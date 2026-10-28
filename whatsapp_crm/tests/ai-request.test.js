'use strict';
const { describe, it, assert } = require('./test-helper');
const axios = require('axios');
const Requests = require('../src/services/ai-request.service');
const args = { url: 'https://example.test/chat/completions', apiKey: 'synthetic', model: 'mimo-v2.6-pro', messages: [{ role: 'user', content: 'JSON facts' }], json: true };
const response = (finish_reason, content = '{"ok":true}') => ({ data: { choices: [{ finish_reason, message: { content } }] } });
async function mocked(post, work) { const original = axios.post; axios.post = post; try { await work(); } finally { axios.post = original; } }
describe('AI bounded request policy', () => {
    it('sets supported explicit budgets and reasoning for selected model families', () => {
        const mimo = Requests.modelOptions('mimo-v2.6-pro', { json: true });
        assert.strictEqual(mimo.max_tokens, 4096); assert.strictEqual(mimo.reasoning.effort, 'low');
        assert.deepStrictEqual(mimo.response_format, { type: 'json_object' });
        assert.strictEqual(Requests.modelOptions('gpt-oss-120b').reasoning.effort, 'low');
        assert.strictEqual(Requests.modelOptions('gpt-5').temperature, undefined);
        const unknown = Requests.modelOptions('tenant-preset'); assert.strictEqual(unknown.reasoning, undefined);
    });
    it('retries an HTTP 200 truncated JSON once with capped budget and shared deadline', async () => {
        let calls = 0, firstTimeout;
        await mocked(async (_, body, options) => {
            calls++; assert.ok(options.signal); assert.strictEqual(options.maxRedirects, 0);
            if (calls === 1) { firstTimeout = options.timeout; assert.strictEqual(body.max_tokens, 4096); return response('length', '{"ok":'); }
            assert.strictEqual(body.max_tokens, 6144); assert.ok(options.timeout <= firstTimeout);
            return response('stop');
        }, async () => assert.strictEqual(await Requests.complete(args), '{"ok":true}'));
        assert.strictEqual(calls, 2);
    });
    it('rejects repeated truncation even if its JSON happens to be syntactically valid', async () => {
        let calls = 0;
        await mocked(async () => { calls++; return response('length'); }, async () => {
            await assert.rejects(Requests.complete(args), e => e.code === 'AI_TRUNCATED');
        }); assert.strictEqual(calls, 2);
    });
    it('aborts in-flight request and excludes late completion', async () => {
        const controller = new AbortController();
        await mocked(async (_, __, options) => { controller.abort(); assert.strictEqual(options.signal.aborted, true); return response('stop'); }, async () => {
            await assert.rejects(Requests.complete({ ...args, signal: controller.signal }), e => e.code === 'AI_CANCELED');
        });
    });
    it('enforces total deadline even if transport never settles after abort', async () => {
        let transportSignal;
        await mocked(async (_, __, options) => { transportSignal = options.signal; return new Promise(() => {}); }, async () => {
            await assert.rejects(Requests.complete({ ...args, timeout: 10 }), e => e.code === 'AI_TIMEOUT');
            assert.strictEqual(transportSignal.aborted, true);
        });
    });
    it('falls back on timeout using the same credential and messages within the total deadline', async () => {
        const calls = []; let receipt;
        await mocked(async (_, body, options) => {
            calls.push({ body, options });
            assert.strictEqual(options.headers.Authorization, 'Bearer synthetic');
            assert.strictEqual(body.messages, args.messages);
            if (calls.length === 1) { assert.ok(options.timeout <= 20000); throw Object.assign(new Error('private upstream'), { code: 'ETIMEDOUT' }); }
            assert.strictEqual(body.model, 'gpt-oss-120b'); assert.ok(options.timeout <= 45000);
            assert.strictEqual(calls[0].options.signal.aborted, true); return response('stop');
        }, async () => {
            assert.strictEqual(await Requests.complete({ ...args, fallbackModel: 'gpt-oss-120b', primaryTimeout: 20000, onReceipt: r => { receipt = r; } }), '{"ok":true}');
        });
        assert.strictEqual(calls.length, 2); assert.strictEqual(receipt.fallbackUsed, true);
        assert.strictEqual(receipt.actualModel, 'gpt-oss-120b'); assert.strictEqual(receipt.attempts[0].status, 'AI_TIMEOUT');
    });
    it('validates fallback identically and bounds truncation plus fallback to two calls total', async () => {
        for (const firstReason of ['length', 'stop']) {
            let calls = 0;
            await mocked(async (_, body) => { calls++; return response(calls === 1 ? firstReason : 'stop', calls === 1 ? '{"bad":true}' : '{"ok":true}'); }, async () => {
                await Requests.complete({ ...args, fallbackModel: 'gpt-oss-120b', validate: text => { if (!JSON.parse(text).ok) throw new Error('private invalid'); } });
            }); assert.strictEqual(calls, 2);
        }
        let calls = 0;
        await mocked(async () => { calls++; return response('length'); }, async () => {
            await assert.rejects(Requests.complete({ ...args, fallbackModel: 'gpt-oss-120b' }), e => e.code === 'AI_TRUNCATED');
        }); assert.strictEqual(calls, 2);
    });
    it('never falls back after caller abort or duplicates the configured default on timeout', async () => {
        let calls = 0; const controller = new AbortController();
        await mocked(async () => { calls++; controller.abort(); return response('stop'); }, async () => {
            await assert.rejects(Requests.complete({ ...args, fallbackModel: 'gpt-oss-120b', signal: controller.signal }), e => e.code === 'AI_CANCELED');
        }); assert.strictEqual(calls, 1);
        calls = 0;
        await mocked(async (_, __, options) => { calls++; assert.ok(options.timeout > 20000); throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }, async () => {
            await assert.rejects(Requests.complete({ ...args, fallbackModel: args.model, primaryTimeout: 20000 }), e => e.code === 'AI_TIMEOUT');
        }); assert.strictEqual(calls, 1);
    });
    it('aborts both hanging attempts by their shared bounded deadline', async () => {
        const signals = [];
        await mocked(async (_, __, options) => { signals.push(options.signal); return new Promise(() => {}); }, async () => {
            await assert.rejects(Requests.complete({ ...args, fallbackModel: 'gpt-oss-120b', timeout: 20, primaryTimeout: 5 }), e => e.code === 'AI_TIMEOUT');
        }); assert.strictEqual(signals.length, 2); assert.ok(signals.every(signal => signal.aborted));
    });
    it('rejects asynchronous invalid fallback content without a third attempt or private error detail', async () => {
        let calls = 0;
        await mocked(async () => { calls++; return response('stop'); }, async () => {
            await assert.rejects(Requests.complete({ ...args, fallbackModel: 'gpt-oss-120b', validate: async () => { throw new Error('private invalid'); } }), e => e.code === 'AI_INVALID_RESPONSE' && !e.message.includes('private'));
        }); assert.strictEqual(calls, 2);
    });
    it('does not request after expired deadline and sanitizes upstream timeout', async () => {
        await mocked(async () => { throw new Error('should not request'); }, async () => {
            await assert.rejects(Requests.complete({ ...args, deadline: Date.now() - 1 }), e => e.code === 'AI_TIMEOUT');
        });
        await mocked(async () => { throw Object.assign(new Error('secret upstream'), { code: 'ETIMEDOUT' }); }, async () => {
            await assert.rejects(Requests.complete(args), e => e.code === 'AI_TIMEOUT' && !e.message.includes('secret'));
        });
    });
});
