"""Archive validator tests, not native PostgreSQL acceptance evidence."""
import hashlib
import importlib.util
import io
import json
import sqlite3
import tarfile
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('backup_validator', Path(__file__).parents[1] / 'scripts/verify-unified-platform-backup.py')
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


def tar_bytes(files, compressed=True):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz' if compressed else 'w') as archive:
        for name, data in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


def fixture_files(tmp_path):
    db_path = tmp_path / 'fixture.db'
    with sqlite3.connect(db_path) as db:
        db.execute('CREATE TABLE IF NOT EXISTS sample(id INTEGER PRIMARY KEY)')
    files = {
        './sqlite/crm_v2.db': db_path.read_bytes(),
        './sqlite/call_history.db': db_path.read_bytes(),
        './postgres/twenty--twenty.dump': b'PGDMP-contract-fixture-not-restorable',
        './postgres/onyx--postgres.dump': b'PGDMP-contract-fixture-not-restorable',
        './manifests/postgres-databases.tsv': b'twenty\ttwenty\ttwenty--twenty.dump\nonyx\tpostgres\tonyx--postgres.dump\n',
        './manifests/twenty--twenty-table-count.txt': b'1\n',
        './manifests/onyx--postgres-table-count.txt': b'1\n',
        './manifests/docker-inspect.private.json': b'[]',
        './manifests/source-path.txt': b'/root/ava-releases/legacy-no-identity\n',
        './source/live-tree.tar': tar_bytes({
            './.env': b'FIXTURE=true\n', './docker-compose.yml': b'services: {}\n',
            './config/ai-agent.yaml': b'contexts: {}\n',
        }, compressed=False),
    }
    for volume in ('asterisk-ai-voice-agent_whatsapp_crm_openwa_data', 'ava-twenty_server-local-data',
                   'onyx_minio_data', 'onyx_opensearch-data', 'onyx_file-system'):
        files[f'./volumes/{volume}.tar'] = tar_bytes({}, compressed=False)
    return files


def keycloak_fixture_files(tmp_path):
    files = fixture_files(tmp_path)
    files['./manifests/source-path.txt'] = b'/root/ava-releases/2026-09-15\n'
    files['./manifests/docker-inspect.private.json'] = json.dumps([
        {'Name': '/ava-identity-database-1', 'Config': {'Labels': {
            'com.docker.compose.project': 'ava-identity',
            'com.docker.compose.service': 'database',
            'com.docker.compose.project.working_dir': '/opt/ava-identity',
            'com.docker.compose.project.config_files': '/opt/ava-identity/docker-compose.yml,/opt/ava-identity/pilot-network.override.yml',
        }}},
    ]).encode()
    files['./source/live-tree.tar'] = tar_bytes({
        './.env': b'AVA_FIXTURE=true\n',
        './docker-compose.yml': b'services:\n  provisioning_worker:\n    env_file: [/opt/ava-identity/web.env, /opt/ava-identity/worker.env]\n',
        './config/ai-agent.yaml': b'contexts: {}\n',
    }, compressed=False)
    files['./postgres/identity-globals.sql'] = b'-- fixture role globals'
    files['./postgres/identity--ava_identity.dump'] = b'PGDMP-keycloak-fixture-not-restorable'
    files['./postgres/identity--postgres.dump'] = b'PGDMP-default-database-fixture'
    files['./manifests/identity--ava_identity-table-count.txt'] = b'2\n'
    files['./manifests/identity--postgres-table-count.txt'] = b'0\n'
    files['./manifests/keycloak-installed.txt'] = b'true\n'
    files['./manifests/postgres-databases.tsv'] += (
        b'identity\tava_identity\tidentity--ava_identity.dump\n'
        b'identity\tpostgres\tidentity--postgres.dump\n'
    )
    files['./source/keycloak-state.tar'] = tar_bytes({
        'docker-compose.yml': b'services:\n  keycloak:\n    volumes: [./user-profile.json:/opt/keycloak/conf/user-profile.json:ro]\n',
        'ava-realm.json': b'{"realm":"ava"}\n',
        'pilot-network.override.yml': b'services: {}\n',
        'user-profile.json': b'{"profile":"fixture"}\n',
        '.env': b'keycloak-secret-sentinel\n', 'web.env': b'web-secret-sentinel\n',
        'worker.env': b'worker-secret-sentinel\n',
    }, compressed=False)
    return files


def archive(files, wrong_checksum=False):
    checksums = ''.join(f'{hashlib.sha256(data).hexdigest()}  {name}\n' for name, data in files.items())
    if wrong_checksum:
        checksums = ('0' if checksums[0] != '0' else '1') + checksums[1:]
    return io.BytesIO(tar_bytes({**files, './SHA256SUMS': checksums.encode()}))


def test_verifies_real_sqlite_and_keeps_native_restore_as_a_separate_gate(tmp_path):
    result = validator.verify(archive(fixture_files(tmp_path)))
    assert result['sqlite_quick_check'] == 'ok'
    assert result['native_restore_required'] is True
    assert result['keycloak_backup_present'] is False


def test_optional_keycloak_database_and_config_bundle_is_verified(tmp_path):
    result = validator.verify(archive(keycloak_fixture_files(tmp_path)))
    assert result['keycloak_backup_present'] is True
    assert result['native_restore_required'] is True
    assert 'secret-sentinel' not in repr(result)


def test_keycloak_marker_requires_database_and_config_state(tmp_path):
    files = keycloak_fixture_files(tmp_path)
    del files['./postgres/identity--ava_identity.dump']
    with pytest.raises(ValueError, match='KEYCLOAK_BACKUP_INCOMPLETE'):
        validator.verify(archive(files))

    files = keycloak_fixture_files(tmp_path)
    state = {'docker-compose.yml': b'services: {keycloak: {volumes: [./user-profile.json:/x]}}\n', 'ava-realm.json': b'{"realm":"ava"}\n',
             '.env': b'present\n', 'pilot-network.override.yml': b'present\n',
             'web.env': b'present\n', 'worker.env': b'present\n'}
    files['./source/keycloak-state.tar'] = tar_bytes(state, compressed=False)
    with pytest.raises(ValueError, match='KEYCLOAK_CONFIG_INPUT_MISSING'):
        validator.verify(archive(files))

    files = keycloak_fixture_files(tmp_path)
    state = {'docker-compose.yml': b'services: {}\n', 'ava-realm.json': b'{"realm":"ava"}\n',
             'pilot-network.override.yml': b'present\n', 'user-profile.json': b'present\n',
             '.env': b'present\n', 'worker.env': b'present\n'}
    files['./source/keycloak-state.tar'] = tar_bytes(state, compressed=False)
    with pytest.raises(ValueError, match='KEYCLOAK_ENV_STATE_MISSING'):
        validator.verify(archive(files))

    files = keycloak_fixture_files(tmp_path)
    files['./source/keycloak-state.tar'] = tar_bytes({
        'docker-compose.yml': b'services: {}\n', 'ava-realm.json': b'{"realm":"ava"}\n',
        'pilot-network.override.yml': b'present\n',
    }, compressed=False)
    with pytest.raises(ValueError, match='KEYCLOAK_CONFIG_STATE_MISSING'):
        validator.verify(archive(files))


def test_keycloak_env_bundle_is_required_only_for_compose_env_file_references(tmp_path):
    files = keycloak_fixture_files(tmp_path)
    files['./source/keycloak-state.tar'] = tar_bytes({
        'docker-compose.yml': b'services: {keycloak: {image: fixture}}\n',
        'ava-realm.json': b'{"realm":"ava"}\n',
        '.env': b'present\n', 'pilot-network.override.yml': b'present\n',
    }, compressed=False)
    # The stack-level .env is always needed for Compose interpolation, while
    # separate service env files are mandatory only when AVA Compose references them.
    main = tar_bytes({'./.env': b'AVA_FIXTURE=true\n', './docker-compose.yml': b'services: {}\n',
        './config/ai-agent.yaml': b'contexts: {}\n'}, compressed=False)
    files['./source/live-tree.tar'] = main
    assert validator.verify(archive(files))['keycloak_backup_present'] is True


def test_keycloak_referenced_override_and_user_profile_must_be_backed_up(tmp_path):
    files = keycloak_fixture_files(tmp_path)
    state = {'docker-compose.yml': b'services: {keycloak: {image: fixture}}\n',
             'ava-realm.json': b'{"realm":"ava"}\n', '.env': b'present\n',
             'user-profile.json': b'present\n'}
    files['./source/keycloak-state.tar'] = tar_bytes(state, compressed=False)
    with pytest.raises(ValueError, match='KEYCLOAK_COMPOSE_INPUT_MISSING'):
        validator.verify(archive(files))

    files = keycloak_fixture_files(tmp_path)
    state = {'docker-compose.yml': b'services: {keycloak: {volumes: [./user-profile.json:/x]}}\n',
             'ava-realm.json': b'{"realm":"ava"}\n', '.env': b'present\n',
             'pilot-network.override.yml': b'present\n', 'web.env': b'present\n',
             'worker.env': b'present\n'}
    files['./source/keycloak-state.tar'] = tar_bytes(state, compressed=False)
    with pytest.raises(ValueError, match='KEYCLOAK_CONFIG_INPUT_MISSING'):
        validator.verify(archive(files))


def test_keycloak_dump_cannot_be_smuggled_into_legacy_manifest(tmp_path):
    files = fixture_files(tmp_path)
    files['./postgres/identity--ava_identity.dump'] = b'PGDMP-keycloak-fixture-not-restorable'
    with pytest.raises(ValueError, match='UNDECLARED_KEYCLOAK_BACKUP'):
        validator.verify(archive(files))


def test_rejects_missing_live_database_even_with_valid_checksums(tmp_path):
    files = fixture_files(tmp_path)
    del files['./postgres/onyx--postgres.dump']
    files['./postgres/onyx--onyx.dump'] = b'PGDMP-empty-wrong-database'
    with pytest.raises(ValueError):
        validator.verify(archive(files))


def test_rejects_empty_live_database_and_inventory_mismatch(tmp_path):
    files = fixture_files(tmp_path)
    files['./manifests/onyx--postgres-table-count.txt'] = b'0\n'
    with pytest.raises(ValueError, match='LIVE_DATABASE_CONTENT_MISSING'):
        validator.verify(archive(files))
    files['./manifests/onyx--postgres-table-count.txt'] = b'1\n'
    files['./manifests/postgres-databases.tsv'] = b'onyx\tpostgres\tonyx--postgres.dump\n'
    with pytest.raises(ValueError, match='LIVE_DATABASE_CONTENT_MISSING'):
        validator.verify(archive(files))


def test_rejects_checksum_mismatch(tmp_path):
    with pytest.raises(ValueError, match='CHECKSUM_MISMATCH'):
        validator.verify(archive(fixture_files(tmp_path), wrong_checksum=True))


def test_rejects_corrupt_sqlite(tmp_path):
    files = fixture_files(tmp_path)
    files['./sqlite/crm_v2.db'] = b'not-a-database'
    with pytest.raises(sqlite3.DatabaseError):
        validator.verify(archive(files))


@pytest.mark.parametrize('runtime', ['data', 'asterisk_media'])
def test_versioned_release_requires_shared_runtime_archive(tmp_path, runtime):
    files = fixture_files(tmp_path)
    source = io.BytesIO(files['./source/live-tree.tar'])
    with tarfile.open(fileobj=source, mode='a') as bundle:
        link = tarfile.TarInfo('./' + runtime)
        link.type = tarfile.SYMTYPE
        link.linkname = '/root/ava-releases/previous/' + runtime
        bundle.addfile(link)
    files['./source/live-tree.tar'] = source.getvalue()
    with pytest.raises(ValueError, match='SHARED_RUNTIME_BACKUP_MISSING'):
        validator.verify(archive(files))
    files[f'./source/runtime-{runtime}.tar'] = tar_bytes({'./example.txt': b'preserved'}, compressed=False)
    assert validator.verify(archive(files))['sqlite_quick_check'] == 'ok'
