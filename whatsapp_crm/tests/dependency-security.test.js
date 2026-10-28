const { describe, it, assert, createTestDB } = require('./test-helper');
const axios = require('axios');
const writeExcelFile = require('write-excel-file/node');

const DB = require('../src/services/database.service');
const TelegramBotCompat = require('../src/services/telegram-bot-compat');
const YookassaService = require('../src/services/yookassa.service');

class FakeTelegramBot {
    constructor() {
        this.handlers = {};
        this.stopped = false;
        this.api = {
            getMe: async () => ({ username: 'secure_bot' }),
            sendMessage: async (payload) => payload,
            editMessageText: async (payload) => payload,
            answerCallbackQuery: async (payload) => payload,
        };
    }

    catch(handler) { this.errorHandler = handler; }
    on(kind, handler) { this.handlers[kind] = handler; }
    hears(pattern, handler) { this.hearsPattern = pattern; this.hearsHandler = handler; }
    async startPolling() {}
    stop() { this.stopped = true; }
}

describe('Dependency security migrations', () => {
    it('Telegram v2 compatibility boundary preserves the established bot contract', async () => {
        const bot = new TelegramBotCompat('test-token', { BotClass: FakeTelegramBot, fetch: async () => {} });
        let receivedMessage = null;
        bot.on('message', (message) => { receivedMessage = message; });
        await bot._bot.handlers.message({ message: { text: 'Привет' } });
        assert.deepStrictEqual(receivedMessage, { text: 'Привет' });

        const sent = await bot.sendMessage(123, 'Ответ', { parse_mode: 'HTML' });
        assert.deepStrictEqual(sent, { chat_id: 123, text: 'Ответ', parse_mode: 'HTML' });
        await bot.stopPolling();
        assert.strictEqual(bot._bot.stopped, true);
    });

    it('YooKassa uses the current HTTPS API without the deprecated request package', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Payment Hotel' });
        await DB.updateInstance(instance.id, {
            yookassaShopId: 'shop-42',
            yookassaSecretKey: 'secret-42',
        });

        const originalPost = axios.post;
        let request = null;
        axios.post = async (url, payload, options) => {
            request = { url, payload, options };
            return {
                data: {
                    id: 'payment-42',
                    status: 'pending',
                    confirmation: { confirmation_url: 'https://yookassa.test/pay/42' },
                },
            };
        };
        try {
            const result = await YookassaService.createPaymentLink(instance.id, '79990000000@c.us', 1250, 'Бронирование');
            assert.strictEqual(result.paymentId, 'payment-42');
            assert.strictEqual(request.url, 'https://api.yookassa.ru/v3/payments');
            assert.deepStrictEqual(request.options.auth, { username: 'shop-42', password: 'secret-42' });
            assert.strictEqual(request.options.maxRedirects, 0);
            assert.ok(request.options.headers['Idempotence-Key']);
        } finally {
            axios.post = originalPost;
        }
    });

    it('XLSX export writer creates an Office ZIP without vulnerable SheetJS', async () => {
        const buffer = await writeExcelFile([
            { sheet: 'Лиды', data: [['Имя'], ['Иван']], stickyRowsCount: 1 },
            { sheet: 'История', data: [['Статус'], ['Новый']], stickyRowsCount: 1 },
        ]).toBuffer();
        assert.ok(Buffer.isBuffer(buffer));
        assert.strictEqual(buffer.subarray(0, 2).toString(), 'PK');
    });
});
