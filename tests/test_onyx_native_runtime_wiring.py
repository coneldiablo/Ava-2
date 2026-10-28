"""Actual native HTTP client -> runner -> runtime; provider data is synthetic."""
import asyncio
from copy import deepcopy
import json
import os
from pathlib import Path
import sqlite3
from types import SimpleNamespace
from urllib.parse import quote
from uuid import uuid4

import httpx
import pytest

from src.core.onyx_agent_runner import OnyxAgentRunner
from src.core.onyx_client import OnyxClientError
from src.core.onyx_db import compute_content_hash, init_onyx_tables
from src.core.onyx_knowledge_runtime import OnyxKnowledgeRuntime
from src.core.onyx_native_runtime_client import OnyxNativeRuntimeClient, normalize_private_gateway_origin
from src.core import onyx_native_runtime_config as config_module


@pytest.fixture
def native(tmp_path):
    path = str(tmp_path/'native.db')
    deployments = {business: str(uuid4()) for business in (1, 2)}
    configs = {business: {'enabled': True, 'deployment_id': deployment,
        'deployment_revision': 1, 'private_gateway_origin': f'http://ava_{deployment.replace("-", "")}-gateway-1:4081',
        'runtime_peer_secret': str(business)*43} for business, deployment in deployments.items()}
    markers = {1: 'SYNTHETIC_ALPHA_NATIVE_739', 2: 'SYNTHETIC_BETA_NATIVE_941'}
    hashes = {business: compute_content_hash(marker) for business, marker in markers.items()}
    with sqlite3.connect(path) as conn:
        conn.executescript('''
            CREATE TABLE instances(id INTEGER PRIMARY KEY,name TEXT,isActive INTEGER);
            INSERT INTO instances VALUES(1,'Alpha',1),(2,'Beta',1);
            CREATE TABLE clients(id INTEGER PRIMARY KEY,instanceId INTEGER,chatId TEXT);
            CREATE TABLE knowledge_base(id INTEGER PRIMARY KEY,instanceId INTEGER,business_id INTEGER,contentHash TEXT,isCurrent INTEGER);
            CREATE TABLE kb_chunks(id INTEGER PRIMARY KEY,kbId INTEGER,chunkIndex INTEGER,text TEXT);
            CREATE TABLE ava_module_deployments(id TEXT PRIMARY KEY,businessId INTEGER,module TEXT,state TEXT,revision INTEGER,namespace TEXT);
            CREATE TABLE ava_module_adapters(id TEXT PRIMARY KEY,businessId INTEGER,module TEXT,enabled INTEGER,
                attachmentMode TEXT,attachmentModeV2 TEXT,deploymentId TEXT,deploymentRevision INTEGER,nativeScope TEXT,
                integrationId INTEGER,integrationRevision INTEGER,revision INTEGER);
            CREATE TABLE ava_onyx_runtime_principals(businessId INTEGER,adapterId TEXT,revokedAt TEXT,adapterRevision INTEGER,
                deploymentId TEXT,deploymentRevision INTEGER,integrationRevision INTEGER,nativeScope TEXT);
            CREATE TABLE onyx_native_runtime_bindings(deployment_id TEXT,deployment_revision INTEGER,business_id INTEGER,
                role TEXT,persona_id INTEGER,document_set_name TEXT,search_tool_id INTEGER,PRIMARY KEY(deployment_id,role));
            CREATE TABLE onyx_native_runtime_document_links(deployment_id TEXT,deployment_revision INTEGER,business_id INTEGER,
                entity_type TEXT,source_id INTEGER,onyx_document_id TEXT,content_hash TEXT,PRIMARY KEY(deployment_id,entity_type,source_id));
        ''')
        init_onyx_tables(conn)
        for business, deployment in deployments.items():
            namespace = 'ava_' + deployment.replace('-', '')
            doc_id = 40 + business
            conn.execute('INSERT INTO knowledge_base VALUES(?,?,?,?,1)', (doc_id,business,None,hashes[business]))
            conn.execute('INSERT INTO kb_chunks VALUES(?,?,0,?)', (doc_id,doc_id,markers[business]))
            conn.execute("INSERT INTO ava_module_deployments VALUES(?,?,'onyx','verified',1,?)", (deployment,business,namespace))
            conn.execute("INSERT INTO onyx_tenant_links(id,business_id,onyx_tenant_id,onyx_base_url,status,revision) VALUES(?,?,?,'https://legacy.invalid/api','STAGING',1)", (business,business,f'hotel_{business}'))
            conn.execute("INSERT INTO ava_module_adapters VALUES(?,?,'onyx',1,'existing_workspace_ui','isolated_workspace_ui',?,1,?,?,1,1)", (f'adapter-{business}',business,deployment,namespace,business))
            conn.execute('INSERT INTO ava_onyx_runtime_principals VALUES(?,?,NULL,1,?,1,1,?)', (business,f'adapter-{business}',deployment,namespace))
            conn.execute("INSERT INTO onyx_native_runtime_bindings VALUES(?,1,?,'sales',?,?,7)", (deployment,business,business,'ava-native-'+deployment.replace('-','')+'-knowledge'))
            conn.execute("INSERT INTO onyx_native_runtime_document_links VALUES(?,1,?,'knowledge',?,?,?)", (deployment,business,doc_id,quote(f'ava:{business}:knowledge:{doc_id}',safe=''),hashes[business]))
            # Correct legacy links deliberately exist; native tests must never
            # use them as proof that the isolated deployment has indexed data.
            conn.execute("INSERT INTO onyx_document_links(business_id,entity_type,source_id,onyx_document_id,content_hash) VALUES(?,'knowledge',?,?,?)", (business,doc_id,f'ava:{business}:knowledge:{doc_id}',hashes[business]))
    return {'path': path, 'deployments': deployments, 'configs': configs, 'markers': markers, 'hashes': hashes}


class NativeHTTP:
    def __init__(self, fixture, business=1, mutate=None):
        self.fixture, self.business, self.mutate = fixture, business, mutate
        self.calls = []
        self.session = str(uuid4())

    async def __call__(self, request):
        self.calls.append((request.method, request.url.path, json.loads(request.content) if request.content else None))
        config = self.fixture['configs'][self.business]
        assert request.headers['x-ava-runtime-peer'] == config['runtime_peer_secret']
        assert 'authorization' not in request.headers and 'cookie' not in request.headers
        assert request.url.host == f'ava_{config["deployment_id"].replace("-", "")}-gateway-1'
        prefix = '/v1/onyx-runtime/chat/'
        if request.url.path == prefix+'create-chat-session':
            return httpx.Response(200,json={'chat_session_id': self.session,'incognito': True})
        if request.url.path == prefix+'send-chat-message':
            payload = json.loads(request.content)
            assert payload['internal_search_filters'] == {'document_set': [
                'ava-native-'+config['deployment_id'].replace('-','')+'-knowledge'],
                'tags': [{'tag_key':'ava_entity_type','tag_value':'knowledge'}]}
            source = 40+self.business
            external = quote(f'ava:{self.business}:knowledge:{source}',safe='')
            result = {'incognito': True,'answer_citationless': self.fixture['markers'][self.business],
                'top_documents': [{'document_id':external,'semantic_identifier':'Synthetic own policy',
                    'metadata': {'business_id':str(self.business),'ava_entity_type':'knowledge',
                                 'ava_content_hash':self.fixture['hashes'][self.business]},'is_internet':False}],
                'citation_info':[{'document_id':external,'citation_number':1}]}
            if self.mutate:
                self.mutate(result)
            return httpx.Response(200,json=result)
        if request.url.path == prefix+'get-chat-session/'+self.session:
            return httpx.Response(200,json={'incognito':True,'persona_id':self.business})
        assert request.url.path in [prefix+'stop-chat-session/'+self.session,prefix+'end-incognito-session/'+self.session]
        assert json.loads(request.content) == {}
        return httpx.Response(200,json=None)


def service(fixture, http):
    def no_legacy(**kwargs):
        raise AssertionError('Configured native route must never instantiate legacy transport')
    def runner(**kwargs):
        return OnyxAgentRunner(client_factory=no_legacy,
            native_runtime_client_factory=lambda **options: OnyxNativeRuntimeClient(
                transport=httpx.MockTransport(http), **options), **kwargs)
    return OnyxKnowledgeRuntime(fixture['path'], runner_factory=runner,
        native_runtime_config_provider=lambda business: fixture['configs'].get(business))


async def answer(runtime, business=1, **kwargs):
    return await runtime.answer(business_id=business, question='Каков синтетический маркер?',
        channel=kwargs.pop('channel','whatsapp'), correlation_id='native-fixture', **kwargs)


@pytest.mark.asyncio
@pytest.mark.parametrize('channel,preview', [('voice',False),('whatsapp',False),('whatsapp',True)])
async def test_native_real_transport_runner_runtime_own_marker_and_cleanup(native,channel,preview):
    for business in (1,2):
        http = NativeHTTP(native,business)
        result = await answer(service(native,http),business,channel=channel,preview=preview)
        assert result['handled'] and result['answer'] == native['markers'][business]
        assert result['citations'][0]['source_id'] == 40+business
        assert result['citations'][0]['external_id'] == f'ava:{business}:knowledge:{40+business}'
        assert result['timings']['runner']['cleanup_ms'] >= 0
        assert result['timings']['model_ttft_ms'] is None
        assert http.calls[-1][1].endswith('end-incognito-session/'+http.session)
        assert native['configs'][business]['runtime_peer_secret'] not in str(result)


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['disabled','bad_peer','extra','foreign_gateway','foreign_deployment','stale_revision'])
async def test_configured_invalid_native_never_falls_back_or_calls_provider(native,change):
    config = native['configs'][1]
    if change == 'disabled': config['enabled'] = False
    if change == 'bad_peer': config['runtime_peer_secret'] = 'secret-private-invalid'
    if change == 'extra': config['business_id'] = 2
    if change == 'foreign_gateway': config['private_gateway_origin'] = native['configs'][2]['private_gateway_origin']
    if change == 'foreign_deployment': config['deployment_id'] = native['deployments'][2]
    if change == 'stale_revision': config['deployment_revision'] = 2
    http = NativeHTTP(native)
    result = await answer(service(native,http),preview=True)
    assert not result['handled'] and not http.calls
    assert result['error_code'] in {'ONYX_NATIVE_RUNTIME_CONFIG_INVALID','ONYX_NATIVE_RUNTIME_NOT_READY'}
    assert 'secret-private-invalid' not in str(result)


@pytest.mark.asyncio
@pytest.mark.parametrize('mutation', [
    "UPDATE ava_module_deployments SET state='disabled' WHERE businessId=1",
    "UPDATE ava_module_adapters SET enabled=0 WHERE businessId=1",
    "UPDATE ava_module_adapters SET attachmentModeV2='shared_workspace_ui' WHERE businessId=1",
    'UPDATE ava_module_adapters SET revision=2 WHERE businessId=1',
    'UPDATE ava_module_adapters SET integrationRevision=2 WHERE businessId=1',
    "UPDATE ava_onyx_runtime_principals SET revokedAt='revoked' WHERE businessId=1",
    'UPDATE ava_onyx_runtime_principals SET deploymentRevision=2 WHERE businessId=1',
    "UPDATE onyx_tenant_links SET status='DISABLED' WHERE business_id=1",
    "UPDATE onyx_native_runtime_bindings SET document_set_name='shared-admin' WHERE business_id=1",
    'UPDATE onyx_native_runtime_bindings SET deployment_revision=2 WHERE business_id=1',
    'DROP TABLE ava_onyx_runtime_principals',
])
async def test_native_admission_is_revision_fenced_and_optional_schema_fails_closed(native,mutation):
    with sqlite3.connect(native['path']) as conn:
        conn.execute(mutation)
    http = NativeHTTP(native)
    result = await answer(service(native,http),preview=True)
    assert result['error_code'] == 'ONYX_NATIVE_RUNTIME_NOT_READY'
    assert not http.calls and not result['handled']


@pytest.mark.asyncio
@pytest.mark.parametrize('mutation,code', [
    ('DELETE FROM onyx_native_runtime_document_links WHERE business_id=1','ONYX_RUNTIME_INDEXING'),
    ('UPDATE onyx_native_runtime_document_links SET deployment_revision=2 WHERE business_id=1','ONYX_RUNTIME_INDEXING'),
    ('UPDATE onyx_native_runtime_document_links SET business_id=2 WHERE source_id=41','ONYX_RUNTIME_INDEXING'),
    ("UPDATE onyx_native_runtime_document_links SET onyx_document_id='ava:2:knowledge:41' WHERE source_id=41",'ONYX_RUNTIME_INDEXING'),
    ("UPDATE onyx_native_runtime_document_links SET content_hash='stale' WHERE source_id=41",'ONYX_RUNTIME_INDEXING'),
    ('UPDATE knowledge_base SET business_id=2 WHERE id=41','ONYX_RUNTIME_INDEXING'),
    ('DELETE FROM knowledge_base WHERE id=41','ONYX_RUNTIME_EMPTY'),
    ('DROP TABLE onyx_native_runtime_document_links','ONYX_RUNTIME_UNAVAILABLE'),
])
async def test_native_corpus_uses_only_current_own_projection_not_correct_legacy_links(native,mutation,code):
    with sqlite3.connect(native['path']) as conn:
        conn.execute(mutation)
    http = NativeHTTP(native)
    result = await answer(service(native,http),preview=True)
    assert result['error_code'] == code and not result['handled'] and not http.calls


@pytest.mark.asyncio
@pytest.mark.parametrize('mutation,code', [
    ('DELETE FROM knowledge_base WHERE id=41','ONYX_RUNTIME_EMPTY'),
    ("UPDATE knowledge_base SET contentHash='revision-2' WHERE id=41",'ONYX_RUNTIME_INDEXING'),
    ('DELETE FROM onyx_native_runtime_document_links WHERE source_id=41','ONYX_RUNTIME_INDEXING'),
    ("UPDATE ava_onyx_runtime_principals SET revokedAt='revoked' WHERE businessId=1",'ONYX_NATIVE_RUNTIME_NOT_READY'),
    ('UPDATE ava_module_adapters SET revision=2 WHERE businessId=1','ONYX_NATIVE_RUNTIME_NOT_READY'),
])
async def test_native_midflight_delete_update_revoke_stop_before_private_end(native,mutation,code):
    def change(_result):
        with sqlite3.connect(native['path']) as conn:
            conn.execute(mutation)
    http = NativeHTTP(native,mutate=change)
    result = await answer(service(native,http),preview=True)
    assert result['error_code'] == code and not result['handled']
    assert native['markers'][1] not in str(result)
    assert http.calls[-2][1].endswith('stop-chat-session/'+http.session)
    assert http.calls[-1][1].endswith('end-incognito-session/'+http.session)


@pytest.mark.asyncio
@pytest.mark.parametrize('change,code', [('foreign','ONYX_RUNTIME_SCOPE_MISMATCH'),('stale','ONYX_RUNTIME_INDEXING'),('negative','ONYX_RUNTIME_UNGROUNDED')])
async def test_native_foreign_stale_and_unsupported_provider_answers_are_not_published(native,change,code):
    def mutate(result):
        if change == 'foreign': result['top_documents'][0]['metadata']['business_id'] = '2'
        if change == 'stale': result['top_documents'][0]['metadata']['ava_content_hash'] = 'old-hash'
        if change == 'negative': result.update(top_documents=[],citation_info=[])
    http = NativeHTTP(native,mutate=mutate)
    result = await answer(service(native,http),preview=True)
    assert result['error_code'] == code and not result['handled']
    assert native['markers'][1] not in str(result)
    assert http.calls[-1][1].endswith('end-incognito-session/'+http.session)


@pytest.mark.asyncio
async def test_native_cancel_real_http_stops_remote_turn_before_private_end(native):
    entered = asyncio.Event()
    http = NativeHTTP(native)
    async def slow(request):
        if request.url.path.endswith('/send-chat-message'):
            http.calls.append((request.method,request.url.path,None))
            entered.set()
            await asyncio.Event().wait()
        return await http(request)
    task = asyncio.create_task(answer(service(native,slow),preview=True))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert http.calls[-2][1].endswith('stop-chat-session/'+http.session)
    assert http.calls[-1][1].endswith('end-incognito-session/'+http.session)


def trusted_files(tmp_path,monkeypatch,value):
    root = tmp_path/'routes'
    root.mkdir(mode=0o750)
    path = root/'1.json'
    path.write_text(json.dumps(value))
    path.chmod(0o440)
    monkeypatch.setenv('AVA_ONYX_NATIVE_RUNTIME_DIRECTORY',str(root))
    real_fstat = os.fstat
    # Tests cannot create root-owned files on the user's Mac. Only ownership
    # metadata is emulated; actual openat/no-follow, modes and bytes are real.
    def root_owned(fd):
        info = real_fstat(fd)
        return SimpleNamespace(st_mode=info.st_mode,st_uid=0,st_gid=1000,st_size=info.st_size)
    monkeypatch.setattr(config_module.os,'fstat',root_owned)
    return root,path


def test_root_config_loader_exact_business_and_absence(tmp_path,monkeypatch):
    value = {'business_id':1,'enabled':True,'deployment_id':str(uuid4())}
    root,path = trusted_files(tmp_path,monkeypatch,value)
    assert config_module.native_runtime_config(1) == {key:item for key,item in value.items() if key!='business_id'}
    assert config_module.native_runtime_config(2) is None
    path.chmod(0o640)
    with pytest.raises(OnyxClientError): config_module.native_runtime_config(1)


@pytest.mark.parametrize('bad_business', [2,True,'1'])
def test_root_config_loader_rejects_foreign_or_untyped_business(tmp_path,monkeypatch,bad_business):
    trusted_files(tmp_path,monkeypatch,{'business_id':bad_business,'runtime_peer_secret':'PRIVATE_FILE_MARKER'})
    with pytest.raises(OnyxClientError) as error:
        config_module.native_runtime_config(1)
    assert error.value.code == 'ONYX_NATIVE_RUNTIME_CONFIG_INVALID'
    assert 'PRIVATE_FILE_MARKER' not in str(error.value)


def test_root_config_loader_rejects_symlink_and_mutable_directory(tmp_path,monkeypatch):
    root,path = trusted_files(tmp_path,monkeypatch,{'business_id':1})
    target = root/'original.json'
    path.rename(target)
    path.symlink_to(target)
    with pytest.raises(OnyxClientError): config_module.native_runtime_config(1)
    path.unlink()
    target.rename(path)
    root.chmod(0o770)
    with pytest.raises(OnyxClientError): config_module.native_runtime_config(1)


def test_root_config_loader_rejects_untrusted_owner_before_reading_file(tmp_path,monkeypatch):
    root,path = trusted_files(tmp_path,monkeypatch,{'business_id':1})
    real_fstat = os.fstat
    def untrusted_owner(fd):
        info = real_fstat(fd)
        return SimpleNamespace(st_mode=info.st_mode,st_uid=501,st_gid=1000,st_size=info.st_size)
    monkeypatch.setattr(config_module.os,'fstat',untrusted_owner)
    with pytest.raises(OnyxClientError) as error:
        config_module.native_runtime_config(1)
    assert error.value.code == 'ONYX_NATIVE_RUNTIME_CONFIG_INVALID'


def test_private_origin_allows_only_exact_unpublished_gateway_port(native):
    origin = native['configs'][1]['private_gateway_origin']
    assert normalize_private_gateway_origin(origin) == origin
    for unsafe in [origin.replace(':4081',':4080'),origin.replace('ava_','shared_'),'http://172.18.0.9:4081']:
        with pytest.raises(OnyxClientError): normalize_private_gateway_origin(unsafe)
