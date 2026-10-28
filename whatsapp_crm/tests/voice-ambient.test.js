'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Profiles = require('../src/services/hotel-profile.service');
const Settings = require('../src/services/voice-settings.service');
const Options = require('../src/services/voice-options.service');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asset = path.resolve(__dirname, '../../assets/audio/office-ambience.wav');
const make = (overrides = {}) => Options.createVoiceOptionsService({
    env: { AVA_VOICE_AMBIENT_PATH: asset },
    engineConfig: { providers: {}, ambient_audio: { enabled: true, business_ids: [9], volume: .75 } },
    fetchImpl: () => assert.fail('Ambience must never call a provider'), ...overrides,
});

describe('Per-business voice ambience and tone', () => {
    it('validates the complete strict ambience schema without accepting paths, NaN or coercion', () => {
        for (const invalid of [false, 'office', {}, [], { enabled: true, preset: 'office' },
            { enabled: 'true', preset: 'office', volume: .5 }, { enabled: true, preset: '../file', volume: .5 },
            { enabled: true, preset: 'office', volume: '0.5' }, { enabled: true, preset: 'office', volume: NaN },
            { enabled: true, preset: 'office', volume: Infinity }, { enabled: true, preset: 'office', volume: 1.01 },
            { enabled: true, preset: 'office', volume: -.1 }, { enabled: true, preset: 'office', volume: .5, wav_path: '/private/file' }]) {
            assert.throws(() => Settings.normalizeAmbient(invalid), error => error.code === 'INVALID_VOICE_AMBIENT');
        }
        assert.strictEqual(Settings.normalizeAmbient(null), null);
        assert.deepStrictEqual(Settings.normalizeAmbient({ enabled: false, preset: 'office', volume: 0 }), { enabled: false, preset: 'office', volume: 0 });
    });

    it('persists independent overrides and tone, readbacks, and reset without modifying model or voice', async () => {
        createTestDB();
        const a = await DB.createInstance({ name: 'One', businessType: 'hotel' });
        const b = await DB.createInstance({ name: 'Two', businessType: 'hotel' });
        const created = await Profiles.create({ name: 'Ambient creation', voiceAmbient: { enabled: false, preset: 'office', volume: .6 } }, { autoProcess: false });
        assert.deepStrictEqual(created.voiceAmbient, { enabled: false, preset: 'office', volume: .6 });
        const before = await Profiles.get(a.id);
        await Profiles.update(a.id, { voiceAmbient: { enabled: true, preset: 'office', volume: .4 }, hotelTone: 'Доброжелательно, короткими фразами' });
        await Profiles.update(b.id, { voiceAmbient: { enabled: false, preset: 'office', volume: .8 }, hotelTone: 'Спокойно, по делу' });
        const first = await Profiles.get(a.id), second = await Profiles.get(b.id);
        assert.deepStrictEqual(first.voiceAmbient, { enabled: true, preset: 'office', volume: .4 });
        assert.deepStrictEqual(second.voiceAmbient, { enabled: false, preset: 'office', volume: .8 });
        assert.strictEqual(first.voiceName, before.voiceName);
        assert.strictEqual(first.voiceModel, before.voiceModel);
        assert.notStrictEqual(first.hotelTone, second.hotelTone);
        const canonical = JSON.parse((await DB.getInstance(a.id)).voiceAmbient);
        assert.deepStrictEqual(canonical, first.voiceAmbient);
        await Profiles.update(a.id, { voiceAmbient: null });
        assert.strictEqual((await Profiles.get(a.id)).voiceAmbient, null);
        assert.deepStrictEqual((await Profiles.get(b.id)).voiceAmbient, second.voiceAmbient);
        await assert.rejects(() => Profiles.update(a.id, { hotelTone: {} }), error => error.code === 'INVALID_VOICE_TONE');
        await assert.rejects(() => Profiles.update(a.id, { hotelTone: 'x'.repeat(501) }), error => error.code === 'INVALID_VOICE_TONE');
        await assert.rejects(() => DB.updateInstance(a.id, { hotelTone: 'x'.repeat(501) }), error => error.code === 'INVALID_VOICE_TONE');
        await assert.rejects(() => DB.updateInstance(a.id, { voiceAmbient: { enabled: true, preset: 'unknown', volume: 1 } }), error => error.code === 'INVALID_VOICE_AMBIENT');
    });

    it('reports actual legacy fallback for business9 and explicit off/on for any other business', async () => {
        const service = make();
        assert.deepStrictEqual((await service.getOptions({ profile: { id: 9 } })).ambientAudio.effective,
            { enabled: true, preset: 'office', volume: .75 });
        assert.strictEqual((await service.getOptions({ profile: { id: 1 } })).ambientAudio.effective.enabled, false);
        assert.strictEqual((await service.getOptions({ profile: { id: 9, voiceAmbient: { enabled: false, preset: 'office', volume: 1 } } })).ambientAudio.effective.enabled, false);
        assert.strictEqual((await service.getOptions({ profile: { id: 1, voiceAmbient: { enabled: true, preset: 'office', volume: .4 } } })).ambientAudio.effective.volume, .4);
    });

    it('reads additive sanitized deployment fallback without credentials or untrusted paths in response', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-ambient-'));
        try {
            const config = path.join(directory, 'voice.yaml');
            fs.writeFileSync(config, 'default_provider: neuro_gemini\nambient_audio:\n  enabled: true\n  business_ids: [9, 42]\n  volume: 0.6\n  wav_path: /private/server-only/path\nproviders:\n  neuro_gemini:\n    enabled: false\n');
            const service = Options.createVoiceOptionsService({ env: { AVA_VOICE_CONFIG_PATH: config, AVA_VOICE_AMBIENT_PATH: asset } });
            const result = await service.getOptions({ profile: { id: 42 } });
            assert.deepStrictEqual(result.ambientAudio.effective, { enabled: true, preset: 'office', volume: .6 });
            assert.ok(!JSON.stringify(result).includes('/private/'));
            fs.writeFileSync(config, 'ambient_audio:\n  enabled: true\n  business_ids:\n  - 9\n  - 42\n  volume: 0.6\nproviders:\n');
            const block = Options.createVoiceOptionsService({ env: { AVA_VOICE_CONFIG_PATH: config, AVA_VOICE_AMBIENT_PATH: asset } });
            assert.strictEqual((await block.getOptions({ profile: { id: 42 } })).ambientAudio.effective.enabled, true);
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });

    it('returns finite four-second local WAV, respects volume and zero, and reauthorizes cached requests', async () => {
        const service = make();
        const full = await service.ambientPreview({ preset: 'office', volume: 1 });
        const half = await service.ambientPreview({ preset: 'office', volume: .5 });
        const zero = await service.ambientPreview({ preset: 'office', volume: 0 });
        assert.strictEqual(full.contentType, 'audio/wav');
        assert.strictEqual(full.audio.length, 44 + 64000);
        assert.strictEqual(full.audio.readUInt32LE(24), 8000);
        assert.strictEqual(full.audio.readUInt32LE(40), 64000);
        assert.ok(full.audio.subarray(44).some(value => value));
        assert.ok(zero.audio.subarray(44).every(value => value === 0));
        for (let offset = 44; offset < full.audio.length; offset += 2) assert.strictEqual(half.audio.readInt16LE(offset), Math.trunc(full.audio.readInt16LE(offset) * .5) || 0);
        await assert.rejects(() => service.ambientPreview({ preset: 'office', volume: 1 }, { beforeSynthesis: () => { throw Object.assign(new Error('revoked'), { statusCode: 403 }); } }), error => error.statusCode === 403);
        const controller = new AbortController(); controller.abort();
        await assert.rejects(() => service.ambientPreview({ preset: 'office', volume: 1 }, { signal: controller.signal }), error => error.code === 'VOICE_REQUEST_CANCELLED');
    });

    it('reports absent assets honestly and rejects arbitrary preview bodies', async () => {
        const service = make({ env: { AVA_VOICE_AMBIENT_PATH: '/missing/fixture.wav' } });
        assert.strictEqual((await service.getOptions()).ambientAudio.previewAvailable, false);
        await assert.rejects(() => service.ambientPreview({ preset: 'office', volume: 1 }), error => error.code === 'VOICE_AMBIENT_UNAVAILABLE');
        for (const body of [null, {}, [], { preset: 'office', volume: 1, path: '/file' }]) await assert.rejects(() => service.ambientPreview(body), error => error.code === 'INVALID_VOICE_AMBIENT');
    });

    it('protects the real HTTP save, readback and bounded preview with tenant and role policies', async () => {
        createTestDB();
        const Identity = require('../src/services/identity/identity-store');
        const Auth = require('../src/services/auth.service');
        const express = require('express');
        const a = await DB.createInstance({ name: 'One', businessType: 'hotel' });
        const b = await DB.createInstance({ name: 'Two', businessType: 'hotel' });
        Identity.ensureSchema();
        function actor(role, name) {
            const invitation = Identity.createInvitation({ platformRole: 'platform_admin' }, { email: `${name}@example.test`, businessId: a.id, role });
            return Identity.completeInvitation(Identity.claimInvitation(invitation.token), `fixture-${name}`);
        }
        const sessions = new Map([['owner', actor('hotel_owner', 'ambient-owner')], ['manager', actor('manager', 'ambient-manager')]]);
        const original = Auth.getSession, origin = process.env.WHATSAPP_CRM_PUBLIC_URL;
        Auth.getSession = req => sessions.get(req.get('x-test-actor')) || null;
        process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
        const app = express();
        app.use(require('../src/routes/voice-settings.routes').previewBody);
        app.use(express.json());
        app.use((req, res, next) => { req.auth = Auth.getSession(req); if (!req.auth) return res.status(401).json({}); next(); });
        app.use('/api', require('../src/routes/api.routes'));
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const request = async (id, suffix, actorName = 'owner', body) => {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/hotel-profiles/${id}${suffix}`, {
                method: body ? suffix ? 'POST' : 'PUT' : 'GET',
                headers: { 'x-test-actor': actorName, origin: 'https://ava.example.test', 'content-type': 'application/json' },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            return { status: response.status, type: response.headers.get('content-type'), cache: response.headers.get('cache-control'), bytes: Buffer.from(await response.arrayBuffer()) };
        };
        try {
            const setting = { enabled: true, preset: 'office', volume: .35 };
            assert.strictEqual((await request(a.id, '', 'owner', { voiceAmbient: setting, hotelTone: 'Кратко' })).status, 200);
            const readback = JSON.parse((await request(a.id, '')).bytes);
            assert.deepStrictEqual(readback.profile.voiceAmbient, setting);
            const options = JSON.parse((await request(a.id, '/voice-options')).bytes);
            assert.deepStrictEqual(options.ambientAudio.effective, setting);
            const clip = await request(a.id, '/ambient-preview', 'owner', { preset: 'office', volume: .35 });
            assert.strictEqual(clip.status, 200);
            assert.ok(clip.type.includes('audio/wav'));
            assert.strictEqual(clip.cache, 'private, no-store');
            assert.strictEqual(clip.bytes.length, 64044);
            assert.strictEqual((await request(a.id, '/ambient-preview', 'manager', { preset: 'office', volume: .35 })).status, 403);
            assert.strictEqual((await request(b.id, '/ambient-preview', 'owner', { preset: 'office', volume: .35 })).status, 403);
            assert.strictEqual((await request(b.id, '', 'owner', { voiceAmbient: setting })).status, 403);
            assert.strictEqual((await request(a.id, '/ambient-preview', 'owner', { preset: 'unknown', volume: 1 })).status, 400);
            for (let index = 0; index < 5; index++) assert.strictEqual((await request(a.id, '/ambient-preview', 'owner', { preset: 'office', volume: .35 })).status, 200);
            assert.strictEqual((await request(a.id, '/ambient-preview', 'owner', { preset: 'office', volume: .35 })).status, 429);
            assert.strictEqual((await Profiles.get(b.id)).voiceAmbient, null);
        } finally {
            await new Promise(resolve => server.close(resolve));
            Auth.getSession = original;
            if (origin === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL; else process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
        }
    });
});
