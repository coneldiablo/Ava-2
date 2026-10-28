#!/usr/bin/env python3
"""Fixed four-service product release. Inventory/prepare never change live state."""
import sys
sys.dont_write_bytecode = True
import argparse
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat as stat_mode
import subprocess
import time
from urllib.request import urlopen

from common import (BASE, IMAGES, NAMES, canonical, excluded_mounts, expected_tree,
                    file_sha, hashes, private_json, relative, require,
                    reviewed_core, sha, tree, validate_manifest)

core = reviewed_core()
IPC_BIND_SOURCE = Path('/run/ava-telephony')
OS_RELEASE_SOURCE = Path('/etc/os-release')


class Operator:
    def __init__(self, root, bundle=None, manifest_sha=None):
        self.root = Path(root).absolute()
        self.bundle = Path(bundle).absolute() if bundle else None
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        require(not self.root.is_symlink(), 'RELEASE_ROOT_SYMLINK')
        self.root.chmod(0o700)
        core.LOG_ROOT = self.root
        self.m = None
        if bundle:
            require(manifest_sha and file_sha(self.bundle / 'manifest.json') == manifest_sha, 'MANIFEST_HASH_REQUIRED')
            self.m = validate_manifest(json.loads((self.bundle / 'manifest.json').read_text()))
            require(file_sha(self.bundle / 'inventory.json') == self.m['inventorySha256'], 'INVENTORY_DRIFT')
            self.manifest_sha = manifest_sha
            self.bundle_guard()

    def run(self, command, **kwargs):
        return core.run(command, **kwargs)

    def inspect(self, name):
        return json.loads(self.run(['docker', 'inspect', name]))[0]

    def rows(self):
        return {role: self.inspect(name) for role, name in NAMES.items()}

    def bundle_guard(self):
        require(file_sha(self.bundle / 'manifest.json') == self.manifest_sha, 'MANIFEST_CHANGED')
        for role, service in self.m['services'].items():
            require(tree(self.bundle / 'payload' / role) == service['files'], 'PAYLOAD_CHANGED')
        actual = tree(self.bundle / 'tooling')
        require(actual == self.m['tooling'], 'TOOLING_CHANGED')
        require(json.loads((self.bundle / 'tooling/schema-contract.json').read_text()) == self.m['schemaContract'], 'SCHEMA_CONTRACT_CHANGED')
        require(file_sha(self.bundle / 'neuro-gemini-release/release_operator.py') == self.m['reviewedCoreSha256'], 'REVIEWED_HELPER_DRIFT')

    def other_containers(self):
        ids = self.run(['docker', 'ps', '-aq']).split()
        rows = json.loads(self.run(['docker', 'inspect', *ids])) if ids else []
        return {r['Name']: [r['Id'], r['Image'], r['State']['Running'], r['State'].get('StartedAt'), r.get('RestartCount')]
                for r in rows if r['Name'].lstrip('/') not in NAMES.values()}

    def config_inputs(self, rows):
        result = {}
        for row in rows.values():
            for field in ('project.config_files', 'project.environment_file'):
                for path in row['Config']['Labels'].get('com.docker.compose.' + field, '').split(','):
                    if path:
                        require(Path(path).is_absolute() and Path(path).is_file(), 'COMPOSE_INPUT_MISSING')
                        result[path] = file_sha(path)
        return result

    def binding_hashes(self, rows):
        result = {}
        # Runtime data/models/project mounts remain in place. Hash configuration,
        # ADC and source entrypoints separately from image application bytes.
        for role, row in rows.items():
            for mount in row['Mounts']:
                destination = mount['Destination']
                if mount.get('RW') and destination not in ('/app/config', '/app/main.py', '/app/scripts'):
                    continue
                source = Path(mount['Source'])
                require(mount['Type'] == 'bind' and source.exists(), 'CONFIG_BIND_INVALID')
                for path in [source] if source.is_file() or source.is_symlink() else sorted(source.rglob('*')):
                    metadata = path.lstat()
                    if (role == 'worker' and destination == '/run/ava-telephony' and
                            source == IPC_BIND_SOURCE and path == source / 'agent.sock' and
                            not mount['RW'] and stat_mode.S_ISSOCK(metadata.st_mode)):
                        # Inspect the IPC inode; never open/read a socket stream.
                        result[str(path)] = {'kind': 'unix-socket', 'device': metadata.st_dev, 'inode': metadata.st_ino,
                            'uid': metadata.st_uid, 'gid': metadata.st_gid, 'mode': metadata.st_mode & 0o777}
                        continue
                    if (role == 'admin' and destination == '/host/etc/os-release' and source == OS_RELEASE_SOURCE
                            and path == source and not mount['RW'] and path.is_symlink()):
                        target = path.resolve(strict=True)
                        require(target.is_file() and not target.is_symlink(), 'OS_RELEASE_TARGET_NOT_REGULAR')
                        target_stat = target.stat()
                        result[str(path)] = {'kind': 'os-release-symlink', 'target': os.readlink(path), 'resolved': str(target),
                            'device': metadata.st_dev, 'inode': metadata.st_ino, 'uid': metadata.st_uid, 'gid': metadata.st_gid,
                            'mode': metadata.st_mode & 0o777, 'contentSha256': file_sha(target),
                            'targetUid': target_stat.st_uid, 'targetGid': target_stat.st_gid, 'targetMode': target_stat.st_mode & 0o777}
                        continue
                    require(not path.is_symlink(), 'CONFIG_BIND_SPECIAL_FILE')
                    if path.is_dir():
                        continue
                    require(path.is_file() and not path.is_symlink(), 'CONFIG_BIND_SPECIAL_FILE')
                    stat = path.stat()
                    result[str(path)] = [file_sha(path), stat.st_uid, stat.st_gid, stat.st_mode & 0o777]
        return result

    def inventory(self):
        rows = self.rows()
        result = {'kind': 'customer-path-inventory', 'capturedAt': time.time(), 'services': {}}
        for role, row in rows.items():
            require(row['Image'] == IMAGES[role] and row['State']['Running'], 'BASE_IMAGE_OR_STATE_DRIFT')
            excluded = excluded_mounts(row)
            live = hashes(self.run, role, row['Id'], excluded)
            image = hashes(self.run, role, row['Image'], excluded, image=True)
            require(live == image, 'LIVE_IMAGE_APPLICATION_DRIFT:' + role)
            result['services'][role] = {'image': row['Image'], 'containerId': row['Id'],
                'excludedMounts': excluded, 'hashes': image,
                'user': row['Config'].get('User'), 'nodeVersion': self.run(['docker', 'exec', row['Id'], 'node', '--version']).strip() if role in ('crm', 'worker') else None}
        private_json(self.root / 'inventory.json', result)
        return {'phase': 'inventory', 'path': str(self.root / 'inventory.json'),
                'sha256': file_sha(self.root / 'inventory.json'),
                'files': {role: len(v['hashes']) for role, v in result['services'].items()}, 'productionMutation': False}

    def database(self, rows):
        paths = []
        for role in ('crm', 'worker'):
            require(core.envmap(rows[role]).get('DB_PATH') == '/app/data/crm_v2.db', 'DATABASE_ENV_DRIFT')
            mounted = [m for m in rows[role]['Mounts'] if m['Destination'] == '/app/data']
            require(len(mounted) == 1 and mounted[0]['Type'] == 'bind' and mounted[0]['RW'], 'DATABASE_MOUNT_DRIFT')
            paths.append((Path(mounted[0]['Source']) / 'crm_v2.db').resolve())
        require(paths[0] == paths[1] and paths[0].is_file(), 'CRM_WORKER_DATABASE_SPLIT')
        return paths[0]

    def engine_databases(self, rows):
        mount = next(m for m in rows['engine']['Mounts'] if m['Destination'] == '/app/data')
        root = Path(mount['Source'])
        result = []
        for name in ('outbound.db', 'outbound_campaigns.db', 'call_history.db'):
            if (root / name).is_file():
                result.append(str((root / name).resolve()))
        # Detect instead of silently missing a newly configured engine DB path.
        env = core.envmap(rows['engine'])
        for key in ('OUTBOUND_DB_PATH', 'CALL_HISTORY_DB_PATH'):
            value = env.get(key)
            if value and value.startswith('/app/data/'):
                local = root / value.removeprefix('/app/data/')
                require(local.is_file(), 'ENGINE_DATABASE_MISSING')
                if str(local.resolve()) not in result:
                    result.append(str(local.resolve()))
        require(result, 'ENGINE_DATABASE_INVENTORY_EMPTY')
        return sorted(result)

    def migration(self, image, database, mode='migrate', role='crm'):
        database = Path(database)
        # A root-created WAL/SHM would lock the actual1000:986 worker out. Never
        # change the live DB owner: run the migration as its existing owner.
        stat = database.stat(); user = str(stat.st_uid) + ':' + str(stat.st_gid)
        runtime = self.root / 'migration-runtime'
        runtime.mkdir(exist_ok=True, mode=0o755); runtime.chmod(0o755)
        for name in ('migrations.cjs', 'schema-contract.json'):
            source = self.bundle / 'tooling' / name
            require(file_sha(source) == self.m['tooling'][name], 'MIGRATION_RUNTIME_SOURCE_DRIFT')
            target = runtime / name
            target.write_bytes(source.read_bytes()); target.chmod(0o444)
        script = runtime / 'migrations.cjs'
        command = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', user,
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--env-file', str(self.root / (role + '-before.env')),
            '-e', 'AVA_RELEASE_OFFLINE=1', '-e', 'DB_PATH=/verify/' + Path(database).name,
            '-e', 'AVA_SCHEMA_CONTRACT=/release/schema-contract.json',
            '--mount', f'type=bind,src={Path(database).parent},dst=/verify',
            '--mount', f'type=bind,src={script},dst=/release/migrations.cjs,readonly',
            '--mount', f'type=bind,src={runtime / "schema-contract.json"},dst=/release/schema-contract.json,readonly',
            '--entrypoint', 'node', image, '/release/migrations.cjs', mode]
        output = self.run(command, timeout=300)
        value = json.loads(output)
        require(value.get('ok') is True and value.get('mode') == mode, 'DATABASE_GATE_FAILED')
        return value

    def clone_for_migration(self, source, name, uid, gid):
        directory = self.root / name
        require(not directory.exists(), 'MIGRATION_CLONE_EXISTS')
        directory.mkdir(mode=0o700)
        target = directory / 'crm.db'; shutil.copyfile(source, target)
        os.chown(target, uid, gid); target.chmod(0o600)
        os.chown(directory, uid, gid); directory.chmod(0o700)
        return target

    def crm_backup(self, source, name, image):
        source = Path(source); stat = source.stat()
        directory = self.root / name
        require(not directory.exists(), 'CRM_BACKUP_EXISTS')
        directory.mkdir(mode=0o700); os.chown(directory, stat.st_uid, stat.st_gid)
        script = r'''const fs=require('fs'),SQLite=require('/app/node_modules/better-sqlite3');
process.umask(0o077);const src=new SQLite('/source/'+process.env.SOURCE_NAME,{readonly:true,fileMustExist:true});require('/app/node_modules/sqlite-vec').load(src);
src.backup('/snapshot/crm.db').then(()=>{src.close();const dst=new SQLite('/snapshot/crm.db',{fileMustExist:true});require('/app/node_modules/sqlite-vec').load(dst);
if(dst.pragma('integrity_check',{simple:true})!=='ok')throw Error('BACKUP_INTEGRITY');dst.pragma('journal_mode=DELETE');dst.close();fs.chmodSync('/snapshot/crm.db',0o600);console.log(JSON.stringify({backupVerified:true}));}).catch(()=>process.exit(1));'''
        output = self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only',
            '--user', str(stat.st_uid) + ':' + str(stat.st_gid),
            '--mount', f'type=bind,src={source.parent},dst=/source',
            '--mount', f'type=bind,src={directory},dst=/snapshot', '-e', 'SOURCE_NAME=' + source.name,
            '--entrypoint', 'node', image, '-e', script], timeout=180)
        require(json.loads(output).get('backupVerified') is True, 'CRM_OWNER_BACKUP_FAILED')
        target = directory / 'crm.db'
        require(target.is_file() and not target.is_symlink(), 'CRM_BACKUP_FILE_INVALID')
        return {'path': str(target), 'sha256': file_sha(target), 'integrityOk': True,
                'method': 'sqlite-online-backup-as-database-owner', 'sourceUid': stat.st_uid, 'sourceGid': stat.st_gid}

    def engine_backup(self, source, name, image):
        source = Path(source); stat = source.stat(); directory = self.root / name
        require(not directory.exists(), 'ENGINE_BACKUP_EXISTS')
        directory.mkdir(mode=0o700); os.chown(directory, stat.st_uid, stat.st_gid)
        script = "import sqlite3,os,pathlib,json;os.umask(0o077);s=sqlite3.connect('file:/source/'+os.environ['SOURCE_NAME']+'?mode=ro',uri=True);d=sqlite3.connect('/snapshot/engine.db');s.backup(d);assert d.execute('PRAGMA integrity_check').fetchall()==[('ok',)];d.execute('PRAGMA journal_mode=DELETE');d.close();s.close();os.chmod('/snapshot/engine.db',0o600);print(json.dumps({'backupVerified':True}))"
        output = self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only',
            '--user', str(stat.st_uid) + ':' + str(stat.st_gid),
            '--mount', f'type=bind,src={source.parent},dst=/source',
            '--mount', f'type=bind,src={directory},dst=/snapshot', '-e', 'SOURCE_NAME=' + source.name,
            '--entrypoint', 'python', image, '-c', script], timeout=180)
        require(json.loads(output).get('backupVerified') is True, 'ENGINE_OWNER_BACKUP_FAILED')
        target = directory / 'engine.db'
        return {'path': str(target), 'sha256': file_sha(target), 'integrityOk': True, 'method': 'sqlite-online-backup-as-database-owner'}

    def database_metadata_guard(self, p):
        database = Path(p['database']); stat = database.stat(); parent = database.parent.stat()
        require([stat.st_dev, stat.st_ino] == p['databaseIdentity'] and
                [stat.st_uid, stat.st_gid, stat.st_mode & 0o777] == p['databaseMetadata'], 'DATABASE_IDENTITY_OR_METADATA_CHANGED')
        require([parent.st_uid, parent.st_gid, parent.st_mode & 0o777] == p['databaseDirectoryMetadata'], 'DATABASE_DIRECTORY_METADATA_CHANGED')
        for suffix in ('-wal', '-shm'):
            path = Path(str(database) + suffix)
            if path.exists():
                sidecar = path.stat()
                require(not path.is_symlink() and sidecar.st_uid == stat.st_uid and sidecar.st_gid == stat.st_gid and
                        sidecar.st_mode & 0o777 == stat.st_mode & 0o777, 'DATABASE_SIDECAR_OWNER_OR_MODE_CHANGED')

    def writer_access(self, image, database, user):
        # Safe on a private clone and during apply's quiesced interval. No DML:
        # prove the real service UID can create/lock WAL and roll back immediately.
        script = r'''const fs=require('fs'),path=require('path'),SQLite=require('/app/node_modules/better-sqlite3');
const p=process.env.DB_PATH;fs.accessSync(p,fs.constants.R_OK|fs.constants.W_OK);fs.accessSync(path.dirname(p),fs.constants.R_OK|fs.constants.W_OK|fs.constants.X_OK);
for(const suffix of ['-wal','-shm'])if(fs.existsSync(p+suffix))fs.accessSync(p+suffix,fs.constants.R_OK|fs.constants.W_OK);
const db=new SQLite(p,{fileMustExist:true});db.pragma('busy_timeout=10000');if(db.pragma('journal_mode',{simple:true})!=='wal')throw Error('WAL_REQUIRED');
db.exec('BEGIN IMMEDIATE;ROLLBACK;');db.close();console.log(JSON.stringify({writerAccess:true}));'''
        output = self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', user,
            '--mount', f'type=bind,src={Path(database).parent},dst=/verify', '-e', 'DB_PATH=/verify/' + Path(database).name,
            '--entrypoint', 'node', image, '-e', script], timeout=30)
        require(json.loads(output).get('writerAccess') is True, 'DATABASE_SERVICE_WRITER_ACCESS_FAILED')

    def stage_voice_config(self, before):
        # Only the sanitized customer catalog receives legacy ambient metadata;
        # the engine's secret config/audio paths remain byte-for-byte untouched.
        mounts = [m for m in before['crm']['Mounts'] if m['Destination'] == '/app/voice-config']
        require(len(mounts) == 1 and mounts[0]['Type'] == 'bind' and not mounts[0]['RW'], 'VOICE_CATALOG_BIND_INVALID')
        original = Path(mounts[0]['Source'])
        require(original.is_dir(), 'VOICE_CATALOG_DIRECTORY_REQUIRED')
        staged = self.root / 'voice-config'
        shutil.copytree(original, staged)
        for path in [staged, *staged.rglob('*')]:
            require(not path.is_symlink(), 'VOICE_CATALOG_SYMLINK')
            path.chmod(0o755 if path.is_dir() else 0o444)
        target = staged / 'ai-agent.yaml'
        text = target.read_text()
        safe = json.loads(self.run(['docker', 'exec', before['engine']['Id'], 'python', '-c',
            "import yaml,json;v=yaml.safe_load(open('/app/config/ai-agent.yaml')).get('ambient_audio',{});print(json.dumps({'enabled':v.get('enabled'),'business_ids':v.get('business_ids'),'volume':v.get('volume',1)}))"]))
        require(safe == {'enabled': True, 'business_ids': [9], 'volume': 1}, 'ENGINE_AMBIENT_SCOPE_CHANGED')
        if re.search(r'(?m)^ambient_audio\s*:', text):
            existing = json.loads(self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only',
                '--mount', f'type=bind,src={staged},dst=/verify,readonly', '--entrypoint', 'python', IMAGES['engine'], '-c',
                "import yaml,json;v=yaml.safe_load(open('/verify/ai-agent.yaml')).get('ambient_audio',{});print(json.dumps({'enabled':v.get('enabled'),'business_ids':v.get('business_ids'),'volume':v.get('volume',1)}))"]))
            require(existing == safe, 'VOICE_AMBIENT_CATALOG_SCOPE_DRIFT')
        else:
            target.chmod(0o644)
            target.write_text(text.rstrip() + '\n\nambient_audio:\n  enabled: true\n  business_ids: [9]\n  volume: 1\n')
            target.chmod(0o444)
        return str(staged), tree(staged)

    def build_images(self, before, inventory):
        images = {}
        build = self.root / 'build'
        build.mkdir()
        for role, item in self.m['services'].items():
            row = before[role]
            require(item['baseTreeSha256'] == sha(canonical(inventory['services'][role]['hashes'])), 'INVENTORY_TREE_DRIFT')
            for path, expected in item['baseFiles'].items():
                require(inventory['services'][role]['hashes'].get(path) == expected, 'BASE_PREIMAGE_DRIFT')
            directory = build / role
            directory.mkdir()
            ordinary, shared = directory / 'app', directory / 'shared'
            ordinary.mkdir(); shared.mkdir()
            for path in item['files']:
                source = self.bundle / 'payload' / role / path
                target = shared / path.removeprefix('__shared_runtime__/') if path.startswith('__shared_runtime__/') else ordinary / path
                target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(source, target); target.chmod(0o644)
            for path in [ordinary, shared, *ordinary.rglob('*'), *shared.rglob('*')]:
                if path.is_dir():
                    path.chmod(0o755)
            base_tag = 'ava-customer-path-base-' + role + ':' + item['baseImage'][-12:]
            self.run(['docker', 'tag', item['baseImage'], base_tag])
            user = row['Config'].get('User')
            require(isinstance(user, str) and user and re.fullmatch('[A-Za-z0-9_:.-]+', user), 'BASE_USER_NOT_EXPLICIT')
            dockerfile = ['FROM ' + base_tag, 'USER 0:0']
            if role == 'crm':
                dockerfile.append('RUN rm -rf /app/frontend/dist')
            dockerfile.append('COPY app/ /app/')
            if any(name.startswith('__shared_runtime__/') for name in item['files']):
                require(core.envmap(row).get('AVA_SHARED_SOURCE_ROOT') == '/opt/ava-runtime-source' and
                        not any(m['Destination'].startswith('/opt/ava-runtime-source') for m in row['Mounts']), 'SHARED_RUNTIME_SHADOWED')
                dockerfile.append('COPY shared/ /opt/ava-runtime-source/')
            dockerfile.extend(['USER ' + user, 'LABEL org.ava.customer-path.commit=' + self.m['candidateCommit']])
            (directory / 'Dockerfile').write_text('\n'.join(dockerfile) + '\n')
            self.run(['docker', 'build', '--network', 'none', '--pull=false', '--tag', item['candidateTag'], str(directory)], timeout=600)
            image = json.loads(self.run(['docker', 'image', 'inspect', item['candidateTag']]))[0]
            require(image['Config'].get('User') == user, 'CANDIDATE_USER_CHANGED')
            actual = hashes(self.run, role, image['Id'], item['excludedMounts'], image=True)
            expected = expected_tree(inventory['services'][role]['hashes'], item['files'], role == 'crm')
            require(actual == expected, 'FULL_UNSELECTED_SOURCE_BYTE_FENCE_FAILED:' + role)
            if role in ('crm', 'worker'):
                actual = core.envmap(row)
                node_path = actual.get('NODE_PATH', '') + (':' if actual.get('NODE_PATH') else '') + '/app/product-dependencies/node_modules'
                self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node',
                    '--env-file', str(self.root / (role + '-before.env')), '-e', 'NODE_PATH=' + node_path, image['Id'], '-e',
                    "if(require('read-excel-file/package.json').version!=='9.3.12')process.exit(1);require('read-excel-file/node');require('/app/src/services/gemini-text.service');"])
            if role == 'admin':
                self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'python', image['Id'], '-c',
                    "import sys,hashlib,pathlib;sys.path.insert(0,'/opt/ava-runtime-source');import src.core.outbound_store as m;assert pathlib.Path(m.__file__).resolve()==pathlib.Path('/opt/ava-runtime-source/src/core/outbound_store.py');assert hashlib.sha256(pathlib.Path(m.__file__).read_bytes()).hexdigest()=='" + item['files']['__shared_runtime__/src/core/outbound_store.py'] + "'"])
            images[role] = image['Id']
        private_json(self.root / 'images.json', images)
        return images

    def overrides(self, before, images, staged_voice):
        paths, intended, rollback_paths = {}, {}, {}
        for role, row in before.items():
            baseline = core.rendered(row)
            actual = core.envmap(row)
            require(all(actual.get(k) == v for k, v in baseline.get('environment', {}).items()), 'LIVE_COMPOSE_ENV_DRIFT')
            require(core.mount_signature(baseline.get('volumes', [])) == core.mount_signature(row['Mounts'], live=True), 'LIVE_COMPOSE_MOUNT_DRIFT')
            env = dict(actual)
            if role in ('crm', 'worker'):
                old = env.get('NODE_PATH', '')
                require('/app/product-dependencies/node_modules' not in old.split(':'), 'DEPENDENCY_NODE_PATH_EXISTS')
                env['NODE_PATH'] = old + (':' if old else '') + '/app/product-dependencies/node_modules'
            require(role != 'crm' or json.loads(env.get('AVA_TELEPHONY_LEGACY_DIDS', '{}')) == {"79000000000": 9} and
                    env.get('OPENWA_EGRESS_PROXY_URL', '') == '', 'PRODUCTION_ROUTING_DRIFT')
            delta = {'image': images[role], 'environment': {k: v.replace('$', '$$') for k, v in env.items()}}
            wanted = copy.deepcopy(baseline); wanted.update(image=images[role], environment=env)
            if role in ('crm', 'worker'):
                addition = {'type': 'bind', 'source': staged_voice, 'target': '/app/voice-config', 'read_only': True}
                delta['volumes'] = [addition]
                wanted['volumes'] = [addition if v['target'] == '/app/voice-config' else v for v in wanted['volumes']]
            service = row['Config']['Labels']['com.docker.compose.service']
            path = self.root / (role + '.candidate.private.json')
            private_json(path, {'services': {service: delta}})
            require(core.rendered(row, path) == wanted, 'CANDIDATE_COMPOSE_RENDER_DRIFT')
            paths[role], intended[role] = str(path), wanted
            rollback = self.root / (role + '.rollback.private.json')
            old_delta = {'image': row['Image'], 'environment': {k: v.replace('$', '$$') for k, v in actual.items()}}
            private_json(rollback, {'services': {service: old_delta}})
            expected_old = {**copy.deepcopy(baseline), 'image': row['Image'], 'environment': actual}
            require(core.rendered(row, rollback) == expected_old, 'ROLLBACK_COMPOSE_RENDER_DRIFT')
            rollback_paths[role] = str(rollback)
        return paths, intended, rollback_paths

    def prepare(self):
        require(not (self.root / 'prepared.private.json').exists(), 'ALREADY_PREPARED')
        self.bundle_guard()
        before = self.rows()
        inventory = json.loads((self.bundle / 'inventory.json').read_text())
        original_inputs = self.config_inputs(before)
        original_bindings = self.binding_hashes(before)
        original_other = self.other_containers()
        for role, row in before.items():
            require(row['Image'] == IMAGES[role] and row['State']['Running'] and not row['State'].get('Paused'), 'BASE_CONTAINER_CHANGED')
            require(excluded_mounts(row) == self.m['services'][role]['excludedMounts'], 'BASE_MOUNT_CHANGED')
            require(hashes(self.run, role, row['Id'], excluded_mounts(row)) == inventory['services'][role]['hashes'], 'APPLICATION_SOURCE_DRIFT')
            core.private_env(self.root / (role + '-before.env'), core.envmap(row))
        database = self.database(before)
        database_stat = database.stat()
        backup = self.crm_backup(database, 'prepare-backup', before['crm']['Image'])
        staged_voice, voice_hashes = self.stage_voice_config(before)
        images = self.build_images(before, inventory)
        clone = self.clone_for_migration(backup['path'], 'prepare-clone', database_stat.st_uid, database_stat.st_gid)
        migration = self.migration(images['crm'], clone)
        self.writer_access(images['worker'], clone, before['worker']['Config']['User'])
        worker_snapshot = self.migration(images['worker'], clone, 'snapshot', 'worker')
        require(worker_snapshot['snapshot'] == migration['afterSnapshot'], 'WORKER_SCHEMA_DRIVER_INCOMPATIBLE')
        overrides, intended, rollback_overrides = self.overrides(before, images, staged_voice)
        require(self.config_inputs(before) == original_inputs and self.binding_hashes(before) == original_bindings
                and self.other_containers() == original_other, 'PREPARE_CONFIGURATION_CHANGED_IN_FLIGHT')
        for role, row in self.rows().items():
            require(row['Id'] == before[role]['Id'] and row['Image'] == before[role]['Image']
                    and core.envmap(row) == core.envmap(before[role]) and row['Mounts'] == before[role]['Mounts']
                    and row['HostConfig'] == before[role]['HostConfig'], 'PREPARE_RUNTIME_CHANGED_IN_FLIGHT')
        prepared = {'candidateCommit': self.m['candidateCommit'], 'manifestSha256': self.manifest_sha,
            'bundle': str(self.bundle), 'before': before, 'images': images, 'inputs': original_inputs,
            'otherContainers': original_other, 'bindings': original_bindings,
            'database': str(database), 'databaseMetadata': [database.stat().st_uid, database.stat().st_gid, database.stat().st_mode & 0o777],
            'databaseIdentity': [database.stat().st_dev, database.stat().st_ino],
            'databaseDirectoryMetadata': [database.parent.stat().st_uid, database.parent.stat().st_gid, database.parent.stat().st_mode & 0o777],
            'prepareBackup': backup, 'engineDatabases': self.engine_databases(before),
            'voiceConfig': staged_voice, 'voiceHashes': voice_hashes,
            'overrides': overrides, 'intended': intended, 'rollbackOverrides': rollback_overrides,
            'migrationSchema': migration['afterSchema'], 'newSchemaObjects': migration['newObjects']}
        private_json(self.root / 'migration-copy.private.json', migration)
        private_json(self.root / 'prepared.private.json', prepared)
        return {'phase': 'prepared', 'candidateCommit': self.m['candidateCommit'], 'images': images,
                'schemaCloneVerified': True, 'newSchemaObjects': migration['newObjects'],
                'productionMutation': False, 'backup': backup}

    def load(self):
        p = json.loads((self.root / 'prepared.private.json').read_text())
        if self.m is None:
            self.bundle = Path(p['bundle']); self.manifest_sha = p['manifestSha256']
            self.m = validate_manifest(json.loads((self.bundle / 'manifest.json').read_text()))
        require(p['candidateCommit'] == self.m['candidateCommit'], 'PREPARED_CANDIDATE_CHANGED')
        self.bundle_guard()
        return p

    def input_guard(self, p):
        require(all(file_sha(path) == digest for path, digest in p['inputs'].items()), 'COMPOSE_INPUT_DRIFT')
        require(tree(p['voiceConfig']) == p['voiceHashes'], 'STAGED_VOICE_CONFIG_DRIFT')
        require(self.binding_hashes(p['before']) == p['bindings'], 'LIVE_CONFIG_BIND_DRIFT')
        require(self.other_containers() == p['otherContainers'], 'UNRELATED_CONTAINER_CHANGED')

    def guard_before(self, p):
        self.input_guard(p)
        database = self.database(self.rows())
        require(str(database) == p['database'] and [database.stat().st_dev, database.stat().st_ino] == p['databaseIdentity'], 'DATABASE_FILE_REPLACED')
        inventory = json.loads((self.bundle / 'inventory.json').read_text())
        for role, row in self.rows().items():
            previous = p['before'][role]
            require(row['Id'] == previous['Id'] and row['Image'] == previous['Image'] and row['State']['Running']
                    and row.get('RestartCount') == previous.get('RestartCount'), 'LIVE_CONTAINER_DRIFT')
            require(core.envmap(row) == core.envmap(previous) and row['Mounts'] == previous['Mounts']
                    and row['HostConfig'] == previous['HostConfig'], 'LIVE_RUNTIME_DRIFT')
            require(hashes(self.run, role, row['Id'], self.m['services'][role]['excludedMounts']) == inventory['services'][role]['hashes'],
                    'LIVE_APPLICATION_CHANGED_AFTER_PREPARE')

    def idle(self):
        core.idle()

    def stop(self, p, roles):
        for role in roles:
            row = self.inspect(NAMES[role])
            require(row['Image'] in (p['before'][role]['Image'], p['images'][role]), 'STOP_IMAGE_DRIFT')
            command, cwd, service = core.compose(p['before'][role])
            self.run(command + ['stop', '--timeout', '30', service], cwd=cwd, timeout=60)
            require(not self.inspect(NAMES[role])['State']['Running'], 'QUIESCE_FAILED')

    def check_container(self, p, role, rollback=False):
        row = self.inspect(NAMES[role]); previous = p['before'][role]
        require(row['Image'] == (previous['Image'] if rollback else p['images'][role]) and row['State']['Running']
                and not row['State'].get('Paused') and row.get('RestartCount') == 0, 'SERVICE_IMAGE_STATE_INVALID')
        intended_env = core.envmap(previous) if rollback else p['intended'][role]['environment']
        require(core.envmap(row) == intended_env, 'SERVICE_ENV_CHANGED')
        mounts = core.mount_signature(previous['Mounts'], live=True) if rollback else core.mount_signature(p['intended'][role]['volumes'])
        require(core.mount_signature(row['Mounts'], live=True) == mounts, 'SERVICE_MOUNTS_CHANGED')
        require(set(row['NetworkSettings']['Networks']) == set(previous['NetworkSettings']['Networks']), 'SERVICE_NETWORK_CHANGED')
        for key in set(row['HostConfig']) | set(previous['HostConfig']):
            if key in ('Binds', 'Mounts'):
                continue  # Exact mount signature above includes only approved delta.
            require(row['HostConfig'].get(key) == previous['HostConfig'].get(key), 'HOST_CONFIG_CHANGED:' + key)
        for key in ('User', 'Entrypoint', 'Cmd', 'WorkingDir', 'Healthcheck', 'StopSignal', 'StopTimeout'):
            require(row['Config'].get(key) == previous['Config'].get(key), 'PROCESS_CONFIG_CHANGED:' + key)
        return row

    def ready(self, role):
        if role == 'engine':
            with urlopen('http://127.0.0.1:15000/health', timeout=5) as response:
                value = json.load(response)
            require(value.get('status') == 'healthy' and value.get('ari_connected') is True and
                    value.get('audiosocket', {}).get('listening') is True, 'ENGINE_NOT_READY')
        elif role in ('crm', 'worker'):
            path = '/api/health' if role == 'crm' else '/__ava_release_readiness__'
            port = "Number(process.env.PORT||3000)" if role == 'crm' else '3900'
            script = "const http=require('http');const r=http.get({host:'127.0.0.1',port:" + port + ",path:" + json.dumps(path) + ",timeout:4000},s=>{let b='';s.on('data',x=>b+=x);s.on('end',()=>{try{const j=JSON.parse(b);if(s.statusCode!==200||" + ("j.ready!==true" if role == 'worker' else "!j.status") + ")process.exit(1)}catch(_){process.exit(1)}})});r.on('timeout',()=>r.destroy());r.on('error',()=>process.exit(1));"
            self.run(['docker', 'exec', NAMES[role], 'node', '-e', script], timeout=8)
        elif role == 'admin':
            # Internal status route requires service token; do not leak it in
            # argv or make a side-effecting provider/call request for readiness.
            script = "import os,urllib.request; p=int(os.getenv('UVICORN_PORT','3003'));r=urllib.request.urlopen('http://127.0.0.1:'+str(p)+'/health',timeout=4);assert r.status==200"
            self.run(['docker', 'exec', NAMES[role], 'python', '-c', script], timeout=8)

    def up(self, p, role, rollback=False):
        self.input_guard(p)
        override = p['rollbackOverrides' if rollback else 'overrides'][role]
        value = core.rendered(p['before'][role], override)
        expected = {**copy.deepcopy(core.rendered(p['before'][role])), 'image': p['before'][role]['Image'],
                    'environment': core.envmap(p['before'][role])} if rollback else p['intended'][role]
        require(value == expected, 'COMPOSE_RENDER_CHANGED')
        command, cwd, service = core.compose(p['before'][role], override)
        self.run(command + ['up', '-d', '--no-deps', '--pull', 'never', '--force-recreate', service], cwd=cwd, timeout=180)
        deadline = time.monotonic() + 100
        while time.monotonic() < deadline:
            row = self.inspect(NAMES[role])
            require(row.get('RestartCount') == 0, 'SERVICE_RESTARTED')
            try:
                self.check_container(p, role, rollback)
                if role == 'crm':
                    require(row['State'].get('Health', {}).get('Status') == 'healthy', 'CRM_NOT_HEALTHY')
                self.ready(role)
                return
            except Exception:
                time.sleep(2)
        raise RuntimeError('SERVICE_READY_TIMEOUT:' + role)

    def engine_snapshot(self, database, image=None):
        # stdlib SQLite covers the call/outbound ledger, not CRM's vec extension.
        if image:
            source = Path(database); stat = source.stat()
            script = r'''import sqlite3,os,json,hashlib
db=sqlite3.connect('file:/source/'+os.environ['SOURCE_NAME']+'?mode=ro',uri=True)
digest=lambda v:hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()
objects=db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall();result={}
for name,_ in objects:
 quoted='"'+name.replace('"','""')+'"';values=[]
 for row in db.execute('SELECT * FROM '+quoted):values.append(digest([[type(v).__name__,v.hex() if isinstance(v,bytes) else v] for v in row]))
 result[name]={'count':len(values),'digest':digest(sorted(values))}
db.close();print(json.dumps({'schema':[list(row) for row in objects],'tables':result}))'''
            return json.loads(self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only',
                '--user', str(stat.st_uid) + ':' + str(stat.st_gid),
                '--mount', f'type=bind,src={source.parent},dst=/source', '-e', 'SOURCE_NAME=' + source.name,
                '--entrypoint', 'python', image, '-c', script], timeout=120))
        import sqlite3
        db = sqlite3.connect(Path(database).as_uri() + '?mode=ro', uri=True)
        try:
            objects = db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
            result = {}
            for name, _ in objects:
                quoted = '"' + name.replace('"', '""') + '"'
                values = []
                for row in db.execute('SELECT * FROM ' + quoted):
                    values.append(sha(canonical([[type(v).__name__, v.hex() if isinstance(v, bytes) else v] for v in row])))
                result[name] = {'count': len(values), 'digest': sha(canonical(sorted(values)))}
            return {'schema': [list(row) for row in objects], 'tables': result}
        finally:
            db.close()

    def apply(self):
        p = self.load()
        require(not (self.root / 'apply-started.private.json').exists(), 'APPLY_ALREADY_STARTED')
        self.guard_before(p); self.idle()
        private_json(self.root / 'apply-started.private.json', {'candidateCommit': p['candidateCommit'], 'at': time.time()})
        # Quiesce writers before the final SQLite snapshot. No stale prepare
        # database is ever restored over subsequent customer work.
        try:
            self.stop(p, ['crm', 'worker'])
            fresh = self.crm_backup(Path(p['database']), 'apply-backup', p['images']['crm'])
            private_json(self.root / 'apply-backup.private.json', fresh)
            clone = self.clone_for_migration(fresh['path'], 'apply-clone', p['databaseMetadata'][0], p['databaseMetadata'][1])
            gate = self.migration(p['images']['crm'], clone)
            self.writer_access(p['images']['worker'], clone, p['before']['worker']['Config']['User'])
            require(gate['afterSchema'] == p['migrationSchema'], 'FRESH_CLONE_SCHEMA_CHANGED')
            self.idle()
            self.stop(p, ['admin', 'engine'])
            p['engineBeforeApply'] = {path: self.engine_snapshot(path, p['images']['engine']) for path in p['engineDatabases']}
            p['engineBackups'] = {str(index): self.engine_backup(Path(path), 'apply-engine-' + str(index), p['images']['engine'])
                                  for index, path in enumerate(p['engineDatabases'])}
            private_json(self.root / 'live-migration-started.private.json', {'candidateCommit': p['candidateCommit'], 'at': time.time()})
            migrated = self.migration(p['images']['crm'], Path(p['database']))
            require(migrated['afterSchema'] == p['migrationSchema'], 'LIVE_SCHEMA_MISMATCH')
            self.database_metadata_guard(p)
            self.writer_access(p['images']['worker'], Path(p['database']), p['before']['worker']['Config']['User'])
            self.database_metadata_guard(p)
            p['afterMigrationSnapshot'] = migrated['afterSnapshot']
            private_json(self.root / 'prepared.private.json', p)
            private_json(self.root / 'migration-live.private.json', migrated)
            for role in ('admin', 'engine', 'worker', 'crm'):
                private_json(self.root / 'activation-started.private.json', {'candidateCommit': p['candidateCommit'], 'role': role, 'at': time.time()})
                self.up(p, role)
            result = self.verify()
            private_json(self.root / 'applied.private.json', result)
            return {'phase': 'applied', **result, 'backup': fresh}
        except Exception as error:
            private_json(self.root / 'apply-failure.private.json', {'candidateCommit': p['candidateCommit'], 'exceptionType': type(error).__name__})
            try:
                self.rollback(automatic=True)
            except Exception:
                self.recover_services(p, compatible=(self.root / 'live-migration-started.private.json').exists())
                raise RuntimeError('APPLY_FAILED_COMPATIBLE_RECOVERY_REQUIRED_DATABASE_RETAINED') from None
            raise RuntimeError('APPLY_FAILED_ROLLED_BACK_DATABASE_RETAINED') from None

    def rollback(self, automatic=False):
        p = self.load()
        self.idle(); self.input_guard(p)
        for role, row in self.rows().items():
            require(row['Image'] in (p['before'][role]['Image'], p['images'][role]), 'ROLLBACK_IMAGE_DRIFT')
            expected_env = core.envmap(p['before'][role]) if row['Image'] == p['before'][role]['Image'] else p['intended'][role]['environment']
            require(core.envmap(row) == expected_env, 'ROLLBACK_RUNTIME_ENV_DRIFT')
        try:
            self.stop(p, ['crm', 'worker', 'admin', 'engine'])
            current = self.migration(p['images']['crm'], Path(p['database']), 'snapshot')['snapshot']
            if not (self.root / 'live-migration-started.private.json').exists():
                pass  # No application/schema execution touched the live DB.
            elif 'afterMigrationSnapshot' in p:
                require(current == p['afterMigrationSnapshot'], 'ROLLBACK_NEW_CUSTOMER_DATA_REQUIRES_COMPATIBLE_RECOVERY')
                barriers = self.migration(p['images']['crm'], Path(p['database']), 'barriers')['barriers']
                require(not any(barriers.values()), 'ROLLBACK_EXTERNAL_OUTCOME_OR_REGISTRATION_FENCE')
            else:
                # Failed before live migration: baseline code can restart only
                # when the current DB still matches the fresh safe backup.
                require((self.root / 'apply-backup.private.json').exists(), 'ROLLBACK_BACKUP_MISSING')
                backup = json.loads((self.root / 'apply-backup.private.json').read_text())
                baseline = self.migration(p['images']['crm'], Path(backup['path']), 'snapshot')['snapshot']
                require(current == baseline, 'ROLLBACK_UNRECORDED_SCHEMA_STATE')
            require(all(self.engine_snapshot(path, p['images']['engine']) == old for path, old in p.get('engineBeforeApply', {}).items()),
                    'ROLLBACK_NEW_CALL_DATA_REQUIRES_COMPATIBLE_RECOVERY')
        except Exception:
            # No old executable is started after a new flow/outcome was written.
            # Keep compatible images; operator must diagnose before admission.
            self.recover_services(p, compatible=(self.root / 'live-migration-started.private.json').exists())
            raise
        recovery = self.recover_services(p, compatible=False)
        require(recovery['allRunning'], 'ROLLBACK_SERVICE_RECOVERY_INCOMPLETE')
        result = self.verify(rollback=True)
        private_json(self.root / 'rolled-back.private.json', result)
        return {'phase': 'rolled_back', 'automatic': automatic, 'databaseRetained': True, **result}

    def recover_services(self, p, compatible):
        """Always attempt every role; do not restart an already running engine."""
        failures, states = {}, {}
        for role in ('admin', 'engine', 'worker', 'crm'):
            target = p['images'][role] if compatible else p['before'][role]['Image']
            try:
                row = self.inspect(NAMES[role])
                if row['Image'] == target and row['State']['Running']:
                    self.ready(role)  # Leave a running service/process intact.
                elif row['Image'] == target:
                    self.run(['docker', 'start', row['Id']], timeout=45)
                else:
                    if role == 'engine':
                        self.idle()
                    # Provisioning may have changed an unrelated container
                    # after activation; do not leave CRM stopped for that fact.
                    # Config/env/mount intent still must be exact before reuse.
                    require(all(file_sha(path) == digest for path, digest in p['inputs'].items()), 'RECOVERY_COMPOSE_INPUT_DRIFT')
                    require(tree(p['voiceConfig']) == p['voiceHashes'], 'RECOVERY_VOICE_CONFIG_DRIFT')
                    override = p['overrides' if compatible else 'rollbackOverrides'][role]
                    expected = p['intended'][role] if compatible else {
                        **copy.deepcopy(core.rendered(p['before'][role])), 'image': p['before'][role]['Image'],
                        'environment': core.envmap(p['before'][role])}
                    require(core.rendered(p['before'][role], override) == expected, 'RECOVERY_RENDER_DRIFT')
                    command, cwd, service = core.compose(p['before'][role], override)
                    # Queue all service starts before waiting on health. An
                    # unhealthy Admin must not leave CRM/worker stopped100s.
                    self.run(command + ['up', '-d', '--no-deps', '--pull', 'never', '--force-recreate', service], cwd=cwd, timeout=90)
            except Exception as exc:
                failures[role] = type(exc).__name__
            # A failed health check must not skip the remaining stopped roles.
            try:
                current = self.inspect(NAMES[role])
                states[role] = {'image': current['Image'], 'running': current['State']['Running'],
                                'expectedImage': current['Image'] == target}
            except Exception:
                states[role] = {'running': False, 'expectedImage': False}
        result = {'compatible': compatible, 'states': states, 'failures': failures,
                  'allRunning': all(x['running'] and x['expectedImage'] for x in states.values())}
        private_json(self.root / 'service-recovery.private.json', result)
        return result

    def verify(self, rollback=False):
        p = self.load(); self.input_guard(p)
        self.database_metadata_guard(p)
        for role in NAMES:
            row = self.check_container(p, role, rollback)
            self.ready(role)
            wanted = json.loads((self.bundle / 'inventory.json').read_text())['services'][role]['hashes']
            if not rollback:
                wanted = expected_tree(wanted, self.m['services'][role]['files'], role == 'crm')
            require(hashes(self.run, role, row['Id'], self.m['services'][role]['excludedMounts']) == wanted, 'RUNNING_SOURCE_FENCE_FAILED')
        with urlopen('https://wh.meludtech.tech/', timeout=15) as response:
            require(response.status == 200, 'PUBLIC_HTTPS_FAILED')
        with urlopen('http://127.0.0.1:8097/resolve/79000000000', timeout=5) as response:
            require(response.read(100).decode().strip() == '9|legacy|79000000000', 'DID_BUSINESS_OWNER_CHANGED')
        return {'candidateCommit': p['candidateCommit'], 'rollback': rollback,
                'images': {role: self.inspect(name)['Image'] for role, name in NAMES.items()},
                'healthVerified': True, 'sourceBytesVerified': True, 'otherContainersPreserved': True,
                'didBusiness9Preserved': True, 'databaseRetained': True, 'customerAcceptance': 'NOT_TESTED'}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['inventory', 'prepare', 'apply', 'verify', 'rollback'])
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--manifest-sha256')
    args = parser.parse_args()
    args.root.mkdir(parents=True, exist_ok=True, mode=0o700)
    # One host-wide lock for all four services, independent of release directory.
    lock_path = Path('/var/lock/ava-customer-path-release.lock')
    with lock_path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('CROSS_SERVICE_RELEASE_ALREADY_RUNNING') from None
        operator = Operator(args.root, args.bundle, args.manifest_sha256)
        require(args.action not in ('prepare',) or operator.m is not None, 'BUNDLE_REQUIRED')
        result = getattr(operator, args.action)()
        print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        code = str(exc)
        print(json.dumps({'phase': 'failed', 'code': code if re.fullmatch('[A-Z_]+(?::[a-zA-Z0-9_.-]+)?', code) else 'RELEASE_FAILED_' + type(exc).__name__.upper()}))
        raise SystemExit(1)
