'use strict';

const express = require('express');
const Auth = require('../services/auth.service');
const Onboarding = require('../services/onboarding-state.service');
const router = express.Router();
const failure = (code, statusCode = 403) => Object.assign(new Error(code), { code, statusCode });
const publicCodes = new Set(['BUSINESS_SCOPE_REQUIRED', 'BUSINESS_NOT_FOUND', 'BUSINESS_ACCESS_DENIED',
    'ACCOUNT_NOT_ACTIVE', 'CAPABILITY_DENIED', 'PLATFORM_ADMIN_REQUIRED', 'ONBOARDING_OWNER_REQUIRED',
    'ONBOARDING_STEP_INVALID', 'ONBOARDING_STEPS_REQUIRED', 'ONBOARDING_STORAGE_UNAVAILABLE',
    'ONBOARDING_REQUEST_INVALID', 'ONBOARDING_PREPARATION_CHANGED', 'CUSTOMER_ORIGIN_REQUIRED', 'AUTHENTICATION_REQUIRED']);

function handle(action, mutation = false) {
    return (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            // This router is mounted before the global role boundary, so it
            // independently verifies a live cookie even if global auth is off.
            const current = Auth.getSession(req);
            if (!current || (req.auth?.userId && current.userId !== req.auth.userId)) {
                throw failure('AUTHENTICATION_REQUIRED', 401);
            }
            const hasPayload = Number(req.get('content-length') || 0) > 0 || Boolean(req.get('transfer-encoding'));
            if ((hasPayload && !req.is('application/json')) || Object.keys(req.query || {}).length || (req.body !== undefined
                && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
                    || Object.keys(req.body).length))) throw failure('ONBOARDING_REQUEST_INVALID', 400);
            if (mutation) {
                const accepted = new Set();
                if (process.env.WHATSAPP_CRM_PUBLIC_URL) accepted.add(new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin);
                if (req.get('host')) accepted.add(`${req.protocol}://${req.get('host')}`);
                if (!accepted.has(req.get('origin')) || req.get('sec-fetch-site') === 'cross-site') {
                    throw failure('CUSTOMER_ORIGIN_REQUIRED');
                }
            }
            const onboarding = action(current, req.params.businessId, req.params.stepId);
            return res.json({ success: true, onboarding });
        } catch (error) {
            const code = publicCodes.has(error.code) ? error.code : 'ONBOARDING_UNAVAILABLE';
            return res.status(code === 'ONBOARDING_UNAVAILABLE' ? 503 : error.statusCode || 403)
                .json({ success: false, code, error: 'Не удалось обновить состояние настройки.' });
        }
    };
}

router.get('/businesses/:businessId/onboarding', handle(Onboarding.get));
router.post('/businesses/:businessId/onboarding/steps/:stepId', handle(Onboarding.confirmStep, true));
router.post('/businesses/:businessId/onboarding/complete', handle(Onboarding.complete, true));

function preparationHandle(write) {
    return (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            const current = Auth.getSession(req);
            if (!current?.userId) throw failure('AUTHENTICATION_REQUIRED', 401);
            if (Object.keys(req.query || {}).length) throw failure('ONBOARDING_REQUEST_INVALID', 400);
            if (write && (req.get('origin') !== require('../services/identity/public-url').getPublicUrl().origin || req.get('sec-fetch-site') === 'cross-site')) throw failure('CUSTOMER_ORIGIN_REQUIRED');
            const preparation = write ? Onboarding.savePreparation(current, req.params.businessId, req.body) : Onboarding.preparation(current, req.params.businessId);
            res.json({ success: true, preparation });
        } catch (error) { const code = publicCodes.has(error.code) ? error.code : 'ONBOARDING_UNAVAILABLE'; res.status(code === 'ONBOARDING_UNAVAILABLE' ? 503 : error.statusCode || 403).json({ success: false, code, error: 'Не удалось сохранить описание бизнеса.' }); }
    };
}
router.get('/businesses/:businessId/onboarding/preparation', preparationHandle(false));
router.put('/businesses/:businessId/onboarding/preparation', express.json({ limit: '64kb' }), preparationHandle(true));
module.exports = router;
