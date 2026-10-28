"""Direct Neuro Speech ASR/TTS transports.

Wire contract: https://speech.neuro.net/app/docs (verified 2026-10-14).
No SDK compatibility assumptions, HTTP proxy inheritance, or provider error bodies
are used. The orchestrator owns VAD, generation fencing, and phrase scheduling.
"""
from __future__ import annotations

import asyncio
import contextlib
import base64
import binascii
import inspect
import json
import os
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from typing import Any
from urllib.parse import quote, urlencode, urlsplit

import aiohttp


class NeuroSpeechError(RuntimeError):
    """A bounded, safe error code; never includes provider response text or keys."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


_ASR_ERRORS = frozenset({
    "auth_error", "quota_exceeded", "rate_limited", "resource_exhausted",
    "transcriber_error", "input_error", "chunk_size_exceeded",
    "session_time_limit_exceeded", "invalid_request", "error",
})
_SAFE_CODES = frozenset({
    "invalid_api_key", "revoked_api_key", "expired_api_key", "api_access_required",
    "insufficient_scope", "workspace_suspended", "quota_exceeded", "rate_limited",
    "capacity_exhausted", "upstream_overloaded", "upstream_unavailable",
    "concurrency_limit_exceeded", "rate_limit_exceeded",
    "request_timeout", "text_too_long", "unsupported_model", "voice_not_found",
    "unsupported_parameter", "unsupported_output_format", "inactivity_timeout",
})


class NeuroSpeech:
    """One call's ASR socket and cancellable, independently closed TTS phrases.

    Config may be a Pydantic object or mapping. Credentials are supplied through
    ``neuro_api_key`` / ``api_key`` or NEURO_API_KEY. No credentials are loaded
    from private files by this library. There are no unbounded audio queues:
    callers receive backpressure from sends, callbacks, and the TTS iterator.
    """

    def __init__(self, config: Any):
        def value(*names: str, default: Any = None) -> Any:
            for name in names:
                found = config.get(name) if isinstance(config, Mapping) else getattr(config, name, None)
                if found is not None:
                    if hasattr(found, "get_secret_value"):
                        found = found.get_secret_value()
                    return found
            return default

        self._api_key = str(value("neuro_api_key", "api_key", default=os.environ.get("NEURO_API_KEY", "")))
        self._base_url = str(value("neuro_base_url", "endpoint", default="https://speech.neuro.net")).rstrip("/")
        parsed = urlsplit(self._base_url)
        if (parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ("", "/") or not parsed.hostname
                or parsed.scheme not in ("http", "https")
                or (parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"))):
            raise NeuroSpeechError("invalid_endpoint")
        self.sample_rate = int(value("asr_sample_rate", "provider_input_sample_rate_hz", default=16000))
        if self.sample_rate not in (8000, 16000):
            raise NeuroSpeechError("unsupported_sample_rate")
        silence = value("asr_silence_seconds")
        if silence is None:
            silence = float(value("vad_silence_ms", default=500)) / 1000
        self.silence_seconds = float(silence)
        if not .3 <= self.silence_seconds <= 3:
            raise NeuroSpeechError("invalid_vad_silence")
        self.connect_timeout = self._positive(value("connect_timeout", "session_timeout_seconds", default=10))
        self.asr_read_timeout = self._positive(value("asr_read_timeout", "asr_timeout_seconds", default=65))
        self.tts_read_timeout = self._positive(value("tts_read_timeout", "tts_timeout_seconds", default=15))
        self.tts_total_timeout = self._positive(value("tts_total_timeout", default=45))
        self.close_timeout = self._positive(value("close_timeout", default=2))
        self.callback_timeout = self._positive(value("callback_timeout", default=5))
        self.max_audio_chunk_bytes = int(value("max_audio_chunk_bytes", default=6400))
        self.max_message_bytes = int(value("max_audio_bytes", default=2 * 1024 * 1024))
        self.max_tts_audio_bytes = int(value("max_tts_audio_bytes", default=4 * 1024 * 1024))
        self.max_tts_text_chars = int(value("max_tts_text_chars", default=2000))
        if min(self.max_audio_chunk_bytes, self.max_message_bytes, self.max_tts_audio_bytes, self.max_tts_text_chars) <= 0 or self.max_audio_chunk_bytes % 2:
            raise NeuroSpeechError("invalid_transport_limit")
        self._session: aiohttp.ClientSession | None = None
        self._asr_ws: aiohttp.ClientWebSocketResponse | None = None
        self._tts_sockets: set[aiohttp.ClientWebSocketResponse] = set()
        self._reader: asyncio.Task | None = None
        self._callback: Callable[[dict], Awaitable[None] | None] | None = None
        self._send_lock = asyncio.Lock()
        self._closed = False
        self._stopping = False
        self._asr_error: str | None = None
        self.metrics: dict[str, Any] = {"asr_audio_bytes": 0, "asr_partials": 0, "asr_finals": 0}
        self.last_tts_metrics: dict[str, Any] = {}

    @staticmethod
    def _positive(value: Any) -> float:
        number = float(value)
        if not 0 < number <= 14400:
            raise NeuroSpeechError("invalid_transport_timeout")
        return number

    def _get_session(self) -> aiohttp.ClientSession:
        if self._closed:
            raise NeuroSpeechError("transport_closed")
        if not self._api_key:
            raise NeuroSpeechError("missing_api_key")
        if self._session is None:
            self._session = aiohttp.ClientSession(
                trust_env=False,
                timeout=aiohttp.ClientTimeout(total=None, sock_connect=self.connect_timeout),
            )
        return self._session

    def _url(self, path: str, params: dict[str, Any]) -> str:
        return self._base_url.replace("https://", "wss://", 1).replace("http://", "ws://", 1) + path + "?" + urlencode(params)

    async def _connect(self, url: str) -> aiohttp.ClientWebSocketResponse:
        return await asyncio.wait_for(
            self._get_session().ws_connect(
                url, headers={"xi-api-key": self._api_key}, proxy=None,
                timeout=aiohttp.ClientWSTimeout(ws_receive=None, ws_close=self.close_timeout),
                max_msg_size=self.max_message_bytes,
            ), self.connect_timeout,
        )

    @staticmethod
    def _decode(message: aiohttp.WSMessage) -> dict[str, Any]:
        if message.type != aiohttp.WSMsgType.TEXT:
            raise NeuroSpeechError("unexpected_ws_message")
        try:
            result = json.loads(message.data)
        except (ValueError, TypeError):
            raise NeuroSpeechError("invalid_json") from None
        if not isinstance(result, dict):
            raise NeuroSpeechError("invalid_message")
        return result

    @staticmethod
    def _error_code(data: dict[str, Any], default: str) -> str:
        # Neuro's error/message strings may contain echoed input. Never expose
        # them. Whitelist documented identifiers only.
        error = data.get("error")
        candidates = [error, data.get("code")]
        if isinstance(error, dict):
            candidates.append(error.get("code"))
        detail = data.get("detail")
        if isinstance(detail, dict):
            candidates.append(detail.get("status"))
        for code in candidates:
            if isinstance(code, str) and code in _SAFE_CODES:
                return code
        return default

    async def _emit(self, event: dict[str, Any]) -> None:
        if self._callback is None or self._stopping:
            return
        result = self._callback(event)
        if inspect.isawaitable(result):
            await asyncio.wait_for(result, self.callback_timeout)

    async def start_asr(self, on_event: Callable[[dict], Awaitable[None] | None]) -> None:
        """Wait for authenticated ``session_started`` before accepting audio."""
        if self._asr_ws is not None or self._reader is not None:
            raise NeuroSpeechError("asr_already_started")
        self._callback = on_event
        self.metrics["asr_connect_started_at"] = time.monotonic()
        try:
            self._asr_ws = await self._connect(self._url("/v1/speech-to-text/realtime", {
                "model_id": "neuro_asr_v2", "audio_format": f"pcm_{self.sample_rate}",
                "sample_rate": self.sample_rate, "commit_strategy": "vad",
                "language_code": "ru", "include_timestamps": "true",
                "vad_silence_threshold_secs": self.silence_seconds,
            }))
            first = self._decode(await asyncio.wait_for(self._asr_ws.receive(), self.connect_timeout))
            if first.get("message_type") != "session_started":
                raise NeuroSpeechError(self._error_code(first, "asr_auth_failed"))
            self.metrics["asr_started_at"] = time.monotonic()
            self._reader = asyncio.create_task(self._read_asr(), name="neuro-asr-reader")
        except asyncio.CancelledError:
            await self.close()
            raise
        except NeuroSpeechError:
            await self.close()
            raise
        except Exception:
            await self.close()
            raise NeuroSpeechError("asr_connect_failed") from None

    async def send_audio(self, pcm16: bytes, sample_rate: int = 16000) -> None:
        if sample_rate != self.sample_rate:
            raise NeuroSpeechError("sample_rate_mismatch")
        if len(pcm16) % 2:
            raise NeuroSpeechError("unaligned_pcm16")
        if not pcm16:
            return
        if self._asr_ws is None or self._asr_ws.closed or self._asr_error or self._closed:
            raise NeuroSpeechError(self._asr_error or "asr_not_running")
        try:
            async with self._send_lock:
                for offset in range(0, len(pcm16), self.max_audio_chunk_bytes):
                    chunk = pcm16[offset:offset + self.max_audio_chunk_bytes]
                    await asyncio.wait_for(self._asr_ws.send_json({
                        "message_type": "input_audio_chunk",
                        "audio_base_64": base64.b64encode(chunk).decode("ascii"), "commit": False,
                    }), self.connect_timeout)
                    self.metrics["asr_audio_bytes"] += len(chunk)
                    self.metrics["asr_last_audio_sent_at"] = time.monotonic()
        except asyncio.CancelledError:
            raise
        except Exception:
            raise NeuroSpeechError("asr_send_failed") from None

    async def commit(self) -> None:
        """Explicit documented endpointing, useful after local VAD speech end."""
        if self._asr_ws is None or self._asr_ws.closed or self._asr_error or self._closed:
            raise NeuroSpeechError(self._asr_error or "asr_not_running")
        try:
            async with self._send_lock:
                await asyncio.wait_for(self._asr_ws.send_json({
                    "message_type": "input_audio_chunk", "audio_base_64": "", "commit": True,
                }), self.connect_timeout)
        except asyncio.CancelledError:
            raise
        except Exception:
            raise NeuroSpeechError("asr_send_failed") from None

    async def _read_asr(self) -> None:
        try:
            while not self._stopping:
                message = await asyncio.wait_for(self._asr_ws.receive(), self.asr_read_timeout)
                if message.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    if not self._stopping:
                        raise NeuroSpeechError("asr_connection_closed")
                    return
                data = self._decode(message)
                kind = data.get("message_type")
                if kind in _ASR_ERRORS or data.get("error"):
                    raise NeuroSpeechError(self._error_code(data, "asr_provider_error"))
                if kind not in ("partial_transcript", "committed_transcript", "committed_transcript_with_timestamps"):
                    continue
                text = data.get("text", "")
                if not isinstance(text, str):
                    raise NeuroSpeechError("invalid_transcript")
                if len(text) > 32768:
                    raise NeuroSpeechError("transcript_too_large")
                received_at = time.monotonic()
                event = {"type": "partial", "text": text, "is_final": False, "received_at": received_at}
                if kind == "committed_transcript":
                    event.update(type="final", is_final=True)
                    self.metrics["asr_finals"] += 1
                    self.metrics["asr_final_at"] = received_at
                elif kind == "committed_transcript_with_timestamps":
                    # This accompanies committed_transcript. It must not trigger
                    # a second model turn or repeat a side-effecting tool.
                    event.update(type="timestamps", words=data.get("words", []), language_code=data.get("language_code"))
                else:
                    self.metrics["asr_partials"] += 1
                await self._emit(event)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._asr_error = exc.code if isinstance(exc, NeuroSpeechError) else ("asr_read_timeout" if isinstance(exc, asyncio.TimeoutError) else "asr_receive_failed")
            try:
                await self._emit({"type": "error", "code": self._asr_error, "is_final": False, "received_at": time.monotonic()})
            except Exception:
                pass
        finally:
            if self._asr_ws is not None:
                await self._close_ws(self._asr_ws)

    async def synthesize(self, text: str, voice: str) -> AsyncIterator[bytes]:
        """Retry only an explicit admission refusal before any PCM was emitted.

        Neuro documents concurrency rejection as unaccepted work with a one
        second retry delay. This never replays a tool or partially spoken phrase.
        All attempts share the original total budget and remain cancellable.
        """
        try:
            async with asyncio.timeout(self.tts_total_timeout):
                emitted = False
                for attempt in range(3):
                    try:
                        async with contextlib.aclosing(self._synthesize_once(text, voice)) as stream:
                            async for chunk in stream:
                                emitted = True
                                yield chunk
                        self.last_tts_metrics["admission_retries"] = attempt
                        return
                    except NeuroSpeechError as exc:
                        self.last_tts_metrics["admission_retries"] = attempt
                        if exc.code != "concurrency_limit_exceeded" or emitted or attempt == 2:
                            raise
                        await asyncio.sleep(1)
        except (asyncio.TimeoutError, TimeoutError):
            self.last_tts_metrics["error_code"] = "tts_timeout"
            raise NeuroSpeechError("tts_timeout") from None

    async def _synthesize_once(self, text: str, voice: str) -> AsyncIterator[bytes]:
        """Yield native mono PCM16 at 16000Hz; cancellation closes this phrase."""
        if not isinstance(text, str) or not text.strip() or len(text) > self.max_tts_text_chars:
            raise NeuroSpeechError("invalid_tts_text")
        if not isinstance(voice, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", voice):
            raise NeuroSpeechError("invalid_voice")
        ws = None
        metrics: dict[str, Any] = {"started_at": time.monotonic(), "audio_bytes": 0, "sample_rate": 16000, "completed": False}
        self.last_tts_metrics = metrics
        carry = b""
        try:
            async with asyncio.timeout(self.tts_total_timeout):
                ws = await self._connect(self._url(f"/v1/text-to-speech/{quote(voice, safe='')}/stream-input", {
                    "output_format": "pcm_16000", "model_id": "neuro_tts_v2",
                }))
                self._tts_sockets.add(ws)
                metrics["connected_at"] = time.monotonic()
                await asyncio.wait_for(ws.send_json({"text": text, "flush": True}), self.connect_timeout)
                await asyncio.wait_for(ws.send_json({"text": ""}), self.connect_timeout)
                while True:
                    message = await asyncio.wait_for(ws.receive(), self.tts_read_timeout)
                    if message.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                        raise NeuroSpeechError("tts_incomplete_stream")
                    data = self._decode(message)
                    if data.get("error"):
                        raise NeuroSpeechError(self._error_code(data, "tts_provider_error"))
                    encoded = data.get("audio")
                    if encoded:
                        if not isinstance(encoded, str):
                            raise NeuroSpeechError("invalid_tts_audio")
                        try:
                            audio = base64.b64decode(encoded, validate=True)
                        except (ValueError, binascii.Error):
                            raise NeuroSpeechError("invalid_tts_audio") from None
                        metrics["audio_bytes"] += len(audio)
                        if metrics["audio_bytes"] > self.max_tts_audio_bytes:
                            raise NeuroSpeechError("tts_audio_limit_exceeded")
                        if audio:
                            metrics.setdefault("first_pcm_at", time.monotonic())
                            audio = carry + audio
                            carry = audio[len(audio) // 2 * 2:]
                            if len(audio) >= 2:
                                yield audio[:len(audio) // 2 * 2]
                    if data.get("isFinal") is True:
                        if carry:
                            raise NeuroSpeechError("unaligned_tts_pcm16")
                        if not metrics["audio_bytes"]:
                            raise NeuroSpeechError("tts_empty_audio")
                        metrics["completed"] = True
                        return
        except asyncio.CancelledError:
            metrics["cancelled"] = True
            raise
        except NeuroSpeechError as exc:
            metrics["error_code"] = exc.code
            raise
        except (asyncio.TimeoutError, TimeoutError):
            metrics["error_code"] = "tts_timeout"
            raise NeuroSpeechError("tts_timeout") from None
        except Exception:
            metrics["error_code"] = "tts_transport_failed"
            raise NeuroSpeechError("tts_transport_failed") from None
        finally:
            if ws is not None:
                self._tts_sockets.discard(ws)
                await self._close_ws(ws)
            metrics["closed_at"] = time.monotonic()

    async def _close_ws(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        try:
            await asyncio.wait_for(ws.close(), self.close_timeout)
        except (Exception, asyncio.CancelledError):
            # The owner closes the session next; close is intentionally bounded.
            pass

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = self._stopping = True
        reader = self._reader
        if reader is not None and reader is not asyncio.current_task():
            reader.cancel()
            try:
                await asyncio.wait_for(asyncio.gather(reader, return_exceptions=True), self.close_timeout + .1)
            except asyncio.TimeoutError:
                pass
        sockets = list(self._tts_sockets)
        if self._asr_ws is not None:
            sockets.append(self._asr_ws)
        if sockets:
            await asyncio.gather(*(self._close_ws(ws) for ws in sockets))
        if self._session is not None:
            await self._session.close()
        self._tts_sockets.clear()
        self._asr_ws = self._session = self._reader = None
        self._callback = None
        self.metrics["closed_at"] = time.monotonic()

    async def stop(self) -> None:
        await self.close()
