'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service'),Sales=require('../src/services/sales-brain.service');
const Queue=require('../src/services/postcall-followup.service'),Profiles=require('../src/services/hotel-profile.service');
const Identity=require('../src/services/client-identity.service'),Catalog=require('../src/services/ava-autopilot.store');
const Workspace=require('../src/services/ava-workspace.store'),AI=require('../src/services/ai.service');
const Gateway=require('../src/services/whatsapp-gateway.service'),Telegram=require('../src/services/telegram.service');
const Router=require('../src/services/channel-router.service'),External=require('../src/services/integrations/store');
const meta=value=>JSON.parse(value.metadataJson),draft=f=>DB.getFollowupDraft(f.a.id,f.result.followup_draft.draft_id);
async function fixture(fn){
 const previousKey=process.env.CHANNEL_CREDENTIALS_MASTER_KEY;process.env.CHANNEL_CREDENTIALS_MASTER_KEY='01'.repeat(32);
 createTestDB();Workspace.ensureSchema();Catalog.ensureSchema();External.schema();
 const a=await DB.createInstance({name:'Own channels'}),b=await DB.createInstance({name:'Other channels'}),phone='79990008821',chat=phone+'@c.us';
 await DB.getOrCreateClient(a.id,chat,'Иван');await DB.getOrCreateClient(b.id,chat,'Другой клиент');
 await DB.updateInstance(a.id,{aiProvider:'gemini',geminiModel:'fixture-gemini',telegramBotToken:'fixture-local-bot'});
 Catalog.saveOffer(a.id,{id:'own',revision:1,name:'Электропастух',amountMinor:125099,currency:'RUB',active:true,publishedAt:new Date().toISOString()});
 const restore=[],sent=[],f={a,b,phone,chat,sent};
 f.patch=(object,key,value)=>{const before=object[key];object[key]=value;restore.push(()=>{object[key]=before;});};
 f.patch(AI,'generatePlainText',async()=> 'Иван, спасибо за разговор! Подготовил информацию по вашему вопросу.');
 f.patch(Gateway,'getConfig',()=>({hasOpenWa:true,hasGreenApi:false}));
 f.patch(Gateway,'getState',async()=>({success:true,state:'authorized',effectiveState:'authorized'}));
 f.patch(Gateway,'sendMessage',async(instance,recipient,text,context)=>{await context.beforeSend();sent.push({channel:'whatsapp',businessId:instance.id,recipient,text});return{success:true,data:{idMessage:'fixture-wa'}};});
 const bots=Telegram._bots;Telegram._bots=new Map([[a.id,{sendMessage:async(recipient,text)=>{sent.push({channel:'telegram',businessId:a.id,recipient:String(recipient),text});return{message_id:711};}}]]);restore.push(()=>{Telegram._bots=bots;});
 try{await fn(f);}finally{restore.reverse().forEach(fn=>fn());if(previousKey===undefined)delete process.env.CHANNEL_CREDENTIALS_MASTER_KEY;else process.env.CHANNEL_CREDENTIALS_MASTER_KEY=previousKey;}
}
async function enable(f){await Profiles.update(f.a.id,{followupAutoSendEnabled:true,expectedFollowupRevision:0});await new Promise(r=>setTimeout(r,2));}
async function call(f,channel='Telegram',overrides={}){
 f.result=await Sales.postCall({business_id:f.a.id,chatId:f.chat,phone:f.phone,callId:'multichannel-call',call_started_at:new Date().toISOString(),
  transcript:[{role:'user',content:`Нужен электропастух. Пришлите цену в ${channel}.`}],summary:'Клиент просит стоимость электропастуха.',...overrides});return f.result;
}

describe('Confirmed multichannel post-call dispatch through existing adapters',()=>{
 it('extracts only explicit guest requests, rejects ambiguity and honors channel cancellation',()=>{
  const request=text=>Sales.followupRequest([{role:'assistant',content:'Пришлю в WhatsApp'},{role:'user',content:text}]);
  for(const [text,channel] of [['Пришлите цену в телеграм','telegram'],['Отправьте документы на почту','email'],['Скинь детали в ВК','vk'],['Напишите в MAX','max'],['Пришлите в Авито','avito'],['Пришлите в WhatsApp','whatsapp']])assert.equal(request(text).channel,channel,text);
  for(const text of ['Не отправляйте в Telegram.','В Telegram я не хочу сообщения.','Я отправлю вам в Telegram.','Пришлите в Telegram или WhatsApp.'])assert.equal(request(text).channel,null,text);
  assert.deepStrictEqual(request('Пришлите в WhatsApp. Не пишите в WhatsApp. Пришлите в Telegram.').channels,['telegram']);
 });

 it('a confirmed Telegram contact without a phone receives one fresh post-call message with canonical history',()=>fixture(async f=>{
  f.chat='tg_780001';f.phone='';await DB.getOrCreateClient(f.a.id,f.chat,'Иван');
  await enable(f);await call(f);assert.equal(f.result.resolved.chatId,f.chat);assert.equal(f.result.resolved.phone,null);
  assert.equal(f.result.automatic_followup.queued,true);assert.equal(meta(draft(f)).channel,'telegram');
  f.patch(Gateway,'getState',async()=>{throw Error('Telegram must not depend on WhatsApp availability');});
  await Queue.recover();assert.equal(f.sent.length,1);assert.equal(f.sent[0].channel,'telegram');assert.equal(f.sent[0].recipient,'780001');assert.equal(f.sent[0].businessId,f.a.id);assert.equal(draft(f).status,'sent');
  assert.equal(DB.get("SELECT COUNT(*) n FROM messages WHERE instanceId=? AND chatId=? AND channel='telegram' AND role='assistant'",[f.a.id,f.chat]).n,1);
  await Queue.recover();await call(f);await Queue.recover();assert.equal(f.sent.length,1);
 }));

 it('the manager-confirmed Telegram alias remains attached to the calling customer and a foreign alias cannot become its target',()=>fixture(async f=>{
  Identity.attach(f.a.id,f.chat,{kind:'telegram',value:'780002'});Identity.attach(f.b.id,f.chat,{kind:'telegram',value:'780099'});
  await enable(f);await call(f);await Queue.recover();assert.equal(f.sent.length,1);assert.equal(f.sent[0].recipient,'780002');
  assert.equal(DB.get('SELECT COUNT(*) n FROM clients WHERE instanceId=?',[f.a.id]).n,1);
  const rejected=await Sales.draftFollowup({business_id:f.a.id,chatId:f.chat,channel:'telegram',recipient:'780099',text:'Foreign target'});
  assert.equal(rejected.error,'channel_not_linked');
 }));

 it('a missing/unconfigured requested target stays for manager review, never silently switches to WhatsApp',()=>fixture(async f=>{
  await enable(f);await call(f);await Queue.recover();assert.equal(f.sent.length,0);assert.equal(meta(draft(f)).autoDispatch.state,'needs_review');assert.equal(draft(f).status,'draft');assert.equal(meta(draft(f)).channel,'telegram');
  Identity.attach(f.a.id,f.chat,{kind:'telegram',value:'780003'});await DB.updateInstance(f.a.id,{telegramBotToken:''});
  await call(f,'Telegram',{callId:'disconnected-telegram'});await Queue.recover();assert.equal(f.sent.length,0);assert.equal(meta(draft(f)).autoDispatch.errorCode,'FOLLOWUP_CHANNEL_UNAVAILABLE');
 }));

 it('removing/replacing a confirmed recipient during preparation prevents dispatch',()=>fixture(async f=>{
  Identity.attach(f.a.id,f.chat,{kind:'telegram',value:'780004'});await enable(f);await call(f);
  f.patch(Router,'sendMessageDetailed',async(i,c,t,ch,o)=>{Identity.attach(f.a.id,f.chat,{kind:'telegram',value:'780005'});o.beforeSend();f.sent.push({i});return{success:true,provider_message_id:'should-not-send'};});
  await Queue.recover();assert.equal(f.sent.length,0);assert.equal(meta(draft(f)).autoDispatch.state,'needs_review');
 }));

 it('unknown Telegram ACK is fenced after restart and cannot be repeated in another channel for that call',()=>fixture(async f=>{
  Identity.attach(f.a.id,f.chat,{kind:'telegram',value:'780006'});await enable(f);await call(f);
  Telegram._bots.set(f.a.id,{sendMessage:async(recipient,text)=>{f.sent.push({channel:'telegram',recipient});return{};}});
  await Queue.recover();assert.equal(f.sent.length,1);assert.equal(meta(draft(f)).autoDispatch.state,'unknown');
  delete require.cache[require.resolve('../src/services/postcall-followup.service')];await require('../src/services/postcall-followup.service').recover();assert.equal(f.sent.length,1);
  assert.equal((await Sales.sendFollowup({instanceId:f.a.id,draftId:draft(f).draftId,channel:'whatsapp',confirmed:true})).status,'pending');assert.equal(f.sent.length,1);
 }));

 it('expired preparation recovers but an old Telegram draft never becomes automatic after enablement',()=>fixture(async f=>{
  Identity.attach(f.a.id,f.chat,{kind:'telegram',value:'780007'});await call(f,'Telegram',{callId:'old-tg'});const old=draft(f);
  await enable(f);assert.equal(Queue.enqueue({businessId:f.a.id,draftId:old.draftId,eventId:f.result.crm_note.event_id,consent:true,requestedChannel:'telegram'}).queued,false);
  await call(f);const current=draft(f);DB.updateFollowupDraft(f.a.id,current.draftId,{metadata:{autoDispatch:{...meta(current).autoDispatch,state:'preparing',claimToken:'expired-process',leaseUntil:0}}});
  await Queue.recover();assert.equal(f.sent.length,1);assert.equal(DB.getFollowupDraft(f.a.id,old.draftId).status,'draft');
 }));

 for(const [channel,phrase,instancePatch,clientPatch,method,args] of [
  ['email','электронную почту',{emailSmtpHost:'smtp.example.test',emailSmtpUser:'business@example.test'},{emailAddress:'client@example.test'},'sendEmail',4],
  ['vk','ВКонтакте',{vkGroupToken:'fixture-vk'},{vkUserId:'780008',vkPeerId:'780008'},'sendMessage',3],
  ['max','MAX',{maxBotToken:'fixture-max'},{maxUserId:'780009',maxChatId:'-780009'},'sendMessage',4],
 ])it(`uses the existing ${channel} adapter and its confirmed native contact`,()=>fixture(async f=>{
  await DB.updateInstance(f.a.id,instancePatch);for(const[key,value]of Object.entries(clientPatch))DB.run(`UPDATE clients SET ${key}=? WHERE instanceId=? AND chatId=?`,[value,f.a.id,f.chat]);
  f.patch(require('../src/services/'+(channel==='vk'?'vk':channel)+'.service'),method,async(...values)=>{const context=values[args];await context.beforeSend();f.sent.push({channel,businessId:values[0],recipient:values[1],text:values[args-1]});return true;});
  await enable(f);await call(f,phrase);assert.equal(f.result.automatic_followup.queued,true);await Queue.recover();assert.equal(f.sent.length,1);assert.equal(f.sent[0].channel,channel);assert.equal(draft(f).status,'sent');
 }));

 it('Avito uses the current account-bound confirmed link and durable send idempotency key',()=>fixture(async f=>{
  DB.run("INSERT INTO customer_external_connections(instanceId,provider,status,accountId,capabilitiesJson,updatedAt) VALUES(?,'avito','connected','880001','{\"send\":true}',?)",[f.a.id,Date.now()]);
  External.link(f.a.id,'avito',f.chat,'880001',{externalChatId:'fixture-chat'});
  f.patch(require('../src/services/avito.service'),'sendMessageDetailed',async(id,recipient,text,context)=>{assert.ok(context.idempotencyKey);await context.beforeSend();f.sent.push({channel:'avito',businessId:id,recipient,text});return{success:true,provider_message_id:'avito-fixture-ack',source_message_id:'fixture-chat:avito-fixture-ack'};});
  await enable(f);await call(f,'Авито');await Queue.recover();assert.equal(f.sent.length,1);assert.equal(f.sent[0].recipient,'avito:880001:fixture-chat');assert.equal(draft(f).status,'sent');
 }));

 it('a definite adapter preflight failure does not grant human approval to an automatic draft',()=>fixture(async f=>{
  Identity.attach(f.a.id,f.chat,{kind:'telegram',value:'780010'});await enable(f);await call(f);Telegram._bots.delete(f.a.id);
  await Queue.recover();assert.equal(f.sent.length,0);assert.equal(meta(draft(f)).autoDispatch.state,'needs_review');assert.equal(draft(f).status,'draft');
  assert.equal((await Sales.sendFollowup({instanceId:f.a.id,draftId:draft(f).draftId,confirmed:true})).status,'needs_approval');
 }));

 it('adopts the same untouched in-call generic draft after needs-approval and sends once after accepted call evidence',()=>fixture(async f=>{
  Identity.attach(f.a.id,f.chat,{kind:'telegram',value:'780011'});await enable(f);
  const prepared=await Sales.draftFollowup({instanceId:f.a.id,chatId:f.chat,phone:f.phone,callId:'multichannel-call',channel:'telegram',text:'Draft prepared during call'});
  assert.equal((await Sales.sendFollowup({instanceId:f.a.id,draftId:prepared.draft_id,channel:'telegram',confirmed:true})).status,'needs_approval');
  await call(f);assert.equal(f.result.followup_draft.draft_id,prepared.draft_id);assert.equal(f.result.automatic_followup.queued,true);assert.equal(draft(f).source,'post_call');
  await Queue.recover();assert.equal(f.sent.length,1);assert.equal(f.sent[0].channel,'telegram');assert.equal(draft(f).status,'sent');
  await call(f);await Queue.recover();assert.equal(f.sent.length,1);assert.equal(DB.get('SELECT COUNT(*) n FROM followup_drafts WHERE instanceId=? AND callId=?',[f.a.id,'multichannel-call']).n,1);
 }));

 it('confirmed native email/VK/MAX merges preserve history and secondary inbound aliases without duplicate cards',()=>fixture(async f=>{
  const hash=value=>require('crypto').createHash('sha256').update(value).digest('hex');
  const samples=[['email','Client@Example.test','email_'+hash('Client@Example.test'),{emailAddress:'Client@Example.test'},value=>DB.getClientByEmail(f.a.id,value)],
   ['vk','780012','vk_780012',{vkUserId:'780012',vkPeerId:'780012'},value=>DB.getClientByVk(f.a.id,value)],
   ['max','user:780013','max_780013',{maxUserId:'780013',maxChatId:'-780013'},value=>DB.getClientByMax(f.a.id,value.replace('user:',''))]];
  const manager='fixture-assignee';DB.run('UPDATE clients SET assigneeUserId=? WHERE instanceId=? AND chatId=?',[manager,f.a.id,f.chat]);
  for(const[kind,value,chatId,fields,getter]of samples){
   await DB.getOrCreateClient(f.a.id,chatId,'Native contact');for(const[key,field]of Object.entries(fields))DB.run(`UPDATE clients SET ${key}=? WHERE instanceId=? AND chatId=?`,[field,f.a.id,chatId]);
   const saved=await DB.saveMessageWithChannel(f.a.id,chatId,'Native contact','Existing source '+kind,'user',kind);const sourceTime=DB.get('SELECT timestamp FROM messages WHERE id=?',[saved.id])?.timestamp;assert.ok(sourceTime);
   assert.throws(()=>Identity.attach(f.a.id,f.chat,{kind,value}),e=>e.code==='ALIAS_CONFLICT');
   Identity.attach(f.a.id,f.chat,{kind,value,confirmMerge:true,mergeChatId:chatId});
   assert.equal((await getter(value)).chatId,f.chat);assert.equal(DB.get('SELECT chatId FROM messages WHERE id=?',[saved.id]).chatId,f.chat);assert.equal(DB.get('SELECT timestamp FROM messages WHERE id=?',[saved.id])?.timestamp,sourceTime);
   const incoming=await getter(kind==='email'?value.toLowerCase():value);await DB.saveMessageWithChannel(f.a.id,incoming.chatId,'Native contact','Future inbound '+kind,'user',kind);
   assert.equal(incoming.assigneeUserId,manager);assert.equal(DB.get('SELECT COUNT(*) n FROM clients WHERE instanceId=?',[f.a.id]).n,1);
  }
  // Changing the primary contact keeps confirmed older aliases usable.
  Identity.attach(f.a.id,f.chat,{kind:'email',value:'other@example.test'});Identity.attach(f.a.id,f.chat,{kind:'vk',value:'780014'});Identity.attach(f.a.id,f.chat,{kind:'max',value:'user:780015'});
  assert.equal((await DB.getClientByEmail(f.a.id,'CLIENT@EXAMPLE.TEST')).chatId,f.chat);assert.equal((await DB.getClientByVk(f.a.id,'780012')).chatId,f.chat);assert.equal((await DB.getClientByMax(f.a.id,'780013')).chatId,f.chat);
  assert.equal(DB.get('SELECT COUNT(*) n FROM clients WHERE instanceId=?',[f.a.id]).n,1);
 }));

 it('real HTTP allows a scoped manager to confirm an existing native contact, rejects foreign scope and exposes its actual channel',()=>fixture(async f=>{
  const Users=require('../src/services/identity/identity-store'),Auth=require('../src/services/auth.service'),express=require('express');Users.ensureSchema();
  DB.run("INSERT INTO ava_users(id,email,displayName) VALUES('multi-manager','multi-manager@example.test','Manager')");DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('multi-manager',?,'manager')",[f.a.id]);
  DB.run('UPDATE clients SET assigneeUserId=? WHERE instanceId=? AND chatId=?',['multi-manager',f.a.id,f.chat]);
  await DB.updateInstance(f.a.id,{emailSmtpHost:'smtp.example.test',emailSmtpUser:'business@example.test'});
  const source=await DB.getOrCreateClient(f.a.id,'email_fixture_source','Email contact');DB.run('UPDATE clients SET emailAddress=? WHERE instanceId=? AND chatId=?',['person@example.test',f.a.id,source.chatId]);
  const actor=Users.actor('multi-manager');f.patch(Auth,'getSession',()=>actor);const oldUrl=process.env.WHATSAPP_CRM_PUBLIC_URL;process.env.WHATSAPP_CRM_PUBLIC_URL='https://ava.example.test';
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.auth=Auth.getSession(req);next();});app.use('/api',require('../src/routes/client-identity.routes'));app.use('/api',require('../src/routes/api.routes'));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const request=async(path,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`,{method:body?'POST':'GET',headers:{origin:'https://ava.example.test','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json()};};
  const path=`clients/${f.a.id}/${encodeURIComponent(f.chat)}/identities`;
  try{
   assert.equal((await request(`clients/${f.b.id}/${encodeURIComponent(f.chat)}/identities`,{kind:'email',value:'person@example.test'})).status,403);
   assert.equal((await request(path,{kind:'email',value:'person@example.test',businessId:f.b.id})).status,403);
   const conflict=await request(path,{kind:'email',value:'person@example.test'});assert.equal(conflict.status,409);assert.equal(conflict.body.conflictingChatId,source.chatId);
   const confirmed=await request(path,{kind:'email',value:'person@example.test',confirmMerge:true,mergeChatId:source.chatId});assert.equal(confirmed.status,200);assert.ok(confirmed.body.aliases.some(a=>a.kind==='email'&&a.value==='person@example.test'));
   const options=await request(`clients/${f.a.id}/${encodeURIComponent(f.chat)}/followup-channels`);assert.equal(options.status,200);assert.ok(options.body.channels.some(c=>c.channel==='email'&&c.recipient==='person@example.test'));
   assert.equal((await DB.getClientByEmail(f.a.id,'person@example.test')).chatId,f.chat);assert.equal(DB.get('SELECT COUNT(*) n FROM clients WHERE instanceId=?',[f.a.id]).n,1);
  }finally{await new Promise(r=>server.close(r));if(oldUrl===undefined)delete process.env.WHATSAPP_CRM_PUBLIC_URL;else process.env.WHATSAPP_CRM_PUBLIC_URL=oldUrl;}
 }));

 it('a previously attempted in-call draft stays fenced instead of being adopted for a second send',()=>fixture(async f=>{
  Identity.attach(f.a.id,f.chat,{kind:'telegram',value:'780016'});await enable(f);
  const prepared=await Sales.draftFollowup({instanceId:f.a.id,chatId:f.chat,callId:'multichannel-call',channel:'telegram',text:'During call'});
  DB.updateFollowupDraft(f.a.id,prepared.draft_id,{metadata:{delivery_status:'unknown'}});
  await call(f);assert.equal(f.result.followup_draft.draft_id,prepared.draft_id);assert.equal(f.result.automatic_followup.queued,false);
  await Queue.recover();assert.equal(f.sent.length,0);assert.equal(draft(f).source,'sales_brain');assert.equal(meta(draft(f)).delivery_status,'unknown');
 }));

 it('preserves opaque WhatsApp LID identities and omits invalid legacy native contacts without losing a valid channel',()=>fixture(async f=>{
  const lid='123456789012345@lid';await DB.getOrCreateClient(f.a.id,lid,'Opaque contact');assert.equal(Identity.resolve(f.a.id,lid),lid);
  Identity.attach(f.a.id,f.chat,{kind:'telegram',value:'780017'});DB.run('UPDATE clients SET maxChatId=?,emailAddress=? WHERE instanceId=? AND chatId=?',['legacy-bad-id','invalid-address',f.a.id,f.chat]);
  assert.ok((await Sales.followupChannels(f.a.id,f.chat)).some(target=>target.channel==='telegram'));
  assert.ok(!(await Sales.followupChannels(f.a.id,f.chat)).some(target=>target.channel==='email'||target.channel==='max'));
 }));

 it('keeps an Instagram request as an explicit manager task without bypassing its manual-reply capability',()=>fixture(async f=>{
  await enable(f);await call(f,'Instagram');assert.equal(f.result.automatic_followup.queued,false);assert.equal(f.result.automatic_followup.reason,'channel_requires_manager');
  assert.ok(f.result.handoff_task.task_id);assert.equal(meta(draft(f)).requested_channel,'instagram');await Queue.recover();assert.equal(f.sent.length,0);
 }));

 it('keeps legacy native primary contacts as confirmed aliases before replacing them',()=>fixture(async f=>{
  DB.run('UPDATE clients SET emailAddress=?,telegramChatId=?,vkUserId=?,vkPeerId=?,maxUserId=?,maxChatId=? WHERE instanceId=? AND chatId=?',
   ['old@example.test','780020','780021','780021','780022','-780022',f.a.id,f.chat]);
  Identity.attach(f.a.id,f.chat,{kind:'email',value:'new@example.test'});Identity.attach(f.a.id,f.chat,{kind:'telegram',value:'780023'});
  Identity.attach(f.a.id,f.chat,{kind:'vk',value:'780024'});Identity.attach(f.a.id,f.chat,{kind:'max',value:'user:780025'});Identity.attach(f.a.id,f.chat,{kind:'max',value:'chat:-780025'});
  for(const value of ['old@example.test','new@example.test'])assert.equal((await DB.getClientByEmail(f.a.id,value)).chatId,f.chat);
  for(const value of ['780020','780023'])assert.equal((await DB.getClientByTelegram(f.a.id,value)).chatId,f.chat);
  for(const value of ['780021','780024'])assert.equal((await DB.getClientByVk(f.a.id,value)).chatId,f.chat);
  for(const value of ['780022','780025'])assert.equal((await DB.getClientByMax(f.a.id,value)).chatId,f.chat);
  assert.equal(Identity.resolve(f.a.id,'chat:-780022'),f.chat);assert.equal(Identity.resolve(f.a.id,'chat:-780025'),f.chat);
  assert.equal(DB.get('SELECT COUNT(*) n FROM clients WHERE instanceId=?',[f.a.id]).n,1);
 }));

 it('uses an explicit manager-confirmed WhatsApp number instead of the calling phone and reviews ambiguous aliases',()=>fixture(async f=>{
  Identity.attach(f.a.id,f.chat,{kind:'whatsapp',value:'79990008822@c.us'});await enable(f);await call(f,'WhatsApp');await Queue.recover();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].recipient,'79990008822@c.us');assert.notEqual(f.sent[0].recipient,f.chat);
  Identity.attach(f.a.id,f.chat,{kind:'whatsapp',value:'79990008823@c.us'});await call(f,'WhatsApp',{callId:'ambiguous-wa'});await Queue.recover();
  assert.equal(f.sent.length,1);assert.equal(meta(draft(f)).autoDispatch.state,'needs_review');
 }));
 it('short channel selection sends after the call through the secondary WhatsApp alias, with full document conditions',()=>fixture(async f=>{
  Identity.attach(f.a.id,f.chat,{kind:'whatsapp',value:'79990008829@c.us'});await enable(f);
  const Local=require('../src/services/knowledge-local.service');
  const text='Инструкция по сборке прибора. '+('Устанавливайте устройство на сухой площадке. '.repeat(20))+'Гарантия действует при соблюдении правил монтажа.';
  const kb=DB.run("INSERT INTO knowledge_base(instanceId,filename,originalName,isCurrent) VALUES(?,?,?,1)",[f.a.id,'fixture-guide','fixture-guide']);
  DB.run('INSERT INTO kb_chunks(kbId,chunkIndex,text) VALUES(?,0,?)',[Number(kb.lastInsertRowid),text]);
  f.patch(Local,'catalogContext',()=>[]);f.patch(Local,'lookup',async()=>({answer:'Инструкция по сборке прибора.',provenance:'local_knowledge_extract',citations:[{source_id:Number(kb.lastInsertRowid)}]}));
  await call(f,'WhatsApp',{transcript:[{role:'user',content:'Нужна инструкция по сборке прибора.'},{role:'assistant',content:'Пришлём инструкцию. Вам удобнее WhatsApp или Telegram?'},{role:'user',content:'Ватсап.'}]});
  assert.equal(f.result.automatic_followup.queued,true);await Queue.recover();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].recipient,'79990008829@c.us');assert.ok(f.sent[0].text.endsWith('Гарантия действует при соблюдении правил монтажа.'));
 }));

 it('voice tool records an unapproved call request without claiming delivery, then post-call sends it once',()=>fixture(async f=>{
  Identity.attach(f.a.id,f.chat,{kind:'telegram',value:'780031'});await enable(f);
  const prepared=await Sales.draftFollowup({instanceId:f.a.id,chatId:f.chat,callId:'multichannel-call',channel:'telegram',text:'Проверенная информация'});
  const pending=await Sales.sendFollowup({instanceId:f.a.id,callId:'multichannel-call',draftId:prepared.draft_id,channel:'telegram',confirmed:true,voiceRequest:true});
  assert.equal(pending.sent,false);assert.equal(pending.status,'awaiting_call_completion');assert.equal(f.sent.length,0);
  await call(f,'Telegram',{transcript:[{role:'user',content:'Нужен электропастух.'},{role:'assistant',content:'Отправить цену в Telegram?'},{role:'user',content:'Да, пожалуйста.'}]});
  assert.equal(f.result.automatic_followup.queued,true);await Queue.recover();assert.equal(f.sent.length,1);assert.equal(draft(f).status,'sent');
  await Queue.recover();assert.equal(f.sent.length,1);
 }));

 it('customer summary exposes the confirmed channel choices without substituting the calling number',()=>fixture(async f=>{
  Identity.attach(f.a.id,f.chat,{kind:'whatsapp',value:'79990008828@c.us'});Identity.attach(f.a.id,f.chat,{kind:'telegram',value:'780032'});
  const summary=await Sales.customerSummary({instanceId:f.a.id,phone:f.phone});
  assert.ok(summary.available_channels.some(c=>c.channel==='telegram'));
  assert.ok(summary.spoken.includes('Подключённые каналы клиента:'));
  assert.ok(!summary.spoken.includes('79990008828'));
 }));

 it('a model-supplied draft id cannot send another customer’s approved text',()=>fixture(async f=>{
  const other='79990008840@c.us';await DB.getOrCreateClient(f.a.id,other,'Other card');
  const prepared=await Sales.draftFollowup({instanceId:f.a.id,chatId:other,callId:'other-call',channel:'whatsapp',text:'Other customer details'});
  DB.updateFollowupDraft(f.a.id,prepared.draft_id,{status:'approved'});
  const result=await Sales.sendFollowup({instanceId:f.a.id,phone:f.phone,callId:'current-call',draftId:prepared.draft_id,confirmed:true,voiceRequest:true});
  assert.equal(result.error,'draft_context_mismatch');assert.equal(f.sent.length,0);assert.equal(DB.getFollowupDraft(f.a.id,prepared.draft_id).status,'approved');
 }));

});
