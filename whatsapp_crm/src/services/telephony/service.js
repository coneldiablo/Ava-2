'use strict';
const DB=require('../database.service');
const Identity=require('../identity/identity-store');
const Store=require('./store');
const Existing=require('./existing');
const {LIMITS,fail,pilot,fields}=require('./policy');
function authorize(auth,businessId,write=false) {
    const id=Identity.authorizeCapability(auth,Number(businessId),write?'business.manage':'business.read');
    if(write && auth?.platformRole==='platform_admin') fail('TELEPHONY_OWNER_REQUIRED',403);
    Store.ensureSchema();return id;
}
function overview(auth,businessId) {
    const id=authorize(auth,businessId), now=Date.now();
    let canManage=false;try {authorize(auth,id,true);canManage=true;} catch(_) {}
    const rows=DB.all("SELECT * FROM ava_phone_numbers WHERE businessId=? AND state<>'released' ORDER BY createdAt",[id]);
    const usage=Store.dailyUsage(id,now);
    const balance=Store.meta('balance'),health=Store.meta('telephony_health');
    return {success:true,businessId:id,canManage,managedMode:!!DB.get("SELECT id FROM ava_phone_numbers WHERE businessId=? AND state<>'released'",[id]),
        canImport:canManage && Object.values(Existing.bindings()).includes(id),
        canPurchase:canManage && pilot(id) && rows.length<LIMITS.numbers,
        health:health?{...JSON.parse(health.value),checkedAt:health.updatedAt}:null,
        pilotEnabled:pilot(id),numbers:rows.map(Store.publicPhone),limits:LIMITS,
        remainingSeconds:Math.max(0,LIMITS.dailySeconds-usage),balanceReady:!!balance && balance.updatedAt>now-90000,
        orders:DB.all(`SELECT * FROM ava_phone_operations WHERE businessId=? AND (kind IN ('purchase','release','import') OR kind LIKE 'external_%')
            AND (state NOT IN ('done','canceled') OR updatedAt>?) ORDER BY createdAt DESC LIMIT 20`,[id,now-86400000]).map(Store.publicOperation),
        notices:DB.all('SELECT code,phoneId,createdAt FROM ava_phone_alerts WHERE businessId=? AND resolvedAt IS NULL ORDER BY createdAt DESC LIMIT 20',[id]),
        ...require('./diagnostics').snapshot(id,{canManage,now}),...require('./external-sip').overview(id)};
}
function catalog(auth,businessId) {
    const id=authorize(auth,businessId);
    const row=Store.meta('catalog');
    if(row && row.updatedAt>Date.now()-86400000) return {success:true,...JSON.parse(row.value)};
    return {success:true,operation:Store.publicOperation(Store.request(id,'catalog',{},auth.userId))};
}
function quotes(auth,businessId,body) {
    const id=authorize(auth,businessId,true);fields(body,['typeId','regionId']);
    if(![1104,1105].includes(body.typeId) || !Number.isSafeInteger(body.regionId) || body.regionId<1) fail('TELEPHONY_INPUT_INVALID');
    return {success:true,operation:Store.publicOperation(Store.request(id,'quotes',body,auth.userId))};
}
function order(auth,businessId,body,key) {
    const id=authorize(auth,businessId,true);fields(body,['quoteId']);
    if(typeof body.quoteId!=='string' || body.quoteId.length>100) fail('TELEPHONY_INPUT_INVALID');
    return {success:true,operation:Store.publicOperation(Store.createOrder(id,body.quoteId,key,auth.userId))};
}
function getOperation(auth,businessId,operationId) {
    const id=authorize(auth,businessId),row=Store.operation(operationId);
    if(!row || row.businessId!==id) fail('TELEPHONY_ORDER_NOT_FOUND',404);
    return {success:true,operation:Store.publicOperation(row)};
}
function existing(auth,businessId) {
    const id=authorize(auth,businessId,true),row=Store.meta('existing_inventory');
    const fresh=row && row.updatedAt>Date.now()-60000 && JSON.parse(row.value).applicationId===process.env.EXOLVE_APPLICATION_UUID;
    return {success:true,candidates:fresh?Existing.candidates(id):[],updatedAt:row?.updatedAt,
        ...(fresh?{}:{operation:Store.publicOperation(Store.request(id,'inventory',{},auth.userId))})};
}
function importNumber(auth,businessId,body,key) {
    const id=authorize(auth,businessId,true);
    return {success:true,operation:Store.publicOperation(Existing.begin(id,body,key,auth.userId))};
}
function external(auth,businessId,id,body,key,action='save') {
    const business=authorize(auth,businessId,true);
    return {success:true,operation:Store.publicOperation(require('./external-sip').request(business,id,body,key,auth.userId,action))};
}
module.exports={external,existing,importNumber,authorize,overview,catalog,quotes,order,getOperation};
