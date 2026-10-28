#!/usr/bin/env python3
"""Negative native API/session/network checks for the two disposable recipes."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

import module_deployment_helper as helper

BASE = Path('/opt/ava-acceptance/ecosystem-20260914')
NATIVE = '/app/packages/twenty-server/dist/ava-native'


def node(container, source, data=None, env=None, timeout=30):
    args = ['docker', 'exec'] + (['-i'] if data is not None else []) + ['-e', 'NODE_OPTIONS=']
    for key, value in (env or {}).items(): args += ['-e', key + '=' + value]
    result = subprocess.run([*args, container, 'node', '-e', source],
        input=json.dumps(data) if data is not None else None, text=True, capture_output=True, timeout=timeout)
    if result.returncode: raise ValueError('QA_NATIVE_PROBE_FAILED')
    return result.stdout


def contour(directory):
    if os.geteuid() != 0 or directory.parent != BASE or not directory.name.startswith('twenty-recipe-qa-'):
        raise ValueError('QA_DIRECTORY_REQUIRED')
    _, manifest = helper.private_json(directory / 'manifest.json')
    row = manifest['row']
    if manifest.get('qa_only') is not True or row['businessId'] not in (900011, 900012):
        raise ValueError('QA_BUSINESS_REQUIRED')
    launcher = helper.Deployments(directory / 'synthetic.sqlite', directory)
    _, _, compose = launcher._recipe(row)
    if launcher._state(row, compose) != 'running': raise ValueError('QA_RUNNING_REQUIRED')
    services = {item['Config']['Labels']['com.docker.compose.service']: item for item in launcher._containers(row['id'])}
    native = services['native']['Id']
    context = json.loads(node(native, "process.stdout.write(require('fs').readFileSync('/run/ava-bootstrap/bootstrap.json','utf8'))"))
    if context['businessId'] != row['businessId'] or context['deploymentId'] != row['id'] or context['revision'] != row['revision']:
        raise ValueError('QA_CONTEXT_SCOPE_INVALID')
    keys = {}
    for name in ('worker', 'gateway'):
        file = directory / row['id'] / 'config' / (name + '.key')
        helper.owned_path(file)
        keys[name] = file.read_text().strip()
    return {'row': row, 'services': services, 'native': native, 'context': context, 'keys': keys}


def probe(side, mode):
    node(side['native'], f"require('{NATIVE}/qa/acceptance-probe.cjs')", env={
        'AVA_NATIVE_QA': 'true', 'AVA_QA_CONTEXT_FILE': '/tmp/ava-recipe-isolation.json',
        'AVA_QA_PEER_URL': 'http://127.0.0.1:3902', 'AVA_QA_TWENTY_URL': 'http://127.0.0.1:3000',
        'AVA_QA_PRIVATE_HOSTS': '127.0.0.1', 'AVA_QA_MODE': mode})


def verify(left, right):
    sides = [contour(left), contour(right)]
    if {side['row']['businessId'] for side in sides} != {900011, 900012}:
        raise ValueError('TWO_DIFFERENT_QA_BUSINESSES_REQUIRED')
    checks = {'different_native_workspaces': sides[0]['context']['nativeScope'] != sides[1]['context']['nativeScope'],
              'different_peer_keys': all(sides[0]['keys'][name] != sides[1]['keys'][name] for name in ('worker', 'gateway'))}
    for source, target in (sides, list(reversed(sides))):
        label = str(source['row']['businessId']) + '_to_' + str(target['row']['businessId'])
        node(source['native'], "const fs=require('fs');fs.copyFileSync('/run/ava-bootstrap/bootstrap.json','/tmp/ava-recipe-isolation.json');fs.chmodSync('/tmp/ava-recipe-isolation.json',0o600)")
        try:
            probe(source, 'mint')
            cookie = json.loads(node(source['native'], "process.stdout.write(require('fs').readFileSync('/tmp/ava-recipe-isolation.json','utf8'))"))
            data = {'source': cookie, 'wrongKey': source['keys']['worker'], 'targetKeys': target['keys'], 'hostname': target['row']['hostname']}
            # Secrets are streamed to stdin, never embedded in command args or output.
            result = json.loads(node(target['native'], """
let input='';process.stdin.on('data',c=>input+=c).on('end',async()=>{
 try { const d=JSON.parse(input),s=d.source;
 const body={businessId:s.businessId,deploymentId:s.deploymentId,nativeScope:s.nativeScope,revision:s.revision,userId:s.userId,subject:'qa:'+s.userId,role:'manager',email:'qa-'+s.userId+'@qa.invalid',displayName:'AVA QA'};
 const request=key=>fetch('http://127.0.0.1:3902/v1/provision',{method:'POST',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify(body)});
 const wrong=await request(d.wrongKey), scope=await request(d.targetKeys.worker);
 const session=await fetch('http://127.0.0.1:3000/metadata',{method:'POST',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/json',origin:'https://'+d.hostname,cookie:s.nativeCookie,'x-ava-native-peer':d.targetKeys.gateway,'x-ava-native-binding':s.bindingId},body:JSON.stringify({query:'query { currentUser { id } }'})});
 process.stdout.write(JSON.stringify({foreignKeyRejected:wrong.status===401,foreignScopeRejected:scope.status===403,foreignSessionRejected:session.status===403}));
 }catch(_){process.exitCode=1}
});""", data))
            for name, passed in result.items(): checks[label + '_' + name] = passed
            target_db = target['services']['database']['NetworkSettings']['Networks']
            if len(target_db) != 1: raise ValueError('QA_DATABASE_NETWORK_INVALID')
            address = next(iter(target_db.values()))['IPAddress']
            network = json.loads(node(source['native'], """
let input='';process.stdin.on('data',c=>input+=c).on('end',()=>{
 const net=require('net'),d=JSON.parse(input);let done=false;
 const finish=blocked=>{if(done)return;done=true;socket.destroy();process.stdout.write(JSON.stringify({blocked}));};
 const socket=net.createConnection({host:d.address,port:5432});socket.setTimeout(2000);
 socket.on('connect',()=>finish(false)).on('timeout',()=>finish(true)).on('error',()=>finish(true));
});""", {'address': address}))
            checks[label + '_foreign_database_network_blocked'] = network['blocked']
        finally:
            probe(source, 'revoke')
            node(source['native'], "require('fs').unlinkSync('/tmp/ava-recipe-isolation.json')")
    result = {'qa_only': True, 'buyer_acceptance': False, 'business_ids': [side['row']['businessId'] for side in sides],
              'deployment_ids': [side['row']['id'] for side in sides], 'checks': checks}
    file = left / f'isolation-{time.time_ns()}-result.json'
    with file.open('x') as output:
        os.chmod(file, 0o600); json.dump(result, output)
    if len(checks) != 10 or not all(checks.values()): raise ValueError('QA_NATIVE_ISOLATION_FAILED')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--left', type=Path, required=True)
    parser.add_argument('--right', type=Path, required=True)
    args = parser.parse_args()
    try: print(json.dumps(verify(args.left, args.right)))
    except Exception:
        raise SystemExit('AVA_TWENTY_RECIPE_ISOLATION_FAILED') from None
