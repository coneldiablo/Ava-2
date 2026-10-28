'use strict';

const express = require('express');
const crypto = require('crypto');
const DB = require('../services/database.service');
const Identity = require('../services/identity/identity-store');
const Auth = require('../services/auth.service');
const AI = require('../services/dashboard/ai');
const Knowledge = require('../services/dashboard/ai.knowledge');
const PDF = require('../services/dashboard/ai.pdf');
const Audio = require('../services/dashboard/ai.audio');

const router = express.Router();
const askWindows = new Map();
const askReplays = new Map();
const audioWindows = new Map();

function fail(res, status, code) {
    return res.status(status).json({ success: false, code });
}

function authorized(req, res, next) {
    const id = Number(req.params.businessId);
    if (!Number.isSafeInteger(id) || id < 1 || String(id) !== req.params.businessId) {
        return fail(res, 400, 'INVALID_BUSINESS_SCOPE');
    }
    if (!req.auth?.userId && req.auth?.platformRole !== 'platform_admin') {
        return fail(res, 403, 'CUSTOMER_ACCESS_REQUIRED');
    }
    const capability = req.method === 'POST' || /\/(overview|audio)\/?$/i.test(req.path) ? 'ai.use' : 'business.read';
    try { Identity.authorizeCapability(req.auth, id, capability); }
    catch (_) { return fail(res, 403, 'BUSINESS_ACCESS_DENIED'); }
    if (!DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [id])) return fail(res, 404, 'BUSINESS_NOT_FOUND');
    for (const input of [req.body, req.query]) {
        for (const key of ['businessId', 'business_id', 'instanceId', 'instance_id']) {
            if (input?.[key] != null && Number(input[key]) !== id) return fail(res, 403, 'BUSINESS_SCOPE_MISMATCH');
        }
    }
    if (req.get('sec-fetch-site') === 'cross-site') return fail(res, 403, 'ORIGIN_REQUIRED');
    if (req.method === 'POST') {
        const origin = req.get('origin');
        const accepted = new Set();
        try {
            if (process.env.WHATSAPP_CRM_PUBLIC_URL) accepted.add(new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin);
            if (req.get('host')) accepted.add(`${req.protocol}://${req.get('host')}`);
        } catch (_) { return fail(res, 503, 'ORIGIN_UNAVAILABLE'); }
        if (!origin || !accepted.has(origin)) return fail(res, 403, 'ORIGIN_REQUIRED');
    }
    res.set('Cache-Control', 'private, no-store');
    res.set('Vary', 'Cookie');
    req.dashboardAiBusinessId = id;
    req.dashboardAiCapability = capability;
    next();
}

function getPeriod(req) {
    const input = req.method === 'POST' ? req.body : req.query;
    return AI.period(input || {});
}

function replyError(res, error) {
    const code = ['INVALID_PERIOD', 'INVALID_WINDOW', 'INVALID_QUESTION', 'KNOWLEDGE_UNAVAILABLE',
        'KNOWLEDGE_NOT_READY', 'KNOWLEDGE_EMPTY', 'KNOWLEDGE_INDEXING',
        'KNOWLEDGE_TIMEOUT', 'KNOWLEDGE_CANCELED', 'ASK_RATE_LIMITED',
        'DASHBOARD_FACTS_UNAVAILABLE', 'DASHBOARD_MODEL_UNAVAILABLE', 'DASHBOARD_MODEL_TIMEOUT',
        'DASHBOARD_MODEL_INVALID', 'DASHBOARD_MODEL_BUSY', 'DASHBOARD_MODEL_CANCELED', 'DASHBOARD_MODEL_TRUNCATED'].includes(error?.code)
        ? error.code : 'DASHBOARD_AI_UNAVAILABLE';
    return fail(res, error?.statusCode || 503, code);
}

function recheck(req) {
    const current = Auth.getSession(req);
    if (!current || (req.auth.userId && String(current.userId) !== String(req.auth.userId))) return false;
    try { Identity.authorizeCapability(current, req.dashboardAiBusinessId, req.dashboardAiCapability); return true; }
    catch (_) { return false; }
}

router.use('/dashboard/:businessId/ai', authorized);

router.get('/dashboard/:businessId/activity', authorized, (req, res) => {
    if (req.query.window !== 'overnight' || Object.keys(req.query).some(key => key !== 'window')) {
        return fail(res, 400, 'INVALID_WINDOW');
    }
    try {
        const result = AI.activity(req.dashboardAiBusinessId);
        if (!recheck(req)) return fail(res, 403, 'BUSINESS_ACCESS_DENIED');
        return res.json({ success: true, ...result });
    } catch (error) { return replyError(res, error); }
});

router.get('/dashboard/:businessId/ai/briefing', async (req, res) => {
    try {
        const briefing = AI.briefing(req.dashboardAiBusinessId, getPeriod(req),
            { pdf: true, audio: await Audio.probe() });
        if (!recheck(req)) return fail(res, 403, 'BUSINESS_ACCESS_DENIED');
        return res.json({ success: true, briefing });
    } catch (error) { return replyError(res, error); }
});

router.get('/dashboard/:businessId/ai/recommendations', (req, res) => {
    try {
        const result = AI.briefing(req.dashboardAiBusinessId, getPeriod(req),
            { pdf: true, audio: Audio.capability() });
        return res.json({ success: true, recommendations: result.recommendations,
            generatedAt: result.generatedAt, sourceUpdatedAt: result.sourceUpdatedAt });
    } catch (error) { return replyError(res, error); }
});

router.get('/dashboard/:businessId/ai/overview', async (req, res) => {
    if (!['overnight', 'yesterday'].includes(req.query.window)
        || Object.keys(req.query).some(key => key !== 'window')) return fail(res, 400, 'INVALID_WINDOW');
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnect);
    try {
        const overview = await AI.overview(req.dashboardAiBusinessId, req.query.window,
            { signal: controller.signal });
        if (!recheck(req)) return fail(res, 403, 'BUSINESS_ACCESS_DENIED');
        return res.json({ success: true, overview });
    } catch (error) { return res.destroyed ? undefined : replyError(res, error); }
    finally { res.off('close', disconnect); }
});

router.post('/dashboard/:businessId/ai/ask', async (req, res) => {
    try {
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).some(key => !['question', 'from', 'to', 'requestId'].includes(key))
            || typeof body.question !== 'string' || !body.question.trim() || body.question.length > 1200
            || (body.requestId != null && (typeof body.requestId !== 'string'
                || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)))) {
            return fail(res, 400, 'INVALID_QUESTION');
        }
        const requestedAt = new Date();
        const overnight = body.from == null && body.to == null && /ноч|overnight/i.test(body.question);
        const range = overnight ? AI.nightPeriod(req.dashboardAiBusinessId, requestedAt) : getPeriod(req);
        const userId = String(req.auth.userId || 'platform_admin');
        const rateKey = `${req.dashboardAiBusinessId}:${userId}`;
        const now = Date.now();
        const window = askWindows.get(rateKey) || { since: now, count: 0 };
        if (now - window.since > 60_000) { window.since = now; window.count = 0; }
        if (window.count >= 20) return fail(res, 429, 'ASK_RATE_LIMITED');
        window.count++;
        askWindows.set(rateKey, window);
        if (askWindows.size > 1000) for (const [key, value] of askWindows) {
            if (now - value.since > 60_000) askWindows.delete(key);
        }
        const replayKey = body.requestId ? `${rateKey}:${body.requestId}` : null;
        const digest = crypto.createHash('sha256').update(JSON.stringify([
            body.question.trim(), body.from || null, body.to || null,
        ])).digest('hex');
        const prior = replayKey && askReplays.get(replayKey);
        if (prior && now - prior.at < 600_000) {
            if (prior.digest !== digest) return fail(res, 409, 'REQUEST_ID_CONFLICT');
            return res.json({ ...prior.value, replayed: true });
        }
        const controller = new AbortController();
        const disconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', disconnect);
        let result;
        try {
            const crmResult = await AI.ask(req.dashboardAiBusinessId, range, body.question,
                { overnight, now: requestedAt, signal: controller.signal });
            if (!recheck(req)) return fail(res, 403, 'BUSINESS_ACCESS_DENIED');
            result = crmResult.unsupported
                ? await Knowledge.askKnowledge(req.dashboardAiBusinessId, userId,
                    body.question.trim(), controller.signal) : crmResult;
        } finally { res.off('close', disconnect); }
        if (!recheck(req)) return fail(res, 403, 'BUSINESS_ACCESS_DENIED');
        const { unsupported, ...answer } = result;
        const value = { success: true, ...answer };
        if (replayKey) askReplays.set(replayKey, { at: now, digest, value });
        if (askReplays.size > 1000) for (const [key, record] of askReplays) {
            if (now - record.at > 600_000 || askReplays.size > 1000) askReplays.delete(key);
            if (askReplays.size <= 1000) break;
        }
        return res.json(value);
    } catch (error) { return res.destroyed ? undefined : replyError(res, error); }
});

router.get('/dashboard/:businessId/ai/briefing.pdf', async (req, res) => {
    try {
        const briefing = AI.briefing(req.dashboardAiBusinessId, getPeriod(req),
            { pdf: true, audio: Audio.capability() });
        const buffer = await PDF.exportPdf(briefing);
        if (!recheck(req)) return fail(res, 403, 'BUSINESS_ACCESS_DENIED');
        res.type('application/pdf');
        res.set('Content-Disposition', 'attachment; filename="ava-briefing.pdf"');
        return res.send(buffer);
    } catch (error) {
        return error?.statusCode === 400 ? fail(res, 400, error.code) : fail(res, 503, 'PDF_UNAVAILABLE');
    }
});

router.get('/dashboard/:businessId/ai/briefing/audio', async (req, res) => {
    if (!Audio.capability().available) return fail(res, 503, 'AUDIO_UNAVAILABLE');
    const key = `${req.dashboardAiBusinessId}:${String(req.auth.userId || 'platform_admin')}`;
    const now = Date.now();
    const window = audioWindows.get(key) || { since: now, count: 0, active: 0 };
    if (now - window.since > 60_000 && !window.active) { window.since = now; window.count = 0; }
    if (window.count >= 4 || window.active) return fail(res, 429, 'AUDIO_RATE_LIMITED');
    window.count++;
    window.active++;
    audioWindows.set(key, window);
    try {
        const range = getPeriod(req);
        if (!(await Audio.probe()).available) return fail(res, 503, 'AUDIO_UNAVAILABLE');
        const briefing = AI.briefing(req.dashboardAiBusinessId, range,
            { pdf: true, audio: Audio.capability() });
        if (!recheck(req)) return fail(res, 403, 'BUSINESS_ACCESS_DENIED');
        const buffer = await Audio.synthesize(briefing);
        if (!recheck(req)) return fail(res, 403, 'BUSINESS_ACCESS_DENIED');
        res.type('audio/wav');
        res.set('Content-Disposition', 'attachment; filename="ava-briefing.wav"');
        return res.send(buffer);
    } catch (error) {
        return error?.statusCode === 400 ? fail(res, 400, error.code) : fail(res, 503, 'AUDIO_UNAVAILABLE');
    } finally {
        window.active--;
        if (audioWindows.size > 1000) for (const [oldKey, item] of audioWindows) {
            if (!item.active && now - item.since > 60_000) audioWindows.delete(oldKey);
        }
    }
});

module.exports = router;
module.exports.authorized = authorized;
