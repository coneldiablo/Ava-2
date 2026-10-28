'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const { Readable } = require('node:stream');
const DB = require('../src/services/database.service');
const Vertex = require('../src/services/gemini-text.service');
const Onyx = require('../src/services/gemini-onyx.service');

const model = 'gemini-3.8-flash';
const payload = { model: 'ava-hotel-1', messages: [{ role: 'user', content: 'Question.' }], stream: false };
const frame = (parts, finishReason = 'STOP') => ({ candidates: [{ index: 0, content: { parts }, ...(finishReason ? { finishReason } : {}) }] });
const sse = value => `data: ${JSON.stringify(value)}\n\n`;
function heldOpen(chunks) {
    let pushed = false;
    return new Readable({ read() {
        if (pushed) return;
        pushed = true;
        for (const chunk of chunks) this.push(chunk);
        // SDK response remains open after the terminal packet. Never push EOF.
    } });
}
async function fixture(run) {
    const settings = Vertex.settings, token = Vertex.accessToken;
    Vertex.settings = () => ({ project: 'project-fixture' });
    Vertex.accessToken = async () => 'fixture-only-token';
    try { await run(); } finally { Vertex.settings = settings; Vertex.accessToken = token; }
}
async function invoke(chunks, { request = payload, milliseconds = 150, signal, db, onChunk } = {}) {
    const stream = heldOpen(chunks), requests = [], emitted = [], controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), milliseconds);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
        const result = await Onyx.complete({ payload: request, model, signal: controller.signal,
            db, businessId: db ? 1 : undefined,
            onChunk: async value => { emitted.push(value); await onChunk?.(value); },
            transport: { request: async options => { requests.push(options); return { data: stream }; } } });
        return { result, requests, emitted, stream, productDestroyed: stream.destroyed };
    } catch (error) {
        error.testEmitted = emitted; error.testStreamDestroyed = stream.destroyed;
        error.testRequests = requests; throw error;
    }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); stream.destroy(); }
}

describe('Onyx Gemini terminal SSE without HTTP EOF', () => {
    it('returns the selected model STOP result and closes held-open transport with one request', () => fixture(async () => {
        const { result, requests, productDestroyed } = await invoke([sse(frame([{ text: 'Ready.' }]))]);
        assert.strictEqual(result.result.choices[0].message.content, 'Ready.');
        assert.strictEqual(result.result.choices[0].finish_reason, 'stop');
        assert.strictEqual(requests.length, 1); assert.ok(requests[0].url.includes(`/${model}:streamGenerateContent`));
        assert.strictEqual(requests[0].proxy, false); assert.strictEqual(productDestroyed, true);
    }));

    it('streams split UTF-8 text then emits final result before EOF and retains same-chunk usage', () => fixture(async () => {
        const bytes = Buffer.from(sse(frame([{ text: 'Привет' }], null)) + sse(frame([{ text: ' мир' }]))
            + sse({ usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }));
        const offset = bytes.indexOf(Buffer.from('Привет')) + 1;
        const { result, emitted } = await invoke([bytes.subarray(0, offset), bytes.subarray(offset)], { request: { ...payload, stream: true } });
        assert.strictEqual(result.result.choices[0].message.content, 'Привет мир');
        assert.strictEqual(emitted.map(value => value.choices[0].delta.content || '').join(''), 'Привет мир');
        assert.strictEqual(emitted.at(-1).choices[0].finish_reason, 'stop');
        assert.strictEqual(result.usage.total_tokens, 5);
    }));

    it('preserves terminal tool calls and opaque signature in the scoped cache and continuation', () => fixture(async () => {
        createTestDB();
        const signature = 'fixture-opaque-signature';
        const part = { functionCall: { id: 'native-call', name: 'lookup', args: { key: 'one' } }, thoughtSignature: signature };
        const request = { ...payload, stream: true, tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] };
        try {
            const { result, emitted } = await invoke([sse(frame([part]))], { request, db: DB });
            const call = result.result.choices[0].message.tool_calls[0];
            assert.strictEqual(result.result.choices[0].finish_reason, 'tool_calls');
            assert.strictEqual(call.extra_content.google.thought_signature, signature);
            assert.strictEqual(emitted.at(-2).choices[0].delta.tool_calls[0].function.name, 'lookup');
            assert.strictEqual(emitted.at(-1).choices[0].finish_reason, 'tool_calls');
            const history = Onyx.requestBody({ ...request, messages: [...payload.messages,
                result.result.choices[0].message, { role: 'tool', tool_call_id: call.id, content: '{"ok":true}' }] }, Onyx.partCache(DB, 1, model));
            assert.deepStrictEqual(history.contents[1].parts[0], part);
            assert.strictEqual(history.contents[2].parts[0].functionResponse.id, 'native-call');
        } finally { DB.db.close(); }
    }));

    it('never acknowledges partial text or DONE without a terminal candidate', () => fixture(async () => {
        for (const tail of ['', 'data: [DONE]\n\n']) await assert.rejects(
            invoke([sse(frame([{ text: 'Partial' }], null)), tail], { request: { ...payload, stream: true }, milliseconds: 25 }),
            error => error.code === 'ONYX_LLM_CANCELED'
                && !error.testEmitted.some(value => value.choices[0].finish_reason)
                && error.testStreamDestroyed);
    }));

    it('rejects MAX_TOKENS and other terminal refusals immediately without retry or final success', () => fixture(async () => {
        for (const [reason, code] of [['MAX_TOKENS', 'ONYX_LLM_TRUNCATED'], ['SAFETY', 'ONYX_LLM_INVALID_UPSTREAM']]) {
            await assert.rejects(invoke([sse(frame([{ text: 'Partial' }], reason))]), error => error.code === code
                && error.testStreamDestroyed && error.testRequests.length === 1);
        }
    }));

    it('keeps empty/thought-only, malformed, multiple-candidate and byte-limit fences before success', () => fixture(async () => {
        const cases = [
            [sse(frame([{ text: 'Private thought', thought: true }])), 'ONYX_LLM_INCOMPLETE_STREAM'],
            [sse(frame([{ text: 'Ready' }])) + 'data: {broken}\n\n', 'ONYX_LLM_INVALID_UPSTREAM'],
            [sse({ candidates: [...frame([{ text: 'One' }]).candidates, ...frame([{ text: 'Two' }]).candidates] }), 'ONYX_LLM_INVALID_UPSTREAM'],
            [sse({ error: { code: 'provider_fixture_error' } }), 'ONYX_LLM_INVALID_UPSTREAM'],
            [sse(frame([{ text: 'x'.repeat(2 * 1024 * 1024) }])), 'ONYX_LLM_RESPONSE_LIMIT'],
        ];
        for (const [input, code] of cases) await assert.rejects(invoke([input]), error => error.code === code && error.testStreamDestroyed);
    }));

    it('retains explicit single-tool policy and rejects undeclared tools at STOP', () => fixture(async () => {
        const declaration = { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } };
        const part = name => ({ functionCall: { name, args: {} } });
        await assert.rejects(invoke([sse(frame([part('lookup'), part('lookup')]))],
            { request: { ...payload, tools: [declaration], parallel_tool_calls: false } }), error => error.code === 'ONYX_LLM_PARALLEL_CALLS_DISABLED');
        await assert.rejects(invoke([sse(frame([part('other')]))],
            { request: { ...payload, tools: [declaration] } }), error => error.code === 'ONYX_LLM_INVALID_UPSTREAM');
    }));

    it('cancels one partial stream without canceling a concurrent completed stream', () => fixture(async () => {
        const one = invoke([sse(frame([{ text: 'Partial' }], null))], { milliseconds: 25 });
        const two = invoke([sse(frame([{ text: 'Independent' }]))]);
        const results = await Promise.allSettled([one, two]);
        assert.strictEqual(results[0].status, 'rejected'); assert.strictEqual(results[0].reason.code, 'ONYX_LLM_CANCELED');
        assert.strictEqual(results[1].status, 'fulfilled');
        assert.strictEqual(results[1].value.result.result.choices[0].message.content, 'Independent');
    }));
});
