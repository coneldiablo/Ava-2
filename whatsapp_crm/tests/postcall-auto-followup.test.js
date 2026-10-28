'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Sales=require('../src/services/sales-brain.service');
const Queue=require('../src/services/postcall-followup.service');
const Profiles=require('../src/services/hotel-profile.service');
const Catalog=require('../src/services/ava-autopilot.store');
const Workspace=require('../src/services/ava-workspace.store');
const AI=require('../src/services/ai.service');
const Router=require('../src/services/channel-router.service');
const Gateway=require('../src/services/whatsapp-gateway.service');
const Voice=require('../src/services/voice-settings.service');
const Options=require('../src/services/voice-options.service');
const raw=id=>DB.get('SELECT * FROM instances WHERE id=?',[id]);
const draft=(f,id)=>DB.getFollowupDraft(f.a.id,id||f.result.followup_draft.draft_id);
const meta=value=>JSON.parse(value.metadataJson);
async function fixture(fn){
 createTestDB();Workspace.ensureSchema();Catalog.ensureSchema();
 const a=await DB.createInstance({name:'Own business'}),b=await DB.createInstance({name:'Foreign business'}),phone='79990007731',chat=phone+'@c.us';
 await DB.updateInstance(a.id,{aiProvider:'gemini',geminiModel:'gemini-fixture'});
 await DB.getOrCreateClient(a.id,chat,'Иван');await DB.getOrCreateClient(b.id,chat,'Чужой');
 Catalog.saveOffer(a.id,{id:'own-offer',revision:1,name:'Электропастух',amountMinor:125099,currency:'RUB',active:true,publishedAt:new Date().toISOString()});
 Catalog.saveOffer(b.id,{id:'foreign-offer',revision:1,name:'Электропастух',amountMinor:1,currency:'RUB',active:true,publishedAt:new Date().toISOString()});
 const restore=[],sent=[],ai=[];const patch=(o,key,value)=>{const previous=o[key];o[key]=value;restore.push(()=>{o[key]=previous;});};
 patch(Gateway,'getConfig',()=>({hasOpenWa:true,hasGreenApi:false}));
 patch(Gateway,'getState',async()=>({success:true,effectiveState:'authorized'}));
 patch(AI,'generatePlainText',async(messages,config,options)=>{ai.push({messages,config,options});return'Иван, спасибо за разговор! Подготовил информацию по вашему вопросу.';});
 patch(Router,'sendMessageDetailed',async(instanceId,chatId,text,channel,options)=>{options.beforeSend();sent.push({instanceId,chatId,text});return{success:true,provider_message_id:'fixture-ack-'+sent.length,channel:'whatsapp'};});
 try{await fn({a,b,phone,chat,patch,sent,ai});}finally{restore.reverse().forEach(fn=>fn());}
}
async function enable(f){await Profiles.update(f.a.id,{followupAutoSendEnabled:true,expectedFollowupRevision:0});await new Promise(resolve=>setTimeout(resolve,2));}
async function call(f,override={}){
 f.result=await Sales.postCall({business_id:f.a.id,phone:f.phone,callId:'fresh-call',call_started_at:new Date().toISOString(),
  transcript:[{role:'user',content:'Нужен электропастух. Пришлите цены в WhatsApp.'}],summary:'Иван просит цену электропастуха в WhatsApp.',...override});return f.result;
}

describe('Future-only durable automatic post-call WhatsApp',()=>{
 it('default is off, reads do not change schema/data, private activation metadata is never projected',()=>fixture(async f=>{
  const before=raw(f.a.id),schema=DB.all("SELECT name,sql FROM sqlite_master ORDER BY name");
  assert.equal((await Profiles.get(f.a.id)).followupAutoSendEnabled,false);
  assert.equal((await Profiles.get(f.a.id)).followupAutoSendRevision,0);
  assert.deepStrictEqual(raw(f.a.id),before);assert.deepStrictEqual(DB.all("SELECT name,sql FROM sqlite_master ORDER BY name"),schema);
  await enable(f);const profile=await Profiles.get(f.a.id);assert.equal(profile.followupAutoSendEnabled,true);assert.equal(profile.followupAutoSendRevision,1);
  assert.ok(!('_postCallFollowup' in profile.voiceSettings));assert.equal((await Profiles.get(f.b.id)).followupAutoSendEnabled,false);
  await assert.rejects(()=>Profiles.update(f.a.id,{voiceSettings:{_postCallFollowup:{enabled:true}}}),e=>e.code==='VOICE_SETTINGS_READ_ONLY');
  await assert.rejects(()=>Profiles.update(f.a.id,{followupAutoSendEnabled:false,expectedFollowupRevision:0}),e=>e.code==='FOLLOWUP_SETTINGS_CHANGED');
 }));

 it('keeps existing drafts and a late old-call completion manual after activation',()=>fixture(async f=>{
  const old=await call(f,{callId:'old-call'}),oldId=old.followup_draft.draft_id;await enable(f);
  assert.equal(Queue.enqueue({businessId:f.a.id,draftId:oldId,eventId:old.crm_note.event_id,consent:true}).queued,false);
  assert.equal((await Sales.sendWhatsAppFollowup({instanceId:f.a.id,draftId:oldId,confirmed:true})).status,'needs_approval');
  const late=await call(f,{callId:'late-old-call',call_started_at:new Date(Queue.policy(raw(f.a.id)).enabledAtMs-60000).toISOString()});
  assert.equal(late.automatic_followup.queued,false);assert.equal(late.automatic_followup.reason,'FOLLOWUP_CALL_BEFORE_ACTIVATION');
  await Queue.recover();assert.equal(f.sent.length,0);assert.equal(draft(f,oldId).status,'draft');
 }));

 it('fresh explicitly requested call survives worker reload and sends one grounded message through selected AI/channel, replay does not resend',()=>fixture(async f=>{
  await enable(f);const result=await call(f);assert.equal(result.automatic_followup.queued,true);
  const id=result.followup_draft.draft_id;assert.equal(meta(draft(f,id)).autoDispatch.state,'queued');assert.equal(f.sent.length,0,'post-call only persists work');
  delete require.cache[require.resolve('../src/services/postcall-followup.service')];
  const restarted=require('../src/services/postcall-followup.service');await restarted.recover();
  assert.equal(f.sent.length,1);assert.equal(draft(f,id).status,'sent');assert.equal(meta(draft(f,id)).autoDispatch.state,'sent');
  assert.equal(f.sent[0].instanceId,f.a.id);assert.equal(f.sent[0].chatId,f.chat);assert.match(f.sent[0].text,/Спасибо за разговор/);assert.match(f.sent[0].text,/1.?250,99 RUB/);
  assert.ok(!/mcp_|tool_|Следующий шаг|Подготовить подборку|foreign-offer/.test(f.sent[0].text));
  assert.equal(f.ai.length,0,'factual materials do not need a second model request for a greeting');
  assert.equal(DB.getManagerTask(f.a.id,draft(f,id).managerTaskId).status,'done');
  await restarted.recover();await call(f);await restarted.recover();assert.equal(f.sent.length,1);
 }));

 it('requires an actual guest request and a trusted call start; a generated followup flag alone cannot send',()=>fixture(async f=>{
  await enable(f);let result=await call(f,{callId:'no-consent',generate_followup:true,transcript:[{role:'assistant',content:'Пришлю в WhatsApp'},{role:'user',content:'Я подумаю.'}]});
  assert.equal(result.automatic_followup.queued,false);
  result=await call(f,{callId:'unknown-start',call_started_at:null});assert.equal(result.automatic_followup.queued,false);
  await Queue.recover();assert.equal(f.sent.length,0);
 }));

 it('off or human takeover during message preparation keeps the task/draft and sends nothing',()=>fixture(async f=>{
  await enable(f);await call(f);f.patch(Gateway,'getState',async()=>{await Profiles.update(f.a.id,{followupAutoSendEnabled:false,expectedFollowupRevision:1});return{success:true,effectiveState:'authorized'};});
  await Queue.recover();assert.equal(f.sent.length,0);assert.equal(meta(draft(f)).autoDispatch.state,'needs_review');assert.equal(DB.getManagerTask(f.a.id,draft(f).managerTaskId).status,'new');
  await Profiles.update(f.a.id,{followupAutoSendEnabled:true,expectedFollowupRevision:2});await new Promise(r=>setTimeout(r,2));
  await call(f,{callId:'takeover-call'});f.patch(Gateway,'getState',async()=>{Workspace.setControl({businessId:f.a.id,chatId:f.chat,mode:'human',actorUserId:'fixture'});return{success:true,effectiveState:'authorized'};});
  await Queue.recover();assert.equal(f.sent.length,0);assert.equal(meta(draft(f)).autoDispatch.state,'needs_review');
 }));

 it('unconfirmed provider outcome is a permanent fence across worker restart and manager retry',()=>fixture(async f=>{
  await enable(f);await call(f);f.patch(Router,'sendMessageDetailed',async(i,c,t,ch,o)=>{o.beforeSend();f.sent.push({i});return{success:false,unknown:true};});
  await Queue.recover();assert.equal(f.sent.length,1);assert.equal(meta(draft(f)).autoDispatch.state,'unknown');assert.equal(draft(f).status,'draft');
  await Queue.recover();assert.equal(f.sent.length,1);const retried=await Sales.sendWhatsAppFollowup({instanceId:f.a.id,draftId:draft(f).draftId,confirmed:true});assert.equal(retried.status,'pending');assert.equal(f.sent.length,1);
 }));

 it('a previous sent/pending draft or acknowledged voice send for the same call prevents a second automatic send',()=>fixture(async f=>{
  await enable(f);await call(f);DB.createFollowupDraft({instanceId:f.a.id,draftId:'prior-call-send',chatId:f.chat,callId:'fresh-call',text:'Earlier message',status:'sent'});
  await Queue.recover();assert.equal(f.sent.length,0);assert.equal(meta(draft(f)).autoDispatch.errorCode,'FOLLOWUP_CALL_ALREADY_DISPATCHED');
  await call(f,{callId:'tool-sent-call'});DB.createToolRun({instanceId:f.a.id,chatId:f.chat,callId:'tool-sent-call',toolName:'mcp_sales_send_whatsapp_followup',resultRedacted:{sent:true},status:'ok'});
  await Queue.recover();assert.equal(f.sent.length,0);
  await call(f,{callId:'pending-call'});DB.createFollowupDraft({instanceId:f.a.id,draftId:'prior-pending',chatId:f.chat,callId:'pending-call',text:'Unknown',metadata:{delivery_status:'pending'}});
  await Queue.recover();assert.equal(f.sent.length,0);
 }));

 it('current published facts are rechecked at provider dispatch; AI failure cannot block an exact factual message',()=>fixture(async f=>{
  await enable(f);await call(f);f.patch(Router,'sendMessageDetailed',async(i,c,t,ch,o)=>{Catalog.saveOffer(f.a.id,{...Catalog.offer(f.a.id,'own-offer'),revision:2,amountMinor:999999});o.beforeSend();f.sent.push({i});return{success:true,provider_message_id:'should-not-send'};});
  await Queue.recover();assert.equal(f.sent.length,0);assert.equal(meta(draft(f)).autoDispatch.state,'needs_review');
  await call(f,{callId:'ai-error-call'});f.patch(AI,'generatePlainText',async()=>{throw Error('fixture model unavailable');});
  f.patch(Router,'sendMessageDetailed',async(i,c,t,ch,o)=>{o.beforeSend();f.sent.push({i,text:t});return{success:true,provider_message_id:'known-ack'};});
  await Queue.recover();assert.equal(f.sent.length,1);assert.equal(meta(draft(f)).autoDispatch.state,'sent');
 }));

 it('an expired preparation lease is recoverable; a sent ACK surviving before worker bookkeeping is reconciled without retry',()=>fixture(async f=>{
  await enable(f);await call(f);const value=draft(f),auto=meta(value).autoDispatch;
  DB.updateFollowupDraft(f.a.id,value.draftId,{metadata:{autoDispatch:{...auto,state:'preparing',claimToken:'dead-process',leaseUntil:Date.now()-1}}});
  await Queue.recover();assert.equal(f.sent.length,1);
  await call(f,{callId:'ack-crash-call'});const current=draft(f);DB.updateFollowupDraft(f.a.id,current.draftId,{status:'sent',sentAt:new Date().toISOString(),metadata:{autoDispatch:{...meta(current).autoDispatch,state:'prepared',leaseUntil:0}}});
  await Queue.recover();assert.equal(f.sent.length,1);assert.equal(meta(draft(f)).autoDispatch.state,'sent');assert.equal(DB.getManagerTask(f.a.id,draft(f).managerTaskId).status,'done');
 }));

 it('preserves a policy committed during awaited voice validation and retains provider selections during a flag-only write',()=>fixture(async f=>{
  const originalOptions=Options.getOptions,originalPrepare=Voice.prepareWrite;
  Options.getOptions=async()=>({providers:['neuro_gemini','yandex_realtime','google_live'].map(id=>({id,available:true,models:[{id:Options.getDefaults(id).model}],voices:[{id:Options.getDefaults(id).voiceName}]}))});
  let updated=false;Voice.prepareWrite=async(...args)=>{const value=await originalPrepare(...args);if(!updated){updated=true;await Profiles.update(f.a.id,{followupAutoSendEnabled:true,expectedFollowupRevision:0});}return value;};
  try{await Profiles.update(f.a.id,{voiceAiProvider:'neuro_gemini'});assert.equal(Queue.policy(raw(f.a.id)).enabled,true);assert.equal(Queue.policy(raw(f.a.id)).revision,1);
   const map=JSON.parse(raw(f.a.id).voiceSettings).neuro_gemini;
   await Profiles.update(f.a.id,{followupAutoSendEnabled:false,expectedFollowupRevision:1});assert.deepStrictEqual(JSON.parse(raw(f.a.id).voiceSettings).neuro_gemini,map);
  }finally{Options.getOptions=originalOptions;Voice.prepareWrite=originalPrepare;}
 }));

 it('real HTTP permits owner read/save, denies manager/foreign business, hides private activation and rejects a stale revision',()=>fixture(async f=>{
  const Identity=require('../src/services/identity/identity-store'),Auth=require('../src/services/auth.service'),express=require('express');Identity.ensureSchema();
  DB.run("INSERT INTO ava_users(id,email,displayName) VALUES('postcall-owner','postcall-owner@example.test','Owner'),('postcall-manager','postcall-manager@example.test','Manager')");
  DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('postcall-owner',?,'hotel_owner'),('postcall-manager',?,'manager')",[f.a.id,f.a.id]);
  const sessions={owner:Identity.actor('postcall-owner'),manager:Identity.actor('postcall-manager')},oldUrl=process.env.WHATSAPP_CRM_PUBLIC_URL;
  f.patch(Auth,'getSession',req=>sessions[req.get('x-test-actor')]||null);process.env.WHATSAPP_CRM_PUBLIC_URL='https://ava.example.test';
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.auth=Auth.getSession(req);next();});app.use('/api',require('../src/routes/api.routes'));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const request=async(path,actor,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`,{method:body?'PUT':'GET',headers:{origin:'https://ava.example.test','x-test-actor':actor,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json()};};
  try{
   assert.equal((await request('hotel-profiles/'+f.a.id,'manager',{followupAutoSendEnabled:true,expectedFollowupRevision:0})).status,403);
   assert.equal((await request('hotel-profiles/'+f.b.id,'owner',{followupAutoSendEnabled:true,expectedFollowupRevision:0})).status,403);
   assert.equal((await request('hotel-profiles/'+f.a.id,'owner',{followupAutoSendEnabled:true,expectedFollowupRevision:0})).status,200);
   const read=await request('hotel-profiles/'+f.a.id,'manager');assert.equal(read.status,200);assert.equal(read.body.profile.followupAutoSendEnabled,true);assert.equal(read.body.profile.followupAutoSendRevision,1);assert.ok(!JSON.stringify(read.body).includes('_postCallFollowup'));
   assert.equal((await request('hotel-profiles/'+f.a.id,'owner',{followupAutoSendEnabled:false,expectedFollowupRevision:0})).status,409);
   const instances=await request('instances','owner');assert.equal(instances.status,200);assert.ok(!JSON.stringify(instances.body).includes('_postCallFollowup'));
   assert.equal(Queue.policy(raw(f.a.id)).enabled,true);assert.equal(Queue.policy(raw(f.b.id)).enabled,false);
  }finally{await new Promise(r=>server.close(r));if(oldUrl===undefined)delete process.env.WHATSAPP_CRM_PUBLIC_URL;else process.env.WHATSAPP_CRM_PUBLIC_URL=oldUrl;}
 }));

 it('missing channel or a new inbound after preparation produces review without a provider send',()=>fixture(async f=>{
  await enable(f);await call(f);f.patch(Gateway,'getConfig',()=>({hasOpenWa:false,hasGreenApi:false}));await Queue.recover();assert.equal(f.sent.length,0);assert.equal(meta(draft(f)).autoDispatch.errorCode,'WHATSAPP_NOT_CONFIGURED');
  f.patch(Gateway,'getConfig',()=>({hasOpenWa:true,hasGreenApi:false}));await call(f,{callId:'changed-dialogue'});
  f.patch(Router,'sendMessageDetailed',async(i,c,t,ch,o)=>{await DB.saveMessage(i,c,'Иван','Новый вопрос','user');o.beforeSend();f.sent.push({i});return{success:true,provider_message_id:'should-not-happen'};});
  await Queue.recover();assert.equal(f.sent.length,0);assert.equal(meta(draft(f)).autoDispatch.state,'needs_review');
 }));

 it('retains published price conditions and never answers a warranty/manual request with a matching product price',()=>fixture(async f=>{
  Catalog.saveOffer(f.a.id,{...Catalog.offer(f.a.id,'own-offer'),terms:'Цена только при покупке от десяти штук.'});
  await enable(f);await call(f);await Queue.recover();assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/только при покупке от десяти штук/);
  await call(f,{callId:'manual-request',transcript:[{role:'user',content:'Пришлите в WhatsApp инструкцию как использовать электропастух.'}]});
  await Queue.recover();assert.equal(f.sent.length,1);assert.equal(meta(draft(f)).autoDispatch.state,'needs_review');
 }));

 it('sends a clean long current-tenant KB extract without truncating its final condition',()=>fixture(async f=>{
  const text='Гарантия на электропастух составляет два года при соблюдении инструкции производителя. Оборудование следует устанавливать на сухом участке и регулярно проверять состояние контактов. Перед началом работы внимательно осмотрите изоляцию, проверьте крепления и убедитесь, что все элементы подключены правильно. Для обращения сохраните документ о покупке и серийный номер устройства. Гарантия действует только при сохранности заводских пломб.';
  assert.ok(text.length>=430&&text.length<=650);
  const kb=DB.addKnowledgeBaseFile(f.a.id,'manual.txt','Гарантия','fixture-long-kb','text/plain',text.length,1);await DB.addKnowledgeBaseChunks(kb,[{text,section:'Гарантия'}]);
  const foreign=DB.addKnowledgeBaseFile(f.b.id,'foreign.txt','Чужой','fixture-foreign','text/plain',20,1);await DB.addKnowledgeBaseChunks(foreign,[{text:'Гарантия на электропастух только один месяц.',section:'Гарантия'}]);
  await enable(f);await call(f,{transcript:[{role:'user',content:'Пришлите условия гарантии на электропастух в WhatsApp.'}]});await Queue.recover();
  assert.equal(f.sent.length,1);assert.ok(f.sent[0].text.includes(text));assert.match(f.sent[0].text,/заводских пломб\.$/);assert.ok(!f.sent[0].text.includes('один месяц'));
 }));
 it('never sends business role-play instructions or price placeholders as customer materials',()=>fixture(async f=>{
  const text='Условия гарантии на электропастух. Клиент: «Магомед». Амина: «Очень приятно. Что интересует?» Если имя не названо — не задерживать разговор, перейти к запросу. По актуальному прайсу [МОДЕЛЬ А] — [ЦЕНА].';
  const kb=DB.addKnowledgeBaseFile(f.a.id,'prompt.txt','Настройки ассистента','fixture-prompt-kb','text/plain',text.length,1);await DB.addKnowledgeBaseChunks(kb,[{text,section:'Инструкция'}]);
  await enable(f);await call(f,{transcript:[{role:'user',content:'Пришлите условия гарантии на электропастух в WhatsApp.'}]});await Queue.recover();
  assert.equal(f.sent.length,0);assert.equal(meta(draft(f)).autoDispatch.errorCode,'FOLLOWUP_FACTS_REQUIRED');assert.equal(DB.getManagerTask(f.a.id,draft(f).managerTaskId).status,'new');
 }));

 it('extracts a complete factual paragraph from a KB chunk that also contains internal dialogue examples',()=>fixture(async f=>{
  const facts='Гарантия на электропастух составляет два года. Гарантия действует только при сохранности заводских пломб.';
  const text='Сценарий диалога. Клиент: «Какая гарантия?» Амина: «По актуальному прайсу [ЦЕНА]».\n\n'+facts;
  const kb=DB.addKnowledgeBaseFile(f.a.id,'mixed.txt','Гарантия','fixture-mixed-kb','text/plain',text.length,1);await DB.addKnowledgeBaseChunks(kb,[{text,section:'Гарантия'}]);
  await enable(f);await call(f,{transcript:[{role:'user',content:'Пришлите условия гарантии на электропастух в WhatsApp.'}]});await Queue.recover();
  assert.equal(f.sent.length,1);assert.ok(f.sent[0].text.endsWith(facts));assert.ok(!f.sent[0].text.includes('Сценарий'));assert.ok(!f.sent[0].text.includes('[ЦЕНА]'));
 }));

});
