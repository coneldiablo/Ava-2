'use strict';

const DB = require('../database.service');
const { canTransitionManagerTask } = require('../../utils/constants');

const DAY = 86400000;
const ACTIVE_STAGES = new Set(['new', 'qualified', 'proposal', 'negotiation']);
const OPEN_TASKS = new Set(['new', 'in_progress']);

function dateOf(value) {
    if (!value) return null;
    const date = new Date(String(value).replace(' ', 'T') + (/^\d{4}-\d\d-\d\d \d/.test(String(value)) ? 'Z' : ''));
    return Number.isFinite(date.getTime()) ? date : null;
}

function localDay(now, timezone) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
    catch (_) { return now.toISOString().slice(0, 10); }
}

function target(type, id, chatId) {
    if (type === 'deal') return { type, id, path: `/deals?dealId=${encodeURIComponent(id)}` };
    if (chatId) return { type: 'client', id: chatId, path: `/client/${encodeURIComponent(chatId)}` };
    return { type: 'task', id, path: null };
}

function factor(code, points, evidence) { return { code, points, evidence }; }
function parseMetadata(raw) {
    try { const data = JSON.parse(raw || '{}'); return data && typeof data === 'object' ? data : {}; }
    catch (_) { return {}; }
}

function validDay(value) {
    return typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value)
        && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
        && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function safeRows(sql, params = []) {
    try { return { available: true, rows: DB.all(sql, params) }; }
    catch (error) {
        // Older installations may not have optional tables. Never turn a
        // missing source into a plausible zero or an online status.
        if (/no such table/i.test(error.message)) return { available: false, rows: [] };
        throw error;
    }
}

function ensureDealsSchema() {
    try {
        // The deals module is installed by the customer CRM integration. It
        // creates its table lazily on upgraded deployments.
        require('../customer-deals.store').ensureSchema();
    } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'DEALS_STORAGE_UNAVAILABLE') throw error;
    }
}

function contactTimes(instanceId) {
    const times = new Map();
    const sources = [
        safeRows('SELECT chatId,MAX(timestamp) AS at FROM messages WHERE instanceId=? GROUP BY chatId', [instanceId]),
        safeRows("SELECT chatId,MAX(createdAt) AS at FROM conversation_events WHERE instanceId=? AND chatId IS NOT NULL AND direction IN ('inbound','outbound') GROUP BY chatId", [instanceId]),
    ];
    for (const source of sources) for (const row of source.rows) {
        const previous = times.get(row.chatId);
        if (!previous || (dateOf(row.at)?.getTime() || 0) > (dateOf(previous)?.getTime() || 0)) times.set(row.chatId, row.at);
    }
    return times;
}

function dealView(row, contacts, now, today) {
    const lastContactAt = row.clientChatId ? contacts.get(row.clientChatId) || null : null;
    const contactDate = dateOf(lastContactAt);
    const daysSilent = contactDate ? Math.floor((now - contactDate) / DAY) : null;
    const factors = [];
    if (row.nextActionAt && row.nextActionAt < today) factors.push(factor('action_overdue', 45, `Следующее действие назначено на ${row.nextActionAt}`));
    if (['proposal', 'negotiation'].includes(row.stage) && (!row.nextAction || !row.nextActionAt)) {
        factors.push(factor('next_action_missing', 20, 'Для сделки на позднем этапе нет действия с датой'));
    }
    if (daysSilent !== null && daysSilent >= 7) factors.push(factor('contact_stale_7d', 35, `Последний контакт ${daysSilent} дн. назад`));
    else if (daysSilent !== null && daysSilent >= 3) factors.push(factor('contact_stale_3d', 20, `Последний контакт ${daysSilent} дн. назад`));
    if (row.stage === 'negotiation' && daysSilent !== null && daysSilent >= 3) factors.push(factor('negotiation_stalled', 15, 'Переговоры без недавнего контакта'));
    const score = factors.reduce((sum, item) => sum + item.points, 0);
    return {
        id: row.id, source: 'customer_deals', title: row.title,
        amount: row.amountMinor / 100, currency: row.currency,
        stage: row.stage, lastContactAt, riskReasons: factors,
        score, nextAction: row.nextAction || null, nextActionAt: row.nextActionAt || null,
        target: target('deal', row.id),
    };
}

function taskView(row, today) {
    const metadata = parseMetadata(row.metadataJson);
    const dueAt = validDay(metadata.dueAt) ? metadata.dueAt : null;
    const factors = [];
    if (row.priority === 'urgent') factors.push(factor('urgent_task', 55, 'Приоритет задачи: срочно'));
    else if (row.priority === 'high') factors.push(factor('high_priority_task', 35, 'Приоритет задачи: высокий'));
    if (dueAt && dueAt < today) factors.push(factor('task_overdue', 40, `Срок задачи: ${dueAt}`));
    if (row.reason === 'transfer_failed') factors.push(factor('failed_transfer', 25, 'Неуспешный перевод звонка'));
    return {
        id: row.taskId, kind: 'task', title: row.summary, priority: row.priority,
        status: row.status, createdAt: row.createdAt, dueAt,
        score: factors.reduce((sum, item) => sum + item.points, 0), scoreFactors: factors,
        target: target('task', row.taskId, row.chatId),
        completeAction: { method: 'PATCH', path: `/api/dashboard/${row.instanceId}/tasks/${encodeURIComponent(row.taskId)}`, body: { status: 'done' } },
    };
}

function sentiment(instanceId, now) {
    const source = safeRows(`SELECT p.chatId,p.sentimentScore,p.rawProfileJson,p.lastProfileUpdate,
        (SELECT COUNT(*) FROM messages m WHERE m.instanceId=p.instanceId AND m.chatId=p.chatId) AS messageCount,
        (SELECT MAX(timestamp) FROM messages m WHERE m.instanceId=p.instanceId AND m.chatId=p.chatId) AS lastMessageAt
        FROM client_profiles p WHERE p.instanceId=?`, [instanceId]);
    if (!source.available) return { status: 'unavailable', reason: 'profile_source_unavailable', sampleSize: 0, windowDays: 30 };
    const scores = [];
    for (const row of source.rows) {
        const updated = dateOf(row.lastProfileUpdate);
        const lastMessage = dateOf(row.lastMessageAt);
        if (!updated || now - updated > 30 * DAY || updated - now > DAY
            || !lastMessage || now - lastMessage > 30 * DAY || lastMessage - now > DAY
            || row.messageCount < 3) continue;
        const raw = parseMetadata(row.rawProfileJson);
        if (typeof raw.sentimentScore !== 'number' || !Number.isFinite(raw.sentimentScore) || raw.sentimentScore < 0 || raw.sentimentScore > 1) continue;
        scores.push(raw.sentimentScore);
    }
    const base = { sampleSize: scores.length, windowDays: 30, method: 'recent_ai_client_profiles_with_3_or_more_messages' };
    if (scores.length < 5) return { status: 'insufficient_data', ...base, positive: null, neutral: null, negative: null };
    const counts = { positive: 0, neutral: 0, negative: 0 };
    for (const score of scores) counts[score >= 0.65 ? 'positive' : score <= 0.35 ? 'negative' : 'neutral']++;
    return { status: 'available', ...base, ...counts };
}

function getIntelligence(instanceId, { now = new Date() } = {}) {
    const id = Number(instanceId);
    if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error('invalid_instance_id'), { statusCode: 400 });
    const instance = DB.get('SELECT id,hotelTimezone FROM instances WHERE id=? AND isActive=1', [id]);
    if (!instance) throw Object.assign(new Error('instance_not_found'), { statusCode: 404 });
    const today = localDay(now, instance.hotelTimezone);
    const contacts = contactTimes(id);

    ensureDealsSchema();
    const dealsSource = safeRows('SELECT * FROM customer_deals WHERE instanceId=? AND stage IN (\'new\',\'qualified\',\'proposal\',\'negotiation\')', [id]);
    const allDeals = dealsSource.rows.filter(row => ACTIVE_STAGES.has(row.stage)).map(row => dealView(row, contacts, now, today));
    const atRiskDeals = allDeals.filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const deals = dealsSource.available
        ? { status: 'available', items: atRiskDeals.slice(0, 10), evaluatedCount: allDeals.length }
        : { status: 'unavailable', reason: 'deals_source_unavailable', items: [] };

    const taskSource = safeRows('SELECT * FROM manager_tasks WHERE instanceId=? AND status IN (\'new\',\'in_progress\')', [id]);
    const tasks = taskSource.rows.map(row => taskView(row, today));
    const plannedTasks = tasks.filter(item => item.dueAt && item.dueAt <= today);
    const plannedDeals = dealsSource.available ? allDeals.filter(item => item.nextActionAt && item.nextActionAt <= today && item.nextAction).map(item => ({
        id: item.id, kind: 'deal', title: item.nextAction, priority: item.nextActionAt < today ? 'overdue' : 'normal',
        status: 'open', dueAt: item.nextActionAt, target: item.target,
    })) : [];
    const dayPlan = {
        date: today, status: taskSource.available || dealsSource.available ? 'available' : 'unavailable',
        items: [...plannedTasks, ...plannedDeals].sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id)).slice(0, 30),
        totalCount: plannedTasks.length + plannedDeals.length,
        unscheduledCount: tasks.filter(item => !item.dueAt).length,
    };

    const candidates = [
        ...tasks.filter(item => item.score > 0).map(item => ({
            id: item.id, kind: 'task', score: item.score, scoreFactors: item.scoreFactors,
            title: item.title, reason: item.scoreFactors.map(f => f.evidence).join('; '),
            nextAction: 'Выполнить задачу', target: item.target, completeAction: item.completeAction,
        })),
        ...atRiskDeals.map(item => ({
            id: item.id, kind: 'deal', score: item.score, scoreFactors: item.riskReasons,
            title: item.title, reason: item.riskReasons.map(f => f.evidence).join('; '),
            nextAction: item.nextAction || 'Проверить сделку и назначить следующее действие', target: item.target,
        })),
    ];
    candidates.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    return {
        success: true, instanceId: id, generatedAt: now.toISOString(), priorities: candidates.slice(0, 3),
        deals, dayPlan, sentiment: sentiment(id, now),
        agents: { status: 'unavailable', reason: 'runtime_source_not_configured', items: [] },
    };
}

function updateTask(instanceId, taskId, status) {
    const id = Number(instanceId);
    if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error('invalid_instance_id'), { statusCode: 400 });
    if (!['in_progress', 'done', 'cancelled'].includes(status)) throw Object.assign(new Error('invalid_status'), { statusCode: 400 });
    const existing = DB.getManagerTask(id, taskId);
    if (!existing) throw Object.assign(new Error('task_not_found'), { statusCode: 404 });
    if (!canTransitionManagerTask(existing.status, status)) throw Object.assign(new Error('invalid_status_transition'), { statusCode: 409 });
    if (existing.status === status) return { success: true, idempotent: true, task: taskView(existing, localDay(new Date(), 'UTC')) };
    const changed = DB.updateManagerTask(id, taskId, { status });
    return { success: true, idempotent: false, task: taskView(changed, localDay(new Date(), 'UTC')) };
}

module.exports = { getIntelligence, updateTask, _internals: { dateOf, localDay, dealView, taskView } };
