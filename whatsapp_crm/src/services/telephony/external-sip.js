'use strict';
const crypto=require('crypto'),dns=require('node:dns').promises,net=require('node:net');
const DB=require('../database.service'),Identity=require('../identity/identity-store');
const Store=require('./store'),Vault=require('./credentials');
const {LIMITS,did,fields,fail}=require('./policy');
const {isPublicAddress}=require('../assistant-public-pages.service');
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const configFields=['number','host','port','transport','login','password'];
function normalize(body,previous={}){
 const value={...previous,...body};
 value.number=did(value.number);
 if(typeof value.host!=='string'||value.host.length>253||value.host!==value.host.trim())fail('TELEPHONY_SIP_HOST_INVALID');
 value.host=value.host.toLowerCase();
 if(!net.isIP(value.host)&&(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(value.host)||/\.(?:local|localhost|internal|test|invalid|example)$/.test(value.host)))fail('TELEPHONY_SIP_HOST_INVALID');
 if(net.isIP(value.host)&&!isPublicAddress(value.host))fail('TELEPHONY_SIP_HOST_PRIVATE');
 if(!Number.isSafeInteger(value.port)||value.port<1||value.port>65535||!['udp','tcp','tls'].includes(value.transport))fail('TELEPHONY_SIP_TRANSPORT_INVALID');
 if(typeof value.login!=='string'||!/^[a-zA-Z0-9_.+~-]{1,80}$/.test(value.login))fail('TELEPHONY_SIP_LOGIN_INVALID');
 if(typeof value.password!=='string'||!/^[a-zA-Z0-9_.!@#$%&*+=:?~\-]{1,128}$/.test(value.password))fail('TELEPHONY_SIP_PASSWORD_INVALID');
 return Object.fromEntries(configFields.map(key=>[key,value[key]]));
}
const digest=value=>crypto.createHmac('sha256',Vault.key()).update(JSON.stringify(value)).digest('hex');
function own(businessId,id){const row=Store.phone(id);if(!row||row.businessId!==businessId||row.origin!=='external'||row.state==='released')fail('TELEPHONY_NUMBER_NOT_FOUND',404);return row;}
function status(id){const row=Store.meta('external_sip:'+id);try{return row?{...JSON.parse(row.value),checkedAt:row.updatedAt}:{};}catch{return{};}}
function publicTrunk(row){
 let config={},vaultError=false;try{config=Vault.decrypt(row.encryptedCredentials,row);}catch{vaultError=true;}
 const observed=status(row.id),job=DB.get("SELECT * FROM ava_phone_operations WHERE phoneId=? AND kind LIKE 'external_%' ORDER BY createdAt DESC,rowid DESC LIMIT 1",[row.id]);
 return {id:row.id,number:row.number,host:config.host||null,port:config.port||null,transport:config.transport||null,
  loginMasked:config.login?'••••'+config.login.slice(-4):null,passwordConfigured:Boolean(config.password),revision:row.generation,state:row.state,
  registration:observed.revision===row.generation&&observed.checkedAt>Date.now()-90000?(observed.registered?'registered':'unregistered'):'unknown',
  inboundVerifiedAt:row.inboundVerifiedAt,outboundVerifiedAt:row.outboundVerifiedAt,
  lastErrorCode:vaultError?'TELEPHONY_VAULT_READ_FAILED':job?.errorCode||null,operationId:job?.id||null};
}
function overview(businessId){
 const row=Store.meta('external_sip_capabilities');let capabilities={};try{if(row?.updatedAt>Date.now()-90000)capabilities=JSON.parse(row.value);}catch{}
 return {externalSip:{available:capabilities.available===true,transports:Array.isArray(capabilities.transports)?capabilities.transports:[],
  ...(capabilities.available===true?{}:{blocker:'TELEPHONY_EXTERNAL_HOST_NOT_READY'})},
  externalTrunks:DB.all("SELECT * FROM ava_phone_numbers WHERE businessId=? AND origin='external' AND state<>'released' ORDER BY createdAt",[businessId]).map(publicTrunk)};
}
function request(businessId,id,body,key,actorUserId,action='save',now=Date.now()){
 fields(body,action==='save'?[...configFields,...(id?['expectedRevision']:[])]:['expectedRevision']);
 if(typeof key!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(key))fail('TELEPHONY_IDEMPOTENCY_REQUIRED');
 const hash=digest({id:id||null,action,body});
 return Store.transaction(()=>{
  Identity.authorizeCapability({userId:actorUserId},businessId,'business.manage');
  if(!DB.get('SELECT id FROM instances WHERE id=? AND isActive=1',[businessId]))fail('BUSINESS_NOT_FOUND',404);
  const old=DB.get('SELECT * FROM ava_phone_operations WHERE businessId=? AND idempotencyKey=?',[businessId,key]);
  if(old){if(old.requestHash!==hash)fail('TELEPHONY_IDEMPOTENCY_CONFLICT',409);return old;}
  let p=id?own(businessId,id):null;
  if(p&&(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision!==p.generation))fail('TELEPHONY_SIP_REVISION_CHANGED',409);
  if(p&&DB.get("SELECT 1 FROM ava_phone_operations WHERE phoneId=? AND state IN ('pending','running','reconciling')",[id]))fail('TELEPHONY_SIP_OPERATION_PENDING',409);
  if(DB.get('SELECT COUNT(*) n FROM ava_phone_operations WHERE businessId=? AND createdAt>?',[businessId,now-60000]).n>=12)fail('TELEPHONY_RATE_LIMIT',429);
  let config;
  if(action==='save'){
   config=normalize(Object.fromEntries(Object.entries(body).filter(([field])=>configFields.includes(field))),p?Vault.decrypt(p.encryptedCredentials,p):{});
   if(DB.get("SELECT id FROM ava_phone_numbers WHERE number=? AND state<>'released' AND id<>?",[config.number,id||''])
    ||DB.get('SELECT businessId FROM business_sip_aliases WHERE alias=? AND (? IS NULL OR businessId<>?)',[config.number,p?.businessId||null,businessId]))fail('TELEPHONY_NUMBER_ALREADY_BOUND',409);
   // Never silently adopt an existing legacy route, including this owner's DID.
   if(!p&&DB.get('SELECT businessId FROM business_sip_aliases WHERE alias=?',[config.number]))fail('TELEPHONY_NUMBER_ALREADY_BOUND',409);
   // Legacy profiles can predate the canonical alias table. Never seize those DIDs.
   for(const profile of DB.all('SELECT id,sipCallerId,sipAliases FROM instances')){
    let aliases=[];try{aliases=JSON.parse(profile.sipAliases||'[]');}catch{}
    const numbers=[profile.sipCallerId,...(Array.isArray(aliases)?aliases:[])].filter(Boolean).map(value=>{try{return did(value);}catch{return null;}});
    if(numbers.includes(config.number)&&(!p||profile.id!==businessId||config.number!==p.number))fail('TELEPHONY_NUMBER_ALREADY_BOUND',409);
   }
   if(!p){
    if(DB.get("SELECT COUNT(*) n FROM ava_phone_numbers WHERE businessId=? AND state<>'released'",[businessId]).n>=LIMITS.numbers)fail('TELEPHONY_NUMBER_LIMIT',409);
    if(!DB.get("SELECT id FROM ava_phone_numbers WHERE businessId=? AND state<>'released'",[businessId]))
     DB.run('INSERT OR IGNORE INTO ava_phone_manual_profiles(businessId,sipCallerId,sipTrunkNumber) SELECT id,sipCallerId,sipTrunkNumber FROM instances WHERE id=?',[businessId]);
    id=Store.uuid();p={id,businessId,number:config.number,sipResourceId:'external:'+id};
    DB.run(`INSERT INTO ava_phone_numbers(id,businessId,number,origin,applicationId,state,installKopecks,monthlyKopecks,sipResourceId,sipName,endpoint,encryptedCredentials,createdAt,updatedAt)
     VALUES(?,?,?,'external','external','provisioning',0,0,?,'',?,?,?,?)`,[id,businessId,config.number,p.sipResourceId,'ava-phone-'+id.replaceAll('-',''),Vault.encrypt(config,p),now,now]);
   }else{
    const previousNumber=p.number;
    DB.run("UPDATE ava_phone_numbers SET number=?,encryptedCredentials=?,generation=generation+1,state='provisioning',inboundReady=0,outboundReady=0,updatedAt=? WHERE id=?",[config.number,Vault.encrypt(config,p),now,id]);
    p={...p,previousNumber};
   }
  }else{
   if(!p)fail('TELEPHONY_NUMBER_NOT_FOUND',404);
   if(action==='disconnect')DB.run("UPDATE ava_phone_numbers SET state='releasing',inboundReady=0,outboundReady=0,generation=generation+1,updatedAt=? WHERE id=?",[now,id]);
  }
  const current=Store.phone(id),kind=action==='save'?'external_apply':action==='disconnect'?'external_remove':'external_check';
  const job=Store.insertOperation({businessId,phoneId:id,kind,stage:action==='save'?'external_validate':action==='disconnect'?'external_remove':'external_status',actorUserId,key,hash,
   input:{revision:current.generation,...(p?.previousNumber?{previousNumber:p.previousNumber}:{})},now,fundingMode:'external'});
  Store.syncProjection(businessId);return job;
 });
}
function requestByKey(businessId,key){
 if(typeof key!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(key))fail('TELEPHONY_IDEMPOTENCY_REQUIRED');
 const row=DB.get("SELECT * FROM ava_phone_operations WHERE businessId=? AND idempotencyKey=? AND kind LIKE 'external_%'",[businessId,key]);
 return {success:true,businessId,operation:row?Store.publicOperation(row):null};
}
function ownerRoute(id,{active=false}={}){
 if(!UUID.test(id))fail('TELEPHONY_NUMBER_NOT_FOUND',404);
 const p=Store.phone(id);
 const business=p&&DB.get('SELECT isActive FROM instances WHERE id=?',[p.businessId]);
 if(!p||p.origin!=='external'||p.state==='released'||!business||active&&(!business.isActive||p.state!=='active'||!p.inboundReady))fail('TELEPHONY_DID_UNAVAILABLE',404);
 return {businessId:p.businessId,phoneId:p.id,number:p.number,endpoint:p.endpoint,revision:p.generation,state:p.state,businessActive:Boolean(business.isActive)};
}
async function addresses(host,lookup=dns.lookup.bind(dns)){
 let answers,timer;
 try{answers=net.isIP(host)?[{address:host}]:await Promise.race([lookup(host,{all:true,verbatim:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('dns_timeout')),5000);})]);}catch{fail('TELEPHONY_SIP_DNS_UNAVAILABLE',503);}finally{clearTimeout(timer);}
 if(!answers.length||answers.length>32||answers.some(row=>!isPublicAddress(row.address)))fail('TELEPHONY_SIP_HOST_PRIVATE',409);
 return [...new Set(answers.map(row=>row.address))].sort();
}
function record(p,evidence,now){
 if(evidence?.success!==true||typeof evidence.configured!=='boolean'||typeof evidence.registered!=='boolean')fail('TELEPHONY_EXTERNAL_STATUS_INVALID',503);
 const current=Store.phone(p.id);if(current.generation!==p.generation)fail('TELEPHONY_SIP_REVISION_CHANGED',409);
 Store.setMeta('external_sip:'+p.id,{configured:evidence.configured,registered:evidence.registered,revision:evidence.revision||0},now);
 return evidence;
}
async function run(worker,job){
 let p=own(job.businessId,job.phoneId),input=JSON.parse(job.inputJson);
 const removing=job.kind==='external_remove'||job.kind==='release';
 if(removing&&input.revision==null)input={...input,revision:p.generation};
 const guard=()=>{Store.assertLease(job,worker.now());if(!(removing&&!job.actorUserId&&p.releaseReason==='business_inactive'))Identity.authorizeCapability({userId:job.actorUserId},job.businessId,'business.manage');const current=own(job.businessId,p.id);if(current.generation!==input.revision)fail('TELEPHONY_SIP_REVISION_CHANGED',409);const active=DB.get('SELECT isActive FROM instances WHERE id=?',[job.businessId])?.isActive;if(!removing&&!active)fail('BUSINESS_NOT_FOUND',404);if(removing&&current.releaseReason==='business_inactive'&&active)fail('TELEPHONY_RELEASE_CHANGED',409);return current;};
 guard();
 const capability=await worker.fenced(job,()=>worker.host.externalCapabilities());
 Store.setMeta('external_sip_capabilities',capability,worker.now());
 if(capability.available!==true){worker.defer(job,'TELEPHONY_EXTERNAL_HOST_NOT_READY',30000);return;}
 if(removing){
  if((await worker.fenced(job,()=>worker.host.calls())).active!==0||DB.get("SELECT 1 FROM ava_phone_calls WHERE phoneId=? AND state='reserved'",[p.id])){worker.defer(job,'TELEPHONY_CALLS_DRAINING',30000);return;}
  let observed=await worker.fenced(job,()=>worker.host.externalStatus(p));
  if(observed.configured){guard();worker.advance(job,'external_remove_dispatching');await worker.fenced(job,()=>worker.host.removeExternal(p));observed=await worker.fenced(job,()=>worker.host.externalStatus(p));}
  if(observed.configured!==false){worker.defer(job,'TELEPHONY_EXTERNAL_OUTCOME_UNKNOWN');return;}
  Store.transaction(()=>{guard();worker.advance(job,'detached',{state:'done',errorCode:null});DB.run("UPDATE ava_phone_numbers SET state='released',isPrimary=0,encryptedCredentials=NULL,inboundReady=0,outboundReady=0,updatedAt=? WHERE id=?",[worker.now(),p.id]);
   const profile=DB.get('SELECT * FROM ava_phone_existing_profiles WHERE phoneId=?',[p.id]);
   if(!profile?.aliasExisted)DB.run('DELETE FROM business_sip_aliases WHERE alias=? AND businessId=?',[p.number,p.businessId]);
   const i=DB.get('SELECT sipAliases,sipTrunkNumber FROM instances WHERE id=?',[p.businessId]);
   DB.run('UPDATE instances SET sipAliases=? WHERE id=?',[JSON.stringify(JSON.parse(i.sipAliases||'[]').filter(n=>n!==p.number||profile?.aliasExisted)),p.businessId]);
   if(i.sipTrunkNumber===p.endpoint){
    const replacement=DB.get("SELECT id FROM ava_phone_numbers WHERE businessId=? AND state='active' AND outboundReady=1 ORDER BY isPrimary DESC,createdAt LIMIT 1",[p.businessId]);
    if(replacement)Store.primary(p.businessId,replacement.id);
    else{const original=DB.get('SELECT sipCallerId,sipTrunkNumber FROM ava_phone_manual_profiles WHERE businessId=?',[p.businessId]);DB.run('UPDATE instances SET sipCallerId=?,sipTrunkNumber=? WHERE id=?',[original?.sipCallerId||null,original?.sipTrunkNumber||null,p.businessId]);}
   }
   if(!DB.get("SELECT 1 FROM ava_phone_numbers WHERE businessId=? AND state<>'released'",[p.businessId]))DB.run('DELETE FROM ava_phone_manual_profiles WHERE businessId=?',[p.businessId]);
   Store.syncProjection(p.businessId);});return;
 }
 const config=Vault.decrypt(p.encryptedCredentials,p);
 if(!capability.transports?.includes(config.transport))fail('TELEPHONY_SIP_TRANSPORT_UNAVAILABLE',409);
 if(job.kind==='external_check'){
  const observed=record(p,await worker.fenced(job,()=>worker.host.externalStatus(p)),worker.now());
  if(!observed.configured||observed.revision!==p.generation||!observed.registered){worker.defer(job,'TELEPHONY_SIP_REGISTERING',30000);return;}
 }else{
  if(job.stage==='external_validate'){
   if((await worker.fenced(job,()=>worker.host.calls())).active!==0||DB.get("SELECT 1 FROM ava_phone_calls WHERE phoneId=? AND state='reserved'",[p.id])){worker.defer(job,'TELEPHONY_CALLS_DRAINING',30000);return;}
   const ips=await worker.fenced(job,()=>addresses(config.host));guard();input={...input,addresses:ips,fingerprint:digest({...config,addresses:ips,revision:p.generation})};
   DB.run('UPDATE ava_phone_operations SET inputJson=? WHERE id=? AND leaseToken=?',[JSON.stringify(input),job.id,job.leaseToken]);job.inputJson=JSON.stringify(input);worker.advance(job,'external_apply_ready');
  }
  const observed=await worker.fenced(job,()=>worker.host.externalStatus(p));
  if(!(observed.configured&&observed.revision===p.generation&&observed.fingerprint===input.fingerprint)){
   if(observed.configured!==false&&observed.revision>=p.generation)fail('TELEPHONY_EXTERNAL_OUTCOME_UNKNOWN',409);
   if((await worker.fenced(job,()=>worker.host.calls())).active!==0){worker.defer(job,'TELEPHONY_CALLS_DRAINING',30000);return;}
   guard();worker.advance(job,'external_apply_dispatching');await worker.fenced(job,()=>worker.host.applyExternal(p,{...config,addresses:input.addresses,fingerprint:input.fingerprint}));
  }
  const final=record(p,await worker.fenced(job,()=>worker.host.externalStatus(p)),worker.now());
  if(!final.configured||final.revision!==p.generation||final.fingerprint!==input.fingerprint||!final.registered){worker.defer(job,'TELEPHONY_SIP_REGISTERING',30000);return;}
 }
 Store.transaction(()=>{
  guard();p=Store.phone(p.id);
  if(p.state==='provisioning'){
   const aliases=DB.get('SELECT sipAliases FROM instances WHERE id=?',[p.businessId]);
   const had=DB.get('SELECT 1 FROM business_sip_aliases WHERE alias=? AND businessId=?',[p.number,p.businessId]);
   DB.run("INSERT OR IGNORE INTO ava_phone_existing_profiles(phoneId,mode,aliasExisted) VALUES(?,'external',?)",[p.id,had?1:0]);
   if(input.previousNumber&&input.previousNumber!==p.number){DB.run('DELETE FROM business_sip_aliases WHERE alias=? AND businessId=?',[input.previousNumber,p.businessId]);DB.run('UPDATE instances SET sipAliases=? WHERE id=?',[JSON.stringify(JSON.parse(aliases.sipAliases||'[]').filter(n=>n!==input.previousNumber)),p.businessId]);}
   Store.activate(job,worker.now(),{external:true});
  }else{DB.run("UPDATE ava_phone_numbers SET inboundReady=1,outboundReady=1 WHERE id=? AND state='active'",[p.id]);worker.advance(job,'checked',{state:'done',errorCode:null});}
 });
}
async function maintenance(worker){
 try{Store.setMeta('external_sip_capabilities',await worker.host.externalCapabilities(),worker.now());}catch{Store.setMeta('external_sip_capabilities',{available:false,transports:[]},worker.now());}
 for(const p of DB.all("SELECT * FROM ava_phone_numbers WHERE origin='external' AND state='active'")){
  try{const observed=record(p,await worker.host.externalStatus(p),worker.now());DB.run("UPDATE ava_phone_numbers SET inboundReady=?,outboundReady=? WHERE id=? AND state='active' AND generation=?",[observed.configured&&observed.registered&&observed.revision===p.generation?1:0,observed.configured&&observed.registered&&observed.revision===p.generation?1:0,p.id,p.generation]);}catch{Store.setMeta('external_sip:'+p.id,{configured:false,registered:false,revision:p.generation},worker.now());DB.run("UPDATE ava_phone_numbers SET inboundReady=0,outboundReady=0 WHERE id=? AND generation=?",[p.id,p.generation]);}
 }
}
module.exports={normalize,addresses,request,requestByKey,ownerRoute,overview,publicTrunk,run,maintenance};
