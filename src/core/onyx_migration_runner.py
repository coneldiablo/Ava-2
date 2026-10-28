"""
AVA ↔ Onyx Knowledge Base Migration Runner (Stage 4)
Orchestrates knowledge migration from AVA to Onyx, validates document integrity,
generates Dry Run reports, and coordinates the ingestion pipeline.
"""

import os
import json
import time
import uuid
import logging
from datetime import datetime
from typing import Dict, Any, List, Optional

from src.core.onyx_db import (
    get_db_connection,
    init_onyx_tables,
    compute_content_hash,
    generate_stable_external_id,
)
from src.core.onyx_connector import AVAOnyxConnector
from src.core.onyx_outbox_worker import OnyxOutboxWorker

logger = logging.getLogger("ava.onyx.migration")


class OnyxKnowledgeMigrator:
    """
    Handles knowledge base validation, dry-run simulation, and live migration runs.
    """

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path
        self.connector = AVAOnyxConnector(db_path=db_path)
        self.outbox_worker = OnyxOutboxWorker(db_path=db_path)
        with get_db_connection(self.db_path) as conn:
            init_onyx_tables(conn)

    def run_migration(
        self,
        business_id: int,
        dry_run: bool = True
    ) -> Dict[str, Any]:
        """
        Execute knowledge migration for a given business_id / tenant.
        When dry_run=True, simulates ingestion and generates detailed audit metrics.
        When dry_run=False, writes to outbox and document link tables.
        """
        start_time = time.time()
        migration_id = f"MIG-{datetime.utcnow().strftime('%Y%m%d')}-{str(uuid.uuid4())[:8]}"
        tenant_id = f"hotel_{business_id}"

        report: Dict[str, Any] = {
            "migration_id": migration_id,
            "business_id": business_id,
            "tenant": tenant_id,
            "dry_run": dry_run,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "counts": {
                "source_count": 0,
                "imported_count": 0,
                "updated_count": 0,
                "skipped_count": 0,
                "rejected_count": 0,
                "duplicates_count": 0,
                "orphan_count": 0,
                "hash_mismatches": 0,
                "errors_count": 0,
            },
            "rejected_details": [],
            "duplicate_details": [],
            "error_details": [],
            "documents_summary": [],
            "processing_time_sec": 0.0,
            "status": "PASS"
        }

        # 1. Check for Orphan instances
        with get_db_connection(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id, name FROM instances WHERE id = ?", (business_id,))
            instance = cursor.fetchone()
            if not instance:
                report["counts"]["orphan_count"] = 1
                report["counts"]["errors_count"] += 1
                report["error_details"].append(f"Business ID {business_id} not found in instances table.")
                report["status"] = "FAIL"
                report["processing_time_sec"] = round(time.time() - start_time, 3)
                return report

            # Check for duplicate filenames within the instance
            cursor.execute("""
                SELECT originalName, COUNT(*) as cnt
                FROM knowledge_base
                WHERE instanceId = ? AND isCurrent = 1
                GROUP BY originalName
                HAVING COUNT(*) > 1
            """, (business_id,))
            dupes = cursor.fetchall()
            for d in dupes:
                report["counts"]["duplicates_count"] += (d["cnt"] - 1)
                report["duplicate_details"].append({
                    "filename": d["originalName"],
                    "occurrences": d["cnt"]
                })

        # 2. Extract documents via AVAOnyxConnector
        try:
            raw_docs = self.connector.load(business_id=business_id)
        except Exception as e:
            report["counts"]["errors_count"] += 1
            report["error_details"].append(f"Connector extraction failed: {str(e)}")
            report["status"] = "FAIL"
            report["processing_time_sec"] = round(time.time() - start_time, 3)
            return report

        report["counts"]["source_count"] = len(raw_docs)

        # 3. Validate and process each document
        with get_db_connection(self.db_path) as conn:
            cursor = conn.cursor()

            for doc in raw_docs:
                doc_id = doc["metadata"]["source_id"]
                title = doc.get("title", "")
                content = (doc.get("content") or "").strip()
                content_hash = doc.get("content_hash") or compute_content_hash(content)
                external_id = doc.get("external_id")

                # Validation checks (rejection criteria)
                if not content or len(content) == 0:
                    report["counts"]["rejected_count"] += 1
                    report["rejected_details"].append({
                        "id": doc_id,
                        "title": title,
                        "reason": "Empty document body"
                    })
                    continue

                if not external_id or not external_id.startswith(f"ava:{business_id}:knowledge:"):
                    report["counts"]["rejected_count"] += 1
                    report["rejected_details"].append({
                        "id": doc_id,
                        "title": title,
                        "reason": f"Invalid external_id structure: {external_id}"
                    })
                    continue

                # Check existing sync link
                cursor.execute("""
                    SELECT onyx_document_id, content_hash
                    FROM onyx_document_links
                    WHERE business_id = ? AND entity_type = 'knowledge' AND source_id = ?
                """, (business_id, doc_id))
                existing_link = cursor.fetchone()

                action = "IMPORT"
                if existing_link:
                    if existing_link["content_hash"] == content_hash:
                        report["counts"]["skipped_count"] += 1
                        action = "SKIP (UP_TO_DATE)"
                    else:
                        report["counts"]["updated_count"] += 1
                        report["counts"]["hash_mismatches"] += 1
                        action = "UPDATE (CONTENT_CHANGED)"
                else:
                    report["counts"]["imported_count"] += 1
                    action = "IMPORT (NEW)"

                report["documents_summary"].append({
                    "id": doc_id,
                    "external_id": external_id,
                    "title": title,
                    "action": action,
                    "content_length": len(content),
                    "hash": content_hash[:12] + "..."
                })

                # If live run and document requires update/import, enqueue to Outbox
                if not dry_run and action.startswith(("IMPORT", "UPDATE")):
                    self.outbox_worker.enqueue_event(
                        business_id=business_id,
                        entity_type="knowledge",
                        source_id=doc_id,
                        operation="UPSERT",
                        payload={
                            "external_id": external_id,
                            "tenant_id": tenant_id,
                            "title": title,
                            "content": content,
                            "content_hash": content_hash,
                            "metadata": doc["metadata"],
                            "permissions": doc["permissions"]
                        }
                    )

        # 4. Final Status Evaluation
        if report["counts"]["errors_count"] > 0 or report["counts"]["rejected_count"] > 0:
            report["status"] = "WARN" if report["counts"]["errors_count"] == 0 else "FAIL"

        report["processing_time_sec"] = round(time.time() - start_time, 3)
        return report

    def format_cli_report(self, report: Dict[str, Any]) -> str:
        """Render a formatted human-readable Dry Run / Migration report."""
        counts = report["counts"]
        lines = [
            "==================================================",
            f"   AVA ➔ ONYX KNOWLEDGE BASE MIGRATION REPORT",
            "==================================================",
            f"Migration ID:      {report['migration_id']}",
            f"Tenant:            {report['tenant']} (Business ID: {report['business_id']})",
            f"Mode:              {'DRY RUN (Simulation)' if report['dry_run'] else 'LIVE INGESTION'}",
            f"Execution Time:    {report['processing_time_sec']}s",
            f"Timestamp:         {report['timestamp']}",
            "",
            "Documents Breakdown:",
            f"  Source Documents:        {counts['source_count']}",
            f"  New (To Import):         {counts['imported_count']}",
            f"  Updated (Hash Changed):  {counts['updated_count']}",
            f"  Skipped (Identical):     {counts['skipped_count']}",
            f"  Rejected (Invalid/Empty):{counts['rejected_count']}",
            f"  Duplicates Found:        {counts['duplicates_count']}",
            f"  Orphan Relations:        {counts['orphan_count']}",
            f"  Errors:                  {counts['errors_count']}",
            "",
            f"Overall Status:            [{report['status']}]",
            "=================================================="
        ]

        if report["rejected_details"]:
            lines.append("\n[Rejected Documents]:")
            for r in report["rejected_details"]:
                lines.append(f"  - Doc #{r['id']} '{r['title']}': {r['reason']}")

        if report["duplicate_details"]:
            lines.append("\n[Duplicate Filenames]:")
            for d in report["duplicate_details"]:
                lines.append(f"  - '{d['filename']}': appears {d['occurrences']} times")

        if report["error_details"]:
            lines.append("\n[Errors]:")
            for e in report["error_details"]:
                lines.append(f"  - {e}")

        return "\n".join(lines)
