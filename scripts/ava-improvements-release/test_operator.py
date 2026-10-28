import copy
import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('operator_release', pathlib.Path(__file__).with_name('release_operator.py'))
op = importlib.util.module_from_spec(spec)
spec.loader.exec_module(op)


class ReleaseTests(unittest.TestCase):
    def test_paths_reject_traversal_and_aliases(self):
        for value in ('../server.js', '/etc/passwd', 'a/../b', 'a//b', './a', 'a\\b', 'a\nb', ''):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                op.relative(value)
        self.assertEqual(str(op.relative('services/ava-improvements-flags.service.js')),
                         'services/ava-improvements-flags.service.js')

    def test_payload_rejects_symlink_parent(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / 'real').mkdir()
            (root / 'real' / 'file').write_text('x')
            (root / 'link').symlink_to(root / 'real')
            with self.assertRaisesRegex(RuntimeError, 'SYMLINK_PAYLOAD'):
                op.contained(root, 'link/file')

    def test_overlay_rejects_production_hotfix_and_unexpected_new_file(self):
        manifest = {'baseSourceFiles': {'existing.js': 'reviewed-hash', 'new.js': None}}
        op.assert_baseline_source({'existing.js': 'reviewed-hash', 'server-only.js': 'unchanged'}, manifest)
        with self.assertRaisesRegex(RuntimeError, 'OVERLAY_BASE_SOURCE_DRIFT'):
            op.assert_baseline_source({'existing.js': 'production-hotfix'}, manifest)
        with self.assertRaisesRegex(RuntimeError, 'OVERLAY_BASE_SOURCE_DRIFT'):
            op.assert_baseline_source({'existing.js': 'reviewed-hash', 'new.js': 'server-only-file'}, manifest)

    def row(self):
        return {'Name': '/whatsapp_crm', 'Image': 'old-id', 'Config': {'Env': [
            'DB_PATH=/app/data/crm_v2.db', 'ADMIN_PASSWORD_HASH=$2b$private', 'PROVIDER=preserved',
            'NODE_VERSION=22'], 'Labels': {'com.docker.compose.service': 'whatsapp_crm'}}}

    def test_env_preserves_actual_values_and_runtime_only_keys(self):
        row = self.row()
        baseline = {'image': 'old-tag', 'environment': {'ADMIN_PASSWORD_HASH': 'stale', 'PROVIDER': 'stale'},
                    'ports': [{'target': 3000, 'published': '3000'}], 'networks': {'default': None}}
        original = copy.deepcopy(baseline)
        payload, expected = op.override_payload(row, baseline, 'candidate-id', {'AVA_IMPROVEMENTS_BUSINESSES': '*'})
        env = payload['services']['whatsapp_crm']['environment']
        self.assertEqual(env['ADMIN_PASSWORD_HASH'], '$$2b$$private')
        self.assertEqual(expected['environment']['ADMIN_PASSWORD_HASH'], '$2b$private')
        self.assertEqual(env['PROVIDER'], 'preserved')
        self.assertEqual(env['NODE_VERSION'], '22')
        self.assertEqual(expected['ports'], baseline['ports'])
        self.assertEqual(baseline, original)
        with self.assertRaisesRegex(RuntimeError, 'NEW_ENV_FORBIDDEN'):
            op.override_payload(row, baseline, 'id', {'UNAUTHORIZED_ENV': 'value'})

    def test_rollback_environment_removes_added_scope(self):
        baseline = {'image': 'old-tag', 'environment': {'PROVIDER': 'stale'}}
        payload, expected = op.override_payload(self.row(), baseline, 'old-id')
        self.assertNotIn(op.ALLOWED_ENV, payload['services']['whatsapp_crm']['environment'])
        self.assertEqual(expected['environment'], op.envmap(self.row()))

    def test_env_additions_from_disk_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'ENV_ADDED_ON_DISK'):
            op.override_payload(self.row(), {'environment': {'NEW_FROM_DISK': 'x'}}, 'id')

    def test_compose_preserves_order_of_all_inputs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            files = [root / f'compose-{i}.json' for i in range(12)]
            env = [root / f'env-{i}' for i in range(3)]
            for file in files + env:
                file.write_text('{}')
            row = self.row()
            row['Config']['Labels'].update({'com.docker.compose.project': 'ava',
                'com.docker.compose.project.config_files': ','.join(map(str, files)),
                'com.docker.compose.project.environment_file': ','.join(map(str, env)),
                'com.docker.compose.project.working_dir': temp})
            cmd, cwd, service = op.compose(row, root / 'override.json')
            self.assertEqual(cmd, ['docker', 'compose', '-p', 'ava'] +
                sum((['--env-file', str(f)] for f in env), []) +
                sum((['-f', str(f)] for f in files), []) + ['-f', str(root / 'override.json')])
            self.assertEqual((cwd, service), (temp, 'whatsapp_crm'))

    def test_online_backup_includes_uncheckpointed_wal(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            source = root / 'live.db'
            connection = sqlite3.connect(source)
            connection.execute('PRAGMA journal_mode=WAL')
            connection.execute('PRAGMA wal_autocheckpoint=0')
            connection.execute('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT)')
            connection.execute("INSERT INTO messages VALUES(1,'new WAL row')")
            connection.commit()
            self.assertTrue(pathlib.Path(str(source) + '-wal').exists())
            target = root / 'backup.db'
            receipt = op.online_backup(source, target)
            copy_db = sqlite3.connect(target)
            self.assertEqual(copy_db.execute('SELECT * FROM messages').fetchall(), [(1, 'new WAL row')])
            self.assertEqual(copy_db.execute('PRAGMA journal_mode').fetchone(), ('delete',))
            self.assertEqual(connection.execute('PRAGMA journal_mode').fetchone(), ('wal',))
            copy_db.close()
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertEqual(receipt['sha256'], op.sha(target))
            connection.execute("INSERT INTO messages VALUES(2,'post backup row')")
            connection.commit()
            connection.close()
            self.assertEqual(op.schema_and_rows(target)['tables']['messages']['count'], 1)

    def test_migration_requires_exact_triggers_and_original_rows(self):
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / 'db'
            db = sqlite3.connect(path)
            db.executescript('CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO messages VALUES(1,\'a\');')
            before = op.schema_and_rows(path)
            db.executescript('CREATE TABLE revisions(id INTEGER PRIMARY KEY); CREATE TRIGGER revision_insert AFTER INSERT ON messages BEGIN INSERT INTO revisions VALUES(new.id); END;')
            after = op.schema_and_rows(path)
            allowed = [value for name, value in after['objects'].items() if name not in before['objects']]
            op.assert_additive(before, after, allowed)
            with self.assertRaisesRegex(RuntimeError, 'UNEXPECTED_SCHEMA_ADDITIONS'):
                op.assert_additive(before, after, allowed[:-1])
            db.execute("UPDATE messages SET body='changed'")
            db.commit()
            with self.assertRaisesRegex(RuntimeError, 'ORIGINAL_ROWS_CHANGED'):
                op.assert_additive(before, op.schema_and_rows(path), allowed)
            db.close()

    def test_rollback_retains_current_db_and_only_recreates_crm(self):
        operator = object.__new__(op.Operator)
        operator.args = mock.Mock(base_image='old-id')
        operator.root = pathlib.Path('/release')
        row = self.row()
        row['Image'] = 'candidate-id'
        row['Mounts'] = [{'Type': 'bind', 'Source': '/live', 'Destination': '/app/data', 'RW': True}]
        p = {'before': copy.deepcopy(row), 'candidateImageId': 'candidate-id', 'otherContainers': {'voice': 'same'},
             'composeInputs': {'same': True}, 'databasePath': '/live/crm_v2.db'}
        operator.state = mock.Mock(return_value=row)
        operator.snapshot_other = mock.Mock(return_value=p['otherContainers'])
        operator.inputs = mock.Mock(return_value=p['composeInputs'])
        operator.new_backup = mock.Mock(return_value={'path': '/backup/current.db'})
        operator.compatibility = mock.Mock()
        operator.up = mock.Mock()
        operator.verify_installed = mock.Mock(return_value={'healthy': True})
        operator.receipt = mock.Mock()
        with (mock.patch.object(op, 'database_path', return_value=pathlib.Path('/live/crm_v2.db')),
              mock.patch.object(op.shutil, 'copyfile', side_effect=AssertionError('must not restore'))):
            operator.rollback(p)
        operator.up.assert_called_once_with(p, rollback=True)
        operator.compatibility.assert_called_once_with('old-id', pathlib.Path('/backup/current.db'))
        self.assertFalse(operator.receipt.call_args.kwargs['databaseRestored'])

    def test_private_capture_permissions(self):
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / 'capture.json'
            op.private_json(path, {'environment': 'secret'})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), {'environment': 'secret'})

    def test_up_recreates_only_the_crm_service(self):
        operator = object.__new__(op.Operator)
        operator.args = mock.Mock(base_image='old-id')
        operator.checked_override = mock.Mock(return_value=pathlib.Path('/private/override.json'))
        operator.scope = mock.Mock(return_value='*')
        operator.run = mock.Mock(return_value='')
        operator.state = mock.Mock(return_value={'State': {'Running': True, 'Health': {'Status': 'healthy'}},
                                                'RestartCount': 0})
        p = {'before': self.row(), 'baselineConfig': {}, 'candidateImageId': 'candidate-id'}
        with mock.patch.object(op, 'compose', return_value=(['docker', 'compose', '-f', '/original',
                                                           '-f', '/private/override.json'], '/cwd', 'whatsapp_crm')):
            operator.up(p, rollback=True)
        self.assertEqual(operator.run.call_args.args[0][-7:],
                         ['up', '-d', '--no-deps', '--pull', 'never', '--force-recreate', 'whatsapp_crm'])
        self.assertEqual(operator.checked_override.call_args.args[2], 'old-id')
        self.assertIsNone(operator.checked_override.call_args.args[4])


if __name__ == '__main__':
    unittest.main()
