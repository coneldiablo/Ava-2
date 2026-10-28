"""
AVA ↔ Onyx Database Operations & Schema Management
Provides schema migration and transactional data access for:
- onyx_tenant_links
- onyx_document_links
- onyx_sync_outbox
- onyx_action_audit
"""

import os
import json
import sqlite3
import hashlib
from urllib.parse import quote
from datetime import datetime
from typing import Optional, Dict, Any, List, Tuple

DEFAULT_DB_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "whatsapp_crm", "crm_v2.db")


def get_db_connection(db_path: Optional[str] = None, *, readonly: bool = False) -> sqlite3.Connection:
    path = db_path or os.getenv("DB_PATH") or DEFAULT_DB_PATH
    conn = sqlite3.connect(f'file:{quote(str(path))}?mode=ro', uri=True, timeout=10.0) if readonly else sqlite3.connect(path, timeout=10.0)
    conn.row_factory = sqlite3.Row
    return conn


def init_onyx_tables(conn: sqlite3.Connection):
    """Ensure all Onyx integration tables exist."""
    cursor = conn.cursor()
    cursor.executescript("""
        CREATE TABLE IF NOT EXISTS onyx_tenant_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL UNIQUE,
            onyx_tenant_id TEXT NOT NULL,
            onyx_base_url TEXT NOT NULL,
            credential_ref TEXT,
            cc_pair_id INTEGER,
            onyx_version TEXT,
            readiness_json TEXT DEFAULT '{}',
            schema_version TEXT DEFAULT '1.0',
            status TEXT DEFAULT 'active',
            last_health_at TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(business_id) REFERENCES instances(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS onyx_tenant_credentials (
            env_ref TEXT PRIMARY KEY,
            token TEXT NOT NULL DEFAULT '',
            token_encrypted TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            revision INTEGER NOT NULL DEFAULT 1,
            business_id INTEGER NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS onyx_document_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_id INTEGER NOT NULL,
            entity_type TEXT NOT NULL,
            source_id INTEGER NOT NULL,
            onyx_document_id TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            last_synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(business_id, entity_type, source_id),
            FOREIGN KEY(business_id) REFERENCES instances(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS onyx_sync_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            business_id INTEGER NOT NULL,
            entity_type TEXT NOT NULL,
            source_id INTEGER NOT NULL,
            operation TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT DEFAULT 'PENDING',
            attempts INTEGER DEFAULT 0,
            next_attempt_at TEXT DEFAULT CURRENT_TIMESTAMP,
            lease_token TEXT,
            leased_until TEXT,
            last_error_code TEXT,
            last_error TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(business_id) REFERENCES instances(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS onyx_action_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            business_id INTEGER NOT NULL,
            user_id TEXT,
            agent_id TEXT NOT NULL,
            action TEXT NOT NULL,
            arguments_hash TEXT NOT NULL,
            status TEXT NOT NULL,
            result_hash TEXT,
            payload_json TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(business_id) REFERENCES instances(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_onyx_sync_outbox_status ON onyx_sync_outbox(status, next_attempt_at);
        CREATE INDEX IF NOT EXISTS idx_onyx_document_links_lookup ON onyx_document_links(business_id, entity_type, source_id);
        CREATE INDEX IF NOT EXISTS idx_onyx_action_audit_business ON onyx_action_audit(business_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS onyx_action_approvals (
            token_hash TEXT PRIMARY KEY,
            business_id INTEGER NOT NULL,
            agent_id TEXT NOT NULL,
            action TEXT NOT NULL,
            arguments_hash TEXT NOT NULL,
            approved_by TEXT NOT NULL,
            expires_at REAL NOT NULL,
            consumed_event_id TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS onyx_agent_bindings (
            business_id INTEGER NOT NULL REFERENCES instances(id),
            role TEXT NOT NULL CHECK(role IN ('sales','manager','revenue')),
            onyx_base_url TEXT NOT NULL,
            persona_id INTEGER NOT NULL,
            document_set_id INTEGER NOT NULL,
            document_set_name TEXT NOT NULL,
            model_configuration_id INTEGER NOT NULL,
            search_tool_id INTEGER NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(business_id,role),
            UNIQUE(onyx_base_url,persona_id)
        );

        CREATE TABLE IF NOT EXISTS onyx_mcp_discovery_credentials (
            id INTEGER PRIMARY KEY CHECK(id=1),
            token_hash TEXT NOT NULL,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS onyx_mcp_execution_scopes (
            token_hash TEXT PRIMARY KEY,
            discovery_hash TEXT NOT NULL,
            business_id INTEGER NOT NULL REFERENCES instances(id),
            agent_role TEXT NOT NULL,
            channel TEXT NOT NULL,
            correlation_id TEXT NOT NULL,
            customer_id INTEGER,
            actor_id TEXT NOT NULL,
            expires_at REAL NOT NULL,
            revoked_at REAL,
            calls_used INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_onyx_mcp_scope_expiry ON onyx_mcp_execution_scopes(expires_at);
        CREATE TABLE IF NOT EXISTS onyx_mcp_action_links (
            token_hash TEXT NOT NULL REFERENCES onyx_mcp_execution_scopes(token_hash) ON DELETE CASCADE,
            event_id TEXT NOT NULL REFERENCES onyx_action_audit(event_id),
            business_id INTEGER NOT NULL,
            action TEXT NOT NULL,
            created_at REAL NOT NULL,
            PRIMARY KEY(token_hash,event_id)
        );
        CREATE TABLE IF NOT EXISTS onyx_mcp_tool_bindings (
            business_id INTEGER NOT NULL REFERENCES instances(id),
            agent_role TEXT NOT NULL,
            onyx_base_url TEXT NOT NULL,
            mcp_server_id INTEGER NOT NULL,
            tool_name TEXT NOT NULL,
            tool_id INTEGER NOT NULL,
            PRIMARY KEY(business_id,agent_role,tool_name)
        );
    """)

    # Additive schema sync for databases created by older AVA releases.
    existing = {row[1] for row in cursor.execute('PRAGMA table_info(onyx_tenant_credentials)')}
    for name, definition in (
        ('token_encrypted', 'TEXT'), ('enabled', 'INTEGER NOT NULL DEFAULT 1'),
        ('revision', 'INTEGER NOT NULL DEFAULT 1'),
    ):
        if name not in existing:
            cursor.execute(f'ALTER TABLE onyx_tenant_credentials ADD COLUMN {name} {definition}')
    cursor.execute("UPDATE onyx_tenant_credentials SET token='', enabled=0, revision=revision+1 "
                   "WHERE token LIKE 'sk-onyx-tenant-%'")
    legacy = cursor.execute("SELECT env_ref,business_id,token FROM onyx_tenant_credentials WHERE token!=''").fetchall()
    if legacy:
        import base64
        import re
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        raw_key = os.getenv('ONYX_CREDENTIALS_MASTER_KEY', '').strip()
        try:
            key = bytes.fromhex(raw_key) if re.fullmatch(r'[a-fA-F0-9]{64}', raw_key) else base64.b64decode(raw_key, validate=True)
            if len(key) != 32:
                raise ValueError()
        except ValueError:
            raise ValueError('ONYX_CREDENTIALS_MASTER_KEY_REQUIRED') from None
        encode = lambda value: base64.urlsafe_b64encode(value).decode().rstrip('=')
        for reference, business_id, token in legacy:
            iv = os.urandom(12)
            encrypted = AESGCM(key).encrypt(iv, token.encode(), f'ava:onyx:{business_id}:{reference}:v2'.encode())
            value = '.'.join(('v2', encode(iv), encode(encrypted[-16:]), encode(encrypted[:-16])))
            cursor.execute("UPDATE onyx_tenant_credentials SET token='', token_encrypted=?, revision=revision+1 WHERE env_ref=? AND business_id=?",
                           (value, reference, business_id))
    existing = {
        row[1] for row in cursor.execute("PRAGMA table_info(onyx_tenant_links)")
    }
    for name, definition in (
        ("cc_pair_id", "INTEGER"),
        ("onyx_version", "TEXT"),
        ("readiness_json", "TEXT DEFAULT '{}'"),
        ("revision", "INTEGER NOT NULL DEFAULT 1"),
    ):
        if name not in existing:
            cursor.execute(f"ALTER TABLE onyx_tenant_links ADD COLUMN {name} {definition}")

    cursor.execute("""CREATE UNIQUE INDEX IF NOT EXISTS idx_onyx_private_pair_owner
        ON onyx_tenant_links(onyx_base_url, cc_pair_id)
        WHERE cc_pair_id IS NOT NULL AND cc_pair_id > 0""")
    cursor.execute("""CREATE TRIGGER IF NOT EXISTS onyx_link_configuration_revision
        AFTER UPDATE OF onyx_base_url,credential_ref,cc_pair_id,onyx_version,status ON onyx_tenant_links
        WHEN OLD.onyx_base_url IS NOT NEW.onyx_base_url OR OLD.credential_ref IS NOT NEW.credential_ref
          OR OLD.cc_pair_id IS NOT NEW.cc_pair_id OR OLD.onyx_version IS NOT NEW.onyx_version
          OR (NEW.status='DISABLED' AND OLD.status!='DISABLED')
        BEGIN
          UPDATE onyx_tenant_links SET revision=revision+1,readiness_json='{}',last_health_at=NULL
          WHERE business_id=NEW.business_id;
        END""")
    cursor.execute("""CREATE TRIGGER IF NOT EXISTS onyx_credential_link_revision
        AFTER UPDATE OF token_encrypted,enabled ON onyx_tenant_credentials
        WHEN OLD.token_encrypted IS NOT NEW.token_encrypted OR OLD.enabled IS NOT NEW.enabled
        BEGIN
          UPDATE onyx_tenant_links SET revision=revision+1,readiness_json='{}',last_health_at=NULL
          WHERE business_id=NEW.business_id AND credential_ref=NEW.env_ref;
        END""")
    cursor.execute("""CREATE TRIGGER IF NOT EXISTS onyx_credential_delete_revision
        AFTER DELETE ON onyx_tenant_credentials
        BEGIN
          UPDATE onyx_tenant_links SET revision=revision+1,readiness_json='{}',last_health_at=NULL
          WHERE business_id=OLD.business_id AND credential_ref=OLD.env_ref;
        END""")

    existing = {
        row[1] for row in cursor.execute("PRAGMA table_info(onyx_sync_outbox)")
    }
    for name, definition in (
        ("lease_token", "TEXT"),
        ("leased_until", "TEXT"),
        ("last_error_code", "TEXT"),
    ):
        if name not in existing:
            cursor.execute(f"ALTER TABLE onyx_sync_outbox ADD COLUMN {name} {definition}")

    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_onyx_sync_outbox_lease "
        "ON onyx_sync_outbox(status, next_attempt_at, leased_until)"
    )
    existing = {row[1] for row in cursor.execute("PRAGMA table_info(onyx_action_audit)")}
    for name, definition in (
        ("result_json", "TEXT"),
        ("started_at_epoch", "REAL"),
        ("finished_at_epoch", "REAL"),
    ):
        if name not in existing:
            cursor.execute(f"ALTER TABLE onyx_action_audit ADD COLUMN {name} {definition}")
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_onyx_action_rate_limit "
        "ON onyx_action_audit(business_id, action, started_at_epoch)"
    )
    conn.commit()


def compute_content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def generate_stable_external_id(business_id: int, entity_type: str, source_id: Any) -> str:
    return f"ava:{business_id}:{entity_type}:{source_id}"
