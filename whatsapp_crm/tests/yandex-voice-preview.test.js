'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { synthesize } = require('../src/services/yandex-voice-preview.service');
const Options = require('../src/services/voice-options.service');
const args = { apiKey: 'fixture-key', folderId: 'fixture-folder', voice: 'sofia', role: 'support', text: 'Здравствуйте!', timeoutMs: 100 };
function fake(mode = 'success') {
    const instances = [];
    class Socket extends EventEmitter {
        constructor(url, options) { super(); this.url = url; this.options = options; this.sent = []; this.terminated = false; instances.push(this); queueMicrotask(() => this.emit('open')); }
        send(raw) {
            const event = JSON.parse(raw); this.sent.push(event);
            if (event.type === 'session.update') queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' }))));
            if (event.type === 'response.create' && mode !== 'stall') queueMicrotask(() => {
                this.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.delta', delta: Buffer.alloc(320, 1).toString('base64') })));
                if (mode === 'close') this.emit('close');
                else this.emit('message', Buffer.from(JSON.stringify({ type: 'response.done', response: { status: mode === 'failure' ? 'failed' : 'completed' } })));
            });
        }
        terminate() { this.terminated = true; }
    }
    return { Socket, instances };
}
test('Yandex LiveTTS preview uses selected voice, fixed text and bounded PCM with no LLM tools', async () => {
    const f = fake(); const result = await synthesize({ ...args, WebSocketImpl: f.Socket }); const s = f.instances[0];
    assert.equal(result.sampleRate, 44100); assert.equal(result.pcm.length, 320); assert(s.terminated);
    assert(s.url.includes('speech-realtime-tts-live')); assert.equal(s.options.headers.Authorization, 'Api-Key fixture-key');
    assert.deepEqual(s.sent.map(e => e.type), ['session.update', 'conversation.item.create', 'response.create']);
    assert.equal(s.sent[0].session.audio.output.voice, 'sofia'); assert.equal(s.sent[1].item.content[0].text, 'Здравствуйте!');
    assert.equal(s.sent[0].session.tools, undefined);
});
test('partial audio is discarded on failed completion or premature close', async () => {
    for (const mode of ['failure', 'close']) {
        const f = fake(mode);
        await assert.rejects(synthesize({ ...args, WebSocketImpl: f.Socket }), { code: 'VOICE_UPSTREAM_INVALID_RESPONSE' });
        assert(f.instances[0].terminated);
    }
});
test('deadline and caller cancellation terminate the socket without replaying a synthesis', async () => {
    const f = fake('stall');
    await assert.rejects(synthesize({ ...args, timeoutMs: 5, WebSocketImpl: f.Socket }), { code: 'VOICE_UPSTREAM_TIMEOUT' });
    assert.equal(f.instances.length, 1); assert(f.instances[0].terminated);
    const c = new AbortController(); const g = fake('stall'); const result = synthesize({ ...args, signal: c.signal, WebSocketImpl: g.Socket }); c.abort();
    await assert.rejects(result, { code: 'VOICE_REQUEST_CANCELLED' }); assert(g.instances[0].terminated);
    const h = fake(); await assert.rejects(synthesize({ ...args, signal: c.signal, WebSocketImpl: h.Socket }), { code: 'VOICE_REQUEST_CANCELLED' }); assert.equal(h.instances.length, 0);
});
test('Yandex availability and selection never depend on the Neuro catalog endpoint', async () => {
    const service = Options.createVoiceOptionsService({ env: { YANDEX_CLOUD_API_KEY: 'fixture', YANDEX_CLOUD_FOLDER_ID: 'fixture-folder' },
        engineConfig: { providers: { yandex_realtime: { enabled: true, role: 'support' } } }, fetchImpl: () => assert.fail('unrelated Neuro request') });
    assert.equal((await service.getOptions()).providers.find(p => p.id === 'yandex_realtime').capabilities.voicePreview, true);
    assert.deepEqual(await service.validateSelection({ provider: 'yandex_realtime', voiceName: 'sofia' }), { provider: 'yandex_realtime', model: 'speech-realtime-max-tts-live/latest', voiceName: 'sofia' });
});
