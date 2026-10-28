"""Durable, at-least-once delivery of post-call tools.

The call is snapshotted before its live session is removed. CRM post-call
requests are idempotent by (business, call ID), so an expired lease is safe to
replay after a process crash.
"""

import asyncio
import json
import os
import sqlite3
import time
import uuid
from dataclasses import asdict
from pathlib import Path


class PostCallDeliveryStore:
    def __init__(self, path=None, max_attempts=20):
        self.max_attempts = max(1, int(max_attempts))
        self.path = path or os.getenv("POST_CALL_OUTBOX_DB_PATH") or os.getenv(
            "CALL_HISTORY_DB_PATH", "/app/data/call_history.db"
        )
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS post_call_deliveries (
                    business_id INTEGER NOT NULL,
                    call_id TEXT NOT NULL,
                    tool_name TEXT NOT NULL,
                    context_json TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT 'pending',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    next_attempt_at REAL NOT NULL DEFAULT 0,
                    lease_until REAL NOT NULL DEFAULT 0,
                    delivered_at REAL,
                    PRIMARY KEY (business_id, call_id, tool_name)
                )
            """)
            columns = {row["name"] for row in db.execute("PRAGMA table_info(post_call_deliveries)")}
            for name, definition in {
                "lease_token": "TEXT", "reason_code": "TEXT", "updated_at": "REAL"
            }.items():
                if name not in columns:
                    db.execute(f"ALTER TABLE post_call_deliveries ADD COLUMN {name} {definition}")

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=30000")
        return db

    def enqueue(self, context, tool_names):
        if not context.call_id or int(context.business_id) < 1:
            raise ValueError("post-call delivery requires call and business IDs")
        payload = asdict(context)
        # Runtime config can contain credentials and is rebuilt from the current
        # deployment when the tool is replayed.
        payload.pop("config", None)
        serialized = json.dumps(payload, ensure_ascii=False)
        with self._connect() as db:
            for name in tool_names:
                db.execute("""
                    INSERT OR IGNORE INTO post_call_deliveries
                    (business_id, call_id, tool_name, context_json)
                    VALUES (?, ?, ?, ?)
                """, (int(context.business_id), context.call_id, name, serialized))

    def lease(self, call_id=None):
        now = time.time()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("""
                SELECT * FROM post_call_deliveries
                WHERE state IN ('pending','leased') AND next_attempt_at <= ?
                  AND (state != 'leased' OR lease_until <= ?)
                  AND (? IS NULL OR call_id = ?)
                ORDER BY next_attempt_at, rowid LIMIT 1
            """, (now, now, call_id, call_id)).fetchone()
            if row is None:
                return None
            token = str(uuid.uuid4())
            db.execute("""
                UPDATE post_call_deliveries SET state='leased', attempts=attempts+1,
                    lease_until=?, lease_token=?, updated_at=? WHERE business_id=? AND call_id=? AND tool_name=?
            """, (now + 60, token, now, row["business_id"], row["call_id"], row["tool_name"]))
            return {**dict(row), "state": "leased", "attempts": row["attempts"] + 1,
                    "lease_token": token, "lease_until": now + 60}

    def _transition(self, row, state, reason=None, next_attempt=0):
        with self._connect() as db:
            return db.execute("""
                UPDATE post_call_deliveries SET state=?, reason_code=?, next_attempt_at=?,
                    lease_until=0, lease_token=NULL, updated_at=?, delivered_at=?
                WHERE business_id=? AND call_id=? AND tool_name=? AND state='leased' AND lease_token=?
            """, (state, reason, next_attempt, time.time(), time.time() if state == "delivered" else None,
                  row["business_id"], row["call_id"], row["tool_name"], row["lease_token"])).rowcount == 1

    def complete(self, row):
        return self._transition(row, "delivered")

    def retry(self, row, reason="POST_CALL_DELIVERY_FAILED"):
        if row["attempts"] >= self.max_attempts:
            return self._transition(row, "dead_letter", "POST_CALL_ATTEMPTS_EXHAUSTED")
        delay = min(300, 2 ** min(int(row["attempts"]), 8))
        return self._transition(row, "pending", reason, time.time() + delay)

    def fail(self, row, reason):
        return self._transition(row, "dead_letter", reason)

    def pending_tools(self):
        with self._connect() as db:
            return [row[0] for row in db.execute(
                "SELECT DISTINCT tool_name FROM post_call_deliveries WHERE state IN ('pending','leased')")]

    def suspend_tool(self, tool_name, reason):
        # Preflight before leasing: disabled integrations never consume attempts.
        with self._connect() as db:
            return db.execute("""
                UPDATE post_call_deliveries SET state='suspended', reason_code=?,
                    lease_until=0, lease_token=NULL, updated_at=?
                WHERE tool_name=? AND (state='pending' OR (state='leased' AND lease_until<=?))
            """, (reason, time.time(), tool_name, time.time())).rowcount

    def resume(self, business_id, call_id, tool_name):
        """Explicit operator recovery after configuration/receiver repair; never replay delivered work."""
        with self._connect() as db:
            return db.execute("""
                UPDATE post_call_deliveries SET state='pending', attempts=0, next_attempt_at=0,
                    lease_until=0, lease_token=NULL, reason_code=NULL, updated_at=?
                WHERE business_id=? AND call_id=? AND tool_name=? AND state IN ('suspended','dead_letter')
            """, (time.time(), int(business_id), call_id, tool_name)).rowcount == 1

    def status(self, business_id, call_id):
        with self._connect() as db:
            return [dict(row) for row in db.execute("""
                SELECT tool_name,state,attempts,reason_code,next_attempt_at,delivered_at FROM post_call_deliveries
                WHERE business_id=? AND call_id=? ORDER BY tool_name
            """, (int(business_id), call_id))]


def unavailable_reason(tool):
    if tool is None:
        return "POST_CALL_TOOL_MISSING"
    config = getattr(tool, "config", None)
    if getattr(config, "enabled", True) is False:
        return "POST_CALL_TOOL_DISABLED"
    if hasattr(config, "url") and not config.url:
        return "POST_CALL_TOOL_UNCONFIGURED"
    return None


async def deliver_post_call_jobs(store, get_tool, *, config=None, call_id=None, pass_timeout=30):
    """Bounded recovery pass. None is the PostCallTool ACK contract; explicit failures cannot ACK."""
    from src.tools.context import PostCallContext

    counts = {"delivered": 0, "pending": 0, "suspended": 0, "dead_letter": 0}
    for name in await asyncio.to_thread(store.pending_tools):
        reason = unavailable_reason(get_tool(name))
        if reason:
            counts["suspended"] += await asyncio.to_thread(store.suspend_tool, name, reason)
    deadline = asyncio.get_running_loop().time() + pass_timeout
    for _ in range(100):
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            break
        row = await asyncio.to_thread(store.lease, call_id)
        if row is None:
            break
        try:
            tool = get_tool(row["tool_name"])
            reason = unavailable_reason(tool)
            if reason:
                # Configuration may change between preflight and lease.
                await asyncio.to_thread(store._transition, row, "suspended", reason)
                counts["suspended"] += 1
                continue
            try:
                context = PostCallContext(**json.loads(row["context_json"]))
            except (ValueError, TypeError):
                await asyncio.to_thread(store.fail, row, "POST_CALL_PAYLOAD_INVALID")
                counts["dead_letter"] += 1
                continue
            context.config = config
            definition = tool.definition
            timeout = getattr(definition, "timeout_ms", None)
            timeout = float(timeout) / 1000 if timeout else float(getattr(definition, "max_execution_time", 30))
            result = await asyncio.wait_for(tool.execute(context), timeout=max(.001, min(timeout, remaining, 30)))
            if result is not None:
                if not isinstance(result, dict) or result.get("success") is False or (
                    result.get("status") not in {None, "ok", "success", "succeeded", "delivered"}
                ) or not (result.get("success") is True or result.get("status") in {"ok", "success", "succeeded", "delivered"}):
                    raise RuntimeError("unconfirmed post-call result")
            if await asyncio.to_thread(store.complete, row):
                counts["delivered"] += 1
        except asyncio.CancelledError:
            await asyncio.to_thread(store.retry, row, "POST_CALL_CANCELLED")
            raise
        except Exception as error:
            reason = "POST_CALL_TIMEOUT" if isinstance(error, asyncio.TimeoutError) else "POST_CALL_DELIVERY_FAILED"
            await asyncio.to_thread(store.retry, row, reason)
            counts["dead_letter" if row["attempts"] >= store.max_attempts else "pending"] += 1
    return counts
