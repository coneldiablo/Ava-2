'use strict';
const express=require('express');
const Service=require('../services/ava-autopilot.service');
const router=express.Router(),base='/businesses/:businessId';
function error(res,e){const known=typeof e?.code==='string'&&/^(AVA_|AUTOPILOT_|WORKSPACE_|SALES_|BUSINESS_|ACCOUNT_|CAPABILITY_)/.test(e.code);return res.status(known?(e.statusCode||503):503).json({success:false,code:known?e.code:'AUTOPILOT_UNAVAILABLE'});}
router.use(base,(req,res,next)=>{if(!/^\/(autopilot|catalog|quotes)(\/|$)/.test(req.path))return next();try{
 const actor=Service.authorize(req.auth,req.params.businessId);
 for(const source of [req.query,req.body])for(const k of ['businessId','business_id','instanceId','instance_id'])if(source?.[k]!=null&&Number(source[k])!==actor.businessId)throw Object.assign(new Error('BUSINESS_SCOPE_MISMATCH'),{code:'BUSINESS_SCOPE_MISMATCH',statusCode:403});
 if(req.method!=='GET'){
  const origin=process.env.WHATSAPP_CRM_PUBLIC_URL?new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin:`${req.protocol}://${req.get('host')}`;
  if(!req.get('origin')||req.get('origin')!==origin||req.get('sec-fetch-site')==='cross-site')throw Object.assign(new Error('AUTOPILOT_ORIGIN_REQUIRED'),{code:'AUTOPILOT_ORIGIN_REQUIRED',statusCode:403});
 }
 req.autopilotBusinessId=actor.businessId;next();
}catch(e){error(res,e);}});
const handle=(fn,status=200)=>(req,res)=>Promise.resolve().then(()=>fn(req)).then(value=>res.status(status).json(value)).catch(e=>error(res,e));
router.get(base+'/autopilot',handle(r=>Service.overview(r.auth,r.autopilotBusinessId)));
router.put(base+'/autopilot/policy',handle(r=>Service.updatePolicy(r.auth,r.autopilotBusinessId,r.body)));
router.post(base+'/autopilot/publish',handle(r=>Service.publish(r.auth,r.autopilotBusinessId,r.body)));
router.post(base+'/autopilot/pause',handle(r=>Service.pause(r.auth,r.autopilotBusinessId)));
router.post(base+'/autopilot/rollback',handle(r=>Service.rollback(r.auth,r.autopilotBusinessId,r.body)));
router.post(base+'/autopilot/simulations',handle(r=>Service.simulations(r.auth,r.autopilotBusinessId,r.body)));
router.get(base+'/catalog',handle(r=>Service.catalog(r.auth,r.autopilotBusinessId)));
router.post(base+'/catalog',handle(r=>Service.createOffer(r.auth,r.autopilotBusinessId,r.body),201));
router.patch(base+'/catalog/:id',handle(r=>Service.updateOffer(r.auth,r.autopilotBusinessId,r.params.id,r.body)));
router.post(base+'/catalog/:id/publish',handle(r=>Service.publishCatalog(r.auth,r.autopilotBusinessId,r.params.id,r.body)));
router.get(base+'/quotes',handle(r=>Service.listQuotes(r.auth,r.autopilotBusinessId,r.query)));
router.post(base+'/quotes',handle(r=>Service.createQuote(r.auth,r.autopilotBusinessId,r.body),201));
router.post(base+'/quotes/:id/send',handle(r=>Service.sendQuote(r.auth,r.autopilotBusinessId,r.params.id,r.body)));
module.exports=router;
