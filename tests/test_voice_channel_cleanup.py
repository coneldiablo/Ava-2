"""Regression of failed startup retaining AudioSocket and blocking later calls."""
import asyncio
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.config import AppConfig
from src.core.models import CallSession
from src.engine import Engine, _cleanup_in_progress, _cleanup_completed_at
from src.audio.audiosocket_server import AudioSocketServer


def make_engine():
    config = AppConfig(**{
        'default_provider': 'local', 'providers': {'local': {'enabled': True}},
        'asterisk': {'host': '127.0.0.1', 'username': 'u', 'password': 'p'},
        'llm': {'initial_greeting': 'Hi', 'prompt': 'Test', 'model': 'test'},
        'audio_transport': 'audiosocket',
    })
    engine = Engine(config)
    engine._execute_post_call_tools = AsyncMock()
    engine._persist_call_history = AsyncMock()
    engine._stop_background_music = AsyncMock()
    engine._disable_pipeline_talk_detect = AsyncMock()
    engine.streaming_playback_manager.stop_streaming_playback = AsyncMock()
    engine.ari_client = SimpleNamespace(destroy_bridge=AsyncMock(), hangup_channel=AsyncMock())
    return engine


async def add_call(engine):
    call = CallSession(call_id=uuid.uuid4().hex, caller_channel_id=uuid.uuid4().hex,
                       provider_name='local', bridge_id='bridge')
    call.audiosocket_conn_id = 'primary-' + call.call_id
    call.audiosocket_channel_id = 'audio-' + call.call_id
    await engine.session_store.upsert_call(call)
    return call


@pytest.mark.asyncio
async def test_startup_task_can_cleanup_itself_and_next_call_without_socket_deadlock():
    engine = make_engine()
    closed = set()
    engine.audio_socket_server = SimpleNamespace(disconnect=AsyncMock(side_effect=lambda conn: closed.add(conn)))
    call = await add_call(engine)
    other = await add_call(engine)
    extra = 'secondary'
    engine.channel_to_conns[call.caller_channel_id] = {extra, call.audiosocket_conn_id}
    engine.conn_to_channel[extra] = call.caller_channel_id

    async def ari_teardown(*args):
        assert call.audiosocket_conn_id in closed
        assert extra in closed
        assert other.audiosocket_conn_id not in closed

    engine.ari_client.destroy_bridge.side_effect = ari_teardown
    engine.ari_client.hangup_channel.side_effect = ari_teardown
    # This is the exact ownership used by _ensure_provider_session_started:
    # the failing startup task enters its own cleanup, without cancellation.
    async def failing_startup():
        engine._provider_start_tasks[call.call_id] = asyncio.current_task()
        await engine._cleanup_call(call.call_id)
        return 'cleanup-finished'
    assert await asyncio.wait_for(asyncio.create_task(failing_startup()), 1) == 'cleanup-finished'
    assert await engine.session_store.get_by_call_id(call.call_id) is None
    assert call.call_id not in _cleanup_in_progress
    engine._persist_call_history.assert_awaited_once()
    assert await engine.session_store.get_by_call_id(other.call_id) is other
    engine.ari_client.destroy_bridge.side_effect = None
    engine.ari_client.hangup_channel.side_effect = None
    await asyncio.wait_for(engine._cleanup_call(other.call_id), 1)
    assert (await engine.session_store.get_session_stats())['active_calls'] == 0


@pytest.mark.asyncio
async def test_unresponsive_ari_and_provider_do_not_prevent_transport_release_or_history():
    engine = make_engine()
    call = await add_call(engine)
    closed = asyncio.Event()
    engine.audio_socket_server = SimpleNamespace(disconnect=AsyncMock(side_effect=lambda _: closed.set()))
    async def stuck(*args):
        assert closed.is_set()
        await asyncio.Future()
    engine.ari_client.destroy_bridge.side_effect = stuck
    engine.ari_client.hangup_channel.side_effect = stuck
    engine._call_providers[call.call_id] = SimpleNamespace(stop_session=stuck)
    original = engine._bounded_call_teardown
    async def shorter(call_id, operation, awaitable, timeout=3):
        return await original(call_id, operation, awaitable, timeout=0.01)
    engine._bounded_call_teardown = shorter
    await asyncio.wait_for(engine._cleanup_call(call.call_id), 1)
    assert closed.is_set()
    assert await engine.session_store.get_by_call_id(call.call_id) is None
    engine._persist_call_history.assert_awaited_once_with(call, call.call_id)
    assert call.call_id not in engine._call_providers


@pytest.mark.asyncio
async def test_concurrent_end_events_do_not_release_another_cleanup_owners_guard():
    engine = make_engine()
    call = await add_call(engine)
    engine.audio_socket_server = SimpleNamespace(disconnect=AsyncMock())
    entered, finish = asyncio.Event(), asyncio.Event()
    async def post_call(*args, **kwargs):
        entered.set()
        await finish.wait()
    engine._execute_post_call_tools.side_effect = post_call
    first = asyncio.create_task(engine._cleanup_call(call.call_id))
    await asyncio.wait_for(entered.wait(), 1)
    await engine._cleanup_call(call.caller_channel_id)
    assert call.call_id in _cleanup_in_progress
    finish.set()
    await asyncio.wait_for(first, 1)
    assert call.call_id not in _cleanup_in_progress
    engine._execute_post_call_tools.assert_awaited_once()


@pytest.mark.asyncio
async def test_transferred_caller_is_preserved_while_ai_media_closes():
    engine = make_engine()
    call = await add_call(engine)
    call.transfer_active = True
    engine.audio_socket_server = SimpleNamespace(disconnect=AsyncMock())
    await engine._cleanup_call(call.call_id)
    engine.audio_socket_server.disconnect.assert_awaited_once_with(call.audiosocket_conn_id)
    assert all(c.args[0] != call.caller_channel_id for c in engine.ari_client.hangup_channel.call_args_list)


@pytest.mark.asyncio
async def test_real_tcp_disconnect_closes_peer_even_when_audio_callback_is_stuck():
    entered = asyncio.Event()
    async def on_uuid(*args):
        entered.set()
        await asyncio.Future()
    server = AudioSocketServer('127.0.0.1', 0, on_uuid=on_uuid, on_audio=AsyncMock(), on_disconnect=AsyncMock())
    await server.start()
    reader, writer = await asyncio.open_connection('127.0.0.1', server.port)
    writer.write(b'\x01\x00\x10' + uuid.uuid4().bytes)
    await writer.drain()
    try:
        await asyncio.wait_for(entered.wait(), 1)
        conn = next(iter(server._writers))
        await asyncio.wait_for(server.disconnect(conn), 1)
        assert await asyncio.wait_for(reader.read(), 1) == b''
        await asyncio.sleep(0)
        assert server.get_connection_count() == 0
        assert not server._connection_tasks
    finally:
        writer.close()
        await writer.wait_closed()
        await server.stop()


@pytest.mark.asyncio
async def test_cancelled_cleanup_can_retry_instead_of_retaining_completed_ttl():
    engine = make_engine()
    call = await add_call(engine)
    entered = asyncio.Event()
    async def interrupted(*args):
        entered.set()
        await asyncio.Future()
    engine.audio_socket_server = SimpleNamespace(disconnect=interrupted)
    cleanup = asyncio.create_task(engine._cleanup_call(call.call_id))
    await asyncio.wait_for(entered.wait(), 1)
    cleanup.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cleanup
    assert call.call_id not in _cleanup_in_progress
    assert call.call_id not in _cleanup_completed_at
    engine.audio_socket_server.disconnect = AsyncMock()
    await engine._cleanup_call(call.call_id)
    assert await engine.session_store.get_by_call_id(call.call_id) is None


@pytest.mark.asyncio
async def test_provider_disconnect_on_its_own_task_preserves_task_identity():
    engine = make_engine()
    call = await add_call(engine)
    call.provider_name = 'neuro_gemini'
    engine.audio_socket_server = SimpleNamespace(disconnect=AsyncMock())
    original = asyncio.current_task()
    async def stop_session():
        # Real Neuro stop cancels all provider tasks except its current task.
        # A child wait_for task would cancel this awaiting provider task.
        assert asyncio.current_task() is original
    engine._call_providers[call.call_id] = SimpleNamespace(stop_session=stop_session)
    await engine.on_provider_event({'type': 'ProviderDisconnected', 'call_id': call.call_id,
                                    'provider': 'neuro_gemini'})
    assert await engine.session_store.get_by_call_id(call.call_id) is None
    engine._persist_call_history.assert_awaited_once_with(call, call.call_id)


@pytest.mark.asyncio
async def test_late_provider_update_cannot_resurrect_completed_call():
    engine = make_engine()
    call = await add_call(engine)
    engine.audio_socket_server = SimpleNamespace(disconnect=AsyncMock())
    await engine._cleanup_call(call.call_id)
    call.provider_session_active = True
    await engine._save_session(call)
    assert await engine.session_store.get_by_call_id(call.call_id) is None


@pytest.mark.asyncio
@pytest.mark.parametrize('shutdown', ['peer', 'disconnect', 'stop'])
async def test_first_audio_tracking_is_released_after_each_tcp_connection(shutdown):
    received = asyncio.Event()
    async def on_audio(*args):
        received.set()
    server = AudioSocketServer('127.0.0.1', 0, on_uuid=AsyncMock(return_value=True),
                               on_audio=on_audio, on_disconnect=AsyncMock())
    await server.start()
    try:
        for _ in range(3):
            received.clear()
            reader, writer = await asyncio.open_connection('127.0.0.1', server.port)
            writer.write(b'\x01\x00\x10' + uuid.uuid4().bytes + b'\x10\x01\x40' + bytes(320))
            await writer.drain()
            await asyncio.wait_for(received.wait(), 1)
            assert len(server._first_audio_logged) == 1
            conn = next(iter(server._writers))
            if shutdown == 'disconnect':
                await server.disconnect(conn)
            elif shutdown == 'stop':
                await server.stop()
            else:
                writer.close()
            await asyncio.wait_for(reader.read(), 1)
            writer.close()
            await writer.wait_closed()
            async with asyncio.timeout(1):
                while server._connection_tasks:
                    await asyncio.sleep(0)
            assert not server._first_audio_logged
            assert not server._writers and not server._conn_to_uuid
            if shutdown == 'stop':
                await server.start()
    finally:
        await server.stop()
