'use strict';
// Independent acceptance: run real business services and HTTP routes, replacing
// only external OAuth/HTTP. No private key, provider call, or production write.
const { describe, it, assert, createTestDB } = require('./test-helper');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
const AI = require('../src/services/ai.service');
const DB = require('../src/services/database.service');
const config = require('../src/config');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');

const completion = (text, stream = false) => stream ? { data: Readable.from([`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] })}\n\n`]) } : ({ data: { id: 'acceptance-completion', choices: [{
    message: { role: 'assistant', content: text }, finish_reason: 'stop',
}], candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } } });

async function vertexFixture(run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-gemini-acceptance-'));
    const file = path.join(dir, 'adc.json');
    fs.writeFileSync(file, JSON.stringify({ type: 'service_account',
        client_email: 'fixture@fixture-project.iam.gserviceaccount.com', private_key: 'SYNTHETIC-NOT-A-KEY' }), { mode: 0o600 });
    const env = { GEMINI_PROJECT_ID: 'fixture-project', GOOGLE_APPLICATION_CREDENTIALS: file,
        GEMINI_LOCATION: 'global', GEMINI_TEXT_ENABLED: 'true', GEMINI_TEXT_ADMISSION_ENABLED: 'true', ONYX_LLM_PROXY_ENABLED: 'true' };
    const oldEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    const previous = { auth: GoogleAuth.prototype.getAccessToken, post: axios.post, get: axios.get,
        request: axios.request, key: config.aiTunnel.apiKey };
    Object.assign(process.env, env);
    config.aiTunnel.apiKey = ''; // Gemini must work with AITunnel unavailable.
    GoogleAuth.prototype.getAccessToken = async () => 'synthetic-vertex-access-token';
    const calls = [];
    axios.get = async () => { throw new Error('Unexpected external catalogue request'); };
    axios.post = async (url, body, options) => {
        calls.push({ url, body, options });
        return completion('{"reply":"Подтверждённый ответ клиента","summary":"Клиент уточнил услугу. Бюджет не указан. Ожидает ответ.","action":"Уточните удобное время."}', options.responseType === 'stream');
    };
    try { return await run(calls); }
    finally {
        GoogleAuth.prototype.getAccessToken = previous.auth; axios.post = previous.post;
        axios.get = previous.get; axios.request = previous.request; config.aiTunnel.apiKey = previous.key;
        for (const [key, value] of Object.entries(oldEnv)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function assertVertex(call, model = 'gemini-3.7-flash') {
    assert.strictEqual(new URL(call.url).hostname, 'aiplatform.googleapis.com');
    assert.ok(call.url.includes('/projects/fixture-project/locations/global/'));
    if (call.body.contents) {
        const url = new URL(call.url);
        assert.ok(url.pathname.endsWith(`/publishers/google/models/${model}:generateContent`)
            || (url.pathname.endsWith(`/publishers/google/models/${model}:streamGenerateContent`) && url.searchParams.get('alt') === 'sse'));
        assert.strictEqual(call.body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
    } else assert.strictEqual(call.body.model, `google/${model}`);
    assert.strictEqual(call.options.headers.Authorization, 'Bearer synthetic-vertex-access-token');
    assert.strictEqual(call.options.proxy, false);
    assert.strictEqual(call.options.maxRedirects, 0);
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 65000);
    assert.ok(call.options.maxContentLength <= 2 * 1024 * 1024);
    assert.ok(!JSON.stringify(call.body).includes('synthetic-vertex-access-token'));
}

async function customer(role, fn) {
    createTestDB(); Identity.ensureSchema();
    const business = await DB.createInstance({ name: 'Gemini acceptance own business' });
    const foreign = await DB.createInstance({ name: 'Gemini acceptance foreign business' });
    await DB.updateInstance(business.id, { aiProvider: 'aitunnel', yandexGptKey: 'fixture-tenant-key',
        yandexGptModelUri: 'legacy-model', geminiModel: 'gemini-3.7-flash', systemPrompt: 'Preserved business prompt' });
    // Existing saved voice settings remain usable even if that provider is
    // temporarily unavailable; configuring a new voice is outside this fixture.
    DB.run("UPDATE instances SET voiceAiProvider='neuro_gemini',voiceModel='gemini-3.8-flash',voiceName='edsel' WHERE id=?", [business.id]);
    const invitation = Identity.createInvitation({ platformRole: 'platform_admin' },
        { email: 'gemini-acceptance@example.test', businessId: business.id, role });
    const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), 'gemini-acceptance-subject');
    const token = Identity.createSession(user.subject, 'gemini-acceptance-session');
    const previous = { enabled: Auth.config.enabled, customer: process.env.AVA_CUSTOMER_ACCESS_ENABLED,
        origin: process.env.WHATSAPP_CRM_PUBLIC_URL };
    Auth.config.enabled = true; process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
    const app = require('../src/app').app;
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
    const request = (route, body) => fetch(`${origin}/api${route}`, {
        method: body === undefined ? 'GET' : 'PUT', headers: { Cookie: `crm_session=ava2:${token}`,
            Origin: origin, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try { await fn({ business, foreign, request, user, token }); }
    finally {
        Auth.config.enabled = previous.enabled;
        for (const [key, value] of [['AVA_CUSTOMER_ACCESS_ENABLED', previous.customer], ['WHATSAPP_CRM_PUBLIC_URL', previous.origin]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        await new Promise(resolve => server.close(resolve));
    }
}

describe('Independent Gemini text integration acceptance', () => {
    it('routes customer replies, plain generation, summaries and next steps through the selected Gemini with no AITunnel key', async () => vertexFixture(async calls => {
        const instance = { aiProvider: 'gemini', geminiModel: 'gemini-3.7-flash', yandexGptModelUri: 'must-not-use-old-model', aiTemperature: 0.2 };
        const history = [{ role: 'user', content: 'Расскажите про услугу' }];
        assert.ok((await AI.generatePlainText(history, instance)).includes('reply'));
        assert.ok((await AI.getResponse(history, { instanceConfig: instance, systemPrompt: 'Business facts' })).reply.includes('ответ'));
        assert.ok((await AI.getSummary(history, instance)).includes('Клиент'));
        assert.ok((await AI.getNextStep(history, 'new', instance)).includes('Уточните'));
        assert.strictEqual(calls.length, 4);
        calls.forEach(call => assertVertex(call));
    }));

    it('fails safely on ADC failure without sending a generation request or silently falling back to AITunnel', async () => vertexFixture(async calls => {
        config.aiTunnel.apiKey = 'available-but-forbidden-fallback';
        GoogleAuth.prototype.getAccessToken = async () => { throw new Error('private credential fixture must not escape'); };
        await assert.rejects(AI.generatePlainText([{ role: 'user', content: 'Hello' }], { aiProvider: 'gemini' }),
            error => error.code === 'AI_AUTH_UNAVAILABLE' && !error.message.includes('private credential'));
        assert.strictEqual(calls.length, 0);
    }));

    it('cancels a pending ADC refresh within the request deadline and does not launch late generation', async () => vertexFixture(async calls => {
        let release;
        GoogleAuth.prototype.getAccessToken = () => new Promise(resolve => { release = resolve; });
        const controller = new AbortController();
        const pending = AI.generatePlainText([{ role: 'user', content: 'Hello' }], { aiProvider: 'gemini' }, { signal: controller.signal, timeout: 1000 });
        await new Promise(resolve => setImmediate(resolve)); controller.abort();
        await assert.rejects(pending, error => error.code === 'AI_CANCELED');
        release('synthetic-vertex-access-token'); await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(calls.length, 0);
    }));

    it('generates and approves an auto-prompt using the business Gemini selection while preserving voice and legacy model', async () => vertexFixture(async calls => {
        createTestDB(); const business = await DB.createInstance({ name: 'Test services' });
        await DB.updateInstance(business.id, { aiProvider: 'gemini', geminiModel: 'gemini-3.7-flash', yandexGptModelUri: 'legacy-model' });
        DB.run("UPDATE instances SET voiceAiProvider='neuro_gemini',voiceModel='gemini-3.8-flash',voiceName='edsel' WHERE id=?", [business.id]);
        const before = await DB.getInstance(business.id);
        const Pages = require('../src/services/assistant-public-pages.service');
        const Draft = require('../src/services/assistant-draft.service');
        const extract = Pages.extractPages;
        Pages.extractPages = async () => [];
        axios.post = async (url, body, options) => {
            calls.push({ url, body, options });
            const content = '{"systemPrompt":"Вы помощник бизнеса Test services. Отвечайте по подтвержденным сведениям, неизвестное уточняйте у сотрудника.","suggestedSettings":{}}';
            return options.responseType === 'stream' ? { data: Readable.from([`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }] })}\n\n`]) } : completion(content);
        };
        try {
            const draft = await Draft.generate(business.id, { links: [], supplement: 'Компания оказывает консультационные услуги по предварительной записи.' });
            assert.strictEqual(draft.status, 'draft'); assert.strictEqual(calls.length, 1); assertVertex(calls[0]);
            const approved = Draft.approve(business.id, { draftId: draft.id, systemPrompt: draft.systemPrompt });
            assert.strictEqual(approved.draft.status, 'approved');
            const after = await DB.getInstance(business.id);
            assert.strictEqual(after.systemPrompt, draft.systemPrompt);
            for (const field of ['aiProvider', 'geminiModel', 'yandexGptModelUri', 'voiceAiProvider', 'voiceModel', 'voiceName']) assert.strictEqual(after[field], before[field]);
        } finally { Pages.extractPages = extract; }
    }));

    it('invalidates overnight cached answers when the provider or selected Gemini model changes', async () => vertexFixture(async calls => {
        createTestDB(); const business = await DB.createInstance({ name: 'Dashboard Gemini' });
        await DB.updateInstance(business.id, { aiProvider: 'gemini', geminiModel: 'gemini-3.7-flash' });
        const Model = require('../src/services/dashboard/ai.model');
        axios.post = async (url, body, options) => {
            calls.push({ url, body, options });
            return completion('{"status":"answered","answer":"Создана запись клиента.","sourceIds":["client:acceptance"]}', options.responseType === 'stream');
        };
        const args = { businessId: business.id, question: 'Что произошло за ночь?',
            range: { from: '2026-10-13T20:00:00.000Z', to: '2026-10-14T09:00:00.000Z' },
            rawFacts: [{ id: 'client:acceptance', summary: 'Создана запись клиента.',
                source: { type: 'clients', id: 'acceptance', createdAt: '2026-10-14T01:00:00.000Z' } }],
            revision: 'independent-gemini-cache-fixture', windowKind: 'overnight' };
        const first = await Model.generate(args); assert.strictEqual(first.grounded, true);
        await Model.generate(args); assert.strictEqual(calls.length, 1);
        await DB.updateInstance(business.id, { geminiModel: 'gemini-3.8-flash' });
        await Model.generate(args); assert.strictEqual(calls.length, 2);
        assertVertex(calls[0]); assertVertex(calls[1], 'gemini-3.8-flash');
        // Preserve the same business/data/model string to isolate provider in the cache key.
        config.aiTunnel.apiKey = 'synthetic-aitunnel-key';
        DB.run("UPDATE instances SET aiProvider='aitunnel',yandexGptModelUri='gemini-3.8-flash' WHERE id=?", [business.id]);
        await Model.generate(args); assert.strictEqual(calls.length, 3);
        assert.ok(calls[2].url.includes('aitunnel')); assert.strictEqual(calls[2].body.model, 'gemini-3.8-flash');
    }));

    it('routes Onyx alias requests and streams to the current business Gemini without exposing ADC or using the preview fallback model', async () => vertexFixture(async calls => {
        createTestDB(); const business = await DB.createInstance({ name: 'Onyx Gemini' });
        await DB.updateInstance(business.id, { aiProvider: 'gemini', geminiModel: 'gemini-3.7-flash' });
        const { OnyxLlmGateway } = require('../src/services/onyx-llm-gateway.service');
        const transport = { request: async request => {
            calls.push({ url: request.url, body: request.data, options: request });
            return { data: Readable.from([Buffer.from('data: '+JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Ответ по знаниям бизнеса.' }] }, finishReason: 'STOP' }] })+'\n\n')]) };
        } };
        const gateway = new OnyxLlmGateway({ transport, previewFlashBusinessIds: 'all' });
        const { token, model } = gateway.issueToken(business.id);
        const body = { model, messages: [{ role: 'user', content: 'Когда можно приехать?' }] };
        const result = await gateway.complete(`Bearer ${token}`, body);
        assert.strictEqual(result.result.model, model); assert.ok(result.result.choices[0].message.content.includes('знаниям'));
        const chunks = [];
        await gateway.complete(`Bearer ${token}`, { ...body, model: `${model}-preview-flash`, stream: true }, { onChunk: value => chunks.push(value) });
        assert.ok(chunks.length > 0); assert.strictEqual(calls.length, 2); calls.forEach(call => assertVertex(call));
        assert.ok(!JSON.stringify(result).includes('synthetic-vertex-access-token'));
        assert.ok(!JSON.stringify(DB.all('SELECT * FROM onyx_llm_requests')).includes('Когда можно'));
        await DB.updateInstance(business.id, { geminiModel: 'gemini-3.8-flash' });
        await gateway.complete(`Bearer ${token}`, body); assertVertex(calls[2], 'gemini-3.8-flash');
    }));

    it('persists an owner provider switch and exact model through canonical reads, permits switchback and isolates another business and voice settings', async () => vertexFixture(() => customer('hotel_owner', async ({ business, foreign, request }) => {
        const before = await DB.getInstance(business.id);
        const providers = await request(`/ai/providers/${business.id}`); assert.strictEqual(providers.status, 200);
        const catalogue = await providers.json(); assert.ok(catalogue.providers.some(p => p.id === 'gemini' && p.configured));
        assert.strictEqual((await request(`/ai/providers/${foreign.id}`)).status, 403);
        assert.strictEqual((await request(`/ai/models/${foreign.id}?provider=gemini`)).status, 403);
        const saved = await request(`/instances/${business.id}`, { aiProvider: 'gemini', geminiModel: 'gemini-3.7-flash' });
        assert.strictEqual(saved.status, 200); const ack = await saved.json();
        assert.strictEqual(ack.instance.aiProvider, 'gemini'); assert.strictEqual(ack.instance.geminiModel, 'gemini-3.7-flash');
        const read = await (await request('/instances')).json();
        assert.strictEqual(read.instances[0].aiProvider, 'gemini'); assert.strictEqual(read.instances[0].geminiModel, 'gemini-3.7-flash');
        assert.ok(!JSON.stringify(read).includes('fixture-tenant-key'));
        const after = await DB.getInstance(business.id);
        for (const field of ['voiceAiProvider', 'voiceModel', 'voiceName', 'systemPrompt', 'yandexGptModelUri']) assert.strictEqual(after[field], before[field]);
        assert.strictEqual((await request(`/instances/${foreign.id}`, { aiProvider: 'gemini' })).status, 403);
        for (const patch of [{ geminiModel: 'unavailable-model' }, { aiProvider: 'unknown-provider' }, { geminiModel: null }]) {
            assert.strictEqual((await request(`/instances/${business.id}`, patch)).status, 400);
            assert.strictEqual((await DB.getInstance(business.id)).geminiModel, 'gemini-3.7-flash');
        }
        assert.strictEqual((await request(`/instances/${business.id}`, { aiProvider: 'aitunnel' })).status, 200);
        assert.strictEqual((await DB.getInstance(business.id)).yandexGptModelUri, 'legacy-model');
        assert.strictEqual((await DB.getInstance(business.id)).geminiModel, 'gemini-3.7-flash');
    })));

    it('allows a manager to inspect text AI but rejects all provider/model changes', async () => vertexFixture(() => customer('manager', async ({ business, request }) => {
        assert.strictEqual((await request(`/ai/providers/${business.id}`)).status, 200);
        assert.strictEqual((await request(`/ai/models/${business.id}?provider=gemini`)).status, 200);
        assert.strictEqual((await request(`/instances/${business.id}`, { aiProvider: 'gemini', geminiModel: 'gemini-3.8-flash' })).status, 403);
        assert.strictEqual((await DB.getInstance(business.id)).aiProvider, 'aitunnel');
    })));

    it('does not acknowledge a Gemini save that failed to persist provider or model', async () => vertexFixture(() => customer('hotel_owner', async ({ business, request }) => {
        const update = DB.updateInstance;
        DB.updateInstance = async () => DB.getInstance(business.id);
        try {
            const failed = await request(`/instances/${business.id}`, { aiProvider: 'gemini', geminiModel: 'gemini-3.8-flash' });
            assert.strictEqual(failed.status, 500);
            assert.strictEqual((await failed.json()).code, 'AI_MODEL_SAVE_FAILED');
            assert.strictEqual((await DB.getInstance(business.id)).aiProvider, 'aitunnel');
        } finally { DB.updateInstance = update; }
    })));

    it('closes new Gemini selection admission without interrupting an existing selected business runtime', async () => vertexFixture(calls => customer('hotel_owner', async ({ business, request }) => {
        process.env.GEMINI_TEXT_ADMISSION_ENABLED = 'false';
        const closed = await (await request(`/ai/providers/${business.id}`)).json();
        assert.strictEqual(closed.providers.find(provider => provider.id === 'gemini').configured, false);
        const rejected = await request(`/instances/${business.id}`, { aiProvider: 'gemini', geminiModel: 'gemini-3.8-flash' });
        assert.strictEqual(rejected.status, 503); assert.strictEqual((await DB.getInstance(business.id)).aiProvider, 'aitunnel');
        DB.run("UPDATE instances SET aiProvider='gemini' WHERE id=?", [business.id]);
        const instance = await DB.getInstance(business.id);
        assert.ok((await AI.generatePlainText([{ role: 'user', content: 'Existing business question' }], instance)).includes('reply'));
        assert.strictEqual(calls.length, 1); assertVertex(calls[0]);
        const retained = await (await request(`/ai/providers/${business.id}`)).json();
        assert.strictEqual(retained.providers.find(provider => provider.id === 'gemini').configured, true);
    })));
});
