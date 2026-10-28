"""Contract tests with real SQLite and simulated Docker, NOT native acceptance."""
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
import uuid
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import module_deployment_helper as helper
import twenty_sync_recovery_helper as recovery


class SyncRecoveryHelperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.dbfile = self.root / 'db.sqlite'
        self.now = 1000.0
        self.request = {key: str(uuid.uuid4()) for key in recovery.IDS}
        self.request.update(contractVersion=recovery.CONTRACT, businessId=7, leaseRevision=1,
                            deploymentRevision=1, adapterRevision=2, integrationRevision=3,
                            correlationId='twout_' + str(uuid.uuid4()))
        self.request['outboxEventId'] = self.request['correlationId']
        self.adapter = str(uuid.uuid4())
        self.scope = str(uuid.uuid4())
        self.outbox_token = str(uuid.uuid4())
        self.mutation_hash = hashlib.sha256(self.outbox_token.encode()).hexdigest()
        p = self.request
        self.row = {'id': p['deploymentId'], 'businessId': 7, 'module': 'twenty', 'revision': 1,
                    'state': 'verified', 'namespace': 'ava_' + p['deploymentId'].replace('-', ''),
                    'hostname': 'unit.crm.meludtech.tech', 'sourceCommit': helper.PINNED['twenty'],
                    'reservedMemoryMiB': 4352}
        records = {
            'ava_sync_lease_recoveries': {**{k: v for k, v in p.items() if k not in ('contractVersion', 'recoveryToken')},
                'state': 'leased', 'leasedUntil': 2_000_000, 'tokenHash': hashlib.sha256(p['recoveryToken'].encode()).hexdigest(),
                'outboxLeaseHash': self.mutation_hash, 'outboxEntityType': 'contacts', 'outboxSourceTable': 'customers',
                'outboxSourceId': 'customer-1', 'outboxOperation': 'upsert'},
            'ava_sync_leases': {'leaseId': p['leaseId'], 'adapterId': self.adapter, 'deploymentId': p['deploymentId'],
                'businessId': 7, 'status': 'active', 'revision': 1, 'nativeScope': self.scope,
                'correlationId': p['correlationId'], 'expiresAt': 900_000, 'outcome': 'abandoned_pending_death',
                'method': 'POST', 'path': '/rest/people', 'objectName': 'people', 'recordId': None, 'bodyDigest': 'a'*64},
            'ava_module_deployments': self.row,
            'ava_module_adapters': {'id': self.adapter, 'businessId': 7, 'module': 'twenty', 'revision': 2,
                'enabled': 1, 'integrationRevision': 3, 'deploymentRevision': 1, 'deploymentId': p['deploymentId'],
                'integrationId': 'twenty_unit', 'nativeScope': self.scope, 'publicOrigin': 'https://' + self.row['hostname']},
            'instances': {'id': 7, 'isActive': 1},
            'twenty_workspace_links': {'id': 'twenty_unit', 'businessId': 7, 'enabled': 1, 'revision': 3, 'workspaceId': self.scope},
            'ava_sync_mutations': {'correlationId': p['correlationId'], 'adapterId': self.adapter, 'businessId': 7,
                'deploymentId': p['deploymentId'], 'nativeScope': self.scope, 'revision': 1, 'integrationRevision': 3,
                'outboxLeaseHash': self.mutation_hash, 'method': 'POST', 'path': '/rest/people', 'objectName': 'people',
                'recordId': None, 'bodyDigest': 'a'*64},
            'twenty_sync_outbox': {'eventId': p['outboxEventId'], 'businessId': 7, 'entityType': 'contacts',
                'sourceTable': 'customers', 'sourceId': 'customer-1', 'operation': 'upsert', 'leaseToken': None,
                'leasedUntil': None, 'status': 'FAILED'},
        }
        with sqlite3.connect(self.dbfile) as db:
            for table, row in records.items():
                columns = ','.join(f'{key} {"INTEGER" if type(value) is int else "TEXT"}' for key, value in row.items())
                db.execute(f'CREATE TABLE {table} ({columns})')
                db.execute(f'INSERT INTO {table} VALUES ({",".join("?" for _ in row)})', tuple(row.values()))
        self.launcher = helper.Deployments(self.dbfile, self.root, clock=lambda: self.now, enable_sync_recovery=True)
        self.rec = recovery.SyncRecovery(self.launcher, sleeper=lambda _: None)

    def tearDown(self):
        self.tmp.cleanup()

    def update(self, table, **values):
        with sqlite3.connect(self.dbfile) as db:
            db.execute(f'UPDATE {table} SET ' + ','.join(k+'=?' for k in values), tuple(values.values()))

    def test_real_sqlite_claim_exact_scope_and_one_use_token(self):
        self.assertEqual(self.rec.claim(self.request), self.row)
        self.update('ava_sync_lease_recoveries', state='readback_required')
        with self.assertRaisesRegex(helper.DeploymentError, 'SYNC_RECOVERY_CLAIM_LOST'):
            self.rec.claim(self.request)

    def test_request_rejects_commands_paths_extra_fields_boolean_and_wrong_token(self):
        mutations = [{'command': 'stop'}, {'proof': True}, {'businessId': True},
                     {'deploymentId': '../../prod'}, {'recoveryToken': 'password'}, {'leaseId': str(uuid.uuid4())}]
        for changes in mutations:
            with self.subTest(changes=changes), self.assertRaises(helper.DeploymentError):
                self.rec.claim({**self.request, **changes})
        with self.assertRaisesRegex(helper.DeploymentError, 'SYNC_RECOVERY_CLAIM_LOST'):
            self.rec.claim({**self.request, 'recoveryToken': str(uuid.uuid4())})

    def test_database_scope_fences_before_any_docker_operation(self):
        changes = [('instances', {'isActive': 0}), ('ava_module_adapters', {'enabled': 0}),
                   ('ava_module_adapters', {'revision': 99}), ('twenty_workspace_links', {'revision': 99}),
                   ('ava_module_deployments', {'state': 'disabled'}), ('ava_module_deployments', {'revision': 99}),
                   ('ava_sync_mutations', {'bodyDigest': 'b'*64}), ('twenty_sync_outbox', {'sourceId': 'other'}),
                   ('twenty_sync_outbox', {'leaseToken': str(uuid.uuid4())})]
        for table, values in changes:
            with self.subTest(table=table, values=values):
                with sqlite3.connect(self.dbfile) as db:
                    previous = db.execute('SELECT ' + ','.join(values) + ' FROM ' + table).fetchone()
                self.update(table, **values)
                self.launcher.runner = mock.Mock(side_effect=AssertionError('must not reach Docker'))
                with self.assertRaises(helper.DeploymentError): self.rec.execute(self.request)
                self.launcher.runner.assert_not_called()
                self.update(table, **dict(zip(values, previous)))

    def test_expired_claim_and_fresh_unabandoned_sync_are_not_recoverable(self):
        self.update('ava_sync_lease_recoveries', leasedUntil=999_000)
        with self.assertRaisesRegex(helper.DeploymentError, 'SYNC_RECOVERY_CLAIM_LOST'): self.rec.claim(self.request)
        self.update('ava_sync_lease_recoveries', leasedUntil=2_000_000)
        self.update('ava_sync_leases', expiresAt=2_000_000, outcome=None)
        with self.assertRaisesRegex(helper.DeploymentError, 'SYNC_RECOVERY_NOT_ELIGIBLE'): self.rec.claim(self.request)
        self.update('ava_sync_leases', outcome='abandoned_pending_death')
        self.assertEqual(self.rec.claim(self.request)['id'], self.row['id'])

    def docker_fixture(self, corrupt_stop=False, database_recovered=True, lose_claim=False):
        names = ['database', 'native', 'worker', 'initializer', 'gateway']
        self.compose = {'services': {name: {'healthcheck': {'test': ['CMD', 'true']}} for name in names}}
        self.compose['_initServices'] = ['initializer']
        recipe = {'initServices': ['initializer']}
        self.launcher._recipe = mock.Mock(return_value=(self.root, recipe, self.compose))
        self.launcher._state = mock.Mock(return_value='running')
        self.stage = 'before'
        self.commands = []
        def snapshot(row, compose):
            result = {}
            for n, name in enumerate(names, 1):
                running = name != 'initializer' and self.stage != 'stopped'
                if name == 'database' and corrupt_stop and self.stage == 'stopped': running = True
                result[name] = {'containerId': str(n)*64, 'running': running, 'restarting': False,
                    # Deliberately reuse PID and container ID after restart.
                    'pid': 100+n if running else 0, 'startedAt': 1_002_000 if self.stage == 'after' else 900_000,
                    'health': 'healthy' if running else None, 'exitCode': 0}
            return result
        self.rec.snapshot = mock.Mock(side_effect=snapshot)
        def runner(command, timeout):
            self.commands.append(command)
            if 'stop' in command:
                self.stage = 'stopped'; self.now = 1001.0
            elif 'up' in command:
                self.stage = 'after'; self.now = 1003.0
                if lose_claim: self.update('ava_module_adapters', enabled=0)
            elif command[:2] == ['docker', 'exec']:
                return json.dumps({'recovered': database_recovered, 'startedAt': 1_002_100})
            return ''
        self.launcher.runner = runner

    def test_whole_contour_stop_and_actual_sql_probe_before_identity_bound_receipt(self):
        self.docker_fixture()
        with mock.patch.object(helper, 'owned_path', side_effect=lambda path: path):
            result = self.rec.execute(self.request)
        self.assertEqual(result['ownedContainerIds'], result['stoppedContainerIds'])
        self.assertEqual(len(result['containers']), 5)
        self.assertEqual(result['database']['postmasterStartedAt'], 1_002_100)
        self.assertNotIn('recoveryToken', result)
        self.assertTrue(all(c['stoppedPid'] == 0 for c in result['containers']))
        native = next(c for c in result['containers'] if c['service'] == 'native')
        self.assertEqual(native['beforePid'], native['afterPid'])
        self.assertGreater(native['afterStartedAt'], result['stopObservedAt'])
        stop = next(c for c in self.commands if 'stop' in c)
        self.assertEqual(stop[-3:], ['stop', '--timeout', '10'])  # no client-supplied service list
        up = next(c for c in self.commands if 'up' in c)
        self.assertEqual(up[-6:], ['up', '--detach', '--no-build', '--pull', 'never', '--no-recreate'])
        sql = next(c for c in self.commands if c[:2] == ['docker', 'exec'])
        self.assertIn('pg_is_in_recovery()', sql[-1])
        self.assertIn('pg_postmaster_start_time()', sql[-1])
        self.assertNotIn(self.request['recoveryToken'], json.dumps(self.commands))
        with sqlite3.connect(self.dbfile) as db:
            self.assertEqual(db.execute('SELECT status FROM ava_sync_leases').fetchone()[0], 'active')

    def test_unproven_database_stop_never_restarts(self):
        self.docker_fixture(corrupt_stop=True)
        with mock.patch.object(helper, 'owned_path', side_effect=lambda path: path):
            with self.assertRaisesRegex(helper.DeploymentError, 'SYNC_RECOVERY_STOP_UNPROVEN'):
                self.rec.execute(self.request)
        self.assertFalse(any('up' in c for c in self.commands))

    def test_database_in_recovery_cannot_emit_proof_and_stops_partial_restart(self):
        self.docker_fixture(database_recovered=False)
        with mock.patch.object(helper, 'owned_path', side_effect=lambda path: path):
            with self.assertRaisesRegex(helper.DeploymentError, 'SYNC_RECOVERY_DATABASE_UNPROVEN'):
                self.rec.execute(self.request)
        self.assertEqual(sum('stop' in c for c in self.commands), 2)

    def test_disable_during_restart_stops_only_owned_project_and_retains_barrier(self):
        self.docker_fixture(lose_claim=True)
        with mock.patch.object(helper, 'owned_path', side_effect=lambda path: path):
            with self.assertRaisesRegex(helper.DeploymentError, 'SYNC_RECOVERY_SCOPE_CHANGED'):
                self.rec.execute(self.request)
        self.assertEqual(sum('stop' in c for c in self.commands), 2)
        self.assertEqual(self.commands[-1][3], self.row['namespace'])

    def test_default_feature_off_before_recovery_payload_or_io(self):
        launch = helper.Deployments(self.dbfile, self.root, runner=mock.Mock())
        with self.assertRaisesRegex(helper.DeploymentError, 'SYNC_RECOVERY_FEATURE_DISABLED'):
            launch.execute('sync-recovery', {'command': 'anything'})
        launch.runner.assert_not_called()

    def test_snapshot_demands_complete_owned_project_and_typed_process_state(self):
        compose = {'services': {'native': {}, 'database': {}}}
        def container(name, char):
            return {'Id': char*64, 'Config': {'Labels': {'com.docker.compose.service': name}},
                    'State': {'Running': True, 'Restarting': False, 'Pid': 100,
                              'StartedAt': '2026-09-15T12:30:00.123456789Z',
                              'Health': {'Status': 'healthy'}, 'ExitCode': 0}}
        good = [container('native', 'a'), container('database', 'b')]
        self.launcher._state = mock.Mock(return_value='running')
        self.launcher._containers = mock.Mock(return_value=good)
        self.assertEqual(set(self.rec.snapshot(self.row, compose)), {'native', 'database'})
        candidates = [good[:1], good + [container('foreign', 'c')], [good[0], good[0]],
                      [good[0], {**good[1], 'Id': '../../foreign'}]]
        for key, value in [('Pid', True), ('Pid', 0), ('Running', 1), ('Restarting', None), ('StartedAt', 'bad')]:
            candidate = copy.deepcopy(good); candidate[0]['State'][key] = value; candidates.append(candidate)
        for value in candidates:
            with self.subTest(value=value):
                self.launcher._containers.return_value = value
                with self.assertRaises(helper.DeploymentError): self.rec.snapshot(self.row, compose)
        self.launcher._state.side_effect = helper.DeploymentError('DEPLOYMENT_RESOURCE_OWNERSHIP_CONFLICT')
        self.launcher._containers.reset_mock()
        with self.assertRaisesRegex(helper.DeploymentError, 'OWNERSHIP_CONFLICT'): self.rec.snapshot(self.row, compose)
        self.launcher._containers.assert_not_called()

    def test_restart_must_have_later_start_even_when_pid_looks_new(self):
        self.docker_fixture()
        original = self.rec.snapshot.side_effect
        def stale_start(row, compose):
            items = original(row, compose)
            if self.stage == 'after':
                items['native']['startedAt'] = 900_000
                items['native']['pid'] = 999
            return items
        self.rec.snapshot.side_effect = stale_start
        self.rec.monotonic = mock.Mock(side_effect=[0, 100])
        with mock.patch.object(helper, 'owned_path', side_effect=lambda path: path):
            with self.assertRaisesRegex(helper.DeploymentError, 'SYNC_RECOVERY_RESTART_UNPROVEN'):
                self.rec.execute(self.request)
        self.assertEqual(sum('stop' in c for c in self.commands), 2)

    def test_response_loss_repeats_stop_and_never_changes_sync_barrier(self):
        self.docker_fixture()
        with mock.patch.object(helper, 'owned_path', side_effect=lambda path: path):
            first = self.rec.execute(self.request)
        self.assertEqual(first['leaseId'], self.request['leaseId'])
        # The worker lost the result and re-leased the same durable recovery.
        self.request['recoveryToken'] = str(uuid.uuid4())
        self.update('ava_sync_lease_recoveries', tokenHash=hashlib.sha256(self.request['recoveryToken'].encode()).hexdigest())
        self.docker_fixture()
        with mock.patch.object(helper, 'owned_path', side_effect=lambda path: path):
            second = self.rec.execute(self.request)
        self.assertEqual(first['recoveryId'], second['recoveryId'])
        self.assertTrue(any('stop' in c for c in self.commands))
        with sqlite3.connect(self.dbfile) as db:
            self.assertEqual(db.execute('SELECT status FROM ava_sync_leases').fetchone()[0], 'active')

    def test_container_replacement_after_stop_or_restart_is_never_adopted_or_stopped(self):
        for drift_stage, code in [('stopped', 'SYNC_RECOVERY_STOP_UNPROVEN'),
                                   ('after', 'SYNC_RECOVERY_INSPECTION_INVALID')]:
            with self.subTest(stage=drift_stage):
                self.docker_fixture()
                original = self.rec.snapshot.side_effect
                def drift(row, compose):
                    result = original(row, compose)
                    if self.stage == drift_stage:
                        result['native']['containerId'] = 'f'*64
                    return result
                self.rec.snapshot.side_effect = drift
                with mock.patch.object(helper, 'owned_path', side_effect=lambda path: path):
                    with self.assertRaisesRegex(helper.DeploymentError, code):
                        self.rec.execute(self.request)
                self.assertEqual(sum('stop' in c for c in self.commands), 1)
                if drift_stage == 'stopped': self.assertFalse(any('up' in c for c in self.commands))

    def test_timestamp_validation_preserves_process_start_boundary(self):
        self.assertEqual(recovery.timestamp_ms('2026-09-15T12:30:00.123456789Z'), 1789475400123)
        self.assertIsNone(recovery.timestamp_ms(None, allow_absent=True))
        for value in (True, 'today', '2026-09-15', '0001-01-01T00:00:00Z', '2026-99-15T12:30:00Z'):
            with self.subTest(value=value), self.assertRaises(helper.DeploymentError): recovery.timestamp_ms(value)


if __name__ == '__main__': unittest.main()
