'use strict';
const express = require('express');
const Release = require('../services/ava-release-flags.service');
const router = express.Router();
const path = '/businesses/:businessId/release-flags';
function error(res, e) { return res.status(e.statusCode || 503).json({success:false, code:e.statusCode ? e.code : 'AVA_RELEASE_UNAVAILABLE'}); }
router.use(path, (req,res,next) => {
    try {
        const actor = Release.authorize(req.auth, req.params.businessId, req.method==='PUT' ? 'business.manage' : 'sales.read');
        for (const input of [req.query,req.body]) for (const key of ['businessId','business_id','instanceId','instance_id'])
            if (input?.[key] != null && Number(input[key]) !== actor.businessId) throw Object.assign(new Error('BUSINESS_SCOPE_MISMATCH'), {code:'BUSINESS_SCOPE_MISMATCH',statusCode:403});
        if (req.method !== 'GET') {
            const origin = process.env.WHATSAPP_CRM_PUBLIC_URL ? new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin : `${req.protocol}://${req.get('host')}`;
            if (req.get('origin') !== origin || req.get('sec-fetch-site') === 'cross-site') throw Object.assign(new Error('ORIGIN_REQUIRED'), {code:'ORIGIN_REQUIRED',statusCode:403});
        }
        next();
    } catch(e) { error(res,e); }
});
router.get(path, (req,res) => { try { res.json(Release.overview(req.auth,req.params.businessId)); } catch(e) { error(res,e); } });
router.put(path, (req,res) => { try { res.json(Release.update(req.auth,req.params.businessId,req.body)); } catch(e) { error(res,e); } });
module.exports = router;
