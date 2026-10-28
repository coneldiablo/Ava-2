"""Two-isolated-deployment negative probe for Community Redis auth state.

Modes are selected with ``AVA_NATIVE_QA_CROSS_SCOPE_MODE=export|check|cleanup``.
This is deliberately direct native access, not a storage-ACL acceptance claim.
It is intended only for disposable QA mounts beneath ``/run/ava-qa``.
"""
from __future__ import annotations

import asyncio
import json
import os
import stat
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from .core import Denied, Unavailable, identifier, integer
from .native import CommunityOnyx

QA_ROOT = Path("/run/ava-qa")
TTL_SECONDS = 300


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise Denied()
    return value


def qa_path(name: str) -> Path:
    path = Path(required(name))
    if not path.is_absolute() or '..' in path.parts or path.parent != QA_ROOT:
        raise Denied()
    if not QA_ROOT.is_dir() or QA_ROOT.is_symlink():
        raise Denied()
    return path


def read_proof(path: Path) -> dict[str, Any]:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.geteuid())
                or stat.S_IMODE(info.st_mode) != 0o600):
            raise Denied()
        raw = os.read(fd, 4097)
        if len(raw) > 4096:
            raise Denied()
    finally:
        os.close(fd)
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise Denied() from None
    expected = {"businessId", "deploymentId", "nativeUserId", "token", "expiresAt"}
    if not isinstance(value, dict) or set(value) != expected:
        raise Denied()
    if type(value["businessId"]) is not int or value["businessId"] < 900000:
        raise Denied()
    identifier(value["deploymentId"])
    identifier(value["nativeUserId"])
    if not isinstance(value["token"], str) or not value["token"]:
        raise Denied()
    if type(value["expiresAt"]) is not int:
        raise Denied()
    return value


def write_proof(path: Path, proof: dict[str, Any]) -> None:
    if path.exists() or path.is_symlink():
        raise Denied()
    fd, temporary = tempfile.mkstemp(prefix=".ava-cross-scope-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", closefd=True) as stream:
            json.dump(proof, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        # Atomic no-overwrite publish: a concurrent export may not replace a
        # live proof belonging to an earlier run.
        os.link(temporary, path)
        os.unlink(temporary)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def own_contour() -> tuple[int, str]:
    if os.environ.get("AVA_NATIVE_QA") != "true":
        raise Denied()
    business_id = integer(int(required("AVA_BUSINESS_ID")))
    if business_id < 900000:
        raise Denied()
    return business_id, identifier(required("AVA_DEPLOYMENT_ID"))


async def export() -> None:
    business_id, deployment_id = own_contour()
    path = qa_path("AVA_NATIVE_QA_PROOF_FILE")
    native = CommunityOnyx()
    if native.backend_name != "redis":
        raise Unavailable()
    native_user_id = str(uuid.uuid4())
    expires_at = int(time.time() * 1000) + TTL_SECONDS * 1000
    await native.ensure_user(native_user_id)
    token = await native.write_token(native_user_id, TTL_SECONDS)
    if not await native.read_token(token, native_user_id, expires_at):
        await native.destroy_token(token, native_user_id)
        await native.disable_user(native_user_id)
        raise Unavailable()
    try:
        write_proof(path, {"businessId": business_id, "deploymentId": deployment_id,
                           "nativeUserId": native_user_id, "token": token, "expiresAt": expires_at})
    except Exception:
        await native.destroy_token(token, native_user_id)
        await native.disable_user(native_user_id)
        raise


async def check() -> dict[str, bool]:
    business_id, deployment_id = own_contour()
    foreign = read_proof(qa_path("AVA_NATIVE_QA_FOREIGN_PROOF_FILE"))
    own = read_proof(qa_path("AVA_NATIVE_QA_PROOF_FILE"))
    if foreign["businessId"] == business_id or foreign["deploymentId"] == deployment_id:
        raise Denied()
    if foreign["expiresAt"] <= int(time.time() * 1000):
        raise Denied()
    if (own["businessId"], own["deploymentId"]) != (business_id, deployment_id) or own["expiresAt"] <= int(time.time() * 1000):
        raise Denied()
    native = CommunityOnyx()
    if native.backend_name != "redis":
        raise Unavailable()
    try:
        await native._user(foreign["nativeUserId"])
        foreign_identity_absent = False
    except Denied:
        foreign_identity_absent = True
    foreign_token_rejected = not await native.read_token(
        foreign["token"], foreign["nativeUserId"], foreign["expiresAt"]
    )
    own_token_live = await native.read_token(own["token"], own["nativeUserId"], own["expiresAt"])
    evidence = {"foreign_contour": True, "foreign_identity_absent": foreign_identity_absent,
                "foreign_token_rejected": foreign_token_rejected, "own_token_live": own_token_live}
    if not all(evidence.values()):
        raise Unavailable()
    return evidence


async def cleanup() -> dict[str, bool]:
    business_id, deployment_id = own_contour()
    path = qa_path("AVA_NATIVE_QA_PROOF_FILE")
    own = read_proof(path)
    if (own["businessId"], own["deploymentId"]) != (business_id, deployment_id):
        raise Denied()
    native = CommunityOnyx()
    await native.destroy_token(own["token"], own["nativeUserId"])
    absent = not await native.read_token(own["token"], own["nativeUserId"], own["expiresAt"])
    if not absent:
        raise Unavailable()
    await native.disable_user(own["nativeUserId"])
    os.unlink(path)
    return {"token_absent": True, "identity_disabled": True, "proof_removed": not path.exists()}


async def execute() -> tuple[bool, dict[str, bool] | None]:
    mode = required("AVA_NATIVE_QA_CROSS_SCOPE_MODE")
    if mode == "export":
        await export()
        return True, None
    if mode == "check":
        return True, await check()
    if mode == "cleanup":
        return True, await cleanup()
    raise Denied()


def main() -> int:
    try:
        ok, evidence = asyncio.run(execute())
    except Exception:
        # No errors, payloads, or connection facts leave this process.
        print(json.dumps({"ok": False, "stage": "cross_scope_probe_failed"}, separators=(",", ":")))
        return 1
    if evidence is not None:
        print(json.dumps({"ok": ok, "evidence": evidence}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
