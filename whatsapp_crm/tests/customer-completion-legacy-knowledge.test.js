'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service'),RAG=require('../src/services/rag.service');
const Native=require('../src/services/customer-native-knowledge.service');
async function fixture(run){
 createTestDB();DB.run("INSERT INTO instances(id,name) VALUES(1,'Legacy fixture'),(2,'Foreign fixture')");
 const id=DB.addKnowledgeBaseFile(1,'legacy.txt','Legacy rules.txt',null,'text/plain',100,1);
 DB.run('INSERT INTO kb_chunks(kbId,chunkIndex,text,searchText) VALUES(?,0,?,?)',[id,'Гарантия на прибор составляет 12 месяцев.','гарантия прибор составляет месяцев']);
 const chunkId=DB.getDocumentChunks(1,id)[0].id,generate=RAG.generateEmbeddings,add=DB.addChunkToVectorTable;
 RAG.generateEmbeddings=async chunks=>chunks;
 try{await run({id,chunkId,hash:Native.snapshot(1,id).editHash});}finally{RAG.generateEmbeddings=generate;DB.addChunkToVectorTable=add;}
}
describe('Legacy RAG.updateChunk shares guarded native edit without recursion',()=>{
 it('uses the editor fingerprint for optional legacy hashes after a section-only update',()=>fixture(async({id,chunkId,hash})=>{
  const before=Native.snapshot(1,id);await RAG.updateChunk(1,chunkId,before.chunks[0].text,'Новый раздел',{expectedHash:hash});
  assert.equal(Native.snapshot(1,id).hash,before.hash);assert.notEqual(Native.snapshot(1,id).editHash,hash);
  await assert.rejects(()=>RAG.updateChunk(1,chunkId,'Stale text',null,{expectedHash:hash}),e=>e.code==='DOCUMENT_REVISION_CONFLICT');assert.equal(DB.getChunkById(1,chunkId).section,'Новый раздел');
 }));
 it('preserves the four-argument contract and exact response shape when no hash or Onyx is configured',()=>fixture(async({id,chunkId})=>{
  let embeddings=0;RAG.generateEmbeddings=async chunks=>{embeddings++;return chunks;};
  const result=await RAG.updateChunk(1,chunkId,'Гарантия на прибор составляет 24 месяца.','Гарантия');
  assert.deepEqual(result,{success:true,kbId:id,nativeSync:{state:'unavailable',queued:false,code:'ONYX_NOT_CONFIGURED'}});
  assert.equal(embeddings,1);assert.equal(DB.getChunkById(1,chunkId).text,'Гарантия на прибор составляет 24 месяца.');
 }));
 it('checks an optional hash before mutation and keeps absent-hash callers compatible',()=>fixture(async({id,chunkId,hash})=>{
  await RAG.updateChunk(1,chunkId,'Гарантия на прибор составляет 36 месяцев.',null,{expectedHash:hash});
  const current=Native.snapshot(1,id).editHash;
  await assert.rejects(()=>RAG.updateChunk(1,chunkId,'Stale draft',null,{expectedHash:hash}),e=>e.code==='DOCUMENT_REVISION_CONFLICT'&&e.statusCode===409);
  assert.equal(Native.snapshot(1,id).editHash,current);
  await RAG.updateChunk(1,chunkId,'Гарантия на прибор составляет 48 месяцев.',null);
  assert.ok(DB.getChunkById(1,chunkId).text.includes('48'));
 }));
 it('refuses a busy index operation before changing the source or its revision',()=>fixture(async({id,chunkId,hash})=>{
  DB.run("INSERT INTO onyx_sync_outbox(event_id,business_id,entity_type,source_id,operation,payload_json,status,next_attempt_at) VALUES('legacy-sync',1,'knowledge',?,'UPSERT','{}','PROCESSING',CURRENT_TIMESTAMP)",[id]);
  await assert.rejects(()=>RAG.updateChunk(1,chunkId,'Should not save',null),e=>e.code==='DOCUMENT_SYNC_IN_PROGRESS'&&e.statusCode===409);
  assert.equal(Native.snapshot(1,id).editHash,hash);
 }));
 it('rejects a late embedding after a newer legacy edit without restoring the old vector',()=>fixture(async({id,chunkId})=>{
  let signal,release,calls=0;const entered=new Promise(r=>signal=r),vectors=[];
  DB.addChunkToVectorTable=(...args)=>vectors.push(args);
  RAG.generateEmbeddings=async chunks=>{if(++calls===1){signal();await new Promise(r=>release=r);}return chunks.map(c=>({...c,embedding:[1,2,3]}));};
  const slow=RAG.updateChunk(1,chunkId,'Гарантия на прибор составляет 24 месяца.',null);await entered;
  await RAG.updateChunk(1,chunkId,'Гарантия на прибор составляет 60 месяцев.',null);release();
  await assert.rejects(()=>slow,e=>e.code==='DOCUMENT_REVISION_CONFLICT');assert.equal(vectors.length,1);assert.ok(DB.getChunkById(1,chunkId).text.includes('60'));
 }));
 it('does not resurrect a document deleted during embedding',()=>fixture(async({id,chunkId})=>{
  let signal,release;const entered=new Promise(r=>signal=r),vectors=[];
  DB.addChunkToVectorTable=(...args)=>vectors.push(args);RAG.generateEmbeddings=async chunks=>{signal();await new Promise(r=>release=r);return chunks.map(c=>({...c,embedding:[1,2,3]}));};
  const slow=RAG.updateChunk(1,chunkId,'Гарантия на прибор составляет 24 месяца.',null);await entered;
  Native.remove(1,id);release();await assert.rejects(()=>slow,e=>e.code==='DOCUMENT_NOT_FOUND');assert.equal(vectors.length,0);assert.equal(DB.get('SELECT id FROM knowledge_base WHERE id=?',[id]),undefined);
 }));
 it('retains scoped lookup and supports reauthorization before save and before vector persistence',()=>fixture(async({id,chunkId,hash})=>{
  await assert.rejects(()=>RAG.updateChunk(2,chunkId,'Foreign edit',null),e=>e.code==='CHUNK_NOT_FOUND'&&e.statusCode===404);
  const denied=()=>{throw Object.assign(new Error('BUSINESS_ACCESS_DENIED'),{code:'BUSINESS_ACCESS_DENIED',statusCode:403});};
  await assert.rejects(()=>RAG.updateChunk(1,chunkId,'Denied edit',null,{beforeWrite:denied}),e=>e.statusCode===403);assert.equal(Native.snapshot(1,id).editHash,hash);
  let granted=true;RAG.generateEmbeddings=async chunks=>{granted=false;return chunks;};
  await assert.rejects(()=>RAG.updateChunk(1,chunkId,'Гарантия на прибор составляет 24 месяца.',null,{beforeWrite:()=>{if(!granted)denied();}}),e=>e.statusCode===403);
  assert.ok(DB.getChunkById(1,chunkId).text.includes('24'));
 }));
});
