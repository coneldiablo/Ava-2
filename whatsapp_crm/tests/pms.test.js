const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const PmsService = require('../src/services/pms/pms.service');
const Store = require('../src/services/pms/pms-store.service');
const BnovoPmsProvider = require('../src/services/pms/bnovo-pms.provider');
const { decryptJson } = require('../src/services/pms/pms-crypto');
const PmsIntent = require('../src/services/pms/pms-intent.service');

process.env.PMS_CREDENTIALS_MASTER_KEY = '11'.repeat(32);

async function hotel(name) {
    return DB.createInstance({ name, businessType: 'hotel', salesGoal: 'call' });
}

function booking(id, hotelId, phone, number, surname = 'Иванов') {
    return {
        id, hotel_id: hotelId, number, amount: 12000,
        status: { id: 1, name: 'Новое' },
        customer: { name: 'Иван', surname, phone, email: 'guest@example.test', notes: 'must not persist' },
        dates: { arrival: '2026-09-01 14:00:00+03', departure: '2026-09-03 12:00:00+03', update_date: '2026-08-12 10:00:00' },
        prices: [{ room_type_id: 71, room_type_name: 'Стандарт', plan_name: 'Гибкий', price: 6000 }],
        plan_name: 'Гибкий',
    };
}

describe('Bnovo PMS integration tests', () => {
    it('does not create a manager task after availability failure without explicit consent', async () => {
        createTestDB();
        const business = await hotel('Consent PMS Hotel');
        PmsService.configure(business.id, { account_id: 89, api_password: 'secret', enabled: true });
        const originalCheck = PmsService.checkAvailability;
        const originalCreate = PmsService.createBookingRequest;
        let created = 0;
        PmsService.checkAvailability = async () => ({
            live_check_available: false,
            categories: [],
        });
        PmsService.createBookingRequest = () => {
            created += 1;
            return { request_id: 1 };
        };
        try {
            const input = {
                businessId: business.id,
                chatId: '79990000001@c.us',
                phone: '+79990000001',
                messageBatchId: 'batch-consent-1',
            };
            const first = await PmsIntent.handle({ ...input, text: 'Есть номер с 01.09.2026 по 03.09.2026?' });
            assert.strictEqual(created, 0);
            assert.strictEqual(first.manager_task_created, false);
            assert.ok(first.reply.includes('Оформить?'));

            const second = await PmsIntent.handle({ ...input, text: 'да' });
            assert.strictEqual(created, 1);
            assert.ok(second.reply.includes('Заявка'));
        } finally {
            PmsService.checkAvailability = originalCheck;
            PmsService.createBookingRequest = originalCreate;
        }
    });
    it('encrypts credentials and never stores the API password in plaintext', async () => {
        createTestDB();
        const business = await hotel('Encrypted Hotel');
        const safe = PmsService.configure(business.id, { account_id: 123456, api_password: 'super-secret-password', currency: 'RUB' });
        const raw = Store.getIntegration(business.id);

        assert.strictEqual(safe.business_id, business.id);
        assert.strictEqual(safe.masked_account, '••••3456');
        assert.strictEqual(safe.credentials_configured, true);
        assert.ok(!raw.credentialsEncrypted.includes('super-secret-password'));
        assert.deepStrictEqual(decryptJson(raw.credentialsEncrypted), { accountId: 123456, password: 'super-secret-password' });
        assert.strictEqual(JSON.stringify(safe).includes('super-secret-password'), false);
    });

    it('resolves the external hotel and safe catalog during connection test', async () => {
        createTestDB();
        const business = await hotel('Catalog Hotel');
        PmsService.configure(business.id, { account_id: 123, api_password: 'secret' });
        const row = Store.getIntegration(business.id);
        const original = PmsService._provider;
        PmsService._provider = () => ({ row, client: {
            testConnection: async () => ({ id: 123, access_token: 'must-not-return' }),
            listRoomTypes: async () => [{ id: 71, hotel_id: 900, name: 'Стандарт' }],
            listTariffs: async () => [{ id: 29, name: 'Гибкий' }],
        } });
        try {
            const result = await PmsService.test(business.id, 'catalog-test');
            assert.strictEqual(result.pms.external_hotel_id, '900');
            assert.deepStrictEqual(result.pms.mappings.available_room_types, [{ id: '71', name: 'Стандарт' }]);
            assert.strictEqual(JSON.stringify(result).includes('must-not-return'), false);
        } finally {
            PmsService._provider = original;
        }
    });

    it('keeps Bnovo v1 useful when professional catalog methods are not enabled', async () => {
        createTestDB();
        const business = await hotel('Limited API Hotel');
        PmsService.configure(business.id, {
            account_id: 123,
            api_password: 'secret',
            external_hotel_id: '900',
        });
        const row = Store.getIntegration(business.id);
        const denied = () => {
            const error = new Error('Access denied');
            error.code = 'BNOVO_CONFIGURATION_ERROR';
            error.statusCode = 403;
            throw error;
        };
        const original = PmsService._provider;
        PmsService._provider = () => ({ row, client: {
            testConnection: async () => ({ id: 123 }),
            listRoomTypes: async () => denied(),
            listTariffs: async () => denied(),
        } });
        try {
            const result = await PmsService.test(business.id, 'limited-test');
            assert.strictEqual(result.pms.connection_status, 'connected_limited');
            assert.strictEqual(result.pms.external_hotel_id, '900');
            assert.deepStrictEqual(result.capabilities, {
                bookings: true,
                booking_requests: true,
                room_types: false,
                tariffs: false,
                availability: false,
            });
        } finally {
            PmsService._provider = original;
        }
    });

    it('syncs v1 bookings even when the room type catalog returns 403', async () => {
        createTestDB();
        const business = await hotel('Limited Sync Hotel');
        PmsService.configure(business.id, {
            account_id: 123,
            api_password: 'secret',
            external_hotel_id: '900',
            enabled: true,
        });
        Store.enqueueJob(business.id, 'bookings_range', {
            dateFrom: '2026-09-01',
            dateTo: '2026-09-30',
        }, 'limited-sync');
        const [job] = Store.leaseDueJobs(1, 60);
        const row = Store.getIntegration(business.id);
        const original = PmsService._provider;
        PmsService._provider = () => ({ row, client: {
            listBookings: async () => [booking(501, 900, '+79000000000', 'V1-501')],
            listRoomTypes: async () => {
                const error = new Error('Access denied');
                error.code = 'BNOVO_CONFIGURATION_ERROR';
                error.statusCode = 403;
                throw error;
            },
        } });
        try {
            await PmsService.processSyncJob(job);
            const stored = PmsService.lookupBooking(business.id, { caller_number: '+79000000000' });
            assert.deepStrictEqual(stored.bookings.map((item) => item.booking_number), ['V1-501']);
        } finally {
            PmsService._provider = original;
        }
    });

    it('keeps the same phone isolated between two hotel businesses', async () => {
        createTestDB();
        const first = await hotel('Hotel A');
        const second = await hotel('Hotel B');
        PmsService.configure(first.id, { account_id: 101, api_password: 'secret-a', enabled: true });
        PmsService.configure(second.id, { account_id: 202, api_password: 'secret-b', enabled: true });
        Store.upsertBooking(first.id, 'bnovo', booking(101, 11, '+7 (930) 065-46-13', 'A-101'), 'RUB');
        Store.upsertBooking(second.id, 'bnovo', booking(202, 22, '+7 (930) 065-46-13', 'B-202'), 'RUB');

        const a = PmsService.lookupBooking(first.id, { caller_number: '+79000000000' });
        const b = PmsService.lookupBooking(second.id, { caller_number: '+79000000000' });
        assert.deepStrictEqual(a.bookings.map((item) => item.booking_number), ['A-101']);
        assert.deepStrictEqual(b.bookings.map((item) => item.booking_number), ['B-202']);
    });

    it('never turns an empty or opaque customer identity into an unfiltered booking list', async () => {
        createTestDB();
        const business = await hotel('Customer identity hotel');
        PmsService.configure(business.id, { account_id: 101, api_password: 'secret', enabled: true, external_hotel_id: '11' });
        const data = booking(101, 11, '+79000000000', 'PRIVATE-101');
        data.dates.departure = '2099-09-03 12:00:00+03';
        Store.upsertBooking(business.id, 'bnovo', data, 'RUB');
        for (const identity of ['', null, undefined, '101', '79000000000@lid', '79000000000@g.us', 'someone']) {
            const result = PmsService.customerContext(business.id, identity);
            assert.deepStrictEqual(result.upcoming_bookings, []);
            assert.strictEqual(result.identity_required, true);
        }
        assert.deepStrictEqual(PmsService.customerContext(business.id, '+7 (930) 065-46-13').upcoming_bookings.map(row => row.booking_number), ['PRIVATE-101']);
    });

    it('rejects fractional/coercible business scopes instead of reading the rounded tenant', async () => {
        createTestDB();
        await hotel('Strict tenant');
        for (const scope of [1.5, '1.5', true, [1], {}, null, '', -1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            assert.throws(() => Store.getIntegration(scope), error => error.code === 'PMS_BUSINESS_SCOPE_REQUIRED');
            assert.throws(() => PmsService.customerContext(scope, ''), error => error.code === 'PMS_BUSINESS_SCOPE_REQUIRED');
        }
        assert.strictEqual(Store._businessId('1'), 1);
    });

    it('keeps customer PMS context scoped to current external hotel and actual cache age', async () => {
        createTestDB();
        const first = await hotel('Current PMS hotel');
        const second = await hotel('Other tenant');
        const originalNow = PmsService.now;
        const now = new Date('2026-09-01T00:30:00Z');
        PmsService.now = () => now;
        try {
            DB.run('UPDATE instances SET hotelTimezone=? WHERE id=?', ['America/Los_Angeles', first.id]);
            PmsService.configure(first.id, { account_id: 101, api_password: 'secret-a', enabled: true, external_hotel_id: '11' });
            PmsService.configure(second.id, { account_id: 202, api_password: 'secret-b', enabled: true, external_hotel_id: '22' });
            for (const [id, tenant, hotelId, status] of [[1, first.id, 11, 'Новое'], [2, first.id, 99, 'Новое'], [3, second.id, 22, 'Новое'], [4, first.id, 11, 'Отменено']]) {
                const data = booking(id, hotelId, '+79000000000', `BOOK-${id}`);
                data.dates.departure = '2026-08-31 22:00:00-07';
                data.status.name = status;
                Store.upsertBooking(tenant, 'bnovo', data, 'RUB');
            }
            DB.run('UPDATE pms_bookings SET sourceTimestamp=?', [now.toISOString()]);
            Store.updateIntegrationStatus(first.id, { lastSyncAt: now.toISOString() });
            let result = PmsService.customerContext(first.id, '+79000000000');
            assert.deepStrictEqual(result.upcoming_bookings.map(row => row.booking_number), ['BOOK-1']);
            assert.strictEqual(result.stale, false);
            assert.strictEqual(result.has_active_booking, null);
            assert.strictEqual(result.live_availability_confirmed, false);
            assert.strictEqual(result.source_timestamp, now.toISOString());
            DB.run('UPDATE pms_bookings SET sourceTimestamp=? WHERE businessId=?', ['2026-08-31T23:00:00Z', first.id]);
            result = PmsService.customerContext(first.id, '+79000000000');
            assert.strictEqual(result.stale, true);
            assert.strictEqual(result.upcoming_bookings[0].stale, true);
            assert.strictEqual(result.upcoming_bookings[0].source_timestamp, '2026-08-31T23:00:00Z');
            DB.run('UPDATE instances SET hotelTimezone=? WHERE id=?', ['Asia/Tokyo', first.id]);
            assert.deepStrictEqual(PmsService.customerContext(first.id, '+79000000000').upcoming_bookings, []);
            DB.run('UPDATE instances SET hotelTimezone=? WHERE id=?', ['invalid-zone', first.id]);
            assert.strictEqual(PmsService.customerContext(first.id, '+79000000000').status, 'invalid_hotel_timezone');
            assert.strictEqual(PmsService.customerContext(first.id, '+79000000000').stale, true);
        } finally { PmsService.now = originalNow; }
    });

    it('scopes a repeated external guest id to its booking', async () => {
        createTestDB();
        const business = await hotel('Repeated Guest Hotel');
        const first = Store.upsertBooking(business.id, 'bnovo', booking(101, 11, '+79000000000', 'A-101'), 'RUB');
        const second = Store.upsertBooking(business.id, 'bnovo', booking(102, 11, '+79000000000', 'A-102'), 'RUB');
        const sharedGuest = { id: 55, name: 'Иван', surname: 'Иванов' };

        Store.replaceBookingGuests(business.id, first.id, [sharedGuest]);
        Store.replaceBookingGuests(business.id, second.id, [sharedGuest]);

        const rows = DB.all('SELECT id, bookingId, externalGuestId FROM pms_booking_guests WHERE businessId=? ORDER BY bookingId', [business.id]);
        assert.strictEqual(rows.length, 2);
        assert.notStrictEqual(rows[0].id, rows[1].id);
        assert.deepStrictEqual(rows.map((row) => row.externalGuestId), ['55', '55']);
    });

    it('creates one booking request, CRM event and manager task per idempotency context', async () => {
        createTestDB();
        const business = await hotel('Request Hotel');
        PmsService.configure(business.id, { account_id: 42, api_password: 'secret', enabled: true });
        const payload = {
            channel: 'voice', call_id: 'call-42', caller_number: '+79000000000', name: 'Иван',
            date_from: '2026-09-01', date_to: '2026-09-03', adults: 2,
        };
        const first = PmsService.createBookingRequest(business.id, payload);
        const second = PmsService.createBookingRequest(business.id, payload);

        assert.strictEqual(first.request_id, second.request_id);
        assert.strictEqual(second.idempotent, true);
        assert.strictEqual(DB.get('SELECT COUNT(*) total FROM pms_booking_requests WHERE businessId=?', [business.id]).total, 1);
        assert.strictEqual(DB.get("SELECT COUNT(*) total FROM manager_tasks WHERE instanceId=? AND reason='booking_request'", [business.id]).total, 1);
        assert.strictEqual(DB.get("SELECT COUNT(*) total FROM tool_runs WHERE instanceId=? AND toolName='create_booking_request'", [business.id]).total, 1);
    });

    it('leases due sync jobs atomically and recovers an expired lease', async () => {
        createTestDB();
        const business = await hotel('Jobs Hotel');
        Store.enqueueJob(business.id, 'bookings_range', { dateFrom: '2026-01-01', dateTo: '2026-01-31' }, 'job-one');
        const leased = Store.leaseDueJobs(5, 60);
        assert.strictEqual(leased.length, 1);
        assert.strictEqual(Store.leaseDueJobs(5, 60).length, 0);

        DB.run("UPDATE pms_sync_jobs SET leaseExpiresAt='2000-01-01T00:00:00.000Z' WHERE id=?", [leased[0].id]);
        const recovered = Store.leaseDueJobs(5, 60);
        assert.strictEqual(recovered.length, 1);
        assert.notStrictEqual(recovered[0].leaseToken, leased[0].leaseToken);
        assert.strictEqual(recovered[0].attempts, 2);
    });

    it('deduplicates Bnovo webhooks and rejects another hotel id', async () => {
        createTestDB();
        const business = await hotel('Webhook Hotel');
        PmsService.configure(business.id, { account_id: 7654, api_password: 'secret', external_hotel_id: '88' });
        const integration = Store.getIntegration(business.id);
        const token = decryptJson(integration.webhookTokenEncrypted).token;
        const body = { id: 'event-1', type: 'booking', external_hotel_id: 88, booking_id: 909 };
        const first = PmsService.handleWebhook(token, body);
        const second = PmsService.handleWebhook(token, body);
        assert.strictEqual(first.job_id, second.job_id);
        assert.strictEqual(DB.get('SELECT COUNT(*) total FROM pms_sync_jobs WHERE businessId=?', [business.id]).total, 1);
        PmsService.handleWebhook(token, { ...body, status: 'changed' });
        assert.strictEqual(DB.get('SELECT COUNT(*) total FROM pms_sync_jobs WHERE businessId=?', [business.id]).total, 2);
        assert.throws(() => PmsService.handleWebhook(token, { ...body, id: 'event-2', external_hotel_id: 99 }), /scope mismatch/);
    });

    it('records a safe diagnostic when Bnovo denies webhook configuration', async () => {
        createTestDB();
        const business = await hotel('Webhook Limited Hotel');
        PmsService.configure(business.id, {
            account_id: 7654,
            api_password: 'secret',
            external_hotel_id: '88',
        });
        const row = Store.getIntegration(business.id);
        const original = PmsService._provider;
        const denied = new Error('Access denied for token=must-not-leak');
        denied.code = 'BNOVO_CONFIGURATION_ERROR';
        denied.statusCode = 403;
        PmsService._provider = () => ({
            row,
            client: { listWebhookSubscribers: async () => { throw denied; } },
        });
        try {
            await assert.rejects(
                PmsService.connectWebhooks(business.id, 'https://crm.example.test', 'webhook-denied'),
                /Access denied/,
            );
            const safe = PmsService.get(business.id);
            assert.strictEqual(safe.webhook_status, 'configuration_error');
            assert.strictEqual(safe.last_error.code, 'BNOVO_CONFIGURATION_ERROR');
            assert.strictEqual(JSON.stringify(safe).includes('must-not-leak'), false);
            const audit = DB.get(
                "SELECT status, errorCode, message FROM pms_audit_events WHERE businessId=? AND operation='configure' AND correlationId=? LIMIT 1",
                [business.id, 'webhook-denied'],
            );
            assert.strictEqual(audit.status, 'failed');
            assert.strictEqual(audit.errorCode, 'BNOVO_CONFIGURATION_ERROR');
            assert.strictEqual(String(audit.message).includes('must-not-leak'), false);
        } finally {
            PmsService._provider = original;
        }
    });

    it('uses booking number plus surname without also requiring the current phone', async () => {
        createTestDB();
        const business = await hotel('Lookup Hotel');
        PmsService.configure(business.id, { account_id: 55, api_password: 'secret', enabled: true });
        Store.upsertBooking(business.id, 'bnovo', booking(501, 55, '+79990000000', 'LOOKUP-501', 'Петров'), 'RUB');

        const result = PmsService.lookupBooking(business.id, {
            caller_number: '+78880000000', booking_number: 'LOOKUP-501', surname: 'Петров',
        });
        assert.strictEqual(result.bookings.length, 1);
        assert.strictEqual(result.bookings[0].booking_number, 'LOOKUP-501');
    });

    it('removes cached live PMS facts when credentials are disconnected', async () => {
        createTestDB();
        const business = await hotel('Disconnect Hotel');
        PmsService.configure(business.id, { account_id: 12, api_password: 'secret', enabled: true });
        Store.upsertBooking(business.id, 'bnovo', booking(12, 12, '+79990000000', 'OLD-12'), 'RUB');
        Store.enqueueJob(business.id, 'plans_refresh', {}, 'old-job');

        assert.strictEqual(PmsService.disconnect(business.id).deleted, true);
        assert.strictEqual(DB.get('SELECT COUNT(*) total FROM pms_bookings WHERE businessId=?', [business.id]).total, 0);
        assert.strictEqual(DB.get('SELECT COUNT(*) total FROM pms_sync_jobs WHERE businessId=?', [business.id]).total, 0);
    });

    it('caches auth token and performs exactly one refresh after 401', async () => {
        let authCalls = 0;
        let meCalls = 0;
        const fakeHttp = {
            async request(request) {
                if (request.url === '/api/v1/auth') {
                    authCalls += 1;
                    return { status: 200, data: { data: { access_token: `token-${authCalls}`, expires_in: 86400 } } };
                }
                meCalls += 1;
                if (meCalls === 1) {
                    const error = new Error('Unauthorized');
                    error.response = { status: 401, data: { error: { message: 'Unauthorized' } }, headers: {} };
                    throw error;
                }
                return { status: 200, data: { data: { hotel_id: 88 } } };
            },
        };
        const client = new BnovoPmsProvider({ businessId: 1, accountId: 123, password: 'secret', http: fakeHttp, sleep: async () => {} });
        const result = await client.testConnection('request-1');
        await client.testConnection('request-2');
        assert.strictEqual(result.hotel_id, 88);
        assert.strictEqual(authCalls, 2);
        assert.strictEqual(meCalls, 3);
    });

    it('paginates bookings with the Bnovo maximum page size', async () => {
        const offsets = [];
        const fakeHttp = {
            async request(request) {
                if (request.url === '/api/v1/auth') return { status: 200, data: { data: { access_token: 'jwt', expires_in: 86400 } } };
                offsets.push(request.params.offset);
                const count = request.params.offset === 0 ? 50 : 1;
                return {
                    status: 200,
                    data: { data: { bookings: Array.from({ length: count }, (_, index) => ({ id: request.params.offset + index + 1 })), meta: { total: 51 } } },
                };
            },
        };
        const client = new BnovoPmsProvider({ businessId: 1, accountId: 123, password: 'secret', http: fakeHttp });
        const rows = await client.listBookings({ dateFrom: '2026-01-01', dateTo: '2026-01-31' });
        assert.strictEqual(rows.length, 51);
        assert.deepStrictEqual(offsets, [0, 50]);
    });

    it('backs off and retries a Bnovo 429 response', async () => {
        let calls = 0;
        const sleeps = [];
        const fakeHttp = {
            async request(request) {
                if (request.url === '/api/v1/auth') return { status: 200, data: { data: { access_token: 'jwt', expires_in: 86400 } } };
                calls += 1;
                if (calls === 1) {
                    const error = new Error('rate limited');
                    error.response = { status: 429, headers: { 'retry-after': '1' }, data: { error: { message: 'rate limited' } } };
                    throw error;
                }
                return { status: 200, data: { data: { hotel_id: 1 } } };
            },
        };
        const client = new BnovoPmsProvider({
            businessId: 1, accountId: 123, password: 'secret', http: fakeHttp,
            sleep: async (milliseconds) => { sleeps.push(milliseconds); },
        });
        const result = await client.testConnection('rate-test');
        assert.strictEqual(result.hotel_id, 1);
        assert.strictEqual(calls, 2);
        assert.ok(sleeps.some((milliseconds) => milliseconds >= 1000));
    });

    it('serializes concurrent rate-limit admission', async () => {
        let now = 0;
        const sleeps = [];
        const client = new BnovoPmsProvider({
            businessId: 1, accountId: 123, password: 'secret',
            http: { request: async () => ({ status: 200, data: { data: {} } }) },
            now: () => now,
            sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
        });
        await Promise.all(Array.from({ length: 26 }, () => client._rateLimit()));
        assert.strictEqual(client.requestTimestamps.length, 26);
        assert.ok(client.requestTimestamps[25] >= 10000);
        assert.ok(sleeps.length >= 1);
        assert.ok(now >= 10000);
    });

    it('keeps one in-memory Bnovo client per tenant until credentials change', async () => {
        createTestDB();
        const business = await hotel('Token Cache Hotel');
        PmsService.configure(business.id, { account_id: 123, api_password: 'secret', enabled: true });
        const first = PmsService._provider(business.id, 'first').client;
        const second = PmsService._provider(business.id, 'second').client;
        assert.strictEqual(first, second);

        PmsService.configure(business.id, { api_password: 'changed-secret' });
        const third = PmsService._provider(business.id, 'third').client;
        assert.notStrictEqual(first, third);
    });

    it('rejects schema drift instead of presenting an empty availability result', async () => {
        let calls = 0;
        const fakeHttp = {
            async request(request) {
                if (request.url === '/api/v1/auth') return { status: 200, data: { data: { access_token: 'jwt', expires_in: 86400 } } };
                calls += 1;
                return { status: 200, data: { data: [] } };
            },
        };
        const client = new BnovoPmsProvider({ businessId: 1, accountId: 123, password: 'secret', http: fakeHttp });
        await assert.rejects(
            () => client.getAvailability({ dateFrom: '2026-09-01', dateTo: '2026-09-03' }),
            (error) => error.code === 'BNOVO_SCHEMA_INVALID' && calls === 1,
        );
    });

    it('redacts secret material from terminal Bnovo errors', async () => {
        const fakeHttp = {
            async request(request) {
                if (request.url === '/api/v1/auth') return { status: 200, data: { data: { access_token: 'jwt-secret', expires_in: 86400 } } };
                const error = new Error('Authorization: Bearer jwt-secret password=hunter2 https://user:pass@example.test');
                error.response = { status: 403, data: { error: { message: error.message } }, headers: {} };
                throw error;
            },
        };
        const client = new BnovoPmsProvider({ businessId: 1, accountId: 123, password: 'hunter2', http: fakeHttp, sleep: async () => {} });
        await assert.rejects(() => client.testConnection(), (error) => {
            assert.strictEqual(error.code, 'BNOVO_CONFIGURATION_ERROR');
            assert.ok(!error.message.includes('jwt-secret'));
            assert.ok(!error.message.includes('hunter2'));
            assert.ok(!error.message.includes('user:pass'));
            return true;
        });
    });

    it('uses the official GET contract for Bnovo test webhook events', async () => {
        const requests = [];
        const fakeHttp = {
            async request(request) {
                requests.push(request);
                if (request.url === '/api/v1/auth') {
                    return { status: 200, data: { data: { access_token: 'jwt', expires_in: 86400 } } };
                }
                return { status: 201, data: { data: { delivered: true } } };
            },
        };
        const client = new BnovoPmsProvider({
            businessId: 1, accountId: 123, password: 'secret', http: fakeHttp,
        });

        await client.sendTestWebhook('booking', 'booking-test');
        await client.sendTestWebhook('plans_data_update', 'plans-test');

        assert.deepStrictEqual(
            requests.slice(1).map(({ method, url, data }) => ({ method, url, data })),
            [
                { method: 'GET', url: '/api/v1/webhooks/messages/bookings/test', data: undefined },
                { method: 'GET', url: '/api/v1/webhooks/messages/plans/test', data: undefined },
            ],
        );
    });

    it('calculates minimum availability and total only from daily Bnovo prices', async () => {
        createTestDB();
        const business = await hotel('Availability Hotel');
        PmsService.configure(business.id, {
            account_id: 123, api_password: 'secret', enabled: true, currency: 'RUB',
            mappings: { enabled_room_type_ids: ['71'], enabled_tariff_ids: ['29'] },
        });
        const row = Store.getIntegration(business.id);
        const original = PmsService._provider;
        PmsService._provider = () => ({ row, client: {
            getAvailability: async () => ({ 71: { room_type_id: 71, availability: { '2026-09-01': 3, '2026-09-02': 2 } } }),
            listRoomTypes: async () => [{ id: 71, name: 'Стандарт' }, { id: 72, name: 'Скрытая' }],
            listTariffs: async () => [{ id: 29, name: 'Гибкий' }, { id: 30, name: 'Скрытый' }],
            getTariffPrices: async () => ({ 71: {
                '2026-09-01': { price: 5000, is_default: false },
                '2026-09-02': { price: 6000, is_default: true },
            } }),
        } });
        try {
            const result = await PmsService.checkAvailability(business.id, { date_from: '2026-09-01', date_to: '2026-09-03' });
            assert.strictEqual(result.stale, false);
            assert.strictEqual(result.categories.length, 1);
            assert.strictEqual(result.categories[0].minimum_availability, 2);
            assert.strictEqual(result.categories[0].offers[0].total, 11000);
            assert.deepStrictEqual(result.categories[0].offers[0].nightly, [
                { date: '2026-09-01', price: 5000 },
                { date: '2026-09-02', price: 6000 },
            ]);
        } finally {
            PmsService._provider = original;
        }
    });

    it('requires valid availability for every stay night and ignores checkout/out-of-range dates', async () => {
        createTestDB();
        const business = await hotel('Complete stay evidence');
        PmsService.configure(business.id, { account_id: 123, api_password: 'secret', enabled: true });
        const row = Store.getIntegration(business.id);
        const original = PmsService._provider;
        let daily = { '2026-09-01': 3 };
        PmsService._provider = () => ({ row, client: {
            getAvailability: async () => ({ 71: { availability: daily } }),
            listRoomTypes: async () => [{ id: 71, name: 'Стандарт' }],
            listTariffs: async () => [{ id: 29, name: 'Гибкий' }],
            getTariffPrices: async () => ({ 71: { '2026-09-01': { price: 5000 }, '2026-09-02': { price: 6000 } } }),
        } });
        const input = { date_from: '2026-09-01', date_to: '2026-09-03' };
        try {
            for (const value of [undefined, null, '', false, 'unknown', -1, 1.5]) {
                daily = { '2026-09-01': 3, '2026-09-02': value };
                await assert.rejects(() => PmsService.checkAvailability(business.id, input), error => error.code === 'PMS_AVAILABILITY_INCOMPLETE');
                assert.strictEqual(Store.getIntegration(business.id).lastSuccessfulAvailabilityAt, null);
            }
            const answer = await PmsIntent.handle({ businessId: business.id, chatId: '79990000001@c.us',
                phone: '+79990000001', messageBatchId: 'incomplete-availability',
                text: 'Есть свободный номер с 01.09.2026 по 03.09.2026?' });
            assert.ok(answer.reply.includes('не могу подтвердить'));
            assert.ok(!answer.reply.includes('не найдено'));
            assert.strictEqual(answer.manager_task_created, false);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS count FROM pms_booking_requests').count, 0);
            PmsIntent.pending.clear();
            daily = { '2026-08-31': 0, '2026-09-01': '3', '2026-09-02': 2, '2026-09-03': 0 };
            assert.strictEqual((await PmsService.checkAvailability(business.id, input)).categories[0].minimum_availability, 2);
            daily['2026-09-02'] = 0;
            assert.deepStrictEqual((await PmsService.checkAvailability(business.id, input)).categories, []);
        } finally { PmsService._provider = original; }
    });

    it('never treats null, invalid or missing prices as a free stay or a sold-out hotel', async () => {
        createTestDB();
        const business = await hotel('Verified daily prices');
        PmsService.configure(business.id, { account_id: 123, api_password: 'secret', enabled: true });
        const row = Store.getIntegration(business.id);
        const original = PmsService._provider;
        let secondPrice;
        PmsService._provider = () => ({ row, client: {
            getAvailability: async () => ({ 71: { availability: { '2026-09-01': 3, '2026-09-02': 2 } } }),
            listRoomTypes: async () => [{ id: 71, name: 'Стандарт' }],
            listTariffs: async () => [{ id: 29, name: 'Гибкий' }],
            getTariffPrices: async () => ({ 71: { '2026-09-01': { price: 5000 }, '2026-09-02': { price: secondPrice } } }),
        } });
        const input = { date_from: '2026-09-01', date_to: '2026-09-03' };
        try {
            for (const value of [undefined, null, '', false, 'NaN', -100, Infinity]) {
                secondPrice = value;
                await assert.rejects(() => PmsService.checkAvailability(business.id, input), error => error.code === 'PMS_PRICES_INCOMPLETE');
            }
            secondPrice = '0';
            assert.strictEqual((await PmsService.checkAvailability(business.id, input)).categories[0].offers[0].total, 5000);
        } finally { PmsService._provider = original; }
    });

    it('recognizes WhatsApp PMS intent and asks one date clarification', () => {
        assert.strictEqual(PmsIntent._internals.intent('Есть ли свободный номер и сколько стоит?'), 'availability');
        assert.strictEqual(PmsIntent._internals.intent('Хочу забронировать номер'), 'request');
        assert.deepStrictEqual(PmsIntent._internals.extractDates('с 01.09.2026 по 03.09.2026'), ['2026-09-01', '2026-09-03']);
    });

    it('continues a WhatsApp availability intent when the next message contains only dates', async () => {
        createTestDB();
        const business = await hotel('WhatsApp PMS Hotel');
        PmsService.configure(business.id, { account_id: 88, api_password: 'secret', enabled: true });
        const original = PmsService.checkAvailability;
        PmsService.checkAvailability = async (_businessId, input) => ({
            date_from: input.date_from, date_to: input.date_to, nights: 2,
            categories: [{ category: 'Стандарт', offers: [{ total: 10000, currency: 'RUB' }] }],
        });
        try {
            const first = await PmsIntent.handle({ businessId: business.id, chatId: '79990000000@c.us', text: 'Есть свободный номер?' });
            const second = await PmsIntent.handle({ businessId: business.id, chatId: '79990000000@c.us', text: '01.09.2026 — 03.09.2026' });
            assert.ok(first.reply.includes('две даты'));
            assert.ok(second.reply.includes('10000 RUB'));
        } finally {
            PmsService.checkAvailability = original;
        }
    });

    it('rejects impossible calendar dates before calling Bnovo', async () => {
        createTestDB();
        const business = await hotel('Calendar Hotel');
        PmsService.configure(business.id, { account_id: 77, api_password: 'secret', enabled: true });
        await assert.rejects(
            () => PmsService.checkAvailability(business.id, { date_from: '2026-02-31', date_to: '2026-03-03' }),
            (error) => error.code === 'PMS_DATE_INVALID',
        );
    });
});
