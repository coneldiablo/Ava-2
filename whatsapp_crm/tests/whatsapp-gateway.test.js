const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const OpenWaService = require('../src/services/openwa.service');
const GreenApiService = require('../src/services/green-api.service');
const WhatsAppGatewayService = require('../src/services/whatsapp-gateway.service');
const WhatsAppService = require('../src/services/whatsapp.service');

describe('WhatsApp Gateway & OpenWA Switch Tests', () => {
    it('OpenWaService should correctly normalize URLs, headers and chat IDs', () => {
        assert.strictEqual(OpenWaService.formatChatId('79991234567'), '79991234567@c.us');
        assert.strictEqual(OpenWaService.formatChatId('+7 (999) 123-45-67'), '79991234567@c.us');
        assert.strictEqual(OpenWaService.formatChatId('123456-789@g.us'), '123456-789@g.us');

        assert.strictEqual(OpenWaService._baseUrl('http://localhost:2785'), 'http://localhost:2785/api');
        assert.strictEqual(OpenWaService._baseUrl('http://localhost:2785/api/'), 'http://localhost:2785/api');

        const headers = OpenWaService._headers('my-test-key');
        assert.strictEqual(headers['X-API-Key'], 'my-test-key');
        assert.strictEqual(headers['Content-Type'], 'application/json');
    });

    it('OpenWaService should inherit the shared Docker endpoint and key for legacy tenant rows', () => {
        const previousUrl = process.env.OPENWA_URL;
        const previousKey = process.env.OPENWA_API_KEY;
        process.env.OPENWA_URL = 'http://whatsapp_crm_openwa:2785';
        process.env.OPENWA_API_KEY = 'shared-openwa-key';

        try {
            assert.strictEqual(
                OpenWaService._baseUrl('http://localhost:2785'),
                'http://whatsapp_crm_openwa:2785/api'
            );
            assert.strictEqual(
                OpenWaService._baseUrl('https://external-openwa.example'),
                'https://external-openwa.example/api'
            );
            assert.strictEqual(OpenWaService._headers('')['X-API-Key'], 'shared-openwa-key');
            assert.strictEqual(OpenWaService._headers('tenant-override')['X-API-Key'], 'tenant-override');
        } finally {
            if (previousUrl === undefined) delete process.env.OPENWA_URL;
            else process.env.OPENWA_URL = previousUrl;
            if (previousKey === undefined) delete process.env.OPENWA_API_KEY;
            else process.env.OPENWA_API_KEY = previousKey;
        }
    });

    it('Database schema should support OpenWA columns and getInstanceByOpenWaSession', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'OpenWA Test Hotel' });
        
        await DB.updateInstance(instance.id, {
            whatsappProvider: 'openwa',
            openWaUrl: 'http://localhost:2785',
            openWaApiKey: 'owa_k1_secret',
            openWaSessionId: 'test-session-uuid-123',
            greenApiInstance: '11034455',
            greenApiToken: 'green-token-abc'
        });

        const updated = await DB.getInstance(instance.id);
        assert.strictEqual(updated.whatsappProvider, 'openwa');
        assert.strictEqual(updated.openWaUrl, 'http://localhost:2785');
        assert.strictEqual(updated.openWaApiKey, 'owa_k1_secret');
        assert.strictEqual(updated.openWaSessionId, 'test-session-uuid-123');
        assert.strictEqual(updated.greenApiInstance, '11034455');

        const foundBySession = await DB.getInstanceByOpenWaSession('test-session-uuid-123');
        assert.ok(foundBySession);
        assert.strictEqual(foundBySession.id, instance.id);
    });

    it('WhatsAppGatewayService should send via primary OpenWA when available', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Primary OpenWA Test' });
        await DB.updateInstance(instance.id, {
            whatsappProvider: 'openwa',
            openWaSessionId: 'sess-openwa-1',
            openWaApiKey: 'key-1',
            greenApiInstance: 'green-inst-1',
            greenApiToken: 'green-tok-1'
        });
        const inst = await DB.getInstance(instance.id);

        const origOpenWaSend = OpenWaService.sendMessage;
        const origGreenSend = GreenApiService.sendMessage;

        let openWaCalled = false;
        let greenApiCalled = false;

        OpenWaService.sendMessage = async (url, key, sessionId, chatId, text) => {
            openWaCalled = true;
            return {
                success: true,
                data: { messageId: 'openwa_msg_100', timestamp: 1719312000 }
            };
        };

        GreenApiService.sendMessage = async () => {
            greenApiCalled = true;
            return { success: true, data: { idMessage: 'green_msg_100' } };
        };

        try {
            const result = await WhatsAppGatewayService.sendMessage(inst, '79991112233@c.us', 'Привет из OpenWA!');
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.gateway, 'openwa');
            assert.strictEqual(result.fallback, false);
            assert.strictEqual(openWaCalled, true);
            assert.strictEqual(greenApiCalled, false);
        } finally {
            OpenWaService.sendMessage = origOpenWaSend;
            GreenApiService.sendMessage = origGreenSend;
        }
    });

    it('WhatsAppGatewayService should automatically fallback to GreenAPI if OpenWA fails', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Fallback Test Hotel' });
        await DB.updateInstance(instance.id, {
            whatsappProvider: 'openwa',
            openWaSessionId: 'sess-openwa-stuck',
            openWaApiKey: 'key-stuck',
            greenApiInstance: 'green-inst-backup',
            greenApiToken: 'green-tok-backup'
        });
        const inst = await DB.getInstance(instance.id);

        const origOpenWaSend = OpenWaService.sendMessage;
        const origGreenSend = GreenApiService.sendMessage;

        let openWaTried = false;
        let greenApiFallbackUsed = false;

        OpenWaService.sendMessage = async () => {
            openWaTried = true;
            return { success: false, statusCode: 404, error: 'Fixture session not found' };
        };

        GreenApiService.sendMessage = async (idInst, token, url, chatId, text) => {
            greenApiFallbackUsed = true;
            return { success: true, data: { idMessage: 'fallback_green_msg_999' } };
        };

        try {
            const result = await WhatsAppGatewayService.sendMessage(inst, '79991112233@c.us', 'Резервное сообщение');
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.gateway, 'green_api');
            assert.strictEqual(result.fallback, true);
            assert.strictEqual(openWaTried, true);
            assert.strictEqual(greenApiFallbackUsed, true);
            assert.strictEqual(result.data.idMessage, 'fallback_green_msg_999');
        } finally {
            OpenWaService.sendMessage = origOpenWaSend;
            GreenApiService.sendMessage = origGreenSend;
        }
    });

    it('WhatsAppGatewayService should respect mode=green_api and bypass OpenWA', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'GreenAPI Only Hotel' });
        await DB.updateInstance(instance.id, {
            whatsappProvider: 'green_api',
            openWaSessionId: 'sess-ignored',
            greenApiInstance: 'green-inst-direct',
            greenApiToken: 'green-tok-direct'
        });
        const inst = await DB.getInstance(instance.id);

        const origOpenWaSend = OpenWaService.sendMessage;
        const origGreenSend = GreenApiService.sendMessage;

        let openWaCalled = false;
        let greenApiCalled = false;

        OpenWaService.sendMessage = async () => {
            openWaCalled = true;
            return { success: true };
        };

        GreenApiService.sendMessage = async () => {
            greenApiCalled = true;
            return { success: true, data: { idMessage: 'direct_green_123' } };
        };

        try {
            const result = await WhatsAppGatewayService.sendMessage(inst, '79991112233@c.us', 'Только Green API');
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.gateway, 'green_api');
            assert.strictEqual(result.fallback, false);
            assert.strictEqual(openWaCalled, false);
            assert.strictEqual(greenApiCalled, true);
        } finally {
            OpenWaService.sendMessage = origOpenWaSend;
            GreenApiService.sendMessage = origGreenSend;
        }
    });

    it('WhatsAppService.processOpenWaWebhook should process incoming message and ignore outgoing message', async () => {
        createTestDB();
        const instance = await DB.createInstance({ name: 'Webhook Test Instance' });
        const chatId = '79997778899@c.us';

        // 1. Inbound message from client
        const inboundPayload = {
            event: 'message.received',
            sessionId: 'test-session-wh',
            data: {
                id: 'wa_inbound_1',
                chatId,
                from: chatId,
                body: 'Здравствуйте! Сколько стоит номер?',
                fromMe: false,
                pushName: 'Иван Клиент',
                type: 'text'
            }
        };

        await WhatsAppService.processOpenWaWebhook(inboundPayload, instance.id);

        const client = await DB.getClient(instance.id, chatId);
        assert.ok(client);
        assert.strictEqual(client.senderName, 'Иван Клиент');

        const messages = await DB.getMessages(instance.id, chatId);
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(messages[0].content, 'Здравствуйте! Сколько стоит номер?');
        assert.strictEqual(messages[0].role, 'user');

        // 2. Outbound message from account (should be ignored)
        const outboundPayload = {
            event: 'message.received',
            sessionId: 'test-session-wh',
            data: {
                id: 'wa_outbound_1',
                chatId,
                from: chatId,
                body: 'Ответ клиенту',
                fromMe: true,
                type: 'text'
            }
        };

        await WhatsAppService.processOpenWaWebhook(outboundPayload, instance.id);

        const messagesAfter = await DB.getMessages(instance.id, chatId);
        assert.strictEqual(messagesAfter.length, 1); // No new message saved
    });
});
