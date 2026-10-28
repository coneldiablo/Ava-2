const crypto = require('crypto');
const config = require('../config');
const Logger = require('../utils/logger');
const { getPublicUrl } = require('./identity/public-url');

class AuthService {
    constructor(authConfig = config.auth) {
        this.config = authConfig;
        this.cookieName = 'crm_session';
        this.loginAttempts = new Map();
    }

    assertConfigured() {
        if (process.env.WHATSAPP_CRM_PUBLIC_URL !== undefined || process.env.AVA_CUSTOMER_ACCESS_ENABLED === 'true') {
            getPublicUrl();
        }
        if (!this.config.enabled) return;

        const missing = [];
        if (!this.config.adminLogin) missing.push('ADMIN_LOGIN');
        if (!this.config.adminPasswordHash) missing.push('ADMIN_PASSWORD_HASH');
        if (!this.config.sessionSecret || this.config.sessionSecret.length < 32) {
            missing.push('SESSION_SECRET (minimum 32 characters)');
        }

        if (missing.length > 0) {
            throw new Error(`Authentication is not configured: ${missing.join(', ')}`);
        }
    }

    hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
        const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
        return `scrypt$${salt}$${hash}`;
    }

    verifyPassword(password, storedHash = this.config.adminPasswordHash) {
        try {
            const [algorithm, salt, expectedHex] = String(storedHash || '').split('$');
            if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;

            const actual = crypto.scryptSync(String(password), salt, 64);
            const expected = Buffer.from(expectedHex, 'hex');
            return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
        } catch (error) {
            Logger.warn('[Auth] Password verification failed:', error.message);
            return false;
        }
    }

    createSession(login = this.config.adminLogin) {
        const now = Math.floor(Date.now() / 1000);
        const payload = Buffer.from(JSON.stringify({
            login,
            iat: now,
            exp: now + (this.config.sessionTtlHours * 60 * 60)
        })).toString('base64url');
        const signature = this._sign(payload);
        return `${payload}.${signature}`;
    }

    verifySession(token) {
        try {
            const [payload, signature] = String(token || '').split('.');
            if (!payload || !signature) return null;

            const expectedSignature = this._sign(payload);
            const actualBuffer = Buffer.from(signature);
            const expectedBuffer = Buffer.from(expectedSignature);
            if (
                actualBuffer.length !== expectedBuffer.length ||
                !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
            ) {
                return null;
            }

            const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            const now = Math.floor(Date.now() / 1000);
            if (session.exp <= now || session.login !== this.config.adminLogin) return null;
            return session;
        } catch (error) {
            return null;
        }
    }

    login(req, res) {
        if (!this.config.enabled) {
            return res.json({ success: true, authenticated: true, login: 'development', role: 'platform_admin' });
        }

        const clientKey = req.ip || req.socket?.remoteAddress || 'unknown';
        if (this._isRateLimited(clientKey)) {
            return res.status(429).json({
                success: false,
                error: 'Слишком много попыток входа. Повторите через 15 минут.'
            });
        }

        const login = String(req.body?.login || '').trim();
        const password = String(req.body?.password || '');
        const validLogin = this._safeEqual(login, this.config.adminLogin);
        const validPassword = this.verifyPassword(password);

        if (!validLogin || !validPassword) {
            this._recordFailedAttempt(clientKey);
            return res.status(401).json({ success: false, error: 'Неверный логин или пароль.' });
        }

        this.loginAttempts.delete(clientKey);
        this._setSessionCookie(req, res, this.createSession(login));
        return res.json({ success: true, authenticated: true, login });
    }

    me(req, res) {
        if (!this.config.enabled) {
            return res.json({ success: true, authenticated: true, login: 'development', role: 'platform_admin' });
        }

        const session = this.getSession(req);
        if (!session) {
            return res.json({ success: true, authenticated: false });
        }

        return res.json({ success: true, authenticated: true, login: session.login,
            ...(session.userId ? { user_id: session.userId, userId: session.userId, displayName: session.displayName, businessQuota: session.businessQuota, canCreateBusiness: session.canCreateBusiness, role: session.platformRole, memberships: session.memberships } : { role: 'platform_admin' }) });
    }

    async logout(req, res) {
        let token;
        try { token = this._parseCookies(req.headers.cookie || '')[this.cookieName]; } catch (_) { /* malformed cookie is unauthenticated */ }
        let logoutUrl = null;
        if (String(token || '').startsWith('ava2:')) {
            require('./identity/identity-store').enqueueLogout(token.slice(5));
            try { logoutUrl = await require('./identity/oidc.service').logoutUrl(); } catch (_) { /* local session already revoked */ }
        }
        res.clearCookie(this.cookieName, {
            httpOnly: true,
            sameSite: 'lax',
            secure: this._isSecureRequest(req),
            path: '/'
        });
        return res.json({ success: true, ...(logoutUrl ? { logout_url: logoutUrl } : {}) });
    }

    requireAuth(req, res, next) {
        if (!this.config.enabled || this._isPublicApiPath(req.path)) return next();

        const session = this.getSession(req);
        if (!session) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        req.auth = session;
        return next();
    }

    requireServiceToken(req, res, next) {
        const expectedToken = String(
            process.env.CRM_SERVICE_API_TOKEN ||
            process.env.SALES_BRAIN_API_TOKEN ||
            process.env.WHATSAPP_CRM_API_TOKEN ||
            ''
        ).trim();

        if (!expectedToken) {
            return res.status(503).json({
                success: false,
                error: 'service_token_not_configured'
            });
        }

        const authHeader = String(req.headers.authorization || '').trim();
        const bearer = authHeader.toLowerCase().startsWith('bearer ')
            ? authHeader.slice(7).trim()
            : '';
        const headerToken = String(req.headers['x-service-token'] || '').trim();
        const actualToken = bearer || headerToken;

        if (!actualToken || !this._safeEqual(actualToken, expectedToken)) {
            return res.status(401).json({
                success: false,
                error: 'Invalid service token'
            });
        }

        req.serviceAuth = { type: 'service_token' };
        return next();
    }

    getSession(req) {
        let cookies;
        try { cookies = this._parseCookies(req.headers.cookie || ''); } catch (_) { return null; }
        if (String(cookies[this.cookieName] || '').startsWith('ava2:')) {
            if (process.env.AVA_CUSTOMER_ACCESS_ENABLED !== 'true') return null;
            return require('./identity/identity-store').session(cookies[this.cookieName].slice(5));
        }
        return this.verifySession(cookies[this.cookieName]);
    }

    _isPublicApiPath(path) {
        return path === '/health' ||
            path === '/webhook' ||
            path === '/webhook/openwa' ||
            path === '/payments/webhook';
    }

    _sign(payload) {
        return crypto
            .createHmac('sha256', this.config.sessionSecret)
            .update(payload)
            .digest('base64url');
    }

    _safeEqual(left, right) {
        const leftBuffer = Buffer.from(String(left));
        const rightBuffer = Buffer.from(String(right));
        return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
    }

    _parseCookies(cookieHeader) {
        return String(cookieHeader)
            .split(';')
            .map(part => part.trim())
            .filter(Boolean)
            .reduce((cookies, part) => {
                const separator = part.indexOf('=');
                if (separator === -1) return cookies;
                const key = part.slice(0, separator);
                const value = part.slice(separator + 1);
                cookies[key] = decodeURIComponent(value);
                return cookies;
            }, {});
    }

    _setSessionCookie(req, res, token) {
        res.cookie(this.cookieName, token, {
            httpOnly: true,
            sameSite: 'lax',
            secure: this._isSecureRequest(req),
            maxAge: this.config.sessionTtlHours * 60 * 60 * 1000,
            path: '/'
        });
    }

    _isSecureRequest(req) {
        return Boolean(req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https');
    }

    _recordFailedAttempt(clientKey) {
        const now = Date.now();
        const current = this.loginAttempts.get(clientKey);
        const attempts = current && current.resetAt > now ? current.attempts + 1 : 1;
        this.loginAttempts.set(clientKey, {
            attempts,
            resetAt: now + (15 * 60 * 1000)
        });
    }

    _isRateLimited(clientKey) {
        const record = this.loginAttempts.get(clientKey);
        if (!record) return false;
        if (record.resetAt <= Date.now()) {
            this.loginAttempts.delete(clientKey);
            return false;
        }
        return record.attempts >= 5;
    }
}

module.exports = new AuthService();
module.exports.AuthService = AuthService;
