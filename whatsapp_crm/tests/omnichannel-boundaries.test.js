const http = require('http');
const express = require('express');
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const ChannelRouter = require('../src/services/channel-router.service');
const SmartTriggers = require('../src/services/smart-triggers.service');
const SequenceService = require('../src/services/sequence.service');
const apiRoutes = require('../src/routes/api.routes');

async function withApi(test) {
    const app = express();
    app.use(express.json());
    app.use('/api', apiRoutes);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const request = async (method, path, body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
            method, headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: response.status, body: await response.json() };
    };
    try { await test(request); } finally { await new Promise(resolve => server.close(resolve)); }
}

describe('Omnichannel and automation boundaries', () => {
    it('rejects Instagram automation without falling through to WhatsApp', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Channel boundary' });
        const client = await DB.getOrCreateClient(instance.id, 'instagram-fixture', 'Fixture');
        await DB.updateClientChannel(instance.id, client.chatId, 'instagram');
        const original = ChannelRouter._sendWhatsAppDetailed;
        let whatsappDispatches = 0;
        ChannelRouter._sendWhatsAppDetailed = async () => { whatsappDispatches++; return { success: true, channel: 'whatsapp' }; };
        try {
            const result = await ChannelRouter.sendMessageDetailed(instance.id, client.chatId, 'test', 'instagram');
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.channel, 'instagram');
            assert.strictEqual(result.error, 'instagram_manual_reply_required');
            assert.strictEqual(result.safeToRetry, true);
            const missing = await ChannelRouter.sendMessageDetailed(instance.id, 'missing-client', 'test', 'instagram');
            assert.strictEqual(missing.success, false);
            assert.strictEqual(missing.channel, 'instagram');
            assert.strictEqual(missing.error, 'WORKSPACE_CLIENT_NOT_FOUND');
            assert.strictEqual(missing.safeToRetry, true);
            assert.strictEqual(missing.unknown, false);
            assert.strictEqual(whatsappDispatches, 0);
        } finally { ChannelRouter._sendWhatsAppDetailed = original; }
    });

    it('reports a running connector when the API supplies a string business id', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Status id type' });
        const TelegramService = require('../src/services/telegram.service');
        TelegramService._bots.set(instance.id, { stopPolling: async () => {} });
        try {
            const status = await ChannelRouter.getChannelStatus(String(instance.id));
            assert.strictEqual(status.telegram, true);
        } finally { TelegramService._bots.delete(instance.id); }
    });

    it('does not report Telegram, VK or MAX connected when provider verification fails', async () => {
        const previousKey = process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
        process.env.CHANNEL_CREDENTIALS_MASTER_KEY = '22'.repeat(32);
        const TelegramService = require('../src/services/telegram.service');
        const VkService = require('../src/services/vk.service');
        const MaxService = require('../src/services/max.service');
        const oldTelegram = TelegramService._TelegramBot;
        const oldVk = VkService._VkBot;
        const oldMaxGet = MaxService._apiGet;
        let started = 0;
        try {
            createTestDB();
            const instance = await DB.createInstance({ name: 'Invalid credentials' });
            await DB.updateInstance(instance.id, { telegramBotToken: 'bad-telegram', vkGroupToken: 'bad-vk', maxBotToken: 'bad-max' });
            TelegramService._TelegramBot = class {
                on() {} async getMe() { throw new Error('invalid token'); }
                startPolling() { started++; } async stopPolling() {}
            };
            VkService._VkBot = class {
                on() {} async getGroupInfo() { throw new Error('invalid token'); }
                startPolling() { started++; } stop() {}
            };
            MaxService._apiGet = async () => { throw new Error('invalid token'); };
            assert.strictEqual(await TelegramService.restartBot(instance.id), false);
            assert.strictEqual(await VkService.restartBot(instance.id), false);
            assert.strictEqual(await MaxService.restartBot(instance.id), false);
            assert.strictEqual(started, 0);
            const status = await ChannelRouter.getChannelStatus(String(instance.id));
            assert.strictEqual(status.telegram, false);
            assert.strictEqual(status.vk, false);
            assert.strictEqual(status.max, false);
        } finally {
            TelegramService._TelegramBot = oldTelegram;
            VkService._VkBot = oldVk;
            MaxService._apiGet = oldMaxGet;
            if (previousKey === undefined) delete process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
            else process.env.CHANNEL_CREDENTIALS_MASTER_KEY = previousKey;
        }
    });

    it('rejects bad replacement credentials without changing saved secrets or working pollers', async () => {
        const previousKey = process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
        process.env.CHANNEL_CREDENTIALS_MASTER_KEY = '33'.repeat(32);
        const TelegramService = require('../src/services/telegram.service');
        const VkService = require('../src/services/vk.service');
        const MaxService = require('../src/services/max.service');
        const oldTelegram = TelegramService._TelegramBot;
        const oldVk = VkService._VkBot;
        const oldMaxGet = MaxService._apiGet;
        let telegramStops = 0;
        let vkStops = 0;
        try {
            createTestDB();
            const instance = await DB.createInstance({ name: 'Keep working channel' });
            await DB.updateInstance(instance.id, {
                telegramBotToken: 'good-telegram', vkGroupToken: 'good-vk',
                vkGroupId: '1', maxBotToken: 'good-max'
            });
            const telegramBot = { stopPolling: async () => { telegramStops++; } };
            const vkBot = { stop: () => { vkStops++; } };
            const maxPoller = { active: true, timeout: null };
            TelegramService._bots.set(instance.id, telegramBot);
            VkService._bots.set(instance.id, vkBot);
            MaxService._pollers.set(instance.id, maxPoller);
            TelegramService._TelegramBot = class {
                on() {} async getMe() { throw new Error('invalid token'); }
                startPolling() { throw new Error('must not start'); }
            };
            VkService._VkBot = class {
                on() {} async getGroupInfo() { throw new Error('invalid token'); }
                startPolling() { throw new Error('must not start'); }
            };
            MaxService._apiGet = async () => { throw new Error('invalid token'); };
            await withApi(async request => {
                for (const body of [
                    { telegramBotToken: 'bad-telegram' },
                    { vkGroupToken: 'bad-vk' },
                    { maxBotToken: 'bad-max' }
                ]) {
                    const result = await request('PUT', `/channels/${instance.id}/config`, body);
                    assert.strictEqual(result.status, 400);
                    assert.deepStrictEqual(result.body, { success: false, error: 'channel_credentials_invalid' });
                }
            });
            const saved = await DB.getInstance(instance.id);
            assert.strictEqual(saved.telegramBotToken, 'good-telegram');
            assert.strictEqual(saved.vkGroupToken, 'good-vk');
            assert.strictEqual(saved.maxBotToken, 'good-max');
            assert.strictEqual(await TelegramService.restartBot(instance.id), false);
            assert.strictEqual(await VkService.restartBot(instance.id), false);
            assert.strictEqual(await MaxService.restartBot(instance.id), false);
            assert.strictEqual(TelegramService._bots.get(instance.id), telegramBot);
            assert.strictEqual(VkService._bots.get(instance.id), vkBot);
            assert.strictEqual(MaxService._pollers.get(instance.id), maxPoller);
            assert.strictEqual(telegramStops, 0);
            assert.strictEqual(vkStops, 0);
        } finally {
            TelegramService._bots.clear();
            VkService._bots.clear();
            MaxService._pollers.clear();
            TelegramService._TelegramBot = oldTelegram;
            VkService._VkBot = oldVk;
            MaxService._apiGet = oldMaxGet;
            if (previousKey === undefined) delete process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
            else process.env.CHANNEL_CREDENTIALS_MASTER_KEY = previousKey;
        }
    });

    it('persists valid replacement credentials and switches verified pollers', async () => {
        const previousKey = process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
        process.env.CHANNEL_CREDENTIALS_MASTER_KEY = '44'.repeat(32);
        const TelegramService = require('../src/services/telegram.service');
        const VkService = require('../src/services/vk.service');
        const MaxService = require('../src/services/max.service');
        const oldTelegram = TelegramService._TelegramBot;
        const oldVk = VkService._VkBot;
        const oldMaxGet = MaxService._apiGet;
        const oldMaxLoop = MaxService._pollLoop;
        const stops = { telegram: 0, vk: 0 };
        const started = { telegram: 0, vk: 0, max: 0 };
        try {
            createTestDB();
            const instance = await DB.createInstance({ name: 'Valid channel replacement' });
            await DB.updateInstance(instance.id, {
                telegramBotToken: 'old-telegram', vkGroupToken: 'old-vk',
                vkGroupId: '1', maxBotToken: 'old-max'
            });
            const oldTelegramBot = { stopPolling: async () => { stops.telegram++; } };
            const oldVkBot = { stop: () => { stops.vk++; } };
            const oldMaxPoller = { active: true, timeout: null };
            TelegramService._bots.set(instance.id, oldTelegramBot);
            VkService._bots.set(instance.id, oldVkBot);
            MaxService._pollers.set(instance.id, oldMaxPoller);
            TelegramService._TelegramBot = class {
                constructor(token) { this.token = token; }
                on() {}
                async getMe() { return { username: 'verified_telegram' }; }
                startPolling() { started.telegram++; }
                async stopPolling() {}
            };
            VkService._VkBot = class {
                constructor(options) { this.token = options.token; }
                on() {}
                async getGroupInfo() { return { name: 'Verified VK' }; }
                startPolling() { started.vk++; }
                stop() {}
            };
            MaxService._apiGet = async () => ({ name: 'Verified MAX', username: 'verified_max' });
            MaxService._pollLoop = async () => { started.max++; };
            await withApi(async request => {
                for (const body of [
                    { telegramBotToken: 'new-telegram' },
                    { vkGroupToken: 'new-vk' },
                    { maxBotToken: 'new-max' }
                ]) {
                    const result = await request('PUT', `/channels/${instance.id}/config`, body);
                    assert.strictEqual(result.status, 200);
                    assert.strictEqual(result.body.success, true);
                    assert.strictEqual(JSON.stringify(result.body).includes(Object.values(body)[0]), false);
                }
            });
            const saved = await DB.getInstance(instance.id);
            assert.strictEqual(saved.telegramBotToken, 'new-telegram');
            assert.strictEqual(saved.vkGroupToken, 'new-vk');
            assert.strictEqual(saved.maxBotToken, 'new-max');
            assert.strictEqual(stops.telegram, 0);
            assert.strictEqual(stops.vk, 0);
            assert.strictEqual(oldMaxPoller.active, true);
            assert.strictEqual(await TelegramService.restartBot(instance.id), true);
            assert.strictEqual(await VkService.restartBot(instance.id), true);
            assert.strictEqual(await MaxService.restartBot(instance.id), true);
            assert.strictEqual(stops.telegram, 1);
            assert.strictEqual(stops.vk, 1);
            assert.strictEqual(oldMaxPoller.active, false);
            assert.strictEqual(TelegramService._bots.get(instance.id).token, 'new-telegram');
            assert.strictEqual(VkService._bots.get(instance.id).token, 'new-vk');
            assert.notStrictEqual(MaxService._pollers.get(instance.id), oldMaxPoller);
            assert.deepStrictEqual(started, { telegram: 1, vk: 1, max: 1 });
        } finally {
            TelegramService._bots.clear();
            VkService._bots.clear();
            MaxService._pollers.clear();
            TelegramService._TelegramBot = oldTelegram;
            VkService._VkBot = oldVk;
            MaxService._apiGet = oldMaxGet;
            MaxService._pollLoop = oldMaxLoop;
            if (previousKey === undefined) delete process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
            else process.env.CHANNEL_CREDENTIALS_MASTER_KEY = previousKey;
        }
    });

    it('does not log a trigger when delivery fails, and cannot attach a foreign sequence', async () => {
        createTestDB();
        const own = await DB.createInstance({ name: 'Own trigger' });
        const foreign = await DB.createInstance({ name: 'Foreign sequence' });
        const client = await DB.getOrCreateClient(own.id, '79990001008@c.us', 'Test');
        const trigger = await DB.createTrigger(own.id, { name: 'Reply', triggerType: 'keyword',
            actionType: 'send_message', actionData: { message: 'Hello' } });
        const previous = SmartTriggers._channelRouter;
        SmartTriggers._channelRouter = { sendMessage: async () => false };
        try {
            await SmartTriggers._executeAction(own, client, trigger, { message: 'Hello' });
            assert.strictEqual(await DB.getTriggerExecutionCount(own.id, client.chatId, trigger.id), 0);
            const sequence = await DB.createSequence(foreign.id, { name: 'Foreign' });
            await SmartTriggers._executeAction(own, client, { ...trigger, actionType: 'start_sequence' },
                { sequenceId: sequence.id });
            assert.strictEqual(DB.get('SELECT COUNT(*) AS count FROM client_sequences').count, 0);
        } finally { SmartTriggers._channelRouter = previous; }
    });

    it('keeps keyword triggers and sequence delivery off until the owner enables automation', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Disabled automation' });
        const client = await DB.getOrCreateClient(instance.id, '79990001008@c.us', 'Test');
        await DB.createTrigger(instance.id, { name: 'Reply', triggerType: 'keyword',
            conditions: { keywords: ['hello'] }, actionType: 'send_message', actionData: { message: 'Hi' } });
        const sequence = await DB.createSequence(instance.id, { name: 'Follow-up' });
        await DB.addSequenceStep(sequence.id, { stepOrder: 1, delayMinutes: 0, messageTemplate: 'Follow-up' });
        DB.run("INSERT INTO client_sequences(instanceId,chatId,sequenceId,currentStep,status,nextStepAt) VALUES (?,?,?,0,'active',datetime('now','-1 minute'))",
            [instance.id, client.chatId, sequence.id]);
        const item = (await DB.getActiveClientSequences())[0];
        const previousTriggerRouter = SmartTriggers._channelRouter;
        const previousSequenceRouter = SequenceService._channelRouter;
        let sends = 0;
        SmartTriggers._channelRouter = SequenceService._channelRouter = {
            sendMessage: async () => { sends++; return false; },
        };
        try {
            await SmartTriggers.checkKeywordTriggers(instance.id, client.chatId, 'hello');
            await SequenceService._processSequenceStep(item);
            assert.strictEqual(sends, 0);
            await DB.updateInstance(instance.id, { smartTriggersEnabled: 1 });
            await SmartTriggers.checkKeywordTriggers(instance.id, client.chatId, 'hello');
            await SequenceService._processSequenceStep(item);
            assert.strictEqual(sends, 2);
            assert.strictEqual(DB.get('SELECT currentStep FROM client_sequences WHERE id = ?', [item.id]).currentStep, 0,
                'failed send must not complete a sequence step');
        } finally {
            SmartTriggers._channelRouter = previousTriggerRouter;
            SequenceService._channelRouter = previousSequenceRouter;
        }
    });

    it('leases due sequence steps stored with ISO timestamps and honors zero-minute first delay', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Sequence due time' });
        const sequence = await DB.createSequence(instance.id, { name: 'Now' });
        await DB.addSequenceStep(sequence.id, { stepOrder: 1, delayMinutes: 0, messageTemplate: 'Hello' });
        const assigned = await DB.assignClientToSequence(instance.id, '79990001008@c.us', sequence.id);
        assert.ok((await DB.getActiveClientSequences()).some(item => item.id === assigned.id));
        await DB.updateClientSequence(assigned.id, { nextStepAt: new Date(Date.now() - 60000).toISOString() });
        assert.ok((await DB.getActiveClientSequences()).some(item => item.id === assigned.id),
            'ISO timestamp must be comparable with the SQLite clock');
        const other = await DB.createInstance({ name: 'Other' });
        await assert.rejects(() => DB.assignClientToSequence(other.id, '79990001008@c.us', sequence.id),
            /does not belong to business/);
    });

    it('rejects cross-business trigger and sequence mutations', async () => {
        createTestDB();
        const own = await DB.createInstance({ name: 'Own scope' });
        const foreign = await DB.createInstance({ name: 'Foreign scope' });
        const trigger = await DB.createTrigger(foreign.id, { name: 'Foreign trigger', triggerType: 'keyword',
            actionType: 'send_message', actionData: { message: 'Hi' } });
        const sequence = await DB.createSequence(foreign.id, { name: 'Foreign sequence' });
        const step = await DB.addSequenceStep(sequence.id, { messageTemplate: 'Hi' });
        await withApi(async request => {
            assert.strictEqual((await request('PUT', `/triggers/${own.id}/${trigger.id}`, { name: 'Hijacked' })).status, 404);
            assert.strictEqual((await request('DELETE', `/triggers/${own.id}/${trigger.id}`)).status, 404);
            assert.strictEqual((await request('PUT', `/sequences/${own.id}/${sequence.id}`, { name: 'Hijacked' })).status, 404);
            assert.strictEqual((await request('DELETE', `/sequences/${own.id}/${sequence.id}`)).status, 404);
            assert.strictEqual((await request('GET', `/sequences/${own.id}/${sequence.id}/steps`)).status, 404);
            assert.strictEqual((await request('PUT', `/sequences/${own.id}/${sequence.id}/steps/${step.id}`, { messageTemplate: 'Hijacked' })).status, 404);
            assert.strictEqual((await request('DELETE', `/sequences/${own.id}/${sequence.id}/steps/${step.id}`)).status, 404);
        });
        assert.strictEqual((await DB.getTrigger(trigger.id)).name, 'Foreign trigger');
        assert.strictEqual((await DB.getSequence(sequence.id)).name, 'Foreign sequence');
    });

    it('saves only approved connector fields and never returns credentials', async () => {
        const previous = process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
        process.env.CHANNEL_CREDENTIALS_MASTER_KEY = '11'.repeat(32);
        try {
            createTestDB();
            const instance = await DB.createInstance({ name: 'Config scope' });
            await withApi(async request => {
                const invalid = await request('PUT', `/channels/${instance.id}/config`, { greenApiToken: 'forbidden' });
                assert.strictEqual(invalid.status, 400);
                const saved = await request('PUT', `/channels/${instance.id}/config`, { telegramBotToken: 'test-secret' });
                assert.strictEqual(saved.status, 200);
                assert.strictEqual(JSON.stringify(saved.body).includes('test-secret'), false);
                assert.strictEqual((await request('PUT', `/triggers/${instance.id}/settings`,
                    { smartTriggersEnabled: true })).status, 200);
            });
            assert.strictEqual((await DB.getInstance(instance.id)).telegramBotToken, 'test-secret');
            assert.strictEqual((await DB.getInstance(instance.id)).smartTriggersEnabled, 1);
            assert.notStrictEqual(DB.get('SELECT telegramBotToken FROM instances WHERE id = ?', [instance.id]).telegramBotToken, 'test-secret');
            await withApi(async request => {
                const disconnected = await request('DELETE', `/channels/${instance.id}/telegram`);
                assert.strictEqual(disconnected.status, 200);
                assert.strictEqual(disconnected.body.success, true);
                assert.strictEqual((await DB.getInstance(instance.id)).telegramBotToken, '');
            });
        } finally {
            if (previous === undefined) delete process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
            else process.env.CHANNEL_CREDENTIALS_MASTER_KEY = previous;
        }
    });

    it('validates automation inputs and preserves an explicit zero cooldown', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Automation validation' });
        const foreign = await DB.createInstance({ name: 'Foreign automation' });
        const foreignSequence = await DB.createSequence(foreign.id, { name: 'Foreign' });
        await withApi(async request => {
            const base = { name: 'Follow-up', triggerType: 'keyword', actionType: 'send_message',
                conditions: { keywords: ['hello'] }, actionData: { message: 'Hello' } };
            assert.strictEqual((await request('POST', `/triggers/${instance.id}`,
                { ...base, triggerType: 'unknown' })).status, 400);
            assert.strictEqual((await request('POST', `/triggers/${instance.id}`,
                { ...base, actionType: 'start_sequence', actionData: { sequenceId: foreignSequence.id } })).status, 400);
            const created = await request('POST', `/triggers/${instance.id}`, { ...base, cooldownMinutes: 0 });
            assert.strictEqual(created.status, 200);
            assert.strictEqual(created.body.trigger.cooldownMinutes, 0);
            const sequence = await request('POST', `/sequences/${instance.id}`, { name: 'Own' });
            assert.strictEqual(sequence.status, 200);
            assert.strictEqual((await request('POST', `/sequences/${instance.id}/${sequence.body.sequence.id}/steps`,
                { messageTemplate: 'Hi', delayMinutes: -1 })).status, 400);
        });
    });
});
