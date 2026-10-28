#!/usr/bin/env python3
"""Probe actual auth/gateway listeners of a disposable Onyx recipe.

This is enrollment/transport evidence, NOT buyer login, TLS, RAG or a release.
No credentials, cookies, redirect codes or response payloads leave the probe.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time

import module_deployment_helper as helper

spec = importlib.util.spec_from_file_location('onyx_recipe_qa', Path(__file__).with_name('run-onyx-recipe-qa.py'))
qa = importlib.util.module_from_spec(spec); spec.loader.exec_module(qa)

CHECKS = frozenset(('auth_own_scope', 'auth_peer_required', 'auth_wrong_peer_denied',
                   'auth_gateway_cannot_manage', 'auth_foreign_business_denied',
                   'auth_foreign_namespace_denied', 'auth_stale_revision_denied',
                   'auth_browser_denied', 'gateway_host_health', 'gateway_wrong_host_denied',
                   'gateway_missing_session_denied', 'gateway_bound_start', 'native_guard_required'))

PROBE = r'''
import json,os,re,urllib.error,urllib.parse,urllib.request
from onyx.ava_auth.core import read_secret
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*a,**kw): return None
opener=urllib.request.build_opener(NoRedirect(),urllib.request.ProxyHandler({}))
def request(url,body=None,headers=None):
 req=urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),
   headers={'Content-Type':'application/json',**(headers or {})})
 try: response=opener.open(req,timeout=5)
 except urllib.error.HTTPError as error: response=error
 with response:
  raw=response.read(16385)
  if len(raw)>16384: raise ValueError('BOUND')
  return response.code,dict(response.headers),raw
scope={'businessId':int(os.environ['AVA_BUSINESS_ID']),
 'deploymentId':os.environ['AVA_DEPLOYMENT_ID'],'nativeScope':os.environ['AVA_DEPLOYMENT_NAMESPACE'],
 'revision':int(os.environ['AVA_DEPLOYMENT_REVISION'])}
if scope['businessId'] not in (911001,911002): raise ValueError('SCOPE')
worker=read_secret(os.environ['AVA_AUTH_WORKER_KEY_FILE']).decode('ascii')
gateway=read_secret(os.environ['AVA_AUTH_GATEWAY_KEY_FILE']).decode('ascii')
auth='http://127.0.0.1:4011/v1/reconcile'
own_status,_,own_raw=request(auth,scope,{'Authorization':'Bearer '+worker})
own=json.loads(own_raw)
checks={'auth_own_scope':own_status==200 and own=={**scope,'state':'verified'}}
def denied(body,headers): return request(auth,body,headers)[0]==403
checks['auth_peer_required']=denied(scope,{})
checks['auth_wrong_peer_denied']=denied(scope,{'Authorization':'Bearer '+'x'*43})
checks['auth_gateway_cannot_manage']=denied(scope,{'Authorization':'Bearer '+gateway})
checks['auth_foreign_business_denied']=denied({**scope,'businessId':911002 if scope['businessId']==911001 else 911001},{'Authorization':'Bearer '+worker})
checks['auth_foreign_namespace_denied']=denied({**scope,'nativeScope':'ava_'+'0'*32},{'Authorization':'Bearer '+worker})
checks['auth_stale_revision_denied']=denied({**scope,'revision':scope['revision']+1},{'Authorization':'Bearer '+worker})
checks['auth_browser_denied']=denied(scope,{'Authorization':'Bearer '+worker,'Origin':'https://wh.meludtech.tech'})
host='qa-'+scope['deploymentId'][:8]+'-'+str(scope['businessId'])+'.knowledge.meludtech.tech'
checks['gateway_host_health']=request('http://gateway:4080/healthz',headers={'Host':host})[0]==200
checks['gateway_wrong_host_denied']=request('http://gateway:4080/healthz',headers={'Host':'foreign.knowledge.meludtech.tech'})[0]==403
checks['gateway_missing_session_denied']=request('http://gateway:4080/',headers={'Host':host})[0]==403
status,headers,_=request('http://gateway:4080/ava-auth/start',headers={'Host':host})
target=urllib.parse.urlsplit(headers.get('Location','')); query=urllib.parse.parse_qs(target.query)
cookie=headers.get('Set-Cookie','')
checks['gateway_bound_start']=(status==302 and target.scheme=='https' and target.netloc=='wh.meludtech.tech'
 and target.path=='/module-access' and not target.fragment and set(query)=={'adapter_id','state','code_challenge'}
 and query['adapter_id']==[scope['deploymentId']]
 and all(len(query[k])==1 and re.fullmatch('[A-Za-z0-9_-]{43}',query[k][0]) for k in ('state','code_challenge'))
 and bool(re.match('__Host-ava_flow=[A-Za-z0-9_-]{43};',cookie))
 and all(v in cookie for v in ('Path=/','Secure','HttpOnly','SameSite=Lax','Max-Age=60')) and 'domain=' not in cookie.lower())
checks['native_guard_required']=request('http://api:8080/me')[0]==403
print(json.dumps({'business_id':scope['businessId'],'deployment_id':scope['deploymentId'],'checks':checks}))
'''


def check_receipt(raw, row):
    if not isinstance(raw, str) or len(raw) > 8192:
        raise ValueError('QA_ACCESS_RESPONSE_INVALID')
    try: value = json.loads(raw)
    except (TypeError, ValueError): raise ValueError('QA_ACCESS_RESPONSE_INVALID') from None
    if (not isinstance(value, dict) or set(value) != {'business_id', 'deployment_id', 'checks'}
            or type(value['business_id']) is not int or value['business_id'] != row['businessId']
            or value['deployment_id'] != row['id'] or not isinstance(value['checks'], dict)
            or set(value['checks']) != CHECKS or not all(flag is True for flag in value['checks'].values())):
        raise ValueError('QA_ACCESS_PROBE_FAILED')
    return value


def execute(directory):
    directory = qa._scope(directory)
    manifest = qa._load_manifest(directory)
    row, payload = manifest['row'], manifest['payload']
    if row['reservedMemoryMiB'] != 12800:
        raise ValueError('QA_ACCESS_RECIPE_REQUIRED')
    database = directory / 'synthetic.sqlite'
    launcher = helper.Deployments(database, directory)
    root, recipe, compose = launcher._recipe(row)
    if not {'auth', 'api', 'gateway'}.issubset(compose['services']) or not qa._runtime_networks_private(compose):
        raise ValueError('QA_ACCESS_RECIPE_REQUIRED')
    started = int(time.time() * 1000)
    with qa.Heartbeat(database, row, payload):
        # This includes the live lease and complete container ownership checks;
        # only the peer hash and prepared identity cross the helper boundary.
        receipt = launcher.execute('enrollment', payload)
        if (receipt.get('nativeScope') != row['namespace'] or receipt.get('adapterId') != row['id']):
            raise ValueError('QA_ACCESS_ENROLLMENT_INVALID')
        containers = qa._containers(launcher, row)
        if any(item.get('HostConfig', {}).get('PortBindings') for item in containers.values()):
            raise ValueError('QA_ACCESS_NATIVE_EXPOSED')
        result = subprocess.run(['docker', 'exec', '-i', containers['auth']['Id'], 'python', '-'],
                                input=PROBE, text=True, capture_output=True, timeout=80, env=helper.SAFE_ENV)
        if result.returncode:
            # Exception text can contain credentials: only this fixed code is
            # emitted. Inspect separately with the scope-aware redactor.
            raise ValueError('QA_ACCESS_NATIVE_PROBE_FAILED')
        checked = check_receipt(result.stdout, row)
        launcher._lease(payload)
        if launcher._state(row, compose) != 'running': raise ValueError('QA_ACCESS_STATE_CHANGED')
        if receipt != launcher.execute('enrollment', payload): raise ValueError('QA_ACCESS_ENROLLMENT_CHANGED')
    evidence = {'qa_only': True, 'buyer_acceptance': False, 'rag_acceptance': False,
                'keycloak_browser_tls_accepted': False, 'business_id': row['businessId'],
                'deployment_id': row['id'], 'namespace': row['namespace'], 'revision': row['revision'],
                'started_at_ms': started, 'finished_at_ms': int(time.time() * 1000),
                'source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'compose_sha256': recipe['composeSha256'],
                'images': {name: containers[name]['Image'] for name in ('auth', 'api', 'gateway')},
                'enrollment_stable': True, 'transport': 'actual_private_http', 'checks': checked['checks']}
    qa._private_new(directory / ('access-' + str(time.time_ns()) + '-result.json'), evidence)
    return evidence


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    args = parser.parse_args()
    try: print(json.dumps(execute(args.directory), sort_keys=True))
    except Exception:
        raise SystemExit('AVA_ONYX_ACCESS_RECIPE_QA_FAILED') from None
