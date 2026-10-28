"""Offline tests for the release adapter's extra preservation boundaries."""
import argparse
import importlib.util
import json
from pathlib import Path
import sqlite3
from contextlib import closing
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import build_bundle
import engine_database
import inventory
import release_operator
from shared import PRIVATE_RUNTIME, PRIVATE_VALIDATION_ALIAS, environment


class EnvironmentTests(unittest.TestCase):
    def test_all_active_scope_keeps_worker_unchanged(self):
        settings = environment({'whatsapp_crm': {'CRM_MEMORY_ENABLED': 'true', 'CRM_MEMORY_SCOPE': 'all_active'}})
        self.assertEqual(settings['provisioning_worker'], {})

    def test_identity_env_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'ENV_KEY_NOT_REVIEWED'):
            environment({'whatsapp_crm': {'AVA_TEAM_NEW_ACCOUNT_ENABLED': 'false'}})

    def test_memory_scope_is_required(self):
        with self.assertRaisesRegex(RuntimeError, 'MEMORY_TENANT_SCOPE_REQUIRED'):
            environment({'whatsapp_crm': {'CRM_MEMORY_ENABLED': 'true'}})

    def test_worker_memory_change_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'MEMORY_ENV_CRM_ONLY'):
            environment({'provisioning_worker': {'CRM_MEMORY_ENABLED': 'false'}})

    def test_bind_order_is_normalized_without_weakening_content(self):
        row = {'HostConfig': {'Binds': ['b:/b:ro', 'a:/a:rw'], 'NetworkMode': 'host'}}
        result = release_operator.host_contract(row)
        self.assertEqual(result['HostConfig']['Binds'], ['a:/a:rw', 'b:/b:ro'])
        self.assertEqual(result['HostConfig']['NetworkMode'], 'host')
        self.assertEqual(row['HostConfig']['Binds'][0], 'b:/b:ro')


class EngineMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'calls.db'
        with closing(sqlite3.connect(self.path)) as db, db:
            db.executescript("CREATE TABLE post_call_deliveries(business_id INTEGER, call_id TEXT, context_json TEXT);"
                             "INSERT INTO post_call_deliveries VALUES(1,'call-1','retained-payload');"
                             "CREATE TABLE call_records(id TEXT); INSERT INTO call_records VALUES('original');")
        self.before = engine_database.snapshot(self.path)
        with closing(sqlite3.connect(self.path)) as db, db:
            for name, kind in engine_database.ADDED:
                db.execute('ALTER TABLE post_call_deliveries ADD COLUMN ' + name + ' ' + kind)

    def tearDown(self):
        self.temp.cleanup()

    def check(self):
        projection = {name: [row[1] for row in columns] for name, columns in self.before['columns'].items()}
        engine_database.assert_migration(self.before, engine_database.snapshot(self.path),
                                         engine_database.snapshot(self.path, projection))

    def test_only_three_nullable_columns_preserve_rows(self):
        self.check()

    def test_payload_mutation_is_rejected(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE post_call_deliveries SET context_json='lost'")
        with self.assertRaisesRegex(RuntimeError, 'ENGINE_DATABASE_ROWS_CHANGED'):
            self.check()

    def test_unrelated_schema_change_is_rejected(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('CREATE TABLE unexpected(id INTEGER)')
        with self.assertRaisesRegex(RuntimeError, 'ENGINE_SCHEMA_OBJECTS_CHANGED'):
            self.check()


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.name', 'Offline fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.write('whatsapp_crm/server.js', 'module.exports=1;\n')
        self.write('whatsapp_crm/frontend/src/app.ts', 'old')
        self.write('scripts/migration.cjs', '// offline migration fixture\n')
        self.write('scripts/contract.cjs', '// offline contract fixture\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'base')
        self.base = self.git('rev-parse', 'HEAD').strip()
        self.write('whatsapp_crm/server.js', 'module.exports=2;\n')
        self.write('whatsapp_crm/src/services/added.service.js', 'module.exports={};\n')
        self.write('whatsapp_crm/frontend/src/app.ts', 'new')
        self.git('add', '.')
        self.git('commit', '-qm', 'candidate')
        self.candidate = self.git('rev-parse', 'HEAD').strip()
        dist = self.root / 'dist'
        (dist / 'assets').mkdir(parents=True)
        (dist / 'index.html').write_text('index')
        (dist / 'assets/current.js').write_text('current')
        frontend = {path.relative_to(dist).as_posix(): build_bundle.b.sha(path.read_bytes()) for path in dist.rglob('*') if path.is_file()}
        (self.root / 'frontend.json').write_text(json.dumps({'sourceCommit': self.candidate, 'files': frontend}))
        old_hash = build_bundle.b.sha(b'module.exports=1;\n')
        self.inventory = {service: {'image': 'sha256:' + 'a' * 64,
            'sourceHashes': {'server.js': old_hash, 'src/services/added.service.js': None},
            'frontendFiles': {'index.html': 'b' * 64, 'assets/retired.js': 'c' * 64}}
            for service in ('whatsapp_crm', 'provisioning_worker')}
        (self.root / 'schema.json').write_text('[]')
        self.args = argparse.Namespace(repo=self.repo, base=self.base, candidate=self.candidate,
            output=self.root / 'bundle', inventory=self.root / 'inventory.json', frontend_receipt=self.root / 'frontend.json',
            frontend_dist=dist, environment_json=None, migration_runner='scripts/migration.cjs',
            contract_runner='scripts/contract.cjs', schema_json=self.root / 'schema.json',
            schema_module=['ava-workspace.store'], crm_base_file_commit=[], worker_base_file_commit=[])

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True)

    def write(self, path, content):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def build(self):
        self.args.inventory.write_text(json.dumps(self.inventory))
        with patch.object(build_bundle, 'BASE', self.base):
            return build_bundle.build(self.args)

    def test_payload_has_only_delta_and_exact_frontend(self):
        self.build()
        manifest = json.loads((self.args.output / 'manifest.json').read_text())
        self.assertTrue(manifest['frontendExact'])
        self.assertIn('assets/retired.js', manifest['frontendBaseFiles'])
        files = manifest['services']['whatsapp_crm']['files']
        self.assertEqual(set(files), {'server.js', 'src/services/added.service.js', 'frontend/dist/index.html', 'frontend/dist/assets/current.js'})
        self.assertFalse(any(path.startswith('frontend/') for path in manifest['services']['provisioning_worker']['files']))

    def test_unknown_hotfix_in_replaced_file_is_rejected(self):
        self.inventory['whatsapp_crm']['sourceHashes']['server.js'] = 'd' * 64
        with self.assertRaisesRegex(RuntimeError, 'PRODUCTION_SOURCE_DRIFT'):
            self.build()

    def test_existing_production_file_cannot_be_claimed_as_addition(self):
        self.inventory['provisioning_worker']['sourceHashes']['src/services/added.service.js'] = 'd' * 64
        with self.assertRaisesRegex(RuntimeError, 'PRODUCTION_SOURCE_DRIFT'):
            self.build()

    def advance(self, path, content):
        self.write('whatsapp_crm/' + path, content)
        self.git('add', '.')
        self.git('commit', '-qm', 'reviewed runtime fixture')
        self.args.candidate = self.git('rev-parse', 'HEAD').strip()
        receipt = json.loads(self.args.frontend_receipt.read_text())
        receipt['sourceCommit'] = self.args.candidate
        self.args.frontend_receipt.write_text(json.dumps(receipt))

    def private_bundle(self):
        self.advance(PRIVATE_RUNTIME, 'module.exports="guarded";\n')
        for service in self.inventory.values():
            service['sourceHashes'][PRIVATE_RUNTIME] = None
        self.build()
        return json.loads((self.args.output / 'manifest.json').read_text())

    def test_exact_private_runtime_survives_builder_inventory_and_validator(self):
        manifest = self.private_bundle()
        inventory.validate_paths([PRIVATE_RUNTIME])
        with patch.object(release_operator, 'BASE', self.base):
            self.assertIs(release_operator.validate_manifest(manifest, self.args.candidate), manifest)
        for service, block in manifest['services'].items():
            self.assertIn(PRIVATE_RUNTIME, block['files'])
            self.assertNotIn(PRIVATE_VALIDATION_ALIAS, block['files'])
            self.assertTrue((self.args.output / 'payload' / service / PRIVATE_RUNTIME).is_file())

    def test_unknown_private_runtime_is_rejected(self):
        self.advance('instagram_private/other.js', 'module.exports=1;\n')
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_CHANGE_UNSUPPORTED'):
            self.build()
        with self.assertRaisesRegex(RuntimeError, 'INVENTORY_PATHS_INVALID'):
            inventory.validate_paths(['instagram_private/other.js'])

    def test_private_provenance_override_is_exact_and_hash_fenced(self):
        self.advance(PRIVATE_RUNTIME, 'module.exports="guarded";\n')
        self.args.crm_base_file_commit = [PRIVATE_RUNTIME + '=' + self.args.candidate]
        self.inventory['whatsapp_crm']['sourceHashes'][PRIVATE_RUNTIME] = build_bundle.b.sha(b'module.exports="guarded";\n')
        self.inventory['provisioning_worker']['sourceHashes'][PRIVATE_RUNTIME] = None
        self.build()
        manifest = json.loads((self.args.output / 'manifest.json').read_text())
        self.assertEqual(manifest['services']['whatsapp_crm']['baseFileCommits'][PRIVATE_RUNTIME], self.args.candidate)
        with self.assertRaisesRegex(RuntimeError, 'BASE_FILE_COMMIT_PATH_FORBIDDEN'):
            build_bundle.file_commit_overrides(self.repo, ['instagram_private/other.js=' + self.args.candidate], ['instagram_private/other.js'])

    def test_private_validation_alias_cannot_collide(self):
        manifest = self.private_bundle()
        block = manifest['services']['whatsapp_crm']
        block['files'][PRIVATE_VALIDATION_ALIAS] = 'd' * 64
        with patch.object(release_operator, 'BASE', self.base):
            with self.assertRaisesRegex(RuntimeError, 'PRIVATE_RUNTIME_ALIAS_COLLISION'):
                release_operator.validate_manifest(manifest, self.args.candidate)

    def test_changed_tests_do_not_become_runtime_payload(self):
        self.advance('tests/new.test.js', 'throw Error("not runtime");\n')
        self.build()
        manifest = json.loads((self.args.output / 'manifest.json').read_text())
        self.assertTrue(all('tests/new.test.js' not in block['files'] for block in manifest['services'].values()))


if __name__ == '__main__':
    unittest.main()
