'use strict';
// Vertex uses server-owned service-account ADC. No customer key or URL enters auth.
const fs = require('fs');
const crypto = require('crypto');
const { GoogleAuth } = require('google-auth-library');
const Requests = require('./ai-request.service');
const axios = require('axios');
const { StringDecoder } = require('node:string_decoder');
const MODELS = Object.freeze(['gemini-3.8-flash', 'gemini-3.7-flash']);
const fail = (code, statusCode = 503) => Object.assign(new Error(code), { code, statusCode });
let cachedAuth, cachedIdentity;
function settings() {
    const project = String(process.env.GEMINI_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '').trim();
    const location = String(process.env.GEMINI_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || 'global').trim();
    const credentialFile = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(project) || location !== 'global' || !credentialFile
        || process.env.GEMINI_TEXT_ENABLED === 'false') throw fail('AI_PROVIDER_NOT_CONFIGURED');
    try {
        fs.accessSync(credentialFile, fs.constants.R_OK);
        const raw = fs.readFileSync(credentialFile, 'utf8');
        if (Buffer.byteLength(raw) > 65536) throw new Error();
        const credentials = JSON.parse(raw);
        if (credentials.type !== 'service_account' || !credentials.client_email || !credentials.private_key) throw new Error();
        const identity = crypto.createHash('sha256').update(raw).update(project).digest('hex');
        return { project, location, identity,
            url: `https://aiplatform.googleapis.com/v1beta1/projects/${project}/locations/global/endpoints/openapi/chat/completions` };
    } catch (_) { throw fail('AI_PROVIDER_NOT_CONFIGURED'); }
}
function configured() { try { settings(); return true; } catch (_) { return false; } }
function selectable(instance = {}) { return configured() && (process.env.GEMINI_TEXT_ADMISSION_ENABLED !== 'false' || instance.aiProvider === 'gemini'); }
function model(value) {
    const selected = String(value || process.env.GEMINI_TEXT_MODEL || MODELS[0]).trim();
    if (!MODELS.includes(selected)) throw fail('AI_MODEL_UNAVAILABLE', 400);
    return selected;
}
async function accessToken({ signal, deadline = Infinity } = {}) {
    const current = settings();
    if (deadline <= Date.now()) throw fail('AI_TIMEOUT', 504);
    if (signal?.aborted) throw fail('AI_CANCELED', 499);
    if (!cachedAuth || cachedIdentity !== current.identity) {
        cachedAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'], projectId: current.project,
            clientOptions: { eagerRefreshThresholdMillis: 300000, transporterOptions: { timeout: 5000, retry: false } } });
        cachedIdentity = current.identity;
    }
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const cancel = () => rejectAbort(fail('AI_CANCELED', 499));
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => rejectAbort(fail('AI_TIMEOUT', 504)), Math.max(1, Math.min(8000, deadline - Date.now())));
    try {
        const token = await Promise.race([cachedAuth.getAccessToken(), aborted]);
        if (signal?.aborted) throw fail('AI_CANCELED', 499);
        if (typeof token !== 'string' || !token) throw fail('AI_PROVIDER_NOT_CONFIGURED');
        return token;
    } catch (error) {
        if (/^AI_/.test(error?.code || '')) throw error;
        throw fail('AI_AUTH_UNAVAILABLE');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
function resolve(instance = {}) {
    const current = settings();
    return { provider: 'gemini', model: model(instance.geminiModel), temperature: Number(instance.aiTemperature ?? 0.3),
        apiKey: null, url: current.url, credentialRevision: current.identity.slice(0, 16) };
}
function nativeBody(messages, { maxTokens, temperature, json, responseSchema, thinking } = {}) {
    if (!Array.isArray(messages) || messages.length > 200) throw fail('AI_INPUT_INVALID', 400);
    if (responseSchema !== undefined && (!json || !responseSchema || typeof responseSchema !== 'object'
        || Array.isArray(responseSchema) || Buffer.byteLength(JSON.stringify(responseSchema)) > 12000)) throw fail('AI_INPUT_INVALID', 400);
    const systems = [], contents = [];
    for (const message of messages) {
        if(Array.isArray(message.content) && message.content.some(part=>part?.type==='inline_data')) {
            if(message.role!=='user'||message.content.length>5)throw fail('AI_INPUT_INVALID',400);
            const parts=message.content.map(part=>{
                if(part?.type==='text'&&typeof part.text==='string')return{text:part.text};
                if(part?.type!=='inline_data'||!['image/jpeg','image/png','image/webp','audio/ogg','audio/wav','audio/mpeg','audio/webm'].includes(part.mimeType)
                    ||typeof part.data!=='string'||part.data.length>14*1024*1024||part.data.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(part.data))throw fail('AI_INPUT_INVALID',400);
                return{inlineData:{mimeType:part.mimeType,data:part.data}};
            });
            contents.push({role:'user',parts});continue;
        }
        const text = typeof message.content === 'string' ? message.content
            : Array.isArray(message.content) && message.content.every(part => part?.type === 'text' && typeof part.text === 'string')
                ? message.content.map(part => part.text).join('\n') : '';
        if (!text.trim()) continue;
        if (['system','developer'].includes(message.role)) systems.push({ text });
        else if (['user','assistant'].includes(message.role)) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
        else throw fail('AI_INPUT_INVALID', 400);
    }
    if (!contents.length) throw fail('AI_INPUT_INVALID', 400);
    const thinkingConfig = optionsThinking(thinking);
    return { ...(systems.length ? { systemInstruction: { parts: systems } } : {}), contents,
        generationConfig: { maxOutputTokens: maxTokens, temperature, thinkingConfig,
            ...(json ? { responseMimeType: 'application/json' } : {}),
            ...(responseSchema ? { responseSchema } : {}) } };
}
function optionsThinking(thinking) {
    if (thinking && typeof thinking === 'object' && !Array.isArray(thinking)) return thinking;
    return { thinkingLevel: 'LOW' };
}
function readNativeChoice(data) {
    const candidate = data?.candidates?.[0];
    return { finish_reason: candidate?.finishReason === 'STOP' ? 'stop'
        : candidate?.finishReason === 'MAX_TOKENS' ? 'length' : 'invalid',
        message: { content: candidate?.content?.parts?.filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('') } };
}
// Native SSE is collected server-side for generation tasks. It uses the same
// business model and ADC; partial or interrupted streams are never drafts.
async function completeStreaming(messages, resolved, current, options) {
    const start = Date.now(), deadline = Math.min(options.deadline || Infinity, start + (options.timeout || 45000));
    const controller = new AbortController();
    let stream, timedOut = false, rejectAborted;
    const aborted = new Promise((_, reject) => { rejectAborted = reject; });
    const onAbort = () => { stream?.destroy(); rejectAborted(fail(timedOut ? 'AI_TIMEOUT' : 'AI_CANCELED', timedOut ? 504 : 499)); };
    const cancel = () => controller.abort();
    controller.signal.addEventListener('abort', onAbort, { once: true });
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, deadline - Date.now()));
    const check = () => {
        if (options.signal?.aborted) throw fail('AI_CANCELED', 499);
        if (timedOut || Date.now() >= deadline) throw fail('AI_TIMEOUT', 504);
        if (controller.signal.aborted) throw fail('AI_CANCELED', 499);
    };
    try {
        check();
        const authStart = Date.now();
        const token = await Promise.race([aborted, accessToken({ signal: controller.signal, deadline })]);
        const authMs = Date.now() - authStart;
        check();
        const body = nativeBody(messages, { maxTokens: options.maxTokens || 4096, temperature: resolved.temperature,
            json: Boolean(options.json), responseSchema: options.responseSchema, thinking: options.thinkingConfig });
        if (Buffer.byteLength(JSON.stringify(body)) > (options.maxBodyLength || 256 * 1024)) throw fail('AI_INPUT_INVALID', 400);
        const url = `https://aiplatform.googleapis.com/v1/projects/${current.project}/locations/global/publishers/google/models/${resolved.model}:streamGenerateContent?alt=sse`;
        const providerStart = Date.now();
        const requested = axios.post(url, body, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
                ...(options.freshConnection ? { Connection: 'close' } : {}) },
            ...(options.freshConnection ? { httpsAgent: false } : {}),
            signal: controller.signal, timeout: Math.max(1, deadline - Date.now()), proxy: false, maxRedirects: 0,
            responseType: 'stream', maxContentLength: options.maxContentLength || 128 * 1024,
            maxBodyLength: options.maxBodyLength || 256 * 1024,
        });
        requested.then(value => { if (controller.signal.aborted) value?.data?.destroy?.(); }, error => { error?.response?.data?.destroy?.(); });
        const response = await Promise.race([aborted, requested]);
        stream = response.data;
        check();
        if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw fail('AI_INVALID_RESPONSE', 502);
        const read = async () => {
            let buffer = '', text = '', bytes = 0, finishReason, frames = 0;
            const decoder = new StringDecoder('utf8');
            const line = value => {
                if (!value.startsWith('data:')) return;
                const raw = value.slice(5).trim();
                if (!raw || raw === '[DONE]') return;
                let frame;
                try { frame = JSON.parse(raw); } catch (_) { throw fail('AI_INVALID_RESPONSE', 502); }
                if (frame.error || (frame.candidates !== undefined && !Array.isArray(frame.candidates))
                    || (frame.candidates === undefined && !frame.usageMetadata)) throw fail('AI_INVALID_RESPONSE', 502);
                frames++;
                for (const candidate of frame.candidates || []) {
                    if (candidate.index && candidate.index !== 0) throw fail('AI_INVALID_RESPONSE', 502);
                    finishReason = candidate.finishReason || finishReason;
                    for (const part of candidate.content?.parts || []) if (typeof part.text === 'string' && !part.thought) text += part.text;
                }
            };
            for await (const chunk of stream) {
                check(); bytes += Buffer.byteLength(chunk);
                if (bytes > (options.maxContentLength || 128 * 1024)) throw fail('AI_RESPONSE_LIMIT', 502);
                buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                let newline;
                while ((newline = buffer.indexOf('\n')) >= 0) {
                    line(buffer.slice(0, newline).trim()); buffer = buffer.slice(newline + 1);
                }
                // A terminal candidate completes generation independently of HTTP
                // EOF. Proxies may keep the SSE connection open after STOP;
                // waiting for EOF would discard an already complete answer at
                // the deadline. The caller still validates the complete text
                // before acknowledging it, and finally closes this transport.
                if (finishReason === 'MAX_TOKENS') throw fail('AI_TRUNCATED', 502);
                if (finishReason === 'STOP') {
                    if (!text.trim()) throw fail('AI_INVALID_RESPONSE', 502);
                    return text;
                }
            }
            buffer += decoder.end(); if (buffer.trim()) line(buffer.trim());
            if (finishReason === 'MAX_TOKENS') throw fail('AI_TRUNCATED', 502);
            if (!frames || finishReason !== 'STOP' || !text.trim()) throw fail('AI_INVALID_RESPONSE', 502);
            return text;
        };
        const content = await Promise.race([aborted, read()]);
        const providerMs = Date.now() - providerStart;
        check();
        if (options.validate) {
            try { await Promise.race([aborted, Promise.resolve().then(() => options.validate(content))]); }
            catch (error) { check(); throw fail('AI_INVALID_RESPONSE', 502); }
        }
        check();
        try { options.onReceipt?.({ provider: 'gemini', selectedModel: resolved.model, actualModel: resolved.model,
            fallbackUsed: false, transport: 'native_sse', authMs, providerMs,
            attempts: [{ model: resolved.model, status: 'answered', authMs, providerMs, elapsedMs: Date.now() - start }], elapsedMs: Date.now() - start }); } catch (_) {}
        return content;
    } catch (error) {
        error?.response?.data?.destroy?.();
        if (options.signal?.aborted) throw fail('AI_CANCELED', 499);
        if (timedOut || ['ECONNABORTED','ETIMEDOUT'].includes(error?.code)) throw fail('AI_TIMEOUT', 504);
        if (/^AI_/.test(error?.code || '')) throw error;
        throw fail('AI_UNAVAILABLE', 502);
    } finally {
        clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', onAbort); stream?.destroy(); controller.abort();
    }
}
async function complete(messages, instance = {}, options = {}) {
    const resolved = resolve(instance), current = settings();
    // Collect native SSE for every normal generation. Vertex unary calls can
    // stall even for tiny JSON; the returned API remains one validated result.
    if (options.stream !== false) {
        const started = Date.now(), deadline = Math.min(options.deadline || Infinity, started + (options.timeout || 45000));
        const maxTokens = options.maxTokens || 4096, retryTokens = options.retryTokens || 6144;
        const attempts = [];
        for (let attempt = 0; attempt < 2; attempt++) {
            const attemptStarted = Date.now();
            try {
                return await completeStreaming(messages, resolved, current, { ...options, deadline,
                    maxTokens: attempt ? retryTokens : maxTokens,
                    onReceipt: receipt => {
                        attempts.push(...receipt.attempts);
                        try { options.onReceipt?.({ ...receipt, attempts, elapsedMs: Date.now() - started }); } catch (_) {}
                    } });
            } catch (error) {
                attempts.push({ model: resolved.model, status: error.code, elapsedMs: Date.now() - attemptStarted });
                // Only a truncated answer can retry, on the same selected model
                // with more output tokens and the original absolute deadline.
                if (attempt || error.code !== 'AI_TRUNCATED' || retryTokens <= maxTokens || Date.now() >= deadline) throw error;
            }
        }
    }
    const url = `https://aiplatform.googleapis.com/v1/projects/${current.project}/locations/global/publishers/google/models/${resolved.model}:generateContent`;
    return Requests.complete({ ...options, provider: 'gemini', url, model: resolved.model,
        messages, temperature: resolved.temperature, getApiKey: accessToken, fallbackModel: null,
        requestBody: params => nativeBody(messages, { ...params, responseSchema: options.responseSchema, thinking: options.thinkingConfig }), readChoice: readNativeChoice,
        onReceipt: receipt => options.onReceipt?.({ ...receipt, provider: 'gemini' }) });
}
module.exports = { MODELS, configured, selectable, settings, model, resolve, accessToken, complete, nativeBody, readNativeChoice };
