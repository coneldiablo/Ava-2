'use strict';

const DB = require('./database.service');
const Canonical = require('./client-identity.service');
const Memory = require('./crm-memory-store.service');
const POLICY = require('./crm-memory-policy.json');

function fail(code, statusCode = 400) { throw Object.assign(new Error(code), {code, statusCode}); }
function parse(value) { try { return JSON.parse(value || '{}'); } catch (_) { return {}; } }
function instant(value) {
    if (!value) return null;
    const text = String(value), date = new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(text) ? text : text.replace(' ', 'T') + 'Z');
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function table(name) { return !!DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [name]); }
function limit(value, fallback) {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 100) fail('WORKSPACE_INPUT_INVALID');
    return Number(value);
}
function cursor(value, businessId, chatId) {
    if (typeof value !== 'string' || value.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('WORKSPACE_HISTORY_CURSOR_INVALID');
    let result;
    try { result = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch (_) { fail('WORKSPACE_HISTORY_CURSOR_INVALID'); }
    if (!result || result.v !== 1 || result.businessId !== businessId || result.chatId !== chatId) fail('WORKSPACE_HISTORY_CURSOR_INVALID');
    return result;
}
function encode(value, businessId, chatId) { return Buffer.from(JSON.stringify({v: 1, businessId, chatId, ...value})).toString('base64url'); }
function sourceView(row, chatId, type = 'call') {
    return {sourceId: String(row.id), type, timestamp: instant(row.timestamp), text: String(row.content || '').slice(0, 600),
        href: `/?client=${encodeURIComponent(chatId)}&source=${encodeURIComponent(row.id)}`};
}

// This is an internal, scoped read model. Authorization belongs to the caller;
// canonical identity is exact and no provider, AI generation or send is invoked.
function scopedClient(businessId, chatId) {
    const id = Number(businessId);
    if (!Number.isSafeInteger(id) || id < 1) fail('BUSINESS_SCOPE_REQUIRED');
    if (typeof chatId !== 'string' || !chatId || chatId.length > 300) fail('WORKSPACE_INPUT_INVALID');
    const canonical = Canonical.resolve(id, chatId);
    const client = DB.get('SELECT * FROM clients WHERE instanceId=? AND chatId=?', [id, canonical]);
    if (!client) fail('WORKSPACE_CLIENT_NOT_FOUND', 404);
    return client;
}

function readySummaries(businessId, chatId) {
    if (!table('crm_memory_summaries')) return [];
    const domain = Memory.domain(businessId);
    return DB.all(`SELECT * FROM crm_memory_summaries WHERE instanceId=? AND chatId=? AND kind IN ('conversation','call')
        ORDER BY julianday(sourceUpdatedAt) DESC,julianday(generatedAt) DESC,summaryId`, [businessId, chatId]).flatMap(row => {
        const value = parse(row.summaryJson);
        if (row.promptVersion !== POLICY.version || value.domain !== domain || !['relevant', 'mixed'].includes(value.relevance)) return [];
        const summary = Memory.safeText(value.summary);
        if (!summary) return [];
        const fields = {};
        for (const name of ['needs', 'budget', 'next_step']) fields[name] = Memory.safeText(value[name], 400);
        for (const name of ['interests', 'objections', 'preferences', 'dates']) fields[name] = Array.isArray(value[name])
            ? value[name].slice(0, 8).map(text => Memory.safeText(text, 200)).filter(Boolean) : [];
        return [{...fields, summary, summaryId: row.summaryId, kind: row.kind, sourceKey: row.sourceKey,
            sourceUpdatedAt: instant(row.sourceUpdatedAt), generatedAt: instant(row.generatedAt), sourceComplete: !!row.sourceComplete,
            provenance: 'ai_generated', evidenceIds: Array.isArray(value.evidence_ids) ? value.evidence_ids.slice(0, 20) : []}];
    });
}

function callHistory(businessId, chatId, summaries, options) {
    const pageLimit = limit(options.callLimit, 30);
    // Page distinct call identities before selecting events. Tasks/drafts cannot
    // consume the 30-call budget or reorder a call by their later creation time.
    const groups = DB.all(`SELECT callId,
        COALESCE(MAX(sourceAt),MIN(anyAt)) AS occurredAt FROM (
            SELECT callId,CASE WHEN channel='voice' AND role NOT IN ('task','draft','summary') THEN julianday(createdAt) END AS sourceAt,
                julianday(createdAt) AS anyAt FROM conversation_events WHERE instanceId=? AND chatId=? AND callId IS NOT NULL
            UNION ALL SELECT sourceKey AS callId,julianday(sourceUpdatedAt) AS sourceAt,julianday(sourceUpdatedAt) AS anyAt
                FROM crm_memory_summaries WHERE instanceId=? AND chatId=? AND kind='call'
        ) GROUP BY callId ORDER BY occurredAt DESC,callId DESC`, [businessId, chatId, businessId, chatId]);
    let before;
    if (options.callBefore !== undefined) {
        before = cursor(options.callBefore, businessId, chatId);
        if (before.kind !== 'calls' || typeof before.callId !== 'string' || !Number.isFinite(before.occurredAt)) fail('WORKSPACE_HISTORY_CURSOR_INVALID');
    }
    const eligible = before ? groups.filter(row => row.occurredAt < before.occurredAt || row.occurredAt === before.occurredAt && row.callId < before.callId) : groups;
    const page = eligible.slice(0, pageLimit), calls = [];
    const hasTranscripts = table('ava_call_transcript_sources');
    for (const group of page) {
        const events = DB.all(`SELECT e.*${hasTranscripts ? ',t.text AS transcript' : ''} FROM conversation_events e
            ${hasTranscripts ? 'LEFT JOIN ava_call_transcript_sources t ON t.businessId=e.instanceId AND t.chatId=e.chatId AND t.sourceId=e.eventId' : ''}
            WHERE e.instanceId=? AND e.chatId=? AND e.callId=? ORDER BY julianday(e.createdAt),e.eventId`, [businessId, chatId, group.callId]);
        const ready = summaries.find(row => row.kind === 'call' && row.sourceKey === group.callId);
        const primary = events.find(row => row.sourceId === `post_call:${group.callId}`)
            || events.find(row => row.channel === 'voice' && ['manager_note', 'system'].includes(row.role)
                && ['provided_summary', 'transcript_extract'].includes(parse(row.metadataJson).summary_provenance))
            || events.find(row => row.channel === 'voice' && ['manager_note', 'system'].includes(row.role));
        const selected = ready ? events.find(row => row.eventId === ready.summaryId) || primary : primary;
        const metadata = parse(primary?.metadataJson || selected?.metadataJson), transcript = events.find(row => row.transcript)?.transcript;
        const summary = ready?.summary || (metadata.summary_provenance === 'unavailable' ? null : primary?.content || null);
        const id = selected?.eventId || ready?.summaryId || events[0]?.eventId || `call:${group.callId}`;
        const timestamp = ready?.sourceUpdatedAt || instant(primary?.createdAt) || instant(events[0]?.createdAt);
        const relatedEvents = events.filter(row => row.eventId !== id && row.role !== 'summary').map(row => ({
            id: row.eventId, type: row.role, summary: String(row.content || '').slice(0, 1200), timestamp: instant(row.createdAt),
            sourceLink: `/conversations?client=${encodeURIComponent(chatId)}&source=${encodeURIComponent(row.eventId)}`,
        }));
        const tasks = table('manager_tasks') ? DB.all('SELECT taskId,summary,status,dueAt FROM manager_tasks WHERE instanceId=? AND chatId=? AND callId=? ORDER BY createdAt,taskId', [businessId, chatId, group.callId]) : [];
        const drafts = table('followup_drafts') ? DB.all('SELECT draftId,managerTaskId,status FROM followup_drafts WHERE instanceId=? AND chatId=? AND callId=? ORDER BY createdAt,draftId', [businessId, chatId, group.callId]) : [];
        calls.push({id, callId: group.callId, timestamp, summary, durationSeconds: Number.isFinite(metadata.duration_seconds) ? metadata.duration_seconds : null,
            provenance: ready?.provenance || metadata.summary_provenance || (summary ? 'stored_call_note' : 'unavailable'),
            sourceComplete: ready?.sourceComplete || false, sourceLink: `/conversations?client=${encodeURIComponent(chatId)}&source=${encodeURIComponent(id)}`,
            relatedEvents, tasks, drafts, ...(transcript ? {transcript: transcript.slice(0, 16000)} : {})});
    }
    const last = page.at(-1), hasMore = eligible.length > page.length;
    return {calls, callPagination: {hasMore, nextCursor: hasMore && last ? encode({kind: 'calls', occurredAt: last.occurredAt, callId: last.callId}, businessId, chatId) : null,
        total: groups.length, limit: pageLimit}};
}

function evidenceSources(businessId, chatId, summary, calls) {
    const sources = [];
    for (const evidence of summary?.evidenceIds || []) {
        if (typeof evidence !== 'string') continue;
        let row, type;
        if (evidence.startsWith('message:')) {
            row = DB.get('SELECT id,content,timestamp FROM messages WHERE instanceId=? AND chatId=? AND CAST(id AS TEXT)=?', [businessId, chatId, evidence.slice(8)]);
            type = 'message';
        } else if (evidence.startsWith('call:')) {
            const call = calls.find(call => call.callId === evidence.slice(5));
            if (call?.summary) row = {id: call.id, content: call.summary, timestamp: call.timestamp};
            type = 'call';
        }
        if (row) sources.push(sourceView(row, chatId, type));
    }
    if (summary?.kind === 'call' && !sources.some(row => row.type === 'call')) {
        const call = calls.find(call => call.callId === summary.sourceKey);
        if (call?.summary) sources.push(sourceView({id: call.id, content: call.summary, timestamp: call.timestamp}, chatId));
    }
    return sources;
}

function snapshot(businessId, chatId, options = {}) {
    const client = scopedClient(businessId, chatId), id = client.instanceId, canonical = client.chatId;
    const summaries = readySummaries(id, canonical), history = callHistory(id, canonical, summaries, options);
    // Context always uses the newest call, even when the user is paging older calls.
    const contextCalls = options.callBefore === undefined ? history.calls : callHistory(id, canonical, summaries, {}).calls;
    const candidates = [...summaries, ...contextCalls.filter(call => call.summary && call.provenance !== 'ai_generated').map(call => ({
        summary: call.summary, sourceUpdatedAt: call.timestamp, sourceComplete: false, provenance: call.provenance,
        kind: 'call', sourceKey: call.callId, needs: null, interests: [], preferences: [], objections: [], next_step: null,
    }))].sort((a, b) => (Date.parse(b.sourceUpdatedAt) || 0) - (Date.parse(a.sourceUpdatedAt) || 0)
        || Number(!!b.summaryId) - Number(!!a.summaryId));
    const ready = candidates[0], sources = evidenceSources(id, canonical, ready, contextCalls);
    const pending = table('crm_memory_jobs') ? DB.all("SELECT kind,state FROM crm_memory_jobs WHERE instanceId=? AND chatId=? AND state<>'done'", [id, canonical]) : [];
    const memory = {summary: ready?.summary || null, keyFacts: [ready?.needs, ...(ready?.interests || []), ...(ready?.preferences || [])].filter(Boolean),
        objections: ready?.objections || [], sourceUpdatedAt: ready?.sourceUpdatedAt || null, sourceComplete: !!ready?.sourceComplete, sources,
        status: ready ? 'ready' : pending.length ? 'generation_pending' : 'empty', provenance: ready?.provenance || null,
        kind: ready?.kind || null, summaryId: ready?.summaryId || null, generationPending: pending.length > 0};
    return {client, ...history, sources, memory, callBrief: {request: ready?.needs || null, lastSummary: memory.summary,
        sources, objections: memory.objections, nextAction: ready?.next_step || null}};
}

function messages(businessId, chatId, options = {}) {
    const client = scopedClient(businessId, chatId), id = client.instanceId, canonical = client.chatId;
    const pageLimit = limit(options.messageLimit, 100);
    let upper = DB.get('SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE instanceId=? AND chatId=?', [id, canonical]).id, before = upper + 1;
    if (options.before !== undefined) {
        const value = cursor(options.before, id, canonical);
        if (value.kind !== 'messages' || !Number.isSafeInteger(value.upper) || value.upper < 0 || !Number.isSafeInteger(value.before) || value.before < 1 || value.before > value.upper + 1) fail('WORKSPACE_HISTORY_CURSOR_INVALID');
        upper = value.upper; before = value.before;
    }
    const rows = DB.all(`SELECT m.id,m.role,m.content,m.timestamp,m.channel,m.senderName,m.sourceMessageId,m.originChatId,a.origin,a.userId AS authorUserId
        FROM messages m LEFT JOIN ava_workspace_message_authorship a ON a.businessId=m.instanceId AND a.messageId=m.id
        WHERE m.instanceId=? AND m.chatId=? AND m.id<=? AND m.id<? ORDER BY m.id DESC LIMIT ?`, [id, canonical, upper, before, pageLimit + 1]);
    const hasMore = rows.length > pageLimit, page = rows.slice(0, pageLimit).reverse();
    const total = DB.get('SELECT COUNT(*) AS n FROM messages WHERE instanceId=? AND chatId=? AND id<=?', [id, canonical, upper]).n;
    const Media = table('whatsapp_media_inputs') ? require('./whatsapp-media.service') : null;
    return {messages: page.map(({origin, sourceMessageId, originChatId, ...row}) => {
        const mediaRow = Media && sourceMessageId ? Media.get(id, originChatId || canonical, sourceMessageId) : null;
        const media = mediaRow ? Media.managerStatus(mediaRow) : null;
        return {...row, timestamp: instant(row.timestamp), channel: row.channel || 'whatsapp',
            ...(media ? {media: {...media, messageId: row.id, mediaUrl: `/api/businesses/${id}/workspace/clients/${encodeURIComponent(canonical)}/messages/${row.id}/media`}} : {}),
            authorType: origin === 'human' ? 'human' : row.role === 'assistant' && /^(autopilot:|whatsapp-reply:)/.test(sourceMessageId || '') ? 'ai'
                : ['assistant', 'manager', 'human', 'agent'].includes(row.role) ? 'team' : 'client'};
    }),
        messagePagination: {hasMore, nextCursor: hasMore ? encode({kind: 'messages', upper, before: page[0].id}, id, canonical) : null, total, limit: pageLimit}};
}

module.exports = {snapshot, messages};
