const axios = require('axios');
const PmsProvider = require('./pms-provider');
const { redact, correlationId } = require('./pms-utils');

class BnovoError extends Error {
    constructor(message, options = {}) {
        super(redact(message));
        this.name = 'BnovoError';
        this.code = options.code || 'BNOVO_REQUEST_FAILED';
        this.statusCode = options.statusCode || null;
        this.retryable = Boolean(options.retryable);
        this.correlationId = options.correlationId || null;
    }
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

class BnovoPmsProvider extends PmsProvider {
    constructor(options = {}) {
        super({ ...options, provider: 'bnovo' });
        this.accountId = Number(options.accountId);
        this.password = String(options.password || '');
        this.baseUrl = String(options.baseUrl || process.env.BNOVO_API_BASE_URL || 'https://api.pms.bnovo.ru').replace(/\/$/, '');
        this.http = options.http || axios.create({ baseURL: this.baseUrl, timeout: Number(options.timeoutMs || 12000) });
        this.sleep = options.sleep || wait;
        this.now = options.now || (() => Date.now());
        this.token = null;
        this.tokenExpiresAt = 0;
        this.authPromise = null;
        this.requestTimestamps = [];
        this.rateQueue = Promise.resolve();
        this.metrics = options.metrics || (() => {});
    }

    _validateCredentials() {
        if (!Number.isInteger(this.accountId) || this.accountId < 1 || !this.password) {
            throw new BnovoError('Bnovo account ID and API password are required', {
                code: 'BNOVO_CREDENTIALS_REQUIRED', statusCode: 400,
            });
        }
    }

    _safeErrorMessage(error) {
        let message = String(error?.response?.data?.error?.message || error?.message || 'Bnovo request failed');
        for (const secret of [this.password, this.token]) {
            if (secret && String(secret).length >= 4) message = message.split(String(secret)).join('[REDACTED]');
        }
        return redact(message);
    }

    async _waitForRateSlot() {
        const limits = [
            { count: 25, windowMs: 10_000 },
            { count: 250, windowMs: 5 * 60_000 },
            { count: 900, windowMs: 60 * 60_000 },
            { count: 9000, windowMs: 24 * 60 * 60_000 },
        ];
        while (true) {
            const now = this.now();
            this.requestTimestamps = this.requestTimestamps.filter((ts) => now - ts < 24 * 60 * 60_000);
            let delay = 0;
            for (const limit of limits) {
                const recent = this.requestTimestamps.filter((ts) => now - ts < limit.windowMs);
                if (recent.length >= limit.count) delay = Math.max(delay, limit.windowMs - (now - recent[0]) + 25);
            }
            if (delay <= 0) break;
            await this.sleep(delay);
        }
        this.requestTimestamps.push(this.now());
    }

    async _rateLimit() {
        // Serialize admission so simultaneous availability/catalog calls cannot
        // all wake on the same boundary and overrun the Bnovo account limits.
        const admitted = this.rateQueue.then(() => this._waitForRateSlot());
        this.rateQueue = admitted.catch(() => {});
        return admitted;
    }

    async _authenticate(force = false, requestId = null) {
        this._validateCredentials();
        if (!force && this.token && this.tokenExpiresAt - this.now() > 5 * 60_000) return this.token;
        if (this.authPromise) return this.authPromise;
        this.authPromise = (async () => {
            const started = this.now();
            try {
                await this._rateLimit();
                const response = await this.http.request({
                    method: 'POST', url: '/api/v1/auth',
                    data: { id: this.accountId, password: this.password },
                    headers: { 'Content-Type': 'application/json' },
                });
                const data = response?.data?.data || response?.data || {};
                if (!data.access_token) throw new Error('Bnovo auth response has no access_token');
                this.token = data.access_token;
                this.tokenExpiresAt = this.now() + Math.max(60, Number(data.expires_in || 86400)) * 1000;
                this.metrics('auth_refresh', { status: 'ok', latencyMs: this.now() - started, correlationId: requestId });
                return this.token;
            } catch (error) {
                const status = error.response?.status;
                this.metrics('auth_refresh', { status: 'error', httpStatus: status || null, correlationId: requestId });
                throw new BnovoError(this._safeErrorMessage(error), {
                    code: status === 429 ? 'BNOVO_RATE_LIMIT' : 'BNOVO_AUTH_FAILED',
                    statusCode: status || 502,
                    retryable: status === 429 || status >= 500 || !status,
                });
            } finally {
                this.authPromise = null;
            }
        })();
        return this.authPromise;
    }

    async _request(method, url, options = {}) {
        const requestId = correlationId(options.correlationId);
        let refreshed = false;
        let attempt = 0;
        while (attempt < 4) {
            attempt += 1;
            const started = this.now();
            try {
                const token = await this._authenticate(false, requestId);
                await this._rateLimit();
                const response = await this.http.request({
                    method, url,
                    params: options.params,
                    data: options.data,
                    headers: { Authorization: `Bearer ${token}`, 'X-Request-ID': requestId },
                });
                this.metrics('request', { method, url, status: response.status, latencyMs: this.now() - started, correlationId: requestId });
                return response.data?.data ?? response.data;
            } catch (error) {
                const status = error.response?.status || error.statusCode || null;
                if (status === 401 && !refreshed) {
                    refreshed = true;
                    this.token = null;
                    this.tokenExpiresAt = 0;
                    await this._authenticate(true, requestId);
                    continue;
                }
                const retryable = status === 429 || status >= 500 || !status;
                this.metrics('request', {
                    method, url, status: status || 0, latencyMs: this.now() - started, retryable,
                    errorCode: status === 429 ? 'BNOVO_RATE_LIMIT' : status === 401 ? 'BNOVO_AUTH_FAILED' : null,
                    correlationId: requestId,
                });
                if (retryable && attempt < 4) {
                    const retryAfter = Number(error.response?.headers?.['retry-after'] || 0) * 1000;
                    await this.sleep(Math.max(retryAfter, Math.min(8000, 500 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 150))));
                    continue;
                }
                const code = status === 403 || status === 406
                    ? 'BNOVO_CONFIGURATION_ERROR'
                    : status === 429 ? 'BNOVO_RATE_LIMIT'
                        : status === 401 ? 'BNOVO_AUTH_FAILED' : retryable ? 'BNOVO_TEMPORARY_ERROR' : 'BNOVO_REQUEST_FAILED';
                throw new BnovoError(this._safeErrorMessage(error), {
                    code, statusCode: status || 502, retryable, correlationId: requestId,
                });
            }
        }
        throw new BnovoError('Bnovo request retry budget exhausted', { code: 'BNOVO_RETRY_EXHAUSTED', retryable: true });
    }

    async testConnection(correlation) { return this._request('GET', '/api/v1/auth/me', { correlationId: correlation }); }

    async listBookings({ dateFrom, dateTo, dataType = 'checkmate', correlationId: requestId } = {}) {
        const bookings = [];
        let offset = 0;
        while (true) {
            const page = await this._request('GET', '/api/v1/bookings', {
                correlationId: requestId,
                params: { date_from: dateFrom, date_to: dateTo, data_type: dataType, limit: 50, offset },
            });
            if (!page || !Array.isArray(page.bookings)) {
                throw new BnovoError('Bnovo bookings response schema is invalid', {
                    code: 'BNOVO_SCHEMA_INVALID', statusCode: 502, retryable: false, correlationId: requestId,
                });
            }
            const rows = page.bookings;
            bookings.push(...rows);
            const total = Number(page?.meta?.total || page?.total || 0);
            if (rows.length < 50 || (total && bookings.length >= total)) break;
            offset += 50;
        }
        return bookings;
    }

    async getBooking(id, correlation) { return this._request('GET', `/api/v1/bookings/${encodeURIComponent(id)}`, { correlationId: correlation }); }
    async getBookingCustomer(id, correlation) { return this._request('GET', `/api/v1/bookings/${encodeURIComponent(id)}/customer`, { correlationId: correlation }); }
    async getBookingGuests(id, correlation) { return this._request('GET', `/api/v1/bookings/${encodeURIComponent(id)}/guests`, { correlationId: correlation }); }
    async getBookingServices(id, correlation) { return this._request('GET', `/api/v1/bookings/${encodeURIComponent(id)}/services`, { correlationId: correlation }); }
    async getAvailability({ dateFrom, dateTo, correlationId: requestId } = {}) {
        const result = await this._request('GET', '/api/v1/availability/roomtypes', {
            correlationId: requestId, params: { date_from: dateFrom, date_to: dateTo },
        });
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
            throw new BnovoError('Bnovo availability response schema is invalid', {
                code: 'BNOVO_SCHEMA_INVALID', statusCode: 502, retryable: false, correlationId: requestId,
            });
        }
        return result;
    }
    async listRoomTypes(correlation) {
        const result = [];
        let offset = 0;
        while (true) {
            const page = await this._request('GET', '/api/v1/roomtypes', { correlationId: correlation, params: { limit: 30, offset } });
            if (!page || !Array.isArray(page.room_types)) {
                throw new BnovoError('Bnovo room types response schema is invalid', {
                    code: 'BNOVO_SCHEMA_INVALID', statusCode: 502, retryable: false, correlationId: correlation,
                });
            }
            const rows = page.room_types;
            result.push(...rows);
            if (rows.length < 30 || (page?.meta?.total && result.length >= Number(page.meta.total))) break;
            offset += 30;
        }
        return result;
    }
    async listTariffs(correlation) {
        const result = await this._request('GET', '/api/v1/tariffs', { correlationId: correlation });
        if (!result || !Array.isArray(result.plans)) {
            throw new BnovoError('Bnovo tariffs response schema is invalid', {
                code: 'BNOVO_SCHEMA_INVALID', statusCode: 502, retryable: false, correlationId: correlation,
            });
        }
        return result.plans;
    }
    async getTariffPrices(planId, { dateFrom, dateTo, correlationId: requestId } = {}) {
        const result = await this._request('GET', `/api/v1/tariffs/prices/${encodeURIComponent(planId)}`, {
            correlationId: requestId, params: { date_from: dateFrom, date_to: dateTo },
        });
        if (!result || !result.prices || typeof result.prices !== 'object' || Array.isArray(result.prices)) {
            throw new BnovoError('Bnovo tariff prices response schema is invalid', {
                code: 'BNOVO_SCHEMA_INVALID', statusCode: 502, retryable: false, correlationId: requestId,
            });
        }
        return result.prices;
    }
    async listWebhookSubscribers(correlation) { return this._request('GET', '/api/v1/webhooks/subscribers', { correlationId: correlation }); }
    async createWebhookSubscriber(url, type, correlation) {
        if (!['booking', 'plans_data_update'].includes(type)) throw new BnovoError('Unsupported webhook type', { code: 'BNOVO_WEBHOOK_TYPE_INVALID', statusCode: 400 });
        return this._request('POST', '/api/v1/webhooks/subscribers', { correlationId: correlation, data: { url, type } });
    }
    async sendTestWebhook(type, correlation) {
        const path = type === 'plans_data_update' ? '/api/v1/webhooks/messages/plans/test' : '/api/v1/webhooks/messages/bookings/test';
        return this._request('GET', path, { correlationId: correlation });
    }
}

module.exports = BnovoPmsProvider;
module.exports.BnovoError = BnovoError;
