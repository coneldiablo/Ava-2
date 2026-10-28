'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Router = require('../src/services/channel-router.service');
const Context = require('../src/services/channel-context.service');
const Workspace = require('../src/services/ava-workspace.store');
const Canonical = require('../src/services/client-identity.service');
const Gateway = require('../src/services/whatsapp-gateway.service');
const OpenWa = require('../src/services/openwa.service');
const Green = require('../src/services/green-api.service');

function setup(channel = 'whatsapp') {
    createTestDB();
    DB.run("INSERT INTO instances(id,name,openWaSessionId,greenApiInstance,greenApiToken) VALUES(1,'One','fixture-session','fixture-instance','fixture-token'),(2,'Two',NULL,NULL,NULL)");
    DB.run('INSERT INTO clients(instanceId,chatId,senderName,preferredChannel,telegramChatId,emailAddress,vkUserId,maxUserId) VALUES(?,?,?,?,?,?,?,?)', [1, 'customer', 'Customer', channel, '900001', 'customer@example.test', '901', '902']);
    DB.run("INSERT INTO clients(instanceId,chatId,senderName,preferredChannel) VALUES(2,'customer','Other tenant','whatsapp')");
    Workspace.ensureSchema();
    Canonical.attach(1, 'customer', { kind: 'whatsapp', value: '79990000001@c.us' });
    Canonical.attach(1, 'customer', { kind: 'telegram', value: '900001' });
    Router.whatsappStateCache.clear();
    return Context.capture(1, 'customer');
}

async function whatsapp(fn) {
    const originals = { state: Gateway.getState, open: OpenWa.sendMessage, green: Green.sendMessage };
    const effects = { open: 0, green: 0 };
    Gateway.getState = async () => ({ success: true, effectiveState: 'authorized' });
    OpenWa.sendMessage = async () => { effects.open++; return { success: true, data: { idMessage: 'provider-ack' } }; };
    Green.sendMessage = async () => { effects.green++; return { success: true, data: { idMessage: 'fallback-ack' } }; };
    try { await fn(effects); }
    finally { Gateway.getState = originals.state; OpenWa.sendMessage = originals.open; Green.sendMessage = originals.green; Router.whatsappStateCache.clear(); }
}

describe('Channel canonical scope, dispatch guards and read-only reconciliation', () => {
    it('routes a verified alias to the canonical tenant customer and stores exact ACK evidence', async () => {
        setup();
        await whatsapp(async effects => {
            OpenWa.sendMessage = async (_url, _key, _session, recipient) => { effects.open++; assert.strictEqual(recipient, '79990000001@c.us'); return { success: true, data: { idMessage: 'exact-ack' } }; };
            const sent = await Router.sendMessageDetailed(1, 'tg_900001', 'Confirmed reply', 'whatsapp', { idempotencyKey: 'reply-one' });
            assert.strictEqual(sent.success, true);
            assert.strictEqual(effects.open, 1);
            assert.strictEqual(DB.get('SELECT chatId FROM messages WHERE id=?', [sent.stored_message_id]).chatId, 'customer');
            const evidence = await Router.reconcileMessage(1, 'tg_900001', { channel: 'whatsapp', idempotencyKey: 'reply-one' });
            assert.strictEqual(evidence.status, 'sent');
            assert.strictEqual(evidence.providerMessageId, 'exact-ack');
            assert.strictEqual(evidence.storedMessageId, sent.stored_message_id);
            assert.strictEqual((await Router.reconcileMessage(2, 'customer', { channel: 'whatsapp', providerMessageId: 'exact-ack' })).status, 'unknown');
            assert.strictEqual((await Router.reconcileMessage(1, 'customer', { channel: 'whatsapp', providerMessageId: 'wrong-ack', idempotencyKey: 'reply-one' })).status, 'unknown');
            assert.strictEqual(effects.open, 1);
        });
    });

    it('blocks manager takeover and inbound revision changes during awaited gateway preparation', async () => {
        for (const changed of ['human', 'inbound']) {
            setup();
            await whatsapp(async effects => {
                Gateway.getState = async () => {
                    await Promise.resolve();
                    if (changed === 'human') Workspace.setControl({ businessId: 1, chatId: 'customer', mode: 'human' });
                    else await DB.saveMessageWithChannel(1, 'tg_900001', 'Customer', 'New question', 'user', 'telegram');
                    return { success: true, effectiveState: 'authorized' };
                };
                const result = await Router.sendMessageDetailed(1, 'customer', 'Outdated reply');
                assert.strictEqual(result.success, false);
                assert.strictEqual(result.safeToRetry, true);
                assert.strictEqual(result.error, changed === 'human' ? 'WORKSPACE_HUMAN_CONTROL' : 'WORKSPACE_DIALOGUE_CHANGED');
                assert.strictEqual(effects.open + effects.green, 0);
            });
        }
    });

    it('revalidates the exact provider recipient after asynchronous preparation', async () => {
        setup();
        await whatsapp(async effects => {
            Gateway.getState = async () => {
                await Promise.resolve();
                DB.run("UPDATE client_aliases SET value='79990000002@c.us' WHERE instanceId=1 AND kind='whatsapp'");
                return { success: true, effectiveState: 'authorized' };
            };
            const result = await Router.sendMessageDetailed(1, 'customer', 'Should stay unsent');
            assert.strictEqual(result.error, 'WORKSPACE_DIALOGUE_CHANGED');
            assert.strictEqual(effects.open, 0);
        });
    });

    it('requires ownership of active sends and retains unknown fences even for their owner', () => {
        const before = setup();
        Workspace.beginAiSend({ businessId: 1, chatId: 'customer', sendId: 'first', revision: before.controlRevision });
        const own = Context.capture(1, 'customer');
        assert.throws(() => Context.assertCanSend(1, 'tg_900001', own), e => e.code === 'WORKSPACE_SEND_IN_PROGRESS');
        assert.strictEqual(Context.assertCanSend(1, 'tg_900001', own, { sendId: 'first' }).chatId, 'customer');
        assert.throws(() => Context.assertCanSend(2, 'customer', own, { sendId: 'first' }), e => e.code === 'WORKSPACE_DIALOGUE_CHANGED');
        Workspace.endAiSend({ businessId: 1, chatId: 'customer', sendId: 'first', status: 'unknown' });
        assert.throws(() => Context.assertCanSend(1, 'customer', Context.capture(1, 'customer'), { sendId: 'first' }), e => e.code === 'WORKSPACE_SEND_IN_PROGRESS');
    });

    it('preserves authenticated human authorization and reserves once across a proven-unsent fallback', async () => {
        setup();
        Workspace.setControl({ businessId: 1, chatId: 'customer', mode: 'human' });
        await whatsapp(async effects => {
            let authorizationChecks = 0;
            OpenWa.sendMessage = async () => { effects.open++; return { success: false, statusCode: 404 }; };
            const result = await Router.sendMessageDetailed(1, 'customer', 'Human reply', 'whatsapp', {
                origin: 'authenticated_customer_reply', businessId: 1, idempotencyKey: 'human-one',
                beforeSend: () => { authorizationChecks++; Workspace.beginHumanSend({ businessId: 1, chatId: 'customer', sendId: 'human-send' }); }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(authorizationChecks, 1);
            assert.deepStrictEqual(effects, { open: 1, green: 1 });
            assert.strictEqual(Context.capture(1, 'customer').activeSendId, 'human-send');
            Workspace.endAiSend({ businessId: 1, chatId: 'customer', sendId: 'human-send', status: 'sent' });
        });
    });

    it('never falls back or sends again after an unknown ACK and reconciliation leaves the fence intact', async () => {
        setup();
        await whatsapp(async effects => {
            OpenWa.sendMessage = async () => { effects.open++; throw new Error('fixture timeout'); };
            const result = await Router.sendMessageDetailed(1, 'customer', 'Unknown reply', 'whatsapp', { idempotencyKey: 'unknown-one' });
            assert.strictEqual(result.unknown, true);
            assert.strictEqual(result.safeToRetry, false);
            const control = Context.capture(1, 'customer');
            assert.strictEqual(control.activeSendStatus, 'unknown');
            assert.strictEqual((await Router.reconcileMessage(1, 'customer', { channel: 'whatsapp', idempotencyKey: 'unknown-one' })).status, 'unknown');
            assert.deepStrictEqual(Context.capture(1, 'customer'), control);
            assert.strictEqual((await Router.sendMessageDetailed(1, 'customer', 'Do not repeat')).success, false);
            assert.deepStrictEqual(effects, { open: 1, green: 0 });
        });
    });

    it('keeps confirmed success and evidence when local history persistence fails after provider ACK', async () => {
        setup();
        const save = DB.saveMessageWithChannel;
        await whatsapp(async effects => {
            DB.saveMessageWithChannel = async () => { throw new Error('fixture database failure'); };
            try {
                const result = await Router.sendMessageDetailed(1, 'customer', 'ACK already received', 'whatsapp', { idempotencyKey: 'history-repair' });
                assert.strictEqual(result.success, true);
                assert.strictEqual(result.stored_message_id, null);
                assert.strictEqual((await Router.reconcileMessage(1, 'customer', { channel: 'whatsapp', idempotencyKey: 'history-repair' })).status, 'sent');
                assert.strictEqual(effects.open, 1);
            } finally { DB.saveMessageWithChannel = save; }
        });
    });

    it('runs the shared guard inside email preparation and does not swallow a pre-provider conflict', async () => {
        setup('email');
        const Email = require('../src/services/email.service'), getInstance = DB.getInstance;
        let sends = 0, reads = 0;
        Email._transporters.set(1, { sendMail: async () => { sends++; } }); Email._verifiedSmtp.add(1);
        DB.getInstance = async id => {
            const result = await getInstance.call(DB, id);
            if (++reads === 2) Workspace.setControl({ businessId: 1, chatId: 'customer', mode: 'human' });
            return result;
        };
        try {
            const result = await Router.sendMessageDetailed(1, 'customer', 'Stale email', 'email');
            assert.strictEqual(result.error, 'WORKSPACE_HUMAN_CONTROL');
            assert.strictEqual(result.safeToRetry, true);
            assert.strictEqual(sends, 0);
        } finally { DB.getInstance = getInstance; Email._transporters.delete(1); Email._verifiedSmtp.delete(1); }
    });

    it('reads durable Telegram job acknowledgements by exact identity without sending or changing state', async () => {
        setup('telegram');
        const Jobs = require('../src/services/channel-jobs.store');
        const inbound = Jobs.enqueue({ instanceId: 1, chatId: 'customer', originChatId: 'tg_900001', channel: 'telegram', providerMessageId: '11', text: 'Question' }).job;
        const claimed = Jobs.claim({ instanceId: 1, channel: 'telegram' });
        Jobs.prepare(claimed, { reply: 'Reply' }); Jobs.markSending(claimed); Jobs.ack(claimed, { providerMessageId: '12' });
        const key = 'telegram-reply:' + inbound.id;
        assert.strictEqual((await Router.reconcileMessage(1, 'tg_900001', { channel: 'telegram', idempotencyKey: key })).status, 'sent');
        assert.strictEqual((await Router.reconcileMessage(1, 'customer', { channel: 'telegram', jobId: inbound.id })).providerMessageId, '12');
        assert.strictEqual((await Router.reconcileMessage(2, 'customer', { channel: 'telegram', idempotencyKey: key })).status, 'unknown');
        assert.strictEqual((await Router.reconcileMessage(1, 'customer', { channel: 'telegram', providerMessageId: '13' })).status, 'unknown');
        assert.strictEqual(Jobs.get({ instanceId: 1, id: inbound.id }).status, 'acknowledged');
    });

    it('requires exact evidence from optional read-only provider lookup and reports unsupported honestly', async () => {
        setup();
        const original = Gateway.reconcileMessage;
        let lookups = 0;
        Gateway.reconcileMessage = async (instance, recipient, query) => {
            lookups++; assert.strictEqual(instance.id, 1); assert.strictEqual(recipient, '79990000001@c.us');
            return { status: 'delivered', providerMessageId: query.providerMessageId };
        };
        try {
            assert.strictEqual((await Router.reconcileMessage(1, 'customer', { channel: 'whatsapp', providerMessageId: 'lookup-ack' })).status, 'sent');
            Gateway.reconcileMessage = async () => ({ status: 'sent', providerMessageId: 'other-message' });
            assert.strictEqual((await Router.reconcileMessage(1, 'customer', { channel: 'whatsapp', providerMessageId: 'lookup-ack' })).status, 'unknown');
            assert.strictEqual(lookups, 1);
        } finally { if (original) Gateway.reconcileMessage = original; else delete Gateway.reconcileMessage; }
        assert.strictEqual((await Router.reconcileMessage(1, 'customer', { channel: 'email', providerMessageId: 'missing' })).reason, 'adapter_reconciliation_unsupported');
        assert.strictEqual(Router.getCapabilities('telegram').durableInbound, true);
        assert.strictEqual(Router.getCapabilities('telegram').autopilot, false);
        assert.strictEqual(Router.getCapabilities('email').providerLookup, false);
    });
});
