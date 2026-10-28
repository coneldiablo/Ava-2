"""Contract tests for pilot analytics (task 13).

Two things are pinned here: the raw-outcome -> display-metric mapping, and the
promise that a missing source is reported as missing rather than as zero.
"""

import asyncio
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from src.core.pilot_analytics import (
    ANSWERED_ATTEMPT_OUTCOMES,
    BUCKETS,
    MAX_RANGE_DAYS,
    PilotAnalyticsStore,
    classify_attempt_outcome,
    classify_call_outcome,
    classify_error_stage,
    empty_call_metrics,
)


ROOT = Path(__file__).resolve().parents[2]
NOW = datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)


# ─── Fixtures ─────────────────────────────────────────────────────────────


@pytest.fixture
def analytics_db(tmp_path, monkeypatch):
    """A real database built with the production schema, not a mock."""
    db_path = str(tmp_path / "call_history.db")
    monkeypatch.setenv("CALL_HISTORY_DB_PATH", db_path)
    monkeypatch.setenv("CALL_HISTORY_ENABLED", "true")

    from src.core.call_history import CallHistoryStore
    from src.core.outbound_store import OutboundStore

    CallHistoryStore(db_path=db_path)
    OutboundStore(db_path=db_path)
    return db_path


def add_call(db_path, *, call_id, business_id, outcome, duration, minutes_ago=10):
    conn = sqlite3.connect(db_path)
    start = (NOW - timedelta(minutes=minutes_ago)).isoformat()
    conn.execute(
        """
        INSERT INTO call_records (id, call_id, business_id, start_time, end_time,
                                  duration_seconds, provider_name, outcome, tool_calls)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]')
        """,
        (call_id, call_id, business_id, start, NOW.isoformat(), duration, "openai_realtime", outcome),
    )
    conn.commit()
    conn.close()


def add_attempt(
    db_path,
    *,
    attempt_id,
    business_id,
    outcome,
    duration=0.0,
    linked_call_id=None,
    error_stage=None,
    error_code=None,
    error_message=None,
    minutes_ago=10,
):
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO outbound_attempts (id, campaign_id, lead_id, business_id, started_at_utc,
                                       ended_at_utc, duration_seconds, outcome, provider,
                                       call_history_call_id, error_stage, error_code, error_message)
        VALUES (?, 'camp-1', 'lead-1', ?, ?, ?, ?, ?, 'asterisk', ?, ?, ?, ?)
        """,
        (
            attempt_id,
            business_id,
            (NOW - timedelta(minutes=minutes_ago)).isoformat(),
            NOW.isoformat(),
            duration,
            outcome,
            linked_call_id,
            error_stage,
            error_code,
            error_message,
        ),
    )
    conn.commit()
    conn.close()


def collect(db_path, business_id=2, *, days=1):
    store = PilotAnalyticsStore(db_path=db_path)
    return asyncio.run(
        store.get_call_metrics(
            business_id=business_id,
            start_date=NOW - timedelta(days=days),
            end_date=NOW + timedelta(minutes=1),
        )
    )


# ─── Outcome mapping ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "outcome,expected",
    [
        ("answered_human", "answered"),
        ("no_answer", "no_answer"),
        ("busy", "no_answer"),
        ("canceled", "no_answer"),
        ("voicemail_dropped", "voicemail"),
        ("machine_detected", "voicemail"),
        ("originate_error", "failed"),
        ("ava_session_error", "failed"),
        ("stale_timeout", "failed"),
        ("congestion", "failed"),
        ("chanunavail", "failed"),
        ("voicemail_error", "failed"),
        ("business_scope_mismatch", "failed"),
        ("consent_denied", "other"),
        ("consent_timeout", "other"),
        ("a_brand_new_engine_outcome", "other"),
        (None, "other"),
        ("", "other"),
    ],
)
def test_attempt_outcome_mapping(outcome, expected):
    assert classify_attempt_outcome(outcome) == expected


@pytest.mark.parametrize(
    "outcome,expected",
    [
        ("completed", "answered"),
        ("transferred", "answered"),
        ("error", "failed"),
        ("abandoned", "other"),
        ("unheard_of", "other"),
    ],
)
def test_call_outcome_mapping(outcome, expected):
    assert classify_call_outcome(outcome) == expected


def test_voicemail_is_never_counted_as_answered():
    for outcome in ("voicemail_dropped", "machine_detected"):
        assert classify_attempt_outcome(outcome) != "answered"


def test_error_stage_normalization():
    assert classify_error_stage("originate") == "originate"
    assert classify_error_stage("provider_sip") == "provider_sip"
    assert classify_error_stage("ava_session") == "ava_session"
    assert classify_error_stage("voicemail") == "voicemail"
    assert classify_error_stage("something_else") == "other"
    assert classify_error_stage(None) == "other"


def test_every_known_outcome_lands_in_exactly_one_bucket():
    from src.core import pilot_analytics as pa

    groups = [
        pa.ANSWERED_ATTEMPT_OUTCOMES,
        pa.NO_ANSWER_ATTEMPT_OUTCOMES,
        pa.VOICEMAIL_ATTEMPT_OUTCOMES,
        pa.FAILED_ATTEMPT_OUTCOMES,
        pa.OTHER_ATTEMPT_OUTCOMES,
    ]
    seen = set()
    for group in groups:
        overlap = seen & set(group)
        assert not overlap, f"outcome classified twice: {overlap}"
        seen |= set(group)


# ─── Aggregation ──────────────────────────────────────────────────────────


def test_empty_database_reports_zeros_not_an_error(analytics_db):
    metrics = collect(analytics_db)

    assert metrics["calls"] == {"incoming": 0, "outgoing_attempts": 0, "outgoing_answered": 0}
    assert metrics["average_answered_call_duration_seconds"] == 0.0
    assert metrics["errors"] == []


def test_missing_database_file_returns_the_empty_shape(tmp_path):
    store = PilotAnalyticsStore(db_path=str(tmp_path / "does-not-exist.db"))
    metrics = asyncio.run(store.get_call_metrics(business_id=1))

    assert metrics == empty_call_metrics()
    assert set(metrics["totals"]) == set(BUCKETS)


def test_incoming_excludes_calls_produced_by_an_outbound_attempt(analytics_db):
    add_call(analytics_db, call_id="in-1", business_id=2, outcome="completed", duration=120)
    add_call(analytics_db, call_id="in-2", business_id=2, outcome="completed", duration=60)
    add_call(analytics_db, call_id="out-1", business_id=2, outcome="completed", duration=300)
    add_attempt(analytics_db, attempt_id="a1", business_id=2, outcome="answered_human",
                duration=300, linked_call_id="out-1")

    metrics = collect(analytics_db)

    assert metrics["calls"]["incoming"] == 2, "the outbound conversation is not an incoming call"
    assert metrics["calls"]["outgoing_attempts"] == 1
    assert metrics["calls"]["outgoing_answered"] == 1


def test_another_business_is_invisible(analytics_db):
    add_call(analytics_db, call_id="mine", business_id=2, outcome="completed", duration=100)
    add_call(analytics_db, call_id="theirs", business_id=3, outcome="completed", duration=100)
    add_attempt(analytics_db, attempt_id="a-mine", business_id=2, outcome="answered_human", duration=50)
    add_attempt(analytics_db, attempt_id="a-theirs", business_id=3, outcome="answered_human", duration=50)

    mine = collect(analytics_db, business_id=2)
    theirs = collect(analytics_db, business_id=3)

    assert mine["calls"]["incoming"] == 1
    assert mine["calls"]["outgoing_attempts"] == 1
    assert theirs["calls"]["incoming"] == 1
    assert theirs["calls"]["outgoing_attempts"] == 1
    # Neither view is the sum of both.
    assert mine["calls"]["incoming"] + theirs["calls"]["incoming"] == 2


def test_outcome_buckets_are_populated_from_real_rows(analytics_db):
    add_attempt(analytics_db, attempt_id="a1", business_id=2, outcome="answered_human", duration=90)
    add_attempt(analytics_db, attempt_id="a2", business_id=2, outcome="no_answer")
    add_attempt(analytics_db, attempt_id="a3", business_id=2, outcome="busy")
    add_attempt(analytics_db, attempt_id="a4", business_id=2, outcome="originate_error",
                error_stage="originate", error_code="ari_http_500")
    add_attempt(analytics_db, attempt_id="a5", business_id=2, outcome="voicemail_dropped", duration=12)
    add_attempt(analytics_db, attempt_id="a6", business_id=2, outcome="consent_denied", duration=4)

    metrics = collect(analytics_db)
    breakdown = metrics["outgoing_breakdown"]

    assert breakdown["answered"] == 1
    assert breakdown["no_answer"] == 2
    assert breakdown["failed"] == 1
    assert breakdown["voicemail"] == 1
    assert breakdown["other"] == 1
    # No attempt is counted twice.
    assert sum(breakdown.values()) == metrics["calls"]["outgoing_attempts"] == 6


def test_raw_outcomes_are_returned_verbatim(analytics_db):
    add_attempt(analytics_db, attempt_id="a1", business_id=2, outcome="brand_new_outcome")
    add_call(analytics_db, call_id="c1", business_id=2, outcome="completed", duration=10)

    metrics = collect(analytics_db)

    assert metrics["raw_attempt_outcomes"]["brand_new_outcome"] == 1
    assert metrics["raw_call_outcomes"]["completed"] == 1
    # Unknown values are visible in raw and bucketed into 'other'.
    assert metrics["outgoing_breakdown"]["other"] == 1


def test_average_duration_ignores_unanswered_and_zero_duration(analytics_db):
    add_call(analytics_db, call_id="in-1", business_id=2, outcome="completed", duration=120)
    add_call(analytics_db, call_id="in-2", business_id=2, outcome="completed", duration=60)
    add_call(analytics_db, call_id="in-3", business_id=2, outcome="error", duration=0)
    add_call(analytics_db, call_id="in-4", business_id=2, outcome="abandoned", duration=0)
    add_attempt(analytics_db, attempt_id="a1", business_id=2, outcome="answered_human", duration=300)
    add_attempt(analytics_db, attempt_id="a2", business_id=2, outcome="no_answer", duration=0)
    add_attempt(analytics_db, attempt_id="a3", business_id=2, outcome="originate_error", duration=0)

    metrics = collect(analytics_db)

    assert metrics["average_answered_incoming_duration_seconds"] == 90.0
    assert metrics["average_answered_outgoing_duration_seconds"] == 300.0
    assert metrics["average_answered_call_duration_seconds"] == 160.0
    assert metrics["total_answered_duration_seconds"] == 480.0


def test_answered_attempt_with_zero_duration_is_not_averaged(analytics_db):
    add_attempt(analytics_db, attempt_id="a1", business_id=2, outcome="answered_human", duration=0)

    metrics = collect(analytics_db)

    assert metrics["outgoing_breakdown"]["answered"] == 1
    assert metrics["average_answered_call_duration_seconds"] == 0.0


def test_period_filter_excludes_rows_outside_the_window(analytics_db):
    add_call(analytics_db, call_id="recent", business_id=2, outcome="completed", duration=30, minutes_ago=30)
    add_call(analytics_db, call_id="old", business_id=2, outcome="completed", duration=30,
             minutes_ago=60 * 24 * 10)

    recent = collect(analytics_db, days=1)
    wide = collect(analytics_db, days=30)

    assert recent["calls"]["incoming"] == 1
    assert wide["calls"]["incoming"] == 2


# ─── Provider / SIP errors ────────────────────────────────────────────────


def test_errors_are_aggregated_by_stage_and_code(analytics_db):
    add_attempt(analytics_db, attempt_id="a1", business_id=2, outcome="originate_error",
                error_stage="originate", error_code="ari_http_500", error_message="boom")
    add_attempt(analytics_db, attempt_id="a2", business_id=2, outcome="originate_error",
                error_stage="originate", error_code="ari_http_500", error_message="boom")
    add_attempt(analytics_db, attempt_id="a3", business_id=2, outcome="congestion",
                error_stage="provider_sip", error_code="sip_congestion", error_message="busy trunk")

    metrics = collect(analytics_db)

    top = metrics["errors"][0]
    assert top["error_code"] == "ari_http_500"
    assert top["count"] == 2
    assert top["error_stage"] == "originate"
    assert top["provider"] == "asterisk"
    assert top["last_seen_at"]
    assert metrics["error_stages"] == {"originate": 2, "provider_sip": 1}


def test_error_previews_are_sanitised(analytics_db):
    add_attempt(
        analytics_db,
        attempt_id="a1",
        business_id=2,
        outcome="originate_error",
        error_stage="originate",
        error_code="ari_http_401",
        error_message="failed with Authorization: Bearer supersecrettoken12345",
    )

    metrics = collect(analytics_db)
    preview = metrics["errors"][0]["message_preview"]

    assert "supersecrettoken12345" not in preview
    assert "REDACTED" in preview


def test_errors_of_another_business_are_not_aggregated(analytics_db):
    add_attempt(analytics_db, attempt_id="a1", business_id=3, outcome="originate_error",
                error_stage="originate", error_code="ari_http_500", error_message="theirs")

    metrics = collect(analytics_db, business_id=2)

    assert metrics["errors"] == []
    assert metrics["error_stages"] == {}


def test_attempts_without_an_error_code_are_not_listed_as_errors(analytics_db):
    add_attempt(analytics_db, attempt_id="a1", business_id=2, outcome="no_answer")

    metrics = collect(analytics_db)

    assert metrics["errors"] == []


# ─── Admin API: period handling and source health ─────────────────────────


@pytest.fixture
def analytics_api():
    backend = ROOT / "admin_ui" / "backend"
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    from api import pilot_analytics as module

    return module


@pytest.mark.parametrize("preset,expected_days", [("24h", 1.0), ("7d", 7.0), ("30d", 30.0)])
def test_period_presets_normalize(analytics_api, preset, expected_days):
    period = analytics_api.resolve_period(preset, None, None, now=NOW)

    assert period.preset == preset
    assert period.days == expected_days
    assert period.end_at == NOW.isoformat()


def test_period_defaults_to_24h(analytics_api):
    assert analytics_api.resolve_period(None, None, None, now=NOW).preset == "24h"


def test_custom_range_wins_over_a_preset(analytics_api):
    period = analytics_api.resolve_period("30d", "2026-06-01", "2026-06-10", now=NOW)

    assert period.preset is None
    assert period.start_at.startswith("2026-06-01")
    # A bare end date covers the whole day, not midnight.
    assert period.end_at.startswith("2026-06-10T23:59")


def test_inverted_range_is_rejected(analytics_api):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as excinfo:
        analytics_api.resolve_period(None, "2026-06-10", "2026-06-01", now=NOW)
    assert excinfo.value.status_code == 400


def test_oversized_range_is_rejected(analytics_api):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as excinfo:
        analytics_api.resolve_period(None, "2026-01-01", "2026-12-31", now=NOW)
    assert excinfo.value.status_code == 400
    assert str(MAX_RANGE_DAYS) in str(excinfo.value.detail)


def test_half_open_custom_range_is_rejected(analytics_api):
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        analytics_api.resolve_period(None, "2026-06-01", None, now=NOW)


def test_unknown_preset_is_rejected(analytics_api):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as excinfo:
        analytics_api.resolve_period("all_time", None, None, now=NOW)
    assert excinfo.value.status_code == 400


def test_business_id_is_required_and_positive(analytics_api):
    import inspect

    from pydantic_core import PydanticUndefined

    signature = inspect.signature(analytics_api.get_pilot_analytics)
    business_id = signature.parameters["business_id"].default

    # No default at all: a caller cannot omit the tenant scope.
    assert business_id.default is PydanticUndefined
    constraints = {type(item).__name__: item for item in getattr(business_id, "metadata", [])}
    assert constraints["Ge"].ge == 1, "business_id must be a positive tenant id"

    # Every other filter is optional, so scope is the only mandatory input.
    for name in ("period", "start_date", "end_date"):
        assert signature.parameters[name].default.default is None


def test_crm_request_is_scoped_to_the_business(analytics_api, monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 200

        @staticmethod
        def json():
            return {
                "success": True,
                "timezone": "Europe/Moscow",
                "manager_tasks": {"created": 3, "by_status": {"new": 3}},
                "followups": {"sent": 1, "created": 2, "by_status": {"sent": 1, "draft": 1}},
            }

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url, params=None, headers=None):
            captured["url"] = url
            captured["params"] = params
            return FakeResponse()

    monkeypatch.setattr(analytics_api, "_service_token", lambda: "token")
    monkeypatch.setattr(analytics_api.httpx, "AsyncClient", FakeClient)

    period = analytics_api.resolve_period("24h", None, None, now=NOW)
    payload, status = asyncio.run(analytics_api._fetch_crm_metrics(7, period))

    assert status == "ok"
    assert captured["params"]["instanceId"] == 7
    assert captured["params"]["start_at"] == period.start_at
    assert payload["manager_tasks"]["created"] == 3


def test_unreachable_crm_is_reported_not_zeroed(analytics_api, monkeypatch):
    import httpx

    class FailingClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, *args, **kwargs):
            raise httpx.ConnectError("crm down")

    monkeypatch.setattr(analytics_api, "_service_token", lambda: "token")
    monkeypatch.setattr(analytics_api.httpx, "AsyncClient", FailingClient)

    period = analytics_api.resolve_period("24h", None, None, now=NOW)
    payload, status = asyncio.run(analytics_api._fetch_crm_metrics(7, period))

    assert status == "unavailable"
    assert payload is None, "a missing source must not become a zero"


def test_missing_crm_token_is_reported_as_not_configured(analytics_api, monkeypatch):
    monkeypatch.setattr(analytics_api, "_service_token", lambda: "")

    period = analytics_api.resolve_period("24h", None, None, now=NOW)
    payload, status = asyncio.run(analytics_api._fetch_crm_metrics(7, period))

    assert status == "not_configured"
    assert payload is None


def test_response_model_omits_crm_blocks_when_unavailable(analytics_api):
    period = analytics_api.resolve_period("24h", None, None, now=NOW)
    response = analytics_api.PilotAnalyticsResponse(
        business_id=2,
        generated_at=NOW.isoformat(),
        period=period,
        partial=True,
        sources={"call_history": "ok", "outbound": "ok", "whatsapp_crm": "unavailable"},
    )

    # None, not 0: the UI must be able to tell "unknown" from "none happened".
    assert response.manager_tasks is None
    assert response.followups is None
    assert response.partial is True


def test_response_model_rejects_unknown_fields(analytics_api):
    from pydantic import ValidationError

    period = analytics_api.resolve_period("24h", None, None, now=NOW)
    with pytest.raises(ValidationError):
        analytics_api.PilotAnalyticsResponse(
            business_id=2,
            generated_at=NOW.isoformat(),
            period=period,
            caller_number="79990000001",
        )


def test_answered_vocabulary_is_shared_between_module_and_docs():
    doc = (ROOT / "docs" / "PILOT_ANALYTICS.md").read_text(encoding="utf-8")

    for outcome in ANSWERED_ATTEMPT_OUTCOMES:
        assert outcome in doc, f"{outcome} is not documented"
