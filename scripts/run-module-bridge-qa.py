#!/usr/bin/env python3
"""Run real AVA broker/gateway/native HTTP only against disposable Twenty QA."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess

spec = importlib.util.spec_from_file_location('qa_logs', Path(__file__).with_name('run-native-auth-qa.py'))
logs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(logs)


def run(manifest_path):
    root = manifest_path.resolve().parent
    base = Path('/opt/ava-acceptance/ecosystem-20260914')
    if os.geteuid() != 0 or root.parent != base or not root.name.startswith('twenty-auth-qa-'):
        raise ValueError('QA_DIRECTORY_REQUIRED')
    os.umask(0o077)
    data = json.loads(manifest_path.read_text())
    if (data.get('qa_only') is not True or data.get('business_id') != 900003
            or data.get('production_volumes_mounted') is not False or data.get('external_network') is not False
            or data.get('directory') != str(root)
            or not re.fullmatch(r'ava-twenty-auth-qa-[a-f0-9]{12}', data.get('network', ''))):
        raise ValueError('QA_SCOPE_REQUIRED')
    network = json.loads(subprocess.check_output(['docker', 'network', 'inspect', data['network']], text=True))[0]
    if network['Labels'].get('ava.qa.run') != data['run_id'] or network['Internal'] is not True:
        raise ValueError('QA_NETWORK_REQUIRED')
    server = json.loads(subprocess.check_output(['docker', 'inspect', data['network'] + '-serve'], text=True))[0]
    if server['Config']['Labels'].get('ava.qa.run') != data['run_id'] or not server['State']['Running']:
        raise ValueError('QA_NATIVE_SERVER_REQUIRED')
    image = subprocess.check_output(['docker', 'image', 'inspect', 'ava-ecosystem-crm:qa-20260914', '--format', '{{.Id}}'], text=True).strip()
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
        raise ValueError('IMMUTABLE_QA_IMAGE_REQUIRED')
    source = base / 'bridge-source'
    if not (source / 'native_modules/gateway/qa/twenty-bridge.cjs').is_file():
        raise ValueError('QA_SOURCE_REQUIRED')
    args = ['docker', 'run', '--rm', '--name', data['network'] + '-bridge', '--network', data['network'],
            '--label', 'ava.qa.run=' + data['run_id'], '--memory', '1g', '--cpus', '1', '--pids-limit', '128',
            '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--env-file', str(root / 'native.env'),
            '-e', 'DB_PATH=/tmp/ava-bridge/ava.sqlite', '-e', 'NODE_PATH=/app/node_modules',
            '--mount', f'type=bind,src={source},dst=/opt/ava-qa-source,readonly',
            '--mount', f'type=bind,src={root / "state"},dst=/run/ava-native-context,readonly',
            '--mount', f'type=bind,src={root / "keys"},dst=/run/ava-native-keys,readonly',
            '--entrypoint', 'node', image, '/opt/ava-qa-source/native_modules/gateway/qa/twenty-bridge.cjs']
    with (root / 'bridge.log').open('w') as output:
        result = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT, timeout=240)
    record = {'qa_only': True, 'business_id': data['business_id'], 'phase': 'bridge', 'exit_code': result.returncode,
              'runtime_image': image, 'native_image': server['Image'], 'production_mounts': False,
              'public_ports': False, 'keycloak_browser_tls_accepted': False}
    (root / 'bridge-result.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record), flush=True)
    print(json.dumps({'safe_log': logs.safe_excerpt(root, 'bridge')}), flush=True)
    if result.returncode:
        raise RuntimeError('QA_BRIDGE_FAILED')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    args = parser.parse_args()
    try:
        run(args.manifest)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError):
        raise SystemExit('QA_BRIDGE_FAILED_PRIVATE_LOG_AVAILABLE')
