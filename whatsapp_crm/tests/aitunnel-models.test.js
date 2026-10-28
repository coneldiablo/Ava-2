const { describe, it, assert, createTestDB } = require('./test-helper');
const axios = require('axios');
const AI = require('../src/services/ai.service');
const config = require('../src/config');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const { OnyxLlmGateway } = require('../src/services/onyx-llm-gateway.service');

async function withCatalog(handler, fn) {
    const oldGet = axios.get, oldKey = config.aiTunnel.apiKey;
    config.aiTunnel.apiKey = 'shared-fixture';
    axios.get = handler;
    try { await fn(); } finally { axios.get = oldGet; config.aiTunnel.apiKey = oldKey; }
}

const catalog = (url) => ({ data: url.endsWith('/models')
    ? { data: [{ id: 'provider/chat:v2' }, { id: 'embedding' }, { id: 'my-preset', owned_by: 'preset' },
        { id: 'provider/chat:v2' }, { id: 'unclassified' }] }
    : { 'provider/chat:v2': { modalities: { output: ['text'] } } } });

async function withCustomer(role, fn) {
    createTestDB(); Identity.ensureSchema();
    const business = await DB.createInstance({ name: 'Own model fixture' });
    await DB.updateInstance(business.id, { yandexGptKey: 'tenant-fixture',
        yandexGptModelUri: 'legacy-chat', systemPrompt: 'Keep prompt', aiProvider: 'aitunnel', aiTemperature: 0.4 });
    const foreign = await DB.createInstance({ name: 'Foreign model fixture' });
    await DB.updateInstance(foreign.id, { yandexGptKey: 'foreign-key' });
    const invitation = Identity.createInvitation({ platformRole: 'platform_admin' },
        { email: 'models@example.test', businessId: business.id, role: role === 'platform_admin' ? 'hotel_owner' : role });
    const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), 'model-test-subject');
    if (role === 'platform_admin') DB.run("UPDATE ava_users SET platformRole='platform_admin' WHERE id=?", [user.userId]);
    const token = Identity.createSession(user.subject, 'model-test-session');
    const previous = { enabled: Auth.config.enabled, customer: process.env.AVA_CUSTOMER_ACCESS_ENABLED,
        origin: process.env.WHATSAPP_CRM_PUBLIC_URL };
    Auth.config.enabled = true; process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
    const app = require('../src/app').app;
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
    const request = (route, body, extraHeaders = {}) => fetch(`${origin}/api${route}`, {
        method: body === undefined ? 'GET' : 'PUT', headers: { Cookie: `crm_session=ava2:${token}`,
            Origin: origin, 'Content-Type': 'application/json', ...extraHeaders },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try { await fn({ business, foreign, request, user, token }); } finally {
        Auth.config.enabled = previous.enabled;
        for (const [key, value] of [['AVA_CUSTOMER_ACCESS_ENABLED', previous.customer], ['WHATSAPP_CRM_PUBLIC_URL', previous.origin]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        await new Promise(resolve => server.close(resolve));
    }
}

describe('AITunnel real catalogue and scoped model settings', () => {
    it('intersects authenticated IDs with live chat metadata and preserves exact preset IDs without secrets', async () => {
        const calls = [];
        await withCatalog(async (url, options) => { calls.push({ url, options }); return catalog(url); }, async () => {
            assert.deepStrictEqual(await AI.getAvailableModels(' tenant-fixture '),
                [{ id: 'provider/chat:v2', name: 'provider/chat:v2' }, { id: 'my-preset', name: 'my-preset' }]);
            const auth = calls.find(call => call.url.endsWith('/models'));
            const publicRequest = calls.find(call => call.url.endsWith('/chat'));
            assert.strictEqual(auth.options.headers.Authorization, 'Bearer tenant-fixture');
            assert.strictEqual(publicRequest.options.headers.Authorization, undefined);
            for (const call of calls) {
                assert.strictEqual(call.options.timeout, 8000); assert.strictEqual(call.options.maxRedirects, 0);
                assert.strictEqual(call.options.maxContentLength, 2 * 1024 * 1024);
                assert.strictEqual(call.options.responseType, 'json'); assert.ok(call.options.signal);
            }
            calls.length = 0;
            await AI.getAvailableModels('   ');
            assert.strictEqual(calls.find(call => call.url.endsWith('/models')).options.headers.Authorization, 'Bearer shared-fixture');
        });
    });

    it('fails safely on missing credentials, malformed responses, timeout and rejected provider authentication', async () => {
        await withCatalog(async () => { throw new Error('Unexpected request'); }, async () => {
            config.aiTunnel.apiKey = '';
            await assert.rejects(AI.getAvailableModels(), error => error.code === 'AI_PROVIDER_NOT_CONFIGURED');
        });
        for (const malformed of [null, {}, { data: 'wrong' }, { data: [{ id: '' }] }, { data: [{ id: 'with space' }] },
            { data: [{ id: 42 }] }, { data: [{ id: 'a'.repeat(257) }] }]) {
            await withCatalog(async url => ({ data: url.endsWith('/models') ? malformed : { chat: {} } }), async () => {
                await assert.rejects(AI.getAvailableModels(), error => error.code === 'AI_MODELS_INVALID_RESPONSE');
            });
        }
        for (const malformed of [null, [], {}, { chat: null }, { chat: [] }]) {
            await withCatalog(async url => ({ data: url.endsWith('/models') ? { data: [{ id: 'chat' }] } : malformed }), async () => {
                await assert.rejects(AI.getAvailableModels(), error => error.code === 'AI_MODELS_INVALID_RESPONSE');
            });
        }
        for (const [failure, code] of [[{ code: 'ECONNABORTED' }, 'AI_MODELS_TIMEOUT'],
            [{ response: { status: 401, data: 'Bearer tenant-fixture' } }, 'AI_MODELS_UNAUTHORIZED'],
            [{ response: { status: 403 } }, 'AI_MODELS_UNAUTHORIZED'], [{}, 'AI_MODELS_UNAVAILABLE']]) {
            await withCatalog(async () => { throw Object.assign(new Error('Bearer tenant-fixture'), failure); }, async () => {
                await assert.rejects(AI.getAvailableModels(), error => error.code === code
                    && !JSON.stringify(error).includes('tenant-fixture') && !error.message.includes('tenant-fixture'));
            });
        }
    });

    it('saves and reads back the exact owner model ID, strips credential overrides and preserves other settings', async () => {
        await withCatalog(async url => catalog(url), () => withCustomer('hotel_owner', async ({ business, foreign, request }) => {
            const before = await DB.getInstance(business.id);
            const result = await request(`/ai/models/${business.id}`);
            assert.strictEqual(result.status, 200);
            assert.deepStrictEqual((await result.json()).models.map(model => model.id), ['provider/chat:v2', 'my-preset']);
            assert.strictEqual((await request(`/ai/models/${foreign.id}`)).status, 403);
            const saved = await request(`/instances/${business.id}`, { yandexGptModelUri: 'provider/chat:v2',
                yandexGptKey: 'forged', aiTemperature: 9, knowledgeBaseInstanceId: foreign.id });
            assert.strictEqual(saved.status, 200);
            const ack = await saved.json();
            assert.strictEqual(ack.success, true); assert.strictEqual(ack.instance.id, business.id);
            assert.strictEqual(ack.instance.yandexGptModelUri, 'provider/chat:v2');
            assert.ok(!Object.hasOwn(ack.instance, 'yandexGptKey'));
            const after = await DB.getInstance(business.id);
            for (const field of ['yandexGptKey', 'aiProvider', 'aiTemperature', 'systemPrompt', 'knowledgeBaseInstanceId']) {
                assert.strictEqual(after[field], before[field]);
            }
            const list = await (await request('/instances')).json();
            assert.strictEqual(list.instances.length, 1);
            assert.strictEqual(list.instances[0].yandexGptModelUri, 'provider/chat:v2');
            assert.ok(!JSON.stringify(list).includes('tenant-fixture'));
            assert.strictEqual((await request(`/instances/${foreign.id}`, { yandexGptModelUri: 'my-preset' })).status, 403);
            assert.strictEqual((await request(`/instances/${business.id}`, { yandexGptModelUri: 'my-preset' },
                { Origin: 'https://foreign.test' })).status, 403);
        }));
    });

    it('lets managers read their catalogue but denies their model changes', async () => {
        await withCatalog(async url => catalog(url), () => withCustomer('manager', async ({ business, request }) => {
            assert.strictEqual((await request(`/ai/models/${business.id}`)).status, 200);
            assert.strictEqual((await request(`/instances/${business.id}`, { yandexGptModelUri: 'my-preset' })).status, 403);
            assert.strictEqual((await DB.getInstance(business.id)).yandexGptModelUri, 'legacy-chat');
        }));
    });

    it('rejects unknown or malformed choices before any write and reports provider failure without false success', async () => {
        await withCatalog(async url => catalog(url), () => withCustomer('hotel_owner', async ({ business, request }) => {
            for (const selected of ['unknown-model', ' model ', null, 42]) {
                const rejected = await request(`/instances/${business.id}`, { yandexGptModelUri: selected, systemPrompt: 'Do not save' });
                assert.strictEqual(rejected.status, 400); assert.strictEqual((await rejected.json()).success, false);
                assert.strictEqual((await DB.getInstance(business.id)).systemPrompt, 'Keep prompt');
            }
            axios.get = async () => { throw Object.assign(new Error('Bearer tenant-fixture'), { code: 'ECONNABORTED' }); };
            assert.strictEqual((await request(`/ai/models/${business.id}`)).status, 504);
            axios.get = async () => { throw new Error('Bearer tenant-fixture secret upstream body'); };
            const unavailable = await request(`/ai/models/${business.id}`);
            assert.strictEqual(unavailable.status, 502);
            assert.deepStrictEqual(await unavailable.json(), { success: false, code: 'AI_MODELS_UNAVAILABLE', error: 'AI_MODELS_UNAVAILABLE' });
            assert.strictEqual((await request(`/instances/${business.id}`, { yandexGptModelUri: 'my-preset' })).status, 502);
            assert.strictEqual((await DB.getInstance(business.id)).yandexGptModelUri, 'legacy-chat');
            // Existing stale choice remains saveable; clearing inherits the server default.
            assert.strictEqual((await request(`/instances/${business.id}`, { yandexGptModelUri: 'legacy-chat' })).status, 200);
            assert.strictEqual((await request(`/instances/${business.id}`, { yandexGptModelUri: '' })).status, 200);
            assert.strictEqual((await DB.getInstance(business.id)).yandexGptModelUri, '');
        }));
    });

    it('does not acknowledge a failed durable model save', async () => {
        await withCatalog(async url => catalog(url), () => withCustomer('hotel_owner', async ({ business, request }) => {
            const original = DB.updateInstance;
            try {
                DB.updateInstance = async () => DB.getInstance(business.id);
                const mismatch = await request(`/instances/${business.id}`, { yandexGptModelUri: 'my-preset' });
                assert.strictEqual(mismatch.status, 500);
                assert.strictEqual((await mismatch.json()).code, 'AI_MODEL_SAVE_FAILED');
                DB.updateInstance = async () => { throw new Error('private SQL/key failure'); };
                const failed = await request(`/instances/${business.id}`, { yandexGptModelUri: 'my-preset' });
                assert.strictEqual(failed.status, 500);
                assert.deepStrictEqual(await failed.json(), { success: false, code: 'AI_MODEL_SAVE_FAILED', error: 'AI_MODEL_SAVE_FAILED' });
                assert.strictEqual((await DB.getInstance(business.id)).yandexGptModelUri, 'legacy-chat');
            } finally { DB.updateInstance = original; }
        }));
    });

    it('validates an administrator key and preset change against the effective new key and preserves masked placeholders', async () => {
        const keys = [];
        await withCatalog(async (url, options) => {
            if (!url.endsWith('/models')) return { data: { chat: {} } };
            keys.push(options.headers.Authorization);
            return { data: { data: [{ id: options.headers.Authorization === 'Bearer new-fixture'
                ? 'new-preset' : 'old-preset', owned_by: 'preset' }] } };
        }, () => withCustomer('platform_admin', async ({ business, request }) => {
            const changed = await request(`/instances/${business.id}`, { yandexGptModelUri: 'new-preset', yandexGptKey: 'new-fixture' });
            assert.strictEqual(changed.status, 200);
            assert.strictEqual((await changed.json()).instance.yandexGptModelUri, 'new-preset');
            assert.deepStrictEqual(keys, ['Bearer new-fixture']);
            assert.strictEqual((await DB.getInstance(business.id)).yandexGptKey, 'new-fixture');
            const unchangedModel = await request(`/instances/${business.id}`, { yandexGptModelUri: 'new-preset', yandexGptKey: 'next-fixture' });
            assert.strictEqual(unchangedModel.status, 400); // Same ID must be revalidated when its key changes.
            assert.strictEqual(keys[1], 'Bearer next-fixture');
            assert.strictEqual((await DB.getInstance(business.id)).yandexGptKey, 'new-fixture');
            await DB.updateInstance(business.id, { yandexGptModelUri: 'legacy-chat' });
            const masked = await request(`/instances/${business.id}`, { yandexGptModelUri: 'new-preset', yandexGptKey: 'ne***re' });
            assert.strictEqual(masked.status, 200);
            assert.strictEqual(keys[2], 'Bearer new-fixture');
            assert.strictEqual((await DB.getInstance(business.id)).yandexGptKey, 'new-fixture');
        }));
    });

    it('rechecks session, enabled actor and owner membership after awaited catalogue before saving or revealing it', async () => {
        for (const mutation of ['session', 'actor', 'membership', 'get', 'platform-role']) {
            let release, started;
            const gate = new Promise(resolve => { release = resolve; });
            const entered = new Promise(resolve => { started = resolve; });
            await withCatalog(async url => {
                if (url.endsWith('/models')) { started(); await gate; }
                return catalog(url);
            }, () => withCustomer(mutation === 'platform-role' ? 'platform_admin' : 'hotel_owner', async ({ business, request, user, token }) => {
                const pending = mutation === 'get' ? request(`/ai/models/${business.id}`)
                    : request(`/instances/${business.id}`, { yandexGptModelUri: 'my-preset', yandexGptKey: 'new-fixture' });
                await entered;
                if (mutation === 'session') Identity.revokeSession(token);
                else if (mutation === 'actor' || mutation === 'get') Identity.revokeUser({ platformRole: 'platform_admin' }, user.userId);
                else if (mutation === 'platform-role') DB.run("UPDATE ava_users SET platformRole='customer' WHERE id=?", [user.userId]);
                else DB.run('UPDATE ava_business_memberships SET enabled=0 WHERE userId=?', [user.userId]);
                release();
                const rejected = await pending;
                assert.strictEqual(rejected.status, 403);
                assert.strictEqual((await rejected.json()).code, 'AI_MODEL_ACCESS_REVOKED');
                assert.strictEqual((await DB.getInstance(business.id)).yandexGptModelUri, 'legacy-chat');
                assert.strictEqual((await DB.getInstance(business.id)).yandexGptKey, 'tenant-fixture');
            }));
        }
    });

    it('rejects credential rotation while a catalogue request is in flight before saving or revealing stale IDs', async () => {
        for (const mode of ['tenant', 'shared']) for (const read of [false, true]) {
            let release, started;
            const gate = new Promise(resolve => { release = resolve; });
            const entered = new Promise(resolve => { started = resolve; });
            await withCatalog(async url => {
                if (url.endsWith('/models')) { started(); await gate; }
                return catalog(url);
            }, () => withCustomer('hotel_owner', async ({ business, request }) => {
                if (mode === 'shared') await DB.updateInstance(business.id, { yandexGptKey: '' });
                const pending = read ? request(`/ai/models/${business.id}`)
                    : request(`/instances/${business.id}`, { yandexGptModelUri: 'my-preset' });
                await entered;
                if (mode === 'shared') config.aiTunnel.apiKey = 'rotated-shared-fixture';
                else await DB.updateInstance(business.id, { yandexGptKey: 'rotated-fixture' });
                release();
                const rejected = await pending;
                assert.strictEqual(rejected.status, 409);
                assert.strictEqual((await rejected.json()).code, 'AI_MODEL_SETTINGS_CHANGED');
                assert.strictEqual((await DB.getInstance(business.id)).yandexGptModelUri, 'legacy-chat');
                assert.strictEqual((await DB.getInstance(business.id)).yandexGptKey, mode === 'shared' ? '' : 'rotated-fixture');
            }));
        }
    });

    it('uses the persisted model with the actual Onyx resolver and inherits server defaults without changing gateway budgets', async () => {
        createTestDB();
        const business = await DB.createInstance({ name: 'Onyx model fixture' });
        await DB.updateInstance(business.id, { yandexGptModelUri: 'provider/chat:v2' });
        const oldKey = config.aiTunnel.apiKey, oldModel = config.aiTunnel.model;
        const oldEnabled = process.env.ONYX_LLM_PROXY_ENABLED;
        config.aiTunnel.apiKey = 'shared-fixture'; config.aiTunnel.model = 'server-default-fixture';
        process.env.ONYX_LLM_PROXY_ENABLED = 'true';
        const calls = [];
        const gateway = new OnyxLlmGateway({ transport: { request: async request => {
            calls.push(request); return { data: { choices: [{ message: { role: 'assistant', content: 'Fixture' } }] } };
        } } });
        const issued = gateway.issueToken(business.id);
        const body = { model: issued.model, messages: [{ role: 'user', content: 'Fixture' }] };
        try {
            await gateway.complete(`Bearer ${issued.token}`, body);
            assert.strictEqual(calls[0].data.model, 'provider/chat:v2');
            assert.strictEqual(calls[0].headers.Authorization, 'Bearer shared-fixture');
            await DB.updateInstance(business.id, { yandexGptModelUri: '', yandexGptKey: 'tenant-fixture' });
            await gateway.complete(`Bearer ${issued.token}`, body);
            assert.strictEqual(calls[1].data.model, 'server-default-fixture');
            assert.strictEqual(calls[1].headers.Authorization, 'Bearer tenant-fixture');
            assert.strictEqual(config.aiTunnel.model, 'server-default-fixture');
            assert.strictEqual(gateway.admissionWaitMs, 5000);
            assert.strictEqual(DB.get("SELECT COUNT(*) count FROM onyx_llm_requests WHERE status='DONE'").count, 2);
        } finally {
            config.aiTunnel.apiKey = oldKey; config.aiTunnel.model = oldModel;
            if (oldEnabled === undefined) delete process.env.ONYX_LLM_PROXY_ENABLED; else process.env.ONYX_LLM_PROXY_ENABLED = oldEnabled;
        }
    });
});
