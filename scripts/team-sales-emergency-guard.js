'use strict';

// Recovery image only. Mount before every /api router, including early public
// and native routers. Customer access is deliberately reduced to owner-only.
const AUTH_ROUTES = new Set([
  'get /auth/config', 'get /auth/me', 'post /auth/login', 'post /auth/logout',
  'get /auth/sso/start', 'get /auth/sso/callback', 'post /auth/sso/backchannel-logout',
]);
const PROVIDER_ROUTES = new Set([
  'post /webhook', 'post /webhook/openwa', 'post /webhook/green-api',
  'get /integrations/instagram/webhook', 'post /integrations/instagram/webhook',
  'get /integrations/onyx/llm/v1/models', 'post /integrations/onyx/llm/v1/chat/completions',
]);
const INVITATION_SEGMENTS = new Set(['invitations', 'owner-invitations', 'team-invitations', 'team', 'access']);

function createGuard({ auth = require('../auth.service'), identity = require('./identity-store') } = {}) {
  const deny = (res, status, code) => res.status(status).json({ success: false, code,
    error: 'Раздел временно недоступен. Попробуйте позже.' });
  return function emergencyGuard(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    // Express defaults are case-insensitive and accept one trailing slash.
    const route = req.path.toLowerCase().replace(/\/$/, '') || '/';
    const method = req.method.toLowerCase() === 'head' ? 'get' : req.method.toLowerCase();
    const key = `${method} ${route}`;
    if (AUTH_ROUTES.has(key) || key === 'get /health') return next();
    const pieces = route.split('/');
    if (pieces.some(piece => INVITATION_SEGMENTS.has(piece))) return deny(res, 503, 'TEAM_RECOVERY_MODE');
    // The baseline payment callback has no provider signature/readback guard;
    // it cannot be granted a public exception during recovery.
    if (route === '/payments/webhook') return deny(res, 503, 'PAYMENT_CALLBACK_NOT_VERIFIED');
    if (route === '/ml' || route.startsWith('/ml/')) {
      // Never let a browser session stand in for the existing service proof.
      return auth.requireServiceToken(req, res, next);
    }
    const opaqueWebhook = method === 'post'
      && /^\/integrations\/(?:bnovo|twenty)\/webhooks\/[a-z0-9_-]+$/.test(route);
    if (PROVIDER_ROUTES.has(key) || opaqueWebhook) {
      // These exact handlers independently verify scoped opaque credentials,
      // signatures or bearer keys before any business mutation/provider call.
      // The old generic auth layer did not exempt the dedicated Green callback;
      // the recovery App uses this private flag only for the exact handlers.
      req.emergencyProviderCallback = true;
      return next();
    }
    try {
      if (auth.config?.enabled !== true) return deny(res, 503, 'RECOVERY_AUTH_REQUIRED');
      const session = auth.getSession(req);
      if (!session) return deny(res, 401, 'AUTHENTICATION_REQUIRED');
      if (!session.userId) {
        if (!session.login || session.login !== auth.config.adminLogin) return deny(res, 403, 'PLATFORM_ADMIN_REQUIRED');
        req.auth = session; // Auth.getSession already verified this HMAC token.
        return next();
      }
      const current = identity.actor(session.userId);
      if (current.platformRole === 'platform_admin') {
        req.auth = current;
        return next();
      }
      if (current.platformRole !== 'customer' || !Array.isArray(current.memberships)
          || current.memberships.length === 0
          || current.memberships.some(member => member.role !== 'hotel_owner')) {
        return deny(res, 403, 'TEAM_RECOVERY_OWNER_ONLY');
      }
      req.auth = current;
      return next();
    } catch (_) {
      return deny(res, 403, 'RECOVERY_ACCESS_DENIED');
    }
  };
}

module.exports = createGuard;
module.exports.AUTH_ROUTES = AUTH_ROUTES;
module.exports.PROVIDER_ROUTES = PROVIDER_ROUTES;
