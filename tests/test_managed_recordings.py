"""Local SQLite/outbox/HTTP acceptance. WAV fixtures are synthetic, never calls."""
from datetime import datetime, timezone
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
import wave

import httpx
import pytest
import yaml
from fastapi import FastAPI

from admin_ui.backend.api import calls
from src.core import call_history
from src.core.managed_telephony import recording_filename, TelephonyUnavailable
from src.core.models import CallSession
from src.core.post_call_delivery import PostCallDeliveryStore
from src.engine import Engine
from src.tools.context import PostCallContext
from src.tools.http.generic_webhook import GenericWebhookTool, WebhookConfig
from src.tools.registry import tool_registry

PHONE = '12345678-abcd-abcd-abcd-123456789abc'


@pytest.mark.asyncio
@pytest.mark.parametrize('call_id', ['1791838123.26', 'ava-managed-12345678-abcd-abcd-abcd-123456789abc'])
async def test_recording_history_outbox_crm_playback_roundtrip(tmp_path, monkeypatch, call_id):
    monkeypatch.setenv('CALL_HISTORY_ENABLED', 'true')
    monkeypatch.setenv('CRM_SERVICE_API_TOKEN', 'local-recording-test-token')
    store = call_history.CallHistoryStore(db_path=str(tmp_path / 'calls.db'))
    monkeypatch.setattr(call_history, 'get_call_history_store', lambda: store)
    monkeypatch.setattr(calls, '_get_call_history_store', lambda: store)
    monkeypatch.setattr(calls, '_RECORDING_BASE', tmp_path)
    name = recording_filename(7, call_id)
    session = CallSession(call_id=call_id, caller_channel_id=call_id, business_id=9,
                          context_name='business-9', telephony_business_id=7,
                          telephony_context_name='business-7', phone_number_id=PHONE,
                          recording_file=name, start_time=datetime.now(timezone.utc))
    session.transfer_active = True
    session.transfer_destination = 'PJSIP/123'
    session.conversation_history = [{'role': 'user', 'content': 'Synthetic fixture'}]
    engine = Engine.__new__(Engine)
    engine.config = SimpleNamespace(default_provider='local')
    engine.transport_orchestrator = SimpleNamespace(get_context_config=lambda _: None)
    engine._post_call_delivery_store = PostCallDeliveryStore(str(tmp_path / 'outbox.db'))
    engine._deliver_post_call_jobs = AsyncMock()  # No external delivery.
    monkeypatch.setattr(tool_registry, 'get_tools_for_context', lambda **_: [
        SimpleNamespace(definition=SimpleNamespace(name='sales_brain_post_call'))])

    await engine._persist_call_history(session, call_id)
    await engine._execute_post_call_tools(call_id, session, call_outcome='transferred')
    reopened = call_history.CallHistoryStore(db_path=str(tmp_path / 'calls.db'))
    record = await reopened.get_by_call_id(call_id)
    assert (record.business_id, record.phone_number_id, record.recording_file) == (7, PHONE, name)
    assert record.outcome == 'transferred'
    row = engine._post_call_delivery_store.lease(call_id)
    ctx = PostCallContext(**json.loads(row['context_json']))
    template = yaml.safe_load((Path(__file__).resolve().parents[1] / 'config/ai-agent.yaml').read_text())
    tool = GenericWebhookTool(WebhookConfig(name='fixture', payload_template=template['tools']['sales_brain_post_call']['payload_template']))
    payload = json.loads(tool._build_payload(ctx))
    assert payload['instanceId'] == '7' and payload['context_id'] == 'business-7'
    assert payload['recording_file'] == name and payload['phone_number_id'] == PHONE
    assert 'config' not in json.loads(row['context_json'])

    # The exact native dialplan filename is discoverable through both old Admin
    # lookup and the tenant-scoped CRM bridge, without exposing a host path.
    with wave.open(str(tmp_path / name), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(8000)
        wav.writeframes(b'\0\0' * 80)
    assert calls._find_recording(call_id, record.start_time).name == name
    app = FastAPI()
    app.include_router(calls.internal_router, prefix='/api')
    headers = {'Authorization': 'Bearer local-recording-test-token'}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        path = f'/api/internal/calls/business/7/{record.id}/recording'
        assert (await client.get(path)).status_code == 401
        response = await client.get(path, headers=headers)
        assert response.json() == {'has_recording': True, 'filename': name, 'file_size_bytes': 204}
        assert (await client.get(path.replace('/business/7/', '/business/8/'), headers=headers)).status_code == 404
        audio = await client.get(path + '.wav', headers=headers)
        assert audio.status_code == 200 and audio.content == (tmp_path / name).read_bytes()
        assert audio.headers['content-type'] == 'audio/wav'
        assert audio.headers['cache-control'] == 'private, no-store'
        listing = await client.get('/api/internal/calls/business/7', headers=headers)
        assert listing.json()['calls'][0]['recording_file'] == name
        assert listing.json()['calls'][0]['phone_number_id'] == PHONE


@pytest.mark.asyncio
async def test_recording_bridge_rejects_empty_wrong_scope_and_escaping_symlink(tmp_path, monkeypatch):
    monkeypatch.setenv('CRM_SERVICE_API_TOKEN', 'local-token')
    monkeypatch.setattr(calls, '_RECORDING_BASE', tmp_path)
    name = recording_filename(7, 'owned')
    record = SimpleNamespace(business_id=7, call_id='owned', start_time=None, recording_file=name)
    monkeypatch.setattr(calls, '_get_call_history_store', lambda: SimpleNamespace(get=AsyncMock(return_value=record)))
    app = FastAPI()
    app.include_router(calls.internal_router, prefix='/api')
    path = '/api/internal/calls/business/7/row/recording'
    headers = {'Authorization': 'Bearer local-token'}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        (tmp_path / name).write_bytes(b'RIFF')
        assert (await client.get(path, headers=headers)).json()['has_recording'] is False
        assert (await client.get(path + '.wav', headers=headers)).status_code == 404
        record.recording_file = recording_filename(8, 'owned')
        (tmp_path / record.recording_file).write_bytes(b'x' * 100)
        assert (await client.get(path + '.wav', headers=headers)).status_code == 404
        record.recording_file = name
        (tmp_path / name).unlink()
        outside = tmp_path.parent / (tmp_path.name + '-outside.wav')
        outside.write_bytes(b'x' * 100)
        try:
            (tmp_path / name).symlink_to(outside)
            assert (await client.get(path + '.wav', headers=headers)).status_code == 404
        finally:
            outside.unlink()


@pytest.mark.parametrize('channel_id', ['../outside', 'x/../../y', 'x;command', 'x\nextra', ''])
def test_recording_filename_is_never_caller_selected_path(channel_id):
    with pytest.raises(TelephonyUnavailable):
        recording_filename(7, channel_id)
