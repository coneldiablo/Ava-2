const Logger = require('../utils/logger');
const DB = require('./database.service');
const crypto = require('crypto');
const { buildTelegramOptions } = require('../utils/telegram-options');

class BaristaBotService {
    constructor() {
        this._bots = new Map(); // instanceId -> bot
        this._TelegramBot = null;
    }

    async start() {
        try {
            this._TelegramBot = require('./telegram-bot-compat');
        } catch (e) {
            Logger.warn('[BaristaBot] node-telegram-bot-api not installed. Barista bot disabled.');
            return;
        }

        const instances = await DB.getInstances();
        for (const instance of instances) {
            if (instance.baristaBotToken && instance.isActive) {
                await this._startBot(instance);
            }
        }
        Logger.info(`[BaristaBot] ☕ Barista bot service initialized (${this._bots.size} bot(s))`);
    }

    async _startBot(instance) {
        if (!this._TelegramBot || !instance.baristaBotToken) return;
        if (this._bots.has(instance.id)) {
            await this._stopBot(instance.id);
        }

        try {
            const bot = new this._TelegramBot(instance.baristaBotToken, buildTelegramOptions());

            // Handle /start command — register barista with an invite code
            bot.onText(/^\/start(?:@\w+)?(?:\s+(.+?))?\s*$/, async (msg, match) => {
                try {
                    await this._handleStart(instance.id, msg, match?.[1]);
                } catch (e) {
                    Logger.error('[BaristaBot] /start error:', e.message);
                }
            });

            // Handle /orders command — show active orders
            bot.onText(/\/orders/, async (msg) => {
                try {
                    await this._handleOrders(instance.id, msg, bot);
                } catch (e) {
                    Logger.error('[BaristaBot] /orders error:', e.message);
                }
            });

            bot.onText(/^\/stoplist(?:@\w+)?\s*$/, async (msg) => {
                try {
                    await this._handleStopList(instance.id, msg, bot);
                } catch (e) {
                    Logger.error('[BaristaBot] /stoplist error:', e.message);
                }
            });

            bot.onText(/^\/stop(?:@\w+)?\s+(add|remove|del|delete)\s+(.+?)\s*$/i, async (msg, match) => {
                try {
                    await this._handleStopCommand(instance.id, msg, bot, match?.[1], match?.[2]);
                } catch (e) {
                    Logger.error('[BaristaBot] /stop error:', e.message);
                }
            });

            // Handle /help command
            bot.onText(/\/help/, async (msg) => {
                const helpText = `☕ Бот баристы — команды:\n\n` +
                    `/start КОД — Зарегистрироваться как бариста\n` +
                    `/orders — Показать активные заказы\n` +
                    `/stoplist — Показать стоп-лист\n` +
                    `/stop add Название | причина — Добавить позицию в стоп-лист\n` +
                    `/stop remove Название — Убрать позицию из стоп-листа\n` +
                    `/help — Эта справка\n\n` +
                    `Заказы приходят автоматически с кнопками управления.`;
                bot.sendMessage(msg.chat.id, helpText);
            });

            // Handle callback queries (Accept / Reject / Complete)
            bot.on('callback_query', async (query) => {
                try {
                    await this._handleCallback(instance.id, query, bot);
                } catch (e) {
                    Logger.error('[BaristaBot] Callback error:', e.message);
                    bot.answerCallbackQuery(query.id, { text: '❌ Ошибка обработки' });
                }
            });

            // Handle general messages (not commands)
            bot.on('message', async (msg) => {
                if (msg.text && msg.text.startsWith('/')) return; // skip commands
                const staff = await DB.findBaristaInstance(String(msg.chat.id));
                if (!staff) {
                    bot.sendMessage(msg.chat.id,
                        '👋 Привет! Я бот для баристов.\nОткройте ссылку приглашения или отправьте /start КОД.');
                }
            });

            bot.on('polling_error', (err) => {
                Logger.warn(`[BaristaBot] Polling error for instance ${instance.id}: ${err.message}`);
            });

            // Get bot info
            try {
                const me = await bot.getMe();
                if (me.username && me.username !== instance.baristaBotUsername) {
                    await DB.updateInstance(instance.id, { baristaBotUsername: me.username });
                }
                Logger.info(`[BaristaBot] ✅ Bot @${me.username} started for instance ${instance.id}`);
            } catch (e) {
                Logger.warn('[BaristaBot] Could not get bot info:', e.message);
            }

            this._bots.set(instance.id, bot);
            bot.startPolling();
        } catch (e) {
            Logger.error(`[BaristaBot] Failed to start bot for instance ${instance.id}:`, e.message);
        }
    }

    async _stopBot(instanceId) {
        const bot = this._bots.get(instanceId);
        if (bot) {
            try {
                await bot.stopPolling();
            } catch (e) { /* ignore */ }
            this._bots.delete(instanceId);
        }
    }

    // ============================================================
    // COMMAND HANDLERS
    // ============================================================

    async _handleStart(instanceId, msg, providedInviteCode = '') {
        const telegramChatId = String(msg.chat.id);
        const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || 'Бариста';

        const bot = this._bots.get(instanceId);
        if (!bot) return;

        const existingStaff = await DB.getBaristaStaffMember(instanceId, telegramChatId);
        const instance = await DB.getInstance(instanceId);
        const expectedInviteCode = String(instance?.baristaInviteCode || '').trim();
        const actualInviteCode = String(providedInviteCode || '').trim();

        if (!existingStaff) {
            if (!expectedInviteCode) {
                await bot.sendMessage(
                    telegramChatId,
                    'Регистрация сотрудников пока закрыта. Администратор должен задать код приглашения в CRM.'
                );
                return;
            }
            if (actualInviteCode !== expectedInviteCode) {
                await bot.sendMessage(
                    telegramChatId,
                    'Неверный код приглашения. Откройте ссылку, которую выдал администратор кофейни.'
                );
                return;
            }
        }

        // Register barista
        await DB.addBaristaStaff(instanceId, telegramChatId, name);

        const instanceName = instance ? instance.name : `#${instanceId}`;

        bot.sendMessage(telegramChatId,
            `✅ Вы зарегистрированы как бариста!\n\n` +
            `☕ Кофейня: ${instanceName}\n` +
            `👤 Имя: ${name}\n\n` +
            `Теперь вы будете получать уведомления о новых заказах.\n` +
            `Используйте /orders для просмотра активных заказов.`
        );

        Logger.info(`[BaristaBot] 👤 Barista "${name}" registered for instance ${instanceId}`);
    }

    async _handleOrders(instanceId, msg, bot) {
        const telegramChatId = String(msg.chat.id);

        // Check if registered
        const staff = await DB.getBaristaStaffMember(instanceId, telegramChatId);
        if (!staff) {
            bot.sendMessage(telegramChatId, '⚠️ Вы не зарегистрированы. Нажмите /start');
            return;
        }

        const orders = await DB.getActiveOrders(instanceId);
        if (orders.length === 0) {
            bot.sendMessage(telegramChatId, '📭 Активных заказов нет');
            return;
        }

        let text = `📋 Активные заказы (${orders.length}):\n\n`;
        for (const order of orders) {
            const statusEmoji = order.status === 'new' ? '🆕' : (order.status === 'ready' ? '🏁' : '🔄');
            const time = new Date(order.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            text += `${statusEmoji} #${order.id} — ${order.orderSummary}\n`;
            text += `   👤 ${order.clientName || 'Клиент'} · ⏰ ${time}\n`;
            text += `   Статус: ${order.status === 'new' ? 'Ожидает' : (order.status === 'ready' ? 'Готов к выдаче' : 'Готовится')}\n\n`;
        }

        bot.sendMessage(telegramChatId, text);
    }

    async _handleStopList(instanceId, msg, bot) {
        const telegramChatId = String(msg.chat.id);
        const staff = await DB.getBaristaStaffMember(instanceId, telegramChatId);
        if (!staff) {
            bot.sendMessage(telegramChatId, '⚠️ Вы не зарегистрированы. Нажмите /start');
            return;
        }

        const items = await DB.getCoffeeStopList(instanceId);
        if (items.length === 0) {
            bot.sendMessage(telegramChatId, '✅ Стоп-лист пуст');
            return;
        }

        const text = `⛔ Стоп-лист (${items.length}):\n\n` +
            items.map((item) => `• ${item.itemName}${item.reason ? ` — ${item.reason}` : ''}`).join('\n');
        bot.sendMessage(telegramChatId, text);
    }

    async _handleStopCommand(instanceId, msg, bot, action, payload) {
        const telegramChatId = String(msg.chat.id);
        const staff = await DB.getBaristaStaffMember(instanceId, telegramChatId);
        if (!staff) {
            bot.sendMessage(telegramChatId, '⚠️ Вы не зарегистрированы. Нажмите /start');
            return;
        }

        const normalizedAction = String(action || '').toLowerCase();
        const rawPayload = String(payload || '').trim();
        if (!rawPayload) {
            bot.sendMessage(telegramChatId, 'Укажите название позиции.');
            return;
        }

        if (normalizedAction === 'add') {
            const [itemName, ...reasonParts] = rawPayload.split('|');
            const item = await DB.addCoffeeStopListItem(instanceId, {
                itemName: itemName.trim(),
                reason: reasonParts.join('|').trim(),
                addedBy: staff.name
            });
            bot.sendMessage(telegramChatId, `⛔ Добавлено в стоп-лист: ${item.itemName}`);
            return;
        }

        const items = await DB.getCoffeeStopList(instanceId, true);
        const target = items.find((item) => item.itemName.toLowerCase() === rawPayload.toLowerCase());
        if (!target) {
            bot.sendMessage(telegramChatId, `Позиция не найдена в стоп-листе: ${rawPayload}`);
            return;
        }

        await DB.updateCoffeeStopListItem(instanceId, target.id, { isActive: false });
        bot.sendMessage(telegramChatId, `✅ Убрано из стоп-листа: ${target.itemName}`);
    }

    // ============================================================
    // CALLBACK QUERY HANDLER (inline buttons)
    // ============================================================

    async _handleCallback(instanceId, query, bot) {
        const data = query.data;
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const baristaName = [query.from.first_name, query.from.last_name].filter(Boolean).join(' ') || 'Бариста';
        const baristaChatId = String(chatId);

        const staff = await DB.getBaristaStaffMember(instanceId, baristaChatId);
        if (!staff) {
            await bot.answerCallbackQuery(query.id, { text: '⛔ Нет доступа к заказам' });
            return;
        }

        if (data.startsWith('accept_order_')) {
            const orderId = parseInt(data.replace('accept_order_', ''));
            const accepted = await this._acceptOrder(instanceId, orderId, baristaChatId, baristaName, bot, chatId, messageId);
            bot.answerCallbackQuery(query.id, { text: accepted ? '✅ Заказ принят!' : '⚠️ Заказ уже обработан' });

        } else if (data.startsWith('reject_order_')) {
            const orderId = parseInt(data.replace('reject_order_', ''));
            const rejected = await this._rejectOrder(instanceId, orderId, baristaChatId, baristaName, bot, chatId, messageId);
            bot.answerCallbackQuery(query.id, { text: rejected ? '❌ Заказ отклонён' : '⚠️ Заказ уже обработан' });

        } else if (data.startsWith('ready_order_')) {
            const orderId = parseInt(data.replace('ready_order_', ''));
            const ready = await this._readyOrder(instanceId, orderId, bot, chatId, messageId);
            bot.answerCallbackQuery(query.id, { text: ready ? '🏁 Клиент уведомлён' : '⚠️ Заказ уже обработан' });

        } else if (data.startsWith('complete_order_')) {
            const orderId = parseInt(data.replace('complete_order_', ''));
            const completed = await this._completeOrder(instanceId, orderId, bot, chatId, messageId);
            bot.answerCallbackQuery(query.id, { text: completed ? '✅ Заказ выдан!' : '⚠️ Заказ уже обработан' });

        } else {
            bot.answerCallbackQuery(query.id, { text: '❓ Неизвестная команда' });
        }
    }

    async _acceptOrder(instanceId, orderId, baristaChatId, baristaName, bot, chatId, messageId) {
        const existingOrder = await DB.getOrder(orderId);
        if (!existingOrder || existingOrder.instanceId !== instanceId) {
            bot.sendMessage(chatId, '⚠️ Заказ не найден');
            return false;
        }

        const order = await DB.transitionOrderStatus(
            instanceId,
            orderId,
            'new',
            'accepted',
            baristaChatId,
            baristaName
        );
        if (!order) {
            const currentOrder = await DB.getOrder(orderId);
            bot.sendMessage(chatId, `⚠️ Заказ #${orderId} уже ${currentOrder?.status === 'accepted' ? 'принят' : 'обработан'}`);
            return false;
        }

        const instance = await DB.getInstance(instanceId);
        const isCoffeePickup = instance?.salesGoal === 'coffee_pickup';

        // Update client status in CRM
        try {
            await DB.updateClientStatus(instanceId, order.chatId, isCoffeePickup ? 'pickup_confirmed' : 'offer',
                `Бариста ${baristaName} принял заказ #${orderId}`, 'barista');
        } catch (e) {
            Logger.warn(`[BaristaBot] Status update failed: ${e.message}`);
        }

        // Notify client via WhatsApp/Telegram
        try {
            const ChannelRouter = require('./channel-router.service');
            const clientMessage = isCoffeePickup
                ? `✅ Заказ подтверждён, готовим.\n\n📋 ${order.orderSummary}\n🕒 Самовывоз: ${order.pickupTime || 'в согласованное время'}.\n\nОплата при получении.`
                : `✅ Ваш заказ принят, готовим! ☕\n\n📋 ${order.orderSummary}\n\nОповестим, когда будет готово!`;
            await ChannelRouter.sendMessage(instanceId, order.chatId,
                clientMessage);
        } catch (e) {
            Logger.warn(`[BaristaBot] Client notification failed: ${e.message}`);
        }

        // Edit Telegram message — replace buttons with "Ready" button
        try {
            const updatedText = `🔄 Заказ #${orderId} — ГОТОВИТСЯ\n\n` +
                `👤 ${order.clientName || 'Клиент'}\n` +
                `📋 ${order.orderSummary}\n` +
                (order.pickupTime ? `🕒 Самовывоз: ${order.pickupTime}\n` : '') +
                `👨‍🍳 Бариста: ${baristaName}\n` +
                `⏰ Принят: ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;

            bot.editMessageText(updatedText, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🏁 Готов к выдаче', callback_data: `ready_order_${orderId}` }
                    ]]
                }
            });
        } catch (e) {
            Logger.warn(`[BaristaBot] Message edit failed: ${e.message}`);
        }

        // Notify other baristas that order was taken
        await this._notifyOtherBaristas(instanceId, baristaChatId, bot,
            `📌 Заказ #${orderId} принят баристой ${baristaName}`);

        Logger.info(`[BaristaBot] ✅ Order #${orderId} accepted by ${baristaName}`);
        return true;
    }

    async _rejectOrder(instanceId, orderId, baristaChatId, baristaName, bot, chatId, messageId) {
        const existingOrder = await DB.getOrder(orderId);
        if (!existingOrder || existingOrder.instanceId !== instanceId) {
            bot.sendMessage(chatId, '⚠️ Заказ не найден');
            return false;
        }

        const order = await DB.transitionOrderStatus(
            instanceId,
            orderId,
            'new',
            'rejected',
            baristaChatId,
            baristaName
        );
        if (!order) {
            bot.sendMessage(chatId, `⚠️ Заказ #${orderId} уже обработан`);
            return false;
        }

        // Notify client
        try {
            const ChannelRouter = require('./channel-router.service');
            await ChannelRouter.sendMessage(instanceId, order.chatId,
                `К сожалению, сейчас не можем выполнить этот заказ 😔\nПопробуйте заказать позже или выбрать что-то другое!`);
        } catch (e) {
            Logger.warn(`[BaristaBot] Client rejection notification failed: ${e.message}`);
        }

        // Edit Telegram message
        try {
            const updatedText = `❌ Заказ #${orderId} — ОТКЛОНЁН\n\n` +
                `👤 ${order.clientName || 'Клиент'}\n` +
                `📋 ${order.orderSummary}\n` +
                `👨‍🍳 Отклонил: ${baristaName}`;

            bot.editMessageText(updatedText, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: [] }
            });
        } catch (e) {
            Logger.warn(`[BaristaBot] Message edit failed: ${e.message}`);
        }

        Logger.info(`[BaristaBot] ❌ Order #${orderId} rejected by ${baristaName}`);
        return true;
    }

    async _readyOrder(instanceId, orderId, bot, chatId, messageId) {
        const existingOrder = await DB.getOrder(orderId);
        if (!existingOrder || existingOrder.instanceId !== instanceId) {
            bot.sendMessage(chatId, '⚠️ Заказ не найден');
            return false;
        }

        const order = await DB.transitionOrderStatus(instanceId, orderId, 'accepted', 'ready');
        if (!order) {
            bot.sendMessage(chatId, `⚠️ Заказ #${orderId} не в статусе "готовится"`);
            return false;
        }

        const instance = await DB.getInstance(instanceId);
        const isCoffeePickup = instance?.salesGoal === 'coffee_pickup';

        // Update client status in CRM
        try {
            await DB.updateClientStatus(instanceId, order.chatId, isCoffeePickup ? 'ready_for_pickup' : 'booked',
                `Заказ #${orderId} готов к выдаче`, 'barista');
        } catch (e) {
            Logger.warn(`[BaristaBot] Status update failed: ${e.message}`);
        }

        // Notify client that order is ready
        try {
            const ChannelRouter = require('./channel-router.service');
            await ChannelRouter.sendMessage(instanceId, order.chatId,
                `🏁 Заказ готов, можете забрать.\n\n📋 ${order.orderSummary}`);
        } catch (e) {
            Logger.warn(`[BaristaBot] Client ready notification failed: ${e.message}`);
        }

        // Edit Telegram message
        try {
            const readyAt = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            const updatedText = `🏁 Заказ #${orderId} — ГОТОВ К ВЫДАЧЕ\n\n` +
                `👤 ${order.clientName || 'Клиент'}\n` +
                `📋 ${order.orderSummary}\n` +
                `🏁 Готов в ${readyAt}`;

            bot.editMessageText(updatedText, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Выдано', callback_data: `complete_order_${orderId}` }
                    ]]
                }
            });
        } catch (e) {
            Logger.warn(`[BaristaBot] Message edit failed: ${e.message}`);
        }

        Logger.info(`[BaristaBot] 🏁 Order #${orderId} ready for pickup`);
        return true;
    }

    async _completeOrder(instanceId, orderId, bot, chatId, messageId) {
        const existingOrder = await DB.getOrder(orderId);
        if (!existingOrder || existingOrder.instanceId !== instanceId) {
            bot.sendMessage(chatId, '⚠️ Заказ не найден');
            return false;
        }

        let order = await DB.transitionOrderStatus(instanceId, orderId, 'ready', 'completed');
        if (!order && existingOrder.status === 'accepted') {
            // Backward compatibility for old Telegram buttons created before the ready stage existed.
            order = await DB.transitionOrderStatus(instanceId, orderId, 'accepted', 'completed');
        }
        if (!order) {
            bot.sendMessage(chatId, `⚠️ Заказ #${orderId} не в статусе "готов к выдаче"`);
            return false;
        }

        const instance = await DB.getInstance(instanceId);
        const isCoffeePickup = instance?.salesGoal === 'coffee_pickup';

        if (!isCoffeePickup) {
            try {
                await DB.updateClientStatus(instanceId, order.chatId, 'booked',
                    `Заказ #${orderId} выполнен`, 'barista');
            } catch (e) {
                Logger.warn(`[BaristaBot] Status update failed: ${e.message}`);
            }
        }

        // Completion is an internal issued status for coffee shops, so do not send noisy extra messages.
        if (!isCoffeePickup) {
            try {
                const ChannelRouter = require('./channel-router.service');
                await ChannelRouter.sendMessage(instanceId, order.chatId,
                    `Спасибо! Заказ закрыт.\n\n📋 ${order.orderSummary}`);
            } catch (e) {
                Logger.warn(`[BaristaBot] Client completion notification failed: ${e.message}`);
            }
        }

        try {
            const completedAt = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            const updatedText = `✅ Заказ #${orderId} — ВЫДАН\n\n` +
                `👤 ${order.clientName || 'Клиент'}\n` +
                `📋 ${order.orderSummary}\n` +
                `✅ Выдан в ${completedAt}`;

            bot.editMessageText(updatedText, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: [] }
            });
        } catch (e) {
            Logger.warn(`[BaristaBot] Message edit failed: ${e.message}`);
        }

        Logger.info(`[BaristaBot] ✅ Order #${orderId} completed`);
        return true;
    }

    // ============================================================
    // PUBLIC: Send order notification to all baristas
    // ============================================================

    async notifyNewOrder(instanceId, orderId, clientName, orderSummary, clientChatId, pickupTime = null) {
        const bot = this._bots.get(instanceId);
        if (!bot) {
            Logger.warn(`[BaristaBot] No bot for instance ${instanceId}`);
            return false;
        }

        const baristas = await DB.getBaristaStaff(instanceId);
        if (baristas.length === 0) {
            Logger.warn(`[BaristaBot] No baristas registered for instance ${instanceId}`);
            return false;
        }

        const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const channel = clientChatId.startsWith('tg_') ? 'Telegram' : 'WhatsApp';

        const text = this.formatOrderMessage(orderId, clientName, orderSummary, channel, time, pickupTime);

        const keyboard = {
            inline_keyboard: [[
                { text: '✅ Принять', callback_data: `accept_order_${orderId}` },
                { text: '❌ Отклонить', callback_data: `reject_order_${orderId}` }
            ]]
        };

        const messageIds = [];
        for (const barista of baristas) {
            try {
                const sent = await bot.sendMessage(barista.telegramChatId, text, {
                    reply_markup: keyboard
                });
                messageIds.push({ chatId: barista.telegramChatId, messageId: sent.message_id });
            } catch (e) {
                Logger.warn(`[BaristaBot] Failed to notify barista ${barista.name}: ${e.message}`);
            }
        }

        // Store message IDs for future edits
        if (messageIds.length > 0) {
            try {
                await DB.updateOrderTelegramMessageIds(orderId, messageIds);
            } catch (e) {
                Logger.warn(`[BaristaBot] Failed to save message IDs: ${e.message}`);
            }
        }

        Logger.info(`[BaristaBot] 📢 Notified ${messageIds.length}/${baristas.length} baristas about order #${orderId}`);
        return messageIds.length > 0;
    }

    async dispatchOrder(instanceId, clientChatId, clientName, orderSummary, pickupTime = null, orderItems = []) {
        const instance = await DB.getInstance(instanceId);
        if (instance?.salesGoal === 'coffee_pickup' && !String(pickupTime || '').trim()) {
            Logger.warn(`[BaristaBot] Coffee order for ${clientChatId} was not dispatched: pickup time is missing`);
            return {
                order: null,
                created: false,
                updated: false,
                notified: false,
                reason: 'pickup_time_required'
            };
        }

        const result = await DB.createOrderIfNew(instanceId, clientChatId, clientName, orderSummary, pickupTime, orderItems);
        const { order, created, updated } = result;
        if (!order) return { ...result, notified: false };

        let existingMessageIds = [];
        try {
            existingMessageIds = JSON.parse(order.telegramMessageIds || '[]');
        } catch (e) {
            existingMessageIds = [];
        }

        if (!created && !updated && ['accepted', 'ready'].includes(order.status)) {
            return { ...result, notified: true };
        }

        if (!this.isActive(instanceId)) {
            Logger.warn(`[BaristaBot] Order #${order.id} saved, but bot is inactive`);
            return { ...result, notified: !updated && existingMessageIds.length > 0 };
        }

        if (updated && existingMessageIds.length > 0) {
            const bot = this._bots.get(instanceId);
            const channel = clientChatId.startsWith('tg_') ? 'Telegram' : 'WhatsApp';
            const text = `✏️ Заказ #${order.id} обновлён\n\n` +
                `👤 ${clientName} (${channel})\n` +
                `📋 ${order.orderSummary}\n` +
                (order.pickupTime ? `🕒 Самовывоз: ${order.pickupTime}\n` : '') +
                `⏰ ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
            const keyboard = {
                inline_keyboard: [[
                    { text: '✅ Принять', callback_data: `accept_order_${order.id}` },
                    { text: '❌ Отклонить', callback_data: `reject_order_${order.id}` }
                ]]
            };

            let editedCount = 0;
            for (const message of existingMessageIds) {
                try {
                    await bot.editMessageText(text, {
                        chat_id: message.chatId,
                        message_id: message.messageId,
                        reply_markup: keyboard
                    });
                    editedCount++;
                } catch (e) {
                    Logger.warn(`[BaristaBot] Could not update order #${order.id} for ${message.chatId}: ${e.message}`);
                }
            }
            if (editedCount > 0) {
                return { ...result, notified: true };
            }
        }

        if (created || updated || existingMessageIds.length === 0) {
            const notified = await this.notifyNewOrder(
                instanceId,
                order.id,
                clientName,
                order.orderSummary,
                clientChatId,
                order.pickupTime
            );
            return { ...result, notified };
        }

        return { ...result, notified: true };
    }

    // Notify other baristas when order is taken
    async _notifyOtherBaristas(instanceId, excludeChatId, bot, text) {
        const baristas = await DB.getBaristaStaff(instanceId);
        for (const barista of baristas) {
            if (barista.telegramChatId === excludeChatId) continue;
            try {
                await bot.sendMessage(barista.telegramChatId, text);
            } catch (e) { /* ignore */ }
        }
    }

    // ============================================================
    // PUBLIC UTILITIES
    // ============================================================

    isActive(instanceId) {
        return this._bots.has(instanceId);
    }

    generateInviteCode() {
        return crypto.randomBytes(8).toString('hex');
    }

    async restartBot(instanceId, settings = {}) {
        const existingInstance = await DB.getInstance(instanceId);
        if (!existingInstance) {
            return { success: false, error: 'Instance not found' };
        }

        const updates = {};
        if (settings.baristaBotToken !== undefined) {
            updates.baristaBotToken = String(settings.baristaBotToken || '').trim();
        }

        const requestedInviteCode = String(settings.baristaInviteCode || '').trim();
        const inviteCode = requestedInviteCode
            || String(existingInstance.baristaInviteCode || '').trim()
            || this.generateInviteCode();

        if (inviteCode !== existingInstance.baristaInviteCode) {
            updates.baristaInviteCode = inviteCode;
        }

        const instance = Object.keys(updates).length > 0
            ? await DB.updateInstance(instanceId, updates)
            : existingInstance;

        if (instance && instance.baristaBotToken) {
            await this._startBot(instance);
            const refreshedInstance = await DB.getInstance(instanceId);
            return {
                success: true,
                inviteCode: refreshedInstance.baristaInviteCode,
                botUsername: refreshedInstance.baristaBotUsername || null
            };
        }
        await this._stopBot(instanceId);
        return {
            success: false,
            inviteCode,
            error: 'No barista bot token configured'
        };
    }

    // Static method for formatting (used in tests)
    formatOrderMessage(orderId, clientName, orderSummary, channel = 'WhatsApp', formattedTime = null, pickupTime = null) {
        const time = formattedTime || new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        return `☕ Новый заказ #${orderId}\n\n` +
            `👤 ${clientName} (${channel})\n` +
            `📋 ${orderSummary}\n` +
            (pickupTime ? `🕒 Самовывоз: ${pickupTime}\n` : '') +
            `⏰ ${time}`;
    }
}

module.exports = new BaristaBotService();
