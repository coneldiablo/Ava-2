const crypto = require('crypto');
const DB = require('../database.service');
const { redact } = require('../pms/pms-utils');

function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function now() { return new Date().toISOString(); }
function plusSeconds(seconds) { return new Date(Date.now() + (seconds * 1000)).toISOString(); }
function leaseSeconds(value) { return Math.max(1, Math.min(Number(value) || 120, 3600)); }
function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

class TwentyStore {
    businessId(value) {
        const businessId = Number(value);
        if (!Number.isInteger(businessId) || businessId < 1) {
            const error = new Error('business_id is required');
            error.code = 'TWENTY_BUSINESS_SCOPE_REQUIRED';
            error.statusCode = 400;
            throw error;
        }
        if (!DB.get('SELECT id FROM instances WHERE id = ?', [businessId])) {
            const error = new Error('Business not found');
            error.code = 'TWENTY_BUSINESS_NOT_FOUND';
            error.statusCode = 404;
            throw error;
        }
        return businessId;
    }

    getIntegration(businessId) {
        businessId = this.businessId(businessId);
        return DB.get('SELECT * FROM twenty_workspace_links WHERE businessId = ?', [businessId]);
    }

    getIntegrationUnsafe(businessId) {
        return DB.get('SELECT * FROM twenty_workspace_links WHERE businessId = ?', [Number(businessId)]);
    }

    listEnabledIntegrations() {
        return DB.all(`SELECT t.*, i.name AS businessName
            FROM twenty_workspace_links t
            JOIN instances i ON i.id = t.businessId
            WHERE t.enabled = 1 AND i.isActive=1
            ORDER BY t.businessId`);
    }

    findByWebhookTokenHash(tokenHash) {
        return DB.get('SELECT * FROM twenty_workspace_links WHERE webhookTokenHash = ?', [String(tokenHash || '')]);
    }

    upsertIntegration(businessId, data = {}) {
        businessId = this.businessId(businessId);
        const existing = this.getIntegrationUnsafe(businessId);
        const integrationId = existing?.id || id('twenty');
        try {
            DB.run(`INSERT INTO twenty_workspace_links (
                id, businessId, workspaceId, baseUrl, apiKeyEncrypted,
                webhookSecretEncrypted, webhookTokenHash, webhookTokenEncrypted,
                enabled, mode, connectionStatus, mappingsJson, lastSyncAt,
                lastSuccessAt, lastWebhookAt, lastErrorCode, lastErrorMessage, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(businessId) DO UPDATE SET
                workspaceId=excluded.workspaceId, baseUrl=excluded.baseUrl,
                apiKeyEncrypted=excluded.apiKeyEncrypted,
                webhookSecretEncrypted=excluded.webhookSecretEncrypted,
                webhookTokenHash=excluded.webhookTokenHash,
                webhookTokenEncrypted=excluded.webhookTokenEncrypted,
                enabled=excluded.enabled, mode=excluded.mode,
                connectionStatus=excluded.connectionStatus,
                mappingsJson=excluded.mappingsJson, lastSyncAt=excluded.lastSyncAt,
                lastSuccessAt=excluded.lastSuccessAt, lastWebhookAt=excluded.lastWebhookAt,
                lastErrorCode=excluded.lastErrorCode, lastErrorMessage=excluded.lastErrorMessage,
                updatedAt=CURRENT_TIMESTAMP`, [
                integrationId,
                businessId,
                data.workspaceId ?? existing?.workspaceId ?? null,
                data.baseUrl || existing?.baseUrl,
                data.apiKeyEncrypted || existing?.apiKeyEncrypted || '',
                data.webhookSecretEncrypted ?? existing?.webhookSecretEncrypted ?? null,
                data.webhookTokenHash ?? existing?.webhookTokenHash ?? null,
                data.webhookTokenEncrypted ?? existing?.webhookTokenEncrypted ?? null,
                data.enabled ? 1 : 0,
                ['shadow', 'live'].includes(data.mode) ? data.mode : (existing?.mode || 'shadow'),
                data.connectionStatus || existing?.connectionStatus || 'not_tested',
                JSON.stringify(data.mappings || parseJson(existing?.mappingsJson, {})),
                data.lastSyncAt ?? existing?.lastSyncAt ?? null,
                data.lastSuccessAt ?? existing?.lastSuccessAt ?? null,
                data.lastWebhookAt ?? existing?.lastWebhookAt ?? null,
                data.lastErrorCode ?? null,
                redact(data.lastErrorMessage || '', 500) || null,
            ]);
        } catch (error) {
            if (String(error.message).includes('workspaceId')) {
                error.code = 'TWENTY_WORKSPACE_ALREADY_LINKED';
                error.statusCode = 409;
            }
            throw error;
        }
        return this.getIntegrationUnsafe(businessId);
    }

    updateStatus(businessId, patch = {}, { expectedRevision = null } = {}) {
        return DB.db.transaction(() => {
            const current = this.getIntegration(businessId);
            if (!current || (expectedRevision !== null && current.revision !== expectedRevision)) {
                throw Object.assign(new Error('Подключение CRM изменилось; повторите проверку'), {
                    code: 'TWENTY_CONFIGURATION_CHANGED', statusCode: 409,
                });
            }
            return this.upsertIntegration(businessId, {
                ...current, ...patch,
                mappings: patch.mappings || parseJson(current.mappingsJson, {}),
                enabled: patch.enabled == null ? Boolean(current.enabled) : Boolean(patch.enabled),
            });
        }).immediate();
    }

    deleteIntegration(businessId) {
        businessId = this.businessId(businessId);
        const transaction = DB.db.transaction(() => {
            DB.run('DELETE FROM twenty_sync_outbox WHERE businessId = ?', [businessId]);
            DB.run('DELETE FROM twenty_webhook_inbox WHERE businessId = ?', [businessId]);
            DB.run('DELETE FROM twenty_record_links WHERE businessId = ?', [businessId]);
            return DB.run('DELETE FROM twenty_workspace_links WHERE businessId = ?', [businessId]).changes > 0;
        });
        return transaction.immediate();
    }

    enqueue(businessId, entityType, sourceTable, sourceId, operation = 'upsert') {
        businessId = this.businessId(businessId);
        const eventId = id('twout');
        DB.run(`INSERT INTO twenty_sync_outbox (
            eventId, businessId, entityType, sourceTable, sourceId,
            operation, payloadJson, status, nextAttemptAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', CURRENT_TIMESTAMP)`, [
            eventId, businessId, entityType, sourceTable, String(sourceId), operation,
            JSON.stringify({ source_table: sourceTable, source_id: String(sourceId) }),
        ]);
        return DB.get('SELECT * FROM twenty_sync_outbox WHERE eventId = ?', [eventId]);
    }

    enqueueInitialSync(businessId, onEnqueued = () => {}) {
        businessId = this.businessId(businessId);
        const sources = [
            ['hotel', 'instances', 'id', 'id'],
            ['person', 'clients', 'id', 'instanceId'],
            ['manager_task', 'manager_tasks', 'taskId', 'instanceId'],
            ['followup_draft', 'followup_drafts', 'draftId', 'instanceId'],
            ['outbound_campaign', 'outbound_campaigns', 'campaignId', 'instanceId'],
            ['outbound_lead', 'outbound_leads', 'leadId', 'instanceId'],
            ['outbound_attempt', 'outbound_attempts', 'attemptId', 'instanceId'],
            ['booking_request', 'pms_booking_requests', 'id', 'businessId'],
        ];
        const transaction = DB.db.transaction(() => {
            let queued = 0;
            for (const [entityType, table, idColumn, scopeColumn] of sources) {
                for (const row of DB.all(`SELECT ${idColumn} AS sourceId FROM ${table} WHERE ${scopeColumn} = ?`, [businessId])) {
                    onEnqueued(this.enqueue(businessId, entityType, table, row.sourceId));
                    queued += 1;
                }
            }
            for (const row of DB.all(`SELECT DISTINCT callId AS sourceId FROM conversation_events
                WHERE instanceId = ? AND callId IS NOT NULL AND TRIM(callId) <> ''`, [businessId])) {
                onEnqueued(this.enqueue(businessId, 'call', 'conversation_events', row.sourceId));
                queued += 1;
            }
            DB.run('UPDATE twenty_workspace_links SET lastSyncAt=CURRENT_TIMESTAMP, updatedAt=CURRENT_TIMESTAMP WHERE businessId=?', [businessId]);
            return queued;
        });
        return transaction.immediate();
    }

    queueBootstrapSync(businessId) {
        // Not a mode supplied by the public API. Only an active provisioning
        // worker can authorize specific initial projection events to a newly
        // allocated workspace; unrelated shadow events remain dry-run.
        if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') throw Object.assign(new Error('Worker required'), { code: 'TWENTY_BOOTSTRAP_WORKER_REQUIRED' });
        return DB.db.transaction(() => {
            const integration = this.getIntegration(businessId);
            const job = DB.get(`SELECT checkpointJson FROM business_provisioning_jobs
                WHERE businessId=? AND module='crm_workspace' AND status='LEASED' AND datetime(leasedUntil)>datetime('now')`, [businessId]);
            const checkpoint = parseJson(job?.checkpointJson, {});
            if (!integration?.enabled || integration.mode !== 'shadow' || !checkpoint.createRequested
                || checkpoint.workspaceId !== integration.workspaceId || !checkpoint.schemaApplied) {
                throw Object.assign(new Error('New workspace bootstrap not verified'), { code: 'TWENTY_BOOTSTRAP_NOT_AUTHORIZED' });
            }
            return this.enqueueInitialSync(businessId, event => DB.run(
                'INSERT INTO twenty_bootstrap_events(eventId,businessId,workspaceId,revision) VALUES (?,?,?,?)',
                [event.eventId, businessId, integration.workspaceId, integration.revision]));
        }).immediate();
    }

    bootstrapEvent(row, integration) {
        return DB.get('SELECT * FROM twenty_bootstrap_events WHERE eventId=? AND businessId=? AND workspaceId=? AND revision=?',
            [row.eventId, row.businessId, integration.workspaceId, integration.revision]);
    }

    bootstrapVerification(businessId) {
        const integration = this.getIntegration(businessId);
        if (!integration?.enabled || !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [businessId])) return false;
        const proof = DB.get(`SELECT COUNT(*) AS total,SUM(verifiedAt IS NOT NULL) AS verified
            FROM twenty_bootstrap_events WHERE businessId=? AND workspaceId=? AND revision=?`,
        [businessId, integration.workspaceId, integration.revision]);
        return proof.total > 0 && proof.verified === proof.total;
    }

    leaseOutbox(limit = 10, ttlSeconds = 120) {
        const transaction = DB.db.transaction(() => {
            DB.run(`UPDATE twenty_sync_outbox SET status=CASE WHEN attempts>=8 THEN 'DEAD' ELSE 'PENDING' END,
                lastErrorCode='TWENTY_SYNC_LEASE_EXPIRED', lastErrorMessage=NULL,
                nextAttemptAt=datetime('now','+30 seconds'), leaseToken=NULL, leasedUntil=NULL,
                updatedAt=CURRENT_TIMESTAMP
                WHERE status='LEASED' AND leasedUntil IS NOT NULL AND julianday(leasedUntil) <= julianday('now')`);
            const rows = DB.all(`SELECT o.* FROM twenty_sync_outbox o
                JOIN twenty_workspace_links t ON t.businessId=o.businessId
                JOIN instances i ON i.id=o.businessId
                WHERE o.status='PENDING' AND datetime(o.nextAttemptAt) <= datetime('now')
                  AND t.enabled=1 AND i.isActive=1 AND o.attempts<8
                ORDER BY datetime(o.createdAt), o.eventId LIMIT ?`, [Math.max(1, Math.min(Number(limit) || 10, 50))]);
            for (const row of rows) {
                const leaseToken = crypto.randomUUID();
                const leasedUntil = plusSeconds(leaseSeconds(ttlSeconds));
                DB.run(`UPDATE twenty_sync_outbox SET status='LEASED', leaseToken=?, leasedUntil=?, attempts=attempts+1,
                    updatedAt=CURRENT_TIMESTAMP WHERE eventId=? AND status='PENDING'`, [
                    leaseToken, leasedUntil, row.eventId,
                ]);
                row.leaseToken = leaseToken;
                row.leasedUntil = leasedUntil;
                row.attempts = Number(row.attempts || 0) + 1;
                row.status = 'LEASED';
            }
            return rows;
        });
        return transaction.immediate();
    }

    hasOutboxLease(eventId, leaseToken) {
        return Boolean(DB.get(`SELECT 1 FROM twenty_sync_outbox
            WHERE eventId=? AND status='LEASED' AND leaseToken=?
              AND julianday(leasedUntil)>julianday('now')`, [eventId, leaseToken]));
    }

    renewOutboxLease(eventId, leaseToken, ttlSeconds = 120) {
        return DB.run(`UPDATE twenty_sync_outbox SET leasedUntil=?, updatedAt=CURRENT_TIMESTAMP
            WHERE eventId=? AND status='LEASED' AND leaseToken=?
              AND julianday(leasedUntil)>julianday('now')`, [
            plusSeconds(leaseSeconds(ttlSeconds)), eventId, leaseToken,
        ]).changes === 1;
    }

    retryFailed(businessId, eventId) {
        businessId = this.businessId(businessId);
        const result = DB.run(`UPDATE twenty_sync_outbox
            SET status='PENDING',attempts=0,nextAttemptAt=CURRENT_TIMESTAMP,
                leaseToken=NULL,leasedUntil=NULL,updatedAt=CURRENT_TIMESTAMP
            WHERE businessId=? AND eventId=? AND status IN ('DEAD','FAILED')`, [businessId, String(eventId)]);
        if (result.changes) this.audit({ businessId, action: 'manual_retry', correlationId: String(eventId) });
        return result.changes > 0;
    }

    finishOutbox(eventId, leaseToken, result = {}) {
        return DB.db.transaction(() => {
            const row = DB.get(`SELECT * FROM twenty_sync_outbox WHERE eventId=? AND status='LEASED'
                AND leaseToken=? AND julianday(leasedUntil)>julianday('now')`, [eventId, leaseToken]);
            if (!row) return false;
            const status = result.status || 'DONE';
            const retryable = Boolean(result.retryable);
            const attempts = Number(row.attempts || 0);
            const terminalStatus = retryable ? (attempts < 8 ? 'PENDING' : 'DEAD') : status;
            const delaySeconds = Math.min(30 * (2 ** Math.max(0, attempts - 1)), 3600);
            const updated = DB.run(`UPDATE twenty_sync_outbox SET status=?, attempts=?, nextAttemptAt=?,
                leaseToken=NULL, leasedUntil=NULL, lastErrorCode=?, lastErrorMessage=?, updatedAt=CURRENT_TIMESTAMP
                WHERE eventId=? AND status='LEASED' AND leaseToken=?`, [
                terminalStatus,
                attempts,
                terminalStatus === 'PENDING' ? plusSeconds(delaySeconds) : now(),
                result.errorCode || null,
                redact(result.errorMessage || '', 500) || null,
                eventId,
                leaseToken,
            ]);
            return updated.changes === 1;
        }).immediate();
    }

    assertOutboxLease(row, revision) {
        const valid = DB.get(`SELECT o.eventId FROM twenty_sync_outbox o
            JOIN twenty_workspace_links t ON t.businessId=o.businessId
            JOIN instances i ON i.id=o.businessId
            WHERE o.eventId=? AND o.businessId=? AND o.status='LEASED' AND o.leaseToken=?
                AND julianday(o.leasedUntil)>julianday('now') AND t.revision=? AND t.enabled=1 AND i.isActive=1`,
        [row.eventId, row.businessId, row.leaseToken, revision]);
        if (!valid) throw Object.assign(new Error('CRM sync lease or configuration changed'), { code: 'TWENTY_SYNC_FENCED', retryable: true });
    }

    getRecordLink(businessId, sourceTable, sourceId) {
        return DB.get(`SELECT * FROM twenty_record_links
            WHERE businessId=? AND sourceTable=? AND sourceId=?`, [Number(businessId), sourceTable, String(sourceId)]);
    }

    getRecordLinkByRemote(businessId, twentyObject, twentyRecordId) {
        return DB.get(`SELECT * FROM twenty_record_links
            WHERE businessId=? AND twentyObject=? AND twentyRecordId=?`, [Number(businessId), twentyObject, String(twentyRecordId)]);
    }

    getRecordLinkByRemoteId(businessId, twentyRecordId) {
        return DB.get(`SELECT * FROM twenty_record_links
            WHERE businessId=? AND twentyRecordId=?`, [Number(businessId), String(twentyRecordId)]);
    }

    upsertRecordLink(data = {}) {
        const businessId = this.businessId(data.businessId);
        DB.run(`INSERT INTO twenty_record_links (
            id,businessId,entityType,sourceTable,sourceId,twentyObject,twentyRecordId,sourceHash,lastSyncedAt
        ) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(businessId,sourceTable,sourceId) DO UPDATE SET
            entityType=excluded.entityType, twentyObject=excluded.twentyObject,
            twentyRecordId=excluded.twentyRecordId, sourceHash=excluded.sourceHash,
            lastSyncedAt=CURRENT_TIMESTAMP, updatedAt=CURRENT_TIMESTAMP`, [
            id('twlink'), businessId, data.entityType, data.sourceTable, String(data.sourceId),
            data.twentyObject, String(data.twentyRecordId), data.sourceHash || null,
        ]);
        return this.getRecordLink(businessId, data.sourceTable, data.sourceId);
    }

    saveWebhook(input = {}) {
        const deliveryId = String(input.deliveryId || '').trim();
        if (!deliveryId) throw new Error('deliveryId is required');
        const businessId = this.businessId(input.businessId);
        return DB.db.transaction(() => {
            const integration = this.getIntegration(businessId);
            if (!integration?.enabled || !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [businessId])
                || (input.expectedRevision != null && integration.revision !== input.expectedRevision)
                || (input.workspaceId && input.workspaceId !== integration.workspaceId)) {
                throw Object.assign(new Error('Webhook connection changed'), { code:'TWENTY_WEBHOOK_CONFIGURATION_CHANGED', statusCode:409 });
            }
            const inserted = DB.run(`INSERT OR IGNORE INTO twenty_webhook_inbox (
                id,deliveryId,businessId,workspaceId,eventType,twentyObject,twentyRecordId,
                payloadJson,payloadHash,integrationRevision,status,nextAttemptAt
            ) VALUES (?,?,?,?,?,?,?,?,?,?,'PENDING',CURRENT_TIMESTAMP)`, [
                id('twin'), deliveryId, businessId, integration.workspaceId || null,
                input.eventType, input.twentyObject, input.twentyRecordId || null,
                JSON.stringify(input.payload || {}), input.payloadHash, integration.revision,
            ]);
            const row = DB.get('SELECT * FROM twenty_webhook_inbox WHERE deliveryId=?', [deliveryId]);
            if (row?.businessId !== businessId || row.payloadHash !== input.payloadHash
                || row.integrationRevision !== integration.revision) {
                throw Object.assign(new Error('Webhook delivery conflict'), { code:'TWENTY_WEBHOOK_DELIVERY_CONFLICT', statusCode:409 });
            }
            return {
                ...row,
                idempotent: inserted.changes === 0,
            };
        }).immediate();
    }

    leaseWebhook(limit = 10, ttlSeconds = 120) {
        const transaction = DB.db.transaction(() => {
            DB.run(`UPDATE twenty_webhook_inbox SET status=CASE WHEN attempts>=8 THEN 'DEAD' ELSE 'PENDING' END,
                lastErrorCode='TWENTY_WEBHOOK_LEASE_EXPIRED',lastErrorMessage=NULL,
                nextAttemptAt=datetime('now','+30 seconds'),leaseToken=NULL,leasedUntil=NULL
                WHERE status='LEASED' AND leasedUntil IS NOT NULL AND datetime(leasedUntil)<=datetime('now')`);
            DB.run(`UPDATE twenty_webhook_inbox AS o SET status='DEAD',leaseToken=NULL,leasedUntil=NULL,
                lastErrorCode='TWENTY_WEBHOOK_CONFIGURATION_CHANGED',lastErrorMessage=NULL
                WHERE o.status IN ('PENDING','LEASED') AND NOT EXISTS (
                    SELECT 1 FROM twenty_workspace_links t JOIN instances i ON i.id=t.businessId
                    WHERE t.businessId=o.businessId AND t.enabled=1 AND i.isActive=1
                      AND t.revision=o.integrationRevision AND t.workspaceId IS o.workspaceId)`);
            const rows = DB.all(`SELECT * FROM twenty_webhook_inbox
                WHERE status='PENDING' AND attempts<8 AND datetime(nextAttemptAt)<=datetime('now')
                ORDER BY datetime(receivedAt), id LIMIT ?`, [Math.max(1, Math.min(Number(limit) || 10, 50))]);
            for (const row of rows) {
                const leaseToken = crypto.randomUUID();
                const leasedUntil = plusSeconds(Math.max(5,Math.min(Number(ttlSeconds)||120,900)));
                DB.run(`UPDATE twenty_webhook_inbox SET status='LEASED',leaseToken=?,leasedUntil=?,attempts=attempts+1
                    WHERE id=? AND status='PENDING'`, [leaseToken, leasedUntil, row.id]);
                row.leaseToken = leaseToken;
                row.leasedUntil = leasedUntil;
                row.attempts = Number(row.attempts || 0) + 1;
                row.status = 'LEASED';
            }
            return rows;
        });
        return transaction.immediate();
    }

    finishWebhook(idValue, leaseToken, result = {}) {
        return DB.db.transaction(() => {
            const row = DB.get(`SELECT * FROM twenty_webhook_inbox WHERE id=? AND status='LEASED' AND leaseToken=?
                AND datetime(leasedUntil)>datetime('now')`, [idValue,leaseToken]);
            if (!row) return false;
            const attempts = Number(row.attempts || 0);
            const retry = result.retryable && attempts < 8;
            DB.run(`UPDATE twenty_webhook_inbox SET status=?, attempts=?, nextAttemptAt=?, leaseToken=NULL,
                leasedUntil=NULL,lastErrorCode=?,lastErrorMessage=?,processedAt=? WHERE id=? AND leaseToken=?`, [
                retry ? 'PENDING' : (result.retryable ? 'DEAD' : (result.status || 'DONE')), attempts,
                retry ? plusSeconds(Math.min(30 * (2 ** Math.max(0, attempts - 1)), 3600)) : now(),
                result.errorCode || null, redact(result.errorMessage || '', 500) || null,
                retry ? null : now(), idValue,leaseToken,
            ]);
            return true;
        }).immediate();
    }

    assertWebhookLease(row) {
        const valid = DB.get(`SELECT o.id FROM twenty_webhook_inbox o
            JOIN twenty_workspace_links t ON t.businessId=o.businessId JOIN instances i ON i.id=o.businessId
            WHERE o.id=? AND o.businessId=? AND o.status='LEASED' AND o.leaseToken=?
              AND datetime(o.leasedUntil)>datetime('now') AND t.enabled=1 AND i.isActive=1
              AND t.revision=o.integrationRevision AND o.workspaceId IS t.workspaceId`,
        [row.id,row.businessId,row.leaseToken]);
        if (!valid) throw Object.assign(new Error('Webhook lease or configuration changed'), {code:'TWENTY_WEBHOOK_FENCED'});
    }

    audit(data = {}) {
        DB.run(`INSERT INTO twenty_audit_events (
            id,businessId,direction,action,entityType,sourceId,twentyRecordId,status,correlationId,detailJson
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`, [
            id('twaudit'), this.businessId(data.businessId), data.direction || 'outbound',
            data.action, data.entityType || null, data.sourceId || null,
            data.twentyRecordId || null, data.status || 'ok', data.correlationId || null,
            JSON.stringify(data.detail || {}),
        ]);
    }

    diagnostics(businessId) {
        businessId = this.businessId(businessId);
        const counts = {};
        for (const row of DB.all('SELECT status, COUNT(*) AS count FROM twenty_sync_outbox WHERE businessId=? GROUP BY status', [businessId])) {
            counts[row.status] = row.count;
        }
        const inbox = {};
        for (const row of DB.all('SELECT status, COUNT(*) AS count FROM twenty_webhook_inbox WHERE businessId=? GROUP BY status', [businessId])) {
            inbox[row.status] = row.count;
        }
        return {
            outbox: counts,
            inbox,
            links: DB.get('SELECT COUNT(*) AS count FROM twenty_record_links WHERE businessId=?', [businessId])?.count || 0,
            errors_24h: DB.get(`SELECT COUNT(*) AS count FROM twenty_audit_events
                WHERE businessId=? AND status<>'ok' AND datetime(createdAt)>=datetime('now','-24 hours')`, [businessId])?.count || 0,
        };
    }
}

module.exports = new TwentyStore();
