'use strict';
const express = require('express');
const Attention = require('../services/ava-attention.service');
const Workspace = require('../services/ava-workspace.service');
const router = express.Router();

router.get('/businesses/:businessId/workspace/attention', (req, res) => {
    try {
        const actor = Workspace.authorize(req.auth, req.params.businessId);
        for (const source of [req.query, req.body]) for (const key of ['businessId', 'business_id', 'instanceId', 'instance_id']) {
            if (source?.[key] != null && Number(source[key]) !== actor.businessId)
                throw Object.assign(new Error('BUSINESS_SCOPE_MISMATCH'), {code: 'BUSINESS_SCOPE_MISMATCH', statusCode: 403});
        }
        res.set('Cache-Control', 'no-store').json(Attention.list(req.auth, actor.businessId, req.query));
    } catch (error) {
        const known = typeof error?.code === 'string' && /^(WORKSPACE_|SALES_|ACCOUNT_|BUSINESS_|CAPABILITY_|AVA_)/.test(error.code);
        res.status(known ? error.statusCode || 503 : 503).json({success: false, code: known ? error.code : 'WORKSPACE_UNAVAILABLE'});
    }
});

module.exports = router;
