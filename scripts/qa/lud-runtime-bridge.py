"""Controlled transport for actual OnyxKnowledgeRuntime + OnyxAgentRunner.

Answers are extracted from a persisted synthetic index selected by the runner's
document-set filter. This does not contact a live Onyx index or LLM.
"""
import asyncio
import json
import re
import sqlite3
import sys
from urllib.parse import unquote
from pathlib import Path
from uuid import uuid4

payload = json.load(sys.stdin)
sys.path.insert(0, payload['repo'])
from src.core.onyx_agent_runner import OnyxAgentRunner
from src.core.onyx_client import OnyxClient, OnyxClientError, OnyxResponse
from src.core.onyx_knowledge_runtime import OnyxKnowledgeRuntime

events = []
mode = payload.get('mode', 'normal')
db_path = payload['db']


class IndexedTransport(OnyxClient):
    def __init__(self, **kwargs):
        self.cc_pair_id = kwargs.get('cc_pair_id')

    async def request(self, method, path, body=None):
        events.append(path.split('/')[2])
        if path == '/onyx-api/ingestion':
            if mode == 'ingest-error':
                raise OnyxClientError('synthetic ingest failure', code='ONYX_NETWORK_ERROR', status_code=503, retryable=True)
            doc = body['document']
            metadata = doc['metadata']
            business_id = int(metadata['business_id'])
            assert body['cc_pair_id'] == business_id
            assert metadata['ava_entity_type'] == 'knowledge'
            content = '\n\n'.join(s['text'] for s in doc['sections'])
            with sqlite3.connect(db_path) as conn:
                binding = conn.execute("SELECT document_set_name FROM onyx_agent_bindings WHERE business_id=? AND role='sales'", (business_id,)).fetchone()
                conn.execute('INSERT OR REPLACE INTO lud_fixture_index VALUES(?,?,?,?,?)',
                             (doc['id'], business_id, binding[0], metadata['ava_content_hash'], content))
            return OnyxResponse(200, {'document_id': doc['id']})
        if method == 'DELETE' and path.startswith('/onyx-api/ingestion/'):
            doc_id = unquote(unquote(path.rsplit('/', 1)[1]))
            with sqlite3.connect(db_path) as conn:
                conn.execute('DELETE FROM lud_fixture_index WHERE external_id=?', (doc_id,))
            return OnyxResponse(200, {})
        if path == '/chat/create-chat-session':
            return OnyxResponse(200, {'chat_session_id': str(uuid4()), 'incognito': True})
        if path.startswith(('/chat/end-incognito-session/', '/chat/stop-chat-session/')):
            return OnyxResponse(200, {})
        assert path == '/chat/send-chat-message'
        assert body['incognito'] if 'incognito' in body else True
        assert body['internal_search_filters']['tags'] == [{'tag_key': 'ava_entity_type', 'tag_value': 'knowledge'}]
        assert body['include_citations'] is True and body['stream'] is False
        if mode == 'error':
            raise RuntimeError('synthetic provider failure')
        if mode == 'cancel':
            await asyncio.Event().wait()
        selected_set = body['internal_search_filters']['document_set'][0]
        with sqlite3.connect(db_path) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute('SELECT * FROM lud_fixture_index WHERE document_set=?', (selected_set,)).fetchall()
            if mode == 'foreign':
                rows = conn.execute('SELECT * FROM lud_fixture_index WHERE document_set<>? LIMIT 1', (selected_set,)).fetchall()
        key = 'выезд' if 'выезд' in body['message'].lower() and 'заезд' not in body['message'].lower() else 'заезд'
        selected = next((row for row in rows if key in row['content'].lower()), None)
        if not selected or mode == 'uncited':
            return OnyxResponse(200, {'incognito': True, 'answer_citationless': 'Нет проверенных данных.', 'top_documents': [], 'citation_info': []})
        fact = re.search(rf'{key}[^.\n]*\d{{2}}:\d{{2}}', selected['content'], re.I).group(0)
        metadata = {'business_id': str(selected['business_id']), 'ava_entity_type': 'knowledge',
                    'ava_content_hash': 'old-hash' if mode == 'stale' else selected['content_hash']}
        return OnyxResponse(200, {'incognito': True, 'answer_citationless': fact,
            'top_documents': [{'document_id': selected['external_id'], 'metadata': metadata,
                               'is_internet': False, 'semantic_identifier': 'Synthetic fixture rules'}],
            'citation_info': [{'document_id': selected['external_id'], 'citation_number': 1}]})


async def run():
    if payload.get('action') in {'sync', 'lease'}:
        from src.core import onyx_outbox_worker as worker_module
        worker_module.OnyxClient = IndexedTransport
        worker = worker_module.OnyxOutboxWorker(db_path)
        leased = worker.lease_events(limit=100)
        completed = []
        if payload['action'] == 'sync':
            for event in leased:
                completed.append(await worker.process_single_event(event))
        with sqlite3.connect(db_path) as conn:
            statuses = conn.execute('SELECT status,COUNT(*),MAX(attempts) FROM onyx_sync_outbox GROUP BY status').fetchall()
        print(json.dumps({'result': {'leased': len(leased), 'completed': completed, 'statuses': statuses}, 'trace': events}))
        return
    runtime = OnyxKnowledgeRuntime(db_path, runner_factory=lambda **kw: OnyxAgentRunner(**kw, client_factory=IndexedTransport))
    kwargs = {k: payload[k] for k in ('business_id', 'question', 'channel', 'correlation_id', 'customer_id') if k in payload}
    kwargs['preview'] = False
    if mode == 'cancel':
        task = asyncio.create_task(runtime.answer(**kwargs))
        while 'send-chat-message' not in events:
            if task.done():
                raise AssertionError('runner ended before cancellation')
            await asyncio.sleep(0.001)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            result = {'cancelled': True}
        assert events[-2:] == ['stop-chat-session', 'end-incognito-session'], events
    else:
        result = await runtime.answer(**kwargs)
    print(json.dumps({'result': result, 'trace': events}, ensure_ascii=False))


asyncio.run(run())
