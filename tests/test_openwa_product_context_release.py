"""Offline release gates; all Docker operations are fakes and DB data is synthetic."""
import copy
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import shutil
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


op = load('openwa_product_operator', ROOT / 'scripts/openwa-product-context-release.py')
legacy = load('openwa_product_core', ROOT / 'scripts/neuro-gemini-release/release_operator.py')
MANIFEST = json.loads((ROOT / 'scripts/openwa-product-context/manifest.json').read_text())


class FakeCore:
    def __init__(self, before, candidate):
        self.row = copy.deepcopy(before)
        self.candidate = candidate
        self.selected = None
        self.commands = []
        self.backups = []
        self.fail_candidate = False

    def inspect(self, _name):
        return copy.deepcopy(self.row)

    def envmap(self, row):
        return dict(value.split('=', 1) for value in row['Config']['Env'])

    def other_containers(self):
        return {'other': ['id-other', 'image-other', True]}

    def rendered(self, before, override=None):
        value = {'image': op.BASE, 'environment': self.envmap(before), 'volumes': [{'type': 'volume', 'target': '/app/data'}]}
        if override:
            selected = next(iter(json.loads(override.read_text())['services'].values()))
            value['image'] = selected['image']
            value['environment'] = {k: v.replace('$$', '$') for k, v in selected['environment'].items()}
        return value

    def compose(self, _before, override):
        self.selected = 'candidate' if 'candidate' in override else 'rollback'
        return ['docker', 'compose'], '/tmp', 'openwa'

    def run(self, command, **_kwargs):
        self.commands.append(command)
        if command[:3] == ['docker', 'image', 'inspect']:
            return json.dumps([{'Id': self.candidate}])
        if 'up' in command:
            self.row['Image'] = self.candidate if self.selected == 'candidate' else op.BASE
            self.row['Id'] = 'id-' + self.selected
            if self.selected == 'candidate' and self.fail_candidate:
                self.row['State']['Health']['Status'] = 'unhealthy'
            else:
                self.row['State']['Health']['Status'] = 'healthy'
        return ''

    def private_json(self, path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def backup(self, source, target):
        self.backups.append((source, target))
        return legacy.backup(source, target)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='ava-openwa-release-test-')
        self.root = Path(self.temporary.name)
        self.data = self.root / 'data'
        self.data.mkdir()
        with sqlite3.connect(self.data / 'openwa.sqlite') as db:
            db.execute('CREATE TABLE sessions(id TEXT PRIMARY KEY, status TEXT)')
            db.execute("INSERT INTO sessions VALUES('synthetic-session','connected')")
        self.before = {
            'Id': 'id-before', 'Image': op.BASE, 'State': {'Running': True, 'Health': {'Status': 'healthy'}},
            'Mounts': [{'Type': 'volume', 'Name': 'auth', 'Source': str(self.data), 'Destination': '/app/data', 'RW': True}],
            'Config': {'Env': ['TOKEN=synthetic-only'], 'User': 'node', 'Entrypoint': ['init'], 'Cmd': ['node', 'main'],
                       'WorkingDir': '/app', 'Healthcheck': {'Test': ['CMD', 'ready']}},
            'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped'}},
            'NetworkSettings': {'Networks': {'ava': {'Aliases': ['openwa']}}},
        }
        candidate = 'sha256:' + 'f' * 64
        self.core = FakeCore(self.before, candidate)
        guarded = self.root / 'guard'
        guarded.write_text('frozen')
        self.prepared = {'before': self.before, 'image': candidate,
                         'inputs': {str(guarded): op.sha(guarded)},
                         'otherContainers': self.core.other_containers(),
                         'candidate': str(self.root / 'candidate.private.json'),
                         'rollback': str(self.root / 'rollback.private.json')}
        self.hashes = patch.object(op, 'file_hashes', side_effect=lambda core, manifest, image=None:
                                  op.expected_hashes(manifest, (image or core.row['Image']) == op.BASE))
        self.hashes.start()

    def tearDown(self):
        self.hashes.stop()
        self.temporary.cleanup()

    def test_applies_only_gateway_with_online_snapshot_and_retained_auth(self):
        result = op.apply_release(self.core, self.prepared, MANIFEST, self.root)
        self.assertEqual(result['phase'], 'applied')
        self.assertTrue(result['authVolumePreserved'])
        self.assertFalse(result['databaseRestored'])
        self.assertEqual(self.core.row['Mounts'], self.before['Mounts'])
        self.assertEqual(len(self.core.backups), 1)
        with sqlite3.connect(self.root / 'openwa-backup.db') as db:
            self.assertEqual(db.execute('SELECT status FROM sessions').fetchone()[0], 'connected')
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        self.assertEqual([cmd[-1] for cmd in self.core.commands if 'up' in cmd], ['openwa'])
        self.assertTrue((self.root / 'apply-started').is_file())

    def test_failed_candidate_rolls_back_image_without_restoring_messages(self):
        self.core.fail_candidate = True
        with self.assertRaisesRegex(RuntimeError, 'GATEWAY_UNHEALTHY'):
            op.apply_release(self.core, self.prepared, MANIFEST, self.root)
        self.assertEqual(self.core.row['Image'], op.BASE)
        self.assertEqual(len(self.core.backups), 1)
        self.assertEqual(len([cmd for cmd in self.core.commands if 'up' in cmd]), 2)
        self.assertFalse(json.loads((self.root / 'automatic-rollback.private.json').read_text())['databaseRestored'])
        with sqlite3.connect(self.data / 'openwa.sqlite') as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0], 1)

    def test_attempt_fence_prevents_repeating_unknown_outcome(self):
        (self.root / 'apply-started').write_text('unknown')
        with self.assertRaisesRegex(RuntimeError, 'APPLY_ALREADY_ATTEMPTED'):
            op.apply_release(self.core, self.prepared, MANIFEST, self.root)
        self.assertEqual(self.core.commands, [])
        self.assertEqual(self.core.backups, [])

    def test_input_drift_stops_before_backup_or_docker_mutation(self):
        Path(next(iter(self.prepared['inputs']))).write_text('changed')
        with self.assertRaisesRegex(RuntimeError, 'COMPOSE_INPUT_DRIFT'):
            op.apply_release(self.core, self.prepared, MANIFEST, self.root)
        self.assertEqual(self.core.commands, [])
        self.assertEqual(self.core.backups, [])

    def test_other_container_drift_stops_before_gateway_mutation(self):
        self.prepared['otherContainers']['other'][0] = 'different-id'
        with self.assertRaisesRegex(RuntimeError, 'OTHER_CONTAINER_DRIFT'):
            op.apply_release(self.core, self.prepared, MANIFEST, self.root)
        self.assertEqual(self.core.commands, [])

    def test_prior_media_hash_is_in_candidate_and_rollback_contract(self):
        for rollback in [False, True]:
            hashes = op.expected_hashes(MANIFEST, rollback)
            self.assertEqual(hashes[MANIFEST['preserved']['target']], MANIFEST['preserved']['sha256'])
            self.assertEqual(len(hashes), 5)

    def test_auth_volume_and_network_alias_drift_are_detected(self):
        self.core.row['Image'] = self.prepared['image']
        self.core.row['Mounts'][0]['Name'] = 'different-auth'
        with self.assertRaisesRegex(RuntimeError, 'AUTH_VOLUME_DRIFT'):
            op.check_contract(self.core, self.prepared, MANIFEST)
        self.core.row['Mounts'] = copy.deepcopy(self.before['Mounts'])
        self.core.row['NetworkSettings']['Networks']['ava']['Aliases'] = ['changed']
        with self.assertRaisesRegex(RuntimeError, 'NETWORK_DRIFT'):
            op.check_contract(self.core, self.prepared, MANIFEST)

    def test_manual_rollback_never_calls_database_backup_or_restore(self):
        self.core.row['Image'] = self.prepared['image']
        result = op.rollback_release(self.core, self.prepared, MANIFEST)
        self.assertEqual(result['phase'], 'rolled_back')
        self.assertFalse(result['databaseRestored'])
        self.assertEqual(self.core.backups, [])

    def test_prepare_freezes_contract_and_does_not_restart_live_gateway(self):
        staged = self.root / 'release'
        staged.mkdir()
        for name in ['patch.cjs', 'manifest.json']:
            shutil.copyfile(ROOT / 'scripts/openwa-product-context' / name, staged / name)
        shutil.copyfile(ROOT / 'scripts/neuro-gemini-release/release_operator.py', self.root / 'core.py')
        compose = self.root / 'compose.yml'
        compose.write_text('synthetic compose contract')
        self.core.row['Config']['Labels'] = {'com.docker.compose.service': 'openwa',
                                            'com.docker.compose.project.config_files': str(compose)}
        result = op.prepare(self.core, staged, op.load_manifest(staged))
        self.assertEqual(result['phase'], 'prepared')
        self.assertEqual(self.core.row['Image'], op.BASE)
        self.assertFalse(any('up' in command for command in self.core.commands))
        prepared = json.loads((staged / 'prepared.private.json').read_text())
        op.check_inputs(prepared)
        self.assertEqual(prepared['before']['Mounts'], self.before['Mounts'])
        dockerfile = (staged / 'Dockerfile').read_text()
        self.assertIn('--network=none', next(' '.join(command) for command in self.core.commands if 'build' in command))
        self.assertIn('node /tmp/ava-product-patch/patch.cjs /app', dockerfile)
        self.assertEqual((staged / '.dockerignore').read_text(), '*\n!Dockerfile\n!patch.cjs\n!manifest.json\n')


if __name__ == '__main__':
    unittest.main()
