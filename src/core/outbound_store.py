"""
Outbound campaign dialer persistence (SQLite).

This module intentionally mirrors the Call History persistence style:
- SQLite WAL mode + busy_timeout
- Thread lock around short transactions
- Async facade via run_in_executor to avoid blocking the asyncio loop

MVP scope:
- Campaigns / leads / attempts tables
- Atomic lead leasing (transaction-based; no dependency on RETURNING support)
- Import helpers for Admin UI (skip_existing default)
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import os
import sqlite3
import threading
import uuid
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import structlog

from src.core.outbound_errors import sanitize_outbound_error

logger = structlog.get_logger(__name__)

try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _as_str(value: Any) -> str:
    return "" if value is None else str(value)


def _safe_json_loads(raw: str) -> Dict[str, Any]:
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
        return {}
    except Exception:
        return {}


_NON_DIAL_CHAR_RE = re.compile(r"[^0-9+*#]+")


def _normalize_phone_number(raw: str) -> str:
    """
    Normalize a phone number for storage.

    Accepts common user formats:
      - +15551234567 (E.164)
      - 15551234567
      - 2765 (internal extension)
      - (555) 123-4567, 555-123-4567, etc.

    We store:
      - "+<digits>" when a leading '+' is present
      - "<digits>" otherwise
    """
    s = (raw or "").strip()
    if not s:
        raise ValueError("Missing phone_number")
    # Reject alphabets and unsafe characters early. We intentionally avoid enforcing E.164 or digit-length
    # rules because trunk routing/formatting varies internationally and by PBX configuration.
    #
    # Allowed (after stripping formatting): digits plus optional leading '+', and '*'/'#'
    # (useful for lab testing / feature codes).
    if re.search(r"[A-Za-z]", s):
        raise ValueError("Invalid phone_number (letters not allowed)")
    if re.search(r"[^0-9+*#() ./-]", s):
        raise ValueError("Invalid phone_number (contains unsupported characters)")
    s = _NON_DIAL_CHAR_RE.sub("", s)
    if not s:
        raise ValueError("Invalid phone_number (no dialable characters)")

    has_plus = s.startswith("+")
    core = s[1:] if has_plus else s
    if not core:
        raise ValueError("Invalid phone_number (missing digits)")
    if not re.fullmatch(r"[0-9*#]+", core):
        raise ValueError("Invalid phone_number (contains invalid characters)")
    if not re.search(r"[0-9]", core):
        raise ValueError("Invalid phone_number (must include at least one digit)")

    # Keep '+' only if it was leading; remove any other '+' via regex above.
    return f"+{core}" if has_plus else core


def _normalize_header_key(raw: str) -> str:
    return (raw or "").strip().lower().replace(" ", "_")


def _optional_timezone_or_error(raw: Optional[str]) -> Optional[str]:
    tz = (raw or "").strip()
    if not tz:
        return None
    return _validate_iana_timezone_name(tz)


def _validate_iana_timezone_name(tz_name: str) -> str:
    """
    Enforce IANA timezone names like 'America/Phoenix' (not 'Phoenix').
    """
    tz_name = (tz_name or "").strip()
    if not tz_name:
        raise ValueError("timezone is required")
    if tz_name.upper() == "UTC":
        return "UTC"
    if ZoneInfo is None:
        # Should not happen in our container images, but avoid hard failure.
        return tz_name
    try:
        ZoneInfo(tz_name)
    except Exception:
        raise ValueError(f"Invalid timezone '{tz_name}'. Use an IANA timezone like 'America/Phoenix' or 'UTC'.")
    return tz_name


@dataclass(frozen=True)
class ImportErrorRow:
    row_number: int
    phone_number: str
    error_reason: str


@dataclass(frozen=True)
class ImportWarningRow:
    row_number: int
    phone_number: str
    warning_reason: str


class OutboundStore:
    _CREATE_TABLES_SQL = [
        """
        CREATE TABLE IF NOT EXISTS outbound_campaigns (
            id TEXT PRIMARY KEY,
            business_id INTEGER NOT NULL DEFAULT 1,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft', -- draft|running|paused|stopped|archived
            timezone TEXT NOT NULL DEFAULT 'UTC',
            run_start_at_utc TEXT,
            run_end_at_utc TEXT,
            daily_window_start_local TEXT NOT NULL DEFAULT '09:00',
            daily_window_end_local TEXT NOT NULL DEFAULT '17:00',
            max_concurrent INTEGER NOT NULL DEFAULT 1,
            min_interval_seconds_between_calls INTEGER NOT NULL DEFAULT 5,
            default_context TEXT NOT NULL DEFAULT 'default',
            callerid TEXT,
            callerid_name TEXT,
            voicemail_drop_enabled INTEGER NOT NULL DEFAULT 1,
            voicemail_drop_mode TEXT NOT NULL DEFAULT 'upload', -- upload|tts
            voicemail_drop_text TEXT,
            voicemail_drop_media_uri TEXT,
            consent_enabled INTEGER NOT NULL DEFAULT 0,
            consent_media_uri TEXT,
            consent_timeout_seconds INTEGER NOT NULL DEFAULT 5,
            amd_options_json TEXT NOT NULL DEFAULT '{}',
            external_source TEXT,
            external_id TEXT,
            max_attempts INTEGER NOT NULL DEFAULT 3,
            retry_initial_delay_seconds INTEGER NOT NULL DEFAULT 60,
            retry_backoff_multiplier REAL NOT NULL DEFAULT 2.0,
            retry_max_delay_seconds INTEGER NOT NULL DEFAULT 3600,
            is_test INTEGER NOT NULL DEFAULT 0,
            parent_campaign_id TEXT,
            created_at_utc TEXT NOT NULL,
            updated_at_utc TEXT NOT NULL
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_status ON outbound_campaigns(status)",
        "CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_business_status ON outbound_campaigns(business_id, status)",
        """
        CREATE TABLE IF NOT EXISTS outbound_leads (
            id TEXT PRIMARY KEY,
            campaign_id TEXT NOT NULL,
            business_id INTEGER NOT NULL DEFAULT 1,
            name TEXT,
            phone_number TEXT NOT NULL,
            lead_timezone TEXT,
            context_override TEXT,
            caller_id_override TEXT,
            custom_vars_json TEXT NOT NULL DEFAULT '{}',
            state TEXT NOT NULL DEFAULT 'pending', -- pending|leased|dialing|amd_pending|in_progress|completed|failed|canceled
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_outcome TEXT,
            last_attempt_at_utc TEXT,
            leased_until_utc TEXT,
            next_attempt_at_utc TEXT,
            lease_token TEXT,
            created_at_utc TEXT NOT NULL,
            updated_at_utc TEXT NOT NULL,
            UNIQUE(campaign_id, phone_number)
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_outbound_leads_campaign_state ON outbound_leads(campaign_id, state)",
        "CREATE INDEX IF NOT EXISTS idx_outbound_leads_campaign_phone ON outbound_leads(campaign_id, phone_number)",
        "CREATE INDEX IF NOT EXISTS idx_outbound_leads_business_campaign_state ON outbound_leads(business_id, campaign_id, state)",
        """
        CREATE TABLE IF NOT EXISTS outbound_attempts (
            id TEXT PRIMARY KEY,
            campaign_id TEXT NOT NULL,
            lead_id TEXT NOT NULL,
            business_id INTEGER NOT NULL DEFAULT 1,
            started_at_utc TEXT NOT NULL,
            ended_at_utc TEXT,
            duration_seconds INTEGER,
            ari_channel_id TEXT,
            outcome TEXT,
            amd_status TEXT,
            amd_cause TEXT,
            consent_dtmf TEXT,
            consent_result TEXT,
            context TEXT,
            provider TEXT,
            call_id TEXT,
            call_history_call_id TEXT,
            trunk TEXT,
            caller_id TEXT,
            endpoint TEXT,
            outbound_opener TEXT,
            error_stage TEXT,
            error_code TEXT,
            retryable INTEGER,
            error_message TEXT
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_outbound_attempts_campaign_started ON outbound_attempts(campaign_id, started_at_utc)",
        "CREATE INDEX IF NOT EXISTS idx_outbound_attempts_lead_started ON outbound_attempts(lead_id, started_at_utc)",
        "CREATE INDEX IF NOT EXISTS idx_outbound_attempts_business_campaign_started ON outbound_attempts(business_id, campaign_id, started_at_utc)",
    ]

    def __init__(self, db_path: Optional[str] = None):
        self._db_path = db_path or os.getenv("CALL_HISTORY_DB_PATH", "data/call_history.db")
        self._enabled = str(os.getenv("CALL_HISTORY_ENABLED", "true")).strip().lower() not in ("0", "false", "no")
        self._lock = threading.Lock()
        self._initialized = False

        if self._enabled:
            self._init_db()

    def _init_db(self) -> None:
        try:
            db_dir = os.path.dirname(self._db_path)
            if db_dir:
                Path(db_dir).mkdir(parents=True, exist_ok=True)
            with self._lock:
                conn = self._get_connection()
                try:
                    cur = conn.cursor()
                    # Existing installations can have the pre-P0 tables without
                    # tenant/retry columns.  Create tables first, migrate those
                    # legacy tables, and only then create indexes that reference
                    # the newly added columns (for example business_id).
                    table_statements = [
                        stmt
                        for stmt in self._CREATE_TABLES_SQL
                        if stmt.lstrip().upper().startswith("CREATE TABLE")
                    ]
                    index_statements = [
                        stmt
                        for stmt in self._CREATE_TABLES_SQL
                        if not stmt.lstrip().upper().startswith("CREATE TABLE")
                    ]
                    for stmt in table_statements:
                        cur.execute(stmt)
                    self._ensure_schema_sync(conn)
                    for stmt in index_statements:
                        cur.execute(stmt)
                    conn.commit()
                    self._initialized = True
                    logger.info("Outbound dialer tables initialized", db_path=self._db_path)
                finally:
                    conn.close()
        except Exception as exc:
            logger.error("Failed to initialize outbound tables", error=str(exc), exc_info=True)
            self._enabled = False

    def _ensure_schema_sync(self, conn: sqlite3.Connection) -> None:
        """
        Best-effort schema migrations for existing installs.

        SQLite has limited ALTER TABLE support; we add new columns when missing.
        """
        try:
            cur = conn.cursor()

            def _cols(table: str) -> set[str]:
                rows = cur.execute(f"PRAGMA table_info({table})").fetchall()
                return {str(r[1]) for r in rows}  # (cid, name, type, notnull, dflt_value, pk)

            # outbound_campaigns
            ccols = _cols("outbound_campaigns")
            if "business_id" not in ccols:
                cur.execute("ALTER TABLE outbound_campaigns ADD COLUMN business_id INTEGER NOT NULL DEFAULT 1")
            if "voicemail_drop_enabled" not in ccols:
                cur.execute("ALTER TABLE outbound_campaigns ADD COLUMN voicemail_drop_enabled INTEGER NOT NULL DEFAULT 1")
            if "consent_enabled" not in ccols:
                cur.execute("ALTER TABLE outbound_campaigns ADD COLUMN consent_enabled INTEGER NOT NULL DEFAULT 0")
            if "consent_media_uri" not in ccols:
                cur.execute("ALTER TABLE outbound_campaigns ADD COLUMN consent_media_uri TEXT")
            if "consent_timeout_seconds" not in ccols:
                cur.execute("ALTER TABLE outbound_campaigns ADD COLUMN consent_timeout_seconds INTEGER NOT NULL DEFAULT 5")
            if "external_source" not in ccols:
                cur.execute("ALTER TABLE outbound_campaigns ADD COLUMN external_source TEXT")
            if "external_id" not in ccols:
                cur.execute("ALTER TABLE outbound_campaigns ADD COLUMN external_id TEXT")
            if "callerid" not in ccols:
                cur.execute("ALTER TABLE outbound_campaigns ADD COLUMN callerid TEXT")
            if "source_number_id" not in ccols:
                cur.execute("ALTER TABLE outbound_campaigns ADD COLUMN source_number_id TEXT")
            if "callerid_name" not in ccols:
                cur.execute("ALTER TABLE outbound_campaigns ADD COLUMN callerid_name TEXT")
            if "max_attempts" not in ccols:
                cur.execute("ALTER TABLE outbound_campaigns ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3")
            if "retry_initial_delay_seconds" not in ccols:
                cur.execute("ALTER TABLE outbound_campaigns ADD COLUMN retry_initial_delay_seconds INTEGER NOT NULL DEFAULT 60")
            if "retry_backoff_multiplier" not in ccols:
                cur.execute("ALTER TABLE outbound_campaigns ADD COLUMN retry_backoff_multiplier REAL NOT NULL DEFAULT 2.0")
            if "retry_max_delay_seconds" not in ccols:
                cur.execute("ALTER TABLE outbound_campaigns ADD COLUMN retry_max_delay_seconds INTEGER NOT NULL DEFAULT 3600")
            if "is_test" not in ccols:
                cur.execute("ALTER TABLE outbound_campaigns ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0")
            if "parent_campaign_id" not in ccols:
                cur.execute("ALTER TABLE outbound_campaigns ADD COLUMN parent_campaign_id TEXT")
            cur.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_campaigns_external "
                "ON outbound_campaigns(external_source, external_id)"
            )

            # outbound_leads
            lcols = _cols("outbound_leads")
            if "business_id" not in lcols:
                cur.execute("ALTER TABLE outbound_leads ADD COLUMN business_id INTEGER NOT NULL DEFAULT 1")
            if "name" not in lcols:
                cur.execute("ALTER TABLE outbound_leads ADD COLUMN name TEXT")
            if "next_attempt_at_utc" not in lcols:
                cur.execute("ALTER TABLE outbound_leads ADD COLUMN next_attempt_at_utc TEXT")
            if "lease_token" not in lcols:
                cur.execute("ALTER TABLE outbound_leads ADD COLUMN lease_token TEXT")
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_outbound_leads_due "
                "ON outbound_leads(business_id, campaign_id, state, next_attempt_at_utc)"
            )

            # outbound_attempts
            acols = _cols("outbound_attempts")
            if "business_id" not in acols:
                cur.execute("ALTER TABLE outbound_attempts ADD COLUMN business_id INTEGER NOT NULL DEFAULT 1")
            if "duration_seconds" not in acols:
                cur.execute("ALTER TABLE outbound_attempts ADD COLUMN duration_seconds INTEGER")
            if "consent_dtmf" not in acols:
                cur.execute("ALTER TABLE outbound_attempts ADD COLUMN consent_dtmf TEXT")
            if "consent_result" not in acols:
                cur.execute("ALTER TABLE outbound_attempts ADD COLUMN consent_result TEXT")
            if "context" not in acols:
                cur.execute("ALTER TABLE outbound_attempts ADD COLUMN context TEXT")
            if "provider" not in acols:
                cur.execute("ALTER TABLE outbound_attempts ADD COLUMN provider TEXT")
            if "call_id" not in acols:
                cur.execute("ALTER TABLE outbound_attempts ADD COLUMN call_id TEXT")
            if "trunk" not in acols:
                cur.execute("ALTER TABLE outbound_attempts ADD COLUMN trunk TEXT")
            if "caller_id" not in acols:
                cur.execute("ALTER TABLE outbound_attempts ADD COLUMN caller_id TEXT")
            if "endpoint" not in acols:
                cur.execute("ALTER TABLE outbound_attempts ADD COLUMN endpoint TEXT")
            if "outbound_opener" not in acols:
                cur.execute("ALTER TABLE outbound_attempts ADD COLUMN outbound_opener TEXT")
            if "error_stage" not in acols:
                cur.execute("ALTER TABLE outbound_attempts ADD COLUMN error_stage TEXT")
            if "error_code" not in acols:
                cur.execute("ALTER TABLE outbound_attempts ADD COLUMN error_code TEXT")
            if "retryable" not in acols:
                cur.execute("ALTER TABLE outbound_attempts ADD COLUMN retryable INTEGER")
        except Exception:
            # A partially migrated outbound schema would make leasing unsafe. Surface the
            # failure and let _init_db disable the store instead of running unpredictably.
            logger.error("Outbound schema migration failed", exc_info=True)
            raise

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, timeout=30.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA busy_timeout=30000;")
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    async def _run(self, fn):
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, fn)

    # ---------------------------------------------------------------------
    # Campaigns
    # ---------------------------------------------------------------------

    async def create_campaign(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not self._enabled:
            raise RuntimeError("OutboundStore disabled (CALL_HISTORY_ENABLED=false)")

        def _sync():
            now = _utcnow_iso()
            campaign_id = str(uuid.uuid4())
            name = _as_str(payload.get("name")).strip() or "Untitled Campaign"
            timezone_name = _validate_iana_timezone_name(_as_str(payload.get("timezone")).strip() or "UTC")
            daily_start = _as_str(payload.get("daily_window_start_local")).strip() or "09:00"
            daily_end = _as_str(payload.get("daily_window_end_local")).strip() or "17:00"
            max_concurrent = max(1, min(5, _as_int(payload.get("max_concurrent"), 1)))
            min_interval = max(0, _as_int(payload.get("min_interval_seconds_between_calls"), 5))
            default_context = _as_str(payload.get("default_context")).strip() or "default"
            business_id = max(1, _as_int(payload.get("business_id", payload.get("instance_id", 1)), 1))
            callerid = _as_str(payload.get("callerid")).strip() or None
            callerid_name = _as_str(payload.get("callerid_name")).strip() or None
            vm_enabled = 1 if bool(payload.get("voicemail_drop_enabled", True)) else 0
            vm_mode = _as_str(payload.get("voicemail_drop_mode")).strip() or "upload"
            vm_text = _as_str(payload.get("voicemail_drop_text")).strip() or None
            vm_uri = _as_str(payload.get("voicemail_drop_media_uri")).strip() or None
            consent_enabled = 1 if bool(payload.get("consent_enabled", False)) else 0
            consent_uri = _as_str(payload.get("consent_media_uri")).strip() or None
            consent_timeout = max(1, min(30, _as_int(payload.get("consent_timeout_seconds"), 5)))
            amd_opts = payload.get("amd_options") if isinstance(payload.get("amd_options"), dict) else {}
            max_attempts = max(1, min(20, _as_int(payload.get("max_attempts"), 3)))
            retry_initial = max(1, min(86400, _as_int(payload.get("retry_initial_delay_seconds"), 60)))
            try:
                retry_multiplier = float(payload.get("retry_backoff_multiplier", 2.0) or 2.0)
            except Exception:
                retry_multiplier = 2.0
            retry_multiplier = max(1.0, min(10.0, retry_multiplier))
            retry_max = max(retry_initial, min(604800, _as_int(payload.get("retry_max_delay_seconds"), 3600)))
            is_test = 1 if bool(payload.get("is_test", False)) else 0
            parent_campaign_id = _as_str(payload.get("parent_campaign_id")).strip() or None

            with self._lock:
                conn = self._get_connection()
                try:
                    conn.execute(
                        """
                        INSERT INTO outbound_campaigns (
                            id, business_id, name, status, timezone, run_start_at_utc, run_end_at_utc,
                            daily_window_start_local, daily_window_end_local,
                            max_concurrent, min_interval_seconds_between_calls,
                            default_context, callerid, callerid_name,
                            voicemail_drop_enabled, voicemail_drop_mode, voicemail_drop_text,
                            voicemail_drop_media_uri,
                            consent_enabled, consent_media_uri, consent_timeout_seconds,
                            amd_options_json,
                            external_source, external_id,
                            max_attempts, retry_initial_delay_seconds,
                            retry_backoff_multiplier, retry_max_delay_seconds,
                            is_test, parent_campaign_id,
                            created_at_utc, updated_at_utc
                        ) VALUES (
                            ?, ?, ?, ?, ?, ?, ?,
                            ?, ?,
                            ?, ?,
                            ?, ?, ?,
                            ?, ?, ?,
                            ?,
                            ?, ?, ?,
                            ?,
                            ?, ?,
                            ?, ?,
                            ?, ?,
                            ?, ?,
                            ?, ?
                        )
                        """,
                        (
                            campaign_id,
                            business_id,
                            name,
                            "draft",
                            timezone_name,
                            payload.get("run_start_at_utc"),
                            payload.get("run_end_at_utc"),
                            daily_start,
                            daily_end,
                            max_concurrent,
                            min_interval,
                            default_context,
                            callerid,
                            callerid_name,
                            vm_enabled,
                            vm_mode,
                            vm_text,
                            vm_uri,
                            consent_enabled,
                            consent_uri,
                            consent_timeout,
                            json.dumps(amd_opts or {}),
                            _as_str(payload.get("external_source")).strip() or None,
                            _as_str(payload.get("external_id")).strip() or None,
                            max_attempts,
                            retry_initial,
                            retry_multiplier,
                            retry_max,
                            is_test,
                            parent_campaign_id,
                            now,
                            now,
                        ),
                    )
                    if payload.get('source_number_id'):
                        conn.execute('UPDATE outbound_campaigns SET source_number_id=? WHERE id=?',
                                     (_as_str(payload['source_number_id']), campaign_id))
                    conn.commit()
                finally:
                    conn.close()
            return self.get_campaign_sync(campaign_id)

        return await self._run(_sync)

    def get_campaign_sync(self, campaign_id: str) -> Dict[str, Any]:
        with self._lock:
            conn = self._get_connection()
            try:
                row = conn.execute("SELECT * FROM outbound_campaigns WHERE id = ?", (campaign_id,)).fetchone()
                if not row:
                    raise KeyError("campaign not found")
                d = dict(row)
                d["amd_options"] = _safe_json_loads(str(d.get("amd_options_json") or "{}"))
                d.pop("amd_options_json", None)
                return d
            finally:
                conn.close()

    async def get_campaign(self, campaign_id: str) -> Dict[str, Any]:
        return await self._run(lambda: self.get_campaign_sync(campaign_id))

    async def find_campaign_by_external(self, external_source: str, external_id: str) -> Optional[Dict[str, Any]]:
        source = _as_str(external_source).strip()
        external = _as_str(external_id).strip()
        if not source or not external or not self._enabled:
            return None

        def _sync():
            with self._lock:
                conn = self._get_connection()
                try:
                    row = conn.execute(
                        "SELECT * FROM outbound_campaigns WHERE external_source = ? AND external_id = ?",
                        (source, external),
                    ).fetchone()
                    if not row:
                        return None
                    data = dict(row)
                    data["amd_options"] = _safe_json_loads(str(data.get("amd_options_json") or "{}"))
                    data.pop("amd_options_json", None)
                    return data
                finally:
                    conn.close()

        return await self._run(_sync)

    async def list_campaigns(
        self,
        *,
        include_archived: bool = False,
        business_id: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        if not self._enabled:
            return []

        def _sync():
            clauses = []
            args: List[Any] = []
            if not include_archived:
                clauses.append("status != ?")
                args.append("archived")
            if business_id is not None:
                clauses.append("business_id = ?")
                args.append(max(1, _as_int(business_id, 1)))
            where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

            with self._lock:
                conn = self._get_connection()
                try:
                    rows = conn.execute(
                        f"SELECT * FROM outbound_campaigns {where} ORDER BY created_at_utc DESC",
                        args,
                    ).fetchall()
                    out: List[Dict[str, Any]] = []
                    for r in rows:
                        d = dict(r)
                        d["amd_options"] = _safe_json_loads(str(d.get("amd_options_json") or "{}"))
                        d.pop("amd_options_json", None)
                        out.append(d)
                    return out
                finally:
                    conn.close()

        return await self._run(_sync)

    async def list_running_campaigns(self) -> List[Dict[str, Any]]:
        """Return campaigns with status=running (lightweight filter for scheduler)."""
        campaigns = await self.list_campaigns(include_archived=False)
        return [c for c in campaigns if (str(c.get("status") or "").lower() == "running")]

    async def update_campaign(
        self, campaign_id: str, payload: Dict[str, Any], *, business_id: Optional[int] = None
    ) -> Dict[str, Any]:
        if not self._enabled:
            raise RuntimeError("OutboundStore disabled")

        def _sync():
            now = _utcnow_iso()
            allowed_fields = {
                "name",
                "business_id",
                "timezone",
                "run_start_at_utc",
                "run_end_at_utc",
                "daily_window_start_local",
                "daily_window_end_local",
                "max_concurrent",
                "min_interval_seconds_between_calls",
                "default_context",
                "callerid",
                "callerid_name",
                "source_number_id",
                "voicemail_drop_enabled",
                "voicemail_drop_mode",
                "voicemail_drop_text",
                "voicemail_drop_media_uri",
                "consent_enabled",
                "consent_media_uri",
                "consent_timeout_seconds",
                "amd_options_json",
                "external_source",
                "external_id",
                "max_attempts",
                "retry_initial_delay_seconds",
                "retry_backoff_multiplier",
                "retry_max_delay_seconds",
                "is_test",
                "parent_campaign_id",
            }

            updates: Dict[str, Any] = {}
            for key in allowed_fields:
                if key in payload:
                    updates[key] = payload[key]
            if "amd_options" in payload and isinstance(payload.get("amd_options"), dict):
                updates["amd_options_json"] = json.dumps(payload.get("amd_options") or {})

            if "timezone" in updates:
                updates["timezone"] = _validate_iana_timezone_name(_as_str(updates.get("timezone")).strip() or "UTC")
            if "instance_id" in payload and "business_id" not in updates:
                updates["business_id"] = payload.get("instance_id")
            if "business_id" in updates:
                updates["business_id"] = max(1, _as_int(updates.get("business_id"), 1))

            if "max_concurrent" in updates:
                updates["max_concurrent"] = max(1, min(5, _as_int(updates.get("max_concurrent"), 1)))
            if "min_interval_seconds_between_calls" in updates:
                updates["min_interval_seconds_between_calls"] = max(
                    0, _as_int(updates.get("min_interval_seconds_between_calls"), 5)
                )
            if "voicemail_drop_enabled" in updates:
                updates["voicemail_drop_enabled"] = 1 if bool(updates.get("voicemail_drop_enabled")) else 0
            if "consent_enabled" in updates:
                updates["consent_enabled"] = 1 if bool(updates.get("consent_enabled")) else 0
            if "consent_timeout_seconds" in updates:
                updates["consent_timeout_seconds"] = max(1, min(30, _as_int(updates.get("consent_timeout_seconds"), 5)))
            if "max_attempts" in updates:
                updates["max_attempts"] = max(1, min(20, _as_int(updates.get("max_attempts"), 3)))
            if "retry_initial_delay_seconds" in updates:
                updates["retry_initial_delay_seconds"] = max(
                    1, min(86400, _as_int(updates.get("retry_initial_delay_seconds"), 60))
                )
            if "retry_backoff_multiplier" in updates:
                try:
                    updates["retry_backoff_multiplier"] = max(
                        1.0, min(10.0, float(updates.get("retry_backoff_multiplier") or 2.0))
                    )
                except Exception:
                    updates["retry_backoff_multiplier"] = 2.0
            if "retry_max_delay_seconds" in updates:
                floor = _as_int(updates.get("retry_initial_delay_seconds"), 60)
                updates["retry_max_delay_seconds"] = max(
                    floor, min(604800, _as_int(updates.get("retry_max_delay_seconds"), 3600))
                )
            if "is_test" in updates:
                updates["is_test"] = 1 if bool(updates.get("is_test")) else 0

            updates["updated_at_utc"] = now

            if not updates:
                return self.get_campaign_sync(campaign_id)

            set_clause = ", ".join([f"{k} = ?" for k in updates.keys()])
            scoped_business_id = max(1, _as_int(business_id, 1)) if business_id is not None else None
            where_scope = " AND business_id = ?" if scoped_business_id is not None else ""
            values = list(updates.values()) + [campaign_id]
            if scoped_business_id is not None:
                values.append(scoped_business_id)

            with self._lock:
                conn = self._get_connection()
                try:
                    cur = conn.execute(
                        f"UPDATE outbound_campaigns SET {set_clause} WHERE id = ?{where_scope}",
                        values,
                    )
                    if cur.rowcount == 0:
                        raise KeyError("campaign not found")
                    conn.commit()
                finally:
                    conn.close()

            return self.get_campaign_sync(campaign_id)

        return await self._run(_sync)

    async def set_campaign_status(self, campaign_id: str, status: str, *, cancel_pending: bool = False, business_id: Optional[int] = None) -> Dict[str, Any]:
        if not self._enabled:
            raise RuntimeError("OutboundStore disabled")

        status = (status or "").strip().lower()
        if status not in ("draft", "running", "paused", "stopped", "archived", "completed"):
            raise ValueError("invalid status")
        if business_id is not None and (type(business_id) is not int or business_id < 1):
            raise ValueError("Invalid campaign business scope")

        def _sync():
            now = _utcnow_iso()
            with self._lock:
                conn = self._get_connection()
                try:
                    cur = conn.execute(
                        "UPDATE outbound_campaigns SET status = ?, updated_at_utc = ? WHERE id = ? AND (? IS NULL OR business_id = ?)",
                        (status, now, campaign_id, business_id, business_id),
                    )
                    if cur.rowcount == 0:
                        raise KeyError("campaign not found")
                    if status == "stopped" and cancel_pending:
                        conn.execute(
                            """
                            UPDATE outbound_leads
                            SET state = 'canceled', leased_until_utc = NULL,
                                lease_token = NULL, next_attempt_at_utc = NULL, updated_at_utc = ?
                            WHERE campaign_id = ? AND state IN ('pending', 'leased')
                            """,
                            (now, campaign_id),
                        )
                    conn.commit()
                finally:
                    conn.close()
            return self.get_campaign_sync(campaign_id)

        return await self._run(_sync)

    async def delete_campaign(self, campaign_id: str) -> None:
        """
        Permanently delete a campaign and all associated leads/attempts.

        This is intentionally destructive and cannot be undone.
        """
        if not self._enabled:
            raise RuntimeError("OutboundStore disabled")

        def _sync():
            campaign = self.get_campaign_sync(campaign_id)
            if str(campaign.get("status") or "").lower() == "running":
                raise ValueError("cannot delete a running campaign")

            with self._lock:
                conn = self._get_connection()
                try:
                    cur = conn.cursor()
                    cur.execute("BEGIN IMMEDIATE")
                    if cur.execute("SELECT id FROM outbound_leads WHERE campaign_id=? AND state='unknown' LIMIT 1", (campaign_id,)).fetchone():
                        raise ValueError("Reconcile unknown call outcomes before deleting the campaign")
                    cur.execute("DELETE FROM outbound_attempts WHERE campaign_id = ?", (campaign_id,))
                    cur.execute("DELETE FROM outbound_leads WHERE campaign_id = ?", (campaign_id,))
                    cur.execute("DELETE FROM outbound_campaigns WHERE id = ?", (campaign_id,))
                    if cur.rowcount == 0:
                        raise KeyError("campaign not found")
                    conn.commit()
                except Exception:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    raise
                finally:
                    conn.close()

        return await self._run(_sync)

    async def clone_campaign(self, campaign_id: str) -> Dict[str, Any]:
        original = await self.get_campaign(campaign_id)
        payload = dict(original)
        payload.pop("id", None)
        payload.pop("created_at_utc", None)
        payload.pop("updated_at_utc", None)
        payload.pop("status", None)
        payload["name"] = f"{original.get('name') or 'Campaign'} (Copy)"
        return await self.create_campaign(payload)

    async def create_test_campaign(
        self,
        campaign_id: str,
        phone_number: str,
        *,
        name: Optional[str] = None,
        business_id: Optional[int] = None,
    ) -> Dict[str, Dict[str, Any]]:
        """Clone campaign telephony settings into an isolated one-lead, one-attempt run."""
        if not self._enabled:
            raise RuntimeError("OutboundStore disabled")
        normalized_phone = _normalize_phone_number(phone_number)

        def _sync():
            now_dt = datetime.now(timezone.utc)
            now = now_dt.isoformat()
            test_campaign_id = str(uuid.uuid4())
            lead_id = str(uuid.uuid4())
            with self._lock:
                conn = self._get_connection()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    source = conn.execute(
                        "SELECT * FROM outbound_campaigns WHERE id=?",
                        (campaign_id,),
                    ).fetchone()
                    if not source:
                        raise KeyError("campaign not found")
                    source_data = dict(source)
                    source_business_id = max(1, _as_int(source_data.get("business_id"), 1))
                    if business_id is not None and max(1, _as_int(business_id, 1)) != source_business_id:
                        raise ValueError("Campaign business scope mismatch")

                    active = conn.execute(
                        """
                        SELECT id FROM outbound_leads
                        WHERE business_id=? AND phone_number=?
                          AND state IN ('leased','dialing','amd_pending','in_progress')
                        LIMIT 1
                        """,
                        (source_business_id, normalized_phone),
                    ).fetchone()
                    if active:
                        raise RuntimeError("An active call already exists for this business and phone number")

                    campaign_data = dict(source_data)
                    campaign_data.update(
                        {
                            "id": test_campaign_id,
                            "name": f"[Test] {source_data.get('name') or 'Campaign'}",
                            "status": "running",
                            "timezone": "UTC",
                            "run_start_at_utc": now,
                            "run_end_at_utc": (now_dt + timedelta(minutes=15)).isoformat(),
                            "daily_window_start_local": "00:00",
                            "daily_window_end_local": "23:59",
                            "max_concurrent": 1,
                            "min_interval_seconds_between_calls": 0,
                            "max_attempts": 1,
                            "is_test": 1,
                            "parent_campaign_id": campaign_id,
                            "external_source": None,
                            "external_id": None,
                            "created_at_utc": now,
                            "updated_at_utc": now,
                        }
                    )
                    columns = [str(row[1]) for row in conn.execute("PRAGMA table_info(outbound_campaigns)")]
                    quoted = ", ".join(f'"{column}"' for column in columns)
                    placeholders = ", ".join("?" for _ in columns)
                    conn.execute(
                        f"INSERT INTO outbound_campaigns ({quoted}) VALUES ({placeholders})",
                        [campaign_data.get(column) for column in columns],
                    )
                    conn.execute(
                        """
                        INSERT INTO outbound_leads (
                            id, campaign_id, business_id, name, phone_number,
                            custom_vars_json, state, attempt_count, next_attempt_at_utc,
                            created_at_utc, updated_at_utc
                        ) VALUES (?, ?, ?, ?, ?, '{}', 'pending', 0, ?, ?, ?)
                        """,
                        (
                            lead_id,
                            test_campaign_id,
                            source_business_id,
                            _as_str(name).strip() or "Test recipient",
                            normalized_phone,
                            now,
                            now,
                            now,
                        ),
                    )
                    conn.commit()
                    campaign_row = conn.execute(
                        "SELECT * FROM outbound_campaigns WHERE id=?", (test_campaign_id,)
                    ).fetchone()
                    lead_row = conn.execute("SELECT * FROM outbound_leads WHERE id=?", (lead_id,)).fetchone()
                    campaign = dict(campaign_row)
                    campaign["amd_options"] = _safe_json_loads(str(campaign.get("amd_options_json") or "{}"))
                    campaign.pop("amd_options_json", None)
                    lead = dict(lead_row)
                    lead["custom_vars"] = _safe_json_loads(str(lead.get("custom_vars_json") or "{}"))
                    lead.pop("custom_vars_json", None)
                    return {"test_campaign": campaign, "lead": lead}
                except Exception:
                    conn.rollback()
                    raise
                finally:
                    conn.close()

        return await self._run(_sync)

    async def cleanup_stale_attempts_and_leads(self, *, stale_seconds: int = 120) -> Dict[str, int]:
        """Compatibility recovery when no ARI reconciler is available (primarily tests/tools)."""
        if not self._enabled:
            return {"attempts_closed": 0, "leads_failed": 0}
        rows = await self.list_stale_attempts(stale_seconds=stale_seconds)
        attempts_closed = 0
        leads_failed = 0
        for row in rows:
            result = await self.finalize_attempt(
                str(row["id"]),
                outcome="stale_timeout",
                disposition="retryable",
                business_id=int(row.get("business_id") or 1),
                error_stage="originate" if not row.get("ari_channel_id") else "provider_sip",
                error_code="stale_attempt_timeout",
                error_message="stale attempt cleanup (engine restart or pre-answer failure)",
                call_id=str(row.get("call_id") or row.get("ari_channel_id") or "") or None,
            )
            attempts_closed += 1
            if result.get("lead_state") == "failed":
                leads_failed += 1
        return {"attempts_closed": attempts_closed, "leads_failed": leads_failed}

    async def list_stale_attempts(self, *, stale_seconds: int = 120) -> List[Dict[str, Any]]:
        if not self._enabled:
            return []

        def _sync():
            cutoff = (datetime.now(timezone.utc) - timedelta(seconds=max(10, int(stale_seconds or 120)))).isoformat()
            with self._lock:
                conn = self._get_connection()
                try:
                    rows = conn.execute(
                        """
                        SELECT a.*, l.state AS lead_state, l.phone_number
                        FROM outbound_attempts a
                        JOIN outbound_leads l ON l.id=a.lead_id
                        WHERE a.ended_at_utc IS NULL
                          AND a.started_at_utc < ?
                          AND l.state IN ('dialing','amd_pending','in_progress')
                        ORDER BY a.started_at_utc ASC
                        """,
                        (cutoff,),
                    ).fetchall()
                    return [dict(row) for row in rows]
                finally:
                    conn.close()

        return await self._run(_sync)

    # ---------------------------------------------------------------------
    # Leads
    # ---------------------------------------------------------------------

    async def lease_pending_leads(
        self,
        campaign_id: str,
        *,
        limit: int,
        lease_seconds: int = 60,
        business_id: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """
        Atomically lease up to N pending leads.

        Notes:
        - This avoids reliance on SQLite RETURNING to be compatible with older distros.
        - Leases expire via leased_until_utc; expired leased leads are eligible again.
        """
        if not self._enabled:
            return []

        def _sync():
            now_dt = datetime.now(timezone.utc)
            now = now_dt.isoformat()
            lease_until = (now_dt + timedelta(seconds=max(1, int(lease_seconds or 60)))).isoformat()
            batch = max(0, min(200, int(limit or 0)))
            scoped_business_id = max(1, _as_int(business_id, 1)) if business_id is not None else None
            if batch <= 0:
                return []

            with self._lock:
                conn = self._get_connection()
                try:
                    cur = conn.cursor()
                    cur.execute("BEGIN IMMEDIATE")
                    campaign = cur.execute(
                        "SELECT business_id, max_attempts FROM outbound_campaigns WHERE id=?",
                        (campaign_id,),
                    ).fetchone()
                    if not campaign:
                        conn.commit()
                        return []
                    campaign_business_id = max(1, _as_int(campaign["business_id"], 1))
                    if scoped_business_id is not None and scoped_business_id != campaign_business_id:
                        conn.commit()
                        return []
                    max_attempts = max(1, _as_int(campaign["max_attempts"], 3))
                    cur.execute(
                        """
                        UPDATE outbound_leads
                        SET state='failed', last_outcome=COALESCE(last_outcome, 'max_attempts'),
                            leased_until_utc=NULL, lease_token=NULL, next_attempt_at_utc=NULL,
                            updated_at_utc=?
                        WHERE campaign_id=? AND business_id=? AND state IN ('pending','leased')
                          AND attempt_count>=?
                        """,
                        (now, campaign_id, campaign_business_id, max_attempts),
                    )
                    rows = cur.execute(
                        """
                        SELECT l.id
                        FROM outbound_leads l
                        WHERE l.campaign_id = ?
                          AND l.business_id = ?
                          AND l.attempt_count < ?
                          AND (
                            (l.state = 'pending' AND (l.next_attempt_at_utc IS NULL OR l.next_attempt_at_utc <= ?))
                            OR (l.state = 'leased' AND l.leased_until_utc IS NOT NULL AND l.leased_until_utc < ?)
                          )
                        ORDER BY COALESCE(l.next_attempt_at_utc, l.created_at_utc) ASC, l.created_at_utc ASC
                        LIMIT ?
                        """,
                        (campaign_id, campaign_business_id, max_attempts, now, now, batch),
                    ).fetchall()
                    lead_ids = [str(r["id"]) for r in rows]
                    if not lead_ids:
                        conn.commit()
                        return []

                    tokens: Dict[str, str] = {}
                    for lead_id in lead_ids:
                        token = str(uuid.uuid4())
                        tokens[lead_id] = token
                        cur.execute(
                            """
                            UPDATE outbound_leads
                            SET state='leased', leased_until_utc=?, lease_token=?, updated_at_utc=?
                            WHERE id=? AND business_id=?
                            """,
                            (lease_until, token, now, lead_id, campaign_business_id),
                        )
                    conn.commit()

                    placeholders = ",".join(["?"] * len(lead_ids))
                    data_rows = conn.execute(
                        f"SELECT * FROM outbound_leads WHERE id IN ({placeholders})",
                        lead_ids,
                    ).fetchall()
                    by_id = {str(r["id"]): dict(r) for r in data_rows}
                    out: List[Dict[str, Any]] = []
                    for lead_id in lead_ids:
                        d = by_id.get(lead_id)
                        if not d:
                            continue
                        d["custom_vars"] = _safe_json_loads(str(d.get("custom_vars_json") or "{}"))
                        d.pop("custom_vars_json", None)
                        d["lease_token"] = tokens.get(lead_id)
                        out.append(d)
                    return out
                except Exception:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    raise
                finally:
                    conn.close()

        return await self._run(_sync)

    async def mark_lead_dialing(self, lead_id: str) -> bool:
        """Transition a lead from leased -> dialing and increment attempt_count."""
        if not self._enabled:
            return False

        def _sync():
            now = _utcnow_iso()
            with self._lock:
                conn = self._get_connection()
                try:
                    cur = conn.execute(
                        """
                        UPDATE outbound_leads
                        SET state='dialing',
                            attempt_count=attempt_count+1,
                            last_attempt_at_utc=?,
                            leased_until_utc=NULL,
                            updated_at_utc=?
                        WHERE id=? AND state='leased'
                        """,
                        (now, now, lead_id),
                    )
                    conn.commit()
                    return cur.rowcount > 0
                finally:
                    conn.close()

        return await self._run(_sync)

    async def cancel_leased_for_policy(self, campaign_id: str, lead_id: str, *, business_id: int, lease_token: str) -> bool:
        """Revoke only this unstarted lease, never an active/unknown/new lease."""
        def _sync():
            with self._lock:
                conn = self._get_connection()
                try:
                    cur = conn.execute("""UPDATE outbound_leads SET state='canceled',
                        last_outcome='crm_do_not_call',leased_until_utc=NULL,lease_token=NULL,
                        next_attempt_at_utc=NULL,updated_at_utc=?
                        WHERE id=? AND campaign_id=? AND business_id=? AND state='leased' AND lease_token=?""",
                        (_utcnow_iso(),lead_id,campaign_id,business_id,lease_token))
                    conn.commit()
                    return cur.rowcount == 1
                finally:
                    conn.close()
        return await self._run(_sync)

    async def set_lead_state(
        self,
        lead_id: str,
        *,
        state: str,
        last_outcome: Optional[str] = None,
        business_id: Optional[int] = None,
    ) -> None:
        if not self._enabled:
            return

        state = (state or "").strip().lower()
        allowed = {
            "pending",
            "leased",
            "dialing",
            "amd_pending",
            "in_progress",
            "completed",
            "failed",
            "canceled",
        }
        if state not in allowed:
            raise ValueError("invalid lead state")

        def _sync():
            now = _utcnow_iso()
            scoped_business_id = max(1, _as_int(business_id, 1)) if business_id is not None else None
            with self._lock:
                conn = self._get_connection()
                try:
                    conn.execute(
                        """
                        UPDATE outbound_leads
                        SET state=?,
                            last_outcome=COALESCE(?, last_outcome),
                            leased_until_utc=NULL,
                            lease_token=NULL,
                            next_attempt_at_utc=CASE WHEN ?='pending' THEN NULL ELSE next_attempt_at_utc END,
                            updated_at_utc=?
                        WHERE id=? AND state<>'unknown' AND (? IS NULL OR business_id=?)
                        """,
                        (state, last_outcome, state, now, lead_id, scoped_business_id, scoped_business_id),
                    )
                    conn.commit()
                finally:
                    conn.close()

        await self._run(_sync)

    async def import_leads_csv(
        self,
        campaign_id: str,
        csv_bytes: bytes,
        *,
        skip_existing: bool = True,
        max_error_rows: int = 20,
        known_contexts: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Import leads for a campaign.

        Expected columns:
          - name (optional; stored on lead and used for caller_name in outbound greeting)
          - phone_number (required)
          - custom_vars (optional JSON)
          - context (optional)
          - timezone (optional)
          - caller_id (optional; stored but MVP uses extension identity)
        """
        if not self._enabled:
            raise RuntimeError("OutboundStore disabled")

        def _sync():
            now = _utcnow_iso()
            accepted = 0
            rejected = 0
            duplicates = 0
            errors: List[ImportErrorRow] = []
            warnings: List[ImportWarningRow] = []
            warning_total = 0

            # CSV decode
            text = (csv_bytes or b"").decode("utf-8-sig", errors="replace")
            reader = csv.DictReader(io.StringIO(text))
            if not reader.fieldnames:
                raise ValueError("CSV missing header row")

            normalized_to_raw: Dict[str, str] = {}
            for h in (reader.fieldnames or []):
                if not h:
                    continue
                normalized = _normalize_header_key(h)
                if normalized:
                    normalized_to_raw[normalized] = h

            phone_key = (
                normalized_to_raw.get("phone_number")
                or normalized_to_raw.get("phone")
                or normalized_to_raw.get("number")
            )
            if not phone_key:
                raise ValueError("CSV must include 'phone_number' column")

            custom_vars_key = normalized_to_raw.get("custom_vars")
            context_key = normalized_to_raw.get("context")
            tz_key = normalized_to_raw.get("timezone")
            caller_id_key = normalized_to_raw.get("caller_id")
            name_key = normalized_to_raw.get("name")

            with self._lock:
                conn = self._get_connection()
                try:
                    # Campaign defaults (applied when CSV field is missing/blank/invalid)
                    camp = conn.execute(
                        "SELECT timezone, default_context, business_id FROM outbound_campaigns WHERE id=?",
                        (campaign_id,),
                    ).fetchone()
                    if not camp:
                        raise KeyError("Campaign not found")

                    campaign_timezone_raw = _as_str(camp["timezone"]).strip()
                    campaign_default_context_raw = _as_str(camp["default_context"]).strip()
                    campaign_business_id = max(1, _as_int(camp["business_id"], 1))

                    try:
                        campaign_timezone = _validate_iana_timezone_name(campaign_timezone_raw or "UTC")
                    except Exception:
                        campaign_timezone = "UTC"

                    campaign_default_context = campaign_default_context_raw or "default"
                    if not re.match(r"^[a-zA-Z0-9_.-]{1,64}$", campaign_default_context):
                        campaign_default_context = "default"

                    known_ctx: Optional[set[str]] = None
                    if known_contexts:
                        try:
                            known_ctx = {str(x).strip() for x in known_contexts if str(x).strip()}
                        except Exception:
                            known_ctx = None

                    for idx, row in enumerate(reader, start=2):  # header is row 1
                        raw_phone = _as_str((row or {}).get(phone_key)).strip()
                        try:
                            phone = _normalize_phone_number(raw_phone)
                        except Exception as exc:
                            rejected += 1
                            if len(errors) < max_error_rows:
                                errors.append(ImportErrorRow(idx, (raw_phone or ""), str(exc)))
                            continue

                        custom_vars_raw = _as_str((row or {}).get(custom_vars_key)).strip() if custom_vars_key else ""
                        if custom_vars_raw:
                            try:
                                custom_vars = json.loads(custom_vars_raw)
                                if not isinstance(custom_vars, dict):
                                    raise ValueError("custom_vars must be a JSON object")
                            except Exception as exc:
                                rejected += 1
                                if len(errors) < max_error_rows:
                                    errors.append(ImportErrorRow(idx, phone, f"Invalid custom_vars JSON: {exc}"))
                                continue
                        else:
                            custom_vars = {}

                        # Context:
                        # - Missing/blank => campaign default_context
                        # - Invalid/unknown => warn + overwrite to campaign default_context
                        context_raw = _as_str((row or {}).get(context_key)).strip() if context_key else ""
                        context_candidate = context_raw.strip()
                        if not context_candidate:
                            context_override = campaign_default_context
                        else:
                            if not re.match(r"^[a-zA-Z0-9_.-]{1,64}$", context_candidate):
                                warning_total += 1
                                if len(warnings) < max_error_rows:
                                    warnings.append(
                                        ImportWarningRow(
                                            idx,
                                            phone,
                                            f"Invalid context '{context_candidate}' (overwritten with campaign default '{campaign_default_context}')",
                                        )
                                    )
                                context_override = campaign_default_context
                            elif known_ctx is not None and context_candidate not in known_ctx:
                                warning_total += 1
                                if len(warnings) < max_error_rows:
                                    warnings.append(
                                        ImportWarningRow(
                                            idx,
                                            phone,
                                            f"Unknown context '{context_candidate}' (overwritten with campaign default '{campaign_default_context}')",
                                        )
                                    )
                                context_override = campaign_default_context
                            else:
                                context_override = context_candidate

                        # Timezone:
                        # - Missing/blank => campaign timezone
                        # - Invalid IANA tz => warn + overwrite to campaign timezone
                        tz_override_raw = _as_str((row or {}).get(tz_key)).strip() if tz_key else ""
                        tz_candidate = (tz_override_raw or "").strip()
                        if not tz_candidate:
                            tz_override = campaign_timezone
                        else:
                            try:
                                tz_override = _validate_iana_timezone_name(tz_candidate)
                            except Exception:
                                warning_total += 1
                                if len(warnings) < max_error_rows:
                                    warnings.append(
                                        ImportWarningRow(
                                            idx,
                                            phone,
                                            f"Invalid timezone '{tz_candidate}' (overwritten with campaign timezone '{campaign_timezone}')",
                                        )
                                    )
                                tz_override = campaign_timezone

                        caller_id_override = _as_str((row or {}).get(caller_id_key)).strip() if caller_id_key else ""
                        caller_id_override = caller_id_override or None
                        lead_name = _as_str((row or {}).get(name_key)).strip() if name_key else ""
                        lead_name = lead_name or None

                        lead_id = str(uuid.uuid4())
                        try:
                            conn.execute(
                                """
                                INSERT INTO outbound_leads (
                                    id, campaign_id, business_id, name, phone_number,
                                    lead_timezone, context_override, caller_id_override,
                                    custom_vars_json, state,
                                    attempt_count, created_at_utc, updated_at_utc
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
                                """,
                                (
                                    lead_id,
                                    campaign_id,
                                    campaign_business_id,
                                    lead_name,
                                    phone,
                                    tz_override,
                                    context_override,
                                    caller_id_override,
                                    json.dumps(custom_vars or {}),
                                    now,
                                    now,
                                ),
                            )
                            accepted += 1
                        except sqlite3.IntegrityError:
                            duplicates += 1
                            if skip_existing:
                                continue
                            # update_existing (optional)
                            conn.execute(
                                """
                                UPDATE outbound_leads
                                SET name = COALESCE(?, name),
                                    lead_timezone = COALESCE(?, lead_timezone),
                                    context_override = COALESCE(?, context_override),
                                    caller_id_override = COALESCE(?, caller_id_override),
                                    custom_vars_json = ?,
                                    updated_at_utc = ?
                                WHERE campaign_id = ? AND phone_number = ?
                                """,
                                (
                                    lead_name,
                                    tz_override,
                                    context_override,
                                    caller_id_override,
                                    json.dumps(custom_vars or {}),
                                    now,
                                    campaign_id,
                                    phone,
                                ),
                            )
                    conn.commit()
                finally:
                    conn.close()

            error_csv_value = ""
            if errors:
                error_csv = io.StringIO()
                w = csv.writer(error_csv)
                w.writerow(["row_number", "phone_number", "error_reason"])
                for e in errors:
                    w.writerow([e.row_number, e.phone_number, e.error_reason])
                error_csv_value = error_csv.getvalue()

            return {
                "accepted": accepted,
                "rejected": rejected,
                "duplicates": duplicates,
                "errors": [e.__dict__ for e in errors],
                "error_csv": error_csv_value,
                "error_csv_truncated": rejected > len(errors),
                "warnings": [w.__dict__ for w in warnings],
                "warnings_truncated": warning_total > len(warnings),
            }

        return await self._run(_sync)

    async def list_leads(
        self,
        campaign_id: str,
        *,
        page: int = 1,
        page_size: int = 50,
        state: Optional[str] = None,
        q: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not self._enabled:
            return {"leads": [], "total": 0, "page": page, "page_size": page_size, "total_pages": 0}

        def _sync():
            page_i = max(1, int(page or 1))
            size_i = max(1, min(200, int(page_size or 50)))
            offset = (page_i - 1) * size_i

            clauses = ["l.campaign_id = ?"]
            args: List[Any] = [campaign_id]

            if state:
                clauses.append("l.state = ?")
                args.append(state)
            if q:
                clauses.append("(l.phone_number LIKE ? OR COALESCE(l.name,'') LIKE ?)")
                args.append(f"%{q}%")
                args.append(f"%{q}%")

            where = " AND ".join(clauses)
            with self._lock:
                conn = self._get_connection()
                try:
                    total = conn.execute(
                        f"SELECT COUNT(*) AS c FROM outbound_leads l WHERE {where}",
                        args,
                    ).fetchone()["c"]
                    rows = conn.execute(
                        f"""
                        SELECT
                            l.*,
                            a.started_at_utc AS last_started_at_utc,
                            a.ended_at_utc AS last_ended_at_utc,
                            a.duration_seconds AS last_duration_seconds,
                            a.outcome AS last_outcome_attempt,
                            a.amd_status AS last_amd_status,
                            a.amd_cause AS last_amd_cause,
                            a.consent_dtmf AS last_consent_dtmf,
                            a.consent_result AS last_consent_result,
                            a.context AS last_context,
                            a.provider AS last_provider,
                            a.call_id AS last_call_id,
                            a.call_history_call_id AS last_call_history_call_id,
                            a.error_stage AS last_error_stage,
                            a.error_code AS last_error_code,
                            a.retryable AS last_retryable,
                            a.error_message AS last_error_message
                        FROM outbound_leads l
                        LEFT JOIN outbound_attempts a
                          ON a.id = (
                            SELECT id
                            FROM outbound_attempts
                            WHERE lead_id = l.id
                            ORDER BY started_at_utc DESC
                            LIMIT 1
                          )
                        WHERE {where}
                        ORDER BY l.created_at_utc DESC
                        LIMIT ? OFFSET ?
                        """,
                        args + [size_i, offset],
                    ).fetchall()
                    out = []
                    for r in rows:
                        d = dict(r)
                        d["custom_vars"] = _safe_json_loads(str(d.get("custom_vars_json") or "{}"))
                        d.pop("custom_vars_json", None)
                        if d.get("last_error_message"):
                            d["last_error_message"] = sanitize_outbound_error(d.get("last_error_message"))
                        out.append(d)
                    total_pages = (total + size_i - 1) // size_i
                    return {"leads": out, "total": total, "page": page_i, "page_size": size_i, "total_pages": total_pages}
                finally:
                    conn.close()

        return await self._run(_sync)

    async def cancel_lead(self, lead_id: str) -> bool:
        if not self._enabled:
            return False

        def _sync():
            now = _utcnow_iso()
            with self._lock:
                conn = self._get_connection()
                try:
                    cur = conn.execute(
                        """
                        UPDATE outbound_leads
                        SET state='canceled', leased_until_utc=NULL, lease_token=NULL,
                            next_attempt_at_utc=NULL, updated_at_utc=?
                        WHERE id=? AND state IN ('pending','leased','dialing','amd_pending')
                        """,
                        (now, lead_id),
                    )
                    conn.commit()
                    return cur.rowcount > 0
                finally:
                    conn.close()

        return await self._run(_sync)

    async def ignore_lead(self, lead_id: str) -> bool:
        """
        Mark a lead as ignored (state=canceled). Reversible via recycle.

        This is the operator-facing "Ignore" action in the Scheduling UI.
        """
        if not self._enabled:
            return False

        def _sync():
            now = _utcnow_iso()
            with self._lock:
                conn = self._get_connection()
                try:
                    cur = conn.execute(
                        """
                        UPDATE outbound_leads
                        SET state='canceled',
                            leased_until_utc=NULL,
                            lease_token=NULL,
                            next_attempt_at_utc=NULL,
                            updated_at_utc=?
                        WHERE id=? AND state NOT IN ('in_progress','amd_pending')
                        """,
                        (now, lead_id),
                    )
                    conn.commit()
                    return cur.rowcount > 0
                finally:
                    conn.close()

        return await self._run(_sync)

    async def recycle_lead(
        self, lead_id: str, *, mode: str = "redial", business_id: Optional[int] = None
    ) -> bool:
        """
        Re-queue a lead by moving it back to 'pending'.

        MVP policy:
        - Allowed from canceled/failed/completed (manual retry only; no automatic retries in v1).
        - attempt_count is preserved; attempts table remains the audit trail.
        """
        if not self._enabled:
            return False

        def _sync():
            now = _utcnow_iso()
            scoped_business_id = max(1, _as_int(business_id, 1)) if business_id is not None else None
            with self._lock:
                conn = self._get_connection()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    scoped = conn.execute(
                        "SELECT business_id,state FROM outbound_leads WHERE id=?",
                        (lead_id,),
                    ).fetchone()
                    if not scoped or (
                        scoped_business_id is not None
                        and max(1, _as_int(scoped["business_id"], 1)) != scoped_business_id
                    ):
                        conn.commit()
                        return False
                    if scoped["state"] == "unknown":
                        # A timeout or worker restart is not proof the customer
                        # was never called. Reset/redial must retain this fence.
                        conn.commit()
                        return False
                    m = (mode or "redial").strip().lower()
                    if m == "reset":
                        # Reset completely: delete attempts and reset lead counters/state.
                        conn.execute("DELETE FROM outbound_attempts WHERE lead_id = ?", (lead_id,))
                        cur = conn.execute(
                            """
                            UPDATE outbound_leads
                            SET state='pending',
                                attempt_count=0,
                                last_outcome=NULL,
                                last_attempt_at_utc=NULL,
                                leased_until_utc=NULL,
                                lease_token=NULL,
                                next_attempt_at_utc=NULL,
                                updated_at_utc=?
                            WHERE id=? AND (? IS NULL OR business_id=?)
                            """,
                            (now, lead_id, scoped_business_id, scoped_business_id),
                        )
                    else:
                        # Re-dial: keep attempts/history; requeue lead.
                        cur = conn.execute(
                            """
                            UPDATE outbound_leads
                            SET state='pending',
                                last_outcome=NULL,
                                leased_until_utc=NULL,
                                lease_token=NULL,
                                next_attempt_at_utc=NULL,
                                updated_at_utc=?
                            WHERE id=? AND (? IS NULL OR business_id=?)
                            """,
                            (now, lead_id, scoped_business_id, scoped_business_id),
                        )
                    conn.commit()
                    return cur.rowcount > 0
                finally:
                    conn.close()

        return await self._run(_sync)

    async def delete_lead(self, lead_id: str) -> None:
        """
        Hard delete a lead and all its attempts.

        The API layer should block this while a campaign is running.
        """
        if not self._enabled:
            raise RuntimeError("OutboundStore disabled")

        def _sync():
            with self._lock:
                conn = self._get_connection()
                try:
                    row = conn.execute(
                        "SELECT campaign_id,state FROM outbound_leads WHERE id=?",
                        (lead_id,),
                    ).fetchone()
                    if not row:
                        raise KeyError("lead not found")
                    if row["state"] == "unknown":
                        raise ValueError("Reconcile the unknown call outcome before deleting the lead")
                    campaign_id = str(row["campaign_id"])
                    camp = conn.execute(
                        "SELECT status FROM outbound_campaigns WHERE id=?",
                        (campaign_id,),
                    ).fetchone()
                    if camp and str(camp["status"] or "").strip().lower() == "running":
                        raise ValueError("Pause/stop the campaign before deleting leads")

                    conn.execute("DELETE FROM outbound_attempts WHERE lead_id=?", (lead_id,))
                    conn.execute("DELETE FROM outbound_leads WHERE id=?", (lead_id,))
                    conn.commit()
                finally:
                    conn.close()

        await self._run(_sync)

    async def campaign_stats(self, campaign_id: str) -> Dict[str, Any]:
        if not self._enabled:
            return {}

        def _sync():
            with self._lock:
                conn = self._get_connection()
                try:
                    lead_rows = conn.execute(
                        "SELECT state, COUNT(*) AS c FROM outbound_leads WHERE campaign_id=? GROUP BY state",
                        (campaign_id,),
                    ).fetchall()
                    attempt_rows = conn.execute(
                        "SELECT outcome, COUNT(*) AS c FROM outbound_attempts WHERE campaign_id=? GROUP BY outcome",
                        (campaign_id,),
                    ).fetchall()
                    return {
                        "lead_states": {str(r["state"]): int(r["c"]) for r in lead_rows},
                        "attempt_outcomes": {str(r["outcome"]): int(r["c"]) for r in attempt_rows if r["outcome"] is not None},
                    }
                finally:
                    conn.close()

        return await self._run(_sync)

    # ---------------------------------------------------------------------
    # Attempts
    # ---------------------------------------------------------------------

    async def list_attempts(
        self,
        campaign_id: str,
        *,
        page: int = 1,
        page_size: int = 50,
    ) -> Dict[str, Any]:
        if not self._enabled:
            return {"attempts": [], "total": 0, "page": page, "page_size": page_size, "total_pages": 0}

        def _sync():
            page_i = max(1, int(page or 1))
            size_i = max(1, min(200, int(page_size or 50)))
            offset = (page_i - 1) * size_i

            with self._lock:
                conn = self._get_connection()
                try:
                    total = conn.execute(
                        "SELECT COUNT(*) AS c FROM outbound_attempts WHERE campaign_id=?",
                        (campaign_id,),
                    ).fetchone()["c"]
                    rows = conn.execute(
                        """
                        SELECT a.*, l.phone_number, l.name
                        FROM outbound_attempts a
                        LEFT JOIN outbound_leads l ON l.id = a.lead_id
                        WHERE a.campaign_id=?
                        ORDER BY a.started_at_utc DESC
                        LIMIT ? OFFSET ?
                        """,
                        (campaign_id, size_i, offset),
                    ).fetchall()
                    out = []
                    for row in rows:
                        data = dict(row)
                        if data.get("error_message"):
                            data["error_message"] = sanitize_outbound_error(data.get("error_message"))
                        out.append(data)
                    total_pages = (total + size_i - 1) // size_i
                    return {"attempts": out, "total": total, "page": page_i, "page_size": size_i, "total_pages": total_pages}
                finally:
                    conn.close()

        return await self._run(_sync)

    async def start_attempt(
        self,
        campaign_id: str,
        lead_id: str,
        *,
        lease_token: Optional[str] = None,
        context: Optional[str] = None,
        provider: Optional[str] = None,
        business_id: Optional[int] = None,
    ) -> str:
        if not self._enabled:
            raise RuntimeError("OutboundStore disabled")

        def _sync():
            attempt_id = str(uuid.uuid4())
            now = _utcnow_iso()
            with self._lock:
                conn = self._get_connection()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    row = conn.execute(
                        """
                        SELECT
                            c.business_id AS campaign_business_id,
                            c.status AS campaign_status,
                            c.max_attempts,
                            l.business_id AS lead_business_id,
                            l.state,
                            l.lease_token,
                            l.leased_until_utc,
                            l.attempt_count
                        FROM outbound_campaigns c
                        JOIN outbound_leads l ON l.campaign_id = c.id
                        WHERE c.id = ? AND l.id = ?
                        """,
                        (campaign_id, lead_id),
                    ).fetchone()
                    if not row:
                        raise ValueError("Campaign/lead pair not found")
                    campaign_business_id = max(1, _as_int(row["campaign_business_id"], 1))
                    lead_business_id = max(1, _as_int(row["lead_business_id"], 1))
                    if campaign_business_id != lead_business_id:
                        raise ValueError("Campaign and lead business scope mismatch")
                    scoped_business_id = max(1, _as_int(business_id, campaign_business_id))
                    if scoped_business_id != campaign_business_id:
                        raise ValueError("Attempt business scope mismatch")
                    # A control command may arrive while a leased batch prepares
                    # its opening. Recheck atomically before recording an attempt;
                    # the scheduler's earlier running snapshot is not authority.
                    if row["campaign_status"] != "running":
                        raise ValueError("Campaign is not running")
                    if str(row["state"] or "") != "leased":
                        raise ValueError("Lead is not leased")
                    current_token = str(row["lease_token"] or "")
                    if lease_token is not None and str(lease_token) != current_token:
                        raise ValueError("Lead lease token mismatch")
                    leased_until = str(row["leased_until_utc"] or "")
                    if leased_until and leased_until < now:
                        raise ValueError("Lead lease expired")
                    if int(row["attempt_count"] or 0) >= max(1, _as_int(row["max_attempts"], 3)):
                        raise ValueError("Lead maximum attempts exhausted")
                    open_attempt = conn.execute(
                        "SELECT id FROM outbound_attempts WHERE lead_id=? AND ended_at_utc IS NULL LIMIT 1",
                        (lead_id,),
                    ).fetchone()
                    if open_attempt:
                        raise ValueError("Lead already has an active attempt")
                    conn.execute(
                        """
                        INSERT INTO outbound_attempts (id, campaign_id, lead_id, business_id, started_at_utc, context, provider)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (attempt_id, campaign_id, lead_id, scoped_business_id, now, context, provider),
                    )
                    cur = conn.execute(
                        """
                        UPDATE outbound_leads
                        SET state='dialing', attempt_count=attempt_count+1,
                            last_attempt_at_utc=?, leased_until_utc=NULL, lease_token=NULL,
                            next_attempt_at_utc=NULL, updated_at_utc=?
                        WHERE id=? AND campaign_id=? AND business_id=? AND state='leased'
                        """,
                        (now, now, lead_id, campaign_id, scoped_business_id),
                    )
                    if cur.rowcount != 1:
                        raise ValueError("Lead state transition failed")
                    conn.commit()
                except Exception:
                    conn.rollback()
                    raise
                finally:
                    conn.close()
            return attempt_id

        return await self._run(_sync)

    async def create_attempt(
        self,
        campaign_id: str,
        lead_id: str,
        *,
        lease_token: Optional[str] = None,
        context: Optional[str] = None,
        provider: Optional[str] = None,
        business_id: Optional[int] = None,
    ) -> str:
        """Compatibility wrapper for callers migrating to atomic start_attempt()."""
        return await self.start_attempt(
            campaign_id,
            lead_id,
            lease_token=lease_token,
            context=context,
            provider=provider,
            business_id=business_id,
        )

    async def set_attempt_channel(self, attempt_id: str, channel_id: str) -> None:
        if not self._enabled:
            return

        def _sync():
            with self._lock:
                conn = self._get_connection()
                try:
                    conn.execute(
                        "UPDATE outbound_attempts SET ari_channel_id=?, call_id=? WHERE id=?",
                        (channel_id, channel_id, attempt_id),
                    )
                    conn.commit()
                finally:
                    conn.close()

        await self._run(_sync)

    async def set_attempt_routing(
        self,
        attempt_id: str,
        *,
        business_id: int,
        trunk: Optional[str] = None,
        caller_id: Optional[str] = None,
        endpoint: Optional[str] = None,
        outbound_opener: Optional[str] = None,
    ) -> None:
        """Persist the effective tenant-specific route before ARI originate."""
        if not self._enabled:
            return

        safe_business_id = max(1, _as_int(business_id, 1))
        safe_opener = _as_str(outbound_opener)[:1000] or None

        def _sync():
            with self._lock:
                conn = self._get_connection()
                try:
                    cur = conn.execute(
                        """
                        UPDATE outbound_attempts
                        SET trunk=?, caller_id=?, endpoint=?, outbound_opener=?
                        WHERE id=? AND business_id=? AND ended_at_utc IS NULL
                        """,
                        (
                            _as_str(trunk).strip() or None,
                            _as_str(caller_id).strip() or None,
                            _as_str(endpoint).strip() or None,
                            safe_opener,
                            attempt_id,
                            safe_business_id,
                        ),
                    )
                    if cur.rowcount != 1:
                        raise ValueError("Attempt routing scope mismatch or attempt already finalized")
                    conn.commit()
                except Exception:
                    conn.rollback()
                    raise
                finally:
                    conn.close()

        await self._run(_sync)

    async def set_attempt_gate_result(
        self,
        attempt_id: str,
        *,
        amd_status: Optional[str] = None,
        amd_cause: Optional[str] = None,
        consent_dtmf: Optional[str] = None,
        consent_result: Optional[str] = None,
        context: Optional[str] = None,
        provider: Optional[str] = None,
        error_message: Optional[str] = None,
    ) -> None:
        """
        Persist mid-call classification data (AMD + consent) without finalizing the attempt.

        Used so the UI can display last AMD/DTMF while a call is still in progress.
        """
        if not self._enabled:
            return
        safe_error_message = sanitize_outbound_error(error_message) if error_message else None

        def _sync():
            with self._lock:
                conn = self._get_connection()
                try:
                    conn.execute(
                        """
                        UPDATE outbound_attempts
                        SET amd_status=COALESCE(?, amd_status),
                            amd_cause=COALESCE(?, amd_cause),
                            consent_dtmf=COALESCE(?, consent_dtmf),
                            consent_result=COALESCE(?, consent_result),
                            context=COALESCE(?, context),
                            provider=COALESCE(?, provider),
                            error_message=COALESCE(?, error_message)
                        WHERE id=? AND ended_at_utc IS NULL
                        """,
                        (
                            amd_status,
                            amd_cause,
                            consent_dtmf,
                            consent_result,
                            context,
                            provider,
                            safe_error_message,
                            attempt_id,
                        ),
                    )
                    conn.commit()
                finally:
                    conn.close()

        await self._run(_sync)

    async def finish_attempt(
        self,
        attempt_id: str,
        *,
        outcome: str,
        amd_status: Optional[str] = None,
        amd_cause: Optional[str] = None,
        consent_dtmf: Optional[str] = None,
        consent_result: Optional[str] = None,
        context: Optional[str] = None,
        provider: Optional[str] = None,
        call_history_call_id: Optional[str] = None,
        error_message: Optional[str] = None,
    ) -> None:
        successes = {"answered", "answered_human", "transferred", "voicemail_dropped", "machine_detected", "completed"}
        canceled = {"canceled", "consent_denied", "consent_timeout"}
        disposition = "success" if outcome in successes else ("canceled" if outcome in canceled else "terminal")
        await self.finalize_attempt(
            attempt_id,
            outcome=outcome,
            disposition=disposition,
            amd_status=amd_status,
            amd_cause=amd_cause,
            consent_dtmf=consent_dtmf,
            consent_result=consent_result,
            context=context,
            provider=provider,
            call_history_call_id=call_history_call_id,
            error_message=error_message,
        )

    async def finalize_attempt(
        self,
        attempt_id: str,
        *,
        outcome: str,
        disposition: str,
        business_id: Optional[int] = None,
        error_stage: Optional[str] = None,
        error_code: Optional[str] = None,
        error_message: Optional[str] = None,
        amd_status: Optional[str] = None,
        amd_cause: Optional[str] = None,
        consent_dtmf: Optional[str] = None,
        consent_result: Optional[str] = None,
        context: Optional[str] = None,
        provider: Optional[str] = None,
        call_id: Optional[str] = None,
        call_history_call_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Atomically finish an attempt and apply retry/success/terminal lead state."""
        if not self._enabled:
            return {}

        normalized_disposition = str(disposition or "terminal").strip().lower()
        if normalized_disposition not in {"success", "retryable", "terminal", "canceled", "unknown"}:
            raise ValueError("invalid attempt disposition")
        if error_code in {"stale_attempt_timeout", "originate_transport_error"}:
            normalized_disposition = "unknown"
        safe_message = sanitize_outbound_error(error_message) if error_message else None

        def _sync():
            now_dt = datetime.now(timezone.utc)
            now = now_dt.isoformat()
            with self._lock:
                conn = self._get_connection()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    row = conn.execute(
                        """
                        SELECT a.*, l.state AS lead_state, l.attempt_count,
                               c.max_attempts, c.retry_initial_delay_seconds,
                               c.retry_backoff_multiplier, c.retry_max_delay_seconds,
                               c.business_id AS campaign_business_id
                        FROM outbound_attempts a
                        JOIN outbound_leads l ON l.id=a.lead_id
                        JOIN outbound_campaigns c ON c.id=a.campaign_id
                        WHERE a.id=?
                        """,
                        (attempt_id,),
                    ).fetchone()
                    if not row:
                        raise KeyError("attempt not found")
                    campaign_business_id = max(1, _as_int(row["campaign_business_id"], 1))
                    if business_id is not None and max(1, _as_int(business_id, 1)) != campaign_business_id:
                        raise ValueError("Attempt business scope mismatch")
                    if row["ended_at_utc"]:
                        conn.commit()
                        return {
                            "attempt_id": attempt_id,
                            "lead_id": str(row["lead_id"]),
                            "lead_state": str(row["lead_state"]),
                            "outcome": row["outcome"],
                            "next_attempt_at_utc": None,
                            "already_finalized": True,
                        }

                    duration_seconds = None
                    try:
                        if row["started_at_utc"]:
                            started = datetime.fromisoformat(str(row["started_at_utc"]))
                            if started.tzinfo is None:
                                started = started.replace(tzinfo=timezone.utc)
                            duration_seconds = max(0, int((now_dt - started).total_seconds()))
                    except Exception:
                        duration_seconds = None
                    retryable_value = 1 if normalized_disposition == "retryable" else (
                        0 if normalized_disposition in {"terminal", "canceled", "unknown"} else None
                    )
                    cur = conn.execute(
                        """
                        UPDATE outbound_attempts
                        SET ended_at_utc=?,
                            duration_seconds=COALESCE(?, duration_seconds),
                            outcome=?,
                            amd_status=?,
                            amd_cause=?,
                            consent_dtmf=COALESCE(?, consent_dtmf),
                            consent_result=COALESCE(?, consent_result),
                            context=COALESCE(?, context),
                            provider=COALESCE(?, provider),
                            call_id=COALESCE(?, call_id),
                            call_history_call_id=COALESCE(?, call_history_call_id),
                            error_stage=?, error_code=?, retryable=?, error_message=?
                        WHERE id=? AND ended_at_utc IS NULL
                        """,
                        (
                            now,
                            duration_seconds,
                            outcome,
                            amd_status,
                            amd_cause,
                            consent_dtmf,
                            consent_result,
                            context,
                            provider,
                            call_id,
                            call_history_call_id,
                            error_stage,
                            error_code,
                            retryable_value,
                            safe_message,
                            attempt_id,
                        ),
                    )
                    if cur.rowcount != 1:
                        raise RuntimeError("Attempt finalization race")

                    next_attempt_at = None
                    attempt_count = int(row["attempt_count"] or 0)
                    max_attempts = max(1, _as_int(row["max_attempts"], 3))
                    if normalized_disposition == "success":
                        lead_state = "completed"
                    elif normalized_disposition == "unknown":
                        lead_state = "unknown"
                    elif normalized_disposition == "canceled":
                        lead_state = "canceled"
                    elif normalized_disposition == "retryable" and attempt_count < max_attempts:
                        lead_state = "pending"
                        initial = max(1, _as_int(row["retry_initial_delay_seconds"], 60))
                        try:
                            multiplier = max(1.0, float(row["retry_backoff_multiplier"] or 2.0))
                        except Exception:
                            multiplier = 2.0
                        cap = max(initial, _as_int(row["retry_max_delay_seconds"], 3600))
                        delay = min(cap, max(1, int(initial * (multiplier ** max(0, attempt_count - 1)))))
                        next_attempt_at = (now_dt + timedelta(seconds=delay)).isoformat()
                    else:
                        lead_state = "failed"

                    conn.execute(
                        """
                        UPDATE outbound_leads
                        SET state=?, last_outcome=?, leased_until_utc=NULL, lease_token=NULL,
                            next_attempt_at_utc=?, updated_at_utc=?
                        WHERE id=? AND campaign_id=? AND business_id=?
                        """,
                        (
                            lead_state,
                            outcome,
                            next_attempt_at,
                            now,
                            str(row["lead_id"]),
                            str(row["campaign_id"]),
                            campaign_business_id,
                        ),
                    )
                    conn.commit()
                    return {
                        "attempt_id": attempt_id,
                        "lead_id": str(row["lead_id"]),
                        "lead_state": lead_state,
                        "outcome": outcome,
                        "next_attempt_at_utc": next_attempt_at,
                        "already_finalized": False,
                    }
                except Exception:
                    conn.rollback()
                    raise
                finally:
                    conn.close()

        return await self._run(_sync)


_outbound_store: Optional[OutboundStore] = None


def get_outbound_store() -> OutboundStore:
    global _outbound_store
    if _outbound_store is None:
        _outbound_store = OutboundStore()
    return _outbound_store
