"""Real Node ingest/outbox and Python runtime joined by one temporary DB.

Only embeddings and HTTP/provider responses are fakes. No external account,
message send or paid LLM call is made, and fixture text never reaches logs.
"""
import json
from pathlib import Path
import sqlite3
import subprocess
from urllib.parse import unquote

import pytest

from src.core.onyx_knowledge_runtime import OnyxKnowledgeRuntime
from src.core.onyx_outbox_worker import OnyxOutboxWorker


def node_step(path, action, document_id=''):
    script = Path(__file__).parents[1] / 'whatsapp_crm/tests/fixtures/knowledge-pipeline.cjs'
    result = subprocess.run(['node', str(script), str(path), action, str(document_id)],
                            text=True, capture_output=True, timeout=15, check=True)
    return json.loads(next(line.removeprefix('PIPELINE_RESULT:') for line in result.stdout.splitlines()
                           if line.startswith('PIPELINE_RESULT:')))


class Response:
    status = 200

    def __init__(self, value):
        self.value = json.dumps(value).encode()

    def read(self, *_args):
        return self.value

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


@pytest.mark.asyncio
async def test_actual_parsed_upload_edit_delete_reaches_scoped_runtime(tmp_path, monkeypatch):
    path = tmp_path / 'pipeline.db'
    docs = node_step(path, 'upload')
    monkeypatch.setenv('DB_PATH', str(path))
    monkeypatch.delenv('AVA_ONYX_NATIVE_RUNTIME_DIRECTORY', raising=False)
    for business_id in (7, 8):
        monkeypatch.setenv(f'FIXTURE_ONYX_{business_id}', f'synthetic-key-{business_id}')
    indexed, requests = {}, []
    foreign = False

    def fake_http(request, timeout):
        requests.append(request.full_url)
        body = json.loads(request.data) if request.data else {}
        if request.method == 'DELETE':
            indexed.pop(unquote(unquote(request.full_url.rsplit('/', 1)[1])), None)
            return Response({})
        if request.full_url.endswith('/onyx-api/ingestion'):
            document = body['document']
            assert body['cc_pair_id'] == int(document['metadata']['business_id'])
            indexed[document['id']] = document
            return Response({'document_id': document['id'].replace(':', '%3A')})
        if request.full_url.endswith('/chat/create-chat-session'):
            return Response({'chat_session_id': '11111111-1111-4111-8111-111111111111', 'incognito': True})
        if request.full_url.endswith('/chat/send-chat-message'):
            business_id = int(request.get_header('Authorization').rsplit('-', 1)[1])
            assert body['internal_search_filters']['document_set'] == [f'synthetic-{business_id}']
            selected = 8 if foreign else business_id
            document = next(value for value in indexed.values() if value['metadata']['business_id'] == str(selected))
            return Response({'incognito': True, 'answer_citationless': document['sections'][0]['text'],
                             'top_documents': [{'document_id': document['id'], 'metadata': document['metadata'],
                                                'semantic_identifier': document['title']}],
                             'citation_info': [{'document_id': document['id'], 'citation_number': 1}]})
        assert '/chat/end-incognito-session/' in request.full_url or '/chat/stop-chat-session/' in request.full_url
        return Response({})

    monkeypatch.setattr('urllib.request.urlopen', fake_http)
    service = OnyxKnowledgeRuntime(str(path))

    async def ask(business_id):
        return await service.answer(business_id=business_id, question='Контрольное время заезда?',
                                    channel='whatsapp', correlation_id='synthetic-pipeline', preview=True)

    assert (await ask(7))['error_code'] == 'ONYX_RUNTIME_INDEXING'
    assert not requests  # Local upload/chunks alone must not invoke generation.
    worker = OnyxOutboxWorker(str(path))

    async def drain():
        events = worker.lease_events()
        for event in events:
            assert await worker.process_single_event(event)
        return len(events)

    assert await drain() == 2
    for business_id in (7, 8):
        result = await ask(business_id)
        assert result['handled'] and result['grounded']
        assert f'SYNTHETIC_MARKER_{business_id}' in result['answer']
        assert f'SYNTHETIC_MARKER_{15-business_id}' not in result['answer']
        assert result['citations'][0]['external_id'].startswith(f'ava:{business_id}:knowledge:')
    foreign = True
    refused = await ask(7)
    assert not refused['handled'] and refused['error_code'] == 'ONYX_RUNTIME_SCOPE_MISMATCH'
    assert 'SYNTHETIC_MARKER_8' not in str(refused)
    assert '/chat/stop-chat-session/' in requests[-2] and '/chat/end-incognito-session/' in requests[-1]
    foreign = False
    own_id = next(row['documentId'] for row in docs if row['businessId'] == 7)
    node_step(path, 'edit', own_id)
    assert (await ask(7))['error_code'] == 'ONYX_RUNTIME_INDEXING'
    assert await drain() == 1
    assert 'SYNTHETIC_UPDATED_7' in (await ask(7))['answer']
    node_step(path, 'delete', own_id)
    assert (await ask(7))['error_code'] == 'ONYX_RUNTIME_EMPTY'
    assert await drain() == 1
    assert f'ava:7:knowledge:{own_id}' not in indexed
    assert (await ask(8))['handled']
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT COUNT(*) FROM onyx_sync_outbox WHERE status!='COMPLETED'").fetchone()[0] == 0
