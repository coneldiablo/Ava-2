'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Identities=require('../src/services/client-identity.service');
const Store=require('../src/services/crm-memory-store.service');
const POLICY=require('../src/services/crm-memory-policy.json');
describe('Canonical customer context',()=>{
 it('reads merged call context through old Telegram alias and accepts confirmed alternate phone only in its business',async()=>{
  createTestDB();
  const business=await DB.createInstance({name:'Context fixture',businessType:'hotel'});
  const foreign=await DB.createInstance({name:'Other fixture',businessType:'hotel'});
  const canonical='79990000111@c.us',old='tg_123456';
  await DB.getOrCreateClient(business.id,canonical,'Fixture');
  await DB.getOrCreateClient(business.id,old,'Fixture TG');
  Identities.attach(business.id,canonical,{kind:'telegram',value:'123456',mergeChatId:old,confirmMerge:true});
  Identities.attach(business.id,canonical,{kind:'phone',value:'+79990000222'});
  DB.run(`INSERT INTO crm_memory_summaries(summaryId,instanceId,chatId,kind,sourceKey,sourceHash,summaryJson,sourceUpdatedAt,generatedAt,model,promptVersion,sourceComplete)
  VALUES('summary-fixture',?,?,'call','call-fixture','hash',?,'2026-10-01T00:00:00Z','2026-10-01T00:00:01Z','fixture',?,1)`,
  [business.id,canonical,JSON.stringify({domain:'hotel',relevance:'relevant',summary:'Requested room details',interests:[]}),POLICY.version]);
  assert.equal(Store.latest(business.id,old,'call').summary,'Requested room details');
  assert.equal(Store.latest(foreign.id,old,'call'),null);
  const event={eventId:'context-call',instanceId:business.id,chatId:old,callId:'call-next',createdAt:'2026-10-01T01:00:00Z'};
  const accepted=Store.enqueueCall(event,{text:'Customer asked for a quiet room and dates',identityConfidence:'manual',phone:'+79990000222'});
  assert.ok(accepted?.jobId);
  assert.equal(DB.get('SELECT chatId FROM crm_memory_jobs WHERE jobId=?',[accepted.jobId]).chatId,canonical);
  assert.equal(Store.enqueueCall({...event,callId:'wrong-phone'},{text:'Customer asked for a quiet room and dates',identityConfidence:'manual',phone:'+79990000999'}),null);
 });
});
