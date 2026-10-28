'use strict';
const router=require('express').Router();
const Identity=require('../services/identity/identity-store');
const service=require('../services/client-identity.service');
function handler(action) { return (req,res)=> { try {
    const business=Number(req.params.instanceId);
    if(!Number.isSafeInteger(business)||business<1) return res.status(400).json({success:false,error:'INVALID_BUSINESS'});
    if(!req.auth?.userId && req.auth?.platformRole!=='platform_admin') return res.status(403).json({success:false,error:'CUSTOMER_ACCESS_REQUIRED'});
    Identity.authorizeCapability(req.auth,business,req.method==='GET'||req.method==='HEAD'?'business.read':'sales.write');
    for(const source of [req.body,req.query]) for(const key of ['instanceId','instance_id','businessId','business_id']) if(source?.[key]!=null&&Number(source[key])!==business) return res.status(403).json({success:false,error:'BUSINESS_SCOPE_MISMATCH'});
    if(req.method!=='GET') {
        const origins=new Set([`${req.protocol}://${req.get('host')}`]);
        if(process.env.WHATSAPP_CRM_PUBLIC_URL) origins.add(new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin);
        if(!origins.has(req.headers.origin)||req.headers['sec-fetch-site']==='cross-site') return res.status(403).json({success:false,error:'CUSTOMER_ORIGIN_REQUIRED'});
    }
    if(req.method!=='GET'&&req.method!=='HEAD') {
        const {row}=require('../services/sales-workspace.service').authorizeClientMutation(req.auth,business,req.params.chatId,{capability:'sales.write'});
        req.params.chatId=row.chatId;
    }
    const result=action(business,req.params.chatId,req);
    res.json({success:true,...result});
} catch(error) { res.status(error.statusCode||500).json({success:false,error:error.code||'IDENTITY_OPERATION_FAILED',...(error.conflictingChatId?{conflictingChatId:error.conflictingChatId}:{})}); } }; }
router.get('/clients/:instanceId/:chatId/identities',handler((id,chat)=>service.list(id,chat)));
router.post('/clients/:instanceId/:chatId/identities',handler((id,chat,req)=>service.attach(id,chat,req.body||{})));
router.delete('/clients/:instanceId/:chatId/identities/:aliasId',handler((id,chat,req)=>service.unlink(id,chat,req.params.aliasId)));
module.exports=router;
