const { describe, it, assert } = require('./test-helper');
const { createVoiceOptionsService } = require('../src/services/voice-options.service');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const configuredEnv = () => ({ NEURO_GEMINI_ENABLED: 'true', NEURO_API_KEY: 'fixture-secret-never-public',
    GEMINI_PROJECT_ID: 'fixture-project', GEMINI_LOCATION: 'global' });
const catalog = () => new Response(JSON.stringify({ voices: [
    { voice_id: 'edsel', name: 'Эдсель', language: 'ru' }, { voice_id: 'anna', name: 'Анна', labels: { language: 'ru' }, preview_url: 'https://private.example/' },
] }), { headers: { 'content-type': 'application/json' } });
function wav() {
    const audio = Buffer.alloc(48);
    audio.write('RIFF', 0); audio.writeUInt32LE(40, 4); audio.write('WAVE', 8);
    audio.write('fmt ', 12); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20);
    audio.writeUInt16LE(1, 22); audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28);
    audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(4, 40);
    return audio;
}
const audioResponse = () => new Response(wav().subarray(44), { headers: { 'content-type': 'audio/pcm' } });
const neuro = options => options.providers.find(provider => provider.id === 'neuro_gemini');
const make = overrides => createVoiceOptionsService({ env: configuredEnv(), engineConfig: { default_provider: 'google_live', providers: { neuro_gemini: { enabled: true } } }, fetchImpl: async () => catalog(), ...overrides });

describe('Voice catalog and bounded Neuro preview', () => {
    it('saves either Yandex model with the selected LiveTTS voice and retains the native model for rollback', async () => {
        const service = make({ env: { YANDEX_CLOUD_API_KEY: 'fixture', YANDEX_CLOUD_FOLDER_ID: 'fixture' },
            engineConfig: { providers: { yandex_realtime: { enabled: true, role: 'support' } } } });
        for (const model of ['aliceai-llm-flash', 'speech-realtime-max-tts-live/latest']) {
            assert.deepStrictEqual(await service.validateSelection({ provider: 'yandex_realtime', model, voiceName: 'vera' }),
                { provider: 'yandex_realtime', model, voiceName: 'vera' });
        }
    });
    it('exposes all provider IDs and only safe real catalog fields, with server-side authentication', async () => {
        let request;
        const service = make({ fetchImpl: async (url, init) => { request = { url, init }; return catalog(); } });
        const options = await service.getOptions();
        assert.deepStrictEqual(options.providers.map(p => p.id), ['google_live', 'openai_realtime', 'yandex_realtime', 'deepgram', 'local', 'neuro_gemini']);
        assert.strictEqual(neuro(options).available, true);
        assert.deepStrictEqual(neuro(options).voices, [{ id: 'edsel', label: 'Эдсель', language: 'ru' }, { id: 'anna', label: 'Анна', language: 'ru' }]);
        assert.strictEqual(request.url, 'https://speech.neuro.net/v1/voices');
        assert.strictEqual(request.init.headers['xi-api-key'], configuredEnv().NEURO_API_KEY);
        assert.strictEqual(request.init.redirect, 'error');
        assert.ok(!JSON.stringify(options).includes(configuredEnv().NEURO_API_KEY));
        assert.ok(!JSON.stringify(options).includes('private.example'));
    });

    it('requires explicit runtime readiness, project, location and credentials before exposing available Neuro', async () => {
        for (const patch of [{ NEURO_GEMINI_ENABLED: '' }, { NEURO_API_KEY: '' }, { GEMINI_PROJECT_ID: '' }, { GEMINI_LOCATION: 'europe-west1' }, { NEURO_API_ENDPOINT: 'http://unsafe.example' }, { NEURO_GEMINI_MODELS: 'invented-model' }]) {
            let calls = 0;
            const service = make({ env: { ...configuredEnv(), ...patch }, fetchImpl: async () => { calls++; return catalog(); } });
            assert.strictEqual(neuro(await service.getOptions()).available, false);
            assert.strictEqual(calls, 0);
        }
    });

    it('requires an explicitly enabled Neuro deployment block even when env credentials and flags exist', async () => {
        for (const providers of [{}, { neuro_gemini: {} }, { neuro_gemini: { enabled: false } }]) {
            let calls = 0;
            const service = make({ engineConfig: { providers }, fetchImpl: async () => { calls++; return catalog(); } });
            assert.strictEqual(neuro(await service.getOptions()).available, false);
            await assert.rejects(() => service.preview({ provider: 'neuro_gemini', voiceName: 'edsel' }), e => e.code === 'VOICE_PROVIDER_UNAVAILABLE');
            assert.strictEqual(calls, 0);
        }
    });

    it('supports GOOGLE_CLOUD_PROJECT fallback and restricts configured models to the runtime allowlist', async () => {
        const service = make({ env: { ...configuredEnv(), GEMINI_PROJECT_ID: '', GOOGLE_CLOUD_PROJECT: 'fallback', NEURO_GEMINI_MODELS: 'gemini-3.7-flash,invented-model' } });
        const provider = neuro(await service.getOptions());
        assert.strictEqual(provider.available, true);
        assert.deepStrictEqual(provider.models.map(model => model.id), ['gemini-3.7-flash']);
        assert.strictEqual(service.getDefaults('neuro_gemini').model, 'gemini-3.7-flash');
    });

    it('uses deployment provider defaults independently from CRM text models and filters incompatible Yandex roles', async () => {
        const service = make({ env: { ...configuredEnv(), OPENAI_API_KEY: 'fixture', YANDEX_CLOUD_API_KEY: 'fixture', YANDEX_CLOUD_FOLDER_ID: 'fixture' },
            engineConfig: { default_provider: 'openai_realtime', providers: {
                openai_realtime: { enabled: true, model: 'gpt-realtime-2', voice: 'coral' },
                yandex_realtime: { enabled: true, role: 'support', voice: 'vera' },
                deepgram: { enabled: false, model: 'nova-2-phonecall', tts_model: 'aura-2-thalia-en' },
            } } });
        assert.strictEqual(service.getDefaultProvider(), 'openai_realtime');
        assert.deepStrictEqual(service.getDefaults('openai_realtime'), { model: 'gpt-realtime-2', voiceName: 'coral' });
        const options = await service.getOptions();
        assert.strictEqual(options.providers.find(p => p.id === 'deepgram').available, false);
        assert.ok(!options.providers.find(p => p.id === 'yandex_realtime').voices.some(v => v.id === 'denis'));
        assert.strictEqual(options.defaultProvider, 'openai_realtime');
    });

    it('reads mounted YAML and additive local scalar defaults with environment expansion', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-voice-options-'));
        try {
            const file = path.join(directory, 'ai-agent.yml');
            fs.writeFileSync(file, 'default_provider: openai_realtime\nproviders:\n  openai_realtime:\n    enabled: true\n    model: gpt-realtime-2\n    voice: alloy\n  neuro_gemini:\n    enabled: true\n    model: gemini-3.8-flash\n    voice_name: edsel\n');
            fs.writeFileSync(path.join(directory, 'ai-agent.local.yml'), 'providers:\n  openai_realtime:\n    voice: "${FIXTURE_VOICE:-coral}"\n  neuro_gemini:\n    model: gemini-3.7-flash\n    voice_name: anna\n');
            const service = createVoiceOptionsService({ env: { ...configuredEnv(), AVA_VOICE_CONFIG_PATH: file, FIXTURE_VOICE: 'sage', OPENAI_API_KEY: 'fixture' }, fetchImpl: async () => catalog() });
            assert.strictEqual(service.getDefaultProvider(), 'openai_realtime');
            assert.deepStrictEqual(service.getDefaults('openai_realtime'), { model: 'gpt-realtime-2', voiceName: 'sage' });
            assert.deepStrictEqual(service.getDefaults('neuro_gemini'), { model: 'gemini-3.7-flash', voiceName: 'anna' });
            assert.strictEqual((await service.getOptions()).providers.find(p => p.id === 'openai_realtime').available, true);
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });

    it('uses the deployment default override and rejects credential-bearing or off-host Neuro endpoints', async () => {
        const service = make({ env: { ...configuredEnv(), AVA_VOICE_DEFAULT_PROVIDER: 'neuro_gemini' } });
        assert.strictEqual(service.getDefaultProvider(), 'neuro_gemini');
        for (const endpoint of ['https://secret@speech.neuro.net', 'https://speech.neuro.net?key=private', 'https://other.example', 'https://speech.neuro.net#private']) {
            const unavailable = make({ env: { ...configuredEnv(), NEURO_API_ENDPOINT: endpoint } });
            assert.strictEqual(neuro(await unavailable.getOptions()).available, false);
        }
    });

    it('honors trusted sanitized legacy readiness without requiring runtime secrets in CRM', async () => {
        const service = make({ env: { ...configuredEnv(), OPENAI_API_KEY: 'fixture' }, engineConfig: {
            default_provider: 'google_live', providers: {
                google_live: { enabled: true, credentials_configured: true, llm_model: 'gemini-live-2.5-flash-native-audio', tts_voice_name: 'Aoede' },
                openai_realtime: { enabled: true, credentials_configured: false, model: 'gpt-realtime-2', voice: 'alloy' },
                yandex_realtime: { enabled: false, credentials_configured: true, voice: 'sofia' },
                neuro_gemini: { credentials_configured: true },
            },
        } });
        const options = await service.getOptions();
        assert.strictEqual(options.providers.find(p => p.id === 'google_live').available, true);
        assert.strictEqual(options.providers.find(p => p.id === 'openai_realtime').available, false);
        assert.strictEqual(options.providers.find(p => p.id === 'yandex_realtime').available, false);
        assert.ok(!JSON.stringify(options).includes('credentials_configured'));
        const neuroWithoutKey = make({ env: { ...configuredEnv(), NEURO_API_KEY: '' }, engineConfig: { providers: { neuro_gemini: { enabled: true, credentials_configured: true } } } });
        assert.strictEqual(neuro(await neuroWithoutKey.getOptions()).available, false);
    });

    it('rejects unknown providers, models and cross-provider voices', async () => {
        const service = make();
        await assert.rejects(() => service.validateSelection({ provider: 'invented', voiceName: 'edsel' }), e => e.statusCode === 400 && e.code === 'INVALID_VOICE_AI_PROVIDER');
        await assert.rejects(() => service.validateSelection({ provider: 'neuro_gemini', model: 'gemini-fake', voiceName: 'edsel' }), e => e.code === 'INVALID_VOICE_MODEL');
        await assert.rejects(() => service.validateSelection({ provider: 'neuro_gemini', voiceName: 'Aoede' }), e => e.code === 'INVALID_VOICE_NAME');
        assert.deepStrictEqual(await service.validateSelection({ provider: 'neuro_gemini', voiceName: 'anna' }), { provider: 'neuro_gemini', model: 'gemini-3.8-flash', voiceName: 'anna' });
    });

    it('retains last known voices during a transient catalog failure without permitting new selections', async () => {
        let at = 0; let fail = false;
        const service = make({ now: () => at, catalogTtlMs: 10, fetchImpl: async () => { if (fail) throw new Error('secret upstream diagnostic'); return catalog(); } });
        const first = await service.getOptions();
        first.providers.find(p => p.id === 'neuro_gemini').voices[0].id = 'mutated';
        at = 11; fail = true;
        const unavailable = neuro(await service.getOptions());
        assert.strictEqual(unavailable.available, false);
        assert.strictEqual(unavailable.voices[0].id, 'edsel');
        await assert.rejects(() => service.validateSelection({ provider: 'neuro_gemini', voiceName: 'edsel' }), e => e.code === 'VOICE_PROVIDER_UNAVAILABLE' && !e.message.includes('secret'));
    });

    it('treats malformed, duplicate or oversized upstream catalogs as unavailable', async () => {
        for (const response of [
            () => new Response('not json', { headers: { 'content-type': 'application/json' } }),
            () => new Response(JSON.stringify({ voices: [{ voice_id: '../unsafe' }] }), { headers: { 'content-type': 'application/json' } }),
            () => new Response(JSON.stringify({ voices: [{ voice_id: 'edsel' }, { voice_id: 'edsel' }] }), { headers: { 'content-type': 'application/json' } }),
            () => new Response('x'.repeat(200), { headers: { 'content-type': 'application/json' } }),
            () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
            () => new Response('unread upstream secret', { status: 403, headers: { 'content-type': 'application/json' } }),
        ]) {
            const service = make({ maxCatalogBytes: 150, fetchImpl: async () => response() });
            assert.strictEqual(neuro(await service.getOptions()).available, false);
        }
    });

    it('rejects extra text/model fields and malformed preview bodies before upstream requests', async () => {
        let calls = 0;
        const service = make({ fetchImpl: async () => { calls++; return catalog(); } });
        for (const input of [null, [], {}, { provider: 'neuro_gemini' }, { provider: 'neuro_gemini', voiceName: 42 }, { provider: 'neuro_gemini', voiceName: 'edsel', text: 'arbitrary long text' }, { provider: 'neuro_gemini', voiceName: 'edsel', model: 'gemini-3.8-flash' }]) {
            await assert.rejects(() => service.preview(input), e => e.statusCode === 400 && e.code === 'INVALID_VOICE_PREVIEW_BODY');
        }
        assert.strictEqual(calls, 0);
    });

    it('returns fixed short playable WAV preview and caches independent copies without exposing credentials', async () => {
        const requests = [];
        const service = make({ fetchImpl: async (url, init) => { requests.push({ url, init }); return init.method === 'POST' ? audioResponse() : catalog(); } });
        const result = await service.preview({ provider: 'neuro_gemini', voiceName: 'edsel' });
        assert.strictEqual(result.contentType, 'audio/wav');
        assert.strictEqual(result.audio.toString('ascii', 0, 4), 'RIFF');
        const post = requests.find(request => request.init.method === 'POST');
        assert.strictEqual(post.url, 'https://speech.neuro.net/v1/text-to-speech/edsel/stream?output_format=pcm_24000');
        const body = JSON.parse(post.init.body);
        assert.deepStrictEqual(Object.keys(body).sort(), ['model_id', 'text']);
        assert.strictEqual(body.model_id, 'neuro_tts_v2');
        assert.strictEqual(body.text, 'Здравствуйте! Я ассистент AVA.');
        result.audio.fill(0);
        const again = await service.preview({ provider: 'neuro_gemini', voiceName: 'edsel' });
        assert.strictEqual(again.audio.toString('ascii', 0, 4), 'RIFF');
        assert.strictEqual(requests.filter(request => request.init.method === 'POST').length, 1);
    });

    it('reauthorizes after catalog await and never dispatches synthesis after revocation', async () => {
        let synthesis = 0;
        const service = make({ fetchImpl: async (url, init) => { if (init.method === 'POST') synthesis++; return catalog(); } });
        await assert.rejects(() => service.preview({ provider: 'neuro_gemini', voiceName: 'edsel' }, {
            beforeSynthesis: () => { throw Object.assign(new Error('Membership revoked'), { statusCode: 403 }); },
        }), e => e.statusCode === 403);
        assert.strictEqual(synthesis, 0);
    });

    it('requires authorization even for cached preview audio', async () => {
        const service = make({ fetchImpl: async (url, init) => init.method === 'POST' ? audioResponse() : catalog() });
        await service.preview({ provider: 'neuro_gemini', voiceName: 'edsel' });
        await assert.rejects(() => service.preview({ provider: 'neuro_gemini', voiceName: 'edsel' }, {
            beforeSynthesis: () => { throw Object.assign(new Error('Membership revoked'), { statusCode: 403 }); },
        }), e => e.statusCode === 403);
    });

    it('rejects upstream audio errors, wrong content types and invalid audio safely', async () => {
        for (const response of [
            () => new Response('private upstream response', { status: 401 }),
            () => new Response('private upstream response', { headers: { 'content-type': 'application/json' } }),
            () => new Response('not a playable wav', { headers: { 'content-type': 'audio/wav' } }),
        ]) {
            const service = make({ fetchImpl: async (url, init) => init.method === 'POST' ? response() : catalog() });
            await assert.rejects(() => service.preview({ provider: 'neuro_gemini', voiceName: 'edsel' }), e => e.statusCode >= 500 && !e.message.includes('private'));
        }
    });

    it('rejects empty or partial PCM, mislabeled WAV and JSON errors without caching', async () => {
        const streamingWav = wav(); streamingWav.writeUInt32LE(0xffffffff, 4); streamingWav.writeUInt32LE(0xffffffff, 40);
        for (const bytes of [Buffer.alloc(0), Buffer.alloc(3), wav(), streamingWav, Buffer.from('{"error":"private failure"}  '), Buffer.from('["private failure"] ')]) {
            let calls = 0;
            const service = make({ fetchImpl: async (url, init) => {
                if (init.method !== 'POST') return catalog();
                calls++;
                return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
            } });
            for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(() => service.preview({ provider: 'neuro_gemini', voiceName: 'edsel' }), e => e.statusCode === 502 && e.code === 'VOICE_UPSTREAM_INVALID_RESPONSE' && !e.message.includes('private'));
            assert.strictEqual(calls, 2, 'Invalid audio must not enter the preview cache');
        }
    });

    it('wraps valid mono PCM with a finite canonical WAV header for every supported raw content type', async () => {
        for (const contentType of ['audio/pcm', 'audio/x-pcm', 'audio/L16;rate=24000', 'application/octet-stream']) {
            const pcm = Buffer.from([0, 1, 255, 128]);
            const service = make({ fetchImpl: async (url, init) => init.method === 'POST' ? new Response(pcm, { headers: { 'content-type': contentType } }) : catalog() });
            const { audio } = await service.preview({ provider: 'neuro_gemini', voiceName: 'edsel' });
            assert.strictEqual(audio.toString('ascii', 0, 4), 'RIFF');
            assert.strictEqual(audio.readUInt32LE(4), audio.length - 8);
            assert.strictEqual(audio.readUInt16LE(20), 1);
            assert.strictEqual(audio.readUInt16LE(22), 1);
            assert.strictEqual(audio.readUInt32LE(24), 24000);
            assert.strictEqual(audio.readUInt32LE(28), 48000);
            assert.strictEqual(audio.readUInt16LE(32), 2);
            assert.strictEqual(audio.readUInt16LE(34), 16);
            assert.strictEqual(audio.readUInt32LE(40), pcm.length);
            assert.deepStrictEqual(audio.subarray(44), pcm);
        }
    });

    it('clips an oversized or endless PCM stream to four seconds and successfully cancels fetch/body', async () => {
        for (const declared of [false, true]) {
            let cancelled = false;
            let fetchSignal;
            const response = () => new Response(new ReadableStream({
                start(controller) { controller.enqueue(new Uint8Array(300001)); },
                cancel() { cancelled = true; },
            }), { headers: { 'content-type': 'audio/pcm', ...(declared ? { 'content-length': '300001' } : {}) } });
            const service = make({ fetchImpl: async (url, init) => {
                if (init.method !== 'POST') return catalog();
                fetchSignal = init.signal;
                return response();
            } });
            const { audio } = await service.preview({ provider: 'neuro_gemini', voiceName: 'edsel' });
            assert.strictEqual(audio.length, 192044);
            assert.strictEqual(audio.readUInt32LE(4), 192036);
            assert.strictEqual(audio.readUInt32LE(40), 192000);
            assert.strictEqual(cancelled, true);
            assert.strictEqual(fetchSignal.aborted, true);
        }
    });

    it('honors caller cancellation racing with successful preview clipping', async () => {
        const controller = new AbortController();
        const service = make({ fetchImpl: async (url, init) => init.method !== 'POST' ? catalog() : new Response(new ReadableStream({
            start(stream) { stream.enqueue(new Uint8Array(192000)); },
            cancel() { controller.abort(); },
        }), { headers: { 'content-type': 'audio/pcm' } }) });
        await assert.rejects(() => service.preview({ provider: 'neuro_gemini', voiceName: 'edsel' }, { signal: controller.signal }), e => e.code === 'VOICE_REQUEST_CANCELLED');
    });

    it('bounds a stalled fetch and aborts it instead of waiting indefinitely', async () => {
        let synthesisSignal;
        const service = make({ previewTimeoutMs: 20, fetchImpl: async (url, init) => {
            if (init.method !== 'POST') return catalog();
            synthesisSignal = init.signal;
            return new Promise(() => {});
        } });
        await assert.rejects(() => service.preview({ provider: 'neuro_gemini', voiceName: 'edsel' }), e => e.statusCode === 504 && e.code === 'VOICE_UPSTREAM_TIMEOUT');
        assert.strictEqual(synthesisSignal.aborted, true);
    });

    it('bounds a stalled audio body and actively cancels its reader', async () => {
        let cancelled = false;
        const service = make({ previewTimeoutMs: 20, fetchImpl: async (url, init) => init.method !== 'POST' ? catalog()
            : new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'audio/pcm' } }) });
        await assert.rejects(() => service.preview({ provider: 'neuro_gemini', voiceName: 'edsel' }), e => e.code === 'VOICE_UPSTREAM_TIMEOUT');
        assert.strictEqual(cancelled, true);
    });

    it('honors caller cancellation before any network request and while streaming audio', async () => {
        const before = new AbortController(); before.abort();
        let calls = 0;
        const unused = make({ fetchImpl: async () => { calls++; return catalog(); } });
        await assert.rejects(() => unused.getOptions({ signal: before.signal }), e => e.code === 'VOICE_REQUEST_CANCELLED');
        assert.strictEqual(calls, 0);
        const controller = new AbortController();
        let cancelled = false;
        const service = make({ fetchImpl: async (url, init) => {
            if (init.method !== 'POST') return catalog();
            setTimeout(() => controller.abort(), 10);
            return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'audio/pcm' } });
        } });
        await assert.rejects(() => service.preview({ provider: 'neuro_gemini', voiceName: 'edsel' }, { signal: controller.signal }), e => e.code === 'VOICE_REQUEST_CANCELLED' && e.statusCode === 499);
        assert.strictEqual(cancelled, true);
    });

    it('propagates catalog cancellation and treats catalog timeout as unavailable', async () => {
        const controller = new AbortController();
        const cancelled = make({ fetchImpl: async () => { setTimeout(() => controller.abort(), 10); return new Promise(() => {}); } });
        await assert.rejects(() => cancelled.getOptions({ signal: controller.signal }), e => e.code === 'VOICE_REQUEST_CANCELLED');
        const timeout = make({ catalogTimeoutMs: 10, fetchImpl: async () => new Promise(() => {}) });
        assert.strictEqual(neuro(await timeout.getOptions()).available, false);
    });
});
