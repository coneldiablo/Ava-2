'use strict';
// Local SQLite + fake host, no SIP network, purchased resource, or real call.
const {test,beforeEach,afterEach}=require.main===module?require('node:test'):(()=>{
 const {it}=require('./test-helper');let setup=()=>{},cleanup=()=>{};
 return {beforeEach:fn=>{setup=fn;},afterEach:fn=>{cleanup=fn;},test:(name,fn)=>it(name,async()=>{try{await setup();await fn();}finally{await cleanup();}})};
})();
const assert=require('node:assert/strict');
const {createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service'),Identity=require('../src/services/identity/identity-store'),Auth=require('../src/services/auth.service');
const Store=require('../src/services/telephony/store'),Service=require('../src/services/telephony/service'),External=require('../src/services/telephony/external-sip'),Vault=require('../src/services/telephony/credentials');
const {PhoneWorker}=require('../src/services/telephony/worker');
let env,now,worker,host,owner,authEnabled,applied,removed,live,registered,providerReads;
const body={number:'74951110003',host:'8.8.8.8',port:5060,transport:'udp',login:'fixture-login',password:'Fixture-private-credential'};
beforeEach(()=>{
 env={...process.env};now=Date.now();authEnabled=Auth.config.enabled;Auth.config.enabled=true;
 Object.assign(process.env,{AVA_TELEPHONY_MASTER_KEY:'a'.repeat(64),AVA_TELEPHONY_PURCHASE_ENABLED:'false',AVA_TELEPHONY_OUTBOUND_ENABLED:'true',AVA_CUSTOMER_ACCESS_ENABLED:'true',CRM_SERVICE_API_TOKEN:'external-fixture-service-token',AVA_TELEPHONY_LEGACY_DIDS:'{"79000000000":1}'});
 if(DB.db?.open)DB.db.close();createTestDB();Identity.ensureSchema();Store.ensureSchema();
 DB.run("INSERT INTO instances(id,name,isActive,sipCallerId,sipTrunkNumber,sipAliases) VALUES(1,'One',1,'79000000000','legacy-existing','[\"79000000000\"]'),(2,'Two',1,NULL,NULL,'[]')");
 DB.run("INSERT INTO business_sip_aliases(alias,businessId) VALUES('79000000000',1)");
 for(const[id,business,role]of[['owner',1,'hotel_owner'],['manager',1,'manager'],['foreign',2,'hotel_owner']]){
  DB.run('INSERT INTO ava_users(id,subject,email,displayName) VALUES(?,?,?,?)',[id,id,id+'@example.test',id]);
  DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)',[id,business,role]);
 }
 owner=Identity.actor('owner');applied=removed=providerReads=0;live=null;registered=true;
 host={externalCapabilities:async()=>({success:true,available:true,transports:['udp']}),calls:async()=>({success:true,active:0}),
  externalStatus:async()=>live?{success:true,configured:true,registered,...live}:{success:true,configured:false,registered:false,revision:0},
  applyExternal:async(p,c)=>{applied++;live={revision:p.generation,fingerprint:c.fingerprint};return{success:true};},
  removeExternal:async()=>{removed++;live=null;return{success:true};},health:async()=>({ingressReady:true})};
 const provider=new Proxy({token:'fixture',applicationId:'app'},{get:(object,key)=>key in object?object[key]:async()=>{providerReads++;throw new Error('EXOLVE_MUST_NOT_RUN');}});
 worker=new PhoneWorker({host,provider,now:()=>now});
});
afterEach(()=>{process.env=env;Auth.config.enabled=authEnabled;});
function create(value=body,key=Store.uuid(),business=1,actor='owner'){return External.request(business,null,value,key,actor,'save',now);}
function later(){now+=61000;worker.lastMaintenance=now;}
test('save durably checkpoints encrypted credentials before any host or DNS work; exact idempotency and scoped recovery',()=>{
 const tables=DB.all("SELECT name FROM sqlite_master WHERE type='table'").map(x=>x.name),key='external-create-key',job=create(body,key);
 assert.equal(job.kind,'external_apply');assert.equal(job.stage,'external_validate');assert.equal(applied,0);
 const p=Store.phone(job.phoneId);assert.equal(p.origin,'external');assert.deepEqual(Vault.decrypt(p.encryptedCredentials,p),body);
 assert(!JSON.stringify(p).includes(body.password));assert(!JSON.stringify(job).includes(body.password));assert(!JSON.stringify(Service.overview(owner,1)).includes(body.password));
 assert.equal(create(body,key).id,job.id);assert.throws(()=>create({...body,password:'different'},key),{code:'TELEPHONY_IDEMPOTENCY_CONFLICT'});
 assert.equal(External.requestByKey(1,key).operation.id,job.id);assert.equal(External.requestByKey(2,key).operation,null);
 assert.deepEqual(DB.all("SELECT name FROM sqlite_master WHERE type='table'").map(x=>x.name),tables);
 assert.deepEqual(Store.resolve('79000000000'),{businessId:1,phoneId:null,number:'79000000000',contextName:'unified_sales_agent',legacy:true});
 assert.deepEqual(Store.source(1),{managed:false});
});
test('invalid syntax, private IP, and foreign or legacy DID cannot enter the queue',async()=>{
 for(const change of [{host:'127.0.0.1'},{host:'http://example.com'},{host:'sip.example.com\n[escape]'},{login:'user;other'},{password:'pass\ninclude'},{transport:'ws'},{port:0},{number:'79000000000'}])assert.throws(()=>create({...body,...change}));
 DB.run("UPDATE instances SET sipCallerId='74951110003' WHERE id=2");assert.throws(()=>create(),{code:'TELEPHONY_NUMBER_ALREADY_BOUND'});
 DB.run("UPDATE instances SET sipCallerId=NULL WHERE id=2");
 await assert.rejects(()=>External.addresses('sip.example.com',async()=>[{address:'8.8.8.8'},{address:'10.1.2.3'}]),{code:'TELEPHONY_SIP_HOST_PRIVATE'});
 assert.deepEqual(await External.addresses('sip.example.com',async()=>[{address:'8.8.8.8'},{address:'1.1.1.1'},{address:'8.8.8.8'}]),['1.1.1.1','8.8.8.8']);
 assert.equal(DB.get('SELECT COUNT(*) n FROM ava_phone_operations').n,0);
});
test('host installation and real transport are gates, no Exolve work and no false activation',async()=>{
 const job=create();host.externalCapabilities=async()=>({success:true,available:false,transports:[]});await worker.processOne();
 assert.equal(Store.phone(job.phoneId).state,'provisioning');assert.equal(Store.operation(job.id).errorCode,'TELEPHONY_EXTERNAL_HOST_NOT_READY');assert.equal(applied,0);assert.equal(providerReads,0);
 later();host.externalCapabilities=async()=>({success:true,available:true,transports:['tls']});await worker.processOne();
 assert.equal(Store.operation(job.id).state,'manual');assert.equal(Store.operation(job.id).errorCode,'TELEPHONY_SIP_TRANSPORT_UNAVAILABLE');assert.equal(providerReads,0);
});
test('registration proof activates own route without claiming a tested call or replacing the existing DID',async()=>{
 const job=create();await worker.processOne();const p=Store.phone(job.phoneId);
 assert.equal(Store.operation(job.id).state,'done');assert.equal(p.state,'active');assert.equal(p.inboundReady,1);assert.equal(p.outboundReady,1);
 assert.equal(p.inboundVerifiedAt,null);assert.equal(p.outboundVerifiedAt,null);assert.equal(p.isPrimary,0);assert.equal(providerReads,0);
 assert.equal(Store.resolve(body.number).phoneId,p.id);assert.equal(External.ownerRoute(p.id,{active:true}).businessId,1);
 const i=DB.get('SELECT sipCallerId,sipTrunkNumber FROM instances WHERE id=1');assert.equal(i.sipCallerId,'79000000000');assert.equal(i.sipTrunkNumber,'legacy-existing');
 const view=Service.overview(owner,1);assert.equal(view.externalSip.available,true);assert.equal(view.externalTrunks[0].registration,'registered');assert.equal(view.externalTrunks[0].passwordConfigured,true);assert(!JSON.stringify(view).includes(body.login));
 Store.reserveCall({businessId:1,number:body.number,callId:'verified-fixture',direction:'inbound'},now);Store.finishCall('verified-fixture',{businessId:1,seconds:5},now);
 assert.equal(Store.phone(p.id).inboundVerifiedAt,now);
});
test('unregistered endpoint stays pending; restart with exact read-back reconciles a lost apply ACK once',async()=>{
 const job=create();const apply=host.applyExternal;host.applyExternal=async(...args)=>{await apply(...args);throw Object.assign(new Error('lost ack'),{code:'TELEPHONY_AGENT_UNAVAILABLE'});};
 await worker.processOne();assert.equal(applied,1);assert.equal(Store.operation(job.id).stage,'external_apply_dispatching');assert.equal(Store.phone(job.phoneId).state,'provisioning');
 later();registered=false;worker=new PhoneWorker({host,provider:worker.provider,now:()=>now});await worker.processOne();assert.equal(applied,1);assert.equal(Store.operation(job.id).errorCode,'TELEPHONY_SIP_REGISTERING');
 later();registered=true;await worker.processOne();assert.equal(applied,1);assert.equal(Store.operation(job.id).state,'done');assert.equal(providerReads,0);
});
test('unknown host result is bounded and never accepted as connected; stale revision cancels only stale job',async()=>{
 const job=create();host.externalStatus=async()=>({success:true,configured:true,registered:true,revision:99,fingerprint:'f'.repeat(64)});await worker.processOne();
 assert.equal(applied,0);assert.equal(Store.operation(job.id).state,'reconciling');assert.equal(Store.phone(job.phoneId).inboundReady,0);
 DB.run('UPDATE ava_phone_numbers SET generation=2 WHERE id=?',[job.phoneId]);later();await worker.processOne();
 assert.equal(Store.operation(job.id).state,'canceled');assert.equal(Store.phone(job.phoneId).state,'provisioning');
});
test('active calls drain before apply and disconnect; only owned endpoint removed, existing legacy route and provider untouched',async()=>{
 const job=create();host.calls=async()=>({active:1});await worker.processOne();assert.equal(applied,0);assert.equal(Store.operation(job.id).errorCode,'TELEPHONY_CALLS_DRAINING');
 later();host.calls=async()=>({active:0});await worker.processOne();
 const p=Store.phone(job.phoneId),remove=External.request(1,p.id,{expectedRevision:p.generation},Store.uuid(),'owner','disconnect',now);
 host.calls=async()=>({active:1});await worker.processOne();assert.equal(removed,0);
 later();host.calls=async()=>({active:0});await worker.processOne();
 assert.equal(removed,1);assert.equal(Store.operation(remove.id).state,'done');assert.equal(Store.phone(p.id).state,'released');assert.equal(Store.phone(p.id).encryptedCredentials,null);assert.equal(providerReads,0);
 assert.equal(DB.get('SELECT sipTrunkNumber FROM instances WHERE id=1').sipTrunkNumber,'legacy-existing');assert.equal(Store.resolve('79000000000').businessId,1);
 assert.equal(DB.get('SELECT businessId FROM business_sip_aliases WHERE alias=?',[body.number]),undefined);
});
test('partial credential update, revision fence, pending fence and checked readback survive business reactivation',async()=>{
 const job=create();await worker.processOne();let p=Store.phone(job.phoneId);
 assert.throws(()=>External.request(1,p.id,{expectedRevision:0,port:5070},Store.uuid(),'owner'),{code:'TELEPHONY_SIP_REVISION_CHANGED'});
 const updated=External.request(1,p.id,{expectedRevision:p.generation,port:5070},Store.uuid(),'owner','save',now);p=Store.phone(p.id);
 assert.equal(Vault.decrypt(p.encryptedCredentials,p).password,body.password);assert.equal(p.generation,2);
 assert.throws(()=>External.request(1,p.id,{expectedRevision:p.generation},Store.uuid(),'owner','check',now),{code:'TELEPHONY_SIP_OPERATION_PENDING'});
 await worker.processOne();assert.equal(Store.operation(updated.id).state,'done');
 DB.run('UPDATE instances SET isActive=0 WHERE id=1');await worker.maintenance();assert.equal(Store.phone(p.id).state,'grace');assert.throws(()=>External.ownerRoute(p.id,{active:true}));
 DB.run('UPDATE instances SET isActive=1 WHERE id=1');Store.restoreBusiness(1,now);assert.equal(Store.phone(p.id).generation,3);assert.equal(Store.phone(p.id).inboundReady,0);
 await worker.processOne();assert.equal(Store.phone(p.id).inboundReady,1);assert.equal(Store.phone(p.id).generation,3);
});
test('maintenance loses readiness on missing host; revoked owner does not retry indefinitely',async()=>{
 const job=create();await worker.processOne();const p=Store.phone(job.phoneId);host.externalStatus=async()=>{throw new Error('unreachable');};
 await External.maintenance(worker);assert.equal(Store.phone(p.id).inboundReady,0);assert.throws(()=>External.ownerRoute(p.id,{active:true}));
 const check=External.request(1,p.id,{expectedRevision:p.generation},Store.uuid(),'owner','check',now);
 DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='owner'");await worker.processOne();assert.equal(Store.operation(check.id).state,'manual');
});
test('real cookie HTTP enforces owner, tenant, origin, revocation and durable unknown-ACK request readback',async()=>{
 const app=require('../src/app').app,sessions={};for(const id of ['owner','manager','foreign'])sessions[id]=Identity.createSession(id,id+'-external-session');
 const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));}),url=`http://127.0.0.1:${server.address().port}`,base=url+'/api/businesses/1/telephony/external';
 const h=id=>({Cookie:`crm_session=ava2:${sessions[id]}`,'Content-Type':'application/json',Origin:url,'Idempotency-Key':'http-external-create'});
 try{
  for(const id of ['manager','foreign'])assert.equal((await fetch(base,{method:'POST',headers:h(id),body:JSON.stringify(body)})).status,403);
  assert.equal((await fetch(base,{method:'POST',headers:{...h('owner'),Origin:'https://evil.test'},body:JSON.stringify(body)})).status,403);
  const created=await fetch(base,{method:'POST',headers:h('owner'),body:JSON.stringify(body)});const result=await created.json();assert.equal(created.status,202,JSON.stringify(result));assert.equal(result.operation.state,'pending');
  const read=await fetch(base+'/requests/http-external-create',{headers:h('owner')});assert.equal(read.status,200);assert.equal((await read.json()).operation.id,result.operation.id);
  assert.equal((await fetch(base+'/requests/http-external-create',{headers:h('foreign')})).status,403);
  const id=result.operation.phoneId;
  assert.equal((await fetch(url+'/api/internal/telephony/external/'+id,{headers:h('owner')})).status,401);
  const internal=await fetch(url+'/api/internal/telephony/external/'+id,{headers:{Authorization:'Bearer external-fixture-service-token'}});assert.equal(internal.status,200);assert.equal((await internal.json()).businessId,1);
  now=Date.now()+100;worker.lastMaintenance=now;await worker.processOne();
  for(const [method,suffix,payload,key]of[['PUT','',{expectedRevision:1,port:5070},'http-update-fixture'],['POST','/check',{expectedRevision:2},'http-check-fixture'],['POST','/disconnect',{expectedRevision:2},'http-remove-fixture']]){
   for(const actor of ['manager','foreign'])assert.equal((await fetch(base+'/'+id+suffix,{method,headers:{...h(actor),'Idempotency-Key':key},body:JSON.stringify(payload)})).status,403);
   const accepted=await fetch(base+'/'+id+suffix,{method,headers:{...h('owner'),'Idempotency-Key':key},body:JSON.stringify(payload)});assert.equal(accepted.status,202,await accepted.text());
   now=Date.now()+100;worker.lastMaintenance=now;await worker.processOne();
  }
  assert.equal(Store.phone(id).state,'released');assert.equal(removed,1);
  DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='owner'");assert.equal((await fetch(base+'/requests/http-external-create',{headers:h('owner')})).status,403);
  assert.equal(applied,2);assert.equal(providerReads,0);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
