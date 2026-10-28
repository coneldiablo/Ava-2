const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Recovery = require('../src/services/identity/password-recovery.service');
const { KeycloakAdmin } = require('../src/services/identity/keycloak-admin');
const platform = { userId: 'fixture-operator', platformRole: 'platform_admin' };
async function environment(fn) {
    const values = { AVA_PROCESS_ROLE: 'provisioning-worker', AVA_OIDC_ISSUER: 'https://identity.example.test/realms/ava',
        WHATSAPP_CRM_PUBLIC_URL: 'https://ava.example.test', AVA_OIDC_CLIENT_ID: 'ava-web',
        SESSION_SECRET: 'fixture-secret-for-recovery-at-least-32-characters', AVA_PASSWORD_RECOVERY_NO_REDIRECT: 'false' };
    const keys = [...Object.keys(values), 'AVA_IDENTITY_ADMIN_ORIGIN'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, values); delete process.env.AVA_IDENTITY_ADMIN_ORIGIN;
    createTestDB();
    try { await fn(); } finally { for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
}
function enrolled(email = 'owner@example.test', subject = 'native-owner') {
    const invite = Identity.createInvitation(platform, { email });
    return Identity.completeInvitation(Identity.claimInvitation(invite.token), subject);
}
function fixture(user, { nativePatch = {}, duplicates = false, onToken = () => {}, onSend = () => {} } = {}) {
    const calls = [], native = { id: user.subject, username: `ava-${user.userId}`, email: user.email,
        enabled: true, emailVerified: true, attributes: { avaUserId: [user.userId] }, ...nativePatch };
    const admin = new KeycloakAdmin({ request: async request => {
        calls.push(request);
        if (request.url.endsWith('/token')) { onToken(); return { data: { access_token: 'fixture', expires_in: 300 } }; }
        if (request.url.includes('/execute-actions-email')) { onSend(); return { data: null }; }
        if (request.url.includes('/users?email=')) return { data: duplicates ? [native, { ...native, id: 'foreign' }] : [native] };
        return { data: native };
    } });
    return { admin, calls, sends: () => calls.filter(call => call.url.includes('/execute-actions-email')) };
}
describe('Keycloak password recovery exact identity and durable abuse fences', () => {
    it('returns the same result for missing, malformed, disabled and enrolled users; stores no reset password or public proof', () => environment(async () => {
        const user = enrolled();
        const accepted = Recovery.request({ email: user.email, rateLimitKey: 'fixture-ip' });
        for (const email of ['missing@example.test', 'invalid', null]) assert.deepStrictEqual(Recovery.request({ email, rateLimitKey: 'fixture-ip' }), accepted);
        DB.run('UPDATE ava_users SET enabled=0 WHERE id=?', [user.userId]);
        assert.deepStrictEqual(Recovery.request({ email: user.email, rateLimitKey: 'fixture-ip-2' }), accepted);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM ava_password_recovery_jobs').n, 1);
        const row = DB.get('SELECT * FROM ava_password_recovery_jobs');
        assert.strictEqual(row.subject, user.subject);
        assert.ok(!Object.keys(row).some(key => /password|tokenHash/.test(key)));
        assert.ok(DB.all('SELECT keyHash FROM ava_password_recovery_limits').every(row => /^[a-f\d]{64}$/.test(row.keyHash)));
    }));
    it('queues exact enabled verified identity and sends only UPDATE_PASSWORD with fixed trusted return URL and ten minute lifespan', () => environment(async () => {
        const user = enrolled(), test = fixture(user);
        const existingSession = Identity.createSession(user.subject, 'existing-native-session');
        Recovery.request({ email: user.email.toUpperCase(), rateLimitKey: 'fixture-ip' });
        assert.strictEqual(await Recovery.processOne({ admin: test.admin }), true);
        assert.strictEqual(await Recovery.processOne({ admin: test.admin }), false);
        const send = test.sends()[0], url = new URL(send.url);
        assert.strictEqual(test.sends().length, 1);
        assert.strictEqual(send.method, 'PUT'); assert.deepStrictEqual(send.data, ['UPDATE_PASSWORD']);
        assert.strictEqual(url.searchParams.get('client_id'), 'ava-web');
        assert.strictEqual(url.searchParams.get('redirect_uri'), 'https://ava.example.test/api/auth/sso/start');
        assert.strictEqual(url.searchParams.get('lifespan'), '600');
        assert.ok(test.calls.every(call => !call.url.includes('/reset-password') && !(call.method === 'PUT' && !call.url.includes('/execute-actions-email'))));
        assert.strictEqual(DB.get('SELECT state FROM ava_password_recovery_jobs').state, 'done');
        assert.ok(Identity.session(existingSession), 'email request/delivery must not provide a victim logout primitive');
        const session = DB.get('SELECT expiresAt FROM ava_sessions');
        assert.ok(session.expiresAt <= Date.now() + 3600000, 'existing AVA session retains its one-hour maximum TTL');
        Identity.backchannelLogout({ sid: 'existing-native-session', jti: 'verified-event-fixture' });
        assert.strictEqual(Identity.session(existingSession), null, 'trusted native logout receipt remains the invalidation boundary');
    }));
    it('operator no-redirect mode omits both optional parameters and preserves the generic response, exact identity and native action', () => environment(async () => {
        process.env.AVA_PASSWORD_RECOVERY_NO_REDIRECT = 'true';
        delete process.env.AVA_OIDC_CLIENT_ID;
        delete process.env.WHATSAPP_CRM_PUBLIC_URL;
        const user = enrolled(), test = fixture(user);
        const session = Identity.createSession(user.subject, 'fallback-existing-session');
        const accepted = Recovery.request({ email: user.email, rateLimitKey: 'fixture-ip', client_id: 'foreign', redirect_uri: 'https://foreign.invalid' });
        assert.deepStrictEqual(accepted, Recovery.request({ email: 'missing@example.test', rateLimitKey: 'fixture-ip' }));
        assert.strictEqual(await Recovery.processOne({ admin: test.admin }), true);
        const sends = test.sends();
        assert.strictEqual(sends.length, 1);
        assert.strictEqual(sends[0].method, 'PUT');
        assert.deepStrictEqual(sends[0].data, ['UPDATE_PASSWORD']);
        assert.deepStrictEqual([...new URL(sends[0].url).searchParams], [['lifespan', '600']]);
        assert.ok(!test.calls.some(call => /\/clients|\/reset-password/.test(call.url)));
        assert.strictEqual(DB.get('SELECT state FROM ava_password_recovery_jobs').state, 'done');
        assert.ok(Identity.session(session));
    }));
    it('no-redirect is explicit operator configuration and never an automatic retry after native rejection', () => environment(async () => {
        const user = enrolled(), test = fixture(user);
        const original = test.admin.request;
        test.admin.request = async request => {
            if (request.url.includes('/execute-actions-email')) {
                test.calls.push(request);
                throw { response: { status: 400 } };
            }
            return original(request);
        };
        await assert.rejects(test.admin.sendPasswordRecovery({ ...user, no_redirect: true }, () => {}), { code: 'IDENTITY_PROVIDER_UNAVAILABLE' });
        assert.strictEqual(test.sends().length, 1);
        assert.strictEqual(new URL(test.sends()[0].url).searchParams.get('client_id'), 'ava-web');
        assert.strictEqual(new URL(test.sends()[0].url).searchParams.get('redirect_uri'), 'https://ava.example.test/api/auth/sso/start');
    }));
    it('no-redirect mode rechecks the exact binding after 401 refresh before redispatch', () => environment(async () => {
        process.env.AVA_PASSWORD_RECOVERY_NO_REDIRECT = 'true';
        const user = enrolled(), test = fixture(user);
        Recovery.request({ email: user.email, rateLimitKey: 'fixture-ip' });
        let tokens = 0, sends = 0;
        const original = test.admin.request;
        test.admin.request = async request => {
            if (request.url.endsWith('/token') && ++tokens === 2) DB.run('UPDATE ava_users SET subject=? WHERE id=?', ['foreign', user.userId]);
            if (request.url.includes('/execute-actions-email')) {
                sends++;
                assert.deepStrictEqual([...new URL(request.url).searchParams], [['lifespan', '600']]);
                throw { response: { status: 401 } };
            }
            return original(request);
        };
        await Recovery.processOne({ admin: test.admin });
        assert.strictEqual(sends, 1);
        assert.strictEqual(DB.get('SELECT state FROM ava_password_recovery_jobs').state, 'failed');
    }));
    for (const mode of ['false', 'true']) it(`refuses unverified, disabled, foreign native mapping or duplicate native email with no mutation (no-redirect=${mode})`, () => environment(async () => {
        process.env.AVA_PASSWORD_RECOVERY_NO_REDIRECT = mode;
        const user = enrolled();
        for (const options of [{ nativePatch: { emailVerified: false } }, { nativePatch: { enabled: false } },
            { nativePatch: { attributes: { avaUserId: ['foreign'] } } }, { nativePatch: { id: 'foreign' } },
            { nativePatch: { email: 'foreign@example.test' } }, { duplicates: true }]) {
            const test = fixture(user, options);
            await assert.rejects(test.admin.sendPasswordRecovery(user, () => {}), { code: 'IDENTITY_RECOVERY_TARGET_INVALID' });
            assert.strictEqual(test.sends().length, 0);
        }
    }));
    it('durable email cooldown survives reload, hourly email and source limits are independent of account existence', () => environment(async () => {
        const user = enrolled(); Recovery.request({ email: user.email, rateLimitKey: 'ip-one' });
        delete require.cache[require.resolve('../src/services/identity/password-recovery.service')];
        const reloaded = require('../src/services/identity/password-recovery.service');
        reloaded.request({ email: user.email, rateLimitKey: 'ip-two' });
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM ava_password_recovery_jobs').n, 1);
        assert.strictEqual(DB.get('SELECT MAX(count) n FROM ava_password_recovery_limits').n, 1);
        DB.run("UPDATE ava_password_recovery_jobs SET state='done'");
        for (let n = 0; n < 5; n++) {
            DB.run('UPDATE ava_password_recovery_limits SET lastRequestAt=0');
            reloaded.request({ email: user.email, rateLimitKey: `ip-${n}` });
            DB.run("UPDATE ava_password_recovery_jobs SET state='done'");
        }
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM ava_password_recovery_jobs').n, 3);
        for (let n = 0; n < 25; n++) reloaded.request({ email: `missing-${n}@example.test`, rateLimitKey: 'same-source' });
        assert.strictEqual(DB.get('SELECT MAX(count) n FROM ava_password_recovery_limits').n, 20);
    }));
    it('provider outage stays generic and retries durably with bounded attempts and expiry', () => environment(async () => {
        const user = enrolled(); const response = Recovery.request({ email: user.email, rateLimitKey: 'fixture-ip' });
        const offline = { sendPasswordRecovery: async () => { throw Object.assign(new Error('private provider detail'), { code: 'IDENTITY_PROVIDER_UNAVAILABLE' }); } };
        for (let n = 0; n < 3; n++) {
            DB.run('UPDATE ava_password_recovery_jobs SET nextAttemptAt=0');
            await Recovery.processOne({ admin: offline });
        }
        const row = DB.get('SELECT * FROM ava_password_recovery_jobs');
        assert.strictEqual(row.state, 'failed'); assert.strictEqual(row.attempts, 3);
        assert.strictEqual(JSON.stringify(row).includes('private provider detail'), false);
        assert.deepStrictEqual(response, Recovery.request({ email: 'missing@example.test', rateLimitKey: 'fixture-ip' }));
    }));
    it('rejects expired tasks and changes to AVA binding after queueing or token acquisition', () => environment(async () => {
        const user = enrolled(); Recovery.request({ email: user.email, rateLimitKey: 'fixture-ip' });
        const test = fixture(user, { onToken: () => DB.run('UPDATE ava_users SET enabled=0 WHERE id=?', [user.userId]) });
        await Recovery.processOne({ admin: test.admin }); assert.strictEqual(test.sends().length, 0);
        assert.strictEqual(DB.get('SELECT state FROM ava_password_recovery_jobs').state, 'failed');
        DB.run('UPDATE ava_users SET enabled=1 WHERE id=?', [user.userId]);
        DB.run('UPDATE ava_password_recovery_limits SET lastRequestAt=0');
        Recovery.request({ email: user.email, rateLimitKey: 'fixture-ip-2' });
        DB.run('UPDATE ava_password_recovery_jobs SET expiresAt=0');
        assert.strictEqual(await Recovery.processOne({ admin: fixture(user).admin }), false);
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM ava_password_recovery_jobs WHERE state='failed'").n, 2);
    }));
    it('revalidates recovery lease after 401 token refresh before issuing any email', () => environment(async () => {
        const user = enrolled(); Recovery.request({ email: user.email, rateLimitKey: 'fixture-ip' });
        const test = fixture(user); let refresh = 0, sendAttempts = 0;
        const original = test.admin.request;
        test.admin.request = async request => {
            if (request.url.endsWith('/token') && ++refresh === 2) DB.run('UPDATE ava_users SET subject=? WHERE id=?', ['foreign', user.userId]);
            if (request.url.includes('/execute-actions-email')) { sendAttempts++; throw { response: { status: 401 } }; }
            return original(request);
        };
        await Recovery.processOne({ admin: test.admin });
        assert.strictEqual(sendAttempts, 1, 'second dispatch refused after refresh changes binding');
        assert.strictEqual(DB.get('SELECT state FROM ava_password_recovery_jobs').state, 'failed');
    }));
    it('recovery worker rejects web process and client/redirect configuration cannot come from public payload', () => environment(async () => {
        const user = enrolled(), test = fixture(user);
        process.env.AVA_PROCESS_ROLE = 'web';
        await assert.rejects(Recovery.processOne({ admin: test.admin }), { code: 'IDENTITY_WORKER_REQUIRED' });
        process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test/?redirect=foreign';
        await assert.rejects(test.admin.sendPasswordRecovery(user, () => {}), { code: 'PUBLIC_URL_INVALID' });
        assert.strictEqual(test.sends().length, 0);
    }));
    it('concurrent recovery drains lease a job once and stop a lease lost during token acquisition', () => environment(async () => {
        const user = enrolled(); Recovery.request({ email: user.email, rateLimitKey: 'fixture-ip' });
        let release, sends = 0;
        const waiting = new Promise(resolve => { release = resolve; });
        const first = Recovery.processOne({ admin: { sendPasswordRecovery: async (_target, assertLease) => {
            sends++; await waiting; assertLease();
        } } });
        assert.strictEqual(await Recovery.processOne({ admin: { sendPasswordRecovery: async () => { sends++; } } }), false);
        release(); await first; assert.strictEqual(sends, 1);
        DB.run('UPDATE ava_password_recovery_limits SET lastRequestAt=0');
        Recovery.request({ email: user.email, rateLimitKey: 'fixture-ip-2' });
        const test = fixture(user, { onToken: () => DB.run("UPDATE ava_password_recovery_jobs SET leaseToken='foreign-lease' WHERE state='sending'") });
        await Recovery.processOne({ admin: test.admin }); assert.strictEqual(test.sends().length, 0);
    }));
    it('enrollment refuses any other native email owner, including disabled accounts, before creating or writing passwords', () => environment(async () => {
        const invitation = Identity.createInvitation(platform, { email: 'owner@example.test' });
        const mutations = [];
        const admin = new KeycloakAdmin({ request: async request => {
            if (request.url.endsWith('/token')) return { data: { access_token: 'fixture', expires_in: 300 } };
            if (request.url.includes('/users?username=')) return { data: [] };
            if (request.url.includes('/users?email=')) return { data: [{ id: 'foreign-disabled', email: 'owner@example.test', enabled: false }] };
            mutations.push(request); return { data: null };
        } });
        await assert.rejects(admin.redeem(invitation.token, 'fixture-password-long'), { code: 'IDENTITY_NATIVE_EMAIL_CONFLICT' });
        assert.strictEqual(mutations.length, 0);
        assert.strictEqual(DB.get('SELECT enabled,subject FROM ava_users').enabled, 0);
        assert.strictEqual(DB.get('SELECT enabled,subject FROM ava_users').subject, null);
    }));
});
