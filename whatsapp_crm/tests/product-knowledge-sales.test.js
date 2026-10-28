'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service'),Identity=require('../src/services/identity/identity-store');
const Import=require('../src/services/catalog-import.service'),Catalog=require('../src/services/ava-autopilot.store');
const Local=require('../src/services/knowledge-local.service'),AI=require('../src/services/ai.service');
const Sales=require('../src/services/sales-brain.service');
describe('A20-A21 imported catalogue actually reaches AI and owed call actions',()=>{
 it('passes imported published product/price/source into actual business model selection and applies updates/removal',async()=>{
  createTestDB();Identity.ensureSchema();DB.run("INSERT INTO instances(id,name,aiProvider,geminiModel) VALUES(1,'Пастух','gemini','gemini-3.8-flash'),(2,'Другой','gemini','gemini-3.8-flash')");
  DB.run("INSERT INTO ava_users(id,subject,email) VALUES('owner','owner','owner@example.test')");DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('owner',1,'hotel_owner')");
  const auth=Identity.actor('owner'), preview=await Import.preview(auth,1,{originalname:'catalog.csv',buffer:Buffer.from('name,price,sku\nКомплект электропастуха для овец,1250.99,OW1')});
  Import.commit(auth,1,preview.import.id,{mapping:{name:0,price:1,sku:2},mode:'add',publish:true,idempotencyKey:'import-products'});
  Catalog.saveOffer(2,{id:'foreign',revision:1,name:'Комплект электропастуха чужой',amountMinor:1,currency:'RUB',active:true,publishedAt:new Date().toISOString()});
  const original=AI.generatePlainText,inputs=[];
  AI.generatePlainText=async(messages,config)=>{const payload=JSON.parse(messages[1].content);inputs.push({payload,config});return JSON.stringify({offerIds:[payload.catalog[0].offerId]});};
  try {
   const response=await Sales.answerFromKnowledge({instanceId:1,question:'Подберите электропастух для овец, сколько стоит?',channel:'voice'});
   assert.match(response.answer,/1\s250,99/);assert.strictEqual(inputs.length,1);assert.strictEqual(inputs[0].config.aiProvider,'gemini');
   assert.strictEqual(inputs[0].payload.catalog[0].amountMinor,125099);assert.strictEqual(inputs[0].payload.catalog[0].source,'published_catalog');assert.ok(!JSON.stringify(inputs).includes('чужой'));
   const offer=Catalog.publishedOffers(1)[0];Catalog.saveOffer(1,{...offer,revision:2,amountMinor:90000},offer.revision);
   assert.match((await Sales.answerFromKnowledge({instanceId:1,question:'Цена электропастуха для овец?'})).answer,/900,00/);
   Catalog.saveOffer(1,{...Catalog.offer(1,offer.id),revision:3,active:false},2);assert.deepStrictEqual(Local.catalogContext(1,'Электропастух для овец'),[]);
   assert.strictEqual(await Local.lookup(1,'Электропастух для овец'),null);
  } finally {AI.generatePlainText=original;}
 });
 it('does not return an offer changed during model generation, or accept model-invented catalogue IDs',async()=>{
  createTestDB();DB.run("INSERT INTO instances(id,name) VALUES(1,'A')");Catalog.saveOffer(1,{id:'p',revision:1,name:'Электропастух',amountMinor:100,currency:'RUB',active:true,publishedAt:new Date().toISOString()});
  const old=AI.generatePlainText;
  try {
   AI.generatePlainText=async()=>JSON.stringify({offerIds:['invented']});await assert.rejects(()=>Local.answerCatalog(1,'Электропастух'),{code:'KNOWLEDGE_MODEL_INVALID'});
   AI.generatePlainText=async()=>{Catalog.saveOffer(1,{...Catalog.offer(1,'p'),revision:2,active:false},1);return JSON.stringify({offerIds:['p']});};
   await assert.rejects(()=>Local.answerCatalog(1,'Электропастух'),{code:'KNOWLEDGE_SOURCE_CHANGED'});
  }finally{AI.generatePlainText=old;}
 });
 it('saves one owed WhatsApp task and draft from a guest request, retains shared call context and never sends',async()=>{
  createTestDB();const one=await DB.createInstance({name:'A'}),two=await DB.createInstance({name:'B'}),chat='79990001001@c.us';
  await DB.getOrCreateClient(one.id,chat,'Гость A');await DB.getOrCreateClient(two.id,chat,'Гость B');
  Identity.ensureSchema();DB.run("INSERT INTO ava_users(id,subject,email) VALUES('manager','manager','manager@example.test')");DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('manager',?,'manager')",[one.id]);
  DB.run("UPDATE clients SET assigneeUserId='manager' WHERE instanceId=? AND chatId=?",[one.id,chat]);
  const input={instanceId:one.id,chatId:chat,callId:'owed-wa-pick',transcript:[{role:'user',content:'Пришлите подборку электропастухов в WhatsApp, пожалуйста'},{role:'assistant',content:'Подготовлю для проверки менеджером'}]};
  const result=await Sales.postCall(input);assert.ok(result.handoff_task.task_id);assert.ok(result.followup_draft.draft_id);
  assert.strictEqual(result.followup_draft.draft.manager_task_id,result.handoff_task.task_id);
  assert.strictEqual(result.handoff_task.assigneeUserId,'manager');assert.strictEqual(result.followup_draft.draft.assigneeUserId,'manager');
  assert.strictEqual((await Sales.postCall(input)).idempotent,true);
  assert.strictEqual(DB.get('SELECT COUNT(*) n FROM manager_tasks WHERE instanceId=? AND callId=?',[one.id,input.callId]).n,1);
  assert.strictEqual(DB.get('SELECT COUNT(*) n FROM followup_drafts WHERE instanceId=? AND callId=?',[one.id,input.callId]).n,1);
  const context=require('../src/services/customer-context.service');
  assert.ok(context.snapshot(one.id,chat).calls.find(call=>call.callId===input.callId));
  assert.ok(!JSON.stringify(context.snapshot(two.id,chat)).includes('электропастух'));
  assert.strictEqual(DB.get('SELECT status FROM followup_drafts WHERE instanceId=?',[one.id]).status,'draft');
  const manager=Identity.actor('manager');
  assert.strictEqual((await Sales.updateManagerTask({instanceId:one.id,taskId:result.handoff_task.task_id,status:'in_progress',actor:manager})).success,true);
  assert.strictEqual((await Sales.updateManagerTask({instanceId:one.id,taskId:result.handoff_task.task_id,status:'done',resolutionNote:'Подборка подготовлена, сообщение проверено',actor:manager})).success,true);
  assert.strictEqual(DB.getManagerTask(one.id,result.handoff_task.task_id).status,'done');
 });
 it('does not create owed WhatsApp work from an assistant promise or explicit guest refusal',async()=>{
  createTestDB();const instance=await DB.createInstance({name:'A'}),chat='79990001002@c.us';await DB.getOrCreateClient(instance.id,chat,'Гость');
  for(const [index,transcript]of[
   [{role:'user',content:'Спасибо, до свидания'},{role:'assistant',content:'Я пришлю подборку в WhatsApp'}],
   [{role:'user',content:'Не нужно присылать подборку в WhatsApp'}],
  ].entries()){
   const result=await Sales.postCall({instanceId:instance.id,chatId:chat,callId:'no-intent-'+index,transcript});assert.strictEqual(result.followup_draft,null);
  }
  assert.strictEqual(DB.get('SELECT COUNT(*) n FROM followup_drafts').n,0);
 });
});
