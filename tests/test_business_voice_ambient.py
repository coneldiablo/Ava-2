"""Tenant settings -> next-call output, tone, gain, and audio safety."""
import asyncio
import audioop
import struct
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.audio.outbound_ambience import OutboundAmbience
from src.engine import Engine


def pcm(value):
    return struct.pack('<h', value) * 160


def engine():
    value = object.__new__(Engine)
    value.config = SimpleNamespace(ambient_audio=SimpleNamespace(enabled=True, business_ids=[9], wav_path='office.wav', volume=.8),
                                   audiosocket=SimpleNamespace(format='slin'))
    value.audio_socket_server = SimpleNamespace(start_ambience=AsyncMock())
    return value


def call(business_id, override=None, **fields):
    profile = {'businessId': business_id, 'voiceAmbient': override, **fields}
    return SimpleNamespace(business_id=business_id, call_id=f'call-{business_id}', hotel_profile=profile, provider_overrides={})


async def test_two_tenants_have_separate_next_call_setting_and_legacy_fallback():
    e = engine()
    first = call(1, {'enabled': True, 'preset': 'office', 'volume': .3})
    second = call(9, {'enabled': False, 'preset': 'office', 'volume': 1})
    await e._enable_call_ambience(first, 'conn-1')
    await e._enable_call_ambience(second, 'conn-9')
    e.audio_socket_server.start_ambience.assert_awaited_once_with('conn-1', 'office.wav', 'pcm16', volume=.3)
    e.audio_socket_server.start_ambience.reset_mock()
    await e._enable_call_ambience(call(9), 'legacy-9')
    await e._enable_call_ambience(call(1), 'legacy-1')
    e.audio_socket_server.start_ambience.assert_awaited_once_with('legacy-9', 'office.wav', 'pcm16', volume=.8)


async def test_existing_call_snapshot_is_unchanged_when_business_saves_new_volume_or_tone():
    e = engine()
    setting = {'enabled': True, 'preset': 'office', 'volume': .3}
    first = call(1, setting, hotelTone='Спокойно')
    await e._enable_call_ambience(first, 'conn-1')
    first.hotel_profile['voiceAmbient']['volume'] = .9
    first.hotel_profile['hotelTone'] = 'Весело'
    assert e._session_business_profile(first)['voiceAmbient']['volume'] == .3
    assert 'Спокойно' in e._append_business_voice_instructions('Trusted prompt', first)
    assert 'Весело' not in e._append_business_voice_instructions('Trusted prompt', first)
    second = call(1, {'enabled': True, 'preset': 'office', 'volume': .9}, hotelTone='Весело')
    await e._enable_call_ambience(second, 'conn-2')
    assert e.audio_socket_server.start_ambience.call_args.kwargs['volume'] == .9
    assert 'Весело' in e._append_business_voice_instructions('Trusted prompt', second)


@pytest.mark.parametrize('setting', [
    {'enabled': True, 'preset': 'unknown', 'volume': .5},
    {'enabled': True, 'preset': 'office', 'volume': float('nan')},
    {'enabled': True, 'preset': 'office', 'volume': True},
    {'enabled': True, 'preset': 'office', 'volume': 2},
    {'enabled': True, 'preset': 'office', 'volume': .5, 'path': '/file'},
    {'enabled': True, 'preset': 'office', 'volume': 0},
])
async def test_invalid_or_silent_override_does_not_reenable_legacy_bed(setting):
    e = engine()
    await e._enable_call_ambience(call(9, setting), 'conn')
    e.audio_socket_server.start_ambience.assert_not_awaited()


async def test_mismatched_profile_cannot_enable_ambience_or_tone_on_other_business():
    e = engine()
    value = call(1, {'enabled': True, 'preset': 'office', 'volume': 1}, hotelTone='Other tenant')
    value.hotel_profile['businessId'] = 2
    await e._enable_call_ambience(value, 'conn')
    e.audio_socket_server.start_ambience.assert_not_awaited()
    assert e._append_business_voice_instructions('Trusted', value) == 'Trusted'


def test_tone_alone_reaches_instructions_without_business_system_prompt():
    e = engine()
    value = call(1, hotelTone='Дружелюбно и кратко')
    prompt = e._append_business_voice_instructions('Trusted', value)
    assert 'Дружелюбно и кратко' in prompt
    assert e._append_business_voice_instructions(prompt, value) == prompt


async def test_independent_mixers_apply_gain_without_changing_shared_asset():
    outputs = [[], []]
    source = pcm(400)
    async def write(index, data):
        outputs[index].append(data)
        return True
    first = OutboundAmbience(source, 'pcm16', lambda data: write(0, data), volume=.25)
    second = OutboundAmbience(source, 'pcm16', lambda data: write(1, data), volume=.75)
    try:
        await asyncio.sleep(.03)
        assert outputs[0][0] == pcm(100)
        assert outputs[1][0] == pcm(300)
        assert source == pcm(400)
    finally:
        await first.close()
        await second.close()


def test_foreground_headroom_avoids_saturation_at_both_polarities():
    for sign in (1, -1):
        mixed = OutboundAmbience._mix(pcm(sign * 32760), pcm(sign * 2100))
        assert audioop.max(mixed, 2) <= 32700
        assert 32000 < audioop.rms(mixed, 2) < 32767
    assert OutboundAmbience._mix(pcm(600), pcm(100)) == pcm(700)


async def test_physical_slin_socket_outputs_scaled_loop_and_preserves_inbound_bytes(tmp_path):
    import uuid
    import wave
    from src.audio.audiosocket_server import AudioSocketServer
    path = tmp_path / 'office.wav'
    with wave.open(str(path), 'wb') as target:
        target.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))
        target.writeframes(pcm(400) * 10)
    inbound, connections = [], []
    ready = asyncio.Event()
    async def bind(conn_id, _):
        connections.append(conn_id)
        await server.start_ambience(conn_id, path, 'pcm16', volume=.25)
        ready.set()
        return True
    async def receive(_, data):
        inbound.append(data)
    server = AudioSocketServer('127.0.0.1', 0, on_uuid=bind, on_audio=receive)
    await server.start()
    reader, writer = await asyncio.open_connection('127.0.0.1', server.port)
    try:
        writer.write(b'\x01\x00\x10' + uuid.uuid4().bytes)
        await writer.drain()
        await asyncio.wait_for(ready.wait(), .5)
        for _ in range(3):
            header = await asyncio.wait_for(reader.readexactly(3), .5)
            assert header == b'\x10\x01\x40'  # type audio, 320 bytes / 20 ms slin8k
            assert await reader.readexactly(320) == pcm(100)
        caller = pcm(1700)
        writer.write(b'\x10\x01\x40' + caller)
        await writer.drain()
        for _ in range(50):
            if inbound:
                break
            await asyncio.sleep(.002)
        assert inbound == [caller]
        await server.disconnect(connections[0])
        assert not server._ambience
    finally:
        writer.close()
        await writer.wait_closed()
        await server.stop()
    assert not server._connection_tasks
