# Guarded image-only CRM/worker rollout; input files remain private on the server.
import argparse,copy,hashlib,json,os,pathlib,subprocess,time
from urllib.request import urlopen
os.umask(0o077)
R=pathlib.Path('/root/ava-releases/ai-client-fixes-20261001')
NAMES={'crm':'whatsapp_crm','worker':'asterisk-ai-voice-agent-provisioning_worker-1'}
ENV=dict(os.environ,AVA_RELEASE_SHA='b3be6ee',AVA_CALL_ANALYTICS_SHA='da737f3')
def run(args,**kwargs):
 p=subprocess.run(args,capture_output=True,text=True,env=ENV,**kwargs)
 if p.returncode:raise RuntimeError('COMMAND_FAILED')
 return p.stdout
def state(name):return json.loads(run(['docker','inspect',name]))[0]
def envmap(row):return dict(value.split('=',1) for value in row['Config']['Env'])
def mounts(row):return {m['Destination']:(m['Type'],os.path.realpath(m['Source']),m['RW']) for m in row['Mounts']}
def compose(row,override=None):
 labels=row['Config']['Labels'];cmd=['docker','compose','-p',labels['com.docker.compose.project']]
 for f in labels.get('com.docker.compose.project.environment_file','').split(','):
  if f:cmd+=['--env-file',f]
 for f in labels['com.docker.compose.project.config_files'].split(','):cmd+=['-f',f]
 if override:cmd+=['-f',str(override)]
 return cmd,labels['com.docker.compose.project.working_dir'],labels['com.docker.compose.service']
def config(row,override=None):
 cmd,cwd,service=compose(row,override);resolved=json.loads(run(cmd+['config','--format','json'],cwd=cwd))['services'][service]
 # `compose config` serializes literal dollars as $$ for re-readable output.
 # Compare effective environment values, as verified by isolated create/inspect.
 for name,value in resolved.get('environment',{}).items():
  if isinstance(value,str):resolved['environment'][name]=value.replace('$$','$')
 return resolved
def environment_patch(row):
 # Preserve running credentials if the compose files drifted since launch.
 # Compose interpolation must not interpret literal dollar signs in hashes.
 actual=envmap(row);patch={}
 for name,value in config(row).get('environment',{}).items():
  if value is not None and actual.get(name)!=str(value):
   assert name in actual,'ENV_ADDED_FROM_DISK'
   patch[name]=actual[name].replace('$','$$')
 return patch
def image_override(before,images):
 services={}
 for key in NAMES:
  service={'image':images[key]};patch=environment_patch(before[key])
  if patch:service['environment']=patch
  services[before[key]['Config']['Labels']['com.docker.compose.service']]=service
 return {'services':services}
def up(row,override=None):
 cmd,cwd,service=compose(row,override);run(cmd+['up','-d','--no-deps','--pull','never',service],cwd=cwd,timeout=150)
def check(row,name,image):
 now=state(name);assert now['Image']==image,'IMAGE_CHANGED';assert envmap(now)==envmap(row),'ENV_CHANGED';assert mounts(now)==mounts(row),'MOUNTS_CHANGED'
 assert set(now['NetworkSettings']['Networks'])==set(row['NetworkSettings']['Networks']),'NETWORK_CHANGED'
 for key in ('PortBindings','RestartPolicy','LogConfig','Privileged','CapAdd','CapDrop','SecurityOpt','Devices','NetworkMode'):assert now['HostConfig'].get(key)==row['HostConfig'].get(key),'HOST_CONFIG_CHANGED'
 for key in ('User','Entrypoint','Cmd','WorkingDir'):assert now['Config'].get(key)==row['Config'].get(key),'EXECUTION_CHANGED'
 assert now['State']['Running'] and not now['State']['Paused'],'SERVICE_NOT_RUNNING'
def wait(name,timeout=90):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  s=state(name)
  if s['State']['Running'] and not s['State']['Paused']:
   health=s['State'].get('Health',{}).get('Status')
   if health=='healthy':return
   if health is None:
    time.sleep(2)
    if state(name)['State']['Running']:return
  time.sleep(2)
 raise RuntimeError('HEALTH_TIMEOUT')
def runtime_hashes(name,root):
 script="const fs=require('fs'),path=require('path'),crypto=require('crypto');const root=process.argv[1],out={};function walk(p){for(const ent of fs.readdirSync(p,{withFileTypes:true})){const file=path.join(p,ent.name);if(ent.isDirectory())walk(file);else if(ent.isFile())out[path.relative(root,file)]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}}walk(root);console.log(JSON.stringify(out));"
 return json.loads(run(['docker','exec',name,'node','-e',script,root]))
def payload_check(manifest,rollback=False):
 expected=manifest['rollbackRuntimeSha256' if rollback else 'runtimeSha256']
 for key in NAMES:assert runtime_hashes(NAMES[key],'/app/src')==expected[key],'RUNTIME_SOURCE_CHANGED'
 if not rollback:assert runtime_hashes(NAMES['crm'],'/app/frontend/dist')==manifest['frontendSha256'],'RUNTIME_FRONTEND_CHANGED'
def restore(before,manifest):
 # Compatibility images retain the canonical identity layer even after a
 # customer merge. Restoring pre-alias images would split the next inbound chat.
 override=R/'rollback-compatible.private.override.json'
 override.write_text(json.dumps(image_override(before,manifest['rollbackImages']),indent=2))
 for key in ('worker','crm'):
  up(before[key],override);wait(NAMES[key]);image=json.loads(run(['docker','image','inspect',manifest['rollbackImages'][key]]))[0]['Id'];check(before[key],NAMES[key],image)
 payload_check(manifest,rollback=True);preserved(before)
def idle():
 channels=run(['asterisk','-rx','core show channels count']);assert '0 active calls' in channels and '0 active channels' in channels,'ACTIVE_CALLS'
def preserved(before):
 for key,name in [('engine','ai_engine'),('admin','admin_ui')]:
  s=state(name);assert s['Id']==before[key]['Id'] and s['Image']==before[key]['Image'],'UNTOUCHED_SERVICE_CHANGED';check(before[key],name,before[key]['Image'])
 with urlopen('http://127.0.0.1:15000/health',timeout=3) as f:h=json.load(f)
 assert h.get('status')=='healthy' and h.get('ari_connected') and h.get('providers',{}).get('yandex_realtime',{}).get('ready'),'VOICE_HEALTH_CHANGED'
def main():
 parser=argparse.ArgumentParser();group=parser.add_mutually_exclusive_group();group.add_argument('--apply',action='store_true');group.add_argument('--rollback',action='store_true');a=parser.parse_args()
 before=json.loads((R/'before.private.json').read_text());m=json.loads((R/'manifest.json').read_text());override=R/'client-fixes.private.override.json'
 if a.rollback:
  idle()
  restore(before,m);print(json.dumps({'phase':'rolled_back','commit':m['commit'],'schema':'canonical identity compatibility retained; no data restore'}));return
 assert run(['sha256sum','-c','SHA256SUMS'],cwd=m['backup']).strip()=='recovery-full.tar.gz.gpg: OK','BACKUP_INVALID'
 for rel,digest in m['filesSha256'].items():assert hashlib.sha256((R/rel).read_bytes()).hexdigest()==digest,'PAYLOAD_CHANGED'
 for key,name in NAMES.items():check(before[key],name,before[key]['Image'])
 preserved(before)
 current=runtime_hashes('whatsapp_crm','/app/src')
 assert current==m['crmBaselineSha256'],'LIVE_SOURCE_CHANGED'
 override.write_text(json.dumps(image_override(before,m['images']),indent=2))
 for key in NAMES:
  old=config(before[key]);new=config(before[key],override);expected=copy.deepcopy(old);expected['image']=m['images'][key]
  for variable in environment_patch(before[key]):expected['environment'][variable]=envmap(before[key])[variable]
  assert new==expected,'COMPOSE_CONTRACT_CHANGED'
  for variable,value in new.get('environment',{}).items():
   if value is not None:assert envmap(before[key]).get(variable)==str(value),'COMPOSE_ENV_DRIFT'
  for image in [m['images'][key],m['rollbackImages'][key]]:run(['docker','image','inspect',image])
 print(json.dumps({'phase':'plan','commit':m['commit'],'backup':m['backup'],'services':list(NAMES.values())}),flush=True)
 if not a.apply:return
 idle();changed=[]
 try:
  for key in ('crm','worker'):
   changed.append(key);up(before[key],override);wait(NAMES[key]);image=json.loads(run(['docker','image','inspect',m['images'][key]]))[0]['Id'];check(before[key],NAMES[key],image)
  payload_check(m);preserved(before)
 except Exception:
  print(json.dumps({'phase':'rollback_after_failure','services':changed}),flush=True)
  restore(before,m);raise RuntimeError('CUTOVER_FAILED_ROLLED_BACK') from None
 print(json.dumps({'phase':'complete','commit':m['commit'],'backup':m['backup'],'voiceUnchanged':True}),flush=True)
if __name__=='__main__':
 try:main()
 except Exception as error:
  reason=str(error);reason=reason if reason.replace('_','').isalnum() else type(error).__name__;print(json.dumps({'phase':'failed','reason':reason}),flush=True);raise SystemExit(1)
