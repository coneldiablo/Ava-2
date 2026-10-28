const crypto = require('crypto');
const DB = require('../database.service');
const { parseJson, normalizePhone, normalizeEmail, redact, isoNow } = require('./pms-utils');

function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function int(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? Math.trunc(n) : fallback; }

class PmsStore {
    _businessId(value) {
        const businessId = (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value.trim())) ? Number(value) : NaN;
        if (!Number.isSafeInteger(businessId) || businessId < 1) {
            const error = new Error('business_id is required');
            error.statusCode = 400;
            error.code = 'PMS_BUSINESS_SCOPE_REQUIRED';
            throw error;
        }
        return businessId;
    }

    getIntegration(businessId, provider = 'bnovo') {
        return DB.get('SELECT * FROM pms_integrations WHERE businessId = ? AND provider = ?', [this._businessId(businessId), provider]);
    }

    listEnabledIntegrations() {
        return DB.all(`SELECT p.*, i.hotelTimezone FROM pms_integrations p
            JOIN instances i ON i.id = p.businessId
            WHERE p.provider = 'bnovo' AND p.enabled = 1
            ORDER BY p.businessId`);
    }

    findIntegrationByWebhookTokenHash(tokenHash) {
        return DB.get('SELECT * FROM pms_integrations WHERE provider = ? AND webhookTokenHash = ?', ['bnovo', tokenHash]);
    }

    upsertIntegration(businessId, data) {
        businessId = this._businessId(businessId);
        const existing = this.getIntegration(businessId, data.provider || 'bnovo');
        const integrationId = existing?.id || id('pmsi');
        try {
            DB.run(`
                INSERT INTO pms_integrations (
                    id, businessId, provider, enabled, mode, externalHotelId, accountIdMasked,
                    credentialsEncrypted, currency, mappingsJson, webhookTokenHash,
                    webhookTokenEncrypted, webhookSubscriberId, connectionStatus, pollingStatus,
                    webhookStatus, lastSyncAt, lastSuccessfulAvailabilityAt, lastWebhookAt,
                    lastErrorCode, lastErrorMessage, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(businessId, provider) DO UPDATE SET
                    enabled=excluded.enabled, mode=excluded.mode,
                    externalHotelId=excluded.externalHotelId, accountIdMasked=excluded.accountIdMasked,
                    credentialsEncrypted=excluded.credentialsEncrypted, currency=excluded.currency,
                    mappingsJson=excluded.mappingsJson, webhookTokenHash=excluded.webhookTokenHash,
                    webhookTokenEncrypted=excluded.webhookTokenEncrypted,
                    webhookSubscriberId=excluded.webhookSubscriberId,
                    connectionStatus=excluded.connectionStatus, pollingStatus=excluded.pollingStatus,
                    webhookStatus=excluded.webhookStatus, lastSyncAt=excluded.lastSyncAt,
                    lastSuccessfulAvailabilityAt=excluded.lastSuccessfulAvailabilityAt,
                    lastWebhookAt=excluded.lastWebhookAt, lastErrorCode=excluded.lastErrorCode,
                    lastErrorMessage=excluded.lastErrorMessage, updatedAt=CURRENT_TIMESTAMP
            `, [
                integrationId, businessId, data.provider || 'bnovo', data.enabled ? 1 : 0,
                data.mode || 'read_only', data.externalHotelId || null, data.accountIdMasked || null,
                data.credentialsEncrypted || existing?.credentialsEncrypted || '', data.currency || 'RUB',
                JSON.stringify(data.mappings || parseJson(existing?.mappingsJson, {})),
                data.webhookTokenHash ?? existing?.webhookTokenHash ?? null,
                data.webhookTokenEncrypted ?? existing?.webhookTokenEncrypted ?? null,
                data.webhookSubscriberId ?? existing?.webhookSubscriberId ?? null,
                data.connectionStatus || existing?.connectionStatus || 'not_tested',
                data.pollingStatus || existing?.pollingStatus || 'idle',
                data.webhookStatus || existing?.webhookStatus || 'not_configured',
                data.lastSyncAt ?? existing?.lastSyncAt ?? null,
                data.lastSuccessfulAvailabilityAt ?? existing?.lastSuccessfulAvailabilityAt ?? null,
                data.lastWebhookAt ?? existing?.lastWebhookAt ?? null,
                data.lastErrorCode ?? null, redact(data.lastErrorMessage || '', 500) || null,
            ]);
        } catch (error) {
            if (String(error.message).includes('externalHotelId')) {
                error.statusCode = 409;
                error.code = 'PMS_EXTERNAL_HOTEL_ALREADY_LINKED';
            }
            throw error;
        }
        return this.getIntegration(businessId, data.provider || 'bnovo');
    }

    updateIntegrationStatus(businessId, patch = {}) {
        const current = this.getIntegration(businessId);
        if (!current) return null;
        return this.upsertIntegration(businessId, {
            ...current,
            ...patch,
            mappings: patch.mappings || parseJson(current.mappingsJson, {}),
        });
    }

    deleteIntegration(businessId) {
        businessId = this._businessId(businessId);
        const remove = DB.db.transaction(() => {
            const deleted = DB.run('DELETE FROM pms_integrations WHERE businessId = ? AND provider = ?', [businessId, 'bnovo']).changes > 0;
            if (!deleted) return false;
            // Cached Bnovo projections must not survive a reconnect to a
            // different hotel account. Manager requests/audit events remain as
            // CRM history, but cannot be used as live PMS facts.
            DB.run('DELETE FROM pms_booking_guests WHERE businessId = ?', [businessId]);
            DB.run('DELETE FROM pms_bookings WHERE businessId = ? AND provider = ?', [businessId, 'bnovo']);
            DB.run('DELETE FROM pms_sync_jobs WHERE businessId = ? AND provider = ?', [businessId, 'bnovo']);
            return true;
        });
        return remove.immediate();
    }

    upsertBooking(businessId, provider, booking, currency = 'RUB') {
        businessId = this._businessId(businessId);
        const externalId = String(booking.id ?? booking.booking_id ?? '');
        if (!externalId) throw new Error('Bnovo booking id is required');
        const dates = booking.dates || {};
        const customer = booking.customer || {};
        const status = booking.status || {};
        const prices = Array.isArray(booking.prices) ? booking.prices : [];
        const price = prices[0] || {};
        const rowId = `pmsb_${businessId}_${provider}_${externalId}`;
        const safe = {
            id: externalId,
            hotel_id: booking.hotel_id ?? null,
            number: booking.number ?? null,
            status: { id: status.id ?? null, name: status.name ?? null },
            dates: { arrival: dates.arrival ?? null, departure: dates.departure ?? null, update_date: dates.update_date ?? null },
            extra: { adults: booking.extra?.adults ?? null, children: booking.extra?.children ?? null },
            room_type_name: price.room_type_name || booking.room_type_name || null,
            plan_name: booking.plan_name || price.plan_name || null,
        };
        DB.run(`
            INSERT INTO pms_bookings (
                id, businessId, provider, externalBookingId, externalHotelId, bookingNumber,
                statusCode, statusName, arrivalAt, departureAt, roomTypeId, roomTypeName,
                tariffId, tariffName, amount, currency, customerName, customerSurname,
                normalizedPhone, normalizedEmail, sourceUpdatedAt, sourceTimestamp, rawSafeJson, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(businessId, provider, externalBookingId) DO UPDATE SET
                externalHotelId=excluded.externalHotelId, bookingNumber=excluded.bookingNumber,
                statusCode=excluded.statusCode, statusName=excluded.statusName,
                arrivalAt=excluded.arrivalAt, departureAt=excluded.departureAt,
                roomTypeId=excluded.roomTypeId, roomTypeName=excluded.roomTypeName,
                tariffId=excluded.tariffId, tariffName=excluded.tariffName,
                amount=excluded.amount, currency=excluded.currency,
                customerName=excluded.customerName, customerSurname=excluded.customerSurname,
                normalizedPhone=excluded.normalizedPhone, normalizedEmail=excluded.normalizedEmail,
                sourceUpdatedAt=excluded.sourceUpdatedAt, sourceTimestamp=excluded.sourceTimestamp,
                rawSafeJson=excluded.rawSafeJson, updatedAt=CURRENT_TIMESTAMP
        `, [
            rowId, businessId, provider, externalId, booking.hotel_id != null ? String(booking.hotel_id) : null,
            booking.number || null, status.id != null ? String(status.id) : null, status.name || null,
            dates.arrival || null, dates.departure || null,
            price.room_type_id != null ? String(price.room_type_id) : null,
            price.room_type_name || booking.room_type_name || null,
            booking.plan_id != null ? String(booking.plan_id) : null,
            booking.plan_name || price.plan_name || null,
            Number(booking.amount ?? 0), currency,
            customer.name || null, customer.surname || null,
            normalizePhone(customer.phone) || null, normalizeEmail(customer.email) || null,
            dates.update_date || null, isoNow(), JSON.stringify(safe),
        ]);
        return DB.get('SELECT * FROM pms_bookings WHERE businessId = ? AND id = ?', [businessId, rowId]);
    }

    listBookings(businessId, filters = {}) {
        businessId = this._businessId(businessId);
        const phone = normalizePhone(filters.phone);
        const number = String(filters.bookingNumber || '').trim();
        const externalHotelId = filters.externalHotelId == null ? '' : String(filters.externalHotelId);
        const provider = String(filters.provider || '');
        const departureFrom = String(filters.departureFrom || '');
        return DB.all(`
            SELECT * FROM pms_bookings
            WHERE businessId = ?
              AND (? = '' OR normalizedPhone = ?)
              AND (? = '' OR LOWER(bookingNumber) = LOWER(?))
              AND (? = '' OR externalHotelId = ?)
              AND (? = '' OR provider = ?)
              AND (? = '' OR substr(departureAt, 1, 10) >= ?)
            ORDER BY arrivalAt ${filters.upcomingFirst === true ? 'ASC' : 'DESC'}
            LIMIT ?
        `, [businessId, phone, phone, number, number, externalHotelId, externalHotelId,
            provider, provider, departureFrom, departureFrom, Math.max(1, Math.min(int(filters.limit, 100), 500))]);
    }

    getBookingByExternalId(businessId, externalBookingId) {
        return DB.get('SELECT * FROM pms_bookings WHERE businessId = ? AND provider = ? AND externalBookingId = ?', [this._businessId(businessId), 'bnovo', String(externalBookingId)]);
    }

    replaceBookingGuests(businessId, bookingRowId, guests = []) {
        businessId = this._businessId(businessId);
        const booking = DB.get('SELECT id FROM pms_bookings WHERE businessId=? AND id=?', [businessId, bookingRowId]);
        if (!booking) throw new Error('Scoped PMS booking not found');
        const replace = DB.db.transaction((rows) => {
            DB.run('DELETE FROM pms_booking_guests WHERE businessId=? AND bookingId=?', [businessId, bookingRowId]);
            for (const guest of rows) {
                const externalId = String(guest.id ?? guest.guest_id ?? crypto.randomUUID());
                const scopedGuestId = crypto.createHash('sha256')
                    .update(`${businessId}:${bookingRowId}:${externalId}`)
                    .digest('hex')
                    .slice(0, 32);
                DB.run(`INSERT INTO pms_booking_guests (
                    id,businessId,bookingId,externalGuestId,name,surname,normalizedPhone,normalizedEmail
                ) VALUES (?,?,?,?,?,?,?,?)`, [
                    `pmsg_${businessId}_${scopedGuestId}`, businessId, bookingRowId, externalId,
                    guest.name || guest.first_name || null, guest.surname || guest.last_name || null,
                    normalizePhone(guest.phone) || null, normalizeEmail(guest.email) || null,
                ]);
            }
        });
        replace.immediate(Array.isArray(guests) ? guests : []);
        return DB.all('SELECT * FROM pms_booking_guests WHERE businessId=? AND bookingId=?', [businessId, bookingRowId]);
    }

    createBookingRequest(input = {}) {
        const businessId = this._businessId(input.businessId);
        const idempotencyKey = String(input.idempotencyKey || '').trim();
        if (!idempotencyKey) throw new Error('idempotency_key is required');
        const run = DB.db.transaction((data) => {
            const existing = DB.get('SELECT * FROM pms_booking_requests WHERE businessId = ? AND idempotencyKey = ?', [businessId, idempotencyKey]);
            if (existing) return { request: existing, idempotent: true };
            const requestId = id('pmsr');
            const eventId = id('event');
            const taskId = `task_booking_${crypto.createHash('sha256').update(`${businessId}:${idempotencyKey}`).digest('hex').slice(0, 24)}`;
            const summary = redact(data.summary || `Новая заявка на бронирование: ${data.arrivalDate} — ${data.departureDate}`, 800);
            DB.run(`INSERT INTO conversation_events (
                eventId, instanceId, chatId, customerId, channel, direction, role, content, callId, sourceId, metadataJson
            ) VALUES (?, ?, ?, ?, ?, 'internal', 'task', ?, ?, ?, ?)`, [
                eventId, businessId, data.chatId || null, data.customerId || null, data.channel,
                summary, data.callId || null, requestId, JSON.stringify({ reason: 'booking_request', requestId }),
            ]);
            DB.run(`INSERT INTO manager_tasks (
                taskId, instanceId, chatId, customerId, callId, phone, customerName, summary,
                reason, priority, status, source, conversationEventId, metadataJson
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'booking_request', 'high', 'new', 'pms', ?, ?)`, [
                taskId, businessId, data.chatId || null, data.customerId || null, data.callId || null,
                normalizePhone(data.callerNumber) || null, data.customerName || null, summary, eventId,
                JSON.stringify({ requestId, provider: 'bnovo' }),
            ]);
            DB.run(`INSERT INTO pms_booking_requests (
                id, businessId, provider, idempotencyKey, channel, callId, messageBatchId,
                chatId, customerId, callerNumber, customerName, arrivalDate, departureDate,
                adults, children, roomTypeId, roomTypeName, tariffId, tariffName,
                quotedTotal, currency, managerTaskId, detailsJson
            ) VALUES (?, ?, 'bnovo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                requestId, businessId, idempotencyKey, data.channel, data.callId || null,
                data.messageBatchId || null, data.chatId || null, data.customerId || null,
                normalizePhone(data.callerNumber) || null, data.customerName || null,
                data.arrivalDate, data.departureDate, Math.max(1, int(data.adults, 1)),
                Math.max(0, int(data.children, 0)), data.roomTypeId || null, data.roomTypeName || null,
                data.tariffId || null, data.tariffName || null,
                data.quotedTotal == null ? null : Number(data.quotedTotal), data.currency || 'RUB', taskId,
                JSON.stringify(data.details || {}),
            ]);
            DB.run(`INSERT INTO tool_runs (
                toolRunId, instanceId, chatId, customerId, callId, conversationEventId,
                toolName, phase, argsRedactedJson, resultRedactedJson, status
            ) VALUES (?, ?, ?, ?, ?, ?, 'create_booking_request', ?, ?, ?, 'ok')`, [
                id('tool'), businessId, data.chatId || null, data.customerId || null,
                data.callId || null, eventId, data.channel === 'voice' ? 'in_call' : 'chat',
                JSON.stringify({ arrivalDate: data.arrivalDate, departureDate: data.departureDate, adults: data.adults, children: data.children }),
                JSON.stringify({ requestId, taskId }),
            ]);
            return { request: DB.get('SELECT * FROM pms_booking_requests WHERE businessId = ? AND id = ?', [businessId, requestId]), idempotent: false };
        });
        return run.immediate(input);
    }

    listBookingRequests(businessId, filters = {}) {
        businessId = this._businessId(businessId);
        const status = String(filters.status || '');
        return DB.all(`SELECT * FROM pms_booking_requests WHERE businessId = ? AND (? = '' OR status = ?) ORDER BY createdAt DESC LIMIT ?`, [
            businessId, status, status, Math.max(1, Math.min(int(filters.limit, 100), 500)),
        ]);
    }

    enqueueJob(businessId, jobType, payload = {}, dedupeKey = null) {
        businessId = this._businessId(businessId);
        const jobId = id('pmsj');
        DB.run(`INSERT OR IGNORE INTO pms_sync_jobs (id, businessId, jobType, dedupeKey, payloadJson) VALUES (?, ?, ?, ?, ?)`, [
            jobId, businessId, jobType, dedupeKey || null, JSON.stringify(payload),
        ]);
        return dedupeKey
            ? DB.get('SELECT * FROM pms_sync_jobs WHERE businessId = ? AND provider = ? AND dedupeKey = ?', [businessId, 'bnovo', dedupeKey])
            : DB.get('SELECT * FROM pms_sync_jobs WHERE businessId = ? AND id = ?', [businessId, jobId]);
    }

    leaseDueJobs(limit = 5, ttlSeconds = 120) {
        const lease = DB.db.transaction(() => {
            const now = isoNow();
            DB.run(`UPDATE pms_sync_jobs SET state='retry', leaseToken=NULL, leaseExpiresAt=NULL,
                lastErrorCode='PMS_JOB_LEASE_EXPIRED', lastErrorMessage='Worker lease expired; job recovered',
                updatedAt=CURRENT_TIMESTAMP WHERE state='leased' AND leaseExpiresAt <= ?`, [now]);
            const rows = DB.all(`SELECT * FROM pms_sync_jobs
                WHERE state IN ('pending','retry') AND nextAttemptAt <= ?
                  AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)
                ORDER BY nextAttemptAt ASC LIMIT ?`, [now, now, Math.max(1, Math.min(int(limit, 5), 20))]);
            return rows.map((row) => {
                const token = crypto.randomUUID();
                const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
                DB.run(`UPDATE pms_sync_jobs SET state='leased', leaseToken=?, leaseExpiresAt=?, attempts=attempts+1, updatedAt=CURRENT_TIMESTAMP
                    WHERE id=? AND businessId=? AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)`, [token, expires, row.id, row.businessId, now]);
                return DB.get('SELECT * FROM pms_sync_jobs WHERE id=? AND businessId=? AND leaseToken=?', [row.id, row.businessId, token]);
            }).filter(Boolean);
        });
        return lease.immediate();
    }

    finalizeJob(businessId, jobId, leaseToken, outcome = {}) {
        businessId = this._businessId(businessId);
        const job = DB.get('SELECT * FROM pms_sync_jobs WHERE id=? AND businessId=? AND leaseToken=? AND state=?', [jobId, businessId, leaseToken, 'leased']);
        if (!job) return false;
        const retry = Boolean(outcome.retryable) && job.attempts < job.maxAttempts;
        const nextAttemptAt = retry ? new Date(Date.now() + Math.min(3600, 30 * (2 ** Math.max(0, job.attempts - 1))) * 1000).toISOString() : null;
        DB.run(`UPDATE pms_sync_jobs SET state=?, nextAttemptAt=COALESCE(?,nextAttemptAt), leaseToken=NULL, leaseExpiresAt=NULL,
            lastErrorCode=?, lastErrorMessage=?, completedAt=?, updatedAt=CURRENT_TIMESTAMP WHERE id=? AND businessId=? AND leaseToken=?`, [
            outcome.success ? 'completed' : retry ? 'retry' : 'dead_letter', nextAttemptAt,
            outcome.errorCode || null, redact(outcome.errorMessage || '', 500) || null,
            outcome.success || !retry ? isoNow() : null, jobId, businessId, leaseToken,
        ]);
        return true;
    }

    audit(businessId, event = {}) {
        businessId = this._businessId(businessId);
        DB.run(`INSERT INTO pms_audit_events (id,businessId,correlationId,eventType,operation,status,httpStatus,latencyMs,errorCode,message,metadataJson)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
            id('pmsa'), businessId, event.correlationId || null, event.eventType || 'request', event.operation || null,
            event.status || 'ok', event.httpStatus || null, event.latencyMs || null, event.errorCode || null,
            redact(event.message || '', 500) || null, JSON.stringify(event.metadata || {}),
        ]);
    }

    diagnostics(businessId) {
        businessId = this._businessId(businessId);
        const queues = DB.all(`SELECT state, COUNT(*) total FROM pms_sync_jobs WHERE businessId=? GROUP BY state`, [businessId]);
        const requests = DB.get(`SELECT COUNT(*) requestCount, AVG(latencyMs) averageLatencyMs,
            SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errorCount,
            SUM(CASE WHEN errorCode='BNOVO_RATE_LIMIT' OR httpStatus=429 THEN 1 ELSE 0 END) rateLimitCount,
            SUM(CASE WHEN eventType='auth_refresh' THEN 1 ELSE 0 END) authRefreshCount
            FROM pms_audit_events WHERE businessId=? AND createdAt >= datetime('now','-24 hours')`, [businessId]) || {};
        const integration = this.getIntegration(businessId);
        const ageSeconds = (value) => {
            const timestamp = Date.parse(String(value || ''));
            return Number.isFinite(timestamp) ? Math.max(0, Math.round((Date.now() - timestamp) / 1000)) : null;
        };
        return {
            queue_depth: Object.fromEntries(queues.map((row) => [row.state, Number(row.total)])),
            requests_24h: Number(requests.requestCount || 0),
            errors_24h: Number(requests.errorCount || 0),
            auth_refresh_24h: Number(requests.authRefreshCount || 0),
            rate_limit_24h: Number(requests.rateLimitCount || 0),
            average_latency_ms_24h: requests.averageLatencyMs == null ? null : Math.round(Number(requests.averageLatencyMs)),
            last_sync_at: integration?.lastSyncAt || null,
            sync_lag_seconds: ageSeconds(integration?.lastSyncAt),
            last_webhook_at: integration?.lastWebhookAt || null,
            webhook_age_seconds: ageSeconds(integration?.lastWebhookAt),
            last_successful_availability_at: integration?.lastSuccessfulAvailabilityAt || null,
        };
    }
}

module.exports = new PmsStore();
module.exports.PmsStore = PmsStore;
