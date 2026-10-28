'use strict';

const crypto = require('crypto');
const DB = require('../database.service');

const MAX_ROWS = 200;
const SOURCES = Object.freeze({
    clients: { time: 'createdAt', id: 'id', kind: 'new_lead' },
    messages: { time: 'timestamp', id: 'id', kind: 'message' },
    lead_status_history: { time: 'createdAt', id: 'id', kind: 'lead_status_change' },
    conversation_events: { time: 'createdAt', id: 'eventId', kind: 'conversation_event' },
    customer_deals: { time: 'updatedAt', id: 'id', kind: 'deal_updated', partial: 'Only the current deal revision and latest update are stored; previous fields and intermediate updates are unavailable.' },
    manager_tasks: { time: 'COALESCE(updatedAt,createdAt)', id: 'taskId', kind: 'task_updated', partial: 'Only the current task state is stored; intermediate updates are unavailable.' },
    outbound_attempts: { time: 'startedAt', id: 'attemptId', kind: 'outbound_call', partial: 'Outbound attempts only; inbound call history is not represented by this table.' },
    tool_runs: { time: 'createdAt', id: 'toolRunId', kind: 'ava_tool_run', partial: 'Recorded tool calls are not a complete AVA action ledger.' },
});

function fail(code, statusCode) {
    throw Object.assign(new Error(code), { code, statusCode });
}

function timestamp(value) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    const normalized = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(raw)
        ? `${raw.replace(' ', 'T')}Z` : raw;
    const epoch = Date.parse(normalized);
    return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function zoneOf(value) {
    if (typeof value !== 'string' || !value.trim()) return { timezone: 'UTC', fallback: true };
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return { timezone: value, fallback: false }; }
    catch (_) { return { timezone: 'UTC', fallback: true }; }
}

function localDate(epoch, timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(epoch);
    const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${p.year}-${p.month}-${p.day}`;
}

function localClock(epoch, timezone) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(epoch);
    const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${p.hour}:${p.minute}:${p.second}`;
}

function addDay(day, offset) {
    return new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
}

// Earliest UTC instant matching a local wall-clock boundary; handles DST gaps/folds.
function wallInstant(day, clock, timezone) {
    const wanted = `${day}T${clock}`;
    const local = epoch => `${localDate(epoch, timezone)}T${localClock(epoch, timezone)}`;
    let low = Date.parse(`${day}T00:00:00Z`) - 48 * 3600000;
    let high = low + 96 * 3600000;
    while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (local(middle) < wanted) low = middle;
        else high = middle;
    }
    return high;
}

function windowFor(kind, now, timezone, completeOnly = false) {
    const today = localDate(now, timezone);
    if (kind === 'yesterday') {
        const yesterday = addDay(today, -1);
        return { kind, timezone, localDate: yesterday,
            start: new Date(wallInstant(yesterday, '00:00:00', timezone)).toISOString(),
            endExclusive: new Date(wallInstant(today, '00:00:00', timezone)).toISOString(),
            complete: true };
    }
    const clock = localClock(now, timezone);
    const startDay = completeOnly ? addDay(today, clock < '09:00:00' ? -2 : -1)
        : clock >= '20:00:00' ? today : addDay(today, -1);
    const endDay = addDay(startDay, 1);
    const end = wallInstant(endDay, '09:00:00', timezone);
    return { kind, timezone, localDate: endDay,
        start: new Date(wallInstant(startDay, '20:00:00', timezone)).toISOString(),
        endExclusive: new Date(Math.min(now.getTime(), end)).toISOString(),
        complete: now.getTime() >= end };
}

function sourceAvailable(table) {
    return Boolean(DB.get("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?", [table]));
}

function clean(value, max = 140) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const CUSTOMER_LABELS = {
    task: { open: 'открыта', pending: 'ожидает обработки', in_progress: 'в работе', done: 'выполнена', completed: 'выполнена', closed: 'закрыта', canceled: 'отменена', cancelled: 'отменена', failed: 'не выполнена' },
    priority: { low: 'низкий', normal: 'обычный', medium: 'средний', high: 'высокий', urgent: 'срочный' },
    client: { new: 'новый', contacted: 'связались', qualified: 'квалифицирован', interested: 'заинтересован', negotiating: 'переговоры', negotiation: 'переговоры', proposal: 'предложение', won: 'успешно завершён', lost: 'потерян', hot: 'высокий интерес', warm: 'есть интерес', cold: 'низкий интерес', converted: 'конвертирован', booked: 'забронировано' },
    deal: { new: 'новая', qualified: 'квалифицирована', proposal: 'предложение', negotiation: 'переговоры', won: 'успешно завершена', lost: 'проиграна' },
};
function customerLabel(kind, value) {
    const text = clean(value, 60);
    return CUSTOMER_LABELS[kind]?.[text.toLowerCase()] || (/^[\p{Script=Cyrillic}\d\s.,()—-]+$/u.test(text) ? text : text ? 'не расшифрован' : 'не указан');
}

function makeFact(table, row) {
    const config = SOURCES[table];
    if (table === 'conversation_events' && ['internal', 'draft'].includes(row.direction)) return null;
    const occurredAt = timestamp(row.factAt || row[config.time]);
    if (!occurredAt) return null;
    const dealCreated = table === 'customer_deals' && row.revision === 1
        && timestamp(row.createdAt) === occurredAt;
    const sourceId = String(row[config.id]);
    const related = {};
    if (row.chatId != null) related.chatId = String(row.chatId);
    if (row.callId != null) related.callId = String(row.callId);
    if (table === 'messages' && row.sourceMessageId != null) related.sourceMessageId = String(row.sourceMessageId);
    if (table === 'conversation_events' && row.sourceId != null) related.sourceId = String(row.sourceId);
    if (table === 'customer_deals') {
        related.dealId = sourceId;
        if (row.clientChatId) related.chatId = String(row.clientChatId);
    }
    const subject = table === 'clients' && clean(row.senderName, 100)
        ? { type: 'client', name: clean(row.senderName, 100), chatId: String(row.chatId) }
        : table === 'manager_tasks' && clean(row.customerName, 100)
            ? { type: 'client', name: clean(row.customerName, 100), chatId: row.chatId ? String(row.chatId) : null }
            : null;
    let summary;
    switch (table) {
    case 'clients': summary = `Создана запись клиента; текущий статус: ${customerLabel('client', row.leadStatus)}.`; break;
    case 'messages': summary = `Сообщение ${row.role === 'user' ? 'клиента' : row.role === 'assistant' ? 'AVA' : 'в диалоге'}${clean(row.content, 320) ? `: «${clean(row.content, 320)}»` : '.'}`; break;
    case 'lead_status_history': summary = `Статус лида: ${customerLabel('client', row.fromStatus)} → ${customerLabel('client', row.toStatus)}.`; break;
    case 'conversation_events':
        summary = row.direction === 'inbound' ? 'Получено обращение клиента.' : row.direction === 'outbound' ? 'Зафиксировано исходящее обращение.' : 'Зафиксировано событие диалога.';
        if (clean(row.content, 320)) summary += ` Текст обращения: «${clean(row.content, 320)}»`;
        break;
    case 'customer_deals': summary = `${dealCreated ? 'Создана' : 'Обновлена'} сделка «${clean(row.title, 100)}»; текущий этап: ${customerLabel('deal', row.stage)}${Number.isSafeInteger(row.amountMinor) ? `; сумма сделки: ${row.amountMinor / 100} ${clean(row.currency, 10)} (не подтверждает оплату)` : ''}${clean(row.nextAction, 180) ? `; следующий шаг: ${clean(row.nextAction, 180)}` : ''}${timestamp(row.nextActionAt) ? `; срок: ${timestamp(row.nextActionAt)}` : ''}.`; break;
    case 'manager_tasks': summary = `Задача «${clean(row.summary, 100)}»; текущий статус: ${customerLabel('task', row.status)}, приоритет: ${customerLabel('priority', row.priority)}.`; break;
    case 'outbound_attempts': summary = `Исходящий вызов: ${clean(row.status, 35)}${row.outcome ? `, результат ${clean(row.outcome, 50)}` : ''}.`; break;
    case 'tool_runs': summary = 'Зафиксировано действие AVA; запись действия не подтверждает доставку или выполнение обещания клиенту.'; break;
    }
    return { id: `${table}:${sourceId}`, type: dealCreated ? 'deal_created' : config.kind,
        occurredAt, summary,
        source: { type: table, id: sourceId, occurredAt }, related,
        ...(subject ? { subject } : {}) };
}

function readSource(table, window) {
    const config = SOURCES[table];
    if (!sourceAvailable(table)) return { status: 'unavailable', count: null,
        returnedCount: 0, latestAt: null, reason: 'source_table_missing', facts: [] };
    const where = `instanceId=? AND julianday(${config.time})>=julianday(?) AND julianday(${config.time})<julianday(?)`;
    const params = [window.businessId, window.start, window.endExclusive];
    try {
        const aggregate = DB.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params);
        const rows = DB.all(`SELECT *, ${config.time} AS factAt FROM ${table} WHERE ${where}
            ORDER BY julianday(${config.time}) DESC, ${config.id} DESC LIMIT ?`, [...params, MAX_ROWS]);
        const facts = rows.map(row => makeFact(table, row)).filter(Boolean);
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
        const latestAt = rows.length ? timestamp(rows[0].factAt) : null;
        const limited = aggregate.n > rows.length;
        return { status: config.partial || limited ? 'partial' : 'available', count: aggregate.n,
            returnedCount: facts.length, latestAt, fingerprint,
            ...(limited || config.partial ? { reason: limited ? 'sample_limit_200' : config.partial } : {}), facts };
    } catch (error) {
        if (/no such (table|column)/i.test(error.message)) return { status: 'unavailable', count: null,
            returnedCount: 0, latestAt: null, reason: 'source_schema_unavailable', facts: [] };
        throw error;
    }
}

// Current records supplement the reporting window and retain original dates.
function readContext(businessId, asOf) {
    const facts = [], sources = {};
    const labels = { clients: 'записей клиентов', messages: 'сообщений', lead_status_history: 'изменений статуса клиентов', conversation_events: 'событий диалога', customer_deals: 'сделок', manager_tasks: 'задач', outbound_attempts: 'попыток исходящих звонков' };
    for (const table of Object.keys(labels)) {
        const config = SOURCES[table];
        if (!sourceAvailable(table)) { sources[table] = { status: 'unavailable', count: null }; continue; }
        const customerOnly = table === 'conversation_events' ? " AND COALESCE(direction,'') NOT IN ('internal','draft')" : '';
        const where = `instanceId=? AND (${config.time} IS NULL OR julianday(${config.time})<=julianday(?))${customerOnly}`;
        const params = [businessId, asOf.toISOString()];
        try {
            const count = DB.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params).n;
            const latest = DB.get(`SELECT ${config.time} AS latestAt FROM ${table} WHERE ${where}
                ORDER BY julianday(${config.time}) DESC LIMIT 1`, params);
            const latestAt = timestamp(latest?.latestAt);
            const attentionOrder = table === 'manager_tasks' ? "CASE WHEN status IN ('done','closed','completed','canceled') THEN 1 ELSE 0 END, "
                : table === 'customer_deals' ? "CASE WHEN stage IN ('won','lost') THEN 1 ELSE 0 END, " : '';
            const rows = DB.all(`SELECT *, ${config.time} AS factAt FROM ${table} WHERE ${where}
                ORDER BY ${attentionOrder}julianday(${config.time}) DESC, ${config.id} DESC LIMIT ?`, [...params, 40]);
            sources[table] = { status: count > rows.length ? 'partial' : 'available', count,
                returnedCount: rows.length, latestAt, fingerprint: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
            if (count) facts.push({ id: `current:${table}`, type: 'current_record_count',
                summary: `Состояние CRM за всё время до отчёта: ${count} ${labels[table]}. Это не события выбранного периода.`,
                source: { type: 'dashboard_aggregate', id: `current_${table}`, occurredAt: asOf.toISOString() } });
            for (const row of rows) {
                const fact = makeFact(table, row);
                if (fact) facts.push({ ...fact, summary: `Контекст CRM (не обязательно событие периода): ${fact.summary}` });
            }
        } catch (error) {
            if (!/no such (table|column)/i.test(error.message)) throw error;
            sources[table] = { status: 'unavailable', count: null };
        }
    }
    const coverage = Object.values(sources);
    const hasBusinessData = coverage.some(source => source.count > 0);
    const dates = coverage.map(source => source.latestAt).filter(Boolean);
    const sourceUpdatedAt = dates.length ? dates.sort().at(-1) : null;
    return { contextFacts: facts, contextSources: sources, hasBusinessData, sourceUpdatedAt,
        businessDataEmpty: !hasBusinessData && coverage.every(source => source.status !== 'unavailable'),
        status: coverage.every(source => source.status === 'unavailable') ? 'unavailable' : coverage.some(source => source.status !== 'available') ? 'partial' : 'available',
        limitations: coverage.some(source => source.status === 'partial') ? ['business_context_sample_limit_40_per_source'] : [] };
}

function getBusinessContext(businessId, { now = new Date() } = {}) {
    const id = Number(businessId), asOf = new Date(now);
    if (!Number.isSafeInteger(id) || id < 1 || String(id) !== String(businessId)) fail('INVALID_BUSINESS_SCOPE', 400);
    if (!Number.isFinite(asOf.getTime())) fail('INVALID_TIME', 400);
    if (!DB.db) fail('DASHBOARD_FACTS_UNAVAILABLE', 503);
    return DB.db.transaction(() => {
        if (!DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [id])) fail('BUSINESS_NOT_FOUND', 404);
        return readContext(id, asOf);
    })();
}

function getFactPacket(businessId, { window: kind, now = new Date(), completeOnly = false } = {}) {
    const id = Number(businessId);
    if (!Number.isSafeInteger(id) || id < 1 || String(id) !== String(businessId)) fail('INVALID_BUSINESS_SCOPE', 400);
    if (!['yesterday', 'overnight'].includes(kind)) fail('INVALID_WINDOW', 400);
    const asOf = new Date(now);
    if (!Number.isFinite(asOf.getTime())) fail('INVALID_TIME', 400);
    if (!DB.db) fail('DASHBOARD_FACTS_UNAVAILABLE', 503);
    const read = DB.db.transaction(() => {
        const business = DB.get('SELECT id,hotelTimezone FROM instances WHERE id=? AND isActive=1', [id]);
        if (!business) fail('BUSINESS_NOT_FOUND', 404);
        const zone = zoneOf(business.hotelTimezone);
        const window = windowFor(kind, asOf, zone.timezone, completeOnly);
        const sources = {};
        const allFacts = [];
        for (const table of Object.keys(SOURCES)) {
            const result = readSource(table, { ...window, businessId: id });
            const { facts, ...coverage } = result;
            sources[table] = coverage;
            allFacts.push(...facts);
        }
        return { window, zone, sources, allFacts, context: readContext(id, asOf) };
    });
    const { window, zone, sources, allFacts, context } = read();
    const messageIds = new Set(allFacts.filter(f => f.source.type === 'messages')
        .flatMap(f => [f.source.id, f.related.sourceMessageId].filter(Boolean)));
    const callIds = new Set(allFacts.filter(f => f.source.type === 'outbound_attempts' && f.related.callId)
        .map(f => f.related.callId));
    const deduped = allFacts.filter(f => {
        if (f.source.type !== 'conversation_events') return true;
        if (f.related.sourceId && messageIds.has(f.related.sourceId)) return false;
        if (f.related.callId && callIds.has(f.related.callId)) return false;
        return true;
    });
    deduped.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
    const factsTruncated = deduped.length > MAX_ROWS;
    const limitations = [];
    if (zone.fallback) limitations.push('business_timezone_unavailable_using_utc');
    if (!window.complete) limitations.push('overnight_window_in_progress');
    limitations.push('dedicated_inbound_call_history_unavailable');
    if (factsTruncated) limitations.push('fact_list_limit_200');
    const statuses = Object.values(sources).map(source => source.status);
    const status = statuses.every(value => value === 'unavailable') ? 'unavailable'
        : statuses.includes('unavailable') || statuses.includes('partial') || limitations.length ? 'partial' : 'available';
    const dates = [...Object.values(sources).map(source => source.latestAt), context.sourceUpdatedAt].filter(Boolean);
    const sourceUpdatedAt = dates.length ? dates.sort().at(-1) : null;
    // Ongoing nights advance endExclusive on each read. Only durable source
    // changes should invalidate an AI summary within the same local night.
    const revisionWindow = { kind: window.kind, timezone: window.timezone,
        localDate: window.localDate, start: window.start };
    const sourceRevision = crypto.createHash('sha256').update(JSON.stringify({
        businessId: id, window: revisionWindow, sources, facts: deduped, contextSources: context.contextSources,
    })).digest('hex');
    return { businessId: id, window, asOf: asOf.toISOString(), snapshotAt: new Date().toISOString(), sourceRevision,
        status, isEmpty: deduped.length === 0, sourceUpdatedAt, sources,
        hasBusinessData: context.hasBusinessData, businessDataEmpty: context.businessDataEmpty,
        contextFacts: context.contextFacts, contextSources: context.contextSources,
        sampledFactCount: deduped.length, factsTruncated, facts: deduped.slice(0, MAX_ROWS), limitations };
}

module.exports = { getFactPacket, getBusinessContext, windowFor, wallInstant, customerLabel };
