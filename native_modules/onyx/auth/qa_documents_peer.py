"""Disposable document QA through the running private auth peer.

This sidecar never opens the auth SQLite state, reads its encryption key, or
constructs ``Store``/``CommunityOnyx``. Provision, session mint/revoke and
per-user disable go through the real 4011 peer API. Document operations still
traverse the guarded Onyx API and deletion completion is observed in the real
tenant-scoped OpenSearch index.
"""
from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import time
import traceback
from typing import Any
import uuid

import httpx

from .core import Config, Denied, Unavailable, identifier, integer, read_secret
from .qa_documents import (
    _extract_file_id,
    _extract_file_status,
    _required,
    _user_payload,
    check_opensearch_cross_scope,
    poll_opensearch_count,
)


MAX_PEER_RESPONSE = 16 * 1024


def _source_hashes() -> dict[str, str]:
    files = {name: Path(__file__).with_name(name) for name in ("qa_documents.py", "qa_documents_peer.py")}
    hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()}
    bundle = hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"probe_sha256": hashes["qa_documents_peer.py"],
            "helper_sha256": hashes["qa_documents.py"], "source_bundle_sha256": bundle}


async def _remote_client(stack: AsyncExitStack, supplied: httpx.AsyncClient | None,
                         env_name: str, allowed: str) -> httpx.AsyncClient:
    if supplied is not None:
        if not str(supplied.base_url).strip("/"):
            supplied.base_url = httpx.URL("http://fixture.invalid")
        return supplied
    if os.environ.get(env_name) != allowed:
        raise Denied()
    return await stack.enter_async_context(httpx.AsyncClient(
        base_url=allowed, timeout=30.0, follow_redirects=False
    ))


async def _peer_call(client: httpx.AsyncClient, path: str, payload: dict,
                     secret: bytes) -> dict:
    try:
        response = await client.post(path, json=payload, headers={
            "Authorization": "Bearer " + secret.decode("ascii", "strict"),
        })
        if response.status_code == 403:
            raise Denied()
        if response.status_code != 200 or len(response.content) > MAX_PEER_RESPONSE:
            raise Unavailable()
        value = response.json()
        if not isinstance(value, dict):
            raise Unavailable()
        return value
    except (Denied, Unavailable):
        raise
    except Exception as exc:
        raise Unavailable() from exc


async def _peer_denied(client: httpx.AsyncClient, path: str, payload: dict,
                       secret: bytes) -> bool:
    try:
        response = await client.post(path, json=payload, headers={
            "Authorization": "Bearer " + secret.decode("ascii", "strict"),
        })
    except Exception as exc:
        raise Unavailable() from exc
    if response.status_code == 403:
        return True
    if response.status_code != 200:
        raise Unavailable()
    return False


def _user_receipt(value: dict, expected: dict, state: str) -> None:
    fields = {*expected, "nativeUserId", "state"}
    if (set(value) != fields or any(value[key] != expected[key] for key in expected)
            or value.get("state") != state):
        raise Unavailable()
    identifier(value.get("nativeUserId"))


async def probe(*, auth_client: httpx.AsyncClient | None = None,
                api_client: httpx.AsyncClient | None = None,
                max_poll_iterations: int = 60,
                poll_interval: float = 1.0) -> dict[str, bool]:
    if os.environ.get("AVA_NATIVE_QA") != "true":
        raise Denied()
    business_id = integer(int(_required("AVA_BUSINESS_ID")))
    if business_id not in (911001, 911002):
        raise Denied()
    deployment_id = identifier(_required("AVA_DEPLOYMENT_ID"))
    namespace = _required("AVA_DEPLOYMENT_NAMESPACE")
    config = Config(business_id, deployment_id, namespace, b"\0" * 32)
    gateway_secret = read_secret(_required("AVA_AUTH_GATEWAY_KEY_FILE"))
    worker_secret = read_secret(_required("AVA_AUTH_WORKER_KEY_FILE"))
    native_peer = read_secret(_required("AVA_NATIVE_HTTP_GATEWAY_KEY_FILE"))
    if gateway_secret != native_peer:
        raise Denied()

    evidence = {key: False for key in (
        "provisioned", "session_created", "upload_status_ok", "file_indexed_completed",
        "opensearch_indexed", "foreign_scope_provision_denied",
        "unknown_binding_read_denied", "unknown_binding_delete_denied",
        "cross_scope_opensearch_denied", "file_deleted", "opensearch_purged",
        "session_revoked", "session_revoke_idempotent", "user_disabled",
        "late_session_denied", "late_provision_denied", "cleaned_up",
    )}
    user_id, binding_id = str(uuid.uuid4()), str(uuid.uuid4())
    user = _user_payload(config, user_id, "qa-doc-" + uuid.uuid4().hex)
    session_payload: dict[str, Any] | None = None
    guard_headers: dict[str, str] | None = None
    file_id: str | None = None

    async with AsyncExitStack() as stack:
        auth = await _remote_client(stack, auth_client, "AVA_AUTH_URL", "http://auth:4011")
        api = await _remote_client(stack, api_client, "AVA_ONYX_API_URL", "http://api:8080")
        cleanup_ok = False
        try:
            provisioned = await _peer_call(auth, "/v1/provision", user, worker_secret)
            _user_receipt(provisioned, user, "active")
            evidence["provisioned"] = True
            session_payload = {**user, "bindingId": binding_id,
                               "nativeUserId": provisioned["nativeUserId"],
                               "expiresAt": int(time.time() * 1000) + 5 * 60 * 1000}
            session = await _peer_call(auth, "/v1/sessions/create", session_payload, gateway_secret)
            expected_session = {key: session_payload[key] for key in (
                "businessId", "deploymentId", "bindingId", "userId", "nativeUserId", "nativeScope"
            )}
            if (any(session.get(key) != value for key, value in expected_session.items())
                    or set(session) != {*expected_session, "nativeCookie", "nativeSessionId"}
                    or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}=[A-Za-z0-9_-]{20,256}", session.get("nativeCookie", ""))
                    or not re.fullmatch(r"[0-9a-f]{64}", session.get("nativeSessionId", ""))):
                raise Unavailable()
            evidence["session_created"] = True
            guard_headers = {"X-Ava-Native-Peer": native_peer.decode("ascii"),
                             "X-Ava-Native-Binding": binding_id,
                             "Cookie": session["nativeCookie"]}

            filename = f"qa-document-{uuid.uuid4().hex[:8]}.txt"
            upload = await api.post("/user/projects/file/upload",
                                    files={"files": (filename, b"AVA QA document lifecycle through the permanent auth peer.\n", "text/plain")},
                                    headers=guard_headers)
            if upload.status_code not in (200, 201):
                raise Unavailable()
            file_id = identifier(_extract_file_id(upload.json()))
            evidence["upload_status_ok"] = True
            for _ in range(max_poll_iterations):
                status = await api.post("/user/projects/file/statuses", json={"file_ids": [file_id]}, headers=guard_headers)
                if status.status_code == 200:
                    current = _extract_file_status(status.json(), file_id)
                    if current == "COMPLETED":
                        evidence["file_indexed_completed"] = True
                        break
                    if current in ("FAILED", "CANCELED", "SKIPPED"):
                        raise Unavailable()
                await asyncio.sleep(poll_interval)
            if not evidence["file_indexed_completed"]:
                raise Unavailable()
            if await poll_opensearch_count(namespace, file_id=file_id, expect_positive=True,
                                           max_attempts=max_poll_iterations, interval=poll_interval) <= 0:
                raise Unavailable()
            evidence["opensearch_indexed"] = True

            foreign_namespace = "ava_" + uuid.uuid4().hex
            foreign = {**user, "businessId": 911002 if business_id != 911002 else 911001,
                       "deploymentId": str(uuid.uuid4()), "nativeScope": foreign_namespace}
            evidence["foreign_scope_provision_denied"] = await _peer_denied(
                auth, "/v1/provision", foreign, worker_secret
            )
            unknown = {**guard_headers, "X-Ava-Native-Binding": str(uuid.uuid4())}
            read_denied = await api.get(f"/user/projects/file/{file_id}", headers=unknown)
            delete_denied = await api.delete(f"/user/projects/file/{file_id}", headers=unknown)
            evidence["unknown_binding_read_denied"] = read_denied.status_code == 403
            evidence["unknown_binding_delete_denied"] = delete_denied.status_code == 403
            evidence["cross_scope_opensearch_denied"] = await check_opensearch_cross_scope(foreign_namespace)
            if not all(evidence[key] for key in (
                "foreign_scope_provision_denied", "unknown_binding_read_denied",
                "unknown_binding_delete_denied", "cross_scope_opensearch_denied"
            )):
                raise Denied()

            deleted = await api.delete(f"/user/projects/file/{file_id}", headers=guard_headers)
            if deleted.status_code not in (200, 204):
                raise Unavailable()
            if deleted.status_code == 200 and deleted.json().get("has_associations") is not False:
                raise Unavailable()
            evidence["file_deleted"] = True
            if await poll_opensearch_count(namespace, file_id=file_id, expect_positive=False,
                                           max_attempts=max_poll_iterations, interval=poll_interval) != 0:
                raise Unavailable()
            evidence["opensearch_purged"] = True
        finally:
            if guard_headers is not None and file_id is not None and not evidence["file_deleted"]:
                try:
                    await api.delete(f"/user/projects/file/{file_id}", headers=guard_headers)
                except Exception:
                    pass
            if session_payload is not None:
                try:
                    revoked = await _peer_call(auth, "/v1/sessions/revoke", {"bindingId": binding_id}, gateway_secret)
                    evidence["session_revoked"] = revoked == {"bindingId": binding_id, "nativeSessionAbsent": True}
                    again = await _peer_call(auth, "/v1/sessions/revoke", {"bindingId": binding_id}, gateway_secret)
                    evidence["session_revoke_idempotent"] = again == revoked
                except Exception:
                    pass
            if evidence["provisioned"]:
                try:
                    disabled = await _peer_call(auth, "/v1/users/disable", user, worker_secret)
                    _user_receipt({key: disabled[key] for key in disabled if key != "nativeSessionsAbsent"}, user, "disabled")
                    evidence["user_disabled"] = disabled.get("nativeSessionsAbsent") is True
                    if session_payload is not None:
                        evidence["late_session_denied"] = await _peer_denied(
                            auth, "/v1/sessions/create", session_payload, gateway_secret
                        )
                    evidence["late_provision_denied"] = await _peer_denied(
                        auth, "/v1/provision", user, worker_secret
                    )
                except Exception:
                    pass
            cleanup_ok = all(evidence[key] for key in (
                "session_revoked", "session_revoke_idempotent", "user_disabled",
                "late_session_denied", "late_provision_denied",
            ))
            evidence["cleaned_up"] = cleanup_ok
    if not all(evidence.values()):
        raise Unavailable()
    return evidence


def main() -> int:
    try:
        started = int(time.time() * 1000)
        evidence = asyncio.run(probe())
        sources = _source_hashes()
        print(json.dumps({
            "ok": True, "qa_only": True, "buyer_acceptance": False, "rag_acceptance": False,
            "schema_version": 3, "run_id": str(uuid.uuid4()), "started_at_ms": started,
            "completed_at_ms": int(time.time() * 1000),
            "business_id": integer(int(_required("AVA_BUSINESS_ID"))),
            "deployment_id": identifier(_required("AVA_DEPLOYMENT_ID")),
            "namespace": _required("AVA_DEPLOYMENT_NAMESPACE"),
            **sources,
            "transport": "running_auth_peer_and_native_http",
            "deletion": "native_endpoint_and_worker_observed",
            "file_scope_negative": "unknown_binding_guard_only",
            "evidence": evidence,
        }, separators=(",", ":")))
        return 0
    except Exception as error:
        frames = [{"file": Path(frame.filename).name, "function": frame.name, "line": frame.lineno}
                  for frame in traceback.extract_tb(error.__traceback__)[-8:]]
        print(json.dumps({"ok": False, "stage": "document_peer_qa_failed",
                          "error_type": type(error).__name__, "frames": frames}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
