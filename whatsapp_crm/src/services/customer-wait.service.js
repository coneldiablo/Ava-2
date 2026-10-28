'use strict';

const DB = require('./database.service');
const Store = require('./ava-workspace.store');
const OUTGOING_ROLES = "'assistant','manager','human','agent'";

function invalid() { throw Object.assign(new Error('WORKSPACE_INPUT_INVALID'), {code: 'WORKSPACE_INPUT_INVALID', statusCode: 400}); }
function instant(value) {
    if (!value) return null;
    const text = String(value);
    const date = new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(text) ? text : text.replace(' ', 'T') + 'Z');
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
// Message IDs are the persisted dialogue order, including equal timestamps.
// Drafts, reservations and a new inbound message cannot clear an actual wait.
function unanswered(businessId, {chatIds} = {}) {
    const id = Number(businessId);
    if (!Number.isSafeInteger(id) || id < 1) invalid();
    if (chatIds !== undefined && (!Array.isArray(chatIds) || chatIds.some(chat => typeof chat !== 'string' || !chat || chat.length > 300))) invalid();
    const chats = chatIds === undefined ? null : [...new Set(chatIds)];
    if (chats && !chats.length) return [];
    return DB.all(`SELECT m.id,m.chatId,m.timestamp FROM messages m JOIN (
        SELECT s.chatId,MIN(s.id) AS id FROM messages s WHERE s.instanceId=? AND s.role='user'
        ${chats ? `AND s.chatId IN (${chats.map(() => '?').join(',')})` : ''}
        AND NOT EXISTS(SELECT 1 FROM messages answer WHERE answer.instanceId=s.instanceId AND answer.chatId=s.chatId
            AND answer.id>s.id AND answer.role IN (${OUTGOING_ROLES})) GROUP BY s.chatId
        ) first ON first.id=m.id WHERE m.instanceId=? ORDER BY m.id`, [id, ...(chats || []), id]);
}
function firstUnanswered(businessId, chatId) { return unanswered(businessId, {chatIds: [chatId]})[0] || null; }
function state(inbound, now, sla) {
    const startedAt = instant(inbound?.timestamp), current = Number(new Date(now));
    const deadline = Number(sla?.responseDeadlineMinutes);
    if (!startedAt || !Number.isFinite(current) || Date.parse(startedAt) > current || !Number.isFinite(deadline) || deadline <= 0)
        return {startedAt, elapsedMinutes: 0, overdue: false, approaching: false};
    const elapsedMinutes = Store.workingMinutes(startedAt, new Date(current), sla, deadline);
    const overdue = elapsedMinutes >= deadline;
    const approaching = !overdue && elapsedMinutes > 0 && deadline - elapsedMinutes <= Math.min(15, Math.ceil(deadline / 3))
        && Store.workingMinutes(new Date(current), new Date(current + 1000), sla) > 0;
    return {startedAt, elapsedMinutes, overdue, approaching};
}
// Find the working-time deadline, including weekends and DST. Overdue records
// search from their source timestamp; approaching records use remaining time.
function responseDeadline(start, now, sla, elapsed) {
    let left = Date.parse(start), remaining = Number(sla?.responseDeadlineMinutes);
    now = Number(new Date(now));
    if (!Number.isFinite(left) || !Number.isFinite(now) || !Number.isFinite(remaining) || remaining <= 0) return null;
    if (elapsed < remaining) { left = now; remaining -= elapsed; }
    let right = left + Math.max(remaining * 60000, 86400000);
    const ceiling = left + 366 * 86400000;
    while (Store.workingMinutes(new Date(left), new Date(right), sla, remaining) < remaining) {
        if (right >= ceiling) return null;
        right = Math.min(ceiling, left + (right - left) * 2);
    }
    const origin = left;
    while (right - left > 1) {
        const middle = Math.floor((left + right) / 2);
        if (Store.workingMinutes(new Date(origin), new Date(middle), sla, remaining) >= remaining) right = middle;
        else left = middle;
    }
    return new Date(right).toISOString();
}

module.exports = {unanswered, firstUnanswered, state, responseDeadline};
