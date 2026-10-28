import os
import json
import sqlite3
import pytest

from src.core.onyx_db import init_onyx_tables
from src.core.onyx_migration_runner import OnyxKnowledgeMigrator
from src.core.onyx_outbox_worker import OnyxOutboxWorker


@pytest.fixture
def migration_test_db(tmp_path):
    db_file = str(tmp_path / "test_migration_crm.db")
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

    # Seed instance
    cursor.execute("INSERT INTO instances (id, name, businessType) VALUES (1, 'Grand Hotel Test', 'hotel')")

    # Seed valid doc 1
    cursor.execute("""
        INSERT INTO knowledge_base (id, instanceId, filename, originalName, contentHash, chunkCount, isCurrent)
        VALUES (1, 1, 'checkin.txt', 'Правила заезда', 'hash_valid_1', 1, 1)
    """)
    cursor.execute("INSERT INTO kb_chunks (kbId, chunkIndex, text) VALUES (1, 0, 'Заезд в 14:00.')")

    # Seed valid doc 2
    cursor.execute("""
        INSERT INTO knowledge_base (id, instanceId, filename, originalName, contentHash, chunkCount, isCurrent)
        VALUES (2, 1, 'checkout.txt', 'Правила выезда', 'hash_valid_2', 1, 1)
    """)
    cursor.execute("INSERT INTO kb_chunks (kbId, chunkIndex, text) VALUES (2, 0, 'Выезд в 12:00.')")

    # Seed duplicate filename doc (same originalName as doc 2)
    cursor.execute("""
        INSERT INTO knowledge_base (id, instanceId, filename, originalName, contentHash, chunkCount, isCurrent)
        VALUES (3, 1, 'checkout_dup.txt', 'Правила выезда', 'hash_valid_2_dup', 1, 1)
    """)
    cursor.execute("INSERT INTO kb_chunks (kbId, chunkIndex, text) VALUES (3, 0, 'Выезд в 12:00.')")

    # Seed empty doc
    cursor.execute("""
        INSERT INTO knowledge_base (id, instanceId, filename, originalName, contentHash, chunkCount, isCurrent)
        VALUES (4, 1, 'empty.txt', '', '', 0, 1)
    """)

    conn.commit()
    conn.close()

    return db_file


def test_migration_dry_run_audit(migration_test_db):
    migrator = OnyxKnowledgeMigrator(db_path=migration_test_db)
    report = migrator.run_migration(business_id=1, dry_run=True)

    assert report["business_id"] == 1
    assert report["tenant"] == "hotel_1"
    assert report["dry_run"] is True
    assert report["counts"]["source_count"] == 4
    assert report["counts"]["imported_count"] == 3
    assert report["counts"]["rejected_count"] == 1
    assert report["counts"]["duplicates_count"] == 1
    assert len(report["rejected_details"]) == 1
    assert "Empty document body" in report["rejected_details"][0]["reason"]
    assert report["status"] == "WARN"

    cli_output = migrator.format_cli_report(report)
    assert "AVA ➔ ONYX KNOWLEDGE BASE MIGRATION REPORT" in cli_output
    assert "MIG-" in cli_output


@pytest.mark.asyncio
async def test_migration_live_run_and_subsequent_skip(migration_test_db):
    migrator = OnyxKnowledgeMigrator(db_path=migration_test_db)
    worker = OnyxOutboxWorker(db_path=migration_test_db)

    # 1. Live Run Migration
    report1 = migrator.run_migration(business_id=1, dry_run=False)
    assert report1["dry_run"] is False
    assert report1["counts"]["imported_count"] == 3

    # 2. Process outbox events
    leased = worker.lease_events(limit=10)
    assert len(leased) == 3
    async def onyx_ingestion_stub(event):
        return {
            "status": "ok",
            "document_id": f"ava:{event['business_id']}:{event['entity_type']}:{event['source_id']}",
        }
    for ev in leased:
        await worker.process_single_event(ev, sync_sender_func=onyx_ingestion_stub)

    # 3. Second run should detect all as skipped (identical hashes)
    report2 = migrator.run_migration(business_id=1, dry_run=True)
    assert report2["counts"]["imported_count"] == 0
    assert report2["counts"]["skipped_count"] == 3
    assert report2["counts"]["rejected_count"] == 1


def test_migration_orphan_instance_fails(migration_test_db):
    migrator = OnyxKnowledgeMigrator(db_path=migration_test_db)
    # Business ID 999 does not exist
    report = migrator.run_migration(business_id=999, dry_run=True)
    assert report["status"] == "FAIL"
    assert report["counts"]["orphan_count"] == 1
    assert "not found in instances table" in report["error_details"][0]
