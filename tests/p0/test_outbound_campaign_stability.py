import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from src.core.outbound_errors import originate_failure, sanitize_outbound_error, sip_failure, terminal_failure
from src.core.outbound_store import OutboundStore
from src.engine import Engine


async def _campaign_with_leads(tmp_path, monkeypatch, *, max_attempts=3, business_id=1, count=1):
    monkeypatch.setenv("CALL_HISTORY_ENABLED", "true")
    store = OutboundStore(db_path=str(tmp_path / "outbound.db"))
    campaign = await store.create_campaign(
        {
            "name": "Stability",
            "business_id": business_id,
            "timezone": "UTC",
            "default_context": "hotel",
            "callerid": "+74950000001",
            "max_attempts": max_attempts,
            "retry_initial_delay_seconds": 60,
            "retry_backoff_multiplier": 2,
            "retry_max_delay_seconds": 3600,
            "voicemail_drop_enabled": False,
        }
    )
    csv_rows = ["phone_number,name"] + [f"+7999000000{i},Lead {i}" for i in range(1, count + 1)]
    await store.import_leads_csv(campaign["id"], ("\n".join(csv_rows) + "\n").encode())
    await store.set_campaign_status(campaign["id"], "running")
    return store, campaign


@pytest.mark.asyncio
@pytest.mark.p0
async def test_due_retry_leases_but_future_backoff_does_not(tmp_path, monkeypatch):
    store, campaign = await _campaign_with_leads(tmp_path, monkeypatch)
    lead = (await store.lease_pending_leads(campaign["id"], limit=1, business_id=1))[0]
    attempt_id = await store.start_attempt(
        campaign["id"], lead["id"], lease_token=lead["lease_token"], business_id=1
    )
    result = await store.finalize_attempt(
        attempt_id,
        outcome="originate_error",
        disposition="retryable",
        business_id=1,
        error_stage="originate",
        error_code="ari_http_500",
        error_message="temporary",
    )
    assert result["lead_state"] == "pending"
    assert result["next_attempt_at_utc"]
    assert await store.lease_pending_leads(campaign["id"], limit=1, business_id=1) == []

    with sqlite3.connect(store._db_path) as conn:
        conn.execute(
            "UPDATE outbound_leads SET next_attempt_at_utc=? WHERE id=?",
            ((datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(), lead["id"]),
        )
    due = await store.lease_pending_leads(campaign["id"], limit=1, business_id=1)
    assert [item["id"] for item in due] == [lead["id"]]


@pytest.mark.asyncio
@pytest.mark.p0
async def test_parallel_workers_cannot_start_same_lead(tmp_path, monkeypatch):
    store_one, campaign = await _campaign_with_leads(tmp_path, monkeypatch)
    store_two = OutboundStore(db_path=store_one._db_path)
    lead = (await store_one.lease_pending_leads(campaign["id"], limit=1, business_id=1))[0]

    results = await asyncio.gather(
        store_one.start_attempt(campaign["id"], lead["id"], lease_token=lead["lease_token"], business_id=1),
        store_two.start_attempt(campaign["id"], lead["id"], lease_token=lead["lease_token"], business_id=1),
        return_exceptions=True,
    )
    assert sum(isinstance(item, str) for item in results) == 1
    assert sum(isinstance(item, ValueError) for item in results) == 1
    attempts = await store_one.list_attempts(campaign["id"])
    assert len([item for item in attempts["attempts"] if item["ended_at_utc"] is None]) == 1


@pytest.mark.asyncio
@pytest.mark.p0
async def test_stale_dialing_is_fenced_unknown_and_fresh_dialing_is_not_recovered(tmp_path, monkeypatch):
    store, campaign = await _campaign_with_leads(tmp_path, monkeypatch, count=2)
    leased = await store.lease_pending_leads(campaign["id"], limit=2, business_id=1)
    stale_id = await store.start_attempt(
        campaign["id"], leased[0]["id"], lease_token=leased[0]["lease_token"], business_id=1
    )
    fresh_id = await store.start_attempt(
        campaign["id"], leased[1]["id"], lease_token=leased[1]["lease_token"], business_id=1
    )
    with sqlite3.connect(store._db_path) as conn:
        conn.execute(
            "UPDATE outbound_attempts SET started_at_utc=? WHERE id=?",
            ((datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat(), stale_id),
        )

    stale = await store.list_stale_attempts(stale_seconds=120)
    assert [row["id"] for row in stale] == [stale_id]
    recovered = await store.cleanup_stale_attempts_and_leads(stale_seconds=120)
    assert recovered["attempts_closed"] == 1
    attempts = {row["id"]: row for row in (await store.list_attempts(campaign["id"]))["attempts"]}
    assert attempts[stale_id]["retryable"] == 0
    assert attempts[fresh_id]["ended_at_utc"] is None
    leads = {row["id"]: row for row in (await store.list_leads(campaign["id"]))["leads"]}
    assert leads[leased[0]["id"]]["state"] == "unknown"
    assert not await store.recycle_lead(leased[0]["id"], mode="reset", business_id=1)
    assert not await store.recycle_lead(leased[0]["id"], mode="redial", business_id=1)


@pytest.mark.asyncio
@pytest.mark.p0
async def test_error_diagnostics_retry_exhaustion_and_secret_redaction(tmp_path, monkeypatch):
    monkeypatch.setenv("PROVIDER_SECRET", "super-secret-value")
    store, campaign = await _campaign_with_leads(tmp_path, monkeypatch, max_attempts=2)
    lead = (await store.lease_pending_leads(campaign["id"], limit=1, business_id=1))[0]
    first = await store.start_attempt(
        campaign["id"], lead["id"], lease_token=lead["lease_token"], business_id=1
    )
    failure = originate_failure(500, "Bearer token123 password=hunter2 secret=super-secret-value")
    first_result = await store.finalize_attempt(
        first,
        outcome="originate_error",
        disposition="retryable",
        business_id=1,
        error_stage=failure.stage,
        error_code=failure.code,
        error_message=failure.message,
    )
    assert first_result["lead_state"] == "pending"

    with sqlite3.connect(store._db_path) as conn:
        conn.execute("UPDATE outbound_leads SET next_attempt_at_utc=NULL WHERE id=?", (lead["id"],))
    retry_lead = (await store.lease_pending_leads(campaign["id"], limit=1, business_id=1))[0]
    second = await store.start_attempt(
        campaign["id"], retry_lead["id"], lease_token=retry_lead["lease_token"], business_id=1
    )
    second_result = await store.finalize_attempt(
        second,
        outcome="no_answer",
        disposition="retryable",
        business_id=1,
        error_stage="provider_sip",
        error_code="sip_cause_19_no_answer",
        error_message="no answer",
    )
    assert second_result["lead_state"] == "failed"
    lead_api = (await store.list_leads(campaign["id"]))["leads"][0]
    attempts = (await store.list_attempts(campaign["id"]))["attempts"]
    first_attempt = next(row for row in attempts if row["id"] == first)
    assert lead_api["last_error_stage"] == "provider_sip"
    assert "token123" not in first_attempt["error_message"]
    assert "hunter2" not in first_attempt["error_message"]
    assert "super-secret-value" not in first_attempt["error_message"]


@pytest.mark.asyncio
@pytest.mark.p0
async def test_success_and_post_answer_failures_are_terminal(tmp_path, monkeypatch):
    store, campaign = await _campaign_with_leads(tmp_path, monkeypatch, count=2)
    leads = await store.lease_pending_leads(campaign["id"], limit=2, business_id=1)
    success_id = await store.start_attempt(
        campaign["id"], leads[0]["id"], lease_token=leads[0]["lease_token"], business_id=1
    )
    ava_id = await store.start_attempt(
        campaign["id"], leads[1]["id"], lease_token=leads[1]["lease_token"], business_id=1
    )
    assert (await store.finalize_attempt(success_id, outcome="answered_human", disposition="success"))["lead_state"] == "completed"
    ava_failure = terminal_failure("ava_session", "provider_session_start_failed", "AVA unavailable")
    assert (
        await store.finalize_attempt(
            ava_id,
            outcome="ava_session_error",
            disposition="terminal",
            error_stage=ava_failure.stage,
            error_code=ava_failure.code,
            error_message=ava_failure.message,
        )
    )["lead_state"] == "failed"
    attempts = {row["id"]: row for row in (await store.list_attempts(campaign["id"]))["attempts"]}
    assert attempts[ava_id]["error_stage"] == "ava_session"
    assert attempts[ava_id]["error_code"] == "provider_session_start_failed"
    assert await store.lease_pending_leads(campaign["id"], limit=10, business_id=1) == []


@pytest.mark.asyncio
@pytest.mark.p0
async def test_voicemail_error_is_visible_and_terminal(tmp_path, monkeypatch):
    store, campaign = await _campaign_with_leads(tmp_path, monkeypatch)
    lead = (await store.lease_pending_leads(campaign["id"], limit=1, business_id=1))[0]
    attempt_id = await store.start_attempt(
        campaign["id"], lead["id"], lease_token=lead["lease_token"], business_id=1
    )
    failure = terminal_failure("voicemail", "voicemail_playback_failed", "media unavailable")
    result = await store.finalize_attempt(
        attempt_id,
        outcome="voicemail_error",
        disposition="terminal",
        error_stage=failure.stage,
        error_code=failure.code,
        error_message=failure.message,
    )
    attempt = (await store.list_attempts(campaign["id"]))["attempts"][0]
    assert result["lead_state"] == "failed"
    assert attempt["error_stage"] == "voicemail"
    assert attempt["retryable"] == 0


@pytest.mark.asyncio
@pytest.mark.p0
async def test_retry_backoff_is_exponential(tmp_path, monkeypatch):
    store, campaign = await _campaign_with_leads(tmp_path, monkeypatch, max_attempts=3)
    lead = (await store.lease_pending_leads(campaign["id"], limit=1, business_id=1))[0]
    first = await store.start_attempt(
        campaign["id"], lead["id"], lease_token=lead["lease_token"], business_id=1
    )
    before_first = datetime.now(timezone.utc)
    first_result = await store.finalize_attempt(first, outcome="busy", disposition="retryable")
    first_delay = (datetime.fromisoformat(first_result["next_attempt_at_utc"]) - before_first).total_seconds()
    assert 59 <= first_delay <= 61

    with sqlite3.connect(store._db_path) as conn:
        conn.execute("UPDATE outbound_leads SET next_attempt_at_utc=NULL WHERE id=?", (lead["id"],))
    retry = (await store.lease_pending_leads(campaign["id"], limit=1, business_id=1))[0]
    second = await store.start_attempt(
        campaign["id"], retry["id"], lease_token=retry["lease_token"], business_id=1
    )
    before_second = datetime.now(timezone.utc)
    second_result = await store.finalize_attempt(second, outcome="no_answer", disposition="retryable")
    second_delay = (datetime.fromisoformat(second_result["next_attempt_at_utc"]) - before_second).total_seconds()
    assert 119 <= second_delay <= 121


@pytest.mark.asyncio
@pytest.mark.p0
async def test_terminal_sip_error_is_not_retried(tmp_path, monkeypatch):
    store, campaign = await _campaign_with_leads(tmp_path, monkeypatch)
    lead = (await store.lease_pending_leads(campaign["id"], limit=1, business_id=1))[0]
    attempt_id = await store.start_attempt(
        campaign["id"], lead["id"], lease_token=lead["lease_token"], business_id=1
    )
    failure = sip_failure(1, "Unallocated number")
    result = await store.finalize_attempt(
        attempt_id,
        outcome="chanunavail",
        disposition="retryable" if failure.retryable else "terminal",
        error_stage=failure.stage,
        error_code=failure.code,
        error_message=failure.message,
    )
    assert result["lead_state"] == "failed"
    assert result["next_attempt_at_utc"] is None


@pytest.mark.asyncio
@pytest.mark.p0
async def test_test_campaign_contains_only_selected_number_and_preserves_scope(tmp_path, monkeypatch):
    store, campaign = await _campaign_with_leads(tmp_path, monkeypatch, business_id=7, count=2)
    result = await store.create_test_campaign(
        campaign["id"], "+7 (999) 123-45-67", name="Operator", business_id=7
    )
    test_campaign = result["test_campaign"]
    leads = await store.list_leads(test_campaign["id"])
    assert test_campaign["parent_campaign_id"] == campaign["id"]
    assert test_campaign["business_id"] == 7
    assert test_campaign["callerid"] == campaign["callerid"]
    assert test_campaign["default_context"] == campaign["default_context"]
    assert test_campaign["max_attempts"] == 1
    assert leads["total"] == 1
    assert leads["leads"][0]["phone_number"] == "+79991234567"
    assert (await store.list_leads(campaign["id"]))["total"] == 2
    leased = (await store.lease_pending_leads(test_campaign["id"], limit=10, business_id=7))
    assert len(leased) == 1
    await store.start_attempt(
        test_campaign["id"], leased[0]["id"], lease_token=leased[0]["lease_token"], business_id=7
    )
    assert (await store.list_attempts(test_campaign["id"]))["total"] == 1
    assert (await store.list_attempts(campaign["id"]))["total"] == 0


@pytest.mark.asyncio
@pytest.mark.p0
async def test_test_run_api_returns_isolated_campaign(tmp_path, monkeypatch):
    from admin_ui.backend.api import outbound as outbound_api

    store, campaign = await _campaign_with_leads(tmp_path, monkeypatch, business_id=4)
    monkeypatch.setattr(outbound_api, "_get_outbound_store", lambda: store)
    response = await outbound_api.create_test_run(
        campaign["id"], outbound_api.TestRunRequest(phone_number="79991230000", name="API test")
    )
    assert response["test_campaign"]["is_test"] == 1
    assert response["test_campaign"]["business_id"] == 4
    assert response["lead"]["phone_number"] == "79991230000"


@pytest.mark.asyncio
@pytest.mark.p0
async def test_wrong_business_cannot_update_retry_or_finalize(tmp_path, monkeypatch):
    store, campaign = await _campaign_with_leads(tmp_path, monkeypatch, business_id=2)
    with pytest.raises(KeyError):
        await store.update_campaign(campaign["id"], {"name": "wrong"}, business_id=1)
    lead = (await store.lease_pending_leads(campaign["id"], limit=1, business_id=2))[0]
    attempt_id = await store.start_attempt(
        campaign["id"], lead["id"], lease_token=lead["lease_token"], business_id=2
    )
    with pytest.raises(ValueError):
        await store.finalize_attempt(attempt_id, outcome="error", disposition="retryable", business_id=1)
    assert await store.recycle_lead(lead["id"], business_id=1) is False


@pytest.mark.asyncio
@pytest.mark.p0
async def test_attempt_routing_diagnostics_are_tenant_scoped(tmp_path, monkeypatch):
    store, campaign = await _campaign_with_leads(tmp_path, monkeypatch, business_id=8)
    lead = (await store.lease_pending_leads(campaign["id"], limit=1, business_id=8))[0]
    attempt_id = await store.start_attempt(
        campaign["id"], lead["id"], lease_token=lead["lease_token"], business_id=8
    )

    with pytest.raises(ValueError):
        await store.set_attempt_routing(
            attempt_id,
            business_id=7,
            trunk="wrong-trunk",
            caller_id="+70000000000",
            endpoint="PJSIP/79990000001@wrong-trunk",
        )

    await store.set_attempt_routing(
        attempt_id,
        business_id=8,
        trunk="mts-hotel-eight",
        caller_id="+74950000008",
        endpoint="PJSIP/79990000001@mts-hotel-eight",
        outbound_opener="Здравствуйте, это Hotel Eight.",
    )
    attempt = (await store.list_attempts(campaign["id"]))["attempts"][0]
    assert attempt["trunk"] == "mts-hotel-eight"
    assert attempt["caller_id"] == "+74950000008"
    assert attempt["endpoint"] == "PJSIP/79990000001@mts-hotel-eight"
    assert attempt["outbound_opener"] == "Здравствуйте, это Hotel Eight."


@pytest.mark.p0
def test_error_classification_has_retryable_and_terminal_boundaries():
    assert originate_failure(500, "down").retryable is True
    assert originate_failure(400, "invalid endpoint").retryable is False
    assert sip_failure(17, "Busy").retryable is True
    terminal = sip_failure(1, "Unallocated number")
    assert terminal.retryable is False
    assert terminal.stage == "provider_sip"
    assert "secret" not in sanitize_outbound_error("password=secret")


@pytest.mark.asyncio
@pytest.mark.p0
async def test_legacy_schema_migrates_with_safe_defaults(tmp_path, monkeypatch):
    monkeypatch.setenv("CALL_HISTORY_ENABLED", "true")
    db_path = str(tmp_path / "legacy.db")
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE outbound_campaigns (
                id TEXT PRIMARY KEY, name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft', timezone TEXT NOT NULL DEFAULT 'UTC',
                run_start_at_utc TEXT, run_end_at_utc TEXT,
                daily_window_start_local TEXT NOT NULL DEFAULT '09:00',
                daily_window_end_local TEXT NOT NULL DEFAULT '17:00', max_concurrent INTEGER NOT NULL DEFAULT 1,
                min_interval_seconds_between_calls INTEGER NOT NULL DEFAULT 5,
                default_context TEXT NOT NULL DEFAULT 'default',
                voicemail_drop_enabled INTEGER NOT NULL DEFAULT 1, voicemail_drop_mode TEXT NOT NULL DEFAULT 'upload',
                voicemail_drop_text TEXT, voicemail_drop_media_uri TEXT, consent_enabled INTEGER NOT NULL DEFAULT 0,
                consent_media_uri TEXT, consent_timeout_seconds INTEGER NOT NULL DEFAULT 5,
                amd_options_json TEXT NOT NULL DEFAULT '{}', external_source TEXT, external_id TEXT,
                created_at_utc TEXT NOT NULL, updated_at_utc TEXT NOT NULL
            );
            CREATE TABLE outbound_leads (
                id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL,
                name TEXT, phone_number TEXT NOT NULL, lead_timezone TEXT, context_override TEXT,
                caller_id_override TEXT, custom_vars_json TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'pending',
                attempt_count INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, last_attempt_at_utc TEXT,
                leased_until_utc TEXT, created_at_utc TEXT NOT NULL, updated_at_utc TEXT NOT NULL,
                UNIQUE(campaign_id, phone_number)
            );
            CREATE TABLE outbound_attempts (
                id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, lead_id TEXT NOT NULL,
                started_at_utc TEXT NOT NULL, ended_at_utc TEXT,
                duration_seconds INTEGER, ari_channel_id TEXT, outcome TEXT, amd_status TEXT, amd_cause TEXT,
                consent_dtmf TEXT, consent_result TEXT, context TEXT, provider TEXT,
                call_history_call_id TEXT, error_message TEXT
            );
            """
        )
        conn.execute(
            """INSERT INTO outbound_campaigns
            (id,name,status,timezone,daily_window_start_local,daily_window_end_local,
             max_concurrent,min_interval_seconds_between_calls,default_context,voicemail_drop_enabled,
             voicemail_drop_mode,consent_enabled,consent_timeout_seconds,amd_options_json,created_at_utc,updated_at_utc)
            VALUES ('legacy','Legacy','draft','UTC','09:00','17:00',1,5,'default',0,'upload',0,5,'{}',?,?)""",
            (now, now),
        )
        conn.execute(
            """INSERT INTO outbound_leads
            (id,campaign_id,phone_number,custom_vars_json,state,attempt_count,created_at_utc,updated_at_utc)
            VALUES ('lead','legacy','1234','{}','pending',0,?,?)""",
            (now, now),
        )

    store = OutboundStore(db_path=db_path)
    campaign = await store.get_campaign("legacy")
    lead = (await store.list_leads("legacy"))["leads"][0]
    assert campaign["business_id"] == 1
    assert campaign["max_attempts"] == 3
    assert campaign["retry_initial_delay_seconds"] == 60
    assert campaign["retry_backoff_multiplier"] == 2.0
    assert campaign["retry_max_delay_seconds"] == 3600
    assert lead["business_id"] == 1
    assert "next_attempt_at_utc" in lead
    assert "lease_token" in lead


class _FakeStore:
    def __init__(self, campaign):
        self.campaign = campaign
        self.states = []

    async def set_attempt_channel(self, *args, **kwargs):
        return None

    async def set_lead_state(self, lead_id, **kwargs):
        self.states.append((lead_id, kwargs))

    async def get_campaign(self, campaign_id):
        return dict(self.campaign, id=campaign_id)


class _FakeARI:
    def __init__(self):
        self.variables = {}
        self.continues = 0

    async def set_channel_var(self, channel_id, key, value):
        self.variables[key] = value
        return True

    async def continue_in_dialplan(self, *args, **kwargs):
        self.continues += 1
        return True


class _RecoveryStore:
    def __init__(self, row):
        self.row = row
        self.finalized = []

    async def list_stale_attempts(self, **kwargs):
        return [dict(self.row)]

    async def finalize_attempt(self, attempt_id, **kwargs):
        self.finalized.append((attempt_id, kwargs))
        return {"lead_state": "pending"}


class _RecoveryARI:
    def __init__(self, status):
        self.status = status
        self.hangups = []

    async def send_command(self, *args, **kwargs):
        return {"status": self.status}

    async def hangup_channel(self, channel_id):
        self.hangups.append(channel_id)


class _RecoverySessions:
    async def get_by_channel_id(self, channel_id):
        return None


@pytest.mark.asyncio
@pytest.mark.p0
@pytest.mark.parametrize("ari_status,expect_finalized", [(500, False), (404, True)])
async def test_restart_recovery_defers_when_ari_state_is_unknown(ari_status, expect_finalized, monkeypatch):
    monkeypatch.setenv("AAVA_OUTBOUND_ATTEMPT_STALE_SECONDS", "10")
    row = {
        "id": "attempt",
        "campaign_id": "campaign",
        "lead_id": "lead",
        "business_id": 1,
        "phone_number": "+79990000001",
        "context": "hotel",
        "provider": "google_live",
        "call_id": "channel",
        "ari_channel_id": "channel",
    }
    engine = Engine.__new__(Engine)
    engine.outbound_store = _RecoveryStore(row)
    engine.ari_client = _RecoveryARI(ari_status)
    engine.session_store = _RecoverySessions()
    engine._outbound_attempt_meta_by_attempt_id = {}
    engine._outbound_attempt_meta_by_channel_id = {}
    engine._outbound_attempt_amd = {}
    engine._outbound_awaiting_amd_channel_ids = set()

    await engine._outbound_cleanup_stale_attempts()

    assert bool(engine.outbound_store.finalized) is expect_finalized
    if expect_finalized:
        _, payload = engine.outbound_store.finalized[0]
        assert payload["disposition"] == "retryable"
        assert payload["error_stage"] == "provider_sip"


@pytest.mark.asyncio
@pytest.mark.p0
@pytest.mark.parametrize(
    "voicemail,consent,expect_bypass",
    [(False, False, True), (False, True, False), (True, False, False)],
)
async def test_voicemail_disabled_bypasses_amd_but_consent_only_keeps_gate(voicemail, consent, expect_bypass):
    engine = Engine.__new__(Engine)
    engine.outbound_store = _FakeStore(
        {"voicemail_drop_enabled": voicemail, "consent_enabled": consent, "amd_options": {}}
    )
    engine.ari_client = _FakeARI()
    engine._outbound_attempt_meta_by_attempt_id = {
        "attempt": {
            "attempt_id": "attempt",
            "campaign_id": "campaign",
            "lead_id": "lead",
            "business_id": 1,
            "phone_number": "+79990000001",
            "context": "hotel",
            "custom_vars": {},
        }
    }
    engine._outbound_attempt_meta_by_channel_id = {}
    engine._outbound_awaiting_amd_channel_ids = set()
    engine._outbound_amd_context = "aava-outbound-amd"
    engine._outbound_build_amd_opts = lambda options: ""
    engine._handle_outbound_amd_result = AsyncMock()

    await engine._handle_outbound_answered("channel", {}, ["outbound", "attempt"])

    assert engine.ari_client.variables["AAVA_AMD_ENABLED"] == ("1" if voicemail else "0")
    if expect_bypass:
        engine._handle_outbound_amd_result.assert_awaited_once()
        assert engine.ari_client.continues == 0
    else:
        engine._handle_outbound_amd_result.assert_not_awaited()
        assert engine.ari_client.continues == 1

@pytest.mark.asyncio
@pytest.mark.p0
async def test_originate_transport_unknown_survives_restart_import_reset_and_delete(tmp_path, monkeypatch):
    store, campaign = await _campaign_with_leads(tmp_path, monkeypatch)
    lead = (await store.lease_pending_leads(campaign['id'], limit=1, business_id=1))[0]
    attempt_id = await store.start_attempt(campaign['id'], lead['id'], lease_token=lead['lease_token'], business_id=1)
    result = await store.finalize_attempt(attempt_id, outcome='originate_error', disposition='retryable',
        business_id=1, error_stage='originate', error_code='originate_transport_error')
    assert result['lead_state'] == 'unknown'
    restarted = OutboundStore(db_path=store._db_path)
    await restarted.import_leads_csv(campaign['id'], b'phone_number,name\n+79990000001,Renamed\n', skip_existing=False)
    await restarted.set_lead_state(lead['id'], state='pending', business_id=1)
    assert await restarted.lease_pending_leads(campaign['id'], limit=1, business_id=1) == []
    assert not await restarted.recycle_lead(lead['id'], mode='reset', business_id=1)
    with pytest.raises(ValueError, match='unknown'):
        await restarted.delete_lead(lead['id'])
    await restarted.set_campaign_status(campaign['id'], 'stopped', cancel_pending=True)
    with pytest.raises(ValueError, match='unknown'):
        await restarted.delete_campaign(campaign['id'])


@pytest.mark.asyncio
@pytest.mark.p0
async def test_customer_fixed_retry_interval_applies_to_each_attempt_and_stops_at_limit(tmp_path, monkeypatch):
    store, campaign = await _campaign_with_leads(tmp_path, monkeypatch, max_attempts=3)
    await store.update_campaign(campaign["id"], {
        "retry_initial_delay_seconds": 1020,
        "retry_backoff_multiplier": 1,
        "retry_max_delay_seconds": 1020,
    })
    for index in range(3):
        lead = (await store.lease_pending_leads(campaign["id"], limit=1, business_id=1))[0]
        attempt = await store.start_attempt(campaign["id"],lead["id"],lease_token=lead["lease_token"],business_id=1)
        before = datetime.now(timezone.utc)
        result = await store.finalize_attempt(attempt,outcome="busy",disposition="retryable")
        if index < 2:
            assert result["lead_state"] == "pending"
            delay = (datetime.fromisoformat(result["next_attempt_at_utc"])-before).total_seconds()
            assert 1019 <= delay <= 1021
            assert await store.lease_pending_leads(campaign["id"],limit=1,business_id=1) == []
            with sqlite3.connect(store._db_path) as conn:
                conn.execute("UPDATE outbound_leads SET next_attempt_at_utc=NULL WHERE id=?",(lead["id"],))
        else:
            assert result["lead_state"] == "failed"
            assert result["next_attempt_at_utc"] is None
            assert await store.lease_pending_leads(campaign["id"],limit=1,business_id=1) == []
