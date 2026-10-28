#!/usr/bin/env python3
"""Prepare an additive, private UI entry for the existing pilot workspace.

Does not start services, replace the live API, alter the workspace or publish TLS.
Secrets are copied directly between root-owned local files, never printed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import uuid

import yaml

ROOT = Path('/opt/ava-deploy/twenty-existing-entry-1')
WORKSPACE = '72600089-b4b4-4db3-a8b9-362f07033467'
ORIGIN = 'https://alleya-resort-1.crm.meludtech.tech'
BASE = 'sha256:63cafcc69ca18a7f402adbb519a0c7322ec5838866056f2c94d6ee38a06206a0'


def inspect(name):
    return json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]


def write(path, data, uid=0):
    path.write_text(data)
    os.chmod(path, 0o600)
    os.chown(path, uid, uid)


def prepare(native_image, gateway_image, broker_image):
    os.umask(0o077)
    if os.getuid() != 0 or ROOT.exists():
        raise ValueError('ROOT_REQUIRED_OR_DESTINATION_EXISTS')
    live = inspect('ava-twenty-server-1')
    if live['Image'] != BASE or not live['State']['Running']:
        raise ValueError('NATIVE_BASE_CHANGED')
    for image in (native_image, gateway_image, broker_image):
        if not image.startswith('sha256:') or len(image) != 71:
            raise ValueError('IMMUTABLE_IMAGE_REQUIRED')
        subprocess.run(['docker', 'image', 'inspect', image], check=True, stdout=subprocess.DEVNULL)
    release = Path('/root/ava-current').resolve()
    data = (release / 'data/whatsapp_crm').resolve()
    with sqlite3.connect(f'file:{data}/crm_v2.db?mode=ro', uri=True) as db:
        row = db.execute('SELECT workspaceId,revision,enabled FROM twenty_workspace_links WHERE businessId=1').fetchone()
        if not row or row[0] != WORKSPACE or row[2] != 1:
            raise ValueError('EXISTING_WORKSPACE_CHANGED')
        exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ava_module_adapters'").fetchone()
        if exists and db.execute("SELECT count(*) FROM ava_module_adapters WHERE businessId=1 AND module='twenty'").fetchone()[0]:
            raise ValueError('EXISTING_ADAPTER_REQUIRES_RECONCILIATION')
    deployment = str(uuid.uuid4())
    ROOT.mkdir(mode=0o700)
    for directory in ('native-keys', 'gateway-keys', 'context', 'gateway-state'):
        (ROOT / directory).mkdir(mode=0o700)
        os.chown(ROOT / directory, 1000, 1000)
    for name in ('gateway', 'worker', 'session'):
        write(ROOT / 'native-keys' / (name + '.key'), secrets.token_urlsafe(32), 1000)
    write(ROOT / 'gateway-keys/native-peer', (ROOT / 'native-keys/gateway.key').read_text(), 1000)
    write(ROOT / 'gateway-keys/encryption-key', secrets.token_urlsafe(32), 1000)
    context = dict(businessId=1, deploymentId=deployment, nativeScope=WORKSPACE, revision=1)
    write(ROOT / 'attach.json', json.dumps(context), 1000)
    env = dict(item.split('=', 1) for item in live['Config']['Env'] if '=' in item)
    names = ('APP_SECRET', 'ENCRYPTION_KEY', 'FALLBACK_ENCRYPTION_KEY', 'PG_DATABASE_URL', 'REDIS_URL', 'STORAGE_TYPE')
    native_env = {key: env[key] for key in names if key in env}
    if any('\n' in value or '\r' in value for value in native_env.values()):
        raise ValueError('ENV_VALUE_UNSAFE')
    native_env.update(SERVER_URL=ORIGIN, FRONTEND_URL=ORIGIN, IS_MULTIWORKSPACE_ENABLED='true',
        IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS='true', DISABLE_CRON_JOBS_REGISTRATION='true',
        DISABLE_DB_MIGRATIONS='true', LOG_LEVELS='error', NODE_ENV='production', NODE_PORT='3000',
        AVA_NATIVE_ADAPTER_ENABLED='true', AVA_NATIVE_ATTACH_EXISTING_WORKSPACE='true',
        AVA_BUSINESS_ID='1', AVA_DEPLOYMENT_ID=deployment, AVA_DEPLOYMENT_REVISION='1',
        AVA_NATIVE_GATEWAY_SECRET_FILE='/run/ava-native-keys/gateway.key',
        AVA_NATIVE_WORKER_SECRET_FILE='/run/ava-native-keys/worker.key',
        AVA_NATIVE_SESSION_KEY_FILE='/run/ava-native-keys/session.key',
        AVA_BOOTSTRAP_CONTEXT_FILE='/var/lib/ava-native/bootstrap.json',
        AVA_NATIVE_ATTACH_CONTEXT_FILE='/run/ava/attach.json')
    # JSON quoting is Compose dotenv syntax and preserves dollar signs literally.
    write(ROOT / 'native.env', '\n'.join(key + "='" + value.replace("'", "\\'") + "'" for key, value in native_env.items()) + '\n')
    common = dict(image=native_image, env_file=[str(ROOT / 'native.env')], user='1000:1000',
        entrypoint=['node'], mem_limit='2g', cpus=1, pids_limit=256,
        cap_drop=['ALL'], security_opt=['no-new-privileges:true'],
        networks=['existing', 'native'],
        volumes=[str(ROOT / 'native-keys') + ':/run/ava-native-keys:ro',
                 str(ROOT / 'context') + ':/var/lib/ava-native',
                 str(ROOT / 'attach.json') + ':/run/ava/attach.json:ro',
                 'existing_storage:/app/packages/twenty-server/.local-storage'])
    services = {
        'attach': {**common, 'command': ['dist/ava-native/attach-existing-workspace.cjs'],
                   'environment': {'NODE_OPTIONS': '', 'AVA_BOOTSTRAP_CONTEXT_FILE': ''}, 'profiles': ['setup'], 'restart': 'no'},
        'native': {**common, 'command': ['dist/main'], 'restart': 'unless-stopped'},
        'broker': {'image': broker_image, 'command': ['node', 'module-access-server.js'],
                   'user': inspect('whatsapp_crm')['Config']['User'] or '1000:1000',
                   'environment': {'NODE_ENV': 'production', 'AVA_PROCESS_ROLE': 'module-access-broker', 'DB_PATH': '/app/data/crm_v2.db'},
                   'volumes': [str(data) + ':/app/data'], 'networks': ['access'],
                   'read_only': True, 'tmpfs': ['/tmp:rw,nosuid,nodev,noexec,size=16m'],
                   'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'], 'mem_limit': '384m',
                   'cpus': 1, 'pids_limit': 128, 'restart': 'unless-stopped'},
        'gateway': {'image': gateway_image, 'volumes': [str(ROOT / 'gateway.json') + ':/run/ava/gateway.json:ro',
                    str(ROOT / 'gateway-keys') + ':/run/ava/secrets:ro', str(ROOT / 'gateway-state') + ':/var/lib/ava-gateway'],
                    'networks': ['native', 'access', 'ingress'], 'ports': ['127.0.0.1:3041:4080'], 'read_only': True,
                    'tmpfs': ['/tmp:rw,nosuid,nodev,noexec,size=8m'], 'cap_drop': ['ALL'],
                    'security_opt': ['no-new-privileges:true'], 'mem_limit': '192m', 'cpus': 0.5, 'pids_limit': 64,
                    'restart': 'unless-stopped'},
    }
    compose = dict(services=services, networks={'existing': {'external': True, 'name': 'ava-twenty_default'},
                   'ingress': {'ipam': {'config': [{'subnet': '10.253.240.64/28'}]}},
                   'native': {'internal': True, 'ipam': {'config': [{'subnet': '10.253.240.32/28'}]}},
                   'access': {'internal': True, 'ipam': {'config': [{'subnet': '10.253.240.48/28'}]}}},
                   volumes={'existing_storage': {'external': True, 'name': 'ava-twenty_server-local-data'}})
    write(ROOT / 'compose.yml', yaml.safe_dump(compose, sort_keys=False))
    manifest = dict(**context, origin=ORIGIN, integrationRevision=row[1], images={'native': native_image, 'gateway': gateway_image, 'broker': broker_image},
                    mode='existing_workspace_ui', live_api_replaced=False, data_migrated=False,
                    backup='post-pilot-20260917T124809Z', state='prepared')
    write(ROOT / 'manifest.json', json.dumps(manifest, indent=2))
    subprocess.run(['docker', 'compose', '-p', 'ava-twenty-entry-1', '-f', str(ROOT / 'compose.yml'), 'config', '--quiet'], check=True)
    print(json.dumps(manifest))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--native-image', required=True)
    parser.add_argument('--gateway-image', required=True)
    parser.add_argument('--broker-image', required=True)
    args = parser.parse_args()
    try:
        prepare(args.native_image, args.gateway_image, args.broker_image)
    except Exception:
        raise SystemExit('TWENTY_ENTRY_PREPARATION_FAILED_PRIVATE_STATE_PRESERVED')
