const axios = require('axios');
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Onyx = require('../src/services/onyx-knowledge.service');
const SalesBrain = require('../src/services/sales-brain.service');
const RAG = require('../src/services/rag.service');
const AI = require('../src/services/ai.service');
const WhatsApp = require('../src/services/whatsapp.service');
const PMS = require('../src/services/pms/pms-intent.service');
const Logger = require('../src/utils/logger');


async function withProvider(fn) {
    createTestDB();
    const a = await DB.createInstance({ name: 'Alpha', isActive: 1 });
    const b = await DB.createInstance({ name: 'Beta', isActive: 1 });
    const original = axios.post;
    const env = { token: process.env.CRM_SERVICE_API_TOKEN, url: process.env.AVA_ADMIN_API_URL };
    process.env.CRM_SERVICE_API_TOKEN = 'test-service-token';
    process.env.AVA_ADMIN_API_URL = 'http://admin.test:3003';
    const calls = [];
    axios.post = async (url, body, config) => {
        calls.push({ url, body, config });
        return { data: { ...body, preview: false, stale: false, handled: true, grounded: true,
            customer_context_provided: Boolean(body.customer_id),
            answer: `Отель ${body.business_id}: заезд в 15:00.`, citations: [{ source_id: body.business_id }] } };
    };
    try { await fn({ a, b, calls }); }
    finally {
        axios.post = original;
        for (const [key, value] of [['CRM_SERVICE_API_TOKEN', env.token], ['AVA_ADMIN_API_URL', env.url]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
}

describe('Onyx real knowledge routing', () => {
    it('resolves the same phone separately per business; voice does not wait on Onyx', async () => withProvider(async ({ a, b, calls }) => {
        const chat = '79990000001@c.us';
        await DB.saveMessage(a.id, chat, 'Alpha', 'Alpha message', 'user');
        await DB.saveMessage(b.id, chat, 'Beta', 'Beta message', 'user');
        await DB.saveMessage(a.id, '79990000002@c.us', 'Another', 'Other message', 'user');
        const alpha = await DB.getOrCreateClient(a.id, chat, 'Alpha');
        const beta = await DB.getOrCreateClient(b.id, chat, 'Beta');
        await DB.getOrCreateClient(a.id, '79990000002@c.us', 'Another');
        const first = await Onyx.answer({ businessId: a.id, question: 'Заезд?', channel: 'whatsapp', chatId: chat,
            customerId: beta.id, customer_context: { history: 'RAW_PRIVATE' } });
        const second = await Onyx.answer({ businessId: b.id, question: 'Заезд?', channel: 'whatsapp', chatId: chat });
        assert.strictEqual(first.customer_id, alpha.id);
        assert.strictEqual(second.customer_id, beta.id);
        await SalesBrain.answerFromKnowledge({ instanceId: a.id, question: 'Заезд?', channel: 'voice',
            callerNumber: '+79990000001', chatId: '79990000002@c.us', callId: 'current-call' });
        assert.strictEqual(calls.length, 2);
        assert.ok(!JSON.stringify(calls).includes('RAW_PRIVATE'));
        assert.ok(!JSON.stringify(calls).includes('Alpha message'));
        const baseline = axios.post;
        axios.post = async (...args) => ({ data: { ...(await baseline(...args)).data, customer_id: beta.id } });
        assert.strictEqual(await Onyx.answer({ businessId: a.id, question: 'Заезд?', channel: 'whatsapp', chatId: chat }), null);
    }));

    it('pins server tenant and sends no caller-supplied credentials/history', async () => withProvider(async ({ a, b, calls }) => {
        const first = await Onyx.answer({ businessId: a.id, question: 'Заезд?', channel: 'whatsapp',
            preview: true, instance_id: b.id, url: 'https://evil.test', token: 'evil', customerContext: 'private' });
        const second = await Onyx.answer({ businessId: b.id, question: 'Заезд?', channel: 'voice' });
        assert.strictEqual(second, null);
        assert.strictEqual(calls[0].url, 'http://admin.test:3003/api/internal/onyx/knowledge');
        assert.deepStrictEqual(Object.keys(calls[0].body).sort(), ['business_id', 'channel', 'correlation_id', 'question']);
        assert.strictEqual(calls[0].body.business_id, a.id);
        assert.strictEqual(calls[0].config.maxRedirects, 0);
        assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM ml_decisions WHERE model='onyx.scoped_knowledge'").n, 1);
        assert.strictEqual(calls[0].config.timeout, 65000);
    }));

    it('rejects stale, foreign, preview and uncited results and provider failures', async () => withProvider(async ({ a }) => {
        const baseline = axios.post;
        for (const patch of [{ business_id: a.id+1 }, { stale: true }, { preview: true }, { grounded: false },
            { citations: [] }, { citations: [null] }, { citations: [{ source_id: -1 }] },
            { citations: [{ source_id: a.id, title: {} }] }, { success: false },
            { error_code: 'ONYX_RUNTIME_TIMEOUT' }, { customer_id: 99 }, { customer_context_provided: true },
            { handled: false }, { channel: 'voice' }, { correlation_id: 'other' }]) {
            axios.post = async (...args) => {
                const response = await baseline(...args);
                return { data: { ...response.data, ...patch } };
            };
            assert.strictEqual(await Onyx.answer({ businessId: a.id, question: 'Заезд?', channel: 'whatsapp' }), null);
        }
        axios.post = async () => { throw new Error('Bearer secret password=private'); };
        assert.strictEqual(await Onyx.answer({ businessId: a.id, question: 'Заезд?', channel: 'voice' }), null);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ml_decisions').n, 0);
    }));

    it('discards a grounded completion when its business was disabled during retrieval', async () => withProvider(async ({ a }) => {
        const baseline = axios.post;
        axios.post = async (...args) => {
            const response = await baseline(...args);
            DB.run('UPDATE instances SET isActive=0 WHERE id=?', [a.id]);
            return response;
        };
        assert.strictEqual(await Onyx.answer({ businessId: a.id, question: 'Заезд?', channel: 'whatsapp' }), null);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ml_decisions').n, 0);
    }));

    it('voice tool uses same-business local knowledge without Onyx latency', async () => withProvider(async ({ a, calls }) => {
        const original = RAG.answerFromKnowledge;
        let localBusiness;
        RAG.answerFromKnowledge = async (businessId) => { localBusiness = businessId; return { answer: 'Локальный ответ' }; };
        try {
            const answer = await SalesBrain.answerFromKnowledge({ instanceId: a.id, question: 'Заезд?' });
            assert.strictEqual(answer.answer, 'Локальный ответ');
            assert.strictEqual(localBusiness, a.id);
            assert.strictEqual(calls.length, 0);
        } finally { RAG.answerFromKnowledge = original; }
    }));

    it('WhatsApp uses current local sources and the selected model while Onyx is deferred', async () => withProvider(async ({ a, calls }) => {
        const original = { send: WhatsApp._sendMessage, ai: AI.getResponse, rag: RAG.runSearchPipeline, pms: PMS.handle };
        const sent = [];
        let receivedContext, localBusiness;
        WhatsApp._sendMessage = async (business, chatId, text) => { sent.push({ business: business.id, chatId, text }); return { idMessage: 'local-ack' }; };
        AI.getResponse = async (_history, context) => { receivedContext = context; return { reply: 'Заезд в 15:00.', action: 'none' }; };
        RAG.runSearchPipeline = async (businessId, _query, options) => {
            localBusiness = businessId;
            assert.strictEqual(options.searchType, 'keyword');
            return { effectiveResults: [{ text: 'Заезд в 15:00', originalName: 'Правила', score: 1 }] };
        };
        PMS.handle = async () => ({ handled: false });
        try {
            await DB.saveMessage(a.id, '79990000001@c.us', 'Guest', 'Во сколько заезд?', 'user');
            await WhatsApp._processBatch(a.id, '79990000001@c.us', { text: 'Во сколько заезд?' }, { isStale: () => false });
            assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].business, a.id);
            assert.strictEqual(localBusiness, a.id); assert.strictEqual(calls.length, 0);
            assert.ok(receivedContext.ragContext.includes('Правила'));
            assert.strictEqual((await DB.getMessages(a.id, '79990000001@c.us')).filter(m => m.role === 'assistant').length, 1);
            sent.length = 0;
            await WhatsApp._processBatch(a.id, '79990000001@c.us', { text: 'Заезд?' }, { isStale: () => true });
            assert.strictEqual(sent.length, 0);
        } finally {
            WhatsApp._sendMessage = original.send; AI.getResponse = original.ai;
            RAG.runSearchPipeline = original.rag; PMS.handle = original.pms;
        }
    }));

    it('ordinary WhatsApp questions still reach AI with empty local knowledge and no remote wait', async () => withProvider(async ({ a, calls }) => {
        const original = { send: WhatsApp._sendMessage, ai: AI.getResponse, rag: RAG.runSearchPipeline, pms: PMS.handle, info: Logger.info };
        const sent = [];
        let checked = false, trace;
        RAG.runSearchPipeline = async () => ({ effectiveResults: [] });
        PMS.handle = async () => null;
        AI.getResponse = async (_history, context) => {
            checked = true;
            assert.strictEqual(context.ragSearched, true); assert.strictEqual(context.ragContext, '');
            assert.ok(AI._buildSystemPrompt(context).includes('Проверенные фрагменты не найдены'));
            return { reply: 'Здравствуйте. Чем могу помочь?', action: 'none' };
        };
        WhatsApp._sendMessage = async (_, __, text) => { sent.push(text); return { idMessage: 'local-ack' }; };
        Logger.info = message => { if (message.startsWith('[WhatsAppLatency] ')) trace = JSON.parse(message.slice(18)); };
        try {
            await WhatsApp._processBatch(a.id, '79990000004@c.us', { text: 'Здравствуйте' }, { isStale: () => false });
            assert.strictEqual(checked, true); assert.strictEqual(calls.length, 0);
            assert.strictEqual(trace.onyx_outcome, 'deferred'); assert.strictEqual(trace.onyx_ms, 0);
            assert.deepStrictEqual(sent, ['Здравствуйте. Чем могу помочь?']);
            assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM ml_decisions WHERE model='onyx.scoped_knowledge'").n, 0);
        } finally {
            WhatsApp._sendMessage = original.send; AI.getResponse = original.ai;
            RAG.runSearchPipeline = original.rag; PMS.handle = original.pms; Logger.info = original.info;
        }
    }));

    it('PMS keeps priority and never goes through the knowledge model', async () => withProvider(async ({ a, calls }) => {
        const original = { send: WhatsApp._sendMessage, pms: PMS.handle };
        const sent = [];
        WhatsApp._sendMessage = async (_, __, text) => sent.push(text);
        PMS.handle = async () => ({ handled: true, reply: 'Уточните даты заезда и выезда.' });
        try {
            await WhatsApp._processBatch(a.id, '79990000001@c.us', { text: 'Есть свободный номер?' }, { isStale: () => false });
            assert.deepStrictEqual(sent, ['Уточните даты заезда и выезда.']);
            assert.strictEqual(calls.length, 0);
        } finally { WhatsApp._sendMessage = original.send; PMS.handle = original.pms; }
    }));
});
