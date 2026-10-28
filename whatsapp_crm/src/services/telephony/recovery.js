'use strict';
// Local operator functions only. Deliberately absent from browser/internal HTTP
// routers: operator recovery must run in the worker with its provider credential.
const DB=require('../database.service');
const Identity=require('../identity/identity-store');
const Store=require('./store');
const {fail}=require('./policy');
const resumable=new Set(['locking','locked','buy_dispatching','buy_confirm','buy_rejected','sip_pending','sip_dispatching',
    'sip_confirm','host_apply','host_verify','forwarding','forwarding_verify','compensate','release_check',
    'import_apply','import_verifying','detach_host','delete_sip_dispatching','delete_sip_confirm','delete_number_dispatching','delete_number_confirm']);
function authorize(actor) {
    Identity.requirePlatformAdmin(actor);
    if(process.env.AVA_PROCESS_ROLE!=='provisioning-worker') fail('TELEPHONY_RECOVERY_WORKER_REQUIRED',409);
}
async function inspect(actor,operationId,provider) {
    authorize(actor);Store.ensureSchema();
    const job=Store.operation(operationId),p=job?.phoneId && Store.phone(job.phoneId);
    if(!p || !['managed','existing'].includes(p.origin) || p.applicationId!==provider.applicationId) fail('TELEPHONY_RECOVERY_SCOPE_INVALID',409);
    const [inventory,sips]=await Promise.all([provider.inventory(),provider.sips()]);
    if(!Array.isArray(inventory) || !Array.isArray(sips)) fail('TELEPHONY_PROVIDER_RESPONSE_INVALID',503);
    const numbers=inventory.filter(n=>String(n?.number_name)===p.number);
    const matching=sips.filter(s=>s?.sip_name===p.sipName || (p.sipResourceId && String(s?.sip_resource_id)===p.sipResourceId));
    if(numbers.length>1 || numbers.some(n=>n.application_uuid!==p.applicationId)
        || matching.length>1 || matching.some(s=>s.application_uuid!==p.applicationId || String(s.cli)!==p.number
            || s.sip_name!==p.sipName || !/^\d+$/.test(String(s.sip_resource_id)))) fail('TELEPHONY_RECOVERY_SCOPE_INVALID',409);
    // These are fresh inventory observations, not evidence that an absent Buy
    // failed. Resuming never rewinds the checkpoint or releases uncertain money.
    return {operation:Store.publicOperation(job),number:Store.publicPhone(p),revision:job.updatedAt,
        providerNumberPresent:numbers.length===1,providerSipPresent:matching.length===1,
        canResume:job.state==='manual' && resumable.has(job.stage) && (p.origin==='managed' || ['import','release'].includes(job.kind)),
        reconciliationOnly:['buy_dispatching','sip_dispatching','delete_sip_dispatching','delete_number_dispatching'].includes(job.stage)};
}
async function resume(actor,operationId,expectedRevision,provider,now=Date.now()) {
    const evidence=await inspect(actor,operationId,provider);
    return Store.transaction(()=>{
        authorize(actor);
        const job=Store.operation(operationId),p=Store.phone(job.phoneId);
        if(!evidence.canResume || !job || job.state!=='manual' || job.updatedAt!==expectedRevision
            || evidence.revision!==expectedRevision || (job.leaseUntil && job.leaseUntil>now)
            || p.state!=='manual' || (job.kind==='purchase' && p.activatedAt)) fail('TELEPHONY_RECOVERY_CONFLICT',409);
        if(p.origin==='existing' && job.kind==='import') require('./existing').assertGrant(p.businessId,p.number);
        DB.run(`UPDATE ava_phone_operations SET state='reconciling',attempts=0,errorCode=NULL,nextAt=?,updatedAt=?,leaseToken=NULL,leaseUntil=NULL WHERE id=?`,[now,now,job.id]);
        DB.run("UPDATE ava_phone_numbers SET state=?,updatedAt=? WHERE id=?",[job.kind==='release'?'releasing':'provisioning',now,p.id]);
        // This local audit contains no provider credentials or SIP attributes.
        Store.setMeta('recovery:'+job.id,{actorUserId:actor.userId,stage:job.stage,
            providerNumberPresent:evidence.providerNumberPresent,providerSipPresent:evidence.providerSipPresent},now);
        Store.syncProjection(job.businessId);
        return Store.publicOperation(Store.operation(job.id));
    });
}
module.exports={inspect,resume};
