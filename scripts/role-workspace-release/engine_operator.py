#!/usr/bin/env python3
"""Optional engine overlay; reuse idle, runtime, backup and rollback controls."""
import argparse
import fcntl
import json
import os
import posixpath
from pathlib import Path
import re
import shutil
import time

from shared import BASE, reviewed
from engine_database import assert_migration, snapshot

voice = reviewed('voice_operator')
core = voice.core
require = core.require
original_check = voice.check


def check(row, before, manifest, rollback=False):
    original_check(row, before, manifest, rollback)
    require(row.get('RestartCount') == 0, 'ENGINE_RESTARTED')


voice.check = check


def validate(root, digest, candidate):
    path = root / 'manifest.json'
    require(core.sha(path) == digest, 'ENGINE_MANIFEST_DRIFT')
    m = json.loads(path.read_text())
    require(m.get('releaseKind') == 'role-workspace-engine' and m.get('baseCommit') == BASE
            and m.get('candidateCommit') == candidate and re.fullmatch('[0-9a-f]{40}', candidate), 'ENGINE_SOURCE_INVALID')
    require(re.fullmatch('sha256:[0-9a-f]{64}', m.get('baseImage', '')) and m.get('files')
            and set(m['files']) == set(m.get('baseFiles', {})) == set(m.get('baseFileCommits', {})), 'ENGINE_MANIFEST_INVALID')
    for name, wanted in m['files'].items():
        require(re.fullmatch(r'src/[a-zA-Z0-9_./-]+\.py', name) and '..' not in name.split('/'), 'ENGINE_PATH_INVALID')
        path = root / 'payload' / name
        require(path.is_file() and not path.is_symlink() and core.sha(path) == wanted, 'ENGINE_PAYLOAD_DRIFT')
        require(m['baseFiles'][name] is None or re.fullmatch('[0-9a-f]{64}', m['baseFiles'][name]), 'ENGINE_BASE_DIGEST_INVALID')
        require(re.fullmatch('[0-9a-f]{40}', m['baseFileCommits'][name]), 'ENGINE_PROVENANCE_INVALID')
    return m


def image_hashes(image):
    script = 'import pathlib,hashlib,json; print(json.dumps({str(p.relative_to("/app")):hashlib.sha256(p.read_bytes()).hexdigest() for p in pathlib.Path("/app/src").rglob("*.py")}))'
    return json.loads(core.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'python', image, '-c', script]))


def migrate(image, path):
    script = 'from src.core.post_call_delivery import PostCallDeliveryStore; import json; PostCallDeliveryStore("/check/' + path.name + '"); print(json.dumps({"schemaVerified":True}))'
    output = core.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
        '--entrypoint', 'python', '--mount', f'type=bind,source={path.parent},target=/check', image, '-c', script])
    require(json.loads(output).get('schemaVerified') is True, 'ENGINE_MIGRATION_FAILED')


def migration_gate(state_root, state, backup):
    clone = state_root / ('outbox-clone-' + str(time.time_ns()) + '.db')
    shutil.copyfile(backup['path'], clone)
    before = snapshot(clone)
    migrate(state['manifest']['candidateImage'], clone)
    after = snapshot(clone)
    projection = {name: [row[1] for row in rows] for name, rows in before['columns'].items()}
    assert_migration(before, after, snapshot(clone, projection))
    migrate(state['manifest']['candidateImage'], clone)
    require(snapshot(clone) == after, 'ENGINE_MIGRATION_NOT_IDEMPOTENT')
    migrate(state['before']['Image'], clone)
    require(snapshot(clone) == after, 'ENGINE_ROLLBACK_DB_INCOMPATIBLE')
    gate = {'schemaVerified': True, 'originalRowsPreserved': True, 'idempotent': True,
            'rollbackCompatible': True, 'backupSha256': backup['sha256']}
    core.private_json(state_root / 'migration-gate.json', gate)
    return gate


def prepare(root, m):
    require(not (root / 'operator-state').exists(), 'ALREADY_PREPARED')
    voice.idle()
    before = core.inspect('ai_engine')
    require(before['Image'] == m['baseImage'], 'ENGINE_BASE_CHANGED')
    old = voice.source_hashes()
    require(all(old.get(name) == value for name, value in m['baseFiles'].items()), 'ENGINE_SOURCE_DRIFT')
    require(image_hashes(m['baseImage']) == old, 'ENGINE_LIVE_IMAGE_SOURCE_DRIFT')
    tag = 'ava-role-engine-base:' + m['baseImage'].removeprefix('sha256:')
    core.run(['docker', 'tag', m['baseImage'], tag])
    require(core.inspect(tag)['Id'] == m['baseImage'], 'ENGINE_BASE_TAG_DRIFT')
    pinned = json.loads(core.run(['docker', 'image', 'inspect', m['baseImage']]))[0]
    user = pinned['Config'].get('User') or '0'
    require(re.fullmatch(r'[a-zA-Z0-9_.:-]+', user), 'ENGINE_USER_INVALID')
    for path in (root / 'payload').rglob('*'):
        require(not path.is_symlink(), 'ENGINE_CONTEXT_LINK')
        path.chmod(0o755 if path.is_dir() else 0o644)
    (root / 'payload').chmod(0o755)
    recipe = 'FROM ' + tag + '\nUSER 0:0\nCOPY --chown=0:0 payload/ /app/\n'
    recipe += 'RUN ["python","-c","import pathlib; [p.chmod(0o755) for p in pathlib.Path(\'/app/src\').rglob(\'*\') if p.is_dir()]; pathlib.Path(\'/app/src\').chmod(0o755)"]\n'
    recipe += 'USER ' + user + '\n'
    (root / 'Dockerfile').write_text(recipe)
    (root / '.dockerignore').write_text('*\n!Dockerfile\n!payload\n!payload/**\n')
    candidate_tag = 'ava-role-engine:' + m['candidateCommit'][:12]
    core.run(['docker', 'build', '--pull=false', '--network', 'none', '-t', candidate_tag, str(root)], timeout=900)
    row = json.loads(core.run(['docker', 'image', 'inspect', candidate_tag]))[0]
    require(core.inspect(tag)['Id'] == m['baseImage'], 'ENGINE_BASE_TAG_DRIFT')
    require(row['Config'] == pinned['Config'], 'ENGINE_IMAGE_CONFIG_CHANGED')
    layers = pinned['RootFS']['Layers']
    require(row['RootFS']['Layers'][:len(layers)] == layers, 'ENGINE_PARENT_LAYERS_CHANGED')
    require(image_hashes(row['Id']) == {**old, **m['files']}, 'ENGINE_CANDIDATE_SOURCE_DRIFT')
    access = 'import pathlib,json; files=' + repr(list(m['files'])) + '; [compile(pathlib.Path("/app",p).read_bytes(),p,"exec") for p in files]; print(json.dumps({"sourceReadable":True}))'
    output = core.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', before['Config']['User'],
                       '--entrypoint', 'python', row['Id'], '-c', access])
    require(json.loads(output).get('sourceReadable') is True, 'ENGINE_RUNTIME_ACCESS_DENIED')
    # Existing voice operator state lives separately from the input bundle.
    staged = {**m, 'candidateImage': row['Id']}
    state_root = root / 'operator-state'
    state_root.mkdir(mode=0o700)
    core.private_json(state_root / 'manifest.json', staged)
    voice.prepare(state_root)
    state = json.loads((state_root / 'prepared.private.json').read_text())
    env = core.envmap(before)
    # Production uses data/call_history.db with WorkingDir=/app. Resolve it
    # exactly as the runtime does; accept only the same reviewed mounted file.
    runtime_path = env.get('POST_CALL_OUTBOX_DB_PATH') or env.get('CALL_HISTORY_DB_PATH', '/app/data/call_history.db')
    resolved = posixpath.normpath(posixpath.join(before['Config']['WorkingDir'], runtime_path))
    require(resolved == '/app/data/call_history.db', 'ENGINE_OUTBOX_PATH_UNREVIEWED')
    outbox = Path('/root/ava-releases/reviewed-20260915T104238Z/data/call_history.db')
    state['outboxIdentity'] = [outbox.stat().st_dev, outbox.stat().st_ino]
    core.private_json(state_root / 'prepared.private.json', state)
    migration_gate(state_root, state, next(item for item in state['backups'] if item['path'].endswith('calls-backup.db')))


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['prepare', 'verify', 'apply', 'rollback'])
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--manifest-sha256', required=True)
    p.add_argument('--candidate-commit', required=True)
    args = p.parse_args()
    core.LOG_ROOT = args.root
    try:
        m = validate(args.root, args.manifest_sha256, args.candidate_commit)
        with (args.root / 'operator.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.action == 'prepare':
                prepare(args.root, m)
            else:
                state_root = args.root / 'operator-state'
                state = json.loads((state_root / 'prepared.private.json').read_text())
                require({k: v for k, v in state['manifest'].items() if k != 'candidateImage'} == m, 'ENGINE_PREPARED_MANIFEST_DRIFT')
                outbox = Path('/root/ava-releases/reviewed-20260915T104238Z/data/call_history.db')
                require([outbox.stat().st_dev, outbox.stat().st_ino] == state['outboxIdentity'], 'ENGINE_OUTBOX_IDENTITY_DRIFT')
                if args.action == 'verify':
                    voice.shared(state)
                    deployed = core.inspect('ai_engine')['Image'] == state['manifest']['candidateImage']
                    check(core.inspect('ai_engine'), state['before'], state['manifest'], rollback=not deployed)
                    voice.idle()
                    require(voice.source_hashes() == ({**state['sourceHashes'], **m['files']} if deployed else state['sourceHashes']), 'ENGINE_SOURCE_DRIFT')
                    print(json.dumps({'phase': 'verified', 'deployed': deployed, 'idle': True}))
                else:
                    if args.action == 'apply':
                        current = core.inspect('ai_engine')
                        require(current['Id'] == state['before']['Id'] and current['Image'] == m['baseImage'], 'ENGINE_CHANGED')
                        voice.shared(state)
                        voice.idle()
                        fresh = {}
                        for name, path in [('crm', '/root/ava-current/data/whatsapp_crm/crm_v2.db'),
                                           ('calls', '/root/ava-releases/reviewed-20260915T104238Z/data/call_history.db')]:
                            fresh[name] = core.backup(path, state_root / (name + '-apply-' + str(time.time_ns()) + '.db'))
                        migration_gate(state_root, state, fresh['calls'])
                        voice.shared(state)
                        voice.idle()
                        try:
                            calls = Path('/root/ava-releases/reviewed-20260915T104238Z/data/call_history.db')
                            stat = calls.stat()
                            migrate(state['manifest']['candidateImage'], calls)
                            require((calls.stat().st_uid, calls.stat().st_gid, calls.stat().st_mode) == (stat.st_uid, stat.st_gid, stat.st_mode), 'ENGINE_DATABASE_METADATA_CHANGED')
                            voice.up(state_root, state)
                        except Exception:
                            voice.up(state_root, state, rollback=True)
                            raise
                    else:
                        backup = core.backup(outbox, state_root / ('calls-rollback-' + str(time.time_ns()) + '.db'))
                        migration_gate(state_root, state, backup)
                        voice.up(state_root, state, rollback=True)
    except Exception as error:
        code = str(error)
        print(json.dumps({'phase': 'failed', 'reason': code if re.fullmatch('[A-Z0-9_]+', code) else 'ENGINE_OPERATOR_FAILED'}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
