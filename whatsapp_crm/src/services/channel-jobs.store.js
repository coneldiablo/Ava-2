'use strict';

const crypto = require('crypto');
const DB = require('./database.service');

const CHANNELS = new Set(['whatsapp', 'telegram', 'email', 'vk', 'max', 'instagram', 'avito']);
const DEFAULT_LEASE_MS = 120000;
const MAX_ATTEMPTS = 8;
const initialized = new WeakSet();

function invalid(code) { throw Object.assign(new Error(code), { code, statusCode: 400 }); }
function businessId(value) {
    if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) invalid('CHANNEL_JOB_TENANT_INVALID');
    return Number(value);
}
function channelName(value = 'telegram') {
    if (!CHANNELS.has(value)) invalid('CHANNEL_JOB_CHANNEL_INVALID');
    return value;
}
function identifier(value, code, limit = 256) {
    if (!['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isSafeInteger(value))) invalid(code);
    const text = String(value);
    if (!text || text.length > limit || /[\x00-\x1f]/.test(text)) invalid(code);
    return text;
}
function json(value) { return value == null ? null : JSON.stringify(value); }
function parse(value, fallback = null) { try { return value == null ? fallback : JSON.parse(value); } catch (_) { return fallback; } }
function hydrate(row) {
    if (!row) return null;
    return { ...row, responseKey: row.batchKey || row.id, meta: parse(row.metaJson, {}), response: parse(row.responseJson), guardSnapshot: parse(row.guardJson) };
}
function duration(value, fallback) {
    const number = value == null ? fallback : Number(value);
    if (!Number.isFinite(number) || number < 1 || number > 3600000) invalid('CHANNEL_JOB_LEASE_INVALID');
    return Math.floor(number);
}
function safeReason(error, fallback) {
    // Persist a diagnostic code, never provider error text (which may include tokens or payloads).
    const code = typeof error === 'string' ? error : error?.code;
    return /^[A-Za-z0-9_:.-]{1,100}$/.test(code || '') ? code : fallback;
}

function ensureSchema() {
    if (!DB.db) throw new Error('CHANNEL_JOB_DATABASE_NOT_READY');
    if (initialized.has(DB.db)) return;
    DB.ensureMessageOriginSchema();
    DB.db.exec(`
        CREATE TABLE IF NOT EXISTS channel_inbound_jobs (
            id TEXT PRIMARY KEY,
            instanceId INTEGER NOT NULL REFERENCES instances(id),
            chatId TEXT NOT NULL, originChatId TEXT NOT NULL, channel TEXT NOT NULL,
            providerMessageId TEXT NOT NULL, inboundMessageId INTEGER NOT NULL,
            text TEXT NOT NULL, senderName TEXT NOT NULL, metaJson TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN
                ('queued','processing','prepared','sending','acknowledged','completed','retry','suppressed','unknown','failed')),
            attempts INTEGER NOT NULL DEFAULT 0, maxAttempts INTEGER NOT NULL DEFAULT 8,
            availableAt INTEGER NOT NULL, leaseToken TEXT, leaseUntil INTEGER, batchKey TEXT,
            responseJson TEXT, guardJson TEXT, outgoingProviderMessageId TEXT, storedMessageId INTEGER,
            lastErrorCode TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
            UNIQUE(instanceId,channel,originChatId,providerMessageId)
        );
        CREATE INDEX IF NOT EXISTS idx_channel_inbound_jobs_due
            ON channel_inbound_jobs(channel,status,availableAt);
        CREATE INDEX IF NOT EXISTS idx_channel_inbound_jobs_customer
            ON channel_inbound_jobs(instanceId,channel,chatId,status);
    `);
    initialized.add(DB.db);
}

function get({ instanceId, id }) {
    ensureSchema();
    return hydrate(DB.get('SELECT * FROM channel_inbound_jobs WHERE instanceId=? AND id=?', [businessId(instanceId), String(id)]));
}

function enqueue(input) {
    ensureSchema();
    const instanceId = businessId(input.instanceId);
    const channel = channelName(input.channel);
    const originChatId = identifier(input.originChatId || input.chatId, 'CHANNEL_JOB_CHAT_INVALID', 200);
    const chatId = require('./client-identity.service').resolve(instanceId, input.chatId);
    const providerMessageId = identifier(input.providerMessageId, 'CHANNEL_JOB_PROVIDER_ID_INVALID', 128);
    const text = input.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 100000) invalid('CHANNEL_JOB_TEXT_INVALID');
    const senderName = String(input.senderName || 'Customer').slice(0, 500);
    const metaJson = json(input.meta || {});
    const now = Date.now();
    const availableAt = input.availableAt == null ? now : Number(input.availableAt);
    if (!Number.isSafeInteger(availableAt) || availableAt < 0) invalid('CHANNEL_JOB_AVAILABLE_AT_INVALID');
    const sourceMessageId = channel === 'telegram' ? `${originChatId}:${providerMessageId}` : providerMessageId;
    if (sourceMessageId.length > 256) invalid('CHANNEL_JOB_PROVIDER_ID_INVALID');

    // saveMessageWithChannel is async, even though its body uses synchronous SQLite.
    // Keep its narrow insert/projection semantics here so any failure rolls back BOTH
    // the inbound message and its work item, including conversation memory enqueue.
    return DB.db.transaction(() => {
        if (!DB.get('SELECT 1 FROM clients WHERE instanceId=? AND chatId=?', [instanceId, chatId])) invalid('CHANNEL_JOB_CLIENT_NOT_FOUND');
        const existing = DB.get(`SELECT * FROM channel_inbound_jobs
            WHERE instanceId=? AND channel=? AND originChatId=? AND providerMessageId=?`, [instanceId, channel, originChatId, providerMessageId]);
        if (existing) return { inserted: false, job: hydrate(existing), messageId: existing.inboundMessageId };
        // Accept pre-migration Telegram inbound rows as well: replay must repair
        // the missing durable job without duplicating the existing user message.
        let message = DB.get(`SELECT id FROM messages WHERE instanceId=? AND originChatId=? AND channel=?
            AND role='user' AND sourceMessageId IN (?,?) ORDER BY id LIMIT 1`,
        [instanceId, originChatId, channel, sourceMessageId, providerMessageId]);
        if (!message) {
            const written = DB.run(`INSERT INTO messages
                (instanceId,chatId,senderName,messageType,content,role,channel,sourceMessageId,originChatId)
                VALUES(?,?,?,'text',?,'user',?,?,?)`, [instanceId, chatId, senderName, text, channel, sourceMessageId, originChatId]);
            message = { id: Number(written.lastInsertRowid) };
            DB.run(`UPDATE clients SET lastMessage=?,lastMessageTime=CURRENT_TIMESTAMP,updatedAt=CURRENT_TIMESTAMP
                WHERE instanceId=? AND chatId=?`, [text, instanceId, chatId]);
            require('./crm-memory-store.service').enqueueConversation(instanceId, chatId, now);
        }
        const id = `channel_job_${crypto.createHash('sha256').update(JSON.stringify([instanceId, channel, originChatId, providerMessageId])).digest('hex')}`;
        DB.run(`INSERT INTO channel_inbound_jobs
            (id,instanceId,chatId,originChatId,channel,providerMessageId,inboundMessageId,text,senderName,metaJson,availableAt,createdAt,updatedAt)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, instanceId, chatId, originChatId, channel, providerMessageId, message.id,
            text, senderName, metaJson, availableAt, now, now]);
        return { inserted: true, job: get({ instanceId, id }), messageId: message.id };
    }).immediate();
}

function recoverExpiredLeases({ now = Date.now(), channel, instanceId } = {}) {
    ensureSchema();
    const filters = ['leaseUntil<=?'];
    const args = [now];
    if (channel != null) { filters.push('channel=?'); args.push(channelName(channel)); }
    if (instanceId != null) { filters.push('instanceId=?'); args.push(businessId(instanceId)); }
    const where = filters.join(' AND ');
    return DB.db.transaction(() => {
        // Once the provider invocation may have begun, time cannot prove failure.
        const unknown = DB.run(`UPDATE channel_inbound_jobs SET status='unknown',leaseUntil=NULL,
            lastErrorCode='SEND_LEASE_EXPIRED',updatedAt=? WHERE ${where} AND status='sending'`, [now, ...args]).changes;
        const retry = DB.run(`UPDATE channel_inbound_jobs SET status=CASE WHEN attempts>=maxAttempts THEN 'failed' ELSE 'retry' END,
            leaseToken=NULL,leaseUntil=NULL,availableAt=?,lastErrorCode='PROCESSING_LEASE_EXPIRED',updatedAt=?
            WHERE ${where} AND status IN ('processing','prepared')`, [now, now, ...args]).changes;
        // Acknowledged rows remain available for repairing history, never sending again.
        return { retry, unknown };
    }).immediate();
}

function scopeFilters(options, alias = '') {
    const prefix = alias ? `${alias}.` : '';
    const filters = [`${prefix}channel=?`];
    const args = [channelName(options.channel)];
    if (options.instanceId != null) { filters.push(`${prefix}instanceId=?`); args.push(businessId(options.instanceId)); }
    if (options.chatId != null) {
        if (options.instanceId == null) invalid('CHANNEL_JOB_TENANT_REQUIRED');
        filters.push(`${prefix}chatId=?`);
        args.push(require('./client-identity.service').resolve(businessId(options.instanceId), options.chatId));
    }
    return { filters, args };
}

function pending(options = {}) {
    ensureSchema();
    recoverExpiredLeases(options);
    const { filters, args } = scopeFilters(options);
    const now = Date.now();
    const limit = Math.min(500, Math.max(1, Number(options.limit) || 100));
    const rows = DB.all(`SELECT * FROM channel_inbound_jobs WHERE ${filters.join(' AND ')}
        AND ((status IN ('queued','retry') AND availableAt<=?) OR status='acknowledged')
        ORDER BY CASE WHEN status='acknowledged' THEN 0 ELSE 1 END,createdAt,rowid LIMIT ?`, [...args, now, limit]).map(hydrate);
    const seen = new Set();
    return rows.filter(row => {
        if (!row.batchKey) return true;
        if (seen.has(row.batchKey)) return false;
        seen.add(row.batchKey);
        return true;
    }).map(row => {
        if (!row.batchKey) return row;
        // Fetch the whole group even when the page boundary cuts through it.
        const jobs = DB.all(`SELECT * FROM channel_inbound_jobs WHERE instanceId=? AND batchKey=? AND status=?
            ORDER BY createdAt,rowid`, [row.instanceId, row.batchKey, row.status]).map(hydrate);
        return { ...jobs[0], jobs, ids: jobs.map(job => job.id), text: jobs.map(job => job.text).join('\n') };
    });
}

function claimJobs(options, batch) {
    ensureSchema();
    const { filters, args } = scopeFilters(options, 'j');
    const now = Date.now();
    const leaseMs = duration(options.leaseMs, DEFAULT_LEASE_MS);
    return DB.db.transaction(() => {
        recoverExpiredLeases(options);
        const first = DB.get(`SELECT j.* FROM channel_inbound_jobs j WHERE ${filters.join(' AND ')}
            AND j.status IN ('queued','retry') AND j.availableAt<=? AND j.attempts<j.maxAttempts
            AND NOT EXISTS (SELECT 1 FROM channel_inbound_jobs active WHERE active.instanceId=j.instanceId
                AND active.channel=j.channel AND active.chatId=j.chatId
                AND active.status IN ('processing','prepared','sending','unknown','acknowledged'))
            AND NOT EXISTS (SELECT 1 FROM channel_inbound_jobs older WHERE older.instanceId=j.instanceId
                AND older.channel=j.channel AND older.chatId=j.chatId AND older.status IN ('queued','retry')
                AND (older.createdAt<j.createdAt OR (older.createdAt=j.createdAt AND older.rowid<j.rowid)))
            ORDER BY j.createdAt,j.rowid LIMIT 1`, [...args, now]);
        if (!first) return null;
        // Retried groups keep their original membership and response. New inbound
        // messages may not be added to an already prepared/recovered answer.
        const rows = first.batchKey ? DB.all(`SELECT * FROM channel_inbound_jobs WHERE instanceId=? AND batchKey=?
            AND status IN ('queued','retry') ORDER BY createdAt,rowid`, [first.instanceId, first.batchKey])
            : batch ? DB.all(`SELECT * FROM channel_inbound_jobs WHERE instanceId=? AND channel=? AND chatId=? AND originChatId=? AND batchKey IS NULL
                AND status IN ('queued','retry') AND availableAt<=? AND attempts<maxAttempts ORDER BY createdAt,rowid LIMIT 50`,
            [first.instanceId, first.channel, first.chatId, first.originChatId, now]) : [first];
        const leaseToken = crypto.randomUUID();
        const batchKey = first.batchKey || (batch ? crypto.randomUUID() : null);
        const jobs = rows.map(row => {
            DB.run(`UPDATE channel_inbound_jobs SET status='processing',attempts=attempts+1,leaseToken=?,leaseUntil=?,batchKey=?,updatedAt=?
                WHERE instanceId=? AND id=? AND status IN ('queued','retry')`, [leaseToken, now + leaseMs, batchKey, now, row.instanceId, row.id]);
            return get({ instanceId: row.instanceId, id: row.id });
        });
        return batch || first.batchKey ? { ...jobs[0], jobs, ids: jobs.map(job => job.id), text: jobs.map(job => job.text).join('\n') } : jobs[0];
    }).immediate();
}

function transition(job, allowed, fields, { expires = true } = {}) {
    ensureSchema();
    const instanceId = businessId(job.instanceId);
    const ids = job.ids || [job.id];
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || new Set(ids).size !== ids.length || !job.leaseToken) return null;
    const now = Date.now();
    return DB.db.transaction(() => {
        const rows = ids.map(id => get({ instanceId, id }));
        if (rows.some(row => !row || row.leaseToken !== job.leaseToken || !allowed.includes(row.status)
            || (expires && (!row.leaseUntil || row.leaseUntil <= now)))) return null;
        for (const row of rows) {
            const changes = typeof fields === 'function' ? fields(row, now) : fields;
            DB.run(`UPDATE channel_inbound_jobs SET ${Object.keys(changes).map(name => `${name}=?`).join(',')},updatedAt=?
                WHERE instanceId=? AND id=? AND leaseToken=?`, [...Object.values(changes), now, instanceId, row.id, job.leaseToken]);
        }
        const updated = ids.map(id => get({ instanceId, id }));
        return job.ids ? { ...updated[0], jobs: updated, ids, text: updated.map(row => row.text).join('\n') } : updated[0];
    }).immediate();
}

function prepare(job, response, guardSnapshot = null) {
    if (response == null) invalid('CHANNEL_JOB_RESPONSE_REQUIRED');
    return transition(job, ['processing', 'prepared'], { status: 'prepared', responseJson: json(response), guardJson: json(guardSnapshot) });
}
function markSending(job) { return transition(job, ['prepared'], { status: 'sending' }); }
function ack(job, { providerMessageId = null } = {}) {
    const providerId = providerMessageId == null ? null : identifier(providerMessageId, 'CHANNEL_JOB_PROVIDER_ID_INVALID');
    // A late positive provider acknowledgement may resolve its own expired send.
    return transition(job, ['sending', 'unknown', 'acknowledged'], row => ({ status: 'acknowledged', outgoingProviderMessageId: providerId || row.outgoingProviderMessageId,
        leaseUntil: null, lastErrorCode: null }), { expires: false });
}
function complete(job, { providerMessageId, storedMessageId = null } = {}) {
    if (storedMessageId != null && (!Number.isSafeInteger(Number(storedMessageId)) || Number(storedMessageId) < 1)) invalid('CHANNEL_JOB_STORED_MESSAGE_ID_INVALID');
    const providerId = providerMessageId == null ? null : identifier(providerMessageId, 'CHANNEL_JOB_PROVIDER_ID_INVALID');
    return transition(job, ['acknowledged'], row => ({ status: 'completed', outgoingProviderMessageId: providerId || row.outgoingProviderMessageId,
        storedMessageId, leaseToken: null, leaseUntil: null, lastErrorCode: null }), { expires: false });
}
function retry(job, error, { delayMs = 5000, definiteNoSideEffect = false, clearResponse = false, guardSnapshot } = {}) {
    if (!Number.isFinite(Number(delayMs)) || Number(delayMs) < 0) invalid('CHANNEL_JOB_RETRY_DELAY_INVALID');
    const code = safeReason(error, 'CHANNEL_JOB_PROCESSING_FAILED');
    const resetResponse = clearResponse || code === 'WORKSPACE_DIALOGUE_CHANGED';
    return transition(job, definiteNoSideEffect ? ['processing', 'prepared', 'sending'] : ['processing', 'prepared'], (row, now) => ({
        status: row.attempts >= row.maxAttempts ? 'failed' : 'retry', availableAt: now + Number(delayMs),
        leaseToken: null, leaseUntil: null, lastErrorCode: code,
        ...(guardSnapshot === undefined ? {} : { guardJson: json(guardSnapshot) }),
        ...(resetResponse ? { responseJson: null, guardJson: null, batchKey: null } : {}),
    }));
}
function suppress(job, reason) {
    return transition(job, ['processing', 'prepared'], { status: 'suppressed', leaseToken: null, leaseUntil: null,
        lastErrorCode: safeReason(reason, 'CHANNEL_JOB_SUPPRESSED') });
}
function unknown(job, reason) {
    return transition(job, ['sending', 'unknown'], { status: 'unknown', leaseUntil: null,
        lastErrorCode: safeReason(reason, 'CHANNEL_JOB_SEND_UNKNOWN') }, { expires: false });
}
function renew(job, { leaseMs = DEFAULT_LEASE_MS } = {}) {
    return transition(job, ['processing', 'prepared', 'sending'], { leaseUntil: Date.now() + duration(leaseMs, DEFAULT_LEASE_MS) });
}
function isCurrent(job) {
    ensureSchema();
    if (!job?.leaseToken || !job.instanceId) return false;
    const now = Date.now();
    return (job.ids || [job.id]).every(id => {
        const row = get({ instanceId: job.instanceId, id });
        return row && row.leaseToken === job.leaseToken && row.leaseUntil > now
            && ['processing', 'prepared', 'sending'].includes(row.status);
    });
}

module.exports = { ensureSchema, enqueue, recordInbound: enqueue, get, pending,
    claim: (options = {}) => claimJobs(options, false), claimBatch: (options = {}) => claimJobs(options, true),
    prepare, markSending, ack, complete, retry, suppress, unknown, renew, isCurrent, recoverExpiredLeases, MAX_ATTEMPTS };
