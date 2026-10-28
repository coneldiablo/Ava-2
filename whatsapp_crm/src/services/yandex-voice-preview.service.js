'use strict';
const WebSocket = require('ws');

// Fixed text, no tools or customer context. LiveTTS uses the same voices/roles as
// the Realtime agent, without paying for an LLM answer merely to preview a voice.
function synthesize({ apiKey, folderId, voice, role, text, signal, timeoutMs = 12000,
    maxBytes = 44100 * 2 * 4, WebSocketImpl = WebSocket }) {
    const fail = (code, statusCode = 502) => Object.assign(new Error(code), { code, statusCode });
    if (!apiKey || !/^[\w-]{3,128}$/.test(folderId || '')) return Promise.reject(fail('VOICE_PROVIDER_UNAVAILABLE', 503));
    if (signal?.aborted) return Promise.reject(fail('VOICE_REQUEST_CANCELLED', 499));
    return new Promise((resolve, reject) => {
        let socket, timer, settled = false, started = false, length = 0;
        const chunks = [];
        const finish = error => {
            if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
            // Keep the error handler installed while terminating a pending handshake.
            try { socket?.terminate(); } catch { /* Already closed. */ }
            if (error) reject(error);
            else if (!length || length % 2) reject(fail('VOICE_UPSTREAM_INVALID_RESPONSE'));
            else resolve({ pcm: Buffer.concat(chunks, length), sampleRate: 44100 });
        };
        const abort = () => finish(fail('VOICE_REQUEST_CANCELLED', 499));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(fail('VOICE_UPSTREAM_TIMEOUT', 504)), timeoutMs);
        try {
            const uri = `gpt://${folderId}/speech-realtime-tts-live/latest`;
            socket = new WebSocketImpl(`wss://ai.api.cloud.yandex.net/v1/realtime/openai?model=${encodeURIComponent(uri)}`,
                { headers: { Authorization: `Api-Key ${apiKey}` }, handshakeTimeout: timeoutMs, maxPayload: 1048576 });
            socket.on('error', () => finish(fail('VOICE_PROVIDER_UNAVAILABLE', 503)));
            socket.on('unexpected-response', (_request, response) => {
                response.resume?.();
                finish(fail(response.statusCode === 429 ? 'VOICE_UPSTREAM_RATE_LIMIT' : 'VOICE_PROVIDER_UNAVAILABLE', response.statusCode === 429 ? 429 : 503));
            });
            socket.on('close', () => { if (!settled) finish(fail('VOICE_UPSTREAM_INVALID_RESPONSE')); });
            socket.on('open', () => {
                if (settled) return;
                socket.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', output_modalities: ['audio'],
                    audio: { output: { format: { type: 'audio/pcm', rate: 44100 }, voice, role } } } }));
            });
            socket.on('message', data => {
                if (settled) return;
                try {
                    const event = JSON.parse(data.toString());
                    if (event.type === 'session.updated' && !started) {
                        started = true;
                        socket.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
                        socket.send(JSON.stringify({ type: 'response.create' }));
                    } else if (event.type === 'response.output_audio.delta') {
                        if (!started || typeof event.delta !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.delta) || event.delta.length % 4) throw fail('VOICE_UPSTREAM_INVALID_RESPONSE');
                        const audio = Buffer.from(event.delta, 'base64');
                        if (!audio.length || audio.length % 2) throw fail('VOICE_UPSTREAM_INVALID_RESPONSE');
                        const remaining = maxBytes - length;
                        chunks.push(audio.subarray(0, remaining)); length += Math.min(audio.length, remaining);
                        if (length >= maxBytes) finish();
                    } else if (event.type === 'response.done') {
                        if (event.response?.status && event.response.status !== 'completed') throw fail('VOICE_UPSTREAM_INVALID_RESPONSE');
                        finish();
                    } else if (event.type === 'error') throw fail('VOICE_PROVIDER_UNAVAILABLE', 503);
                } catch (error) { finish(error.code ? error : fail('VOICE_UPSTREAM_INVALID_RESPONSE')); }
            });
        } catch { finish(fail('VOICE_PROVIDER_UNAVAILABLE', 503)); }
    });
}
module.exports = { synthesize };
