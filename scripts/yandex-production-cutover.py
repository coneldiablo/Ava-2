import argparse,copy,hashlib,json,os,pathlib,subprocess,time
from urllib.request import urlopen
import yaml
os.umask(0o077)
R=pathlib.Path('/root/ava-releases/yandex-realtime-20260930')
BACKUP=pathlib.Path('/root/backups/ava/post-pilot-20260930T192905Z')
NAMES={'crm':'whatsapp_crm','worker':'asterisk-ai-voice-agent-provisioning_worker-1','engine':'ai_engine'}
ENV=dict(os.environ,AVA_RELEASE_SHA='b3be6ee',AVA_CALL_ANALYTICS_SHA='da737f3')
def run(args,**kwargs):
 r=subprocess.run(args,capture_output=True,text=True,env=ENV,**kwargs)
 if r.returncode:raise RuntimeError('COMMAND_FAILED')
 return r.stdout
def state(name):return json.loads(run(['docker','inspect',name]))[0]
def envmap(row):return dict(v.split('=',1) for v in row['Config']['Env'])
def mounts(row):return {m['Destination']:(m['Type'],os.path.realpath(m['Source']),m['RW']) for m in row['Mounts']}
def compose(row,extra=None):
 labels=row['Config']['Labels'];cmd=['docker','compose','-p',labels['com.docker.compose.project']]
 for f in labels.get('com.docker.compose.project.environment_file','').split(','):
  if f:cmd+=['--env-file',f]
 if extra:cmd+=['--env-file','/root/ava-private/yandex-realtime-20260930.env']
 for f in labels['com.docker.compose.project.config_files'].split(','):cmd+=['-f',f]
 if extra:cmd+=['-f',str(extra)]
 return cmd,labels['com.docker.compose.project.working_dir'],labels['com.docker.compose.service']
def cfg(row,extra=None):
 cmd,cwd,service=compose(row,extra)
 return json.loads(run(cmd+['config','--format','json'],cwd=cwd))['services'][service]
def up(row,extra=None):
 cmd,cwd,service=compose(row,extra)
 run(cmd+['up','-d','--no-deps','--pull','never',service],cwd=cwd,timeout=150)
def wait(name,timeout=60):
 deadline=time.monotonic()+timeout
 while time.monotonic()<deadline:
  s=state(name)
  if s['State']['Running'] and not s['State']['Paused']:
   if s['State'].get('Health',{}).get('Status')=='healthy':return
   if name=='ai_engine':
    try:
     with urlopen('http://127.0.0.1:15000/health',timeout=3) as f:h=json.load(f)
     if h.get('status')=='healthy' and h.get('ari_connected'):return
    except Exception:pass
   elif s['State'].get('Health') is None:
    time.sleep(2)
    if state(name)['State']['Running']:return
  time.sleep(2)
 raise RuntimeError('HEALTH_TIMEOUT')
def idle():
 t=run(['asterisk','-rx','core show channels count'])
 assert '0 active channels' in t and '0 active calls' in t,'ACTIVE_CALLS'
def profiles(mode):
 # The only live DB change is the voice-provider field; text AI, keys and prompts stay untouched.
 body=r'''const SQLite=require('/app/node_modules/better-sqlite3');
 const db=new SQLite(process.env.DB_PATH||'/app/crm_v2.db');
 const before=JSON.parse(process.env.AVA_VOICE_BEFORE||'[]');
 let out;
 if(process.env.AVA_VOICE_ACTION==='capture')out=db.prepare("SELECT id,voiceAiProvider FROM instances WHERE voiceAiProvider='google_live' ORDER BY id").all();
 else{db.transaction(()=>{for(const row of before){const target=process.env.AVA_VOICE_ACTION==='rollback'?row.voiceAiProvider:'yandex_realtime';const expected=process.env.AVA_VOICE_ACTION==='rollback'?'yandex_realtime':row.voiceAiProvider;const r=db.prepare('UPDATE instances SET voiceAiProvider=? WHERE id=? AND voiceAiProvider=?').run(target,row.id,expected);if(r.changes!==1)throw Error('VOICE_CONCURRENT_CHANGE');}})();out=before.map(row=>db.prepare('SELECT id,voiceAiProvider FROM instances WHERE id=?').get(row.id));}
 console.log('VOICE_MIGRATION '+JSON.stringify(out));db.close();'''
 e=dict(ENV,AVA_VOICE_ACTION=mode,AVA_VOICE_BEFORE=(R/'voice-before.private.json').read_text() if mode!='capture' else '[]')
 r=subprocess.run(['docker','exec','-i','-e','AVA_VOICE_ACTION','-e','AVA_VOICE_BEFORE','whatsapp_crm','node','-'],input=body,capture_output=True,text=True,env=e,timeout=15)
 assert r.returncode==0,'VOICE_PROFILE_CHANGE_FAILED'
 line=next(x for x in r.stdout.splitlines() if x.startswith('VOICE_MIGRATION '))
 value=json.loads(line[len('VOICE_MIGRATION '):])
 if mode=='capture':(R/'voice-before.private.json').write_text(json.dumps(value))
 return value
def check_contract(row,key,image,yandex):
 s=state(NAMES[key]);assert s['Image']==image,'IMAGE_CONTRACT_CHANGED'
 expected=envmap(row)
 if key=='engine' and yandex:
  for line in pathlib.Path('/root/ava-private/yandex-realtime-20260930.env').read_text().splitlines():
   k,v=line.split('=',1);expected[k]=v
  expected['AVA_VOICE_DEFAULT_PROVIDER']='yandex_realtime'
 assert envmap(s)==expected,'ENV_CONTRACT_CHANGED'
 m=mounts(row)
 if key=='engine' and yandex:
  m['/app/src']=('bind',str(R/'engine-src'),False)
  m['/app/config']=('bind',str(R/'engine-config'),True)
 assert mounts(s)==m,'MOUNT_CONTRACT_CHANGED'
 assert set(s['NetworkSettings']['Networks'])==set(row['NetworkSettings']['Networks']),'NETWORK_CONTRACT_CHANGED'
 for f in ('PortBindings','RestartPolicy','LogConfig','Privileged','CapAdd','CapDrop','SecurityOpt','Devices','NetworkMode'):
  assert s['HostConfig'].get(f)==row['HostConfig'].get(f),'HOST_CONTRACT_CHANGED'
 assert s['State']['Running'] and not s['State']['Paused'],'NOT_RUNNING'
 if key=='engine' and yandex:
  with urlopen('http://127.0.0.1:15000/health',timeout=3) as f:h=json.load(f)
  assert h.get('status')=='healthy' and h.get('ari_connected'),'ENGINE_NOT_READY'
  assert h.get('providers',{}).get('yandex_realtime',{}).get('ready'),'YANDEX_NOT_READY'
def main():
 a=argparse.ArgumentParser();a.add_argument('--apply',action='store_true');a.add_argument('--rollback',action='store_true');args=a.parse_args()
 before=json.loads((R/'before.private.json').read_text());manifest=json.loads((R/'manifest.json').read_text())
 override=R/'yandex.private.override.json'
 if args.rollback:
  idle();profiles('rollback')
  for k in ('engine','worker','crm'):up(before[k]);wait(NAMES[k]);check_contract(before[k],k,before[k]['Image'],False)
  print(json.dumps({'phase':'rolled_back','commit':manifest.get('commit'),'restoredVoiceRows':len(json.loads((R/'voice-before.private.json').read_text()))}));return
 assert run(['sha256sum','-c','SHA256SUMS'],cwd=BACKUP).strip()=='recovery-full.tar.gz.gpg: OK','BACKUP_INVALID'
 for rel,digest in manifest['filesSha256'].items():assert hashlib.sha256((R/rel).read_bytes()).hexdigest()==digest,'RELEASE_CHANGED'
 for k,name in NAMES.items():
  s=state(name);assert s['Image']==before[k]['Image'] and mounts(s)==mounts(before[k]) and envmap(s)==envmap(before[k]),'BASELINE_CHANGED'
 oldsrc=pathlib.Path(next(m['Source'] for m in before['engine']['Mounts'] if m['Destination']=='/app/src'))
 for rel,digest in manifest['engineBaselineSha256'].items():assert hashlib.sha256((oldsrc/rel).read_bytes()).hexdigest()==digest,'LIVE_SOURCE_CHANGED'
 released=dict(manifest['engineBaselineSha256']);released.update(manifest['deployedEngineFilesSha256'])
 newsrc=R/'engine-src'
 actual={str(f.relative_to(newsrc)):hashlib.sha256(f.read_bytes()).hexdigest() for f in newsrc.rglob('*.py') if '__pycache__' not in f.parts}
 assert actual==released,'STAGED_SOURCE_CHANGED'
 oldconfig=pathlib.Path(next(m['Source'] for m in before['engine']['Mounts'] if m['Destination']=='/app/config'))
 prior=yaml.safe_load((oldconfig/'ai-agent.yaml').read_text());newcfg=yaml.safe_load((R/'engine-config'/'ai-agent.yaml').read_text())
 assert 'yandex_realtime' not in prior.get('providers',{}),'LIVE_CONFIG_CHANGED'
 expected_cfg=copy.deepcopy(prior);expected_cfg.setdefault('providers',{})['yandex_realtime']=newcfg['providers']['yandex_realtime']
 for context in ('default','unified_sales_agent'):
  if context in expected_cfg.get('contexts',{}):expected_cfg['contexts'][context]['provider']='yandex_realtime'
 assert expected_cfg==newcfg,'LIVE_CONFIG_CHANGED'
 prior_files={str(f.relative_to(oldconfig)):hashlib.sha256(f.read_bytes()).hexdigest() for f in oldconfig.rglob('*') if f.is_file() and f.name!='ai-agent.yaml'}
 new_files={str(f.relative_to(R/'engine-config')):hashlib.sha256(f.read_bytes()).hexdigest() for f in (R/'engine-config').rglob('*') if f.is_file() and f.name!='ai-agent.yaml'}
 assert prior_files==new_files,'LIVE_CONFIG_CHANGED'
 admin=state('admin_ui');admin_id=admin['Id'];admin_image=admin['Image']
 services={'whatsapp_crm':{'image':manifest['releaseImages']['crm']},'provisioning_worker':{'image':manifest['releaseImages']['worker']},'ai_engine':{'environment':{'YANDEX_CLOUD_API_KEY':'${YANDEX_CLOUD_API_KEY}','YANDEX_CLOUD_FOLDER_ID':'${YANDEX_CLOUD_FOLDER_ID}','AVA_VOICE_DEFAULT_PROVIDER':'yandex_realtime'},'volumes':[str(R/'engine-src')+':/app/src:ro',str(R/'engine-config')+':/app/config:rw']}}
 override.write_text(json.dumps({'services':services},indent=2))
 for k in NAMES:
  old=cfg(before[k]);new=cfg(before[k],override);expected=copy.deepcopy(old)
  if k!='engine':expected['image']=services[before[k]['Config']['Labels']['com.docker.compose.service']]['image']
  else:
   expected.setdefault('environment',{}).update({n:new['environment'][n] for n in ('YANDEX_CLOUD_API_KEY','YANDEX_CLOUD_FOLDER_ID','AVA_VOICE_DEFAULT_PROVIDER')})
   for volume in expected.get('volumes',[]):
    if volume.get('target') in ('/app/src','/app/config'):volume['source']=str(R/('engine-src' if volume['target']=='/app/src' else 'engine-config'))
  assert new==expected,'COMPOSE_CONTRACT_CHANGED'
 print(json.dumps({'phase':'plan','services':list(NAMES.values()),'backup':str(BACKUP),'commit':manifest.get('commit')}),flush=True)
 if not args.apply:return
 idle();changed=[];migrated=False
 try:
  profiles('capture')
  for k in ('crm','worker'):
   changed.append(k);up(before[k],override);wait(NAMES[k])
   image=json.loads(run(['docker','image','inspect',services[before[k]['Config']['Labels']['com.docker.compose.service']]['image']]))[0]['Id'];check_contract(before[k],k,image,True)
  idle();profiles('apply');migrated=True
  changed.append('engine');up(before['engine'],override);wait('ai_engine')
  check_contract(before['engine'],'engine',before['engine']['Image'],True)
  assert state('admin_ui')['Id']==admin_id and state('admin_ui')['Image']==admin_image,'ADMIN_CHANGED'
 except Exception:
  print(json.dumps({'phase':'rollback_after_failure','services':changed}),flush=True)
  if migrated:profiles('rollback')
  for k in reversed(changed):up(before[k]);wait(NAMES[k]);check_contract(before[k],k,before[k]['Image'],False)
  raise RuntimeError('CUTOVER_FAILED_ROLLED_BACK') from None
 print(json.dumps({'phase':'complete','commit':manifest.get('commit'),'voiceRowsMigrated':len(json.loads((R/'voice-before.private.json').read_text())),'backup':str(BACKUP)}),flush=True)
if __name__=='__main__':
 try:main()
 except Exception as e:
  reason=str(e);reason=reason if reason.replace('_','').isalnum() else type(e).__name__
  print(json.dumps({'phase':'failed','reason':reason}),flush=True);raise SystemExit(1)
