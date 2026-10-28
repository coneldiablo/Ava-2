'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const NativeCrm = require('../src/services/customer-native-crm.service');
const Identity = require('../src/services/identity/identity-store');
const express = require('express');

describe('Customer scoped Twenty task', () => {
    it('denies cross-tenant and cross-origin task requests before writes', async () => {
        const authorize = Identity.authorizeCapability, create = NativeCrm.createTask;
        const previousOrigin = process.env.WHATSAPP_CRM_PUBLIC_URL;
        process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
        let writes = 0;
        Identity.authorizeCapability = (_auth, businessId) => {
            if (businessId !== 7) throw Object.assign(new Error('denied'), { statusCode: 403 });
            return businessId;
        };
        NativeCrm.createTask = () => { writes++; return { taskId: 'customer_' + 'a'.repeat(64), nativeStatus: 'pending' }; };
        const app = express();
        app.use(express.json());
        app.use('/api', (req, _res, next) => { req.auth = { userId: 'owner-a' }; next(); });
        app.use('/api', require('../src/routes/customer-native-crm.routes'));
        const server = await new Promise(resolve => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        const base = `http://127.0.0.1:${server.address().port}/api/businesses`;
        const request = (id, origin) => fetch(`${base}/${id}/crm/tasks`, { method: 'POST',
            headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': '550e8400-e29b-41d4-a716-446655440000' },
            body: JSON.stringify({ summary: 'Позвонить гостю' }) });
        try {
            assert.equal((await request(8, 'https://ava.example.test')).status, 403);
            assert.equal((await request(7, 'https://evil.example')).status, 403);
            assert.equal(writes, 0);
            assert.equal((await request(7, 'https://ava.example.test')).status, 202);
            assert.equal(writes, 1);
        } finally {
            await new Promise(resolve => server.close(resolve));
            Identity.authorizeCapability = authorize; NativeCrm.createTask = create;
            if (previousOrigin === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
            else process.env.WHATSAPP_CRM_PUBLIC_URL = previousOrigin;
        }
    });

    it('queues one task for a live workspace, deduplicates retries, and waits for readback', () => {
        const previous = DB.db;
        const database = createTestDB();
        try {
            DB.run("INSERT INTO instances(id,name) VALUES (7,'Отель А'),(8,'Отель Б')");
            DB.run(`INSERT INTO twenty_workspace_links
                (id,businessId,baseUrl,apiKeyEncrypted,enabled,mode,connectionStatus)
                VALUES ('t7',7,'https://twenty.example','encrypted',1,'live','connected')`);
            const key = '550e8400-e29b-41d4-a716-446655440000';
            const first = NativeCrm.createTask(7, 'user-a', { key, summary: 'Позвонить гостю' });
            assert.equal(first.nativeStatus, 'pending');
            assert.deepEqual(NativeCrm.createTask(7, 'user-a', { key, summary: 'Позвонить гостю' }), first);
            assert.equal(DB.get('SELECT COUNT(*) count FROM manager_tasks WHERE instanceId=7').count, 1);
            assert.equal(DB.get("SELECT COUNT(*) count FROM twenty_sync_outbox WHERE businessId=7 AND sourceTable='manager_tasks'").count, 1);
            assert.throws(() => NativeCrm.taskState(8, first.taskId), { code: 'TASK_NOT_FOUND' });
            assert.throws(() => NativeCrm.createTask(8, 'user-a', { key, summary: 'Чужая задача' }), { code: 'TWENTY_NOT_READY' });
            DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES (8,'79990001122@c.us','Чужой клиент')");
            assert.throws(() => NativeCrm.createTask(7, 'user-a', {
                key: '550e8400-e29b-41d4-a716-446655440001', summary: 'Чужой контакт', chatId: '79990001122@c.us',
            }), { code: 'CLIENT_NOT_FOUND' });
            DB.run(`INSERT INTO twenty_record_links
                (id,businessId,entityType,sourceTable,sourceId,twentyObject,twentyRecordId,lastSyncedAt)
                VALUES ('link',7,'manager_task','manager_tasks',?,'tasks','native-id',CURRENT_TIMESTAMP)`, [first.taskId]);
            DB.run("UPDATE twenty_sync_outbox SET status='DONE' WHERE businessId=7 AND sourceId=?", [first.taskId]);
            assert.equal(NativeCrm.taskState(7, first.taskId).nativeStatus, 'verified');
        } finally { database.close(); DB.db = previous; }
    });
});
