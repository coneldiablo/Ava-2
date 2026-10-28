#!/usr/bin/env python3
"""Bounded isolated 1/3/5 AudioSocket -> real Neuro/Vertex/Neuro probe.

Run via docker exec -i ai_engine python - < this file. Only inherited credentials
are used; no live Engine, ARI, CRM or customer records are instantiated. One
shared synthetic input TTS, <=9 ASR sessions, <=27 model rounds, <=4 tool calls
per session. The only tool is a process-local, read-only constant health check.
No transcript, credentials, provider body, or audio is printed or saved.
"""
import asyncio
import audioop
import contextlib
import copy
import json
import logging
import os
import time
import uuid
import sys
from collections import Counter
from pathlib import Path

logging.disable(logging.CRITICAL)
import structlog
structlog.configure(logger_factory=structlog.stdlib.LoggerFactory())
from src.audio.audiosocket_server import AudioSocketServer
from src.providers.neuro_gemini import NeuroGeminiProvider
from src.providers.neuro_speech import NeuroSpeech
from src.tools.base import Tool, ToolDefinition, ToolCategory
from src.tools.registry import tool_registry


class SyntheticHealth(Tool):
    @property
    def definition(self):
        return ToolDefinition(name='synthetic_health', description='Read-only synthetic connection check. No customer data or side effects.',
                              category=ToolCategory.BUSINESS, parameters=[], max_execution_time=2)

    async def execute(self, parameters, context):
        assert context.business_id == 999999
        await asyncio.sleep(.03)
        return {'status': 'success', 'healthy': True}


def rss_kib():
    return int(Path('/proc/self/status').read_text().split('VmRSS:')[1].split()[0])


def safe_failure(exc):
    import re
    code = getattr(exc, 'code', None)
    return {'class': type(exc).__name__, 'code': code if isinstance(code, str) and re.fullmatch('[a-z_]{1,64}', code) else None}


def cfg():
    return dict(api_key=os.environ.get('NEURO_API_KEY', ''), project_id=os.environ.get('GEMINI_PROJECT_ID', os.environ.get('GOOGLE_CLOUD_PROJECT', '')),
                endpoint=os.environ.get('NEURO_API_ENDPOINT', 'https://speech.neuro.net'),
                location=os.environ.get('GEMINI_LOCATION', 'global'), model='gemini-3.8-flash', thinking_level='LOW', voice_name='edsel',
                proxy_url=os.environ.get('GEMINI_TEXT_PROXY_URL') or None,
                input_encoding='pcm16', input_sample_rate_hz=8000, target_encoding='pcm16', target_sample_rate_hz=8000,
                session_timeout_seconds=10, asr_timeout_seconds=35, tts_timeout_seconds=15,
                model_timeout_seconds=35, chunk_timeout_seconds=12, turn_timeout_seconds=70,
                max_tool_rounds=3, max_tool_calls=4, vad_silence_ms=500, progress_after_seconds=5)


async def batch(size, audio, settings):
    providers, records, ids, resources = {}, {}, {}, []
    started = time.monotonic()
    before_rss = rss_kib()
    cpu = time.process_time()
    peak_rss, peak_tasks, peak_pending, lag = before_rss, 0, 0, []
    observing = True

    async def observe():
        nonlocal peak_rss, peak_tasks, peak_pending
        while observing:
            tick = time.monotonic()
            await asyncio.sleep(.02)
            lag.append(max(0, (time.monotonic() - tick - .02) * 1000))
            peak_rss = max(peak_rss, rss_kib())
            peak_tasks = max(peak_tasks, len(asyncio.all_tasks()))
            peak_pending = max(peak_pending, sum(bool(p._turn_task and not p._turn_task.done()) for p in providers.values()))

    async def on_uuid(conn, ident):
        rec = records[ident]
        rec['connected_at'] = time.monotonic()
        rec['conn'] = conn
        async def event(e):
            kind = e.get('type')
            rec['events'][kind] += 1
            if kind == 'AgentAudio':
                if not e.get('progress'):
                    rec.setdefault('answer_audio_at', time.monotonic())
                    rec['answer_audio_bytes'] += len(e.get('data', b''))
                await server.send_audio(conn, e.get('data', b''))
            elif kind in ('AgentAudioDone', 'ProviderError', 'ProviderDisconnected'):
                if kind != 'AgentAudioDone':
                    import re
                    reason = e.get('error', e.get('reason'))
                    rec['failure_reason'] = reason if isinstance(reason, str) and re.fullmatch('[a-z_]{1,96}', reason) else 'unclassified'
                rec['done'].set()
            elif kind == 'ProviderTurnError':
                import re
                reason = e.get('error')
                rec['turn_failure_reason'] = reason if isinstance(reason, str) and re.fullmatch('[a-z_]{1,96}', reason) else 'unclassified'
        provider = NeuroGeminiProvider(settings, event)
        providers[conn] = provider
        try:
            await provider.start_session('synthetic-capacity-' + ident, {
            'business_id': 999999, 'greeting': '', 'tools': ['synthetic_health'],
            'instructions': 'Это синтетическая проверка. Вызови synthetic_health ровно один раз, затем кратко скажи: Проверка прошла. Не задавай вопросов. Других действий нет.',
            })
        except Exception as exc:
            rec['startup_failure'] = safe_failure(exc)
            raise
        resources.append((provider._speech, provider._vertex))
        vertex = provider._vertex
        original_stream = vertex.stream
        rec['model_requests'] = []
        async def traced_stream(*args, **kwargs):
            entry = {'round': len(rec['model_requests']), 'history_messages': len(args[0]) if args else 0}
            rec['model_requests'].append(entry)
            tick = time.monotonic()
            try:
                async with contextlib.aclosing(original_stream(*args, **kwargs)) as stream:
                    async for event in stream:
                        yield event
            except Exception as exc:
                entry['failure'] = safe_failure(exc)
                raise
            finally:
                entry['elapsed_ms'] = round((time.monotonic() - tick)*1000, 1)
                entry['transport'] = copy.deepcopy(getattr(vertex, 'last_request_metrics', {}))
        vertex.stream = traced_stream
        ids[conn] = ident
        return True

    async def on_audio(conn, payload):
        await providers[conn].send_audio(payload, sample_rate=8000, encoding='pcm16')

    async def on_disconnect(conn):
        if conn in providers:
            await providers[conn].stop_session()

    server = AudioSocketServer('127.0.0.1', 0, on_uuid=on_uuid, on_audio=on_audio, on_disconnect=on_disconnect)
    await server.start()
    monitor = asyncio.create_task(observe())

    async def session():
        ident = str(uuid.uuid4())
        rec = records[ident] = {'events': Counter(), 'done': asyncio.Event(), 'answer_audio_bytes': 0, 'wire_bytes': 0}
        writer = receiver = None
        try:
            async with asyncio.timeout(85):
                reader, writer = await asyncio.open_connection('127.0.0.1', server.port)
                async def receive():
                    while True:
                        header = await reader.readexactly(3)
                        data = await reader.readexactly(int.from_bytes(header[1:], 'big'))
                        if header[0] == 0x10:
                            rec['wire_bytes'] += len(data)
                receiver = asyncio.create_task(receive())
                writer.write(b'\x01\x00\x10' + uuid.UUID(ident).bytes)
                await writer.drain()
                # Allow ASR startup; TCP buffers only bounded fixed synthetic input.
                for offset in range(0, len(audio) + 16000, 320):
                    payload = audio[offset:offset + 320] if offset < len(audio) else bytes(320)
                    payload = payload.ljust(320, b'\0')
                    writer.write(b'\x10\x01\x40' + payload)
                    await writer.drain()
                    await asyncio.sleep(.02)
                rec['input_end_at'] = time.monotonic()
                await rec['done'].wait()
                provider = providers.get(rec.get('conn'))
                if provider and provider._turn_task:
                    try:
                        await asyncio.shield(provider._turn_task)
                    except asyncio.CancelledError:
                        if asyncio.current_task().cancelling():
                            raise
                        rec['turn_cancelled_by_provider'] = True
                await asyncio.sleep(.1)
                metrics = provider.last_turn_metrics if provider else {}
                rec['stage_ms'] = {name: round((metrics[name] - metrics['asr_final_at']) * 1000, 1)
                                   for name in ('first_model_text_at', 'first_pcm_at', 'first_audio_emitted_at')
                                   if name in metrics and 'asr_final_at' in metrics}
                rec['tool_results'] = Counter(str(v.get('status')) for v in provider._tool_ledger.values()) if provider else {}
                rec['pass'] = bool(rec['answer_audio_bytes'] and rec['wire_bytes'] and rec['events']['AgentAudioDone']
                                   and metrics.get('first_audio_emitted_at') and rec['tool_results'].get('success') == 1
                                   and not any(rec['events'][key] for key in ('ProviderError', 'ProviderDisconnected', 'ProviderTurnError')))
        except Exception as exc:
            rec['failure'] = safe_failure(exc)
            rec['pass'] = False
        finally:
            if writer:
                writer.close()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(writer.wait_closed(), 2)
            if receiver:
                receiver.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await receiver

    try:
        await asyncio.gather(*(session() for _ in range(size)))
    finally:
        cleanup_start = time.monotonic()
        await asyncio.wait_for(server.stop(), 12)
        for provider in providers.values():
            await asyncio.wait_for(provider.stop_session(), 8)
        observing = False
        await monitor
        await asyncio.sleep(.05)
    cleaned = {'connections': len(server._writers), 'readers': len(server._connection_tasks),
               'uuid_bindings': len(server._conn_to_uuid), 'first_audio_markers': len(server._first_audio_logged),
               'provider_tasks': sum(len(p._background) + len(p._tool_batches) + int(p._turn_task is not None) for p in providers.values()),
               'asr_sockets': sum(int(s._asr_ws is not None) for s, v in resources),
               'tts_sockets': sum(len(s._tts_sockets) for s, v in resources),
               'vertex_responses': sum(len(v._responses) for s, v in resources)}
    results = [{k: dict(v) if isinstance(v, Counter) else v for k, v in rec.items()
                if k in ('events', 'answer_audio_bytes', 'wire_bytes', 'stage_ms', 'tool_results', 'pass', 'failure', 'startup_failure', 'failure_reason', 'turn_failure_reason', 'model_requests', 'turn_cancelled_by_provider')}
               for rec in records.values()]
    return {'concurrency': size, 'sessions': results, 'all_turns_pass': all(rec.get('pass') for rec in records.values()),
            'elapsed_ms': round((time.monotonic() - started) * 1000), 'cpu_seconds': round(time.process_time() - cpu, 3),
            'rss_kib': {'before': before_rss, 'peak': peak_rss, 'after': rss_kib()}, 'peak_tasks': peak_tasks, 'peak_pending_turns': peak_pending,
            'event_loop_lag_ms': {'p95': round(sorted(lag)[int(len(lag)*.95)], 2), 'max': round(max(lag), 2)},
            'cleanup_ms': round((time.monotonic()-cleanup_start)*1000), 'retained': cleaned}


async def main():
    tool_registry.register(SyntheticHealth)
    report = {'level': 'live_provider_isolated_synthetic', 'carrier': 'NOT_TESTED', 'customer_acceptance': 'NOT_TESTED',
              'production_runtime_mutated': False, 'max_sessions': 9, 'max_model_requests': 27, 'batches': []}
    settings = cfg()
    source = NeuroSpeech(settings)
    try:
        async with asyncio.timeout(380):
            audio = b''.join([chunk async for chunk in source.synthesize('Выполни проверку соединения.', 'edsel')])
            await source.close()
            audio, _ = audioop.ratecv(audio, 2, 1, 16000, 8000, None)
            if not 320 <= len(audio) <= 16000 * 12:
                raise ValueError('synthetic_audio_limit')
            report['input_pcm_bytes'] = len(audio)
            sizes = tuple(int(v) for v in sys.argv[1:]) if sys.argv[1:] else (1, 3, 5)
            if not sizes or any(v not in (1, 3, 5) for v in sizes) or sum(sizes) > 9:
                raise ValueError('invalid_capacity_sizes')
            for size in sizes:
                report['batches'].append(await batch(size, audio, settings))
    except Exception as exc:
        report['failure'] = safe_failure(exc)
    finally:
        await source.close()
    report['remaining_tasks'] = len([t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()])
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    asyncio.run(main())
