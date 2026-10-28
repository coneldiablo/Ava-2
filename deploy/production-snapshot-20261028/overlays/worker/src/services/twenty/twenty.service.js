const crypto = require('crypto');
const DB = require('../database.service');
const Logger = require('../../utils/logger');
const Store = require('./twenty-store.service');
const ModuleAccess = require('../identity/module-access-store');
const { TwentyClient, normalizeBaseUrl, safeMessage } = require('./twenty-client');
const {
    encryptJson,
    decryptJson,
    randomOpaqueToken,
    sha256,
    context,
} = require('./twenty-crypto');

const DEFAULT_ENTITIES = Object.freeze({
    hotel: { object: 'companies' },
    person: { object: 'people' },
    manager_task: { object: 'tasks' },
    call: { object: 'avaCalls' },
    outbound_campaign: { object: 'avaCampaigns' },
    outbound_lead: { object: 'avaCampaignMembers' },
    outbound_attempt: { object: 'avaCallAttempts' },
    followup_draft: { object: 'avaFollowUpDrafts' },
    booking_request: { object: 'avaBookingRequests' },
});

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function trim(value, limit = 500) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

function digits(value) { return String(value || '').replace(/\D/g, ''); }

function taskStatusToTwenty(status) {
    if (['done', 'closed', 'cancelled'].includes(status)) return 'DONE';
    return status === 'in_progress' ? 'IN_PROGRESS' : 'TODO';
}

function taskStatusFromTwenty(status, current) {
    if (['DONE', 'COMPLETED', 'CLOSED'].includes(status)) {
        // Twenty has no cancelled status. Its echo must not erase AVA's reason.
        return current === 'cancelled' ? 'cancelled' : 'done';
    }
    if (status === 'IN_PROGRESS') return 'in_progress';
    if (['TODO', 'OPEN', 'NEW'].includes(status)) return 'new';
    return current;
}

function phoneFromChatId(value) {
    const raw = String(value || '').trim();
    // Group IDs, WhatsApp LIDs and Telegram/VK identifiers are not phones.
    const match = raw.match(/^\+?([1-9]\d{7,14})(?:@(c\.us|s\.whatsapp\.net))?$/);
    return match ? `+${match[1]}` : null;
}

function splitName(value) {
    const parts = trim(value, 160).split(' ').filter(Boolean);
    return { firstName: parts.shift() || 'Гость', lastName: parts.join(' ') };
}

function compact(object) {
    return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function extractRecord(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.id) return value;
    if (value.data) return extractRecord(value.data);
    for (const child of Object.values(value)) {
        if (child && typeof child === 'object') {
            const found = extractRecord(child);
            if (found) return found;
        }
    }
    return null;
}

function sourceUrl(path) {
    const base = String(process.env.AVA_PUBLIC_BASE_URL || process.env.ADMIN_UI_PUBLIC_URL || '').replace(/\/$/, '');
    return base ? `${base}${path}` : path;
}

function mapCustomFields(payload, mapping = {}) {
    const fieldMap = mapping.fields && typeof mapping.fields === 'object' ? mapping.fields : {};
    const output = {};
    for (const [key, value] of Object.entries(payload)) {
        if (value === undefined || value === null || value === '') continue;
        output[fieldMap[key] || key] = value;
    }
    return output;
}

function remoteRecordId(integration, row) {
    // UUIDv5 in the URL namespace. Twenty v2.37 rejects UUIDv8 identifiers.
    const hex = crypto.createHash('sha1')
        .update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex'))
        .update(JSON.stringify([
        'ava-twenty-v1', integration.workspaceId || integration.baseUrl,
        Number(row.businessId), row.sourceTable, String(row.sourceId),
    ])).digest('hex').slice(0, 32).split('');
    hex[12] = '5';
    hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
    const value = hex.join('');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

class TwentyService {
    constructor() {
        this.timer = null;
        this.processing = false;
        this.clientFactory = (options) => new TwentyClient(options);
        this.clients = new Map();
        this.outboxLeaseTtlSeconds = 120;
    }

    start() {
        if (this.timer || process.env.TWENTY_SYNC_ENABLED === 'false') return;
        const intervalMs = Math.max(1000, Number(process.env.TWENTY_SYNC_INTERVAL_MS || 5000));
        this.timer = setInterval(() => this.tick().catch((error) => {
            Logger.error('[Twenty] worker tick failed:', safeMessage(error));
        }), intervalMs);
        this.timer.unref?.();
        this.tick().catch((error) => Logger.warn('[Twenty] initial tick failed:', safeMessage(error)));
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    _credentials(row) {
        return decryptJson(row.apiKeyEncrypted || '', context(row.businessId));
    }

    _client(row) {
        const cached = this.clients.get(row.businessId);
        if (cached && cached.factory === this.clientFactory && cached.baseUrl === row.baseUrl
            && cached.encrypted === row.apiKeyEncrypted) return cached.client;
        const credentials = this._credentials(row);
        const client = this.clientFactory({
            baseUrl: row.baseUrl,
            apiKey: credentials.apiKey,
            maxRequestsPerMinute: Number(process.env.TWENTY_RATE_LIMIT_PER_MINUTE || 90),
        });
        this.clients.set(row.businessId, {
            factory: this.clientFactory, baseUrl: row.baseUrl, encrypted: row.apiKeyEncrypted, client,
        });
        return client;
    }

    _public(row, extra = {}) {
        if (!row) {
            return {
                provider: 'twenty', enabled: false, mode: 'shadow',
                credentials_configured: false, webhook_configured: false,
                connection_status: 'not_configured', mappings: {}, diagnostics: {},
                ...extra,
            };
        }
        let keySuffix = '';
        try { keySuffix = String(this._credentials(row).apiKey || '').slice(-4); } catch (_) { keySuffix = ''; }
        return {
            provider: 'twenty',
            business_id: Number(row.businessId),
            revision: row.revision,
            enabled: Boolean(row.enabled),
            mode: row.mode,
            workspace_id: row.workspaceId || null,
            base_url: row.baseUrl,
            credentials_configured: Boolean(row.apiKeyEncrypted),
            masked_api_key: keySuffix ? `••••${keySuffix}` : null,
            webhook_configured: Boolean(row.webhookSecretEncrypted && row.webhookTokenHash),
            webhook_path: row.webhookTokenEncrypted ? `/api/integrations/twenty/webhooks/configured` : null,
            connection_status: row.connectionStatus,
            mappings: parseJson(row.mappingsJson, {}),
            last_sync_at: row.lastSyncAt || null,
            last_success_at: row.lastSuccessAt || null,
            last_webhook_at: row.lastWebhookAt || null,
            last_error: row.lastErrorCode ? { code: row.lastErrorCode, message: row.lastErrorMessage || '' } : null,
            diagnostics: Store.diagnostics(row.businessId),
            ...extra,
        };
    }

    get(businessId) {
        return this._public(Store.getIntegration(businessId));
    }

    configure(businessId, input = {}) {
        const existing = Store.getIntegration(businessId);
        const baseUrl = normalizeBaseUrl(input.base_url || input.baseUrl || existing?.baseUrl);
        const apiKey = String(input.api_key || input.apiKey || '').trim();
        const workspaceId = String(
            input.workspace_id || input.workspaceId || existing?.workspaceId || ''
        ).trim() || null;
        const connectionParametersChanged = Boolean(
            apiKey
            || (existing && baseUrl !== existing.baseUrl)
            || (existing && workspaceId !== (existing.workspaceId || null))
        );
        let apiKeyEncrypted = existing?.apiKeyEncrypted || '';
        if (apiKey) apiKeyEncrypted = encryptJson({ apiKey }, context(businessId));
        if (!apiKeyEncrypted) {
            const error = new Error('Twenty API key is required');
            error.code = 'TWENTY_API_KEY_REQUIRED';
            error.statusCode = 400;
            throw error;
        }
        const mode = ['shadow', 'live'].includes(input.mode) ? input.mode : (existing?.mode || 'shadow');
        const connectionVerified = existing?.connectionStatus === 'connected' && !connectionParametersChanged;
        if (mode === 'live' && input.enabled !== false && !connectionVerified) {
            const error = new Error('Сначала проверьте подключение Twenty, затем включайте live-синхронизацию');
            error.code = 'TWENTY_CONNECTION_NOT_VERIFIED';
            error.statusCode = 409;
            throw error;
        }
        const webhookSecret = String(input.webhook_secret || input.webhookSecret || '').trim();
        const row = Store.upsertIntegration(businessId, {
            workspaceId,
            baseUrl,
            apiKeyEncrypted,
            webhookSecretEncrypted: webhookSecret ? encryptJson({ secret: webhookSecret }, context(businessId, 'webhookSecretEncrypted')) : existing?.webhookSecretEncrypted,
            webhookTokenHash: existing?.webhookTokenHash || null,
            webhookTokenEncrypted: existing?.webhookTokenEncrypted || null,
            enabled: Boolean(input.enabled),
            mode,
            connectionStatus: connectionParametersChanged ? 'not_tested' : (existing?.connectionStatus || 'not_tested'),
            mappings: input.mappings || parseJson(existing?.mappingsJson, {}),
        });
        return this._public(row);
    }

    disconnect(businessId) {
        this.clients.delete(Number(businessId));
        return { business_id: Number(businessId), provider: 'twenty', disconnected: Store.deleteIntegration(businessId) };
    }

    async test(businessId, correlationId = crypto.randomUUID()) {
        const row = Store.getIntegration(businessId);
        try {
            const response = await this._client(row).testConnection(correlationId);
            const objects = Array.isArray(response) ? response : (response?.data || response?.objects || []);
            const updated = Store.updateStatus(businessId, {
                connectionStatus: 'connected', lastSuccessAt: new Date().toISOString(),
                lastErrorCode: null, lastErrorMessage: null,
            }, { expectedRevision: row.revision });
            Store.audit({ businessId, direction: 'outbound', action: 'test_connection', status: 'ok', correlationId, detail: { objects_visible: Array.isArray(objects) ? objects.length : null } });
            return this._public(updated, { correlation_id: correlationId, test_ok: true });
        } catch (error) {
            if (Store.getIntegrationUnsafe(businessId)?.revision === row?.revision) {
                Store.updateStatus(businessId, {
                    connectionStatus: 'error', lastErrorCode: error.code || 'TWENTY_TEST_FAILED', lastErrorMessage: safeMessage(error),
                }, { expectedRevision: row.revision });
            }
            Store.audit({ businessId, direction: 'outbound', action: 'test_connection', status: 'error', correlationId, detail: { error_code: error.code || 'TWENTY_TEST_FAILED' } });
            throw error;
        }
    }

    enqueueInitialSync(businessId) {
        const row = Store.getIntegration(businessId);
        if (row.connectionStatus !== 'connected') {
            const error = new Error('Twenty connection is not verified');
            error.code = 'TWENTY_CONNECTION_NOT_VERIFIED';
            error.statusCode = 409;
            throw error;
        }
        const queued = Store.enqueueInitialSync(businessId);
        return { business_id: Number(businessId), provider: 'twenty', queued };
    }

    connectWebhook(businessId, publicBaseUrl) {
        const current = Store.getIntegration(businessId);
        const base = String(publicBaseUrl || process.env.AVA_PUBLIC_BASE_URL || process.env.WHATSAPP_CRM_PUBLIC_URL || '').replace(/\/$/, '');
        if (!base || !/^https:\/\//i.test(base)) {
            const error = new Error('Public HTTPS base URL is required for Twenty webhook');
            error.code = 'TWENTY_PUBLIC_URL_REQUIRED';
            error.statusCode = 400;
            throw error;
        }
        let token;
        let secret;
        let secretOnce = null;
        if (current.webhookTokenEncrypted) token = decryptJson(current.webhookTokenEncrypted, context(businessId, 'webhookTokenEncrypted')).token;
        else token = randomOpaqueToken();
        if (current.webhookSecretEncrypted) secret = decryptJson(current.webhookSecretEncrypted, context(businessId, 'webhookSecretEncrypted')).secret;
        else {
            secret = randomOpaqueToken();
            secretOnce = secret;
        }
        const row = Store.updateStatus(businessId, {
            webhookTokenHash: sha256(token),
            webhookTokenEncrypted: current.webhookTokenEncrypted || encryptJson({ token }, context(businessId, 'webhookTokenEncrypted')),
            webhookSecretEncrypted: current.webhookSecretEncrypted || encryptJson({ secret }, context(businessId, 'webhookSecretEncrypted')),
        });
        return this._public(row, {
            webhook_url: `${base}/api/integrations/twenty/webhooks/${token}`,
            webhook_secret_once: secretOnce,
            manual_setup_required: true,
            setup_steps: [
                'Twenty → Настройки → API и Webhooks → Webhooks → Создать',
                'Вставьте webhook URL и общий секрет',
                'Сохраните и отправьте тестовое событие',
            ],
        });
    }

    _entityMapping(row, entityType) {
        const mappings = parseJson(row.mappingsJson, {});
        return { ...(DEFAULT_ENTITIES[entityType] || {}), ...(mappings.entities?.[entityType] || {}) };
    }

    _sourceSnapshot(row) {
        const businessId = Number(row.businessId);
        const sourceId = String(row.sourceId);
        switch (row.sourceTable) {
        case 'instances': {
            const item = DB.get('SELECT id,name,businessType,hotelTimezone,sipCallerId,createdAt,updatedAt FROM instances WHERE id=?', [businessId]);
            if (!item) return null;
            return { name: trim(item.name, 180), avaBusinessId: String(businessId), businessType: item.businessType || 'hotel', timezone: item.hotelTimezone || 'Europe/Moscow', sourceUrl: sourceUrl(`/hotels?business_id=${businessId}`) };
        }
        case 'clients': {
            const item = DB.get('SELECT id,chatId,senderName,leadStatus,createdAt,updatedAt FROM clients WHERE instanceId=? AND id=?', [businessId, sourceId]);
            if (!item) return null;
            if (String(item.chatId).endsWith('@g.us')) return null;
            const name = splitName(item.senderName);
            const phone = phoneFromChatId(item.chatId);
            return compact({ name, phones: phone ? { primaryPhoneNumber: phone } : undefined,
                jobTitle: trim(item.leadStatus, 80), avaBusinessId: String(businessId),
                avaSourceId: String(item.id), sourceUrl: sourceUrl(`/hotels?business_id=${businessId}`) });
        }
        case 'manager_tasks': {
            const item = DB.get('SELECT * FROM manager_tasks WHERE instanceId=? AND taskId=?', [businessId, sourceId]);
            if (!item) return null;
            return compact({ title: trim(item.summary, 160), bodyV2: { markdown: trim(item.resolutionNote || `${item.reason}: ${item.summary}`, 1500) }, status: taskStatusToTwenty(item.status), avaBusinessId: String(businessId), avaSourceId: item.taskId, callId: item.callId, phone: digits(item.phone), priority: item.priority, sourceUrl: sourceUrl(`/tasks?business_id=${businessId}`) });
        }
        case 'followup_drafts': {
            const item = DB.get('SELECT * FROM followup_drafts WHERE instanceId=? AND draftId=?', [businessId, sourceId]);
            if (!item) return null;
            return compact({ name: `Follow-up ${item.draftId}`, avaBusinessId: String(businessId), avaSourceId: item.draftId, status: item.status, text: trim(item.text, 1200), callId: item.callId, sourceUrl: sourceUrl(`/followups?business_id=${businessId}`), createdAtAva: item.createdAt });
        }
        case 'outbound_campaigns': {
            const item = DB.get('SELECT * FROM outbound_campaigns WHERE instanceId=? AND campaignId=?', [businessId, sourceId]);
            if (!item) return null;
            return compact({ name: trim(item.name, 180), avaBusinessId: String(businessId), avaSourceId: item.campaignId, status: item.status, contextName: item.contextId, maxAttempts: item.maxAttempts, sourceUrl: sourceUrl(`/call-scheduling?business_id=${businessId}`), createdAtAva: item.createdAt });
        }
        case 'outbound_leads': {
            const item = DB.get('SELECT * FROM outbound_leads WHERE instanceId=? AND leadId=?', [businessId, sourceId]);
            if (!item) return null;
            return compact({ name: trim(item.name || `Лид ${item.leadId}`, 180), avaBusinessId: String(businessId), avaSourceId: item.leadId, campaignSourceId: String(item.campaignId), phone: digits(item.phone), status: item.state, attemptCount: item.attemptCount, lastOutcome: item.lastOutcome, sourceUrl: sourceUrl(`/call-scheduling?business_id=${businessId}`) });
        }
        case 'outbound_attempts': {
            const item = DB.get('SELECT * FROM outbound_attempts WHERE instanceId=? AND attemptId=?', [businessId, sourceId]);
            if (!item) return null;
            return compact({ name: `Попытка ${item.attemptId}`, avaBusinessId: String(businessId), avaSourceId: item.attemptId, campaignSourceId: String(item.campaignId), leadSourceId: String(item.leadId), callId: item.callId, status: item.status, outcome: item.outcome, durationSeconds: item.durationSec, sourceUrl: sourceUrl(`/logs?business_id=${businessId}&call_id=${encodeURIComponent(item.callId || '')}`), createdAtAva: item.createdAt });
        }
        case 'conversation_events': {
            const events = DB.all(`SELECT * FROM conversation_events WHERE instanceId=? AND callId=?
                ORDER BY CASE role WHEN 'manager_note' THEN 0 WHEN 'task' THEN 1 ELSE 2 END, datetime(createdAt) DESC`, [businessId, sourceId]);
            if (!events.length) return null;
            const summaryEvent = events.find((item) => ['manager_note', 'task'].includes(item.role));
            const first = events[0];
            return compact({ name: `Звонок ${sourceId}`, avaBusinessId: String(businessId), avaSourceId: sourceId, callId: sourceId, channel: first.channel, summary: trim(summaryEvent?.content || 'Звонок сохранён в AVA', 1200), sourceUrl: sourceUrl(`/logs?mode=troubleshoot&business_id=${businessId}&call_id=${encodeURIComponent(sourceId)}`), occurredAt: first.createdAt });
        }
        case 'pms_booking_requests': {
            const item = DB.get('SELECT * FROM pms_booking_requests WHERE businessId=? AND id=?', [businessId, sourceId]);
            if (!item) return null;
            return compact({ name: `Заявка ${item.customerName || item.id}`, avaBusinessId: String(businessId), avaSourceId: item.id, status: item.status, customerName: trim(item.customerName, 180), arrivalDate: item.arrivalDate, departureDate: item.departureDate, adults: item.adults, children: item.children, sourceUrl: sourceUrl(`/hotels?business_id=${businessId}`), createdAtAva: item.createdAt });
        }
        default:
            return null;
        }
    }

    async _syncOutboxRow(row) {
        const integration = Store.getIntegrationUnsafe(row.businessId);
        if (!integration || !integration.enabled) {
            Store.finishOutbox(row.eventId, row.leaseToken, { status: 'CANCELED', errorCode: 'TWENTY_DISABLED' });
            return;
        }
        const assertActive = () => Store.assertOutboxLease(row, integration.revision);
        assertActive();
        const bootstrap = Store.bootstrapEvent(row, integration);
        if (integration.mode === 'shadow' && !bootstrap) {
            Store.audit({ businessId: row.businessId, direction: 'outbound', action: 'shadow_projection', entityType: row.entityType, sourceId: row.sourceId, status: 'ok' });
            Store.finishOutbox(row.eventId, row.leaseToken, { status: 'SHADOWED' });
            return;
        }
        const mapping = this._entityMapping(integration, row.entityType);
        if (!mapping.object || !DEFAULT_ENTITIES[row.entityType]) {
            Store.finishOutbox(row.eventId, row.leaseToken, { status: 'DEAD', errorCode: 'TWENTY_WRITE_FIREWALL' });
            return;
        }
        const snapshot = this._sourceSnapshot(row);
        if (!snapshot) {
            Store.finishOutbox(row.eventId, row.leaseToken, { status: 'DONE' });
            return;
        }
        const payload = mapCustomFields(snapshot, mapping);
        const sourceHash = sha256(JSON.stringify(payload));
        const existing = Store.getRecordLink(row.businessId, row.sourceTable, row.sourceId);

        const client = this._client(integration);
        const prepareNativeRequest = async (method, recordId, body) => {
            const deadline = Date.now() + 3000;
            while (true) {
                try {
                    return ModuleAccess.prepareSyncMutation({
                        businessId: Number(row.businessId),
                        correlationId: row.eventId,
                        outboxLeaseToken: row.leaseToken,
                        integrationRevision: Number(integration.revision),
                        method,
                        objectName: mapping.object,
                        recordId: recordId || null,
                        body: body ?? null,
                    });
                } catch (error) {
                    // The native HTTP response can arrive just before its
                    // asynchronous lease-release callback commits locally.
                    // Wait only for that narrow hand-off; a stuck or expired
                    // lease remains a hard barrier after the bounded deadline.
                    if (error.code !== 'MODULE_SYNC_LEASE_CONCURRENT' || Date.now() >= deadline) throw error;
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
            }
        };
        const create = async () => {
            const recordId = remoteRecordId(integration, row);
            const createPayload = { ...payload, id: recordId };
            try {
                assertActive();
                await prepareNativeRequest('POST', null, createPayload);
                return await client.createRecord(mapping.object, createPayload, row.eventId, assertActive);
            } catch (error) {
                if (error.statusCode !== 409 && error.code !== 'TWENTY_DUPLICATE_RECORD') throw error;
                // A previous POST may have committed before its response was
                // lost. Fetch the same deterministic ID instead of duplicating.
                assertActive();
                await prepareNativeRequest('GET', recordId, null);
                await client.getRecord(mapping.object, recordId, row.eventId, assertActive);
                assertActive();
                await prepareNativeRequest('PATCH', recordId, payload);
                return client.updateRecord(mapping.object, recordId, payload, row.eventId, assertActive);
            }
        };
        let response;
        try {
            if (existing?.sourceHash === sourceHash) {
                response = { id: existing.twentyRecordId };
            } else if (existing) {
                await prepareNativeRequest('PATCH', existing.twentyRecordId, payload);
                response = await client.updateRecord(mapping.object, existing.twentyRecordId, payload, row.eventId, assertActive);
            } else {
                response = await create();
            }
        } catch (error) {
            if (existing && error.statusCode === 404) {
                response = await create();
            } else {
                throw error;
            }
        }
        assertActive();
        const record = extractRecord(response);
        if (!record?.id) {
            const error = new Error('Twenty response does not contain a record id');
            error.code = 'TWENTY_SCHEMA_MISMATCH';
            error.retryable = false;
            throw error;
        }

        await prepareNativeRequest('GET', record.id, null);
        const readback = extractRecord(await client.getRecord(mapping.object, record.id, row.eventId, assertActive));
        assertActive();
        const contains = (actual, expected, field) => {
            if (field === 'phones' && expected?.primaryPhoneNumber) {
                const expectedDigits = digits(expected.primaryPhoneNumber);
                const remoteDigits = digits(actual?.primaryPhoneNumber);
                const callingCode = digits(actual?.primaryPhoneCallingCode);
                return Boolean(remoteDigits) && (remoteDigits === expectedDigits
                    || `${callingCode}${remoteDigits}` === expectedDigits);
            }
            if (['occurredAt', 'createdAtAva'].includes(field)
                && typeof expected === 'string' && typeof actual === 'string') {
                const asUtc = value => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
                    ? value.replace(' ', 'T') + 'Z' : value;
                const expectedTime = Date.parse(asUtc(expected));
                const actualTime = Date.parse(asUtc(actual));
                return Number.isFinite(expectedTime) && expectedTime === actualTime;
            }
            return expected && typeof expected === 'object'
                ? actual && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => contains(actual[key], value, key))
                : actual === expected;
        };
        if (readback?.id !== record.id || !contains(readback, payload)) {
            throw Object.assign(new Error('CRM record readback does not match the tenant projection'), { code: 'TWENTY_READBACK_MISMATCH', retryable: false });
        }
        DB.db.transaction(() => {
            assertActive();
            Store.upsertRecordLink({
                businessId: row.businessId, entityType: row.entityType,
                sourceTable: row.sourceTable, sourceId: row.sourceId,
                twentyObject: mapping.object, twentyRecordId: record.id, sourceHash,
            });
            Store.audit({ businessId: row.businessId, direction: 'outbound', action: existing ? 'update' : 'create', entityType: row.entityType, sourceId: row.sourceId, twentyRecordId: record.id, status: 'ok', correlationId: row.eventId });
            Store.updateStatus(row.businessId, { lastSuccessAt: new Date().toISOString(), lastErrorCode: null, lastErrorMessage: null }, { expectedRevision: integration.revision });
            if (!Store.finishOutbox(row.eventId, row.leaseToken, { status: 'DONE' })) {
                throw Object.assign(new Error('CRM sync lease expired before commit'), { code: 'TWENTY_SYNC_FENCED', retryable: true });
            }
            if (bootstrap) DB.run('UPDATE twenty_bootstrap_events SET verifiedAt=CURRENT_TIMESTAMP WHERE eventId=?', [row.eventId]);
        }).immediate();
    }

    async processOutbox(limit = 10) {
        let processed = 0;
        for (let index = 0; index < limit; index += 1) {
            // Rate limiting and HTTP retries can consume the entire batch TTL.
            const [row] = Store.leaseOutbox(1, this.outboxLeaseTtlSeconds);
            if (!row) break;
            processed += 1;

            const revision = Store.getIntegrationUnsafe(row.businessId)?.revision;
            // Keep the lease valid while the HTTP client's rate limiter and retries run.
            const heartbeat = setInterval(() => {
                try { Store.renewOutboxLease(row.eventId, row.leaseToken, this.outboxLeaseTtlSeconds); }
                catch (error) { Logger.warn('[Twenty] lease renewal failed:', safeMessage(error)); }
            }, Math.max(100, Math.floor(this.outboxLeaseTtlSeconds * 1000 / 3)));
            heartbeat.unref?.();
            try {
                await this._syncOutboxRow(row);
            } catch (error) {
                const errorCode = error.code || 'TWENTY_SYNC_FAILED';
                const retryable = error.retryable !== false;

                if (Store.finishOutbox(row.eventId, row.leaseToken, { status: retryable ? 'FAILED' : 'DEAD', retryable, errorCode, errorMessage: safeMessage(error) })) {
                    if (errorCode !== 'TWENTY_SYNC_FENCED') {
                        try { Store.updateStatus(row.businessId, { lastErrorCode: errorCode, lastErrorMessage: safeMessage(error) }, { expectedRevision: revision }); }
                        catch (changed) { if (!['TWENTY_CONFIGURATION_CHANGED','TWENTY_BUSINESS_NOT_FOUND'].includes(changed.code)) throw changed; }
                    }
                    Store.audit({ businessId: row.businessId, direction: 'outbound', action: 'sync', entityType: row.entityType, sourceId: row.sourceId, status: 'error', correlationId: row.eventId, detail: { error_code: errorCode } });
                }
            } finally {
                clearInterval(heartbeat);
            }
        }
        return processed;
    }

    _applyInbound(row) {
        const payload = parseJson(row.payloadJson, {});
        const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
        const link = row.twentyRecordId ? Store.getRecordLinkByRemoteId(row.businessId, row.twentyRecordId) : null;
        if (!link) return 'IGNORED';
        switch (link.sourceTable) {
        case 'clients': {
            const current = DB.get('SELECT * FROM clients WHERE instanceId=? AND id=?', [row.businessId, link.sourceId]);
            if (!current) return 'IGNORED';
            const remoteName = data.name && typeof data.name === 'object'
                ? trim(`${data.name.firstName || ''} ${data.name.lastName || ''}`, 180)
                : trim(data.name, 180);
            if (remoteName && remoteName !== current.senderName) {
                DB.run('UPDATE clients SET senderName=?,updatedAt=CURRENT_TIMESTAMP WHERE instanceId=? AND id=?', [remoteName, row.businessId, link.sourceId]);
            }
            return 'DONE';
        }
        case 'manager_tasks': {
            const current = DB.get('SELECT * FROM manager_tasks WHERE instanceId=? AND taskId=?', [row.businessId, link.sourceId]);
            if (!current) return 'IGNORED';
            const statusRaw = String(data.status || '').toUpperCase();
            const status = taskStatusFromTwenty(statusRaw, current.status);
            const resolution = trim(data.resolutionNote || data.bodyV2?.markdown || data.body || '', 800) || current.resolutionNote;
            if (status !== current.status || resolution !== current.resolutionNote) {
                DB.run(`UPDATE manager_tasks SET status=?,resolutionNote=?,updatedAt=CURRENT_TIMESTAMP,
                    closedAt=CASE WHEN ? IN ('done','cancelled') THEN COALESCE(closedAt,CURRENT_TIMESTAMP) ELSE NULL END
                    WHERE instanceId=? AND taskId=?`, [status, resolution, status, row.businessId, link.sourceId]);
            }
            return 'DONE';
        }
        case 'followup_drafts': {
            const current = DB.get('SELECT * FROM followup_drafts WHERE instanceId=? AND draftId=?', [row.businessId, link.sourceId]);
            if (!current) return 'IGNORED';
            const text = trim(data.text, 1200) || current.text;
            const remoteStatus = String(data.status || '').toLowerCase();
            const allowedStatus = ['draft', 'approved', 'canceled'].includes(remoteStatus) ? remoteStatus : current.status;
            if (text !== current.text || allowedStatus !== current.status) {
                DB.run(`UPDATE followup_drafts SET text=?,status=?,editedBy='twenty',editedAt=CURRENT_TIMESTAMP,
                    approvedBy=CASE WHEN ?='approved' THEN 'twenty' ELSE approvedBy END,
                    approvedAt=CASE WHEN ?='approved' THEN COALESCE(approvedAt,CURRENT_TIMESTAMP) ELSE approvedAt END,
                    updatedAt=CURRENT_TIMESTAMP WHERE instanceId=? AND draftId=?`, [
                    text, allowedStatus, allowedStatus, allowedStatus, row.businessId, link.sourceId,
                ]);
            }
            return 'DONE';
        }
        default:
            return 'IGNORED';
        }
    }

    processWebhookInbox(limit = 10) {
        const rows = Store.leaseWebhook(limit);
        for (const row of rows) {
            try {
                DB.db.transaction(() => {
                    Store.assertWebhookLease(row);
                    const status = this._applyInbound(row);
                    if (!Store.finishWebhook(row.id, row.leaseToken, { status })) throw Object.assign(new Error('Webhook lease lost'), {code:'TWENTY_WEBHOOK_FENCED'});
                    Store.updateStatus(row.businessId, { lastWebhookAt: new Date().toISOString() }, {expectedRevision:row.integrationRevision});
                    Store.audit({ businessId: row.businessId, direction: 'inbound', action: row.eventType, twentyRecordId: row.twentyRecordId, status: 'ok', correlationId: row.deliveryId, detail: { result: status } });
                }).immediate();
            } catch (error) {
                Store.finishWebhook(row.id, row.leaseToken, { status: 'FAILED', retryable: true, errorCode: error.code || 'TWENTY_WEBHOOK_PROCESSING_FAILED', errorMessage: safeMessage(error) });
            }
        }
        return rows.length;
    }

    async tick() {
        if (this.processing) return { skipped: true };
        this.processing = true;
        try {
            const [outbox, inbox] = await Promise.all([
                this.processOutbox(10),
                Promise.resolve(this.processWebhookInbox(10)),
            ]);
            return { outbox, inbox };
        } finally {
            this.processing = false;
        }
    }
}

module.exports = new TwentyService();
