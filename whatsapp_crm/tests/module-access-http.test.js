'use strict';
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { describe, it: register, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Provisioning = require('../src/services/provisioning/business-provisioning-store.service');
const Twenty = require('../src/services/twenty/twenty-store.service');
const Access = require('../src/services/identity/module-access-store');
const { createServer } = require('../src/services/identity/module-access-broker');
const createRouter = require('../src/routes/module-access.routes');
const random = () => crypto.randomBytes(32).toString('base64url');
const digest = value => crypto.createHash('sha256').update(value).digest('base64url');
const admin = { userId: 'test-admin', platformRole: 'platform_admin' };
const publicOrigin = 'https://wh.meludtech.tech';

function request(server, path, { body, raw, method = 'POST', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const data = raw ?? (body === undefined ? '' : JSON.stringify(body));
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, res => {
            let text = ''; res.on('data', part => text += part);
            res.on('end', () => {
                let json; try { json = JSON.parse(text); } catch (_) { json = null; }
                resolve({ status: res.statusCode, headers: res.headers, json, text });
            });
        });
        req.on('error', reject); req.end(data);
    });
}
function it(name, fn) {
    register(name, async () => {
        const keys = ['AVA_PROCESS_ROLE','AVA_CUSTOMER_ACCESS_ENABLED','WHATSAPP_CRM_PUBLIC_URL'];
        const previous = keys.map(key => process.env[key]);
        createTestDB();
        process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
        process.env.WHATSAPP_CRM_PUBLIC_URL = publicOrigin;
        const app = express(); app.use(express.json()); app.use('/api', createRouter());
        app.get('/api/auth/config', (_req, res) => res.json({ public: true }));
        const servers = [createServer(), http.createServer(app)];
        try {
            await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
            await fn(...servers);
        } finally {
            await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
            keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
        }
    });
}
async function buyer(name) {
    const invitation = Identity.createInvitation(admin, { email: `${name}@example.test` });
    const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), `subject-${name}`);
    const business = Provisioning.createBusinessAtomic({ name }, { ownerUserId: user.userId }).instance;
    Twenty.upsertIntegration(business.id, { baseUrl: `https://${name}.crm.meludtech.tech`, workspaceId: `scope-${name}`, enabled: true });
    const adapter = Access.configure({ businessId: business.id, module: 'twenty', publicOrigin: `https://${name}.crm.meludtech.tech` });
    // Explicit native fixture; the HTTP/SQLite/PKCE boundary below is real.
    await Access.verifyPrincipal({ adapterId: adapter.id, userId: user.userId, nativeUserId: `native-${name}`,
        readback: async input => ({ ...input, ownAccess: true, foreignAccessDenied: true, platformAdminDenied: true, sessionGuardVerified: true }) });
    const token = Identity.createSession(user.subject, `sid-${name}`);
    return { user, business, adapter, token,
        browser: { Cookie: `crm_session=ava2:${token}`, Origin: publicOrigin },
        peer: { 'X-AVA-Adapter-ID': adapter.id, Authorization: `Bearer ${adapter.peerSecret}` } };
}
async function grant(browser, value) {
    const verifier = random();
    const result = await request(browser, `/api/modules/${value.adapter.id}/grants`, {
        headers: value.browser, body: { code_challenge: digest(verifier) } });
    assert.strictEqual(result.status, 200);
    return { code: result.json.code, verifier };
}

describe('A07 real browser and private broker HTTP boundary (native identity fixtures)', () => {
    it('keeps machine authorization private, peer-authenticated and free of caller scope', async (broker, browser) => {
        const a = await buyer('runtime-boundary');
        const path = '/v1/onyx-runtime/authorize';
        assert.strictEqual((await request(browser, path, { body: {}, headers: a.peer })).status, 404);
        assert.strictEqual((await request(broker, path, { body: {}, headers: { ...a.peer, Origin: publicOrigin } })).status, 403);
        assert.strictEqual((await request(broker, path, { body: {}, headers: { ...a.peer, Authorization: `Bearer ${random()}` } })).status, 403);
        for (const body of [{ businessId: 1 }, { nativeUserId: 'admin' }, { subject: 'other' }]) {
            assert.strictEqual((await request(broker, path, { body, headers: a.peer })).status, 400);
        }
        const result = await request(broker, path, { body: {}, headers: a.peer });
        assert.strictEqual(result.status, 403); // A Twenty peer is never an Onyx machine identity.
        assert.strictEqual(result.json.error_code, 'ONYX_RUNTIME_CONFIGURATION_CHANGED');
        assert.strictEqual(result.text.includes(a.adapter.peerSecret), false);
    });
    it('does not intercept public login routes and never publishes broker endpoints', async (_broker, browser) => {
        assert.strictEqual((await request(browser, '/api/auth/config', { method: 'GET' })).status, 200);
        assert.strictEqual((await request(browser, '/v1/exchange', { body: {} })).status, 404);
        assert.strictEqual((await request(browser, '/api/businesses/1/modules', { method: 'GET' })).status, 401);
    });
    it('lists only authorized safe modules, missing knowledge is awaiting setup not ready', async (_broker, browser) => {
        const a = await buyer('north'), b = await buyer('south');
        const own = await request(browser, `/api/businesses/${a.business.id}/modules`, { method: 'GET', headers: a.browser });
        assert.strictEqual(own.status, 200);
        assert.deepStrictEqual(own.json.modules.map(row => row.state), ['verified','awaiting_setup']);
        assert.strictEqual(own.text.includes(a.adapter.peerSecret), false);
        assert.strictEqual(own.text.includes('native-north'), false);
        const foreign = await request(browser, `/api/businesses/${b.business.id}/modules`, { method: 'GET', headers: a.browser });
        assert.strictEqual(foreign.status, 403);
        assert.strictEqual(foreign.text.includes('south'), false);
    });
    it('browser grant, server exchange, native guard and logout are single-use and revocation aware', async (broker, browser) => {
        const a = await buyer('north');
        const body = await grant(browser, a);
        const exchange = await request(broker, '/v1/exchange', { body, headers: a.peer });
        assert.strictEqual(exchange.status, 200);
        assert.strictEqual(exchange.json.userId, a.user.userId);
        assert.match(exchange.json.bindingId, /^[0-9a-f-]{36}$/);
        assert.strictEqual(exchange.headers['cache-control'], 'no-store');
        assert.strictEqual((await request(broker, '/v1/exchange', { body, headers: a.peer })).status, 403);
        const session = { sessionHandle: exchange.json.sessionHandle };
        assert.strictEqual((await request(broker, '/v1/authorize', { body: session, headers: a.peer })).status, 200);
        assert.strictEqual((await request(broker, '/v1/logout', { body: session, headers: a.peer })).status, 200);
        assert.strictEqual((await request(broker, '/v1/logout', { body: session, headers: a.peer })).status, 200);
        assert.strictEqual((await request(broker, '/v1/authorize', { body: session, headers: a.peer })).status, 403);
        assert.ok(Identity.session(a.token));
    });
    it('global logout denies all buyer sessions, persists native cleanup and cannot revoke another buyer', async (broker, browser) => {
        const a = await buyer('north'), b = await buyer('south');
        const second = Identity.createSession(a.user.subject, 'second-device');
        const x = (await request(broker, '/v1/exchange', { body: await grant(browser, a), headers: a.peer })).json;
        const y = (await request(broker, '/v1/exchange', { body: await grant(browser, a), headers: a.peer })).json;
        const body = { sessionHandle: x.sessionHandle };
        assert.strictEqual((await request(broker, '/v1/logout-all', { body, headers: b.peer })).status, 403);
        assert.ok(Identity.session(a.token));
        Access.disable(a.adapter.id);
        for (let i = 0; i < 2; i++) assert.strictEqual((await request(broker, '/v1/logout-all', { body, headers: a.peer })).status, 200);
        assert.strictEqual(Identity.session(a.token), null);
        assert.strictEqual(Identity.session(second), null);
        assert.ok(Identity.session(b.token));
        assert.strictEqual(DB.get("SELECT count(*) AS n FROM ava_identity_outbox WHERE userId=? AND action='revoke_sessions'", [a.user.userId]).n, 1);
        for (const bindingId of [x.bindingId,y.bindingId]) {
            assert.strictEqual(DB.get('SELECT state FROM ava_module_revocations WHERE bindingId=?', [bindingId]).state, 'pending');
        }
    });
    it('cross-site grants, callback/scope injection and shared-service credentials are refused', async (broker, browser) => {
        const a = await buyer('north');
        const path = `/api/modules/${a.adapter.id}/grants`, body = { code_challenge: digest(random()) };
        for (const origin of [undefined, 'https://evil.test', 'https://other.crm.meludtech.tech']) {
            const headers = { ...a.browser }; if (origin) headers.Origin = origin; else delete headers.Origin;
            assert.strictEqual((await request(browser, path, { headers, body })).status, 403);
        }
        for (const patch of [{ businessId: 99 }, { role: 'admin' }, { callbackUrl: 'https://evil.test' }]) {
            assert.strictEqual((await request(browser, path, { headers: a.browser, body: { ...body, ...patch } })).status, 400);
        }
        const code = await grant(browser, a);
        assert.strictEqual((await request(broker, '/v1/exchange', { body: code, headers: { ...a.peer, Origin: publicOrigin } })).status, 403);
        assert.strictEqual((await request(broker, '/v1/exchange', { body: code, headers: { ...a.peer, Authorization: `Bearer ${random()}` } })).status, 403);
        assert.strictEqual((await request(broker, '/v1/exchange', { body: { ...code, nativeUserId: 'admin' }, headers: a.peer })).status, 400);
    });
    it('another native adapter cannot exchange or authorize a session even with its valid peer key', async (broker, browser) => {
        const a = await buyer('north'), b = await buyer('south'), code = await grant(browser, a);
        assert.strictEqual((await request(broker, '/v1/exchange', { body: code, headers: b.peer })).status, 403);
        const exchanged = await request(broker, '/v1/exchange', { body: code, headers: a.peer });
        const body = { sessionHandle: exchanged.json.sessionHandle };
        assert.strictEqual((await request(broker, '/v1/authorize', { body, headers: b.peer })).status, 403);
        Identity.revokeSession(a.token);
        assert.strictEqual((await request(broker, '/v1/authorize', { body, headers: a.peer })).status, 403);
    });
    it('malformed and oversized bodies return bounded errors without echoing secrets', async broker => {
        const a = await buyer('north');
        const result = await request(broker, '/v1/exchange', { raw: '{"secret":"do-not-print"', headers: a.peer });
        assert.strictEqual(result.status, 400); assert.strictEqual(result.text.includes('do-not-print'), false);
        assert.strictEqual((await request(broker, '/v1/exchange', { raw: 'x'.repeat(4097), headers: a.peer })).status, 413);
        assert.strictEqual((await request(broker, '/v1/exchange?secret=x', { body: {}, headers: a.peer })).status, 404);
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM ava_module_grants').n, 0);
    });
    it('native cleanup survives business disable, is peer-scoped and requires an unexpired receipt', async (broker, browser) => {
        const a = await buyer('north'), b = await buyer('south');
        const exchange = await request(broker, '/v1/exchange', { body: await grant(browser, a), headers: a.peer });
        Access.disable(a.adapter.id);
        const lease = await request(broker, '/v1/revocations/lease', { body: {}, headers: a.peer });
        assert.strictEqual(lease.status, 200);
        assert.strictEqual(lease.json.job.bindingId, exchange.json.bindingId);
        const body = { bindingId: lease.json.job.bindingId, leaseToken: lease.json.job.leaseToken, result: 'native_session_absent' };
        assert.strictEqual((await request(broker, '/v1/revocations/complete', { body, headers: b.peer })).status, 403);
        assert.strictEqual((await request(broker, '/v1/revocations/complete', { body: { ...body, result: 'ok' }, headers: a.peer })).status, 403);
        assert.strictEqual((await request(broker, '/v1/revocations/complete', { body, headers: a.peer })).status, 200);
        assert.strictEqual((await request(broker, '/v1/revocations/lease', { body: {}, headers: a.peer })).json.job, null);
        assert.strictEqual(DB.get('SELECT state FROM ava_module_revocations WHERE bindingId=?', [body.bindingId]).state, 'done');
    });
    it('crashed native cleanup workers cannot acknowledge late and enter dead-letter after eight attempts', async (broker, browser) => {
        const a = await buyer('north');
        const exchange = await request(broker, '/v1/exchange', { body: await grant(browser, a), headers: a.peer });
        Identity.revokeSession(a.token);
        const first = (await request(broker, '/v1/revocations/lease', { body: {}, headers: a.peer })).json.job;
        assert.ok(first);
        for (let i = 0; i < 8; i++) {
            DB.run('UPDATE ava_module_revocations SET leasedUntil=?', [Date.now() - 1]);
            await request(broker, '/v1/revocations/lease', { body: {}, headers: a.peer });
        }
        const late = await request(broker, '/v1/revocations/complete', { headers: a.peer,
            body: { bindingId: first.bindingId, leaseToken: first.leaseToken, result: 'native_session_absent' } });
        assert.strictEqual(late.status, 403);
        const row = DB.get('SELECT * FROM ava_module_revocations WHERE bindingId=?', [exchange.json.bindingId]);
        assert.strictEqual(row.attempts, 8); assert.strictEqual(row.state, 'failed');
        assert.strictEqual(JSON.stringify(row).includes(exchange.json.sessionHandle), false);
    });
});
