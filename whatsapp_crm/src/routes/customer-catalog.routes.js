'use strict';
const express=require('express'),multer=require('multer');
const Auth=require('../services/auth.service');
const Service=require('../services/catalog-import.service');
const {getPublicUrl}=require('../services/identity/public-url');
const router=express.Router(),base='/businesses/:businessId/catalog-imports';
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:0}}).single('file');
function error(res,e){const code=typeof e.code==='string'&&/^(CATALOG_|BUSINESS_|ACCOUNT_|CAPABILITY_|CUSTOMER_|AUTHENTICATION_|PLATFORM_)/.test(e.code)?e.code:'CATALOG_UNAVAILABLE';return res.status(e.statusCode||503).json({success:false,code,error:'Не удалось выполнить действие с каталогом.',...(e.details?{details:e.details}:{})});}
function guard(req,res,next){try{const current=Auth.getSession(req);if(!current?.userId)throw {code:'AUTHENTICATION_REQUIRED',statusCode:401};req.catalogActor=current;Service.authorize(current,req.params.businessId,req.method!=='GET');if(req.method!=='GET'&&(req.get('origin')!==getPublicUrl().origin||req.get('sec-fetch-site')==='cross-site'))throw {code:'CUSTOMER_ORIGIN_REQUIRED',statusCode:403};next();}catch(e){error(res,e);}}
router.use(base,guard);
router.post(base+'/preview',(req,res)=>upload(req,res,async e=>{if(e)return error(res,{code:e.code==='LIMIT_FILE_SIZE'?'CATALOG_FILE_TOO_LARGE':'CATALOG_FILE_INVALID',statusCode:400});try{res.set('Cache-Control','no-store');res.json(await Service.preview(req.catalogActor,req.params.businessId,req.file,{beforeWrite:()=>{const live=Auth.getSession(req);if(!live?.userId||live.userId!==req.catalogActor.userId)throw {code:'AUTHENTICATION_REQUIRED',statusCode:401};}}));}catch(e){error(res,e);}}));
const handle=fn=>(req,res)=>{try{res.set('Cache-Control','no-store');res.json(fn(req.catalogActor,req.params.businessId,req.params.id,req.body));}catch(e){error(res,e);}};
router.get(base+'/:id',handle(Service.get));
router.post(base+'/:id/validate',express.json({limit:'8kb'}),handle(Service.validate));
router.post(base+'/:id/commit',express.json({limit:'8kb'}),handle(Service.commit));
router.post(base+'/:id/rollback',handle(Service.rollback));
module.exports=router;
