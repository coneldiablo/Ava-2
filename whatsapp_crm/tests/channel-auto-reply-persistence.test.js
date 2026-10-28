const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const AIService = require('../src/services/ai.service');
const RAGService = require('../src/services/rag.service');
const SmartTriggersService = require('../src/services/smart-triggers.service');
const SequenceService = require('../src/services/sequence.service');
const PersonalizationService = require('../src/services/personalization.service');
const TelegramService = require('../src/services/telegram.service');
const ChannelJobs = require('../src/services/channel-jobs.store');
const Workspace = require('../src/services/ava-workspace.store');
const MaxService = require('../src/services/max.service');
const VkService = require('../src/services/vk.service');

async function runReply(channel, outcome) {
    createTestDB();
    const instance = await DB.createInstance({ name: `${channel} reply persistence` });
    const service = { telegram: TelegramService, max: MaxService, vk: VkService }[channel];
    const original = {
        sendMessage: service.sendMessage,
        getResponse: AIService.getResponse,
        buildConversationContext: RAGService.buildConversationContext,
        checkKeywordTriggers: SmartTriggersService.checkKeywordTriggers,
        onClientReply: SequenceService.onClientReply,
        shouldUpdateProfile: PersonalizationService.shouldUpdateProfile,
        telegramBot: TelegramService._bots.get(instance.id),
    };
    let sends = 0;
    let keywordChecks = 0;
    let clientReplyCallbacks = 0;
    service.sendMessage = async () => {
        sends++;
        if (outcome === 'throw') throw new Error('provider unavailable');
        return outcome === 'success';
    };
    AIService.getResponse = async () => ({ reply: 'Ответ AVA', thought: 'test' });
    RAGService.buildConversationContext = async () => ({ context: '', searched: true, query: 'Вопрос' });
    SmartTriggersService.checkKeywordTriggers = async () => { keywordChecks++; };
    SequenceService.onClientReply = async () => { clientReplyCallbacks++; };
    PersonalizationService.shouldUpdateProfile = async () => false;

    let chatId;
    try {
        if (channel === 'telegram') {
            chatId = 'tg_123';
            await DB.getOrCreateClient(instance.id, chatId, 'Клиент');
            DB.run('UPDATE clients SET telegramChatId = ?, preferredChannel = ? WHERE instanceId = ? AND chatId = ?',
                ['123', 'telegram', instance.id, chatId]);
            TelegramService._bots.set(instance.id, { sendMessage: async () => {
                sends++;
                if (outcome === 'throw') throw new Error('provider unavailable');
                if (outcome === 'false') throw Object.assign(new Error('provider rejected'), { errorCode: 429 });
                return { message_id: 456 };
            }});
            const saved = ChannelJobs.recordInbound({ instanceId: instance.id, chatId, originChatId: chatId,
                channel: 'telegram', providerMessageId: '123', senderName: 'Клиент', text: 'Вопрос',
                meta: { telegramChatId: '123' } });
            await service._processQueuedBatch(instance.id, chatId, { text: 'Вопрос', meta: { telegramChatId: '123' } },
                { isStale: () => false });
            const job = ChannelJobs.get({ instanceId: instance.id, id: saved.job.id });
            assert.strictEqual(job.status, { success: 'completed', false: 'retry', throw: 'unknown' }[outcome]);
            assert.strictEqual(job.outgoingProviderMessageId, outcome === 'success' ? '456' : null);
            assert.strictEqual(Workspace.getControl(instance.id, chatId).sendStatus,
                outcome === 'throw' ? 'unknown' : undefined);
        } else if (channel === 'max') {
            chatId = 'max_123';
            await service._handleUpdate(instance.id, 'unused-token', {
                update_type: 'message_created',
                message: { sender: { user_id: 123, name: 'Клиент' }, body: { text: 'Вопрос' },
                    recipient: { chat_id: 456 } },
            });
        } else {
            chatId = 'vk_123';
            await service._handleMessage(instance.id, { message: { from_id: 123, peer_id: 456, text: 'Вопрос' } });
        }

        const messages = await DB.getMessages(instance.id, chatId);
        assert.strictEqual(sends, 1, `${channel}: provider send attempted exactly once`);
        // Telegram's detailed provider boundary retains the durable outcome and
        // lets inbound keyword/sequence handling finish even on transport error.
        const expectedCallbacks = channel === 'telegram' ? 1 : outcome === 'throw' ? 0 : 1;
        assert.strictEqual(keywordChecks, expectedCallbacks,
            `${channel}: a failed delivery result must not skip keyword processing`);
        assert.strictEqual(clientReplyCallbacks, expectedCallbacks,
            `${channel}: a failed delivery result must not skip sequence pause handling`);
        assert.strictEqual(messages.filter(message => message.role === 'user').length, 1,
            `${channel}: incoming message must remain visible`);
        assert.strictEqual(messages.filter(message => message.role === 'assistant').length,
            outcome === 'success' ? 1 : 0,
            `${channel}: only successfully sent replies may appear in the conversation`);
    } finally {
        if (channel === 'telegram') {
            if (original.telegramBot) TelegramService._bots.set(instance.id, original.telegramBot);
            else TelegramService._bots.delete(instance.id);
        }
        service.sendMessage = original.sendMessage;
        AIService.getResponse = original.getResponse;
        RAGService.buildConversationContext = original.buildConversationContext;
        SmartTriggersService.checkKeywordTriggers = original.checkKeywordTriggers;
        SequenceService.onClientReply = original.onClientReply;
        PersonalizationService.shouldUpdateProfile = original.shouldUpdateProfile;
    }
}

describe('Omnichannel automatic reply persistence', () => {
    for (const channel of ['telegram', 'max', 'vk']) {
        for (const outcome of ['false', 'throw', 'success']) {
            it(`${channel} ${outcome}: saves an outgoing reply only after provider delivery`, async () => {
                await runReply(channel, outcome);
            });
        }
    }
});
