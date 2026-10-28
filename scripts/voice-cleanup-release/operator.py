#!/usr/bin/env python3
"""Engine-only release with exact runtime preservation, idle check and rollback."""
import argparse
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from urllib.request import urlopen

CORE_HASH = '1f8e0e2845d15bd504f4d33550545b9734b0bd83361f57d3ec8d2568d375015d'
core_path = Path(__file__).with_name('neuro_release_operator.py')
if not core_path.exists():
    core_path = Path(__file__).parents[1] / 'neuro-gemini-release/release_operator.py'
assert hashlib.sha256(core_path.read_bytes()).hexdigest() == CORE_HASH, 'CORE_DRIFT'
spec = importlib.util.spec_from_file_location('voice_cleanup_core', core_path)
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
require, run, inspect = core.require, core.run, core.inspect


def peers():
    rows = json.loads(run(['docker', 'inspect', *run(['docker', 'ps', '-aq']).split()]))
    return {r['Name']: [r['Id'], r['Image'], r['State']['Running'], r.get('RestartCount')]
            for r in rows if r['Name'] != '/ai_engine'}


def health():
    with urlopen('http://127.0.0.1:15000/health', timeout=4) as response:
        h = json.load(response)
    require(h.get('status') == 'healthy' and h.get('ari_connected') is True
            and h.get('audiosocket', {}).get('listening') is True, 'ENGINE_NOT_HEALTHY')
    return h


def idle():
    health()
    with urlopen('http://127.0.0.1:15000/sessions/stats', timeout=4) as response:
        s = json.load(response)
    require(s['active_calls'] == 0 and s['provider_sessions'] == 0, 'CALLS_ACTIVE')
    require(not run(['timeout', '5', 'asterisk', '-rx', 'core show channels concise']).strip(), 'ASTERISK_CHANNELS_ACTIVE')


def source_hashes():
    script = 'import pathlib,hashlib,json; print(json.dumps({str(p.relative_to("/app")):hashlib.sha256(p.read_bytes()).hexdigest() for p in pathlib.Path("/app/src").rglob("*.py")}))'
    return json.loads(run(['docker', 'exec', 'ai_engine', 'python', '-c', script]))


def check(row, before, manifest, rollback=False):
    wanted = before['Image'] if rollback else manifest['candidateImage']
    require(row['Image'] == wanted and row['State']['Running'], 'IMAGE_OR_RUNNING_MISMATCH')
    require(core.envmap(row) == core.envmap(before), 'ENVIRONMENT_CHANGED')
    for key in ['User', 'Entrypoint', 'Cmd', 'WorkingDir']:
        require(row['Config'][key] == before['Config'][key], 'RUNTIME_CONFIG_CHANGED:' + key)
    live_host, old_host = copy.deepcopy(row['HostConfig']), copy.deepcopy(before['HostConfig'])
    # Docker Compose may reorder equivalent bind strings on recreation.
    for host in (live_host, old_host):
        host['Binds'] = sorted(host.get('Binds') or [])
    require(live_host == old_host, 'HOST_CONFIG_CHANGED')
    require(core.mount_signature(row['Mounts'], live=True) == core.mount_signature(before['Mounts'], live=True), 'MOUNTS_CHANGED')
    require(set(row['NetworkSettings']['Networks']) == set(before['NetworkSettings']['Networks']), 'NETWORK_CHANGED')


def shared(p):
    require(peers() == p['peers'], 'UNRELATED_SERVICE_CHANGED')
    require(all(core.sha(path) == digest for path, digest in p['inputs'].items()), 'CONFIG_CHANGED')


def prepare(root):
    require(not (root / 'prepared.private.json').exists(), 'ALREADY_PREPARED')
    idle()
    manifest = json.loads((root / 'manifest.json').read_text())
    before = inspect('ai_engine')
    require(before['Image'] == manifest['baseImage'], 'BASE_IMAGE_DRIFT')
    hashes = source_hashes()
    require(all(hashes.get(path) == digest for path, digest in manifest['baseFiles'].items()), 'SOURCE_DRIFT')
    inputs = {}
    labels = before['Config']['Labels']
    for key in ['com.docker.compose.project.config_files', 'com.docker.compose.project.environment_file']:
        for path in labels.get(key, '').split(','):
            if path:
                inputs[path] = core.sha(path)
    for m in before['Mounts']:
        if m['Type'] == 'bind' and m['Destination'] in ['/app/config', '/run/secrets/ava-vertex-adc.json']:
            source = Path(m['Source'])
            for path in ([source] if source.is_file() else [p for p in source.rglob('*') if p.is_file()]):
                inputs[str(path)] = core.sha(path)
            if source.is_dir():
                shutil.copytree(source, root / 'config-backup')
    baseline = core.rendered(before)
    require(core.mount_signature(baseline.get('volumes', [])) == core.mount_signature(before['Mounts'], live=True), 'COMPOSE_MOUNT_DRIFT')
    expected = copy.deepcopy(baseline)
    expected['environment'] = core.envmap(before)
    service = labels['com.docker.compose.service']
    for name, image in [('candidate', manifest['candidateImage']), ('rollback', before['Image'])]:
        override = root / (name + '.private.json')
        core.private_json(override, {'services': {service: {'image': image, 'environment': {k: v.replace('$', '$$') for k, v in expected['environment'].items()}}}})
        rendered = core.rendered(before, override)
        require(rendered['image'] == image, 'RENDERED_IMAGE_MISMATCH')
        for key in set(rendered) | set(expected):
            if key != 'image':
                require(rendered.get(key) == expected.get(key), 'RENDERED_CONFIG_MISMATCH:' + key)
    backups = []
    for name, path in [('crm', '/root/ava-current/data/whatsapp_crm/crm_v2.db'),
                       ('calls', '/root/ava-releases/reviewed-20260915T104238Z/data/call_history.db')]:
        backups.append(core.backup(path, root / (name + '-backup.db')))
    core.private_json(root / 'prepared.private.json', {'before': before, 'manifest': manifest, 'inputs': inputs,
        'peers': peers(), 'sourceHashes': hashes, 'backups': backups})
    print(json.dumps({'phase': 'prepared', 'backupCount': len(backups), 'sourceFiles': len(manifest['files'])}), flush=True)


def up(root, p, rollback=False):
    shared(p)
    idle()
    command, cwd, service = core.compose(p['before'], root / ('rollback.private.json' if rollback else 'candidate.private.json'))
    run(command + ['up', '-d', '--no-deps', '--force-recreate', '--no-build', service], cwd=cwd)
    for _ in range(25):
        try:
            health()
            break
        except Exception:
            time.sleep(1)
    health()
    check(inspect('ai_engine'), p['before'], p['manifest'], rollback)
    shared(p)
    expected = dict(p['sourceHashes'])
    if not rollback:
        expected.update(p['manifest']['files'])
    require(source_hashes() == expected, 'INSTALLED_SOURCE_MISMATCH')
    # Confirm channel accounting is responsive after startup.
    idle()
    receipt = {'phase': 'rolled-back' if rollback else 'deployed', 'image': inspect('ai_engine')['Image'],
               'revision': p['manifest']['candidateCommit'], 'health': True, 'activeCalls': 0,
               'asteriskChannels': 0, 'otherServicesUnchanged': True, 'runtimeUnchanged': True,
               'liveCustomerCallAfterPatch': False}
    core.private_json(root / ('rollback-receipt.json' if rollback else 'receipt.json'), receipt)
    print(json.dumps(receipt), flush=True)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'apply', 'rollback'])
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    core.LOG_ROOT = args.root
    with (args.root / 'operator.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'prepare':
            prepare(args.root)
            return
        p = json.loads((args.root / 'prepared.private.json').read_text())
        if args.action == 'apply':
            before = inspect('ai_engine')
            require(before['Id'] == p['before']['Id'] and before['Image'] == p['before']['Image'], 'ENGINE_CHANGED')
            try:
                up(args.root, p)
            except Exception:
                # Rollback also requires idle; never interrupt a newly active call.
                up(args.root, p, rollback=True)
                raise
        else:
            up(args.root, p, rollback=True)


if __name__ == '__main__':
    main()
