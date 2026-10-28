"""Destructive-free, isolated real-runtime document QA probe for AVA Onyx knowledge module.

Verifies document upload, indexing status polling, OpenSearch tenant count,
document deletion, physical OpenSearch purge, and cross-scope access denial.
Run only inside a disposable QA deployment:
``AVA_NATIVE_QA=true python -m onyx.ava_auth.qa_documents``. It never prints a
token, cookie, password, exception, SQL parameter, or connection detail.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import re
import secrets
import ssl
import tempfile
import time
import traceback
import uuid
from pathlib import Path
from typing import Any

try:
    import httpx
except ImportError:
    httpx = None  # type: ignore[assignment]

from .core import (
    Config,
    Denied,
    Service,
    Store,
    Unavailable,
    identifier,
    integer,
    read_secret,
)
from .native import CommunityOnyx


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise Denied()
    return value


def _user_payload(config: Config, user_id: str, subject: str, revision: int = 1) -> dict[str, Any]:
    return {
        "businessId": config.business_id,
        "deploymentId": config.deployment_id,
        "nativeScope": config.namespace,
        "userId": user_id,
        "subject": subject,
        "role": "manager",
        "revision": revision,
    }


def _extract_file_id(data: Any) -> str | None:
    if isinstance(data, dict):
        if "file_ids" in data and isinstance(data["file_ids"], list) and data["file_ids"]:
            return str(data["file_ids"][0])
        if "user_files" in data and isinstance(data["user_files"], list) and data["user_files"]:
            item = data["user_files"][0]
            if isinstance(item, dict):
                return str(item.get("id") or item.get("file_id") or "")
        if "id" in data:
            return str(data["id"])
    elif isinstance(data, list) and data:
        item = data[0]
        if isinstance(item, dict):
            return str(item.get("id") or item.get("file_id") or "")
    return None


def _extract_file_status(data: Any, file_id: str) -> str | None:
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and str(item.get("id") or item.get("file_id")) == file_id:
                return item.get("status")
    elif isinstance(data, dict):
        if file_id in data and isinstance(data[file_id], str):
            return data[file_id]
        for key in ("file_statuses", "statuses", "user_files"):
            if key in data and isinstance(data[key], list):
                for item in data[key]:
                    if isinstance(item, dict) and str(item.get("id") or item.get("file_id")) == file_id:
                        return item.get("status")
    return None


def _search_connection(namespace: str, *, base_url=None, username=None, password=None,
                       ca_certs=None, verify_certs=None):
    """Use only the scoped runtime principal and verified internal TLS."""
    own = _required("AVA_DEPLOYMENT_NAMESPACE")
    if not re.fullmatch(r"ava_[0-9a-f]{32}", namespace) or not re.fullmatch(r"ava_[0-9a-f]{32}", own):
        raise Denied()
    if verify_certs is False or os.environ.get("OPENSEARCH_VERIFY_CERTS", "true") != "true":
        raise Denied()
    url = base_url or os.environ.get("AVA_OPENSEARCH_URL", "https://search:9200")
    if url != "https://search:9200":
        raise Denied()
    user = username or os.environ.get("AVA_SEARCH_RUNTIME_USER") or os.environ.get("OPENSEARCH_ADMIN_USERNAME")
    # The upstream env variable is named ADMIN, but the recipe deliberately
    # supplies only a per-deployment runtime identity through it.
    if user != own + "_runtime":
        raise Denied()
    pwd = password or os.environ.get("AVA_SEARCH_RUNTIME_PASSWORD") or os.environ.get("OPENSEARCH_ADMIN_PASSWORD")
    if not isinstance(pwd, str) or len(pwd) < 32:
        raise Denied()
    ca_file = ca_certs or os.environ.get("OPENSEARCH_CA_CERTS", "/run/ava-search-ca/ca.pem")
    try:
        verify = ssl.create_default_context(cafile=ca_file) if Path(ca_file).is_file() else True
    except (OSError, ssl.SSLError) as exc:
        raise Unavailable() from exc
    return url, (user, pwd), verify


async def query_opensearch_count(namespace: str, *, file_id: str | None = None,
                                base_url=None, username=None, password=None,
                                ca_certs=None, verify_certs=None, timeout: float = 10.0) -> int:
    """Count exact uploaded document chunks; errors never mean empty storage."""
    if namespace != _required("AVA_DEPLOYMENT_NAMESPACE"):
        raise Denied()
    url, auth, verify = _search_connection(namespace, base_url=base_url, username=username,
                                          password=password, ca_certs=ca_certs, verify_certs=verify_certs)
    query = {"query": {"term": {"document_id": identifier(file_id)}}} if file_id is not None else {"query": {"match_all": {}}}
    try:
        async with httpx.AsyncClient(verify=verify, timeout=timeout, follow_redirects=False) as client:
            res = await client.post(url + f"/{namespace}_documents*/_count", json=query, auth=auth)
        if res.status_code == 403:
            raise Denied()
        if res.status_code != 200:
            raise Unavailable()
        data = res.json()
        count = data.get("count") if isinstance(data, dict) else None
        if type(count) is not int or count < 0 or data.get("_shards", {}).get("failed", 0) != 0:
            raise Unavailable()
        return count
    except (Denied, Unavailable):
        raise
    except Exception as exc:
        raise Unavailable() from exc


async def poll_opensearch_count(namespace: str, *, expect_positive: bool,
                                max_attempts: int = 30, interval: float = 1.0, **kwargs: Any) -> int:
    for _ in range(max_attempts):
        count = await query_opensearch_count(namespace, **kwargs)
        if (expect_positive and count > 0) or (not expect_positive and count == 0):
            return count
        await asyncio.sleep(interval)
    raise Unavailable()


async def check_opensearch_cross_scope(foreign_namespace: str, *, base_url=None, username=None,
                                      password=None, ca_certs=None, verify_certs=None,
                                      timeout: float = 10.0) -> bool:
    """Only an actual authorization refusal proves this negative check."""
    if foreign_namespace == _required("AVA_DEPLOYMENT_NAMESPACE"):
        raise Denied()
    url, auth, verify = _search_connection(foreign_namespace, base_url=base_url, username=username,
                                          password=password, ca_certs=ca_certs, verify_certs=verify_certs)
    try:
        async with httpx.AsyncClient(verify=verify, timeout=timeout, follow_redirects=False) as client:
            res = await client.get(f"{url}/{foreign_namespace}_documents/_count", auth=auth)
        if res.status_code == 403:
            return True
        if res.status_code == 200:
            return False
        raise Unavailable()
    except (Denied, Unavailable):
        raise
    except Exception as exc:
        raise Unavailable() from exc


@contextlib.asynccontextmanager
async def _get_client(
    client: httpx.AsyncClient | None,
    config: Config,
    state_file: Path,
    gateway_key_file: str,
    native: Any,
):
    if client is not None:
        if not str(client.base_url).strip("/"):
            client.base_url = httpx.URL("https://native.invalid")
        yield client
        return

    # A native acceptance run must reach the already-running server, including
    # its real guard, lifespan, and background workers. No ASGI auto-wrapping.
    api_url = os.environ.get("AVA_ONYX_API_URL", "http://127.0.0.1:8080")
    if api_url not in ("http://127.0.0.1:8080", "http://api:8080"):
        raise Denied()
    async with httpx.AsyncClient(base_url=api_url, timeout=30.0, follow_redirects=False) as remote_client:
        yield remote_client


async def probe(
    *,
    client: httpx.AsyncClient | None = None,
    native: Any | None = None,
    max_poll_iterations: int = 60,
    poll_interval: float = 1.0,
) -> dict[str, bool]:
    """Execute complete document lifecycle and cross-scope isolation probe."""
    if os.environ.get("AVA_NATIVE_QA") != "true":
        raise Denied()

    business_id = integer(int(_required("AVA_BUSINESS_ID")))
    if business_id not in (911001, 911002):
        raise Denied()

    deployment_id = identifier(_required("AVA_DEPLOYMENT_ID"))
    namespace = _required("AVA_DEPLOYMENT_NAMESPACE")
    encryption_key = read_secret(_required("AVA_AUTH_ENCRYPTION_KEY_FILE"), key=True)
    config = Config(business_id, deployment_id, namespace, encryption_key)

    if native is None:
        native = CommunityOnyx()
    if native.backend_name != "redis":
        raise Unavailable()

    evidence: dict[str, bool] = {
        "provisioned": False,
        "session_created": False,
        "upload_status_ok": False,
        "file_indexed_completed": False,
        "opensearch_indexed": False,
        "file_deleted": False,
        "opensearch_purged": False,
        "cross_scope_read_denied": False,
        "cross_scope_delete_denied": False,
        "cross_scope_opensearch_denied": False,
        "cleaned_up": False,
    }

    user_id = str(uuid.uuid4())
    binding_id = str(uuid.uuid4())
    now = int(time.time() * 1000)
    expires_at = now + 5 * 60 * 1000

    configured_env: dict[str, str] = {}
    previous_env: dict[str, str | None] = {}
    foreign_store = None
    foreign_service = None
    foreign_native_id = None
    foreign_binding = None
    file_id = None

    existing_state = os.environ.get("AVA_AUTH_STATE_FILE")
    existing_gw = os.environ.get("AVA_NATIVE_HTTP_GATEWAY_KEY_FILE")
    use_existing_state = bool(
        existing_state
        and existing_gw
        and Path(existing_state).parent.exists()
        and Path(existing_gw).exists()
    )

    if client is None and not use_existing_state:
        raise Denied()

    with tempfile.TemporaryDirectory(prefix="ava-onyx-doc-qa-") as directory:
        root = Path(directory)

        if use_existing_state:
            assert existing_state is not None and existing_gw is not None
            state_path = Path(existing_state)
            gateway_key_path = Path(existing_gw)
            gateway_secret = read_secret(str(gateway_key_path))
        else:
            state_path = root / "state.sqlite"
            gateway_secret = secrets.token_urlsafe(32)
            gateway_key_path = root / "gateway.key"
            gateway_key_path.write_text(gateway_secret)
            gateway_key_path.chmod(0o600)

            configured_env = {
                "AVA_NATIVE_HTTP_GUARD": "true",
                "AVA_AUTH_STATE_FILE": str(state_path),
                "AVA_NATIVE_HTTP_GATEWAY_KEY_FILE": str(gateway_key_path),
            }
            previous_env = {k: os.environ.get(k) for k in configured_env}
            os.environ.update(configured_env)

        store = Store(state_path, config)
        service = Service(store, native)
        try:
            # 1. Provision manager user
            user = _user_payload(config, user_id, "qa-doc-" + uuid.uuid4().hex)
            provisioned = await service.provision(user)
            native_user_id = provisioned["nativeUserId"]
            evidence["provisioned"] = provisioned["state"] == "active"

            # 2. Create stateful session
            session_payload = {
                **user,
                "bindingId": binding_id,
                "nativeUserId": native_user_id,
                "expiresAt": expires_at,
            }
            session = await service.create_session(session_payload)
            evidence["session_created"] = bool(session.get("nativeCookie"))

            guard_headers = {
                "X-Ava-Native-Peer": gateway_secret,
                "X-Ava-Native-Binding": binding_id,
                "Cookie": session["nativeCookie"],
            }

            async with _get_client(client, config, state_path, str(gateway_key_path), native) as http_client:
                # 3. Document upload via POST /user/projects/file/upload
                filename = f"qa-document-{uuid.uuid4().hex[:8]}.txt"
                doc_bytes = b"AVA QA synthetic document verification content for Onyx search indexing.\n"
                files = {"files": (filename, doc_bytes, "text/plain")}

                upload_res = await http_client.post(
                    "/user/projects/file/upload",
                    files=files,
                    headers=guard_headers,
                )
                if upload_res.status_code not in (200, 201):
                    raise Unavailable()
                evidence["upload_status_ok"] = True

                upload_data = upload_res.json()
                raw_file_id = _extract_file_id(upload_data)
                if not raw_file_id:
                    raise Unavailable()
                file_id = identifier(raw_file_id)

                # 4. Poll status via POST /user/projects/file/statuses until COMPLETED
                poll_payload = {"file_ids": [file_id]}
                is_completed = False
                for _ in range(max_poll_iterations):
                    status_res = await http_client.post(
                        "/user/projects/file/statuses",
                        json=poll_payload,
                        headers=guard_headers,
                    )
                    if status_res.status_code == 200:
                        current_status = _extract_file_status(status_res.json(), file_id)
                        if current_status == "COMPLETED":
                            is_completed = True
                            break
                        if current_status in ("FAILED", "CANCELED", "SKIPPED"):
                            raise Unavailable()
                    await asyncio.sleep(poll_interval)
                if not is_completed:
                    raise Unavailable()
                evidence["file_indexed_completed"] = True

                # 5. Query OpenSearch _count on tenant index to assert count > 0
                indexed_count = await poll_opensearch_count(namespace, file_id=file_id, expect_positive=True)
                if indexed_count <= 0:
                    raise Unavailable()
                evidence["opensearch_indexed"] = True

                # 6. Cross-scope negative check with synthetic business 911002
                foreign_business_id = 911002 if config.business_id != 911002 else 911001
                foreign_deployment_id = str(uuid.uuid4())
                foreign_namespace = "ava_" + foreign_deployment_id.replace("-", "")
                foreign_key = secrets.token_bytes(32)
                foreign_config = Config(foreign_business_id, foreign_deployment_id, foreign_namespace, foreign_key)

                foreign_state_path = root / "foreign-state.sqlite"
                foreign_store = Store(foreign_state_path, foreign_config)
                foreign_service = Service(foreign_store, native)
                foreign_user_id = str(uuid.uuid4())
                foreign_user = _user_payload(foreign_config, foreign_user_id, "qa-foreign-" + uuid.uuid4().hex)
                foreign_prov = await foreign_service.provision(foreign_user)
                foreign_native_id = foreign_prov["nativeUserId"]
                foreign_binding = str(uuid.uuid4())
                foreign_session = await foreign_service.create_session({
                    **foreign_user,
                    "bindingId": foreign_binding,
                    "nativeUserId": foreign_native_id,
                    "expiresAt": expires_at,
                })

                foreign_headers = {
                    "X-Ava-Native-Peer": gateway_secret,
                    "X-Ava-Native-Binding": foreign_binding,
                    "Cookie": foreign_session["nativeCookie"],
                }

                # Foreign read check: GET /user/projects/file/{file_id}
                foreign_read = await http_client.get(f"/user/projects/file/{file_id}", headers=foreign_headers)
                evidence["cross_scope_read_denied"] = foreign_read.status_code in (403, 404)
                if not evidence["cross_scope_read_denied"]:
                    raise Denied()

                # Foreign delete check: DELETE /user/projects/file/{file_id}
                foreign_delete = await http_client.delete(f"/user/projects/file/{file_id}", headers=foreign_headers)
                evidence["cross_scope_delete_denied"] = foreign_delete.status_code in (403, 404)
                if not evidence["cross_scope_delete_denied"]:
                    raise Denied()

                # Foreign OpenSearch index check
                foreign_search_denied = await check_opensearch_cross_scope(foreign_namespace)
                evidence["cross_scope_opensearch_denied"] = foreign_search_denied
                if not foreign_search_denied:
                    raise Denied()

                # 7. Delete document via DELETE /user/projects/file/{file_id}
                del_res = await http_client.delete(f"/user/projects/file/{file_id}", headers=guard_headers)
                if del_res.status_code not in (200, 204):
                    raise Unavailable()
                if del_res.status_code == 200 and del_res.json().get("has_associations") is not False:
                    raise Unavailable()
                evidence["file_deleted"] = True

                # Observe only. The normal native DELETE endpoint must enqueue
                # and complete its own work; the probe never executes jobs.
                # 8. Query OpenSearch _count to assert physical purge (count == 0)
                purged_count = await poll_opensearch_count(namespace, file_id=file_id, expect_positive=False)
                if purged_count != 0:
                    raise Unavailable()
                evidence["opensearch_purged"] = True

        finally:
            cleanup_ok = True
            try:
                owned = [(service, store, locals().get("native_user_id"), user_id, binding_id)]
                if foreign_service is not None:
                    owned.append((foreign_service, foreign_store, foreign_native_id,
                                  locals().get("foreign_user_id"), foreign_binding))
                for svc, st, native_id, ava_id, binding in owned:
                    if not native_id:
                        continue
                    try:
                        if binding and st.session(binding):
                            await svc.revoke({"bindingId": binding})
                        if not await native.revoke_owned_tokens(native_id):
                            raise Unavailable()
                        await native.disable_user(native_id)
                        try:
                            await native.verify_user(native_id)
                        except Denied:
                            pass
                        else:
                            raise Unavailable()
                        with st.db:
                            st.db.execute("DELETE FROM ava_native_sessions WHERE user_id=?", (ava_id,))
                            st.db.execute("DELETE FROM ava_native_users WHERE user_id=?", (ava_id,))
                    except Exception:
                        cleanup_ok = False
            finally:
                if foreign_store is not None:
                    foreign_store.close()
                store.close()
                for key, val in previous_env.items():
                    if val is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = val
                evidence["cleaned_up"] = cleanup_ok

    if not all(evidence.values()):
        raise Unavailable()
    return evidence


def main() -> int:
    try:
        started = int(time.time() * 1000)
        evidence = asyncio.run(probe())
        print(json.dumps({
            "ok": True, "qa_only": True, "buyer_acceptance": False, "rag_acceptance": False,
            "schema_version": 2, "run_id": str(uuid.uuid4()), "started_at_ms": started,
            "completed_at_ms": int(time.time() * 1000),
            "business_id": integer(int(_required("AVA_BUSINESS_ID"))),
            "deployment_id": identifier(_required("AVA_DEPLOYMENT_ID")),
            "namespace": _required("AVA_DEPLOYMENT_NAMESPACE"),
            "probe_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "transport": "running_native_http", "deletion": "native_endpoint_and_worker",
            "file_scope_negative": "foreign_binding_on_same_native_backend",
            "evidence": evidence,
        }, separators=(",", ":")))
        return 0
    except Exception as error:
        frames = [
            {"file": Path(frame.filename).name, "function": frame.name, "line": frame.lineno}
            for frame in traceback.extract_tb(error.__traceback__)[-8:]
        ]
        print(
            json.dumps(
                {
                    "ok": False,
                    "stage": "document_qa_probe_failed",
                    "error_type": type(error).__name__,
                    "frames": frames,
                },
                separators=(",", ":"),
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
