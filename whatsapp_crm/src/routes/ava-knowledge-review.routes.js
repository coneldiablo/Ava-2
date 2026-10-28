'use strict';

const express = require('express');
const Review = require('../services/ava-knowledge-review.service');

function errorResponse(res, error) {
    const known = typeof error?.code === 'string'
        && /^(KNOWLEDGE_REVIEW_|WORKSPACE_|SALES_|ACCOUNT_|BUSINESS_|CAPABILITY_|AVA_|AI_|DOCUMENT_|ONYX_)/.test(error.code);
    return res.status(known ? (error.statusCode || 503) : 503)
        .json({ success: false, code: known ? error.code : 'KNOWLEDGE_REVIEW_UNAVAILABLE' });
}

// The factory supports isolated HTTP acceptance tests; the production router
// always uses the actual live-authorizing service and feature flag provider.
function createRouter(service = Review) {
    const router = express.Router();
    const base = '/businesses/:businessId/workspace/knowledge-review';
    function guard(req, res, next) {
        try {
            const actor = service.authorize(req.auth, req.params.businessId);
            for (const source of [req.query, req.body]) {
                for (const key of ['businessId', 'business_id', 'instanceId', 'instance_id']) {
                    if (source?.[key] != null && Number(source[key]) !== actor.businessId) {
                        throw Object.assign(new Error('BUSINESS_SCOPE_MISMATCH'),
                            { code: 'BUSINESS_SCOPE_MISMATCH', statusCode: 403 });
                    }
                }
            }
            if (req.method !== 'GET') {
                const origin = process.env.WHATSAPP_CRM_PUBLIC_URL
                    ? new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin
                    : `${req.protocol}://${req.get('host')}`;
                if (req.get('origin') !== origin || req.get('sec-fetch-site') === 'cross-site') {
                    throw Object.assign(new Error('KNOWLEDGE_REVIEW_ORIGIN_REQUIRED'),
                        { code: 'KNOWLEDGE_REVIEW_ORIGIN_REQUIRED', statusCode: 403 });
                }
            }
            req.knowledgeBusinessId = actor.businessId;
            next();
        } catch (error) { errorResponse(res, error); }
    }
    function handle(fn, status = 200) {
        return async (req, res) => {
            const controller = new AbortController();
            const abort = () => controller.abort();
            const close = () => { if (!res.writableEnded) abort(); };
            req.once('aborted', abort);
            res.once('close', close);
            try {
                const result = await fn(req, {
                    idempotencyKey: req.get('Idempotency-Key'), signal: controller.signal,
                });
                if (!controller.signal.aborted) res.status(status).json(result);
            } catch (error) {
                if (!controller.signal.aborted) errorResponse(res, error);
            } finally {
                req.removeListener('aborted', abort);
                res.removeListener('close', close);
            }
        };
    }
    router.get(base, guard, handle((req, opts) => service.list(req.auth, req.knowledgeBusinessId, req.query, opts)));
    router.post(base + '/drafts', guard, handle((req, opts) => service.createDraft(req.auth, req.knowledgeBusinessId, req.body, opts), 201));
    router.patch(base + '/drafts/:id', guard, handle((req, opts) => service.updateDraft(req.auth, req.knowledgeBusinessId, req.params.id, req.body, opts)));
    for (const [action, method] of [['check', 'checkDraft'], ['publish', 'publishDraft'], ['rollback', 'rollbackDraft']]) {
        router.post(base + '/drafts/:id/' + action, guard,
            handle((req, opts) => service[method](req.auth, req.knowledgeBusinessId, req.params.id, req.body, opts)));
    }
    return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
