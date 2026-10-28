'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const { PrivateInstagramService } = require('../instagram_private/server');
const Routes = require('../src/routes/instagram.routes');
const Identity = require('../src/services/identity/identity-store');
const ChannelRouter = require('../src/services/channel-router.service');
const apiRoutes = require('../src/routes/api.routes');

async function withPrivate(fn) {
    const previousKey = process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
    const previousEnabled = process.env.INSTAGRAM_PRIVATE_CONNECTOR_ENABLED;
    const previousUsername = process.env.INSTAGRAM_PRIVATE_ALLOWED_USERNAME;
    const previousSender = process.env.INSTAGRAM_PRIVATE_CONFIRMATION_SENDER_ID;
    process.env.CHANNEL_CREDENTIALS_MASTER_KEY = 'a'.repeat(64);
    process.env.INSTAGRAM_PRIVATE_CONNECTOR_ENABLED = 'true';
    delete process.env.INSTAGRAM_PRIVATE_ALLOWED_USERNAME;
    delete process.env.INSTAGRAM_PRIVATE_CONFIRMATION_SENDER_ID;
    try { await fn(); }
    finally {
        if (previousKey === undefined) delete process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
        else process.env.CHANNEL_CREDENTIALS_MASTER_KEY = previousKey;
        if (previousEnabled === undefined) delete process.env.INSTAGRAM_PRIVATE_CONNECTOR_ENABLED;
        else process.env.INSTAGRAM_PRIVATE_CONNECTOR_ENABLED = previousEnabled;
        if (previousUsername === undefined) delete process.env.INSTAGRAM_PRIVATE_ALLOWED_USERNAME;
        else process.env.INSTAGRAM_PRIVATE_ALLOWED_USERNAME = previousUsername;
        if (previousSender === undefined) delete process.env.INSTAGRAM_PRIVATE_CONFIRMATION_SENDER_ID;
        else process.env.INSTAGRAM_PRIVATE_CONFIRMATION_SENDER_ID = previousSender;
    }
}

const credential = { username: 'any_business_account', password: 'local-only-password' };
const session = { cookies: { secret: 'session-only-secret' } };
const runner = async request => {
    if (request.action === 'login') return { account_id: '1001', settings: session };
    if (request.action === 'poll') return { account_id: '1001', settings: session, threads: [{
        id: '3001', peer_id: '2001', messages: [{ id: '4001', sender_id: '2001', text: 'Incoming', timestamp_ms: Date.now() }],
    }] };
    if (request.action === 'reply') return { account_id: '1001', settings: session, message_id: '5001' };
    throw new Error('invalid test request');
};

describe('Instagram private per-business boundary', () => {
    it('fences a timed-out reply worker without dispatching the reply again',async()=>{
        await withPrivate(async()=>{
            createTestDB();const b=await DB.createInstance({name:'Uncertain reply'});let sends=0;
            const service=new PrivateInstagramService(async request=>{
                if(request.action==='reply'){sends++;throw Object.assign(new Error('private'),{code:'INSTAGRAM_PRIVATE_WORKER_TIMEOUT'});}
                return runner(request);
            });
            await service.login(b.id,credential);await service.poll(b.id,true);
            await assert.rejects(service.reply(b.id,'igp:1001:2001','Reply'),{code:'INSTAGRAM_PRIVATE_SEND_RESULT_UNKNOWN'});
            assert.strictEqual(service.status(b.id).state,'paused');
            await assert.rejects(service.reply(b.id,'igp:1001:2001','Reply'),{code:'INSTAGRAM_PRIVATE_THREAD_NOT_FOUND'});
            assert.strictEqual(sends,1);
        });
    });
    it('continues a failed login with the same encrypted device context and clears it after success', async () => {
        await withPrivate(async () => {
            createTestDB();
            const business = await DB.createInstance({name:'Pending login'});
            let attempts = 0;
            const pendingSettings = {uuids:{phone_id:'stable-private-device'},cookies:{private:'partial-cookie'}};
            const service = new PrivateInstagramService(async request => {
                attempts++;
                if (attempts === 1) throw Object.assign(new Error('must not escape'),{
                    code:'INSTAGRAM_PRIVATE_TWO_FACTOR_REQUIRED',loginSettings:pendingSettings});
                assert.deepStrictEqual(request.settings,pendingSettings);
                assert.strictEqual(request.code,'123456');
                return runner(request);
            });
            await assert.rejects(service.login(business.id,credential),{code:'INSTAGRAM_PRIVATE_TWO_FACTOR_REQUIRED'});
            const row = DB.get('SELECT * FROM instagram_private_login_contexts WHERE businessId=?',[business.id]);
            assert.match(row.settingsEncrypted,/^enc:v1:/);
            assert.ok(!JSON.stringify(row).includes('stable-private-device'));
            assert.ok(!JSON.stringify(row).includes(credential.password));
            assert.strictEqual(service.status(business.id).lastLoginError,'INSTAGRAM_PRIVATE_TWO_FACTOR_REQUIRED');
            assert.ok(!JSON.stringify(service.status(business.id)).includes('partial-cookie'));
            await service.login(business.id,{...credential,code:'123456'});
            assert.strictEqual(service.status(business.id).state,'awaiting_inbound');
            assert.strictEqual(DB.get('SELECT * FROM instagram_private_login_contexts WHERE businessId=?',[business.id]),undefined);
        });
    });

    it('never reuses pending device settings for another account, expired attempt or business', async () => {
        await withPrivate(async () => {
            createTestDB();
            const first=await DB.createInstance({name:'First pending'}),second=await DB.createInstance({name:'Second pending'});
            let seen=[];
            const service=new PrivateInstagramService(async request=>{seen.push(request);throw Object.assign(new Error('private'),{
                code:'INSTAGRAM_PRIVATE_WORKER_TIMEOUT',loginSettings:{uuids:{phone_id:'private-device'}}});});
            await assert.rejects(service.login(first.id,credential));
            await assert.rejects(service.login(second.id,credential));
            await assert.rejects(service.login(first.id,{...credential,username:'another_account'}));
            DB.run('UPDATE instagram_private_login_contexts SET expiresAt=0 WHERE businessId=?',[first.id]);
            await assert.rejects(service.login(first.id,{...credential,username:'another_account'}));
            assert.ok(seen.every(request=>request.settings===undefined));
            service.disconnect(first.id);
            assert.strictEqual(DB.get('SELECT * FROM instagram_private_login_contexts WHERE businessId=?',[first.id]),undefined);
            assert.ok(DB.get('SELECT * FROM instagram_private_login_contexts WHERE businessId=?',[second.id]));
        });
    });
    it('stays unavailable by default and never exposes credentials in status', async () => {
        createTestDB();
        const business = await DB.createInstance({ name: 'Separate' });
        const service = new PrivateInstagramService(runner);
        const state = service.status(business.id);
        assert.strictEqual(state.state, 'disabled');
        assert.strictEqual(state.configured, false);
        assert.strictEqual(state.reason, 'connector_disabled_or_key_required');
        await assert.rejects(service.login(business.id, credential), cause => cause.code === 'INSTAGRAM_PRIVATE_DISABLED');
    });

    it('reports Instagram connected in the shared channel status only after a fresh inbound', async () => {
        await withPrivate(async () => {
            createTestDB();
            const business = await DB.createInstance({ name: 'Shared status' });
            const service = new PrivateInstagramService(runner);
            const before = await ChannelRouter.getChannelStatus(business.id);
            assert.strictEqual(before.instagram, false);
            assert.strictEqual(before.instagramState, 'not_connected');
            await service.login(business.id, credential);
            const waiting = await ChannelRouter.getChannelStatus(business.id);
            assert.strictEqual(waiting.instagram, false);
            assert.strictEqual(waiting.instagramConfigured, true);
            assert.strictEqual(waiting.instagramState, 'awaiting_inbound');
            assert.strictEqual(waiting.instagramInboundConfirmed, false);
            await service.poll(business.id, true);
            const confirmed = await ChannelRouter.getChannelStatus(business.id);
            assert.strictEqual(confirmed.instagram, true);
            assert.strictEqual(confirmed.instagramState, 'connected');
            assert.strictEqual(confirmed.instagramInboundConfirmed, true);
            DB.run("UPDATE instagram_private_accounts SET state='paused' WHERE businessId=?", [business.id]);
            const paused = await ChannelRouter.getChannelStatus(business.id);
            assert.strictEqual(paused.instagram, false);
            assert.strictEqual(paused.instagramState, 'paused');
        });
    });

    it('encrypts session, reserves an account globally, and confirms only an actual inbound', async () => {
        await withPrivate(async () => {
            createTestDB();
            const first = await DB.createInstance({ name: 'First' });
            const second = await DB.createInstance({ name: 'Second' });
            const service = new PrivateInstagramService(runner);
            const pending = await service.login(first.id, credential);
            assert.strictEqual(pending.state, 'awaiting_inbound');
            assert.strictEqual(pending.inboundConfirmed, false);
            assert.ok(!JSON.stringify(pending).includes('session-only-secret'));
            assert.ok(!JSON.stringify(pending).includes('local-only-password'));
            const stored = DB.get('SELECT sessionEncrypted FROM instagram_private_accounts WHERE businessId=?', [first.id]);
            assert.match(stored.sessionEncrypted, /^enc:v1:/);
            assert.ok(!stored.sessionEncrypted.includes('session-only-secret'));
            await assert.rejects(service.login(second.id, { ...credential, username: 'another_business_account' }),
                cause => cause.code === 'INSTAGRAM_PRIVATE_ACCOUNT_BOUND');
            assert.strictEqual((await service.poll(first.id, true)).accepted, 1);
            assert.strictEqual(service.status(first.id).state, 'connected');
            assert.strictEqual((await service.poll(first.id, true)).accepted, 0);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM messages WHERE instanceId=?', [first.id]).n, 1);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM messages WHERE instanceId=?', [second.id]).n, 0);
            assert.strictEqual(DB.get('SELECT channel FROM messages WHERE instanceId=?', [first.id]).channel, 'instagram');
        });
    });

    it('connects two independent businesses and continues polling after one account fails', async () => {
        await withPrivate(async () => {
            createTestDB();
            const first = await DB.createInstance({ name: 'First' });
            const second = await DB.createInstance({ name: 'Second' });
            const service = new PrivateInstagramService(async request => {
                if (request.action === 'login') {
                    const accountId = request.username === 'first_owner' ? '1001' : '1002';
                    return { account_id: accountId, settings: { accountId } };
                }
                if (request.action === 'poll') {
                    if (request.settings.accountId === '1001') {
                        throw Object.assign(new Error('upstream secret'), { code: 'INSTAGRAM_PRIVATE_RATE_LIMITED' });
                    }
                    return { account_id: '1002', settings: request.settings, threads: [{
                        id: '3002', peer_id: '2002', messages: [{
                            id: '4002', sender_id: '2002', text: 'Second business inbound', timestamp_ms: Date.now(),
                        }],
                    }] };
                }
                throw new Error('invalid test request');
            });
            await service.login(first.id, { ...credential, username: 'first_owner' });
            await service.login(second.id, { ...credential, username: 'second_owner' });
            await service.pollDue();
            assert.strictEqual(service.status(first.id).state, 'paused');
            assert.strictEqual(service.status(second.id).state, 'connected');
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM messages WHERE instanceId=?', [first.id]).n, 0);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM messages WHERE instanceId=?', [second.id]).n, 1);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM instagram_private_account_claims').n, 2);
        });
    });

    it('confirms a fresh inbound from any peer, but not old, outbound, or mismatched messages', async () => {
        await withPrivate(async () => {
            createTestDB();
            const business = await DB.createInstance({ name: 'Separate' });
            let phase = 'old';
            const service = new PrivateInstagramService(async request => {
                if (request.action !== 'poll') return runner(request);
                const peer = phase === 'old' ? '2001' : '2002';
                const sender = phase === 'outbound' ? '1001' : phase === 'mismatch' ? '2003' : peer;
                return { account_id: '1001', settings: session, threads: [{
                    id: phase === 'old' ? '3001' : '3002', peer_id: peer,
                    messages: [{ id: phase === 'new' ? '4004' : phase === 'mismatch' ? '4003' : phase === 'outbound' ? '4002' : '4001',
                        sender_id: sender, text: 'Incoming',
                        timestamp_ms: phase === 'old' ? Date.now() - 60_000 : Date.now() }],
                }] };
            });
            await service.login(business.id, credential);
            assert.strictEqual((await service.poll(business.id, true)).accepted, 0);
            phase = 'outbound';
            assert.strictEqual((await service.poll(business.id, true)).accepted, 0);
            phase = 'mismatch';
            assert.strictEqual((await service.poll(business.id, true)).accepted, 0);
            assert.strictEqual(service.status(business.id).state, 'awaiting_inbound');
            phase = 'new';
            assert.strictEqual((await service.poll(business.id, true)).accepted, 1);
            assert.strictEqual(service.status(business.id).state, 'connected');
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM messages WHERE instanceId=?', [business.id]).n, 1);
            assert.strictEqual(DB.get('SELECT chatId FROM messages WHERE instanceId=?', [business.id]).chatId, 'igp:1001:2002');
        });
    });

    it('replies only to this business existing thread and keeps history on disconnect', async () => {
        await withPrivate(async () => {
            createTestDB();
            const first = await DB.createInstance({ name: 'First' });
            const second = await DB.createInstance({ name: 'Second' });
            let sends = 0;
            const service = new PrivateInstagramService(async request => {
                if (request.action === 'reply') sends++;
                return runner(request);
            });
            await service.login(first.id, credential);
            await assert.rejects(service.reply(first.id, 'igp:1001:2001', 'Too early'),
                cause => cause.code === 'INSTAGRAM_PRIVATE_THREAD_NOT_FOUND');
            await service.poll(first.id, true);
            await assert.rejects(service.reply(second.id, 'igp:1001:2001', 'Wrong business'),
                cause => cause.code === 'INSTAGRAM_PRIVATE_THREAD_NOT_FOUND');
            await assert.rejects(service.reply(first.id, 'igp:1001:9999', 'Cold'),
                cause => cause.code === 'INSTAGRAM_PRIVATE_THREAD_NOT_FOUND');
            assert.strictEqual(sends, 0);
            assert.strictEqual((await service.reply(first.id, 'igp:1001:2001', 'Manual reply')).success, true);
            assert.strictEqual(sends, 1);
            assert.strictEqual(service.disconnect(first.id).state, 'not_connected');
            assert.strictEqual(DB.get('SELECT sessionEncrypted FROM instagram_private_accounts WHERE businessId=?', [first.id]), undefined);
            assert.strictEqual(DB.get('SELECT businessId FROM instagram_private_account_claims WHERE accountId=?', ['1001']), undefined);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM messages WHERE instanceId=?', [first.id]).n, 2);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM instagram_private_threads WHERE businessId=?', [first.id]).n, 1);
            await assert.rejects(service.reply(first.id, 'igp:1001:2001', 'After disconnect'),
                cause => cause.code === 'INSTAGRAM_PRIVATE_THREAD_NOT_FOUND');
            assert.strictEqual((await service.login(second.id, { ...credential, username: 'second_owner' })).state,
                'awaiting_inbound');
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM messages WHERE instanceId=?', [second.id]).n, 0);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM instagram_private_threads WHERE businessId=?', [second.id]).n, 0);
        });
    });

    it('can reclaim a legacy disabled account without exposing its old business history', async () => {
        await withPrivate(async () => {
            createTestDB();
            const first = await DB.createInstance({ name: 'First' });
            const second = await DB.createInstance({ name: 'Second' });
            const service = new PrivateInstagramService(runner);
            await service.login(first.id, credential);
            DB.run(`UPDATE instagram_private_accounts SET state='disabled',sessionEncrypted=NULL WHERE businessId=?`, [first.id]);
            assert.strictEqual((await service.login(second.id, { ...credential, username: 'moved_account' })).state,
                'awaiting_inbound');
            assert.strictEqual(DB.get('SELECT businessId FROM instagram_private_account_claims WHERE accountId=?', ['1001']).businessId,
                second.id);
            assert.strictEqual(service.status(first.id).state, 'not_connected');
        });
    });

    it('holds the account claim while a reply is in flight', async () => {
        await withPrivate(async () => {
            createTestDB();
            const first = await DB.createInstance({ name: 'First' });
            const second = await DB.createInstance({ name: 'Second' });
            let release;
            let started;
            const begun = new Promise(resolve => { started = resolve; });
            const service = new PrivateInstagramService(async request => {
                if (request.action === 'reply') {
                    started();
                    await new Promise(resolve => { release = resolve; });
                }
                return runner(request);
            });
            await service.login(first.id, credential);
            await service.poll(first.id, true);
            const reply = service.reply(first.id, 'igp:1001:2001', 'Manual reply');
            await begun;
            assert.throws(() => service.disconnect(first.id),
                cause => cause.code === 'INSTAGRAM_PRIVATE_OPERATION_IN_PROGRESS');
            await assert.rejects(service.login(second.id, credential),
                cause => cause.code === 'INSTAGRAM_PRIVATE_ACCOUNT_BOUND');
            release();
            await reply;
            assert.strictEqual(service.disconnect(first.id).state, 'not_connected');
            assert.strictEqual((await service.login(second.id, credential)).state, 'awaiting_inbound');
        });
    });

    it('does not acknowledge disconnect while login is in flight', async () => {
        await withPrivate(async () => {
            createTestDB();
            const business = await DB.createInstance({ name: 'First' });
            let release;
            let started;
            const begun = new Promise(resolve => { started = resolve; });
            const service = new PrivateInstagramService(async request => {
                if (request.action === 'login') {
                    started();
                    await new Promise(resolve => { release = resolve; });
                }
                return runner(request);
            });
            const login = service.login(business.id, credential);
            await begun;
            assert.throws(() => service.disconnect(business.id),
                cause => cause.code === 'INSTAGRAM_PRIVATE_OPERATION_IN_PROGRESS');
            release();
            assert.strictEqual((await login).state, 'awaiting_inbound');
            assert.strictEqual(service.disconnect(business.id).state, 'not_connected');
        });
    });

    it('pauses polling on challenge or rate limit without logging provider text', async () => {
        await withPrivate(async () => {
            createTestDB();
            const business = await DB.createInstance({ name: 'Separate' });
            let calls = 0;
            const service = new PrivateInstagramService(async request => {
                if (request.action === 'poll') {
                    calls++;
                    throw Object.assign(new Error('secret upstream response'), { code: 'INSTAGRAM_PRIVATE_RATE_LIMITED' });
                }
                return runner(request);
            });
            await service.login(business.id, credential);
            await assert.rejects(service.poll(business.id, true), cause =>
                cause.code === 'INSTAGRAM_PRIVATE_RATE_LIMITED' && !cause.message.includes('secret upstream'));
            assert.strictEqual(service.status(business.id).state, 'paused');
            assert.strictEqual((await service.poll(business.id, true)).skipped, true);
            assert.strictEqual(calls, 1);
        });
    });

    it('limits login attempts per business without blocking the first 2FA retry', async () => {
        await withPrivate(async () => {
            createTestDB();
            const first = await DB.createInstance({ name: 'First' });
            const second = await DB.createInstance({ name: 'Second' });
            let calls = 0;
            const service = new PrivateInstagramService(async () => {
                calls++;
                throw Object.assign(new Error('provider secret'), { code: 'INSTAGRAM_PRIVATE_TWO_FACTOR_REQUIRED' });
            });
            for (let attempt = 0; attempt < 5; attempt++) {
                await assert.rejects(service.login(first.id, { ...credential, code: attempt ? '123456' : undefined }),
                    cause => cause.code === 'INSTAGRAM_PRIVATE_TWO_FACTOR_REQUIRED' && !cause.message.includes('provider secret'));
            }
            await assert.rejects(service.login(first.id, credential),
                cause => cause.code === 'INSTAGRAM_PRIVATE_LOGIN_COOLDOWN' && cause.statusCode === 429);
            assert.strictEqual(calls, 5);
            await assert.rejects(service.login(second.id, credential),
                cause => cause.code === 'INSTAGRAM_PRIVATE_TWO_FACTOR_REQUIRED');
            assert.strictEqual(calls, 6);
        });
    });

    it('returns a safe challenge code and delays another login attempt', async () => {
        await withPrivate(async () => {
            createTestDB();
            const business = await DB.createInstance({ name: 'Challenge' });
            let calls = 0;
            const service = new PrivateInstagramService(async () => {
                calls++;
                throw Object.assign(new Error('provider challenge details'), {
                    code: 'INSTAGRAM_PRIVATE_CHALLENGE_REQUIRED', statusCode: 409,
                });
            });
            await assert.rejects(service.login(business.id, credential), cause =>
                cause.code === 'INSTAGRAM_PRIVATE_CHALLENGE_REQUIRED' &&
                cause.statusCode === 409 && !cause.message.includes('provider challenge details'));
            await assert.rejects(service.login(business.id, credential), cause =>
                cause.code === 'INSTAGRAM_PRIVATE_LOGIN_COOLDOWN' && cause.statusCode === 429);
            assert.strictEqual(calls, 1);
        });
    });

    it('blocks immediate retry after provider rate limit and concurrent login', async () => {
        await withPrivate(async () => {
            createTestDB();
            const business = await DB.createInstance({ name: 'Separate' });
            let release;
            let calls = 0;
            const service = new PrivateInstagramService(async () => {
                calls++;
                await new Promise(resolve => { release = resolve; });
                throw Object.assign(new Error('provider secret'), { code: 'INSTAGRAM_PRIVATE_RATE_LIMITED' });
            });
            const first = service.login(business.id, credential);
            await assert.rejects(service.login(business.id, credential),
                cause => cause.code === 'INSTAGRAM_PRIVATE_LOGIN_IN_PROGRESS' && cause.statusCode === 429);
            release();
            await assert.rejects(first, cause => cause.code === 'INSTAGRAM_PRIVATE_RATE_LIMITED');
            await assert.rejects(service.login(business.id, credential),
                cause => cause.code === 'INSTAGRAM_PRIVATE_LOGIN_COOLDOWN');
            assert.strictEqual(calls, 1);
        });
    });

    it('denies foreign-business requests before running the connector', async () => {
        await withPrivate(async () => {
            createTestDB();
            const business = await DB.createInstance({ name: 'Separate' });
            const previous = Identity.authorizeBusiness;
            let ownerRequired = false;
            Identity.authorizeBusiness = (_auth, _businessId, options) => {
                ownerRequired = options?.owner === true;
                throw Object.assign(new Error('forbidden'), { statusCode: 403, code: 'BUSINESS_ACCESS_DENIED' });
            };
            const layer = Routes.customerRouter.stack.find(item =>
                item.route?.path === '/businesses/:businessId/instagram-private/login');
            const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; },
                json(body) { this.body = body; return this; } };
            try {
                await layer.route.stack[0].handle({ auth: { userId: 'customer', platformRole: 'customer' },
                    params: { businessId: String(business.id) }, body: credential }, res);
                assert.strictEqual(res.statusCode, 403);
                assert.strictEqual(ownerRequired, true);
                assert.ok(!JSON.stringify(res.body).includes(credential.password));
            } finally { Identity.authorizeBusiness = previous; }
        });
    });

    it('sends a manual reply from the CRM conversation through the private connector only', async () => {
        await withPrivate(async () => {
            createTestDB();
            const first = await DB.createInstance({ name: 'First' });
            const second = await DB.createInstance({ name: 'Second' });
            let sends = 0;
            const service = new PrivateInstagramService(async request => {
                if (request.action === 'reply') sends++;
                return runner(request);
            });
            await service.login(first.id, credential);
            await service.poll(first.id, true);
            const privateConnector = require('../instagram_private/server');
            const previousReply = privateConnector.reply;
            Identity.ensureSchema();
            DB.run("INSERT INTO ava_users(id,subject,email,displayName) VALUES('instagram-private-qa','instagram-private-subject','instagram-private-qa@example.test','QA manager')");
            DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('instagram-private-qa',?,'manager')",[first.id]);
            DB.run("UPDATE clients SET assigneeUserId='instagram-private-qa' WHERE instanceId=? AND chatId='igp:1001:2001'",[first.id]);
            const actor=Identity.actor('instagram-private-qa'),token=Identity.createSession('instagram-private-subject','instagram-private-session');
            const previousAccess=process.env.AVA_CUSTOMER_ACCESS_ENABLED;
            process.env.AVA_CUSTOMER_ACCESS_ENABLED='true';
            privateConnector.reply = service.reply.bind(service);
            const request=(businessId,chatId,text)=>({params:{instanceId:String(businessId),chatId:encodeURIComponent(chatId)},auth:actor,headers:{cookie:'crm_session=ava2:'+token},body:{text},reauthorizeCustomerAction:()=>require('../src/services/sales-workspace.service').authorizeClientMutation(Identity.actor(actor.userId),businessId,chatId,{capability:'messages.send'})});
            const handler = apiRoutes.stack.find(layer =>
                layer.route?.path === '/clients/:instanceId/:chatId/send-message').route.stack[1].handle;
            const response = () => ({ statusCode: 200, body: null,
                status(code) { this.statusCode = code; return this; },
                json(body) { this.body = body; return this; } });
            try {
                const manual = { origin: 'authenticated_customer_reply', businessId: first.id };
                const chatId = 'igp:1001:2001';
                assert.strictEqual((await ChannelRouter.sendMessageDetailed(first.id, chatId,
                    'Automatic send', 'instagram')).error, 'instagram_manual_reply_required');
                assert.strictEqual((await ChannelRouter.sendMessageDetailed(first.id, chatId,
                    'Wrong provider', 'whatsapp', manual)).error, 'instagram_recipient_not_inbound');
                assert.strictEqual(sends, 0);
                const sent = response();
                await handler(request(first.id,chatId,'Manual reply'), sent);
                assert.strictEqual(sent.statusCode, 200);
                assert.deepStrictEqual(sent.body, { success: true });
                assert.strictEqual(sends, 1);
                assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM messages WHERE instanceId=? AND role='assistant'", [first.id]).n, 1);
                const denied = response();
                await handler(request(second.id,chatId,'Foreign reply'), denied);
                assert.strictEqual(denied.statusCode, 403);
                assert.strictEqual(sends, 1);
            } finally {
                privateConnector.reply = previousReply;
                if(previousAccess===undefined)delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;else process.env.AVA_CUSTOMER_ACCESS_ENABLED=previousAccess;
            }
        });
    });
});
