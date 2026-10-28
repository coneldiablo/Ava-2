'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Native=require('../src/services/customer-native-knowledge.service');
const RAG=require('../src/services/rag.service');
const Local=require('../src/services/knowledge-local.service');
const Http=require('../src/services/integrations/http');
const Store=require('../src/services/integrations/store');
const Amo=require('../src/services/integrations/amocrm');
const axios=require('axios');
const Import=require('../src/services/catalog-import.service');
const express=require('express');
const Identity=require('../src/services/identity/identity-store');
const Auth=require('../src/services/auth.service');
async function source(fn){
 createTestDB();DB.run("INSERT INTO instances(id,name) VALUES(1,'Source fixture'),(2,'Other fixture')");
 const id=DB.addKnowledgeBaseFile(1,'rules.txt','Правила.txt',null,'text/plain',60,1);
 DB.run('INSERT INTO kb_chunks(kbId,chunkIndex,text,searchText) VALUES(?,0,?,?)',[id,'Гарантия на прибор составляет 12 месяцев.','гарантия прибор составляет месяцев']);
 const chunkId=DB.getDocumentChunks(1,id)[0].id,generate=RAG.generateEmbeddings;
 RAG.generateEmbeddings=async chunks=>chunks;
 try{await fn({id,chunkId,hash:Native.snapshot(1,id).editHash});}finally{RAG.generateEmbeddings=generate;}
}
describe('Customer completion data revision and unknown-outcome regressions',()=>{
 it('fences a stale header-only edit without changing the Onyx content hash or resending the same source',()=>source(async({id,chunkId,hash})=>{
  const before=Native.snapshot(1,id);
  DB.run("INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,status) VALUES(1,'hotel_1','https://example.test','ACTIVE')");
  DB.run("INSERT INTO onyx_document_links(business_id,entity_type,source_id,onyx_document_id,content_hash) VALUES(1,'knowledge',?,?,?)",[id,`ava:1:knowledge:${id}`,before.hash]);
  const first=await Native.updateChunk(1,id,chunkId,{text:before.chunks[0].text,section:'Новый заголовок',expectedHash:hash});
  assert.notEqual(first.hash,hash);assert.equal(first.sourceHash,before.hash);assert.equal(Native.snapshot(1,id).hash,before.hash);assert.equal(first.sync.state,'submitted');
  await assert.rejects(()=>Native.updateChunk(1,id,chunkId,{text:'Stale text edit',section:null,expectedHash:hash}),e=>e.code==='DOCUMENT_REVISION_CONFLICT');
  assert.equal(DB.getChunkById(1,chunkId).section,'Новый заголовок');assert.equal(DB.getChunkById(1,chunkId).text,before.chunks[0].text);assert.equal(DB.get('SELECT COUNT(*) n FROM onyx_sync_outbox').n,0);
 }));
 it('updates canonical uploaded text and current answers without Onyx configuration, with optimistic conflict protection',()=>source(async({id,chunkId,hash})=>{
  const first=await Native.updateChunk(1,id,chunkId,{text:'Гарантия на прибор составляет 24 месяца.',section:'Гарантия',expectedHash:hash});
  assert.notEqual(first.hash,hash);assert.equal(first.sync.state,'unavailable');
  const answer=await Local.lookup(1,'Какая гарантия на прибор?');assert.ok(answer.answer.includes('24'));assert.ok(!answer.answer.includes('12'));
  await assert.rejects(()=>Native.updateChunk(1,id,chunkId,{text:'Outdated draft',section:null,expectedHash:hash}),e=>e.code==='DOCUMENT_REVISION_CONFLICT');
  assert.equal(DB.getChunkById(1,chunkId).text,first.chunk.text);
  assert.equal(await Local.lookup(2,'Какая гарантия на прибор?'),null);
 }));
 it('refuses a busy sync before editing text/hash or queued events',()=>source(async({id,chunkId,hash})=>{
  DB.run("INSERT INTO onyx_sync_outbox(event_id,business_id,entity_type,source_id,operation,payload_json,status,next_attempt_at) VALUES('fixture',1,'knowledge',?,'UPSERT','{}','PROCESSING',CURRENT_TIMESTAMP)",[id]);
  await assert.rejects(()=>Native.updateChunk(1,id,chunkId,{text:'Should not save',section:null,expectedHash:hash}),e=>e.code==='DOCUMENT_SYNC_IN_PROGRESS');
  assert.equal(Native.snapshot(1,id).editHash,hash);assert.equal(DB.getChunkById(1,chunkId).text,'Гарантия на прибор составляет 12 месяцев.');
 }));
 it('queues the actual edited revision and supersedes a previous pending source',()=>source(async({id,chunkId,hash})=>{
  DB.run("INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,status) VALUES(1,'hotel_1','https://example.test','ACTIVE')");
  Native.enqueue(1,id);
  const edited=await Native.updateChunk(1,id,chunkId,{text:'Гарантия на прибор составляет 36 месяцев.',section:null,expectedHash:hash});
  const outbox=DB.all("SELECT status,payload_json FROM onyx_sync_outbox ORDER BY id");
  assert.equal(outbox.length,2);assert.equal(outbox[0].status,'DEAD');assert.equal(outbox[1].status,'PENDING');
  assert.equal(JSON.parse(outbox[1].payload_json).content_hash,edited.sourceHash);
  assert.ok(JSON.parse(outbox[1].payload_json).content.includes('36'));
 }));
 it('does not restore a stale vector if another edit completes during embedding',()=>source(async({id,chunkId,hash})=>{
  let release,entered;const waiting=new Promise(r=>entered=r),writes=[];
  const add=DB.addChunkToVectorTable;DB.addChunkToVectorTable=(...args)=>writes.push(args);
  let count=0;RAG.generateEmbeddings=async chunks=>{if(++count===1){entered();await new Promise(r=>release=r);}return chunks.map(c=>({...c,embedding:[1,2,3]}));};
  try{
   const old=Native.updateChunk(1,id,chunkId,{text:'Гарантия на прибор составляет 24 месяца.',section:null,expectedHash:hash});await waiting;
   const fresh=await Native.updateChunk(1,id,chunkId,{text:'Гарантия на прибор составляет 48 месяцев.',section:null,expectedHash:Native.snapshot(1,id).editHash});
   release();await assert.rejects(()=>old,e=>e.code==='DOCUMENT_REVISION_CONFLICT');
   assert.equal(writes.length,1);assert.equal(Native.snapshot(1,id).editHash,fresh.hash);assert.ok(DB.getChunkById(1,chunkId).text.includes('48'));
  }finally{DB.addChunkToVectorTable=add;}
 }));
 it('retains saved readable text when embeddings fail and rejects foreign document edits',()=>source(async({id,chunkId,hash})=>{
  RAG.generateEmbeddings=async()=>{throw new Error('fixture embedding unavailable');};
  const result=await Native.updateChunk(1,id,chunkId,{text:'Гарантия на прибор составляет 60 месяцев.',section:null,expectedHash:hash});
  assert.ok(result.chunk.text.includes('60'));
  await assert.rejects(()=>Native.updateChunk(2,id,chunkId,{text:'foreign',section:null}),e=>e.code==='DOCUMENT_NOT_FOUND');
 }));
 it('fences provider HTTP408 after dispatch and refuses a second write',async()=>{
  createTestDB();DB.run("INSERT INTO instances(id,name) VALUES(1,'External fixture')");let calls=0;
  const send=()=>Http.write(1,'amocrm','timeout-fixture',{text:'fixture'},async()=>{calls++;throw Object.assign(new Error('private provider details'),{response:{status:408}});});
  await assert.rejects(send,e=>e.code==='EXTERNAL_TIMEOUT'&&e.unknown===true&&e.safeToRetry===false);
  assert.equal(Store.operation(1,'amocrm','timeout-fixture').status,'unknown');
  await assert.rejects(send,e=>e.code==='EXTERNAL_OUTCOME_UNKNOWN');assert.equal(calls,1);
 });
 it('retains retryable validation refusals and sanitizes provider messages',()=>{
  const error=Http.providerError({response:{status:422,data:{secret:'private'}}});
  assert.equal(error.safeToRetry,true);assert.equal(error.unknown,false);assert.ok(!JSON.stringify(error).includes('private'));
 });
 it('detects comma CSV despite semicolons inside a quoted header and reports invalid UTF8 as input error',async()=>{
  const parsed=await Import._internals.parse({originalname:'quoted.csv',buffer:Buffer.from('"Товар;описание;ещё",Цена,Артикул\nПрибор,123,A')});
  assert.deepEqual(parsed.rows[1],['Прибор','123','A']);
  await assert.rejects(()=>Import._internals.parse({originalname:'bad.csv',buffer:Buffer.from([0xff,0xfe,0x41])}),e=>e.code==='CATALOG_ENCODING_INVALID'&&e.statusCode===400);
 });
 it('keeps all lead/task identifiers in a mixed callback and exposes unknown direct writes in connection readback',async()=>{
  createTestDB();DB.run("INSERT INTO instances(id,name) VALUES(1,'External fixture')");process.env.CHANNEL_CREDENTIALS_MASTER_KEY='11'.repeat(32);
  Store.save(1,'amocrm',{domain:'fixture.amocrm.ru'},{clientId:'fixture'});Store.patch(1,'amocrm',{accountId:'101',status:'connected',webhookToken:'fixture-hook'});
  const payload={account:{id:'101'},leads:{update:[{id:'401'}],status:{0:{id:'402'}},add:[{id:'403'}]},task:{update:[{id:'501'}],add:[{id:'502'}]}};
  await Amo.webhook(1,'fixture-hook',payload);await Amo.webhook(1,'fixture-hook',payload);
  const callbacks=Store.callbacks('amocrm');assert.equal(callbacks.length,1);
  assert.deepEqual(callbacks[0].payload.ids,['401','402','403']);assert.deepEqual(callbacks[0].payload.taskIds,['501','502']);
  Store.begin(1,'amocrm','unknown-direct',{text:'fixture'});Store.finish(1,'amocrm','unknown-direct','unknown',{},'EXTERNAL_TIMEOUT');
  const status=Store.status(1,'amocrm');assert.equal(status.exchange.unconfirmedWrites,1);assert.equal(status.error.code,'EXTERNAL_OUTCOME_UNKNOWN');
 });
 it('projects a reopened provider task back to an open local task without duplicates',async()=>{
  createTestDB();DB.run("INSERT INTO instances(id,name) VALUES(1,'External fixture')");process.env.CHANNEL_CREDENTIALS_MASTER_KEY='11'.repeat(32);
  Store.save(1,'amocrm',{domain:'fixture.amocrm.ru',mapping:{statusMap:{}}},{clientId:'fixture',accessToken:'fixture',expiresAt:Date.now()+3600000});Store.patch(1,'amocrm',{accountId:'101',status:'connected'});
  const client=await DB.getOrCreateClient(1,'fixture-client','Fixture');Store.link(1,'amocrm',client.chatId,'101',{contactId:'301',leadId:'401'});
  let completed=true;const request=axios.request;
  axios.request=async config=>({data:config.url.endsWith('/leads')?{_embedded:{leads:[{id:401,name:'Fixture',updated_at:1}]}}:{_embedded:{tasks:[{id:501,entity_type:'leads',entity_id:401,text:'Fixture task',is_completed:completed,complete_till:2000000000}]}}});
  try{await Amo.sync(1);assert.equal(DB.get('SELECT status FROM manager_tasks').status,'done');completed=false;await Amo.sync(1);
   assert.equal(DB.get('SELECT COUNT(*) n FROM manager_tasks').n,1);assert.equal(DB.get('SELECT status FROM manager_tasks').status,'new');
  }finally{axios.request=request;}
 });
 it('serves editor revision/readback and clear conflicts over real HTTP with current tenant roles',()=>source(async({id,chunkId})=>{
  Identity.ensureSchema();
  for(const [user,role]of[['owner','hotel_owner'],['manager','manager']]){
   DB.run('INSERT INTO ava_users(id,subject,email) VALUES(?,?,?)',[user,user,user+'@example.test']);
   DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,1,?)',[user,role]);
  }
  const session=Auth.getSession,origin=process.env.WHATSAPP_CRM_PUBLIC_URL;Auth.getSession=req=>req.auth;process.env.WHATSAPP_CRM_PUBLIC_URL='https://ava.example.test';
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.auth=Identity.actor(req.get('X-Fixture-Actor')||'owner');next();});
  app.use('/api',require('../src/routes/customer-knowledge-preview.routes'));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}/api/businesses/1/knowledge/documents/${id}/chunks`;
  const put=(body,actor='owner')=>fetch(`${base}/${chunkId}`,{method:'PUT',headers:{Origin:'https://ava.example.test','Content-Type':'application/json','X-Fixture-Actor':actor},body:JSON.stringify(body)});
  try{
   const read=await fetch(base),before=await read.json();assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');
   const sectionEdit=await put({text:before.chunks[0].text,section:'Новый раздел',expectedHash:before.hash}),metadata=await sectionEdit.json();assert.equal(sectionEdit.status,200);
   const reread=await fetch(base).then(r=>r.json());assert.equal(reread.hash,metadata.hash);assert.notEqual(reread.hash,before.hash);assert.equal(reread.sourceHash,before.sourceHash);
   assert.equal((await put({text:'Stale overwrite',section:null,expectedHash:before.hash})).status,409);
   const update=await put({text:'Гарантия на прибор составляет 72 месяца.',expectedHash:reread.hash}),after=await update.json();
   assert.equal(update.status,200);assert.notEqual(after.hash,before.hash);assert.equal(after.sync.state,'unavailable');
   assert.equal((await fetch(base).then(r=>r.json())).chunks[0].text,after.chunk.text);
   assert.equal((await put({text:'Stale draft',expectedHash:before.hash})).status,409);
   assert.equal((await put({text:'Denied draft',expectedHash:after.hash},'manager')).status,403);
   assert.equal((await fetch(base.replace('/businesses/1/','/businesses/2/'))).status,403);
   assert.equal((await put({text:'Wrong revision',expectedHash:'bad'})).status,400);
  }finally{await new Promise(r=>server.close(r));Auth.getSession=session;if(origin===undefined)delete process.env.WHATSAPP_CRM_PUBLIC_URL;else process.env.WHATSAPP_CRM_PUBLIC_URL=origin;}
 }));
});
