import io
import json
import os
from pathlib import Path
import sqlite3
import urllib.error

import pytest

from src.core.onyx_client import OnyxClient, OnyxClientError, redact_onyx_error
from src.core.onyx_outbox_worker import OnyxOutboxWorker
from src.core.onyx_tenant_service import OnyxTenantService


class DummyResponse:
    def __init__(self, body, status=200):
        self.body = json.dumps(body).encode()
        self.status = status

    def read(self, _limit=None):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def make_db(path):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE instances (id INTEGER PRIMARY KEY, name TEXT NOT NULL, isActive INTEGER NOT NULL DEFAULT 1)")
    conn.execute("INSERT INTO instances(id,name) VALUES (1, 'Hotel One')")
    conn.execute("""
        CREATE TABLE knowledge_base (
            id INTEGER PRIMARY KEY, instanceId INTEGER NOT NULL, originalName TEXT,
            filename TEXT, isCurrent INTEGER DEFAULT 1, contentHash TEXT, createdAt TEXT
        )
    """)
    conn.execute("CREATE TABLE kb_chunks (id INTEGER PRIMARY KEY, kbId INTEGER, chunkIndex INTEGER, text TEXT, section TEXT)")
    conn.commit()
    conn.close()


@pytest.mark.asyncio
async def test_onyx_client_uses_v47_ingestion_contract_and_scoped_pair(monkeypatch):
    monkeypatch.setenv("ONYX_HOTEL_1_API_KEY", "onyx-secret-value")
    captured = []

    def fake_urlopen(request, timeout):
        captured.append({
            "url": request.full_url,
            "authorization": request.get_header("Authorization"),
            "payload": json.loads(request.data.decode()) if request.data else None,
            "timeout": timeout,
        })
        return DummyResponse({"document_id": "ava:1:knowledge:7", "already_existed": False})

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    client = OnyxClient(
        base_url="https://onyx.example.test/api",
        credential_ref="env:ONYX_HOTEL_1_API_KEY",
        cc_pair_id=42,
    )
    result = await client.apply_outbox_event({
        "business_id": 1,
        "entity_type": "knowledge",
        "source_id": 7,
        "operation": "UPSERT",
        "payload_json": json.dumps({
            "external_id": "ava:1:knowledge:7",
            "title": "Правила отеля",
            "content": "Заезд после 14:00.",
            "content_hash": "hash-seven",
            "metadata": {"business_id": 1, "source_id": 7, "private": "not-exported"},
        }),
    })

    assert result["document_id"] == "ava:1:knowledge:7"
    assert captured[0]["url"] == "https://onyx.example.test/api/onyx-api/ingestion"
    assert captured[0]["authorization"] == "Bearer onyx-secret-value"
    assert captured[0]["payload"]["cc_pair_id"] == 42
    assert captured[0]["payload"]["document"]["sections"][0]["text"] == "Заезд после 14:00."
    assert "private" not in captured[0]["payload"]["document"]["metadata"]


@pytest.mark.asyncio
async def test_onyx_client_classifies_permanent_auth_error(monkeypatch):
    monkeypatch.setenv("ONYX_HOTEL_1_API_KEY", "top-secret-token")

    def forbidden(_request, timeout):
        raise urllib.error.HTTPError(
            "https://onyx.example.test/api/me", 403,
            "Bearer top-secret-token is forbidden", {},
            io.BytesIO(b'{"detail":"Bearer top-secret-token is forbidden"}'),
        )

    monkeypatch.setattr("urllib.request.urlopen", forbidden)
    client = OnyxClient(
        base_url="https://onyx.example.test/api",
        credential_ref="ONYX_HOTEL_1_API_KEY",
        cc_pair_id=42,
    )
    with pytest.raises(OnyxClientError) as captured:
        await client.test_connection()
    assert captured.value.code == "ONYX_FORBIDDEN"
    assert captured.value.retryable is False
    assert "top-secret-token" not in str(captured.value)


@pytest.mark.asyncio
async def test_onyx_client_uses_manage_prefix_for_cc_pair_health(monkeypatch):
    monkeypatch.setenv("ONYX_HOTEL_1_API_KEY", "onyx-secret-value")
    captured = []

    def fake_urlopen(request, timeout):
        captured.append(request.full_url)
        return DummyResponse({"id": "service-user"} if request.full_url.endswith("/me") else {"id": 42})

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    client = OnyxClient(
        base_url="https://onyx.example.test/api",
        credential_ref="ONYX_HOTEL_1_API_KEY",
        cc_pair_id=42,
    )

    result = await client.test_connection()

    assert result["authenticated"] is True
    assert captured == [
        "https://onyx.example.test/api/me",
        "https://onyx.example.test/api/manage/admin/cc-pair/42",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("document_id", ["ava:1:knowledge:7", "ava%3A1%3Aknowledge%3A7"])
async def test_onyx_client_deletes_url_normalized_document_id(monkeypatch, document_id):
    monkeypatch.setenv("ONYX_HOTEL_1_API_KEY", "onyx-secret-value")
    captured = []

    def fake_urlopen(request, timeout):
        captured.append(request.full_url)
        return DummyResponse(None, status=204)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    client = OnyxClient(
        base_url="https://onyx.example.test/api",
        credential_ref="ONYX_HOTEL_1_API_KEY",
        cc_pair_id=42,
    )

    result = await client.delete_document(document_id)

    assert result["deleted"] is True
    assert captured == [
        "https://onyx.example.test/api/onyx-api/ingestion/ava%253A1%253Aknowledge%253A7"
    ]


def test_onyx_tenant_config_stores_only_environment_reference(tmp_path, monkeypatch):
    db_path = str(tmp_path / "onyx.db")
    make_db(db_path)
    monkeypatch.setenv("ONYX_HOTEL_1_API_KEY", "secret-never-in-sqlite")
    service = OnyxTenantService(db_path=db_path)
    view = service.configure(1, {
        "base_url": "https://onyx.example.test/api",
        "credential_ref": "env:ONYX_HOTEL_1_API_KEY",
        "cc_pair_id": 42,
        "onyx_version": "v4.7.0",
    })

    raw_bytes = Path(db_path).read_bytes()
    assert b"secret-never-in-sqlite" not in raw_bytes
    assert view["credential_configured"] is True
    assert view["credential_available"] is True
    assert "credential_ref" not in view


def test_connection_change_invalidates_agents_and_readiness(tmp_path):
    db_path = str(tmp_path / 'changed.db')
    make_db(db_path)
    service = OnyxTenantService(db_path=db_path)
    payload = {'base_url': 'https://onyx.example.test/api', 'credential_ref': 'ONYX_TEST_KEY', 'cc_pair_id': 1}
    service.configure(1, payload)
    service.update_readiness(1, {'shadow_mode_completed': True})
    with sqlite3.connect(db_path) as conn:
        conn.execute('''INSERT INTO onyx_agent_bindings
            (business_id,role,onyx_base_url,persona_id,document_set_id,document_set_name,model_configuration_id,search_tool_id)
            VALUES (1,'sales','https://onyx.example.test/api',1,1,'hotel-1',1,1)''')
    unchanged = service.configure(1, payload)
    assert unchanged['readiness']['shadow_mode_completed']['passed'] is True
    changed = service.configure(1, {**payload, 'cc_pair_id': 2})
    assert changed['readiness'] == {}
    with sqlite3.connect(db_path) as conn:
        assert conn.execute('SELECT COUNT(*) FROM onyx_agent_bindings').fetchone()[0] == 0


@pytest.mark.asyncio
async def test_outbox_never_reports_mock_success_without_tenant_link(tmp_path):
    db_path = str(tmp_path / "onyx.db")
    make_db(db_path)
    worker = OnyxOutboxWorker(db_path=db_path)
    event_id = worker.enqueue_event(1, "knowledge", 7, "UPSERT", {
        "content": "content", "content_hash": "hash",
    })
    event = worker.lease_events()[0]
    assert await worker.process_single_event(event) is False

    conn = sqlite3.connect(db_path)
    row = conn.execute(
        "SELECT status,last_error_code FROM onyx_sync_outbox WHERE event_id=?",
        (event_id,),
    ).fetchone()
    conn.close()
    assert row == ("DEAD_LETTER", "ONYX_TENANT_NOT_READY")


def test_onyx_error_redaction_removes_known_environment_secrets(monkeypatch):
    monkeypatch.setenv("ONYX_SENSITIVE_API_KEY", "secret-value-123")
    message = redact_onyx_error(
        "Bearer abc.def password=hello https://user:pass@example.test?api_key=qwerty secret-value-123"
    )
    assert "abc.def" not in message
    assert "qwerty" not in message
    assert "secret-value-123" not in message
    assert "hello" not in message
    assert "user:pass" not in message


def test_ingestion_budget_is_separate_from_live_call_timeout(tmp_path, monkeypatch):
    db_path = str(tmp_path / "onyx.db")
    make_db(db_path)
    monkeypatch.setenv("ONYX_REQUEST_TIMEOUT_SECONDS", "2")
    worker = OnyxOutboxWorker(db_path=db_path)
    assert worker.ingestion_timeout == 60
    assert worker.cb.request_timeout == 65
    monkeypatch.setenv("ONYX_INGESTION_TIMEOUT_SECONDS", "45")
    worker = OnyxOutboxWorker(db_path=db_path)
    service = OnyxTenantService(db_path=db_path)
    service.configure(1, {
        "base_url": "https://onyx.example.test/api", "credential_ref": "ONYX_HOTEL_1_API_KEY",
        "cc_pair_id": 42, "onyx_version": "v4.7.0",
    })
    with sqlite3.connect(db_path) as conn:
        conn.execute("UPDATE onyx_tenant_links SET status='STAGING' WHERE business_id=1")
    assert worker._client_for_event({"business_id": 1}).timeout_seconds == 45
    assert worker.cb.request_timeout == 50


@pytest.mark.asyncio
async def test_runtime_leases_each_document_only_immediately_before_processing(monkeypatch):
    import asyncio
    from src.core.onyx_worker_runtime import OnyxWorkerRuntime

    runtime = OnyxWorkerRuntime(db_path='unused')
    runtime.stop_event = asyncio.Event()
    calls = []

    class Worker:
        def __init__(self, **kwargs):
            pass

        def lease_events(self, limit):
            calls.append(('lease', limit))
            return [{'id': 1}]

        async def process_single_event(self, event):
            calls.append(('process', event['id']))
            runtime.stop_event.set()

    monkeypatch.setattr('src.core.onyx_worker_runtime.OnyxOutboxWorker', Worker)
    await runtime._run()
    assert calls == [('lease', 1), ('process', 1)]


def test_outbox_lease_is_single_owner_and_recovers_after_expiry(tmp_path):
    db_path = str(tmp_path / "onyx.db")
    make_db(db_path)
    first_worker = OnyxOutboxWorker(db_path=db_path)
    second_worker = OnyxOutboxWorker(db_path=db_path)
    event_id = first_worker.enqueue_event(1, "knowledge", 8, "UPSERT", {
        "content": "lease", "content_hash": "lease-hash",
    })

    first = first_worker.lease_events()[0]
    assert second_worker.lease_events() == []
    conn = sqlite3.connect(db_path)
    conn.execute(
        "UPDATE onyx_sync_outbox SET leased_until='2000-01-01 00:00:00' WHERE event_id=?",
        (event_id,),
    )
    conn.commit()
    conn.close()

    recovered = second_worker.lease_events()[0]
    assert recovered["event_id"] == event_id
    assert recovered["lease_token"] != first["lease_token"]


def knowledge_event(**payload):
    return {'business_id': 1, 'entity_type': 'knowledge', 'source_id': 7, 'operation': 'UPSERT',
            'payload_json': json.dumps({'content': 'SYNTHETIC_KNOWLEDGE', 'content_hash': 'hash-seven', **payload})}


@pytest.mark.asyncio
@pytest.mark.parametrize('body,code', [
    (None, 'ONYX_DOCUMENT_ACK_INVALID'),
    ({}, 'ONYX_DOCUMENT_ACK_INVALID'),
    ({'document_id': None}, 'ONYX_DOCUMENT_ACK_INVALID'),
    ({'document_id': ''}, 'ONYX_DOCUMENT_ACK_INVALID'),
    ({'document_id': {'secret': 'SYNTHETIC_PRIVATE_BODY'}}, 'ONYX_DOCUMENT_ACK_INVALID'),
    ({'document_id': 'ava:2:knowledge:7'}, 'ONYX_DOCUMENT_ACK_SCOPE_MISMATCH'),
    ({'document_id': 'ava:1:customer_summary:7'}, 'ONYX_DOCUMENT_ACK_SCOPE_MISMATCH'),
    ({'document_id': 'ava:1:knowledge:8'}, 'ONYX_DOCUMENT_ACK_SCOPE_MISMATCH'),
    ({'document_id': 'SYNTHETIC_PRIVATE_BODY'}, 'ONYX_DOCUMENT_ACK_SCOPE_MISMATCH'),
])
async def test_client_requires_exact_document_ack_without_body_leak(monkeypatch, body, code):
    monkeypatch.setenv('ONYX_HOTEL_1_API_KEY', 'onyx-secret-value')
    monkeypatch.setattr('urllib.request.urlopen', lambda _request, timeout: DummyResponse(body))
    client = OnyxClient(base_url='https://onyx.example.test/api', credential_ref='ONYX_HOTEL_1_API_KEY', cc_pair_id=42)
    with pytest.raises(OnyxClientError) as error:
        await client.apply_outbox_event(knowledge_event())
    assert error.value.code == code and error.value.retryable is True
    assert 'SYNTHETIC_PRIVATE_BODY' not in str(error.value)


@pytest.mark.asyncio
@pytest.mark.parametrize('document_id', ['ava:1:knowledge:7', 'ava%3A1%3Aknowledge%3A7'])
async def test_client_preserves_valid_ack_and_normalizes_scoped_request_id(monkeypatch, document_id):
    monkeypatch.setenv('ONYX_HOTEL_1_API_KEY', 'onyx-secret-value')
    sent = []
    def remote(request, timeout):
        sent.append(json.loads(request.data))
        return DummyResponse({'document_id': document_id, 'already_existed': True})
    monkeypatch.setattr('urllib.request.urlopen', remote)
    client = OnyxClient(base_url='https://onyx.example.test/api', credential_ref='ONYX_HOTEL_1_API_KEY', cc_pair_id=42)
    result = await client.apply_outbox_event(knowledge_event(external_id='ava%3A1%3Aknowledge%3A7',
        metadata={'business_id': 2, 'source_id': 8}))
    assert result == {'status': 'ok', 'document_id': document_id, 'already_existed': True}
    assert sent[0]['document']['id'] == 'ava:1:knowledge:7'
    assert sent[0]['document']['metadata']['business_id'] == '1'
    assert sent[0]['document']['metadata']['source_id'] == '7'


@pytest.mark.asyncio
@pytest.mark.parametrize('external_id', ['', None, 'ava:2:knowledge:7', 'ava:1:knowledge:8'])
@pytest.mark.parametrize('operation', ['UPSERT', 'DELETE'])
async def test_client_rejects_unscoped_payload_before_network(monkeypatch, external_id, operation):
    def forbidden(*args, **kwargs):
        raise AssertionError('foreign scope must not reach HTTP transport')
    monkeypatch.setattr('urllib.request.urlopen', forbidden)
    client = OnyxClient(base_url='https://onyx.example.test/api', credential_ref='ONYX_HOTEL_1_API_KEY', cc_pair_id=42)
    event = {**knowledge_event(external_id=external_id), 'operation': operation}
    with pytest.raises(OnyxClientError) as error:
        await client.apply_outbox_event(event)
    assert error.value.code == 'ONYX_DOCUMENT_SCOPE_INVALID' and not error.value.retryable


@pytest.mark.asyncio
@pytest.mark.parametrize('ack,code', [
    (None, 'ONYX_DOCUMENT_ACK_INVALID'),
    ('accepted', 'ONYX_DOCUMENT_ACK_INVALID'),
    ({'status': 'ok'}, 'ONYX_DOCUMENT_ACK_INVALID'),
    ({'status': 'ok', 'document_id': ''}, 'ONYX_DOCUMENT_ACK_INVALID'),
    ({'status': 'failed', 'document_id': 'ava:1:knowledge:7'}, 'ONYX_DOCUMENT_ACK_INVALID'),
    ({'status': 'ok', 'document_id': 'ava:2:knowledge:7'}, 'ONYX_DOCUMENT_ACK_SCOPE_MISMATCH'),
    ({'status': 'ok', 'document_id': 'ava:1:knowledge:8'}, 'ONYX_DOCUMENT_ACK_SCOPE_MISMATCH'),
    ({'status': 'ok', 'document_id': 'SYNTHETIC_PRIVATE_BODY'}, 'ONYX_DOCUMENT_ACK_SCOPE_MISMATCH'),
])
async def test_outbox_invalid_ack_never_completes_or_projects(tmp_path, caplog, ack, code):
    path = str(tmp_path/'ack.db')
    make_db(path)
    worker = OnyxOutboxWorker(path)
    event_id = worker.enqueue_event(1, 'knowledge', 7, 'UPSERT', {'content': 'fixture', 'content_hash': 'hash-seven'})
    async def sender(_event):
        return ack
    assert not await worker.process_single_event(worker.lease_events()[0], sync_sender_func=sender)
    with sqlite3.connect(path) as conn:
        row = conn.execute('SELECT status,attempts,last_error_code,last_error FROM onyx_sync_outbox WHERE event_id=?', (event_id,)).fetchone()
        assert row[:3] == ('RETRY', 1, code)
        assert conn.execute('SELECT COUNT(*) FROM onyx_document_links').fetchone()[0] == 0
    assert 'SYNTHETIC_PRIVATE_BODY' not in str(row) and 'SYNTHETIC_PRIVATE_BODY' not in caplog.text


@pytest.mark.asyncio
async def test_valid_encoded_ack_is_durable_and_duplicate_does_not_send(tmp_path):
    path = str(tmp_path/'valid-ack.db')
    make_db(path)
    worker = OnyxOutboxWorker(path)
    payload = {'content': 'fixture', 'content_hash': 'hash-seven'}
    worker.enqueue_event(1, 'knowledge', 7, 'UPSERT', payload)
    calls = []
    async def sender(event):
        calls.append(event['event_id'])
        return {'status': 'ok', 'document_id': 'ava%3A1%3Aknowledge%3A7'}
    assert await worker.process_single_event(worker.lease_events()[0], sync_sender_func=sender)
    duplicate = worker.enqueue_event(1, 'knowledge', 7, 'UPSERT', payload)
    assert await worker.process_single_event(worker.lease_events()[0], sync_sender_func=sender)
    assert len(calls) == 1
    with sqlite3.connect(path) as conn:
        assert conn.execute('SELECT onyx_document_id,content_hash FROM onyx_document_links').fetchone() == ('ava%3A1%3Aknowledge%3A7', 'hash-seven')
        assert conn.execute('SELECT status FROM onyx_sync_outbox WHERE event_id=?', (duplicate,)).fetchone()[0] == 'COMPLETED'


@pytest.mark.asyncio
async def test_foreign_projection_cannot_satisfy_idempotent_completion(tmp_path):
    path = str(tmp_path/'foreign-link.db')
    make_db(path)
    worker = OnyxOutboxWorker(path)
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO onyx_document_links(business_id,entity_type,source_id,onyx_document_id,content_hash) VALUES(1,'knowledge',7,'ava:2:knowledge:7','hash-seven')")
    worker.enqueue_event(1, 'knowledge', 7, 'UPSERT', {'content': 'fixture', 'content_hash': 'hash-seven'})
    calls = []
    async def sender(event):
        calls.append(event['event_id'])
        return {'status': 'ok', 'document_id': 'ava:1:knowledge:7'}
    assert await worker.process_single_event(worker.lease_events()[0], sync_sender_func=sender)
    assert len(calls) == 1
    with sqlite3.connect(path) as conn:
        assert conn.execute('SELECT onyx_document_id FROM onyx_document_links').fetchone()[0] == 'ava:1:knowledge:7'


@pytest.mark.asyncio
async def test_duplicate_stale_lease_does_not_report_completed(tmp_path):
    path = str(tmp_path/'stale-lease.db')
    make_db(path)
    worker = OnyxOutboxWorker(path)
    with sqlite3.connect(path) as conn:
        conn.execute("INSERT INTO onyx_document_links(business_id,entity_type,source_id,onyx_document_id,content_hash) VALUES(1,'knowledge',7,'ava:1:knowledge:7','hash-seven')")
    event_id = worker.enqueue_event(1, 'knowledge', 7, 'UPSERT', {'content': 'fixture', 'content_hash': 'hash-seven'})
    event = worker.lease_events()[0]
    with sqlite3.connect(path) as conn:
        conn.execute('UPDATE onyx_sync_outbox SET lease_token=? WHERE event_id=?', ('new-owner', event_id))
    async def forbidden(_event):
        raise AssertionError('duplicate must not call sender')
    assert not await worker.process_single_event(event, sync_sender_func=forbidden)
    with sqlite3.connect(path) as conn:
        assert conn.execute('SELECT status FROM onyx_sync_outbox WHERE event_id=?', (event_id,)).fetchone()[0] == 'PROCESSING'
