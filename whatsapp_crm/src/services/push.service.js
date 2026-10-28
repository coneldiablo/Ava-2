const webpush = require('web-push');
const DB = require('./database.service');
const Logger = require('../utils/logger');

class PushService {
    constructor() {
        this._initialized = false;
    }

    init() {
        if (this._initialized) return;

        let publicKey = process.env.VAPID_PUBLIC_KEY;
        let privateKey = process.env.VAPID_PRIVATE_KEY;

        // Auto-generate VAPID keys if not set
        if (!publicKey || !privateKey) {
            Logger.warn('[Push] VAPID keys not found in .env — generating new ones. Copy these to .env for persistence!');
            const keys = webpush.generateVAPIDKeys();
            publicKey = keys.publicKey;
            privateKey = keys.privateKey;
            Logger.info(`[Push] VAPID_PUBLIC_KEY=${publicKey}`);
            Logger.info(`[Push] VAPID_PRIVATE_KEY=${privateKey}`);
            // Store in process.env for this session
            process.env.VAPID_PUBLIC_KEY = publicKey;
            process.env.VAPID_PRIVATE_KEY = privateKey;
        }

        const subject = process.env.VAPID_SUBJECT || 'mailto:admin@whatscrm.local';

        webpush.setVapidDetails(subject, publicKey, privateKey);
        this._initialized = true;
        Logger.success('[Push] Web Push initialized');
    }

    getPublicKey() {
        return process.env.VAPID_PUBLIC_KEY || null;
    }

    _withTimeout(promise, timeoutMs, label) {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs))
        ]);
    }

    async sendToAll(instanceId, payload) {
        if (!this._initialized) this.init();

        const subscriptions = await DB.getPushSubscriptions(instanceId);
        if (!subscriptions || subscriptions.length === 0) return;

        const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

        for (const sub of subscriptions) {
            const pushSub = {
                endpoint: sub.endpoint,
                keys: {
                    p256dh: sub.p256dh,
                    auth: sub.auth,
                },
            };

            try {
                await this._withTimeout(
                    webpush.sendNotification(pushSub, payloadStr),
                    3000,
                    'Web push'
                );
            } catch (err) {
                // 410 Gone = subscription expired, remove it
                if (err.statusCode === 410 || err.statusCode === 404) {
                    Logger.warn(`[Push] Removing stale subscription: ${sub.endpoint.substring(0, 60)}...`);
                    await DB.deletePushSubscription(sub.endpoint);
                } else {
                    Logger.error(`[Push] Error sending notification:`, err.message);
                }
            }
        }
    }

    async notifyNewLead(instanceId, clientName, chatId) {
        await this.sendToAll(instanceId, {
            type: 'new_lead',
            title: '🆕 Новый лид!',
            body: `${clientName} написал(а) первое сообщение`,
            chatId,
        });
    }

    async notifyHumanHelp(instanceId, clientName, chatId) {
        await this.sendToAll(instanceId, {
            type: 'human_help',
            title: '🚨 Нужна помощь менеджера!',
            body: `${clientName} (${chatId.replace('@c.us', '')}) ждёт ответа человека`,
            chatId,
            instanceId,
        });
    }
}

module.exports = new PushService();
