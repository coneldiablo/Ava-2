'use strict';

const express = require('express');
const Identity = require('../services/identity/identity-store');
const Deals = require('../services/customer-deals.store');
const DB = require('../services/database.service');

const router = express.Router();
const SCOPE_KEYS = ['business_id', 'businessId', 'instanceId', 'instance_id'];

function errorResponse(res, error) {
    const known = error?.code && /^DEAL_|^BUSINESS_|^ACCOUNT_|^SALES_|^CAPABILITY_/.test(error.code);
    return res.status(error?.statusCode || 503).json({ success: false,
        code: known ? error.code : 'DEALS_UNAVAILABLE',
        error: known ? 'Проверьте данные сделки или обновите страницу.' : 'Сделки временно недоступны.' });
}

function guard(req, res, next) {
    try {
        // This router is mounted after requireAuth. A missing session must not
        // become a legacy global-operator route if auth is disabled by mistake.
        const legacyOperator = Boolean(req.auth?.login && !req.auth?.userId);
        if (!req.auth?.userId && !legacyOperator && req.auth?.platformRole !== 'platform_admin') {
            throw Object.assign(new Error('ACCOUNT_NOT_ACTIVE'), { code: 'ACCOUNT_NOT_ACTIVE', statusCode: 403 });
        }
        // Deals are day-to-day CRM work: hotel managers may edit their own
        // hotel's pipeline, while the same-origin and live membership checks
        // still apply to every mutation.
        const businessId = legacyOperator ? Number(req.params.instanceId)
            : Identity.authorizeCapability(req.auth, req.params.instanceId, req.method === 'GET' || req.method === 'HEAD' ? 'sales.read' : 'sales.write');
        if (!Number.isSafeInteger(businessId) || businessId < 1) {
            throw Object.assign(new Error('BUSINESS_SCOPE_REQUIRED'), { code: 'BUSINESS_SCOPE_REQUIRED', statusCode: 400 });
        }
        for (const source of [req.query, req.body]) {
            for (const key of SCOPE_KEYS) {
                if (source?.[key] != null && Number(source[key]) !== businessId) {
                    throw Object.assign(new Error('BUSINESS_SCOPE_MISMATCH'), { code: 'BUSINESS_SCOPE_MISMATCH', statusCode: 403 });
                }
            }
        }
        if (req.method !== 'GET') {
            const origin = req.get('origin');
            const publicUrl = process.env.WHATSAPP_CRM_PUBLIC_URL;
            const accepted = new Set();
            if (publicUrl) accepted.add(new URL(publicUrl).origin);
            else if (req.get('host')) accepted.add(`${req.protocol}://${req.get('host')}`);
            if (!origin || !accepted.has(origin) || req.get('sec-fetch-site') === 'cross-site') {
                throw Object.assign(new Error('DEAL_ORIGIN_REQUIRED'), { code: 'DEAL_ORIGIN_REQUIRED', statusCode: 403 });
            }
        }
        req.dealBusinessId = businessId;
        next();
    } catch (error) {
        errorResponse(res, error);
    }
}


function unavailableDeal() {
    throw Object.assign(new Error('DEAL_NOT_FOUND'), { code: 'DEAL_NOT_FOUND', statusCode: 404 });
}

function authorizeDealMutation(req, existing = null, input = null) {
    if (!req.auth?.userId || req.auth.platformRole === 'platform_admin') return input;
    const actor = Identity.actor(req.auth.userId);
    const membership = actor.memberships.find(item => item.businessId === req.dealBusinessId);
    const broad = membership?.capabilities.includes('sales.assign');
    const Sales = require('../services/sales-workspace.service');
    // Check the existing linked client even when the update points elsewhere.
    if (existing?.clientChatId) {
        Sales.authorizeClientMutation(req.auth, req.dealBusinessId, existing.clientChatId, { capability: 'sales.write' });
    } else if (existing && !broad && existing.createdBy !== actor.userId) {
        throw Object.assign(new Error('DEAL_SCOPE_DENIED'), { code: 'DEAL_SCOPE_DENIED', statusCode: 403 });
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const next = { ...input };
    if (Object.hasOwn(next, 'clientChatId')) {
        if (typeof next.clientChatId === 'string' && next.clientChatId.trim()) {
            const { row } = Sales.authorizeClientMutation(req.auth, req.dealBusinessId, next.clientChatId.trim(), { capability: 'sales.write' });
            next.clientChatId = row.chatId;
        } else if ((next.clientChatId == null || next.clientChatId === '')
            && existing && !broad && existing.createdBy !== actor.userId) {
            throw Object.assign(new Error('DEAL_SCOPE_DENIED'), { code: 'DEAL_SCOPE_DENIED', statusCode: 403 });
        }
    }
    return next;
}

function dealTransaction(action) {
    // Ensure schema outside the transaction: its initialization cache must not
    // survive a rolled-back CREATE TABLE caused by a rejected mutation.
    Deals.ensureSchema();
    return DB.db.transaction(action).immediate();
}

router.use('/deals/:instanceId', guard);

router.get('/deals/:instanceId', (req, res) => {
    try {
        const data = Deals.list(req.dealBusinessId, { search: req.query.search });
        res.json({ success: true, business_id: req.dealBusinessId, ...data });
    } catch (error) { errorResponse(res, error); }
});

router.get('/deals/:instanceId/:dealId', (req, res) => {
    try {
        const deal = Deals.get(req.dealBusinessId, req.params.dealId);
        if (!deal) {
            throw Object.assign(new Error('DEAL_NOT_FOUND'), { code: 'DEAL_NOT_FOUND', statusCode: 404 });
        }
        res.json({ success: true, business_id: req.dealBusinessId, deal });
    } catch (error) { errorResponse(res, error); }
});

router.post('/deals/:instanceId', (req, res) => {
    try {
        const deal = dealTransaction(() => Deals.create(req.dealBusinessId,
            authorizeDealMutation(req, null, req.body), req.auth.userId || null));
        res.status(201).json({ success: true, business_id: req.dealBusinessId, deal });
    } catch (error) { errorResponse(res, error); }
});

router.put('/deals/:instanceId/:dealId', (req, res) => {
    try {
        const deal = dealTransaction(() => {
            const existing = Deals.get(req.dealBusinessId, req.params.dealId);
            if (!existing) unavailableDeal();
            return Deals.update(req.dealBusinessId, req.params.dealId, authorizeDealMutation(req, existing, req.body), req.auth?.userId || null);
        });
        res.json({ success: true, business_id: req.dealBusinessId, deal });
    } catch (error) { errorResponse(res, error); }
});

router.delete('/deals/:instanceId/:dealId', (req, res) => {
    try {
        dealTransaction(() => {
            const existing = Deals.get(req.dealBusinessId, req.params.dealId);
            if (!existing) unavailableDeal();
            authorizeDealMutation(req, existing);
            Deals.remove(req.dealBusinessId, req.params.dealId, req.body?.revision);
        });
        res.json({ success: true, business_id: req.dealBusinessId });
    } catch (error) { errorResponse(res, error); }
});

module.exports = router;
