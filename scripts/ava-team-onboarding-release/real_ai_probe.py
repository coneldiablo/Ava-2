#!/usr/bin/env python3
"""Assigned one-shot provider probe, pinned prepared CRM image and cloned DB only."""
import argparse,fcntl,hashlib,importlib.util,json,os,pathlib,re,shutil,tempfile,time,types,uuid,subprocess

def main():
 os.umask(0o077)
 ap=argparse.ArgumentParser();ap.add_argument('--release-root',type=pathlib.Path,required=True);ap.add_argument('--candidate-commit',required=True);ap.add_argument('--manifest-sha256',required=True);ap.add_argument('--probe-sha256',required=True);a=ap.parse_args()
 root=a.release_root.resolve(strict=True)
 spec=importlib.util.spec_from_file_location('ava_ai_operator',root/'scripts/release_operator.py');op=importlib.util.module_from_spec(spec);spec.loader.exec_module(op)
 operator=op.Operator(types.SimpleNamespace(release_dir=root/'operator-state',bundle=root/'bundle',candidate_commit=a.candidate_commit,manifest_sha256=a.manifest_sha256))
 probe=root/'scripts/probe_ai.cjs';op.require(op.sha(probe)==a.probe_sha256,'PROBE_BYTES_CHANGED')
 token=uuid.uuid4().hex;label='ava.team.ai-probe='+token;cid=None;temp=None
 receipt={'candidateCommit':a.candidate_commit,'manifestSha256':a.manifest_sha256,'liveApplyPerformed':False,'liveDatabaseMounted':False,'passed':False,'probeRemoved':False}
 with open('/var/lock/ava-registration-release.lock','a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  try:
   p=operator.load();before=operator.guard(p,p['baseImages']);image=p['candidateImages'][op.CRM];receipt['imageId']=image
   backup=operator.backup(p,'ai-probe-backup');temp=pathlib.Path(tempfile.mkdtemp(prefix='ai-probe-',dir=operator.root));clone=temp/'crm_v2.db';shutil.copyfile(backup['path'],clone)
   original=operator.snapshot(image,clone);operator.runner(image,clone);migrated=operator.snapshot(image,clone);op.assert_additive(original,migrated,operator.m['allowedNewSchema'])
   op.require(time.time()-backup['createdAt']<300 and op.sha(backup['path'])==backup['sha256'],'AI_PROBE_BACKUP_NOT_FRESH')
   actual=op.envmap(p['before'][op.CRM]);allowed=['AITUNNEL_API_KEY','AI_TUNNEL_API_KEY','YANDEX_GPT_API_KEY','AITUNNEL_API_URL','AI_TUNNEL_API_URL','AITUNNEL_MODEL','AI_TUNNEL_MODEL','YANDEX_GPT_MODEL_URI']
   env={k:actual[k] for k in allowed if k in actual};env.update(AVA_RELEASE_REAL_AI_PROBE='1',AVA_RELEASE_CANDIDATE_COMMIT=a.candidate_commit,AVA_RELEASE_APP_ROOT='/app',DB_PATH='/probe/crm_v2.db',NODE_ENV='production',DOTENV_CONFIG_QUIET='true')
   op.require(any(env.get(k) for k in allowed[:3]),'AI_RUNTIME_KEY_UNAVAILABLE');op.require(all('\n' not in k+v and '\r' not in k+v and '\x00' not in k+v for k,v in env.items()),'AI_ENV_UNREPRESENTABLE')
   executable=temp/'probe_ai.cjs';shutil.copyfile(probe,executable);executable.chmod(0o400);op.require(op.sha(executable)==a.probe_sha256,'PROBE_COPY_BYTES_CHANGED')
   envfile=temp/'probe.env';envfile.write_text(''.join(k+'='+v+'\n' for k,v in sorted(env.items())));envfile.chmod(0o600)
   cid=operator.run(['docker','create','--name','ava-ai-probe-'+token,'--label',label,'--network','bridge','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--cap-drop','ALL','--security-opt','no-new-privileges','--workdir','/probe','--entrypoint','node','--env-file',str(envfile),'--mount','type=bind,source='+str(temp)+',target=/probe','--mount','type=bind,source='+str(executable)+',target=/probe/probe_ai.cjs,readonly',image,'/probe/probe_ai.cjs'],timeout=30).strip()
   op.require(bool(re.fullmatch('[a-f0-9]{64}',cid)),'AI_PROBE_ID_INVALID');receipt['containerId']=cid
   operator.run(['docker','start',cid]);exitcode=operator.run(['docker','wait',cid],timeout=90).strip()
   logs=operator.run(['docker','logs',cid]);logpath=operator.root/('ai-probe-'+token+'.private.log');logpath.write_text(logs);logpath.chmod(0o600)
   result=json.loads(logs);receipt['probe']=result
   op.require(exitcode=='0' and result.get('generated') is True and result.get('approved') is True and result.get('existingBusinessRowsPreserved') is True and result.get('schemaPreserved') is True and 1<=result.get('providerRequests',0)<=2,'REAL_AI_PROBE_FAILED')
   receipt['passed']=True
  except Exception as error:
   receipt['reason']=str(error) if re.fullmatch('[A-Z][A-Z0-9_]{0,100}',str(error)) else 'REAL_AI_PROBE_FAILED'
  finally:
   if cid:
    try:
     row=json.loads(operator.run(['docker','inspect',cid]))[0];op.require(row['Id']==cid and row['Config'].get('Labels',{}).get('ava.team.ai-probe')==token,'AI_CLEANUP_SCOPE_CHANGED');operator.run(['docker','rm','-f',cid]);receipt['probeRemoved']=True
    except Exception:receipt['cleanupFailed']=True;receipt['passed']=False
   if temp and (not cid or receipt['probeRemoved']):shutil.rmtree(temp)
   try:
    rows=operator.guard(p,p['baseImages']);op.require(all(rows[s]['Id']==before[s]['Id'] and rows[s]['State']['StartedAt']==before[s]['State']['StartedAt'] and rows[s].get('RestartCount')==before[s].get('RestartCount') for s in op.SERVICES),'AI_BASELINE_CHANGED');receipt['liveBaselineUnchanged']=True
   except Exception:receipt['liveBaselineUnchanged']=False;receipt['passed']=False
   op.private_json(operator.root/'real-ai-probe.receipt.json',receipt)
 print(json.dumps(receipt,sort_keys=True));return 0 if receipt['passed'] else 1
if __name__=='__main__':raise SystemExit(main())
