import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiohttp import web

from src.core.managed_telephony import ManagedTelephony, TelephonyUnavailable
from src.core.outbound_store import OutboundStore
from src.engine import Engine


def imported(campaign, lead):
    return {**lead, 'custom_vars': {'sales_brain_campaign_id': campaign['external_id'],
        'sales_brain_lead_id': 'crm-lead', 'sales_brain_instance_id': campaign['business_id']}}


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['allow', 'deny', 'unavailable', 'foreign', 'paused'])
async def test_real_http_scoped_preflight_fails_closed(tmp_path, monkeypatch, mode):
    monkeypatch.setenv('CALL_HISTORY_ENABLED', 'true')
    store = OutboundStore(db_path=str(tmp_path / 'outbound.db'))
    campaign = await store.create_campaign({'name':'CRM', 'business_id':2, 'external_source':'sales_brain', 'external_id':'crm-campaign'})
    await store.import_leads_csv(campaign['id'], b'phone_number\n+79990000001\n')
    await store.set_campaign_status(campaign['id'], 'running')
    lead = imported(campaign, (await store.lease_pending_leads(campaign['id'], limit=1, business_id=2))[0])
    requests = []

    async def permission(request):
        assert request.headers['Authorization'] == 'Bearer synthetic-token'
        body = await request.json()
        assert body == {'businessId':2,'campaignId':'crm-campaign','leadId':'crm-lead','phone':'+79990000001'}
        requests.append(body)
        if mode == 'unavailable':
            return web.json_response({'success':False}, status=503)
        return web.json_response({'success':True,'businessId':3 if mode=='foreign' else 2,
            'campaignId':'crm-campaign','leadId':'crm-lead','allowed':mode=='allow',
            'reason':'campaign_not_running' if mode=='paused' else 'do_not_call'})

    app = web.Application()
    app.router.add_post('/api/internal/telephony/campaigns/can-dial', permission)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    monkeypatch.setenv('SALES_BRAIN_BASE_URL', f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}')
    monkeypatch.setenv('CRM_SERVICE_API_TOKEN','synthetic-token')
    engine = Engine.__new__(Engine)
    engine.outbound_store = store
    try:
        allowed = await engine._outbound_preflight_leased(campaign, lead)
        assert allowed is (mode=='allow')
        assert len(requests) == 1
        current = (await store.list_leads(campaign['id']))['leads'][0]
        assert current['state'] == ('canceled' if mode=='deny' else 'leased')
        assert current['attempt_count'] == 0
        assert (await store.list_attempts(campaign['id']))['attempts'] == []
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_native_campaign_needs_no_crm_but_imported_malformed_scope_is_closed(monkeypatch):
    request = AsyncMock(side_effect=AssertionError('must not request CRM'))
    monkeypatch.setattr(ManagedTelephony,'request',request)
    engine = Engine.__new__(Engine)
    assert await engine._outbound_crm_permission({'external_source':None}, {})
    with pytest.raises(TelephonyUnavailable):
        await engine._outbound_crm_permission({'external_source':'sales_brain','business_id':2}, {})
    request.assert_not_awaited()


@pytest.mark.asyncio
async def test_policy_cancellation_cannot_change_released_active_unknown_or_foreign_lease(tmp_path, monkeypatch):
    monkeypatch.setenv('CALL_HISTORY_ENABLED','true')
    store = OutboundStore(db_path=str(tmp_path / 'outbound.db'))
    c = await store.create_campaign({'name':'Scoped','business_id':2})
    await store.import_leads_csv(c['id'], b'phone_number\n+79990000001\n')
    await store.set_campaign_status(c['id'],'running')
    lead = (await store.lease_pending_leads(c['id'],limit=1,business_id=2))[0]
    for business,token in [(3,lead['lease_token']),(2,'old-token')]:
        assert not await store.cancel_leased_for_policy(c['id'],lead['id'],business_id=business,lease_token=token)
    attempt = await store.start_attempt(c['id'],lead['id'],business_id=2,lease_token=lead['lease_token'])
    assert not await store.cancel_leased_for_policy(c['id'],lead['id'],business_id=2,lease_token=lead['lease_token'])
    await store.finalize_attempt(attempt,outcome='originate_unknown',disposition='unknown',business_id=2)
    assert not await store.cancel_leased_for_policy(c['id'],lead['id'],business_id=2,lease_token=lead['lease_token'])
    assert (await store.list_leads(c['id']))['leads'][0]['state']=='unknown'


@pytest.mark.asyncio
async def test_scheduler_rechecks_after_opening_and_never_starts_denied_attempt(tmp_path, monkeypatch):
    monkeypatch.setenv('CALL_HISTORY_ENABLED','true')
    store = OutboundStore(db_path=str(tmp_path / 'outbound.db'))
    c = await store.create_campaign({'name':'Scoped','business_id':2,'external_source':'sales_brain','external_id':'crm-campaign'})
    await store.import_leads_csv(c['id'], b'phone_number\n+79990000001\n')
    await store.set_campaign_status(c['id'],'running')
    c = await store.get_campaign(c['id'])
    engine = Engine.__new__(Engine)
    engine.outbound_store = store
    engine.session_store = SimpleNamespace(count_active_outbound_calls=AsyncMock(return_value=0))
    engine._outbound_attempt_meta_by_attempt_id = {}
    engine._outbound_last_dial_ts = {}
    engine._outbound_last_campaign_error_log_ts = {}
    engine._outbound_cleanup_stale_attempts = AsyncMock()
    engine._outbound_campaign_in_window = lambda *_: True
    engine._outbound_telephony_route = AsyncMock(return_value=('default',{},None))
    engine._outbound_originate_attempt = AsyncMock()
    engine.transport_orchestrator = SimpleNamespace(get_context_config=lambda _:None)
    engine.providers = {}
    order = []
    async def prepare(**kwargs):
        order.append('prepared_then_opted_out')
        return {'sales_brain_campaign_id':'crm-campaign','sales_brain_lead_id':'crm-lead','sales_brain_instance_id':2}
    async def permission(*args):
        assert order == ['prepared_then_opted_out']
        order.append('fresh_denied')
        return False
    engine._outbound_prepare_opening_before_dial = prepare
    engine._outbound_crm_permission = permission
    monkeypatch.setattr(store,'list_running_campaigns',AsyncMock(side_effect=[[c],asyncio.CancelledError()]))
    await asyncio.wait_for(engine._outbound_scheduler_loop(),timeout=4)
    assert order == ['prepared_then_opted_out','fresh_denied']
    engine._outbound_originate_attempt.assert_not_awaited()
    assert (await store.list_attempts(c['id']))['attempts']==[]
    assert (await store.list_leads(c['id']))['leads'][0]['state']=='canceled'
