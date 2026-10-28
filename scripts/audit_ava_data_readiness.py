#!/usr/bin/env python3
"""
AVA -> Onyx Migration: Stage 0 Data Readiness Audit Tool
Verifies database integrity, tenant mapping, knowledge base consistency,
and checks for orphans, duplicates, or empty content before migration.
"""

import os
import sys
import json
import sqlite3
from datetime import datetime
from typing import Dict, Any, List

DEFAULT_DB_PATH = os.path.join(os.path.dirname(__file__), "..", "whatsapp_crm", "crm_v2.db")


def run_audit(db_path: str) -> Dict[str, Any]:
    if not os.path.exists(db_path):
        return {
            "status": "ERROR",
            "error": f"Database file not found at: {db_path}",
            "timestamp": datetime.utcnow().isoformat() + "Z"
        }

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    report: Dict[str, Any] = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "database_path": os.path.abspath(db_path),
        "checks": {},
        "summary": {
            "instances_count": 0,
            "knowledge_base_docs": 0,
            "kb_chunks_count": 0,
            "clients_count": 0,
            "prompt_templates_count": 0,
            "issues_found": 0,
            "ready_for_stage1": True
        }
    }

    # 1. Check instances (tenants)
    try:
        cursor.execute("SELECT id, name, businessType, isActive FROM instances")
        instances = [dict(row) for row in cursor.fetchall()]
        report["checks"]["instances"] = {
            "count": len(instances),
            "items": instances
        }
        report["summary"]["instances_count"] = len(instances)
    except Exception as e:
        report["checks"]["instances"] = {"error": str(e)}

    # 2. Knowledge Base docs grouped by instanceId (business_id)
    try:
        cursor.execute("""
            SELECT instanceId, COUNT(*) as doc_count, SUM(chunkCount) as total_chunks, SUM(fileSize) as total_bytes
            FROM knowledge_base
            GROUP BY instanceId
        """)
        kb_by_instance = [dict(row) for row in cursor.fetchall()]
        cursor.execute("SELECT COUNT(*) FROM knowledge_base")
        total_kb = cursor.fetchone()[0]
        report["checks"]["knowledge_base"] = {
            "total_documents": total_kb,
            "by_instance": kb_by_instance
        }
        report["summary"]["knowledge_base_docs"] = total_kb
    except Exception as e:
        report["checks"]["knowledge_base"] = {"error": str(e)}

    # 3. Orphan knowledge base records (instanceId not in instances)
    try:
        cursor.execute("""
            SELECT k.id, k.instanceId, k.originalName
            FROM knowledge_base k
            LEFT JOIN instances i ON i.id = k.instanceId
            WHERE i.id IS NULL
        """)
        orphans = [dict(row) for row in cursor.fetchall()]
        report["checks"]["orphan_knowledge_base"] = {
            "count": len(orphans),
            "items": orphans
        }
        if orphans:
            report["summary"]["issues_found"] += len(orphans)
            report["summary"]["ready_for_stage1"] = False
    except Exception as e:
        report["checks"]["orphan_knowledge_base"] = {"error": str(e)}

    # 4. Duplicate knowledge base documents (instanceId, originalName)
    try:
        cursor.execute("""
            SELECT instanceId, originalName, COUNT(*) as cnt
            FROM knowledge_base
            GROUP BY instanceId, originalName
            HAVING COUNT(*) > 1
        """)
        duplicates = [dict(row) for row in cursor.fetchall()]
        report["checks"]["duplicate_knowledge_base"] = {
            "count": len(duplicates),
            "items": duplicates
        }
        if duplicates:
            report["summary"]["issues_found"] += len(duplicates)
    except Exception as e:
        report["checks"]["duplicate_knowledge_base"] = {"error": str(e)}

    # 5. Empty knowledge base documents
    try:
        cursor.execute("""
            SELECT id, instanceId, originalName, fileSize, chunkCount
            FROM knowledge_base
            WHERE fileSize = 0 OR chunkCount = 0 OR contentHash IS NULL
        """)
        empty_docs = [dict(row) for row in cursor.fetchall()]
        report["checks"]["empty_knowledge_base"] = {
            "count": len(empty_docs),
            "items": empty_docs
        }
        if empty_docs:
            report["summary"]["issues_found"] += len(empty_docs)
    except Exception as e:
        report["checks"]["empty_knowledge_base"] = {"error": str(e)}

    # 6. Total kb_chunks count
    try:
        cursor.execute("SELECT COUNT(*) FROM kb_chunks")
        report["summary"]["kb_chunks_count"] = cursor.fetchone()[0]
    except Exception as e:
        report["summary"]["kb_chunks_count"] = f"Error: {e}"

    # 7. Clients count by instance
    try:
        cursor.execute("SELECT instanceId, COUNT(*) as client_count FROM clients GROUP BY instanceId")
        clients_by_instance = [dict(row) for row in cursor.fetchall()]
        cursor.execute("SELECT COUNT(*) FROM clients")
        total_clients = cursor.fetchone()[0]
        report["checks"]["clients"] = {
            "total_clients": total_clients,
            "by_instance": clients_by_instance
        }
        report["summary"]["clients_count"] = total_clients
    except Exception as e:
        report["checks"]["clients"] = {"error": str(e)}

    # 8. Prompt templates
    try:
        cursor.execute("SELECT id, name, taskType, channel, version, status FROM prompt_templates")
        prompts = [dict(row) for row in cursor.fetchall()]
        report["checks"]["prompt_templates"] = {
            "total_prompts": len(prompts),
            "items": prompts
        }
        report["summary"]["prompt_templates_count"] = len(prompts)
    except Exception as e:
        report["checks"]["prompt_templates"] = {"error": str(e)}

    # 9. Verify integration tables readiness (check if migration tables exist or need to be created in Stage 2)
    migration_tables = ["onyx_tenant_links", "onyx_document_links", "onyx_sync_outbox", "onyx_action_audit"]
    existing_tables = []
    for table in migration_tables:
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,))
        if cursor.fetchone():
            existing_tables.append(table)

    report["checks"]["migration_tables"] = {
        "expected": migration_tables,
        "existing": existing_tables,
        "pending_stage2": [t for t in migration_tables if t not in existing_tables]
    }

    conn.close()
    return report


def main():
    db_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DB_PATH
    print(f"==================================================")
    print(f"   AVA -> ONYX STAGE 0: DATA READINESS AUDIT")
    print(f"==================================================")
    print(f"Scanning SQLite DB: {db_path}\n")

    report = run_audit(db_path)

    if "error" in report:
        print(f"[ERROR] {report['error']}")
        sys.exit(1)

    summary = report["summary"]
    print(f"Audit Summary:")
    print(f" - Instances (Tenants):    {summary['instances_count']}")
    print(f" - Knowledge Base Docs:    {summary['knowledge_base_docs']}")
    print(f" - KB Chunks:              {summary['kb_chunks_count']}")
    print(f" - Clients (Context):      {summary['clients_count']}")
    print(f" - Prompt Templates:       {summary['prompt_templates_count']}")
    print(f" - Data Issues Found:      {summary['issues_found']}")
    print(f" - Ready for Stage 1:      {'YES (PASS)' if summary['ready_for_stage1'] else 'NO (FAIL)'}")
    print(f" - Stage 2 Tables Pending: {report['checks']['migration_tables']['pending_stage2']}")

    print("\nDetailed Report (JSON):")
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
