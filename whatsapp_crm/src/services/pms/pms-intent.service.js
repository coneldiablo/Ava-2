const PmsService = require('./pms.service');
const Logger = require('../../utils/logger');

function isoDate(year, month, day) {
    const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.getUTCFullYear() === Number(year)
        && parsed.getUTCMonth() + 1 === Number(month) && parsed.getUTCDate() === Number(day) ? value : null;
}

function extractDates(text) {
    const found = [];
    for (const match of String(text || '').matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)) {
        const value = isoDate(match[1], match[2], match[3]);
        if (value) found.push(value);
    }
    for (const match of String(text || '').matchAll(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](20\d{2}))?\b/g)) {
        let year = Number(match[3] || new Date().getFullYear());
        let value = isoDate(year, match[2], match[1]);
        if (value && !match[3] && Date.parse(`${value}T00:00:00Z`) < Date.now() - 86400000) value = isoDate(year + 1, match[2], match[1]);
        if (value) found.push(value);
    }
    return [...new Set(found)].slice(0, 2);
}

function intent(text) {
    const value = String(text || '').toLowerCase().replace(/ё/g, 'е');
    const booking = /(брон|брониров|заезд|выезд)/.test(value);
    if (booking && /(моя|мою|статус|провер|найд|номер брони)/.test(value)) return 'lookup';
    if (/(заброни|оформить брон|оставить заявк|хочу бронир)/.test(value)) return 'request';
    if (/(налич|свободн|есть(?: ли)?.*номер|номер.*есть|стоим|цен|сколько.*номер)/.test(value)) return 'availability';
    return null;
}

function formatAvailability(result) {
    const categories = result.categories || [];
    if (!categories.length) return `На даты ${result.date_from} — ${result.date_to} доступных категорий по подключенным тарифам не найдено.`;
    const lines = categories.slice(0, 3).map((category) => {
        const offer = [...(category.offers || [])].sort((a, b) => Number(a.total) - Number(b.total))[0];
        return `${category.category}: ${offer.total} ${offer.currency} за ${result.nights} ноч.`;
    });
    return `По данным Bnovo на ${result.date_from} — ${result.date_to}: ${lines.join(' ')}`;
}

class PmsIntentService {
    constructor() {
        this.pending = new Map();
        this.pendingTtlMs = 10 * 60 * 1000;
    }

    _pendingKey(input) {
        return `${Number(input.businessId)}:${String(input.chatId || input.phone || '')}`;
    }

    _getPending(input) {
        const key = this._pendingKey(input);
        const value = this.pending.get(key);
        if (!value) return null;
        if (Date.now() - value.createdAt > this.pendingTtlMs) {
            this.pending.delete(key);
            return null;
        }
        return value;
    }

    _isYes(text) {
        return /^(?:да|ага|хорошо|оформляй|оформите|оставьте|создай|создайте|согласен|согласна)(?:\s|$)/i.test(String(text || '').trim());
    }

    _isNo(text) {
        return /^(?:нет|не надо|не нужно|отмена|не стоит)(?:\s|$)/i.test(String(text || '').trim());
    }

    _availabilityFallback(input, key, dateFrom, dateTo) {
        this.pending.set(key, {
            intent: 'availability_request_confirmation',
            createdAt: Date.now(),
            dateFrom,
            dateTo,
        });
        return {
            handled: true,
            reply: 'Сейчас я не могу подтвердить актуальное наличие и цену через Bnovo. Могу оформить заявку на эти даты, чтобы её проверили. Оформить?',
            manager_task_created: false,
        };
    }

    async handle(input = {}) {
        const pms = PmsService.get(input.businessId);
        if (!pms?.enabled) return null;
        const key = this._pendingKey(input);
        const pending = this._getPending(input);
        if (pending?.intent === 'availability_request_confirmation') {
            if (this._isYes(input.text)) {
                this.pending.delete(key);
                const request = PmsService.createBookingRequest(input.businessId, {
                    channel: 'whatsapp', message_batch_id: input.messageBatchId,
                    chat_id: input.chatId, customer_id: input.customerId,
                    caller_number: input.phone, name: input.customerName,
                    date_from: pending.dateFrom, date_to: pending.dateTo,
                    summary: `Проверить наличие на ${pending.dateFrom} — ${pending.dateTo}`,
                });
                return {
                    handled: true,
                    reply: `Заявка на даты ${pending.dateFrom} — ${pending.dateTo} создана. Менеджер подтвердит наличие и цену.`,
                    request,
                };
            }
            if (this._isNo(input.text)) {
                this.pending.delete(key);
                return { handled: true, reply: 'Хорошо, заявку не создаю. Могу ответить на другие вопросы об отеле.' };
            }
            return { handled: true, reply: 'Оформить заявку на проверку этих дат? Ответьте «да» или «нет».' };
        }

        const detected = intent(input.text) || pending?.intent;
        if (!detected) return null;

        if (detected === 'lookup') {
            const result = PmsService.lookupBooking(input.businessId, { caller_number: input.phone, correlation_id: input.messageBatchId });
            if (!result.bookings.length) return { handled: true, reply: 'В этом отеле я не нашла активную бронь по вашему номеру. Напишите номер бронирования и фамилию гостя одним сообщением.' };
            this.pending.delete(key);
            const booking = result.bookings[0];
            return { handled: true, reply: `Бронь ${booking.booking_number || ''}: заезд ${booking.arrival || 'не указан'}, выезд ${booking.departure || 'не указан'}, статус «${booking.status || 'не указан'}».` };
        }

        const dates = extractDates(input.text);
        if (dates.length < 2) {
            this.pending.set(key, { intent: detected, createdAt: Date.now() });
            return { handled: true, reply: 'Уточните, пожалуйста, две даты одним сообщением: дату заезда и дату выезда.' };
        }
        this.pending.delete(key);
        const [dateFrom, dateTo] = dates.sort();
        if (detected === 'request') {
            const request = PmsService.createBookingRequest(input.businessId, {
                channel: 'whatsapp', message_batch_id: input.messageBatchId,
                chat_id: input.chatId, customer_id: input.customerId,
                caller_number: input.phone, name: input.customerName,
                date_from: dateFrom, date_to: dateTo,
            });
            return { handled: true, reply: `Заявка на даты ${dateFrom} — ${dateTo} создана и передана менеджеру. Бронь в Bnovo пока не изменена; менеджер подтвердит наличие и итоговую цену.` , request };
        }

        try {
            const availability = await PmsService.checkAvailability(input.businessId, {
                date_from: dateFrom, date_to: dateTo, correlation_id: input.messageBatchId,
            });
            if (availability.live_check_available === false) {
                return this._availabilityFallback(input, key, dateFrom, dateTo);
            }
            return { handled: true, reply: formatAvailability(availability), availability };
        } catch (error) {
            Logger.warn(`[PMS WhatsApp] availability failed: ${error.code || 'error'} ${error.message}`);
            return this._availabilityFallback(input, key, dateFrom, dateTo);
        }
    }
}

module.exports = new PmsIntentService();
module.exports._internals = { intent, extractDates, formatAvailability };
