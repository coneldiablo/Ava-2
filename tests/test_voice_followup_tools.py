import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.mcp_servers import sales_brain_mcp_server as server
from src.tools.mcp_tool import MCPTool, MCPToolBehavior


@pytest.mark.parametrize('status,sent', [('needs_approval', False), ('pending', False), ('awaiting_call_completion', False), ('sent', True)])
@pytest.mark.asyncio
async def test_delivery_status_survives_mcp_and_provider_serialization(monkeypatch, status, sent):
    from src.providers.neuro_gemini import NeuroGeminiProvider
    from src.tools.adapters.sanitize import sanitize_tool_result_for_json_string

    monkeypatch.setattr(server, '_post_json', lambda *args: {
        'success': sent or status == 'awaiting_call_completion', 'status': status,
        'sent': sent, 'draft_id': 'fixture-draft', 'spoken': 'Состояние запроса.'})
    reply = server.send_followup('telegram', 'Материалы', True, caller_number='79990000001', call_id='fixture', instance_id=4)
    manager = SimpleNamespace(call_tool=AsyncMock(return_value=reply))
    tool = MCPTool(exposed_name='mcp_sales_send_followup', server_id='sales_brain',
                   mcp_tool_name='send_followup', description='Send requested information',
                   input_schema={'properties': {'instance_id': {}, 'caller_number': {}, 'call_id': {}}},
                   manager=manager, behavior=MCPToolBehavior(speech_field='spoken'))
    result = await tool.execute({'caller_number': 'foreign', 'instance_id': 99},
        SimpleNamespace(call_id='fixture', business_id=4, caller_number='79990000001'))
    assert result['status'] == status
    assert result['data']['sent'] is sent
    assert manager.call_tool.call_args.kwargs['arguments']['instance_id'] == 4
    assert manager.call_tool.call_args.kwargs['arguments']['caller_number'] == '79990000001'
    for output in (NeuroGeminiProvider._normalize_tool_result(result), sanitize_tool_result_for_json_string(result)):
        assert output['status'] == status
        assert output['data']['sent'] is sent


def test_application_error_response_is_not_thrown_away(monkeypatch):
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self): return json.dumps({'success': False, 'status': 'needs_approval',
                                           'sent': False, 'spoken': 'Менеджер проверит сообщение.'}).encode()
    monkeypatch.setattr(server.urllib.request, 'urlopen', lambda *args, **kwargs: Response())
    result = server.send_followup('whatsapp', 'Материалы', True, caller_number='79990000001', instance_id=4)
    assert result['structured']['status'] == 'needs_approval'
    assert result['structured']['sent'] is False
    assert result['structured']['spoken'] == 'Менеджер проверит сообщение.'
