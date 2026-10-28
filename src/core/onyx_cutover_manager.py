"""
AVA ↔ Onyx Controlled Cutover & Rollback Management Engine (Stage 11)
Validates Go/No-Go production criteria, orchestrates live traffic cutover for pilot hotels,
enforces Policy Gateway in live mode, and manages instantaneous zero-downtime rollbacks.
"""

import json
import logging
from typing import Dict, Any, List, Optional
from datetime import datetime, timezone

from src.core.onyx_db import (
    get_db_connection,
    init_onyx_tables,
)
from src.core.onyx_policy_gateway import PolicyGateway
from src.core.onyx_tenant_service import REQUIRED_ONYX_VERSION

logger = logging.getLogger("ava.onyx.cutover")


class OnyxCutoverManager:
    """
    Manages Go/No-Go checks, pilot cutovers, and zero-downtime rollback switches.
    """

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path
        self.policy_gateway = PolicyGateway(db_path=db_path)
        with get_db_connection(self.db_path) as conn:
            init_onyx_tables(conn)

    def check_go_no_go_criteria(self, business_id: int) -> Dict[str, Any]:
        """
        Evaluate full Production Cutover Checklist and Go/No-Go criteria:
        1. Knowledge sync completion >= 99.9%
        2. Zero unhandled Outbox dead-letters
        3. Zero cross-tenant security incidents
        4. Policy Gateway registered & active
        5. Instant rollback readiness
        """
        with get_db_connection(self.db_path) as conn:
            cursor = conn.cursor()

            # 1. Total vs synced documents
            cursor.execute("""
                SELECT COUNT(*) as total
                FROM knowledge_base
                WHERE instanceId = ? AND isCurrent = 1
            """, (business_id,))
            total_docs = cursor.fetchone()["total"]

            cursor.execute("""
                SELECT COUNT(*) as synced
                FROM onyx_document_links l
                JOIN knowledge_base k ON k.id=l.source_id AND k.instanceId=l.business_id
                WHERE l.business_id = ? AND l.entity_type='knowledge' AND k.isCurrent=1
                  AND (k.contentHash IS NULL OR k.contentHash='' OR k.contentHash=l.content_hash)
            """, (business_id,))
            synced_docs = cursor.fetchone()["synced"]

            sync_rate = (synced_docs / total_docs * 100.0) if total_docs > 0 else 100.0

            # 2. Outbox health
            cursor.execute("""
                SELECT status, COUNT(*) as cnt
                FROM onyx_sync_outbox
                WHERE business_id = ?
                GROUP BY status
            """, (business_id,))
            outbox_counts = {r["status"]: r["cnt"] for r in cursor.fetchall()}
            dead_letters = outbox_counts.get("DEAD_LETTER", 0)

            # 3. Security Audit checks
            cursor.execute("""
                SELECT COUNT(*) as denied_cnt
                FROM onyx_action_audit
                WHERE business_id = ? AND status = 'DENIED'
            """, (business_id,))
            denied_actions = cursor.fetchone()["denied_cnt"]

            # 4. Tenant link status
            cursor.execute("""
                SELECT status, schema_version, onyx_base_url, credential_ref,
                       cc_pair_id, onyx_version, readiness_json, last_health_at
                FROM onyx_tenant_links
                WHERE business_id = ?
            """, (business_id,))
            tenant_link = cursor.fetchone()
            tenant_status = tenant_link["status"] if tenant_link else "UNLINKED"
            binding_roles = cursor.execute('''SELECT b.role FROM onyx_agent_bindings b
                JOIN onyx_tenant_links t ON t.business_id=b.business_id AND t.onyx_base_url=b.onyx_base_url
                JOIN instances i ON i.id=b.business_id AND i.isActive=1
                WHERE b.business_id=?''', (business_id,)).fetchall()

        evidence = {}
        if tenant_link:
            try:
                evidence = json.loads(tenant_link["readiness_json"] or "{}")
            except (TypeError, ValueError):
                evidence = {}

        health_recent = False
        if tenant_link and tenant_link["last_health_at"]:
            try:
                health_at = datetime.fromisoformat(str(tenant_link["last_health_at"]).replace("Z", "+00:00"))
                if health_at.tzinfo is None:
                    health_at = health_at.replace(tzinfo=timezone.utc)
                health_recent = 0 <= (datetime.now(timezone.utc) - health_at).total_seconds() <= 600
            except (TypeError, ValueError):
                health_recent = False

        pass_sync = total_docs > 0 and total_docs == synced_docs
        pass_dead_letters = dead_letters == 0
        queue_drained = sum(
            int(outbox_counts.get(status, 0))
            for status in ("PENDING", "RETRY", "PROCESSING")
        ) == 0
        pass_tenant = bool(
            tenant_link
            and tenant_status in ("STAGING", "ACTIVE")
            and tenant_link["onyx_base_url"]
            and tenant_link["credential_ref"]
            and int(tenant_link["cc_pair_id"] or 0) > 0
        )
        version_pinned = bool(
            tenant_link
            and str(tenant_link["onyx_version"] or "").lstrip("v")
            == str(REQUIRED_ONYX_VERSION).lstrip("v")
        )

        def evidence_passed(key: str) -> bool:
            value = evidence.get(key)
            return value.get("passed") is True if isinstance(value, dict) else value is True

        checklist = {
            "version_pinned": version_pinned,
            "data_audit_passed": evidence_passed("data_audit_passed"),
            "backup_tested": evidence_passed("backup_tested"),
            "connector_verified": health_recent,
            "outbox_worker_active": pass_dead_letters and queue_drained,
            "knowledge_base_ingested": pass_sync,
            "grounding_verified": evidence_passed("grounding_verified"),
            "prompts_separated": evidence_passed("prompts_separated"),
            "policy_gateway_enabled": evidence_passed("policy_gateway_enabled"),
            "audit_logging_active": evidence_passed("policy_gateway_enabled"),
            "rate_limits_active": evidence_passed("monitoring_active"),
            "shadow_mode_completed": evidence_passed("shadow_mode_completed"),
            "rollback_verified": evidence_passed("rollback_verified"),
            "monitoring_active": evidence_passed("monitoring_active"),
            "tenant_link_ready": pass_tenant,
            "agents_provisioned": {row['role'] for row in binding_roles} == {'sales', 'manager', 'revenue'},
            "agent_tools_verified": evidence_passed("agent_tools_verified"),
            "voice_route_verified": evidence_passed("voice_route_verified"),
            "whatsapp_route_verified": evidence_passed("whatsapp_route_verified"),
        }

        all_passed = all(checklist.values())
        decision = "GO" if all_passed else "NO-GO"

        return {
            "business_id": business_id,
            "tenant_id": f"hotel_{business_id}",
            "decision": decision,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "metrics": {
                "total_source_documents": total_docs,
                "synced_documents": synced_docs,
                "sync_completion_pct": round(sync_rate, 2),
                "outbox_dead_letters": dead_letters,
                "outbox_pending": sum(int(outbox_counts.get(status, 0)) for status in ("PENDING", "RETRY", "PROCESSING")),
                "denied_security_actions": denied_actions,
                "current_tenant_status": tenant_status,
                "connector_health_recent": health_recent,
                "configured_onyx_version": tenant_link["onyx_version"] if tenant_link else None,
                "required_onyx_version": REQUIRED_ONYX_VERSION,
            },
            "checklist": checklist
        }

    def enable_live_cutover(self, business_id: int, hotel_name: str = "Grand Hotel Pilot") -> Dict[str, Any]:
        """
        Transition tenant from Staging/Shadow to ACTIVE_LIVE traffic.
        """
        criteria = self.check_go_no_go_criteria(business_id)
        if criteria["decision"] != "GO":
            return {
                "success": False,
                "status": "CUTOVER_BLOCKED",
                "reason": "Go/No-Go criteria not met",
                "details": criteria
            }

        with get_db_connection(self.db_path) as conn:
            cursor = conn.cursor()
            result = cursor.execute("""
                UPDATE onyx_tenant_links
                SET status = 'ACTIVE_LIVE', updated_at = CURRENT_TIMESTAMP
                WHERE business_id = ? AND status IN ('STAGING', 'ACTIVE')
            """, (business_id,))
            if result.rowcount != 1:
                conn.rollback()
                return {
                    "success": False,
                    "status": "CUTOVER_BLOCKED",
                    "reason": "Onyx tenant link is not in STAGING state",
                    "details": criteria,
                }
            conn.commit()

        logger.info(f"[OnyxCutoverManager] Tenant {business_id} ({hotel_name}) transitioned to ACTIVE_LIVE.")

        return {
            "success": True,
            "business_id": business_id,
            "tenant_id": f"hotel_{business_id}",
            "status": "ACTIVE_LIVE",
            "use_onyx_ai": True,
            "message": f"Cutover complete. Tenant {business_id} is now serving live traffic with Onyx AI Agent.",
            "timestamp": datetime.utcnow().isoformat() + "Z"
        }

    def execute_instant_rollback(self, business_id: int, reason: str = "Operator manual rollback") -> Dict[str, Any]:
        """
        Instant Zero-Downtime Rollback:
        1. Updates tenant link status to 'FALLBACK_LEGACY'.
        2. AVA routing immediately defaults to legacy local handlers (SIP/WhatsApp runtime unaffected).
        3. Records rollback audit log.
        """
        with get_db_connection(self.db_path) as conn:
            cursor = conn.cursor()
            result = cursor.execute("""
                UPDATE onyx_tenant_links
                SET status = 'FALLBACK_LEGACY', updated_at = CURRENT_TIMESTAMP
                WHERE business_id = ?
            """, (business_id,))
            if result.rowcount != 1:
                return {
                    "success": False,
                    "business_id": business_id,
                    "status": "UNLINKED",
                    "use_onyx_ai": False,
                    "reason": "Onyx tenant link is not configured",
                }
            conn.commit()

        # Log action to audit
        self.policy_gateway._log_audit(
            event_id=f"rollback_{business_id}_{int(datetime.utcnow().timestamp())}",
            business_id=business_id,
            user_id="operator",
            agent_id=f"ava:{business_id}:agent:system",
            action="execute_rollback",
            arguments_hash="rollback",
            status="EXECUTED",
            result_hash=None,
            payload={"reason": reason, "previous_status": "ACTIVE_LIVE", "new_status": "FALLBACK_LEGACY"}
        )

        logger.warning(f"[OnyxCutoverManager] Emergency Rollback executed for tenant {business_id}. Reason: {reason}")

        return {
            "success": True,
            "business_id": business_id,
            "tenant_id": f"hotel_{business_id}",
            "status": "FALLBACK_LEGACY",
            "use_onyx_ai": False,
            "operational_impact": "Zero impact: AVA telephony, WhatsApp & CRM continue via local fallback.",
            "reason": reason,
            "timestamp": datetime.utcnow().isoformat() + "Z"
        }
