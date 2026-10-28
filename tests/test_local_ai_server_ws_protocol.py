from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


def _load_ws_protocol_modules():
    local_ai_dir = Path(__file__).resolve().parents[1] / "local_ai_server"
    sys.path.insert(0, str(local_ai_dir))
    try:
        ws_protocol = importlib.import_module("ws_protocol")
        session_mod = importlib.import_module("session")
        return ws_protocol, session_mod
    finally:
        if sys.path and sys.path[0] == str(local_ai_dir):
            sys.path.pop(0)


class _FakeServer:
    def __init__(self):
        self.ws_auth_token = None
        self.sent_payloads = []
        self.clear_calls = []

    async def _send_json(self, _websocket, payload):
        self.sent_payloads.append(payload)

    def _clear_whisper_stt_suppression(self, session, *, reason: str):
        self.clear_calls.append({"call_id": session.call_id, "reason": reason})


@pytest.mark.asyncio
async def test_ws_protocol_handles_barge_in_and_returns_ack():
    ws_protocol_mod, session_mod = _load_ws_protocol_modules()
    protocol = ws_protocol_mod.WebSocketProtocol(_FakeServer())
    session = session_mod.SessionContext(call_id="seed")

    await protocol.handle_json_message(
        websocket=None,
        session=session,
        message='{"type":"barge_in","call_id":"call-123","request_id":"barge-1"}',
    )

    assert protocol._server.clear_calls == [{"call_id": "call-123", "reason": "engine_barge_in"}]
    assert protocol._server.sent_payloads[-1] == {
        "type": "barge_in_ack",
        "status": "ok",
        "call_id": "call-123",
        "request_id": "barge-1",
    }


@pytest.mark.asyncio
async def test_ws_protocol_normalizes_hyphenated_barge_type():
    ws_protocol_mod, session_mod = _load_ws_protocol_modules()
    protocol = ws_protocol_mod.WebSocketProtocol(_FakeServer())
    session = session_mod.SessionContext(call_id="seed")

    await protocol.handle_json_message(
        websocket=None,
        session=session,
        message='{"type":"  barge-in\\u0000  ","call_id":"call-xyz","request_id":"barge-2"}',
    )

    assert protocol._server.clear_calls == [{"call_id": "call-xyz", "reason": "engine_barge_in"}]
    assert protocol._server.sent_payloads[-1]["type"] == "barge_in_ack"
    assert protocol._server.sent_payloads[-1]["request_id"] == "barge-2"
