import os
from datetime import datetime, timedelta, timezone

import pytest


@pytest.mark.asyncio
async def test_call_history_list_count_filter_parity(tmp_path, monkeypatch):
    monkeypatch.setenv("CALL_HISTORY_ENABLED", "true")
    db_path = str(tmp_path / "call_history.db")

    from src.core.call_history import CallHistoryStore, CallRecord

    store = CallHistoryStore(db_path=db_path)

    now = datetime.now(timezone.utc)

    r1 = CallRecord(
        call_id="call-1",
        caller_number="1001",
        caller_name="Alice",
        start_time=now,
        end_time=now + timedelta(seconds=10),
        duration_seconds=10.0,
        provider_name="openai_realtime",
        pipeline_name=None,
        pipeline_components={},
        context_name="demo",
        conversation_history=[{"role": "user", "content": "hi"}],
        outcome="completed",
        tool_calls=[],
        avg_turn_latency_ms=100.0,
        max_turn_latency_ms=100.0,
        total_turns=1,
        caller_audio_format="ulaw",
        codec_alignment_ok=True,
        barge_in_count=0,
    )

    r2 = CallRecord(
        call_id="call-2",
        caller_number="1002",
        caller_name="Bob",
        start_time=now + timedelta(minutes=1),
        end_time=now + timedelta(minutes=1, seconds=5),
        duration_seconds=5.0,
        provider_name="deepgram",
        pipeline_name=None,
        pipeline_components={},
        context_name="demo",
        conversation_history=[{"role": "user", "content": "transfer me"}],
        outcome="transferred",
        tool_calls=[{"name": "transfer_call", "params": {"target": "6000"}, "result": "success"}],
        avg_turn_latency_ms=250.0,
        max_turn_latency_ms=250.0,
        total_turns=1,
        caller_audio_format="ulaw",
        codec_alignment_ok=True,
        barge_in_count=0,
    )

    assert await store.save(r1) is True
    assert await store.save(r2) is True

    # Filter parity: has_tool_calls must match for list/count.
    listed = await store.list(has_tool_calls=True, include_details=False)
    counted = await store.count(has_tool_calls=True)
    assert counted == len(listed) == 1
    assert listed[0].call_id == "call-2"
    # include_details=False should not hydrate the heavy fields.
    assert listed[0].conversation_history == []
    assert listed[0].tool_calls == []

    # Caller-name filter parity.
    listed = await store.list(caller_name="Ali", include_details=False)
    counted = await store.count(caller_name="Ali")
    assert counted == len(listed) == 1
    assert listed[0].call_id == "call-1"


@pytest.mark.asyncio
async def test_call_history_persists_outbound_routing_diagnostics(tmp_path, monkeypatch):
    monkeypatch.setenv("CALL_HISTORY_ENABLED", "true")
    from src.core.call_history import CallHistoryStore, CallRecord

    store = CallHistoryStore(db_path=str(tmp_path / "routing.db"))
    now = datetime.now(timezone.utc)
    record = CallRecord(
        call_id="call-routing",
        caller_number="79990000008",
        called_number="79990000008",
        business_id=8,
        direction="outbound",
        campaign_id="campaign-8",
        lead_id="lead-8",
        attempt_id="attempt-8",
        trunk="mts-hotel-eight",
        caller_id="+74950000008",
        outbound_opener="Здравствуйте, это Hotel Eight.",
        start_time=now,
        end_time=now + timedelta(seconds=3),
        provider_name="openai_realtime",
    )

    assert await store.save(record) is True
    persisted = await store.get_by_call_id("call-routing")
    assert persisted is not None
    assert persisted.business_id == 8
    assert persisted.direction == "outbound"
    assert persisted.campaign_id == "campaign-8"
    assert persisted.lead_id == "lead-8"
    assert persisted.attempt_id == "attempt-8"
    assert persisted.trunk == "mts-hotel-eight"
    assert persisted.caller_id == "+74950000008"
    assert persisted.outbound_opener == "Здравствуйте, это Hotel Eight."



@pytest.mark.asyncio
async def test_managed_phone_identity_roundtrips_with_tenant_after_transfer(tmp_path, monkeypatch):
    monkeypatch.setenv('CALL_HISTORY_ENABLED', 'true')
    from src.core.call_history import CallHistoryStore, CallRecord
    path = str(tmp_path / 'managed.db')
    store = CallHistoryStore(db_path=path)
    record = CallRecord(call_id='owned-call', business_id=7,
                        phone_number_id='12345678-abcd-abcd-abcd-123456789abc', outcome='transferred',
                        start_time=datetime.now(timezone.utc), end_time=datetime.now(timezone.utc), provider_name='google_live')
    assert await store.save(record)
    persisted = await CallHistoryStore(db_path=path).get_by_call_id('owned-call')
    assert persisted.business_id == 7 and persisted.phone_number_id == record.phone_number_id
    assert persisted.outcome == 'transferred'
