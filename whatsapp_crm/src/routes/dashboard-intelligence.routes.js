'use strict';

const express = require('express');
const Intelligence = require('../services/dashboard/intelligence.service');
const Identity = require('../services/identity/identity-store');
const Logger = require('../utils/logger');
const router = express.Router();

function guard(req, res, next) {
    try {
        // Mounted after requireAuth. Refresh membership at every request so a
        // revoked customer session cannot keep reading another business.
        const legacyOperator = Boolean(req.auth?.login && !req.auth?.userId);
        if (!req.auth?.userId && !legacyOperator && req.auth?.platformRole !== 'platform_admin') {
            throw Object.assign(new Error('ACCOUNT_NOT_ACTIVE'), { statusCode: 403 });
        }
        const businessId = legacyOperator ? Number(req.params.instanceId)
            : Identity.authorizeCapability(req.auth, req.params.instanceId, req.method === 'GET' || req.method === 'HEAD' ? 'sales.read' : 'sales.write');
        if (!Number.isSafeInteger(businessId) || businessId < 1) {
            throw Object.assign(new Error('BUSINESS_SCOPE_REQUIRED'), { statusCode: 400 });
        }
        for (const source of [req.query, req.body]) {
            for (const key of ['business_id', 'businessId', 'instanceId', 'instance_id']) {
                if (source?.[key] != null && Number(source[key]) !== businessId) {
                    throw Object.assign(new Error('BUSINESS_SCOPE_MISMATCH'), { statusCode: 403 });
                }
            }
        }
        if (req.method !== 'GET') {
            const accepted = new Set();
            if (process.env.WHATSAPP_CRM_PUBLIC_URL) accepted.add(new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin);
            else if (req.get('host')) accepted.add(`${req.protocol}://${req.get('host')}`);
            if (!req.get('origin') || !accepted.has(req.get('origin')) || req.get('sec-fetch-site') === 'cross-site') {
                throw Object.assign(new Error('CUSTOMER_ORIGIN_REQUIRED'), { statusCode: 403 });
            }
        }
        next();
    } catch (error) {
        res.status(error.statusCode || 403).json({ success: false, error: error.message });
    }
}

router.use('/dashboard/:instanceId', guard);

router.get('/dashboard/:instanceId/intelligence', (req, res) => {
    try { res.json(Intelligence.getIntelligence(req.params.instanceId)); }
    catch (error) {
        Logger.error('Dashboard intelligence read failed:', error);
        res.status(error.statusCode || 500).json({ success: false, error: error.statusCode ? error.message : 'intelligence_unavailable' });
    }
});

router.patch('/dashboard/:instanceId/tasks/:taskId', (req, res) => {
    try {
        if (req.auth?.userId && req.auth.platformRole !== 'platform_admin') {
            require('../services/sales-workspace.service').authorizeTaskMutation(
                req.auth, req.params.instanceId, req.params.taskId);
        }
        res.json(Intelligence.updateTask(req.params.instanceId, req.params.taskId, req.body?.status));
    }
    catch (error) {
        Logger.error('Dashboard task update failed:', error);
        res.status(error.statusCode || 500).json({ success: false, error: error.statusCode ? error.message : 'task_update_failed' });
    }
});

module.exports = router;
