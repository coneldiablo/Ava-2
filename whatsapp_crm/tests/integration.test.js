const express = require('express');
const axios = require('axios');
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const AIService = require('../src/services/ai.service');
const GreenApiService = require('../src/services/green-api.service');
const WhatsAppService = require('../src/services/whatsapp.service');
const BaristaBotService = require('../src/services/barista-bot.service');
const router = require('../src/routes/api.routes');

describe('System Integration & Smoke Tests', () => {
    let app;
    let server;
    let baseUrl;
    
    // Mocks state
    let lastSentWhatsAppMsg = null;
    let mockBaristaBot = null;
    // Axios mock state
    let originalGet = null;
    let originalPost = null;
    let originalDelay = null;

    it('should setup test environment and mock services', async () => {
        // Setup axios intercepts
        originalGet = axios.get;
        originalPost = axios.post;

        axios.get = async (url, config) => {
            if (url.includes('/health')) {
                return originalGet(url, config);
            }
            if (url.includes('getStateInstance')) {
                return {
                    status: 200,
                    data: {
                        stateInstance: 'authorized'
                    }
                };
            }
            return { status: 200, data: {} };
        };

        axios.post = async (url, data, config) => {
            if (url.includes('/api/webhook')) {
                return originalPost(url, data, config);
            }
            if (url.includes('chat/completions')) {
                return {
                    status: 200,
                    data: {
                        choices: [{
                            message: {
                                content: JSON.stringify({
                                    reply: 'Ваш заказ принят в работу! Скоро всё приготовим. ☕',
                                    status: 'qualified',
                                    action: 'none',
                                    thought: 'Client ordered coffee',
                                    status_reasoning: 'Status moves to qualified as client requested coffee',
                                    order_summary: 'Двойной эспрессо, банановый кекс'
                                })
                            }
                        }]
                    }
                };
            }
            if (url.includes('sendMessage')) {
                lastSentWhatsAppMsg = {
                    chatId: data.chatId,
                    text: data.message
                };
                return { status: 200, data: { idMessage: 'msg_12345' } };
            }
            return { status: 200, data: {} };
        };
        
        // 3. Mock push notifications to prevent error logging
        const PushService = require('../src/services/push.service');
        PushService.notifyNewLead = async () => {};
        PushService.notifyHumanHelp = async () => {};
        
        // Mock RAG service apiClient and set test API keys to avoid network requests
        const RAGService = require('../src/services/rag.service');
        const config = require('../src/config');
        config.aiTunnel.apiKey = 'test_key';
        RAGService.apiClient.post = async (url, data, config) => {
            if (url.includes('/embeddings')) {
                return {
                    data: {
                        data: [{
                            index: 0,
                            embedding: new Array(384).fill(0.1)
                        }]
                    }
                };
            }
            return { data: {} };
        };
        
        // 4. Setup mock Barista Telegram Bot
        mockBaristaBot = {
            sendMessage: async (chatId, text, options) => {
                mockBaristaBot.sent.push({ chatId, text, options });
                return { message_id: 888 };
            },
            editMessageText: async (text, options) => {
                mockBaristaBot.edited.push({ text, options });
                return true;
            },
            sent: [],
            edited: []
        };
        
        // 5. Speed up WhatsApp queue debounce delay for tests
        originalDelay = WhatsAppService.delayTime;
        WhatsAppService.delayTime = 5;
        
        // 6. Spin up ephemeral Express server
        app = express();
        app.use(express.json());
        app.use('/api', router);
        
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', () => {
                const address = server.address();
                baseUrl = `http://${address.address}:${address.port}/api`;
                resolve();
            });
        });
        
        assert.ok(baseUrl);
    });
    
    it('should respond with 200 OK on health check', async () => {
        const res = await axios.get(`${baseUrl}/health`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.data.status, 'ok');
    });

    it('should include knowledge base context in simulator responses', async () => {
        createTestDB();

        const instance = await DB.createInstance({ name: 'Simulator Cafe' });
        await DB.updateInstance(instance.id, {
            systemPrompt: 'Отвечай по меню.',
            salesGoal: 'coffee_pickup',
            aiResponseFormat: 'json_object'
        });

        const RAGService = require('../src/services/rag.service');
        const originalBuildConversationContext = RAGService.buildConversationContext;
        const originalGetResponse = AIService.getResponse;

        let receivedContext = null;
        let receivedHistory = null;
        RAGService.buildConversationContext = async () => ({
            query: 'Сколько стоит айс кофе?',
            context: '[Меню]: Айс-кофе — 300 ₽.',
            searched: true
        });
        AIService.getResponse = async (history, context) => {
            receivedHistory = history;
            receivedContext = context;
            return {
                reply: 'Айс-кофе стоит 300 ₽.',
                status: 'new',
                action: 'none'
            };
        };

        try {
            const response = await originalPost(`${baseUrl}/simulate`, {
                message: 'Сколько стоит айс кофе?',
                history: [],
                instanceId: instance.id
            });

            assert.strictEqual(response.status, 200);
            assert.strictEqual(response.data.response.reply, 'Айс-кофе стоит 300 ₽.');
            assert.strictEqual(receivedContext.ragSearched, true);
            assert.ok(receivedContext.ragContext.includes('Айс-кофе — 300 ₽.'));
            assert.strictEqual(receivedContext.salesGoal, 'coffee_pickup');
            assert.strictEqual(receivedContext.instanceId, instance.id);
            assert.strictEqual(receivedHistory.length, 1);
            assert.strictEqual(receivedHistory[0].content, 'Сколько стоит айс кофе?');
        } finally {
            RAGService.buildConversationContext = originalBuildConversationContext;
            AIService.getResponse = originalGetResponse;
        }
    });
    
    it('should process incoming webhook, run AI, create order and notify barista', async () => {
        createTestDB(); // Fresh DB
        
        // 1. Create instance in DB matching Green API id
        const greenApiInstance = '123456';
        const instance = await DB.createInstance({ name: 'Central Cafe' });
        await DB.updateInstance(instance.id, {
            greenApiInstance,
            greenApiToken: 'fixture_green_token_at_least_16',
            greenApiUrl: 'http://localhost',
            baristaBotToken: 'bot_token_xyz',
            isActive: 1
        });
        
        // 2. Add barista staff
        await DB.addBaristaStaff(instance.id, '112233', 'Ольга');
        
        // Register mock bot in BaristaBotService
        BaristaBotService._bots.set(instance.id, mockBaristaBot);
        
        // Clear mocks state
        lastSentWhatsAppMsg = null;
        mockBaristaBot.sent = [];
        mockBaristaBot.edited = [];
        
        // 3. Send green-api webhook POST to our server
        const webhookPayload = {
            typeWebhook: 'incomingMessageReceived',
            instanceData: {
                idInstance: greenApiInstance
            },
            senderData: {
                chatId: '79997778899@c.us',
                senderName: 'Дмитрий'
            },
            messageData: {
                typeMessage: 'textMessage',
                textMessageData: {
                    textMessage: 'Привет! Сделайте мне двойной эспрессо и банановый кекс.'
                }
            }
        };
        
        const token = require('../src/services/whatsapp-connection.service').greenWebhookToken(await DB.getInstance(instance.id));
        const response = await axios.post(`${baseUrl}/webhook`, webhookPayload, { headers: { Authorization: `Bearer ${token}` } });
        assert.strictEqual(response.status, 200);
        
        // Wait for debounce queue processing
        let client = null;
        for (let i = 0; i < 25; i++) {
            client = await DB.getClient(instance.id, '79997778899@c.us');
            if (client && client.leadStatus === 'qualified') {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        
        // 4. Verify client created
        assert.ok(client);
        assert.strictEqual(client.senderName, 'Дмитрий');
        assert.strictEqual(client.leadStatus, 'qualified'); // Status updated by AI
        
        // 5. Verify messages saved
        const history = await DB.getClientHistory(instance.id, '79997778899@c.us', 5);
        assert.strictEqual(history.length, 2);
        assert.strictEqual(history[0].role, 'user');
        assert.strictEqual(history[1].role, 'assistant');
        assert.strictEqual(history[1].content, 'Ваш заказ принят в работу! Скоро всё приготовим. ☕');
        
        // 6. Verify WhatsApp auto-reply sent back to customer
        assert.ok(lastSentWhatsAppMsg);
        assert.strictEqual(lastSentWhatsAppMsg.chatId, '79997778899@c.us');
        assert.ok(lastSentWhatsAppMsg.text.includes('Ваш заказ принят в работу!'));
        
        // 7. Verify order created in orders table
        const activeOrders = await DB.getActiveOrders(instance.id);
        assert.strictEqual(activeOrders.length, 1);
        assert.strictEqual(activeOrders[0].clientName, 'Дмитрий');
        assert.strictEqual(activeOrders[0].orderSummary, 'Двойной эспрессо, банановый кекс');
        assert.strictEqual(activeOrders[0].status, 'new');
        
        // 8. Verify barista got Telegram notification
        assert.strictEqual(mockBaristaBot.sent.length, 1);
        assert.strictEqual(mockBaristaBot.sent[0].chatId, '112233');
        assert.ok(mockBaristaBot.sent[0].text.includes('Новый заказ #' + activeOrders[0].id));
        assert.ok(mockBaristaBot.sent[0].text.includes('Двойной эспрессо, банановый кекс'));
    });
    
    it('should complete status transition chain and verify order execution via callbacks', async () => {
        // Continue using DB from previous test case
        const instanceId = 1;
        const chatId = '79997778899@c.us';
        
        // Verify current state is 'qualified'
        let client = await DB.getClient(instanceId, chatId);
        assert.strictEqual(client.leadStatus, 'qualified');
        
        const activeOrders = await DB.getActiveOrders(instanceId);
        assert.strictEqual(activeOrders.length, 1);
        const orderId = activeOrders[0].id;
        
        // 1. Simulating Accept Order Callback Query from Telegram Barista Bot
        const acceptQuery = {
            id: 'query_accept',
            data: `accept_order_${orderId}`,
            from: { first_name: 'Ольга', last_name: '' },
            message: {
                chat: { id: 112233 },
                message_id: 888
            }
        };
        
        // Setup answerCallbackQuery mock
        mockBaristaBot.answerCallbackQuery = async () => true;
        
        await BaristaBotService._handleCallback(instanceId, acceptQuery, mockBaristaBot);
        
        // Client status should transition to 'offer' (gets prepared)
        client = await DB.getClient(instanceId, chatId);
        assert.strictEqual(client.leadStatus, 'offer');
        
        // Order status should be 'accepted'
        let order = await DB.getOrder(orderId);
        assert.strictEqual(order.status, 'accepted');
        assert.strictEqual(order.baristaName, 'Ольга');
        
        // 2. Simulating Complete Order Callback Query
        const completeQuery = {
            id: 'query_complete',
            data: `complete_order_${orderId}`,
            from: { first_name: 'Ольга', last_name: '' },
            message: {
                chat: { id: 112233 },
                message_id: 888
            }
        };
        
        await BaristaBotService._handleCallback(instanceId, completeQuery, mockBaristaBot);
        
        // Client status should transition to 'booked' (order picked up/ready)
        client = await DB.getClient(instanceId, chatId);
        assert.strictEqual(client.leadStatus, 'booked');
        
        // Order status should be 'completed'
        order = await DB.getOrder(orderId);
        assert.strictEqual(order.status, 'completed');
        
        // Stats verify
        const stats = await DB.getOrderStats(instanceId);
        assert.strictEqual(stats.completed, 1);
        assert.strictEqual(stats.new, 0);
    });
    
    it('should teardown test environment', async () => {
        // Restore axios
        axios.get = originalGet;
        axios.post = originalPost;
        WhatsAppService.delayTime = originalDelay;
        WhatsAppService.batcher.clearAll();
        // Shutdown server
        await new Promise((resolve) => server.close(resolve));
    });
});
