const crypto = require('crypto');
const DB = require('../database.service');
const Store = require('./pms-store.service');
const BnovoPmsProvider = require('./bnovo-pms.provider');
const { encryptJson, decryptJson, randomOpaqueToken, hashOpaqueToken } = require('./pms-crypto');
const { parseJson, normalizePhone, redact, correlationId, isoNow } = require('./pms-utils');

function httpError(statusCode, message, code) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
}
function dateOnly(value) {
    const text = String(value || '');
    const parsed = new Date(`${text}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
        throw httpError(400, 'Date must use YYYY-MM-DD format', 'PMS_DATE_INVALID');
    }
    return text;
}
function plusDays(value, days) {
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}
function diffDays(from, to) { return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000); }
function idList(value) { return (Array.isArray(value) ? value : []).map(String).filter(Boolean); }
function nonnegativeNumber(value, integer = false) {
    // Number(null), Number('') and Number(false) are zero, not provider evidence.
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && (!integer || Number.isInteger(number)) ? number : null;
}
function sourceIsStale(timestamp, now) {
    if (typeof timestamp !== 'string' || !timestamp.trim()) return true;
    const value = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(timestamp)
        ? `${timestamp.replace(' ', 'T')}Z` : timestamp;
    const age = now.getTime() - Date.parse(value);
    return !Number.isFinite(age) || age < 0 || age > 15 * 60 * 1000;
}

class PmsService {
    constructor() {
        this.now = () => new Date();
        this.running = false;
        this.timer = null;
        this.lastIncrementalBucket = new Map();
        this.lastReconciliationDate = new Map();
        this.clientCache = new Map();
    }

    safeIntegration(row) {
        if (!row) return null;
        const mappings = parseJson(row.mappingsJson, {});
        return {
            business_id: Number(row.businessId),
            provider: row.provider,
            enabled: Boolean(row.enabled),
            mode: row.mode,
            currency: row.currency || 'RUB',
            masked_account: row.accountIdMasked || null,
            external_hotel_id: row.externalHotelId || null,
            mappings,
            connection_status: row.connectionStatus,
            polling_status: row.pollingStatus,
            webhook_status: row.webhookStatus,
            last_sync_at: row.lastSyncAt || null,
            last_successful_availability_at: row.lastSuccessfulAvailabilityAt || null,
            last_webhook_at: row.lastWebhookAt || null,
            last_error: row.lastErrorCode ? { code: row.lastErrorCode, message: redact(row.lastErrorMessage || '') } : null,
            credentials_configured: Boolean(row.credentialsEncrypted),
            diagnostics: Store.diagnostics(row.businessId),
        };
    }

    get(businessId) { return this.safeIntegration(Store.getIntegration(businessId)); }

    configure(businessId, input = {}) {
        const existing = Store.getIntegration(businessId);
        let credentials = existing?.credentialsEncrypted ? decryptJson(existing.credentialsEncrypted) : {};
        const accountId = input.account_id ?? input.accountId;
        const password = input.api_password ?? input.apiPassword ?? input.password;
        if (accountId !== undefined && String(accountId) !== '' && !String(accountId).includes('•')) credentials.accountId = Number(accountId);
        if (password !== undefined && String(password) !== '' && !String(password).includes('•')) credentials.password = String(password);
        if (!Number.isInteger(Number(credentials.accountId)) || Number(credentials.accountId) < 1 || !credentials.password) {
            throw httpError(400, 'Bnovo account ID and API password are required', 'BNOVO_CREDENTIALS_REQUIRED');
        }

        let webhookTokenHash = existing?.webhookTokenHash;
        let webhookTokenEncrypted = existing?.webhookTokenEncrypted;
        if (!webhookTokenHash || !webhookTokenEncrypted) {
            const token = randomOpaqueToken();
            webhookTokenHash = hashOpaqueToken(token);
            webhookTokenEncrypted = encryptJson({ token });
        }
        const existingMappings = parseJson(existing?.mappingsJson, {});
        const row = Store.upsertIntegration(businessId, {
            provider: 'bnovo',
            enabled: Boolean(input.enabled ?? existing?.enabled ?? false),
            mode: 'read_only',
            externalHotelId: input.external_hotel_id ?? input.externalHotelId ?? existing?.externalHotelId ?? null,
            accountIdMasked: `••••${String(credentials.accountId).slice(-4)}`,
            credentialsEncrypted: encryptJson(credentials),
            currency: String(input.currency || existing?.currency || 'RUB').toUpperCase().slice(0, 3),
            mappings: input.mappings ? { ...existingMappings, ...input.mappings } : existingMappings,
            webhookTokenHash,
            webhookTokenEncrypted,
            connectionStatus: accountId !== undefined || password !== undefined ? 'not_tested' : existing?.connectionStatus,
        });
        this.clientCache.delete(Number(businessId));
        Store.audit(businessId, { eventType: 'configuration', operation: 'configure', status: 'ok', metadata: { enabled: Boolean(row.enabled), provider: 'bnovo' } });
        return this.safeIntegration(row);
    }

    disconnect(businessId) {
        this.clientCache.delete(Number(businessId));
        const deleted = Store.deleteIntegration(businessId);
        return { deleted };
    }

    _provider(businessId, correlation) {
        const row = Store.getIntegration(businessId);
        if (!row) throw httpError(404, 'PMS integration is not configured', 'PMS_NOT_CONFIGURED');
        const scopedBusinessId = Number(row.businessId);
        const fingerprint = crypto.createHash('sha256').update(String(row.credentialsEncrypted)).digest('hex');
        let cached = this.clientCache.get(scopedBusinessId);
        if (!cached || cached.fingerprint !== fingerprint) {
            const credentials = decryptJson(row.credentialsEncrypted);
            cached = {
                fingerprint,
                client: new BnovoPmsProvider({
                    businessId: scopedBusinessId,
                    accountId: credentials.accountId,
                    password: credentials.password,
                    metrics: (event, data) => Store.audit(scopedBusinessId, {
                        correlationId: data.correlationId || null, eventType: event, operation: data.url || event,
                        status: data.status === 'error' || Number(data.status) >= 400 ? 'error' : 'ok',
                        httpStatus: Number(data.status) || null, latencyMs: data.latencyMs,
                        errorCode: data.errorCode || null, metadata: { retryable: data.retryable },
                    }),
                }),
            };
            this.clientCache.set(scopedBusinessId, cached);
        }
        return {
            row,
            client: cached.client,
        };
    }

    _enabledIntegration(businessId) {
        const row = Store.getIntegration(businessId);
        if (!row) throw httpError(404, 'PMS integration is not configured', 'PMS_NOT_CONFIGURED');
        if (!row.enabled) throw httpError(503, 'PMS tools are disabled for this business', 'PMS_DISABLED');
        return row;
    }

    _isOptionalV2AccessDenied(error) {
        return error?.code === 'BNOVO_CONFIGURATION_ERROR' && Number(error?.statusCode) === 403;
    }

    async _optionalV2List(client, method, correlation) {
        try {
            return { available: true, items: await client[method](correlation) };
        } catch (error) {
            if (!this._isOptionalV2AccessDenied(error)) throw error;
            return { available: false, items: [] };
        }
    }

    async test(businessId, requestId, { beforeWrite = () => {} } = {}) {
        const correlation = correlationId(requestId);
        const { row, client } = this._provider(businessId, correlation);
        try {
            const [, roomCatalog, tariffCatalog] = await Promise.all([
                client.testConnection(correlation),
                this._optionalV2List(client, 'listRoomTypes', correlation),
                this._optionalV2List(client, 'listTariffs', correlation),
            ]);
            const roomTypes = roomCatalog.items;
            const tariffs = tariffCatalog.items;
            const hotelIds = [...new Set(roomTypes.map((item) => item.hotel_id).filter((value) => value != null).map(String))];
            let externalHotelId = row.externalHotelId || null;
            if (!externalHotelId && hotelIds.length === 1) externalHotelId = hotelIds[0];
            if (!externalHotelId && hotelIds.length > 1) {
                throw httpError(409, 'Bnovo account contains multiple hotels; select an external hotel ID', 'BNOVO_HOTEL_SELECTION_REQUIRED');
            }
            if (!externalHotelId) {
                throw httpError(409, 'Bnovo hotel ID could not be resolved from room types', 'BNOVO_HOTEL_ID_UNAVAILABLE');
            }
            if (hotelIds.length && !hotelIds.includes(String(externalHotelId))) {
                throw httpError(409, 'Configured Bnovo hotel ID is not available to this account', 'BNOVO_HOTEL_SCOPE_MISMATCH');
            }
            const mappings = parseJson(row.mappingsJson, {});
            mappings.available_room_types = roomTypes
                .filter((item) => String(item.hotel_id) === String(externalHotelId))
                .map((item) => ({ id: String(item.id), name: item.name }));
            mappings.available_tariffs = tariffs.map((item) => ({ id: String(item.id), name: item.name }));
            const capabilities = {
                bookings: true,
                booking_requests: true,
                room_types: roomCatalog.available,
                tariffs: tariffCatalog.available,
                availability: roomCatalog.available && tariffCatalog.available,
            };
            mappings.capabilities = capabilities;
            beforeWrite();
            const updated = Store.updateIntegrationStatus(businessId, {
                connectionStatus: capabilities.availability ? 'connected' : 'connected_limited',
                externalHotelId: String(externalHotelId), mappings,
                lastErrorCode: null, lastErrorMessage: null,
            });
            return {
                pms: this.safeIntegration(updated), capabilities,
                provider: 'bnovo', business_id: Number(businessId), correlation_id: correlation,
            };
        } catch (error) {
            beforeWrite();
            Store.updateIntegrationStatus(businessId, { connectionStatus: 'error', lastErrorCode: error.code, lastErrorMessage: error.message });
            throw error;
        }
    }

    enqueueInitialSync(businessId) {
        const today = new Date().toISOString().slice(0, 10);
        const start = plusDays(today, -365);
        const end = plusDays(today, 730);
        const jobs = [];
        for (let cursor = start; cursor < end; cursor = plusDays(cursor, 31)) {
            const dateTo = plusDays(cursor, Math.min(30, diffDays(cursor, end)));
            jobs.push(Store.enqueueJob(businessId, 'bookings_range', { dateFrom: cursor, dateTo }, `initial:${cursor}:${dateTo}`));
        }
        Store.updateIntegrationStatus(businessId, { pollingStatus: 'queued', lastErrorCode: null, lastErrorMessage: null });
        return { queued: jobs.length, business_id: Number(businessId), provider: 'bnovo' };
    }

    enqueueIncrementalSync(businessId) {
        const today = new Date().toISOString().slice(0, 10);
        return Store.enqueueJob(businessId, 'bookings_range', { dateFrom: plusDays(today, -2), dateTo: plusDays(today, 31), dataType: 'changed' }, `incremental:${Math.floor(Date.now() / 300000)}`);
    }

    _enrichBookingCatalog(booking, roomTypes = []) {
        const roomTypeId = booking?.actual_price?.room_type_id
            ?? booking?.prices?.[0]?.room_type_id
            ?? booking?.room_type_id;
        const roomType = roomTypes.find((item) => String(item.id) === String(roomTypeId));
        if (roomType && !booking.room_type_name) booking.room_type_name = roomType.name;
        if (booking.plan_id == null && booking?.actual_price?.plan_id != null) booking.plan_id = booking.actual_price.plan_id;
        return booking;
    }

    async processSyncJob(job) {
        const payload = parseJson(job.payloadJson, {});
        const correlation = correlationId(job.id);
        const { row, client } = this._provider(job.businessId, correlation);
        try {
            if (job.jobType === 'booking_refresh') {
                const [booking, guestsPayload, customerPayload, roomTypes] = await Promise.all([
                    client.getBooking(payload.bookingId, correlation),
                    client.getBookingGuests(payload.bookingId, correlation),
                    client.getBookingCustomer(payload.bookingId, correlation),
                    client.listRoomTypes(correlation),
                ]);
                if (customerPayload && !booking.customer) booking.customer = customerPayload.customer || customerPayload;
                this._enrichBookingCatalog(booking, roomTypes);
                if (row.externalHotelId && String(booking.hotel_id) !== String(row.externalHotelId)) {
                    throw httpError(409, 'Webhook booking belongs to another Bnovo hotel', 'BNOVO_HOTEL_SCOPE_MISMATCH');
                }
                const stored = Store.upsertBooking(job.businessId, 'bnovo', booking, row.currency);
                Store.replaceBookingGuests(job.businessId, stored.id, guestsPayload?.guests || (Array.isArray(guestsPayload) ? guestsPayload : []));
                await this._syncGuestIdentity(job.businessId, booking);
            } else if (job.jobType === 'plans_refresh') {
                await Promise.all([client.listRoomTypes(correlation), client.listTariffs(correlation)]);
            } else {
                const bookings = await client.listBookings({
                    dateFrom: payload.dateFrom, dateTo: payload.dateTo,
                    dataType: payload.dataType || 'checkmate', correlationId: correlation,
                });
                const roomCatalog = await this._optionalV2List(client, 'listRoomTypes', correlation);
                const roomTypes = roomCatalog.items;
                for (const booking of bookings) {
                    if (row.externalHotelId && booking.hotel_id != null && String(booking.hotel_id) !== String(row.externalHotelId)) continue;
                    this._enrichBookingCatalog(booking, roomTypes);
                    const stored = Store.upsertBooking(job.businessId, 'bnovo', booking, row.currency);
                    const guests = Array.isArray(booking.guests)
                        ? booking.guests
                        : Array.isArray(booking.customers)
                            ? booking.customers
                            : booking.customer ? [booking.customer] : [];
                    Store.replaceBookingGuests(job.businessId, stored.id, guests);
                    await this._syncGuestIdentity(job.businessId, booking);
                }
            }
            Store.finalizeJob(job.businessId, job.id, job.leaseToken, { success: true });
            Store.updateIntegrationStatus(job.businessId, { pollingStatus: 'healthy', lastSyncAt: isoNow(), lastErrorCode: null, lastErrorMessage: null });
        } catch (error) {
            Store.finalizeJob(job.businessId, job.id, job.leaseToken, { success: false, retryable: error.retryable, errorCode: error.code, errorMessage: error.message });
            Store.updateIntegrationStatus(job.businessId, { pollingStatus: error.retryable ? 'retrying' : 'error', lastErrorCode: error.code, lastErrorMessage: error.message });
        }
    }

    async _syncGuestIdentity(businessId, booking) {
        const departure = String(booking?.dates?.departure || '').slice(0, 10);
        if (departure && departure < new Date().toISOString().slice(0, 10)) return null;
        const phone = normalizePhone(booking?.customer?.phone);
        if (!phone) return null;
        const chatId = `${phone}@c.us`;
        const name = [booking?.customer?.name, booking?.customer?.surname].filter(Boolean).join(' ').trim() || 'Гость Bnovo';
        // getOrCreate never sends a message and never rewrites an existing CRM stage.
        return DB.getOrCreateClient(Number(businessId), chatId, name);
    }

    async runJobsOnce() {
        if (this.running) return 0;
        this.running = true;
        try {
            const jobs = Store.leaseDueJobs(5, 180);
            for (const job of jobs) await this.processSyncJob(job);
            return jobs.length;
        } finally { this.running = false; }
    }

    scheduleDueJobs() {
        const fiveMinuteBucket = Math.floor(Date.now() / 300000);
        for (const integration of Store.listEnabledIntegrations()) {
            const businessId = Number(integration.businessId);
            if (this.lastIncrementalBucket.get(businessId) !== fiveMinuteBucket) {
                this.lastIncrementalBucket.set(businessId, fiveMinuteBucket);
                this.enqueueIncrementalSync(businessId);
            }
            const timezone = integration.hotelTimezone || 'UTC';
            let parts;
            try {
                parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
                    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
                }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
            } catch (_) { parts = null; }
            if (parts && parts.hour === '03' && Number(parts.minute) >= 30) {
                const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
                if (this.lastReconciliationDate.get(businessId) !== dateKey) {
                    this.lastReconciliationDate.set(businessId, dateKey);
                    const start = plusDays(dateKey, -31);
                    const end = plusDays(dateKey, 365);
                    for (let cursor = start; cursor < end; cursor = plusDays(cursor, 31)) {
                        const dateTo = plusDays(cursor, Math.min(30, diffDays(cursor, end)));
                        Store.enqueueJob(businessId, 'bookings_range', { dateFrom: cursor, dateTo }, `reconcile:${dateKey}:${cursor}:${dateTo}`);
                    }
                }
            }
        }
    }

    start() {
        if (this.timer || process.env.PMS_ENABLED === 'false') return;
        this.scheduleDueJobs();
        this.timer = setInterval(() => {
            this.scheduleDueJobs();
            this.runJobsOnce().catch(() => {});
        }, 15_000);
        this.timer.unref?.();
    }

    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

    handleWebhook(token, body = {}) {
        const tokenHash = hashOpaqueToken(token);
        const row = Store.findIntegrationByWebhookTokenHash(tokenHash);
        if (!row) throw httpError(404, 'Webhook not found', 'PMS_WEBHOOK_NOT_FOUND');
        const externalHotelId = body.external_hotel_id ?? body.hotel_id ?? body.data?.external_hotel_id ?? body.data?.hotel_id;
        if (row.externalHotelId && String(externalHotelId) !== String(row.externalHotelId)) {
            throw httpError(403, 'Bnovo hotel scope mismatch', 'BNOVO_HOTEL_SCOPE_MISMATCH');
        }
        const type = body.type || body.event || body.data?.type || 'booking';
        const bookingId = body.booking_id ?? body.data?.booking_id ?? body.data?.id;
        const payloadDigest = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const dedupeRaw = JSON.stringify({ type, externalHotelId, bookingId, eventId: body.id || body.event_id || null, payloadDigest });
        const dedupe = `webhook:${crypto.createHash('sha256').update(dedupeRaw).digest('hex')}`;
        const today = new Date().toISOString().slice(0, 10);
        const job = type === 'plans_data_update'
            ? Store.enqueueJob(row.businessId, 'plans_refresh', {}, dedupe)
            : bookingId != null
                ? Store.enqueueJob(row.businessId, 'booking_refresh', { bookingId }, dedupe)
                : Store.enqueueJob(row.businessId, 'bookings_range', {
                    dateFrom: plusDays(today, -2), dateTo: plusDays(today, 31), dataType: 'changed',
                }, dedupe);
        Store.updateIntegrationStatus(row.businessId, { webhookStatus: 'receiving', lastWebhookAt: isoNow(), lastErrorCode: null, lastErrorMessage: null });
        Store.audit(row.businessId, { eventType: 'webhook', operation: type, status: 'accepted', metadata: { jobId: job.id } });
        return { accepted: true, business_id: Number(row.businessId), provider: 'bnovo', job_id: job.id };
    }

    async connectWebhooks(businessId, publicBaseUrl, requestId, { beforeWrite = () => {} } = {}) {
        const correlation = correlationId(requestId);
        const { row, client } = this._provider(businessId, correlation);
        const token = decryptJson(row.webhookTokenEncrypted).token;
        const base = String(publicBaseUrl || process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
        if (!/^https:\/\//i.test(base)) throw httpError(400, 'PUBLIC_BASE_URL with HTTPS is required', 'PMS_PUBLIC_URL_REQUIRED');
        const url = `${base}/api/integrations/bnovo/webhooks/${token}`;
        try {
            const existing = await client.listWebhookSubscribers(correlation);
            const subscribers = Array.isArray(existing) ? existing : [];
            for (const type of ['booking', 'plans_data_update']) {
                if (!subscribers.some((item) => item.url === url && item.type === type)) { beforeWrite(); await client.createWebhookSubscriber(url, type, correlation); }
            }
        } catch (error) {
            beforeWrite();
            const errorCode = error.code || 'PMS_WEBHOOK_CONFIGURATION_ERROR';
            Store.updateIntegrationStatus(businessId, {
                webhookStatus: 'configuration_error',
                lastErrorCode: errorCode,
                lastErrorMessage: redact(error.message || 'Webhook configuration failed', 500),
            });
            Store.audit(businessId, {
                eventType: 'webhook',
                operation: 'configure',
                status: 'failed',
                correlationId: correlation,
                errorCode,
                message: error.message,
                metadata: { errorCode },
            });
            throw error;
        }
        beforeWrite();
        const updated = Store.updateIntegrationStatus(businessId, { webhookStatus: 'activation_pending', lastErrorCode: null, lastErrorMessage: null });
        return { pms: this.safeIntegration(updated), activation_may_take_hours: 24, provider: 'bnovo', business_id: Number(businessId) };
    }

    _safeBooking(row) {
        return {
            business_id: Number(row.businessId), provider: row.provider,
            booking_id: row.externalBookingId, booking_number: row.bookingNumber,
            status: row.statusName || row.statusCode, arrival: row.arrivalAt, departure: row.departureAt,
            category: row.roomTypeName, tariff: row.tariffName, amount: row.amount, currency: row.currency,
            customer: { name: row.customerName, surname: row.customerSurname },
            source_timestamp: row.sourceTimestamp, stale: sourceIsStale(row.sourceTimestamp, this.now()),
        };
    }

    lookupBooking(businessId, input = {}) {
        this._enabledIntegration(businessId);
        const phone = normalizePhone(input.caller_number || input.phone);
        const bookingNumber = String(input.booking_number || '').trim();
        if (!phone && !bookingNumber) throw httpError(400, 'Current phone or booking number is required', 'PMS_LOOKUP_KEY_REQUIRED');
        const rows = Store.listBookings(businessId, { phone: bookingNumber ? '' : phone, bookingNumber, limit: 20 });
        let matches = rows;
        if (bookingNumber) {
            const surname = String(input.surname || '').trim().toLowerCase();
            if (!surname) throw httpError(400, 'Surname is required with booking number', 'PMS_SURNAME_REQUIRED');
            matches = rows.filter((row) => String(row.customerSurname || '').trim().toLowerCase() === surname);
        }
        return {
            business_id: Number(businessId), provider: 'bnovo', source_timestamp: isoNow(), stale: false,
            bookings: matches.map((row) => this._safeBooking(row)), correlation_id: correlationId(input.correlation_id),
        };
    }

    async bookingServices(businessId, input = {}) {
        this._enabledIntegration(businessId);
        const cached = Store.getBookingByExternalId(businessId, input.booking_id);
        if (!cached) throw httpError(404, 'Booking not found in this business', 'PMS_BOOKING_NOT_FOUND');
        const correlation = correlationId(input.correlation_id);
        const { client } = this._provider(businessId, correlation);
        const raw = await client.getBookingServices(cached.externalBookingId, correlation);
        const services = (raw?.services || (Array.isArray(raw) ? raw : [])).map((item) => ({
            name: item.name || item.service_name || null,
            quantity: Number(item.quantity || 1),
            amount: item.amount == null ? null : Number(item.amount),
        }));
        return { business_id: Number(businessId), provider: 'bnovo', booking_id: cached.externalBookingId, services, source_timestamp: isoNow(), stale: false, correlation_id: correlation };
    }

    async checkAvailability(businessId, input = {}) {
        const dateFrom = dateOnly(input.date_from || input.arrival_date);
        const dateTo = dateOnly(input.date_to || input.departure_date);
        const nights = diffDays(dateFrom, dateTo);
        if (nights < 1 || nights > 45) throw httpError(400, 'Stay must be between 1 and 45 nights', 'PMS_DATE_RANGE_INVALID');
        const correlation = correlationId(input.correlation_id);
        const { row, client } = this._provider(businessId, correlation);
        if (!row.enabled) throw httpError(503, 'PMS tools are disabled for this business', 'PMS_DISABLED');
        const mappings = parseJson(row.mappingsJson, {});
        try {
            const [availability, roomTypes, tariffs] = await Promise.all([
                client.getAvailability({ dateFrom, dateTo, correlationId: correlation }),
                client.listRoomTypes(correlation), client.listTariffs(correlation),
            ]);
            const allowedRooms = new Set(idList(mappings.enabled_room_type_ids));
            const allowedTariffs = new Set(idList(mappings.enabled_tariff_ids));
            const categories = [];
            let incompletePrices = false;
            for (const room of roomTypes) {
                const roomId = String(room.id);
                if (allowedRooms.size && !allowedRooms.has(roomId)) continue;
                const item = availability?.[roomId] || {};
                const dailyAvailability = item.availability || {};
                const nightlyAvailability = [];
                for (let day = dateFrom; day < dateTo; day = plusDays(day, 1)) {
                    const available = nonnegativeNumber(dailyAvailability[day], true);
                    if (available === null) {
                        throw httpError(502, 'Bnovo availability is missing or invalid for a stay date', 'PMS_AVAILABILITY_INCOMPLETE');
                    }
                    nightlyAvailability.push(available);
                }
                const minimum = Math.min(...nightlyAvailability);
                if (minimum < 1) continue;
                const offers = [];
                for (const tariff of tariffs) {
                    const tariffId = String(tariff.id);
                    if (allowedTariffs.size && !allowedTariffs.has(tariffId)) continue;
                    const allPrices = {};
                    for (let cursor = dateFrom; cursor < dateTo; cursor = plusDays(cursor, 7)) {
                        const chunkEnd = plusDays(cursor, Math.min(7, diffDays(cursor, dateTo)));
                        Object.assign(allPrices, (await client.getTariffPrices(tariffId, { dateFrom: cursor, dateTo: chunkEnd, correlationId: correlation }))?.[roomId] || {});
                    }
                    const nightly = [];
                    for (let day = dateFrom; day < dateTo; day = plusDays(day, 1)) {
                        const price = nonnegativeNumber(allPrices?.[day]?.price);
                        if (price === null) { nightly.length = 0; incompletePrices = true; break; }
                        nightly.push({ date: day, price });
                    }
                    if (nightly.length === nights) offers.push({ tariff_id: tariffId, tariff: tariff.name, nightly, total: nightly.reduce((sum, item) => sum + item.price, 0), currency: row.currency || 'RUB' });
                }
                if (offers.length) categories.push({ room_type_id: roomId, category: room.name, minimum_availability: minimum, offers });
            }
            if (!categories.length && incompletePrices) {
                throw httpError(502, 'Bnovo prices do not cover the stay; availability cannot be quoted', 'PMS_PRICES_INCOMPLETE');
            }
            Store.updateIntegrationStatus(businessId, { lastSuccessfulAvailabilityAt: isoNow(), lastErrorCode: null, lastErrorMessage: null });
            return { business_id: Number(businessId), provider: 'bnovo', date_from: dateFrom, date_to: dateTo, nights, categories, source_timestamp: isoNow(), stale: false, correlation_id: correlation };
        } catch (error) {
            Store.updateIntegrationStatus(businessId, { lastErrorCode: error.code || 'BNOVO_AVAILABILITY_FAILED', lastErrorMessage: error.message });
            if (this._isOptionalV2AccessDenied(error)) {
                return {
                    business_id: Number(businessId), provider: 'bnovo',
                    date_from: dateFrom, date_to: dateTo, nights,
                    categories: [], live_check_available: false,
                    availability_status: 'unsupported_by_account',
                    error_code: 'PMS_LIVE_AVAILABILITY_UNAVAILABLE',
                    manager_task_created: false, requires_manager: false,
                    source_timestamp: isoNow(), stale: false,
                    correlation_id: correlation,
                };
            }
            error.code = error.code || 'BNOVO_AVAILABILITY_FAILED';
            throw error;
        }
    }

    createBookingRequest(businessId, input = {}) {
        this._enabledIntegration(businessId);
        const dateFrom = dateOnly(input.date_from || input.arrival_date);
        const dateTo = dateOnly(input.date_to || input.departure_date);
        if (diffDays(dateFrom, dateTo) < 1) throw httpError(400, 'Departure must be after arrival', 'PMS_DATE_RANGE_INVALID');
        const channel = ['voice', 'whatsapp'].includes(input.channel) ? input.channel : 'voice';
        const sourceId = channel === 'voice' ? input.call_id : input.message_batch_id;
        if (!sourceId) throw httpError(400, 'call_id or message_batch_id is required', 'PMS_IDEMPOTENCY_CONTEXT_REQUIRED');
        const key = crypto.createHash('sha256').update(`${Number(businessId)}:${channel}:${sourceId}`).digest('hex');
        const result = Store.createBookingRequest({
            businessId, idempotencyKey: key, channel, callId: input.call_id,
            messageBatchId: input.message_batch_id, chatId: input.chat_id,
            customerId: input.customer_id, callerNumber: input.caller_number,
            customerName: input.name || input.customer_name, arrivalDate: dateFrom,
            departureDate: dateTo, adults: input.adults, children: input.children,
            roomTypeId: input.room_type_id, roomTypeName: input.room_type_name,
            tariffId: input.tariff_id, tariffName: input.tariff_name,
            quotedTotal: input.quoted_total, currency: input.currency || Store.getIntegration(businessId)?.currency || 'RUB',
            details: { wishes: redact(input.wishes || '', 500) },
            summary: input.summary,
        });
        return {
            business_id: Number(businessId), provider: 'bnovo', request_id: result.request.id,
            manager_task_id: result.request.managerTaskId, status: result.request.status,
            idempotent: result.idempotent, source_timestamp: result.request.createdAt,
            stale: false, correlation_id: correlationId(input.correlation_id),
        };
    }

    customerContext(businessId, phone) {
        businessId = Store._businessId(businessId);
        const empty = { business_id: businessId, provider: 'bnovo', upcoming_bookings: [],
            source_timestamp: null, stale: true, has_active_booking: null,
            live_availability_confirmed: false };
        const normalized = normalizePhone(phone);
        if (!/^\+?[\d ()-]+$/.test(String(phone || '')) || !/^[1-9]\d{7,14}$/.test(normalized)) {
            // Store.listBookings intentionally supports an unfiltered admin list.
            // Customer context must never reach that branch for a missing identity.
            return { ...empty, identity_required: true, status: 'verified_phone_required' };
        }
        const integration = Store.getIntegration(businessId);
        const business = DB.get('SELECT hotelTimezone FROM instances WHERE id = ? AND isActive = 1', [businessId]);
        if (!business || !integration?.enabled || !integration.externalHotelId) {
            return { ...empty, status: 'not_connected' };
        }
        const now = this.now();
        let today;
        try {
            const parts = new Intl.DateTimeFormat('en', { timeZone: business.hotelTimezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
            const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
            today = `${values.year}-${values.month}-${values.day}`;
        } catch (_) { return { ...empty, status: 'invalid_hotel_timezone' }; }
        const rows = Store.listBookings(businessId, { phone: normalized, provider: 'bnovo',
            externalHotelId: integration.externalHotelId, departureFrom: today, upcomingFirst: true, limit: 500 })
            .filter(row => !/cancel|отмен|аннул|no.?show|не.?заезд/i.test(String(row.statusName || row.statusCode || '')))
            .slice(0, 5);
        const upcoming = rows.map(row => this._safeBooking(row));
        return { ...empty, status: 'cached_projection', upcoming_bookings: upcoming,
            source_timestamp: integration.lastSyncAt || null,
            stale: sourceIsStale(integration.lastSyncAt, now) || upcoming.some(row => row.stale) };
    }

    listBookings(businessId, filters) { return Store.listBookings(businessId, filters).map((row) => this._safeBooking(row)); }
    listBookingRequests(businessId, filters) { return Store.listBookingRequests(businessId, filters).map((row) => ({ ...row, details: parseJson(row.detailsJson, {}), detailsJson: undefined })); }
}

module.exports = new PmsService();
module.exports.PmsService = PmsService;
