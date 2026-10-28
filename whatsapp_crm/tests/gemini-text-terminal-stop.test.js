'use strict';
const { describe, it, assert } = require('./test-helper');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Readable } = require('node:stream');
const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');
const Gemini = require('../src/services/gemini-text.service');

async function fixture(run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-gemini-terminal-'));
    const adc = path.join(dir, 'adc.json');
    fs.writeFileSync(adc, JSON.stringify({ type: 'service_account', client_email: 'fixture@example.test', private_key: 'fixture' }), { mode: 0o600 });
    const names = ['GEMINI_PROJECT_ID', 'GEMINI_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_TEXT_ENABLED'];
    const env = Object.fromEntries(names.map(name => [name, process.env[name]]));
    const post = axios.post, token = GoogleAuth.prototype.getAccessToken;
    Object.assign(process.env, { GEMINI_PROJECT_ID: 'project-fixture', GEMINI_LOCATION: 'global', GOOGLE_APPLICATION_CREDENTIALS: adc, GEMINI_TEXT_ENABLED: 'true' });
    GoogleAuth.prototype.getAccessToken = async () => 'fixture-token';
    try { await run(); } finally {
        axios.post = post; GoogleAuth.prototype.getAccessToken = token;
        for (const name of names) if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
function heldOpen(text, finishReason) {
    let pushed = false;
    return new Readable({ read() {
        if (pushed) return;
        pushed = true;
        this.push('data: ' + JSON.stringify({ candidates: [{ index: 0, finishReason, content: { parts: [{ text }] } }] }) + '\n\n');
        // Vertex has completed the candidate; HTTP EOF is deliberately absent.
    } });
}
const messages = [{ role: 'user', content: 'Return JSON.' }];
const business = { geminiModel: 'gemini-3.8-flash', aiTemperature: 0.3 };

describe('Gemini terminal SSE candidate', () => {
    it('validates the complete STOP answer and closes transport without waiting for HTTP EOF', () => fixture(async () => {
        let stream, receipt, validated = 0;
        axios.post = async () => ({ data: stream = heldOpen('{"ok":true}', 'STOP') });
        const value = await Gemini.complete(messages, business, { timeout: 100, json: true,
            validate: raw => { assert.strictEqual(JSON.parse(raw).ok, true); validated++; },
            onReceipt: result => { receipt = result; } });
        assert.strictEqual(value, '{"ok":true}'); assert.strictEqual(validated, 1);
        assert.strictEqual(receipt.selectedModel, business.geminiModel);
        assert.strictEqual(receipt.fallbackUsed, false); assert.strictEqual(stream.destroyed, true);
    }));

    it('rejects invalid JSON after terminal STOP before creating a successful receipt', () => fixture(async () => {
        let stream, receipt = false;
        axios.post = async () => ({ data: stream = heldOpen('{"ok":', 'STOP') });
        await assert.rejects(Gemini.complete(messages, business, { timeout: 100, json: true,
            validate: raw => JSON.parse(raw), onReceipt: () => { receipt = true; } }), error => error.code === 'AI_INVALID_RESPONSE');
        assert.strictEqual(receipt, false); assert.strictEqual(stream.destroyed, true);
    }));

    it('recognizes MAX_TOKENS without EOF and retries only the same model within the original deadline', () => fixture(async () => {
        const streams = [], calls = []; let receipt;
        axios.post = async (url, body) => {
            calls.push({ url, tokens: body.generationConfig.maxOutputTokens });
            const stream = heldOpen(calls.length === 1 ? '{"ok":' : '{"ok":true}', calls.length === 1 ? 'MAX_TOKENS' : 'STOP');
            streams.push(stream); return { data: stream };
        };
        assert.strictEqual(await Gemini.complete(messages, business, { timeout: 100, json: true, maxTokens: 128, retryTokens: 256,
            validate: raw => JSON.parse(raw), onReceipt: value => { receipt = value; } }), '{"ok":true}');
        assert.deepStrictEqual(calls.map(call => call.tokens), [128, 256]);
        assert.strictEqual(calls[0].url, calls[1].url); assert.ok(streams.every(stream => stream.destroyed));
        assert.deepStrictEqual(receipt.attempts.map(attempt => attempt.status), ['AI_TRUNCATED', 'answered']);
    }));

    it('still times out an unfinished candidate and never validates or acknowledges partial text', () => fixture(async () => {
        let stream, validated = false, receipt = false;
        axios.post = async () => ({ data: stream = heldOpen('{"ok":', undefined) });
        await assert.rejects(Gemini.complete(messages, business, { timeout: 25, json: true,
            validate: () => { validated = true; }, onReceipt: () => { receipt = true; } }), error => error.code === 'AI_TIMEOUT');
        assert.strictEqual(validated, false); assert.strictEqual(receipt, false); assert.strictEqual(stream.destroyed, true);
    }));
});
