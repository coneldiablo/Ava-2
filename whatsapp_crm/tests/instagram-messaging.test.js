'use strict';

const crypto = require('crypto');
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Instagram = require('../src/services/instagram.service');
const Router = require('../src/services/channel-router.service');
const Identity = require('../src/services/identity/identity-store');
const Routes = require('../src/routes/instagram.routes');
const apiRoutes = require('../src/routes/api.routes');

async function configured(fn) {
    const keys = ['INSTAGRAM_CONNECTOR_ENABLED', 'INSTAGRAM_APP_SECRET',
        'INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'CHANNEL_CREDENTIALS_MASTER_KEY'];
    const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const priorFetch = global.fetch;
    process.env.INSTAGRAM_CONNECTOR_ENABLED = 'true';
    process.env.INSTAGRAM_APP_SECRET = 'app-secret-for-unit-tests-only';
    process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN = 'verify-token-for-unit-tests';
    process.env.CHANNEL_CREDENTIALS_MASTER_KEY = crypto.randomBytes(32).toString('hex');
    try { return await fn(); }
    finally {
        global.fetch = priorFetch;
        for (const key of keys) {
            if (before[key] === undefined) delete process.env[key];
            else process.env[key] = before[key];
        }
    }
}

function signed(payload) {
    const raw = Buffer.from(JSON.stringify(payload));
    return [raw, `sha256=${crypto.createHmac('sha256', process.env.INSTAGRAM_APP_SECRET).update(raw).digest('hex')}`];
}

function inbound(igId = '1001', sender = '7001', mid = 'm-1', at = Date.now()) {
    return { object: 'instagram', entry: [{ id: igId, messaging: [{
        sender: { id: sender }, recipient: { id: igId }, timestamp: at,
        message: { mid, text: 'Hello from customer' },
    }] }] };
}

async function bind(id, igUserId, token = 'valid-professional-token') {
    global.fetch = async url => {
        assert.match(String(url), /graph\.instagram\.com\/v26\.0\/me\?fields=id,account_type/);
        return { ok: true, json: async () => ({ id: igUserId, account_type: 'BUSINESS' }) };
    };
    return Instagram.connect(id, token);
}

describe('Official Instagram Messaging boundary', () => {
    it('stays disabled and reports external prerequisites without a Meta app', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Hotel' });
        const previous = process.env.INSTAGRAM_CONNECTOR_ENABLED;
        delete process.env.INSTAGRAM_CONNECTOR_ENABLED;
        try {
            const state = Instagram.status(instance.id);
            assert.strictEqual(state.configured, false);
            assert.strictEqual(state.state, 'external_setup_required');
            assert.strictEqual(state.mode, 'manual_replies_only');
            await assert.rejects(Instagram.connect(instance.id, 'any-token-that-is-long-enough'),
                error => error.code === 'INSTAGRAM_EXTERNAL_SETUP_REQUIRED');
            assert.deepStrictEqual(await Instagram.send(instance.id, 'ig:7001', 'Hi'),
                { success: false, channel: 'instagram', error: 'instagram_external_setup_required' });
        } finally {
            if (previous === undefined) delete process.env.INSTAGRAM_CONNECTOR_ENABLED;
            else process.env.INSTAGRAM_CONNECTOR_ENABLED = previous;
        }
    });

    it('checks webhook challenge and raw-body HMAC without accepting malformed or wrong signatures', async () => {
        await configured(async () => {
            assert.strictEqual(Instagram.verifyChallenge({ 'hub.mode': 'subscribe',
                'hub.verify_token': process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN,
                'hub.challenge': '12345' }), '12345');
            assert.strictEqual(Instagram.verifyChallenge({ 'hub.mode': 'subscribe',
                'hub.verify_token': process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN,
                'hub.challenge': 'challenge_A-1' }), 'challenge_A-1');
            assert.throws(() => Instagram.verifyChallenge({ 'hub.mode': 'subscribe',
                'hub.verify_token': 'wrong', 'hub.challenge': '12345' }), /INSTAGRAM_CHALLENGE_INVALID/);
            const [raw, signature] = signed(inbound());
            assert.strictEqual(Instagram.verifySignature(raw, signature), true);
            assert.strictEqual(Instagram.verifySignature(Buffer.concat([raw, Buffer.from(' ')]), signature), false);
            assert.strictEqual(Instagram.verifySignature(raw, 'sha256=' + '0'.repeat(64)), false);
            assert.strictEqual(Instagram.verifySignature(Buffer.alloc(128 * 1024 + 1), signature), false);
        });
    });

    it('verifies the token at Meta, encrypts it, and rejects account ownership collision', async () => {
        await configured(async () => {
            createTestDB();
            const first = await DB.createInstance({ name: 'First' });
            const second = await DB.createInstance({ name: 'Second' });
            const status = await bind(first.id, '1001');
            assert.strictEqual(status.state, 'pending_webhook');
            assert.strictEqual(status.access_token, undefined);
            assert.strictEqual(status.igUserIdMasked, '••••1001');
            assert.strictEqual(status.igUserId, undefined);
            const raw = DB.get('SELECT accessTokenEncrypted FROM instagram_accounts WHERE businessId=?', [first.id]);
            assert.ok(raw.accessTokenEncrypted.startsWith('enc:v1:'));
            assert.ok(!raw.accessTokenEncrypted.includes('valid-professional-token'));
            await assert.rejects(bind(second.id, '1001'), error => error.code === 'INSTAGRAM_ACCOUNT_ALREADY_BOUND');
            global.fetch = async () => ({ ok: false });
            await assert.rejects(Instagram.connect(second.id, 'bad-but-long-enough-token'),
                error => error.code === 'INSTAGRAM_TOKEN_INVALID');
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM instagram_accounts').n, 1);
        });
    });

    it('binds each signed inbound message to the recipient business and deduplicates replay durably', async () => {
        await configured(async () => {
            createTestDB();
            const first = await DB.createInstance({ name: 'First' });
            const second = await DB.createInstance({ name: 'Second' });
            await bind(first.id, '1001');
            await bind(second.id, '1002');
            const [raw, signature] = signed(inbound('1001', '7001', 'm-1'));
            assert.deepStrictEqual(Instagram.receive(raw, signature), { accepted: 1, duplicate: 0 });
            assert.deepStrictEqual(Instagram.receive(raw, signature), { accepted: 0, duplicate: 1 });
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM messages WHERE instanceId=?', [first.id]).n, 1);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM messages WHERE instanceId=?', [second.id]).n, 0);
            assert.strictEqual(DB.get('SELECT channel FROM messages WHERE instanceId=?', [first.id]).channel, 'instagram');
            assert.strictEqual(DB.get('SELECT preferredChannel FROM clients WHERE instanceId=?', [first.id]).preferredChannel, 'instagram');
            const [mismatchRaw, mismatchSignature] = signed({ object: 'instagram', entry: [{ id: '1002',
                messaging: [{ ...inbound('1001', '7002', 'm-2').entry[0].messaging[0] }] }] });
            assert.deepStrictEqual(Instagram.receive(mismatchRaw, mismatchSignature), { accepted: 0, duplicate: 0 });
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM instagram_contacts').n, 1);
        });
    });

    it('routes only to an inbound IGSID inside 24 hours; never sends cold, cross-tenant, or expired DMs', async () => {
        await configured(async () => {
            createTestDB();
            const first = await DB.createInstance({ name: 'First' });
            const second = await DB.createInstance({ name: 'Second' });
            await bind(first.id, '1001');
            await bind(second.id, '1002');
            let calls = 0;
            global.fetch = async (url, options) => {
                calls++;
                assert.strictEqual(String(url), 'https://graph.instagram.com/v26.0/1001/messages');
                assert.deepStrictEqual(JSON.parse(options.body), {
                    recipient: { id: '7001' }, message: { text: 'Reply' },
                });
                assert.match(options.headers.Authorization, /^Bearer valid-professional-token$/);
                return { ok: true, json: async () => ({ message_id: 'out-1' }) };
            };
            assert.strictEqual((await Router.sendMessageDetailed(first.id, 'ig:7001', 'Cold', 'instagram',
                { origin: 'authenticated_customer_reply', businessId: first.id })).error,
            'WORKSPACE_CLIENT_NOT_FOUND');
            const [raw, signature] = signed(inbound());
            Instagram.receive(raw, signature);
            assert.strictEqual((await Router.sendMessageDetailed(first.id, 'ig:7001', 'Automation', 'instagram')).error,
                'instagram_manual_reply_required');
            const manual = { origin: 'authenticated_customer_reply', businessId: first.id };
            assert.strictEqual((await Router.sendMessageDetailed(second.id, 'ig:7001', 'Wrong tenant', 'instagram',
                { origin: 'authenticated_customer_reply', businessId: second.id })).error,
            'WORKSPACE_CLIENT_NOT_FOUND');
            const result = await Router.sendMessageDetailed(first.id, 'ig:7001', 'Reply', 'instagram', manual);
            assert.strictEqual(result.success, true);
            assert.strictEqual(calls, 1);
            assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM messages WHERE channel='instagram' AND role='assistant'").n, 1);
            DB.run('UPDATE instagram_contacts SET lastInboundAt=? WHERE businessId=? AND igScopedId=?',
                [Date.now() - 24 * 60 * 60 * 1000 - 1000, first.id, '7001']);
            assert.strictEqual((await Router.sendMessageDetailed(first.id, 'ig:7001', 'Too late', 'instagram', manual)).error,
                'instagram_reply_window_closed');
            assert.strictEqual(calls, 1);
            await bind(first.id, '1003');
            global.fetch = async () => { throw new Error('No send allowed after account change'); };
            assert.strictEqual((await Router.sendMessageDetailed(first.id, 'ig:7001', 'Old contact', 'instagram', manual)).error,
                'instagram_recipient_not_inbound');
        });
    });

    it('does not let another customer read status or submit a token for a foreign business', async () => {
        await configured(async () => {
            createTestDB();
            const foreign = await DB.createInstance({ name: 'Foreign' });
            const previous = Identity.authorizeBusiness;
            Identity.authorizeBusiness = (_auth, businessId) => {
                if (Number(businessId) !== 999) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
                return 999;
            };
            const route = method => Routes.customerRouter.stack.find(layer =>
                layer.route?.path === '/businesses/:businessId/instagram' && layer.route.methods[method]).route;
            const response = () => ({ statusCode: 200, body: null,
                status(code) { this.statusCode = code; return this; },
                json(body) { this.body = body; return this; } });
            const request = { params: { businessId: String(foreign.id) },
                auth: { userId: 'owner', platformRole: 'customer' },
                body: { access_token: 'sensitive-token-never-echoed' } };
            try {
                const read = response();
                await route('get').stack[0].handle(request, read);
                assert.strictEqual(read.statusCode, 403);
                const write = response();
                await route('post').stack[0].handle(request, write);
                assert.strictEqual(write.statusCode, 403);
                assert.ok(!JSON.stringify(write.body).includes('sensitive-token-never-echoed'));
                const remove = response();
                await route('delete').stack[0].handle(request, remove);
                assert.strictEqual(remove.statusCode, 403);
            } finally {
                Identity.authorizeBusiness = previous;
            }
        });
    });

    it('locally disconnects credentials and contacts but preserves historical messages', async () => {
        await configured(async () => {
            createTestDB();
            const instance = await DB.createInstance({ name: 'Hotel' });
            await bind(instance.id, '1001');
            const [raw, signature] = signed(inbound());
            Instagram.receive(raw, signature);
            assert.strictEqual(Instagram.status(instance.id).state, 'inbox_receiving');
            DB.run('UPDATE instagram_accounts SET webhookReceivedAt=? WHERE businessId=?',
                [Date.now() - 24 * 60 * 60 * 1000 - 1, instance.id]);
            assert.strictEqual(Instagram.status(instance.id).state, 'webhook_stale');
            assert.strictEqual(Instagram.disconnect(instance.id).state, 'not_configured');
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM instagram_accounts').n, 0);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM instagram_contacts').n, 0);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM messages WHERE channel=\'instagram\'').n, 1);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM instagram_inbound_events').n, 1);
        });
    });

    it('returns a stable 24-hour-window error from the authenticated manual-send API', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Hotel' });
        await DB.getOrCreateClient(instance.id, 'ig:7001', 'Instagram user');
        DB.run('UPDATE clients SET preferredChannel=? WHERE instanceId=? AND chatId=?',
            ['instagram', instance.id, 'ig:7001']);
        const handler = apiRoutes.stack.find(layer =>
            layer.route?.path === '/clients/:instanceId/:chatId/send-message').route.stack[1].handle;
        Identity.ensureSchema();
        DB.run("INSERT INTO ava_users(id,subject,email,displayName) VALUES('instagram-qa-manager','instagram-qa-subject','instagram-qa@example.test','QA manager')");
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('instagram-qa-manager',?,'manager')",[instance.id]);
        DB.run("UPDATE clients SET assigneeUserId='instagram-qa-manager' WHERE instanceId=? AND chatId='ig:7001'",[instance.id]);
        const actor=Identity.actor('instagram-qa-manager'),token=Identity.createSession('instagram-qa-subject','instagram-qa-session');
        const previousAccess=process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        process.env.AVA_CUSTOMER_ACCESS_ENABLED='true';
        const oldSend = Router.sendMessageDetailed;
        Router.sendMessageDetailed = async () => ({ success: false, channel: 'instagram',
            error: 'instagram_reply_window_closed' });
        const response = () => ({ statusCode: 200, body: null,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; } });
        try {
            const res = response();
            await handler({ params: { instanceId: String(instance.id), chatId: 'ig%3A7001' },
                auth: actor, headers: {cookie:'crm_session=ava2:'+token},
                reauthorizeCustomerAction:()=>require('../src/services/sales-workspace.service').authorizeClientMutation(Identity.actor(actor.userId),instance.id,'ig:7001',{capability:'messages.send'}),
                body: { text: 'Reply' } }, res);
            assert.strictEqual(res.statusCode, 409);
            assert.deepStrictEqual(res.body, { success: false, code: 'instagram_reply_window_closed' });
        } finally {
            if(previousAccess===undefined)delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;else process.env.AVA_CUSTOMER_ACCESS_ENABLED=previousAccess;
            Router.sendMessageDetailed = oldSend;
        }
    });
});
