from pathlib import Path
import pytest
import yaml


@pytest.mark.parametrize('channel', ['whatsapp', 'telegram', 'email', 'vk', 'max', 'avito'])
def test_generic_followup_maps_requested_destination_without_recipient_override(monkeypatch, channel):
    from src.mcp_servers import sales_brain_mcp_server as server
    calls = []
    monkeypatch.setattr(server, '_post_json', lambda path, payload: calls.append((path, payload)) or {'success': True, 'spoken': 'ok'})
    server._handle_call('send_followup', {'target_channel': channel, 'caller_number': '+79990000001',
                                        'call_id': 'actual-call', 'instance_id': 7, 'text': 'Информация',
                                        'draft_id': 'draft-1', 'confirmed': True, 'recipient': 'foreign'})
    assert calls == [('/api/ml/followup/send', {'channel': channel, 'phone': '+79990000001', 'callId': 'actual-call',
                                              'instanceId': 7, 'text': 'Информация', 'draftId': 'draft-1', 'confirmed': True})]
    schema = next(t['inputSchema'] for t in server._tools_list()['tools'] if t['name'] == 'send_followup')
    assert 'target_channel' in schema['required'] and 'confirmed' in schema['required']
    assert not {'recipient', 'chat_id', 'phone', 'channel'} & schema['properties'].keys()


@pytest.mark.asyncio
async def test_actual_call_scope_wins_and_destination_survives_voice_channel_injection(monkeypatch):
    from src.mcp_servers import sales_brain_mcp_server as server
    from src.tools.context import ToolExecutionContext
    from src.tools.mcp_tool import MCPTool, MCPToolBehavior
    calls = []
    monkeypatch.setattr(server, '_post_json', lambda path, payload: calls.append((path, payload)) or {'success': True, 'spoken': 'ok'})
    class Manager:
        async def call_tool(self, *, tool_name, arguments, **kwargs):
            return server._handle_call(tool_name, arguments)
    schema = next(t['inputSchema'] for t in server._tools_list()['tools'] if t['name'] == 'draft_followup')
    tool = MCPTool(exposed_name='mcp_sales_draft_followup', server_id='sales_brain', mcp_tool_name='draft_followup',
                   description='Draft', input_schema=schema, manager=Manager(), behavior=MCPToolBehavior())
    await tool.execute({'target_channel': 'telegram', 'instance_id': 999, 'caller_number': '+79990000999', 'call_id': 'model-call'},
                       ToolExecutionContext(call_id='actual-call', business_id=7, caller_number='+79990000001'))
    assert calls == [('/api/ml/followup/draft', {'channel': 'telegram', 'phone': '+79990000001', 'callId': 'actual-call',
                                               'instanceId': 7, 'text': None})]


@pytest.mark.asyncio
async def test_legacy_sales_phone_cannot_select_a_different_customer(monkeypatch):
    from src.mcp_servers import sales_brain_mcp_server as server
    from src.tools.context import ToolExecutionContext
    from src.tools.mcp_tool import MCPTool, MCPToolBehavior
    calls = []
    monkeypatch.setattr(server, '_post_json', lambda path, payload: calls.append((path, payload)) or {'success': True, 'spoken': 'ok'})
    class Manager:
        async def call_tool(self, *, tool_name, arguments, **kwargs):
            return server._handle_call(tool_name, arguments)
    schema = next(t['inputSchema'] for t in server._tools_list()['tools'] if t['name'] == 'customer_summary')
    tool = MCPTool(exposed_name='mcp_sales_customer_summary', server_id='sales_brain', mcp_tool_name='customer_summary',
                   description='Summary', input_schema=schema, manager=Manager(), behavior=MCPToolBehavior())
    await tool.execute({'phone': '+79990000999', 'instance_id': 999},
                       ToolExecutionContext(call_id='actual-call', business_id=7, caller_number='+79990000001'))
    assert calls == [('/api/ml/customer/summary', {'phone': '+79990000001', 'instanceId': 7})]


def test_generic_tools_retain_published_autopilot_write_and_reply_actions():
    from src.tools.context import ToolExecutionContext
    assert ToolExecutionContext._autopilot_required_action_for_tool('mcp_sales_draft_followup') == 'update_fields'
    assert ToolExecutionContext._autopilot_required_action_for_tool('mcp_sales_send_followup') == 'reply'
    config = yaml.safe_load((Path(__file__).parents[1] / 'config/ai-agent.yaml').read_text())
    found = []
    def walk(value):
        if isinstance(value, dict):
            for child in value.values(): walk(child)
        elif isinstance(value, list):
            if 'mcp_sales_send_whatsapp_followup' in [v for v in value if isinstance(v, str)]:
                assert 'mcp_sales_send_followup' in value and 'mcp_sales_draft_followup' in value
                found.append(True)
            for child in value: walk(child)
    walk(config)
    assert found
