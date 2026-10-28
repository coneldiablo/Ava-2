'use strict';
// The repository runner uses its own sequential queue. Do not start node:test
// asynchronously when this file is required by tests/run-tests.js.
const {test,beforeEach,afterEach}=require.main===module?require('node:test'):(()=>{
    const {it}=require('./test-helper');let setup=()=>{},cleanup=()=>{};
    return {beforeEach:fn=>{setup=fn;},afterEach:fn=>{cleanup=fn;},
        test:(name,fn)=>it(name,async()=>{try {await setup();await fn();} finally {await cleanup();}})};
})();
const assert=require('node:assert/strict');
const {createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Identity=require('../src/services/identity/identity-store');
const Provisioning=require('../src/services/provisioning/business-provisioning-store.service');
const Store=require('../src/services/telephony/store');
const Service=require('../src/services/telephony/service');
const {PhoneWorker,prices}=require('../src/services/telephony/worker');
const {ExolveClient}=require('../src/services/telephony/exolve-client');
const Policy=require('../src/services/telephony/policy');
const Vault=require('../src/services/telephony/credentials');
let now,owner,other,provider,host,worker,previous;
const numberOptions={incoming_calls:true,outgoing_calls:true};
function free(number='74951110001') {return {number_code:number,number_options:numberOptions,install_fee:'590',subscription_fee:'150'};}
function fakeProvider() {
    const calls={buy:0,sip:0,delete:0,deleteSip:0,lock:0};let inventory=[],sips=[];
    return {token:'test-only',applicationId:'app',calls,
        catalog:async()=>({types:[{type_id:1104,type_name:'DEF'},{type_id:1106,type_name:'KDU'}],regions:[{region_id:10230,description:'Москва'}]}),
        free:async({mask}={})=>[free(mask || '74951110001')],fees:async()=>({install_fee:0,subscription_fee:90}),balance:async()=>({balance:'100000'}),
        lock:async()=>{calls.lock++;return {Id:'123'};},unlock:async()=>({}),
        buy:async(number)=>{calls.buy++;inventory.push({number_name:number,application_uuid:'app',number_options:numberOptions,install_fee:'590',subscription_fee:'150'});return {};},
        inventory:async()=>inventory,
        createSip:async(name,number)=>{calls.sip++;sips.push({sip_name:name,cli:number,sip_resource_id:String(calls.sip),application_uuid:'app'});return {sip_resource_id:String(calls.sip)};},
        sips:async()=>sips,
        sip:async(id)=>{const s=sips.find(s=>s.sip_resource_id===id);return {...s,attributes:{cli:s.cli,login:'883140123456789',password:'test-secret',domain:'sip.exolve.ru',install_fee:0,subscription_fee:90}};},
        forwarding:async(number,ip,port)=>{const n=inventory.find(n=>n.number_name===number);n.call_forwarding_flag=true;n.call_forwarding_ip_static={did_name:number,ip,port};return {};},
        deleteNumber:async(number)=>{calls.delete++;inventory=inventory.filter(n=>n.number_name!==number);return {};},
        deleteSip:async(id)=>{calls.deleteSip++;sips=sips.filter(s=>s.sip_resource_id!==id);return {};},
    };
}
function quote(businessId=1,number='74951110001',overrides={}) {
    const row={id:Store.uuid(),businessId,number,typeId:1104,regionId:10230,categoryId:10000,
        installKopecks:59000,monthlyKopecks:24000,numberInstall:59000,numberMonthly:15000,sipInstall:0,sipMonthly:9000,
        expiresAt:now+120000,createdAt:now,...overrides};
    const cols=Object.keys(row);DB.run(`INSERT INTO ava_phone_quotes(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`,Object.values(row));return row;
}
function order(businessId=1,number='74951110001',key=Store.uuid()) {const q=quote(businessId,number);return Store.createOrder(businessId,q.id,key,businessId===1?'owner':'other',now);}
beforeEach(()=>{
    previous={...process.env};now=Date.now();
    Object.assign(process.env,{AVA_TELEPHONY_PURCHASE_ENABLED:'true',AVA_TELEPHONY_PILOT_BUSINESSES:'1,2',AVA_TELEPHONY_OUTBOUND_ENABLED:'true',
        EXOLVE_APPLICATION_UUID:'app',EXOLVE_STATIC_IP:'203.0.113.10',AVA_TELEPHONY_MASTER_KEY:'a'.repeat(64)});
    if(DB.db?.open)DB.db.close();createTestDB();Identity.ensureSchema();Store.ensureSchema();
    Provisioning.createBusinessAtomic({name:'A'});Provisioning.createBusinessAtomic({name:'B'});
    for(const [id,biz,role] of [['owner',1,'hotel_owner'],['other',2,'hotel_owner'],['manager',1,'manager'],['observer',1,'observer']]){
        DB.run('INSERT INTO ava_users(id,subject,email,displayName) VALUES(?,?,?,?)',[id,id,id+'@test.local',id]);
        DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)',[id,biz,role]);
    }
    owner=Identity.actor('owner');other=Identity.actor('other');Store.setMeta('balance',{kopecks:10000000},now);
    provider=fakeProvider();host={health:async()=>({ingressReady:true}),apply:async()=>({}),status:async()=>({registered:true}),remove:async()=>({}),calls:async()=>({active:0})};
    worker=new PhoneWorker({provider,host,now:()=>now});
});
afterEach(()=>{process.env=previous;});
test('strict decimal money and both directions; missing prices never mean free',()=>{
    assert.equal(Policy.kopecks('0.01'),1);assert.equal(Policy.kopecks('590'),59000);
    for(const x of [null,undefined,'NaN',Infinity,-1,'0.001','1e3'])assert.throws(()=>Policy.kopecks(x));
    assert.throws(()=>prices({...free(),install_fee:undefined},{install_fee:0,subscription_fee:90}));
    assert.throws(()=>prices({...free(),number_options:{incoming_calls:true}},{install_fee:0,subscription_fee:90}));
});
test('idempotent order, different payload conflict, quota includes every unfinished state',()=>{
    const q=quote(),key=Store.uuid(),a=Store.createOrder(1,q.id,key,'owner',now);
    assert.equal(Store.createOrder(1,q.id,key,'owner',now).id,a.id);
    assert.throws(()=>Store.createOrder(1,quote(1,'74951110002').id,key,'owner',now),{code:'TELEPHONY_IDEMPOTENCY_CONFLICT'});
    order(1,'74951110002');order(1,'74951110003');
    assert.throws(()=>order(1,'74951110004'),{code:'TELEPHONY_NUMBER_LIMIT'});
    assert.equal(provider.calls.buy,0);
});
test('price cap includes SIP, stale quote and stale balance rejected before purchase',()=>{
    const q=quote(1,'74951110001',{monthlyKopecks:50001});
    assert.throws(()=>Store.createOrder(1,q.id,Store.uuid(),'owner',now),{code:'TELEPHONY_PRICE_LIMIT'});
    const expired=quote(1,'74951110002',{expiresAt:now});
    assert.throws(()=>Store.createOrder(1,expired.id,Store.uuid(),'owner',now),{code:'TELEPHONY_QUOTE_EXPIRED'});
    Store.setMeta('balance',{kopecks:10000000},now-90001);
    assert.throws(()=>order(),{code:'TELEPHONY_BALANCE_PENDING'});
});
test('happy purchase configures own DID, encrypted SIP credentials and profile projections',async()=>{
    const job=order();assert.equal(await worker.processOne(),true);
    assert.equal(Store.operation(job.id).state,'done');
    const p=Store.phone(job.phoneId);assert.equal(p.state,'active');assert.equal(p.isPrimary,1);
    assert.deepEqual([provider.calls.buy,provider.calls.sip],[1,1]);
    assert.equal(Store.resolve(p.number).businessId,1);assert.equal(Store.source(1).phoneId,p.id);
    assert.equal(DB.get('SELECT sipCallerId FROM instances WHERE id=1').sipCallerId,p.number);
    assert(!JSON.stringify(Service.overview(owner,1)).includes('test-secret'));
    assert(!p.encryptedCredentials.includes('test-secret'));assert.equal(Vault.decrypt(p.encryptedCredentials,p).password,'test-secret');
    assert.throws(()=>Vault.decrypt(p.encryptedCredentials,{...p,businessId:2}));
});
test('paid Buy response lost: reconcile ownership, never replay Buy',async()=>{
    const original=provider.buy;provider.buy=async n=>{await original(n);throw Object.assign(new Error('lost'),{uncertain:true,code:'TELEPHONY_PROVIDER_ERROR'});};
    const job=order();await worker.processOne();assert.equal(Store.operation(job.id).stage,'buy_dispatching');
    assert.equal(Store.operation(job.id).state,'reconciling');now+=31000;await worker.processOne();
    assert.equal(Store.operation(job.id).state,'done');assert.equal(provider.calls.buy,1);
});
test('worker crash at buy dispatch without result never retries purchase or frees quota',async()=>{
    const job=order(),leased=Store.lease(now);Store.advance(leased,'buy_dispatching',{},now);
    now+=61000;await worker.processOne();now+=31000;await worker.processOne();
    assert.equal(provider.calls.buy,0);assert.equal(Store.operation(job.id).state,'reconciling');
    assert.equal(Store.phone(job.phoneId).state,'provisioning');
});
test('SIP create response lost is recovered by deterministic name without another SIP',async()=>{
    const original=provider.createSip;provider.createSip=async(...args)=>{await original(...args);throw Object.assign(new Error('lost'),{uncertain:true,code:'TELEPHONY_PROVIDER_ERROR'});};
    const job=order();await worker.processOne();now+=31000;await worker.processOne();
    assert.equal(Store.operation(job.id).state,'done');assert.equal(provider.calls.sip,1);
});
test('revoked owner after purchase cannot activate and only new order resources are compensated',async()=>{
    const original=provider.buy;provider.buy=async n=>{await original(n);DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='owner'");return {};};
    const job=order();await worker.processOne();
    assert.equal(Store.phone(job.phoneId).state,'released');assert.equal(provider.calls.delete,1);
    assert.equal(provider.calls.sip,0);assert.equal(Store.operation(job.id).state,'failed');
});
test('two tenants isolated; second number does not replace primary; manual alias bypass rejected',async()=>{
    const a=order();await worker.processOne();const b=order(2,'74951110002');await worker.processOne();
    const a2=order(1,'74951110003');await worker.processOne();
    assert.equal(Store.resolve('74951110002').businessId,2);assert.equal(Store.source(1).phoneId,a.phoneId);
    assert.throws(()=>Store.source(1,b.phoneId),{code:'TELEPHONY_SOURCE_UNAVAILABLE'});
    assert.throws(()=>Store.protectProfile(2,{sipAliases:['74951110001']}));
    assert.throws(()=>Provisioning.createBusinessAtomic({name:'Thief',sipAliases:['74951110001']}));
    assert.throws(()=>Store.resolve('74959999999'),{code:'TELEPHONY_DID_UNAVAILABLE'});
    Store.primary(1,a2.phoneId);assert.equal(Store.source(1).phoneId,a2.phoneId);
});
test('atomic minute reservations, one call, 10-second interval, daily exhaustion and Moscow midnight',async()=>{
    // Keep this quota case away from midnight. finishCall prorates a five-minute
    // call over the real Moscow day boundary; a wall-clock run just after 00:00
    // otherwise correctly charges only its part after midnight, not all 300s.
    now=Date.parse('2026-10-12T12:00:00Z');Store.setMeta('balance',{kopecks:10000000},now);
    const job=order();await worker.processOne();
    const first=Store.reserveCall({businessId:1,callId:'call-1'},now);assert.equal(first.maxSeconds,300);
    assert.throws(()=>Store.reserveCall({businessId:1,callId:'call-2'},now),{code:'TELEPHONY_CONCURRENT_LIMIT'});
    Store.finishCall('call-1',{businessId:1,seconds:300},now);
    assert.throws(()=>Store.reserveCall({businessId:1,callId:'call-2'},now),{code:'TELEPHONY_INTERVAL_LIMIT'});
    for(let i=2;i<=6;i++){now+=11000;Store.reserveCall({businessId:1,callId:'call-'+i},now);Store.finishCall('call-'+i,{businessId:1,seconds:300},now);}
    now+=11000;assert.throws(()=>Store.reserveCall({businessId:1,callId:'call-7'},now),{code:'TELEPHONY_DAILY_LIMIT'});
    assert.equal(Policy.day(Date.parse('2026-10-12T21:00:00Z')),'2026-10-13');
    now+=86400000;assert.equal(Store.reserveCall({businessId:1,callId:'call-8'},now).maxSeconds,300);
});
test('owner release is reversible during grace, rejects incoming immediately, releases after seven days',async()=>{
    const job=order();await worker.processOne();Store.release(1,job.phoneId,false,now);
    assert.throws(()=>Store.resolve('74951110001'));assert.equal(provider.calls.delete,0);
    now+=4*86400000;await worker.maintenance();assert.equal(Store.phone(job.phoneId).warningAt,now);
    Store.release(1,job.phoneId,true,now);assert.equal(Store.resolve('74951110001').businessId,1);
    Store.release(1,job.phoneId,false,now);now+=7*86400000;await worker.processOne();
    assert.equal(Store.phone(job.phoneId).state,'released');assert.equal(provider.calls.delete,1);assert.equal(provider.calls.deleteSip,1);
    await worker.processOne();assert.equal(provider.calls.delete,1);
});
test('business deactivation and reactivation cancel scheduled release without buying again',async()=>{
    const job=order();await worker.processOne();DB.run('UPDATE instances SET isActive=0 WHERE id=1');
    assert.equal(Store.phone(job.phoneId).state,'grace');assert.throws(()=>Store.source(1));
    DB.run('UPDATE instances SET isActive=1 WHERE id=1');await worker.maintenance();
    assert.equal(Store.phone(job.phoneId).state,'active');assert.equal(provider.calls.buy,1);
});
test('owner/read roles enforced, foreign operations and number mutations denied',()=>{
    for(const id of ['manager','observer']){
        assert(Service.overview(Identity.actor(id),1).success);
        assert.throws(()=>Service.order(Identity.actor(id),1,{quoteId:'fake'},Store.uuid()));
    }
    const job=order();assert.throws(()=>Service.getOperation(other,2,job.id),{code:'TELEPHONY_ORDER_NOT_FOUND'});
    assert.throws(()=>Service.overview(owner,2));
});
test('provider uses documented SIP list path/pagination and never retries paid actions or exposes raw errors',async()=>{
    const requests=[];const client=new ExolveClient({token:'never-print-this',applicationId:'app',sleep:async()=>{},request:async o=>{
        requests.push(o);return {data:{sips:o.data.offset===0?Array.from({length:100},(_,i)=>({sip_resource_id:i,application_uuid:'app',sip_name:'test-'+i})):[]}};}});
    assert.equal((await client.sips()).length,100);assert.equal(requests.length,2);
    assert(requests[0].url.endsWith('/number/customer/v1/GetSIPList'));
    let count=0;client.request=async()=>{count++;throw {response:{status:500,data:'never-print-this'},config:{headers:{Authorization:'secret'}}};};
    await assert.rejects(()=>client.buy('74951110001','1'),e=>e.uncertain && !JSON.stringify(e).includes('secret'));
    assert.equal(count,1);count=0;await assert.rejects(()=>client.balance());assert.equal(count,3);
});

test('catalog and city quotes sanitize provider fields, reject malformed inputs and deduplicate numbers',async()=>{
    provider.catalog=async()=>({types:[{type_id:1105,type_name:'ABC',secret:'hidden'},null,{type_id:1106}],
        regions:[{region_id:10230,description:'Москва',secret:'hidden'},null]});
    let op=Service.catalog(owner,1).operation;now=Date.now();await worker.processOne();
    assert.deepEqual(Store.publicOperation(Store.operation(op.id)).result,{types:[{type_id:1105,type_name:'ABC'}],regions:[{id:10230,name:'Москва'}]});
    assert(!JSON.stringify(Service.catalog(owner,1)).includes('hidden'));
    const original=provider.free;
    provider.free=async input=>{assert.equal(input.type_id,1105);assert.equal(input.category_id,10001);
        return [free(),free(),free('74951110002'),{...free('74951110003'),subscription_fee:undefined},null];};
    op=Service.quotes(owner,1,{typeId:1105,regionId:10230}).operation;now=Date.now();await worker.processOne();
    const result=Store.publicOperation(Store.operation(op.id)).result;
    assert.equal(result.quotes.length,2);assert.equal(result.quotes[0].monthlyKopecks,24000);
    now+=1;provider.free=original;
    op=Service.quotes(owner,1,{typeId:1104,regionId:10230}).operation;now=Date.now();await worker.processOne();
    assert.equal(Store.operation(op.id).state,'failed');assert.equal(provider.calls.buy,0);
});

test('price changed or another free number is returned: no lock or purchase',async()=>{
    let job=order();provider.free=async()=>[{...free(),install_fee:591}];await worker.processOne();
    assert.equal(Store.operation(job.id).errorCode,'TELEPHONY_PRICE_CHANGED');assert.equal(Store.phone(job.phoneId).state,'released');
    provider.free=async()=>[free('74951119999')];job=order();await worker.processOne();
    assert.equal(Store.operation(job.id).errorCode,'TELEPHONY_NUMBER_NO_LONGER_FREE');
    assert.deepEqual([provider.calls.lock,provider.calls.buy],[0,0]);
});

test('definitive Buy rejection releases only the lock and the money reservation',async()=>{
    let unlocks=0;provider.unlock=async()=>{unlocks++;return {};};
    provider.buy=async()=>{provider.calls.buy++;throw Object.assign(new Error('rejected'),{code:'TELEPHONY_PROVIDER_ERROR',uncertain:false});};
    const job=order();await worker.processOne();
    assert.equal(Store.operation(job.id).state,'failed');assert.equal(Store.reservedSpend(),0);
    assert.equal(Store.phone(job.phoneId).state,'released');
    assert.deepEqual([provider.calls.buy,provider.calls.delete,unlocks],[1,0,1]);
});

test('lost SIP Delete and number Delete responses are reconciled without replay',async()=>{
    const job=order();await worker.processOne();Store.release(1,job.phoneId,false,now);now+=7*86400000;
    const deleteSip=provider.deleteSip;provider.deleteSip=async id=>{await deleteSip(id);throw Object.assign(new Error('lost'),{code:'TELEPHONY_PROVIDER_ERROR',uncertain:true});};
    const deleteNumber=provider.deleteNumber;provider.deleteNumber=async n=>{await deleteNumber(n);throw Object.assign(new Error('lost'),{code:'TELEPHONY_PROVIDER_ERROR',uncertain:true});};
    await worker.processOne();assert.equal(Store.phone(job.phoneId).state,'releasing');
    now+=31000;await worker.processOne();assert.equal(Store.phone(job.phoneId).state,'releasing');
    now+=31000;await worker.processOne();assert.equal(Store.phone(job.phoneId).state,'released');
    assert.deepEqual([provider.calls.deleteSip,provider.calls.delete],[1,1]);
});

test('unknown deletion that did not take effect never sends Delete again during reconciliation',async()=>{
    const job=order();await worker.processOne();Store.release(1,job.phoneId,false,now);now+=7*86400000;
    provider.deleteSip=async()=>{provider.calls.deleteSip++;throw Object.assign(new Error('lost'),{uncertain:true});};
    await worker.processOne();now+=31000;await worker.processOne();
    assert.equal(provider.calls.deleteSip,1);assert.equal(provider.calls.delete,0);
    assert.equal(Store.phone(job.phoneId).state,'releasing');
});

test('active call holds release until finish and aggregate status follows the remaining numbers',async()=>{
    const a=order();await worker.processOne();const b=order(1,'74951110002');await worker.processOne();
    Store.reserveCall({businessId:1,sourceId:a.phoneId,callId:'live'},now);host.calls=async()=>({active:1});
    Store.release(1,a.phoneId,false,now);now+=7*86400000;await worker.processOne();assert.equal(provider.calls.delete,0);
    Store.finishCall('live',{businessId:1,seconds:60,channelId:'channel-1'},now);host.calls=async()=>({active:0});now+=31000;await worker.processOne();
    assert.equal(Store.source(1).phoneId,b.phoneId);
    assert.equal(DB.get("SELECT status FROM business_provisioning_jobs WHERE businessId=1 AND module='telephony_sip'").status,'DONE');
    Store.release(1,b.phoneId,false,now);
    assert.equal(DB.get("SELECT status FROM business_provisioning_jobs WHERE businessId=1 AND module='telephony_sip'").status,'BLOCKED');
    now+=7*86400000;await worker.processOne();
    assert.equal(DB.get("SELECT status FROM business_provisioning_jobs WHERE businessId=1 AND module='telephony_sip'").status,'SKIPPED');
    assert.equal(Service.overview(owner,1).managedMode,false);assert.deepEqual(Store.source(1),{managed:false});
});

test('reactivation cancels queued unsent release, including a leased release after host drain await',async()=>{
    const job=order();await worker.processOne();DB.run('UPDATE instances SET isActive=0 WHERE id=1');now+=8*86400000;
    await worker.maintenance();assert.equal(Store.phone(job.phoneId).state,'releasing');
    DB.run('UPDATE instances SET isActive=1 WHERE id=1');await worker.maintenance();
    assert.equal(Store.phone(job.phoneId).state,'active');assert.equal(provider.calls.delete,0);
    const release=DB.get("SELECT * FROM ava_phone_operations WHERE kind='release'");assert.equal(release.state,'canceled');
    DB.run('UPDATE instances SET isActive=0 WHERE id=1');now+=8*86400000;await worker.maintenance();
    host.calls=async()=>{DB.run('UPDATE instances SET isActive=1 WHERE id=1');return {active:0};};
    worker.lastMaintenance=now;await worker.processOne();
    assert.equal(Store.phone(job.phoneId).state,'active');assert.equal(provider.calls.delete,0);
});

test('maintenance failure does not block independent queued work',async()=>{
    const job=order();await worker.processOne();Store.release(1,job.phoneId,false,now);now+=7*86400000;
    provider.balance=async()=>{throw new Error('balance unavailable');};provider.inventory=async()=>{throw new Error('inventory unavailable');};
    const op=Store.request(1,'catalog',{},'owner',now);await worker.processOne();
    assert.equal(Store.operation(op.id).state,'done');
    assert.equal(Store.phone(job.phoneId).state,'releasing');
    assert(DB.get("SELECT id FROM ava_phone_alerts WHERE code='TELEPHONY_RECONCILIATION_UNAVAILABLE'"));
});

test('paid terminal spend survives immediate cached balance, elapsed timer and reads started inside the 120-second window',async()=>{
    Store.setMeta('balance',{kopecks:83000},now);const job=order();await worker.processOne();
    const completedAt=now,deadline=completedAt+120000;
    assert.equal(Store.operation(job.id).spendHoldUntil,deadline);
    assert.equal(Store.reservedSpend(),83000);
    // Even a read begun after completion can still return Exolve's old balance.
    now=completedAt+1;Store.recordBalance(83000,now,now);
    assert.equal(Store.reservedSpend(),83000);
    // A response received after the window is insufficient if its read began inside it.
    now=deadline+1;Store.recordBalance(83000,deadline-1,now);
    assert.equal(Store.reservedSpend(),83000);
    Store.recordBalance(83000,deadline,now);
    assert.equal(Store.reservedSpend(),83000);
    // Passing time alone and refreshing metadata must not free the held budget.
    now=deadline+60000;Store.setMeta('balance',{kopecks:83000},now);
    assert.equal(Store.reservedSpend(),83000);
    assert.throws(()=>order(2,'74951110002'),{code:'TELEPHONY_BALANCE_LOW'});
    Store.recordBalance(83000,completedAt-1,now);assert.equal(Store.reservedSpend(),83000);
    now+=1;Store.recordBalance(0,now,now);assert.equal(Store.reservedSpend(),0);
    assert.equal(Store.operation(job.id).spendHoldUntil,null);
    Store.recordBalance(1000000,completedAt,now+1);assert.equal(JSON.parse(Store.meta('balance').value).kopecks,0);
});

test('concurrent orders cannot reuse the cached pre-purchase balance during terminal settlement',async()=>{
    provider.balance=async()=>({balance:'1000'});Store.setMeta('balance',{kopecks:100000},now);
    const first=order();await worker.processOne();assert.equal(provider.calls.buy,1);
    const completedAt=now;now+=1;await worker.balance();
    assert.equal(JSON.parse(Store.meta('balance').value).kopecks,100000);
    assert.equal(Store.reservedSpend(),83000);
    const requests=[quote(1,'74951110002'),quote(2,'74951110003')];
    const outcomes=await Promise.allSettled(requests.map((q,index)=>Promise.resolve().then(()=>
        Store.createOrder(q.businessId,q.id,Store.uuid(),index===0?'owner':'other',now))));
    assert(outcomes.every(r=>r.status==='rejected' && r.reason.code==='TELEPHONY_BALANCE_LOW'));
    assert.equal(DB.get("SELECT COUNT(*) AS n FROM ava_phone_operations WHERE kind='purchase'").n,1);
    assert.equal(provider.calls.buy,1);
    now=completedAt+120001;provider.balance=async()=>({balance:'170'});await worker.balance();
    assert.equal(Store.reservedSpend(),0);
    assert.equal(JSON.parse(Store.meta('balance').value).kopecks,17000);
    assert.throws(()=>order(2,'74951110003'),{code:'TELEPHONY_BALANCE_LOW'});
    assert.equal(Store.operation(first.id).state,'done');
});

test('paid compensation and legacy terminal rows retain the same settlement protection; unpaid failures reserve nothing',async()=>{
    const original=provider.buy;provider.buy=async n=>{await original(n);(await provider.inventory())[0].subscription_fee='151';return {};};
    const compensated=order();await worker.processOne();
    assert.equal(Store.operation(compensated.id).state,'failed');
    const completedAt=now;assert.equal(Store.operation(compensated.id).spendHoldUntil,completedAt+120000);
    now+=1;Store.recordBalance(100000,now,now);assert.equal(Store.reservedSpend(),83000);
    // Existing terminal rows created by the previous worker have a null deadline.
    DB.run('UPDATE ava_phone_operations SET spendHoldUntil=NULL WHERE id=?',[compensated.id]);
    now=completedAt+119999;Store.recordBalance(100000,now,now);assert.equal(Store.reservedSpend(),83000);
    now=completedAt+120001;Store.recordBalance(17000,now,now);assert.equal(Store.reservedSpend(),0);
    Store.setMeta('balance',{kopecks:10000000},now);
    provider.buy=original;provider.free=async()=>[{...free(),install_fee:591}];
    const unpaid=order();await worker.processOne();
    assert.equal(Store.operation(unpaid.id).state,'failed');
    assert.equal(Store.operation(unpaid.id).spendReserved,0);assert.equal(Store.operation(unpaid.id).spendHoldUntil,null);
});

test('shared account reservations are atomic across tenants and manual unknown orders keep the budget',()=>{
    Store.setMeta('balance',{kopecks:100000},now);const job=order();
    assert.throws(()=>order(2,'74951110002'),{code:'TELEPHONY_BALANCE_LOW'});
    const lease=Store.lease(now);Store.advance(lease,'buy_dispatching',{},now);worker.manual(lease,'TELEPHONY_PURCHASE_RECONCILING');
    now+=86400000;Store.recordBalance(100000,now,now);
    assert.equal(Store.reservedSpend(),83000);assert.throws(()=>order(2,'74951110002'),{code:'TELEPHONY_BALANCE_LOW'});
    assert.equal(Store.phone(job.phoneId).state,'manual');
});

test('expired lease cannot defer or mutate another worker checkpoint; stale reads cannot dispatch Buy',async()=>{
    const job=order();const first=Store.lease(now);now+=61000;const second=Store.lease(now);
    Store.defer(first,'old',now);assert.equal(Store.operation(job.id).leaseToken,second.leaseToken);
    assert.throws(()=>Store.advance(first,'buy_dispatching',{},now),{code:'TELEPHONY_LEASE_LOST'});
    const original=provider.free;provider.free=async input=>{const result=await original(input);now+=61000;return result;};
    await assert.rejects(()=>worker.purchase(second),{code:'TELEPHONY_LEASE_LOST'});assert.equal(provider.calls.buy,0);
});

test('two workers racing the same purchase only dispatch Buy once',async()=>{
    const job=order();const second=new PhoneWorker({provider,host,now:()=>now});
    worker.lastMaintenance=second.lastMaintenance=now;
    await Promise.all([worker.processOne(),second.processOne()]);
    assert.equal(Store.operation(job.id).state,'done');assert.equal(provider.calls.buy,1);
});

test('manual profile guards cover foreign DID and endpoint in every manual field, inside create transaction after replay',async()=>{
    const job=order();await worker.processOne();const p=Store.phone(job.phoneId);
    for(const values of [{sipTrunkNumber:p.endpoint},{sipCallerId:p.endpoint},{sipAliases:[p.endpoint]},
        {sipTrunkNumber:'+7 (495) 111-00-01'},{sipCallerId:p.number},{sipAliases:[p.number]}]) {
        assert.throws(()=>Store.protectProfile(2,values));
        assert.throws(()=>Provisioning.createBusinessAtomic({name:'Thief',...values}));
    }
    const data={name:'Existing',sipAliases:['74951110009']};
    const first=Provisioning.createBusinessAtomic(data,{idempotencyKey:'existing-business'});
    // A later managed migration must not break retry of the original create request.
    DB.run("UPDATE ava_phone_numbers SET number=?,businessId=? WHERE id=?",['74951110009',first.instance.id,p.id]);
    const replay=Provisioning.createBusinessAtomic(data,{idempotencyKey:'existing-business'});
    assert.equal(replay.instance.id,first.instance.id);assert.equal(replay.isExisting,true);
});

test('strict inbound scope, legacy calls and public projections never expose private SIP fields',async()=>{
    const job=order();await worker.processOne();
    assert.throws(()=>Store.reserveCall({businessId:2,callId:'foreign',direction:'inbound',number:'74951110001'},now),{code:'TELEPHONY_SCOPE_MISMATCH'});
    assert.throws(()=>Store.reserveCall({businessId:1,callId:'bad',direction:'other'},now),{code:'TELEPHONY_CALL_INVALID'});
    Store.reserveCall({businessId:1,callId:'in',direction:'inbound',number:'74951110001'},now);
    assert.throws(()=>Store.reserveCall({businessId:1,callId:'in',direction:'inbound',number:'74951110002'},now),{code:'TELEPHONY_CALL_CONFLICT'});
    DB.run('INSERT INTO business_sip_aliases(alias,businessId) VALUES(?,?)',['74951110009',1]);
    process.env.AVA_TELEPHONY_LEGACY_DIDS=JSON.stringify({'74951110009':1});
    assert.equal(Store.reserveCall({businessId:1,callId:'legacy',direction:'inbound',number:'74951110009'},now).managed,false);
    assert.equal(DB.get("SELECT count(*) AS n FROM ava_phone_calls WHERE id='legacy'").n,0);
    const output=JSON.stringify(Service.overview(owner,1));
    for(const secret of ['encryptedCredentials','sipName','sipResourceId','ava-phone-','test-secret','applicationId']) assert(!output.includes(secret));
});

test('malformed or truncated inventory cannot authorize deletion and paid malformed responses remain uncertain',async()=>{
    const client=new ExolveClient({token:'test-only',applicationId:'app',sleep:async()=>{},request:async()=>({data:{numbers:[],total:1}})});
    await assert.rejects(()=>client.inventory(),{code:'TELEPHONY_INVENTORY_INCOMPLETE'});
    client.request=async()=>({data:{numbers:[null]}});await assert.rejects(()=>client.inventory(),{code:'TELEPHONY_PROVIDER_RESPONSE_INVALID'});
    client.request=async()=>({data:{}});await assert.rejects(()=>client.free({}),{code:'TELEPHONY_PROVIDER_RESPONSE_INVALID'});
    client.request=async()=>({data:[]});await assert.rejects(()=>client.buy('74951110001','1'),e=>e.uncertain===true);
});

test('real HTTP boundary: owner/manage/read roles, tenant isolation, origin, internal service token and secret-free responses',async()=>{
    const express=require('express'),http=require('http');
    const Auth=require('../src/services/auth.service');const oldConfig=Auth.config;
    process.env.AVA_CUSTOMER_ACCESS_ENABLED='true';process.env.WHATSAPP_CRM_PUBLIC_URL='https://ava.test';
    process.env.CRM_SERVICE_API_TOKEN='local-test-service-token';Auth.config={...oldConfig,enabled:true};
    const app=express();app.use(express.json());
    app.use('/api/internal/telephony',Auth.requireServiceToken.bind(Auth),require('../src/routes/telephony-internal.routes'));
    app.use('/api',Auth.requireAuth.bind(Auth),require('../src/services/identity/customer-role-boundary'),require('../src/routes/telephony.routes'));
    const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const tokens=Object.fromEntries(['owner','other','manager','observer'].map(id=>[id,Identity.createSession(id,id+'-native-session')]));
    const headers=id=>({Cookie:`crm_session=ava2:${tokens[id]}`,Origin:'https://ava.test'});
    const request=(path,{method='GET',body={},headers:extra={}}={})=>new Promise((resolve,reject)=>{
        const data=method==='GET'?'':JSON.stringify(body);
        const req=http.request({host:'127.0.0.1',port:server.address().port,path,method,
            headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),...extra}},res=>{
                const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks)),headers:res.headers}));});
        req.on('error',reject);req.end(data);
    });
    const base='/api/businesses/1/telephony';
    try {
        assert.equal((await request(base)).status,401);
        for(const role of ['manager','observer']) {
            const overview=await request(base,{headers:headers(role)});assert.equal(overview.status,200);assert.equal(overview.body.canManage,false);
            assert.equal((await request(base+'/orders',{method:'POST',headers:headers(role),body:{quoteId:'fake'}})).status,403);
        }
        const q=quote(),key=Store.uuid();
        let result=await request(base+'/orders',{method:'POST',headers:{Cookie:headers('owner').Cookie,'Idempotency-Key':key},body:{quoteId:q.id}});
        assert.equal(result.status,403);assert.equal(result.body.code,'CUSTOMER_ORIGIN_REQUIRED');
        result=await request(base+'/orders',{method:'POST',headers:{...headers('owner'),Origin:'https://foreign.test','Idempotency-Key':key},body:{quoteId:q.id}});assert.equal(result.status,403);
        result=await request(base+'/orders',{method:'POST',headers:{...headers('owner'),'Sec-Fetch-Site':'cross-site','Idempotency-Key':key},body:{quoteId:q.id}});assert.equal(result.status,403);
        const buy=()=>request(base+'/orders',{method:'POST',headers:{...headers('owner'),'Idempotency-Key':key},body:{quoteId:q.id}});
        result=await buy();assert.equal(result.status,202);const id=result.body.operation.id;
        assert.equal((await buy()).body.operation.id,id);assert.equal(provider.calls.buy,0);
        assert.equal((await request('/api/businesses/2/telephony',{headers:headers('owner')})).status,403);
        assert.equal((await request('/api/businesses/2/telephony/orders/'+id,{headers:headers('other')})).status,404);
        assert.equal((await request(base+'/orders',{method:'POST',headers:{...headers('owner'),'Idempotency-Key':Store.uuid()},body:{quoteId:quote(2,'74951110002').id}})).status,409);
        assert.equal((await request(base+'/quotes',{method:'POST',headers:headers('owner'),body:{typeId:1104,regionId:10230,businessId:2}})).status,403);
        assert.equal((await request(base+'/quotes',{method:'POST',headers:headers('owner'),body:{typeId:1104,regionId:10230,password:'never-echo'}})).status,400);
        now=Date.now();await worker.processOne();const p=Store.phone(Store.operation(id).phoneId);
        assert.equal(p.state,'active');
        const overview=await request(base,{headers:headers('owner')});assert.equal(overview.headers['cache-control'],'no-store');
        for(const secret of ['test-secret','encryptedCredentials','sipResourceId','ava-phone-','applicationId']) assert(!JSON.stringify(overview.body).includes(secret));
        assert.equal((await request('/api/internal/telephony/resolve/'+p.number,{headers:headers('owner')})).status,401);
        const machineHeaders={Authorization:'Bearer local-test-service-token'};
        result=await request('/api/internal/telephony/resolve/'+p.number,{headers:machineHeaders});assert.equal(result.status,200);assert.equal(result.body.businessId,1);
        result=await request('/api/internal/telephony/source/2?sourceNumberId='+p.id,{headers:machineHeaders});assert.equal(result.status,409);
        result=await request('/api/internal/telephony/calls/reserve',{method:'POST',headers:machineHeaders,body:{businessId:2,sourceId:p.id,callId:'foreign-http',direction:'outbound'}});assert.equal(result.status,409);
        result=await request('/api/internal/telephony/calls/reserve',{method:'POST',headers:machineHeaders,body:{businessId:1,sourceId:p.id,callId:'http-call',direction:'outbound'}});assert.equal(result.status,200);
        result=await request('/api/internal/telephony/calls/http-call/finish',{method:'POST',headers:machineHeaders,body:{businessId:2,seconds:20}});assert.equal(result.status,404);
        result=await request('/api/internal/telephony/calls/http-call/finish',{method:'POST',headers:machineHeaders,body:{businessId:1,seconds:20,channelId:'http-channel'}});assert.equal(result.status,200);
        const imported=existingFixture('inbound_only');imported.n.number_name='74951110009';
        imported.n.call_forwarding_ip_static.did_name=imported.n.number_name;imported.body.number=imported.n.number_name;
        process.env.AVA_TELEPHONY_EXISTING_BINDINGS='{"74951110009":1}';await imported.Existing.inventory(worker);
        assert.equal((await request(base+'/existing',{headers:headers('owner')})).status,200);
        assert.equal((await request(base+'/existing',{headers:headers('observer')})).status,403);
        assert.equal((await request(base+'/existing',{headers:headers('other')})).status,403);
        assert.equal((await request(base+'/imports',{method:'POST',headers:{Cookie:headers('owner').Cookie},body:imported.body})).status,403);
        const importedResult=await request(base+'/imports',{method:'POST',headers:{...headers('owner'),'Idempotency-Key':Store.uuid()},body:imported.body});
        assert.equal(importedResult.status,202);assert.equal(importedResult.body.operation.kind,'import');
        assert.equal((await request(base+'/orders/'+importedResult.body.operation.id,{headers:headers('owner')})).status,200);
        DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='owner'");assert.equal((await request(base,{headers:headers('owner')})).status,403);
        Identity.revokeSession(tokens.manager);assert.equal((await request(base,{headers:headers('manager')})).status,401);
        delete process.env.CRM_SERVICE_API_TOKEN;delete process.env.SALES_BRAIN_API_TOKEN;delete process.env.WHATSAPP_CRM_API_TOKEN;
        assert.equal((await request('/api/internal/telephony/resolve/'+p.number,{headers:machineHeaders})).status,503);
    } finally {Auth.config=oldConfig;await new Promise(resolve=>server.close(resolve));}
});

test('operator resume is worker-only, checks scope/revision and never rewinds unknown paid checkpoints',async()=>{
    const Recovery=require('../src/services/telephony/recovery');
    DB.run("INSERT INTO ava_users(id,subject,email,displayName,platformRole) VALUES('operator','operator','operator@test.local','Operator','platform_admin')");
    const actor=Identity.actor('operator');const job=order();const leased=Store.lease(now);Store.advance(leased,'buy_dispatching',{},now);worker.manual(leased,'TELEPHONY_PURCHASE_RECONCILING');
    await assert.rejects(()=>Recovery.inspect(actor,job.id,provider),{code:'TELEPHONY_RECOVERY_WORKER_REQUIRED'});
    process.env.AVA_PROCESS_ROLE='provisioning-worker';
    await assert.rejects(()=>Recovery.inspect(owner,job.id,provider));
    let inspection=await Recovery.inspect(actor,job.id,provider);assert.equal(inspection.canResume,true);assert.equal(inspection.reconciliationOnly,true);
    const reserved=Store.reservedSpend();now+=1;
    await assert.rejects(()=>Recovery.resume(actor,job.id,inspection.revision-1,provider,now),{code:'TELEPHONY_RECOVERY_CONFLICT'});
    await Recovery.resume(actor,job.id,inspection.revision,provider,now);
    assert.equal(Store.operation(job.id).stage,'buy_dispatching');await worker.processOne();
    assert.equal(provider.calls.buy,0);assert.equal(Store.reservedSpend(),reserved);
    assert.equal(Store.operation(job.id).state,'reconciling');
    const again=Store.lease(now+31000);now+=31000;worker.manual(again,'TELEPHONY_PURCHASE_RECONCILING');
    provider.inventory=async()=>[{number_name:'74951110001',application_uuid:'foreign-app'}];
    await assert.rejects(()=>Recovery.inspect(actor,job.id,provider),{code:'TELEPHONY_RECOVERY_SCOPE_INVALID'});
    const audit=JSON.parse(Store.meta('recovery:'+job.id).value);assert.equal(audit.actorUserId,'operator');
    assert(!JSON.stringify(audit).includes('test-secret'));
});

test('actual call seconds are split across Moscow midnight and finished duration cannot disappear from the next day',async()=>{
    const job=order();await worker.processOne();
    now=Date.parse('2026-10-12T20:59:50Z');Store.reserveCall({businessId:1,callId:'midnight'},now);
    now+=20000;Store.finishCall('midnight',{businessId:1,seconds:20,channelId:'midnight-channel'},now);
    assert.equal(Store.dailyUsage(1,Date.parse('2026-10-12T20:59:59Z')),10);
    assert.equal(Store.dailyUsage(1,now),10);
    now+=11000;assert.equal(Store.reserveCall({businessId:1,callId:'new-day'},now).maxSeconds,300);
    assert.equal(Store.dailyUsage(1,now),310);
});

test('manual SIP connection and aliases survive managed purchase and final release',async()=>{
    DB.run('UPDATE instances SET sipCallerId=?,sipTrunkNumber=?,sipAliases=? WHERE id=1',['74951110009','existing-manual-trunk',JSON.stringify(['74951110009'])]);
    DB.run('INSERT INTO business_sip_aliases(alias,businessId) VALUES(?,1)',['74951110009']);
    const job=order();await worker.processOne();assert.equal(DB.get('SELECT sipTrunkNumber FROM instances WHERE id=1').sipTrunkNumber,Store.phone(job.phoneId).endpoint);
    Store.release(1,job.phoneId,false,now);now+=7*86400000;await worker.processOne();
    const profile=DB.get('SELECT sipCallerId,sipTrunkNumber,sipAliases FROM instances WHERE id=1');
    assert.equal(profile.sipCallerId,'74951110009');assert.equal(profile.sipTrunkNumber,'existing-manual-trunk');assert.deepEqual(JSON.parse(profile.sipAliases),['74951110009']);
    assert.equal(DB.get("SELECT businessId FROM business_sip_aliases WHERE alias='74951110009'").businessId,1);
    assert.deepEqual(Store.source(1),{managed:false});
});

test('unexpected maintenance exception is isolated from leased operations',async()=>{
    const job=order();worker.maintenance=async()=>{throw new Error('maintenance unavailable');};
    assert.equal(await worker.processOne(),true);assert.equal(Store.operation(job.id).state,'done');
    assert(DB.get("SELECT id FROM ava_phone_alerts WHERE code='TELEPHONY_MAINTENANCE_FAILED'"));
});

test('schema cache survives provisioning transaction rollback before the first managed operation',()=>{
    DB.db.close();createTestDB();
    const shared=DB.db.prepare("INSERT INTO instances(name) VALUES('Shared')").run().lastInsertRowid;
    assert.throws(()=>Provisioning.createBusinessAtomic({name:'Invalid',knowledgeBaseInstanceId:shared}),{code:'ONYX_KNOWLEDGE_SCOPE_MISMATCH'});
    assert.equal(Provisioning.createBusinessAtomic({name:'Valid'}).instance.name,'Valid');
    assert(DB.get("SELECT name FROM sqlite_master WHERE name='ava_phone_numbers'"));
});

test('managed campaign deploy uses its canonical business source, one call and rejects foreign or malformed selections before HTTP',async()=>{
    const axios=require('axios'),previousPost=axios.post;
    const {AvaOutboundService}=require('../src/services/ava-outbound.service');
    const service=new AvaOutboundService({apiUrl:'http://ava-test.local',serviceToken:'test-only'});
    const first=order();await worker.processOne();const foreign=order(2,'74951110002');await worker.processOne();
    DB.createOutboundCampaign({campaignId:'campaign-own',instanceId:1});let payload,calls=0;
    axios.post=async(url,body)=>{calls++;payload=body;return {data:{success:true}};};
    try {
        await service.syncCampaign('campaign-own',{sourceNumberId:first.phoneId,maxConcurrent:5,minIntervalSecondsBetweenCalls:0});
        assert.equal(payload.source_number_id,first.phoneId);assert.equal(payload.max_concurrent,1);assert.equal(payload.min_interval_seconds_between_calls,10);
        await assert.rejects(()=>service.syncCampaign('campaign-own',{sourceNumberId:foreign.phoneId}),{code:'TELEPHONY_SOURCE_UNAVAILABLE'});
        await assert.rejects(()=>service.syncCampaign('campaign-own',{sourceNumberId:0}),{code:'TELEPHONY_SOURCE_UNAVAILABLE'});
        await assert.rejects(()=>service.syncCampaign('missing'),{code:'CAMPAIGN_NOT_FOUND'});assert.equal(calls,1);
    } finally {axios.post=previousPost;}
});

test('persistent unknown Buy escalates to manual while keeping the number and money, recovery still does not replay Buy',async()=>{
    const Recovery=require('../src/services/telephony/recovery');
    DB.run("INSERT INTO ava_users(id,subject,email,displayName,platformRole) VALUES('operator','operator','operator@test.local','Operator','platform_admin')");
    process.env.AVA_PROCESS_ROLE='provisioning-worker';const actor=Identity.actor('operator');
    const job=order(),leased=Store.lease(now);Store.advance(leased,'buy_dispatching',{},now);
    DB.run('UPDATE ava_phone_operations SET attempts=19 WHERE id=?',[job.id]);now+=61000;await worker.processOne();
    assert.equal(Store.operation(job.id).state,'manual');assert.equal(Store.phone(job.phoneId).state,'manual');assert.equal(Store.reservedSpend(),83000);
    const inspection=await Recovery.inspect(actor,job.id,provider);now+=1;await Recovery.resume(actor,job.id,inspection.revision,provider,now);await worker.processOne();
    assert.equal(Store.operation(job.id).stage,'buy_dispatching');assert.equal(provider.calls.buy,0);assert.equal(provider.calls.delete,0);
});

test('number or SIP price drift after Buy compensates only the new number before creating a SIP',async()=>{
    const original=provider.buy;
    provider.buy=async n=>{await original(n);(await provider.inventory())[0].subscription_fee='151';return {};};
    let job=order();await worker.processOne();assert.equal(Store.phone(job.phoneId).state,'released');
    assert.equal(Store.operation(job.id).errorCode,'TELEPHONY_PRICE_CHANGED');assert.equal(provider.calls.sip,0);assert.equal(provider.calls.delete,1);
    provider.buy=original;let fees=0;provider.fees=async()=>({install_fee:0,subscription_fee:++fees===1?90:91});
    job=order(1,'74951110002');await worker.processOne();assert.equal(Store.phone(job.phoneId).state,'released');
    assert.equal(provider.calls.sip,0);assert.equal(provider.calls.delete,2);
});

test('reactivation during host removal restores the same SIP before canceling an unsent provider Delete',async()=>{
    const job=order();let applies=0;host.apply=async()=>{applies++;return {};};await worker.processOne();
    DB.run('UPDATE instances SET isActive=0 WHERE id=1');now+=8*86400000;
    host.remove=async()=>{DB.run('UPDATE instances SET isActive=1 WHERE id=1');return {};};
    await worker.processOne();assert.equal(Store.phone(job.phoneId).state,'active');
    assert.equal(applies,2);assert.equal(provider.calls.delete,0);assert.equal(provider.calls.deleteSip,0);
    assert.equal(DB.get("SELECT state FROM ava_phone_operations WHERE kind='release'").state,'canceled');
    assert.equal(Store.resolve('74951110001').businessId,1);
});
function existingFixture(mode='sip') {
    process.env.AVA_TELEPHONY_PURCHASE_ENABLED='false';
    process.env.AVA_TELEPHONY_EXISTING_BINDINGS='{"74951110001":1}';
    const n={number_name:'74951110001',application_uuid:'app',number_options:numberOptions,install_fee:'99999',subscription_fee:'210',
        call_forwarding_flag:true,call_forwarding_ip_static:{did_name:'74951110001',ip:process.env.EXOLVE_STATIC_IP,port:5060}};
    const s={sip_resource_id:'42',sip_name:'operator_existing',application_uuid:'app',cli:n.number_name,install_fee:'0',subscription_fee:'0'};
    provider.inventory=async()=>[n];provider.sips=async()=>mode==='sip'?[s]:[];
    provider.sip=async()=>({...s,attributes:{cli:n.number_name,login:'existing-login',password:'existing-secret',domain:'sip.exolve.ru',subscription_fee:'0'}});
    for(const name of ['buy','lock','unlock','createSip','forwarding','deleteSip','deleteNumber']) provider[name]=async()=>{throw new Error('FORBIDDEN_PROVIDER_MUTATION_'+name);};
    worker.lastMaintenance=now;
    const Existing=require('../src/services/telephony/existing'),body={number:n.number_name,mode,confirmUnused:true};
    return {n,s,Existing,body,begin:()=>Existing.begin(1,body,Store.uuid(),'owner',now)};
}
test('existing SIP imports with zero spend and no provider mutations; source and tenant guards apply',async()=>{
    const f=existingFixture(),job=f.begin();await worker.processOne();
    assert.equal(Store.operation(job.id).state,'done');const p=Store.phone(job.phoneId);
    assert.equal(p.origin,'existing');assert.equal(p.installKopecks,0);assert.equal(p.monthlyKopecks,21000);
    assert.equal(Store.source(1).phoneId,p.id);assert.equal(Store.resolve(p.number).phoneId,p.id);
    assert.equal(Store.reservedSpend(),0);assert.equal(Service.overview(owner,1).managedMode,true);
    assert(!JSON.stringify(Service.overview(owner,1)).includes('existing-secret'));
    assert.throws(()=>Store.source(2,p.id),{code:'TELEPHONY_SOURCE_UNAVAILABLE'});
});
test('existing inbound-only import, history, reactivation and reconciliation never enable outbound',async()=>{
    const f=existingFixture('inbound_only');host.apply=async()=>{throw new Error('must not apply SIP');};
    const job=f.begin();await worker.processOne();const p=Store.phone(job.phoneId);
    assert.equal(p.state,'active');assert.equal(p.inboundReady,1);assert.equal(p.outboundReady,0);
    assert.throws(()=>Store.source(1),{code:'TELEPHONY_SOURCE_UNAVAILABLE'});
    Store.reserveCall({businessId:1,callId:'existing-inbound',direction:'inbound',number:p.number},now);
    Store.finishCall('existing-inbound',{businessId:1,seconds:12},now);assert.equal(Store.phone(p.id).inboundVerifiedAt,now);
    DB.run('UPDATE instances SET isActive=0 WHERE id=1');DB.run('UPDATE instances SET isActive=1 WHERE id=1');
    Store.restoreBusiness(1,now);assert.equal(Store.phone(p.id).outboundReady,0);
    await worker.maintenance();assert.equal(Store.phone(p.id).state,'active');
});
test('existing import fails before host apply for missing forwarding, active calls, foreign app or revoked grant',async()=>{
    for(const scenario of ['forwarding','calls','application','grant']) {
        const f=existingFixture();let applied=0;host.apply=async()=>{applied++;};const job=f.begin();
        if(scenario==='forwarding') f.n.call_forwarding_flag=false;
        if(scenario==='calls') host.calls=async()=>({active:1});
        if(scenario==='application') f.n.application_uuid='foreign';
        if(scenario==='grant') process.env.AVA_TELEPHONY_EXISTING_BINDINGS='{}';
        await worker.processOne();assert.equal(Store.operation(job.id).state,'failed',scenario);assert.equal(applied,0);
        assert.equal(Store.phone(job.phoneId).state,'released');host.calls=async()=>({active:0});
    }
});
test('customer-editable alias is not an import grant; concurrent foreign tenant claim is rejected',()=>{
    const f=existingFixture();DB.run('INSERT INTO business_sip_aliases(alias,businessId) VALUES(?,1)',[f.n.number_name]);
    process.env.AVA_TELEPHONY_EXISTING_BINDINGS='{}';assert.throws(()=>f.begin(),{code:'TELEPHONY_IMPORT_NOT_GRANTED'});
    process.env.AVA_TELEPHONY_EXISTING_BINDINGS='{"74951110001":1}';f.begin();
    process.env.AVA_TELEPHONY_EXISTING_BINDINGS='{"74951110001":2}';
    assert.throws(()=>f.Existing.begin(2,f.body,Store.uuid(),'other',now),{code:'TELEPHONY_NUMBER_ALREADY_BOUND'});
});
test('existing inventory is tenant scoped, missing routes explicit, import retry idempotent',async()=>{
    const f=existingFixture();f.n.call_forwarding_flag=false;await f.Existing.inventory(worker);
    assert.equal(f.Existing.candidates(1).length,1);assert.deepEqual(f.Existing.candidates(2),[]);
    assert.equal(f.Existing.candidates(1)[0].forwardingReady,false);
    const key=Store.uuid(),a=f.Existing.begin(1,f.body,key,'owner',now);
    assert.equal(f.Existing.begin(1,f.body,key,'owner',now).id,a.id);
    assert.throws(()=>f.Existing.begin(1,{...f.body,mode:'inbound_only'},key,'owner',now),{code:'TELEPHONY_IDEMPOTENCY_CONFLICT'});
    assert.throws(()=>Service.existing(Identity.actor('observer'),1));
});
test('revocation after import host apply fails closed and retains cleanup evidence',async()=>{
    const f=existingFixture(),job=f.begin();host.apply=async()=>{DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='owner'");};
    await worker.processOne();assert.equal(Store.operation(job.id).state,'manual');const p=Store.phone(job.phoneId);
    assert.equal(p.state,'manual');assert.equal(p.inboundReady,0);assert.equal(p.outboundReady,0);assert(p.encryptedCredentials);
});
test('existing detach preserves pre-existing manual alias/profile and never deletes provider resources',async()=>{
    const f=existingFixture();DB.run('INSERT INTO business_sip_aliases(alias,businessId) VALUES(?,1)',[f.n.number_name]);
    DB.run('UPDATE instances SET sipAliases=?,sipCallerId=?,sipTrunkNumber=? WHERE id=1',[JSON.stringify([f.n.number_name]),f.n.number_name,'manual-original']);
    const job=f.begin();await worker.processOne();Store.release(1,job.phoneId,false,now);
    now+=Policy.LIMITS.graceMs;await worker.processOne();assert.equal(Store.phone(job.phoneId).state,'released');
    const i=DB.get('SELECT sipCallerId,sipTrunkNumber,sipAliases FROM instances WHERE id=1');
    assert.equal(i.sipTrunkNumber,'manual-original');assert.equal(i.sipCallerId,f.n.number_name);
    assert.deepEqual(JSON.parse(i.sipAliases),[f.n.number_name]);assert(DB.get('SELECT alias FROM business_sip_aliases WHERE alias=?',[f.n.number_name]));
});
test('purchase-disabled worker processes catalog while ignoring a queued paid operation',async()=>{
    const paid=order();process.env.AVA_TELEPHONY_PURCHASE_ENABLED='false';worker.lastMaintenance=now;
    const read=Store.request(1,'catalog',{},'owner',now);await worker.processOne();
    assert.equal(Store.operation(read.id).state,'done');assert.equal(Store.operation(paid.id).state,'pending');
    assert.equal(provider.calls.buy,0);assert.equal(provider.calls.sip,0);assert.equal(provider.calls.lock,0);
});
test('local operator import uses explicit grant and no fabricated customer session',async()=>{
    const f=existingFixture('inbound_only');
    assert.throws(()=>f.Existing.begin(1,f.body,Store.uuid(),null,now,{operator:true}),{code:'TELEPHONY_OPERATOR_REQUIRED'});
    process.env.AVA_PROCESS_ROLE='provisioning-worker';const job=f.Existing.begin(1,f.body,Store.uuid(),null,now,{operator:true});
    await worker.processOne();assert.equal(Store.operation(job.id).state,'done');assert.equal(Store.operation(job.id).fundingMode,'existing_operator');
});
