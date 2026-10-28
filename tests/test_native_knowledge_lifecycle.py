"""Synthetic native lifecycle contracts; no live indexing or buyer proof."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import uuid
import time

import pytest


ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


sync = load("native_sync_fixture", "reconcile-onyx-native-knowledge.py")
projection = load("native_projection_fixture", "project-onyx-native-knowledge.py")


@pytest.fixture
def contour(tmp_path):
    deployment = str(uuid.uuid4())
    config = {"businessId": 4, "deploymentId": deployment, "nativeScope": "ava_" + deployment.replace("-", ""),
              "revision": 3, "ownerUserId": str(uuid.uuid4()), "runtimeUserId": str(uuid.uuid4()),
              "ownerCcPairId": 11, "runtimeCcPairId": 12, "documentSetId": 13}
    db_path = tmp_path / "crm.db"
    with sqlite3.connect(db_path) as db:
        db.executescript("""
        CREATE TABLE instances(id INTEGER PRIMARY KEY,isActive INTEGER);
        CREATE TABLE ava_module_deployments(id TEXT,businessId INTEGER,module TEXT,state TEXT,revision INTEGER,namespace TEXT);
        CREATE TABLE knowledge_base(id INTEGER PRIMARY KEY,instanceId INTEGER,business_id INTEGER,originalName TEXT,
            contentHash TEXT,version INTEGER,isCurrent INTEGER,content TEXT);
        CREATE TABLE kb_chunks(id INTEGER PRIMARY KEY,kbId INTEGER,chunkIndex INTEGER,text TEXT);
        CREATE TABLE onyx_document_links(business_id INTEGER,source_id INTEGER,content_hash TEXT);
        INSERT INTO instances VALUES(4,1),(9,1);
        INSERT INTO knowledge_base VALUES(7,4,4,'SYNTHETIC own','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,1,NULL);
        INSERT INTO knowledge_base VALUES(8,9,9,'SYNTHETIC foreign','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',1,1,NULL);
        INSERT INTO kb_chunks VALUES(1,7,0,'SYNTHETIC business4 marker'),(2,8,0,'SYNTHETIC business9 marker');
        INSERT INTO onyx_document_links VALUES(9,8,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
        """)
        db.execute("INSERT INTO ava_module_deployments VALUES(?,?, 'onyx','verified',?,?)",
            (deployment, 4, 3, config["nativeScope"]))
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps(config)); config_path.chmod(0o600)
    key_path = tmp_path / "key"
    key_path.write_text("S" * 43); key_path.chmod(0o600)
    checkpoint = tmp_path / "checkpoint.json"
    args = {"config_path": config_path, "crm_db": db_path, "checkpoint_path": checkpoint,
            "api_url": "http://127.0.0.1:3043", "worker_key_path": key_path}
    return config, args


def ack(_url, _key, path, payload):
    document_id = payload["document"]["id"] if path.endswith("upsert") else payload["documentId"]
    return {"document_id": document_id, **({"deleted": True} if path.endswith("delete") else {})}


def checkpoint_for(config):
    return {"version": 1, "scope": {key: config[key] for key in ("businessId", "deploymentId", "nativeScope", "revision")},
            "documents": {"ava:4:knowledge:7": {"source_id": "7", "revision": 1, "content_hash": "a" * 32}}}


def receipt_for(config):
    return {**{key: config[key] for key in ("businessId", "deploymentId", "revision")}, "binding": {
        "persona_id": 14, "search_tool_id": 1, "document_set_name": "ava-native-" + config["deploymentId"].replace("-", "") + "-knowledge",
        "owner_cc_pair_id": 11, "runtime_cc_pair_id": 12, "document_set_id": 13}}


def index_proof(config, checkpoint):
    return {"scope": checkpoint["scope"], "checkedAt": int(time.time() * 1000), "indexReadinessVerified": True,
            "indexProbeMethod": "default_document_index_random_acl_v1", "indexedDocuments": {
                key: {"onyx_document_id": projection.quote(key, safe=""), "source_id": item["source_id"], "content_hash": item["content_hash"]}
                for key, item in checkpoint["documents"].items()}}


def test_dry_run_never_reads_key_or_sends_or_saves(contour, monkeypatch):
    config, args = contour
    args["worker_key_path"].unlink()
    monkeypatch.setattr(sync, "_request", lambda *_: pytest.fail("dry-run contacted native API"))
    result = sync.plan(**{key: args[key] for key in ("config_path", "crm_db", "checkpoint_path")})
    assert result == {"businessId": 4, "upserted": 1, "deleted": 0, "unchanged": 0, "dryRun": True, "searchabilityVerified": False}
    assert not args["checkpoint_path"].exists()


def test_generic_catchup_is_scoped_and_idempotent(contour, monkeypatch):
    _config, args = contour
    seen = []
    def request(*items):
        seen.append(items[-1]); return ack(*items)
    monkeypatch.setattr(sync, "_request", request)
    assert sync.reconcile(**args)["upserted"] == 1
    assert sync.reconcile(**args) == {"upserted": 0, "deleted": 0, "unchanged": 1, "searchabilityVerified": False}
    assert len(seen) == 1 and seen[0]["document"]["id"] == "ava:4:knowledge:7"
    assert "business9" not in json.dumps(seen)
    assert "SYNTHETIC" not in args["checkpoint_path"].read_text()


def test_last_chunk_deletion_sends_idempotent_remote_delete(contour, monkeypatch):
    _config, args = contour
    monkeypatch.setattr(sync, "_request", ack)
    sync.reconcile(**args)
    with sqlite3.connect(args["crm_db"]) as db:
        db.execute("DELETE FROM kb_chunks WHERE kbId=7")
    assert sync.reconcile(**args)["deleted"] == 1
    assert sync.reconcile(**args)["deleted"] == 0
    assert sync.read_checkpoint(args["checkpoint_path"], _config)["documents"] == {}


@pytest.mark.parametrize("mutation", ["UPDATE instances SET isActive=0 WHERE id=4", "UPDATE ava_module_deployments SET revision=4",
    "UPDATE ava_module_deployments SET state='disabled'", "UPDATE ava_module_deployments SET businessId=9"])
def test_inactive_changed_or_foreign_deployment_never_sends(contour, monkeypatch, mutation):
    _config, args = contour
    with sqlite3.connect(args["crm_db"]) as db: db.execute(mutation)
    monkeypatch.setattr(sync, "_request", lambda *_: pytest.fail("invalid deployment sent a document"))
    with pytest.raises(sync.ReconcileError, match="deployment not active"): sync.reconcile(**args)
    assert not args["checkpoint_path"].exists()


@pytest.mark.parametrize("failure", ["foreign-ack", "source-race", "revoke-race"])
def test_wrong_ack_or_postwrite_race_cannot_advance_checkpoint(contour, monkeypatch, failure):
    _config, args = contour
    def request(*items):
        if failure == "foreign-ack": return {"document_id": "ava:9:knowledge:8"}
        with sqlite3.connect(args["crm_db"]) as db:
            db.execute("UPDATE knowledge_base SET contentHash=? WHERE id=7", ("c" * 32,)) if failure == "source-race" else db.execute("UPDATE instances SET isActive=0 WHERE id=4")
        return ack(*items)
    monkeypatch.setattr(sync, "_request", request)
    with pytest.raises(sync.ReconcileError): sync.reconcile(**args)
    assert not args["checkpoint_path"].exists()


def test_projection_and_rollback_are_generic_and_leave_foreign_and_legacy_rows(contour):
    config, args = contour
    with sqlite3.connect(args["crm_db"], isolation_level=None) as db:
        receipt, checkpoint = receipt_for(config), checkpoint_for(config)
        assert projection.project(db, config, receipt, checkpoint, dry_run=True) == 1
        assert db.execute("SELECT name FROM sqlite_master WHERE name='onyx_native_runtime_bindings'").fetchone() is None
        assert projection.project(db, config, receipt, checkpoint, index_readback=index_proof(config, checkpoint)) == 1
        assert projection.project(db, config, receipt, checkpoint, index_readback=index_proof(config, checkpoint)) == 1
        db.execute("INSERT INTO onyx_native_runtime_document_links VALUES('foreign',1,9,'knowledge',8,'ava%3A9%3Aknowledge%3A8',?)", ("b" * 32,))
        assert projection.rollback(db, config) == 2
        assert projection.rollback(db, config) == 0
        assert db.execute("SELECT business_id FROM onyx_native_runtime_document_links").fetchall() == [(9,)]
        assert db.execute("SELECT business_id FROM onyx_document_links").fetchall() == [(9,)]


def test_projection_refuses_stale_sources_or_mismatched_native_binding(contour):
    config, args = contour
    with sqlite3.connect(args["crm_db"], isolation_level=None) as db:
        receipt, checkpoint = receipt_for(config), checkpoint_for(config)
        wrong = json.loads(json.dumps(receipt)); wrong["binding"]["document_set_id"] = 99
        with pytest.raises(projection.ProjectionError, match="BINDING_SCOPE"): projection.project(db, config, wrong, checkpoint)
        db.execute("UPDATE knowledge_base SET contentHash=? WHERE id=7", ("c" * 32,))
        with pytest.raises(projection.ProjectionError, match="CHECKPOINT_STALE"): projection.project(db, config, receipt, checkpoint, index_readback=index_proof(config, checkpoint))


def test_runtime_projection_rejects_missing_foreign_expired_or_stale_index_readback(contour):
    config, args = contour; receipt, checkpoint = receipt_for(config), checkpoint_for(config)
    for proof in (None, {**index_proof(config, checkpoint), "checkedAt": 1},
                  {**index_proof(config, checkpoint), "indexedDocuments": {}},
                  {**index_proof(config, checkpoint), "scope": {**checkpoint["scope"], "businessId": 9}}):
        with sqlite3.connect(args["crm_db"], isolation_level=None) as db:
            with pytest.raises(projection.ProjectionError, match="INDEX_PROOF"):
                projection.project(db, config, receipt, checkpoint, index_readback=proof)
            assert db.execute("SELECT name FROM sqlite_master WHERE name='onyx_native_runtime_document_links'").fetchone() is None
        assert db.execute("SELECT name FROM sqlite_master WHERE name='onyx_native_runtime_bindings'").fetchone() is None


def test_lock_symlink_fails_without_touching_target(contour, tmp_path, monkeypatch):
    _config, args = contour
    target = tmp_path / "unrelated"
    target.write_text("unchanged")
    args["checkpoint_path"].with_suffix(".json.lock").symlink_to(target)
    monkeypatch.setattr(sync, "_request", lambda *_: pytest.fail("symlink lock sent a document"))
    with pytest.raises(OSError): sync.reconcile(**args)
    assert target.read_text() == "unchanged"
