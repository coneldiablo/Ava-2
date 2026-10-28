import asyncio
import json
from uuid import uuid4

import httpx
import pytest

from src.core.onyx_client import OnyxClientError
from src.core import onyx_native_runtime_client as runtime_module
from src.core.onyx_native_runtime_client import OnyxNativeRuntimeClient, normalize_private_gateway_origin


PEER = "p" * 43
SESSION = str(uuid4())


def client(handler, **kwargs):
    return OnyxNativeRuntimeClient(
        enabled=True,
        private_gateway_origin="https://onyx-runtime.private.test",
        runtime_peer_secret=PEER,
        transport=httpx.MockTransport(handler),
        **kwargs,
    )


@pytest.mark.asyncio
async def test_native_runtime_uses_only_private_lifecycle_allowlist_and_peer_header():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"path": request.url.path})

    runtime = client(handler)
    await runtime.create_chat_session(7)
    await runtime.send_chat_message({
        "chat_session_id": SESSION,
        "message": "Подскажи время заезда",
        "stream": False,
        "include_citations": True,
        "allowed_tool_ids": [9],
        "internal_search_filters": {"document_set": ["hotel-1"]},
        "mcp_headers": {"X-AVA-Execution": "e" * 43},
    })
    await runtime.get_chat_session(SESSION)
    await runtime.stop_chat_session(SESSION)
    await runtime.end_incognito_session(SESSION)
    await runtime.request("POST", "/chat/create-chat-session", {"persona_id": 8, "incognito": True})

    assert [(request.method, request.url.path) for request in seen] == [
        ("POST", "/v1/onyx-runtime/chat/create-chat-session"),
        ("POST", "/v1/onyx-runtime/chat/send-chat-message"),
        ("GET", f"/v1/onyx-runtime/chat/get-chat-session/{SESSION}"),
        ("POST", f"/v1/onyx-runtime/chat/stop-chat-session/{SESSION}"),
        ("POST", f"/v1/onyx-runtime/chat/end-incognito-session/{SESSION}"),
        ("POST", "/v1/onyx-runtime/chat/create-chat-session"),
    ]
    for request in seen:
        assert request.url.query == b""
        assert request.headers["x-ava-runtime-peer"] == PEER
        assert "authorization" not in request.headers
        assert "cookie" not in request.headers
        assert "origin" not in request.headers
        assert not any(name.startswith("x-ava-") and name != "x-ava-runtime-peer" for name in request.headers)
    assert json.loads(seen[0].content) == {"persona_id": 7, "incognito": True}
    assert json.loads(seen[3].content) == {}
    assert json.loads(seen[4].content) == {}


@pytest.mark.asyncio
async def test_native_runtime_is_explicitly_opt_in_and_never_uses_legacy_bearer(monkeypatch):
    monkeypatch.setenv("ONYX_LEGACY_API_KEY", "legacy-secret-never-used")
    runtime = OnyxNativeRuntimeClient(enabled=False, runtime_peer_secret="legacy-secret-never-used")
    with pytest.raises(OnyxClientError) as captured:
        await runtime.create_chat_session(1)
    assert captured.value.code == "ONYX_NATIVE_RUNTIME_DISABLED"
    assert "legacy-secret-never-used" not in repr(runtime)
    with pytest.raises(OnyxClientError) as invalid:
        OnyxNativeRuntimeClient(
            enabled=True,
            private_gateway_origin="https://runtime.private.test",
            runtime_peer_secret="legacy-secret-never-used",
        )
    assert invalid.value.code == "ONYX_NATIVE_RUNTIME_CONFIG_INVALID"


@pytest.mark.asyncio
async def test_native_runtime_rejects_unsafe_endpoints_and_payload_scope_before_network():
    calls = []
    runtime = client(lambda request: calls.append(request) or httpx.Response(200, json={}))
    with pytest.raises(OnyxClientError) as endpoint:
        await runtime.request("POST", "/onyx-api/ingestion", {})
    assert endpoint.value.code == "ONYX_NATIVE_RUNTIME_ENDPOINT_FORBIDDEN"
    with pytest.raises(OnyxClientError) as payload:
        await runtime.request("POST", "/v1/onyx-runtime/chat/send-chat-message", {
            "chat_session_id": SESSION,
            "message": "hello",
            "stream": False,
            "business_id": 99,
        })
    assert payload.value.code == "ONYX_NATIVE_RUNTIME_REQUEST_INVALID"
    with pytest.raises(OnyxClientError) as stream:
        await runtime.request("POST", "/v1/onyx-runtime/chat/send-chat-message", {
            "chat_session_id": SESSION,
            "message": "hello",
            "stream": True,
        })
    assert stream.value.code == "ONYX_NATIVE_RUNTIME_REQUEST_INVALID"
    with pytest.raises(OnyxClientError) as malformed_session:
        await runtime.request("GET", f"/v1/onyx-runtime/chat/get-chat-session/forged/{SESSION}")
    assert malformed_session.value.code == "ONYX_NATIVE_RUNTIME_ENDPOINT_FORBIDDEN"
    assert calls == []


@pytest.mark.asyncio
async def test_native_runtime_never_follows_redirects_or_leaks_peer_in_errors():
    redirect = client(lambda _request: httpx.Response(302, headers={"location": "https://attacker.test/"}))
    with pytest.raises(OnyxClientError) as redirected:
        await redirect.create_chat_session(1)
    assert redirected.value.code == "ONYX_NATIVE_RUNTIME_REDIRECT_DENIED"

    denied = client(lambda _request: httpx.Response(403, json={"detail": f"peer={PEER}"}))
    with pytest.raises(OnyxClientError) as rejected:
        await denied.create_chat_session(1)
    assert rejected.value.code == "ONYX_NATIVE_RUNTIME_FORBIDDEN"
    assert PEER not in str(rejected.value)


@pytest.mark.asyncio
async def test_native_runtime_propagates_cancellation_without_a_legacy_retry():
    started = asyncio.Event()

    async def handler(_request: httpx.Request) -> httpx.Response:
        started.set()
        await asyncio.Event().wait()
        return httpx.Response(200, json={})

    runtime = client(handler, timeout_seconds=5)
    task = asyncio.create_task(runtime.create_chat_session(1))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_native_runtime_disables_environment_proxies_and_caps_streams_before_buffering(monkeypatch):
    observed = {}
    real_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        observed.update(kwargs)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(runtime_module.httpx, "AsyncClient", client_factory)
    await client(lambda _request: httpx.Response(200, json={})).create_chat_session(1)
    assert observed["trust_env"] is False

    class LargeStream(httpx.AsyncByteStream):
        def __init__(self):
            self.chunks_sent = 0

        async def __aiter__(self):
            for _ in range(4):
                self.chunks_sent += 1
                yield b"x" * (1024 * 1024)

        async def aclose(self):
            return None

    stream = LargeStream()
    oversized = client(lambda _request: httpx.Response(200, stream=stream))
    with pytest.raises(OnyxClientError) as captured:
        await oversized.create_chat_session(1)
    assert captured.value.code == "ONYX_NATIVE_RUNTIME_INVALID_RESPONSE"
    assert stream.chunks_sent == 3  # third chunk was rejected before appending it


def test_private_gateway_origin_is_https_or_loopback_only():
    assert normalize_private_gateway_origin("https://runtime.private.test/") == "https://runtime.private.test"
    assert normalize_private_gateway_origin("http://127.0.0.1:18443") == "http://127.0.0.1:18443"
    with pytest.raises(OnyxClientError) as captured:
        normalize_private_gateway_origin("http://runtime.private.test")
    assert captured.value.code == "ONYX_NATIVE_RUNTIME_ORIGIN_INVALID"


def test_production_buffered_preview_budget_remains_supported_and_bounded():
    runtime = client(lambda _request: httpx.Response(200, json={}), timeout_seconds=45)
    assert runtime.timeout_seconds == 45
    with pytest.raises(OnyxClientError) as captured:
        client(lambda _request: httpx.Response(200, json={}), timeout_seconds=60.1)
    assert captured.value.code == "ONYX_NATIVE_RUNTIME_CONFIG_INVALID"


@pytest.mark.asyncio
async def test_production_preview_override_preserves_its_restricted_contract():
    calls = []
    runtime = client(lambda request: calls.append(request) or httpx.Response(200, json={}))
    approved = {
        "chat_session_id": SESSION, "message": "Synthetic document question", "stream": False,
        "include_citations": True, "allowed_tool_ids": [9], "forced_tool_id": 9,
        "internal_search_filters": {
            "document_set": ["ava-native-" + "a" * 32 + "-knowledge"],
            "tags": [{"tag_key": "ava_entity_type", "tag_value": "knowledge"}],
        },
        "llm_override": {"model_version": "ava-hotel-7-preview-flash"},
    }
    await runtime.send_chat_message(approved)
    assert len(calls) == 1 and json.loads(calls[0].content) == approved
    invalid_changes = [
        {"llm_override": {"model_version": "arbitrary-model"}},
        {"llm_override": {"model_version": "ava-hotel-7-preview-flash", "api_key": "synthetic"}},
        {"include_citations": False},
        {"allowed_tool_ids": [9, 10]},
        {"mcp_headers": {"X-AVA-Execution": "e" * 43}},
        {"internal_search_filters": {"document_set": ["unscoped"]}},
    ]
    for change in invalid_changes:
        with pytest.raises(OnyxClientError) as captured:
            await runtime.send_chat_message({**approved, **change})
        assert captured.value.code == "ONYX_NATIVE_RUNTIME_REQUEST_INVALID"
    assert len(calls) == 1
