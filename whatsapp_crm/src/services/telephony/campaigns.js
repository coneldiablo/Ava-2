'use strict';
const { randomUUID, createHash } = require('crypto');
const DB = require('../database.service');
const Store = require('./store');
const Outbound = require('../ava-outbound.service');
const { fail, fields } = require('./policy');
const json = JSON.stringify;
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const initialized = new WeakSet();
function ensureSchema() {
    Store.ensureSchema();
    if (initialized.has(DB.db)) return;
    DB.db.exec(`CREATE TABLE IF NOT EXISTS ava_campaign_imports (
        id TEXT PRIMARY KEY,businessId INTEGER NOT NULL,actorUserId TEXT NOT NULL,
        rowsJson TEXT NOT NULL,countsJson TEXT NOT NULL,createdAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ava_campaign_drafts (
        campaignId TEXT PRIMARY KEY,businessId INTEGER NOT NULL,actorUserId TEXT NOT NULL,
        sourceNumberId TEXT,importId TEXT,idempotencyKey TEXT NOT NULL,requestHash TEXT NOT NULL,
        createdAt INTEGER NOT NULL,UNIQUE(businessId,idempotencyKey));
        CREATE TABLE IF NOT EXISTS ava_campaign_commands (
        id TEXT PRIMARY KEY,businessId INTEGER NOT NULL,campaignId TEXT NOT NULL,actorUserId TEXT NOT NULL,
        idempotencyKey TEXT NOT NULL,requestHash TEXT NOT NULL,action TEXT NOT NULL,targetStatus TEXT NOT NULL,
        state TEXT NOT NULL,errorCode TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,
        UNIQUE(businessId,idempotencyKey));
        CREATE TABLE IF NOT EXISTS ava_campaign_sources (campaignId TEXT PRIMARY KEY,sourceNumberId TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS ava_campaign_one_dispatch ON ava_campaign_commands(campaignId)
        WHERE state IN ('dispatching','unknown');`);
    if (!DB.db.inTransaction) initialized.add(DB.db);
}
function phone(value) {
    let text = String(value ?? '').trim();
    if (!/^[+\d\s().-]+$/.test(text)) return null;
    text = text.replace(/\D/g, '');
    if (/^8\d{10}$/.test(text)) text = '7' + text.slice(1);
    if (/^\d{10}$/.test(text)) text = '7' + text;
    return /^[1-9]\d{7,14}$/.test(text) ? text : null;
}
function parseCsv(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 512 * 1024) fail('TELEPHONY_IMPORT_TOO_LARGE');
    text = text.replace(/^\uFEFF/, '');
    const first = text.split(/\r?\n/, 1)[0];
    const delimiter = first.includes(';') ? ';' : ',';
    const rows = []; let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
        } else if (!quoted && (ch === delimiter || ch === '\n')) {
            row.push(cell); cell = '';
            if (ch === '\n') { if (row.some(v => v.trim())) rows.push(row); row = []; }
        } else if (ch !== '\r' || quoted) cell += ch;
        if (rows.length > 5001 || cell.length > 10000) fail('TELEPHONY_IMPORT_TOO_LARGE');
    }
    if (quoted) fail('TELEPHONY_CSV_INVALID');
    row.push(cell); if (row.some(v => v.trim())) rows.push(row);
    const headers = (rows.shift() || []).map(v => v.trim());
    if (new Set(headers).size !== headers.length) fail('TELEPHONY_CSV_INVALID');
    return rows.map(values => Object.fromEntries(headers.map((key, i) => [key, values[i] || ''])));
}
function crmRows(businessId,filter) {
    fields(filter,['statuses','lead_statuses','stages','tags','include_tags','exclude_tags','silent_days','silentDays']);
    for(const key of ['statuses','lead_statuses','stages','tags','include_tags','exclude_tags'])
        if(filter[key]!==undefined&&(!Array.isArray(filter[key])||filter[key].length>100||filter[key].some(v=>typeof v!=='string'||!v.trim()||v.length>100)))fail('TELEPHONY_INPUT_INVALID');
    for(const key of ['silent_days','silentDays'])if(filter[key]!==undefined&&(!Number.isSafeInteger(filter[key])||filter[key]<0||filter[key]>3650))fail('TELEPHONY_INPUT_INVALID');
    const Identity=require('../client-identity.service'),Sales=require('../sales-brain.service');
    return DB.all('SELECT * FROM clients WHERE instanceId=? ORDER BY updatedAt DESC,id',[businessId])
        .filter(row=>Sales.clientMatchesOutboundFilter(row,filter)).map(row=>{
            const aliases=Identity.list(businessId,row.chatId).aliases;
            const linked=aliases.find(a=>a.kind==='phone')?.value||aliases.find(a=>a.kind==='whatsapp')?.value;
            const natural=row.chatId.replace(/@(c\.us|s\.whatsapp\.net)$/,'');
            return {phone:linked?linked.replace(/@(c\.us|s\.whatsapp\.net)$/,''):/^\+?[\d ()-]+$/.test(natural)?natural:'',name:row.senderName||''};
        });
}
function preview(businessId, actorUserId, body, now = Date.now()) {
    ensureSchema(); fields(body, ['rows','csv','sourceFilter','phoneColumn','nameColumn']);
    DB.run('DELETE FROM ava_campaign_imports WHERE expiresAt<?',[now]);
    if (DB.get('SELECT COUNT(*) AS n FROM ava_campaign_imports WHERE businessId=? AND createdAt>?',[businessId,now-60000]).n >= 12) fail('TELEPHONY_RATE_LIMIT',429);
    if ([body.rows,body.csv,body.sourceFilter].filter(v=>v!==undefined).length!==1) fail('TELEPHONY_INPUT_INVALID');
    const rows = body.sourceFilter !== undefined ? crmRows(businessId,body.sourceFilter) : body.csv !== undefined ? parseCsv(body.csv) : body.rows;
    if (!Array.isArray(rows) || !rows.length || rows.length > 5000 || Buffer.byteLength(json(rows)) > 1024 * 1024) fail('TELEPHONY_IMPORT_TOO_LARGE');
    const phoneColumn = body.phoneColumn || 'phone', nameColumn = body.nameColumn || 'name';
    if (![phoneColumn,nameColumn].every(v => typeof v === 'string' && v.length > 0 && v.length < 101)) fail('TELEPHONY_INPUT_INVALID');
    const seen = new Set(), valid = [], errors = [], duplicates = [];
    rows.forEach((row, index) => {
        const normalized = row && typeof row === 'object' && !Array.isArray(row) ? phone(row[phoneColumn]) : null;
        if (!normalized) { errors.push({ row: index + 1, code: 'INVALID_PHONE' }); return; }
        if (seen.has(normalized)) { duplicates.push({ row: index + 1, phone: normalized }); return; }
        seen.add(normalized);
        valid.push({ phone: normalized, name: typeof row[nameColumn] === 'string' ? row[nameColumn].trim().slice(0,120) : '' });
    });
    const id = randomUUID(), counts = { total: rows.length, accepted: valid.length, invalid: errors.length, duplicates: duplicates.length };
    DB.run('INSERT INTO ava_campaign_imports VALUES(?,?,?,?,?,?,?)', [id,businessId,actorUserId,json(valid),json(counts),now,now + 86400000]);
    return { success: true, importId: id, expiresAt: now + 86400000, counts, rows: valid.slice(0,100), errors: errors.slice(0,100), duplicates: duplicates.slice(0,100) };
}
function key(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(value)) fail('TELEPHONY_IDEMPOTENCY_REQUIRED'); return value; }
function campaign(businessId, campaignId) {
    const row = DB.getOutboundCampaign(campaignId);
    if (!row || Number(row.instanceId) !== businessId) fail('TELEPHONY_CAMPAIGN_NOT_FOUND',404);
    return row;
}
function configuration(body) {
    fields(body, ['name','importId','sourceNumberId','timezone','callWindow','maxAttempts','retryIntervalMinutes']);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120 || typeof body.importId !== 'string') fail('TELEPHONY_INPUT_INVALID');
    const timezone = body.timezone || 'Europe/Moscow';
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch (_) { fail('TELEPHONY_TIMEZONE_INVALID'); }
    const window = body.callWindow || { start: '09:00', end: '18:00' };
    fields(window, ['start','end']);
    if (![window.start,window.end].every(v => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v)) || window.start >= window.end) fail('TELEPHONY_CALL_WINDOW_INVALID');
    const maxAttempts = body.maxAttempts ?? 1;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) fail('TELEPHONY_ATTEMPTS_INVALID');
    if (body.sourceNumberId != null && (typeof body.sourceNumberId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.sourceNumberId))) fail('TELEPHONY_INPUT_INVALID');
    const input = { name: body.name.trim(), importId: body.importId, sourceNumberId: body.sourceNumberId || null, timezone, callWindow: window, maxAttempts };
    // Preserve the original canonical request for pending pre-upgrade retries.
    if (body.retryIntervalMinutes !== undefined) {
        validateRetryInterval(body.retryIntervalMinutes);
        input.retryIntervalMinutes = body.retryIntervalMinutes;
    }
    return input;
}
function validateRetryInterval(minutes) {
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) fail('TELEPHONY_RETRY_INTERVAL_INVALID');
}
function fixedRetryPolicy(minutes) {
    return { initial_delay_seconds: minutes * 60, multiplier: 1, max_delay_seconds: minutes * 60 };
}
function retrySettings(row) {
    let policy; try { policy = JSON.parse(row.retryPolicyJson || '{}'); } catch (_) { policy = {}; }
    const legacyMinutes = Number(policy.delay_minutes || policy.retry_delay_minutes || 0);
    return { retryIntervalMinutes: Number(policy.initial_delay_seconds || (legacyMinutes > 0 ? legacyMinutes * 60 : 60)) / 60,
        retryBackoffMultiplier: Number(policy.multiplier || policy.backoff_multiplier || (legacyMinutes > 0 ? 1 : 2)) };
}
function updateRetrySettings(businessId, campaignId, body) {
    ensureSchema(); fields(body, ['maxAttempts','retryIntervalMinutes']);
    if (!Object.keys(body).length) fail('TELEPHONY_INPUT_INVALID');
    if (body.maxAttempts !== undefined && (!Number.isSafeInteger(body.maxAttempts) || body.maxAttempts < 1 || body.maxAttempts > 5)) fail('TELEPHONY_ATTEMPTS_INVALID');
    if (body.retryIntervalMinutes !== undefined) validateRetryInterval(body.retryIntervalMinutes);
    return Store.transaction(() => {
        const row = campaign(businessId,campaignId);
        if (row.status !== 'draft' || DB.get("SELECT 1 FROM ava_campaign_commands WHERE campaignId=? AND state IN ('dispatching','unknown')", [campaignId])) fail('TELEPHONY_CAMPAIGN_STATE_CONFLICT',409);
        const updated = DB.updateOutboundCampaign(campaignId, {
            ...(body.maxAttempts === undefined ? {} : { maxAttempts: body.maxAttempts }),
            ...(body.retryIntervalMinutes === undefined ? {} : { retryPolicy: fixedRetryPolicy(body.retryIntervalMinutes) })
        });
        return { success:true,campaign:publicCampaign(updated) };
    });
}
function create(businessId, actorUserId, body, idempotencyKey, now = Date.now()) {
    ensureSchema(); key(idempotencyKey); const input = configuration(body), hash = digest(input);
    const Identities = require('../client-identity.service');
    // Initialize the existing identity schema outside the draft transaction;
    // its module caches schema initialization for the current DB connection.
    Identities.resolve(businessId,'');
    return Store.transaction(() => {
        const prior = DB.get('SELECT * FROM ava_campaign_drafts WHERE businessId=? AND idempotencyKey=?', [businessId,idempotencyKey]);
        if (prior) {
            if (prior.requestHash !== hash) fail('TELEPHONY_IDEMPOTENCY_CONFLICT',409);
            return { success: true, campaign: publicCampaign(campaign(businessId,prior.campaignId)) };
        }
        const imported = DB.get('SELECT * FROM ava_campaign_imports WHERE id=? AND businessId=? AND actorUserId=?', [input.importId,businessId,actorUserId]);
        if (!imported || imported.expiresAt <= now) fail('TELEPHONY_IMPORT_EXPIRED',409);
        const contacts = JSON.parse(imported.rowsJson); if (!contacts.length) fail('TELEPHONY_IMPORT_EMPTY');
        const campaignId = 'camp_' + randomUUID();
        const profile = DB.get('SELECT voiceContextName FROM instances WHERE id=?', [businessId]);
        const row = DB.createOutboundCampaign({ campaignId, instanceId: businessId, name: input.name, contextId: profile.voiceContextName || 'unified_sales_agent', timezone: input.timezone,
            callWindow: input.callWindow, maxAttempts: input.maxAttempts,
            ...(input.retryIntervalMinutes === undefined ? {} : { retryPolicy: fixedRetryPolicy(input.retryIntervalMinutes) }), enabled: false, status: 'draft', sourceFilter: { imported: true },
            postCallAction: { create_note: true, draft_followup: true } });
        for (const contact of contacts) {
            const ids = [...new Set([Identities.resolve(businessId,contact.phone),Identities.resolve(businessId,contact.phone+'@c.us'),contact.phone,contact.phone+'@c.us'])];
            const clients = DB.all(`SELECT * FROM clients WHERE instanceId=? AND chatId IN (${ids.map(()=>'?').join(',')})`,[businessId,...ids]);
            const client = clients.find(row=>row.chatId===ids[0]) || clients[0];
            const blocked = clients.some(row=>require('../sales-brain.service').isDoNotCallClient(row));
            DB.upsertOutboundLead({ campaignId, instanceId: businessId, phone: contact.phone, name: contact.name || client?.senderName,
                customerId:client?`crm_${businessId}_${client.id}`:null,chatId:client?.chatId || null,doNotCall:blocked,state:blocked?'blocked':'pending',
                source: { importId: input.importId }, customVars: { caller_name: contact.name || '', sales_brain_instance_id: businessId } });
        }
        DB.run('INSERT INTO ava_campaign_drafts VALUES(?,?,?,?,?,?,?,?)', [campaignId,businessId,actorUserId,input.sourceNumberId,input.importId,idempotencyKey,hash,now]);
        return { success: true, campaign: publicCampaign(row) };
    });
}
function publicCommand(row) { return row && Object.fromEntries(['id','campaignId','action','targetStatus','state','errorCode','createdAt','updatedAt'].map(k => [k,row[k]])); }
function publicCampaign(row) {
    ensureSchema();
    const counts = DB.all('SELECT state,COUNT(*) AS count FROM outbound_leads WHERE campaignId=? GROUP BY state', [row.campaignId]);
    const command = DB.get('SELECT * FROM ava_campaign_commands WHERE campaignId=? ORDER BY createdAt DESC LIMIT 1', [row.campaignId]);
    const draft = DB.get('SELECT sourceNumberId FROM ava_campaign_sources WHERE campaignId=?', [row.campaignId]) || DB.get('SELECT sourceNumberId FROM ava_campaign_drafts WHERE campaignId=?', [row.campaignId]);
    return { campaignId: row.campaignId, businessId: Number(row.instanceId), name: row.name, status: row.status,
        timezone: row.timezone, callWindow: JSON.parse(row.callWindowJson || '{}'), maxAttempts: row.maxAttempts, ...retrySettings(row),
        audienceSource: DB.get('SELECT 1 FROM ava_campaign_drafts WHERE campaignId=?',[row.campaignId]) ? 'import' : 'crm',
        contextId: row.contextId, sourceNumberId: draft?.sourceNumberId || null, counts: Object.fromEntries(counts.map(r => [r.state,r.count])),
        audienceSize: DB.get('SELECT COUNT(*) AS n FROM outbound_leads WHERE campaignId=? AND doNotCall=0',[row.campaignId]).n,command: publicCommand(command) };
}
function list(businessId) { ensureSchema(); return { success: true, campaigns: DB.listOutboundCampaigns(businessId,{includeDisabled:true}).map(publicCampaign) }; }
function details(businessId,campaignId) {
    ensureSchema(); const row = campaign(businessId,campaignId);
    const leads = DB.all('SELECT * FROM outbound_leads WHERE campaignId=? ORDER BY createdAt DESC LIMIT 5000',[campaignId]).map(lead => ({ leadId:lead.leadId,phone:lead.phone,name:lead.name,state:lead.state,attemptCount:lead.attemptCount,lastOutcome:lead.lastOutcome,
        clientUrl: lead.chatId ? `/clients/${encodeURIComponent(lead.chatId)}` : null }));
    return { success:true,campaign:publicCampaign(row),leads };
}
function assertRoute(businessId, sourceNumberId) {
    const route = Store.source(businessId,sourceNumberId);
    if (!route.managed) {
        const i = DB.get('SELECT sipTrunkNumber,sipCallerId,isActive FROM instances WHERE id=?', [businessId]);
        if (!i?.isActive || !i.sipTrunkNumber || !i.sipCallerId) fail('TELEPHONY_SOURCE_UNAVAILABLE',409);
        // A configured trunk without an owned alias must not originate as another business.
        if (!DB.get('SELECT alias FROM business_sip_aliases WHERE alias=? AND businessId=?',[i.sipCallerId,businessId])) fail('TELEPHONY_SOURCE_UNAVAILABLE',409);
    }
    return route;
}
async function command(businessId, actorUserId, campaignId, body, idempotencyKey, { reauthorize = () => {}, now = Date.now() } = {}) {
    ensureSchema(); key(idempotencyKey); fields(body,['action','confirmAudience','sourceNumberId']);
    const target = {prepare:'draft',start:'running',resume:'running',pause:'paused',stop:'stopped'}[body.action];
    if (!target) fail('TELEPHONY_INPUT_INVALID');
    const hash = digest({campaignId,...body});
    // Revoke late opt-outs before claiming the command transaction. Keep this
    // snapshot update even when the changed audience requires reconfirmation.
    if(target==='running'){
        campaign(businessId,campaignId);
        require('./campaign-permission').refreshSnapshot(businessId,campaignId);
    }
    const claim = Store.transaction(() => {
        const row = campaign(businessId,campaignId);
        const old = DB.get('SELECT * FROM ava_campaign_commands WHERE businessId=? AND idempotencyKey=?',[businessId,idempotencyKey]);
        if (old) { if (old.requestHash !== hash) fail('TELEPHONY_IDEMPOTENCY_CONFLICT',409); return {old}; }
        if (DB.get("SELECT id FROM ava_campaign_commands WHERE campaignId=? AND state IN ('dispatching','unknown')",[campaignId])) fail('TELEPHONY_CAMPAIGN_OUTCOME_UNKNOWN',409);
        const previousSource = DB.get('SELECT sourceNumberId FROM ava_campaign_sources WHERE campaignId=?',[campaignId]) || DB.get('SELECT sourceNumberId FROM ava_campaign_drafts WHERE campaignId=?',[campaignId]);
        const sourceNumberId = Object.hasOwn(body,'sourceNumberId') ? body.sourceNumberId : previousSource?.sourceNumberId || null;
        if (Object.hasOwn(body,'sourceNumberId') && !['prepare','start'].includes(body.action)) fail('TELEPHONY_CAMPAIGN_STATE_CONFLICT',409);
        if (Object.hasOwn(body,'sourceNumberId')) Store.source(businessId,sourceNumberId);
        if (target === 'running') {
            const audience = DB.get('SELECT COUNT(*) AS n FROM outbound_leads WHERE campaignId=? AND doNotCall=0',[campaignId]).n;
            if (!Number.isSafeInteger(body.confirmAudience) || body.confirmAudience !== audience || audience < 1) fail('TELEPHONY_AUDIENCE_CONFIRMATION_REQUIRED',409);
            assertRoute(businessId,sourceNumberId);
            if (body.action === 'resume' && row.status !== 'paused' || body.action === 'start' && row.status !== 'draft') fail('TELEPHONY_CAMPAIGN_STATE_CONFLICT',409);
        }
        if (body.action === 'pause' && row.status !== 'running' || body.action === 'stop' && !['running','paused'].includes(row.status)) fail('TELEPHONY_CAMPAIGN_STATE_CONFLICT',409);
        if (body.action === 'prepare' && row.status !== 'draft') fail('TELEPHONY_CAMPAIGN_STATE_CONFLICT',409);
        const id = randomUUID();
        if (['prepare','start'].includes(body.action)) DB.run('INSERT INTO ava_campaign_sources VALUES(?,?) ON CONFLICT(campaignId) DO UPDATE SET sourceNumberId=excluded.sourceNumberId',[campaignId,sourceNumberId]);
        DB.run('INSERT INTO ava_campaign_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[id,businessId,campaignId,actorUserId,idempotencyKey,hash,body.action,target,'dispatching',null,now,now]);
        return {id};
    });
    if (claim.old) return { success:claim.old.state === 'succeeded',command:publicCommand(claim.old),campaign:publicCampaign(campaign(businessId,campaignId)) };
    try {
        reauthorize();
        const draft = DB.get('SELECT sourceNumberId FROM ava_campaign_sources WHERE campaignId=?',[campaignId]) || DB.get('SELECT sourceNumberId FROM ava_campaign_drafts WHERE campaignId=?',[campaignId]);
        const result = ['start','prepare'].includes(body.action)
            ? await Outbound.syncCampaign(campaignId,{start:body.action==='start',syncLeads:false,sourceNumberId:draft?.sourceNumberId || null,maxConcurrent:1})
            : await Outbound.setCampaignStatus(campaignId,target,{cancelPending:body.action === 'stop'});
        validateEvidence(result,businessId,campaignId,target,draft?.sourceNumberId || null);
        DB.updateOutboundCampaign(campaignId,{status:target,enabled:target === 'running'});
        DB.run("UPDATE ava_campaign_commands SET state='succeeded',updatedAt=? WHERE id=?",[Date.now(),claim.id]);
        reauthorize();
        return {success:true,command:publicCommand(DB.get('SELECT * FROM ava_campaign_commands WHERE id=?',[claim.id])),campaign:publicCampaign(campaign(businessId,campaignId))};
    } catch (error) {
        DB.run("UPDATE ava_campaign_commands SET state='unknown',errorCode='TELEPHONY_CAMPAIGN_OUTCOME_UNKNOWN',updatedAt=? WHERE id=? AND state='dispatching'",[Date.now(),claim.id]);
        if (error.statusCode === 403) throw error;
        fail('TELEPHONY_CAMPAIGN_OUTCOME_UNKNOWN',409);
    }
}
function validateEvidence(result,businessId,campaignId,status,sourceNumberId = null) {
    const observed = result?.ava_campaign;
    if (result?.success !== true || result.sales_brain_campaign_id !== campaignId || Number(observed?.business_id) !== businessId ||
        observed.external_source !== 'sales_brain' || observed.external_id !== campaignId || observed.status !== status ||
        sourceNumberId !== null && observed.source_number_id !== sourceNumberId) fail('TELEPHONY_CAMPAIGN_EVIDENCE_INVALID',502);
}
async function reconcile(businessId,campaignId,reauthorize = () => {}) {
    ensureSchema(); const before = campaign(businessId,campaignId);
    const pending = DB.get("SELECT * FROM ava_campaign_commands WHERE campaignId=? AND state IN ('dispatching','unknown')",[campaignId]);
    if (pending?.state === 'dispatching' && pending.createdAt > Date.now()-60000) return details(businessId,campaignId);
    const latestCommand = DB.get('SELECT id FROM ava_campaign_commands WHERE campaignId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1',[campaignId])?.id;
    const selected = DB.get('SELECT sourceNumberId FROM ava_campaign_sources WHERE campaignId=?',[campaignId]) || DB.get('SELECT sourceNumberId FROM ava_campaign_drafts WHERE campaignId=?',[campaignId]);
    const observed = await Outbound.getCampaignStatus(campaignId);
    reauthorize();
    const status = pending?.targetStatus || observed?.ava_campaign?.status;
    if (!['draft','running','paused','stopped','completed'].includes(status)) fail('TELEPHONY_CAMPAIGN_EVIDENCE_INVALID',502);
    validateEvidence(observed,businessId,campaignId,status,selected?.sourceNumberId || null);
    Store.transaction(() => {
        const current = campaign(businessId,campaignId);
        const latest = DB.get('SELECT id FROM ava_campaign_commands WHERE campaignId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1',[campaignId])?.id;
        if (current.status !== before.status || current.updatedAt !== before.updatedAt || latest !== latestCommand)
            fail('TELEPHONY_CAMPAIGN_STATE_CONFLICT',409);
        if (pending) {
            const command = DB.get('SELECT state FROM ava_campaign_commands WHERE id=?',[pending.id]);
            if (!['dispatching','unknown'].includes(command?.state)) fail('TELEPHONY_CAMPAIGN_STATE_CONFLICT',409);
            DB.run("UPDATE ava_campaign_commands SET state='succeeded',errorCode=NULL,updatedAt=? WHERE id=?",[Date.now(),pending.id]);
        }
        // Legacy campaigns can have no command journal at all. Refresh their
        // display state from scoped runtime evidence without dispatching calls.
        DB.updateOutboundCampaign(campaignId,{status,enabled:status === 'running'});
    });
    return {...details(businessId,campaignId),runtimeStateConfirmed:true};
}
module.exports = {ensureSchema,phone,parseCsv,preview,create,list,details,command,reconcile,publicCampaign,assertRoute,updateRetrySettings};
