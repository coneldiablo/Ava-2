import sqlite3
from copy import deepcopy
from uuid import UUID
import pytest

from src.core.onyx_agents_config import (
    separate_ava_prompts,
    build_hotel_sales_agent,
    build_hotel_manager_agent,
    build_revenue_agent,
)
from src.core.onyx_agent_runner import OnyxAgentRunner
from src.core.onyx_client import OnyxClientError, OnyxResponse
from src.core.onyx_db import init_onyx_tables
from src.core.onyx_mcp_bridge import OnyxExecutionScope, OnyxMcpBridge


def test_prompt_separation_logic():
    sample_prompts = [
        {"id": "p1", "name": "Hotel Sales", "taskType": "sales", "body": "..."},
        {"id": "p2", "name": "Hotel FAQ", "taskType": "faq", "body": "..."},
        {"id": "p3", "name": "Lead Qualification", "taskType": "qualification", "body": "..."},
        {"id": "p4", "name": "SIP Asterisk Gateway", "taskType": "sip_runtime", "body": "..."},
        {"id": "p5", "name": "VAD Threshold Monitor", "taskType": "vad_detection", "body": "..."},
        {"id": "p6", "name": "Security Guardrail", "taskType": "security_guardrail", "body": "..."},
    ]

    separated = separate_ava_prompts(sample_prompts)
    migratable = separated["migratable_to_onyx"]
    retained = separated["retained_in_ava"]

    assert len(migratable) == 3
    assert {p["id"] for p in migratable} == {"p1", "p2", "p3"}

    assert len(retained) == 3
    assert {p["id"] for p in retained} == {"p4", "p5", "p6"}


def test_agent_definitions_structure():
    sales_agent = build_hotel_sales_agent(business_id=1, hotel_name="Grand Hotel")
    assert sales_agent.agent_id == "ava:1:agent:sales"
    assert "get_customer" in sales_agent.allowed_tools
    assert "get_booking" in sales_agent.allowed_tools
    assert sales_agent.tenant_scoped is True

    mgr_agent = build_hotel_manager_agent(business_id=1, hotel_name="Grand Hotel")
    assert mgr_agent.agent_id == "ava:1:agent:manager"
    assert "get_sales" in mgr_agent.allowed_tools
    assert "get_campaigns" in mgr_agent.allowed_tools

    rev_agent = build_revenue_agent(business_id=1, hotel_name="Grand Hotel")
    assert rev_agent.agent_id == "ava:1:agent:revenue"
    assert "get_occupancy" in rev_agent.allowed_tools
    assert "get_rates" in rev_agent.allowed_tools


@pytest.fixture
def multi_tenant_db(tmp_path):
    db_file = str(tmp_path / "multi_tenant.db")
    conn = sqlite3.connect(db_file)
    cursor = conn.cursor()

    cursor.executescript("""
        CREATE TABLE instances (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            businessType TEXT DEFAULT 'hotel',
            isActive INTEGER DEFAULT 1
        );

        CREATE TABLE knowledge_base (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            instanceId INTEGER NOT NULL,
            filename TEXT NOT NULL,
            originalName TEXT NOT NULL,
            contentHash TEXT,
            mimeType TEXT DEFAULT 'text/plain',
            fileSize INTEGER DEFAULT 0,
            chunkCount INTEGER DEFAULT 0,
            hasEmbeddings INTEGER DEFAULT 0,
            version INTEGER DEFAULT 1,
            isCurrent INTEGER DEFAULT 1,
            createdAt TEXT DEFAULT '2026-08-31 01:00:00',
            FOREIGN KEY (instanceId) REFERENCES instances (id)
        );

        CREATE TABLE kb_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kbId INTEGER NOT NULL,
            chunkIndex INTEGER NOT NULL,
            text TEXT NOT NULL,
            section TEXT,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (kbId) REFERENCES knowledge_base (id)
        );
    """)

    # Hotel A (business_id = 1)
    cursor.execute("INSERT INTO instances (id, name) VALUES (1, 'Hotel Alpha')")
    cursor.execute("INSERT INTO knowledge_base (id, instanceId, filename, originalName, contentHash, chunkCount, isCurrent) VALUES (1, 1, 'alpha.txt', 'Правила Alpha', 'hash_a', 1, 1)")
    cursor.execute("INSERT INTO kb_chunks (kbId, chunkIndex, text) VALUES (1, 0, 'В Hotel Alpha бассейн работает с 06:00 до 22:00.')")

    # Hotel B (business_id = 2)
    cursor.execute("INSERT INTO instances (id, name) VALUES (2, 'Hotel Beta')")
    cursor.execute("INSERT INTO knowledge_base (id, instanceId, filename, originalName, contentHash, chunkCount, isCurrent) VALUES (2, 2, 'beta.txt', 'Секретные правила Beta', 'hash_b', 1, 1)")
    cursor.execute("INSERT INTO kb_chunks (kbId, chunkIndex, text) VALUES (2, 0, 'В Hotel Beta бассейн закрыт на реконструкцию.')")

    init_onyx_tables(conn)
    for business_id in (1, 2):
        conn.execute('''INSERT INTO onyx_tenant_links
            (business_id,onyx_tenant_id,onyx_base_url,credential_ref,cc_pair_id,status)
            VALUES (?,?,?,'ONYX_TEST_KEY',?,'STAGING')''',
            (business_id, f'hotel_{business_id}', 'https://onyx.example.test/api', business_id))
        conn.execute('''INSERT INTO onyx_agent_bindings
            (business_id,role,onyx_base_url,persona_id,document_set_id,document_set_name,model_configuration_id,search_tool_id)
            VALUES (?,'sales',?,?,?,?,1,1)''',
            (business_id, 'https://onyx.example.test/api', business_id, business_id, f'ava-hotel-{business_id}-knowledge'))
        conn.execute('''INSERT INTO onyx_document_links
            (business_id,entity_type,source_id,onyx_document_id,content_hash)
            VALUES (?,'knowledge',?,?,?)''',
            (business_id, business_id, f'ava:{business_id}:knowledge:{business_id}', f'hash_{"a" if business_id == 1 else "b"}'))
    conn.commit()
    conn.close()
    return db_file


class FakeOnyx:
    """Onyx HTTP contract stub; never searches local chunks or invents metrics."""
    def __init__(self, business_id, mutate=None, create_private=True, privacy=None, cleanup_error=False):
        self.business_id = business_id
        self.mutate = mutate
        self.create_private = create_private
        self.privacy = privacy
        self.cleanup_error = cleanup_error
        self.calls = []
        self.session_id = str(UUID(int=business_id))

    async def request(self, method, path, payload=None):
        self.calls.append((method, path, deepcopy(payload)))
        if path == '/chat/create-chat-session':
            return OnyxResponse(200, {'chat_session_id': self.session_id, 'incognito': self.create_private})
        if path == '/chat/send-chat-message':
            b = self.business_id
            result = {
                'incognito': True,
                'answer_citationless': 'Бассейн открыт.' if b == 1 else 'Бассейн закрыт.',
                'top_documents': [{'document_id': f'ava%3A{b}%3Aknowledge%3A{b}',
                    'semantic_identifier': 'Правила Alpha' if b == 1 else 'Секретные правила Beta',
                    'metadata': {'business_id': str(b), 'ava_entity_type': 'knowledge',
                                 'ava_content_hash': 'hash_a' if b == 1 else 'hash_b'}, 'is_internet': False}],
                'citation_info': [{'document_id': f'ava%3A{b}%3Aknowledge%3A{b}', 'citation_number': 1}],
            }
            if self.mutate:
                self.mutate(result)
            return OnyxResponse(200, result)
        if path == f'/chat/get-chat-session/{self.session_id}':
            return OnyxResponse(200, self.privacy)
        if path == f'/chat/stop-chat-session/{self.session_id}':
            return OnyxResponse(200, {'message': 'Chat session stopped'})
        assert path == f'/chat/end-incognito-session/{self.session_id}'
        if self.cleanup_error:
            raise OnyxClientError('secret provider response', code='ONYX_NETWORK_ERROR')
        return OnyxResponse(200, None)


def make_runner(db_path, fake):
    kwargs_seen = []
    def factory(**kwargs):
        kwargs_seen.append(kwargs)
        return fake
    return OnyxAgentRunner(db_path=db_path, client_factory=factory), kwargs_seen


def test_strict_tenant_isolation_during_agent_retrieval(multi_tenant_db):
    fake_a, fake_b = FakeOnyx(1), FakeOnyx(2)
    runner, seen = make_runner(multi_tenant_db, fake_a)

    # Query Hotel Alpha for pool
    res_a = runner.answer_query(business_id=1, query="бассейн", agent_role="sales", hotel_name="Hotel Alpha")
    assert res_a["grounded"] is True
    citation_titles_a = [c["title"] for c in res_a["citations"]]
    assert "Правила Alpha" in citation_titles_a
    assert "Секретные правила Beta" not in citation_titles_a

    # Query Hotel Beta for pool
    runner_b, _ = make_runner(multi_tenant_db, fake_b)
    res_b = runner_b.answer_query(business_id=2, query="бассейн", agent_role="sales", hotel_name="Hotel Beta")
    assert res_b["grounded"] is True
    citation_titles_b = [c["title"] for c in res_b["citations"]]
    assert "Секретные правила Beta" in citation_titles_b
    assert "Правила Alpha" not in citation_titles_b
    assert seen[0]['credential_ref'] == 'ONYX_TEST_KEY'
    assert seen[0]['cc_pair_id'] == 1
    payload_a, payload_b = fake_a.calls[1][2], fake_b.calls[1][2]
    assert payload_a['internal_search_filters']['document_set'] == ['ava-hotel-1-knowledge']
    assert payload_b['internal_search_filters']['document_set'] == ['ava-hotel-2-knowledge']
    assert payload_a['internal_search_filters']['tags'] == [{'tag_key': 'ava_entity_type', 'tag_value': 'knowledge'}]
    assert payload_a['forced_tool_id'] == 1 and payload_a['allowed_tool_ids'] == [1]
    assert res_a['execution_source'] == 'onyx_live'
    assert 'accuracy_score' not in res_a  # Citation presence is not semantic correctness.
    assert fake_a.calls[-1][1].endswith(fake_a.session_id)


def test_untrusted_hotel_and_customer_context_are_not_forwarded(multi_tenant_db):
    fake = FakeOnyx(1)
    runner, _ = make_runner(multi_tenant_db, fake)
    result = runner.answer_query(business_id=1, query='бассейн', hotel_name='Other hotel',
                                 customer_context={'history': 'private transcript', 'business_id': 2})
    assert result['hotel_name'] == 'Hotel Alpha'
    assert result['customer_context_used'] is False
    assert 'private transcript' not in str(fake.calls) and 'Other hotel' not in str(fake.calls)


def test_current_customer_snapshot_is_read_from_scoped_crm_not_model(multi_tenant_db):
    with sqlite3.connect(multi_tenant_db) as conn:
        conn.executescript('''
            CREATE TABLE clients(id INTEGER PRIMARY KEY,instanceId INTEGER,chatId TEXT,senderName TEXT,leadStatus TEXT,lastMessage TEXT);
            CREATE TABLE client_profiles(instanceId INTEGER,chatId TEXT,needs TEXT);
            INSERT INTO clients VALUES(101,1,'79990000001@c.us','Alpha Guest','qualified','RAW_ALPHA'),
                                      (202,2,'79990000001@c.us','Beta Guest','new','RAW_BETA');
            INSERT INTO client_profiles VALUES(1,'79990000001@c.us','ALPHA_NEEDS password=TOP_SECRET'),
                                              (2,'79990000001@c.us','BETA_NEEDS');
        ''')
    for business, customer, wanted, forbidden in [(1, 101, 'ALPHA_NEEDS', 'BETA_NEEDS'), (2, 202, 'BETA_NEEDS', 'ALPHA_NEEDS')]:
        fake = FakeOnyx(business)
        runner, _ = make_runner(multi_tenant_db, fake)
        result = runner.answer_query(business_id=business, query='бассейн', customer_id=customer,
                                     customer_context={'needs': 'MODEL_INJECTED_CONTEXT'})
        payload = fake.calls[1][2]
        assert wanted in payload['message'] and forbidden not in payload['message']
        assert all(secret not in str(fake.calls) for secret in ('RAW_ALPHA', 'RAW_BETA', 'TOP_SECRET', 'MODEL_INJECTED_CONTEXT'))
        assert payload['allowed_tool_ids'] == [1]
        assert 'additional_context' not in payload  # Native incognito discards it.
        assert result['customer_context_provided'] is True and result['customer_id'] == customer
        assert result['customer_context_used'] is None
        assert fake.calls[-1][1].startswith('/chat/end-incognito-session/')
    foreign = FakeOnyx(1)
    runner, _ = make_runner(multi_tenant_db, foreign)
    with pytest.raises(OnyxClientError, match='Customer not found'):
        runner.answer_query(business_id=1, query='бассейн', customer_id=202)
    assert not foreign.calls


@pytest.mark.parametrize('customer_id', [True, '101', 0, -1])
def test_invalid_customer_id_never_queries_onyx(multi_tenant_db, customer_id):
    fake = FakeOnyx(1)
    runner, _ = make_runner(multi_tenant_db, fake)
    with pytest.raises(OnyxClientError):
        runner.answer_query(business_id=1, query='бассейн', customer_id=customer_id)
    assert not fake.calls


@pytest.mark.asyncio
async def test_canceled_request_stops_remote_turn_before_private_cleanup(multi_tenant_db):
    import asyncio
    class SlowOnyx(FakeOnyx):
        async def request(self, method, path, payload=None):
            if path == '/chat/send-chat-message':
                self.calls.append((method, path, deepcopy(payload)))
                await asyncio.Event().wait()
            return await super().request(method, path, payload)
    fake = SlowOnyx(1)
    runner, seen = make_runner(multi_tenant_db, fake)
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(runner.answer_query_async(business_id=1, query='Заезд?'), timeout=0.02)
    assert fake.calls[-2][1] == f'/chat/stop-chat-session/{fake.session_id}'
    assert fake.calls[-1][1] == f'/chat/end-incognito-session/{fake.session_id}'
    assert seen[-1]['timeout_seconds'] == 2


@pytest.mark.asyncio
async def test_cancel_during_create_ends_late_private_session_without_sending(multi_tenant_db):
    import asyncio

    class SlowCreate(FakeOnyx):
        def __init__(self, business_id):
            super().__init__(business_id)
            self.entered = asyncio.Event()
            self.release = asyncio.Event()

        async def request(self, method, path, payload=None):
            if path == '/chat/create-chat-session':
                self.entered.set()
                await self.release.wait()
            return await super().request(method, path, payload)

    fake = SlowCreate(1)
    runner, seen = make_runner(multi_tenant_db, fake)
    pending = asyncio.create_task(runner.answer_query_async(business_id=1, query='Заезд?'))
    await fake.entered.wait()
    pending.cancel()
    await asyncio.sleep(0)  # Let the runner enter its cancelled-create cleanup.
    fake.release.set()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert [path for _, path, _ in fake.calls] == [
        '/chat/create-chat-session', f'/chat/end-incognito-session/{fake.session_id}',
    ]
    assert seen[-1]['timeout_seconds'] == 2


@pytest.mark.parametrize('business_id,role', [(True, 'sales'), ('1', 'sales'), (0, 'sales'), (3, 'sales'), (1, 'unknown'), (1, 'manager')])
def test_unprovisioned_or_invalid_scope_never_queries_onyx(multi_tenant_db, business_id, role):
    fake = FakeOnyx(1)
    runner, _ = make_runner(multi_tenant_db, fake)
    with pytest.raises(OnyxClientError):
        runner.answer_query(business_id=business_id, query='бассейн', agent_role=role)
    assert not fake.calls


@pytest.mark.parametrize('mutation', [
    "UPDATE instances SET isActive=0 WHERE id=1",
    "UPDATE onyx_tenant_links SET status='FALLBACK_LEGACY' WHERE business_id=1",
    "UPDATE onyx_agent_bindings SET onyx_base_url='https://other.test/api' WHERE business_id=1",
])
def test_inactive_or_changed_binding_never_queries_onyx(multi_tenant_db, mutation):
    with sqlite3.connect(multi_tenant_db) as conn:
        conn.execute(mutation)
    fake = FakeOnyx(1)
    runner, _ = make_runner(multi_tenant_db, fake)
    with pytest.raises(OnyxClientError):
        runner.answer_query(business_id=1, query='бассейн')
    assert not fake.calls


@pytest.mark.parametrize('field,value,code', [
    ('business_id', '2', 'ONYX_CROSS_TENANT_SOURCE'),
    ('business_id', ['1', '2'], 'ONYX_CROSS_TENANT_SOURCE'),
    ('ava_entity_type', 'customer_summary', 'ONYX_CROSS_TENANT_SOURCE'),
    ('ava_content_hash', 'older_revision', 'ONYX_STALE_SOURCE'),
])
def test_foreign_or_stale_source_rejects_whole_answer(multi_tenant_db, field, value, code):
    fake = FakeOnyx(1, mutate=lambda r: r['top_documents'][0]['metadata'].update({field: value}))
    runner, _ = make_runner(multi_tenant_db, fake)
    with pytest.raises(OnyxClientError) as error:
        runner.answer_query(business_id=1, query='бассейн')
    assert error.value.code == code
    assert fake.calls[-1][1].startswith('/chat/end-incognito-session/')


@pytest.mark.parametrize('mutation,code', [
    (lambda r: r['top_documents'][0].update({'is_internet': True}), 'ONYX_CROSS_TENANT_SOURCE'),
    (lambda r: r['citation_info'][0].update({'document_id': 'ava:2:knowledge:2'}), 'ONYX_UNVERIFIED_CITATION'),
    (lambda r: r.update({'top_documents': [None]}), 'ONYX_AGENT_INVALID_RESPONSE'),
    (lambda r: r.update({'citation_info': [None]}), 'ONYX_AGENT_INVALID_RESPONSE'),
    (lambda r: r.update({'answer_citationless': {'invalid': 'shape'}}), 'ONYX_AGENT_INVALID_RESPONSE'),
    (lambda r: r.update({'error_msg': 'private upstream secret'}), 'ONYX_AGENT_UPSTREAM_ERROR'),
])
def test_bad_onyx_responses_fail_closed_and_clean_up(multi_tenant_db, mutation, code):
    fake = FakeOnyx(1, mutate=mutation)
    runner, _ = make_runner(multi_tenant_db, fake)
    with pytest.raises(OnyxClientError) as error:
        runner.answer_query(business_id=1, query='бассейн')
    assert error.value.code == code
    assert 'private upstream secret' not in str(error.value)
    assert fake.calls[-1][1].startswith('/chat/end-incognito-session/')


@pytest.mark.parametrize('mutation,code', [
    ('UPDATE knowledge_base SET isCurrent=0 WHERE id=1', 'ONYX_RUNTIME_EMPTY'),
    ("UPDATE knowledge_base SET contentHash='new_hash' WHERE id=1", 'ONYX_RUNTIME_INDEXING'),
])
def test_deleted_or_updated_local_document_rejects_old_answer(multi_tenant_db, mutation, code):
    with sqlite3.connect(multi_tenant_db) as conn:
        conn.execute(mutation)
    fake = FakeOnyx(1)
    runner, _ = make_runner(multi_tenant_db, fake)
    with pytest.raises(OnyxClientError) as error:
        runner.answer_query(business_id=1, query='бассейн')
    assert error.value.code == code and not fake.calls


def test_incognito_refusal_does_not_send_question(multi_tenant_db):
    fake = FakeOnyx(1, create_private=False)
    runner, _ = make_runner(multi_tenant_db, fake)
    with pytest.raises(OnyxClientError) as error:
        runner.answer_query(business_id=1, query='private guest query')
    assert error.value.code == 'ONYX_INCOGNITO_REQUIRED'
    assert not any(path == '/chat/send-chat-message' for _, path, _ in fake.calls)
    assert fake.calls[-1][1].startswith('/chat/end-incognito-session/')


@pytest.mark.parametrize('privacy,accepted', [
    ({'incognito': True, 'persona_id': 1}, True),
    ({'incognito': False, 'persona_id': 1}, False),
    ({'incognito': True, 'persona_id': 2}, False),
    (None, False),
])
def test_onyx_v47_false_echo_requires_verified_private_session(multi_tenant_db, privacy, accepted):
    fake = FakeOnyx(1, mutate=lambda r: r.update({'incognito': False}), privacy=privacy)
    runner, _ = make_runner(multi_tenant_db, fake)
    if accepted:
        assert runner.answer_query(business_id=1, query='бассейн')['grounded']
    else:
        with pytest.raises(OnyxClientError) as error:
            runner.answer_query(business_id=1, query='бассейн')
        assert error.value.code == 'ONYX_INCOGNITO_REQUIRED'
    assert fake.calls[-1][1].startswith('/chat/end-incognito-session/')


def test_cleanup_error_is_safe_and_does_not_hide_primary_error(multi_tenant_db, caplog):
    fake = FakeOnyx(1, cleanup_error=True)
    runner, _ = make_runner(multi_tenant_db, fake)
    with pytest.raises(OnyxClientError) as error:
        runner.answer_query(business_id=1, query='private query')
    assert error.value.code == 'ONYX_PRIVATE_SESSION_CLEANUP_FAILED'
    fake.mutate = lambda r: r.update({'error_msg': 'failure'})
    with pytest.raises(OnyxClientError) as error:
        runner.answer_query(business_id=1, query='private query')
    assert error.value.code == 'ONYX_AGENT_UPSTREAM_ERROR'
    assert 'private query' not in caplog.text and 'secret provider' not in caplog.text


@pytest.mark.asyncio
async def test_async_runtime_uses_async_entrypoint(multi_tenant_db):
    runner, _ = make_runner(multi_tenant_db, FakeOnyx(1))
    with pytest.raises(RuntimeError, match='await answer_query_async'):
        runner.answer_query(business_id=1, query='бассейн')
    assert (await runner.answer_query_async(business_id=1, query='бассейн'))['grounded']


def test_mcp_scope_injected_outside_prompt_and_revoked(multi_tenant_db):
    bridge = OnyxMcpBridge(multi_tenant_db)
    bridge.issue_discovery_token()
    with sqlite3.connect(multi_tenant_db) as conn:
        conn.execute('''INSERT INTO onyx_mcp_tool_bindings
            (business_id,agent_role,onyx_base_url,mcp_server_id,tool_name,tool_id)
            VALUES (1,'sales','https://onyx.example.test/api',1,'get_hotel_info',8)''')
    fake = FakeOnyx(1)
    runner, _ = make_runner(multi_tenant_db, fake)
    result = runner.answer_query(business_id=1, query='Какой это отель?',
        execution_scope=OnyxExecutionScope(1,'sales','staging','request-1','operator'), forced_action='get_hotel_info')
    payload = fake.calls[1][2]
    token = payload['mcp_headers']['X-AVA-Execution']
    assert payload['allowed_tool_ids'] == [1,8]
    assert payload['forced_tool_id'] == 8
    assert token not in payload['message'] and token not in str(result)
    assert result['mcp_execution_scoped'] is True
    with sqlite3.connect(multi_tenant_db) as conn:
        assert conn.execute('SELECT revoked_at FROM onyx_mcp_execution_scopes').fetchone()[0] is not None


def test_cross_tenant_execution_scope_cannot_be_passed_to_runner(multi_tenant_db):
    fake = FakeOnyx(1)
    runner, _ = make_runner(multi_tenant_db, fake)
    with pytest.raises(OnyxClientError, match='scope mismatch'):
        runner.answer_query(business_id=1, query='Отель?', execution_scope=OnyxExecutionScope(2,'sales','staging','request-1','operator'))
    assert fake.calls == []


@pytest.mark.parametrize('mutation,code', [
    ('DELETE FROM knowledge_base WHERE id=1', 'ONYX_RUNTIME_EMPTY'),
    ("UPDATE knowledge_base SET contentHash='revision-2' WHERE id=1", 'ONYX_RUNTIME_INDEXING'),
    ("UPDATE onyx_agent_bindings SET persona_id=99 WHERE business_id=1", 'ONYX_AGENT_BINDING_STALE'),
    ("UPDATE onyx_tenant_links SET status='DISABLED' WHERE business_id=1", 'ONYX_AGENT_UNAVAILABLE'),
])
def test_revoke_or_update_during_provider_request_rejects_answer_and_stops(multi_tenant_db, mutation, code):
    def during_request(_result):
        with sqlite3.connect(multi_tenant_db) as conn:
            conn.execute(mutation)
    fake = FakeOnyx(1, mutate=during_request)
    runner, _ = make_runner(multi_tenant_db, fake)
    with pytest.raises(OnyxClientError) as error:
        runner.answer_query(business_id=1, query='бассейн')
    assert error.value.code == code
    assert fake.calls[-2][1] == f'/chat/stop-chat-session/{fake.session_id}'
    assert fake.calls[-1][1] == f'/chat/end-incognito-session/{fake.session_id}'


def test_provider_negative_answer_has_no_grounding_or_invented_sources(multi_tenant_db):
    fake = FakeOnyx(1, mutate=lambda result: result.update({
        'answer_citationless': 'В базе знаний нет данных об этом.', 'top_documents': [], 'citation_info': []}))
    runner, _ = make_runner(multi_tenant_db, fake)
    result = runner.answer_query(business_id=1, query='SYNTHETIC_UNKNOWN_POLICY')
    assert not result['grounded'] and not result['citations']
    assert result['recommended_next_step'] == 'clarify_or_manager_review'
    assert fake.calls[-1][1] == f'/chat/end-incognito-session/{fake.session_id}'


def test_observed_lifecycle_timings_include_private_cleanup(multi_tenant_db):
    import math
    fake = FakeOnyx(1)
    runner, _ = make_runner(multi_tenant_db, fake)
    result = runner.answer_query(business_id=1, query='бассейн')
    timings = result['timings']
    for key in ('session_create_ms', 'provider_request_ms', 'source_verification_ms', 'cleanup_ms', 'total_ms'):
        assert math.isfinite(timings[key]) and timings[key] >= 0
    assert timings['total_ms'] >= timings['provider_request_ms']
    assert all(timings[key] is None for key in ('queue_ms', 'retrieval_ms', 'model_ttft_ms'))
    assert fake.calls[-1][1] == f'/chat/end-incognito-session/{fake.session_id}'


@pytest.mark.asyncio
async def test_real_runtime_runner_returns_fixture_marker_and_scoped_source(multi_tenant_db):
    from src.core.onyx_db import compute_content_hash
    from src.core.onyx_knowledge_runtime import OnyxKnowledgeRuntime
    marker = 'SYNTHETIC_ALPHA_20260928_Q7'
    doc_hash = compute_content_hash(marker)
    with sqlite3.connect(multi_tenant_db) as conn:
        conn.execute('UPDATE kb_chunks SET text=? WHERE kbId=1', (marker,))
        conn.execute('UPDATE knowledge_base SET contentHash=? WHERE id=1', (doc_hash,))
        conn.execute('UPDATE onyx_document_links SET content_hash=? WHERE source_id=1', (doc_hash,))
    def fixture_answer(result):
        result['answer_citationless'] = marker
        result['top_documents'][0]['metadata']['ava_content_hash'] = doc_hash
    fake = FakeOnyx(1, mutate=fixture_answer)
    runtime = OnyxKnowledgeRuntime(multi_tenant_db, runner_factory=lambda **kwargs:
        OnyxAgentRunner(client_factory=lambda **_options: fake, **kwargs))
    result = await runtime.answer(business_id=1, question='Каков контрольный маркер?',
                                  channel='whatsapp', correlation_id='synthetic-marker', preview=True)
    assert result['handled'] and result['grounded'] and result['answer'] == marker
    assert result['citations'][0]['source_id'] == 1
    assert result['citations'][0]['external_id'] == 'ava:1:knowledge:1'
    assert result['timings']['runner']['total_ms'] >= 0
    assert fake.calls[-1][1] == f'/chat/end-incognito-session/{fake.session_id}'
    # The same runtime rejects the provider's source from the other business.
    def foreign(result):
        fixture_answer(result)
        result['top_documents'][0]['metadata']['business_id'] = '2'
    fake.mutate = foreign
    rejected = await runtime.answer(business_id=1, question='Каков контрольный маркер?',
        channel='whatsapp', correlation_id='synthetic-foreign', preview=True)
    assert rejected['error_code'] == 'ONYX_RUNTIME_SCOPE_MISMATCH'
    assert not rejected['handled'] and marker not in str(rejected)


@pytest.mark.asyncio
async def test_real_runtime_does_not_publish_provider_unsupported_answer(multi_tenant_db):
    from src.core.onyx_knowledge_runtime import OnyxKnowledgeRuntime
    fake = FakeOnyx(1, mutate=lambda result: result.update({
        'answer_citationless': 'SYNTHETIC_UNSUPPORTED', 'top_documents': [], 'citation_info': []}))
    runtime = OnyxKnowledgeRuntime(multi_tenant_db, runner_factory=lambda **kwargs:
        OnyxAgentRunner(client_factory=lambda **_options: fake, **kwargs))
    result = await runtime.answer(business_id=1, question='SYNTHETIC_UNKNOWN_POLICY',
                                  channel='whatsapp', correlation_id='synthetic-negative', preview=True)
    assert result['error_code'] == 'ONYX_RUNTIME_UNGROUNDED' and not result['handled']
    assert 'SYNTHETIC_UNSUPPORTED' not in str(result)
    assert fake.calls[-1][1] == f'/chat/end-incognito-session/{fake.session_id}'
