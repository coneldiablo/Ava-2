'use strict';

// Real-peer acceptance client. It deliberately has no fixture/native mock:
// the target must be the QA-only Twenty container built from ../Dockerfile.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`missing_${name}`);
  return value;
};
const assertQaOrigin = name => {
  if (process.env.AVA_NATIVE_QA !== 'true') throw new Error('AVA_NATIVE_QA_required');
  const value = required(name);
  const origin = new URL(value);
  const hosts = new Set(required('AVA_QA_PRIVATE_HOSTS').split(',').map(host => host.trim()).filter(Boolean));
  if (!hosts.has(origin.hostname) || !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/') throw new Error('qa_private_origin_required');
  return origin.origin;
};
const secret = name => fs.readFileSync(required(`${name}_FILE`), 'utf8').trim();
const contextPath = () => required('AVA_QA_CONTEXT_FILE');
const loadContext = () => JSON.parse(fs.readFileSync(contextPath(), 'utf8'));
const saveContext = value => fs.writeFileSync(contextPath(), JSON.stringify(value), { mode: 0o600 });
const post = async (url, headers, body) => {
  const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10_000), headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(`peer_${response.status}_${value.error || 'failed'}`);
  return value;
};
const uuid = () => crypto.randomUUID();

async function mint() {
  const ctx = loadContext();
  // qa-bootstrap creates this workspace and both reviewed non-admin roles in
  // an otherwise empty QA database; this probe creates no shared identity.
  const userId = uuid();
  const common = { businessId: ctx.businessId, deploymentId: ctx.deploymentId, nativeScope: ctx.nativeScope, revision: ctx.revision };
  const worker = { authorization: `Bearer ${secret('AVA_NATIVE_WORKER_SECRET')}` };
  const provision = await post(`${assertQaOrigin('AVA_QA_PEER_URL')}/v1/provision`, worker, {
    ...common, userId, subject: `qa:${userId}`, role: 'manager', email: `qa-${userId}@qa.invalid`, displayName: 'AVA QA',
  });
  const bindingId = uuid();
  const session = await post(`${assertQaOrigin('AVA_QA_PEER_URL')}/v1/sessions/create`,
    { authorization: `Bearer ${secret('AVA_NATIVE_GATEWAY_SECRET')}` }, {
      businessId: ctx.businessId, deploymentId: ctx.deploymentId, bindingId, userId,
      nativeUserId: provision.nativeUserId, nativeScope: ctx.nativeScope, subject: provision.subject,
      role: provision.role, revision: ctx.revision, expiresAt: Date.now() + 5 * 60_000,
    });
  saveContext({ ...ctx, userId, bindingId, nativeUserId: provision.nativeUserId, nativeCookie: session.nativeCookie, nativeSessionId: session.nativeSessionId });
}

async function resolve(expectAllowed) {
  const ctx = loadContext();
  const response = await fetch(`${assertQaOrigin('AVA_QA_TWENTY_URL')}/metadata`, { method: 'POST', signal: AbortSignal.timeout(10_000), headers: {
    'content-type': 'application/json', cookie: ctx.nativeCookie,
    origin: required('SERVER_URL'),
    'x-ava-native-peer': secret('AVA_NATIVE_GATEWAY_SECRET'), 'x-ava-native-binding': ctx.bindingId,
  }, body: JSON.stringify({ operationName: 'CurrentNativeSession', query: 'query CurrentNativeSession { currentUser { id } currentUserSessions { id workspaceId authProvider userAgent isCurrent } }' }) });
  if (!expectAllowed) {
    if (response.status !== 403) throw new Error('native_revoke_not_denied');
    return;
  }
  const value = await response.json();
  if (!response.ok || value.errors?.length || value.data?.currentUser?.id !== ctx.nativeUserId) {
    // Native error messages can contain data; emit only status/code shape.
    process.stderr.write(JSON.stringify({ stage: 'native_resolve', status: response.status,
      guardCode: typeof value.code === 'string' && /^[a-z_]{1,64}$/.test(value.code) ? value.code : null,
      graphqlErrorCount: Array.isArray(value.errors) ? value.errors.length : 0,
      errorCodes: (value.errors || []).map(item => /^[A-Z_]{1,64}$/.test(item.extensions?.code) ? item.extensions.code : 'UNCLASSIFIED'),
      currentUserPresent: Boolean(value.data?.currentUser), currentUserMatches: value.data?.currentUser?.id === ctx.nativeUserId }) + '\n');
    throw new Error('native_resolve_invalid');
  }
  const session = value.data.currentUserSessions?.find(item => item.id === ctx.nativeSessionId);
  if (!session || session.workspaceId !== ctx.nativeScope || session.authProvider !== 'sso' || session.userAgent !== 'ava-native' || session.isCurrent !== true) throw new Error('native_session_readback_invalid');
  const origin = assertQaOrigin('AVA_QA_TWENTY_URL');
  const payload = JSON.stringify({ operationName: 'CurrentNativeSession', query: 'query CurrentNativeSession { currentUser { id } }' });
  const direct = await fetch(`${origin}/metadata`, { method: 'POST', signal: AbortSignal.timeout(10_000), headers: {
    'content-type': 'application/json', cookie: ctx.nativeCookie, origin: required('SERVER_URL'),
  }, body: payload });
  if (direct.status !== 403) throw new Error('native_guard_missing_peer_not_denied');
  const wrongBinding = await fetch(`${origin}/metadata`, { method: 'POST', signal: AbortSignal.timeout(10_000), headers: {
    'content-type': 'application/json', cookie: ctx.nativeCookie, origin: required('SERVER_URL'),
    'x-ava-native-peer': secret('AVA_NATIVE_GATEWAY_SECRET'), 'x-ava-native-binding': uuid(),
  }, body: payload });
  if (wrongBinding.status !== 403) throw new Error('native_guard_wrong_binding_not_denied');
}

async function revoke() {
  const ctx = loadContext();
  const value = await post(`${assertQaOrigin('AVA_QA_PEER_URL')}/v1/sessions/revoke`,
    { authorization: `Bearer ${secret('AVA_NATIVE_GATEWAY_SECRET')}` }, { bindingId: ctx.bindingId });
  if (!value.nativeSessionAbsent) throw new Error('native_revoke_not_confirmed');
  // The peer returns only its stable contract. Its success now includes an
  // internal UserSessionService.resolveSession cache-path rejection of the
  // old encrypted native cookie; no token/cookie is echoed for this proof.
  process.stderr.write(JSON.stringify({ stage: 'native_revoke', cachePathRejected: true }) + '\n');
}

const mode = required('AVA_QA_MODE');
const safeFailure = error => {
  const type = /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error?.name) ? error.name : 'Error';
  const code = /^[A-Z0-9_]{1,64}$/.test(error?.code) ? error.code : 'UNCLASSIFIED';
  const match = String(error?.stack || '').match(/acceptance-probe\.cjs:(\d+):(\d+)/);
  return `AVA_QA_PROBE_FAILED:type=${type} code=${code} frame=${match ? `${match[1]}:${match[2]}` : 'unknown'}\n`;
};
(async () => {
  if (mode === 'mint') await mint();
  else if (mode === 'resolve') await resolve(true);
  else if (mode === 'revoke') { await revoke(); await resolve(false); }
  else throw new Error('invalid_AVA_QA_MODE');
})().catch(error => { process.stderr.write(safeFailure(error)); process.exitCode = 1; });
