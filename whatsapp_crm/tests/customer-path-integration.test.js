'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const AI=require('../src/services/ai.service');
const Catalog=require('../src/services/ava-autopilot.store');
const Identity=require('../src/services/identity/identity-store');
const Auth=require('../src/services/auth.service');
const Documents=require('../src/services/commercial-documents.service');
const Deals=require('../src/services/customer-deals.store');
const Studio=require('../src/services/customer-studio.service');
const OpenWA=require('../src/services/openwa.service');
const Router=require('../src/services/channel-router.service');

function fixture(){
 createTestDB();Identity.ensureSchema();
 DB.run("INSERT INTO instances(id,name,aiProvider,yandexGptKey,whatsappProvider,openWaSessionId,openWaUrl) VALUES(1,'One','aitunnel','fixture','openwa','session-one','http://openwa.test'),(2,'Two','aitunnel','fixture','openwa','session-two','http://openwa.test')");
 for(const [user,business,role]of[['owner',1,'hotel_owner'],['manager',1,'manager'],['foreign',2,'hotel_owner']]){
  DB.run('INSERT INTO ava_users(id,subject,email) VALUES(?,?,?)',[user,user,user+'@example.test']);
  DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)',[user,business,role]);
 }
 DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,'79990000001@c.us','Buyer','manager'),(2,'79990000001@c.us','Other',NULL)");
 Catalog.saveOffer(1,{id:'one',revision:1,name:'Пастух',amountMinor:125099,currency:'RUB',active:true,publishedAt:new Date().toISOString()});
 Catalog.saveOffer(2,{id:'two',revision:1,name:'Пастух чужой',amountMinor:1,currency:'RUB',active:true,publishedAt:new Date().toISOString()});
 return Identity.actor('owner');
}
describe('Customer package integrated ownership boundaries',()=>{
 it('CRM campaign filters use confirmed contacts and the same immutable audience preview',()=>{
  fixture();const Campaigns=require('../src/services/telephony/campaigns');
  DB.run("UPDATE clients SET leadStatus='qualified',tags='[\"pilot\"]' WHERE instanceId=1");
  DB.run("INSERT INTO clients(instanceId,chatId,senderName,leadStatus,tags) VALUES(1,'tg_79990000002','Telegram without phone','qualified','[\"pilot\"]')");
  const Canonical=require('../src/services/client-identity.service');
  const preview=Campaigns.preview(1,'owner',{sourceFilter:{statuses:['qualified'],tags:['pilot']}});
  assert.strictEqual(preview.counts.accepted,1);assert.strictEqual(preview.counts.invalid,1);
  Canonical.attach(1,'tg_79990000002',{kind:'phone',value:'+79990000003'});
  const confirmed=Campaigns.preview(1,'owner',{sourceFilter:{statuses:['qualified'],tags:['pilot']}});
  assert.strictEqual(confirmed.counts.accepted,2);
  assert.deepStrictEqual(confirmed.rows.map(r=>r.phone).sort(),['79990000001','79990000003']);
  const draft=Campaigns.create(1,'owner',{name:'CRM audience',importId:confirmed.importId},'crm-preview-unique');
  assert.strictEqual(draft.campaign.audienceSize,2);
  assert.throws(()=>Campaigns.preview(1,'owner',{sourceFilter:{silentDays:-1}}),{code:'TELEPHONY_INPUT_INVALID'});
 });
 it('ordinary configured AI receives only this business catalogue and rejects changes during completion',async()=>{
  fixture();const old=AI._callAITunnel;let input;
  AI._callAITunnel=async messages=>{input=messages;return JSON.stringify({reply:'Стоимость 1250,99 рублей',action:'none'});};
  try{
   const config=await DB.getInstance(1);
   await AI.getResponse([{role:'user',content:'Цена пастуха?'}],{instanceConfig:config,instanceId:1});
   assert.match(input[0].content,/125099/);assert.ok(!input[0].content.includes('Пастух чужой'));
   AI._callAITunnel=async()=>{Catalog.saveOffer(1,{...Catalog.offer(1,'one'),revision:2,amountMinor:90000},1);return '{"reply":"old","action":"none"}';};
   await assert.rejects(()=>AI.getResponse([{role:'user',content:'Цена пастуха?'}],{instanceConfig:config}),{code:'KNOWLEDGE_SOURCE_CHANGED'});
  }finally{AI._callAITunnel=old;}
 });
 it('real application mounts settings, private documents and verified callback with exact role and origin boundaries',async()=>{
  const auth=fixture(),oldEnabled=Auth.config.enabled,oldEnv=process.env.AVA_CUSTOMER_ACCESS_ENABLED,oldUrl=process.env.WHATSAPP_CRM_PUBLIC_URL;
  Auth.config.enabled=true;process.env.AVA_CUSTOMER_ACCESS_ENABLED='true';
  const app=require('../src/app').app,server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const origin='http://127.0.0.1:'+server.address().port;process.env.WHATSAPP_CRM_PUBLIC_URL=origin;
  const session=Identity.createSession('owner','integration-owner'),manager=Identity.createSession('manager','integration-manager'),foreign=Identity.createSession('foreign','integration-foreign');
  const headers=token=>({Cookie:'crm_session=ava2:'+token,Origin:origin,'Content-Type':'application/json'});
  const deal=Deals.create(1,{title:'Proposal',clientChatId:'79990000001@c.us'},'owner');
  Studio.save(auth,1,deal.id,{revision:0,dealRevision:deal.revision,text:'Подборка для покупателя',catalogItems:[{offerId:'one',offerRevision:1,quantity:1}],idempotencyKey:'material'});
  const oldState=Router._getWhatsAppState,oldSend=OpenWA.sendDocument;let sends=0;
  Router._getWhatsAppState=async()=>({success:true,state:'authorized'});
  OpenWA.sendDocument=async()=>{sends++;return{success:true,providerMessageId:'document-ack',safeToRetry:false};};
  try{
   const settings=origin+'/api/businesses/1/whatsapp/response-settings';
   const request=(url,token,method='GET',body)=>fetch(url,{method,headers:headers(token),...(body?{body:JSON.stringify(body)}:{})});
   assert.strictEqual((await request(settings,foreign)).status,403);
   assert.strictEqual((await request(settings,manager,'PUT',{delaySeconds:20,revision:0})).status,403);
   assert.strictEqual((await request(settings,session,'PUT',{delaySeconds:20,revision:0})).status,200);
   assert.strictEqual((await(await request(settings,session)).json()).settings.delaySeconds,20);
   assert.strictEqual((await request(settings,session,'PUT',{delaySeconds:30,revision:0})).status,409);
   const base=origin+'/api/businesses/1/studio/proposals/'+deal.id+'/documents';
   const pdf=await request(base+'/proposal.pdf?revision=1',session);assert.strictEqual(pdf.status,200);assert.match(pdf.headers.get('content-type'),/pdf/);
   assert.strictEqual((await request(base,foreign)).status,403);
   const send=()=>request(base+'/send',session,'POST',{kind:'proposal',revision:1});
   const first=await send();assert.strictEqual(first.status,200);assert.strictEqual((await first.json()).status,'sent');
   assert.strictEqual((await(await send()).json()).status,'sent');assert.strictEqual(sends,1);
   assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE instanceId=1 AND role='assistant'").n,1);
   const callback=await fetch(origin+'/api/external-integrations/webhook/avito/1/not-a-secret',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
   assert.notStrictEqual(callback.status,200);assert.notStrictEqual(callback.status,401);
   Identity.revokeSession(session);assert.strictEqual((await request(base,session)).status,401);
  }finally{
   Router._getWhatsAppState=oldState;OpenWA.sendDocument=oldSend;Auth.config.enabled=oldEnabled;
   if(oldEnv===undefined)delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;else process.env.AVA_CUSTOMER_ACCESS_ENABLED=oldEnv;
   if(oldUrl===undefined)delete process.env.WHATSAPP_CRM_PUBLIC_URL;else process.env.WHATSAPP_CRM_PUBLIC_URL=oldUrl;
   await new Promise(r=>server.close(r));
  }
 });
});
