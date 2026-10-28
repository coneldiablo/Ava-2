'use strict';
const crypto = require('crypto');
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Verification = require('../src/services/identity/team-verification-store');
const Mailer = require('../src/services/identity/system-mailer.service');
const { KeycloakAdmin } = require('../src/services/identity/keycloak-admin');

const platform = { platformRole: 'platform_admin', userId: 'fixture-operator' };
const password = 'fixture-staff-password-long';

async function fixture(run) {
    const names = ['AVA_PROCESS_ROLE', 'AVA_OIDC_ISSUER', 'AVA_IDENTITY_ADMIN_ORIGIN',
        'AVA_IDENTITY_ADMIN_CLIENT_ID', 'AVA_IDENTITY_ADMIN_CLIENT_SECRET',
        'SESSION_SECRET', 'WHATSAPP_CRM_PUBLIC_URL', 'AVA_CUSTOMER_ACCESS_ENABLED'];
    const previousEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
    const previousDB = DB.db;
    const previousSend = Mailer.sendVerificationCodeEmail;
    Object.assign(process.env, {
        AVA_PROCESS_ROLE: 'provisioning-worker',
        AVA_OIDC_ISSUER: 'https://identity.example.test/realms/ava',
        AVA_IDENTITY_ADMIN_CLIENT_ID: 'fixture-admin-client',
        AVA_IDENTITY_ADMIN_CLIENT_SECRET: 'fixture-admin-secret',
        SESSION_SECRET: 'fixture-team-proof-secret-at-least-32-characters',
        WHATSAPP_CRM_PUBLIC_URL: 'https://ava.example.test',
        AVA_CUSTOMER_ACCESS_ENABLED: 'true',
    });
    delete process.env.AVA_IDENTITY_ADMIN_ORIGIN;
    let db;
    let message;
    Mailer.sendVerificationCodeEmail = async value => { message = value; };
    try {
        db = createTestDB();
        Identity.ensureSchema();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'Fixture business')");
        const invitation = Identity.inviteBusinessMember(platform, 1, {
            email: 'staff@example.test', role: 'manager', displayName: 'Fixture staff',
        });
        const verification = await Verification.initiateVerification(invitation.token, { password });
        assert.equal(message.to, 'staff@example.test');
        Verification.verifyCode(invitation.token, { verificationId: verification.verificationId, code: message.code });
        const row = DB.get('SELECT * FROM ava_invitations WHERE id=?', [invitation.invitationId]);
        await run({ invitation, verification, userId: row.userId });
    } finally {
        Mailer.sendVerificationCodeEmail = previousSend;
        for (const name of names) {
            if (previousEnv[name] === undefined) delete process.env[name];
            else process.env[name] = previousEnv[name];
        }
        DB.db = previousDB;
        if (db?.open) db.close();
    }
}

// Run the real admin/token/enrollment code. Only provider HTTP is stubbed;
// each boundary mutation occurs after its request has yielded asynchronously.
function provider(context, { existing = false, onLookup, onFinalRead, onToken, onPassword,
    onCreate, onEmailLookup, onEnable, requiredActions = ['VERIFY_EMAIL'], cleanupOffline = false } = {}) {
    const initial = {
        id: 'fixture-native-staff', username: `ava-${context.userId}`, email: 'staff@example.test',
        attributes: { avaUserId: [context.userId] }, enabled: false, emailVerified: false,
        requiredActions,
    };
    let native = existing ? structuredClone(initial) : null;
    let lookupCount = 0;
    let tokenCount = 0;
    const writes = { create: 0, password: 0, enable: 0, disable: 0, logout: 0 };
    const attempts = { password: 0, enable: 0 };
    const admin = new KeycloakAdmin({ request: async ({ method, url, data }) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/protocol/openid-connect/token')) {
            tokenCount++;
            await Promise.resolve();
            if (onToken) await onToken(context, tokenCount);
            return { data: { access_token: 'fixture-admin-access', expires_in: 300 } };
        }
        if (method === 'GET' && url.includes('?username=')) {
            lookupCount++;
            await Promise.resolve();
            if (lookupCount === 1 && onLookup) await onLookup(context);
            return { data: native ? [structuredClone(native)] : [] };
        }
        if (method === 'GET' && url.includes('?email=')) {
            await Promise.resolve();
            if (onEmailLookup) await onEmailLookup(context, native);
            return { data: native ? [structuredClone(native)] : [] };
        }
        if (method === 'POST' && path.endsWith('/users')) {
            writes.create++;
            native = { ...structuredClone(data), id: initial.id };
            if (onCreate) await onCreate(context);
            return { data: null };
        }
        if (method === 'PUT' && path.endsWith('/reset-password')) {
            attempts.password++;
            if (onPassword) await onPassword(context, attempts.password);
            writes.password++;
            assert.equal(data.type, 'password');
            assert.equal(data.temporary, false);
            assert(data.value === password, 'Password reset must use only the chosen credential');
            return { data: null };
        }
        if (method === 'PUT' && path.endsWith(`/users/${initial.id}`)) {
            if (data.enabled === true) {
                attempts.enable++;
                if (onEnable) await onEnable(context, attempts.enable);
                writes.enable++;
            }
            if (data.enabled === false) {
                writes.disable++;
                if (cleanupOffline) throw new Error('Fixture native cleanup unavailable');
            }
            native = { ...native, ...structuredClone(data) };
            return { data: null };
        }
        if (method === 'GET' && path.endsWith(`/users/${initial.id}`)) {
            await Promise.resolve();
            if (onFinalRead) await onFinalRead(context, native);
            return { data: structuredClone(native) };
        }
        if (method === 'POST' && path.endsWith(`/users/${initial.id}/logout`)) {
            writes.logout++;
            return { data: null };
        }
        throw new Error('Unexpected fixture identity request');
    } });
    return { admin, writes, attempts, native: () => native };
}

function assertLocalDenied(context) {
    assert.equal(DB.get('SELECT enabled FROM ava_users WHERE id=?', [context.userId]).enabled, 0);
    assert.equal(DB.get('SELECT COUNT(*) AS n FROM ava_business_memberships WHERE userId=? AND enabled=1', [context.userId]).n, 0);
    assert.notEqual(DB.get('SELECT state FROM ava_invitations WHERE id=?', [context.invitation.invitationId]).state, 'consumed');
    assert.equal(DB.get('SELECT COUNT(*) AS n FROM ava_sessions WHERE userId=? AND revokedAt IS NULL', [context.userId]).n, 0);
}

function assertDurableCompensation(context) {
    assertLocalDenied(context);
    const task = DB.get("SELECT action,state FROM ava_identity_outbox WHERE userId=? AND action='revoke_memberships'", [context.userId]);
    assert(task, 'A durable native revocation must survive provider cleanup failure');
    assert.equal(task.state, 'pending');
    assert.throws(() => Identity.createSession('fixture-native-staff'), { code: 'ACCOUNT_NOT_ENROLLED' });
}

const invalidateProof = {
    expires: ({ verification }) => DB.run('UPDATE ava_team_email_verifications SET expiresAtMs=? WHERE id=?', [Date.now() - 1, verification.verificationId]),
    consumed: ({ verification }) => DB.run('UPDATE ava_team_email_verifications SET completedAtMs=? WHERE id=?', [Date.now(), verification.verificationId]),
    deleted: ({ verification }) => DB.run('DELETE FROM ava_team_email_verifications WHERE id=?', [verification.verificationId]),
    'email mismatch': ({ verification }) => DB.run('UPDATE ava_team_email_verifications SET email=? WHERE id=?', ['different@example.test', verification.verificationId]),
};

describe('Persistent staff enrollment proof and final native identity', () => {
    it('exact live AVA staff proof verifies native email and permits the first login without VERIFY_EMAIL', () => fixture(async context => {
        const test = provider(context);
        assert.deepEqual(await test.admin.redeem(context.invitation.token, password, context.verification.verificationId), { success: true });
        assert.equal(test.native().emailVerified, true);
        assert.deepEqual(test.native().requiredActions, []);
        assert.equal(test.writes.password, 1);
        assert.equal(test.writes.enable, 1);
        assert(Verification.completed(context.invitation.invitationId, context.verification.verificationId));
        assert.equal(DB.get('SELECT passwordEncrypted FROM ava_team_email_verifications WHERE id=?', [context.verification.verificationId]).passwordEncrypted, '');
        assert.equal(DB.get('SELECT role FROM ava_business_memberships WHERE userId=? AND businessId=1 AND enabled=1', [context.userId]).role, 'manager');
    }));

    it('retry of the exact disabled native staff identity verifies email and preserves unrelated required actions', () => fixture(async context => {
        const test = provider(context, { existing: true, requiredActions: ['VERIFY_EMAIL', 'CONFIGURE_TOTP'] });
        await test.admin.redeem(context.invitation.token, password, context.verification.verificationId);
        assert.equal(test.writes.create, 0);
        assert.equal(test.native().emailVerified, true);
        assert.deepEqual(test.native().requiredActions, ['CONFIGURE_TOTP']);
        const session = Identity.createSession(test.native().id);
        assert.equal(Identity.session(session).memberships[0].businessId, 1);
    }));

    it('a forged verified flag without the exact claimed proof never contacts the native provider', () => fixture(async context => {
        const claim = Identity.claimInvitation(context.invitation.token, context.verification.verificationId);
        claim.emailVerificationId = 'another-proof-id';
        let requests = 0;
        const admin = new KeycloakAdmin({ request: async () => { requests++; } });
        await assert.rejects(admin.enrollClaim(claim, password), { code: 'INVITATION_LEASE_LOST' });
        assert.equal(requests, 0);
        assertLocalDenied(context);
    }));

    it('the worker rejects a different requested proof ID instead of falling back to the valid invitation proof', () => fixture(async context => {
        let requests = 0;
        const admin = new KeycloakAdmin({ request: async () => { requests++; } });
        await assert.rejects(admin.redeem(context.invitation.token, password, 'another-proof-id'), { code: 'VERIFICATION_REQUIRED' });
        assert.equal(requests, 0); assertLocalDenied(context);
    }));

    it('proof invalidated while native creation is in flight prevents password reset and activation', () => fixture(async context => {
        const test = provider(context, { onCreate: invalidateProof.expires });
        await assert.rejects(test.admin.redeem(context.invitation.token, password, context.verification.verificationId), { code: 'INVITATION_LEASE_LOST' });
        assert.equal(test.writes.create, 1);
        assert.equal(test.writes.password, 0);
        assert.equal(test.writes.enable, 0);
        assert.equal(test.native().enabled, false);
        assertDurableCompensation(context);
    }));

    it('proof invalidated during the exact native email read prevents reset and activation', () => fixture(async context => {
        const test = provider(context, { existing: true, onEmailLookup: invalidateProof.expires });
        await assert.rejects(test.admin.redeem(context.invitation.token, password, context.verification.verificationId), { code: 'INVITATION_LEASE_LOST' });
        assert.equal(test.writes.password, 0);
        assert.equal(test.writes.enable, 0);
        assertDurableCompensation(context);
    }));

    it('proof expiry during the creation admin-token await prevents native POST dispatch', () => fixture(async context => {
        let test;
        test = provider(context, {
            onEmailLookup: () => { test.admin.cachedToken = null; },
            onToken: (current, count) => { if (count === 2) invalidateProof.expires(current); },
        });
        await assert.rejects(test.admin.redeem(context.invitation.token, password, context.verification.verificationId), { code: 'INVITATION_LEASE_LOST' });
        assert.equal(test.writes.create, 0); assert.equal(test.writes.password, 0); assert.equal(test.writes.enable, 0);
        assert.equal(test.native(), null); assertLocalDenied(context);
    }));

    it('an exact native email lookup belonging to another AVA identity prevents credential mutation', () => fixture(async context => {
        const test = provider(context, { existing: true,
            onEmailLookup: (_context, native) => { native.attributes.avaUserId = ['foreign-ava-user']; } });
        await assert.rejects(test.admin.redeem(context.invitation.token, password, context.verification.verificationId), { code: 'IDENTITY_NATIVE_EMAIL_CONFLICT' });
        assert.equal(test.writes.password, 0); assert.equal(test.writes.enable, 0); assertLocalDenied(context);
    }));

    it('legacy platform invitations without an AVA email proof retain native VERIFY_EMAIL', () => fixture(async context => {
        const legacy = Identity.createInvitation(platform, { email: 'legacy@example.test', businessId: 1, role: 'observer' });
        const { userId } = DB.get('SELECT userId FROM ava_invitations WHERE id=?', [legacy.invitationId]);
        const native = { id: 'legacy-native', username: `ava-${userId}`, email: 'legacy@example.test',
            attributes: { avaUserId: [userId] }, enabled: false, emailVerified: false, requiredActions: ['VERIFY_EMAIL'] };
        const admin = new KeycloakAdmin({ request: async ({ method, url, data }) => {
            if (url.endsWith('/token')) return { data: { access_token: 'fixture-token', expires_in: 300 } };
            if (method === 'GET' && url.includes('?username=')) return { data: [structuredClone(native)] };
            if (method === 'PUT' && !url.endsWith('/reset-password')) Object.assign(native, data);
            return { data: structuredClone(native) };
        } });
        await admin.redeem(legacy.token, password);
        assert.equal(native.emailVerified, false);
        assert.deepEqual(native.requiredActions, ['VERIFY_EMAIL']);
    }));

    it('wrong persisted proof email before initial claim denies before contacting the native provider', () => fixture(async context => {
        invalidateProof['email mismatch'](context);
        let providerRequests = 0;
        const admin = new KeycloakAdmin({ request: async () => {
            providerRequests++;
            throw new Error('Provider must not be contacted without bound proof');
        } });
        await assert.rejects(admin.redeem(context.invitation.token, password, context.verification.verificationId), { code: 'VERIFICATION_REQUIRED' });
        assert.equal(providerRequests, 0);
        assertLocalDenied(context);
    }));

    it('an expired claimed proof cannot silently switch to another valid proof during provider lookup', () => fixture(async context => {
        const test = provider(context, { existing: true, onLookup: () => {
            const proof = DB.get('SELECT * FROM ava_team_email_verifications WHERE id=?', [context.verification.verificationId]);
            invalidateProof.expires(context);
            DB.run(`INSERT INTO ava_team_email_verifications
                (id,invitationId,invitationTokenHash,email,passwordEncrypted,codeHash,
                 attempts,resendCount,resendAfterMs,expiresAtMs,verifiedAtMs,completedAtMs,createdAtMs)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [crypto.randomUUID(),proof.invitationId,proof.invitationTokenHash,proof.email,
                proof.passwordEncrypted,proof.codeHash,proof.attempts,proof.resendCount,
                proof.resendAfterMs,proof.expiresAtMs,proof.verifiedAtMs,null,proof.createdAtMs + 1]);
        } });
        await assert.rejects(test.admin.redeem(context.invitation.token, password, context.verification.verificationId), { code: 'INVITATION_LEASE_LOST' });
        assert.equal(test.writes.password, 0);
        assert.equal(test.writes.enable, 0);
        assertLocalDenied(context);
    }));

    for (const existing of [false, true]) {
        for (const [reason, mutation] of Object.entries(invalidateProof)) {
            it(`proof ${reason} during native lookup blocks ${existing ? 'reset and enable of existing native user' : 'native creation'}`, () => fixture(async context => {
                const test = provider(context, { existing, onLookup: mutation });
                await assert.rejects(test.admin.redeem(context.invitation.token, password, context.verification.verificationId));
                assert.equal(test.writes.create, 0);
                assert.equal(test.writes.password, 0);
                assert.equal(test.writes.enable, 0);
                assertLocalDenied(context);
                if (existing) assert.equal(test.native().enabled, false);
            }));
        }
    }

    const changeSnapshot = {
        'live user email': ({ userId }) => DB.run('UPDATE ava_users SET email=? WHERE id=?', ['changed@example.test', userId]),
        'live invitation role': ({ invitation }) => DB.run("UPDATE ava_invitations SET role='observer' WHERE id=?", [invitation.invitationId]),
        'invitation token hash with retained lease': ({ invitation }) => DB.run('UPDATE ava_invitations SET tokenHash=? WHERE id=?', [Identity.hash(crypto.randomBytes(32).toString('base64url')), invitation.invitationId]),
    };
    for (const [reason, mutation] of Object.entries(changeSnapshot)) {
        it(`${reason} changed during provider await denies stale enrollment snapshot`, () => fixture(async context => {
            const test = provider(context, { existing: true, onLookup: mutation });
            await assert.rejects(test.admin.redeem(context.invitation.token, password, context.verification.verificationId));
            assert.equal(test.writes.password, 0);
            assert.equal(test.writes.enable, 0);
            assertLocalDenied(context);
        }));
    }

    it('proof expiry during final provider GET prevents local completion and compensates native enable', () => fixture(async context => {
        const test = provider(context, { onFinalRead: invalidateProof.expires });
        await assert.rejects(test.admin.redeem(context.invitation.token, password, context.verification.verificationId));
        assert.equal(test.writes.enable, 1);
        assert.equal(test.writes.disable, 1);
        assert.equal(test.writes.logout, 1);
        assert.equal(test.native().enabled, false);
        assertDurableCompensation(context);
    }));

    it('a stale worker final read cannot disable or revoke a newer successful exact native enrollment', () => fixture(async context => {
        const test = provider(context, { onFinalRead: (_context, native) => {
            // Simulate a superseded generation from an older worker. Normal
            // claims retain a durable barrier and cannot perform this reset.
            DB.run("UPDATE ava_invitations SET state='pending',leaseToken=NULL,leasedUntil=NULL WHERE id=?", [context.invitation.invitationId]);
            const replacement = Identity.claimInvitation(context.invitation.token, context.verification.verificationId);
            Identity.completeInvitation(replacement, native.id);
        } });
        await assert.rejects(test.admin.redeem(context.invitation.token, password, context.verification.verificationId), { code: 'INVITATION_LEASE_LOST' });
        assert.equal(test.writes.enable, 1);
        assert.equal(test.writes.disable, 0); assert.equal(test.writes.logout, 0);
        assert.equal(test.native().enabled, true); assert.equal(test.native().emailVerified, true);
        assert.equal(DB.get('SELECT enabled FROM ava_users WHERE id=?', [context.userId]).enabled, 1);
        assert.equal(DB.get('SELECT state FROM ava_invitations WHERE id=?', [context.invitation.invitationId]).state, 'consumed');
        assert.equal(DB.get('SELECT count(*) n FROM ava_identity_outbox WHERE userId=?', [context.userId]).n, 0);
        const current = Identity.session(Identity.createSession(test.native().id));
        assert.equal(current.memberships.find(member => member.businessId === 1).role, 'manager');
    }));

    for (const phase of ['password', 'enable']) {
        it(`proof expiry during admin token await prevents ${phase} HTTP dispatch`, () => fixture(async context => {
            let test;
            test = provider(context, { existing: true,
                onLookup: phase === 'password' ? () => { test.admin.cachedToken = null; } : undefined,
                onPassword: phase === 'enable' ? () => { test.admin.cachedToken = null; } : undefined,
                onToken: (current, count) => { if (count === 2) invalidateProof.expires(current); },
            });
            await assert.rejects(test.admin.redeem(context.invitation.token, password, context.verification.verificationId));
            assert.equal(test.attempts.password, phase === 'password' ? 0 : 1,
                'A token await must not dispatch a password reset after proof invalidation');
            assert.equal(test.attempts.enable, 0,
                'A token await must not dispatch native enable after proof invalidation');
            assert.equal(test.writes.enable, 0);
            assert.equal(test.native().enabled, false);
            assertDurableCompensation(context);
        }));
    }

    for (const phase of ['password', 'enable']) {
        it(`proof expiry during 401 refresh prevents a fresh ${phase} mutation retry`, () => fixture(async context => {
            const unauthorized = (_context, attempt) => {
                if (attempt === 1) throw Object.assign(new Error('Fixture native authorization expired'), {
                    response: { status: 401 },
                });
            };
            const test = provider(context, { existing: true,
                onPassword: phase === 'password' ? unauthorized : undefined,
                onEnable: phase === 'enable' ? unauthorized : undefined,
                onToken: (current, count) => { if (count === 2) invalidateProof.expires(current); },
            });
            await assert.rejects(test.admin.redeem(context.invitation.token, password, context.verification.verificationId));
            assert.equal(test.attempts.password, 1,
                'An unauthorized password request must never be retried after proof invalidation');
            assert.equal(test.attempts.enable, phase === 'password' ? 0 : 1,
                'An unauthorized enable request must never be retried after proof invalidation');
            assert.equal(test.writes.password, phase === 'password' ? 0 : 1);
            assert.equal(test.writes.enable, 0);
            assert.equal(test.native().enabled, false);
            assertDurableCompensation(context);
        }));
    }

    const nativeChanges = {
        subject: native => { native.id = 'foreign-native-subject'; },
        username: native => { native.username = 'ava-foreign-fixture'; },
        email: native => { native.email = 'foreign@example.test'; },
        avaUserId: native => { native.attributes = { avaUserId: ['foreign-ava-user'] }; },
    };
    for (const [field, mutation] of Object.entries(nativeChanges)) {
        it(`changed native ${field} on final read rejects completion and persists compensation`, () => fixture(async context => {
            const test = provider(context, { onFinalRead: (_context, native) => mutation(native) });
            await assert.rejects(test.admin.redeem(context.invitation.token, password, context.verification.verificationId), { code: 'IDENTITY_NATIVE_OWNER_UNVERIFIED' });
            assert.equal(test.writes.disable, 1);
            assert.equal(test.writes.logout, 1);
            assert.equal(test.native().enabled, false);
            assert.equal(DB.get('SELECT completedAtMs FROM ava_team_email_verifications WHERE id=?', [context.verification.verificationId]).completedAtMs, null);
            assertDurableCompensation(context);
        }));
    }

    it('failed native compensation after final identity mismatch still durably denies AVA access', () => fixture(async context => {
        const test = provider(context, { cleanupOffline: true,
            onFinalRead: (_context, native) => { native.email = 'foreign@example.test'; } });
        await assert.rejects(test.admin.redeem(context.invitation.token, password, context.verification.verificationId), { code: 'IDENTITY_NATIVE_OWNER_UNVERIFIED' });
        assert.equal(test.writes.disable, 1);
        assert.equal(test.native().enabled, true, 'Offline provider cleanup must not be reported as successful');
        assertDurableCompensation(context);
    }));
});
