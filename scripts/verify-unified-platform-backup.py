#!/usr/bin/env python3
"""Verify a decrypted recovery stream without extracting secrets or live restore.

Only SQLite and the nested source tar are spooled into a private temporary
directory. No customer rows, environment values, or credentials are printed.
PostgreSQL header checks do not replace an isolated pg_restore rehearsal.
"""
import hashlib
import json
import re
import sqlite3
import sys
import tarfile
import tempfile
from pathlib import Path
from pathlib import PurePosixPath

import yaml


def verify(stream):
    hashes, expected, timestamps, table_counts = {}, {}, {}, {}
    database_manifest = ''
    keycloak_marker = None
    required = {
        './sqlite/crm_v2.db', './sqlite/call_history.db',
        './postgres/twenty--twenty.dump', './postgres/onyx--postgres.dump', './source/live-tree.tar',
        './manifests/postgres-databases.tsv',
        './volumes/asterisk-ai-voice-agent_whatsapp_crm_openwa_data.tar',
        './volumes/ava-twenty_server-local-data.tar', './volumes/onyx_minio_data.tar',
        './volumes/onyx_opensearch-data.tar', './volumes/onyx_file-system.tar',
        './manifests/docker-inspect.private.json',
    }
    with tempfile.TemporaryDirectory(prefix='ava-recovery-check-') as directory:
        root = Path(directory)
        with tarfile.open(fileobj=stream, mode='r|gz') as archive:
            for member in archive:
                if not member.isfile():
                    continue
                if member.name in hashes:
                    raise ValueError('DUPLICATE_ARCHIVE_MEMBER')
                file = archive.extractfile(member)
                if member.name == './SHA256SUMS':
                    for line in file.read(8 * 1024 * 1024).decode().splitlines():
                        digest, name = line.split('  ', 1)
                        if name in expected:
                            raise ValueError('DUPLICATE_CHECKSUM_MEMBER')
                        expected[name] = digest
                    continue
                digest = hashlib.sha256()
                dest = None
                if member.name in ('./sqlite/crm_v2.db', './sqlite/call_history.db',
                                   './source/live-tree.tar', './source/keycloak-state.tar',
                                   './manifests/docker-inspect.private.json', './manifests/source-path.txt'):
                    path = root / Path(member.name).name
                    path.touch(mode=0o600)
                    dest = path.open('wb')
                try:
                    first = file.read(8 * 1024 * 1024)
                    if member.name.endswith('.dump') and not first.startswith(b'PGDMP'):
                        raise ValueError('INVALID_PG_DUMP_HEADER')
                    if member.name in ('./manifests/started-utc.txt', './manifests/completed-utc.txt'):
                        timestamps[Path(member.name).name] = first.decode().strip()
                    if member.name == './manifests/postgres-databases.tsv':
                        database_manifest = first.decode()
                    if member.name == './manifests/keycloak-installed.txt':
                        keycloak_marker = first.decode().strip()
                    if member.name.startswith('./manifests/') and member.name.endswith('-table-count.txt'):
                        table_counts[Path(member.name).name.removesuffix('-table-count.txt')] = int(first)
                    chunk = first
                    while chunk:
                        digest.update(chunk)
                        if dest:
                            dest.write(chunk)
                        chunk = file.read(8 * 1024 * 1024)
                finally:
                    if dest:
                        dest.close()
                hashes[member.name] = digest.hexdigest()
        if not required <= hashes.keys() or hashes != expected:
            raise ValueError('RECOVERY_CONTENT_OR_CHECKSUM_MISMATCH')
        keycloak_installed = keycloak_marker == 'true'
        if keycloak_marker not in (None, 'true'):
            raise ValueError('INVALID_KEYCLOAK_MARKER')
        keycloak_artifacts = {
            './source/keycloak-state.tar', './postgres/identity-globals.sql',
            './postgres/identity--ava_identity.dump',
            './postgres/identity--postgres.dump',
            './manifests/identity--ava_identity-table-count.txt',
            './manifests/identity--postgres-table-count.txt',
            './manifests/source-path.txt',
        }
        if keycloak_installed and not keycloak_artifacts <= hashes.keys():
            raise ValueError('KEYCLOAK_BACKUP_INCOMPLETE')
        # source-path is present in legacy backups too; it is not evidence of
        # an identity stack without one of the identity-specific artifacts.
        if not keycloak_installed and any(name in hashes for name in keycloak_artifacts
                                         if name != './manifests/source-path.txt'):
            raise ValueError('UNDECLARED_KEYCLOAK_BACKUP')

        inventory = set()
        for line in database_manifest.splitlines():
            module, database, dump = line.split('\t')
            if module not in ('twenty', 'onyx', 'identity') or not re.fullmatch(r'[a-zA-Z0-9_-]+', database):
                raise ValueError('INVALID_DATABASE_INVENTORY')
            if module == 'identity' and (not keycloak_installed or database not in ('ava_identity', 'postgres')):
                raise ValueError('INVALID_IDENTITY_DATABASE')
            name = f'{module}--{database}'
            if dump != name + '.dump' or dump in inventory or name not in table_counts:
                raise ValueError('DATABASE_INVENTORY_MISMATCH')
            inventory.add(dump)
        actual_dumps = {Path(name).name for name in hashes if name.startswith('./postgres/') and name.endswith('.dump')}
        required_nonempty = ['twenty--twenty', 'onyx--postgres']
        if keycloak_installed:
            required_nonempty.append('identity--ava_identity')
        if actual_dumps != inventory or not all(table_counts.get(name, 0) > 0 for name in required_nonempty):
            raise ValueError('LIVE_DATABASE_CONTENT_MISSING')
        for name in ('crm_v2.db', 'call_history.db'):
            with sqlite3.connect(f'file:{root/name}?mode=ro', uri=True) as db:
                if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                    raise ValueError('SQLITE_QUICK_CHECK_FAILED')
        configs = 0
        main_compose = None
        with tarfile.open(root / 'live-tree.tar') as source:
            for runtime in ('data', 'asterisk_media'):
                try:
                    member = source.getmember('./' + runtime)
                except KeyError:
                    continue
                if member.issym() and f'./source/runtime-{runtime}.tar' not in hashes:
                    raise ValueError('SHARED_RUNTIME_BACKUP_MISSING')
            for name in ('./.env', './docker-compose.yml', './config/ai-agent.yaml'):
                member = source.getmember(name)
                if not member.isfile() or not member.size:
                    raise ValueError('RECOVERY_SOURCE_CONFIG_MISSING')
                if name.endswith(('.yml', '.yaml')):
                    parsed = yaml.safe_load(source.extractfile(member))
                    if not isinstance(parsed, dict):
                        raise ValueError('INVALID_RECOVERY_YAML')
                    if name == './docker-compose.yml':
                        main_compose = parsed
                    configs += 1
        if keycloak_installed:
            docker_inventory = json.loads((root / 'docker-inspect.private.json').read_text())
            if not isinstance(docker_inventory, list):
                raise ValueError('INVALID_DOCKER_INSPECT_INVENTORY')
            identity_database = next((item for item in docker_inventory
                if item.get('Name', '').lstrip('/') == 'ava-identity-database-1'
                and (item.get('Config', {}).get('Labels') or {}).get('com.docker.compose.project') == 'ava-identity'
                and (item.get('Config', {}).get('Labels') or {}).get('com.docker.compose.service') == 'database'), None)
            if identity_database is None:
                raise ValueError('KEYCLOAK_DATABASE_CONTAINER_MISSING')
            labels = identity_database.get('Config', {}).get('Labels') or {}
            working_dir = labels.get('com.docker.compose.project.working_dir')
            source_path = (root / 'source-path.txt').read_text().strip()
            source_parts = PurePosixPath(source_path).parts
            if len(source_parts) < 4 or source_parts[:3] != ('/', 'root', 'ava-releases') or '..' in source_parts:
                raise ValueError('SOURCE_PATH_UNTRUSTED')
            release_config_dir = str(Path(source_path) / 'deploy' / 'keycloak')
            if working_dir not in ('/opt/ava-identity', release_config_dir):
                raise ValueError('KEYCLOAK_WORKDIR_UNTRUSTED')
            config_files = labels.get('com.docker.compose.project.config_files', '')
            config_names = []
            allowed_config_names = {'.env', 'web.env', 'worker.env', 'docker-compose.yml',
                'pilot-network.override.yml', 'ava-realm.json', 'Dockerfile', 'nginx.conf',
                'nginx-http.conf', 'user-profile.json'}
            for config_file in config_files.split(','):
                config_path = Path(config_file.strip())
                if not config_file or config_path.parent != Path(working_dir) or config_path.name not in allowed_config_names:
                    raise ValueError('INVALID_KEYCLOAK_COMPOSE_INPUT')
                config_names.append(config_path.name)
            if not config_names:
                raise ValueError('INVALID_KEYCLOAK_COMPOSE_INPUT')
            with tarfile.open(root / 'keycloak-state.tar') as state:
                state_members = {member.name: member for member in state if member.isfile()}
                if not {'docker-compose.yml', 'ava-realm.json', '.env'} <= state_members.keys():
                    raise ValueError('KEYCLOAK_CONFIG_STATE_MISSING')
                if not set(config_names) <= state_members.keys():
                    raise ValueError('KEYCLOAK_COMPOSE_INPUT_MISSING')
                try:
                    compose = yaml.safe_load(state.extractfile(state_members['docker-compose.yml']))
                    realm = json.load(state.extractfile(state_members['ava-realm.json']))
                except Exception:
                    raise ValueError('INVALID_KEYCLOAK_COMPOSE') from None
            if not isinstance(compose, dict) or not isinstance(compose.get('services'), dict) or not isinstance(realm, dict):
                raise ValueError('INVALID_KEYCLOAK_COMPOSE')
            required_env_files = set()
            compose_texts = []
            for index, parsed_compose in enumerate((main_compose, compose)):
                if not isinstance(parsed_compose, dict) or not isinstance(parsed_compose.get('services'), dict):
                    raise ValueError('INVALID_KEYCLOAK_COMPOSE')
                compose_texts.append(json.dumps(parsed_compose, sort_keys=True))
                for service in parsed_compose['services'].values():
                    entries = service.get('env_file', []) if isinstance(service, dict) else []
                    if isinstance(entries, (str, dict)):
                        entries = [entries]
                    for entry in entries or []:
                        env_path = entry.get('path') if isinstance(entry, dict) else entry
                        required = entry.get('required', True) if isinstance(entry, dict) else True
                        from_main_compose = (index == 0 and Path(env_path).is_absolute()
                            and Path(env_path).parent == Path(working_dir)) if isinstance(env_path, str) else False
                        if isinstance(env_path, str) and required and (index == 1 or from_main_compose):
                            required_env_files.add(Path(env_path).name)
            if 'user-profile.json' in ''.join(compose_texts) and 'user-profile.json' not in state_members:
                raise ValueError('KEYCLOAK_CONFIG_INPUT_MISSING')
            if not required_env_files <= state_members.keys():
                raise ValueError('KEYCLOAK_ENV_STATE_MISSING')
        return {'checksums': len(hashes), 'sqlite_quick_check': 'ok', 'yaml_configs': configs,
                'postgres_headers': 'ok', 'native_restore_required': True,
                'private_temporary_files_removed_on_exit': True,
                'keycloak_backup_present': keycloak_installed, **timestamps}


if __name__ == '__main__':
    try:
        print(json.dumps(verify(sys.stdin.buffer), sort_keys=True))
    except Exception:
        # Neither traceback nor raw payload: a backup contains live secrets.
        raise SystemExit('UNIFIED_BACKUP_VERIFICATION_FAILED')
