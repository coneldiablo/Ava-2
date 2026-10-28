const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const OwnerVerificationStore = require('../src/services/identity/owner-verification-store');
const { reconcileOwnerEmail } = require('../src/services/identity/reconcile-owner-email');

function completedOwner() {
    createTestDB();
    OwnerVerificationStore.ensureSchema();
    const link = Identity.createOwnerInvitationLink({ userId: 'operator', platformRole: 'platform_admin' }, { label: 'Test' });
    const child = Identity.beginOwnerInvitationUse(link.token, { email: 'owner@example.test', displayName: 'Owner' });
    const claim = Identity.claimInvitation(child.childToken);
    Identity.completeInvitation(claim, 'native-owner');
    Identity.finishOwnerInvitationUse(child.invitationId);
    const use = DB.get('SELECT linkId,createdAtMs FROM ava_owner_invitation_uses WHERE invitationId=?', [child.invitationId]);
    DB.run(`INSERT INTO ava_owner_email_verifications
        (id,linkId,email,passwordEncrypted,codeHash,resendAfterMs,expiresAtMs,verifiedAtMs,createdAtMs)
        VALUES (?,?,?,?,?,?,?,?,?)`,
    ['verified-code', use.linkId, 'owner@example.test', '', 'fixture', 0, 0,
        use.createdAtMs + 1, use.createdAtMs - 1]);
    return child.userId;
}

describe('Completed owner email repair', () => {
    it('previews without mutation and only removes VERIFY_EMAIL after exact proof and native match', async () => {
        const userId = completedOwner();
        const native = { id: 'native-owner', username: `ava-${userId}`, email: 'owner@example.test',
            enabled: true, emailVerified: false, requiredActions: ['VERIFY_EMAIL', 'UPDATE_PROFILE'],
            attributes: { avaUserId: [userId] } };
        let writes = 0;
        const admin = { call: async (method, _path, data) => {
            if (method === 'PUT') { writes++; Object.assign(native, data); return null; }
            return _path.includes('?username=') ? [native] : native;
        } };
        assert.deepStrictEqual(await reconcileOwnerEmail({ db: DB.db, admin, userId }),
            { eligible: true, changeNeeded: true, updated: false });
        assert.strictEqual(writes, 0);
        assert.deepStrictEqual(await reconcileOwnerEmail({ db: DB.db, admin, userId, apply: true }),
            { eligible: true, changeNeeded: true, updated: true });
        assert.strictEqual(native.emailVerified, true);
        assert.deepStrictEqual(native.requiredActions, ['UPDATE_PROFILE']);
        assert.strictEqual(writes, 1);
    });

    it('refuses missing proof and foreign native identity', async () => {
        const userId = completedOwner();
        const admin = { call: async () => [{ id: 'foreign', username: `ava-${userId}`,
            email: 'other@example.test', enabled: true, attributes: { avaUserId: [userId] } }] };
        await assert.rejects(reconcileOwnerEmail({ db: DB.db, admin, userId, apply: true }),
            { message: 'NATIVE_IDENTITY_MISMATCH' });
        DB.run('DELETE FROM ava_owner_email_verifications');
        await assert.rejects(reconcileOwnerEmail({ db: DB.db, admin, userId, apply: true }),
            { message: 'EMAIL_CODE_PROOF_NOT_UNIQUE' });
    });
});
