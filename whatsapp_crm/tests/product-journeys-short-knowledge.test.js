'use strict';
const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const RAG=require('../src/services/rag.service');
const Native=require('../src/services/customer-native-knowledge.service');
const Local=require('../src/services/knowledge-local.service');
const Logger=require('../src/utils/logger');
const originalIndex=RAG._indexDocumentChunks,originalLog={info:Logger.info,error:Logger.error,warn:Logger.warn,success:Logger.success};
beforeEach(()=>{for(const key of Object.keys(originalLog))Logger[key]=()=>{};createTestDB();DB.run("INSERT INTO instances(id,name) VALUES(1,'Fixture A'),(2,'Fixture B')");RAG._indexDocumentChunks=async()=>({vectorCount:0});});
afterEach(()=>{RAG._indexDocumentChunks=originalIndex;DB.db?.close();Object.assign(Logger,originalLog);});
const note=(businessId,text,name='Правила.txt')=>RAG.processDocument(businessId,Buffer.from(text,'utf8'),name,'text/plain');
test('short check-in fact becomes a stored, searchable and cited chunk',async()=>{
 const result=await note(1,'Заезд с 14:00.');assert.equal(result.success,true,result.error);assert.equal(result.chunksCount,1);
 assert.equal(DB.getDocumentChunks(1,result.kbId)[0].text,'Заезд с 14:00.');
 const answer=await Local.lookup(1,'Во сколько заезд?');assert.match(answer.answer,/14:00/);assert.equal(answer.citations[0].source_id,result.kbId);
});
test('Unicode and supplementary-plane characters survive normalization and chunk storage',async()=>{
 const result=await note(1,'\u00a0🚜 草原\tоткрыт.\r\n\u00a0');assert.equal(result.success,true,result.error);
 assert.equal(DB.getDocumentChunks(1,result.kbId)[0].text,'🚜 草原 открыт.');
});
test('empty Unicode whitespace has an explicit validation code and saves no document',async()=>{
 for(const text of ['', ' \t\r\n', '\u00a0\u2003\u202f']){const result=await note(1,text);assert.equal(result.success,false);assert.equal(result.code,'KNOWLEDGE_TEXT_EMPTY');}
 assert.equal(DB.get('SELECT COUNT(*) n FROM knowledge_base').n,0);assert.equal(DB.get('SELECT COUNT(*) n FROM kb_chunks').n,0);
});
test('the existing short non-plain-document guard stays in force',async()=>{
 await assert.rejects(RAG.extractText(Buffer.from('# Short'),'text/markdown'),{code:'KNOWLEDGE_DOCUMENT_TOO_SHORT'});
 assert.deepEqual(RAG.smartChunk('A','legacy.txt'),[]);assert.deepEqual(RAG.smartChunk(' \u00a0 ','empty.txt',{allowShortText:true}),[]);
});
test('identical normalized short notes retain existing hash deduplication in one tenant',async()=>{
 const first=await note(1,'  Заезд с 14:00.\r\n');const duplicate=await note(1,'Заезд с 14:00.');
 assert.equal(first.success,true);assert.equal(duplicate.success,false);assert.equal(duplicate.isDuplicate,true);assert.equal(duplicate.kbId,first.kbId);
 assert.equal(DB.get('SELECT COUNT(*) n FROM knowledge_base WHERE instanceId=1').n,1);
});
test('editing the same note creates a current version and deletion restores the previous version',async()=>{
 const first=await note(1,'Заезд с 14:00.');const second=await note(1,'Заезд с 15:00.');
 assert.equal(second.success,true,second.error);assert.equal(second.version,2);
 assert.deepEqual(DB.all('SELECT id,isCurrent,version FROM knowledge_base ORDER BY id'),[{id:first.kbId,isCurrent:0,version:1},{id:second.kbId,isCurrent:1,version:2}]);
 Native.remove(1,second.kbId);assert.equal(DB.get('SELECT isCurrent FROM knowledge_base WHERE id=?',[first.kbId]).isCurrent,1);
 assert.match((await Local.lookup(1,'Во сколько заезд?')).answer,/14:00/);
});
test('equal hashes stay tenant-scoped and a foreign delete leaves the owning fact intact',async()=>{
 const first=await note(1,'Заезд с 14:00.');const other=await note(2,'Заезд с 14:00.');
 assert.equal(first.success,true);assert.equal(other.success,true);assert.notEqual(first.kbId,other.kbId);
 assert.throws(()=>Native.remove(2,first.kbId),{code:'DOCUMENT_NOT_FOUND'});
 assert.equal(DB.getDocumentChunks(1,first.kbId)[0].text,'Заезд с 14:00.');assert.equal(DB.getDocumentChunks(2,other.kbId)[0].text,'Заезд с 14:00.');
});
