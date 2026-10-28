"""Real Onyx SQLite/crypto role fencing; NativeFixture is not live acceptance."""
import asyncio
import uuid

import pytest
import importlib.util
from pathlib import Path

_fixture_spec = importlib.util.spec_from_file_location("ava_native_role_test_fixture", Path(__file__).with_name("test_native_onyx_auth.py"))
_fixture = importlib.util.module_from_spec(_fixture_spec)
_fixture_spec.loader.exec_module(_fixture)
core, service, payload = _fixture.core, _fixture.service, _fixture.payload


def provision_of(full):
    return {key: value for key, value in full.items() if key not in {'bindingId', 'nativeUserId', 'expiresAt'}}


def test_onyx_owner_manager_same_revision_after_revoke_ack_and_stale_owner_denied(tmp_path):
    svc, config, native, user, binding = service(tmp_path)
    owner = {**payload(config, user, binding), 'role': 'hotel_owner'}
    asyncio.run(svc.provision(provision_of(owner)))
    old = asyncio.run(svc.create_session(owner))
    assert asyncio.run(svc.revoke({'bindingId': binding}))['nativeSessionAbsent'] is True
    manager = {**owner, 'role': 'manager', 'bindingId': str(uuid.uuid4())}
    result = asyncio.run(svc.provision(provision_of(manager)))
    assert result['role'] == 'manager' and result['revision'] == 1
    assert result['nativeUserId'] == owner['nativeUserId']
    fresh = asyncio.run(svc.create_session(manager))
    assert fresh['nativeCookie'] != old['nativeCookie']
    assert svc.store.session(binding)['state'] == 'revoked'
    assert svc.store.session(manager['bindingId'])['state'] == 'active'
    with pytest.raises(core.Denied):
        asyncio.run(svc.provision(provision_of(owner)))
    with pytest.raises(core.Denied):
        asyncio.run(svc.create_session(owner))
    assert not asyncio.run(native.read_token(old['nativeCookie'].split('=', 1)[1], owner['nativeUserId'], owner['expiresAt']))


def test_onyx_downgrade_sweeps_lost_tokens_only_for_exact_user(tmp_path):
    svc, config, native, user, binding = service(tmp_path)
    owner = {**payload(config, user, binding), 'role': 'hotel_owner'}
    asyncio.run(svc.provision(provision_of(owner)))
    asyncio.run(svc.create_session(owner))
    other_user = str(uuid.uuid4())
    other = {**payload(config, other_user, str(uuid.uuid4())), 'subject': 'other-subject'}
    asyncio.run(svc.provision(provision_of(other)))
    other_session = asyncio.run(svc.create_session(other))
    orphan = 'T' + uuid.uuid4().hex
    native.tokens[orphan] = owner['nativeUserId']
    asyncio.run(svc.provision({**provision_of(owner), 'role': 'manager'}))
    assert orphan not in native.tokens
    assert svc.store.session(binding)['state'] == 'revoked'
    assert native.tokens[other_session['nativeCookie'].split('=', 1)[1]] == other['nativeUserId']
    assert svc.store.session(other['bindingId'])['state'] == 'active'


def test_onyx_downgrade_cleanup_failure_keeps_manager_fence_and_retry_cannot_skip_cleanup(tmp_path):
    svc, config, native, user, binding = service(tmp_path)
    owner = {**payload(config, user, binding), 'role': 'hotel_owner'}
    asyncio.run(svc.provision(provision_of(owner)))
    asyncio.run(svc.create_session(owner))
    manager = {**owner, 'role': 'manager', 'bindingId': str(uuid.uuid4())}
    original = native.revoke_owned_tokens
    attempts = 0

    async def fail_once(value):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return False
        return await original(value)

    native.revoke_owned_tokens = fail_once
    with pytest.raises(core.Unavailable):
        asyncio.run(svc.provision(provision_of(manager)))
    assert svc.store.user(user)['state'] == 'pending'
    assert svc.store.user(user)['role'] == 'manager'
    with pytest.raises(core.Denied):
        asyncio.run(svc.create_session(manager))
    with pytest.raises(core.Denied):
        asyncio.run(svc.provision(provision_of(owner)))
    assert asyncio.run(svc.provision(provision_of(manager)))['state'] == 'active'
    assert attempts == 2
    assert asyncio.run(svc.create_session(manager))['bindingId'] == manager['bindingId']


@pytest.mark.parametrize('role', ['observer', 'sales_lead'])
def test_onyx_new_roles_still_denied_before_native_work(tmp_path, role):
    svc, config, native, user, binding = service(tmp_path)
    full = payload(config, user, binding)
    with pytest.raises(core.Denied):
        asyncio.run(svc.provision({**provision_of(full), 'role': role}))
    assert not native.users and not native.tokens
    assert svc.store.user(user) is None


@pytest.mark.parametrize('state', ['active', 'pending'])
def test_onyx_higher_revision_cannot_promote_manager_or_clear_pending_fence(tmp_path, state):
    svc, config, native, user, binding = service(tmp_path)
    owner = {**payload(config, user, binding), 'role': 'hotel_owner'}
    asyncio.run(svc.provision(provision_of(owner)))
    manager = {**owner, 'role': 'manager'}
    asyncio.run(svc.provision(provision_of(manager)))
    asyncio.run(svc.create_session(manager))
    svc.store.db.execute("UPDATE ava_native_users SET state=? WHERE user_id=?", (state, user))
    before = dict(svc.store.user(user))
    session_before = dict(svc.store.session(binding))
    tokens_before = dict(native.tokens)

    async def unexpected_native_work(*_args):
        pytest.fail('a forbidden role increase must be denied before native work')

    native.ensure_user = native.verify_user = native.revoke_owned_tokens = unexpected_native_work
    native.destroy_token = unexpected_native_work
    with pytest.raises(core.Denied):
        asyncio.run(svc.provision({**provision_of(owner), 'revision': 2}))
    assert svc.store.user(user) == before
    assert svc.store.session(binding) == session_before
    assert native.tokens == tokens_before
