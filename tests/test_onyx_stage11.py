import os
import json
import sqlite3
import pytest
from datetime import datetime, timezone

from src.core.onyx_db import init_onyx_tables
from src.core.onyx_cutover_manager import OnyxCutoverManager


READINESS = {
    key: {"passed": True, "verified_at": "2026-09-05T12:00:00Z"}
    for key in (
        "backup_tested", "grounding_verified", "prompts_separated",
        "policy_gateway_enabled", "rollback_verified", "monitoring_active",
        "shadow_mode_completed", "data_audit_passed",
        "agent_tools_verified", "voice_route_verified", "whatsapp_route_verified",
    )
}


def seed_ready_tenant_link(db_path):
    conn = sqlite3.connect(db_path)
    init_onyx_tables(conn)
    conn.execute("""
        INSERT INTO onyx_tenant_links (
            business_id, onyx_tenant_id, onyx_base_url, credential_ref,
            cc_pair_id, onyx_version, readiness_json, status, last_health_at
        ) VALUES (1, 'hotel_1', 'https://onyx.example.test/api', 'ONYX_TEST_API_KEY',
                  17, 'v4.7.0', ?, 'STAGING', ?)
        ON CONFLICT(business_id) DO UPDATE SET
            onyx_base_url=excluded.onyx_base_url,
            credential_ref=excluded.credential_ref,
            cc_pair_id=excluded.cc_pair_id,
            onyx_version=excluded.onyx_version,
            readiness_json=excluded.readiness_json,
            status=excluded.status,
            last_health_at=excluded.last_health_at
    """, (json.dumps(READINESS), datetime.now(timezone.utc).isoformat()))
    for persona_id, role in enumerate(('sales', 'manager', 'revenue'), 1):
        conn.execute('''INSERT OR REPLACE INTO onyx_agent_bindings
            (business_id,role,onyx_base_url,persona_id,document_set_id,document_set_name,model_configuration_id,search_tool_id)
            VALUES (1,?,'https://onyx.example.test/api',?,1,'ava-hotel-1-knowledge',1,1)''', (role, persona_id))
    conn.commit()
    conn.close()


@pytest.fixture
def cutover_test_db(tmp_path):
    db_file = str(tmp_path / "test_cutover.db")
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
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (instanceId) REFERENCES instances (id)
        );

        CREATE TABLE manager_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            taskId TEXT UNIQUE NOT NULL,
            instanceId INTEGER NOT NULL,
            summary TEXT NOT NULL,
            priority TEXT DEFAULT 'normal',
            status TEXT DEFAULT 'new',
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(instanceId) REFERENCES instances(id)
        );
    """)

    cursor.execute("INSERT INTO instances (id, name) VALUES (1, 'Grand Hotel Alpha')")
    cursor.execute("""
        INSERT INTO knowledge_base (id, instanceId, filename, originalName, contentHash, chunkCount, isCurrent)
        VALUES (1, 1, 'info.txt', 'Информация', 'hash1', 1, 1)
    """)

    conn.commit()
    conn.close()

    return db_file


def test_go_no_go_criteria_success(cutover_test_db):
    seed_ready_tenant_link(cutover_test_db)
    # Seed synced document
    conn = sqlite3.connect(cutover_test_db)
    init_onyx_tables(conn)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO onyx_document_links (business_id, entity_type, source_id, onyx_document_id, content_hash)
        VALUES (1, 'knowledge', 1, 'ava:1:knowledge:1', 'hash1')
    """)
    conn.commit()
    conn.close()

    mgr = OnyxCutoverManager(db_path=cutover_test_db)
    res = mgr.check_go_no_go_criteria(business_id=1)

    assert res["decision"] == "GO"
    assert res["metrics"]["sync_completion_pct"] == 100.0
    assert res["checklist"]["version_pinned"] is True
    assert res["checklist"]["policy_gateway_enabled"] is True


@pytest.mark.parametrize('entity_type,source_id,content_hash', [
    ('customer_summary', 1, 'hash1'), ('knowledge', 999, 'hash1'), ('knowledge', 1, 'old_hash'),
])
def test_unrelated_or_stale_projection_cannot_satisfy_knowledge_gate(cutover_test_db, entity_type, source_id, content_hash):
    seed_ready_tenant_link(cutover_test_db)
    with sqlite3.connect(cutover_test_db) as conn:
        conn.execute('''INSERT INTO onyx_document_links
            (business_id,entity_type,source_id,onyx_document_id,content_hash) VALUES (1,?,?,?,?)''',
            (entity_type, source_id, f'ava:1:{entity_type}:{source_id}', content_hash))
    result = OnyxCutoverManager(db_path=cutover_test_db).check_go_no_go_criteria(1)
    assert result['decision'] == 'NO-GO'
    assert result['metrics']['synced_documents'] == 0
    assert not result['checklist']['knowledge_base_ingested']


def test_empty_business_and_missing_agents_are_not_ready(cutover_test_db):
    seed_ready_tenant_link(cutover_test_db)
    with sqlite3.connect(cutover_test_db) as conn:
        conn.execute('DELETE FROM knowledge_base')
        conn.execute('DELETE FROM onyx_agent_bindings')
    result = OnyxCutoverManager(db_path=cutover_test_db).check_go_no_go_criteria(1)
    assert not result['checklist']['knowledge_base_ingested']
    assert not result['checklist']['agents_provisioned']
    assert result['decision'] == 'NO-GO'


def test_unverified_routes_and_string_false_never_pass(cutover_test_db):
    seed_ready_tenant_link(cutover_test_db)
    evidence = dict(READINESS)
    evidence.pop('voice_route_verified')
    evidence['whatsapp_route_verified'] = 'false'
    evidence['agent_tools_verified'] = {'passed': 'false'}
    with sqlite3.connect(cutover_test_db) as conn:
        conn.execute('UPDATE onyx_tenant_links SET readiness_json=?', (json.dumps(evidence),))
    result = OnyxCutoverManager(db_path=cutover_test_db).check_go_no_go_criteria(1)
    assert not result['checklist']['voice_route_verified']
    assert not result['checklist']['whatsapp_route_verified']
    assert not result['checklist']['agent_tools_verified']


def test_enable_live_cutover_and_rollback(cutover_test_db):
    seed_ready_tenant_link(cutover_test_db)
    conn = sqlite3.connect(cutover_test_db)
    init_onyx_tables(conn)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO onyx_document_links (business_id, entity_type, source_id, onyx_document_id, content_hash)
        VALUES (1, 'knowledge', 1, 'ava:1:knowledge:1', 'hash1')
    """)
    conn.commit()
    conn.close()

    mgr = OnyxCutoverManager(db_path=cutover_test_db)

    # 1. Enable Cutover
    cutover_res = mgr.enable_live_cutover(business_id=1, hotel_name="Grand Hotel Alpha")
    assert cutover_res["success"] is True
    assert cutover_res["status"] == "ACTIVE_LIVE"
    assert cutover_res["use_onyx_ai"] is True

    # Verify DB state
    conn = sqlite3.connect(cutover_test_db)
    cursor = conn.cursor()
    cursor.execute("SELECT status FROM onyx_tenant_links WHERE business_id = 1")
    assert cursor.fetchone()[0] == "ACTIVE_LIVE"

    # 2. Instant Emergency Rollback
    rollback_res = mgr.execute_instant_rollback(business_id=1, reason="Network anomaly test")
    assert rollback_res["success"] is True
    assert rollback_res["status"] == "FALLBACK_LEGACY"
    assert rollback_res["use_onyx_ai"] is False

    cursor.execute("SELECT status FROM onyx_tenant_links WHERE business_id = 1")
    assert cursor.fetchone()[0] == "FALLBACK_LEGACY"

    # Verify audit log entry
    cursor.execute("SELECT action, status FROM onyx_action_audit WHERE business_id = 1 AND action = 'execute_rollback'")
    audit_row = cursor.fetchone()
    assert audit_row is not None
    assert audit_row[1] == "EXECUTED"
    conn.close()


def test_cutover_blocks_on_dead_letters(cutover_test_db):
    seed_ready_tenant_link(cutover_test_db)
    conn = sqlite3.connect(cutover_test_db)
    init_onyx_tables(conn)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO onyx_sync_outbox (event_id, business_id, entity_type, source_id, operation, payload_json, status, attempts)
        VALUES ('ev_dl_1', 1, 'knowledge', 1, 'UPSERT', '{}', 'DEAD_LETTER', 7)
    """)
    conn.commit()
    conn.close()

    mgr = OnyxCutoverManager(db_path=cutover_test_db)
    res = mgr.check_go_no_go_criteria(business_id=1)
    assert res["decision"] == "NO-GO"
    assert res["metrics"]["outbox_dead_letters"] == 1

    cutover_res = mgr.enable_live_cutover(business_id=1)
    assert cutover_res["success"] is False
    assert cutover_res["status"] == "CUTOVER_BLOCKED"


def test_cutover_blocks_unlinked_tenant_even_when_documents_are_synced(cutover_test_db):
    conn = sqlite3.connect(cutover_test_db)
    init_onyx_tables(conn)
    conn.execute("""
        INSERT INTO onyx_document_links (business_id, entity_type, source_id, onyx_document_id, content_hash)
        VALUES (1, 'knowledge', 1, 'ava:1:knowledge:1', 'hash1')
    """)
    conn.commit()
    conn.close()

    result = OnyxCutoverManager(db_path=cutover_test_db).check_go_no_go_criteria(1)
    assert result["decision"] == "NO-GO"
    assert result["checklist"]["tenant_link_ready"] is False
    assert result["checklist"]["connector_verified"] is False
