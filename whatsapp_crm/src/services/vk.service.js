const Logger = require('../utils/logger');
const DB = require('./database.service');

class VkService {
    constructor() {
        this._bots = new Map(); // instanceId -> bot
        this._VkBot = null;
    }

    async start() {
        try {
            this._VkBot = require('./vk-bot-compat');
        } catch (e) {
            Logger.warn('[VK] node-vk-bot-api not installed. VK integration disabled.');
            return;
        }

        const instances = await DB.getInstances();
        for (const instance of instances) {
            if (instance.vkGroupToken && instance.isActive) {
                await this._startBot(instance);
            }
        }
        Logger.info(`[VK] 🤖 VK service initialized (${this._bots.size} bot(s))`);
    }

    async _startBot(instance) {
        if (!this._VkBot || !instance.vkGroupToken) return;

        try {
            const bot = new this._VkBot({
                token: instance.vkGroupToken,
                group_id: instance.vkGroupId || undefined,
            });

            // Handle all incoming messages
            bot.on(async (ctx) => {
                try {
                    await this._handleMessage(instance.id, ctx);
                } catch (e) {
                    Logger.error(`[VK] Message handling error:`, e.message);
                }
            });

            // Verify the token and group before reporting the channel connected.
            try {
                const group = await bot.getGroupInfo();
                if (!group) return false;
                const groupName = group.name || group.screen_name || 'VK Group';
                if (groupName !== instance.vkGroupName) {
                    await DB.updateInstance(instance.id, { vkGroupName: groupName });
                }
                Logger.info(`[VK] ✅ Bot for "${groupName}" started for instance ${instance.id}`);
            } catch (e) {
                Logger.warn(`[VK] Bot verification failed for instance ${instance.id}:`, e.code || e.name || 'unknown');
                return false;
            }

            // Keep the old listener until the candidate has passed provider verification.
            if (this._bots.has(instance.id)) await this._stopBot(instance.id);
            bot.startPolling((err) => {
                if (err) Logger.error(`[VK] Polling error for instance ${instance.id}:`, err.code || err.name || 'unknown');
            });
            this._bots.set(instance.id, bot);
            return true;
        } catch (e) {
            Logger.error(`[VK] Failed to start bot for instance ${instance.id}:`, e.code || e.name || 'unknown');
            return false;
        }
    }

    async _stopBot(instanceId) {
        const bot = this._bots.get(instanceId);
        if (bot) {
            try {
                bot.stop();
            } catch (e) { /* ignore */ }
            this._bots.delete(instanceId);
        }
    }

    async _handleMessage(instanceId, ctx) {
        const msg = ctx.message;
        if (!msg || !msg.text) return;
        // Ignore messages from bots/groups (negative from_id or no from_id)
        if (!msg.from_id || msg.from_id <= 0) return;

        const vkUserId = String(msg.from_id);
        const peerId = String(msg.peer_id);
        if (ctx.isChat || Number(peerId) >= 2000000000) return;
        const text = msg.text;

        // Try to get user name
        let senderName = 'VK User';
        try {
            const bot = this._bots.get(instanceId);
            if (bot) {
                const u = await bot.getUserInfo(vkUserId);
                if (u) {
                    senderName = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'VK User';
                }
            }
        } catch (e) {
            Logger.warn(`[VK] Could not get user name for instance ${instanceId}:`, e.code || e.name || 'provider_error');
        }

        Logger.info(`[VK] Message received for instance ${instanceId}`);

        // Find or create client
        let client = await DB.getClientByVk(instanceId, vkUserId);
        if (!client) {
            const internalChatId = `vk_${vkUserId}`;
            client = await DB.getOrCreateClient(instanceId, internalChatId, senderName);
            DB.run('UPDATE clients SET vkUserId = ?, vkPeerId = ?, preferredChannel = ? WHERE instanceId = ? AND chatId = ?',
                [vkUserId, peerId, 'vk', instanceId, internalChatId]);
            client = await DB.getClient(instanceId, internalChatId);
        } else {
            // Update peerId if needed
            if (client.vkPeerId !== peerId) {
                DB.run('UPDATE clients SET vkPeerId = ? WHERE instanceId = ? AND chatId = ?',
                    [peerId, instanceId, client.chatId]);
            }
        }

        // Save message
        const saved = await DB.saveMessageWithChannel(instanceId, client.chatId, senderName, text, 'user', 'vk', null, msg.id || msg.conversation_message_id);
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
                    Logger.info(`[RAG] Found VK context for instance ${instanceId}`);
                }
            } catch (e) {
                Logger.warn('[VK] RAG search failed:', e.message);
                context.ragContext = '';
            }

            const aiResponse = await AIService.getResponse(history, context);
            let replyText = '';

            if (typeof aiResponse === 'object') {
                replyText = aiResponse.reply;

                if (aiResponse.status && aiResponse.status !== client.leadStatus) {
                    try {
                        await DB.updateClientStatus(instanceId, client.chatId, aiResponse.status,
                            aiResponse.statusReasoning || 'AI auto-detection (VK)', 'ai');
                    } catch (e) {
                        Logger.warn(`[VK] Status update failed: ${e.message}`);
                    }
                }

                if (aiResponse.action === 'send_yclients' && instanceConfig.yclientsLink) {
                    replyText += `\n\n📅 Записаться: ${instanceConfig.yclientsLink}`;
                }
            } else {
                replyText = aiResponse;
            }

            if (replyText) {
                const sent = await this.sendMessage(instanceId, peerId, replyText);
                if (sent) {
                    await DB.saveMessageWithChannel(instanceId, client.chatId, 'Bot', replyText, 'assistant', 'vk', aiResponse.thought || null);
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
            Logger.error(`[VK] AI processing error:`, e.message);
        }
    }

    async sendMessage(instanceId, peerId, text, context = null) {
        const bot = this._bots.get(instanceId);
        if (!bot) {
            Logger.warn(`[VK] No bot for instance ${instanceId}`);
            return false;
        }
        try {
            if (typeof context?.beforeSend === 'function') { const guard = context.beforeSend(); if (guard?.then) await guard; }
            await bot.sendMessage(parseInt(peerId), text);
            return true;
        } catch (e) {
            if (e?.safeToRetry === true && e?.code) throw e;
            Logger.error(`[VK] sendMessage failed:`, e.code || e.name || 'provider_error');
            return false;
        }
    }

    async restartBot(instanceId) {
        const instance = await DB.getInstance(instanceId);
        if (instance?.isActive && instance.vkGroupToken) {
            return Boolean(await this._startBot(instance));
        }
        return false;
    }

    async validateCredentials(instance) {
        try {
            const Bot = this._VkBot || require('./vk-bot-compat');
            const bot = new Bot({ token: instance.vkGroupToken, group_id: instance.vkGroupId || undefined });
            return Boolean(await bot.getGroupInfo());
        } catch (e) {
            Logger.warn(`[VK] Candidate verification failed for instance ${instance.id}:`, e.code || e.name || 'unknown');
            return false;
        }
    }

    isActive(instanceId) {
        return this._bots.has(instanceId);
    }
}

module.exports = new VkService();
