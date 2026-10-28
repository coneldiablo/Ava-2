const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const TwentyService = require('../src/services/twenty/twenty.service');
const Store = require('../src/services/twenty/twenty-store.service');
const { decryptJson, sha256 } = require('../src/services/twenty/twenty-crypto');
const { handleTwentyWebhook } = require('../src/routes/twenty-public.routes');

process.env.TWENTY_CREDENTIALS_MASTER_KEY = '22'.repeat(32);

async function business(name) {
    return DB.createInstance({ name, businessType: 'hotel' });
}

function responseCapture() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

describe('Twenty tenant-scoped CRM bridge', () => {
    it('ships the same person schema to manual and runtime Twenty provisioning', () => {
        const deployed = fs.readFileSync(path.join(__dirname, '../../deploy/twenty/schema-manifest.json'));
        const runtime = fs.readFileSync(path.join(__dirname, '../src/services/twenty/schema-manifest.json'));
        assert.ok(deployed.equals(runtime), 'runtime and deployment Twenty manifests must be byte-identical');
        assert.deepStrictEqual(JSON.parse(runtime).standard_object_fields.people,
            ['avaBusinessId', 'avaSourceId', 'sourceUrl']);
    });

    it('encrypts API and webhook credentials without returning plaintext', async () => {
        createTestDB();
        const hotel = await business('Twenty Hotel');
        const view = TwentyService.configure(hotel.id, {
            base_url: 'https://twenty.example.test/rest',
            workspace_id: 'workspace-a',
            api_key: 'twenty-api-secret',
            webhook_secret: 'twenty-webhook-secret',
            enabled: true,
            mode: 'shadow',
        });
        const raw = Store.getIntegration(hotel.id);

        assert.strictEqual(view.base_url, 'https://twenty.example.test');
        assert.strictEqual(view.masked_api_key, '••••cret');
        assert.strictEqual(JSON.stringify(view).includes('twenty-api-secret'), false);
        assert.strictEqual(raw.apiKeyEncrypted.includes('twenty-api-secret'), false);
        assert.strictEqual(raw.webhookSecretEncrypted.includes('twenty-webhook-secret'), false);
        assert.deepStrictEqual(decryptJson(raw.apiKeyEncrypted, { businessId: hotel.id }), { apiKey: 'twenty-api-secret' });
    });

    it('atomically enqueues changed CRM rows and leases each event only once', async () => {
        createTestDB();
        const hotel = await business('Outbox Hotel');
        TwentyService.configure(hotel.id, {
            base_url: 'https://twenty.example.test', api_key: 'key-a', enabled: true, mode: 'shadow',
        });
        DB.run(`INSERT INTO clients (instanceId,chatId,senderName) VALUES (?,?,?)`, [hotel.id, '79990001122@c.us', 'Иван Иванов']);

        const before = DB.get(`SELECT COUNT(*) AS count FROM twenty_sync_outbox
            WHERE businessId=? AND sourceTable='clients'`, [hotel.id]).count;
        assert.strictEqual(before, 1);
        const first = Store.leaseOutbox(10, 60);
        const second = Store.leaseOutbox(10, 60);
        assert.strictEqual(first.length, 1);
        assert.strictEqual(second.length, 0);
        assert.ok(first[0].leaseToken);
    });

    it('renews a live lease and fences expired workers without dropping their job', async () => {
        createTestDB();
        const hotel = await business('Lease fencing');
        TwentyService.configure(hotel.id, { base_url: 'https://twenty.example.test', api_key: 'lease-key', enabled: true, mode: 'shadow' });
        const event = Store.enqueue(hotel.id, 'person', 'clients', 'lease-source');
        const [first] = Store.leaseOutbox(1, 5);
        assert.strictEqual(first.eventId, event.eventId);
        assert.strictEqual(Store.renewOutboxLease(event.eventId, first.leaseToken, 5), true);
        assert.strictEqual(Store.leaseOutbox(1, 5).length, 0);
        DB.run("UPDATE twenty_sync_outbox SET leasedUntil=datetime('now','-1 second') WHERE eventId=?", [event.eventId]);
        assert.strictEqual(Store.renewOutboxLease(event.eventId, first.leaseToken, 5), false);
        assert.strictEqual(Store.finishOutbox(event.eventId, first.leaseToken, { status: 'DONE', recordLink: {
            businessId: hotel.id, entityType: 'person', sourceTable: 'clients', sourceId: 'lease-source',
            twentyObject: 'people', twentyRecordId: 'stale', sourceHash: 'stale',
        } }), false);
        // Expired leases back off for 30 seconds before a new worker may retry.
        assert.strictEqual(Store.leaseOutbox(1, 5).length, 0);
        DB.run("UPDATE twenty_sync_outbox SET nextAttemptAt=datetime('now','-1 second') WHERE eventId=?", [event.eventId]);
        const [second] = Store.leaseOutbox(1, 5);
        assert.strictEqual(second.eventId, event.eventId);
        assert.notStrictEqual(second.leaseToken, first.leaseToken);
        assert.strictEqual(Store.renewOutboxLease(event.eventId, first.leaseToken, 5), false);
        assert.strictEqual(Store.getRecordLink(hotel.id, 'clients', 'lease-source'), undefined);
        assert.strictEqual(Store.finishOutbox(event.eventId, second.leaseToken, { status: 'DONE' }), true);
        assert.strictEqual(DB.get('SELECT status FROM twenty_sync_outbox WHERE eventId=?', [event.eventId]).status, 'DONE');
    });

    it('keeps a slow remote write leased while another worker checks the queue', async () => {
        createTestDB();
        const hotel = await business('Slow Twenty');
        TwentyService.configure(hotel.id, { base_url: 'https://twenty.example.test', api_key: 'slow-key', enabled: false });
        Store.updateStatus(hotel.id, { connectionStatus: 'connected' });
        TwentyService.configure(hotel.id, { enabled: true, mode: 'live' });
        DB.run('INSERT INTO clients(instanceId,chatId,senderName) VALUES (?,?,?)', [hotel.id, '79990001123@c.us', 'Медленный клиент']);
        const originalFactory = TwentyService.clientFactory;
        const originalTtl = TwentyService.outboxLeaseTtlSeconds;
        const calls = [];
        TwentyService.outboxLeaseTtlSeconds = 1;
        TwentyService.clientFactory = () => ({
            createRecord: async (objectName, payload) => {
                calls.push({ objectName, payload });
                await new Promise((resolve) => setTimeout(resolve, 1500));
                return { ...payload };
            },
            getRecord: async () => calls[0]?.payload,
        });
        try {
            const running = TwentyService.processOutbox(1);
            await new Promise((resolve) => setTimeout(resolve, 1150));
            assert.strictEqual(Store.leaseOutbox(1, 1).length, 0);
            await running;
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].objectName, 'people');
            assert.strictEqual(DB.get('SELECT status FROM twenty_sync_outbox WHERE businessId=?', [hotel.id]).status, 'DONE');
        } finally {
            TwentyService.clientFactory = originalFactory;
            TwentyService.outboxLeaseTtlSeconds = originalTtl;
        }
    });

    it('does not commit a stale remote response after lease takeover', async () => {
        createTestDB();
        const hotel = await business('Takeover Twenty');
        TwentyService.configure(hotel.id, { base_url: 'https://twenty.example.test', api_key: 'takeover-key', enabled: false });
        Store.updateStatus(hotel.id, { connectionStatus: 'connected' });
        TwentyService.configure(hotel.id, { enabled: true, mode: 'live' });
        const clientId = DB.run('INSERT INTO clients(instanceId,chatId,senderName) VALUES (?,?,?)',
            [hotel.id, '79990001124@c.us', 'Повтор']).lastInsertRowid;
        const originalFactory = TwentyService.clientFactory;
        let releaseFirst;
        let firstStarted;
        const started = new Promise((resolve) => { firstStarted = resolve; });
        const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
        const remoteIds = new Set();
        let creates = 0;
        let remote;
        TwentyService.clientFactory = () => ({
            createRecord: async (_object, payload) => {
                creates += 1;
                remoteIds.add(payload.id);
                remote = { ...payload };
                if (creates === 1) { firstStarted(); await firstGate; }
                return remote;
            },
            getRecord: async () => remote,
        });
        try {
            const oldWorker = TwentyService.processOutbox(1);
            await started;
            const event = DB.get('SELECT * FROM twenty_sync_outbox WHERE businessId=?', [hotel.id]);
            DB.run("UPDATE twenty_sync_outbox SET leasedUntil=datetime('now','-1 second') WHERE eventId=?", [event.eventId]);
            assert.strictEqual(Store.leaseOutbox(1, 5).length, 0);
            DB.run("UPDATE twenty_sync_outbox SET nextAttemptAt=datetime('now','-1 second') WHERE eventId=?", [event.eventId]);
            assert.strictEqual(await TwentyService.processOutbox(1), 1);
            releaseFirst();
            await oldWorker;
            assert.strictEqual(creates, 2);
            assert.strictEqual(remoteIds.size, 1);
            assert.strictEqual(DB.get('SELECT status FROM twenty_sync_outbox WHERE eventId=?', [event.eventId]).status, 'DONE');
            assert.strictEqual(Store.getRecordLink(hotel.id, 'clients', clientId).twentyRecordId, [...remoteIds][0]);
            assert.strictEqual(DB.get("SELECT COUNT(*) AS count FROM twenty_audit_events WHERE correlationId=? AND action='create'", [event.eventId]).count, 1);
        } finally {
            releaseFirst?.();
            TwentyService.clientFactory = originalFactory;
        }
    });

    it('keeps shadow mode read-only and records the projected event', async () => {
        createTestDB();
        const hotel = await business('Shadow Hotel');
        TwentyService.configure(hotel.id, {
            base_url: 'https://twenty.example.test', api_key: 'key-shadow', enabled: true, mode: 'shadow',
        });
        DB.run(`INSERT INTO clients (instanceId,chatId,senderName) VALUES (?,?,?)`, [hotel.id, '79990002233@c.us', 'Анна']);
        let networkCalls = 0;
        const originalFactory = TwentyService.clientFactory;
        TwentyService.clientFactory = () => ({ createRecord: async () => { networkCalls += 1; } });
        try {
            await TwentyService.processOutbox(10);
            assert.strictEqual(networkCalls, 0);
            assert.strictEqual(DB.get(`SELECT status FROM twenty_sync_outbox WHERE businessId=?`, [hotel.id]).status, 'SHADOWED');
        } finally {
            TwentyService.clientFactory = originalFactory;
        }
    });

    it('creates and updates a linked Twenty person with normalized phone readback', async () => {
        createTestDB();
        const hotel = await business('Live Hotel');
        TwentyService.configure(hotel.id, {
            base_url: 'https://twenty.example.test', api_key: 'key-live', enabled: false, mode: 'shadow',
        });
        Store.updateStatus(hotel.id, { connectionStatus: 'connected' });
        TwentyService.configure(hotel.id, { enabled: true, mode: 'live' });
        DB.run(`INSERT INTO clients (instanceId,chatId,senderName) VALUES (?,?,?)`, [hotel.id, '79990003344@c.us', 'Пётр Петров']);

        const calls = [];
        let remote;
        const originalFactory = TwentyService.clientFactory;
        TwentyService.clientFactory = () => ({
            createRecord: async (objectName, payload) => { calls.push(['create', objectName, payload]); remote = { ...payload, id: 'person-remote-1' }; return remote; },
            updateRecord: async (objectName, recordId, payload) => { calls.push(['update', objectName, recordId, payload]); remote = { ...payload, id: recordId }; return remote; },
            getRecord: async () => ({ ...remote, phones: {
                primaryPhoneNumber: remote.phones.primaryPhoneNumber.slice(2),
                primaryPhoneCallingCode: '+7', additionalPhones: [],
            } }),
        });
        try {
            await TwentyService.processOutbox(10);
            assert.strictEqual(calls[0][0], 'create');
            assert.strictEqual(calls[0][1], 'people');
            assert.strictEqual(calls[0][2].avaBusinessId, String(hotel.id));
            assert.ok(calls[0][2].avaSourceId);
            assert.ok(calls[0][2].sourceUrl.includes(`business_id=${hotel.id}`));
            const client = DB.get('SELECT * FROM clients WHERE instanceId=?', [hotel.id]);
            const link = Store.getRecordLink(hotel.id, 'clients', client.id);
            assert.strictEqual(link.twentyRecordId, 'person-remote-1');

            DB.run('UPDATE clients SET senderName=?,updatedAt=CURRENT_TIMESTAMP WHERE instanceId=? AND id=?', ['Пётр Новый', hotel.id, client.id]);
            await TwentyService.processOutbox(10);
            assert.strictEqual(calls[1][0], 'update');
            assert.strictEqual(calls[1][2], 'person-remote-1');
        } finally {
            TwentyService.clientFactory = originalFactory;
        }
    });

    it('accepts Twenty ISO timestamps for the same call and follow-up instant', async () => {
        createTestDB();
        const hotel = await business('Timestamp readback');
        TwentyService.configure(hotel.id, { base_url: 'https://twenty.example.test', api_key: 'date-key', enabled: false });
        Store.updateStatus(hotel.id, { connectionStatus: 'connected' });
        TwentyService.configure(hotel.id, { enabled: true, mode: 'live' });
        DB.run(`INSERT INTO conversation_events(eventId,instanceId,channel,callId,content,createdAt)
            VALUES ('event-date',?,'voice','call-date','Summary','2026-09-25 10:00:00')`, [hotel.id]);
        DB.run(`INSERT INTO followup_drafts(draftId,instanceId,text,createdAt)
            VALUES ('draft-date',?,'Follow up','2026-09-25 10:00:00')`, [hotel.id]);
        Store.enqueue(hotel.id, 'call', 'conversation_events', 'call-date');
        Store.enqueue(hotel.id, 'followup_draft', 'followup_drafts', 'draft-date');

        const remote = new Map();
        const originalFactory = TwentyService.clientFactory;
        TwentyService.clientFactory = () => ({
            createRecord: async (_object, payload) => { remote.set(payload.id, payload); return payload; },
            getRecord: async (_object, id) => {
                const record = { ...remote.get(id) };
                for (const field of ['occurredAt', 'createdAtAva']) {
                    if (record[field]) record[field] = record[field].replace(' ', 'T') + '.000Z';
                }
                return record;
            },
        });
        try {
            await TwentyService.processOutbox(10);
            for (const [table, source] of [['conversation_events', 'call-date'], ['followup_drafts', 'draft-date']]) {
                const job = DB.get('SELECT status FROM twenty_sync_outbox WHERE businessId=? AND sourceTable=? AND sourceId=?',
                    [hotel.id, table, source]);
                assert.strictEqual(job.status, 'DONE');
            }
        } finally { TwentyService.clientFactory = originalFactory; }
    });

    it('projects real CRM identifiers, rich-text tasks and E164 phones without treating groups as people', async () => {
        createTestDB();
        const hotel = await business('Projection contract');
        const group = DB.run('INSERT INTO clients(instanceId,chatId,senderName) VALUES (?,?,?)', [hotel.id, '120363044972566545@g.us', 'Группа']).lastInsertRowid;
        const person = DB.run('INSERT INTO clients(instanceId,chatId,senderName) VALUES (?,?,?)', [hotel.id, '79000000000@c.us', 'Гость']).lastInsertRowid;
        const lid = DB.run('INSERT INTO clients(instanceId,chatId,senderName) VALUES (?,?,?)', [hotel.id, '12345678901@lid', 'Без телефона']).lastInsertRowid;
        const snapshot = (sourceTable, sourceId) => TwentyService._sourceSnapshot({ businessId: hotel.id, sourceTable, sourceId });
        assert.strictEqual(snapshot('clients', group), null);
        assert.deepStrictEqual(snapshot('clients', person).phones, { primaryPhoneNumber: '+79000000000' });
        assert.strictEqual(snapshot('clients', lid).phones, undefined);
        DB.run(`INSERT INTO manager_tasks(taskId,instanceId,summary,reason) VALUES ('task-contract',?,'Позвонить','booking_request')`, [hotel.id]);
        const task = snapshot('manager_tasks', 'task-contract');
        assert.strictEqual(task.body, undefined);
        assert.deepStrictEqual(task.bodyV2, { markdown: 'booking_request: Позвонить' });
        DB.run("UPDATE manager_tasks SET resolutionNote='Решено в Twenty' WHERE instanceId=? AND taskId='task-contract'", [hotel.id]);
        assert.deepStrictEqual(snapshot('manager_tasks', 'task-contract').bodyV2, { markdown: 'Решено в Twenty' });
        DB.run(`INSERT INTO outbound_campaigns(campaignId,instanceId,name) VALUES ('camp_uuid',?,'Кампания')`, [hotel.id]);
        DB.run(`INSERT INTO outbound_leads(leadId,campaignId,instanceId,phone) VALUES ('lead_uuid','camp_uuid',?,'79000000000')`, [hotel.id]);
        DB.run(`INSERT INTO outbound_attempts(attemptId,campaignId,leadId,instanceId,phone) VALUES ('attempt_uuid','camp_uuid','lead_uuid',?,'79000000000')`, [hotel.id]);
        assert.strictEqual(snapshot('outbound_leads', 'lead_uuid').campaignSourceId, 'camp_uuid');
        assert.strictEqual(snapshot('outbound_attempts', 'attempt_uuid').leadSourceId, 'lead_uuid');

        const manifest = require('../src/services/twenty/schema-manifest.json');
        assert.deepStrictEqual(manifest.standard_object_fields.people, ['avaBusinessId', 'avaSourceId', 'sourceUrl']);
        assert.strictEqual(manifest.standard_object_fields.opportunities, undefined);
        assert.strictEqual(manifest.field_definitions.campaignSourceId.type, 'TEXT');
        assert.strictEqual(manifest.field_definitions.leadSourceId.type, 'TEXT');
    });

    it('round-trips every canonical task status without reopening completed or cancelled tasks', async () => {
        createTestDB();
        const hotel = await business('Task lifecycle');
        DB.run(`INSERT INTO manager_tasks(taskId,instanceId,summary) VALUES ('lifecycle',?,'Тест')`, [hotel.id]);
        Store.upsertRecordLink({ businessId: hotel.id, entityType: 'manager_task', sourceTable: 'manager_tasks', sourceId: 'lifecycle', twentyObject: 'tasks', twentyRecordId: 'remote-life', sourceHash: 'old' });
        for (const [local, remote] of [['new', 'TODO'], ['in_progress', 'IN_PROGRESS'], ['done', 'DONE'], ['cancelled', 'DONE']]) {
            DB.updateManagerTask(hotel.id, 'lifecycle', { status: local });
            const snapshot = TwentyService._sourceSnapshot({ businessId: hotel.id, sourceTable: 'manager_tasks', sourceId: 'lifecycle' });
            assert.strictEqual(snapshot.status, remote);
            TwentyService._applyInbound({ businessId: hotel.id, twentyRecordId: 'remote-life', payloadJson: JSON.stringify({ data: snapshot }) });
            const task = DB.getManagerTask(hotel.id, 'lifecycle');
            assert.strictEqual(task.status, local);
            assert.strictEqual(Boolean(task.closedAt), ['done', 'cancelled'].includes(local));
        }
        TwentyService._applyInbound({ businessId: hotel.id, twentyRecordId: 'remote-life', payloadJson: JSON.stringify({ data: { status: 'TODO' } }) });
        assert.strictEqual(DB.getManagerTask(hotel.id, 'lifecycle').status, 'new');
        assert.strictEqual(DB.getManagerTask(hotel.id, 'lifecycle').closedAt, null);
    });

    it('normalizes obsolete closed status only on Twenty-linked tasks', async () => {
        createTestDB();
        const hotel = await business('Task legacy');
        for (const id of ['linked-old', 'unlinked-old']) {
            DB.run(`INSERT INTO manager_tasks(taskId,instanceId,summary,status) VALUES (?,?,'Старая задача','closed')`, [id, hotel.id]);
        }
        Store.upsertRecordLink({ businessId: hotel.id, entityType: 'manager_task', sourceTable: 'manager_tasks', sourceId: 'linked-old', twentyObject: 'tasks', twentyRecordId: 'legacy-remote', sourceHash: 'old' });
        DB.createTwentyTables();
        DB.createTwentyTables();
        assert.strictEqual(DB.getManagerTask(hotel.id, 'linked-old').status, 'done');
        assert.ok(DB.getManagerTask(hotel.id, 'linked-old').closedAt);
        assert.strictEqual(DB.getManagerTask(hotel.id, 'unlinked-old').status, 'closed');
    });

    it('reuses a rate-limited client until credentials change', async () => {
        createTestDB();
        const hotel = await business('Rate budget');
        TwentyService.configure(hotel.id, { base_url: 'https://twenty.example.test', api_key: 'rate-a' });
        const first = TwentyService._client(Store.getIntegration(hotel.id));
        first.requestTimes.push(Date.now());
        assert.strictEqual(TwentyService._client(Store.getIntegration(hotel.id)), first);
        assert.strictEqual(TwentyService._client(Store.getIntegration(hotel.id)).requestTimes.length, 1);
        TwentyService.configure(hotel.id, { api_key: 'rate-b' });
        assert.notStrictEqual(TwentyService._client(Store.getIntegration(hotel.id)), first);
    });

    it('recovers a lost create response with the same remote id and tenant-scoped retry', async () => {
        createTestDB();
        const hotel = await business('Lost response');
        const other = await business('Other hotel');
        TwentyService.configure(hotel.id, { base_url: 'https://twenty.example.test', api_key: 'lost-a', enabled: false });
        Store.updateStatus(hotel.id, { connectionStatus: 'connected' });
        TwentyService.configure(hotel.id, { enabled: true, mode: 'live' });
        DB.run('INSERT INTO clients(instanceId,chatId,senderName) VALUES (?,?,?)', [hotel.id, '79990004455@c.us', 'Тест']);
        const records = new Map();
        const originalFactory = TwentyService.clientFactory;
        let creates = 0;
        TwentyService.clientFactory = () => ({
            createRecord: async (_object, payload) => {
                creates += 1;
                if (records.has(payload.id)) throw Object.assign(new Error('Duplicate'), { statusCode: 400, code: 'TWENTY_DUPLICATE_RECORD', retryable: false });
                records.set(payload.id, payload);
                throw Object.assign(new Error('Response lost'), { retryable: true });
            },
            getRecord: async (_object, id) => records.get(id),
            updateRecord: async (_object, id, payload) => { records.set(id, { ...payload, id }); return { id }; },
        });
        try {
            await TwentyService.processOutbox(1);
            const event = DB.get('SELECT * FROM twenty_sync_outbox WHERE businessId=?', [hotel.id]);
            assert.strictEqual(event.status, 'PENDING');
            DB.run("UPDATE twenty_sync_outbox SET status='DEAD' WHERE eventId=?", [event.eventId]);
            assert.strictEqual(Store.retryFailed(other.id, event.eventId), false);
            assert.strictEqual(Store.retryFailed(hotel.id, event.eventId), true);
            await TwentyService.processOutbox(1);
            assert.strictEqual(records.size, 1);
            assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test([...records.keys()][0]));
            assert.strictEqual(creates, 2);
            assert.strictEqual(DB.get('SELECT status FROM twenty_sync_outbox WHERE eventId=?', [event.eventId]).status, 'DONE');
            assert.strictEqual(Store.getRecordLink(hotel.id, event.sourceTable, event.sourceId).twentyRecordId, [...records.keys()][0]);
        } finally { TwentyService.clientFactory = originalFactory; }
    });

    it('verifies HMAC, timestamp, workspace scope and webhook replay', async () => {
        createTestDB();
        const hotel = await business('Webhook Hotel');
        TwentyService.configure(hotel.id, {
            base_url: 'https://twenty.example.test', workspace_id: 'workspace-one', api_key: 'key',
            webhook_secret: 'shared-secret', enabled: true, mode: 'shadow',
        });
        TwentyService.connectWebhook(hotel.id, 'https://ava.example.test');
        const integration = Store.getIntegration(hotel.id);
        const token = decryptJson(integration.webhookTokenEncrypted, { businessId: hotel.id, field: 'webhookTokenEncrypted' }).token;
        const payload = { event: 'person.updated', workspaceId: 'workspace-one', data: { id: 'person-1', name: { firstName: 'Иван' } } };
        const rawBody = Buffer.from(JSON.stringify(payload));
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = crypto.createHmac('sha256', 'shared-secret').update(`${timestamp}:${rawBody}`).digest('hex');
        const makeRequest = (overrides = {}) => ({
            params: { opaqueToken: token }, body: payload, rawBody,
            get(name) {
                const headers = {
                    'X-Twenty-Webhook-Signature': signature,
                    'X-Twenty-Webhook-Timestamp': timestamp,
                    'X-Twenty-Webhook-Id': 'delivery-one',
                    ...overrides,
                };
                return headers[name];
            },
        });

        const first = responseCapture();
        handleTwentyWebhook(makeRequest(), first);
        assert.strictEqual(first.statusCode, 202);
        assert.strictEqual(first.body.idempotent, false);
        const replay = responseCapture();
        handleTwentyWebhook(makeRequest(), replay);
        assert.strictEqual(replay.body.idempotent, true);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS count FROM twenty_webhook_inbox').count, 1);

        const invalid = responseCapture();
        handleTwentyWebhook(makeRequest({ 'X-Twenty-Webhook-Signature': '00'.repeat(32) }), invalid);
        assert.strictEqual(invalid.statusCode, 401);

        const staleTimestamp = '100';
        const stale = responseCapture();
        handleTwentyWebhook({ ...makeRequest(), get(name) {
            if (name === 'X-Twenty-Webhook-Timestamp') return staleTimestamp;
            return makeRequest().get(name);
        } }, stale);
        assert.strictEqual(stale.statusCode, 401);
    });

    it('applies only allowlisted task updates inside the linked business', async () => {
        createTestDB();
        const first = await business('Hotel A');
        const second = await business('Hotel B');
        TwentyService.configure(first.id, { base_url: 'https://twenty.example.test', api_key: 'a', enabled: true, mode: 'shadow' });
        TwentyService.configure(second.id, { base_url: 'https://twenty.example.test', api_key: 'b', enabled: true, mode: 'shadow' });
        DB.run(`INSERT INTO manager_tasks (taskId,instanceId,summary) VALUES ('task-a',?,'Позвонить гостю')`, [first.id]);
        DB.run(`INSERT INTO manager_tasks (taskId,instanceId,summary) VALUES ('task-b',?,'Не менять')`, [second.id]);
        Store.upsertRecordLink({ businessId: first.id, entityType: 'manager_task', sourceTable: 'manager_tasks', sourceId: 'task-a', twentyObject: 'tasks', twentyRecordId: 'remote-task', sourceHash: 'old' });
        Store.saveWebhook({
            deliveryId: 'task-update', businessId: first.id, eventType: 'task.updated', twentyObject: 'task',
            twentyRecordId: 'remote-task', payloadHash: sha256('task-update'), payload: { event: 'task.updated', data: { id: 'remote-task', status: 'DONE', body: 'Гость подтверждён' } },
        });

        TwentyService.processWebhookInbox(10);
        assert.strictEqual(DB.get(`SELECT status FROM manager_tasks WHERE instanceId=? AND taskId='task-a'`, [first.id]).status, 'done');
        assert.strictEqual(DB.get(`SELECT status FROM manager_tasks WHERE instanceId=? AND taskId='task-b'`, [second.id]).status, 'new');
    });

    it('accepts the signed v2.37 eventName/record envelope and deduplicates re-signed retries', async () => {
        createTestDB();
        const hotel = await business('Twenty runtime contract');
        TwentyService.configure(hotel.id, {
            base_url: 'https://twenty.example.test', workspace_id: 'workspace-live', api_key: 'api-key',
            webhook_secret: 'contract-secret', enabled: true, mode: 'shadow',
        });
        TwentyService.connectWebhook(hotel.id, 'https://ava.example.test');
        const token = decryptJson(Store.getIntegration(hotel.id).webhookTokenEncrypted, { businessId: hotel.id, field: 'webhookTokenEncrypted' }).token;
        DB.run(`INSERT INTO manager_tasks (taskId,instanceId,summary) VALUES ('runtime-task',?,'Проверка')`, [hotel.id]);
        Store.upsertRecordLink({ businessId: hotel.id, entityType: 'manager_task', sourceTable: 'manager_tasks', sourceId: 'runtime-task', twentyObject: 'tasks', twentyRecordId: 'remote-runtime-task', sourceHash: 'old' });
        const payload = {
            targetUrl: `https://ava.example.test/api/integrations/twenty/webhooks/${token}`,
            eventName: 'task.updated', workspaceId: 'workspace-live', webhookId: 'webhook-one',
            eventDate: new Date().toISOString(), objectMetadata: { nameSingular: 'task', id: 'meta-task' },
            record: { id: 'remote-runtime-task', status: 'DONE', bodyV2: { markdown: 'Обработано' }, email: 'private@example.test' },
            updatedFields: ['status'],
        };
        const rawBody = Buffer.from(JSON.stringify(payload));
        const deliver = (timestamp) => {
            const signature = crypto.createHmac('sha256', 'contract-secret').update(`${timestamp}:${rawBody}`).digest('hex');
            const response = responseCapture();
            handleTwentyWebhook({ params: { opaqueToken: token }, body: payload, rawBody, get(name) {
                return { 'X-Twenty-Webhook-Timestamp': timestamp, 'X-Twenty-Webhook-Signature': signature }[name];
            } }, response);
            return response;
        };
        const first = deliver(String(Date.now()));
        assert.strictEqual(first.statusCode, 202);
        assert.strictEqual(first.body.idempotent, false);
        const replay = deliver(String(Date.now() + 1000));
        assert.strictEqual(replay.statusCode, 202);
        assert.strictEqual(replay.body.idempotent, true);
        const stored = DB.get('SELECT payloadJson FROM twenty_webhook_inbox');
        assert.strictEqual(stored.payloadJson.includes(token), false);
        assert.strictEqual(stored.payloadJson.includes('private@example.test'), false);
        TwentyService.processWebhookInbox(10);
        assert.strictEqual(DB.get(`SELECT status FROM manager_tasks WHERE taskId='runtime-task'`).status, 'done');
        assert.strictEqual(DB.get(`SELECT resolutionNote FROM manager_tasks WHERE taskId='runtime-task'`).resolutionNote, 'Обработано');
    });

    it('requires a fresh connection test after changing Twenty connection parameters', async () => {
        createTestDB();
        const hotel = await business('Retest Hotel');
        TwentyService.configure(hotel.id, {
            base_url: 'https://twenty.example.test', workspace_id: 'workspace-old',
            api_key: 'old-key', enabled: false, mode: 'shadow',
        });
        Store.updateStatus(hotel.id, { connectionStatus: 'connected' });

        assert.throws(() => TwentyService.configure(hotel.id, {
            base_url: 'https://twenty-new.example.test', workspace_id: 'workspace-new',
            api_key: 'new-key', enabled: true, mode: 'live',
        }), (error) => error.code === 'TWENTY_CONNECTION_NOT_VERIFIED');

        const saved = TwentyService.configure(hotel.id, {
            base_url: 'https://twenty-new.example.test', workspace_id: 'workspace-new',
            api_key: 'new-key', enabled: false, mode: 'shadow',
        });
        assert.strictEqual(saved.connection_status, 'not_tested');
    });

    it('does not persist webhook credentials when the public URL is invalid', async () => {
        createTestDB();
        const hotel = await business('Webhook Validation Hotel');
        TwentyService.configure(hotel.id, {
            base_url: 'https://twenty.example.test', api_key: 'key', enabled: true, mode: 'shadow',
        });

        assert.throws(() => TwentyService.connectWebhook(hotel.id, 'http://ava.example.test'),
            (error) => error.code === 'TWENTY_PUBLIC_URL_REQUIRED');
        const raw = Store.getIntegration(hotel.id);
        assert.strictEqual(raw.webhookTokenEncrypted, null);
        assert.strictEqual(raw.webhookSecretEncrypted, null);
    });
});
