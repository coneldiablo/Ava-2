const axios = require('axios');
const DB = require('./database.service');
const Logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

class YookassaService {
    async getCredentials(instanceId) {
        const instance = await DB.getInstance(instanceId);
        if (!instance || !instance.yookassaShopId || !instance.yookassaSecretKey) {
            throw new Error('ЮKassa не настроена для этого бизнеса. Укажите Shop ID и Secret Key в настройках.');
        }
        return {
            shopId: instance.yookassaShopId,
            secretKey: instance.yookassaSecretKey
        };
    }

    async createPaymentLink(instanceId, chatId, amount, description) {
        try {
            const numericAmount = Number(amount);
            if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
                throw new Error('Сумма платежа должна быть положительным числом.');
            }
            const credentials = await this.getCredentials(instanceId);
            const idempotenceKey = uuidv4();

            const createPayload = {
                amount: {
                    value: numericAmount.toFixed(2),
                    currency: 'RUB'
                },
                payment_method_data: {
                    type: 'bank_card'
                },
                confirmation: {
                    type: 'redirect',
                    return_url: 'https://wa.me' // Will redirect the user back to WA ideally
                },
                description: description || 'Оплата услуг',
                capture: true,
                metadata: {
                    instanceId: instanceId.toString(),
                    chatId: chatId
                }
            };

            const response = await axios.post('https://api.yookassa.ru/v3/payments', createPayload, {
                auth: {
                    username: credentials.shopId,
                    password: credentials.secretKey,
                },
                headers: {
                    'Idempotence-Key': idempotenceKey,
                    'Content-Type': 'application/json',
                },
                timeout: 15000,
                maxRedirects: 0,
            });
            const payment = response.data;
            if (!payment?.id || !payment?.confirmation?.confirmation_url) {
                throw new Error('ЮKassa вернула неполный ответ без ссылки на оплату.');
            }

            // Save to DB
            await DB.createPayment(payment.id, instanceId, chatId, numericAmount, description, payment.status);

            Logger.success(`Создана платежная ссылка для ${chatId} (${instanceId}), сумма: ${numericAmount}`);

            return {
                paymentId: payment.id,
                confirmationUrl: payment.confirmation.confirmation_url,
                status: payment.status
            };
        } catch (error) {
            const status = Number(error?.response?.status || 0);
            const code = String(error?.response?.data?.code || error?.code || 'YOOKASSA_REQUEST_FAILED').slice(0, 80);
            Logger.error(`Ошибка создания платежа ЮKassa: code=${code}${status ? ` status=${status}` : ''}`);
            throw error;
        }
    }
}

module.exports = new YookassaService();
