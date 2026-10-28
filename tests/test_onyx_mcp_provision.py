import asyncio
import runpy
import sqlite3
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.core.onyx_db import init_onyx_tables
from src.core.onyx_mcp_bridge import READ_ACTIONS

provision = runpy.run_path(str(Path(__file__).resolve().parents[1]/'scripts/provision-onyx-mcp.py'))['provision']
URL = 'https://ava.example.test/api/integrations/onyx/mcp'


@pytest.fixture
def setup(tmp_path):
    path = str(tmp_path/'provision.db')
    with sqlite3.connect(path) as conn:
        conn.executescript("CREATE TABLE instances(id INTEGER PRIMARY KEY,name TEXT,isActive INTEGER); INSERT INTO instances VALUES(1,'Alpha',1);")
        init_onyx_tables(conn)
        conn.execute("INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,credential_ref,cc_pair_id,status) VALUES(1,'hotel_1','https://onyx.test/api','ONYX_TEST_KEY',1,'STAGING')")
        conn.execute("INSERT INTO onyx_agent_bindings VALUES(1,'sales','https://onyx.test/api',1,1,'hotel_1',1,1,CURRENT_TIMESTAMP)")
    persona = {'id':1,'name':'AVA Hotel 1 sales','description':'Existing operator description','is_public':False,
        'document_sets':[{'id':1}], 'default_model_configuration_id':1,'system_prompt':'Keep operator prompt',
        'task_prompt':'Keep task prompt', 'replace_base_system_prompt':False,'datetime_aware':True,
        'tools':[{'id':1}], 'attached_documents':[{'id':'ava:1:knowledge:4'}]}
    state = {'persona':persona,'servers':[],'requests':[]}

    class Client:
        def __init__(self, **kwargs):
            pass

        async def request(self, method, path, body=None):
            state['requests'].append((method,path,deepcopy(body)))
            if method == 'GET' and path == '/persona/1':
                result = deepcopy(state['persona'])
            elif path == '/admin/mcp/servers':
                result = {'mcp_servers':state['servers']}
            elif path == '/admin/mcp/servers/create':
                assert body['auth_type'] == 'API_TOKEN' and len(body['api_token']) == 43
                assert body['transport'] == 'STREAMABLE_HTTP'
                state['servers'] = [{'id':7,'name':'AVA Read Actions','server_url':URL}]
                result = {'server_id':7}
            elif path == '/admin/mcp/server/7/tools/snapshots?source=mcp':
                result = [{'id':i+10,'name':name,'mcp_server_id':7} for i,name in enumerate(sorted(READ_ACTIONS))]
            elif path == '/admin/mcp/servers/update':
                assert set(body['selected_tools']) == READ_ACTIONS
                result = {'updated_tools':6}
            elif method == 'PATCH' and path == '/persona/1':
                assert body['system_prompt'] == 'Keep operator prompt'
                assert body['document_ids'] == ['ava:1:knowledge:4']
                assert body['is_public'] is False
                state['persona']['tools'] = [{'id':value} for value in body['tool_ids']]
                result = deepcopy(state['persona'])
            else:
                raise AssertionError((method,path))
            return SimpleNamespace(body=result)
    return path, state, Client


def test_provision_read_catalog_and_preserve_operator_prompt_idempotently(setup):
    path,state,client = setup
    result = asyncio.run(provision(1,URL,db_path=path,client_factory=client))
    assert result['write_tools_enabled'] is False and result['live_cutover'] is False
    assert set(result['agents'][0]['read_tools']) == {'get_customer','get_hotel_info','get_booking','get_availability'}
    with sqlite3.connect(path) as conn:
        assert conn.execute('SELECT COUNT(*) FROM onyx_mcp_tool_bindings').fetchone()[0] == 4
        original_hash = conn.execute('SELECT token_hash FROM onyx_mcp_discovery_credentials').fetchone()[0]
    asyncio.run(provision(1,URL,db_path=path,client_factory=client))
    assert sum(path == '/admin/mcp/servers/create' for _,path,_ in state['requests']) == 1
    with sqlite3.connect(path) as conn:
        assert conn.execute('SELECT token_hash FROM onyx_mcp_discovery_credentials').fetchone()[0] == original_hash
    assert 'api_token' not in str(result)


@pytest.mark.parametrize('change', [{'is_public':True},{'document_sets':[{'id':2}]},{'default_model_configuration_id':2}])
def test_foreign_or_public_persona_rejected_before_mutation(setup, change):
    path,state,client = setup
    state['persona'].update(change)
    with pytest.raises(ValueError, match='Persona scope'):
        asyncio.run(provision(1,URL,db_path=path,client_factory=client))
    assert all(method == 'GET' for method,_,_ in state['requests'])
    with sqlite3.connect(path) as conn:
        assert conn.execute('SELECT COUNT(*) FROM onyx_mcp_discovery_credentials').fetchone()[0] == 0


@pytest.mark.parametrize('url', ['http://ava.test/api/integrations/onyx/mcp','https://user:password@ava.test/api/integrations/onyx/mcp',URL+'?token=secret'])
def test_unsafe_endpoint_rejected(setup,url):
    path,state,client = setup
    with pytest.raises(ValueError):
        asyncio.run(provision(1,url,db_path=path,client_factory=client))
    assert state['requests'] == []
