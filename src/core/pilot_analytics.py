"""Pilot analytics aggregation.

Turns raw call-history rows and outbound-attempt rows into the handful of
numbers a pilot manager actually reads. The raw-outcome -> display-metric
mapping lives here and nowhere else, so the API, the UI and the docs cannot
drift apart.

Both tables live in the same SQLite file (``CALL_HISTORY_DB_PATH``), which is
why incoming calls can be separated from outbound ones with a single query
instead of a cross-process join.

Everything is tenant-scoped: ``business_id`` is required, never optional, and
there is deliberately no "all businesses" mode.
"""

from __future__ import annotations

import asyncio
import os
import sqlite3
from datetime import datetime
from typing import Any, Dict, List, Optional

from src.core.outbound_errors import ERROR_STAGES, sanitize_outbound_error


# ─── Outcome vocabulary ───────────────────────────────────────────────────
# These are the values the engine actually writes. Keep them in sync with
# docs/PILOT_ANALYTICS.md; the contract tests assert both directions.

# A human picked up and a conversation happened.
ANSWERED_ATTEMPT_OUTCOMES = frozenset({"answered_human"})

# Nobody picked up. Busy counts here: from the pilot's point of view it is a
# failed reach, not a broken system.
NO_ANSWER_ATTEMPT_OUTCOMES = frozenset({"no_answer", "busy", "canceled"})

# An answering machine picked up. Reported separately: it is neither a
# conversation nor a system fault.
VOICEMAIL_ATTEMPT_OUTCOMES = frozenset({"voicemail_dropped", "machine_detected"})

# Something broke: originate, SIP, the AVA session, or the voicemail flow.
FAILED_ATTEMPT_OUTCOMES = frozenset({
    "originate_error",
    "ava_session_error",
    "stale_timeout",
    "error",
    "congestion",
    "chanunavail",
    "voicemail_error",
    "business_scope_mismatch",
})

# Connected, but the guest declined or ignored the consent prompt. Not a
# conversation and not a fault, so it stays out of the three headline numbers.
OTHER_ATTEMPT_OUTCOMES = frozenset({"consent_denied", "consent_timeout"})

# Call-history outcomes for calls that reached a real conversation.
ANSWERED_CALL_OUTCOMES = frozenset({"completed", "transferred"})
FAILED_CALL_OUTCOMES = frozenset({"error"})
OTHER_CALL_OUTCOMES = frozenset({"abandoned"})

BUCKETS = ("answered", "no_answer", "failed", "voicemail", "other")

MAX_RANGE_DAYS = 90
ERROR_STAGE_LABELS = tuple(sorted(ERROR_STAGES)) + ("other",)


def classify_attempt_outcome(outcome: Optional[str]) -> str:
    """Map a raw outbound attempt outcome onto exactly one display bucket."""
    value = str(outcome or "").strip().lower()
    if value in ANSWERED_ATTEMPT_OUTCOMES:
        return "answered"
    if value in NO_ANSWER_ATTEMPT_OUTCOMES:
        return "no_answer"
    if value in VOICEMAIL_ATTEMPT_OUTCOMES:
        return "voicemail"
    if value in FAILED_ATTEMPT_OUTCOMES:
        return "failed"
    if value in OTHER_ATTEMPT_OUTCOMES:
        return "other"
    # Unknown values are surfaced, never silently dropped: the raw breakdown
    # still carries them so a new engine outcome shows up instead of vanishing.
    return "other"


def classify_call_outcome(outcome: Optional[str]) -> str:
    """Map a raw call-history outcome onto exactly one display bucket."""
    value = str(outcome or "").strip().lower()
    if value in ANSWERED_CALL_OUTCOMES:
        return "answered"
    if value in FAILED_CALL_OUTCOMES:
        return "failed"
    if value in OTHER_CALL_OUTCOMES:
        return "other"
    return "other"


def classify_error_stage(stage: Optional[str]) -> str:
    value = str(stage or "").strip().lower()
    return value if value in ERROR_STAGES else "other"


def _empty_buckets() -> Dict[str, int]:
    return {bucket: 0 for bucket in BUCKETS}


def _default_db_path() -> str:
    return os.getenv("CALL_HISTORY_DB_PATH", "/app/data/call_history.db")


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if isinstance(value, datetime) else None


def _table_exists(cursor: sqlite3.Cursor, name: str) -> bool:
    cursor.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        (name,),
    )
    return cursor.fetchone() is not None


def empty_call_metrics() -> Dict[str, Any]:
    """Shape returned when the analytics database is absent or disabled."""
    return {
        "calls": {"incoming": 0, "outgoing_attempts": 0, "outgoing_answered": 0},
        "incoming_breakdown": _empty_buckets(),
        "outgoing_breakdown": _empty_buckets(),
        "totals": _empty_buckets(),
        "average_answered_call_duration_seconds": 0.0,
        "average_answered_incoming_duration_seconds": 0.0,
        "average_answered_outgoing_duration_seconds": 0.0,
        "total_answered_duration_seconds": 0.0,
        "raw_call_outcomes": {},
        "raw_attempt_outcomes": {},
        "errors": [],
        "error_stages": {},
    }


class PilotAnalyticsStore:
    """Read-only aggregation over call history and outbound attempts."""

    def __init__(self, db_path: Optional[str] = None):
        self._db_path = db_path or _default_db_path()

    def _connect(self) -> sqlite3.Connection:
        # Read-only work: the writers own schema creation.
        return sqlite3.connect(self._db_path, timeout=30.0, check_same_thread=False)

    async def get_call_metrics(
        self,
        *,
        business_id: int,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        error_limit: int = 10,
    ) -> Dict[str, Any]:
        scoped_business_id = max(1, int(business_id))
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None,
            lambda: self._collect_sync(
                business_id=scoped_business_id,
                start_date=start_date,
                end_date=end_date,
                error_limit=max(1, min(int(error_limit or 10), 50)),
            ),
        )

    def _collect_sync(
        self,
        *,
        business_id: int,
        start_date: Optional[datetime],
        end_date: Optional[datetime],
        error_limit: int,
    ) -> Dict[str, Any]:
        if not os.path.exists(self._db_path):
            return empty_call_metrics()

        conn = self._connect()
        try:
            cursor = conn.cursor()
            has_calls = _table_exists(cursor, "call_records")
            has_attempts = _table_exists(cursor, "outbound_attempts")
            if not has_calls and not has_attempts:
                return empty_call_metrics()

            result = empty_call_metrics()
            start_iso = _iso(start_date)
            end_iso = _iso(end_date)

            if has_calls:
                self._collect_calls(
                    cursor,
                    result,
                    business_id=business_id,
                    start_iso=start_iso,
                    end_iso=end_iso,
                    has_attempts=has_attempts,
                )
            if has_attempts:
                self._collect_attempts(
                    cursor,
                    result,
                    business_id=business_id,
                    start_iso=start_iso,
                    end_iso=end_iso,
                    error_limit=error_limit,
                )

            self._finalize(result)
            return result
        finally:
            conn.close()

    @staticmethod
    def _scope_clause(column: str, start_iso: Optional[str], end_iso: Optional[str]) -> tuple:
        clause = "business_id = ?"
        params: List[Any] = []
        if start_iso:
            clause += f" AND {column} >= ?"
            params.append(start_iso)
        if end_iso:
            clause += f" AND {column} <= ?"
            params.append(end_iso)
        return clause, params

    def _collect_calls(
        self,
        cursor: sqlite3.Cursor,
        result: Dict[str, Any],
        *,
        business_id: int,
        start_iso: Optional[str],
        end_iso: Optional[str],
        has_attempts: bool,
    ) -> None:
        clause, extra = self._scope_clause("start_time", start_iso, end_iso)
        params: List[Any] = [business_id, *extra]

        # A call record produced by an outbound attempt is not an incoming call.
        # The attempt row is the authoritative outbound record, so exclude it
        # here instead of double counting the same conversation.
        if has_attempts:
            clause += (
                " AND call_id NOT IN ("
                " SELECT call_history_call_id FROM outbound_attempts"
                " WHERE call_history_call_id IS NOT NULL AND call_history_call_id != ''"
                " UNION"
                " SELECT call_id FROM outbound_attempts"
                " WHERE call_id IS NOT NULL AND call_id != ''"
                ")"
            )

        cursor.execute(
            f"""
            SELECT outcome, COUNT(*), SUM(duration_seconds)
            FROM call_records
            WHERE {clause}
            GROUP BY outcome
            """,
            params,
        )

        incoming = 0
        answered_duration = 0.0
        answered_count = 0
        for outcome, count, total_duration in cursor.fetchall():
            count = int(count or 0)
            incoming += count
            raw_key = str(outcome or "unknown")
            result["raw_call_outcomes"][raw_key] = result["raw_call_outcomes"].get(raw_key, 0) + count
            bucket = classify_call_outcome(outcome)
            result["incoming_breakdown"][bucket] += count
            if bucket == "answered":
                answered_duration += float(total_duration or 0.0)

        # Average uses only connected conversations with a real duration, so a
        # zero-duration technical failure cannot drag the number down.
        cursor.execute(
            f"""
            SELECT COUNT(*), AVG(duration_seconds), SUM(duration_seconds)
            FROM call_records
            WHERE {clause}
              AND duration_seconds > 0
              AND LOWER(COALESCE(outcome, '')) IN ({','.join('?' * len(ANSWERED_CALL_OUTCOMES))})
            """,
            [*params, *sorted(ANSWERED_CALL_OUTCOMES)],
        )
        row = cursor.fetchone() or (0, 0.0, 0.0)
        answered_count = int(row[0] or 0)

        result["calls"]["incoming"] = incoming
        result["_incoming_answered_count"] = answered_count
        result["_incoming_answered_duration"] = float(row[2] or 0.0)
        result["average_answered_incoming_duration_seconds"] = round(float(row[1] or 0.0), 2)

    def _collect_attempts(
        self,
        cursor: sqlite3.Cursor,
        result: Dict[str, Any],
        *,
        business_id: int,
        start_iso: Optional[str],
        end_iso: Optional[str],
        error_limit: int,
    ) -> None:
        clause, extra = self._scope_clause("started_at_utc", start_iso, end_iso)
        params: List[Any] = [business_id, *extra]

        cursor.execute(
            f"""
            SELECT outcome, COUNT(*)
            FROM outbound_attempts
            WHERE {clause}
            GROUP BY outcome
            """,
            params,
        )

        attempts = 0
        for outcome, count in cursor.fetchall():
            count = int(count or 0)
            attempts += count
            raw_key = str(outcome or "unknown")
            result["raw_attempt_outcomes"][raw_key] = result["raw_attempt_outcomes"].get(raw_key, 0) + count
            result["outgoing_breakdown"][classify_attempt_outcome(outcome)] += count

        result["calls"]["outgoing_attempts"] = attempts
        result["calls"]["outgoing_answered"] = result["outgoing_breakdown"]["answered"]

        answered_placeholders = ",".join("?" * len(ANSWERED_ATTEMPT_OUTCOMES))
        cursor.execute(
            f"""
            SELECT COUNT(*), AVG(duration_seconds), SUM(duration_seconds)
            FROM outbound_attempts
            WHERE {clause}
              AND duration_seconds > 0
              AND LOWER(COALESCE(outcome, '')) IN ({answered_placeholders})
            """,
            [*params, *sorted(ANSWERED_ATTEMPT_OUTCOMES)],
        )
        row = cursor.fetchone() or (0, 0.0, 0.0)
        result["_outgoing_answered_count"] = int(row[0] or 0)
        result["_outgoing_answered_duration"] = float(row[2] or 0.0)
        result["average_answered_outgoing_duration_seconds"] = round(float(row[1] or 0.0), 2)

        self._collect_errors(
            cursor,
            result,
            clause=clause,
            params=params,
            error_limit=error_limit,
        )

    def _collect_errors(
        self,
        cursor: sqlite3.Cursor,
        result: Dict[str, Any],
        *,
        clause: str,
        params: List[Any],
        error_limit: int,
    ) -> None:
        cursor.execute(
            f"""
            SELECT
                error_stage,
                error_code,
                provider,
                COUNT(*) AS total,
                MAX(started_at_utc) AS last_seen,
                MAX(error_message) AS sample_message
            FROM outbound_attempts
            WHERE {clause}
              AND error_code IS NOT NULL
              AND error_code != ''
            GROUP BY error_stage, error_code, provider
            ORDER BY total DESC, last_seen DESC
            LIMIT ?
            """,
            [*params, error_limit],
        )

        errors: List[Dict[str, Any]] = []
        for stage, code, provider, total, last_seen, sample_message in cursor.fetchall():
            normalized_stage = classify_error_stage(stage)
            errors.append({
                "error_stage": normalized_stage,
                "error_code": str(code or "unknown"),
                "provider": str(provider or "") or None,
                "count": int(total or 0),
                "last_seen_at": last_seen,
                # Already sanitised on write; sanitised again and truncated here
                # so a stored payload can never leak through the API.
                "message_preview": sanitize_outbound_error(sample_message, max_length=160) or None,
            })
        result["errors"] = errors

        cursor.execute(
            f"""
            SELECT error_stage, COUNT(*)
            FROM outbound_attempts
            WHERE {clause}
              AND error_code IS NOT NULL
              AND error_code != ''
            GROUP BY error_stage
            """,
            params,
        )
        stages: Dict[str, int] = {}
        for stage, count in cursor.fetchall():
            key = classify_error_stage(stage)
            stages[key] = stages.get(key, 0) + int(count or 0)
        result["error_stages"] = stages

    @staticmethod
    def _finalize(result: Dict[str, Any]) -> None:
        incoming_count = int(result.pop("_incoming_answered_count", 0) or 0)
        incoming_duration = float(result.pop("_incoming_answered_duration", 0.0) or 0.0)
        outgoing_count = int(result.pop("_outgoing_answered_count", 0) or 0)
        outgoing_duration = float(result.pop("_outgoing_answered_duration", 0.0) or 0.0)

        total_count = incoming_count + outgoing_count
        total_duration = incoming_duration + outgoing_duration
        result["total_answered_duration_seconds"] = round(total_duration, 2)
        result["average_answered_call_duration_seconds"] = (
            round(total_duration / total_count, 2) if total_count else 0.0
        )

        for bucket in BUCKETS:
            result["totals"][bucket] = (
                result["incoming_breakdown"][bucket] + result["outgoing_breakdown"][bucket]
            )


_store: Optional[PilotAnalyticsStore] = None


def get_pilot_analytics_store() -> PilotAnalyticsStore:
    global _store
    if _store is None:
        _store = PilotAnalyticsStore()
    return _store
