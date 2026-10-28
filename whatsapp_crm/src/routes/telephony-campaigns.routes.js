'use strict';
const express = require('express');
const Access = require('../services/identity/customer-access');
const Identity = require('../services/identity/identity-store');
const Campaigns = require('../services/telephony/campaigns');
const router = express.Router();
const base = '/businesses/:businessId/outbound';
function guard(req,write) {
    const id = Number(req.params.businessId);
    if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error(),{code:'TELEPHONY_SCOPE_INVALID',statusCode:400});
    if (!req.auth?.userId || req.auth?.platformRole === 'platform_admin') throw Object.assign(new Error(),{code:'CUSTOMER_ACCESS_REQUIRED',statusCode:403});
    Access.reauthorize(req,id,write?'business.manage':'business.read');
    if(write) {
        const origins = new Set([`${req.protocol}://${req.get('host')}`]);
        if(process.env.WHATSAPP_CRM_PUBLIC_URL) origins.add(new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin);
        if(!origins.has(req.get('origin')) || req.get('sec-fetch-site')==='cross-site') throw Object.assign(new Error(),{code:'CUSTOMER_ORIGIN_REQUIRED',statusCode:403});
    }
    return id;
}
function handle(fn) { return async(req,res)=>{
    try {
        const id = guard(req,req.method!=='GET');
        const result = await fn(req,id,()=>guard(req,req.method!=='GET'));
        guard(req,req.method!=='GET');
        res.set('Cache-Control','no-store').status(result.success===false?202:200).json(result);
    } catch(error) {
        const code = /^(TELEPHONY_|CUSTOMER_|BUSINESS_)[A-Z_]+$/.test(error.code||error.message||'') ? error.code||error.message : 'TELEPHONY_UNAVAILABLE';
        res.set('Cache-Control','no-store').status(error.statusCode||503).json({success:false,code});
    }
}; }
router.post(base+'/imports/preview',handle((req,id)=>Campaigns.preview(id,req.auth.userId,req.body)));
router.get(base+'/campaigns',handle((req,id)=>Campaigns.list(id)));
router.post(base+'/campaigns',handle((req,id)=>Campaigns.create(id,req.auth.userId,req.body,req.get('Idempotency-Key'))));
router.patch(base+'/campaigns/:campaignId/retry-settings',handle((req,id)=>Campaigns.updateRetrySettings(id,req.params.campaignId,req.body)));
router.get(base+'/campaigns/:campaignId',handle((req,id)=>Campaigns.details(id,req.params.campaignId)));
router.post(base+'/campaigns/:campaignId/commands',handle((req,id,reauthorize)=>Campaigns.command(id,req.auth.userId,req.params.campaignId,req.body,req.get('Idempotency-Key'),{reauthorize})));
router.post(base+'/campaigns/:campaignId/reconcile',handle((req,id,reauthorize)=>Campaigns.reconcile(id,req.params.campaignId,reauthorize)));
module.exports = router;
