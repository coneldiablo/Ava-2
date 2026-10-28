const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const BaristaBotService = require('../src/services/barista-bot.service');

describe('Barista Bot Service Tests', () => {
    
    it('should format order message correctly', () => {
        const orderId = 42;
        const clientName = 'Иван';
        const orderSummary = 'Капучино на овсяном, Круассан';
        const channel = 'WhatsApp';
        
        const text = BaristaBotService.formatOrderMessage(orderId, clientName, orderSummary, channel, '12:10', 'к 12:30');
        
        assert.ok(text.includes('Новый заказ #42'));
        assert.ok(text.includes('Иван (WhatsApp)'));
        assert.ok(text.includes('Капучино на овсяном, Круассан'));
        assert.ok(text.includes('Самовывоз: к 12:30'));
    });
    
    it('should notify all active baristas about new order', async () => {
        createTestDB();
        
        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        
        // Add 2 baristas
        await DB.addBaristaStaff(instance.id, 'chat_b1', 'Михаил');
        await DB.addBaristaStaff(instance.id, 'chat_b2', 'Анна');
        
        // Create order
        const order = await DB.createOrder(instance.id, 'client_1', 'Клиент', 'Эспрессо');
        
        // Setup mock Telegram bot
        const sentMessages = [];
        const mockBot = {
            sendMessage: async (chatId, text, options) => {
                sentMessages.push({ chatId, text, options });
                return { message_id: 999 + sentMessages.length };
            }
        };
        
        // Register mock bot in service
        BaristaBotService._bots.set(instance.id, mockBot);
        
        // Notify
        const success = await BaristaBotService.notifyNewOrder(
            instance.id,
            order.id,
            'Клиент',
            'Эспрессо',
            'client_1'
        );
        
        assert.strictEqual(success, true);
        assert.strictEqual(sentMessages.length, 2);
        
        // Verify message parameters for first barista
        assert.strictEqual(sentMessages[0].chatId, 'chat_b1');
        assert.ok(sentMessages[0].text.includes('Новый заказ #' + order.id));
        assert.ok(sentMessages[0].text.includes('Эспрессо'));
        assert.ok(sentMessages[0].options.reply_markup.inline_keyboard);
        
        // Verify message parameters for second barista
        assert.strictEqual(sentMessages[1].chatId, 'chat_b2');
        
        // Verify order message IDs updated in DB
        const updatedOrder = await DB.getOrder(order.id);
        const savedMsgIds = JSON.parse(updatedOrder.telegramMessageIds);
        assert.strictEqual(savedMsgIds.length, 2);
        assert.strictEqual(savedMsgIds[0].chatId, 'chat_b1');
        assert.strictEqual(savedMsgIds[0].messageId, 1000);
        assert.strictEqual(savedMsgIds[1].chatId, 'chat_b2');
        assert.strictEqual(savedMsgIds[1].messageId, 1001);
    });
    
    it('should handle accept order callback query', async () => {
        createTestDB();
        
        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        const clientChatId = '79991234567@c.us';
        await DB.getOrCreateClient(instance.id, clientChatId, 'Клиент');
        
        // Create new order
        const order = await DB.createOrder(instance.id, clientChatId, 'Клиент', 'Капучино 0.3');
        
        // Add barista staff
        await DB.addBaristaStaff(instance.id, '8888', 'Иван');
        
        // Mock bot
        const answeredCallbacks = [];
        const editedMessages = [];
        const sentMessages = [];
        
        const mockBot = {
            sendMessage: async (chatId, text) => {
                sentMessages.push({ chatId, text });
                return { message_id: 111 };
            },
            answerCallbackQuery: async (id, options) => {
                answeredCallbacks.push({ id, options });
                return true;
            },
            editMessageText: async (text, options) => {
                editedMessages.push({ text, options });
                return true;
            }
        };
        
        BaristaBotService._bots.set(instance.id, mockBot);
        
        // Create callback query object
        const query = {
            id: 'cb_query_1',
            data: `accept_order_${order.id}`,
            from: { first_name: 'Иван', last_name: '', username: 'ivan_barista' },
            message: {
                chat: { id: 8888 },
                message_id: 999
            }
        };
        
        // Handle callback
        await BaristaBotService._handleCallback(instance.id, query, mockBot);
        
        // Assert callback answered
        assert.strictEqual(answeredCallbacks.length, 1);
        assert.strictEqual(answeredCallbacks[0].options.text, '✅ Заказ принят!');
        
        // Assert DB status updated to 'accepted'
        const updatedOrder = await DB.getOrder(order.id);
        assert.strictEqual(updatedOrder.status, 'accepted');
        assert.strictEqual(updatedOrder.baristaName, 'Иван');
        assert.strictEqual(updatedOrder.baristaChatId, '8888');
        
        // Assert client status updated in DB
        const client = await DB.getClient(instance.id, clientChatId);
        assert.strictEqual(client.leadStatus, 'offer'); // 'accepted' -> 'offer' status
        
        // Assert inline keyboard updated (has ready button)
        assert.strictEqual(editedMessages.length, 1);
        assert.strictEqual(editedMessages[0].options.chat_id, 8888);
        assert.strictEqual(editedMessages[0].options.message_id, 999);
        assert.ok(editedMessages[0].text.includes('ГОТОВИТСЯ'));
        
        const inlineKeyboard = editedMessages[0].options.reply_markup.inline_keyboard;
        assert.strictEqual(inlineKeyboard[0][0].text, '🏁 Готов к выдаче');
        assert.strictEqual(inlineKeyboard[0][0].callback_data, `ready_order_${order.id}`);
    });
    
    it('should handle reject order callback query', async () => {
        createTestDB();
        
        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        const clientChatId = '79991234567@c.us';
        await DB.getOrCreateClient(instance.id, clientChatId, 'Клиент');
        
        const order = await DB.createOrder(instance.id, clientChatId, 'Клиент', 'Американо');
        await DB.addBaristaStaff(instance.id, '7777', 'Мария П.');
        
        const answeredCallbacks = [];
        const editedMessages = [];
        
        const mockBot = {
            answerCallbackQuery: async (id, options) => {
                answeredCallbacks.push({ id, options });
                return true;
            },
            editMessageText: async (text, options) => {
                editedMessages.push({ text, options });
                return true;
            }
        };
        
        const query = {
            id: 'cb_query_2',
            data: `reject_order_${order.id}`,
            from: { first_name: 'Мария', last_name: 'П.' },
            message: {
                chat: { id: 7777 },
                message_id: 888
            }
        };
        
        await BaristaBotService._handleCallback(instance.id, query, mockBot);
        
        assert.strictEqual(answeredCallbacks.length, 1);
        assert.strictEqual(answeredCallbacks[0].options.text, '❌ Заказ отклонён');
        
        const updatedOrder = await DB.getOrder(order.id);
        assert.strictEqual(updatedOrder.status, 'rejected');
        assert.strictEqual(updatedOrder.baristaName, 'Мария П.');
        
        assert.strictEqual(editedMessages.length, 1);
        assert.ok(editedMessages[0].text.includes('ОТКЛОНЁН'));
        assert.strictEqual(editedMessages[0].options.reply_markup.inline_keyboard.length, 0); // No buttons
    });
    
    it('should handle complete order callback query', async () => {
        createTestDB();
        
        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        const clientChatId = '79991234567@c.us';
        await DB.getOrCreateClient(instance.id, clientChatId, 'Клиент');
        
        // Create and set status to ready first
        const order = await DB.createOrder(instance.id, clientChatId, 'Клиент', 'Раф');
        await DB.updateOrderStatus(order.id, 'ready', '7777', 'Дмитрий');
        await DB.addBaristaStaff(instance.id, '7777', 'Дмитрий');
        
        const answeredCallbacks = [];
        const editedMessages = [];
        
        const mockBot = {
            answerCallbackQuery: async (id, options) => {
                answeredCallbacks.push({ id, options });
                return true;
            },
            editMessageText: async (text, options) => {
                editedMessages.push({ text, options });
                return true;
            }
        };
        
        const query = {
            id: 'cb_query_3',
            data: `complete_order_${order.id}`,
            from: { first_name: 'Дмитрий', last_name: '' },
            message: {
                chat: { id: 7777 },
                message_id: 888
            }
        };
        
        await BaristaBotService._handleCallback(instance.id, query, mockBot);
        
        assert.strictEqual(answeredCallbacks.length, 1);
        assert.strictEqual(answeredCallbacks[0].options.text, '✅ Заказ выдан!');
        
        const updatedOrder = await DB.getOrder(order.id);
        assert.strictEqual(updatedOrder.status, 'completed');
        
        const client = await DB.getClient(instance.id, clientChatId);
        assert.strictEqual(client.leadStatus, 'booked'); // 'completed' -> 'booked' status
        
        assert.strictEqual(editedMessages.length, 1);
        assert.ok(editedMessages[0].text.includes('ВЫДАН'));
        assert.strictEqual(editedMessages[0].options.reply_markup.inline_keyboard.length, 0); // No buttons
    });

    it('should require invite code for new barista registration', async () => {
        createTestDB();

        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        await DB.updateInstance(instance.id, { baristaInviteCode: 'invite-123' });

        const sentMessages = [];
        const mockBot = {
            sendMessage: async (chatId, text) => {
                sentMessages.push({ chatId: String(chatId), text });
                return { message_id: sentMessages.length };
            }
        };
        BaristaBotService._bots.set(instance.id, mockBot);

        const msg = {
            chat: { id: 5555 },
            from: { first_name: 'Олег', last_name: 'К.' }
        };

        await BaristaBotService._handleStart(instance.id, msg, 'wrong-code');
        assert.strictEqual((await DB.getBaristaStaff(instance.id)).length, 0);
        assert.ok(sentMessages[0].text.includes('Неверный код'));

        await BaristaBotService._handleStart(instance.id, msg, 'invite-123');
        const staff = await DB.getBaristaStaff(instance.id);
        assert.strictEqual(staff.length, 1);
        assert.strictEqual(staff[0].telegramChatId, '5555');
    });

    it('should manage stop-list from barista Telegram commands', async () => {
        createTestDB();

        const instance = await DB.createInstance({ name: 'Accent Coffee', businessType: 'coffee_shop' });
        await DB.addBaristaStaff(instance.id, '7777', 'Анна');

        const sentMessages = [];
        const mockBot = {
            sendMessage: async (chatId, text) => {
                sentMessages.push({ chatId: String(chatId), text });
                return true;
            }
        };
        const msg = { chat: { id: 7777 } };

        await BaristaBotService._handleStopCommand(instance.id, msg, mockBot, 'add', 'Цезарь | нет курицы');
        assert.strictEqual((await DB.getCoffeeStopList(instance.id)).length, 1);
        assert.ok(sentMessages[0].text.includes('Добавлено'));

        await BaristaBotService._handleStopList(instance.id, msg, mockBot);
        assert.ok(sentMessages[1].text.includes('Цезарь'));

        await BaristaBotService._handleStopCommand(instance.id, msg, mockBot, 'remove', 'Цезарь');
        assert.strictEqual((await DB.getCoffeeStopList(instance.id)).length, 0);
        assert.ok(sentMessages[2].text.includes('Убрано'));
    });

    it('should persist an invite code when restarting the barista bot', async () => {
        createTestDB();

        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        const originalStartBot = BaristaBotService._startBot;
        BaristaBotService._startBot = async () => {};

        try {
            const result = await BaristaBotService.restartBot(instance.id, {
                baristaBotToken: 'test-token',
                baristaInviteCode: 'invite-from-form'
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.inviteCode, 'invite-from-form');
            const updated = await DB.getInstance(instance.id);
            assert.strictEqual(updated.baristaBotToken, 'test-token');
            assert.strictEqual(updated.baristaInviteCode, 'invite-from-form');
        } finally {
            BaristaBotService._startBot = originalStartBot;
        }
    });

    it('should deny order callbacks from unregistered Telegram users', async () => {
        createTestDB();

        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        const order = await DB.createOrder(instance.id, 'client_1', 'Клиент', 'Эспрессо');
        const answers = [];
        const mockBot = {
            answerCallbackQuery: async (id, options) => answers.push({ id, options })
        };

        await BaristaBotService._handleCallback(instance.id, {
            id: 'unauthorized_callback',
            data: `accept_order_${order.id}`,
            from: { first_name: 'Посторонний' },
            message: { chat: { id: 9999 }, message_id: 1 }
        }, mockBot);

        assert.strictEqual(answers[0].options.text, '⛔ Нет доступа к заказам');
        assert.strictEqual((await DB.getOrder(order.id)).status, 'new');
    });

    it('should keep an order in CRM when the Telegram bot is offline', async () => {
        createTestDB();

        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        BaristaBotService._bots.delete(instance.id);

        const result = await BaristaBotService.dispatchOrder(
            instance.id,
            '79990000000@c.us',
            'Клиент',
            'Флэт уайт'
        );

        assert.strictEqual(result.created, true);
        assert.strictEqual(result.notified, false);
        const activeOrders = await DB.getActiveOrders(instance.id);
        assert.strictEqual(activeOrders.length, 1);
        assert.strictEqual(activeOrders[0].orderSummary, 'Флэт уайт');
    });

    it('should not dispatch a coffee pickup order without pickup time', async () => {
        createTestDB();

        const instance = await DB.createInstance({ name: 'Coffee Pickup' });
        await DB.updateInstance(instance.id, { salesGoal: 'coffee_pickup' });

        const result = await BaristaBotService.dispatchOrder(
            instance.id,
            '79990000001@c.us',
            'Клиент',
            'Латте 0.3'
        );

        assert.strictEqual(result.created, false);
        assert.strictEqual(result.reason, 'pickup_time_required');
        assert.strictEqual((await DB.getActiveOrders(instance.id)).length, 0);
    });

    it('should not redispatch a fresh accepted coffee order as a repeat order', async () => {
        createTestDB();

        const instance = await DB.createInstance({ name: 'Coffee Pickup' });
        await DB.updateInstance(instance.id, { salesGoal: 'coffee_pickup' });
        const chatId = '79990000002@c.us';
        const first = await DB.createOrderIfNew(instance.id, chatId, 'Клиент', 'Латте', 'к 12:00');
        await DB.updateOrderStatus(first.order.id, 'accepted', 'barista_1', 'Анна');

        const result = await BaristaBotService.dispatchOrder(
            instance.id,
            chatId,
            'Клиент',
            'Айс кофе',
            'к 13:00'
        );

        assert.strictEqual(result.created, false);
        assert.strictEqual(result.updated, false);
        assert.strictEqual(result.reason, 'active_order_accepted');
        assert.strictEqual(result.order.id, first.order.id);
        assert.strictEqual((await DB.getOrder(first.order.id)).orderSummary, 'Латте');
        assert.strictEqual((await DB.getActiveOrders(instance.id)).length, 1);
    });

    it('should confirm coffee pickup when barista accepts and keep it terminal after completion', async () => {
        createTestDB();

        const instance = await DB.createInstance({ name: 'Coffee Pickup' });
        await DB.updateInstance(instance.id, { salesGoal: 'coffee_pickup' });
        const clientChatId = '79995550000@c.us';
        await DB.getOrCreateClient(instance.id, clientChatId, 'Алина');
        const order = await DB.createOrder(
            instance.id,
            clientChatId,
            'Алина',
            'Капучино 0.3, чизкейк',
            'к 18:20'
        );
        await DB.addBaristaStaff(instance.id, 'barista_1', 'Анна');

        const editedMessages = [];
        const mockBot = {
            sendMessage: async () => ({ message_id: 1 }),
            editMessageText: async (text, options) => {
                editedMessages.push({ text, options });
                return true;
            }
        };

        const accepted = await BaristaBotService._acceptOrder(
            instance.id,
            order.id,
            'barista_1',
            'Анна',
            mockBot,
            'barista_1',
            50
        );
        assert.strictEqual(accepted, true);
        assert.strictEqual((await DB.getClient(instance.id, clientChatId)).leadStatus, 'pickup_confirmed');
        assert.ok(editedMessages[0].text.includes('Самовывоз: к 18:20'));

        const ready = await BaristaBotService._readyOrder(
            instance.id,
            order.id,
            mockBot,
            'barista_1',
            50
        );
        assert.strictEqual(ready, true);
        assert.strictEqual((await DB.getClient(instance.id, clientChatId)).leadStatus, 'ready_for_pickup');

        const completed = await BaristaBotService._completeOrder(
            instance.id,
            order.id,
            mockBot,
            'barista_1',
            50
        );
        assert.strictEqual(completed, true);
        assert.strictEqual((await DB.getClient(instance.id, clientChatId)).leadStatus, 'ready_for_pickup');

        const stats = await DB.getStats(instance.id);
        assert.strictEqual(stats.pickupConfirmed, 1);
        assert.strictEqual(stats.converted, 1);
        assert.strictEqual(stats.conversion, 100);
    });
});
