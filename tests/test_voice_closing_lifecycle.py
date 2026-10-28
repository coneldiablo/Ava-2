"""Call closing regressions with actual engine/provider state transitions.

No provider network, Asterisk request or customer message is made here.
"""
import asyncio
import copy
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.engine import Engine
from src.providers.neuro_gemini import NeuroGeminiProvider
from src.providers.yandex_realtime import YandexRealtimeProvider
from src.tools.registry import tool_registry
from src.tools.telephony.hangup import HangupCallTool


def engine_call():
    session = SimpleNamespace(call_id="closing-call", caller_channel_id="caller-leg",
        provider_name="yandex_realtime", last_transcript="До свидания",
        cleanup_after_tts=True, tts_playing=False, conversation_history=[])
    engine = object.__new__(Engine)
    engine.config = SimpleNamespace(farewell_hangup_delay_sec=.08, providers={}, tools={})
    engine.session_store = SimpleNamespace(get_by_call_id=AsyncMock(return_value=session),
        upsert_call=AsyncMock(), list_playbacks_for_call=AsyncMock(return_value=[]))
    engine.ari_client = SimpleNamespace(hangup_channel=AsyncMock())
    engine._voice_runtime_allowed = AsyncMock(return_value=True)
    engine.streaming_playback_manager = SimpleNamespace(is_stream_active=lambda _: False)
    return engine, session


@pytest.mark.asyncio
async def test_provider_receive_returns_before_drain_and_duplicate_release_is_coalesced():
    engine, session = engine_call()
    event = {"type":"HangupReady", "call_id":session.call_id, "had_audio":True,
             "reason":"farewell_completed"}
    # An inline drain wait would exceed this timeout and stall native STT.
    await asyncio.wait_for(engine.on_provider_event(event), timeout=.03)
    pending = engine._provider_hangup_tasks[session.call_id]
    engine.ari_client.hangup_channel.assert_not_awaited()
    await engine.on_provider_event(event)
    assert engine._provider_hangup_tasks[session.call_id] is pending
    await asyncio.wait_for(pending, timeout=.5)
    engine.ari_client.hangup_channel.assert_awaited_once_with("caller-leg")
    assert session.call_id not in engine._provider_hangup_tasks


@pytest.mark.asyncio
@pytest.mark.parametrize("new_event", [
    {"type":"transcript", "text":"Подождите, сколько стоит доставка?", "is_final":True},
    # Even when no audio remains to flush, new speech must cancel the timer.
    {"type":"ProviderBargeIn", "reason":"speech_started"},
])
async def test_new_speech_cancels_scheduled_release_without_dropping_caller(new_event):
    engine, session = engine_call()
    await engine.on_provider_event({"type":"HangupReady", "call_id":session.call_id,
                                   "had_audio":True})
    pending = engine._provider_hangup_tasks[session.call_id]
    await asyncio.sleep(0)
    await engine.on_provider_event({"call_id":session.call_id, **new_event})
    await asyncio.wait_for(pending, timeout=.5)
    engine.ari_client.hangup_channel.assert_not_awaited()
    assert session.cleanup_after_tts is False
    assert session.call_id not in engine._provider_hangup_tasks
    if new_event["type"] == "transcript":
        assert session.last_transcript == new_event["text"]
        assert session.conversation_history[-1]["content"] == new_event["text"]


@pytest.mark.asyncio
@pytest.mark.parametrize('caller_text', ['Пришлите подборку в WhatsApp', 'Спасибо'])
async def test_provider_farewell_cannot_hang_up_unchanged_delivery_request_or_thanks(caller_text):
    engine, session = engine_call()
    session.last_transcript = caller_text
    await engine.on_provider_event({'type':'HangupReady', 'call_id':session.call_id, 'had_audio':True})
    await asyncio.wait_for(engine._provider_hangup_tasks[session.call_id], timeout=.5)
    engine.ari_client.hangup_channel.assert_not_awaited()
    assert session.cleanup_after_tts is False


def native_provider(monkeypatch):
    monkeypatch.setitem(tool_registry._tools, "hangup_call", HangupCallTool())
    session = SimpleNamespace(cleanup_after_tts=False, tool_calls=[])
    provider = YandexRealtimeProvider(SimpleNamespace(tool_timeout_seconds=2), lambda _: None)
    provider._closing = False
    provider._call_id = "native-closing"
    provider._context = {"tools":["hangup_call"]}
    provider._session_store = SimpleNamespace(get_by_call_id=AsyncMock(return_value=session),
                                            upsert_call=AsyncMock())
    provider.websocket = SimpleNamespace(closed=False, send_json=AsyncMock())
    provider._record_tool = AsyncMock()
    return provider, session


def native_result(provider):
    outputs = [call.args[0] for call in provider.websocket.send_json.await_args_list
               if call.args[0]["type"] == "conversation.item.create"]
    assert len(outputs) == 1
    return json.loads(outputs[0]["item"]["output"])


@pytest.mark.asyncio
async def test_native_hangup_without_committed_transcript_fails_closed(monkeypatch):
    provider, session = native_provider(monkeypatch)
    await asyncio.wait_for(provider._execute_tool({"name":"hangup_call", "call_id":"tool-1",
        "arguments":'{"farewell_message":"До свидания"}'}), timeout=2)
    result = native_result(provider)
    assert result["will_hangup"] is False
    assert result["code"] == "caller_not_finished"
    assert session.cleanup_after_tts is False
    provider._session_store.upsert_call.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("transcript,allowed", [
    ("До свидания", True), ("Подождите, сколько стоит доставка?", False),
])
async def test_native_tool_waits_for_late_stt_and_uses_its_actual_intent(monkeypatch, transcript, allowed):
    provider, session = native_provider(monkeypatch)
    await provider._handle_event({"type":"response.created", "response":{"id":"turn-1"}})
    await provider._handle_event({"type":"response.output_item.done", "response_id":"turn-1",
        "item":{"type":"function_call", "name":"hangup_call", "call_id":"tool-1",
                "arguments":'{"farewell_message":"До свидания"}'}})
    await asyncio.sleep(.03)
    assert session.cleanup_after_tts is False
    await provider._handle_event({"type":"conversation.item.input_audio_transcription.completed",
        "item_id":"caller-1", "transcript":transcript})
    await asyncio.wait_for(provider._tool_tasks["tool-1"], timeout=1)
    assert native_result(provider)["will_hangup"] is allowed
    assert session.cleanup_after_tts is allowed


class Speech:
    def __init__(self):
        self.phrases = []

    async def start_asr(self, callback):
        self.callback = callback

    async def synthesize(self, text, voice):
        self.phrases.append(text)
        yield b"\x01\x01" * 320

    async def close(self):
        pass


class Model:
    def __init__(self, text, calls=()):
        self.text, self.calls = text, calls
        self.requests = []

    async def stream(self, history, **kwargs):
        self.requests.append(copy.deepcopy(history))
        yield {"type":"text", "text":self.text}
        parts = [{"text":self.text}] + [{"functionCall":call} for call in self.calls]
        yield {"type":"content", "content":{"role":"model", "parts":parts}}

    async def close(self):
        pass


async def cascade_provider(monkeypatch, model):
    speech, events = Speech(), []
    provider = NeuroGeminiProvider(SimpleNamespace(api_key="synthetic", project_id="synthetic",
        model="gemini-3.8-flash", voice_name="edsel", input_encoding="pcm16",
        input_sample_rate_hz=16000, target_encoding="pcm16", target_sample_rate_hz=16000), events.append)
    monkeypatch.setattr(provider, "_new_speech", lambda: speech)
    monkeypatch.setattr(provider, "_new_vertex", lambda: model)
    monkeypatch.setitem(tool_registry._tools, "hangup_call", HangupCallTool())
    session = SimpleNamespace(cleanup_after_tts=False, tool_calls=[])
    provider._session_store = SimpleNamespace(get_by_call_id=AsyncMock(return_value=session),
                                             upsert_call=AsyncMock())
    await provider.start_session("cascade-closing", context={"tools":["hangup_call"]})
    return provider, speech, events, session


@pytest.mark.asyncio
async def test_filtered_only_model_response_speaks_recovery_instead_of_silent_success(monkeypatch):
    model = Model('hangup_call {"farewell_message":"До свидания"}')
    provider, speech, events, session = await cascade_provider(monkeypatch, model)
    try:
        await speech.callback({"type":"final", "text":"Спасибо"})
        await asyncio.wait_for(provider._turn_task, timeout=2)
        assert len(speech.phrases) == 1
        assert "Повторите" in speech.phrases[0]
        assert "hangup_call" not in speech.phrases[0]
        assert any(event["type"] == "AgentAudio" for event in events)
        assert not any(event["type"] == "HangupReady" for event in events)
        assert session.cleanup_after_tts is False
    finally:
        await provider.stop_session()


@pytest.mark.asyncio
async def test_actual_hangup_farewell_survives_prior_filtered_protocol_text(monkeypatch):
    farewell = "До свидания, хорошего дня!"
    model = Model('hangup_call {"farewell_message":"Неверный текст"}', calls=[
        {"id":"finish-1", "name":"hangup_call", "args":{"farewell_message":farewell}}])
    provider, speech, events, session = await cascade_provider(monkeypatch, model)
    try:
        # This is allowed for the real hangup tool, but is not the explicit
        # goodbye shortcut: the model and tool must actually execute.
        await speech.callback({"type":"final", "text":"Это всё"})
        await asyncio.wait_for(provider._turn_task, timeout=2)
        assert len(model.requests) == 1
        assert speech.phrases == [farewell]
        assert session.cleanup_after_tts is True
        closing = [event for event in events if event["type"] == "HangupReady"]
        assert len(closing) == 1 and closing[0]["had_audio"] is True
        assert [event["type"] for event in events].index("AgentAudio") < [
            event["type"] for event in events].index("HangupReady")
    finally:
        await provider.stop_session()
