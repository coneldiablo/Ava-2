import importlib.util
import json
from pathlib import Path
import sqlite3

import pytest


spec = importlib.util.spec_from_file_location('workspace_route_helper', Path(__file__).parents[1] / 'scripts/workspace_route_helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


@pytest.fixture
def routes(tmp_path):
    path = tmp_path / 'crm.db'
    with sqlite3.connect(path) as db:
        db.executescript('''CREATE TABLE instances(id INTEGER PRIMARY KEY,isActive INTEGER);
            INSERT INTO instances VALUES (2,1);
            CREATE TABLE business_provisioning_jobs(businessId INTEGER,module TEXT,status TEXT,leasedUntil TEXT,checkpointJson TEXT,leaseToken TEXT);''')
        db.execute("INSERT INTO business_provisioning_jobs VALUES (2,'crm_workspace','LEASED',datetime('now','+1 minute'),?,'lease-one')", (json.dumps({'slug': 'test-2'}),))
    calls = []
    instance = helper.WorkspaceRoutes(path, tmp_path / 'nginx', runner=lambda args: calls.append(args), probe=lambda host: calls.append(['https', host]))
    return instance, calls


@pytest.mark.parametrize('payload', [
    {'business_id': 2, 'slug': '../../root'}, {'business_id': 2, 'slug': 'hotel-1'},
    {'business_id': True, 'slug': 'hotel-1'}, {'business_id': 2, 'slug': 'a;reboot-2'},
    {'business_id': 2, 'slug': 'test-2', 'command': 'reboot'}, {'business_id': 2, 'slug': '-test-2'},
])
def test_rejects_untrusted_operations_before_side_effects(routes, payload):
    instance, calls = routes
    with pytest.raises(helper.RouteError):
        instance.ensure(payload)
    assert calls == []


def test_only_current_reserved_business_can_request_a_route(routes):
    instance, calls = routes
    with pytest.raises(helper.RouteError, match='WORKSPACE_RESERVATION_NOT_OWNED'):
        instance.ensure({'business_id': 3, 'slug': 'test-3'})
    assert calls == []


def test_route_is_repeatable_and_probe_must_succeed(routes):
    instance, calls = routes
    payload = {'business_id': 2, 'slug': 'test-2'}
    result = instance.ensure(payload)
    first = (instance.directory / 'test-2.conf').read_text()
    assert result == {'business_id': 2, 'hostname': 'test-2.crm.meludtech.tech', 'https_ready': True}
    instance.ensure(payload)
    assert (instance.directory / 'test-2.conf').read_text() == first
    assert list(instance.directory.glob('*.conf')) == [instance.directory / 'test-2.conf']
    assert calls[0][0] == 'certbot'
    assert calls[1:3] == [['nginx', '-t'], ['systemctl', 'reload', 'nginx']]


def test_nginx_failure_restores_previous_managed_config_without_restart(routes):
    instance, calls = routes
    instance.directory.mkdir()
    original = helper.MARKER + '# previous known route\n'
    (instance.directory / 'test-2.conf').write_text(original)
    failed = False
    def run(command):
        nonlocal failed
        calls.append(command)
        if command == ['nginx', '-t'] and not failed:
            failed = True
            raise helper.RouteError('fixture validation failure')
    instance.runner = run
    with pytest.raises(helper.RouteError):
        instance.ensure({'business_id': 2, 'slug': 'test-2'})
    assert (instance.directory / 'test-2.conf').read_text() == original
    assert not any('restart' in command for command in calls)


def test_does_not_overwrite_operator_config(routes):
    instance, calls = routes
    instance.directory.mkdir()
    target = instance.directory / 'test-2.conf'
    target.write_text('# manually managed\n')
    with pytest.raises(helper.RouteError, match='WORKSPACE_ROUTE_NOT_MANAGED'):
        instance.ensure({'business_id': 2, 'slug': 'test-2'})
    assert calls == []


def test_lost_lease_during_certificate_issuance_cannot_install_route(routes):
    instance, calls = routes
    def issue(command):
        calls.append(command)
        with sqlite3.connect(instance.database) as db:
            db.execute("UPDATE business_provisioning_jobs SET leaseToken='replacement'")
    instance.runner = issue
    with pytest.raises(helper.RouteError, match='WORKSPACE_RESERVATION_NOT_OWNED'):
        instance.ensure({'business_id': 2, 'slug': 'test-2'})
    assert not (instance.directory / 'test-2.conf').exists()
    assert len(calls) == 1
