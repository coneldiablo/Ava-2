#!/usr/bin/env python3
"""Exact single dependency overlay; retain WhatsApp auth volume and compose contract."""
import argparse,fcntl,hashlib,importlib.util,json,sqlite3,time
from pathlib import Path
BASE='sha256:5fd912fe6554fc4a14d321d1bba4d6ef679b03b38235833b2bb315a2bb6422b9'
BEFORE='2613dbfe7d062e30bc3e87eee870eda942478047c0cd832d3909db67eade4f30'
AFTER='d4a96549534f18a4afaa5d871ac9518bd3e675a683259eaa5ab778ce729659c8'
NAME='whatsapp_crm_openwa'
TARGET='/app/node_modules/whatsapp-web.js/src/structures/Message.js'
CORE_SHA='1f8e0e2845d15bd504f4d33550545b9734b0bd83361f57d3ec8d2568d375015d'

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def require(v,code):
 if not v:raise RuntimeError(code)
def mounts(r):
 return sorted((x['Type'],x.get('Name'),x['Source'],x['Destination'],x['RW'],x.get('Propagation')) for x in r['Mounts'])
def filehash(c,image=None):
 script="const fs=require('fs'),c=require('crypto');console.log(c.createHash('sha256').update(fs.readFileSync("+json.dumps(TARGET)+")).digest('hex'))"
 return c.run((['docker','run','--rm','--network=none','--entrypoint','node',image] if image else ['docker','exec',NAME,'node'])+['-e',script]).strip()
def check(c,p,rollback=False):
 r=c.inspect(NAME);before=p['before'];require(r['Image']==(before['Image'] if rollback else p['image']) and r['State']['Running'],'GATEWAY_IMAGE_DRIFT')
 require(mounts(r)==mounts(before),'AUTH_VOLUME_DRIFT');require(c.envmap(r)==c.envmap(before),'ENVIRONMENT_DRIFT')
 for key in ['User','Entrypoint','Cmd','WorkingDir']:require(r['Config'].get(key)==before['Config'].get(key),'PROCESS_DRIFT')
 for key in ['PortBindings','RestartPolicy','LogConfig','Privileged','CapAdd','CapDrop','SecurityOpt','Devices','NetworkMode','Tmpfs']:
  require(r['HostConfig'].get(key)==before['HostConfig'].get(key),'HOST_CONFIG_DRIFT')
 require(set(r['NetworkSettings']['Networks'])==set(before['NetworkSettings']['Networks']),'NETWORK_DRIFT')
 require(filehash(c)==(BEFORE if rollback else AFTER),'GATEWAY_INSTALLED_SOURCE_DRIFT')
def up(c,p,override):
 require(all(sha(k)==v for k,v in p['inputs'].items()),'COMPOSE_INPUT_DRIFT')
 command,cwd,service=c.compose(p['before'],override)
 c.run(command+['up','-d','--no-deps','--no-build',service],cwd=cwd,timeout=120)
def main():
 a=argparse.ArgumentParser();a.add_argument('mode',choices=['prepare','apply','rollback']);a.add_argument('--root',type=Path,required=True);v=a.parse_args();root=v.root.resolve();root.mkdir(exist_ok=True)
 require(sha(root.parent/'core.py')==CORE_SHA,'OPERATOR_DRIFT')
 spec=importlib.util.spec_from_file_location('core',root.parent/'core.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c);c.LOG_ROOT=root
 # Snapshot every other service, including engine and CRM.
 c.NAMES={'gateway':NAME}
 with open('/var/lock/ava-customer-path-release.lock','a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  if v.mode=='prepare':
   require(not(root/'prepared.private.json').exists(),'ALREADY_PREPARED');before=c.inspect(NAME)
   require(before['Image']==BASE and filehash(c)==BEFORE,'EXACT_PREIMAGE_DRIFT')
   c.run(['docker','tag',BASE,'ava-openwa-media-base:20261023'])
   (root/'Dockerfile').write_text('FROM ava-openwa-media-base:20261023\nCOPY patch-media-mimetype.cjs /tmp/ava-media-patch.cjs\nRUN node /tmp/ava-media-patch.cjs '+TARGET+' && node --check '+TARGET+' && rm /tmp/ava-media-patch.cjs\n')
   c.run(['docker','build','--pull=false','--network=none','-t','ava-openwa-media:20261023',str(root)],timeout=180)
   image=json.loads(c.run(['docker','image','inspect','ava-openwa-media:20261023']))[0]['Id'];require(filehash(c,image)==AFTER,'CANDIDATE_SOURCE_DRIFT')
   inputs={};labels=before['Config']['Labels'];baseline=c.rendered(before)
   for key in ['com.docker.compose.project.config_files','com.docker.compose.project.environment_file']:
    for path in labels.get(key,'').split(','):
     if path:inputs[path]=sha(path)
   p={'before':before,'image':image,'inputs':inputs,'otherContainers':c.other_containers()}
   for mode,img in [('candidate',image),('rollback',BASE)]:
    path=root/(mode+'.private.json');c.private_json(path,{'services':{labels['com.docker.compose.service']:{'image':img,'environment':{k:x.replace('$','$$') for k,x in c.envmap(before).items()}}}})
    rendered=c.rendered(before,path);require(rendered==dict(baseline,image=img,environment=c.envmap(before)),'COMPOSE_CONTRACT_DRIFT')
    p[mode]=str(path);p['inputs'][str(path)]=sha(path)
   p['inputs'][str(root/'patch-media-mimetype.cjs')]=sha(root/'patch-media-mimetype.cjs')
   c.private_json(root/'prepared.private.json',p);print(json.dumps({'phase':'prepared','image':image,'afterHash':AFTER}))
  else:
   p=json.loads((root/'prepared.private.json').read_text())
   require(c.other_containers()==p['otherContainers'],'OTHER_CONTAINER_DRIFT')
   if v.mode=='apply':
    require(c.inspect(NAME)['Id']==p['before']['Id'],'CONTAINER_DRIFT');require(not(root/'apply-started').exists(),'APPLY_ALREADY_ATTEMPTED')
    data=next(x['Source'] for x in p['before']['Mounts'] if x['Destination']=='/app/data')
    c.backup(Path(data)/'openwa.sqlite',root/'openwa-backup.db')
    if (Path(data)/'main.sqlite').is_file():
     with sqlite3.connect((Path(data)/'main.sqlite').as_uri()+'?mode=ro',uri=True) as db:
      has_tables=db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
     if has_tables:c.backup(Path(data)/'main.sqlite',root/'main-backup.db')
    (root/'apply-started').write_text(str(time.time()))
    try:
     up(c,p,p['candidate']);check(c,p)
     require(c.other_containers()==p['otherContainers'],'OTHER_CONTAINER_DRIFT')
     c.private_json(root/'applied.private.json',{'image':p['image'],'sourceHash':AFTER,'authVolumePreserved':True,'databaseRestored':False})
     print(json.dumps({'phase':'applied','image':p['image'],'sourceHash':AFTER,'authVolumePreserved':True}))
    except BaseException:
     up(c,p,p['rollback']);check(c,p,True);raise
   else:
    check(c,p);up(c,p,p['rollback']);check(c,p,True);print(json.dumps({'phase':'rolled_back','databaseRestored':False}))
if __name__=='__main__':
 try:main()
 except Exception as e:
  code=str(e);print(json.dumps({'phase':'failed','code':code if code.replace('_','').isalnum() else type(e).__name__}));raise SystemExit(1)
