#!/usr/bin/env python3
"""Guarded additive serializer overlay; retain existing WhatsApp auth and media fix.

Stage this operator, patch.cjs and manifest.json in a fresh private --root.
Stage the exact pinned release core as --root/../core.py. Prepare builds an
offline candidate only; apply restarts only the gateway and fences retries.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import time

NAME = 'whatsapp_crm_openwa'
CORE_SHA = '1f8e0e2845d15bd504f4d33550545b9734b0bd83361f57d3ec8d2568d375015d'
PATCH_SHA = 'c0b01e1ed335824ab608ec3a6a0f1bd9de1c86d44da09777ec012aa2e7d92b48'
MANIFEST_SHA = '3985f8618371c35c83bbd2fe730e9f8b45c343e49f91a4db013f8d6e22fa70c3'
BASE = 'sha256:ac87d268d87b7f2dba6e92c77df6d6998a826ac7d9cf0be01936bca5764871f3'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require(value, code):
    if not value:
        raise RuntimeError(code)


def load_manifest(root):
    require(sha(root / 'manifest.json') == MANIFEST_SHA, 'MANIFEST_DRIFT')
    require(sha(root / 'patch.cjs') == PATCH_SHA, 'PATCH_DRIFT')
    manifest = json.loads((root / 'manifest.json').read_text())
    require(manifest['baseImage'] == BASE and len(manifest['files']) == 4, 'MANIFEST_CONTRACT_DRIFT')
    return manifest


def mounts(row):
    return sorted((v['Type'], v.get('Name'), v['Source'], v['Destination'], v['RW'], v.get('Propagation'))
                  for v in row['Mounts'])


def networks(row):
    return {name: {key: sorted(value.get(key) or []) if key == 'Aliases' else value.get(key)
                   for key in ['Aliases', 'Links', 'DriverOpts', 'IPAMConfig']}
            for name, value in row['NetworkSettings']['Networks'].items()}


def file_hashes(core, manifest, image=None):
    targets = [v['target'] for v in manifest['files']] + [manifest['preserved']['target']]
    script = "const fs=require('fs'),c=require('crypto');console.log(JSON.stringify(Object.fromEntries(" + json.dumps(targets) + ".map(p=>[p,c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))))"
    command = (['docker', 'run', '--rm', '--network=none', '--entrypoint', 'node', image]
               if image else ['docker', 'exec', NAME, 'node'])
    return json.loads(core.run(command + ['-e', script]))


def expected_hashes(manifest, rollback=False):
    return {v['target']: v['before' if rollback else 'after'] for v in manifest['files']} | {
        manifest['preserved']['target']: manifest['preserved']['sha256']}


def wait_healthy(core, timeout=240):
    deadline = time.monotonic() + timeout
    while True:
        row = core.inspect(NAME)
        require(row['State']['Running'], 'GATEWAY_STOPPED')
        status = row['State'].get('Health', {}).get('Status')
        if status == 'healthy':
            # Also exercise the current readiness endpoint, rather than trusting
            # an earlier Docker healthcheck result immediately after replacement.
            core.run(['docker', 'exec', NAME, 'node', '-e',
                      "fetch('http://127.0.0.1:2785/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"])
            return
        require(status != 'unhealthy', 'GATEWAY_UNHEALTHY')
        require(time.monotonic() < deadline, 'GATEWAY_HEALTH_TIMEOUT')
        time.sleep(2)


def check_contract(core, prepared, manifest, rollback=False):
    row = core.inspect(NAME)
    before = prepared['before']
    require(row['Image'] == (BASE if rollback else prepared['image']) and row['State']['Running'], 'GATEWAY_IMAGE_DRIFT')
    require(mounts(row) == mounts(before), 'AUTH_VOLUME_DRIFT')
    require(core.envmap(row) == core.envmap(before), 'ENVIRONMENT_DRIFT')
    for key in ['User', 'Entrypoint', 'Cmd', 'WorkingDir', 'Healthcheck', 'StopSignal', 'StopTimeout', 'Tty', 'OpenStdin']:
        require(row['Config'].get(key) == before['Config'].get(key), 'PROCESS_DRIFT')
    for key in ['PortBindings', 'RestartPolicy', 'LogConfig', 'Privileged', 'CapAdd', 'CapDrop', 'SecurityOpt',
                'Devices', 'NetworkMode', 'Tmpfs', 'ReadonlyRootfs', 'Memory', 'NanoCpus', 'PidsLimit', 'ShmSize', 'Ulimits']:
        require(row['HostConfig'].get(key) == before['HostConfig'].get(key), 'HOST_CONFIG_DRIFT')
    require(networks(row) == networks(before), 'NETWORK_DRIFT')
    require(file_hashes(core, manifest) == expected_hashes(manifest, rollback), 'GATEWAY_INSTALLED_SOURCE_DRIFT')


def check_inputs(prepared):
    require(all(sha(path) == value for path, value in prepared['inputs'].items()), 'COMPOSE_INPUT_DRIFT')


def up(core, prepared, override):
    check_inputs(prepared)
    command, cwd, service = core.compose(prepared['before'], override)
    core.run(command + ['up', '-d', '--no-deps', '--no-build', service], cwd=cwd, timeout=120)
    wait_healthy(core)


def prepare(core, root, manifest):
    require(not (root / 'prepared.private.json').exists(), 'ALREADY_PREPARED')
    before = core.inspect(NAME)
    require(before['Image'] == BASE and before['State']['Running'], 'BASE_CONTAINER_CHANGED')
    require(file_hashes(core, manifest) == expected_hashes(manifest, True), 'EXACT_PREIMAGE_DRIFT')
    wait_healthy(core)
    data = [v for v in before['Mounts'] if v['Destination'] == '/app/data']
    require(len(data) == 1 and data[0]['RW'], 'AUTH_VOLUME_CONTRACT_DRIFT')
    baseline = core.rendered(before)
    suffix = MANIFEST_SHA[:12]
    base_tag, candidate_tag = 'ava-openwa-product-base:' + suffix, 'ava-openwa-product:' + suffix
    core.run(['docker', 'tag', BASE, base_tag])
    targets = [v['target'] for v in manifest['files']]
    dockerfile = ('FROM ' + base_tag + '\n'
                  'COPY patch.cjs manifest.json /tmp/ava-product-patch/\n'
                  'RUN node /tmp/ava-product-patch/patch.cjs /app' +
                  ''.join(' && node --check ' + p for p in targets) +
                  ' && rm -r /tmp/ava-product-patch\n')
    (root / 'Dockerfile').write_text(dockerfile)
    (root / '.dockerignore').write_text('*\n!Dockerfile\n!patch.cjs\n!manifest.json\n')
    core.run(['docker', 'build', '--pull=false', '--network=none', '-t', candidate_tag, str(root)], timeout=180)
    image = json.loads(core.run(['docker', 'image', 'inspect', candidate_tag]))[0]['Id']
    require(file_hashes(core, manifest, image) == expected_hashes(manifest), 'CANDIDATE_SOURCE_DRIFT')
    inputs = {str(root / name): sha(root / name) for name in ['patch.cjs', 'manifest.json', 'Dockerfile', '.dockerignore']}
    inputs[str(Path(__file__).resolve())] = sha(__file__)
    inputs[str(root.parent / 'core.py')] = CORE_SHA
    labels = before['Config']['Labels']
    for key in ['com.docker.compose.project.config_files', 'com.docker.compose.project.environment_file']:
        for path in labels.get(key, '').split(','):
            if path:
                inputs[path] = sha(path)
    prepared = {'before': before, 'image': image, 'inputs': inputs, 'otherContainers': core.other_containers()}
    for mode, selected in [('candidate', image), ('rollback', BASE)]:
        path = root / (mode + '.private.json')
        core.private_json(path, {'services': {labels['com.docker.compose.service']: {
            'image': selected, 'environment': {k: v.replace('$', '$$') for k, v in core.envmap(before).items()}}}})
        rendered = core.rendered(before, path)
        require(rendered == dict(baseline, image=selected, environment=core.envmap(before)), 'COMPOSE_CONTRACT_DRIFT')
        prepared[mode] = str(path)
        inputs[str(path)] = sha(path)
    core.private_json(root / 'prepared.private.json', prepared)
    return {'phase': 'prepared', 'image': image, 'patchedFiles': 4, 'priorMediaFixPreserved': True}


def database_backups(core, prepared, root):
    data = Path(next(v['Source'] for v in prepared['before']['Mounts'] if v['Destination'] == '/app/data'))
    backups = [core.backup(data / 'openwa.sqlite', root / 'openwa-backup.db')]
    # Old installations can retain an empty main.sqlite; only back up populated
    # SQLite databases. Source files are opened read-only, using online backup.
    if (data / 'main.sqlite').is_file():
        with sqlite3.connect((data / 'main.sqlite').resolve().as_uri() + '?mode=ro', uri=True) as db:
            populated = db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
        if populated:
            backups.append(core.backup(data / 'main.sqlite', root / 'main-backup.db'))
    return backups


def apply_release(core, prepared, manifest, root):
    check_inputs(prepared)
    require(core.other_containers() == prepared['otherContainers'], 'OTHER_CONTAINER_DRIFT')
    row = core.inspect(NAME)
    require(row['Id'] == prepared['before']['Id'] and row['Image'] == BASE, 'CONTAINER_DRIFT')
    check_contract(core, prepared, manifest, True)
    require(not (root / 'apply-started').exists(), 'APPLY_ALREADY_ATTEMPTED')
    backups = database_backups(core, prepared, root)
    core.private_json(root / 'backups.private.json', backups)
    (root / 'apply-started').write_text(str(time.time()))
    try:
        up(core, prepared, prepared['candidate'])
        check_contract(core, prepared, manifest)
        require(core.other_containers() == prepared['otherContainers'], 'OTHER_CONTAINER_DRIFT')
        receipt = {'phase': 'applied', 'image': prepared['image'], 'sourceHashes': expected_hashes(manifest),
                   'authVolumePreserved': True, 'databaseRestored': False, 'otherContainersUnchanged': True}
        core.private_json(root / 'applied.private.json', receipt)
        return receipt
    except BaseException:
        # The named volume is retained on rollback. Never replace an active DB
        # with the snapshot: messages may have arrived during the release.
        up(core, prepared, prepared['rollback'])
        check_contract(core, prepared, manifest, True)
        require(core.other_containers() == prepared['otherContainers'], 'OTHER_CONTAINER_DRIFT')
        core.private_json(root / 'automatic-rollback.private.json', {'image': BASE, 'databaseRestored': False})
        raise


def rollback_release(core, prepared, manifest):
    check_inputs(prepared)
    require(core.other_containers() == prepared['otherContainers'], 'OTHER_CONTAINER_DRIFT')
    require(core.inspect(NAME)['Image'] == prepared['image'], 'GATEWAY_IMAGE_DRIFT')
    up(core, prepared, prepared['rollback'])
    check_contract(core, prepared, manifest, True)
    require(core.other_containers() == prepared['otherContainers'], 'OTHER_CONTAINER_DRIFT')
    return {'phase': 'rolled_back', 'image': BASE, 'databaseRestored': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'apply', 'rollback'])
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    root = args.root.resolve()
    root.mkdir(mode=0o700, exist_ok=True)
    root.chmod(0o700)
    require(sha(root.parent / 'core.py') == CORE_SHA, 'OPERATOR_DRIFT')
    manifest = load_manifest(root)
    spec = importlib.util.spec_from_file_location('core', root.parent / 'core.py')
    core = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(core)
    core.LOG_ROOT = root
    core.NAMES = {'gateway': NAME}
    with open('/var/lock/ava-customer-path-release.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.mode == 'prepare':
            result = prepare(core, root, manifest)
        else:
            prepared = json.loads((root / 'prepared.private.json').read_text())
            result = (apply_release(core, prepared, manifest, root) if args.mode == 'apply'
                      else rollback_release(core, prepared, manifest))
        print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        print(json.dumps({'phase': 'failed', 'code': code if code.replace('_', '').isalnum() else type(error).__name__}))
        raise SystemExit(1)
