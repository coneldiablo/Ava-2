'use strict';
const router=require('express').Router();
const DB=require('../services/database.service');
const Access=require('../services/identity/customer-access');
const Settings=require('../services/whatsapp-response-settings.service');
for(const method of ['get','put']) router[method]('/businesses/:businessId/whatsapp/response-settings',async(req,res)=>{
    try{
        const id=Number(req.params.businessId);
        if(!req.auth?.userId || req.auth.platformRole==='platform_admin') throw Object.assign(new Error(),{code:'CUSTOMER_ACCESS_REQUIRED',statusCode:403});
        Access.reauthorize(req,id,method==='put'?'business.manage':'business.read');
        if(method==='put') {
            const origins=new Set([`${req.protocol}://${req.get('host')}`]);
            if(process.env.WHATSAPP_CRM_PUBLIC_URL) origins.add(new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin);
            if(!origins.has(req.get('origin')) || req.get('sec-fetch-site')==='cross-site') throw Object.assign(new Error(),{code:'CUSTOMER_ORIGIN_REQUIRED',statusCode:403});
        }
        if(!await DB.getInstance(id)) return res.status(404).json({success:false,code:'BUSINESS_NOT_FOUND'});
        Access.reauthorize(req,id,method==='put'?'business.manage':'business.read');
        const settings=method==='put'?Settings.save(id,req.body):Settings.get(id);
        res.set('Cache-Control','no-store').json({success:true,settings});
    }catch(e){res.status(e.statusCode||403).json({success:false,code:e.code||'WHATSAPP_SETTINGS_UNAVAILABLE'});}
});
module.exports=router;
