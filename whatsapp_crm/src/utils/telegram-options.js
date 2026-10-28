const Logger = require('./logger');

function buildTelegramOptions() {
    const options = {};
    const proxyUrl = String(process.env.TELEGRAM_PROXY_URL || '').trim();

    if (!proxyUrl) return options;

    try {
        new URL(proxyUrl);
        options.proxyUrl = proxyUrl;
        Logger.info('[Telegram] Egress proxy enabled');
    } catch (error) {
        Logger.warn('[Telegram] Could not initialize egress proxy:', error.message);
    }

    return options;
}

module.exports = { buildTelegramOptions };
