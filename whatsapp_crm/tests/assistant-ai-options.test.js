'use strict';
const { describe, it, assert } = require('./test-helper');
const axios = require('axios');
const AI = require('../src/services/ai.service');
describe('Assistant generation provider cancellation', () => {
    it('passes abort signal and bounded response size to real plain call path', async () => {
        const post = axios.post;
        const controller = new AbortController();
        axios.post = async (_, body, options) => {
            assert.ok(options.signal instanceof AbortSignal);
            assert.strictEqual(options.signal.aborted, false);
            assert.ok(options.timeout > 0 && options.timeout <= 1000);
            assert.strictEqual(options.maxContentLength, 128 * 1024);
            assert.strictEqual(body.model, 'selected-business-model');
            assert.strictEqual(body.store, false);
            return { data: { choices: [{ message: { content: '{"systemPrompt":"test"}' } }] } };
        };
        try {
            const result = await AI.generatePlainText([{ role: 'user', content: 'facts' }],
                { yandexGptKey: 'test-key', yandexGptModelUri: 'selected-business-model' }, { signal: controller.signal, timeout: 1000 });
            assert.ok(result.includes('systemPrompt'));
        } finally { axios.post = post; }
    });
    it('keeps existing structured chat call functional with no options argument', async () => {
        const post = axios.post;
        axios.post = async (_, body, options) => {
            assert.strictEqual(options.timeout, 45000);
            assert.strictEqual(body.model, 'model');
            return { data: { choices: [{ message: { content: '{"reply":"Existing chat still works"}' } }] } };
        };
        try {
            const result = await AI._callAITunnel([{ role: 'user', content: 'hello' }], 'key', 'model', 0.5);
            assert.ok(result.includes('Existing chat still works'));
        } finally { axios.post = post; }
    });
});
