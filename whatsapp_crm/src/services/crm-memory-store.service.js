const crypto = require('crypto');
const { redact } = require('./pms/pms-utils');
const POLICY = require('./crm-memory-policy.json');

const RETRIES = [5000, 15000, 60000, 300000, 1800000, 7200000];
const SCHEMA_DIAGNOSTICS = new Set([
    'MEMORY_SCHEMA_SIZE_INVALID',
    'MEMORY_SCHEMA_JSON_INVALID',
    'MEMORY_SCHEMA_OBJECT_INVALID',
    'MEMORY_SCHEMA_EXTRA_FIELD',
    'MEMORY_SCHEMA_MISSING_FIELD',
    'MEMORY_SCHEMA_SUMMARY_INVALID',
    'MEMORY_SCHEMA_RELEVANCE_INVALID',
    'MEMORY_SCHEMA_EVIDENCE_INVALID',
    'MEMORY_SCHEMA_FIELD_INVALID',
    'MEMORY_SCHEMA_ARRAY_INVALID',
]);
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const parse = (value) => {
    try {
        return JSON.parse(value || '{}');
    } catch (_) {
        return {};
    }
};
function phone(value) {
    value = String(value || '').replace(/@(c\.us|s\.whatsapp\.net)$/, '');
    if (!/^\+?[\d ()-]+$/.test(value)) return null;
    let digits = value.replace(/\D/g, '');
    if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
    return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

function safeText(value, limit = 1200) {
    if (typeof value !== 'string') return null;
    let text = redact(value, 64000);
    for (const [key, secret] of Object.entries(process.env)) {
        if (/(?:password|secret|token|api.?key)/i.test(key) && secret && secret.length >= 6)
            text = text.split(secret).join('[REDACTED]');
    }
    text = text
        .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL]')
        .replace(/\+?\d[\d ()-]{7,}\d/g, (match) => {
            // Preserve explicit calendar dates, never phone/card/passport strings.
            if (/^\d{4}-\d{2}-\d{2}$/.test(match) || /^\d{2}-\d{2}-\d{4}$/.test(match)) return match;
            return match.replace(/\D/g, '').length >= 9 ? '[NUMBER]' : match;
        })
        .replace(/\s+/g, ' ')
        .trim();
    return text.slice(0, limit) || null;
}

class CrmMemoryStore {
    constructor(db = null) {
        this.handle = db;
    }
    get db() {
        return this.handle || require('./database.service');
    }
    domain(instanceId) {
        const row = this.db.get('SELECT businessType FROM instances WHERE id=? AND isActive=1', [instanceId]);
        if (!row) return null;
        return POLICY.domains.includes(row.businessType) ? row.businessType : 'standard';
    }
    businessId(value) {
        const id =
            typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))
                ? Number(value)
                : NaN;
        if (!Number.isSafeInteger(id) || id < 1)
            throw Object.assign(new Error('business_id is required'), {
                code: 'MEMORY_SCOPE_INVALID',
                statusCode: 400,
            });
        return id;
    }

    enabledBusinessIds() {
        if (process.env.CRM_MEMORY_ENABLED !== 'true') return [];
        const scope = String(process.env.CRM_MEMORY_SCOPE || 'allowlist').trim();
        if (scope === 'all_active')
            return this.db.all('SELECT id FROM instances WHERE isActive=1 ORDER BY id')
                .map((row) => this.businessId(row.id));
        if (scope !== 'allowlist')
            throw Object.assign(new Error('Invalid memory rollout scope'), { code: 'MEMORY_SCOPE_INVALID' });
        const configured = String(process.env.CRM_MEMORY_BUSINESS_IDS || '').trim();
        if (!configured) return [];
        return [...new Set(configured.split(',').map((value) => this.businessId(value.trim())))];
    }

    coverage(now = Date.now(), maxWaitMs = 15 * 60000) {
        const enabled = new Set(this.enabledBusinessIds());
        const active = this.db.all('SELECT id FROM instances WHERE isActive=1');
        const pending = this.db.all(`SELECT j.instanceId,j.createdAt,j.attempts FROM crm_memory_jobs j
            JOIN instances i ON i.id=j.instanceId WHERE i.isActive=1 AND j.state='pending'`);
        return {
            active_businesses: active.length,
            enabled_businesses: active.filter((row) => enabled.has(row.id)).length,
            uncovered_businesses: active.filter((row) => !enabled.has(row.id)).length,
            pending_jobs: pending.length,
            uncovered_jobs: pending.filter((row) => !enabled.has(row.instanceId)).length,
            overdue_unattempted_jobs: pending.filter((row) => row.attempts === 0 && row.createdAt <= now - maxWaitMs).length,
        };
    }

    initSchema(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS crm_memory_jobs (
                jobId TEXT PRIMARY KEY, instanceId INTEGER NOT NULL, chatId TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('conversation','call')), sourceKey TEXT NOT NULL,
                sourceHash TEXT NOT NULL, payloadJson TEXT, state TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0, nextAttemptAt INTEGER NOT NULL,
                leaseToken TEXT, leaseUntil INTEGER, lastErrorCode TEXT, lastErrorMessage TEXT,
                createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
                UNIQUE(instanceId,kind,sourceKey), FOREIGN KEY(instanceId) REFERENCES instances(id)
            );
            CREATE INDEX IF NOT EXISTS idx_crm_memory_due ON crm_memory_jobs(state,nextAttemptAt,leaseUntil);
            CREATE TABLE IF NOT EXISTS crm_memory_summaries (
                summaryId TEXT PRIMARY KEY, instanceId INTEGER NOT NULL, chatId TEXT NOT NULL,
                kind TEXT NOT NULL, sourceKey TEXT NOT NULL, sourceHash TEXT NOT NULL,
                summaryJson TEXT NOT NULL, sourceUpdatedAt TEXT, generatedAt TEXT NOT NULL,
                model TEXT NOT NULL, promptVersion TEXT NOT NULL, sourceComplete INTEGER NOT NULL,
                UNIQUE(instanceId,kind,sourceKey), FOREIGN KEY(instanceId) REFERENCES instances(id)
            );
            CREATE INDEX IF NOT EXISTS idx_crm_memory_customer ON crm_memory_summaries(instanceId,chatId,kind,generatedAt);
        `);
    }

    canonicalChatId(instanceId, chatId) {
        return this.handle ? chatId : require('./client-identity.service').resolve(instanceId, chatId);
    }

    scope(instanceId, chatId) {
        if (
            !Number.isSafeInteger(instanceId) ||
            instanceId < 1 ||
            typeof chatId !== 'string' ||
            !chatId ||
            chatId.length > 200 ||
            /@(g\.us|broadcast)$/.test(chatId)
        )
            return null;
        chatId = this.canonicalChatId(instanceId, chatId);
        return this.db.get(
            `SELECT c.id,c.chatId FROM clients c JOIN instances i ON i.id=c.instanceId
            WHERE c.instanceId=? AND c.chatId=? AND i.isActive=1`,
            [instanceId, chatId]
        );
    }

    enqueue(instanceId, chatId, kind, sourceKey, sourceHash, payload, now = Date.now(), delay = 0) {
        if (!this.scope(instanceId, chatId)) return null;
        chatId = this.canonicalChatId(instanceId, chatId);
        const jobId = `memory_${hash(`${instanceId}:${kind}:${sourceKey}`)}`;
        const written = this.db.run(
            `INSERT INTO crm_memory_jobs(jobId,instanceId,chatId,kind,sourceKey,sourceHash,payloadJson,nextAttemptAt,createdAt,updatedAt)
            VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(instanceId,kind,sourceKey) DO UPDATE SET
            chatId=excluded.chatId,sourceHash=excluded.sourceHash,payloadJson=excluded.payloadJson,state='pending',attempts=0,
            nextAttemptAt=excluded.nextAttemptAt,leaseToken=NULL,leaseUntil=NULL,lastErrorCode=NULL,lastErrorMessage=NULL,updatedAt=excluded.updatedAt
            WHERE crm_memory_jobs.sourceHash<>excluded.sourceHash AND crm_memory_jobs.kind='conversation'`,
            [
                jobId,
                instanceId,
                chatId,
                kind,
                sourceKey,
                sourceHash,
                JSON.stringify(payload),
                now + delay,
                now,
                now,
            ]
        );
        const job = this.db.get('SELECT jobId,state FROM crm_memory_jobs WHERE jobId=? AND instanceId=?', [
            jobId,
            instanceId,
        ]);
        return { ...job, changed: written.changes === 1 };
    }

    enqueueConversation(instanceId, chatId, now = Date.now()) {
        if (!this.scope(instanceId, chatId)) return null;
        chatId = this.canonicalChatId(instanceId, chatId);
        const source = this.db.get(
            `SELECT MAX(id) AS endId,COUNT(*) AS count,MAX(timestamp) AS sourceUpdatedAt
            FROM messages WHERE instanceId=? AND chatId=? AND role IN ('user','assistant')`,
            [instanceId, chatId]
        );
        if (source.count < 2) return null;
        const domain = this.domain(instanceId);
        return this.enqueue(
            instanceId,
            chatId,
            'conversation',
            chatId,
            hash(`${POLICY.version}:${domain}:${source.endId}:${source.count}`),
            { ...source, policyVersion: POLICY.version, domain },
            now,
            30000
        );
    }

    enqueueCall(event, input = {}, now = Date.now()) {
        const client = this.scope(Number(event.instanceId), event.chatId);
        if (!client || !event.callId || typeof input.text !== 'string' || input.text.trim().length < 10)
            return null;
        event = { ...event, chatId: client.chatId };
        // A fuzzy name/suffix match must never attach a call to a guest's memory.
        if (!['exact', 'manual'].includes(input.identityConfidence)) return null;
        if (input.phone) {
            const expected = phone(input.phone);
            const direct = phone(event.chatId);
            if (!expected || direct !== expected) {
                const alias = this.db.get(
                    `SELECT 1 FROM customer_identity_links WHERE instanceId=? AND chatId=?
                    AND customerId=? AND normalizedPhone=? AND confidence IN ('exact','manual')`,
                    [
                        event.instanceId,
                        event.chatId,
                        `crm_${event.instanceId}_${client.id}`,
                        String(input.phone).replace(/\D/g, ''),
                    ]
                );
                const confirmed = this.db.getIdentityLinkByPhone?.(Number(event.instanceId), '+' + expected);
                if (!alias && !(confirmed?.confidence === 'manual' && confirmed.chatId === client.chatId)) return null;
            }
        }
        const text = safeText(input.text, 24000);
        if (!text) return null;
        const metadata = parse(event.metadataJson);
        return this.enqueue(
            Number(event.instanceId),
            event.chatId,
            'call',
            event.callId,
            hash(`${POLICY.version}:${this.domain(Number(event.instanceId))}:${text}`),
            {
                text,
                policyVersion: POLICY.version,
                domain: this.domain(Number(event.instanceId)),
                eventId: event.eventId,
                sourceUpdatedAt: event.createdAt,
                sourceComplete: input.sourceComplete !== false && input.text.length <= 24000,
                callDirection: metadata.call_direction || null,
                outcome: metadata.outcome || null,
                durationSeconds: metadata.duration_seconds ?? null,
            },
            now
        );
    }

    lease(now = Date.now(), ttl = 120000, businessIds = null) {
        const ids =
            businessIds === null ? null : [...new Set(businessIds.map((value) => this.businessId(value)))];
        if (ids && !ids.length) return null;
        const filter = ids ? ` AND instanceId IN (${ids.map(() => '?').join(',')})` : '';
        return this.db.db
            .transaction(() => {
                this.db.run(
                    `UPDATE crm_memory_jobs SET state=CASE WHEN attempts>=7 THEN 'dead_letter' ELSE 'pending' END,
                nextAttemptAt=?,leaseToken=NULL,leaseUntil=NULL,lastErrorCode='MEMORY_LEASE_EXPIRED',updatedAt=?
                WHERE state='running' AND leaseUntil<=?${filter}`,
                    [now, now, now, ...(ids || [])]
                );
                const row = this.db.get(
                    `SELECT j.* FROM crm_memory_jobs j JOIN instances i ON i.id=j.instanceId
                WHERE j.state='pending' AND j.nextAttemptAt<=? AND j.attempts<7 AND i.isActive=1${filter.replace('instanceId', 'j.instanceId')}
                ORDER BY j.nextAttemptAt,j.createdAt LIMIT 1`,
                    [now, ...(ids || [])]
                );
                if (!row) return null;
                const token = crypto.randomUUID();
                this.db.run(
                    `UPDATE crm_memory_jobs SET state='running',attempts=attempts+1,leaseToken=?,leaseUntil=?,updatedAt=? WHERE jobId=?`,
                    [token, now + ttl, now, row.jobId]
                );
                return {
                    ...row,
                    state: 'running',
                    attempts: row.attempts + 1,
                    leaseToken: token,
                    leaseUntil: now + ttl,
                };
            })
            .immediate();
    }

    current(job, now = Date.now()) {
        return this.db.get(
            `SELECT * FROM crm_memory_jobs WHERE jobId=? AND instanceId=? AND chatId=?
            AND sourceHash=? AND state='running' AND leaseToken=? AND leaseUntil>?`,
            [job.jobId, job.instanceId, job.chatId, job.sourceHash, job.leaseToken, now]
        );
    }

    source(job) {
        if (!this.scope(job.instanceId, job.chatId))
            throw Object.assign(new Error('Memory customer scope no longer exists'), {
                code: 'MEMORY_SCOPE_INVALID',
                terminal: true,
            });
        const payload = parse(job.payloadJson);
        const domain = this.domain(job.instanceId);
        if (payload.policyVersion !== POLICY.version || payload.domain !== domain) {
            throw Object.assign(new Error('Memory policy changed; refresh source before generation'), {
                code: 'MEMORY_POLICY_CHANGED',
                terminal: true,
            });
        }
        if (job.kind === 'call')
            return {
                messages: [{ id: `call:${job.sourceKey}`, role: 'conversation', text: payload.text }],
                sourceUpdatedAt: payload.sourceUpdatedAt,
                complete: payload.sourceComplete === true,
                domain,
                policyVersion: POLICY.version,
            };
        const rows = this.db.all(
            `SELECT id,role,content,timestamp FROM messages WHERE instanceId=? AND chatId=? AND id<=?
            AND role IN ('user','assistant') ORDER BY id DESC LIMIT 51`,
            [job.instanceId, job.chatId, payload.endId]
        );
        let size = 0;
        const messages = [];
        for (const row of rows.slice(0, 50)) {
            const text = safeText(row.content, 2000);
            if (!text) continue;
            if (size + text.length > 24000) break;
            size += text.length;
            messages.push({ id: `message:${row.id}`, role: row.role, text });
        }
        return {
            messages: messages.reverse(),
            sourceUpdatedAt: payload.sourceUpdatedAt,
            complete:
                rows.length <= 50 &&
                messages.length === rows.length &&
                rows.every((r) => String(r.content || '').length <= 2000),
            domain,
            policyVersion: POLICY.version,
        };
    }

    finish(job, result, source, model, now = Date.now()) {
        return this.db.db
            .transaction(() => {
                if (
                    !this.current(job, now) ||
                    !this.scope(job.instanceId, job.chatId) ||
                    source.policyVersion !== POLICY.version ||
                    source.domain !== this.domain(job.instanceId)
                )
                    return false;
                const summaryId = `summary_${hash(`${job.instanceId}:${job.kind}:${job.sourceKey}`)}`;
                const generatedAt = new Date(now).toISOString();
                this.db.run(
                    `INSERT INTO crm_memory_summaries(summaryId,instanceId,chatId,kind,sourceKey,sourceHash,summaryJson,sourceUpdatedAt,generatedAt,model,promptVersion,sourceComplete)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(instanceId,kind,sourceKey) DO UPDATE SET
                chatId=excluded.chatId,sourceHash=excluded.sourceHash,summaryJson=excluded.summaryJson,sourceUpdatedAt=excluded.sourceUpdatedAt,
                generatedAt=excluded.generatedAt,model=excluded.model,promptVersion=excluded.promptVersion,sourceComplete=excluded.sourceComplete`,
                    [
                        summaryId,
                        job.instanceId,
                        job.chatId,
                        job.kind,
                        job.sourceKey,
                        job.sourceHash,
                        JSON.stringify({ ...result, domain: source.domain }),
                        source.sourceUpdatedAt,
                        generatedAt,
                        model,
                        POLICY.version,
                        source.complete ? 1 : 0,
                    ]
                );
                if (job.kind === 'call') {
                    const payload = parse(job.payloadJson);
                    this.db.run(
                        `INSERT INTO conversation_events(eventId,instanceId,chatId,channel,direction,role,content,callId,sourceId,metadataJson)
                    VALUES(?,?,?,'voice','internal','summary',?,?,?,?) ON CONFLICT(eventId) DO UPDATE SET
                    content=excluded.content,metadataJson=excluded.metadataJson WHERE conversation_events.instanceId=excluded.instanceId AND conversation_events.chatId=excluded.chatId`,
                        [
                            summaryId,
                            job.instanceId,
                            job.chatId,
                            result.summary,
                            job.sourceKey,
                            `memory:${job.sourceKey}`,
                            JSON.stringify({
                                summary_provenance: 'ai_generated',
                                summary_id: summaryId,
                                source_hash: job.sourceHash,
                                source_complete: source.complete,
                                call_direction: payload.callDirection,
                                outcome: payload.outcome,
                                duration_seconds: payload.durationSeconds,
                                next_step: result.next_step,
                                model,
                                prompt_version: POLICY.version,
                                memory_domain: source.domain,
                                relevance: result.relevance,
                            }),
                        ]
                    );
                }
                this.db.run(
                    `UPDATE crm_memory_jobs SET state='done',payloadJson=NULL,leaseToken=NULL,leaseUntil=NULL,
                lastErrorCode=NULL,lastErrorMessage=NULL,updatedAt=? WHERE jobId=?`,
                    [now, job.jobId]
                );
                return true;
            })
            .immediate();
    }

    fail(job, error, now = Date.now()) {
        if (!this.current(job, now)) return false;
        const terminal = error.terminal === true || job.attempts >= 7;
        const diagnosticCode =
            error.code === 'MEMORY_SCHEMA_INVALID' &&
            SCHEMA_DIAGNOSTICS.has(error.diagnosticCode)
                ? error.diagnosticCode
                : 'MEMORY_PROCESSING_FAILED';
        this.db.run(
            `UPDATE crm_memory_jobs SET state=?,nextAttemptAt=?,leaseToken=NULL,leaseUntil=NULL,
            lastErrorCode=?,lastErrorMessage=?,updatedAt=? WHERE jobId=? AND instanceId=? AND leaseToken=?`,
            [
                terminal ? 'dead_letter' : 'pending',
                now + (terminal ? 0 : RETRIES[Math.min(job.attempts - 1, RETRIES.length - 1)]),
                String(error.code || 'MEMORY_GENERATION_FAILED')
                    .replace(/[^A-Z0-9_]/g, '')
                    .slice(0, 80),
                diagnosticCode,
                now,
                job.jobId,
                job.instanceId,
                job.leaseToken,
            ]
        );
        return true;
    }

    refreshPolicyJob(job, now = Date.now()) {
        // Only stored, identity-checked call input may be reprocessed. An API
        // replay must never replace a transcript already accepted for a call ID.
        return this.db.db
            .transaction(() => {
                if (!this.scope(job.instanceId, job.chatId)) return null;
                const current = this.db.get(
                    'SELECT * FROM crm_memory_jobs WHERE jobId=? AND instanceId=? AND chatId=?',
                    [job.jobId, job.instanceId, job.chatId]
                );
                if (!current) return null;
                if (current.kind === 'conversation')
                    return this.enqueueConversation(current.instanceId, current.chatId, now);
                if (current.state === 'done' || !current.payloadJson) return null;
                const payload = parse(current.payloadJson);
                const domain = this.domain(current.instanceId);
                if (!payload.text || (payload.policyVersion === POLICY.version && payload.domain === domain))
                    return null;
                const result = this.db.run(
                    `UPDATE crm_memory_jobs SET sourceHash=?,payloadJson=?,state='pending',attempts=0,
                nextAttemptAt=?,leaseToken=NULL,leaseUntil=NULL,lastErrorCode=NULL,lastErrorMessage=NULL,updatedAt=?
                WHERE jobId=? AND instanceId=? AND sourceHash=? AND state<>'done'`,
                    [
                        hash(`${POLICY.version}:${domain}:${payload.text}`),
                        JSON.stringify({ ...payload, policyVersion: POLICY.version, domain }),
                        now,
                        now,
                        current.jobId,
                        current.instanceId,
                        current.sourceHash,
                    ]
                );
                return { jobId: current.jobId, changed: result.changes === 1 };
            })
            .immediate();
    }

    refreshPolicyJobs(instanceId, options = {}) {
        const result = this.backfill(instanceId, 50, { ...options, dryRun: false });
        // Remaining legacy call jobs are upgraded individually before generation
        // when leased. Completed calls no longer retain input: never fake a re-run.
        const calls = this.db.all(
            `SELECT * FROM crm_memory_jobs WHERE instanceId=? AND kind='call'
            AND state<>'done' AND payloadJson IS NOT NULL ORDER BY createdAt LIMIT 50`,
            [instanceId]
        );
        let callsRefreshed = 0;
        for (const call of calls) if (this.refreshPolicyJob(call)?.changed) callsRefreshed++;
        return { ...result, calls_refreshed: callsRefreshed };
    }

    backfill(instanceId, limit = 50, { dryRun = true, afterCustomerId = 0 } = {}) {
        instanceId = this.businessId(instanceId);
        if (!Number.isSafeInteger(afterCustomerId) || afterCustomerId < 0)
            throw new Error('Invalid memory cursor');
        const pageSize = Math.min(100, Math.max(1, Number.isSafeInteger(limit) ? limit : 50));
        const rows = this.db.all(
            `SELECT c.id,c.chatId FROM clients c JOIN messages m ON m.instanceId=c.instanceId AND m.chatId=c.chatId
            JOIN instances i ON i.id=c.instanceId WHERE c.instanceId=? AND i.isActive=1
            AND c.id>? AND c.chatId NOT LIKE '%@g.us' AND c.chatId NOT LIKE '%@broadcast'
            AND m.role IN ('user','assistant') GROUP BY c.id,c.chatId HAVING COUNT(m.id)>=2 ORDER BY c.id LIMIT ?`,
            [instanceId, afterCustomerId, pageSize + 1]
        );
        const page = rows.slice(0, pageSize);
        let enqueued = 0;
        if (!dryRun)
            for (const row of page) if (this.enqueueConversation(instanceId, row.chatId)?.changed) enqueued++;
        return {
            business_id: instanceId,
            candidates: page.length,
            enqueued,
            dry_run: dryRun,
            next_cursor: rows.length > pageSize ? page[page.length - 1].id : null,
        };
    }

    latest(instanceId, chatId, kind = 'conversation') {
        if (!this.scope(instanceId, chatId) || !['conversation', 'call'].includes(kind)) return null;
        chatId = this.canonicalChatId(instanceId, chatId);
        const row = this.db.get(
            `SELECT * FROM crm_memory_summaries WHERE instanceId=? AND chatId=? AND kind=?
            ORDER BY sourceUpdatedAt DESC,generatedAt DESC LIMIT 1`,
            [instanceId, chatId, kind]
        );
        if (!row) {
            const pending = this.db.get(
                'SELECT state FROM crm_memory_jobs WHERE instanceId=? AND chatId=? AND kind=? ORDER BY updatedAt DESC LIMIT 1',
                [instanceId, chatId, kind]
            );
            return pending ? this.emptySummary(pending.state === 'dead_letter' ? 'generation_failed' : 'generation_pending') : null;
        }
        const value = parse(row.summaryJson);
        if (
            row.promptVersion !== POLICY.version ||
            value.domain !== this.domain(instanceId) ||
            !['relevant', 'mixed', 'out_of_scope', 'no_business_facts'].includes(value.relevance)
        ) {
            return this.emptySummary('policy_refresh_required');
        }
        const excluded = ['out_of_scope', 'no_business_facts'].includes(value.relevance);
        const result = {
            summary_id: row.summaryId,
            summary: excluded
                ? 'В доступной переписке пока нет сведений о запросе, связанном с этим бизнесом.'
                : safeText(value.summary),
            provenance: 'ai_generated',
            status: 'ai_summary',
            policy_version: POLICY.version,
            domain: value.domain,
            relevance: value.relevance,
            source_updated_at: row.sourceUpdatedAt,
            generated_at: row.generatedAt,
            source_complete: !!row.sourceComplete,
        };
        for (const key of ['needs', 'budget', 'next_step'])
            result[key] = excluded ? null : safeText(value[key], 400);
        for (const key of ['interests', 'objections', 'dates', 'preferences'])
            result[key] =
                !excluded && Array.isArray(value[key])
                    ? value[key]
                          .slice(0, 8)
                          .map((v) => safeText(v, 200))
                          .filter(Boolean)
                    : [];
        return result;
    }

    emptySummary(status) {
        return {
            summary: null,
            provenance: 'ai_generated',
            status,
            policy_version: POLICY.version,
            needs: null,
            budget: null,
            next_step: null,
            interests: [],
            objections: [],
            dates: [],
            preferences: [],
            source_complete: false,
            update_pending: status !== 'generation_failed',
        };
    }

    diagnostics(instanceId) {
        if (!Number.isSafeInteger(instanceId) || instanceId < 1) throw new Error('business_id is required');
        const states = this.db.all(
            'SELECT state,COUNT(*) AS count FROM crm_memory_jobs WHERE instanceId=? GROUP BY state',
            [instanceId]
        );
        const errors = this.db.all(
            `SELECT jobId,kind,state,attempts,lastErrorCode,lastErrorMessage,updatedAt FROM crm_memory_jobs
            WHERE instanceId=? AND lastErrorCode IS NOT NULL ORDER BY updatedAt DESC LIMIT 10`,
            [instanceId]
        );
        let enabled = false;
        try {
            enabled = this.enabledBusinessIds().includes(instanceId);
        } catch (_) {
            // Invalid allowlists do not enable any business.
        }
        return {
            business_id: instanceId,
            worker_enabled: enabled,
            overdue_unattempted_jobs: this.db.get(`SELECT COUNT(*) AS count FROM crm_memory_jobs
                WHERE instanceId=? AND state='pending' AND attempts=0 AND createdAt<=?`,
                [instanceId, Date.now() - 15 * 60000]).count,
            states,
            errors: errors.map(({ lastErrorCode, lastErrorMessage, ...row }) => ({
                ...row,
                lastErrorCode,
                diagnosticCode:
                    lastErrorCode === 'MEMORY_SCHEMA_INVALID' &&
                    SCHEMA_DIAGNOSTICS.has(lastErrorMessage)
                        ? lastErrorMessage
                        : null,
            })),
        };
    }

    retryJob(instanceId, jobId, now = Date.now()) {
        instanceId = this.businessId(instanceId);
        return (
            this.db.run(
                `UPDATE crm_memory_jobs SET state='pending',attempts=0,nextAttemptAt=?,updatedAt=?,
            leaseToken=NULL,leaseUntil=NULL,lastErrorCode=NULL,lastErrorMessage=NULL
            WHERE instanceId=? AND jobId=? AND state='dead_letter' AND payloadJson IS NOT NULL`,
                [now, now, instanceId, String(jobId || '')]
            ).changes === 1
        );
    }
}

module.exports = new CrmMemoryStore();
module.exports.safeText = safeText;
module.exports.CrmMemoryStore = CrmMemoryStore;
