import json
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.core.onyx_mcp_bridge import OnyxExecutionScope, OnyxMcpBridge, OnyxMcpError


@pytest.fixture
def bridge(tmp_path, monkeypatch):
    path = str(tmp_path/'mcp.db')
    monkeypatch.setenv('DB_PATH', path)
    monkeypatch.setenv('ONYX_MCP_ENABLED', 'true')
    with sqlite3.connect(path) as conn:
        conn.executescript('''CREATE TABLE instances(id INTEGER PRIMARY KEY,name TEXT,businessType TEXT,isActive INTEGER);
            CREATE TABLE clients(id INTEGER PRIMARY KEY,instanceId INTEGER,chatId TEXT,senderName TEXT,leadStatus TEXT);
            INSERT INTO instances VALUES(1,'Alpha','hotel',1),(2,'Beta','hotel',1);
            INSERT INTO clients VALUES(1,1,'79990000001@c.us','Alpha guest','new'),(2,2,'79990000001@c.us','Beta guest','booked');''')
    result = OnyxMcpBridge(path)
    with sqlite3.connect(path) as conn:
        conn.executemany('''INSERT INTO onyx_tenant_links
            (business_id,onyx_tenant_id,onyx_base_url,credential_ref,cc_pair_id,status)
            VALUES (?,?,'https://onyx.test/api','ONYX_TEST_KEY',?,'STAGING')''', [(1,'hotel_1',1),(2,'hotel_2',2)])
    result.discovery_token = result.issue_discovery_token()
    result.discovery_hash = result.authenticate_discovery('Bearer '+result.discovery_token)
    return result


def execution(bridge, business_id=1, role='sales', customer_id=1):
    return bridge.issue_execution(OnyxExecutionScope(business_id, role, 'staging', 'test-correlation', 'test-operator', customer_id))


def call(bridge, token, name='get_hotel_info', arguments=None, request_id=1):
    return bridge.call_tool(discovery_hash=bridge.discovery_hash, execution_token=token, name=name,
                            arguments=arguments or {}, request_id=request_id)


def test_real_read_action_is_scoped_and_audited(bridge):
    token = execution(bridge)
    result = call(bridge, token)
    assert result['business_id'] == 1
    assert result['read_only'] is True
    assert result['result']['hotel']['name'] == 'Alpha'
    assert call(bridge, token) == result
    assert bridge.execution_evidence(token) == [{'action':'get_hotel_info','audit_event_id':result['audit_event_id'],
                                                'customer_context_provided':False}]
    with sqlite3.connect(bridge.db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM onyx_action_audit WHERE status='EXECUTED'").fetchone()[0] == 1
    contents = Path(bridge.db_path).read_bytes()
    assert token.encode() not in contents and bridge.discovery_token.encode() not in contents


def test_same_phone_in_two_hotels_returns_distinct_current_customer(bridge):
    one = call(bridge, execution(bridge), 'get_customer')
    two = call(bridge, execution(bridge, business_id=2, customer_id=2), 'get_customer')
    assert one['result']['customer']['senderName'] == 'Alpha guest'
    assert two['result']['customer']['senderName'] == 'Beta guest'
    assert 'chatId' not in str(one) and '79990000001' not in str(one)
    assert one['result']['context']['business_id'] == 1
    assert two['result']['context']['business_id'] == 2
    with pytest.raises(OnyxMcpError):
        execution(bridge, customer_id=2)


def test_execution_evidence_uses_gateway_audit_not_model_claim(bridge):
    token = execution(bridge)
    assert bridge.execution_evidence(token) == []
    result = call(bridge, token, 'get_customer')
    evidence = bridge.execution_evidence(token)
    assert evidence == [{'action':'get_customer','audit_event_id':result['audit_event_id'],'customer_context_provided':True}]
    other = execution(bridge, business_id=2, customer_id=2)
    assert bridge.execution_evidence(other) == []


@pytest.mark.parametrize('arguments', [{'business_id':2}, {'instance_id':2}, {'customer_id':2}, {'phone':'79990000002'}])
def test_model_cannot_override_scope(bridge, arguments):
    with pytest.raises(OnyxMcpError) as error:
        call(bridge, execution(bridge), 'get_customer', arguments)
    assert error.value.code == 'ONYX_MCP_INVALID_ARGUMENTS'


@pytest.mark.parametrize('name', ['create_task','make_call','launch_campaign','send_whatsapp','change_price','cancel_booking','unknown'])
def test_read_only_bridge_rejects_writes_and_critical_actions(bridge, name):
    with pytest.raises(OnyxMcpError, match='ACTION_FORBIDDEN'):
        call(bridge, execution(bridge), name)


def test_discovery_auth_is_not_execution_auth(bridge):
    assert len(bridge.list_tools()['tools']) == 6
    with pytest.raises(OnyxMcpError):
        call(bridge, bridge.discovery_token)
    with pytest.raises(OnyxMcpError):
        bridge.authenticate_discovery('Bearer '+execution(bridge))


def test_group_cannot_receive_individual_customer_execution_scope(bridge):
    with sqlite3.connect(bridge.db_path) as conn:
        conn.execute("UPDATE clients SET chatId='1234567890@g.us' WHERE id=1")
    with pytest.raises(OnyxMcpError, match='CUSTOMER_SCOPE_INVALID'):
        execution(bridge)


def test_expiry_revocation_rotation_and_disabled_business_fail_closed(bridge):
    token = execution(bridge)
    bridge.revoke_execution(token)
    with pytest.raises(OnyxMcpError, match='EXECUTION_EXPIRED'):
        call(bridge, token)
    token = execution(bridge)
    now = bridge.now()
    bridge.now = lambda: now+181
    with pytest.raises(OnyxMcpError, match='EXECUTION_EXPIRED'):
        call(bridge, token)
    bridge.now = lambda: now
    token = execution(bridge)
    bridge.discovery_hash = bridge.authenticate_discovery('Bearer '+bridge.issue_discovery_token())
    with pytest.raises(OnyxMcpError, match='EXECUTION_EXPIRED'):
        call(bridge, token)
    token = execution(bridge)
    with sqlite3.connect(bridge.db_path) as conn:
        conn.execute('UPDATE instances SET isActive=0 WHERE id=1')
    with pytest.raises(OnyxMcpError, match='BUSINESS_UNAVAILABLE'):
        call(bridge, token)


def test_customer_required_and_role_checked(bridge):
    with pytest.raises(OnyxMcpError, match='CUSTOMER_NOT_SELECTED'):
        call(bridge, execution(bridge, customer_id=None), 'get_customer')
    with pytest.raises(OnyxMcpError, match='ROLE_FORBIDDEN'):
        call(bridge, execution(bridge, role='revenue'), 'get_customer')


def test_capability_budget_is_atomic_across_connections(bridge):
    token = execution(bridge)
    def invoke(i):
        another = OnyxMcpBridge(bridge.db_path)
        try:
            return another.call_tool(discovery_hash=bridge.discovery_hash, execution_token=token,
                name='get_hotel_info', arguments={}, request_id=i)['business_id']
        except OnyxMcpError as e:
            return e.code
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(invoke, range(24)))
    assert results.count(1) == 20
    assert results.count('ONYX_MCP_EXECUTION_LIMIT') == 4


@pytest.fixture
def api(bridge):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'admin_ui/backend'))
    from api.onyx_mcp import router
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    client.headers.update({'Authorization':'Bearer '+bridge.discovery_token,
                           'Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'})
    return client, bridge


def rpc(client, method, params=None, **kwargs):
    return client.post('/api/integrations/onyx/mcp', json={'jsonrpc':'2.0','id':1,'method':method,'params':params or {}}, **kwargs)


def test_http_discovery_handshake_and_real_capability_tool_call(api):
    client, bridge = api
    init = rpc(client, 'initialize', {'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'test','version':'1'}})
    assert init.status_code == 200 and init.json()['result']['protocolVersion'] == '2025-06-18'
    assert client.post('/api/integrations/onyx/mcp', json={'jsonrpc':'2.0','method':'notifications/initialized'}).status_code == 202
    assert len(rpc(client, 'tools/list').json()['result']['tools']) == 6
    result = rpc(client,'tools/call',{'name':'get_hotel_info','arguments':{}}).json()['result']
    assert result['isError'] is True
    result = rpc(client,'tools/call',{'name':'get_hotel_info','arguments':{}}, headers={'X-AVA-Execution':execution(bridge)}).json()['result']
    assert not result['isError']
    assert result['structuredContent']['result']['hotel']['name'] == 'Alpha'
    assert client.get('/api/integrations/onyx/mcp').status_code == 405


@pytest.mark.parametrize('headers,status', [
    ({'Origin':'https://evil.example'},403), ({'Authorization':'Bearer invalid'},401),
    ({'Accept':'application/json'},406), ({'MCP-Protocol-Version':'bad'},400),
])
def test_http_security_boundaries(api, headers, status):
    client, _ = api
    assert rpc(client,'tools/list',headers=headers).status_code == status


def test_http_limits_errors_and_feature_flag(api, monkeypatch):
    client, _ = api
    assert rpc(client,'tools/call',{'name':'get_hotel_info','arguments':{},'large':'x'*70000}).status_code == 413
    assert rpc(client,'unknown').json()['error']['code'] == -32601
    assert client.post('/api/integrations/onyx/mcp', content='bad',headers={'Content-Type':'application/json'}).status_code == 400
    monkeypatch.setenv('ONYX_MCP_ENABLED','false')
    assert rpc(client,'tools/list').status_code == 503
