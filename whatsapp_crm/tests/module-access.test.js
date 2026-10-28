const crypto = require('crypto');
const { describe, it: registerTest, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Provisioning = require('../src/services/provisioning/business-provisioning-store.service');
const Store = require('../src/services/twenty/twenty-store.service');
const Access = require('../src/services/identity/module-access-store');
const admin = { userId: 'test-operator', platformRole: 'platform_admin' };

// Explicit native contract fixture: these tests prove AVA's real SQLite and
// crypto boundary, not that a Twenty/Onyx extension is installed or working.
const nativeReadback = async input => ({ ...input, ownAccess: true,
    foreignAccessDenied: true, platformAdminDenied: true, sessionGuardVerified: true });
const random = () => crypto.randomBytes(32).toString('base64url');
const challenge = verifier => crypto.createHash('sha256').update(verifier).digest('base64url');
function it(name, run) {
    registerTest(name, async () => {
        const previous = process.env.AVA_PROCESS_ROLE;
        try { await run(); } finally {
            if (previous === undefined) delete process.env.AVA_PROCESS_ROLE;
            else process.env.AVA_PROCESS_ROLE = previous;
        }
    });
}

function owner(name) {
    const invitation = Identity.createInvitation(admin, { email: `${name}@example.test` });
    const claim = Identity.claimInvitation(invitation.token);
    const user = Identity.completeInvitation(claim, `subject-${name}`);
    const business = Provisioning.createBusinessAtomic({ name }, { ownerUserId: user.userId }).instance;
    Store.upsertIntegration(business.id, { baseUrl: `https://${name}.crm.meludtech.tech`, workspaceId: `workspace-${name}`, enabled: true });
    const adapter = Access.configure({ businessId: business.id, module: 'twenty', publicOrigin: `https://${name}.crm.meludtech.tech` });
    return { user, business, adapter, sessionToken: Identity.createSession(user.subject, `sid-${name}`) };
}
function setup() {
    createTestDB();
    process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
    return owner('north');
}
function verify(value, readback = nativeReadback, nativeUserId = 'native-north') {
    return Access.verifyPrincipal({ adapterId: value.adapter.id, userId: value.user.userId, nativeUserId, readback });
}
function issue(value, verifier = random()) {
    const grant = Access.issue({ sessionToken: value.sessionToken, adapterId: value.adapter.id, codeChallenge: challenge(verifier) });
    return { ...grant, verifier };
}
function redeem(value, grant) {
    return Access.redeem({ adapterId: value.adapter.id, peerSecret: value.adapter.peerSecret, code: grant.code, verifier: grant.verifier });
}
function authorized(value, session) {
    return Access.authorize({ adapterId: value.adapter.id, peerSecret: value.adapter.peerSecret, sessionHandle: session.sessionHandle });
}

describe('A07 independent AVA module bridge: real authorization store, native fixtures', () => {
    it('configuration is worker-only, hash-only and cannot grant access without native proof', () => {
        const value = setup();
        const stored = DB.get('SELECT * FROM ava_module_adapters');
        assert.strictEqual(JSON.stringify(stored).includes(value.adapter.peerSecret), false);
        assert.throws(() => issue(value), { code: 'MODULE_PRINCIPAL_NOT_VERIFIED' });
        const previous = process.env.AVA_PROCESS_ROLE;
        try {
            process.env.AVA_PROCESS_ROLE = 'web';
            assert.throws(() => Access.configure({ businessId: value.business.id, module: 'twenty', publicOrigin: 'https://north.crm.meludtech.tech' }), { code: 'MODULE_WORKER_REQUIRED' });
        } finally { process.env.AVA_PROCESS_ROLE = previous; }
    });

    it('native identity, subject, role and all negative probes are mandatory', async () => {
        const value = setup();
        for (const patch of [{ subject: 'foreign' }, { nativeScope: 'foreign' }, { role: 'admin' },
            { nativeUserId: 'foreign' }, { foreignAccessDenied: false }, { platformAdminDenied: false },
            { sessionGuardVerified: false }, { ownAccess: false }]) {
            await assert.rejects(verify(value, async input => ({ ...await nativeReadback(input), ...patch })), { code: 'MODULE_NATIVE_PROOF_INCOMPLETE' });
        }
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM ava_module_principals').n, 0);
    });

    it('grant uses PKCE, is single-use, does not store raw tokens and returns only mapped scope', async () => {
        const value = setup(); await verify(value);
        const grant = issue(value);
        assert.strictEqual(grant.callbackUrl, 'https://north.crm.meludtech.tech/ava-auth/callback');
        assert.strictEqual(JSON.stringify(DB.get('SELECT * FROM ava_module_grants')).includes(grant.code), false);
        assert.throws(() => redeem(value, { ...grant, verifier: random() }), { code: 'MODULE_PKCE_INVALID' });
        const session = redeem(value, grant);
        assert.strictEqual(session.nativeScope, 'workspace-north');
        assert.strictEqual(session.nativeUserId, 'native-north');
        assert.strictEqual(session.businessId, value.business.id);
        assert.strictEqual(session.role, 'hotel_owner');
        assert.strictEqual('email' in session, false);
        assert.strictEqual(JSON.stringify(DB.get('SELECT * FROM ava_module_sessions')).includes(session.sessionHandle), false);
        assert.throws(() => redeem(value, grant), { code: 'MODULE_GRANT_INVALID' });
        assert.strictEqual(authorized(value, session).subject, value.user.subject);
    });

    it('another peer, business, user or native module cannot redeem the grant', async () => {
        const value = setup(); await verify(value);
        const other = owner('south'); await verify(other, nativeReadback, 'native-south');
        const grant = issue(value);
        assert.throws(() => redeem({ ...value, adapter: { ...value.adapter, peerSecret: other.adapter.peerSecret } }, grant), { code: 'MODULE_PEER_DENIED' });
        assert.throws(() => redeem(other, grant), { code: 'MODULE_PRINCIPAL_NOT_VERIFIED' });
        assert.throws(() => issue({ ...value, sessionToken: other.sessionToken }), { code: 'MODULE_PRINCIPAL_NOT_VERIFIED' });
        const session = redeem(value, grant);
        assert.throws(() => authorized(other, session), { code: 'MODULE_PRINCIPAL_NOT_VERIFIED' });
        assert.strictEqual(authorized(value, session).businessId, value.business.id);
    });

    it('logout and IdP backchannel logout immediately invalidate module session guards', async () => {
        const value = setup(); await verify(value);
        const session = redeem(value, issue(value));
        Identity.revokeSession(value.sessionToken);
        assert.throws(() => authorized(value, session), { code: 'MODULE_PARENT_SESSION_REVOKED' });
        value.sessionToken = Identity.createSession(value.user.subject, 'new-sid');
        const newSession = redeem(value, issue(value));
        Identity.backchannelLogout({ sub: value.user.subject, sid: 'new-sid', jti: 'logout-jti' });
        assert.throws(() => authorized(value, newSession), { code: 'MODULE_PARENT_SESSION_REVOKED' });
    });

    it('disable beats a late successful native check and re-enable never revives old sessions', async () => {
        const value = setup(); await verify(value);
        const session = redeem(value, issue(value));
        await assert.rejects(verify(value, async input => {
            Access.disable(value.adapter.id);
            return nativeReadback(input);
        }), { code: 'MODULE_ADAPTER_UNAVAILABLE' });
        assert.throws(() => authorized(value, session), { code: 'MODULE_ADAPTER_UNAVAILABLE' });
        value.adapter = Access.configure({ businessId: value.business.id, module: 'twenty', publicOrigin: 'https://north.crm.meludtech.tech' });
        await verify(value);
        assert.throws(() => authorized(value, session), { code: 'MODULE_SESSION_INVALID' });
    });

    it('module integration revision and business disable invalidate access without restart', async () => {
        const value = setup(); await verify(value);
        const session = redeem(value, issue(value));
        Store.updateStatus(value.business.id, { apiKeyEncrypted: 'fixture-key-rotation' });
        assert.throws(() => authorized(value, session), { code: 'MODULE_CONFIGURATION_CHANGED' });
        value.adapter = Access.configure({ businessId: value.business.id, module: 'twenty', publicOrigin: 'https://north.crm.meludtech.tech' });
        await verify(value);
        const fresh = redeem(value, issue(value));
        DB.run('UPDATE instances SET isActive=0 WHERE id=?', [value.business.id]);
        assert.throws(() => authorized(value, fresh), { code: 'MODULE_BUSINESS_INACTIVE' });
    });

    it('customer revoke and membership downgrade override existing native grants', async () => {
        const value = setup(); await verify(value);
        const session = redeem(value, issue(value));
        DB.run("UPDATE ava_business_memberships SET role='manager' WHERE userId=?", [value.user.userId]);
        assert.throws(() => authorized(value, session), { code: 'MODULE_MEMBERSHIP_CHANGED' });
        await verify(value);
        const fresh = redeem(value, issue(value));
        assert.strictEqual(fresh.role, 'manager');
        Identity.revokeUser(admin, value.user.userId);
        assert.throws(() => authorized(value, fresh), { code: 'ACCOUNT_NOT_ACTIVE' });
    });

    it('native identity rebind cannot change the identity behind an outstanding session', async () => {
        const value = setup(); await verify(value);
        const session = redeem(value, issue(value)), outstanding = issue(value);
        await verify(value, nativeReadback, 'native-replacement');
        assert.throws(() => authorized(value, session), { code: 'MODULE_SESSION_INVALID' });
        assert.throws(() => redeem(value, outstanding), { code: 'MODULE_GRANT_INVALID' });
        assert.strictEqual(redeem(value, issue(value)).nativeUserId, 'native-replacement');
    });

    it('grant expiration and parent expiry are enforced even if the peer knows the code', async () => {
        const value = setup(); await verify(value);
        const grant = issue(value);
        DB.run('UPDATE ava_module_grants SET expiresAt=?', [Date.now() - 1]);
        assert.throws(() => redeem(value, grant), { code: 'MODULE_GRANT_INVALID' });
        const session = redeem(value, issue(value));
        DB.run('UPDATE ava_sessions SET expiresAt=?', [Date.now() - 1]);
        assert.throws(() => authorized(value, session), { code: 'MODULE_PARENT_SESSION_REVOKED' });
    });

    it('untrusted callback origins, URL credentials and paths cannot be configured', () => {
        const value = setup();
        for (const url of ['http://north.crm.meludtech.tech', 'https://north.crm.meludtech.tech.evil.test',
            'https://user:pass@north.crm.meludtech.tech', 'https://north.crm.meludtech.tech/next',
            'https://north.crm.meludtech.tech?next=bad', 'https://north.crm.meludtech.tech:8443', 'https://*.crm.meludtech.tech']) {
            assert.throws(() => Access.configure({ businessId: value.business.id, module: 'twenty', publicOrigin: url }), { code: 'MODULE_ORIGIN_INVALID' });
        }
    });

    it('Onyx scope is pinned separately and cannot accept a Twenty grant', async () => {
        const value = setup(); await verify(value);
        DB.run(`INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,status)
            VALUES (?,'knowledge-north','https://knowledge.meludtech.tech','STAGING')`, [value.business.id]);
        const knowledge = { ...value, adapter: Access.configure({ businessId: value.business.id,
            module: 'onyx', publicOrigin: 'https://knowledge.meludtech.tech' }) };
        await verify(knowledge, nativeReadback, 'knowledge-user-north');
        assert.throws(() => redeem(knowledge, issue(value)), { code: 'MODULE_PRINCIPAL_NOT_VERIFIED' });
        const session = redeem(knowledge, issue(knowledge));
        assert.strictEqual(session.module, 'onyx');
        assert.strictEqual(session.nativeScope, 'knowledge-north');
        DB.run("UPDATE onyx_tenant_links SET status='DISABLED' WHERE business_id=?", [value.business.id]);
        assert.throws(() => authorized(knowledge, session), { code: 'MODULE_INTEGRATION_UNAVAILABLE' });
    });

    it('two buyers cannot share a native identity on the same module deployment', async () => {
        const first = setup(), second = owner('south');
        for (const value of [first, second]) {
            DB.run(`INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,status)
                VALUES (?,?,'https://knowledge.meludtech.tech','STAGING')`, [value.business.id, `knowledge-${value.business.id}`]);
            value.adapter = Access.configure({ businessId: value.business.id,
                module: 'onyx', publicOrigin: 'https://knowledge.meludtech.tech' });
        }
        await verify(first, nativeReadback, 'same-native-user');
        await assert.rejects(verify(second, nativeReadback, 'same-native-user'), { code: 'MODULE_NATIVE_IDENTITY_ALREADY_LINKED' });
    });
});
