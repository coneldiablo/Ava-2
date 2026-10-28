'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { attach, attachmentLockFor, configFrom, readAttachmentBinding, roleLabels, writeOutput } = require('./attach-existing-workspace.cjs');
const scope = '11111111-1111-4111-8111-111111111111';
const deployment = '22222222-2222-4222-8222-222222222222';
const manager = '33333333-3333-4333-8333-333333333333';
const owner = '44444444-4444-4444-8444-444444444444';
const objectIds = ['55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777','88888888-8888-4888-8888-888888888888','99999999-9999-4999-8999-999999999999','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];
const config = () => ({ businessId: 1, deploymentId: deployment, revision: 1, nativeScope: scope });
function env(value = config()) { return { AVA_NATIVE_ATTACH_EXISTING_WORKSPACE: 'true', AVA_BUSINESS_ID: String(value.businessId), AVA_DEPLOYMENT_ID: value.deploymentId, AVA_DEPLOYMENT_REVISION: String(value.revision) }; }
function fixture({ workspace = { id: scope, activationStatus: 'ACTIVE' }, mutateRole } = {}) {
  const roles = []; const calls = { create: 0, permissions: 0, users: 0, schema: 0, lock: 0, unlock: 0 };
  const labels = roleLabels(deployment);
  const roleService = {
    async getWorkspaceRoles() { return roles.map(({ id, label }) => ({ id, label })); },
    async getRoleById(id) { return roles.find(role => role.id === id) || null; },
    async createRole({ input }) { calls.create++; const id = roles.length ? owner : manager; const role = { ...input, id, applicationId: 'app', objectPermissions: [] }; roles.push(mutateRole ? mutateRole(role) : role); return role; },
  };
  const objects = ['person','company','task','note'].map((nameSingular, index) => ({ nameSingular, id: objectIds[index] }));
  return { roles, calls, deps: {
    workspaceRepo: { async findOneBy() { return workspace; } },
    applicationService: { async findWorkspaceTwentyStandardAndCustomApplicationOrThrow() { return { workspaceCustomFlatApplication: { id: 'app' } }; } },
    roleService,
    findObjects: async (_workspace, names) => objects.filter(object => names.includes(object.nameSingular)),
    objectPermissionService: { async upsertObjectPermissions({ input }) { calls.permissions++; const role = roles.find(item => item.id === input.roleId); role.objectPermissions = input.objectPermissions; } },
    async lockAttachment() { calls.lock++; return async () => { calls.unlock++; }; },
    async readAttachmentBinding() { return null; },
  } };
}

test('requires explicit, exact existing-workspace attach context bound to runtime contour', () => {
  assert.deepEqual(configFrom({ env: env(), readFile: () => JSON.stringify(config()) }), config());
  for (const candidate of [
    { ...env(), AVA_NATIVE_ATTACH_EXISTING_WORKSPACE: 'false' },
    { ...env(), AVA_BUSINESS_ID: '2' },
  ]) assert.throws(() => configFrom({ env: candidate, readFile: () => JSON.stringify(config()) }));
  assert.throws(() => configFrom({ env: env(), readFile: () => JSON.stringify({ ...config(), extra: true }) }), { code: 'ATTACH_CONFIG_INVALID' });
});

test('attaches only active existing workspace, creates confined roles, and grants existing base objects', async () => {
  const f = fixture(); const result = await attach(config(), f.deps);
  assert.equal(f.calls.create, 2); assert.equal(f.calls.permissions, 2); assert.equal(f.calls.lock, 1); assert.equal(f.calls.unlock, 1); assert.equal(f.calls.users, 0); assert.equal(f.calls.schema, 0);
  assert.deepEqual(Object.keys(result).sort(), ['businessId','deploymentId','grantedObjects','hotelOwnerRoleId','managerRoleId','nativeScope','permissions','revision'].sort());
  assert.ok(f.roles.every(role => role.applicationId === 'app' && role.canUpdateAllSettings === false && role.canAccessAllTools === false && role.canBeAssignedToApiKeys === false));
  assert.ok(f.roles.every(role => role.objectPermissions.length === 4 && role.objectPermissions.every(permission => permission.canReadObjectRecords && permission.canUpdateObjectRecords && !permission.canSoftDeleteObjectRecords && !permission.canDestroyObjectRecords)));
  const second = await attach(config(), f.deps); assert.equal(f.calls.create, 2); assert.equal(second.managerRoleId, result.managerRoleId);
});

test('does not adopt inactive workspaces, foreign roles, elevated roles, or an incomplete stock CRM surface', async () => {
  await assert.rejects(attach(config(), fixture({ workspace: { id: scope, activationStatus: 'PENDING_CREATION' } }).deps), { code: 'ATTACH_WORKSPACE_NOT_ACTIVE' });
  const foreign = fixture(); foreign.roles.push({ id: manager, label: roleLabels(deployment).manager, applicationId: 'other', objectPermissions: [] });
  await assert.rejects(attach(config(), foreign.deps), { code: 'ATTACH_ROLE_COLLISION' });
  await assert.rejects(attach(config(), fixture({ mutateRole: role => ({ ...role, canAccessAllTools: true }) }).deps), { code: 'ATTACH_ROLE_READBACK_INVALID' });
  const incomplete = fixture(); incomplete.deps.findObjects = async () => [];
  await assert.rejects(attach(config(), incomplete.deps), { code: 'ATTACH_CRM_BASE_OBJECTS_MISSING' });
});

test('grants existing known AVA projections but rejects a conflicting durable native binding', async () => {
  const f = fixture();
  const projections = ['avaCall', 'avaCampaign'];
  f.deps.findObjects = async (_workspace, names) => ['person','company','task','note', ...projections]
    .filter(name => names.includes(name)).map((name, index) => ({ nameSingular: name, id: objectIds[index] }));
  const result = await attach(config(), f.deps);
  assert.deepEqual(result.grantedObjects, ['person','company','task','note', ...projections]);
  assert.ok(f.roles.every(role => role.objectPermissions.length === 6));
  const mismatch = fixture(); mismatch.deps.readAttachmentBinding = async () => ({ business_id: 2, deployment_id: deployment, native_scope: scope, revision: 1, enabled: true });
  await assert.rejects(attach(config(), mismatch.deps), { code: 'ATTACH_BINDING_INVALID' });
  assert.equal(mismatch.calls.create, 0);
});

test('uses a deployment-scoped PostgreSQL advisory lock and reads existing attachment binding without mutation', async () => {
  const queries = []; let released = 0;
  const dataSource = { createQueryRunner() { return { async connect() {}, async release() { released++; }, async query(sql, values) { queries.push([sql, values]); return []; } }; } };
  const unlock = await attachmentLockFor(dataSource)(config()); await unlock();
  assert.match(queries[0][0], /pg_advisory_lock/); assert.match(queries[1][0], /pg_advisory_unlock/); assert.equal(released, 1);
  const reads = [];
  const binding = await readAttachmentBinding({ async query(sql) { reads.push(sql); return reads.length === 1 ? [{ relation: 'ava_connector.deployment' }] : [{ business_id: 1, deployment_id: deployment, native_scope: scope, revision: 1, enabled: true }]; } });
  assert.equal(binding.native_scope, scope); assert.equal(reads.some(sql => /^INSERT|^UPDATE|^CREATE/i.test(sql)), false);
});

test('writes a non-secret context consumable by the guarded server, without a bootstrap owner identity', () => {
  const writes = []; const output = writeOutput({ ...config(), managerRoleId: manager, hotelOwnerRoleId: owner }, { output: '/run/out.json', fsApi: { mkdirSync(){}, writeFileSync(path, value, options) { writes.push({ path, value, options }); }, renameSync(){}, chmodSync(){} } });
  assert.deepEqual(Object.keys(output).sort(), ['businessId','deploymentId','hotelOwnerRoleId','managerRoleId','nativeScope','revision'].sort());
  assert.equal(writes[0].options.mode, 0o600); assert.equal(writes[0].value.includes('ownerUserId'), false);
});
