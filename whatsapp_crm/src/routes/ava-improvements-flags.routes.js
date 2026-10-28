'use strict';
const express = require('express');
const Flags = require('../services/ava-improvements-flags.service');
const router = express.Router();
function errorResponse(res, error) {
    const known = /^(WORKSPACE_|SALES_|ACCOUNT_|BUSINESS_|CAPABILITY_|AVA_)/.test(error?.code || '');
    return res.status(known ? (error.statusCode || 503) : 503).json({success: false, code: known ? error.code : 'WORKSPACE_FEATURES_UNAVAILABLE'});
}
function scope(req, res, next) {
    try {
        const view = Flags.overview(req.auth, req.params.businessId);
        for (const source of [req.body, req.query]) for (const key of ['businessId', 'business_id', 'instanceId', 'instance_id'])
            if (source?.[key] != null && Number(source[key]) !== view.businessId)
                throw Object.assign(new Error('BUSINESS_SCOPE_MISMATCH'), {code: 'BUSINESS_SCOPE_MISMATCH', statusCode: 403});
        if (req.method !== 'GET') {
            const origin = process.env.WHATSAPP_CRM_PUBLIC_URL ? new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin : `${req.protocol}://${req.get('host')}`;
            if (req.get('origin') !== origin || req.get('sec-fetch-site') === 'cross-site')
                throw Object.assign(new Error('WORKSPACE_ORIGIN_REQUIRED'), {code: 'WORKSPACE_ORIGIN_REQUIRED', statusCode: 403});
        }
        req.improvementBusinessId = view.businessId;
        next();
    } catch (error) { errorResponse(res, error); }
}
router.get('/businesses/:businessId/workspace/features', scope, (req, res) => {
    try { res.json(Flags.overview(req.auth, req.improvementBusinessId)); } catch (error) { errorResponse(res, error); }
});
router.patch('/businesses/:businessId/workspace/features', scope, (req, res) => {
    try { res.json(Flags.update(req.auth, req.improvementBusinessId, req.body)); } catch (error) { errorResponse(res, error); }
});
module.exports = router;
