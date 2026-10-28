'use strict';
const express=require('express');
const Auth=require('../services/auth.service');
const Identity=require('../services/identity/identity-store');
const Store=require('../services/integrations/store');
const Amo=require('../services/integrations/amocrm');
const Avito=require('../services/avito.service');
const router=express.Router(),publicRouter=express.Router();
const base='/external-integrations/:instanceId';
function integration(req) {if(!['amocrm','avito'].includes(req.params.provider))Store.fail('EXTERNAL_PROVIDER_INVALID',404);return req.params.provider==='avito'?Avito:Amo;}
function authorized(req,capability='business.manage') {
    const id=Number(req.params.instanceId),current=Auth.getSession(req);
    if(!current?.userId||!req.auth?.userId||String(current.userId)!==String(req.auth.userId))Store.fail('AUTHENTICATION_REQUIRED',401);
    Store.scope(id,req.params.provider||'amocrm');Identity.authorizeCapability(current,id,capability);
    for(const data of [req.body,req.query])for(const key of ['instanceId','instance_id','businessId','business_id'])if(data?.[key]!=null&&Number(data[key])!==id)Store.fail('BUSINESS_SCOPE_MISMATCH',403);
    if(req.method!=='GET'&&req.method!=='HEAD') {
        let origin;try{origin=new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin;}catch(_){Store.fail('EXTERNAL_PUBLIC_URL_REQUIRED',503);}
        if(req.get('origin')!==origin||req.get('sec-fetch-site')==='cross-site')Store.fail('CUSTOMER_ORIGIN_REQUIRED',403);
    }
    return id;
}
function sendError(res,e) {
    const code=/^(EXTERNAL_|AVITO_|BUSINESS_|CAPABILITY_|AUTHENTICATION_|CUSTOMER_|ACCOUNT_)/.test(e?.code||'')?e.code:'EXTERNAL_OPERATION_FAILED';
    return res.status(e.statusCode||502).json({success:false,error:code,code,unknown:e.unknown===true,safeToRetry:e.safeToRetry===true,
        message:code==='EXTERNAL_ACCESS_DENIED'?'У аккаунта нет доступа к этому API. Проверьте разрешения подключения.':code==='EXTERNAL_OUTCOME_UNKNOWN'?'Результат действия не подтверждён. Проверьте историю у провайдера.':'Не удалось завершить действие. Проверьте подключение и повторите попытку.',...(e.retryAt?{retryAt:e.retryAt}:{})});
}
const handle=(action,capability='business.manage')=>async(req,res)=>{try {
    res.set('Cache-Control','no-store');const id=authorized(req,capability),service=integration(req);
    const result=await action(id,service,req,()=>authorized(req,capability));
    authorized(req,capability);res.json({success:true,...result});
}catch(e){sendError(res,e);}};
router.get(base+'/:provider',handle((id,_,req)=>({integration:Store.status(id,req.params.provider)}),'business.read'));
router.put(base+'/:provider',express.json({limit:'24kb'}),handle((id,service,req)=>({integration:service.save(id,req.body||{},{actorId:req.auth.userId})})));
router.post(base+'/:provider/connect',express.json({limit:'8kb'}),handle(async(id,service,req,check)=>({integration:await service.connect(id,req.body||{},{beforeWrite:check})})));
router.post(base+'/:provider/check',handle(async(id,service)=>({integration:await service.check(id)})));
router.delete(base+'/:provider',handle((id,_,req)=>{Store.disconnect(id,req.params.provider);return {integration:Store.status(id,req.params.provider)};}));
router.post(base+'/:provider/webhook',handle(async(id,service)=>service.subscribe(id)));
const AmoCatalog=require('../services/integrations/amocrm-catalog');
function catalogHandle(action,capability='business.manage'){return(req,res,next)=>{req.params.provider='amocrm';return handle(action,capability)(req,res,next);};}
router.get(base+'/amocrm/catalog',catalogHandle(id=>({catalog:AmoCatalog.state(id)}),'business.read'));
router.post(base+'/amocrm/catalog/preview',express.json({limit:'8kb'}),catalogHandle(async(id,_,r,check)=>({preview:await AmoCatalog.preview(id,r.body||{},{beforeWrite:check})})));
router.post(base+'/amocrm/catalog/publish',express.json({limit:'8kb'}),catalogHandle((id,_,r,check)=>({publication:AmoCatalog.publish(id,r.body?.previewId,{beforeWrite:check})})));
router.put(base+'/amocrm/catalog/settings',express.json({limit:'8kb'}),catalogHandle((id,_,r)=>({catalog:AmoCatalog.settings(id,r.body||{},{actorId:r.auth.userId})})));
router.get(base+'/amocrm/options',(req,res,next)=>{req.params.provider='amocrm';return handle(async(id)=>Amo.options(id))(req,res,next);});
router.post(base+'/amocrm/link',express.json({limit:'8kb'}),(req,res,next)=>{req.params.provider='amocrm';return handle(async(id,_,r,check)=>Amo.attachExisting(id,r.body||{},check))(req,res,next);});
router.get(base+'/avito/chats',(req,res,next)=>{req.params.provider='avito';return handle(async(id,_,r)=>Avito.chats(id,{offset:Number(r.query.offset||0)}))(req,res,next);});
router.post(base+'/avito/chats/:chatId/import',(req,res,next)=>{req.params.provider='avito';return handle(async(id,_,r)=>Avito.importChat(id,r.params.chatId))(req,res,next);});
router.post(base+'/:provider/sync',express.json({limit:'24kb'}),handle(async(id,service,req,check)=> {
    if(req.params.provider==='avito')return service.sync(id);
    if(req.body?.chatId==null)return service.sync(id);
    if(typeof req.body.chatId!=='string'||!req.body.chatId)Store.fail('EXTERNAL_CLIENT_REQUIRED');
    if(req.body.kind&&!['lead','note','task'].includes(req.body.kind))Store.fail('EXTERNAL_SYNC_KIND_INVALID');
    return service.syncClient(id,req.body.chatId,null,{kind:req.body.kind||'lead',text:req.body.text,sourceId:req.body.sourceId,completeTill:req.body.completeTill,beforeWrite:check});
}));
publicRouter.get('/external-integrations/callback/amocrm',async(req,res)=>{try{
    await Amo.callback(req.query);res.set('Cache-Control','no-store').redirect('/channels?integration=amocrm');
}catch(e){sendError(res,e);}});
publicRouter.post('/external-integrations/webhook/:provider/:instanceId/:secret',express.json({limit:'128kb'}),express.urlencoded({extended:true,limit:'128kb'}),async(req,res)=>{try{
    const id=Store.scope(req.params.instanceId,req.params.provider),service=integration(req);
    const result=await service.webhook(id,req.params.secret,req.body||{});res.set('Cache-Control','no-store').json({success:true,...result});
}catch(e){sendError(res,e);}});
module.exports=router;
module.exports.publicRouter=publicRouter;
