#!/usr/bin/env python3
"""Guarded CRM/worker rollout. Private inputs stay on the production server.

The emergency rollback retains expanded schemas, role and assignment modules
while restoring previous App assembly and frontend behind a mandatory owner-only API barrier.
No database restore, credential, voice or admin change is performed.
"""
import argparse
import copy
import hashlib
import json
import os
import pathlib
import re
import subprocess
import time
from urllib.request import urlopen

os.umask(0o077)
R = pathlib.Path('/root/ava-releases/team-sales-20261002')
NAMES = {'crm': 'whatsapp_crm', 'worker': 'asterisk-ai-voice-agent-provisioning_worker-1'}
ENV = dict(os.environ, AVA_RELEASE_SHA='b3be6ee', AVA_CALL_ANALYTICS_SHA='da737f3')
HASH_SCRIPT = r"""
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const roots=JSON.parse(process.argv[1]),out={};
for(const [key,root] of Object.entries(roots)) {
 const values={};
 function walk(p) { for(const ent of fs.readdirSync(p,{withFileTypes:true})) {
  const f=path.join(p,ent.name);if(ent.isDirectory())walk(f);
  else if(ent.isFile())values[path.relative(root,f)]=crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  else throw new Error('UNSUPPORTED_RELEASE_FILE');
 }}
 if(Array.isArray(root)) { for(const rel of root)values[rel]=crypto.createHash('sha256').update(fs.readFileSync('/app/'+rel)).digest('hex'); }
 else walk(root);
 out[key]=values;
}
console.log(JSON.stringify(out));
"""


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def run(args, **kwargs):
    process = subprocess.run(args, capture_output=True, text=True, env=ENV, **kwargs)
    if process.returncode:
        raise RuntimeError('COMMAND_FAILED')
    return process.stdout


def state(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def optional_state(name):
    identifiers = run(['docker', 'ps', '-aq', '--filter', f'name=^/{re.escape(name)}$']).split()
    if not identifiers:
        return None
    require(len(identifiers) == 1, 'CONTAINER_IDENTITY_AMBIGUOUS')
    return state(identifiers[0])


def envmap(row):
    return dict(value.split('=', 1) for value in row['Config']['Env'])


def mounts(row):
    return {m['Destination']: (m['Type'], os.path.realpath(m['Source']), m['RW']) for m in row['Mounts']}


def compose(row, override=None):
    labels = row['Config']['Labels']
    command = ['docker', 'compose', '-p', labels['com.docker.compose.project']]
    for file in labels.get('com.docker.compose.project.environment_file', '').split(','):
        if file:
            command += ['--env-file', file]
    for file in labels['com.docker.compose.project.config_files'].split(','):
        command += ['-f', file]
    if override:
        command += ['-f', str(override)]
    return command, labels['com.docker.compose.project.working_dir'], labels['com.docker.compose.service']


def config(row, override=None):
    command, cwd, service = compose(row, override)
    resolved = json.loads(run(command + ['config', '--format', 'json'], cwd=cwd))['services'][service]
    for name, value in resolved.get('environment', {}).items():
        if isinstance(value, str):
            resolved['environment'][name] = value.replace('$$', '$')
    return resolved


def environment_patch(row):
    actual, patch = envmap(row), {}
    for name, value in config(row).get('environment', {}).items():
        if value is not None and actual.get(name) != str(value):
            require(name in actual, 'ENV_ADDED_FROM_DISK')
            patch[name] = actual[name].replace('$', '$$')
    return patch


def image_override(before, images):
    services = {}
    for key in NAMES:
        service = {'image': images[key]}
        patch = environment_patch(before[key])
        if patch:
            service['environment'] = patch
        services[before[key]['Config']['Labels']['com.docker.compose.service']] = service
    return {'services': services}


def write_override(before, manifest, rollback=False):
    images = manifest['rollbackImages' if rollback else 'images']
    override = R / ('rollback-compatible.private.override.json' if rollback else 'team-sales.private.override.json')
    override.write_text(json.dumps(image_override(before, images), indent=2))
    for key in NAMES:
        old, new = config(before[key]), config(before[key], override)
        expected = copy.deepcopy(old)
        expected['image'] = images[key]
        for variable in environment_patch(before[key]):
            expected['environment'][variable] = envmap(before[key])[variable]
        require(new == expected, 'COMPOSE_CONTRACT_CHANGED')
        for variable, value in new.get('environment', {}).items():
            if value is not None:
                require(envmap(before[key]).get(variable) == str(value), 'COMPOSE_ENV_DRIFT')
    return override


def up(row, override):
    command, cwd, service = compose(row, override)
    run(command + ['up', '-d', '--no-deps', '--pull', 'never', service], cwd=cwd, timeout=150)


def check(row, name, image):
    now = state(name)
    require(now['Image'] == image, 'IMAGE_CHANGED')
    require(envmap(now) == envmap(row), 'ENV_CHANGED')
    require(mounts(now) == mounts(row), 'MOUNTS_CHANGED')
    require(set(now['NetworkSettings']['Networks']) == set(row['NetworkSettings']['Networks']), 'NETWORK_CHANGED')
    for key in ('PortBindings', 'RestartPolicy', 'LogConfig', 'Privileged', 'CapAdd', 'CapDrop', 'SecurityOpt', 'Devices', 'NetworkMode'):
        require(now['HostConfig'].get(key) == row['HostConfig'].get(key), 'HOST_CONFIG_CHANGED')
    for key in ('User', 'Entrypoint', 'Cmd', 'WorkingDir'):
        require(now['Config'].get(key) == row['Config'].get(key), 'EXECUTION_CHANGED')
    require(now['State']['Running'] and not now['State']['Paused'], 'SERVICE_NOT_RUNNING')


def wait(name, timeout=90):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        current = state(name)
        if current['State']['Running'] and not current['State']['Paused']:
            health = current['State'].get('Health', {}).get('Status')
            if health == 'healthy':
                return
            if health is None:
                restarts = current['RestartCount']
                time.sleep(3)
                latest = state(name)
                if latest['State']['Running'] and not latest['State']['Paused'] and latest['RestartCount'] == restarts:
                    return
        time.sleep(2)
    raise RuntimeError('HEALTH_TIMEOUT')


def hashes(name, roots, image=False):
    command = ['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node', name] if image else ['docker', 'exec', name, 'node']
    return json.loads(run(command + ['-e', HASH_SCRIPT, json.dumps(roots)], timeout=45))


def expected_entrypoints(manifest, rollback=False):
    return manifest.get('rollbackEntrypointSha256', manifest['entrypointSha256']) if rollback else manifest['entrypointSha256']


def expected_roots(manifest, key, rollback=False):
    return {'source': '/app/src', 'entrypoints': list(expected_entrypoints(manifest, rollback)[key]), **({'frontend': '/app/frontend/dist'} if key == 'crm' else {})}


def verify_payload(manifest, rollback=False, image=False):
    for key in NAMES:
        name = manifest['rollbackImages' if rollback else 'images'][key] if image else NAMES[key]
        actual = hashes(name, expected_roots(manifest, key, rollback), image=image)
        require(actual['source'] == manifest['rollbackRuntimeSha256' if rollback else 'runtimeSha256'][key], 'RUNTIME_SOURCE_CHANGED')
        require(actual['entrypoints'] == expected_entrypoints(manifest, rollback)[key], 'ENTRYPOINT_CHANGED')
        if key == 'crm':
            require(actual['frontend'] == manifest['rollbackFrontendSha256' if rollback else 'frontendSha256'], 'RUNTIME_FRONTEND_CHANGED')


def image_id(image):
    return json.loads(run(['docker', 'image', 'inspect', image]))[0]['Id']


def preserved(before):
    for key, name in [('engine', 'ai_engine'), ('admin', 'admin_ui')]:
        current = state(name)
        require(current['Id'] == before[key]['Id'] and current['Image'] == before[key]['Image'], 'UNTOUCHED_SERVICE_CHANGED')
        check(before[key], name, before[key]['Image'])
    with urlopen('http://127.0.0.1:15000/health', timeout=3) as response:
        health = json.load(response)
    require(health.get('status') == 'healthy' and health.get('ari_connected')
            and health.get('providers', {}).get('yandex_realtime', {}).get('ready'), 'VOICE_HEALTH_CHANGED')


def idle():
    channels = run(['asterisk', '-rx', 'core show channels count'])
    require('0 active calls' in channels and '0 active channels' in channels, 'ACTIVE_CALLS')


def database_path(before):
    host_paths = []
    for key in NAMES:
        location = pathlib.PurePosixPath(envmap(before[key]).get('DB_PATH', '/app/crm_v2.db'))
        require(location.is_absolute(), 'RELATIVE_DATABASE_PATH')
        matches = []
        for mount in before[key]['Mounts']:
            target = pathlib.PurePosixPath(mount['Destination'])
            if location == target or target in location.parents:
                matches.append((len(target.parts), pathlib.Path(mount['Source']) / str(location.relative_to(target))))
        require(bool(matches), 'DATABASE_NOT_MOUNTED')
        host_paths.append(os.path.realpath(max(matches, key=lambda match: match[0])[1]))
    require(host_paths[0] == host_paths[1], 'CRM_WORKER_DATABASE_MISMATCH')
    return pathlib.Path(host_paths[0])


def no_other_writers(before):
    directory = database_path(before).parent
    ids = run(['docker', 'ps', '-q']).split()
    if not ids:
        return
    for row in json.loads(run(['docker', 'inspect', *ids])):
        if row['Name'].lstrip('/') in NAMES.values():
            continue
        for mount in row['Mounts']:
            source = pathlib.Path(os.path.realpath(mount['Source']))
            if mount.get('RW') and (source == directory or source in directory.parents or directory in source.parents):
                raise RuntimeError('OTHER_DATABASE_WRITER')


def database_check(mode, before=None, manifest=None, stopped=False):
    script = (R / 'team-sales-migration-check.js').read_text()
    if stopped:
        file = database_path(before)
        command = ['docker', 'run', '--rm', '-i', '--network', 'none', '--entrypoint', 'node',
                   '--mount', f'type=bind,source={file.parent},target=/check,readonly',
                   '-e', f'DB_PATH=/check/{file.name}', manifest['images']['worker'], '-', mode]
    else:
        command = ['docker', 'exec', '-i', NAMES['worker'], 'node', '-', mode]
    process = subprocess.run(command, input=script, timeout=30, capture_output=True, text=True, env=ENV)
    try:
        receipt = json.loads(process.stdout.strip())
    except ValueError:
        raise RuntimeError('DATABASE_VALIDATION_FAILED') from None
    if process.returncode:
        code = receipt.get('reason', '')
        require(re.fullmatch(r'[A-Z_]+', code), 'DATABASE_VALIDATION_FAILED')
        raise RuntimeError(code)
    require(receipt.get('phase') == ('database_idle' if mode == 'idle' else 'schema_verified'), 'DATABASE_VALIDATION_FAILED')
    return receipt


def stop_writers(before):
    # Stop both before either replacement starts: only one schema migrator runs.
    existing = [name for name in NAMES.values() if optional_state(name) is not None]
    if existing:
        run(['docker', 'stop', '-t', '35', *existing], timeout=85)
    for name in NAMES.values():
        current = optional_state(name)
        require(current is None or not current['State']['Running'], 'DATABASE_WRITER_STILL_RUNNING')
    no_other_writers(before)


def assert_counts_preserved(baseline, schema):
    for table, count in (baseline or {}).get('counts', {}).items():
        require(table in schema['counts'] and schema['counts'][table] >= count, 'MIGRATION_ROW_COUNT_DECREASED')


def stopped_idle(before, manifest):
    # Processes are already stopped. A killed process may still hold a short
    # persisted lease; wait for expiry instead of migrating under that lease.
    deadline = time.monotonic() + 65
    while True:
        try:
            return database_check('idle', before, manifest, stopped=True)
        except RuntimeError as error:
            if str(error) not in {'ACTIVE_ENROLLMENT_LEASE', 'ACTIVE_IDENTITY_LEASE', 'ACTIVE_PROVISIONING_LEASE'} or time.monotonic() >= deadline:
                raise
            time.sleep(2)


def start_pair(before, manifest, override, rollback=False, baseline=None):
    images = manifest['rollbackImages' if rollback else 'images']
    up(before['worker'], override)
    wait(NAMES['worker'])
    check(before['worker'], NAMES['worker'], image_id(images['worker']))
    schema = database_check('schema')
    assert_counts_preserved(baseline, schema)
    up(before['crm'], override)
    wait(NAMES['crm'])
    for key in NAMES:
        check(before[key], NAMES[key], image_id(images[key]))
    verify_payload(manifest, rollback=rollback)
    preserved(before)
    return schema


def restore(before, manifest):
    override = write_override(before, manifest, rollback=True)
    idle()
    stop_writers(before)
    baseline = stopped_idle(before, manifest)
    return start_pair(before, manifest, override, rollback=True, baseline=baseline)


def check_backup(manifest, fresh=True):
    directory = pathlib.Path(manifest['backup'])
    archive = directory / 'recovery-full.tar.gz.gpg'
    require(archive.is_file(), 'BACKUP_MISSING')
    digest = hashlib.sha256()
    with archive.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    require(digest.hexdigest() == manifest['backupSha256'], 'BACKUP_DIGEST_CHANGED')
    age = time.time() - archive.stat().st_mtime
    if fresh:
        require(-60 <= age <= int(manifest.get('backupMaxAgeSeconds', 7200)), 'BACKUP_NOT_FRESH')
    require(run(['sha256sum', '-c', 'SHA256SUMS'], cwd=directory).strip() == 'recovery-full.tar.gz.gpg: OK', 'BACKUP_INVALID')


def preflight(before, manifest, rollback=False):
    require(re.fullmatch(r'[0-9a-f]{40}', manifest['commit']) is not None, 'COMMIT_INVALID')
    critical = manifest.get('criticalSourceFiles')
    require(isinstance(critical, dict) and set(critical) == set(NAMES), 'ROLLBACK_CRITICAL_FILES_MISSING')
    required_critical = {'services/database.service.js', 'services/identity/identity-store.js',
        'services/identity/role-policy.js', 'services/identity/module-access-store.js',
        'services/identity/customer-access.js', 'services/sales-workspace.store.js',
        'services/sales-workspace.service.js', 'services/client-identity.service.js'}
    for key in NAMES:
        require(required_critical.issubset(set(critical[key])), 'ROLLBACK_CRITICAL_FILES_INCOMPLETE')
        for relative in critical[key]:
            require(relative in manifest['runtimeSha256'][key]
                    and manifest['runtimeSha256'][key][relative] == manifest['rollbackRuntimeSha256'][key].get(relative), 'ROLLBACK_CRITICAL_SOURCE_DIFFERS')
    emergency = manifest.get('emergencyRollbackSha256', {})
    require(set(emergency) == {'app.js', 'services/identity/team-emergency-guard.js'}, 'EMERGENCY_GUARD_NOT_PINNED')
    for relative, digest in emergency.items():
        require(re.fullmatch(r'[0-9a-f]{64}', digest) is not None
                and manifest['rollbackRuntimeSha256']['crm'].get(relative) == digest, 'EMERGENCY_GUARD_CHANGED')
    require(set(manifest['entrypointSha256']['crm']) == {'server.js'}
            and set(manifest['entrypointSha256']['worker']) == {'provisioning-worker.js'}, 'ENTRYPOINT_MANIFEST_INVALID')
    require(set(expected_entrypoints(manifest, True)['crm']) == {'server.js'}
            and set(expected_entrypoints(manifest, True)['worker']) == {'provisioning-worker.js'}, 'ROLLBACK_ENTRYPOINT_MANIFEST_INVALID')
    check_backup(manifest, fresh=not rollback)
    for relative, digest in manifest['filesSha256'].items():
        file = (R / relative).resolve()
        require(R.resolve() in file.parents, 'RELEASE_PATH_ESCAPES')
        require(hashlib.sha256(file.read_bytes()).hexdigest() == digest, 'PAYLOAD_CHANGED')
    require('team-sales-migration-check.js' in manifest['filesSha256'], 'DATABASE_CHECK_NOT_PINNED')
    preserved(before)
    no_other_writers(before)
    for key in NAMES:
        require(not (state(NAMES[key])['State']['Paused']), 'SERVICE_PAUSED')
        if not rollback:
            check(before[key], NAMES[key], before[key]['Image'])
            actual = hashes(NAMES[key], {'source': '/app/src'})['source']
            require(actual == manifest['crmBaselineSha256' if key == 'crm' else 'workerBaselineSha256'], 'LIVE_SOURCE_CHANGED')
        else:
            current = state(NAMES[key])
            allowed = {image_id(manifest['images'][key]), image_id(manifest['rollbackImages'][key])}
            require(current['Image'] in allowed, 'ROLLBACK_TARGET_CHANGED')
            check(before[key], NAMES[key], current['Image'])
        for image in [manifest['images'][key], manifest['rollbackImages'][key]]:
            image_id(image)
    verify_payload(manifest, image=True)
    verify_payload(manifest, rollback=True, image=True)
    idle()
    database_check('idle')
    return write_override(before, manifest, rollback=rollback)


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--apply', action='store_true')
    group.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    before = json.loads((R / 'before.private.json').read_text())
    manifest = json.loads((R / 'manifest.json').read_text())
    override = preflight(before, manifest, rollback=args.rollback)
    print(json.dumps({'phase': 'plan', 'commit': manifest['commit'], 'backup': manifest['backup'],
                      'services': list(NAMES.values()), 'order': ['stop_both', 'worker', 'crm'],
                      'rollbackPreservesCriticalBackend': True, 'rollbackCustomerAccess': 'owner_only',
                      'rollbackInvitations': 'disabled'}), flush=True)
    if not args.apply and not args.rollback:
        return
    touched = False
    try:
        # Repeat immediately before stop. A plan is never permission to skip gates.
        idle()
        database_check('idle')
        touched = True
        stop_writers(before)
        baseline = stopped_idle(before, manifest)
        schema = start_pair(before, manifest, override, rollback=args.rollback, baseline=baseline)
    except Exception:
        if touched and not args.rollback:
            print(json.dumps({'phase': 'rollback_after_failure', 'criticalBackendRetained': True,
                              'customerAccess': 'owner_only'}), flush=True)
            try:
                restore(before, manifest)
            except Exception:
                raise RuntimeError('CUTOVER_AND_COMPATIBLE_ROLLBACK_FAILED') from None
            raise RuntimeError('CUTOVER_FAILED_ROLLED_BACK') from None
        raise
    print(json.dumps({'phase': 'rolled_back' if args.rollback else 'complete', 'commit': manifest['commit'],
                      'backup': manifest['backup'], 'voiceUnchanged': True, 'noDataRestore': True,
                      'schema': schema}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error)
        code = message if re.fullmatch(r'[A-Z_]+', message) else type(error).__name__
        print(json.dumps({'phase': 'failed', 'reason': code}), flush=True)
        raise SystemExit(1)
