const { Bot } = require('node-telegram-bot-api');
const nodeFetch = require('node-fetch');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

function createFetch(proxyUrl) {
    if (!proxyUrl) return globalThis.fetch;
    const protocol = new URL(proxyUrl).protocol;
    const agent = protocol === 'http:' || protocol === 'https:'
        ? new HttpsProxyAgent(proxyUrl) : new SocksProxyAgent(proxyUrl);
    return (url, options = {}) => nodeFetch(url, { ...options, agent });
}

/**
 * Small compatibility boundary for node-telegram-bot-api v2.
 * The rest of the CRM keeps its established v1-shaped calls while all network
 * work is performed by the maintained v2 transport.
 */
class TelegramBotCompat {
    constructor(token, options = {}) {
        const proxyUrl = String(options.proxyUrl || process.env.TELEGRAM_PROXY_URL || '').trim();
        const BotClass = options.BotClass || Bot;
        this._errorHandler = null;
        this._pollPromise = null;
        this._bot = new BotClass(token, {
            fetch: options.fetch || createFetch(proxyUrl),
            timeoutMs: 300000,
            // A send has no idempotency key; ambiguous transport failures must
            // be reconciled by the durable caller instead of replayed here.
            maxRetries: 0,
        });
        this._bot.catch((error) => {
            if (this._errorHandler) this._errorHandler(error);
        });
    }

    on(event, handler) {
        if (event === 'polling_error') {
            this._errorHandler = handler;
            return this;
        }
        if (event === 'message') {
            this._bot.on('message', (ctx) => handler(ctx.message));
            return this;
        }
        if (event === 'callback_query') {
            this._bot.on('callback_query', (ctx) => handler(ctx.callbackQuery));
            return this;
        }
        throw new Error(`Unsupported Telegram event: ${event}`);
    }

    onText(pattern, handler) {
        this._bot.hears(pattern, (ctx) => handler(ctx.message, ctx.match));
        return this;
    }

    startPolling() {
        if (this._pollPromise) return this._pollPromise;
        this._pollPromise = this._bot.startPolling()
            .catch((error) => {
                if (this._errorHandler) this._errorHandler(error);
            })
            .finally(() => {
                this._pollPromise = null;
            });
        return this._pollPromise;
    }

    async stopPolling() {
        this._bot.stop();
        await this._pollPromise;
    }

    getMe() {
        return this._bot.api.getMe();
    }

    sendMessage(chatId, text, options = {}) {
        return this._bot.api.sendMessage({ chat_id: chatId, text, ...options });
    }

    editMessageText(text, options = {}) {
        return this._bot.api.editMessageText({ text, ...options });
    }

    answerCallbackQuery(callbackQueryId, options = {}) {
        return this._bot.api.answerCallbackQuery({ callback_query_id: callbackQueryId, ...options });
    }
}

module.exports = TelegramBotCompat;
