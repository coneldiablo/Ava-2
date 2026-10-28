'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Settings=require('../src/services/whatsapp-response-settings.service');
const WhatsApp=require('../src/services/whatsapp.service');
const OpenWA=require('../src/services/openwa.service');
const axios=require('axios');
async function fixture(fn){createTestDB();WhatsApp.batcher.clearAll();const created=await DB.createInstance({name:'Presence fixture'});
 await DB.updateInstance(created.id,{isActive:1,openWaSessionId:'fixture-session'});const instance=await DB.getInstance(created.id);
 const original=OpenWA.sendChatState,calls=[];OpenWA.sendChatState=async(...args)=>{calls.push(args);return true;};
 try{await fn({instance,calls});}finally{OpenWA.sendChatState=original;WhatsApp.batcher.clearAll();}}
describe('Optional real OpenWA presence',()=>{
 it('migrates the existing settings table without changing saved delay or revision',()=>fixture(async({instance})=>{
  DB.db.exec('CREATE TABLE whatsapp_response_settings(businessId INTEGER PRIMARY KEY,delaySeconds INTEGER NOT NULL,revision INTEGER NOT NULL,updatedAt INTEGER NOT NULL)');
  DB.run('INSERT INTO whatsapp_response_settings VALUES(?,45,7,1)',[instance.id]);
  assert.deepEqual(Settings.get(instance.id),{delaySeconds:45,revision:7,maxDelaySeconds:300});
  assert.equal(DB.get('SELECT typingEnabled FROM whatsapp_response_settings').typingEnabled,0);
  assert.equal(Settings.save(instance.id,{delaySeconds:45,revision:7,typingEnabled:true}).typingEnabled,true);
 }));
 it('is disabled by default, scoped, revisioned and preserves the choice in legacy delay-only updates',()=>fixture(async({instance,calls})=>{
  await (await WhatsApp._startTyping(instance,'79990000001@c.us',{isStale:()=>false}))();assert.equal(calls.length,0);
  const on=Settings.save(instance.id,{delaySeconds:10,revision:0,typingEnabled:true});assert.equal(on.typingEnabled,true);
  assert.equal(Settings.save(instance.id,{delaySeconds:15,revision:1}).typingEnabled,true);
  assert.throws(()=>Settings.save(instance.id,{delaySeconds:0,revision:2,typingEnabled:'true'}),e=>e.code==='WHATSAPP_RESPONSE_SETTINGS_INVALID');
  const other=await DB.createInstance({name:'Other'});assert.equal(Settings.get(other.id).typingEnabled,undefined);
  assert.equal(Settings.save(instance.id,{delaySeconds:0,revision:2,typingEnabled:false}).typingEnabled,undefined);
 }));
 it('sends one typing and one paused indicator, with no replay or timer loop',()=>fixture(async({instance,calls})=>{
  Settings.save(instance.id,{delaySeconds:0,revision:0,typingEnabled:true});
  const stop=await WhatsApp._startTyping(instance,'79990000001@c.us',{isStale:()=>false});assert.equal(calls.length,1);
  await stop();assert.deepEqual(calls.map(c=>c[4]),['typing','paused']);
 }));
 it('does not signal for canceled work or a Green API channel and does not touch a replaced session',()=>fixture(async({instance,calls})=>{
  Settings.save(instance.id,{delaySeconds:0,revision:0,typingEnabled:true});
  await (await WhatsApp._startTyping(instance,'79990000001@c.us',{isStale:()=>true}))();
  await (await WhatsApp._startTyping({...instance,whatsappProvider:'green_api'},'79990000001@c.us',{isStale:()=>false}))();assert.equal(calls.length,0);
  const stop=await WhatsApp._startTyping(instance,'79990000001@c.us',{isStale:()=>false});
  await DB.updateInstance(instance.id,{openWaSessionId:'replacement'});await stop();assert.equal(calls.length,1);
 }));
 it('uses the installed DTO/route and contains errors without retries or redirects',async()=>{
  const original=axios.post;let calls=0;
  axios.post=async(url,payload,options)=>{calls++;assert.ok(url.endsWith('/api/sessions/fixture-session/chats/typing'));assert.deepEqual(payload,{chatId:'79990000001@c.us',state:'typing'});assert.equal(options.maxRedirects,0);assert.equal(options.timeout,1500);throw new Error('fixture timeout');};
  try{assert.equal(await OpenWA.sendChatState('http://gateway.test',null,'fixture-session','79990000001@c.us','typing'),false);assert.equal(calls,1);
   assert.equal(await OpenWA.sendChatState('http://gateway.test',null,'fixture-session','bad-recipient','typing'),false);assert.equal(calls,1);
  }finally{axios.post=original;}
 });
 it('refuses a reply built for a replaced WhatsApp session before the gateway can send',()=>fixture(async({instance})=>{
  const Gateway=require('../src/services/whatsapp-gateway.service'),send=Gateway.sendMessage;let sends=0;
  Gateway.sendMessage=async()=>{sends++;return{success:true,data:{idMessage:'should-not-send'}};};
  try{await DB.updateInstance(instance.id,{openWaSessionId:'new-session'});
   await assert.rejects(()=>WhatsApp._sendMessage(instance,'79990000001@c.us','stale reply'),e=>e.code==='WHATSAPP_CONNECTION_CHANGED'&&e.safeToRetry===true);assert.equal(sends,0);
  }finally{Gateway.sendMessage=send;}
 }));
});
