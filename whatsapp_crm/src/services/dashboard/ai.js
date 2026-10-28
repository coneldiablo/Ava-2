'use strict';

const DB = require('../database.service');
const Deals = require('../customer-deals.store');
const Model = require('./ai.model');
const Intelligence = require('./intelligence.service');
const { customerLabel } = require('./facts');

const MAX_PERIOD_MS = 31 * 24 * 60 * 60 * 1000;
const CACHE_MS = 20_000;
const caches = new WeakMap();

function inputError(code) {
    return Object.assign(new Error(code), { code, statusCode: 400 });
}

function parseDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
        throw inputError('INVALID_PERIOD');
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw inputError('INVALID_PERIOD');
    return date;
}

function period(input = {}, now = new Date()) {
    const to = input.to == null ? now : parseDate(input.to);
    const from = input.from == null ? new Date(to.getTime() - 24 * 60 * 60 * 1000) : parseDate(input.from);
    if (to > now || from >= to || to - from > MAX_PERIOD_MS) throw inputError('INVALID_PERIOD');
    return { from: from.toISOString(), to: to.toISOString() };
}

// The last completed (or ongoing) business night is 20:00–09:00 in its timezone.
function nightPeriod(businessId, now = new Date()) {
    const business = DB.get('SELECT hotelTimezone FROM instances WHERE id=? AND isActive=1', [businessId]);
    if (!business) throw inputError('INVALID_BUSINESS_SCOPE');
    let zone = business.hotelTimezone || 'UTC';
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch (_) { zone = 'UTC'; }
    const window = require('./facts').windowFor('overnight', now, zone);
    return { from: window.start, to: window.endExclusive };
}

function short(value, max = 180) {
    return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clientCountLabel(count) {
    if (count % 100 >= 11 && count % 100 <= 14) return 'клиентов';
    return count % 10 === 1 ? 'клиент' : count % 10 >= 2 && count % 10 <= 4 ? 'клиента' : 'клиентов';
}

function source(type, id, createdAt) {
    return { type, id: String(id), createdAt: validTimestamp(createdAt) };
}

function validTimestamp(value) {
    if (!value) return null;
    const raw = String(value);
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
        ? `${raw.replace(' ', 'T')}Z` : raw;
    const date = new Date(normalized);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function snapshot(businessId, range, { fresh = false } = {}) {
    const id = Number(businessId);
    if (!Number.isSafeInteger(id) || id < 1) throw inputError('INVALID_BUSINESS_SCOPE');
    if (!DB.db) throw Object.assign(new Error('DASHBOARD_AI_UNAVAILABLE'), { statusCode: 503 });
    let cache = caches.get(DB.db);
    if (!cache) { cache = new Map(); caches.set(DB.db, cache); }
    const key = `${id}:${range.from}:${range.to}`;
    const cached = cache.get(key);
    if (!fresh && cached && Date.now() - cached.time < CACHE_MS) return cached.value;
    Deals.ensureSchema();
    const params = [id, range.from, range.to];
    const eventCount = DB.get(`SELECT COUNT(*) AS n FROM conversation_events
        WHERE instanceId=? AND direction NOT IN ('internal','draft') AND datetime(createdAt)>=datetime(?) AND datetime(createdAt)<datetime(?)`, params).n;
    const statusCount = DB.get(`SELECT COUNT(*) AS n FROM lead_status_history
        WHERE instanceId=? AND datetime(createdAt)>=datetime(?) AND datetime(createdAt)<datetime(?)`, params).n;
    const messageCount = DB.get(`SELECT COUNT(*) AS n FROM messages
        WHERE instanceId=? AND datetime(timestamp)>=datetime(?) AND datetime(timestamp)<datetime(?)`, params).n;
    const newClientCount = DB.get(`SELECT COUNT(*) AS n FROM clients
        WHERE instanceId=? AND datetime(createdAt)>=datetime(?) AND datetime(createdAt)<datetime(?)`, params).n;
    const events = DB.all(`SELECT eventId, channel, direction, role, content, createdAt
        FROM conversation_events WHERE instanceId=? AND direction NOT IN ('internal','draft') AND datetime(createdAt)>=datetime(?) AND datetime(createdAt)<datetime(?)
        ORDER BY datetime(createdAt) DESC, eventId DESC LIMIT 80`, params);
    const statuses = DB.all(`SELECT id, chatId, fromStatus, toStatus, createdAt
        FROM lead_status_history WHERE instanceId=? AND datetime(createdAt)>=datetime(?) AND datetime(createdAt)<datetime(?)
        ORDER BY datetime(createdAt) DESC, id DESC LIMIT 80`, params);
    const messages = DB.all(`SELECT id, role, channel, content, timestamp FROM messages
        WHERE instanceId=? AND datetime(timestamp)>=datetime(?) AND datetime(timestamp)<datetime(?)
        ORDER BY datetime(timestamp) DESC, id DESC LIMIT 80`, params);
    const newClients = DB.all(`SELECT id, chatId, senderName, leadStatus, createdAt FROM clients
        WHERE instanceId=? AND datetime(createdAt)>=datetime(?) AND datetime(createdAt)<datetime(?)
        ORDER BY datetime(createdAt) DESC, id DESC LIMIT 80`, params);
    const openTaskCount = DB.get(`SELECT COUNT(*) AS n FROM manager_tasks
        WHERE instanceId=? AND status NOT IN ('completed','cancelled','closed','done')`, [id]).n;
    const openDealCount = DB.get(`SELECT COUNT(*) AS n FROM customer_deals
        WHERE instanceId=? AND stage NOT IN ('won','lost')`, [id]).n;
    const tasks = DB.all(`SELECT taskId, status, priority, reason, summary, createdAt, updatedAt
        FROM manager_tasks WHERE instanceId=? AND status NOT IN ('completed','cancelled','closed','done')
        ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, datetime(createdAt) DESC LIMIT 30`, [id]);
    const deals = DB.all(`SELECT id, title, stage, nextAction, nextActionAt, amountMinor, currency, updatedAt
        FROM customer_deals WHERE instanceId=? AND stage NOT IN ('won','lost')
        ORDER BY CASE WHEN nextActionAt IS NOT NULL AND nextActionAt<=date(?) THEN 0 ELSE 1 END,
                 datetime(updatedAt) DESC LIMIT 30`, [id, range.to]);
    const changedDealCount = DB.get(`SELECT COUNT(*) AS n FROM customer_deals WHERE instanceId=?
        AND revision>1 AND julianday(updatedAt)>=julianday(?) AND julianday(updatedAt)<julianday(?)`, params).n;
    const changedDeals = DB.all(`SELECT id,title,stage,updatedAt FROM customer_deals WHERE instanceId=?
        AND revision>1 AND julianday(updatedAt)>=julianday(?) AND julianday(updatedAt)<julianday(?)
        ORDER BY julianday(updatedAt) DESC,id DESC LIMIT 30`, params);
    const toolCount = DB.get(`SELECT COUNT(*) AS n FROM tool_runs WHERE instanceId=? AND status='ok'
        AND julianday(createdAt)>=julianday(?) AND julianday(createdAt)<julianday(?)`, params).n;
    const tools = DB.all(`SELECT toolRunId,toolName,createdAt FROM tool_runs WHERE instanceId=? AND status='ok'
        AND julianday(createdAt)>=julianday(?) AND julianday(createdAt)<julianday(?)
        ORDER BY julianday(createdAt) DESC,toolRunId DESC LIMIT 30`, params);
    const recommendations = [];
    for (const task of tasks) {
        if (!['urgent', 'high'].includes(task.priority)) continue;
        const at = validTimestamp(task.updatedAt || task.createdAt);
        if (!at) continue;
        recommendations.push({
            id: `task:${task.taskId}`, title: 'Проверьте задачу менеджера',
            reason: short(task.summary, 240), action: 'Откройте задачу и определите следующий шаг.',
            priority: task.priority, sources: [source('manager_task', task.taskId, at)],
        });
        if (recommendations.length >= 5) break;
    }
    for (const deal of deals) {
        if (!deal.nextActionAt || deal.nextActionAt > range.to.slice(0, 10)) continue;
        const at = validTimestamp(deal.updatedAt);
        if (!at) continue;
        recommendations.push({
            id: `deal:${deal.id}`, title: `Проверьте сделку: ${short(deal.title, 100)}`,
            reason: `Следующее действие назначено на ${deal.nextActionAt}. Текущий этап: ${deal.stage}.`,
            action: deal.nextAction ? short(deal.nextAction, 240) : 'Уточните статус и назначьте следующий шаг.',
            priority: deal.nextActionAt < range.to.slice(0, 10) ? 'high' : 'normal',
            sources: [source('customer_deal', deal.id, at)],
        });
        if (recommendations.length >= 8) break;
    }
    const allDates = [
        ...events.map(row => row.createdAt), ...statuses.map(row => row.createdAt),
        ...messages.map(row => row.timestamp), ...newClients.map(row => row.createdAt),
        ...tasks.map(row => row.updatedAt || row.createdAt), ...deals.map(row => row.updatedAt),
        ...changedDeals.map(row => row.updatedAt), ...tools.map(row => row.createdAt),
    ].map(validTimestamp).filter(Boolean);
    const sourceUpdatedAt = allDates.length ? allDates.sort().at(-1) : null;
    const total = eventCount + statusCount + messageCount + newClientCount;
    const summary = total || changedDealCount || toolCount
        ? `За выбранный период в CRM: новые записи клиентов — ${newClientCount}; обновлённые сделки — ${changedDealCount}; изменения статуса лидов — ${statusCount}; события диалогов — ${eventCount}; сообщения — ${messageCount}; успешные вызовы инструментов AVA — ${toolCount}. Записи разных источников могут относиться к одному взаимодействию. История изменений сделок и действий AVA доступна частично.`
        : 'За выбранный период в доступных источниках CRM нет новых сообщений, событий диалогов, изменений статуса или клиентов. Открытые задачи и сделки показаны отдельно, если они есть.';
    const value = {
        businessId: id, period: range, generatedAt: new Date().toISOString(), sourceUpdatedAt,
        eventCount: total, sourceComplete: eventCount <= events.length && statusCount <= statuses.length
            && messageCount <= messages.length && newClientCount <= newClients.length
            && openTaskCount <= tasks.length && openDealCount <= deals.length
            && changedDealCount <= changedDeals.length && toolCount <= tools.length,
        summary, recommendations,
        activity: {
            newLeads: { status: 'available', count: newClientCount, items: newClients.map(row => ({
                title: short(row.senderName, 100) || `Клиент ${row.id}`, leadStatus: short(row.leadStatus, 40),
                source: source('client', row.id, row.createdAt),
                target: row.chatId ? { type: 'client', id: row.chatId,
                    path: `/client/${encodeURIComponent(row.chatId)}` } : null })) },
            changedDeals: { status: 'partial', count: changedDealCount,
                reason: 'Доступно последнее обновление сделки; прежние значения полей и этапов не сохраняются.',
                items: changedDeals.map(row => ({ title: short(row.title, 100), stage: row.stage,
                    source: source('customer_deal', row.id, row.updatedAt),
                    target: { type: 'deal', id: row.id, path: `/deals?dealId=${encodeURIComponent(row.id)}` } })) },
            importantEvents: { status: 'available', count: statusCount,
                items: statuses.map(row => ({ title: `Статус лида: ${customerLabel('client', row.fromStatus)} → ${customerLabel('client', row.toStatus)}`,
                    source: source('lead_status_change', row.id, row.createdAt) })) },
            priorities: { status: 'available', count: recommendations.length,
                items: recommendations.map(row => ({ title: row.title, action: row.action, sources: row.sources })) },
            risks: { status: 'partial',
                reason: 'Показаны срочные задачи и просроченные действия; показатель риска оттока не рассчитывается.',
                count: recommendations.filter(row => ['high', 'urgent'].includes(row.priority)).length,
                items: recommendations.filter(row => ['high', 'urgent'].includes(row.priority)) },
            avaActions: { status: 'partial', count: toolCount,
                reason: 'Учтены только успешные вызовы инструментов; это не полный журнал действий AVA.',
                items: tools.map(row => ({ title: short(row.toolName, 100),
                    source: source('tool_run', row.toolRunId, row.createdAt) })) },
        },
        facts: { conversationEventCount: eventCount, leadStatusChangeCount: statusCount,
            messageCount, newClientCount, changedDealCount, toolCount,
            openTaskSampleCount: tasks.length, openDealSampleCount: deals.length },
        evidence: [
            ...events.map(row => ({ source: source('conversation_event', row.eventId, row.createdAt),
                fact: `${row.direction === 'inbound' ? 'Получено обращение клиента' : row.direction === 'outbound' ? 'Отправлено сообщение клиенту' : 'Записано взаимодействие'}${['inbound', 'outbound'].includes(row.direction) && row.content ? ': ' + short(row.content, 220) : '.'}` })),
            ...statuses.map(row => ({ source: source('lead_status_change', row.id, row.createdAt),
                fact: `Статус лида: ${customerLabel('client', row.fromStatus)} → ${customerLabel('client', row.toStatus)}` })),
            ...messages.map(row => ({ source: source('message', row.id, row.timestamp),
                fact: `${row.role === 'user' ? 'Сообщение клиента' : row.role === 'assistant' ? 'Ответ AVA' : 'Записано сообщение'}: ${short(row.content, 220) || 'текст не сохранён'}` })),
            ...newClients.map(row => ({ source: source('client', row.id, row.createdAt),
                fact: `Новый клиент, статус ${short(row.leadStatus, 40)}` })),
            ...tasks.map(row => ({ source: source('manager_task', row.taskId, row.updatedAt || row.createdAt),
                fact: `Задача ${row.status}, приоритет ${row.priority}: ${short(row.summary, 140)}` })),
            ...deals.map(row => ({ source: source('customer_deal', row.id, row.updatedAt),
                fact: `Сделка ${short(row.title, 90)}, этап ${row.stage}, следующее действие ${row.nextActionAt || 'не указано'}` })),
            ...changedDeals.map(row => ({ source: source('customer_deal', row.id, row.updatedAt),
                fact: `Обновлена сделка ${short(row.title, 90)}, текущий этап ${row.stage}` })),

        ].filter(row => row.source.createdAt),
    };
    cache.set(key, { time: Date.now(), value });
    if (cache.size > 200) for (const [oldKey, entry] of cache) {
        if (Date.now() - entry.time >= CACHE_MS || cache.size > 200) cache.delete(oldKey);
        if (cache.size <= 200) break;
    }
    return value;
}

function briefing(businessId, range, capabilities) {
    const { evidence, facts, ...data } = snapshot(businessId, range);
    return { ...data, capabilities };
}

function activity(businessId, now = new Date()) {
    const business = DB.get('SELECT hotelTimezone FROM instances WHERE id=? AND isActive=1', [businessId]);
    if (!business) throw inputError('INVALID_BUSINESS_SCOPE');
    let timezone = business.hotelTimezone || 'UTC';
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch (_) { timezone = 'UTC'; }
    const range = nightPeriod(businessId, now);
    const data = snapshot(businessId, range);
    const items = [];
    const add = (category, kind, title, description, src, target = null) => {
        if (!src?.createdAt) return;
        const key = require('crypto').createHash('sha256').update(`${businessId}:${kind}:${src.id}`).digest('hex').slice(0, 20);
        items.push({ id: key, category, kind, title: customerText(title), description: customerText(description),
            occurredAt: src.createdAt, target });
    };
    for (const lead of data.activity.newLeads.items) add('client', 'new_lead', lead.title,
        `Новая запись клиента; текущий статус: ${customerLabel('client', lead.leadStatus)}.`, lead.source, lead.target);
    for (const deal of data.activity.changedDeals.items) add('team', 'deal_updated', deal.title,
        `Сделка обновлена; текущий этап: ${customerLabel('deal', deal.stage)}.`, deal.source, deal.target);
    for (const event of data.activity.importantEvents.items) add('team', 'lead_status_changed',
        event.title, event.title, event.source);
    const recentTasks = DB.all(`SELECT taskId,chatId,summary,priority,status,createdAt,updatedAt
        FROM manager_tasks WHERE instanceId=? AND
        ((julianday(createdAt)>=julianday(?) AND julianday(createdAt)<julianday(?)) OR
         (julianday(updatedAt)>=julianday(?) AND julianday(updatedAt)<julianday(?)))
        ORDER BY julianday(updatedAt) DESC,taskId DESC LIMIT 30`,
    [businessId, range.from, range.to, range.from, range.to]);
    for (const task of recentTasks) {
        const updated = validTimestamp(task.updatedAt);
        const at = updated >= range.from && updated < range.to ? task.updatedAt : task.createdAt;
        add('team', 'manager_task', short(task.summary, 120),
            `Задача: ${customerLabel('task', task.status)}; приоритет: ${customerLabel('priority', task.priority)}.`,
            source('manager_task', task.taskId, at), task.chatId
                ? { type: 'client', id: task.chatId, path: `/client/${encodeURIComponent(task.chatId)}` } : null);
    }
    for (const event of data.evidence.filter(row => row.source.type === 'conversation_event'
        && /Получено обращение клиента|Отправлено сообщение клиенту/.test(row.fact))) {
        add('client', 'conversation_event', 'Событие диалога', event.fact, event.source);
    }
    items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
    return { instanceId: Number(businessId), period: { ...range, timezone }, status: 'available',
        sourceComplete: false, coverage: {
            sampledRowsComplete: data.sourceComplete,
            deals: 'partial', aiActions: 'partial',
            description: 'История полей сделок и полный журнал действий AVA недоступны; некоторые списки ограничены выборкой.',
        }, items: items.slice(0, 100) };
}

function isKnowledgeQuestion(question) {
    const value = short(question, 1200);
    // Operational and financial CRM questions must keep their tenant-scoped
    // record path even when they mention an offered service or room.
    if (/(лид|сделк|выруч|доход|прибыл|воронк|конверс|звонк|сообщен|диалог|статистик|аналитик|показател|задач|продаж|оборот|follow.?up)/i.test(value)
        || /(?:сколько|число|количеств|список|нов[ыые]|потерянн).{0,40}(?:клиент|заявк|обращен)/i.test(value)
        || /(?:клиент|покупател).{0,40}(?:риску|уйт|актив|потер|статус|сегмент)/i.test(value)) return false;
    return /(документ|баз[еуы] знани|заселени|заезд|выезд|парковк|питани|лояльност|правил|услуг|стоимост|цен[аыу]|тариф|прайс|номер|прожив|бассейн|ресторан|завтрак|спа|саун|трансфер|интернет|wi.?fi|брон|отмен|оплат|часы работы|режим работы|во сколько|до скольки)/i.test(value);
}

function noEvidence(range, status = 'empty', revision = null) {
    return { answer: 'В доступных подтверждённых данных нет основания для ответа на этот вопрос.',
        sources: [], grounded: false, period: range, dataStatus: status,
        answerStatus: status === 'empty' ? 'empty' : 'unavailable',
        generatedAt: new Date().toISOString(), sourceUpdatedAt: null,
        sourceRevision: revision, provenance: 'crm_records' };
}

function validFactPacket(packet, businessId, range, now, kind) {
    return packet && packet.businessId === Number(businessId)
        && packet.window?.kind === kind
        && packet.window.start === range.from && packet.window.endExclusive === range.to
        && typeof packet.snapshotAt === 'string' && Number.isFinite(Date.parse(packet.snapshotAt))
        && Math.abs(Date.parse(packet.snapshotAt) - Date.now()) < 120_000
        && typeof packet.sourceRevision === 'string' && packet.sourceRevision.length >= 8
        && ['available', 'partial', 'unavailable'].includes(packet.status)
        && Array.isArray(packet.facts);
}

function aggregateFacts(packet) {
    const labels = {
        clients: 'созданных записей клиентов', messages: 'сообщений',
        lead_status_history: 'записанных изменений статуса лида',
        customer_deals: 'сделок с текущей датой обновления в этом окне',
        manager_tasks: 'задач с текущей датой обновления в этом окне',
        outbound_attempts: 'исходящих попыток вызова',
    };
    return Object.entries(packet.sources || {}).flatMap(([name, source]) => {
        if (!labels[name] || !Number.isSafeInteger(source.count) || source.count < 0) return [];
        // An empty window needs citable evidence too. Historical context cannot
        // establish that no new records were saved in this reporting window.
        // Never turn an unavailable/partial source into evidence of absence, or
        // start generation for a business that has no records at all.
        if (source.count === 0 && (!packet.hasBusinessData || source.status !== 'available')) return [];
        const id = `aggregate:${name}:${packet.window.kind}:${packet.window.localDate}`;
        return [{ id, summary: `За выбранное окно: ${source.count} ${labels[name]}.`,
            source: { type: 'dashboard_aggregate', id, occurredAt: packet.snapshotAt } }];
    });
}

function reportingContext(businessId, packet) {
    // A period summary needs current next steps, not an archive of old messages
    // and lifetime counters. Check live status in the same business before using
    // a historical task/deal as an action for today.
    return (packet.contextFacts || []).filter(fact => {
        if (fact.source.type === 'manager_tasks') {
            const row = DB.get('SELECT status FROM manager_tasks WHERE instanceId=? AND taskId=?', [businessId, fact.source.id]);
            return row && !['completed', 'cancelled', 'canceled', 'closed', 'done'].includes(row.status);
        }
        if (fact.source.type === 'customer_deals') {
            const row = DB.get('SELECT stage FROM customer_deals WHERE instanceId=? AND id=?', [businessId, fact.source.id]);
            return row && !['won', 'lost'].includes(row.stage);
        }
        return false;
    }).slice(0, 8);
}

function currentStateData(businessId, now = new Date()) {
    Deals.ensureSchema();
    const clients = DB.get('SELECT COUNT(*) AS n,MAX(createdAt) AS updatedAt FROM clients WHERE instanceId=? AND julianday(createdAt)<=julianday(?)', [businessId, now.toISOString()]);
    const openDeals = DB.get("SELECT COUNT(*) AS n,MAX(updatedAt) AS updatedAt FROM customer_deals WHERE instanceId=? AND stage NOT IN ('won','lost') AND julianday(updatedAt)<=julianday(?)", [businessId, now.toISOString()]);
    const openTasks = DB.get("SELECT COUNT(*) AS n,MAX(updatedAt) AS updatedAt FROM manager_tasks WHERE instanceId=? AND status NOT IN ('completed','cancelled','closed','done') AND julianday(updatedAt)<=julianday(?)", [businessId, now.toISOString()]);
    const statuses = DB.all(`SELECT leadStatus,COUNT(*) AS n FROM clients
        WHERE instanceId=? AND julianday(createdAt)<=julianday(?) GROUP BY leadStatus ORDER BY n DESC,leadStatus LIMIT 20`, [businessId, now.toISOString()]);
    const dealAmounts = DB.all(`SELECT currency,SUM(amountMinor) AS totalMinor,MAX(updatedAt) AS updatedAt
        FROM customer_deals WHERE instanceId=? AND stage NOT IN ('won','lost') AND amountMinor IS NOT NULL
        AND julianday(updatedAt)<=julianday(?) GROUP BY currency`, [businessId, now.toISOString()]);
    return { clients, openDeals, openTasks, statuses, dealAmounts };
}

function currentStateFacts(businessId, state = currentStateData(businessId)) {
    const source = (id, updatedAt) => ({ type: 'dashboard_aggregate', id,
        createdAt: validTimestamp(updatedAt) });
    return [
        { id: 'current:clients', summary: `Текущее состояние бизнеса в CRM: ${state.clients.n} ${clientCountLabel(state.clients.n)} за всё время; это не показатель выручки или числа активных покупателей.`,
            source: source('current:clients', state.clients.updatedAt) },
        { id: 'current:open-deals', summary: `Сейчас в CRM ${state.openDeals.n} открытых сделок.`,
            source: source('current:open-deals', state.openDeals.updatedAt) },
        { id: 'current:open-tasks', summary: `Сейчас в CRM ${state.openTasks.n} открытых задач.`,
            source: source('current:open-tasks', state.openTasks.updatedAt) },
        ...state.dealAmounts.filter(row => Number.isSafeInteger(row.totalMinor)).map(row => ({
            id: `current:open-deal-amount:${row.currency}`,
            summary: `Текущее состояние: общая сумма открытых сделок ${row.totalMinor / 100} ${short(row.currency, 10)}. Это сумма предложений в CRM, не подтверждённая выручка или оплата.`,
            source: source(`current:open-deal-amount:${row.currency}`, row.updatedAt),
        })),
        ...state.statuses.map(row => {
            const status = short(row.leadStatus, 50) || 'не указан';
            const id = `current:lead-status:${status}`;
            return { id,
                summary: `Текущее состояние бизнеса в CRM: ${row.n} записей клиентов имеют статус «${customerLabel('client', status)}». Статус не доказывает оплату или риск ухода.`,
                source: source(id, state.clients.updatedAt) };
        }),
    ];
}

function questionContext(question) {
    const asksClientCount = /(?:сколько|число|количеств).{0,50}(?:клиент|покупател)|(?:клиент|покупател).{0,30}(?:сколько|число|количеств)/i.test(question);
    return {
        clientTotal: asksClientCount && /всего|за вс[её] время|общ[ее] числ|в crm|в срм|в бизнесе|у нас/i.test(question)
            && !/нов[ыые]|сегодня|вчера|за ночь|за период|за день|за неделю/i.test(question),
        businessState: /как (ид[её]т|дела)|состояни[ея] бизнеса|обзор бизнеса|статистик|показател|что (с|у) моим бизнесом/i.test(question),
        risk: /риску|риск|уйти|уход|отток|потер.*клиент|проблем.*сделк/i.test(question),
        plan: /план|приоритет|что (важно|делать)|на что обратит|задач/i.test(question),
    };
}

// Reuse the tenant-scoped intelligence already shown in Command Center. Its
// scores describe operational attention, not a prediction that a client leaves.
function intelligenceFacts(businessId, question, now) {
    const context = questionContext(question);
    if (!context.risk && !context.plan && !context.businessState) return [];
    const data = Intelligence.getIntelligence(businessId, { now });
    const observedAt = data.generatedAt;
    const seen = new Map();
    const facts = [];
    const add = (type, id, summary, subject) => {
        const factId = `intelligence:${type}:${id}`;
        if (seen.has(factId)) {
            const existing = seen.get(factId);
            existing.summary = short(`${existing.summary} ${summary}`, 300);
            return;
        }
        const updated = type === 'deal'
            ? DB.get('SELECT updatedAt FROM customer_deals WHERE instanceId=? AND id=?', [businessId, id])
            : DB.get('SELECT updatedAt FROM manager_tasks WHERE instanceId=? AND taskId=?', [businessId, id]);
        const fact = { id: factId, summary: short(summary, 300),
            subject: { type, name: short(subject, 80) },
            source: { type: type === 'deal' ? 'customer_deal' : 'manager_task',
                id: String(id), createdAt: validTimestamp(updated?.updatedAt) || observedAt } };
        seen.set(factId, fact);
        facts.push(fact);
    };
    if (context.plan || context.businessState) {
        for (const item of data.dayPlan.items.slice(0, 12)) {
            const kind = item.kind === 'deal' ? 'deal' : 'task';
            add(kind, item.id,
                `${kind === 'deal' ? 'Действие по сделке' : 'Открытая задача'} «${short(item.title, 100)}» назначено на ${item.dueAt}; приоритет ${item.priority}.`,
                item.title);
        }
    }
    if (context.risk || context.businessState || context.plan) {
        for (const item of data.deals.items.slice(0, 8)) {
            const linked = DB.get(`SELECT d.clientChatId,c.id AS clientId,c.senderName,c.createdAt AS clientCreatedAt FROM customer_deals d
                LEFT JOIN clients c ON c.instanceId=d.instanceId AND c.chatId=d.clientChatId
                WHERE d.instanceId=? AND d.id=?`, [businessId, item.id]);
            const client = linked?.clientChatId
                ? `Клиент: ${short(linked.senderName, 80) || 'имя не указано'}. ` : '';
            const reasons = item.riskReasons.map(reason => reason.code === 'action_overdue'
                ? `Просрочено следующее действие (${item.nextActionAt})` : reason.evidence).join('; ');
            add('deal', item.id,
                `${client}Сделка «${short(item.title, 90)}», этап ${item.stage}; причины внимания: ${reasons}. Последний контакт: ${item.lastContactAt || 'не записан'}. Следующее действие: ${short(item.nextAction, 90) || 'не указано'}.`,
                item.title);
            if (linked?.clientId != null) {
                const clientId = `intelligence:client:${linked.clientId}`;
                if (!seen.has(clientId)) {
                    const fact = { id: clientId,
                        summary: `Клиент «${short(linked.senderName, 80) || 'имя не указано'}» связан со сделкой «${short(item.title, 90)}».`,
                        subject: { type: 'client', name: short(linked.senderName, 80) || 'имя не указано' },
                        source: { type: 'client', id: String(linked.clientId),
                            createdAt: validTimestamp(linked.clientCreatedAt) } };
                    seen.set(clientId, fact);
                    facts.push(fact);
                }
            }
        }
        for (const item of data.priorities.filter(row => row.kind === 'task')) {
            add('task', item.id,
                `Открытая задача «${short(item.title, 100)}»; причины внимания: ${item.scoreFactors.map(factor => factor.evidence).join('; ')}. Следующий шаг: ${short(item.nextAction, 90)}.`,
                item.title);
        }
    }
    return facts;
}

async function ask(businessId, range, question, { overnight = false, factWindow = null,
    signal, now = new Date(), factPacket } = {}) {
    const q = short(question, 1200);
    if (!q) throw inputError('INVALID_QUESTION');
    if (isKnowledgeQuestion(q)) return { unsupported: true };
    const context = questionContext(q);
    let rawFacts, revision, status, limitations = [], sourceUpdatedAt = null;
    let state = null;
    const windowKind = factWindow || (overnight ? 'overnight' : null);
    if (windowKind) {
        const packet = factPacket || require('./facts').getFactPacket(businessId, { window: windowKind, now });
        if (!validFactPacket(packet, businessId, range, now, windowKind)) {
            throw Object.assign(new Error('DASHBOARD_FACTS_UNAVAILABLE'),
                { code: 'DASHBOARD_FACTS_UNAVAILABLE', statusCode: 503 });
        }
        rawFacts = [...aggregateFacts(packet), ...packet.facts.filter(fact => fact.source.type !== 'tool_runs'), ...reportingContext(businessId, packet)];
        revision = packet.sourceRevision;
        status = packet.status;
        limitations = packet.limitations || [];
        sourceUpdatedAt = packet.sourceUpdatedAt || null;
    } else {
        const data = snapshot(businessId, range, { fresh: true });
        const businessContext = require('./facts').getBusinessContext(Number(businessId), { now });
        if (businessContext.hasBusinessData) state = currentStateData(Number(businessId), now);
        const counts = [
            ['newClientCount', 'созданных записей клиентов'],
            ['messageCount', 'сообщений'],
            ['leadStatusChangeCount', 'изменений статуса лида'],
            ['conversationEventCount', 'событий диалога'],
            ['changedDealCount', 'сделок с текущей датой обновления в периоде'],
            ['openTaskSampleCount', 'открытых задач в ограниченной выборке'],
            ['openDealSampleCount', 'открытых сделок в ограниченной выборке'],
        ];
        const includeZeros = businessContext.hasBusinessData || /(сколько|число|колич|нет ли)/i.test(q);
        rawFacts = [
            ...(state ? currentStateFacts(Number(businessId), state) : []),
            ...intelligenceFacts(Number(businessId), q, now),
            ...businessContext.contextFacts,
            ...counts.flatMap(([name, label]) => {
                const count = data.facts[name];
                if (!Number.isSafeInteger(count) || (!count && !includeZeros)) return [];
                return [{ id: `aggregate:${name}`, summary: `За выбранный период: ${count} ${label}.`,
                    source: { type: 'dashboard_aggregate', id: name, createdAt: data.generatedAt } }];
            }),
            ...data.evidence.map(row => ({ id: `${row.source.type}:${row.source.id}`,
                summary: row.fact, source: row.source })),
        ];
        revision = Model.sourceRevision(businessId, range, Model.normalizeFacts(rawFacts));
        status = data.sourceComplete && businessContext.status !== 'partial' ? 'available' : 'partial';
        limitations = data.sourceComplete ? [] : ['Некоторые источники ограничены выборкой; история изменений сделок неполная.'];
        sourceUpdatedAt = [data.sourceUpdatedAt, businessContext.sourceUpdatedAt].filter(Boolean).sort().at(-1) || null;
        if (!businessContext.hasBusinessData && !data.eventCount && !data.facts.changedDealCount) {
            rawFacts = [];
            if (!businessContext.businessDataEmpty) status = 'unavailable';
        }
    }
    if (status === 'unavailable' || !rawFacts.length) return noEvidence(range,
        status === 'unavailable' ? 'unavailable' : 'empty', revision);
    const result = await Model.generate({ businessId: Number(businessId), question: q, range,
        rawFacts, revision, status, limitations, windowKind, signal });
    const answer = result.grounded ? { ...result, period: range, sourceUpdatedAt }
        : { ...noEvidence(range, status, revision), answerStatus: 'insufficient',
            dataStatus: status, generatedAt: result.generatedAt,
            summarizedThrough: result.summarizedThrough || null };
    if (result.modelReceipt) Object.defineProperty(answer, 'modelReceipt', { value: result.modelReceipt });
    return answer;
}

// Customer summaries never expose identifiers or execution diagnostics. Sources
// stay in the server fact packet and the grounded Ask response for citation checks.
function customerText(value) {
    return short(value, 1600)
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '')
        .replace(/\b(?:conversation_events|tool_runs|manager_tasks|outbound_attempts|lead_status_history|customer_deals|internal|draft)\b/gi, '')
        .replace(/\s+/g, ' ').trim();
}

async function overview(businessId, kind, { now = new Date(), signal } = {}) {
    if (!['overnight', 'yesterday'].includes(kind)) throw inputError('INVALID_WINDOW');
    const business = DB.get('SELECT hotelTimezone FROM instances WHERE id=? AND isActive=1', [businessId]);
    if (!business) throw inputError('INVALID_BUSINESS_SCOPE');
    let zone = business.hotelTimezone || 'UTC';
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch (_) { zone = 'UTC'; }
    const window = require('./facts').windowFor(kind, now, zone, true);
    return require('./overview.store').once(businessId, window,
        () => buildOverview(businessId, kind, now), signal);
}

async function buildOverview(businessId, kind, now) {
    const packet = require('./facts').getFactPacket(businessId, { window: kind, now, completeOnly: true });
    const range = { from: packet.window.start, to: packet.window.endExclusive };
    const question = kind === 'overnight'
        ? 'Что произошло за ночь? Кратко выдели подтверждённые значимые события.'
        : 'Что произошло вчера за день? Кратко выдели подтверждённые значимые события.';
    const answer = await ask(businessId, range, question,
        { factWindow: kind, now, factPacket: packet });
    const cited = new Set(answer.sources.map(source => `${source.type}:${source.id}`));
    const changes = packet.facts.filter(fact => cited.has(`${fact.source.type}:${fact.source.id}`))
        .map(fact => customerText(fact.summary)).filter(Boolean).slice(0, 6);
    const attention = (packet.contextFacts || []).filter(fact => {
        if (!cited.has(`${fact.source.type}:${fact.source.id}`)) return false;
        if (fact.source.type === 'manager_tasks') {
            const row = DB.get('SELECT status FROM manager_tasks WHERE instanceId=? AND taskId=?', [businessId, fact.source.id]);
            return row && !['completed', 'cancelled', 'canceled', 'closed', 'done'].includes(row.status);
        }
        if (fact.source.type === 'customer_deals' && /следующий шаг|срок/i.test(fact.summary)) {
            const row = DB.get('SELECT stage FROM customer_deals WHERE instanceId=? AND id=?', [businessId, fact.source.id]);
            return row && !['won', 'lost'].includes(row.stage);
        }
        return false;
    }).map(fact => customerText(fact.summary)).filter(Boolean).slice(0, 4);
    const summary = customerText(answer.answer);
    const result = { businessId: Number(businessId), window: packet.window, asOf: packet.asOf,
        status: packet.status, answerStatus: answer.answerStatus,
        summary, outcome: summary, changes, attention, grounded: answer.grounded,
        highlights: changes.map(text => ({ text })),
        sourceUpdatedAt: packet.sourceUpdatedAt,
        generatedAt: answer.generatedAt, summaryThrough: answer.summarizedThrough || null };
    if (answer.modelReceipt) Object.defineProperty(result, 'modelReceipt', { value: answer.modelReceipt });
    return result;

}

module.exports = { period, nightPeriod, snapshot, briefing, activity, ask, overview, inputError, isKnowledgeQuestion };
