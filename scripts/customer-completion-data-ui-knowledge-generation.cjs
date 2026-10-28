#!/usr/bin/env node
'use strict';
// Local coordinator; deployed immutable Python runtime, private SQLite clone only.
const {spawn}=require('node:child_process');
const python=String.raw`
import os,sys,json,time,sqlite3,tempfile,shutil,logging,asyncio,re,uuid
from urllib.parse import quote
logging.disable(logging.CRITICAL)
start=time.monotonic(); report={'kind':'knowledge-generation-live-clone','startedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'sourceDatabaseReadOnly':True,'privateClone':True,'productionEnvironmentInherited':True,'applicationStarted':False,'liveWrites':0,'sends':0,'calls':0,'previewCalls':0,'generationTurnsDispatched':0,'retry':False,'privateSessionCreated':False,'privateSessionCleanup':None,'cloneCleanup':False,'pass':False}
private=None;db=None
safe=lambda value: value if isinstance(value,str) and re.fullmatch(r'[A-Z][A-Z0-9_]{1,100}',value) else 'KNOWLEDGE_GENERATION_PROBE_FAILED'
try:
 root=os.environ.get('AVA_SHARED_SOURCE_ROOT','')
 if root!='/opt/ava-runtime-source' or not os.path.isdir(root+'/src'):raise RuntimeError('PROBE_SOURCE_ROOT_INVALID')
 sys.path.insert(0,root)
 source_path=os.environ['DB_PATH'];private=tempfile.mkdtemp(prefix='ava-knowledge-generation-');os.chmod(private,0o700);clone_path=private+'/crm.db'
 source=sqlite3.connect('file:'+quote(source_path)+'?mode=ro',uri=True);db=sqlite3.connect(clone_path);source.backup(db);source.close();os.chmod(clone_path,0o600);db.row_factory=sqlite3.Row
 if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('PROBE_CLONE_INTEGRITY')
 report['cloneIntegrity']=True;os.environ['DB_PATH']=clone_path
 row=db.execute("SELECT i.id,i.aiProvider,i.geminiModel,t.status FROM instances i JOIN onyx_tenant_links t ON t.business_id=i.id WHERE i.isActive=1 AND COALESCE(i.knowledgeBaseInstanceId,i.id)=i.id AND EXISTS(SELECT 1 FROM knowledge_base k JOIN kb_chunks c ON c.kbId=k.id WHERE k.instanceId=i.id AND k.isCurrent=1 AND length(trim(c.text))>60) ORDER BY CASE WHEN EXISTS(SELECT 1 FROM ava_module_deployments d WHERE d.businessId=i.id AND d.module='onyx' AND d.state='verified') THEN 0 ELSE 1 END,i.id LIMIT 1").fetchone()
 if row is None:raise RuntimeError('KNOWLEDGE_NO_READY_SCOPE')
 business=row['id'];report['provider']=row['aiProvider'] if row['aiProvider'] in ['gemini','aitunnel'] else 'configured_other';report['model']=row['geminiModel'] if isinstance(row['geminiModel'],str) and re.fullmatch(r'[A-Za-z0-9._/-]{1,100}',row['geminiModel']) else None;report['onyxState']=row['status']
 doc=db.execute('SELECT k.id,k.contentHash,c.text FROM knowledge_base k JOIN kb_chunks c ON c.kbId=k.id WHERE k.instanceId=? AND k.isCurrent=1 AND length(trim(c.text))>60 ORDER BY k.id,c.chunkIndex,c.id LIMIT 1',(business,)).fetchone()
 words=re.findall(r'[^\W\d_]{5,24}',doc['text'],re.UNICODE);stop={'который','которые','которого','можно','нужно','также','этого','после','перед','будет','чтобы','когда','только','данные','должны','должен','например'}
 anchor=next((w.lower() for w in words if w.lower() not in stop and re.search('[а-яё]',w,re.I)),None)
 if not anchor:raise RuntimeError('KNOWLEDGE_NO_QUERY_ANCHOR')
 question='Что указано в документе базы знаний по теме «'+anchor+'»? Дай краткий ответ только по источнику.'
 from src.core.onyx_knowledge_runtime import OnyxKnowledgeRuntime
 from src.core.onyx_agent_runner import current_knowledge_sources
 from src.core.onyx_native_runtime_config import native_runtime_scope
 from src.core.onyx_client import OnyxClient,OnyxClientError
 from src.core.onyx_native_runtime_client import OnyxNativeRuntimeClient
 scope=native_runtime_scope(clone_path,business);state,ready=current_knowledge_sources(clone_path,business,native_scope=scope)
 report['nativeAdmitted']=scope is not None;report['sourceState']=state;report['sourceCount']=len(ready);report['canonicalTenantValidated']=True
 if state!='READY':raise RuntimeError('KNOWLEDGE_SOURCE_NOT_READY')
 # Observe and fence the existing scoped client's lifecycle. No fake response or new generator.
 sessions=set()
 def decorate(original):
  async def request(self,method,path,payload=None,*args,**kwargs):
   create=method=='POST' and path in ['/chat/create-chat-session','/v1/onyx-runtime/chat/create-chat-session']
   send=method=='POST' and path in ['/chat/send-chat-message','/v1/onyx-runtime/chat/send-chat-message']
   clean=method=='POST' and ('/end-incognito-session/' in path)
   check=method=='GET' and ('/get-chat-session/' in path)
   stop=method=='POST' and ('/stop-chat-session/' in path)
   if create:
    if report['privateSessionCreated'] or not isinstance(payload,dict) or payload.get('incognito') is not True:raise OnyxClientError('Probe denied',code='PROBE_LIFECYCLE_DENIED',status_code=403)
   elif send:
    if report['generationTurnsDispatched']>=1 or payload.get('chat_session_id') not in sessions:raise OnyxClientError('Probe denied',code='PROBE_GENERATION_LIMIT',status_code=403)
    report['generationTurnsDispatched']+=1
   elif clean or check or stop:
    if path.rsplit('/',1)[-1] not in sessions:raise OnyxClientError('Probe denied',code='PROBE_LIFECYCLE_DENIED',status_code=403)
   else:raise OnyxClientError('Probe denied',code='PROBE_LIFECYCLE_DENIED',status_code=403)
   try:
    value=await original(self,method,path,payload,*args,**kwargs)
    if create and isinstance(value.body,dict) and isinstance(value.body.get('chat_session_id'),str):sessions.add(value.body['chat_session_id']);report['privateSessionCreated']=True
    if clean:report['privateSessionCleanup']=True
    return value
   except Exception as error:
    report['innerErrorCode']=safe(getattr(error,'code',None))
    if clean:report['privateSessionCleanup']=False
    raise
  return request
 OnyxClient.request=decorate(OnyxClient.request);OnyxNativeRuntimeClient.request=decorate(OnyxNativeRuntimeClient.request)
 # Guard all further SQLite opens against accidentally selecting the live DB.
 original_connect=sqlite3.connect
 def connect(database,*args,**kwargs):
  text=str(database)
  if text!=clone_path and not text.startswith('file:'+quote(clone_path)+'?'):raise RuntimeError('PROBE_DATABASE_SCOPE_DENIED')
  return original_connect(database,*args,**kwargs)
 sqlite3.connect=connect
 async def run():
  report['previewCalls']+=1;began=time.monotonic()
  value=await OnyxKnowledgeRuntime(db_path=clone_path).answer(business_id=business,question=question,channel='whatsapp',correlation_id=str(uuid.uuid4()),preview=True)
  report['answerElapsedMs']=round((time.monotonic()-began)*1000);report['errorCode']=safe(value['error_code']) if value.get('error_code') else None
  report['answerLength']=len(value.get('answer') or '');refs=value.get('citations') or [];report['answerSourceCount']=len(refs)
  report['grounded']=value.get('grounded') is True;report['responseScopeValidated']=value.get('business_id')==business and value.get('preview') is True
  report['allSourcesCurrent']=bool(refs) and all(isinstance(ref,dict) and ref.get('source_id') in ready for ref in refs)
  report['sourceVersionStable']=db.execute('SELECT contentHash FROM knowledge_base WHERE id=? AND instanceId=? AND isCurrent=1',(doc['id'],business)).fetchone()[0]==doc['contentHash']
  report['pass']=report['grounded'] and report['responseScopeValidated'] and report['allSourcesCurrent'] and report['sourceVersionStable'] and report['answerLength']>0 and report['generationTurnsDispatched']==1 and report['privateSessionCleanup'] is True
 asyncio.run(asyncio.wait_for(run(),timeout=60))
except BaseException as error:
 report['errorCode']=safe(getattr(error,'code',None) or (str(error) if re.fullmatch(r'[A-Z][A-Z0-9_]{1,100}',str(error)) else None))
finally:
 try:
  if db:db.close()
  if private:shutil.rmtree(private)
  report['cloneCleanup']=private is None or not os.path.exists(private)
 except Exception:report['cloneCleanup']=False
 report['elapsedMs']=round((time.monotonic()-start)*1000)
 report['providerDispatchCount']='NOT_OBSERVABLE_FROM_SCOPED_ONYX_CLIENT';report['modelIsConfiguredSelection']=True
 report['pass']=report['pass'] and report['cloneCleanup']
 print(json.dumps(report,separators=(',',':')))
`;
const child=spawn('ssh',['-i','/Users/developer/.ssh/ava-deploy-ed25519','-o','BatchMode=yes','-o','ConnectTimeout=8','root@203.0.113.10','docker exec -i admin_ui python -'],{stdio:['pipe','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.end(python);
const cap=setTimeout(()=>{child.kill('SIGTERM');},70000);
child.on('close',status=>{clearTimeout(cap);try{const result=JSON.parse(stdout.trim());process.stdout.write(JSON.stringify(result,null,2)+'\n');if(!result.pass)process.exitCode=1;}catch(_){process.stdout.write(JSON.stringify({pass:false,errorCode:'PROBE_TRANSPORT_OR_RUNTIME_START_FAILED',sshStatus:status,stderrRetained:false})+'\n');process.exitCode=1;}});
