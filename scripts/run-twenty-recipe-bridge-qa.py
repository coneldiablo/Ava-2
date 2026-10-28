#!/usr/bin/env python3
"""Real AVA HTTP bridge against a factory-created disposable Twenty contour."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time

import module_deployment_helper as helper

spec = importlib.util.spec_from_file_location('recipe_isolation', Path(__file__).with_name('verify-twenty-recipe-isolation.py'))
isolation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(isolation)
RUNTIME = 'sha256:0f8775b90217b2a6ce57dc491637b21d48717b4ce40d989ae7ba81425c114195'
CHECKS = frozenset('AVA_BUSINESS_SCOPE NATIVE_IDENTITY_NON_ADMIN NATIVE_EXACT_SESSION NATIVE_FOREIGN_SCOPE_REJECTED NATIVE_ADMIN_DENIED NATIVE_GUARD_REQUIRED PROOF_SESSION_REMOVED GATEWAY_BROWSER_BOUND_FLOW AVA_HTTP_GRANT BROKER_GATEWAY_NATIVE_EXCHANGE HOST_ONLY_COOKIE_NO_NATIVE_TOKEN CALLBACK_REPLAY_DENIED NATIVE_QUERY_THROUGH_REAL_GATEWAY BUSINESS_NAVIGATION WRONG_HOST_DENIED NATIVE_TOKEN_MINT_DENIED GLOBAL_LOGOUT AVA_AND_MODULE_SESSION_REVOKED DURABLE_NATIVE_CLEANUP_DONE OLD_NATIVE_COOKIE_REJECTED'.split())


def safe_receipt(value, business):
    fields = {'qa_only','business_id','checks','identity_enrollment','transport','second_twenty_deployment','production_access'}
    if not isinstance(value,dict) or set(value) != fields: return None
    checks = value['checks']
    if not isinstance(checks,list) or len(checks) != 20 or any(not isinstance(item,str) for item in checks) or set(checks) != CHECKS: return None
    if value['qa_only'] is not True or value['business_id'] != business or value['second_twenty_deployment'] is not False or value['production_access'] is not False: return None
    if value['identity_enrollment'] != 'real_invitation_store_without_keycloak' or value['transport'] != 'private_http_no_tls': return None
    return value


def execute(directory):
    side = isolation.contour(directory)
    source = isolation.BASE / 'recipe-bridge-source'
    helper.owned_path(source, directory=True)
    if not (source / 'native_modules/gateway/qa/twenty-bridge.cjs').is_file():
        raise ValueError('QA_SOURCE_REQUIRED')
    if json.loads(helper.run(['docker','image','inspect',RUNTIME],timeout=15))[0]['Id'] != RUNTIME:
        raise ValueError('PINNED_QA_RUNTIME_REQUIRED')
    native_networks = side['services']['native']['NetworkSettings']['Networks']
    name = side['row']['namespace'] + '_native'
    if set(native_networks) != {name}:
        raise ValueError('QA_NATIVE_NETWORK_REQUIRED')
    network = json.loads(helper.run(['docker','network','inspect',name],timeout=15))[0]
    if network['Internal'] is not True:
        raise ValueError('QA_INTERNAL_NETWORK_REQUIRED')
    os.umask(0o077)
    run_id = str(time.time_ns())
    inputs = directory / ('bridge-inputs-' + run_id)
    inputs.mkdir(mode=0o700)
    os.chown(inputs,1000,1000)
    # Copy only safe IDs and the two narrow peer keys; no native/env/bootstrap
    # admin credentials are exposed to the AVA test process.
    for file, value in [('context.json',json.dumps(side['context'])), *[(key+'.key',value) for key,value in side['keys'].items()]]:
        with (inputs/file).open('x') as output: output.write(value)
        os.chmod(inputs/file,0o600); os.chown(inputs/file,1000,1000)
    args = ['docker','run','--rm','--name',side['row']['namespace']+'-bridge-'+run_id,
        '--network',name,'--label','ava.qa.business='+str(side['row']['businessId']),
        '--user','1000:1000','--memory','1g','--cpus','1','--pids-limit','128',
        '--cap-drop','ALL','--security-opt','no-new-privileges','--read-only',
        '--tmpfs','/tmp:rw,nosuid,nodev,size=256m','-e','AVA_NATIVE_QA=true',
        '-e','SERVER_URL=https://'+side['row']['hostname'],'-e','DB_PATH=/tmp/ava-bridge/ava.sqlite',
        '-e','NODE_PATH=/app/node_modules','--mount',f'type=bind,src={source},dst=/opt/ava-qa-source,readonly',
        '--mount',f'type=bind,src={inputs},dst=/run/ava-native-context,readonly',
        '--mount',f'type=bind,src={inputs},dst=/run/ava-native-keys,readonly',
        '--entrypoint','node',RUNTIME,'/opt/ava-qa-source/native_modules/gateway/qa/twenty-bridge.cjs']
    try:
        result = subprocess.run(args,capture_output=True,text=True,timeout=240)
        # The probe may emit library diagnostics. Only its explicit success
        # receipt is admitted to the shared artifact/output.
        receipt = None
        for line in result.stdout.splitlines():
            try: value = json.loads(line)
            except ValueError: continue
            checked = safe_receipt(value, side['row']['businessId'])
            if checked is not None: receipt=checked
        if result.returncode or receipt is None:
            raise ValueError('QA_REAL_BRIDGE_FAILED')
        record = {'qa_only':True,'buyer_acceptance':False,'keycloak_browser_tls_accepted':False,
            'business_id':side['row']['businessId'],'deployment_id':side['row']['id'],
            'native_image':side['services']['native']['Image'],'runtime_image':RUNTIME,
            'source_mode':'read-only QA source mount; not a release image','receipt':receipt}
        with (directory/('bridge-'+run_id+'-result.json')).open('x') as output: json.dump(record,output)
        return record
    finally:
        # Remove only files created in this run's dedicated input directory.
        for file in inputs.iterdir(): file.unlink()
        inputs.rmdir()


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,required=True)
    args=parser.parse_args()
    try: print(json.dumps(execute(args.directory)))
    except Exception:
        raise SystemExit('AVA_TWENTY_RECIPE_BRIDGE_QA_FAILED') from None
