'use strict';

// Run inside the pinned Twenty Community server image with NODE_OPTIONS unset.
// It calls upstream services; it never inserts core/workspace tables directly.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = '/app/packages/twenty-server/dist';
const load = (file, name) => require(path.join(root, file))[name];
const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`missing_${name}`);
  return value;
};
const assertQa = () => {
  if (process.env.AVA_NATIVE_QA !== 'true') throw new Error('AVA_NATIVE_QA_required');
  const database = required('AVA_QA_DATABASE_NAME');
  if (!/^ava_native_qa_[a-z0-9_]+$/.test(database)) throw new Error('qa_database_name_required');
  if (!required('PG_DATABASE_URL').endsWith(`/${database}`)) throw new Error('qa_database_url_mismatch');
};
const writeContext = value => {
  const target = required('AVA_QA_CONTEXT_FILE');
  if (fs.existsSync(target)) throw new Error('qa_context_must_not_exist');
  fs.writeFileSync(target, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
};
const elevated = role => Boolean(role.canUpdateAllSettings || role.canAccessAllTools || role.canReadAllObjectRecords ||
  role.canUpdateAllObjectRecords || role.canSoftDeleteAllObjectRecords || role.canDestroyAllObjectRecords ||
  (role.rolePermissionFlags || []).some(flag => ['WORKSPACE', 'WORKSPACE_MEMBERS', 'ROLES', 'SECURITY', 'IMPERSONATE', 'SSO_BYPASS'].includes(flag.permissionFlag?.key)));

const safeFailure = error => {
  const type = /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error?.name) ? error.name : 'Error';
  const code = /^[A-Z0-9_]{1,64}$/.test(error?.code) ? error.code : 'UNCLASSIFIED';
  const match = String(error?.stack || '').match(/bootstrap\.cjs:(\d+):(\d+)/);
  const frame = match ? `${match[1]}:${match[2]}` : 'unknown';
  return `AVA_QA_BOOTSTRAP_FAILED:type=${type} code=${code} frame=${frame}\n`;
};

(async () => {
  assertQa();
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(path.join(root, 'app.module.js'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const { DataSource } = require('typeorm');
    const signInUp = app.get(load('engine/core-modules/auth/services/sign-in-up.service.js', 'SignInUpService'));
    const workspaceService = app.get(load('engine/core-modules/workspace/services/workspace.service.js', 'WorkspaceService'));
    const roleService = app.get(load('engine/metadata-modules/role/role.service.js', 'RoleService'));
    const applicationService = app.get(load('engine/core-modules/application/application.service.js', 'ApplicationService'));
    const workspaceRepo = app.get(DataSource).getRepository(load('engine/core-modules/workspace/workspace.entity.js', 'WorkspaceEntity'));
    const run = crypto.randomUUID();
    const ownerEmail = `ava-qa-owner-${run}@qa.invalid`;
    const { user: owner, workspace } = await signInUp.signUpOnNewWorkspace({
      type: 'newUserWithPicture',
      newUserWithPicture: { email: ownerEmail, firstName: 'AVA', lastName: 'QA', picture: '', locale: 'en', isEmailAlreadyVerified: true },
    }, { displayName: `AVA native QA ${run.slice(0, 8)}`, subdomain: `ava-native-qa-${run.slice(0, 12)}` });
    await workspaceService.activateWorkspace({ id: owner.id }, workspace);
    const active = await workspaceRepo.findOneBy({ id: workspace.id });
    if (!active || active.activationStatus !== 'ACTIVE') throw new Error('qa_workspace_not_active');
    const applications = await applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow({ workspaceId: workspace.id });
    const roleInput = label => ({ label, canUpdateAllSettings: false, canAccessAllTools: false,
      canReadAllObjectRecords: false, canUpdateAllObjectRecords: false, canSoftDeleteAllObjectRecords: false,
      canDestroyAllObjectRecords: false, canBeAssignedToUsers: true, canBeAssignedToAgents: false, canBeAssignedToApiKeys: false });
    const manager = await roleService.createRole({ input: roleInput('AVA QA manager'), workspaceId: workspace.id,
      ownerFlatApplication: applications.workspaceCustomFlatApplication });
    const hotelOwner = await roleService.createRole({ input: roleInput('AVA QA hotel owner'), workspaceId: workspace.id,
      ownerFlatApplication: applications.workspaceCustomFlatApplication });
    const readManager = await roleService.getRoleById(manager.id, workspace.id);
    const readOwner = await roleService.getRoleById(hotelOwner.id, workspace.id);
    if (!readManager || !readOwner || elevated(readManager) || elevated(readOwner) || owner.email !== ownerEmail) throw new Error('qa_role_or_owner_readback_failed');
    writeContext({ businessId: Number(required('AVA_QA_BUSINESS_ID')), deploymentId: required('AVA_QA_DEPLOYMENT_ID'),
      nativeScope: workspace.id, revision: Number(required('AVA_QA_REVISION')), ownerUserId: owner.id,
      ownerEmail, managerRoleId: manager.id, hotelOwnerRoleId: hotelOwner.id });
  } finally { await app.close(); }
})().catch(error => { process.stderr.write(safeFailure(error)); process.exitCode = 1; });
