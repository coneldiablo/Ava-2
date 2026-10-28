const axios = require('axios');
const { redact } = require('../pms/pms-utils');

const REDACTION_PATTERNS = [
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
    /https?:\/\/[^\s/@]+:[^\s/@]+@/gi,
    /(\b(?:token|password|secret|api[_-]?key)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi,
    /([?&](?:token|password|secret|api[_-]?key)=)[^&\s]+/gi,
];

function redactOnyxError(error, limit = 500, secrets = []) {
    let text = typeof error === 'string' ? error : (error?.message || error?.toString() || 'Onyx API Error');
    if (error?.response?.data) {
        try {
            const dataStr = typeof error.response.data === 'string'
                ? error.response.data
                : JSON.stringify(error.response.data);
            text += ` | response: ${dataStr}`;
        } catch (_) {}
    }
    for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
    for (const pattern of REDACTION_PATTERNS) {
        text = text.replace(pattern, '$1 [REDACTED]');
    }
    return redact(text, limit);
}

function normalizeBaseUrl(url) {
    if (!url || typeof url !== 'string') {
        throw new Error('Onyx base URL is required');
    }
    const clean = url.trim().replace(/\/+$/, '');
    const parsed = new URL(clean);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
        throw new Error('Onyx base URL must be a valid HTTP(S) URL');
    }
    if (parsed.username || parsed.password) {
        throw new Error('Credentials in Onyx URL are forbidden');
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(/\/+$/, '');
}

class OnyxClient {
    constructor({ baseUrl, apiKey, timeoutMs = 20000, adapter = null } = {}) {
        this.baseUrl = normalizeBaseUrl(baseUrl || 'http://localhost:8080');
        this.apiKey = String(apiKey || '').trim();
        this.timeoutMs = Math.max(1000, Math.min(timeoutMs, 60000));
        this.adapter = adapter;
    }

    async _request(method, path, data = null, options = {}) {
        if (this.adapter) {
            return this.adapter({ method, path, data, options, client: this });
        }
        const url = `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
        const headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'AVA-Onyx-Bridge/1.0',
            ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
            ...(options.headers || {}),
        };

        try {
            const response = await axios({
                method,
                url,
                data,
                headers,
                timeout: this.timeoutMs,
                maxRedirects: 0,
            });
            return response.data;
        } catch (error) {
            const safeMsg = redactOnyxError(error, 500, [this.apiKey]);
            const status = error?.response?.status || (error.code === 'ECONNABORTED' ? 408 : 503);
            const err = new Error(safeMsg);
            err.statusCode = status;
            err.status = status;
            err.retryable = [408, 409, 425, 429].includes(status) || status >= 500;
            err.code = status === 401 ? 'ONYX_UNAUTHORIZED'
                : status === 403 ? 'ONYX_FORBIDDEN'
                : status === 404 ? 'ONYX_NOT_FOUND'
                : status === 429 ? 'ONYX_RATE_LIMITED'
                : status === 422 ? 'ONYX_VALIDATION_FAILED'
                : 'ONYX_API_ERROR';
            throw err;
        }
    }

    async getHealth() {
        return this._request('GET', '/health');
    }

    async getVersion() {
        return this._request('GET', '/manage/admin/version');
    }

    async getMe() {
        return this._request('GET', '/me');
    }

    async getApiKeys() { return this._request('GET', '/admin/api-key'); }
    async createApiKey(name, groupIds = []) {
        // v4.7.0 creates a native service account; it is not a local JWT.
        return this._request('POST', '/admin/api-key', { name, group_ids: groupIds });
    }
    async regenerateApiKey(id) { return this._request('POST', `/admin/api-key/${id}/regenerate`); }
    async getUserGroups() { return this._request('GET', '/manage/admin/user-group'); }
    async getOwnGroups() { return this._request('GET', '/manage/user-groups/minimal'); }
    async createUserGroup(name) { return this._request('POST', '/manage/admin/user-group', { name, user_ids: [], cc_pair_ids: [] }); }
    async getGroupPermissions(id) { return this._request('GET', `/manage/admin/user-group/${id}/permissions`); }

    async getCcPair(ccPairId) {
        return this._request('GET', `/manage/admin/cc-pair/${ccPairId}`);
    }

    async createConnector(payload) {
        return this._request('POST', '/manage/admin/connector', payload);
    }

    async getConnectors() {
        return this._request('GET', '/manage/admin/connector');
    }

    async getConnectorStatuses() { return this._request('GET', '/manage/admin/connector/status'); }
    async createPrivateIngestionConnector(payload) {
        return this._request('POST', '/manage/admin/connector-with-mock-credential', payload);
    }

    async createCredential(payload) {
        return this._request('POST', '/manage/admin/credential', payload);
    }

    async getCredentials() {
        return this._request('GET', '/manage/admin/credential');
    }

    async createCcPair(connectorId, credentialId, name) {
        return this._request('PUT', `/manage/connector/${connectorId}/credential/${credentialId}`, {
            name,
            access_type: 'private', groups: [],
        });
    }

    async getDocumentSets() {
        return this._request('GET', '/manage/document-set');
    }

    async getDocumentSet(id) {
        return this._request('GET', `/manage/admin/document-set/${id}`);
    }

    async createDocumentSet(payload) {
        return this._request('POST', '/manage/admin/document-set', payload);
    }

    async getLlmProviders() {
        return this._request('GET', '/admin/llm/provider');
    }

    async putLlmProvider(payload, isCreation = false) {
        return this._request('PUT', `/admin/llm/provider?is_creation=${Boolean(isCreation)}`, payload);
    }

    async getTools() {
        return this._request('GET', '/tool');
    }

    async getPersonas() {
        return this._request('GET', '/persona');
    }

    async getPersona(id) {
        return this._request('GET', `/persona/${id}`);
    }

    async createPersona(payload) {
        return this._request('POST', '/persona', payload);
    }

    async updatePersona(id, payload) {
        return this._request('PATCH', `/persona/${id}`, payload);
    }

    async deletePersona(id) {
        return this._request('DELETE', `/persona/${id}`);
    }

    async getMcpServers() {
        return this._request('GET', '/admin/mcp/servers');
    }

    async getMcpServerTools(serverId) {
        return this._request('GET', `/admin/mcp/server/${serverId}/tools/snapshots?source=mcp`);
    }

    async createMcpServer(payload) {
        return this._request('POST', '/admin/mcp/servers/create', payload);
    }

    async updateMcpServerTools(serverId, selectedTools) {
        return this._request('POST', '/admin/mcp/servers/update', {
            server_id: serverId,
            selected_tools: selectedTools,
        });
    }

    async ingestDocument(document, ccPairId) {
        return this._request('POST', '/onyx-api/ingestion', {
            document,
            cc_pair_id: ccPairId,
        });
    }

    async deleteDocument(documentId) {
        const encoded = encodeURIComponent(encodeURIComponent(documentId));
        return this._request('DELETE', `/onyx-api/ingestion/${encoded}`);
    }
}

module.exports = {
    OnyxClient,
    normalizeBaseUrl,
    redactOnyxError,
};
