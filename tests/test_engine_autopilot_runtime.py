"""Native live-control tests; all providers, transports and CRM lookups are mocked."""
import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from src.engine import Engine
from src.tools.context import ToolExecutionContext


def allowed(actions=None, *, activated=True):
    return {
        'sales_autopilot_activated': activated,
        'sales_autopilot_allowed': True,
        'sales_autopilot_policy_revision': '7',
        'sales_autopilot_allowed_actions': json.dumps(actions if actions is not None else ['reply']),
    }


def fixture():
    engine = object.__new__(Engine)
    session = SimpleNamespace(call_id='native-call', business_id=9, context_name='sales',
        caller_number='+79990000001', caller_name='Test', caller_channel_id='caller',
        provider_session_active=True, tts_tokens={'old-segment'}, tts_playing=True,
        cleanup_after_tts=True, audio_capture_enabled=True,
        outbound_custom_vars={'ava_voice_phase': 'active'}, pre_call_results={})
    engine.transport_orchestrator = SimpleNamespace(get_context_config=lambda _: SimpleNamespace(pre_call_tools=['sales_brain_pre_call_context']))
    engine.config = SimpleNamespace(tools={})
    engine.session_store = SimpleNamespace(get_by_call_id=AsyncMock(return_value=session),
        list_playbacks_for_call=AsyncMock(return_value=['file-playback']), clear_gating_token=AsyncMock())
    engine.ari_client = SimpleNamespace(stop_playback=AsyncMock(), hangup_channel=AsyncMock())
    engine.streaming_playback_manager = SimpleNamespace(active_streams={'native-call': {}}, stop_streaming_playback=AsyncMock(), start_streaming_playback=AsyncMock())
    engine._provider_stream_queues = {'native-call': object()}
    engine._provider_stream_formats = {'native-call': {}}
    engine._provider_coalesce_buf = {'native-call': bytearray(b'old tail')}
    engine._pipeline_tasks, engine._pipeline_queues, engine._pipeline_transcript_queues = {}, {}, {}
    engine._call_bg_tasks = {}
    provider = SimpleNamespace(cancel_response=AsyncMock(), stop_session=AsyncMock())
    engine._call_providers = {'native-call': provider}
    engine._save_session = AsyncMock()
    engine._ensure_voice_autopilot_watch = Mock()
    return engine, session, provider


async def shutdown(engine, session):
    task = engine._voice_runtime_state(session.call_id).get('shutdown_task')
    if task:
        await task


@pytest.mark.asyncio
async def test_lookup_refreshes_only_gate_and_never_trusts_outbound_phase(monkeypatch):
    from src.tools.registry import tool_registry
    engine, session, _ = fixture()
    tool = SimpleNamespace(definition=SimpleNamespace(timeout_ms=5000), execute=AsyncMock(return_value=allowed()))
    getter = Mock(return_value=tool)
    monkeypatch.setattr(tool_registry, 'get', getter)
    engine._execute_pre_call_tools = AsyncMock(side_effect=AssertionError('Unrelated enrichment must not rerun'))
    await engine._refresh_voice_autopilot_gate(session, force=True, phase='before_start')
    initial = tool.execute.call_args.args[0]
    assert initial.business_id == 9 and initial.call_id == 'native-call'
    assert initial.outbound_custom_vars['ava_voice_phase'] == 'before_start'
    await engine._refresh_voice_autopilot_gate(session, force=True, phase='active')
    assert tool.execute.call_args.args[0].outbound_custom_vars['ava_voice_phase'] == 'active'
    assert getter.call_args_list == [(("sales_brain_pre_call_context",),)] * 2
    engine._execute_pre_call_tools.assert_not_awaited()


@pytest.mark.asyncio
async def test_audio_cache_is_bounded_and_tool_boundary_forces_refresh(monkeypatch):
    from src.tools.registry import tool_registry
    engine, session, _ = fixture()
    tool = SimpleNamespace(definition=SimpleNamespace(timeout_ms=5000), execute=AsyncMock(return_value=allowed()))
    monkeypatch.setattr(tool_registry, 'get', lambda _: tool)
    await engine._refresh_voice_autopilot_gate(session, force=True)
    await engine._refresh_voice_autopilot_gate(session)
    assert tool.execute.await_count == 1
    engine._voice_runtime_state(session.call_id)['checked_at'] = time.monotonic() - 0.251
    await engine._refresh_voice_autopilot_gate(session)
    assert tool.execute.await_count == 2
    assert await engine._voice_tool_block_response(session.call_id, 'mcp_sales_answer_from_knowledge') is None
    assert tool.execute.await_count == 3


@pytest.mark.asyncio
async def test_takeover_drops_audio_flushes_tail_and_preserves_caller():
    engine, session, provider = fixture()
    engine._refresh_voice_autopilot_gate = AsyncMock(return_value={**allowed(), 'sales_autopilot_allowed': False, 'sales_autopilot_reason': 'WORKSPACE_HUMAN_CONTROL'})
    await engine.on_provider_event({'type': 'AgentAudio', 'call_id': session.call_id, 'data': b'never play'})
    await shutdown(engine, session)
    state = engine._voice_runtime_state(session.call_id)
    assert state['blocked'] is True
    assert engine.streaming_playback_manager.active_streams[session.call_id]['end_reason'] == 'barge-in'
    engine.streaming_playback_manager.stop_streaming_playback.assert_awaited_once_with(session.call_id)
    engine.streaming_playback_manager.start_streaming_playback.assert_not_awaited()
    engine.ari_client.stop_playback.assert_awaited_once_with('file-playback')
    engine.session_store.clear_gating_token.assert_awaited_once_with(session.call_id, 'old-segment')
    provider.cancel_response.assert_awaited_once()
    provider.stop_session.assert_awaited_once()
    engine.ari_client.hangup_channel.assert_not_awaited()
    assert session.provider_session_active is False and session.cleanup_after_tts is False
    assert session.call_id not in engine._provider_coalesce_buf
    # A provider disconnect caused by our own stop must preserve the SIP leg too.
    await engine.on_provider_event({'type': 'ProviderDisconnected', 'call_id': session.call_id})
    engine.ari_client.hangup_channel.assert_not_awaited()


@pytest.mark.asyncio
async def test_unavailable_live_gate_fails_closed_and_does_not_repeat_shutdown(monkeypatch):
    from src.tools.registry import tool_registry
    engine, session, provider = fixture()
    tool = SimpleNamespace(definition=SimpleNamespace(timeout_ms=100), execute=AsyncMock(side_effect=OSError('offline')))
    monkeypatch.setattr(tool_registry, 'get', lambda _: tool)
    assert await engine._voice_runtime_allowed(session, force=True) is False
    await shutdown(engine, session)
    assert engine._voice_runtime_state(session.call_id)['reason'] == 'voice_autopilot_gate_unavailable'
    assert await engine._voice_runtime_allowed(session, force=True) is False
    await shutdown(engine, session)
    provider.stop_session.assert_awaited_once()
    engine.ari_client.hangup_channel.assert_not_awaited()


@pytest.mark.asyncio
async def test_old_provider_output_cannot_resume_before_watch_recreates_session():
    engine, session, _ = fixture()
    state = engine._voice_runtime_state(session.call_id)
    state['blocked'] = True
    engine._refresh_voice_autopilot_gate = AsyncMock(return_value=allowed())
    assert await engine._voice_runtime_allowed(session, force=True) is False


@pytest.mark.asyncio
async def test_watch_only_resumes_after_fresh_server_permission_and_complete_shutdown(monkeypatch):
    engine, session, _ = fixture()
    state = engine._voice_runtime_state(session.call_id)
    state.update(blocked=True, admitted=True)
    ended = asyncio.get_running_loop().create_future()
    ended.set_result(None)
    state['shutdown_task'] = ended
    engine._refresh_voice_autopilot_gate = AsyncMock(side_effect=[{**allowed(), 'sales_autopilot_allowed': False}, allowed()])
    engine._block_voice_runtime = AsyncMock()
    engine._start_provider_session = AsyncMock()
    engine.session_store.get_by_call_id = AsyncMock(side_effect=[session, session, None])
    # Deterministic tick; no physical clock delay or external phone required.
    async def tick(_):
        return None
    monkeypatch.setattr('src.engine.asyncio.sleep', tick)
    await engine._voice_autopilot_watch(session.call_id)
    engine._block_voice_runtime.assert_awaited_once()
    engine._start_provider_session.assert_awaited_once_with(session.call_id, runtime_resume=True)
    assert state['blocked'] is False
    assert all(c.kwargs['phase'] == 'active' for c in engine._refresh_voice_autopilot_gate.await_args_list)


@pytest.mark.asyncio
@pytest.mark.parametrize('actions,tool,permitted', [
    (['reply'], 'mcp_sales_answer_from_knowledge', True),
    (['reply'], 'mcp_sales_update_stage', False),
    (['reply', 'update_fields'], 'mcp_sales_update_stage', True),
    (['reply', 'quote'], 'mcp_sales_send_whatsapp_followup', False),
    (['reply', 'quote', 'update_fields'], 'mcp_hotel_create_booking_request', False),
    (['reply'], 'mcp_sales_create_manager_task', True),
    (['reply'], 'transfer', True),
    (['reply'], 'invented_write_tool', False),
])
async def test_policy_actions_do_not_authorize_arbitrary_voice_writes(actions, tool, permitted):
    engine, session, _ = fixture()
    engine._refresh_voice_autopilot_gate = AsyncMock(return_value=allowed(actions))
    async def refresh(*args, **kwargs):
        result = allowed(actions)
        engine._voice_runtime_state(session.call_id)['results'] = result
        return result
    engine._refresh_voice_autopilot_gate.side_effect = refresh
    result = await engine._voice_tool_block_response(session.call_id, tool)
    assert (result is None) is permitted


@pytest.mark.asyncio
async def test_tool_context_fails_closed_when_runtime_guard_raises():
    context = ToolExecutionContext(call_id='call', runtime_guard=AsyncMock(side_effect=OSError('CRM unavailable')))
    blocked = await context.get_tool_block_response('mcp_sales_create_crm_note')
    assert blocked['code'] == 'voice_autopilot_gate_unavailable' and blocked['ai_should_speak'] is False


@pytest.mark.asyncio
@pytest.mark.parametrize('adapter_name', ['openai', 'deepgram', 'google', 'elevenlabs'])
async def test_native_adapter_cannot_execute_before_runtime_guard(adapter_name):
    tool = SimpleNamespace(execute=AsyncMock(return_value={'status': 'success'}))
    registry = SimpleNamespace(get=lambda _: tool, get_tool=lambda _: tool, is_tool_allowed=lambda *_: True)
    guard = AsyncMock(return_value={'status': 'error', 'code': 'voice_autopilot_blocked', 'message': 'Human control', 'ai_should_speak': False})
    context = {'call_id': 'call', 'session_store': SimpleNamespace(), 'ari_client': SimpleNamespace(), 'runtime_guard': guard, 'allowed_tools': ['write']}
    if adapter_name == 'openai':
        from src.tools.adapters.openai import OpenAIToolAdapter
        result = await OpenAIToolAdapter(registry).handle_tool_call_event({'item': {'type': 'function_call', 'call_id': 'invocation', 'name': 'write', 'arguments': '{}'}}, context)
    elif adapter_name == 'deepgram':
        from src.tools.adapters.deepgram import DeepgramToolAdapter
        result = await DeepgramToolAdapter(registry).handle_tool_call_event({'functions': [{'id': 'invocation', 'name': 'write', 'arguments': '{}'}]}, context)
    elif adapter_name == 'google':
        from src.tools.adapters.google import GoogleToolAdapter
        result = await GoogleToolAdapter(registry).execute_tool('write', {}, ToolExecutionContext(call_id='call', runtime_guard=guard))
    else:
        from src.tools.adapters.elevenlabs import ElevenLabsToolAdapter
        result = await ElevenLabsToolAdapter(registry).execute_tool('write', 'invocation', {}, context)
    if adapter_name == 'elevenlabs':
        assert result['success'] is False and result['result']['status'] == 'error'
    else:
        assert result['status'] == 'error'
    guard.assert_awaited_once_with('call', 'write')
    tool.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_yandex_direct_tool_path_also_checks_runtime_guard(monkeypatch):
    from src.providers.yandex_realtime import YandexRealtimeProvider, tool_registry
    tool = SimpleNamespace(execute=AsyncMock(return_value={'status': 'success'}))
    monkeypatch.setattr(tool_registry, 'get', lambda _: tool)
    monkeypatch.setattr(tool_registry, 'is_tool_allowed', lambda *_: True)
    provider = YandexRealtimeProvider(SimpleNamespace(api_key='fixture', folder_id='fixture'), AsyncMock())
    provider._call_id, provider._closing = 'call', False
    provider._context = {'tools': ['write']}
    provider._voice_tool_guard = AsyncMock(return_value={'status': 'error', 'code': 'voice_autopilot_blocked'})
    provider._record_tool = AsyncMock()
    provider._send = AsyncMock()
    await provider._execute_tool({'name': 'write', 'call_id': 'invocation', 'arguments': '{}'})
    provider._voice_tool_guard.assert_awaited_once_with('call', 'write')
    tool.execute.assert_not_awaited()
    assert provider._record_tool.call_args.args[2]['status'] == 'error'


@pytest.mark.asyncio
async def test_initial_enrichment_forces_before_start_despite_outbound_custom_vars(monkeypatch):
    from src.tools.registry import tool_registry
    engine, session, _ = fixture()
    tool = SimpleNamespace(definition=SimpleNamespace(name='sales_brain_pre_call_context', timeout_ms=5000, hold_audio_file=None, hold_audio_threshold_ms=500, output_variables=[]), execute=AsyncMock(return_value=allowed()))
    monkeypatch.setattr(tool_registry, 'get_tools_for_context', lambda **kwargs: [tool])
    session.is_outbound = True
    session.outbound_custom_vars['sales_customer_context'] = 'Cached outbound context'
    result = await engine._execute_pre_call_tools(session.call_id, session)
    assert tool.execute.call_args.args[0].outbound_custom_vars['ava_voice_phase'] == 'before_start'
    assert result['sales_customer_context'] == 'Cached outbound context'


@pytest.mark.asyncio
async def test_elevenlabs_callback_cannot_bypass_fresh_runtime_guard():
    from src.tools.adapters.elevenlabs import ElevenLabsToolAdapter
    callback = AsyncMock(return_value={'success': True})
    guard = AsyncMock(return_value={'status': 'error', 'code': 'voice_autopilot_blocked'})
    result = await ElevenLabsToolAdapter(None, execute_callback=callback).execute_tool('write', 'invocation', {}, {'call_id': 'call', 'runtime_guard': guard})
    assert result['success'] is False
    callback.assert_not_awaited()
    guard.assert_awaited_once_with('call', 'write')


@pytest.mark.asyncio
async def test_elevenlabs_get_registry_fallback_still_runs_guard_before_tool():
    from src.tools.adapters.elevenlabs import ElevenLabsToolAdapter
    tool = SimpleNamespace(execute=AsyncMock(return_value={'status': 'success'}))
    registry = SimpleNamespace(get=Mock(return_value=tool))
    guard = AsyncMock(return_value=None)
    result = await ElevenLabsToolAdapter(registry).execute_tool('read', 'invocation', {}, {'call_id': 'call', 'runtime_guard': guard})
    assert result['success'] is True
    guard.assert_awaited_once_with('call', 'read')
    registry.get.assert_called_once_with('read')
    tool.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_takeover_during_provider_startup_preserves_caller_instead_of_failure_cleanup():
    engine, session, _ = fixture()
    session.hotel_profile = {}
    session.provider_name = 'local'
    session.provider_session_active = False
    engine._call_providers.clear()
    engine._business_voice_provider = lambda _: None
    engine._apply_provider_overrides = lambda *_: None
    engine.config = SimpleNamespace(default_provider='local', audio_transport='audiosocket', tools={}, dict=lambda: {})
    engine.pipeline_orchestrator = SimpleNamespace(enabled=False)
    engine._execute_pre_call_tools = AsyncMock(return_value=allowed())
    engine._cleanup_call = AsyncMock()
    engine.conversation_coordinator = None
    async def start(*args, **kwargs):
        engine._voice_runtime_state(session.call_id)['blocked'] = True
        raise RuntimeError('Provider stopped by live takeover during startup')
    provider = SimpleNamespace(config={}, start_session=start, stop_session=AsyncMock())
    engine.provider_factories = {'local': lambda: provider}
    await engine._start_provider_session(session.call_id)
    assert session.provider_session_active is False
    engine._cleanup_call.assert_not_awaited()
    engine.ari_client.hangup_channel.assert_not_awaited()
