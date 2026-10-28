'use strict';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const DB = require('../services/database.service');
const Identity = require('../services/identity/identity-store');
const AuthService = require('../services/auth.service');
const LocalKnowledge = require('../services/knowledge-local.service');
const NativePreview = require('../services/knowledge-preview-ai.service');
const preview = require('./customer-knowledge-preview.routes');
const BusinessContext = require('../services/customer-business-gpt.service');

const router = express.Router();
const activeChats = new Set();
const createWindows = new Map();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(res, status, code) { return res.status(status).json({ success: false, code }); }

function sameOrigin(req) {
    try {
        const publicUrl = process.env.WHATSAPP_CRM_PUBLIC_URL;
        const accepted = new Set(publicUrl ? [new URL(publicUrl).origin] : []);
        if (req.protocol === 'https' && req.get('host')) accepted.add(`https://${req.get('host')}`);
        return accepted.has(req.get('origin')) && req.get('origin')?.startsWith('https://')
            && req.get('sec-fetch-site') !== 'cross-site';
    } catch (_) { return false; }
}

router.param('businessId', (req, res, next, raw) => {
    const businessId = Number(raw);
    if (!Number.isSafeInteger(businessId) || businessId < 1 || String(businessId) !== raw) {
        return fail(res, 400, 'INVALID_BUSINESS_SCOPE');
    }
    if (!req.auth?.userId) return fail(res, 403, 'CUSTOMER_ACCESS_REQUIRED');
    try { Identity.authorizeCapability(req.auth, businessId, req.method === 'GET' || req.method === 'HEAD' ? 'business.read' : 'ai.use'); }
    catch (_) { return fail(res, 403, 'BUSINESS_ACCESS_DENIED'); }
    if (req.get('sec-fetch-site') === 'cross-site' || Object.keys(req.query || {}).length) {
        return fail(res, 403, 'ORIGIN_REQUIRED');
    }
    req.businessGptScope = { businessId, userId: String(req.auth.userId) };
    next();
});

function chat(req) {
    const { businessId, userId } = req.businessGptScope;
    return DB.get('SELECT * FROM customer_business_gpt_chats WHERE id = ? AND business_id = ? AND user_id = ?',
        [req.params.chatId, businessId, userId]);
}

function turn(row) {
    const citations = JSON.parse(row.citations_json);
    return { id: row.id, requestId: row.request_id, question: row.question, answer: row.answer,
        citations, sourceTimestamp: row.source_timestamp,
        correlationId: row.correlation_id, createdAt: row.created_at,
        ...(BusinessContext.metadata(row.id) || BusinessContext.documentMetadata(row.business_id, citations, row.source_timestamp)) };
}

function chatSummary(row) {
    return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

router.get('/businesses/:businessId/business-gpt/chats', (req, res) => {
    const { businessId, userId } = req.businessGptScope;
    const rows = DB.all(`SELECT * FROM customer_business_gpt_chats
        WHERE business_id = ? AND user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 50`, [businessId, userId]);
    return res.json({ success: true, chats: rows.map(chatSummary) });
});

router.post('/businesses/:businessId/business-gpt/chats', (req, res) => {
    if (!sameOrigin(req)) return fail(res, 403, 'ORIGIN_REQUIRED');
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
        || Object.keys(req.body).length) return fail(res, 400, 'INVALID_CHAT_REQUEST');
    const { businessId, userId } = req.businessGptScope;
    const key = `${businessId}:${userId}`;
    const now = Date.now();
    const window = createWindows.get(key) || { since: now, count: 0 };
    if (now - window.since > 60_000) { window.since = now; window.count = 0; }
    if (window.count >= 10) return fail(res, 429, 'CHAT_RATE_LIMITED');
    window.count++;
    createWindows.set(key, window);
    if (createWindows.size > 1000) for (const [entry, value] of createWindows) {
        if (now - value.since > 60_000) createWindows.delete(entry);
    }
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    DB.run(`INSERT INTO customer_business_gpt_chats
        (id, business_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, businessId, userId, 'Новый диалог', at, at]);
    return res.status(201).json({ success: true, chat: { id, title: 'Новый диалог', createdAt: at, updatedAt: at } });
});

router.get('/businesses/:businessId/business-gpt/chats/:chatId', (req, res) => {
    if (!UUID.test(req.params.chatId)) return fail(res, 404, 'CHAT_NOT_FOUND');
    const record = chat(req);
    if (!record) return fail(res, 404, 'CHAT_NOT_FOUND');
    const rows = DB.all(`SELECT * FROM (
            SELECT rowid AS _rowid, * FROM customer_business_gpt_turns
            WHERE chat_id = ? AND business_id = ? AND user_id = ?
            ORDER BY created_at DESC, rowid DESC LIMIT 100
        ) ORDER BY created_at ASC, _rowid ASC`,
    [record.id, record.business_id, record.user_id]);
    const turns = rows.map(turn);
    if (turns.some(item => item.answerContext.kind !== 'documents')) {
        try { Identity.authorizeCapability(req.auth, record.business_id, 'sales.read'); }
        catch (_) { return fail(res, 403, 'BUSINESS_ACCESS_DENIED'); }
    }
    return res.json({ success: true, chat: chatSummary(record), turns });
});

router.post('/businesses/:businessId/business-gpt/chats/:chatId/messages', async (req, res) => {
    if (!sameOrigin(req)) return fail(res, 403, 'ORIGIN_REQUIRED');
    if (!UUID.test(req.params.chatId)) return fail(res, 404, 'CHAT_NOT_FOUND');
    const record = chat(req);
    if (!record) return fail(res, 404, 'CHAT_NOT_FOUND');
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['question', 'requestId', 'customerChatId'].includes(key))
        || typeof body.question !== 'string' || !body.question.trim() || body.question.length > 1200
        || typeof body.requestId !== 'string' || !UUID.test(body.requestId)
        || body.customerChatId !== undefined && (typeof body.customerChatId !== 'string'
            || !body.customerChatId.trim() || body.customerChatId.length > 300)) {
        return fail(res, 400, 'INVALID_CHAT_REQUEST');
    }
    const { businessId, userId } = req.businessGptScope;
    let customerChatId;
    try { customerChatId = BusinessContext.customerScope(req.auth, businessId, body.customerChatId); }
    catch (error) { return fail(res, error.statusCode === 404 ? 404 : 403,
        error.statusCode === 404 ? 'CUSTOMER_NOT_FOUND' : 'BUSINESS_ACCESS_DENIED'); }
    const prior = DB.get(`SELECT * FROM customer_business_gpt_turns
        WHERE chat_id = ? AND business_id = ? AND user_id = ? AND request_id = ?`,
    [record.id, businessId, userId, body.requestId]);
    if (prior) {
        const priorScope = BusinessContext.metadata(prior.id)?.answerContext?.customerChatId || null;
        if (prior.question !== body.question.trim() || priorScope !== customerChatId) return fail(res, 409, 'REQUEST_ID_CONFLICT');
        if (['crm', 'mixed'].includes(BusinessContext.metadata(prior.id)?.answerContext.kind)) {
            try { Identity.authorizeCapability(req.auth, businessId, 'sales.read'); }
            catch (_) { return fail(res, 403, 'BUSINESS_ACCESS_DENIED'); }
        }
        return res.json({ success: true, turn: turn(prior), replayed: true });
    }
    if (activeChats.has(record.id)) return fail(res, 409, 'CHAT_BUSY');
    const release = preview.reservePreview(userId, businessId);
    if (!release) return fail(res, 429, 'CHAT_RATE_LIMITED');
    activeChats.add(record.id);
    try {
        const history = DB.all(`SELECT id, question, answer FROM (
                SELECT rowid AS _rowid, id, question, answer, created_at FROM customer_business_gpt_turns
                WHERE chat_id = ? AND business_id = ? AND user_id = ?
                ORDER BY created_at DESC, rowid DESC LIMIT 2
            ) ORDER BY created_at ASC, _rowid ASC`, [record.id, businessId, userId]);
        const context = history.map((item, index) =>
            `${index + 1}. Вопрос: ${item.question.slice(0, 180)}\nОтвет: ${item.answer.slice(0, 260)}`).join('\n');
        const currentQuestion = body.question.trim();
        const instruction = 'Предыдущие реплики только для понимания продолжения; проверь ответ по текущей базе знаний.\n';
        const suffix = `\nНовый вопрос: ${currentQuestion}`;
        const question = context ? `${instruction}${context.slice(0, 2000 - instruction.length - suffix.length)}${suffix}`
            : currentQuestion;
        const correlationId = crypto.randomUUID();
        const abort = new AbortController();
        let disconnected = false;
        const onClose = () => {
            if (!res.writableEnded) { disconnected = true; abort.abort(); }
        };
        res.once('close', onClose);
        let data;
        let localAnswer = false;
        try {
            const crm = BusinessContext.crmAnswer(req.auth, businessId, currentQuestion, customerChatId);
            // Document evidence and CRM facts keep distinct source kinds. The
            // document search never receives private CRM context.
            let document = await LocalKnowledge.lookup(businessId, currentQuestion);
            if (!crm && !document) {
                // Only previous document answers may clarify a document follow-up.
                // CRM/customer history never enters this knowledge-only prompt.
                const documentContext = history.filter(item => BusinessContext.metadata(item.id)?.answerContext?.kind === 'documents')
                    .map((item, index) => `${index + 1}. Вопрос: ${item.question.slice(0, 180)}\nОтвет: ${item.answer.slice(0, 260)}`).join('\n');
                const documentQuestion = documentContext
                    ? `${instruction}${documentContext.slice(0, 2000 - instruction.length - suffix.length)}${suffix}` : currentQuestion;
                const reauthorize = () => require('../services/identity/customer-access').reauthorize(req, businessId, 'ai.use');
                reauthorize();
                document = await NativePreview.answer(req.auth, businessId, documentQuestion, { signal: abort.signal, reauthorize });
            }
            const local = crm || document;
            if (disconnected) return undefined;
            try { require('../services/identity/customer-access').reauthorize(req, businessId, 'ai.use'); }
            catch (_) { return fail(res, 403, 'BUSINESS_ACCESS_DENIED'); }
            if (local) {
                localAnswer = true;
                data = { answer: local.answer, citations: local.citations,
                    source_timestamp: local.source_timestamp, metadata: crm?.metadata };
                if (crm && document) {
                    data.answer += `\n\nПо документам:\n${document.answer}`;
                    data.citations = document.citations;
                    const documentSources = BusinessContext.documentMetadata(businessId,
                        document.citations.map(item => ({ sourceId: item.source_id, title: item.title })),
                        document.source_timestamp).sources;
                    data.metadata = { answerContext: { ...crm.metadata.answerContext, kind: 'mixed' },
                        sources: [...crm.metadata.sources, ...documentSources] };
                }
            } else if (LocalKnowledge.canConcludeNoMatch(businessId)) {
                return fail(res, 409, 'PREVIEW_NO_MATCH');
            } else {
                const token = process.env.CRM_SERVICE_API_TOKEN;
                const base = (process.env.AVA_ADMIN_API_URL || '').replace(/\/+$/, '');
                if (!token || !base) return fail(res, 503, 'KNOWLEDGE_UNAVAILABLE');
                const upstream = await axios.post(`${base}/api/internal/onyx/knowledge/preview`, {
                    business_id: businessId, question, channel: 'whatsapp', correlation_id: correlationId,
                }, { headers: { Authorization: `Bearer ${token}` }, timeout: preview.UPSTREAM_TIMEOUT_MS,
                    signal: abort.signal,
                    maxRedirects: 0, maxContentLength: 128 * 1024, maxBodyLength: 16 * 1024 });
                data = upstream.data;
            }
        } catch (error) {
            if (disconnected) return undefined;
            const nativeFailure = preview.nativePreviewFailure(error);
            if (nativeFailure) return fail(res, nativeFailure.status, nativeFailure.code);
            if (error?.statusCode === 403 || error?.statusCode === 404) return fail(res, error.statusCode,
                error.statusCode === 403 ? 'BUSINESS_ACCESS_DENIED' : 'CUSTOMER_NOT_FOUND');
            return ['ECONNABORTED', 'ETIMEDOUT'].includes(error?.code)
                ? fail(res, 504, 'PREVIEW_TIMEOUT') : fail(res, 503, 'KNOWLEDGE_UNAVAILABLE');
        }
        finally { res.off('close', onClose); }
        if (disconnected) return;
        if (!localAnswer && !preview.validPreview(data, businessId, correlationId)) {
            const code = preview.verifiedFailureCode(data, businessId, correlationId) || 'KNOWLEDGE_UNAVAILABLE';
            return fail(res, code === 'PREVIEW_TIMEOUT' ? 504
                : ['PREVIEW_EMPTY', 'PREVIEW_INDEXING'].includes(code) ? 409 : 503, code);
        }
        // The membership may have been revoked while Onyx was generating.
        try {
            const currentSession = AuthService.getSession(req);
            if (!currentSession || String(currentSession.userId) !== userId) throw Error('session revoked');
            Identity.authorizeCapability(currentSession, businessId, 'ai.use');
            if (data.metadata?.answerContext.kind === 'crm' || data.metadata?.answerContext.kind === 'mixed') {
                Identity.authorizeCapability(currentSession, businessId, 'sales.read');
            }
        }
        catch (_) { return fail(res, 403, 'BUSINESS_ACCESS_DENIED'); }
        const citations = data.citations.map(item => ({ sourceId: item.source_id,
            title: item.title.trim() || `Источник №${item.source_id}` }));
        const answerMetadata = data.metadata || BusinessContext.documentMetadata(businessId, citations, data.source_timestamp);
        BusinessContext.ensureSchema();
        const id = crypto.randomUUID();
        const at = new Date().toISOString();
        DB.db.transaction(() => {
            DB.run(`INSERT INTO customer_business_gpt_turns
                (id, chat_id, business_id, user_id, request_id, question, answer, citations_json,
                source_timestamp, correlation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, record.id, businessId, userId, body.requestId, body.question.trim(), data.answer,
                JSON.stringify(citations), data.source_timestamp, correlationId, at]);
            BusinessContext.saveMetadata(id, answerMetadata);
            DB.run(`UPDATE customer_business_gpt_chats SET updated_at = ?, title = CASE
                WHEN title = 'Новый диалог' THEN ? ELSE title END
                WHERE id = ? AND business_id = ? AND user_id = ?`,
            [at, body.question.trim().slice(0, 80), record.id, businessId, userId]);
        })();
        return res.status(201).json({ success: true, turn: { id, requestId: body.requestId,
            question: body.question.trim(), answer: data.answer, citations,
            sourceTimestamp: data.source_timestamp, correlationId, createdAt: at, ...answerMetadata }, replayed: false });
    } catch (_) { return fail(res, 503, 'KNOWLEDGE_UNAVAILABLE'); }
    finally { activeChats.delete(record.id); release(); }
});

module.exports = router;
