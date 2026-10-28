const Logger = require('../utils/logger');
const DB = require('./database.service');

class SequenceService {
    constructor() {
        this._timer = null;
        this._running = false;
        this._channelRouter = null;
        this._personalization = null;
    }

    start() {
        if (this._timer) return;
        this._channelRouter = require('./channel-router.service');
        this._personalization = require('./personalization.service');
        Logger.info('[Sequences] 📋 Sequence service started (checks every 60s)');
        this._timer = setInterval(() => this._processSequences(), 60 * 1000);
        setTimeout(() => this._processSequences(), 15000);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    async _processSequences() {
        if (this._running) return;
        this._running = true;
        try {
            const activeItems = await DB.getActiveClientSequences();
            for (const item of activeItems) {
                await this._processSequenceStep(item);
            }
        } catch (e) {
            Logger.error('[Sequences] Process error:', e.message);
        } finally {
            this._running = false;
        }
    }

    async _processSequenceStep(clientSeq) {
        try {
            const instance = await DB.getInstance(clientSeq.instanceId);
            if (!instance?.isActive || !instance.smartTriggersEnabled) return;
            const sequence = await DB.getSequence(clientSeq.sequenceId);
            if (!sequence || sequence.instanceId !== clientSeq.instanceId || !sequence.isActive) return;
            const steps = await DB.getSequenceSteps(clientSeq.sequenceId);
            if (!steps || steps.length === 0) {
                await DB.updateClientSequence(clientSeq.id, { status: 'completed', completedAt: new Date().toISOString() });
                return;
            }

            const currentStepIdx = clientSeq.currentStep;
            const step = steps[currentStepIdx];

            if (!step) {
                await DB.updateClientSequence(clientSeq.id, { status: 'completed', completedAt: new Date().toISOString() });
                Logger.info(`[Sequences] ✅ Sequence "${clientSeq.sequenceName}" completed for ${clientSeq.chatId}`);
                return;
            }

            // Build message from template
            let message = step.messageTemplate;
            const client = await DB.getClient(clientSeq.instanceId, clientSeq.chatId);

            if (client) {
                message = message.replace(/\{clientName\}/g, client.senderName || '');
            }

            // AI personalization if enabled
            if (step.useAiPersonalization && this._personalization) {
                const profile = await DB.getClientProfile(clientSeq.instanceId, clientSeq.chatId);
                if (profile) {
                    message = message.replace(/\{need\}/g, profile.needs || '');
                    message = message.replace(/\{budget\}/g, profile.budget || '');

                    try {
                        const instanceConfig = await DB.getInstance(clientSeq.instanceId);
                        const AIService = require('./ai.service');
                        const msgs = [
                            {
                                role: 'system',
                                content: `Перепиши сообщение для клиента, адаптируя под его стиль общения (${profile.communicationStyle}).
Профиль: потребности — ${profile.needs || 'не выявлены'}, бюджет — ${profile.budget || 'не указан'}.
Верни ТОЛЬКО текст сообщения, без пояснений, без кавычек.`
                            },
                            { role: 'user', content: message }
                        ];
                        const personalized = await AIService._callProviderPlain(msgs, instanceConfig);
                        if (personalized && personalized.trim()) {
                            message = personalized.trim().replace(/^["']|["']$/g, '');
                        }
                    } catch (e) {
                        Logger.warn('[Sequences] AI personalization failed, using template as-is:', e.message);
                    }
                }
            }

            // Send message
            const channel = step.channelOverride || (client ? client.preferredChannel : 'whatsapp') || 'whatsapp';
            // The owner may disable automation while AI personalization runs.
            const currentInstance = await DB.getInstance(clientSeq.instanceId);
            if (!currentInstance?.isActive || !currentInstance.smartTriggersEnabled) return;
            if (!this._channelRouter) return;
            // A durable compare-and-swap closes the retry window before any external I/O.
            // Even a process crash or ambiguous provider result requires manual review.
            if (!await DB.claimClientSequenceDelivery(clientSeq, channel)) return;
            let sent = false;
            try {
                sent = await this._channelRouter.sendMessage(clientSeq.instanceId, clientSeq.chatId, message, channel);
            } catch (e) {
                await DB.recordClientSequenceDeliveryFailure(clientSeq.id, 'send_exception');
                Logger.warn(`[Sequences] Delivery exception for clientSeq ${clientSeq.id}; manual review required`);
                return;
            }
            if (sent !== true) {
                await DB.recordClientSequenceDeliveryFailure(clientSeq.id, 'send_returned_false');
                Logger.warn(`[Sequences] Delivery failed for clientSeq ${clientSeq.id}; manual review required`);
                return;
            }

            // Advance to next step
            const nextStepIdx = currentStepIdx + 1;
            if (nextStepIdx >= steps.length) {
                await DB.updateClientSequence(clientSeq.id, {
                    currentStep: nextStepIdx,
                    status: 'completed',
                    completedAt: new Date().toISOString(),
                    deliveryFailureCode: null,
                    deliveryFailureChannel: null,
                    deliveryFailureStep: null
                });
                Logger.info(`[Sequences] 📤 Sent step ${currentStepIdx + 1}/${steps.length} of "${clientSeq.sequenceName}" to ${clientSeq.chatId}`);
                Logger.info(`[Sequences] ✅ Sequence "${clientSeq.sequenceName}" completed for ${clientSeq.chatId}`);
            } else {
                const nextStep = steps[nextStepIdx];
                const delayMin = nextStep ? nextStep.delayMinutes : 60;
                const nextStepAt = new Date(Date.now() + delayMin * 60 * 1000).toISOString();
                await DB.updateClientSequence(clientSeq.id, {
                    currentStep: nextStepIdx,
                    nextStepAt,
                    status: 'active',
                    deliveryFailureCode: null,
                    deliveryFailureChannel: null,
                    deliveryFailureStep: null
                });
                Logger.info(`[Sequences] 📤 Sent step ${currentStepIdx + 1}/${steps.length} of "${clientSeq.sequenceName}" to ${clientSeq.chatId}`);
            }

        } catch (e) {
            Logger.error(`[Sequences] Step processing error for clientSeq ${clientSeq.id}:`, e.message);
        }
    }

    // Called when client replies during a sequence — pause the sequence
    async onClientReply(instanceId, chatId) {
        try {
            const activeSeqs = await DB.getClientActiveSequences(instanceId, chatId);
            const running = activeSeqs.filter(s => s.status === 'active');
            if (running.length > 0) {
                await DB.pauseClientSequences(instanceId, chatId);
                Logger.info(`[Sequences] ⏸️ Paused ${running.length} sequence(s) for ${chatId} (client replied)`);
            }
        } catch (e) {
            Logger.error('[Sequences] onClientReply error:', e.message);
        }
    }
}

module.exports = new SequenceService();
