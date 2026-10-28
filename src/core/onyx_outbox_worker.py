"""
AVA ↔ Onyx Transactional Outbox Worker (Stage 3: Outbox & Retry Engine)
Handles reliable, asynchronous synchronization between AVA and Onyx.
Implements leasing, idempotency, exponential backoff retries, and dead-letter queues.
"""

import time
import json
import uuid
import logging
import sqlite3
import os
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta

from src.core.onyx_db import (
    get_db_connection,
    init_onyx_tables,
    generate_stable_external_id,
)
from src.core.onyx_resilience import OnyxCircuitBreaker
from src.core.onyx_client import (OnyxClient, OnyxClientError, redact_onyx_error,
                                  validate_onyx_document_id, event_document_id)

logger = logging.getLogger("ava.onyx.outbox")

RETRY_SCHEDULE_SECONDS = [
    5,      # 1st retry: 5 sec
    15,     # 2nd retry: 15 sec
    60,     # 3rd retry: 1 min
    300,    # 4th retry: 5 min
    1800,   # 5th retry: 30 min
    7200    # 6th retry: 2 hours
]
MAX_RETRIES = len(RETRY_SCHEDULE_SECONDS)


class OnyxOutboxWorker:
    """
    Transactional Outbox Engine for syncing AVA changes to Onyx.
    """

    def __init__(
        self,
        db_path: Optional[str] = None,
        circuit_breaker: Optional[OnyxCircuitBreaker] = None
    ):
        self.db_path = db_path
        # Ingestion is synchronous in Onyx v4.7 and embeds the entire document.
        # Keep its budget separate from the short live-call/search deadline.
        self.ingestion_timeout = max(1.0, min(float(os.getenv("ONYX_INGESTION_TIMEOUT_SECONDS", "60")), 60.0))
        self.cb = circuit_breaker or OnyxCircuitBreaker(
            request_timeout=self.ingestion_timeout + 5.0
        )
        with get_db_connection(self.db_path) as conn:
            init_onyx_tables(conn)

    def enqueue_event(
        self,
        business_id: int,
        entity_type: str,
        source_id: int,
        operation: str,
        payload: Dict[str, Any]
    ) -> str:
        """Enqueue an event transactionally into onyx_sync_outbox."""
        event_id = str(uuid.uuid4())
        now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        with get_db_connection(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO onyx_sync_outbox (
                    event_id, business_id, entity_type, source_id,
                    operation, payload_json, status, attempts,
                    next_attempt_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)
            """, (
                event_id,
                business_id,
                entity_type,
                source_id,
                operation.upper(),
                json.dumps(payload, ensure_ascii=False),
                now,
                now,
                now
            ))
            conn.commit()
        logger.info(f"[OnyxOutbox] Enqueued event {event_id} ({operation} {entity_type}:{source_id}) for business {business_id}")
        return event_id

    def lease_events(self, limit: int = 10, lease_ttl_seconds: int = 120) -> List[Dict[str, Any]]:
        """Atomically lease due events and recover expired worker leases."""
        now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        leased_until = (datetime.utcnow() + timedelta(seconds=max(10, lease_ttl_seconds))).strftime("%Y-%m-%d %H:%M:%S")
        with get_db_connection(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("BEGIN IMMEDIATE")
            cursor.execute("""
                UPDATE onyx_sync_outbox
                SET status = 'RETRY', lease_token = NULL, leased_until = NULL,
                    next_attempt_at = ?, last_error_code = 'ONYX_LEASE_EXPIRED',
                    last_error = 'Previous worker lease expired; event recovered', updated_at = ?
                WHERE status = 'PROCESSING'
                  AND (leased_until IS NULL OR leased_until <= ?)
            """, (now, now, now))
            cursor.execute("""
                SELECT id, event_id, business_id, entity_type, source_id,
                       operation, payload_json, status, attempts, next_attempt_at
                FROM onyx_sync_outbox
                WHERE status IN ('PENDING', 'RETRY') AND next_attempt_at <= ?
                ORDER BY next_attempt_at ASC
                LIMIT ?
            """, (now, limit))
            candidates = [dict(r) for r in cursor.fetchall()]
            rows = []
            for event in candidates:
                lease_token = str(uuid.uuid4())
                updated = cursor.execute("""
                    UPDATE onyx_sync_outbox
                    SET status = 'PROCESSING', lease_token = ?, leased_until = ?, updated_at = ?
                    WHERE id = ? AND status IN ('PENDING', 'RETRY') AND next_attempt_at <= ?
                """, (lease_token, leased_until, now, event["id"], now))
                if updated.rowcount == 1:
                    event["status"] = "PROCESSING"
                    event["lease_token"] = lease_token
                    event["leased_until"] = leased_until
                    rows.append(event)
            conn.commit()

        return rows

    def mark_completed(
        self, event_id: str, business_id: int, entity_type: str, source_id: int,
        content_hash: str, *, lease_token: Optional[str] = None,
        remote_document_id: Optional[str] = None, operation: str = "UPSERT"
    ) -> bool:
        """Mark outbox event as completed and update document link."""
        now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        external_id = generate_stable_external_id(business_id, entity_type, source_id)
        # A completion cannot synthesize remote acceptance from a local ID.
        # Duplicate processing supplies the previously verified stored ID.
        remote_document_id = validate_onyx_document_id(remote_document_id, external_id)
        with get_db_connection(self.db_path) as conn:
            cursor = conn.cursor()
            where_lease = " AND lease_token = ?" if lease_token else ""
            params: List[Any] = [now, event_id, business_id, entity_type, source_id, operation.upper()]
            if lease_token:
                params.append(lease_token)
            result = cursor.execute(f"""
                UPDATE onyx_sync_outbox
                SET status = 'COMPLETED', lease_token = NULL, leased_until = NULL,
                    last_error_code = NULL, last_error = NULL, updated_at = ?
                WHERE event_id = ? AND business_id=? AND entity_type=? AND source_id=?
                  AND UPPER(operation)=? AND status = 'PROCESSING'{where_lease}
            """, params)
            if result.rowcount != 1:
                conn.rollback()
                return False

            if operation.upper() == "DELETE":
                cursor.execute("""
                    DELETE FROM onyx_document_links
                    WHERE business_id = ? AND entity_type = ? AND source_id = ?
                """, (business_id, entity_type, source_id))
            else:
                cursor.execute("""
                    INSERT INTO onyx_document_links (
                        business_id, entity_type, source_id,
                        onyx_document_id, content_hash, last_synced_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(business_id, entity_type, source_id) DO UPDATE SET
                        onyx_document_id = excluded.onyx_document_id,
                        content_hash = excluded.content_hash,
                        last_synced_at = excluded.last_synced_at
                """, (business_id, entity_type, source_id, remote_document_id, content_hash, now))
            conn.commit()
        logger.info(f"[OnyxOutbox] Event {event_id} COMPLETED. Synced link: {external_id}")
        return True

    def mark_failed(
        self, event_id: str, current_attempts: int, error_msg: str, *,
        lease_token: Optional[str] = None, error_code: str = "ONYX_SYNC_FAILED",
        retryable: bool = True
    ) -> bool:
        """Handle failure with exponential backoff or move to DEAD_LETTER."""
        now_dt = datetime.utcnow()
        new_attempts = current_attempts + 1

        if not retryable or new_attempts > MAX_RETRIES:
            status = "DEAD_LETTER"
            next_attempt_str = (now_dt + timedelta(days=365)).strftime("%Y-%m-%d %H:%M:%S")
            logger.error(f"[OnyxOutbox] Event {event_id} exceeded max retries ({MAX_RETRIES}). Transitioned to DEAD_LETTER.")
        else:
            status = "RETRY"
            delay_sec = RETRY_SCHEDULE_SECONDS[new_attempts - 1]
            next_attempt_str = (now_dt + timedelta(seconds=delay_sec)).strftime("%Y-%m-%d %H:%M:%S")
            logger.warning(f"[OnyxOutbox] Event {event_id} failed (attempt {new_attempts}/{MAX_RETRIES}). Next retry in {delay_sec}s.")

        with get_db_connection(self.db_path) as conn:
            cursor = conn.cursor()
            where_lease = " AND lease_token = ?" if lease_token else ""
            params: List[Any] = [
                status,
                new_attempts,
                next_attempt_str,
                error_code,
                redact_onyx_error(error_msg),
                now_dt.strftime("%Y-%m-%d %H:%M:%S"),
                event_id,
            ]
            if lease_token:
                params.append(lease_token)
            result = cursor.execute(f"""
                UPDATE onyx_sync_outbox
                SET status = ?, attempts = ?, next_attempt_at = ?, last_error_code = ?,
                    last_error = ?, lease_token = NULL, leased_until = NULL, updated_at = ?
                WHERE event_id = ? AND status = 'PROCESSING'{where_lease}
            """, params)
            conn.commit()
            return result.rowcount == 1

    def _client_for_event(self, event: Dict[str, Any]) -> OnyxClient:
        with get_db_connection(self.db_path) as conn:
            row = conn.execute("""
                SELECT onyx_base_url, credential_ref, cc_pair_id, status
                FROM onyx_tenant_links WHERE business_id = ?
            """, (int(event["business_id"]),)).fetchone()
        if not row or row["status"] not in {"STAGING", "ACTIVE", "ACTIVE_LIVE"}:
            raise OnyxClientError(
                "Onyx tenant link is not configured or enabled",
                code="ONYX_TENANT_NOT_READY",
                status_code=409,
            )
        return OnyxClient(
            base_url=row["onyx_base_url"],
            credential_ref=row["credential_ref"],
            cc_pair_id=row["cc_pair_id"],
            timeout_seconds=self.ingestion_timeout,
        )

    def is_idempotent_duplicate(self, business_id: int, entity_type: str, source_id: int, content_hash: str) -> bool:
        """Check if identical content is already synchronized in Onyx."""
        return self._idempotent_document_id(business_id, entity_type, source_id, content_hash) is not None

    def _idempotent_document_id(self, business_id: int, entity_type: str, source_id: int, content_hash: str) -> Optional[str]:
        if not content_hash:
            return None
        with get_db_connection(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT content_hash,onyx_document_id FROM onyx_document_links
                WHERE business_id = ? AND entity_type = ? AND source_id = ?
            """, (business_id, entity_type, source_id))
            row = cursor.fetchone()
            if row and row["content_hash"] == content_hash:
                try:
                    return validate_onyx_document_id(row['onyx_document_id'],
                        generate_stable_external_id(business_id, entity_type, source_id))
                except OnyxClientError:
                    return None
        return None

    async def process_single_event(
        self,
        event: Dict[str, Any],
        sync_sender_func: Optional[Any] = None
    ) -> bool:
        """Process one outbox event through the circuit breaker."""
        event_id = event["event_id"]
        business_id = event["business_id"]
        entity_type = event["entity_type"]
        source_id = event["source_id"]
        payload = json.loads(event["payload_json"])
        content_hash = payload.get("content_hash", "")

        captured_error: List[Exception] = []

        async def send_to_onyx():
            try:
                if sync_sender_func:
                    result = await sync_sender_func(event)
                else:
                    result = await self._client_for_event(event).apply_outbox_event(event)
                if not isinstance(result, dict) or result.get('status') != 'ok':
                    raise OnyxClientError('Onyx document acknowledgement is missing',
                        code='ONYX_DOCUMENT_ACK_INVALID', status_code=502, retryable=True)
                validate_onyx_document_id(result.get('document_id'),
                    generate_stable_external_id(business_id, entity_type, source_id))
                return result
            except Exception as error:
                captured_error.append(error)
                raise

        try:
            # Validate payload scope before both network and idempotent paths.
            event_document_id(event, payload)
            duplicate_id = (self._idempotent_document_id(business_id, entity_type, source_id, content_hash)
                            if event['operation'].upper() == 'UPSERT' else None)
            if duplicate_id is not None:
                logger.info(f"[OnyxOutbox] Event {event_id} skipped (already synchronized with identical hash).")
                return self.mark_completed(
                    event_id, business_id, entity_type, source_id, content_hash,
                    lease_token=event.get('lease_token'), remote_document_id=duplicate_id,
                    operation=event['operation'])
            result = await self.cb.execute(send_to_onyx)
            if result is not None:
                return self.mark_completed(
                    event_id, business_id, entity_type, source_id, content_hash,
                    lease_token=event.get("lease_token"),
                    remote_document_id=(result.get("document_id") if isinstance(result, dict) else None),
                    operation=event["operation"],
                )
            else:
                error = captured_error[-1] if captured_error else None
                self.mark_failed(
                    event_id,
                    event["attempts"],
                    error or "Onyx unavailable (timeout or circuit open)",
                    lease_token=event.get("lease_token"),
                    error_code=getattr(error, "code", "ONYX_TIMEOUT_OR_CIRCUIT_OPEN"),
                    retryable=getattr(error, "retryable", True),
                )
                return False
        except Exception as e:
            self.mark_failed(
                event_id, event["attempts"], str(e),
                lease_token=event.get("lease_token"),
                error_code=getattr(e, "code", "ONYX_SYNC_FAILED"),
                retryable=getattr(e, "retryable", True),
            )
            return False
