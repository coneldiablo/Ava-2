'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const express = require('express');
const axios = require('axios');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Registration = require('../src/services/identity/self-registration.service');
const Recovery = require('../src/services/identity/password-recovery.service');
const Mailer = require('../src/services/identity/system-mailer.service');
const Sso = require('../src/services/identity/oidc.service');
const { KeycloakAdmin } = require('../src/services/identity/keycloak-admin');
const Broker = require('../src/services/identity/identity-broker');
const { BusinessProvisioningWorker } = require('../src/services/provisioning/business-provisioning-worker.service');
let sequence = 0;
async function listen(server) { if (!server.listening) await new Promise(resolve => server.once('listening', resolve)); return server.address().port; }
async function close(server) { await new Promise(resolve => server.close(resolve)); }
async function harness(fn) {
    const keys = ['AVA_PROCESS_ROLE','AVA_CUSTOMER_ACCESS_ENABLED','AVA_SELF_REGISTRATION_ENABLED','SESSION_SECRET',
        'WHATSAPP_CRM_PUBLIC_URL','AVA_OIDC_ISSUER','AVA_OIDC_CLIENT_ID','AVA_IDENTITY_BROKER_TOKEN','NODE_ENV'];
    const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const originalPost = axios.post, originalTransport = Mailer._transporter, originalLoad = Sso.load;
    const emails = [], native = [], calls = [];
    let hook = async () => {}, lostReply = false, failMail = false;
    Object.assign(process.env, { AVA_PROCESS_ROLE: 'provisioning-worker', AVA_CUSTOMER_ACCESS_ENABLED: 'true',
        AVA_SELF_REGISTRATION_ENABLED: 'true', SESSION_SECRET: 'synthetic-registration-session-secret-only',
        WHATSAPP_CRM_PUBLIC_URL: 'https://ava.example.test', AVA_OIDC_ISSUER: 'https://id.example.test/realms/ava',
        AVA_OIDC_CLIENT_ID: 'ava-web', AVA_IDENTITY_BROKER_TOKEN: 'synthetic-registration-broker-token-only', NODE_ENV: 'test' });
    const db = createTestDB();
    Mailer._transporter = { sendMail: async message => {
        if (failMail) throw new Error('synthetic SMTP unavailable');
        emails.push(message);
    } };
    const admin = new KeycloakAdmin({ request: async request => {
        const url = new URL(request.url), data = request.data;
        calls.push([request.method, url.pathname, url.search]);
        await hook(request);
        if (url.pathname.endsWith('/protocol/openid-connect/token')) return { data: { access_token: 'synthetic-native-token', expires_in: 300 } };
        const path = url.pathname.replace('/admin/realms/ava', '');
        if (request.method === 'GET' && path === '/users') return { data: structuredClone(native.filter(user =>
            url.searchParams.has('username') ? user.username === url.searchParams.get('username') : user.email.toLowerCase() === url.searchParams.get('email').toLowerCase())) };
        if (request.method === 'POST' && path === '/users') { native.push({ id: `native-${native.length+1}`, ...structuredClone(data) }); return { data: null }; }
        const user = native.find(user => path.startsWith(`/users/${user.id}`));
        assert.ok(user, `unexpected synthetic native path ${path}`);
        if (request.method === 'GET' && path.endsWith('/sessions')) return { data: [] };
        if (request.method === 'GET') return { data: structuredClone(user) };
        if (request.method === 'PUT' && path.endsWith('/reset-password')) user.password = data.value;
        if (request.method === 'PUT' && !path.endsWith('/reset-password') && !path.includes('/execute-actions-email')) Object.assign(user, structuredClone(data));
        return { data: null };
    } });
    const broker = Broker.start({ port: 0, host: '127.0.0.1', admin });
    const port = await listen(broker);
    axios.post = async (url, ...args) => {
        assert.strictEqual(url, 'http://provisioning_worker:3900/invitations/redeem');
        const result = await originalPost(`http://127.0.0.1:${port}/invitations/redeem`, ...args);
        if (lostReply) throw new Error('synthetic lost worker reply after commit');
        return result;
    };
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api', require('../src/routes/identity.routes'));
    const server = app.listen(0, '127.0.0.1'), apiPort = await listen(server);
    const source = `127.0.1.${++sequence}`;
    const api = async (path, body, headers = {}) => {
        const response = await fetch(`http://127.0.0.1:${apiPort}/api/public/identity/${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { Origin: 'https://ava.example.test', 'Content-Type': 'application/json', 'X-Forwarded-For': source, ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json(), headers: response.headers };
    };
    const start = async (overrides = {}) => api('registration/start', {
        email: 'new-owner@example.test', displayName: 'New Owner', businessName: 'New Business',
        password: 'synthetic-password-123', ...overrides,
    });
    const code = () => emails.at(-1).subject.match(/\d{6}/)[0];
    try { await fn({ api, start, code, emails, native, calls, admin, db, server,
        setHook: value => { hook = value; }, loseReply: () => { lostReply = true; },
        failMail: value => { failMail = value; } }); }
    finally {
        await close(server); await close(broker);
        axios.post = originalPost; Mailer._transporter = originalTransport; Sso.load = originalLoad;
        db.close();
        for (const key of keys) if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
}

describe('Self registration API → identity broker → Keycloak adapter → atomic provisioning (synthetic providers)', () => {
    it('registers verified unique email without invite, binds one business, and resumes a completed response without native password writes', async () => harness(async h => {
        const config = await h.api('config');
        assert.strictEqual(config.body.registration_enabled, true);
        const started = await h.start();
        assert.strictEqual(started.status, 200);
        assert.strictEqual(h.native.length, 0);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM ava_users').n, 0);
        const proof = { verification_id: started.body.verification_id, code: h.code() };
        assert.ok(!JSON.stringify(started.body).includes(h.code()));
        const result = await h.api('registration/verify', proof);
        assert.strictEqual(result.status, 200, JSON.stringify(result.body));
        const user = Identity.actor(result.body.user_id);
        assert.strictEqual(user.subject, h.native[0].id);
        assert.strictEqual(h.native[0].emailVerified, true);
        assert.strictEqual(h.native[0].enabled, true);
        assert.ok(!h.native[0].requiredActions.includes('VERIFY_EMAIL'));
        assert.strictEqual(user.memberships.length, 1);
        assert.strictEqual(user.memberships[0].role, 'hotel_owner');
        const jobs = DB.all('SELECT * FROM business_provisioning_jobs WHERE businessId=?', [result.body.business_id]);
        assert.strictEqual(jobs.length, 5);
        assert.ok(jobs.every(job => !job.checkpointJson.includes('synthetic-password')));
        const writes = h.calls.filter(([method]) => method !== 'GET').length;
        const replay = await h.api('registration/verify', proof);
        assert.strictEqual(replay.status, 200);
        assert.strictEqual(replay.body.business_id, result.body.business_id);
        assert.strictEqual(h.calls.filter(([method]) => method !== 'GET').length, writes);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 1);
        assert.strictEqual(DB.get('SELECT passwordEncrypted FROM ava_self_registrations').passwordEncrypted, '');
        assert.strictEqual(result.body.login_url, `/api/auth/sso/start?enrolled_user=${user.userId}`);
        // Exercise actual queue leases and finalization with synthetic module adapters.
        const worker = new BusinessProvisioningWorker();
        worker._executeJob = async job => ({ status: 'DONE', stage: 'synthetic_ready', checkpoint: { provider: 'synthetic', businessId: job.businessId } });
        assert.strictEqual(await worker.processQueue(), 5);
        assert.ok(DB.all('SELECT status FROM business_provisioning_jobs').every(job => job.status === 'DONE'));
    }));
    it('a lost worker HTTP response after native commit still returns exactly one user and business', async () => harness(async h => {
        const started = await h.start(); h.loseReply();
        const result = await h.api('registration/verify', { verification_id: started.body.verification_id, code: h.code() });
        assert.strictEqual(result.status, 200, JSON.stringify(result.body));
        assert.strictEqual(h.native.length, 1);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM ava_users').n, 1);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 1);
    }));
    it('first login verifies signed OIDC PKCE/nonce and accepts only the new registered subject', async () => harness(async h => {
        const started = await h.start();
        const registered = await h.api('registration/verify', { verification_id: started.body.verification_id, code: h.code() });
        assert.strictEqual(registered.status, 200);
        const oidc = await import(require.resolve('openid-client'));
        const jose = await import(require.resolve('jose'));
        const pair = await jose.generateKeyPair('RS256');
        const jwk = { ...await jose.exportJWK(pair.publicKey), kid: 'signup-fixture', alg: 'RS256', use: 'sig' };
        const issuer = process.env.AVA_OIDC_ISSUER;
        let flow, subject = 'old-foreign-native';
        const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
        const request = async (input, options) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('/.well-known/openid-configuration')) return json({ issuer,
                authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/certs`,
                end_session_endpoint: `${issuer}/logout`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] });
            if (url.pathname.endsWith('/certs')) return json({ keys: [jwk] });
            const body = new URLSearchParams(options.body);
            assert.strictEqual(body.get('code_verifier'), flow.verifier);
            const idToken = await new jose.SignJWT({ nonce: flow.nonce, sid: 'signup-native-session' })
                .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setSubject(subject)
                .setAudience('ava-web').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
            return json({ access_token: 'synthetic-access-token', token_type: 'Bearer', expires_in: 300, id_token: idToken });
        };
        const service = new (require('../src/services/identity/oidc.service').OidcService)({ load: async () => ({ ...oidc,
            discovery: (server, client, metadata, auth, options) => oidc.discovery(server, client, metadata, auth, { ...options, [oidc.customFetch]: request }),
        }) });
        let begin = await service.begin(registered.body.user_id);
        flow = service.open(begin.cookie);
        assert.strictEqual(new URL(begin.url).searchParams.get('prompt'), 'login');
        await assert.rejects(service.complete(`state=${flow.state}&code=synthetic-code`, begin.cookie), { code: 'AVA_SSO_FAILED' });
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM ava_sessions').n, 0);
        subject = h.native[0].id;
        begin = await service.begin(registered.body.user_id); flow = service.open(begin.cookie);
        const session = await service.complete(`state=${flow.state}&code=synthetic-code`, begin.cookie);
        assert.strictEqual(Identity.session(session).userId, registered.body.user_id);
        assert.strictEqual(Identity.session(session).memberships[0].businessId, registered.body.business_id);
        await assert.rejects(service.complete(`state=${flow.state}&code=synthetic-code`, begin.cookie));
    }));
    it('rolls back failed atomic business bootstrap and retries the same subject after durable compensation', async () => harness(async h => {
        const started = await h.start();
        h.db.exec("CREATE TRIGGER synthetic_bootstrap_failure BEFORE INSERT ON instances BEGIN SELECT RAISE(ABORT,'synthetic bootstrap outage'); END");
        const proof = { verification_id: started.body.verification_id, code: h.code() };
        assert.strictEqual((await h.api('registration/verify', proof)).status, 503);
        assert.strictEqual(DB.get('SELECT enabled FROM ava_users').enabled, 0);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 0);
        h.db.exec('DROP TRIGGER synthetic_bootstrap_failure');
        await require('../src/services/identity/revocation-worker').processOne({ admin: h.admin, keycloakOnly: true });
        assert.strictEqual((await h.api('registration/verify', proof)).status, 200);
        assert.strictEqual(DB.get('SELECT passwordEncrypted FROM ava_self_registrations').passwordEncrypted, '');
        assert.strictEqual(h.native.length, 1);
    }));
    it('never rebinds an existing disabled or enabled local email, including mixed case', async () => harness(async h => {
        Identity.ensureSchema();
        DB.run("INSERT INTO ava_users(id,email,subject,enabled) VALUES ('foreign','New-Owner@Example.Test','existing-subject',0)");
        const started = await h.start();
        assert.strictEqual(started.status, 200);
        assert.strictEqual(h.emails.length, 1);
        const verified = await h.api('registration/verify', { verification_id: started.body.verification_id, code: h.code() });
        assert.strictEqual(verified.body.status, 'existing_account');
        assert.strictEqual(verified.body.login_url, '/api/auth/sso/start');
        assert.strictEqual(verified.body.user_id, undefined);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 0);
        assert.strictEqual(DB.get('SELECT passwordEncrypted FROM ava_self_registrations').passwordEncrypted, '');
        assert.deepStrictEqual(DB.get("SELECT subject,enabled,businessQuota FROM ava_users WHERE id='foreign'"), { subject: 'existing-subject', enabled: 0, businessQuota: 0 });
        assert.strictEqual(h.calls.length, 0);
    }));
    it('native-only disabled email blocks new account creation and password mutation', async () => harness(async h => {
        h.native.push({ id: 'foreign-native', username: 'unrelated', email: 'new-owner@example.test', enabled: false, attributes: {} });
        const started = await h.start();
        const result = await h.api('registration/verify', { verification_id: started.body.verification_id, code: h.code() });
        assert.strictEqual(result.status, 503);
        assert.ok(!h.calls.some(([method, path]) => method === 'PUT' || (method === 'POST' && path.endsWith('/users'))));
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 0);
    }));
    it('resumed registration cannot reset a recreated native subject with otherwise identical attributes', async () => harness(async h => {
        const started = await h.start();
        h.setHook(async request => {
            if (request.url.endsWith('/reset-password')) throw { response: { status: 400, data: { errorMessage: 'invalidPasswordHistoryMessage' } } };
        });
        assert.strictEqual((await h.api('registration/verify', { verification_id: started.body.verification_id, code: h.code() })).status, 400);
        const original = DB.get('SELECT id,subject FROM ava_users');
        h.setHook(async () => {});
        await require('../src/services/identity/revocation-worker').processOne({ admin: h.admin, keycloakOnly: true });
        h.native[0].id = 'native-recreated';
        h.native[0].enabled = false;
        DB.run('UPDATE ava_self_registrations SET expiresAtMs=0');
        const restarted = await h.start({ password: 'new-synthetic-password-456' });
        const startCalls = h.calls.length;
        assert.strictEqual((await h.api('registration/verify', { verification_id: restarted.body.verification_id, code: h.code() })).status, 503);
        assert.ok(h.calls.slice(startCalls).every(([method]) => method === 'GET'));
        assert.strictEqual(h.native[0].enabled, false);
        assert.strictEqual(DB.get('SELECT subject FROM ava_users').subject, original.subject);
    }));
    it('schema-only release migration leaves existing registration rows byte-for-byte unchanged', async () => harness(async h => {
        await h.start();
        DB.run('UPDATE ava_self_registrations SET expiresAtMs=0');
        const before = DB.all('SELECT * FROM ava_self_registrations');
        Registration.ensureSchema({ cleanup: false });
        assert.deepStrictEqual(DB.all('SELECT * FROM ava_self_registrations'), before);
        Registration.ensureSchema();
        assert.strictEqual(DB.get('SELECT passwordEncrypted FROM ava_self_registrations').passwordEncrypted, '');
    }));
    it('wrong codes commit five-attempt budget; resend cannot reset guesses or extend expiry', async () => harness(async h => {
        const started = await h.start();
        const id = started.body.verification_id;
        const before = DB.get('SELECT expiresAtMs FROM ava_self_registrations').expiresAtMs;
        assert.strictEqual((await h.api('registration/resend', { verification_id: id })).status, 429);
        DB.run('UPDATE ava_self_registrations SET resendAfterMs=?', [Date.now()-1]);
        const original = h.code();
        assert.strictEqual((await h.api('registration/resend', { verification_id: id })).status, 200);
        assert.strictEqual(DB.get('SELECT expiresAtMs FROM ava_self_registrations').expiresAtMs, before);
        const wrong = h.code() === '000000' ? '000001' : '000000';
        for (let attempt = 0; attempt < 5; attempt++) {
            const result = await h.api('registration/verify', { verification_id: id, code: wrong });
            assert.strictEqual(result.status, attempt === 4 ? 429 : 400);
        }
        assert.strictEqual(DB.get('SELECT attempts FROM ava_self_registrations').attempts, 5);
        assert.strictEqual((await h.api('registration/verify', { verification_id: id, code: h.code() })).status, 429);
        assert.strictEqual(h.native.length, 0);
        assert.ok(original);
    }));
    it('bounds resend to three deliveries and scrubs expired encrypted passwords', async () => harness(async h => {
        const started = await h.start();
        for (let attempt = 0; attempt < 2; attempt++) {
            DB.run('UPDATE ava_self_registrations SET resendAfterMs=0');
            assert.strictEqual((await h.api('registration/resend', { verification_id: started.body.verification_id })).status, 200);
        }
        DB.run('UPDATE ava_self_registrations SET resendAfterMs=0');
        assert.strictEqual((await h.api('registration/resend', { verification_id: started.body.verification_id })).status, 429);
        assert.strictEqual(h.emails.length, 3);
        DB.run('UPDATE ava_self_registrations SET expiresAtMs=0');
        assert.strictEqual((await h.api('registration/verify', { verification_id: started.body.verification_id, code: h.code() })).status, 400);
        assert.strictEqual(DB.get('SELECT passwordEncrypted FROM ava_self_registrations').passwordEncrypted, '');
    }));
    it('SMTP failure is explicit and leaves a fresh start retryable without native calls', async () => harness(async h => {
        h.failMail(true);
        const failed = await h.start();
        assert.strictEqual(failed.status, 503);
        assert.strictEqual(failed.body.error_code, 'REGISTRATION_EMAIL_UNAVAILABLE');
        assert.strictEqual(DB.get('SELECT passwordEncrypted FROM ava_self_registrations').passwordEncrypted, '');
        h.failMail(false);
        const restarted = await h.start();
        assert.strictEqual(restarted.status, 200);
        assert.strictEqual(h.emails.length, 1);
        assert.strictEqual(h.native.length, 0);
    }));
    it('native password policy rejection is explicit and accepts correction only with the same OTP after compensation', async () => harness(async h => {
        assert.strictEqual((await h.start({ password: 'new-owner@example.test' })).body.error_code, 'PASSWORD_POLICY');
        const started = await h.start();
        const proof = { verification_id: started.body.verification_id, code: h.code() };
        h.setHook(async request => {
            if (request.url.endsWith('/reset-password') && request.data.value === 'synthetic-password-123') {
                throw { response: { status: 400, data: { errorMessage: 'invalidPasswordHistoryMessage' } } };
            }
        });
        const rejected = await h.api('registration/verify', proof);
        assert.strictEqual(rejected.status, 400, JSON.stringify(rejected.body));
        assert.strictEqual(rejected.body.error_code, 'PASSWORD_POLICY');
        assert.strictEqual(DB.get('SELECT passwordEncrypted FROM ava_self_registrations').passwordEncrypted, '');
        assert.strictEqual((await h.api('registration/verify', { ...proof, password: 'corrected-synthetic-password-123' })).status, 409);
        const originalUser = DB.get('SELECT id,subject FROM ava_users');
        assert.strictEqual(await require('../src/services/identity/revocation-worker').processOne({ admin: h.admin, keycloakOnly: true }), true);
        const result = await h.api('registration/verify', { ...proof, password: 'corrected-synthetic-password-123' });
        assert.strictEqual(result.status, 200, JSON.stringify(result.body));
        assert.strictEqual(h.native.length, 1);
        assert.strictEqual(result.body.user_id, originalUser.id);
        assert.strictEqual(Identity.actor(originalUser.id).subject, originalUser.subject);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 1);
    }));
    it('replays a corrected-password completion after a lost reply without validating or resetting a supplied password', async () => harness(async h => {
        const started = await h.start();
        const proof = { verification_id: started.body.verification_id, code: h.code() };
        h.setHook(async request => {
            if (request.url.endsWith('/reset-password') && request.data.value === 'synthetic-password-123') throw { response: { status: 400 } };
        });
        assert.strictEqual((await h.api('registration/verify', proof)).status, 400);
        await require('../src/services/identity/revocation-worker').processOne({ admin: h.admin, keycloakOnly: true });
        h.loseReply();
        const request = { ...proof, password: 'corrected-synthetic-password-123' };
        const committed = await h.api('registration/verify', request);
        assert.strictEqual(committed.status, 200);
        const writes = h.calls.filter(([method]) => method !== 'GET').length;
        // Discard the successful response as a browser timeout would, then
        // resend the same payload, including its optional corrected password.
        const replay = await h.api('registration/verify', request);
        assert.strictEqual(replay.status, 200, JSON.stringify(replay.body));
        assert.strictEqual(replay.body.user_id, committed.body.user_id);
        assert.strictEqual(replay.body.business_id, committed.body.business_id);
        assert.strictEqual((await h.api('registration/verify', { ...proof, password: 'bad' })).status, 200);
        assert.strictEqual(h.calls.filter(([method]) => method !== 'GET').length, writes);
        assert.strictEqual(h.native[0].password, request.password);
        assert.strictEqual(DB.get('SELECT passwordEncrypted FROM ava_self_registrations').passwordEncrypted, '');
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 1);
    }));
    it('worker outage plus expired proof restarts its exact orphan with fresh email OTP and no duplicate identity', async () => harness(async h => {
        const started = await h.start();
        const oldProof = { verification_id: started.body.verification_id, code: h.code() };
        h.setHook(async request => { if (request.url.endsWith('/token')) throw new Error('synthetic provider outage'); });
        assert.strictEqual((await h.api('registration/verify', oldProof)).status, 503);
        const originalUser = DB.get('SELECT id,subject FROM ava_users');
        assert.strictEqual(originalUser.subject, null);
        DB.run('UPDATE ava_self_registrations SET expiresAtMs=0');
        DB.run('UPDATE ava_invitations SET leasedUntil=0');
        h.setHook(async () => {});
        const restarted = await h.start({ password: 'changed-synthetic-password-123' });
        assert.strictEqual(restarted.status, 200);
        assert.strictEqual(h.emails.length, 2);
        assert.notStrictEqual(restarted.body.verification_id, started.body.verification_id);
        assert.strictEqual((await h.api('registration/verify', oldProof)).status, 400);
        const result = await h.api('registration/verify', { verification_id: restarted.body.verification_id, code: h.code() });
        assert.strictEqual(result.status, 200, JSON.stringify(result.body));
        assert.strictEqual(result.body.user_id, originalUser.id);
        assert.strictEqual(h.native.length, 1);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM ava_users').n, 1);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 1);
    }));
    it('expired proof after native compensation resumes only the same disabled native subject and waits for its revocation', async () => harness(async h => {
        const started = await h.start();
        h.setHook(async request => {
            if (request.url.endsWith('/reset-password')) throw { response: { status: 400, data: { errorMessage: 'invalidPasswordHistoryMessage' } } };
        });
        assert.strictEqual((await h.api('registration/verify', { verification_id: started.body.verification_id, code: h.code() })).status, 400);
        const original = DB.get('SELECT id,subject FROM ava_users');
        DB.run('UPDATE ava_self_registrations SET expiresAtMs=0');
        DB.run('UPDATE ava_invitations SET leasedUntil=0');
        h.setHook(async () => {});
        const restarted = await h.start({ password: 'changed-synthetic-password-123' });
        assert.strictEqual(h.emails.length, 2);
        const proof = { verification_id: restarted.body.verification_id, code: h.code() };
        assert.strictEqual((await h.api('registration/verify', proof)).status, 409);
        await require('../src/services/identity/revocation-worker').processOne({ admin: h.admin, keycloakOnly: true });
        const result = await h.api('registration/verify', proof);
        assert.strictEqual(result.status, 200, JSON.stringify(result.body));
        assert.strictEqual(result.body.user_id, original.id);
        assert.strictEqual(h.native[0].id, original.subject);
        assert.strictEqual(h.native.length, 1);
    }));
    it('proof expiry during native token acquisition fences every native mutation', async () => harness(async h => {
        const started = await h.start();
        h.setHook(async request => {
            if (request.url.includes('/protocol/openid-connect/token')) DB.run('UPDATE ava_self_registrations SET expiresAtMs=0');
        });
        assert.strictEqual((await h.api('registration/verify', { verification_id: started.body.verification_id, code: h.code() })).status, 503);
        assert.ok(!h.calls.some(([method, path]) => method === 'PUT' || (method === 'POST' && path.endsWith('/users'))));
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 0);
    }));
    it('concurrent confirmations cannot create a second native user or business', async () => harness(async h => {
        const started = await h.start();
        const proof = { verification_id: started.body.verification_id, code: h.code() };
        const results = await Promise.all([h.api('registration/verify', proof), h.api('registration/verify', proof)]);
        assert.ok(results.some(result => result.status === 200));
        assert.ok(results.every(result => [200,409].includes(result.status)), JSON.stringify(results));
        assert.strictEqual(h.native.length, 1);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 1);
    }));
    it('expired old worker must terminate and compensate before replacement proof can mutate native identity', async () => harness(async h => {
        const started = await h.start();
        const oldProof = { verification_id: started.body.verification_id, code: h.code() };
        let entered, release;
        const enteredPromise = new Promise(resolve => { entered = resolve; });
        const releasePromise = new Promise(resolve => { release = resolve; });
        let paused = false;
        h.setHook(async request => {
            if (!paused && request.url.endsWith('/reset-password')) { paused = true; entered(); await releasePromise; }
        });
        const oldRequest = h.api('registration/verify', oldProof);
        await enteredPromise;
        DB.run('UPDATE ava_self_registrations SET expiresAtMs=0');
        DB.run('UPDATE ava_invitations SET leasedUntil=0');
        const restarted = await h.start({ password: 'changed-synthetic-password-123' });
        const nextProof = { verification_id: restarted.body.verification_id, code: h.code() };
        assert.strictEqual((await h.api('registration/verify', nextProof)).status, 409);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 0);
        release();
        assert.strictEqual((await oldRequest).status, 503);
        assert.strictEqual((await h.api('registration/verify', nextProof)).status, 409);
        await require('../src/services/identity/revocation-worker').processOne({ admin: h.admin, keycloakOnly: true });
        const result = await h.api('registration/verify', nextProof);
        assert.strictEqual(result.status, 200, JSON.stringify(result.body));
        assert.strictEqual(Identity.actor(result.body.user_id).memberships.length, 1);
        assert.strictEqual(h.native.length, 1);
        assert.strictEqual(h.native[0].enabled, true);
    }));
    for (const status of [null, 503]) it(`ambiguous native password mutation (${status || 'transport timeout'}) retains the durable barrier even after compensation`, async () => harness(async h => {
        const started = await h.start();
        const proof = { verification_id: started.body.verification_id, code: h.code() };
        let lateWrite;
        h.setHook(async request => {
            if (request.url.endsWith('/reset-password')) {
                lateWrite = () => { h.native[0].password = request.data.value; };
                throw status ? { response: { status } } : Object.assign(new Error('synthetic remote write continues after timeout'), { code: 'ECONNABORTED' });
            }
        });
        assert.strictEqual((await h.api('registration/verify', proof)).status, 503);
        assert.ok(DB.get('SELECT leaseToken FROM ava_invitations').leaseToken);
        h.setHook(async () => {});
        await require('../src/services/identity/revocation-worker').processOne({ admin: h.admin, keycloakOnly: true });
        assert.strictEqual(DB.get('SELECT state FROM ava_identity_outbox').state, 'done');
        assert.strictEqual((await h.api('registration/verify', { ...proof, password: 'corrected-synthetic-password-123' })).status, 409);
        lateWrite();
        assert.strictEqual((await h.api('registration/verify', proof)).status, 409);
        DB.run('UPDATE ava_self_registrations SET expiresAtMs=0');
        DB.run('UPDATE ava_invitations SET leasedUntil=0');
        const replacement = await h.start({ password: 'replacement-synthetic-password-123' });
        assert.strictEqual((await h.api('registration/verify', { verification_id: replacement.body.verification_id, code: h.code() })).status, 409);
        assert.strictEqual(DB.get('SELECT enabled FROM ava_users').enabled, 0);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 0);
    }));
    it('worker commit already includes exactly one business even if CRM response is lost until after proof expiry', async () => harness(async h => {
        const started = await h.start();
        const token = started.body.verification_id, code = h.code();
        // Stop at the real HTTP worker commit before the CRM can reconcile;
        // verify the durable business exists at that exact crash boundary.
        const original = axios.post;
        axios.post = async (...args) => {
            await original(...args);
            assert.strictEqual(DB.get('SELECT state FROM ava_self_registrations').state, 'completed');
            assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 1);
            DB.run('UPDATE ava_self_registrations SET expiresAtMs=0');
            throw new Error('synthetic CRM response lost after worker commit');
        };
        try {
            const result = await h.api('registration/verify', { verification_id: token, code });
            assert.strictEqual(result.status, 200);
        } finally { axios.post = original; }
        const userId = DB.get('SELECT userId FROM ava_self_registrations').userId;
        assert.strictEqual(DB.get('SELECT state FROM ava_self_registrations').state, 'completed');
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 1);
        assert.strictEqual(Identity.actor(userId).memberships.length, 1);
        assert.strictEqual((await h.api('registration/verify', { verification_id: token, code })).status, 400);
        assert.ok(Identity.session(Identity.createSession(h.native[0].id, 'after-crash')));
    }));
    it('proof expiry after native enable compensates both native and local access and scrubs secrets', async () => harness(async h => {
        const started = await h.start();
        h.setHook(async request => {
            if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/users/native-1')) DB.run('UPDATE ava_self_registrations SET expiresAtMs=0');
        });
        assert.strictEqual((await h.api('registration/verify', { verification_id: started.body.verification_id, code: h.code() })).status, 503);
        assert.strictEqual(DB.get('SELECT enabled FROM ava_users').enabled, 0);
        await require('../src/services/identity/revocation-worker').processOne({ admin: h.admin, keycloakOnly: true });
        assert.strictEqual(h.native[0].enabled, false);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM ava_identity_outbox').n, 1);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 0);
        assert.strictEqual(DB.get('SELECT passwordEncrypted FROM ava_self_registrations').passwordEncrypted, '');
    }));
    it('registration limits and proof survive reopening the durable SQLite connection', async () => harness(async h => {
        const started = await h.start();
        const Database = require('better-sqlite3');
        const reopened = new Database(h.db.serialize());
        DB.db = reopened;
        try {
            for (let attempt = 0; attempt < 4; attempt++) assert.strictEqual((await h.start()).status, 429);
            assert.strictEqual((await h.start()).status, 429);
            assert.strictEqual((await h.api('registration/verify', { verification_id: started.body.verification_id, code: h.code() })).status, 200);
        } finally { DB.db = h.db; reopened.close(); }
    }));
    it('restores exact challenge state, rotates old codes on resend, and expires without extending access', async () => harness(async h => {
        const started = await h.start(), id = started.body.verification_id, oldCode = h.code();
        let state = await h.api('registration/status', { verification_id: id });
        assert.strictEqual(state.body.status, 'verification_requested');
        assert.ok(state.body.expires_in_ms > 0 && state.body.resend_after_ms > 0);
        assert.ok(!JSON.stringify(state.body).includes(oldCode));
        DB.run('UPDATE ava_self_registrations SET resendAfterMs=0');
        assert.strictEqual((await h.api('registration/resend', { verification_id: id })).body.verification_id, id);
        assert.strictEqual((await h.api('registration/verify', { verification_id: id, code: oldCode })).body.error_code, 'INVALID_VERIFICATION_CODE');
        DB.run('UPDATE ava_self_registrations SET expiresAtMs=0');
        state = await h.api('registration/status', { verification_id: id });
        assert.strictEqual(state.body.status, 'expired');
        assert.strictEqual(state.body.expires_in_ms, 0);
        assert.strictEqual((await h.api('registration/resend', { verification_id: id })).body.error_code, 'VERIFICATION_CODE_EXPIRED');
    }));
    it('mailer HTML escapes client names and keeps plaintext readable', async () => harness(async h => {
        const name = '<a href="https://example.invalid/qa">QA & name</a>';
        assert.strictEqual((await h.start({ displayName: name })).status, 200);
        assert.ok(!h.emails[0].html.includes('<a href='));
        assert.ok(h.emails[0].html.includes('&lt;a href=&quot;https://example.invalid/qa&quot;&gt;QA &amp; name&lt;/a&gt;'));
        assert.ok(h.emails[0].text.includes(name));
    }));
    it('same-origin and feature gate reject before SMTP, worker, or account creation; recovery remains generic during provider outage', async () => harness(async h => {
        assert.strictEqual((await h.start()).status, 200);
        const cross = await h.api('registration/start', { email: 'another@example.test' }, { Origin: 'https://foreign.example.test' });
        assert.strictEqual(cross.status, 403);
        process.env.AVA_SELF_REGISTRATION_ENABLED = 'false';
        assert.strictEqual((await h.start({ email: 'other@example.test' })).status, 503);
        const missing = await h.api('password/recovery', { email: 'unknown@example.test' });
        const known = await h.api('password/recovery', { email: 'new-owner@example.test' });
        assert.strictEqual(missing.status, 202);
        assert.deepStrictEqual(missing.body, known.body);
        assert.strictEqual(h.native.length, 0);
    }));
});
