'use strict';
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Provisioning = require('../src/services/provisioning/business-provisioning-store.service');
const Twenty = require('../src/services/twenty/twenty-store.service');
const Access = require('../src/services/identity/module-access-store');
const { createServer } = require('../src/services/identity/module-access-broker');
const createRouter = require('../src/routes/module-access.routes');
const origin = 'https://wh.meludtech.tech';
const random = () => crypto.randomBytes(32).toString('base64url');
const readback = async input => ({ ...input, ownAccess: true, foreignAccessDenied: true,
    platformAdminDenied: true, sessionGuardVerified: true });
function request(server, path, { method = 'POST', headers = {}, body = {} } = {}) {
    return new Promise((resolve, reject) => {
        const data = method === 'GET' ? '' : JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('error', reject); req.end(data);
    });
}

describe('Native team role direct HTTP boundary with active AVA cookie', () => {
    it('rechecks all roles, business removal, foreign scope and native sessions on real endpoints', async () => {
        const envKeys = ['AVA_PROCESS_ROLE', 'AVA_CUSTOMER_ACCESS_ENABLED', 'WHATSAPP_CRM_PUBLIC_URL'];
        const previous = envKeys.map(key => process.env[key]);
        process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
        process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
        createTestDB();
        const admin = { userId: 'native-http-operator', platformRole: 'platform_admin' };
        const invite = Identity.createInvitation(admin, { email: 'native-http@example.test' });
        const user = Identity.completeInvitation(Identity.claimInvitation(invite.token), 'native-http-subject');
        const business = Provisioning.createBusinessAtomic({ name: 'Native HTTP team' }, { ownerUserId: user.userId }).instance;
        Twenty.upsertIntegration(business.id, { baseUrl: 'https://team-http.crm.meludtech.tech', workspaceId: 'native-http-workspace', enabled: true });
        const adapter = Access.configure({ businessId: business.id, module: 'twenty', publicOrigin: 'https://team-http.crm.meludtech.tech' });
        const token = Identity.createSession(user.subject, 'native-http-sid');
        const browserHeaders = { Cookie: `crm_session=ava2:${token}`, Origin: origin };
        const peerHeaders = { 'X-AVA-Adapter-ID': adapter.id, Authorization: `Bearer ${adapter.peerSecret}` };
        const app = express(); app.use(express.json()); app.use('/api', createRouter());
        const broker = createServer(), browser = http.createServer(app);
        try {
            await Promise.all([broker, browser].map(server => new Promise((resolve, reject) => {
                server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
            })));
            let previousNativeSession = null;
            for (const role of ['hotel_owner', 'manager', 'sales_lead', 'observer']) {
                DB.db.transaction(() => {
                    Access.revokeBusinessAccess(user.userId, business.id);
                    DB.run('UPDATE ava_business_memberships SET role=? WHERE userId=? AND businessId=?', [role, user.userId, business.id]);
                }).immediate();
                if (previousNativeSession) {
                    const denied = await request(broker, '/v1/authorize', { headers: peerHeaders, body: { sessionHandle: previousNativeSession } });
                    assert.strictEqual(denied.status, 403);
                }
                const supported = ['hotel_owner', 'manager'].includes(role);
                if (supported) await Access.verifyPrincipal({ adapterId: adapter.id, userId: user.userId,
                    nativeUserId: 'native-http-user', readback });
                const listing = await request(browser, `/api/businesses/${business.id}/modules`, { method: 'GET', headers: browserHeaders });
                assert.strictEqual(listing.status, 200);
                const native = listing.json.modules.find(item => item.module === 'twenty');
                assert.deepStrictEqual(native.allowed_actions, supported ? ['open'] : []);
                if (!supported) assert.strictEqual(native.error_code, 'MODULE_ROLE_NOT_SUPPORTED');
                const verifier = random();
                const grant = await request(browser, `/api/modules/${adapter.id}/grants`, { headers: browserHeaders,
                    body: { code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') } });
                assert.strictEqual(grant.status, supported ? 200 : 403);
                if (!supported) {
                    assert.strictEqual(grant.json.error_code, 'MODULE_ROLE_NOT_SUPPORTED');
                    continue;
                }
                const exchanged = await request(broker, '/v1/exchange', { headers: peerHeaders, body: { code: grant.json.code, verifier } });
                assert.strictEqual(exchanged.status, 200);
                assert.strictEqual(exchanged.json.role, role);
                previousNativeSession = exchanged.json.sessionHandle;
            }
            assert.ok(Identity.session(token));
            const forged = await request(browser, `/api/modules/${adapter.id}/grants`, { headers: browserHeaders,
                body: { code_challenge: random(), role: 'hotel_owner', businessId: business.id } });
            assert.strictEqual(forged.status, 400);
            const foreign = await request(browser, `/api/businesses/${business.id + 500}/modules`, { method: 'GET', headers: browserHeaders });
            assert.strictEqual(foreign.status, 403);
            DB.db.transaction(() => {
                Access.revokeBusinessAccess(user.userId, business.id);
                DB.run('UPDATE ava_business_memberships SET enabled=0 WHERE userId=? AND businessId=?', [user.userId, business.id]);
            }).immediate();
            assert.ok(Identity.session(token));
            const removed = await request(browser, `/api/businesses/${business.id}/modules`, { method: 'GET', headers: browserHeaders });
            assert.strictEqual(removed.status, 403);
            const stale = await request(browser, `/api/modules/${adapter.id}/grants`, { headers: browserHeaders, body: { code_challenge: random() } });
            assert.strictEqual(stale.status, 403);
            assert.strictEqual(DB.get('SELECT count(*) AS n FROM ava_identity_outbox').n, 0);
        } finally {
            await Promise.all([broker, browser].filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
            envKeys.forEach((key, i) => {
                if (previous[i] === undefined) delete process.env[key];
                else process.env[key] = previous[i];
            });
        }
    });
});
