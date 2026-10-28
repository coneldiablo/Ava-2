'use strict';
const Profiles = require('../services/hotel-profile.service');
const Options = require('../services/voice-options.service');
const Access = require('../services/identity/customer-access');
const previewJson = require('express').json({ limit: 512 });
const isPreview = req => req.method === 'POST' && /^\/api\/hotel-profiles\/[^/]+\/(?:voice|ambient)-preview\/?$/.test(req.originalUrl.split('?')[0]);
function previewBody(req, res, next) {
    if (!isPreview(req)) return next();
    previewJson(req, res, error => {
        if (!error) return next();
        const code = error.type === 'entity.too.large' ? 'VOICE_PREVIEW_BODY_TOO_LARGE' : 'INVALID_VOICE_PREVIEW_BODY';
        res.status(error.type === 'entity.too.large' ? 413 : 400).json({ success: false, code, error: code });
    });
}

function fail(code, statusCode) { return Object.assign(new Error(code), { code, statusCode }); }
function createHandlers({ profiles = Profiles, options = Options, access = Access, now = Date.now } = {}) {
    const buckets = new Map();
    let inFlight = 0;
    function limit(req, id) {
        const time = now();
        for (const [key, bucket] of buckets) if (time - bucket.start >= 60000) buckets.delete(key);
        const key = `${req.auth?.userId || req.auth?.platformRole || 'service'}:${id}`;
        let bucket = buckets.get(key);
        if (!bucket) {
            if (buckets.size >= 2048) throw fail('VOICE_PREVIEW_RATE_LIMIT', 429);
            bucket = { start: time, count: 0, active: false };
            buckets.set(key, bucket);
        }
        if (bucket.count >= 6 || bucket.active || inFlight >= 8) throw fail('VOICE_PREVIEW_RATE_LIMIT', 429);
        bucket.count++;
        bucket.active = true;
        inFlight++;
        return () => { bucket.active = false; inFlight--; };
    }
    const authorize = (req, id, capability) => {
        if (!req.auth?.userId) return;
        try { access.reauthorize(req, id, capability); }
        catch (_) { throw fail('BUSINESS_ACCESS_DENIED', 403); }
    };
    const handler = (preview, ambient = false) => async (req, res) => {
        const id = Number(req.params.id);
        const controller = new AbortController();
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', cancel);
        let release;
        try {
            if (!Number.isSafeInteger(id) || id < 1) throw fail('BUSINESS_SCOPE_REQUIRED', 400);
            if (preview) {
                const body = req.body;
                const invalidSelection = ambient
                    ? !body || Object.keys(body).sort().join(',') !== 'preset,volume'
                        || body.preset !== 'office' || typeof body.volume !== 'number' || !Number.isFinite(body.volume) || body.volume < 0 || body.volume > 1
                    : !body || Object.keys(body).some(key => !['provider', 'voiceName'].includes(key))
                        || typeof body.provider !== 'string' || !body.provider || body.provider.length > 64
                        || typeof body.voiceName !== 'string' || !body.voiceName || body.voiceName.length > 160;
                if (!body || typeof body !== 'object' || Array.isArray(body)
                    || invalidSelection
                    || Buffer.byteLength(JSON.stringify(body)) > 512
                    || Object.keys(req.query || {}).length) throw fail(ambient ? 'INVALID_VOICE_AMBIENT' : 'INVALID_VOICE_PREVIEW_BODY', 400);
            }
            const profile = await profiles.get(id);
            if (!profile) throw fail('HOTEL_PROFILE_NOT_FOUND', 404);
            authorize(req, id, preview ? 'business.manage' : 'business.read');
            let result;
            if (preview) {
                release = limit(req, id);
                result = await options[ambient ? 'ambientPreview' : 'preview'](req.body, {
                    signal: controller.signal,
                    beforeSynthesis: () => authorize(req, id, 'business.manage'),
                });
            } else result = await options.getOptions({ signal: controller.signal, profile });
            if (res.destroyed || controller.signal.aborted) return;
            authorize(req, id, preview ? 'business.manage' : 'business.read');
            res.set('Cache-Control', 'private, no-store');
            if (!preview) return res.json(result);
            return res.type(result.contentType).send(result.audio);
        } catch (error) {
            if (res.destroyed || controller.signal.aborted) return;
            const safe = /^[A-Z0-9_]+$/.test(error.code || '') && error.statusCode >= 400 && error.statusCode < 600;
            const code = safe ? error.code : 'VOICE_OPERATION_FAILED';
            if (safe && error.statusCode === 429) res.set('Retry-After', '60');
            return res.status(safe ? error.statusCode : 500).json({ success: false, code, error: code });
        } finally {
            release?.();
            res.removeListener('close', cancel);
        }
    };
    return { catalog: handler(false), preview: handler(true), ambientPreview: handler(true, true) };
}
function register(router) {
    const handlers = createHandlers();
    router.get('/hotel-profiles/:id/voice-options', handlers.catalog);
    router.post('/hotel-profiles/:id/voice-preview', handlers.preview);
    router.post('/hotel-profiles/:id/ambient-preview', handlers.ambientPreview);
}
module.exports = { register, createHandlers, previewBody };
