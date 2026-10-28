"""Direct Yandex SpeechKit -> Alice Flash -> LiveTTS, using AVA's existing agent.

No Realtime LLM session is opened in this mode. Per-call history, action fences,
tenant context and cancellation are inherited from the production full agent.
"""
from __future__ import annotations

import asyncio
import base64
import json
import time

import aiohttp
import numpy as np

from .neuro_gemini import NeuroGeminiProvider
from .neuro_vertex import VertexClientError
from .yandex_realtime import session_output_matches


class YandexFastError(VertexClientError):
    def __init__(self, code):
        super().__init__(code)


class YandexText:
    def __init__(self, config):
        self.config = config
        self.http = None
        self.last_request_metrics = {}

    def session(self):
        if self.http is None:
            self.http = aiohttp.ClientSession(trust_env=False, timeout=aiohttp.ClientTimeout(total=8, sock_connect=3, sock_read=4))
        return self.http

    @staticmethod
    def messages(history, instructions):
        result = [{"role": "system", "content": instructions}]
        for item in history:
            parts = item.get("parts", [])
            text = "".join(p.get("text", "") for p in parts)
            if item["role"] == "model":
                calls = [{"id": p["functionCall"]["id"], "type": "function", "function": {
                    "name": p["functionCall"]["name"], "arguments": json.dumps(p["functionCall"]["args"], ensure_ascii=False)}}
                    for p in parts if "functionCall" in p]
                message = {"role": "assistant", "content": text or None}
                if calls:
                    message["tool_calls"] = calls
                result.append(message)
            else:
                if text:
                    result.append({"role": "user", "content": text})
                for part in parts:
                    if "functionResponse" in part:
                        value = part["functionResponse"]
                        result.append({"role": "tool", "tool_call_id": value["id"], "content": json.dumps(value["response"], ensure_ascii=False)})
        return result

    async def stream(self, history, instructions="", tools=None, model="aliceai-llm-flash"):
        # Some completions terminate without a usable tool call. Retry once
        # only before any output is exposed: no speech or action can have
        # escaped this generation. The full-agent turn deadline still applies.
        for attempt in range(2):
            emitted = False
            try:
                async for event in self._stream_once(history, instructions, tools, model):
                    emitted = True
                    yield event
                return
            except YandexFastError as error:
                if emitted or attempt or error.code != "yandex_text_incomplete":
                    raise

    async def _stream_once(self, history, instructions="", tools=None, model="aliceai-llm-flash"):
        if model != "aliceai-llm-flash":
            raise YandexFastError("yandex_invalid_model")
        payload = {"model": f"gpt://{self.config.folder_id}/{model}", "messages": self.messages(history, instructions),
                   "stream": True, "max_tokens": 512, "temperature": 0.3}
        declarations = [value for group in (tools or []) for value in group.get("functionDeclarations", [])]
        if declarations:
            payload["tools"] = [{"type": "function", "function": {"name": value["name"], "description": value["description"],
                                 "parameters": value["parametersJsonSchema"]}} for value in declarations]
        started = time.monotonic()
        self.last_request_metrics = {"phase": "headers"}
        # Retry a rejected request once, before any generation/tool output exists.
        for attempt in range(2):
            response = await self.session().post("https://ai.api.cloud.yandex.net/v1/chat/completions",
                headers={"Authorization": "Api-Key " + self.config.api_key}, json=payload)
            if response.status == 429 and attempt == 0:
                response.release()
                await asyncio.sleep(.4)
                continue
            break
        async with response:
            if response.status != 200:
                raise YandexFastError("yandex_text_rate_limit" if response.status == 429 else "yandex_text_unavailable")
            self.last_request_metrics.update(phase="body", headers_ms=(time.monotonic()-started)*1000)
            text, calls, terminal, frames = [], {}, False, 0
            async for line in response.content:
                if len(line) > 131072:
                    raise YandexFastError("yandex_text_frame_limit")
                if not line.startswith(b"data:"):
                    continue
                raw = line[5:].strip()
                if raw == b"[DONE]":
                    break
                event = json.loads(raw)
                choices = event.get("choices") or []
                if not choices:
                    continue
                frames += 1
                if frames > 4096:
                    raise YandexFastError("yandex_text_frame_limit")
                choice = choices[0]
                delta = choice.get("delta") or {}
                if delta.get("content"):
                    value = delta["content"]
                    text.append(value)
                    if sum(len(part.encode()) for part in text) > 65536:
                        raise YandexFastError("yandex_text_limit")
                    yield {"type": "text", "text": value}
                for call in delta.get("tool_calls") or []:
                    index = call.get("index", 0)
                    if not isinstance(index, int) or not 0 <= index < 16:
                        raise YandexFastError("yandex_tool_limit")
                    value = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                    if call.get("id"):
                        value["id"] = call["id"]
                    function = call.get("function") or {}
                    value["name"] += function.get("name") or ""
                    value["arguments"] += function.get("arguments") or ""
                    if len(value["arguments"].encode()) > 32000:
                        raise YandexFastError("yandex_tool_limit")
                finish = choice.get("finish_reason")
                if finish:
                    if finish not in ("stop", "tool_calls"):
                        raise YandexFastError("yandex_text_incomplete")
                    terminal = True
            if not terminal or not (text or calls):
                raise YandexFastError("yandex_text_incomplete")
            parts = [{"text": "".join(text)}] if text else []
            for _, call in sorted(calls.items()):
                args = json.loads(call["arguments"], parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Invalid number")))
                if not call["id"] or not call["name"] or not isinstance(args, dict):
                    raise YandexFastError("yandex_invalid_tool_call")
                parts.append({"functionCall": {"id": call["id"], "name": call["name"], "args": args}})
            self.last_request_metrics.update(phase="complete", elapsed_ms=(time.monotonic()-started)*1000, frames=frames)
            yield {"type": "content", "content": {"role": "model", "parts": parts}}

    async def close(self):
        if self.http:
            await self.http.close()
            self.http = None


class YandexSpeech:
    """Bounded utterance recognition. Network I/O never blocks the audio hot path."""
    def __init__(self, config):
        self.config = config
        self.http = None
        self.callback = None
        self.buffer = bytearray()
        self.pre_roll = bytearray()
        self.silence_ms = 0
        self.active = False
        self.closed = False
        self.queue = asyncio.Queue(maxsize=4)
        self.worker = None
        self.idle_worker = None
        self.last_audio_at = 0
        self.final_parts = []

    def session(self):
        if self.http is None:
            self.http = aiohttp.ClientSession(trust_env=False, timeout=aiohttp.ClientTimeout(total=6, sock_connect=3))
        return self.http

    async def start_asr(self, callback):
        self.callback = callback
        self.worker = asyncio.create_task(self._recognize())
        self.idle_worker = asyncio.create_task(self._flush_idle())

    async def _flush_idle(self):
        while not self.closed:
            await asyncio.sleep(.1)
            # AudioSocket/RTP may omit silence packets. A frame-count-only VAD
            # leaves a complete utterance pending forever on those connections.
            if self.active and time.monotonic()-self.last_audio_at >= .45:
                await self.commit()

    async def send_audio(self, pcm16, sample_rate=16000):
        if self.closed or sample_rate != 16000 or len(pcm16) % 2:
            raise YandexFastError("yandex_asr_invalid_audio")
        if not pcm16:
            return
        self.last_audio_at = time.monotonic()
        samples = np.frombuffer(pcm16, dtype="<i2").astype(np.float64)
        speech = float(np.sqrt(np.mean(samples*samples))) >= 600
        if not self.active:
            self.pre_roll.extend(pcm16)
            del self.pre_roll[:-6400]  # 200 ms before the first speech frame.
            if not speech:
                return
            self.active = True
            self.buffer.extend(self.pre_roll)
            self.pre_roll.clear()
            await self.callback({"type": "speech_started"})
        else:
            self.buffer.extend(pcm16)
        self.silence_ms = 0 if speech else self.silence_ms + len(pcm16)/32
        if self.silence_ms >= 450:
            await self.commit()
        elif len(self.buffer) >= 640000:
            # V1 accepts <=1 MB. Join long utterance segments before a model turn.
            self._enqueue(bytes(self.buffer), False)
            self.buffer.clear()

    def _enqueue(self, audio, final):
        try:
            self.queue.put_nowait((audio, final))
        except asyncio.QueueFull:
            raise YandexFastError("yandex_asr_backpressure") from None

    async def commit(self):
        if self.active:
            self._enqueue(bytes(self.buffer), True)
            self.buffer.clear()
            self.active = False
            self.silence_ms = 0

    async def _recognize(self):
        try:
            while not self.closed:
                audio, final = await self.queue.get()
                async with self.session().post("https://stt.api.cloud.yandex.net/speech/v1/stt:recognize",
                    headers={"Authorization": "Api-Key " + self.config.api_key},
                    params={"folderId": self.config.folder_id, "lang": "ru-RU", "format": "lpcm", "sampleRateHertz": "16000"}, data=audio) as response:
                    if response.status != 200:
                        raise YandexFastError("yandex_asr_rate_limit" if response.status == 429 else "yandex_asr_unavailable")
                    value = await response.json()
                    text = value.get("result", "")
                    if not isinstance(text, str) or len(text) > 32768:
                        raise YandexFastError("yandex_asr_invalid_transcript")
                    if text.strip():
                        self.final_parts.append(text.strip())
                    if len(" ".join(self.final_parts)) > 32768:
                        raise YandexFastError("yandex_asr_transcript_limit")
                if final:
                    text = " ".join(self.final_parts)
                    self.final_parts.clear()
                    await self.callback({"type": "final" if text else "speech_empty", "text": text, "received_at": time.monotonic()})
                    if self.active or not self.queue.empty():
                        # A newer utterance may have started while HTTP was in
                        # flight. Its action fence must survive this older final.
                        await self.callback({"type": "speech_started"})
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if not self.closed:
                await self.callback({"type": "error", "code": error.code if isinstance(error, YandexFastError) else "yandex_asr_unavailable"})

    async def synthesize(self, text, voice):
        uri = f"gpt://{self.config.folder_id}/speech-realtime-tts-live/latest"
        from urllib.parse import urlencode
        expected = {"format": {"type": "audio/pcm", "rate": 16000}, "voice": voice, "role": self.config.role}
        async with self.session().ws_connect("wss://ai.api.cloud.yandex.net/v1/realtime/openai?" + urlencode({"model": uri}),
                headers={"Authorization": "Api-Key " + self.config.api_key}, timeout=3, max_msg_size=1048576) as ws:
            await ws.send_json({"type": "session.update", "session": {"type": "realtime", "output_modalities": ["audio"],
                "audio": {"output": expected}}})
            started, count, response_id = False, 0, None
            async with asyncio.timeout(6):
                async for message in ws:
                    if message.type != aiohttp.WSMsgType.TEXT:
                        raise YandexFastError("yandex_tts_closed")
                    event = json.loads(message.data)
                    kind = event.get("type")
                    if kind == "session.updated" and not started:
                        output = ((event.get("session") or {}).get("audio") or {}).get("output")
                        if not session_output_matches(output, expected):
                            continue
                        started = True
                        await ws.send_json({"type": "conversation.item.create", "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}})
                        await ws.send_json({"type": "response.create"})
                    elif kind == "response.created":
                        response_id = (event.get("response") or {}).get("id")
                        if not started or not response_id:
                            raise YandexFastError("yandex_tts_unexpected_response")
                    elif kind == "response.output_audio.delta":
                        if not started or not response_id:
                            raise YandexFastError("yandex_tts_unexpected_response")
                        if event.get("response_id") and event["response_id"] != response_id:
                            continue
                        pcm = base64.b64decode(event["delta"], validate=True)
                        if len(pcm) % 2:
                            raise YandexFastError("yandex_tts_invalid_audio")
                        count += len(pcm)
                        if count > 16000*2*30:
                            raise YandexFastError("yandex_tts_audio_limit")
                        yield pcm
                    elif kind == "response.done":
                        if not started or not response_id:
                            raise YandexFastError("yandex_tts_unexpected_response")
                        if event.get("response", {}).get("id") != response_id:
                            continue
                        if not count or event.get("response", {}).get("status") != "completed":
                            raise YandexFastError("yandex_tts_incomplete")
                        return
                    elif kind == "error":
                        raise YandexFastError("yandex_tts_unavailable")
            raise YandexFastError("yandex_tts_incomplete")

    async def close(self):
        self.closed = True
        if self.idle_worker:
            self.idle_worker.cancel()
            await asyncio.gather(self.idle_worker, return_exceptions=True)
        if self.worker and self.worker is not asyncio.current_task():
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
        self.buffer.clear()
        self.final_parts.clear()
        if self.http:
            await self.http.close()
            self.http = None


class YandexFastProvider(NeuroGeminiProvider):
    provider_name = "yandex_realtime"

    def get_capabilities(self):
        capabilities = super().get_capabilities()
        # SpeechKit HTTP receives our locally segmented utterances. An upstream
        # server-VAD squelch would filter the signal a second time and lose words.
        capabilities.has_native_vad = False
        return capabilities

    def _cfg(self, name, default=None):
        if name == "voice_name":
            return getattr(self.config, "voice", default)
        if name == "vad_threshold":
            return 600
        if name in ("turn_timeout_seconds", "model_timeout_seconds", "tts_timeout_seconds"):
            return {"turn_timeout_seconds": 18, "model_timeout_seconds": 8, "tts_timeout_seconds": 6}[name]
        return super()._cfg(name, default)

    def is_ready(self):
        return bool(self._cfg("enabled", True) and self._cfg("api_key") and self._cfg("folder_id") and self._cfg("model") == "aliceai-llm-flash")

    def _new_speech(self):
        return YandexSpeech(self.config)

    def _new_vertex(self):
        return YandexText(self.config)

    async def _on_asr(self, event):
        if event.get("type") == "speech_started":
            self._speech_committed.clear()
            return
        if event.get("type") == "speech_empty":
            self._speech_committed.set()
            return
        await super()._on_asr(event)
