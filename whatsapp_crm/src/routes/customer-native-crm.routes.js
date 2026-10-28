'use strict';

const express = require('express');
const Identity = require('../services/identity/identity-store');
const NativeCrm = require('../services/customer-native-crm.service');

const router = express.Router();
const fail = (res, status, code) => res.status(status).json({ success: false, code });

function scope(req, res, mutation = false) {
    const businessId = Number(req.params.businessId);
    if (!Number.isSafeInteger(businessId) || businessId < 1 || String(businessId) !== req.params.businessId) {
        fail(res, 400, 'INVALID_BUSINESS_SCOPE'); return null;
    }
    if (!req.auth?.userId) { fail(res, 403, 'CUSTOMER_ACCESS_REQUIRED'); return null; }
    try { Identity.authorizeCapability(req.auth, businessId, mutation ? 'sales.write' : 'sales.read'); }
    catch (_) { fail(res, 403, 'BUSINESS_ACCESS_DENIED'); return null; }
    if (mutation) {
        try {
            const origin = process.env.WHATSAPP_CRM_PUBLIC_URL
                ? new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin : `${req.protocol}://${req.get('host')}`;
            if (req.get('origin') !== origin || req.get('sec-fetch-site') === 'cross-site') {
                fail(res, 403, 'ORIGIN_REQUIRED'); return null;
            }
        } catch (_) { fail(res, 503, 'CRM_UNAVAILABLE'); return null; }
    }
    return businessId;
}

function onError(res, error) {
    const codes = new Set(['TASK_INVALID','TASK_NOT_FOUND','TASK_KEY_CONFLICT','CLIENT_NOT_FOUND',
        'TWENTY_NOT_READY','TWENTY_OUTBOX_UNAVAILABLE', 'SALES_CLIENT_CLAIM_REQUIRED',
        'SALES_CLIENT_SCOPE_DENIED','SALES_CLIENT_NOT_FOUND','SALES_INPUT_INVALID','CAPABILITY_DENIED',
        'BUSINESS_ACCESS_DENIED','ACCOUNT_NOT_ACTIVE']);
    return fail(res, codes.has(error?.code) ? error.statusCode : 503,
        codes.has(error?.code) ? error.code : 'CRM_UNAVAILABLE');
}

router.post('/businesses/:businessId/crm/tasks', (req, res) => {
    const businessId = scope(req, res, true);
    if (!businessId) return;
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
        || Object.keys(req.body).some(key => !['summary','chatId'].includes(key))) {
        return fail(res, 400, 'TASK_INVALID');
    }
    try {
        if (req.body.chatId != null) {
            const { row } = require('../services/sales-workspace.service').authorizeClientMutation(
                req.auth, businessId, req.body.chatId, { capability: 'sales.write' });
            req.body.chatId = row.chatId;
        }
        const task = NativeCrm.createTask(businessId, req.auth.userId, {
            key: req.get('idempotency-key'), summary: req.body.summary, chatId: req.body.chatId ?? null,
        });
        return res.status(202).json({ success: true, businessId, task });
    } catch (error) { return onError(res, error); }
});

router.get('/businesses/:businessId/crm/tasks/:taskId', (req, res) => {
    const businessId = scope(req, res);
    if (!businessId) return;
    if (!/^customer_[0-9a-f]{64}$/.test(req.params.taskId)) return fail(res, 400, 'TASK_INVALID');
    try { return res.json({ success: true, businessId, task: NativeCrm.taskState(businessId, req.params.taskId) }); }
    catch (error) { return onError(res, error); }
});

module.exports = router;
