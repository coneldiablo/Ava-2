const axios = require('axios');
const crypto = require('crypto');

function failure(code, retryable = false) {
    // Do not attach native payloads, Axios configs, passwords or session tokens.
    return Object.assign(new Error(code === 'TWENTY_PROVISIONING_CREDENTIALS_REQUIRED'
        ? 'Настройте защищённый служебный вход владельца CRM для автоматического создания рабочих пространств.'
        : `Не удалось подтвердить настройку CRM (${code}).`), { code, retryable });
}

// Contract verified against the installed Twenty v2.37.0 image, not an
// imagined cross-workspace admin REST API. Never bypass native onboarding,
// workspace limits, email verification, MFA, roles or licensing checks.
class TwentyNativeProvisioning {
    constructor({ baseUrl = process.env.TWENTY_PROVISIONING_BASE_URL,
        email = process.env.TWENTY_PROVISIONING_EMAIL,
        password = process.env.TWENTY_PROVISIONING_PASSWORD,
        roleLabel = process.env.TWENTY_PROVISIONING_ROLE_LABEL || 'AVA Integration',
        transport = axios, assertLease = () => {}, checkpoint = {}, onCheckpoint = () => {} } = {}) {
        if (!baseUrl || !email || !password) throw failure('TWENTY_PROVISIONING_CREDENTIALS_REQUIRED');
        let url;
        try { url = new URL(baseUrl); } catch (_) { throw failure('TWENTY_PROVISIONING_URL_INVALID'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
            || url.pathname !== '/' || url.port) throw failure('TWENTY_PROVISIONING_URL_INVALID');
        this.baseUrl = url.origin;
        this.rootHost = url.hostname.replace(/^app\./, '');
        this.email = email.trim().toLowerCase();
        this.password = password;
        this.roleLabel = roleLabel;
        this.transport = transport;
        this.assertLease = assertLease;
        this.checkpoint = checkpoint;
        this.onCheckpoint = onCheckpoint;
        this.sessions = [];
        this.workspaces = new Map();
    }

    async gql(origin, query, variables = {}, token, cleanup = false) {
        if (!cleanup) this.assertLease();
        let response;
        try {
            response = await this.transport.request({ method: 'POST', url: `${origin}/metadata`,
                headers: { 'Content-Type': 'application/json', Origin: origin,
                    ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                data: { query, variables }, timeout: 30000, maxRedirects: 0,
                proxy: false,
                validateStatus: status => status >= 200 && status < 300 });
        } catch (error) {
            const status = Number(error.response?.status || 0);
            throw failure(status === 401 ? 'TWENTY_NATIVE_AUTH_FAILED' : status === 403
                ? 'TWENTY_NATIVE_FORBIDDEN' : 'TWENTY_NATIVE_TRANSPORT_FAILED',
            !status || [401, 408, 425, 429].includes(status) || status >= 500);
        }
        if (!cleanup) {
            try { this.assertLease(); }
            catch (error) {
                const tokens = response.data?.data?.signIn?.tokens
                    || response.data?.data?.getAuthTokensFromLoginToken?.tokens;
                if (tokens?.refreshToken?.token) this.sessions.push({ origin, refreshToken: tokens.refreshToken.token });
                throw error;
            }
        }
        if (!response.data?.data || response.data.errors?.length) {
            throw failure('TWENTY_NATIVE_OPERATION_REJECTED');
        }
        return response.data.data;
    }

    rememberSession(origin, tokens) {
        const token = tokens?.accessOrWorkspaceAgnosticToken?.token;
        if (!token || !tokens?.refreshToken?.token) throw failure('TWENTY_NATIVE_AUTH_CONTRACT_INVALID');
        this.sessions.push({ origin, refreshToken: tokens.refreshToken.token });
        return token;
    }

    async login() {
        if (this.loginResult) return this.loginResult;
        const result = (await this.gql(this.baseUrl, `mutation AvaProvisionSignIn($email:String!,$password:String!){
            signIn(email:$email,password:$password){tokens{accessOrWorkspaceAgnosticToken{token} refreshToken{token}}
            availableWorkspaces{availableWorkspacesForSignIn{id loginToken workspaceUrls{subdomainUrl}}}}}`,
        { email: this.email, password: this.password })).signIn;
        this.ownerToken = this.rememberSession(this.baseUrl, result?.tokens);
        const available = result?.availableWorkspaces?.availableWorkspacesForSignIn;
        if (!Array.isArray(available)) throw failure('TWENTY_NATIVE_AUTH_CONTRACT_INVALID');
        this.loginResult = available;
        return available;
    }

    workspaceOrigin(workspace, slug) {
        let url;
        try { url = new URL(workspace.workspaceUrls?.subdomainUrl); }
        catch (_) { throw failure('TWENTY_NATIVE_WORKSPACE_URL_INVALID'); }
        if (url.protocol !== 'https:' || url.hostname !== `${slug}.${this.rootHost}` || url.port
            || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
            throw failure('TWENTY_NATIVE_WORKSPACE_URL_INVALID');
        }
        return url.origin;
    }

    async enter(workspace, slug, loginToken) {
        const origin = this.workspaceOrigin(workspace, slug);
        const result = (await this.gql(origin, `mutation AvaProvisionEnter($token:String!,$origin:String!){
            getAuthTokensFromLoginToken(loginToken:$token,origin:$origin){tokens{
                accessOrWorkspaceAgnosticToken{token} refreshToken{token}}}}`,
        { token: loginToken, origin })).getAuthTokensFromLoginToken;
        const token = this.rememberSession(origin, result?.tokens);
        let current = (await this.gql(origin,
            'query AvaProvisionWorkspace{currentWorkspace{id subdomain activationStatus}}', {}, token)).currentWorkspace;
        if (current?.id !== workspace.id || current.subdomain !== slug) throw failure('TWENTY_WORKSPACE_NOT_VERIFIED');
        if (['PENDING_CREATION', 'ONGOING_CREATION'].includes(current.activationStatus)) {
            await this.gql(origin, 'mutation AvaProvisionActivate{activateWorkspace(data:{}){id}}', {}, token);
            current = (await this.gql(origin,
                'query AvaProvisionWorkspace{currentWorkspace{id subdomain activationStatus}}', {}, token)).currentWorkspace;
        }
        if (current?.id !== workspace.id || current.subdomain !== slug || current.activationStatus !== 'ACTIVE') {
            throw failure('TWENTY_WORKSPACE_NOT_VERIFIED', true);
        }
        this.workspaces.set(current.id, { origin, token, slug });
        return { ...current, workspaceUrl: origin };
    }

    async countWorkspaces() {
        // This is the authenticated owner's visible count; the server remains
        // authoritative for the installation-wide license/capacity check.
        return (await this.login()).length;
    }

    async findWorkspace({ slug, workspaceId }) {
        const available = await this.login();
        const matches = available.filter(item => {
            try { return new URL(item.workspaceUrls?.subdomainUrl).hostname === `${slug}.${this.rootHost}`; }
            catch (_) { return false; }
        });
        if (matches.length > 1 || (matches.length && workspaceId && matches[0].id !== workspaceId)) {
            throw failure('TWENTY_WORKSPACE_NOT_VERIFIED');
        }
        return matches.length ? this.enter(matches[0], slug, matches[0].loginToken) : null;
    }

    async createWorkspace({ name, slug }) {
        await this.login();
        const result = (await this.gql(this.baseUrl,
            `mutation AvaProvisionCreate($input:SignUpInNewWorkspaceInput!){signUpInNewWorkspace(input:$input){
                loginToken{token} workspace{id workspaceUrls{subdomainUrl}}}}`,
            { input: { displayName: name, subdomain: slug } }, this.ownerToken)).signUpInNewWorkspace;
        if (!result?.workspace?.id || !result.loginToken?.token) throw failure('TWENTY_CREATE_RESPONSE_INVALID', true);
        // Native activation is idempotent. A lost response is reconciled by
        // slug on the next job, including a still-pending activation.
        return this.enter(result.workspace, slug, result.loginToken.token);
    }

    context(workspaceId) {
        const context = this.workspaces.get(workspaceId);
        if (!context) throw failure('TWENTY_WORKSPACE_NOT_VERIFIED');
        return context;
    }

    async configureMembership({ workspaceId, ownerEmail }) {
        const { origin, token } = this.context(workspaceId);
        const user = (await this.gql(origin, 'query AvaProvisionMember{currentUser{id email}}', {}, token)).currentUser;
        if (!user?.id || user.email?.toLowerCase() !== this.email) throw failure('TWENTY_MEMBERSHIP_NOT_VERIFIED');
        // Native onboarding creates membership for the authenticated service
        // owner. Do not pretend that this also enrolls a different customer.
        return { configured: true, serviceMemberId: user.id,
            customerAccessVerified: Boolean(ownerEmail && ownerEmail.toLowerCase() === this.email) };
    }

    async issueWorkspaceApiKey({ workspaceId, businessId }) {
        if (/^(admin|administrator|owner)$/i.test(String(this.roleLabel).trim())) throw failure('TWENTY_RESTRICTED_RUNTIME_ROLE_REQUIRED');
        const { origin, token, slug } = this.context(workspaceId);
        if (!Number.isInteger(Number(businessId)) || Number(businessId) < 1
            || !slug.endsWith(`-${Number(businessId)}`)) throw failure('TWENTY_BUSINESS_SCOPE_REQUIRED');
        const data = await this.gql(origin,
            'query AvaProvisionKeys{apiKeys{id name expiresAt role{id}} getApiKeyRoles{id label}}', {}, token);
        if (!Array.isArray(data.apiKeys) || !Array.isArray(data.getApiKeyRoles)) throw failure('TWENTY_NATIVE_KEY_CONTRACT_INVALID');
        const roles = data.getApiKeyRoles.filter(role => role.label === this.roleLabel);
        if (roles.length !== 1 || !roles[0].id) throw failure('TWENTY_NATIVE_RUNTIME_ROLE_REQUIRED');
        const name = `AVA_RUNTIME_KEY_${businessId}`;
        const matches = data.apiKeys.filter(key => key.name === name);
        if (matches.length > 1) throw failure('TWENTY_NATIVE_KEY_AMBIGUOUS');
        let key = matches[0];
        if (!key) {
            if (this.checkpoint.nativeKeyCreateRequested) throw failure('TWENTY_KEY_RECONCILIATION_REQUIRED', true);
            this.onCheckpoint({ nativeKeyCreateRequested: true });
            key = (await this.gql(origin, `mutation AvaProvisionKey($input:CreateApiKeyInput!){
                createApiKey(input:$input){id name expiresAt role{id}}}`,
            { input: { name, roleId: roles[0].id, expiresAt: new Date(Date.now() + 90 * 86400000).toISOString() } }, token)).createApiKey;
        }
        if (!key?.id || key.name !== name || key.role?.id !== roles[0].id
            || !(Date.parse(key.expiresAt) > Date.now() + 60000)) throw failure('TWENTY_NATIVE_KEY_INVALID');
        const issued = (await this.gql(origin, `mutation AvaProvisionKeyToken($id:UUID!,$expires:String!){
            generateApiKeyToken(apiKeyId:$id,expiresAt:$expires){token}}`,
        { id: key.id, expires: key.expiresAt }, token)).generateApiKeyToken;
        if (!issued?.token || issued.token === token || issued.token === this.ownerToken) throw failure('TWENTY_RUNTIME_KEY_INVALID');
        const verified = (await this.gql(origin,
            'query AvaVerifyRuntimeScope{currentWorkspace{id subdomain}}', {}, issued.token)).currentWorkspace;
        if (verified?.id !== workspaceId || verified.subdomain !== slug) throw failure('TWENTY_RUNTIME_KEY_INVALID');
        return { apiKey: issued.token, nativeKeyId: key.id };
    }

    async configureWebhook({ workspaceId, webhook, secret }) {
        const { origin, token } = this.context(workspaceId);
        const targetUrl = webhook.webhook_url;
        if (!secret || !targetUrl?.startsWith('https://')) throw failure('TWENTY_WEBHOOK_CONFIG_REQUIRED');
        const operations = ['person.updated', 'task.updated', 'avaFollowUpDraft.updated'];
        const listed = (await this.gql(origin,
            'query AvaProvisionWebhooks{webhooks{id targetUrl}}', {}, token)).webhooks;
        if (!Array.isArray(listed)) throw failure('TWENTY_WEBHOOK_CONTRACT_INVALID');
        const matches = listed.filter(value => value.targetUrl === targetUrl);
        if (matches.length > 1) throw failure('TWENTY_WEBHOOK_AMBIGUOUS');
        let id = matches[0]?.id || this.checkpoint.nativeWebhookId;
        if (!id) {
            id = crypto.randomUUID();
            this.onCheckpoint({ nativeWebhookId: id });
        }
        const read = async () => (await this.gql(origin,
            'query AvaProvisionWebhook($id:UUID!){webhook(id:$id){id targetUrl operations secret}}', { id }, token)).webhook;
        let current = await read();
        if (!current) {
            // v2.37.0 accepts a client-supplied native ID. The same checkpointed
            // ID is reused after an uncertain response; no duplicate webhook.
            await this.gql(origin, `mutation AvaProvisionWebhookCreate($input:CreateWebhookInput!){
                createWebhook(input:$input){id}}`,
            { input: { id, targetUrl, operations, secret, description: 'AVA tenant-scoped CRM synchronization' } }, token);
            current = await read();
        }
        if (current?.id !== id || current.targetUrl !== targetUrl || current.secret !== secret
            || JSON.stringify([...(current.operations || [])].sort()) !== JSON.stringify([...operations].sort())) {
            throw failure('TWENTY_WEBHOOK_NOT_VERIFIED');
        }
        // Verifies native configuration, not successful event delivery.
        return { configured: true, verified: true, deliveryVerified: false, nativeWebhookId: id };
    }

    async close() {
        let success = true;
        for (const session of this.sessions) {
            try { await this.gql(session.origin, 'mutation AvaProvisionSignOut($token:String!){signOut(refreshToken:$token)}',
                { token: session.refreshToken }, undefined, true); }
            catch (_) { success = false; }
        }
        this.sessions = [];
        this.workspaces.clear();
        this.loginResult = null;
        this.ownerToken = null;
        this.password = null;
        if (!success) console.warn('[CRM provisioning] TWENTY_SESSION_CLEANUP_FAILED');
        return success;
    }
}

module.exports = { TwentyNativeProvisioning };
