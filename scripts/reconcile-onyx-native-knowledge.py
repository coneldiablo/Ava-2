#!/usr/bin/env python3
"""Reconcile CRM canonical knowledge into the isolated Community worker.

Configuration and the bearer are supplied by root-owned files/environment, not
argv.  The checkpoint contains only source IDs, revisions and hashes; it never
contains document text or credentials.
"""
from __future__ import annotations

import hashlib
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, ProxyHandler


class ReconcileError(Exception):
    pass


CONFIG_FIELDS = {
    "businessId", "deploymentId", "nativeScope", "revision", "ownerUserId",
    "runtimeUserId", "ownerCcPairId", "runtimeCcPairId", "documentSetId",
}
HASH_RE = re.compile(r"^(?:[0-9a-f]{32}|[0-9a-f]{64})$")


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ReconcileError("worker redirect rejected")


_OPENER = build_opener(ProxyHandler({}), _NoRedirect)


def _read_private(path: Path, *, json_file: bool = False) -> bytes:
    limit = 64 * 1024 if json_file else 4096
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as exc:
        raise ReconcileError("private input unavailable") from exc
    try:
        st = os.fstat(fd)
        if (not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077
                or st.st_uid not in (0, os.getuid()) or st.st_size < 1 or st.st_size > limit):
            raise ReconcileError("private input permissions invalid")
        data = os.read(fd, limit + 1)
        if not data or len(data) > limit:
            raise ReconcileError("private input size invalid")
        return data
    except OSError as exc:
        raise ReconcileError("private input unreadable") from exc
    finally:
        os.close(fd)


def load_config(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(_read_private(path, json_file=True))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ReconcileError("trusted config invalid") from exc
    if not isinstance(value, dict) or set(value) != CONFIG_FIELDS:
        raise ReconcileError("trusted config fields invalid")
    if type(value["businessId"]) is not int or value["businessId"] < 1:
        raise ReconcileError("trusted config business invalid")
    if (not isinstance(value["deploymentId"], str)
            or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", value["deploymentId"])
            or value["nativeScope"] != "ava_" + value["deploymentId"].replace("-", "")):
        raise ReconcileError("trusted config deployment invalid")
    if type(value["revision"]) is not int or value["revision"] < 1:
        raise ReconcileError("trusted config revision invalid")
    for field in ("ownerUserId", "runtimeUserId"):
        if not isinstance(value[field], str) or not value[field].strip():
            raise ReconcileError("trusted config users invalid")
    for field in ("ownerCcPairId", "runtimeCcPairId", "documentSetId"):
        if type(value[field]) is not int or value[field] < 1:
            raise ReconcileError("trusted config resource invalid")
    if value["ownerCcPairId"] == value["runtimeCcPairId"]:
        raise ReconcileError("trusted config pairs collide")
    return value


def allowed_api_url(value: str) -> str:
    parsed = urlparse(value.rstrip("/"))
    if (parsed.scheme not in ("http", "https") or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        raise ReconcileError("worker URL invalid")
    if parsed.hostname not in {"127.0.0.1", "localhost", "onyx-knowledge", "onyx_knowledge", "knowledge-api"}:
        raise ReconcileError("worker URL outside private allowlist")
    return value.rstrip("/")


def read_checkpoint(path: Path, config: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "scope": {k: config[k] for k in ("businessId", "deploymentId", "nativeScope", "revision")}, "documents": {}}
    try:
        value = json.loads(_read_private(path, json_file=True))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ReconcileError("checkpoint invalid") from exc
    expected_scope = {k: config[k] for k in ("businessId", "deploymentId", "nativeScope", "revision")}
    if not isinstance(value, dict) or value.get("version") != 1 or value.get("scope") != expected_scope or not isinstance(value.get("documents"), dict):
        raise ReconcileError("checkpoint scope invalid")
    for doc_id, item in value["documents"].items():
        prefix = f"ava:{config['businessId']}:knowledge:"
        if (not isinstance(doc_id, str) or not doc_id.startswith(prefix)
                or not isinstance(item, dict) or set(item) != {"source_id", "revision", "content_hash"}):
            raise ReconcileError("checkpoint document invalid")
        source_id = doc_id[len(prefix):]
        if (not source_id.isdigit() or source_id != item.get("source_id")
                or type(item.get("revision")) is not int or item["revision"] < 1
                or not HASH_RE.fullmatch(item["content_hash"])):
            raise ReconcileError("checkpoint hash invalid")
    return value


def write_checkpoint(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def read_canonical_documents(db_path: Path, business_id: int) -> dict[str, dict[str, Any]]:
    try:
        db = sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        columns = {row[1] for row in db.execute("PRAGMA table_info(knowledge_base)")}
        required = {"id", "instanceId", "originalName", "contentHash", "version", "isCurrent"}
        if not required <= columns:
            raise ReconcileError("CRM knowledge schema invalid")
        tenant = " AND (business_id IS NULL OR business_id=instanceId)" if "business_id" in columns else ""
        content_column = "content" if "content" in columns else "NULL AS content"
        rows = db.execute(
            f"SELECT id, originalName, contentHash, version, {content_column} FROM knowledge_base "
            f"WHERE instanceId=? AND isCurrent=1{tenant} ORDER BY id", (business_id,)
        ).fetchall()
        result: dict[str, dict[str, Any]] = {}
        for row in rows:
            source_id = str(row["id"])
            digest = row["contentHash"]
            if not isinstance(digest, str) or not HASH_RE.fullmatch(digest):
                raise ReconcileError("CRM canonical hash invalid")
            chunks = db.execute(
                "SELECT text FROM kb_chunks WHERE kbId=? ORDER BY chunkIndex, id", (row["id"],)
            ).fetchall()
            text = "\n\n".join(str(chunk["text"]) for chunk in chunks if chunk["text"] is not None).strip()
            # Parsed chunks are authoritative. Removing the last chunk is an
            # empty source and must reconcile its old remote document away.
            if not text:
                continue
            if len(text.encode("utf-8")) > 512 * 1024:
                raise ReconcileError("CRM canonical text invalid")
            title = str(row["originalName"] or "").strip()
            if not title or len(title.encode("utf-8")) > 512:
                raise ReconcileError("CRM canonical title invalid")
            doc_id = f"ava:{business_id}:knowledge:{source_id}"
            if type(row["version"]) is not int or row["version"] < 1:
                raise ReconcileError("CRM canonical revision invalid")
            result[doc_id] = {"id": doc_id, "title": title, "text": text, "source_id": source_id,
                              "content_hash": digest, "revision": row["version"]}
        return result
    except sqlite3.Error as exc:
        raise ReconcileError("CRM database unavailable") from exc
    finally:
        try:
            db.close()
        except UnboundLocalError:
            pass


def _request(base_url: str, key: bytes, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(payload, separators=(",", ":")).encode()
    request = Request(base_url + path, data=body, method="POST", headers={
        "Authorization": "Bearer " + key.decode("ascii"), "Content-Type": "application/json",
        "Content-Length": str(len(body)),
    })
    try:
        with _OPENER.open(request, timeout=120) as response:
            result = json.loads(response.read(128 * 1024))
    except (HTTPError, URLError, TimeoutError, ValueError, UnicodeDecodeError, OSError) as exc:
        raise ReconcileError("worker request failed") from exc
    if not isinstance(result, dict):
        raise ReconcileError("worker response invalid")
    return result


def deployment_fence(db_path: Path, config: dict[str, Any]) -> None:
    """A trusted file cannot reactivate a disabled/replaced deployment."""
    try:
        with sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True) as db:
            row = db.execute(
                "SELECT d.namespace FROM ava_module_deployments d JOIN instances i ON i.id=d.businessId "
                "WHERE d.id=? AND d.businessId=? AND d.module='onyx' AND d.state='verified' "
                "AND d.revision=? AND i.isActive=1",
                (config["deploymentId"], config["businessId"], config["revision"]),
            ).fetchone()
            if row != (config["nativeScope"],):
                raise ReconcileError("deployment not active")
    except sqlite3.Error as exc:
        raise ReconcileError("CRM deployment unavailable") from exc


def plan(*, config_path: Path, crm_db: Path, checkpoint_path: Path) -> dict[str, int | bool]:
    """Read-only catch-up plan: no credential read, network, or DB writes."""
    config = load_config(config_path)
    deployment_fence(crm_db, config)
    checkpoint = read_checkpoint(checkpoint_path, config)
    snapshot = read_canonical_documents(crm_db, config["businessId"])
    upserts = sum(checkpoint["documents"].get(doc_id) != {
        "source_id": doc["source_id"], "revision": doc["revision"], "content_hash": doc["content_hash"]
    } for doc_id, doc in snapshot.items())
    return {"businessId": config["businessId"], "upserted": upserts,
            "deleted": len(set(checkpoint["documents"]) - set(snapshot)), "unchanged": len(snapshot) - upserts,
            "dryRun": True, "searchabilityVerified": False}


def _reconcile_unlocked(*, config_path: Path, crm_db: Path, checkpoint_path: Path, api_url: str, worker_key_path: Path) -> dict[str, int | bool]:
    config = load_config(config_path)
    deployment_fence(crm_db, config)
    base_url = allowed_api_url(api_url)
    key = _read_private(worker_key_path)
    if not re.fullmatch(rb"[A-Za-z0-9._~-]{20,256}", key):
        raise ReconcileError("worker bearer invalid")
    checkpoint = read_checkpoint(checkpoint_path, config)
    snapshot = read_canonical_documents(crm_db, config["businessId"])
    common = {k: config[k] for k in ("businessId", "deploymentId", "nativeScope", "revision", "ownerUserId", "runtimeUserId", "ownerCcPairId", "runtimeCcPairId", "documentSetId")}
    upserts = deletes = 0
    for doc_id, document in snapshot.items():
        old = checkpoint["documents"].get(doc_id)
        if old != {"source_id": document["source_id"], "revision": document["revision"], "content_hash": document["content_hash"]}:
            deployment_fence(crm_db, config)
            response = _request(base_url, key, "/v1/knowledge/upsert", {**common, "document": {k: document[k] for k in ("id", "title", "text", "source_id", "content_hash")}})
            if response.get("document_id") != doc_id:
                raise ReconcileError("worker response scope invalid")
            upserts += 1
    for doc_id in set(checkpoint["documents"]) - set(snapshot):
        deployment_fence(crm_db, config)
        response = _request(base_url, key, "/v1/knowledge/delete", {**common, "documentId": doc_id})
        if response.get("document_id") != doc_id or response.get("deleted") not in (True, False):
            raise ReconcileError("worker response scope invalid")
        deletes += 1
    # Re-read after writes; never advance the checkpoint across a source race.
    if read_canonical_documents(crm_db, config["businessId"]) != snapshot:
        raise ReconcileError("CRM changed during reconciliation")
    deployment_fence(crm_db, config)
    if load_config(config_path) != config:
        raise ReconcileError("configuration changed during reconciliation")
    next_checkpoint = {"version": 1, "scope": {k: config[k] for k in ("businessId", "deploymentId", "nativeScope", "revision")},
                       "documents": {doc_id: {"source_id": doc["source_id"], "revision": doc["revision"], "content_hash": doc["content_hash"]} for doc_id, doc in snapshot.items()}}
    write_checkpoint(checkpoint_path, next_checkpoint)
    return {"upserted": upserts, "deleted": deletes, "unchanged": len(snapshot) - upserts,
            "searchabilityVerified": False}


@contextmanager
def _checkpoint_lock(path: Path):
    lock_path = path.with_name(path.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid()) or info.st_mode & 0o077:
            raise ReconcileError("checkpoint lock unsafe")
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def reconcile(*, config_path: Path, crm_db: Path, checkpoint_path: Path, api_url: str, worker_key_path: Path) -> dict[str, int]:
    with _checkpoint_lock(checkpoint_path):
        return _reconcile_unlocked(config_path=config_path, crm_db=crm_db, checkpoint_path=checkpoint_path,
                                   api_url=api_url, worker_key_path=worker_key_path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="read-only reconciliation counts; no credential access")
    args = parser.parse_args()
    try:
        common = dict(
            config_path=Path(os.environ["AVA_ONYX_RECONCILE_CONFIG"]),
            crm_db=Path(os.environ["AVA_CRM_DB_PATH"]),
            checkpoint_path=Path(os.environ["AVA_ONYX_RECONCILE_CHECKPOINT"]),
        )
        result = plan(**common) if args.dry_run else reconcile(**common,
            api_url=os.environ["AVA_ONYX_KNOWLEDGE_URL"],
            worker_key_path=Path(os.environ["AVA_AUTH_WORKER_KEY_FILE"]))
    except (KeyError, ReconcileError, OSError) as error:
        # Messages are fixed local labels; never include requests or credentials.
        print(json.dumps({'error': str(error) if isinstance(error, ReconcileError) else 'configuration missing'}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
