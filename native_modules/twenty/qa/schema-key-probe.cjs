'use strict';

// This probe rotates a credential. It is deliberately fenced to the two
// disposable recipe-QA contours and is never buyer acceptance evidence.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERSISTED_KEYS = ['businessId', 'deploymentId', 'hotelOwnerRoleId', 'managerRoleId', 'nativeScope', 'ownerUserId', 'revision'];
const secretPath = '/var/lib/ava-runtime-credentials/runtime.key';
const fail = code => Object.assign(new Error(code), { code });
function openNoFollow(file, code) {
  try {
    return fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch {
    throw fail(code);
  }
}

function readJson(file) {
  const fd = openNoFollow(file, 'QA_CONTEXT_INVALID');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 8192 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw fail('QA_CONTEXT_INVALID');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error?.code && /^QA_/.test(error.code)) throw error;
    throw fail('QA_CONTEXT_INVALID');
  } finally {
    fs.closeSync(fd);
  }
}

function readSecret(file = secretPath) {
  const fd = openNoFollow(file, 'QA_RUNTIME_FILE_UNSAFE');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size < 32 || stat.size > 16384 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw fail('QA_RUNTIME_FILE_UNSAFE');
    const value = fs.readFileSync(fd, 'utf8');
    if (/[\r\n\0]/.test(value)) throw fail('QA_RUNTIME_FILE_UNSAFE');
    return value;
  } finally {
    fs.closeSync(fd);
  }
}

function validateQa(config, persisted, env = process.env) {
  const expectedHost = `recipe-qa-${config?.businessId}.crm.meludtech.tech`;
  if (env.AVA_NATIVE_QA !== 'true' || ![900011, 900012].includes(config?.businessId) ||
      config.hostname !== expectedHost || env.SERVER_URL !== `https://${expectedHost}`) throw fail('QA_SCOPE_REQUIRED');
  if (!persisted || Object.keys(persisted).sort().join(',') !== [...PERSISTED_KEYS].sort().join(',') ||
      persisted.businessId !== config.businessId || persisted.deploymentId !== config.deploymentId ||
      persisted.revision !== config.revision || !Number.isSafeInteger(persisted.revision) || persisted.revision < 1 ||
      ![persisted.deploymentId, persisted.nativeScope, persisted.hotelOwnerRoleId, persisted.managerRoleId, persisted.ownerUserId]
        .every(value => UUID.test(value || ''))) throw fail('QA_CONTEXT_SCOPE_INVALID');
  return Object.freeze({ ...persisted, hostname:config.hostname });
}

const digest = value => crypto.createHash('sha256').update(value).digest();
const sameDigest = (left, right) => left.length === right.length && crypto.timingSafeEqual(left, right);
const fileIsSafe = stat => Boolean(stat?.regular && !stat.symlink && (stat.mode & 0o777) === 0o600);
const ledgerMatches = (row, context) => Boolean(row && row.deploymentId === context.deploymentId &&
  row.workspaceId === context.nativeScope && row.revision === context.revision && row.disabled === false);

async function runProbe(context, ops) {
  const initialToken = ops.readSecret();
  const initialDigest = digest(initialToken);
  if (!fileIsSafe(ops.statSecret())) throw fail('QA_RUNTIME_FILE_UNSAFE');

  const schema = await ops.schemaReplay(context);
  if (!schema?.ready || schema.objectsCreated !== 0 || schema.fieldsCreated !== 0) throw fail('QA_SCHEMA_REPLAY_NOT_IDEMPOTENT');

  const first = await ops.runtimeReplay(context);
  const replayedToken = ops.readSecret();
  if (!first?.nativeKeyId || !first.roleId || !sameDigest(initialDigest, digest(replayedToken))) throw fail('QA_RUNTIME_REPLAY_NOT_IDEMPOTENT');

  const initialLedger = await ops.getLedger(context.deploymentId);
  if (!ledgerMatches(initialLedger, context) || initialLedger.activeKeyId !== first.nativeKeyId ||
      !Number.isSafeInteger(initialLedger.activeGeneration) || initialLedger.activeGeneration < 1 ||
      initialLedger.roleId !== first.roleId) throw fail('QA_RUNTIME_KEY_SCOPE_INVALID');

  const payload = await ops.verifySignature(replayedToken);
  if (payload?.type !== 'API_KEY' || payload.jti !== first.nativeKeyId || payload.sub !== context.nativeScope ||
      payload.workspaceId !== context.nativeScope) throw fail('QA_RUNTIME_SIGNATURE_INVALID');
  const nativeKey = await ops.validateKey(first.nativeKeyId, context.nativeScope);
  if (nativeKey?.id !== first.nativeKeyId || nativeKey.workspaceId !== context.nativeScope || nativeKey.revokedAt) throw fail('QA_RUNTIME_KEY_SCOPE_INVALID');
  const roleId = await ops.roleForKey(first.nativeKeyId, context.nativeScope);
  const role = await ops.getRole(roleId, context.nativeScope);
  if (roleId !== first.roleId || !ops.roleSafe(role, context)) throw fail('QA_RUNTIME_ROLE_SCOPE_INVALID');

  // Exercise the real rotation path without altering expiry in SQL: the runtime
  // receives a virtual clock one millisecond inside its configured threshold.
  const expiresAt = new Date(first.expiresAt).getTime();
  const rotateNow = expiresAt - ops.rotateBeforeMs + 1;
  if (!Number.isSafeInteger(rotateNow) || rotateNow <= Date.now() || rotateNow >= expiresAt) throw fail('QA_ROTATION_CLOCK_INVALID');
  const rotated = await ops.rotate(context, rotateNow);
  const rotatedToken = ops.readSecret();
  if (!rotated?.nativeKeyId || rotated.nativeKeyId === first.nativeKeyId ||
      sameDigest(initialDigest, digest(rotatedToken)) || !fileIsSafe(ops.statSecret())) throw fail('QA_ROTATION_NOT_PROVEN');

  const rotatedPayload = await ops.verifySignature(rotatedToken);
  const newKey = await ops.validateKey(rotated.nativeKeyId, context.nativeScope);
  const rotatedRoleId = await ops.roleForKey(rotated.nativeKeyId, context.nativeScope);
  const rotatedRole = await ops.getRole(rotatedRoleId, context.nativeScope);
  const old = await ops.findKey(first.nativeKeyId, context.nativeScope);
  let oldAccessRefused = false;
  try {
    await ops.validateKey(first.nativeKeyId, context.nativeScope);
  } catch (error) {
    oldAccessRefused = error?.code === 'API_KEY_REVOKED';
  }
  const active = await ops.getLedger(context.deploymentId);
  if (rotatedPayload?.type !== 'API_KEY' || rotatedPayload.jti !== rotated.nativeKeyId ||
      rotatedPayload.sub !== context.nativeScope || rotatedPayload.workspaceId !== context.nativeScope ||
      newKey?.id !== rotated.nativeKeyId || newKey.workspaceId !== context.nativeScope || newKey.revokedAt ||
      rotated.roleId !== roleId || rotatedRoleId !== roleId || !ops.roleSafe(rotatedRole, context) ||
      !old?.revokedAt || !oldAccessRefused ||
      !ledgerMatches(active, context) || active.activeKeyId !== rotated.nativeKeyId ||
      active.activeGeneration !== initialLedger.activeGeneration + 1 || active.roleId !== roleId ||
      active.candidateKeyId != null || active.candidateGeneration != null) throw fail('QA_ROTATION_READBACK_INVALID');

  let foreignRefused = false;
  try {
    await ops.foreignRevision({ ...context, revision:context.revision + 1 }, rotateNow);
  } catch (error) {
    foreignRefused = error?.code === 'AVA_RUNTIME_KEY_FENCED';
  }
  if (!foreignRefused) throw fail('QA_FOREIGN_REVISION_ACCEPTED');
  const afterForeign = await ops.getLedger(context.deploymentId);
  const finalToken = ops.readSecret();
  if (!ledgerMatches(afterForeign, context) || afterForeign.activeKeyId !== rotated.nativeKeyId ||
      afterForeign.activeGeneration !== active.activeGeneration ||
      !sameDigest(digest(rotatedToken), digest(finalToken)) || !fileIsSafe(ops.statSecret())) throw fail('QA_FOREIGN_REVISION_MUTATED');

  return {
    qa_only:true,
    buyer_acceptance:false,
    business_id:context.businessId,
    deployment_id:context.deploymentId,
    native_scope:context.nativeScope,
    ids:{ initial_native_key_id:first.nativeKeyId, rotated_native_key_id:rotated.nativeKeyId, runtime_role_id:roleId },
    checks:{ context_scope:true, schema_replay_zero_creates:true, runtime_replay_same_key:true,
      runtime_secret_unchanged_on_replay:true, runtime_file_0600:true, native_signature_valid:true,
      native_key_active:true, native_role_scope_exact:true, rotation_new_active:true,
      rotation_old_revoked:true, foreign_revision_refused:true },
  };
}
async function nativeOps(app, context) {
  const root = '/app/packages/twenty-server/dist';
  const load = (file, name) => require(path.join(root, file))[name];
  const runtime = require('../runtime-key.cjs');
  const schema = require('../schema-bootstrap.cjs');
  const DataSource = require('typeorm').DataSource;
  const ds = app.get(DataSource);
  const applicationService = app.get(load('engine/core-modules/application/application.service.js', 'ApplicationService'));
  const apps = await applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow({ workspaceId:context.nativeScope });
  const apiKeyService = app.get(load('engine/core-modules/api-key/services/api-key.service.js', 'ApiKeyService'));
  const roleService = app.get(load('engine/metadata-modules/role/role.service.js', 'RoleService'));
  const apiKeyRoleService = app.get(load('engine/core-modules/api-key/services/api-key-role.service.js', 'ApiKeyRoleService'));
  const jwt = app.get(load('engine/core-modules/jwt/services/jwt-wrapper.service.js', 'JwtWrapperService'));
  const deps = {
    apiKeyService,
    roleService,
    roleTargetService:app.get(load('engine/metadata-modules/role-target/services/role-target.service.js', 'RoleTargetService')),
    objectPermissionService:app.get(load('engine/metadata-modules/object-permission/object-permission.service.js', 'ObjectPermissionService')),
    flatCache:app.get(load('engine/metadata-modules/flat-entity/services/workspace-many-or-all-flat-entity-maps-cache.service.js', 'WorkspaceManyOrAllFlatEntityMapsCacheService')),
    ownerFlatApplication:apps.workspaceCustomFlatApplication,
    ledger:runtime.ledgerFor(ds),
    output:secretPath,
  };
  return {
    rotateBeforeMs:runtime.DEFAULT_ROTATE_BEFORE,
    readSecret:() => readSecret(),
    statSecret:() => { const stat=fs.lstatSync(secretPath); return { regular:stat.isFile(), symlink:stat.isSymbolicLink(), mode:stat.mode }; },
    schemaReplay:value => schema.prepareWithApp(app, value),
    runtimeReplay:value => runtime.prepareWithApp(app, value),
    verifySignature:token => jwt.verifyJwtToken(token),
    validateKey:(id, workspace) => apiKeyService.validateApiKey(id, workspace),
    findKey:(id, workspace) => apiKeyService.findById(id, workspace),
    roleForKey:(id, workspace) => apiKeyRoleService.getRoleIdForApiKeyId(id, workspace),
    getRole:(id, workspace) => roleService.getRoleById(id, workspace),
    roleSafe:(role, value) => runtime.safeRole(role, value, apps.workspaceCustomFlatApplication),
    getLedger:id => deps.ledger.get(id),
    rotate:(value, now) => runtime.prepare(value, { ...deps, now:() => now }),
    foreignRevision:(value, now) => runtime.prepare(value, { ...deps, now:() => now }),
  };
}

async function main() {
  const { configFrom } = require('../bootstrap.cjs');
  const config = configFrom();
  const persisted = readJson('/var/lib/ava-native/bootstrap.json');
  const context = validateQa(config, persisted);
  const root = '/app/packages/twenty-server/dist';
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(path.join(root, 'app.module.js'));
  const app = await NestFactory.createApplicationContext(AppModule, { logger:false });
  try {
    return await runProbe(context, await nativeOps(app, context));
  } finally {
    await app.close();
  }
}

const safeFailure = error => `${/^[A-Z0-9_]{1,64}$/.test(error?.code || '') ? error.code : 'QA_SCHEMA_KEY_FAILED'}\n`;
if (require.main === module) main().then(value => process.stdout.write(`${JSON.stringify(value)}\n`)).catch(error => {
  process.stderr.write(safeFailure(error));
  process.exitCode = 1;
});
module.exports = { digest, main, nativeOps, readJson, readSecret, runProbe, safeFailure, sameDigest, validateQa };
