"""Full-agent lifecycle and business-action tests; no carrier/API calls."""
import asyncio
import copy
import struct
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.providers.neuro_gemini import NeuroGeminiProvider, PhraseBuffer
from src.tools.base import ToolDefinition, ToolCategory


def config(**overrides):
    return SimpleNamespace(api_key="synthetic", project_id="synthetic-project", model="gemini-3.8-flash",
        voice_name="edsel", input_encoding="pcm16", input_sample_rate_hz=16000,
        target_encoding="pcm16", target_sample_rate_hz=16000, **overrides)


class Speech:
    def __init__(self):
        self.closed = False
        self.phrases = []
        self.callback = None
        self.started = asyncio.Event()
        self.release = None

    async def start_asr(self, callback):
        self.callback = callback

    async def send_audio(self, *args, **kwargs):
        pass

    async def synthesize(self, text, voice):
        self.phrases.append((text, voice))
        self.started.set()
        if self.release:
            await self.release.wait()
        yield b"\x01\x01" * 320

    async def close(self):
        self.closed = True


class Vertex:
    def __init__(self, responses):
        self.responses = responses
        self.requests = []
        self.closed = False

    async def stream(self, history, **kwargs):
        self.requests.append((copy.deepcopy(history), kwargs))
        response = self.responses[len(self.requests) - 1]
        for event in response:
            if isinstance(event, asyncio.Event):
                await event.wait()
            else:
                yield event

    async def close(self):
        self.closed = True


async def setup(monkeypatch, responses, context=None, **cfg):
    events, speech, vertex = [], Speech(), Vertex(responses)
    provider = NeuroGeminiProvider(config(**cfg), events.append)
    monkeypatch.setattr(provider, "_new_speech", lambda: speech)
    monkeypatch.setattr(provider, "_new_vertex", lambda: vertex)
    await provider.start_session("synthetic-call", context=context)
    return provider, speech, vertex, events


def answer(text="Готово."):
    return [{"type": "text", "text": text}, {"type": "content", "content": {"role": "model", "parts": [{"text": text}]}}]


async def finish(provider):
    await asyncio.wait_for(provider._turn_task, 2)


async def wait_until(predicate):
    async with asyncio.timeout(1):
        while not predicate():
            await asyncio.sleep(.001)


@pytest.mark.asyncio
async def test_interim_noise_and_listening_acknowledgements_do_not_restart_pending_answer(monkeypatch):
    release = asyncio.Event()
    provider, speech, vertex, events = await setup(monkeypatch, [[release, *answer("На ваши даты проверяю наличие.")]])
    await speech.callback({"type": "final", "text": "С 28 октября по 30 октября"})
    await wait_until(lambda: vertex.requests)
    turn, generation = provider._turn_task, provider._generation
    initial_interrupts = sum(e["type"] == "ProviderBargeIn" for e in events)
    for text in ("а", "у", "угу", "алло"):
        await speech.callback({"type": "partial", "text": text})
        await provider.send_audio(bytes(16000))
    for text in ("Угу", "Алло"):
        await speech.callback({"type": "final", "text": text})
    assert provider._turn_task is turn and provider._generation == generation
    assert len(vertex.requests) == 1
    assert sum(e["type"] == "ProviderBargeIn" for e in events) == initial_interrupts
    release.set()
    await finish(provider)
    assert speech.phrases[-1][0] == "На ваши даты проверяю наличие."
    await provider.stop_session()


@pytest.mark.asyncio
async def test_progress_is_serialized_and_does_not_masquerade_as_answer_latency(monkeypatch):
    release = asyncio.Event()
    provider, speech, vertex, events = await setup(monkeypatch, [[release, *answer("Ответ готов.")]], progress_after_seconds=.01)
    await speech.callback({"type": "final", "text": "Вопрос"})
    await wait_until(lambda: any(e["type"] == "AgentAudio" and e.get("progress") for e in events))
    assert "first_audio_emitted_at" not in provider._active_metrics
    assert not any(e["type"] == "agent_transcript" and not e.get("progress") for e in events)
    release.set()
    await finish(provider)
    assert provider.last_turn_metrics["first_audio_emitted_at"] >= provider.last_turn_metrics["first_model_text_at"]
    assert speech.phrases == [("Секунду, пожалуйста.", "edsel"), ("Ответ готов.", "edsel")]
    await provider.stop_session()


@pytest.mark.asyncio
async def test_progress_uses_isolated_business_policy_and_honors_disable(monkeypatch):
    policy = {"enabled": True, "phrases": ["Проверяю ваш вопрос."],
              "afterSeconds": 1, "repeatSeconds": 5, "maxMessages": 1}
    provider, speech, vertex, events = await setup(monkeypatch, [], context={"progress": policy})
    policy["phrases"][0] = "Чужая изменённая фраза."
    queue = asyncio.Queue()
    # A real wait has already exceeded the configured first-announcement delay.
    await asyncio.wait_for(provider._progress(queue, provider._generation, {},
                                            time.monotonic() - 2), 1)
    assert queue.qsize() == 1 and queue.get_nowait()["text"] == "Проверяю ваш вопрос."
    assert provider._progress_config["maxMessages"] == 1
    await provider.stop_session()
    disabled, *_ = await setup(monkeypatch, [], context={"progress": {**policy, "enabled": False}})
    queue = asyncio.Queue()
    await asyncio.wait_for(disabled._progress(queue, disabled._generation, {}, 0), .1)
    assert queue.empty()
    await disabled.stop_session()


@pytest.mark.asyncio
async def test_waiting_does_not_restart_after_answer_audio_or_tool_round(monkeypatch):
    release = asyncio.Event()
    response = [{"type": "text", "text": "Вот первый факт."}, release,
                {"type": "content", "content": {"role": "model", "parts": [{"text": "Вот первый факт."}]}}]
    provider, speech, vertex, events = await setup(monkeypatch, [response],
        progress_after_seconds=.005, progress_repeat_seconds=.005, progress_max_messages=2)
    await speech.callback({"type": "final", "text": "Расскажите"})
    await wait_until(lambda: any(e["type"] == "AgentAudio" and not e.get("progress") for e in events))
    await asyncio.sleep(.04)
    assert not any(e["type"] == "AgentAudio" and e.get("progress") for e in events)
    release.set()
    await finish(provider)
    await provider.stop_session()


def test_progress_defaults_are_one_message_and_invalid_limits_cannot_loop():
    provider = NeuroGeminiProvider(config(), lambda e: None)
    assert provider._progress_settings() == {"enabled": True, "phrases": ["Секунду, пожалуйста."],
        "afterSeconds": 3, "repeatSeconds": 15, "maxMessages": 1}
    provider._context = {"progress": {"enabled": False, "phrases": [],
        "afterSeconds": float("nan"), "repeatSeconds": 0, "maxMessages": 999}}
    policy = provider._progress_settings()
    assert policy["enabled"] is False
    assert policy["afterSeconds"] == 3 and policy["repeatSeconds"] == 15 and policy["maxMessages"] == 1
    legacy = NeuroGeminiProvider(config(progress_max_messages=0, progress_after_seconds=30), lambda e: None)
    assert legacy._progress_settings()["maxMessages"] == 0
    assert legacy._progress_settings()["afterSeconds"] == 30


@pytest.mark.asyncio
async def test_model_timeout_speaks_recovery_and_keeps_the_call_alive(monkeypatch):
    provider, speech, vertex, events = await setup(monkeypatch, [[asyncio.Event()], answer("Продолжим.")], model_timeout_seconds=.03, progress_after_seconds=.01)
    await speech.callback({"type": "final", "text": "Тест"})
    await finish(provider)
    assert not provider._closing and not speech.closed
    assert not any(e["type"] == "ProviderDisconnected" for e in events)
    assert any("Повторите" in p[0] for p in speech.phrases)
    assert len(vertex.requests) == 1  # No automatic model/action replay.
    await speech.callback({"type": "final", "text": "Давайте дальше"})
    await finish(provider)
    assert speech.phrases[-1][0] == "Продолжим."
    await provider.stop_session()


@pytest.mark.asyncio
async def test_yes_confirmation_is_not_filtered_as_a_listening_acknowledgement(monkeypatch):
    provider, speech, vertex, events = await setup(monkeypatch, [[asyncio.Event()], answer("Принято.")])
    await speech.callback({"type": "final", "text": "Первый вопрос"})
    await wait_until(lambda: vertex.requests)
    await speech.callback({"type": "final", "text": "Да"})
    await finish(provider)
    assert len(vertex.requests) == 2
    assert vertex.requests[-1][0][-1]["parts"][0]["text"] == "Да"
    await provider.stop_session()


@pytest.mark.asyncio
async def test_real_speech_transport_failure_still_ends_unusable_session(monkeypatch):
    from src.providers.neuro_speech import NeuroSpeechError
    provider, speech, vertex, events = await setup(monkeypatch, [answer()])
    async def failed(*args):
        raise NeuroSpeechError("tts_connection_failed")
        yield b""
    speech.synthesize = failed
    await speech.callback({"type": "final", "text": "Тест"})
    turn = provider._turn_task
    await asyncio.wait_for(turn, 1)
    assert any(e["type"] == "ProviderDisconnected" for e in events)
    assert speech.closed and vertex.closed


def test_engine_progress_does_not_hide_real_answer_delay():
    from src.engine import Engine
    session = SimpleNamespace(last_transcription_ts=100.0, turn_latencies_ms=[])
    Engine._record_provider_answer_latency(session, {"progress": True}, 102.5)
    assert session.last_transcription_ts == 100.0 and session.turn_latencies_ms == []
    Engine._record_provider_answer_latency(session, {}, 111.0)
    assert session.turn_latencies_ms == [11000.0] and session.last_transcription_ts == 0.0
    Engine._record_provider_answer_latency(session, {}, 112.0)
    assert session.turn_latencies_ms == [11000.0]


@pytest.mark.asyncio
async def test_waiting_phrase_that_an_answer_overtook_is_not_spoken(monkeypatch):
    provider, speech, vertex, events = await setup(monkeypatch, [])
    queue = asyncio.Queue()
    queue.put_nowait({"text": "Уже не нужно ждать.", "progress": True, "queued_at": 1.0})
    queue.put_nowait(None)
    await provider._play_phrases(queue, provider._generation, {"last_model_audio_at": 2.0})
    assert speech.phrases == []
    await provider.stop_session()


@pytest.mark.asyncio
async def test_waiting_during_a_submitted_action_does_not_repeat_it(monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    async def action(*args):
        entered.set()
        await release.wait()
        return {"status": "success", "data": {"id": "saved-once"}}
    execute = AsyncMock(side_effect=action)
    tool(monkeypatch, execute)
    raw = {"role": "model", "parts": [{"functionCall": {"name": "synthetic_action", "args": {"count": 1}}, "thoughtSignature": "keep-signature"}]}
    provider, speech, vertex, events = await setup(monkeypatch, [[{"type": "content", "content": raw}], answer("Готово.")], context={"tools": ["synthetic_action"]}, progress_after_seconds=.01)
    await speech.callback({"type": "final", "text": "Создай"})
    await entered.wait()
    await wait_until(lambda: any(e["type"] == "AgentAudio" and e.get("progress") for e in events))
    await speech.callback({"type": "partial", "text": "Угу"})
    await speech.callback({"type": "final", "text": "Алло"})
    assert execute.await_count == 1
    release.set()
    await finish(provider)
    assert execute.await_count == 1 and len(vertex.requests) == 2
    assert vertex.requests[1][0][1] == raw
    assert speech.phrases[-1][0] == "Готово."
    await provider.stop_session()


@pytest.mark.asyncio
async def test_tool_takeover_preserves_result_without_model_continuation(monkeypatch):
    execute = AsyncMock(return_value={"status": "blocked", "code": "voice_human_takeover",
                                     "ai_should_speak": False})
    tool(monkeypatch, execute)
    raw = {"role": "model", "parts": [{"functionCall": {"name": "synthetic_action", "args": {"count": 1}},
                                         "thoughtSignature": "preserved"}]}
    provider, speech, vertex, events = await setup(monkeypatch, [[{"type": "content", "content": raw}]],
        context={"tools": ["synthetic_action"], "progress": {"enabled": False}})
    await speech.callback({"type": "final", "text": "Передайте менеджеру"})
    await finish(provider)
    assert len(vertex.requests) == 1 and execute.await_count == 1
    assert provider._history[-1]["parts"][0]["functionResponse"]["response"]["ai_should_speak"] is False
    assert not speech.phrases and not provider._closing
    await provider.stop_session()


@pytest.mark.asyncio
async def test_interim_change_of_request_blocks_new_action_until_committed(monkeypatch):
    execute = AsyncMock(return_value={"status": "success"})
    tool(monkeypatch, execute)
    provider, speech, vertex, events = await setup(monkeypatch, [answer("Не оформляю.")], context={"tools": ["synthetic_action"]})
    generation = provider._generation
    await speech.callback({"type": "partial", "text": "Другие даты"})
    task = asyncio.create_task(provider._execute_tool({"name": "synthetic_action", "args": {"count": 1}}, 1, generation=generation))
    await asyncio.sleep(.01)
    execute.assert_not_awaited()
    await speech.callback({"type": "final", "text": "Не бронируй"})
    assert (await task)["code"] == "tool_not_submitted"
    execute.assert_not_awaited()
    await finish(provider)
    await provider.stop_session()


def test_phrase_buffer_streams_sentence_before_response_end_and_bounds_long_text():
    buffer = PhraseBuffer(40)
    assert buffer.push("Здравствуйте.") == ["Здравствуйте."]
    assert buffer.push("Длинная фраза " * 10)
    assert len(buffer.pending) < 40
    assert buffer.push("", final=True)


@pytest.mark.asyncio
async def test_first_phrase_audio_precedes_model_completion_and_cleanup(monkeypatch):
    release = asyncio.Event()
    response = [{"type": "text", "text": "Сначала это."}, release,
                {"type": "content", "content": {"role": "model", "parts": [{"text": "Сначала это."}]}}]
    provider, speech, vertex, events = await setup(monkeypatch, [response])
    await speech.callback({"type": "final", "text": "Тест"})
    await asyncio.wait_for(speech.started.wait(), 1)
    assert any(e["type"] == "AgentAudio" for e in events)
    assert not provider._turn_task.done()
    release.set()
    await finish(provider)
    assert provider.last_turn_metrics["first_model_text_at"] <= provider.last_turn_metrics["first_pcm_at"]
    assert provider.last_turn_metrics["first_pcm_at"] <= provider.last_turn_metrics["first_audio_emitted_at"]
    await provider.stop_session()
    assert speech.closed and vertex.closed
    assert not provider._background and not provider._tool_batches and provider._turn_task is None


@pytest.mark.asyncio
async def test_barge_in_cancels_queued_tts_and_fences_late_audio(monkeypatch):
    provider, speech, vertex, events = await setup(monkeypatch, [answer("Первый ответ.")])
    speech.release = asyncio.Event()
    await speech.callback({"type": "final", "text": "Первый запрос"})
    await asyncio.wait_for(speech.started.wait(), 1)
    old = provider._generation
    await speech.callback({"type": "partial", "text": "Стоп"})
    speech.release.set()
    await provider._emit("AgentAudio", generation=old, data=b"late")
    assert any(e["type"] == "ProviderBargeIn" for e in events)
    assert not any(e["type"] == "AgentAudio" for e in events)
    await provider.stop_session()
    assert speech.closed and vertex.closed


@pytest.mark.asyncio
async def test_line_noise_does_not_discard_pending_answer_without_asr_replacement(monkeypatch):
    release = asyncio.Event()
    provider, speech, vertex, events = await setup(monkeypatch, [[release, *answer()]])
    await speech.callback({"type": "final", "text": "Настоящий вопрос"})
    while not vertex.requests:
        await asyncio.sleep(0)
    turn = provider._turn_task
    generation = provider._generation
    events.clear()
    # The old path silently killed the turn after only 80 ms above RMS 500.
    await provider.send_audio(struct.pack("<h", 2000) * 1280)
    await provider.send_audio(bytes(12800))
    assert provider._turn_task is turn and not turn.done()
    assert provider._generation == generation
    assert not any(e["type"] == "ProviderBargeIn" for e in events)
    release.set()
    await finish(provider)
    assert any(e["type"] == "AgentAudio" for e in events)
    assert not any(e["type"] == "ProviderError" for e in events)
    await provider.stop_session()


@pytest.mark.asyncio
async def test_noise_during_tts_keeps_answer_but_recognized_speech_interrupts(monkeypatch):
    provider, speech, vertex, events = await setup(monkeypatch, [answer("Первый ответ."), answer("Новый ответ.")])
    speech.release = asyncio.Event()
    await speech.callback({"type": "final", "text": "Первый вопрос"})
    await asyncio.wait_for(speech.started.wait(), 1)
    turn = provider._turn_task
    await provider.send_audio(struct.pack("<h", 2000) * 1280)
    assert provider._turn_task is turn and not turn.done()
    # Energy must not mark semantic speech as already handled and swallow this.
    await speech.callback({"type": "partial", "text": "Другой вопрос"})
    assert provider._turn_task is turn and not turn.done()
    await speech.callback({"type": "final", "text": "Другой вопрос"})
    assert turn.cancelled()
    speech.release.set()
    events.clear()
    await finish(provider)
    assert any(e["type"] == "AgentAudio" for e in events)
    assert all(e["text"] == "Новый ответ." for e in events if e["type"] == "agent_transcript")
    assert len(vertex.requests) == 2
    await provider.stop_session()


@pytest.mark.asyncio
async def test_repeated_noisy_turns_keep_responding_and_preserve_context(monkeypatch):
    provider, speech, vertex, events = await setup(monkeypatch, [answer() for _ in range(20)])
    for number in range(20):
        await speech.callback({"type": "final", "text": f"Вопрос {number}"})
        await provider.send_audio(struct.pack("<h", 2000) * 1280)
        await provider.send_audio(bytes(12800))
        await finish(provider)
    assert len(vertex.requests) == 20
    assert len([e for e in events if e["type"] == "AgentAudio"]) == 20
    assert len([row for row in provider._history if row["role"] == "user"]) == 20
    assert not any(e["type"] == "ProviderError" for e in events)
    await provider.stop_session()


@pytest.mark.asyncio
async def test_timestamps_metadata_does_not_duplicate_final(monkeypatch):
    provider, speech, vertex, events = await setup(monkeypatch, [answer()])
    await speech.callback({"type": "final", "text": "Да"})
    await speech.callback({"type": "timestamps", "text": "Да"})
    await finish(provider)
    assert len(vertex.requests) == 1
    assert len([e for e in events if e["type"] == "transcript" and e["is_final"]]) == 1
    await provider.stop_session()


def tool(monkeypatch, executor, name="synthetic_action", schema=None):
    from src.providers import neuro_gemini as module
    definition = ToolDefinition(name=name, description="Synthetic action", category=ToolCategory.BUSINESS,
        input_schema=schema or {"type": "object", "properties": {"count": {"type": "integer"}}, "required": ["count"], "additionalProperties": False})
    instance = SimpleNamespace(definition=definition, validate_parameters=AsyncMock(return_value=True), execute=executor)
    monkeypatch.setattr(module.tool_registry, "get", lambda requested: instance if requested == name else None)
    monkeypatch.setattr(module.tool_registry, "to_openai_realtime_schema_filtered", lambda names: [definition.to_openai_realtime_schema()] if name in names else [])
    return instance


@pytest.mark.asyncio
async def test_raw_signature_tool_result_and_duplicate_action_are_preserved(monkeypatch):
    execute = AsyncMock(return_value={"status": "success", "data": {"record_id": "durable-123"}, "message": "Записано"})
    instance = tool(monkeypatch, execute)
    raw = {"role": "model", "parts": [{"thought": True, "text": "private thought"},
        {"functionCall": {"name": "synthetic_action", "args": {"count": 1}}, "thoughtSignature": "opaque-signature"}]}
    provider, speech, vertex, events = await setup(monkeypatch,
        [[{"type": "content", "content": raw}], [{"type": "content", "content": raw}], answer("Записано.")],
        context={"tools": ["synthetic_action"], "business_id": 7})
    await speech.callback({"type": "final", "text": "Запиши"})
    await finish(provider)
    assert execute.await_count == 1
    assert vertex.requests[1][0][1] == raw
    response = vertex.requests[1][0][2]["parts"][0]["functionResponse"]["response"]
    assert response["data"]["record_id"] == "durable-123"
    assert all("private thought" not in phrase for phrase, voice in speech.phrases)
    assert execute.await_args.args[1].business_id == 7
    await provider.stop_session()


@pytest.mark.asyncio
async def test_invalid_typed_arguments_and_unallowed_tool_never_execute(monkeypatch):
    execute = AsyncMock()
    instance = tool(monkeypatch, execute)
    provider, speech, vertex, events = await setup(monkeypatch, [], context={"tools": ["synthetic_action"]})
    result = await provider._execute_tool({"name": "synthetic_action", "args": {"count": "wrong"}}, 1)
    denied = await provider._execute_tool({"name": "unallowed", "args": {"count": 1}}, 1)
    assert result["code"] == denied["code"] == "invalid_tool_call"
    execute.assert_not_awaited()
    instance.validate_parameters.assert_not_awaited()
    await provider.stop_session()


@pytest.mark.asyncio
async def test_timeout_unknown_outcome_is_consumed_once_without_retry(monkeypatch):
    async def slow(*args):
        await asyncio.Event().wait()
    execute = AsyncMock(side_effect=slow)
    tool(monkeypatch, execute)
    provider, speech, vertex, events = await setup(monkeypatch, [], context={"tools": ["synthetic_action"]}, tool_timeout_seconds=.01)
    call = {"name": "synthetic_action", "args": {"count": 1}}
    result = await provider._execute_tool(call, 1)
    assert result["code"] == "tool_timeout" and result["outcome"] == "unknown"
    assert await provider._execute_tool(call, 1) == result
    assert execute.await_count == 1
    await provider.stop_session()


@pytest.mark.asyncio
async def test_barge_in_during_tool_keeps_durable_result_before_next_user(monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    async def action(*args):
        entered.set()
        await release.wait()
        return {"status": "success", "data": {"record_id": "once"}}
    execute = AsyncMock(side_effect=action)
    tool(monkeypatch, execute)
    raw = {"role": "model", "parts": [{"functionCall": {"name": "synthetic_action", "args": {"count": 1}}, "thoughtSignature": "sig"}]}
    provider, speech, vertex, events = await setup(monkeypatch, [[{"type": "content", "content": raw}], answer()], context={"tools": ["synthetic_action"]})
    await speech.callback({"type": "final", "text": "Запиши"})
    await asyncio.wait_for(entered.wait(), 1)
    await speech.callback({"type": "partial", "text": "Стоп"})
    await speech.callback({"type": "final", "text": "Что получилось?"})
    release.set()
    await finish(provider)
    history = vertex.requests[1][0]
    assert history[1] == raw
    assert history[2]["parts"][0]["functionResponse"]["response"]["data"]["record_id"] == "once"
    assert history[3]["parts"][0]["text"] == "Что получилось?"
    assert execute.await_count == 1
    await provider.stop_session()


@pytest.mark.asyncio
async def test_hangup_result_speaks_farewell_then_emits_ready(monkeypatch):
    execute = AsyncMock(return_value={"status": "success", "will_hangup": True, "message": "До свидания."})
    tool(monkeypatch, execute, name="hangup_call", schema={"type": "object"})
    raw = {"role": "model", "parts": [{"functionCall": {"name": "hangup_call", "args": {}}}]}
    provider, speech, vertex, events = await setup(monkeypatch, [[{"type": "content", "content": raw}]], context={"tools": ["hangup_call"]})
    await speech.callback({"type": "final", "text": "Пока"})
    await finish(provider)
    kinds = [e["type"] for e in events]
    assert kinds.index("AgentAudio") < kinds.index("AgentAudioDone") < kinds.index("HangupReady")
    assert speech.phrases == [("До свидания.", "edsel")]
    await provider.stop_session()


@pytest.mark.asyncio
async def test_model_failure_keeps_asr_and_next_question_working(monkeypatch):
    provider, speech, vertex, events = await setup(monkeypatch, [[], answer("Я на связи.")])
    await speech.callback({"type": "final", "text": "Тест"})
    await finish(provider)
    assert any(e["type"] == "ProviderTurnError" and e["recoverable"] for e in events)
    assert not any(e["type"] == "ProviderDisconnected" for e in events)
    assert not speech.closed and not vertex.closed and not provider._closing
    await speech.callback({"type": "final", "text": "Вы на связи?"})
    await finish(provider)
    assert speech.phrases[-1][0] == "Я на связи."
    await provider.stop_session()


@pytest.mark.asyncio
async def test_context_and_configuration_are_detached(monkeypatch):
    source = config()
    provider = NeuroGeminiProvider(source, lambda _: None)
    source.voice_name = "changed"
    assert provider.config.voice_name == "edsel"
    p, speech, vertex, events = await setup(monkeypatch, [answer()], context={"tools": ["first"]})
    assert p._context["tools"] == ["first"]
    await p.stop_session()


@pytest.mark.asyncio
async def test_cancel_while_audio_callback_waits_closes_suspended_tts_generator(monkeypatch):
    provider, speech, vertex, events = await setup(monkeypatch, [answer()])
    audio_entered, generator_closed = asyncio.Event(), asyncio.Event()
    async def chunks(text, voice):
        try:
            yield b"\x01\x01" * 320
            await asyncio.Event().wait()
        finally:
            generator_closed.set()
    async def on_event(event):
        if event["type"] == "AgentAudio":
            audio_entered.set()
            await asyncio.Event().wait()
        events.append(event)
    speech.synthesize = chunks
    provider.on_event = on_event
    await speech.callback({"type": "final", "text": "Тест"})
    await asyncio.wait_for(audio_entered.wait(), 1)
    await asyncio.wait_for(provider.cancel_response(), 1)
    assert generator_closed.is_set()  # Before hangup/GC closes the client.
    await provider.stop_session()


@pytest.mark.asyncio
async def test_barge_in_after_generation_done_still_flushes_engine_playback(monkeypatch):
    provider, speech, vertex, events = await setup(monkeypatch, [answer()])
    await speech.callback({"type": "final", "text": "Тест"})
    await finish(provider)
    events.clear()
    await speech.callback({"type": "partial", "text": "Перебиваю буфер"})
    assert not any(e["type"] == "ProviderBargeIn" for e in events)
    await speech.callback({"type": "final", "text": "Перебиваю буфер"})
    assert any(e["type"] == "ProviderBargeIn" for e in events)
    await provider.stop_session()


@pytest.mark.asyncio
async def test_interrupt_during_batch_does_not_submit_remaining_actions(monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    async def action(args, context):
        entered.set()
        await release.wait()
        return {"status": "success", "data": {"record_id": args["count"]}}
    execute = AsyncMock(side_effect=action)
    tool(monkeypatch, execute)
    raw = {"role": "model", "parts": [{"functionCall": {"name": "synthetic_action", "args": {"count": count}}, "thoughtSignature": "sig"} for count in (1, 2)]}
    provider, speech, vertex, events = await setup(monkeypatch, [[{"type": "content", "content": raw}], answer()], context={"tools": ["synthetic_action"]})
    await speech.callback({"type": "final", "text": "Запиши два"})
    await asyncio.wait_for(entered.wait(), 1)
    await speech.callback({"type": "partial", "text": "Стоп"})
    await speech.callback({"type": "final", "text": "Что получилось?"})
    release.set()
    await finish(provider)
    assert execute.await_count == 1
    history = vertex.requests[1][0]
    responses = history[2]["parts"]
    assert responses[0]["functionResponse"]["response"]["status"] == "success"
    assert responses[1]["functionResponse"]["response"]["code"] == "tool_not_submitted"
    await provider.stop_session()


@pytest.mark.parametrize("raw,field", [
    ({"status": "success", "message": "Events listed.", "events": [{"id": "event1", "summary": "Meeting", "start": "18:00"}]}, "events"),
    ({"status": "success", "id": "event-created", "summary": "Meeting", "htmlLink": "https://calendar.google.com/event"}, "id"),
])
def test_existing_calendar_tool_fields_survive_normalization(raw, field):
    result = NeuroGeminiProvider._normalize_tool_result(raw)
    assert result["data"][field] == raw[field]


def test_tool_response_size_cap_includes_nonstandard_fields():
    import json
    raw = {"status": "success", "events": [{"description": "x" * 20000}], "message": "Events listed."}
    result = NeuroGeminiProvider._normalize_tool_result(raw)
    assert len(json.dumps(result).encode()) <= 12000
    assert "exceeded the response limit" in result["message"]


@pytest.mark.asyncio
async def test_interrupt_while_permission_check_waits_does_not_submit_action(monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    execute = AsyncMock(return_value={"status": "success"})
    tool(monkeypatch, execute)
    provider, speech, vertex, events = await setup(monkeypatch, [], context={"tools": ["synthetic_action"]})
    async def guard(*args):
        entered.set()
        await release.wait()
    provider._voice_tool_guard = guard
    generation = provider._generation
    task = asyncio.create_task(provider._execute_tool({"name": "synthetic_action", "args": {"count": 1}}, 1, generation=generation))
    await entered.wait()
    await provider.cancel_response()
    release.set()
    result = await task
    assert result["code"] == "tool_not_submitted"
    execute.assert_not_awaited()
    await provider.stop_session()


@pytest.mark.asyncio
async def test_nonfinite_tool_arguments_never_execute(monkeypatch):
    execute = AsyncMock()
    tool(monkeypatch, execute, schema={"type": "object", "properties": {"count": {"type": "number"}}})
    provider, speech, vertex, events = await setup(monkeypatch, [], context={"tools": ["synthetic_action"]})
    result = await provider._execute_tool({"name": "synthetic_action", "args": {"count": float("nan")}}, 1)
    assert result["code"] == "invalid_tool_call"
    execute.assert_not_awaited()
    await provider.stop_session()

@pytest.mark.asyncio
async def test_explicit_russian_goodbye_needs_no_model_round(monkeypatch):
    provider, speech, vertex, events = await setup(monkeypatch, [], context={'tools':['hangup_call']})
    await speech.callback({'type':'final','text':'Спасибо, до свидания!'})
    await finish(provider)
    assert not vertex.requests
    assert len(speech.phrases) == 1
    assert sum(e['type']=='HangupReady' for e in events) == 1
    await provider.stop_session()


@pytest.mark.asyncio
async def test_thanks_keeps_call_open_even_when_model_says_goodbye_without_speaking_tool_text(monkeypatch):
    provider, speech, vertex, events = await setup(monkeypatch,
        [answer('Хорошего вам дня! hangup_call {"farewell_message":"Пока"}')], context={'tools':['hangup_call']})
    await speech.callback({'type':'final','text':'Спасибо'})
    await finish(provider)
    assert len(speech.phrases)==1
    assert speech.phrases[0][0]=='Хорошего вам дня!'
    assert not any(e['type']=='HangupReady' for e in events)
    await provider.stop_session()


@pytest.mark.asyncio
async def test_question_after_thanks_keeps_consultation_open(monkeypatch):
    provider, speech, vertex, events = await setup(monkeypatch, [answer('Модель стоит 5000 рублей.')], context={'tools':['hangup_call']})
    await speech.callback({'type':'final','text':'Спасибо, а сколько стоит?'})
    await finish(provider)
    assert len(vertex.requests)==1
    assert not any(e['type']=='HangupReady' for e in events)
    await provider.stop_session()
