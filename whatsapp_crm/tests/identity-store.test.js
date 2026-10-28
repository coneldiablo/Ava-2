const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Provisioning = require('../src/services/provisioning/business-provisioning-store.service');
const admin = { userId: 'operator', platformRole: 'platform_admin' };

function invite(email) {
    const invitation = Identity.createInvitation(admin, { email });
    const claim = Identity.claimInvitation(invitation.token);
    const user = Identity.completeInvitation(claim, `keycloak-${claim.userId}`);
    return { invitation, user, claim };
}

describe('A02/A07 product identities and atomic ownership', () => {
    it('invitation is hash-only, single-use and does not grant a global role', () => {
        createTestDB();
        const { invitation, user } = invite('owner@example.test');
        assert.strictEqual(user.platformRole, 'customer');
        assert.deepStrictEqual(user.memberships, []);
        assert.strictEqual(JSON.stringify(DB.get('SELECT * FROM ava_invitations')).includes(invitation.token), false);
        assert.throws(() => Identity.claimInvitation(invitation.token), { code: 'INVITATION_INVALID' });
        assert.throws(() => Identity.createInvitation(user, { email: 'attacker@example.test' }), { code: 'PLATFORM_ADMIN_REQUIRED' });
    });

    it('business, membership and provisioning jobs commit together; quota failure rolls back all', () => {
        createTestDB();
        const { user } = invite('owner@example.test');
        const result = Provisioning.createBusinessAtomic({ name: 'Owned hotel' }, { ownerUserId: user.userId, idempotencyKey: 'same-request' });
        assert.strictEqual(Identity.authorizeBusiness(user, result.instance.id, { owner: true }), result.instance.id);
        const again = Provisioning.createBusinessAtomic({ name: 'Owned hotel' }, { ownerUserId: user.userId, idempotencyKey: 'same-request' });
        assert.strictEqual(again.isExisting, true);
        assert.throws(() => Provisioning.createBusinessAtomic({ name: 'Extra hotel' }, { ownerUserId: user.userId }), { code: 'BUSINESS_QUOTA_EXCEEDED' });
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM instances').n, 1);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_business_memberships').n, 1);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM business_provisioning_jobs').n, 5);
    });

    it('same payload/idempotency key and stale session cannot give access to another business', () => {
        createTestDB();
        const first = invite('one@example.test').user, second = invite('two@example.test').user;
        const result = Provisioning.createBusinessAtomic({ name: 'Private hotel' }, { ownerUserId: first.userId, idempotencyKey: 'known-key' });
        assert.throws(() => Provisioning.createBusinessAtomic({ name: 'Private hotel' }, { ownerUserId: second.userId, idempotencyKey: 'known-key' }), { code: 'BUSINESS_ACCESS_DENIED' });
        assert.throws(() => Identity.authorizeBusiness(second, result.instance.id), { code: 'BUSINESS_ACCESS_DENIED' });
        const token = Identity.createSession(first.subject, 'native-session');
        assert.ok(Identity.session(token));
        Identity.revokeUser(admin, first.userId);
        assert.strictEqual(Identity.session(token), null);
        assert.throws(() => Identity.authorizeBusiness(first, result.instance.id), { code: 'ACCOUNT_NOT_ACTIVE' });
        assert.strictEqual(DB.get('SELECT action FROM ava_identity_outbox').action, 'revoke_memberships');
    });

    it('expired and concurrently claimed invitations cannot be reused', () => {
        createTestDB();
        const invitation = Identity.createInvitation(admin, { email: 'one@example.test' });
        const claim = Identity.claimInvitation(invitation.token);
        assert.throws(() => Identity.claimInvitation(invitation.token), { code: 'INVITATION_IN_PROGRESS' });
        DB.run('UPDATE ava_invitations SET expiresAt=?', [Date.now() - 1]);
        assert.throws(() => Identity.completeInvitation(claim, 'native-subject'), { code: 'INVITATION_LEASE_LOST' });
        assert.throws(() => Identity.claimInvitation(invitation.token), { code: 'INVITATION_INVALID' });
    });

    it('manager cannot change owner-only settings and logout revokes server session', () => {
        createTestDB();
        const owner = invite('owner@example.test').user;
        const hotel = Provisioning.createBusinessAtomic({ name: 'Hotel' }, { ownerUserId: owner.userId }).instance;
        const invitation = Identity.createInvitation(admin, { email: 'manager@example.test', businessId: hotel.id, role: 'manager' });
        const claim = Identity.claimInvitation(invitation.token);
        const manager = Identity.completeInvitation(claim, 'manager-subject');
        assert.strictEqual(Identity.authorizeBusiness(manager, hotel.id), hotel.id);
        assert.throws(() => Identity.authorizeBusiness(manager, hotel.id, { owner: true }), { code: 'BUSINESS_ACCESS_DENIED' });
        const token = Identity.createSession(manager.subject, 'sid');
        Identity.revokeSession(token);
        assert.strictEqual(Identity.session(token), null);
    });
});
