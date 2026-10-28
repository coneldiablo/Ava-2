'use strict';
const express=require('express');
const Store=require('../services/telephony/store');
const {fields,fail}=require('../services/telephony/policy');
const router=express.Router();
const handle=fn=>(req,res)=>{try {res.set('Cache-Control','no-store').json({success:true,...fn(req)});}
    catch(e){res.status(e.statusCode || 503).json({success:false,code:/^TELEPHONY_/.test(e.code || '')?e.code:'TELEPHONY_UNAVAILABLE'});}};
router.get('/resolve/:number',handle(r=>Store.resolve(r.params.number)));
router.get('/external/:id',handle(r=>require('../services/telephony/external-sip').ownerRoute(r.params.id,{active:r.query.active==='true'})));
router.get('/source/:businessId',handle(r=>Store.source(Number(r.params.businessId),r.query.sourceNumberId || null)));
router.post('/campaigns/can-dial',handle(r=>require('../services/telephony/campaign-permission').read(r.body)));
router.post('/calls/reserve',handle(r=>{
    fields(r.body,['businessId','sourceId','callId','direction','number']);
    if(!['inbound','outbound'].includes(r.body.direction) || !Number.isSafeInteger(r.body.businessId)) fail('TELEPHONY_CALL_INVALID');
    return Store.reserveCall(r.body);
}));
router.post('/calls/:id/finish',handle(r=>{
    fields(r.body,['businessId','seconds','channelId']);return Store.finishCall(r.params.id,r.body);
}));
module.exports=router;
