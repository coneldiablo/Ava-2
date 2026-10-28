const crypto = require('crypto');
const DB = require('./database.service');
const { redact } = require('./pms/pms-utils');

class WhatsAppHandoffService {
    create({ businessId, chatId, sourceMessageId, text }) {
        if (!Number.isSafeInteger(businessId) || businessId < 1 || !Number.isSafeInteger(sourceMessageId)) {
            throw new Error('WHATSAPP_HANDOFF_SCOPE_INVALID');
        }
        return DB.db.transaction(() => {
            const business = DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [businessId]);
            const client = DB.get('SELECT id,senderName FROM clients WHERE instanceId=? AND chatId=?', [businessId, chatId]);
            const message = DB.get("SELECT id FROM messages WHERE id=? AND instanceId=? AND chatId=? AND role='user'",
                [sourceMessageId, businessId, chatId]);
            if (!business || !client || !message) throw new Error('WHATSAPP_HANDOFF_SCOPE_INVALID');
            const key = crypto.createHash('sha256').update(JSON.stringify([businessId, chatId, sourceMessageId])).digest('hex');
            const taskId = `task_whatsapp_${businessId}_${key}`;
            const existing = DB.getManagerTask(businessId, taskId);
            if (existing) return { task: existing, created: false };
            const summary = `Нужна помощь менеджера по обращению WhatsApp: ${redact(text, 650)}`;
            const phone = /^([1-9][0-9]{7,14})@(c\.us|s\.whatsapp\.net)$/.exec(String(chatId))?.[1] || null;
            const event = DB.createConversationEvent({ eventId: `evt_whatsapp_${key}`, instanceId: businessId,
                chatId, customerId: client.id, channel: 'manager', direction: 'internal', role: 'task',
                content: summary, sourceId: String(sourceMessageId),
                metadata: { reason: 'other', source: 'whatsapp_handoff', source_message_id: sourceMessageId } });
            const task = DB.createManagerTask({ taskId, instanceId: businessId, chatId, customerId: client.id,
                phone, customerName: client.senderName, summary, reason: 'other', priority: 'normal', status: 'new',
                source: 'whatsapp_handoff', conversationEventId: event.eventId,
                metadata: { channel: 'whatsapp', source_message_id: sourceMessageId } });
            if (!task) throw new Error('WHATSAPP_HANDOFF_WRITE_FAILED');
            DB.createToolRun({ toolRunId: `tool_whatsapp_handoff_${key}`, instanceId: businessId,
                chatId, customerId: client.id, conversationEventId: event.eventId,
                toolName: 'create_manager_task', phase: 'chat', argsRedacted: { reason: 'other' },
                resultRedacted: { taskId: task.taskId, eventId: event.eventId }, status: 'ok' });
            // The existing DB trigger enqueues this task to Twenty in this
            // same transaction, when the business has an enabled workspace.
            return { task, created: true };
        }).immediate();
    }
}

module.exports = new WhatsAppHandoffService();
