#!/usr/bin/env python3
"""Worker-only launcher for reviewed, per-business deployment recipes.

The request cannot supply Compose, paths, images, ports, environment or commands.
Installing a recipe is a separate release operation. This helper intentionally
does not turn container health into native identity/isolation acceptance.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import socketserver
import sqlite3
import stat
import struct
import subprocess
import time
from http.server import BaseHTTPRequestHandler


UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')
DIGEST = re.compile(r'sha256:[0-9a-f]{64}\Z')
PINNED = {'twenty': '6da524b8903ec16a3eeea4b2e4a5fb63dbfc1c58',
          'onyx': 'a1b9e02eb65cc114c65381cbef5e555e1753ed0a'}
LABEL = 'tech.melud.ava.deployment'
SAFE_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/var/empty',
            'DOCKER_HOST': 'unix:///var/run/docker.sock', 'COMPOSE_DISABLE_ENV_FILE': 'true'}
IDENTITY = ('deploymentId', 'businessId', 'module', 'revision', 'hostname', 'namespace', 'sourceCommit')


class DeploymentError(Exception):
    pass


def reject(code):
    raise DeploymentError(code)


def request_identity(value):
    if not isinstance(value, dict) or set(value) != {'deploymentId', 'businessId', 'revision', 'leaseToken'}:
        reject('DEPLOYMENT_REQUEST_INVALID')
    if any(not isinstance(value[key], str) or not UUID.fullmatch(value[key]) for key in ('deploymentId', 'leaseToken')):
        reject('DEPLOYMENT_REQUEST_INVALID')
    if any(type(value[key]) is not int or value[key] < 1 for key in ('businessId', 'revision')):
        reject('DEPLOYMENT_REQUEST_INVALID')
    return value


def owned_path(path, owner=0, directory=False):
    """Reject links and writable parents, including a symlinked ancestor."""
    path = Path(path)
    if not path.is_absolute():
        reject('DEPLOYMENT_RECIPE_UNTRUSTED')
    for item in [*reversed(path.parents), path]:
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022:
            reject('DEPLOYMENT_RECIPE_UNTRUSTED')
        if item != path and not stat.S_ISDIR(info.st_mode):
            reject('DEPLOYMENT_RECIPE_UNTRUSTED')
    info = path.lstat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        reject('DEPLOYMENT_RECIPE_UNTRUSTED')
    return path


def private_json(path):
    owned_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if info.st_uid != 0 or info.st_mode & 0o077 or info.st_size > 1024 * 1024:
            reject('DEPLOYMENT_RECIPE_UNTRUSTED')
        with os.fdopen(fd, 'rb', closefd=False) as source:
            raw = source.read(1024 * 1024 + 1)
        value = json.loads(raw)
        if not isinstance(value, dict):
            reject('DEPLOYMENT_RECIPE_INVALID')
        return raw, value
    finally:
        os.close(fd)


def run(command, timeout=180):
    try:
        result = subprocess.run(command, check=True, capture_output=True, timeout=timeout, env=SAFE_ENV)
        if len(result.stdout) > 4 * 1024 * 1024:
            reject('DEPLOYMENT_RESPONSE_TOO_LARGE')
        return result.stdout.decode('utf-8')
    except (subprocess.SubprocessError, OSError, UnicodeError):
        # Docker/Compose errors can contain secret env values. Never propagate.
        reject('DEPLOYMENT_OPERATION_FAILED')


def validate_compose(compose, recipe, root):
    allowed_top = {'services', 'networks', 'volumes'}
    if set(compose) - allowed_top or not isinstance(compose.get('services'), dict) or not compose['services']:
        reject('DEPLOYMENT_COMPOSE_INVALID')
    networks, volumes = compose.get('networks', {}), compose.get('volumes', {})
    if not isinstance(networks, dict) or not isinstance(volumes, dict):
        reject('DEPLOYMENT_COMPOSE_INVALID')
    for name, config in networks.items():
        if not re.fullmatch(r'[a-z][a-z0-9_]{0,31}', name) or not isinstance(config, dict):
            reject('DEPLOYMENT_NETWORK_INVALID')
        if config.get('external'):
            if config != {'external': True, 'name': f'ava-module-{name}'} or name not in ('ingress', 'access'):
                reject('DEPLOYMENT_NETWORK_INVALID')
        elif config != {'internal': True}:
            reject('DEPLOYMENT_NETWORK_INVALID')
    for name, config in volumes.items():
        if not re.fullmatch(r'[a-z][a-z0-9_]{0,31}', name) or config not in ({}, None):
            reject('DEPLOYMENT_VOLUME_INVALID')
    allowed_service = {'image', 'user', 'environment', 'env_file', 'command', 'entrypoint', 'volumes',
                       'networks', 'read_only', 'cap_drop', 'security_opt', 'tmpfs', 'mem_limit',
                       'cpus', 'pids_limit', 'restart', 'stop_grace_period', 'healthcheck', 'depends_on', 'labels'}
    total_memory = 0
    raw_init = recipe.get('initServices', [])
    if not isinstance(raw_init, list) or any(not isinstance(name, str) for name in raw_init):
        reject('DEPLOYMENT_RECIPE_INVALID')
    init_services = set(raw_init)
    if len(init_services) != len(raw_init):
        reject('DEPLOYMENT_RECIPE_INVALID')
    for name, service in compose['services'].items():
        if not re.fullmatch(r'[a-z][a-z0-9_-]{0,31}', name) or not isinstance(service, dict) or set(service) - allowed_service:
            reject('DEPLOYMENT_SERVICE_INVALID')
        image = service.get('image', '')
        if not isinstance(image, str) or not DIGEST.fullmatch(image.split('@')[-1]):
            reject('DEPLOYMENT_IMAGE_UNPINNED')
        if service.get('read_only') is not True or service.get('cap_drop') != ['ALL'] or service.get('security_opt') != ['no-new-privileges:true']:
            reject('DEPLOYMENT_SERVICE_UNSAFE')
        labels = service.get('labels')
        expected_labels = {LABEL: recipe['deploymentId'], 'tech.melud.ava.business': str(recipe['businessId']),
                           'tech.melud.ava.revision': str(recipe['revision'])}
        if labels != expected_labels:
            reject('DEPLOYMENT_LABELS_INVALID')
        memory, cpus, pids = service.get('mem_limit'), service.get('cpus'), service.get('pids_limit')
        if type(memory) is not int or not 16 * 1024**2 <= memory <= 16384 * 1024**2:
            reject('DEPLOYMENT_LIMITS_INVALID')
        if type(cpus) not in (int, float) or not 0 < cpus <= 8 or type(pids) is not int or not 16 <= pids <= 1024:
            reject('DEPLOYMENT_LIMITS_INVALID')
        total_memory += memory
        attached = service.get('networks')
        if not isinstance(attached, list) or not attached or any(n not in networks for n in attached):
            reject('DEPLOYMENT_NETWORK_INVALID')
        if name != 'gateway' and any(networks[n].get('external') for n in attached):
            reject('DEPLOYMENT_NATIVE_EXPOSED')
        if name in init_services:
            if service.get('restart') != 'no' or any(networks[n].get('external') for n in attached):
                reject('DEPLOYMENT_INIT_INVALID')
        env_files = service.get('env_file', [])
        if not isinstance(env_files, list):
            reject('DEPLOYMENT_ENV_INVALID')
        for source in env_files:
            if not isinstance(source, str) or '..' in Path(source).parts or not Path(source).is_relative_to(root / 'config'):
                reject('DEPLOYMENT_ENV_INVALID')
            owned_path(source)
        if not isinstance(service.get('environment', {}), dict):
            reject('DEPLOYMENT_ENV_INVALID')
        for mount in service.get('volumes', []):
            if not isinstance(mount, dict) or set(mount) - {'type', 'source', 'target', 'read_only'}:
                reject('DEPLOYMENT_VOLUME_INVALID')
            source, target = mount.get('source'), mount.get('target')
            if not isinstance(target, str) or not target.startswith('/') or '..' in Path(target).parts or target in ('/', '/var/run/docker.sock'):
                reject('DEPLOYMENT_VOLUME_INVALID')
            if mount.get('type') == 'volume':
                if source not in volumes:
                    reject('DEPLOYMENT_VOLUME_INVALID')
            elif mount.get('type') == 'bind':
                if not isinstance(source, str) or '..' in Path(source).parts or not Path(source).is_relative_to(root / 'config') or mount.get('read_only') is not True:
                    reject('DEPLOYMENT_VOLUME_INVALID')
                owned_path(source, directory=Path(source).is_dir())
            else:
                reject('DEPLOYMENT_VOLUME_INVALID')
    if not init_services.issubset(compose['services']) or total_memory > recipe['memoryMiB'] * 1024**2:
        reject('DEPLOYMENT_RESERVATION_TOO_SMALL')
    return compose


class Deployments:
    def __init__(self, database, recipes, runner=run, clock=time.time, verifier=None, recipe_factory=None,
                 enable_sync_recovery=False):
        self.database, self.recipes = Path(database), Path(recipes)
        self.runner, self.clock, self.verifier, self.recipe_factory = runner, clock, verifier, recipe_factory
        self.enable_sync_recovery = enable_sync_recovery is True

    def _lease(self, payload):
        request_identity(payload)
        with sqlite3.connect(f'{self.database.as_uri()}?mode=ro', uri=True, timeout=5) as db:
            db.row_factory = sqlite3.Row
            row = db.execute('''SELECT d.* FROM ava_module_deployments d JOIN instances i ON i.id=d.businessId
                WHERE d.id=? AND d.businessId=? AND i.isActive=1''', (payload['deploymentId'], payload['businessId'])).fetchone()
        if not row or row['state'] != 'provisioning' or row['revision'] != payload['revision'] or row['leaseToken'] != payload['leaseToken'] or (row['leasedUntil'] or 0) <= int(self.clock() * 1000):
            reject('DEPLOYMENT_LEASE_LOST')
        return dict(row)

    @staticmethod
    def identity(row):
        return {key: row['id'] if key == 'deploymentId' else row[key] for key in IDENTITY}

    def _recipe(self, row):
        root = self.recipes / row['id']
        try:
            _, recipe = private_json(root / 'recipe.json')
            raw, compose = private_json(root / 'compose.json')
        except FileNotFoundError:
            if self.recipe_factory is None:
                reject('DEPLOYMENT_RECIPE_REQUIRED')
            self.recipe_factory.prepare(row)
            _, recipe = private_json(root / 'recipe.json')
            raw, compose = private_json(root / 'compose.json')
        required = {*IDENTITY, 'schemaVersion', 'composeSha256', 'imageDigest', 'memoryMiB'}
        if set(recipe) - {*required, 'initServices'} or not required.issubset(recipe) or recipe['schemaVersion'] != 1:
            reject('DEPLOYMENT_RECIPE_INVALID')
        if any(recipe[key] != value for key, value in self.identity(row).items()):
            reject('DEPLOYMENT_RECIPE_SCOPE_MISMATCH')
        if recipe['sourceCommit'] != PINNED.get(recipe['module']) or recipe['namespace'] != 'ava_' + row['id'].replace('-', ''):
            reject('DEPLOYMENT_RECIPE_SCOPE_MISMATCH')
        if type(recipe['memoryMiB']) is not int or not 256 <= recipe['memoryMiB'] <= row['reservedMemoryMiB']:
            reject('DEPLOYMENT_RESERVATION_TOO_SMALL')
        if hashlib.sha256(raw).hexdigest() != recipe['composeSha256'] or not DIGEST.fullmatch(recipe.get('imageDigest', '')):
            reject('DEPLOYMENT_RECIPE_DIGEST_MISMATCH')
        # No variable expansion from the helper's environment, even in strings.
        if b'${' in raw or b'$' in raw:
            reject('DEPLOYMENT_COMPOSE_INTERPOLATION_FORBIDDEN')
        validate_compose(compose, recipe, root)
        compose['_initServices'] = list(recipe.get('initServices', []))
        return root, recipe, compose

    def _containers(self, deployment_id=None):
        selector = f'{LABEL}={deployment_id}' if deployment_id else LABEL
        ids = self.runner(['docker', 'ps', '-aq', '--filter', 'label=' + selector], timeout=15).split()
        if not ids:
            return []
        if any(not re.fullmatch(r'[a-f0-9]{12,64}', value) for value in ids):
            reject('DEPLOYMENT_INSPECTION_INVALID')
        try:
            rows = json.loads(self.runner(['docker', 'inspect', *ids], timeout=20))
            if not isinstance(rows, list):
                reject('DEPLOYMENT_INSPECTION_INVALID')
            return rows
        except (ValueError, TypeError):
            reject('DEPLOYMENT_INSPECTION_INVALID')

    def capacity(self):
        memory = {key: int(value.split()[0]) for key, value in
                  (line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())}
        running = set()
        for row in self._containers():
            deployment = row.get('Config', {}).get('Labels', {}).get(LABEL, '')
            if row.get('State', {}).get('Running') and UUID.fullmatch(deployment):
                running.add(deployment)
        return {'totalMiB': memory['MemTotal'] // 1024, 'availableMiB': memory['MemAvailable'] // 1024,
                # An idle/partially started container is not evidence that the
                # full reservation is represented in MemAvailable. Until a
                # cgroup peak-growth sample is available, charge reservations
                # conservatively even while running; never release headroom on
                # the strength of one tiny running sidecar.
                'observedAt': int(self.clock() * 1000), 'runningDeploymentIds': []}

    def _state(self, row, compose):
        containers = self._containers(row['id'])
        project_ids = set(self.runner(['docker', 'ps', '-aq', '--no-trunc', '--filter',
                                      'label=com.docker.compose.project=' + row['namespace']], timeout=15).split())
        owned_ids = {item.get('Id') for item in containers}
        if project_ids != owned_ids:
            reject('DEPLOYMENT_RESOURCE_OWNERSHIP_CONFLICT')
        if not containers:
            return 'absent'
        names, running, init_failed, init_running = set(), True, False, False
        init_services = set(compose.get('_initServices', []))
        for item in containers:
            labels = item.get('Config', {}).get('Labels', {})
            name = labels.get('com.docker.compose.service')
            if labels.get('com.docker.compose.project') != row['namespace'] or labels.get('tech.melud.ava.business') != str(row['businessId']) or labels.get('tech.melud.ava.revision') != str(row['revision']) or name not in compose['services'] or name in names:
                reject('DEPLOYMENT_RESOURCE_OWNERSHIP_CONFLICT')
            if item.get('Config', {}).get('Image') != compose['services'][name]['image']:
                reject('DEPLOYMENT_IMAGE_DRIFT')
            names.add(name)
            if name in init_services:
                state = item.get('State', {})
                if state.get('Running') is True: init_running = True
                elif state.get('Status') == 'exited' and state.get('ExitCode') == 0: pass
                else: init_failed = True
                continue
            running = running and item.get('State', {}).get('Running') is True and item.get('State', {}).get('Health', {}).get('Status', 'healthy') == 'healthy'
        # Failed/stopped init is resumable through compose up --no-recreate;
        # retain the degraded state after inspecting every container so a
        # foreign label cannot be hidden by an initializer's condition.
        return 'running' if running and not init_running and not init_failed and names == set(compose['services']) else 'degraded'

    def _enrollment(self, row, root, compose):
        if row['module'] not in PINNED or 'gateway' not in compose['services']:
            reject('DEPLOYMENT_GATEWAY_REQUIRED')
        if row['module'] == 'onyx':
            # A Community contour owns a fixed namespace, not a generated
            # workspace UUID. Enroll only the root-prepared identity manifest.
            # This is not native readiness: execute('verify') still requires
            # live TLS, identity and storage/isolation proof independently.
            if 'auth' not in compose['services'] or 'api' not in compose['services']:
                reject('DEPLOYMENT_GATEWAY_REQUIRED')
            _, manifest = private_json(root / 'config' / 'enrollment.json')
            expected = {**self.identity(row), 'schemaVersion': 1,
                        'adapterId': row['id'], 'nativeScope': row['namespace']}
            if set(manifest) != set(expected) or manifest != expected \
                    or any(type(manifest[key]) is not int for key in ('schemaVersion', 'businessId', 'revision')) \
                    or row['namespace'] != 'ava_' + row['id'].replace('-', '') \
                    or row['sourceCommit'] != PINNED['onyx']:
                reject('DEPLOYMENT_ENROLLMENT_INVALID')
            native_scope = manifest['nativeScope']
        else:
            native_scope = self._twenty_native_scope(row)
        peer_hash = self._enrollment_peer_hash(root)
        return {**self.identity(row), 'adapterId': row['id'], 'nativeScope': native_scope, 'peerSecretHash': peer_hash}

    def _twenty_native_scope(self, row):
        # Native identity comes from the initializer's readback, not a request
        # parameter or a guessed workspace name. This fixed command emits IDs
        # only; it never reads environment variables or credential files.
        native = [item for item in self._containers(row['id'])
                  if item.get('Config', {}).get('Labels', {}).get('com.docker.compose.service') == 'native']
        if len(native) != 1 or not re.fullmatch(r'[a-f0-9]{12,64}', native[0].get('Id', '')):
            reject('DEPLOYMENT_INSPECTION_INVALID')
        script = """const fs=require('node:fs');
const fd=fs.openSync('/run/ava-bootstrap/bootstrap.json',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
try {const s=fs.fstatSync(fd);if(!s.isFile()||s.size>4096||(s.mode&0o077))process.exit(2);
const v=JSON.parse(fs.readFileSync(fd,'utf8'));
process.stdout.write(JSON.stringify({businessId:v.businessId,deploymentId:v.deploymentId,revision:v.revision,nativeScope:v.nativeScope}));
} finally {fs.closeSync(fd);}"""
        try:
            output = self.runner(['docker', 'exec', native[0]['Id'], 'node', '-e', script], timeout=10)
            if len(output) > 4096:
                reject('DEPLOYMENT_ENROLLMENT_INVALID')
            proof = json.loads(output)
        except (ValueError, TypeError):
            reject('DEPLOYMENT_ENROLLMENT_INVALID')
        if not isinstance(proof, dict) or set(proof) != {'businessId', 'deploymentId', 'revision', 'nativeScope'} \
                or type(proof['businessId']) is not int or type(proof['revision']) is not int \
                or proof['businessId'] != row['businessId'] or proof['deploymentId'] != row['id'] \
                or proof['revision'] != row['revision'] or not isinstance(proof['nativeScope'], str) \
                or not UUID.fullmatch(proof['nativeScope']):
            reject('DEPLOYMENT_ENROLLMENT_INVALID')
        return proof['nativeScope']

    @staticmethod
    def _enrollment_peer_hash(root):
        # Read exactly the root-prepared broker key. Only the hash crosses the
        # Unix worker boundary, so a retry cannot reveal or replace credentials.
        key_path = owned_path(root / 'config' / 'broker-peer.key')
        fd = os.open(key_path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if info.st_uid != 0 or info.st_gid != 1000 or info.st_mode & 0o777 != 0o640 or info.st_size != 43:
                reject('DEPLOYMENT_RECIPE_UNTRUSTED')
            key = os.read(fd, 44)
            if not re.fullmatch(rb'[A-Za-z0-9_-]{43}', key):
                reject('DEPLOYMENT_ENROLLMENT_INVALID')
            peer_hash = hashlib.sha256(key).hexdigest()
        finally:
            os.close(fd)
        return peer_hash

    def execute(self, operation, payload):
        if operation == 'sync-recovery':
            if not self.enable_sync_recovery:
                reject('SYNC_RECOVERY_FEATURE_DISABLED')
            from twenty_sync_recovery_helper import SyncRecovery
            return SyncRecovery(self).execute(payload)
        if operation not in ('reconcile', 'provision', 'enrollment', 'verify'):
            reject('DEPLOYMENT_OPERATION_FORBIDDEN')
        row = self._lease(payload)
        root, recipe, compose = self._recipe(row)
        # Serialize a deployment across helper processes; no browser-supplied path.
        fd = os.open(root / '.launch.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            reject('DEPLOYMENT_HELPER_BUSY')
        try:
            self._lease(payload)
            state = self._state(row, compose)
            if operation == 'provision' and state in ('absent', 'degraded'):
                command = ['docker', 'compose', '--project-name', row['namespace'], '--project-directory', str(root),
                           '--env-file', '/dev/null', '-f', str(root / 'compose.json')]
                self.runner([*command, 'config', '--quiet'], timeout=20)
                self._lease(payload)
                try:
                    self.runner([*command, 'up', '--detach', '--no-build', '--pull', 'never', '--no-recreate'], timeout=180)
                finally:
                    try:
                        self._lease(payload)
                    except DeploymentError:
                        # Even an unsuccessful Compose command may have started
                        # some services before a concurrent revoke. Stop exactly
                        # this project, never delete its data or volumes.
                        self.runner([*command, 'stop', '--timeout', '10'], timeout=30)
                        raise
                state = self._state(row, compose)
            self._lease(payload)
            if operation == 'enrollment':
                if state != 'running':
                    reject('DEPLOYMENT_NOT_RUNNING')
                receipt = self._enrollment(row, root, compose)
                self._lease(payload)
                return receipt
            if operation == 'verify':
                if state != 'running':
                    reject('DEPLOYMENT_NOT_RUNNING')
                if self.verifier is None:
                    reject('DEPLOYMENT_NATIVE_VERIFIER_REQUIRED')
                proof = self.verifier(self.identity(row), recipe)
                self._lease(payload)
                # The worker separately checks every acceptance field/revision.
                return proof
            return {**self.identity(row), 'state': state}
        finally:
            os.close(fd)


class ApprovedRecipeFactories:
    """Closed module dispatch; catalogues are selected by the root operator.

    A deployment/browser request cannot supply a catalogue path or substitute
    one module's bootstrap material for another's.
    """
    def __init__(self, factories):
        if not isinstance(factories, dict) or set(factories) - set(PINNED):
            reject('DEPLOYMENT_HELPER_CONFIGURATION_INVALID')
        self.factories = dict(factories)

    def prepare(self, row):
        factory = self.factories.get(row.get('module'))
        if factory is None:
            reject('DEPLOYMENT_RECIPE_REQUIRED')
        return factory.prepare(row)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        self.connection.settimeout(5)
        try:
            _pid, uid, _gid = struct.unpack('3i', self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != self.server.worker_uid:
                reject('DEPLOYMENT_WORKER_REQUIRED')
            lengths = self.headers.get_all('Content-Length') or []
            if len(lengths) != 1 or not lengths[0].isdigit() or self.headers.get('Transfer-Encoding') or any(self.headers.get(key) for key in ('Origin', 'Cookie', 'Authorization')):
                reject('DEPLOYMENT_REQUEST_INVALID')
            length = int(lengths[0])
            if not 0 < length <= 2048:
                reject('DEPLOYMENT_REQUEST_INVALID')
            payload = json.loads(self.rfile.read(length))
            if self.path == '/v1/capacity' and payload == {}:
                value = self.server.deployments.capacity()
            elif self.path in ('/v1/reconcile', '/v1/provision', '/v1/enrollment', '/v1/verify', '/v1/sync-recovery'):
                value = self.server.deployments.execute(self.path[4:], payload)
            else:
                reject('DEPLOYMENT_OPERATION_FORBIDDEN')
            code = 200
        except DeploymentError as error:
            code, value = 409, {'error_code': str(error)}
        except Exception:
            code, value = 503, {'error_code': 'DEPLOYMENT_HELPER_UNAVAILABLE'}
        body = json.dumps(value).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--recipes', type=Path, default=Path('/etc/ava/module-recipes'))
    parser.add_argument('--socket', type=Path, default=Path('/run/ava-module-deployment/helper.sock'))
    parser.add_argument('--worker-uid', type=int, required=True)
    parser.add_argument('--image-catalogue', type=Path)
    parser.add_argument('--onyx-image-catalogue', type=Path)
    parser.add_argument('--enable-onyx-native-verifier', action='store_true',
                        help='Run live native identity, TLS and storage checks using each root-installed scoped verifier manifest')
    parser.add_argument('--enable-sync-recovery', action='store_true',
                        help='Enable reviewed worker-only whole-contour sync recovery; off until native acceptance')
    args = parser.parse_args()
    if os.geteuid() != 0 or args.worker_uid <= 0 or not args.database.is_absolute():
        reject('DEPLOYMENT_HELPER_CONFIGURATION_INVALID')
    owned_path(args.recipes, directory=True)
    owned_path(args.socket.parent, directory=True)
    os.umask(0o077)
    lock = os.open(args.socket.parent / '.helper.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.socket.exists() or args.socket.is_symlink():
            info = args.socket.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != args.worker_uid:
                reject('DEPLOYMENT_SOCKET_UNTRUSTED')
            # The process-wide lock proves no managed helper is still serving.
            args.socket.unlink()
        try:
            with Server(str(args.socket), Handler) as server:
                os.chown(args.socket, args.worker_uid, 0)
                os.chmod(args.socket, 0o600)
                server.worker_uid = args.worker_uid
                import sys
                sys.modules.setdefault('module_deployment_helper', sys.modules[__name__])
                factory = None
                if args.image_catalogue or args.onyx_image_catalogue:
                    factories = {}
                    if args.image_catalogue:
                        from twenty_recipe_factory import TwentyRecipeFactory
                        factories['twenty'] = TwentyRecipeFactory(args.recipes, args.image_catalogue, args.database)
                    if args.onyx_image_catalogue:
                        from onyx_recipe_factory import OnyxRecipeFactory
                        factories['onyx'] = OnyxRecipeFactory(args.recipes, args.onyx_image_catalogue, args.database)
                    factory = ApprovedRecipeFactories(factories)
                verifier = None
                if args.enable_onyx_native_verifier:
                    from onyx_native_verifier import OnyxNativeVerifier
                    verifier = OnyxNativeVerifier(args.recipes, args.database)
                server.deployments = Deployments(args.database, args.recipes, recipe_factory=factory,
                                                verifier=verifier,
                                                enable_sync_recovery=args.enable_sync_recovery)
                server.serve_forever()
        finally:
            args.socket.unlink(missing_ok=True)
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except (DeploymentError, OSError):
        raise SystemExit('AVA_MODULE_DEPLOYMENT_HELPER_FAILED') from None
