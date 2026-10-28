"""Response/tool ordering regressions with a local WebSocket boundary fixture."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.providers import yandex_realtime as module


def subject(monkeypatch, execute):
    provider = module.YandexRealtimeProvider(SimpleNamespace(tool_timeout_seconds=1), lambda event: None)
    provider._call_id, provider._closing = "fixture", False
    provider._context = {"tools": ["fixture_lookup"], "tool_executor": execute}
    provider.websocket = SimpleNamespace(closed=False, send_json=AsyncMock(), close=AsyncMock())
    monkeypatch.setattr(module.tool_registry, "is_tool_allowed", lambda *a: True)
    monkeypatch.setattr(module.tool_registry, "get", lambda name: SimpleNamespace(execute=execute))
    monkeypatch.setattr(module.ToolExecutionContext, "get_tool_block_response", AsyncMock(return_value=None))
    return provider


async def start_tool(provider, invocation, response="r1"):
    await provider._handle_event({"type": "response.output_item.done", "response_id": response,
        "item": {"type": "function_call", "call_id": invocation,
                 "name": "fixture_lookup", "arguments": "{}"}})


def sends(provider, kind):
    return [c.args[0] for c in provider.websocket.send_json.call_args_list if c.args[0]["type"] == kind]


@pytest.mark.asyncio
async def test_parallel_results_continue_once_only_after_complete_group(monkeypatch):
    release = asyncio.Event()
    async def execute(*args, **kwargs):
        if kwargs["idempotency_key"].endswith(":second"):
            await release.wait()
        return {"status": "success", "data": "fixture"}
    provider = subject(monkeypatch, AsyncMock(side_effect=execute))
    await provider._handle_event({"type": "response.created", "response": {"id": "r1"}})
    await start_tool(provider, "first")
    await start_tool(provider, "second")
    await provider._tool_tasks["first"]
    assert len(sends(provider, "conversation.item.create")) == 1
    assert not sends(provider, "response.create")
    await provider._handle_event({"type": "response.done", "response": {"id": "r1", "status": "completed"}})
    assert not sends(provider, "response.create")
    release.set()
    await provider._tool_tasks["second"]
    assert len(sends(provider, "conversation.item.create")) == 2
    assert len(sends(provider, "response.create")) == 1
    await provider.stop_session()


@pytest.mark.asyncio
async def test_fast_tool_waits_for_response_done_without_a_second_model_dispatch(monkeypatch):
    executor = AsyncMock(return_value={"status": "success"})
    provider = subject(monkeypatch, executor)
    await provider._handle_event({"type": "response.created", "response": {"id": "r1"}})
    await start_tool(provider, "single")
    await provider._tool_tasks["single"]
    assert not sends(provider, "response.create")
    terminal = {"type": "response.done", "response": {"id": "r1", "status": "completed"}}
    await provider._handle_event(terminal)
    await provider._handle_event(terminal)
    await start_tool(provider, "single")
    assert executor.await_count == 1 and len(sends(provider, "response.create")) == 1
    await provider.stop_session()


@pytest.mark.asyncio
async def test_interrupted_submitted_tool_keeps_result_without_reviving_old_response(monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    async def execute(*args, **kwargs):
        entered.set()
        await release.wait()
        return {"status": "success", "data": "accepted-once"}
    executor = AsyncMock(side_effect=execute)
    provider = subject(monkeypatch, executor)
    await provider._handle_event({"type": "response.created", "response": {"id": "r1"}})
    await start_tool(provider, "action")
    await entered.wait()
    await provider._handle_event({"type": "input_audio_buffer.speech_started"})
    await provider._handle_event({"type": "response.done", "response": {"id": "r1", "status": "cancelled"}})
    await provider._handle_event({"type": "response.created", "response": {"id": "new-answer"}})
    release.set()
    await provider._tool_tasks["action"]
    assert executor.await_count == 1 and len(sends(provider, "conversation.item.create")) == 1
    assert not sends(provider, "response.create")
    await provider.stop_session()


@pytest.mark.asyncio
async def test_late_unsubmitted_call_after_barge_in_never_executes(monkeypatch):
    executor = AsyncMock(return_value={"status": "success"})
    provider = subject(monkeypatch, executor)
    await provider._handle_event({"type": "response.created", "response": {"id": "r1"}})
    await provider._handle_event({"type": "input_audio_buffer.speech_started"})
    await start_tool(provider, "late")
    await provider._tool_tasks["late"]
    executor.assert_not_awaited()
    output = json.loads(sends(provider, "conversation.item.create")[0]["item"]["output"])
    assert output["code"] == "tool_not_submitted"
    assert not sends(provider, "response.create")
    await provider.stop_session()


@pytest.mark.asyncio
async def test_guard_speech_block_is_preserved_and_stops_continuation(monkeypatch):
    executor = AsyncMock(return_value={"status": "blocked", "ai_should_speak": False,
                                      "code": "voice_human_takeover", "outcome": "not_submitted"})
    provider = subject(monkeypatch, executor)
    await provider._handle_event({"type": "response.created", "response": {"id": "r1"}})
    await start_tool(provider, "blocked")
    await provider._tool_tasks["blocked"]
    await provider._handle_event({"type": "response.done", "response": {"id": "r1", "status": "completed"}})
    output = json.loads(sends(provider, "conversation.item.create")[0]["item"]["output"])
    assert output["ai_should_speak"] is False and output["code"] == "voice_human_takeover"
    assert output["outcome"] == "not_submitted" and not sends(provider, "response.create")
    await provider.stop_session()
