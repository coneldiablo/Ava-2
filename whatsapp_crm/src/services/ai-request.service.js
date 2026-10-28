'use strict';
const axios = require('axios');
const fail = (code, statusCode = 502) => Object.assign(new Error(code), { code, statusCode });
// AITunnel /docs/reasoning: low is portable; never request none on mandatory-thinking models.
function modelOptions(model, { maxTokens = 4096, temperature = 0, json = false, provider = 'aitunnel' } = {}) {
    if (provider === 'gemini') return { max_tokens: maxTokens, temperature, reasoning_effort: 'low',
        ...(json ? { response_format: { type: 'json_object' } } : {}) };
    const name = String(model).toLowerCase();
    const body = { max_tokens: maxTokens, store: false };
    if (!/(?:^|\/)(?:o[134](?:-|$)|gpt-[56])/.test(name)) body.temperature = temperature;
    if (/gpt-oss|(?:^|\/)o[134](?:-|$)|gpt-[56]|gemini|deepseek-r|qwen.*(?:thinking|reason)|glm-5|mimo-v2/.test(name)) body.reasoning = { effort: 'low', exclude: true };
    if (json && /gpt-oss|gpt-[456]|mimo-v2/.test(name)) body.response_format = { type: 'json_object' };
    return body;
}
async function complete({ url, apiKey, getApiKey, provider = 'aitunnel', model, messages, signal, timeout = 45000, deadline,
    maxTokens = 4096, retryTokens = 6144, temperature = 0, json = false,
    fallbackModel, primaryTimeout, validate, onReceipt, requestBody, readChoice,
    maxContentLength = 128 * 1024, maxBodyLength = 256 * 1024 }) {
    const started = Date.now(), expires = Math.min(deadline || Infinity, started + timeout);
    const fallback = typeof fallbackModel === 'string' && fallbackModel.trim() && fallbackModel.trim() !== model
        ? fallbackModel.trim() : null;
    const attempts = [];
    let selectedModel = model;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (signal?.aborted) throw fail('AI_CANCELED', 499);
        const remaining = expires - Date.now();
        if (remaining <= 0) throw fail('AI_TIMEOUT', 504);
        const budget = attempt === 0 && fallback ? Math.min(remaining, primaryTimeout || remaining) : remaining;
        const controller = new AbortController();
        let timedOut = false, rejectAbort;
        const aborted = new Promise((_, reject) => { rejectAbort = reject; });
        const cancel = () => controller.abort();
        const onAbort = () => rejectAbort(fail(timedOut ? 'AI_TIMEOUT' : 'AI_CANCELED', timedOut ? 504 : 499));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        signal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, budget));
        const attemptStart = Date.now();
        try {
            const credential = getApiKey ? await Promise.race([aborted, getApiKey({ signal: controller.signal })]) : apiKey;
            if (controller.signal.aborted) throw fail(timedOut ? 'AI_TIMEOUT' : 'AI_CANCELED', timedOut ? 504 : 499);
            const body = requestBody ? requestBody({ maxTokens: attempt ? retryTokens : maxTokens, temperature, json })
                : { model: provider === 'gemini' ? `google/${selectedModel}` : selectedModel, messages,
                    ...modelOptions(selectedModel, { maxTokens: attempt ? retryTokens : maxTokens, temperature, json, provider }) };
            const response = await Promise.race([aborted, axios.post(url, body, {
                headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
                timeout: Math.max(1, Math.min(budget, expires - Date.now())), proxy: provider === 'gemini' ? false : undefined, signal: controller.signal, maxRedirects: 0,
                maxContentLength, maxBodyLength, transitional: { clarifyTimeoutError: true },
            })]);
            if (signal?.aborted) throw fail('AI_CANCELED', 499);
            if (controller.signal.aborted) throw fail(timedOut ? 'AI_TIMEOUT' : 'AI_CANCELED', timedOut ? 504 : 499);
            const choice = readChoice ? readChoice(response?.data) : response?.data?.choices?.[0];
            if (['length', 'max_tokens'].includes(choice?.finish_reason)) throw fail('AI_TRUNCATED');
            if (choice?.finish_reason && choice.finish_reason !== 'stop') throw fail('AI_INVALID_RESPONSE');
            const content = choice?.message?.content;
            if (typeof content !== 'string' || !content.trim()) throw fail('AI_INVALID_RESPONSE');
            if (validate) {
                try { await Promise.race([aborted, Promise.resolve().then(() => validate(content))]); }
                catch (_) { throw fail('AI_INVALID_RESPONSE'); }
            }
            if (signal?.aborted) throw fail('AI_CANCELED', 499);
            attempts.push({ model: selectedModel, status: 'answered', elapsedMs: Date.now() - attemptStart });
            const receipt = { selectedModel: model, actualModel: selectedModel, fallbackUsed: selectedModel !== model,
                attempts, elapsedMs: Date.now() - started };
            try { onReceipt?.(receipt); } catch (_) { /* Internal receipt hooks cannot change model success. */ }
            return content;
        } catch (error) {
            const safeError = signal?.aborted ? fail('AI_CANCELED', 499)
                : timedOut || ['ECONNABORTED', 'ETIMEDOUT'].includes(error?.code) ? fail('AI_TIMEOUT', 504)
                    : /^AI_/.test(error?.code || '') ? error : fail('AI_UNAVAILABLE');
            attempts.push({ model: selectedModel, status: safeError.code, elapsedMs: Date.now() - attemptStart });
            if (safeError.code === 'AI_CANCELED') throw safeError;
            const canTry = attempt === 0 && expires - Date.now() > 0
                && (fallback || (safeError.code === 'AI_TRUNCATED' && retryTokens > maxTokens));
            if (!canTry) throw safeError;
            selectedModel = fallback || model;
        } finally {
            clearTimeout(timer); signal?.removeEventListener('abort', cancel);
            controller.signal.removeEventListener('abort', onAbort); controller.abort();
        }
    }
}
module.exports = { complete, modelOptions };
