#!/usr/bin/env python3
"""Run pinned Onyx migrations/probes on an explicitly empty AVA QA manifest.

Only labelled QA networks and own directories are accepted. No production
mounts or external ports are added. Dependency logs stay in root-only files.
"""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess


def safe_excerpt(directory, phase):
    output = (directory / (phase + '.log')).read_text(errors='replace')
    for line in (directory / 'native.env').read_text().splitlines():
        key, _, value = line.partition('=')
        if re.search('PASSWORD|SECRET|TOKEN|API_KEY', key) and value:
            output = output.replace(value, '[REDACTED]')
    output = re.sub(r'(?i)(Bearer|Basic)\s+\S+', r'\1 [REDACTED]', output)
    output = re.sub(r'(\w+://)[^\s/@]+:[^\s/@]+@', r'\1[REDACTED]@', output)
    return '\n'.join(output.splitlines()[-18:])[-3500:]


def run(manifest_path, probe=False, inspect=False, cross_scope=False, http_wiring=False):
    base = Path('/opt/ava-acceptance/ecosystem-20260914')
    root = manifest_path.resolve().parent
    if os.geteuid() != 0 or root.parent != base or not root.name.startswith('native-auth-qa-'):
        raise ValueError('QA_DIRECTORY_REQUIRED')
    os.umask(0o077)
    manifest = json.loads(manifest_path.read_text())
    if (manifest.get('qa_only') is not True or manifest.get('production_volumes_mounted') is not False
            or manifest.get('external_network') is not False or len(manifest['deployments']) != 2):
        raise ValueError('QA_MANIFEST_REQUIRED')
    if sum((bool(probe), bool(cross_scope), bool(http_wiring))) > 1:
        raise ValueError('ONE_QA_PHASE_REQUIRED')
    image_name = 'ava-onyx-http:qa-20260914' if http_wiring else 'ava-onyx-auth:qa-20260914'
    image = subprocess.check_output(['docker', 'image', 'inspect', image_name, '--format', '{{.Id}}'], text=True).strip()
    if not re.fullmatch('sha256:[a-f0-9]{64}', image):
        raise ValueError('IMMUTABLE_IMAGE_REQUIRED')
    if cross_scope:
        return run_cross_scope(root, manifest, image)
    evidence = []
    for item in manifest['deployments']:
        network = item['network']
        if not re.fullmatch(r'ava-auth-qa-[a-f0-9]{12}-[12]', network) or item['business_id'] not in (900001, 900002):
            raise ValueError('QA_SCOPE_REQUIRED')
        labels = json.loads(subprocess.check_output(['docker', 'network', 'inspect', network, '--format', '{{json .Labels}}'], text=True))
        if labels.get('ava.qa.run') != manifest['run_id']:
            raise ValueError('QA_NETWORK_REQUIRED')
        directory = Path(item['directory']).resolve()
        if directory.parent != root:
            raise ValueError('QA_PATH_REQUIRED')
        phase = 'http-wiring' if http_wiring else 'probe' if probe else 'migrate'
        if inspect:
            print(json.dumps({'business_id': item['business_id'], 'phase': phase, 'safe_log': safe_excerpt(directory, phase)}))
            continue
        key_file = directory / 'auth-encryption.key'
        if (probe or http_wiring) and not key_file.exists():
            fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as key:
                key.write(secrets.token_hex(32))
            os.chown(key_file, 1001, 1001)
        command = (['python', '-m', 'onyx.ava_auth.qa_http_wiring'] if http_wiring else
                   ['python', '-m', 'onyx.ava_auth.qa_probe'] if probe else ['alembic', '-c', '/app/alembic.ini', 'upgrade', 'head'])
        args = ['docker', 'run', '--rm', '--name', network + '-' + phase, '--network', network,
                '--label', 'ava.qa.run=' + manifest['run_id'], '--memory', '2g', '--cpus', '2', '--pids-limit', '192',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
                '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=128m', '--env-file', str(directory / 'native.env'),
                '-e', 'AVA_NATIVE_QA=true']
        if probe or http_wiring:
            args += ['--mount', f'type=bind,src={key_file},dst=/run/ava-qa-key,readonly',
                     '-e', 'AVA_AUTH_ENCRYPTION_KEY_FILE=/run/ava-qa-key']
        args += [image, *command]
        with (directory / (phase + '.log')).open('w') as log:
            result = subprocess.run(args, text=True, stdout=log, stderr=subprocess.STDOUT, timeout=300)
        record = {'business_id': item['business_id'], 'phase': phase, 'exit_code': result.returncode,
                  'image': image, 'production_mounts': False, 'public_ports': False}
        evidence.append(record)
        print(json.dumps(record), flush=True)
        if result.returncode:
            print(json.dumps({'safe_log': safe_excerpt(directory, phase)}), flush=True)
            break
    if inspect:
        return
    filename = 'http-wiring-results.json' if http_wiring else 'probe-results.json' if probe else 'migration-results.json'
    (root / filename).write_text(json.dumps(evidence, indent=2) + '\n')
    if len(evidence) != 2 or any(row['exit_code'] for row in evidence):
        raise RuntimeError('NATIVE_QA_FAILED_PRIVATE_LOG_AVAILABLE')


def run_cross_scope(root, manifest, image):
    items = manifest['deployments']
    for item in items:
        directory = Path(item['directory']).resolve()
        if (directory.parent != root or item['business_id'] not in (900001, 900002)
                or not re.fullmatch(r'ava-auth-qa-[a-f0-9]{12}-[12]', item['network'])):
            raise ValueError('QA_SCOPE_REQUIRED')
        labels = json.loads(subprocess.check_output(['docker', 'network', 'inspect', item['network'], '--format', '{{json .Labels}}'], text=True))
        if labels.get('ava.qa.run') != manifest['run_id']:
            raise ValueError('QA_NETWORK_REQUIRED')
        proofs = directory / 'cross-scope'
        proofs.mkdir(mode=0o700, exist_ok=False)
        os.chown(proofs, 1001, 1001)
    evidence = []

    def phase(item, mode, other):
        directory = Path(item['directory'])
        proof_dir = directory / 'cross-scope'
        args = ['docker', 'run', '--rm', '--name', item['network'] + '-cross-' + mode,
                '--network', item['network'], '--label', 'ava.qa.run=' + manifest['run_id'],
                '--memory', '2g', '--cpus', '2', '--pids-limit', '192', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=128m',
                '--env-file', str(directory / 'native.env'), '-e', 'AVA_NATIVE_QA=true',
                '-e', 'AVA_NATIVE_QA_CROSS_SCOPE_MODE=' + mode, '-e', 'AVA_NATIVE_QA_PROOF_FILE=/run/ava-qa/proof.json',
                '--mount', f'type=bind,src={proof_dir},dst=/run/ava-qa']
        if mode == 'check':
            args += ['--mount', f'type=bind,src={Path(other["directory"]) / "cross-scope/proof.json"},dst=/run/ava-qa/foreign.json,readonly',
                     '-e', 'AVA_NATIVE_QA_FOREIGN_PROOF_FILE=/run/ava-qa/foreign.json']
        args += [image, 'python', '-m', 'onyx.ava_auth.qa_cross_scope']
        with (directory / ('cross-' + mode + '.log')).open('w') as log:
            result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=60)
        record = {'business_id': item['business_id'], 'phase': 'cross-' + mode, 'exit_code': result.returncode, 'image': image}
        evidence.append(record)
        if mode != 'export' or result.returncode:
            record['safe_log'] = safe_excerpt(directory, 'cross-' + mode)
        print(json.dumps(record), flush=True)
        return result.returncode == 0

    ok = True
    try:
        for mode in ('export', 'check'):
            for index, item in enumerate(items):
                if not phase(item, mode, items[1 - index]):
                    ok = False
                    raise RuntimeError('NATIVE_CROSS_SCOPE_FAILED')
    finally:
        for index, item in enumerate(items):
            if (Path(item['directory']) / 'cross-scope/proof.json').exists():
                ok = phase(item, 'cleanup', items[1 - index]) and ok
        (root / 'cross-scope-results.json').write_text(json.dumps(evidence, indent=2) + '\n')
    if not ok:
        raise RuntimeError('NATIVE_CROSS_SCOPE_FAILED')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--http-wiring', action='store_true', help='Verify real main router/guard without external-service lifespan or browser claims')
    parser.add_argument('--inspect', action='store_true', help='Only print redacted QA logs; do not run containers')
    parser.add_argument('--cross-scope', action='store_true', help='Verify both native contours reject each other while their own sessions stay valid')
    args = parser.parse_args()
    try:
        if args.inspect and args.cross_scope:
            raise ValueError('INCOMPATIBLE_QA_MODES')
        run(args.manifest, args.probe, args.inspect, args.cross_scope, args.http_wiring)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError):
        raise SystemExit('NATIVE_QA_FAILED_PRIVATE_LOG_AVAILABLE')
