'use strict';

const crypto = require('crypto');
const DB = require('./database.service');
const WonAudit = require('./dashboard/deal-won-audit');

const STAGES = Object.freeze(['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost']);
const CURRENCIES = new Set(['RUB', 'USD', 'EUR', 'KZT']);
const initialized = new WeakSet();

function fail(code, statusCode = 400) {
    throw Object.assign(new Error(code), { code, statusCode });
}

function scope(instanceId) {
    const id = Number(instanceId);
    if (!Number.isSafeInteger(id) || id < 1) fail('BUSINESS_SCOPE_REQUIRED');
    return id;
}

function ensureSchema() {
    if (!DB.db) fail('DEALS_STORAGE_UNAVAILABLE', 503);
    if (initialized.has(DB.db)) return;
    DB.db.exec(`
        CREATE TABLE IF NOT EXISTS customer_deals (
            id TEXT PRIMARY KEY,
            instanceId INTEGER NOT NULL REFERENCES instances(id),
            clientChatId TEXT,
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 180),
            amountMinor INTEGER NOT NULL DEFAULT 0 CHECK(amountMinor >= 0),
            currency TEXT NOT NULL DEFAULT 'RUB',
            stage TEXT NOT NULL DEFAULT 'new' CHECK(stage IN ('new','qualified','proposal','negotiation','won','lost')),
            ownerName TEXT NOT NULL DEFAULT '',
            nextAction TEXT NOT NULL DEFAULT '',
            nextActionAt TEXT,
            notes TEXT NOT NULL DEFAULT '',
            createdBy TEXT,
            revision INTEGER NOT NULL DEFAULT 1,
            createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(instanceId,clientChatId) REFERENCES clients(instanceId,chatId)
        );
        CREATE INDEX IF NOT EXISTS idx_customer_deals_scope_stage ON customer_deals(instanceId,stage,updatedAt DESC);
        CREATE INDEX IF NOT EXISTS idx_customer_deals_scope_client ON customer_deals(instanceId,clientChatId);
    `);
    DB.db.exec(`
        CREATE TABLE IF NOT EXISTS deal_stage_events (
            id TEXT PRIMARY KEY,
            instanceId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
            dealId TEXT NOT NULL,
            clientChatId TEXT,
            fromStage TEXT,
            toStage TEXT NOT NULL,
            revision INTEGER NOT NULL,
            actorId TEXT,
            source TEXT NOT NULL CHECK(source IN ('created','transition')),
            occurredAt TEXT NOT NULL,
            dealCreatedAt TEXT NOT NULL,
            amountMinor INTEGER NOT NULL,
            currency TEXT NOT NULL,
            UNIQUE(instanceId,dealId,revision)
        );
        CREATE INDEX IF NOT EXISTS idx_deal_stage_event_scope ON deal_stage_events(instanceId,occurredAt,dealId);
    `);
    DB.db.transaction(() => {
        if (!DB.all('PRAGMA table_info(customer_deals)').some(column => column.name === 'lostReason'))
            DB.db.exec("ALTER TABLE customer_deals ADD COLUMN lostReason TEXT NOT NULL DEFAULT ''");
    }).immediate();
    WonAudit.ensureSchema();
    initialized.add(DB.db);
}

function stringField(value, key, limit, required = false) {
    if (typeof value !== 'string') fail(`DEAL_${key.toUpperCase()}_INVALID`);
    const text = value.trim();
    if ((required && !text) || text.length > limit) fail(`DEAL_${key.toUpperCase()}_INVALID`);
    return text;
}

function normalize(input, existing = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('DEAL_INVALID');
    const allowed = new Set(['title', 'clientChatId', 'amount', 'currency', 'stage', 'ownerName', 'nextAction', 'nextActionAt', 'notes', 'lostReason', 'revision']);
    if (Object.keys(input).some(key => !allowed.has(key))) fail('DEAL_FIELD_NOT_ALLOWED');
    const next = {};
    if ('title' in input) next.title = stringField(input.title, 'title', 180, true);
    else if (!existing) fail('DEAL_TITLE_REQUIRED');
    if ('clientChatId' in input) next.clientChatId = input.clientChatId == null || input.clientChatId === ''
        ? null : stringField(input.clientChatId, 'client', 180, true);
    if ('amount' in input) {
        if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount < 0 || input.amount > 90000000000000) fail('DEAL_AMOUNT_INVALID');
        const minor = Math.round(input.amount * 100);
        if (!Number.isSafeInteger(minor) || Math.abs(minor / 100 - input.amount) > 1e-8) fail('DEAL_AMOUNT_INVALID');
        next.amountMinor = minor;
    }
    if ('currency' in input) {
        if (typeof input.currency !== 'string' || !CURRENCIES.has(input.currency)) fail('DEAL_CURRENCY_INVALID');
        next.currency = input.currency;
    }
    if ('stage' in input) {
        if (!STAGES.includes(input.stage)) fail('DEAL_STAGE_INVALID');
        next.stage = input.stage;
    }
    for (const [name, limit] of [['ownerName', 120], ['nextAction', 280], ['notes', 2000], ['lostReason', 500]]) {
        if (name in input) next[name] = stringField(input[name], name, limit);
    }
    if ('nextActionAt' in input) {
        const date = input.nextActionAt;
        if (date == null || date === '') next.nextActionAt = null;
        else if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
            || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
            || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) fail('DEAL_NEXT_ACTION_DATE_INVALID');
        else next.nextActionAt = date;
    }
    if (existing && !Object.keys(next).length) fail('DEAL_EMPTY_UPDATE');
    return next;
}

function rowToDeal(row) {
    if (!row) return null;
    return { ...row, amount: row.amountMinor / 100 };
}

function assertClient(id, chatId) {
    if (chatId && !DB.get('SELECT id FROM clients WHERE instanceId=? AND chatId=?', [id, chatId])) fail('DEAL_CLIENT_NOT_FOUND', 404);
}

function get(instanceId, dealId) {
    ensureSchema();
    const id = scope(instanceId);
    return rowToDeal(DB.get('SELECT * FROM customer_deals WHERE instanceId=? AND id=?', [id, dealId]));
}

function list(instanceId, { search = '', limit = 500 } = {}) {
    ensureSchema();
    const id = scope(instanceId);
    if (typeof search !== 'string' || search.length > 120) fail('DEAL_SEARCH_INVALID');
    const bounded = Math.max(1, Math.min(Number(limit) || 500, 500));
    const rows = search.trim()
        ? DB.all(`SELECT * FROM customer_deals WHERE instanceId=? AND
            (title LIKE ? ESCAPE '\\' OR ownerName LIKE ? ESCAPE '\\' OR clientChatId LIKE ? ESCAPE '\\')
            ORDER BY updatedAt DESC,id DESC LIMIT ?`, [id, ...Array(3).fill(`%${search.trim().replace(/[\\%_]/g, '\\$&')}%`), bounded])
        : DB.all('SELECT * FROM customer_deals WHERE instanceId=? ORDER BY updatedAt DESC,id DESC LIMIT ?', [id, bounded]);
    const totals = DB.all('SELECT stage,currency,COUNT(*) AS count,SUM(amountMinor) AS amountMinor FROM customer_deals WHERE instanceId=? GROUP BY stage,currency', [id]);
    return { deals: rows.map(rowToDeal), totals };
}

function recordStageEvent(id, deal, fromStage, actorId, source) {
    DB.run(`INSERT INTO deal_stage_events(id,instanceId,dealId,clientChatId,fromStage,toStage,
        revision,actorId,source,occurredAt,dealCreatedAt,amountMinor,currency)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [crypto.randomUUID(),id,deal.id,deal.clientChatId,
        fromStage,deal.stage,deal.revision,actorId,source,new Date().toISOString(),
        deal.createdAt,deal.amountMinor,deal.currency]);
}

function create(instanceId, input, actorId = null) {
    ensureSchema();
    const id = scope(instanceId);
    const value = normalize(input);
    return DB.db.transaction(() => {
        if (!DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [id])) fail('BUSINESS_NOT_FOUND', 404);
        WonAudit.markTenant(id);
        assertClient(id, value.clientChatId);
        const dealId = crypto.randomUUID();
        DB.run(`INSERT INTO customer_deals(id,instanceId,clientChatId,title,amountMinor,currency,stage,ownerName,nextAction,nextActionAt,notes,lostReason,createdBy)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [dealId, id, value.clientChatId ?? null, value.title,
            value.amountMinor ?? 0, value.currency ?? 'RUB', value.stage ?? 'new', value.ownerName ?? '',
            value.nextAction ?? '', value.nextActionAt ?? null, value.notes ?? '', value.lostReason ?? '', actorId]);
        const created = get(id, dealId);
        recordStageEvent(id, created, null, actorId, 'created');
        return created;
    }).immediate();
}

function update(instanceId, dealId, input, actorId = null) {
    ensureSchema();
    const id = scope(instanceId);
    return DB.db.transaction(() => {
        const existing = get(id, dealId);
        if (!existing) fail('DEAL_NOT_FOUND', 404);
        if (!Number.isSafeInteger(input?.revision) || input.revision !== existing.revision) fail('DEAL_REVISION_CONFLICT', 409);
        WonAudit.markTenant(id);
        const value = normalize(input, existing);
        assertClient(id, value.clientChatId);
        const fields = Object.keys(value);
        const result = DB.run(`UPDATE customer_deals SET ${fields.map(field => `${field}=?`).join(',')},
            revision=revision+1,updatedAt=CURRENT_TIMESTAMP WHERE instanceId=? AND id=? AND revision=?`,
        [...fields.map(field => value[field]), id, dealId, existing.revision]);
        if (result.changes !== 1) fail('DEAL_REVISION_CONFLICT', 409);
        const updated = get(id, dealId);
        if (updated.stage !== existing.stage) recordStageEvent(id, updated, existing.stage, actorId, 'transition');
        return updated;
    }).immediate();
}

function remove(instanceId, dealId, revision) {
    ensureSchema();
    const id = scope(instanceId);
    if (!Number.isSafeInteger(revision)) fail('DEAL_REVISION_REQUIRED');
    const result = DB.run('DELETE FROM customer_deals WHERE instanceId=? AND id=? AND revision=?', [id, dealId, revision]);
    if (!result.changes) {
        if (get(id, dealId)) fail('DEAL_REVISION_CONFLICT', 409);
        fail('DEAL_NOT_FOUND', 404);
    }
    return true;
}

// Keep sales history when a lead is deleted, but remove its personal chat link.
// Callers perform this together with the lead deletion in one DB transaction.
function unlinkClient(instanceId, chatId) {
    ensureSchema();
    const id = scope(instanceId);
    DB.run('UPDATE deal_stage_events SET clientChatId=NULL WHERE instanceId=? AND clientChatId=?', [id,chatId]);
    return DB.run(`UPDATE customer_deals SET clientChatId=NULL,
        revision=revision+1,updatedAt=CURRENT_TIMESTAMP
        WHERE instanceId=? AND clientChatId=?`, [id, chatId]);
}

// A business deletion removes its deals before clients and the instance row.
function removeBusiness(instanceId) {
    ensureSchema();
    const id = scope(instanceId);
    DB.run('DELETE FROM deal_stage_events WHERE instanceId=?', [id]);
    return DB.run('DELETE FROM customer_deals WHERE instanceId=?', [id]);
}

module.exports = { STAGES, ensureSchema, list, get, create, update, remove, unlinkClient, removeBusiness };
