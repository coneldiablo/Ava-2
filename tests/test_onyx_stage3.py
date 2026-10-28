import os
import json
import sqlite3
import pytest
from datetime import datetime, timedelta

from src.core.onyx_db import init_onyx_tables, compute_content_hash, generate_stable_external_id
from src.core.onyx_connector import AVAOnyxConnector
from src.core.onyx_outbox_worker import OnyxOutboxWorker, RETRY_SCHEDULE_SECONDS, MAX_RETRIES
from src.core.onyx_resilience import OnyxCircuitBreaker


@pytest.fixture
def test_db(tmp_path):
    db_file = str(tmp_path / "test_crm.db")
    conn = sqlite3.connect(db_file)
    cursor = conn.cursor()

    # Create instances and knowledge_base tables matching CRM schema
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

    # Seed instance
    cursor.execute("INSERT INTO instances (id, name, businessType) VALUES (1, 'Grand Hotel', 'hotel')")

    # Seed doc 1 (with chunks)
    cursor.execute("""
        INSERT INTO knowledge_base (id, instanceId, filename, originalName, contentHash, chunkCount, isCurrent, createdAt)
        VALUES (101, 1, 'hotel_policy.txt', 'Правила отеля', 'hash_101', 2, 1, '2026-08-31 01:00:00')
    """)
    cursor.execute("INSERT INTO kb_chunks (kbId, chunkIndex, text) VALUES (101, 0, 'Заезд с 14:00, выезд до 12:00.')")
    cursor.execute("INSERT INTO kb_chunks (kbId, chunkIndex, text) VALUES (101, 1, 'Завтрак включен в стоимость проживания.')")

    # Seed doc 2 (without chunks, uses originalName)
    cursor.execute("""
        INSERT INTO knowledge_base (id, instanceId, filename, originalName, contentHash, chunkCount, isCurrent, createdAt)
        VALUES (102, 1, 'spa_menu.pdf', 'СПА меню', 'hash_102', 0, 1, '2026-08-31 02:00:00')
    """)

    conn.commit()
    conn.close()

    return db_file


def test_onyx_connector_load_and_mapping(test_db):
    connector = AVAOnyxConnector(db_path=test_db)
    docs = connector.load(business_id=1)

    assert len(docs) == 2

    doc1 = next(d for d in docs if d["external_id"] == "ava:1:knowledge:101")
    assert doc1["tenant_id"] == "hotel_1"
    assert doc1["title"] == "Правила отеля"
    assert "Заезд с 14:00" in doc1["content"]
    assert "Завтрак включен" in doc1["content"]
    assert doc1["content_hash"] == "hash_101"
    assert doc1["metadata"]["business_id"] == 1
    assert doc1["metadata"]["source"] == "ava_knowledge_base"
    assert doc1["permissions"]["access_type"] == "tenant_private"


def test_onyx_connector_poll_and_slim(test_db):
    connector = AVAOnyxConnector(db_path=test_db)

    # Poll documents created >= 01:30:00 (should return only doc 102)
    poll_docs = connector.poll(business_id=1, since_timestamp="2026-08-31 01:30:00")
    assert len(poll_docs) == 1
    assert poll_docs[0]["external_id"] == "ava:1:knowledge:102"

    # Slim load returns lightweight hash tuples
    slim_docs = connector.slim(business_id=1)
    assert len(slim_docs) == 2
    assert slim_docs[0]["external_id"] == "ava:1:knowledge:101"
    assert slim_docs[0]["content_hash"] == "hash_101"


@pytest.mark.asyncio
async def test_outbox_enqueue_and_process(test_db):
    worker = OnyxOutboxWorker(db_path=test_db)

    # 1. Enqueue event
    event_id = worker.enqueue_event(
        business_id=1,
        entity_type="knowledge",
        source_id=101,
        operation="UPSERT",
        payload={"title": "Правила отеля", "content_hash": "hash_101"}
    )
    assert event_id is not None

    # 2. Lease event
    leased = worker.lease_events(limit=5)
    assert len(leased) == 1
    assert leased[0]["event_id"] == event_id

    # 3. Process event successfully
    called = False
    async def mock_sync(event):
        nonlocal called
        called = True
        return {"status": "ok", "document_id": "ava:1:knowledge:101"}

    success = await worker.process_single_event(leased[0], sync_sender_func=mock_sync)
    assert success is True
    assert called is True

    # 4. Verify document link created
    conn = sqlite3.connect(test_db)
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM onyx_document_links WHERE business_id = 1 AND source_id = 101")
    link = cursor.fetchone()
    assert link is not None
    assert link[4] == "ava:1:knowledge:101" # onyx_document_id

    # 5. Verify Idempotency on second run with identical hash
    event_id2 = worker.enqueue_event(
        business_id=1,
        entity_type="knowledge",
        source_id=101,
        operation="UPSERT",
        payload={"title": "Правила отеля", "content_hash": "hash_101"}
    )
    leased2 = worker.lease_events(limit=5)
    called2 = False
    async def should_not_call(event):
        nonlocal called2
        called2 = True
        return {"status": "ok", "document_id": "ava:1:knowledge:101"}

    success2 = await worker.process_single_event(leased2[0], sync_sender_func=should_not_call)
    assert success2 is True
    assert called2 is False # Skipped network call because identical hash is already synced!
    conn.close()


@pytest.mark.asyncio
async def test_outbox_exponential_retry_and_dead_letter(test_db):
    worker = OnyxOutboxWorker(db_path=test_db)

    event_id = worker.enqueue_event(
        business_id=1,
        entity_type="knowledge",
        source_id=999,
        operation="UPSERT",
        payload={"content_hash": "err_hash"}
    )

    async def failing_sender(event):
        raise ConnectionError("Onyx network error")

    # Simulate retries 1 to 6
    for attempt in range(MAX_RETRIES):
        # Force next_attempt_at to past so it can be leased
        conn = sqlite3.connect(test_db)
        cursor = conn.cursor()
        cursor.execute("UPDATE onyx_sync_outbox SET next_attempt_at = '2020-01-01 00:00:00' WHERE event_id = ?", (event_id,))
        conn.commit()
        conn.close()

        leased = worker.lease_events(limit=5)
        assert len(leased) == 1
        res = await worker.process_single_event(leased[0], sync_sender_func=failing_sender)
        assert res is False

    # After MAX_RETRIES (6 attempts), next attempt transitions to DEAD_LETTER
    conn = sqlite3.connect(test_db)
    cursor = conn.cursor()
    cursor.execute("UPDATE onyx_sync_outbox SET next_attempt_at = '2020-01-01 00:00:00' WHERE event_id = ?", (event_id,))
    conn.commit()
    conn.close()

    leased = worker.lease_events(limit=5)
    assert len(leased) == 1
    res_final = await worker.process_single_event(leased[0], sync_sender_func=failing_sender)
    assert res_final is False

    conn = sqlite3.connect(test_db)
    cursor = conn.cursor()
    cursor.execute("SELECT status, attempts FROM onyx_sync_outbox WHERE event_id = ?", (event_id,))
    row = cursor.fetchone()
    assert row[0] == "DEAD_LETTER"
    assert row[1] == MAX_RETRIES + 1
    conn.close()
