#!/usr/bin/env python3
"""Project verified native knowledge metadata into the CRM runtime tables.

This root-only job runs after reconciliation.  It never fetches document text,
contacts Onyx, or updates the legacy tenant link; it copies only fenced IDs,
hashes and native search binding metadata into additive CRM tables.
"""
from __future__ import annotations

import json
import argparse
import importlib.util
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import time
from typing import Any
from urllib.parse import quote


_RECONCILE_SPEC = importlib.util.spec_from_file_location("ava_native_reconcile", Path(__file__).with_name("reconcile-onyx-native-knowledge.py"))
reconciler = importlib.util.module_from_spec(_RECONCILE_SPEC)
_RECONCILE_SPEC.loader.exec_module(reconciler)
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
HASH_RE = re.compile(r"(?:[0-9a-f]{32}|[0-9a-f]{64})\Z")


class ProjectionError(ValueError):
    pass


def require(condition: bool, code: str) -> None:
    if not condition:
        raise ProjectionError(code)


def read_root_json(path: Path) -> dict[str, Any]:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as exc:
        raise ProjectionError("ROOT_RECEIPT_REQUIRED") from exc
    try:
        info = os.fstat(fd)
        require(
            stat.S_ISREG(info.st_mode)
            and info.st_uid == 0
            and not (info.st_mode & 0o027)
            and 1 <= info.st_size <= 128 * 1024,
            "ROOT_RECEIPT_UNSAFE",
        )
        data = os.read(fd, 128 * 1024 + 1)
    finally:
        os.close(fd)
    try:
        value = json.loads(data)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ProjectionError("ROOT_RECEIPT_INVALID") from exc
    require(isinstance(value, dict), "ROOT_RECEIPT_INVALID")
    return value


def load_projection_inputs(config_path: Path, receipt_path: Path, checkpoint_path: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    # Explicit root-owned files, checked against durable deployment/source
    # state below. No fixed business, container name, hostname or mount lookup.
    read_root_json(config_path)
    operator = reconciler.load_config(config_path)
    receipt = read_root_json(receipt_path)
    checkpoint = read_root_json(checkpoint_path)
    for value in (receipt,):
        require(
            value.get("businessId") == operator["businessId"]
            and value.get("deploymentId") == operator["deploymentId"]
            and value.get("revision") == operator["revision"],
            "KNOWLEDGE_RECEIPT_SCOPE_INVALID",
        )
    expected_scope = {
        key: operator[key] for key in ("businessId", "deploymentId", "nativeScope", "revision")
    }
    require(
        checkpoint.get("version") == 1
        and checkpoint.get("scope") == expected_scope
        and isinstance(checkpoint.get("documents"), dict),
        "KNOWLEDGE_CHECKPOINT_SCOPE_INVALID",
    )
    binding = receipt.get("binding")
    require(
        isinstance(binding, dict)
        and type(binding.get("persona_id")) is int and binding["persona_id"] > 0
        and isinstance(binding.get("document_set_name"), str) and binding["document_set_name"]
        and type(binding.get("search_tool_id")) is int and binding["search_tool_id"] > 0,
        "KNOWLEDGE_BINDING_INVALID",
    )
    require(binding.get("owner_cc_pair_id") == operator["ownerCcPairId"]
            and binding.get("runtime_cc_pair_id") == operator["runtimeCcPairId"]
            and binding.get("document_set_id") == operator["documentSetId"]
            and binding["document_set_name"] == "ava-native-" + operator["deploymentId"].replace("-", "") + "-knowledge",
            "KNOWLEDGE_BINDING_SCOPE_INVALID")
    return operator, receipt, checkpoint


def checkpoint_documents(checkpoint: dict[str, Any], business_id: int) -> dict[int, dict[str, Any]]:
    result: dict[int, dict[str, Any]] = {}
    prefix = f"ava:{business_id}:knowledge:"
    for document_id, document in checkpoint["documents"].items():
        require(
            isinstance(document_id, str)
            and document_id.startswith(prefix)
            and isinstance(document, dict)
            and set(document) == {"source_id", "revision", "content_hash"},
            "KNOWLEDGE_CHECKPOINT_INVALID",
        )
        source_id = document_id[len(prefix):]
        require(
            source_id.isdigit() and str(int(source_id)) == source_id
            and source_id == document["source_id"]
            and type(document["revision"]) is int and document["revision"] > 0
            and isinstance(document["content_hash"], str)
            and HASH_RE.fullmatch(document["content_hash"]) is not None,
            "KNOWLEDGE_CHECKPOINT_INVALID",
        )
        key = int(source_id)
        require(key > 0 and key not in result, "KNOWLEDGE_CHECKPOINT_INVALID")
        result[key] = document
    return result


ADDITIVE_DDL = """
CREATE TABLE IF NOT EXISTS onyx_native_runtime_bindings (
    deployment_id TEXT NOT NULL, deployment_revision INTEGER NOT NULL CHECK(deployment_revision>0),
    business_id INTEGER NOT NULL REFERENCES instances(id),
    role TEXT NOT NULL CHECK(role IN ('sales','manager','revenue')),
    persona_id INTEGER NOT NULL, document_set_name TEXT NOT NULL, search_tool_id INTEGER NOT NULL,
    PRIMARY KEY(deployment_id,role)
);
CREATE TABLE IF NOT EXISTS onyx_native_runtime_document_links (
    deployment_id TEXT NOT NULL, deployment_revision INTEGER NOT NULL CHECK(deployment_revision>0),
    business_id INTEGER NOT NULL REFERENCES instances(id),
    entity_type TEXT NOT NULL CHECK(entity_type='knowledge'), source_id INTEGER NOT NULL,
    onyx_document_id TEXT NOT NULL, content_hash TEXT NOT NULL,
    PRIMARY KEY(deployment_id,entity_type,source_id), UNIQUE(deployment_id,onyx_document_id)
);
"""


def current_canonical(conn: sqlite3.Connection, business_id: int) -> dict[int, dict[str, Any]]:
    columns = {row[1] for row in conn.execute("PRAGMA table_info(knowledge_base)")}
    require({"id", "instanceId", "contentHash", "version", "isCurrent"} <= columns, "CRM_KNOWLEDGE_SCHEMA_INVALID")
    business_guard = " AND (business_id IS NULL OR business_id=instanceId)" if "business_id" in columns else ""
    rows = conn.execute(
        "SELECT id,contentHash,version FROM knowledge_base "
        f"WHERE instanceId=? AND isCurrent=1{business_guard} ORDER BY id",
        (business_id,),
    ).fetchall()
    result: dict[int, dict[str, Any]] = {}
    for row in rows:
        source_id, digest, revision = row
        texts = conn.execute("SELECT text FROM kb_chunks WHERE kbId=? ORDER BY chunkIndex,id", (source_id,)).fetchall()
        if not "\n\n".join(str(item[0]) for item in texts if item[0] is not None).strip():
            continue
        require(
            type(source_id) is int and source_id > 0
            and isinstance(digest, str) and HASH_RE.fullmatch(digest) is not None
            and type(revision) is int and revision > 0,
            "CRM_CANONICAL_ROW_INVALID",
        )
        result[source_id] = {"source_id": str(source_id), "revision": revision, "content_hash": digest}
    return result


def validate_index_proof(operator, checkpoint, proof, now=None):
    now = int(time.time() * 1000) if now is None else now
    require(isinstance(proof, dict) and proof.get("scope") == {key: operator[key] for key in ("businessId", "deploymentId", "nativeScope", "revision")}
        and type(proof.get("checkedAt")) is int and 0 <= now - proof["checkedAt"] <= 60000
        and proof.get("indexReadinessVerified") is True
        and proof.get("indexProbeMethod") == "default_document_index_random_acl_v1", "INDEX_PROOF_REQUIRED")
    expected = {key: {"onyx_document_id": quote(key, safe=""), "source_id": item["source_id"], "content_hash": item["content_hash"]}
                for key, item in checkpoint["documents"].items()}
    require(proof.get("indexedDocuments") == expected, "INDEX_PROOF_STALE")


def project(conn: sqlite3.Connection, operator: dict[str, Any], receipt: dict[str, Any], checkpoint: dict[str, Any], *, dry_run: bool = False, index_readback=None) -> int:
    business_id = operator["businessId"]
    deployment_id = operator["deploymentId"]
    revision = operator["revision"]
    require(all(receipt.get(key) == operator[key] for key in ("businessId", "deploymentId", "revision")), "KNOWLEDGE_RECEIPT_SCOPE_INVALID")
    require(checkpoint.get("version") == 1 and checkpoint.get("scope") == {key: operator[key] for key in ("businessId", "deploymentId", "nativeScope", "revision")}, "KNOWLEDGE_CHECKPOINT_SCOPE_INVALID")
    binding = receipt.get("binding", {})
    require(isinstance(binding, dict) and type(binding.get("persona_id")) is int and binding["persona_id"] > 0
            and type(binding.get("search_tool_id")) is int and binding["search_tool_id"] > 0
            and binding.get("owner_cc_pair_id") == operator["ownerCcPairId"]
            and binding.get("runtime_cc_pair_id") == operator["runtimeCcPairId"]
            and binding.get("document_set_id") == operator["documentSetId"]
            and binding.get("document_set_name") == "ava-native-" + deployment_id.replace("-", "") + "-knowledge", "KNOWLEDGE_BINDING_SCOPE_INVALID")
    expected_documents = checkpoint_documents(checkpoint, business_id)
    if not dry_run:
        validate_index_proof(operator, checkpoint, index_readback)
    try:
        conn.execute("BEGIN IMMEDIATE")
        active = conn.execute(
            "SELECT 1 FROM ava_module_deployments d JOIN instances i ON i.id=d.businessId "
            "WHERE d.id=? AND d.businessId=? AND d.module='onyx' AND d.state='verified' "
            "AND d.revision=? AND d.namespace=? AND i.isActive=1",
            (deployment_id, business_id, revision, operator["nativeScope"]),
        ).fetchone()
        require(active is not None, "DEPLOYMENT_NOT_ACTIVE")
        require(current_canonical(conn, business_id) == expected_documents, "CANONICAL_CHECKPOINT_STALE")
        if dry_run:
            conn.rollback()
            return len(expected_documents)
        validate_index_proof(operator, checkpoint, index_readback)
        # executescript() issues an implicit commit in sqlite3, which would
        # defeat the source fence above.  Execute the additive statements one
        # at a time so every mutation remains inside this BEGIN IMMEDIATE.
        for statement in ADDITIVE_DDL.split(";\n"):
            if statement.strip():
                conn.execute(statement)
        # Delete only this deployment's previous projection.  No legacy Onyx
        # table nor another deployment's native map is in this mutation set.
        conn.execute("DELETE FROM onyx_native_runtime_document_links WHERE deployment_id=?", (deployment_id,))
        conn.execute("DELETE FROM onyx_native_runtime_bindings WHERE deployment_id=?", (deployment_id,))
        conn.execute(
            "INSERT INTO onyx_native_runtime_bindings "
            "(deployment_id,deployment_revision,business_id,role,persona_id,document_set_name,search_tool_id) "
            "VALUES (?,?,?,?,?,?,?)",
            (deployment_id, revision, business_id, "sales", binding["persona_id"], binding["document_set_name"], binding["search_tool_id"]),
        )
        for source_id, document in expected_documents.items():
            conn.execute(
                "INSERT INTO onyx_native_runtime_document_links "
                "(deployment_id,deployment_revision,business_id,entity_type,source_id,onyx_document_id,content_hash) "
                "VALUES (?,?,?,?,?,?,?)",
                (deployment_id, revision, business_id, "knowledge", source_id,
                 quote(f"ava:{business_id}:knowledge:{source_id}", safe=""), document["content_hash"]),
            )
        conn.commit()
        return len(expected_documents)
    except Exception:
        conn.rollback()
        raise


def rollback(conn: sqlite3.Connection, operator: dict[str, Any], *, dry_run: bool = False) -> int:
    """Remove only this exact projection, retaining native data and legacy links."""
    try:
        conn.execute("BEGIN IMMEDIATE")
        match = conn.execute("SELECT 1 FROM ava_module_deployments WHERE id=? AND businessId=? AND module='onyx' AND revision=? AND namespace=?",
            (operator["deploymentId"], operator["businessId"], operator["revision"], operator["nativeScope"])).fetchone()
        require(match is not None, "DEPLOYMENT_SCOPE_CHANGED")
        count = 0
        for table in ("onyx_native_runtime_document_links", "onyx_native_runtime_bindings"):
            exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
            if not exists:
                continue
            rows = conn.execute(f"SELECT business_id,deployment_revision FROM {table} WHERE deployment_id=?", (operator["deploymentId"],)).fetchall()
            require(all(row == (operator["businessId"], operator["revision"]) for row in rows), "PROJECTION_SCOPE_CHANGED")
            count += len(rows)
            if not dry_run:
                conn.execute(f"DELETE FROM {table} WHERE deployment_id=? AND business_id=? AND deployment_revision=?",
                    (operator["deploymentId"], operator["businessId"], operator["revision"]))
        conn.rollback() if dry_run else conn.commit()
        return count
    except Exception:
        conn.rollback()
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="commit scoped projection; otherwise read-only plan")
    parser.add_argument("--rollback", action="store_true", help="remove only this deployment's own runtime metadata")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ProjectionError("ROOT_REQUIRED")
    config_path = Path(os.environ["AVA_ONYX_RECONCILE_CONFIG"])
    read_root_json(config_path)
    operator = reconciler.load_config(config_path)
    if not args.rollback:
        operator, receipt, checkpoint = load_projection_inputs(config_path,
            Path(os.environ["AVA_ONYX_KNOWLEDGE_BOOTSTRAP_RECEIPT"]), Path(os.environ["AVA_ONYX_RECONCILE_CHECKPOINT"]))
    index_readback = read_root_json(Path(os.environ["AVA_ONYX_INDEX_READBACK_FILE"])) if args.run and not args.rollback else None
    db_path = Path(os.environ["AVA_CRM_DB_PATH"]).resolve()
    # Dry-run must not accidentally create/migrate a missing database.
    uri = db_path.as_uri() + ("?mode=rw" if args.run else "?mode=ro")
    with sqlite3.connect(uri, uri=True, timeout=15, isolation_level=None) as conn:
        count = rollback(conn, operator, dry_run=not args.run) if args.rollback else project(conn, operator, receipt, checkpoint, dry_run=not args.run, index_readback=index_readback)
    print(json.dumps({"rows": count, "businessId": operator["businessId"], "deploymentId": operator["deploymentId"],
                      "dryRun": not args.run, "rollback": args.rollback, "searchabilityVerified": False}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ProjectionError, reconciler.ReconcileError, sqlite3.Error, KeyError, OSError):
        raise SystemExit("ONYX_NATIVE_KNOWLEDGE_PROJECTION_FAILED") from None
