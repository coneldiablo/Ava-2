'use strict';
const router = require('express').Router();
const Collaboration = require('../services/ava-collaboration.service');
const Sales = require('../services/sales-workspace.service');
function errorResponse(res,error) {
    const known=/^(WORKSPACE_|SALES_|ACCOUNT_|BUSINESS_|CAPABILITY_|AVA_)/.test(error?.code||'');
    return res.status(known?(error.statusCode||503):503).json({success:false,code:known?error.code:'WORKSPACE_UNAVAILABLE'});
}
function guard(req,res,next) {
    try {
        const actor=Sales.authorize(req.auth,req.params.businessId);
        for(const source of [req.query,req.body]) for(const key of ['businessId','business_id','instanceId','instance_id'])
            if(source?.[key]!=null && Number(source[key])!==actor.businessId) throw Object.assign(new Error('BUSINESS_SCOPE_MISMATCH'),{code:'BUSINESS_SCOPE_MISMATCH',statusCode:403});
        if(req.method!=='GET') {
            const origin=process.env.WHATSAPP_CRM_PUBLIC_URL?new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin:`${req.protocol}://${req.get('host')}`;
            if(req.get('origin')!==origin || req.get('sec-fetch-site')==='cross-site') throw Object.assign(new Error('WORKSPACE_ORIGIN_REQUIRED'),{code:'WORKSPACE_ORIGIN_REQUIRED',statusCode:403});
        }
        req.collaborationBusinessId=actor.businessId;res.set('Cache-Control','no-store');next();
    } catch(error) {errorResponse(res,error);}
}
const base='/businesses/:businessId/workspace/clients/:chatId/presence';
router.get(base,guard,(req,res)=>{try{res.json(Collaboration.presence(req.auth,req.collaborationBusinessId,req.params.chatId));}catch(error){errorResponse(res,error);}});
router.post(base,guard,(req,res)=>{try{res.json(Collaboration.heartbeat(req.auth,req.collaborationBusinessId,req.params.chatId,req.body));}catch(error){errorResponse(res,error);}});
module.exports=router;
