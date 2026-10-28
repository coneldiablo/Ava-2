'use strict';
const express=require('express');
const Analytics=require('../services/ava-analytics.service');
const router=express.Router();
const base='/businesses/:businessId/workspace';
router.use([base+'/analytics',base+'/quality-criteria'],(req,res,next)=>{
    try {
        const businessId=Analytics.authorize(req.auth,req.params.businessId,req.method==='PUT'?'business.manage':'sales.assign');
        require('../services/ava-release-flags.service').assertEnabled(businessId,'analytics');
        for(const input of [req.query,req.body])for(const key of ['businessId','business_id','instanceId','instance_id'])
            if(input?.[key]!=null&&Number(input[key])!==businessId)throw Object.assign(new Error('BUSINESS_SCOPE_MISMATCH'),{code:'BUSINESS_SCOPE_MISMATCH',statusCode:403});
        next();
    }catch(e){error(res,e);}
});
function error(res,e){return res.status(e.statusCode||503).json({success:false,code:e.statusCode?e.code:'ANALYTICS_UNAVAILABLE'});}
router.get(base+'/analytics',(req,res)=>{try{res.json(Analytics.report(req.auth,req.params.businessId,req.query));}catch(e){error(res,e);}});
router.get(base+'/quality-criteria',(req,res)=>{try{const id=Analytics.authorize(req.auth,req.params.businessId);res.json({success:true,businessId:id,...Analytics.criteria(id)});}catch(e){error(res,e);}});
router.put(base+'/quality-criteria',(req,res)=>{
    try{
        const origin=process.env.WHATSAPP_CRM_PUBLIC_URL?new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin:`${req.protocol}://${req.get('host')}`;
        if(req.get('origin')!==origin||req.get('sec-fetch-site')==='cross-site')throw Object.assign(new Error('ORIGIN_REQUIRED'),{code:'ORIGIN_REQUIRED',statusCode:403});
        res.json(Analytics.saveCriteria(req.auth,req.params.businessId,req.body));
    }catch(e){error(res,e);}
});
module.exports=router;
