'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Identity=require('../src/services/identity/identity-store');
const Auto=require('../src/services/ava-autopilot.service');
const Store=require('../src/services/ava-autopilot.store');
const Workspace=require('../src/services/ava-workspace.store');
const Release=require('../src/services/ava-release-flags.service');
const Sales=require('../src/services/sales-brain.service');
const Router=require('../src/services/channel-router.service');
const chat='79990000000@c.us',otherChat='79990000001@c.us';
function setup(){
 createTestDB();Identity.ensureSchema();DB.createSalesWorkspaceTables();
 DB.run("INSERT INTO instances(id,name,isActive) VALUES(1,'One',1),(2,'Two',1)");
 for(const [id,role,b] of [['owner','hotel_owner',1],['manager','manager',1],['other','hotel_owner',2]]){
  DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)',[id,id+'@example.test',id]);
  DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)',[id,b,role]);
 }
 for(const [b,c] of [[1,chat],[1,otherChat],[2,chat]])DB.run('INSERT INTO clients(instanceId,chatId,senderName,leadStatus) VALUES(?,?,?,?)',[b,c,'Guest','new']);
 Store.ensureSchema();Workspace.ensureSchema();Release.ensureSchema();
 return {owner:Identity.actor('owner'),manager:Identity.actor('manager'),other:Identity.actor('other')};
}
function enable(a,extra={},b=1){const owner=b===1?a.owner:a.other;const p=Auto.updatePolicy(owner,b,{revision:Store.policy(b)?.revision||0,enabled:true,...extra}).policy;const sim=Auto.simulations(owner,b,{revision:p.revision}).simulation;return Auto.publish(owner,b,{revision:p.revision,simulationId:sim.id}).policy;}
function admit(callId='call',c=chat,b=1){assert.strictEqual(Auto.voiceAllowance(b,c,{callId}).allowed,true);}
const note=(callId='call',extra={})=>Sales.createCrmNote({instanceId:1,chatId:chat,callId,note:'Клиент просит монтаж',...extra});
const stage=(callId='call',extra={})=>Sales.updateStage({instanceId:1,chatId:chat,callId,stage:'qualified',reason:'Клиент подтвердил потребность',...extra});
const post=(callId='call',extra={})=>Sales.postCall({instanceId:1,chatId:chat,callId,transcript:[{role:'user',text:'Мне нужен монтаж, бюджет 1000 рублей.'}],duration_sec:25,outcome:'completed',...extra});
async function preparedDraft(actor='owner'){
 const draft=await Sales.draftWhatsAppFollowup({instanceId:1,chatId:chat,callId:'draft-call',text:'Перезвоню завтра в 14:00.'});
 assert.strictEqual(Sales.claimFollowupDraft({instanceId:1,draftId:draft.draft_id,actor}).success,true);
 DB.updateFollowupDraft(1,draft.draft_id,{status:'approved',approvedBy:actor,approvedAt:new Date().toISOString()});
 return draft.draft_id;
}
async function stubRouter(fn,run){const original=Router.sendMessageDetailed;Router.sendMessageDetailed=fn;try{return await run();}finally{Router.sendMessageDetailed=original;}}
describe('AVA server-side native CRM writes and follow-up control fences',()=>{
 it('requires published update_fields for both native tools and post-call inference while retaining actual call evidence',async()=>{
  const a=setup();enable(a,{allowedActions:['reply','handoff']});admit();
  assert.strictEqual((await note()).error,'AUTOPILOT_ACTION_NOT_ALLOWED');assert.strictEqual((await stage()).error,'AUTOPILOT_ACTION_NOT_ALLOWED');
  const result=await post('call',{tool_runs:[{name:'actual_tool',result:{accepted:true}}]});
  assert.strictEqual(result.success,true);assert.strictEqual(result.inference_write.reason,'AUTOPILOT_ACTION_NOT_ALLOWED');
  assert.ok(DB.getConversationEventBySource(1,'post_call:call'));
  assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM tool_runs WHERE toolName=?',['actual_tool']).n,1);
  assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM client_profiles').n,0);
  assert.strictEqual(DB.get('SELECT leadStatus FROM clients WHERE instanceId=1 AND chatId=?',[chat]).leadStatus,'new');
  assert.ok(Store.actions(1).every(a=>a.kind==='crm_write'&&a.status==='blocked'&&a.sourceCallId==='call'&&a.policyRevision===1));
 });
 it('keeps real call/transcript evidence after human takeover, suppresses native notes and inferred customer mutations',async()=>{
  const a=setup();enable(a,{routing:{enabled:true,memberIds:['owner']}});admit();Workspace.setControl({businessId:1,chatId:chat,mode:'human',reason:'Менеджер подключился'});
  assert.strictEqual((await note()).error,'WORKSPACE_HUMAN_CONTROL');assert.strictEqual((await stage()).error,'WORKSPACE_HUMAN_CONTROL');
  const result=await post();assert.strictEqual(result.inference_write.reason,'WORKSPACE_HUMAN_CONTROL');
  assert.ok(DB.getConversationEventBySource(1,'post_call:call'));assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM client_profiles').n,0);
  assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM lead_status_history').n,0);
  assert.strictEqual(Workspace.getControl(1,chat).mode,'human');
  assert.strictEqual(DB.get('SELECT assigneeUserId FROM clients WHERE instanceId=1 AND chatId=?',[chat]).assigneeUserId,null);
 });
 it('preserves legacy post-call extraction before opt-in and prevents repetition after callback replay',async()=>{
  setup();const first=await post('legacy');assert.strictEqual(first.inference_write.applied,true);
  const raw=JSON.parse((await DB.getClientProfile(1,chat)).rawProfileJson);assert.ok(raw.lastCallAt);
  const count=DB.get('SELECT COUNT(*) AS n FROM lead_status_history').n;
  const second=await post('legacy');assert.strictEqual(second.idempotent,true);
  assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM lead_status_history').n,count);
  assert.strictEqual(Store.actions(1).filter(x=>x.operation==='post_call_inference').length,1);
 });
 it('requires exact live admission for business, canonical customer and call ID; request phase cannot bypass it',async()=>{
  const a=setup();enable(a);enable(a,{},2);admit();
  assert.strictEqual((await note('not-admitted')).error,'AUTOPILOT_VOICE_ADMISSION_REQUIRED');
  assert.strictEqual((await note('call',{chatId:otherChat})).error,'AUTOPILOT_VOICE_ADMISSION_INVALID');
  assert.strictEqual((await note('call',{instanceId:2})).error,'AUTOPILOT_VOICE_ADMISSION_REQUIRED');
  assert.strictEqual((await note(null,{phase:'post_call',summary_provenance:'provided_summary'})).error,'AUTOPILOT_VOICE_ADMISSION_REQUIRED');
  assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM conversation_events').n,0);
 });
 it('commits one policy-linked result for each repeated native tool and counts only executed CRM actions',async()=>{
  const a=setup();enable(a);admit();const first=await note(),again=await note();
  assert.strictEqual(first.success,true);assert.strictEqual(again.idempotent,true);assert.strictEqual(first.event_id,again.event_id);
  assert.strictEqual((await stage()).success,true);assert.strictEqual((await stage()).idempotent,true);
  assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM lead_status_history').n,1);
  assert.strictEqual(Store.usage(1).actions,2);assert.strictEqual(Store.usage(1).tokens,0);
  for(const action of Store.actions(1)){assert.strictEqual(action.policyRevision,1);assert.strictEqual(action.sourceCallId,'call');assert.strictEqual(action.status,'done');assert.strictEqual(action.result.success,true);}
 });
 it('rechecks permissions and human control after asynchronous stage preparation',async()=>{
  const a=setup();enable(a);admit();const original=DB.getInstance;
  DB.getInstance=async(id)=>{const instance=await original.call(DB,id);Workspace.setControl({businessId:1,chatId:chat,mode:'human'});return instance;};
  try{assert.strictEqual((await stage()).error,'WORKSPACE_HUMAN_CONTROL');}finally{DB.getInstance=original;}
  assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM lead_status_history').n,0);
 });
 it('denies paused policy, revoked owner, changed policy revision and out-of-hours writes',async()=>{
  for(const [alter,expected] of [
   [(a)=>Auto.pause(a.owner,1),'AUTOPILOT_POLICY_INACTIVE'],
   [()=>DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='owner'"),'AUTOPILOT_OWNER_INACTIVE'],
   [(a)=>enable(a,{}),'AUTOPILOT_VOICE_ADMISSION_INVALID'],
   [(a)=>{const day={Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6,Sun:7}[new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Moscow',weekday:'short'}).format(new Date())];enable(a,{workDays:[day===7?1:day+1]});},'AUTOPILOT_OUTSIDE_HOURS']]){
    const a=setup();enable(a);admit();alter(a);assert.strictEqual((await stage()).error,expected);assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM lead_status_history').n,0);
  }
 });
 it('allows ended admission only for real post-call inference and refuses forged or cross-business source events',async()=>{
  const a=setup();enable(a);admit();const result=await post();assert.strictEqual(result.inference_write.applied,true);
  assert.strictEqual((await note()).error,'AUTOPILOT_VOICE_ADMISSION_INVALID');
  let calls=0;const forged=Auto.runVoiceMutation({businessId:1,chatId:chat,callId:'different',operation:'post_call_inference',postCall:true,sourceEventId:result.crm_note.event_id},()=>{calls++;return {success:true};});
  assert.strictEqual(forged.applied,false);assert.strictEqual(calls,0);
  Workspace.setControl({businessId:1,chatId:chat,mode:'ai'});
  setup();DB.createConversationEvent({instanceId:2,chatId:chat,callId:'foreign',eventId:'foreign-event',channel:'voice',sourceId:'post_call:foreign'});
  const foreign=Auto.runVoiceMutation({businessId:1,chatId:chat,callId:'foreign',operation:'post_call_inference',postCall:true,sourceEventId:'foreign-event'},()=>{calls++;return {success:true};});
  assert.strictEqual(foreign.reason,'AUTOPILOT_SOURCE_INVALID');assert.strictEqual(calls,0);
 });
 it('rolls back all inferred field changes on a synchronous write failure and journals the failure without discarding the call',async()=>{
  const a=setup();enable(a);admit();const original=DB.upsertClientProfileSync;DB.upsertClientProfileSync=()=>{throw new Error('Injected profile failure');};
  let result;try{result=await post();}finally{DB.upsertClientProfileSync=original;}
  assert.strictEqual(result.success,true);assert.strictEqual(result.inference_write.reason,'AUTOPILOT_CRM_WRITE_FAILED');
  assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM lead_status_history').n,0);assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM client_profiles').n,0);
  assert.strictEqual(DB.get('SELECT leadStatus FROM clients WHERE instanceId=1 AND chatId=?',[chat]).leadStatus,'new');
  assert.ok(DB.getConversationEventBySource(1,'post_call:call'));assert.strictEqual(result.inference_write.action.status,'failed');
 });
 it('disables actual native writes, inbound dispatch and publication per business while retaining owner recovery controls',async()=>{
  const a=setup();enable(a);admit();Release.update(a.owner,1,{revision:0,flags:{autopilot:false}});
  assert.strictEqual((await note()).error,'AVA_FEATURE_DISABLED');assert.strictEqual(Auto.voiceAllowance(1,chat,{callId:'call',voicePhase:'active'}).reason,'AVA_FEATURE_DISABLED');
  const source=await DB.saveMessageWithChannel(1,chat,'Guest','Привет','user','whatsapp');
  assert.strictEqual((await Auto.handleInbound({businessId:1,chatId:chat,eventId:'message:'+source.id,text:'Привет'})).reason,'AVA_FEATURE_DISABLED');
  const p=Auto.updatePolicy(a.owner,1,{revision:1,enabled:true}).policy,sim=Auto.simulations(a.owner,1,{revision:p.revision}).simulation;
  assert.throws(()=>Auto.publish(a.owner,1,{revision:p.revision,simulationId:sim.id}),e=>e.code==='AVA_FEATURE_DISABLED');
  Release.update(a.owner,1,{revision:1,flags:{autopilot:true}});Auto.publish(a.owner,1,{revision:p.revision,simulationId:sim.id});
  assert.strictEqual(Auto.voiceAllowance(1,chat,{callId:'recovered'}).allowed,true);assert.strictEqual((await note('recovered')).success,true);
 });
 it('authenticates manual follow-up, switches to human control and holds the shared send fence through uncertain ACK',async()=>{
  const a=setup();enable(a);const draftId=await preparedDraft();let calls=0;
  await stubRouter(async(_b,_c,_t,_channel,context)=>{context.beforeSend();calls++;assert.strictEqual(Workspace.getControl(1,chat).mode,'human');assert.throws(()=>Workspace.beginAiSend({businessId:1,chatId:chat,sendId:'parallel'}),e=>e.code==='WORKSPACE_HUMAN_CONTROL');return {success:true,pending:true};},async()=>{
   const first=await Sales.sendWhatsAppFollowup({instanceId:1,chatId:chat,draftId,confirmed:true,actor:a.owner});assert.strictEqual(first.status,'pending');
   assert.strictEqual(Workspace.getControl(1,chat).sendStatus,'unknown');
   await Sales.sendWhatsAppFollowup({instanceId:1,chatId:chat,draftId,confirmed:true,actor:a.owner});assert.strictEqual(calls,1);
   assert.throws(()=>Workspace.setControl({businessId:1,chatId:chat,mode:'ai'}),e=>e.code==='WORKSPACE_SEND_IN_PROGRESS');
  });
 });
 it('blocks manual follow-up when AI already owns the slot and rechecks live actor at the provider boundary',async()=>{
  const a=setup(),draftId=await preparedDraft();Workspace.beginAiSend({businessId:1,chatId:chat,sendId:'active-ai'});
  let calls=0;await stubRouter(async()=>{calls++;return {success:true};},async()=>{const r=await Sales.sendWhatsAppFollowup({instanceId:1,chatId:chat,draftId,confirmed:true,actor:a.owner});assert.strictEqual(r.error,'WORKSPACE_SEND_IN_PROGRESS');assert.strictEqual(calls,0);});
  Workspace.endAiSend({businessId:1,chatId:chat,sendId:'active-ai',status:'sent'});
  await stubRouter(async(_b,_c,_t,_channel,context)=>{DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='owner'");context.beforeSend();calls++;return {success:true};},async()=>{
   const r=await Sales.sendWhatsAppFollowup({instanceId:1,chatId:chat,draftId,confirmed:true,actor:a.owner});assert.strictEqual(r.sent,false);assert.strictEqual(calls,0);assert.strictEqual(Boolean(Workspace.getControl(1,chat).sendInProgress),false);
  });
 });
 it('treats missing WhatsApp provider acknowledgement as unknown and retains the shared fence',async()=>{
  const a=setup(),draftId=await preparedDraft();let calls=0;
  await stubRouter(async(_b,_c,_t,_channel,context)=>{context.beforeSend();calls++;return {success:true,channel:'whatsapp'};},async()=>{
   const result=await Sales.sendWhatsAppFollowup({instanceId:1,chatId:chat,draftId,confirmed:true,actor:a.owner});
   assert.strictEqual(result.status,'pending');assert.strictEqual(Workspace.getControl(1,chat).sendStatus,'unknown');
   await Sales.sendWhatsAppFollowup({instanceId:1,chatId:chat,draftId,confirmed:true,actor:a.owner});assert.strictEqual(calls,1);
  });
 });
 it('holds the manual shared slot for direct Telegram and saves exact human authorship after an acknowledged send',async()=>{
  const a=setup(),draftId=await preparedDraft();DB.run('UPDATE instances SET telegramBotToken=? WHERE id=1',['test-token']);DB.run('UPDATE clients SET telegramChatId=? WHERE instanceId=1 AND chatId=?',['123456789',chat]);
  DB.updateFollowupDraft(1,draftId,{metadata:{channel:'telegram',recipient:'123456789'}});
  const Telegram=require('../src/services/telegram.service'),original=Telegram.sendMessageDetailed;
  let started,finish;const waiting=new Promise(r=>started=r);Telegram.sendMessageDetailed=async(b,recipient,_text,context)=>{context.beforeSend();assert.strictEqual(b,1);assert.strictEqual(recipient,'123456789');started();return new Promise(r=>finish=r);};
  try {
   const task=Sales.sendWhatsAppFollowup({instanceId:1,chatId:chat,draftId,confirmed:true,actor:a.owner});await waiting;
   assert.strictEqual(Workspace.getControl(1,chat).sendInProgress,true);assert.throws(()=>Workspace.setControl({businessId:1,chatId:chat,mode:'ai'}),e=>e.code==='WORKSPACE_SEND_IN_PROGRESS');
   finish({success:true,channel:'telegram',provider_message_id:'telegram-ack'});const result=await task;assert.strictEqual(result.sent,true);assert.strictEqual(Boolean(Workspace.getControl(1,chat).sendInProgress),false);
   const saved=DB.get('SELECT * FROM messages WHERE instanceId=1 AND chatId=? AND channel=?',[chat,'telegram']);assert.ok(saved);
   assert.strictEqual(DB.get('SELECT userId FROM ava_workspace_message_authorship WHERE messageId=?',[saved.id]).userId,'owner');
   assert.strictEqual(Workspace.promises(1,chat).length,1);
  } finally {Telegram.sendMessageDetailed=original;}
 });
 it('denies raw autonomous follow-up after activation and honors human mode for legacy auto-send',async()=>{
  const a=setup();enable(a);const draftId=await preparedDraft();let calls=0;
  await stubRouter(async()=>{calls++;return {success:true};},async()=>{assert.strictEqual((await Sales.sendWhatsAppFollowup({instanceId:1,chatId:chat,draftId,confirmed:true})).error,'AUTOPILOT_ACTION_NOT_ALLOWED');assert.strictEqual(calls,0);});
  setup();const draft=await preparedDraft();Workspace.setControl({businessId:1,chatId:chat,mode:'human'});
  await stubRouter(async()=>{calls++;return {success:true};},async()=>{assert.strictEqual((await Sales.sendWhatsAppFollowup({instanceId:1,chatId:chat,draftId:draft,confirmed:true})).error,'WORKSPACE_HUMAN_CONTROL');assert.strictEqual(calls,0);});
 });
});
