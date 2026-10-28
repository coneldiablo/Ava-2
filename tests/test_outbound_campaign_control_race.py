"""Campaign control must win over a scheduler's previously leased batch."""
import pytest

from src.core.outbound_store import OutboundStore


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["paused", "stopped", "archived", "completed", "draft"])
async def test_control_change_before_attempt_blocks_old_lease(tmp_path, monkeypatch, status):
    monkeypatch.setenv("CALL_HISTORY_ENABLED", "true")
    store = OutboundStore(db_path=str(tmp_path / "outbound.db"))
    campaign = await store.create_campaign({"name": "Controlled", "business_id": 2})
    await store.import_leads_csv(campaign["id"], b"phone_number\n+79990000001\n")
    await store.set_campaign_status(campaign["id"], "running")
    lead = (await store.lease_pending_leads(campaign["id"], limit=1, business_id=2))[0]

    # A second process changes control while the scheduler prepares the opening.
    controller = OutboundStore(db_path=store._db_path)
    await controller.set_campaign_status(campaign["id"], status, cancel_pending=status == "stopped")
    with pytest.raises(ValueError, match="not running"):
        await store.start_attempt(campaign["id"], lead["id"], lease_token=lead["lease_token"], business_id=2)
    assert (await store.list_attempts(campaign["id"]))["attempts"] == []
    after = (await store.list_leads(campaign["id"]))["leads"][0]
    assert after["attempt_count"] == 0
    if status == "stopped":
        assert after["state"] == "canceled"
        assert after["lease_token"] is None
    if status == "paused":
        await controller.set_campaign_status(campaign["id"], "running")
        await store.start_attempt(campaign["id"], lead["id"], lease_token=lead["lease_token"], business_id=2)
        assert len((await store.list_attempts(campaign["id"]))["attempts"]) == 1


@pytest.mark.asyncio
async def test_stop_cancels_unstarted_batch_but_retains_active_and_unknown(tmp_path, monkeypatch):
    monkeypatch.setenv("CALL_HISTORY_ENABLED", "true")
    store = OutboundStore(db_path=str(tmp_path / "outbound.db"))
    campaign = await store.create_campaign({"name": "Controlled", "business_id": 2})
    await store.import_leads_csv(campaign["id"], b"phone_number\n+79990000001\n+79990000002\n+79990000003\n+79990000004\n")
    await store.set_campaign_status(campaign["id"], "running")
    leads = await store.lease_pending_leads(campaign["id"], limit=3, business_id=2)
    active = await store.start_attempt(campaign["id"], leads[0]["id"], lease_token=leads[0]["lease_token"], business_id=2)
    unknown = await store.start_attempt(campaign["id"], leads[1]["id"], lease_token=leads[1]["lease_token"], business_id=2)
    await store.finalize_attempt(unknown, outcome="originate_unknown", disposition="unknown", business_id=2)
    await store.set_campaign_status(campaign["id"], "stopped", cancel_pending=True)
    states = {row["id"]: row["state"] for row in (await store.list_leads(campaign["id"]))["leads"]}
    assert states[leads[0]["id"]] == "dialing"
    assert states[leads[1]["id"]] == "unknown"
    assert states[leads[2]["id"]] == "canceled"
    assert list(states.values()).count("canceled") == 2
    attempts = {row["id"]: row for row in (await store.list_attempts(campaign["id"]))["attempts"]}
    assert attempts[active]["ended_at_utc"] is None
    assert attempts[unknown]["ended_at_utc"] is not None
