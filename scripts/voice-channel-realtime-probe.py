#!/usr/bin/env python3
"""Real Yandex Realtime transport, synthetic MCP outputs, no customer side effects."""
import asyncio
import json
import runpy
import time
from types import SimpleNamespace

from src.config import load_config
from src.mcp_servers.sales_brain_mcp_server import _voice_result
from src.providers.yandex_realtime import YandexRealtimeProvider
from src.tools.mcp_tool import MCPTool, MCPToolBehavior
from src.tools.registry import tool_registry


async def main():
    helper = runpy.run_path('/tmp/model-probe.py')
    value = load_config('/app/config/ai-agent.yaml').providers['yandex_realtime']
    value = value if isinstance(value, dict) else value.model_dump()
    value.update(model='speech-realtime-max-tts-live/latest')
    calls, after_send_audio, trace = [], 0, []
    done = asyncio.Event()
    started = time.monotonic()

    class Manager:
        async def call_tool(self, **args):
            name = 'mcp_sales_' + args['tool_name']
            reply = helper['output'](name, args['arguments'])
            calls.append(name)
            return _voice_result(reply.pop('message'), **reply)

    for decl in helper['DECLARATIONS']:
        tool_registry.register_instance(MCPTool(exposed_name=decl['name'], server_id='synthetic',
            mcp_tool_name=decl['name'].removeprefix('mcp_sales_'), description=decl['description'],
            input_schema=decl['parametersJsonSchema'], manager=Manager(), behavior=MCPToolBehavior(speech_field='spoken')))

    async def emit(event):
        nonlocal after_send_audio
        if 'mcp_sales_send_followup' in calls and event['type'] == 'AgentAudio':
            after_send_audio += len(event.get('data', b''))
        if event['type'] == 'AgentAudioDone' and after_send_audio: done.set()
        if event['type'] in {'ProviderDisconnected', 'ProviderError'}: done.set()

    provider = YandexRealtimeProvider(SimpleNamespace(**value), emit)
    provider._business_id = 999999
    provider._caller_number = '79990000001'
    original_handler = provider._handle_event
    async def traced(event):
        if event.get('type') in {'response.created', 'response.done', 'response.output_item.done', 'error'}:
            trace.append({'event':event['type'], 'ms':round((time.monotonic()-started)*1000),
                'status':event.get('response',{}).get('status'), 'itemType':event.get('item',{}).get('type'),
                'errorCode':event.get('error',{}).get('code'), 'errorMessage':str(event.get('error',{}).get('message','')).replace(value['api_key'],'[key]').replace(value['folder_id'],'[folder]')[:500]})
        await original_handler(event)
    provider._handle_event = traced
    result = {'model': value['model'], 'synthetic': True, 'customerCall': False, 'customerSend': False}
    try:
        await provider.start_session('synthetic-channel-proof', {'greeting': '', 'instructions': helper['INSTRUCTIONS'],
            'tools': [d['name'] for d in helper['DECLARATIONS']]})
        await provider._send({'type':'conversation.item.create', 'item':{'type':'message','role':'user',
            'content':[{'type':'input_text','text':'Пришлите описание и цену прибора «Пример» в Telegram.'}]}})
        await provider._send({'type':'response.create'})
        await asyncio.wait_for(done.wait(), timeout=140)
        result.update(ok=bool(after_send_audio) and 'mcp_sales_customer_summary' in calls and 'mcp_sales_send_followup' in calls,
                      tools=calls, afterSendAudioBytes=after_send_audio)
    except Exception as exc:
        result.update(ok=False, tools=calls, errorType=type(exc).__name__)
    finally:
        await provider.stop_session()
    result['trace'] = trace
    result['groups'] = [{'pending':len(g['pending']), 'done':g['done'], 'continued':g['continued']} for g in provider._tool_groups.values()]
    result['elapsedMs'] = round((time.monotonic()-started)*1000)
    print(json.dumps(result))


if __name__ == '__main__': asyncio.run(main())
