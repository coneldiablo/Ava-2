'use strict';

const express = require('express');
const DB = require('../services/database.service');
const Identity = require('../services/identity/identity-store');
const SmartTriggers = require('../services/smart-triggers.service');

const router = express.Router();

function fail(res, status, code) {
    return res.status(status).json({ success: false, code });
}

router.post('/businesses/:businessId/triggers/:triggerId/preview', async (req, res) => {
    const businessId = Number(req.params.businessId);
    const triggerId = Number(req.params.triggerId);
    if (!Number.isSafeInteger(businessId) || businessId < 1 || String(businessId) !== req.params.businessId
        || !Number.isSafeInteger(triggerId) || triggerId < 1 || String(triggerId) !== req.params.triggerId) {
        return fail(res, 400, 'INVALID_PREVIEW_SCOPE');
    }
    if (!req.auth?.userId && req.auth?.platformRole !== 'platform_admin') {
        return fail(res, 403, 'CUSTOMER_ACCESS_REQUIRED');
    }
    try {
        Identity.authorizeCapability(req.auth, businessId, 'business.read');
    } catch (_) {
        return fail(res, 403, 'BUSINESS_ACCESS_DENIED');
    }

    // Same-origin is required even though this endpoint is read-only: POST must
    // not become an unauthenticated cross-site oracle for tenant trigger rules.
    let acceptedOrigin;
    try {
        acceptedOrigin = process.env.WHATSAPP_CRM_PUBLIC_URL
            ? new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin
            : `${req.protocol}://${req.get('host')}`;
    } catch (_) { return fail(res, 503, 'PREVIEW_UNAVAILABLE'); }
    if (!req.get('origin') || req.get('origin') !== acceptedOrigin
        || req.get('sec-fetch-site') === 'cross-site') return fail(res, 403, 'ORIGIN_REQUIRED');

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'sampleText')
        || typeof body.sampleText !== 'string' || !body.sampleText.trim()
        || body.sampleText.length > 2000 || Object.keys(req.query || {}).length) {
        return fail(res, 400, 'INVALID_PREVIEW_REQUEST');
    }

    try {
        const trigger = await DB.getTrigger(triggerId);
        // Membership may have been revoked while storage was queried.
        try { require('../services/identity/customer-access').reauthorize(req, businessId, 'business.read'); }
        catch (_) { return fail(res, 403, 'BUSINESS_ACCESS_DENIED'); }
        if (!trigger || Number(trigger.instanceId) !== businessId) {
            return fail(res, 404, 'TRIGGER_NOT_FOUND');
        }
        if (trigger.triggerType !== 'keyword') return fail(res, 400, 'KEYWORD_TRIGGER_REQUIRED');
        let conditions;
        try {
            conditions = typeof trigger.conditions === 'string'
                ? JSON.parse(trigger.conditions) : trigger.conditions;
        } catch (_) { return fail(res, 422, 'INVALID_TRIGGER_CONDITIONS'); }
        if (!conditions || !Array.isArray(conditions.keywords)) {
            return fail(res, 422, 'INVALID_TRIGGER_CONDITIONS');
        }
        const result = SmartTriggers.matchKeywordText(conditions, body.sampleText);
        return res.json({
            success: true, businessId, triggerId,
            matched: result.matched, matchedKeyword: result.matchedKeyword,
            dryRun: true, actionExecuted: false,
        });
    } catch (_) {
        return fail(res, 503, 'PREVIEW_UNAVAILABLE');
    }
});

module.exports = router;
