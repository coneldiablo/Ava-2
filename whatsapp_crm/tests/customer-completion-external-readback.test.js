'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service'),Store=require('../src/services/integrations/store');
const Amo=require('../src/services/integrations/amocrm'),axios=require('axios');
async function fixture(run){
 createTestDB();DB.run("INSERT INTO instances(id,name) VALUES(1,'Readback fixture')");
 const previous=process.env.CHANNEL_CREDENTIALS_MASTER_KEY,request=axios.request;process.env.CHANNEL_CREDENTIALS_MASTER_KEY='11'.repeat(32);
 Store.save(1,'amocrm',{domain:'fixture.amocrm.ru',mapping:{statusMap:{}}},{clientId:'fixture',accessToken:'fixture-access',expiresAt:Date.now()+3600000});Store.patch(1,'amocrm',{accountId:'101',status:'connected'});
 try{await run();}finally{axios.request=request;if(previous===undefined)delete process.env.CHANNEL_CREDENTIALS_MASTER_KEY;else process.env.CHANNEL_CREDENTIALS_MASTER_KEY=previous;}
}
describe('External readback prioritizes unresolved outcomes over transient diagnostics',()=>{
 it('shows unknown outcome after actual Amo.syncClient HTTP408 and retains the one-write fence',()=>fixture(async()=>{
  const client=await DB.getOrCreateClient(1,'79990000001@c.us','Fixture');let writes=0;
  axios.request=async req=>{assert.equal(req.method,'POST');assert.ok(req.url.endsWith('/api/v4/contacts'));writes++;throw {response:{status:408}};};
  await assert.rejects(()=>Amo.syncClient(1,client.chatId,'new'),e=>e.code==='EXTERNAL_TIMEOUT'&&e.unknown===true);
  assert.equal(Store.get(1,'amocrm').errorCode,'EXTERNAL_TIMEOUT');
  const readback=Store.status(1,'amocrm');assert.equal(readback.exchange.unconfirmedWrites,1);assert.equal(readback.error.code,'EXTERNAL_OUTCOME_UNKNOWN');assert.match(readback.error.action,/перед повтором/);
  await assert.rejects(()=>Amo.syncClient(1,client.chatId,'new'),e=>e.code==='EXTERNAL_OUTCOME_UNKNOWN'&&e.safeToRetry===false);
  assert.equal(writes,1);assert.equal(DB.get('SELECT status FROM customer_external_operations').status,'unknown');
 }));
 it('also prioritizes unresolved export actions while preserving stored diagnostic details',()=>fixture(async()=>{
  Store.patch(1,'amocrm',{errorCode:'EXTERNAL_PROVIDER_UNAVAILABLE'});
  DB.run("INSERT INTO customer_external_exports(instanceId,provider,accountId,sourceType,sourceId,chatId,sourceHash,status,updatedAt) VALUES(1,'amocrm','101','task','fixture-task','fixture-chat','fixture-hash','unknown',?)",[Date.now()]);
  const status=Store.status(1,'amocrm');assert.equal(status.exchange.unconfirmedActions,1);assert.equal(status.exchange.unconfirmedWrites,0);assert.equal(status.error.code,'EXTERNAL_OUTCOME_UNKNOWN');assert.equal(Store.get(1,'amocrm').errorCode,'EXTERNAL_PROVIDER_UNAVAILABLE');
 }));
 it('retains transient error readback when there are no unresolved writes or actions',()=>fixture(async()=>{
  Store.patch(1,'amocrm',{errorCode:'EXTERNAL_TIMEOUT'});const status=Store.status(1,'amocrm');assert.equal(status.error.code,'EXTERNAL_TIMEOUT');assert.equal(status.exchange.unconfirmedWrites,0);assert.equal(status.exchange.unconfirmedActions,0);
 }));
});
