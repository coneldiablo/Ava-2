"""
AVA ↔ Onyx Knowledge Connector (Stage 3: AVAOnyxConnector)
Implements standard connector interfaces (load, poll, slim, get_documents, permissions)
mapping AVA knowledge base documents to Onyx Document schemas with stable external IDs.
"""

import json
import sqlite3
from typing import Dict, Any, List, Optional
from datetime import datetime

from src.core.onyx_db import (
    get_db_connection,
    init_onyx_tables,
    compute_content_hash,
    generate_stable_external_id,
)


class AVAOnyxConnector:
    """
    Official AVA Knowledge Connector for Onyx ingestion.
    Extracts knowledge base entries and metadata, maps them to Onyx Document format,
    and maintains tenant isolation boundaries.
    """

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path
        with get_db_connection(self.db_path) as conn:
            init_onyx_tables(conn)

    def get_credentials(self, business_id: int) -> Dict[str, Any]:
        """Fetch the safe tenant-link view; never invent or expose credentials."""
        with get_db_connection(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT business_id, onyx_tenant_id, onyx_base_url, credential_ref,
                       cc_pair_id, onyx_version, status, last_health_at
                FROM onyx_tenant_links
                WHERE business_id = ?
            """, (business_id,))
            row = cursor.fetchone()
            if row:
                value = dict(row)
                value["credential_configured"] = bool(value.pop("credential_ref", None))
                return value
            return {
                "business_id": business_id,
                "onyx_tenant_id": f"hotel_{business_id}",
                "onyx_base_url": None,
                "cc_pair_id": None,
                "onyx_version": None,
                "credential_configured": False,
                "status": "UNLINKED",
                "last_health_at": None,
            }

    def get_permissions(self, business_id: int) -> Dict[str, Any]:
        """Return tenant-level ACL and permission boundaries."""
        tenant_id = f"hotel_{business_id}"
        return {
            "business_id": business_id,
            "tenant_id": tenant_id,
            "allowed_users": [f"user_{business_id}"],
            "allowed_groups": [f"group_{business_id}"],
            "access_type": "tenant_private"
        }

    def load(self, business_id: int) -> List[Dict[str, Any]]:
        """
        Full load: Returns all active knowledge base documents for business_id
        mapped to Onyx Document schema.
        """
        return self.get_documents(business_id=business_id)

    def poll(self, business_id: int, since_timestamp: str) -> List[Dict[str, Any]]:
        """
        Incremental polling: Returns documents created or updated after since_timestamp.
        """
        with get_db_connection(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT k.id, k.instanceId as business_id, k.filename, k.originalName,
                       k.mimeType, k.fileSize, k.chunkCount, k.version, k.isCurrent,
                       k.createdAt, k.contentHash
                FROM knowledge_base k
                WHERE k.instanceId = ? AND k.isCurrent = 1 AND k.createdAt >= ?
                ORDER BY k.createdAt ASC
            """, (business_id, since_timestamp))
            rows = cursor.fetchall()

        doc_ids = [row["id"] for row in rows]
        return self.get_documents(business_id=business_id, doc_ids=doc_ids)

    def slim(self, business_id: int) -> List[Dict[str, Any]]:
        """
        Slim load: Returns lightweight ID and hash tuples for high-speed differential syncing.
        """
        with get_db_connection(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT k.id, k.instanceId as business_id, k.contentHash, k.createdAt
                FROM knowledge_base k
                WHERE k.instanceId = ? AND k.isCurrent = 1
            """, (business_id,))
            rows = cursor.fetchall()

        return [
            {
                "external_id": generate_stable_external_id(r["business_id"], "knowledge", r["id"]),
                "source_id": r["id"],
                "content_hash": r["contentHash"] or "",
                "updated_at": r["createdAt"]
            }
            for r in rows
        ]

    def get_documents(
        self,
        business_id: int,
        doc_ids: Optional[List[int]] = None
    ) -> List[Dict[str, Any]]:
        """
        Retrieve and assemble full documents from knowledge_base and kb_chunks.
        """
        with get_db_connection(self.db_path) as conn:
            cursor = conn.cursor()
            if doc_ids:
                placeholders = ",".join("?" for _ in doc_ids)
                query = f"""
                    SELECT k.id, k.instanceId as business_id, k.filename, k.originalName,
                           k.mimeType, k.fileSize, k.chunkCount, k.version, k.isCurrent,
                           k.createdAt, k.contentHash
                    FROM knowledge_base k
                    WHERE k.instanceId = ? AND k.isCurrent = 1 AND k.id IN ({placeholders})
                """
                params = [business_id] + doc_ids
            else:
                query = """
                    SELECT k.id, k.instanceId as business_id, k.filename, k.originalName,
                           k.mimeType, k.fileSize, k.chunkCount, k.version, k.isCurrent,
                           k.createdAt, k.contentHash
                    FROM knowledge_base k
                    WHERE k.instanceId = ? AND k.isCurrent = 1
                """
                params = [business_id]

            cursor.execute(query, params)
            kb_rows = [dict(row) for row in cursor.fetchall()]

            # Fetch chunks for each document to reconstruct raw text content
            documents = []
            permissions = self.get_permissions(business_id)

            for kb in kb_rows:
                cursor.execute("""
                    SELECT chunkIndex, text, section
                    FROM kb_chunks
                    WHERE kbId = ?
                    ORDER BY chunkIndex ASC
                """, (kb["id"],))
                chunk_rows = cursor.fetchall()

                # Reconstruct full body
                body_text = "\n\n".join(r["text"] for r in chunk_rows if r["text"])
                if not body_text:
                    body_text = kb.get("originalName", "")

                doc_hash = kb.get("contentHash") or compute_content_hash(body_text)
                external_id = generate_stable_external_id(business_id, "knowledge", kb["id"])

                documents.append({
                    "external_id": external_id,
                    "tenant_id": permissions["tenant_id"],
                    "title": kb.get("originalName") or kb.get("filename") or f"doc_{kb['id']}",
                    "content": body_text,
                    "content_hash": doc_hash,
                    "metadata": {
                        "business_id": business_id,
                        "source": "ava_knowledge_base",
                        "source_id": kb["id"],
                        "version": kb.get("version", 1),
                        "file_size": kb.get("fileSize", len(body_text.encode("utf-8"))),
                        "mime_type": kb.get("mimeType", "text/plain"),
                        "created_at": kb.get("createdAt")
                    },
                    "permissions": permissions,
                    "updated_at": kb.get("createdAt") or datetime.utcnow().isoformat() + "Z"
                })

            return documents
