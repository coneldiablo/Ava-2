'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service'),Identity=require('../src/services/identity/identity-store');
const WhatsApp=require('../src/services/whatsapp.service'),Autopilot=require('../src/services/ava-autopilot.service');
const Store=require('../src/services/ava-autopilot.store'),Control=require('../src/services/ava-workspace.store');
const Settings=require('../src/services/whatsapp-response-settings.service'),Gateway=require('../src/services/whatsapp-gateway.service');
const OpenWA=require('../src/services/openwa.service');
async function fixture(typingEnabled,run){
 createTestDB();WhatsApp.batcher.clearAll();WhatsApp._stateCache=new Map();Identity.ensureSchema();
 DB.run("INSERT INTO instances(id,name,isActive,openWaSessionId,whatsappProvider) VALUES(1,'Published policy fixture',1,'fixture-session','openwa')");
 DB.run("INSERT INTO ava_users(id,email,displayName) VALUES('owner','owner@example.test','Owner')");DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('owner',1,'hotel_owner')");
 const chat='79990000001@c.us',auth=Identity.actor('owner');await DB.getOrCreateClient(1,chat,'Fixture');
 const offer=Autopilot.createOffer(auth,1,{name:'Услуга',amountMinor:19999,currency:'RUB',terms:'Монтаж включён'}).offer;Autopilot.publishCatalog(auth,1,offer.id,{revision:offer.revision});
 const policy=Autopilot.updatePolicy(auth,1,{revision:0,enabled:true}).policy,simulation=Autopilot.simulations(auth,1,{revision:policy.revision}).simulation;assert.equal(simulation.passed,true);Autopilot.publish(auth,1,{revision:policy.revision,simulationId:simulation.id});assert.equal(Store.policy(1).activated,true);
 Settings.save(1,{delaySeconds:0,revision:0,typingEnabled});WhatsApp._ensureReplySchema();
 const source=await DB.saveMessageWithChannel(1,chat,'Fixture','Сколько стоит Услуга?','user','whatsapp');
 const batch={text:'Сколько стоит Услуга?',jobIds:[source.id],originChatId:chat,messages:[{meta:{messageId:source.id}}]};
 const old={handle:Autopilot.handleInbound,state:Gateway.getState,send:Gateway.sendMessage,presence:OpenWA.sendChatState,start:WhatsApp._startTyping},state={handoffs:0,sends:0,presence:[],cancelled:false};
 Autopilot.handleInbound=async input=>{state.handoffs++;return old.handle(input);};
 Gateway.getState=async()=>({success:true,effectiveState:'authorized'});Gateway.sendMessage=async()=>{state.sends++;return{success:true,data:{idMessage:'autopilot-fixture-ack'}};};
 OpenWA.sendChatState=async(...args)=>{state.presence.push(args[4]);return true;};
 try{await run({chat,batch,state,token:{isStale:()=>state.cancelled},afterPresence(fn){WhatsApp._startTyping=async(...args)=>{const stop=await old.start.apply(WhatsApp,args);await fn();return stop;};}});}
 finally{Object.assign(Autopilot,{handleInbound:old.handle});Gateway.getState=old.state;Gateway.sendMessage=old.send;OpenWA.sendChatState=old.presence;WhatsApp._startTyping=old.start;WhatsApp.batcher.clearAll();}
}
describe('Published text Autopilot handoff survives optional presence',()=>{
 for(const typingEnabled of [false,true])it(`dispatches the real published policy once with typing=${typingEnabled}`,()=>fixture(typingEnabled,async({chat,batch,state,token})=>{
  await WhatsApp._processBatch(1,chat,batch,token);assert.equal(state.handoffs,1);assert.equal(state.sends,1);assert.equal(Store.actions(1).filter(a=>a.status==='sent').length,1);
  assert.deepEqual(state.presence,typingEnabled?['typing','paused']:[]);
 }));
 for(const cancellation of ['token','human','session'])it(`does not hand off or send when ${cancellation} changes during presence`,()=>fixture(true,async({chat,batch,state,token,afterPresence})=>{
  afterPresence(async()=>{if(cancellation==='token')state.cancelled=true;else if(cancellation==='human'){Control.setControl({businessId:1,chatId:chat,mode:'human'});Control.setControl({businessId:1,chatId:chat,mode:'ai'});}else await DB.updateInstance(1,{openWaSessionId:'replacement-session'});});
  await WhatsApp._processBatch(1,chat,batch,token);assert.equal(state.handoffs,0);assert.equal(state.sends,0);assert.equal(Store.actions(1).length,0);
 }));
});
