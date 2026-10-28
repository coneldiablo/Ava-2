'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const { KeycloakAdmin } = require('../src/services/identity/keycloak-admin');
const { reconcile } = require('../src/services/identity/team-email-reconciliation');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

async function environment(fn) {
    const env = { AVA_PROCESS_ROLE: 'provisioning-worker', AVA_OIDC_ISSUER: 'https://identity.example.test/realms/ava', AVA_IDENTITY_ADMIN_ORIGIN: undefined };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    createTestDB(); Identity.ensureSchema();
    const now = Date.now();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Fixture business')");
    DB.run("INSERT INTO ava_users(id,subject,email,enabled) VALUES ('staff','native-staff','staff@example.test',1)");
    DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES ('staff',1,'manager')");
    DB.run("INSERT INTO ava_invitations(id,tokenHash,userId,businessId,role,expiresAt,state,createdBy,acceptanceMode) VALUES ('invite',?,'staff',1,'manager',?,'consumed','fixture','team')", ['a'.repeat(64), now - 1000]);
    DB.run("INSERT INTO ava_team_email_verifications(id,invitationId,invitationTokenHash,email,passwordEncrypted,codeHash,resendAfterMs,expiresAtMs,createdAtMs,verifiedAtMs,completedAtMs) VALUES ('proof','invite',?,'staff@example.test','','fixture',?,?,?,?,?)", ['a'.repeat(64), now - 15000, now - 2000, now - 15000, now - 10000, now - 5000]);
    try { await fn(); } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
function provider({ nativePatch = {}, duplicate = false, onRequest = () => {}, failPut = false, readbackPatch = null } = {}) {
    const calls = [];
    let written = false;
    const native = { id: 'native-staff', username: 'ava-staff', email: 'staff@example.test', enabled: true,
        emailVerified: false, requiredActions: ['UPDATE_PASSWORD', 'VERIFY_EMAIL', 'CONFIGURE_TOTP'], attributes: { avaUserId: ['staff'] }, ...nativePatch };
    const admin = new KeycloakAdmin({ request: async request => {
        calls.push(request); onRequest(request, native);
        if (request.url.endsWith('/token')) return { data: { access_token: 'fixture', expires_in: 300 } };
        if (request.method === 'PUT') {
            if (failPut) throw { response: { status: 401 } };
            Object.assign(native, request.data); written = true; return { data: null };
        }
        const value = { ...native, ...(written ? readbackPatch : null) };
        if (request.url.includes('/users?')) return { data: duplicate ? [value, { ...value, id: 'other' }] : [value] };
        return { data: value };
    } });
    return { admin, native, calls, writes: () => calls.filter(call => call.method === 'PUT') };
}
const options = extra => ({ invitationId: 'invite', verificationId: 'proof', ...extra });

describe('Scoped completed staff email reconciliation', () => {
    it('dry-run uses historical valid proof after expiry, makes no mutation, then apply preserves other required actions and is idempotent', () => environment(async () => {
        const test = provider();
        assert.deepStrictEqual(await reconcile(options({ admin: test.admin })), { status: 'repair_required', changed: false, readbackVerified: true });
        assert.strictEqual(test.writes().length, 0);
        assert.deepStrictEqual(await reconcile(options({ admin: test.admin, apply: true })), { status: 'repaired', changed: true, readbackVerified: true });
        assert.deepStrictEqual(test.writes()[0].data, { emailVerified: true, requiredActions: ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'] });
        assert.deepStrictEqual(await reconcile(options({ admin: test.admin, apply: true })), { status: 'already_verified', changed: false, readbackVerified: true });
        assert.strictEqual(test.writes().length, 1);
        assert.ok(test.calls.every(call => !/reset-password|logout|execute-actions-email/.test(call.url)));
        assert.strictEqual(DB.get('SELECT role FROM ava_business_memberships').role, 'manager');
    }));
    for (const [label, sql] of [
        ['revoked invitation', "UPDATE ava_invitations SET state='revoked'"],
        ['non-team invitation', "UPDATE ava_invitations SET acceptanceMode='legacy'"],
        ['missing OTP', 'DELETE FROM ava_team_email_verifications'],
        ['unverified completed OTP', 'UPDATE ava_team_email_verifications SET verifiedAtMs=NULL'],
        ['OTP verified after expiry', 'UPDATE ava_team_email_verifications SET verifiedAtMs=expiresAtMs'],
        ['enrollment after OTP expiry', 'UPDATE ava_team_email_verifications SET completedAtMs=expiresAtMs'],
        ['enrollment after invitation expiry', 'UPDATE ava_invitations SET expiresAt=1'],
        ['wrong token hash', "UPDATE ava_team_email_verifications SET invitationTokenHash='wrong'"],
        ['wrong proof email', "UPDATE ava_team_email_verifications SET email='other@example.test'"],
        ['disabled membership', 'UPDATE ava_business_memberships SET enabled=0'],
        ['role drift', "UPDATE ava_business_memberships SET role='observer'"],
        ['inactive business', 'UPDATE instances SET isActive=0'],
        ['disabled user', 'UPDATE ava_users SET enabled=0'],
        ['missing subject', 'UPDATE ava_users SET subject=NULL'],
        ['duplicate local email', "INSERT INTO ava_users(id,email) VALUES ('duplicate','STAFF@example.test')"],
        ['pending revocation', "INSERT INTO ava_identity_outbox(id,userId,action,nextAttemptAt) VALUES ('revoke','staff','revoke_sessions',0)"],
    ]) it(`fails closed for ${label} before provider access`, () => environment(async () => {
        DB.run(sql); const test = provider();
        await assert.rejects(reconcile(options({ admin: test.admin, apply: true })), { code: 'TEAM_EMAIL_RECONCILIATION_PROOF_INVALID' });
        assert.strictEqual(test.calls.length, 0);
    }));
    for (const nativePatch of [{ id: 'foreign' }, { username: 'other' }, { email: 'foreign@example.test' },
        { attributes: { avaUserId: ['staff', 'other'] } }, { enabled: false }, { requiredActions: null }]) {
        it(`rejects native mapping conflict ${Object.keys(nativePatch)[0]}`, () => environment(async () => {
            const test = provider({ nativePatch });
            await assert.rejects(reconcile(options({ admin: test.admin, apply: true })), { code: 'TEAM_EMAIL_RECONCILIATION_NATIVE_CONFLICT' });
            assert.strictEqual(test.writes().length, 0);
        }));
    }
    it('rejects duplicate native identity and concurrent native requiredAction drift', () => environment(async () => {
        const duplicate = provider({ duplicate: true });
        await assert.rejects(reconcile(options({ admin: duplicate.admin, apply: true })), { code: 'TEAM_EMAIL_RECONCILIATION_NATIVE_CONFLICT' });
        const drift = provider({ onRequest: (request, native) => { if (request.url.includes('/users?username')) native.requiredActions = [...native.requiredActions, 'UPDATE_PROFILE']; } });
        await assert.rejects(reconcile(options({ admin: drift.admin, apply: true })), { code: 'TEAM_EMAIL_RECONCILIATION_NATIVE_CONFLICT' });
        assert.strictEqual(duplicate.writes().length + drift.writes().length, 0);
    }));
    for (const stage of ['token', 'native-read', 'before-put']) it(`rechecks proof across ${stage} awaits`, () => environment(async () => {
        const test = provider({ onRequest: request => {
            const shouldChange = stage === 'token' ? request.url.endsWith('/token')
                : stage === 'native-read' ? request.url.endsWith('/users/native-staff')
                    : request.url.includes('/users?username');
            if (shouldChange) DB.run("UPDATE ava_users SET subject='foreign' WHERE id='staff'");
        } });
        await assert.rejects(reconcile(options({ admin: test.admin, apply: true })));
        assert.strictEqual(test.writes().length, 0);
    }));
    it('401 PUT is not automatically redispatched and failing readback is never success', () => environment(async () => {
        const unauthorized = provider({ failPut: true });
        await assert.rejects(reconcile(options({ admin: unauthorized.admin, apply: true })), { code: 'IDENTITY_PROVIDER_UNAVAILABLE', nativeMutationAmbiguous: true });
        assert.strictEqual(unauthorized.writes().length, 1);
        const broken = provider({ readbackPatch: { requiredActions: ['VERIFY_EMAIL'] } });
        await assert.rejects(reconcile(options({ admin: broken.admin, apply: true })), { code: 'TEAM_EMAIL_RECONCILIATION_READBACK_FAILED', nativeMutationAmbiguous: true });
    }));
    it('rechecks proof after token reacquisition immediately before PUT', () => environment(async () => {
        let tokens = 0, nativeReads = 0;
        const test = provider({ onRequest: request => {
            if (request.url.endsWith('/token') && ++tokens === 2) DB.run('UPDATE ava_business_memberships SET enabled=0');
            if (request.url.endsWith('/users/native-staff') && ++nativeReads === 2) test.admin.cachedToken.expiresAt = 0;
        } });
        await assert.rejects(reconcile(options({ admin: test.admin, apply: true })), { code: 'TEAM_EMAIL_RECONCILIATION_PROOF_INVALID' });
        assert.strictEqual(tokens, 2); assert.strictEqual(test.writes().length, 0);
    }));
    it('rechecks proof on GET 401 refresh before redispatch', () => environment(async () => {
        let tokens = 0, reads = 0;
        const test = provider({ onRequest: request => {
            if (request.url.endsWith('/token') && ++tokens === 2) DB.run('UPDATE ava_team_email_verifications SET verifiedAtMs=NULL');
            if (request.url.endsWith('/users/native-staff') && ++reads === 1) throw { response: { status: 401 } };
        } });
        await assert.rejects(reconcile(options({ admin: test.admin, apply: true })), { code: 'TEAM_EMAIL_RECONCILIATION_PROOF_INVALID' });
        assert.strictEqual(reads, 1); assert.strictEqual(test.writes().length, 0);
    }));
    it('requires worker role and explicit scope', () => environment(async () => {
        await assert.rejects(reconcile(), { code: 'TEAM_EMAIL_RECONCILIATION_SCOPE_REQUIRED' });
        process.env.AVA_PROCESS_ROLE = 'crm';
        await assert.rejects(reconcile(options()), { code: 'IDENTITY_WORKER_REQUIRED' });
    }));
    it('CLI creates private redacted failure receipt without initializing or modifying an empty database', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-email-reconciliation-'));
        const dbPath = path.join(directory, 'fixture.db'), receiptPath = path.join(directory, 'receipt.json');
        const db = new Database(dbPath); db.exec('CREATE TABLE sentinel(value TEXT)'); db.close();
        const before = fs.readFileSync(dbPath);
        try {
            const child = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/team-email-reconciliation.js'),
                '--invitation-id', 'private-invite', '--verification-id', 'private-proof', '--receipt', receiptPath],
            { env: { ...process.env, AVA_PROCESS_ROLE: 'provisioning-worker', DB_PATH: dbPath }, encoding: 'utf8' });
            assert.strictEqual(child.status, 1);
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
            assert.deepStrictEqual(JSON.parse(child.stdout), receipt);
            assert.strictEqual(receipt.mode, 'dry_run'); assert.strictEqual(receipt.status, 'failed');
            assert.strictEqual(fs.statSync(receiptPath).mode & 0o777, 0o600);
            assert.ok(!/private-invite|private-proof|staff@example|native-staff/.test(child.stdout + child.stderr + JSON.stringify(receipt)));
            assert.deepStrictEqual(fs.readFileSync(dbPath), before);
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
});
