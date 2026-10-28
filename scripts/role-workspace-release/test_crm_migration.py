"""Actual local SQLite/Node snapshot tests for the reviewed CRM column gate."""
import json
import os
from pathlib import Path
import sqlite3
from contextlib import closing
import subprocess
import tempfile
import unittest

from crm_database import assert_migration
import release_operator
from shared import COLUMN_MIGRATIONS


class CrmColumnTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'crm.db'
        with closing(sqlite3.connect(self.path)) as db, db:
            db.executescript("CREATE TABLE ava_workspace_reply_actions(id TEXT PRIMARY KEY,payload TEXT NOT NULL);"
                             "INSERT INTO ava_workspace_reply_actions VALUES('original','retained');"
                             "CREATE TABLE unrelated(id INTEGER); INSERT INTO unrelated VALUES(1);")
        self.op = object.__new__(release_operator.Operator)
        self.modules = Path(__file__).parents[2] / 'whatsapp_crm/node_modules'
        def run(command, **kwargs):
            script = command[-1].replace('/app/node_modules', str(self.modules))
            self.assertIn('projection[r.name]?', script)
            env = {**os.environ, 'DB_PATH': str(self.path)}
            result = subprocess.run(['node', '-e', script], env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout
        self.op.run = run
        self.before = self.op.snapshot('unused', self.path)
        with closing(sqlite3.connect(self.path)) as db, db:
            for name, kind in COLUMN_MIGRATIONS['ava_workspace_reply_actions']:
                db.execute('ALTER TABLE ava_workspace_reply_actions ADD COLUMN ' + name + ' ' + kind)

    def tearDown(self):
        self.temp.cleanup()

    def check(self, allowed=(), triggers=()):
        projection = {name: [row[1] for row in columns] for name, columns in self.before['columns'].items()}
        after = self.op.snapshot('unused', self.path)
        assert_migration(self.before, after, self.op.snapshot('unused', self.path, projection),
                         list(allowed), release_operator.core.assert_additive, triggers)
        return after

    def test_four_columns_and_declared_new_table_preserve_old_rows(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('CREATE TABLE recovery_evidence(actionId TEXT PRIMARY KEY)')
        after = self.op.snapshot('unused', self.path)
        allowed = [obj for name, obj in after['objects'].items() if name not in self.before['objects']]
        self.check(allowed)
        # Repeat the proof after all reviewed additions are already installed.
        self.before = after
        self.check(allowed)

    def test_old_payload_change_is_rejected(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE ava_workspace_reply_actions SET payload='lost'")
        with self.assertRaisesRegex(RuntimeError, 'ORIGINAL_ROWS_CHANGED'):
            self.check()

    def test_new_fields_cannot_backfill_legacy_rows(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE ava_workspace_reply_actions SET text='invented'")
        with self.assertRaisesRegex(RuntimeError, 'CRM_LEGACY_COLUMN_BACKFILL_FORBIDDEN'):
            self.check()

    def test_additional_column_is_rejected(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('ALTER TABLE ava_workspace_reply_actions ADD COLUMN unexpected TEXT')
        with self.assertRaisesRegex(RuntimeError, 'CRM_ADDED_COLUMNS_INVALID'):
            self.check()

    def test_constraint_rewrite_is_rejected_with_same_column_metadata(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            sql = db.execute("SELECT sql FROM sqlite_master WHERE name='ava_workspace_reply_actions'").fetchone()[0]
            db.execute('PRAGMA writable_schema=1')
            db.execute("UPDATE sqlite_master SET sql=? WHERE name='ava_workspace_reply_actions'", (sql[:-1] + ',CHECK(1))',))
        with self.assertRaisesRegex(RuntimeError, 'CRM_TABLE_REWRITE_FORBIDDEN'):
            self.check()

    def trigger_fixture(self):
        name = 'ava_dialogue_ava_workspace_reply_actions_update'
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('CREATE TRIGGER ' + name + ' AFTER UPDATE ON ava_workspace_reply_actions BEGIN SELECT 1; END')
        self.before = self.op.snapshot('unused', self.path)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('DROP TRIGGER ' + name)
            db.execute('CREATE TRIGGER ' + name + ' AFTER UPDATE OF text ON ava_workspace_reply_actions BEGIN SELECT 1; END')
        after = self.op.snapshot('unused', self.path)
        return [{**after['objects'][name], 'baseSqlHash': self.before['objects'][name]['sqlHash']}]

    def test_exact_trigger_replacement_and_retry(self):
        triggers = self.trigger_fixture()
        after = self.check(triggers=triggers)
        self.before = after
        self.check(triggers=triggers)

    def test_unknown_trigger_baseline_is_rejected(self):
        triggers = self.trigger_fixture()
        triggers[0]['baseSqlHash'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'CRM_TRIGGER_BASELINE_DRIFT'):
            self.check(triggers=triggers)

    def test_different_trigger_candidate_hash_is_rejected(self):
        triggers = self.trigger_fixture()
        triggers[0]['sqlHash'] = 'f' * 64
        with self.assertRaisesRegex(RuntimeError, 'CRM_TRIGGER_REPLACEMENT_INVALID'):
            self.check(triggers=triggers)


if __name__ == '__main__':
    unittest.main()
