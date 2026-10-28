from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from src.engine import Engine


def fixture_engine():
    engine = object.__new__(Engine)
    engine.transport_orchestrator = SimpleNamespace(get_context_config=lambda _: SimpleNamespace(pre_call_tools=['sales_brain_pre_call_context']))
    return engine


@pytest.mark.parametrize('activated', [True, False, 'true', 'false'])
def test_gate_accepts_explicit_authorized_policy_and_legacy_response(activated):
    engine = fixture_engine()
    results = {'sales_autopilot_activated': activated, 'sales_autopilot_allowed': True}
    if str(activated).lower() == 'true':
        results['sales_autopilot_allowed_actions'] = '["reply","handoff"]'
    assert engine._voice_autopilot_block_reason(SimpleNamespace(context_name='sales'), {
        **results,
    }) is None


def test_published_voice_policy_requires_reply_action():
    engine = fixture_engine()
    assert engine._voice_autopilot_block_reason(SimpleNamespace(context_name='sales'), {
        'sales_autopilot_activated': 'true', 'sales_autopilot_allowed': 'true',
        'sales_autopilot_allowed_actions': '["handoff"]',
    }) == 'voice_autopilot_action_blocked'


@pytest.mark.parametrize('results', [{}, {'sales_autopilot_activated': '', 'sales_autopilot_allowed': ''}, {'sales_autopilot_activated': True}])
def test_configured_gate_fails_closed_when_lookup_is_unavailable(results):
    assert fixture_engine()._voice_autopilot_block_reason(SimpleNamespace(context_name='sales'), results) == 'voice_autopilot_gate_unavailable'


def test_paused_or_human_control_blocks_voice_and_other_contexts_remain_compatible():
    engine = fixture_engine()
    assert engine._voice_autopilot_block_reason(SimpleNamespace(context_name='sales'), {'sales_autopilot_activated': 'true', 'sales_autopilot_allowed': 'false'}) == 'voice_autopilot_blocked'
    engine.transport_orchestrator.get_context_config = lambda _: SimpleNamespace(pre_call_tools=[])
    assert engine._voice_autopilot_block_reason(SimpleNamespace(context_name='support'), {}) is None


@pytest.mark.asyncio
async def test_denied_gate_never_constructs_provider_and_persists_terminal_reason():
    engine = fixture_engine()
    session = SimpleNamespace(call_id='call', context_name='sales', business_id=7, hotel_profile={}, provider_name='local', provider_session_active=False, caller_channel_id='caller')
    engine.session_store = SimpleNamespace(get_by_call_id=AsyncMock(return_value=session))
    engine.providers = {'local': object()}
    engine.provider_factories = {'local': lambda: pytest.fail('Provider created before policy permission')}
    engine._call_providers = {}
    engine._execute_pre_call_tools = AsyncMock(return_value={'sales_autopilot_activated': 'true', 'sales_autopilot_allowed': 'false'})
    engine._save_session = AsyncMock()
    engine.on_provider_event = AsyncMock()
    engine._cleanup_call = AsyncMock()
    await engine._start_provider_session('call')
    assert session.error_message == 'voice_autopilot_blocked'
    engine.on_provider_event.assert_awaited_once()
    engine._cleanup_call.assert_awaited_once_with('call')
    assert engine._call_providers == {}


def test_native_config_maps_gate_and_requests_idempotent_call_source():
    import yaml
    from pathlib import Path
    config = yaml.safe_load(Path('config/ai-agent.yaml').read_text())
    tool = config['tools']['sales_brain_pre_call_context']
    assert tool['output_variables']['sales_autopilot_allowed'] == 'autopilot_allowed'
    assert tool['output_variables']['sales_autopilot_allowed_actions'] == 'autopilot_allowed_actions'
    assert '"callId": "{call_id}"' in tool['body_template']


@pytest.mark.asyncio
async def test_native_tool_context_blocks_policy_disallowed_writes():
    from src.tools.context import ToolExecutionContext
    context = ToolExecutionContext(call_id='call', autopilot_allowed_actions=['reply', 'handoff'])
    blocked = await context.get_tool_block_response('mcp_sales_update_stage')
    assert blocked['status'] == 'error'
    assert blocked['required_action'] == 'update_fields'
    assert await context.get_tool_block_response('mcp_sales_answer_from_knowledge') is None
