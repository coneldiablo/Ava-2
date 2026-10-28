#!/usr/bin/env python3
"""Reproduce legacy Onyx false-positive results offline, never against a live DB.

Python 3.11 + pytest are required. Extracts only the pinned Onyx modules and three
unchanged historical test files into a TemporaryDirectory; no checkout/reset,
credentials, runtime databases or production endpoints are used.
"""

import argparse
import asyncio
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile


REVISION = "84b9faf2011e82190187b38a2dc4848a8a2d09c9"
MODULES = (
    "onyx_agent_runner", "onyx_agents_config", "onyx_connector", "onyx_db",
    "onyx_outbox_worker", "onyx_resilience", "onyx_policy_gateway",
    "onyx_shadow_mode", "onyx_cutover_manager",
)
TESTS = tuple(f"tests/test_onyx_stage{stage}.py" for stage in (5, 10, 11))


def run_isolated(root):
    # Fail closed on outbound network attempts; this does NOT supply fake API
    # responses. The legacy modules and test assertions remain byte-for-byte.
    network_attempts = []

    def deny_network(*args, **kwargs):
        network_attempts.append("blocked")
        raise RuntimeError("Offline legacy audit: external networking disabled")

    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    socket.create_connection = deny_network
    socket.getaddrinfo = deny_network
    sys.path.insert(0, str(root))
    os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
    import pytest

    class Counts:
        passed = 0
        failed = 0

        def pytest_runtest_logreport(self, report):
            if report.when == "call" and report.passed:
                self.passed += 1
            if report.failed:
                self.failed += 1

    counts = Counts()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        test_exit = int(pytest.main(["-q", "-p", "no:cacheprovider", *TESTS], plugins=[counts]))

    def fixture(module_name, fixture_name, dirname):
        spec = importlib.util.spec_from_file_location(module_name, root / "tests" / f"{module_name}.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        target = root / dirname
        target.mkdir()
        return getattr(module, fixture_name).__wrapped__(target)

    from src.core.onyx_agent_runner import OnyxAgentRunner
    from src.core.onyx_outbox_worker import OnyxOutboxWorker
    from src.core.onyx_policy_gateway import PolicyGateway
    from src.core.onyx_shadow_mode import OnyxShadowModeRunner
    from src.core.onyx_cutover_manager import OnyxCutoverManager
    from src.core.onyx_db import init_onyx_tables

    db = fixture("test_onyx_stage5", "multi_tenant_db", "answer-case")
    runner = OnyxAgentRunner(db_path=db)
    answers = []
    with sqlite3.connect(db) as conn:
        for business_id, hotel in ((1, "Hotel Alpha"), (2, "Hotel Beta")):
            source = conn.execute("SELECT text FROM kb_chunks WHERE kbId = ?", (business_id,)).fetchone()[0]
            result = runner.answer_query(business_id=business_id, query="бассейн", hotel_name=hotel)
            answers.append({"business_id": business_id, "source": source,
                            "answer": result["answer"], "grounded": result["grounded"],
                            "citations": result["citations"]})

    worker = OnyxOutboxWorker(db_path=db)
    event_id = worker.enqueue_event(1, "knowledge", 1, "UPSERT", {"content_hash": "audit-only"})
    processed = asyncio.run(worker.process_single_event(worker.lease_events()[0]))
    with sqlite3.connect(db) as conn:
        outbox_status = conn.execute("SELECT status FROM onyx_sync_outbox WHERE event_id = ?", (event_id,)).fetchone()[0]
        task_table_exists = bool(conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'manager_tasks'").fetchone())

    gateway = PolicyGateway(db_path=db)
    actions = {}
    inputs = {
        "get_booking": {"booking_id": "NONEXISTENT-AUDIT-BOOKING"},
        "get_availability": {"room_category": "NONEXISTENT-AUDIT-CATEGORY"},
        "make_call": {"phone": "+19999999999", "greeting": "Offline audit only"},
        "send_whatsapp": {"chat_id": "offline-audit", "text": "Offline audit only"},
        "create_task": {"summary": "Offline audit only", "priority": "normal"},
    }
    for action, arguments in inputs.items():
        result = gateway.execute_action(1, "ava:1:agent:sales", action, arguments)
        # Random identifiers are not needed to reproduce the false-success flags.
        payload = {k: v for k, v in result["result"].items() if k not in ("call_id", "task_id")}
        actions[action] = {"status": result["status"], "result": payload}

    shadow = OnyxShadowModeRunner(db_path=db)
    observation = shadow.process_shadow_query(2, "бассейн", "Бассейн закрыт на реконструкцию.", hotel_name="Hotel Beta")
    metrics = shadow.evaluate_shadow_metrics([observation])
    metrics["metrics"].pop("avg_latency_ms")
    metrics["metrics"].pop("max_latency_ms")

    cutover_db = fixture("test_onyx_stage11", "cutover_test_db", "cutover-case")
    with sqlite3.connect(cutover_db) as conn:
        init_onyx_tables(conn)
        conn.execute("INSERT INTO onyx_document_links (business_id, entity_type, source_id, onyx_document_id, content_hash) VALUES (1, 'knowledge', 1, 'ava:1:knowledge:1', 'hash1')")
        conn.commit()
    cutover = OnyxCutoverManager(db_path=cutover_db).check_go_no_go_criteria(1)
    cutover.pop("timestamp")

    defects = {
        "same_incorrect_pool_answer_for_different_hotels": answers[0]["answer"] == answers[1]["answer"] and "07:00" in answers[1]["answer"] and all(a["grounded"] for a in answers),
        "outbox_completed_without_sender": processed is True and outbox_status == "COMPLETED",
        "call_and_whatsapp_claim_success_offline": actions["make_call"]["result"]["initiated"] is True and actions["send_whatsapp"]["result"]["queued"] is True,
        "task_created_without_task_table": not task_table_exists and actions["create_task"]["result"]["created"] is True,
        "incorrect_answer_marked_ready_for_pilot": metrics["rollout_status"] == "READY_FOR_PILOT" and observation["accuracy_score"] == 1.0,
        "unlinked_tenant_given_go_and_backup_verified": cutover["decision"] == "GO" and cutover["metrics"]["current_tenant_status"] == "UNLINKED" and cutover["checklist"]["backup_tested"] is True,
    }
    return {"revision": REVISION, "python": sys.version.split()[0],
            "original_tests": {"files": TESTS, "passed": counts.passed, "failed": counts.failed, "exit_code": test_exit},
            "pool_answers": answers, "outbox": {"sender_supplied": False, "processed": processed, "status": outbox_status},
            "actions": actions, "manager_tasks_table_exists": task_table_exists,
            "shadow": metrics, "cutover": cutover, "outbound_network_attempts": len(network_attempts),
            "reproduced_defects": defects}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Optional JSON evidence artifact")
    parser.add_argument("--isolated-root", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.isolated_root:
        print(json.dumps(run_isolated(args.isolated_root), ensure_ascii=False, indent=2))
        return
    repo = Path(__file__).resolve().parents[1]
    files = [f"src/core/{module}.py" for module in MODULES] + list(TESTS)
    hashes = {}
    with tempfile.TemporaryDirectory(prefix="ava-legacy-onyx-audit-") as directory:
        root = Path(directory)
        for name in files:
            data = subprocess.check_output(["git", "show", f"{REVISION}:{name}"], cwd=repo)
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            hashes[name] = hashlib.sha256(data).hexdigest()
        environment = {"PATH": os.defpath, "HOME": directory,
                       "PYTHONPATH": directory, "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1"}
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--isolated-root", directory],
                                cwd=directory, env=environment, check=True, capture_output=True, text=True)
    evidence = json.loads(result.stdout)
    evidence["unchanged_source_sha256"] = hashes
    rendered = json.dumps(evidence, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    if evidence["original_tests"]["passed"] != 8 or evidence["original_tests"]["exit_code"] != 0 or evidence["outbound_network_attempts"] or not all(evidence["reproduced_defects"].values()):
        raise SystemExit("Audit did not reproduce the complete expected evidence; inspect output.")


if __name__ == "__main__":
    main()
