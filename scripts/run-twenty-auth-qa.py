#!/usr/bin/env python3
"""Run real native Twenty setup only on a labelled disposable QA contour."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time

spec = importlib.util.spec_from_file_location('qa_logs', Path(__file__).with_name('run-native-auth-qa.py'))
logs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(logs)

COMMANDS = {
    'init': ['dist/database/scripts/setup-db.js'],
    'migrate': ['dist/command/command', 'run-instance-commands', '--force', '--include-slow'],
    'bootstrap': ['dist/ava-native/qa/bootstrap.cjs'],
    'serve': ['dist/main'],
    'restart': [],
    'mint': ['dist/ava-native/qa/acceptance-probe.cjs'],
    'resolve': ['dist/ava-native/qa/acceptance-probe.cjs'],
    'revoke': ['dist/ava-native/qa/acceptance-probe.cjs'],
}


def run(manifest_path, phase, inspect=False):
    root = manifest_path.resolve().parent
    if os.geteuid() != 0 or root.parent != Path('/opt/ava-acceptance/ecosystem-20260914') or not root.name.startswith('twenty-auth-qa-'):
        raise ValueError('QA_DIRECTORY_REQUIRED')
    os.umask(0o077)
    data = json.loads(manifest_path.read_text())
    if (data.get('qa_only') is not True or data.get('business_id') != 900003 or data.get('production_volumes_mounted') is not False
            or data.get('external_network') is not False or data.get('directory') != str(root)
            or not re.fullmatch(r'ava-twenty-auth-qa-[a-f0-9]{12}', data.get('network', ''))):
        raise ValueError('QA_SCOPE_REQUIRED')
    if inspect:
        print(json.dumps({'phase': phase, 'safe_log': logs.safe_excerpt(root, phase)}))
        return
    labels = json.loads(subprocess.check_output(['docker', 'network', 'inspect', data['network'], '--format', '{{json .Labels}}'], text=True))
    if labels.get('ava.qa.run') != data['run_id']:
        raise ValueError('QA_NETWORK_REQUIRED')
    image = subprocess.check_output(['docker', 'image', 'inspect', 'ava-twenty-auth:qa-20260914', '--format', '{{.Id}}'], text=True).strip()
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
        raise ValueError('IMMUTABLE_IMAGE_REQUIRED')
    adapter = phase in ('serve', 'mint', 'resolve', 'revoke')
    adapter_args = []
    if adapter:
        context = json.loads((root / 'state/context.json').read_text())
        if context['businessId'] != data['business_id'] or context['deploymentId'] != data['deployment_id']:
            raise ValueError('QA_NATIVE_CONTEXT_MISMATCH')
        for field in ('nativeScope', 'managerRoleId', 'hotelOwnerRoleId'):
            if not re.fullmatch(r'[a-f0-9-]{36}', context[field]):
                raise ValueError('QA_NATIVE_CONTEXT_INVALID')
        keys = root / 'keys'
        keys.mkdir(mode=0o700, exist_ok=True)
        os.chown(keys, 1000, 1000)
        for name in ('gateway', 'worker', 'session'):
            file = keys / (name + '.key')
            if not file.exists():
                with file.open('x') as out:
                    out.write(secrets.token_urlsafe(32))
                file.chmod(0o600)
                os.chown(file, 1000, 1000)
        env = {'AVA_NATIVE_ADAPTER_ENABLED': 'true', 'AVA_BUSINESS_ID': str(data['business_id']),
               'AVA_DEPLOYMENT_ID': data['deployment_id'], 'AVA_DEPLOYMENT_REVISION': str(context['revision']),
               'AVA_NATIVE_SCOPE': context['nativeScope'], 'AVA_NATIVE_OWNER_ROLE_ID': context['hotelOwnerRoleId'],
               'AVA_NATIVE_MANAGER_ROLE_ID': context['managerRoleId'],
               'AVA_NATIVE_GATEWAY_SECRET_FILE': '/run/ava-keys/gateway.key',
               'AVA_NATIVE_WORKER_SECRET_FILE': '/run/ava-keys/worker.key',
               'AVA_NATIVE_SESSION_KEY_FILE': '/run/ava-keys/session.key',
               'AVA_QA_PEER_URL': 'http://server:3902', 'AVA_QA_TWENTY_URL': 'http://server:3000',
               'AVA_QA_PRIVATE_HOSTS': 'server', 'AVA_QA_MODE': phase}
        if phase == 'serve':
            env['NODE_OPTIONS'] = '--max-old-space-size=2048 --require=/app/packages/twenty-server/dist/ava-native/preload.cjs'
        for key, value in env.items():
            adapter_args += ['-e', key + '=' + value]
        adapter_args += ['--mount', f'type=bind,src={keys},dst=/run/ava-keys,readonly']
    args = ['docker', 'run', '--rm', '--name', data['network'] + '-' + phase, '--network', data['network'],
            '--label', 'ava.qa.run=' + data['run_id'], '--memory', '3g', '--cpus', '2', '--pids-limit', '256',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--env-file', str(root / 'native.env'),
            '--mount', f'type=bind,src={root / "state"},dst=/run/ava-qa', '--entrypoint', 'node']
    if phase == 'serve':
        args.remove('--rm')
        args += ['-d', '--network-alias', 'server']
    args += adapter_args + [image, *COMMANDS[phase]]
    if phase == 'restart':
        info = json.loads(subprocess.check_output(['docker', 'inspect', data['network'] + '-serve'], text=True))[0]
        if info['Config']['Labels'].get('ava.qa.run') != data['run_id'] or info['Image'] != image:
            raise ValueError('QA_SERVER_IMAGE_REQUIRED')
        args = ['docker', 'restart', '--timeout', '15', data['network'] + '-serve']
    with (root / (phase + '.log')).open('w') as output:
        result = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT, timeout=300)
    if phase in ('serve', 'restart') and result.returncode == 0:
        for _ in range(60):
            ready = subprocess.run(['docker', 'exec', data['network'] + '-serve', 'node', '-e',
                "Promise.all([fetch('http://127.0.0.1:3000/healthz'),fetch('http://127.0.0.1:3902/v1/sessions/create',{method:'POST'})]).then(([app,peer])=>process.exit(app.ok&&peer.status===401?0:1)).catch(()=>process.exit(1))"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            result.returncode = 1
        with (root / (phase + '.log')).open('w') as output:
            subprocess.run(['docker', 'logs', data['network'] + '-serve'], stdout=output, stderr=subprocess.STDOUT, timeout=15)
    record = {'business_id': data['business_id'], 'phase': phase, 'exit_code': result.returncode,
              'image': image, 'production_mounts': False, 'public_ports': False}
    (root / (phase + '-result.json')).write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record), flush=True)
    if result.returncode:
        print(json.dumps({'safe_log': logs.safe_excerpt(root, phase)}), flush=True)
        raise RuntimeError('TWENTY_QA_FAILED')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--phase', choices=COMMANDS, required=True)
    parser.add_argument('--inspect', action='store_true')
    args = parser.parse_args()
    try:
        run(args.manifest, args.phase, args.inspect)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError):
        raise SystemExit('TWENTY_QA_FAILED_PRIVATE_LOG_AVAILABLE')
