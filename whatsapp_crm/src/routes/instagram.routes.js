'use strict';

const express = require('express');
const Identity = require('../services/identity/identity-store');
const Instagram = require('../services/instagram.service');
const PrivateInstagram = require('../../instagram_private/server');

const publicRouter = express.Router();
const customerRouter = express.Router();

function handleError(res, error) {
    return res.status(error.statusCode || 503).json({ success: false,
        code: error.code || 'INSTAGRAM_UNAVAILABLE' });
}

publicRouter.get('/instagram/webhook', (req, res) => {
    try { return res.type('text/plain').send(Instagram.verifyChallenge(req.query)); }
    catch (error) { return handleError(res, error); }
});

publicRouter.post('/instagram/webhook', express.raw({ type: 'application/json', limit: '128kb' }), (req, res) => {
    try { return res.json({ success: true, ...Instagram.receive(req.body, req.get('x-hub-signature-256')) }); }
    catch (error) { return handleError(res, error); }
});

function authorize(req, owner = false) {
    if (!req.auth?.userId || req.auth.platformRole === 'platform_admin') {
        throw Object.assign(new Error('CUSTOMER_ACCESS_REQUIRED'), { code: 'CUSTOMER_ACCESS_REQUIRED', statusCode: 403 });
    }
    return Identity.authorizeBusiness(req.auth, req.params.businessId, { owner });
}

customerRouter.get('/businesses/:businessId/instagram', (req, res) => {
    try {
        const businessId = authorize(req);
        return res.json({ success: true, ...Instagram.status(businessId) });
    } catch (error) { return handleError(res, error); }
});

customerRouter.post('/businesses/:businessId/instagram', async (req, res) => {
    try {
        const businessId = authorize(req, true);
        const result = await Instagram.connect(businessId, req.body?.access_token);
        return res.json({ success: true, ...result });
    } catch (error) { return handleError(res, error); }
});

customerRouter.delete('/businesses/:businessId/instagram', (req, res) => {
    try {
        const businessId = authorize(req, true);
        return res.json({ success: true, ...Instagram.disconnect(businessId) });
    } catch (error) { return handleError(res, error); }
});

// Private API is independent of the official Meta connector above.
customerRouter.get('/businesses/:businessId/instagram-private', (req, res) => {
    try { return res.json({ success: true, ...PrivateInstagram.status(authorize(req)) }); }
    catch (cause) { return handleError(res, cause); }
});

customerRouter.post('/businesses/:businessId/instagram-private/login', async (req, res) => {
    try { return res.json({ success: true, ...await PrivateInstagram.login(authorize(req, true), req.body) }); }
    catch (cause) { return handleError(res, cause); }
});

customerRouter.post('/businesses/:businessId/instagram-private/poll', async (req, res) => {
    try { return res.json({ success: true, ...await PrivateInstagram.poll(authorize(req, true), true) }); }
    catch (cause) { return handleError(res, cause); }
});

customerRouter.post('/businesses/:businessId/instagram-private/reply', async (req, res) => {
    try { return res.json({ success: true, ...await PrivateInstagram.reply(
        authorize(req, true), req.body?.chatId, req.body?.text) }); }
    catch (cause) { return handleError(res, cause); }
});

customerRouter.delete('/businesses/:businessId/instagram-private', (req, res) => {
    try { return res.json({ success: true, ...PrivateInstagram.disconnect(authorize(req, true)) }); }
    catch (cause) { return handleError(res, cause); }
});

// SQLite lease prevents concurrent polls across web processes.
const pollTimer = setInterval(() => { void PrivateInstagram.pollDue(); }, 120_000);
pollTimer.unref?.();

module.exports = { publicRouter, customerRouter };
