'use strict';
const crypto=require('crypto');
const DB=require('../database.service');
const Identity=require('../identity/identity-store');
const Store=require('./store');
const Vault=require('./credentials');
const {LIMITS,did,fail,kopecks,fields}=require('./policy');
function bindings() {
    try {
        const value=JSON.parse(process.env.AVA_TELEPHONY_EXISTING_BINDINGS || '{}');
        return value && !Array.isArray(value) && typeof value==='object'?value:{};
    } catch(_) {return {};}
}
function granted(businessId,number) {return bindings()[number]===businessId;}
function assertGrant(businessId,number) {
    if(!granted(businessId,number)) fail('TELEPHONY_IMPORT_NOT_GRANTED',403);
}
function candidates(businessId) {
    const snapshot=Store.meta('existing_inventory');
    if(!snapshot) return [];
    const data=JSON.parse(snapshot.value);
    if(data.applicationId!==process.env.EXOLVE_APPLICATION_UUID) return [];
    return data.numbers.filter(n=>granted(businessId,n.number)).map(n=>({...n,
        alreadyBound:!!DB.get("SELECT id FROM ava_phone_numbers WHERE number=? AND state<>'released'",[n.number])}));
}
function begin(businessId,body,key,actorUserId,now=Date.now(),{operator=false}={}) {
    fields(body,['number','mode','confirmUnused']);
    const number=did(body.number),mode=body.mode;
    if(!['sip','inbound_only'].includes(mode) || body.confirmUnused!==true) fail('TELEPHONY_INPUT_INVALID');
    if(typeof key!=='string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) fail('TELEPHONY_IDEMPOTENCY_REQUIRED');
    return Store.transaction(()=>{
        if(operator) {
            if(process.env.AVA_PROCESS_ROLE!=='provisioning-worker') fail('TELEPHONY_OPERATOR_REQUIRED',403);
        } else Identity.authorizeCapability({userId:actorUserId},businessId,'business.manage');
        assertGrant(businessId,number);
        if(!DB.get('SELECT id FROM instances WHERE id=? AND isActive=1',[businessId])) fail('BUSINESS_NOT_FOUND',404);
        const input={number,mode,confirmUnused:true},hash=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
        const old=DB.get('SELECT * FROM ava_phone_operations WHERE businessId=? AND idempotencyKey=?',[businessId,key]);
        if(old) {if(old.requestHash!==hash) fail('TELEPHONY_IDEMPOTENCY_CONFLICT',409);return old;}
        if(DB.get("SELECT COUNT(*) n FROM ava_phone_numbers WHERE businessId=? AND state<>'released'",[businessId]).n>=LIMITS.numbers)
            fail('TELEPHONY_NUMBER_LIMIT',409);
        if(DB.get("SELECT id FROM ava_phone_numbers WHERE number=? AND state<>'released'",[number])
            || DB.get('SELECT alias FROM business_sip_aliases WHERE alias=? AND businessId<>?',[number,businessId]))
            fail('TELEPHONY_NUMBER_ALREADY_BOUND',409);
        if(DB.get('SELECT COUNT(*) n FROM ava_phone_operations WHERE businessId=? AND createdAt>?',[businessId,now-60000]).n>=12) fail('TELEPHONY_RATE_LIMIT',429);
        if(!process.env.EXOLVE_APPLICATION_UUID) fail('TELEPHONY_PROVIDER_NOT_CONFIGURED',503);
        if(!DB.get("SELECT id FROM ava_phone_numbers WHERE businessId=? AND state<>'released'",[businessId]))
            DB.run('INSERT OR IGNORE INTO ava_phone_manual_profiles(businessId,sipCallerId,sipTrunkNumber) SELECT id,sipCallerId,sipTrunkNumber FROM instances WHERE id=?',[businessId]);
        const id=Store.uuid(),endpoint=`ava-phone-${id.replaceAll('-','')}`;
        DB.run(`INSERT INTO ava_phone_numbers(id,businessId,number,origin,applicationId,state,installKopecks,monthlyKopecks,sipName,endpoint,createdAt,updatedAt)
            VALUES(?,?,?,'existing',?,'provisioning',0,0,'',?,?,?)`,[id,businessId,number,process.env.EXOLVE_APPLICATION_UUID,endpoint,now,now]);
        DB.run('INSERT INTO ava_phone_existing_profiles(phoneId,mode,aliasExisted) VALUES(?,?,?)',
            [id,mode,DB.get('SELECT alias FROM business_sip_aliases WHERE alias=? AND businessId=?',[number,businessId])?1:0]);
        const job=Store.insertOperation({businessId,phoneId:id,kind:'import',stage:'import_validate',actorUserId,input,key,hash,now,fundingMode:operator?'existing_operator':'existing'});
        Store.syncProjection(businessId);return job;
    });
}
function grant(job,p,now) {
    Store.assertLease(job,now);assertGrant(p.businessId,p.number);
    if(job.fundingMode!=='existing_operator') Identity.authorizeCapability({userId:job.actorUserId},p.businessId,'business.manage');
    if(!DB.get('SELECT id FROM instances WHERE id=? AND isActive=1',[p.businessId])) fail('BUSINESS_NOT_FOUND',404);
}
async function inventory(worker,job=null) {
    const read=action=>job?worker.fenced(job,action):action();
    const [numbers,sips]=await read(()=>Promise.all([worker.provider.inventory(),worker.provider.sips()]));
    if(!Array.isArray(numbers) || !Array.isArray(sips)) fail('TELEPHONY_PROVIDER_RESPONSE_INVALID',503);
    const result=[];
    for(const n of numbers) {
        if(n.application_uuid!==worker.provider.applicationId || !/^7\d{10}$/.test(String(n.number_name))) continue;
        let monthly;try {monthly=kopecks(n.subscription_fee);} catch(_) {continue;}
        const matching=sips.filter(s=>s.application_uuid===worker.provider.applicationId && String(s.cli)===String(n.number_name));
        const modes=n.number_options?.incoming_calls===true?['inbound_only']:[];
        if(matching.length===1 && n.number_options?.outgoing_calls===true) {
            try {monthly+=kopecks(matching[0].subscription_fee);modes.unshift('sip');} catch(_) {}
        }
        let forwardingReady=false;
        try {const {staticTarget,forwardingMatches}=require('./worker');forwardingReady=forwardingMatches(n,{number:String(n.number_name)},staticTarget());} catch(_) {}
        result.push({number:String(n.number_name),modes,monthlyKopecks:monthly,forwardingReady,sipAvailable:matching.length===1,
            blockers:[...(!forwardingReady?['TELEPHONY_IMPORT_FORWARDING_REQUIRED']:[]),...(matching.length!==1?['TELEPHONY_IMPORT_SIP_REQUIRED']:[])]});
    }
    Store.setMeta('existing_inventory',{applicationId:worker.provider.applicationId,numbers:result},worker.now());
    return {numbers,sips};
}
async function run(worker,job,{staticTarget,forwardingMatches}) {
    let p=Store.phone(job.phoneId);
    if(!p || p.origin!=='existing' || p.applicationId!==worker.provider.applicationId) fail('TELEPHONY_PROVIDER_SCOPE_MISMATCH',409);
    const mode=JSON.parse(job.inputJson).mode;
    grant(job,p,worker.now());
    const {numbers,sips}=await inventory(worker,job);
    const n=numbers.find(n=>String(n.number_name)===p.number && n.application_uuid===p.applicationId);
    if(!n || n.number_options?.incoming_calls!==true) fail('TELEPHONY_IMPORT_NUMBER_UNAVAILABLE',409);
    if(!forwardingMatches(n,p,staticTarget())) fail('TELEPHONY_IMPORT_FORWARDING_REQUIRED',409);
    if((await worker.fenced(job,()=>worker.host.health())).ingressReady!==true) fail('TELEPHONY_INGRESS_NOT_READY',409);
    if((await worker.fenced(job,()=>worker.host.calls())).active!==0
        || DB.get("SELECT id FROM ava_phone_calls WHERE phoneId IN (SELECT id FROM ava_phone_numbers WHERE number=?) AND state='reserved'",[p.number]))
        fail('TELEPHONY_IMPORT_IN_USE',409);
    let monthly=kopecks(n.subscription_fee);
    if(mode==='sip') {
        const matches=sips.filter(s=>s.application_uuid===p.applicationId && String(s.cli)===p.number);
        if(matches.length!==1 || n.number_options?.outgoing_calls!==true) fail('TELEPHONY_IMPORT_SIP_REQUIRED',409);
        const s=matches[0],id=String(s.sip_resource_id);
        if(!/^\d+$/.test(id) || typeof s.sip_name!=='string') fail('TELEPHONY_PROVIDER_RESPONSE_INVALID',503);
        if((p.sipResourceId && p.sipResourceId!==id) || DB.get("SELECT id FROM ava_phone_numbers WHERE sipResourceId=? AND state<>'released' AND id<>?",[id,p.id]))
            fail('TELEPHONY_IMPORT_SIP_IN_USE',409);
        const a=await worker.fenced(job,()=>worker.provider.sip(id));
        if(a.application_uuid!==p.applicationId || String(a.sip_resource_id)!==id || a.sip_name!==s.sip_name
            || String(a.attributes?.cli)!==p.number) fail('TELEPHONY_IMPORT_SIP_SCOPE_INVALID',409);
        const credentials={login:a.attributes.login,password:a.attributes.password,domain:a.attributes.domain};
        if(Object.values(credentials).some(v=>typeof v!=='string' || !v || v.length>1024)) fail('TELEPHONY_PROVIDER_RESPONSE_INVALID',503);
        monthly+=kopecks(a.attributes.subscription_fee);
        grant(job,p,worker.now());
        p={...p,sipResourceId:id,sipName:s.sip_name};
        Store.transaction(()=>{
            Store.assertLease(job,worker.now());
            DB.run('UPDATE ava_phone_numbers SET sipResourceId=?,sipName=?,encryptedCredentials=? WHERE id=?',[id,s.sip_name,Vault.encrypt(credentials,p),p.id]);
            worker.advance(job,'import_apply');
        });
        await worker.fenced(job,()=>worker.host.apply(p,credentials));
        worker.advance(job,'import_verifying');
        if((await worker.fenced(job,()=>worker.host.status(p))).registered!==true) {worker.defer(job,'TELEPHONY_SIP_REGISTERING');return;}
    }
    grant(job,p,worker.now());
    // Provider routing may change while applying a host endpoint.
    if(!forwardingMatches(await worker.purchased(p,job),p,staticTarget())) fail('TELEPHONY_IMPORT_FORWARDING_REQUIRED',409);
    Store.transaction(()=>{
        grant(job,p,worker.now());
        DB.run('UPDATE ava_phone_numbers SET monthlyKopecks=? WHERE id=?',[monthly,p.id]);
        Store.activate(job,worker.now(),{existing:true,outbound:mode==='sip'});
    });
}
module.exports={bindings,granted,assertGrant,candidates,begin,inventory,run};
