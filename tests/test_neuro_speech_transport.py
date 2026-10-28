"""Contract and cleanup tests against local Neuro-shaped WebSocket servers."""
import asyncio
import base64
import json

import pytest
import pytest_asyncio
from aiohttp import web

from src.providers.neuro_speech import NeuroSpeech, NeuroSpeechError


@pytest_asyncio.fixture
async def serve():
    runners = []

    async def start(handler):
        app = web.Application()
        app.router.add_get('/{tail:.*}', handler)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        runners.append(runner)
        return f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'

    yield start
    for runner in runners:
        await runner.cleanup()


def config(url, **extra):
    return dict(neuro_api_key='local-test-key', neuro_base_url=url,
                connect_timeout=1, close_timeout=.1, tts_read_timeout=.1,
                tts_total_timeout=1, asr_read_timeout=1, **extra)


@pytest.mark.asyncio
async def test_asr_documented_wire_and_timestamp_event_are_not_duplicate_final(serve):
    observed = []
    events = []
    finished = asyncio.Event()

    async def handler(request):
        assert request.headers['xi-api-key'] == 'local-test-key'
        assert request.path == '/v1/speech-to-text/realtime'
        assert request.query['audio_format'] == 'pcm_16000'
        assert request.query['commit_strategy'] == 'vad'
        assert request.query['include_timestamps'] == 'true'
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_json({'message_type': 'session_started', 'session_id': 'test'})
        async for msg in ws:
            data = json.loads(msg.data)
            observed.append(data)
            if data['commit']:
                await ws.send_json({'message_type': 'partial_transcript', 'text': 'проверка'})
                await ws.send_json({'message_type': 'committed_transcript', 'text': 'Проверка.'})
                await ws.send_json({'message_type': 'committed_transcript_with_timestamps', 'text': 'Проверка.', 'words': [{'text': 'Проверка.', 'start': 0, 'end': .2}]})
        finished.set()
        return ws

    async def on_event(event):
        events.append(event)

    speech = NeuroSpeech(config(await serve(handler)))
    await speech.start_asr(on_event)
    assert speech._session.trust_env is False
    await speech.send_audio(b'\x01\x00' * 4000)
    await speech.commit()
    async with asyncio.timeout(1):
        while len(events) < 3:
            await asyncio.sleep(.005)
    assert [e['type'] for e in events] == ['partial', 'final', 'timestamps']
    assert [e['is_final'] for e in events] == [False, True, False]
    assert b''.join(base64.b64decode(m['audio_base_64']) for m in observed) == b'\x01\x00' * 4000
    assert all(m['message_type'] == 'input_audio_chunk' for m in observed)
    assert max(len(base64.b64decode(m['audio_base_64'])) for m in observed) <= 6400
    await speech.close()
    await speech.close()
    await asyncio.wait_for(finished.wait(), 1)
    assert speech._session is speech._asr_ws is speech._reader is None


@pytest.mark.asyncio
async def test_tts_documented_wire_pcm_alignment_and_completion(serve):
    finished = asyncio.Event()

    async def handler(request):
        assert request.path == '/v1/text-to-speech/vlad/stream-input'
        assert request.query['output_format'] == 'pcm_16000'
        assert request.query['model_id'] == 'neuro_tts_v2'
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        assert json.loads((await ws.receive()).data) == {'text': 'Проверка.', 'flush': True}
        assert json.loads((await ws.receive()).data) == {'text': ''}
        await ws.send_json({'audio': base64.b64encode(b'\x01').decode(), 'isFinal': False})
        await ws.send_json({'audio': base64.b64encode(b'\x00\x02\x00').decode(), 'isFinal': False})
        await ws.send_json({'audio': None, 'isFinal': True})
        await ws.receive()
        finished.set()
        return ws

    speech = NeuroSpeech(config(await serve(handler)))
    chunks = [chunk async for chunk in speech.synthesize('Проверка.', 'vlad')]
    assert chunks == [b'\x01\x00\x02\x00']
    assert speech.last_tts_metrics['completed'] is True
    assert speech.last_tts_metrics['first_pcm_at'] >= speech.last_tts_metrics['started_at']
    assert not speech._tts_sockets
    await speech.close()
    await asyncio.wait_for(finished.wait(), 1)


@pytest.mark.asyncio
@pytest.mark.parametrize('payload,code', [
    ({'error': 'text_too_long', 'message': 'key and private input'}, 'text_too_long'),
    ({'error': 'echoed secret local-test-key'}, 'tts_provider_error'),
])
async def test_tts_provider_errors_are_sanitized_and_close(serve, payload, code):
    async def handler(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.receive()
        await ws.receive()
        await ws.send_json(payload)
        await ws.receive()
        return ws

    speech = NeuroSpeech(config(await serve(handler)))
    try:
        with pytest.raises(NeuroSpeechError, match=code) as caught:
            _ = [chunk async for chunk in speech.synthesize('Проверка.', 'vlad')]
        assert str(caught.value) == code
        assert not speech._tts_sockets
    finally:
        await speech.close()


@pytest.mark.asyncio
async def test_tts_timeout_and_cancellation_close_upstream(serve):
    closed = asyncio.Queue()

    async def handler(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        async for _ in ws:
            pass
        await closed.put(True)
        return ws

    url = await serve(handler)
    speech = NeuroSpeech(config(url))
    with pytest.raises(NeuroSpeechError, match='tts_timeout'):
        _ = [chunk async for chunk in speech.synthesize('Проверка.', 'vlad')]
    assert await asyncio.wait_for(closed.get(), 1)
    assert not speech._tts_sockets

    async def consume():
        return [chunk async for chunk in speech.synthesize('Проверка.', 'vlad')]

    task = asyncio.create_task(consume())
    async with asyncio.timeout(1):
        while not speech._tts_sockets:
            await asyncio.sleep(.005)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await asyncio.wait_for(closed.get(), 1)
    assert not speech._tts_sockets
    assert speech.last_tts_metrics['cancelled'] is True
    await speech.close()


@pytest.mark.asyncio
async def test_truncated_tts_is_failure(serve):
    async def handler(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.receive()
        await ws.receive()
        await ws.send_json({'audio': 'AQABAA==', 'isFinal': False})
        await ws.close()
        return ws

    speech = NeuroSpeech(config(await serve(handler)))
    try:
        with pytest.raises(NeuroSpeechError, match='tts_incomplete_stream'):
            _ = [chunk async for chunk in speech.synthesize('Проверка.', 'vlad')]
        assert speech.last_tts_metrics['completed'] is False
    finally:
        await speech.close()


@pytest.mark.asyncio
async def test_failed_asr_auth_closes_all_resources_without_echo(serve):
    async def handler(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_json({'message_type': 'auth_error', 'error': 'invalid_api_key', 'message': 'private echoed input'})
        await ws.close()
        return ws

    speech = NeuroSpeech(config(await serve(handler)))
    with pytest.raises(NeuroSpeechError, match='invalid_api_key'):
        await speech.start_asr(lambda event: None)
    assert speech._session is speech._asr_ws is None


@pytest.mark.asyncio
async def test_asr_reader_error_event_safe_and_connection_closed(serve):
    events = []

    async def handler(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_json({'message_type': 'session_started'})
        await ws.send_json({'message_type': 'transcriber_error', 'error': 'echoed credential'})
        await ws.receive()
        return ws

    speech = NeuroSpeech(config(await serve(handler)))
    try:
        await speech.start_asr(events.append)
        async with asyncio.timeout(1):
            while not events:
                await asyncio.sleep(.005)
        assert events[0]['code'] == 'asr_provider_error'
        with pytest.raises(NeuroSpeechError, match='asr_provider_error'):
            await speech.send_audio(b'\x00\x00')
    finally:
        await speech.close()


def test_config_aliases_and_preflight_validation():
    speech = NeuroSpeech({'api_key': 'test', 'endpoint': 'https://speech.neuro.net',
                          'provider_input_sample_rate_hz': 8000, 'vad_silence_ms': 700,
                          'session_timeout_seconds': 2, 'asr_timeout_seconds': 7, 'tts_timeout_seconds': 3})
    assert speech.sample_rate == 8000 and speech.silence_seconds == .7
    assert (speech.connect_timeout, speech.asr_read_timeout, speech.tts_read_timeout) == (2, 7, 3)
    for overrides, code in [({'endpoint': 'http://remote.example'}, 'invalid_endpoint'),
                            ({'provider_input_sample_rate_hz': 24000}, 'unsupported_sample_rate'),
                            ({'vad_silence_ms': 1}, 'invalid_vad_silence')]:
        with pytest.raises(NeuroSpeechError, match=code):
            NeuroSpeech(overrides)


@pytest.mark.asyncio
async def test_closing_tts_iterator_while_suspended_at_yield_closes_socket(serve):
    closed = asyncio.Event()

    async def handler(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.receive()
        await ws.receive()
        await ws.send_json({'audio': 'AQABAA==', 'isFinal': False})
        async for _ in ws:
            pass
        closed.set()
        return ws

    speech = NeuroSpeech(config(await serve(handler)))
    stream = speech.synthesize('Проверка.', 'vlad')
    assert await anext(stream) == b'\x01\x00\x01\x00'
    assert len(speech._tts_sockets) == 1
    await stream.aclose()
    assert not speech._tts_sockets
    await asyncio.wait_for(closed.wait(), 1)
    await speech.close()


@pytest.mark.asyncio
async def test_tts_audio_limit_is_bounded_failure(serve):
    async def handler(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.receive()
        await ws.receive()
        await ws.send_json({'audio': base64.b64encode(b'\0' * 6).decode(), 'isFinal': True})
        await ws.receive()
        return ws

    speech = NeuroSpeech(config(await serve(handler), max_tts_audio_bytes=4))
    try:
        with pytest.raises(NeuroSpeechError, match='tts_audio_limit_exceeded'):
            _ = [chunk async for chunk in speech.synthesize('Проверка.', 'vlad')]
        assert not speech._tts_sockets
    finally:
        await speech.close()


@pytest.mark.parametrize('code', ['concurrency_limit_exceeded', 'rate_limit_exceeded'])
@pytest.mark.parametrize('envelope', ['string', 'code', 'nested', 'detail'])
def test_documented_limits_keep_safe_code_instead_of_auth_or_generic_error(code, envelope):
    payload = {'error': code} if envelope == 'string' else {'code': code} if envelope == 'code' else {'error': {'code': code, 'message': 'private upstream text'}} if envelope == 'nested' else {'detail': {'status': code, 'message': 'private upstream text'}}
    assert NeuroSpeech._error_code(payload, 'asr_auth_failed') == code
    assert NeuroSpeech._error_code(payload, 'tts_provider_error') == code


@pytest.mark.asyncio
async def test_tts_busy_before_audio_retries_admission_once_and_returns_real_audio(serve):
    attempts = []
    async def handler(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.receive(); await ws.receive()
        attempts.append(len(attempts)+1)
        if len(attempts) == 1:
            await ws.send_json({'error': 'concurrency_limit_exceeded'})
        else:
            await ws.send_json({'audio': base64.b64encode(b'\x01\x00'*160).decode(), 'isFinal': True})
        await ws.receive()
        return ws
    settings=config(await serve(handler));settings['tts_total_timeout']=3
    speech=NeuroSpeech(settings)
    try:
        pcm=b''.join([chunk async for chunk in speech.synthesize('Проверка.', 'vlad')])
        assert pcm==b'\x01\x00'*160
        assert len(attempts)==2 and speech.last_tts_metrics['admission_retries']==1
        assert not speech._tts_sockets
    finally:
        await speech.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('partial', [False, True])
async def test_tts_admission_refusal_is_bounded_and_never_replays_partial_audio(serve, partial):
    attempts=[]
    async def handler(request):
        ws=web.WebSocketResponse();await ws.prepare(request)
        await ws.receive();await ws.receive();attempts.append(1)
        if partial:
            await ws.send_json({'audio':base64.b64encode(b'\x01\x00'*160).decode(),'isFinal':False})
        await ws.send_json({'error':'concurrency_limit_exceeded'})
        await ws.receive();return ws
    settings=config(await serve(handler));settings['tts_total_timeout']=3
    speech=NeuroSpeech(settings);audio=[]
    try:
        with pytest.raises(NeuroSpeechError,match='concurrency_limit_exceeded'):
            async for chunk in speech.synthesize('Проверка.', 'vlad'):audio.append(chunk)
        assert len(attempts)==(1 if partial else 3)
        assert b''.join(audio)==(b'\x01\x00'*160 if partial else b'')
        assert not speech._tts_sockets
    finally:
        await speech.close()


@pytest.mark.asyncio
async def test_tts_busy_retry_wait_obeys_original_total_timeout(serve):
    attempts=[]
    async def handler(request):
        ws=web.WebSocketResponse();await ws.prepare(request)
        await ws.receive();await ws.receive();attempts.append(1)
        await ws.send_json({'error':'concurrency_limit_exceeded'})
        await ws.receive();return ws
    settings=config(await serve(handler));settings['tts_total_timeout']=.1
    speech=NeuroSpeech(settings)
    try:
        with pytest.raises(NeuroSpeechError,match='tts_timeout'):
            _=[chunk async for chunk in speech.synthesize('Проверка.', 'vlad')]
        assert len(attempts)==1 and not speech._tts_sockets
    finally:
        await speech.close()


@pytest.mark.asyncio
async def test_hangup_during_tts_admission_wait_never_opens_retry_socket(serve):
    refused=asyncio.Event();attempts=[]
    async def handler(request):
        ws=web.WebSocketResponse();await ws.prepare(request)
        await ws.receive();await ws.receive();attempts.append(1)
        await ws.send_json({'error':'concurrency_limit_exceeded'});refused.set()
        await ws.receive();return ws
    settings=config(await serve(handler));settings['tts_total_timeout']=3
    speech=NeuroSpeech(settings)
    async def consume():return [chunk async for chunk in speech.synthesize('Проверка.', 'vlad')]
    task=asyncio.create_task(consume())
    await asyncio.wait_for(refused.wait(),1);await asyncio.sleep(.02);task.cancel()
    with pytest.raises(asyncio.CancelledError):await task
    assert len(attempts)==1 and not speech._tts_sockets
    await speech.close()
