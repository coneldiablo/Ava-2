"""A05 race tests use real independent SQLite connections; HTTP is explicit fixture."""
import asyncio
import sqlite3

import pytest

from src.core.onyx_tenant_service import OnyxTenantService


@pytest.fixture
def service(tmp_path):
    path = tmp_path / 'revision.db'
    with sqlite3.connect(path) as conn:
        conn.execute('CREATE TABLE instances(id INTEGER PRIMARY KEY, isActive INTEGER DEFAULT 1)')
        conn.execute('INSERT INTO instances(id) VALUES (1),(2)')
    instance = OnyxTenantService(str(path))
    instance.configure(1, {'base_url': 'https://onyx.example.test/api', 'credential_ref': 'ONYX_API_KEY_HOTEL_1', 'cc_pair_id': 10})
    return instance


@pytest.mark.asyncio
@pytest.mark.parametrize('succeeds', [True, False])
async def test_delayed_health_cannot_reverse_disable(service, monkeypatch, succeeds):
    started, release = asyncio.Event(), asyncio.Event()

    async def health(_self):
        started.set()
        await release.wait()
        if not succeeds:
            raise RuntimeError('fixture network failure')
        return {'user': {'id': 'fixture-user'}}

    monkeypatch.setattr('src.core.onyx_tenant_service.OnyxClient.test_connection', health)
    task = asyncio.create_task(service.test_connection(1))
    await started.wait()
    service.disable(1)
    release.set()
    with pytest.raises((ValueError, RuntimeError)):
        await task
    assert service.public(1)['status'] == 'DISABLED'
    assert service.public(1)['last_health_at'] is None


@pytest.mark.asyncio
async def test_delayed_health_cannot_verify_a_reconfigured_pair(service, monkeypatch):
    async def health(_self):
        service.configure(1, {'cc_pair_id': 11})
        return {'user': {'id': 'fixture-user'}}
    monkeypatch.setattr('src.core.onyx_tenant_service.OnyxClient.test_connection', health)
    with pytest.raises(ValueError, match='ONYX_CONFIGURATION_CHANGED'):
        await service.test_connection(1)
    assert service.public(1)['cc_pair_id'] == 11
    assert service.public(1)['status'] == 'CONFIGURED'


def test_private_pair_cannot_be_assigned_to_second_business(service):
    with pytest.raises(ValueError, match='ONYX_PRIVATE_BOUNDARY_ALREADY_LINKED'):
        service.configure(2, {'base_url': 'https://onyx.example.test/api', 'credential_ref': 'ONYX_API_KEY_HOTEL_2', 'cc_pair_id': 10})
    assert service.public(2)['status'] == 'UNLINKED'


def test_old_readiness_and_credential_rotation_are_fenced(service):
    revision = service.public(1)['revision']
    service.configure(1, {'cc_pair_id': 12})
    with pytest.raises(ValueError, match='ONYX_CONFIGURATION_CHANGED'):
        service.update_readiness(1, {'grounding_verified': True}, expected_revision=revision)
    service.update_readiness(1, {'grounding_verified': True}, expected_revision=service.public(1)['revision'])
    with sqlite3.connect(service.db_path) as conn:
        conn.execute("INSERT INTO onyx_tenant_credentials(env_ref,business_id,token_encrypted) VALUES ('ONYX_API_KEY_HOTEL_1',1,'fixture-encrypted')")
        conn.execute("UPDATE onyx_tenant_credentials SET enabled=0 WHERE business_id=1")
    assert service.public(1)['readiness'] == {}
    revision = service.public(1)['revision']
    service.update_readiness(1, {'grounding_verified': True}, expected_revision=revision)
    with sqlite3.connect(service.db_path) as conn:
        conn.execute('DELETE FROM onyx_tenant_credentials WHERE business_id=1')
    assert service.public(1)['revision'] > revision
    assert service.public(1)['readiness'] == {}


@pytest.mark.asyncio
async def test_business_disable_wins_over_inflight_health(service, monkeypatch):
    async def health(_self):
        with sqlite3.connect(service.db_path) as conn:
            conn.execute('UPDATE instances SET isActive=0 WHERE id=1')
        return {'user': {'id': 'fixture-user'}}
    monkeypatch.setattr('src.core.onyx_tenant_service.OnyxClient.test_connection', health)
    with pytest.raises(ValueError, match='ONYX_CONFIGURATION_CHANGED'):
        await service.test_connection(1)
    assert service.public(1)['last_health_at'] is None
    with pytest.raises(ValueError, match='ONYX_TENANT_DISABLED'):
        await service.test_connection(1)
