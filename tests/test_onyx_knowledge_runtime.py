import asyncio
import sqlite3
import sys
import math
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.core.onyx_db import init_onyx_tables
from src.core.onyx_knowledge_runtime import OnyxKnowledgeRuntime


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    path = str(tmp_path/'runtime.db')
    monkeypatch.setenv('DB_PATH', path)
    with sqlite3.connect(path) as conn:
        conn.executescript("CREATE TABLE instances(id INTEGER PRIMARY KEY,name TEXT,isActive INTEGER);"
                           "INSERT INTO instances VALUES(1,'Alpha',1),(2,'Beta',1),(3,'Disabled',0);"
                           "CREATE TABLE clients(id INTEGER PRIMARY KEY,instanceId INTEGER,chatId TEXT);"
                           "INSERT INTO clients VALUES(101,1,'79990000001@c.us'),(202,2,'79990000001@c.us'),(303,1,'group@g.us');"
                           "CREATE TABLE knowledge_base(id INTEGER PRIMARY KEY,instanceId INTEGER,contentHash TEXT,isCurrent INTEGER);"
                           "INSERT INTO knowledge_base VALUES(1,1,'hash-a',1),(2,2,'hash-b',1);"
                           "CREATE TABLE kb_chunks(id INTEGER PRIMARY KEY,kbId INTEGER,chunkIndex INTEGER,text TEXT);"
                           "INSERT INTO kb_chunks VALUES(1,1,0,'Alpha: заезд в 15:00.'),(2,2,0,'Beta: заезд в 16:00.');")
        init_onyx_tables(conn)
        conn.executemany("INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,status) VALUES(?,?,?,'ACTIVE_LIVE')",
                         [(i, f'hotel_{i}', 'http://onyx.test/api') for i in (1, 2, 3)])
        conn.executemany("INSERT INTO onyx_document_links(business_id,entity_type,source_id,onyx_document_id,content_hash) VALUES(?,'knowledge',?,?,?)",
                         [(1,1,'ava:1:knowledge:1','hash-a'),(2,2,'ava:2:knowledge:2','hash-b')])

    class Runner:
        calls = []
        options = []
        hook = None

        def __init__(self, **kwargs):
            self.options = kwargs
            Runner.options.append(kwargs)

        async def answer_query_async(self, **kwargs):
            Runner.calls.append(kwargs)
            if Runner.hook:
                return await Runner.hook(kwargs)
            return {'business_id': kwargs['business_id'], 'answer': f"Отель {kwargs['business_id']}: заезд в 15:00.",
                    'grounded': True, 'citations': [{'source_id': kwargs['business_id']}],
                    'grounding_verification': 'scoped_citations_only', 'timestamp': '2026-09-07T15:00:00Z'}

    return OnyxKnowledgeRuntime(path, runner_factory=Runner), Runner


def state(runtime, status, business_id=1):
    with sqlite3.connect(runtime.db_path) as conn:
        conn.execute('UPDATE onyx_tenant_links SET status=? WHERE business_id=?', (status, business_id))


async def answer(runtime, business_id=1, channel='whatsapp', **kwargs):
    return await runtime.answer(business_id=business_id, question='Во сколько заезд?', channel=channel,
                                correlation_id='request-1', **kwargs)


@pytest.mark.asyncio
@pytest.mark.parametrize('status', ['STAGING', 'CONFIGURED', 'ERROR', 'DISABLED', 'FALLBACK_LEGACY'])
async def test_non_live_modes_never_call_provider(runtime, status):
    service, runner = runtime
    state(service, status)
    assert (await answer(service))['handled'] is False
    assert not runner.calls


@pytest.mark.asyncio
@pytest.mark.parametrize('channel', ['voice', 'whatsapp'])
async def test_both_real_routes_keep_business_and_source_evidence(runtime, channel):
    service, runner = runtime
    a, b = await answer(service, channel=channel), await answer(service, 2, channel)
    assert a['handled'] and b['handled'] and a['answer'] != b['answer']
    assert a['read_only'] and not a['manager_task_created'] and not a['preview']
    assert a['citations'] == [{'source_id': 1}]
    assert set(runner.calls[0]) == {'business_id', 'query', 'agent_role'}
    assert (await answer(service, 3))['handled'] is False


@pytest.mark.asyncio
async def test_preview_does_not_switch_live_and_cannot_bypass_disable(runtime):
    service, runner = runtime
    state(service, 'STAGING')
    assert (await answer(service, preview=True))['handled']
    assert runner.options[-1]['timeout_seconds'] == 30
    assert not (await answer(service))['handled']
    state(service, 'DISABLED')
    assert not (await answer(service, preview=True))['handled']


@pytest.mark.asyncio
async def test_preview_disconnect_cancels_runtime_task(runtime, monkeypatch):
    sys.path.insert(0, str(Path(__file__).parents[1]/'admin_ui/backend'))
    from api import onyx_runtime
    service, runner = runtime
    entered = asyncio.Event()
    cleaned = asyncio.Event()

    async def slow(_kwargs):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.set()

    class Disconnect:
        async def is_disconnected(self):
            return entered.is_set()

    runner.hook = slow
    monkeypatch.setattr(onyx_runtime, 'OnyxKnowledgeRuntime', lambda: service)
    payload = onyx_runtime.KnowledgeRequest(business_id=1, question='Заезд?',
                                              channel='whatsapp', correlation_id='test-disconnect')
    assert await asyncio.wait_for(onyx_runtime._preview_until_disconnect(Disconnect(), payload), 1) is None
    assert cleaned.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize('bad', ['uncited', 'foreign', 'rollback', 'timeout', 'secret'])
async def test_unsafe_or_outage_answer_falls_back_without_leaking(runtime, bad):
    service, runner = runtime

    async def hook(kwargs):
        if bad == 'timeout':
            raise asyncio.TimeoutError()
        if bad == 'secret':
            raise RuntimeError('Bearer secret-value password=secret-value')
        if bad == 'rollback':
            state(service, 'FALLBACK_LEGACY')
        return {'business_id': 2 if bad == 'foreign' else 1, 'grounded': bad != 'uncited',
                'citations': [] if bad == 'uncited' else [{}], 'answer': 'secret-value'}

    runner.hook = hook
    result = await answer(service)
    assert not result['handled'] and 'secret-value' not in str(result)


def test_internal_api_auth_and_strict_server_scope(runtime, monkeypatch):
    sys.path.insert(0, str(Path(__file__).parents[1]/'admin_ui/backend'))
    from api import onyx_runtime
    monkeypatch.setenv('CRM_SERVICE_API_TOKEN', 'test-service-token')
    monkeypatch.setattr(onyx_runtime, 'OnyxKnowledgeRuntime', lambda: runtime[0])
    app = FastAPI()
    app.include_router(onyx_runtime.router)
    with TestClient(app) as client:
        url = '/api/internal/onyx/knowledge'
        body = dict(business_id=1, question='Во сколько заезд?', channel='voice', correlation_id='request-1')
        assert client.post(url, json=body).status_code == 401
        auth = {'Authorization': 'Bearer test-service-token'}
        for injected in ({'instance_id': 2}, {'preview': True}, {'caller_number': '79999999999'}, {'agent_role': 'manager'}):
            assert client.post(url, json={**body, **injected}, headers=auth).status_code == 422
        assert client.post(url, json={**body, 'business_id': True}, headers=auth).status_code == 422
        for customer in (True, 0, -1, '101'):
            assert client.post(url, json={**body, 'customer_id': customer}, headers=auth).status_code == 422
        result = client.post(url, json=body, headers=auth)
        assert result.status_code == 200 and result.json()['handled']
        state(runtime[0], 'STAGING')
        assert not client.post(url, json=body, headers=auth).json()['handled']
        assert client.post(url+'/preview', json=body, headers=auth).json()['handled']


@pytest.mark.asyncio
async def test_runtime_requires_current_customer_provenance(runtime):
    service, runner = runtime
    for customer_id in (202, 303, 999):
        assert not (await answer(service, customer_id=customer_id))['handled']
    assert not runner.calls
    async def correct(kwargs):
        assert kwargs['customer_id'] == 101
        return {'business_id': 1, 'customer_id': 101, 'customer_context_provided': True,
                'answer': 'Ответ', 'grounded': True, 'citations': [{'source_id': 1}],
                'grounding_verification': 'scoped_citations_only', 'timestamp': '2026-09-07T20:00:00Z'}
    runner.hook = correct
    result = await answer(service, customer_id=101)
    assert result['handled'] and result['customer_context_provided'] and result['customer_id'] == 101
    for patch in ({'customer_id': 202}, {'customer_context_provided': False}):
        async def bad(kwargs):
            return {**await correct(kwargs), **patch}
        runner.hook = bad
        assert not (await answer(service, customer_id=101))['handled']
    async def removed(kwargs):
        with sqlite3.connect(service.db_path) as conn:
            conn.execute('DELETE FROM clients WHERE id=101')
        return await correct(kwargs)
    runner.hook = removed
    assert not (await answer(service, customer_id=101))['handled']


@pytest.mark.asyncio
@pytest.mark.parametrize('mutation,code', [
    ('DELETE FROM knowledge_base WHERE instanceId=1', 'ONYX_RUNTIME_EMPTY'),
    ('UPDATE knowledge_base SET isCurrent=0 WHERE instanceId=1', 'ONYX_RUNTIME_EMPTY'),
    ('DELETE FROM kb_chunks WHERE kbId=1', 'ONYX_RUNTIME_EMPTY'),
    ("UPDATE kb_chunks SET text='   ' WHERE kbId=1", 'ONYX_RUNTIME_EMPTY'),
    ('DELETE FROM onyx_document_links WHERE business_id=1', 'ONYX_RUNTIME_INDEXING'),
    ("UPDATE knowledge_base SET contentHash='new-revision' WHERE id=1", 'ONYX_RUNTIME_INDEXING'),
    ("UPDATE knowledge_base SET contentHash=NULL WHERE id=1", 'ONYX_RUNTIME_INDEXING'),
    ("UPDATE onyx_document_links SET onyx_document_id='ava:2:knowledge:1' WHERE business_id=1", 'ONYX_RUNTIME_INDEXING'),
    ('UPDATE onyx_document_links SET business_id=2 WHERE source_id=1', 'ONYX_RUNTIME_INDEXING'),
])
async def test_empty_and_unsynced_corpus_never_call_provider(runtime, mutation, code):
    service, runner = runtime
    with sqlite3.connect(service.db_path) as conn:
        conn.execute(mutation)
    result = await answer(service, preview=True)
    assert result['error_code'] == code and not result['handled']
    assert not runner.calls and not runner.options
    assert 'answer' not in result and 'citations' not in result


@pytest.mark.asyncio
async def test_partial_index_does_not_answer_using_only_old_documents(runtime):
    service, runner = runtime
    with sqlite3.connect(service.db_path) as conn:
        conn.execute("INSERT INTO knowledge_base VALUES(10,1,'new-revision',1)")
        conn.execute("INSERT INTO kb_chunks VALUES(10,10,0,'SYNTHETIC_NEW_POLICY')")
    assert (await answer(service))['error_code'] == 'ONYX_RUNTIME_INDEXING'
    assert not runner.calls


@pytest.mark.asyncio
async def test_missing_storage_is_an_outage_not_empty_knowledge(runtime):
    service, runner = runtime
    with sqlite3.connect(service.db_path) as conn:
        conn.execute('DROP TABLE kb_chunks')
    result = await answer(service)
    assert result['error_code'] == 'ONYX_RUNTIME_UNAVAILABLE'
    assert not runner.calls and 'no such table' not in str(result)


@pytest.mark.asyncio
@pytest.mark.parametrize('mutation,code', [
    ('DELETE FROM knowledge_base WHERE id=1', 'ONYX_RUNTIME_EMPTY'),
    ("UPDATE knowledge_base SET contentHash='revision-2' WHERE id=1", 'ONYX_RUNTIME_INDEXING'),
    ('DELETE FROM onyx_document_links WHERE business_id=1', 'ONYX_RUNTIME_INDEXING'),
])
async def test_revision_revocation_during_request_wins_over_grounded_answer(runtime, mutation, code):
    service, runner = runtime
    async def mutate(_kwargs):
        with sqlite3.connect(service.db_path) as conn:
            conn.execute(mutation)
        return {'business_id': 1, 'grounded': True, 'citations': [{'source_id': 1}],
                'answer': 'SYNTHETIC_STALE_ANSWER'}
    runner.hook = mutate
    result = await answer(service)
    assert result['error_code'] == code
    assert not result['handled'] and 'SYNTHETIC_STALE_ANSWER' not in str(result)


@pytest.mark.asyncio
async def test_reindex_during_generation_cannot_validate_an_old_response(runtime):
    service, runner = runtime
    async def update(_kwargs):
        with sqlite3.connect(service.db_path) as conn:
            conn.execute("UPDATE knowledge_base SET contentHash='revision-2' WHERE id=1")
            conn.execute("UPDATE onyx_document_links SET content_hash='revision-2' WHERE source_id=1")
        return {'business_id': 1, 'grounded': True, 'citations': [{'source_id': 1}],
                'answer': 'SYNTHETIC_STALE_ANSWER'}
    runner.hook = update
    result = await answer(service)
    assert result['error_code'] == 'ONYX_RUNTIME_INDEXING' and not result['handled']


@pytest.mark.asyncio
async def test_add_update_delete_lifecycle_requires_current_revision(runtime):
    service, runner = runtime
    with sqlite3.connect(service.db_path) as conn:
        conn.execute('DELETE FROM onyx_document_links WHERE business_id=1')
    assert (await answer(service))['error_code'] == 'ONYX_RUNTIME_INDEXING'
    with sqlite3.connect(service.db_path) as conn:
        conn.execute("INSERT INTO onyx_document_links(business_id,entity_type,source_id,onyx_document_id,content_hash) VALUES(1,'knowledge',1,'ava:1:knowledge:1','hash-a')")
    assert (await answer(service))['handled']
    with sqlite3.connect(service.db_path) as conn:
        conn.execute("UPDATE knowledge_base SET contentHash='revision-2' WHERE id=1")
        conn.execute("UPDATE kb_chunks SET text='SYNTHETIC_UPDATED_POLICY' WHERE kbId=1")
    assert (await answer(service))['error_code'] == 'ONYX_RUNTIME_INDEXING'
    with sqlite3.connect(service.db_path) as conn:
        conn.execute("UPDATE onyx_document_links SET content_hash='revision-2' WHERE source_id=1")
    assert (await answer(service))['handled']
    with sqlite3.connect(service.db_path) as conn:
        conn.execute('DELETE FROM knowledge_base WHERE id=1')
    assert (await answer(service))['error_code'] == 'ONYX_RUNTIME_EMPTY'
    assert len(runner.calls) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize('citations', [[{'source_id': 2}], [{}], [{'source_id': True}],
                                        [{'source_id': 1, 'external_id': 'ava:2:knowledge:1'}]])
async def test_runtime_does_not_trust_provider_grounded_flag(runtime, citations):
    service, runner = runtime
    async def foreign(_kwargs):
        return {'business_id': 1, 'grounded': True, 'citations': citations, 'answer': 'SYNTHETIC_FOREIGN'}
    runner.hook = foreign
    result = await answer(service)
    assert result['error_code'] == 'ONYX_RUNTIME_SCOPE_MISMATCH' and not result['handled']
    assert 'SYNTHETIC_FOREIGN' not in str(result)


@pytest.mark.asyncio
async def test_timings_are_observed_and_opaque_stages_are_unavailable(runtime):
    service, _ = runtime
    result = await answer(service)
    for key in ('total_ms', 'guard_ms', 'runner_ms'):
        assert math.isfinite(result['timings'][key]) and result['timings'][key] >= 0
    assert all(result['timings'][key] is None for key in ('queue_ms', 'retrieval_ms', 'model_ttft_ms'))
    assert result['response_time_ms'] >= 0
