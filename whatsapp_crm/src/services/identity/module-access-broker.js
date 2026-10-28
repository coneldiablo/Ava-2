'use strict';
const http = require('http');
const crypto = require('crypto');
const Access = require('./module-access-store');
const OnyxRuntime = require('./onyx-runtime-access');

// Separate private listener. Never mount this on the public Express router.
// Each native adapter authenticates using its OWN hashed peer credential.
function createServer({ store = Access, onyxRuntime = OnyxRuntime } = {}) {
    const exactKeys = keys => body => Boolean(body && typeof body === 'object' && !Array.isArray(body)
        && Object.keys(body).sort().join(',') === [...keys].sort().join(','));
    const syncClaimKeys = ['contractVersion','deploymentId','businessId','nativeScope','revision','nativeKeyId','generation',
        'roleId','correlationId','method','path','objectName','recordId','bodyDigest'];
    const routes = new Map([
        ['/v1/onyx-runtime/authorize', { fields: [], run: input => onyxRuntime.authorize(input) }],
        ['/v1/exchange', { fields: ['code','verifier'], run: input => store.redeem(input) }],
        ['/v1/authorize', { fields: ['sessionHandle'], run: input => store.authorize(input) }],
        ['/v1/navigation', { fields: ['sessionHandle'], run: input => store.navigation(input) }],
        ['/v1/logout', { fields: ['sessionHandle'], run: input => store.logout(input) }],
        ['/v1/logout-all', { fields: ['sessionHandle'], run: input => store.logoutAll(input) }],
        ['/v1/revocations/lease', { fields: [], run: input => store.leaseRevocation(input) }],
        ['/v1/revocations/complete', { fields: ['bindingId','leaseToken','result'], run: input => store.finishRevocation(input) }],
        ['/v1/sync-lease/acquire', {
            validate: body => exactKeys(syncClaimKeys)(body) && body.contractVersion === 'ava-sync-lease-v1',
            run: input => store.acquireSyncLease(input, { adapterId: input.adapterId, peerSecret: input.peerSecret })
        }],
        ['/v1/sync-readback', {
            validate: body => exactKeys(['contractVersion','leaseId'])(body) && body.contractVersion === 'ava-sync-lease-v1',
            run: input => store.getSyncReadback(input.leaseId, { adapterId: input.adapterId, peerSecret: input.peerSecret })
        }],
        ['/v1/sync-lease/release', {
            validate: body => exactKeys(['contractVersion','leaseId','outcome'])(body) && body.contractVersion === 'ava-sync-lease-v1',
            run: input => store.releaseSyncLease(input, { adapterId: input.adapterId, peerSecret: input.peerSecret })
        }],
    ]);
    const server = http.createServer((req, res) => {
        const correlationId = crypto.randomUUID();
        const reply = (status, data) => {
            if (res.destroyed || res.writableEnded) return;
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff', 'X-Correlation-ID': correlationId });
            res.end(JSON.stringify({ ...data, correlation_id: correlationId }));
        };
        const route = routes.get(req.url);
        if (!route || req.method !== 'POST') return reply(404, { error_code: 'MODULE_ROUTE_NOT_FOUND' });
        // Reject all browser requests. Server peers do not send cookies or Origin.
        if (req.headers.origin || req.headers.cookie || req.headers['sec-fetch-site']) return reply(403, { error_code: 'MODULE_PEER_DENIED' });
        if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) return reply(415, { error_code: 'MODULE_JSON_REQUIRED' });
        const adapterId = req.headers['x-ava-adapter-id'];
        const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
        if (typeof adapterId !== 'string' || !/^[0-9a-f-]{36}$/i.test(adapterId) || !match) return reply(403, { error_code: 'MODULE_PEER_DENIED' });
        if (Number(req.headers['content-length'] || 0) > 4096) return reply(413, { error_code: 'MODULE_BODY_TOO_LARGE' });
        let size = 0, chunks = [], oversized = false;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > 4096) { oversized = true; chunks = []; reply(413, { error_code: 'MODULE_BODY_TOO_LARGE' }); return; }
            if (!oversized) chunks.push(chunk);
        });
        req.on('end', async () => {
            if (oversized) return;
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error_code: 'MODULE_BODY_INVALID' });
                if (route.validate) {
                    if (!route.validate(body)) return reply(400, { error_code: 'MODULE_BODY_INVALID' });
                } else if (Object.keys(body).length !== route.fields.length
                    || route.fields.some(key => typeof body[key] !== 'string')) {
                    return reply(400, { error_code: 'MODULE_BODY_INVALID' });
                }
                const result = await Promise.resolve(route.run({ ...body, adapterId, peerSecret: match[1] }));
                reply(200, result);
            } catch (err) {
                // Never echo native/network/SQL messages or body/header values.
                const code = /^(?:MODULE|ONYX_RUNTIME)_[A-Z_]+$/.test(err.code || '') ? err.code : 'MODULE_ACCESS_DENIED';
                reply(err instanceof SyntaxError ? 400 : (Number(err.statusCode) || 403), { error_code: code });
            }
        });
        req.on('error', () => { /* no body, credential or parser error logging */ });
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.timeout = 5000;
    server.maxHeadersCount = 20;
    server.maxConnections = 128;
    return server;
}
module.exports = { createServer };
