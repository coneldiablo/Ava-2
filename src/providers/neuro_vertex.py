"""Bounded Vertex text streaming for the Neuro full-agent provider.

No tools execute here. The caller retains the terminal raw Content, validates and
executes its function calls once, and appends functionResponse Content to history.
Raw parts (including opaque thoughtSignature values) must never be reconstructed
from the visible text events or combined with adjacent parts.
"""

from __future__ import annotations

import asyncio
import copy
import json
import math
import re
import time
import weakref
from collections.abc import AsyncIterator, Sequence
from typing import Any
from urllib.parse import urlsplit

import aiohttp
import google.auth
import google.auth.transport.requests
import requests


DEFAULT_PROJECT = "project-70a86530-dd7e-4201-b95"
DEFAULT_MODEL = "gemini-3.8-flash"
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
_SCOPES = ("https://www.googleapis.com/auth/cloud-platform",)


def _reject_json_constant(_: str) -> None:
    # Python's decoder accepts NaN/Infinity by default; neither is valid JSON
    # or a safe numeric argument for a business tool.
    raise ValueError("Invalid JSON number")


class VertexClientError(RuntimeError):
    """Safe error: contains a fixed code, never upstream bodies or credentials."""

    def __init__(self, code: str, *, http_status: int | None = None):
        self.code = code
        self.http_status = http_status
        super().__init__(f"Vertex text {code}" + (f" (HTTP {http_status})" if http_status else ""))


class _AdcTokens:
    """Single-flight ADC refresh shared by clients on the same event loop.

    wait_for bounds the caller. A timed-out worker is retained until completion,
    so repeated failed calls cannot spawn unbounded authentication workers.
    Each synchronous HTTP request is also limited by the refresh deadline.
    """

    def __init__(self, project: str):
        self.project = project
        self.credentials: Any = None
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    def _refresh(self, timeout: float) -> str:
        deadline = time.monotonic() + timeout
        session = requests.Session()
        # Only Gemini text requests may use the explicitly configured proxy.
        session.trust_env = False
        request = google.auth.transport.requests.Request(session=session)

        def bounded_request(*args: Any, **kwargs: Any) -> Any:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("ADC deadline")
            kwargs["timeout"] = min(float(kwargs.get("timeout") or remaining), remaining)
            return request(*args, **kwargs)

        try:
            if self.credentials is None:
                self.credentials, _ = google.auth.default(
                    scopes=_SCOPES, quota_project_id=self.project, request=bounded_request
                )
            if not self.credentials.valid or not self.credentials.token:
                self.credentials.refresh(bounded_request)
            token = self.credentials.token
            if not isinstance(token, str) or not token:
                raise VertexClientError("auth_failed")
            return token
        finally:
            session.close()

    async def token(self, timeout: float) -> str:
        async with self._lock:
            if self.credentials is not None and self.credentials.valid and self.credentials.token:
                return str(self.credentials.token)
            if self._task is None or self._task.done():
                self._task = asyncio.create_task(asyncio.to_thread(self._refresh, timeout))
                # Retrieve eventual failures even if every waiting call was cancelled.
                self._task.add_done_callback(lambda task: None if task.cancelled() else task.exception())
            task = self._task
        try:
            return await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
        except asyncio.TimeoutError:
            raise VertexClientError("auth_timeout") from None
        except asyncio.CancelledError:
            raise
        except Exception:
            raise VertexClientError("auth_failed") from None


_ADC_BY_LOOP: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()


def _adc_tokens(project: str) -> _AdcTokens:
    loop = asyncio.get_running_loop()
    providers = _ADC_BY_LOOP.setdefault(loop, {})
    if project not in providers:
        providers[project] = _AdcTokens(project)
    return providers[project]


class VertexTextClient:
    """Streaming REST client using ADC; owns and closes its HTTP session.

    ``stream`` yields visible ``text`` deltas followed by exactly one ``content``
    event only after a successful STOP. No automatic generation retries occur.
    Use an async context manager or call ``close`` when the call ends.
    """

    def __init__(
        self,
        project: str = DEFAULT_PROJECT,
        location: str = "global",
        proxy_url: str | None = None,
        *,
        auth_timeout: float = 10.0,
        total_timeout: float = 40.0,
        connect_timeout: float = 10.0,
        chunk_timeout: float = 15.0,
        max_history_bytes: int = 512_000,
        max_history_messages: int = 256,
        max_response_bytes: int = 2_000_000,
        max_event_bytes: int = 512_000,
        max_parts: int = 512,
        max_text_chars: int = 20_000,
        max_output_tokens: int = 2048,
    ):
        if not _ID.fullmatch(project) or not _ID.fullmatch(location):
            raise VertexClientError("invalid_config")
        if proxy_url:
            try:
                proxy = urlsplit(proxy_url)
                if proxy.scheme not in {"http", "https"} or not proxy.hostname or proxy.fragment:
                    raise ValueError
                proxy.port  # Validate the port without exposing the original URL.
            except ValueError:
                raise VertexClientError("invalid_proxy") from None
        limits = (auth_timeout, total_timeout, connect_timeout, chunk_timeout,
                  max_history_bytes, max_history_messages, max_response_bytes,
                  max_event_bytes, max_parts, max_text_chars, max_output_tokens)
        try:
            valid_limits = all(not isinstance(value, bool) and math.isfinite(value) and value > 0
                               for value in limits)
        except (TypeError, ValueError, OverflowError):
            valid_limits = False
        if not valid_limits:
            raise VertexClientError("invalid_limits")
        self.project = project
        self.location = location
        self._proxy_url = proxy_url
        self.auth_timeout = auth_timeout
        self.total_timeout = total_timeout
        self.connect_timeout = connect_timeout
        self.chunk_timeout = chunk_timeout
        self.max_history_bytes = max_history_bytes
        self.max_history_messages = max_history_messages
        self.max_response_bytes = max_response_bytes
        self.max_event_bytes = max_event_bytes
        self.max_parts = max_parts
        self.max_text_chars = max_text_chars
        self.max_output_tokens = max_output_tokens
        self._session: aiohttp.ClientSession | None = None
        self._responses: set[aiohttp.ClientResponse] = set()
        self._closed = False
        self.last_request_metrics: dict[str, Any] = {}

    async def __aenter__(self) -> VertexTextClient:
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.close()

    async def close(self) -> None:
        self._closed = True
        for response in tuple(self._responses):
            response.close()
        self._responses.clear()
        if self._session is not None:
            await self._session.close()

    def _payload(self, history: Sequence[dict[str, Any]], instructions: str,
                 tools: Sequence[dict[str, Any]] | None) -> dict[str, Any]:
        if (not isinstance(history, (list, tuple)) or not history
                or len(history) > self.max_history_messages or not isinstance(instructions, str)):
            raise VertexClientError("invalid_history")
        for content in history:
            if (not isinstance(content, dict) or content.get("role") not in {"user", "model"}
                    or not isinstance(content.get("parts"), list) or not content["parts"]
                    or any(not isinstance(part, dict) for part in content["parts"])):
                raise VertexClientError("invalid_history")
        payload: dict[str, Any] = {
            "contents": history,
            "generationConfig": {
                "maxOutputTokens": self.max_output_tokens,
                "thinkingConfig": {"thinkingLevel": "LOW"},
            },
        }
        if instructions:
            payload["systemInstruction"] = {"parts": [{"text": instructions}]}
        if tools:
            payload["tools"] = tools
        try:
            encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False)
            if len(encoded.encode("utf-8")) > self.max_history_bytes:
                raise VertexClientError("history_limit")
            # Snapshot before the first await: callers cannot mutate an in-flight request.
            return json.loads(encoded)
        except (TypeError, ValueError, RecursionError):
            raise VertexClientError("invalid_history") from None

    async def _frames(self, response: aiohttp.ClientResponse, started: float) -> AsyncIterator[dict]:
        buffer = b""
        data: list[bytes] = []
        event_bytes = 0
        total = 0
        chunks = response.content.iter_chunked(16_384).__aiter__()
        received = False
        while True:
            remaining = self.total_timeout - (time.monotonic() - started)
            if remaining <= 0:
                raise VertexClientError("timeout")
            try:
                # Model thinking before the first byte belongs to the configured
                # request budget. The idle-chunk deadline starts after data flows.
                chunk = await asyncio.wait_for(chunks.__anext__(), min(self.chunk_timeout, remaining) if received else remaining)
            except StopAsyncIteration:
                # SSE dispatch normally uses a blank line; also handle a final EOF.
                chunk = b"\n\n" if buffer or data else b""
                final = True
            else:
                final = False
                received = True
                total += len(chunk)
                if total > self.max_response_bytes:
                    raise VertexClientError("response_limit")
            buffer += chunk
            if len(buffer) > self.max_event_bytes:
                raise VertexClientError("event_limit")
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                line = line.rstrip(b"\r")
                if line.startswith(b"data:"):
                    value = line[5:]
                    if value.startswith(b" "):
                        value = value[1:]
                    event_bytes += len(value)
                    if event_bytes > self.max_event_bytes:
                        raise VertexClientError("event_limit")
                    data.append(value)
                elif not line and data:
                    raw = b"\n".join(data)
                    data, event_bytes = [], 0
                    if raw.strip() == b"[DONE]":
                        continue
                    try:
                        frame = json.loads(raw, parse_constant=_reject_json_constant)
                    except (ValueError, UnicodeDecodeError, RecursionError):
                        raise VertexClientError("invalid_response") from None
                    if not isinstance(frame, dict):
                        raise VertexClientError("invalid_response")
                    yield frame
            if final:
                break

    async def stream(self, history: Sequence[dict[str, Any]], instructions: str = "",
                     tools: Sequence[dict[str, Any]] | None = None,
                     model: str = DEFAULT_MODEL) -> AsyncIterator[dict[str, Any]]:
        if self._closed:
            raise VertexClientError("closed")
        if not isinstance(model, str) or not _ID.fullmatch(model):
            raise VertexClientError("invalid_model")
        payload = self._payload(history, instructions, tools)
        request_started = time.monotonic()
        metrics = self.last_request_metrics = {"phase": "auth", "frames": 0}
        token = await _adc_tokens(self.project).token(self.auth_timeout)
        metrics["auth_ms"] = round((time.monotonic() - request_started) * 1000, 1)
        if self._closed:
            raise VertexClientError("closed")
        if self._session is None:
            self._session = aiohttp.ClientSession(trust_env=False, timeout=aiohttp.ClientTimeout(
                total=self.total_timeout, connect=self.connect_timeout, sock_read=None,
            ))
        host = "aiplatform.googleapis.com" if self.location == "global" else f"{self.location}-aiplatform.googleapis.com"
        endpoint = (f"https://{host}/v1/projects/{self.project}/locations/{self.location}"
                    f"/publishers/google/models/{model}:streamGenerateContent?alt=sse")
        headers = {"Authorization": f"Bearer {token}", "x-goog-user-project": self.project}
        started = time.monotonic()
        first_text_ms: float | None = None
        parts: list[dict] = []
        text_chars = 0
        finish = None
        try:
            metrics["phase"] = "headers"
            async with self._session.post(endpoint, json=payload, headers=headers,
                                          proxy=self._proxy_url, allow_redirects=False) as response:
                metrics["headers_ms"] = round((time.monotonic() - started) * 1000, 1)
                metrics["http_status"] = response.status
                metrics["phase"] = "body"
                self._responses.add(response)
                try:
                    if response.status != 200:
                        raise VertexClientError("http_error", http_status=response.status)
                    if "text/event-stream" not in response.headers.get("Content-Type", "").lower():
                        raise VertexClientError("invalid_response")
                    async for frame in self._frames(response, started):
                        metrics["frames"] += 1
                        metrics.setdefault("first_frame_ms", round((time.monotonic() - started) * 1000, 1))
                        if "error" in frame:
                            raise VertexClientError("upstream_error")
                        if frame.get("promptFeedback", {}).get("blockReason"):
                            raise VertexClientError("blocked")
                        candidates = frame.get("candidates", [])
                        if not isinstance(candidates, list) or len(candidates) > 1:
                            raise VertexClientError("invalid_response")
                        for candidate in candidates:
                            if not isinstance(candidate, dict) or candidate.get("index", 0) != 0:
                                raise VertexClientError("invalid_response")
                            content = candidate.get("content", {})
                            if not isinstance(content, dict) or content.get("role", "model") != "model":
                                raise VertexClientError("invalid_response")
                            raw_parts = content.get("parts", [])
                            if not isinstance(raw_parts, list):
                                raise VertexClientError("invalid_response")
                            for part in raw_parts:
                                if not isinstance(part, dict):
                                    raise VertexClientError("invalid_response")
                                parts.append(copy.deepcopy(part))
                                if len(parts) > self.max_parts:
                                    raise VertexClientError("parts_limit")
                                text = part.get("text")
                                if text is not None and not isinstance(text, str):
                                    raise VertexClientError("invalid_response")
                                if text and not part.get("thought"):
                                    text_chars += len(text)
                                    if text_chars > self.max_text_chars:
                                        raise VertexClientError("text_limit")
                                    if first_text_ms is None:
                                        first_text_ms = (time.monotonic() - started) * 1000
                                    yield {"type": "text", "text": text}
                            if candidate.get("finishReason"):
                                finish = candidate["finishReason"]
                        # finishReason terminates the candidate. Do not delay
                        # tool submission waiting for an idle HTTP connection to
                        # reach EOF after a fully received terminal SSE frame.
                        if finish:
                            break
                    if finish != "STOP" or not parts:
                        raise VertexClientError("incomplete_response")
                finally:
                    self._responses.discard(response)
            yield {"type": "content", "content": {"role": "model", "parts": parts},
                   "finish_reason": finish, "first_text_ms": first_text_ms,
                   "elapsed_ms": (time.monotonic() - started) * 1000}
            metrics["phase"] = "complete"
        except VertexClientError as exc:
            metrics["failure_code"] = exc.code
            raise
        except asyncio.CancelledError:
            raise
        except (asyncio.TimeoutError, TimeoutError):
            metrics["failure_code"] = "timeout"
            raise VertexClientError("timeout") from None
        except Exception:
            metrics["failure_code"] = "transport_error"
            # aiohttp exceptions can contain URLs, proxy passwords or upstream text.
            raise VertexClientError("transport_error") from None
        finally:
            metrics["elapsed_ms"] = round((time.monotonic() - started) * 1000, 1)
