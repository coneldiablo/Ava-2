'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');
let lastProbe = null;

function capability() {
    const url = process.env.DASHBOARD_TTS_WS_URL || '';
    const token = process.env.DASHBOARD_TTS_AUTH_TOKEN || '';
    if (!/^wss?:\/\//.test(url) || !token) return { available: false, reason: 'TTS_NOT_CONFIGURED' };
    return { available: true };
}

function probe() {
    const configured = capability();
    if (!configured.available) return Promise.resolve(configured);
    const fingerprint = crypto.createHash('sha256').update(`${process.env.DASHBOARD_TTS_WS_URL}\0${process.env.DASHBOARD_TTS_AUTH_TOKEN}`).digest('hex');
    if (lastProbe?.fingerprint === fingerprint && Date.now() - lastProbe.at < 20_000) {
        return Promise.resolve(lastProbe.result);
    }
    return new Promise(resolve => {
        const socket = new WebSocket(process.env.DASHBOARD_TTS_WS_URL, { handshakeTimeout: 1500,
            maxPayload: 128 * 1024, perMessageDeflate: false });
        const timeout = setTimeout(() => finish({ available: false, reason: 'TTS_UNAVAILABLE' }), 2500);
        let done = false;
        function finish(result) {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            socket.close();
            lastProbe = { fingerprint, at: Date.now(), result };
            resolve(result);
        }
        socket.on('error', () => finish({ available: false, reason: 'TTS_UNAVAILABLE' }));
        socket.on('close', () => finish({ available: false, reason: 'TTS_UNAVAILABLE' }));
        socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', auth_token: process.env.DASHBOARD_TTS_AUTH_TOKEN })));
        socket.on('message', raw => {
            let data;
            try { data = JSON.parse(raw.toString()); } catch (_) { return; }
            if (data.type === 'auth_response') {
                if (data.status !== 'ok') return finish({ available: false, reason: 'TTS_UNAVAILABLE' });
                socket.send(JSON.stringify({ type: 'status' }));
            } else if (data.type === 'status_response') {
                finish(data.status === 'ok' && data.models?.tts?.loaded === true
                    ? { available: true } : { available: false, reason: 'TTS_UNAVAILABLE' });
            }
        });
    });
}

function mulawToPcm(bytes) {
    const pcm = Buffer.allocUnsafe(bytes.length * 2);
    for (let i = 0; i < bytes.length; i++) {
        const u = (~bytes[i]) & 0xff;
        const sign = u & 0x80;
        const exponent = (u >> 4) & 0x07;
        const mantissa = u & 0x0f;
        const magnitude = ((mantissa << 3) + 0x84) << exponent;
        const sample = sign ? 0x84 - magnitude : magnitude - 0x84;
        pcm.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
    }
    return pcm;
}

function wav(pcm) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(16000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

function synthesize(briefing) {
    if (!capability().available) return Promise.reject(new Error('AUDIO_UNAVAILABLE'));
    const text = `${briefing.summary} ${briefing.recommendations.slice(0, 3).map(item => `${item.title}. ${item.action}`).join(' ')}`.slice(0, 800);
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(process.env.DASHBOARD_TTS_WS_URL, { handshakeTimeout: 5000,
            maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });
        const timeout = setTimeout(() => finish(new Error('AUDIO_UNAVAILABLE')), 20_000);
        let done = false;
        function finish(error, result) {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            socket.close();
            if (error) reject(error); else resolve(result);
        }
        socket.on('error', () => finish(new Error('AUDIO_UNAVAILABLE')));
        socket.on('close', () => finish(new Error('AUDIO_UNAVAILABLE')));
        socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', auth_token: process.env.DASHBOARD_TTS_AUTH_TOKEN })));
        socket.on('message', raw => {
            let data;
            try { data = JSON.parse(raw.toString()); } catch (_) { return; }
            if (data.type === 'auth_response') {
                if (data.status !== 'ok') return finish(new Error('AUDIO_UNAVAILABLE'));
                socket.send(JSON.stringify({ type: 'tts_request', text, request_id: requestId,
                    call_id: `dashboard-${requestId}`, response_format: 'json' }));
            } else if (data.type === 'tts_response' && data.request_id === requestId) {
                if (data.encoding !== 'mulaw' || data.sample_rate_hz !== 8000
                    || typeof data.audio_data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.audio_data)) {
                    return finish(new Error('AUDIO_UNAVAILABLE'));
                }
                const bytes = Buffer.from(data.audio_data, 'base64');
                if (!bytes.length || bytes.length > 2 * 1024 * 1024 || bytes.length !== data.byte_length) {
                    return finish(new Error('AUDIO_UNAVAILABLE'));
                }
                finish(null, wav(mulawToPcm(bytes)));
            }
        });
    });
}

module.exports = { capability, probe, synthesize, mulawToPcm, wav };
