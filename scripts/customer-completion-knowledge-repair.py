#!/usr/bin/env python3
"""Pinned, root-coordinated Onyx runtime config repair. Default: inspect only.

Run locally with --mode inspect/apply/verify (SSH); root may use --on-host.
No DB/index/account writes, service startup/restart or generation. apply publishes
one previously absent config, then checks the real default admission/readback.
Secrets stay in process memory and private stdin; stdout/receipts contain metadata.
"""
import argparse
import json
import subprocess
import sys

REMOTE = r'''
import os,sys,json,subprocess,hashlib,stat,tempfile,time,re
EXPECTED_MANIFEST='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
EXPECTED_CANDIDATE='116c7bc7d1d7d65d9d128a6c598b31bbdf26bdfc9deade0aed71185d5e8f61e1'
EXPECTED_FENCE='5551e15361a834dff604fa8d12e8ddb2a0be44808f4834e1454ad1b74ca6b761'
EXPECTED_CONTAINER_DIR='/run/ava-onyx-runtime'
EXPECTED_HOST_DIR='/opt/ava-deploy/lud-recovery-20260929/native-runtime'
STATE_ROOT='/root/ava-releases/customer-completion-20261018/knowledge-runtime-repair'
report={'mode':MODE,'liveDatabaseWrites':0,'indexMutations':0,'accountMutations':0,'restarts':0,'generations':0,'configWrites':0,'pass':False}
class Refused(Exception):
 def __init__(self,code):self.code=code

def require(ok,code):
 if not ok:raise Refused(code)
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def digest(v):return hashlib.sha256(canonical(v)).hexdigest()
def file_bytes(p,limit=8192):
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  st=os.fstat(fd);require(stat.S_ISREG(st.st_mode) and st.st_size<=limit,'UNSAFE_FILE');return os.read(fd,limit+1)
 finally:os.close(fd)
def docker_json(name,script,values=None):
 # Values may include the existing secret. They go only through private stdin.
 source=('INPUT='+repr(json.dumps(values))+'\n' if values is not None else '')+script
 p=subprocess.run(['docker','exec','-i',name,'python','-'],input=source,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=18)
 require(p.returncode==0,'CONTAINER_READ_PROBE_FAILED')
 try:v=json.loads(p.stdout)
 except Exception:raise Refused('CONTAINER_INVALID_RECEIPT')
 require(not v.get('probeError'),'CONTAINER_SAFE_ERROR');return v
SNAPSHOT=r"""
import os,json,sqlite3
c=sqlite3.connect('file:'+os.environ['DB_PATH']+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
try:
 rows=c.execute("SELECT i.id AS business_id,d.id AS deployment_id,d.revision AS deployment_revision,d.namespace,d.state, (SELECT COUNT(*) FROM knowledge_base k WHERE k.instanceId=i.id AND k.isCurrent=1 AND EXISTS(SELECT 1 FROM kb_chunks x WHERE x.kbId=k.id AND length(trim(x.text))>12)) documents FROM instances i LEFT JOIN ava_module_deployments d ON d.businessId=i.id AND d.module='onyx' WHERE i.isActive=1 AND COALESCE(i.knowledgeBaseInstanceId,i.id)=i.id AND EXISTS(SELECT 1 FROM knowledge_base k JOIN kb_chunks x ON x.kbId=k.id WHERE k.instanceId=i.id AND k.isCurrent=1 AND length(trim(x.text))>12) ORDER BY i.id").fetchall()
 eligible=[dict(r) for r in rows if r['state']=='verified'];selected=eligible[0] if len(eligible)==1 else None
 fence=None
 if selected:
  found=c.execute("SELECT i.id AS business_id,i.isActive,COALESCE(i.knowledgeBaseInstanceId,i.id) AS knowledge_scope, d.id AS deployment_id,d.revision AS deployment_revision,d.namespace,d.state, a.id AS adapter_id,a.revision AS adapter_revision,a.enabled,a.attachmentMode,a.attachmentModeV2,a.deploymentId AS adapter_deployment,a.deploymentRevision AS adapter_deployment_revision,a.nativeScope,a.peerSecretHash,a.integrationId,a.integrationRevision, p.id AS principal_id,p.adapterId,p.adapterRevision,p.deploymentId AS principal_deployment,p.deploymentRevision AS principal_deployment_revision,p.integrationRevision AS principal_integration_revision,p.nativeScope AS principal_namespace,p.servicePrincipalId,p.subject,p.nativeUserId,p.admittedAt,p.revokedAt, t.id AS tenant_id,t.revision AS tenant_revision,t.status AS tenant_status, b.deployment_id AS binding_deployment,b.deployment_revision AS binding_revision,b.role,b.persona_id,b.document_set_name,b.search_tool_id FROM instances i JOIN ava_module_deployments d ON d.businessId=i.id AND d.module='onyx' JOIN ava_module_adapters a ON a.businessId=i.id AND a.module='onyx' AND a.enabled=1 JOIN ava_onyx_runtime_principals p ON p.businessId=i.id AND p.adapterId=a.id JOIN onyx_tenant_links t ON t.business_id=i.id JOIN onyx_native_runtime_bindings b ON b.business_id=i.id AND b.role='sales' WHERE i.id=?",(selected['business_id'],)).fetchall()
  if len(found)==1:fence=dict(found[0])
 print(json.dumps({'corpora':[dict(r) for r in rows],'selected':selected,'fence':fence,'runtimeDirectory':os.environ.get('AVA_ONYX_NATIVE_RUNTIME_DIRECTORY')}))
finally:c.close()
"""
ADMISSION=r"""
import os,sys,json,sqlite3,logging
logging.disable(logging.CRITICAL);sys.path.insert(0,'/opt/ava-runtime-source')
from src.core.onyx_native_runtime_config import native_runtime_config,native_runtime_scope
v=json.loads(INPUT);candidate=v['candidate'];business=candidate['business_id'];raw=dict(candidate);raw.pop('business_id');r={}
try:
 r['candidateAdmitted']=native_runtime_scope(os.environ['DB_PATH'],business,provider=lambda b:raw if b==business else None) is not None
 actual=native_runtime_config(business);r['defaultPresent']=actual is not None
 r['defaultAdmitted']=native_runtime_scope(os.environ['DB_PATH'],business) is not None
 r['defaultExact']=actual==raw if actual is not None else False
except Exception as error:r['safeCode']=getattr(error,'code','NATIVE_ADMISSION_READBACK_FAILED')
print(json.dumps(r))
"""

def inspect_container(name):
 p=subprocess.run(['docker','inspect',name],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=8)
 require(p.returncode==0,'CONTAINER_NOT_FOUND');v=json.loads(p.stdout);require(len(v)==1,'CONTAINER_AMBIGUOUS');return v[0]
def directory_manifest(fd):
 rows=[]
 for name in sorted(os.listdir(fd)):
  if not name.endswith('.json'):continue
  st=os.stat(name,dir_fd=fd,follow_symlinks=False);require(stat.S_ISREG(st.st_mode),'RUNTIME_CONFIG_SYMLINK_OR_NONFILE')
  f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
  try:
   data=os.read(f,4097);require(len(data)<=4096,'RUNTIME_CONFIG_TOO_LARGE');rows.append([name,hashlib.sha256(data).hexdigest()])
  finally:os.close(f)
 return rows

def prepare():
 require(os.getuid()==0,'ROOT_REQUIRED')
 s=docker_json('admin_ui',SNAPSHOT);require(s['selected'] is not None and s['fence'] is not None,'EXACT_ONE_VERIFIED_CORPUS_REQUIRED')
 selected=s['selected'];gateway=inspect_container(selected['namespace']+'-gateway-1');admin=inspect_container('admin_ui')
 require(gateway['State']['Running'] and (gateway['State'].get('Health') or {}).get('Status')=='healthy','GATEWAY_NOT_HEALTHY')
 mounts={m['Destination']:m for m in gateway['Mounts']};cfg=json.loads(file_bytes(mounts['/run/ava/gateway.json']['Source']))
 peer=file_bytes(mounts['/run/ava/secrets/runtime-peer']['Source'],256).decode().strip();require(re.fullmatch('[A-Za-z0-9_-]{43}',peer) is not None,'RUNTIME_PEER_INVALID')
 broker_peer=file_bytes(mounts['/run/ava/secrets/broker-peer']['Source'],256).decode().strip()
 require(hashlib.sha256(broker_peer.encode()).hexdigest()==s['fence']['peerSecretHash'],'ADAPTER_PEER_MISMATCH')
 native_peer=file_bytes(mounts['/run/ava/secrets/native-peer']['Source'],256).decode().strip();require(peer not in [broker_peer,native_peer],'RUNTIME_PEER_NOT_DISTINCT')
 require(cfg.get('runtimeEnabled') is True and cfg.get('businessId')==selected['business_id'] and cfg.get('deploymentId')==selected['deployment_id'] and cfg.get('revision')==selected['deployment_revision'],'GATEWAY_SCOPE_MISMATCH')
 require(set(gateway['NetworkSettings']['Networks'])&set(admin['NetworkSettings']['Networks']),'NO_SHARED_PRIVATE_NETWORK')
 require(s['runtimeDirectory']==EXPECTED_CONTAINER_DIR,'RUNTIME_DIRECTORY_CHANGED')
 relevant=[m for m in admin['Mounts'] if EXPECTED_CONTAINER_DIR==m['Destination'] or EXPECTED_CONTAINER_DIR.startswith(m['Destination'].rstrip('/')+'/')];relevant.sort(key=lambda m:len(m['Destination']),reverse=True)
 require(bool(relevant),'RUNTIME_MOUNT_MISSING');mount=relevant[0];host=mount['Source']+EXPECTED_CONTAINER_DIR[len(mount['Destination']):]
 require(host==EXPECTED_HOST_DIR and not mount['RW'],'RUNTIME_MOUNT_CHANGED')
 fd=os.open(host,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);st=os.fstat(fd);require(st.st_uid==0 and st.st_gid==1000 and stat.S_IMODE(st.st_mode)==0o750,'RUNTIME_DIRECTORY_METADATA_CHANGED')
 candidate={k:selected[k] for k in ['business_id','deployment_id','deployment_revision']};candidate.update({'enabled':True,'private_gateway_origin':'http://'+selected['namespace']+'-gateway-1:4081','runtime_peer_secret':peer})
 require(digest(candidate)==EXPECTED_CANDIDATE,'CANDIDATE_HASH_CHANGED')
 fence=digest(s['fence']);manifest=directory_manifest(fd);admission=docker_json('admin_ui',ADMISSION,{'candidate':candidate})
 require(admission.get('candidateAdmitted') is True,'CANDIDATE_ADMISSION_DENIED')
 target=str(selected['business_id'])+'.json';target_present=target in os.listdir(fd)
 inventory={'activeNonemptyCorpusBusinessCount':len(s['corpora']),'verifiedNativeGatewayAndAdmissionCount':1,'verifiedNativeGatewayAndAdmissionMissingConfigCount':int(not target_present),'otherActiveCorpusBusinessesWithoutVerifiedDeployment':len(s['corpora'])-1}
 report.update({'inventory':inventory,'currentManifestSha256':digest(manifest),'expectedManifestMatches':digest(manifest)==EXPECTED_MANIFEST,'candidateCanonicalSha256':digest(candidate),'currentAdmissionFenceSha256':fence,'expectedAdmissionFenceMatches':fence==EXPECTED_FENCE,'targetPresent':target_present,'candidateAdmitted':True,'defaultAdmitted':admission.get('defaultAdmitted',False),'defaultExact':admission.get('defaultExact',False),'runtimeDirectoryMetadataValid':True,'adapterPeerMatches':True,'runtimePeerDistinct':True})
 return s,candidate,fd,st,manifest,target,admission

def verify_existing(candidate,fd,target):
 data=file_bytes(EXPECTED_HOST_DIR+'/'+target,4096);st=os.stat(target,dir_fd=fd,follow_symlinks=False)
 require(stat.S_ISREG(st.st_mode) and st.st_uid==0 and st.st_gid==1000 and stat.S_IMODE(st.st_mode)==0o440,'TARGET_METADATA_INVALID')
 require(data==canonical(candidate),'TARGET_BYTES_MISMATCH')
 v=docker_json('admin_ui',ADMISSION,{'candidate':candidate});require(v.get('defaultPresent') and v.get('defaultAdmitted') and v.get('defaultExact'),'DEFAULT_NATIVE_READBACK_FAILED')
 fresh=docker_json('admin_ui',SNAPSHOT);require(digest(fresh['fence'])==EXPECTED_FENCE,'POSTWRITE_ADMISSION_FENCE_CHANGED')
 report.update({'defaultAdmitted':True,'defaultExact':True,'targetMetadataValid':True,'targetSha256':hashlib.sha256(data).hexdigest()})

def run():
 fd=None;tempname=None;installed=None;state_dir=None
 try:
  s,candidate,fd,original,manifest,target,admission=prepare()
  if MODE=='inspect':report['pass']=True;return
  require(EXPECTED_FENCE!='PIN_AFTER_INSPECT' and report['expectedAdmissionFenceMatches'],'ADMISSION_FENCE_CHANGED')
  if MODE=='verify':verify_existing(candidate,fd,target);report['pass']=True;return
  require(MODE=='apply','UNKNOWN_MODE');require(report['expectedManifestMatches'],'RUNTIME_MANIFEST_CHANGED');require(not report['targetPresent'],'TARGET_EXISTS_USE_VERIFY');require(not admission.get('defaultPresent'),'UNEXPECTED_DEFAULT_CONFIG')
  os.makedirs(STATE_ROOT,mode=0o700,exist_ok=True);state_meta=os.lstat(STATE_ROOT);require(stat.S_ISDIR(state_meta.st_mode) and state_meta.st_uid==0 and stat.S_IMODE(state_meta.st_mode)==0o700,'STATE_DIRECTORY_UNSAFE')
  state_dir=tempfile.mkdtemp(prefix=time.strftime('%Y%m%dT%H%M%SZ-'),dir=STATE_ROOT);os.chmod(state_dir,0o700)
  backup={'targetOriginallyAbsent':True,'targetFilename':target,'directoryMetadata':{'uid':original.st_uid,'gid':original.st_gid,'mode':oct(stat.S_IMODE(original.st_mode))},'jsonManifest':manifest,'manifestSha256':digest(manifest),'candidateCanonicalSha256':digest(candidate),'admissionFenceSha256':report['currentAdmissionFenceSha256']}
  with open(state_dir+'/before.json','x') as f:os.chmod(f.fileno(),0o600);json.dump(backup,f,sort_keys=True);f.flush();os.fsync(f.fileno())
  state_fd=os.open(state_dir,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:os.fsync(state_fd)
  finally:os.close(state_fd)
  # Final pre-publication guards; do not overwrite another coordinator's file.
  require(digest(directory_manifest(fd))==EXPECTED_MANIFEST and target not in os.listdir(fd),'PREWRITE_STATE_CHANGED')
  require(digest(docker_json('admin_ui',SNAPSHOT)['fence'])==EXPECTED_FENCE,'PREWRITE_ADMISSION_CHANGED')
  tempname='.knowledge-repair-'+os.urandom(12).hex();tmp=os.open(tempname,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
  try:
   os.fchown(tmp,0,1000);os.fchmod(tmp,0o440);data=canonical(candidate);require(os.write(tmp,data)==len(data),'SHORT_CONFIG_WRITE');os.fsync(tmp);owned=os.fstat(tmp)
  finally:os.close(tmp)
  # Hard-link publish is atomic and no-clobber; the temp name is then removed.
  os.link(tempname,target,src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False);installed=(owned.st_dev,owned.st_ino);report['configWrites']=1;os.unlink(tempname,dir_fd=fd);tempname=None;os.fsync(fd)
  verify_existing(candidate,fd,target);report['pass']=True;report['backupStateDirectory']=state_dir;report['rollbackPerformed']=False
 except Exception as error:
  report['errorCode']=getattr(error,'code','REPAIR_HELPER_FAILED')
  if installed is not None and fd is not None:
   quarantine=None;qfd=None
   try:
    # Capture the current target atomically before testing ownership. Other
    # coordinators may replace target; they never own this unique 0700 directory.
    qname='.knowledge-repair-quarantine-'+os.urandom(12).hex();os.mkdir(qname,0o700,dir_fd=fd);quarantine=qname
    qfd=os.open(quarantine,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);qmeta=os.fstat(qfd)
    require(qmeta.st_uid==os.getuid() and stat.S_IMODE(qmeta.st_mode)==0o700,'QUARANTINE_NOT_OWNED')
    os.rename(target,'config',src_dir_fd=fd,dst_dir_fd=qfd);os.fsync(qfd);os.fsync(fd)
    moved=os.stat('config',dir_fd=qfd,follow_symlinks=False);owned_moved=False
    if stat.S_ISREG(moved.st_mode):
     captured=os.open('config',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=qfd)
     try:
      current=os.fstat(captured);data=os.read(captured,4097)
      owned_moved=(current.st_dev,current.st_ino)==installed and data==canonical(candidate)
     finally:os.close(captured)
    if owned_moved:
     os.unlink('config',dir_fd=qfd);os.fsync(qfd);os.rmdir(quarantine,dir_fd=fd);os.fsync(fd)
     report['rollbackPerformed']=True;report['originalAbsenceRestored']=target not in os.listdir(fd)
     if not report['originalAbsenceRestored']:report['rootReconciliationRequired']=True
    else:
     # Preserve the foreign inode even after a successful no-clobber restore:
     # a later replacement of target must not delete its last retained copy.
     try:os.link('config',target,src_dir_fd=qfd,dst_dir_fd=fd,follow_symlinks=False);os.fsync(fd);report['foreignTargetRestored']=True
     except FileExistsError:report['foreignTargetRestored']=False
     report['rollbackPerformed']=False;report['rootReconciliationRequired']=True
   except Exception:report['rollbackPerformed']=False;report['rootReconciliationRequired']=True
   finally:
    if qfd is not None:os.close(qfd)
    if quarantine and quarantine in os.listdir(fd):
     try:os.rmdir(quarantine,dir_fd=fd);os.fsync(fd)
     except OSError:report['quarantineRetained']=quarantine;report['rootReconciliationRequired']=True
 finally:
  if tempname and fd is not None:
   try:os.unlink(tempname,dir_fd=fd)
   except Exception:report['tempCleanupFailed']=True
  if fd is not None:os.close(fd)
  if state_dir:
   try:
    with open(state_dir+'/receipt.json','x') as f:os.chmod(f.fileno(),0o600);json.dump(report,f,sort_keys=True);f.flush();os.fsync(f.fileno())
   except Exception:report['privateReceiptWriteFailed']=True
run();print(json.dumps(report,sort_keys=True));sys.exit(0 if report['pass'] else 1)
'''


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--mode',choices=['inspect','apply','verify'],default='inspect')
    p.add_argument('--on-host',action='store_true',help='Run as root on the deployment host, without SSH')
    args=p.parse_args()
    code='MODE='+repr(args.mode)+'\n'+REMOTE
    command=[sys.executable,'-'] if args.on_host else ['ssh','-i','/Users/developer/.ssh/ava-deploy-ed25519','-o','BatchMode=yes','-o','ConnectTimeout=8','root@203.0.113.10','python3 -']
    try:
        proc=subprocess.run(command,input=code,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=100)
        value=json.loads(proc.stdout.strip())
    except Exception:
        print(json.dumps({'pass':False,'mode':args.mode,'errorCode':'REPAIR_COORDINATOR_TRANSPORT_FAILED','stderrRetained':False}));return 1
    print(json.dumps(value,indent=2,sort_keys=True));return 0 if value.get('pass') else 1


if __name__=='__main__':raise SystemExit(main())
