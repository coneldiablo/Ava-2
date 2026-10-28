"""Destructive-free, isolated real-runtime probe for the AVA Onyx auth adapter.

Run only inside a freshly migrated, disposable v4.7.0 Community deployment:
``AVA_NATIVE_QA=true python -m onyx.ava_auth.qa_probe``.  It never prints a
token, cookie, password, exception, SQL parameter, or connection detail.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import sqlite3
import tempfile
import time
import traceback
import uuid
from pathlib import Path

from .core import Config, Denied, Service, Store, Unavailable, integer, read_secret
from .native import CommunityOnyx


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise Denied()
    return value


def _user_payload(config: Config, user_id: str, subject: str, revision: int = 1) -> dict:
    return {
        "businessId": config.business_id,
        "deploymentId": config.deployment_id,
        "nativeScope": config.namespace,
        "userId": user_id,
        "subject": subject,
        "role": "manager",
        "revision": revision,
    }


async def probe() -> dict[str, bool]:
    if os.environ.get("AVA_NATIVE_QA") != "true":
        raise Denied()
    business_id = integer(int(_required("AVA_BUSINESS_ID")))
    if business_id < 900000:
        raise Denied()
    deployment_id = _required("AVA_DEPLOYMENT_ID")
    namespace = _required("AVA_DEPLOYMENT_NAMESPACE")
    encryption_key = read_secret(_required("AVA_AUTH_ENCRYPTION_KEY_FILE"), key=True)
    config = Config(business_id, deployment_id, namespace, encryption_key)
    native = CommunityOnyx()
    # Lost-mint proof requires actual scoped Redis enumeration; a PostgreSQL
    # runtime intentionally fails closed in the adapter because enumeration is
    # not a stable Community interface at this pinned revision.
    if native.backend_name != "redis":
        raise Unavailable()

    now = int(time.time() * 1000)
    user_id, binding_id, lost_binding = (str(uuid.uuid4()) for _ in range(3))
    expires_at = now + 5 * 60 * 1000
    evidence = {
        "provisioned": False,
        "identity_read": False,
        "basic_non_admin": False,
        "stateful_cookie_minted_read": False,
        "idempotent_repeat": False,
        "native_revoke_readback": False,
        "lost_mint_recovered": False,
        "wrong_scope_denied": False,
        "disabled": False,
    }
    with tempfile.TemporaryDirectory(prefix="ava-onyx-auth-qa-") as directory:
        state_path = Path(directory) / "adapter-state.sqlite"
        store = Store(state_path, config)
        service = Service(store, native)
        try:
            user = _user_payload(config, user_id, "qa-" + uuid.uuid4().hex)
            provisioned = await service.provision(user)
            native_id = provisioned["nativeUserId"]
            evidence["provisioned"] = provisioned["state"] == "active"
            evidence["identity_read"] = (await native.verify_user(native_id)) is not None
            permissions = await native.verify_user(native_id)
            # Pinned Community v4.7.0 represents FULL_ADMIN_PANEL_ACCESS as
            # the persisted permission value ``admin``.
            evidence["basic_non_admin"] = "basic" in permissions and "admin" not in permissions

            session = {**user, "bindingId": binding_id, "nativeUserId": native_id, "expiresAt": expires_at}
            created = await service.create_session(session)
            token = created["nativeCookie"].split("=", 1)[1]
            evidence["stateful_cookie_minted_read"] = bool(token) and await native.read_token(token, native_id, expires_at)
            repeated = await service.create_session(session)
            evidence["idempotent_repeat"] = repeated["nativeSessionId"] == created["nativeSessionId"]
            revoked = await service.revoke({"bindingId": binding_id})
            evidence["native_revoke_readback"] = bool(revoked["nativeSessionAbsent"]) and not await native.read_token(token, native_id, expires_at)

            # Simulate the precise crash window: a real native token exists,
            # but only `issuing` (no ciphertext) reached durable adapter state.
            lost_token = await native.write_token(native_id, 60)
            store.db.execute(
                "INSERT INTO ava_native_sessions VALUES(?,?,?,?,'issuing',NULL,?,?)",
                (lost_binding, user_id, 1, expires_at, int(time.time() * 1000), int(time.time() * 1000)),
            )
            if not await native.read_token(lost_token, native_id, expires_at):
                raise Unavailable()
            await service.recover()
            evidence["lost_mint_recovered"] = not await native.read_token(lost_token, native_id, expires_at)

            try:
                await service.provision({**user, "nativeScope": "ava_" + "b" * 32})
            except Denied:
                evidence["wrong_scope_denied"] = True
            disabled = await service.disable({
                "businessId": config.business_id, "deploymentId": config.deployment_id,
                "nativeScope": config.namespace, "revision": 1,
            })
            evidence["disabled"] = disabled["state"] == "disabled" and bool(disabled["nativeSessionsAbsent"])
        finally:
            store.close()
    if not all(evidence.values()):
        raise Unavailable()
    evidence.update(await peer_http_probe(config))
    return evidence


async def peer_http_probe(config: Config) -> dict[str, bool]:
    """Real peer handlers + native cookie dependency, not a complete UI proof.

    ASGI requests exercise the shipped adapter handlers and the pinned native
    FastAPI Users authentication dependency with the real PostgreSQL/Redis.
    Nothing is bound to a host port; no native service is replaced by a fake.
    """
    from fastapi import Depends, FastAPI, HTTPException
    import httpx
    from onyx.auth.users import optional_fastapi_current_user
    from .http_guard import NativeHTTPGuard

    native_http = FastAPI()

    @native_http.get('/qa-authenticated')
    async def identity(user=Depends(optional_fastapi_current_user)):
        if user is None:
            raise HTTPException(status_code=401)
        return {'nativeUserId': str(user.id)}

    with tempfile.TemporaryDirectory(prefix='ava-onyx-peer-qa-') as directory:
        root = Path(directory)
        gateway, worker = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        keys = {'AVA_AUTH_GATEWAY_KEY_FILE': root / 'gateway.key', 'AVA_AUTH_WORKER_KEY_FILE': root / 'worker.key'}
        for path, value in ((keys['AVA_AUTH_GATEWAY_KEY_FILE'], gateway), (keys['AVA_AUTH_WORKER_KEY_FILE'], worker)):
            path.write_text(value)
            path.chmod(0o600)
        configured = {**{key: str(path) for key, path in keys.items()}, 'AVA_AUTH_STATE_FILE': str(root / 'peer.sqlite')}
        previous = {key: os.environ.get(key) for key in configured}
        os.environ.update(configured)
        try:
            # One import per disposable process; app builds its own state
            # store in this QA directory, independent of the core probe.
            from .app import app
            async with app.router.lifespan_context(app):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://private-peer') as peer:
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=native_http), base_url='https://native.invalid') as native:
                        user = _user_payload(config, str(uuid.uuid4()), 'qa-http-' + uuid.uuid4().hex)
                        headers = {'Authorization': 'Bearer ' + worker}
                        result = await peer.post('/v1/provision', json=user, headers=headers)
                        if result.status_code != 200:
                            raise Unavailable()
                        user_id = result.json()['nativeUserId']
                        foreign = await peer.post('/v1/provision', json={**user, 'businessId': config.business_id + 50}, headers=headers)
                        browser = await peer.post('/v1/verify', json=user, headers={**headers, 'Origin': 'https://browser.invalid'})
                        binding = str(uuid.uuid4())
                        request = {**user, 'nativeUserId': user_id, 'bindingId': binding, 'expiresAt': int(time.time() * 1000) + 300_000}
                        peer_headers = {'Authorization': 'Bearer ' + gateway}
                        minted = await peer.post('/v1/sessions/create', json=request, headers=peer_headers)
                        if minted.status_code != 200:
                            raise Unavailable()
                        cookie = minted.json()['nativeCookie']
                        resolved = await native.get('/qa-authenticated', headers={'Cookie': cookie})
                        unauthenticated = await native.get('/qa-authenticated')
                        # Exercise the shipped middleware over a real binding,
                        # real DB/Redis token and native authentication route.
                        # This still does not claim the complete Onyx main app.
                        guarded_app = NativeHTTPGuard(native_http, config=config,
                            state_file=root / 'peer.sqlite', gateway_key_file=str(keys['AVA_AUTH_GATEWAY_KEY_FILE']))
                        guard_headers = {'Cookie': cookie, 'X-Ava-Native-Peer': gateway, 'X-Ava-Native-Binding': binding}
                        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=guarded_app), base_url='https://native.invalid') as guarded:
                            guarded_ok = await guarded.get('/qa-authenticated', headers=guard_headers)
                            guarded_anon = await guarded.get('/qa-authenticated', headers={'Cookie': cookie})
                            guarded_binding = await guarded.get('/qa-authenticated', headers={**guard_headers, 'X-Ava-Native-Binding': str(uuid.uuid4())})
                            guarded_duplicate_cookie = await guarded.get('/qa-authenticated', headers={**guard_headers, 'Cookie': cookie + '; ' + cookie})
                            guarded_extra_cookie = await guarded.get('/qa-authenticated', headers={**guard_headers, 'Cookie': cookie + '; extra=forbidden'})
                            guarded_duplicate_auth = await guarded.get('/qa-authenticated', headers=[*guard_headers.items(),
                                ('Authorization', 'Bearer duplicate-a'), ('Authorization', 'Bearer duplicate-b')])
                            guarded_admin = await guarded.get('/api/admin/api-key', headers=guard_headers)
                            with sqlite3.connect(root / 'peer.sqlite') as fault_db:
                                fault_db.execute('UPDATE ava_native_contour SET revision=revision+1 WHERE singleton=1')
                            try:
                                guarded_revision = await guarded.get('/qa-authenticated', headers=guard_headers)
                            finally:
                                with sqlite3.connect(root / 'peer.sqlite') as fault_db:
                                    fault_db.execute('UPDATE ava_native_contour SET revision=revision-1 WHERE singleton=1')
                            guard_evidence = {
                                'native_guard_real_cookie_identity': guarded_ok.status_code == 200 and guarded_ok.json().get('nativeUserId') == user_id,
                                'native_guard_peer_required': guarded_anon.status_code == 403,
                                'native_guard_binding_required': guarded_binding.status_code == 403,
                                'native_guard_duplicate_cookie_denied': guarded_duplicate_cookie.status_code == 403,
                                'native_guard_extra_cookie_denied': guarded_extra_cookie.status_code == 403,
                                'native_guard_duplicate_authorization_denied': guarded_duplicate_auth.status_code == 403,
                                'native_guard_independent_credentials_denied': guarded_admin.status_code == 403,
                                'native_guard_contour_revision_fenced': guarded_revision.status_code == 403,
                            }
                        gateway_rotated = secrets.token_urlsafe(32)
                        keys['AVA_AUTH_GATEWAY_KEY_FILE'].write_text(gateway_rotated)
                        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=guarded_app), base_url='https://native.invalid') as guarded:
                            old_guard_peer = await guarded.get('/qa-authenticated', headers=guard_headers)
                            guard_headers['X-Ava-Native-Peer'] = gateway_rotated
                            new_guard_peer = await guarded.get('/qa-authenticated', headers=guard_headers)
                            guard_evidence['native_guard_key_rotation'] = old_guard_peer.status_code == 403 and new_guard_peer.status_code == 200
                        old_peer = await peer.post('/v1/sessions/revoke', json={'bindingId': binding}, headers=peer_headers)
                        revoked = await peer.post('/v1/sessions/revoke', json={'bindingId': binding},
                                                  headers={'Authorization': 'Bearer ' + gateway_rotated})
                        denied = await native.get('/qa-authenticated', headers={'Cookie': cookie})
                        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=guarded_app), base_url='https://native.invalid') as guarded:
                            guarded_revoked = await guarded.get('/qa-authenticated', headers=guard_headers)
                            guard_evidence['native_guard_revoked_cookie_denied'] = guarded_revoked.status_code == 403
                        disabled = await peer.post('/v1/disable', json={key: user[key] for key in ('businessId', 'deploymentId', 'nativeScope', 'revision')}, headers=headers)
                        evidence = {'peer_http_provision': result.status_code == 200,
                                    'peer_http_scope_denied': foreign.status_code == 403,
                                    'peer_http_browser_denied': browser.status_code == 403,
                                    'native_cookie_http_readback': resolved.status_code == 200 and resolved.json()['nativeUserId'] == user_id,
                                    'native_cookie_http_anonymous_denied': unauthenticated.status_code == 401,
                                    'peer_http_rotation': old_peer.status_code == 403 and revoked.status_code == 200,
                                    'native_cookie_http_revoked_denied': denied.status_code == 401,
                                    'peer_http_disable': disabled.status_code == 200}
                        evidence.update(guard_evidence)
                        if not all(evidence.values()):
                            raise Unavailable()
                        return evidence
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


def main() -> int:
    try:
        result = asyncio.run(probe())
    except Exception as error:
        # No messages, source lines, SQL, values or locals. Frame coordinates
        # identify a pinned API mismatch without exposing a session/password.
        frames = [{"file": Path(frame.filename).name, "function": frame.name, "line": frame.lineno}
                  for frame in traceback.extract_tb(error.__traceback__)[-8:]]
        print(json.dumps({"ok": False, "stage": "native_auth_probe_failed",
                          "error_type": type(error).__name__, "frames": frames}, separators=(",", ":")))
        return 1
    print(json.dumps({"ok": True, "evidence": result}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
