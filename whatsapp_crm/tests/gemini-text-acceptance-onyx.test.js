'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const { Readable } = require('stream');
const Vertex = require('../src/services/gemini-text.service');
const Adapter = require('../src/services/gemini-onyx.service');
const tools = [{ type: 'function', function: { name: 'availability', description: 'Availability', parameters: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'], additionalProperties: false } } }];
const payload = () => ({ model: 'ava-hotel-1', messages: [{ role: 'system', content: 'Business policy' }, { role: 'user', content: 'Availability?' }], tools, tool_choice: { type: 'function', function: { name: 'availability' } }, max_tokens: 2048, stream: true });
const frame = (parts, finishReason, usageMetadata) => `data: ${JSON.stringify({ candidates: [{ content: { parts }, ...(finishReason ? { finishReason } : {}) }], ...(usageMetadata ? { usageMetadata } : {}) })}\n\n`;
const functionPart = () => ({ functionCall: { id: 'native-call-1', name: 'availability', args: { date: '2026-10-20' } }, thoughtSignature: 'opaque-thought-signature' });
async function fixture(fn) {
    const previous = { settings: Vertex.settings, token: Vertex.accessToken };
    Vertex.settings = () => ({ project: 'fixture-project' }); Vertex.accessToken = async () => 'synthetic-token';
    try { await fn(); } finally { Vertex.settings = previous.settings; Vertex.accessToken = previous.token; }
}
describe('Gemini native Onyx protocol adapter', () => {
    it('preserves parallel tool histories, IDs, results and each opaque thought signature in native parts', () => {
        const source = payload();
        source.messages.push({ role: 'assistant', content: null, tool_calls: ['a', 'b'].map(id => ({ id, type: 'function', function: { name: 'availability', arguments: JSON.stringify({ date: id }) }, extra_content: { google: { thought_signature: `signature-${id}` } } })) },
            { role: 'tool', tool_call_id: 'a', content: '{"available":true}' }, { role: 'tool', tool_call_id: 'b', content: 'Unavailable' });
        const native = Adapter.requestBody(source);
        assert.strictEqual(native.contents[1].role, 'model'); assert.strictEqual(native.contents[1].parts.length, 2);
        assert.deepStrictEqual(native.contents[1].parts.map(part => part.thoughtSignature), ['signature-a', 'signature-b']);
        assert.deepStrictEqual(native.contents[2].parts.map(part => part.functionResponse.id), ['a', 'b']);
        assert.deepStrictEqual(native.contents[2].parts[0].functionResponse.response, { available: true });
        assert.deepStrictEqual(native.contents[2].parts[1].functionResponse.response, { result: 'Unavailable' });
        assert.deepStrictEqual(native.tools[0].functionDeclarations[0].parametersJsonSchema, tools[0].function.parameters);
        assert.strictEqual(native.toolConfig.functionCallingConfig.mode, 'ANY');
    });
    it('rejects orphaned, duplicate, incomplete or malformed tool histories before provider I/O', () => {
        for (const messages of [
            [{ role: 'tool', tool_call_id: 'missing', content: '{}' }],
            [{ role: 'assistant', content: '', tool_calls: [{ id: 'one', function: { name: 'availability', arguments: '{bad' } }] }],
            [{ role: 'assistant', content: '', tool_calls: [{ id: 'one', function: { name: 'availability', arguments: '{}' } }] }],
        ]) assert.throws(() => Adapter.requestBody({ ...payload(), messages }), error => error.code === 'ONYX_LLM_INVALID_TOOL_HISTORY');
    });
    it('streams native UTF8 text but releases complete signed function calls only after a terminal STOP', () => fixture(async () => {
        const chunks = [], source = payload(), controller = new AbortController();
        const bytes = Buffer.from(frame([{ text: 'Проверяю. ' }]) + frame([functionPart()], 'STOP', { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 12 }));
        const transport = { request: async request => {
            assert.ok(request.url.endsWith('/gemini-3.8-flash:streamGenerateContent?alt=sse'));
            assert.strictEqual(request.data.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
            assert.strictEqual(request.data.store, undefined); assert.strictEqual(request.data.model, undefined);
            assert.strictEqual(request.headers.Authorization, 'Bearer synthetic-token'); assert.strictEqual(request.proxy, false);
            return { data: Readable.from([bytes.subarray(0, 35), bytes.subarray(35, 77), bytes.subarray(77)]) };
        } };
        const result = await Adapter.complete({ payload: source, model: 'gemini-3.8-flash', transport, signal: controller.signal, onChunk: chunk => chunks.push(chunk) });
        assert.strictEqual(result.result.choices[0].finish_reason, 'tool_calls');
        const call = result.result.choices[0].message.tool_calls[0];
        assert.ok(call.id.startsWith('call_')); assert.strictEqual(call.extra_content.google.thought_signature, 'opaque-thought-signature');
        assert.deepStrictEqual(JSON.parse(call.function.arguments), { date: '2026-10-20' });
        assert.strictEqual(chunks[0].choices[0].delta.content, 'Проверяю. ');
        assert.strictEqual(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
        assert.strictEqual(result.usage.completion_tokens, 5); assert.strictEqual(result.usage.total_tokens, 12);
    }));
    it('collects native SSE into a normal JSON completion for existing nonstream clients', () => fixture(async () => {
        const source = { ...payload(), stream: false, tools: [], tool_choice: 'none' };
        const result = await Adapter.complete({ payload: source, model: 'gemini-3.7-flash', signal: new AbortController().signal,
            transport: { request: async () => ({ data: Readable.from([frame([{ text: 'Подтверждённый ответ.' }], 'STOP')]) }) } });
        assert.strictEqual(result.result.choices[0].message.content, 'Подтверждённый ответ.');
        assert.strictEqual(result.result.choices[0].finish_reason, 'stop');
    }));
    it('does not release executable tool calls on truncation, missing STOP, unknown functions or malformed SSE', () => fixture(async () => {
        for (const source of [frame([functionPart()], 'MAX_TOKENS'), frame([functionPart()]), 'data: {bad}\n\n', frame([{ functionCall: { name: 'unknown', args: {} } }], 'STOP')]) {
            const chunks = [];
            await assert.rejects(Adapter.complete({ payload: payload(), model: 'gemini-3.8-flash', signal: new AbortController().signal,
                transport: { request: async () => ({ data: Readable.from([source]) }) }, onChunk: chunk => chunks.push(chunk) }),
            error => /^ONYX_LLM_/.test(error.code));
            assert.ok(!chunks.some(chunk => chunk.choices[0].delta.tool_calls));
        }
    }));
    it('cancels a stalled native stream and destroys it without a completion or a tool action', () => fixture(async () => {
        const controller = new AbortController(), stream = new Readable({ read() {} });
        let entered; const started = new Promise(resolve => { entered = resolve; });
        const chunks = [];
        const pending = Adapter.complete({ payload: payload(), model: 'gemini-3.8-flash', signal: controller.signal,
            transport: { request: async () => { entered(); return { data: stream }; } }, onChunk: chunk => chunks.push(chunk) });
        await started; await new Promise(resolve => setImmediate(resolve)); controller.abort();
        await assert.rejects(pending, error => error.code === 'ONYX_LLM_CANCELED');
        assert.strictEqual(stream.destroyed, true); assert.deepStrictEqual(chunks, []);
    }));
    it('restores signed native parts after a standard client strips vendor fields, while fencing tenant/model/arguments', () => fixture(async () => {
        createTestDB(); DB.run("INSERT INTO instances(id,name) VALUES(1,'A'),(2,'B')");
        const generated = await Adapter.complete({ payload: { ...payload(), stream: false }, model: 'gemini-3.8-flash', db: DB, businessId: 1,
            signal: new AbortController().signal, transport: { request: async () => ({ data: Readable.from([frame([functionPart()], 'STOP')]) }) } });
        const call = generated.result.choices[0].message.tool_calls[0];
        const standard = { id: call.id, type: call.type, function: call.function };
        const history = { ...payload(), messages: [{ role: 'user', content: 'Availability?' },
            { role: 'assistant', content: null, tool_calls: [standard] }, { role: 'tool', tool_call_id: call.id, content: '{"available":true}' },
            { role: 'user', content: 'Summarize the result.' }] };
        const restored = Adapter.requestBody(history, Adapter.partCache(DB, 1, 'gemini-3.8-flash'));
        assert.deepStrictEqual(restored.contents[1].parts[0], functionPart());
        assert.strictEqual(restored.contents[2].parts[0].functionResponse.id, 'native-call-1');
        // Real Vertex rejects tool results merged with this later question
        // with INVALID_ARGUMENT: Requests ending with a model turn are not supported.
        assert.deepStrictEqual(restored.contents.map(content => content.role), ['user', 'model', 'user', 'user']);
        assert.strictEqual(restored.contents[2].parts.length, 1);
        assert.deepStrictEqual(restored.contents[3].parts, [{ text: 'Summarize the result.' }]);
        for (const cache of [Adapter.partCache(DB, 2, 'gemini-3.8-flash'), Adapter.partCache(DB, 1, 'gemini-3.7-flash')]) {
            const legacy = Adapter.requestBody(history, cache);
            assert.ok(legacy.contents.every(content => content.parts.every(part => !part.functionCall && !part.functionResponse && !part.thoughtSignature)));
            assert.ok(JSON.stringify(legacy.contents).includes('available'));
            assert.ok(!JSON.stringify(legacy.contents).includes('opaque-thought-signature'));
        }
        standard.function = { ...standard.function, arguments: '{"date":"tampered"}' };
        assert.throws(() => Adapter.requestBody(history, Adapter.partCache(DB, 1, 'gemini-3.8-flash')), error => error.code === 'ONYX_LLM_INVALID_TOOL_HISTORY');
    }));
    it('evicts bounded old tool context without blocking new requests and preserves evicted history as quoted facts', () => fixture(async () => {
        createTestDB(); DB.run("INSERT INTO instances(id,name) VALUES(1,'A')");
        const cache = Adapter.partCache(DB, 1, 'gemini-3.8-flash');
        cache.save([{ id: 'existing', function: { name: 'availability', arguments: '{}' } }], [functionPart()]);
        const row = DB.get('SELECT * FROM onyx_gemini_tool_parts LIMIT 1');
        for (let index = 1; index < 256; index++) DB.run('INSERT INTO onyx_gemini_tool_parts VALUES(?,?,?,?,?,?)', [1, row.model, `existing-${index}`, row.args_hash, row.part_json, row.expires_at]);
        const chunks = [];
        DB.run("UPDATE onyx_gemini_tool_parts SET expires_at=? WHERE call_id='existing'", [Date.now() + 1000]);
        await Adapter.complete({ payload: payload(), model: 'gemini-3.8-flash', db: DB, businessId: 1,
            signal: new AbortController().signal, transport: { request: async () => ({ data: Readable.from([frame([functionPart()], 'STOP')]) }) }, onChunk: chunk => chunks.push(chunk) });
        assert.ok(chunks.some(chunk => chunk.choices[0].delta.tool_calls));
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM onyx_gemini_tool_parts').n, 256);
        assert.strictEqual(DB.get("SELECT call_id FROM onyx_gemini_tool_parts WHERE call_id='existing'"), undefined);
        const history = Adapter.requestBody({ ...payload(), messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'existing', type: 'function', function: { name: 'availability', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'existing', content: '{"available":true}' }] }, cache);
        assert.ok(JSON.stringify(history.contents).includes('available'));
        assert.ok(history.contents.every(content => content.parts.every(part => !part.functionCall && !part.functionResponse)));
    }));
});
