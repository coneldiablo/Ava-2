"""No Docker/server calls: exercise only orchestration and guard contracts."""
import contextlib
import importlib.util
import io
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cutover', pathlib.Path(__file__).with_name('team-sales-production-cutover.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

CRITICAL = ['services/database.service.js', 'services/identity/identity-store.js',
    'services/identity/role-policy.js', 'services/identity/module-access-store.js',
    'services/identity/customer-access.js', 'services/sales-workspace.store.js',
    'services/sales-workspace.service.js', 'services/client-identity.service.js']


def fixture():
    runtime = {k: dict.fromkeys(CRITICAL, 'a' * 64) for k in c.NAMES}
    runtime['crm']['app.js'] = 'b' * 64
    rollback = {key: dict(rows) for key, rows in runtime.items()}
    rollback['crm']['app.js'] = 'c' * 64
    rollback['crm']['services/identity/team-emergency-guard.js'] = 'd' * 64
    return {'commit': 'e' * 40, 'backup': '/fixture-backup', 'criticalSourceFiles': {k: CRITICAL for k in c.NAMES},
      'emergencyRollbackSha256': {key: rollback['crm'][key] for key in ['app.js', 'services/identity/team-emergency-guard.js']},
      'runtimeSha256': runtime, 'rollbackRuntimeSha256': rollback,
      'entrypointSha256': {'crm': {'server.js': 'f' * 64}, 'worker': {'provisioning-worker.js': 'f' * 64}},
      'rollbackEntrypointSha256': {'crm': {'server.js': '9' * 64}, 'worker': {'provisioning-worker.js': '9' * 64}},
      'filesSha256': {'team-sales-migration-check.js': 'a' * 64},
      'images': {'crm': 'candidate-crm', 'worker': 'candidate-worker'},
      'rollbackImages': {'crm': 'recovery-crm', 'worker': 'recovery-worker'},
      'crmBaselineSha256': {'old': 'baseline'}, 'workerBaselineSha256': {'old': 'baseline'},
      'frontendSha256': {'new': 'FE'}, 'rollbackFrontendSha256': {'old': 'FE'}}


class CutoverTest(unittest.TestCase):
    def test_worker_starts_then_schema_checked_then_crm(self):
        events = []
        schema = {'counts': {'clients': 3}}
        before = {k: k for k in c.NAMES}
        with patch.multiple(c, up=lambda row, _: events.append(('up', row)),
            wait=lambda name: events.append(('wait', name)),
            check=lambda *_: events.append(('check',)), image_id=lambda s: s,
            database_check=lambda mode: (events.append(('schema', mode)) or schema),
            verify_payload=lambda *_args, **_kw: events.append(('hash',)),
            preserved=lambda _: events.append(('preserve',))):
            self.assertEqual(c.start_pair(before, fixture(), '/override', baseline={'counts': {'clients': 3}}), schema)
        self.assertLess(events.index(('up', 'worker')), events.index(('schema', 'schema')))
        self.assertLess(events.index(('schema', 'schema')), events.index(('up', 'crm')))

    def test_row_loss_stops_before_crm_start(self):
        starts = []
        with patch.multiple(c, up=lambda row, _: starts.append(row), wait=lambda _: None,
            check=lambda *_: None, image_id=lambda s: s,
            database_check=lambda mode: {'counts': {'clients': 2}}):
            with self.assertRaisesRegex(RuntimeError, '^MIGRATION_ROW_COUNT_DECREASED$'):
                c.start_pair({'crm': 'crm', 'worker': 'worker'}, fixture(), '/override', baseline={'counts': {'clients': 3}})
        self.assertEqual(starts, ['worker'])

    def test_stop_both_before_any_schema_start(self):
        events = []
        with patch.multiple(c, optional_state=lambda _: {'State': {'Running': False}},
            run=lambda args, **_: events.append(args) or '',
            no_other_writers=lambda _: events.append('writers_checked')):
            c.stop_writers({})
        self.assertEqual(events[0], ['docker', 'stop', '-t', '35', *c.NAMES.values()])
        self.assertEqual(events[-1], 'writers_checked')

    def test_backend_recovery_may_differ_except_critical_modules(self):
        m = fixture()
        before = {k: {'Image': 'old'} for k in c.NAMES}
        with patch.multiple(c, check_backup=lambda *_a, **_kw: None,
            preserved=lambda _: None, no_other_writers=lambda _: None,
            state=lambda _: {'State': {'Paused': False}}, check=lambda *_: None,
            image_id=lambda _: 'image', hashes=lambda *_a, **_kw: {'source': {'old': 'baseline'}},
            verify_payload=lambda *_a, **_kw: None, idle=lambda: None,
            database_check=lambda _: {}, write_override=lambda *_a, **_kw: '/override'), tempfile.TemporaryDirectory() as d:
            c.R = pathlib.Path(d)
            file = c.R / 'team-sales-migration-check.js'
            file.write_text('fixture')
            m['filesSha256'][file.name] = c.hashlib.sha256(file.read_bytes()).hexdigest()
            self.assertEqual(c.preflight(before, m), '/override')
            m['rollbackRuntimeSha256']['worker']['services/identity/identity-store.js'] = '0' * 64
            with self.assertRaisesRegex(RuntimeError, '^ROLLBACK_CRITICAL_SOURCE_DIFFERS$'):
                c.preflight(before, m)

    def test_emergency_image_requires_pinned_api_barrier(self):
        m = fixture()
        m.pop('emergencyRollbackSha256')
        with self.assertRaisesRegex(RuntimeError, '^EMERGENCY_GUARD_NOT_PINNED$'):
            c.preflight({}, m)

    def test_missing_transitive_critical_module_rejected(self):
        m = fixture()
        m['criticalSourceFiles']['worker'] = CRITICAL[:-1]
        with self.assertRaisesRegex(RuntimeError, '^ROLLBACK_CRITICAL_FILES_INCOMPLETE$'):
            c.preflight({}, m)

    def test_rollback_checks_its_own_entrypoint_and_frontend(self):
        m = fixture()
        def hashes(name, roots, image=False):
            key = 'crm' if name.endswith('crm') else 'worker'
            return {'source': m['rollbackRuntimeSha256'][key],
                'entrypoints': m['rollbackEntrypointSha256'][key],
                **({'frontend': m['rollbackFrontendSha256']} if key == 'crm' else {})}
        with patch.object(c, 'hashes', hashes): c.verify_payload(m, rollback=True, image=True)

    def test_stale_killed_lease_retries_only_idle(self):
        checks = []
        def db_check(*_a, **_kw):
            checks.append(True)
            if len(checks) < 3: raise RuntimeError('ACTIVE_ENROLLMENT_LEASE')
            return {'phase': 'database_idle'}
        with patch.multiple(c, database_check=db_check), patch.object(c.time, 'sleep', lambda _: None):
            self.assertEqual(c.stopped_idle({}, {}), {'phase': 'database_idle'})
        self.assertEqual(len(checks), 3)

    def test_schema_integrity_error_never_retried(self):
        with patch.object(c, 'database_check', side_effect=RuntimeError('DATABASE_FOREIGN_KEY_CHECK_FAILED')) as read:
            with self.assertRaisesRegex(RuntimeError, 'DATABASE_FOREIGN_KEY_CHECK_FAILED'): c.stopped_idle({}, {})
        self.assertEqual(read.call_count, 1)

    def test_failed_deploy_uses_compatible_restore(self):
        m = fixture()
        with tempfile.TemporaryDirectory() as d:
            c.R = pathlib.Path(d)
            (c.R / 'before.private.json').write_text('{}')
            (c.R / 'manifest.json').write_text(c.json.dumps(m))
            with patch('sys.argv', ['cutover', '--apply']), contextlib.redirect_stdout(io.StringIO()), \
                patch.multiple(c, preflight=lambda *_a, **_kw: '/override', idle=lambda: None,
                    database_check=lambda _: {}, stop_writers=lambda _: None,
                    stopped_idle=lambda *_: {'counts': {}},
                    start_pair=lambda *_a, **_kw: (_ for _ in ()).throw(RuntimeError('HEALTH_TIMEOUT'))), \
                patch.object(c, 'restore', return_value={}) as restored:
                with self.assertRaisesRegex(RuntimeError, '^CUTOVER_FAILED_ROLLED_BACK$'): c.main()
                restored.assert_called_once()


if __name__ == '__main__': unittest.main()
