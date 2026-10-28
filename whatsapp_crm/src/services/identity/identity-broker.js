'use strict';
const http = require('http');
const crypto = require('crypto');
const Admin = require('./keycloak-admin');

function start({ port = 3900, host = '0.0.0.0', admin = Admin, ready = true } = {}) {
    const secret = String(process.env.AVA_IDENTITY_BROKER_TOKEN || '');
    if (secret.length < 32 || process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') return null;
    const server = http.createServer((request, response) => {
        const reply = (status, payload) => {
            if (response.destroyed) return;
            response.writeHead(status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(payload));
        };
        if (request.method === 'GET' && request.url === '/__ava_release_readiness__') {
            return reply(server.runtimeReady ? 200 : 503, { ready: server.runtimeReady });
        }
        const actual = Buffer.from(String(request.headers.authorization || ''));
        const expected = Buffer.from(`Bearer ${secret}`);
        if (request.method !== 'POST' || request.url !== '/invitations/redeem'
            || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return reply(403, { error: 'IDENTITY_BROKER_ACCESS_DENIED' });
        if (!server.runtimeReady) return reply(503, { error: 'IDENTITY_BROKER_NOT_READY' });
        let body = '', oversized = false;
        request.setTimeout(5000, () => request.destroy());
        request.on('data', chunk => {
            body += chunk;
            if (body.length > 4096) { oversized = true; request.destroy(); }
        });
        request.on('end', async () => {
            if (oversized) return;
            // Shutdown can begin while an admitted request is still reading
            // its body. Do not enter enrollment after DB teardown starts.
            if (!server.runtimeReady) return reply(503, { error: 'IDENTITY_BROKER_NOT_READY' });
            server.activeEnrollments++;
            request.setTimeout(60000, () => request.destroy());
            try {
                const payload = JSON.parse(body);
                const result = await admin.redeem(payload.token, payload.password, payload.verificationId);
                reply(200, result);
            } catch (error) {
                reply(error.statusCode || 503, { error: error.code || 'IDENTITY_ENROLLMENT_FAILED' });
            } finally {
                server.activeEnrollments--;
            }
        });
    });
    server.activeEnrollments = 0;
    server.runtimeReady = ready === true;
    server.setReady = value => { server.runtimeReady = value === true; };
    return server.listen(port, host);
}
module.exports = { start };
