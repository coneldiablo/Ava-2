'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Recovery = require('../src/services/identity/password-recovery.service');
const { KeycloakAdmin } = require('../src/services/identity/keycloak-admin');
const UNKNOWN = 'IDENTITY_RECOVERY_OUTCOME_UNKNOWN';
async function fixture(run) {
    const vars = { AVA_PROCESS_ROLE: 'provisioning-worker', AVA_OIDC_ISSUER: 'https://identity.example.test/realms/ava',
        WHATSAPP_CRM_PUBLIC_URL: 'https://ava.example.test', AVA_OIDC_CLIENT_ID: 'ava-web',
        SESSION_SECRET: 'customer-completion-auth-fixture-secret-at-least-32', AVA_PASSWORD_RECOVERY_NO_REDIRECT: 'false' };
    const previous = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
    Object.assign(process.env, vars); createTestDB();
    try {
        const invitation = Identity.createInvitation({ platformRole: 'platform_admin', userId: 'fixture-operator' }, { email: 'recovery@example.test' });
        const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), 'fixture-native');
        Recovery.request({ email: user.email, rateLimitKey: 'fixture-source' });
        await run(user);
    } finally {
        DB.db.close();
        for (const k of Object.keys(vars)) if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k];
    }
}
function adapter(user, failure, onSend) {
    const native = { id: user.subject, username: `ava-${user.userId}`, email: user.email,
        enabled: true, emailVerified: true, attributes: { avaUserId: [user.userId] } };
    return new KeycloakAdmin({ request: async req => {
        if (req.url.endsWith('/token')) return { data: { access_token: 'fixture', expires_in: 300 } };
        if (req.url.includes('/execute-actions-email')) { onSend(req); throw failure; }
        return { data: req.url.includes('/users?email=') ? [native] : native };
    } });
}
describe('Customer completion auth recovery unknown dispatch fence', () => {
    for (const failure of [{ code: 'ETIMEDOUT' }, { response: { status: 503 } }, { response: { status: 408 } }]) {
        it(`does not retry an ambiguous native email (${failure.code || failure.response.status})`, () => fixture(async user => {
            let sends = 0;
            const admin = adapter(user, failure, req => { assert.strictEqual(req.method, 'PUT'); sends++; });
            await Recovery.processOne({ admin });
            const job = DB.get('SELECT * FROM ava_password_recovery_jobs');
            assert.strictEqual(job.state, 'failed'); assert.strictEqual(job.lastErrorCode, UNKNOWN);
            DB.run('UPDATE ava_password_recovery_jobs SET nextAttemptAt=0');
            assert.strictEqual(await Recovery.processOne({ admin }), false);
            assert.strictEqual(sends, 1);
            DB.run('UPDATE ava_password_recovery_limits SET lastRequestAt=0');
            Recovery.request({ email: user.email, rateLimitKey: 'another-source' });
            assert.strictEqual(DB.get('SELECT COUNT(*) n FROM ava_password_recovery_jobs').n, 1);
        }));
    }
    it('fences stale sending leases across restart and preserves them past ordinary cleanup', () => fixture(async user => {
        DB.run("UPDATE ava_password_recovery_jobs SET state='sending',leaseToken='interrupted',leasedUntil=0,expiresAt=0");
        let sends = 0;
        DB.run('UPDATE ava_password_recovery_limits SET lastRequestAt=0');
        Recovery.request({ email: user.email, rateLimitKey: 'before-restart' });
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM ava_password_recovery_jobs').n, 1);
        delete require.cache[require.resolve('../src/services/identity/password-recovery.service')];
        const restarted = require('../src/services/identity/password-recovery.service');
        assert.strictEqual(await restarted.processOne({ admin: { sendPasswordRecovery: async () => { sends++; } } }), false);
        assert.strictEqual(DB.get('SELECT lastErrorCode FROM ava_password_recovery_jobs').lastErrorCode, UNKNOWN);
        DB.run('UPDATE ava_password_recovery_limits SET lastRequestAt=0');
        restarted.request({ email: user.email, rateLimitKey: 'restart-source' });
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM ava_password_recovery_jobs').n, 1);
        assert.strictEqual(sends, 0);
    }));
    for (const readFailure of [{ code: 'ETIMEDOUT' }, { response: { status: 408 } }]) {
    it(`still retries a provider read outage before email dispatch (${readFailure.code || readFailure.response.status})`, () => fixture(async () => {
        let reads = 0, sends = 0;
        const admin = new KeycloakAdmin({ request: async req => {
            if (req.url.endsWith('/token')) return { data: { access_token: 'fixture', expires_in: 300 } };
            if (req.url.includes('/execute-actions-email')) sends++;
            reads++; throw readFailure;
        } });
        await Recovery.processOne({ admin });
        assert.strictEqual(DB.get('SELECT state FROM ava_password_recovery_jobs').state, 'pending');
        DB.run('UPDATE ava_password_recovery_jobs SET nextAttemptAt=0');
        await Recovery.processOne({ admin });
        assert.strictEqual(reads, 2); assert.strictEqual(sends, 0);
    }));
    }
});
