const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Handoff = require('../src/services/whatsapp-handoff.service');
const WhatsApp = require('../src/services/whatsapp.service');
const AI = require('../src/services/ai.service');
const RAG = require('../src/services/rag.service');
const Onyx = require('../src/services/onyx-knowledge.service');
const PMS = require('../src/services/pms/pms-intent.service');
const Push = require('../src/services/push.service');

async function seed() {
    createTestDB();
    const business = await DB.createInstance({ name: 'Handoff Hotel', isActive: 1 });
    const chatId = '79990000001@c.us';
    await DB.getOrCreateClient(business.id, chatId, 'Guest');
    await DB.saveMessage(business.id, chatId, 'Guest', 'Позовите менеджера', 'user');
    const [message] = await DB.getClientHistory(business.id, chatId, 1);
    DB.run("INSERT INTO twenty_workspace_links(id,businessId,baseUrl,apiKeyEncrypted,enabled) VALUES('test',?,'https://twenty.test','test',1)", [business.id]);
    return { businessId: business.id, chatId, sourceMessageId: message.id, text: 'Позовите менеджера password=private-value' };
}

describe('WhatsApp durable manager handoff', () => {
    it('creates one scoped task, event, audit and Twenty job across replay', async () => {
        const input = await seed();
        const first = Handoff.create(input);
        const second = Handoff.create(input);
        assert.ok(first.created && !second.created);
        assert.strictEqual(first.task.taskId, second.task.taskId);
        assert.strictEqual(first.task.phone, '79990000001');
        assert.ok(first.task.customerId && first.task.conversationEventId);
        assert.ok(!first.task.summary.includes('private-value'));
        for (const table of ['manager_tasks', 'conversation_events', 'tool_runs']) {
            assert.strictEqual(DB.get(`SELECT COUNT(*) AS n FROM ${table}`).n, 1);
        }
        assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM twenty_sync_outbox WHERE sourceTable='manager_tasks'").n, 1);
    });

    it('rejects another business message or paused business without any writes', async () => {
        const input = await seed();
        const second = await DB.createInstance({ name: 'Other Hotel', isActive: 1 });
        await DB.getOrCreateClient(second.id, input.chatId, 'Other Guest');
        assert.throws(() => Handoff.create({ ...input, businessId: second.id }), /SCOPE_INVALID/);
        DB.run('UPDATE instances SET isActive=0 WHERE id=?', [input.businessId]);
        assert.throws(() => Handoff.create(input), /SCOPE_INVALID/);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM manager_tasks').n, 0);
    });

    it('rolls back task, event and Twenty enqueue when audit write fails', async () => {
        const input = await seed();
        const original = DB.createToolRun;
        DB.createToolRun = () => { throw new Error('simulated disk failure'); };
        try { assert.throws(() => Handoff.create(input), /simulated disk failure/); }
        finally { DB.createToolRun = original; }
        for (const table of ['manager_tasks', 'conversation_events', 'twenty_sync_outbox']) {
            assert.strictEqual(DB.get(`SELECT COUNT(*) AS n FROM ${table}`).n, 0);
        }
    });

    it('real WhatsApp processing acknowledges only durable task; failed storage is not claimed as handoff', async () => {
        const input = await seed();
        const original = { ai: AI.getResponse, rag: RAG.buildConversationContext, onyx: Onyx.answer,
            pms: PMS.handle, push: Push.notifyHumanHelp, send: WhatsApp._sendMessage, create: Handoff.create };
        const sent = [];
        let pushes = 0;
        AI.getResponse = async () => ({ reply: 'Обещание модели', action: 'human_help' });
        RAG.buildConversationContext = async () => ({ context: '', searched: true });
        Onyx.answer = async () => null;
        PMS.handle = async () => ({ handled: false });
        Push.notifyHumanHelp = async () => { pushes++; throw new Error('push outage'); };
        WhatsApp._sendMessage = async (_, __, text) => sent.push(text);
        try {
            const batch = { text: input.text };
            await WhatsApp._processBatch(input.businessId, input.chatId, batch, { isStale: () => false });
            await WhatsApp._processBatch(input.businessId, input.chatId, batch, { isStale: () => false });
            assert.ok(sent.every(text => text.startsWith('Передал ваше обращение')));
            assert.strictEqual(pushes, 1);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM manager_tasks').n, 1);
            Handoff.create = () => { throw new Error('disk full'); };
            await WhatsApp._processBatch(input.businessId, input.chatId, batch, { isStale: () => false });
            assert.ok(sent[2].startsWith('Не удалось передать'));
        } finally {
            AI.getResponse = original.ai; RAG.buildConversationContext = original.rag; Onyx.answer = original.onyx;
            PMS.handle = original.pms; Push.notifyHumanHelp = original.push; WhatsApp._sendMessage = original.send;
            Handoff.create = original.create;
        }
    });
});
