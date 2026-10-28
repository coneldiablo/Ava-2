'use strict';

// Attach a guarded AVA server to an already active Twenty workspace. Unlike
// bootstrap.cjs this never creates a workspace, a user, schema metadata, an
// API key, or a ledger row. It is intended for a separately bound native
// server; the existing public Twenty server remains untouched.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BASE_OBJECTS, REQUIRED_OBJECTS, provisionCrmPermissions } = require('./crm-bootstrap.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = code => Object.assign(new Error(code), { code });
const safeFailure = error => `AVA_NATIVE_ATTACH_FAILED:type=${/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error?.name) ? error.name : 'Error'} code=${/^[A-Z0-9_]{1,64}$/.test(error?.code) ? error.code : 'UNCLASSIFIED'}\n`;

function readConfig(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) || ![0, process.getuid()].includes(stat.uid)) throw fail('ATTACH_CONFIG_INVALID');
    return fs.readFileSync(fd, 'utf8');
  } catch (error) {
    if (error?.code === 'ATTACH_CONFIG_INVALID') throw error;
    throw fail('ATTACH_CONFIG_INVALID');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function configFrom({ readFile = readConfig, env = process.env } = {}) {
  if (env.AVA_NATIVE_ATTACH_EXISTING_WORKSPACE !== 'true') throw fail('ATTACH_MODE_REQUIRED');
  let value;
  try { value = JSON.parse(readFile(env.AVA_NATIVE_ATTACH_CONTEXT_FILE || '/run/ava/attach-existing-workspace.json')); }
  catch (_) { throw fail('ATTACH_CONFIG_INVALID'); }
  const keys = ['businessId', 'deploymentId', 'nativeScope', 'revision'];
  if (!value || Object.keys(value).sort().join(',') !== keys.join(',')
    || !Number.isSafeInteger(value.businessId) || value.businessId < 1
    || !UUID.test(value.deploymentId || '') || !UUID.test(value.nativeScope || '')
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || String(value.businessId) !== env.AVA_BUSINESS_ID
    || value.deploymentId !== env.AVA_DEPLOYMENT_ID
    || String(value.revision) !== env.AVA_DEPLOYMENT_REVISION) throw fail('ATTACH_CONFIG_INVALID');
  return Object.freeze({ ...value, deploymentId: value.deploymentId.toLowerCase(), nativeScope: value.nativeScope.toLowerCase() });
}

const roleLabels = deploymentId => ({
  manager: `AVA native manager ${deploymentId}`,
  hotelOwner: `AVA native hotel owner ${deploymentId}`,
});
const roleInput = label => ({ label, canUpdateAllSettings: false, canAccessAllTools: false,
  canReadAllObjectRecords: false, canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false, canDestroyAllObjectRecords: false,
  canBeAssignedToUsers: true, canBeAssignedToAgents: false, canBeAssignedToApiKeys: false });
function safeRole(role, label, application) {
  return Boolean(role && UUID.test(role.id || '') && role.label === label && role.applicationId === application.id
    && role.canUpdateAllSettings === false && role.canAccessAllTools === false
    && role.canReadAllObjectRecords === false && role.canUpdateAllObjectRecords === false
    && role.canSoftDeleteAllObjectRecords === false && role.canDestroyAllObjectRecords === false
    && role.canBeAssignedToUsers === true && role.canBeAssignedToAgents === false && role.canBeAssignedToApiKeys === false
    && !(role.rolePermissionFlags || []).length);
}

async function findOwnedRole(roleService, workspaceId, label, application) {
  const matches = (await roleService.getWorkspaceRoles(workspaceId)).filter(role => role.label === label);
  if (matches.length > 1) throw fail('ATTACH_ROLE_COLLISION');
  if (!matches.length) return null;
  const role = await roleService.getRoleById(matches[0].id, workspaceId);
  if (!safeRole(role, label, application)) throw fail('ATTACH_ROLE_COLLISION');
  return role;
}

async function ensureRole(roleService, workspaceId, label, application) {
  let role = await findOwnedRole(roleService, workspaceId, label, application);
  if (!role) {
    try { role = await roleService.createRole({ input: roleInput(label), workspaceId, ownerFlatApplication: application }); }
    catch (error) {
      role = await findOwnedRole(roleService, workspaceId, label, application);
      if (!role) throw error;
    }
  }
  role = await roleService.getRoleById(role.id, workspaceId);
  if (!safeRole(role, label, application)) throw fail('ATTACH_ROLE_READBACK_INVALID');
  return role;
}

function bindingMatches(row, config) {
  return !row || (Number(row.business_id) === config.businessId && row.deployment_id === config.deploymentId
    && row.native_scope === config.nativeScope && Number(row.revision) === config.revision && row.enabled === true);
}

function attachmentLockFor(dataSource) {
  return async config => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try { await runner.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`ava-native-attach:${config.deploymentId}`]); }
    catch (error) { await runner.release(); throw error; }
    return async () => {
      try { await runner.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`ava-native-attach:${config.deploymentId}`]); }
      finally { await runner.release(); }
    };
  };
}

async function readAttachmentBinding(dataSource) {
  const exists = await dataSource.query("SELECT to_regclass('ava_connector.deployment') AS relation");
  if (!exists?.[0]?.relation) return null;
  const rows = await dataSource.query('SELECT business_id,deployment_id,native_scope,revision,enabled FROM ava_connector.deployment WHERE singleton=true');
  if (rows.length > 1) throw fail('ATTACH_BINDING_INVALID');
  return rows[0] || null;
}

async function attach(config, deps) {
  if (typeof deps.lockAttachment !== 'function' || typeof deps.readAttachmentBinding !== 'function') throw fail('ATTACH_LOCK_REQUIRED');
  const unlock = await deps.lockAttachment(config);
  if (typeof unlock !== 'function') throw fail('ATTACH_LOCK_REQUIRED');
  try {
  const binding = await deps.readAttachmentBinding();
  if (!bindingMatches(binding, config)) throw fail('ATTACH_BINDING_INVALID');
  const workspace = await deps.workspaceRepo.findOneBy({ id: config.nativeScope });
  if (!workspace || workspace.deletedAt || workspace.activationStatus !== 'ACTIVE') throw fail('ATTACH_WORKSPACE_NOT_ACTIVE');
  const apps = await deps.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow({ workspaceId: config.nativeScope });
  const application = apps?.workspaceCustomFlatApplication;
  if (!application?.id) throw fail('ATTACH_APPLICATION_UNAVAILABLE');
  const labels = roleLabels(config.deploymentId);
  const manager = await ensureRole(deps.roleService, config.nativeScope, labels.manager, application);
  const hotelOwner = await ensureRole(deps.roleService, config.nativeScope, labels.hotelOwner, application);
  // Give customer roles their familiar AVA projection objects only when those
  // objects already exist. Unknown/new metadata and settings are never added.
  const existing = await deps.findObjects(config.nativeScope, REQUIRED_OBJECTS);
  const existingNames = new Set(existing.map(object => object.nameSingular));
  const names = REQUIRED_OBJECTS.filter(name => BASE_OBJECTS.includes(name) || existingNames.has(name));
  if (BASE_OBJECTS.some(name => !existingNames.has(name))) throw fail('ATTACH_CRM_BASE_OBJECTS_MISSING');
  const result = { businessId: config.businessId, deploymentId: config.deploymentId, revision: config.revision,
    nativeScope: config.nativeScope, managerRoleId: manager.id, hotelOwnerRoleId: hotelOwner.id };
  const permissions = await provisionCrmPermissions(result, {
    objectPermissionService: deps.objectPermissionService,
    getRole: (id, workspaceId) => deps.roleService.getRoleById(id, workspaceId),
    findObjects: deps.findObjects,
  }, { names });
  // A current business1 workspace may have additional AVA objects supplied by
  // legacy sync. Attach grants each known projection already present, but
  // never mutates custom metadata to make an old workspace look compliant.
  if (permissions.manager.objectCount !== names.length || permissions.hotelOwner.objectCount !== names.length) {
    throw fail('ATTACH_PERMISSION_READBACK_INVALID');
  }
  return { ...result, permissions, grantedObjects: names };
  } finally { await unlock(); }
}

function writeOutput(value, { output = '/var/lib/ava-native/bootstrap.json', fsApi = fs } = {}) {
  const safe = (({ businessId, deploymentId, revision, nativeScope, managerRoleId, hotelOwnerRoleId }) =>
    ({ businessId, deploymentId, revision, nativeScope, managerRoleId, hotelOwnerRoleId }))(value);
  if (!Number.isSafeInteger(safe.businessId) || safe.businessId < 1 || !Number.isSafeInteger(safe.revision) || safe.revision < 1
    || ![safe.deploymentId, safe.nativeScope, safe.managerRoleId, safe.hotelOwnerRoleId].every(value => UUID.test(value || ''))) {
    throw fail('ATTACH_OUTPUT_INVALID');
  }
  fsApi.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${process.pid}.${crypto.randomUUID()}`;
  fsApi.writeFileSync(temporary, JSON.stringify(safe), { mode: 0o600, flag: 'wx' });
  fsApi.renameSync(temporary, output); fsApi.chmodSync(output, 0o600);
  return safe;
}

async function main() {
  const config = configFrom();
  const root = '/app/packages/twenty-server/dist';
  const load = (file, name) => require(path.join(root, file))[name];
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(path.join(root, 'app.module.js'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const DataSource = require('typeorm').DataSource;
    const db = app.get(DataSource);
    const workspaceRepo = db.getRepository(load('engine/core-modules/workspace/workspace.entity.js', 'WorkspaceEntity'));
    const roleService = app.get(load('engine/metadata-modules/role/role.service.js', 'RoleService'));
    const flatCache = app.get(load('engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service.js', 'WorkspaceManyOrAllFlatEntityMapsCacheService'));
    const result = await attach(config, {
      workspaceRepo,
      roleService,
      applicationService: app.get(load('engine/core-modules/application/application.service.js', 'ApplicationService')),
      objectPermissionService: app.get(load('engine/metadata-modules/object-permission/object-permission.service.js', 'ObjectPermissionService')),
      findObjects: async (workspaceId, names) => {
        const maps = await flatCache.getOrRecomputeManyOrAllFlatEntityMaps({ workspaceId, flatMapsKeys: ['flatObjectMetadataMaps'] });
        return Object.values(maps.flatObjectMetadataMaps.byUniversalIdentifier).filter(value => value && names.includes(value.nameSingular))
          .map(value => ({ id: value.id, nameSingular: value.nameSingular }));
      },
      lockAttachment: attachmentLockFor(db),
      readAttachmentBinding: () => readAttachmentBinding(db),
    });
    writeOutput(result);
  } finally { await app.close(); }
}

if (require.main === module) main().catch(error => { process.stderr.write(safeFailure(error)); process.exitCode = 1; });

module.exports = { attach, attachmentLockFor, bindingMatches, configFrom, ensureRole, findOwnedRole, readAttachmentBinding, roleInput, roleLabels, safeFailure, safeRole, writeOutput };
