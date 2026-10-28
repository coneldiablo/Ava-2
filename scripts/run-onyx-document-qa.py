#!/usr/bin/env python3
"""Run an observed HTTP document lifecycle in one owned, disposable contour.

The QA source is an explicit read-only overlay in a short-lived sidecar, never
copied into the live application image or a production recipe. Secrets remain
in the existing private env/key files; only bounded safe evidence is returned.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid

spec = importlib.util.spec_from_file_location("document_recipe_qa", Path(__file__).with_name("run-onyx-recipe-qa.py"))
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


def safe_probe_result(stdout: str) -> dict:
    lines = stdout.splitlines()
    if len(stdout) > 2_000_000:
        raise ValueError("QA_OUTPUT_LIMIT")
    value = next((json.loads(line) for line in reversed(lines)
                  if line.startswith('{"ok":') and len(line) <= 16_000), None)
    if not isinstance(value, dict) or type(value.get("ok")) is not bool:
        raise ValueError("QA_RESULT_MISSING")
    if value["ok"]:
        fields = {"ok", "qa_only", "buyer_acceptance", "rag_acceptance", "schema_version", "run_id",
                  "started_at_ms", "completed_at_ms", "business_id", "deployment_id", "namespace",
                  "probe_sha256", "helper_sha256", "source_bundle_sha256",
                  "transport", "deletion", "file_scope_negative", "evidence"}
        if set(value) != fields or value["qa_only"] is not True or value["buyer_acceptance"] is not False or value["rag_acceptance"] is not False:
            raise ValueError("QA_RESULT_CONTRACT_INVALID")
        expected = {"provisioned", "session_created", "upload_status_ok", "file_indexed_completed",
                    "opensearch_indexed", "foreign_scope_provision_denied", "unknown_binding_read_denied",
                    "unknown_binding_delete_denied", "cross_scope_opensearch_denied", "file_deleted",
                    "opensearch_purged", "session_revoked", "session_revoke_idempotent", "user_disabled",
                    "late_session_denied", "late_provision_denied", "cleaned_up"}
        if not isinstance(value["evidence"], dict) or set(value["evidence"]) != expected or any(v is not True for v in value["evidence"].values()):
            raise ValueError("QA_RESULT_CHECKS_INVALID")
        if (value["schema_version"] != 3 or value["transport"] != "running_auth_peer_and_native_http"
                or value["deletion"] != "native_endpoint_and_worker_observed"
                or value["file_scope_negative"] != "unknown_binding_guard_only"):
            raise ValueError("QA_RESULT_TRANSPORT_INVALID")
        for key in ("run_id", "deployment_id"):
            if not qa.helper.UUID.fullmatch(value[key]):
                raise ValueError("QA_RESULT_ID_INVALID")
        for key in ("probe_sha256", "helper_sha256", "source_bundle_sha256"):
            if not re.fullmatch(r"[0-9a-f]{64}", value[key]):
                raise ValueError("QA_RESULT_SOURCE_INVALID")
        for key in ("started_at_ms", "completed_at_ms", "business_id"):
            if type(value[key]) is not int or value[key] < 1:
                raise ValueError("QA_RESULT_NUMBER_INVALID")
    else:
        # Failure text/locals are deliberately discarded, even if a dependency
        # unexpectedly returns a verbose payload instead of our safe contract.
        error_type = value.get("error_type", "Unknown")
        if not isinstance(error_type, str) or error_type not in {"Denied", "Unavailable", "ValueError", "RuntimeError", "TimeoutError"}:
            error_type = "UnexpectedDependencyError"
        frames = value.get("frames", [])
        clean_frames = []
        if isinstance(frames, list):
            for frame in frames[-8:]:
                if (isinstance(frame, dict) and set(frame) == {"file", "function", "line"}
                        and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", str(frame["file"]))
                        and re.fullmatch(r"[A-Za-z0-9_<>]{1,100}", str(frame["function"]))
                        and type(frame["line"]) is int):
                    clean_frames.append(frame)
        value = {"ok": False, "error_type": error_type, "frames": clean_frames}
    return value


def _selected_env(path: Path, row: dict) -> bytes:
    qa.helper.owned_path(path)
    raw = path.read_bytes()
    if len(raw) > 64 * 1024:
        raise ValueError("QA_ENV_INVALID")
    parsed = {}
    for line in raw.decode("utf-8", "strict").splitlines():
        if not line or "=" not in line:
            raise ValueError("QA_ENV_INVALID")
        key, value = line.split("=", 1)
        if key in parsed or not re.fullmatch(r"[A-Z][A-Z0-9_]{1,63}", key) or "\x00" in value:
            raise ValueError("QA_ENV_INVALID")
        parsed[key] = value
    required = {key: parsed.get(key) for key in (
        "AVA_BUSINESS_ID", "AVA_DEPLOYMENT_ID", "AVA_DEPLOYMENT_NAMESPACE", "AVA_DEPLOYMENT_REVISION",
        "OPENSEARCH_ADMIN_USERNAME", "OPENSEARCH_ADMIN_PASSWORD", "OPENSEARCH_VERIFY_CERTS", "OPENSEARCH_CA_CERTS",
    )}
    expected = {"AVA_BUSINESS_ID": str(row["businessId"]), "AVA_DEPLOYMENT_ID": row["id"],
                "AVA_DEPLOYMENT_NAMESPACE": row["namespace"], "AVA_DEPLOYMENT_REVISION": str(row["revision"]),
                "OPENSEARCH_ADMIN_USERNAME": row["namespace"] + "_runtime",
                "OPENSEARCH_VERIFY_CERTS": "true", "OPENSEARCH_CA_CERTS": "/run/ava-search-ca/ca.pem"}
    if any(required.get(key) != value for key, value in expected.items()) \
            or not isinstance(required["OPENSEARCH_ADMIN_PASSWORD"], str) \
            or len(required["OPENSEARCH_ADMIN_PASSWORD"]) < 32:
        raise ValueError("QA_ENV_INVALID")
    selected = {**required, "AVA_NATIVE_QA": "true", "AVA_AUTH_URL": "http://auth:4011",
                "AVA_ONYX_API_URL": "http://api:8080", "AVA_OPENSEARCH_URL": "https://search:9200",
                "AVA_AUTH_GATEWAY_KEY_FILE": "/run/ava-peer/gateway.key",
                "AVA_NATIVE_HTTP_GATEWAY_KEY_FILE": "/run/ava-peer/gateway.key",
                "AVA_AUTH_WORKER_KEY_FILE": "/run/ava-peer/worker.key"}
    return ("\n".join(f"{key}={value}" for key, value in selected.items()) + "\n").encode()


def _source_hashes(probe: Path, helper: Path) -> dict[str, str]:
    hashes = {"qa_documents.py": hashlib.sha256(helper.read_bytes()).hexdigest(),
              "qa_documents_peer.py": hashlib.sha256(probe.read_bytes()).hexdigest()}
    return {"probe_sha256": hashes["qa_documents_peer.py"],
            "helper_sha256": hashes["qa_documents.py"],
            "source_bundle_sha256": hashlib.sha256(
                json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()}


def run(directory: Path) -> dict:
    directory = qa._scope(directory)
    manifest = qa._load_manifest(directory)
    row = manifest["row"]
    launcher = qa.helper.Deployments(directory / "synthetic.sqlite", directory)
    root, recipe, compose = launcher._recipe(row)
    launcher._state(row, compose)
    containers = qa._containers(launcher, row)
    api, auth = containers.get("api", {}), containers.get("auth", {})
    if (row["businessId"] not in (911001, 911002)
            or api.get("State", {}).get("Health", {}).get("Status") != "healthy"
            or auth.get("State", {}).get("Health", {}).get("Status") != "healthy"
            or auth.get("Image") != api.get("Image")):
        raise ValueError("QA_NATIVE_API_NOT_READY")
    if not qa._runtime_mounts_private(containers) or any(item.get("HostConfig", {}).get("PortBindings") for item in containers.values()):
        raise ValueError("QA_RUNTIME_BOUNDARY_INVALID")
    memory = {line.split(':', 1)[0]: int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()
              if line.startswith(('MemTotal:', 'MemAvailable:'))}
    if memory.get('MemAvailable', 0) < memory.get('MemTotal', 0) * 0.2 + 512 * 1024:
        raise ValueError('QA_CAPACITY_REQUIRED')
    network = row["namespace"] + "_native"
    network_state = json.loads(qa.helper.run(["docker", "network", "inspect", network], timeout=15))[0]
    if network_state.get("Internal") is not True:
        raise ValueError("QA_NETWORK_NOT_INTERNAL")
    api_mounts = {item["Destination"]: item for item in api.get("Mounts", [])}
    auth_mounts = {item["Destination"]: item for item in auth.get("Mounts", [])}
    probe = Path(__file__).resolve().parents[1] / "native_modules/onyx/auth/qa_documents_peer.py"
    helper_source = probe.with_name("qa_documents.py")
    for source in (probe, helper_source):
        qa.helper.owned_path(source)
        source.relative_to(Path(__file__).resolve().parents[1])
    source_hashes = _source_hashes(probe, helper_source)
    name = row["namespace"] + "-document-review-" + uuid.uuid4().hex[:12]
    env_data = _selected_env(root / "config/native.env", row)
    mount_args = []
    for mounts, source_target, target in (
        (auth_mounts, "/run/ava-keys/gateway.key", "/run/ava-peer/gateway.key"),
        (auth_mounts, "/run/ava-keys/worker.key", "/run/ava-peer/worker.key"),
        (api_mounts, "/run/ava-search-ca/ca.pem", "/run/ava-search-ca/ca.pem"),
    ):
        mount = mounts.get(source_target, {})
        if mount.get("Type") != "bind" or mount.get("RW") is not False:
            raise ValueError("QA_KEY_MOUNT_INVALID")
        source = Path(mount["Source"])
        source.relative_to(root / "config")
        qa.helper.owned_path(source)
        mount_args += ["--mount", f"type=bind,source={source},target={target},readonly"]
    env_fd, env_name = tempfile.mkstemp(prefix=".document-peer-", suffix=".env", dir=directory)
    env_path = Path(env_name)
    try:
        with os.fdopen(env_fd, "wb") as output:
            output.write(env_data); output.flush(); os.fsync(output.fileno())
        os.chmod(env_path, 0o600)
    except Exception:
        env_path.unlink(missing_ok=True)
        raise
    lock_fd = None
    try:
        command = ["docker", "run", "--rm", "--name", name, "--network", network,
                   "--read-only", "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
                   "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1001:1001",
                   "--label", "tech.melud.ava.qa-document-probe=" + row["id"],
                   "--env-file", str(env_path), "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m",
                   "--mount", f"type=bind,source={probe},target=/app/onyx/ava_auth/qa_documents_peer.py,readonly",
                   "--mount", f"type=bind,source={helper_source},target=/app/onyx/ava_auth/qa_documents.py,readonly",
                   *mount_args, "--entrypoint", "python", api["Image"], "-m", "onyx.ava_auth.qa_documents_peer"]
        lock_fd = os.open(directory / ".document-qa.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        started = int(time.time() * 1000)
        try:
            execution = subprocess.run(command, capture_output=True, text=True, timeout=240, env=qa.helper.SAFE_ENV)
            parsed = safe_probe_result(execution.stdout)
        except subprocess.TimeoutExpired:
            qa.helper.run(["docker", "rm", "-f", name], timeout=15)
            parsed = {"ok": False, "error_type": "TimeoutError", "frames": []}
            execution = None
        if parsed["ok"] and (execution.returncode != 0 or parsed["business_id"] != row["businessId"]
                              or parsed["deployment_id"] != row["id"] or parsed["namespace"] != row["namespace"]
                              or any(parsed[key] != value for key, value in source_hashes.items())
                              or not started <= parsed["started_at_ms"] <= parsed["completed_at_ms"] <= int(time.time() * 1000)):
            raise ValueError("QA_RESULT_BINDING_INVALID")
        result = {"qa_only": True, "buyer_acceptance": False, "rag_acceptance": False,
                  "phase": "document_review", "business_id": row["businessId"], "deployment_id": row["id"],
                  "image_id": api["Image"], "compose_sha256": recipe["composeSha256"], **source_hashes,
                  "wrapper_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  "started_at_ms": started, "completed_at_ms": int(time.time() * 1000), "result": parsed}
        qa._private_new(directory / f"document-review-{time.time_ns()}-result.json", result)
        return result
    finally:
        if lock_fd is not None:
            os.close(lock_fd)
        env_path.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = run(args.directory)
        print(json.dumps(result))
        raise SystemExit(0 if result["result"]["ok"] else 1)
    except Exception:
        raise SystemExit("ONYX_DOCUMENT_QA_REVIEW_FAILED") from None
