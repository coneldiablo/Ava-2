#!/usr/bin/env python3
"""Verify the scoped recovery tar on stdin; extract only SQLite to owned tempdir."""
import sqlite3
import sys
import tarfile
import tempfile
from pathlib import Path

import yaml

wanted = {
    './sqlite/crm_v2.db', './twenty/docker-compose.twenty.yml',
    './twenty/docker-compose.production.yml', './twenty/database.pgdump',
    './twenty/.env', './nginx/sites-available/ava-modules',
}
data = {}
optional = {'./twenty/docker-compose.workspaces.yml'}
with tarfile.open(fileobj=sys.stdin.buffer, mode='r|gz') as archive:
    for member in archive:
        if member.name in wanted | optional and member.isfile():
            stream = archive.extractfile(member)
            data[member.name] = stream.read(5) if member.name.endswith('.pgdump') else stream.read()
assert wanted <= set(data)
with tempfile.TemporaryDirectory(prefix='ava-crm-check-') as directory:
    snapshot = Path(directory) / 'snapshot.db'
    snapshot.touch(mode=0o600)
    snapshot.write_bytes(data.pop('./sqlite/crm_v2.db'))
    with sqlite3.connect(f'file:{snapshot}?mode=ro', uri=True) as conn:
        assert conn.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
for name in ('docker-compose.twenty.yml', 'docker-compose.production.yml'):
    assert isinstance(yaml.safe_load(data['./twenty/' + name]), dict)
assert data['./twenty/database.pgdump'] == b'PGDMP'
assert data['./twenty/.env'] and data['./nginx/sites-available/ava-modules']
if b'docker-compose.workspaces.yml' in data['./twenty/.env']:
    assert yaml.safe_load(data['./twenty/docker-compose.workspaces.yml'])['services']
print('snapshot_check=ok sqlite=ok compose_yaml=ok pg_dump_header=ok temporary_files_removed=true')
