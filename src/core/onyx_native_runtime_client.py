"""Optional private transport for an isolated Onyx chat runtime.

The runner selects this transport only through a root-mounted deployment
configuration and durable admission. It never resolves a legacy API key, never
falls back to the shared/admin API, and sends requests only to the private
gateway's small chat allowlist.
"""
from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Optional
from urllib.parse import urlsplit, urlunsplit

import httpx

from src.core.onyx_client import OnyxClientError, OnyxResponse


_PEER_SECRET = re.compile(r"^[A-Za-z0-9_-]{43}$")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
_DOCKER_GATEWAY = re.compile(r'^ava_([0-9a-f]{32})-gateway-1$')
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_CREATE = "/v1/onyx-runtime/chat/create-chat-session"
_SEND = "/v1/onyx-runtime/chat/send-chat-message"
_SESSION_PREFIX = "/v1/onyx-runtime/chat/"
_SESSION_ACTIONS = {"get-chat-session": "GET", "stop-chat-session": "POST", "end-incognito-session": "POST"}


def _error(message: str, code: str, status_code: int = 503, retryable: bool = False) -> OnyxClientError:
    # Messages are fixed local strings, not upstream bodies, request bodies,
    # headers, URLs or exception text.  Runtime peer secrets must never reach
    # an error object that may later be logged by a caller.
    return OnyxClientError(message, code=code, status_code=status_code, retryable=retryable)


def normalize_private_gateway_origin(value: str) -> str:
    raw = str(value or "").strip().rstrip("/")
    parsed = urlsplit(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise _error("Private Onyx gateway origin is invalid", "ONYX_NATIVE_RUNTIME_ORIGIN_INVALID", 400)
    if parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise _error("Private Onyx gateway origin is invalid", "ONYX_NATIVE_RUNTIME_ORIGIN_INVALID", 400)
    # The isolated Compose listener is unpublished and deployment-fenced by
    # native_runtime_scope. Other non-loopback origins still require HTTPS.
    loopback = parsed.hostname.lower() in {"localhost", "127.0.0.1", "::1"}
    docker_gateway = (_DOCKER_GATEWAY.fullmatch(parsed.hostname) is not None
                      and parsed.netloc == f'{parsed.hostname}:4081')
    if parsed.scheme != "https" and not loopback and not docker_gateway:
        raise _error("Private Onyx gateway origin requires HTTPS", "ONYX_NATIVE_RUNTIME_ORIGIN_INVALID", 400)
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def _session_path(action: str, session_id: str) -> str:
    if action not in _SESSION_ACTIONS or not isinstance(session_id, str) or not _UUID.fullmatch(session_id):
        raise _error("Native Onyx session identifier is invalid", "ONYX_NATIVE_RUNTIME_REQUEST_INVALID", 400)
    return f"{_SESSION_PREFIX}{action}/{session_id}"


def _gateway_path(path: str) -> str:
    """Map only the existing chat lifecycle paths to the private prefix.

    Accepting the legacy-shaped paths keeps this client compatible with the
    existing async runner interface, but it does *not* contact the legacy
    bearer endpoint: every accepted path is sent to ``/v1/onyx-runtime``.
    """
    if not isinstance(path, str) or "?" in path or "#" in path:
        return path
    if path == "/chat/create-chat-session":
        return _CREATE
    if path == "/chat/send-chat-message":
        return _SEND
    for action in _SESSION_ACTIONS:
        legacy_prefix = f"/chat/{action}/"
        if path.startswith(legacy_prefix):
            return _session_path(action, path[len(legacy_prefix):])
    return path


def _exact_keys(value: Any, allowed: set[str], required: set[str]) -> bool:
    return isinstance(value, dict) and required.issubset(value) and set(value).issubset(allowed)


class OnyxNativeRuntimeClient:
    """Async lifecycle-compatible client for the private native gateway.

    ``enabled`` is deliberately opt-in.  Creating a disabled client is safe,
    but every attempted request fails closed rather than selecting the legacy
    :class:`OnyxClient` bearer/admin transport.
    """

    def __init__(
        self,
        *,
        enabled: bool = False,
        private_gateway_origin: Optional[str] = None,
        runtime_peer_secret: Optional[str] = None,
        timeout_seconds: float = 20.0,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        if type(enabled) is not bool:
            raise _error("Native runtime opt-in is invalid", "ONYX_NATIVE_RUNTIME_CONFIG_INVALID", 400)
        self.enabled = enabled
        self._origin: Optional[str] = None
        self._runtime_peer_secret: Optional[str] = None
        self._transport = transport
        try:
            timeout = float(timeout_seconds)
        except (TypeError, ValueError):
            timeout = 0
        # Preserve the reviewed production ceiling for buffered preview turns;
        # the runtime still supplies its separate voice/WhatsApp budgets.
        if not 0.1 <= timeout <= 60.0:
            raise _error("Native runtime timeout is invalid", "ONYX_NATIVE_RUNTIME_CONFIG_INVALID", 400)
        self.timeout_seconds = timeout
        if not enabled:
            return
        self._origin = normalize_private_gateway_origin(private_gateway_origin or "")
        if not isinstance(runtime_peer_secret, str) or not _PEER_SECRET.fullmatch(runtime_peer_secret):
            raise _error("Native runtime peer credential is invalid", "ONYX_NATIVE_RUNTIME_CONFIG_INVALID", 400)
        self._runtime_peer_secret = runtime_peer_secret

    def __repr__(self) -> str:
        return f"OnyxNativeRuntimeClient(enabled={self.enabled}, private_gateway_origin={'configured' if self._origin else 'none'})"

    def _assert_enabled(self) -> tuple[str, str]:
        if not self.enabled or not self._origin or not self._runtime_peer_secret:
            raise _error("Native Onyx runtime is not enabled", "ONYX_NATIVE_RUNTIME_DISABLED", 503)
        return self._origin, self._runtime_peer_secret

    @staticmethod
    def _validate_request(method: str, path: str, payload: Optional[dict[str, Any]]) -> None:
        if method == "POST" and path == _CREATE:
            if not _exact_keys(payload, {"persona_id", "incognito"}, {"persona_id", "incognito"}) \
                    or type(payload["persona_id"]) is not int or payload["persona_id"] < 1 or payload["incognito"] is not True:
                raise _error("Native Onyx create request is invalid", "ONYX_NATIVE_RUNTIME_REQUEST_INVALID", 400)
            return
        if method == "POST" and path == _SEND:
            allowed = {"chat_session_id", "message", "stream", "include_citations", "allowed_tool_ids", "forced_tool_id",
                       "internal_search_filters", "mcp_headers", "llm_override"}
            if not _exact_keys(payload, allowed, {"chat_session_id", "message", "stream"}) \
                    or not isinstance(payload["chat_session_id"], str) or not _UUID.fullmatch(payload["chat_session_id"]) \
                    or not isinstance(payload["message"], str) or not payload["message"].strip() or len(payload["message"]) > 32000 \
                    or payload["stream"] is not False:
                raise _error("Native Onyx send request is invalid", "ONYX_NATIVE_RUNTIME_REQUEST_INVALID", 400)
            if "include_citations" in payload and type(payload["include_citations"]) is not bool:
                raise _error("Native Onyx send request is invalid", "ONYX_NATIVE_RUNTIME_REQUEST_INVALID", 400)
            if "allowed_tool_ids" in payload and (not isinstance(payload["allowed_tool_ids"], list)
                                                  or not all(type(item) is int and item > 0 for item in payload["allowed_tool_ids"])):
                raise _error("Native Onyx send request is invalid", "ONYX_NATIVE_RUNTIME_REQUEST_INVALID", 400)
            if "forced_tool_id" in payload and (type(payload["forced_tool_id"]) is not int or payload["forced_tool_id"] < 1
                                                 or payload["forced_tool_id"] not in payload.get("allowed_tool_ids", [])):
                raise _error("Native Onyx send request is invalid", "ONYX_NATIVE_RUNTIME_REQUEST_INVALID", 400)
            if "internal_search_filters" in payload:
                filters = payload["internal_search_filters"]
                valid_tags = isinstance(filters, dict) and set(filters).issubset({"document_set", "tags"}) \
                    and ("document_set" not in filters or (isinstance(filters["document_set"], list)
                        and all(isinstance(item, str) and item for item in filters["document_set"]))) \
                    and ("tags" not in filters or (isinstance(filters["tags"], list) and all(
                        _exact_keys(item, {"tag_key", "tag_value"}, {"tag_key", "tag_value"})
                        and isinstance(item["tag_key"], str) and item["tag_key"]
                        and isinstance(item["tag_value"], str) and item["tag_value"] for item in filters["tags"])))
                if not valid_tags:
                    raise _error("Native Onyx send request is invalid", "ONYX_NATIVE_RUNTIME_REQUEST_INVALID", 400)
            if "mcp_headers" in payload and (not _exact_keys(payload["mcp_headers"], {"X-AVA-Execution"}, {"X-AVA-Execution"})
                                              or not isinstance(payload["mcp_headers"]["X-AVA-Execution"], str)
                                              or not _PEER_SECRET.fullmatch(payload["mcp_headers"]["X-AVA-Execution"])):
                raise _error("Native Onyx send request is invalid", "ONYX_NATIVE_RUNTIME_REQUEST_INVALID", 400)
            if "llm_override" in payload:
                override = payload["llm_override"]
                match = re.fullmatch(r"ava-hotel-([1-9][0-9]*)-preview-flash", override.get("model_version", "")) \
                    if isinstance(override, dict) and set(override) == {"model_version"} \
                    and isinstance(override.get("model_version"), str) else None
                filters = payload.get("internal_search_filters")
                if (not match or payload.get("include_citations") is not True
                        or payload.get("allowed_tool_ids") != [payload.get("forced_tool_id")]
                        or "mcp_headers" in payload
                        or not isinstance(filters, dict)
                        or not isinstance(filters.get("document_set"), list)
                        or len(filters["document_set"]) != 1
                        or not isinstance(filters["document_set"][0], str)
                        or not re.fullmatch(r"ava-native-[0-9a-f]{32}-knowledge", filters["document_set"][0])
                        or filters.get("tags") != [{"tag_key": "ava_entity_type", "tag_value": "knowledge"}]):
                    raise _error("Native Onyx preview model scope is invalid", "ONYX_NATIVE_RUNTIME_REQUEST_INVALID", 400)
            return
        for action, allowed_method in _SESSION_ACTIONS.items():
            if method == allowed_method and path.startswith(f"{_SESSION_PREFIX}{action}/"):
                session_path = _session_path(action, path.rsplit("/", 1)[-1])
                if path == session_path and ((allowed_method == "GET" and payload is None)
                                             or (allowed_method == "POST" and payload == {})):
                    return
        raise _error("Native Onyx endpoint is not allowed", "ONYX_NATIVE_RUNTIME_ENDPOINT_FORBIDDEN", 403)

    async def request(self, method: str, path: str, payload: Optional[dict[str, Any]] = None) -> OnyxResponse:
        origin, secret = self._assert_enabled()
        method = str(method or "").upper()
        path = _gateway_path(path)
        if method == 'POST' and payload is None and any(
                path.startswith(f'{_SESSION_PREFIX}{action}/')
                for action in ('stop-chat-session', 'end-incognito-session')):
            payload = {}
        self._validate_request(method, path, payload)
        headers = {
            "X-AVA-Runtime-Peer": secret,
            "Accept": "application/json",
            "User-Agent": "AVA-Onyx-Native-Runtime/1.0",
        }
        if method == "POST":
            headers["Content-Type"] = "application/json"
        try:
            async with httpx.AsyncClient(
                base_url=origin,
                timeout=httpx.Timeout(self.timeout_seconds),
                follow_redirects=False,
                trust_env=False,
                transport=self._transport,
                headers=headers,
            ) as client:
                async with client.stream(method, path, json=payload) as response:
                    if 300 <= response.status_code < 400:
                        raise _error("Native Onyx runtime redirect was denied", "ONYX_NATIVE_RUNTIME_REDIRECT_DENIED", 502)
                    if not 200 <= response.status_code < 300:
                        if response.status_code == 401:
                            code = "ONYX_NATIVE_RUNTIME_UNAUTHORIZED"
                        elif response.status_code == 403:
                            code = "ONYX_NATIVE_RUNTIME_FORBIDDEN"
                        elif response.status_code == 404:
                            code = "ONYX_NATIVE_RUNTIME_NOT_FOUND"
                        elif response.status_code == 429:
                            code = "ONYX_NATIVE_RUNTIME_RATE_LIMITED"
                        elif response.status_code >= 500:
                            code = "ONYX_NATIVE_RUNTIME_UPSTREAM_UNAVAILABLE"
                        else:
                            code = "ONYX_NATIVE_RUNTIME_REQUEST_REJECTED"
                        raise _error("Native Onyx runtime rejected the request", code, response.status_code,
                                     response.status_code in {408, 409, 425, 429, 500, 502, 503, 504})
                    declared_size = response.headers.get("content-length")
                    if declared_size and (not declared_size.isdigit() or int(declared_size) > _MAX_RESPONSE_BYTES):
                        raise _error("Native Onyx runtime response is too large", "ONYX_NATIVE_RUNTIME_INVALID_RESPONSE", 502, True)
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        if len(raw) + len(chunk) > _MAX_RESPONSE_BYTES:
                            raise _error("Native Onyx runtime response is too large", "ONYX_NATIVE_RUNTIME_INVALID_RESPONSE", 502, True)
                        raw.extend(chunk)
        except asyncio.CancelledError:
            # Let the runner's existing cancellation cleanup stop the remote
            # turn; swallowing this would leave a live native request behind.
            raise
        except httpx.TimeoutException:
            raise _error("Native Onyx runtime timed out", "ONYX_NATIVE_RUNTIME_TIMEOUT", 503, True) from None
        except httpx.HTTPError:
            raise _error("Native Onyx runtime is unavailable", "ONYX_NATIVE_RUNTIME_NETWORK_ERROR", 503, True) from None
        if not raw:
            return OnyxResponse(status_code=response.status_code, body=None)
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError):
            raise _error("Native Onyx runtime returned invalid JSON", "ONYX_NATIVE_RUNTIME_INVALID_RESPONSE", 502, True) from None
        return OnyxResponse(status_code=response.status_code, body=body)

    async def create_chat_session(self, persona_id: int) -> OnyxResponse:
        return await self.request("POST", _CREATE, {"persona_id": persona_id, "incognito": True})

    async def send_chat_message(self, payload: dict[str, Any]) -> OnyxResponse:
        return await self.request("POST", _SEND, payload)

    async def get_chat_session(self, session_id: str) -> OnyxResponse:
        return await self.request("GET", _session_path("get-chat-session", session_id))

    async def stop_chat_session(self, session_id: str) -> OnyxResponse:
        return await self.request("POST", _session_path("stop-chat-session", session_id), {})

    async def end_incognito_session(self, session_id: str) -> OnyxResponse:
        return await self.request("POST", _session_path("end-incognito-session", session_id), {})
