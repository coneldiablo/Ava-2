'use strict';
const crypto = require('crypto');
const Identity = require('./identity-store');
const DB = require('../database.service');

const fail = () => Object.assign(new Error('Не удалось подтвердить вход AVA. Повторите вход.'), { code: 'AVA_SSO_FAILED', statusCode: 401 });
class OidcService {
    constructor({ load = () => import(require.resolve('openid-client')), loadJose = () => import(require.resolve('jose')) } = {}) {
        this.load = load;
        this.loadJose = loadJose;
    }
    enabled() { return process.env.AVA_CUSTOMER_ACCESS_ENABLED === 'true'; }
    async configuration() {
        if (!this.enabled()) throw fail();
        const issuer = new URL(process.env.AVA_OIDC_ISSUER);
        const publicUrl = new URL(process.env.WHATSAPP_CRM_PUBLIC_URL);
        if (issuer.protocol !== 'https:' || publicUrl.protocol !== 'https:' || issuer.username || issuer.password
            || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/') throw fail();
        const oidc = await this.load();
        const configuration = await oidc.discovery(issuer, process.env.AVA_OIDC_CLIENT_ID,
            process.env.AVA_OIDC_CLIENT_SECRET, undefined, { timeout: 10 });
        oidc.enableNonRepudiationChecks(configuration);
        const metadata = configuration.serverMetadata();
        // Discovery is not authority to send tokens/secrets to a new host.
        for (const name of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'end_session_endpoint']) {
            if (!metadata[name]) throw fail();
            const endpoint = new URL(metadata[name]);
            if (endpoint.origin !== issuer.origin || endpoint.username || endpoint.password) throw fail();
        }
        return { oidc, configuration, publicUrl };
    }
    _flowKey() {
        const key = String(process.env.SESSION_SECRET || '');
        if (key.length < 32) throw fail();
        return crypto.createHash('sha256').update(`ava:oidc-flow:${key}`).digest();
    }
    seal(value) {
        const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this._flowKey(), iv);
        cipher.setAAD(Buffer.from('ava:oidc-flow:v1'));
        const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
        return [iv, cipher.getAuthTag(), data].map(part => part.toString('base64url')).join('.');
    }
    open(value) {
        try {
            const parts = String(value || '').split('.');
            if (parts.length !== 3 || value.length > 4096) throw fail();
            const [iv, tag, data] = parts.map(part => Buffer.from(part, 'base64url'));
            const decipher = crypto.createDecipheriv('aes-256-gcm', this._flowKey(), iv);
            decipher.setAAD(Buffer.from('ava:oidc-flow:v1'));
            decipher.setAuthTag(tag);
            const flow = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]));
            if (flow.expiresAt < Date.now()) throw fail();
            return flow;
        } catch (_) { throw fail(); }
    }
    async begin(expectedUserId) {
        const { oidc, configuration, publicUrl } = await this.configuration();
        Identity.ensureSchema();
        DB.db.exec(`CREATE TABLE IF NOT EXISTS ava_oidc_flows (stateHash TEXT PRIMARY KEY,expiresAt INTEGER NOT NULL)`);
        const flow = { state: oidc.randomState(), nonce: oidc.randomNonce(), verifier: oidc.randomPKCECodeVerifier(), expiresAt: Date.now() + 600000 };
        if (expectedUserId) flow.expectedUserId = expectedUserId;
        DB.run('DELETE FROM ava_oidc_flows WHERE expiresAt<?', [Date.now()]);
        DB.run('INSERT INTO ava_oidc_flows VALUES (?,?)', [Identity.hash(flow.state), flow.expiresAt]);
        const url = oidc.buildAuthorizationUrl(configuration, {
            redirect_uri: new URL('/api/auth/sso/callback', publicUrl).href,
            scope: 'openid email profile', state: flow.state, nonce: flow.nonce,
            code_challenge_method: 'S256', code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
            ...(expectedUserId ? { prompt: 'login' } : {}),
        });
        return { url: url.href, cookie: this.seal(flow) };
    }
    async complete(query, cookie) {
        const flow = this.open(cookie);
        const { oidc, configuration, publicUrl } = await this.configuration();
        const callback = new URL('/api/auth/sso/callback', publicUrl);
        callback.search = query;
        if (callback.searchParams.get('state') !== flow.state) throw fail();
        Identity.ensureSchema();
        const deleted = DB.run('DELETE FROM ava_oidc_flows WHERE stateHash=? AND expiresAt>?', [Identity.hash(flow.state), Date.now()]);
        if (deleted.changes !== 1) throw fail();
        // Library validates nonce, issuer, audience, expiry and PKCE; never use
        // an unverified JWT or email to select the product's account/tenant.
        const tokens = await oidc.authorizationCodeGrant(configuration, callback, {
            expectedState: flow.state, expectedNonce: flow.nonce, pkceCodeVerifier: flow.verifier,
        });
        const claims = tokens.claims();
        if (!claims?.sub) throw fail();
        if (flow.expectedUserId) {
            let expected;
            try { expected = Identity.actor(flow.expectedUserId); } catch (_) { throw fail(); }
            if (expected.subject !== claims.sub) throw fail();
        }
        return Identity.createSession(claims.sub, claims.sid, 3600);
    }
    async logoutUrl() {
        const { oidc, configuration, publicUrl } = await this.configuration();
        return oidc.buildEndSessionUrl(configuration, {
            client_id: process.env.AVA_OIDC_CLIENT_ID,
            post_logout_redirect_uri: publicUrl.origin,
        }).href;
    }

    async backchannelLogout(token) {
        if (typeof token !== 'string' || token.length > 8192) throw fail();
        const { configuration } = await this.configuration();
        const { createRemoteJWKSet, jwtVerify } = await this.loadJose();
        const metadata = configuration.serverMetadata();
        const key = createRemoteJWKSet(new URL(metadata.jwks_uri), { timeoutDuration: 5000 });
        const { payload } = await jwtVerify(token, key, {
            issuer: metadata.issuer, audience: process.env.AVA_OIDC_CLIENT_ID,
            algorithms: ['RS256'], requiredClaims: ['iat', 'jti', 'events'],
            maxTokenAge: '5m', clockTolerance: 10,
        });
        if ((!payload.sid && !payload.sub) || payload.nonce !== undefined || typeof payload.jti !== 'string'
            || payload.jti.length > 255 || !payload.events
            || !Object.hasOwn(payload.events, 'http://schemas.openid.net/event/backchannel-logout')) throw fail();
        if ((payload.sid !== undefined && typeof payload.sid !== 'string') || (payload.sub !== undefined && typeof payload.sub !== 'string')) throw fail();
        Identity.backchannelLogout(payload);
    }
}
module.exports = new OidcService();
module.exports.OidcService = OidcService;
