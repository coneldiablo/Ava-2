"""LiveTTS default ACKs must never select a different speaker for a call."""
import asyncio
import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import aiohttp
import pytest

from src.providers.yandex_fast import YandexFastError, YandexSpeech
from src.providers.yandex_realtime import YandexRealtimeProvider


PCM = b"\x01\x00" * 480


def output(voice="sofia", role="support", rate=None):
    return {"voice": voice, "role": role, "format": {"type": "audio/pcm", "rate": rate}}


def ack(voice="sofia", role="support", kind="session.updated", rate=None):
    return {"type": kind, "session": {"audio": {"output": output(voice, role, rate)}}}


def response(kind="response.created", voice="sofia", role="support", rid="r1"):
    return {"type": kind, "response": {"id": rid, "status": "completed" if kind == "response.done" else "in_progress",
            "audio": {"output": {"voice": voice, "role": role, "format": None}}}}


class Socket:
    """Only the external WebSocket boundary is replaced; the providers run normally."""
    def __init__(self, frames, *, hang=False):
        self.frames = iter(frames)
        self.sent = []
        self.closed = False
        self.hang = hang
        self.waiting = asyncio.Event()

    async def send_json(self, payload):
        self.sent.append(payload)

    async def close(self):
        self.closed = True

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            frame = next(self.frames)
        except StopIteration:
            self.waiting.set()
            if self.hang:
                await asyncio.Event().wait()
            raise StopAsyncIteration
        if callable(frame):
            frame(self)
            return await self.__anext__()
        return SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=json.dumps(frame))


def speech_for(socket, voice="sofia", role="support"):
    speech = YandexSpeech(SimpleNamespace(api_key="test-key", folder_id="test-folder", voice=voice, role=role))
    speech.http = SimpleNamespace(ws_connect=lambda *args, **kwargs: socket, close=AsyncMock())
    return speech


def only_configuration_sent(socket):
    assert [event["type"] for event in socket.sent] == ["session.update"]


@pytest.mark.asyncio
@pytest.mark.parametrize("voice,role", [("sofia", "support"), ("vera", "casual"), ("denis", "neutral")])
async def test_fast_waits_for_exact_speaker_ack_in_each_fresh_phrase(voice, role):
    sockets = []
    speech = speech_for(None, voice, role)
    for phrase in ("Здравствуйте.", "Секунду.", "Ответ.", "Повторите, пожалуйста."):
        socket = Socket([
            ack("denis", None, "session.created"),
            ack("denis", None), only_configuration_sent,
            ack(voice, None), only_configuration_sent,
            ack(voice, role), response(voice="denis", role=None),
            {"type": "response.output_audio.delta", "response_id": "r1", "delta": base64.b64encode(PCM).decode()},
            response("response.done", "denis", None),
        ])
        sockets.append(socket)
        speech.http.ws_connect = lambda *args, **kwargs: socket
        assert [chunk async for chunk in speech.synthesize(phrase, voice)] == [PCM]
        assert socket.sent[0]["session"]["audio"]["output"] == output(voice, role, 16000)
        assert socket.sent[1]["item"]["content"][0]["text"] == phrase
        assert socket.sent[2] == {"type": "response.create"}
        assert socket.closed
    assert len(sockets) == 4
    await speech.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("unconfirmed", [
    ack("denis", None), ack("sofia", None), ack("SOFIA", "support"),
    {"type": "session.updated"}, ack(rate=24000),
    {"type": "session.updated", "session": {"audio": {"output": {
        "voice": "sofia", "role": "support", "format": {"type": "audio/opus"}}}}},
])
async def test_fast_missing_requested_ack_times_out_without_starting_speech(unconfirmed):
    socket = Socket([unconfirmed, only_configuration_sent], hang=True)
    speech = speech_for(socket)
    real_timeout = asyncio.timeout
    with patch("src.providers.yandex_fast.asyncio.timeout", side_effect=lambda _: real_timeout(.02)):
        with pytest.raises(TimeoutError):
            _ = [chunk async for chunk in speech.synthesize("Проверка.", "sofia")]
    only_configuration_sent(socket)
    assert socket.closed
    await speech.close()


@pytest.mark.asyncio
async def test_fast_cancellation_while_waiting_for_ack_closes_phrase_socket():
    socket = Socket([ack("denis", None)], hang=True)
    speech = speech_for(socket)
    async def consume():
        return [chunk async for chunk in speech.synthesize("Проверка.", "sofia")]
    task = asyncio.create_task(consume())
    await asyncio.wait_for(socket.waiting.wait(), .2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    only_configuration_sent(socket)
    assert socket.closed
    await speech.close()
    assert speech.http is None


@pytest.mark.asyncio
async def test_fast_closing_stream_after_first_audio_closes_phrase_socket():
    socket = Socket([ack(), response(),
        {"type": "response.output_audio.delta", "response_id": "r1", "delta": base64.b64encode(PCM).decode()}], hang=True)
    speech = speech_for(socket)
    stream = speech.synthesize("Проверка.", "sofia")
    assert await anext(stream) == PCM
    await stream.aclose()
    assert socket.closed
    await speech.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("unexpected", [response(),
    {"type": "response.output_audio.delta", "response_id": "unsolicited", "delta": base64.b64encode(PCM).decode()}])
async def test_fast_unsolicited_response_before_requested_ack_is_never_exposed(unexpected):
    socket = Socket([ack("denis", None), unexpected])
    speech = speech_for(socket)
    chunks = []
    with pytest.raises(YandexFastError):
        async for chunk in speech.synthesize("Проверка.", "sofia"):
            chunks.append(chunk)
    assert chunks == []
    only_configuration_sent(socket)
    assert socket.closed
    await speech.close()


@pytest.mark.asyncio
async def test_fast_audio_and_completion_are_bound_to_created_response():
    socket = Socket([ack(), response(),
        {"type": "response.output_audio.delta", "response_id": "other", "delta": base64.b64encode(b"\x02\x00").decode()},
        response("response.done", rid="other"),
        {"type": "response.output_audio.delta", "response_id": "r1", "delta": base64.b64encode(PCM).decode()},
        response("response.done")])
    speech = speech_for(socket)
    assert [chunk async for chunk in speech.synthesize("Проверка.", "sofia")] == [PCM]
    assert socket.closed
    await speech.close()


def native(**extra):
    settings = dict(api_key="test-key", folder_id="test-folder", voice="sofia", role="support",
                    output_sample_rate_hz=24000, session_timeout_seconds=.03)
    settings.update(extra)
    events = []
    provider = YandexRealtimeProvider(SimpleNamespace(**settings), events.append)
    return provider, events


@pytest.mark.asyncio
async def test_native_only_requested_ack_readies_greeting():
    provider, _ = native()
    observed_readiness = []
    socket = Socket([ack("denis", None, "session.created"), ack("denis", None),
                     lambda _: observed_readiness.append(provider._ready.is_set()),
                     ack()], hang=True)
    http = SimpleNamespace(ws_connect=AsyncMock(return_value=socket), close=AsyncMock())
    with patch("src.providers.yandex_realtime.aiohttp.ClientSession", return_value=http):
        await provider.start_session("call-1", {"greeting": "Здравствуйте."})
    assert observed_readiness == [False]
    assert socket.sent[1] == {"type": "response.create", "response": {
        "instructions": "Произнеси приветствие дословно: Здравствуйте."}}
    await provider._send_tool_continuation()
    await provider._send_tool_continuation("До свидания.")
    assert socket.sent[2] == {"type": "response.create"}
    assert socket.sent[3] == {"type": "response.create", "response": {
        "instructions": "Произнеси прощание и больше не вызывай инструменты: До свидания."}}
    await provider.stop_session()
    assert socket.closed and provider._receive_task is None
    http.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_native_missing_requested_ack_times_out_without_greeting_and_closes():
    provider, _ = native()
    socket = Socket([ack("denis", None)], hang=True)
    http = SimpleNamespace(ws_connect=AsyncMock(return_value=socket), close=AsyncMock())
    with patch("src.providers.yandex_realtime.aiohttp.ClientSession", return_value=http):
        with pytest.raises(TimeoutError):
            await provider.start_session("call-1", {"greeting": "Здравствуйте."})
    only_configuration_sent(socket)
    assert socket.closed and provider._receive_task is None
    http.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_native_cancelled_startup_closes_receive_task_and_connection():
    provider, _ = native(session_timeout_seconds=1)
    socket = Socket([ack("denis", None)], hang=True)
    http = SimpleNamespace(ws_connect=AsyncMock(return_value=socket), close=AsyncMock())
    with patch("src.providers.yandex_realtime.aiohttp.ClientSession", return_value=http):
        task = asyncio.create_task(provider.start_session("call-1", {"greeting": "Здравствуйте."}))
        await asyncio.wait_for(socket.waiting.wait(), .2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    only_configuration_sent(socket)
    assert socket.closed and provider._receive_task is None
    http.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_native_unsolicited_response_before_requested_ack_fails_closed():
    provider, events = native()
    socket = Socket([ack("denis", None), response(voice="denis", role=None),
        {"type": "response.output_audio.delta", "response_id": "r1", "delta": base64.b64encode(PCM).decode()},
        ack()], hang=True)
    http = SimpleNamespace(ws_connect=AsyncMock(return_value=socket), close=AsyncMock())
    with patch("src.providers.yandex_realtime.aiohttp.ClientSession", return_value=http):
        with pytest.raises(RuntimeError, match="configuration rejected"):
            await provider.start_session("call-1", {"greeting": "Здравствуйте."})
    assert not any(event["type"] == "AgentAudio" for event in events)
    only_configuration_sent(socket)
    assert socket.closed and provider._receive_task is None
    http.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_native_reused_provider_requires_current_call_speaker_ack():
    provider, _ = native()
    previous_socket = Socket([ack()], hang=True)
    next_socket = Socket([ack(), ack("vera", "casual")], hang=True)
    previous_http = SimpleNamespace(ws_connect=AsyncMock(return_value=previous_socket), close=AsyncMock())
    next_http = SimpleNamespace(ws_connect=AsyncMock(return_value=next_socket), close=AsyncMock())
    with patch("src.providers.yandex_realtime.aiohttp.ClientSession", side_effect=[previous_http, next_http]):
        await provider.start_session("call-1")
        provider.config.voice, provider.config.role = "vera", "casual"
        observed_readiness = []
        next_socket.frames = iter([ack(), lambda _: observed_readiness.append(provider._ready.is_set()), ack("vera", "casual")])
        await provider.start_session("call-2")
        assert observed_readiness == [False]
        assert provider._ready.is_set()
        await provider.stop_session()
    assert previous_socket.closed and next_socket.closed
    previous_http.close.assert_awaited_once()
    next_http.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_native_acknowledged_speaker_accepts_stale_response_voice_metadata():
    provider, events = native()
    socket = Socket([])
    provider.websocket = socket
    provider._closing = False
    await provider._handle_event(ack())
    await provider._handle_event(response(voice="denis", role=None))
    await provider._handle_event({"type": "response.output_audio.delta", "response_id": "r1",
                                  "delta": base64.b64encode(PCM).decode()})
    assert any(event["type"] == "AgentAudio" for event in events)
    assert not any(event["type"] == "ProviderDisconnected" for event in events)
    await provider.stop_session()
