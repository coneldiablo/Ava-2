'use strict';
// Independent acceptance: actual production HTTP middleware/router + real SQLite.
// Only the provider catalog transport boundary is synthetic in this file.
const { describe, it, assert, createTestDB } = require('./test-helper');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');

const selected = profile => ({ provider: profile.voiceAiProvider, model: profile.voiceModel, voice: profile.voiceName });
const A = { voiceAiProvider: 'neuro_gemini', voiceModel: 'gemini-3.8-flash', voiceName: 'edsel' };
const B = { voiceAiProvider: 'neuro_gemini', voiceModel: 'gemini-3.7-flash', voiceName: 'acceptance-voice-b' };
const triple = patch => ({ provider: patch.voiceAiProvider, model: patch.voiceModel, voice: patch.voiceName });
const clone = value => JSON.parse(JSON.stringify(value));

function actor(businessId, role = 'hotel_owner') {
    const invitation = Identity.createInvitation({ platformRole: 'platform_admin' }, {
        email: `${role}-${businessId}@acceptance.example.test`, businessId, role,
    });
    const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), `${role}-${businessId}`);
    return { ...user, cookie: `crm_session=ava2:${Identity.createSession(user.subject)}` };
}

async function fixture(run) {
    createTestDB(); Identity.ensureSchema();
    const a = await DB.createInstance({ name: 'Acceptance A', businessType: 'hotel' });
    const b = await DB.createInstance({ name: 'Acceptance B', businessType: 'hotel' });
    const ownerA = actor(a.id), ownerB = actor(b.id), manager = actor(a.id, 'manager');
    const Auth = require('../src/services/auth.service');
    const Options = require('../src/services/voice-options.service');
    const previous = { enabled: Auth.config.enabled, options: Options.getOptions };
    const keys = ['AVA_CUSTOMER_ACCESS_ENABLED', 'WHATSAPP_CRM_PUBLIC_URL', 'CRM_SERVICE_API_TOKEN'];
    const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Auth.config.enabled = true; process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
    process.env.CRM_SERVICE_API_TOKEN = 'independent-fixture-service-token';
    const defaults = provider => {
        const d = Options.getDefaults(provider);
        return { model: d.model ?? d.defaultModel ?? null, voiceName: d.voiceName ?? d.defaultVoiceName ?? null };
    };
    const google = defaults('google_live');
    const catalog = { defaultProvider: Options.getDefaultProvider(), providers: [
        { id: 'neuro_gemini', label: 'Neuro + Gemini', available: true,
            models: [A.voiceModel, B.voiceModel].map(id => ({ id, label: id })),
            voices: [A.voiceName, B.voiceName].map(id => ({ id, label: id, language: 'ru' })),
            defaultModel: defaults('neuro_gemini').model, defaultVoiceName: defaults('neuro_gemini').voiceName },
        { id: 'google_live', label: 'Google Live', available: true,
            models: google.model ? [{ id: google.model, label: google.model }] : [],
            voices: google.voiceName ? [{ id: google.voiceName, label: google.voiceName }] : [],
            defaultModel: google.model, defaultVoiceName: google.voiceName },
    ] };
    for (const provider of ['openai_realtime', 'yandex_realtime', 'deepgram', 'local']) {
        const d = defaults(provider);
        catalog.providers.push({ id: provider, label: provider, available: true,
            models: d.model ? [{ id: d.model, label: d.model }] : [],
            voices: d.voiceName ? [{ id: d.voiceName, label: d.voiceName }] : [],
            defaultModel: d.model, defaultVoiceName: d.voiceName });
    }
    let optionCalls = 0;
    Options.getOptions = async () => { optionCalls++; return clone(catalog); };
    const app = require('../src/app').app;
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
    const request = (user, url, body, extra = {}) => fetch(`${origin}${url}`, {
        method: body === undefined ? 'GET' : 'PUT',
        headers: { Cookie: user.cookie, Origin: origin, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...extra,
    });
    async function profile(user, id) {
        const response = await request(user, `/api/hotel-profiles/${id}`);
        assert.strictEqual(response.status, 200); return (await response.json()).profile;
    }
    async function save(user, id, patch, route = 'hotel-profiles') {
        const response = await request(user, `/api/${route}/${id}`, patch);
        const data = await response.json();
        assert.strictEqual(response.status, 200, JSON.stringify(data));
        assert.strictEqual(data.success, true); return profile(user, id);
    }
    async function serviceProfile(id) {
        const response = await fetch(`${origin}/api/ml/hotel-profiles/${id}`, {
            headers: { Authorization: 'Bearer independent-fixture-service-token' },
        });
        assert.strictEqual(response.status, 200); return (await response.json()).profile;
    }
    try { await run({ a, b, ownerA, ownerB, manager, request, profile, save, serviceProfile,
        Options, catalog, defaults, optionCalls: () => optionCalls }); }
    finally {
        Options.getOptions = previous.options; Auth.config.enabled = previous.enabled;
        await new Promise(resolve => server.close(resolve));
        for (const key of keys) if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
async function bounded(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('acceptance gate did not reach catalog boundary')), 5000);
    })]); } finally { clearTimeout(timer); }
}

describe('Independent Neuro Gemini cross-stack acceptance', () => {
    it('persists two tenants, restores providers, and exports actual service profiles for engine acceptance', () => fixture(async f => {
        await DB.updateInstance(f.a.id, { aiProvider: 'yandex', yandexGptModelUri: 'crm-model-A',
            sipTrunkNumber: 'fixture-trunk-A', greenApiToken: 'must-not-appear-in-public-dto' });
        await f.save(f.ownerA, f.a.id, { ...A, systemPrompt: 'Instructions only for Acceptance A',
            voiceGreetingTemplate: 'Hello from A', outboundOpenerTemplate: 'Outbound A' });
        await f.save(f.ownerB, f.b.id, { ...B, systemPrompt: 'Instructions only for Acceptance B',
            voiceGreetingTemplate: 'Hello from B', outboundOpenerTemplate: 'Outbound B' });
        const initial = await Promise.all([f.serviceProfile(f.a.id), f.serviceProfile(f.b.id)]);
        for (const [index, user] of [f.ownerA, f.ownerB].entries()) {
            const publicProfile = await f.profile(user, initial[index].businessId);
            assert.deepStrictEqual(selected(publicProfile), selected(initial[index]));
            assert.deepStrictEqual(selected(publicProfile), triple(index ? B : A));
            assert.deepStrictEqual(publicProfile.voiceSettings, initial[index].voiceSettings);
            assert.ok(!JSON.stringify(publicProfile).includes('must-not-appear'));
        }
        const updated = await f.save(f.ownerA, f.a.id, B);
        const updatedService = await f.serviceProfile(f.a.id);
        await f.save(f.ownerA, f.a.id, { voiceAiProvider: 'google_live' });
        const restored = await f.save(f.ownerA, f.a.id, { voiceAiProvider: 'neuro_gemini' });
        assert.deepStrictEqual(selected(restored), triple(B));
        assert.deepStrictEqual(selected(await f.profile(f.ownerB, f.b.id)), triple(B));
        const raw = await DB.getInstance(f.a.id);
        assert.strictEqual(raw.aiProvider, 'yandex'); assert.strictEqual(raw.yandexGptModelUri, 'crm-model-A');
        assert.strictEqual(raw.sipTrunkNumber, 'fixture-trunk-A');
        assert.strictEqual(restored.systemPrompt, 'Instructions only for Acceptance A');
        assert.strictEqual(restored.voiceGreetingTemplate, 'Hello from A');
        assert.strictEqual(restored.outboundOpenerTemplate, 'Outbound A');
        if (process.env.AVA_NEURO_PROFILE_FIXTURE) fs.writeFileSync(process.env.AVA_NEURO_PROFILE_FIXTURE,
            JSON.stringify({ initial, updated: updatedService, restored: await f.serviceProfile(f.a.id) }, null, 2));
        assert.deepStrictEqual(selected(updated), triple(B));
    }));

    it('survives SQLite reopen and idempotent schema initialization', () => fixture(async f => {
        await f.save(f.ownerA, f.a.id, A);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-neuro-acceptance-db-'));
        const filename = path.join(directory, 'fixture.sqlite');
        try {
            await DB.db.backup(filename); DB.db.close(); DB.db = new Database(filename);
            DB.ensureColumns(); DB.ensureColumns();
            assert.deepStrictEqual(selected(await f.profile(f.ownerA, f.a.id)), triple(A));
            assert.deepStrictEqual(selected(await f.serviceProfile(f.a.id)), triple(A));
        } finally { DB.db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
    }));

    it('explicit blank model and voice reset to this provider defaults; blank provider uses its own default entry', () => fixture(async f => {
        await f.save(f.ownerA, f.a.id, B);
        const reset = await f.save(f.ownerA, f.a.id, { voiceModel: '', voiceName: '' });
        assert.deepStrictEqual(selected(reset), { provider: 'neuro_gemini',
            model: f.defaults('neuro_gemini').model, voice: f.defaults('neuro_gemini').voiceName });
        const defaultProvider = f.Options.getDefaultProvider();
        const implicit = await f.save(f.ownerA, f.a.id, { voiceAiProvider: '' });
        assert.deepStrictEqual(selected(implicit), { provider: defaultProvider,
            model: f.defaults(defaultProvider).model, voice: f.defaults(defaultProvider).voiceName });
        assert.deepStrictEqual(implicit.voiceSettings.neuro_gemini, f.defaults('neuro_gemini'));
    }));

    it('applies the same validation through both profile and generic instance ingress', () => fixture(async f => {
        await f.save(f.ownerA, f.a.id, A);
        for (const route of ['hotel-profiles', 'instances']) {
            for (const patch of [{ voiceModel: 'unsupported-model' }, { voiceName: 'unsupported-voice' },
                { voiceAiProvider: 'invalid' }, { voiceModel: {} }, { voiceName: ['edsel'] }]) {
                const response = await f.request(f.ownerA, `/api/${route}/${f.a.id}`, patch);
                assert.strictEqual(response.status, 400, `${route} accepted ${JSON.stringify(patch)}`);
                assert.deepStrictEqual(selected(await f.profile(f.ownerA, f.a.id)), triple(A));
            }
            await f.save(f.ownerA, f.a.id, { hotelTone: 'Still valid',
                voiceSettings: { neuro_gemini: { model: 'forged', voiceName: 'forged' } } }, route);
            assert.deepStrictEqual(selected(await f.profile(f.ownerA, f.a.id)), triple(A));
        }
    }));

    it('denies cross-tenant, manager and cross-origin changes before provider dispatch', () => fixture(async f => {
        const before = f.optionCalls();
        for (const [user, id] of [[f.ownerA, f.b.id], [f.manager, f.a.id]]) {
            assert.strictEqual((await f.request(user, `/api/hotel-profiles/${id}`, A)).status, 403);
            assert.strictEqual((await f.request(user, `/api/hotel-profiles/${id}/voice-preview`,
                { provider: 'neuro_gemini', voiceName: 'edsel' }, { method: 'POST' })).status, 403);
        }
        assert.strictEqual((await f.request(f.ownerA, `/api/hotel-profiles/${f.b.id}/voice-options`)).status, 403);
        assert.strictEqual((await f.request(f.ownerA, `/api/hotel-profiles/${f.a.id}`, A, {
            headers: { Cookie: f.ownerA.cookie, Origin: 'https://foreign.example.test', 'Content-Type': 'application/json' },
        })).status, 403);
        assert.strictEqual(f.optionCalls(), before);
        assert.strictEqual((await f.request(f.manager, `/api/hotel-profiles/${f.a.id}/voice-options`)).status, 200);
    }));

    it('keeps legacy settings during unavailable catalogs and rejects new unsupported choices', () => fixture(async f => {
        DB.run('UPDATE instances SET voiceAiProvider=?,voiceModel=?,voiceName=?,voiceSettings=? WHERE id=?',
            ['neuro_gemini', 'legacy-model', 'legacy-voice', '{}', f.a.id]);
        let upstream = 0;
        f.Options.getOptions = async () => { upstream++; return { providers: f.catalog.providers.map(p => ({ ...p, available: false })) }; };
        await f.save(f.ownerA, f.a.id, { hotelTone: 'Calm' });
        await f.save(f.ownerA, f.a.id, { voiceAiProvider: 'neuro_gemini', voiceModel: 'legacy-model', voiceName: 'legacy-voice' });
        assert.strictEqual(upstream, 0);
        assert.deepStrictEqual(selected(await f.profile(f.ownerA, f.a.id)), { provider: 'neuro_gemini', model: 'legacy-model', voice: 'legacy-voice' });
        assert.strictEqual((await f.request(f.ownerA, `/api/hotel-profiles/${f.a.id}`, A)).status, 503);
        assert.strictEqual(upstream, 1);
    }));

    it('rechecks membership after awaited catalog validation before profile and instance writes', () => fixture(async f => {
        for (const route of ['hotel-profiles', 'instances']) {
            DB.run('UPDATE ava_business_memberships SET enabled=1 WHERE userId=?', [f.ownerA.userId]);
            const before = await DB.getInstance(f.a.id), entered = deferred(), release = deferred();
            f.Options.getOptions = async () => { entered.resolve(); await release.promise; return clone(f.catalog); };
            const pending = f.request(f.ownerA, `/api/${route}/${f.a.id}`, A);
            try { await bounded(entered.promise); DB.run('UPDATE ava_business_memberships SET enabled=0 WHERE userId=?', [f.ownerA.userId]); }
            finally { release.resolve(); }
            assert.strictEqual((await pending).status, 403, `${route} committed after membership revocation`);
            const after = await DB.getInstance(f.a.id);
            for (const field of ['voiceAiProvider', 'voiceModel', 'voiceName', 'voiceSettings']) assert.strictEqual(after[field], before[field]);
        }
    }));

    it('merges different provider entries under interleaved same-business saves', () => fixture(async f => {
        const entered = deferred(), release = deferred(); let calls = 0;
        f.Options.getOptions = async () => {
            if (++calls === 1) { entered.resolve(); await release.promise; }
            return clone(f.catalog);
        };
        const slow = f.request(f.ownerA, `/api/hotel-profiles/${f.a.id}`, A);
        try {
            await bounded(entered.promise);
            await f.save(f.ownerA, f.a.id, { voiceAiProvider: 'google_live' });
        } finally { release.resolve(); }
        assert.strictEqual((await slow).status, 200);
        let current = await f.profile(f.ownerA, f.a.id);
        assert.deepStrictEqual(current.voiceSettings.neuro_gemini, { model: A.voiceModel, voiceName: A.voiceName });
        assert.deepStrictEqual(current.voiceSettings.google_live, f.defaults('google_live'));
        current = await f.save(f.ownerA, f.a.id, { voiceAiProvider: 'google_live' });
        assert.deepStrictEqual(selected(current), { provider: 'google_live', ...{ model: f.defaults('google_live').model, voice: f.defaults('google_live').voiceName } });
        current = await f.save(f.ownerA, f.a.id, { voiceAiProvider: 'neuro_gemini' });
        assert.deepStrictEqual(selected(current), triple(A));
    }));
});

function previewService(overrides = {}) {
    const { createVoiceOptionsService } = require('../src/services/voice-options.service');
    return createVoiceOptionsService({
        env: { NEURO_GEMINI_ENABLED: 'true', NEURO_API_KEY: 'synthetic-fixture-key',
            GEMINI_PROJECT_ID: 'synthetic-fixture-project', GEMINI_LOCATION: 'global' },
        engineConfig: { providers: { neuro_gemini: { enabled: true, model: A.voiceModel, voice_name: A.voiceName } } },
        fetchImpl: async () => new Response(JSON.stringify({ voices: [{ voice_id: 'edsel', name: 'Fixture' }] }),
            { headers: { 'Content-Type': 'application/json' } }),
        ...overrides,
    });
}

function pcmWave() {
    const bytes = Buffer.alloc(48);
    bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVE', 8);
    bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
    bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(4, 40);
    bytes.writeInt16LE(900, 44); bytes.writeInt16LE(-900, 46);
    return bytes;
}

describe('Independent catalog and playable-preview regressions', () => {
    it('does not advertise an absent or disabled runtime provider and never fetches its catalog', async () => {
        for (const block of [undefined, { enabled: false }, { enabled: 'false' }]) {
            let fetches = 0;
            const service = previewService({ engineConfig: { providers: block ? { neuro_gemini: block } : {} },
                fetchImpl: async () => { fetches++; throw new Error('must not dispatch'); } });
            const provider = (await service.getOptions()).providers.find(item => item.id === 'neuro_gemini');
            assert.strictEqual(provider.available, false); assert.strictEqual(fetches, 0);
        }
    });

    it('wraps raw PCM into finite playable WAV and rejects containers, empty, unaligned or JSON bytes before caching', async () => {
        const markerOnly = Buffer.alloc(44); markerOnly.write('RIFF'); markerOnly.write('WAVE', 8);
        const pcm = pcmWave().subarray(44);
        const malformed = [markerOnly, pcmWave(), Buffer.alloc(0), Buffer.alloc(3), Buffer.from('{"error":1} ')];
        for (const audio of [pcm, ...malformed]) {
            let syntheses = 0;
            const service = previewService({ fetchImpl: async (url) => {
                if (url.endsWith('/v1/voices')) return new Response(JSON.stringify({ voices: [{ voice_id: 'edsel' }] }),
                    { headers: { 'Content-Type': 'application/json' } });
                assert.ok(url.includes('output_format=pcm_24000'));
                syntheses++; return new Response(audio, { headers: { 'Content-Type': 'audio/pcm' } });
            } });
            const input = { provider: 'neuro_gemini', voiceName: 'edsel' };
            if (malformed.includes(audio)) {
                await assert.rejects(() => service.preview(input), e => e.statusCode === 502);
                await assert.rejects(() => service.preview(input), e => e.statusCode === 502);
                assert.strictEqual(syntheses, 2, 'Invalid audio was cached as playable');
            } else {
                const result = await service.preview(input);
                assert.strictEqual(result.contentType, 'audio/wav'); assert.deepStrictEqual(result.audio, pcmWave());
                await service.preview(input); assert.strictEqual(syntheses, 1);
            }
        }
    });

    it('clips preview PCM to four seconds and cancels upstream before returning bounded finite WAV', async () => {
        let cancelled = false, upstreamSignal, sentBody;
        const service = previewService({ fetchImpl: async (url, init) => {
            if (url.endsWith('/v1/voices')) return new Response(JSON.stringify({ voices: [{ voice_id: 'edsel' }] }),
                { headers: { 'Content-Type': 'application/json' } });
            upstreamSignal = init.signal; sentBody = JSON.parse(init.body);
            return new Response(new ReadableStream({
                start(controller) { controller.enqueue(Buffer.alloc(24000 * 2 * 5)); },
                cancel() { cancelled = true; },
            }), { headers: { 'Content-Type': 'audio/pcm' } });
        } });
        const result = await bounded(service.preview({ provider: 'neuro_gemini', voiceName: 'edsel' }));
        assert.strictEqual(result.audio.length, 44 + 24000 * 2 * 4);
        assert.strictEqual(result.audio.readUInt32LE(4), result.audio.length - 8);
        assert.strictEqual(result.audio.readUInt32LE(40), result.audio.length - 44);
        assert.strictEqual(result.audio.readUInt16LE(20), 1); assert.strictEqual(result.audio.readUInt16LE(22), 1);
        assert.strictEqual(result.audio.readUInt32LE(24), 24000); assert.strictEqual(result.audio.readUInt16LE(34), 16);
        assert.strictEqual(upstreamSignal.aborted, true); assert.strictEqual(cancelled, true);
        assert.strictEqual(typeof sentBody.text, 'string'); assert.strictEqual(sentBody.model_id, 'neuro_tts_v2');
        await assert.rejects(() => service.preview({ provider: 'neuro_gemini', voiceName: 'edsel', text: 'Client override' }),
            e => e.statusCode === 400);
    });
});
