#!/usr/bin/env python3
"""Role CRM/worker adapter over the pinned registration release operator."""
import argparse
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import time
from urllib.request import urlopen

from shared import BASE, COLUMN_MIGRATIONS, PRIVATE_RUNTIME, PRIVATE_VALIDATION_ALIAS, environment, modules, reviewed, schema, trigger_replacements
from crm_database import assert_migration

core = reviewed('registration_operator')
require = core.require
original_validate = core.validate_manifest


def validate_manifest(value, commit):
    require(value.get('releaseKind') == 'role-workspace' and value.get('baseCommit') == BASE
            and value.get('frontendExact') is True, 'ROLE_RELEASE_CONTRACT_INVALID')
    require(value.get('publicRoutes') == ['/', '/today', '/clients', '/team', '/login', '/register', '/forgot-password'], 'PUBLIC_ROUTES_CHANGED')
    settings = environment({name: block.get('environment', {}) for name, block in value['services'].items()})
    schema(value.get('allowedNewSchema'))
    modules(value.get('schemaModules'))
    require(value.get('allowedColumnMigrations') == COLUMN_MIGRATIONS, 'CRM_COLUMN_CONTRACT_INVALID')
    trigger_replacements(value.get('allowedTriggerReplacements'))
    require(value.get('frontendBaseFiles') and all(core.HEX.fullmatch(x or '') for x in value['frontendBaseFiles'].values()), 'FRONTEND_BASE_CONTRACT_REQUIRED')
    for name in value['frontendBaseFiles']:
        core.relative(name)
    # Reuse every source/provenance/runner rule. Only the reviewed route/env/
    # empty-schema variants are projected for the old registration validator.
    checked = copy.deepcopy(value)
    checked['publicRoutes'] = ['/login', '/register', '/forgot-password']
    checked['allowedNewSchema'] = checked['allowedNewSchema'] or [
        {'name': 'role_empty_contract', 'type': 'table', 'tbl_name': 'role_empty_contract', 'sqlHash': '0' * 64}]
    for name in checked['services']:
        checked['services'][name]['environment'] = {}
        block = checked['services'][name]
        if PRIVATE_RUNTIME in block.get('files', {}):
            # This is validation-only: actual manifest keys, hash fences and
            # contained payload paths remain instagram_private/server.js.
            require(all(PRIVATE_VALIDATION_ALIAS not in block.get(field, {})
                        for field in ('files', 'baseFiles', 'baseFileCommits')), 'PRIVATE_RUNTIME_ALIAS_COLLISION')
            for field in ('files', 'baseFiles', 'baseFileCommits'):
                require(PRIVATE_RUNTIME in block.get(field, {}), 'PRIVATE_RUNTIME_CONTRACT_MISSING')
                block[field][PRIVATE_VALIDATION_ALIAS] = block[field].pop(PRIVATE_RUNTIME)
    original_validate(checked, commit)
    require(all(value['services'][name].get('environment', {}) == settings[name] for name in settings), 'ENV_CONTRACT_INVALID')
    return value


def database_path(row):
    require(core.envmap(row).get('DB_PATH') == '/app/data/crm_v2.db', 'DB_PATH_CONTRACT_CHANGED')
    data = [m for m in row['Mounts'] if m['Destination'] == '/app/data']
    require(len(data) == 1 and data[0]['Type'] == 'bind' and data[0]['RW'], 'DB_BIND_CONTRACT_CHANGED')
    for mount in row['Mounts']:
        target = mount['Destination']
        if target == '/app' or target.startswith('/app/') and target != '/app/data':
            require(target == '/app/voice-config' and mount['Type'] == 'bind' and not mount['RW'], 'APP_SOURCE_MOUNT_FORBIDDEN')
    db = Path(data[0]['Source']) / 'crm_v2.db'
    require(db.is_file() and not db.is_symlink(), 'LIVE_DB_MISSING_OR_SYMLINK')
    return db.resolve()


core.validate_manifest = validate_manifest
core.database_path = database_path
# Mounted public voice configuration is fenced independently. Image/runtime
# comparisons otherwise cover all /app bytes, including dependency symlinks.
core.HASH_JS = core.HASH_JS.replace("if(rel==='data')continue;", "if(rel==='data'||rel==='voice-config')continue;")


def host_contract(row):
    value = copy.deepcopy(row)
    value['HostConfig']['Binds'] = sorted(value['HostConfig'].get('Binds') or [])
    return value


class Operator(core.Operator):
    def state(self, name, missing=False):
        value = super().state(name, missing)
        return None if value is None else host_contract(value)

    def keycloak_check(self, applied=False):
        return {'identitySettingsPreserved': True, 'identityMutation': False, 'mailSent': False}

    def no_redirect_recovery(self):
        return False

    def validate_feature_configuration(self, rows):
        # Identity flows already run in production. This release introduces no
        # identity env changes, no Keycloak plan and no new identity capability.
        require(core.envmap(rows['provisioning_worker']).get('AVA_PROCESS_ROLE') == 'provisioning-worker', 'WORKER_ROLE_CHANGED')
        require(core.envmap(rows[core.CRM]).get('AVA_CUSTOMER_ACCESS_ENABLED') == 'true', 'CRM_IDENTITY_CONFIGURATION_INVALID')

    def bind_files(self, rows):
        result = {}
        for row in rows.values():
            for mount in row['Mounts']:
                if mount['Destination'] not in ('/app/voice-config', '/run/secrets/ava-vertex-adc.json'):
                    continue
                root = Path(mount['Source'])
                require(not mount['RW'], 'CONFIG_BIND_NOT_READONLY')
                for path in ([root] if root.is_file() else sorted(root.rglob('*'))):
                    if path.is_file():
                        result[str(path)] = [core.sha(path), path.stat().st_uid, path.stat().st_gid, path.stat().st_mode & 0o777]
                    else:
                        require(path.is_dir(), 'CONFIG_BIND_SPECIAL_FILE')
        return result

    def engine_ready(self):
        with urlopen('http://127.0.0.1:15000/health', timeout=5) as response:
            value = json.load(response)
        require(value.get('status') == 'healthy' and value.get('ari_connected') is True
                and value.get('audiosocket', {}).get('listening') is True, 'VOICE_ENGINE_NOT_READY')

    def capture(self):
        p = super().capture()
        old = {name.removeprefix('frontend/dist/'): digest for name, digest in p['oldHashes'][core.CRM].items()
               if name.startswith('frontend/dist/')}
        require(old == self.m['frontendBaseFiles'], 'FRONTEND_BASE_DRIFT')
        p['preservedBindFiles'] = self.bind_files(p['before'])
        p['operatorSha256'] = core.sha(Path(__file__))
        self.engine_ready()
        return p

    def guard(self, p, images, extras=None, check_ready=True):
        rows = super().guard(p, images, extras, check_ready)
        require(core.sha(Path(__file__)) == p['operatorSha256'], 'OPERATOR_FILE_DRIFT')
        require(self.bind_files(rows) == p['preservedBindFiles'], 'CONFIG_BIND_DRIFT')
        for name, row in rows.items():
            for key in ('User', 'WorkingDir'):
                require(row['Config'].get(key) == p['before'][name]['Config'].get(key), 'RUNTIME_IDENTITY_CHANGED')
            require(set(row['NetworkSettings']['Networks']) == set(p['before'][name]['NetworkSettings']['Networks']), 'NETWORK_CHANGED')
        self.engine_ready()
        return rows

    def runner(self, image, db, field='migrationRunner', mode='migrate'):
        item = self.m[field]
        runner = core.contained(self.bundle, item['path'])
        require(core.sha(runner) == item['sha256'], 'RUNNER_CHANGED')
        output = self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--entrypoint', 'node',
            '--mount', f'type=bind,source={db.parent},target=/check',
            '--mount', f'type=bind,source={runner},target=/release/runner.cjs,readonly',
            '-e', 'DB_PATH=/check/' + db.name, '-e', 'AVA_RELEASE_OFFLINE=1',
            '-e', 'AVA_ROLE_SCHEMA_MODULES=' + json.dumps(self.m['schemaModules']),
            image, '/release/runner.cjs', mode], timeout=300)
        result = json.loads(output)
        require(result.get('contractVerified' if field == 'contractRunner' else 'schemaVerified') is True, 'RUNNER_RECEIPT_INVALID')
        return result

    def compatibility(self, image, db):
        result = self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
            '--entrypoint', 'node', '--mount', f'type=bind,source={db.parent},target=/check,readonly',
            '-e', 'DB_PATH=/check/' + db.name, image, '-e', core.COMPAT_JS], timeout=300)
        require(json.loads(result).get('compatibilityOk') is True, 'ROLLBACK_SQLITE_INCOMPATIBLE')

    def snapshot(self, image, db, projection=None):
        script = core.SNAPSHOT_JS.replace('const objects={},tables={};',
            'const objects={},tables={},columns={},tableSql={},columnNonNull={},projection=' + json.dumps(projection or {}) + ';')
        script = script.replace("if(r.type==='table'){", """if(r.type==='table'){
  const quote=s=>'"'+s.replace(/"/g,'""')+'"';
  columns[r.name]=db.prepare('PRAGMA table_info('+quote(r.name)+')').all().map(c=>[Number(c.cid),c.name,c.type,Number(c.notnull),c.dflt_value,Number(c.pk)]);
  tableSql[r.name]=r.sql;
  if(r.name==='ava_workspace_reply_actions'){
   columnNonNull[r.name]={};for(const key of ['text','dispatchStartedAt','dispatchCompletedAt','dispatchOwnerJson']){
    if(columns[r.name].some(c=>c[1]===key))columnNonNull[r.name][key]=Number(db.prepare('SELECT COUNT(*) AS n FROM '+quote(r.name)+' WHERE '+quote(key)+' IS NOT NULL').get().n);
   }
  }""")
        script = script.replace("'SELECT * FROM \"'+r.name.replace(/\"/g,'\"\"')+'\"'",
            "'SELECT '+(projection[r.name]?projection[r.name].map(quote).join(','):'*')+' FROM '+quote(r.name)")
        script = script.replace('JSON.stringify({objects,tables})', 'JSON.stringify({objects,tables,columns,tableSql,columnNonNull})')
        output = self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
            '--entrypoint', 'node', '--mount', f'type=bind,source={db.parent},target=/check,readonly',
            '-e', 'DB_PATH=/check/' + db.name, image, '-e', script], timeout=300)
        return json.loads(output)

    def migration_test(self, p, backup):
        directory = Path(backup['path']).parent / 'migration-check'
        directory.mkdir(mode=0o700)
        clone = directory / 'crm_v2.db'
        shutil.copyfile(backup['path'], clone)
        candidate = p['candidateImages'][core.CRM]
        before = self.snapshot(candidate, clone)
        self.runner(candidate, clone)
        after = self.snapshot(candidate, clone)
        projection = {name: [row[1] for row in columns] for name, columns in before['columns'].items()}
        assert_migration(before, after, self.snapshot(candidate, clone, projection), self.m['allowedNewSchema'],
                         core.assert_additive, self.m['allowedTriggerReplacements'])
        for name in core.SERVICES:
            self.runner(p['candidateImages'][name], clone)
            require(self.snapshot(candidate, clone) == after, 'MIGRATION_NOT_IDEMPOTENT')
            self.compatibility(p['baseImages'][name], clone)
            self.runner(p['candidateImages'][name], clone, 'contractRunner', 'smoke')
            require(self.snapshot(candidate, clone) == after, 'CONTRACT_SMOKE_CHANGED_CLONE')
        p['baseSchema'] = {'objects': before['objects'], 'columns': before['columns']}
        p['expectedSchema'] = {'objects': after['objects'], 'columns': after['columns']}
        return {'originalColumnsAndRowsUnchanged': True, 'reviewedNullableReplyColumns': True,
                'bothImagesIdempotent': True, 'bothRollbackImagesCompatible': True,
                'offlineContractBothImages': True, 'schemaHash': core.digest(after['objects'])}

    def verify_installed(self, p, rollback=False):
        receipt = super().verify_installed(p, rollback)
        script = r'''const SQLite=require('/app/node_modules/better-sqlite3'),c=require('crypto');
const db=new SQLite(process.env.DB_PATH,{readonly:true,fileMustExist:true});
require('/app/node_modules/sqlite-vec').load(db);const objects={},columns={};
for(const r of db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all()){
objects[r.name]={name:r.name,type:r.type,tbl_name:r.tbl_name,sqlHash:c.createHash('sha256').update(r.sql||'').digest('hex')};
if(r.type==='table')columns[r.name]=db.prepare('PRAGMA table_info("'+r.name.replace(/"/g,'""')+'")').all().map(v=>[v.cid,v.name,v.type,v.notnull,v.dflt_value,v.pk]);
}db.close();console.log(JSON.stringify({objects,columns}));'''
        image = p['baseImages' if rollback else 'candidateImages'][core.CRM]
        db = Path(p['databasePath'])
        value = json.loads(self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
            '--entrypoint', 'node', '--mount', f'type=bind,source={db.parent},target=/check,readonly',
            '-e', 'DB_PATH=/check/' + db.name, image, '-e', script]))
        acceptable = [p['expectedSchema']] + ([p['baseSchema']] if rollback else [])
        require(value in acceptable, 'INSTALLED_CRM_SCHEMA_MISMATCH')
        return {**receipt, 'installedSchemaVerified': True, 'schemaHash': core.digest(value['objects'])}

    def prepare(self):
        require(not (self.root / 'prepared.private.json').exists(), 'RELEASE_ALREADY_PREPARED')
        p = self.capture()
        p['candidateImages'], p['candidateHashes'] = {}, {}
        for name in core.SERVICES:
            base = p['baseImages'][name]
            base_tag = 'ava-role-base-' + name + ':' + self.args.candidate_commit[:12]
            self.run(['docker', 'tag', base, base_tag])
            require(self.image(base_tag)['Id'] == base, 'PINNED_BUILD_BASE_DRIFT')
            context = self.root / ('build-' + name)
            context.mkdir(mode=0o700)
            files = self.m['services'][name]['files']
            for rel in files:
                target = context / 'payload' / rel
                target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                shutil.copyfile(core.contained(self.bundle / 'payload' / name, rel), target)
                target.chmod(0o644)
            for path in (context / 'payload').rglob('*'):
                require(not path.is_symlink(), 'SYMLINK_BUILD_PAYLOAD')
                if path.is_dir():
                    path.chmod(0o755)
            (context / 'payload').chmod(0o755)
            chmod, access_probe = core.overlay_permissions(files)
            original_user = self.image(base)['Config'].get('User', '')
            recipe = 'FROM ' + base_tag + '\nUSER 0:0\n'
            if name == core.CRM:
                recipe += 'RUN ["node","-e","require(\'fs\').rmSync(\'/app/frontend/dist\',{recursive:true,force:true})"]\n'
            recipe += 'COPY --chown=0:0 payload/ /app/\nRUN ' + json.dumps(['node', '-e', chmod]) + '\n'
            recipe += 'USER ' + (original_user or '0') + '\n'
            (context / 'Dockerfile').write_text(recipe)
            self.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', self.m['services'][name]['candidateTag'], str(context)], timeout=900)
            require(self.image(base_tag)['Id'] == base, 'PINNED_BUILD_BASE_DRIFT')
            candidate, pinned = self.image(self.m['services'][name]['candidateTag']), self.image(base)
            require(candidate['Config'] == pinned['Config'], 'IMAGE_RUNTIME_CONFIG_CHANGED')
            layers = pinned['RootFS']['Layers']
            require(candidate['RootFS']['Layers'][:len(layers)] == layers, 'PINNED_PARENT_LAYERS_CHANGED')
            expected = {key: value for key, value in p['oldHashes'][name].items()
                        if name != core.CRM or not key.startswith('frontend/dist/')}
            expected.update(files)
            require(self.hashes(candidate['Id'], image=True) == expected, 'CANDIDATE_BYTES_MISMATCH')
            user = p['before'][name]['Config'].get('User') or original_user or '0'
            access = self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', user,
                              '--entrypoint', 'node', candidate['Id'], '-e', access_probe], timeout=60)
            require(json.loads(access).get('overlayReadable') is True, 'CANDIDATE_RUNTIME_ACCESS_DENIED')
            p['candidateImages'][name], p['candidateHashes'][name] = candidate['Id'], expected
        self.checked_override(p, p['candidateImages'])
        self.checked_override(p, p['baseImages'], rollback=True)
        backup = self.backup(p, 'prepare-backup')
        migration = self.migration_test(p, backup)
        canary = self.worker_canary(p, backup)
        self.guard(p, p['baseImages'])
        core.private_json(self.root / 'prepared.private.json', p)
        self.receipt('prepared', p, backup=backup, migration=migration, workerCanary=canary)

    def worker_canary(self, p, backup):
        row = p['before']['provisioning_worker']
        directory = self.root / 'worker-canary'
        directory.mkdir(mode=0o755)
        directory.chmod(0o755)
        db = directory / 'crm_v2.db'
        shutil.copyfile(backup['path'], db)
        self.runner(p['candidateImages']['provisioning_worker'], db)
        user = row['Config'].get('User') or '0'
        require(re.fullmatch(r'[0-9]+:[0-9]+', user), 'WORKER_NUMERIC_UID_GID_REQUIRED')
        uid, gid = map(int, user.split(':'))
        os.chown(directory, uid, gid)
        os.chown(db, uid, gid)
        db.chmod(0o600)
        env = {**core.envmap(row), **self.m['services']['provisioning_worker'].get('environment', {})}
        require(all('\n' not in value and '\r' not in value for value in env.values()), 'MULTILINE_ENV_UNSUPPORTED')
        env_file = self.root / 'worker-canary.private.env'
        env_file.write_text(''.join(key + '=' + value + '\n' for key, value in env.items()))
        env_file.chmod(0o600)
        name = 'ava-role-worker-canary-' + self.args.candidate_commit[:12]
        command = ['docker', 'create', '--name', name, '--network', 'none', '--user', user,
                   '--env-file', str(env_file), '--mount', f'type=bind,source={directory},target=/app/data']
        for mount in row['Mounts']:
            if mount['Destination'] in ('/app/voice-config', '/run/secrets/ava-vertex-adc.json'):
                require(not mount['RW'], 'CANARY_WRITABLE_CONFIG_BIND')
                command += ['--mount', f"type=bind,source={mount['Source']},target={mount['Destination']},readonly"]
        entrypoint = row['Config'].get('Entrypoint') or []
        require(len(entrypoint) <= 1, 'WORKER_ENTRYPOINT_UNSUPPORTED')
        if entrypoint:
            command += ['--entrypoint', entrypoint[0]]
        command += ['--workdir', row['Config']['WorkingDir'], p['candidateImages']['provisioning_worker'], *row['Config']['Cmd']]
        created = False
        try:
            self.run(command)
            created = True
            self.run(['docker', 'start', name])
            for _ in range(2):
                deadline = time.monotonic() + 50
                while True:
                    canary = json.loads(self.run(['docker', 'inspect', name]))[0]
                    require(canary['State']['Running'] and canary.get('RestartCount') == 0, 'CANARY_WORKER_EXITED')
                    try:
                        self.ready(canary, require_worker_ready=True)
                        break
                    except RuntimeError:
                        require(time.monotonic() < deadline, 'CANARY_WORKER_NOT_READY')
                        time.sleep(2)
                time.sleep(2)
        finally:
            if created:
                self.run(['docker', 'rm', '-f', name])
                require(not self.run(['docker', 'ps', '-aq', '--filter', 'name=^/' + name + '$']).strip(), 'CANARY_CLEANUP_FAILED')
        return {'actualEntrypoint': True, 'runtimeUidGid': user, 'readinessChecks': 2,
                'network': 'none', 'liveDatabaseMounted': False, 'hostTelephonySocketMounted': False,
                'zeroRestarts': True, 'cleanupVerified': True}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['audit', 'prepare', 'verify', 'apply', 'rollback'])
    for field in ('bundle', 'release-dir'):
        parser.add_argument('--' + field, type=Path, required=True)
    parser.add_argument('--candidate-commit', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    args = parser.parse_args()
    try:
        operator = Operator(args)
        # Share the existing host lock with prior CRM/worker releases.
        with open('/var/lock/ava-registration-release.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            getattr(operator, args.action)()
    except Exception as error:
        code = str(error)
        if not re.fullmatch(r'[A-Z0-9_]+', code):
            code = 'OPERATOR_FAILED_' + type(error).__name__.upper()
        print(json.dumps({'phase': 'failed', 'reason': code}), flush=True)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
