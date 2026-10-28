'use strict';
const axios = require('axios');
const Identity = require('./identity-store');
const { getPublicUrl } = require('./public-url');
const safeFailure = code => Object.assign(new Error(code), { code, statusCode: 503 });
const matchesInvitationUser = (user, invitation) => !!user?.id
    && user.username === `ava-${invitation.userId}`
    && typeof user.email === 'string'
    && (invitation.user.subject == null || user.id === invitation.user.subject)
    && user.email.toLowerCase() === invitation.user.email.toLowerCase()
    && user.attributes?.avaUserId?.[0] === invitation.userId;

class KeycloakAdmin {
    constructor({ request = axios.request } = {}) { this.request = request; this.cachedToken = null; }
    config() {
        if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') throw safeFailure('IDENTITY_WORKER_REQUIRED');
        const issuer = new URL(process.env.AVA_OIDC_ISSUER);
        if (issuer.protocol !== 'https:' || issuer.username || issuer.password || !/^\/realms\/[a-zA-Z0-9_-]+$/.test(issuer.pathname)) throw safeFailure('IDENTITY_CONFIGURATION_INVALID');
        const realm = issuer.pathname.split('/').pop();
        const internal = process.env.AVA_IDENTITY_ADMIN_ORIGIN;
        if (internal && internal !== 'http://ava-identity-provider:8080') throw safeFailure('IDENTITY_CONFIGURATION_INVALID');
        const origin = internal || issuer.origin;
        return { issuer: `${origin}/realms/${realm}`, admin: `${origin}/admin/realms/${realm}` };
    }
    async token() {
        const config = this.config();
        if (this.cachedToken?.expiresAt > Date.now()) return this.cachedToken.value;
        if (this.pendingToken) return this.pendingToken;
        this.pendingToken = (async () => {
            try {
                const response = await this.request({ method: 'POST', url: `${config.issuer}/protocol/openid-connect/token`,
                    data: new URLSearchParams({ grant_type: 'client_credentials',
                        client_id: process.env.AVA_IDENTITY_ADMIN_CLIENT_ID || '', client_secret: process.env.AVA_IDENTITY_ADMIN_CLIENT_SECRET || '' }),
                    timeout: 8000, maxRedirects: 0, proxy: false, maxContentLength: 65536,
                });
                if (!response.data?.access_token || Number(response.data.expires_in) < 1) throw safeFailure('IDENTITY_AUTH_FAILED');
                this.cachedToken = { value: response.data.access_token, expiresAt: Date.now() + Math.max(0, Number(response.data.expires_in) - 30) * 1000 };
                return this.cachedToken.value;
            } catch (_) { throw safeFailure('IDENTITY_AUTH_FAILED'); }
        })();
        try { return await this.pendingToken; } finally { this.pendingToken = null; }
    }
    async call(method, path, data, refreshed = false, beforeRequest = null) {
        let token;
        try { token = await this.token(); }
        catch (_) { throw safeFailure('IDENTITY_PROVIDER_UNAVAILABLE'); }
        // Token acquisition can yield or refresh after a 401. Revalidate the
        // enrollment immediately before dispatch, without masking lease errors.
        if (beforeRequest) beforeRequest();
        try {
            return (await this.request({ method, url: `${this.config().admin}${path}`, data,
                headers: { Authorization: `Bearer ${token}` },
                timeout: 8000, maxRedirects: 0, proxy: false, maxContentLength: 65536,
            })).data;
        } catch (error) {
            if (!refreshed && error.response?.status === 401) {
                this.cachedToken = null;
                return this.call(method, path, data, true, beforeRequest);
            }
            if (method === 'PUT' && path.endsWith('/reset-password') && error.response?.status === 400) {
                throw Object.assign(new Error('PASSWORD_POLICY'), { code: 'PASSWORD_POLICY', statusCode: 400 });
            }
            const failure = safeFailure('IDENTITY_PROVIDER_UNAVAILABLE');
            // A timeout (including HTTP 408) or server failure does not establish that a dispatched
            // mutation stopped. Preserve durable barriers until reconciliation.
            if (method !== 'GET' && (!error.response || error.response.status === 408 || error.response.status >= 500)) failure.nativeMutationAmbiguous = true;
            throw failure;
        }
    }
    async redeem(token, password, emailVerificationId) {
        this.config();
        if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw Object.assign(new Error('Пароль должен содержать от 12 до 256 символов.'), { code: 'PASSWORD_POLICY', statusCode: 400 });
        const invitation = Identity.claimInvitation(token, emailVerificationId);
        let ambiguous = false;
        try { return await this.enrollClaim(invitation, password); }
        catch (error) { ambiguous = error.nativeMutationAmbiguous === true; throw error; }
        finally { if (!ambiguous) Identity.releaseRegistrationLease(invitation); }
    }
    async enrollClaim(invitation, password) {
        const assertLease = () => Identity.assertInvitationLease(invitation);
        assertLease();
        // Team claims carry the exact persisted AVA email proof, bound to the
        // invitation token, user, business and role. assertLease rechecks that
        // same proof before every native mutation (including token refreshes)
        // and completeInvitation checks it again inside its DB transaction.
        const verifiedTeamInvitation = invitation.acceptanceMode === 'team'
            && invitation.emailVerifiedInvitation === true && !!invitation.emailVerificationId;
        const ownerInvitation = invitation.ownerInvitation === true
            || (invitation.selfRegistration === true && invitation.emailVerifiedInvitation === true);
        const verifiedInvitation = ownerInvitation || verifiedTeamInvitation;
        const username = `ava-${invitation.userId}`;
        const path = `/users?username=${encodeURIComponent(username)}&exact=true`;
        let users = await this.call('GET', path);
        if (!Array.isArray(users) || users.length > 1) throw safeFailure('IDENTITY_NATIVE_OWNER_UNVERIFIED');
        if (!users.length) {
            // Email ownership is never authority to reuse another native
            // account, including a disabled/unbound account from another flow.
            const matches = await this.call('GET', `/users?email=${encodeURIComponent(invitation.user.email)}&exact=true`);
            if (!Array.isArray(matches) || matches.length) throw safeFailure('IDENTITY_NATIVE_EMAIL_CONFLICT');
            Identity.assertInvitationLease(invitation);
            await this.call('POST', '/users', {
                username, email: invitation.user.email, enabled: false, emailVerified: verifiedInvitation,
                requiredActions: verifiedInvitation ? [] : ['VERIFY_EMAIL'],
                attributes: { avaUserId: [invitation.userId] },
            }, false, assertLease);
            users = await this.call('GET', path);
        }
        const user = users?.[0];
        if (users.length !== 1 || !matchesInvitationUser(user,invitation)) throw safeFailure('IDENTITY_NATIVE_OWNER_UNVERIFIED');
        if (invitation.selfRegistration || verifiedTeamInvitation) {
            const matches = await this.call('GET', `/users?email=${encodeURIComponent(invitation.user.email)}&exact=true`);
            if (!Array.isArray(matches) || matches.length !== 1 || matches[0].id !== user.id
                || !matchesInvitationUser(matches[0], invitation)) throw safeFailure('IDENTITY_NATIVE_EMAIL_CONFLICT');
        }
        const emailVerified = verifiedInvitation || user.emailVerified === true;
        // Only enrollment/reset writes the chosen password; it is never put
        // into a job/checkpoint, log or AVA credential table.
        try {
            Identity.assertInvitationLease(invitation);
            await this.call('PUT', `/users/${encodeURIComponent(user.id)}/reset-password`, { type: 'password', temporary: false, value: password }, false, assertLease);
            Identity.assertInvitationLease(invitation);
            const requiredActions = emailVerified
                ? (user.requiredActions || []).filter(action => action !== 'VERIFY_EMAIL')
                : [...new Set([...(user.requiredActions || []), 'VERIFY_EMAIL'])];
            await this.call('PUT', `/users/${encodeURIComponent(user.id)}`, {
                enabled: true, emailVerified, requiredActions,
            }, false, assertLease);
            const current = await this.call('GET', `/users/${encodeURIComponent(user.id)}`);
            if (!matchesInvitationUser(current,invitation) || current.enabled !== true || current.id !== user.id
                || current.emailVerified !== emailVerified
                || (emailVerified ? current.requiredActions?.includes('VERIFY_EMAIL')
                    : !current.requiredActions?.includes('VERIFY_EMAIL'))) throw safeFailure('IDENTITY_NATIVE_OWNER_UNVERIFIED');
            Identity.completeInvitation(invitation, user.id);
        } catch (error) {
            const aborted = Identity.abortEnrollment(invitation, user.id);
            // A completed or superseded generation no longer owns this
            // identity. Its late failure cannot disable another completion.
            if (aborted === false) throw error;
            // A later registration attempt waits for the durable revocation
            // job. Do not leave untracked inline cleanup racing that attempt
            // after the durable job has completed.
            if (invitation.selfRegistration) throw error;
            // Best effort now; the durable native revocation queue remains
            // authoritative if either of these HTTP responses is lost.
            try {
                await this.call('PUT', `/users/${encodeURIComponent(user.id)}`, { enabled: false });
                await this.call('POST', `/users/${encodeURIComponent(user.id)}/logout`);
            } catch (_) { /* Durable compensation will retry. */ }
            throw error;
        }
        return { success: true };
    }

    async sendPasswordRecovery(target, beforeRequest) {
        this.config();
        const { userId, subject, email } = target || {};
        if (typeof userId !== 'string' || typeof subject !== 'string' || !subject || subject.length > 255
            || typeof email !== 'string' || !email || typeof beforeRequest !== 'function') throw safeFailure('IDENTITY_RECOVERY_TARGET_INVALID');
        const query = new URLSearchParams({ lifespan: '600' });
        // Explicit operator fallback: Keycloak supports action email without
        // either optional parameter and uses its enabled system client.
        // Never retry a dispatched email in another mode automatically.
        if (process.env.AVA_PASSWORD_RECOVERY_NO_REDIRECT !== 'true') {
            const clientId = process.env.AVA_OIDC_CLIENT_ID;
            if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(clientId)) throw safeFailure('IDENTITY_CONFIGURATION_INVALID');
            const publicUrl = getPublicUrl();
            if (publicUrl.protocol !== 'https:') throw safeFailure('IDENTITY_CONFIGURATION_INVALID');
            query.set('client_id', clientId);
            query.set('redirect_uri', new URL('/api/auth/sso/start', publicUrl).href);
        }
        const nativePath = `/users/${encodeURIComponent(subject)}`;
        const native = await this.call('GET', nativePath);
        const matches = await this.call('GET', `/users?email=${encodeURIComponent(email)}&exact=true`);
        const matchesTarget = user => user?.id === subject && user.enabled === true && user.emailVerified === true
            && matchesInvitationUser(user, { userId, user: { email } });
        if (!matchesTarget(native) || !Array.isArray(matches) || matches.length !== 1 || !matchesTarget(matches[0])) {
            throw safeFailure('IDENTITY_RECOVERY_TARGET_INVALID');
        }
        // No public redirect/client/action/password is forwarded. Keycloak
        // owns the single-use email token and validates its password policy.
        await this.call('PUT', `${nativePath}/execute-actions-email?${query}`, ['UPDATE_PASSWORD'], false, beforeRequest);
    }
}
module.exports = new KeycloakAdmin();
module.exports.KeycloakAdmin = KeycloakAdmin;
