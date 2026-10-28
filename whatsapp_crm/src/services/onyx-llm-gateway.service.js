// Onyx uses a revocable per-business AVA credential, never the provider key.
const crypto = require('crypto');
const axios = require('axios');
const DB = require('./database.service');
const AIService = require('./ai.service');
const { StringDecoder } = require('string_decoder');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ALLOWED_FIELDS = new Set(['model', 'messages', 'stream', 'stream_options',
    'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'tools',
    'tool_choice', 'parallel_tool_calls', 'response_format', 'stop', 'seed',
    'frequency_penalty', 'presence_penalty', 'reasoning_effort']);
const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);
const OSS_MODELS = new Set(['gpt-oss-120b', 'gpt-oss-20b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const { setTimeout: wait } = require('timers/promises');
const { performance } = require('perf_hooks');

class OnyxLlmGateway {
    constructor({ db = DB, transport = axios, resolveProvider, now = () => Date.now(), admissionWaitMs = 5000,
        tenantConcurrencyLimit = process.env.ONYX_LLM_TENANT_CONCURRENCY_LIMIT || 2,
        previewFlashBusinessIds = process.env.ONYX_LLM_PREVIEW_FLASH_BUSINESS_IDS || '' } = {}) {
        this.db = db;
        this.transport = transport;
        this.now = now;
        // This queue absorbs Onyx's small parallel search burst. Persistent
        // SQLite leases remain authoritative across processes/connections.
        this.admissionWaitMs = Math.max(0, Math.min(5000, admissionWaitMs));
        // Opt-in experiment for Onyx's parallel search calls. An unset flag
        // retains the existing per-business limit and is the rollback path.
        this.tenantConcurrencyLimit = Number(tenantConcurrencyLimit);
        if (![2, 3].includes(this.tenantConcurrencyLimit)) throw fail('ONYX_LLM_CONCURRENCY_CONFIG_INVALID', 503);
        this.previewFlashBusinessIds = previewFlashBusinessIds === 'all' ? 'all'
            : new Set(String(previewFlashBusinessIds).split(',').filter(id => /^[1-9][0-9]*$/.test(id)));
        this.admissionQueue = new Set();
        this.resolveProvider = resolveProvider || ((business) => ({
            ...AIService._resolveProviderConfig(business), url: AIService._normalizeProvider(business.aiProvider) === 'gemini'
                ? require('./gemini-text.service').settings().url : AIService._chatCompletionsUrl(),
        }));
    }

    ensureSchema() {
        this.db.db.exec(`
            CREATE TABLE IF NOT EXISTS onyx_llm_credentials (
                business_id INTEGER PRIMARY KEY REFERENCES instances(id),
                token_hash TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS onyx_llm_deployment_credentials (
                deployment_id TEXT PRIMARY KEY,
                business_id INTEGER NOT NULL REFERENCES instances(id),
                deployment_revision INTEGER NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS onyx_llm_requests (
                request_id TEXT PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES instances(id),
                started_at INTEGER NOT NULL, finished_at INTEGER, lease_until INTEGER NOT NULL,
                status TEXT NOT NULL, error_code TEXT, prompt_tokens INTEGER, completion_tokens INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_onyx_llm_budget ON onyx_llm_requests(business_id,started_at);
        `);
    }

    business(businessId) {
        const business = this.db.get('SELECT * FROM instances WHERE id=? AND isActive=1', [businessId]);
        if (!business) throw fail('ONYX_LLM_BUSINESS_UNAVAILABLE', 403);
        return business;
    }

    issueToken(businessId) {
        if (!Number.isSafeInteger(businessId) || businessId < 1) throw fail('ONYX_LLM_BUSINESS_INVALID');
        this.ensureSchema();
        this.business(businessId);
        const token = crypto.randomBytes(32).toString('base64url');
        this.db.run(`INSERT INTO onyx_llm_credentials(business_id,token_hash,enabled)
            VALUES (?,?,1) ON CONFLICT(business_id) DO UPDATE SET token_hash=excluded.token_hash,
            enabled=1,created_at=CURRENT_TIMESTAMP`, [businessId, digest(token)]);
        return { token, model: `ava-hotel-${businessId}` };
    }

    deployment(input) {
        if (!input || Object.keys(input).sort().join(',') !== 'businessId,deploymentId,expectedRevision'
            || !Number.isSafeInteger(input.businessId) || input.businessId < 1
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.deploymentId || '')
            || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw fail('ONYX_LLM_DEPLOYMENT_INVALID');
        const row = this.db.get(`SELECT id,businessId,revision FROM ava_module_deployments
            WHERE id=? AND businessId=? AND module='onyx' AND state='verified' AND revision=?`,
        [input.deploymentId, input.businessId, input.expectedRevision]);
        if (!row) throw fail('ONYX_LLM_DEPLOYMENT_UNAVAILABLE', 403);
        return row;
    }

    issueDeploymentToken(input) {
        if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') throw fail('ONYX_LLM_WORKER_REQUIRED', 403);
        this.ensureSchema();
        const deployment = this.deployment(input);
        this.business(deployment.businessId);
        const token = crypto.randomBytes(32).toString('base64url');
        this.db.run(`INSERT INTO onyx_llm_deployment_credentials(deployment_id,business_id,deployment_revision,token_hash,enabled)
            VALUES (?,?,?,?,1) ON CONFLICT(deployment_id) DO UPDATE SET business_id=excluded.business_id,
            deployment_revision=excluded.deployment_revision,token_hash=excluded.token_hash,enabled=1,created_at=CURRENT_TIMESTAMP`,
        [deployment.id, deployment.businessId, deployment.revision, digest(token)]);
        return { token, model: `ava-hotel-${deployment.businessId}` };
    }

    revokeDeploymentToken(input) {
        if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') throw fail('ONYX_LLM_WORKER_REQUIRED', 403);
        this.ensureSchema();
        const deployment = this.deployment(input);
        this.db.run('UPDATE onyx_llm_deployment_credentials SET enabled=0 WHERE deployment_id=? AND business_id=? AND deployment_revision=?',
            [deployment.id, deployment.businessId, deployment.revision]);
    }

    authenticate(authorization) {
        if (process.env.ONYX_LLM_PROXY_ENABLED !== 'true') throw fail('ONYX_LLM_DISABLED', 503);
        const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(authorization || ''));
        if (!match) throw fail('ONYX_LLM_UNAUTHORIZED', 401);
        this.ensureSchema();
        const tokenHash = digest(match[1]);
        const legacy = this.db.get('SELECT business_id FROM onyx_llm_credentials WHERE token_hash=? AND enabled=1', [tokenHash]);
        if (legacy) return this.business(legacy.business_id);
        // Deployment credentials are fenced against current state on every
        // request; a revoked, moved or stale deployment cannot be used.
        const deployment = this.db.get(`SELECT c.business_id FROM onyx_llm_deployment_credentials c
            JOIN ava_module_deployments d ON d.id=c.deployment_id AND d.businessId=c.business_id
            WHERE c.token_hash=? AND c.enabled=1 AND d.module='onyx' AND d.state='verified'
              AND d.revision=c.deployment_revision`, [tokenHash]);
        if (!deployment) throw fail('ONYX_LLM_UNAUTHORIZED', 401);
        return this.business(deployment.business_id);
    }

    validate(body, businessId) {
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).some((key) => !ALLOWED_FIELDS.has(key))) throw fail('ONYX_LLM_INVALID_REQUEST');
        const previewAlias = `ava-hotel-${businessId}-preview-flash`;
        if (body.model !== `ava-hotel-${businessId}`
            && !((this.previewFlashBusinessIds === 'all' || this.previewFlashBusinessIds.has(String(businessId)))
                && body.model === previewAlias)) {
            throw fail('ONYX_LLM_MODEL_SCOPE_MISMATCH', 403);
        }
        if (body.reasoning_effort !== undefined && !REASONING_EFFORTS.has(body.reasoning_effort)) throw fail('ONYX_LLM_INVALID_REASONING_EFFORT');
        if (body.stream !== undefined && typeof body.stream !== 'boolean') throw fail('ONYX_LLM_INVALID_STREAM');
        if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 100
            || Buffer.byteLength(JSON.stringify(body)) > 512 * 1024) throw fail('ONYX_LLM_INPUT_LIMIT');
        for (const message of body.messages) {
            if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw fail('ONYX_LLM_INVALID_MESSAGE');
            if (Object.keys(message).some((key) => !['role', 'content', 'name', 'tool_call_id', 'tool_calls'].includes(key))) throw fail('ONYX_LLM_INVALID_MESSAGE');
            if (message.content !== null && message.content !== undefined && typeof message.content !== 'string'
                && !(Array.isArray(message.content) && message.content.every((part) => part?.type === 'text' && typeof part.text === 'string'
                    && Object.keys(part).every((key) => ['type', 'text'].includes(key))))) throw fail('ONYX_LLM_TEXT_ONLY');
            if (message.tool_calls && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 24
                || message.tool_calls.some((call) => call?.type !== 'function' || typeof call.id !== 'string'
                    || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string'))) throw fail('ONYX_LLM_INVALID_TOOL_CALL');
        }
        if (body.tools && (!Array.isArray(body.tools) || body.tools.length > 24 || body.tools.some((tool) =>
            tool?.type !== 'function' || !/^[\w-]{1,128}$/.test(tool.function?.name || '')
            || !tool.function?.parameters || typeof tool.function.parameters !== 'object'))) throw fail('ONYX_LLM_INVALID_TOOLS');
        for (const [field, min, max] of [['temperature', 0, 2], ['top_p', 0, 1], ['frequency_penalty', -2, 2], ['presence_penalty', -2, 2]]) {
            if (body[field] !== undefined && (typeof body[field] !== 'number' || !Number.isFinite(body[field]) || body[field] < min || body[field] > max)) throw fail('ONYX_LLM_INVALID_SAMPLING');
        }
        if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) throw fail('ONYX_LLM_TOKEN_LIMIT');
        const requested = body.max_completion_tokens ?? body.max_tokens ?? 2048;
        if (!Number.isSafeInteger(requested) || requested < 1 || requested > 65536) throw fail('ONYX_LLM_TOKEN_LIMIT');
        return { ...body, [body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens']: Math.min(requested, 4096), store: false };
    }

    reserve(businessId) {
        const now = this.now();
        return this.db.db.transaction(() => {
            const counts = this.db.get(`SELECT
                SUM(CASE WHEN business_id=? AND started_at>? THEN 1 ELSE 0 END) minute_count,
                SUM(CASE WHEN business_id=? THEN 1 ELSE 0 END) day_count,
                SUM(CASE WHEN status='PROCESSING' AND lease_until>? THEN 1 ELSE 0 END) active_count,
                SUM(CASE WHEN business_id=? AND status='PROCESSING' AND lease_until>? THEN 1 ELSE 0 END) tenant_active
                FROM onyx_llm_requests WHERE started_at>?`, [businessId, now - 60000, businessId, now, businessId, now, now - 86400000]);
            if (counts.minute_count >= 60 || counts.day_count >= 2000) throw fail('ONYX_LLM_RATE_LIMIT', 429);
            if (counts.active_count >= 8 || counts.tenant_active >= this.tenantConcurrencyLimit) throw fail('ONYX_LLM_CONCURRENCY_LIMIT', 429);
            const requestId = crypto.randomUUID();
            this.db.run(`INSERT INTO onyx_llm_requests(request_id,business_id,started_at,lease_until,status)
                VALUES (?,?,?,?,'PROCESSING')`, [requestId, businessId, now, now + 65000]);
            return requestId;
        }).immediate();
    }

    async admit(authorization, businessId, signal) {
        const started = performance.now();
        let ticket;
        try {
            while (true) {
                if (signal?.aborted) throw fail('ONYX_LLM_CANCELED', 499);
                if (ticket && performance.now() - started >= this.admissionWaitMs) throw fail('ONYX_LLM_CONCURRENCY_LIMIT', 429);
                // Rotation, disable and changes made while waiting must win.
                const business = this.authenticate(authorization);
                if (business.id !== businessId) throw fail('ONYX_LLM_UNAUTHORIZED', 401);
                try {
                    const requestId = this.reserve(businessId);
                    return { business, requestId };
                } catch (error) {
                    // Provider quotas are not concurrency contention. Never
                    // queue or retry exhausted minute/day budgets here.
                    if (error.code !== 'ONYX_LLM_CONCURRENCY_LIMIT') throw error;
                    if (performance.now() - started >= this.admissionWaitMs) throw error;
                    if (!ticket) {
                        const tenantWaiting = [...this.admissionQueue].filter((item) => item.businessId === businessId).length;
                        if (this.admissionQueue.size >= 16 || tenantWaiting >= 4) throw fail('ONYX_LLM_QUEUE_FULL', 429);
                        ticket = { businessId };
                        this.admissionQueue.add(ticket);
                    }
                }
                try {
                    await wait(Math.min(50, Math.max(1, this.admissionWaitMs - (performance.now() - started))), undefined, { signal });
                } catch (error) {
                    if (error.name === 'AbortError') throw fail('ONYX_LLM_CANCELED', 499);
                    throw error;
                }
            }
        } finally {
            if (ticket) this.admissionQueue.delete(ticket);
        }
    }

    finish(requestId, errorCode = null, usage = {}) {
        const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
        this.db.run(`UPDATE onyx_llm_requests SET status=?,finished_at=?,error_code=?,prompt_tokens=?,completion_tokens=?
            WHERE request_id=? AND status='PROCESSING'`, [errorCode ? 'FAILED' : 'DONE', this.now(), errorCode,
            count(usage.prompt_tokens), count(usage.completion_tokens), requestId]);
    }

    safeResult(data, alias, streaming = false) {
        if (!data || !Array.isArray(data.choices) || data.choices.length > 1
            || (!streaming && data.choices.length !== 1)) throw fail('ONYX_LLM_INVALID_UPSTREAM', 502);
        const result = { id: String(data.id || '').slice(0, 160), object: streaming ? 'chat.completion.chunk' : 'chat.completion',
            created: Number(data.created) || Math.floor(this.now() / 1000), model: alias,
            choices: data.choices.map((choice) => {
                const field = streaming ? 'delta' : 'message';
                const message = choice[field] || {};
                return { index: 0, finish_reason: choice.finish_reason || null, [field]: Object.fromEntries(
                    ['role', 'content', 'tool_calls', 'refusal'].filter((key) => Object.hasOwn(message, key)).map((key) => [key, message[key]])) };
            }) };
        if (data.usage) result.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens']
            .filter((key) => Number.isSafeInteger(data.usage[key]) && data.usage[key] >= 0).map((key) => [key, data.usage[key]]));
        return result;
    }

    async complete(authorization, body, { signal, onChunk } = {}) {
        const initialBusiness = this.authenticate(authorization);
        const payload = this.validate(body, initialBusiness.id);
        if (payload.stream && !onChunk) throw fail('ONYX_LLM_STREAM_HANDLER_REQUIRED');
        const { business, requestId } = await this.admit(authorization, initialBusiness.id, signal);
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) controller.abort();
        const deadline = setTimeout(abort, 60000);
        let usage = {};
        try {
            const provider = this.resolveProvider(business);
            const effectiveModel = payload.model === `ava-hotel-${business.id}-preview-flash`
                && provider.provider !== 'gemini' ? 'gemini-2.5-flash-lite' : provider.model;
            if (provider.provider === 'gemini') {
                const completed = await require('./gemini-onyx.service').complete({ payload, model: effectiveModel,
                    transport: this.transport, signal: controller.signal, db: this.db, businessId: business.id,
                    onChunk: async chunk => onChunk(this.safeResult(chunk, body.model, true), requestId) });
                usage = completed.usage;
                const result = payload.stream ? null : this.safeResult(completed.result, body.model);
                this.finish(requestId, null, usage);
                return payload.stream ? { requestId, streamed: true } : { requestId, result };
            }
            // Optional Onyx-only latency tuning for the model actually configured
            // by this business. Never change the model/provider or a voice setting.
            // Explicit per-session effort from Onyx takes precedence.
            const defaultEffort = String(process.env.ONYX_LLM_OSS_REASONING_EFFORT || '').trim();
            if (payload.reasoning_effort === undefined && OSS_MODELS.has(effectiveModel) && defaultEffort) {
                if (!REASONING_EFFORTS.has(defaultEffort)) throw fail('ONYX_LLM_REASONING_CONFIG_INVALID', 503);
                payload.reasoning_effort = defaultEffort;
            }
            const url = new URL(provider.url);
            if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
                || (!provider.apiKey && provider.provider !== 'gemini') || !provider.model) throw fail('ONYX_LLM_UPSTREAM_NOT_CONFIGURED', 503);
            if (controller.signal.aborted) throw fail('ONYX_LLM_CANCELED', 499);
            const apiKey = provider.provider === 'gemini'
                ? await require('./gemini-text.service').accessToken({ signal: controller.signal }) : provider.apiKey;
            if (controller.signal.aborted) throw fail('ONYX_LLM_CANCELED', 499);
            const response = await this.transport.request({ method: 'POST', url: url.toString(),
                data: { ...payload, model: provider.provider === 'gemini' ? `google/${effectiveModel}` : effectiveModel,
                    ...(provider.provider === 'gemini' ? { reasoning_effort: 'low' } : {}) }, proxy: provider.provider === 'gemini' ? false : undefined, signal: controller.signal,
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Request-ID': requestId },
                responseType: payload.stream ? 'stream' : 'json', timeout: 60000, maxRedirects: 0,
                maxContentLength: MAX_RESPONSE_BYTES, maxBodyLength: 512 * 1024,
                validateStatus: (status) => status >= 200 && status < 300 });
            if (!payload.stream) {
                const result = this.safeResult(response.data, body.model);
                usage = result.usage || {};
                this.finish(requestId, null, usage);
                return { requestId, result };
            }
            let buffer = '', bytes = 0, done = false, frames = 0;
            const decoder = new StringDecoder('utf8');
            for await (const chunk of response.data) {
                bytes += Buffer.byteLength(chunk);
                if (bytes > MAX_RESPONSE_BYTES) throw fail('ONYX_LLM_RESPONSE_LIMIT', 502);
                buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                let newline;
                while ((newline = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + 1);
                    if (!line.startsWith('data:')) continue;
                    const data = line.slice(5).trim();
                    if (data === '[DONE]') { done = true; break; }
                    const result = this.safeResult(JSON.parse(data), body.model, true);
                    usage = result.usage || usage;
                    frames += 1;
                    await onChunk(result, requestId);
                }
                if (done) break;
            }
            if (!done || !frames) throw fail('ONYX_LLM_INCOMPLETE_STREAM', 502);
            this.finish(requestId, null, usage);
            return { requestId, streamed: true };
        } catch (error) {
            controller.abort();
            const upstreamStatus = Number(error.response?.status || 0);
            // Do not reflect Axios config, URLs, response bodies, or credentials.
            const code = String(error.code || '').startsWith('ONYX_LLM_') ? error.code
                : ['ERR_CANCELED', 'ECONNABORTED'].includes(error.code) || error.name === 'AbortError' ? 'ONYX_LLM_CANCELED'
                    : upstreamStatus === 429 ? 'ONYX_LLM_UPSTREAM_RATE_LIMIT'
                        : [401, 403].includes(upstreamStatus) ? 'ONYX_LLM_UPSTREAM_AUTH' : 'ONYX_LLM_UPSTREAM_ERROR';
            this.finish(requestId, code);
            throw fail(code, error.status || (upstreamStatus === 429 ? 429 : 502));
        } finally {
            clearTimeout(deadline);
            signal?.removeEventListener('abort', abort);
        }
    }
}

module.exports = { OnyxLlmGateway };
