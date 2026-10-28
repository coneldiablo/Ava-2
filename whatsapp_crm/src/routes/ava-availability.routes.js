'use strict';
const express = require('express');
const Availability = require('../services/ava-availability.service');
const router = express.Router();
const base = '/businesses/:businessId/workspace/availability';

function errorResponse(res, error) {
    const known = typeof error?.code === 'string' && /^(AVAILABILITY_|SALES_|ACCOUNT_|BUSINESS_|CAPABILITY_|AVA_|WORKSPACE_)/.test(error.code);
    return res.status(known ? error.statusCode || 503 : 503)
        .json({success:false, code:known ? error.code : 'AVAILABILITY_UNAVAILABLE'});
}

function guard(req, res, next) {
    try {
        const actor = Availability.authorize(req.auth, req.params.businessId);
        for (const source of [req.query, req.body]) {
            for (const key of ['businessId', 'business_id', 'instanceId', 'instance_id']) {
                if (source?.[key] != null && Number(source[key]) !== actor.businessId)
                    throw Object.assign(new Error('BUSINESS_SCOPE_MISMATCH'), {code:'BUSINESS_SCOPE_MISMATCH', statusCode:403});
            }
        }
        if (req.method !== 'GET') {
            const accepted = process.env.WHATSAPP_CRM_PUBLIC_URL ? new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin
                : `${req.protocol}://${req.get('host')}`;
            if (req.get('origin') !== accepted || req.get('sec-fetch-site') === 'cross-site')
                throw Object.assign(new Error('WORKSPACE_ORIGIN_REQUIRED'), {code:'WORKSPACE_ORIGIN_REQUIRED', statusCode:403});
        }
        req.availabilityBusinessId = actor.businessId;
        next();
    } catch (error) { errorResponse(res, error); }
}

router.get(base, guard, (req, res) => {
    try { res.json(Availability.list(req.auth, req.availabilityBusinessId)); }
    catch (error) { errorResponse(res, error); }
});
router.patch(base + '/:userId', guard, (req, res) => {
    try { res.json(Availability.patch(req.auth, req.availabilityBusinessId, req.params.userId, req.body)); }
    catch (error) { errorResponse(res, error); }
});
module.exports = router;
