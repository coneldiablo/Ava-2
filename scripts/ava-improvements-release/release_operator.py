#!/usr/bin/env python3
"""Pinned, CRM-only release operator. Run on the Docker host, not over implicit SSH."""
from __future__ import annotations

import argparse
import copy
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request

CRM = 'whatsapp_crm'
ALLOWED_ENV = 'AVA_IMPROVEMENTS_BUSINESSES'
HEX = re.compile(r'^[0-9a-f]{64}$')
COMMIT = re.compile(r'^[0-9a-f]{40}$')
HASH_JS = r'''
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const out={source:{},frontend:{},runtime:{}};
function hash(b){return crypto.createHash('sha256').update(b).digest('hex')}
function walk(root,dir,map,skip=[]){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){
const f=path.join(dir,ent.name),rel=path.relative(root,f);
if(skip.some(s=>rel===s||rel.startsWith(s+'/')))continue;
if(ent.isDirectory())walk(root,f,map,skip);
else if(ent.isFile())map[rel]=hash(fs.readFileSync(f));
else if(ent.isSymbolicLink())map[rel]='symlink:'+fs.readlinkSync(f);
else throw Error('SPECIAL_FILE');}}
walk('/app/src','/app/src',out.source);
walk('/app/frontend/dist','/app/frontend/dist',out.frontend);
walk('/app','/app',out.runtime,['src','frontend/dist','data']);
console.log(JSON.stringify(out));
'''
COMPAT_JS = r'''
const SQLite=require('/app/node_modules/better-sqlite3');
const db=new SQLite(process.env.DB_PATH,{readonly:true,fileMustExist:true});
require('/app/node_modules/sqlite-vec').load(db);
if(db.pragma('integrity_check',{simple:true})!=='ok')throw Error('INTEGRITY');
// Prepare and read every existing table using the rollback image's SQLite driver.
for(const r of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()){
 db.prepare('SELECT * FROM "'+r.name.replace(/"/g,'""')+'" LIMIT 1').all();
}
db.close(); console.log(JSON.stringify({compatibilityOk:true}));
'''
SNAPSHOT_JS = r'''
const SQLite=require('/app/node_modules/better-sqlite3'),crypto=require('crypto');
const db=new SQLite(process.env.DB_PATH,{readonly:true,fileMustExist:true});
require('/app/node_modules/sqlite-vec').load(db);
db.defaultSafeIntegers(true);
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
if(db.pragma('integrity_check',{simple:true})!=='ok')throw Error('INTEGRITY');
const objects={},tables={};
db.transaction(()=>{
for(const r of db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all()){
 objects[r.name]={name:r.name,type:r.type,tbl_name:r.tbl_name,sqlHash:hash(r.sql||'')};
 if(r.type==='table'){
  const hashes=[];
  for(const row of db.prepare('SELECT * FROM "'+r.name.replace(/"/g,'""')+'"').raw().iterate()){
   const typed=row.map(v=>[v===null?'null':Buffer.isBuffer(v)?'blob':typeof v,
    Buffer.isBuffer(v)?v.toString('hex'):typeof v==='bigint'?v.toString():v]);
   hashes.push(hash(JSON.stringify(typed)));
  }
  tables[r.name]={count:hashes.length,rowsHash:hash(JSON.stringify(hashes.sort()))};
 }
}
})();
db.close();console.log(JSON.stringify({objects,tables}));
'''


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def sha(path):
    h = hashlib.sha256()
    with pathlib.Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def private_json(path, value):
    path = pathlib.Path(path)
    # Exclusive temp file and atomic replacement; never expose credentials in stdout.
    temp = path.with_name(path.name + '.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temp, 0o600)
    os.replace(temp, path)


def relative(name):
    require(isinstance(name, str) and name and '\\' not in name and '\n' not in name,
            'INVALID_MANIFEST_PATH')
    parts = name.split('/')
    require(not name.startswith('/') and all(p not in ('', '.', '..') for p in parts),
            'INVALID_MANIFEST_PATH')
    return pathlib.PurePosixPath(name)


def contained(root, name):
    rel = relative(name)
    path = pathlib.Path(root).joinpath(*rel.parts)
    require(not pathlib.Path(root).is_symlink(), 'SYMLINK_BUNDLE')
    current = pathlib.Path(root)
    for part in rel.parts:
        current = current / part
        require(not current.is_symlink(), 'SYMLINK_PAYLOAD')
    require(path.is_file(), 'PAYLOAD_MISSING')
    return path


def validate_manifest(m, base_image, commit):
    require(m.get('schemaVersion') == 1, 'MANIFEST_VERSION')
    require(COMMIT.fullmatch(m.get('baseCommit', '')) and COMMIT.fullmatch(commit or ''), 'COMMIT_INVALID')
    require(m.get('candidateCommit') == commit, 'CANDIDATE_COMMIT_MISMATCH')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', base_image or '') and m.get('baseImageId') == base_image,
            'BASE_IMAGE_MISMATCH')
    require(re.fullmatch(r'ava-improvements-crm:[a-zA-Z0-9_.-]+', m.get('candidateTag', '')), 'CANDIDATE_TAG_INVALID')
    for field in ('sourceFiles', 'frontendFiles'):
        require(isinstance(m.get(field), dict) and m[field], 'EMPTY_PAYLOAD_MAP')
        for path, value in m[field].items():
            relative(path)
            require(HEX.fullmatch(value or ''), 'PAYLOAD_DIGEST_INVALID')
    base_sources = m.get('baseSourceFiles')
    require(isinstance(base_sources, dict) and set(base_sources) == set(m['sourceFiles']),
            'BASE_SOURCE_CONTRACT_MISSING')
    require(all(value is None or isinstance(value, str) and HEX.fullmatch(value)
                for value in base_sources.values()), 'BASE_SOURCE_DIGEST_INVALID')
    require('index.html' in m['frontendFiles'] and any(p.startswith('assets/') and p.endswith('.js')
            for p in m['frontendFiles']), 'FRONTEND_INCOMPLETE')
    require(m.get('businesses') == '*' or (isinstance(m.get('businesses'), list) and m['businesses']
            and all(isinstance(x, str) and re.fullmatch(r'[A-Za-z0-9_-]+', x) for x in m['businesses'])),
            'BUSINESS_SCOPE_INVALID')
    require(m.get('publicBaseUrl') == 'https://wh.meludtech.tech' and m.get('publicRoutes') == ['/', '/today'],
            'PUBLIC_ROUTES_CHANGED')
    runner = m.get('migrationRunner') or {}
    relative(runner.get('path'))
    require(HEX.fullmatch(runner.get('sha256', '')), 'MIGRATION_RUNNER_UNPINNED')
    additions = m.get('allowedNewSchema')
    require(isinstance(additions, list) and additions, 'NEW_SCHEMA_CONTRACT_MISSING')
    seen = set()
    for obj in additions:
        require(set(obj) == {'name', 'type', 'tbl_name', 'sqlHash'} and obj['type'] in ('table', 'index', 'trigger'),
                'NEW_SCHEMA_CONTRACT_INVALID')
        require(isinstance(obj['name'], str) and obj['name'] and obj['name'] not in seen and
                isinstance(obj['tbl_name'], str) and HEX.fullmatch(obj['sqlHash']), 'NEW_SCHEMA_CONTRACT_INVALID')
        seen.add(obj['name'])
    return m


def assert_baseline_source(old_source, manifest):
    # Replacements must match Git's reviewed base; additions must be absent.
    # Preserving the rest of the image cannot protect a hotfix in an overlaid file.
    for path, expected in manifest['baseSourceFiles'].items():
        require((path not in old_source) if expected is None else old_source.get(path) == expected,
                'OVERLAY_BASE_SOURCE_DRIFT')


def envmap(row):
    values = row['Config'].get('Env') or []
    result = dict(x.split('=', 1) for x in values if '=' in x)
    require(len(result) == len(values), 'CONTAINER_ENV_INVALID')
    return result


def compose(row, override=None):
    labels = row['Config']['Labels']
    prefix = 'com.docker.compose.'
    require(all(labels.get(prefix + key) for key in ('project', 'project.config_files', 'service', 'project.working_dir')),
            'COMPOSE_LABELS_MISSING')
    args = ['docker', 'compose', '-p', labels[prefix + 'project']]
    for name in labels.get(prefix + 'project.environment_file', '').split(','):
        if name:
            require(pathlib.Path(name).is_absolute() and pathlib.Path(name).is_file(), 'ENV_FILE_MISSING')
            args += ['--env-file', name]
    for name in labels[prefix + 'project.config_files'].split(','):
        require(pathlib.Path(name).is_absolute() and pathlib.Path(name).is_file(), 'COMPOSE_FILE_MISSING')
        args += ['-f', name]
    if override:
        args += ['-f', str(override)]
    return args, labels[prefix + 'project.working_dir'], labels[prefix + 'service']


def override_payload(row, baseline, image, extra=None):
    actual = envmap(row)
    require(set((baseline.get('environment') or {})) <= set(actual), 'ENV_ADDED_ON_DISK')
    require(not extra or set(extra) == {ALLOWED_ENV}, 'NEW_ENV_FORBIDDEN')
    intended = {**actual, **(extra or {})}
    payload = {'services': {row['Config']['Labels']['com.docker.compose.service']: {
        'image': image, 'environment': {k: v.replace('$', '$$') for k, v in intended.items()}}}}
    expected = copy.deepcopy(baseline)
    expected['image'] = image
    expected['environment'] = intended
    return payload, expected


def database_path(row):
    db = pathlib.PurePosixPath(envmap(row).get('DB_PATH', ''))
    require(db.is_absolute(), 'DB_PATH_NOT_ABSOLUTE')
    mounts = row.get('Mounts') or []
    require(len(mounts) == 1 and mounts[0]['Type'] == 'bind' and mounts[0]['Destination'] == '/app/data'
            and mounts[0].get('RW') and str(db) == '/app/data/crm_v2.db', 'DB_BIND_CONTRACT_CHANGED')
    source = pathlib.Path(mounts[0]['Source'])
    require(source.is_absolute(), 'DB_BIND_INVALID')
    path = source / 'crm_v2.db'
    require(path.is_file(), 'LIVE_DB_MISSING')
    return path


def online_backup(source, target, validate=True):
    require(not target.exists(), 'BACKUP_EXISTS')
    src = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=30)
    dst = sqlite3.connect(target, timeout=30)
    try:
        src.backup(dst, pages=512, sleep=0.05)
        # Standalone backup must open on a read-only bind without WAL sidecars.
        dst.commit()
        require(dst.execute("PRAGMA journal_mode=DELETE").fetchone() == ("delete",),
                "BACKUP_JOURNAL_MODE_FAILED")
        if validate:
            require(dst.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'BACKUP_INTEGRITY_FAILED')
        dst.commit()
    finally:
        dst.close()
        src.close()
    target.chmod(0o600)
    with target.open('rb') as stream:
        os.fsync(stream.fileno())
    fd = os.open(target.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return {'path': str(target), 'sha256': sha(target), 'createdAt': time.time(), 'integrityOk': validate,
            'method': 'sqlite-online-backup'}


def schema_and_rows(path):
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=30)
    try:
        require(db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'DATABASE_INTEGRITY_FAILED')
        objects = {}
        tables = {}
        for kind, name, table, sql in db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name'):
            objects[name] = {'name': name, 'type': kind, 'tbl_name': table,
                             'sqlHash': hashlib.sha256((sql or '').encode()).hexdigest()}
            if kind == 'table':
                quoted = '"' + name.replace('"', '""') + '"'
                hashes = []
                for row in db.execute('SELECT * FROM ' + quoted):
                    typed = [(type(value).__name__, value.hex() if isinstance(value, bytes) else value) for value in row]
                    hashes.append(digest(typed))
                tables[name] = {'count': len(hashes), 'rowsHash': digest(sorted(hashes))}
        return {'objects': objects, 'tables': tables}
    finally:
        db.close()


def assert_additive(before, after, allowed):
    for name, obj in before['objects'].items():
        require(after['objects'].get(name) == obj, 'ORIGINAL_SCHEMA_CHANGED')
    for name, value in before['tables'].items():
        require(after['tables'].get(name) == value, 'ORIGINAL_ROWS_CHANGED')
    additions = {k: v for k, v in after['objects'].items() if k not in before['objects']}
    require(additions == {obj['name']: obj for obj in allowed}, 'UNEXPECTED_SCHEMA_ADDITIONS')


class Operator:
    def __init__(self, args):
        self.args = args
        self.root = args.release_dir.resolve()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        require(not args.release_dir.is_symlink(), 'SYMLINK_RELEASE_DIR')
        self.manifest_path = contained(args.bundle.resolve(), 'manifest.json')
        require(HEX.fullmatch(args.manifest_sha256 or '') and sha(self.manifest_path) == args.manifest_sha256,
                'MANIFEST_DIGEST_MISMATCH')
        self.m = validate_manifest(json.loads(self.manifest_path.read_text()), args.base_image, args.candidate_commit)
        for field, directory in (('sourceFiles', 'src'), ('frontendFiles', 'frontend-dist')):
            for rel, wanted in self.m[field].items():
                require(sha(contained(args.bundle.resolve() / directory, rel)) == wanted, 'PAYLOAD_BYTES_CHANGED')
        runner = self.m['migrationRunner']
        self.runner = contained(args.bundle.resolve(), runner['path'])
        require(sha(self.runner) == runner['sha256'], 'MIGRATION_RUNNER_CHANGED')

    def run(self, args, cwd=None, input=None, timeout=180):
        process = subprocess.run(args, cwd=cwd, input=input, text=True, capture_output=True, timeout=timeout)
        if process.returncode:
            private_json(self.root / 'command-failure.private.json', {'args': args, 'stdout': process.stdout,
                         'stderr': process.stderr, 'returncode': process.returncode})
            raise RuntimeError('COMMAND_FAILED_PRIVATE_LOG')
        return process.stdout

    def state(self, target=CRM):
        return json.loads(self.run(['docker', 'inspect', target]))[0]

    def healthy(self, row):
        require(row['State']['Running'] and not row['State'].get('Paused') and
                row['State'].get('Health', {}).get('Status') == 'healthy', 'CRM_NOT_HEALTHY')
        require(row.get('RestartCount') == 0, 'CRM_RESTARTED')

    def snapshot_other(self):
        ids = self.run(['docker', 'ps', '-aq']).split()
        rows = json.loads(self.run(['docker', 'inspect', *ids])) if ids else []
        return {r['Name'].lstrip('/'): {'Id': r['Id'], 'Image': r['Image'], 'Running': r['State']['Running']}
                for r in rows if r['Name'].lstrip('/') != CRM}

    def config(self, row, override=None):
        cmd, cwd, service = compose(row, override)
        value = json.loads(self.run(cmd + ['config', '--format', 'json'], cwd=cwd))['services'][service]
        value = copy.deepcopy(value)
        value['environment'] = {k: v.replace('$$', '$') if isinstance(v, str) else v
                                for k, v in (value.get('environment') or {}).items()}
        return value

    def checked_override(self, row, baseline, image, filename, extra=None):
        payload, expected = override_payload(row, baseline, image, extra)
        path = self.root / filename
        private_json(path, payload)
        require(self.config(row, path) == expected, 'COMPOSE_CONFIG_CHANGED')
        return path

    def hashes(self, target, image=False):
        cmd = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node', target]
        if not image:
            cmd = ['docker', 'exec', target, 'node']
        return json.loads(self.run(cmd + ['-e', HASH_JS], timeout=300))

    def image(self, target):
        return json.loads(self.run(['docker', 'image', 'inspect', target]))[0]

    def db_runner(self, image, db, mode='migrate'):
        require(sha(self.runner) == self.m['migrationRunner']['sha256'], 'MIGRATION_RUNNER_CHANGED')
        cmd = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node',
               '--mount', f'type=bind,source={db.parent},target=/check' + (',readonly' if mode == 'compat' else ''),
               '--mount', f'type=bind,source={self.runner},target=/release/migrations.cjs,readonly',
               '-e', 'DB_PATH=/check/' + db.name, '-e', ALLOWED_ENV + '=' + self.scope(), image,
               '/release/migrations.cjs', mode]
        # Only code supplied by the pinned runner sees the DB; never start the application.
        require(json.loads(self.run(cmd, timeout=180)).get('schemaVerified') is True, 'MIGRATION_RECEIPT_INVALID')

    def compatibility(self, image, db):
        self.db_runner(image, db, 'compat')
        output = self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node',
                   '--mount', f'type=bind,source={db.parent},target=/check,readonly',
                   '-e', 'DB_PATH=/check/' + db.name, image, '-e', COMPAT_JS])
        require(json.loads(output).get('compatibilityOk') is True, 'ROLLBACK_SQLITE_INCOMPATIBLE')

    def scope(self):
        return '*' if self.m['businesses'] == '*' else ','.join(self.m['businesses'])

    def db_snapshot(self, image, db):
        return json.loads(self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node',
                   '--mount', f'type=bind,source={db.parent},target=/check,readonly',
                   '-e', 'DB_PATH=/check/' + db.name, image, '-e', SNAPSHOT_JS], timeout=300))

    def new_backup(self, row, prefix):
        directory = self.root / (prefix + '-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        directory.mkdir(mode=0o700)
        receipt = online_backup(database_path(row), directory / 'crm_v2.db', validate=False)
        # The production SQLite schema contains vec0 virtual tables. Validate with
        # the pinned runtime's driver and sqlite-vec rather than host Python SQLite.
        self.compatibility(self.args.base_image, pathlib.Path(receipt['path']))
        receipt['integrityOk'] = True
        private_json(directory / 'receipt.json', receipt)
        return receipt

    def migration_test(self, backup, candidate):
        directory = pathlib.Path(backup['path']).parent / 'migration-check'
        directory.mkdir(mode=0o700)
        clone = directory / 'crm_v2.db'
        shutil.copyfile(backup['path'], clone)
        clone.chmod(0o600)
        before = self.db_snapshot(candidate, clone)
        self.db_runner(candidate, clone)
        after = self.db_snapshot(candidate, clone)
        assert_additive(before, after, self.m['allowedNewSchema'])
        # A second invocation proves the exact runner is idempotent.
        self.db_runner(candidate, clone)
        require(self.db_snapshot(candidate, clone) == after, 'MIGRATION_NOT_IDEMPOTENT')
        self.compatibility(self.args.base_image, clone)
        return {'originalSchemaAndRowsUnchanged': True, 'idempotent': True, 'oldImageReadOnlyCompatible': True,
                'schemaHash': digest(after['objects'])}

    def inputs(self, row):
        cmd, cwd, service = compose(row)
        labels = row['Config']['Labels']
        names = labels['com.docker.compose.project.config_files'].split(',')
        names += [x for x in labels.get('com.docker.compose.project.environment_file', '').split(',') if x]
        return {'command': cmd, 'cwd': cwd, 'service': service, 'fileHashes': {x: sha(x) for x in names}}

    def guard(self, prepared, row, expected_image, extra=None):
        self.healthy(row)
        require(row['Image'] == expected_image, 'LIVE_CRM_IMAGE_DRIFT')
        require(database_path(row) == pathlib.Path(prepared['databasePath']), 'LIVE_DB_BIND_DRIFT')
        require(row['Mounts'] == prepared['before']['Mounts'], 'LIVE_MOUNTS_DRIFT')
        require(envmap(row) == {**envmap(prepared['before']), **(extra or {})}, 'LIVE_ENV_DRIFT')
        require(self.snapshot_other() == prepared['otherContainers'], 'NON_CRM_CONTAINER_CHANGED')
        # Always replay the original ordered inputs, including their runtime env differences.
        require(self.inputs(prepared['before']) == prepared['composeInputs'], 'COMPOSE_INPUT_DRIFT')

    def prepare(self):
        require(not (self.root / 'prepared.private.json').exists(), 'RELEASE_ALREADY_PREPARED')
        before = self.state()
        self.healthy(before)
        require(before['Image'] == self.args.base_image, 'LIVE_CRM_BASE_IMAGE_CHANGED')
        db = database_path(before)
        other = self.snapshot_other()
        baseline_config = self.config(before)
        inputs = self.inputs(before)
        old = self.hashes(CRM)
        assert_baseline_source(old['source'], self.m)
        base = self.image(self.args.base_image)
        require(self.hashes(self.args.base_image, image=True) == old, 'BASE_IMAGE_LIVE_BYTES_DRIFT')
        # A local tag makes FROM portable across Docker builders; resolve and
        # verify its content ID rather than asking a registry for sha256:<id>.
        base_tag = 'ava-improvements-base:' + self.args.candidate_commit[:12]
        self.run(['docker', 'tag', self.args.base_image, base_tag])
        require(self.image(base_tag)['Id'] == self.args.base_image, 'PINNED_BUILD_BASE_DRIFT')
        context = self.root / 'build-context'
        context.mkdir(mode=0o700)
        for field, directory in (('sourceFiles', 'src'), ('frontendFiles', 'frontend-dist')):
            for rel in self.m[field]:
                target = context / directory / rel
                target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                shutil.copyfile(contained(self.args.bundle.resolve() / directory, rel), target)
                target.chmod(0o644)
        (context / 'Dockerfile').write_text('FROM ' + base_tag + '\nCOPY --chown=0:0 src/ /app/src/\n'
                                          'COPY --chown=0:0 frontend-dist/ /app/frontend/dist/\n')
        self.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', self.m['candidateTag'], str(context)],
                 timeout=900)
        require(self.image(base_tag)['Id'] == self.args.base_image, 'PINNED_BUILD_BASE_DRIFT')
        candidate = self.image(self.m['candidateTag'])
        require(base['Config'] == candidate['Config'], 'IMAGE_RUNTIME_CONFIG_CHANGED')
        expected = copy.deepcopy(old)
        expected['source'].update(self.m['sourceFiles'])
        expected['frontend'].update(self.m['frontendFiles'])
        require(self.hashes(candidate['Id'], image=True) == expected, 'CANDIDATE_BYTES_MISMATCH')
        candidate_override = self.checked_override(before, baseline_config, candidate['Id'],
                            'candidate.private.override.json', {ALLOWED_ENV: self.scope()})
        rollback_override = self.checked_override(before, baseline_config, self.args.base_image,
                                                  'rollback.private.override.json')
        backup = self.new_backup(before, 'prepare-backup')
        migration = self.migration_test(backup, candidate['Id'])
        prepared = {'manifestSha256': self.args.manifest_sha256, 'candidateCommit': self.args.candidate_commit,
                    'baseImageId': self.args.base_image, 'candidateImageId': candidate['Id'], 'before': before,
                    'otherContainers': other, 'composeInputs': inputs, 'baselineConfig': baseline_config,
                    'databasePath': str(db), 'oldHashes': old, 'candidateHashes': expected,
                    'candidateOverride': str(candidate_override), 'rollbackOverride': str(rollback_override),
                    'backup': backup, 'migration': migration}
        self.guard(prepared, self.state(), self.args.base_image)
        private_json(self.root / 'prepared.private.json', prepared)
        self.receipt('prepared', prepared, backup=backup, migration=migration)

    def load(self, check_candidate=True):
        p = json.loads((self.root / 'prepared.private.json').read_text())
        require(p['manifestSha256'] == self.args.manifest_sha256 and p['candidateCommit'] == self.args.candidate_commit
                and p['baseImageId'] == self.args.base_image, 'PREPARED_RELEASE_MISMATCH')
        if check_candidate:
            require(self.image(self.m['candidateTag'])['Id'] == p['candidateImageId'], 'CANDIDATE_TAG_DRIFT')
            require(self.hashes(p['candidateImageId'], image=True) == p['candidateHashes'], 'CANDIDATE_BYTES_DRIFT')
        require(self.hashes(self.args.base_image, image=True) == p['oldHashes'], 'ROLLBACK_IMAGE_BYTES_DRIFT')
        return p

    def public(self, files):
        def get(path):
            url = self.m['publicBaseUrl'] + path
            with urllib.request.urlopen(urllib.request.Request(url, headers={'Cache-Control': 'no-cache'}), timeout=20) as response:
                require(response.status == 200 and response.geturl() == url, 'PUBLIC_HTTPS_RESPONSE_CHANGED')
                h = hashlib.sha256()
                while block := response.read(1024 * 1024):
                    h.update(block)
                return h.hexdigest()
        for route in self.m['publicRoutes']:
            require(get(route) == files['index.html'], 'PUBLIC_ROUTE_BYTES_MISMATCH')
        # Verify every candidate asset, including lazy chunks; no customer API calls.
        for rel, wanted in files.items():
            require(get('/' + rel) == wanted, 'PUBLIC_ASSET_BYTES_MISMATCH')
        return {'https': True, 'routes': self.m['publicRoutes'], 'fileCount': len(files), 'filesHash': digest(files)}

    def verify_installed(self, p, rollback=False):
        image = self.args.base_image if rollback else p['candidateImageId']
        hashes = p['oldHashes'] if rollback else p['candidateHashes']
        row = self.state()
        self.guard(p, row, image, None if rollback else {ALLOWED_ENV: self.scope()})
        require(self.hashes(CRM) == hashes, 'INSTALLED_BYTES_MISMATCH')
        require(row['Config']['Cmd'] == p['before']['Config']['Cmd'] and
                row['Config']['Entrypoint'] == p['before']['Config']['Entrypoint'] and
                row['HostConfig'] == p['before']['HostConfig'], 'CONTAINER_RUNTIME_CONFIG_CHANGED')
        public = self.public(p['oldHashes']['frontend'] if rollback else self.m['frontendFiles'])
        # Recheck after HTTPS verification so health and restart claims are fresh.
        self.guard(p, self.state(), image, None if rollback else {ALLOWED_ENV: self.scope()})
        return {'healthy': True, 'restartCount': 0, 'databaseBindVerified': True,
                'nonCrmContainersUnchanged': True, 'staticHash': digest(hashes), 'public': public}

    def up(self, p, rollback=False):
        row = p['before']
        image = self.args.base_image if rollback else p['candidateImageId']
        filename = 'rollback.private.override.json' if rollback else 'candidate.private.override.json'
        override = self.checked_override(row, p['baselineConfig'], image, filename,
                                         None if rollback else {ALLOWED_ENV: self.scope()})
        cmd, cwd, service = compose(row, override)
        self.run(cmd + ['up', '-d', '--no-deps', '--pull', 'never', '--force-recreate', service], cwd=cwd)
        deadline = time.monotonic() + 120
        while True:
            current = self.state()
            if current['State']['Running'] and current['State'].get('Health', {}).get('Status') == 'healthy':
                self.healthy(current)
                return
            require(time.monotonic() < deadline and current.get('RestartCount') == 0, 'CRM_HEALTH_TIMEOUT')
            time.sleep(2)

    def apply(self):
        p = self.load()
        self.guard(p, self.state(), self.args.base_image)
        require(self.hashes(CRM) == p['oldHashes'], 'LIVE_BYTES_DRIFT')
        backup = self.new_backup(self.state(), 'apply-backup')
        migration = self.migration_test(backup, p['candidateImageId'])
        require(time.time() - backup['createdAt'] < 300 and sha(backup['path']) == backup['sha256'], 'BACKUP_NOT_FRESH')
        self.guard(p, self.state(), self.args.base_image)
        private_json(self.root / 'apply-started.json', {'backup': backup, 'candidateImageId': p['candidateImageId'],
                                                    'candidateCommit': p['candidateCommit']})
        try:
            self.db_runner(p['candidateImageId'], pathlib.Path(p['databasePath']))
            live_schema = self.db_snapshot(p['candidateImageId'], pathlib.Path(p['databasePath']))['objects']
            for obj in self.m['allowedNewSchema']:
                require(live_schema.get(obj['name']) == obj, 'LIVE_MIGRATION_SCHEMA_MISMATCH')
            self.up(p)
            health = self.verify_installed(p)
        except Exception:
            # Recover the pinned old executable and original environment; retain all current DB rows.
            try:
                self.rollback(p, automatic=True)
            except Exception:
                raise RuntimeError('APPLY_AND_ROLLBACK_FAILED_PRIVATE_LOG') from None
            raise RuntimeError('APPLY_FAILED_ROLLED_BACK_DATABASE_RETAINED') from None
        self.receipt('applied', p, backup=backup, migration=migration, health=health)

    def rollback(self, p=None, automatic=False):
        p = p or self.load(check_candidate=False)
        row = self.state()
        require(row['Image'] in (self.args.base_image, p['candidateImageId']), 'ROLLBACK_LIVE_IMAGE_DRIFT')
        require(row['Mounts'] == p['before']['Mounts'] and database_path(row) == pathlib.Path(p['databasePath']),
                'ROLLBACK_BIND_DRIFT')
        require(self.snapshot_other() == p['otherContainers'] and self.inputs(p['before']) == p['composeInputs'],
                'ROLLBACK_COMPOSE_OR_OTHER_DRIFT')
        backup = self.new_backup(row, 'rollback-backup')
        self.compatibility(self.args.base_image, pathlib.Path(backup['path']))
        self.up(p, rollback=True)
        health = self.verify_installed(p, rollback=True)
        self.receipt('rolled_back', p, backup=backup, health=health, automatic=automatic, databaseRestored=False)

    def receipt(self, phase, p, **extra):
        value = {'phase': phase, 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                 'candidateCommit': self.args.candidate_commit, 'manifestSha256': self.args.manifest_sha256,
                 'baseImageId': self.args.base_image, 'candidateImageId': p['candidateImageId'], **extra}
        private_json(self.root / (phase + '.receipt.json'), value)
        # Receipts contain only technical checks; customer rows and env values never leave private captures.
        print(json.dumps(value), flush=True)

    def verify(self):
        p = self.load()
        row = self.state()
        rollback = row['Image'] == self.args.base_image
        if rollback:
            self.guard(p, row, self.args.base_image)
            require(self.hashes(CRM) == p['oldHashes'], 'LIVE_BYTES_DRIFT')
            backup = self.new_backup(row, 'verify-backup')
            migration = self.migration_test(backup, p['candidateImageId'])
            self.receipt('verified_preapply', p, backup=backup, migration=migration)
        else:
            self.receipt('verified', p, health=self.verify_installed(p))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'verify', 'apply', 'rollback'])
    parser.add_argument('--bundle', type=pathlib.Path, required=True)
    parser.add_argument('--release-dir', type=pathlib.Path, required=True)
    parser.add_argument('--base-image', required=True)
    parser.add_argument('--candidate-commit', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    args = parser.parse_args()
    try:
        getattr(Operator(args), args.action)()
    except Exception as error:
        code = str(error)
        if not re.fullmatch(r'[A-Z0-9_]+', code):
            code = 'OPERATOR_FAILED_' + type(error).__name__.upper()
        print(json.dumps({'phase': 'failed', 'reason': code}), flush=True)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
