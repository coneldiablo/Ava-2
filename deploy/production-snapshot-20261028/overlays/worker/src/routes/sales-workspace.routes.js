'use strict';
const express=require('express');
const Sales=require('../services/sales-workspace.service');
const router=express.Router();
const base='/businesses/:businessId/sales-workspace';
function errorResponse(res,error) {
    const known=typeof error?.code==='string'&&/^(SALES_|ACCOUNT_|BUSINESS_|CAPABILITY_)/.test(error.code);
    return res.status(known?(error.statusCode||503):503).json({success:false,code:known?error.code:'SALES_WORKSPACE_UNAVAILABLE',
        error:known&&error.statusCode<500?'Действие недоступно. Обновите страницу и проверьте данные.':'Рабочее место продаж временно недоступно.'});
}
router.use(base,(req,res,next)=> {
    try {
        const actor=Sales.authorize(req.auth,req.params.businessId);
        for(const source of [req.query,req.body]) for(const key of ['businessId','business_id','instanceId','instance_id'])
            if(source?.[key]!=null&&Number(source[key])!==actor.businessId) throw Object.assign(new Error('BUSINESS_SCOPE_MISMATCH'),{code:'BUSINESS_SCOPE_MISMATCH',statusCode:403});
        if(req.method!=='GET') {
            const accepted=process.env.WHATSAPP_CRM_PUBLIC_URL?new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin:`${req.protocol}://${req.get('host')}`;
            if(!req.get('origin')||req.get('origin')!==accepted||req.get('sec-fetch-site')==='cross-site')
                throw Object.assign(new Error('SALES_ORIGIN_REQUIRED'),{code:'SALES_ORIGIN_REQUIRED',statusCode:403});
        }
        req.salesBusinessId=actor.businessId;next();
    } catch(error){errorResponse(res,error);}
});
function handle(fn,status=200) {return (req,res)=> {try {res.status(status).json(fn(req));}catch(error){errorResponse(res,error);}};}
router.get(base,handle(req=>Sales.workspace(req.auth,req.salesBusinessId,req.query)));
router.post(base+'/tasks',handle(req=>Sales.createTask(req.auth,req.salesBusinessId,req.body),201));
router.patch(base+'/tasks/:taskId',handle(req=>Sales.updateTask(req.auth,req.salesBusinessId,req.params.taskId,req.body)));
router.post(base+'/tasks/:taskId/claim',handle(req=> {
    if(Object.keys(req.body||{}).length) throw Object.assign(new Error('SALES_INPUT_INVALID'),{code:'SALES_INPUT_INVALID',statusCode:400});
    return Sales.claimTask(req.auth,req.salesBusinessId,req.params.taskId);
}));
router.put(base+'/clients/:chatId/assignee',handle(req=>Sales.assignClient(req.auth,req.salesBusinessId,req.params.chatId,req.body)));
module.exports=router;
