const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Profiles = require('../src/services/hotel-profile.service');
const Options = require('../src/services/voice-options.service');
const Access = require('../src/services/identity/customer-access');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const express = require('express');

function fixtureCatalog() {
    return { defaultProvider: Options.getDefaultProvider(), providers: ['google_live', 'openai_realtime', 'yandex_realtime', 'neuro_gemini'].map(id => {
        const defaults = Options.getDefaults(id);
        return { id, available: true, defaultModel: defaults.model, defaultVoiceName: defaults.voiceName,
            models: [...new Set([defaults.model, ...(id === 'neuro_gemini' ? ['gemini-3.8-flash', 'gemini-3.7-flash'] : [])])].map(id => ({ id, label: id })),
            voices: [...new Set([defaults.voiceName, ...(id === 'neuro_gemini' ? ['edsel', 'anna'] : id === 'google_live' ? ['Kore'] : [])])].map(id => ({ id, label: id })) };
    }) };
}
async function configured(fn) {
    createTestDB();
    const original = Options.getOptions;
    Options.getOptions = async () => fixtureCatalog();
    try { await fn(); } finally { Options.getOptions = original; }
}
function authFor(id, role, suffix) {
    const invitation = Identity.createInvitation({ platformRole: 'platform_admin' }, { email: `${suffix}@example.test`, businessId: id, role });
    return Identity.completeInvitation(Identity.claimInvitation(invitation.token), `${suffix}-password-test`);
}
async function httpFixture(fn) {
    await configured(async () => {
        const a = await DB.createInstance({ name: 'A', businessType: 'hotel' });
        const b = await DB.createInstance({ name: 'B', businessType: 'hotel' });
        Identity.ensureSchema();
        const owner = authFor(a.id, 'hotel_owner', 'voice-owner');
        const manager = authFor(a.id, 'manager', 'voice-manager');
        const sessions = new Map([['owner', owner], ['manager', manager]]);
        const originals = { getSession: Auth.getSession, preview: Options.preview, url: process.env.WHATSAPP_CRM_PUBLIC_URL };
        process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
        Auth.getSession = req => sessions.get(req.get('x-test-actor')) || null;
        const app = express();
        app.use(require('../src/routes/voice-settings.routes').previewBody);
        app.use(express.json());
        app.use((req, res, next) => { req.auth = sessions.get(req.get('x-test-actor')); if (!req.auth) return res.status(401).json({}); next(); });
        app.use('/api/ml', require('../src/routes/ml.routes'));
        app.use('/api', require('../src/routes/api.routes'));
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const request = async (path, { method = 'GET', actor = 'owner', body, raw } = {}) => {
            const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
                method, headers: { 'x-test-actor': actor, origin: 'https://ava.example.test', 'content-type': 'application/json' },
                ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
            const type = response.headers.get('content-type') || '';
            return { status: response.status, headers: response.headers, body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
        };
        try { await fn({ a, b, owner, manager, sessions, request }); }
        finally {
            await new Promise(resolve => server.close(resolve));
            Auth.getSession = originals.getSession;
            Options.preview = originals.preview;
            if (originals.url === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL; else process.env.WHATSAPP_CRM_PUBLIC_URL = originals.url;
        }
    });
}

describe('Neuro Gemini canonical backend', () => {
    it('persists independent model and voice for two businesses and restores each provider after reload', () => configured(async () => {
        const a = await DB.createInstance({ name: 'A', businessType: 'hotel' });
        const b = await DB.createInstance({ name: 'B', businessType: 'hotel' });
        await DB.updateInstance(a.id, { yandexGptModelUri: 'text-model-a', systemPrompt: 'A instructions' });
        await Profiles.update(a.id, { voiceAiProvider: 'neuro_gemini', voiceModel: 'gemini-3.7-flash', voiceName: 'anna' });
        await Profiles.update(b.id, { voiceAiProvider: 'neuro_gemini', voiceModel: 'gemini-3.8-flash', voiceName: 'edsel' });
        const old = await Profiles.get(a.id);
        await Profiles.update(a.id, { voiceAiProvider: 'google_live', voiceName: 'Kore' });
        assert.strictEqual((await Profiles.get(a.id)).voiceModel, Options.getDefaults('google_live').model);
        await Profiles.update(a.id, { voiceAiProvider: 'neuro_gemini' });
        const loaded = await Profiles.get(a.id);
        assert.strictEqual(loaded.voiceModel, 'gemini-3.7-flash');
        assert.strictEqual(loaded.voiceName, 'anna');
        assert.deepStrictEqual(loaded.voiceSettings.neuro_gemini, { model: 'gemini-3.7-flash', voiceName: 'anna' });
        assert.strictEqual(old.voiceName, 'anna');
        assert.strictEqual((await Profiles.get(b.id)).voiceName, 'edsel');
        const row = await DB.getInstance(a.id);
        assert.strictEqual(row.aiProvider, 'yandex');
        assert.strictEqual(row.yandexGptModelUri, 'text-model-a');
        assert.strictEqual(row.systemPrompt, 'A instructions');
        await Profiles.update(a.id, { voiceModel: '', voiceName: '' });
        assert.strictEqual((await Profiles.get(a.id)).voiceModel, 'gemini-3.8-flash');
        assert.strictEqual((await Profiles.get(a.id)).voiceName, 'edsel');
    }));

    it('rejects arbitrary provider/model/voice and raw provider maps on profile and generic instance writes', () => configured(async () => {
        const a = await DB.createInstance({ name: 'A', businessType: 'hotel' });
        for (const patch of [
            { voiceAiProvider: 'arbitrary' }, { voiceAiProvider: 'neuro_gemini', voiceModel: 'gemini-made-up' },
            { voiceAiProvider: 'neuro_gemini', voiceName: 'Aoede' }, { voiceModel: {} }, { voiceName: [] },
            { voiceSettings: { neuro_gemini: { model: 'fake', voiceName: 'fake' } } },
        ]) {
            await assert.rejects(() => Profiles.update(a.id, patch), error => error.statusCode === 400);
            await assert.rejects(() => DB.updateInstance(a.id, patch), error => error.statusCode === 400);
        }
        assert.strictEqual((await DB.getInstance(a.id)).voiceAiProvider, null);
    }));

    it('validates generic legacy provider aliases and preserves legacy voice when changing text AI', () => configured(async () => {
        const a = await DB.createInstance({ name: 'Legacy alias', businessType: 'hotel' });
        const configuredCatalog = Options.getOptions;
        Options.getOptions = async () => ({ providers: fixtureCatalog().providers.map(p => ({ ...p, available: false })) });
        await assert.rejects(() => DB.updateInstance(a.id, { aiProvider: 'neuro_gemini' }), error => error.statusCode === 503);
        assert.strictEqual((await DB.getInstance(a.id)).aiProvider, 'yandex');
        Options.getOptions = configuredCatalog;
        await DB.updateInstance(a.id, { aiProvider: 'neuro_gemini', voiceName: 'anna' });
        assert.strictEqual((await Profiles.get(a.id)).voiceName, 'anna');
        assert.strictEqual((await DB.getInstance(a.id)).aiProvider, 'yandex');
        DB.run("UPDATE instances SET voiceAiProvider=NULL, voiceModel=NULL, voiceSettings='{}',aiProvider='google_live',voiceName='LegacyVoice' WHERE id=?", [a.id]);
        Options.getOptions = async () => { throw new Error('legacy text change must not consult catalog'); };
        await DB.updateInstance(a.id, { aiProvider: 'openrouter' });
        assert.strictEqual((await DB.getInstance(a.id)).aiProvider, 'openrouter');
        assert.strictEqual((await Profiles.get(a.id)).voiceAiProvider, 'google_live');
        assert.strictEqual((await Profiles.get(a.id)).voiceName, 'LegacyVoice');
    }));

    it('preserves legacy and saved settings on unrelated/no-op writes and catalog outages', () => configured(async () => {
        const a = await DB.createInstance({ name: 'Legacy', businessType: 'hotel' });
        DB.run('UPDATE instances SET voiceAiProvider=?, voiceModel=?, voiceName=? WHERE id=?', ['google_live', 'old-model', 'old-voice', a.id]);
        Options.getOptions = async () => { throw new Error('catalog must not run'); };
        await Profiles.update(a.id, { name: 'Legacy renamed' });
        await Profiles.update(a.id, { voiceAiProvider: 'google_live', voiceModel: 'old-model', voiceName: 'old-voice' });
        assert.strictEqual((await Profiles.get(a.id)).voiceName, 'old-voice');
        Options.getOptions = async () => ({ providers: fixtureCatalog().providers.map(p => ({ ...p, available: false })) });
        await assert.rejects(() => Profiles.update(a.id, { voiceAiProvider: 'neuro_gemini' }), error => error.statusCode === 503);
        assert.strictEqual((await Profiles.get(a.id)).voiceModel, 'old-model');
    }));

    it('additively migrates a legacy SQLite copy twice preserving selections, secrets, prompts and row counts', async () => {
        createTestDB();
        const a = await DB.createInstance({ name: 'Migration hotel', businessType: 'hotel' });
        DB.run("UPDATE instances SET voiceAiProvider='google_live',voiceName='LegacyVoice',systemPrompt='Keep prompt',greenApiToken='synthetic-marker' WHERE id=?", [a.id]);
        DB.db.exec('ALTER TABLE instances DROP COLUMN voiceSettings');
        DB.db.exec('ALTER TABLE instances DROP COLUMN voiceModel');
        DB.ensureColumns();
        DB.ensureColumns();
        const row = await DB.getInstance(a.id);
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM instances').n, 1);
        assert.strictEqual(row.voiceName, 'LegacyVoice');
        assert.strictEqual(row.greenApiToken, 'synthetic-marker');
        assert.strictEqual(row.systemPrompt, 'Keep prompt');
        assert.deepStrictEqual(JSON.parse(row.voiceSettings), {});
        const profile = await Profiles.get(a.id);
        assert.strictEqual(profile.voiceName, 'LegacyVoice');
        assert.strictEqual(profile.voiceSettings.google_live.voiceName, 'LegacyVoice');
    });

    it('keeps migration free of Twenty side effects and persists/restores legacy selection on first normal switch', () => configured(async () => {
        const a = await DB.createInstance({ name: 'Existing Twenty business', businessType: 'hotel' });
        DB.run("UPDATE instances SET voiceAiProvider='google_live',voiceName='Kore',systemPrompt='Keep instructions' WHERE id=?", [a.id]);
        DB.run("INSERT INTO twenty_workspace_links(businessId,baseUrl,workspaceId,apiKeyEncrypted,enabled) VALUES(?,?,?,?,1)",
            [a.id, 'https://synthetic.invalid', 'synthetic-workspace', 'synthetic-credential']);
        DB.db.exec('ALTER TABLE instances DROP COLUMN voiceSettings');
        DB.db.exec('ALTER TABLE instances DROP COLUMN voiceModel');
        const outboxBefore = DB.get('SELECT count(*) AS n FROM twenty_sync_outbox').n;
        DB.ensureColumns(); DB.ensureColumns();
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM twenty_sync_outbox').n, outboxBefore);
        assert.deepStrictEqual(JSON.parse((await DB.getInstance(a.id)).voiceSettings), {});
        assert.strictEqual((await Profiles.get(a.id)).voiceSettings.google_live.voiceName, 'Kore');
        await Profiles.update(a.id, { voiceAiProvider: 'neuro_gemini', voiceName: 'anna', voiceModel: 'gemini-3.7-flash' });
        assert.strictEqual(JSON.parse((await DB.getInstance(a.id)).voiceSettings).google_live.voiceName, 'Kore');
        await Profiles.update(a.id, { voiceAiProvider: 'google_live' });
        const restored = await Profiles.get(a.id);
        assert.strictEqual(restored.voiceName, 'Kore');
        assert.strictEqual(restored.voiceModel, Options.getDefaults('google_live').model);
        assert.strictEqual(restored.systemPrompt, 'Keep instructions');
        assert.strictEqual((await DB.getInstance(a.id)).aiProvider, 'yandex');
    }));

    it('merges concurrent provider saves and rejects access revoked during awaited validation', () => configured(async () => {
        const a = await DB.createInstance({ name: 'A', businessType: 'hotel' });
        let release, entered;
        const started = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        let calls = 0;
        Options.getOptions = async () => { if (++calls === 1) { entered(); await gate; } return fixtureCatalog(); };
        const first = Profiles.update(a.id, { voiceAiProvider: 'neuro_gemini', voiceName: 'anna' });
        await started;
        await Profiles.update(a.id, { voiceGreetingTemplate: 'Newest greeting', hotelTimezone: 'Europe/Moscow', systemPrompt: 'Newest prompt' });
        await Profiles.update(a.id, { voiceAiProvider: 'google_live', voiceName: 'Kore' });
        release(); await first;
        const saved = await Profiles.get(a.id);
        assert.strictEqual(saved.voiceSettings.google_live.voiceName, 'Kore');
        assert.strictEqual(saved.voiceSettings.neuro_gemini.voiceName, 'anna');
        assert.strictEqual(saved.voiceGreetingTemplate, 'Newest greeting');
        assert.strictEqual(saved.hotelTimezone, 'Europe/Moscow');
        assert.strictEqual(saved.systemPrompt, 'Newest prompt');
        await assert.rejects(() => Profiles.update(a.id, { voiceModel: 'gemini-3.7-flash' }, {
            beforeWrite() { throw Object.assign(new Error('revoked'), { statusCode: 403 }); },
        }), error => error.statusCode === 403);
        assert.strictEqual((await Profiles.get(a.id)).voiceModel, 'gemini-3.8-flash');
    }));

    it('merges a second SQLite connection commit before BEGIN and holds its write lock through authorization', () => configured(async () => {
        const fs = require('fs'), os = require('os'), path = require('path');
        const Database = require('better-sqlite3');
        const a = await DB.createInstance({ name: 'Two connections', businessType: 'hotel' });
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-voice-connections-'));
        const file = path.join(directory, 'copy.db');
        fs.writeFileSync(file, DB.db.serialize());
        const memory = DB.db;
        const main = new Database(file), other = new Database(file);
        main.pragma('journal_mode=WAL'); other.pragma('busy_timeout=1');
        DB.db = main;
        const originalTransaction = main.transaction;
        let interleaved = false, locked = false;
        main.transaction = function (fn) {
            const transaction = originalTransaction.call(this, fn);
            const immediate = transaction.immediate;
            const wrapped = (...args) => transaction(...args);
            wrapped.immediate = (...args) => {
                if (!interleaved) {
                    interleaved = true;
                    const model = Options.getDefaults('google_live').model;
                    other.prepare('UPDATE instances SET voiceAiProvider=?,voiceModel=?,voiceName=?,voiceSettings=? WHERE id=?')
                        .run('google_live', model, 'Kore', JSON.stringify({ google_live: { model, voiceName: 'Kore' } }), a.id);
                }
                return immediate(...args);
            };
            return wrapped;
        };
        try {
            await Profiles.update(a.id, { voiceAiProvider: 'neuro_gemini', voiceName: 'anna' }, {
                beforeWrite() {
                    assert.throws(() => other.prepare("UPDATE instances SET name='collision' WHERE id=?").run(a.id), error => error.code === 'SQLITE_BUSY');
                    locked = true;
                },
            });
            assert.strictEqual(locked, true);
            assert.strictEqual(interleaved, true);
            const map = (await Profiles.get(a.id)).voiceSettings;
            assert.strictEqual(map.google_live.voiceName, 'Kore');
            assert.strictEqual(map.neuro_gemini.voiceName, 'anna');
        } finally { main.close(); other.close(); DB.db = memory; fs.rmSync(directory, { recursive: true, force: true }); }
    }));

    it('real HTTP customer and engine readbacks expose selected fields and generic route cannot bypass validation', () => httpFixture(async ({ a, request }) => {
        const path = `/api/hotel-profiles/${a.id}`;
        const saved = await request(path, { method: 'PUT', body: { voiceAiProvider: 'neuro_gemini', voiceModel: 'gemini-3.7-flash', voiceName: 'anna' } });
        assert.strictEqual(saved.status, 200);
        for (const route of [path, `/api/ml/hotel-profiles/${a.id}`]) {
            const result = await request(route);
            assert.strictEqual(result.body.profile.voiceModel, 'gemini-3.7-flash');
            assert.deepStrictEqual(result.body.profile.voiceSettings.neuro_gemini, { model: 'gemini-3.7-flash', voiceName: 'anna' });
        }
        const invalid = await request(`/api/instances/${a.id}`, { method: 'PUT', body: { voiceAiProvider: 'neuro_gemini', voiceModel: 'fake' } });
        assert.strictEqual(invalid.status, 400);
        const instances = await request('/api/instances');
        assert.strictEqual(instances.body.instances[0].voiceSettings.neuro_gemini.voiceName, 'anna');
        assert.strictEqual(instances.body.instances[0].aiProvider, 'yandex');
    }));

    it('real HTTP tenant and RBAC boundaries protect catalog, preview and profile saves', () => httpFixture(async ({ a, b, request }) => {
        assert.strictEqual(Access.routePolicies.get('get /hotel-profiles/:id/voice-options'), 'business.read');
        assert.strictEqual(Access.routePolicies.get('post /hotel-profiles/:id/voice-preview'), 'business.manage');
        assert.strictEqual((await request(`/api/hotel-profiles/${a.id}/voice-options`, { actor: 'manager' })).status, 200);
        assert.strictEqual((await request(`/api/hotel-profiles/${b.id}/voice-options`)).status, 403);
        assert.strictEqual((await request(`/api/hotel-profiles/${b.id}/voice-preview`, { method: 'POST', body: { provider: 'neuro_gemini', voiceName: 'edsel' } })).status, 403);
        assert.strictEqual((await request(`/api/hotel-profiles/${a.id}/voice-preview`, { actor: 'manager', method: 'POST', body: { provider: 'neuro_gemini', voiceName: 'edsel' } })).status, 403);
        assert.strictEqual((await request(`/api/hotel-profiles/${a.id}`, { actor: 'manager', method: 'PUT', body: { voiceName: 'edsel' } })).status, 403);
    }));

    it('bounds preview bodies/rate and returns playable binary with no-store', () => httpFixture(async ({ a, request }) => {
        let dispatches = 0;
        Options.preview = async (body, options) => { options.beforeSynthesis(); dispatches++; return { audio: Buffer.from('test-audio'), contentType: 'audio/wav' }; };
        const path = `/api/hotel-profiles/${a.id}/voice-preview`;
        for (const body of [null, [], {}, { provider: {}, voiceName: 'edsel' }, { provider: 'neuro_gemini', voiceName: 'edsel', text: 'custom' }, { provider: 'neuro_gemini', voiceName: 'a'.repeat(161) }]) {
            const result = await request(path, { method: 'POST', body });
            assert.strictEqual(result.status, 400);
            assert.strictEqual(result.body.code, 'INVALID_VOICE_PREVIEW_BODY');
        }
        assert.strictEqual((await request(path, { method: 'POST', raw: '{bad-json' })).body.code, 'INVALID_VOICE_PREVIEW_BODY');
        assert.strictEqual((await request(path, { method: 'POST', raw: ' '.repeat(513) })).status, 413);
        for (let i = 0; i < 6; i++) {
            const result = await request(path, { method: 'POST', body: { provider: 'neuro_gemini', voiceName: 'edsel' } });
            assert.strictEqual(result.status, 200);
            assert.match(result.headers.get('content-type'), /audio\/wav/);
            assert.strictEqual(result.headers.get('cache-control'), 'private, no-store');
        }
        assert.strictEqual((await request(path, { method: 'POST', body: { provider: 'neuro_gemini', voiceName: 'edsel' } })).status, 429);
        assert.strictEqual(dispatches, 6);
    }));

    it('reauthorizes HTTP save after catalog await', () => httpFixture(async ({ a, sessions, request }) => {
        let release, entered;
        const started = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        Options.getOptions = async () => { entered(); await gate; return fixtureCatalog(); };
        const save = request(`/api/hotel-profiles/${a.id}`, { method: 'PUT', body: { voiceAiProvider: 'neuro_gemini', voiceName: 'anna' } });
        await started; sessions.delete('owner'); release();
        assert.strictEqual((await save).status, 403);
        assert.strictEqual((await DB.getInstance(a.id)).voiceAiProvider, null);
    }));

    it('reauthorizes HTTP preview after catalog await with zero synthesis dispatches on revoked access', () => httpFixture(async ({ a, sessions, request }) => {
        let release, entered, dispatches = 0;
        const started = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        const service = Options.createVoiceOptionsService({ env: { NEURO_GEMINI_ENABLED: 'true', NEURO_API_KEY: 'fixture', GEMINI_PROJECT_ID: 'fixture' },
            engineConfig: { providers: { neuro_gemini: { enabled: true } } }, fetchImpl: async (url) => {
                if (!url.endsWith('/voices')) { dispatches++; throw new Error('must not synthesize'); }
                entered(); await gate;
                return new Response(JSON.stringify({ voices: [{ voice_id: 'edsel', name: 'Edsel' }] }), { headers: { 'content-type': 'application/json' } });
            } });
        Options.preview = service.preview;
        const preview = request(`/api/hotel-profiles/${a.id}/voice-preview`, { method: 'POST', body: { provider: 'neuro_gemini', voiceName: 'edsel' } });
        await started; sessions.delete('owner'); release();
        assert.strictEqual((await preview).status, 403);
        assert.strictEqual(dispatches, 0);
    }));

    it('cancels upstream catalog work when an HTTP response disconnects', async () => {
        const { EventEmitter } = require('events');
        let entered, seenSignal;
        const started = new Promise(resolve => { entered = resolve; });
        const handlers = require('../src/routes/voice-settings.routes').createHandlers({ profiles: { get: async () => ({ id: 1 }) },
            options: { getOptions: ({ signal }) => new Promise((resolve, reject) => {
                seenSignal = signal; entered(); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
            }) } });
        const res = new EventEmitter();
        res.json = () => { throw new Error('must not send after disconnect'); };
        res.status = () => res;
        const call = handlers.catalog({ params: { id: '1' } }, res);
        await started; res.destroyed = true; res.emit('close'); await call;
        assert.strictEqual(seenSignal.aborted, true);
        assert.strictEqual(res.listenerCount('close'), 0);
    });

    it('reauthorizes business creation after voice catalog validation before inserting any row', () => httpFixture(async ({ sessions, request }) => {
        let entered, release;
        const started = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        Options.getOptions = async () => { entered(); await gate; return fixtureCatalog(); };
        const create = request('/api/instances', { method: 'POST', body: { name: 'Revoked creation', voiceAiProvider: 'neuro_gemini', voiceName: 'edsel' } });
        await started; sessions.delete('owner'); release();
        assert.strictEqual((await create).status, 403);
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM instances').n, 2);
    }));
});
