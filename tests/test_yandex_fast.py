import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from src.providers.yandex_fast import YandexFastError, YandexFastProvider, YandexSpeech, YandexText
from src.providers.yandex_realtime import YandexRealtimeProvider


def config(**kwargs):
    return SimpleNamespace(api_key="test-key", folder_id="test-folder", model="aliceai-llm-flash",
                           voice="vera", role="support", **kwargs)


class Lines:
    def __init__(self, frames):
        self.frames = frames

    def __aiter__(self):
        async def iterate():
            for delta, finish in self.frames:
                yield b"data: " + json.dumps({"choices": [{"delta": delta, "finish_reason": finish}]}).encode() + b"\n"
            yield b"data: [DONE]\n"
        return iterate()


class Response:
    status = 200

    def __init__(self, frames):
        self.content = Lines(frames)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        pass


@pytest.mark.asyncio
async def test_rate_limit_retries_only_rejected_request_and_is_bounded():
    client = YandexText(config())
    rejected = SimpleNamespace(status=429, release=lambda: None)
    client.http = SimpleNamespace(post=AsyncMock(side_effect=[rejected, Response([({'content': 'готово'}, 'stop')])]))
    with patch('src.providers.yandex_fast.asyncio.sleep', new=AsyncMock()):
        events = [e async for e in client.stream([])]
    assert client.http.post.await_count == 2
    assert events[-1]['content']['parts'] == [{'text': 'готово'}]


@pytest.mark.asyncio
async def test_streaming_tool_arguments_roundtrip_with_exact_id():
    client = YandexText(config())
    client.http = SimpleNamespace(post=AsyncMock(return_value=Response([
        ({"tool_calls": [{"index": 0, "id": "action-1", "function": {"name": "lookup", "arguments": '{"x":'}}]}, None),
        ({"tool_calls": [{"index": 0, "function": {"arguments": "7}"}}]}, "tool_calls"),
    ])))
    events = [e async for e in client.stream([{"role": "user", "parts": [{"text": "question"}]}])]
    content = events[-1]["content"]
    assert content["parts"][0]["functionCall"] == {"id": "action-1", "name": "lookup", "args": {"x": 7}}
    history = [content, {"role": "user", "parts": [{"functionResponse": {"id": "action-1", "name": "lookup", "response": {"status": "ok"}}}]}]
    messages = client.messages(history, "tenant instructions")
    assert messages[0]["content"] == "tenant instructions"
    assert messages[1]["tool_calls"][0]["id"] == messages[2]["tool_call_id"] == "action-1"
    assert client.http.post.call_args.kwargs["json"]["max_tokens"] == 512


@pytest.mark.asyncio
@pytest.mark.parametrize("frames", [
    [({"tool_calls": [{"index": 0, "id": "x", "function": {"name": "lookup", "arguments": "{\"x\":NaN}"}}]}, "tool_calls")],
    [({"tool_calls": [{"index": 0, "id": "x", "function": {"name": "lookup", "arguments": "{}"}}]}, "length")],
    [({"content": "partial"}, None)],
])
async def test_incomplete_or_invalid_generation_never_yields_executable_content(frames):
    client = YandexText(config())
    client.http = SimpleNamespace(post=AsyncMock(return_value=Response(frames)))
    seen = []
    with pytest.raises((YandexFastError, ValueError)):
        async for event in client.stream([]):
            seen.append(event)
    assert all(e["type"] != "content" for e in seen)


@pytest.mark.asyncio
async def test_real_speech_commit_is_ordered_and_hot_path_does_not_wait_for_http():
    speech = YandexSpeech(config())
    speech.callback = AsyncMock()
    voiced = (1000).to_bytes(2, "little", signed=True) * 320
    for _ in range(10):
        await speech.send_audio(voiced)
    for _ in range(23):
        await speech.send_audio(bytes(640))
    audio, final = speech.queue.get_nowait()
    assert final and voiced in audio
    assert speech.http is None
    assert speech.callback.call_args.args[0]["type"] == "speech_started"
    assert speech.buffer == b""
    assert not speech.active
    await speech.commit()
    assert speech.queue.empty()
    await speech.close()


@pytest.mark.asyncio
async def test_missing_silence_packets_flush_by_wall_clock_and_timer_is_cleaned_up():
    speech = YandexSpeech(config())
    speech.callback = AsyncMock()
    speech.idle_worker = asyncio.create_task(speech._flush_idle())
    await speech.send_audio((1500).to_bytes(2, 'little', signed=True)*3200)
    speech.last_audio_at -= 1
    await asyncio.sleep(.12)
    audio, final = speech.queue.get_nowait()
    assert audio and final and not speech.active
    await speech.close()
    assert speech.idle_worker.done()


@pytest.mark.asyncio
async def test_delegate_preserves_business_guard_executor_and_selected_voice():
    native = YandexRealtimeProvider(config(), AsyncMock())
    assert native.get_capabilities().requires_continuous_audio
    assert not native.get_capabilities().has_native_vad
    native._business_id = 19
    native._voice_tool_guard = object()
    native.set_input_mode("pcm16_16k")
    fake = SimpleNamespace(start_session=AsyncMock(), stop_session=AsyncMock(), send_audio=AsyncMock(), cancel_response=AsyncMock(), set_input_mode=lambda mode: None)
    executor = AsyncMock()
    with patch("src.providers.yandex_fast.YandexFastProvider", return_value=fake):
        await native.start_session("call", {"business_id": 19, "tool_executor": executor})
    assert fake._business_id == 19 and fake._voice_tool_guard is native._voice_tool_guard
    assert fake.start_session.call_args.args[1]["tool_executor"] is executor
    await native.send_audio(b"12", sample_rate=16000, encoding="pcm16")
    fake.send_audio.assert_awaited_once()
    await native.cancel_response()
    fake.cancel_response.assert_awaited_once()
    await native.stop_session()
    fake.stop_session.assert_awaited_once()


@pytest.mark.asyncio
async def test_fast_provider_uses_yandex_voice_and_noise_does_not_cancel_generation():
    events = []
    provider = YandexFastProvider(config(), events.append)
    provider._closing = False
    assert provider.is_ready()
    assert provider._cfg("voice_name") == "vera"
    assert provider._cfg("model_timeout_seconds") == 8
    await provider._on_asr({"type": "speech_started"})
    assert not provider._speech_committed.is_set()
    await provider._on_asr({"type": "speech_empty"})
    assert provider._speech_committed.is_set()
    assert not events

@pytest.mark.asyncio
async def test_empty_incomplete_tool_generation_retries_once_before_any_output(monkeypatch):
    from src.providers.yandex_fast import YandexText, YandexFastError
    text = YandexText(SimpleNamespace())
    calls = []
    async def generate(*args):
        calls.append(1)
        if len(calls) == 1:
            raise YandexFastError('yandex_text_incomplete')
        yield {'type': 'content', 'content': {'role': 'model', 'parts': [{'functionCall': {'id': 'f', 'name': 'send', 'args': {}}}]}}
    monkeypatch.setattr(text, '_stream_once', generate)
    events = [event async for event in text.stream([])]
    assert len(calls) == 2 and len(events) == 1


@pytest.mark.asyncio
async def test_partial_speech_and_repeated_incomplete_generations_are_not_retried_unbounded(monkeypatch):
    from src.providers.yandex_fast import YandexText, YandexFastError
    text = YandexText(SimpleNamespace())
    calls = []
    async def generate(*args):
        calls.append(1)
        yield {'type': 'text', 'text': 'Часть ответа'}
        raise YandexFastError('yandex_text_incomplete')
    monkeypatch.setattr(text, '_stream_once', generate)
    with pytest.raises(YandexFastError):
        _ = [event async for event in text.stream([])]
    assert len(calls) == 1
    calls.clear()
    async def empty(*args):
        calls.append(1)
        raise YandexFastError('yandex_text_incomplete')
        yield
    monkeypatch.setattr(text, '_stream_once', empty)
    with pytest.raises(YandexFastError):
        _ = [event async for event in text.stream([])]
    assert len(calls) == 2
