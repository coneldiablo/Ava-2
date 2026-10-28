"""Deterministic Vertex transport/auth/continuation tests; no cloud calls."""

import asyncio
import copy
import json
import time

import pytest

from src.providers import neuro_vertex as vertex


HISTORY = [{"role": "user", "parts": [{"text": "Synthetic test"}]}]


def sse(*frames, ending=True):
    value = b"".join(b"data: " + json.dumps(frame, ensure_ascii=False).encode() + b"\r\n\r\n"
                     for frame in frames)
    return value if ending else value.rstrip(b"\r\n")


def frame(parts=(), finish=None):
    candidate = {"index": 0, "content": {"role": "model", "parts": list(parts)}}
    if finish:
        candidate["finishReason"] = finish
    return {"candidates": [candidate]}


class Body:
    def __init__(self, body, *, delay=0):
        self.body = body
        self.delay = delay

    async def iter_chunked(self, _):
        # Deliberately split UTF-8, CRLF and JSON tokens across arbitrary chunks.
        for offset in range(0, len(self.body), 7):
            if self.delay:
                await asyncio.sleep(self.delay)
            yield self.body[offset:offset + 7]


class Response:
    def __init__(self, body=b"", *, status=200, content_type="text/event-stream", delay=0):
        self.content = Body(body, delay=delay)
        self.status = status
        self.headers = {"Content-Type": content_type}
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        self.close()

    def close(self):
        self.closed = True


class Session:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []
        self.closed = False

    def post(self, endpoint, **kwargs):
        self.requests.append((endpoint, copy.deepcopy(kwargs)))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    async def close(self):
        self.closed = True


@pytest.fixture
def transport(monkeypatch):
    def configure(*responses):
        session = Session(responses)
        created = []

        def factory(**kwargs):
            created.append(kwargs)
            return session

        class Tokens:
            async def token(self, timeout):
                return "synthetic-token"

        monkeypatch.setattr(vertex.aiohttp, "ClientSession", factory)
        monkeypatch.setattr(vertex, "_adc_tokens", lambda project: Tokens())
        session.created = created
        return session

    return configure


async def events(client, history=None, **kwargs):
    return [event async for event in client.stream(history or HISTORY, **kwargs)]


async def test_visible_text_and_all_raw_parts_are_preserved(transport):
    raw = [{"text": "hidden reasoning", "thought": True, "thoughtSignature": "opaque-a"},
           {"text": "Привет, "}, {"text": "мир."}, {"text": "", "thoughtSignature": "opaque-b"}]
    response = Response(sse(frame(raw[:2]), frame(raw[2:], "STOP")))
    session = transport(response)
    async with vertex.VertexTextClient() as client:
        result = await events(client, instructions="Speak briefly")
    assert [event["text"] for event in result if event["type"] == "text"] == ["Привет, ", "мир."]
    assert result[-1]["content"] == {"role": "model", "parts": raw}
    assert result[-1]["first_text_ms"] is not None
    assert result[-1]["elapsed_ms"] >= result[-1]["first_text_ms"]
    assert result[-1]["finish_reason"] == "STOP"
    assert response.closed and session.closed
    assert session.created[0]["trust_env"] is False
    endpoint, request = session.requests[0]
    assert endpoint == ("https://aiplatform.googleapis.com/v1/projects/"
                        "project-70a86530-dd7e-4201-b95/locations/global/publishers/google/models/"
                        "gemini-3.8-flash:streamGenerateContent?alt=sse")
    assert request["json"]["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "LOW"}
    assert "temperature" not in request["json"]["generationConfig"]
    assert request["allow_redirects"] is False


async def test_manual_parallel_tool_continuation_keeps_signatures_and_ids(transport):
    parts = [{"functionCall": {"id": "fc-1", "name": "lookup_a", "args": {}},
              "thoughtSignature": "opaque-original"},
             {"functionCall": {"id": "fc-2", "name": "lookup_b", "args": {"value": 3}}}]
    session = transport(Response(sse(frame(parts, "STOP"))),
                        Response(sse(frame([{"text": "Confirmed."}], "STOP"))))
    history = copy.deepcopy(HISTORY)
    tools = [{"functionDeclarations": [{"name": "lookup_a", "parameters": {"type": "OBJECT"}}]}]
    async with vertex.VertexTextClient() as client:
        first = await events(client, history, tools=tools)
        assert len(first) == 1  # Function calls are never visible text or executed here.
        history.append(first[-1]["content"])
        history.append({"role": "user", "parts": [
            {"functionResponse": {"id": "fc-1", "name": "lookup_a", "response": {"ok": True}}},
            {"functionResponse": {"id": "fc-2", "name": "lookup_b", "response": {"ok": True}}},
        ]})
        await events(client, history, tools=tools)
    sent = session.requests[1][1]["json"]
    assert sent["contents"][1] == {"role": "model", "parts": parts}
    assert sent["contents"][2] == history[2]
    assert len(session.requests) == 2


async def test_eof_without_blank_line_keeps_final_signature(transport):
    transport(Response(sse(frame([{"text": "ok"}, {"text": "", "thoughtSignature": "sig"}], "STOP"),
                           ending=False)))
    async with vertex.VertexTextClient() as client:
        result = await events(client)
    assert result[-1]["content"]["parts"][-1] == {"text": "", "thoughtSignature": "sig"}


@pytest.mark.parametrize("finish", ["STOP", "MAX_TOKENS"])
async def test_terminal_frame_does_not_wait_for_http_eof(transport, finish):
    raw = [{"functionCall": {"id": "fc-1", "name": "lookup", "args": {}},
            "thoughtSignature": "opaque-original"}]

    class StalledTail(Body):
        async def iter_chunked(self, size):
            async for chunk in super().iter_chunked(size):
                yield chunk
            await asyncio.Event().wait()

    response = Response()
    response.content = StalledTail(sse(frame(raw, finish)))
    transport(response)
    async with vertex.VertexTextClient(chunk_timeout=.05) as client:
        if finish == "STOP":
            result = await events(client)
            assert len(result) == 1
            assert result[0]["type"] == "content"
            assert result[0]["content"] == {"role": "model", "parts": raw}
            assert result[0]["finish_reason"] == "STOP"
        else:
            with pytest.raises(vertex.VertexClientError, match="incomplete_response"):
                await events(client)
    assert response.closed


@pytest.mark.parametrize("raw,code", [
    (sse(frame([{"text": "cut off"}])), "incomplete_response"),
    (sse(frame([{"text": "cut off"}], "MAX_TOKENS")), "incomplete_response"),
    (sse({"error": {"message": "private upstream detail"}}), "upstream_error"),
    (sse({"promptFeedback": {"blockReason": "SAFETY"}}), "blocked"),
    (b"data: broken\n\n", "invalid_response"),
    (sse([1, 2, 3]), "invalid_response"),
    (sse({"candidates": [{"content": {"parts": [42]}}]}), "invalid_response"),
    (sse({"candidates": [{"index": 1}]}), "invalid_response"),
    (sse(frame([{"text": "ok"}], "MALFORMED_FUNCTION_CALL")), "incomplete_response"),
    (sse(frame([{"functionCall": {"name": "synthetic", "args": {"value": float("nan")}}}], "STOP")), "invalid_response"),
])
async def test_failed_or_incomplete_stream_never_emits_terminal_content(transport, raw, code):
    response = Response(raw)
    session = transport(response)
    received = []
    async with vertex.VertexTextClient() as client:
        with pytest.raises(vertex.VertexClientError) as error:
            async for event in client.stream(HISTORY):
                received.append(event)
    assert error.value.code == code
    assert not any(event["type"] == "content" for event in received)
    assert "private" not in str(error.value)
    assert response.closed and session.closed
    assert len(session.requests) == 1


@pytest.mark.parametrize("response,code,status", [
    (Response(b"SECRET BODY", status=401), "http_error", 401),
    (Response(b"SECRET BODY", status=429), "http_error", 429),
    (Response(b"SECRET BODY", status=302), "http_error", 302),
    (Response(b"SECRET BODY", content_type="application/json"), "invalid_response", None),
    (RuntimeError("proxy password and private url"), "transport_error", None),
])
async def test_http_and_transport_errors_sanitize_and_never_retry(transport, response, code, status):
    session = transport(response)
    async with vertex.VertexTextClient() as client:
        with pytest.raises(vertex.VertexClientError) as error:
            await events(client)
    assert error.value.code == code and error.value.http_status == status
    assert "SECRET" not in str(error.value) and "password" not in str(error.value)
    assert len(session.requests) == 1


@pytest.mark.parametrize("limits,body,code", [
    ({"max_response_bytes": 10}, sse(frame([{"text": "hello"}], "STOP")), "response_limit"),
    ({"max_event_bytes": 20}, sse(frame([{"text": "hello"}], "STOP")), "event_limit"),
    ({"max_parts": 1}, sse(frame([{"text": "one"}, {"text": "two"}], "STOP")), "parts_limit"),
    ({"max_text_chars": 2}, sse(frame([{"text": "hello"}], "STOP")), "text_limit"),
])
async def test_response_limits_close_transport(transport, limits, body, code):
    response = Response(body)
    transport(response)
    async with vertex.VertexTextClient(**limits) as client:
        with pytest.raises(vertex.VertexClientError) as error:
            await events(client)
    assert error.value.code == code and response.closed


@pytest.mark.parametrize("kwargs,history,model,code", [
    ({"max_history_bytes": 10}, HISTORY, vertex.DEFAULT_MODEL, "history_limit"),
    ({"max_history_messages": 1}, HISTORY * 2, vertex.DEFAULT_MODEL, "invalid_history"),
    ({}, [{"role": "tool", "parts": [{"text": "wrong role"}]}], vertex.DEFAULT_MODEL, "invalid_history"),
    ({}, [{"role": "user", "parts": []}], vertex.DEFAULT_MODEL, "invalid_history"),
    ({}, [{"role": "user", "parts": [{"text": float("nan")}]}], vertex.DEFAULT_MODEL, "invalid_history"),
    ({}, HISTORY, "../private?token=value", "invalid_model"),
])
async def test_input_rejected_before_auth_or_network(transport, kwargs, history, model, code):
    session = transport()
    async with vertex.VertexTextClient(**kwargs) as client:
        with pytest.raises(vertex.VertexClientError) as error:
            await events(client, history, model=model)
    assert error.value.code == code and not session.requests and not session.created


@pytest.mark.parametrize("kwargs", [
    {"project": "bad/project"}, {"location": "bad/location"},
    {"proxy_url": "socks5://localhost:1080"}, {"proxy_url": "https://localhost:bad"},
    {"total_timeout": 0}, {"max_parts": -1},
    {"auth_timeout": float("nan")}, {"chunk_timeout": float("inf")},
])
def test_invalid_constructor_settings(kwargs):
    with pytest.raises(vertex.VertexClientError):
        vertex.VertexTextClient(**kwargs)


async def test_text_proxy_only_and_model_override(transport, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://unrelated.invalid")
    session = transport(Response(sse(frame([{"text": "ok"}], "STOP"))))
    async with vertex.VertexTextClient(location="europe-west4", proxy_url="http://127.0.0.1:3128") as client:
        await events(client, model="gemini-3.7-flash")
    endpoint, request = session.requests[0]
    assert endpoint.startswith("https://europe-west4-aiplatform.googleapis.com/")
    assert "gemini-3.7-flash:streamGenerateContent" in endpoint
    assert request["proxy"] == "http://127.0.0.1:3128"
    assert session.created[0]["trust_env"] is False
    assert vertex.requests.utils.get_environ_proxies("https://example.com")["https"] == "http://unrelated.invalid"


async def test_request_snapshot_is_not_changed_during_auth(transport, monkeypatch):
    session = transport(Response(sse(frame([{"text": "ok"}], "STOP"))))
    history = copy.deepcopy(HISTORY)

    class MutatingAuth:
        async def token(self, timeout):
            history[0]["parts"][0]["text"] = "Changed after request started"
            return "synthetic"

    monkeypatch.setattr(vertex, "_adc_tokens", lambda _: MutatingAuth())
    async with vertex.VertexTextClient() as client:
        await events(client, history)
    assert session.requests[0][1]["json"]["contents"] == HISTORY


async def test_read_timeout_and_total_deadline_close_response(transport):
    for limits in ({"chunk_timeout": 0.005}, {"total_timeout": 0.005}):
        response = Response(sse(frame([{"text": "ok"}], "STOP")), delay=0.02)
        transport(response)
        async with vertex.VertexTextClient(**limits) as client:
            with pytest.raises(vertex.VertexClientError) as error:
                await events(client)
        assert error.value.code == "timeout" and response.closed


async def test_cancellation_and_hangup_close_active_response(transport):
    response = Response(sse(frame([{"text": "ok"}], "STOP")), delay=0.02)
    session = transport(response)
    client = vertex.VertexTextClient()
    task = asyncio.create_task(events(client))
    await asyncio.sleep(0.005)
    await client.close()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert response.closed and session.closed and not client._responses
    with pytest.raises(vertex.VertexClientError, match="closed"):
        await events(client)


async def test_early_generator_close_releases_response(transport):
    response = Response(sse(frame([{"text": "first"}]), frame([{"text": "last"}], "STOP")))
    transport(response)
    async with vertex.VertexTextClient() as client:
        stream = client.stream(HISTORY)
        assert (await anext(stream))["text"] == "first"
        await stream.aclose()
        assert response.closed and not client._responses


async def test_adc_single_flight_cache_and_bounded_http(monkeypatch):
    refreshes = []
    sessions = []
    request_timeouts = []

    class FakeCredentials:
        token = None
        valid = False

        def refresh(self, request):
            refreshes.append(True)
            time.sleep(0.01)
            request(url="https://oauth2.googleapis.com/token", timeout=120)
            self.token = "synthetic-credential"
            self.valid = True

    credentials = FakeCredentials()

    class AuthSession:
        trust_env = True
        closed = False

        def close(self):
            self.closed = True

    def session_factory():
        session = AuthSession()
        sessions.append(session)
        return session

    def request_factory(session):
        def request(*args, **kwargs):
            request_timeouts.append(kwargs["timeout"])
        return request

    monkeypatch.setattr(vertex.requests, "Session", session_factory)
    monkeypatch.setattr(vertex.google.auth.transport.requests, "Request", request_factory)
    monkeypatch.setattr(vertex.google.auth, "default", lambda **kwargs: (credentials, "ignored"))
    auth = vertex._AdcTokens("synthetic-project")
    tokens = await asyncio.gather(*(auth.token(0.1) for _ in range(8)))
    assert len(set(tokens)) == 1 and len(refreshes) == 1
    assert await auth.token(0.1) == tokens[0] and len(refreshes) == 1
    assert all(not session.trust_env and session.closed for session in sessions)
    assert 0 < request_timeouts[0] <= 0.1


async def test_auth_timeout_retains_one_worker_and_hides_failure(monkeypatch):
    calls = []

    def refresh(timeout):
        calls.append(True)
        time.sleep(0.04)
        raise RuntimeError("private OAuth token details")

    auth = vertex._AdcTokens("synthetic-project")
    monkeypatch.setattr(auth, "_refresh", refresh)
    for _ in range(2):
        with pytest.raises(vertex.VertexClientError) as error:
            await auth.token(0.005)
        assert error.value.code == "auth_timeout" and "private" not in str(error.value)
    assert len(calls) == 1
    await asyncio.sleep(0.05)
    assert auth._task.done()


async def test_adc_provider_shared_for_project_on_current_loop():
    assert vertex._adc_tokens("synthetic-cache-a") is vertex._adc_tokens("synthetic-cache-a")
    assert vertex._adc_tokens("synthetic-cache-a") is not vertex._adc_tokens("synthetic-cache-b")


@pytest.mark.parametrize('delay_stage', ['headers', 'first_body'])
async def test_model_first_byte_uses_total_budget_not_idle_chunk_timeout(monkeypatch, delay_stage):
    """Real HTTP: a valid thinking delay must not inherit streaming idle timeout."""
    import aiohttp
    from aiohttp import web
    real_session = aiohttp.ClientSession
    async def handler(request):
        if delay_stage == 'headers':
            await asyncio.sleep(.06)
        response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
        await response.prepare(request)
        if delay_stage == 'first_body':
            await asyncio.sleep(.06)
        await response.write(sse(frame([{'text': 'Ready.'}], 'STOP')))
        await response.write_eof()
        return response
    app = web.Application()
    app.router.add_post('/', handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    class LocalSession:
        def __init__(self, **kwargs):
            self.inner = real_session(**kwargs)
        def post(self, endpoint, **kwargs):
            return self.inner.post(f'http://127.0.0.1:{port}/', **kwargs)
        async def close(self):
            await self.inner.close()
    class Tokens:
        async def token(self, timeout):
            return 'synthetic'
    monkeypatch.setattr(vertex.aiohttp, 'ClientSession', LocalSession)
    monkeypatch.setattr(vertex, '_adc_tokens', lambda _: Tokens())
    try:
        async with vertex.VertexTextClient(chunk_timeout=.02, total_timeout=.3) as client:
            result = await events(client)
            assert result[-1]['finish_reason'] == 'STOP'
            assert client.last_request_metrics['phase'] == 'complete'
            assert client.last_request_metrics['elapsed_ms'] >= 50
            assert client.last_request_metrics['http_status'] == 200
    finally:
        await runner.cleanup()


async def test_first_body_is_still_bounded_by_total_deadline(transport):
    response = Response(sse(frame([{'text': 'Ready.'}], 'STOP')), delay=.06)
    transport(response)
    async with vertex.VertexTextClient(chunk_timeout=.01, total_timeout=.03) as client:
        with pytest.raises(vertex.VertexClientError) as error:
            await events(client)
        assert error.value.code == 'timeout'
        assert client.last_request_metrics['phase'] == 'body'
        assert client.last_request_metrics['failure_code'] == 'timeout'
    assert response.closed
