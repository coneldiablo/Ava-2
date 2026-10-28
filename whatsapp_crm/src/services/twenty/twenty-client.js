const axios = require('axios');
const { redact } = require('../pms/pms-utils');

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value) {
    let raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) throw Object.assign(new Error('Twenty base URL is required'), { code: 'TWENTY_BASE_URL_REQUIRED', statusCode: 400 });
    if (raw.endsWith('/rest')) raw = raw.slice(0, -5);
    let url;
    try { url = new URL(raw); } catch (_) {
        throw Object.assign(new Error('Twenty base URL is invalid'), { code: 'TWENTY_BASE_URL_INVALID', statusCode: 400 });
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw Object.assign(new Error('Twenty base URL must use HTTP or HTTPS'), { code: 'TWENTY_BASE_URL_INVALID', statusCode: 400 });
    }
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
}

function safeMessage(error, secrets = []) {
    let raw = String(
        (Array.isArray(error?.response?.data?.messages) ? error.response.data.messages.join('; ') : '')
        || error?.response?.data?.message
        || error?.response?.data?.error
        || error?.message
        || 'Twenty request failed'
    );
    for (const secret of secrets) if (secret) raw = raw.split(secret).join('[REDACTED]');
    return redact(raw, 500)
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
        .replace(/([?&](?:token|password|secret|api[_-]?key)=)[^&\s]+/gi, '$1[REDACTED]')
        .slice(0, 500);
}

class TwentyClient {
    constructor({ baseUrl, apiKey, timeoutMs = 15000, maxRequestsPerMinute = 90, transport = axios } = {}) {
        this.baseUrl = normalizeBaseUrl(baseUrl);
        this.apiKey = String(apiKey || '').trim();
        if (!this.apiKey) throw Object.assign(new Error('Twenty API key is required'), { code: 'TWENTY_API_KEY_REQUIRED', statusCode: 400 });
        this.timeoutMs = Math.max(1000, Math.min(Number(timeoutMs) || 15000, 60000));
        this.maxRequestsPerMinute = Math.max(1, Math.min(Number(maxRequestsPerMinute) || 90, 99));
        this.transport = transport;
        this.requestTimes = [];
    }

    async _rateLimit() {
        const cutoff = Date.now() - 60000;
        this.requestTimes = this.requestTimes.filter((time) => time > cutoff);
        if (this.requestTimes.length >= this.maxRequestsPerMinute) {
            const waitMs = Math.max(1, this.requestTimes[0] + 60000 - Date.now());
            await sleep(waitMs);
            return this._rateLimit();
        }
        this.requestTimes.push(Date.now());
    }

    _error(error) {
        const status = Number(error?.response?.status || 0);
        const wrapped = new Error(safeMessage(error, [this.apiKey]));
        wrapped.statusCode = status || 503;
        wrapped.retryable = !status || RETRYABLE_STATUS.has(status);
        if (status === 401) wrapped.code = 'TWENTY_UNAUTHORIZED';
        else if (status === 403) wrapped.code = 'TWENTY_FORBIDDEN';
        else if (status === 404) wrapped.code = 'TWENTY_NOT_FOUND';
        else if (status === 429) wrapped.code = 'TWENTY_RATE_LIMITED';
        else if (status >= 500) wrapped.code = 'TWENTY_UPSTREAM_UNAVAILABLE';
        else if (!status) wrapped.code = 'TWENTY_NETWORK_ERROR';
        else if (status === 400 && safeMessage(error) === 'A duplicate entry was detected') wrapped.code = 'TWENTY_DUPLICATE_RECORD';
        else wrapped.code = 'TWENTY_REQUEST_REJECTED';
        return wrapped;
    }

    async request(method, path, { data, params, retries = 2, correlationId, assertActive = () => {} } = {}) {
        const normalizedPath = path.startsWith('/') ? path : `/${path}`;
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
            assertActive();
            await this._rateLimit();
            assertActive();
            let response;
            try {
                response = await this.transport.request({
                    method,
                    url: `${this.baseUrl}${normalizedPath}`,
                    data,
                    params,
                    timeout: this.timeoutMs,
                    maxRedirects: 0,
                    proxy: false,
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                        ...(correlationId ? { 'X-Correlation-ID': String(correlationId) } : {}),
                    },
                    validateStatus: (status) => status >= 200 && status < 300,
                });
            } catch (error) {
                assertActive();
                lastError = this._error(error);
                if (!lastError.retryable || attempt >= retries) throw lastError;
                const retryAfter = Number(error?.response?.headers?.['retry-after']);
                const delay = Number.isFinite(retryAfter) && retryAfter > 0
                    ? Math.min(retryAfter * 1000, 30000)
                    : Math.min(500 * (2 ** attempt), 5000);
                await sleep(delay);
                continue;
            }
            assertActive();
            return response.data;
        }
        throw lastError;
    }

    testConnection(correlationId) {
        return this.request('GET', '/rest/metadata/objects', {
            params: { limit: 1 }, retries: 1, correlationId,
        });
    }

    listObjects(correlationId) {
        return this.request('GET', '/rest/metadata/objects', { params: { limit: 100 }, correlationId });
    }

    listRecords(objectName, params = {}, correlationId) {
        return this.request('GET', `/rest/${encodeURIComponent(objectName)}`, {
            params: { limit: 50, ...params }, correlationId,
        });
    }

    getRecord(objectName, recordId, correlationId, assertActive) {
        return this.request('GET', `/rest/${encodeURIComponent(objectName)}/${encodeURIComponent(recordId)}`, { correlationId, assertActive });
    }

    createRecord(objectName, payload, correlationId, assertActive) {
        return this.request('POST', `/rest/${encodeURIComponent(objectName)}`, { data: payload, correlationId, assertActive });
    }

    updateRecord(objectName, recordId, payload, correlationId, assertActive) {
        return this.request('PATCH', `/rest/${encodeURIComponent(objectName)}/${encodeURIComponent(recordId)}`, {
            data: payload, correlationId, assertActive,
        });
    }
}

module.exports = { TwentyClient, normalizeBaseUrl, safeMessage };
