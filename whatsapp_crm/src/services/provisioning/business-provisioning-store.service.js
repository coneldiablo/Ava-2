const { normalizeVoiceProvider } = require('../voice-provider.service');
const crypto = require('crypto');
const DB = require('../database.service');
const { redact, parseJson } = require('../pms/pms-utils');

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DEFAULT_WORKING_HOURS = Object.freeze({
    mon: { enabled: true, start: '09:00', end: '18:00' },
    tue: { enabled: true, start: '09:00', end: '18:00' },
    wed: { enabled: true, start: '09:00', end: '18:00' },
    thu: { enabled: true, start: '09:00', end: '18:00' },
    fri: { enabled: true, start: '09:00', end: '18:00' },
    sat: { enabled: false, start: '09:00', end: '18:00' },
    sun: { enabled: false, start: '09:00', end: '18:00' },
});

function httpError(statusCode, message, code = null) {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (code) error.code = code;
    return error;
}

function normalizeTime(value, fieldName) {
    const text = String(value || '').trim();
    if (!/^\d{2}:\d{2}$/.test(text)) {
        throw httpError(400, `${fieldName} must use HH:MM format`, 'INVALID_TIME_FORMAT');
    }
    const [hour, minute] = text.split(':').map(Number);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        throw httpError(400, `${fieldName} must be a valid 24h time`, 'INVALID_TIME_VALUE');
    }
    return text;
}

function normalizeTimezone(value) {
    const timezone = String(value || 'UTC').trim() || 'UTC';
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    } catch (_) {
        throw httpError(400, 'hotelTimezone must be a valid IANA timezone', 'INVALID_TIMEZONE');
    }
    return timezone;
}

function normalizeWorkingHours(value) {
    const raw = parseJson(value, DEFAULT_WORKING_HOURS);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw httpError(400, 'hotelWorkingHours must be an object', 'INVALID_WORKING_HOURS');
    }

    for (const key of Object.keys(raw)) {
        if (!DAY_KEYS.includes(key)) {
            throw httpError(400, `Unsupported working hours day: ${key}`, 'INVALID_WORKING_DAY');
        }
    }

    const normalized = {};
    for (const day of DAY_KEYS) {
        const source = raw[day] && typeof raw[day] === 'object'
            ? raw[day]
            : DEFAULT_WORKING_HOURS[day];
        normalized[day] = {
            enabled: source.enabled === undefined ? true : Boolean(source.enabled),
            start: normalizeTime(source.start || DEFAULT_WORKING_HOURS[day].start, `${day}.start`),
            end: normalizeTime(source.end || DEFAULT_WORKING_HOURS[day].end, `${day}.end`),
        };
    }
    return normalized;
}

function normalizeSipAliases(value) {
    const raw = Array.isArray(value)
        ? value
        : String(value || '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    const seen = new Set();
    const aliases = [];
    for (const item of raw) {
        const normalized = String(item || '').replace(/\D+/g, '');
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        aliases.push(normalized);
    }
    return aliases;
}

function sanitizeSafeMessage(text) {
    if (!text) return null;
    return redact(text, 500)
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED_AUTH]')
        .replace(/([?&](?:token|password|secret|api[_-]?key)=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(/\b(?:password|passwd|apiKey|token|secret)["']?\s*[:=]\s*["']?[^"',\s}]+/gi, 'secret: [REDACTED]')
        .replace(/at\s+.*:\d+:\d+/g, '') // remove stack trace lines
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500) || null;
}

// A checkpoint is operational state, never a credential store. Also cleans
// checkpoints written by the pre-fix worker when they are loaded for retry.
function safeCheckpoint(value) {
    if (Array.isArray(value)) return value.map(safeCheckpoint);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/^(api[_-]?key|(?:(?:access|refresh|login|bootstrap)[_-]?)?token|password|(?:webhook[_-]?)?secret|credentials|authorization|dedicatedKey)$/i.test(key))
        .map(([key, item]) => [key, safeCheckpoint(item)]));
}

class BusinessProvisioningStore {
    sanitizeLegacyCheckpoints({ knowledgeOnly = false } = {}) {
        DB.db.transaction(() => {
            const scope = knowledgeOnly ? " WHERE module IN ('knowledge_base','onyx_runtime')" : '';
            for (const row of DB.all(`SELECT id,checkpointJson FROM business_provisioning_jobs${scope}`)) {
                const sanitized = JSON.stringify(safeCheckpoint(parseJson(row.checkpointJson, {})));
                if (sanitized !== row.checkpointJson) DB.run('UPDATE business_provisioning_jobs SET checkpointJson=? WHERE id=?', [sanitized, row.id]);
            }
        }).immediate();
    }
    /**
     * Atomically create business instance, dedicate knowledge scope,
     * register SIP aliases without race condition, enqueue module provisioning jobs,
     * and record idempotency key in ONE local SQLite transaction.
     */
    createBusinessAtomic(data = {}, options = {}) {
        const Identity = require('../identity/identity-store');
        if (options.ownerUserId) Identity.ensureSchema();
        const name = String(data.name || '').trim();
        if (!name) throw httpError(400, 'name is required', 'NAME_REQUIRED');

        const idempotencyKey = options.idempotencyKey ? String(options.idempotencyKey).trim() : null;
        const requestHash = idempotencyKey
            ? crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex')
            : null;

        const businessType = ['hotel', 'standard', 'coffee_shop'].includes(data.businessType)
            ? data.businessType
            : 'hotel';
        const salesGoal = businessType === 'coffee_shop'
            ? 'coffee_pickup'
            : (data.salesGoal || 'call');
        const timezone = normalizeTimezone(data.hotelTimezone ?? data.timezone ?? 'UTC');
        const workingHours = JSON.stringify(normalizeWorkingHours(data.hotelWorkingHours ?? data.workingHours));
        const aliases = normalizeSipAliases(data.sipAliases ?? data.sip_aliases ?? []);

        const transaction = DB.db.transaction(() => {
            // 1. Check idempotency key if provided
            if (idempotencyKey) {
                const existingKey = DB.get(
                    'SELECT * FROM business_idempotency_keys WHERE idempotencyKey = ?',
                    [idempotencyKey]
                );
                if (existingKey) {
                    if (existingKey.requestHash === requestHash) {
                        const existingInstance = DB.get(
                            'SELECT * FROM instances WHERE id = ?',
                            [existingKey.businessId]
                        );
                        if (existingInstance) {
                            if (options.ownerUserId) Identity.authorizeBusiness(Identity.actor(options.ownerUserId), existingInstance.id, { owner: true });
                            return {
                                instance: existingInstance,
                                isExisting: true,
                                idempotencyKey,
                            };
                        }
                    } else {
                        throw httpError(
                            409,
                            `Idempotency key "${idempotencyKey}" already used with different payload`,
                            'IDEMPOTENCY_KEY_MISMATCH'
                        );
                    }
                }
            }

            // Idempotent replay returns the existing business before checking new bindings.
            const rawAliases=data.sipAliases ?? data.sip_aliases ?? [];
            require('../telephony/store').protectProfile(null, {sipAliases:Array.isArray(rawAliases)?rawAliases:String(rawAliases).split(','),
                sipCallerId:data.sipCallerId,sipTrunkNumber:data.sipTrunkNumber});
            require('../telephony/store').protectProfile(null, {sipAliases:aliases,
                sipCallerId:data.sipCallerId,sipTrunkNumber:data.sipTrunkNumber});

            // 2. Atomically verify SIP aliases against active businesses
            for (const alias of aliases) {
                const existingAlias = DB.get(`
                    SELECT s.businessId, i.name AS businessName, i.isActive
                    FROM business_sip_aliases s
                    JOIN instances i ON i.id = s.businessId
                    WHERE s.alias = ? AND i.isActive = 1
                `, [alias]);

                if (existingAlias) {
                    throw httpError(
                        409,
                        `sip alias ${alias} already belongs to hotel profile ${existingAlias.businessId}`,
                        'SIP_ALIAS_CONFLICT'
                    );
                }
            }

            // 3. Insert normalized business instance into `instances` in one shot
            const voiceAiProvider = normalizeVoiceProvider(options.voicePatch?.voiceAiProvider ?? data.voiceAiProvider ?? data.aiProvider ?? data.ai_provider ?? null);
            const voiceName = options.voicePatch?.voiceName ?? data.voiceName ?? data.voice ?? null;
            const voiceModel = options.voicePatch?.voiceModel || null;
            const voiceSettings = options.voicePatch?.voiceSettings || '{}';
            if (!options.voicePatch && (data.voiceSettings !== undefined || data.voiceModel !== undefined || data.voiceAmbient !== undefined || voiceName)) {
                throw httpError(400, 'Voice selections require catalog validation', 'VOICE_VALIDATION_REQUIRED');
            }

            const insertStmt = DB.db.prepare(`
                INSERT INTO instances (
                    name, businessType, salesGoal,
                    hotelTone, hotelTimezone, hotelWorkingHours,
                    sipTrunkNumber, sipCallerId, sipAliases,
                    voiceContextName, voiceAiProvider, voiceName, voiceModel, voiceSettings, voiceAmbient,
                    voiceGreetingTemplate, outboundOpenerTemplate,
                    isActive, createdAt, updatedAt
                ) VALUES (
                    ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, ?,
                    1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
            `);

            const insertResult = insertStmt.run(
                name,
                businessType,
                salesGoal,
                options.voicePatch?.hotelTone ?? (data.hotelTone ? String(data.hotelTone).trim() : null),
                timezone,
                workingHours,
                data.sipTrunkNumber ? String(data.sipTrunkNumber).trim() : null,
                data.sipCallerId ? String(data.sipCallerId).trim() : null,
                JSON.stringify(aliases),
                data.voiceContextName ? String(data.voiceContextName).trim() : 'unified_sales_agent',
                voiceAiProvider ? String(voiceAiProvider).trim() : null,
                voiceName ? String(voiceName).trim() : null,
                voiceModel,
                voiceSettings,
                options.voicePatch?.voiceAmbient ?? null,
                data.voiceGreetingTemplate ? String(data.voiceGreetingTemplate).trim() : null,
                data.outboundOpenerTemplate ? String(data.outboundOpenerTemplate).trim() : null
            );

            const businessId = Number(insertResult.lastInsertRowid);
            if (options.ownerUserId) Identity.attachBusinessOwner(options.ownerUserId, businessId);
            if (process.env.AVA_ISOLATED_MODULES_ENABLED === 'true') {
                require('./deployment-store').requestForBusiness(businessId, name);
            }

            // Knowledge is owned by the new business; never accept a donor scope.
            const requestedKnowledgeBaseId = data.knowledgeBaseInstanceId ?? data.knowledge_base_instance_id;
            const targetKbId = (requestedKnowledgeBaseId !== undefined && requestedKnowledgeBaseId !== null && requestedKnowledgeBaseId !== '')
                ? Number(requestedKnowledgeBaseId)
                : businessId;
            if (targetKbId !== businessId) throw httpError(400, 'Knowledge scope must match the new business', 'ONYX_KNOWLEDGE_SCOPE_MISMATCH');

            DB.run(
                'UPDATE instances SET knowledgeBaseInstanceId = ? WHERE id = ?',
                [targetKbId, businessId]
            );

            // 4. Register SIP aliases atomically in `business_sip_aliases`
            for (const alias of aliases) {
                DB.run(
                    'INSERT OR REPLACE INTO business_sip_aliases (alias, businessId) VALUES (?, ?)',
                    [alias, businessId]
                );
            }

            // 5. Enqueue module provisioning jobs in `business_provisioning_jobs`
            const defaultModules = [
                {
                    module: 'knowledge_base',
                    stage: 'init',
                    status: 'PENDING',
                    dependsOnModule: null,
                    userNextStep: 'Загрузите документы отеля в базу знаний',
                },
                {
                    module: 'crm_workspace',
                    stage: 'workspace_create',
                    status: 'PENDING',
                    dependsOnModule: null,
                    userNextStep: 'Настройка рабочего пространства Twenty CRM',
                },
                {
                    module: 'onyx_runtime',
                    stage: 'agent_bind',
                    status: 'PENDING',
                    dependsOnModule: 'knowledge_base',
                    userNextStep: 'Подключение контура знаний Onyx',
                },
                {
                    module: 'telephony_sip',
                    stage: 'verify',
                    status: 'PENDING',
                    dependsOnModule: null,
                    userNextStep: (data.sipTrunkNumber || aliases.length)
                        ? 'Проверка SIP-маршрутизации'
                        : 'Укажите номер транка или SIP-алиас',
                },
                {
                    module: 'whatsapp',
                    stage: 'session_init',
                    status: 'PENDING',
                    dependsOnModule: null,
                    userNextStep: 'Подключите WhatsApp сессию по QR-коду',
                },
            ];

            if (data.pms || data.pmsProvider) {
                defaultModules.push({
                    module: 'pms',
                    stage: 'init',
                    status: 'PENDING',
                    dependsOnModule: null,
                    userNextStep: 'Проверка подключения к PMS',
                });
            }

            for (const job of defaultModules) {
                DB.run(`
                    INSERT INTO business_provisioning_jobs (
                        businessId, module, stage, status,
                        dependsOnModule, userNextStep, checkpointJson
                    ) VALUES (?, ?, ?, ?, ?, ?, '{}')
                `, [
                    businessId,
                    job.module,
                    job.stage,
                    job.status,
                    job.dependsOnModule,
                    job.userNextStep,
                ]);
            }

            // 6. Record idempotency key if provided
            if (idempotencyKey) {
                DB.run(`
                    INSERT INTO business_idempotency_keys (
                        idempotencyKey, businessId, requestHash
                    ) VALUES (?, ?, ?)
                `, [idempotencyKey, businessId, requestHash]);
            }

            const instance = DB.get('SELECT * FROM instances WHERE id = ?', [businessId]);
            return {
                instance,
                isExisting: false,
                idempotencyKey,
            };
        });

        return transaction.immediate();
    }

    /**
     * Atomically update SIP aliases of an existing business with conflict checks.
     */
    updateBusinessSipAliasesAtomic(businessId, newAliases = []) {
        const id = Number(businessId);
        const aliases = normalizeSipAliases(newAliases);
        require('../telephony/store').protectProfile(id, {sipAliases:aliases});

        const transaction = DB.db.transaction(() => {
            require('../telephony/store').protectProfile(id, {sipAliases:Array.isArray(newAliases)?newAliases:String(newAliases).split(',')});
            require('../telephony/store').protectProfile(id, {sipAliases:aliases});
            const current = DB.get('SELECT id, isActive FROM instances WHERE id = ?', [id]);
            if (!current) throw httpError(404, 'hotel profile not found', 'NOT_FOUND');

            for (const alias of aliases) {
                const conflict = DB.get(`
                    SELECT s.businessId
                    FROM business_sip_aliases s
                    JOIN instances i ON i.id = s.businessId
                    WHERE s.alias = ? AND s.businessId != ? AND i.isActive = 1
                `, [alias, id]);

                if (conflict) {
                    throw httpError(
                        409,
                        `sip alias ${alias} already belongs to hotel profile ${conflict.businessId}`,
                        'SIP_ALIAS_CONFLICT'
                    );
                }
            }

            DB.run('DELETE FROM business_sip_aliases WHERE businessId = ?', [id]);
            for (const alias of aliases) {
                DB.run(
                    'INSERT OR REPLACE INTO business_sip_aliases (alias, businessId) VALUES (?, ?)',
                    [alias, id]
                );
            }
            DB.run('UPDATE instances SET sipAliases = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [
                JSON.stringify(aliases),
                id,
            ]);
            return aliases;
        });

        return transaction.immediate();
    }

    /**
     * Atomically lease pending jobs whose lease is expired or ready to execute.
     * Recover stale LEASED jobs whose leasedUntil has passed.
     */
    leaseJobs(limit = 5, ttlSeconds = 60, { knowledgeOnly = false } = {}) {
        ttlSeconds = Math.max(5, Math.min(Number(ttlSeconds) || 60, 900));
        // Apply the same fixed scope to recovery and failure transitions as
        // leasing. A knowledge-only worker must not mutate other module jobs.
        const scope = knowledgeOnly ? " AND module IN ('knowledge_base','onyx_runtime')" : '';
        const jobScope = knowledgeOnly ? " AND j.module IN ('knowledge_base','onyx_runtime')" : '';
        const transaction = DB.db.transaction(() => {
            // Stale lease recovery
            DB.run(`
                UPDATE business_provisioning_jobs
                SET status = 'PENDING',
                    leaseToken = NULL,
                    leasedUntil = NULL,
                    updatedAt = CURRENT_TIMESTAMP
                WHERE status = 'LEASED'
                  AND leasedUntil IS NOT NULL
                  AND datetime(leasedUntil) <= datetime('now')
                  ${scope}
            `);

            // Crashes consume the same bounded attempt budget as ordinary
            // failures. Recovery must not create an infinite dial/setup loop.
            DB.run(`UPDATE business_provisioning_jobs
                SET status='FAILED', leaseToken=NULL, leasedUntil=NULL,
                    lastErrorCode='PROVISIONING_ATTEMPTS_EXHAUSTED',
                    lastErrorMessage='Исчерпаны попытки подключения после прерывания работы',
                    userNextStep='Проверьте подключение и повторите настройку',
                    updatedAt=CURRENT_TIMESTAMP
                WHERE status='PENDING' AND attempts >= maxAttempts${scope}`);
            DB.run(`UPDATE business_provisioning_jobs AS j
                SET status='BLOCKED', lastErrorCode='DEPENDENCY_FAILED',
                    userNextStep='Сначала восстановите зависимый модуль', updatedAt=CURRENT_TIMESTAMP
                WHERE j.status='PENDING'${jobScope} AND EXISTS (
                    SELECT 1 FROM business_provisioning_jobs dep
                    WHERE dep.businessId=j.businessId AND dep.module=j.dependsOnModule
                        AND dep.status IN ('FAILED','BLOCKED'))`);

            // Find eligible pending jobs:
            // 1. status = 'PENDING'
            // 2. nextAttemptAt <= now
            // 3. no unmet dependencies (dependsOnModule is NULL or dependent module is DONE)
            const rows = DB.all(`
                SELECT j.*
                FROM business_provisioning_jobs j
                JOIN instances i ON i.id = j.businessId
                WHERE j.status = 'PENDING'
                  ${jobScope}
                  AND j.attempts < j.maxAttempts
                  AND i.isActive = 1
                  AND datetime(j.nextAttemptAt) <= datetime('now')
                  AND (
                    j.dependsOnModule IS NULL
                    OR EXISTS (
                        SELECT 1 FROM business_provisioning_jobs dep
                        WHERE dep.businessId = j.businessId
                          AND dep.module = j.dependsOnModule
                          AND dep.status = 'DONE'
                    )
                  )
                ORDER BY datetime(j.createdAt), j.id
                LIMIT ?
            `, [Math.max(1, Math.min(Number(limit) || 5, 50))]);

            const leased = [];
            for (const row of rows) {
                const leaseToken = crypto.randomUUID();
                const updateRes = DB.run(`
                    UPDATE business_provisioning_jobs
                    SET status = 'LEASED',
                        leaseToken = ?,
                        leasedUntil = datetime('now', '+' || ? || ' seconds'),
                        attempts = attempts + 1,
                        updatedAt = CURRENT_TIMESTAMP
                    WHERE id = ? AND status = 'PENDING' AND attempts < maxAttempts
                `, [leaseToken, ttlSeconds, row.id]);

                if (updateRes.changes > 0) {
                    row.leaseToken = leaseToken;
                    row.status = 'LEASED';
                    row.attempts = Number(row.attempts || 0) + 1;
                    leased.push(row);
                }
            }
            return leased;
        });

        return transaction.immediate();
    }

    /**
     * Atomically complete or fail a leased job.
     */
    finishJob(jobId, leaseToken, result = {}) {
        const transaction = DB.db.transaction(() => {
            const job = DB.get(`SELECT j.* FROM business_provisioning_jobs j
                JOIN instances i ON i.id = j.businessId
                WHERE j.id = ? AND i.isActive = 1
                  AND datetime(j.leasedUntil) > datetime('now')`, [jobId]);
            if (!job || job.status !== 'LEASED' || job.leaseToken !== leaseToken) {
                return false;
            }

            const targetStatus = result.status || 'DONE';
            const checkpointJson = JSON.stringify(safeCheckpoint(result.checkpoint || parseJson(job.checkpointJson, {})));

            if (targetStatus === 'BLOCKED') {
                DB.run(`UPDATE business_provisioning_jobs SET status='BLOCKED',stage=?,checkpointJson=?,
                    lastErrorCode=?,lastErrorMessage=?,userNextStep=?,leaseToken=NULL,leasedUntil=NULL,updatedAt=CURRENT_TIMESTAMP
                    WHERE id=? AND leaseToken=?`, [result.stage || 'awaiting_setup', checkpointJson,
                    result.errorCode || 'MODULE_SETUP_REQUIRED', sanitizeSafeMessage(result.errorMessage),
                    result.userNextStep || 'Ожидает настройки платформой AVA', jobId, leaseToken]);
                return true;
            }

            if (targetStatus === 'DONE' || targetStatus === 'SKIPPED') {
                DB.run(`
                    UPDATE business_provisioning_jobs
                    SET status = ?,
                        stage = ?,
                        checkpointJson = ?,
                        userNextStep = ?,
                        leaseToken = NULL,
                        leasedUntil = NULL,
                        lastErrorCode = NULL,
                        lastErrorMessage = NULL,
                        updatedAt = CURRENT_TIMESTAMP
                    WHERE id = ? AND leaseToken = ?
                `, [
                    targetStatus,
                    result.stage || job.stage || 'ready',
                    checkpointJson,
                    result.userNextStep || null,
                    jobId,
                    leaseToken,
                ]);

                // A preserved/unverified or missing module is not a completed
                // prerequisite. Only actual completion releases dependent jobs.
                if (targetStatus === 'DONE') DB.run(`
                    UPDATE business_provisioning_jobs
                    SET status = 'PENDING',
                        updatedAt = CURRENT_TIMESTAMP
                    WHERE businessId = ?
                      AND dependsOnModule = ?
                      AND status = 'BLOCKED'
                `, [job.businessId, job.module]);

                return true;
            }

            // Failure handling with backoff or permanent failure
            const retryable = result.retryable !== false;
            const attempts = Number(job.attempts || 1);
            const maxAttempts = Number(job.maxAttempts || 5);
            const lastErrorCode = result.errorCode || 'PROVISIONING_FAILED';
            const lastErrorMessage = sanitizeSafeMessage(result.errorMessage || 'Module provisioning failed');
            const userNextStep = result.userNextStep || 'Повторите подключение модуля или проверьте настройки';

            if (retryable && attempts < maxAttempts) {
                const backoffBase = Number(job.backoffSeconds || 5);
                // Isolated deployment retries have their own durable backoff.
                // Do not spend the parent job's attempts while that lease is
                // intentionally not due yet. The hint is internal, bounded and
                // can only increase (never shorten) the normal retry delay.
                const retryDelay = Number.isSafeInteger(result.retryAt)
                    ? Math.max(0, Math.min(3600, Math.ceil((result.retryAt - Date.now()) / 1000))) : 0;
                const delaySeconds = Math.max(retryDelay, Math.min(backoffBase * (2 ** Math.max(0, attempts - 1)), 300));

                DB.run(`
                    UPDATE business_provisioning_jobs
                    SET status = 'PENDING',
                        stage = ?,
                        nextAttemptAt = datetime('now', '+' || ? || ' seconds'),
                        checkpointJson = ?,
                        lastErrorCode = ?,
                        lastErrorMessage = ?,
                        userNextStep = ?,
                        leaseToken = NULL,
                        leasedUntil = NULL,
                        updatedAt = CURRENT_TIMESTAMP
                    WHERE id = ? AND leaseToken = ?
                `, [
                    result.stage || job.stage,
                    delaySeconds,
                    checkpointJson,
                    lastErrorCode,
                    lastErrorMessage,
                    userNextStep,
                    jobId,
                    leaseToken,
                ]);
            } else {
                DB.run(`
                    UPDATE business_provisioning_jobs
                    SET status = 'FAILED',
                        stage = ?,
                        checkpointJson = ?,
                        lastErrorCode = ?,
                        lastErrorMessage = ?,
                        userNextStep = ?,
                        leaseToken = NULL,
                        leasedUntil = NULL,
                        updatedAt = CURRENT_TIMESTAMP
                    WHERE id = ? AND leaseToken = ?
                `, [
                    result.stage || job.stage,
                    checkpointJson,
                    lastErrorCode,
                    lastErrorMessage,
                    userNextStep,
                    jobId,
                    leaseToken,
                ]);

                // Mark dependent jobs as BLOCKED
                DB.run(`
                    UPDATE business_provisioning_jobs
                    SET status = 'BLOCKED',
                        lastErrorCode = 'DEPENDENCY_FAILED',
                        lastErrorMessage = 'Заблокировано: сбой зависимого модуля ' || ?,
                        userNextStep = 'Требуется исправить сбой модуля ' || ?,
                        updatedAt = CURRENT_TIMESTAMP
                    WHERE businessId = ?
                      AND dependsOnModule = ?
                      AND status IN ('PENDING', 'LEASED')
                `, [job.module, job.module, job.businessId, job.module]);
            }

            return true;
        });

        return transaction.immediate();
    }

    /**
     * Atomically update a job's checkpoint JSON in the database.
     * Used by provisioners to persist intermediate checkpoints across crash boundaries (R4).
     */
    updateJobCheckpoint(jobId, leaseToken, checkpoint) {
        const checkpointJson = JSON.stringify(safeCheckpoint(checkpoint || {}));
        const updated = DB.run(`
            UPDATE business_provisioning_jobs
            SET checkpointJson = ?, updatedAt = CURRENT_TIMESTAMP
            WHERE id = ? AND leaseToken = ? AND status = 'LEASED'
              AND datetime(leasedUntil) > datetime('now')
              AND EXISTS (SELECT 1 FROM instances i WHERE i.id = businessId AND i.isActive = 1)
        `, [checkpointJson, jobId, leaseToken]);
        if (!updated.changes) {
            throw httpError(409, 'Provisioning lease is no longer owned by this worker', 'PROVISIONING_LEASE_LOST');
        }
        return updated;
    }

    renewLease(jobId, leaseToken, ttlSeconds = 60) {
        return DB.run(`UPDATE business_provisioning_jobs
            SET leasedUntil = datetime('now', '+' || ? || ' seconds')
            WHERE id = ? AND leaseToken = ? AND status = 'LEASED'
              AND datetime(leasedUntil) > datetime('now')
              AND EXISTS (SELECT 1 FROM instances i WHERE i.id = businessId AND i.isActive = 1)`,
        [ttlSeconds, jobId, leaseToken]).changes === 1;
    }

    /**
     * Manual retry for failed or blocked provisioning jobs without creating a duplicate business.
     */
    retryJobs(businessId, { module = null } = {}) {
        const id = Number(businessId);
        const transaction = DB.db.transaction(() => {
            const instance = DB.get('SELECT id FROM instances WHERE id = ? AND isActive=1', [id]);
            if (!instance) throw httpError(404, 'business not found', 'NOT_FOUND');

            let query = `
                UPDATE business_provisioning_jobs
                SET status = 'PENDING',
                    attempts = 0,
                    nextAttemptAt = CURRENT_TIMESTAMP,
                    leaseToken = NULL,
                    leasedUntil = NULL,
                    lastErrorCode = NULL,
                    lastErrorMessage = NULL,
                    updatedAt = CURRENT_TIMESTAMP
                WHERE businessId = ?
                  AND status IN ('FAILED', 'BLOCKED', 'SKIPPED')
            `;
            const params = [id];

            if (module) {
                query += ' AND module = ?';
                params.push(String(module));
            }

            const result = DB.run(query, params);
            return result.changes;
        });

        return transaction.immediate();
    }

    /**
     * Get sanitized, safe provisioning status for API without credentials or traceback.
     */
    getProvisioningStatus(businessId) {
        const id = Number(businessId);
        const instance = DB.get('SELECT id, name, createdAt, updatedAt FROM instances WHERE id = ?', [id]);
        if (!instance) return null;

        const jobs = DB.all(`
            SELECT id, businessId, module, stage, status, attempts, maxAttempts, nextAttemptAt,
                   lastErrorCode, lastErrorMessage, userNextStep,
                   createdAt, updatedAt
            FROM business_provisioning_jobs
            WHERE businessId = ?
            ORDER BY id ASC
        `, [id]);

        if (jobs.length === 0) {
            return {
                businessId: id,
                businessName: instance.name,
                overallStatus: 'unconfigured',
                progressPercent: 0,
                modules: {},
                nextStep: 'Запустите первичную настройку бизнеса',
                createdAt: instance.createdAt,
                updatedAt: instance.updatedAt,
            };
        }

        let doneCount = 0;
        let skippedCount = 0;
        let failedCount = 0;
        let pendingCount = 0;
        let leasedCount = 0;
        let blockedCount = 0;

        const modules = {};
        let firstIncompleteNextStep = null;

        for (const job of jobs) {
            if (job.status === 'DONE') doneCount += 1;
            else if (job.status === 'SKIPPED') skippedCount += 1;
            else if (job.status === 'FAILED') failedCount += 1;
            else if (job.status === 'BLOCKED') blockedCount += 1;
            else if (job.status === 'LEASED') leasedCount += 1;
            else pendingCount += 1;

            if (job.status !== 'DONE' && !firstIncompleteNextStep && job.userNextStep) {
                firstIncompleteNextStep = job.userNextStep;
            }

            let progress = 0;
            if (job.status === 'DONE') progress = 100;
            else if (job.status === 'SKIPPED') progress = 0;
            else if (job.status === 'LEASED') progress = 50;
            else if (job.status === 'PENDING') progress = job.attempts > 0 ? 30 : 10;
            else progress = 0;

            modules[job.module] = {
                status: job.status,
                stage: job.stage,
                progress,
                attempts: job.attempts,
                maxAttempts: job.maxAttempts,
                nextAttemptAt: job.status === 'PENDING' ? job.nextAttemptAt : null,
                userNextStep: job.userNextStep || null,
                error: sanitizeSafeMessage(job.lastErrorMessage),
                errorCode: job.lastErrorCode || null,
                configured: job.status === 'DONE' || job.stage === 'requires_verification',
                verified: job.status === 'DONE',
                allowedActions: ['FAILED', 'BLOCKED', 'SKIPPED'].includes(job.status) ? ['retry'] : [],
                updatedAt: job.updatedAt,
            };
        }

        const totalCount = jobs.length;
        // Progress percent strictly reflects completed modules, avoiding false 100% when modules are skipped (R2)
        const progressPercent = Math.round((doneCount / totalCount) * 100);

        let overallStatus = 'in_progress';
        if (doneCount === totalCount) {
            overallStatus = 'ready';
        } else if (pendingCount > 0 || leasedCount > 0) {
            overallStatus = doneCount > 0 ? 'partially_ready' : 'in_progress';
        } else if (failedCount > 0) {
            overallStatus = doneCount > 0 ? 'partially_ready' : 'failed';
        } else if (skippedCount > 0 && doneCount > 0) {
            overallStatus = 'partially_ready';
        } else if (skippedCount === totalCount) {
            overallStatus = 'unconfigured';
        } else {
            overallStatus = doneCount > 0 ? 'partially_ready' : 'in_progress';
        }

        return {
            businessId: id,
            businessName: instance.name,
            overallStatus,
            progressPercent,
            modules,
            deployments: require('./deployment-store').list(id),
            nextStep: firstIncompleteNextStep || (overallStatus === 'ready' ? null : 'Завершите настройку неподключенных модулей'),
            createdAt: instance.createdAt,
            updatedAt: instance.updatedAt,
        };
    }
}

module.exports = new BusinessProvisioningStore();
module.exports._internals = {
    DAY_KEYS,
    DEFAULT_WORKING_HOURS,
    normalizeTime,
    normalizeTimezone,
    normalizeWorkingHours,
    normalizeSipAliases,
    sanitizeSafeMessage,
    safeCheckpoint,
};
