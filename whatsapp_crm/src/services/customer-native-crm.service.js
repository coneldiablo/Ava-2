'use strict';

const crypto = require('crypto');
const DB = require('./database.service');

const fail = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });
const TASK_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function connected(businessId) {
    const row = DB.get(`SELECT enabled,mode,connectionStatus FROM twenty_workspace_links WHERE businessId=?`, [businessId]);
    return Boolean(row?.enabled && row.mode === 'live' && row.connectionStatus === 'connected');
}

function taskState(businessId, taskId) {
    const task = DB.getManagerTask(businessId, taskId);
    if (!task) throw fail('TASK_NOT_FOUND', 404);
    const link = DB.get(`SELECT twentyRecordId,lastSyncedAt FROM twenty_record_links
        WHERE businessId=? AND sourceTable='manager_tasks' AND sourceId=?`, [businessId, taskId]);
    const outbox = DB.get(`SELECT status,lastErrorCode FROM twenty_sync_outbox
        WHERE businessId=? AND sourceTable='manager_tasks' AND sourceId=? ORDER BY createdAt DESC,eventId DESC LIMIT 1`,
    [businessId, taskId]);
    return {
        taskId, summary: task.summary, status: task.status,
        customerName: task.customerName || null,
        nativeStatus: link && outbox?.status === 'DONE' ? 'verified'
            : outbox?.status === 'DEAD' || outbox?.status === 'FAILED' ? 'failed' : 'pending',
        verifiedAt: link && outbox?.status === 'DONE' ? link.lastSyncedAt : null,
    };
}

function createTask(businessId, userId, { key, summary, chatId = null }) {
    if (!TASK_KEY.test(key || '') || typeof summary !== 'string' || !summary.trim()
        || summary.length > 160 || (chatId != null && (typeof chatId !== 'string' || chatId.length > 256))) {
        throw fail('TASK_INVALID', 400);
    }
    const taskId = `customer_${crypto.createHash('sha256').update(JSON.stringify([businessId, userId, key])).digest('hex')}`;
    return DB.db.transaction(() => {
        if (!connected(businessId)) throw fail('TWENTY_NOT_READY', 503);
        const existing = DB.getManagerTask(businessId, taskId);
        if (existing) {
            if (existing.summary !== summary.trim() || existing.chatId !== chatId) throw fail('TASK_KEY_CONFLICT');
            return taskState(businessId, taskId);
        }
        const client = chatId ? DB.get('SELECT chatId,senderName FROM clients WHERE instanceId=? AND chatId=?', [businessId, chatId]) : null;
        if (chatId && !client) throw fail('CLIENT_NOT_FOUND', 404);
        const phone = client?.chatId?.match(/^\+?([1-9]\d{7,14})(?:@(c\.us|s\.whatsapp\.net))?$/)?.[1] || null;
        const created = DB.createManagerTask({ taskId, instanceId: businessId, chatId,
            customerName: client?.senderName || null, phone: phone ? `+${phone}` : null,
            summary: summary.trim(), reason: 'manual', source: 'customer_crm' });
        if (!created) throw fail('TASK_KEY_CONFLICT');
        // The existing Twenty trigger writes the outbox row in this transaction.
        const queued = DB.get(`SELECT eventId FROM twenty_sync_outbox WHERE businessId=?
            AND sourceTable='manager_tasks' AND sourceId=? LIMIT 1`, [businessId, taskId]);
        if (!queued) throw fail('TWENTY_OUTBOX_UNAVAILABLE', 503);
        return taskState(businessId, taskId);
    }).immediate();
}

module.exports = { connected, createTask, taskState };
