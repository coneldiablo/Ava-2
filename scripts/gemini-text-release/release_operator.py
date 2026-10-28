#!/usr/bin/env python3
"""Guarded CRM/worker Gemini text release; the running voice engine is retained."""
import argparse
import copy
from contextlib import closing
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import time
from urllib.request import urlopen

# Import reviewed helpers as a normal module. The deployment copies this exact
# audited file beside the adapter; local checkout uses its repository location.
CORE_HASH = '1f8e0e2845d15bd504f4d33550545b9734b0bd83361f57d3ec8d2568d375015d'
CORE_PATH = Path(__file__).with_name('neuro_release_operator.py')
if not CORE_PATH.is_file():
    CORE_PATH = Path(__file__).parents[1] / 'neuro-gemini-release/release_operator.py'
import hashlib
if hashlib.sha256(CORE_PATH.read_bytes()).hexdigest() != CORE_HASH:
    raise RuntimeError('SHARED_OPERATOR_HASH_MISMATCH')
spec = importlib.util.spec_from_file_location('gemini_text_reviewed_core', CORE_PATH)
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
require, sha, private_json, private_env = core.require, core.sha, core.private_json, core.private_env
backup, envmap, mount_signature = core.backup, core.envmap, core.mount_signature
run, inspect, rendered, compose = core.run, core.inspect, core.rendered, core.compose
OPERATOR_PATH = Path(__file__).resolve()
NAMES = {'crm': 'whatsapp_crm', 'worker': 'asterisk-ai-voice-agent-provisioning_worker-1'}
ENGINE = 'ai_engine'
BASE_COMMIT = 'fceb3df6d9b834b5b4a76722aea0bdc2c42e6a41'
ADC = Path('/root/ava-private/neuro-gemini-20261014/vertex-adc.json')
ADC_TARGET = '/run/secrets/ava-vertex-adc.json'
PROJECT = 'project-70a86530-dd7e-4201-b95'
FLAG, ADMISSION = 'GEMINI_TEXT_ENABLED', 'GEMINI_TEXT_ADMISSION_ENABLED'


def load(root):
    return json.loads((root / 'prepared.private.json').read_text())


def other_containers():
    ids = run(['docker', 'ps', '-aq']).split()
    rows = json.loads(run(['docker', 'inspect', *ids])) if ids else []
    return {r['Name'].lstrip('/'): [r['Id'], r['Image'], r['State']['Running'],
            bool(r['State'].get('Paused')), r.get('RestartCount', 0)]
            for r in rows if r['Name'].lstrip('/') not in NAMES.values()}


def engine_ready():
    with urlopen('http://127.0.0.1:15000/health', timeout=10) as response:
        health = json.load(response)
    require(health.get('status') == 'healthy' and health.get('ari_connected') is True
            and health.get('audiosocket', {}).get('listening') is True
            and health.get('providers', {}).get('neuro_gemini', {}).get('ready') is True, 'VOICE_ENGINE_NOT_READY')
    return True


def guard_shared(p):
    require(p.get('operatorHash') == sha(OPERATOR_PATH), 'OPERATOR_FILE_DRIFT')
    require(all(sha(path) == value for path, value in p['inputs'].items()), 'COMPOSE_INPUT_DRIFT')
    require(other_containers() == p['otherContainers'], 'UNRELATED_CONTAINER_DRIFT')
    require(sha(p['engineConfig']) == p['engineConfigHash'], 'ENGINE_CONFIG_DRIFT')
    engine = inspect(ENGINE)
    for field in ('Config', 'HostConfig'):
        require(engine[field] == p['engineBefore'][field], 'VOICE_ENGINE_RUNTIME_DRIFT')
    require(mount_signature(engine['Mounts'], live=True) == mount_signature(p['engineBefore']['Mounts'], live=True)
            and set(engine['NetworkSettings']['Networks']) == set(p['engineBefore']['NetworkSettings']['Networks']), 'VOICE_ENGINE_RUNTIME_DRIFT')
    require(sha(ADC) == p['adcHash'], 'ADC_FILE_DRIFT')
    require(sha(CORE_PATH) == p['coreHash'], 'SHARED_OPERATOR_HASH_MISMATCH')


def text_restart_ready(p):
    # CRM/worker do not own active call media or Stasis sessions. Require the
    # unchanged, healthy voice engine, without claiming that calls are idle.
    guard_shared(p)
    engine_ready()


def guard_original(p):
    guard_shared(p)
    for role, name in NAMES.items():
        row, before = inspect(name), p['before'][role]
        require(row['Id'] == before['Id'] and row['Image'] == before['Image'], 'LIVE_CONTAINER_DRIFT')
        require(row['State']['Running'] and not row['State'].get('Paused')
                and row.get('RestartCount') == before.get('RestartCount'), 'LIVE_SERVICE_STATE_DRIFT')


def override_value(p, role, intent):
    service = p['before'][role]['Config']['Labels']['com.docker.compose.service']
    block = {key: copy.deepcopy(intent[key]) for key in ('image', 'environment', 'volumes')}
    block['environment'] = {key: value.replace('$', '$$') if isinstance(value, str) else value
                            for key, value in block['environment'].items()}
    return {'services': {service: block}}


def prepare(root):
    require(not (root / 'prepared.private.json').exists(), 'ALREADY_PREPARED')
    manifest = json.loads((root / 'bundle/manifest.json').read_text())
    images = json.loads((root / 'images.json').read_text())
    require(manifest.get('baseCommit') in (BASE_COMMIT, '78fa4f5de4a34fc95e70ce2c8d6db637a5071b65'), 'BASE_SOURCE_MISMATCH')
    require(re.fullmatch('[0-9a-f]{40}', manifest.get('candidateCommit', '')), 'CANDIDATE_SOURCE_INVALID')
    require(set(images) == set(NAMES), 'IMAGE_SERVICE_SET_INVALID')
    before = {role: inspect(name) for role, name in NAMES.items()}
    inputs = {}
    for role, row in before.items():
        require(row['Image'] == manifest['services'][role]['baseImage'] and row['State']['Running']
                and not row['State'].get('Paused'), 'BASE_CONTAINER_CHANGED')
        require(re.fullmatch('sha256:[0-9a-f]{64}', images[role]), 'PINNED_IMAGE_REQUIRED')
        labels = row['Config']['Labels']
        for key in ('com.docker.compose.project.config_files', 'com.docker.compose.project.environment_file'):
            for value in labels.get(key, '').split(','):
                if value:
                    path = Path(value)
                    require(not path.resolve().is_relative_to(root.resolve()), 'COMPOSE_INPUT_IN_NEW_RELEASE_ROOT')
                    inputs[value] = sha(path)
    engine = inspect(ENGINE)
    require(engine['State']['Running'] and not engine['State'].get('Paused')
            and envmap(engine).get('NEURO_GEMINI_ENABLED') == 'true', 'VOICE_ENGINE_BASELINE_INVALID')
    config_mount = next(m for m in engine['Mounts'] if m['Destination'] == '/app/config')
    engine_config = Path(config_mount['Source']) / 'ai-agent.yaml'
    engine_ready()
    require(ADC.is_file() and not ADC.is_symlink(), 'ADC_FILE_INVALID')
    require(ADC.stat().st_uid == 1000 and ADC.stat().st_mode & 0o777 == 0o400, 'ADC_FILE_PERMISSIONS_INVALID')
    owned = ['prepare-crm.db', 'crm-before.env', 'worker-before.env',
             *[f'{role}.{kind}.private.json' for role in NAMES for kind in ('candidate', 'active', 'recovery', 'rollback')]]
    if any((root / name).exists() for name in owned):
        attempt = root / ('prepare-attempt-' + str(time.time_ns()))
        attempt.mkdir(mode=0o700)
        for name in owned:
            if (root / name).exists():
                (root / name).rename(attempt / name)
    crm_mount = next(m for m in before['crm']['Mounts'] if m['Destination'] == '/app/data')
    worker_mount = next(m for m in before['worker']['Mounts'] if m['Destination'] == '/app/data')
    database = Path(crm_mount['Source']) / 'crm_v2.db'
    require(database.resolve() == (Path(worker_mount['Source']) / 'crm_v2.db').resolve(), 'CRM_WORKER_DATABASE_SPLIT')
    require(len({envmap(row).get(FLAG) for row in before.values()}) == 1, 'MIXED_GEMINI_RUNTIME_BASELINE')
    base_runtime = all(envmap(row).get(FLAG) == 'true' for row in before.values())
    require(not base_runtime or manifest['baseCommit'] == '78fa4f5de4a34fc95e70ce2c8d6db637a5071b65', 'UNREVIEWED_GEMINI_RUNTIME_BASELINE')
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        require(db.execute("SELECT COUNT(*) FROM instances WHERE aiProvider='gemini'").fetchone()[0] == 0 or base_runtime,
                'EXISTING_GEMINI_SELECTION_REQUIRES_COMPATIBLE_STAGE')
    p = {'sourceCommit': manifest['candidateCommit'], 'baseCommit': manifest['baseCommit'], 'baseGeminiRuntime': base_runtime, 'before': before, 'images': images,
         'inputs': inputs, 'otherContainers': other_containers(), 'engineConfig': str(engine_config),
         'engineConfigHash': sha(engine_config), 'engineId': engine['Id'], 'engineImage': engine['Image'], 'engineBefore': engine,
         'adcHash': sha(ADC), 'coreHash': CORE_HASH, 'operatorHash': sha(OPERATOR_PATH), 'database': str(database),
         'prepareBackup': backup(database, root / 'prepare-crm.db'),
         'intended': {}, 'activationIntended': {}, 'recoveryIntended': {},
         'overrides': {}, 'activationOverrides': {}, 'recoveryOverrides': {}}
    stat = database.stat()
    p['databaseMetadata'] = [stat.st_uid, stat.st_gid, stat.st_mode & 0o777]
    for role, row in before.items():
        actual = envmap(row)
        private_env(root / (role + '-before.env'), actual)
        baseline = rendered(row)
        require(mount_signature(baseline.get('volumes', [])) == mount_signature(row['Mounts'], live=True), 'LIVE_COMPOSE_MOUNT_DRIFT')
        require(set(baseline.get('environment', {})) <= set(actual), 'ENV_DRIFT_ON_DISK')
        extra = {'GOOGLE_APPLICATION_CREDENTIALS': ADC_TARGET, 'GEMINI_PROJECT_ID': PROJECT,
                 'GOOGLE_CLOUD_PROJECT': PROJECT, 'GEMINI_LOCATION': 'global', 'GOOGLE_CLOUD_LOCATION': 'global',
                 'GEMINI_TEXT_MODEL': 'gemini-3.8-flash', FLAG: 'true', ADMISSION: 'true'}
        target = copy.deepcopy(baseline)
        target.update(image=images[role], environment={**actual, **extra})
        volumes = list(baseline.get('volumes', []))
        addition = {'type': 'bind', 'source': str(ADC), 'target': ADC_TARGET, 'read_only': True}
        existing = [v for v in volumes if v.get('target') == ADC_TARGET]
        if existing:
            require(mount_signature(existing) == mount_signature([addition]), 'ADC_MOUNT_CONFLICT')
        else:
            volumes.append(addition)
        target['volumes'] = volumes
        for kind, key, mapping, enabled, admitted in (
                ('active', 'activationIntended', 'activationOverrides', 'true', 'true'),
                ('candidate', 'intended', 'overrides', 'true' if base_runtime else 'false', 'false'),
                ('recovery', 'recoveryIntended', 'recoveryOverrides', 'true', 'false')):
            intent = copy.deepcopy(target)
            intent['environment'].update({FLAG: enabled, ADMISSION: admitted})
            path = root / f'{role}.{kind}.private.json'
            private_json(path, override_value(p, role, intent))
            value = rendered(row, path)
            require(value.get('image') == intent['image'] and value.get('environment') == intent['environment'], 'CANDIDATE_RENDER_DRIFT')
            for field in set(value) | set(baseline):
                if field not in ('image', 'environment', 'volumes'):
                    require(value.get(field) == baseline.get(field), 'UNRELATED_COMPOSE_CHANGE')
            require(mount_signature(value.get('volumes', [])) == mount_signature(volumes), 'UNRELATED_VOLUME_CHANGE')
            p[key][role], p[mapping][role] = value, str(path)
        service = row['Config']['Labels']['com.docker.compose.service']
        private_json(root / (role + '.rollback.private.json'), {'services': {service: {
            'image': row['Image'], 'environment': {k: v.replace('$', '$$') for k, v in actual.items()}, 'volumes': []}}})
    guard_original(p)
    private_json(root / 'prepared.private.json', p)
    print(json.dumps({'phase': 'prepared', 'sourceCommit': p['sourceCommit'], 'services': list(NAMES),
                      'enginePreserved': True, 'backup': p['prepareBackup']}), flush=True)


def check_container(p, role, rollback=False, active=False, recovery=False, allow_unhealthy=False):
    row, before = inspect(NAMES[role]), p['before'][role]
    require(row['Image'] == (before['Image'] if rollback else p['images'][role]), 'INSTALLED_IMAGE_NOT_RUNNING')
    if not allow_unhealthy:
        require(row['State']['Running'] and not row['State'].get('Paused'), 'INSTALLED_IMAGE_NOT_RUNNING')
        require(row.get('RestartCount') == 0, 'SERVICE_RESTARTED')
    intent = p['recoveryIntended' if recovery else 'activationIntended' if active else 'intended'][role]
    require(envmap(row) == (envmap(before) if rollback else intent['environment']), 'INSTALLED_ENV_MISMATCH')
    expected_mounts = mount_signature(before['Mounts'], live=True) if rollback else mount_signature(intent['volumes'])
    require(mount_signature(row['Mounts'], live=True) == expected_mounts, 'INSTALLED_MOUNT_MISMATCH')
    require(set(row['NetworkSettings']['Networks']) == set(before['NetworkSettings']['Networks']), 'NETWORK_CHANGED')
    for key in ('PortBindings', 'RestartPolicy', 'LogConfig', 'Privileged', 'CapAdd', 'CapDrop', 'SecurityOpt', 'Devices', 'NetworkMode', 'Tmpfs'):
        require(row['HostConfig'].get(key) == before['HostConfig'].get(key), 'HOST_CONFIG_CHANGED')
    for key in ('User', 'Entrypoint', 'Cmd', 'WorkingDir'):
        require(row['Config'].get(key) == before['Config'].get(key), 'PROCESS_CONFIG_CHANGED')
    if role == 'crm' and not allow_unhealthy:
        require(row['State'].get('Health', {}).get('Status') == 'healthy', 'CRM_NOT_HEALTHY')
    return row


def up(p, role, override, rollback=False, active=False, recovery=False):
    require(role in NAMES, 'UNREVIEWED_SERVICE')
    guard_shared(p)
    value = rendered(p['before'][role], override)
    if rollback:
        require(value['image'] == p['before'][role]['Image'] and value['environment'] == envmap(p['before'][role]), 'ROLLBACK_RENDER_DRIFT')
        require(mount_signature(value.get('volumes', [])) == mount_signature(p['before'][role]['Mounts'], live=True), 'ROLLBACK_MOUNT_DRIFT')
    else:
        require(value == p['recoveryIntended' if recovery else 'activationIntended' if active else 'intended'][role], 'CANDIDATE_RENDER_DRIFT')
    text_restart_ready(p)
    command, cwd, service = compose(p['before'][role], override)
    run(command + ['up', '-d', '--no-deps', '--pull', 'never', '--force-recreate', service], cwd=cwd, timeout=180)
    deadline = time.monotonic() + 100
    while time.monotonic() < deadline:
        row = inspect(NAMES[role])
        require(row.get('RestartCount') == 0, 'SERVICE_RESTARTED')
        if row['State']['Running'] and not row['State'].get('Paused') and (role != 'crm' or row['State'].get('Health', {}).get('Status') == 'healthy'):
            time.sleep(2)
            check_container(p, role, rollback=rollback, active=active, recovery=recovery)
            guard_shared(p)
            return
        time.sleep(2)
    raise RuntimeError('SERVICE_HEALTH_TIMEOUT')


def migrate_live(root, p):
    probe = root / 'tooling/migration_probe.cjs'
    gate = json.loads((root / 'migration-gate.json').read_text())
    require(probe.is_file() and sha(probe) == gate['probeSHA256'], 'MIGRATION_PROBE_DRIFT')
    source = Path(p['database'])
    output = run(['docker', 'run', '--rm', '--network', 'none', '--user', '1000:986', '--env-file', str(root / 'crm-before.env'),
                  '-e', 'DB_PATH=/verify/' + source.name, '-e', 'AVA_APP_ROOT=/app', '-e', 'AVA_PROCESS_ROLE=provisioning-worker',
                  '--mount', f'type=bind,src={source.parent},dst=/verify',
                  '--mount', f'type=bind,src={probe},dst=/release/migration_probe.cjs,readonly',
                  '--entrypoint', 'node', p['images']['crm'], '/release/migration_probe.cjs', 'apply'], timeout=120)
    value = json.loads(output)
    require(value.get('ok') is True and value.get('mode') == 'apply' and value.get('initVerified') is True
            and value.get('voiceColumnsVerified') is True and value.get('textColumnsVerified') is True
            and value.get('sourceReadableVerified') is True and value.get('exactDataFence') is False, 'LIVE_MIGRATION_FAILED')
    require(sha(probe) == gate['probeSHA256'], 'MIGRATION_PROBE_DRIFT')
    stat = source.stat()
    require([stat.st_uid, stat.st_gid, stat.st_mode & 0o777] == p['databaseMetadata'], 'DATABASE_OWNERSHIP_CHANGED')
    private_json(root / 'migration-live.private.json', value)


def verify(root, rollback=False, active=False, recovery=False):
    p = load(root)
    guard_shared(p)
    rows = {role: check_container(p, role, rollback=rollback, active=active, recovery=recovery) for role in NAMES}
    engine_ready()
    return {'sourceCommit': p['sourceCommit'], 'images': {role: row['Image'] for role, row in rows.items()},
            'engineId': p['engineId'], 'engineImage': p['engineImage'], 'enginePreserved': True,
            'engineHealthy': True, 'neuroReady': True, 'restartGate': 'unchanged_voice_engine_ready', 'newSelectionEnabled': active and not rollback,
            'existingGeminiEnabled': all(envmap(row).get(FLAG) == 'true' for row in rows.values()), 'databaseRetained': True}


def rollback(root, automatic=False):
    p = load(root)
    require(not (root / 'activation-started.private.json').exists() and not (root / 'activated.private.json').exists(),
            'ACTIVATED_RELEASE_REQUIRES_COMPATIBILITY_RECOVERY')
    guard_shared(p)
    text_restart_ready(p)
    for role in NAMES:
        row = inspect(NAMES[role])
        if row['Image'] == p['images'][role]:
            check_container(p, role, allow_unhealthy=True)
            require(envmap(row).get(FLAG) == ('true' if p.get('baseGeminiRuntime') else 'false') and envmap(row).get(ADMISSION) == 'false', 'ROLLBACK_ADMISSION_NOT_CLOSED')
        else:
            require(row['Image'] == p['before'][role]['Image'], 'ROLLBACK_IMAGE_DRIFT')
    with closing(sqlite3.connect(Path(p['database']).resolve().as_uri() + '?mode=ro', uri=True)) as db:
        require(db.execute("SELECT COUNT(*) FROM instances WHERE aiProvider='gemini'").fetchone()[0] == 0 or p.get('baseGeminiRuntime') is True,
                'NEW_TEXT_SELECTIONS_REQUIRE_COMPATIBILITY_RECOVERY')
    for role in ('worker', 'crm'):
        up(p, role, root / (role + '.rollback.private.json'), rollback=True)
    receipt = verify(root, rollback=True)
    private_json(root / 'rollback.private.json', receipt)
    print(json.dumps({'phase': 'rolled_back', 'automatic': automatic, **receipt}), flush=True)


def apply(root):
    p = load(root)
    require(not (root / 'apply-started.private.json').exists(), 'APPLY_ALREADY_STARTED')
    guard_original(p)
    gate = json.loads((root / 'migration-gate.json').read_text())
    require(gate.get('pass') is True and gate.get('sourceCommit') == p['sourceCommit']
            and gate.get('candidateImage') == p['images']['crm'] and gate.get('oldImage') == p['before']['crm']['Image']
            and gate.get('backupSHA256') == p['prepareBackup']['sha256']
            and gate.get('probeSHA256') == sha(root / 'tooling/migration_probe.cjs'), 'DATABASE_COPY_GATE_MISSING')
    smoke = json.loads((root / 'provider-smoke.json').read_text())
    require(smoke.get('pass') is True and smoke.get('image') == p['images']['crm']
            and smoke.get('sourceCommit') == p['sourceCommit'], 'PROVIDER_SMOKE_MISSING')
    text_restart_ready(p)
    fresh = backup(Path(p['database']), root / ('apply-crm-' + str(time.time_ns()) + '.db'))
    guard_original(p)
    private_json(root / 'apply-started.private.json', {'backup': fresh, 'sourceCommit': p['sourceCommit'], 'time': time.time()})
    try:
        migrate_live(root, p)
        for role in ('worker', 'crm'):
            up(p, role, p['overrides'][role])
        receipt = verify(root)
        private_json(root / 'applied.private.json', receipt)
        print(json.dumps({'phase': 'applied_admission_closed', 'backup': fresh, **receipt}), flush=True)
    except Exception as cause:
        code = str(cause)
        private_json(root / 'apply-failure.private.json', {'code': code if re.fullmatch('[A-Z_]+', code) else type(cause).__name__, 'sourceCommit': p['sourceCommit']})
        if (root / 'last-command.private.log').exists():
            shutil.copy2(root / 'last-command.private.log', root / 'apply-error.private.log')
        try:
            rollback(root, automatic=True)
        except Exception:
            private_json(root / 'recovery-required.private.json', {'sourceCommit': p['sourceCommit'], 'databaseRetained': True})
            raise RuntimeError('APPLY_FAILED_RECOVERY_REQUIRED_DATABASE_RETAINED') from None
        raise RuntimeError('APPLY_FAILED_ROLLED_BACK_DATABASE_RETAINED') from None


def close_admission(root, p):
    # Runtime stays available to saved Gemini businesses while owner writes of
    # new Gemini selections are closed by a separate server admission flag.
    guard_shared(p)
    for role in ('worker', 'crm'):
        up(p, role, p['recoveryOverrides'][role], recovery=True)
    receipt = verify(root, recovery=True)
    private_json(root / 'admission-recovered.private.json', receipt)
    return receipt


def recover(root):
    p = load(root)
    require((root / 'activation-started.private.json').exists(), 'NO_ACTIVATION_TO_RECOVER')
    receipt = close_admission(root, p)
    print(json.dumps({'phase': 'recovered_admission_closed', **receipt}), flush=True)


def activate(root):
    p = load(root)
    require((root / 'applied.private.json').is_file() and (not (root / 'activated.private.json').exists()
            or (root / 'admission-recovered.private.json').exists()), 'ACTIVATION_STATE_INVALID')
    if (root / 'activation-started.private.json').exists():
        close_admission(root, p)
    else:
        verify(root)
    text_restart_ready(p)
    private_json(root / 'activation-started.private.json', {'sourceCommit': p['sourceCommit'], 'time': time.time()})
    try:
        for role in ('worker', 'crm'):
            up(p, role, p['activationOverrides'][role], active=True)
        receipt = verify(root, active=True)
    except Exception:
        try:
            close_admission(root, p)
        except Exception:
            raise RuntimeError('ACTIVATION_INCOMPLETE_COMPATIBLE_RECOVERY_REQUIRED') from None
        raise RuntimeError('ACTIVATION_FAILED_ADMISSION_CLOSED_CANDIDATE_RETAINED') from None
    if (root / 'admission-recovered.private.json').exists():
        (root / 'admission-recovered.private.json').rename(root / ('admission-recovered-history-' + str(time.time_ns()) + '.private.json'))
    private_json(root / 'activated.private.json', receipt)
    print(json.dumps({'phase': 'activated', **receipt}), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'apply', 'activate', 'verify', 'rollback', 'recover'])
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    core.LOG_ROOT = args.root
    try:
        with (args.root / 'operator.lock').open('a') as operator_lock:
            try:
                fcntl.flock(operator_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('OPERATOR_ALREADY_RUNNING') from None
            if args.action == 'verify':
                recovering = (args.root / 'admission-recovered.private.json').exists()
                print(json.dumps(verify(args.root, active=(args.root / 'activated.private.json').exists() and not recovering, recovery=recovering)))
            else:
                globals()[args.action](args.root)
    except Exception as exc:
        code = str(exc)
        code = code if re.fullmatch('[A-Z_]+', code) else 'OPERATOR_FAILED_' + type(exc).__name__.upper()
        print(json.dumps({'phase': 'failed', 'code': code}), flush=True)
        raise SystemExit(1)
