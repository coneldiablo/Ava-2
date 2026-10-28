const axios = require('axios');
const Logger = require('../utils/logger');
const DB = require('./database.service');

const MAX_API_BASE = 'https://platform-api.max.ru';

class MaxService {
    constructor() {
        this._pollers = new Map(); // instanceId -> { active, timeout }
    }

    async start() {
        const instances = await DB.getInstances();
        for (const instance of instances) {
            if (instance.maxBotToken && instance.isActive) {
                await this._startPolling(instance);
            }
        }
        Logger.info(`[MAX] 🤖 MAX service initialized (${this._pollers.size} bot(s))`);
    }

    async _startPolling(instance) {
        if (!instance.maxBotToken) return;

        // Get bot info
        try {
            const me = await this._apiGet(instance.maxBotToken, '/me');
            if (!me) return false;
            if (me && me.name) {
                if (me.name !== instance.maxBotName || me.username !== instance.maxBotUsername) {
                    await DB.updateInstance(instance.id, {
                        maxBotName: me.name,
                        maxBotUsername: me.username || ''
                    });
                }
                Logger.info(`[MAX] ✅ Bot "${me.name}" started for instance ${instance.id}`);
            }
        } catch (e) {
            Logger.warn(`[MAX] Bot verification failed for instance ${instance.id}:`, e.code || e.name || 'unknown');
            return false;
        }

        // A bad replacement must not tear down an existing long poller.
        if (this._pollers.has(instance.id)) await this._stopPolling(instance.id);
        const poller = { active: true, timeout: null, marker: null };
        this._pollers.set(instance.id, poller);
        // Start long-polling loop
        this._pollLoop(instance.id, instance.maxBotToken);
        return true;
    }

    async _pollLoop(instanceId, token) {
        const poller = this._pollers.get(instanceId);
        if (!poller || !poller.active) return;

        try {
            const params = { timeout: 25, types: 'message_created,bot_started' };
            if (poller.marker) params.marker = poller.marker;

            const data = await this._apiGet(token, '/updates', params);

            if (data && data.updates && Array.isArray(data.updates)) {
                for (const update of data.updates) {
                    try {
                        await this._handleUpdate(instanceId, token, update);
                    } catch (e) {
                        Logger.error(`[MAX] Update handling error:`, e.message);
                    }
                }
                if (data.marker) {
                    poller.marker = data.marker;
                }
            }
        } catch (e) {
            if (e.code !== 'ECONNABORTED') {
                Logger.warn(`[MAX] Poll error for instance ${instanceId}:`, e.code || e.name || 'provider_error');
            }
        }

        // Schedule next poll
        if (poller.active) {
            poller.timeout = setTimeout(() => this._pollLoop(instanceId, token), 500);
        }
    }

    async _stopPolling(instanceId) {
        const poller = this._pollers.get(instanceId);
        if (poller) {
            poller.active = false;
            if (poller.timeout) {
                clearTimeout(poller.timeout);
            }
            this._pollers.delete(instanceId);
        }
    }

    async _handleUpdate(instanceId, token, update) {
        if (update.update_type === 'bot_started') {
            // User started the bot — treat as a greeting
            const user = update.user;
            if (!user) return;
            const maxUserId = String(user.user_id);
            const senderName = user.name || user.username || 'MAX User';
            const chatId = update.chat_id ? String(update.chat_id) : null;

            Logger.info(`[MAX] Bot started for instance ${instanceId}`);

            const internalChatId = `max_${maxUserId}`;
            let client = await DB.getClientByMax(instanceId, maxUserId);
            if (!client) {
                client = await DB.getOrCreateClient(instanceId, internalChatId, senderName);
                DB.run('UPDATE clients SET maxUserId = ?, maxChatId = ?, preferredChannel = ? WHERE instanceId = ? AND chatId = ?',
                    [maxUserId, chatId, 'max', instanceId, internalChatId]);
            }
            return;
        }

        if (update.update_type !== 'message_created') return;

        const message = update.message;
        if (!message || !message.body || !message.body.text) return;
        if (['group', 'channel'].includes(message.recipient?.chat_type || message.chat_type)) return;

        const sender = message.sender;
        if (!sender || sender.is_bot) return;

        const maxUserId = String(sender.user_id);
        const senderName = sender.name || sender.username || 'MAX User';
        const text = message.body.text;
        const chatId = message.recipient ? String(message.recipient.chat_id) : null;

        Logger.info(`[MAX] Message received for instance ${instanceId}`);

        // Find or create client
        let client = await DB.getClientByMax(instanceId, maxUserId);
        if (!client) {
            const internalChatId = `max_${maxUserId}`;
            client = await DB.getOrCreateClient(instanceId, internalChatId, senderName);
            DB.run('UPDATE clients SET maxUserId = ?, maxChatId = ?, preferredChannel = ? WHERE instanceId = ? AND chatId = ?',
                [maxUserId, chatId, 'max', instanceId, internalChatId]);
            client = await DB.getClient(instanceId, internalChatId);
        } else {
            // Update chatId if needed
            if (chatId && client.maxChatId !== chatId) {
                DB.run('UPDATE clients SET maxChatId = ? WHERE instanceId = ? AND chatId = ?',
                    [chatId, instanceId, client.chatId]);
            }
        }

        // Save message
        const saved = await DB.saveMessageWithChannel(instanceId, client.chatId, senderName, text, 'user', 'max', null, message.mid || message.id || update.update_id);
        if (!saved.inserted) return;

        // Process through AI pipeline
        try {
            const history = await DB.getClientHistory(instanceId, client.chatId, 20);
            const instanceConfig = await DB.getInstance(instanceId);

            if (!instanceConfig.isActive) return;

            const AIService = require('./ai.service');
            const context = {
                clientName: client.senderName,
                leadStatus: client.leadStatus,
                yclientsLink: instanceConfig.yclientsLink,
                systemPrompt: instanceConfig.systemPrompt,
                salesGoal: instanceConfig.salesGoal || 'call',
                instanceConfig,
                instanceId
            };

            try {
                const RAGService = require('./rag.service');
                const rag = await RAGService.buildConversationContext(instanceId, client.chatId, text, { k: 5 });
                context.ragContext = rag.context;
                context.ragSearched = rag.searched;
                if (context.ragContext) {
                    Logger.info(`[RAG] Found MAX context for instance ${instanceId}`);
                }
            } catch (e) {
                Logger.warn('[MAX] RAG search failed:', e.message);
                context.ragContext = '';
            }

            const aiResponse = await AIService.getResponse(history, context);
            let replyText = '';

            if (typeof aiResponse === 'object') {
                replyText = aiResponse.reply;

                if (aiResponse.status && aiResponse.status !== client.leadStatus) {
                    try {
                        await DB.updateClientStatus(instanceId, client.chatId, aiResponse.status,
                            aiResponse.statusReasoning || 'AI auto-detection (MAX)', 'ai');
                    } catch (e) {
                        Logger.warn(`[MAX] Status update failed: ${e.message}`);
                    }
                }

                if (aiResponse.action === 'send_yclients' && instanceConfig.yclientsLink) {
                    replyText += `\n\n📅 Записаться: ${instanceConfig.yclientsLink}`;
                }
            } else {
                replyText = aiResponse;
            }

            if (replyText) {
                const sendChatId = chatId || client.maxChatId;
                const sendUserId = maxUserId;
                const sent = await this.sendMessage(instanceId, sendChatId, sendUserId, replyText);
                if (sent) {
                    await DB.saveMessageWithChannel(instanceId, client.chatId, 'Bot', replyText, 'assistant', 'max', aiResponse.thought || null);
                }
            }

            // Check keyword triggers
            const SmartTriggersService = require('./smart-triggers.service');
            await SmartTriggersService.checkKeywordTriggers(instanceId, client.chatId, text);

            // Pause sequences if client replied
            const SequenceService = require('./sequence.service');
            await SequenceService.onClientReply(instanceId, client.chatId);

            // Update profile periodically
            const PersonalizationService = require('./personalization.service');
            if (await PersonalizationService.shouldUpdateProfile(instanceId, client.chatId)) {
                PersonalizationService.buildClientProfile(instanceId, client.chatId).catch(() => { });
                PersonalizationService.analyzeContactTimes(instanceId, client.chatId).catch(() => { });
            }

        } catch (e) {
            Logger.error(`[MAX] AI processing error:`, e.message);
        }
    }

    async sendMessage(instanceId, chatId, userId, text, context = null) {
        const instance = await DB.getInstance(instanceId);
        if (!instance || !instance.maxBotToken) {
            Logger.warn(`[MAX] No token for instance ${instanceId}`);
            return false;
        }
        try {
            const params = {};
            if (chatId) {
                params.chat_id = chatId;
            } else if (userId) {
                params.user_id = userId;
            } else {
                Logger.warn(`[MAX] No chat_id or user_id for sending message`);
                return false;
            }

            const queryStr = new URLSearchParams(params).toString();
            if (typeof context?.beforeSend === 'function') { const guard = context.beforeSend(); if (guard?.then) await guard; }
            await axios.post(
                `${MAX_API_BASE}/messages?${queryStr}`,
                { text },
                {
                    headers: {
                        'Authorization': instance.maxBotToken,
                        'Content-Type': 'application/json',
                    },
                    timeout: 15000,
                }
            );
            return true;
        } catch (e) {
            if (e?.safeToRetry === true && e?.code) throw e;
            Logger.error(`[MAX] sendMessage failed:`, e.response?.status || e.code || e.name || 'provider_error');
            return false;
        }
    }

    async restartBot(instanceId) {
        const instance = await DB.getInstance(instanceId);
        if (instance?.isActive && instance.maxBotToken) {
            return Boolean(await this._startPolling(instance));
        }
        return false;
    }

    async validateCredentials(instance) {
        try {
            return Boolean(await this._apiGet(instance.maxBotToken, '/me'));
        } catch (e) {
            Logger.warn(`[MAX] Candidate verification failed for instance ${instance.id}:`, e.code || e.name || 'unknown');
            return false;
        }
    }

    isActive(instanceId) {
        return this._pollers.has(instanceId);
    }

    // --- HTTP helpers ---

    async _apiGet(token, path, params = {}) {
        const queryStr = new URLSearchParams(params).toString();
        const url = `${MAX_API_BASE}${path}${queryStr ? '?' + queryStr : ''}`;
        const res = await axios.get(url, {
            headers: { 'Authorization': token },
            timeout: 30000,
        });
        return res.data;
    }
}

module.exports = new MaxService();
