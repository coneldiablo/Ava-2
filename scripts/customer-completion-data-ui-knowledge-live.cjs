#!/usr/bin/env node
'use strict';
// Execute in deployed whatsapp_crm container using stdin. Native knowledge read probe only.
// Source SQLite connection is read-only; real service reads use a private online clone.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const app=Module.createRequire('/app/package.json'),out=process.stdout.write.bind(process.stdout),start=Date.now();
const report={kind:'knowledge-live-native-read',startedAt:new Date(start).toISOString(),sourceDatabaseReadOnly:true,privateClone:true,productionEnvironmentInherited:true,applicationStarted:false,liveWrites:0,sends:0,calls:0,generationCalls:0,retrievalCalls:0,externalRequests:0,deniedActions:0,cleanup:false,pass:false};
let source,clone,DB,dir,finished=false;
const safeCode=e=>/^[A-Z][A-Z0-9_]{1,90}$/.test(e?.code||'')?e.code:'KNOWLEDGE_PROBE_FAILED';
function fail(code){throw Object.assign(new Error(code),{code});}
function denied(){report.deniedActions++;fail('KNOWLEDGE_PROBE_ACTION_DENIED');}
function finish(error){if(finished)return;finished=true;if(error)report.error=safeCode(error);try{if(DB)DB.db=null;if(clone?.open)clone.close();if(source?.open)source.close();if(dir)fs.rmSync(dir,{recursive:true,force:true});report.cleanup=!dir||!fs.existsSync(dir);}catch(_){report.cleanup=false;}report.elapsedMs=Date.now()-start;report.pass=!error&&report.cleanup&&report.deniedActions===0&&report.retrievalCalls===1&&report.answer?.success===true;out(JSON.stringify(report)+'\n');process.exit(report.pass?0:1);}
for(const method of ['log','info','warn','error','debug'])console[method]=()=>{};
const timer=setTimeout(()=>finish({code:'KNOWLEDGE_PROBE_DEADLINE'}),45000);
global.setInterval=denied;require('node:net').Server.prototype.listen=denied;require('node:dgram').createSocket=denied;
for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[method]=denied;
for(const name of ['node:http','node:https'])for(const method of ['request','get'])require(name)[method]=()=>{report.externalRequests++;denied();};
global.fetch=()=>{report.externalRequests++;denied();};
const originalLoad=Module._load;Module._load=function(request,parent,...rest){if(/(?:^|\/)(?:app|openwa\.service|whatsapp\.service|telegram\.service|email\.service|followup\.service|ai\.service)(?:\.js)?$/.test(request)||/\/services\/(?:telephony|integrations|identity)\//.test(request))denied();return originalLoad.call(this,request,parent,...rest);};
async function main(){
 if(process.env.DB_PATH!=='/app/data/crm_v2.db')fail('KNOWLEDGE_PROBE_DATABASE_SCOPE');
 const SQLite=app('better-sqlite3');dir=fs.mkdtempSync(path.join(os.tmpdir(),'ava-knowledge-live-'));fs.chmodSync(dir,0o700);const clonePath=path.join(dir,'crm.db');
 source=new SQLite(process.env.DB_PATH,{readonly:true,fileMustExist:true});await source.backup(clonePath);source.close();source=null;fs.chmodSync(clonePath,0o600);process.env.DB_PATH=clonePath;
 clone=new SQLite(clonePath,{fileMustExist:true});app('sqlite-vec').load(clone);if(clone.pragma('integrity_check',{simple:true})!=='ok')fail('KNOWLEDGE_PROBE_CLONE_INTEGRITY');report.cloneIntegrity=true;
 DB=app('./src/services/database.service');DB.db=clone;
 const rows=DB.all(`SELECT i.id,CASE WHEN COALESCE(i.knowledgeBaseInstanceId,i.id)=i.id THEN 1 ELSE 0 END ownScope,
 (SELECT COUNT(*) FROM knowledge_base k WHERE k.instanceId=i.id AND k.isCurrent=1) docs,
 (SELECT COUNT(*) FROM knowledge_base k WHERE k.instanceId=i.id AND k.isCurrent=1 AND EXISTS(SELECT 1 FROM kb_chunks c WHERE c.kbId=k.id AND LENGTH(TRIM(c.text))>12)) nonempty,
 (SELECT COUNT(*) FROM kb_chunks c JOIN knowledge_base k ON k.id=c.kbId WHERE k.instanceId=i.id AND k.isCurrent=1 AND LENGTH(TRIM(c.text))>12) chunks,
 (SELECT status FROM onyx_tenant_links t WHERE t.business_id=i.id) onyxStatus,
 (SELECT state FROM ava_module_deployments m WHERE m.businessId=i.id AND m.module='onyx') nativeState
 FROM instances i WHERE i.isActive=1 ORDER BY i.id`);
 report.inventory={activeBusinessCount:rows.length,currentDocumentCount:rows.reduce((n,r)=>n+r.docs,0),nonemptyCurrentDocumentCount:rows.reduce((n,r)=>n+r.nonempty,0),currentChunkCount:rows.reduce((n,r)=>n+r.chunks,0),readyNativeScopeCount:rows.filter(r=>r.ownScope&&r.nonempty&&r.chunks).length,verifiedOnyxScopeCount:rows.filter(r=>r.nativeState==='verified').length,scopes:rows.map(({id,...row},i)=>({ordinal:i+1,...row}))};
 const selected=rows.find(r=>r.ownScope&&r.nonempty&&r.chunks&&r.nativeState==='verified')||rows.find(r=>r.ownScope&&r.nonempty&&r.chunks);if(!selected)fail('KNOWLEDGE_NO_READY_NATIVE_SCOPE');
 const b=selected.id,Native=app('./src/services/customer-native-knowledge.service'),status=Native.status(b);
 const states={};for(const d of status.documents)states[d.state]=(states[d.state]||0)+1;
 const indexed=DB.get(`SELECT c.id,c.kbId,c.text,k.contentHash FROM kb_chunks c JOIN knowledge_base k ON k.id=c.kbId WHERE k.instanceId=? AND k.isCurrent=1 AND LENGTH(TRIM(c.text))>60 ORDER BY c.chunkIndex,c.id LIMIT 1`,[b]);if(!indexed)fail('KNOWLEDGE_NO_QUERYABLE_CHUNK');
 const stop=new Set(['который','которые','которого','можно','нужно','также','этого','после','перед','будет','чтобы','когда','только','данные','должны','должен','например']);
 const words=(indexed.text.match(/[\p{L}]{5,24}/gu)||[]).map(w=>w.toLowerCase()).filter(w=>!stop.has(w));
 const anchor=words.find(w=>/[а-яё]/u.test(w))||words[0];if(!anchor)fail('KNOWLEDGE_NO_QUERY_ANCHOR');
 const question='Что указано в базе знаний по теме «'+anchor+'»?';
 report.selectedScope={active:true,canonicalOwnKnowledgeScope:true,currentDocuments:selected.docs,nonemptyCurrentDocuments:selected.nonempty,currentChunks:selected.chunks,onyxState:selected.onyxStatus,nativeDeploymentState:selected.nativeState,documentSyncStateCounts:states,sourceVersionValidatedBeforeQuery:true};
 report.query={retained:false,construction:'single current tenant chunk topic term; assembled in memory',servicePath:'rag.service.answerFromKnowledge',searchType:'keyword',k:3,generationRequired:false};
 const RAG=app('./src/services/rag.service'),began=Date.now();report.retrievalCalls++;
 const result=await RAG.answerFromKnowledge(b,question,{channel:'whatsapp',searchType:'keyword',k:3});
 const refs=Array.isArray(result?.citations)?result.citations:[];
 const scopeValid=refs.length>0&&refs.every(ref=>DB.get(`SELECT 1 FROM kb_chunks c JOIN knowledge_base k ON k.id=c.kbId WHERE c.id=? AND k.id=? AND k.instanceId=? AND k.isCurrent=1`,[Number(ref.chunk_id),Number(ref.document_id),b]));
 const current=DB.get('SELECT c.text,k.contentHash FROM kb_chunks c JOIN knowledge_base k ON k.id=c.kbId WHERE c.id=? AND k.id=? AND k.instanceId=? AND k.isCurrent=1',[indexed.id,indexed.kbId,b]);
 const versionValid=!!current&&current.text===indexed.text&&current.contentHash===indexed.contentHash;
 report.answer={elapsedMs:Date.now()-began,answerLength:typeof result?.answer==='string'?result.answer.length:0,sourceCount:refs.length,allSourcesCurrentAndTenantScoped:!!scopeValid,sourceVersionStable:versionValid,missingInformationCount:Array.isArray(result?.missing_info)?result.missing_info.length:null,requiresManager:result?.requires_manager===true,provenance:'native_current_tenant_keyword_extraction',retained:false};
 report.answer.success=report.answer.answerLength>12&&scopeValid&&versionValid&&result?.missing_info?.length===0;
 report.onyxGeneration='NOT_TESTED';report.productionADCUsed=false;
 if(!report.answer.success)fail('KNOWLEDGE_NATIVE_ANSWER_UNCONFIRMED');
}
main().then(()=>{clearTimeout(timer);finish();},e=>{clearTimeout(timer);finish(e);});
