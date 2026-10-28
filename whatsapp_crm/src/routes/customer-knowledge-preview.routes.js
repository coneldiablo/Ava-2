'use strict';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const Identity = require('../services/identity/identity-store');
const Auth = require('../services/auth.service');
const DB = require('../services/database.service');
const RAG = require('../services/rag.service');
const NativeKnowledge = require('../services/customer-native-knowledge.service');
const LocalKnowledge = require('../services/knowledge-local.service');
const NativePreview = require('../services/knowledge-preview-ai.service');

const router = express.Router();
const MAX_QUESTION_LENGTH = 2000;
const MAX_ANSWER_LENGTH = 20000;
const MAX_CITATIONS = 50;
const PREVIEW_WINDOW_MS = 60_000;
// Onyx preview allows 30s for retrieval plus up to 5s for private cleanup.
const UPSTREAM_TIMEOUT_MS = 40_000;
const userSlots = new Map();
const businessSlots = new Map();
let activePreviews = 0;

function fail(res, status, code) {
    return res.status(status).json({ success: false, code });
}

function nativePreviewFailure(error) {
    const code = error?.code;
    if (!/^KNOWLEDGE_PREVIEW_/.test(code || '')) return null;
    if (code === 'KNOWLEDGE_PREVIEW_NO_ANSWER') return { status: 409, code: 'PREVIEW_NO_MATCH' };
    if (['KNOWLEDGE_PREVIEW_SOURCE_CHANGED', 'KNOWLEDGE_PREVIEW_CONFIG_CHANGED'].includes(code)) {
        return { status: 409, code: 'PREVIEW_INDEXING' };
    }
    if (code === 'KNOWLEDGE_PREVIEW_TIMEOUT') return { status: 504, code: 'PREVIEW_TIMEOUT' };
    if (error.statusCode === 403) return { status: 403, code: 'BUSINESS_ACCESS_DENIED' };
    return { status: 503, code: 'PREVIEW_UNAVAILABLE' };
}

function customerScope(req, res, { owner = false, mutation = false } = {}) {
    const businessId = Number(req.params.businessId);
    if (!Number.isSafeInteger(businessId) || businessId < 1
        || String(businessId) !== req.params.businessId) { fail(res, 400, 'INVALID_BUSINESS_SCOPE'); return null; }
    if (!req.auth?.userId) { fail(res, 403, 'CUSTOMER_ACCESS_REQUIRED'); return null; }
    try { Identity.authorizeCapability(req.auth, businessId, owner ? 'business.manage' : 'business.read'); }
    catch (_) { fail(res, 403, 'BUSINESS_ACCESS_DENIED'); return null; }
    if (mutation) {
        let accepted;
        try {
            accepted = new Set(process.env.WHATSAPP_CRM_PUBLIC_URL
                ? [new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin]
                : [`${req.protocol}://${req.get('host')}`]);
        } catch (_) { fail(res, 503, 'KNOWLEDGE_UNAVAILABLE'); return null; }
        if (!accepted.has(req.get('origin')) || req.get('sec-fetch-site') === 'cross-site') {
            fail(res, 403, 'ORIGIN_REQUIRED'); return null;
        }
    }
    return businessId;
}

function documentId(req, res) {
    const id = Number(req.params.documentId);
    if (!Number.isSafeInteger(id) || id < 1 || String(id) !== req.params.documentId) {
        fail(res, 400, 'INVALID_DOCUMENT_ID'); return null;
    }
    return id;
}

function knowledgeError(res, error) {
    const known = ['DOCUMENT_NOT_FOUND','DOCUMENT_EMPTY','ONYX_NOT_CONFIGURED','DOCUMENT_SYNC_IN_PROGRESS',
        'DOCUMENT_REVISION_CONFLICT','CHUNK_NOT_FOUND','BUSINESS_ACCESS_DENIED'].includes(error?.code);
    return fail(res, known ? error.statusCode : 503, known ? error.code : 'KNOWLEDGE_UNAVAILABLE');
}

// Document state reflects the scoped AVA -> Onyx outbox and a completed
// ingestion acknowledgement. The answer preview below is the retrieval check.
router.get('/businesses/:businessId/knowledge/native-status', (req, res) => {
    const businessId = customerScope(req, res);
    if (!businessId) return;
    try { res.json({ success: true, ...NativeKnowledge.status(businessId) }); }
    catch (error) { knowledgeError(res, error); }
});

router.get('/businesses/:businessId/native-modules/status', (req, res) => {
    const businessId = customerScope(req, res);
    if (!businessId) return;
    try {
        const onyx = DB.get('SELECT status FROM onyx_tenant_links WHERE business_id=?', [businessId]);
        const twenty = DB.get(`SELECT enabled,mode,connectionStatus FROM twenty_workspace_links WHERE businessId=?`, [businessId]);
        res.json({ success: true, businessId, modules: {
            knowledge: { state: onyx && ['STAGING','ACTIVE','ACTIVE_LIVE'].includes(onyx.status)
                ? 'configured' : 'unavailable', check: 'Проверка ответа доступна в базе знаний' },
            crm: { state: twenty?.enabled && twenty.mode === 'live' && twenty.connectionStatus === 'connected'
                ? 'connected' : 'unavailable', check: 'Запись в Twenty подтверждается обратным чтением' },
        } });
    } catch (_) { fail(res, 503, 'MODULE_STATUS_UNAVAILABLE'); }
});

router.post('/businesses/:businessId/knowledge/documents/:documentId/sync', (req, res) => {
    const businessId = customerScope(req, res, { owner: true, mutation: true });
    if (!businessId) return;
    const id = documentId(req, res);
    if (!id) return;
    if (req.body && Object.keys(req.body).length) return fail(res, 400, 'INVALID_REQUEST');
    try { res.json({ success: true, businessId, documentId: id, ...NativeKnowledge.enqueue(businessId, id) }); }
    catch (error) { knowledgeError(res, error); }
});

router.get('/businesses/:businessId/knowledge/documents/:documentId/chunks', (req, res) => {
    const businessId = customerScope(req, res);
    if (!businessId) return;
    const id = documentId(req, res);
    if (!id) return;
    try {
        const source = NativeKnowledge.snapshot(businessId, id);
        res.set('Cache-Control', 'no-store').json({ success: true, businessId, documentId: id, hash: source.editHash, sourceHash: source.hash,
            chunks: DB.getDocumentChunks(businessId, id).map(c => ({ id: c.id, text: c.text, section: c.section })) });
    } catch (error) { knowledgeError(res, error); }
});

router.put('/businesses/:businessId/knowledge/documents/:documentId/chunks/:chunkId', async (req, res) => {
    const businessId = customerScope(req, res, { owner: true, mutation: true });
    if (!businessId) return;
    const id = documentId(req, res);
    if (!id) return;
    const chunkId = Number(req.params.chunkId);
    if (!Number.isSafeInteger(chunkId) || chunkId < 1 || String(chunkId) !== req.params.chunkId
        || !req.body || Object.keys(req.body).some(key => !['text','section','expectedHash'].includes(key))
        || typeof req.body.text !== 'string' || !req.body.text.trim() || req.body.text.length > 10000
        || (req.body.section != null && (typeof req.body.section !== 'string' || req.body.section.length > 200))
        || (req.body.expectedHash !== undefined && (typeof req.body.expectedHash !== 'string' || !/^[a-f0-9]{32,64}$/.test(req.body.expectedHash)))) {
        return fail(res, 400, 'INVALID_CHUNK');
    }
    try {
        const updated = await NativeKnowledge.updateChunk(businessId, id, chunkId, {
            text: req.body.text.trim(), section: req.body.section || null, expectedHash: req.body.expectedHash,
        }, { beforeWrite: () => {
            try { require('../services/identity/customer-access').reauthorize(req, businessId, 'business.manage'); }
            catch (_) { throw Object.assign(new Error('BUSINESS_ACCESS_DENIED'), { code: 'BUSINESS_ACCESS_DENIED', statusCode: 403 }); }
        } });
        res.set('Cache-Control', 'no-store').json({ success: true, businessId, documentId: id, ...updated });
    } catch (error) { knowledgeError(res, error); }
});

router.delete('/businesses/:businessId/knowledge/documents/:documentId', async (req, res) => {
    const businessId = customerScope(req, res, { owner: true, mutation: true });
    if (!businessId) return;
    const id = documentId(req, res);
    if (!id) return;
    try {
        const result = await NativeKnowledge.remove(businessId, id);
        try { require('../services/identity/customer-access').reauthorize(req, businessId, 'business.manage'); }
        catch (_) { return fail(res, 403, 'BUSINESS_ACCESS_DENIED'); }
        res.json({ success: true, businessId, documentId: id, deleted: result.deleted === 1 });
    } catch (error) { knowledgeError(res, error); }
});

function reservePreview(userId, businessId) {
    const now = Date.now();
    const userKey = `${businessId}:${userId}`;
    const limits = [
        { slots: userSlots, key: userKey, maxCount: 4, maxActive: 1 },
        { slots: businessSlots, key: businessId, maxCount: 16, maxActive: 2 },
    ];
    const entries = limits.map(limit => ({ ...limit,
        value: limit.slots.get(limit.key) || { since: now, count: 0, active: 0 },
    }));
    for (const entry of entries) {
        if (now - entry.value.since >= PREVIEW_WINDOW_MS && entry.value.active === 0) {
            entry.value = { since: now, count: 0, active: 0 };
        }
    }
    if (activePreviews >= 10 || entries.some(entry => entry.value.count >= entry.maxCount
        || entry.value.active >= entry.maxActive)) return null;
    for (const entry of entries) {
        entry.value.count += 1;
        entry.value.active += 1;
        entry.slots.set(entry.key, entry.value);
    }
    activePreviews += 1;
    return () => {
        for (const entry of entries) entry.value.active -= 1;
        activePreviews -= 1;
        if (userSlots.size > 1000) for (const [key, value] of userSlots) {
            if (value.active === 0 && Date.now() - value.since >= PREVIEW_WINDOW_MS) userSlots.delete(key);
        }
        if (businessSlots.size > 1000) for (const [key, value] of businessSlots) {
            if (value.active === 0 && Date.now() - value.since >= PREVIEW_WINDOW_MS) businessSlots.delete(key);
        }
    };
}

function verifiedFailureCode(data, businessId, correlationId) {
    if (!data || typeof data !== 'object' || Array.isArray(data)
        || data.business_id !== businessId || data.channel !== 'whatsapp'
        || data.correlation_id !== correlationId || data.preview !== true
        || data.read_only !== true || data.handled !== false
        || data.customer_id != null || data.customer_context_provided === true) return null;
    if (data.error_code === 'ONYX_RUNTIME_NOT_LIVE') return 'PREVIEW_NOT_READY';
    if (data.error_code === 'ONYX_RUNTIME_UNGROUNDED') return 'PREVIEW_UNGROUNDED';
    if (data.error_code === 'ONYX_RUNTIME_TIMEOUT') return 'PREVIEW_TIMEOUT';
    if (data.error_code === 'ONYX_RUNTIME_EMPTY') return 'PREVIEW_EMPTY';
    if (data.error_code === 'ONYX_RUNTIME_INDEXING') return 'PREVIEW_INDEXING';
    return null;
}

function validPreview(data, businessId, correlationId) {
    if (!data || typeof data !== 'object' || Array.isArray(data)
        || data.business_id !== businessId || data.channel !== 'whatsapp'
        || data.correlation_id !== correlationId || data.preview !== true
        || data.read_only !== true || data.handled !== true
        || data.error_code != null || data.success === false
        || data.grounded !== true || data.stale !== false
        || data.customer_id != null || data.customer_context_provided === true
        || typeof data.answer !== 'string' || !data.answer.trim()
        || data.answer.length > MAX_ANSWER_LENGTH
        || typeof data.source_timestamp !== 'string'
        || !Number.isFinite(Date.parse(data.source_timestamp))
        || !Array.isArray(data.citations) || data.citations.length < 1
        || data.citations.length > MAX_CITATIONS) return false;
    return data.citations.every(citation => citation && typeof citation === 'object'
        && !Array.isArray(citation) && Number.isSafeInteger(citation.source_id)
        && citation.source_id > 0 && typeof citation.title === 'string'
        && citation.title.length <= 300);
}


function previewAccessStillActive(req, businessId) {
    try {
        const current = Auth.getSession(req);
        if (!current || String(current.userId) !== String(req.auth.userId)) return false;
        Identity.authorizeCapability(current, businessId, 'ai.use');
        return true;
    } catch (_) { return false; }
}

router.post('/businesses/:businessId/knowledge/preview', async (req, res) => {
    const businessId = Number(req.params.businessId);
    if (!Number.isSafeInteger(businessId) || businessId < 1
        || String(businessId) !== req.params.businessId) return fail(res, 400, 'INVALID_BUSINESS_SCOPE');
    if (!req.auth?.userId && req.auth?.platformRole !== 'platform_admin') {
        return fail(res, 403, 'CUSTOMER_ACCESS_REQUIRED');
    }
    try {
        // Live account and membership checks; never trust a browser-supplied tenant.
        Identity.authorizeCapability(req.auth, businessId, 'ai.use');
    } catch (error) {
        return fail(res, error?.statusCode === 400 ? 400 : 403, 'BUSINESS_ACCESS_DENIED');
    }

    let acceptedOrigins;
    try {
        const publicUrl = process.env.WHATSAPP_CRM_PUBLIC_URL;
        acceptedOrigins = new Set(publicUrl ? [new URL(publicUrl).origin] : []);
        if (req.protocol === 'https' && req.get('host')) {
            acceptedOrigins.add(`https://${req.get('host')}`);
        }
    } catch (_) { return fail(res, 503, 'PREVIEW_UNAVAILABLE'); }
    if (!acceptedOrigins.has(req.get('origin')) || !req.get('origin')?.startsWith('https://')
        || req.get('sec-fetch-site') === 'cross-site') return fail(res, 403, 'ORIGIN_REQUIRED');

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'question')
        || typeof body.question !== 'string' || !body.question.trim()
        || body.question.length > MAX_QUESTION_LENGTH
        || (req.query && Object.keys(req.query).length)) return fail(res, 400, 'INVALID_PREVIEW_REQUEST');

    const release = reservePreview(req.auth.userId || `admin:${req.auth.platformRole}`, businessId);
    if (!release) return fail(res, 429, 'PREVIEW_RATE_LIMITED');
    const correlationId = crypto.randomUUID();
    const abort = new AbortController();
    let disconnected = false;
    const onClose = () => {
        if (!res.writableEnded) { disconnected = true; abort.abort(); }
    };
    res.once('close', onClose);
    try {
        let local = await LocalKnowledge.lookup(businessId, body.question.trim());
        if (!local) {
            const reauthorize = () => {
                if (!previewAccessStillActive(req, businessId)) {
                    throw Object.assign(new Error('BUSINESS_ACCESS_DENIED'), { code: 'BUSINESS_ACCESS_DENIED', statusCode: 403 });
                }
            };
            reauthorize();
            local = await NativePreview.answer(req.auth, businessId, body.question.trim(), { signal: abort.signal, reauthorize });
        }
        if (disconnected) return undefined;
        if (!previewAccessStillActive(req, businessId)) return fail(res, 403, 'BUSINESS_ACCESS_DENIED');
        if (local) {
            return res.json({ success: true, businessId, answer: local.answer,
                citations: local.citations.map(citation => ({ sourceId: citation.source_id,
                    title: citation.title })),
                sourceTimestamp: local.source_timestamp, correlationId,
                provenance: local.provenance });
        }
        // A lexical miss cannot establish semantic absence, even in a small
        // corpus. Onyx performs bounded retrieval and verifies current sources.
        const token = process.env.CRM_SERVICE_API_TOKEN;
        const base = (process.env.AVA_ADMIN_API_URL || '').replace(/\/+$/, '');
        if (!token || !base) return fail(res, 503, 'PREVIEW_UNAVAILABLE');
        const upstream = await axios.post(`${base}/api/internal/onyx/knowledge/preview`, {
            business_id: businessId, question: body.question.trim(), channel: 'whatsapp',
            correlation_id: correlationId,
        }, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: UPSTREAM_TIMEOUT_MS, signal: abort.signal, maxRedirects: 0,
            maxContentLength: 128 * 1024, maxBodyLength: 16 * 1024,
        });
        if (!validPreview(upstream.data, businessId, correlationId)) {
            const code = verifiedFailureCode(upstream.data, businessId, correlationId) || 'PREVIEW_UNAVAILABLE';
            return fail(res, code === 'PREVIEW_TIMEOUT' ? 504
                : ['PREVIEW_EMPTY', 'PREVIEW_INDEXING'].includes(code) ? 409 : 503, code);
        }
        if (!previewAccessStillActive(req, businessId)) return fail(res, 403, 'BUSINESS_ACCESS_DENIED');
        return res.json({
            success: true, businessId, answer: upstream.data.answer,
            citations: upstream.data.citations.map(citation => ({
                sourceId: citation.source_id,
                title: citation.title.trim() || `Источник №${citation.source_id}`,
            })),
            sourceTimestamp: upstream.data.source_timestamp, correlationId,
        });
    } catch (error) {
        // Provider exceptions can contain URLs, headers, credentials or guest data.
        if (disconnected) return undefined;
        if (!previewAccessStillActive(req, businessId)) return fail(res, 403, 'BUSINESS_ACCESS_DENIED');
        const nativeFailure = nativePreviewFailure(error);
        if (nativeFailure) return fail(res, nativeFailure.status, nativeFailure.code);
        return ['ECONNABORTED', 'ETIMEDOUT'].includes(error?.code)
            ? fail(res, 504, 'PREVIEW_TIMEOUT') : fail(res, 503, 'PREVIEW_UNAVAILABLE');
    } finally {
        res.off('close', onClose);
        release();
    }
});

module.exports = router;
// Shared fail-closed boundary for customer Business GPT. Keep validation identical.
module.exports.validPreview = validPreview;
module.exports.verifiedFailureCode = verifiedFailureCode;
module.exports.reservePreview = reservePreview;
module.exports.nativePreviewFailure = nativePreviewFailure;

module.exports.UPSTREAM_TIMEOUT_MS = UPSTREAM_TIMEOUT_MS;
