'use strict';

// AVA-owned extension of Twenty Community. No enterprise module is loaded here.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = new Set(['hotel_owner', 'manager']);
const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS ava_connector;
CREATE TABLE IF NOT EXISTS ava_connector.deployment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  business_id bigint NOT NULL, deployment_id uuid NOT NULL, native_scope uuid NOT NULL,
  revision bigint NOT NULL, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS ava_connector.identities (
  user_id text PRIMARY KEY, subject text UNIQUE NOT NULL, native_user_id uuid UNIQUE NOT NULL,
  native_membership_id uuid UNIQUE, role text NOT NULL, revision bigint NOT NULL,
  state text NOT NULL CHECK(state IN ('provisioning','active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ava_connector.sessions (
  binding_id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES ava_connector.identities(user_id),
  revision bigint NOT NULL, native_session_id uuid UNIQUE,
  encrypted_cookie text, expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('creating','active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now()
);`;

class AdapterError extends Error {
  constructor(code, status = 403) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new AdapterError(code, status); };
const hash = value => crypto.createHash('sha256').update(value).digest();
function secureEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(hash(a), hash(b));
}
function exact(body, keys) {
  if (!body || Array.isArray(body) || typeof body !== 'object' ||
      Object.keys(body).some(key => !keys.includes(key)) || keys.some(key => !(key in body))) {
    fail('invalid_request', 400);
  }
}
function text(value, max = 256) {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f]/.test(value)) fail('invalid_request', 400);
  return value;
}
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_request', 400); return value.toLowerCase(); }
function revision(value) { if (!Number.isSafeInteger(value) || value < 1) fail('invalid_revision', 400); return value; }
function readSecret(env, name) {
  const file = env[`${name}_FILE`];
  if (!file || env[name]) fail('secret_file_required', 500);
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    // Docker/Kubernetes secret mounts may be root-owned; never accept a file
    // writable/readable by group/other or owned by an unrelated account.
    const trustedRootGroupRead = stat.uid === 0 && stat.gid === process.getgid?.() && !(stat.mode & 0o037);
    if (!stat.isFile() || ((stat.mode & 0o077) && !trustedRootGroupRead) || ![0, process.getuid?.()].includes(stat.uid) || stat.size > 4096) {
      fail('secret_file_permissions', 500);
    }
    const secret = fs.readFileSync(descriptor, { encoding: 'utf8' }).trim();
    if (secret.length < 43 || secret.length > 512) fail('secret_invalid', 500);
    return secret;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    fail('secret_file_unreadable', 500);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
function configFromEnv(env = process.env) {
  const businessId = Number(env.AVA_BUSINESS_ID);
  if (!Number.isSafeInteger(businessId) || businessId < 1) fail('business_config_invalid', 500);
  const gatewaySecret = () => readSecret(env, 'AVA_NATIVE_GATEWAY_SECRET');
  const workerSecret = () => readSecret(env, 'AVA_NATIVE_WORKER_SECRET');
  if (secureEqual(gatewaySecret(), workerSecret())) fail('peer_secrets_must_differ', 500);
  const vault = readSecret(env, 'AVA_NATIVE_SESSION_KEY');
  const key = Buffer.from(vault, 'base64');
  if (key.length !== 32) fail('session_key_invalid', 500);
  const origin = new URL(env.SERVER_URL);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) fail('https_required', 500);
  if (env.AVA_NATIVE_ATTACH_EXISTING_WORKSPACE === 'true') {
    let frontend;
    try { frontend = new URL(env.FRONTEND_URL || ''); } catch (_) { fail('native_attach_frontend_origin_invalid', 500); }
    if (env.IS_MULTIWORKSPACE_ENABLED !== 'true' || frontend.protocol !== 'https:' || frontend.username || frontend.password
      || frontend.pathname !== '/' || frontend.search || frontend.hash || frontend.origin !== origin.origin) {
      fail('native_attach_frontend_origin_invalid', 500);
    }
  }
  return {
    businessId, deploymentId: uuid(env.AVA_DEPLOYMENT_ID), nativeScope: uuid(env.AVA_NATIVE_SCOPE),
    revision: revision(Number(env.AVA_DEPLOYMENT_REVISION)), gatewaySecret, workerSecret, key,
    hostname: origin.hostname, origin: origin.origin,
    roles: { hotel_owner: uuid(env.AVA_NATIVE_OWNER_ROLE_ID), manager: uuid(env.AVA_NATIVE_MANAGER_ROLE_ID) },
    port: Number(env.AVA_NATIVE_PEER_PORT || 3902), host: env.AVA_NATIVE_PEER_HOST || '0.0.0.0',
  };
}
function deterministicUserId(deploymentId, userId) {
  const bytes = hash(JSON.stringify(['ava-native-twenty-user-v1', deploymentId, userId]));
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function sealCookie(config, bindingId, cookie) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify([config.businessId, config.deploymentId, bindingId])));
  return Buffer.concat([iv, cipher.update(cookie, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
function openCookie(config, bindingId, value) {
  const data = Buffer.from(value, 'base64');
  const cipher = crypto.createDecipheriv('aes-256-gcm', config.key, data.subarray(0, 12));
  cipher.setAAD(Buffer.from(JSON.stringify([config.businessId, config.deploymentId, bindingId])));
  cipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString('utf8');
}

function createAdapter({ config, db, native, now = () => Date.now() }) {
  const scope = body => {
    if (body.businessId !== config.businessId || body.deploymentId !== config.deploymentId || body.nativeScope !== config.nativeScope) fail('scope_mismatch');
  };
  const locked = async operation => {
    const connection = db.createQueryRunner();
    await connection.connect();
    let acquired = false;
    try {
      const [result] = await connection.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [`ava-native:${config.deploymentId}`]);
      acquired = result.acquired;
      if (!acquired) fail('adapter_busy', 409);
      return await operation(connection);
    } finally {
      if (acquired) await connection.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`ava-native:${config.deploymentId}`]).catch(() => {});
      await connection.release();
    }
  };
  const deployment = async (connection = db, allowDisabled = false) => {
    const [row] = await connection.query('SELECT * FROM ava_connector.deployment WHERE singleton=true');
    if (!row || Number(row.business_id) !== config.businessId || row.deployment_id !== config.deploymentId || row.native_scope !== config.nativeScope) fail('deployment_binding_invalid');
    if (!row.enabled && !allowDisabled) fail('deployment_disabled');
    return row;
  };
  const identity = async (userId, connection = db) => {
    const [row] = await connection.query('SELECT * FROM ava_connector.identities WHERE user_id=$1', [userId]);
    if (!row) fail('identity_not_provisioned');
    return row;
  };
  async function verifyIdentity(row) {
    if (row.state !== 'active') fail('identity_not_active');
    const result = await native.readIdentity(row.native_user_id, config.nativeScope, row.native_membership_id);
    if (!result || result.disabled || result.deleted || result.canImpersonate || result.canAccessFullAdminPanel ||
        result.nativeUserId !== row.native_user_id || result.nativeScope !== config.nativeScope ||
        result.nativeMembershipId !== row.native_membership_id || result.roleElevated || result.roleIds.length !== 1 ||
        result.roleIds[0] !== config.roles[row.role]) fail('native_membership_invalid');
    return result;
  }
  async function revokeRow(row, connection = db) {
    // Tombstone first: a concurrent native request stops before cleanup
    // completes. Keep the AEAD record temporarily so a lost response can be
    // retried and the native service/cache invalidation can still be proven.
    const nativeCookie = row.encrypted_cookie ? openCookie(config, row.binding_id, row.encrypted_cookie) : null;
    await connection.query("UPDATE ava_connector.sessions SET state='revoked' WHERE binding_id=$1", [row.binding_id]);
    if (row.native_session_id) {
      const member = await identity(row.user_id, connection);
      await native.revokeSession(row.native_session_id, member.native_user_id, config.nativeScope);
      if (await native.isSessionActive(row.native_session_id)) fail('native_revoke_not_confirmed', 503);
      if (nativeCookie && await native.isSessionResolvable(nativeCookie, member.native_user_id, config.nativeScope)) fail('native_revoke_cache_not_confirmed', 503);
    }
    await connection.query('UPDATE ava_connector.sessions SET encrypted_cookie=NULL WHERE binding_id=$1', [row.binding_id]);
  }
  async function recoverOrphans(userId, connection) {
    const row = await identity(userId, connection);
    const sessions = await native.listAvaSessions(row.native_user_id, config.nativeScope);
    const known = await connection.query("SELECT native_session_id FROM ava_connector.sessions WHERE user_id=$1 AND state='active'", [userId]);
    const keep = new Set(known.map(item => item.native_session_id));
    for (const session of sessions) {
      if (!keep.has(session.id)) {
        await native.revokeSession(session.id, row.native_user_id, config.nativeScope);
        if (await native.isSessionActive(session.id)) fail('orphan_recovery_unconfirmed', 503);
      }
    }
  }
  const safeIdentity = (row, proof) => ({ businessId: config.businessId, deploymentId: config.deploymentId,
    userId: row.user_id, subject: row.subject, nativeUserId: row.native_user_id,
    nativeMembershipId: row.native_membership_id, nativeScope: config.nativeScope, role: row.role,
    revision: Number(row.revision), state: row.state,
    permissions: { platformAdmin: false, impersonation: false, nativeRoleIds: proof.roleIds, nativeMembershipVerified: true },
  });

  return {
    async initialize() {
      await db.query(SCHEMA);
      await db.query('INSERT INTO ava_connector.deployment(singleton,business_id,deployment_id,native_scope,revision) VALUES(true,$1,$2,$3,$4) ON CONFLICT(singleton) DO NOTHING', [config.businessId, config.deploymentId, config.nativeScope, config.revision]);
      await deployment(db, true);
    },
    async provision(body) {
      exact(body, ['businessId', 'deploymentId', 'nativeScope', 'userId', 'subject', 'role', 'revision', 'email', 'displayName']);
      scope(body); text(body.userId); text(body.subject); text(body.displayName, 160); text(body.email, 254); revision(body.revision);
      if (!ROLES.has(body.role) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) fail('invalid_identity', 400);
      return locked(async connection => {
        const current = await deployment(connection);
        if (Number(current.revision) !== body.revision) fail('revision_mismatch');
        const id = deterministicUserId(config.deploymentId, body.userId);
        const [existing] = await connection.query('SELECT * FROM ava_connector.identities WHERE user_id=$1 OR subject=$2 OR native_user_id=$3', [body.userId, body.subject, id]);
        if (existing && (existing.user_id !== body.userId || existing.subject !== body.subject || existing.native_user_id !== id || existing.state === 'disabled')) fail('immutable_identity_conflict', 409);
        if (existing && Number(existing.revision) > body.revision) fail('revision_mismatch');
        // The team API permits owner -> manager, never manager -> owner. This
        // monotonic downgrade uses the current deployment revision; a delayed
        // owner request cannot undo its durable fence at that same revision.
        const downgrade = existing && existing.role === 'hotel_owner' && body.role === 'manager';
        if (existing && existing.role !== body.role && !downgrade) fail('immutable_identity_conflict', 409);
        await connection.query("INSERT INTO ava_connector.identities(user_id,subject,native_user_id,role,revision,state) VALUES($1,$2,$3,$4,$5,'provisioning') ON CONFLICT(user_id) DO NOTHING", [body.userId, body.subject, id, body.role, body.revision]);
        if (existing && (downgrade || existing.state === 'provisioning' || Number(existing.revision) !== body.revision)) {
          // Commit the desired lower role before any native await. Cleanup
          // failure stays fenced; a same-role retry repeats the full sweep.
          await connection.query("UPDATE ava_connector.identities SET role=$2,revision=$3,state='provisioning' WHERE user_id=$1 AND state<>'disabled'", [body.userId, body.role, body.revision]);
          const sessions = await connection.query('SELECT * FROM ava_connector.sessions WHERE user_id=$1', [body.userId]);
          for (const session of sessions) await revokeRow(session, connection);
          await recoverOrphans(body.userId, connection);
          if ((await native.listAvaSessions(id, config.nativeScope)).length) fail('native_revoke_not_confirmed', 503);
        }
        const result = await native.provisionIdentity({ nativeUserId: id, nativeScope: config.nativeScope,
          email: body.email.toLowerCase(), displayName: body.displayName, roleId: config.roles[body.role],
          previousRoleId: body.role === 'manager' ? config.roles.hotel_owner : undefined });
        await connection.query("UPDATE ava_connector.identities SET native_membership_id=$2,revision=$3,state='active' WHERE user_id=$1 AND state<>'disabled'", [body.userId, result.nativeMembershipId, body.revision]);
        const row = await identity(body.userId, connection);
        try { return safeIdentity(row, await verifyIdentity(row)); }
        catch (error) {
          await connection.query("UPDATE ava_connector.identities SET state='provisioning' WHERE user_id=$1 AND state='active'", [body.userId]);
          throw error;
        }
      });
    },
    async verify(body) {
      exact(body, ['businessId', 'deploymentId', 'nativeScope', 'userId', 'revision']); scope(body); text(body.userId); revision(body.revision);
      const current = await deployment();
      const row = await identity(body.userId);
      if (Number(current.revision) !== body.revision || Number(row.revision) !== body.revision) fail('revision_mismatch');
      return safeIdentity(row, await verifyIdentity(row));
    },
    async createSession(body) {
      exact(body, ['businessId', 'deploymentId', 'bindingId', 'userId', 'nativeUserId', 'nativeScope', 'subject', 'role', 'revision', 'expiresAt']);
      scope(body); uuid(body.bindingId); uuid(body.nativeUserId); text(body.userId); text(body.subject); revision(body.revision);
      const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : Date.parse(body.expiresAt);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > now() + 86400000) fail('invalid_expiry', 400);
      return locked(async connection => {
        const current = await deployment(connection);
        const member = await identity(body.userId, connection);
        if (Number(current.revision) !== body.revision || Number(member.revision) !== body.revision ||
            member.subject !== body.subject || member.role !== body.role || member.native_user_id !== body.nativeUserId) fail('identity_binding_mismatch');
        await verifyIdentity(member);
        const [existing] = await connection.query('SELECT * FROM ava_connector.sessions WHERE binding_id=$1', [body.bindingId]);
        if (existing && (existing.user_id !== body.userId || Number(existing.revision) !== body.revision || existing.state === 'revoked' || new Date(existing.expires_at).getTime() !== expiresAt)) fail('session_binding_conflict', 409);
        if (existing?.state === 'active') {
          if (!await native.isSessionActive(existing.native_session_id)) fail('native_session_expired');
          return { ...body, nativeCookie: openCookie(config, body.bindingId, existing.encrypted_cookie), nativeSessionId: existing.native_session_id };
        }
        await connection.query("INSERT INTO ava_connector.sessions(binding_id,user_id,revision,expires_at,state) VALUES($1,$2,$3,$4,'creating') ON CONFLICT(binding_id) DO NOTHING", [body.bindingId, body.userId, body.revision, new Date(expiresAt)]);
        await recoverOrphans(body.userId, connection);
        const created = await native.createSession({ nativeUserId: member.native_user_id, nativeScope: config.nativeScope,
          nativeMembershipId: member.native_membership_id, expiresAt: new Date(expiresAt) });
        // Never persist the plaintext native token. A lost reply is replayed from an AEAD-bound record.
        await connection.query("UPDATE ava_connector.sessions SET native_session_id=$2,encrypted_cookie=$3,state='active' WHERE binding_id=$1 AND state='creating'", [body.bindingId, created.nativeSessionId, sealCookie(config, body.bindingId, created.nativeCookie)]);
        if (!await native.isSessionActive(created.nativeSessionId)) fail('native_session_readback_failed', 503);
        return { ...body, nativeCookie: created.nativeCookie, nativeSessionId: created.nativeSessionId };
      });
    },
    async revoke(body) {
      exact(body, ['bindingId']); uuid(body.bindingId);
      return locked(async connection => {
        const [row] = await connection.query('SELECT * FROM ava_connector.sessions WHERE binding_id=$1', [body.bindingId]);
        if (row) { await revokeRow(row, connection); await recoverOrphans(row.user_id, connection); }
        return { bindingId: body.bindingId, nativeSessionAbsent: true };
      });
    },
    async disable(body) {
      exact(body, ['businessId', 'deploymentId', 'nativeScope', 'revision']); scope(body); revision(body.revision);
      return locked(async connection => {
        const current = await deployment(connection, true);
        if (body.revision <= Number(current.revision) && current.enabled) fail('new_revision_required', 409);
        if (body.revision < Number(current.revision)) fail('revision_mismatch');
        await connection.query('UPDATE ava_connector.deployment SET enabled=false,revision=$1 WHERE singleton=true', [body.revision]);
        await connection.query("UPDATE ava_connector.identities SET state='disabled'");
        const sessions = await connection.query('SELECT * FROM ava_connector.sessions');
        for (const row of sessions) await revokeRow(row, connection);
        const members = await connection.query('SELECT * FROM ava_connector.identities');
        for (const member of members) await recoverOrphans(member.user_id, connection);
        return { businessId: config.businessId, deploymentId: config.deploymentId, revision: body.revision, state: 'disabled', nativeSessionsAbsent: true };
      });
    },
    async authorizeNative(bindingId, cookie) {
      uuid(bindingId);
      const current = await deployment();
      const [session] = await db.query('SELECT * FROM ava_connector.sessions WHERE binding_id=$1', [bindingId]);
      if (!session || session.state !== 'active' || Number(session.revision) !== Number(current.revision) || new Date(session.expires_at).getTime() <= now()) fail('native_access_revoked');
      const member = await identity(session.user_id);
      if (Number(member.revision) !== Number(current.revision)) fail('native_access_revoked');
      await verifyIdentity(member);
      const expected = openCookie(config, bindingId, session.encrypted_cookie);
      if (typeof cookie !== 'string' || !secureEqual(cookie, expected)) fail('native_cookie_mismatch');
      if (!await native.isSessionActive(session.native_session_id)) fail('native_access_revoked');
      return true;
    },
  };
}

function peerServer(adapter, config) {
  const routes = {
    '/v1/sessions/create': ['gateway', 'createSession'], '/v1/sessions/revoke': ['gateway', 'revoke'],
    '/v1/provision': ['worker', 'provision'], '/v1/reconcile': ['worker', 'provision'],
    '/v1/verify': ['worker', 'verify'], '/v1/disable': ['worker', 'disable'],
  };
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000 }, async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      const route = routes[request.url];
      if (request.method !== 'POST' || !route) fail('not_found', 404);
      if (request.headers.origin || request.headers.cookie || request.headers['sec-fetch-site']) fail('browser_request_forbidden');
      const expected = route[0] === 'gateway' ? config.gatewaySecret() : config.workerSecret();
      if (!secureEqual(request.headers.authorization, `Bearer ${expected}`)) fail('peer_unauthorized', 401);
      if ((request.headers['content-type'] || '').split(';')[0] !== 'application/json') fail('json_required', 415);
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 8192) fail('body_too_large', 413); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('invalid_json', 400); }
      send(200, await adapter[route[1]](body));
    } catch (error) { send(error instanceof AdapterError ? error.status : 503, { error: error instanceof AdapterError ? error.code : 'native_adapter_unavailable' }); }
  });
  server.maxConnections = 64;
  return server;
}

module.exports = { AdapterError, SCHEMA, configFromEnv, createAdapter, peerServer, secureEqual, deterministicUserId, sealCookie, openCookie };
