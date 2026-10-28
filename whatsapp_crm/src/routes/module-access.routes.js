'use strict';
const express = require('express');
const Auth = require('../services/auth.service');
const Access = require('../services/identity/module-access-store');
const { getPublicUrl } = require('../services/identity/public-url');

// Browser APIs deliberately do NOT expose peer exchange, authorization checks,
// provisioning, native user IDs, native sessions or bootstrap credentials.
function createRouter() {
    const router = express.Router();
    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        next();
    });
    function session(req) {
        const cookie = Auth._parseCookies(req.headers.cookie || '')[Auth.cookieName];
        if (typeof cookie !== 'string' || !cookie.startsWith('ava2:')) {
            throw Object.assign(new Error('MODULE_CUSTOMER_SESSION_REQUIRED'), { code: 'MODULE_CUSTOMER_SESSION_REQUIRED', statusCode: 401 });
        }
        return cookie.slice(5);
    }
    function error(res, err) {
        const code = /^MODULE_[A-Z_]+$/.test(err.code || '') ? err.code : 'MODULE_ACCESS_DENIED';
        res.status([400,401,403,409,429,503].includes(err.statusCode) ? err.statusCode : 403).json({ error_code: code });
    }
    router.get('/businesses/:businessId/modules', Auth.requireAuth.bind(Auth), (req, res) => {
        try { res.json({ modules: Access.list({ sessionToken: session(req), businessId: req.params.businessId }) }); }
        catch (err) { error(res, err); }
    });
    router.post('/modules/:adapterId/grants', Auth.requireAuth.bind(Auth), (req, res) => {
        try {
            const expected = getPublicUrl();
            if (req.headers.origin !== expected.origin
                || req.headers['sec-fetch-site'] === 'cross-site') return res.sendStatus(403);
            // Scope, identity, callback, role and native deployment are resolved
            // exclusively by the store. Extra body fields cannot override them.
            const keys = Object.keys(req.body || {});
            if (keys.length !== 1 || keys[0] !== 'code_challenge') return res.sendStatus(400);
            res.json(Access.issue({ sessionToken: session(req), adapterId: req.params.adapterId,
                codeChallenge: req.body.code_challenge }));
        } catch (err) { error(res, err); }
    });
    return router;
}
module.exports = createRouter;
