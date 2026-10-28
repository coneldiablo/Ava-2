'use strict';

// Loaded once by Twenty's normal Nest bootstrap. Imports are resolved from the
// pinned image, so sessions and membership use the installed native services.
const path = require('node:path');
const { configFromEnv, createAdapter, peerServer, secureEqual, AdapterError } = require('./adapter.cjs');

const NATIVE_AUTH_MUTATIONS = new Set([
  'getAuthorizationUrlForSSO', 'getLoginTokenFromCredentials', 'signIn',
  'verifyEmailAndGetLoginToken', 'verifyEmailAndGetWorkspaceAgnosticToken',
  'getAuthTokensFromOTP', 'signUp', 'signUpInWorkspace', 'signUpInNewWorkspace',
  'generateTransientToken', 'getAuthTokensFromLoginToken', 'getAuthTokensFromSSOExchangeToken',
  'authorizeApp', 'renewToken', 'generateApiKeyToken', 'generatePlaygroundToken',
  'emailPasswordResetLink', 'updatePasswordViaResetToken', 'revokeUserSession', 'revokeAllOtherUserSessions',
]);
const isNativeGraphqlPath = pathname => pathname === '/graphql' || pathname === '/metadata';

function assertSafeGraphqlDocument(body) {
  // Batches and persisted operations cannot be tied to a visible document, so
  // they are not acceptable on the private native path.
  if (!body || Array.isArray(body) || typeof body !== 'object' || typeof body.query !== 'string' || !body.query.trim() || body.extensions) {
    throw new AdapterError('native_graphql_unverifiable');
  }
  let document;
  try {
    document = require('graphql').parse(body.query, { noLocation: true });
  } catch {
    throw new AdapterError('native_graphql_malformed');
  }
  let forbidden = false;
  require('graphql').visit(document, {
    Field(node) { if (NATIVE_AUTH_MUTATIONS.has(node.name.value)) forbidden = true; },
  });
  if (forbidden) throw new AdapterError('native_auth_mutation_forbidden');
}

function assertCappedResolvedSession(resolved, nativeUserId, nativeScope, capped) {
  const expiry = new Date(resolved?.expiresAt).getTime();
  if (resolved?.payload?.workspaceId !== nativeScope || resolved?.payload?.userId !== nativeUserId ||
      !Number.isFinite(expiry) || expiry > capped.getTime()) throw new AdapterError('native_session_scope_invalid', 503);
}

async function isNativeSessionResolvable(sessionService, nativeCookie, userId, workspaceId) {
  const match = typeof nativeCookie === 'string' && nativeCookie.match(/^__Host-twenty-session=([^;]+)$/);
  if (!match) throw new AdapterError('native_cookie_invalid', 503);
  let token;
  try { token = decodeURIComponent(match[1]); }
  catch { throw new AdapterError('native_cookie_invalid', 503); }
  try {
    const resolved = await sessionService.resolveSession(token);
    if (resolved?.payload?.userId !== userId || resolved?.payload?.workspaceId !== workspaceId) {
      throw new AdapterError('native_session_identity_mismatch', 503);
    }
    return true;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    // Pinned UserSessionService uses AuthExceptionCode.UNAUTHENTICATED for an
    // invalid, expired or revoked token. Redis/DB and other failures are not
    // revoke proof and must retain the encrypted record for a retry.
    if (error?.code === 'UNAUTHENTICATED') return false;
    throw new AdapterError('native_session_cache_unverifiable', 503);
  }
}

const roleIsElevated = role => Boolean(role?.canUpdateAllSettings || role?.canAccessAllTools ||
  role?.canReadAllObjectRecords || role?.canUpdateAllObjectRecords || role?.canSoftDeleteAllObjectRecords ||
  role?.canDestroyAllObjectRecords || (role?.rolePermissionFlags || []).some(item =>
    ['WORKSPACE', 'WORKSPACE_MEMBERS', 'ROLES', 'SECURITY', 'IMPERSONATE', 'SSO_BYPASS'].includes(item?.permissionFlag?.key)));

async function reconcileNativeRole({ roleService, nativeScope, membershipId, roleId, previousRoleId }) {
  const args = { userWorkspaceIds: [membershipId], workspaceId: nativeScope };
  const roles = (await roleService.getRolesByUserWorkspaces(args)).get(membershipId) || [];
  const replacingProvedRole = roles.length === 1 && previousRoleId && previousRoleId !== roleId && roles[0].id === previousRoleId;
  if (roles.length && (roles.length !== 1 || (roles[0].id !== roleId && !replacingProvedRole))) throw new AdapterError('native_role_conflict', 409);
  if (roles.some(roleIsElevated)) throw new AdapterError('native_elevated_role_forbidden', 409);
  // Pinned sdk/v2.37 UserRoleService -> RoleTargetService.createMany replaces
  // the old userWorkspace target through its own metadata migration/cache path.
  if (!roles.length || replacingProvedRole) await roleService.assignRoleToManyUserWorkspace({ workspaceId: nativeScope, userWorkspaceIds: [membershipId], roleId });
  const verified = (await roleService.getRolesByUserWorkspaces(args)).get(membershipId) || [];
  if (verified.length !== 1 || verified[0].id !== roleId || verified.some(roleIsElevated)) throw new AdapterError('native_role_readback_invalid', 503);
}

function nativeFromApp(app, root) {
  const load = (file, name) => require(path.join(root, file))[name];
  const { DataSource, IsNull, MoreThan } = require('typeorm');
  const db = app.get(DataSource);
  const sessionService = app.get(load('engine/core-modules/user-session/services/user-session.service.js', 'UserSessionService'));
  const cookieService = app.get(load('engine/core-modules/user-session/services/user-session-cookie.service.js', 'UserSessionCookieService'));
  const workspaceService = app.get(load('engine/core-modules/user-workspace/user-workspace.service.js', 'UserWorkspaceService'));
  const roleService = app.get(load('engine/metadata-modules/user-role/user-role.service.js', 'UserRoleService'));
  const userRepo = db.getRepository(load('engine/core-modules/user/user.entity.js', 'UserEntity'));
  const workspaceRepo = db.getRepository(load('engine/core-modules/workspace/workspace.entity.js', 'WorkspaceEntity'));
  const memberRepo = db.getRepository(load('engine/core-modules/user-workspace/user-workspace.entity.js', 'UserWorkspaceEntity'));
  const sessionRepo = db.getRepository(load('engine/core-modules/user-session/user-session.entity.js', 'UserSessionEntity'));

  async function activeWorkspace(id) {
    const workspace = await workspaceRepo.findOneBy({ id });
    if (!workspace || workspace.activationStatus !== 'ACTIVE' || workspace.deletedAt) throw new AdapterError('workspace_not_active');
    return workspace;
  }
  return { db, native: {
    async provisionIdentity({ nativeUserId, nativeScope, email, displayName, roleId, previousRoleId }) {
      await activeWorkspace(nativeScope);
      let user = await userRepo.findOne({ where: { id: nativeUserId }, withDeleted: true });
      const emailOwner = await userRepo.findOne({ where: { email }, withDeleted: true });
      // Email is an immutable conflict check only; it is never an identity key
      // and never causes an existing Twenty user to be adopted by AVA.
      if (emailOwner && emailOwner.id !== nativeUserId) throw new AdapterError('native_identity_conflict', 409);
      if (user && (user.email !== email || user.disabled || user.deletedAt || user.canImpersonate || user.canAccessFullAdminPanel)) throw new AdapterError('native_identity_conflict', 409);
      if (!user) {
        // Never find or merge by email: a duplicate email is a native conflict.
        user = await userRepo.save(userRepo.create({ id: nativeUserId, email, firstName: displayName, lastName: '',
          isEmailVerified: true, disabled: false, canImpersonate: false, canAccessFullAdminPanel: false, passwordHash: null, locale: 'ru-RU' }));
      }
      let membership = await memberRepo.findOneBy({ userId: nativeUserId, workspaceId: nativeScope });
      if (!membership) membership = await workspaceService.create({ userId: nativeUserId, workspaceId: nativeScope, isExistingUser: true });
      await workspaceService.createWorkspaceMember(nativeScope, user);
      await reconcileNativeRole({ roleService, nativeScope, membershipId: membership.id, roleId, previousRoleId });
      return { nativeUserId, nativeMembershipId: membership.id };
    },
    async readIdentity(nativeUserId, nativeScope, nativeMembershipId) {
      await activeWorkspace(nativeScope);
      const user = await userRepo.findOne({ where: { id: nativeUserId }, withDeleted: true });
      const member = await memberRepo.findOne({ where: { id: nativeMembershipId, userId: nativeUserId, workspaceId: nativeScope }, withDeleted: true });
      if (!user || !member) return null;
      const roleMap = await roleService.getRolesByUserWorkspaces({ userWorkspaceIds: [member.id], workspaceId: nativeScope });
      return { nativeUserId: user.id, nativeMembershipId: member.id, nativeScope: member.workspaceId,
        disabled: user.disabled, deleted: Boolean(user.deletedAt || member.deletedAt),
        canImpersonate: user.canImpersonate, canAccessFullAdminPanel: user.canAccessFullAdminPanel,
        roleIds: (roleMap.get(member.id) || []).map(role => role.id),
        roleElevated: (roleMap.get(member.id) || []).some(roleIsElevated) };
    },
    async createSession({ nativeUserId, nativeScope, nativeMembershipId, expiresAt }) {
      // `ava` is not a v2.37 AuthProviderEnum value. Store the supported SSO
      // provider and keep AVA ownership in ava_connector.sessions instead.
      const { sessionToken, session } = await sessionService.createSession({ userId: nativeUserId,
        workspaceId: nativeScope, userWorkspaceId: nativeMembershipId, authProvider: 'sso', userAgent: 'ava-native', origin: 'sign_in' });
      const capped = new Date(Math.min(session.expiresAt.getTime(), expiresAt.getTime()));
      await sessionRepo.update({ id: session.id }, { expiresAt: capped });
      let nativeCookie;
      cookieService.attachSessionTokenToResponse({ cookie(name, value, options) {
        if (name !== '__Host-twenty-session' || !options.secure || !options.httpOnly || options.domain) throw new AdapterError('unsafe_native_cookie', 503);
        nativeCookie = `${name}=${encodeURIComponent(value)}`;
      } }, sessionToken, capped);
      // Resolve via the real native session service, including its cache path.
      const resolved = await sessionService.resolveSession(sessionToken);
      assertCappedResolvedSession(resolved, nativeUserId, nativeScope, capped);
      return { nativeCookie, nativeSessionId: session.id };
    },
    async revokeSession(sessionId, userId, workspaceId) {
      const session = await sessionRepo.findOneBy({ id: sessionId, userId, workspaceId });
      if (!session) return;
      await sessionService.revokeSessionByIdForUserWorkspace({ sessionId, userId, workspaceId, reason: 'USER_REVOKED' });
    },
    async isSessionActive(id) {
      const session = await sessionRepo.findOneBy({ id, revokedAt: IsNull(), expiresAt: MoreThan(new Date()) });
      return Boolean(session);
    },
    async isSessionResolvable(nativeCookie, userId, workspaceId) {
      return isNativeSessionResolvable(sessionService, nativeCookie, userId, workspaceId);
    },
    async listAvaSessions(userId, workspaceId) {
      return sessionRepo.findBy({ userId, workspaceId, authProvider: 'sso', userAgent: 'ava-native', revokedAt: IsNull(), expiresAt: MoreThan(new Date()) });
    },
  } };
}

// This hook exists only in the separately-bound guarded server used to attach
// an existing customer workspace. It deliberately does not touch the stock
// server's domain resolver or database domain records. Twenty's stock
// single-workspace fallback picks the newest/seed workspace, so it must never
// decide the workspace for an AVA attachment.
function installAttachedWorkspaceScope(app, root, config, env = process.env, injected = {}) {
  if (env.AVA_NATIVE_ATTACH_EXISTING_WORKSPACE !== 'true') return false;
  const load = injected.load || ((file, name) => require(path.join(root, file))[name]);
  const WorkspaceDomainsService = injected.WorkspaceDomainsService || load('engine/core-modules/domain/workspace-domains/services/workspace-domains.service.js', 'WorkspaceDomainsService');
  const WorkspaceService = injected.WorkspaceService || load('engine/core-modules/workspace/services/workspace.service.js', 'WorkspaceService');
  const DataSource = injected.DataSource || require('typeorm').DataSource;
  const db = injected.db || (injected.workspaceRepo ? null : app.get(DataSource));
  const workspaceRepo = injected.workspaceRepo || db.getRepository(load('engine/core-modules/workspace/workspace.entity.js', 'WorkspaceEntity'));
  const domains = injected.domains || app.get(WorkspaceDomainsService);
  // `app.init()` has already registered GraphQL resolver callbacks. Do not
  // replace a resolver method here: a callback captured earlier would retain
  // the original method. The pinned resolver dynamically asks this singleton
  // service for every id lookup, so fencing it also covers captured callbacks.
  const workspaceService = injected.workspaceService || app.get(WorkspaceService);
  if (!domains || !workspaceService || typeof domains.getWorkspaceByOriginOrDefaultWorkspace !== 'function'
    || typeof domains.resolveWorkspaceAndPublicDomain !== 'function' || typeof domains.getWorkspaceUrls !== 'function'
    || typeof workspaceService.findOneWorkspaceById !== 'function') throw new AdapterError('native_workspace_hook_unavailable', 500);
  const activeScope = async () => {
    // The pinned public-workspace resolver calls `getAuthProvidersByWorkspace`,
    // which maps this relation unconditionally. Match Twenty's own domain
    // resolver query rather than returning a partial entity from `findOneBy`.
    const workspace = await workspaceRepo.findOne({
      where: { id: config.nativeScope },
      relations: ['workspaceSSOIdentityProviders'],
    });
    if (!workspace || workspace.deletedAt || workspace.activationStatus !== 'ACTIVE') throw new AdapterError('native_workspace_not_active', 503);
    return workspace;
  };
  const exactOrigin = origin => {
    if (origin !== config.origin) throw new AdapterError('native_workspace_origin_invalid');
  };
  const originalFindOneWorkspaceById = workspaceService.findOneWorkspaceById.bind(workspaceService);
  domains.getWorkspaceByOriginOrDefaultWorkspace = async origin => {
    exactOrigin(origin);
    return activeScope();
  };
  domains.resolveWorkspaceAndPublicDomain = async origin => {
    exactOrigin(origin);
    return { workspace: await activeScope(), publicDomain: null, isIsolatedOrigin: true };
  };
  domains.getWorkspaceUrls = workspace => {
    if (!workspace || workspace.id !== config.nativeScope) throw new AdapterError('native_workspace_scope_invalid');
    // The browser must remain at the guarded origin; do not mutate the legacy
    // workspace's subdomain or custom-domain rows to make that happen.
    return { customUrl: config.origin, subdomainUrl: config.origin };
  };
  workspaceService.findOneWorkspaceById = async id => {
    if (id !== config.nativeScope) throw new AdapterError('native_workspace_scope_invalid');
    await activeScope();
    return originalFindOneWorkspaceById(id);
  };
  return true;
}

async function install(app, root = path.resolve(__dirname, '..'), env = process.env) {
  if (env.AVA_NATIVE_ADAPTER_ENABLED !== 'true') throw new AdapterError('native_adapter_must_be_enabled', 500);
  const config = configFromEnv(env);
  const { db, native } = nativeFromApp(app, root);
  const adapter = createAdapter({ config, db, native });
  await adapter.initialize();
  installAttachedWorkspaceScope(app, root, config, env);
  // Applies to REST, GraphQL, static files and SSE before their native handlers.
  // WebSocket upgrade authentication/revalidation belongs to the only exposed
  // gateway. Neither the native HTTP port nor this peer listener is public.
  const nativeRequestGuard = async (request, response, next) => {
    if (request.method === 'GET' && request.url === '/healthz') return response.status(200).json({ status: 'ok' });
    try {
      if (!secureEqual(request.headers['x-ava-native-peer'], config.gatewaySecret()) || request.headers.authorization) throw new AdapterError('native_gateway_required');
      await adapter.authorizeNative(request.headers['x-ava-native-binding'], request.headers.cookie);
      // Pinned v2.37 inventory: /auth REST is OAuth/login material. The
      // actual GraphQL AST, not caller-controlled operationName, is inspected
      // across aliases and fragments before native handlers see the request.
      if (request.path?.startsWith('/auth') || request.path?.startsWith('/admin-panel')) throw new AdapterError('native_auth_mutation_forbidden');
      if (isNativeGraphqlPath(request.path)) assertSafeGraphqlDocument(request.body);
      next();
    } catch (error) {
      const code = error instanceof AdapterError && /^[a-z_]{1,64}$/.test(error.code)
        ? error.code : 'native_access_unavailable';
      response.status(error instanceof AdapterError ? 403 : 503).set('Cache-Control', 'no-store')
        .json({ error: 'native_access_denied', code });
    }
  };
  // Nest has already registered its routes when this bootstrap hook runs. Put
  // this middleware before them, rather than merely appending an ineffective
  // guard after GraphQL, REST, file and static handlers.
  app.use(nativeRequestGuard);
  const expressApp = app.getHttpAdapter().getInstance();
  const router = expressApp.router || expressApp._router;
  const guardLayer = router?.stack?.pop();
  if (!guardLayer || guardLayer.handle !== nativeRequestGuard) throw new AdapterError('native_guard_install_failed', 500);
  // The preload calls app.init() only after main.ts registered body parsers.
  // Insert immediately after the final parser, not merely before `route`
  // layers: GraphQL/static handlers may be mounted middleware with no route.
  const parserNames = new Set(['jsonParser', 'urlencodedParser', 'textParser', 'graphqlUploadExpress']);
  let lastParser = -1;
  for (let index = 0; index < router.stack.length; index += 1) {
    if (parserNames.has(router.stack[index].name)) lastParser = index;
  }
  if (lastParser < 0) throw new AdapterError('native_body_parser_missing', 500);
  const guardIndex = lastParser + 1;
  // Nest/Express exposes controller routes, mounted GraphQL routers and static
  // middleware through these layer shapes. Any detected endpoint before the
  // guard is a startup failure, never a partially guarded listener.
  const endpointBeforeGuard = router.stack.slice(0, guardIndex).some(layer =>
    layer.route || layer.name === 'router' || layer.name === 'serveStatic');
  if (endpointBeforeGuard) throw new AdapterError('native_guard_order_invalid', 500);
  router.stack.splice(guardIndex, 0, guardLayer);
  const server = peerServer(adapter, config);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  app.getHttpServer().once('close', () => server.close());
  return { adapter, server };
}

module.exports = { install, nativeFromApp, reconcileNativeRole, installAttachedWorkspaceScope, assertSafeGraphqlDocument, isNativeGraphqlPath, isNativeSessionResolvable, assertCappedResolvedSession };
