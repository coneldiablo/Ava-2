"""Allow exactly reviewed nullable reply-action columns, preserving old rows."""
import copy
import hashlib
import sqlite3
from contextlib import closing

from shared import COLUMN_MIGRATIONS, require, trigger_replacements as validate_triggers


def assert_migration(before, after, projected, allowed_new, assert_additive, trigger_replacements=()):
    checked = copy.deepcopy(before)
    for obj in validate_triggers(list(trigger_replacements)):
        name = obj['name']
        old, current = before['objects'].get(name), after['objects'].get(name)
        require(old is not None and all(old[key] == obj[key] for key in ('name', 'type', 'tbl_name'))
                and old['sqlHash'] in (obj['baseSqlHash'], obj['sqlHash']), 'CRM_TRIGGER_BASELINE_DRIFT')
        require(current == {key: obj[key] for key in ('name', 'type', 'tbl_name', 'sqlHash')}, 'CRM_TRIGGER_REPLACEMENT_INVALID')
        checked['objects'][name]['sqlHash'] = obj['sqlHash']
    for table, permitted in COLUMN_MIGRATIONS.items():
        require(table in before['columns'] and table in after['columns'], 'CRM_COLUMN_BASELINE_MISSING')
        old, new = before['columns'][table], after['columns'][table]
        require(new[:len(old)] == old, 'CRM_EXISTING_COLUMNS_CHANGED')
        additions = [(key, kind) for key, kind in permitted if key not in {column[1] for column in old}]
        require([(row[1], row[2]) for row in new[len(old):]] == additions and
                all(row[3:] == [0, None, 0] for row in new[len(old):]), 'CRM_ADDED_COLUMNS_INVALID')
        require(all(after['columnNonNull'][table][key] == 0 for key, _ in additions), 'CRM_LEGACY_COLUMN_BACKFILL_FORBIDDEN')
        # Recreate the exact old CREATE statement and apply only the reviewed
        # ALTERs. Comparing resulting sqlite_master SQL catches constraint,
        # default and table rewrites that PRAGMA table_info alone cannot detect.
        with closing(sqlite3.connect(':memory:')) as model:
            model.execute(before['tableSql'][table])
            for key, kind in additions:
                model.execute('ALTER TABLE ' + table + ' ADD COLUMN ' + key + ' ' + kind)
            sql = model.execute('SELECT sql FROM sqlite_master WHERE name=?', (table,)).fetchone()[0]
        wanted = hashlib.sha256(sql.encode()).hexdigest()
        require(after['objects'][table]['sqlHash'] == wanted, 'CRM_TABLE_REWRITE_FORBIDDEN')
        checked['objects'][table]['sqlHash'] = wanted
    for table, columns in before['columns'].items():
        if table not in COLUMN_MIGRATIONS:
            require(after['columns'].get(table) == columns, 'CRM_UNRELATED_COLUMNS_CHANGED')
    # Project every original table through exactly its old columns. New fields
    # must not change a prior row's typed value or multiplicity.
    after_checked = {**after, 'tables': projected['tables']}
    assert_additive(checked, after_checked, allowed_new)
