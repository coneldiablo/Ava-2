'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const express=require('express');
const DB=require('../src/services/database.service'),RAG=require('../src/services/rag.service');
const upload=require('../src/services/knowledge-upload.service');
const Identity=require('../src/services/identity/identity-store'),Auth=require('../src/services/auth.service');
async function fixture(run){
 createTestDB();DB.run("INSERT INTO instances(id,name) VALUES(1,'Multipart fixture')");
 const embedding=RAG.generateEmbeddings;RAG.generateEmbeddings=async chunks=>chunks;
 const app=express();let counter=0;
 app.post('/upload',upload,async(req,res,next)=>{try{
  const files=[...(req.files?.files||[]),...(req.files?.file||[])],results=[];
  for(const file of files){const result=await RAG.processDocument(1,file.buffer,file.originalname,file.mimetype);assert.equal(result.success,true);results.push({originalName:file.originalname,kbId:result.kbId});}
  res.json({results,names:(await DB.getKnowledgeBaseFiles(1)).map(file=>file.originalName)});
 }catch(e){next(e);}});
 app.use((error,req,res,next)=>res.status(400).json({code:error.code||'UPLOAD_FAILED'}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),url=`http://127.0.0.1:${server.address().port}/upload`;
 const text=()=>`Гарантия на прибор составляет 24 месяца. Для ремонта обратитесь к менеджеру. Номер ${++counter}.`;
 const raw=(nameBytes,{encoding,extended}={})=>{
  const boundary='ava-filename-fixture';
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="`),nameBytes,Buffer.from(`"${extended?`; filename*=UTF-8''${encodeURIComponent(extended)}`:''}\r\nContent-Type: text/plain\r\n\r\n${text()}\r\n--${boundary}--\r\n`)]);
  return fetch(url,{method:'POST',headers:{'Content-Type':`multipart/form-data; boundary=${boundary}`,...(encoding?{'X-AVA-Upload-Filename-Encoding':encoding}:{})},body});
 };
 try{await run({url,raw,text});}finally{await new Promise(r=>server.close(r));RAG.generateEmbeddings=embedding;}
}
describe('Knowledge upload filename charset: actual multipart bytes → parser → RAG → SQLite',()=>{
 it('roundtrips browser UTF8 Cyrillic, accented Latin and literal ambiguous names without double decoding',()=>fixture(async({url,text})=>{
  const names=['Правила возврата.txt','café.txt','Ã©tude.txt','ÐŸÑ€-literal.txt'];
  for(const name of names){const form=new FormData();form.append('files',new Blob([text()],{type:'text/plain'}),name);
   const response=await fetch(url,{method:'POST',headers:{'X-AVA-Upload-Filename-Encoding':'utf-8'},body:form});assert.equal(response.status,200);const data=await response.json();assert.equal(data.results[0].originalName,name);assert.ok(data.names.includes(name));}
 }));
 it('preserves true Latin1 bytes including text that could also be guessed as UTF8',()=>fixture(async({raw})=>{
  for(const name of ['café.txt','Ã©tude.txt','Ð¡-literal.txt']){const response=await raw(Buffer.from(name,'latin1'));assert.equal(response.status,200);const data=await response.json();assert.equal(data.results[0].originalName,name);assert.ok(data.names.includes(name));}
 }));
 it('honors RFC extended filename encoding independently of legacy or UTF8 default',()=>fixture(async({raw})=>{
  for(const encoding of [undefined,'utf-8']){const name='Правила café Ã©.txt',response=await raw(Buffer.from('fallback.txt'),{encoding,extended:name});assert.equal(response.status,200);assert.equal((await response.json()).results[0].originalName,name);}
 }));
 it('rejects an unknown encoding before document mutation and retains existing upload limits',()=>fixture(async({raw,url,text})=>{
  const bad=await raw(Buffer.from('name.txt'),{encoding:'windows-1251'});assert.equal(bad.status,400);assert.equal((await bad.json()).code,'KNOWLEDGE_FILENAME_ENCODING_INVALID');assert.equal((await DB.getKnowledgeBaseFiles(1)).length,0);
  const form=new FormData();for(let i=0;i<11;i++)form.append('files',new Blob([text()],{type:'text/plain'}),`file-${i}.txt`);
  const over=await fetch(url,{method:'POST',headers:{'X-AVA-Upload-Filename-Encoding':'utf-8'},body:form});assert.equal(over.status,400);assert.equal((await over.json()).code,'LIMIT_UNEXPECTED_FILE');assert.equal((await DB.getKnowledgeBaseFiles(1)).length,0);
 }));
 it('roundtrips the Unicode filename through the assembled app upload endpoint and authenticated list readback',async()=>{
  createTestDB();Identity.ensureSchema();DB.run("INSERT INTO instances(id,name) VALUES(1,'App upload fixture')");
  DB.run("INSERT INTO ava_users(id,subject,email) VALUES('owner','owner','owner@example.test')");DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('owner',1,'hotel_owner')");
  const saved={embedding:RAG.generateEmbeddings,enabled:Auth.config.enabled,customer:process.env.AVA_CUSTOMER_ACCESS_ENABLED,url:process.env.WHATSAPP_CRM_PUBLIC_URL};
  RAG.generateEmbeddings=async chunks=>chunks;Auth.config.enabled=true;process.env.AVA_CUSTOMER_ACCESS_ENABLED='true';
  const app=require('../src/app').app,server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const origin=`http://127.0.0.1:${server.address().port}`,token=Identity.createSession('owner','upload-owner');process.env.WHATSAPP_CRM_PUBLIC_URL=origin;
  const headers={Cookie:'crm_session=ava2:'+token,Origin:origin},name='Правила возврата café.txt';
  try{
   const form=new FormData();form.append('files',new Blob(['Гарантия составляет 24 месяца. Для ремонта обратитесь к менеджеру.'],{type:'text/plain'}),name);
   const response=await fetch(origin+'/api/knowledge-base/1/upload',{method:'POST',headers:{...headers,'X-AVA-Upload-Filename-Encoding':'utf-8'},body:form});
   assert.equal(response.status,200);const data=await response.json();assert.equal(data.results[0].originalName,name);
   const list=await fetch(origin+'/api/knowledge-base/1',{headers});assert.equal(list.status,200);assert.ok((await list.json()).files.some(file=>file.originalName===name));
  }finally{await new Promise(r=>server.close(r));RAG.generateEmbeddings=saved.embedding;Auth.config.enabled=saved.enabled;for(const[key,value]of[['AVA_CUSTOMER_ACCESS_ENABLED',saved.customer],['WHATSAPP_CRM_PUBLIC_URL',saved.url]])if(value===undefined)delete process.env[key];else process.env[key]=value;}
 });
});
