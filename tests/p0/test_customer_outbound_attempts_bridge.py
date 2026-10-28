"""The customer CRM only receives scoped, redacted outbound attempt history."""

import httpx
import pytest
from fastapi import FastAPI

from admin_ui.backend.api import outbound


def _app():
    app = FastAPI()
    app.include_router(outbound.internal_router, prefix="/api")
    return app


def _campaign(business_id=7):
    return {
        "id": "ava-campaign-1", "business_id": business_id,
        "external_source": "sales_brain", "external_id": "crm-campaign-1",
    }


def _attempt(business_id=7):
    return {
        "id": "attempt-1", "campaign_id": "ava-campaign-1", "business_id": business_id,
        "name": "Guest", "phone_number": "+79990000000", "started_at_utc": "2026-09-23T10:00:00Z",
        "error_stage": "originate", "error_code": "ari_http_503", "retryable": 1,
        "error_message": "Authorization: Bearer abcdefgh123456 password=supersecret",
        "endpoint": "PJSIP/private-trunk", "outbound_opener": "private prompt",
    }


@pytest.mark.asyncio
async def test_attempt_bridge_requires_token_and_returns_only_scoped_safe_fields(monkeypatch):
    monkeypatch.setenv("CRM_SERVICE_API_TOKEN", "bridge-test-token")

    class Store:
        async def find_campaign_by_external(self, source, external_id):
            assert (source, external_id) == ("sales_brain", "crm-campaign-1")
            return _campaign()

        async def list_attempts(self, campaign_id, *, page, page_size):
            assert (campaign_id, page, page_size) == ("ava-campaign-1", 1, 20)
            return {"attempts": [_attempt()], "total": 1, "page": 1, "page_size": 20, "total_pages": 1}

    monkeypatch.setattr(outbound, "_get_outbound_store", lambda: Store())
    url = "/api/internal/outbound/sales-brain/campaigns/crm-campaign-1/attempts"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app()), base_url="http://test") as client:
        assert (await client.get(url)).status_code == 401
        response = await client.get(url, headers={"Authorization": "Bearer bridge-test-token"})

    assert response.status_code == 200
    body = response.json()
    assert body["ava_campaign"] == {
        "id": "ava-campaign-1", "business_id": 7, "external_source": "sales_brain",
        "external_campaign_id": "crm-campaign-1",
    }
    row = body["attempts"][0]
    assert row["business_id"] == 7
    assert row["error_stage"] == "originate"
    assert "abcdefgh123456" not in row["error_message"]
    assert "supersecret" not in row["error_message"]
    assert "endpoint" not in row and "outbound_opener" not in row


@pytest.mark.asyncio
@pytest.mark.parametrize("foreign", ["campaign", "attempt", "wrong_campaign"])
async def test_attempt_bridge_fails_closed_on_scope_mismatch(monkeypatch, foreign):
    monkeypatch.setenv("CRM_SERVICE_API_TOKEN", "bridge-test-token")

    class Store:
        async def find_campaign_by_external(self, *_args):
            return _campaign(8 if foreign == "campaign" else 7)

        async def list_attempts(self, *_args, **kwargs):
            row = _attempt(8 if foreign == "attempt" else 7)
            if foreign == "wrong_campaign":
                row["campaign_id"] = "ava-campaign-other"
            return {"attempts": [row], "total": 1, "page": kwargs["page"],
                    "page_size": kwargs["page_size"], "total_pages": 1}

    monkeypatch.setattr(outbound, "_get_outbound_store", lambda: Store())
    url = "/api/internal/outbound/sales-brain/campaigns/crm-campaign-1/attempts"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app()), base_url="http://test") as client:
        response = await client.get(url, headers={"Authorization": "Bearer bridge-test-token"})
    assert response.status_code == 503
    assert "attempts" not in response.json()
