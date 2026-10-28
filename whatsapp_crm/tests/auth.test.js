const { describe, it, assert } = require('./test-helper');
const { AuthService } = require('../src/services/auth.service');

function createAuthService() {
    const auth = new AuthService({
        enabled: true,
        adminLogin: 'accent_admin',
        adminPasswordHash: '',
        sessionSecret: 'test-session-secret-that-is-long-enough',
        sessionTtlHours: 24
    });
    auth.config.adminPasswordHash = auth.hashPassword('strong-password');
    return auth;
}

describe('Authentication Service Tests', () => {
    it('should verify a scrypt password hash', () => {
        const auth = createAuthService();
        assert.strictEqual(auth.verifyPassword('strong-password'), true);
        assert.strictEqual(auth.verifyPassword('wrong-password'), false);
    });

    it('should create and verify a signed session', () => {
        const auth = createAuthService();
        const token = auth.createSession('accent_admin');
        const session = auth.verifySession(token);

        assert.ok(session);
        assert.strictEqual(session.login, 'accent_admin');
        assert.ok(session.exp > session.iat);
    });

    it('should reject a modified session token', () => {
        const auth = createAuthService();
        const token = auth.createSession('accent_admin');
        const modified = `${token.slice(0, -1)}x`;
        assert.strictEqual(auth.verifySession(modified), null);
    });

    it('should report an unauthenticated session without an HTTP error', () => {
        const auth = createAuthService();
        const req = { headers: {} };
        let statusCode = 200;
        let payload = null;
        const res = {
            status(code) {
                statusCode = code;
                return this;
            },
            json(body) {
                payload = body;
                return body;
            }
        };

        auth.me(req, res);

        assert.strictEqual(statusCode, 200);
        assert.deepStrictEqual(payload, { success: true, authenticated: false });
    });

    it('should leave only external service endpoints public', () => {
        const auth = createAuthService();
        assert.strictEqual(auth._isPublicApiPath('/health'), true);
        assert.strictEqual(auth._isPublicApiPath('/webhook'), true);
        assert.strictEqual(auth._isPublicApiPath('/payments/webhook'), true);
        assert.strictEqual(auth._isPublicApiPath('/instances'), false);
    });
});
