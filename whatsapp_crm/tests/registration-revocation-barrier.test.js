'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Registration = require('../src/services/identity/self-registration.service');
const Mailer = require('../src/services/identity/system-mailer.service');
const Revocations = require('../src/services/identity/revocation-worker');
const { KeycloakAdmin } = require('../src/services/identity/keycloak-admin');

async function fixture(fn) {
    const values = { AVA_PROCESS_ROLE: 'provisioning-worker', AVA_CUSTOMER_ACCESS_ENABLED: 'true',
        AVA_SELF_REGISTRATION_ENABLED: 'true', SESSION_SECRET: 'synthetic-revocation-barrier-secret-only',
        AVA_OIDC_ISSUER: 'https://identity.example.test/realms/ava' };
    const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
    const previousSend = Mailer.sendVerificationCodeEmail;
    Object.assign(process.env, values);
    const db = createTestDB();
    let code, native, rejectPassword = true;
    Mailer.sendVerificationCodeEmail = async message => { code = message.code; };
    const admin = new KeycloakAdmin({ request: async ({ method, url, data }) => {
        const parsed = new URL(url), path = parsed.pathname.replace('/admin/realms/ava', '');
        if (url.endsWith('/token')) return { data: { access_token: 'synthetic-admin-token', expires_in: 300 } };
        if (method === 'GET' && path === '/users') return { data: native ? [structuredClone(native)] : [] };
        if (method === 'POST' && path === '/users') {
            native = { ...structuredClone(data), id: 'synthetic-native-subject' };
            return { data: null };
        }
        if (method === 'GET' && path.endsWith('/sessions')) return { data: [] };
        if (method === 'GET') return { data: structuredClone(native) };
        if (path.endsWith('/reset-password')) {
            if (rejectPassword) throw { response: { status: 400, data: { errorMessage: 'invalidPasswordHistoryMessage' } } };
        } else if (method === 'PUT') Object.assign(native, structuredClone(data));
        return { data: null };
    } });
    const redeem = async (token, password) => {
        try { return await admin.redeem(token, password); }
        catch (error) {
            if (error.code === 'PASSWORD_POLICY') throw { response: { data: { error: 'PASSWORD_POLICY' } } };
            throw error;
        }
    };
    try {
        const started = await Registration.start({ email: 'barrier-owner@example.test', displayName: 'Owner',
            businessName: 'Barrier business', password: 'synthetic-password-123' }, 'synthetic-source');
        const proof = { verification_id: started.verification_id, code };
        await assert.rejects(Registration.verify(proof, { redeem }), { code: 'PASSWORD_POLICY' });
        rejectPassword = false;
        const retry = () => Registration.verify({ ...proof, password: 'corrected-synthetic-password-123' }, { redeem });
        await fn({ admin, retry, native: () => native });
    } finally {
        Mailer.sendVerificationCodeEmail = previousSend;
        db.close();
        for (const name of Object.keys(values)) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    }
}

describe('Registration native revocation durable barriers (synthetic provider)', () => {
    it('an expired paused disable cannot be stolen or race replacement enrollment', async () => fixture(async h => {
        let entered, release, paused = false;
        const begun = new Promise(resolve => { entered = resolve; });
        const waiting = new Promise(resolve => { release = resolve; });
        const pausingAdmin = { call: async (method, path, data) => {
            if (!paused && method === 'PUT' && data?.enabled === false) {
                paused = true; entered(); await waiting;
            }
            return h.admin.call(method, path, data);
        } };
        const old = Revocations.processOne({ admin: pausingAdmin, keycloakOnly: true });
        await begun;
        try {
            const original = DB.get('SELECT leaseToken FROM ava_identity_outbox').leaseToken;
            DB.run('UPDATE ava_identity_outbox SET leasedUntil=0');
            assert.strictEqual(await Revocations.processOne({ admin: h.admin, keycloakOnly: true }), false);
            assert.strictEqual(DB.get('SELECT leaseToken FROM ava_identity_outbox').leaseToken, original);
            await assert.rejects(h.retry(), { code: 'REGISTRATION_RETRY_PENDING' });
        } finally { release(); await old; }
        assert.strictEqual(DB.get('SELECT state FROM ava_identity_outbox').state, 'pending');
        DB.run('UPDATE ava_identity_outbox SET nextAttemptAt=0');
        assert.strictEqual(await Revocations.processOne({ admin: h.admin, keycloakOnly: true }), true);
        const completed = await h.retry();
        assert.strictEqual(completed.status, 'completed');
        assert.strictEqual(h.native().enabled, true);
        assert.strictEqual(DB.get('SELECT enabled FROM ava_users').enabled, 1);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 1);
    }));

    for (const mutation of ['PUT', 'POST']) it(`ambiguous native ${mutation} retains its registration barrier after the invocation returns`, async () => fixture(async h => {
        let lateMutation;
        const ambiguousAdmin = { call: async (method, path, data) => {
            if (method === mutation) {
                lateMutation = () => h.admin.call(method, path, data);
                throw Object.assign(new Error('synthetic remote mutation outcome unknown'),
                    { code: 'IDENTITY_PROVIDER_UNAVAILABLE', nativeMutationAmbiguous: true });
            }
            return h.admin.call(method, path, data);
        } };
        assert.strictEqual(await Revocations.processOne({ admin: ambiguousAdmin, keycloakOnly: true }), true);
        const held = DB.get('SELECT * FROM ava_identity_outbox');
        assert.strictEqual(held.state, 'leased');
        assert.ok(held.leaseToken);
        assert.strictEqual(held.lastErrorCode, 'IDENTITY_REVOCATION_RECONCILIATION_REQUIRED');
        DB.run('UPDATE ava_identity_outbox SET leasedUntil=0,nextAttemptAt=0');
        assert.strictEqual(await Revocations.processOne({ admin: h.admin, keycloakOnly: true }), false);
        await assert.rejects(h.retry(), { code: 'REGISTRATION_RETRY_PENDING' });
        await lateMutation();
        assert.strictEqual(DB.get('SELECT state FROM ava_identity_outbox').state, 'leased');
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM instances').n, 0);
        assert.strictEqual(DB.get('SELECT enabled FROM ava_users').enabled, 0);
    }));

    it('preserves automatic expired lease recovery and transport retries for non-registration identities', async () => fixture(async h => {
        DB.run("UPDATE ava_invitations SET createdBy='legacy-operator'");
        const first = Revocations.lease();
        DB.run('UPDATE ava_identity_outbox SET leasedUntil=0');
        const replacement = Revocations.lease();
        assert.notStrictEqual(replacement.leaseToken, first.leaseToken);
        DB.run("UPDATE ava_identity_outbox SET state='pending',leaseToken=NULL,leasedUntil=NULL,nextAttemptAt=0");
        await Revocations.processOne({ admin: { call: async (method, path, data) => {
            if (method === 'PUT') throw Object.assign(new Error('synthetic timeout'),
                { code: 'IDENTITY_PROVIDER_UNAVAILABLE', nativeMutationAmbiguous: true });
            return h.admin.call(method, path, data);
        } }, keycloakOnly: true });
        const pending = DB.get('SELECT * FROM ava_identity_outbox');
        assert.strictEqual(pending.state, 'pending');
        assert.strictEqual(pending.leaseToken, null);
        assert.strictEqual(pending.lastErrorCode, 'IDENTITY_PROVIDER_UNAVAILABLE');
    }));
});
