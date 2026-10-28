#!/usr/bin/env python3
"""Pinned CRM + provisioning worker release. Run explicitly on the Docker host."""
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
SERVICES = ('whatsapp_crm', 'provisioning_worker')
ENV_RULES = {'AVA_SELF_REGISTRATION_ENABLED': {'true', 'false'},
             'AVA_TEAM_NEW_ACCOUNT_ENABLED': {'true', 'false'},
             'AVA_PASSWORD_RECOVERY_NO_REDIRECT': {'true', 'false'},
             'WHATSAPP_CRM_PUBLIC_URL': {'https://wh.meludtech.tech'}, 'AVA_OIDC_CLIENT_ID': {'ava-web'}}
HEX = re.compile(r'^[0-9a-f]{64}$')
COMMIT = re.compile(r'^[0-9a-f]{40}$')
HASH_JS = r'''
const fs=require('fs'),path=require('path'),crypto=require('crypto'),out={};
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
 const f=path.join(dir,e.name),rel=path.relative('/app',f);
 if(rel==='data')continue;
 if(e.isDirectory())walk(f);
 else if(e.isFile())out[rel]=crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
 else if(e.isSymbolicLink())out[rel]='symlink:'+fs.readlinkSync(f);
 else throw Error('SPECIAL_FILE');
}}walk('/app');console.log(JSON.stringify(out));
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


def overlay_permissions(files):
    directories = {'/app'}
    paths = []
    for name in files:
        path = pathlib.PurePosixPath('/app') / relative(name)
        paths.append(str(path))
        directories.update(str(parent) for parent in path.parents if str(parent).startswith('/app'))
    declarations = 'const fs=require("fs"),directories=' + json.dumps(sorted(directories)) + ';'
    chmod = declarations + '''for(const path of directories){
const s=fs.lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink())throw Error('OVERLAY_DIRECTORY_INVALID');
fs.chmodSync(path,0o755);}'''
    probe = declarations + 'const files=' + json.dumps(sorted(paths)) + ''';
try{for(const path of directories){const s=fs.lstatSync(path);
if(!s.isDirectory()||(s.mode&0o777)!==0o755)throw Error('OVERLAY_DIRECTORY_MODE');
fs.accessSync(path,fs.constants.R_OK|fs.constants.X_OK);}
for(const path of files)fs.accessSync(path,fs.constants.R_OK);
console.log(JSON.stringify({overlayReadable:true}));}catch(_){process.exitCode=1;}'''
    return chmod, probe



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
    expected = {obj['name']: obj for obj in allowed}
    for name, obj in before['objects'].items():
        require(after['objects'].get(name) == obj, 'ORIGINAL_SCHEMA_CHANGED')
    for name, value in before['tables'].items():
        require(after['tables'].get(name) == value, 'ORIGINAL_ROWS_CHANGED')
    additions = {k: v for k, v in after['objects'].items() if k not in before['objects']}
    # Already-installed exact additions are valid on retries; mismatched DDL fails.
    require(all(after['objects'].get(k) == v for k, v in expected.items()), 'EXPECTED_SCHEMA_MISSING')
    require(additions == {k: v for k, v in expected.items() if k not in before['objects']},
            'UNEXPECTED_SCHEMA_ADDITIONS')


def validate_manifest(m, commit):
    require(m.get('schemaVersion') == 2 and COMMIT.fullmatch(m.get('baseCommit', '')),
            'MANIFEST_VERSION_OR_BASE')
    require(COMMIT.fullmatch(commit or '') and m.get('candidateCommit') == commit, 'CANDIDATE_COMMIT_MISMATCH')
    require(set(m.get('services', {})) == set(SERVICES), 'TWO_SERVICE_CONTRACT_REQUIRED')
    require(m.get('publicBaseUrl') == 'https://wh.meludtech.tech' and
            m.get('publicRoutes') == ['/login', '/register', '/forgot-password'], 'PUBLIC_ROUTES_CHANGED')
    support = m.get('contractSupportFiles', [])
    require(isinstance(support, list) and all(isinstance(p, str) for p in support) and
            len(support) == len(set(support)), 'CONTRACT_SUPPORT_INVALID')
    for path in support:
        relative(path)
        require(path == 'test-helper.js' or path.startswith('tests/') and path.endswith('.js'),
                'CONTRACT_SUPPORT_INVALID')
    for service, s in m['services'].items():
        require(COMMIT.fullmatch(s.get('baseCommit', '')), 'SERVICE_BASE_COMMIT_UNPINNED')
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', s.get('baseImageId', '')), 'BASE_IMAGE_UNPINNED')
        require(re.fullmatch(r'ava-registration-(crm|worker):[a-zA-Z0-9_.-]+', s.get('candidateTag', '')),
                'CANDIDATE_TAG_INVALID')
        require(s.get('files') and set(s['files']) == set(s.get('baseFiles', {})), 'SOURCE_CONTRACT_MISSING')
        source_keys = {p for p in s['files'] if not p.startswith('frontend/dist/')}
        require(set(s.get('baseFileCommits', {})) == source_keys and
                all(COMMIT.fullmatch(v or '') for v in s['baseFileCommits'].values()), 'FILE_BASE_COMMIT_UNPINNED')
        require(set(support) <= source_keys, 'CONTRACT_SUPPORT_MISSING')
        absent = s.get('absentContractSupportFiles', [])
        require(isinstance(absent, list) and all(isinstance(p, str) for p in absent) and
                len(absent) == len(set(absent)) and set(absent) <= set(support),
                'ABSENT_CONTRACT_SUPPORT_INVALID')
        require(all(s['baseFiles'][p] is None and s['baseFileCommits'][p] == s['baseCommit']
                    for p in absent), 'ABSENT_CONTRACT_SUPPORT_INVALID')
        require(all(not p.startswith('tests/') or c == s['baseCommit'] or p in support
                    for p, c in s['baseFileCommits'].items()), 'TEST_PROVENANCE_NOT_EXPLICIT')
        for name, value in s['files'].items():
            relative(name)
            require(name in ('server.js', 'provisioning-worker.js', 'test-helper.js',
                             'scripts/team-enrollment-lease-recovery.js',
                             'scripts/team-email-reconciliation.js') or
                    name.startswith(('src/', 'tests/', 'frontend/dist/')), 'RUNTIME_PATH_FORBIDDEN')
            require(service == CRM or not name.startswith('frontend/'), 'WORKER_FRONTEND_FORBIDDEN')
            require(HEX.fullmatch(value or ''), 'PAYLOAD_DIGEST_INVALID')
            base = s['baseFiles'][name]
            require(base is None or HEX.fullmatch(base or ''), 'BASE_DIGEST_INVALID')
        for key, value in s.get('environment', {}).items():
            require(key in ENV_RULES and value in ENV_RULES[key], 'NEW_ENV_FORBIDDEN')
            require(key != 'AVA_PASSWORD_RECOVERY_NO_REDIRECT' or service == 'provisioning_worker',
                    'RECOVERY_MODE_WORKER_ONLY')
    require(m['services'][CRM]['baseCommit'] == m['baseCommit'], 'CRM_BASE_COMMIT_MISMATCH')
    for key in ('migrationRunner', 'contractRunner'):
        r = m.get(key) or {}
        relative(r.get('path'))
        require(HEX.fullmatch(r.get('sha256', '')), 'RUNNER_UNPINNED')
    allowed = m.get('allowedNewSchema')
    require(isinstance(allowed, list) and allowed, 'SCHEMA_CONTRACT_MISSING')
    names = set()
    for obj in allowed:
        require(set(obj) == {'name', 'type', 'tbl_name', 'sqlHash'} and
                obj['type'] in ('table', 'index', 'trigger') and isinstance(obj['name'], str) and
                obj['name'] and obj['name'] not in names and isinstance(obj['tbl_name'], str) and
                HEX.fullmatch(obj['sqlHash'] or ''), 'SCHEMA_CONTRACT_INVALID')
        names.add(obj['name'])
    return m


def assert_baseline_source(old, service):
    for name, expected in service['baseFiles'].items():
        require((name not in old) if expected is None else old.get(name) == expected,
                'OVERLAY_BASE_SOURCE_DRIFT')


def override_payload(rows, baseline, images, additions=None):
    result, expected = {'services': {}}, copy.deepcopy(baseline)
    for name in SERVICES:
        actual = envmap(rows[name])
        require(set(baseline[name].get('environment') or {}) <= set(actual), 'ENV_ADDED_ON_DISK')
        extra = (additions or {}).get(name, {})
        require(all(k in ENV_RULES and v in ENV_RULES[k] for k, v in extra.items()), 'NEW_ENV_FORBIDDEN')
        intended = {**actual, **extra}
        result['services'][name] = {'image': images[name],
                'environment': {k: v.replace('$', '$$') for k, v in intended.items()}}
        expected[name]['image'] = images[name]
        expected[name]['environment'] = intended
    return result, expected


def database_path(row):
    require(envmap(row).get('DB_PATH') == '/app/data/crm_v2.db', 'DB_PATH_CONTRACT_CHANGED')
    mounts = row.get('Mounts') or []
    data = [m for m in mounts if m.get('Destination') == '/app/data']
    require(len(data) == 1 and data[0]['Type'] == 'bind' and data[0].get('RW'), 'DB_BIND_CONTRACT_CHANGED')
    require(all(m['Destination'] == '/app/data' or not
                ('/app'.startswith(m['Destination'].rstrip('/') + '/') or
                 m['Destination'] == '/app' or m['Destination'].startswith('/app/'))
                for m in mounts), 'APP_SOURCE_MOUNT_FORBIDDEN')
    root = pathlib.Path(data[0]['Source'])
    require(root.is_absolute() and root.is_dir(), 'DB_BIND_INVALID')
    db = root / 'crm_v2.db'
    require(db.is_file() and not db.is_symlink(), 'LIVE_DB_MISSING_OR_SYMLINK')
    return db.resolve()


READINESS_JS = r'''
const http=require('http');
const worker=process.env.AVA_PROCESS_ROLE==='provisioning-worker';
const requireWorkerReady=false;
const req=http.get({host:'127.0.0.1',port:worker?3900:Number(process.env.PORT||3000),
 path:worker?'/__ava_release_readiness__':'/api/health',timeout:4000},r=>{
 let body='';r.on('data',b=>{body+=b;if(body.length>8192)req.destroy()});
 r.on('end',()=>{let marker=false;try{marker=JSON.parse(body).ready===true}catch(_){}
 let ok=worker?(requireWorkerReady?r.statusCode===200&&marker:
 (r.statusCode===200&&marker)||(r.statusCode===403&&body.includes('IDENTITY_BROKER_ACCESS_DENIED'))):
 r.statusCode===200;
 if(!ok)process.exitCode=1;else console.log(JSON.stringify({ready:true}));});
});req.on('error',()=>{process.exitCode=1});req.on('timeout',()=>req.destroy());
'''

CANDIDATE_READINESS_JS = READINESS_JS.replace('const requireWorkerReady=false;', 'const requireWorkerReady=true;')


ROLLBACK_ELIGIBILITY_JS = r'''
const SQLite=require('/app/node_modules/better-sqlite3');
let db;
try {
 db=new SQLite(process.env.DB_PATH,{readonly:true,fileMustExist:true});
 db.pragma('busy_timeout=10000');
 const table=(name,columns,optional=false)=>{
  const object=db.prepare('SELECT type FROM sqlite_master WHERE name=?').get(name);
  if(!object){if(optional)return false;throw Error('SCHEMA');}
  if(object.type!=='table')throw Error('SCHEMA');
  const actual=new Set(db.prepare('PRAGMA table_info("'+name+'")').all().map(r=>r.name));
  if(!columns.every(c=>actual.has(c)))throw Error('SCHEMA');
  return true;
 };
 const result=db.transaction(()=>{
  table('ava_invitations',['createdBy','userId','leaseToken']);
  table('ava_identity_outbox',['userId','state']);
  const registrations=table('ava_self_registrations',['state'],true);
  const signup="createdBy LIKE 'self-registration:%'";
  const anySignup=Boolean(db.prepare('SELECT 1 FROM ava_invitations WHERE '+signup+' LIMIT 1').get());
  if(!registrations&&anySignup)throw Error('SCHEMA');
  const barriers={
   invitationLease:Boolean(db.prepare('SELECT 1 FROM ava_invitations WHERE '+signup+' AND leaseToken IS NOT NULL LIMIT 1').get()),
   pendingRevocation:Boolean(db.prepare("SELECT 1 FROM ava_identity_outbox WHERE (state IS NULL OR state!='done') AND userId IN (SELECT userId FROM ava_invitations WHERE "+signup+") LIMIT 1").get()),
   enrollingRegistration:registrations&&Boolean(db.prepare("SELECT 1 FROM ava_self_registrations WHERE state='enrolling' LIMIT 1").get())
  };
  return {schemaValid:true,rollbackEligible:!Object.values(barriers).some(Boolean),barriers};
 })();
 db.close();console.log(JSON.stringify(result));
}catch(_){
 if(db?.open)db.close();
 console.log(JSON.stringify({schemaValid:false,rollbackEligible:false}));
}
'''


class Operator:
    def __init__(self, args):
        self.args = args
        require(not args.release_dir.is_symlink(), 'SYMLINK_RELEASE_DIR')
        self.root = args.release_dir.resolve()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        require(self.root.stat().st_mode & 0o077 == 0, 'RELEASE_DIR_NOT_PRIVATE')
        self.bundle = args.bundle.resolve()
        manifest = contained(self.bundle, 'manifest.json')
        require(HEX.fullmatch(args.manifest_sha256 or '') and sha(manifest) == args.manifest_sha256,
                'MANIFEST_DIGEST_MISMATCH')
        self.m = validate_manifest(json.loads(manifest.read_text()), args.candidate_commit)
        for service in SERVICES:
            for name, wanted in self.m['services'][service]['files'].items():
                require(sha(contained(self.bundle / 'payload' / service, name)) == wanted, 'PAYLOAD_BYTES_CHANGED')
        for field in ('migrationRunner', 'contractRunner'):
            require(sha(contained(self.bundle, self.m[field]['path'])) == self.m[field]['sha256'], 'RUNNER_CHANGED')

    def run(self, args, cwd=None, input=None, timeout=180):
        # Historical chains interpolate other services before target selection.
        # Actual target images are independently pinned by the private override.
        compose_env = ({**os.environ, 'AVA_RELEASE_SHA': self.args.candidate_commit}
                       if args[:2] == ['docker', 'compose'] else None)
        proc = subprocess.run(args, cwd=cwd, input=input, text=True, capture_output=True,
                              timeout=timeout, env=compose_env)
        if proc.returncode:
            private_json(self.root / 'command-failure.private.json', {'commandFamily': args[:2],
                         'stdoutSha256': hashlib.sha256(proc.stdout.encode()).hexdigest(),
                         'stderrSha256': hashlib.sha256(proc.stderr.encode()).hexdigest(),
                         'returncode': proc.returncode})
            raise RuntimeError('COMMAND_FAILED_PRIVATE_LOG')
        return proc.stdout + proc.stderr if args[:2] == ['docker', 'logs'] else proc.stdout

    def set_stage(self, phase, service=None, rollback=False):
        self._release_stage = {'phase': phase, 'service': service, 'rollback': rollback,
                               'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        private_json(self.root / 'apply-progress.private.json', self._release_stage)

    def capture_apply_failure(self, p, error):
        # Preserve the candidate failure BEFORE any rollback probe can replace
        # command-failure.private.json. Never persist raw logs, env or exceptions.
        code = str(error)
        code = code if re.fullmatch(r'[A-Z][A-Z0-9_]{0,100}', code) else 'APPLY_STAGE_FAILED'
        value = {'reason': code, 'stage': copy.deepcopy(getattr(self, '_release_stage', {})),
                 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'runtime': {}}
        command = self.root / 'command-failure.private.json'
        if command.is_file():
            try:
                c = json.loads(command.read_text())
                if set(c) == {'commandFamily', 'stdoutSha256', 'stderrSha256', 'returncode'} and \
                        c['commandFamily'] in [['docker', x] for x in ('exec', 'compose', 'inspect', 'ps', 'run', 'logs')] and \
                        all(HEX.fullmatch(c[k] or '') for k in ('stdoutSha256', 'stderrSha256')) and \
                        isinstance(c['returncode'], int):
                    value['lastCommandFailure'] = c
                    value['lastCommandMayBeTransient'] = True
            except Exception:
                pass
        try:
            for service, row in self.rows(missing=True).items():
                state = row['State']
                info = {'containerId': row['Id'], 'imageId': row['Image'], 'running': state['Running'],
                        'restarting': state.get('Restarting', False), 'exitCode': state.get('ExitCode'),
                        'oomKilled': state.get('OOMKilled', False), 'restartCount': row.get('RestartCount'),
                        'dockerHealth': state.get('Health', {}).get('Status')}
                value['runtime'][service] = info
                if row['Image'] == p['candidateImages'][service]:
                    try:
                        logs = self.run(['docker', 'logs', '--tail', '200', row['Id']], timeout=15)
                        info['logsSha256'] = hashlib.sha256(logs.encode()).hexdigest()
                        info['knownLogCodes'] = [c for c in ('PROVISIONING_WORKER_START_FAILED', 'SQLITE_BUSY',
                            'SQLITE_CONSTRAINT', 'MODULE_NOT_FOUND', 'EADDRINUSE', 'ERR_DLOPEN_FAILED')
                            if re.search(r'\b' + c + r'\b', logs)]
                        diagnostics = []
                        phases = {'DB_INIT', 'IDENTITY_SCHEMA', 'SALES_SCHEMA', 'BROKER_BIND',
                            'LOAD_REVOCATION', 'LOAD_PASSWORD_RECOVERY', 'LOAD_REGISTRATION', 'IDENTITY_TIMER',
                            'LOAD_SYNC_RECOVERY', 'SYNC_RECOVERY_TIMER', 'LOAD_PROVISIONING',
                            'PROVISIONING_POLLER', 'READY', 'BOOTSTRAP'}
                        for line in logs.splitlines()[-200:]:
                            try:
                                event = json.loads(line)
                                if not isinstance(event, dict) or event.get('event') != 'PROVISIONING_WORKER_START_FAILED' or \
                                        event.get('phase') not in phases or not isinstance(event.get('code'), str) or \
                                        len(event['code']) > 80 or not re.fullmatch(
                                            r'(?:SQLITE_[A-Z_]+|ERR_[A-Z_]+|MODULE_NOT_FOUND|EADDRINUSE|EACCES|ENOENT|IDENTITY_[A-Z_]+|WORKER_STARTUP_FAILED)', event['code']):
                                    continue
                                diagnostic = {k: event[k] for k in ('event', 'phase', 'code')}
                                if 'source' in event:
                                    source = event['source']
                                    if not isinstance(source, dict) or set(source) != {'path', 'line'} or \
                                            not isinstance(source['path'], str) or len(source['path']) > 180 or \
                                            not re.fullmatch(r'(?:src/[a-zA-Z0-9_./-]+|provisioning-worker)\.js', source['path']) or \
                                            '..' in source['path'].split('/') or type(source['line']) is not int or source['line'] < 1:
                                        continue
                                    diagnostic['source'] = source
                                diagnostics.append(diagnostic)
                            except (ValueError, TypeError):
                                continue
                        info['startupDiagnostics'] = diagnostics[-4:]
                    except Exception:
                        info['logsUnavailable'] = True
        except Exception:
            value['runtimeCaptureUnavailable'] = True
        private_json(self.root / 'apply-failure.private.json', value)

    def state(self, name, missing=False):
        # Resolve by Compose service, since worker has no fixed container_name.
        ids = self.run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.service=' + name]).split()
        if not ids and missing:
            return None
        require(len(ids) == 1, 'SERVICE_CONTAINER_AMBIGUOUS_OR_MISSING')
        return json.loads(self.run(['docker', 'inspect', ids[0]]))[0]

    def rows(self, missing=False):
        result = {s: self.state(s, missing=missing) for s in SERVICES}
        return {s: r for s, r in result.items() if r is not None}

    def ready(self, row, require_worker_ready=False):
        require(row['State']['Running'] and not row['State'].get('Paused') and not
                row['State'].get('Restarting') and row.get('RestartCount') == 0, 'SERVICE_NOT_STABLE')
        status = row['State'].get('Health', {}).get('Status')
        require(status is None or status == 'healthy', 'SERVICE_NOT_HEALTHY')
        script = CANDIDATE_READINESS_JS if require_worker_ready else READINESS_JS
        require(json.loads(self.run(['docker', 'exec', row['Id'], 'node', '-e', script], timeout=10))
                .get('ready') is True, 'SERVICE_NOT_READY')

    def snapshot_other(self, rows):
        ids = self.run(['docker', 'ps', '-aq']).split()
        all_rows = json.loads(self.run(['docker', 'inspect', *ids])) if ids else []
        own = {r['Id'] for r in rows.values()}
        return {r['Name']: {'id': r['Id'], 'image': r['Image'], 'running': r['State']['Running'],
                'startedAt': r['State'].get('StartedAt'), 'restarts': r.get('RestartCount')}
                for r in all_rows if r['Id'] not in own}

    def config(self, row, override=None):
        cmd, cwd, service = compose(row, override)
        value = copy.deepcopy(json.loads(self.run(cmd + ['config', '--format', 'json'], cwd=cwd))['services'][service])
        value['environment'] = {k: v.replace('$$', '$') if isinstance(v, str) else v
                                for k, v in (value.get('environment') or {}).items()}
        return value

    def inputs(self, row):
        cmd, cwd, _ = compose(row)
        labels = row['Config']['Labels']
        paths = labels['com.docker.compose.project.config_files'].split(',')
        paths += [x for x in labels.get('com.docker.compose.project.environment_file', '').split(',') if x]
        return {'command': cmd, 'cwd': cwd, 'fileHashes': {x: sha(x) for x in paths}}

    def checked_override(self, p, images, rollback=False, service=None):
        # Each service replays ITS OWN ordered historical Compose/env chain.
        # Prod worker and CRM were recreated by different previous releases.
        paths = {}
        for name in ([service] if service else SERVICES):
            actual = envmap(p['before'][name])
            baseline = p['baselineConfig'][name]
            require(set(baseline.get('environment') or {}) <= set(actual), 'ENV_ADDED_ON_DISK')
            extra = {} if rollback else self.m['services'][name].get('environment', {})
            intended = {**actual, **extra}
            payload = {'services': {name: {'image': images[name],
                       'environment': {k: v.replace('$', '$$') for k, v in intended.items()}}}}
            expected = {**copy.deepcopy(baseline), 'image': images[name], 'environment': intended}
            path = self.root / (name + ('.rollback' if rollback else '.candidate') + '.private.override.json')
            private_json(path, payload)
            require(self.config(p['before'][name], path) == expected, 'COMPOSE_CONFIG_CHANGED')
            paths[name] = path
        return paths[service] if service else paths

    def hashes(self, target, image=False):
        cmd = (['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node', target]
               if image else ['docker', 'exec', target, 'node'])
        return json.loads(self.run(cmd + ['-e', HASH_JS], timeout=600))

    def image(self, target):
        return json.loads(self.run(['docker', 'image', 'inspect', target]))[0]

    def runner(self, image, db, field='migrationRunner', mode='migrate'):
        item = self.m[field]
        runner = contained(self.bundle, item['path'])
        require(sha(runner) == item['sha256'], 'RUNNER_CHANGED')
        no_redirect = field == 'contractRunner' and self.no_redirect_recovery()
        control = ['-e', 'AVA_RELEASE_RECOVERY_NO_REDIRECT=1'] if no_redirect else []
        output = self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
                '--entrypoint', 'node', '--mount', f'type=bind,source={db.parent},target=/check',
                '--mount', f'type=bind,source={runner},target=/release/runner.cjs,readonly',
                '-e', 'DB_PATH=/check/' + db.name, '-e', 'AVA_RELEASE_OFFLINE=1',
                *control, image, '/release/runner.cjs', mode], timeout=300)
        result = json.loads(output)
        require(result.get('contractVerified' if field == 'contractRunner' else 'schemaVerified') is True,
                'RUNNER_RECEIPT_INVALID')
        if no_redirect:
            require(result.get('noRedirectRecoveryContractVerified') is True,
                    'NO_REDIRECT_RECOVERY_CONTRACT_UNPROVEN')
        return result

    def snapshot(self, image, db):
        return json.loads(self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node',
                '--mount', f'type=bind,source={db.parent},target=/check,readonly', '-e', 'DB_PATH=/check/' + db.name,
                image, '-e', SNAPSHOT_JS], timeout=300))

    def compatibility(self, image, db):
        result = self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node',
                '--mount', f'type=bind,source={db.parent},target=/check,readonly', '-e', 'DB_PATH=/check/' + db.name,
                image, '-e', COMPAT_JS], timeout=300)
        require(json.loads(result).get('compatibilityOk') is True, 'ROLLBACK_SQLITE_INCOMPATIBLE')

    def backup(self, p, prefix):
        directory = self.root / (prefix + '-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        directory.mkdir(mode=0o700)
        receipt = online_backup(pathlib.Path(p['databasePath']), directory / 'crm_v2.db', validate=False)
        for name in SERVICES:
            self.compatibility(p['baseImages'][name], pathlib.Path(receipt['path']))
        receipt['integrityOk'] = True
        private_json(directory / 'receipt.private.json', receipt)
        return receipt

    def migration_test(self, p, backup):
        directory = pathlib.Path(backup['path']).parent / 'migration-check'
        directory.mkdir(mode=0o700)
        clone = directory / 'crm_v2.db'
        shutil.copyfile(backup['path'], clone)
        candidate = p['candidateImages'][CRM]
        before = self.snapshot(candidate, clone)
        self.runner(candidate, clone)
        after = self.snapshot(candidate, clone)
        assert_additive(before, after, self.m['allowedNewSchema'])
        # Check BOTH implementations are identical/idempotent on the shared DB.
        for name in SERVICES:
            self.runner(p['candidateImages'][name], clone)
            require(self.snapshot(candidate, clone) == after, 'MIGRATION_NOT_IDEMPOTENT')
            self.compatibility(p['baseImages'][name], clone)
            # Isolated synthetic DB only, never the production backup/DB.
            self.runner(p['candidateImages'][name], clone, 'contractRunner', 'smoke')
            require(self.snapshot(candidate, clone) == after, 'CONTRACT_SMOKE_CHANGED_CLONE')
        return {'originalSchemaAndRowsUnchanged': True, 'bothImagesIdempotent': True,
                'bothRollbackImagesCompatible': True, 'offlineContractBothImages': True,
                'noRedirectRecoveryContractVerified': self.no_redirect_recovery(),
                'schemaHash': digest(after['objects'])}

    def database_identity(self, p):
        stat = pathlib.Path(p['databasePath']).stat()
        require({'device': stat.st_dev, 'inode': stat.st_ino} == p['databaseIdentity'], 'DATABASE_INODE_DRIFT')

    def guard(self, p, images, extras=None, check_ready=True):
        rows = self.rows()
        self.database_identity(p)
        for name in SERVICES:
            row, old = rows[name], p['before'][name]
            if check_ready:
                self.ready(row, require_worker_ready=name == 'provisioning_worker' and
                           images[name] != self.m['services'][name]['baseImageId'])
            require(row['Image'] == images[name], 'LIVE_IMAGE_DRIFT')
            require(row['Mounts'] == old['Mounts'] and str(database_path(row)) == p['databasePath'], 'LIVE_MOUNTS_DRIFT')
            require(envmap(row) == {**envmap(old), **((extras or {}).get(name, {}))}, 'LIVE_ENV_DRIFT')
            require(row['Config']['Cmd'] == old['Config']['Cmd'] and
                    row['Config']['Entrypoint'] == old['Config']['Entrypoint'] and
                    row['HostConfig'] == old['HostConfig'], 'CONTAINER_RUNTIME_CONFIG_CHANGED')
            require(self.inputs(old) == p['composeInputs'][name], 'COMPOSE_INPUT_DRIFT')
        require(all(self.config(p['before'][s]) == p['baselineConfig'][s] for s in SERVICES), 'COMPOSE_RESOLVED_DRIFT')
        require(self.snapshot_other(rows) == p['otherContainers'], 'OTHER_CONTAINER_CHANGED')
        return rows

    def validate_feature_configuration(self, rows):
        intended = {s: {**envmap(rows[s]), **self.m['services'][s].get('environment', {})} for s in SERVICES}
        crm, worker = intended[CRM], intended['provisioning_worker']
        require(crm.get('AVA_CUSTOMER_ACCESS_ENABLED') == 'true' and len(crm.get('SESSION_SECRET', '')) >= 32,
                'CRM_IDENTITY_CONFIGURATION_INVALID')
        for service, env in intended.items():
            no_redirect_worker = service == 'provisioning_worker' and self.no_redirect_recovery()
            require(env.get('AVA_OIDC_ISSUER') == 'https://auth.meludtech.tech/realms/ava' and
                    (no_redirect_worker or (env.get('WHATSAPP_CRM_PUBLIC_URL') == 'https://wh.meludtech.tech' and
                     env.get('AVA_OIDC_CLIENT_ID') == 'ava-web')),
                    'RECOVERY_ORIGIN_CLIENT_CONFIGURATION_INVALID')
        require(worker.get('AVA_PROCESS_ROLE') == 'provisioning-worker' and
                worker.get('AVA_IDENTITY_ADMIN_CLIENT_ID') and worker.get('AVA_IDENTITY_ADMIN_CLIENT_SECRET'),
                'WORKER_IDENTITY_CONFIGURATION_INVALID')
        require(len(crm.get('AVA_IDENTITY_BROKER_TOKEN', '')) >= 32 and
                crm['AVA_IDENTITY_BROKER_TOKEN'] == worker.get('AVA_IDENTITY_BROKER_TOKEN'),
                'IDENTITY_BROKER_CONFIGURATION_MISMATCH')

    def capture(self):
        rows = self.rows()
        self.validate_feature_configuration(rows)
        images = {s: self.m['services'][s]['baseImageId'] for s in SERVICES}
        inputs = {s: self.inputs(rows[s]) for s in SERVICES}
        db = database_path(rows[CRM])
        for name in SERVICES:
            self.ready(rows[name])
            require(rows[name]['Image'] == images[name], 'LIVE_BASE_IMAGE_CHANGED')
            require(rows[name]['Config']['Labels']['com.docker.compose.project'] ==
                    rows[CRM]['Config']['Labels']['com.docker.compose.project'], 'COMPOSE_PROJECT_DIFFERENT')
            require(rows[name]['Config']['Labels']['com.docker.compose.service'] == name, 'SERVICE_LABEL_CHANGED')
            require(database_path(rows[name]) == db, 'SHARED_DB_CONTRACT_CHANGED')
        old = {s: self.hashes(rows[s]['Id']) for s in SERVICES}
        for name in SERVICES:
            assert_baseline_source(old[name], self.m['services'][name])
            require(self.hashes(images[name], image=True) == old[name], 'BASE_IMAGE_LIVE_BYTES_DRIFT')
        return {'manifestSha256': self.args.manifest_sha256, 'candidateCommit': self.args.candidate_commit,
                'before': rows, 'baseImages': images, 'databasePath': str(db),
                'databaseIdentity': {'device': db.stat().st_dev, 'inode': db.stat().st_ino}, 'oldHashes': old,
                'composeInputs': inputs, 'baselineConfig': {s: self.config(rows[s]) for s in SERVICES},
                'otherContainers': self.snapshot_other(rows)}

    def no_redirect_recovery(self):
        return self.m['services']['provisioning_worker'].get('environment', {}).get(
            'AVA_PASSWORD_RECOVERY_NO_REDIRECT') == 'true'

    def keycloak_check(self, applied=False):
        if self.no_redirect_recovery():
            # Both image smokes must separately prove the exact request shape.
            # This mode grants no new admin privilege and makes no SMTP claim.
            return {'mode': 'no_redirect', 'clientMutationRequired': False,
                    'smtpReadiness': 'unverified', 'mailSent': False}
        # Same-process read-only gate; separate CLI owns the scoped Keycloak PUT.
        import importlib.util
        spec = importlib.util.spec_from_file_location('ava_keycloak_release', pathlib.Path(__file__).with_name('keycloak_operator.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        require(self.args.keycloak_state is not None, 'KEYCLOAK_PLAN_REQUIRED')
        kc = module.KeycloakOperator(self.args.keycloak_state, getattr(self.args, 'keycloak_container', None))
        kc.smtp_password_file = getattr(self.args, 'smtp_password_file', None)
        state = kc.load()
        current = kc.read_client()
        require(current == state['after'] if applied else current in (state['before'], state['after']),
                'KEYCLOAK_RELEASE_STATE_DRIFT')
        smtp = kc.smtp()
        return {'mode': 'trusted_redirect', 'clientStateVerified': True, 'smtp': smtp}

    def audit(self):
        # Docker inspect/exec/config only: no image build/tag/up, DB write or backup.
        p = self.capture()
        self.guard(p, p['baseImages'])
        self.receipt('audited', p, productionMutation=False, sourceFence=True, composeContract=True)

    def prepare(self):
        require(not (self.root / 'prepared.private.json').exists(), 'RELEASE_ALREADY_PREPARED')
        p = self.capture()
        recovery = self.keycloak_check()
        p['candidateImages'], p['candidateHashes'] = {}, {}
        for name in SERVICES:
            base = p['baseImages'][name]
            base_tag = 'ava-registration-base-' + ('crm' if name == CRM else 'worker') + ':' + self.args.candidate_commit[:12]
            self.run(['docker', 'tag', base, base_tag])
            require(self.image(base_tag)['Id'] == base, 'PINNED_BUILD_BASE_DRIFT')
            context = self.root / ('build-' + name)
            context.mkdir(mode=0o700)
            for rel in self.m['services'][name]['files']:
                target = context / 'payload' / rel
                target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                shutil.copyfile(contained(self.bundle / 'payload' / name, rel), target)
                target.chmod(0o644)
            # mkdir modes are filtered by the private operator umask (077).
            # COPY preserves source directory modes, so normalize application
            # directories explicitly for the saved non-root runtime user.
            # The build context and all release-state/env files stay private.
            payload = context / 'payload'
            for directory in [payload, *payload.rglob('*')]:
                require(not directory.is_symlink(), 'SYMLINK_BUILD_PAYLOAD')
                if directory.is_dir():
                    directory.chmod(0o755)
            chmod, access_probe = overlay_permissions(self.m['services'][name]['files'])
            # Normalize the final image as well: BuildKit COPY can retain or
            # synthesize destination modes independently of context modes.
            require(self.image(base)['Config'].get('User', '') in ('', '0', '0:0', 'root', 'root:root'),
                    'BUILD_ROOT_USER_REQUIRED')
            (context / 'Dockerfile').write_text('FROM ' + base_tag + '\nCOPY --chown=0:0 payload/ /app/\nRUN ' +
                                              json.dumps(['node', '-e', chmod]) + '\n')
            tag = self.m['services'][name]['candidateTag']
            self.run(['docker', 'build', '--network', 'none', '--pull=false', '-t', tag, str(context)], timeout=900)
            require(self.image(base_tag)['Id'] == base, 'PINNED_BUILD_BASE_DRIFT')
            candidate = self.image(tag)
            pinned = self.image(base)
            require(candidate['Config'] == pinned['Config'], 'IMAGE_RUNTIME_CONFIG_CHANGED')
            layers = pinned['RootFS']['Layers']
            require(candidate['RootFS']['Layers'][:len(layers)] == layers, 'PINNED_PARENT_LAYERS_CHANGED')
            expected = {**p['oldHashes'][name], **self.m['services'][name]['files']}
            require(self.hashes(candidate['Id'], image=True) == expected, 'CANDIDATE_BYTES_MISMATCH')
            user = p['before'][name]['Config'].get('User') or candidate['Config'].get('User') or '0'
            access = self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only',
                              '--user', user, '--entrypoint', 'node', candidate['Id'], '-e', access_probe], timeout=60)
            require(json.loads(access).get('overlayReadable') is True, 'CANDIDATE_RUNTIME_ACCESS_DENIED')
            p['candidateImages'][name], p['candidateHashes'][name] = candidate['Id'], expected
        self.checked_override(p, p['candidateImages'])
        self.checked_override(p, p['baseImages'], rollback=True)
        backup = self.backup(p, 'prepare-backup')
        migration = self.migration_test(p, backup)
        self.guard(p, p['baseImages'])
        private_json(self.root / 'prepared.private.json', p)
        self.receipt('prepared', p, backup=backup, migration=migration, recoveryPrerequisite=recovery)

    def load(self, check_candidate=True):
        p = json.loads(contained(self.root, 'prepared.private.json').read_text())
        require(p['manifestSha256'] == self.args.manifest_sha256 and
                p['candidateCommit'] == self.args.candidate_commit, 'PREPARED_RELEASE_MISMATCH')
        for name in SERVICES:
            require(p['baseImages'][name] == self.m['services'][name]['baseImageId'], 'BASE_IMAGE_CHANGED')
            image_sets = [('baseImages', 'oldHashes')]
            if check_candidate:
                image_sets.append(('candidateImages', 'candidateHashes'))
            for field, hashes in image_sets:
                require(self.hashes(p[field][name], image=True) == p[hashes][name], 'PINNED_IMAGE_BYTES_DRIFT')
        return p

    def public(self, hashes):
        files = {k.removeprefix('frontend/dist/'): v for k, v in hashes.items() if k.startswith('frontend/dist/')}
        require('index.html' in files, 'PUBLIC_FRONTEND_MISSING')
        def get(path):
            url = self.m['publicBaseUrl'] + path
            with urllib.request.urlopen(urllib.request.Request(url, headers={'Cache-Control': 'no-cache'}), timeout=20) as res:
                require(res.status == 200 and res.geturl() == url, 'PUBLIC_HTTPS_RESPONSE_CHANGED')
                return hashlib.sha256(res.read()).hexdigest()
        for path in self.m['publicRoutes']:
            require(get(path) == files['index.html'], 'PUBLIC_ROUTE_BYTES_MISMATCH')
        for rel, wanted in files.items():
            require(get('/' + rel) == wanted, 'PUBLIC_ASSET_BYTES_MISMATCH')
        return {'https': True, 'routes': self.m['publicRoutes'], 'fileCount': len(files), 'filesHash': digest(files)}

    def verify_installed(self, p, rollback=False):
        images = p['baseImages' if rollback else 'candidateImages']
        hashes = p['oldHashes' if rollback else 'candidateHashes']
        self.set_stage('installed_recovery_prerequisite', rollback=rollback)
        recovery = None if rollback else self.keycloak_check(applied=True)
        extras = None if rollback else {s: self.m['services'][s].get('environment', {}) for s in SERVICES}
        self.set_stage('installed_runtime_guard', rollback=rollback)
        rows = self.guard(p, images, extras)
        for name in SERVICES:
            self.set_stage('installed_bytes', name, rollback)
            require(self.hashes(rows[name]['Id']) == hashes[name], 'INSTALLED_BYTES_MISMATCH')
        self.set_stage('public_bytes', CRM, rollback)
        public = self.public(hashes[CRM])
        self.set_stage('final_runtime_guard', rollback=rollback)
        self.guard(p, images, extras)
        return {'bothServicesReady': True, 'zeroRestarts': True, 'sharedDatabaseBindVerified': True,
                'otherContainersUnchanged': True, 'runtimeHashes': {s: digest(hashes[s]) for s in SERVICES},
                'public': public, 'recoveryPrerequisite': recovery}

    def up(self, p, rollback=False):
        images = p['baseImages' if rollback else 'candidateImages']
        # Worker first; CRM only exposes new endpoints after worker readiness.
        # Rollback CRM first closes new endpoints, then restores worker.
        order = SERVICES if rollback else tuple(reversed(SERVICES))
        for name in order:
            self.set_stage('compose_recreate', name, rollback)
            override = self.checked_override(p, images, rollback, service=name)
            cmd, cwd, _ = compose(p['before'][name], override)
            self.run(cmd + ['up', '-d', '--no-deps', '--pull', 'never', '--force-recreate', name], cwd=cwd)
            self.set_stage('readiness', name, rollback)
            deadline = time.monotonic() + 120
            observed = None
            while True:
                row = self.state(name)
                try:
                    self.ready(row, require_worker_ready=name == 'provisioning_worker' and not rollback)
                    require(row['Image'] == images[name], 'RECREATED_IMAGE_MISMATCH')
                    require(row['Mounts'] == p['before'][name]['Mounts'], 'RECREATED_MOUNTS_MISMATCH')
                    additions = {} if rollback else self.m['services'][name].get('environment', {})
                    require(envmap(row) == {**envmap(p['before'][name]), **additions}, 'RECREATED_ENV_MISMATCH')
                    if observed == row['Id']:
                        break
                    observed = row['Id']
                except RuntimeError:
                    observed = None
                require(time.monotonic() < deadline and row.get('RestartCount') == 0, 'SERVICE_READINESS_TIMEOUT')
                time.sleep(5)

    def apply(self):
        p = self.load()
        self.keycloak_check(applied=True)
        rows = self.guard(p, p['baseImages'])
        for name in SERVICES:
            require(self.hashes(rows[name]['Id']) == p['oldHashes'][name], 'LIVE_BYTES_DRIFT')
        backup = self.backup(p, 'apply-backup')
        migration = self.migration_test(p, backup)
        require(time.time() - backup['createdAt'] < 300 and sha(backup['path']) == backup['sha256'], 'BACKUP_NOT_FRESH')
        self.guard(p, p['baseImages'])
        private_json(self.root / 'apply-started.private.json', {'backup': backup, 'images': p['candidateImages']})
        try:
            self.set_stage('live_migration')
            self.runner(p['candidateImages'][CRM], pathlib.Path(p['databasePath']))
            self.set_stage('live_schema_verification')
            objects = self.snapshot(p['candidateImages'][CRM], pathlib.Path(p['databasePath']))['objects']
            require(all(objects.get(o['name']) == o for o in self.m['allowedNewSchema']), 'LIVE_SCHEMA_MISMATCH')
            self.up(p)
            health = self.verify_installed(p)
        except Exception as apply_error:
            try:
                self.capture_apply_failure(p, apply_error)
            except Exception:
                # Diagnostic storage failure must never prevent safe rollback.
                pass
            try:
                self.rollback(p, automatic=True)
            except Exception as rollback_error:
                if str(rollback_error) in ('ROLLBACK_IDENTITY_RECONCILIATION_REQUIRED', 'ROLLBACK_ELIGIBILITY_SCHEMA_INVALID'):
                    raise RuntimeError(str(rollback_error)) from None
                raise RuntimeError('APPLY_AND_ROLLBACK_FAILED_PRIVATE_LOG') from None
            raise RuntimeError('APPLY_FAILED_ROLLED_BACK_DATABASE_RETAINED') from None
        self.receipt('applied', p, backup=backup, migration=migration, health=health)

    def quiesce(self, p, rows):
        # Close all registration ingress before draining/stopping the broker.
        # Process exit/timeout is NEVER evidence a dispatched remote write ended.
        for name in SERVICES:
            row = rows.get(name)
            if row and row['State']['Running']:
                self.run(['docker', 'stop', '-t', '35', row['Id']], timeout=60)
        current = self.rows(missing=True)
        for name, row in current.items():
            require(name in rows and row['Id'] == rows[name]['Id'] and not row['State']['Running'] and
                    not row['State'].get('Restarting') and not row['State'].get('Paused'),
                    'ROLLBACK_QUIESCE_FAILED')
        require(self.snapshot_other(current) == p['otherContainers'], 'ROLLBACK_OTHER_CONTAINER_DRIFT')
        self.database_identity(p)
        return current

    def rollback_eligibility(self, p, backup):
        path = pathlib.Path(backup['path'])
        output = self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node',
                '--mount', f'type=bind,source={path.parent},target=/check,readonly',
                '-e', 'DB_PATH=/check/' + path.name, p['baseImages'][CRM], '-e', ROLLBACK_ELIGIBILITY_JS])
        value = json.loads(output)
        require(isinstance(value.get('schemaValid'), bool) and isinstance(value.get('rollbackEligible'), bool),
                'ROLLBACK_ELIGIBILITY_RECEIPT_INVALID')
        if value['schemaValid']:
            require(set(value.get('barriers', {})) == {'invitationLease', 'pendingRevocation', 'enrollingRegistration'}
                    and all(isinstance(v, bool) for v in value['barriers'].values()) and
                    value['rollbackEligible'] == (not any(value['barriers'].values())),
                    'ROLLBACK_ELIGIBILITY_RECEIPT_INVALID')
        else:
            require(value['rollbackEligible'] is False, 'ROLLBACK_ELIGIBILITY_RECEIPT_INVALID')
        return {**value, 'gateSha256': hashlib.sha256(ROLLBACK_ELIGIBILITY_JS.encode()).hexdigest(),
                'databaseSha256': backup['sha256'], 'ingressAndWorkerQuiesced': True}

    def rollback(self, p=None, automatic=False):
        p = p or self.load(check_candidate=False)
        rows = self.rows(missing=True)
        require(database_path(p['before'][CRM]) == pathlib.Path(p['databasePath']), 'ROLLBACK_DB_PATH_DRIFT')
        self.database_identity(p)
        for name in rows:
            require(rows[name]['Image'] in (p['baseImages'][name], p['candidateImages'][name]), 'ROLLBACK_IMAGE_DRIFT')
            require(rows[name]['Mounts'] == p['before'][name]['Mounts'] and
                    str(database_path(rows[name])) == p['databasePath'], 'ROLLBACK_BIND_DRIFT')
            require(envmap(rows[name]) in (envmap(p['before'][name]),
                    {**envmap(p['before'][name]), **self.m['services'][name].get('environment', {})}), 'ROLLBACK_ENV_DRIFT')
        require(all(self.inputs(p['before'][s]) == p['composeInputs'][s] and
                self.config(p['before'][s]) == p['baselineConfig'][s] for s in SERVICES), 'ROLLBACK_COMPOSE_DRIFT')
        require(self.snapshot_other(rows) == p['otherContainers'], 'ROLLBACK_OTHER_CONTAINER_DRIFT')
        self.quiesce(p, rows)
        backup = self.backup(p, 'rollback-backup')
        eligibility = self.rollback_eligibility(p, backup)
        if not eligibility['schemaValid'] or not eligibility['rollbackEligible']:
            self.receipt('rollback_blocked', p, backup=backup, rollbackGate=eligibility,
                         automatic=automatic, databaseRestored=False, bothAppsStopped=True)
            raise RuntimeError('ROLLBACK_IDENTITY_RECONCILIATION_REQUIRED' if eligibility['schemaValid']
                               else 'ROLLBACK_ELIGIBILITY_SCHEMA_INVALID')
        self.up(p, rollback=True)
        health = self.verify_installed(p, rollback=True)
        self.receipt('rolled_back', p, backup=backup, health=health, automatic=automatic,
                     databaseRestored=False, rollbackGate=eligibility)

    def verify(self):
        p = self.load()
        rows = self.rows()
        if all(rows[s]['Image'] == p['baseImages'][s] for s in SERVICES):
            self.guard(p, p['baseImages'])
            backup = self.backup(p, 'verify-backup')
            self.receipt('verified_preapply', p, backup=backup, migration=self.migration_test(p, backup))
        else:
            self.receipt('verified', p, health=self.verify_installed(p))

    def receipt(self, phase, p, **extra):
        # Whitelist receipt fields: never emit compose, env, inspect or row captures.
        if 'backup' in extra:
            extra['backup'] = {k: extra['backup'][k] for k in ('sha256', 'createdAt', 'integrityOk', 'method')}
        value = {'phase': phase, 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'candidateCommit': self.args.candidate_commit, 'baseCommit': self.m['baseCommit'],
                'manifestSha256': self.args.manifest_sha256,
                'servicesBaseCommits': {s: self.m['services'][s]['baseCommit'] for s in SERVICES}, 'baseImages': p['baseImages'],
                'candidateImages': p.get('candidateImages'), **extra}
        private_json(self.root / (phase + '.receipt.json'), value)
        print(json.dumps(value), flush=True)


def main():
    import fcntl
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['audit', 'prepare', 'verify', 'apply', 'rollback'])
    parser.add_argument('--bundle', type=pathlib.Path, required=True)
    parser.add_argument('--release-dir', type=pathlib.Path, required=True)
    parser.add_argument('--candidate-commit', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--keycloak-state', type=pathlib.Path)
    parser.add_argument('--keycloak-container')
    parser.add_argument('--smtp-password-file', type=pathlib.Path)
    args = parser.parse_args()
    try:
        operator = Operator(args)
        # One lock per Docker host, including different release directories.
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
    sys.exit(main())
