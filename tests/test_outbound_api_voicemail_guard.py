import sys
from pathlib import Path
import importlib.util

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
ADMIN_BACKEND = PROJECT_ROOT / "admin_ui" / "backend"
if str(ADMIN_BACKEND) not in sys.path:
    sys.path.insert(0, str(ADMIN_BACKEND))

spec = importlib.util.spec_from_file_location("outbound_api_for_test", ADMIN_BACKEND / "api" / "outbound.py")
outbound = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(outbound)


class FakeOutboundStore:
    def __init__(self, campaign):
        self.campaign = dict(campaign)
        self.updates = []
        self.status_updates = []

    async def get_campaign(self, campaign_id):
        return dict(self.campaign, id=campaign_id)

    async def campaign_stats(self, campaign_id):
        return {"lead_states": {"pending": 1}}

    async def update_campaign(self, campaign_id, body):
        self.updates.append((campaign_id, dict(body)))
        self.campaign.update(body)
        return dict(self.campaign, id=campaign_id)

    async def set_campaign_status(self, campaign_id, status, cancel_pending=False):
        self.status_updates.append((campaign_id, status, cancel_pending))
        self.campaign["status"] = status
        return dict(self.campaign, id=campaign_id)


@pytest.mark.asyncio
async def test_start_campaign_does_not_require_voicemail_when_disabled(monkeypatch):
    store = FakeOutboundStore({
        "voicemail_drop_enabled": 0,
        "voicemail_drop_media_uri": "",
        "consent_enabled": 0,
        "timezone": "UTC",
    })
    monkeypatch.setattr(outbound, "_get_outbound_store", lambda: store)

    result = await outbound.set_campaign_status(
        "campaign-1",
        outbound.CampaignStatusRequest(status="running"),
    )

    assert result["status"] == "running"
    assert store.updates == []
    assert store.status_updates == [("campaign-1", "running", False)]


@pytest.mark.asyncio
async def test_start_campaign_autofills_default_voicemail_when_enabled(monkeypatch):
    store = FakeOutboundStore({
        "voicemail_drop_enabled": 1,
        "voicemail_drop_media_uri": "",
        "consent_enabled": 0,
        "timezone": "UTC",
    })
    monkeypatch.setattr(outbound, "_get_outbound_store", lambda: store)
    monkeypatch.setattr(
        outbound,
        "_media_uri_exists",
        lambda media_uri: media_uri == outbound.DEFAULT_VOICEMAIL_MEDIA_URI,
    )

    result = await outbound.set_campaign_status(
        "campaign-1",
        outbound.CampaignStatusRequest(status="running"),
    )

    assert result["status"] == "running"
    assert store.updates == [
        ("campaign-1", {"voicemail_drop_media_uri": outbound.DEFAULT_VOICEMAIL_MEDIA_URI})
    ]


def test_campaign_api_accepts_managed_source_and_sync_distinguishes_omitted_from_clear():
    phone = '12345678-abcd-abcd-abcd-123456789abc'
    assert outbound.CampaignCreateRequest(name='managed', source_number_id=phone).source_number_id == phone
    assert 'source_number_id' not in outbound.SalesBrainCampaignSyncRequest().model_fields_set
    assert 'source_number_id' in outbound.SalesBrainCampaignSyncRequest(source_number_id=None).model_fields_set

@pytest.mark.asyncio
async def test_crm_status_reconciliation_is_read_only_and_returns_only_scoped_evidence(monkeypatch):
    class ReadOnlyStore:
        async def find_campaign_by_external(self, source, external_id):
            assert (source, external_id) == ('sales_brain', 'crm-campaign')
            return {'id':'engine-campaign','business_id':7,'external_source':source,'external_id':external_id,
                'status':'running','source_number_id':None,'callerid':'private','system_prompt':'never expose'}
        async def set_campaign_status(self, *args, **kwargs):
            raise AssertionError('read-only status must not mutate or dispatch')
    monkeypatch.setattr(outbound, '_get_outbound_store', lambda: ReadOnlyStore())
    result = await outbound.get_sales_brain_campaign_status_internal('crm-campaign')
    assert result['ava_campaign']['business_id'] == 7
    assert result['ava_campaign']['status'] == 'running'
    assert 'system_prompt' not in result['ava_campaign']
    assert 'callerid' not in result['ava_campaign']

def test_crm_campaign_status_http_requires_service_auth_and_never_starts(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    class ReadOnlyStore:
        async def find_campaign_by_external(self, source, external_id):
            return {'id':'engine-campaign','business_id':9,'external_source':source,'external_id':external_id,'status':'paused'}
        async def set_campaign_status(self, *args, **kwargs):
            raise AssertionError('GET must never start/resume')
    monkeypatch.setenv('CRM_SERVICE_API_TOKEN','synthetic-test-service-token')
    monkeypatch.setattr(outbound,'_get_outbound_store',lambda:ReadOnlyStore())
    app=FastAPI();app.include_router(outbound.internal_router)
    with TestClient(app) as client:
        path='/internal/outbound/sales-brain/campaigns/crm-campaign/status'
        assert client.get(path).status_code==401
        response=client.get(path,headers={'Authorization':'Bearer synthetic-test-service-token'})
        assert response.status_code==200
        assert response.json()['ava_campaign']['status']=='paused'
