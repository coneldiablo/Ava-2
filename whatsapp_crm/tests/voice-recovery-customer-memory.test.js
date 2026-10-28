'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Sales=require('../src/services/sales-brain.service');
const Context=require('../src/services/channel-customer-context.service');
const Identity=require('../src/services/client-identity.service');
const Workspace=require('../src/services/ava-workspace.store');
const Catalog=require('../src/services/ava-autopilot.store');
const AI=require('../src/services/ai.service');
const WhatsApp=require('../src/services/whatsapp.service');
const RAG=require('../src/services/rag.service');
const PMS=require('../src/services/pms/pms-intent.service');

async function seed(){
 createTestDB(); Workspace.ensureSchema();
 const first=await DB.createInstance({name:'Foreign fixture'});
 const business=await DB.createInstance({name:'Voice fixture'});
 await DB.updateInstance(business.id,{aiProvider:'gemini',geminiModel:'gemini-3.8-flash'});
 const phone='79990006711',chat=phone+'@c.us';
 await DB.getOrCreateClient(first.id,chat,'Чужое имя');
 await DB.getOrCreateClient(business.id,chat,'Звонивший клиент');
 return {first,business,phone,chat};
}
async function call(f,overrides={}){
 return Sales.postCall({business_id:f.business.id,phone:f.phone,callId:'memory-call',
  transcript:[{role:'assistant',content:'Меня зовут Анастасия.'},{role:'user',content:'Меня зовут Иван Нужен электропастух для овец. Пришлите детали в WhatsApp.'}],
  summary:'Иван выбирает электропастух для овец и попросил подборку в WhatsApp.',...overrides});
}
function patch(object,key,value,restore){const previous=object[key];object[key]=value;restore.push(()=>{object[key]=previous;});}

describe('Voice recovery: exact customer, name, call memory and owed WhatsApp work',()=>{
 it('remembers an answer to the name question and recovers an older unnamed card from its actual transcript',async()=>{
  const f=await seed();await call(f,{transcript:[{role:'assistant',content:'Как к вам обращаться?'},{role:'user',content:'Магомед.'},{role:'user',content:'Хочу посмотреть видеосравнение электропастухов.'}],summary:'Магомед запросил видеосравнение оборудования.'});
  assert.equal((await DB.getClient(f.business.id,f.chat)).senderName,'Магомед');
  // A card processed by an older release can still have its placeholder name.
  DB.run('UPDATE clients SET senderName=? WHERE instanceId=? AND chatId=?',['Звонивший клиент',f.business.id,f.chat]);
  const next=await Sales.assembleContext({business_id:f.business.id,phone:f.phone,callId:'recall-name'});
  assert.equal(next.customer_name,'Магомед');assert.match(next.summary_for_voice,/Магомед/);
  assert.equal((await DB.getClient(f.business.id,f.chat)).senderName,'Звонивший клиент');
  assert.equal((await DB.getClient(f.first.id,f.chat)).senderName,'Чужое имя');
 });

 it('uses newer complete call facts ahead of an older chat summary without accepting incomplete call facts',async()=>{
  const f=await seed();await call(f);
  const Memory=require('../src/services/crm-memory-store.service'),policy=require('../src/services/crm-memory-policy.json');
  function saved(kind,key,date,needs,complete){
   const value={domain:Memory.domain(f.business.id),relevance:'relevant',summary:'Клиент уточнил '+needs,needs,budget:null,interests:[needs],objections:[],dates:[],preferences:[],next_step:null,evidence_ids:[]};
   DB.run('INSERT INTO crm_memory_summaries VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[key,f.business.id,f.chat,kind,key,key,JSON.stringify(value),date,date,'fixture',policy.version,complete?1:0]);
  }
  saved('conversation','old-chat-memory','2026-10-20T10:00:00Z','Старый бумажный каталог',true);
  saved('call','new-call-memory','2026-10-24T10:00:00Z','Видеосравнение моделей электропастухов',true);
  const current=await Sales.assembleContext({business_id:f.business.id,phone:f.phone,callId:'recall-needs'});
  assert.equal(current.known_needs,'Видеосравнение моделей электропастухов');
  assert.match(current.summary_for_voice,/Видеосравнение моделей/);
  DB.run('UPDATE crm_memory_summaries SET sourceComplete=0 WHERE summaryId=?',['new-call-memory']);
  const incomplete=await Sales.assembleContext({business_id:f.business.id,phone:f.phone,callId:'incomplete-needs'});
  assert.equal(incomplete.known_needs,'Старый бумажный каталог');
 });

 it('does not turn a product request after the name question into a customer name',async()=>{
  const f=await seed();await call(f,{transcript:[{role:'assistant',content:'Как к вам обращаться?'},{role:'user',content:'Мне нужен каталог.'}],summary:'Запросил каталог.'});
  assert.equal((await DB.getClient(f.business.id,f.chat)).senderName,'Звонивший клиент');
 });

 it('persists caller self-introduction, one call, task and draft, then restores the same context on the next call/chat',async()=>{
  const f=await seed(),result=await call(f);
  assert.equal(result.resolved.instanceId,f.business.id);
  assert.equal((await DB.getClient(f.business.id,f.chat)).senderName,'Иван');
  assert.equal((await DB.getClient(f.first.id,f.chat)).senderName,'Чужое имя');
  assert.ok(result.followup_draft?.draft_id);
  const draft=DB.getFollowupDraft(f.business.id,result.followup_draft.draft_id),task=DB.getManagerTask(f.business.id,draft.managerTaskId);
  assert.equal(draft.chatId,f.chat);assert.equal(task.chatId,f.chat);assert.equal(draft.callId,'memory-call');
  assert.equal(draft.status,'draft');assert.equal(draft.sentAt,null);
  const next=await Sales.assembleContext({business_id:f.business.id,phone:f.phone,callId:'next-call'});
  assert.equal(next.customer_name,'Иван');assert.match(next.last_call_summary,/электропастух/);
  assert.ok(!/Проверить и отправить|Черновик|Здравствуйте, Иван/.test(next.last_call_summary));
  assert.match(Context.aiContext(f.business.id,f.chat).lastCallSummary,/электропастух/);
  assert.equal(Context.aiContext(f.first.id,f.chat).lastCallSummary,null);
  assert.equal((await call(f)).idempotent,true);
  for(const table of ['followup_drafts','manager_tasks'])assert.equal(DB.get(`SELECT COUNT(*) n FROM ${table} WHERE instanceId=? AND callId=?`,[f.business.id,'memory-call']).n,1);
 });

 it('does not treat tasks or drafts as calls and keeps a newer accepted call ahead of an older profile summary',async()=>{
  const f=await seed();await call(f);
  DB.run("UPDATE conversation_events SET createdAt='2026-10-20 00:00:00' WHERE instanceId=? AND sourceId='post_call:memory-call'",[f.business.id]);
  await call(f,{callId:'newer-call',transcript:[{role:'user',content:'Интересует доставка оборудования завтра.'}],summary:'Теперь клиент уточнил доставку оборудования.'});
  // A linked task is newer than the call and must not become its summary.
  DB.createConversationEvent({instanceId:f.business.id,chatId:f.chat,callId:'newer-call',channel:'manager',role:'task',content:'TASK MUST NEVER BECOME CUSTOMER MEMORY'});
  DB.run("UPDATE conversation_events SET createdAt='2026-10-21 00:00:00' WHERE instanceId=? AND sourceId='post_call:newer-call'",[f.business.id]);
  DB.run("UPDATE client_profiles SET rawProfileJson=? WHERE instanceId=? AND chatId=?",[JSON.stringify({lastCallSummary:'OLD PROFILE SUMMARY',lastCallAt:'2026-10-22T00:00:00Z'}),f.business.id,f.chat]);
  const current=await Sales.customerSummary({business_id:f.business.id,phone:f.phone});
  assert.match(current.profile.lastCallSummary,/доставку оборудования/);
  assert.equal(Sales.getRecentCallEvents(f.business.id,f.chat,3).length,2);
  assert.ok(!current.summary_for_voice.includes('TASK MUST'));
 });

 it('pending conversation generation retains already saved needs/budget and source call facts',async()=>{
  const f=await seed();await call(f);
  DB.upsertClientProfileSync(f.business.id,f.chat,{needs:'Оборудование для овец',budget:'50000 руб'});
  await DB.saveMessage(f.business.id,f.chat,'Иван','Здравствуйте','user');
  await DB.saveMessage(f.business.id,f.chat,'AVA','Здравствуйте','assistant');
  const summary=await Sales.customerSummary({business_id:f.business.id,phone:f.phone});
  assert.equal(summary.memory.summary_status,'generation_pending');
  assert.equal(summary.profile.needs,'Оборудование для овец');assert.equal(summary.profile.budget,'50000 руб');
  assert.match(summary.summary_for_voice,/электропастух/);
 });

 it('only fills placeholder names from an unambiguous caller declaration and respects human control',async()=>{
  const f=await seed();
  const transcripts=[
   [{role:'assistant',content:'Меня зовут Мария'}],
   [{role:'user',content:'У друга меня зовут не спрашивайте'}],
   [{role:'user',content:'Меня зовут Иван. Меня зовут Пётр.'}],
  ];
  for(const [index,transcript]of transcripts.entries())await call(f,{callId:'not-name-'+index,transcript,summary:'Уточняли сведения о бизнесе.'});
  assert.equal((await DB.getClient(f.business.id,f.chat)).senderName,'Звонивший клиент');
  Workspace.setControl({businessId:f.business.id,chatId:f.chat,mode:'human',actorUserId:'fixture',reason:'Manager controls conversation'});
  await call(f,{callId:'human-name',transcript:[{role:'user',content:'Меня зовут Сергей.'}]});
  assert.equal((await DB.getClient(f.business.id,f.chat)).senderName,'Звонивший клиент');
  Workspace.setControl({businessId:f.business.id,chatId:f.chat,mode:'ai',actorUserId:'fixture'});
  DB.run('UPDATE clients SET senderName=? WHERE instanceId=? AND chatId=?',['Елена',f.business.id,f.chat]);
  await call(f,{callId:'preserve-name',transcript:[{role:'user',content:'Меня зовут Сергей.'}]});
  assert.equal((await DB.getClient(f.business.id,f.chat)).senderName,'Елена');
 });

 it('resolves a confirmed alternate caller number to one Telegram card, rejects near matches and conflicting business IDs',async()=>{
  const f=await seed(),telegram='tg_700123';await DB.getOrCreateClient(f.business.id,telegram,'Наталья');
  Identity.attach(f.business.id,telegram,{kind:'phone',value:'+79990006822'});
  const found=await Sales.assembleContext({business_id:f.business.id,phone:'8 (999) 000-68-22',callId:'alias-call'});
  assert.equal(found.chatId,telegram);assert.equal(found.customer_name,'Наталья');
  assert.equal(DB.get('SELECT COUNT(*) n FROM clients WHERE instanceId=?',[f.business.id]).n,2);
  assert.equal((await Sales.resolveCustomer({business_id:f.business.id,phone:'79990006823'})).found,false);
  assert.equal((await Sales.resolveCustomer({business_id:f.first.id,phone:'79990006822'})).found,false);
  await assert.rejects(()=>Sales.assembleContext({instanceId:f.first.id,business_id:f.business.id,phone:f.phone}),error=>error.code==='BUSINESS_SCOPE_REQUIRED');
 });

 it('the Sales Brain chat route passes canonical saved name/call memory and the selected provider/model to AI',async()=>{
  const f=await seed();await call(f);const restore=[],seen=[];
  patch(AI,'getResponse',async(history,context)=>{seen.push({history,context,messages:AI._constructMessages(history,context)});return{reply:'Сведения получены',action:'none'};},restore);
  try{
   await Sales.reply({business_id:f.business.id,phone:f.phone,clientName:'Caller-controlled wrong name',history:[{role:'user',content:'Помните мой звонок?'}]});
   assert.equal(seen.length,1);assert.equal(seen[0].context.clientName,'Иван');
   assert.equal(seen[0].context.instanceConfig.aiProvider,'gemini');assert.equal(seen[0].context.instanceConfig.geminiModel,'gemini-3.8-flash');
   assert.match(seen[0].messages[0].content,/Иван/);assert.match(seen[0].messages[0].content,/электропастух/);
   assert.ok(!seen[0].messages[0].content.includes('Чужое имя'));
  }finally{restore.reverse().forEach(fn=>fn());}
 });

 it('actual WhatsApp path uses the business AI with durable call context and published prices, without remote Onyx/vector waits',async()=>{
  const f=await seed();await call(f);const restore=[],seen=[],sent=[];
  Catalog.saveOffer(f.business.id,{id:'own-price',revision:1,name:'Электропастух',amountMinor:125099,currency:'RUB',active:true,publishedAt:new Date().toISOString()});
  Catalog.saveOffer(f.first.id,{id:'foreign-price',revision:1,name:'Электропастух',amountMinor:1,currency:'RUB',active:true,publishedAt:new Date().toISOString()});
  await DB.saveMessage(f.business.id,f.chat,'Иван','Помните моё имя и электропастух?','user');
  patch(WhatsApp,'_waitForOnyx',async()=>{throw Error('Remote Onyx must not run');},restore);
  patch(RAG,'searchHybrid',async()=>{throw Error('Vector must not run');},restore);
  patch(RAG,'searchVector',async()=>{throw Error('Vector must not run');},restore);
  patch(PMS,'handle',async()=>({handled:false}),restore);
  patch(WhatsApp,'_startTyping',async()=>async()=>{},restore);
  patch(WhatsApp,'_sendMessage',async(instance,chat,text)=>{sent.push({instance:instance.id,chat,text});return{idMessage:'local-ack'};},restore);
  patch(require('../src/services/smart-triggers.service'),'checkKeywordTriggers',async()=>{},restore);
  patch(require('../src/services/sequence.service'),'onClientReply',async()=>{},restore);
  patch(require('../src/services/personalization.service'),'analyzeContactTimes',async()=>{},restore);
  patch(AI,'getResponse',async(history,context)=>{seen.push({context,messages:AI._constructMessages(history,context)});return{reply:'Иван, помню ваш запрос на электропастух.',action:'none'};},restore);
  try{
   await WhatsApp._processBatch(f.business.id,f.chat,{text:'Помните моё имя и электропастух?'},{isStale:()=>false});
   assert.equal(seen.length,1);assert.equal(sent.length,1);assert.equal(sent[0].instance,f.business.id);
   assert.match(seen[0].context.lastCallSummary,/электропастух/);assert.equal(seen[0].context.clientName,'Иван');
   assert.match(seen[0].messages[0].content,/125099/);assert.ok(!seen[0].messages[0].content.includes('foreign-price'));
   assert.equal(seen[0].context.instanceConfig.aiProvider,'gemini');
   assert.equal(DB.getFollowupDraft(f.business.id,DB.get('SELECT draftId FROM followup_drafts WHERE instanceId=?',[f.business.id]).draftId).status,'draft');
   Workspace.setControl({businessId:f.business.id,chatId:f.chat,mode:'human',actorUserId:'fixture'});
   await WhatsApp._processBatch(f.business.id,f.chat,{text:'Новый вопрос'},{isStale:()=>false});
   assert.equal(seen.length,1);assert.equal(sent.length,1);
  }finally{restore.reverse().forEach(fn=>fn());}
 });
});
