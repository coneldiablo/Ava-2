'use strict';
// Idempotent Community-only bootstrap. It writes only its own public.ava_bootstrap ledger.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { provisionCrmPermissions } = require('./crm-bootstrap.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = code => Object.assign(new Error(code), { code });
const compact = id => id.replaceAll('-', '').toLowerCase();
// Pinned Twenty validates native subdomains at 30 characters, not DNS's 63.
// Base36 retains the full UUID (no truncated-ID collisions) within 29 chars.
const nativeSubdomain = id => `ava-${BigInt('0x' + compact(id)).toString(36).padStart(25, '0')}`;
const safeFailure = error => `AVA_NATIVE_BOOTSTRAP_FAILED:type=${/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error?.name) ? error.name : 'Error'} code=${/^[A-Z0-9_]{1,64}$/.test(error?.code) ? error.code : 'UNCLASSIFIED'}\n`;
function readConfigFile(file) { const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > 4096) throw fail('BOOTSTRAP_CONFIG_INVALID'); return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); } }
function configFrom({ readFile = readConfigFile, env = process.env } = {}) {
  let value; try { value = JSON.parse(readFile('/run/ava/bootstrap.json', 'utf8')); } catch (_) { throw fail('BOOTSTRAP_CONFIG_INVALID'); }
  if (!value || Object.keys(value).sort().join(',') !== 'businessId,deploymentId,displayName,hostname,revision' || !Number.isSafeInteger(value.businessId) || value.businessId < 1 || !UUID.test(value.deploymentId || '') || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.displayName !== 'string' || !value.displayName.trim() || value.displayName.length > 128 || /[\x00-\x1f\x7f]/.test(value.displayName) || typeof value.hostname !== 'string') throw fail('BOOTSTRAP_CONFIG_INVALID');
  const suffix = '.crm.meludtech.tech'; const label = value.hostname.endsWith(suffix) ? value.hostname.slice(0, -suffix.length) : '';
  if (value.hostname !== value.hostname.toLowerCase() || label.length > 63 || !new RegExp(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?-${value.businessId}$`).test(label)) throw fail('BOOTSTRAP_HOSTNAME_INVALID');
  let database; try { database = new URL(env.PG_DATABASE_URL); } catch (_) { throw fail('BOOTSTRAP_DATABASE_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.pathname !== `/ava_${compact(value.deploymentId)}`) throw fail('BOOTSTRAP_DATABASE_SCOPE_INVALID');
  return Object.freeze({ ...value, displayName: value.displayName.trim(), ownerEmail: `ava-bootstrap-${compact(value.deploymentId)}@ava.invalid`, subdomain: nativeSubdomain(value.deploymentId) });
}
const roleInput = label => ({ label, canUpdateAllSettings: false, canAccessAllTools: false, canReadAllObjectRecords: false, canUpdateAllObjectRecords: false, canSoftDeleteAllObjectRecords: false, canDestroyAllObjectRecords: false, canBeAssignedToUsers: true, canBeAssignedToAgents: false, canBeAssignedToApiKeys: false });
const elevated = role => !role || role.canUpdateAllSettings || role.canAccessAllTools || role.canReadAllObjectRecords || role.canUpdateAllObjectRecords || role.canSoftDeleteAllObjectRecords || role.canDestroyAllObjectRecords || role.canBeAssignedToAgents || role.canBeAssignedToApiKeys || (role.rolePermissionFlags || []).some(flag => ['WORKSPACE','WORKSPACE_MEMBERS','ROLES','SECURITY','IMPERSONATE','SSO_BYPASS'].includes(flag.permissionFlag?.key));
async function findOwnedRole(roleService, workspaceId, label, application) {
  // getWorkspaceRoles returns DTOs without applicationId in this pinned version.
  // Read the entity before adopting a role after an interrupted create.
  const summaries = (await roleService.getWorkspaceRoles(workspaceId)).filter(role => role.label === label);
  if (summaries.length > 1) throw fail('BOOTSTRAP_ROLE_COLLISION');
  if (!summaries.length) return null;
  const role = await roleService.getRoleById(summaries[0].id, workspaceId);
  if (!role || role.applicationId !== application.id) throw fail('BOOTSTRAP_ROLE_COLLISION');
  return role;
}
function writeOutput(value, { output = '/var/lib/ava-native/bootstrap.json', fsApi = fs } = {}) {
  const safe = (({ businessId, deploymentId, revision, nativeScope, managerRoleId, hotelOwnerRoleId, ownerUserId }) => ({ businessId, deploymentId, revision, nativeScope, managerRoleId, hotelOwnerRoleId, ownerUserId }))(value);
  if (![safe.nativeScope, safe.managerRoleId, safe.hotelOwnerRoleId, safe.ownerUserId].every(id => UUID.test(id || ''))) throw fail('BOOTSTRAP_READBACK_INVALID');
  fsApi.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${process.pid}.${crypto.randomUUID()}`;
  fsApi.writeFileSync(temporary, JSON.stringify(safe), { mode: 0o600, flag: 'wx' }); fsApi.renameSync(temporary, output); fsApi.chmodSync(output, 0o600);
  return safe;
}
function ledgerFor(dataSource) {
  return {
    async lock() { const runner = dataSource.createQueryRunner(); await runner.connect(); await runner.query('SELECT pg_advisory_lock(hashtext($1))', ['ava-native-bootstrap-v1']); return async () => { try { await runner.query('SELECT pg_advisory_unlock(hashtext($1))', ['ava-native-bootstrap-v1']); } finally { await runner.release(); } }; },
    async ensure() { await dataSource.query('CREATE TABLE IF NOT EXISTS public.ava_bootstrap (deployment_id uuid PRIMARY KEY,business_id integer NOT NULL,revision integer NOT NULL,native_scope uuid,owner_user_id uuid,manager_role_id uuid,hotel_owner_role_id uuid,owner_email text NOT NULL,subdomain text NOT NULL,singleton boolean NOT NULL DEFAULT true UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(subdomain))'); },
    async get(id) { const rows = await dataSource.query('SELECT * FROM public.ava_bootstrap WHERE deployment_id=$1', [id]); return rows[0] || null; },
    async claim(config) { await dataSource.query('INSERT INTO public.ava_bootstrap(deployment_id,business_id,revision,owner_email,subdomain) VALUES($1,$2,$3,$4,$5) ON CONFLICT(deployment_id) DO NOTHING', [config.deploymentId, config.businessId, config.revision, config.ownerEmail, config.subdomain]); },
    async put(config, fields) { await dataSource.query('UPDATE public.ava_bootstrap SET native_scope=COALESCE($2,native_scope),owner_user_id=COALESCE($3,owner_user_id),manager_role_id=COALESCE($4,manager_role_id),hotel_owner_role_id=COALESCE($5,hotel_owner_role_id) WHERE deployment_id=$1', [config.deploymentId, fields.nativeScope || null, fields.ownerUserId || null, fields.managerRoleId || null, fields.hotelOwnerRoleId || null]); },
  };
}
async function bootstrap(config, deps) {
  const { ledger, signInUp, workspaceService, roleService, applicationService, workspaceRepo } = deps;
  await ledger.ensure(); const unlock = await ledger.lock(config.deploymentId); try {
  let row = await ledger.get(config.deploymentId);
  if (!row) { if (await deps.findOwnedWorkspace?.(config)) throw fail('BOOTSTRAP_OWNERSHIP_COLLISION'); await ledger.claim(config); row = await ledger.get(config.deploymentId); if (!row) throw fail('BOOTSTRAP_LEDGER_CLAIM_FAILED'); }
  if (row && (row.business_id !== config.businessId || row.revision !== config.revision || row.owner_email !== config.ownerEmail || row.subdomain !== config.subdomain)) throw fail('BOOTSTRAP_SCOPE_IMMUTABLE');
  let created;
  if (!row?.native_scope) {
    // An earlier process may have committed signup and died before checkpoint.
    // Reconcile the durable claim first, never attempt a second signup blindly.
    const recovered = await deps.findOwnedWorkspace?.(config);
    if (recovered) {
      const user = await deps.findOwnedUser?.(config, recovered.id);
      if (!user) throw fail('BOOTSTRAP_OWNERSHIP_COLLISION');
      created = { workspace: recovered, user };
    }
    try { if (!created) created = await signInUp.signUpOnNewWorkspace({ type: 'newUserWithPicture', newUserWithPicture: { email: config.ownerEmail, firstName: 'AVA', lastName: 'Bootstrap', picture: '', locale: 'en', isEmailAlreadyVerified: true } }, { displayName: config.displayName, subdomain: config.subdomain }); }
    catch (error) { const workspace = await deps.findOwnedWorkspace?.(config); const user = workspace && await deps.findOwnedUser?.(config, workspace.id); created = workspace && user ? { workspace, user } : null; if (!created) throw error; }
    if (!created?.user || !created?.workspace || created.user.email !== config.ownerEmail || created.workspace.subdomain !== config.subdomain) throw fail('BOOTSTRAP_SIGNUP_READBACK_INVALID');
    row = { ...row, native_scope: created.workspace.id, owner_user_id: created.user.id }; await ledger.put(config, { nativeScope: row.native_scope, ownerUserId: row.owner_user_id });
  }
  const workspace = created?.workspace || await workspaceRepo.findOneBy({ id: row.native_scope });
  const owner = created?.user || await deps.findOwnedUser?.(config, row.native_scope, row.owner_user_id);
  if (!workspace || workspace.subdomain !== config.subdomain || !owner || owner.email !== config.ownerEmail) throw fail('BOOTSTRAP_OWNERSHIP_COLLISION');
  if (workspace.activationStatus !== 'ACTIVE') { try { await workspaceService.activateWorkspace({ id: owner.id }, workspace); } catch (error) { const recovered = await workspaceRepo.findOneBy({ id: workspace.id }); if (!recovered || recovered.activationStatus !== 'ACTIVE') throw error; } }
  const active = await workspaceRepo.findOneBy({ id: workspace.id }); if (!active || active.activationStatus !== 'ACTIVE') throw fail('BOOTSTRAP_ACTIVATION_READBACK_INVALID');
  const apps = await applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow({ workspaceId: workspace.id });
  const ensureRole = async (key, label) => { let role = row[key] && await roleService.getRoleById(row[key], workspace.id); if (!role && deps.findOwnedRole) role = await deps.findOwnedRole(workspace.id, label, apps.workspaceCustomFlatApplication); if (!role) { try { role = await roleService.createRole({ input: roleInput(label), workspaceId: workspace.id, ownerFlatApplication: apps.workspaceCustomFlatApplication }); } catch (error) { role = await deps.findOwnedRole?.(workspace.id, label, apps.workspaceCustomFlatApplication); if (!role) throw error; } } role = await roleService.getRoleById(role.id, workspace.id); if (elevated(role) || role.label !== label || role.applicationId !== apps.workspaceCustomFlatApplication.id) throw fail('BOOTSTRAP_ROLE_READBACK_INVALID'); return role.id; };
  const managerRoleId = await ensureRole('manager_role_id', 'AVA native manager'); await ledger.put(config, { managerRoleId }); row.manager_role_id = managerRoleId;
  const hotelOwnerRoleId = await ensureRole('hotel_owner_role_id', 'AVA native hotel owner'); await ledger.put(config, { hotelOwnerRoleId });
  const result = { businessId: config.businessId, deploymentId: config.deploymentId, revision: config.revision, nativeScope: workspace.id, ownerUserId: owner.id, managerRoleId, hotelOwnerRoleId };
  await ledger.put(config, result); return result;
  } finally { await unlock?.(); }
}
async function main() {
  const config = configFrom(); const root = '/app/packages/twenty-server/dist'; const load = (file, name) => require(path.join(root, file))[name];
  const { NestFactory } = require('@nestjs/core'); const { AppModule } = require(path.join(root, 'app.module.js')); const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const ds = app.get(require('typeorm').DataSource);
    const workspaceRepo = ds.getRepository(load('engine/core-modules/workspace/workspace.entity.js', 'WorkspaceEntity'));
    const userRepo = ds.getRepository(load('engine/core-modules/user/user.entity.js', 'UserEntity'));
    const membershipRepo = ds.getRepository(load('engine/core-modules/user-workspace/user-workspace.entity.js', 'UserWorkspaceEntity'));
    const roleService = app.get(load('engine/metadata-modules/role/role.service.js', 'RoleService'));
    const result = await bootstrap(config, {
      ledger: ledgerFor(ds),
      signInUp: app.get(load('engine/core-modules/auth/services/sign-in-up.service.js', 'SignInUpService')),
      workspaceService: app.get(load('engine/core-modules/workspace/services/workspace.service.js', 'WorkspaceService')),
      roleService, applicationService: app.get(load('engine/core-modules/application/application.service.js', 'ApplicationService')),
      workspaceRepo, findOwnedWorkspace: value => workspaceRepo.findOneBy({ subdomain: value.subdomain }),
      findOwnedUser: async (value, workspaceId, userId) => {
        const user = await userRepo.findOneBy(userId ? { id: userId, email: value.ownerEmail } : { email: value.ownerEmail });
        return user && await membershipRepo.findOneBy({ userId: user.id, workspaceId }) ? user : null;
      },
      findOwnedRole: (workspaceId, label, application) => findOwnedRole(roleService, workspaceId, label, application),
    });
    const schema = await require('./schema-bootstrap.cjs').prepareWithApp(app, result);
    const flatCache = app.get(load('engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service.js', 'WorkspaceManyOrAllFlatEntityMapsCacheService'));
    const permissions = await provisionCrmPermissions(result, {
      objectPermissionService: app.get(load('engine/metadata-modules/object-permission/object-permission.service.js', 'ObjectPermissionService')),
      getRole: (id, workspaceId) => roleService.getRoleById(id, workspaceId),
      findObjects: async (workspaceId, names) => {
        const maps = await flatCache.getOrRecomputeManyOrAllFlatEntityMaps({ workspaceId, flatMapsKeys: ['flatObjectMetadataMaps'] });
        return Object.values(maps.flatObjectMetadataMaps.byUniversalIdentifier).filter(value => value && names.includes(value.nameSingular))
          .map(value => ({ id: value.id, nameSingular: value.nameSingular }));
      },
    }, { requireFullSchema: true });
    // The token is written to a separate initializer-only volume. Neither the
    // browser native process nor the gateway receives that credential volume.
    const runtime = await require('./runtime-key.cjs').prepareWithApp(app, result);
    writeOutput(result);
    const status = { businessId:result.businessId, deploymentId:result.deploymentId, revision:result.revision,
      nativeScope:result.nativeScope, schema, permissions, runtime };
    const destination = '/var/lib/ava-native/crm-bootstrap-status.json';
    const temporary = `${destination}.${crypto.randomUUID()}`;
    fs.writeFileSync(temporary, JSON.stringify(status), { flag:'wx', mode:0o600 });
    fs.renameSync(temporary, destination);
  } finally { await app.close(); }
}
if (require.main === module) main().catch(error => { process.stderr.write(safeFailure(error)); process.exitCode = 1; });
module.exports = { configFrom, bootstrap, ledgerFor, writeOutput, roleInput, findOwnedRole, nativeSubdomain, safeFailure, main };
