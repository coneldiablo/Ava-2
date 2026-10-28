"""Exact preservation check for the three additive post-call outbox columns."""
import hashlib
import json
import sqlite3
from contextlib import closing

from shared import require

ADDED = [('lease_token', 'TEXT'), ('reason_code', 'TEXT'), ('updated_at', 'REAL')]


def snapshot(path, projection=None):
    result = {'objects': {}, 'columns': {}, 'rows': {}}
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        require(db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'ENGINE_DB_INTEGRITY_FAILED')
        for kind, name, table, sql in db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name'):
            result['objects'][name] = [kind, table, sql]
            if kind != 'table':
                continue
            quote = lambda value: '"' + value.replace('"', '""') + '"'
            columns = db.execute('PRAGMA table_info(' + quote(name) + ')').fetchall()
            result['columns'][name] = columns
            wanted = (projection or {}).get(name, [row[1] for row in columns])
            hashes = []
            for row in db.execute('SELECT ' + ','.join(map(quote, wanted)) + ' FROM ' + quote(name)):
                typed = [[type(v).__name__, v.hex() if isinstance(v, bytes) else v] for v in row]
                hashes.append(hashlib.sha256(json.dumps(typed, separators=(',', ':')).encode()).hexdigest())
            result['rows'][name] = hashlib.sha256(json.dumps(sorted(hashes)).encode()).hexdigest()
    return result


def assert_migration(before, after, projected):
    require(set(before['objects']) == set(after['objects']), 'ENGINE_SCHEMA_OBJECTS_CHANGED')
    require(before['rows'] == projected['rows'], 'ENGINE_DATABASE_ROWS_CHANGED')
    require('post_call_deliveries' in before['columns'], 'ENGINE_OUTBOX_BASELINE_MISSING')
    for name, value in before['objects'].items():
        if name != 'post_call_deliveries':
            require(value == after['objects'][name], 'ENGINE_UNRELATED_SCHEMA_CHANGED')
    for name, columns in before['columns'].items():
        current = after['columns'][name]
        if name != 'post_call_deliveries':
            require(columns == current, 'ENGINE_UNRELATED_COLUMNS_CHANGED')
            continue
        require(current[:len(columns)] == columns, 'ENGINE_EXISTING_COLUMNS_CHANGED')
        expected = [(key, kind) for key, kind in ADDED if key not in {row[1] for row in columns}]
        require([(row[1], row[2]) for row in current[len(columns):]] == expected
                and all(row[3:] == (0, None, 0) for row in current[len(columns):]), 'ENGINE_ADDED_COLUMNS_INVALID')
