"""Local contract tests; all CRM/ARI calls are fakes, never provider acceptance."""
from types import SimpleNamespace
from unittest.mock import AsyncMock
import time

import pytest

from src.core.managed_telephony import ManagedTelephony, TelephonyUnavailable, enforce_duration
from src.engine import Engine

PHONE = '12345678-abcd-abcd-abcd-123456789abc'
ROUTE = {'success': True, 'managed': True, 'phoneId': PHONE, 'endpoint': 'ava-phone-' + PHONE.replace('-', ''), 'number': '79991234567', 'maxSeconds': 300}


def engine():
    e = Engine.__new__(Engine)
    e.config = SimpleNamespace(contexts={}, asterisk=SimpleNamespace(app_name='asterisk-ai-voice-agent'))
    e._hotel_profile_cache = {}
    e._resolve_hotel_profile = AsyncMock(return_value={'id': 7, 'sipTrunkNumber': ROUTE['endpoint']})
    e._fetch_hotel_profile = AsyncMock(return_value={'id': 7, 'knowledgeBaseInstanceId': 7, 'voiceContextName': 'business-7'})
    e._normalize_hotel_profile = lambda raw, bid: raw
    e.ari_client = SimpleNamespace(send_command=AsyncMock(return_value={'status': 204}), hangup_channel=AsyncMock(), set_channel_var=AsyncMock(return_value=True), continue_in_dialplan=AsyncMock(return_value=True))
    e._outbound_finalize_failure = AsyncMock()
    e.outbound_store = SimpleNamespace(set_attempt_routing=AsyncMock(), set_attempt_channel=AsyncMock(), set_lead_state=AsyncMock(), get_campaign=AsyncMock(return_value={'voicemail_drop_enabled': False}))
    e._outbound_attempt_meta_by_attempt_id = {'attempt': {'business_id': 7, 'campaign_id': 'campaign', 'attempt_id': 'attempt', 'context': 'business-7'}}
    e._outbound_attempt_meta_by_channel_id = {}
    e._outbound_resolve_routing = lambda *args: {'trunk': 'global', 'caller_id': 'global-cid', 'caller_id_name': 'AVA'}
    e._outbound_choose_endpoint = AsyncMock(return_value='Local/79991234568@from-internal')
    e._outbound_is_trunk_dialable = lambda _: False
    e._outbound_pbx_type = 'generic'
    e.transport_orchestrator = SimpleNamespace(get_context_config=lambda _: None)
    e.providers = {}
    e._handle_outbound_amd_result = AsyncMock()
    e._cleanup_call = AsyncMock()
    e._handle_outbound_channel_destroyed = AsyncMock()
    e._pre_stasis_channels = set()
    e._outbound_awaiting_amd_channel_ids = set()
    return e


@pytest.mark.asyncio
@pytest.mark.parametrize('bad', [None, {}, {'managed': False}, {**ROUTE, 'phoneId': 'other'}, {**ROUTE, 'endpoint': 'shared'}])
async def test_explicit_source_never_falls_back(monkeypatch, bad):
    client = ManagedTelephony()
    client.request = AsyncMock(return_value=bad or {})
    with pytest.raises(TelephonyUnavailable):
        await client.source(7, PHONE)


@pytest.mark.asyncio
@pytest.mark.parametrize('seconds', [0, 301, '300', True, None])
async def test_bad_reservation_limit_is_rejected(seconds):
    client = ManagedTelephony()
    client.request = AsyncMock(return_value={**ROUTE, 'maxSeconds': seconds})
    with pytest.raises(TelephonyUnavailable):
        await client.reserve(7, 'attempt', source_id=PHONE)


@pytest.mark.asyncio
@pytest.mark.parametrize('number', [None, 'unknown', '1234', '79991234568'])
async def test_did_never_resolves_a_different_number(number):
    client = ManagedTelephony()
    client.request = AsyncMock(return_value={'businessId': 7, 'number': ROUTE['number'], 'contextName': 'business-7', 'phoneId': PHONE})
    with pytest.raises(TelephonyUnavailable):
        await client.resolve(number)


@pytest.mark.asyncio
async def test_did_canonicalization():
    client = ManagedTelephony()
    client.request = AsyncMock(return_value={'businessId': 7, 'number': ROUTE['number'], 'contextName': 'business-7', 'phoneId': PHONE})
    for number in ('+79991234567', '89991234567', '9991234567'):
        assert (await client.resolve(number))['businessId'] == 7
    assert client.request.call_args.args[1] == '/resolve/79991234567'


@pytest.mark.asyncio
async def test_canonical_campaign_identity_and_context_before_pregeneration(monkeypatch):
    e = engine()
    e.config.contexts = {'foreign': SimpleNamespace(business_id=9)}
    assert e._resolve_business_id(campaign={'business_id': 7}, context_name='foreign', custom_vars={'instanceId': 9}) == 7
    source = AsyncMock(return_value=ROUTE)
    monkeypatch.setattr(ManagedTelephony, 'source', source)
    e._outbound_should_pregenerate_opening = lambda context, custom: context != 'business-7'
    result = await e._outbound_prepare_opening_before_dial(campaign={'business_id': 7, 'source_number_id': PHONE}, lead={'custom_vars': {}}, context_name='foreign')
    assert result == {}
    source.assert_awaited_once_with(7, PHONE)
    e._fetch_hotel_profile.assert_awaited_once_with(7)


@pytest.mark.asyncio
async def test_foreign_kb_stops_before_ai_request(monkeypatch):
    e = engine()
    e._fetch_hotel_profile.return_value = {'id': 7, 'knowledgeBaseInstanceId': 9}
    e._outbound_should_pregenerate_opening = lambda *_: pytest.fail('must not consult foreign AI context')
    monkeypatch.setattr(ManagedTelephony, 'source', AsyncMock(return_value=ROUTE))
    with pytest.raises(TelephonyUnavailable, match='TELEPHONY_PROFILE_UNAVAILABLE'):
        await e._outbound_prepare_opening_before_dial(campaign={'business_id': 7}, lead={}, context_name='foreign')


@pytest.mark.asyncio
async def test_false_route_for_managed_endpoint_fails_closed(monkeypatch):
    e = engine()
    monkeypatch.setattr(ManagedTelephony, 'source', AsyncMock(return_value={'managed': False}))
    with pytest.raises(TelephonyUnavailable, match='TELEPHONY_SOURCE_UNAVAILABLE'):
        await e._outbound_telephony_route({'business_id': 7}, 7, 'default')


@pytest.mark.asyncio
@pytest.mark.parametrize('response', [{'status': 500}, {'status': 404}, None])
async def test_absolute_timeout_non_success_fails(response):
    ari = SimpleNamespace(send_command=AsyncMock(return_value=response))
    with pytest.raises(TelephonyUnavailable, match='TELEPHONY_DEADLINE_FAILED'):
        await enforce_duration(ari, 'chan', 300)


@pytest.mark.asyncio
async def test_maximum_duration_is_300():
    ari = SimpleNamespace(send_command=AsyncMock(return_value={'status': 204}))
    await enforce_duration(ari, 'chan', 999)
    assert ari.send_command.call_args.kwargs['data'] == {'variable': 'TIMEOUT(absolute)', 'value': '300'}


@pytest.mark.asyncio
async def test_answer_before_originate_response_and_transfer_settle_on_destroy(monkeypatch):
    e = engine()
    monkeypatch.setattr(ManagedTelephony, 'source', AsyncMock(return_value=ROUTE))
    monkeypatch.setattr(ManagedTelephony, 'reserve', AsyncMock(return_value=ROUTE))
    finish = AsyncMock()
    monkeypatch.setattr(ManagedTelephony, 'finish', finish)
    post = {}
    async def command(method, path, **kwargs):
        if path == 'channels':
            post.update(kwargs)
            cid = kwargs['params']['channelId']
            await e._handle_outbound_answered(cid, {}, ['outbound', 'attempt'])
            post['answered'] = e._managed_call_channels[cid]['answered_at']
            return {'id': cid}
        return {'status': 204}
    e.ari_client.send_command = command
    await e._outbound_originate_attempt({'id': 'campaign', 'business_id': 7, 'source_number_id': PHONE}, {'id': 'lead', 'phone_number': '+79991234568'}, 'attempt')
    cid = 'ava-managed-attempt'
    assert e._managed_call_channels[cid]['answered_at'] == post['answered']
    assert post['params']['endpoint'] == 'PJSIP/79991234568@' + ROUTE['endpoint']
    assert post['data']['variables']['TIMEOUT(absolute)'] == '300'
    assert post['data']['variables']['AI_CONTEXT'] == 'business-7'
    assert post['data']['variables']['CALLERID(num)'] == ROUTE['number']
    await e._handle_stasis_end({'channel': {'id': cid}})  # transfer leaves Stasis but caller lives
    finish.assert_not_awaited()
    assert cid in e._managed_call_channels
    e._managed_call_channels[cid]['answered_at'] = time.time() - 120
    await e._handle_channel_destroyed({'channel': {'id': 'employee'}})
    finish.assert_not_awaited()
    await e._handle_channel_destroyed({'channel': {'id': cid}})
    args = finish.call_args.args
    assert args[:2] == (7, 'attempt') and 119 <= args[2] <= 121 and args[3] == cid
    await e._handle_channel_destroyed({'channel': {'id': cid}})
    assert finish.await_count == 1


@pytest.mark.asyncio
async def test_early_destroy_before_originate_response_does_not_resurrect(monkeypatch):
    e = engine()
    monkeypatch.setattr(ManagedTelephony, 'source', AsyncMock(return_value=ROUTE))
    monkeypatch.setattr(ManagedTelephony, 'reserve', AsyncMock(return_value=ROUTE))
    finish = AsyncMock()
    monkeypatch.setattr(ManagedTelephony, 'finish', finish)
    async def command(method, path, **kwargs):
        cid = kwargs['params']['channelId']
        await e._handle_channel_destroyed({'channel': {'id': cid}})
        e._outbound_attempt_meta_by_attempt_id.pop('attempt', None)
        return {'id': cid}
    e.ari_client.send_command = command
    await e._outbound_originate_attempt({'id': 'campaign', 'business_id': 7}, {'id': 'lead', 'phone_number': '79991234568'}, 'attempt')
    finish.assert_awaited_once_with(7, 'attempt', 0, 'ava-managed-attempt')
    assert not e._managed_call_channels and 'attempt' not in e._outbound_attempt_meta_by_attempt_id


@pytest.mark.asyncio
async def test_lost_originate_response_keeps_reservation_for_host_reconciliation(monkeypatch):
    e = engine()
    monkeypatch.setattr(ManagedTelephony, 'source', AsyncMock(return_value=ROUTE))
    monkeypatch.setattr(ManagedTelephony, 'reserve', AsyncMock(return_value=ROUTE))
    finish = AsyncMock()
    monkeypatch.setattr(ManagedTelephony, 'finish', finish)
    e.ari_client.send_command.side_effect = TimeoutError()
    await e._outbound_originate_attempt({'id': 'campaign', 'business_id': 7}, {'id': 'lead', 'phone_number': '79991234568'}, 'attempt')
    finish.assert_not_awaited()
    assert 'ava-managed-attempt' in e._managed_call_channels
    e._managed_call_channels = {}  # simulated engine crash loses process memory
    await e._handle_channel_destroyed({'channel': {'id': 'ava-managed-attempt'}})
    finish.assert_not_awaited()  # crash must not undercharge or unlock another live channel


@pytest.mark.asyncio
@pytest.mark.parametrize('variable', ['AI_CONTEXT', 'TIMEOUT(absolute)'])
async def test_managed_outbound_required_variable_failure_hangs_up(monkeypatch, variable):
    e = engine()
    e._outbound_attempt_meta_by_attempt_id['attempt'].update(phone_number_id=PHONE, telephony_max_seconds=300)
    async def command(*args, **kw):
        return {'status': 500 if kw.get('data', {}).get('variable') == variable else 204}
    e.ari_client.send_command = command
    await e._handle_outbound_answered('chan', {}, ['outbound', 'attempt'])
    e.ari_client.hangup_channel.assert_awaited_once_with('chan')
    e._handle_outbound_amd_result.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['unknown', 'foreign_profile', 'context_failure'])
async def test_managed_ingress_rejects_before_answer_or_ai(monkeypatch, mode):
    e = engine()
    e.session_store = SimpleNamespace(get_by_call_id=AsyncMock(return_value=None))
    e.ari_client.answer_channel = AsyncMock()
    async def command(method, path, **kwargs):
        name = kwargs.get('params', {}).get('variable')
        if method == 'GET':
            return {'value': {'AAVA_OUTBOUND': '', 'AAVA_MANAGED_INGRESS': '1', 'DIALED_NUMBER': ROUTE['number']}.get(name, '')}
        return {'status': 500 if kwargs.get('data', {}).get('variable') == 'AI_CONTEXT' else 204}
    e.ari_client.send_command = command
    resolve = AsyncMock(return_value={'businessId': 7, 'phoneId': PHONE, 'contextName': 'business-7'})
    if mode == 'unknown':
        resolve.side_effect = TelephonyUnavailable('TELEPHONY_DID_UNAVAILABLE')
    if mode == 'foreign_profile':
        e._fetch_hotel_profile.return_value = {'id': 8, 'knowledgeBaseInstanceId': 8}
    monkeypatch.setattr(ManagedTelephony, 'resolve', resolve)
    monkeypatch.setattr(ManagedTelephony, 'reserve', AsyncMock(return_value=ROUTE))
    finish = AsyncMock()
    monkeypatch.setattr(ManagedTelephony, 'finish', finish)
    await e._handle_caller_stasis_start_hybrid('inbound', {'caller': {}})
    e.ari_client.hangup_channel.assert_awaited_once_with('inbound')
    e.ari_client.answer_channel.assert_not_awaited()
    finish.assert_not_awaited()  # only destruction proves the call is finished


@pytest.mark.asyncio
async def test_valid_managed_inbound_reaches_answer_and_keeps_reservation(monkeypatch):
    e = engine()
    e.session_store = SimpleNamespace(get_by_call_id=AsyncMock(return_value=None))
    e.ari_client.answer_channel = AsyncMock()
    async def command(method, path, **kwargs):
        if method == 'GET':
            return {'value': {'AAVA_OUTBOUND': '', 'AAVA_MANAGED_INGRESS': '1', 'AAVA_RECORDING_STARTED': '1', 'DIALED_NUMBER': ROUTE['number']}.get(kwargs.get('params', {}).get('variable'), '')}
        return {'status': 204}
    e.ari_client.send_command = command
    monkeypatch.setattr(ManagedTelephony, 'resolve', AsyncMock(return_value={'businessId': 7, 'phoneId': PHONE, 'contextName': 'business-7'}))
    reserve = AsyncMock(return_value=ROUTE)
    monkeypatch.setattr(ManagedTelephony, 'reserve', reserve)
    await e._handle_caller_stasis_start_hybrid('valid-inbound', {'caller': {}})
    reserve.assert_awaited_once_with(7, 'valid-inbound', number=ROUTE['number'], direction='inbound')
    e.ari_client.answer_channel.assert_awaited_once_with('valid-inbound')
    assert e._managed_call_channels['valid-inbound']['answered_at'] > 0


@pytest.mark.parametrize('field', ['businessId', 'instance_id', 'knowledge_base_instance_id'])
def test_conflicting_profile_alias_cannot_fall_back(field):
    e = engine()
    with pytest.raises(TelephonyUnavailable, match='TELEPHONY_PROFILE_UNAVAILABLE'):
        e._managed_hotel_profile({'id': 7, field: 9}, 7)


@pytest.mark.asyncio
async def test_manual_foreign_kb_stops_before_pregeneration(monkeypatch):
    e = engine()
    e._resolve_hotel_profile.return_value = {'id': 7, 'knowledgeBaseInstanceId': 9}
    monkeypatch.delenv('AVA_MANAGED_TELEPHONY_ENABLED', raising=False)
    with pytest.raises(TelephonyUnavailable, match='TELEPHONY_SCOPE_MISMATCH'):
        await e._outbound_prepare_opening_before_dial(campaign={'business_id': 7}, lead={}, context_name='default')


@pytest.mark.asyncio
async def test_audio_profile_cannot_override_verified_tenant_with_channel_defaults():
    from src.core.models import CallSession
    e = engine()
    e.config.default_provider = 'local'
    e._save_session = AsyncMock()
    e.ari_client.send_command.return_value = {'value': 'business-9'}
    session = CallSession(call_id='owned', caller_channel_id='owned', business_id=7,
                          telephony_business_id=7, telephony_context_name='business-7')
    session.hotel_profile = {'id': 7, 'businessId': 7, 'knowledgeBaseInstanceId': 7, 'voiceAiProvider': 'local'}
    await e._resolve_audio_profile(session, 'owned')
    assert session.business_id == 7 and session.context_name == 'business-7'
    assert session.hotel_profile['knowledgeBaseInstanceId'] == 7
    e._resolve_hotel_profile.assert_not_awaited()


@pytest.mark.asyncio
async def test_duplicate_answer_does_not_renew_deadline_or_start_time():
    e = engine()
    e._outbound_attempt_meta_by_attempt_id['attempt'].update(phone_number_id=PHONE, telephony_max_seconds=300)
    await e._handle_outbound_answered('chan', {}, ['outbound', 'attempt'])
    answered = e._managed_call_channels['chan']['answered_at']
    await e._handle_outbound_answered('chan', {}, ['outbound', 'attempt'])
    assert e._managed_call_channels['chan']['answered_at'] == answered
    deadline_writes = [call for call in e.ari_client.send_command.call_args_list
                       if call.kwargs.get('data', {}).get('variable') == 'TIMEOUT(absolute)']
    assert len(deadline_writes) == 1
    e.ari_client.continue_in_dialplan.assert_awaited_once_with(
        'chan', context='ava-managed-outbound-record', extension='s', priority=1)


@pytest.mark.asyncio
@pytest.mark.parametrize('response', [None, {}, {'value': '0'}, {'status': 500, 'value': '1'},
                                    {'status': 404, 'value': '1'}, {'status': 302, 'value': '1'}])
async def test_recording_return_cannot_treat_truthy_ari_error_as_success(response):
    e = engine()
    e._outbound_attempt_meta_by_attempt_id['attempt'].update(phone_number_id=PHONE)
    await e._handle_outbound_stasis('chan', {}, ['outbound', 'attempt'])
    await e._handle_stasis_end({'channel': {'id': 'chan'}})
    e._cleanup_call.assert_not_awaited()
    e.ari_client.send_command.return_value = response
    await e._handle_outbound_stasis('chan', {}, ['outbound_recorded', 'attempt'])
    e.ari_client.hangup_channel.assert_awaited_once_with('chan')
    e._handle_outbound_amd_result.assert_not_awaited()


@pytest.mark.asyncio
async def test_recording_return_reaches_ai_without_second_recorder_or_deadline():
    e = engine()
    e._outbound_attempt_meta_by_attempt_id['attempt'].update(phone_number_id=PHONE)
    await e._handle_outbound_stasis('chan', {}, ['outbound', 'attempt'])
    answered = e._managed_call_channels['chan']['answered_at']
    async def command(method, path, **kw):
        return {'value': '1'} if method == 'GET' else {'status': 204}
    e.ari_client.send_command.side_effect = command
    await e._handle_outbound_stasis('chan', {}, ['outbound_recorded', 'attempt'])
    e._handle_outbound_amd_result.assert_awaited_once()
    assert e._managed_call_channels['chan']['answered_at'] == answered
    assert e._outbound_attempt_meta_by_attempt_id['attempt']['telephony_recording_started']
    assert 'chan' not in e._outbound_awaiting_amd_channel_ids
    e.ari_client.continue_in_dialplan.assert_awaited_once()
    assert len([c for c in e.ari_client.send_command.call_args_list
                if c.kwargs.get('data', {}).get('variable') == 'TIMEOUT(absolute)']) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['continue', 'destroy'])
async def test_recording_hop_failure_keeps_reservation_until_caller_destroy(monkeypatch, failure):
    e = engine()
    e._outbound_attempt_meta_by_attempt_id['attempt'].update(phone_number_id=PHONE)
    if failure == 'continue':
        e.ari_client.continue_in_dialplan.return_value = False
    finish = AsyncMock()
    monkeypatch.setattr(ManagedTelephony, 'finish', finish)
    await e._handle_outbound_stasis('chan', {}, ['outbound', 'attempt'])
    finish.assert_not_awaited()
    assert 'chan' in e._managed_call_channels
    e._handle_outbound_amd_result.assert_not_awaited()
    await e._handle_channel_destroyed({'channel': {'id': 'chan'}})
    assert finish.await_count == 1
    assert 'chan' not in e._outbound_awaiting_amd_channel_ids
    assert not e._managed_call_channels
