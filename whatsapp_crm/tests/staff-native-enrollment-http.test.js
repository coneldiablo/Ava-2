'use strict';
const http = require('http');
const express = require('express');
const axios = require('axios');
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Mailer = require('../src/services/identity/system-mailer.service');
const Sso = require('../src/services/identity/oidc.service');
const { KeycloakAdmin } = require('../src/services/identity/keycloak-admin');
const Broker = require('../src/services/identity/identity-broker');
const routes = require('../src/routes/identity.routes');

const origin = 'https://ava.example.test';
const password = 'fixture-staff-long-password';
const operator = { platformRole: 'platform_admin', userId: 'fixture-operator' };
let fixtureAddress = 80;
const listen = server => new Promise((resolve, reject) => {
    server.once('error', reject);
    if (server.listening) resolve(server);
    else server.once('listening', () => resolve(server));
});

async function fixture(run) {
    const names = ['AVA_TEAM_NEW_ACCOUNT_ENABLED', 'AVA_CUSTOMER_ACCESS_ENABLED', 'AVA_PROCESS_ROLE',
        'AVA_OIDC_ISSUER', 'AVA_IDENTITY_ADMIN_ORIGIN', 'AVA_IDENTITY_BROKER_TOKEN',
        'AVA_IDENTITY_ADMIN_CLIENT_ID', 'AVA_IDENTITY_ADMIN_CLIENT_SECRET', 'SESSION_SECRET', 'WHATSAPP_CRM_PUBLIC_URL'];
    const env = Object.fromEntries(names.map(name => [name, process.env[name]]));
    const previous = { db: DB.db, send: Mailer.sendVerificationCodeEmail, enabled: Sso.enabled, post: axios.post };
    Object.assign(process.env, { AVA_TEAM_NEW_ACCOUNT_ENABLED: 'true', AVA_CUSTOMER_ACCESS_ENABLED: 'true',
        AVA_PROCESS_ROLE: 'provisioning-worker', AVA_OIDC_ISSUER: 'https://identity.example.test/realms/ava',
        AVA_IDENTITY_BROKER_TOKEN: 'fixture-broker-token-at-least-32-characters',
        AVA_IDENTITY_ADMIN_CLIENT_ID: 'fixture-client', AVA_IDENTITY_ADMIN_CLIENT_SECRET: 'fixture-secret',
        SESSION_SECRET: 'fixture-staff-http-secret-at-least-32-characters', WHATSAPP_CRM_PUBLIC_URL: origin });
    delete process.env.AVA_IDENTITY_ADMIN_ORIGIN;
    const db = createTestDB(); Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Fixture A'),(2,'Fixture B')");
    const existing = (email, businessId) => {
        const invite = Identity.createInvitation(operator, { email, businessId, role: 'hotel_owner' });
        return Identity.completeInvitation(Identity.claimInvitation(invite.token), `fixture-subject-${businessId}`);
    };
    const owner = existing('owner@example.test', 1), staff = existing('existing@example.test', 2);
    const messages = [];
    Mailer.sendVerificationCodeEmail = async message => { messages.push(message); };
    Sso.enabled = () => true;
    let native = null;
    const writes = { create: 0, password: 0, enable: 0 };
    let onNativeEnable;
    const providerApp = express(); providerApp.use(express.urlencoded({ extended: false })); providerApp.use(express.json());
    providerApp.post('/realms/ava/protocol/openid-connect/token', (_req, res) => res.json({ access_token: 'fixture-token', expires_in: 300 }));
    providerApp.use('/admin/realms/ava', (req, res) => {
        if (req.headers.authorization !== 'Bearer fixture-token') return res.status(401).json({});
        if (req.method === 'GET' && req.path === '/users') return res.json(native ? [native] : []);
        if (req.method === 'POST' && req.path === '/users') {
            writes.create++; native = { ...req.body, id: 'fixture-native-new-staff' }; return res.status(201).end();
        }
        if (!native || !req.path.startsWith(`/users/${native.id}`)) return res.status(404).json({});
        if (req.method === 'PUT' && req.path.endsWith('/reset-password')) {
            assert.equal(req.body.value, password); writes.password++; return res.status(204).end();
        }
        if (req.method === 'PUT') {
            if (req.body.enabled === true) { writes.enable++; if (onNativeEnable) onNativeEnable(); }
            Object.assign(native, req.body); return res.status(204).end();
        }
        if (req.method === 'POST' && req.path.endsWith('/logout')) return res.status(204).end();
        if (req.method === 'GET') return res.json(native);
        return res.status(404).json({});
    });
    const provider = http.createServer(providerApp).listen(0, '127.0.0.1');
    const app = express(); app.set('trust proxy', true); app.use(express.json()); app.use('/api', routes);
    const browser = http.createServer(app).listen(0, '127.0.0.1');
    let broker;
    try {
        await Promise.all([listen(provider), listen(browser)]);
        const admin = new KeycloakAdmin({ request: config => axios.request({ ...config,
            url: `http://127.0.0.1:${provider.address().port}${new URL(config.url).pathname}${new URL(config.url).search}` }) });
        broker = Broker.start({ port: 0, host: '127.0.0.1', admin }); await listen(broker);
        // Rewrite the fixed service origin only. Both hops execute actual HTTP,
        // real authentication, public routes, broker, native adapter and DB code.
        axios.post = (url, data, config) => {
            assert.equal(url, 'http://provisioning_worker:3900/invitations/redeem');
            assert.equal(typeof data.verificationId, 'string', 'The selected public proof must be pinned through the broker');
            return previous.post(`http://127.0.0.1:${broker.address().port}/invitations/redeem`, data, config);
        };
        const address = `192.0.2.${fixtureAddress++}`;
        const request = async (path, body, session) => {
            const response = await fetch(`http://127.0.0.1:${browser.address().port}/api/invitations/${path}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin,
                    'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-For': address,
                    ...(session ? { Cookie: `crm_session=ava2:${session}` } : {}) }, body: JSON.stringify(body),
            });
            return { status: response.status, data: await response.json(), headers: response.headers };
        };
        await run({ owner, staff, request, messages, writes, native: () => native,
            expireDuringEnable: verificationId => { onNativeEnable = () => DB.run(
                'UPDATE ava_team_email_verifications SET expiresAtMs=? WHERE id=?', [Date.now() - 1, verificationId]); } });
    } finally {
        axios.post = previous.post; Sso.enabled = previous.enabled; Mailer.sendVerificationCodeEmail = previous.send;
        await Promise.all([provider, browser, broker].filter(server => server?.listening)
            .map(server => new Promise(resolve => server.close(resolve))));
        DB.db = previous.db; db.close();
        for (const name of names) env[name] === undefined ? delete process.env[name] : process.env[name] = env[name];
    }
}

describe('Staff invitation real public HTTP / authenticated worker HTTP / SQLite enrollment', () => {
    it('new staff proves email, activates verified native identity, gets exactly invited tenant and role, and cannot replay', () => fixture(async context => {
        const invite = Identity.inviteBusinessMember(context.owner, 1, { email: 'new@example.test', role: 'manager' });
        const inspected = await context.request('inspect', { token: invite.token });
        assert.equal(inspected.status, 200); assert.equal(inspected.data.acceptance, 'new_account');
        assert.equal(inspected.data.newAccountEnabled, true);
        const verification = await context.request('request-verification', { token: invite.token, password });
        assert.equal(verification.status, 200); assert.equal(context.messages[0].to, 'new@example.test');
        const verificationId = verification.data.verification_id;
        const invalid = await context.request('redeem', { token: invite.token, verificationId, code: '000000' });
        assert.equal(invalid.status, 400); assert.equal(invalid.data.error_code, 'INVALID_VERIFICATION_CODE');
        assert.deepEqual(context.writes, { create: 0, password: 0, enable: 0 });
        const joined = await context.request('redeem', { token: invite.token, verificationId, code: context.messages[0].code,
            password: 'ignored-untrusted-password', businessId: 2, role: 'hotel_owner' });
        assert.equal(joined.status, 200); assert.equal(joined.headers.get('set-cookie'), null);
        const native = context.native(); assert.equal(native.enabled, true); assert.equal(native.emailVerified, true);
        assert.deepEqual(native.requiredActions, []); assert.equal(native.username, `ava-${joined.data.user_id}`);
        assert.deepEqual(native.attributes.avaUserId, [joined.data.user_id]);
        const current = Identity.session(Identity.createSession(native.id));
        assert.deepEqual(current.memberships.map(({ businessId, role }) => ({ businessId, role })), [{ businessId: 1, role: 'manager' }]);
        assert.throws(() => Identity.authorizeCapability(current, 2, 'team.manage'), { code: 'BUSINESS_ACCESS_DENIED' });
        assert.equal(DB.get('SELECT passwordEncrypted FROM ava_team_email_verifications WHERE id=?', [verificationId]).passwordEncrypted, '');
        const replay = await context.request('redeem', { token: invite.token, verificationId, code: context.messages[0].code });
        assert.equal(replay.status, 400); assert.deepEqual(context.writes, { create: 1, password: 1, enable: 1 });
    }));

    it('existing staff must use exact current subject and joins without password reset or native mutation', () => fixture(async context => {
        const invite = Identity.inviteBusinessMember(context.owner, 1, { email: context.staff.email, role: 'observer' });
        const inspected = await context.request('inspect', { token: invite.token });
        assert.equal(inspected.data.acceptance, 'existing_account');
        const wrong = await context.request('accept', { token: invite.token }, Identity.createSession(context.owner.subject));
        assert.equal(wrong.status, 403);
        const joined = await context.request('accept', { token: invite.token, role: 'hotel_owner', businessId: 2 }, Identity.createSession(context.staff.subject));
        assert.equal(joined.status, 200); assert.equal(joined.data.user_id, context.staff.userId);
        assert.equal(Identity.actor(context.staff.userId).memberships.find(item => item.businessId === 1).role, 'observer');
        assert.deepEqual(context.writes, { create: 0, password: 0, enable: 0 }); assert.equal(context.messages.length, 0);
    }));

    it('public selected proof stays pinned through the worker even with another valid proof, and expiry compensates access', () => fixture(async context => {
        const invite = Identity.inviteBusinessMember(context.owner, 1, { email: 'new@example.test', role: 'manager' });
        const verification = await context.request('request-verification', { token: invite.token, password });
        const verificationId = verification.data.verification_id;
        // A newer valid proof must not silently replace the proof the browser
        // selected and verified. This makes the broker's exact ID observable.
        DB.run(`INSERT INTO ava_team_email_verifications
            (id,invitationId,invitationTokenHash,email,passwordEncrypted,codeHash,attempts,resendCount,resendAfterMs,expiresAtMs,verifiedAtMs,createdAtMs)
            SELECT 'fixture-newer-proof',invitationId,invitationTokenHash,email,passwordEncrypted,codeHash,attempts,resendCount,resendAfterMs,expiresAtMs,?,createdAtMs+1
            FROM ava_team_email_verifications WHERE id=?`, [Date.now(), verificationId]);
        context.expireDuringEnable(verificationId);
        const joined = await context.request('redeem', { token: invite.token, verificationId, code: context.messages[0].code });
        assert.notEqual(joined.status, 200); assert.equal(context.native().enabled, false);
        const { userId, state } = DB.get('SELECT userId,state FROM ava_invitations WHERE id=?', [invite.invitationId]);
        assert.notEqual(state, 'consumed'); assert.equal(DB.get('SELECT enabled FROM ava_users WHERE id=?', [userId]).enabled, 0);
        assert.equal(DB.get('SELECT count(*) n FROM ava_business_memberships WHERE userId=? AND enabled=1', [userId]).n, 0);
        assert.equal(DB.get("SELECT state FROM ava_identity_outbox WHERE userId=? AND action='revoke_memberships'", [userId]).state, 'pending');
        assert.throws(() => Identity.createSession(context.native().id), { code: 'ACCOUNT_NOT_ENROLLED' });
    }));
});
