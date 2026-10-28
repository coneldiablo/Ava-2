"""Caller-only loop, bounded audio, interruption and real AudioSocket IO."""
import asyncio
import audioop
import struct
import uuid
import wave
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.audio.outbound_ambience import OutboundAmbience, load_office_loop
from src.audio.audiosocket_server import AudioSocketServer
from src.engine import Engine


def pcm(value, samples=160):
    return struct.pack('<h', value) * samples


def test_loop_wrap_and_invalid_asset(tmp_path):
    # No task is needed to test the final fractional frame wrapping.
    mix = object.__new__(OutboundAmbience)
    mix.pcm, mix.cursor = pcm(1, 1) + pcm(2, 1), 2
    assert mix._bed() == (pcm(2, 1) + pcm(1, 1)) * 80
    path = tmp_path/'bad.wav'
    with wave.open(str(path), 'wb') as f:
        f.setparams((2, 2, 8000, 0, 'NONE', 'not compressed')); f.writeframes(pcm(100))
    with pytest.raises(ValueError, match='ambience_format'):
        load_office_loop(path)


async def test_idle_loop_and_voice_mix_keep_running_after_clear():
    output, ready = [], asyncio.Event()
    async def write(data):
        output.append(data)
        if len(output) >= 5: ready.set()
        return True
    mix = OutboundAmbience(pcm(120), 'pcm16', write)
    try:
        assert await mix.send(pcm(400))
        await asyncio.wait_for(ready.wait(), .5)
        assert output[0] == pcm(520)
        assert all(frame == pcm(120) for frame in output[1:])
        assert await mix.send(pcm(900, 320))
        await mix.clear()
        size = len(output)
        await asyncio.sleep(.05)
        assert len(output) > size
        assert all(frame == pcm(120) for frame in output[size:])
    finally:
        await mix.close()
    assert mix.task.done() and not mix.voice


async def test_bounded_voice_backpressure_unblocks_on_disconnect():
    started, release = asyncio.Event(), asyncio.Event()
    async def write(data):
        started.set(); await release.wait(); return True
    mix = OutboundAmbience(pcm(50), 'pcm16', write)
    sender = asyncio.create_task(mix.send(pcm(1000, 16000)))
    await asyncio.wait_for(started.wait(), .5)
    assert len(mix.voice) <= mix.LIMIT and not sender.done()
    await mix.close()
    assert await asyncio.wait_for(sender, .5) is False
    assert not mix.voice


@pytest.mark.parametrize('encoding', ['ulaw', 'pcm16'])
async def test_real_socket_background_never_calls_inbound_asr(tmp_path, encoding):
    path = tmp_path/'office.wav'
    with wave.open(str(path), 'wb') as f:
        f.setparams((1,2,8000,0,'NONE','not compressed')); f.writeframes(pcm(120,1600))
    received, bound, connected = [], asyncio.Event(), []
    async def on_uuid(conn, value):
        connected.append(conn)
        await server.start_ambience(conn, path, encoding)
        bound.set(); return True
    async def on_audio(conn, data): received.append(data)
    server = AudioSocketServer('127.0.0.1',0,on_uuid=on_uuid,on_audio=on_audio)
    await server.start()
    reader, writer = await asyncio.open_connection('127.0.0.1', server.port)
    try:
        writer.write(b'\x01\x00\x10'+uuid.uuid4().bytes); await writer.drain()
        await asyncio.wait_for(bound.wait(),.5)
        for _ in range(3):
            h=await asyncio.wait_for(reader.readexactly(3),.5)
            audio=await reader.readexactly(int.from_bytes(h[1:],'big'))
            assert h[0]==0x10 and len(audio)==(160 if encoding=='ulaw' else 320)
            assert audioop.rms(audioop.ulaw2lin(audio,2) if encoding=='ulaw' else audio,2)>0
        assert received == []
        inbound=b'caller-input-unmodified'
        writer.write(b'\x10'+len(inbound).to_bytes(2,'big')+inbound); await writer.drain()
        for _ in range(20):
            if received: break
            await asyncio.sleep(.005)
        assert received == [inbound]
        await server.disconnect(connected[0])
        assert not server._ambience
    finally:
        writer.close(); await writer.wait_closed(); await server.stop()
    assert not server._connection_tasks and not server._ambience


async def test_only_enabled_business_on_supported_wire_gets_background():
    e=object.__new__(Engine)
    e.config=SimpleNamespace(ambient_audio=SimpleNamespace(enabled=True,business_ids=[9],wav_path='office.wav'),
                             audiosocket=SimpleNamespace(format='ulaw'))
    e.audio_socket_server=SimpleNamespace(start_ambience=AsyncMock())
    session=SimpleNamespace(business_id=1,call_id='call',transport_profile=SimpleNamespace(wire_sample_rate=8000))
    await e._enable_call_ambience(session,'conn')
    e.audio_socket_server.start_ambience.assert_not_called()
    session.business_id=9
    await e._enable_call_ambience(session,'conn')
    e.audio_socket_server.start_ambience.assert_awaited_once_with('conn','office.wav','ulaw',volume=1.0)
    e.audio_socket_server.start_ambience.reset_mock()
    session.transport_profile.wire_sample_rate=16000
    e.config.audiosocket.format='slin'
    await e._enable_call_ambience(session,'conn')
    e.audio_socket_server.start_ambience.assert_awaited_once_with('conn','office.wav','pcm16',volume=1.0)
    e.audio_socket_server.start_ambience.reset_mock()
    e.config.audiosocket.format='slin16'
    await e._enable_call_ambience(session,'conn')
    e.audio_socket_server.start_ambience.assert_not_called()


async def test_output_failure_stops_loop_without_waiting_senders():
    async def write(data): return False
    mix=OutboundAmbience(pcm(120),'ulaw',write)
    await asyncio.wait_for(mix.task,.5)
    assert mix.closed and await mix.send(b'\xff'*160) is False


async def test_barge_in_clears_buffer_even_after_stream_has_finished():
    from src.core.streaming_playback_manager import StreamingPlaybackManager
    manager=object.__new__(StreamingPlaybackManager)
    manager.audio_transport='audiosocket'
    manager.audiosocket_server=SimpleNamespace(clear_ambience_voice=AsyncMock(),has_ambience=lambda:True)
    manager.session_store=SimpleNamespace(get_by_call_id=AsyncMock(return_value=SimpleNamespace(audiosocket_conn_id='conn')))
    manager.active_streams={}
    await manager.stop_streaming_playback('call')
    manager.audiosocket_server.clear_ambience_voice.assert_awaited_once_with('conn')


def test_prepared_asset_has_quiet_peaks_and_faded_seam():
    from pathlib import Path
    data=load_office_loop(Path(__file__).parents[1]/'assets/audio/office-ambience.wav')
    assert len(data)>8000*2*80
    assert audioop.max(data,2)<=2100  # about -24 dBFS peak
    assert audioop.rms(data,2)<500
    assert abs(struct.unpack('<h',data[:2])[0])<=2
    assert abs(struct.unpack('<h',data[-2:])[0])<=2
