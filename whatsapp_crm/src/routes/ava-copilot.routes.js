'use strict';
const express = require('express');
const Copilot = require('../services/ava-copilot.service');
const Workspace = require('../services/ava-workspace.service');
const router = express.Router();

function errorResponse(res, error) {
    const known = typeof error?.code === 'string' && /^(COPILOT_|WORKSPACE_|SALES_|ACCOUNT_|BUSINESS_|CAPABILITY_|AVA_)/.test(error.code);
    return res.status(known ? (error.statusCode || 503) : 503).json({ success: false, code: known ? error.code : 'COPILOT_UNAVAILABLE' });
}
router.post('/businesses/:businessId/workspace/clients/:chatId/copilot', async (req, res) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const closed = () => { if (!res.writableEnded) cancel(); };
    req.once('aborted', cancel); res.once('close', closed);
    try {
        const actor = Workspace.authorize(req.auth, req.params.businessId, 'ai.use');
        for (const source of [req.query, req.body]) for (const key of ['businessId', 'business_id', 'instanceId', 'instance_id']) {
            if (source?.[key] != null && Number(source[key]) !== actor.businessId) {
                throw Object.assign(new Error('BUSINESS_SCOPE_MISMATCH'), { code: 'BUSINESS_SCOPE_MISMATCH', statusCode: 403 });
            }
        }
        const accepted = process.env.WHATSAPP_CRM_PUBLIC_URL ? new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin : `${req.protocol}://${req.get('host')}`;
        if (req.get('origin') !== accepted || req.get('sec-fetch-site') === 'cross-site') {
            throw Object.assign(new Error('WORKSPACE_ORIGIN_REQUIRED'), { code: 'WORKSPACE_ORIGIN_REQUIRED', statusCode: 403 });
        }
        if (req.aborted || res.destroyed) controller.abort();
        const result = await Copilot.generate(req.auth, actor.businessId, req.params.chatId, req.body, { signal: controller.signal });
        if (!controller.signal.aborted && !res.destroyed) res.status(200).json(result);
    } catch (error) {
        if (!res.destroyed && !res.headersSent) errorResponse(res, error);
    } finally { req.removeListener('aborted', cancel); res.removeListener('close', closed); }
});
module.exports = router;
