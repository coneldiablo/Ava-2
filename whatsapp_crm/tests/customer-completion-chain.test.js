'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service'),Identity=require('../src/services/identity/identity-store');
const Auth=require('../src/services/auth.service'),Import=require('../src/services/catalog-import.service');
const Catalog=require('../src/services/catalog.store'),RAG=require('../src/services/rag.service');
const Native=require('../src/services/customer-native-knowledge.service'),Local=require('../src/services/knowledge-local.service');
const AI=require('../src/services/ai.service'),Sales=require('../src/services/sales-brain.service');
const Deals=require('../src/services/customer-deals.store'),Studio=require('../src/services/customer-studio.service');
const OpenWA=require('../src/services/openwa.service'),Router=require('../src/services/channel-router.service');
describe('Customer completion assembled data → customer → task → PDF path',()=>{
 it('uses current CSV/source facts, canonical history and one owed task, then downloads/sends the exact PDF once through the real app',async()=>{
  createTestDB();Identity.ensureSchema();
  DB.run("INSERT INTO instances(id,name,aiProvider,geminiModel,openWaSessionId,whatsappProvider) VALUES(1,'Chain fixture','gemini','gemini-3.8-flash','chain-session','openwa'),(2,'Foreign fixture','gemini','gemini-3.8-flash',NULL,'openwa')");
  for(const [user,business,role]of[['owner',1,'hotel_owner'],['manager',1,'manager'],['foreign',2,'hotel_owner']]){
   DB.run('INSERT INTO ava_users(id,subject,email) VALUES(?,?,?)',[user,user,user+'@example.test']);
   DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)',[user,business,role]);
  }
  const auth=Identity.actor('owner'),chat='79990000001@c.us';await DB.getOrCreateClient(1,chat,'Chain buyer');
  DB.run("UPDATE clients SET assigneeUserId='manager' WHERE instanceId=1 AND chatId=?",[chat]);
  const old={embeddings:RAG.generateEmbeddings,generate:AI.generatePlainText,state:Router._getWhatsAppState,send:OpenWA.sendDocument,auth:Auth.config.enabled,customer:process.env.AVA_CUSTOMER_ACCESS_ENABLED,url:process.env.WHATSAPP_CRM_PUBLIC_URL};
  RAG.generateEmbeddings=async chunks=>chunks;let server;
  try{
   const uploaded=await RAG.processDocument(1,Buffer.from('Гарантия на прибор составляет 12 месяцев. Для ремонта сохраните серийный номер и обратитесь к менеджеру.'),'Правила.txt','text/plain');
   assert.equal(uploaded.success,true);const source=Native.snapshot(1,uploaded.kbId),chunk=source.chunks[0];
   await Native.updateChunk(1,uploaded.kbId,chunk.id,{text:'Гарантия на прибор составляет 24 месяца. Для ремонта обратитесь к менеджеру.',section:null,expectedHash:source.editHash});
   assert.ok((await Local.lookup(1,'Какая гарантия на прибор?')).answer.includes('24'));
   const preview=await Import.preview(auth,1,{originalname:'prices.csv',buffer:Buffer.from('Название,Цена,Артикул\nКомплект электропастуха,1250.99,K1')});
   Import.commit(auth,1,preview.import.id,{mapping:{name:0,price:1,sku:2},mode:'add',publish:true,idempotencyKey:'chain-import'});
   const offer=Catalog.listPublished(1)[0];
   AI.generatePlainText=async(messages,config)=>{assert.equal(config.id,1);const data=JSON.parse(messages[1].content);assert.equal(data.catalog[0].amountMinor,125099);return JSON.stringify({offerIds:[offer.id]});};
   const answer=await Sales.answerFromKnowledge({instanceId:1,chatId:chat,question:'Сколько стоит комплект электропастуха?',channel:'whatsapp'});assert.match(answer.answer,/1\s250,99/);
   await DB.saveMessage(1,chat,'AVA',answer.answer,'assistant');
   const call={instanceId:1,chatId:chat,callId:'chain-call',transcript:[{role:'user',content:'Пришлите подборку электропастухов в WhatsApp, пожалуйста'}]};
   const result=await Sales.postCall(call);assert.ok(result.handoff_task.task_id);assert.equal((await Sales.postCall(call)).idempotent,true);
   assert.equal(DB.getManagerTask(1,result.handoff_task.task_id).assigneeUserId,'manager');
   assert.ok((await DB.getClientHistory(1,chat,20)).some(m=>m.content===answer.answer));
   const deal=Deals.create(1,{title:'Chain proposal',clientChatId:chat},'owner');
   Studio.save(auth,1,deal.id,{revision:0,dealRevision:deal.revision,text:'Комплект по текущему прайсу. Гарантия 24 месяца.',catalogItems:[{offerId:offer.id,offerRevision:offer.revision,quantity:1}],idempotencyKey:'chain-material'});
   Auth.config.enabled=true;process.env.AVA_CUSTOMER_ACCESS_ENABLED='true';
   const app=require('../src/app').app;server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
   const origin='http://127.0.0.1:'+server.address().port;process.env.WHATSAPP_CRM_PUBLIC_URL=origin;
   const token=Identity.createSession('owner','chain-owner'),foreign=Identity.createSession('foreign','chain-foreign');
   const request=(path,method='GET',body,session=token)=>fetch(origin+path,{method,headers:{Cookie:'crm_session=ava2:'+session,Origin:origin,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
   const base=`/api/businesses/1/studio/proposals/${deal.id}/documents`;
   const pdf=await request(base+'/proposal.pdf?revision=1');assert.equal(pdf.status,200);const bytes=Buffer.from(await pdf.arrayBuffer());assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.ok(bytes.length>1000);
   Router._getWhatsAppState=async()=>({success:true,state:'authorized'});let sends=0;
   OpenWA.sendDocument=async(_url,_key,session,recipient,document)=>{sends++;assert.equal(session,'chain-session');assert.equal(recipient,chat);assert.ok(document.buffer.equals(bytes));return{success:true,providerMessageId:'chain-provider-ack'};};
   assert.equal((await request(base+'/send','POST',{kind:'proposal',revision:1},foreign)).status,403);
   for(let i=0;i<2;i++){const sent=await request(base+'/send','POST',{kind:'proposal',revision:1});assert.equal(sent.status,200);assert.equal((await sent.json()).status,'sent');}
   assert.equal(sends,1);assert.equal(DB.get('SELECT status FROM whatsapp_document_deliveries').status,'accepted');assert.equal(DB.get('SELECT providerMessageId FROM whatsapp_document_deliveries').providerMessageId,'chain-provider-ack');
   assert.equal(DB.get('SELECT COUNT(*) n FROM manager_tasks WHERE callId=?',[call.callId]).n,1);
   assert.equal(await Local.lookup(2,'Какая гарантия на прибор?'),null);
  }finally{
   if(server)await new Promise(r=>server.close(r));RAG.generateEmbeddings=old.embeddings;AI.generatePlainText=old.generate;Router._getWhatsAppState=old.state;OpenWA.sendDocument=old.send;Auth.config.enabled=old.auth;
   for(const [key,value]of[['AVA_CUSTOMER_ACCESS_ENABLED',old.customer],['WHATSAPP_CRM_PUBLIC_URL',old.url]])if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
 });
});
