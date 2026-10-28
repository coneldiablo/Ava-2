"""Per-call Neuro Speech + Vertex Gemini full agent.

Neuro owns direct audio connections; Vertex receives text only. Every asynchronous
output is fenced by a generation, including responses arriving after barge-in.
"""
from __future__ import annotations

import asyncio
import contextlib
import copy
import hashlib
import inspect
import json
import math
import re
import time
from datetime import datetime, timezone

import numpy as np
from jsonschema import Draft202012Validator
from structlog import get_logger

from .base import AIProviderInterface, ProviderCapabilities
from .neuro_speech import NeuroSpeech, NeuroSpeechError
from .neuro_vertex import VertexTextClient, VertexClientError
from ..audio import mulaw_to_pcm16le, resample_audio, convert_pcm16le_to_target_format
from ..core.voice_closing import clear_closing, mutual_closing
from ..tools.registry import tool_registry
from ..tools.context import ToolExecutionContext
from ..tools.adapters.sanitize import sanitize_tool_result_for_json_string

logger = get_logger(__name__)
MODELS = frozenset({"gemini-3.8-flash", "gemini-3.7-flash"})


class PhraseBuffer:
    """Emit short complete phrases while the model is still streaming."""

    def __init__(self, limit=160):
        self.limit = max(40, min(int(limit), 500))
        self.pending = ""

    def push(self, text, final=False):
        self.pending += text
        phrases = []
        while self.pending:
            # A trailing punctuation token needs no following token to speak.
            boundary = re.search(r"[.!?;:\n](?:\s|$)", self.pending)
            end = boundary.end() if boundary else 0
            if not end and len(self.pending) >= self.limit:
                end = self.pending.rfind(" ", 0, self.limit + 1)
                if end < self.limit // 2:
                    end = self.limit
            if not end and final:
                end = len(self.pending)
            if not end:
                break
            phrase, self.pending = self.pending[:end].strip(), self.pending[end:].lstrip()
            if phrase:
                phrases.append(phrase)
        return phrases


class NeuroGeminiProvider(AIProviderInterface):
    provider_name = "neuro_gemini"
    def __init__(self, config, on_event, gating_manager=None):
        super().__init__(on_event)
        self.config = copy.deepcopy(config)
        self._gating_manager = gating_manager
        self._call_id = None
        self._context = {}
        self._speech = self._vertex = None
        self._closing = True
        self._disconnected = False
        self._generation = 0
        self._turn_number = 0
        self._turn_task = None
        self._background = set()
        self._tool_batches = set()
        self._tool_ledger = {}
        self._history = []
        self._pending_user = []
        self._input_mode = None
        self._input_state = None
        self._audio_lock = asyncio.Lock()
        self._speech_ms = self._silence_ms = 0.0
        self._speaking = False
        self._speech_end = None
        self._final_pending = False
        self._active_queue = None
        self._active_metrics = None
        self._progress_config = None
        self._last_partial_at = 0.0
        self._speech_committed = asyncio.Event()
        self._speech_committed.set()
        self.last_turn_metrics = {}

    def _cfg(self, name, default=None):
        if isinstance(self.config, dict):
            return self.config.get(name, default)
        return getattr(self.config, name, default)

    def _progress_settings(self):
        """Snapshot the selected business's waiting policy, retaining legacy config.

        Public progress settings are validated before reaching the engine. Keep
        defensive bounds here too: a malformed optional setting must not start an
        unbounded loop, leak another call's phrases, or disable the actual answer.
        """
        raw = self._context.get("progress")
        canonical = isinstance(raw, dict)
        raw = raw if canonical else {}

        def bounded(name, legacy, default, lower, upper, integer=False):
            value = raw.get(name, default) if canonical else self._cfg(legacy, default)
            if (isinstance(value, bool) or not isinstance(value, (int, float))
                    or not math.isfinite(value) or not lower <= value <= upper
                    or (integer and not isinstance(value, int))):
                return default
            return value

        enabled = raw.get("enabled", True) if canonical else self._cfg("progress_enabled", True)
        phrases = raw.get("phrases") if canonical else self._cfg("progress_phrases")
        if (not isinstance(phrases, list) or not 1 <= len(phrases) <= 5
                or any(not isinstance(p, str) or not p.strip() or len(p) > 200 for p in phrases)):
            phrases = ["Секунду, пожалуйста."]
        return {"enabled": enabled if isinstance(enabled, bool) else True,
                "phrases": [p.strip() for p in phrases],
                # Legacy sub-second values remain useful for existing deployments
                # and offline tests; the public API has a one-second minimum.
                "afterSeconds": bounded("afterSeconds", "progress_after_seconds", 3, 1 if canonical else .001, 15 if canonical else 30),
                "repeatSeconds": bounded("repeatSeconds", "progress_repeat_seconds", 15, 5 if canonical else .001, 60),
                "maxMessages": bounded("maxMessages", "progress_max_messages", 1, 1 if canonical else 0, 2 if canonical else 3, integer=True)}

    def _model_timing(self):
        """Only bounded scalar transport metrics may reach call logs."""
        raw = getattr(self._vertex, "last_request_metrics", {}) or {}
        result = {}
        if raw.get("phase") in {"auth", "headers", "body", "complete"}:
            result["model_request_phase"] = raw["phase"]
        for key in ("auth_ms", "headers_ms", "first_frame_ms", "elapsed_ms", "frames"):
            value = raw.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
                result["model_" + key] = round(value, 1)
        return result

    @property
    def supported_codecs(self):
        return ["ulaw", "slin16"]

    def is_ready(self):
        return bool(self._cfg("enabled", True) and self._cfg("api_key")
                    and self._cfg("project_id") and self._cfg("model", "gemini-3.8-flash") in MODELS
                    and self._cfg("thinking_level", "LOW") == "LOW"
                    and self._cfg("voice_name", "edsel"))

    def get_capabilities(self):
        # VAD/barge-in are owned by this full agent rather than the engine gate.
        return ProviderCapabilities(["ulaw", "pcm16", "slin16"], [8000, 16000, 24000],
                                    ["ulaw", "pcm16", "slin16"], [8000, 16000, 24000],
                                    is_full_agent=True, has_native_vad=True,
                                    has_native_barge_in=True, requires_continuous_audio=True)

    def set_input_mode(self, mode):
        if mode not in {"mulaw8k", "pcm16_8k", "pcm16_16k"}:
            raise ValueError("Unsupported engine input mode")
        self._input_mode = mode
        self._input_state = None

    async def _emit(self, kind, generation=None, **values):
        if generation is not None and (self._closing or generation != self._generation):
            return
        result = self.on_event({"type": kind, "call_id": self._call_id,
                                "provider": self.provider_name, **values})
        if inspect.isawaitable(result):
            await result

    def _spawn(self, coroutine, collection=None):
        task = asyncio.create_task(coroutine)
        target = collection if collection is not None else self._background
        target.add(task)
        def finished(done):
            target.discard(done)
            # Retrieve failures even when a cancellation detached the waiter.
            if not done.cancelled():
                done.exception()
        task.add_done_callback(finished)
        return task

    def _new_speech(self):
        return NeuroSpeech(self.config)

    def _new_vertex(self):
        return VertexTextClient(project=self._cfg("project_id"), location=self._cfg("location", "global"),
                                proxy_url=self._cfg("proxy_url", self._cfg("text_proxy")) or None,
                                total_timeout=float(self._cfg("model_timeout_seconds", 35)),
                                connect_timeout=float(self._cfg("session_timeout_seconds", 10)),
                                chunk_timeout=float(self._cfg("chunk_timeout_seconds", 12)),
                                max_history_bytes=int(self._cfg("max_history_bytes", 512000)))

    async def start_session(self, call_id, context=None):
        await self.stop_session()
        self._call_id = call_id
        # Deep copy only data: executor/context handles must retain their identity.
        source = dict(context or {})
        self._context = {key: (value if callable(value) else copy.deepcopy(value)) for key, value in source.items()}
        self._progress_config = self._progress_settings()
        if not self.is_ready():
            raise ValueError("Neuro Gemini is not configured")
        self._closing = False
        self._disconnected = False
        self._history = []
        self._pending_user = []
        self._tool_ledger = {}
        self._tool_batches = set()
        self._turn_number = 0
        self._input_state = None
        self._speech_ms = self._silence_ms = 0.0
        self._speaking = self._final_pending = False
        self._speech_end = None
        self._speech_committed.set()
        self._speech = self._new_speech()
        self._vertex = self._new_vertex()
        try:
            await asyncio.wait_for(self._speech.start_asr(self._on_asr),
                                   timeout=float(self._cfg("session_timeout_seconds", 10)))
            await self._emit("ProviderAudioFormat", encoding=self._cfg("target_encoding", "ulaw"),
                             sample_rate=int(self._cfg("target_sample_rate_hz", 8000)))
            greeting = str(self._context.get("greeting", self._cfg("greeting", "")) or "").strip()
            if greeting:
                self._history.append({"role": "model", "parts": [{"text": greeting}]})
                self._generation += 1
                self._turn_task = asyncio.create_task(self._respond(self._generation, greeting=greeting))
        except BaseException:
            await self.stop_session()
            raise

    async def send_audio(self, audio_chunk, sample_rate=None, encoding=None):
        if self._closing or not audio_chunk:
            return
        async with self._audio_lock:
            if self._closing:
                return
            codec = self._cfg("input_encoding", "ulaw")
            rate = int(self._cfg("input_sample_rate_hz", 8000))
            if self._input_mode:
                codec = "ulaw" if self._input_mode == "mulaw8k" else "pcm16"
                rate = 16000 if self._input_mode == "pcm16_16k" else 8000
            codec, rate = str(encoding or codec).lower(), int(sample_rate or rate)
            if codec in {"ulaw", "mulaw", "g711_ulaw", "mu-law"}:
                pcm = mulaw_to_pcm16le(audio_chunk)
            elif codec in {"pcm16", "slin16", "slin", "linear16"} and len(audio_chunk) % 2 == 0:
                pcm = audio_chunk
            else:
                raise ValueError("Unsupported input audio")
            pcm, self._input_state = resample_audio(pcm, rate, 16000, state=self._input_state)
            await self._vad(pcm)
            try:
                await self._speech.send_audio(pcm, sample_rate=16000)
            except asyncio.CancelledError:
                raise
            except Exception:
                await self._fail("neuro_asr_send_failed")

    async def _vad(self, pcm):
        if not pcm:
            return
        duration = len(pcm) / 32.0
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float64)
        rms = float(np.sqrt(np.mean(samples * samples)))
        if rms >= float(self._cfg("vad_threshold", 500)):
            self._speech_ms += duration
            self._silence_ms = 0
            self._speech_end = time.monotonic()
            # Energy is useful for speech-end timing, but is not proof of speech.
            # Cancelling here also cancels a pending answer on line noise/echo,
            # with no ASR final to start a replacement. Only recognized speech
            # below may interrupt generation and buffered engine playback.
        else:
            self._silence_ms += duration
            if self._silence_ms >= float(self._cfg("vad_silence_ms", 400)):
                self._speaking = False
                self._speech_ms = 0

    async def _interrupt(self):
        active = self._turn_task is not None and not self._turn_task.done()
        await self.cancel_response()
        # The engine may still be playing buffered PCM after generation ended.
        # It checks actual playback activity before flushing this signal.
        await self._emit("ProviderBargeIn", reason="speech_started")
        if active:
            await self._emit("AgentAudioDone")

    async def cancel_response(self):
        self._generation += 1
        task, self._turn_task = self._turn_task, None
        if task and task is not asyncio.current_task() and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    async def _on_asr(self, event):
        if self._closing:
            return
        received_at = event.get("received_at")
        if not isinstance(received_at, (int, float)):
            received_at = time.monotonic()
        kind = event.get("type")
        if kind == "error":
            self._spawn(self._fail("neuro_asr_failed"))
            return
        if kind == "timestamps":
            return  # Additional metadata for the same committed transcript.
        text = str(event.get("text") or "").strip()
        if not text:
            return
        if kind == "partial":
            self._last_partial_at = time.monotonic()
            # An interim hypothesis can disappear or be revised. Never discard
            # the pending answer on it; committed speech owns normal barge-in.
            # An explicit stop remains immediate and prevents unsent actions.
            normalized = re.sub(r"[^\w\s]", "", text.casefold()).strip()
            if normalized and normalized not in {"а", "у", "угу", "ага", "мгм", "хм"}:
                self._speech_committed.clear()
            explicit_stop = normalized in {"стоп", "остановись", "подождите", "не надо", "погоди", "погодите", "отмена"} or re.match(r"^не (?:бронируй|оформляй|отправляй|создавай|оплачивай)(?:\s|$)", normalized)
            if explicit_stop and not self._speaking:
                self._speaking = True
                await self._interrupt()
            await self._emit("transcript", text=text, is_final=False, role="user")
            return
        if kind != "final":
            return
        normalized = re.sub(r"[^\w\s]", "", text.casefold()).strip()
        if not normalized:
            return
        self._last_partial_at = 0.0
        self._speech_committed.set()
        busy = self._turn_task is not None and not self._turn_task.done()
        # A listening acknowledgement while an answer is still being prepared
        # does not replace the actual request or restart its model/tool work.
        # Yes/no remain meaningful; acknowledgements after a completed answer
        # also remain normal user turns (including booking confirmation).
        continuation = busy and self._active_metrics is not None and not self._active_metrics.get("first_audio_emitted_at") and normalized in {"угу", "ага", "мгм", "хм", "алло", "алло алло", "ты здесь", "вы здесь", "слышишь", "вы меня слышите"}
        if continuation:
            await self._emit("transcript", text=text, is_final=True, role="user", continues_pending_turn=True)
            logger.info("Neuro Gemini pending answer retained", call_id=self._call_id, generation=self._generation)
            return
        await self._interrupt()
        await self._emit("transcript", text=text, is_final=True, role="user")
        self._pending_user.append(text)
        self._turn_number += 1
        self._generation += 1
        generation = self._generation
        previous = self._turn_task
        if previous and not previous.done():
            previous.cancel()
        # Preserve every final utterance in arrival order; the next model turn
        # waits for the previous tool batch to close its function-call history.
        self._turn_task = asyncio.create_task(self._respond(generation, user_text=text, previous=previous))
        self._speaking = False
        self._speech_ms = 0
        self.last_turn_metrics = {"asr_final_at": received_at, "speech_end_at": self._speech_end}

    async def _respond(self, generation, user_text=None, greeting=None, previous=None):
        producer = consumer = progress = None
        queue = asyncio.Queue(maxsize=int(self._cfg("phrase_queue_size", 8)))
        metrics = self.last_turn_metrics.copy() if user_text else {}
        started = time.monotonic()
        phase = "waiting_for_actions"
        self._active_queue, self._active_metrics = queue, metrics
        logger.info("Neuro Gemini turn started", call_id=self._call_id, generation=generation)
        try:
            async with asyncio.timeout(float(self._cfg("turn_timeout_seconds", 90))):
                consumer = asyncio.create_task(self._play_phrases(queue, generation, metrics))
                if not greeting:
                    progress = asyncio.create_task(self._progress(queue, generation, metrics, started))
                if previous and previous is not asyncio.current_task():
                    with contextlib.suppress(asyncio.CancelledError):
                        await previous
                # A barge-in cancels generation/TTS, never an already submitted
                # business action. Consume its durable/unknown result first.
                if self._tool_batches:
                    await asyncio.gather(*(asyncio.shield(t) for t in list(self._tool_batches)))
                if self._closing or generation != self._generation:
                    return
                for text in self._pending_user:
                    self._history.append({"role": "user", "parts": [{"text": text}]})
                self._pending_user.clear()
                phase = "model_and_speech"
                if greeting:
                    await queue.put(greeting)
                    await queue.put(None)
                elif mutual_closing(user_text, next(("".join(p.get("text", "") for p in item.get("parts", []))
                         for item in reversed(self._history) if item.get("role") == "model"), "")) and tool_registry.is_tool_allowed("hangup_call", self._context.get("tools") or []):
                    # A committed explicit goodbye needs no model round or tool
                    # syntax generation. Submitted actions were awaited above.
                    metrics["hangup"] = True
                    await queue.put("До свидания.")
                    await queue.put(None)
                else:
                    producer = asyncio.create_task(self._produce(queue, generation, metrics))
                jobs = [consumer] + ([producer] if producer else [])
                await asyncio.gather(*jobs)
                if metrics.get("control_text_suppressed") and not metrics.get("first_audio_emitted_at") and not metrics.get("speech_blocked"):
                    recovery = asyncio.Queue()
                    recovery.put_nowait({"text":"Не удалось подготовить ответ. Повторите, пожалуйста, вопрос.", "trusted":True})
                    recovery.put_nowait(None)
                    await self._play_phrases(recovery, generation, metrics)
                if generation == self._generation and not self._closing:
                    await self._emit("AgentAudioDone", generation=generation)
                    if not greeting and metrics.get("closing_phrase_played") and mutual_closing(user_text, "До свидания"):
                        metrics["hangup"] = tool_registry.is_tool_allowed("hangup_call", self._context.get("tools") or [])
                    if metrics.get("hangup"):
                        await self._emit("HangupReady", generation=generation,
                                         reason="farewell_completed", had_audio=bool(metrics.get("first_pcm_at")))
                    self.last_turn_metrics = metrics
                    logger.info("Neuro Gemini turn timing", call_id=self._call_id, generation=generation, **{
                        f"{name}_ms": round((metrics[name] - metrics["asr_final_at"]) * 1000)
                        for name in ("first_model_text_at", "first_pcm_at", "first_audio_emitted_at")
                        if name in metrics and "asr_final_at" in metrics})
        except asyncio.CancelledError:
            logger.info("Neuro Gemini turn cancelled", call_id=self._call_id, generation=generation,
                        phase=phase, elapsed_ms=round((time.monotonic() - started) * 1000),
                        had_model_text=bool(metrics.get("first_model_text_at")),
                        had_audio=bool(metrics.get("first_audio_emitted_at")), **self._model_timing())
            raise
        except Exception as exc:
            # Only fixed identifiers from our clients may leave this boundary.
            code = exc.code if isinstance(exc, (NeuroSpeechError, VertexClientError)) else (
                "timeout" if isinstance(exc, TimeoutError) else "turn_failed")
            request_metrics = getattr(self._vertex, "last_request_metrics", {}) or {}
            request_phase = request_metrics.get("phase")
            if request_phase not in {"auth", "headers", "body", "complete"}:
                request_phase = None
            logger.warning("Neuro Gemini turn failed", call_id=self._call_id, generation=generation,
                           phase=phase, error_code=code, model_request_phase=request_phase,
                           model_request_ms=request_metrics.get("elapsed_ms"))
            speech_failed = isinstance(exc, NeuroSpeechError) or (consumer is not None and consumer.done() and not consumer.cancelled() and consumer.exception() is not None)
            if speech_failed:
                await self._fail("neuro_gemini_" + code)
            else:
                # A model deadline must not tear down a healthy ASR/audio call.
                # Stop only this turn; retain history and submitted tool results.
                for task in (producer, consumer, progress):
                    if task and not task.done():
                        task.cancel()
                for task in (producer, consumer, progress):
                    if task:
                        with contextlib.suppress(asyncio.CancelledError, Exception):
                            await task
                if not self._closing and generation == self._generation:
                    fallback = "Я на связи. Не получилось быстро подготовить ответ. Повторите, пожалуйста, вопрос."
                    recovery = asyncio.Queue()
                    await recovery.put({"text": fallback, "progress": True})
                    await recovery.put(None)
                    try:
                        await self._play_phrases(recovery, generation, metrics)
                        await self._emit("AgentAudioDone", generation=generation)
                        await self._emit("ProviderTurnError", generation=generation, error=code, recoverable=True)
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        await self._fail("neuro_gemini_recovery_speech_failed")
        finally:
            for task in (producer, consumer, progress):
                if task and not task.done():
                    task.cancel()
            for task in (producer, consumer, progress):
                if task:
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await task
            if self._active_queue is queue:
                self._active_queue = self._active_metrics = None

    async def _progress(self, queue, generation, metrics, started):
        policy = self._progress_config or self._progress_settings()
        if not policy["enabled"]:
            return
        delay, repeat, maximum = policy["afterSeconds"], policy["repeatSeconds"], policy["maxMessages"]
        sent, last = 0, started
        while sent < maximum:
            await asyncio.sleep(min(delay, .25))
            if self._closing or generation != self._generation:
                return
            # A response has begun: do not interleave generic waiting speech
            # between its phrases or tool continuation rounds. This budget is
            # per user turn, never reset by a model/tool round.
            if metrics.get("first_audio_emitted_at"):
                return
            now = time.monotonic()
            if now - max(last, metrics.get("last_audio_at", started)) < (delay if not sent else repeat):
                continue
            if metrics.get("tts_active") or not queue.empty() or now - self._last_partial_at < .8:
                continue
            queue.put_nowait({"text": policy["phrases"][sent % len(policy["phrases"])], "progress": True, "queued_at": now})
            sent, last = sent + 1, now
            logger.info("Neuro Gemini progress queued", call_id=self._call_id, generation=generation, elapsed_ms=round((now-started)*1000))

    def _tool_declarations(self):
        result = []
        for schema in tool_registry.to_openai_realtime_schema_filtered(self._context.get("tools") or []):
            result.append({"name": schema["name"], "description": schema["description"],
                           "parametersJsonSchema": schema["parameters"]})
        return [{"functionDeclarations": result}] if result else []

    async def _produce(self, queue, generation, metrics):
        instructions = str(self._context.get("instructions", self._cfg("instructions", "")) or "")
        instructions += "\nОтвечай краткими разговорными фразами. Не произноси разметку. Не подтверждай действие до успешного результата инструмента."
        instructions += ("\nЕсли нужен инструмент, вызывай его без вводных фраз ожидания: такие сообщения воспроизводит система. "
                         "Используй уже доступный контекст; если данных достаточно, отвечай без лишних повторных вызовов. "
                         "Не повторяй действие с неподтверждённым результатом.")
        for round_number in range(int(self._cfg("max_tool_rounds", 6))):
            if self._closing or generation != self._generation:
                return
            self._bound_history()
            buffer = PhraseBuffer(self._cfg("phrase_max_chars", 160))
            content = None
            request_started = time.monotonic()
            declarations = self._tool_declarations()
            logger.info("Neuro Gemini model request", call_id=self._call_id, generation=generation,
                        model=self._cfg("model", "gemini-3.8-flash"), round=round_number,
                        history_messages=len(self._history), history_bytes=len(json.dumps(self._history, ensure_ascii=False).encode()),
                        instruction_bytes=len(instructions.encode()), tools_bytes=len(json.dumps(declarations).encode()))
            async with asyncio.timeout(float(self._cfg("model_timeout_seconds", 35))):
                stream = self._vertex.stream(copy.deepcopy(self._history), instructions=instructions,
                                             tools=declarations, model=self._cfg("model", "gemini-3.8-flash"))
                async with contextlib.aclosing(stream):
                    async for event in stream:
                        if generation != self._generation or self._closing:
                            return
                        if event.get("type") == "text":
                            metrics.setdefault("first_model_text_at", time.monotonic())
                            for phrase in buffer.push(event.get("text") or ""):
                                await queue.put(phrase)
                        elif event.get("type") == "content":
                            content = copy.deepcopy(event["content"])
            for phrase in buffer.push("", final=True):
                await queue.put(phrase)
            if not content or content.get("role") != "model":
                raise RuntimeError("Missing model content")
            # Preserve every opaque thoughtSignature and raw part in order.
            self._history.append(content)
            calls = [part["functionCall"] for part in content.get("parts", []) if "functionCall" in part]
            logger.info("Neuro Gemini model completed", call_id=self._call_id, generation=generation,
                        round=round_number, duration_ms=round((time.monotonic()-request_started)*1000),
                        tool_calls=len(calls), **self._model_timing())
            if not calls:
                await queue.put(None)
                return
            if len(calls) > 16:
                raise RuntimeError("Too many tool calls")
            batch = self._spawn(self._tool_batch(calls, self._turn_number, generation), self._tool_batches)
            results = await asyncio.shield(batch)
            if any(result.get("ai_should_speak") is False for _, result in results):
                metrics["speech_blocked"] = True
                await queue.put(None)
                return
            hangup = next((r for name, r in results if tool_registry.canonicalize_tool_name(name) == "hangup_call" and r.get("will_hangup")), None)
            if hangup:
                metrics["hangup"] = True
                await queue.put({"text":str(hangup.get("message") or "До свидания."),"trusted":True})
                await queue.put(None)
                return
        raise RuntimeError("Tool round limit")

    def _bound_history(self):
        # Never prune a function call away from its corresponding result. Bound
        # the call instead of silently losing model signatures or tool evidence.
        if len(json.dumps(self._history, ensure_ascii=False).encode()) > int(self._cfg("max_history_bytes", 512000)):
            raise RuntimeError("Conversation limit")

    async def _tool_batch(self, calls, turn_number, generation):
        responses, results = [], []
        for call in calls:
            name = str(call.get("name") or "")
            if self._closing or generation != self._generation:
                result = {"status": "error", "code": "tool_not_submitted", "outcome": "cancelled",
                          "message": "Speech interrupted before this action was submitted."}
            else:
                result = await self._execute_tool(call, turn_number, generation=generation)
            response = {"name": name, "response": result}
            if call.get("id"):
                response["id"] = call["id"]
            responses.append({"functionResponse": response})
            results.append((name, result))
        self._history.append({"role": "user", "parts": responses})
        return results

    async def _execute_tool(self, call, turn_number, generation=None):
        name, args = str(call.get("name") or ""), call.get("args", {})
        try:
            if not isinstance(args, dict) or len(json.dumps(args, allow_nan=False).encode()) > 32000:
                raise ValueError("Invalid tool arguments")
            canonical = tool_registry.canonicalize_tool_name(name)
            fingerprint = hashlib.sha256(json.dumps([canonical, args], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            key = f"{turn_number}:{fingerprint}"
            # Deduplicate identical model actions within a user turn even if the
            # model emitted a different invocation ID on the next round.
            if key in self._tool_ledger:
                return copy.deepcopy(self._tool_ledger[key])
            if len(self._tool_ledger) >= int(self._cfg("max_tool_calls", 64)):
                raise ValueError("Tool limit")
            if not tool_registry.is_tool_allowed(name, self._context.get("tools") or []):
                raise ValueError("Tool denied")
            tool = tool_registry.get(name)
            if tool is None:
                raise ValueError("Unknown tool")
            schema = tool.definition._json_schema_object()
            Draft202012Validator(schema).validate(args)
            if not await asyncio.wait_for(tool.validate_parameters(args), timeout=float(self._cfg("tool_timeout_seconds", 30))):
                raise ValueError("Tool arguments rejected")
        except Exception:
            return {"status": "error", "code": "invalid_tool_call", "message": "Tool name or arguments are not allowed."}
        started = time.monotonic()
        logger.info("Neuro Gemini tool started", call_id=self._call_id, generation=generation, tool=name)
        result = {"status": "error", "code": "tool_execution_failed", "outcome": "unknown",
                  "message": "Action completion is unconfirmed. Do not retry automatically."}
        # Install conservative entry before execution: failures cannot re-submit.
        self._tool_ledger[key] = result
        context = ToolExecutionContext(call_id=self._call_id,
            business_id=int(getattr(self, "_business_id", self._context.get("business_id", 1))),
            autopilot_allowed_actions=list(self._context.get("autopilot_allowed_actions") or []),
            session_store=getattr(self, "_session_store", None), ari_client=getattr(self, "_ari_client", None),
            config=getattr(self, "_full_config", None), provider_name=self.provider_name, provider_session=self,
            runtime_guard=getattr(self, "_voice_tool_guard", None),
            caller_channel_id=getattr(self, "_caller_channel_id", None), bridge_id=getattr(self, "_bridge_id", None),
            caller_number=getattr(self, "_caller_number", None), called_number=getattr(self, "_called_number", None),
            caller_name=getattr(self, "_caller_name", None), context_name=getattr(self, "_context_name", None),
            user_input=next(("".join(p.get("text", "") for p in item.get("parts", []))
                             for item in reversed(self._history) if item.get("role") == "user"
                             and any("text" in p for p in item.get("parts", []))), None))
        try:
            async def execute():
                if not self._speech_committed.is_set():
                    try:
                        await asyncio.wait_for(self._speech_committed.wait(), timeout=min(2, float(self._cfg("tool_timeout_seconds", 30))/2))
                    except asyncio.TimeoutError:
                        return {"status": "error", "code": "tool_not_submitted", "outcome": "cancelled",
                                "message": "The caller has not finished speaking. No action was submitted; clarify the request."}
                blocked = await context.get_tool_block_response(name)
                if blocked:
                    return blocked
                if self._closing or (generation is not None and generation != self._generation):
                    return {"status": "error", "code": "tool_not_submitted", "outcome": "cancelled",
                            "message": "Speech interrupted before this action was submitted."}
                executor = self._context.get("tool_executor")
                if executor:
                    return await executor(name, args, context,
                                          idempotency_key=f"neuro:{self._call_id}:{key}")
                return await tool.execute(args, context)
            timeout = min(float(self._cfg("tool_timeout_seconds", 30)), float(tool.definition.max_execution_time or 30))
            raw = await asyncio.wait_for(execute(), timeout=timeout)
            result = self._normalize_tool_result(raw)
        except asyncio.TimeoutError:
            result["code"] = "tool_timeout"
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("Neuro Gemini tool failed")
        self._tool_ledger[key] = copy.deepcopy(result)
        logger.info("Neuro Gemini tool completed", call_id=self._call_id, generation=generation, tool=name,
                    duration_ms=round((time.monotonic()-started)*1000), status=result.get("status", "unknown"))
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._record_tool(name, key, result, started), timeout=3)
        return result

    @staticmethod
    def _normalize_tool_result(raw):
        """Retain actual registry tool outputs, including calendar/MCP fields."""
        controls = ("status", "message", "will_hangup", "transferred", "transfer_mode", "extension",
                    "destination", "error", "code", "outcome", "ai_should_speak")
        if not isinstance(raw, dict):
            return sanitize_tool_result_for_json_string(raw)
        payload = {key: (value[:2000] if isinstance(value, str) else value)
                   for key, value in raw.items() if key in controls}
        extra = {key: value for key, value in raw.items() if key not in controls and key != "data"}
        if extra:
            data = raw.get("data")
            payload["data"] = {**extra, **({"data": data} if data is not None else {})}
        elif "data" in raw:
            payload["data"] = raw["data"]
        result = sanitize_tool_result_for_json_string(payload, keep_keys=(*controls, "data"))
        if "data" in payload and "data" not in result:
            result["message"] = str(result.get("message") or "")[:1000] + " [Additional tool data exceeded the response limit.]"
        if len(json.dumps(result, ensure_ascii=False).encode()) > 12000:
            result = {"status": "error", "code": "tool_result_limit", "outcome": "unknown",
                      "message": "Action returned an oversized result. Do not repeat it automatically."}
        return result

    async def _record_tool(self, name, invocation, result, started):
        store = getattr(self, "_session_store", None)
        if store is None:
            return
        try:
            session = await store.get_by_call_id(self._call_id)
            if session:
                if getattr(session, "tool_calls", None) is None:
                    session.tool_calls = []
                session.tool_calls.append({"name": name, "call_id": invocation, "params": {},
                    "result": result.get("status", "unknown"), "message": "",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "duration_ms": round((time.monotonic() - started) * 1000)})
                await store.upsert_call(session)
        except Exception:
            logger.warning("Neuro Gemini tool history save failed")

    async def _play_phrases(self, queue, generation, metrics):
        state, tail = None, b""
        while True:
            phrase = await queue.get()
            if phrase is None:
                return
            is_progress = isinstance(phrase, dict) and phrase.get("progress") is True
            trusted = isinstance(phrase, dict) and phrase.get("trusted") is True
            if isinstance(phrase, dict):
                if phrase.get("queued_at") and metrics.get("last_model_audio_at", 0) >= phrase["queued_at"]:
                    continue  # An answer overtook the queued waiting phrase.
                phrase = phrase["text"]
            # Never synthesize textual tool protocol. It is not an action and
            # must not reach the caller even when the model ignored its schema.
            if not trusted and (metrics.get("control_text_suppressed") or re.search(
                    r"(?:\b(?:hangup_call|farewell_message|function_call|tool_call|mcp_\w+)|<tool|\{\s*\"(?:name|arguments|functionCall)\")", phrase, re.I)):
                metrics["control_text_suppressed"] = True
                logger.warning("Voice control text suppressed", call_id=self._call_id)
                continue
            transcript_sent = False
            metrics["tts_active"] = True
            async with asyncio.timeout(float(self._cfg("tts_timeout_seconds", 15))):
                stream = self._speech.synthesize(phrase, self._cfg("voice_name", "edsel"))
                async with contextlib.aclosing(stream):
                    async for chunk in stream:
                        if generation != self._generation or self._closing:
                            return
                        pcm = tail + chunk
                        tail = pcm[len(pcm) // 2 * 2:]
                        pcm = pcm[:len(pcm) // 2 * 2]
                        if not pcm:
                            continue
                        if not is_progress:
                            metrics.setdefault("first_pcm_at", time.monotonic())
                        pcm, state = resample_audio(pcm, 16000, int(self._cfg("target_sample_rate_hz", 8000)), state=state)
                        codec = self._cfg("target_encoding", "ulaw")
                        data = convert_pcm16le_to_target_format(pcm, codec)
                        if data:
                            await self._emit("AgentAudio", generation=generation, data=data, streaming_chunk=True,
                                             encoding=codec, sample_rate=int(self._cfg("target_sample_rate_hz", 8000)), progress=is_progress)
                            metrics["last_audio_at"] = time.monotonic()
                            if not is_progress:
                                metrics.setdefault("first_audio_emitted_at", time.monotonic())
                                metrics["last_model_audio_at"] = time.monotonic()
                            if not transcript_sent:
                                await self._emit("agent_transcript", generation=generation, text=phrase, is_final=True, role="assistant", progress=is_progress)
                                transcript_sent = True
            metrics["tts_active"] = False
            if not transcript_sent:
                raise RuntimeError("TTS returned no audio")
            if not is_progress and clear_closing(phrase):
                metrics["closing_phrase_played"] = True

    async def _fail(self, reason):
        if self._closing or self._disconnected:
            return
        self._disconnected = True
        await self._emit("ProviderError", error=reason)
        await self._emit("ProviderDisconnected", reason=reason)
        await self.stop_session()

    async def stop_session(self):
        self._closing = True
        self._generation += 1
        current = asyncio.current_task()
        tasks = {self._turn_task, *self._background, *self._tool_batches}
        for task in tasks:
            if task and task is not current and not task.done():
                task.cancel()
        for task in tasks:
            if task and task is not current:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        for client in (self._speech, self._vertex):
            if client:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(client.close(), timeout=3)
        self._speech = self._vertex = self._turn_task = None
        self._background.clear()
        self._tool_batches.clear()
        self._history.clear()
        self._pending_user.clear()
        self._tool_ledger.clear()
        self._active_queue = self._active_metrics = None
        self._last_partial_at = 0.0
