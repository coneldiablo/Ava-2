const crypto = require('crypto');
const axios = require('axios');
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Gateway = require('../src/services/openwa.service');
const Connection = require('../src/services/whatsapp-connection.service');

async function fixture(test) {
    createTestDB();
    const previous = { key: process.env.OPENWA_API_KEY, url: process.env.WHATSAPP_CRM_PUBLIC_URL };
    process.env.OPENWA_API_KEY = 'test-shared-gateway-key-with-32-characters';
    process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://crm.example.test';
    const originals = {};
    const calls = [];
    const results = {
        getState: { success: true, data: { rawStatus: 'disconnected', engineLoaded: false } },
        createSession: { success: true, data: { id: 'actual-generated-session' } },
        startSession: { success: true, data: { status: 'qr_ready' } },
        stopSession: { success: true },
        setupWebhook: { success: true },
        getQR: { success: true, type: 'qrCode', message: 'data:image/png;base64,test' },
    };
    for (const name of Object.keys(results)) {
        originals[name] = Gateway[name];
        Gateway[name] = async (...args) => { calls.push({ name, args }); return results[name]; };
    }
    try { await test({ calls, results }); }
    finally {
        Object.assign(Gateway, originals);
        for (const [name, value] of [['OPENWA_API_KEY', previous.key], ['WHATSAPP_CRM_PUBLIC_URL', previous.url]]) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
    }
}

describe('Managed WhatsApp connection', () => {
    it('explains a different-account scan without exposing numbers or retrying the old binding', () => fixture(async ({ calls, results }) => {
        const i = await DB.createInstance({ name: 'Hotel' });
        await DB.updateInstance(i.id, { openWaSessionId: 'old-account' });
        results.getState = { success: true, data: { rawStatus: 'failed', lastError: 'Link rejected: this session is bound to 79990000001, but a different WhatsApp number (79990000002) scanned its QR.' } };
        const result = await Connection.connect(i.id);
        assert.strictEqual(result.code, 'WHATSAPP_ACCOUNT_CHANGED');
        assert.ok(!JSON.stringify(result).includes('7999000'));
        assert.deepStrictEqual(calls.map(c => c.name), ['getState']);
    }));
    it('creates direct sessions when no egress proxy is configured and preserves explicit proxy support', async () => {
        const post = axios.post, previous = process.env.OPENWA_EGRESS_PROXY_URL;
        const calls = [];
        axios.post = async (_url, payload) => { calls.push(payload); return { data: { id: 'created' } }; };
        try {
            process.env.OPENWA_EGRESS_PROXY_URL = '';
            assert.strictEqual((await Gateway.createSession('https://gateway.test', 'key', 'direct')).success, true);
            assert.deepStrictEqual(calls[0], { name: 'direct' });
            process.env.OPENWA_EGRESS_PROXY_URL = 'http://egress.test:8080';
            assert.strictEqual((await Gateway.createSession('https://gateway.test', 'key', 'proxied')).success, true);
            assert.deepStrictEqual(calls[1], { name: 'proxied', proxyUrl: 'http://egress.test:8080', proxyType: 'http' });
        } finally {
            axios.post = post;
            if (previous === undefined) delete process.env.OPENWA_EGRESS_PROXY_URL; else process.env.OPENWA_EGRESS_PROXY_URL = previous;
        }
    });
    it('maps transport/startup failures separately from an explicit account block', async () => {
        const get = axios.get;
        try {
            for (const status of ['failed', 'action_required', 'blocked', 'ready']) {
                axios.get = async () => ({ data: { status, lastError: 'net::ERR_TIMED_OUT at https://web.whatsapp.com/' } });
                const result = await Gateway.getState('https://gateway.test', 'key', 'session');
                assert.strictEqual(result.data.stateInstance, status === 'ready' ? 'authorized' : status === 'blocked' ? 'blocked' : 'failed');
            }
        } finally { axios.get = get; }
    });
    it('treats post-scan QR absence as authentication in progress rather than an error', () => fixture(async ({ results }) => {
        results.getQR = { success: false, statusCode: 400 };
        results.getState = { success: true, data: { rawStatus: 'authenticating' } };
        const result = await Connection.getQRResult({ openWaSessionId: 's' });
        assert.deepStrictEqual(result, { success: true, type: 'pending', status: 'authenticating' });
    }));
    it('replaces only the explicitly selected binding and preserves CRM history', () => fixture(async ({ calls, results }) => {
        const i = await DB.createInstance({ name: 'Hotel' });
        const other = await DB.createInstance({ name: 'Other' });
        await DB.updateInstance(i.id, { openWaSessionId: 'old-account' });
        await DB.updateInstance(other.id, { openWaSessionId: 'other-account' });
        await DB.saveMessage(i.id, '79990001008@c.us', 'Test', 'existing CRM history', 'user');
        results.getState = { success: true, data: { rawStatus: 'ready', engineLoaded: true } };
        const result = await Connection.replaceConnection(i.id, 'old-account');
        assert.strictEqual(result.success, true);
        assert.strictEqual((await DB.getInstance(i.id)).openWaSessionId, 'actual-generated-session');
        assert.strictEqual((await DB.getInstance(other.id)).openWaSessionId, 'other-account');
        assert.strictEqual(DB.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE instanceId=?').get(i.id).n, 1);
        assert.strictEqual(calls.filter(c => c.name === 'stopSession').length, 1);
        assert.strictEqual(calls.find(c => c.name === 'stopSession').args[2], 'old-account');
    }));
    it('rejects stale replacement confirmation without touching the provider', () => fixture(async ({ calls }) => {
        const i = await DB.createInstance({ name: 'Hotel' });
        await DB.updateInstance(i.id, { openWaSessionId: 'current' });
        assert.strictEqual((await Connection.replaceConnection(i.id, 'outdated')).code, 'WHATSAPP_CONNECTION_CHANGED');
        assert.strictEqual(calls.length, 0);
    }));
    it('preserves a working connection when replacement creation fails', () => fixture(async ({ calls, results }) => {
        const i = await DB.createInstance({ name: 'Hotel' });
        await DB.updateInstance(i.id, { openWaSessionId: 'current' });
        results.getState = { success: true, data: { rawStatus: 'ready', engineLoaded: true } };
        results.createSession = { success: false };
        assert.strictEqual((await Connection.replaceConnection(i.id, 'current')).success, false);
        assert.ok(!calls.some(c => c.name === 'stopSession'));
        assert.strictEqual((await DB.getInstance(i.id)).openWaSessionId, 'current');
    }));
    it('starts an existing stopped session and installs its signed callback before QR', () => fixture(async ({ calls }) => {
        const i = await DB.createInstance({ name: 'Hotel', openWaSessionId: 'existing-session' });
        await DB.updateInstance(i.id, { openWaSessionId: 'existing-session' });
        const result = await Connection.connect(i.id);
        assert.strictEqual(result.type, 'qrCode');
        assert.deepStrictEqual(calls.map(c => c.name), ['getState', 'setupWebhook', 'startSession', 'getQR']);
        assert.strictEqual(calls[1].args[3], 'https://crm.example.test/api/webhook/openwa');
        assert.strictEqual(calls[1].args[4].length, 64);
        assert.ok(!JSON.stringify(result).includes(calls[1].args[4]));
    }));
    it('coalesces concurrent connect requests and saves the actual gateway session id', () => fixture(async ({ calls }) => {
        const i = await DB.createInstance({ name: 'Одинаковое имя' });
        const [a, b] = await Promise.all([Connection.connect(i.id), Connection.connect(String(i.id))]);
        assert.deepStrictEqual(a, b);
        assert.strictEqual(calls.filter(c => c.name === 'createSession').length, 1);
        assert.strictEqual(calls.find(c => c.name === 'createSession').args[2], `ava-business-${i.id}`);
        assert.strictEqual((await DB.getInstance(i.id)).openWaSessionId, 'actual-generated-session');
    }));
    it('does not restart an already connected account', () => fixture(async ({ calls, results }) => {
        const i = await DB.createInstance({ name: 'Hotel' });
        await DB.updateInstance(i.id, { openWaSessionId: 'ready-session' });
        results.getState = { success: true, data: { rawStatus: 'ready', engineLoaded: true } };
        results.getQR = { success: true, type: 'alreadyLogged' };
        assert.strictEqual((await Connection.connect(i.id)).type, 'alreadyLogged');
        assert.ok(!calls.some(c => c.name === 'startSession' || c.name === 'createSession'));
    }));
    it('does not invent successful creation on a gateway outage or expose its error', () => fixture(async ({ results }) => {
        const i = await DB.createInstance({ name: 'Hotel' });
        results.createSession = { success: false, error: 'ECONNREFUSED http://user:secret@gateway:2785 Docker' };
        const result = await Connection.connect(i.id);
        assert.strictEqual(result.success, false);
        assert.ok(!(await DB.getInstance(i.id)).openWaSessionId);
        assert.ok(!JSON.stringify(result).match(/Docker|ECONN|secret|2785/));
    }));
    it('rejects a session shared with another business before gateway access', () => fixture(async ({ calls }) => {
        const a = await DB.createInstance({ name: 'Hotel' });
        const b = await DB.createInstance({ name: 'Hotel' });
        await DB.updateInstance(a.id, { openWaSessionId: 'shared' });
        await DB.updateInstance(b.id, { openWaSessionId: 'shared' });
        assert.strictEqual((await Connection.connect(b.id)).code, 'WHATSAPP_SESSION_SCOPE');
        assert.strictEqual(calls.length, 0);
    }));
    it('rejects unsigned, altered, missing-session and cross-business webhook payloads', () => fixture(async () => {
        const instance = { id: 1, openWaSessionId: 'one' };
        const body = { sessionId: 'one', event: 'session.status', data: { status: 'ready' } };
        const rawBody = Buffer.from(JSON.stringify(body));
        const signature = 'sha256=' + crypto.createHmac('sha256', Connection.signingSecret(instance)).update(rawBody).digest('hex');
        const req = { body, rawBody, headers: { 'x-openwa-signature': signature } };
        assert.strictEqual(Connection.verifyWebhook(req, instance), true);
        assert.strictEqual(Connection.verifyWebhook({ ...req, headers: {} }, instance), false);
        assert.strictEqual(Connection.verifyWebhook({ ...req, rawBody: Buffer.from('{}') }, instance), false);
        assert.strictEqual(Connection.verifyWebhook(req, { ...instance, id: 2 }), false);
        assert.strictEqual(Connection.verifyWebhook({ ...req, body: {} }, instance), false);
    }));
    it('uses the installed OpenWA session-scoped API and updates a callback without duplicating it', async () => {
        const original = { get: axios.get, post: axios.post, put: axios.put };
        const calls = [];
        axios.get = async url => { calls.push(['get', url]); return { data: [{ id: 'hook', url: 'https://crm.test/api/webhook/openwa' }] }; };
        axios.post = async () => { throw new Error('must not duplicate'); };
        axios.put = async (url, data) => { calls.push(['put', url, data]); return { data: { id: 'hook' } }; };
        try {
            const result = await Gateway.setupWebhook('https://gateway.test', 'key', 'session-a', 'https://crm.test/api/webhook/openwa', 'signing-secret');
            assert.strictEqual(result.success, true);
            assert.strictEqual(calls[0][1], 'https://gateway.test/api/sessions/session-a/webhooks');
            assert.strictEqual(calls[1][1], 'https://gateway.test/api/sessions/session-a/webhooks/hook');
            assert.strictEqual(calls[1][2].secret, 'signing-secret');
            assert.strictEqual(calls[1][2].active, true);
        } finally { Object.assign(axios, original); }
    });
});
