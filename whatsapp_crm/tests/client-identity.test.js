'use strict';
const assert=require('node:assert/strict');
const {createTestDB,describe,it}=require('./test-helper');
const DB=require('../src/services/database.service');
const identity=require('../src/services/client-identity.service');
describe('Confirmed client identity linking',()=> {
it('preserves merged history, context and natural-origin ingress dedup within one business',async()=> {
 createTestDB(); const a=await DB.createInstance({name:'A'}),b=await DB.createInstance({name:'B'});
 const call=await DB.getOrCreateClient(a.id,'79990000001@c.us','Caller');
 const tg=await DB.getOrCreateClient(a.id,'tg_123456','Telegram');
 await DB.saveMessageWithChannel(a.id,tg.chatId,'Telegram','source history','user','telegram',null,'same-id');
 await DB.saveMessageWithChannel(a.id,call.chatId,'Caller','main history','user','telegram',null,'same-id');
 DB.run("INSERT INTO manager_tasks(taskId,instanceId,chatId,customerId,summary) VALUES('task',?,?,?,'follow up')",[a.id,tg.chatId,`crm_${a.id}_${tg.id}`]);
 DB.run("INSERT INTO followup_drafts(draftId,instanceId,chatId,customerId,text) VALUES('draft',?,?,?,'durable text')",[a.id,tg.chatId,`crm_${a.id}_${tg.id}`]);
 await DB.upsertClientProfile(a.id,call.chatId,{needs:'main needs',interests:['main']});
 await DB.upsertClientProfile(a.id,tg.chatId,{needs:'source needs',interests:['source']});
 assert.throws(()=>identity.attach(a.id,call.chatId,{kind:'telegram',value:'123456'}),e=>e.code==='ALIAS_CONFLICT');
 identity.attach(a.id,call.chatId,{kind:'telegram',value:'123456',mergeChatId:tg.chatId,confirmMerge:true});
 identity.attach(a.id,call.chatId,{kind:'whatsapp',value:'79990000002@s.whatsapp.net'});
 identity.attach(a.id,call.chatId,{kind:'phone',value:'+7 (999) 000-00-03'});
 assert.equal((await DB.getOrCreateClient(a.id,'tg_123456','x')).id,call.id);
 assert.equal((await DB.getOrCreateClient(a.id,'79990000002@c.us','x')).id,call.id);
 assert.equal((await DB.getOrCreateClient(a.id,'79990000003@c.us','Phone alias WA')).id,call.id);
 assert.equal((await DB.getClientByTelegram(a.id,'123456')).id,call.id);
 assert.equal((await DB.getMessages(a.id,tg.chatId)).length,2);
 // Re-run startup migration with colliding provider IDs across merged origins.
 DB.ensureColumns();
 assert.equal((await DB.getMessages(a.id,tg.chatId)).length,2);
 assert.equal(DB.get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_source_message'"),undefined);
 assert.equal((await DB.saveMessageWithChannel(a.id,tg.chatId,'Telegram','replay','user','telegram',null,'same-id')).inserted,false);
 assert.equal(DB.get("SELECT chatId FROM manager_tasks WHERE taskId='task'").chatId,call.chatId);
 assert.equal(DB.get("SELECT customerId FROM followup_drafts WHERE draftId='draft'").customerId,`crm_${a.id}_${call.id}`);
 const profile=await DB.getClientProfile(a.id,call.chatId);
 assert.ok(profile.needs.includes('source needs'));
 assert.ok(profile.needs.includes('main needs'));
 assert.equal(await DB.getClientCount(a.id),1);
 assert.equal(DB.getIdentityLinkByPhone(a.id,'+79990000003').chatId,call.chatId);
 assert.throws(()=>identity.attach(b.id,call.chatId,{kind:'telegram',value:'123456'}),e=>e.code==='CLIENT_NOT_FOUND');
 const other=await DB.getOrCreateClient(a.id,'tg_654321','other');
 assert.throws(()=>identity.attach(a.id,other.chatId,{kind:'telegram',value:'123456'}),e=>e.code==='ALIAS_CONFLICT');
 const aliases=identity.list(a.id,call.chatId).aliases;
 identity.unlink(a.id,call.chatId,aliases.find(x=>x.kind==='whatsapp' && x.id).id);
 assert.equal(identity.resolve(a.id,'79990000002@c.us'),'79990000002@c.us');
 await DB.upsertClientProfile(a.id,tg.chatId,{budget:'alias update'});
 assert.equal((await DB.getClientProfile(a.id,call.chatId)).budget,'alias update');
 const event=DB.createConversationEvent({instanceId:a.id,chatId:tg.chatId,sourceId:'alias-event',content:'history'});
 assert.equal(event.chatId,call.chatId);
 assert.ok(DB.getConversationEvents(a.id,tg.chatId).some(e=>e.eventId===event.eventId));
 const telegram=require('../src/services/telegram.service');
 const original=telegram.batcher.enqueue;
 let queued=0;telegram.batcher.enqueue=()=>{queued++;return {delayMs:0,pendingCount:1};};
 const message={chat:{id:123456},from:{first_name:'Fixture'},text:'replay fixture',message_id:991};
 try {
  await telegram._handleMessage(a.id,message); await telegram._handleMessage(a.id,message);
  assert.equal(queued,1);
  // Telegram IDs are chat-local: dedupe is canonical customer + natural
  // origin, while the durable job retains the exact provider ID separately.
  assert.equal(DB.get("SELECT COUNT(*) AS count FROM messages WHERE instanceId=? AND chatId=? AND originChatId=? AND sourceMessageId=?",
   [a.id,call.chatId,tg.chatId,`${tg.chatId}:991`]).count,1);
  const job=DB.get("SELECT * FROM channel_inbound_jobs WHERE instanceId=? AND chatId=? AND originChatId=? AND providerMessageId='991'",
   [a.id,call.chatId,tg.chatId]);
  assert.ok(job); assert.equal(job.channel,'telegram'); assert.equal(job.status,'queued');
  assert.equal(DB.get('SELECT originChatId FROM messages WHERE id=?',[job.inboundMessageId]).originChatId,tg.chatId);
  identity.attach(a.id,call.chatId,{kind:'telegram',value:'123457'});
  const secondOrigin={...message,chat:{id:123457},text:'different confirmed origin'};
  await telegram._handleMessage(a.id,secondOrigin); await telegram._handleMessage(a.id,secondOrigin);
  assert.equal(queued,2);
  assert.equal(DB.get("SELECT COUNT(*) AS count FROM channel_inbound_jobs WHERE instanceId=? AND chatId=? AND providerMessageId='991'",
   [a.id,call.chatId]).count,2);
  assert.equal(DB.get("SELECT COUNT(*) AS count FROM messages WHERE instanceId=? AND chatId=? AND originChatId='tg_123457' AND sourceMessageId='tg_123457:991'",
   [a.id,call.chatId]).count,1);
 }
 finally {telegram.batcher.enqueue=original;}
 assert.equal(await DB.getClientCount(a.id),2); // main + intentionally unrelated card
 });
});
