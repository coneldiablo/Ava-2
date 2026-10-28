'use strict';
const crypto = require('crypto');
const { describe, it: registerTest, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Provisioning = require('../src/services/provisioning/business-provisioning-store.service');
const Twenty = require('../src/services/twenty/twenty-store.service');
const Access = require('../src/services/identity/module-access-store');
const platform = { userId: 'native-team-operator', platformRole: 'platform_admin' };
const readback = async input => ({ ...input, ownAccess: true, foreignAccessDenied: true,
    platformAdminDenied: true, sessionGuardVerified: true });
const random = () => crypto.randomBytes(32).toString('base64url');
function it(name, run) {
    registerTest(name, async () => {
        const old = process.env.AVA_PROCESS_ROLE;
        process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        try { await run(); } finally {
            if (old === undefined) delete process.env.AVA_PROCESS_ROLE;
            else process.env.AVA_PROCESS_ROLE = old;
        }
    });
}
function fixture() {
    createTestDB();
    const invite = Identity.createInvitation(platform, { email: 'native-team@example.test' });
    const user = Identity.completeInvitation(Identity.claimInvitation(invite.token), 'native-team-subject');
    DB.run('UPDATE ava_users SET businessQuota=2 WHERE id=?', [user.userId]);
    const sessionToken = Identity.createSession(user.subject, 'native-team-sid');
    const entries = ['north', 'south'].map(name => {
        const business = Provisioning.createBusinessAtomic({ name }, { ownerUserId: user.userId }).instance;
        Twenty.upsertIntegration(business.id, { baseUrl: `https://team-${name}.crm.meludtech.tech`, workspaceId: `workspace-${name}`, enabled: true });
        const adapter = Access.configure({ businessId: business.id, module: 'twenty', publicOrigin: `https://team-${name}.crm.meludtech.tech` });
        return { business, adapter, user, sessionToken };
    });
    return { user, sessionToken, entries };
}
const verify = entry => Access.verifyPrincipal({ adapterId: entry.adapter.id, userId: entry.user.userId,
    nativeUserId: `native-${entry.business.id}`, readback });
function issue(entry) {
    const verifier = random();
    return { ...Access.issue({ sessionToken: entry.sessionToken, adapterId: entry.adapter.id,
        codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url') }), verifier };
}
const redeem = (entry, grant) => Access.redeem({ adapterId: entry.adapter.id, peerSecret: entry.adapter.peerSecret,
    code: grant.code, verifier: grant.verifier });
const authorize = (entry, session) => Access.authorize({ adapterId: entry.adapter.id, peerSecret: entry.adapter.peerSecret,
    sessionHandle: session.sessionHandle });
const lease = entry => Access.leaseRevocation({ adapterId: entry.adapter.id, peerSecret: entry.adapter.peerSecret }).job;
const complete = (entry, job, result = 'native_session_absent') => Access.finishRevocation({ adapterId: entry.adapter.id,
    peerSecret: entry.adapter.peerSecret, bindingId: job.bindingId, leaseToken: job.leaseToken, result });

describe('Team native module constraints: real SQLite, native readback fixtures', () => {
    it('keeps exact owner/manager native roles and rejects unproved lead/observer before any adapter work', async () => {
        const { entries: [entry] } = fixture();
        for (const role of ['hotel_owner', 'manager']) {
            DB.run('UPDATE ava_business_memberships SET role=? WHERE userId=? AND businessId=?', [role, entry.user.userId, entry.business.id]);
            await verify(entry);
            const session = redeem(entry, issue(entry));
            assert.strictEqual(authorize(entry, session).role, role);
        }
        for (const role of ['sales_lead', 'observer']) {
            DB.run('UPDATE ava_business_memberships SET role=? WHERE userId=? AND businessId=?', [role, entry.user.userId, entry.business.id]);
            let called = false;
            await assert.rejects(Access.verifyPrincipal({ adapterId: entry.adapter.id, userId: entry.user.userId,
                nativeUserId: 'unproved-role', readback: async input => { called = true; return readback(input); } }), { code: 'MODULE_ROLE_NOT_SUPPORTED' });
            assert.strictEqual(called, false);
            assert.throws(() => issue(entry), { code: 'MODULE_ROLE_NOT_SUPPORTED' });
            const item = Access.list({ sessionToken: entry.sessionToken, businessId: entry.business.id }).find(value => value.module === 'twenty');
            assert.strictEqual(item.error_code, 'MODULE_ROLE_NOT_SUPPORTED');
            assert.deepStrictEqual(item.allowed_actions, []);
        }
        assert.strictEqual(DB.get('SELECT role FROM ava_module_principals').role, 'manager');
    });

    it('business removal revokes its native sessions and grants but preserves AVA and another business', async () => {
        const { user, sessionToken, entries: [north, south] } = fixture();
        await verify(north); await verify(south);
        const northSession = redeem(north, issue(north)), southSession = redeem(south, issue(south));
        const northGrant = issue(north), southGrant = issue(south);
        const result = DB.db.transaction(() => {
            const result = Access.revokeBusinessAccess(user.userId, north.business.id);
            DB.run('UPDATE ava_business_memberships SET enabled=0 WHERE userId=? AND businessId=?', [user.userId, north.business.id]);
            return result;
        }).immediate();
        assert.deepStrictEqual(result, { businessId: north.business.id, principalsInvalidated: 1,
            grantsRevoked: 2, sessionsRevoked: 1, nativeRevocationPending: true });
        assert.ok(Identity.session(sessionToken));
        assert.throws(() => authorize(north, northSession), { code: 'MODULE_SESSION_INVALID' });
        assert.throws(() => redeem(north, northGrant), { code: 'MODULE_GRANT_INVALID' });
        assert.strictEqual(authorize(south, southSession).businessId, south.business.id);
        assert.strictEqual(redeem(south, southGrant).businessId, south.business.id);
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM ava_identity_outbox').n, 0);
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM ava_module_revocations').n, 1);
        const job = lease(north);
        assert.strictEqual(job.bindingId, northSession.bindingId);
        assert.throws(() => complete(south, job), { code: 'MODULE_REVOCATION_LEASE_LOST' });
        assert.deepStrictEqual(complete(north, job), { completed: true });
        assert.strictEqual(Access.revokeBusinessAccess(user.userId, north.business.id).nativeRevocationPending, false);
        assert.strictEqual(lease(north), null);
        assert.deepStrictEqual(DB.all('PRAGMA foreign_key_check'), []);
    });

    it('membership and native revocation roll back together on assignment cleanup failure', async () => {
        const { user, entries: [north] } = fixture();
        await verify(north);
        const session = redeem(north, issue(north)), grant = issue(north);
        assert.throws(() => DB.db.transaction(() => {
            Access.revokeBusinessAccess(user.userId, north.business.id);
            DB.run('UPDATE ava_business_memberships SET enabled=0 WHERE userId=? AND businessId=?', [user.userId, north.business.id]);
            throw new Error('assignment cleanup refused');
        }).immediate(), /assignment cleanup refused/);
        assert.strictEqual(DB.get('SELECT enabled FROM ava_business_memberships WHERE businessId=?', [north.business.id]).enabled, 1);
        assert.strictEqual(authorize(north, session).role, 'hotel_owner');
        assert.strictEqual(redeem(north, grant).role, 'hotel_owner');
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM ava_module_revocations').n, 0);
    });

    it('demotion invalidates outstanding native access without widening to manager; unchanged other business survives', async () => {
        const { user, entries: [north, south] } = fixture();
        await verify(north); await verify(south);
        const old = redeem(north, issue(north)), other = redeem(south, issue(south));
        DB.db.transaction(() => {
            Access.revokeBusinessAccess(user.userId, north.business.id);
            DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId=? AND businessId=?", [user.userId, north.business.id]);
        }).immediate();
        assert.throws(() => authorize(north, old), { code: 'MODULE_SESSION_INVALID' });
        assert.throws(() => issue(north), { code: 'MODULE_ROLE_NOT_SUPPORTED' });
        assert.strictEqual(authorize(south, other).role, 'hotel_owner');
        assert.strictEqual(DB.get('SELECT role,verifiedAt FROM ava_module_principals WHERE adapterId=?', [north.adapter.id]).role, 'hotel_owner');
        assert.strictEqual(DB.get('SELECT role,verifiedAt FROM ava_module_principals WHERE adapterId=?', [north.adapter.id]).verifiedAt, null);
        assert.strictEqual(lease(north).bindingId, old.bindingId);
    });

    it('supported role change still requires fresh native proof, and old grants never revive', async () => {
        const { user, entries: [north] } = fixture();
        await verify(north);
        const session = redeem(north, issue(north)), grant = issue(north);
        DB.db.transaction(() => {
            Access.revokeBusinessAccess(user.userId, north.business.id);
            DB.run("UPDATE ava_business_memberships SET role='manager' WHERE userId=? AND businessId=?", [user.userId, north.business.id]);
        }).immediate();
        assert.throws(() => issue(north), { code: 'MODULE_PRINCIPAL_NOT_VERIFIED' });
        await verify(north);
        assert.strictEqual(redeem(north, issue(north)).role, 'manager');
        assert.throws(() => authorize(north, session), { code: 'MODULE_SESSION_INVALID' });
        assert.throws(() => redeem(north, grant), { code: 'MODULE_GRANT_INVALID' });
    });

    it('revokes Twenty and Onyx independently for the same business and denies unproved Onyx roles', async () => {
        const { user, entries: [north, south] } = fixture();
        await verify(north); await verify(south);
        DB.run(`INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,status)
            VALUES (?,?,'https://team-knowledge.meludtech.tech','STAGING')`, [north.business.id, 'knowledge-north']);
        const knowledge = { ...north, adapter: Access.configure({ businessId: north.business.id,
            module: 'onyx', publicOrigin: 'https://team-knowledge.meludtech.tech' }) };
        await verify(knowledge);
        const crmSession = redeem(north, issue(north)), knowledgeSession = redeem(knowledge, issue(knowledge));
        const otherSession = redeem(south, issue(south));
        const result = Access.revokeBusinessAccess(user.userId, north.business.id);
        assert.strictEqual(result.principalsInvalidated, 2);
        assert.strictEqual(result.sessionsRevoked, 2);
        assert.throws(() => authorize(north, crmSession), { code: 'MODULE_SESSION_INVALID' });
        assert.throws(() => authorize(knowledge, knowledgeSession), { code: 'MODULE_SESSION_INVALID' });
        assert.strictEqual(authorize(south, otherSession).businessId, south.business.id);
        assert.strictEqual(lease(north).bindingId, crmSession.bindingId);
        assert.strictEqual(lease(knowledge).bindingId, knowledgeSession.bindingId);
        DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId=? AND businessId=?", [user.userId, north.business.id]);
        assert.throws(() => issue(knowledge), { code: 'MODULE_ROLE_NOT_SUPPORTED' });
        await assert.rejects(verify(knowledge), { code: 'MODULE_ROLE_NOT_SUPPORTED' });
    });

    it('scoped collector does not create cleanup jobs for unrelated invalid native sessions', async () => {
        const { user, entries: [north, south] } = fixture();
        await verify(north); await verify(south);
        const northSession = redeem(north, issue(north)), southSession = redeem(south, issue(south));
        DB.run('UPDATE ava_module_sessions SET expiresAt=? WHERE bindingId=?', [Date.now() - 1, southSession.bindingId]);
        Access.revokeBusinessAccess(user.userId, north.business.id);
        assert.deepStrictEqual(DB.all('SELECT bindingId FROM ava_module_revocations'), [{ bindingId: northSession.bindingId }]);
        assert.strictEqual(DB.get('SELECT revokedAt FROM ava_module_sessions WHERE bindingId=?', [southSession.bindingId]).revokedAt, null);
    });

    it('legacy native sessions without binding stay explicitly unverified after local revoke', async () => {
        const { user, entries: [north] } = fixture();
        await verify(north);
        const session = redeem(north, issue(north));
        DB.run('UPDATE ava_module_sessions SET bindingId=NULL WHERE bindingId=?', [session.bindingId]);
        const result = Access.revokeBusinessAccess(user.userId, north.business.id);
        assert.strictEqual(result.sessionsRevoked, 1);
        assert.strictEqual(result.nativeRevocationPending, true);
        assert.throws(() => authorize(north, session), { code: 'MODULE_SESSION_INVALID' });
        assert.strictEqual(lease(north), null);
        assert.strictEqual(Access.revokeBusinessAccess(user.userId, north.business.id).nativeRevocationPending, true);
    });

    it('native cleanup retry never masquerades as acknowledged revocation', async () => {
        const { user, entries: [north] } = fixture();
        await verify(north);
        const session = redeem(north, issue(north));
        Access.revokeBusinessAccess(user.userId, north.business.id);
        const first = lease(north);
        assert.deepStrictEqual(complete(north, first, 'retry'), { completed: false });
        assert.strictEqual(Access.revokeBusinessAccess(user.userId, north.business.id).nativeRevocationPending, true);
        assert.strictEqual(DB.get('SELECT state FROM ava_module_revocations WHERE bindingId=?', [session.bindingId]).state, 'pending');
        DB.run('UPDATE ava_module_revocations SET nextAttemptAt=0 WHERE bindingId=?', [session.bindingId]);
        const second = lease(north);
        assert.notStrictEqual(first.leaseToken, second.leaseToken);
        assert.throws(() => complete(north, first), { code: 'MODULE_REVOCATION_LEASE_LOST' });
        complete(north, second);
        assert.strictEqual(Access.revokeBusinessAccess(user.userId, north.business.id).nativeRevocationPending, false);
    });
});
