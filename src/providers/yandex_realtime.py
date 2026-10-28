"""Direct server-side Yandex Realtime transport (current nested-audio protocol)."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import inspect
import json
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

import aiohttp
from structlog import get_logger

from .base import AIProviderInterface, ProviderCapabilities
from ..audio import mulaw_to_pcm16le, resample_audio, convert_pcm16le_to_target_format
from ..core.voice_closing import mutual_closing
from ..tools.registry import tool_registry
from ..tools.context import ToolExecutionContext
from ..tools.adapters.sanitize import sanitize_tool_result_for_json_string

logger = get_logger(__name__)
LIVE_VOICES = {
    "sofia": {"casual", "support"}, "vera": {"casual", "support"},
    "vasily": {"support", "sales"}, "sergey": {"support", "sales"},
    "denis": {"casual", "formal", "neutral", "sales"},
    "irina": {"formal", "support", "narrator", "sales", "neutral"},
}
ENDPOINT = "wss://ai.api.cloud.yandex.net/v1/realtime/openai"


def session_output_matches(actual, expected):
    """Require the requested speaker ACK without inventing missing rates.

    LiveTTS returns format.rate=null in session ACKs. Response voice metadata
    can retain the server default even when the actual audio uses the speaker
    acknowledged by session.updated; only that session ACK selects readiness.
    Canonical voice and role names are exact.
    """
    if not isinstance(actual, dict):
        return False
    for key in ("voice", "role"):
        if actual.get(key) != expected[key]:
            return False
    format_ = actual.get("format")
    if format_ is not None:
        if not isinstance(format_, dict):
            return False
        for key in ("type", "rate"):
            if format_.get(key) is not None and format_[key] != expected["format"][key]:
                return False
    return True


class YandexRealtimeProvider(AIProviderInterface):
    def __init__(self, config, on_event, gating_manager=None):
        super().__init__(on_event)
        self.config = config
        self._gating_manager = gating_manager
        self.websocket = None
        self._http = None
        self._receive_task = None
        self._tool_tasks = {}
        self._closing_checks = set()
        self._tool_groups = {}
        self._send_lock = asyncio.Lock()
        self._call_id = None
        self._closing = True
        self._disconnect_emitted = False
        self._response_id = None
        self._interrupted = set()
        self._input_state = self._output_state = None
        self._output_tail = b""
        self._context = {}
        self._ready = asyncio.Event()
        self._startup_error = False
        self._turn_started = None
        self._first_audio = False
        self._input_mode = None
        self._hangup_after_response = False
        self._farewell_response_id = None
        self._response_had_audio = False
        self._transcripts_seen = set()
        self._fast_provider = None
        self._last_user_text = ""
        self._closing_generation = 0
        self._response_generations = {}
        self._response_texts = {}
        self._audio_completed = set()
        self._last_completed_response = None
        self._closing_emitted = False
        self._expected_output = None

    def _cfg(self, name, default=None):
        return getattr(self.config, name, default)

    @property
    def supported_codecs(self):
        return ["ulaw", "slin16"]

    def is_ready(self):
        """Configured availability only; does not prove remote authorization or health."""
        try:
            if not self._cfg("enabled", True):
                return False
            if not str(self._cfg("api_key", "") or "").strip() or not str(self._cfg("folder_id", "") or "").strip():
                return False
            model = str(self._cfg("model", "speech-realtime-max-tts-live/latest") or "")
            folder = str(self._cfg("folder_id"))
            if model not in ("aliceai-llm-flash", "speech-realtime-max-tts-live/latest", f"gpt://{folder}/speech-realtime-max-tts-live/latest"):
                return False
            voice, role = self._cfg("voice", "sofia"), self._cfg("role", "support")
            if voice not in LIVE_VOICES or role not in LIVE_VOICES[voice]:
                return False
            if self._rate() not in (8000, 16000, 22050, 24000, 44100, 48000) or self._out_rate() not in (8000, 16000, 22050, 24000, 44100, 48000):
                return False
            encodings = {"ulaw", "mulaw", "g711_ulaw", "mu-law", "pcm16", "slin16", "slin", "linear16"}
            if self._cfg("input_encoding", "ulaw").lower() not in encodings or self._cfg("target_encoding", "ulaw").lower() not in encodings:
                return False
            return int(self._cfg("input_sample_rate_hz", 8000)) in (8000, 16000, 24000) and int(self._cfg("target_sample_rate_hz", 8000)) in (8000, 16000, 24000)
        except (TypeError, ValueError, AttributeError):
            return False

    def get_capabilities(self):
        return ProviderCapabilities(["ulaw", "pcm16", "slin16"], [8000, 16000, 24000],
                                    ["ulaw", "pcm16", "slin16"], [8000, 16000, 24000],
                                    is_full_agent=True, has_native_vad=self._cfg("model") != "aliceai-llm-flash",
                                    has_native_barge_in=True, requires_continuous_audio=True)

    def set_input_mode(self, mode):
        if mode not in ("mulaw8k", "pcm16_8k", "pcm16_16k"):
            raise ValueError("Unsupported engine input mode")
        self._input_mode = mode
        self._input_state = None
        if self._fast_provider:
            self._fast_provider.set_input_mode(mode)

    def _rate(self):
        return int(self._cfg("provider_input_sample_rate_hz", self._cfg("realtime_sample_rate_hz", 24000)))

    def _out_rate(self):
        return int(self._cfg("output_sample_rate_hz", self._rate()))

    def _session_payload(self):
        voice, role = self._cfg("voice", "sofia"), self._cfg("role", "support")
        if voice not in LIVE_VOICES or role not in LIVE_VOICES[voice]:
            raise ValueError("Unsupported LiveTTS voice/role combination")
        for rate in (self._rate(), self._out_rate()):
            if rate not in (8000, 16000, 22050, 24000, 44100, 48000):
                raise ValueError("Unsupported PCM sample rate")
        return {"type": "session.update", "session": {
            "type": "realtime", "instructions": self._context.get("instructions", self._cfg("instructions", "")),
            "output_modalities": ["audio"], "audio": {
                "input": {"format": {"type": "audio/pcm", "rate": self._rate()},
                          "turn_detection": {"type": "server_vad", "threshold": self._cfg("vad_threshold", 0.5),
                                             "silence_duration_ms": self._cfg("vad_silence_duration_ms", 400)}},
                "output": {"format": {"type": "audio/pcm", "rate": self._out_rate()}, "voice": voice, "role": role}},
            "tools": tool_registry.to_openai_realtime_schema_filtered(self._context.get("tools") or [])}}

    async def _emit(self, kind, **values):
        result = self.on_event({"type": kind, "call_id": self._call_id, **values})
        if inspect.isawaitable(result):
            await result

    async def _disconnect(self, reason):
        if self._disconnect_emitted or self._closing:
            return
        self._disconnect_emitted = True
        await self._emit("ProviderDisconnected", reason=reason)
        await self.stop_session()

    async def _send(self, payload):
        async with self._send_lock:
            if self._closing or self.websocket is None or self.websocket.closed:
                raise RuntimeError("Yandex session is closed")
            await self.websocket.send_json(payload)

    async def start_session(self, call_id, context=None):
        await self.stop_session()
        if self._cfg("model") == "aliceai-llm-flash":
            from .yandex_fast import YandexFastProvider
            delegate = YandexFastProvider(self.config, self.on_event, self._gating_manager)
            for name in ("_business_id", "_session_store", "_ari_client", "_full_config", "_voice_tool_guard",
                         "_caller_channel_id", "_bridge_id", "_caller_number", "_called_number", "_caller_name", "_context_name"):
                if hasattr(self, name):
                    setattr(delegate, name, getattr(self, name))
            if self._input_mode:
                delegate.set_input_mode(self._input_mode)
            self._fast_provider = delegate
            try:
                await delegate.start_session(call_id, context)
            except BaseException:
                await self.stop_session()
                raise
            return
        self._call_id, self._context = call_id, dict(context or {})
        self._input_state = self._output_state = None
        self._output_tail = b""
        self._tool_tasks = {}
        self._tool_groups = {}
        self._interrupted = set()
        self._response_id = None
        self._ready = asyncio.Event()
        self._startup_error = False
        self._hangup_after_response = False
        self._farewell_response_id = None
        self._response_had_audio = False
        self._transcripts_seen = set()
        self._last_user_text = ""
        self._closing_generation = 0
        self._response_generations.clear()
        self._response_texts.clear()
        self._audio_completed.clear()
        self._last_completed_response = None
        self._closing_emitted = False
        payload = self._session_payload()
        self._expected_output = payload["session"]["audio"]["output"]
        key, folder = self._cfg("api_key"), self._cfg("folder_id")
        if not key or not folder:
            raise ValueError("Yandex requires api_key and folder_id")
        model = self._cfg("model", "speech-realtime-max-tts-live/latest")
        uri = f"gpt://{folder}/{model}"
        if str(model).startswith("gpt://"):
            if not str(model).startswith(f"gpt://{folder}/"):
                raise ValueError("Yandex model folder does not match configured folder")
            uri = model
        started = time.monotonic()
        self._closing = False
        self._disconnect_emitted = False
        try:
            self._http = aiohttp.ClientSession(trust_env=False)
            self.websocket = await asyncio.wait_for(self._http.ws_connect(
                ENDPOINT + "?" + urlencode({"model": uri}),
                headers={"Authorization": f"Api-Key {key}", "x-folder-id": folder},
                proxy=None, heartbeat=20.0, max_msg_size=8 * 1024 * 1024),
                timeout=self._cfg("session_timeout_seconds", 10))
            self._receive_task = asyncio.create_task(self._receive())
            await self._send(payload)
            await asyncio.wait_for(self._ready.wait(), self._cfg("session_timeout_seconds", 10))
            if self._startup_error:
                raise RuntimeError("Yandex session configuration rejected")
            greeting = self._context.get("greeting", self._cfg("greeting", ""))
            if greeting:
                await self._send({"type": "response.create", "response": {
                    "instructions": "Произнеси приветствие дословно: " + greeting}})
            logger.info("Yandex session ready", model=model, connect_ms=round((time.monotonic()-started)*1000))
        except BaseException:
            await self.stop_session()
            raise

    async def send_audio(self, audio_chunk, sample_rate=None, encoding=None):
        if self._fast_provider:
            return await self._fast_provider.send_audio(audio_chunk, sample_rate=sample_rate, encoding=encoding)
        if self._closing or not audio_chunk:
            return
        supplied_encoding = encoding
        encoding = self._cfg("input_encoding", "ulaw").lower()
        input_rate = int(self._cfg("input_sample_rate_hz", 8000))
        if self._input_mode:
            encoding = "ulaw" if self._input_mode == "mulaw8k" else "pcm16"
            input_rate = 16000 if self._input_mode == "pcm16_16k" else 8000
        if supplied_encoding is not None:
            encoding = str(supplied_encoding).lower()
        if sample_rate is not None:
            input_rate = int(sample_rate)
        if encoding in ("ulaw", "mulaw", "g711_ulaw", "mu-law"):
            pcm = mulaw_to_pcm16le(audio_chunk)
        elif encoding in ("pcm16", "slin16", "slin", "linear16"):
            pcm = audio_chunk
            if len(pcm) % 2:
                raise ValueError("Input PCM must contain whole int16 samples")
        else:
            raise ValueError("Unsupported input encoding")
        pcm, self._input_state = resample_audio(pcm, input_rate, self._rate(), state=self._input_state)
        await self._send({"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm).decode("ascii")})

    async def cancel_response(self):
        if self._fast_provider:
            return await self._fast_provider.cancel_response()
        self._hangup_after_response = False
        self._farewell_response_id = None
        for group in self._tool_groups.values():
            group["interrupted"] = True
        if self._response_id:
            self._interrupted.add(self._response_id)
            self._response_id = None
            self._output_state = None
            self._output_tail = b""
            await self._send({"type": "response.cancel"})

    async def _handle_event(self, event):
        kind = event.get("type")
        rid = event.get("response_id")
        if kind == "session.updated":
            output = ((event.get("session") or {}).get("audio") or {}).get("output")
            expected = self._expected_output or self._session_payload()["session"]["audio"]["output"]
            if session_output_matches(output, expected):
                self._ready.set()
        elif kind == "error":
            self._startup_error = not self._ready.is_set()
            self._ready.set()
            # Raw provider messages can contain prompts, credentials and tool arguments.
            logger.warning("Yandex protocol error")
            await self._emit("ProviderError", error="yandex_protocol_error")
            if not self._startup_error:
                await self._disconnect("yandex_protocol_error")
        elif kind == "input_audio_buffer.speech_started":
            self._closing_generation += 1
            self._last_user_text = ""
            self._closing_emitted = False
            self._hangup_after_response = False
            self._farewell_response_id = None
            for group in self._tool_groups.values():
                group["interrupted"] = True
            if self._response_id:
                self._interrupted.add(self._response_id)
            self._response_id = None
            self._output_state = None
            self._output_tail = b""
            await self._emit("ProviderBargeIn")
            await self._emit("AgentAudioDone")
        elif kind == "input_audio_buffer.speech_stopped":
            self._turn_started = time.monotonic()
            self._first_audio = False
        elif kind == "response.created":
            self._response_id = (event.get("response") or {}).get("id")
            self._response_had_audio = False
            self._response_generations[self._response_id] = self._closing_generation
            if len(self._response_generations) > 32:
                oldest = next(iter(self._response_generations))
                self._response_generations.pop(oldest, None)
                self._response_texts.pop(oldest, None)
                self._audio_completed.discard(oldest)
            if self._hangup_after_response:
                self._farewell_response_id = self._response_id
                self._hangup_after_response = False
            self._output_state = None
            self._output_tail = b""
        elif kind == "response.output_audio.delta":
            if not self._response_id or rid in self._interrupted or (rid and rid != self._response_id):
                return
            pcm = self._output_tail + base64.b64decode(event["delta"], validate=True)
            self._output_tail = pcm[len(pcm) // 2 * 2:]
            pcm = pcm[:len(pcm) // 2 * 2]
            pcm, self._output_state = resample_audio(pcm, self._out_rate(), int(self._cfg("target_sample_rate_hz", 8000)), state=self._output_state)
            encoding = self._cfg("target_encoding", "ulaw")
            data = convert_pcm16le_to_target_format(pcm, encoding)
            if data:
                self._response_had_audio = True
                await self._emit("AgentAudio", data=data, streaming_chunk=True, encoding=encoding,
                                 sample_rate=int(self._cfg("target_sample_rate_hz", 8000)))
                if self._turn_started and not self._first_audio:
                    logger.info("Yandex first turn audio", latency_ms=round((time.monotonic()-self._turn_started)*1000))
                    self._first_audio = True
        elif kind == "response.output_audio.done":
            if self._response_id and (not rid or rid == self._response_id):
                await self._emit("AgentAudioDone")
                if self._response_had_audio:
                    self._audio_completed.add(self._response_id)
                    self._last_completed_response = self._response_id
                if self._farewell_response_id == self._response_id and self._response_had_audio:
                    self._farewell_response_id = None
                    self._closing_emitted = True
                    await self._emit("HangupReady", reason="farewell_completed", had_audio=True)
                else:
                    await self._maybe_finish_closing(self._response_id)
        elif kind == "response.done":
            response = event.get("response") or {}
            if response.get("status") in ("failed", "incomplete"):
                await self._disconnect("yandex_response_failed")
                return
            if response.get("id") == self._farewell_response_id:
                if response.get("status") == "completed" and not self._response_had_audio:
                    self._farewell_response_id = None
                    await self._emit("ProviderError", error="yandex_farewell_no_audio")
                    await self._emit("HangupReady", reason="farewell_no_audio", had_audio=False)
                    return
                if response.get("status") == "cancelled":
                    self._farewell_response_id = None
            if response.get("id") == self._response_id:
                self._response_id = None
            group = self._tool_groups.get(response.get("id"))
            if group is not None:
                group["done"] = response.get("status") == "completed"
                if not group["done"]:
                    group["interrupted"] = True
                await self._continue_tool_group(response.get("id"))
        elif kind in ("conversation.item.input_audio_transcription.completed", "response.output_text.done", "response.output_audio_transcript.done"):
            role = "user" if kind.startswith("conversation.") else "assistant"
            text = event.get("transcript", event.get("text", ""))
            key = (event.get("item_id") or rid, role, text)
            if text and key not in self._transcripts_seen:
                self._transcripts_seen.add(key)
                await self._emit("transcript" if role == "user" else "agent_transcript",
                                 text=text, is_final=True, role=role)
                response_id = rid or self._response_id or self._last_completed_response
                if role == "user":
                    self._last_user_text = text
                elif response_id:
                    self._response_texts[response_id] = (self._response_texts.get(response_id, "") + " " + text).strip()
                await self._maybe_finish_closing(response_id)
        elif kind == "response.output_item.done" and (event.get("item") or {}).get("type") == "function_call":
            item = event["item"]
            call_id = item.get("call_id")
            if call_id and call_id not in self._tool_tasks:
                response_id = rid or self._response_id
                if response_id:
                    group = self._tool_groups.setdefault(response_id, {
                        "pending": set(), "done": False, "continued": False,
                        "interrupted": response_id in self._interrupted, "farewell": None, "speech_blocked": False})
                    group["pending"].add(call_id)
                task = asyncio.create_task(self._execute_tool(item, response_id=response_id))
                self._tool_tasks[call_id] = task
                def completed(done):
                    if not done.cancelled():
                        done.exception()
                    if self._closing:
                        return
                    check = asyncio.create_task(self._maybe_finish_closing(self._last_completed_response))
                    self._closing_checks.add(check)
                    def checked(value):
                        self._closing_checks.discard(value)
                        if not value.cancelled():
                            value.exception()
                    check.add_done_callback(checked)
                task.add_done_callback(completed)

    async def _continue_tool_group(self, response_id):
        group = self._tool_groups.get(response_id)
        if (not group or group["pending"] or group["continued"] or group.get("flushing")
                or group["interrupted"] or self._closing):
            return
        group["flushing"] = True
        try:
            # Collect outputs already arriving in the same WebSocket batch.
            # Yandex requires function_call_output followed by response.create;
            # waiting for response.done between them can cause internal_error.
            await asyncio.sleep(.02)
            if (group["pending"] or group["continued"] or group["interrupted"] or self._closing
                    or self._response_id and self._response_id != response_id):
                return
            group["continued"] = True
            for payload in group.get("outputs", []):
                await self._send(payload)
            if not group["speech_blocked"]:
                await self._send_tool_continuation(group["farewell"])
        finally:
            group["flushing"] = False

    async def _maybe_finish_closing(self, response_id):
        # Native transcripts and audio-done can arrive in either order. Only
        # completed audio from this caller turn may release the call.
        if (self._closing or not response_id or self._closing_emitted
                or any(not task.done() for task in self._tool_tasks.values()) or response_id in self._interrupted
                or response_id not in self._audio_completed
                or self._response_generations.get(response_id) != self._closing_generation
                or not tool_registry.is_tool_allowed("hangup_call", self._context.get("tools") or [])):
            return
        if mutual_closing(self._last_user_text, self._response_texts.get(response_id, "")):
            self._closing_emitted = True
            await self._emit("HangupReady", reason="farewell_completed", had_audio=True)

    async def _send_tool_continuation(self, farewell=None):
        response = {"type": "response.create"}
        if farewell:
            self._hangup_after_response = True
            response["response"] = {"instructions": "Произнеси прощание и больше не вызывай инструменты: " + farewell}
        await self._send(response)

    async def _execute_tool(self, item, response_id=None):
        name, invocation = item.get("name"), item["call_id"]
        started = time.monotonic()
        result = {"status": "error", "message": "Tool execution failed"}
        try:
            args = json.loads(item.get("arguments") or "{}")
            if not isinstance(args, dict):
                raise ValueError("Tool arguments must be an object")
            allowed = self._context.get("tools") or []
            if not tool_registry.is_tool_allowed(name, allowed):
                raise ValueError("Tool is not allowed")
            tool = tool_registry.get(name)
            if tool is None:
                raise ValueError("Unknown tool")
            if name == "hangup_call" and not self._last_user_text:
                # Native STT can arrive after the tool event. This task is
                # separate from the receive loop; wait briefly, never fail open.
                deadline = time.monotonic() + .8
                while not self._last_user_text and not self._closing and time.monotonic() < deadline:
                    await asyncio.sleep(.02)
            context = ToolExecutionContext(call_id=self._call_id, business_id=int(getattr(self, "_business_id", self._context.get("business_id", 1))),
                autopilot_allowed_actions=list(self._context.get("autopilot_allowed_actions") or []),
                session_store=getattr(self, "_session_store", None), ari_client=getattr(self, "_ari_client", None),
                config=getattr(self, "_full_config", None), provider_name="yandex_realtime",
                runtime_guard=getattr(self, "_voice_tool_guard", None),
                caller_channel_id=getattr(self, "_caller_channel_id", None), bridge_id=getattr(self, "_bridge_id", None),
                caller_number=getattr(self, "_caller_number", None), called_number=getattr(self, "_called_number", None),
                user_input=self._last_user_text)
            async def execute():
                blocked = await context.get_tool_block_response(name)
                if blocked:
                    return blocked
                if self._closing or (response_id and (response_id in self._interrupted
                        or self._tool_groups.get(response_id, {}).get("interrupted"))):
                    return {"status": "error", "code": "tool_not_submitted", "outcome": "cancelled",
                            "message": "Caller interrupted before this action was submitted."}
                executor = self._context.get("tool_executor")
                if executor:
                    return await executor(name, args, context, idempotency_key=f"yandex:{self._call_id}:{invocation}")
                return await tool.execute(args, context)
            result = await asyncio.wait_for(execute(), timeout=float(self._cfg("tool_timeout_seconds", 30)))
            result = sanitize_tool_result_for_json_string(result, keep_keys=(
                "status", "message", "data", "code", "outcome", "ai_should_speak",
                "will_hangup", "transferred", "transfer_mode", "extension", "destination", "error"))
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            result = {"status": "error", "code": "tool_timeout", "outcome": "unknown",
                      "message": "Tool timed out; completion is unconfirmed. Do not retry this action automatically."}
            logger.warning("Yandex tool timed out")
        except Exception:
            logger.warning("Yandex tool execution failed")
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._record_tool(name, invocation, result, started), timeout=3)
        if not self._closing:
            try:
                payload = {"type": "conversation.item.create", "item": {
                    "type": "function_call_output", "call_id": invocation, "output": json.dumps(result, ensure_ascii=False)}}
                farewell = str(result.get("message") or "До свидания.") if name == "hangup_call" and result.get("will_hangup") else None
                if response_id:
                    group = self._tool_groups[response_id]
                    group.setdefault("outputs", []).append(payload)
                    group["pending"].discard(invocation)
                    if result.get("ai_should_speak") is False:
                        group["speech_blocked"] = True
                    if farewell:
                        group["farewell"] = farewell
                    await self._continue_tool_group(response_id)
                elif result.get("ai_should_speak") is not False:
                    # Compatibility with direct tool adapters without a response
                    # envelope; live output_item events always carry a group.
                    await self._send(payload)
                    await self._send_tool_continuation(farewell)
                else:
                    await self._send(payload)
            except Exception:
                logger.warning("Yandex tool result delivery failed")
                await self._disconnect("yandex_tool_delivery_failed")

    async def _record_tool(self, name, invocation, result, started):
        store = getattr(self, "_session_store", None)
        if not store:
            return
        try:
            session = await store.get_by_call_id(self._call_id)
            if session:
                if getattr(session, "tool_calls", None) is None:
                    session.tool_calls = []
                session.tool_calls.append({
                    "name": name, "call_id": invocation, "params": {},
                    "result": result.get("status", "unknown"),
                    "message": "", "timestamp": datetime.now(timezone.utc).isoformat(),
                    "duration_ms": round((time.monotonic() - started) * 1000),
                })
                await store.upsert_call(session)
        except Exception:
            logger.warning("Yandex tool history save failed")

    async def _receive(self):
        try:
            async for message in self.websocket:
                if message.type == aiohttp.WSMsgType.TEXT:
                    event = json.loads(message.data)
                    if not self._ready.is_set() and str(event.get("type", "")).startswith("response."):
                        self._startup_error = True
                        self._ready.set()
                        await self._disconnect("yandex_response_before_ready")
                        return
                    await self._handle_event(event)
                elif message.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSE):
                    break
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("Yandex receive failed")
        finally:
            if not self._closing:
                self._startup_error = not self._ready.is_set()
                self._ready.set()
                await self._disconnect("yandex_connection_closed")

    async def stop_session(self):
        delegate, self._fast_provider = self._fast_provider, None
        if delegate:
            await delegate.stop_session()
        self._closing = True
        tasks = [self._receive_task, *self._tool_tasks.values(), *self._closing_checks]
        for task in tasks:
            if task and task is not asyncio.current_task() and not task.done():
                task.cancel()
        for task in tasks:
            if task and task is not asyncio.current_task():
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        if self.websocket:
            await self.websocket.close()
        if self._http:
            await self._http.close()
        self.websocket = self._http = self._receive_task = None
        self._response_id = None
        self._tool_groups.clear()
