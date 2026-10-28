"""AVA-owned fixed Twenty recipe; never renders customer supplied Compose."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import tempfile

from module_deployment_helper import DeploymentError, DIGEST, PINNED, UUID, owned_path, private_json, validate_compose


def fail(code):
    raise DeploymentError(code)


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode()


def identity(row):
    if row.get('module') != 'twenty' or not UUID.fullmatch(row.get('id', '')):
        fail('DEPLOYMENT_FACTORY_UNSUPPORTED')
    if type(row.get('businessId')) is not int or row['businessId'] <= 0 or type(row.get('revision')) is not int or row['revision'] <= 0:
        fail('DEPLOYMENT_RECIPE_SCOPE_MISMATCH')
    compact = row['id'].replace('-', '')
    hostname = row.get('hostname', '')
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.crm\.meludtech\.tech', hostname) or not hostname.split('.')[0].endswith('-' + str(row['businessId'])):
        fail('DEPLOYMENT_RECIPE_SCOPE_MISMATCH')
    if row.get('namespace') != 'ava_' + compact or row.get('sourceCommit') != PINNED['twenty']:
        fail('DEPLOYMENT_RECIPE_SCOPE_MISMATCH')
    return {'deploymentId': row['id'], **{key: row[key] for key in ('businessId', 'module', 'revision', 'hostname', 'namespace', 'sourceCommit')}}


def display_name(row):
    value = str(row.get('businessName') or f'Отель {row["businessId"]}').strip()
    if not value or len(value) > 128 or any(ord(char) < 32 or ord(char) == 127 for char in value):
        fail('DEPLOYMENT_BUSINESS_NAME_INVALID')
    return value


def catalogue(value):
    required = {'schemaVersion', 'sourceCommit', 'nativeImage', 'postgresImage', 'redisImage', 'postgresUid', 'postgresGid', 'redisUid', 'redisGid'}
    if not isinstance(value, dict) or not required.issubset(value) or set(value) - required - {'gateway'}:
        fail('DEPLOYMENT_IMAGE_CATALOGUE_INVALID')
    if value['schemaVersion'] != 1 or value['sourceCommit'] != PINNED['twenty']:
        fail('DEPLOYMENT_IMAGE_CATALOGUE_INVALID')
    for key in ('nativeImage', 'postgresImage', 'redisImage'):
        if not isinstance(value[key], str) or not DIGEST.fullmatch(value[key]):
            fail('DEPLOYMENT_IMAGE_CATALOGUE_INVALID')
    for key in ('postgresUid', 'postgresGid', 'redisUid', 'redisGid'):
        if type(value[key]) is not int or not 1 <= value[key] <= 65535:
            fail('DEPLOYMENT_IMAGE_CATALOGUE_INVALID')
    if 'gateway' in value:
        gateway = value['gateway']
        # Only a reviewed internal broker address, never a customer-supplied URL.
        if not isinstance(gateway, dict) or set(gateway) != {'image', 'brokerOrigin'} \
                or not isinstance(gateway['image'], str) or not DIGEST.fullmatch(gateway['image']) \
                or gateway['brokerOrigin'] != 'http://ava-module-access:3901':
            fail('DEPLOYMENT_IMAGE_CATALOGUE_INVALID')
    return value


SECRET_NAMES = ('dbAdmin', 'dbApp', 'redis', 'appSecret', 'encryptionKey', 'gatewayPeer', 'workerPeer', 'sessionKey')
GATEWAY_SECRET_NAMES = ('brokerPeer', 'gatewayEncryption')


def render(row, images, keys, root):
    """Pure renderer; credential-containing results must never be logged."""
    scope, images = identity(row), catalogue(images)
    expected_secrets = SECRET_NAMES + (GATEWAY_SECRET_NAMES if 'gateway' in images else ())
    if set(keys) != set(expected_secrets) or any(not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', value) for value in keys.values()) or len(set(keys.values())) != len(keys):
        fail('DEPLOYMENT_GENERATED_SECRETS_INVALID')
    memory_budget = 4352 if 'gateway' in images else 4096
    if row.get('reservedMemoryMiB', 0) < memory_budget:
        fail('DEPLOYMENT_RESERVATION_TOO_SMALL')
    root = Path(root)
    namespace = scope['namespace']
    admin = 'owner_' + row['id'].replace('-', '')
    labels = {'tech.melud.ava.deployment': row['id'], 'tech.melud.ava.business': str(row['businessId']), 'tech.melud.ava.revision': str(row['revision'])}
    native_env = {
        'PG_DATABASE_URL': f'postgres://{namespace}:{keys["dbApp"]}@database:5432/{namespace}',
        'REDIS_URL': f'redis://:{keys["redis"]}@cache:6379',
        'SERVER_URL': f'https://{row["hostname"]}', 'APP_SECRET': keys['appSecret'],
        'ENCRYPTION_KEY': keys['encryptionKey'], 'STORAGE_TYPE': 'local',
        'STORAGE_LOCAL_PATH': '/var/lib/ava-storage', 'TELEMETRY_ENABLED': 'false',
        'IS_SIGN_UP_DISABLED': 'true', 'IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS': 'true',
        'DISABLE_DB_MIGRATIONS': 'true', 'DISABLE_CRON_JOBS_REGISTRATION': 'true',
        'LOG_LEVELS': 'error,warn', 'NODE_ENV': 'production',
    }
    display = display_name(row)
    bootstrap = {key: scope[key] for key in ('businessId', 'deploymentId', 'revision', 'hostname')}
    bootstrap['displayName'] = display
    # All interpolated identifiers and passwords above are strict ASCII tokens.
    # This seed runs only in a brand-new PostgreSQL volume, never an existing DB.
    sql = f'''CREATE ROLE {namespace} LOGIN PASSWORD '{keys['dbApp']}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER DATABASE {namespace} OWNER TO {namespace};
REVOKE ALL ON DATABASE {namespace} FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO {namespace};
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS citext;
'''
    files = {
        'native.env': ('\n'.join(f'{key}={value}' for key, value in native_env.items()) + '\n', 0o600, 0),
        'database.env': (f'POSTGRES_USER={admin}\nPOSTGRES_DB={namespace}\nPOSTGRES_PASSWORD={keys["dbAdmin"]}\nPGDATA=/var/lib/postgresql/data/pgdata\n', 0o600, 0),
        'seed.sql': (sql, 0o640, images['postgresGid']),
        'bootstrap.json': (encoded(bootstrap).decode(), 0o640, 1000),
        'redis.conf': (f'bind 0.0.0.0\nprotected-mode yes\nport 6379\ndir /data\nappendonly yes\nappendfsync everysec\nmaxmemory 128mb\nmaxmemory-policy noeviction\nrequirepass {keys["redis"]}\n', 0o640, images['redisGid']),
        'gateway.key': (keys['gatewayPeer'], 0o640, 1000),
        'worker.key': (keys['workerPeer'], 0o640, 1000),
        'session.key': (keys['sessionKey'], 0o640, 1000),
    }
    def bind(name, target):
        return {'type': 'bind', 'source': str(root / 'config' / name), 'target': target, 'read_only': True}
    def volume(name, target, readonly=False):
        return {'type': 'volume', 'source': name, 'target': target, 'read_only': readonly}
    def service(image, memory, user='1000:1000'):
        return {'image': image, 'user': user, 'labels': dict(labels), 'networks': ['native'],
                'read_only': True, 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
                'mem_limit': memory * 1024**2, 'cpus': 2, 'pids_limit': 256, 'restart': 'unless-stopped'}
    database = {**service(images['postgresImage'], 512, f'{images["postgresUid"]}:{images["postgresGid"]}'),
                'env_file': [str(root / 'config/database.env')],
                'volumes': [volume('database', '/var/lib/postgresql/data'), bind('seed.sql', '/docker-entrypoint-initdb.d/10-ava.sql')],
                'tmpfs': [f'/var/run/postgresql:rw,nosuid,nodev,uid={images["postgresUid"]},gid={images["postgresGid"]},size=8m', '/tmp:rw,nosuid,nodev,size=32m'],
                'healthcheck': {'test': ['CMD', 'pg_isready', '-h', '127.0.0.1', '-U', namespace, '-d', namespace], 'interval': '3s', 'timeout': '3s', 'retries': 30}}
    cache = {**service(images['redisImage'], 192, f'{images["redisUid"]}:{images["redisGid"]}'),
             'command': ['redis-server', '/run/ava/redis.conf'],
             'volumes': [volume('cache', '/data'), bind('redis.conf', '/run/ava/redis.conf')]}
    dependencies = {'database': {'condition': 'service_healthy'}, 'cache': {'condition': 'service_started'}}
    initializer = {**service(images['nativeImage'], 1024), 'restart': 'no', 'entrypoint': ['node'],
                   'command': ['/app/packages/twenty-server/dist/ava-native/initializer.cjs'],
                   'env_file': [str(root / 'config/native.env')],
                   'environment': {'NODE_OPTIONS': '--max-old-space-size=768', 'AVA_NATIVE_ADAPTER_ENABLED': 'false', 'IS_SIGN_UP_DISABLED': 'false'},
                   'volumes': [volume('bootstrap', '/var/lib/ava-native'), volume('runtime_credentials', '/var/lib/ava-runtime-credentials'), volume('storage', '/var/lib/ava-storage'), bind('bootstrap.json', '/run/ava/bootstrap.json')],
                   'tmpfs': ['/tmp:rw,nosuid,nodev,size=256m'], 'depends_on': dependencies}
    native = {**service(images['nativeImage'], 1536), 'entrypoint': ['node'], 'command': ['dist/main'],
              'env_file': [str(root / 'config/native.env')],
              'environment': {'NODE_OPTIONS': '--max-old-space-size=1024 --require=/app/packages/twenty-server/dist/ava-native/preload.cjs',
                  'AVA_NATIVE_ADAPTER_ENABLED': 'true', 'AVA_BUSINESS_ID': str(row['businessId']),
                  'AVA_DEPLOYMENT_ID': row['id'], 'AVA_DEPLOYMENT_REVISION': str(row['revision']),
                  'AVA_BOOTSTRAP_CONTEXT_FILE': '/run/ava-bootstrap/bootstrap.json',
                  'AVA_NATIVE_GATEWAY_SECRET_FILE': '/run/ava-keys/gateway.key',
                  'AVA_NATIVE_WORKER_SECRET_FILE': '/run/ava-keys/worker.key', 'AVA_NATIVE_SESSION_KEY_FILE': '/run/ava-keys/session.key'},
              'volumes': [volume('bootstrap', '/run/ava-bootstrap', True), volume('storage', '/var/lib/ava-storage'),
                  *[bind(name + '.key', '/run/ava-keys/' + name + '.key') for name in ('gateway', 'worker', 'session')]],
              'tmpfs': ['/tmp:rw,nosuid,nodev,size=128m'],
              'depends_on': {**dependencies, 'initializer': {'condition': 'service_completed_successfully'}},
              'healthcheck': {'test': ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
                              'interval': '5s', 'timeout': '4s', 'retries': 30, 'start_period': '30s'}}
    worker = {**service(images['nativeImage'], 768), 'entrypoint': ['node'], 'command': ['dist/queue-worker/queue-worker'],
              'env_file': [str(root / 'config/native.env')],
              'environment': {'NODE_OPTIONS': '--max-old-space-size=512', 'AVA_NATIVE_ADAPTER_ENABLED': 'false'},
              'volumes': [volume('storage', '/var/lib/ava-storage')], 'tmpfs': ['/tmp:rw,nosuid,nodev,size=128m'],
              'depends_on': {'native': {'condition': 'service_healthy'}}}
    compose = {'services': {'database': database, 'cache': cache, 'initializer': initializer, 'native': native, 'worker': worker},
               'networks': {'native': {'internal': True}}, 'volumes': {name: {} for name in ('database', 'cache', 'bootstrap', 'storage', 'runtime_credentials')}}
    if 'gateway' in images:
        gateway_config = {'businessId': row['businessId'], 'module': 'twenty', 'deploymentId': row['id'],
                          'revision': row['revision'], 'adapterId': row['id'],
                          'publicOrigin': 'https://' + row['hostname'], 'avaOrigin': 'https://wh.meludtech.tech',
                          'brokerOrigin': images['gateway']['brokerOrigin'], 'nativeOrigin': 'http://native:3902',
                          'upstreamOrigin': 'http://native:3000',
                          'nativeScopeFile': '/run/ava-bootstrap/bootstrap.json'}
        files.update({'gateway.json': (encoded(gateway_config).decode(), 0o640, 1000),
                      'broker-peer.key': (keys['brokerPeer'], 0o640, 1000),
                      'gateway-encryption.key': (keys['gatewayEncryption'], 0o640, 1000)})
        compose['services']['gateway'] = {**service(images['gateway']['image'], 256),
            'networks': ['native', 'ingress', 'access'],
            'volumes': [bind('gateway.json', '/run/ava/gateway.json'),
                        bind('broker-peer.key', '/run/ava/secrets/broker-peer'),
                        bind('gateway-encryption.key', '/run/ava/secrets/encryption-key'),
                        bind('gateway.key', '/run/ava/secrets/native-peer'),
                        volume('gateway', '/var/lib/ava-gateway'), volume('bootstrap', '/run/ava-bootstrap', True)],
            'tmpfs': ['/tmp:rw,nosuid,nodev,size=16m'], 'depends_on': {'native': {'condition': 'service_healthy'}},
            'healthcheck': {'test': ['CMD', 'node', '-e', "const http=require('http'),c=require('/run/ava/gateway.json');const r=http.get({host:'127.0.0.1',port:4080,path:'/healthz',headers:{host:new URL(c.publicOrigin).host}},s=>{s.resume();s.on('end',()=>process.exit(s.statusCode===200?0:1))});r.on('error',()=>process.exit(1));r.setTimeout(2000,()=>{r.destroy();process.exit(1)})"],
                            'interval': '5s', 'timeout': '3s', 'retries': 15, 'start_period': '5s'}}
        compose['networks'].update({name: {'external': True, 'name': 'ava-module-' + name} for name in ('ingress', 'access')})
        compose['volumes']['gateway'] = {}
    recipe = {**scope, 'schemaVersion': 1, 'initServices': ['initializer'], 'memoryMiB': memory_budget,
              'imageDigest': images['nativeImage'], 'composeSha256': hashlib.sha256(encoded(compose)).hexdigest()}
    return files, compose, recipe


class TwentyRecipeFactory:
    def __init__(self, recipes, image_catalogue, database=None):
        self.recipes, self.image_catalogue = Path(recipes), Path(image_catalogue)
        self.database = Path(database) if database else None

    @staticmethod
    def _write(path, content, mode=0o600, gid=0):
        if path.exists() or path.is_symlink():
            owned_path(path)
            if path.read_bytes() != content or path.stat().st_mode & 0o777 != mode or path.stat().st_gid != gid:
                fail('DEPLOYMENT_PREPARED_FILE_CHANGED')
            return
        fd, temporary = tempfile.mkstemp(prefix='.prepare-', dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write(content); output.flush(); os.fsync(output.fileno())
            os.chmod(temporary, mode); os.chown(temporary, 0, gid)
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_DIRECTORY)
            try: os.fsync(directory)
            finally: os.close(directory)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)

    def prepare(self, row):
        if os.geteuid() != 0:
            fail('DEPLOYMENT_FACTORY_ROOT_REQUIRED')
        scope = identity(row)
        owned_path(self.recipes, directory=True)
        _, images = private_json(self.image_catalogue)
        catalogue(images)
        root = self.recipes / row['id']
        root.mkdir(mode=0o700, exist_ok=True)
        owned_path(root, directory=True)
        lock = os.open(root / '.prepare.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # A marker is the first durable write. Do not adopt an unmarked
            # pre-existing directory or regenerate a prepared deployment's keys.
            marker = root / 'preparation.json'
            if not marker.exists() and any(path.name != '.prepare.lock' for path in root.iterdir()):
                fail('DEPLOYMENT_PREPARATION_NOT_OWNED')
            if self.database:
                with sqlite3.connect(f'{self.database.as_uri()}?mode=ro', uri=True, timeout=5) as db:
                    business = db.execute('SELECT name FROM instances WHERE id=? AND isActive=1', (row['businessId'],)).fetchone()
                if not business: fail('DEPLOYMENT_BUSINESS_INACTIVE')
                row = {**row, 'businessName': business[0]}
            if marker.exists():
                _, prepared = private_json(marker)
                if not isinstance(prepared, dict) or {key: prepared.get(key) for key in scope} != scope or not isinstance(prepared.get('displayName'), str):
                    fail('DEPLOYMENT_RECIPE_SCOPE_MISMATCH')
                row = {**row, 'businessName': prepared['displayName']}
            else:
                self._write(marker, encoded({**scope, 'displayName': display_name(row)}))
            secret_path = root / 'secrets.json'
            if secret_path.exists():
                _, keys = private_json(secret_path)
            else:
                names = SECRET_NAMES + (GATEWAY_SECRET_NAMES if 'gateway' in images else ())
                keys = {name: secrets.token_urlsafe(32) for name in names}
                self._write(secret_path, encoded(keys))
            config = root / 'config'
            config.mkdir(mode=0o700, exist_ok=True)
            owned_path(config, directory=True)
            files, compose, recipe = render(row, images, keys, root)
            for name, (value, mode, gid) in files.items():
                self._write(config / name, value.encode(), mode, gid)
            validate_compose(compose, recipe, root)
            self._write(root / 'compose.json', encoded(compose))
            # Recipe is the commit marker consumed by the launcher, written last.
            self._write(root / 'recipe.json', encoded(recipe))
        except BlockingIOError:
            fail('DEPLOYMENT_HELPER_BUSY')
        finally:
            os.close(lock)
