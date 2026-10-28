#!/usr/bin/env python3
"""Exercise the real fixed Twenty recipe on disposable, unexposed volumes.

This proves bootstrap/native-session behavior, not public buyer acceptance.
No production database, credential, network or volume is used.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
import uuid

import module_deployment_helper as helper
from twenty_recipe_factory import TwentyRecipeFactory, encoded

BASE = Path('/opt/ava-acceptance/ecosystem-20260914')


def private(path, value):
    with path.open('x', encoding='utf-8') as output:
        os.chmod(path, 0o600)
        output.write(json.dumps(value, sort_keys=True) + '\n')


def qa_gateway_networks():
    for name in ('ava-module-ingress', 'ava-module-access'):
        names = helper.run(['docker', 'network', 'ls', '--format', '{{.Name}}'], timeout=10).splitlines()
        if name not in names:
            helper.run(['docker', 'network', 'create', '--internal', '--label', 'tech.melud.ava.qa-shared=ecosystem-20260914', name], timeout=10)
        item = json.loads(helper.run(['docker', 'network', 'inspect', name], timeout=10))[0]
        if item.get('Internal') is not True or item.get('Labels', {}).get('tech.melud.ava.qa-shared') != 'ecosystem-20260914':
            raise ValueError('QA_SHARED_NETWORK_NOT_OWNED')


def initialize(directory, image, business, gateway_image=None):
    if os.geteuid() != 0 or directory.parent != BASE or directory.exists() or not directory.name.startswith('twenty-recipe-qa-') or business not in (900011, 900012):
        raise ValueError('NEW_ISOLATED_QA_DIRECTORY_REQUIRED')
    if not helper.DIGEST.fullmatch(image):
        raise ValueError('IMMUTABLE_IMAGE_REQUIRED')
    if gateway_image is not None and not helper.DIGEST.fullmatch(gateway_image):
        raise ValueError('IMMUTABLE_IMAGE_REQUIRED')
    budget = 4352 if gateway_image else 4096
    memory = {key: int(value.split()[0]) for key, value in (line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())}
    if memory['MemAvailable'] - budget * 1024 < memory['MemTotal'] * .2:
        raise ValueError('QA_CAPACITY_REQUIRED')
    for value in (image, 'sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685', 'sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf'):
        if json.loads(helper.run(['docker', 'image', 'inspect', value], timeout=15))[0]['Id'] != value:
            raise ValueError('INSTALLED_IMMUTABLE_IMAGE_REQUIRED')
    if gateway_image:
        if json.loads(helper.run(['docker', 'image', 'inspect', gateway_image], timeout=15))[0]['Id'] != gateway_image:
            raise ValueError('INSTALLED_IMMUTABLE_IMAGE_REQUIRED')
        qa_gateway_networks()
    os.umask(0o077)
    directory.mkdir(mode=0o700)
    deployment, token = str(uuid.uuid4()), str(uuid.uuid4())
    row = {'id': deployment, 'businessId': business, 'module': 'twenty', 'revision': 1,
           'hostname': f'recipe-qa-{business}.crm.meludtech.tech', 'namespace': 'ava_' + deployment.replace('-', ''),
           'sourceCommit': helper.PINNED['twenty'], 'reservedMemoryMiB': budget}
    payload = {'deploymentId': deployment, 'businessId': business, 'revision': 1, 'leaseToken': token}
    catalogue = {'schemaVersion': 1, 'sourceCommit': row['sourceCommit'], 'nativeImage': image,
        'postgresImage': 'sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
        'redisImage': 'sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf',
        'postgresUid': 70, 'postgresGid': 70, 'redisUid': 999, 'redisGid': 1000}
    if gateway_image: catalogue['gateway'] = {'image': gateway_image, 'brokerOrigin': 'http://ava-module-access:3901'}
    private(directory / 'catalogue.json', catalogue)
    database = directory / 'synthetic.sqlite'
    with sqlite3.connect(database) as db:
        db.executescript('''CREATE TABLE instances(id INTEGER PRIMARY KEY,isActive INTEGER,name TEXT);
            CREATE TABLE ava_module_deployments(id TEXT PRIMARY KEY,businessId INTEGER,module TEXT,
                hostname TEXT,namespace TEXT,sourceCommit TEXT,revision INTEGER,state TEXT,
                leaseToken TEXT,leasedUntil INTEGER,reservedMemoryMiB INTEGER);''')
        db.execute('INSERT INTO instances VALUES(?,1,?)', (business, f'AVA QA {business}'))
        db.execute('INSERT INTO ava_module_deployments VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            (deployment, business, 'twenty', row['hostname'], row['namespace'], row['sourceCommit'], 1,
             'provisioning', token, int(time.time()*1000) + 60000, budget))
    private(directory / 'manifest.json', {'qa_only': True, 'row': row, 'payload': payload, 'image': image, 'gateway_image': gateway_image})


def execute(directory, phase):
    if os.geteuid() != 0 or directory.parent != BASE or not directory.name.startswith('twenty-recipe-qa-'):
        raise ValueError('ISOLATED_QA_DIRECTORY_REQUIRED')
    _, manifest = helper.private_json(directory / 'manifest.json')
    row, payload = manifest['row'], manifest['payload']
    if manifest.get('qa_only') is not True or row['businessId'] not in (900011, 900012) or row['namespace'] != 'ava_' + row['id'].replace('-', ''):
        raise ValueError('QA_SCOPE_REQUIRED')
    database = directory / 'synthetic.sqlite'
    factory = TwentyRecipeFactory(directory, directory / 'catalogue.json', database)
    launcher = helper.Deployments(database, directory, recipe_factory=factory)
    stop = threading.Event()
    def heartbeat():
        while not stop.is_set():
            with sqlite3.connect(database) as db:
                db.execute('UPDATE ava_module_deployments SET leasedUntil=? WHERE id=? AND state=? AND leaseToken=?',
                    (int(time.time()*1000) + 60000, row['id'], 'provisioning', payload['leaseToken']))
            if stop.wait(10): break
    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    # Renew synchronously before the first strict helper lease check.
    with sqlite3.connect(database) as db:
        db.execute('UPDATE ava_module_deployments SET leasedUntil=? WHERE id=? AND state=?',
            (int(time.time()*1000) + 60000, row['id'], 'provisioning'))
    checks = {}
    try:
        if phase == 'launch':
            state = launcher.execute('reconcile', payload)['state']
            checks['fixed_recipe_prepared'] = True
            launcher.execute('provision', payload)
            for _ in range(120):
                if launcher.execute('reconcile', payload)['state'] == 'running': break
                if stop.wait(2): break
            else: raise ValueError('NATIVE_HEALTH_NOT_READY')
            checks['real_native_running'] = launcher.execute('reconcile', payload)['state'] == 'running'
            containers = launcher._containers(row['id'])
            checks['six_owned_services' if manifest.get('gateway_image') else 'five_owned_services'] = len(containers) == (6 if manifest.get('gateway_image') else 5)
            checks['no_published_ports'] = all(not c['HostConfig'].get('PortBindings') for c in containers)
            checks['only_owned_mounts'] = all(m['Source'].startswith(str(directory / row['id'] / 'config') + '/') if m['Type'] == 'bind'
                else m['Type'] == 'volume' and m['Name'].startswith(row['namespace'] + '_') for c in containers for m in c['Mounts'])
            network = json.loads(helper.run(['docker', 'network', 'inspect', row['namespace'] + '_native'], timeout=15))[0]
            checks['internal_network'] = network['Internal'] is True
            checks['health_not_buyer_acceptance'] = False
            try: launcher.execute('verify', payload)
            except helper.DeploymentError as error: checks['health_not_buyer_acceptance'] = str(error) == 'DEPLOYMENT_NATIVE_VERIFIER_REQUIRED'
        elif phase == 'schema-key':
            import subprocess
            root, recipe, compose = launcher._recipe(row)
            if launcher._state(row, compose) != 'running': raise ValueError('QA_CONTOUR_NOT_RUNNING')
            script = Path(__file__).resolve().parents[1] / 'native_modules/twenty/qa/schema-key-probe.cjs'
            helper.owned_path(script)
            destination = '/app/packages/twenty-server/dist/ava-native/qa/schema-key-probe.cjs'
            # A temporary initializer receives its existing isolated credential
            # volume. Nothing is mounted into the running browser/gateway.
            output = subprocess.run(['docker', 'compose', '--project-name', row['namespace'], '-f', str(root / 'compose.json'),
                                     'run', '--rm', '--no-deps', '-e', 'AVA_NATIVE_QA=true', '-e', 'NODE_OPTIONS=',
                                     '--volume', str(script) + ':' + destination + ':ro', '--entrypoint', 'node', 'initializer', destination],
                                    text=True, capture_output=True, timeout=150, env=helper.SAFE_ENV)
            if output.returncode or len(output.stdout) > 16384:
                import re
                safe = re.findall(r'^QA_[A-Z_]{1,64}$', output.stderr, re.MULTILINE)
                raise ValueError(safe[-1] if safe else 'QA_SCHEMA_KEY_FAILED')
            proof = json.loads(output.stdout)
            expected = {'context_scope', 'schema_replay_zero_creates', 'runtime_replay_same_key',
                        'runtime_secret_unchanged_on_replay', 'runtime_file_0600', 'native_signature_valid',
                        'native_key_active', 'native_role_scope_exact', 'rotation_new_active',
                        'rotation_old_revoked', 'foreign_revision_refused'}
            if proof.get('qa_only') is not True or proof.get('buyer_acceptance') is not False \
                    or proof.get('business_id') != row['businessId'] or proof.get('deployment_id') != row['id'] \
                    or set(proof.get('checks', {})) != expected or any(value is not True for value in proof['checks'].values()):
                raise ValueError('QA_SCHEMA_KEY_FAILED')
            checks.update(proof['checks'])
        elif phase in ('records', 'custom-records'):
            import subprocess
            root, recipe, compose = launcher._recipe(row)
            if launcher._state(row, compose) != 'running': raise ValueError('QA_CONTOUR_NOT_RUNNING')
            native = [c for c in launcher._containers(row['id']) if c['Config']['Labels']['com.docker.compose.service'] == 'native'][0]['Id']
            script = Path(__file__).resolve().parents[1] / 'native_modules/twenty/qa/crm-records-probe.cjs'
            helper.owned_path(script)
            output = subprocess.run(['docker', 'exec', '-i', '-e', 'AVA_NATIVE_QA=true', '-e', 'AVA_QA_CRM_CUSTOM=' + ('true' if phase == 'custom-records' else 'false'), '-e', 'NODE_OPTIONS=', native, 'node'],
                                    input=script.read_text(), text=True, capture_output=True, timeout=90, env=helper.SAFE_ENV)
            if output.returncode or len(output.stdout) > 16384: raise ValueError('QA_CRM_RECORDS_FAILED')
            proof = json.loads(output.stdout)
            expected = {f'{role}_native_{action}' for role in ('manager', 'hotel_owner') for action in ('create', 'readback', 'update', 'revoke')}
            if phase == 'custom-records':
                expected |= {f'{role}_native_{name}_readback' for role in ('manager', 'hotel_owner') for name in
                             ('avaCall', 'avaCampaign', 'avaCampaignMember', 'avaCallAttempt', 'avaFollowUpDraft', 'avaCustomerIdentity', 'avaBookingRequest')}
            if proof.get('qa_only') is not True or proof.get('buyer_acceptance') is not False or proof.get('business_id') != row['businessId'] \
                    or proof.get('deployment_id') != row['id'] or set(proof.get('checks', {})) != expected \
                    or any(value is not True for value in proof['checks'].values()):
                raise ValueError('QA_CRM_RECORDS_FAILED')
            checks.update(proof['checks'])
        elif phase == 'enrollment':
            first = launcher.execute('enrollment', payload)
            again = launcher.execute('enrollment', payload)
            checks['stable_enrollment_replay'] = first == again
            checks['enrollment_exact_scope'] = all(first[key] == value for key, value in launcher.identity(row).items())
            checks['adapter_id_is_deployment'] = first['adapterId'] == row['id']
            checks['hash_only_receipt'] = set(first) == {*helper.IDENTITY, 'adapterId', 'nativeScope', 'peerSecretHash'}
            key = (directory / row['id'] / 'config/broker-peer.key').read_bytes()
            checks['broker_hash_matches_durable_key'] = first['peerSecretHash'] == hashlib.sha256(key).hexdigest() and key.decode() not in json.dumps(first)
            gateway = [c for c in launcher._containers(row['id']) if c['Config']['Labels']['com.docker.compose.service'] == 'gateway'][0]
            # An anonymous request must reach the configured host guard but not
            # gain access while broker/native customer enrollment is incomplete.
            code = "const http=require('http');const c=require('/run/ava/gateway.json');const request=p=>new Promise((ok,no)=>{const r=http.get({host:'127.0.0.1',port:4080,path:p,headers:{host:new URL(c.publicOrigin).host}},s=>{s.resume();s.on('end',()=>ok({status:s.statusCode,location:s.headers.location||'',cookie:s.headers['set-cookie']||[]}))});r.on('error',no)});(async()=>{const a=await request('/ava-auth/start'),b=await request('/');process.stdout.write(JSON.stringify({start:a.status===302&&new URL(a.location).origin===c.avaOrigin,denied:b.status===403,noSession:b.cookie.length===0}))})().catch(()=>process.exit(1))"
            proof = json.loads(helper.run(['docker', 'exec', gateway['Id'], 'node', '-e', code], timeout=10))
            checks['gateway_ava_entry_redirect'] = proof['start']
            checks['unenrolled_access_denied'] = proof['denied'] and proof['noSession']
            # Enrollment never changes the deployment's verification state.
            checks['enrollment_not_buyer_acceptance'] = launcher._lease(payload)['state'] == 'provisioning'
        elif phase in ('probe', 'repeat', 'restart'):
            root, recipe, compose = launcher._recipe(row)
            if launcher._state(row, compose) != 'running': raise ValueError('QA_CONTOUR_NOT_RUNNING')
            containers = launcher._containers(row['id'])
            by_service = {c['Config']['Labels']['com.docker.compose.service']: c for c in containers}
            native = by_service['native']['Id']
            def node(code, timeout=30):
                return helper.run(['docker', 'exec', '-e', 'NODE_OPTIONS=', native, 'node', '-e', code], timeout=timeout)
            # Returned context contains IDs only; cookies stay inside /tmp in QA.
            context = json.loads(node("process.stdout.write(require('fs').readFileSync('/run/ava-bootstrap/bootstrap.json','utf8'))"))
            checks['context_scope'] = context['businessId'] == row['businessId'] and context['deploymentId'] == row['id'] and context['revision'] == row['revision']
            readback = json.loads(node("const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.PG_DATABASE_URL});await c.connect();const r=await c.query('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');const w=await c.query('SELECT count(*)::int AS n FROM core.workspace');const l=await c.query('SELECT count(*)::int AS n FROM public.ava_bootstrap');process.stdout.write(JSON.stringify({limited:r.rows[0].rolsuper===false&&r.rows[0].rolcreatedb===false&&r.rows[0].rolcreaterole===false,workspaces:w.rows[0].n,ledgers:l.rows[0].n}));await c.end()})().catch(()=>process.exit(1))"))
            checks['database_role_limited'] = readback['limited']
            checks['one_workspace_one_claim'] = readback['workspaces'] == 1 and readback['ledgers'] == 1
            if phase == 'repeat':
                factory.prepare(row)
                helper.run(['docker', 'start', '--attach', by_service['initializer']['Id']], timeout=480)
                after = json.loads(node("process.stdout.write(require('fs').readFileSync('/run/ava-bootstrap/bootstrap.json','utf8'))"))
                checks['repeat_kept_exact_native_ids'] = after == context
                checks['repeat_initializer_success'] = launcher.execute('reconcile', payload)['state'] == 'running'
            else:
                # Restart is a standalone phase, not dependent on a prior probe
                # having left a context in the container's disposable tmpfs.
                node("const fs=require('fs');fs.copyFileSync('/run/ava-bootstrap/bootstrap.json','/tmp/ava-recipe-qa-context.json');fs.chmodSync('/tmp/ava-recipe-qa-context.json',0o600)")
                def probe(mode):
                    env = {'NODE_OPTIONS': '', 'AVA_NATIVE_QA': 'true', 'AVA_QA_CONTEXT_FILE': '/tmp/ava-recipe-qa-context.json',
                           'AVA_QA_PEER_URL': 'http://127.0.0.1:3902', 'AVA_QA_TWENTY_URL': 'http://127.0.0.1:3000',
                           'AVA_QA_PRIVATE_HOSTS': '127.0.0.1', 'AVA_QA_MODE': mode}
                    args = ['docker', 'exec']
                    for key, value in env.items(): args += ['-e', key + '=' + value]
                    helper.run([*args, native, 'node', 'dist/ava-native/qa/acceptance-probe.cjs'], timeout=30)
                probe('mint'); checks['real_native_user_session_created'] = True
                probe('resolve'); checks['native_graphql_resolves_user'] = True
                if phase == 'restart':
                    # tmpfs credentials disappear on restart. Preserve only the
                    # probe file in root-private QA storage and restore via stdin.
                    cookie_context = node("process.stdout.write(require('fs').readFileSync('/tmp/ava-recipe-qa-context.json','utf8'))")
                    helper.run(['docker', 'restart', '--timeout', '15', native], timeout=45)
                    for _ in range(60):
                        try:
                            node("fetch('http://127.0.0.1:3902/v1/sessions/create',{method:'POST'}).then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))", timeout=5); break
                        except helper.DeploymentError: stop.wait(2)
                    else: raise ValueError('QA_RESTART_NOT_READY')
                    import subprocess
                    result = subprocess.run(['docker','exec','-i','-e','NODE_OPTIONS=',native,'node','-e',
                        "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>require('fs').writeFileSync('/tmp/ava-recipe-qa-context.json',s,{mode:0o600}))"],
                        input=cookie_context, text=True, capture_output=True, timeout=10)
                    if result.returncode: raise ValueError('QA_CONTEXT_RESTORE_FAILED')
                    probe('resolve'); checks['native_session_survives_restart'] = True
                probe('revoke'); checks['native_revoke_denied_including_cache'] = True
        else:
            raise ValueError('QA_PHASE_INVALID')
        result = {'qa_only': True, 'buyer_acceptance': False, 'phase': phase, 'business_id': row['businessId'],
                  'deployment_id': row['id'], 'native_image': manifest['image'], 'checks': checks}
        private(directory / f'{phase}-{time.time_ns()}-result.json', result)
        if not checks or not all(checks.values()): raise ValueError('QA_CHECK_FAILED')
        return result
    finally:
        stop.set(); thread.join(timeout=2)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--image')
    parser.add_argument('--gateway-image')
    parser.add_argument('--business', type=int, choices=(900011, 900012))
    parser.add_argument('--phase', choices=('launch', 'enrollment', 'records', 'custom-records', 'schema-key', 'probe', 'repeat', 'restart'), default='launch')
    args = parser.parse_args()
    try:
        if args.image: initialize(args.directory, args.image, args.business, args.gateway_image)
        print(json.dumps(execute(args.directory, args.phase)), flush=True)
    except Exception as error:
        code = str(error) if isinstance(error, (ValueError, helper.DeploymentError)) else 'QA_INTERNAL_FAILURE'
        if not __import__('re').fullmatch(r'[A-Z0-9_]{1,80}', code): code = 'QA_INTERNAL_FAILURE'
        raise SystemExit('AVA_TWENTY_RECIPE_QA_FAILED:' + code) from None
