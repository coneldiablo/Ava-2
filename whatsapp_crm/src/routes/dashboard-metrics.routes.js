'use strict';

const express = require('express');
const DB = require('../services/database.service');
const Identity = require('../services/identity/identity-store');
const Metrics = require('../services/dashboard/metrics');

const router = express.Router();

router.get('/dashboard/:instanceId/metrics', (req, res) => {
    try {
        if (!req.auth?.userId && req.auth?.platformRole !== 'platform_admin') {
            return res.status(403).json({ success: false, code: 'DASHBOARD_ACCESS_REQUIRED' });
        }
        const id = Number(req.params.instanceId);
        if (!Number.isSafeInteger(id) || id < 1) {
            return res.status(400).json({ success: false, code: 'DASHBOARD_SCOPE_INVALID' });
        }
        const days = Metrics.parseDays(req.query.days);
        for (const key of ['business_id', 'businessId', 'instanceId', 'instance_id']) {
            if (req.query[key] != null && Number(req.query[key]) !== id) {
                return res.status(403).json({ success: false, code: 'DASHBOARD_SCOPE_MISMATCH' });
            }
        }
        Identity.authorizeCapability(req.auth, id, 'business.read');
        if (!DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [id])) {
            return res.status(404).json({ success: false, code: 'DASHBOARD_BUSINESS_NOT_FOUND' });
        }
        // Membership is checked before each read. Keep this route synchronous so
        // authorization cannot be revoked between a yield and response.
        return res.json(Metrics.getMetrics(id, days));
    } catch (error) {
        const known = error?.code?.startsWith('DASHBOARD_');
        const accessError = ['BUSINESS_ACCESS_DENIED', 'ACCOUNT_NOT_ACTIVE'].includes(error?.code);
        const status = error?.statusCode || (accessError ? 403 : 503);
        return res.status(status).json({ success: false,
            code: known ? error.code : accessError ? 'DASHBOARD_ACCESS_DENIED' : 'DASHBOARD_METRICS_UNAVAILABLE' });
    }
});

module.exports = router;
