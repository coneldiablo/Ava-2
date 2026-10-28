'use strict';
const express=require('express');
const Workspace=require('../services/ava-workspace.service');
const Recovery=require('../services/ava-send-recovery.service');
const router=express.Router();
const base='/businesses/:businessId';
function errorResponse(res,error){const known=typeof error?.code==='string'&&/^(WORKSPACE_|SALES_|ACCOUNT_|BUSINESS_|CAPABILITY_|AVA_|WHATSAPP_MEDIA_|AI_)/.test(error.code);return res.status(known?(error.statusCode||503):503).json({success:false,code:known?error.code:'WORKSPACE_UNAVAILABLE',...(error?.media?{media:error.media}:{})});}
function scopedGuard(req,res,next,workspaceRequired){try{const actor=Workspace.authorize(req.auth,req.params.businessId);if(workspaceRequired)require('../services/ava-release-flags.service').assertEnabled(actor.businessId,'workspace');for(const source of [req.query,req.body])for(const key of ['businessId','business_id','instanceId','instance_id'])if(source?.[key]!=null&&Number(source[key])!==actor.businessId)throw Object.assign(new Error('BUSINESS_SCOPE_MISMATCH'),{code:'BUSINESS_SCOPE_MISMATCH',statusCode:403});if(req.method!=='GET'){const accepted=process.env.WHATSAPP_CRM_PUBLIC_URL?new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin:`${req.protocol}://${req.get('host')}`;if(req.get('origin')!==accepted||req.get('sec-fetch-site')==='cross-site')throw Object.assign(new Error('WORKSPACE_ORIGIN_REQUIRED'),{code:'WORKSPACE_ORIGIN_REQUIRED',statusCode:403});}req.workspaceBusinessId=actor.businessId;next();}catch(error){errorResponse(res,error);}}
function guard(req,res,next){return scopedGuard(req,res,next,true);}
// Attachments are also exposed by the legacy inbox and customer history.
function mediaGuard(req,res,next){return scopedGuard(req,res,next,false);}
function handle(fn,status=200){return async(req,res)=>{try{res.status(status).json(await fn(req));}catch(error){errorResponse(res,error);}};}
router.get(base+'/workspace',guard,handle(req=>Workspace.workspace(req.auth,req.workspaceBusinessId,req.query)));
router.get(base+'/workspace/clients/:chatId',guard,handle(req=>Workspace.clientWorkspace(req.auth,req.workspaceBusinessId,req.params.chatId,req.query)));
router.post(base+'/workspace/clients/:chatId/control',guard,handle(req=>Workspace.control(req.auth,req.workspaceBusinessId,req.params.chatId,req.body)));
router.get(base+'/workspace/clients/:chatId/reply-status',guard,handle(req=>Workspace.replyStatus(req.auth,req.workspaceBusinessId,req.params.chatId,req.query)));
router.get(base+'/workspace/clients/:chatId/reply-recovery',guard,handle(req=>Recovery.detail(req.auth,req.workspaceBusinessId,req.params.chatId,req.query)));
router.post(base+'/workspace/clients/:chatId/reply-recovery',guard,handle(req=>Recovery.reconcile(req.auth,req.workspaceBusinessId,req.params.chatId,req.body)));
router.post(base+'/workspace/clients/:chatId/reply',guard,handle(req=>Workspace.reply(req.auth,req.workspaceBusinessId,req.params.chatId,req.body)));
router.get(base+'/workspace/clients/:chatId/messages/:messageId/media',mediaGuard,async(req,res)=>{
    const controller=new AbortController(),abort=()=>controller.abort(),closed=()=>{if(!res.writableEnded)controller.abort();};
    req.on('aborted',abort);res.on('close',closed);
    try{
        const {buffer,mimeType}=await Workspace.mediaContent(req.auth,req.workspaceBusinessId,req.params.chatId,req.params.messageId,{signal:controller.signal});
        if(res.destroyed||res.headersSent)return;
        res.setHeader('Content-Type',mimeType||'application/octet-stream');
        res.setHeader('Content-Length',String(buffer.length));
        res.setHeader('Cache-Control','private, max-age=300');
        res.setHeader('X-Content-Type-Options','nosniff');
        return res.status(200).send(buffer);
    }catch(error){if(!res.destroyed&&!res.headersSent)return errorResponse(res,error);}
    finally{req.removeListener('aborted',abort);res.removeListener('close',closed);}
});
router.post(base+'/workspace/clients/:chatId/messages/:messageId/media/retry',mediaGuard,async(req,res)=>{
    const controller=new AbortController(),abort=()=>controller.abort(),closed=()=>{if(!res.writableEnded)controller.abort();};
    req.on('aborted',abort);res.on('close',closed);
    try{
        const result=await Workspace.retryMedia(req.auth,req.workspaceBusinessId,req.params.chatId,req.params.messageId,{signal:controller.signal});
        if(!res.destroyed&&!res.headersSent)return res.status(200).json(result);
    }catch(error){if(!res.destroyed&&!res.headersSent)return errorResponse(res,error);}
    finally{req.removeListener('aborted',abort);res.removeListener('close',closed);}
});
router.post(base+'/workspace/clients/:chatId/snooze',guard,handle(req=>Workspace.snooze(req.auth,req.workspaceBusinessId,req.params.chatId,req.body)));
router.get(base+'/promises',guard,handle(req=>Workspace.listPromises(req.auth,req.workspaceBusinessId,req.query)));
router.post(base+'/promises',guard,handle(req=>Workspace.createPromise(req.auth,req.workspaceBusinessId,req.body),201));
router.patch(base+'/promises/:id',guard,handle(req=>Workspace.updatePromise(req.auth,req.workspaceBusinessId,req.params.id,req.body)));
router.get(base+'/search',guard,handle(req=>Workspace.search(req.auth,req.workspaceBusinessId,req.query)));
router.get(base+'/saved-views',guard,handle(req=>Workspace.savedViews(req.auth,req.workspaceBusinessId)));
router.post(base+'/saved-views',guard,handle(req=>Workspace.createSavedView(req.auth,req.workspaceBusinessId,req.body),201));
router.delete(base+'/saved-views/:id',guard,handle(req=>Workspace.deleteSavedView(req.auth,req.workspaceBusinessId,req.params.id)));
module.exports=router;
