"""Safety regressions for the opt-in probe, independent of provider implementation."""
import asyncio
from types import SimpleNamespace
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import wave

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/yandex-realtime-smoke.py"
spec = importlib.util.spec_from_file_location("yandex_probe", SCRIPT)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def test_default_does_not_authorize_metered_probe_or_expose_env():
    env = dict(os.environ, YANDEX_CLOUD_API_KEY="secret-sentinel", YANDEX_CLOUD_FOLDER_ID="folder-sentinel")
    result = subprocess.run([sys.executable, str(SCRIPT)], env=env, text=True, capture_output=True, timeout=3)
    assert result.returncode == 0
    assert json.loads(result.stdout)["live"] is False
    assert "sentinel" not in result.stdout + result.stderr


def test_live_missing_credentials_reports_no_values():
    env = {k: v for k, v in os.environ.items() if k not in {"YANDEX_CLOUD_API_KEY", "YANDEX_CLOUD_FOLDER_ID"}}
    result = subprocess.run([sys.executable, str(SCRIPT), "--live"], env=env, text=True, capture_output=True, timeout=3)
    assert result.returncode == 1
    report = json.loads(result.stdout)
    assert report["passed"] is False
    assert report["phase"] == "credentials"
    assert report["failure_code"] == "unclassified"
    assert report["error_class"] == "ValueError"
    assert report["details"] == "suppressed"
    assert not result.stderr


def test_general_family_voice_rejected_before_connection():
    with pytest.raises(ValueError):
        probe.session_payload("dasha", "friendly", 24000)


@pytest.mark.parametrize("channels,width,rate,seconds", [(2, 2, 24000, 1), (1, 1, 24000, 1), (1, 2, 8000, 1), (1, 2, 24000, 21)])
def test_invalid_audio_fixture_rejected(tmp_path, channels, width, rate, seconds):
    path = tmp_path / "synthetic.wav"
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(width)
        wav.setframerate(rate)
        wav.writeframes(bytes(channels * width * rate * seconds))
    with pytest.raises(ValueError):
        probe.pcm_fixture(str(path), 24000)


@pytest.mark.parametrize("error", [
    {"code": "invalid_request", "type": "invalid_request_error", "param": "session.audio.input", "message": "secret-sentinel", "nested": {"key": "secret-sentinel"}},
    {"code": "Bearer secret-sentinel", "type": "https://secret-sentinel", "param": "x" * 100},
    "secret-sentinel",
])
def test_server_error_only_bounded_machine_identifiers(error):
    safe = probe.safe_server_error(error)
    assert "secret-sentinel" not in json.dumps(safe)
    assert set(safe) <= {"code", "type", "param"}
    if isinstance(error, dict) and error.get("code") == "invalid_request":
        assert safe == {k: error[k] for k in ("code", "type", "param")}
    else:
        assert safe == {}


@pytest.mark.parametrize("exc,code", [
    (probe.ProbeFailure("input_turn_incomplete"), "input_turn_incomplete"),
    (RuntimeError("https://secret-sentinel user prompt toolargs"), "unclassified"),
    (TimeoutError("secret-sentinel"), "timeout"),
])
def test_failure_keeps_phase_counts_and_audio_evidence_without_exception_text(monkeypatch, exc, code):
    async def failed(args, report):
        report.update(phase="audio", audio_bytes=1234, transcript_received=True,
                      first_audio_ms=99, interrupted_response="secret-sentinel")
        report["events"]["response.output_audio.delta"] = 4
        raise exc
    monkeypatch.setattr(probe, "_probe", failed)
    report = asyncio.run(probe.probe(SimpleNamespace()))
    assert report["phase"] == "audio"
    assert report["audio_bytes"] == 1234
    assert report["transcript_received"] is True
    assert report["events"]["response.output_audio.delta"] == 4
    assert report["first_audio_ms"] == 99
    assert report["elapsed_ms"] >= 0
    assert report["failure_code"] == code
    assert "secret-sentinel" not in json.dumps(report)

@pytest.mark.parametrize("event,expected_code", [
    ({"type": "error", "error": {"code": "invalid_audio", "type": "invalid_request_error", "param": "session.audio", "message": "secret-sentinel"}}, "server_error"),
    ({"type": "response.done", "response": {"status": "failed", "status_details": {"error": {"code": "model_error", "message": "secret-sentinel"}}}}, "response_failed"),
])
def test_protocol_failure_safe_receipt(monkeypatch, event, expected_code):
    import aiohttp
    class Socket:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def send_json(self, value):
            pass
        def __aiter__(self):
            return self
        async def __anext__(self):
            if getattr(self, "sent", False):
                raise StopAsyncIteration
            self.sent = True
            return SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=json.dumps(event))
    class Client:
        def __init__(self, **kwargs):
            assert kwargs["trust_env"] is False
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        def ws_connect(self, *args, **kwargs):
            assert kwargs["proxy"] is None
            return Socket()
    monkeypatch.setattr(aiohttp, "ClientSession", Client)
    monkeypatch.setenv("YANDEX_CLOUD_API_KEY", "secret-sentinel")
    monkeypatch.setenv("YANDEX_CLOUD_FOLDER_ID", "secret-sentinel")
    report = asyncio.run(probe.probe(SimpleNamespace(wav=None, rate=24000, timeout=3, voice="sofia", role="support")))
    assert report["failure_code"] == expected_code
    assert report["phase"] == "setup"
    assert report["server_error"]["code"] in {"invalid_audio", "model_error"}
    if expected_code == "response_failed":
        assert report["response_status"] == "failed"
    assert "secret-sentinel" not in json.dumps(report)

@pytest.mark.parametrize("final_answer", [True, False])
def test_split_vad_cancelled_answer_waits_for_final_input_answer(monkeypatch, final_answer):
    import aiohttp
    def response(kind, identifier, **kwargs):
        return {"type": kind, "response": {"id": identifier, **kwargs}}
    events = [
        {"type": "session.updated"}, response("response.created", "greeting"),
        {"type": "response.output_audio.delta", "response_id": "greeting", "delta": "AAA="},
        response("response.done", "greeting", status="completed"),
        {"type": "input_audio_buffer.speech_started"},
        {"type": "input_audio_buffer.speech_stopped"},
        response("response.created", "intermediate"),
        {"type": "response.output_audio.delta", "response_id": "intermediate", "delta": "AAA="},
        {"type": "input_audio_buffer.speech_started"},
        response("response.done", "intermediate", status="cancelled"),
        {"type": "input_audio_buffer.speech_stopped"},
        {"type": "conversation.item.input_audio_transcription.completed", "transcript": "secret-sentinel"},
    ]
    if final_answer:
        events += [response("response.created", "final"),
                   {"type": "response.output_audio.delta", "response_id": "final", "delta": "AAAAAA=="},
                   response("response.done", "final", status="completed")]
    sent = []
    class Socket:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def send_json(self, value): sent.append(value)
        def __aiter__(self): return self
        async def __anext__(self):
            await asyncio.sleep(0.005)
            if not events: raise StopAsyncIteration
            return SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=json.dumps(events.pop(0)))
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def ws_connect(self, *args, **kwargs): return Socket()
    monkeypatch.setattr(aiohttp, "ClientSession", Client)
    monkeypatch.setattr(probe, "pcm_fixture", lambda *args: bytes(2))
    monkeypatch.setenv("YANDEX_CLOUD_API_KEY", "secret-sentinel")
    monkeypatch.setenv("YANDEX_CLOUD_FOLDER_ID", "secret-sentinel")
    report = asyncio.run(probe.probe(SimpleNamespace(wav="synthetic", rate=50, timeout=3, voice="sofia", role="support")))
    assert report["cancelled_responses"] == 1
    assert report["failure_code"] == "session_closed"
    assert report["passed"] is False
    assert report["phase"] == ("tool" if final_answer else "audio")
    assert report.get("final_input_response_completed", False) is final_answer
    if final_answer:
        assert report["input_turn_audio_bytes"] == 4  # excludes superseded output
    assert "secret-sentinel" not in json.dumps(report)


@pytest.mark.parametrize("continuation_audio", [True, False])
def test_input_function_response_waits_for_its_audio_continuation(monkeypatch, continuation_audio):
    import aiohttp
    events = [
        {"type": "session.updated"},
        {"type": "response.created", "response": {"id": "greeting"}},
        {"type": "response.output_audio.delta", "response_id": "greeting", "delta": "AAA="},
        {"type": "response.done", "response": {"id": "greeting", "status": "completed"}},
        {"type": "input_audio_buffer.speech_started"},
        {"type": "input_audio_buffer.speech_stopped"},
        {"type": "conversation.item.input_audio_transcription.completed", "transcript": "secret-sentinel"},
        {"type": "response.created", "response": {"id": "function-turn"}},
        {"type": "response.output_item.done", "response_id": "function-turn", "item": {"type": "function_call", "name": "acceptance_marker", "call_id": "f1", "arguments": "{}"}},
        {"type": "response.done", "response": {"id": "function-turn", "status": "completed"}},
    ]
    if continuation_audio:
        events += [
            {"type": "response.created", "response": {"id": "continuation"}},
            {"type": "response.output_audio.delta", "response_id": "continuation", "delta": "AAAAAA=="},
            {"type": "response.done", "response": {"id": "continuation", "status": "completed"}},
        ]
    sent = []
    class Socket:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def send_json(self, value): sent.append(value)
        def __aiter__(self): return self
        async def __anext__(self):
            await asyncio.sleep(0.005)
            if not events: raise StopAsyncIteration
            return SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=json.dumps(events.pop(0)))
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def ws_connect(self, *args, **kwargs): return Socket()
    monkeypatch.setattr(aiohttp, "ClientSession", Client)
    monkeypatch.setattr(probe, "pcm_fixture", lambda *args: bytes(2))
    monkeypatch.setenv("YANDEX_CLOUD_API_KEY", "secret-sentinel")
    monkeypatch.setenv("YANDEX_CLOUD_FOLDER_ID", "secret-sentinel")
    report = asyncio.run(probe.probe(SimpleNamespace(wav="synthetic", rate=50, timeout=3, voice="sofia", role="support")))
    assert report["function_responses_awaiting_continuation"] == 1
    assert report["tool_executions"] == 1
    assert any(item.get("item", {}).get("type") == "function_call_output" for item in sent)
    assert report["phase"] == ("tool" if continuation_audio else "audio")
    assert report["passed"] is False and report["failure_code"] == "session_closed"
    assert report.get("final_input_response_completed", False) is continuation_audio
    assert "secret-sentinel" not in json.dumps(report)
