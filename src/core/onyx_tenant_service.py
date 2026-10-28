"""Tenant-scoped configuration and health checks for the AVA-Onyx bridge."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from src.core.onyx_client import (
    OnyxClient,
    OnyxClientError,
    normalize_credential_ref,
    normalize_onyx_base_url,
    redact_onyx_error,
)
from src.core.onyx_db import get_db_connection, init_onyx_tables


REQUIRED_ONYX_VERSION = os.getenv("ONYX_REQUIRED_VERSION", "v4.7.0")
READINESS_EVIDENCE_KEYS = {
    "backup_tested",
    "grounding_verified",
    "prompts_separated",
    "policy_gateway_enabled",
    "rollback_verified",
    "monitoring_active",
    "shadow_mode_completed",
    "data_audit_passed",
    "agent_tools_verified",
    "voice_route_verified",
    "whatsapp_route_verified",
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_json(value: Any) -> Dict[str, Any]:
    try:
        parsed = json.loads(value or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


class OnyxTenantService:
    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path
        with get_db_connection(self.db_path) as conn:
            init_onyx_tables(conn)

    def _business(self, business_id: int) -> int:
        value = int(business_id or 0)
        with get_db_connection(self.db_path) as conn:
            row = conn.execute("SELECT id FROM instances WHERE id = ?", (value,)).fetchone()
        if not row:
            raise ValueError(f"Business {value} not found")
        return value

    def _row(self, business_id: int):
        business_id = self._business(business_id)
        with get_db_connection(self.db_path) as conn:
            return conn.execute(
                "SELECT * FROM onyx_tenant_links WHERE business_id = ?",
                (business_id,),
            ).fetchone()

    def public(self, business_id: int) -> Dict[str, Any]:
        row = self._row(business_id)
        if not row:
            return {
                "business_id": int(business_id),
                "provider": "onyx",
                "status": "UNLINKED",
                "configured": False,
                "credential_configured": False,
                "required_version": REQUIRED_ONYX_VERSION,
                "readiness": {},
            }
        value = dict(row)
        credential_ref = value.pop("credential_ref", None)
        try:
            from src.core.onyx_client import resolve_api_key
            credential_available = bool(credential_ref and resolve_api_key(credential_ref, self.db_path))
        except OnyxClientError:
            credential_available = False
        return {
            "business_id": value["business_id"],
            "provider": "onyx",
            "tenant_id": value["onyx_tenant_id"],
            "base_url": value["onyx_base_url"],
            "cc_pair_id": value.get("cc_pair_id"),
            "onyx_version": value.get("onyx_version"),
            "required_version": REQUIRED_ONYX_VERSION,
            "status": value["status"],
            "configured": True,
            "credential_configured": bool(credential_ref),
            "credential_available": credential_available,
            "last_health_at": value.get("last_health_at"),
            "readiness": _parse_json(value.get("readiness_json")),
            "revision": value["revision"],
        }

    def configure(self, business_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
        business_id = self._business(business_id)
        current = self._row(business_id)
        base_url = normalize_onyx_base_url(payload.get("base_url") or (current and current["onyx_base_url"]))
        credential_ref = normalize_credential_ref(
            payload.get("credential_ref") or (current and current["credential_ref"])
        )
        if credential_ref.startswith('ONYX_API_KEY_HOTEL_') and credential_ref != f'ONYX_API_KEY_HOTEL_{business_id}':
            raise ValueError('Managed credential belongs to another business')
        cc_pair_id = int(payload.get("cc_pair_id") or (current and current["cc_pair_id"]) or 0)
        if cc_pair_id < 1:
            raise ValueError("A dedicated Onyx cc_pair_id is required")
        version = str(payload.get("onyx_version") or (current and current["onyx_version"]) or REQUIRED_ONYX_VERSION).strip()
        if not version:
            raise ValueError("Onyx version is required")
        tenant_id = f"hotel_{business_id}"
        readiness = _parse_json(current["readiness_json"] if current else None)
        connection_changed = bool(
            not current
            or base_url != current["onyx_base_url"]
            or credential_ref != current["credential_ref"]
            or cc_pair_id != current["cc_pair_id"]
            or version != current["onyx_version"]
        )
        if connection_changed:
            # Old agent/document-set bindings and acceptance claims cannot be
            # reused for a different server, key or ingestion boundary.
            readiness = {}
        status = "STAGING" if not connection_changed and current and current["status"] == "STAGING" else "CONFIGURED"
        with get_db_connection(self.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            conflict = conn.execute(
                "SELECT business_id FROM onyx_tenant_links WHERE onyx_base_url=? AND cc_pair_id=? AND business_id!=?",
                (base_url, cc_pair_id, business_id),
            ).fetchone()
            if conflict:
                raise ValueError("ONYX_PRIVATE_BOUNDARY_ALREADY_LINKED")
            if connection_changed:
                conn.execute('DELETE FROM onyx_agent_bindings WHERE business_id=?', (business_id,))
                conn.execute('DELETE FROM onyx_mcp_tool_bindings WHERE business_id=?', (business_id,))
                conn.execute('DELETE FROM onyx_mcp_action_links WHERE business_id=?', (business_id,))
                conn.execute('DELETE FROM onyx_mcp_execution_scopes WHERE business_id=?', (business_id,))
            updated = conn.execute("""
                INSERT INTO onyx_tenant_links (
                    business_id, onyx_tenant_id, onyx_base_url, credential_ref,
                    cc_pair_id, onyx_version, readiness_json, status, last_health_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)
                ON CONFLICT(business_id) DO UPDATE SET
                    onyx_tenant_id=excluded.onyx_tenant_id,
                    onyx_base_url=excluded.onyx_base_url,
                    credential_ref=excluded.credential_ref,
                    cc_pair_id=excluded.cc_pair_id,
                    onyx_version=excluded.onyx_version,
                    readiness_json=excluded.readiness_json,
                    status=excluded.status,
                    last_health_at=CASE WHEN ? THEN NULL ELSE onyx_tenant_links.last_health_at END,
                    updated_at=CURRENT_TIMESTAMP
                WHERE onyx_tenant_links.revision=?
            """, (
                business_id, tenant_id, base_url, credential_ref, cc_pair_id,
                version, json.dumps(readiness), status, connection_changed,
                current["revision"] if current else 0,
            ))
            if updated.rowcount != 1:
                raise ValueError("ONYX_CONFIGURATION_CHANGED")
            conn.commit()
        return self.public(business_id)

    async def test_connection(self, business_id: int) -> Dict[str, Any]:
        row = self._row(business_id)
        if not row:
            raise ValueError("Onyx tenant link is not configured")
        if row["status"] == "DISABLED":
            raise ValueError("ONYX_TENANT_DISABLED")
        with get_db_connection(self.db_path) as conn:
            if not conn.execute("SELECT id FROM instances WHERE id=? AND isActive=1", (int(business_id),)).fetchone():
                raise ValueError("ONYX_TENANT_DISABLED")
        revision = row["revision"]
        client = OnyxClient(
            base_url=row["onyx_base_url"],
            credential_ref=row["credential_ref"],
            cc_pair_id=row["cc_pair_id"],
        )
        try:
            result = await client.test_connection()
        except Exception as error:
            with get_db_connection(self.db_path) as conn:
                conn.execute(
                    "UPDATE onyx_tenant_links SET status='ERROR', updated_at=CURRENT_TIMESTAMP "
                    "WHERE business_id=? AND revision=? AND status!='DISABLED' "
                    "AND EXISTS (SELECT 1 FROM instances WHERE id=business_id AND isActive=1)",
                    (int(business_id), revision),
                )
                conn.commit()
            raise
        with get_db_connection(self.db_path) as conn:
            updated = conn.execute("""
                UPDATE onyx_tenant_links
                SET status='STAGING', last_health_at=?, updated_at=CURRENT_TIMESTAMP
                WHERE business_id=? AND revision=? AND status!='DISABLED'
                AND EXISTS (SELECT 1 FROM instances WHERE id=business_id AND isActive=1)
            """, (_utc_now(), int(business_id), revision))
            conn.commit()
            if updated.rowcount != 1:
                raise ValueError("ONYX_CONFIGURATION_CHANGED")
        safe_user = result.get("user") if isinstance(result.get("user"), dict) else {}
        return {
            **self.public(business_id),
            "test_ok": True,
            "authenticated_user_id": safe_user.get("id"),
        }

    def update_readiness(self, business_id: int, evidence: Dict[str, Any], *, expected_revision: Optional[int] = None) -> Dict[str, Any]:
        row = self._row(business_id)
        if not row:
            raise ValueError("Onyx tenant link is not configured")
        if row["status"] == "DISABLED":
            raise ValueError("ONYX_TENANT_DISABLED")
        # Callers that performed remote checks must carry the revision they
        # checked. Omission is retained for synchronous legacy local callers.
        revision = row["revision"] if expected_revision is None else int(expected_revision)
        if revision != row["revision"]:
            raise ValueError("ONYX_CONFIGURATION_CHANGED")
        current = _parse_json(row["readiness_json"])
        now = _utc_now()
        for key, value in (evidence or {}).items():
            if key not in READINESS_EVIDENCE_KEYS:
                continue
            passed = value.get("passed") is True if isinstance(value, dict) else value is True
            details = value.get("details") if isinstance(value, dict) else None
            current[key] = {
                "passed": passed,
                "verified_at": now,
                "details": redact_onyx_error(details, 300) if details else None,
            }
        with get_db_connection(self.db_path) as conn:
            updated = conn.execute(
                "UPDATE onyx_tenant_links SET readiness_json=?, updated_at=CURRENT_TIMESTAMP "
                "WHERE business_id=? AND revision=? AND status!='DISABLED' "
                "AND EXISTS (SELECT 1 FROM instances WHERE id=business_id AND isActive=1)",
                (json.dumps(current, ensure_ascii=False), int(business_id), revision),
            )
            conn.commit()
            if updated.rowcount != 1:
                raise ValueError("ONYX_CONFIGURATION_CHANGED")
        return self.public(business_id)

    def disable(self, business_id: int) -> Dict[str, Any]:
        row = self._row(business_id)
        if not row:
            return self.public(business_id)
        with get_db_connection(self.db_path) as conn:
            conn.execute("""
                UPDATE onyx_tenant_links SET status='DISABLED', updated_at=CURRENT_TIMESTAMP
                WHERE business_id=?
            """, (int(business_id),))
            conn.execute("UPDATE onyx_tenant_credentials SET enabled=0, token='', token_encrypted=NULL, "
                         "revision=revision+1 WHERE business_id=?", (int(business_id),))
            conn.commit()
        return self.public(business_id)
