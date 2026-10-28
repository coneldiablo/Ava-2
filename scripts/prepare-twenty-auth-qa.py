#!/usr/bin/env python3
"""Create one empty Twenty auth QA contour, using installed immutable images.

No production configuration, credentials, volume or network is reused.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import uuid

spec = importlib.util.spec_from_file_location('qa_base', Path(__file__).with_name('prepare-native-auth-qa.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def prepare(root):
    if os.geteuid() != 0 or root.parent != Path('/opt/ava-acceptance/ecosystem-20260914') or root.exists():
        raise ValueError('NEW_QA_DIRECTORY_REQUIRED')
    os.umask(0o077)
    mem = {k: int(v.split()[0]) for k, v in (line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())}
    if mem['MemAvailable'] - 5 * 1024 * 1024 < mem['MemTotal'] * .2:
        raise RuntimeError('QA_CAPACITY_REQUIRED')
    root.mkdir(mode=0o700)
    deployment = str(uuid.uuid4())
    run_id = uuid.uuid4().hex[:12]
    prefix = 'ava-twenty-auth-qa-' + run_id
    database = 'ava_native_qa_' + run_id
    db_image, cache_image = base.image_from('ava-twenty-db-1'), base.image_from('ava-twenty-redis-1')
    password, admin_password = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    base.private_file(root / 'postgres.env', f'POSTGRES_USER=qa_admin\nPOSTGRES_DB=postgres\nPOSTGRES_PASSWORD={admin_password}\n')
    env = {'PG_DATABASE_URL': f'postgres://{database}:{password}@database:5432/{database}',
           'REDIS_URL': 'redis://cache:6379', 'SERVER_URL': f'https://{prefix}.crm.meludtech.tech',
           'APP_SECRET': secrets.token_urlsafe(48), 'TELEMETRY_ENABLED': 'false', 'STORAGE_TYPE': 'local',
           'STORAGE_LOCAL_PATH': '/tmp/twenty-storage', 'LOG_LEVEL': 'error', 'NODE_ENV': 'production',
           'DISABLE_CRON_JOBS': 'true', 'DISABLE_DB_MIGRATIONS': 'true',
           'AVA_NATIVE_QA': 'true', 'AVA_QA_DATABASE_NAME': database,
           'AVA_QA_BUSINESS_ID': '900003', 'AVA_QA_DEPLOYMENT_ID': deployment, 'AVA_QA_REVISION': '1',
           'AVA_QA_CONTEXT_FILE': '/run/ava-qa/context.json', 'NODE_OPTIONS': '--max-old-space-size=2048'}
    base.private_file(root / 'native.env', ''.join(f'{key}={value}\n' for key, value in env.items()))
    state = root / 'state'
    state.mkdir(mode=0o700)
    os.chown(state, 1000, 1000)
    base.run(['docker', 'network', 'create', '--internal', '--label', 'ava.qa.run=' + run_id, prefix])
    base.run(['docker', 'run', '-d', '--name', prefix + '-db', '--network', prefix, '--network-alias', 'database',
              '--label', 'ava.qa.run=' + run_id, '--memory', '768m', '--cpus', '1', '--pids-limit', '128',
              '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,size=512m', '--env-file', str(root / 'postgres.env'), db_image])
    base.run(['docker', 'run', '-d', '--name', prefix + '-cache', '--network', prefix, '--network-alias', 'cache',
              '--label', 'ava.qa.run=' + run_id, '--memory', '192m', '--cpus', '0.5', '--pids-limit', '64',
              '--read-only', '--tmpfs', '/data:rw,nosuid,nodev,noexec,size=64m', cache_image,
              'redis-server', '--save', '', '--appendonly', 'no', '--maxmemory', '128mb', '--maxmemory-policy', 'noeviction'])
    for _ in range(30):
        ready = subprocess.run(['docker', 'exec', prefix + '-db', 'pg_isready', '-h', '127.0.0.1', '-U', 'qa_admin'],
                               capture_output=True, timeout=5)
        if ready.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('QA_DATABASE_NOT_READY')
    base.run(['docker', 'exec', '-i', prefix + '-db', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'qa_admin', '-d', 'postgres'],
             data=f"CREATE ROLE {database} LOGIN PASSWORD '{password}' NOSUPERUSER NOCREATEDB NOCREATEROLE;\n"
                  f'CREATE DATABASE {database} OWNER {database};\nREVOKE CONNECT ON DATABASE postgres FROM PUBLIC;\n'
                  f'REVOKE ALL ON DATABASE {database} FROM PUBLIC;\n')
    base.run(['docker', 'exec', '-i', prefix + '-db', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'qa_admin', '-d', database],
             data='CREATE EXTENSION IF NOT EXISTS "uuid-ossp";\nCREATE EXTENSION IF NOT EXISTS unaccent;\nCREATE EXTENSION IF NOT EXISTS citext;\n')
    manifest = {'qa_only': True, 'business_id': 900003, 'run_id': run_id, 'deployment_id': deployment,
                'directory': str(root), 'network': prefix, 'database': database, 'postgres_image': db_image,
                'cache_image': cache_image, 'production_volumes_mounted': False, 'external_network': False}
    base.private_file(root / 'manifest.json', json.dumps(manifest, indent=2) + '\n')
    return {'qa_only': True, 'manifest': str(root / 'manifest.json'), 'network': prefix}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.directory.resolve())))
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError):
        raise SystemExit('TWENTY_QA_PREPARATION_FAILED')
