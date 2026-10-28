const Logger = require('../utils/logger');
const DB = require('./database.service');
const PushService = require('./push.service');

class CoffeeFeedbackService {
    constructor() {
        this._timer = null;
        this.intervalMs = Math.max(parseInt(process.env.COFFEE_FEEDBACK_INTERVAL_MS, 10) || 5 * 60 * 1000, 30 * 1000);
    }

    start() {
        if (this._timer) return;
        this._timer = setInterval(() => {
            this.processDueFeedback().catch((e) => Logger.warn('[CoffeeFeedback] process error:', e.message));
        }, this.intervalMs);
        this.processDueFeedback().catch((e) => Logger.warn('[CoffeeFeedback] initial process error:', e.message));
        Logger.info(`[CoffeeFeedback] Service started, interval ${Math.round(this.intervalMs / 1000)}s`);
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    async processDueFeedback() {
        const orders = await DB.getDueCoffeeFeedbackOrders(50);
        if (!orders.length) return 0;

        const ChannelRouter = require('./channel-router.service');
        let sent = 0;
        for (const order of orders) {
            const text = String(order.coffeeFeedbackText || '').trim()
                || 'Спасибо, что зашли. Всё было хорошо с заказом?';
            const ok = await ChannelRouter.sendMessage(order.instanceId, order.chatId, text);
            if (ok) {
                await DB.markOrderFeedbackSent(order.id);
                sent++;
            }
        }
        if (sent > 0) Logger.info(`[CoffeeFeedback] Sent ${sent} feedback request(s)`);
        return sent;
    }

    classify(text) {
        const value = String(text || '').toLowerCase();
        const negative = [
            'плохо', 'ужас', 'не понрав', 'невкус', 'холодн', 'долго', 'ошиб',
            'не то', 'проблем', 'разочар', 'груб', 'ждал', 'опоздал'
        ];
        const positive = ['спасибо', 'хорошо', 'отлично', 'вкусно', 'супер', 'понрав', 'класс'];

        if (negative.some((word) => value.includes(word))) return 'negative';
        if (positive.some((word) => value.includes(word))) return 'positive';
        return 'neutral';
    }

    async handleIncomingFeedback(instanceId, chatId, text) {
        const order = await DB.getLatestFeedbackCandidate(instanceId, chatId);
        if (!order) return null;

        const sentiment = this.classify(text);
        const feedback = await DB.saveCoffeeFeedback(instanceId, chatId, order.id, sentiment, text);

        if (['negative', 'problem'].includes(sentiment)) {
            const client = await DB.getClient(instanceId, chatId);
            await PushService.notifyHumanHelp(instanceId, client?.senderName || 'Клиент', chatId)
                .catch((e) => Logger.warn('[CoffeeFeedback] human-help push failed:', e.message));
        }

        return feedback;
    }
}

module.exports = new CoffeeFeedbackService();
