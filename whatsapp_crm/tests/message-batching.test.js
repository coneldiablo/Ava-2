const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const AIService = require('../src/services/ai.service');
const MessageBatcher = require('../src/services/message-batcher.service');
const WhatsAppService = require('../src/services/whatsapp.service');
const TelegramService = require('../src/services/telegram.service');
const RAGService = require('../src/services/rag.service');
const OnyxService = require('../src/services/onyx-knowledge.service');
const SmartTriggersService = require('../src/services/smart-triggers.service');
const SequenceService = require('../src/services/sequence.service');
const PersonalizationService = require('../src/services/personalization.service');
const BaristaBotService = require('../src/services/barista-bot.service');
const CrmMemoryStore = require('../src/services/crm-memory-store.service');
const Logger = require('../src/utils/logger');
const config = require('../src/config');
const OnyxKnowledgeService = require('../src/services/onyx-knowledge.service');
const PushService = require('../src/services/push.service');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(assertion, timeoutMs = 500) {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeoutMs) {
        try {
            assertion();
            return;
        } catch (e) {
            lastError = e;
            await sleep(10);
        }
    }
    if (lastError) throw lastError;
}

function patchQuietSideEffects() {
    const originals = {
        buildConversationContext: RAGService.buildConversationContext,
        checkKeywordTriggers: SmartTriggersService.checkKeywordTriggers,
        onClientReply: SequenceService.onClientReply,
        shouldUpdateProfile: PersonalizationService.shouldUpdateProfile,
        buildClientProfile: PersonalizationService.buildClientProfile,
        analyzeContactTimes: PersonalizationService.analyzeContactTimes,
        notifyNewOrder: BaristaBotService.notifyNewOrder
    };

    RAGService.buildConversationContext = async (instanceId, chatId, query) => ({
        query,
        context: '',
        searched: true
    });
    SmartTriggersService.checkKeywordTriggers = async () => {};
    SequenceService.onClientReply = async () => {};
    PersonalizationService.shouldUpdateProfile = async () => false;
    PersonalizationService.buildClientProfile = async () => {};
    PersonalizationService.analyzeContactTimes = async () => {};
    BaristaBotService.notifyNewOrder = async () => false;

    return () => {
        RAGService.buildConversationContext = originals.buildConversationContext;
        SmartTriggersService.checkKeywordTriggers = originals.checkKeywordTriggers;
        SequenceService.onClientReply = originals.onClientReply;
        PersonalizationService.shouldUpdateProfile = originals.shouldUpdateProfile;
        PersonalizationService.buildClientProfile = originals.buildClientProfile;
        PersonalizationService.analyzeContactTimes = originals.analyzeContactTimes;
        BaristaBotService.notifyNewOrder = originals.notifyNewOrder;
    };
}

function setFastBatching(service) {
    const timings = {
        delayTime: service.delayTime,
        shortDelayTime: service.shortDelayTime,
        maxBatchTime: service.maxBatchTime
    };
    service.delayTime = 5;
    service.shortDelayTime = 20;
    service.maxBatchTime = 80;
    return () => {
        service.delayTime = timings.delayTime;
        service.shortDelayTime = timings.shortDelayTime;
        service.maxBatchTime = timings.maxBatchTime;
        service.batcher.clearAll();
    };
}

describe('Message Batching Tests', () => {
    it('should apply the shorter window only to WhatsApp', () => {
        assert.strictEqual(WhatsAppService.delayTime, config.whatsappMessageBatching.idleMs);
        assert.strictEqual(WhatsAppService.shortDelayTime, config.whatsappMessageBatching.shortIdleMs);
        assert.strictEqual(TelegramService.delayTime, config.messageBatching.idleMs);
        assert.strictEqual(TelegramService.shortDelayTime, config.messageBatching.shortIdleMs);
    });

    it('should dedupe provider webhook IDs before batching and keep customer data out of WhatsApp logs', async () => {
        createTestDB();
        const restoreSideEffects = patchQuietSideEffects();
        const restoreTiming = setFastBatching(WhatsAppService);
        const original = {
            ai: AIService.getResponse,
            onyx: OnyxKnowledgeService.answer,
            send: WhatsAppService._sendMessage,
            push: PushService.notifyNewLead,
            info: Logger.info,
            warn: Logger.warn,
            error: Logger.error,
        };
        const logs = [];
        let aiCalls = 0;
        let sends = 0;
        AIService.getResponse = async () => {
            aiCalls++;
            return { reply: 'Ответ', status: 'new', action: 'none' };
        };
        OnyxKnowledgeService.answer = async () => null;
        WhatsAppService._sendMessage = async () => { sends++; return { idMessage: 'local-ack' }; };
        PushService.notifyNewLead = async () => {};
        Logger.info = message => { logs.push(String(message)); };
        Logger.warn = (...parts) => { logs.push(parts.map(String).join(' ')); };
        Logger.error = (...parts) => { logs.push(parts.map(String).join(' ')); };

        try {
            const instance = await DB.createInstance({ name: 'Webhook dedup fixture' });
            await DB.updateInstance(instance.id, { isActive: 1 });
            const green = { typeWebhook: 'incomingMessageReceived', idMessage: 'green-123',
                senderData: { chatId: '79990000011@c.us', senderName: 'PRIVATE_NAME' },
                messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'PRIVATE_TEXT' } } };
            await WhatsAppService.processWebhook(green, instance.id);
            await waitFor(() => assert.strictEqual(sends, 1));
            await WhatsAppService.processWebhook(green, instance.id);

            const openwa = { event: 'message.received', data: { id: { _serialized: 'openwa-456' },
                chatId: '79990000012@c.us', from: '79990000012@c.us',
                pushName: 'PRIVATE_NAME', body: 'PRIVATE_TEXT' } };
            await WhatsAppService.processOpenWaWebhook(openwa, instance.id);
            await waitFor(() => assert.strictEqual(sends, 2));
            await WhatsAppService.processOpenWaWebhook(openwa, instance.id);

            assert.strictEqual(aiCalls, 2);
            assert.strictEqual(sends, 2);
            for (const chatId of ['79990000011@c.us', '79990000012@c.us']) {
                const messages = await DB.getMessages(instance.id, chatId);
                assert.strictEqual(messages.filter(m => m.role === 'user').length, 1);
                assert.strictEqual(messages.filter(m => m.role === 'assistant').length, 1);
            }
            const output = logs.join('\n');
            for (const privateValue of ['PRIVATE_NAME', 'PRIVATE_TEXT', '79990000011', '79990000012', 'green-123', 'openwa-456']) {
                assert.ok(!output.includes(privateValue), `WhatsApp log exposed ${privateValue}`);
            }
        } finally {
            AIService.getResponse = original.ai;
            OnyxKnowledgeService.answer = original.onyx;
            WhatsAppService._sendMessage = original.send;
            PushService.notifyNewLead = original.push;
            Logger.info = original.info;
            Logger.warn = original.warn;
            Logger.error = original.error;
            restoreTiming();
            restoreSideEffects();
        }
    });

    it('should merge short consecutive messages into one batch', async () => {
        const batcher = new MessageBatcher({ idleMs: 5, shortIdleMs: 20, maxMs: 80 });
        const batches = [];

        batcher.enqueue({
            key: '1:whatsapp:test',
            text: 'Добрый вечер',
            onFlush: async (batch, token) => batches.push({ batch, stale: token.isStale() })
        });
        await sleep(5);
        batcher.enqueue({
            key: '1:whatsapp:test',
            text: 'У вас кухня работает?',
            onFlush: async (batch, token) => batches.push({ batch, stale: token.isStale() })
        });

        await waitFor(() => assert.strictEqual(batches.length, 1));
        assert.strictEqual(batches[0].batch.text, 'Добрый вечер\nУ вас кухня работает?');
        assert.strictEqual(batches[0].stale, false);
    });

    it('should mark a running batch as stale when a new message arrives', async () => {
        const batcher = new MessageBatcher({ idleMs: 1, shortIdleMs: 1, maxMs: 50 });
        let firstToken = null;
        let releaseFirst;
        const firstDone = new Promise(resolve => { releaseFirst = resolve; });

        batcher.enqueue({
            key: '1:telegram:test',
            text: 'Первое сообщение',
            onFlush: async (batch, token) => {
                if (!firstToken) {
                    firstToken = token;
                    await firstDone;
                }
            }
        });

        await waitFor(() => assert.ok(firstToken));
        batcher.enqueue({
            key: '1:telegram:test',
            text: 'Второе сообщение',
            onFlush: async () => {}
        });

        assert.strictEqual(firstToken.isStale(), true);
        releaseFirst();
        await sleep(10);
        batcher.clearAll();
    });

    it('should process multiple WhatsApp messages with one AI response', async () => {
        createTestDB();
        const restoreSideEffects = patchQuietSideEffects();
        const restoreTiming = setFastBatching(WhatsAppService);
        const originalGetResponse = AIService.getResponse;
        const originalSend = WhatsAppService._sendMessage;
        const sent = [];
        let aiCalls = 0;
        let receivedContext = null;

        AIService.getResponse = async (history, context) => {
            aiCalls += 1;
            receivedContext = context;
            return {
                reply: 'Кухня работает с 09:00 до 22:00.',
                status: 'new',
                action: 'none',
                thought: 'Answered combined user turn',
                orderSummary: ''
            };
        };
        WhatsAppService._sendMessage = async (instanceConfig, chatId, text) => {
            sent.push({ chatId, text });
            return { idMessage: 'test_msg' };
        };

        try {
            const instance = await DB.createInstance({ name: 'Batch Cafe' });
            await DB.updateInstance(instance.id, { isActive: 1 });

            await WhatsAppService._handleIncomingMessage(instance.id, '79990002001@c.us', 'Теона', 'Добрый вечер');
            await WhatsAppService._handleIncomingMessage(instance.id, '79990002001@c.us', 'Теона', 'У вас кухня работает?');

            await waitFor(() => assert.strictEqual(sent.length, 1));
            assert.strictEqual(aiCalls, 1);
            assert.strictEqual(receivedContext.currentBatchText, 'Добрый вечер\nУ вас кухня работает?');

            const messages = await DB.getMessages(instance.id, '79990002001@c.us');
            assert.strictEqual(messages.filter(m => m.role === 'user').length, 2);
            assert.strictEqual(messages.filter(m => m.role === 'assistant').length, 1);
        } finally {
            AIService.getResponse = originalGetResponse;
            WhatsAppService._sendMessage = originalSend;
            restoreTiming();
            restoreSideEffects();
        }
    });

    it('should not send stale WhatsApp AI replies or apply stale side effects', async () => {
        createTestDB();
        const restoreSideEffects = patchQuietSideEffects();
        const restoreTiming = setFastBatching(WhatsAppService);
        const originalGetResponse = AIService.getResponse;
        const originalSend = WhatsAppService._sendMessage;
        const originalDispatchOrder = BaristaBotService.dispatchOrder;
        const sent = [];
        let aiCalls = 0;
        let dispatchCalls = 0;
        let releaseFirst;
        const firstAiCanFinish = new Promise(resolve => { releaseFirst = resolve; });

        AIService.getResponse = async () => {
            aiCalls += 1;
            if (aiCalls === 1) {
                await firstAiCanFinish;
                return {
                    reply: 'Старый ответ',
                    status: 'qualified',
                    action: 'none',
                    thought: 'stale',
                    orderSummary: 'Старый заказ'
                };
            }
            return {
                reply: 'Ответ по полной мысли',
                status: 'new',
                action: 'none',
                thought: 'fresh',
                orderSummary: ''
            };
        };
        WhatsAppService._sendMessage = async (instanceConfig, chatId, text) => {
            sent.push({ chatId, text });
            return { idMessage: 'test_msg' };
        };
        BaristaBotService.dispatchOrder = async () => {
            dispatchCalls += 1;
            return { order: { id: 1 }, created: true, updated: false, notified: false };
        };

        try {
            const instance = await DB.createInstance({ name: 'Stale Cafe' });
            await DB.updateInstance(instance.id, { isActive: 1 });

            await WhatsAppService._handleIncomingMessage(instance.id, '79990002002@c.us', 'Теона', 'Хочу заказать');
            await waitFor(() => assert.strictEqual(aiCalls, 1));
            await WhatsAppService._handleIncomingMessage(instance.id, '79990002002@c.us', 'Теона', 'к 15:00');

            assert.strictEqual(aiCalls, 1, 'generation for one chat is serialized');
            releaseFirst();
            await waitFor(() => assert.strictEqual(aiCalls, 2));
            await waitFor(() => assert.strictEqual(sent.length, 1));
            await sleep(20);

            assert.strictEqual(sent.length, 1);
            assert.strictEqual(sent[0].text, 'Ответ по полной мысли');
            assert.strictEqual(dispatchCalls, 0);

            const client = await DB.getClient(instance.id, '79990002002@c.us');
            assert.strictEqual(client.leadStatus, 'new');
        } finally {
            releaseFirst?.();
            AIService.getResponse = originalGetResponse;
            WhatsAppService._sendMessage = originalSend;
            BaristaBotService.dispatchOrder = originalDispatchOrder;
            restoreTiming();
            restoreSideEffects();
        }
    });

    it('should include only the same tenant and chat complete call summary in local AI context', async () => {
        createTestDB();
        const restoreSideEffects = patchQuietSideEffects();
        const restoreTiming = setFastBatching(WhatsAppService);
        const originalGetResponse = AIService.getResponse;
        const originalSend = WhatsAppService._sendMessage;
        const contexts = new Map();
        let sent = 0;
        AIService.getResponse = async (_history, context) => {
            contexts.set(context.instanceId, context);
            return { reply: 'Ответ', status: 'new', action: 'none' };
        };
        WhatsAppService._sendMessage = async () => { sent++; return { idMessage: 'local' }; };

        try {
            const first = await DB.createInstance({ name: 'First business' });
            const second = await DB.createInstance({ name: 'Second business' });
            await DB.updateInstance(first.id, { isActive: 1 });
            await DB.updateInstance(second.id, { isActive: 1 });
            const chatId = '79990000001@c.us';
            await DB.getOrCreateClient(first.id, chatId, 'Клиент');
            const policy = require('../src/services/crm-memory-policy.json');
            DB.run(`INSERT INTO crm_memory_summaries
                (summaryId,instanceId,chatId,kind,sourceKey,sourceHash,summaryJson,sourceUpdatedAt,
                 generatedAt,model,promptVersion,sourceComplete) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
                'call-summary-1', first.id, chatId, 'call', 'call-1', 'source-hash',
                JSON.stringify({ summary: 'Клиент просил написать во вторник.', domain: CrmMemoryStore.domain(first.id), relevance: 'relevant' }),
                new Date().toISOString(), new Date().toISOString(), 'fixture', policy.version, 1,
            ]);

            await Promise.all([first, second].map(instance =>
                WhatsAppService._handleIncomingMessage(instance.id, chatId, 'Клиент', 'Когда свяжетесь?')));
            await waitFor(() => assert.strictEqual(sent, 2));
            assert.strictEqual(contexts.get(first.id).lastCallSummary, 'Клиент просил написать во вторник.');
            assert.strictEqual(contexts.get(second.id).lastCallSummary, null);
            assert.ok(AIService._buildSystemPrompt(contexts.get(first.id)).includes('Клиент просил написать во вторник.'));
            assert.ok(!AIService._buildSystemPrompt(contexts.get(second.id)).includes('Клиент просил написать во вторник.'));
        } finally {
            AIService.getResponse = originalGetResponse;
            WhatsAppService._sendMessage = originalSend;
            restoreTiming();
            restoreSideEffects();
        }
    });

    it('should use local knowledge and selected AI without waiting for deferred Onyx', async () => {
        createTestDB();
        const restoreSideEffects = patchQuietSideEffects();
        const restoreTiming = setFastBatching(WhatsAppService);
        const originalOnyx = OnyxService.answer;
        const originalGetResponse = AIService.getResponse;
        const originalSend = WhatsAppService._sendMessage;
        let onyxArgs = null;
        let aiCalls = 0;
        const sent = [];

        OnyxService.answer = async (args) => {
            onyxArgs = args;
            return null;
        };
        AIService.getResponse = async () => {
            aiCalls += 1;
            return { reply: 'Локальный ответ', status: 'new', action: 'none' };
        };
        WhatsAppService._sendMessage = async (_instanceConfig, chatId, text) => {
            sent.push({ chatId, text });
            return { idMessage: 'local-fallback' };
        };

        try {
            const instance = await DB.createInstance({ name: 'Fallback business' });
            await DB.updateInstance(instance.id, { isActive: 1 });
            await WhatsAppService._handleIncomingMessage(instance.id, '79990002003@c.us', 'Клиент', 'Что по документам?');
            await waitFor(() => assert.strictEqual(sent.length, 1));
            assert.strictEqual(onyxArgs, null);
            assert.strictEqual(aiCalls, 1);
            assert.strictEqual(sent[0].text, 'Локальный ответ');
        } finally {
            OnyxService.answer = originalOnyx;
            AIService.getResponse = originalGetResponse;
            WhatsAppService._sendMessage = originalSend;
            restoreTiming();
            restoreSideEffects();
        }
    });

    it('should distinguish gateway ACK from failed durable reply save', async () => {
        createTestDB();
        const restoreSideEffects = patchQuietSideEffects();
        const originalGetResponse = AIService.getResponse;
        const originalSend = WhatsAppService._sendMessage;
        const originalSave = DB.saveMessage;
        const originalInfo = Logger.info;
        const originalError = Logger.error;
        let sends = 0;
        let trace = null;

        try {
            const instance = await DB.createInstance({ name: 'ACK fixture' });
            await DB.updateInstance(instance.id, { isActive: 1 });
            const chatId = '79990002004@c.us';
            await DB.getOrCreateClient(instance.id, chatId, 'Клиент');
            await DB.saveMessage(instance.id, chatId, 'Клиент', 'Вопрос?', 'user');
            AIService.getResponse = async () => ({ reply: 'Ответ', status: 'new', action: 'none' });
            WhatsAppService._sendMessage = async () => { sends++; return { idMessage: 'local-ack' }; };
            DB.saveMessage = async (...args) => {
                if (args[4] === 'assistant') throw new Error('fixture save failed');
                return originalSave.apply(DB, args);
            };
            Logger.info = message => {
                if (message.startsWith('[WhatsAppLatency] ')) trace = JSON.parse(message.slice(18));
            };
            Logger.error = () => {};
            await WhatsAppService._processBatch(instance.id, chatId, {
                text: 'Вопрос?', version: 1,
                messages: [{ meta: { receivedAt: Date.now(), inboundSaveMs: 0 } }],
            }, { isStale: () => false });
            assert.strictEqual(sends, 1);
            assert.strictEqual(trace.outcome, 'persistence_error_after_ack');
            assert.ok(Number.isFinite(trace.first_inbound_to_ack_ms));
            assert.strictEqual((await DB.getMessages(instance.id, chatId)).filter(row => row.role === 'assistant').length, 0);
        } finally {
            AIService.getResponse = originalGetResponse;
            WhatsAppService._sendMessage = originalSend;
            DB.saveMessage = originalSave;
            Logger.info = originalInfo;
            Logger.error = originalError;
            restoreSideEffects();
        }
    });

    it('should process multiple Telegram messages with one AI response', async () => {
        createTestDB();
        const restoreSideEffects = patchQuietSideEffects();
        const restoreTiming = setFastBatching(TelegramService);
        const originalGetResponse = AIService.getResponse;
        const previousCredentialKey = process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
        process.env.CHANNEL_CREDENTIALS_MASTER_KEY = '22'.repeat(32);
        const sent = [];
        let aiCalls = 0;
        let receivedContext = null;

        AIService.getResponse = async (history, context) => {
            aiCalls += 1;
            receivedContext = context;
            return {
                reply: 'Салаты есть: Цезарь и баклажаны.',
                status: 'new',
                action: 'none',
                thought: 'Answered Telegram batch',
                orderSummary: ''
            };
        };

        try {
            const instance = await DB.createInstance({ name: 'Telegram Cafe' });
            await DB.updateInstance(instance.id, { isActive: 1, telegramBotToken: 'token' });
            TelegramService._bots.set(instance.id, {
                sendMessage: async (chatId, text) => {
                    sent.push({ chatId, text });
                    return { message_id: 1 };
                }
            });

            const baseMsg = {
                chat: { id: 12345 },
                from: { first_name: 'Теона', last_name: '', is_bot: false }
            };
            await TelegramService._handleMessage(instance.id, { ...baseMsg, message_id: 1, text: 'Да' });
            await TelegramService._handleMessage(instance.id, { ...baseMsg, message_id: 2, text: 'Какие салаты есть?' });

            await waitFor(() => assert.strictEqual(sent.length, 1));
            assert.strictEqual(aiCalls, 1);
            assert.strictEqual(receivedContext.currentBatchText, 'Да\nКакие салаты есть?');

            const client = await DB.getClientByTelegram(instance.id, '12345');
            const messages = await DB.getMessages(instance.id, client.chatId);
            assert.strictEqual(messages.filter(m => m.role === 'user').length, 2);
            assert.strictEqual(messages.filter(m => m.role === 'assistant').length, 1);
        } finally {
            if (previousCredentialKey === undefined) delete process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
            else process.env.CHANNEL_CREDENTIALS_MASTER_KEY = previousCredentialKey;
            AIService.getResponse = originalGetResponse;
            TelegramService._bots.clear();
            restoreTiming();
            restoreSideEffects();
        }
    });

    it('should create one coffee order from a split WhatsApp order and pickup time', async () => {
        createTestDB();
        const restoreSideEffects = patchQuietSideEffects();
        const restoreTiming = setFastBatching(WhatsAppService);
        const originalGetResponse = AIService.getResponse;
        const originalSend = WhatsAppService._sendMessage;
        const sent = [];
        let aiCalls = 0;

        AIService.getResponse = async (history, context) => {
            aiCalls += 1;
            assert.strictEqual(context.currentBatchText, 'Айс кофе\nк 15:00');
            return {
                reply: 'Передал заказ бариста, ожидайте подтверждения.',
                status: 'offer',
                action: 'none',
                thought: 'Order and pickup time are known',
                orderSummary: 'Айс кофе',
                pickupTime: 'к 15:00'
            };
        };
        WhatsAppService._sendMessage = async (instanceConfig, chatId, text) => {
            sent.push({ chatId, text });
            return { idMessage: 'test_msg' };
        };

        try {
            const instance = await DB.createInstance({ name: 'Coffee Batch', businessType: 'coffee_shop' });
            await DB.updateInstance(instance.id, { isActive: 1 });

            await WhatsAppService._handleIncomingMessage(instance.id, '79990002005@c.us', 'Теона', 'Айс кофе');
            await WhatsAppService._handleIncomingMessage(instance.id, '79990002005@c.us', 'Теона', 'к 15:00');

            await waitFor(() => assert.strictEqual(sent.length, 1));
            assert.strictEqual(aiCalls, 1);

            const orders = await DB.getOrdersByClient(instance.id, '79990002005@c.us');
            assert.strictEqual(orders.length, 1);
            assert.strictEqual(orders[0].orderSummary, 'Айс кофе');
            assert.strictEqual(orders[0].pickupTime, 'к 15:00');
        } finally {
            AIService.getResponse = originalGetResponse;
            WhatsAppService._sendMessage = originalSend;
            restoreTiming();
            restoreSideEffects();
        }
    });
});
