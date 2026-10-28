const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');

describe('Database Service Tests', () => {
    
    it('should perform Instance CRUD operations', async () => {
        createTestDB(); // Isolated DB for this test case
        
        // Create
        const name = 'Espresso House';
        const instance = await DB.createInstance({ name });
        assert.ok(instance.id);
        assert.strictEqual(instance.name, name);
        assert.strictEqual(instance.aiProvider, 'yandex'); // default
        assert.strictEqual(instance.businessType, 'standard');
        assert.strictEqual(instance.salesGoal, 'call');
        
        // Read
        const fetched = await DB.getInstance(instance.id);
        assert.ok(fetched);
        assert.strictEqual(fetched.id, instance.id);
        assert.strictEqual(fetched.name, name);
        
        // Update
        const updated = await DB.updateInstance(instance.id, {
            name: 'Espresso House Premium',
            baristaBotToken: 'bot123456',
            baristaBotUsername: 'baristabot',
            baristaInviteCode: 'coffee-team-2026'
        });
        assert.ok(updated);
        assert.strictEqual(updated.name, 'Espresso House Premium');
        assert.strictEqual(updated.baristaBotToken, 'bot123456');
        assert.strictEqual(updated.baristaBotUsername, 'baristabot');
        assert.strictEqual(updated.baristaInviteCode, 'coffee-team-2026');
        
        // Delete
        await DB.deleteInstance(instance.id);
        const afterDelete = await DB.getInstance(instance.id);
        assert.strictEqual(afterDelete, undefined);
    });

    it('should keep standard and coffee business profiles separate', async () => {
        createTestDB();

        const standard = await DB.createInstance({
            name: 'Consulting',
            businessType: 'standard',
            salesGoal: 'payment'
        });
        const coffee = await DB.createInstance({
            name: 'Coffee',
            businessType: 'coffee_shop'
        });

        assert.strictEqual(standard.businessType, 'standard');
        assert.strictEqual(standard.salesGoal, 'payment');
        assert.strictEqual(coffee.businessType, 'coffee_shop');
        assert.strictEqual(coffee.salesGoal, 'coffee_pickup');

        const changedToCoffee = await DB.updateInstance(standard.id, { businessType: 'coffee_shop' });
        assert.strictEqual(changedToCoffee.businessType, 'coffee_shop');
        assert.strictEqual(changedToCoffee.salesGoal, 'coffee_pickup');

        const changedBack = await DB.updateInstance(standard.id, {
            businessType: 'standard',
            salesGoal: 'coffee_pickup'
        });
        assert.strictEqual(changedBack.businessType, 'standard');
        assert.strictEqual(changedBack.salesGoal, 'call');
    });
    
    it('should handle client creation, retrieval and status updates', async () => {
        createTestDB();
        
        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        const chatId = '79991234567@c.us';
        const senderName = 'Иван';
        
        // Create/Get client
        const client = await DB.getOrCreateClient(instance.id, chatId, senderName);
        assert.ok(client);
        assert.strictEqual(client.chatId, chatId);
        assert.strictEqual(client.senderName, senderName);
        assert.strictEqual(client.leadStatus, 'new'); // default status
        
        // Get client
        const fetched = await DB.getClient(instance.id, chatId);
        assert.ok(fetched);
        assert.strictEqual(fetched.chatId, chatId);
        
        // Update status - valid
        await DB.updateClientStatus(instance.id, chatId, 'qualified', 'Client ordered a coffee', 'ai');
        const updatedClient = await DB.getClient(instance.id, chatId);
        assert.strictEqual(updatedClient.leadStatus, 'qualified');
        
        // Update status - invalid
        assert.throws(() => {
            DB.db.transaction(() => {
                // Better-sqlite3 throws instantly if query runs, but updateClientStatus runs run()
                // Let's assert that passing an invalid status throws an error
                throw new Error('Invalid lead status');
            })();
        });
        
        // Real invalid status check
        await assert.rejects(
            async () => await DB.updateClientStatus(instance.id, chatId, 'invalid_status_name'),
            /Invalid lead status/
        );
    });
    
    it('should save messages and retrieve client history', async () => {
        createTestDB();
        
        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        const chatId = '79991234567@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Иван');
        
        // Save user message
        await DB.saveMessage(instance.id, chatId, 'Иван', 'Хочу капучино на кокосовом', 'user');
        
        // Save bot message with thought
        await DB.saveMessage(instance.id, chatId, 'Bot', 'Конечно! Какого объема?', 'assistant', 'AI thinking process');
        
        // Get history
        const history = await DB.getClientHistory(instance.id, chatId, 10);
        assert.strictEqual(history.length, 2);

        const userMsg = history.find(h => h.role === 'user');
        const assistantMsg = history.find(h => h.role === 'assistant');
        assert.ok(userMsg);
        assert.ok(assistantMsg);
        assert.strictEqual(userMsg.content, 'Хочу капучино на кокосовом');
        assert.strictEqual(assistantMsg.content, 'Конечно! Какого объема?');
        assert.strictEqual(assistantMsg.aiThought, 'AI thinking process');
    });
    
    it('should log lead status history transitions', async () => {
        createTestDB();
        
        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        const chatId = '79991234567@c.us';
        await DB.getOrCreateClient(instance.id, chatId, 'Иван');
        
        // Transition: new -> qualified
        await DB.updateClientStatus(instance.id, chatId, 'qualified', 'AI identified order', 'ai');
        // Transition: qualified -> offer
        await DB.updateClientStatus(instance.id, chatId, 'offer', 'Barista accepted order', 'barista');
        
        // Retrieve transitions from DB
        const rows = DB.all('SELECT * FROM lead_status_history WHERE instanceId = ? AND chatId = ? ORDER BY id ASC', [instance.id, chatId]);
        assert.strictEqual(rows.length, 2);
        
        assert.strictEqual(rows[0].fromStatus, 'new');
        assert.strictEqual(rows[0].toStatus, 'qualified');
        assert.strictEqual(rows[0].changedBy, 'ai');
        assert.strictEqual(rows[0].reason, 'AI identified order');
        
        assert.strictEqual(rows[1].fromStatus, 'qualified');
        assert.strictEqual(rows[1].toStatus, 'offer');
        assert.strictEqual(rows[1].changedBy, 'barista');
        assert.strictEqual(rows[1].reason, 'Barista accepted order');
    });
    
    it('should manage Orders (Barista Bot)', async () => {
        createTestDB();
        
        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        const chatId = '79991234567@c.us';
        const clientName = 'Петр';
        const summary = 'Капучино на овсяном 0.3, Круассан с сыром';
        
        // 1. Create order
        const order = await DB.createOrder(instance.id, chatId, clientName, summary, 'к 16:00');
        assert.ok(order);
        assert.ok(order.id);
        assert.strictEqual(order.instanceId, instance.id);
        assert.strictEqual(order.chatId, chatId);
        assert.strictEqual(order.clientName, clientName);
        assert.strictEqual(order.orderSummary, summary);
        assert.strictEqual(order.pickupTime, 'к 16:00');
        assert.strictEqual(order.status, 'new');
        
        // 2. Get order
        const fetched = await DB.getOrder(order.id);
        assert.ok(fetched);
        assert.strictEqual(fetched.id, order.id);
        
        // 3. Get active orders
        let active = await DB.getActiveOrders(instance.id);
        assert.strictEqual(active.length, 1);
        assert.strictEqual(active[0].id, order.id);
        
        // 4. Update status (new -> accepted)
        const accepted = await DB.updateOrderStatus(order.id, 'accepted', 'tg_barista_1', 'Михаил');
        assert.strictEqual(accepted.status, 'accepted');
        assert.strictEqual(accepted.baristaChatId, 'tg_barista_1');
        assert.strictEqual(accepted.baristaName, 'Михаил');
        assert.ok(accepted.acceptedAt);
        
        // 5. Update message IDs
        await DB.updateOrderTelegramMessageIds(order.id, [{ chatId: 'tg_barista_1', messageId: 445 }]);
        const orderAfterMsgId = await DB.getOrder(order.id);
        const msgIds = JSON.parse(orderAfterMsgId.telegramMessageIds);
        assert.strictEqual(msgIds.length, 1);
        assert.strictEqual(msgIds[0].messageId, 445);
        
        // 6. Complete order (accepted -> completed)
        const completed = await DB.updateOrderStatus(order.id, 'completed');
        assert.strictEqual(completed.status, 'completed');
        assert.ok(completed.completedAt);
        
        // 7. Verification: no active orders remaining
        active = await DB.getActiveOrders(instance.id);
        assert.strictEqual(active.length, 0);
    });

    it('should deduplicate identical active orders and transition atomically', async () => {
        createTestDB();

        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        const first = await DB.createOrderIfNew(instance.id, 'client_1', 'Иван', 'Латте, круассан', 'через 20 минут');
        const duplicate = await DB.createOrderIfNew(instance.id, 'client_1', 'Иван', '  латте,   КРУАССАН ', 'через 20 минут');

        assert.strictEqual(first.created, true);
        assert.strictEqual(duplicate.created, false);
        assert.strictEqual(duplicate.order.id, first.order.id);
        assert.strictEqual(duplicate.order.pickupTime, 'через 20 минут');

        const updated = await DB.createOrderIfNew(instance.id, 'client_1', 'Иван', 'Латте на овсяном, круассан', 'к 15:45');
        assert.strictEqual(updated.created, false);
        assert.strictEqual(updated.updated, true);
        assert.strictEqual(updated.order.id, first.order.id);
        assert.strictEqual(updated.order.orderSummary, 'Латте на овсяном, круассан');
        assert.strictEqual(updated.order.pickupTime, 'к 15:45');

        const accepted = await DB.transitionOrderStatus(
            instance.id,
            first.order.id,
            'new',
            'accepted',
            'barista_1',
            'Анна'
        );
        const secondClaim = await DB.transitionOrderStatus(
            instance.id,
            first.order.id,
            'new',
            'accepted',
            'barista_2',
            'Игорь'
        );

        assert.ok(accepted);
        assert.strictEqual(accepted.baristaName, 'Анна');
        assert.strictEqual(secondClaim, null);
    });

    it('should allow repeat orders after previous orders are completed', async () => {
        createTestDB();

        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        const chatId = 'client_repeat';

        const first = await DB.createOrderIfNew(instance.id, chatId, 'Иван', 'Айс кофе', 'к 12:00');
        await DB.updateOrderStatus(first.order.id, 'accepted', 'barista_1', 'Анна');
        await DB.updateOrderStatus(first.order.id, 'completed');

        const second = await DB.createOrderIfNew(instance.id, chatId, 'Иван', 'Флэт уайт', 'к 16:00');

        assert.strictEqual(second.created, true);
        assert.notStrictEqual(second.order.id, first.order.id);
        assert.strictEqual(second.order.orderSummary, 'Флэт уайт');

        const orders = await DB.getOrdersByClient(instance.id, chatId);
        assert.strictEqual(orders.length, 2);
    });

    it('should not overwrite a fresh accepted order with a new repeat order', async () => {
        createTestDB();

        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        const first = await DB.createOrderIfNew(instance.id, 'client_active', 'Иван', 'Латте', 'к 12:00');
        await DB.updateOrderStatus(first.order.id, 'accepted', 'barista_1', 'Анна');

        const repeat = await DB.createOrderIfNew(instance.id, 'client_active', 'Иван', 'Айс кофе', 'к 13:00');

        assert.strictEqual(repeat.created, false);
        assert.strictEqual(repeat.updated, false);
        assert.strictEqual(repeat.reason, 'active_order_accepted');
        assert.strictEqual(repeat.order.id, first.order.id);
        assert.strictEqual((await DB.getOrder(first.order.id)).orderSummary, 'Латте');
        assert.strictEqual((await DB.getActiveOrders(instance.id)).length, 1);
    });

    it('should expire stale active orders and let the same client order again', async () => {
        createTestDB();

        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        const chatId = 'client_stale';
        const stale = await DB.createOrder(instance.id, chatId, 'Иван', 'Капучино', 'к 09:30');
        DB.run("UPDATE orders SET createdAt = datetime('now', '-13 hours') WHERE id = ?", [stale.id]);

        const expiredCount = await DB.expireStaleOrders(instance.id, chatId);
        assert.strictEqual(expiredCount, 1);
        assert.strictEqual((await DB.getOrder(stale.id)).status, 'expired');
        assert.strictEqual((await DB.getActiveOrderForClient(instance.id, chatId)), undefined);

        const next = await DB.createOrderIfNew(instance.id, chatId, 'Иван', 'Американо', 'к 11:00');
        assert.strictEqual(next.created, true);
        assert.notStrictEqual(next.order.id, stale.id);

        const stats = await DB.getOrderStats(instance.id);
        assert.strictEqual(stats.expired, 1);
        assert.strictEqual(stats.new, 1);
    });

    it('should manage CoffeeOps stop-list, order items and insights', async () => {
        createTestDB();

        const instance = await DB.createInstance({ name: 'Accent Coffee', businessType: 'coffee_shop' });
        await DB.updateCoffeeOperationsMode(instance.id, {
            mode: 'busy',
            coffeeCafeHours: '09:00-00:00',
            coffeeKitchenHours: '09:00-22:00',
            coffeePrepTimeMinutes: 15,
            coffeeBusyPrepTimeMinutes: 25
        });

        const stopItem = await DB.addCoffeeStopListItem(instance.id, {
            itemName: 'Цезарь с креветкой',
            reason: 'Нет креветки',
            addedBy: 'Анна'
        });
        assert.strictEqual(stopItem.isActive, 1);
        assert.strictEqual((await DB.getCoffeeStopList(instance.id)).length, 1);

        const chatId = 'coffee_guest';
        await DB.getOrCreateClient(instance.id, chatId, 'Гость');
        const created = await DB.createOrderIfNew(
            instance.id,
            chatId,
            'Гость',
            'Айс кофе, чизкейк',
            'к 15:00',
            [
                { itemName: 'Айс кофе', quantity: 1, category: 'кофе', modifiers: ['лёд'], unitPrice: 300, confidence: 0.95 },
                { itemName: 'Чизкейк', quantity: 1, category: 'десерт', modifiers: [], unitPrice: 280, confidence: 0.8 }
            ]
        );

        assert.strictEqual(created.created, true);
        const orderItems = await DB.getOrderItems(created.order.id);
        assert.strictEqual(orderItems.length, 2);
        assert.strictEqual(orderItems[0].itemName, 'Айс кофе');
        assert.deepStrictEqual(orderItems[0].modifiers, ['лёд']);

        await DB.updateOrderStatus(created.order.id, 'accepted', 'barista_1', 'Анна');
        await DB.updateOrderStatus(created.order.id, 'ready');
        await DB.updateOrderStatus(created.order.id, 'completed');

        const itemAnalytics = await DB.getCoffeeItemAnalytics(instance.id);
        assert.ok(itemAnalytics.topItems.some(item => item.itemName === 'Айс кофе'));
        assert.strictEqual(itemAnalytics.topCategories.length >= 1, true);
        assert.strictEqual(itemAnalytics.unstructuredOrders, 0);

        const insights = await DB.getCoffeeClientInsights(instance.id, chatId);
        assert.strictEqual(insights.ordersCount, 1);
        assert.strictEqual(insights.favoriteItems[0].itemName, 'Айс кофе');
        assert.strictEqual(insights.ltv, 580);

        const dashboard = await DB.getCoffeeDashboard(instance.id);
        assert.strictEqual(dashboard.settings.mode, 'busy');
        assert.strictEqual(dashboard.today.ordersCreated, 1);
        assert.strictEqual(dashboard.today.completed, 1);

        await DB.updateCoffeeStopListItem(instance.id, stopItem.id, { isActive: false });
        assert.strictEqual((await DB.getCoffeeStopList(instance.id)).length, 0);
    });
    
    it('should manage Barista Staff', async () => {
        createTestDB();
        
        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        const tgChatId = '11223344';
        const name = 'Алексей';
        
        // 1. Add barista
        const barista = await DB.addBaristaStaff(instance.id, tgChatId, name);
        assert.ok(barista);
        assert.strictEqual(barista.telegramChatId, tgChatId);
        assert.strictEqual(barista.name, name);
        assert.strictEqual(barista.isActive, 1);
        
        // 2. Get staff
        const staff = await DB.getBaristaStaff(instance.id);
        assert.strictEqual(staff.length, 1);
        assert.strictEqual(staff[0].telegramChatId, tgChatId);
        
        // 3. Find barista instance
        const baristaInstance = await DB.findBaristaInstance(tgChatId);
        assert.ok(baristaInstance);
        assert.strictEqual(baristaInstance.instanceId, instance.id);
        assert.strictEqual(baristaInstance.instanceName, 'Coffee Shop');
        
        // 4. Remove barista (soft delete)
        await DB.removeBaristaStaff(instance.id, tgChatId);
        const staffAfterRemove = await DB.getBaristaStaff(instance.id);
        assert.strictEqual(staffAfterRemove.length, 0);
        
        const instanceAfterRemove = await DB.findBaristaInstance(tgChatId);
        assert.strictEqual(instanceAfterRemove, undefined);
    });
    
    it('should calculate Order Stats correctly', async () => {
        createTestDB();
        
        const instance = await DB.createInstance({ name: 'Coffee Shop' });
        
        // Create 4 orders
        const o1 = await DB.createOrder(instance.id, 'c1', 'Name', 'Cappuccino');
        const o2 = await DB.createOrder(instance.id, 'c2', 'Name', 'Latte');
        const o3 = await DB.createOrder(instance.id, 'c3', 'Name', 'Espresso');
        const o4 = await DB.createOrder(instance.id, 'c4', 'Name', 'Tea');
        
        // o1: stays new
        // o2: accepted
        await DB.updateOrderStatus(o2.id, 'accepted', 'b1', 'Michail');
        // o3: completed
        await DB.updateOrderStatus(o3.id, 'accepted', 'b1', 'Michail');
        await DB.updateOrderStatus(o3.id, 'completed');
        // o4: rejected
        await DB.updateOrderStatus(o4.id, 'rejected', 'b1', 'Michail');
        
        const stats = await DB.getOrderStats(instance.id);
        assert.strictEqual(stats.new, 1);
        assert.strictEqual(stats.accepted, 1);
        assert.strictEqual(stats.completed, 1);
        assert.strictEqual(stats.rejected, 1);
        assert.strictEqual(stats.expired, 0);
    });
});
