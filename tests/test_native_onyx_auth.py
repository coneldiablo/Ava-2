import asyncio
import ast
import importlib.util
import json
import os
import shutil
import stat
import sys
import tempfile
from types import SimpleNamespace
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("ava_onyx_auth_core", ROOT / "native_modules/onyx/auth/core.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


class NativeFixture:
    """Contract fake only; it is explicitly not proof against a live Onyx."""
    cookie_name = "fastapiusersauth"
    backend_name = "redis"

    def __init__(self):
        self.tokens = {}
        self.users = set()

    async def ensure_user(self, value): self.users.add(value)
    async def verify_user(self, value):
        if value not in self.users: raise core.Denied()
        return ["basic"]
    async def write_token(self, value, ttl):
        assert ttl > 0
        token = "T" + uuid.uuid4().hex
        self.tokens[token] = value
        return token
    async def read_token(self, token, value, expires_at): return self.tokens.get(token) == value
    async def destroy_token(self, token, value):
        if self.tokens.get(token) == value: del self.tokens[token]
    async def revoke_owned_tokens(self, value):
        for token, owner in list(self.tokens.items()):
            if owner == value: del self.tokens[token]
        return True
    async def disable_user(self, value): self.users.discard(value)


def ids(): return str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())


def payload(config, user_id, binding_id, revision=1):
    native_id = config.native_id(user_id)
    return {"businessId": config.business_id, "deploymentId": config.deployment_id,
            "nativeScope": config.namespace, "userId": user_id, "nativeUserId": native_id,
            "bindingId": binding_id, "subject": "subject-1", "role": "manager",
            "revision": revision, "expiresAt": 10_300}


def service(tmp_path):
    deployment, user, binding = ids()
    config = core.Config(7, deployment, "ava_" + "a" * 32, b"k" * 32)
    native = NativeFixture()
    return core.Service(core.Store(tmp_path / "state.sqlite", config), native, clock=lambda: 10_000), config, native, user, binding


def test_read_secret_accepts_only_owner_only_or_exact_root_service_group_modes(tmp_path, monkeypatch):
    secret = tmp_path / "peer.key"
    secret.write_bytes(b"a" * 43)
    monkeypatch.setattr(core.os, "geteuid", lambda: 1001)
    monkeypatch.setattr(core.os, "getegid", lambda: 2001)

    def metadata(owner, group, mode):
        actual = secret.stat()
        return SimpleNamespace(st_mode=stat.S_IFREG | mode, st_uid=owner, st_gid=group,
                               st_size=actual.st_size)

    accepted = ((1001, 9999, 0o400), (1001, 9999, 0o600),
                (0, 9999, 0o400), (0, 9999, 0o600), (0, 2001, 0o440))
    for owner, group, mode in accepted:
        with monkeypatch.context() as scoped:
            scoped.setattr(core.os, "fstat", lambda _fd, value=metadata(owner, group, mode): value)
            assert core.read_secret(str(secret)) == b"a" * 43

    rejected = (
        (0, 2002, 0o440),   # another service group
        (1001, 2001, 0o440),  # group-readable but not root-owned
        (0, 2001, 0o640),   # explicitly forbidden owner-write variant
        (0, 2001, 0o460),   # group-writable
        (0, 2001, 0o444),   # other-readable
        (0, 9999, 0o604),   # other-readable owner secret
        (0, 9999, 0o400 | 0o010),  # any extra group permission
        (2002, 2001, 0o400),  # foreign owner
    )
    for owner, group, mode in rejected:
        with monkeypatch.context() as scoped:
            scoped.setattr(core.os, "fstat", lambda _fd, value=metadata(owner, group, mode): value)
            with pytest.raises(core.Denied):
                core.read_secret(str(secret))


def test_read_secret_rejects_non_regular_and_symlink_without_path_or_secret_disclosure(tmp_path, monkeypatch, capsys, caplog):
    raw = "NeverLeakThisSecret_" + "x" * 43
    secret = tmp_path / raw
    secret.write_bytes(b"a" * 43)
    secret.chmod(0o600)
    link = tmp_path / "peer-link.key"
    link.symlink_to(secret)
    with pytest.raises(core.Denied) as symlink_error:
        core.read_secret(str(link))
    assert str(symlink_error.value) == ""

    actual = secret.stat()
    directory_meta = SimpleNamespace(st_mode=stat.S_IFDIR | 0o400, st_uid=os.geteuid(),
                                     st_gid=os.getegid(), st_size=actual.st_size)
    monkeypatch.setattr(core.os, "fstat", lambda _fd: directory_meta)
    with pytest.raises(core.Denied) as type_error:
        core.read_secret(str(secret))
    assert str(type_error.value) == ""
    captured = capsys.readouterr()
    assert raw not in captured.out and raw not in captured.err and raw not in caplog.text


def test_read_secret_preserves_key_and_peer_value_contracts(tmp_path):
    value = tmp_path / "value.key"
    value.write_text("c" * 64)
    value.chmod(0o600)
    assert core.read_secret(str(value), key=True) == bytes.fromhex("c" * 64)
    assert core.read_secret(str(value)) == b"c" * 64

    for peer in ("A" * 43, "z" * 128, "safe_URL-09" * 4):
        value.write_text(peer)
        assert core.read_secret(str(value)) == peer.encode()
    for invalid in ("a" * 42, "a" * 129, "a" * 63 + "g", "a" * 42 + "+"):
        value.write_text(invalid)
        with pytest.raises(core.Denied) as error:
            core.read_secret(str(value), key=len(invalid) == 64)
        assert invalid not in str(error.value)


def test_session_is_aes_encrypted_and_revoke_proves_native_absence(tmp_path):
    svc, config, native, user, binding = service(tmp_path)
    provision = {key: value for key, value in payload(config, user, binding).items() if key not in {"bindingId", "nativeUserId", "expiresAt"}}
    asyncio.run(svc.provision(provision))
    created = asyncio.run(svc.create_session(payload(config, user, binding)))
    assert created["nativeCookie"].startswith("fastapiusersauth=")
    assert ";" not in created["nativeCookie"]
    stored = svc.store.session(binding)
    assert created["nativeCookie"].split("=", 1)[1] not in stored["ciphertext"] and stored["state"] == "active"
    assert asyncio.run(svc.revoke({"bindingId": binding})) == {"bindingId": binding, "nativeSessionAbsent": True}
    assert not native.tokens and svc.store.session(binding)["ciphertext"] is None


def test_native_identity_is_deterministic_and_email_is_never_an_input_key(tmp_path):
    svc, config, _, user, binding = service(tmp_path)
    first = payload(config, user, binding)
    provision = {key: value for key, value in first.items() if key not in {"bindingId", "nativeUserId", "expiresAt"}}
    result = asyncio.run(svc.provision(provision))
    assert result["nativeUserId"] == config.native_id(user)
    changed = dict(provision, subject="other-subject")
    with pytest.raises(core.Denied): asyncio.run(svc.provision(changed))


def test_per_user_disable_is_idempotent_and_terminal_for_late_session_or_provision(tmp_path):
    svc, config, native, user, binding = service(tmp_path)
    full = payload(config, user, binding)
    provision = {key: value for key, value in full.items() if key not in {"bindingId", "nativeUserId", "expiresAt"}}
    asyncio.run(svc.provision(provision))
    asyncio.run(svc.create_session(full))
    native.tokens["T" + uuid.uuid4().hex] = config.native_id(user)  # lost mint without a Store row

    first = asyncio.run(svc.disable_user(provision))
    second = asyncio.run(svc.disable_user(provision))
    assert first == second
    assert first["userId"] == user and first["state"] == "disabled"
    assert first["nativeSessionsAbsent"] is True
    assert svc.store.contour()["enabled"] == 1
    assert svc.store.user(user)["state"] == "disabled"
    assert not native.tokens
    with pytest.raises(core.Denied):
        asyncio.run(svc.create_session(full))
    with pytest.raises(core.Denied):
        asyncio.run(svc.provision(provision))
    with pytest.raises(core.Denied):
        asyncio.run(svc.provision({**provision, "revision": 2}))


def test_per_user_disable_fences_before_native_failure_and_recover_completes(tmp_path):
    svc, config, native, user, binding = service(tmp_path)
    full = payload(config, user, binding)
    provision = {key: value for key, value in full.items() if key not in {"bindingId", "nativeUserId", "expiresAt"}}
    asyncio.run(svc.provision(provision))
    asyncio.run(svc.create_session(full))
    original = native.disable_user
    attempts = 0

    async def fail_once(value):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise core.Unavailable()
        await original(value)

    native.disable_user = fail_once
    with pytest.raises(core.Unavailable):
        asyncio.run(svc.disable_user(provision))
    assert svc.store.user(user)["state"] == "disabled"
    with pytest.raises(core.Denied):
        asyncio.run(svc.create_session(full))
    with pytest.raises(core.Denied):
        asyncio.run(svc.provision({**provision, "revision": 2}))
    asyncio.run(svc.recover())
    assert attempts == 2
    assert not native.tokens
    assert svc.store.session(binding)["state"] == "revoked"


def test_per_user_disable_with_unprovable_sweep_never_returns_absence_receipt(tmp_path):
    svc, config, native, user, binding = service(tmp_path)
    full = payload(config, user, binding)
    provision = {key: value for key, value in full.items() if key not in {"bindingId", "nativeUserId", "expiresAt"}}
    asyncio.run(svc.provision(provision))
    async def cannot_prove(_value): return False
    native.revoke_owned_tokens = cannot_prove
    with pytest.raises(core.Unavailable):
        asyncio.run(svc.disable_user(provision))
    assert svc.store.user(user)["state"] == "disabled"
    assert svc.store.contour()["enabled"] == 1
    with pytest.raises(core.Denied):
        asyncio.run(svc.create_session(full))


def test_per_user_disable_denies_unknown_foreign_or_changed_identity(tmp_path):
    svc, config, _native, user, binding = service(tmp_path)
    full = payload(config, user, binding)
    provision = {key: value for key, value in full.items() if key not in {"bindingId", "nativeUserId", "expiresAt"}}
    asyncio.run(svc.provision(provision))
    cases = (
        {**provision, "userId": str(uuid.uuid4())},
        {**provision, "businessId": config.business_id + 1},
        {**provision, "deploymentId": str(uuid.uuid4())},
        {**provision, "nativeScope": "ava_" + "b" * 32},
        {**provision, "subject": "changed"},
        {**provision, "role": "hotel_owner"},
        {**provision, "revision": 2},
    )
    for value in cases:
        with pytest.raises(core.Denied):
            asyncio.run(svc.disable_user(value))
    assert svc.store.contour()["enabled"] == 1
    assert svc.store.user(user)["state"] == "active"


def test_lost_mint_is_scoped_revoked_before_a_new_binding_is_issued(tmp_path):
    svc, config, native, user, binding = service(tmp_path)
    provision = {key: value for key, value in payload(config, user, binding).items() if key not in {"bindingId", "nativeUserId", "expiresAt"}}
    asyncio.run(svc.provision(provision))
    # This models a process death after native write but before ciphertext.
    svc.store.db.execute("INSERT INTO ava_native_sessions VALUES(?,?,?,?,'issuing',NULL,?,?)",
                         (binding, user, 1, 10_300, 10_000, 10_000))
    native.tokens["T" + uuid.uuid4().hex] = config.native_id(user)
    next_binding = str(uuid.uuid4())
    result = asyncio.run(svc.create_session(payload(config, user, next_binding)))
    assert result["bindingId"] == next_binding
    assert svc.store.session(binding)["state"] == "revoked"


def test_lost_mint_without_native_enumeration_is_quarantined_not_receipted(tmp_path):
    svc, config, native, user, binding = service(tmp_path)
    provision = {key: value for key, value in payload(config, user, binding).items() if key not in {"bindingId", "nativeUserId", "expiresAt"}}
    asyncio.run(svc.provision(provision))
    svc.store.db.execute("INSERT INTO ava_native_sessions VALUES(?,?,?,?,'issuing',NULL,?,?)",
                         (binding, user, 1, 10_300, 10_000, 10_000))
    async def unavailable_sweep(_value): return False
    native.revoke_owned_tokens = unavailable_sweep
    with pytest.raises(core.Unavailable):
        asyncio.run(svc.revoke({"bindingId": binding}))
    assert svc.store.session(binding)["state"] == "revoking"


def test_bearer_peer_key_rotates_and_browser_headers_are_rejected(tmp_path, monkeypatch):
    # Load only the private peer verifier; no Community runtime is claimed by
    # this test. The fake keeps `build_app()` independent of Onyx imports.
    key = tmp_path / "gateway.key"
    worker = tmp_path / "worker.key"
    for path, value in ((key, "a" * 43), (worker, "b" * 43)):
        path.write_text(value)
        path.chmod(0o600)
    monkeypatch.setenv("AVA_BUSINESS_ID", "7")
    monkeypatch.setenv("AVA_DEPLOYMENT_ID", str(uuid.uuid4()))
    monkeypatch.setenv("AVA_DEPLOYMENT_NAMESPACE", "ava_" + "a" * 32)
    encryption = tmp_path / "encryption.key"
    encryption.write_text("c" * 64)
    encryption.chmod(0o600)
    monkeypatch.setenv("AVA_AUTH_ENCRYPTION_KEY_FILE", str(encryption))
    monkeypatch.setenv("AVA_AUTH_GATEWAY_KEY_FILE", str(key))
    monkeypatch.setenv("AVA_AUTH_WORKER_KEY_FILE", str(worker))
    monkeypatch.setenv("AVA_AUTH_STATE_FILE", str(tmp_path / "state.sqlite"))
    sys.path.insert(0, str(ROOT / "native_modules/onyx"))
    try:
        import auth.native as native
        import auth.core as auth_core
        native.CommunityOnyx = NativeFixture
        sys.modules.pop("auth.app", None)
        import auth.app as app
        assert "/v1/users/disable" in {route.path for route in app.app.routes}
        from starlette.requests import Request
        def request(headers): return Request({"type": "http", "method": "POST", "path": "/v1/sessions/create", "headers": [(k.encode(), v.encode()) for k, v in headers.items()]})
        verifier = app.PeerVerifier(str(key), str(worker))
        verifier.verify(request({"authorization": "Bearer " + "a" * 43}), "gateway")
        key.write_text("d" * 43)
        with pytest.raises(auth_core.Denied): verifier.verify(request({"authorization": "Bearer " + "a" * 43}), "gateway")
        verifier.verify(request({"authorization": "Bearer " + "d" * 43}), "gateway")
        with pytest.raises(auth_core.Denied): verifier.verify(request({"authorization": "Bearer " + "d" * 43, "origin": "https://browser.invalid"}), "gateway")
    finally:
        sys.path.remove(str(ROOT / "native_modules/onyx"))


def test_asgi_fixture_backend_secret_error_is_contained(tmp_path, monkeypatch, caplog):
    """Fixture-only boundary test; it does not claim a native runtime proof."""
    key = tmp_path / "gateway.key"
    worker = tmp_path / "worker.key"
    encryption = tmp_path / "encryption.key"
    for path, value in ((key, "a" * 43), (worker, "b" * 43), (encryption, "c" * 64)):
        path.write_text(value)
        path.chmod(0o600)
    monkeypatch.setenv("AVA_BUSINESS_ID", "900001")
    monkeypatch.setenv("AVA_DEPLOYMENT_ID", str(uuid.uuid4()))
    monkeypatch.setenv("AVA_DEPLOYMENT_NAMESPACE", "ava_" + "a" * 32)
    monkeypatch.setenv("AVA_AUTH_ENCRYPTION_KEY_FILE", str(encryption))
    monkeypatch.setenv("AVA_AUTH_GATEWAY_KEY_FILE", str(key))
    monkeypatch.setenv("AVA_AUTH_WORKER_KEY_FILE", str(worker))
    monkeypatch.setenv("AVA_AUTH_STATE_FILE", str(tmp_path / "state.sqlite"))
    sys.path.insert(0, str(ROOT / "native_modules/onyx"))
    secret = "postgresql://qa-user:secret-password@private.invalid/db"
    try:
        import auth.native as native
        native.CommunityOnyx = NativeFixture
        sys.modules.pop("auth.app", None)
        import auth.app as app_module
        @app_module.app.get("/__qa_fixture_secret_error")
        async def fixture_secret_error():
            raise RuntimeError(secret)
        import httpx
        async def request_error():
            transport = httpx.ASGITransport(app=app_module.app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url="http://private.test") as client:
                return await client.get("/__qa_fixture_secret_error")
        response = asyncio.run(request_error())
        assert response.status_code == 503
        assert response.json() == {"detail": "unavailable", "code": "AVA_NATIVE_INTERNAL"}
        assert secret not in response.text
        assert secret not in caplog.text
    finally:
        sys.path.remove(str(ROOT / "native_modules/onyx"))


def test_preparation_excludes_ee_and_marks_native_proof_unverified(tmp_path):
    source = Path("/tmp/ava-native-pinned-20260914/onyx-a1b9e02eb65cc114c65381cbef5e555e1753ed0a")
    if not source.exists(): pytest.skip("pinned source is not available")
    spec = importlib.util.spec_from_file_location("prepare_onyx_auth", ROOT / "scripts/prepare-onyx-auth-extension.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    output = tmp_path / "prepared"
    manifest = module.prepare(source, output)
    assert not (output / "backend/ee").exists()
    assert manifest["community_only"] and not manifest["native_runtime_proof_passed"]


def test_pinned_community_strategy_api_shape_used_by_native_adapter():
    source = Path("/tmp/ava-native-pinned-20260914/onyx-a1b9e02eb65cc114c65381cbef5e555e1753ed0a/backend/onyx/auth/users.py")
    if not source.exists(): pytest.skip("pinned source is not available")
    tree = ast.parse(source.read_text())
    classes = {node.name: node for node in tree.body if isinstance(node, ast.ClassDef)}
    redis = classes["TenantAwareRedisStrategy"]
    database = classes["RefreshableDatabaseStrategy"]
    redis_methods = {node.name: node for node in redis.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    db_methods = {node.name: node for node in database.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    assert [arg.arg for arg in redis_methods["read_token"].args.args] == ["self", "token", "user_manager"]
    assert [arg.arg for arg in redis_methods["destroy_token"].args.args] == ["self", "token", "user"]
    assert [arg.arg for arg in db_methods["__init__"].args.args] == ["self", "access_token_db", "lifetime_seconds"]


def test_native_http_guard_fixture_covers_http_stream_and_websocket(tmp_path):
    """Fixture boundary coverage only; pinned-image QA remains the real proof."""
    sys.path.insert(0, str(ROOT / "native_modules/onyx"))
    try:
        import auth.core as guarded_core
        from auth.http_guard import NativeHTTPGuard
        from fastapi import FastAPI
        config = guarded_core.Config(900001, str(uuid.uuid4()), "ava_" + "a" * 32, b"k" * 32)
        native = NativeFixture()
        store = guarded_core.Store(tmp_path / "state.sqlite", config)
        service = guarded_core.Service(store, native)
        user, binding = str(uuid.uuid4()), str(uuid.uuid4())
        provision = {"businessId": config.business_id, "deploymentId": config.deployment_id, "nativeScope": config.namespace,
                     "userId": user, "subject": "guard-subject", "role": "manager", "revision": 1}
        asyncio.run(service.provision(provision))
        expires_at = int(__import__("time").time() * 1000) + 60_000
        created = asyncio.run(service.create_session({**provision, "bindingId": binding,
            "nativeUserId": config.native_id(user), "expiresAt": expires_at}))
        app = FastAPI()
        @app.get("/events")
        async def events(): return {"stream": "accepted"}
        @app.get("/auth/type")
        async def auth_metadata(): return {"requires_verification": False}
        key = tmp_path / "gateway.key"
        key.write_text("a" * 43)
        key.chmod(0o600)
        guarded = NativeHTTPGuard(app, config=config, state_file=tmp_path / "state.sqlite",
                                  gateway_key_file=str(key), native=native)
        headers = {"x-ava-native-peer": "a" * 43, "x-ava-native-binding": binding,
                   "cookie": created["nativeCookie"]}
        import httpx
        async def request(method_headers, path="/events", method="GET"):
            transport = httpx.ASGITransport(app=guarded, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url="http://native.test") as client:
                return await client.request(method, path, headers=method_headers)
        assert asyncio.run(request(headers)).json() == {"stream": "accepted"}
        assert asyncio.run(request({**headers, "authorization": "Bearer self-issued"})).status_code == 403
        assert asyncio.run(request(list(headers.items()) + [("authorization", "one"), ("authorization", "two")])).status_code == 403
        assert asyncio.run(request(list(headers.items()) + [("cookie", created["nativeCookie"])] )).status_code == 403
        assert asyncio.run(request(headers, "/api/auth/login")).status_code == 403
        assert asyncio.run(request(headers, "/auth/type")).status_code == 200
        assert asyncio.run(request({}, "/auth/type")).status_code == 403
        for missing in ("x-ava-native-peer", "x-ava-native-binding", "cookie"):
            assert asyncio.run(request({k: v for k, v in headers.items() if k != missing}, "/auth/type")).status_code == 403
        for path in ("/auth/type/", "/auth/login", "/auth/logout", "/auth/register", "/api/auth/type"):
            assert asyncio.run(request(headers, path)).status_code == 403
        assert asyncio.run(request(headers, "/auth/type", "POST")).status_code == 403
        store.db.execute("UPDATE ava_native_contour SET revision=2 WHERE singleton=1")
        assert asyncio.run(request(headers)).status_code == 403
        assert asyncio.run(request(headers, "/auth/type")).status_code == 403
        store.db.execute("UPDATE ava_native_contour SET revision=1 WHERE singleton=1")
        sent, lifecycle = [], []
        async def stream(_scope, _receive, send):
            try:
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": b"first", "more_body": True})
                store.db.execute("UPDATE ava_native_contour SET revision=2 WHERE singleton=1")
                await send({"type": "http.response.body", "body": b"must not leak", "more_body": True})
                lifecycle.append("incorrectly continued")
            finally:
                lifecycle.append("generator closed")
        guarded.app = stream
        async def receive(): return {"type": "http.request", "body": b""}
        async def send(message): sent.append(message)
        scope = {"type": "http", "method": "GET", "path": "/events",
                 "headers": [(key.encode(), value.encode()) for key, value in headers.items()]}
        asyncio.run(guarded(scope, receive, send))
        assert lifecycle == ["generator closed"]
        assert [item.get("body") for item in sent if item["type"] == "http.response.body"] == [b"first", b""]
        assert sent[-1]["more_body"] is False
        store.db.execute("UPDATE ava_native_contour SET revision=1 WHERE singleton=1")
        from starlette.responses import StreamingResponse
        lifecycle.clear()
        async def chunks():
            try:
                yield b"first"
                store.db.execute("UPDATE ava_native_contour SET revision=2 WHERE singleton=1")
                yield b"must not leak"
                lifecycle.append("incorrectly continued")
            finally:
                lifecycle.append("generator closed")
        guarded.app = StreamingResponse(chunks(), media_type="text/event-stream")
        async def framework_stream():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=guarded), base_url="http://native.test") as client:
                return await client.get('/events', headers=headers)
        assert asyncio.run(framework_stream()).content == b"first"
        assert lifecycle == ["generator closed"]
        store.db.execute("UPDATE ava_native_contour SET revision=1 WHERE singleton=1")
        sent.clear(); lifecycle.clear()
        async def websocket(_scope, receive, send):
            try:
                await send({"type": "websocket.accept"})
                store.db.execute("UPDATE ava_native_contour SET revision=2 WHERE singleton=1")
                await receive()
                lifecycle.append("revoked command handled")
            finally:
                lifecycle.append("socket handler closed")
        guarded.app = websocket
        async def receive(): return {"type": "websocket.receive", "text": "forbidden action"}
        asyncio.run(guarded({**scope, "type": "websocket", "path": "/ws"}, receive, send))
        assert lifecycle == ["socket handler closed"]
        assert sent[-1] == {"type": "websocket.close", "code": 4403}
        store.db.execute("UPDATE ava_native_contour SET revision=1 WHERE singleton=1")
        guarded.app = app
        async def outage(*_args): raise RuntimeError("dependency unavailable")
        native.read_token = outage
        assert asyncio.run(request(headers)).status_code == 503
        sent = []
        async def receive(): return {"type": "websocket.connect"}
        async def send(message): sent.append(message)
        asyncio.run(guarded({"type": "websocket", "path": "/ws", "headers": []}, receive, send))
        assert sent == [{"type": "websocket.close", "code": 4403}]
        store.close()
    finally:
        sys.path.remove(str(ROOT / "native_modules/onyx"))
