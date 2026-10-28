'use strict';

const DB = require('./database.service');
const Workspace = require('./ava-workspace.service');
const Store = require('./ava-workspace.store');
const Flags = require('./ava-improvements-flags.service');
const Canonical = require('./client-identity.service');
const Wait = require('./customer-wait.service');
const SOURCE_LIMIT = 2000;
const CLOSED_CLIENT_STATES = new Set(['won', 'lost', 'junk', 'booked']);
const PRIORITIES = {urgent: 0, high: 1, normal: 2};

function fail(code, statusCode = 400) { throw Object.assign(new Error(code), {code, statusCode}); }
function instant(value) {
    if (!value) return null;
    const text = String(value);
    const date = new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(text) ? text : text.replace(' ', 'T') + 'Z');
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function settings(businessId) {
    const policy = Store.businessSettings(businessId);
    return {policy, sla: {timezone: Store.timezone(businessId), workHours: policy.workHours || {start: '00:00', end: '00:00'},
        workDays: policy.workDays || [1, 2, 3, 4, 5, 6, 7], responseDeadlineMinutes: policy.responseDeadlineMinutes || 30}};
}
function routingAvailability(businessId, now) {
    const path = './ava-availability.service';
    let modulePath;
    try { modulePath = require.resolve(path); } catch (error) {
        if (error.code === 'MODULE_NOT_FOUND') return null;
        throw error;
    }
    const service = require(modulePath);
    return typeof service.routingAvailability === 'function' ? service.routingAvailability(businessId, {now: new Date(now)}) : null;
}
function list(auth, businessId, query = {}) {
    const actor = Workspace.authorize(auth, businessId);
    Flags.assertEnabled(actor.businessId, 'attention');
    if (query.limit !== undefined && (typeof query.limit !== 'string' && typeof query.limit !== 'number'
        || !/^\d+$/.test(String(query.limit)) || Number(query.limit) < 1 || Number(query.limit) > 100)) fail('WORKSPACE_INPUT_INVALID');
    const limit = query.limit === undefined ? 50 : Number(query.limit), now = Date.now();
    const {policy, sla} = settings(actor.businessId);
    const broad = ['hotel_owner', 'sales_lead', 'observer'].includes(actor.role);
    let truncated = false;
    function rows(sql, params = []) {
        const result = DB.all(sql + ' LIMIT ?', [...params, SOURCE_LIMIT + 1]);
        if (result.length > SOURCE_LIMIT) truncated = true;
        return result.slice(0, SOURCE_LIMIT);
    }
    const nowInstant = new Date(now).toISOString();
    const noSnoozeSql = ` AND NOT EXISTS(SELECT 1 FROM ava_workspace_snoozes snooze WHERE snooze.businessId=c.instanceId
        AND snooze.chatId=c.chatId AND snooze.userId=? AND julianday(snooze.until)>julianday(?))`;
    const personalScopeParams = [...(broad ? [] : [actor.userId]), actor.userId, nowInstant];
    // Restrict at query time; notifications for someone else's clients never
    // consume a manager's bounded result budget.
    const clients = rows(`SELECT c.*, CASE WHEN u.id IS NOT NULL THEN u.id ELSE NULL END AS effectiveAssigneeUserId
        FROM clients c LEFT JOIN ava_business_memberships m ON m.businessId=c.instanceId AND m.userId=c.assigneeUserId
        AND m.enabled=1 AND m.role IN ('hotel_owner','sales_lead','manager') LEFT JOIN ava_users u ON u.id=m.userId AND u.enabled=1
        WHERE c.instanceId=? ${broad ? '' : 'AND (u.id IS NULL OR u.id=?)'} ${noSnoozeSql}
        ORDER BY c.lastMessageTime, c.chatId`, [actor.businessId, ...personalScopeParams]);
    const visible = new Map(clients.map(c => [c.chatId, c]));
    const items = new Map();
    function add(type, sourceId, chatId, title, description, priority, dueAt = null) {
        if (!visible.has(chatId)) return;
        if (type === 'send_failed' && items.has('send_unknown:' + chatId)) return;
        if (type === 'send_unknown') items.delete('send_failed:' + chatId);
        const id = type.replace(/_(soon|overdue)$/, '') + ':' + sourceId;
        if (items.has(id)) return;
        items.set(id, {id, type, title, description: String(description || '').slice(0, 800), chatId,
            href: '/today?client=' + encodeURIComponent(chatId), priority, dueAt});
    }
    const canonical = chatId => chatId ? Canonical.resolve(actor.businessId, chatId) : null;
    function deadline(type, id, chatId, description, due) {
        const dueAt = instant(due);
        if (!dueAt) return;
        const delta = Date.parse(dueAt) - now;
        if (delta <= 0) add(type + '_overdue', id, chatId, type === 'task' ? 'Задача просрочена' : 'Обещание просрочено', description, 'high', dueAt);
        else if (delta <= 30 * 60000) add(type + '_soon', id, chatId, type === 'task' ? 'Скоро срок задачи' : 'Скоро срок обещания', description, 'normal', dueAt);
    }
    const scopeSql = ` AND EXISTS(SELECT 1 FROM clients c LEFT JOIN ava_business_memberships m ON m.businessId=c.instanceId AND m.userId=c.assigneeUserId
        AND m.enabled=1 AND m.role IN ('hotel_owner','sales_lead','manager') LEFT JOIN ava_users u ON u.id=m.userId AND u.enabled=1
        WHERE c.instanceId=s.instanceId AND c.chatId=s.chatId ${broad ? '' : 'AND (u.id IS NULL OR u.id=?)'} ${noSnoozeSql})`;
    const scoped = [actor.businessId, ...personalScopeParams];
    const businessScopeSql = scopeSql.replaceAll('s.instanceId', 's.businessId');
    for (const row of rows(`SELECT s.* FROM manager_tasks s WHERE s.instanceId=? AND s.status IN ('new','in_progress') AND s.dueAt IS NOT NULL ${scopeSql} ORDER BY julianday(s.dueAt),s.taskId`, scoped)) {
        if (!broad) { const owner = Store.activeAssignee(actor.businessId, row.assigneeUserId); if (owner && owner !== actor.userId) continue; }
        deadline('task', row.taskId, canonical(row.chatId), row.summary, row.dueAt);
    }
    for (const row of rows(`SELECT p.* FROM ava_client_promises p JOIN clients c ON c.instanceId=p.businessId AND c.chatId=p.chatId
        LEFT JOIN ava_business_memberships m ON m.businessId=c.instanceId AND m.userId=c.assigneeUserId AND m.enabled=1 AND m.role IN ('hotel_owner','sales_lead','manager')
        LEFT JOIN ava_users u ON u.id=m.userId AND u.enabled=1 WHERE p.businessId=? AND p.status='open' AND p.dueAt IS NOT NULL
        ${broad ? '' : 'AND (u.id IS NULL OR u.id=?)'} ${noSnoozeSql} ORDER BY julianday(p.dueAt),p.id`, scoped)) {
        if (!broad) { const owner = Store.activeAssignee(actor.businessId, row.assigneeUserId); if (owner && owner !== actor.userId) continue; }
        deadline('promise', row.id, row.chatId, row.summary, row.dueAt);
    }
    // The first unanswered message starts the SLA; subsequent customer messages
    // do not reset it. Only an actual later outgoing message clears this reason.
    for (const row of Wait.unanswered(actor.businessId, {chatIds: [...visible.keys()]})) {
        const wait = Wait.state(row, now, sla);
        if (wait.overdue || wait.approaching) add(wait.overdue ? 'response_overdue' : 'response_soon', row.id, row.chatId,
            wait.overdue ? 'Клиент ждёт ответа' : 'Скоро срок ответа', 'Ответьте на сообщение клиента', wait.overdue ? 'high' : 'normal',
            Wait.responseDeadline(wait.startedAt, now, sla, wait.elapsedMinutes));
    }
    // A process can die after reserving dispatch. Surface a stale sending fence
    // without changing or expiring it: elapsed time never proves non-delivery.
    const staleSendingBefore = new Date(now - 60000).toISOString();
    for (const row of rows(`SELECT s.* FROM ava_conversation_control s WHERE s.businessId=? AND (s.activeSendStatus='unknown'
        OR s.activeSendStatus='sending' AND julianday(s.updatedAt)<=julianday(?)) ${businessScopeSql} ORDER BY s.updatedAt,s.chatId`,
        [actor.businessId, staleSendingBefore, ...personalScopeParams]))
        add('send_unknown', row.chatId, row.chatId, 'Отправка требует проверки', 'Результат отправки не подтверждён. Проверьте доставку перед новым ответом', 'urgent');
    // A later successful retry makes historical failures irrelevant. One state
    // per dialogue avoids duplicate notifications for multiple failed attempts.
    for (const row of rows(`SELECT s.* FROM ava_workspace_reply_actions s WHERE s.businessId=? AND (s.status IN ('unknown','failed')
        OR s.status='sending' AND julianday(s.updatedAt)<=julianday(?)) ${businessScopeSql}
        AND NOT EXISTS(SELECT 1 FROM ava_workspace_reply_actions later WHERE later.businessId=s.businessId AND later.chatId=s.chatId
        AND (later.createdAt>s.createdAt OR (later.createdAt=s.createdAt AND later.rowid>s.rowid))) ORDER BY s.updatedAt,s.id`,
        [actor.businessId, staleSendingBefore, ...personalScopeParams])) {
        if (row.status === 'unknown' || row.status === 'sending') add('send_unknown', row.chatId, row.chatId, 'Отправка требует проверки', 'Результат отправки не подтверждён. Проверьте доставку перед новым ответом', 'urgent');
        else if (!DB.get("SELECT 1 FROM messages WHERE instanceId=? AND chatId=? AND role IN ('assistant','manager','human','agent') AND julianday(timestamp)>julianday(?) LIMIT 1", [actor.businessId, row.chatId, row.updatedAt]))
            add('send_failed', row.chatId, row.chatId, 'Сообщение не отправлено', 'Проверьте диалог и повторите отправку', 'high');
    }
    // Legacy follow-ups share the provider fence but keep delivery outcomes in
    // metadata (a failed approved draft is still actionable).
    for (const row of rows(`SELECT s.* FROM followup_drafts s WHERE s.instanceId=? AND s.status NOT IN ('sent','rejected') ${scopeSql}
        ORDER BY s.updatedAt DESC,s.draftId`, scoped)) {
        let metadata; try { metadata = JSON.parse(row.metadataJson || '{}'); } catch (_) { continue; }
        const states = [row.status, metadata?.delivery_status, metadata?.provider_status].map(value => String(value || '').toLowerCase());
        const unknown = states.some(state => ['unknown','unknown_pending','unknown-pending','delivery_pending','delivery_unconfirmed','unconfirmed','pending','sending'].includes(state));
        const chatId = canonical(row.chatId);
        if (unknown) add('send_unknown', chatId, chatId, 'Отправка требует проверки', 'Результат отправки не подтверждён. Проверьте доставку перед новым ответом', 'urgent');
        else if (states.includes('failed') && !DB.get("SELECT 1 FROM messages WHERE instanceId=? AND chatId=? AND role IN ('assistant','manager','human','agent') AND julianday(timestamp)>julianday(?) LIMIT 1", [actor.businessId, chatId, row.updatedAt]))
            add('send_failed', chatId, chatId, 'Сообщение не отправлено', 'Проверьте диалог и повторите отправку', 'high');
    }
    const availability = policy.routing?.enabled && Flags.snapshot(actor.businessId).flags.shifts ? routingAvailability(actor.businessId, now) : null;
    const noMember = availability?.configured === true && availability?.isWorkingTime === true && Array.isArray(availability.eligibleUserIds)
        && availability.eligibleUserIds.length === 0;
    for (const client of visible.values()) {
        if (client.effectiveAssigneeUserId || CLOSED_CLIENT_STATES.has(client.leadStatus)) continue;
        if (noMember) add('no_available_member', client.chatId, client.chatId, 'Некому принять обращение', 'Сейчас нет доступного сотрудника для назначения', 'high');
        else add('unassigned', client.chatId, client.chatId, 'Нет ответственного', 'Назначьте сотрудника для работы с клиентом', 'normal');
    }
    const sorted = [...items.values()].sort((a, b) => PRIORITIES[a.priority] - PRIORITIES[b.priority]
        || String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999')) || a.id.localeCompare(b.id));
    const byType = {}; for (const item of sorted) byType[item.type] = (byType[item.type] || 0) + 1;
    return {success: true, businessId: actor.businessId, items: sorted.slice(0, limit), counts: {total: sorted.length, returned: Math.min(sorted.length, limit), byType},
        truncated: truncated || sorted.length > limit};
}

module.exports = {list};
