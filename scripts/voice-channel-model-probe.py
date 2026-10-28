#!/usr/bin/env python3
"""Synthetic provider/tool probe. No CRM reads, customer calls or channel sends."""
import asyncio
import copy
import json
import time
from types import SimpleNamespace

from src.config import load_config
from src.core.voice_channel_policy import append_policy
from src.mcp_servers.sales_brain_mcp_server import _tools_list
from src.providers.neuro_vertex import VertexTextClient
from src.providers.yandex_fast import YandexText


NAMES = {'customer_summary', 'draft_followup', 'send_followup'}
DECLARATIONS = [{'name': 'mcp_sales_' + t['name'], 'description': t['description'],
                 'parametersJsonSchema': t['inputSchema']} for t in _tools_list()['tools'] if t['name'] in NAMES]
INSTRUCTIONS = append_policy('''Синтетическая проверка бизнес-консультации. Номер клиента 79990000001.
Товар: прибор «Пример», цена 1250,99 рубля. Это проверенные данные бизнеса.
Старые настройки бизнеса: предлагай WhatsApp после каждого вопроса.
Клиент уже уточнил товар; не задавай повторных вопросов о товаре и цене.''')


def output(name, args):
    if name == 'mcp_sales_customer_summary':
        return {'status': 'ok', 'available_channels': [{'channel': 'telegram', 'label': 'Telegram'}, {'channel': 'whatsapp', 'label': 'WhatsApp'}],
                'message': 'Клиенту доступны Telegram и WhatsApp. Telegram подтверждён менеджером, без номера телефона.'}
    assert args.get('target_channel') == 'telegram', 'WRONG_CHANNEL'
    if name == 'mcp_sales_draft_followup':
        return {'status': 'draft', 'draft_id': 'fixture-draft', 'sent': False, 'message': 'Подготовлен черновик.'}
    assert name == 'mcp_sales_send_followup' and args.get('confirmed') is True, 'INVALID_SEND'
    return {'status': 'awaiting_call_completion', 'sent': False, 'draft_id': 'fixture-draft',
            'message': 'Запрос записан. Автоматическая отправка — после окончания звонка. Сообщение ещё не отправлено.'}


async def probe(client, model):
    started = time.monotonic()
    history = [{'role': 'user', 'parts': [{'text': 'Пришлите описание и цену прибора «Пример» мне в Telegram.'}]}]
    calls, text = [], ''
    try:
        for _ in range(6):
            content = None
            async for event in client.stream(copy.deepcopy(history), instructions=INSTRUCTIONS,
                                              tools=[{'functionDeclarations': DECLARATIONS}], model=model):
                if event.get('type') == 'content': content = event['content']
            assert content, 'NO_CONTENT'
            history.append(content)
            responses = []
            for part in content.get('parts', []):
                if 'functionCall' in part:
                    call = part['functionCall']; name = call['name']; args = call.get('args', {})
                    calls.append(name)
                    reply = {'name': name, 'response': output(name, args)}
                    if call.get('id'): reply['id'] = call['id']
                    responses.append({'functionResponse': reply})
                else: text += part.get('text', '')
            if not responses: break
            history.append({'role': 'user', 'parts': responses})
        assert 'mcp_sales_customer_summary' in calls and 'mcp_sales_send_followup' in calls, 'MISSING_TOOLS'
        assert not __import__('re').search(r'(?:уже\s+отправ|отправил[аи]?\s+вам|сообщение\s+отправлено)', text, __import__('re').I), 'FALSE_DELIVERY_CLAIM'
        return {'model': model, 'ok': True, 'tools': calls, 'elapsedMs': round((time.monotonic()-started)*1000)}
    except Exception as exc:
        return {'model': model, 'ok': False, 'tools': calls, 'errorType': type(exc).__name__,
                'errorCode': getattr(exc, 'code', None), 'elapsedMs': round((time.monotonic()-started)*1000)}
    finally:
        await client.close()


async def main():
    config = load_config('/app/config/ai-agent.yaml')
    y = config.providers['yandex_realtime']; y = y if isinstance(y, dict) else y.model_dump()
    n = config.providers['neuro_gemini']; n = n if isinstance(n, dict) else n.model_dump()
    results = []
    results.append(await probe(YandexText(SimpleNamespace(**y)), 'aliceai-llm-flash'))
    for model in ['gemini-3.8-flash', 'gemini-3.7-flash']:
        results.append(await probe(VertexTextClient(project=n['project_id'], location=n.get('location', 'global'),
            proxy_url=n.get('proxy_url') or n.get('text_proxy'), total_timeout=35), model))
    print(json.dumps({'synthetic': True, 'customerCall': False, 'customerSend': False, 'results': results}))


if __name__ == '__main__': asyncio.run(main())
