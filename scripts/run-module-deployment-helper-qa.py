#!/usr/bin/env python3
"""Real Docker launcher smoke, NOT native Twenty/Onyx or customer acceptance.

Uses an installed Node image for a tiny inert process and a synthetic lease DB.
No published ports, secrets, production mounts, external networks or volumes.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid


spec = importlib.util.spec_from_file_location('deployment_helper', Path(__file__).with_name('module_deployment_helper.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def private(path, value):
    with path.open('x', encoding='utf-8') as output:
        os.chmod(path, 0o600)
        output.write(json.dumps(value, sort_keys=True))


def execute(directory, image):
    if os.geteuid() != 0 or directory.parent != Path('/opt/ava-acceptance/ecosystem-20260914') or directory.exists() or not directory.name.startswith('module-launch-qa-') or not helper.DIGEST.fullmatch(image):
        raise ValueError('NEW_ISOLATED_QA_DIRECTORY_REQUIRED')
    if json.loads(helper.run(['docker', 'image', 'inspect', image], timeout=15))[0]['Id'] != image:
        raise ValueError('INSTALLED_IMMUTABLE_IMAGE_REQUIRED')
    mem = {key: int(value.split()[0]) for key, value in (line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())}
    if mem['MemAvailable'] - 256 * 1024 < mem['MemTotal'] * .2:
        raise ValueError('QA_CAPACITY_REQUIRED')
    os.umask(0o077)
    directory.mkdir(mode=0o700)
    deployment, lease = str(uuid.uuid4()), str(uuid.uuid4())
    namespace = 'ava_' + deployment.replace('-', '')
    root = directory / deployment
    root.mkdir(mode=0o700)
    payload = {'deploymentId': deployment, 'businessId': 900010, 'revision': 1, 'leaseToken': lease}
    recipe = {**{key: value for key, value in payload.items() if key != 'leaseToken'}, 'schemaVersion': 1,
              'module': 'twenty', 'hostname': 'launcher-qa-900010.crm.meludtech.tech', 'namespace': namespace,
              'sourceCommit': helper.PINNED['twenty'], 'imageDigest': image, 'memoryMiB': 256}
    # Module/source fields exercise the contract only. This is deliberately not
    # a Twenty image and /verify must refuse it without a native verifier.
    compose = {'services': {'gateway': {'image': image, 'user': '1000:1000',
                'entrypoint': ['node'], 'command': ['-e', 'setInterval(()=>{},1000)'],
                'read_only': True, 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
                'mem_limit': 64 * 1024**2, 'cpus': .25, 'pids_limit': 32, 'restart': 'no',
                'networks': ['native'], 'labels': {helper.LABEL: deployment,
                    'tech.melud.ava.business': '900010', 'tech.melud.ava.revision': '1'}}},
               'networks': {'native': {'internal': True}}, 'volumes': {}}
    private(root / 'compose.json', compose)
    recipe['composeSha256'] = hashlib.sha256((root / 'compose.json').read_bytes()).hexdigest()
    private(root / 'recipe.json', recipe)
    database = directory / 'synthetic.sqlite'
    with sqlite3.connect(database) as db:
        db.executescript('''CREATE TABLE instances(id INTEGER PRIMARY KEY,isActive INTEGER);
            CREATE TABLE ava_module_deployments(id TEXT PRIMARY KEY,businessId INTEGER,module TEXT,
                hostname TEXT,namespace TEXT,sourceCommit TEXT,revision INTEGER,state TEXT,
                leaseToken TEXT,leasedUntil INTEGER,reservedMemoryMiB INTEGER);''')
        db.execute('INSERT INTO instances VALUES(900010,1)')
        db.execute('INSERT INTO ava_module_deployments VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                   (deployment, 900010, 'twenty', recipe['hostname'], namespace, recipe['sourceCommit'],
                    1, 'provisioning', lease, int(time.time() * 1000) + 60000, 256))
    operations = []
    def runner(command, **kwargs):
        operations.append(command)
        return helper.run(command, **kwargs)
    launcher = helper.Deployments(database, directory, runner=runner)
    checks = {}
    command = ['docker', 'compose', '--project-name', namespace, '--project-directory', str(root),
               '--env-file', '/dev/null', '-f', str(root / 'compose.json')]
    try:
        checks['initially_absent'] = launcher.execute('reconcile', payload)['state'] == 'absent'
        checks['launched_real_container'] = launcher.execute('provision', payload)['state'] == 'running'
        before = launcher._containers(deployment)
        checks['single_process'] = len(before) == 1
        checks['no_published_ports'] = not before[0]['HostConfig'].get('PortBindings')
        checks['no_host_mounts'] = not before[0]['Mounts']
        network = json.loads(helper.run(['docker', 'network', 'inspect', namespace + '_native'], timeout=15))[0]
        checks['network_internal'] = network['Internal'] is True
        checks['recovered_existing_process'] = launcher.execute('reconcile', payload)['state'] == 'running'
        launcher.execute('provision', payload)
        checks['repeat_kept_exact_container'] = before[0]['Id'] == launcher._containers(deployment)[0]['Id']
        checks['compose_up_once'] = sum('up' in value for value in operations) == 1
        try:
            launcher.execute('verify', payload)
        except helper.DeploymentError as error:
            checks['health_not_native_acceptance'] = str(error) == 'DEPLOYMENT_NATIVE_VERIFIER_REQUIRED'
        with sqlite3.connect(database) as db:
            db.execute("UPDATE ava_module_deployments SET state='disabled',revision=2")
        try:
            launcher.execute('provision', payload)
        except helper.DeploymentError as error:
            checks['disabled_lease_rejected'] = str(error) == 'DEPLOYMENT_LEASE_LOST'
    finally:
        # Only the synthetic project's containers/network are removed. There
        # are no volumes, and production project names cannot enter this path.
        helper.run([*command, 'down', '--timeout', '10'], timeout=30)
        checks['qa_containers_removed'] = launcher._containers(deployment) == []
    result = {'qa_only': True, 'native_module_acceptance': False, 'image_id': image,
              'business_id': 900010, 'deployment_id': deployment, 'checks': checks}
    private(directory / 'result.json', result)
    if len(checks) != 12 or not all(checks.values()):
        raise ValueError('LAUNCHER_QA_FAILED')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(execute(args.directory, args.image)))
    except Exception:
        raise SystemExit('AVA_DEPLOYMENT_LAUNCHER_QA_FAILED') from None
