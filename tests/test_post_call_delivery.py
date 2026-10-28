"""Synthetic SQLite recovery tests; no calls, provider requests or customer sends."""
import ast
import asyncio
from datetime import datetime, timezone
import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.core.post_call_delivery import PostCallDeliveryStore, deliver_post_call_jobs
from src.tools.context import PostCallContext


def context(business=7, call="synthetic-call"):
    return PostCallContext(call_id=call, caller_number="", business_id=business, config={"secret": "not-stored"})


def tool(*, enabled=True, execute=None, timeout=100):
    return SimpleNamespace(config=SimpleNamespace(enabled=enabled, url="https://unused.invalid"),
                           definition=SimpleNamespace(timeout_ms=timeout), execute=execute or AsyncMock(return_value=None))


@pytest.mark.asyncio
async def test_disabled_and_missing_tools_suspend_without_attempts_and_only_explicitly_resume(tmp_path):
    path = str(tmp_path / "outbox.db")
    store = PostCallDeliveryStore(path)
    store.enqueue(context(), ["demo", "missing"])
    demo = tool(enabled=False)
    get_tool = lambda name: demo if name == "demo" else None
    assert (await deliver_post_call_jobs(store, get_tool))["suspended"] == 2
    rows = store.status(7, "synthetic-call")
    assert {r["reason_code"] for r in rows} == {"POST_CALL_TOOL_DISABLED", "POST_CALL_TOOL_MISSING"}
    assert all(r["state"] == "suspended" and r["attempts"] == 0 for r in rows)
    demo.execute.assert_not_awaited()
    reopened = PostCallDeliveryStore(path)
    demo.config.enabled = True
    assert reopened.lease() is None
    assert not reopened.resume(8, "synthetic-call", "demo")
    assert reopened.resume(7, "synthetic-call", "demo")
    assert (await deliver_post_call_jobs(reopened, get_tool))["delivered"] == 1
    assert not reopened.resume(7, "synthetic-call", "demo")
    assert reopened.lease() is None
    assert store.status(8, "synthetic-call") == []


@pytest.mark.asyncio
async def test_real_receiver_failures_remain_durable_and_retry_limit_is_visible(tmp_path):
    path = str(tmp_path / "outbox.db")
    store = PostCallDeliveryStore(path, max_attempts=2)
    store.enqueue(context(), ["crm"])
    failing = tool(execute=AsyncMock(side_effect=RuntimeError("synthetic receiver unavailable")))
    assert (await deliver_post_call_jobs(store, lambda _: failing))["pending"] == 1
    with store._connect() as db:
        payload = json.loads(db.execute("SELECT context_json FROM post_call_deliveries").fetchone()[0])
        assert "config" not in payload
        db.execute("UPDATE post_call_deliveries SET next_attempt_at=0")
    reopened = PostCallDeliveryStore(path, max_attempts=2)
    assert (await deliver_post_call_jobs(reopened, lambda _: failing))["dead_letter"] == 1
    row = reopened.status(7, "synthetic-call")[0]
    assert (row["attempts"], row["state"], row["reason_code"]) == (2, "dead_letter", "POST_CALL_ATTEMPTS_EXHAUSTED")
    assert reopened.lease() is None


@pytest.mark.asyncio
@pytest.mark.parametrize("result", [{"status": "unknown"}, {"success": False}, {}, "error", {"success": True, "status": "error"}])
async def test_explicit_or_unknown_result_cannot_ack(tmp_path, result):
    store = PostCallDeliveryStore(str(tmp_path / "outbox.db"))
    store.enqueue(context(), ["crm"])
    await deliver_post_call_jobs(store, lambda _: tool(execute=AsyncMock(return_value=result)))
    assert store.status(7, "synthetic-call")[0]["state"] == "pending"


@pytest.mark.asyncio
async def test_slow_tool_is_bounded_and_cancelled_without_losing_durable_job(tmp_path):
    store = PostCallDeliveryStore(str(tmp_path / "outbox.db"))
    store.enqueue(context(), ["slow"])
    cancelled = asyncio.Event()

    async def slow(_):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    await asyncio.wait_for(deliver_post_call_jobs(store, lambda _: tool(execute=slow, timeout=10)), .5)
    assert cancelled.is_set()
    assert store.status(7, "synthetic-call")[0]["reason_code"] == "POST_CALL_TIMEOUT"


def test_expired_lease_is_replayable_but_old_ack_is_fenced(tmp_path):
    store = PostCallDeliveryStore(str(tmp_path / "outbox.db"))
    store.enqueue(context(), ["crm"])
    old = store.lease()
    with store._connect() as db:
        db.execute("UPDATE post_call_deliveries SET lease_until=0")
    current = store.lease()
    assert old["lease_token"] != current["lease_token"]
    assert not store.complete(old)
    assert store.complete(current)
    store.enqueue(context(), ["crm"])
    assert store.lease() is None


def test_existing_outbox_schema_upgrades_without_discarding_pending_payload(tmp_path):
    path = str(tmp_path / "legacy.db")
    with sqlite3.connect(path) as db:
        db.execute("""CREATE TABLE post_call_deliveries (
            business_id INTEGER,call_id TEXT,tool_name TEXT,context_json TEXT,state TEXT DEFAULT 'pending',
            attempts INTEGER DEFAULT 0,next_attempt_at REAL DEFAULT 0,lease_until REAL DEFAULT 0,
            delivered_at REAL,PRIMARY KEY(business_id,call_id,tool_name))""")
        db.execute("INSERT INTO post_call_deliveries(business_id,call_id,tool_name,context_json,attempts) VALUES(7,'legacy','crm','{}',4)")
    store = PostCallDeliveryStore(path)
    row = store.lease("legacy")
    assert (row["context_json"], row["attempts"]) == ("{}", 5)
    assert store.complete(row)
    assert PostCallDeliveryStore(path).status(7, "legacy")[0]["state"] == "delivered"


@pytest.mark.asyncio
async def test_engine_enqueue_returns_before_external_delivery(tmp_path, monkeypatch):
    # Compile the production method in isolation, avoiding unrelated voice providers.
    module = ast.parse((Path(__file__).parents[1] / "src/engine.py").read_text())
    engine = next(n for n in module.body if isinstance(n, ast.ClassDef) and n.name == "Engine")
    method = next(n for n in engine.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "_execute_post_call_tools")
    namespace = {"asyncio": asyncio, "datetime": datetime, "timezone": timezone,
                 "logger": SimpleNamespace(info=lambda *a, **kw: None, debug=lambda *a, **kw: None, error=lambda *a, **kw: None)}
    exec(compile(ast.Module(body=[method], type_ignores=[]), "src/engine.py", "exec"), namespace)
    from src.tools.registry import tool_registry
    monkeypatch.setattr(tool_registry, "get_tools_for_context", lambda **_: [SimpleNamespace(definition=SimpleNamespace(name="crm"))])
    instance = SimpleNamespace(config=SimpleNamespace(default_provider="synthetic"),
                               transport_orchestrator=SimpleNamespace(get_context_config=lambda _: None),
                               _post_call_delivery_store=PostCallDeliveryStore(str(tmp_path / "outbox.db")),
                               _deliver_post_call_jobs=AsyncMock())
    session = SimpleNamespace(context_name="business-7", business_id=7, caller_number="", caller_name=None,
                              provider_name="synthetic", start_time=None)
    await asyncio.wait_for(namespace[method.name](instance, "synthetic-call", session), .5)
    instance._deliver_post_call_jobs.assert_not_awaited()
    assert instance._post_call_delivery_store.status(7, "synthetic-call")[0]["state"] == "pending"
