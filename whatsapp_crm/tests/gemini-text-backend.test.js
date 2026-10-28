'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const fs = require('fs'), os = require('os'), path = require('path');
const { Readable } = require('stream');
const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');
const AI = require('../src/services/ai.service');
const Gemini = require('../src/services/gemini-text.service');
const DB = require('../src/services/database.service');
const config = require('../src/config');
const { OnyxLlmGateway } = require('../src/services/onyx-llm-gateway.service');
const Dashboard = require('../src/services/dashboard/ai.model');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const Pages = require('../src/services/assistant-public-pages.service');
const Draft = require('../src/services/assistant-draft.service');

async function fixture(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-gemini-text-'));
    const file = path.join(dir, 'adc.json');
    fs.writeFileSync(file, JSON.stringify({ type: 'service_account', client_email: 'fixture@example.test', private_key: 'fixture-key' }), { mode: 0o600 });
    const names = ['GEMINI_PROJECT_ID','GEMINI_LOCATION','GOOGLE_APPLICATION_CREDENTIALS','GEMINI_TEXT_ENABLED','GEMINI_TEXT_ADMISSION_ENABLED','ONYX_LLM_PROXY_ENABLED','GEMINI_TEXT_MODEL'];
    const env = Object.fromEntries(names.map(name => [name, process.env[name]]));
    const old = { post: axios.post, get: axios.get, token: GoogleAuth.prototype.getAccessToken, key: config.aiTunnel.apiKey };
    Object.assign(process.env, { GEMINI_PROJECT_ID: 'project-fixture', GEMINI_LOCATION: 'global', GOOGLE_APPLICATION_CREDENTIALS: file, GEMINI_TEXT_ENABLED: 'true', GEMINI_TEXT_ADMISSION_ENABLED: 'true', ONYX_LLM_PROXY_ENABLED: 'true' });
    delete process.env.GEMINI_TEXT_MODEL;
    config.aiTunnel.apiKey = '';
    GoogleAuth.prototype.getAccessToken = async () => 'fixture-adc-token';
    try { await fn({ file }); } finally {
        axios.post = old.post; axios.get = old.get; GoogleAuth.prototype.getAccessToken = old.token; config.aiTunnel.apiKey = old.key;
        for (const name of names) if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
const nativeData = (text, reason = 'STOP') => ({ candidates: [{ finishReason: reason, content: { parts: [{ text }] } }] });
const native = (text, reason = 'STOP') => ({ data: Readable.from(['data: ' + JSON.stringify(nativeData(text, reason)) + '\n\n']) });
const selection = { aiProvider: 'gemini', geminiModel: 'gemini-3.7-flash', yandexGptModelUri: 'preserved-aitunnel-model' };

async function customer(role, fn) {
    createTestDB(); Identity.ensureSchema();
    const business = await DB.createInstance({ name: 'Gemini own' });
    const foreign = await DB.createInstance({ name: 'Gemini foreign' });
    await DB.updateInstance(business.id, { aiProvider: 'aitunnel', yandexGptKey: 'tenant-old-key', yandexGptModelUri: 'old-aitunnel', systemPrompt: 'Keep business prompt' });
    const invitation = Identity.createInvitation({ platformRole: 'platform_admin' }, { email: 'gemini@example.test', businessId: business.id, role });
    const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), 'gemini-test-subject');
    const token = Identity.createSession(user.subject, 'gemini-test-session');
    const before = { enabled: Auth.config.enabled, customer: process.env.AVA_CUSTOMER_ACCESS_ENABLED, origin: process.env.WHATSAPP_CRM_PUBLIC_URL };
    Auth.config.enabled = true; process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
    const server = await new Promise(resolve => { const listener = require('../src/app').app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const origin = `http://127.0.0.1:${server.address().port}`; process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
    const request = (url, body, headers = {}) => fetch(`${origin}/api${url}`, { method: body === undefined ? 'GET' : 'PUT',
        headers: { Cookie: `crm_session=ava2:${token}`, Origin: origin, 'Content-Type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try { await fn({ business, foreign, request, user, token }); } finally {
        Auth.config.enabled = before.enabled;
        for (const [key, value] of [['AVA_CUSTOMER_ACCESS_ENABLED', before.customer], ['WHATSAPP_CRM_PUBLIC_URL', before.origin]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
        await new Promise(resolve => server.close(resolve));
    }
}

describe('Gemini text AI provider and shared business contracts', () => {
    it('uses the selected native Gemini model with ADC, LOW, JSON and no AITunnel credential or URL', () => fixture(async () => {
        let calls = 0;
        axios.post = async (url, body, options) => {
            calls++; assert.ok(url.endsWith('/gemini-3.7-flash:streamGenerateContent?alt=sse')); assert.ok(url.startsWith('https://aiplatform.googleapis.com/v1/'));
            assert.strictEqual(options.headers.Authorization, 'Bearer fixture-adc-token'); assert.strictEqual(options.proxy, false);
            assert.strictEqual(options.responseType, 'stream');
            assert.strictEqual(body.generationConfig.thinkingConfig.thinkingLevel, 'LOW'); assert.strictEqual(body.generationConfig.responseMimeType, 'application/json');
            if (calls === 1) { assert.strictEqual(body.systemInstruction.parts[0].text, 'Keep policy'); assert.strictEqual(body.contents[0].role, 'model');
                assert.strictEqual(body.contents[1].role, 'user'); } assert.ok(!JSON.stringify(body).includes('preserved-aitunnel-model'));
            return native('{"reply":"Gemini reply","status":"qualified","action":"none"}');
        };
        const raw = await AI.generatePlainText([{ role: 'system', content: 'Keep policy' }, { role: 'assistant', content: 'History' }, { role: 'user', content: 'Question' }], selection, { json: true });
        assert.strictEqual(JSON.parse(raw).reply, 'Gemini reply');
        const response = await AI.getResponse([{ role: 'user', content: 'Question' }], { instanceConfig: selection });
        assert.strictEqual(response.reply, 'Gemini reply'); assert.strictEqual(response.status, 'qualified'); assert.strictEqual(calls, 2);
    }));

    it('does not fallback to AITunnel or another Gemini model on failure; truncated output retries only same model', () => fixture(async () => {
        const calls = [], streams = []; let receipt;
        axios.post = async (url, body) => {
            calls.push([url, body.generationConfig.maxOutputTokens]);
            if (streams.length) assert.strictEqual(streams[0].destroyed, true);
            const response = calls.length === 1 ? native('partial', 'MAX_TOKENS') : native('complete');
            streams.push(response.data); return response;
        };
        assert.strictEqual(await AI.generatePlainText([{ role: 'user', content: 'Question' }], selection,
            { maxTokens: 200, retryTokens: 400, onReceipt: value => { receipt = value; } }), 'complete');
        assert.strictEqual(receipt.transport, 'native_sse');
        assert.deepStrictEqual(receipt.attempts.map(attempt => attempt.status), ['AI_TRUNCATED', 'answered']);
        assert.ok(streams.every(stream => stream.destroyed));
        assert.strictEqual(calls.length, 2); assert.strictEqual(calls[0][0], calls[1][0]); assert.deepStrictEqual(calls.map(call => call[1]), [200, 400]);
        calls.length = 0; config.aiTunnel.apiKey = 'must-not-use';
        axios.post = async url => { calls.push(url); throw Object.assign(new Error('secret upstream body'), { response: { status: 500 } }); };
        await assert.rejects(AI.generatePlainText([{ role: 'user', content: 'Question' }], selection), error => error.code === 'AI_UNAVAILABLE' && !error.message.includes('secret'));
        assert.strictEqual(calls.length, 1); assert.ok(calls[0].includes('gemini-3.7-flash'));
    }));

    it('cancels token acquisition and honors a bounded provider deadline before any generation request', () => fixture(async () => {
        let calls = 0; axios.post = async () => { calls++; throw new Error('must not send'); };
        GoogleAuth.prototype.getAccessToken = () => new Promise(() => {});
        const controller = new AbortController();
        const pending = AI.generatePlainText([{ role: 'user', content: 'Question' }], selection, { signal: controller.signal, timeout: 500 });
        controller.abort();
        await assert.rejects(pending, error => error.code === 'AI_CANCELED'); assert.strictEqual(calls, 0);
        const started = Date.now();
        await assert.rejects(AI.generatePlainText([{ role: 'user', content: 'Question' }], selection, { timeout: 20 }), error => error.code === 'AI_TIMEOUT');
        assert.ok(Date.now() - started < 400); assert.strictEqual(calls, 0);
    }));

    it('fails explicitly when service ADC is missing or personal refresh credentials are supplied', () => fixture(async ({ file }) => {
        assert.strictEqual(Gemini.configured(), true);
        fs.writeFileSync(file, JSON.stringify({ type: 'authorized_user', refresh_token: 'never-copy-owner-token' }));
        assert.strictEqual(Gemini.configured(), false);
        assert.throws(() => AI._resolveProviderConfig(selection), error => error.code === 'AI_PROVIDER_NOT_CONFIGURED');
        await assert.rejects(Gemini.accessToken(), error => error.code === 'AI_PROVIDER_NOT_CONFIGURED');
    }));

    it('keeps AITunnel and voice selections independent across switch, unrelated saves and durable readback', () => fixture(async () => customer('hotel_owner', async ({ business, request }) => {
        const before = await DB.getInstance(business.id);
        const first = await request(`/instances/${business.id}`, { aiProvider: 'gemini', geminiModel: 'gemini-3.7-flash' });
        assert.strictEqual(first.status, 200); const saved = (await first.json()).instance;
        assert.strictEqual(saved.aiProvider, 'gemini'); assert.strictEqual(saved.geminiModel, 'gemini-3.7-flash');
        assert.ok(!JSON.stringify(saved).includes('fixture-adc-token'));
        await request(`/instances/${business.id}`, { name: 'Updated name' });
        assert.strictEqual((await request(`/instances/${business.id}`, { aiProvider: 'aitunnel' })).status, 200);
        const restored = await DB.getInstance(business.id);
        assert.strictEqual(restored.yandexGptModelUri, 'old-aitunnel'); assert.strictEqual(restored.geminiModel, 'gemini-3.7-flash');
        for (const field of ['voiceAiProvider','voiceModel','voiceName','voiceSettings','systemPrompt','yandexGptKey']) assert.strictEqual(restored[field], before[field]);
        await request(`/instances/${business.id}`, { aiProvider: 'gemini' });
        assert.strictEqual((await DB.getInstance(business.id)).geminiModel, 'gemini-3.7-flash');
        const current = (await (await request('/instances')).json()).instances[0]; assert.strictEqual(current.aiProvider, 'gemini');
    })));

    it('closes new Gemini selection independently while existing Gemini businesses keep working and may change model', () => fixture(async () => customer('hotel_owner', async ({ business, request }) => {
        process.env.GEMINI_TEXT_ADMISSION_ENABLED = 'false';
        let providers = await (await request(`/ai/providers/${business.id}`)).json();
        assert.strictEqual(providers.providers.find(item => item.id === 'gemini').configured, false);
        assert.strictEqual((await request(`/instances/${business.id}`, { aiProvider: 'gemini', geminiModel: 'gemini-3.7-flash' })).status, 503);
        assert.strictEqual((await DB.getInstance(business.id)).aiProvider, 'aitunnel');
        // Already accepted selections must not be forced onto another provider during recovery.
        await DB.updateInstance(business.id, selection);
        providers = await (await request(`/ai/providers/${business.id}`)).json();
        assert.strictEqual(providers.providers.find(item => item.id === 'gemini').configured, true);
        axios.post = async url => { assert.ok(url.includes('gemini-3.7-flash')); return native('Existing Gemini still works'); };
        assert.strictEqual(await AI.generatePlainText([{ role: 'user', content: 'Question' }], await DB.getInstance(business.id)), 'Existing Gemini still works');
        assert.strictEqual((await request(`/instances/${business.id}`, { aiProvider: 'gemini', geminiModel: 'gemini-3.8-flash' })).status, 200);
        assert.strictEqual((await DB.getInstance(business.id)).geminiModel, 'gemini-3.8-flash');
    })));

    it('exposes scoped ready providers and Gemini models without calling AITunnel or exposing credentials', () => fixture(async () => customer('hotel_owner', async ({ business, foreign, request }) => {
        axios.get = async () => { throw new Error('AITunnel must not be needed'); };
        const providers = await (await request(`/ai/providers/${business.id}`)).json();
        assert.strictEqual(providers.provider, 'aitunnel'); assert.ok(providers.providers.find(item => item.id === 'gemini').configured);
        const models = await (await request(`/ai/models/${business.id}?provider=gemini`)).json();
        assert.strictEqual(models.provider, 'gemini'); assert.deepStrictEqual(models.models.map(item => item.id), Gemini.MODELS);
        assert.ok(!JSON.stringify([providers, models]).includes('fixture-adc-token'));
        assert.strictEqual((await request(`/ai/providers/${foreign.id}`)).status, 403);
        assert.strictEqual((await request(`/ai/models/${foreign.id}?provider=gemini`)).status, 403);
        assert.strictEqual((await request(`/instances/${foreign.id}`, { aiProvider: 'gemini' })).status, 403);
    })));

    it('rejects invalid model/provider, foreign origin and manager writes before changing settings', () => fixture(async () => {
        await customer('hotel_owner', async ({ business, request }) => {
            for (const patch of [{ aiProvider: 'forged' }, { aiProvider: 'gemini', geminiModel: 'foreign-model' }, { geminiModel: null }]) {
                assert.strictEqual((await request(`/instances/${business.id}`, patch)).status, 400);
                assert.strictEqual((await DB.getInstance(business.id)).aiProvider, 'aitunnel');
            }
            assert.strictEqual((await request(`/instances/${business.id}`, { aiProvider: 'gemini' }, { Origin: 'https://foreign.test' })).status, 403);
        });
        await customer('manager', async ({ business, request }) => {
            assert.strictEqual((await request(`/ai/providers/${business.id}`)).status, 200);
            assert.strictEqual((await request(`/instances/${business.id}`, { aiProvider: 'gemini' })).status, 403);
        });
    }));

    it('runs dashboard Ask and overnight summaries against Gemini with provider-separated cache and valid citations', () => fixture(async () => {
        createTestDB(); const business = await DB.createInstance({ name: 'Dashboard Gemini' });
        await DB.updateInstance(business.id, { ...selection });
        let calls = 0;
        const fact = { id: 'clients:1', summary: 'Клиент попросил уточнить условия.', source: { type: 'clients', id: '1' } };
        axios.post = async (url, body) => { calls++; assert.ok(url.includes('gemini-3.7-flash')); assert.ok(body.contents[0].parts[0].text.includes(fact.summary)); return native(JSON.stringify({ status: 'answered', answer: fact.summary, sourceIds: [fact.id] })); };
        const args = { businessId: business.id, question: 'Что произошло?', range: { from: '2026-10-13T00:00:00Z', to: '2026-10-14T00:00:00Z' }, rawFacts: [fact], revision: 'gemini-cache', windowKind: 'overnight' };
        const first = await Dashboard.generate(args); assert.strictEqual(first.provenance, 'gemini_crm'); assert.strictEqual(first.grounded, true);
        await Dashboard.generate(args); assert.strictEqual(calls, 1);
        await DB.updateInstance(business.id, { geminiModel: 'gemini-3.8-flash' });
        axios.post = async url => { calls++; assert.ok(url.includes('gemini-3.8-flash')); return native(JSON.stringify({ status: 'answered', answer: fact.summary, sourceIds: [fact.id] })); };
        await Dashboard.generate(args); assert.strictEqual(calls, 2);
        await Dashboard.generate({ ...args, windowKind: null }); assert.strictEqual(calls, 3);
    }));

    it('generates and persists an autoprompt through Gemini without AITunnel', () => fixture(async () => {
        createTestDB(); const business = await DB.createInstance({ name: 'Autoprompt Gemini' }); await DB.updateInstance(business.id, selection);
        const oldPages = Pages.extractPages; Pages.extractPages = async () => [];
        axios.post = async (url, body) => { assert.ok(url.includes('gemini-3.7-flash')); assert.strictEqual(body.generationConfig.responseMimeType, 'application/json');
            assert.strictEqual(body.generationConfig.maxOutputTokens, 4096);
            assert.deepStrictEqual(body.generationConfig.responseSchema.required, ['systemPrompt','suggestedSettings']);
            assert.deepStrictEqual(body.generationConfig.responseSchema.properties.suggestedSettings.properties.hotelWorkingHours.required, ['mon','tue','wed','thu','fri','sat','sun']);
            assert.ok(body.systemInstruction.parts[0].text.includes('1000–2500'));
            assert.ok(body.systemInstruction.parts[0].text.includes('НЕДОВЕРЕННЫМИ'));
            assert.strictEqual(body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
            return { data: Readable.from(['data: ' + JSON.stringify(nativeData(JSON.stringify({ systemPrompt: 'Отвечай по подтвержденным услугам нашего бизнеса и передавай сложные вопросы сотруднику.', suggestedSettings: {} }))) + '\n\n']) }; };
        try {
            const result = await Draft.generate(business.id, { links: [], supplement: 'Мы продаем кофе, работаем ежедневно и выдаем заказы с собой.' });
            assert.strictEqual(result.status, 'draft'); assert.ok(result.systemPrompt.includes('подтвержденным')); assert.strictEqual(Draft.get(business.id).id, result.id);
        } finally { Pages.extractPages = oldPages; }
    }));

    it('collects bounded native SSE with split UTF-8, suppresses thoughts and records the selected model', () => fixture(async () => {
        const frames = 'data: ' + JSON.stringify({ candidates: [{ index: 0, content: { parts: [{ text: 'private thought', thought: true }, { text: '{"systemPrompt":"Привет' }] } }] }) + '\n\n'
            + 'data: ' + JSON.stringify({ candidates: [{ index: 0, content: { parts: [{ text: ' мир"}' }] }, finishReason: 'STOP' }] }) + '\n\n'
            + 'data: ' + JSON.stringify({ usageMetadata: { candidatesTokenCount: 10 } }) + '\n\n';
        const bytes = Buffer.from(frames), offset = bytes.indexOf(Buffer.from('Привет')) + 1;
        let stream, receipt;
        axios.post = async (url, body, options) => {
            assert.ok(url.includes('/gemini-3.7-flash:streamGenerateContent?alt=sse'));
            assert.strictEqual(options.responseType, 'stream'); assert.strictEqual(options.proxy, false);
            assert.strictEqual(body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
            stream = Readable.from([bytes.subarray(0, offset), bytes.subarray(offset)]); return { data: stream };
        };
        const raw = await AI.generatePlainText([{ role: 'user', content: 'Draft' }], selection,
            { json: true, validate: value => JSON.parse(value), onReceipt: value => { receipt = value; } });
        assert.strictEqual(JSON.parse(raw).systemPrompt, 'Привет мир'); assert.ok(!raw.includes('private thought'));
        assert.strictEqual(receipt.transport, 'native_sse'); assert.strictEqual(receipt.actualModel, selection.geminiModel);
        assert.strictEqual(receipt.fallbackUsed, false); assert.strictEqual(stream.destroyed, true);
    }));

    it('rejects partial, truncated, oversized and canceled SSE without saving a successful receipt', () => fixture(async () => {
        for (const [data, code, limit] of [
            [{ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }, 'AI_INVALID_RESPONSE', 128 * 1024],
            [{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }] }, 'AI_TRUNCATED', 128 * 1024],
            [{ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'x'.repeat(200) }] } }] }, 'AI_RESPONSE_LIMIT', 80],
        ]) {
            let receipt = false, stream;
            axios.post = async () => ({ data: stream = Readable.from(['data: ' + JSON.stringify(data) + '\n\n']) });
            await assert.rejects(AI.generatePlainText([{ role: 'user', content: 'Draft' }], selection,
                { stream: true, json: true, maxContentLength: limit, onReceipt: () => { receipt = true; } }), error => error.code === code);
            assert.strictEqual(receipt, false); assert.strictEqual(stream.destroyed, true);
        }
        let stream;
        axios.post = async () => ({ data: stream = new Readable({ read() {} }) });
        await assert.rejects(AI.generatePlainText([{ role: 'user', content: 'Draft' }], selection, { stream: true, timeout: 20 }), error => error.code === 'AI_TIMEOUT');
        assert.strictEqual(stream.destroyed, true);
    }));

    it('closes an upstream error stream and keeps provider details out of the error', () => fixture(async () => {
        const stream = Readable.from(['private upstream error']);
        axios.post = async () => { throw Object.assign(new Error('private upstream error'), { response: { status: 503, data: stream } }); };
        await assert.rejects(AI.generatePlainText([{ role: 'user', content: 'Draft' }], selection, { stream: true }), error => error.code === 'AI_UNAVAILABLE' && !error.message.includes('private'));
        assert.strictEqual(stream.destroyed, true);
    }));

    it('keeps structured-output tuning opt-in and rejects incompatible or oversized native schemas', () => fixture(async () => {
        const messages = [{ role: 'user', content: 'Question' }];
        assert.strictEqual(Gemini.nativeBody(messages, { maxTokens: 4096, temperature: 0, json: true }).generationConfig.responseSchema, undefined);
        for (const [schema, json] of [[{}, false], [[], true], [{ type: 'OBJECT', description: 'x'.repeat(13000) }, true]]) {
            assert.throws(() => Gemini.nativeBody(messages, { maxTokens: 4096, temperature: 0, json, responseSchema: schema }), error => error.code === 'AI_INPUT_INVALID');
        }
    }));

    it('uses the real Onyx resolver for Gemini JSON/tools/SSE and keeps model aliases scoped', () => fixture(async () => {
        createTestDB(); const business = await DB.createInstance({ name: 'Onyx Gemini' }); await DB.updateInstance(business.id, selection);
        const calls = [];
        const signature = { google: { thought_signature: 'opaque-signature' } };
        const transport = { request: async request => { calls.push(request); return { data: Readable.from(['data: ' + JSON.stringify({
            candidates: [{ content: { parts: [{ functionCall: { id: 'call-1', name: 'lookup', args: {} }, thoughtSignature: signature.google.thought_signature }] }, finishReason: 'STOP' }]
        }) + '\n\n']) }; } };
        const gateway = new OnyxLlmGateway({ transport, previewFlashBusinessIds: 'all' }); const issued = gateway.issueToken(business.id);
        const body = { model: issued.model, messages: [{ role: 'user', content: 'Question' }], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }] };
        const result = await gateway.complete(`Bearer ${issued.token}`, body);
        assert.deepStrictEqual(result.result.choices[0].message.tool_calls[0].extra_content, signature);
        const frames = []; await gateway.complete(`Bearer ${issued.token}`, { ...body, stream: true }, { onChunk: chunk => frames.push(chunk) }); assert.strictEqual(frames.length, 2);
        await gateway.complete(`Bearer ${issued.token}`, { ...body, model: `${issued.model}-preview-flash` });
        for (const call of calls) {
            assert.ok(call.url.endsWith('/gemini-3.7-flash:streamGenerateContent?alt=sse')); assert.strictEqual(call.responseType, 'stream');
            assert.strictEqual(call.data.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
            assert.strictEqual(call.data.toolConfig.functionCallingConfig.mode, 'AUTO'); assert.strictEqual(call.headers.Authorization, 'Bearer fixture-adc-token'); assert.strictEqual(call.proxy, false);
        }
        assert.ok(DB.all('SELECT status FROM onyx_llm_requests').every(row => row.status === 'DONE'));
    }));

    it('propagates the selected Gemini model into SalesBrain, simulator follow-up rows and safe metadata', () => fixture(async () => {
        createTestDB(); const business = await DB.createInstance({ name: 'Sales Gemini' }); await DB.updateInstance(business.id, selection);
        await DB.getOrCreateClient(business.id, '79990000001@c.us', 'Client');
        await DB.updateInstance(business.id, { greenApiInstance: 'fixture', greenApiToken: 'fixture-key' });
        DB.run("UPDATE clients SET lastStatusChangeAt=datetime('now','-50 hours') WHERE instanceId=?", [business.id]);
        const stuck = await DB.getStuckLeads(24); assert.strictEqual(stuck[0].geminiModel, 'gemini-3.7-flash');
        axios.post = async url => { assert.ok(url.includes('gemini-3.7-flash')); return native('{"reply":"Ответ клиента","status":"qualified","action":"none"}'); };
        const result = await require('../src/services/sales-brain.service').reply({ instanceId: business.id, history: [{ role: 'user', content: 'Question' }] });
        assert.strictEqual(result.response.reply, 'Ответ клиента'); assert.strictEqual(DB.get('SELECT model FROM ml_decisions ORDER BY rowid DESC LIMIT 1').model, 'gemini-3.7-flash');
    }));
});
