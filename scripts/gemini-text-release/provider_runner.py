#!/usr/bin/env python3
"""Run synthetic real-provider acceptance with the candidate on a fresh DB."""
import argparse, hashlib, json, os, subprocess, time
from pathlib import Path

def main(root):
    os.umask(0o077)
    p=json.loads((root/'prepared.private.json').read_text())
    directory=root/('provider-copy-'+str(time.time_ns()))
    directory.mkdir(mode=0o700); os.chown(directory,1000,986)
    environment=directory/'runtime.env'
    values=p['activationIntended']['crm']['environment']
    if any('\n' in str(value) or '\r' in str(value) for value in values.values()): raise RuntimeError('MULTILINE_ENV_UNSUPPORTED')
    environment.write_text(''.join(key+'='+str(value)+'\n' for key,value in values.items()));environment.chmod(0o600)
    probe=root/'tooling/provider_probe.cjs'
    before=hashlib.sha256(probe.read_bytes()).hexdigest()
    result=subprocess.run(['docker','run','--rm','--network',p['before']['crm']['HostConfig']['NetworkMode'],'--user','1000:986',
        '--env-file',str(environment),'-e','DB_PATH=/verify/probe.db','-e','AVA_PROCESS_ROLE=provisioning-worker',
        '-e','ONYX_LLM_PROXY_ENABLED=true','--mount',f'type=bind,src={directory},dst=/verify',
        '--mount',f'type=bind,src={probe},dst=/release/provider_probe.cjs,readonly',
        '--mount','type=bind,src=/root/ava-private/neuro-gemini-20261014/vertex-adc.json,dst=/run/secrets/ava-vertex-adc.json,readonly',
        '--entrypoint','node',p['images']['crm'],'/release/provider_probe.cjs'],capture_output=True,text=True,timeout=360)
    (directory/'stdout.private.log').write_text(result.stdout);(directory/'stderr.private.log').write_text(result.stderr)
    receipt=json.loads(result.stdout)
    receipt.update(sourceCommit=p['sourceCommit'],image=p['images']['crm'],probeSHA256=before,
                   host='production_host_isolated_candidate',liveDatabaseTouched=False)
    if hashlib.sha256(probe.read_bytes()).hexdigest()!=before: raise RuntimeError('PROVIDER_PROBE_DRIFT')
    (root/'provider-smoke.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt),flush=True)
    if result.returncode or not receipt.get('pass'): raise SystemExit(1)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,required=True);main(parser.parse_args().root)
