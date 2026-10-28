'use strict';

const DB = require('./database.service');
const Identity = require('./identity/identity-store');
const initialized = new WeakSet();
const table = name => Boolean(DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [name]));
const clean = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1200);
const stageName = value => ({ new: 'новая', qualified: 'квалифицирована', proposal: 'предложение',
    negotiation: 'переговоры', won: 'выиграна', lost: 'проиграна' }[value] || clean(value));

function ensureSchema() {
    if (initialized.has(DB.db)) return;
    DB.db.exec(`CREATE TABLE IF NOT EXISTS customer_business_gpt_context (
        turnId TEXT PRIMARY KEY REFERENCES customer_business_gpt_turns(id) ON DELETE CASCADE ON UPDATE CASCADE,
        payloadJson TEXT NOT NULL)`);
    initialized.add(DB.db);
}
function metadata(turnId) {
    ensureSchema();
    const row = DB.get('SELECT payloadJson FROM customer_business_gpt_context WHERE turnId=?', [turnId]);
    return row ? JSON.parse(row.payloadJson) : null;
}
function saveMetadata(turnId, value) {
    ensureSchema();
    DB.run('INSERT INTO customer_business_gpt_context VALUES(?,?)', [turnId, JSON.stringify(value)]);
}
function documentMetadata(businessId, citations, observedAt, customerChatId = null) {
    return { answerContext: { kind: 'documents', businessId, customerChatId, limitations: [] },
        sources: citations.map(item => ({ kind: 'document', title: item.title,
            sourceId: item.sourceId, observedAt })) };
}
function requestedCrm(question, customerChatId) {
    return Boolean(customerChatId) || /(?:crm|срм|мо[йияёе]\s+бизнес|наш(?:ем|его|и)?\s+бизнес|клиент|сделк|задач|очеред|продаж|договор[её]н|следующ(?:ий|ее|его)\s+(?:шаг|действ)|звон|обещан)/iu.test(question);
}
function customerScope(auth, businessId, chatId) {
    if (chatId === undefined) return null;
    Identity.authorizeCapability(auth, businessId, 'sales.read');
    const canonical = require('./client-identity.service').resolve(businessId, chatId.trim());
    if (!DB.get('SELECT 1 FROM clients WHERE instanceId=? AND chatId=?', [businessId, canonical])) {
        throw Object.assign(new Error('CUSTOMER_NOT_FOUND'), { code: 'CUSTOMER_NOT_FOUND', statusCode: 404 });
    }
    return canonical;
}
function crmAnswer(auth, businessId, question, customerChatId) {
    if (!requestedCrm(question, customerChatId)) return null;
    Identity.authorizeCapability(auth, businessId, 'sales.read');
    // Never convert missing storage into a business with zero customers.
    if (!table('instances') || !table('clients')) return null;
    const business = DB.get('SELECT name FROM instances WHERE id=? AND isActive=1', [businessId]);
    if (!business) return null;
    const observedAt = new Date().toISOString();
    const sources = [{ kind: 'business', title: `CRM: ${clean(business.name)}`, observedAt }];
    const limitations = ['Это сохранённые данные CRM на время ответа. Сделка и её сумма не подтверждают оплату, бронь или доставку сообщения.'];
    const answer = [`Бизнес: ${clean(business.name)}.`];
    let canonical = null;
    if (customerChatId) {
        const context = require('./customer-context.service').snapshot(businessId, customerChatId, { callLimit: 3 });
        canonical = context.client.chatId;
        answer.push(`Клиент: ${clean(context.client.senderName || context.client.name || 'Имя не указано')}.`);
        sources.push({ kind: 'customer', title: 'Карточка клиента', observedAt });
        if (context.callBrief?.request) answer.push(`Запрос: ${clean(context.callBrief.request)}.`);
        if (context.memory?.summary || context.callBrief?.lastSummary) {
            answer.push(`Последний сохранённый контекст: ${clean(context.memory?.summary || context.callBrief.lastSummary)}`);
            sources.push({ kind: context.memory?.kind === 'call' ? 'call' : 'memory', title: 'Сохранённый контекст клиента',
                observedAt: context.memory?.sourceUpdatedAt || context.calls[0]?.timestamp || observedAt,
                ...(context.sources[0]?.sourceId ? { sourceId: context.sources[0].sourceId } : {}) });
            limitations.push(context.memory?.provenance === 'ai_generated'
                ? 'Сводка разговора создана AI; перед действием проверьте исходный разговор.'
                : 'Сохранённая заметка описывает разговор; перед действием проверьте источник.');
        }
        if (context.callBrief?.nextAction) answer.push(`Следующий шаг из карточки: ${clean(context.callBrief.nextAction)}`);
        if (table('customer_deals')) {
            const deals = DB.all('SELECT title,stage,nextAction,amountMinor,currency FROM customer_deals WHERE instanceId=? AND clientChatId=? ORDER BY updatedAt DESC,id DESC LIMIT 6', [businessId, canonical]);
            if (deals.length) {
                answer.push('Последние сделки:\n' + deals.slice(0, 5).map(row => `• ${clean(row.title)}; этап ${stageName(row.stage)}; сумма сделки ${(row.amountMinor / 100).toFixed(2)} ${row.currency}${row.nextAction ? '; следующий шаг: ' + clean(row.nextAction) : ''}`).join('\n'));
                sources.push({ kind: 'deal', title: 'Сделки клиента', observedAt });
                if (deals.length > 5) limitations.push('Показаны пять последних сделок клиента.');
            } else answer.push('Связанных сделок в CRM нет.');
        } else limitations.push('Данные сделок недоступны.');
        if (table('manager_tasks')) {
            const tasks = DB.all("SELECT summary,status,dueAt FROM manager_tasks WHERE instanceId=? AND chatId=? AND status NOT IN ('done','cancelled','completed') ORDER BY createdAt DESC,taskId DESC LIMIT 6", [businessId, canonical]);
            if (tasks.length) {
                answer.push('Открытые задачи:\n' + tasks.slice(0, 5).map(row => `• ${clean(row.summary)}${row.dueAt ? '; срок: ' + clean(row.dueAt) : ''}`).join('\n'));
                sources.push({ kind: 'task', title: 'Задачи клиента', observedAt });
                if (tasks.length > 5) limitations.push('Показаны пять последних открытых задач.');
            } else answer.push('Открытых задач в CRM нет.');
        } else limitations.push('Данные задач недоступны.');
        if (!context.memory?.summary && !context.callBrief?.lastSummary) limitations.push('Готовая сводка разговора отсутствует; содержание клиента не додумывается.');
    } else {
        const clients = DB.get('SELECT COUNT(*) AS count FROM clients WHERE instanceId=?', [businessId]).count;
        answer.push(`Клиентов в CRM: ${clients}.`);
        if (table('customer_deals')) {
            const stages = DB.all('SELECT stage,COUNT(*) AS count FROM customer_deals WHERE instanceId=? GROUP BY stage ORDER BY stage', [businessId]);
            answer.push(`Сделок: ${stages.reduce((sum, row) => sum + row.count, 0)}${stages.length ? '; по этапам: ' + stages.map(row => `${stageName(row.stage)} — ${row.count}`).join(', ') : ''}.`);
            sources.push({ kind: 'deal', title: 'Сделки бизнеса', observedAt });
        } else limitations.push('Данные сделок недоступны.');
        if (table('manager_tasks')) {
            const count = DB.get("SELECT COUNT(*) AS count FROM manager_tasks WHERE instanceId=? AND status NOT IN ('done','cancelled','completed')", [businessId]).count;
            answer.push(`Открытых задач: ${count}.`);
            sources.push({ kind: 'task', title: 'Задачи бизнеса', observedAt });
        } else limitations.push('Данные задач недоступны.');
        limitations.push('Для контекста конкретного клиента выберите его карточку.');
    }
    return { answer: answer.join('\n\n'), citations: [], source_timestamp: observedAt,
        metadata: { answerContext: { kind: 'crm', businessId, customerChatId: canonical, limitations }, sources } };
}
module.exports = { ensureSchema, metadata, saveMetadata, documentMetadata, crmAnswer, customerScope };
