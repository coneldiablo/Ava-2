#!/usr/bin/env python3
"""Read-only original Compose intent/current Onyx API reconciliation; never repins."""
import argparse,json,subprocess,sys
REMOTE=r'''
import os,sys,json,subprocess,hashlib,stat,tempfile,time,re,decimal,shlex
ROOT='/root/ava-releases/customer-completion-20261018/knowledge-api-warmup-candidate/20261018T121456Z-10l76pwy'
MANIFEST_SHA='c2663a0dc97c2c5ad892f9bdff3d2e66b53f993c01f3658c41783a73765b66ca'
STATE_ROOT='/root/ava-releases/customer-completion-20261018/onyx-hostconfig-reconcile'
report={'kind':'onyx-original-compose-readonly-reconciliation','productionMutations':0,'generations':0,'embeddings':0,'restarts':0,'baselineRepinned':False,'pass':False}
state=None
class Refused(Exception):
 def __init__(self,code):self.code=code

def need(value,code):
 if not value:raise Refused(code)
def canon(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def sha(value):return hashlib.sha256(canon(value)).hexdigest()
def raw(path):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_size<=262144,'PRIVATE_SOURCE_UNSAFE')
  return os.read(fd,262145)
 finally:os.close(fd)
def command(args):
 p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=20)
 need(p.returncode==0,'READONLY_COMMAND_FAILED');return json.loads(p.stdout)
def inspect(name):
 rows=command(['docker','inspect',name]);need(len(rows)==1,'AMBIGUOUS_CONTAINER');return rows[0]
def duration(value):
 if isinstance(value,int):return value
 parts=re.findall(r'(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)',str(value));need(''.join(n+u for n,u in parts)==str(value),'DURATION_UNSUPPORTED')
 scale={'ns':1,'us':1000,'µs':1000,'ms':1000000,'s':1000000000,'m':60000000000,'h':3600000000000}
 return int(sum(decimal.Decimal(n)*scale[u] for n,u in parts))
def save(path,value):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  data=canon(value)+b'\n';need(os.write(fd,data)==len(data),'PRIVATE_SHORT_WRITE');os.fsync(fd)
 finally:os.close(fd)
def envmap(values):return dict(item.split('=',1) for item in values)
def main():
 global state
 need(os.getuid()==0,'ROOT_REQUIRED')
 b=raw(ROOT+'/manifest.json');need(hashlib.sha256(b).hexdigest()==MANIFEST_SHA,'MANIFEST_CHANGED');m=json.loads(b)
 need(len(m['sourceBackups'])==3,'EXACT_THREE_ORIGINAL_FILES_REQUIRED')
 for item in m['sourceBackups']:
  for key in ('source','backup'):need(hashlib.sha256(raw(item[key])).hexdigest()==item['sha256'],'ORIGINAL_FILE_HASH_CHANGED')
 report['originalThreeSourceAndBackupHashesMatch']=True
 c=inspect(m['project']+'-api-1');need(c['Image']==m['beforeApiFence']['imageDigest'] and c['State']['Running'],'API_IMAGE_OR_RUNNING_CHANGED')
 for name,want in m['otherNativeContainerIds'].items():
  other=inspect(name);need(other['Id']==want and other['State']['Running'],'OTHER_NATIVE_ID_CHANGED')
 report['apiImagePinned']=True;report['otherNativeIdsMatch']=True
 os.makedirs(STATE_ROOT,mode=0o700,exist_ok=True);meta=os.lstat(STATE_ROOT);need(stat.S_ISDIR(meta.st_mode) and meta.st_uid==0 and stat.S_IMODE(meta.st_mode)==0o700,'PRIVATE_STATE_UNSAFE')
 state=tempfile.mkdtemp(prefix=time.strftime('%Y%m%dT%H%M%SZ-'),dir=STATE_ROOT);os.chmod(state,0o700)
 save(state+'/actual-hostconfig.private.json',{'HostConfig':c['HostConfig'],'containerId':c['Id'],'image':c['Image'],'environmentSha256':sha(sorted(c['Config']['Env'])),'manifestSha256':MANIFEST_SHA})
 report['privateProofRetained']=True;report['privateProofDirectorySha256']=sha(state)
 args=['docker','compose','--project-directory',m['projectDirectory'],'-p',m['project']]
 for item in m['sourceBackups']:args+=['-f',item['backup']]
 composition=command(args+['config','--format','json']);service=composition['services']['api'];hc=c['HostConfig'];config=c['Config']
 save(state+'/compose-intent.private.json',{'api':{key:value for key,value in service.items() if key!='environment'},'environmentSha256':sha(service.get('environment',{})),'originalSources':m['sourceBackups']})
 image=command(['docker','image','inspect',c['Image']])[0]['Config']
 checks={};expected={};actual={}
 def compare(name,want,have):checks[name]=want==have;expected[name]=sha(want);actual[name]=sha(have)
 known={'cap_drop','command','cpus','depends_on','entrypoint','environment','healthcheck','image','labels','mem_limit',
  'networks','pids_limit','read_only','restart','security_opt','tmpfs','user','working_dir','stop_grace_period','stop_signal',
  'ports','volumes','privileged','cap_add','devices','group_add','network_mode','pid','ipc','uts','shm_size','ulimits',
  'dns','dns_opt','dns_search','extra_hosts','init','runtime','logging','mem_reservation','memswap_limit','oom_kill_disable',
  'oom_score_adj','cpu_shares','cpu_period','cpu_quota','cpuset','sysctls','stdin_open','tty','hostname','domainname'}
 unknown=sorted(set(service)-known);report['unhandledComposeFieldNames']=unknown;need(not unknown,'UNHANDLED_COMPOSE_FIELDS')
 compare('image',service['image'],c['Image'])
 direct={'read_only':'ReadonlyRootfs','pids_limit':'PidsLimit','mem_limit':'Memory','mem_reservation':'MemoryReservation',
  'memswap_limit':'MemorySwap','privileged':'Privileged','cap_add':'CapAdd','cap_drop':'CapDrop','group_add':'GroupAdd',
  'network_mode':'NetworkMode','pid':'PidMode','ipc':'IpcMode','uts':'UTSMode','shm_size':'ShmSize','runtime':'Runtime',
  'oom_kill_disable':'OomKillDisable','oom_score_adj':'OomScoreAdj','cpu_shares':'CpuShares','cpu_period':'CpuPeriod',
  'cpu_quota':'CpuQuota','cpuset':'CpusetCpus','dns':'Dns','dns_opt':'DnsOptions','dns_search':'DnsSearch','extra_hosts':'ExtraHosts',
  'init':'Init','sysctls':'Sysctls'}
 covered_hc=set()
 for name,key in direct.items():
  if name in service:
   value=service[name]
   if name in ['mem_limit','mem_reservation','memswap_limit'] and isinstance(value,str):
    need(re.fullmatch(r'-?\d+',value) is not None,'COMPOSE_MEMORY_NOT_DECIMAL_BYTES')
    value=int(value);report['composeDecimalMemoryBytesComparedExactly']=True
   compare('HostConfig.'+key,value,hc.get(key));covered_hc.add(key)
 if 'cpus' in service:
  compare('HostConfig.NanoCpus',int(decimal.Decimal(str(service['cpus']))*1000000000),hc.get('NanoCpus'));covered_hc.add('NanoCpus')
 if 'security_opt' in service:
  compare('HostConfig.SecurityOpt',service['security_opt'],hc.get('SecurityOpt'));covered_hc.add('SecurityOpt')
 if 'restart' in service:
  restart=service['restart'].split(':',1);want={'Name':restart[0],'MaximumRetryCount':int(restart[1]) if len(restart)>1 else 0}
  compare('HostConfig.RestartPolicy',want,hc.get('RestartPolicy'));covered_hc.add('RestartPolicy')
 if 'tmpfs' in service:
  tmp={}
  for entry in service['tmpfs']:
   target,separator,options=entry.partition(':');need(target not in tmp,'TMPFS_DESTINATION_COLLISION');tmp[target]=options if separator else ''
  compare('HostConfig.Tmpfs',tmp,hc.get('Tmpfs'));covered_hc.add('Tmpfs')
 if 'volumes' in service:
  want=[]
  for mount in service['volumes']:
   need(mount['type'] in ['bind','volume'],'UNSUPPORTED_VOLUME_KIND')
   if mount['type']=='bind':origin=os.path.realpath(mount['source'])
   else:
    need(not mount.get('volume'),'UNHANDLED_VOLUME_OPTIONS');origin=composition['volumes'][mount['source']]['name']
   want.append([mount['type'],origin,mount['target'],bool(mount.get('read_only',False)),mount.get('bind',{}).get('propagation') or 'rprivate'])
  have=[[mount['Type'],mount['Name'] if mount['Type']=='volume' else os.path.realpath(mount['Source']),mount['Destination'],not mount['RW'],mount.get('Propagation') or 'rprivate'] for mount in c['Mounts']]
  need(len({row[2] for row in want})==len(want) and len({row[2] for row in have})==len(have),'MOUNT_DESTINATION_COLLISION')
  compare('mounts.exactBindingsAndNamedVolumes',sorted(want),sorted(have));covered_hc.update(['Binds','Mounts'])
 for key in ['devices','ulimits','ports','logging']:
  need(key not in service,'UNHANDLED_EXPLICIT_RESOURCE_SETTING')
 for name,key in [('entrypoint','Entrypoint'),('command','Cmd'),('user','User'),('working_dir','WorkingDir'),
                  ('stop_signal','StopSignal'),('stdin_open','OpenStdin'),('tty','Tty'),('hostname','Hostname'),('domainname','Domainname')]:
  if name in service:
   value=service[name]
   if value is None:value=image.get(key)
   if name in ('entrypoint','command') and isinstance(value,str):value=shlex.split(value)
   compare('process.'+key,value,config.get(key))
  elif name in ['entrypoint','command','user','working_dir','stop_signal']:
   compare('imageInherited.'+key,image.get(key),config.get(key))
 if 'stop_grace_period' in service:compare('process.StopTimeout',duration(service['stop_grace_period'])//1000000000,config.get('StopTimeout'))
 if 'healthcheck' in service:
  health=service['healthcheck'];have=config.get('Healthcheck',{})
  fields={'test':'Test','interval':'Interval','timeout':'Timeout','start_period':'StartPeriod','start_interval':'StartInterval','retries':'Retries'}
  need(set(health)<=set(fields)|{'disable'},'HEALTHCHECK_FIELD_UNSUPPORTED')
  for key,want in health.items():
   if key=='disable':
    if want:compare('process.Healthcheck.Test',['NONE'],have.get('Test'))
   else:compare('process.Healthcheck.'+fields[key],duration(want) if key in ('interval','timeout','start_period','start_interval') else want,have.get(fields[key]))
 for key,value in service.get('labels',{}).items():compare('labels.'+key,value,config['Labels'].get(key))
 before=m['beforeApiFence'];compare('environment.originalFullHash',before['environmentSha256'],sha(sorted(config['Env'])))
 for key,value in service.get('environment',{}).items():compare('environment.'+key,str(value) if value is not None else None,envmap(config['Env']).get(key))
 networks=service.get('networks',{});want_names={composition['networks'][name].get('name',m['project']+'_'+name) for name in networks}
 compare('networks.exactNames',sorted(want_names),sorted(c['NetworkSettings']['Networks']))
 if 'network_mode' not in service:checks['HostConfig.NetworkModeUsesDeclaredNetwork']=hc.get('NetworkMode') in want_names;covered_hc.add('NetworkMode')
 for name,options in networks.items():
  options=options or {};network_name=composition['networks'][name].get('name',m['project']+'_'+name);connected=c['NetworkSettings']['Networks'].get(network_name,{})
  need(set(options)<= {'aliases','ipv4_address','ipv6_address','link_local_ips','mac_address','priority','gw_priority'},'NETWORK_SETTING_UNSUPPORTED')
  for setting,field in [('ipv4_address','IPAddress'),('ipv6_address','GlobalIPv6Address'),('mac_address','MacAddress')]:
   if setting in options:compare('networks.'+name+'.'+setting,options[setting],connected.get(field))
  if options.get('link_local_ips'):compare('networks.'+name+'.link_local_ips',options['link_local_ips'],connected.get('IPAMConfig',{}).get('LinkLocalIPs'))
  aliases=options.get('aliases',[]);checks['networks.'+name+'.declaredAliases']=set(aliases)<=set(connected.get('Aliases') or [])
  need(not options.get('priority') and not options.get('gw_priority'),'EXPLICIT_NETWORK_PRIORITY_REQUIRES_EVIDENCE')
  live_network=command(['docker','network','inspect',network_name])[0]
  compare('networks.'+name+'.id',live_network['Id'],connected.get('NetworkID'))
  definition=composition['networks'][name]
  for setting,field in [('internal','Internal'),('driver','Driver'),('enable_ipv6','EnableIPv6')]:
   if setting in definition:compare('networks.'+name+'.'+setting,definition[setting],live_network.get(field))
 compare('process.originalFullHash',before['processSha256'],sha({'entrypoint':config['Entrypoint'],'cmd':config['Cmd']}))
 compare('mounts.originalFullHash',before['mountsSha256'],sha(c['Mounts']))
 report['checks']=checks;report['differingFieldNames']=[name for name,ok in checks.items() if not ok]
 report['fieldValueHashes']={name:{'expected':expected[name],'current':actual[name]} for name in report['differingFieldNames'] if name in expected}
 report['currentFullHostConfigSha256']=sha(hc)
 normalized=dict(hc);normalized['Binds']=sorted(hc['Binds']) if hc.get('Binds') is not None else None
 report['currentBindsOrderNormalizedHostConfigSha256']=sha(normalized)
 report['historicalFullHostConfigSha256']=before['hostConfigSha256'];report['historicalRawFullHostConfigMatches']=sha(hc)==before['hostConfigSha256']
 report['notExplicitlyControlledHostConfigFieldNames']=sorted(set(hc)-covered_hc)
 report['currentApiHealthy']=(c['State'].get('Health') or {}).get('Status')=='healthy'
 report['allExplicitComposeIntentMatches']=all(checks.values());report['eligibleForRootExplicitNewBaselineApproval']=all(checks.values()) and report['currentApiHealthy']
 report['pass']=report['eligibleForRootExplicitNewBaselineApproval'];save(state+'/receipt.json',report)
try:main()
except Exception as error:
 report['errorCode']=getattr(error,'code','READONLY_RECONCILIATION_FAILED')
 if state and not os.path.exists(state+'/receipt.json'):save(state+'/receipt.json',report)
print(json.dumps(report,sort_keys=True));sys.exit(0 if report['pass'] else 1)
'''
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--on-host',action='store_true');args=p.parse_args()
 command=[sys.executable,'-'] if args.on_host else ['ssh','-i','/Users/developer/.ssh/ava-deploy-ed25519','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=8','root@203.0.113.10','python3 -']
 try:
  result=subprocess.run(command,input=REMOTE,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120);value=json.loads(result.stdout)
 except Exception:print(json.dumps({'pass':False,'errorCode':'RECONCILE_TRANSPORT_FAILED'}));return 1
 print(json.dumps(value,indent=2,sort_keys=True));return 0 if value.get('pass') else 1
if __name__=='__main__':raise SystemExit(main())
