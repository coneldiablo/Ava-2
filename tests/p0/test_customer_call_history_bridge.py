"""The CRM call-history bridge must require a service token and stay tenant-scoped."""

from types import SimpleNamespace
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi import FastAPI

from admin_ui.backend.api import calls


def record(business_id):
    return SimpleNamespace(
        id="row-1", call_id="call-1", business_id=business_id,
        caller_number="+79990000000", caller_name=None, called_number=None,
        direction="inbound", campaign_id=None, lead_id=None, attempt_id=None,
        trunk=None, caller_id=None, outbound_opener="private prompt",
        start_time=None, end_time=None, duration_seconds=3.0,
        provider_name="sip", pipeline_name=None, context_name=None,
        outcome="completed", error_message="secret diagnostic",
        avg_turn_latency_ms=0.0, total_turns=0, barge_in_count=0,
        created_at=None,
    )


@pytest.mark.asyncio
async def test_internal_call_list_requires_token_and_redacts_diagnostics(monkeypatch):
    monkeypatch.setenv("CRM_SERVICE_API_TOKEN", "bridge-test-token")

    class Store:
        async def count(self, **kwargs):
            assert kwargs["business_id"] == 7
            return 1

        async def list(self, **kwargs):
            assert kwargs["business_id"] == 7
            assert kwargs["include_details"] is False
            return [record(7)]

    monkeypatch.setattr(calls, "_get_call_history_store", lambda: Store())
    app = FastAPI()
    app.include_router(calls.internal_router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.get("/api/internal/calls/business/7")).status_code == 401
        response = await client.get("/api/internal/calls/business/7", headers={"Authorization": "Bearer bridge-test-token"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["calls"][0]["business_id"] == 7
    assert payload["calls"][0]["error_message"] is None
    assert payload["calls"][0]["outbound_opener"] is None


@pytest.mark.asyncio
async def test_internal_call_list_fails_closed_on_wrong_tenant(monkeypatch):
    monkeypatch.setenv("CRM_SERVICE_API_TOKEN", "bridge-test-token")

    class Store:
        async def count(self, **kwargs):
            return 1

        async def list(self, **kwargs):
            return [record(2)]

    monkeypatch.setattr(calls, "_get_call_history_store", lambda: Store())
    app = FastAPI()
    app.include_router(calls.internal_router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/internal/calls/business/7", headers={"Authorization": "Bearer bridge-test-token"})
    assert response.status_code == 500
    assert "calls" not in response.json()


@pytest.mark.asyncio
async def test_legacy_call_without_business_id_is_visible_only_to_original_business(monkeypatch):
    monkeypatch.setenv("CRM_SERVICE_API_TOKEN", "bridge-test-token")

    class Store:
        async def count(self, **kwargs):
            return 1

        async def list(self, **kwargs):
            return [record(None)]

    monkeypatch.setattr(calls, "_get_call_history_store", lambda: Store())
    app = FastAPI()
    app.include_router(calls.internal_router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        headers = {"Authorization": "Bearer bridge-test-token"}
        original = await client.get("/api/internal/calls/business/1", headers=headers)
        foreign = await client.get("/api/internal/calls/business/2", headers=headers)
    assert original.status_code == 200
    assert original.json()["calls"][0]["business_id"] == 1
    assert foreign.status_code == 500


@pytest.mark.asyncio
async def test_internal_stats_are_real_tenant_scoped_and_redacted(tmp_path, monkeypatch):
    from src.core.call_history import CallHistoryStore, CallRecord

    monkeypatch.setenv("CRM_SERVICE_API_TOKEN", "bridge-test-token")
    monkeypatch.setenv("CALL_HISTORY_ENABLED", "true")
    store = CallHistoryStore(db_path=str(tmp_path / "calls.db"))
    now = datetime.now(timezone.utc)
    for tenant, direction, duration in [(7, "inbound", 10), (7, "outbound", 20), (8, "inbound", 999)]:
        assert await store.save(CallRecord(
            call_id=f"{tenant}-{direction}", business_id=tenant,
            direction=direction, duration_seconds=duration, start_time=now - timedelta(hours=1),
            end_time=now - timedelta(hours=1) + timedelta(seconds=duration),
            caller_number="+79990000000", outbound_opener="secret prompt",
            error_message="secret diagnostic", provider_name="sip", outcome="completed",
        ))
    monkeypatch.setattr(calls, "_get_call_history_store", lambda: store)
    app = FastAPI()
    app.include_router(calls.internal_router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        path = "/api/internal/calls/business/7/stats?days=7"
        assert (await client.get(path)).status_code == 401
        response = await client.get(path, headers={"Authorization": "Bearer bridge-test-token"})
        empty = await client.get("/api/internal/calls/business/9/stats?days=30", headers={"Authorization": "Bearer bridge-test-token"})
        invalid = await client.get("/api/internal/calls/business/7/stats?days=8", headers={"Authorization": "Bearer bridge-test-token"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["business_id"] == 7
    assert payload["total_calls"] == 2
    assert payload["avg_duration_seconds"] == 15
    assert payload["directions"] == {"inbound": 1, "outbound": 1}
    assert payload["outcomes"] == {"completed": 2}
    assert payload["providers"] == {"sip": 2}
    assert len(payload["calls_per_day"]) == 1
    assert not any(secret in str(payload) for secret in ("+79990000000", "secret prompt", "secret diagnostic", "active_calls", "top_callers"))
    assert empty.status_code == 200
    assert empty.json()["total_calls"] == 0
    assert empty.json()["directions"] == {}
    assert invalid.status_code == 422


@pytest.mark.asyncio
async def test_internal_stats_90_days_keeps_more_than_admin_30_day_limit(tmp_path, monkeypatch):
    from src.core.call_history import CallHistoryStore, CallRecord

    monkeypatch.setenv("CRM_SERVICE_API_TOKEN", "bridge-test-token")
    store = CallHistoryStore(db_path=str(tmp_path / "calls.db"))
    now = datetime.now(timezone.utc)
    for age in range(40):
        start = now - timedelta(days=age, hours=1)
        assert await store.save(CallRecord(
            call_id=f"day-{age}", business_id=7,
            start_time=start, end_time=start + timedelta(seconds=10),
            provider_name="google_live", outcome="completed",
        ))
    monkeypatch.setattr(calls, "_get_call_history_store", lambda: store)
    app = FastAPI()
    app.include_router(calls.internal_router, prefix="/api")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get(
            "/api/internal/calls/business/7/stats?days=90",
            headers={"Authorization": "Bearer bridge-test-token"},
        )
    assert response.status_code == 200
    assert response.json()["total_calls"] == 40
    assert len(response.json()["calls_per_day"]) == 40
    # Keep the older Admin dashboard's bounded default unchanged.
    assert len((await store.get_stats(business_id=7))["calls_per_day"]) == 30
