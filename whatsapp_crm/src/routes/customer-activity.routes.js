'use strict';

const express = require('express');
const axios = require('axios');
const DB = require('../services/database.service');
const Identity = require('../services/identity/identity-store');
const config = require('../config');

const router = express.Router();
const MAX_LIMIT = 100;
const EVENT_TYPES = new Set(['all', 'message', 'status', 'task', 'followup', 'call']);
const STATUS_LABELS = {
    new: 'Новое обращение', qualified: 'Квалифицирован', audit: 'Аудит', offer: 'Предложение',
    booked: 'Записан', junk: 'Отказ', pickup_confirmed: 'Самовывоз подтверждён',
    ready_for_pickup: 'Готов к выдаче',
};
const CALL_OUTCOMES = {
    completed: 'Завершён', answered: 'Ответили', no_answer: 'Без ответа',
    busy: 'Занято', failed: 'Ошибка', canceled: 'Отменён', transferred: 'Переведён',
    voicemail: 'Автоответчик', voicemail_drop: 'Сообщение оставлено',
};

function text(value, maxLength = 500) {
    return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function phone(value) {
    return typeof value === 'string' && /^\+?[0-9()\-\s]{5,24}$/.test(value)
        ? value.trim() : 'Номер не указан';
}

function utcTimestamp(value) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw || raw.length > 64) return null;
    const naive = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/);
    const timestamp = naive ? `${naive[1]}T${naive[2]}${naive[3] || ''}Z` : raw;
    return Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

function eventMillis(event) {
    return Date.parse(event.occurredAt || '') || 0;
}

async function callEvents(businessId, limit) {
    const { apiUrl, serviceToken, timeoutMs } = config.avaAdmin;
    if (!apiUrl || !serviceToken) return { events: [], status: 'unavailable' };
    try {
        const response = await axios.get(`${apiUrl}/api/internal/calls/business/${businessId}`, {
            params: { page: 1, page_size: Math.min(limit, 50) },
            headers: { Authorization: `Bearer ${serviceToken}`, Accept: 'application/json' },
            timeout: Math.min(timeoutMs, 5000), maxRedirects: 0,
            maxContentLength: 256 * 1024,
        });
        const rows = response.data?.calls;
        if (!Array.isArray(rows) || rows.some(row => Number(row.business_id) !== businessId)) {
            throw new Error('CALL_HISTORY_SCOPE_MISMATCH');
        }
        return {
            status: 'ready',
            events: rows.filter(row => row && (row.id != null || row.call_id)
                    && utcTimestamp(row.start_time))
                .map(row => ({
                    id: `call-${String(row.id ?? row.call_id).slice(0, 100)}`, type: 'call',
                    title: row.direction === 'outbound' ? 'Исходящий звонок' : 'Входящий звонок',
                    detail: `${phone(row.direction === 'outbound' ? row.called_number : row.caller_number)} · ${Object.hasOwn(CALL_OUTCOMES, row.outcome) ? CALL_OUTCOMES[row.outcome] : 'Результат неизвестен'}`,
                    occurredAt: utcTimestamp(row.start_time),
                })),
        };
    } catch (_) {
        // Do not leak upstream URLs, headers, credentials, or another tenant's calls.
        return { events: [], status: 'unavailable' };
    }
}

router.get('/businesses/:businessId/activity', async (req, res) => {
    const businessId = Number(req.params.businessId);
    const parsedLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    const type = req.query.type === undefined ? 'all' : req.query.type;
    if (!Number.isSafeInteger(businessId) || businessId < 1 ||
        !Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || !EVENT_TYPES.has(type)) {
        return res.status(400).json({ success: false, error: 'INVALID_ACTIVITY_SCOPE' });
    }
    const limit = Math.min(parsedLimit, MAX_LIMIT);
    try {
        if (!req.auth?.userId && req.auth?.platformRole !== 'platform_admin') {
            return res.status(403).json({ success: false, error: 'CUSTOMER_ACCESS_REQUIRED' });
        }
        // Enforces active-account state and live membership on every request.
        Identity.authorizeCapability(req.auth, businessId, 'business.read');

        const messages = type !== 'all' && type !== 'message' ? [] : DB.all(
            `SELECT id, chatId, senderName, messageType, content, role, timestamp
             FROM messages WHERE instanceId = ?
             ORDER BY timestamp DESC, id DESC LIMIT ?`, [businessId, limit]
        ).map(row => ({
            id: `message-${row.id}`, type: 'message', chatId: row.chatId,
            title: row.role === 'user' ? 'Сообщение клиента' : row.role === 'assistant' ? 'Ответ ассистента' : 'Сообщение',
            detail: row.content ? String(row.content).slice(0, 500) : 'Сообщение без текста',
            senderName: row.senderName || null,
            messageType: row.messageType || 'text', occurredAt: utcTimestamp(row.timestamp),
        }));
        const statuses = type !== 'all' && type !== 'status' ? [] : DB.all(
            `SELECT id, chatId, fromStatus, toStatus, createdAt
             FROM lead_status_history WHERE instanceId = ?
             ORDER BY createdAt DESC, id DESC LIMIT ?`, [businessId, limit]
        ).map(row => ({
            id: `status-${row.id}`, type: 'status', chatId: row.chatId,
            title: 'Изменение статуса',
            detail: `${STATUS_LABELS[row.fromStatus] || row.fromStatus || 'Без статуса'} → ${STATUS_LABELS[row.toStatus] || row.toStatus}`,
            occurredAt: utcTimestamp(row.createdAt),
        }));
        const tasks = type !== 'all' && type !== 'task' ? [] : DB.all(
            `SELECT taskId, chatId, customerName, summary, status, createdAt, closedAt
             FROM manager_tasks WHERE instanceId = ?
             ORDER BY CASE WHEN closedAt IS NOT NULL AND julianday(closedAt) > julianday(createdAt)
                THEN julianday(closedAt) ELSE julianday(createdAt) END DESC, taskId DESC LIMIT ?`, [businessId, limit]
        ).flatMap(row => {
            const base = {
                chatId: row.chatId || null,
                senderName: text(row.customerName, 120) || null,
                detail: text(row.summary) || 'Задача менеджеру',
            };
            const entries = [{ ...base, id: `task-${row.taskId}`, type: 'task',
                title: 'Задача менеджеру', occurredAt: utcTimestamp(row.createdAt) }];
            if (row.closedAt && ['done', 'cancelled'].includes(row.status)) entries.push({
                ...base, id: `task-closed-${row.taskId}`, type: 'task',
                title: row.status === 'done' ? 'Задача выполнена' : 'Задача отменена',
                occurredAt: utcTimestamp(row.closedAt),
            });
            return entries;
        });
        const followups = type !== 'all' && type !== 'followup' ? [] : DB.all(
            `SELECT draftId, chatId, originalText, text, status, createdAt, sentAt
             FROM followup_drafts WHERE instanceId = ?
             ORDER BY CASE WHEN status = 'sent' AND sentAt IS NOT NULL
                AND julianday(sentAt) > julianday(createdAt)
                THEN julianday(sentAt) ELSE julianday(createdAt) END DESC, draftId DESC LIMIT ?`, [businessId, limit]
        ).flatMap(row => {
            const base = { chatId: row.chatId || null };
            const entries = [{ ...base, id: `followup-${row.draftId}`, type: 'followup',
                detail: text(row.originalText) || 'Текст сообщения не указан',
                title: 'Черновик follow-up', occurredAt: utcTimestamp(row.createdAt) }];
            if (row.status === 'sent' && row.sentAt) entries.push({
                ...base, id: `followup-sent-${row.draftId}`, type: 'followup',
                detail: text(row.text) || 'Текст сообщения не указан',
                title: 'Follow-up отправлен', occurredAt: utcTimestamp(row.sentAt),
            });
            return entries;
        });
        const calls = type === 'all' || type === 'call'
            ? await callEvents(businessId, limit) : { events: [], status: 'not_requested' };
        // A membership can be revoked while the call-history request is in flight.
        require('../services/identity/customer-access').reauthorize(req, businessId, 'business.read');
        const events = [...messages, ...statuses, ...tasks, ...followups, ...calls.events]
            .sort((a, b) => eventMillis(b) - eventMillis(a) || b.id.localeCompare(a.id))
            .slice(0, limit);
        return res.json({ success: true, businessId, events, callHistoryStatus: calls.status });
    } catch (error) {
        if (error.statusCode) return res.status(error.statusCode).json({ success: false, error: 'BUSINESS_ACCESS_DENIED' });
        return res.status(500).json({ success: false, error: 'ACTIVITY_UNAVAILABLE' });
    }
});

module.exports = router;
