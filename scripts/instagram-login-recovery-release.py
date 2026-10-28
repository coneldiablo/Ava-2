#!/usr/bin/env python3
"""Guard the additive pending-login table, then use the existing CRM image cutover operator."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require(value, code):
    if not value:
        raise RuntimeError(code)


def apply(root, manifest_sha, migration_sha):
    require(sha(root / 'payload/manifest.json') == manifest_sha, 'MANIFEST_DRIFT')
    m = json.loads((root / 'payload/manifest.json').read_text())
    require(m['kind'] == 'instagram-login-recovery-20261025'
            and m['roles'] == ['crm'] and not m['engineFiles'], 'RELEASE_SCOPE_DRIFT')
    for name, digest in m['tooling'].items():
        require(sha(root / name) == digest, 'TOOLING_DRIFT')
    migration = root / 'probe-runtime/login-context-migration.cjs'
    require(sha(migration) == migration_sha, 'MIGRATION_TOOL_DRIFT')
    gate = json.loads((root / 'startup-gate.json').read_text())
    require(gate.get('ok') and gate.get('realAppStart') and gate.get('schemaPreserved')
            and gate.get('customerRowsPreserved') and gate.get('migrationSha256') == migration_sha
            and gate.get('manifestSha256') == manifest_sha
            and gate.get('loginContextMigration', {}).get('onlyAllowedSchemaChanges'), 'STARTUP_GATE_REQUIRED')
    spec = importlib.util.spec_from_file_location('audited_cutover', root / 'operator.py')
    op = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(op)
    core = op.module(root / 'core.py')
    core.LOG_ROOT = root
    core.NAMES = {role: core.NAMES[role] for role in m['roles']}
    op.CRM, op.ENGINE, op.PINS = tuple(m['crmFiles']), (), m['baseImages']
    p = json.loads((root / 'prepared.private.json').read_text())
    require(gate.get('images') == p['images'], 'STARTUP_IMAGE_DRIFT')
    require(not (root / 'apply-started').exists() and not (root / 'migration-started.private.json').exists(),
            'RELEASE_ALREADY_ATTEMPTED')
    for role, old in p['before'].items():
        now = core.inspect(core.NAMES[role])
        require(now['Id'] == old['Id'] and now['Image'] == old['Image'] and now['State']['Running'], 'LIVE_CONTAINER_DRIFT')
        expected = {dest: m['files'][source]['before'] for source, dest in op.paths(role).items()}
        require(op.file_hashes(core, core.NAMES[role], expected) == expected, 'EXACT_PREIMAGE_DRIFT')
    require(core.other_containers() == p['otherContainers'], 'OTHER_CONTAINER_DRIFT')
    require(all(sha(path) == digest for path, digest in p['inputs'].items()), 'INPUT_DRIFT')
    for source, value in m['files'].items():
        require(sha(root / 'payload' / source) == value['after'], 'PAYLOAD_DRIFT')
    core.idle()
    backup = '/tmp/ava-audit-before-login-context-migration.db'
    core.run(['docker', 'exec', 'whatsapp_crm', 'node', '-e', op.BACKUP, backup], timeout=90)
    target = root / 'before-login-context-migration.db'
    core.run(['docker', 'cp', 'whatsapp_crm:' + backup, str(target)])
    target.chmod(0o600)
    database = Path(next(x['Source'] for x in p['before']['crm']['Mounts'] if x['Destination'] == '/app/data')) / 'crm_v2.db'
    stat = database.stat()
    core.private_json(root / 'migration-started.private.json', {
        'manifestSha256': manifest_sha, 'migrationSha256': migration_sha,
        'backupSha256': sha(target), 'backupIntegrityOk': True,
    })
    output = core.run(['docker', 'run', '--rm', '--network', 'none', '--read-only',
        '--user', f'{stat.st_uid}:{stat.st_gid}', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
        '--env-file', str(root / 'crm.private.env'), '-e', 'DB_PATH=/verify/crm_v2.db',
        '-e', 'AVA_LOGIN_CONTEXT_MIGRATION=1', '--mount', f'type=bind,src={database.parent},dst=/verify',
        '--mount', f'type=bind,src={root / "probe-runtime"},dst=/release,readonly',
        '--entrypoint', 'node', p['images']['crm'], '/release/login-context-migration.cjs'], timeout=120)
    result = json.loads(output)
    require(result.get('ok') and result.get('existingRowsPreserved') and result.get('onlyAllowedSchemaChanges'),
            'LIVE_LOGIN_CONTEXT_MIGRATION_FAILED')
    now = database.stat()
    require((stat.st_dev, stat.st_ino, stat.st_uid, stat.st_gid, stat.st_mode) ==
            (now.st_dev, now.st_ino, now.st_uid, now.st_gid, now.st_mode), 'DATABASE_METADATA_DRIFT')
    core.private_json(root / 'login-context-migration.json', result)
    print(json.dumps({'phase': 'login_context_migrated', **result}), flush=True)
    # This operator takes a fresh second backup and automatically restores old
    # images after a cutover failure. The added table remains compatible with the previous image.
    op.apply(root, core)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--migration-sha256', required=True)
    args = parser.parse_args()
    try:
        with open('/var/lock/ava-customer-path-release.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            apply(args.root.resolve(), args.manifest_sha256, args.migration_sha256)
    except Exception as error:
        code = str(error)
        print(json.dumps({'phase': 'failed', 'code': code if code.replace('_', '').isalnum()
                         else type(error).__name__}), flush=True)
        raise SystemExit(1)
