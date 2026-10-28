'use strict';
const express=require('express');
const Service=require('../services/telephony/service');
const Store=require('../services/telephony/store');
const {fields}=require('../services/telephony/policy');
const Access=require('../services/identity/customer-access');
const router=express.Router();
const base='/businesses/:businessId/telephony';
function error(res,e) {
    const code=/^(TELEPHONY_|BUSINESS_|CAPABILITY_|ACCOUNT_|CUSTOMER_)/.test(e.code || e.message || '')?(e.code || e.message):'TELEPHONY_UNAVAILABLE';
    res.status(e.statusCode || 503).json({success:false,code});
}
function handle(fn,status=200) {
    return (req,res)=>{try {
        // Always refresh cookie/canonical membership at the point of action.
        Access.reauthorize(req,Number(req.params.businessId),req.method==='GET'?'business.read':'business.manage');
        if(req.method!=='GET') {
            const accepted=new Set([`${req.protocol}://${req.get('host')}`]);
            if(process.env.WHATSAPP_CRM_PUBLIC_URL) accepted.add(new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin);
            if(!accepted.has(req.get('origin')) || req.get('sec-fetch-site')==='cross-site')
                throw Object.assign(new Error('CUSTOMER_ORIGIN_REQUIRED'),{code:'CUSTOMER_ORIGIN_REQUIRED',statusCode:403});
        }
        res.set('Cache-Control','no-store').status(status).json(fn(req));
    }catch(e){error(res,e);}};
}
router.get(base,handle(r=>Service.overview(r.auth,r.params.businessId)));
router.get(base+'/external/requests/:key',handle(r=>require('../services/telephony/external-sip').requestByKey(Service.authorize(r.auth,r.params.businessId),r.params.key)));
router.post(base+'/external',handle(r=>Service.external(r.auth,r.params.businessId,null,r.body,r.get('Idempotency-Key')),202));
router.put(base+'/external/:id',handle(r=>Service.external(r.auth,r.params.businessId,r.params.id,r.body,r.get('Idempotency-Key')),202));
for(const action of ['check','disconnect'])router.post(base+'/external/:id/'+action,handle(r=>Service.external(r.auth,r.params.businessId,r.params.id,r.body,r.get('Idempotency-Key'),action),202));
router.get(base+'/calls/:callId/result',handle(r=>require('../services/telephony/call-result').read(r.auth,Number(r.params.businessId),r.params.callId)));
router.get(base+'/records/:recordId/transcript',async(req,res)=>{
    try {
        const id=Number(req.params.businessId);
        const reauthorize=()=>Access.reauthorize(req,id,'business.read');
        reauthorize();
        const result=await require('../services/telephony/call-result').transcript(req.auth,id,req.params.recordId,reauthorize);
        reauthorize();res.set('Cache-Control','no-store').json(result);
    } catch(e) {error(res,e);}
});
for(const prefix of [base]) {
    router.get(prefix+'/existing',handle(r=>Service.existing(r.auth,r.params.businessId)));
    router.post(prefix+'/imports',handle(r=>Service.importNumber(r.auth,r.params.businessId,r.body,r.get('Idempotency-Key')),202));
}
router.get(base+'/catalog',handle(r=>Service.catalog(r.auth,r.params.businessId)));
router.post(base+'/quotes',handle(r=>Service.quotes(r.auth,r.params.businessId,r.body),202));
router.post(base+'/orders',handle(r=>Service.order(r.auth,r.params.businessId,r.body,r.get('Idempotency-Key')),202));
router.get(base+'/orders/:id',handle(r=>Service.getOperation(r.auth,r.params.businessId,r.params.id)));
router.put(base+'/primary',handle(r=>{
    const id=Service.authorize(r.auth,r.params.businessId,true);fields(r.body,['phoneId']);
    return {success:true,number:Store.primary(id,r.body.phoneId)};
}));
for(const action of ['release','cancel-release']) router.post(base+'/numbers/:id/'+action,handle(r=>{
    const id=Service.authorize(r.auth,r.params.businessId,true);fields(r.body,[]);
    return {success:true,number:Store.release(id,r.params.id,action==='cancel-release')};
}));
module.exports=router;
