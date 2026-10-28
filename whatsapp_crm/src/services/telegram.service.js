const Logger = require('../utils/logger');
const DB = require('./database.service');
const { buildTelegramOptions } = require('../utils/telegram-options');
const MessageBatcher = require('./message-batcher.service');
const Jobs = require('./channel-jobs.store');
const ChannelContext = require('./channel-context.service');
const CustomerContext = require('./channel-customer-context.service');
const Workspace = require('./ava-workspace.store');

class TelegramService {
    constructor() {
        this._bots = new Map(); // instanceId -> bot
        this._TelegramBot = null;
        this.batcher = new MessageBatcher();
        this.delayTime = this.batcher.defaultIdleMs;
        this.shortDelayTime = this.batcher.defaultShortIdleMs;
        this.maxBatchTime = this.batcher.defaultMaxMs;
        this.inFlight = new Map();
        this.recoveryTimer = setInterval(() => {
            if (DB.db?.open) this.recoverPending().catch(e => Logger.error('[Telegram] Recovery failed:', this._errorCode(e)));
        }, 5000);
        this.recoveryTimer.unref();
    }

    async start() {
        try {
            this._TelegramBot = require('./telegram-bot-compat');
        } catch (e) {
            Logger.warn('[Telegram] node-telegram-bot-api not installed. Telegram integration disabled.');
            return;
        }

        const instances = await DB.getInstances();
        for (const instance of instances) {
            if (instance.telegramBotToken && instance.isActive) {
                await this._startBot(instance);
            }
        }
        await this.recoverPending();
        Logger.info(`[Telegram] 🤖 Telegram service initialized (${this._bots.size} bot(s))`);
    }

    async _startBot(instance) {
        if (!this._TelegramBot || !instance.telegramBotToken) return;

        try {
            const bot = new this._TelegramBot(instance.telegramBotToken, buildTelegramOptions());

            bot.on('message', async (msg) => {
                try {
                    await this._handleMessage(instance.id, msg);
                } catch (e) {
                    Logger.error(`[Telegram] Message handling error:`, e.message);
                }
            });

            bot.on('polling_error', (err) => {
                Logger.warn(`[Telegram] Polling error for instance ${instance.id}: ${err.code || err.name || 'provider_error'}`);
            });

            // Get bot info
            try {
                const me = await bot.getMe();
                if (me.username && me.username !== instance.telegramBotUsername) {
                    await DB.updateInstance(instance.id, { telegramBotUsername: me.username });
                }
                Logger.info(`[Telegram] ✅ Bot @${me.username} started for instance ${instance.id}`);
            } catch (e) {
                Logger.warn(`[Telegram] Bot verification failed for instance ${instance.id}:`, e.code || e.name || 'unknown');
                return false;
            }

            // Do not interrupt the working poller until the replacement token is verified.
            if (this._bots.has(instance.id)) await this._stopBot(instance.id);
            this._bots.set(instance.id, bot);
            bot.startPolling();
            return true;
        } catch (e) {
            Logger.error(`[Telegram] Failed to start bot for instance ${instance.id}:`, e.code || e.name || 'unknown');
            return false;
        }
    }

    async _stopBot(instanceId) {
        const bot = this._bots.get(instanceId);
        if (bot) {
            try {
                await bot.stopPolling();
            } catch (e) { /* ignore */ }
            this._bots.delete(instanceId);
        }
    }

    async _handleMessage(instanceId, msg) {
        if (!msg.text || !msg.from || msg.from.is_bot || !msg.chat?.id || !Number.isSafeInteger(msg.message_id)) return;
        if (msg.chat?.type && msg.chat.type !== 'private') return;

        const telegramChatId = String(msg.chat.id);
        const senderName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || 'Telegram User';
        const text = msg.text;

        Logger.info(`[Telegram] Message received for instance ${instanceId}`);

        // Find or create client
        let client = await DB.getClientByTelegram(instanceId, telegramChatId);
        if (!client) {
            // Create a chatId for internal use: tg_<telegramChatId>
            const internalChatId = `tg_${telegramChatId}`;
            client = await DB.getOrCreateClient(instanceId, internalChatId, senderName);
            // Update telegramChatId
            DB.run('UPDATE clients SET telegramChatId = ?, preferredChannel = ? WHERE instanceId = ? AND chatId = ?',
                [telegramChatId, 'telegram', instanceId, internalChatId]);
            client = await DB.getClient(instanceId, internalChatId);
        }

        // Persist inbound + response work atomically, before volatile batching.
        const saved = Jobs.recordInbound({instanceId, chatId:client.chatId, originChatId:`tg_${telegramChatId}`,
            channel:'telegram', providerMessageId:String(msg.message_id), senderName, text,
            meta:{telegramChatId}});
        if (!saved.inserted) { await this.recoverPending(); return; }

        DB.getInstance(instanceId)
            .then((instanceConfig) => {
                if (instanceConfig?.salesGoal === 'coffee_pickup' || instanceConfig?.businessType === 'coffee_shop') {
                    const CoffeeFeedbackService = require('./coffee-feedback.service');
                    return CoffeeFeedbackService.handleIncomingFeedback(instanceId, client.chatId, text);
                }
                return null;
            })
            .catch((e) => Logger.warn('[CoffeeFeedback] Telegram feedback handling failed:', e.message));

        this._enqueueJob(saved.job);
    }

    _enqueueJob(job) {
        const queueKey = `${job.instanceId}:telegram:${job.chatId}`;
        if (this.batcher.entries.get(queueKey)?.messages.some(m => m.meta.jobId === job.id)) return;
        return this.batcher.enqueue({
            key:queueKey, text:job.text,
            meta:{...job.meta, instanceId:job.instanceId, chatId:job.chatId, channel:'telegram', jobId:job.id},
            idleMs: this.delayTime,
            shortIdleMs: this.shortDelayTime,
            maxMs: this.maxBatchTime,
            onFlush:(batch, token) => this._processQueuedBatch(job.instanceId, job.chatId, batch, token)
        });
    }

    async recoverPending() {
        Jobs.ensureSchema();
        Jobs.recoverExpiredLeases();
        // Align our own expired provider leases with the shared customer fence.
        // No time-based path clears a send whose provider outcome is unknown.
        Workspace.ensureSchema();
        for (const row of DB.all("SELECT j.*,c.activeSendId,c.activeSendStatus FROM channel_inbound_jobs j JOIN ava_conversation_control c ON c.businessId=j.instanceId AND c.chatId=j.chatId WHERE j.channel='telegram' AND j.status='unknown' AND c.activeSendStatus='sending' LIMIT 200")) {
            const sendId = `telegram-reply:${row.batchKey || row.id}`;
            if (row.activeSendId === sendId) Workspace.endAiSend({businessId:row.instanceId,chatId:row.chatId,sendId,status:'unknown'});
        }
        for (const job of Jobs.pending({channel:'telegram'})) {
            if (job.status === 'acknowledged') await this._repairAcknowledged(job);
            else if (this._bots.has(Number(job.instanceId))) this._enqueueJob(job);
        }
    }

    async _repairAcknowledged(job) {
        const text = job.response?.reply;
        if (!text) return;
        const historyKey = `telegram-reply:${job.batchKey || job.id}`;
        const saved = await DB.saveMessageWithChannel(job.instanceId, job.chatId, 'Bot', text, 'assistant',
            'telegram', job.response?.thought || null, historyKey);
        const stored = saved?.id || DB.get('SELECT id FROM messages WHERE instanceId=? AND chatId=? AND channel=? AND sourceMessageId=?',
            [job.instanceId,job.chatId,'telegram',historyKey])?.id;
        Jobs.complete(job,{providerMessageId:job.outgoingProviderMessageId,storedMessageId:stored});
    }

    async _processQueuedBatch(instanceId, chatId, batch, token) {
        const key = `${instanceId}:telegram:${chatId}`;
        if (this.inFlight.has(key)) return;
        const claimed = Jobs.claimBatch({channel:'telegram',instanceId,chatId,leaseMs:120000});
        if (!claimed) return;
        const db = DB.db;
        this.inFlight.set(key, claimed.leaseToken);
        const heartbeat = setInterval(() => {
            try { if (DB.db === db) Jobs.renew(claimed,{leaseMs:120000}); }
            catch (e) { Logger.warn('[Telegram] Lease renewal failed:',this._errorCode(e)); }
        },20000);
        heartbeat.unref();
        const guard = {isStale:() => DB.db !== db || token?.isStale?.() || !Jobs.isCurrent(claimed)};
        try { await this._processBatch(instanceId,chatId,{...batch,...claimed,job:claimed},guard); }
        catch (e) {
            const code = this._errorCode(e);
            const current = Jobs.get({instanceId,id:claimed.id});
            if (current?.status === 'sending') Jobs.unknown(claimed,code);
            else if (['WORKSPACE_HUMAN_CONTROL','AUTOPILOT_CHANNEL_UNSUPPORTED','BUSINESS_INACTIVE','CHANNEL_RECIPIENT_UNLINKED'].includes(code)) Jobs.suppress(claimed,code);
            else if (['processing','prepared'].includes(current?.status)) Jobs.retry(claimed,code,
                {delayMs:Math.min(60000,5000 * 2 ** Math.min(4,claimed.attempts || 0))});
            Logger.warn('[Telegram] Processing retained:',code);
        } finally {
            clearInterval(heartbeat); this.inFlight.delete(key);
            const current = DB.db === db && db.open ? Jobs.get({instanceId,id:claimed.id}) : null;
            if (['processing','prepared'].includes(current?.status)) Jobs.retry(claimed,'WORKSPACE_DIALOGUE_CHANGED',{delayMs:0});
        }
    }

    async _processBatch(instanceId, clientChatId, batch, token) {
        const batchText = batch?.text || '';

        // Process through AI pipeline
        try {
            const client = await DB.getClient(instanceId, clientChatId);
            if (!client) return;

            const telegramChatId = batch?.meta?.telegramChatId || client.telegramChatId;
            if (!telegramChatId) {
                Logger.warn(`[Telegram] Missing chat ID for instance ${instanceId}`);
                return;
            }

            const history = await DB.getClientHistory(instanceId, client.chatId, 20);
            const instanceConfig = await DB.getInstance(instanceId);

            if (!instanceConfig?.isActive) throw Object.assign(new Error('BUSINESS_INACTIVE'),{code:'BUSINESS_INACTIVE'});
            const guardSnapshot = batch?.guardSnapshot || ChannelContext.capture(instanceId,client.chatId);
            ChannelContext.assertCanSend(instanceId,client.chatId,guardSnapshot,{origin:'ai'});
            if (require('./ava-autopilot.store').policy(instanceId)?.activated) {
                throw Object.assign(new Error('AUTOPILOT_CHANNEL_UNSUPPORTED'),{code:'AUTOPILOT_CHANNEL_UNSUPPORTED'});
            }

            const AIService = require('./ai.service');
            const isCoffeePickup = instanceConfig.salesGoal === 'coffee_pickup';
            let activeCoffeeOrder = null;
            let lastCoffeeOrder = null;
            let lastOrderItems = [];
            let stopList = [];
            let effectiveLeadStatus = client.leadStatus;

            if (isCoffeePickup) {
                await DB.expireStaleOrders(instanceId, client.chatId);
                activeCoffeeOrder = await DB.getActiveOrderForClient(instanceId, client.chatId);
                lastCoffeeOrder = await DB.getLastOrderForClient(instanceId, client.chatId);
                if (lastCoffeeOrder) {
                    lastOrderItems = await DB.getOrderItems(lastCoffeeOrder.id);
                }
                stopList = await DB.getCoffeeStopList(instanceId);
                if (['pickup_confirmed', 'ready_for_pickup'].includes(client.leadStatus) && !activeCoffeeOrder) {
                    effectiveLeadStatus = 'new';
                }
            }

            const context = {
                ...CustomerContext.aiContext(instanceId,client.chatId),
                clientName: client.senderName,
                leadStatus: effectiveLeadStatus,
                originalLeadStatus: client.leadStatus,
                yclientsLink: instanceConfig.yclientsLink,
                systemPrompt: instanceConfig.systemPrompt,
                salesGoal: instanceConfig.salesGoal || 'call',
                instanceConfig,
                instanceId,
                currentBatchText: batchText,
                hasActiveCoffeeOrder: Boolean(activeCoffeeOrder),
                activeOrderStatus: activeCoffeeOrder?.status || null,
                lastOrderStatus: lastCoffeeOrder?.status || null,
                lastOrderSummary: lastCoffeeOrder?.orderSummary || '',
                lastPickupTime: lastCoffeeOrder?.pickupTime || '',
                lastOrderItems,
                stopList,
                coffeeOperations: isCoffeePickup ? {
                    mode: instanceConfig.coffeeOperationMode || 'normal',
                    cafeHours: instanceConfig.coffeeCafeHours || '09:00-00:00',
                    kitchenHours: instanceConfig.coffeeKitchenHours || '09:00-22:00',
                    prepTimeMinutes: instanceConfig.coffeePrepTimeMinutes || 15,
                    busyPrepTimeMinutes: instanceConfig.coffeeBusyPrepTimeMinutes || 25
                } : null
            };

            try {
                const RAGService = require('./rag.service');
                const rag = await RAGService.buildConversationContext(instanceId, client.chatId, batchText, { k: 5 });
                context.ragContext = rag.context;
                context.ragSearched = rag.searched;
                if (context.ragContext) {
                    Logger.info(`[RAG] Found Telegram context for instance ${instanceId}`);
                }
            } catch (e) {
                Logger.warn('[Telegram] RAG search failed:', e.message);
                context.ragContext = '';
            }

            if (this._isBatchStale(token, instanceId, client.chatId, 'before AI call')) throw this._staleError();
            ChannelContext.assertCanSend(instanceId,client.chatId,guardSnapshot,{origin:'ai'});

            const aiResponse = batch?.response || await this._withDeadline(AIService.getResponse(history, context));
            // Preserve the generated draft even when a manager takes over during AI.
            if (batch?.job) Jobs.prepare(batch.job,typeof aiResponse === 'string' ? {reply:aiResponse} : aiResponse,guardSnapshot);
            ChannelContext.assertCanSend(instanceId,client.chatId,guardSnapshot,{origin:'ai'});
            if (this._isBatchStale(token, instanceId, client.chatId, 'after AI call')) throw this._staleError();

            let replyText = '';

            if (typeof aiResponse === 'object') {
                replyText = aiResponse.reply;

                if (isCoffeePickup) {
                    if (client.leadStatus === 'ready_for_pickup' && activeCoffeeOrder?.status === 'ready') {
                        aiResponse.status = 'ready_for_pickup';
                    } else if (client.leadStatus === 'pickup_confirmed' && activeCoffeeOrder?.status === 'accepted') {
                        aiResponse.status = 'pickup_confirmed';
                    } else if (['pickup_confirmed', 'ready_for_pickup', 'booked'].includes(aiResponse.status)) {
                        Logger.warn('[Telegram] AI attempted to close pickup before barista acceptance');
                        aiResponse.status = 'offer';
                    }
                }

                if (aiResponse.status && aiResponse.status !== client.leadStatus) {
                    if (this._isBatchStale(token, instanceId, client.chatId, 'before status update')) return;
                    try {
                        await DB.updateClientStatus(instanceId, client.chatId, aiResponse.status,
                            aiResponse.statusReasoning || 'AI auto-detection (Telegram)', 'ai');
                    } catch (e) {
                        Logger.warn(`[Telegram] Status update failed: ${e.message}`);
                    }
                }

                if (aiResponse.action === 'send_yclients' && instanceConfig.yclientsLink) {
                    replyText += `\n\n📅 Записаться: ${instanceConfig.yclientsLink}`;
                }

                // [NEW] Notify barista bot about new orders from Telegram
                try {
                    if (aiResponse.orderSummary && aiResponse.orderSummary.trim()) {
                        if (this._isBatchStale(token, instanceId, client.chatId, 'before barista dispatch')) return;
                        const BaristaBotService = require('./barista-bot.service');
                        const { order, created, updated, notified } = await BaristaBotService.dispatchOrder(
                            instanceId,
                            client.chatId,
                            client.senderName,
                            aiResponse.orderSummary,
                            aiResponse.pickupTime,
                            aiResponse.orderItems || []
                        );
                        if (order) {
                            if (created) {
                                Logger.info('[Barista] Telegram order created');
                            } else if (updated) {
                                Logger.info('[Barista] Telegram order updated');
                            } else {
                                Logger.info('[Barista] Duplicate active Telegram order ignored');
                            }
                            if (!notified && (created || updated)) {
                                replyText = `${replyText || ''}\n\nЗаявка сохранена. Подтверждение может занять немного больше времени.`.trim();
                            }
                        }
                    }
                } catch (e) {
                    Logger.warn('[Barista] Telegram order notification failed:', e.message);
                }
            } else {
                replyText = aiResponse;
            }

            if (replyText) {
                if (batch?.job) Jobs.prepare(batch.job,{reply:replyText,thought:aiResponse?.thought || null},guardSnapshot);
                await this._sendAndSave(instanceId,client.chatId,telegramChatId,replyText,batch,guardSnapshot,token);
            } else if (batch?.job) {
                Jobs.suppress(batch.job,'TELEGRAM_EMPTY_RESPONSE');
            }

            // Check keyword triggers
            const SmartTriggersService = require('./smart-triggers.service');
            await SmartTriggersService.checkKeywordTriggers(instanceId, client.chatId, batchText);

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
            throw e;
        }
    }

    async _sendAndSave(instanceId,chatId,telegramChatId,text,batch,snapshot,token) {
        const sendId = `telegram-reply:${batch.job.batchKey || batch.job.id}`;
        const beforeSend = () => DB.db.transaction(() => {
            if (token?.isStale?.()) throw this._staleError();
            ChannelContext.assertCanSend(instanceId,chatId,snapshot,{origin:'ai'});
            const Identity = require('./client-identity.service');
            const links = Identity.list(instanceId,chatId);
            if (Identity.resolve(instanceId,`tg_${telegramChatId}`) !== chatId ||
                !links.aliases.some(alias => alias.kind === 'telegram' && String(alias.value) === String(telegramChatId))) {
                throw Object.assign(new Error('CHANNEL_RECIPIENT_UNLINKED'),{code:'CHANNEL_RECIPIENT_UNLINKED'});
            }
            if (require('./ava-autopilot.store').policy(instanceId)?.activated) throw Object.assign(new Error('AUTOPILOT_CHANNEL_UNSUPPORTED'),{code:'AUTOPILOT_CHANNEL_UNSUPPORTED'});
            Workspace.beginAiSend({businessId:instanceId,chatId,revision:snapshot.controlRevision,sendId});
            if (!Jobs.markSending(batch.job)) throw Object.assign(new Error('CHANNEL_LEASE_LOST'),{code:'CHANNEL_LEASE_LOST'});
        }).immediate();
        const result = await this.sendMessageDetailed(instanceId,telegramChatId,text,{origin:'ai',chatId,beforeSend});
        const reserved = DB.get('SELECT activeSendId FROM ava_conversation_control WHERE businessId=? AND chatId=?',[instanceId,chatId])?.activeSendId === sendId;
        if (!result.success) {
            if (reserved) Workspace.endAiSend({businessId:instanceId,chatId,sendId,status:result.safeToRetry?'failed':'unknown'});
            if (result.safeToRetry) {
                const code = result.error || 'TELEGRAM_SEND_FAILED';
                if (['WORKSPACE_HUMAN_CONTROL','AUTOPILOT_CHANNEL_UNSUPPORTED','CHANNEL_RECIPIENT_UNLINKED'].includes(code)) Jobs.suppress(batch.job,code);
                else Jobs.retry(batch.job,code,{delayMs:5000,definiteNoSideEffect:true,
                    ...(reserved ? {guardSnapshot:ChannelContext.capture(instanceId,chatId)} : {})});
            } else Jobs.unknown(batch.job,result.error || 'TELEGRAM_SEND_ACK_UNKNOWN');
            return;
        }
        // ACK is durable before history writes; restart repairs history only.
        DB.db.transaction(() => {
            if (!Jobs.ack(batch.job,{providerMessageId:result.provider_message_id})) throw Object.assign(new Error('CHANNEL_ACK_PERSISTENCE_FAILED'),{code:'CHANNEL_ACK_PERSISTENCE_FAILED'});
            if (reserved) Workspace.endAiSend({businessId:instanceId,chatId,sendId,status:'sent'});
        }).immediate();
        const acknowledged = Jobs.get({instanceId,id:batch.job.id});
        await this._repairAcknowledged({...acknowledged,ids:batch.job.ids});
    }

    _staleError() { return Object.assign(new Error('WORKSPACE_DIALOGUE_CHANGED'),{code:'WORKSPACE_DIALOGUE_CHANGED'}); }
    _errorCode(error) { return /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'TELEGRAM_PROCESSING_FAILED'; }
    async _withDeadline(promise,ms=60000) {
        let timer;
        try { return await Promise.race([promise,new Promise((_,reject) => {timer=setTimeout(() => reject(Object.assign(new Error('TELEGRAM_AI_TIMEOUT'),{code:'TELEGRAM_AI_TIMEOUT'})),ms);})]); }
        finally { clearTimeout(timer); }
    }

    _isBatchStale(token, instanceId, chatId, phase) {
        if (token?.isStale?.()) {
            Logger.info(`[Telegram] [Instance ${instanceId}] Skipping stale AI batch (${phase})`);
            return true;
        }
        return false;
    }

    async sendMessage(instanceId, telegramChatId, text, context = null) {
        return (await this.sendMessageDetailed(instanceId,telegramChatId,text,context)).success;
    }

    async sendMessageDetailed(instanceId, telegramChatId, text, context = null) {
        const bot = this._bots.get(instanceId);
        if (!bot) {
            Logger.warn(`[Telegram] No bot for instance ${instanceId}`);
            return {success:false,channel:'telegram',error:'telegram_not_configured',safeToRetry:true};
        }
        let dispatchStarted = false;
        try {
            if (typeof context?.beforeSend === 'function') {
                const guard=context.beforeSend(); if (guard?.then) await guard;
            }
            dispatchStarted=true;
            const result = await bot.sendMessage(telegramChatId, text);
            const providerId = result?.message_id;
            if (providerId === undefined || providerId === null) return {success:false,channel:'telegram',unknown:true,safeToRetry:false,error:'TELEGRAM_SEND_ACK_UNKNOWN'};
            return {success:true,channel:'telegram',provider_message_id:String(providerId),safeToRetry:false};
        } catch (e) {
            Logger.error(`[Telegram] sendMessage failed:`, e.code || e.name || 'provider_error');
            const status = Number(e?.errorCode || e?.response?.body?.error_code || e?.error_code || e?.statusCode);
            const safeToRetry = !dispatchStarted || (status >= 400 && status < 500);
            return {success:false,channel:'telegram',error:this._errorCode(e),safeToRetry,unknown:!safeToRetry};
        }
    }

    async restartBot(instanceId) {
        const instance = await DB.getInstance(instanceId);
        if (instance?.isActive && instance.telegramBotToken) {
            return Boolean(await this._startBot(instance));
        }
        return false;
    }

    async validateCredentials(instance) {
        try {
            const Bot = this._TelegramBot || require('./telegram-bot-compat');
            const bot = new Bot(instance.telegramBotToken, buildTelegramOptions());
            return Boolean(await bot.getMe());
        } catch (e) {
            Logger.warn(`[Telegram] Candidate verification failed for instance ${instance.id}:`, e.code || e.name || 'unknown');
            return false;
        }
    }

    isActive(instanceId) {
        return this._bots.has(instanceId);
    }
}

module.exports = new TelegramService();
