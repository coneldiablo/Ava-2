"""Independent regressions for provider failure and interruption boundaries."""
import asyncio
import base64
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from src.providers.yandex_realtime import YandexRealtimeProvider


@pytest.mark.asyncio
async def test_unavailable_selected_provider_terminates_answered_call_with_error():
    from src.engine import Engine
    from src.core.models import CallSession
    engine = object.__new__(Engine)
    call = CallSession(call_id="synthetic-missing", caller_channel_id="local-synthetic")
    call.business_id = 900001
    call.hotel_profile = {"businessId": 900001, "voiceAiProvider": "yandex_realtime"}
    engine.providers = {"google_live": object()}
    engine.provider_factories = {}
    engine._call_providers = {}
    engine.session_store = SimpleNamespace(get_by_call_id=AsyncMock(return_value=call))
    engine._save_session = AsyncMock()
    engine.ari_client = SimpleNamespace(hangup_channel=AsyncMock())
    engine.config = SimpleNamespace(tools={})
    await engine._start_provider_session(call.call_id)
    assert call.error_message, "startup failure must remain visible in saved call history"
    engine.ari_client.hangup_channel.assert_awaited_once_with("local-synthetic")


@pytest.mark.asyncio
async def test_provider_user_transcript_updates_engine_transfer_context_once():
    from src.engine import Engine
    from src.core.models import CallSession
    engine = object.__new__(Engine)
    call = CallSession(call_id="synthetic-call", caller_channel_id="local-synthetic")
    engine.session_store = SimpleNamespace(get_by_call_id=AsyncMock(return_value=call), upsert_call=AsyncMock())
    provider, _ = subject()
    provider.on_event = engine.on_provider_event
    provider._session_store = engine.session_store
    await provider._handle_event({"type": "conversation.item.input_audio_transcription.completed", "item_id": "question1", "transcript": "Передайте менеджеру вопрос о синтетическом тарифе"})
    assert call.last_transcript == "Передайте менеджеру вопрос о синтетическом тарифе"
    assert len(call.conversation_history) == 1


@pytest.mark.asyncio
async def test_completed_farewell_without_audio_still_terminates():
    provider, events = subject()
    provider._hangup_after_response = True
    await provider._handle_event({"type": "response.created", "response": {"id": "farewell"}})
    await provider._handle_event({"type": "response.done", "response": {"id": "farewell", "status": "completed"}})
    assert any(e["type"] == "HangupReady" for e in events)


@pytest.mark.asyncio
async def test_interrupted_farewell_does_not_hangup_following_answer():
    provider, events = subject()
    provider._hangup_after_response = True
    await provider._handle_event({"type": "response.created", "response": {"id": "farewell"}})
    await provider._handle_event({"type": "input_audio_buffer.speech_started"})
    await provider._handle_event({"type": "response.created", "response": {"id": "followup-answer"}})
    await provider._handle_event({"type": "response.output_audio.done", "response_id": "followup-answer"})
    assert not any(e["type"] == "HangupReady" for e in events)


@pytest.mark.asyncio
async def test_tool_execution_reaches_post_call_audit_snapshot():
    from src.core.models import CallSession
    provider, _ = subject()
    call = CallSession(call_id="synthetic-call", caller_channel_id="local-synthetic")
    call.business_id = 900001
    provider._business_id = call.business_id
    provider._context = {"tools": ["synthetic_lookup"]}
    provider._session_store = SimpleNamespace(get_by_call_id=AsyncMock(return_value=call), upsert_call=AsyncMock())
    tool = SimpleNamespace(execute=AsyncMock(return_value={"status": "success", "message": "synthetic result"}))
    with patch("src.providers.yandex_realtime.tool_registry.is_tool_allowed", return_value=True), \
         patch("src.providers.yandex_realtime.tool_registry.get", return_value=tool), \
         patch("src.providers.yandex_realtime.ToolExecutionContext.get_tool_block_response", new=AsyncMock(return_value=None)):
        await provider._execute_tool({"name": "synthetic_lookup", "call_id": "audit-f1", "arguments": "{}"})
    assert len(call.tool_calls) == 1
    assert call.tool_calls[0]["name"] == "synthetic_lookup"
    provider._session_store.upsert_call.assert_awaited()


def subject():
    events = []
    async def emit(event):
        events.append(event)
    provider = YandexRealtimeProvider(SimpleNamespace(target_encoding="pcm16", target_sample_rate_hz=24000,
                                                     tool_timeout_seconds=0.01), emit)
    provider._call_id = "synthetic-call"
    provider._closing = False
    provider.websocket = SimpleNamespace(closed=False, send_json=AsyncMock(), close=AsyncMock())
    return provider, events


@pytest.mark.asyncio
async def test_failed_response_surfaces_failure_instead_of_silent_completion():
    provider, events = subject()
    provider._ready.set()
    await provider._handle_event({"type": "response.created", "response": {"id": "r1"}})
    await provider._handle_event({"type": "response.done", "response": {"id": "r1", "status": "failed"}})
    assert any(e["type"] in {"ProviderError", "ProviderDisconnected"} for e in events)


@pytest.mark.asyncio
async def test_old_audio_done_cannot_finish_new_response():
    provider, events = subject()
    await provider._handle_event({"type": "response.created", "response": {"id": "old"}})
    await provider._handle_event({"type": "input_audio_buffer.speech_started"})
    await provider._handle_event({"type": "response.created", "response": {"id": "new"}})
    events.clear()
    await provider._handle_event({"type": "response.output_audio.delta", "response_id": "old", "delta": base64.b64encode(bytes(480)).decode()})
    await provider._handle_event({"type": "response.output_audio.done", "response_id": "old"})
    assert not events
    await provider._handle_event({"type": "response.output_audio.delta", "response_id": "new", "delta": base64.b64encode(bytes(480)).decode()})
    assert any(e["type"] == "AgentAudio" for e in events)


@pytest.mark.asyncio
async def test_hung_tool_returns_error_and_continues_with_trusted_tenant():
    provider, _ = subject()
    provider._business_id = 900001
    provider._context = {"tools": ["synthetic_lookup"], "business_id": 900001}
    observed = []
    async def hung(args, context):
        observed.append(context.business_id)
        await asyncio.Event().wait()
    tool = SimpleNamespace(execute=hung)
    with patch("src.providers.yandex_realtime.tool_registry.is_tool_allowed", return_value=True), \
         patch("src.providers.yandex_realtime.tool_registry.get", return_value=tool), \
         patch("src.providers.yandex_realtime.ToolExecutionContext.get_tool_block_response", new=AsyncMock(return_value=None)):
        await asyncio.wait_for(provider._execute_tool({"name": "synthetic_lookup", "call_id": "f1", "arguments": '{"business_id":900002}'}), timeout=0.5)
    assert observed == [900001]
    sent = [call.args[0] for call in provider.websocket.send_json.await_args_list]
    assert sent[0]["item"]["type"] == "function_call_output"
    assert '"status": "error"' in sent[0]["item"]["output"]
    assert sent[1]["type"] == "response.create"
