'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createAdapter, SCHEMA, deterministicUserId } = require('./adapter.cjs');
const { reconcileNativeRole } = require('./install.cjs');
const UUID = () => crypto.randomUUID();

// Real adapter, real durable SQLite ledgers with PostgreSQL query syntax
// translated; explicit native service fixture, never live native acceptance.
function fixture(revision = 1, clock = () => 10_000) {
  const sqlDb = new Database(':memory:');
  sqlDb.exec("ATTACH DATABASE ':memory:' AS ava_connector");
  const config = { businessId: 1, deploymentId: UUID(), nativeScope: UUID(), revision,
    roles: { hotel_owner: UUID(), manager: UUID() }, key: crypto.randomBytes(32) };
  const state = { roles: new Map(), sessions: new Map(), users: new Map(), locked: false,
    revokeFailure: false, roleReadbackStale: false, nativeCalls: 0 };
  const query = async (sql, values = []) => {
    if (sql.startsWith('SELECT pg_try_advisory_lock')) {
      const acquired = !state.locked; state.locked = true; return [{ acquired }];
    }
    if (sql.startsWith('SELECT pg_advisory_unlock')) { state.locked = false; return []; }
    if (sql.includes('CREATE SCHEMA')) {
      sqlDb.exec(sql.replace('CREATE SCHEMA IF NOT EXISTS ava_connector;', '').replaceAll('now()', 'CURRENT_TIMESTAMP').replaceAll('REFERENCES ava_connector.identities', 'REFERENCES identities'));
      return [];
    }
    const params = [];
    const translated = sql.replace(/\$(\d+)/g, (_match, index) => {
      const value = values[Number(index) - 1];
      params.push(value instanceof Date ? value.toISOString() : value); return '?';
    });
    const statement = sqlDb.prepare(translated);
    if (/^\s*SELECT/.test(sql)) return statement.all(...params);
    statement.run(...params); return [];
  };
  const db = { query, createQueryRunner: () => ({ query, connect: async () => {}, release: async () => {} }) };
  const roleService = {
    getRolesByUserWorkspaces: async ({ userWorkspaceIds, workspaceId }) => {
      assert.equal(workspaceId, config.nativeScope);
      return new Map(userWorkspaceIds.map(id => [id, state.roles.get(id) || []]));
    },
    assignRoleToManyUserWorkspace: async ({ userWorkspaceIds, workspaceId, roleId }) => {
      assert.equal(workspaceId, config.nativeScope); assert.equal(userWorkspaceIds.length, 1);
      if (!state.roleReadbackStale) state.roles.set(userWorkspaceIds[0], [{ id: roleId }]);
    },
  };
  const native = {
    async provisionIdentity({ nativeUserId, nativeScope, roleId, previousRoleId }) {
      state.nativeCalls++;
      let user = state.users.get(nativeUserId);
      if (!user) { user = { id: nativeUserId, membershipId: UUID() }; state.users.set(nativeUserId, user); }
      await reconcileNativeRole({ roleService, nativeScope, membershipId: user.membershipId, roleId, previousRoleId });
      return { nativeUserId, nativeMembershipId: user.membershipId };
    },
    async readIdentity(nativeUserId, nativeScope, nativeMembershipId) {
      return { nativeUserId, nativeScope, nativeMembershipId,
        disabled: false, deleted: false, canImpersonate: false, canAccessFullAdminPanel: false,
        roleElevated: false, roleIds: (state.roles.get(nativeMembershipId) || []).map(role => role.id) };
    },
    async createSession({ nativeUserId, nativeScope }) {
      const id = UUID(), nativeCookie = `__Host-twenty-session=${UUID()}`;
      state.sessions.set(id, { id, nativeUserId, nativeScope, nativeCookie, active: true });
      return { nativeSessionId: id, nativeCookie };
    },
    async revokeSession(id, nativeUserId, nativeScope) {
      if (state.revokeFailure) throw new Error('native cleanup fixture failure');
      const row = state.sessions.get(id);
      assert.equal(row.nativeUserId, nativeUserId); assert.equal(row.nativeScope, nativeScope); row.active = false;
    },
    async isSessionActive(id) { return Boolean(state.sessions.get(id)?.active); },
    async isSessionResolvable(cookie, nativeUserId, nativeScope) {
      return [...state.sessions.values()].some(row => row.active && row.nativeCookie === cookie && row.nativeUserId === nativeUserId && row.nativeScope === nativeScope);
    },
    async listAvaSessions(nativeUserId, nativeScope) {
      return [...state.sessions.values()].filter(row => row.active && row.nativeUserId === nativeUserId && row.nativeScope === nativeScope);
    },
  };
  const adapter = createAdapter({ config, db, native, now: clock });
  const owner = { businessId: config.businessId, deploymentId: config.deploymentId, nativeScope: config.nativeScope,
    userId: UUID(), subject: UUID(), role: 'hotel_owner', revision, email: 'role-test@example.invalid', displayName: 'Fixture owner' };
  const session = (body, bindingId = UUID()) => ({ businessId: body.businessId, deploymentId: body.deploymentId,
    nativeScope: body.nativeScope, userId: body.userId, subject: body.subject, role: body.role,
    revision: body.revision, nativeUserId: deterministicUserId(config.deploymentId, body.userId), bindingId, expiresAt: clock() + 20_000 });
  return { config, state, adapter, owner, session, native, sqlDb, roleService };
}

test('owner->manager stays at exact deployment revision, after revoke ACK a fresh session works and stale owner replay fails', async () => {
  for (const revision of [1, 2]) {
    const f = fixture(revision);
    try {
      await f.adapter.initialize(); await f.adapter.provision(f.owner);
      const oldBody = f.session(f.owner), old = await f.adapter.createSession(oldBody);
      assert.equal(await f.adapter.authorizeNative(oldBody.bindingId, old.nativeCookie), true);
      assert.deepEqual(await f.adapter.revoke({ bindingId: oldBody.bindingId }), { bindingId: oldBody.bindingId, nativeSessionAbsent: true });
      const manager = { ...f.owner, role: 'manager' };
      const result = await f.adapter.provision(manager);
      assert.equal(result.role, 'manager'); assert.equal(result.revision, revision);
      assert.equal(result.nativeUserId, oldBody.nativeUserId);
      const freshBody = f.session(manager), fresh = await f.adapter.createSession(freshBody);
      assert.equal(await f.adapter.authorizeNative(freshBody.bindingId, fresh.nativeCookie), true);
      await assert.rejects(f.adapter.authorizeNative(oldBody.bindingId, old.nativeCookie), { code: 'native_access_revoked' });
      await assert.rejects(f.adapter.provision(f.owner), { code: 'immutable_identity_conflict' });
      await assert.rejects(f.adapter.provision({ ...manager, subject: UUID() }), { code: 'immutable_identity_conflict' });
      await assert.rejects(f.adapter.provision({ ...manager, revision: revision + 1 }), { code: 'revision_mismatch' });
    } finally { f.sqlDb.close(); }
  }
});

test('failed downgrade cleanup is durable, cannot revive owner, retries sweep only that user and preserves another active session', async () => {
  const f = fixture();
  try {
    await f.adapter.initialize(); await f.adapter.provision(f.owner);
    const oldBody = f.session(f.owner), old = await f.adapter.createSession(oldBody);
    const other = { ...f.owner, userId: UUID(), subject: UUID(), email: 'other@example.invalid' };
    await f.adapter.provision(other);
    const otherBody = f.session(other), otherSession = await f.adapter.createSession(otherBody);
    f.state.revokeFailure = true;
    await assert.rejects(f.adapter.provision({ ...f.owner, role: 'manager' }), /native cleanup fixture failure/);
    const fenced = f.sqlDb.prepare('SELECT role,state FROM ava_connector.identities WHERE user_id=?').get(f.owner.userId);
    assert.deepEqual(fenced, { role: 'manager', state: 'provisioning' });
    await assert.rejects(f.adapter.authorizeNative(oldBody.bindingId, old.nativeCookie), { code: 'native_access_revoked' });
    await assert.rejects(f.adapter.provision(f.owner), { code: 'immutable_identity_conflict' });
    await assert.rejects(f.adapter.createSession(f.session({ ...f.owner, role: 'manager' })), { code: 'identity_not_active' });
    assert.equal(await f.adapter.authorizeNative(otherBody.bindingId, otherSession.nativeCookie), true);
    f.state.revokeFailure = false;
    const changed = await f.adapter.provision({ ...f.owner, role: 'manager' });
    assert.equal(changed.role, 'manager');
    assert.equal(await f.native.isSessionActive(old.nativeSessionId), false);
    assert.equal(await f.adapter.authorizeNative(otherBody.bindingId, otherSession.nativeCookie), true);
    const freshBody = f.session({ ...f.owner, role: 'manager' }), fresh = await f.adapter.createSession(freshBody);
    assert.equal(await f.adapter.authorizeNative(freshBody.bindingId, fresh.nativeCookie), true);
  } finally { f.sqlDb.close(); }
});

test('stale native role readback stays fenced and unproved role or foreign business never calls native dependencies', async () => {
  const f = fixture();
  try {
    await f.adapter.initialize(); await f.adapter.provision(f.owner);
    f.state.roleReadbackStale = true;
    await assert.rejects(f.adapter.provision({ ...f.owner, role: 'manager' }), { code: 'native_role_readback_invalid' });
    assert.equal(f.sqlDb.prepare('SELECT state FROM ava_connector.identities').get().state, 'provisioning');
    const calls = f.state.nativeCalls;
    for (const role of ['observer', 'sales_lead']) await assert.rejects(f.adapter.provision({ ...f.owner, role }), { code: 'invalid_identity' });
    await assert.rejects(f.adapter.provision({ ...f.owner, businessId: 2 }), { code: 'scope_mismatch' });
    assert.equal(f.state.nativeCalls, calls);
    f.state.roleReadbackStale = false;
    assert.equal((await f.adapter.provision({ ...f.owner, role: 'manager' })).state, 'active');
  } finally { f.sqlDb.close(); }
});

test('native role replacement rejects extra/elevated/unexpected roles and requires exact post-assignment proof', async () => {
  const f = fixture();
  try {
    const membershipId = UUID(), input = { roleService: f.roleService, nativeScope: f.config.nativeScope,
      membershipId, roleId: f.config.roles.manager, previousRoleId: f.config.roles.hotel_owner };
    for (const roles of [[{ id: UUID() }], [{ id: f.config.roles.hotel_owner }, { id: UUID() }],
      [{ id: f.config.roles.hotel_owner, canAccessAllTools: true }]]) {
      f.state.roles.set(membershipId, roles);
      await assert.rejects(reconcileNativeRole(input), error => ['native_role_conflict', 'native_elevated_role_forbidden'].includes(error.code));
      assert.deepEqual(f.state.roles.get(membershipId), roles);
    }
    f.state.roles.set(membershipId, [{ id: f.config.roles.hotel_owner }]);
    await assert.rejects(reconcileNativeRole({ ...input, previousRoleId: undefined }), { code: 'native_role_conflict' });
    await reconcileNativeRole(input);
    assert.deepEqual(f.state.roles.get(membershipId), [{ id: f.config.roles.manager }]);
  } finally { f.sqlDb.close(); }
});


test('AVA scoped revoke ACK and native manager proof produce a fresh manager PKCE grant without resetting AVA login', async () => {
  const DB = require('../../whatsapp_crm/src/services/database.service');
  const Identity = require('../../whatsapp_crm/src/services/identity/identity-store');
  const Access = require('../../whatsapp_crm/src/services/identity/module-access-store');
  const Provisioning = require('../../whatsapp_crm/src/services/provisioning/business-provisioning-store.service');
  const Twenty = require('../../whatsapp_crm/src/services/twenty/twenty-store.service');
  const { createTestDB } = require('../../whatsapp_crm/tests/test-helper');
  const previousRole = process.env.AVA_PROCESS_ROLE;
  process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
  const f = fixture(1, Date.now);
  try {
    createTestDB();
    const invitation = Identity.createInvitation({ userId: 'native-integration-operator', platformRole: 'platform_admin' },
      { email: 'native-integration@example.invalid' });
    const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), 'native-integration-subject');
    const business = Provisioning.createBusinessAtomic({ name: 'Native role proof' }, { ownerUserId: user.userId }).instance;
    const publicOrigin = 'https://native-role-proof.crm.meludtech.tech';
    Twenty.upsertIntegration(business.id, { baseUrl: publicOrigin, workspaceId: f.config.nativeScope, enabled: true });
    const brokerAdapter = Access.configure({ businessId: business.id, module: 'twenty', publicOrigin });
    const sessionToken = Identity.createSession(user.subject, 'native-integration-sid');
    const owner = { ...f.owner, userId: user.userId, subject: user.subject };
    const nativeUserId = deterministicUserId(f.config.deploymentId, user.userId);
    await f.adapter.initialize(); await f.adapter.provision(owner);
    const verify = () => Access.verifyPrincipal({ adapterId: brokerAdapter.id, userId: user.userId, nativeUserId,
      readback: async input => {
        const native = await f.adapter.verify({ businessId: business.id, deploymentId: f.config.deploymentId,
          nativeScope: f.config.nativeScope, userId: user.userId, revision: brokerAdapter.revision });
        return { ...input, role: native.role, nativeUserId: native.nativeUserId, subject: native.subject,
          ownAccess: true, foreignAccessDenied: true, platformAdminDenied: true, sessionGuardVerified: true };
      } });
    const grant = () => {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const issued = Access.issue({ sessionToken, adapterId: brokerAdapter.id,
        codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url') });
      return Access.redeem({ adapterId: brokerAdapter.id, peerSecret: brokerAdapter.peerSecret, code: issued.code, verifier });
    };
    await verify();
    const old = grant(), oldNativeBody = { ...f.session(owner, old.bindingId), expiresAt: old.expiresAt };
    const oldNative = await f.adapter.createSession(oldNativeBody);
    DB.db.transaction(() => {
      Access.revokeBusinessAccess(user.userId, business.id);
      DB.run("UPDATE ava_business_memberships SET role='manager' WHERE userId=? AND businessId=?", [user.userId, business.id]);
    }).immediate();
    const pending = Access.leaseRevocation({ adapterId: brokerAdapter.id, peerSecret: brokerAdapter.peerSecret }).job;
    assert.equal(pending.bindingId, old.bindingId);
    const receipt = await f.adapter.revoke({ bindingId: pending.bindingId });
    assert.equal(receipt.nativeSessionAbsent, true);
    Access.finishRevocation({ adapterId: brokerAdapter.id, peerSecret: brokerAdapter.peerSecret,
      bindingId: pending.bindingId, leaseToken: pending.leaseToken, result: 'native_session_absent' });
    const manager = { ...owner, role: 'manager' };
    await f.adapter.provision(manager); await verify();
    const fresh = grant();
    assert.equal(fresh.role, 'manager');
    const freshNative = await f.adapter.createSession({ ...f.session(manager, fresh.bindingId), expiresAt: fresh.expiresAt });
    assert.equal(await f.adapter.authorizeNative(fresh.bindingId, freshNative.nativeCookie), true);
    assert.equal(Access.authorize({ adapterId: brokerAdapter.id, peerSecret: brokerAdapter.peerSecret, sessionHandle: fresh.sessionHandle }).role, 'manager');
    assert.throws(() => Access.authorize({ adapterId: brokerAdapter.id, peerSecret: brokerAdapter.peerSecret,
      sessionHandle: old.sessionHandle }), { code: 'MODULE_SESSION_INVALID' });
    await assert.rejects(f.adapter.authorizeNative(old.bindingId, oldNative.nativeCookie), { code: 'native_access_revoked' });
    assert.equal(Identity.session(sessionToken).userId, user.userId);
    assert.equal(DB.get('SELECT count(*) AS n FROM ava_identity_outbox').n, 0);
  } finally {
    f.sqlDb.close();
    if (previousRole === undefined) delete process.env.AVA_PROCESS_ROLE;
    else process.env.AVA_PROCESS_ROLE = previousRole;
  }
});
