'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Identity=require('../src/services/identity/identity-store');
const Flags=require('../src/services/ava-improvements-flags.service');
const Actions=require('../src/services/ava-autopilot.store');
const Control=require('../src/services/ava-workspace.store');
const Autopilot=require('../src/services/ava-autopilot.service');
const RAG=require('../src/services/rag.service');
const Gateway=require('../src/services/whatsapp-gateway.service');
const Router=require('../src/services/channel-router.service');
const Module=require('module');
const CHAT='79990000001@c.us';
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Context interleaving exceeded 5s')),5000);})]);}finally{clearTimeout(timer);}}
function setup(routing=false){
 createTestDB();Identity.ensureSchema();DB.createSalesWorkspaceTables();
 DB.run("INSERT INTO instances(id,name,isActive,whatsappProvider,greenApiInstance,greenApiToken) VALUES(1,'One',1,'green_api','fixture','fixture'),(2,'Two',1,'green_api','fixture','fixture')");
 for(const [id,role] of [['owner','hotel_owner'],['manager','manager']]){DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)',[id,id+'@example.test',id]);DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,1,?)',[id,role]);}
 DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,?,'One',?),(1,'other-chat','Other',NULL),(2,?,'Foreign',NULL)",[CHAT,routing?null:'manager',CHAT]);
 Control.ensureSchema();Actions.ensureSchema();
 DB.run("INSERT INTO knowledge_base(instanceId,filename,originalName) VALUES(1,'fixture.txt','fixture.txt')");
 const owner=Identity.actor('owner'),policy=Autopilot.updatePolicy(owner,1,{revision:0,enabled:true,routing:{enabled:routing,memberIds:routing?['manager']:[]}}).policy;
 const sim=Autopilot.simulations(owner,1,{revision:policy.revision}).simulation;Autopilot.publish(owner,1,{revision:policy.revision,simulationId:sim.id});
 return {owner,knowledge:{answer:'Монтаж включён.',citations:[{document_id:DB.get('SELECT id FROM knowledge_base WHERE instanceId=1').id}]}};
}
async function incoming(text='Как работает монтаж?',businessId=1,chat=CHAT){const row=await DB.saveMessageWithChannel(businessId,chat,'Client',text,'user','whatsapp');return {businessId,chatId:chat,text,eventId:'message:'+row.id};}
async function fixture(fn){
 const originalLoad=Module._load,originalRAG=RAG.answerFromKnowledge,originalSend=Gateway.sendMessage;
 const originalAllowlist=process.env.AVA_IMPROVEMENTS_BUSINESSES;
 const revisions=new Map();let calls=0;
 process.env.AVA_IMPROVEMENTS_BUSINESSES='1';
 // Section 1 owns trigger implementation. This fixture exercises the consumer
 // against that helper's exact synchronous revision interface.
 Module._load=function(request,...args){if(request==='./ava-collaboration.service')return {dialogueRevision:(b,chat)=>{
  const row=DB.get('SELECT assigneeUserId FROM clients WHERE instanceId=? AND chatId=?',[b,chat]);
  return String(revisions.get(b+':'+chat)||1)+':'+(row?.assigneeUserId||'queue');
 }};return originalLoad.call(this,request,...args);};
 Gateway.sendMessage=async(_instance,_recipient,_text,context)=>{if(context?.beforeSend)await context.beforeSend();calls++;return {success:true,data:{idMessage:'fixture-ack-'+calls}};};
 try{await fn({calls:()=>calls,bump:(b=1,chat=CHAT)=>revisions.set(b+':'+chat,(revisions.get(b+':'+chat)||1)+1)});}
 finally{Module._load=originalLoad;RAG.answerFromKnowledge=originalRAG;Gateway.sendMessage=originalSend;if(originalAllowlist===undefined)delete process.env.AVA_IMPROVEMENTS_BUSINESSES;else process.env.AVA_IMPROVEMENTS_BUSINESSES=originalAllowlist;}
}
async function delayedKnowledge(a,mutate){const entered=deferred(),release=deferred();RAG.answerFromKnowledge=()=>{entered.resolve();return bounded(release.promise);};const pending=Autopilot.handleInbound(await incoming());try{await bounded(entered.promise);await mutate();release.resolve(a.knowledge);return await bounded(pending);}finally{release.resolve(a.knowledge);await pending;}}
describe('Autopilot consumes live collaboration context before external effects',()=>{
 it('blocks awaited AI after newer inbound and retains a durable blocked action without provider invocation',()=>fixture(async f=>{
  const a=setup();const result=await delayedKnowledge(a,async()=>{await incoming('Новый вопрос');f.bump();});
  assert.strictEqual(result.action.status,'blocked');assert.strictEqual(result.reason,'WORKSPACE_DIALOGUE_CHANGED');assert.strictEqual(f.calls(),0);assert.strictEqual(Control.getControl(1,CHAT).sendInProgress,undefined);
  assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='assistant'").n,0);
 }));
 it('keeps feature-off legacy handling of newer inbound compatible',()=>fixture(async f=>{
  const a=setup();Flags.update(a.owner,1,{revision:0,flags:{collaboration:false}});
  const result=await delayedKnowledge(a,async()=>{await incoming('Новый вопрос');f.bump();});assert.strictEqual(result.status,'sent');assert.strictEqual(f.calls(),1);
 }));
 it('blocks an old persisted event even when the current revision is first captured after newer inbound',()=>fixture(async f=>{
  const a=setup();RAG.answerFromKnowledge=async()=>a.knowledge;const old=await incoming();await incoming('Already newer');f.bump();
  const result=await Autopilot.handleInbound(old);assert.strictEqual(result.action.status,'blocked');assert.strictEqual(result.reason,'WORKSPACE_DIALOGUE_CHANGED');assert.strictEqual(f.calls(),0);
 }));
 it('does not turn an outdated unavailable-knowledge result into a human handoff or task',()=>fixture(async f=>{
  const a=setup();a.knowledge={answer:'',citations:[],requires_manager:true};
  const result=await delayedKnowledge(a,async()=>{await incoming('Changed');f.bump();});
  assert.strictEqual(result.action.status,'blocked');assert.strictEqual(Control.getControl(1,CHAT).mode,'ai');assert.strictEqual(DB.get('SELECT COUNT(*) n FROM manager_tasks').n,0);assert.strictEqual(f.calls(),0);
 }));
 it('invalidates an answer on a new same-client voice context during generation',()=>fixture(async f=>{
  const a=setup();const result=await delayedKnowledge(a,()=>{DB.createConversationEvent({instanceId:1,chatId:CHAT,eventId:'new-call',callId:'call',channel:'voice',content:'Updated call context'});f.bump();});
  assert.strictEqual(result.action.status,'blocked');assert.strictEqual(f.calls(),0);
 }));
 it('does not invalidate preparation for another client or business',()=>fixture(async f=>{
  const a=setup();const result=await delayedKnowledge(a,async()=>{await incoming('Other',1,'other-chat');f.bump(1,'other-chat');await incoming('Foreign',2);f.bump(2);});
  assert.strictEqual(result.status,'sent');assert.strictEqual(f.calls(),1);
 }));
 it('recaptures only its own atomic assignment so a new unassigned customer still receives an answer',()=>fixture(async f=>{
  const a=setup(true);RAG.answerFromKnowledge=async()=>a.knowledge;
  const result=await Autopilot.handleInbound(await incoming());assert.strictEqual(result.status,'sent');assert.strictEqual(f.calls(),1);
  assert.strictEqual(DB.get('SELECT assigneeUserId FROM clients WHERE instanceId=1 AND chatId=?',[CHAT]).assigneeUserId,'manager');
 }));
 it('does not swallow a changed revision committed together with the preparation claim',()=>fixture(async f=>{
  setup(true);const claim=Actions.claim;Actions.claim=function(input){const result=claim(input);f.bump();return result;};
  try{const result=await Autopilot.handleInbound(await incoming());assert.strictEqual(result.action.status,'blocked');assert.strictEqual(f.calls(),0);assert.strictEqual(DB.get('SELECT assigneeUserId FROM clients WHERE instanceId=1 AND chatId=?',[CHAT]).assigneeUserId,null);}finally{Actions.claim=claim;}
 }));
 it('rechecks in final send transaction after post-generation provider preparation',()=>fixture(async f=>{
  const a=setup();RAG.answerFromKnowledge=async()=>a.knowledge;
  const getInstance=DB.getInstance,entered=deferred(),release=deferred();DB.getInstance=async function(...args){entered.resolve();await bounded(release.promise);return getInstance.apply(this,args);};
  const pending=Autopilot.handleInbound(await incoming());try{await bounded(entered.promise);await incoming('Changed after AI');f.bump();release.resolve();const result=await bounded(pending);assert.strictEqual(result.action.status,'blocked');assert.strictEqual(f.calls(),0);}finally{release.resolve();await pending;DB.getInstance=getInstance;}
 }));
 it('blocks preparation started while collaboration was off if the feature becomes active before dispatch',()=>fixture(async f=>{
  const a=setup();Flags.update(a.owner,1,{revision:0,flags:{collaboration:false}});
  const result=await delayedKnowledge(a,()=>{Flags.update(a.owner,1,{revision:1,flags:{collaboration:true}});f.bump();});
  assert.strictEqual(result.action.status,'blocked');assert.strictEqual(f.calls(),0);
 }));
 it('checks real router beforeSend for quote sends after awaited provider state',()=>fixture(async f=>{
  const a=setup();let offer=Autopilot.createOffer(a.owner,1,{name:'Услуга',amountMinor:100}).offer;offer=Autopilot.publishCatalog(a.owner,1,offer.id,{revision:offer.revision}).offer;
  const quote=Autopilot.createQuote(a.owner,1,{chatId:CHAT,offerId:offer.id,quantity:1}).quote;
  const state=Router._getWhatsAppState,entered=deferred(),release=deferred();Router._getWhatsAppState=()=>{entered.resolve();return bounded(release.promise);};
  const pending=Autopilot.sendQuote(a.owner,1,quote.id,{idempotencyKey:'quote-context'});
  try{await bounded(entered.promise);await incoming('Changed quote context');f.bump();release.resolve({success:true,state:'authorized'});const result=await bounded(pending);assert.strictEqual(result.quote.status,'failed');assert.strictEqual(f.calls(),0);assert.strictEqual(Control.getControl(1,CHAT).sendInProgress,undefined);}finally{release.resolve({success:true,state:'authorized'});await pending;Router._getWhatsAppState=state;}
 }));
});
