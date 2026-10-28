"""Action gateway contracts: no fabricated success, tenant safety and durable effects."""
import asyncio
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from src.core.onyx_action_client import AvaActionClient, AvaActionError
from src.core.onyx_policy_gateway import PolicyGateway, PolicyGatewayError
from src.core.outbound_store import OutboundStore


@pytest.fixture
def gateway_db(tmp_path):
    path = str(tmp_path / "gateway.db")
    with sqlite3.connect(path) as conn:
        conn.executescript("""
            CREATE TABLE instances(id INTEGER PRIMARY KEY,name TEXT,businessType TEXT DEFAULT 'hotel',isActive INTEGER DEFAULT 1);
            INSERT INTO instances(id,name) VALUES(1,'Alpha'),(2,'Beta');
            CREATE TABLE clients(id INTEGER PRIMARY KEY,instanceId INTEGER,chatId TEXT,senderName TEXT,leadStatus TEXT);
            INSERT INTO clients VALUES(10,1,'79990000001','Guest A','new'),(20,2,'79990000001','Guest B','new');
            CREATE TABLE manager_tasks(taskId TEXT PRIMARY KEY,instanceId INTEGER,summary TEXT,priority TEXT);
            CREATE TABLE conversation_events(callId TEXT,instanceId INTEGER,chatId TEXT,content TEXT,role TEXT,createdAt TEXT,eventId TEXT,metadataJson TEXT);
            INSERT INTO conversation_events VALUES('call-a',1,'79990000001','Alpha summary','summary','2026-09-06','evt-a','{"summary_provenance":"provided_summary"}');
            INSERT INTO conversation_events VALUES('call-b',2,'79990000001','Beta summary','summary','2026-09-06','evt-b','{"summary_provenance":"provided_summary"}');
        """)
    return path


class CrmContract:
    """Persisted contract double; actual HTTP transport has separate tests."""
    def __init__(self, path):
        self.path, self.requests = path, []

    def post(self, path, business_id, payload):
        self.requests.append((path, business_id, payload))
        with sqlite3.connect(self.path) as conn:
            if path == "/manager-task":
                conn.execute("INSERT INTO manager_tasks VALUES(?,?,?,?)", (payload['taskId'], business_id, payload['summary'], payload['priority']))
                return {"success": True, "task_id": payload['taskId']}
            if path == "/stage/update":
                changed = conn.execute("UPDATE clients SET leadStatus=? WHERE instanceId=? AND chatId=?", (payload['stage'], business_id, payload['chatId'])).rowcount
                assert changed == 1
                return {"success": True, "stage": payload['stage']}
        if path == "/pms/lookup-booking":
            return {"business_id": business_id, "bookings": []}
        if path == "/pms/check-availability":
            return {"business_id": business_id, "categories": [], "live_check_available": False}
        raise AssertionError(path)


def execute(gateway, action, arguments, *, business=1, role="sales", key=None, approval=None):
    return gateway.execute_action(business, f"ava:{business}:agent:{role}", action, arguments, idempotency_key=key, approval_token=approval)


def approve(gateway, action, arguments, business=1, role="sales"):
    return gateway.issue_approval(business_id=business, agent_id=f"ava:{business}:agent:{role}", action=action, arguments=arguments, approved_by="operator")['approval_token']


def test_reads_return_actual_scoped_data_and_no_fake_pms_answers(gateway_db):
    client = CrmContract(gateway_db)
    gateway = PolicyGateway(gateway_db, client=client)
    assert execute(gateway, 'get_customer', {'customer_id': 10})['result']['customer']['senderName'] == 'Guest A'
    assert execute(gateway, 'get_hotel_info', {})['result']['hotel']['name'] == 'Alpha'
    booking = execute(gateway, 'get_booking', {'booking_number': 'unknown', 'surname': 'Guest'})['result']
    assert booking['bookings'] == []
    availability = execute(gateway, 'get_availability', {'date_from': '2026-10-01', 'date_to': '2026-10-03'})['result']
    assert availability['live_check_available'] is False
    assert 'available_rooms' not in availability
    history = execute(gateway, 'get_call_history', {'customer_id': 10}, role='manager')['result']
    assert [item['call_id'] for item in history['call_summaries']] == ['call-a']
    assert history['call_summaries'][0]['summary'] == 'Alpha summary'
    assert all(business == 1 for _, business, _ in client.requests)


def test_writes_go_through_ava_and_replay_returns_result_not_arguments(gateway_db):
    client = CrmContract(gateway_db)
    gateway = PolicyGateway(gateway_db, client=client)
    execute(gateway, 'update_customer', {'customer_id': 10, 'lead_status': 'qualified'}, key='update-1')
    args = {'summary': 'Callback requested', 'priority': 'high'}
    first = execute(gateway, 'create_task', args, key='task-1')
    second = execute(PolicyGateway(gateway_db, client=client), 'create_task', args, key='task-1')
    assert second['status'] == 'EXECUTED (CACHED)'
    assert first['result'] == second['result']
    assert first['result']['task_id']
    assert 'summary' not in second['result']
    with sqlite3.connect(gateway_db) as conn:
        assert conn.execute('SELECT COUNT(*) FROM manager_tasks').fetchone()[0] == 1
        assert conn.execute('SELECT leadStatus FROM clients WHERE id=10').fetchone()[0] == 'qualified'
        assert conn.execute('SELECT leadStatus FROM clients WHERE id=20').fetchone()[0] == 'new'


def test_unknown_foreign_or_inactive_entities_never_report_success(gateway_db):
    gateway = PolicyGateway(gateway_db, client=CrmContract(gateway_db))
    for business, customer in [(1, 20), (2, 10), (1, 999)]:
        with pytest.raises(PolicyGatewayError, match='Customer not found'):
            execute(gateway, 'update_customer', {'customer_id': customer, 'lead_status': 'qualified'}, business=business, key=f'{business}:{customer}')
    with pytest.raises(PolicyGatewayError) as error:
        gateway.execute_action(1, 'ava:2:agent:sales', 'get_customer', {'customer_id': 10})
    assert error.value.code == 'CROSS_TENANT_FORBIDDEN'
    with pytest.raises(PolicyGatewayError) as error:
        execute(gateway, 'get_hotel_info', {}, role='anything')
    assert error.value.code == 'ROLE_FORBIDDEN'
    with sqlite3.connect(gateway_db) as conn:
        conn.execute('UPDATE instances SET isActive=0 WHERE id=2')
    with pytest.raises(PolicyGatewayError, match='disabled'):
        execute(gateway, 'get_hotel_info', {}, business=2)


@pytest.mark.parametrize('arguments', [
    {'summary': 'task', 'priority': 'high', 'business_id': 2},
    {'summary': 'task', 'priority': 'high', 'approved': True},
    {'summary': 'task', 'priority': 'invalid'},
    {'summary': 'x'*2001, 'priority': 'high'},
    {'summary': None, 'priority': 'high'},
])
def test_model_cannot_inject_scope_or_approval(gateway_db, arguments):
    with pytest.raises(PolicyGatewayError):
        execute(PolicyGateway(gateway_db), 'create_task', arguments, key='invalid')


def test_idempotency_key_is_tenant_scoped_and_arguments_bound(gateway_db):
    client = CrmContract(gateway_db)
    gateway = PolicyGateway(gateway_db, client=client)
    args = {'summary': 'task', 'priority': 'normal'}
    first = execute(gateway, 'create_task', args, key='shared-key')
    other = execute(gateway, 'create_task', args, business=2, key='shared-key')
    assert first['result']['task_id'] != other['result']['task_id']
    with pytest.raises(PolicyGatewayError) as error:
        execute(gateway, 'create_task', {**args, 'priority': 'high'}, key='shared-key')
    assert error.value.code == 'IDEMPOTENCY_CONFLICT'
    assert execute(gateway, 'create_task', args, key='shared-key')['result'] == first['result']


def test_concurrent_gateways_reserve_only_one_effect(gateway_db):
    entered, release = threading.Event(), threading.Event()
    client = CrmContract(gateway_db)
    class SlowClient:
        def post(self, *args):
            entered.set()
            assert release.wait(5)
            return client.post(*args)
    first = PolicyGateway(gateway_db, client=SlowClient())
    second = PolicyGateway(gateway_db, client=client)
    args = {'summary': 'one effect', 'priority': 'normal'}
    with ThreadPoolExecutor(2) as pool:
        future = pool.submit(execute, first, 'create_task', args, key='concurrent')
        assert entered.wait(5)
        try:
            with pytest.raises(PolicyGatewayError) as error:
                execute(second, 'create_task', args, key='concurrent')
            assert error.value.code == 'ACTION_RECONCILIATION_REQUIRED'
        finally:
            release.set()
        assert future.result()['status'] == 'EXECUTED'
    assert len(client.requests) == 1


def test_uncertain_side_effect_not_retried_and_error_redacted(gateway_db):
    class BrokenClient:
        calls = 0
        def post(self, *args):
            self.calls += 1
            raise RuntimeError('Bearer abcdefgh123 password=pwd123 https://user:private@example.com token=tok123')
    client = BrokenClient()
    gateway = PolicyGateway(gateway_db, client=client)
    args = {'summary': 'task', 'priority': 'normal'}
    with pytest.raises(PolicyGatewayError):
        execute(gateway, 'create_task', args, key='lost-response')
    with pytest.raises(PolicyGatewayError) as error:
        execute(PolicyGateway(gateway_db, client=client), 'create_task', args, key='lost-response')
    assert error.value.code == 'ACTION_RECONCILIATION_REQUIRED'
    with sqlite3.connect(gateway_db) as conn:
        audit = conn.execute('SELECT payload_json FROM onyx_action_audit').fetchone()[0]
    for secret in ['abcdefgh123', 'pwd123', 'private', 'tok123']:
        assert secret not in audit
    assert client.calls == 1


def test_critical_actions_need_single_use_bound_approval(gateway_db):
    client = CrmContract(gateway_db)
    gateway = PolicyGateway(gateway_db, client=client)
    args = {'booking_id': 'B-1', 'reason': 'Guest asked'}
    with pytest.raises(PolicyGatewayError) as error:
        execute(gateway, 'cancel_booking', args, key='cancel')
    assert error.value.code == 'APPROVAL_REQUIRED'
    token = approve(gateway, 'cancel_booking', args)
    with pytest.raises(PolicyGatewayError) as error:
        execute(gateway, 'cancel_booking', {**args, 'booking_id': 'B-2'}, key='different', approval=token)
    assert error.value.code == 'APPROVAL_INVALID'
    result = execute(gateway, 'cancel_booking', args, key='cancel', approval=token)['result']
    assert result['canceled'] is False and result['task_id']
    assert result['status'] == 'manager_review_required'
    with pytest.raises(PolicyGatewayError) as error:
        execute(gateway, 'cancel_booking', args, key='second', approval=token)
    assert error.value.code == 'APPROVAL_INVALID'
    with sqlite3.connect(gateway_db) as conn:
        assert token not in str(conn.execute('SELECT * FROM onyx_action_approvals').fetchall())


def test_rate_limit_survives_gateway_restart(gateway_db):
    client = CrmContract(gateway_db)
    args = {'booking_id': 'B-1', 'reason': 'Guest asked'}
    for index in range(5):
        gateway = PolicyGateway(gateway_db, client=client)
        execute(gateway, 'cancel_booking', args, key=f'cancel-{index}', approval=approve(gateway, 'cancel_booking', args))
    gateway = PolicyGateway(gateway_db, client=client)
    with pytest.raises(PolicyGatewayError) as error:
        execute(gateway, 'cancel_booking', args, key='over-limit', approval=approve(gateway, 'cancel_booking', args))
    assert error.value.code == 'RATE_LIMIT_EXCEEDED'
    assert len(client.requests) == 5


def test_real_outbound_store_schedules_one_call_with_parent_scope(tmp_path, gateway_db, monkeypatch):
    monkeypatch.setenv('CALL_HISTORY_ENABLED', 'true')
    store = OutboundStore(str(tmp_path / 'calls.db'))
    parent = asyncio.run(store.create_campaign({'name': 'Source', 'business_id': 1, 'timezone': 'UTC', 'default_context': 'hotel_alpha', 'callerid': '+74950000001'}))
    gateway = PolicyGateway(gateway_db, outbound_store=store)
    args = {'campaign_id': parent['id'], 'phone': '+79990000001'}
    token = approve(gateway, 'make_call', args)
    result = execute(gateway, 'make_call', args, key='call-once', approval=token)['result']
    assert result['status'] == 'scheduled' and result['initiated'] is False
    campaign = store.get_campaign_sync(result['campaign_id'])
    assert campaign['business_id'] == 1 and campaign['max_attempts'] == 1
    assert campaign['default_context'] == 'hotel_alpha' and campaign['callerid'] == '+74950000001'
    replay = execute(gateway, 'make_call', args, key='call-once')['result']
    assert replay == result
    with sqlite3.connect(store._db_path) as conn:
        assert conn.execute('SELECT COUNT(*) FROM outbound_leads').fetchone()[0] == 1
    foreign = {'campaign_id': parent['id'], 'phone': '+79990000002'}
    with pytest.raises(PolicyGatewayError, match='Campaign not found'):
        execute(gateway, 'make_call', foreign, business=2, key='foreign', approval=approve(gateway, 'make_call', foreign, business=2))


def test_transport_overwrites_all_tenant_aliases_and_rejects_unapproved_urls(monkeypatch):
    monkeypatch.setenv('CRM_SERVICE_API_TOKEN', 'test-only-token')
    monkeypatch.setenv('SALES_BRAIN_BASE_URL', 'http://localhost:3011')
    captured = []
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, _): return b'{"business_id":1,"bookings":[]}'
    class Opener:
        def open(self, request, timeout):
            captured.append(request)
            return Response()
    monkeypatch.setattr('urllib.request.build_opener', lambda *args: Opener())
    client = AvaActionClient()
    client.post('/pms/lookup-booking', 1, {'business_id': 2, 'instanceId': 3, 'instance_id': 4})
    assert set(json.loads(captured[0].data).values()) == {1}
    with pytest.raises(AvaActionError):
        client.post('https://untrusted.example/', 1, {})


def test_transport_never_treats_business_failure_as_success(monkeypatch):
    monkeypatch.setenv('CRM_SERVICE_API_TOKEN', 'test-only-token')
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, _): return b'{"success":false,"error":"needs_approval"}'
    class Opener:
        def open(self, *args, **kwargs): return Response()
    monkeypatch.setattr('urllib.request.build_opener', lambda *args: Opener())
    with pytest.raises(AvaActionError) as error:
        AvaActionClient().post('/followup/send', 1, {})
    assert error.value.code == 'AVA_ACTION_REJECTED'
