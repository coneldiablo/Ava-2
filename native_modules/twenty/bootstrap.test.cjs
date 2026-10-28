'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { bootstrap, configFrom, writeOutput, findOwnedRole, nativeSubdomain } = require('./bootstrap.cjs');
const id = '2d4466e8-70b5-4f95-aad4-04aec1cab8f2'; const ownerId = '25f2ef17-2b91-4416-a54e-967a67e7c2de'; const roleA = '35f2ef17-2b91-4416-a54e-967a67e7c2de'; const roleB = '45f2ef17-2b91-4416-a54e-967a67e7c2de';
function config() { return { businessId: 7, deploymentId: id, revision: 3, displayName: 'Hotel', hostname: 'hotel-7.crm.meludtech.tech', ownerEmail: `ava-bootstrap-${id.replaceAll('-', '')}@ava.invalid`, subdomain: `ava-${id.replaceAll('-', '')}` }; }
function configFile(value = config()) { const { businessId, deploymentId, revision, displayName, hostname } = value; return { businessId, deploymentId, revision, displayName, hostname }; }
function fixture({ signupLost = false, activationLost = false, roleLost = false } = {}) {
  const state = { signup: 0, activate: 0, roles: [], row: null, workspace: { id, subdomain: config().subdomain, activationStatus: 'PENDING_CREATION' }, user: { id: ownerId, email: config().ownerEmail } };
  const ledger = { ensure: async()=>{}, lock: async()=>{}, get: async()=>state.row, claim: async c => { state.row = { deployment_id:c.deploymentId,business_id:c.businessId,revision:c.revision,owner_email:c.ownerEmail,subdomain:c.subdomain }; }, put: async(c,v)=> { state.row = { ...state.row, native_scope:v.nativeScope || state.row.native_scope, owner_user_id:v.ownerUserId || state.row.owner_user_id, manager_role_id:v.managerRoleId || state.row.manager_role_id, hotel_owner_role_id:v.hotelOwnerRoleId || state.row.hotel_owner_role_id }; } };
  const roleService = { async getRoleById(roleId) { return state.roles.find(x => x.id === roleId) || null; }, async createRole({ input }) { const role = { ...input, applicationId: 'app', id: state.roles.length ? roleB : roleA, label: input.label }; state.roles.push(role); if (roleLost) throw new Error('lost'); return role; } };
  return { state, deps: { ledger, signInUp: { async signUpOnNewWorkspace() { state.signup++; if (signupLost) throw new Error('lost'); return { user: state.user, workspace: state.workspace }; } }, workspaceService: { async activateWorkspace() { state.activate++; state.workspace.activationStatus='ACTIVE'; if (activationLost) throw new Error('lost'); } }, roleService, applicationService: { async findWorkspaceTwentyStandardAndCustomApplicationOrThrow() { return { workspaceCustomFlatApplication: { id:'app' } }; } }, workspaceRepo: { async findOneBy() { return state.workspace; } }, async findOwnedWorkspace() { return state.signup ? state.workspace : null; }, async findOwnedUser() { return state.user; }, async findOwnedRole(workspaceId, label) { return state.roles.find(x => x.label === label) || null; } } };
}
test('rejects missing or wrongly scoped bootstrap configuration', () => {
  assert.throws(() => configFrom({ readFile: () => '{}', env: {} }), { code: 'BOOTSTRAP_CONFIG_INVALID' });
  assert.throws(() => configFrom({ readFile: () => JSON.stringify({ ...configFile(), hostname: 'other.crm.meludtech.tech' }), env: { PG_DATABASE_URL: `postgres://x/ava_${id.replaceAll('-', '')}` } }), { code: 'BOOTSTRAP_HOSTNAME_INVALID' });
  assert.throws(() => configFrom({ readFile: () => JSON.stringify(configFile()), env: { PG_DATABASE_URL: 'postgres://x/ava_wrong' } }), { code: 'BOOTSTRAP_DATABASE_SCOPE_INVALID' });
});
test('native subdomain obeys pinned 30-character limit without truncating deployment identity', () => {
  const value = configFrom({ readFile: () => JSON.stringify(configFile()), env: { PG_DATABASE_URL: `postgres://x/ava_${id.replaceAll('-', '')}` } });
  assert.match(value.subdomain, /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/);
  assert.ok(value.subdomain.length <= 30);
  assert.notEqual(nativeSubdomain(id), nativeSubdomain(id.slice(0, -1) + '3'));
  let restored = 0n;
  for (const char of value.subdomain.slice(4)) restored = restored * 36n + BigInt(parseInt(char, 36));
  assert.equal(restored.toString(16).padStart(32, '0'), id.replaceAll('-', ''));
});
test('repeat is idempotent and scope changes fail closed', async () => {
  const f = fixture(); const first = await bootstrap(config(), f.deps); const second = await bootstrap(config(), f.deps);
  assert.equal(f.state.signup, 1); assert.equal(f.state.roles.length, 2); assert.deepEqual(second, first);
  await assert.rejects(bootstrap({ ...config(), revision: 4 }, f.deps), { code: 'BOOTSTRAP_SCOPE_IMMUTABLE' });
});
test('an existing deterministic workspace without a ledger claim is never adopted', async () => {
  const f = fixture(); f.state.signup = 1;
  await assert.rejects(bootstrap(config(), f.deps), { code: 'BOOTSTRAP_OWNERSHIP_COLLISION' });
});
test('lost signup, activation, and role responses reconcile owned state', async () => {
  const signup = fixture({ signupLost: true }); await bootstrap(config(), signup.deps); assert.equal(signup.state.signup, 1);
  const activation = fixture({ activationLost: true }); await bootstrap(config(), activation.deps); assert.equal(activation.state.workspace.activationStatus, 'ACTIVE');
  const roles = fixture({ roleLost: true }); const result = await bootstrap(config(), roles.deps); assert.equal(roles.state.roles.length, 2); assert.equal(result.managerRoleId, roleA);
});
test('safe output excludes email and has only runtime identifiers', () => {
  const writes=[]; const result = writeOutput({ ...config(), nativeScope:id, managerRoleId:roleA, hotelOwnerRoleId:roleB, ownerUserId:ownerId }, { output:'/run/out.json', fsApi:{ mkdirSync(){}, writeFileSync(p,v,o){writes.push([p,v,o]);}, renameSync(){}, chmodSync(){} } });
  assert.deepEqual(Object.keys(result).sort(), ['businessId','deploymentId','hotelOwnerRoleId','managerRoleId','nativeScope','ownerUserId','revision'].sort()); assert.equal(writes[0][2].mode, 0o600); assert.equal(writes[0][1].includes('ava-bootstrap'), false);
});
test('process restart after native signup but before checkpoint never signs up twice', async () => {
  const f = fixture(); const put = f.deps.ledger.put;
  f.deps.ledger.put = async () => { throw new Error('process killed'); };
  await assert.rejects(bootstrap(config(), f.deps), /process killed/);
  assert.equal(f.state.signup, 1); assert.equal(f.state.row.native_scope, undefined);
  f.deps.ledger.put = put;
  await bootstrap(config(), f.deps);
  assert.equal(f.state.signup, 1); assert.equal(f.state.roles.length, 2);
});
test('role adoption reads owning application from native entity, not summary DTO', async () => {
  let applicationId = 'app';
  const service = { getWorkspaceRoles: async () => [{ id: roleA, label: 'AVA role' }], getRoleById: async () => ({ id: roleA, applicationId }) };
  assert.equal((await findOwnedRole(service, id, 'AVA role', { id: 'app' })).id, roleA);
  applicationId = 'foreign';
  await assert.rejects(findOwnedRole(service, id, 'AVA role', { id: 'app' }), { code: 'BOOTSTRAP_ROLE_COLLISION' });
});
test('elevated or foreign-application roles are not accepted on restart', async () => {
  for (const change of [{ canAccessAllTools: true }, { applicationId: 'foreign' }]) {
    const f = fixture(); await bootstrap(config(), f.deps); Object.assign(f.state.roles[0], change);
    await assert.rejects(bootstrap(config(), f.deps), { code: 'BOOTSTRAP_ROLE_READBACK_INVALID' });
  }
});
