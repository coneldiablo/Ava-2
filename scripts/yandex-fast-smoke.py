#!/usr/bin/env python3
"""Opt-in synthetic provider conversation; no CRM, SIP dial or customer sends."""
import argparse
import asyncio
import json
import logging
import time
from types import SimpleNamespace


async def run():
    from src.config import load_config
    from src.logging_config import configure_logging
    from src.providers.yandex_fast import YandexSpeech, YandexText
    from src.providers.yandex_realtime import YandexRealtimeProvider
    configure_logging()
    logging.disable(logging.CRITICAL)
    values = load_config('/app/config/ai-agent.yaml').providers['yandex_realtime']
    values = values if isinstance(values, dict) else values.model_dump()
    config = SimpleNamespace(**dict(values, model='aliceai-llm-flash', voice='vera'))
    receipt = {'scope': 'synthetic_provider_conversation', 'customerSend': False, 'sipVerified': False,
               'model': config.model, 'voice': config.voice, 'responseMs': [], 'errors': [], 'passed': False}
    phase, first_audio, done, final = 'greeting', None, asyncio.Event(), None
    texts, audio, turns = [], 0, []
    async def event(value):
        nonlocal first_audio, final, audio
        kind = value['type']
        if kind == 'AgentAudio' and not value.get('progress'):
            first_audio = first_audio or time.monotonic()
            audio += len(value['data'])
            if turns and 'firstAudioAt' not in turns[-1]:
                turns[-1]['firstAudioAt'] = time.monotonic()
        if kind == 'agent_transcript' and not value.get('progress'):
            texts.append(value['text'])
        if kind == 'transcript' and value.get('is_final'):
            final = time.monotonic()
            turns.append({'finalAt': final})
        if kind == 'AgentAudioDone':
            # Barge-in's flush does not mean the new answer completed.
            if first_audio:
                done.set()
        if kind in ('ProviderError', 'ProviderDisconnected', 'ProviderTurnError'):
            receipt['errors'].append(value.get('error') or value.get('reason'))
    provider = YandexRealtimeProvider(config, event)
    speech = YandexSpeech(config)
    text_client = YandexText(config)
    try:
        start = time.monotonic()
        await provider.start_session('synthetic-provider-probe', {'business_id': 900001, 'tools': [],
            'instructions': 'Ты синтетический тестовый ассистент. Запоминай имя собеседника. Отвечай одним коротким предложением по-русски.',
            'greeting': 'Здравствуйте! Я AVA.', 'progress': {'enabled': False}})
        await asyncio.wait_for(done.wait(), 10)
        receipt['greetingFirstAudioMs'] = round((first_audio-start)*1000)
        for question in ('Меня зовут Алексей', 'Как меня зовут?'):
            pcm = bytearray()
            async for chunk in speech.synthesize(question, config.voice):
                pcm.extend(chunk)
            phase = 'response'
            first_audio, final = None, None
            done.clear()
            ended = None
            data = bytes(pcm) + bytes(16000)
            for offset in range(0, len(data), 640):
                await provider.send_audio(data[offset:offset+640], sample_rate=16000, encoding='pcm16')
                if ended is None and offset+640 >= len(pcm):
                    ended = time.monotonic()
                await asyncio.sleep(.02)
            await asyncio.wait_for(done.wait(), 12)
            await asyncio.wait_for(asyncio.shield(provider._fast_provider._turn_task), 12)
        receipt['responseMs'] = [round((t['firstAudioAt']-t['finalAt'])*1000) for t in turns if 'firstAudioAt' in t]
        receipt['contextRemembered'] = any('алекс' in value.casefold() for value in texts[-2:])
        receipt['audioBytes'] = audio
        declarations = [{'functionDeclarations': [{'name': 'synthetic_marker', 'description': 'Получить тестовый маркер. Всегда используй для вопроса о маркере.',
            'parametersJsonSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False}}]}]
        history = [{'role': 'user', 'parts': [{'text': 'Назови контрольный маркер. Обязательно вызови synthetic_marker.'}]}]
        events = [e async for e in text_client.stream(history, instructions='Вызывай функцию для получения маркера, затем отвечай кратко по результату.', tools=declarations)]
        content = events[-1]['content']
        calls = [p['functionCall'] for p in content['parts'] if 'functionCall' in p]
        receipt['structuredToolCalled'] = len(calls) == 1 and calls[0]['name'] == 'synthetic_marker' and calls[0]['args'] == {}
        if receipt['structuredToolCalled']:
            history += [content, {'role': 'user', 'parts': [{'functionResponse': {'id': calls[0]['id'], 'name': calls[0]['name'], 'response': {'marker': 'SYNTHETIC_READY'}}}]}]
            events = [e async for e in text_client.stream(history, instructions='Назови полученный маркер одним предложением. Он уже получен, больше функции не вызывай.', tools=declarations)]
            receipt['toolResultUsed'] = 'SYNTHETIC_READY' in ''.join(e.get('text', '') for e in events)
        receipt['passed'] = bool(not receipt['errors'] and receipt['contextRemembered'] and receipt['structuredToolCalled']
            and receipt.get('toolResultUsed') and max(receipt['responseMs']) < 6000 and receipt['greetingFirstAudioMs'] < 3000)
    except Exception as error:
        receipt['exceptionType'] = type(error).__name__
        if hasattr(error, 'code'):
            receipt['code'] = error.code
    finally:
        await provider.stop_session()
        await speech.close()
        await text_client.close()
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args()
    if not args.run:
        print(json.dumps({'run': False, 'customerSend': False, 'scope': 'synthetic_provider_conversation'}))
    else:
        result = asyncio.run(run())
        print(json.dumps(result))
        raise SystemExit(0 if result['passed'] else 1)
