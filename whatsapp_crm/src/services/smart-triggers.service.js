const Logger = require('../utils/logger');
const DB = require('./database.service');

function eventTime(value) {
    if (!value) return NaN;
    // SQLite CURRENT_TIMESTAMP is UTC but has no timezone suffix.
    if (typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)) {
        return new Date(`${value.replace(' ', 'T')}Z`).getTime();
    }
    return new Date(value).getTime();
}

async function occurrenceStart(trigger) {
    const fence = eventTime(await DB.getTriggerOccurrenceFence());
    if (!Number.isFinite(fence)) throw new Error('Trigger occurrence migration fence is missing');
    const created = eventTime(trigger.createdAt);
    return Number.isFinite(created) ? Math.max(fence, created) : fence;
}

class SmartTriggersService {
    constructor() {
        this._timer = null;
        this._running = false;
        this._channelRouter = null;
        this._personalization = null;
    }

    start() {
        if (this._timer) return;
        // Lazy-load to avoid circular deps
        this._channelRouter = require('./channel-router.service');
        this._personalization = require('./personalization.service');
        Logger.info('[SmartTriggers] 🎯 Smart triggers service started (checks every 30s)');
        this._timer = setInterval(() => this._check(), 30 * 1000);
        setTimeout(() => this._check(), 10000);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    // Pure condition check shared by live inbound processing and the customer
    // preview. It deliberately does not inspect or execute actionData.
    matchKeywordText(conditions, messageText) {
        const keywords = Array.isArray(conditions?.keywords) ? conditions.keywords : [];
        if (typeof messageText !== 'string') return { matched: false, matchedKeyword: null };
        const lowerText = messageText.toLowerCase();
        const matchedKeyword = keywords.find(keyword => typeof keyword === 'string'
            && keyword.trim() && lowerText.includes(keyword.toLowerCase()));
        return { matched: Boolean(matchedKeyword), matchedKeyword: matchedKeyword || null };
    }

    async _check() {
        if (this._running) return;
        this._running = true;
        try {
            await DB.pruneTriggerOccurrences();
            const instances = await DB.getInstances();
            for (const instance of instances) {
                if (!instance.isActive || !instance.smartTriggersEnabled) continue;
                await this._checkInstance(instance);
            }
        } catch (e) {
            Logger.error('[SmartTriggers] Check error:', e.message);
        } finally {
            this._running = false;
        }
    }

    async _checkInstance(instance) {
        const triggers = await DB.getActiveTriggers(instance.id);
        if (triggers.length === 0) return;

        for (const trigger of triggers) {
            try {
                await this._processTrigger(instance, trigger);
            } catch (e) {
                Logger.error(`[SmartTriggers] Error processing trigger ${trigger.id}:`, e.message);
            }
        }
    }

    async _processTrigger(instance, trigger) {
        const conditions = typeof trigger.conditions === 'string' ? JSON.parse(trigger.conditions) : trigger.conditions;
        const actionData = typeof trigger.actionData === 'string' ? JSON.parse(trigger.actionData) : trigger.actionData;

        switch (trigger.triggerType) {
            case 'silence':
                await this._checkSilenceTrigger(instance, trigger, conditions, actionData);
                break;
            case 'status_change':
                await this._checkStatusChangeTrigger(instance, trigger, conditions, actionData);
                break;
            case 'keyword':
                // Keyword triggers are checked synchronously in whatsapp pipeline
                break;
            case 'time_based':
                await this._checkTimeBasedTrigger(instance, trigger, conditions, actionData);
                break;
            case 'new_lead':
                await this._checkNewLeadTrigger(instance, trigger, conditions, actionData);
                break;
            case 'sentiment':
                await this._checkSentimentTrigger(instance, trigger, conditions, actionData);
                break;
        }
    }

    async _checkSilenceTrigger(instance, trigger, conditions, actionData) {
        const silenceHours = conditions.silenceHours || 24;
        const statuses = conditions.statuses || null;

        const clients = await DB.getClientsForTrigger(instance.id, statuses);
        for (const client of clients) {
            if (!client.lastMessageTime) continue;
            const hoursSilent = (Date.now() - new Date(client.lastMessageTime).getTime()) / (1000 * 60 * 60);
            if (hoursSilent >= silenceHours) {
                await this._executeAction(instance, client, trigger, actionData);
            }
        }
    }

    async _checkStatusChangeTrigger(instance, trigger, conditions, actionData) {
        const targetStatus = conditions.targetStatus;
        if (!targetStatus) return;

        // Revisit a bounded horizon so a short poll outage does not lose source events.
        const recentChanges = await DB.getRecentStatusChanges(instance.id, 24 * 60);
        const notBefore = await occurrenceStart(trigger);
        for (const change of recentChanges) {
            if (eventTime(change.createdAt) < notBefore) continue;
            if (change.toStatus === targetStatus) {
                const client = await DB.getClient(instance.id, change.chatId);
                if (client) {
                    await this._runOccurrence(instance, client, trigger, actionData, `status:${change.id}`);
                }
            }
        }
    }

    async _checkTimeBasedTrigger(instance, trigger, conditions, actionData) {
        const targetHour = conditions.hour;
        const targetDays = conditions.days || [0, 1, 2, 3, 4, 5, 6];
        const statuses = conditions.statuses || null;

        const now = Date.now();
        const notBefore = await occurrenceStart(trigger);
        const slots = [];
        for (let offset = 0; offset <= 24; offset++) {
            const slot = new Date(Math.floor(now / 3600000) * 3600000 - offset * 3600000);
            if (slot.getHours() === targetHour && targetDays.includes(slot.getDay())) slots.push(slot);
        }
        if (!slots.length) return;
        const clients = await DB.getClientsForTrigger(instance.id, statuses);
        for (const slot of slots) {
            if (slot.getTime() < notBefore) continue;
            for (const client of clients) {
                if (client.createdAt && eventTime(client.createdAt) > slot.getTime()) continue;
                await this._runOccurrence(instance, client, trigger, actionData, `schedule:${slot.toISOString()}`);
            }
        }
    }

    async _checkNewLeadTrigger(instance, trigger, conditions, actionData) {
        const notBefore = await occurrenceStart(trigger);
        const clients = await DB.getClientsForTrigger(instance.id, ['new']);
        for (const client of clients) {
            if (!client.createdAt) continue;
            if (eventTime(client.createdAt) < notBefore) continue;
            const minutesAgo = (Date.now() - eventTime(client.createdAt)) / (1000 * 60);
            if (minutesAgo >= 0 && minutesAgo <= 24 * 60) {
                await this._runOccurrence(instance, client, trigger, actionData, `lead:${client.id}:${client.createdAt}`);
            }
        }
    }

    async _runOccurrence(instance, client, trigger, actionData, sourceKey) {
        // A crash after provider acceptance but before completion can resend after lease expiry.
        // The channel provider has no shared idempotency key, so this is at-least-once delivery.
        const token = await DB.claimTriggerOccurrence(instance.id, trigger.id, client.chatId, sourceKey);
        if (!token) return;
        let outcome = false;
        try {
            outcome = await this._executeAction(instance, client, trigger, actionData);
            // Cooldown/max are decisions about this event, not delivery errors to retry later.
        } finally {
            await DB.finishTriggerOccurrence(instance.id, trigger.id, client.chatId, sourceKey, token, outcome);
        }
    }

    async _checkSentimentTrigger(instance, trigger, conditions, actionData) {
        const threshold = conditions.threshold || 0.3;
        const clients = await DB.getClientsForTrigger(instance.id, conditions.statuses || null);

        for (const client of clients) {
            const profile = await DB.getClientProfile(instance.id, client.chatId);
            if (profile && profile.sentimentScore < threshold) {
                await this._executeAction(instance, client, trigger, actionData);
            }
        }
    }

    async _executeAction(instance, client, trigger, actionData) {
        if (!instance || !client || Number(instance.id) !== Number(client.instanceId)) return false;
        // A trigger can be queued just before an owner switches automation off.
        // Re-read the tenant switch at the last side-effect boundary.
        const currentInstance = await DB.getInstance(instance.id);
        // A paused/disabled business must not replay old marketing events when
        // it is enabled again. Only delivery failures remain retryable.
        if (!currentInstance?.isActive || !currentInstance.smartTriggersEnabled) return 'suppressed';
        actionData = actionData && typeof actionData === 'object' ? actionData : {};
        // Check cooldown
        if (trigger.cooldownMinutes > 0) {
            const lastExec = await DB.getLastTriggerExecution(instance.id, client.chatId, trigger.id);
            if (lastExec) {
                const minutesSince = (Date.now() - eventTime(lastExec.createdAt)) / (1000 * 60);
                if (minutesSince < trigger.cooldownMinutes) return 'suppressed';
            }
        }

        // Check max executions
        if (trigger.maxExecutions > 0) {
            const execCount = await DB.getTriggerExecutionCount(instance.id, client.chatId, trigger.id);
            if (execCount >= trigger.maxExecutions) return 'suppressed';
        }

        Logger.info(`[SmartTriggers] 🎯 Firing trigger "${trigger.name}" for ${client.senderName} (${client.chatId})`);

        try {
            switch (trigger.actionType) {
                case 'send_message':
                    if (typeof actionData.message === 'string' && actionData.message.trim() && this._channelRouter) {
                        let msg = actionData.message;
                        msg = msg.replace('{clientName}', client.senderName || '');
                        if (!await this._channelRouter.sendMessage(instance.id, client.chatId, msg)) return false;
                    } else return typeof actionData.message === 'string' && actionData.message.trim() ? false : 'suppressed';
                    break;

                case 'change_status':
                    if (actionData.status) {
                        await DB.updateClientStatus(instance.id, client.chatId, actionData.status, `Trigger: ${trigger.name}`, 'trigger');
                    } else return 'suppressed';
                    break;

                case 'notify_manager':
                    try {
                        const PushService = require('./push.service');
                        await PushService.sendToAll(instance.id, {
                            type: 'trigger',
                            title: `🎯 ${trigger.name}`,
                            body: `Клиент: ${client.senderName} (${client.chatId.replace('@c.us', '')})`,
                        });
                    } catch (e) {
                        Logger.warn('[SmartTriggers] Push notification failed:', e.message);
                        return false;
                    }
                    break;

                case 'start_sequence':
                    if (actionData.sequenceId) {
                        const sequence = await DB.get('SELECT id FROM message_sequences WHERE id = ? AND instanceId = ? AND isActive = 1',
                            [actionData.sequenceId, instance.id]);
                        if (!sequence) return 'suppressed';
                        await DB.assignClientToSequence(instance.id, client.chatId, actionData.sequenceId);
                    } else return 'suppressed';
                    break;

                case 'send_offer':
                    if (this._personalization) {
                        const offer = await this._personalization.generatePersonalizedOffer(instance.id, client.chatId);
                        if (offer && offer.offerText && this._channelRouter) {
                            if (!await this._channelRouter.sendMessage(instance.id, client.chatId, offer.offerText)) return false;
                        } else return false;
                    } else return false;
                    break;
                default:
                    return 'suppressed';
            }

            // Log execution
            await DB.logTriggerExecution(instance.id, client.chatId, trigger.id, trigger.triggerType, trigger.actionType, {
                clientName: client.senderName,
                actionData
            });
            return true;

        } catch (e) {
            Logger.error(`[SmartTriggers] Action execution error for trigger ${trigger.id}:`, e.message);
            return false;
        }
    }

    // Called synchronously from whatsapp/telegram pipeline for keyword triggers
    async checkKeywordTriggers(instanceId, chatId, messageText) {
        try {
            const instance = await DB.getInstance(instanceId);
            if (!instance?.isActive || !instance.smartTriggersEnabled) return;
            const triggers = await DB.getActiveTriggers(instanceId);
            const keywordTriggers = triggers.filter(t => t.triggerType === 'keyword');

            for (const trigger of keywordTriggers) {
                const conditions = typeof trigger.conditions === 'string' ? JSON.parse(trigger.conditions) : trigger.conditions;
                const { matched } = this.matchKeywordText(conditions, messageText);
                if (matched) {
                    const client = await DB.getClient(instanceId, chatId);
                    if (client) {
                        const actionData = typeof trigger.actionData === 'string' ? JSON.parse(trigger.actionData) : trigger.actionData;
                        await this._executeAction(instance, client, trigger, actionData);
                    }
                }
            }
        } catch (e) {
            Logger.error('[SmartTriggers] checkKeywordTriggers error:', e.message);
        }
    }
}

module.exports = new SmartTriggersService();
