#!/usr/bin/env python3
"""Root-coordinated private Onyx API warm-up. Default verify never embeds.
apply recreates only API from the pinned private candidate; root alone runs it.
"""
import argparse,json,subprocess,sys
REMOTE=r'''
import os,json,subprocess,hashlib,stat,tempfile,time,fcntl
ROOT='/root/ava-releases/customer-completion-20261018/knowledge-api-warmup-candidate/20261018T121456Z-10l76pwy'
MANIFEST_SHA='c2663a0dc97c2c5ad892f9bdff3d2e66b53f993c01f3658c41783a73765b66ca'
CANDIDATE_SHA='2718f9395385f70179bc8adf76bcb281557887971393e5f12ba0802261e213e0'
report={'mode':MODE,'pass':False,'apiRecreateAttempts':0,'llmCalls':0,'inferenceRestarted':False,'databaseRestore':False}
class Refused(Exception):
 def __init__(self,code):self.code=code
def need(ok,code):
 if not ok:raise Refused(code)
def canon(v):return json.dumps(v,sort_keys=True,separators=(',',':')).encode()
def sha(v):return hashlib.sha256(canon(v)).hexdigest()
def raw(path,limit=262144):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_size<=limit,'PRIVATE_FILE_UNSAFE');return os.read(fd,limit+1)
 finally:os.close(fd)
def cmd(args,timeout=20,stdin=None):
 p=subprocess.run(args,input=stdin,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=timeout);need(p.returncode==0,'COMMAND_FAILED');return p.stdout
def inspect(name):return json.loads(cmd(['docker','inspect',name]))[0]
def rawfence(c):return {'containerId':c['Id'],'imageDigest':c['Image'],'environmentSha256':sha(sorted(c['Config']['Env'])),'mountsSha256':sha(c['Mounts']),'processSha256':sha({'entrypoint':c['Config']['Entrypoint'],'cmd':c['Config']['Cmd']}),'hostConfigSha256':sha(c['HostConfig'])}
def projection(c):
 h=json.loads(json.dumps(c['HostConfig']));h['Binds']=sorted(h['Binds']) if h.get('Binds') is not None else None
 metadata=[]
 for m in sorted(c['Mounts'],key=lambda x:x['Destination']):
  s=os.lstat(m['Source']);metadata.append([m['Source'],s.st_dev,s.st_ino,s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode)])
 process={k:c['Config'].get(k) for k in ['Entrypoint','Cmd','User','WorkingDir','Healthcheck','StopSignal','ExposedPorts']}
 return {'image':c['Image'],'env':sha(sorted(c['Config']['Env'])),'mounts':sha(sorted(c['Mounts'],key=lambda x:x['Destination'])),'mountSourceMetadata':sha(metadata),'process':sha(process),'hostConfig':sha(h)}
def others():
 for name,want in m['otherNativeContainerIds'].items():
  c=inspect(name);need(c['Id']==want and c['State']['Running'],'OTHER_NATIVE_CONTAINER_CHANGED')
def sources(backup=False):
 paths=[]
 for row in m['sourceBackups']:
  p=row['backup'] if backup else row['source'];need(hashlib.sha256(raw(p)).hexdigest()==row['sha256'],'SOURCE_CONFIG_CHANGED');paths.append(p)
 return paths
def base(paths,extra=False):
 a=['docker','compose','--project-directory',m['projectDirectory'],'-p',m['project']]
 for p in paths:a+=['-f',p]
 return a+(['-f',m['candidatePath']] if extra else [])
def diff(a,b,p=''):
 if type(a)!=type(b):return [p]
 if isinstance(a,dict):
  out=[]
  for k in sorted(set(a)|set(b)):out+=([p+'.'+k] if k not in a or k not in b else diff(a[k],b[k],p+'.'+k))
  return out
 return [] if a==b else [p]
def save(path,data):
 fd,tmp=tempfile.mkstemp(prefix='.receipt-',dir=os.path.dirname(path))
 try:
  os.fchmod(fd,0o600);os.write(fd,canon(data)+b'\n');os.fsync(fd);os.close(fd);fd=None;os.replace(tmp,path)
  d=os.open(os.path.dirname(path),os.O_RDONLY|os.O_DIRECTORY);os.fsync(d);os.close(d)
 finally:
  if fd is not None:os.close(fd)
  if os.path.exists(tmp):os.unlink(tmp)
def capture(label,c,reference=None,expected=None):
 private={'HostConfig':c['HostConfig'],'Mounts':c['Mounts'],'process':{k:c['Config'].get(k) for k in ['Entrypoint','Cmd','User','WorkingDir','Healthcheck','StopSignal','ExposedPorts']},'environmentSha256':sha(sorted(c['Config']['Env']))}
 save(state+'/'+label+'-private.json',private)
 if reference is not None:
  a=json.loads(json.dumps(reference['HostConfig']));b=json.loads(json.dumps(c['HostConfig']))
  for v in [a,b]:
   if v.get('Binds') is not None:v['Binds']=sorted(v['Binds'])
  report[label+'HostConfigDiff']={k:{'beforeSha256':sha({'present':k in a,'value':a.get(k)}),'currentSha256':sha({'present':k in b,'value':b.get(k)})} for k in sorted(set(a)|set(b)) if (k in a,a.get(k))!=(k in b,b.get(k))}
 if expected is not None:
  now=projection(c);report[label+'ChangedProjectionKeys']=[k for k in sorted(set(now)|set(expected)) if now.get(k)!=expected.get(k)]
READY=r"""
import json,math,time,urllib.request
r={'pass':False,'embeddingRequests':0,'llmCalls':0};start=time.monotonic();deadline=start+65
try:
 healthy=False
 while time.monotonic()<start+45:
  try:
   with urllib.request.urlopen('http://127.0.0.1:8080/ava-native-healthz',timeout=2) as response:healthy=response.status==200
   if healthy:break
  except Exception:pass
  time.sleep(.5)
 if not healthy:raise RuntimeError()
 r['apiHealth']=True
 if ENCODE:
  body={'texts':['AVA synthetic search readiness check.'],'model_name':'nomic-ai/nomic-embed-text-v1','max_context_length':512,'normalize_embeddings':True,'provider_type':None,'text_type':'query','manual_query_prefix':'search_query: '}
  request=urllib.request.Request('http://inference_model:9000/encoder/bi-encoder-embed',data=json.dumps(body).encode(),method='POST',headers={'Content-Type':'application/json'})
  began=time.monotonic();r['embeddingRequests']=1
  with urllib.request.urlopen(request,timeout=max(1,min(15,deadline-began))) as response:data=json.loads(response.read(128*1024))
  elapsed=round((time.monotonic()-began)*1000);v=data.get('embeddings');valid=isinstance(v,list) and len(v)==1 and isinstance(v[0],list) and len(v[0])==768
  valid=valid and all(isinstance(x,(int,float)) and not isinstance(x,bool) and math.isfinite(x) for x in v[0]);r.update(embeddingElapsedMs=elapsed,dimensions=768 if valid else 0,embeddingReady=bool(valid))
  if not valid or elapsed>=5000:raise RuntimeError()
 r['pass']=True
except Exception:r['errorCode']='BOUNDED_READINESS_FAILED'
r['elapsedMs']=round((time.monotonic()-start)*1000);print(json.dumps(r))
"""
def ready(encode):return json.loads(cmd(['docker','exec','-i',api_name,'python','-'],70,'ENCODE='+repr(encode)+'\n'+READY))
def recreate(paths,extra):
 report['apiRecreateAttempts']+=1;cmd(base(paths,extra)+['up','-d','--no-deps','--pull','never','--force-recreate','api'],60)
state=None;mutating=False;before=None;before_normalized=None;lock=None
try:
 need(os.getuid()==0 and stat.S_ISDIR(os.lstat(ROOT).st_mode) and stat.S_IMODE(os.lstat(ROOT).st_mode)==0o700,'ROOT_OR_STATE_UNSAFE')
 lock=os.open(ROOT+'/.warmup.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 b=raw(ROOT+'/manifest.json');need(hashlib.sha256(b).hexdigest()==MANIFEST_SHA,'MANIFEST_CHANGED');m=json.loads(b)
 need(m['candidateSha256']==CANDIDATE_SHA and hashlib.sha256(raw(m['candidatePath'])).hexdigest()==CANDIDATE_SHA,'CANDIDATE_CHANGED')
 api_name=m['project']+'-api-1';others();paths=sources();before=inspect(api_name)
 if MODE=='verify':
  last=json.loads(raw(ROOT+'/last-success.json'));need(last['manifestSha256']==MANIFEST_SHA and last['candidateSha256']==CANDIDATE_SHA,'RECEIPT_SCOPE_CHANGED')
  need(before['Id']==last['afterApiId'] and projection(before)==last['expectedAfter'],'CURRENT_API_CHANGED');need(last['readiness']['pass'] and last['readiness']['embeddingRequests']==1 and last['readiness']['embeddingElapsedMs']<5000,'NO_ACCEPTED_EMBEDDING_RECEIPT')
  report['health']=ready(False);need(report['health']['pass'],'VERIFY_HEALTH_FAILED');others();report.update({'pass':True,'embeddingReceiptReused':True,'embeddingRequests':0})
 else:
  need(MODE=='apply' and rawfence(before)==m['beforeApiFence'] and sha(rawfence(before))==m['beforeApiFenceSha256'],'API_BEFORE_PINS_CHANGED')
  old=json.loads(cmd(base(paths)+['config','--format','json']));new=json.loads(cmd(base(paths,True)+['config','--format','json']))
  need(diff(old,new)==['.services.api.environment.SKIP_WARM_UP'] and new['services']['api']['image']==before['Image'],'COMPOSE_DIFF_OR_IMAGE_CHANGED')
  env=before['Config']['Env'];need(len({s.split('=',1)[0] for s in env})==len(env),'DUPLICATE_ENV_KEYS');before_normalized=projection(before);expected=dict(before_normalized);expected['env']=sha(sorted([s for s in env if not s.startswith('SKIP_WARM_UP=')]+['SKIP_WARM_UP=false']))
  state=tempfile.mkdtemp(prefix='apply-'+time.strftime('%Y%m%dT%H%M%SZ-'),dir=ROOT);os.chmod(state,0o700)
  capture('before',before);save(state+'/before.json',{'manifestSha256':MANIFEST_SHA,'candidateSha256':CANDIDATE_SHA,'beforeFence':rawfence(before),'beforeNormalized':before_normalized,'expectedAfter':expected,'otherNativeIdsSha256':m['otherNativeContainerIdsSha256']})
  others();need(rawfence(inspect(api_name))==m['beforeApiFence'],'PRE_APPLY_DRIFT');sources();mutating=True;recreate(paths,True)
  after=inspect(api_name);capture('after',after,before,expected);need(after['State']['Running'] and projection(after)==expected,'API_AFTER_CONFIG_CHANGED');others()
  report['readiness']=ready(True);need(report['readiness']['pass'],'READINESS_NOT_ACCEPTED');after=inspect(api_name);capture('postReadiness',after,before,expected);need(projection(after)==expected,'POST_READINESS_CONFIG_CHANGED');others()
  report.update({'pass':True,'manifestSha256':MANIFEST_SHA,'candidateSha256':CANDIDATE_SHA,'afterApiId':after['Id'],'expectedAfter':expected,'receiptDirectory':state,'rollbackPerformed':False})
  save(ROOT+'/last-success.json',report)
except Exception as error:
 report['pass']=False;report['errorCode']=getattr(error,'code','WARMUP_HELPER_FAILED')
 if mutating:
  try:
   recreate(sources(True),False);restored=inspect(api_name);capture('rollback',restored,before,before_normalized);need(projection(restored)==before_normalized,'ROLLBACK_CONFIG_MISMATCH');others();health=ready(False);need(health['pass'],'ROLLBACK_HEALTH_FAILED');report.update(rollbackPerformed=True,rollbackVerified=True)
  except Exception as rollback_error:report.update(rollbackPerformed=False,rootReconciliationRequired=True,rollbackErrorCode=getattr(rollback_error,'code','ROLLBACK_FAILED'))
finally:
 if state:
  try:save(state+'/receipt.json',report)
  except Exception:report['privateReceiptWriteFailed']=True
 if lock is not None:os.close(lock)
print(json.dumps(report,sort_keys=True));sys.exit(0 if report['pass'] else 1)
'''
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--mode',choices=['apply','verify'],default='verify');p.add_argument('--on-host',action='store_true');a=p.parse_args()
 command=[sys.executable,'-'] if a.on_host else ['ssh','-i','/Users/developer/.ssh/ava-deploy-ed25519','-o','BatchMode=yes','-o','ConnectTimeout=8','root@203.0.113.10','python3 -']
 try:
  r=subprocess.run(command,input='MODE='+repr(a.mode)+'\n'+REMOTE,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=360);value=json.loads(r.stdout)
 except Exception:print(json.dumps({'pass':False,'errorCode':'COORDINATOR_TRANSPORT_FAILED','stderrRetained':False}));return 1
 print(json.dumps(value,indent=2,sort_keys=True));return 0 if value.get('pass') else 1
if __name__=='__main__':raise SystemExit(main())
