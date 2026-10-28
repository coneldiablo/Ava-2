'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const axios = require('axios');
const DB = require('../src/services/database.service');
const config = require('../src/config');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const Provisioning = require('../src/services/provisioning/business-provisioning-store.service');
const router = require('../src/routes/customer-activity.routes');

const platformAdmin = { userId: 'test-admin', platformRole: 'platform_admin' };

function enroll(email) {
    const invitation = Identity.createInvitation(platformAdmin, { email });
    const claim = Identity.claimInvitation(invitation.token);
    return Identity.completeInvitation(claim, `subject-${email}`);
}

async function invoke(businessId, auth, limit = '50', type = 'all') {
    const handler = router.stack.find(layer => layer.route?.path === '/businesses/:businessId/activity').route.stack[0].handle;
    const response = { statusCode: 200, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; } };
    const oldCustomer = process.env.AVA_CUSTOMER_ACCESS_ENABLED;
    process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
    try {
        if (auth?.platformRole === 'platform_admin' && !auth.subject) {
            DB.run("INSERT OR IGNORE INTO ava_users(id,subject,email,platformRole) VALUES (?,?,'activity-admin@example.test','platform_admin')",
                [auth.userId,'activity-admin-subject']);
            auth = Identity.actor(auth.userId);
        }
        const token = auth?.subject ? Identity.createSession(auth.subject, 'activity-direct-test') : null;
        await handler({ params: { businessId: String(businessId) }, query: { limit, type }, auth,
            headers: token ? { cookie: `crm_session=ava2:${token}` } : {} }, response);
    } finally {
        if (oldCustomer === undefined) delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        else process.env.AVA_CUSTOMER_ACCESS_ENABLED = oldCustomer;
    }
    return response;
}

describe('Customer activity tenant scope', () => {
    it('authorizes live business access and returns bounded safe events', async () => {
        const original = { all: DB.all, authorizeCapability: Identity.authorizeCapability, getSession: Auth.getSession,
            serviceToken: config.avaAdmin.serviceToken };
        const calls = [];
        DB.all = (sql, params) => {
            calls.push([sql, params]);
            if (sql.includes('FROM messages')) return [{ id: 2, chatId: 'guest@c.us', senderName: 'Гость', content: 'x'.repeat(700), role: 'user', timestamp: '2026-09-20 12:00:00', aiThought: 'secret' }];
            if (sql.includes('FROM lead_status_history')) return [{ id: 3, chatId: 'guest@c.us', fromStatus: 'new', toStatus: 'qualified', createdAt: '2026-09-20 13:00:00', reason: 'secret', changedBy: 'secret' }];
            return [];
        };
        config.avaAdmin.serviceToken = '';
        Auth.getSession = req => req.auth;
        Identity.authorizeCapability = (_auth, id) => { if (id !== 7) throw Object.assign(new Error('denied'), { statusCode: 403 }); };
        const handler = router.stack.find(layer => layer.route?.path === '/businesses/:businessId/activity').route.stack[0].handle;
        const request = async (businessId, query = {}, customer = true) => {
            const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
            await handler({ params: { businessId: String(businessId) }, query, auth: customer ? { userId: 'customer-1' } : { platformRole: 'platform_admin' } }, response);
            return response;
        };
        try {
            let response = await request(8);
            assert.equal(response.statusCode, 403);
            assert.equal(calls.length, 0, 'denied business must not query activity');
            response = await request(7, { type: 'unexpected' });
            assert.equal(response.statusCode, 400);
            assert.equal(calls.length, 0, 'invalid event type must not query activity');
            response = await request(7, {}, false);
            assert.equal(response.statusCode, 200, 'platform admin may inspect an explicitly selected business');
            response = await request(7, { limit: '999999' });
            assert.equal(response.statusCode, 200);
            assert.equal(response.body.events.length, 2);
            assert.equal(response.body.events[0].type, 'status');
            assert.equal(response.body.events[1].type, 'message');
            assert.equal(JSON.stringify(response.body).includes('secret'), false);
            assert.equal(response.body.events.find(event => event.type === 'message').detail.length, 500,
                'message detail is safely truncated');
            assert.equal(response.body.callHistoryStatus, 'unavailable');
            assert.deepEqual(calls.map(([, params]) => params), [
                [7, 50], [7, 50], [7, 50], [7, 50],
                [7, 100], [7, 100], [7, 100], [7, 100],
            ]);
        } finally {
            DB.all = original.all;
            Identity.authorizeCapability = original.authorizeCapability;
        Auth.getSession = original.getSession;
            config.avaAdmin.serviceToken = original.serviceToken;
        }
    });

    it('isolates real activity for two active tenants sharing the same chat id', async () => {
        createTestDB();
        const firstOwner = enroll('activity-one@example.test');
        const secondOwner = enroll('activity-two@example.test');
        const firstBusiness = Provisioning.createBusinessAtomic({ name: 'Activity One' }, { ownerUserId: firstOwner.userId }).instance;
        const secondBusiness = Provisioning.createBusinessAtomic({ name: 'Activity Two' }, { ownerUserId: secondOwner.userId }).instance;
        const sharedChatId = '79990000001@c.us';

        for (const [business, name, message, status] of [
            [firstBusiness, 'First Guest', 'First tenant message', 'qualified'],
            [secondBusiness, 'Second Guest', 'Second tenant message', 'audit'],
        ]) {
            await DB.getOrCreateClient(business.id, sharedChatId, name);
            await DB.saveMessageWithChannel(business.id, sharedChatId, name, message, 'user', 'whatsapp', 'internal ai thought');
            await DB.updateClientStatus(business.id, sharedChatId, status, 'private transition note', 'manager');
        }

        const own = await invoke(firstBusiness.id, firstOwner);
        assert.equal(own.statusCode, 200);
        assert.equal(own.body.businessId, firstBusiness.id);
        assert.equal(own.body.events.length, 2);
        assert.ok(own.body.events.every(event => event.chatId === sharedChatId));
        assert.ok(own.body.events.some(event => event.detail === 'First tenant message'));
        assert.ok(own.body.events.some(event => event.detail.includes('Квалифицирован')));
        assert.equal(JSON.stringify(own.body).includes('Second tenant'), false);
        assert.equal(JSON.stringify(own.body).includes('Second tenant message'), false);
        assert.equal(JSON.stringify(own.body).includes('internal ai thought'), false);
        assert.equal(JSON.stringify(own.body).includes('private transition note'), false);

        const crossTenant = await invoke(secondBusiness.id, firstOwner);
        assert.equal(crossTenant.statusCode, 403);
        assert.equal(JSON.stringify(crossTenant.body).includes('Second tenant message'), false);

        const scopedAdmin = await invoke(firstBusiness.id, platformAdmin);
        assert.equal(scopedAdmin.statusCode, 200, 'platform admin may read only the explicitly scoped business');
        assert.equal(JSON.stringify(scopedAdmin.body).includes('First tenant message'), true);
        assert.equal(JSON.stringify(scopedAdmin.body).includes('Second tenant message'), false);
    });

    it('merges real task, follow-up and verified call events without crossing tenants', async () => {
        createTestDB();
        const firstOwner = enroll('activity-stream-one@example.test');
        const secondOwner = enroll('activity-stream-two@example.test');
        const first = Provisioning.createBusinessAtomic({ name: 'Stream One' }, { ownerUserId: firstOwner.userId }).instance;
        const second = Provisioning.createBusinessAtomic({ name: 'Stream Two' }, { ownerUserId: secondOwner.userId }).instance;
        const chatId = '79990000002@c.us';
        DB.createManagerTask({ taskId: 'first-task', instanceId: first.id, chatId,
            customerName: 'First guest', summary: 'First task summary' });
        DB.updateManagerTask(first.id, 'first-task', { status: 'done' });
        DB.run('UPDATE manager_tasks SET createdAt = ? WHERE instanceId = ? AND taskId = ?',
            ['2026-09-22 11:00:00', first.id, 'first-task']);
        DB.createFollowupDraft({ draftId: 'first-draft', instanceId: first.id, chatId,
            text: 'First follow-up text' });
        DB.run('UPDATE followup_drafts SET status = ?, text = ?, sentAt = ? WHERE instanceId = ? AND draftId = ?',
            ['sent', 'Edited first follow-up', '2026-09-22T11:00:00Z', first.id, 'first-draft']);
        DB.createManagerTask({ taskId: 'second-task', instanceId: second.id, chatId,
            customerName: 'Second guest', summary: 'Second tenant secret' });

        const original = { get: axios.get, ...config.avaAdmin };
        config.avaAdmin.apiUrl = 'https://admin.example.test';
        config.avaAdmin.serviceToken = 'test-service-token';
        axios.get = async (url, options) => {
            assert.equal(url, `https://admin.example.test/api/internal/calls/business/${first.id}`);
            assert.equal(options.params.page_size, 50);
            return { data: { calls: [{ id: 5, business_id: first.id, call_id: 'first-call',
                caller_number: '+79991234567', direction: 'inbound', outcome: 'answered',
                start_time: '2026-09-22T10:00:00Z', provider_secret: 'must-not-leak' }] } };
        };
        try {
            const own = await invoke(first.id, firstOwner);
            assert.equal(own.statusCode, 200);
            assert.equal(own.body.callHistoryStatus, 'ready');
            assert.ok(own.body.events.some(event => event.type === 'task' && event.detail === 'First task summary'));
            assert.ok(own.body.events.some(event => event.title === 'Задача выполнена'));
            assert.ok(own.body.events.some(event => event.title === 'Черновик follow-up'
                && event.detail === 'First follow-up text'));
            assert.ok(own.body.events.some(event => event.title === 'Follow-up отправлен'
                && event.detail === 'Edited first follow-up'));
            assert.ok(own.body.events.some(event => event.type === 'call' && event.detail.includes('+79991234567')));
            assert.ok(own.body.events.findIndex(event => event.id === 'task-first-task')
                < own.body.events.findIndex(event => event.id === 'call-5'),
            'SQLite UTC 11:00 must sort after a call at ISO UTC 10:00');
            assert.equal(JSON.stringify(own.body).includes('Second tenant secret'), false);
            assert.equal(JSON.stringify(own.body).includes('must-not-leak'), false);

            const onlyCalls = await invoke(first.id, firstOwner, '50', 'call');
            assert.equal(onlyCalls.statusCode, 200);
            assert.equal(onlyCalls.body.events.length, 1);
            assert.equal(onlyCalls.body.events[0].type, 'call');
            const onlyTasks = await invoke(first.id, firstOwner, '50', 'task');
            assert.equal(onlyTasks.body.callHistoryStatus, 'not_requested');
            assert.ok(onlyTasks.body.events.every(event => event.type === 'task'));

            const denied = await invoke(second.id, firstOwner);
            assert.equal(denied.statusCode, 403);

            axios.get = async () => ({ data: { calls: [{ id: 6, business_id: second.id,
                start_time: '2026-09-22T10:00:00Z' }] } });
            const mismatched = await invoke(first.id, firstOwner);
            assert.equal(mismatched.body.callHistoryStatus, 'unavailable');
            assert.equal(mismatched.body.events.some(event => event.type === 'call'), false);
        } finally {
            axios.get = original.get;
            Object.assign(config.avaAdmin, { apiUrl: original.apiUrl, serviceToken: original.serviceToken,
                timeoutMs: original.timeoutMs });
        }
    });

    it('drops the entire response when business access is revoked during a call read', async () => {
        createTestDB();
        const owner = enroll('activity-revoked@example.test');
        const business = Provisioning.createBusinessAtomic({ name: 'Revoked Stream' }, { ownerUserId: owner.userId }).instance;
        const original = { get: axios.get, authorizeCapability: Identity.authorizeCapability, getSession: Auth.getSession,
            apiUrl: config.avaAdmin.apiUrl, serviceToken: config.avaAdmin.serviceToken };
        config.avaAdmin.apiUrl = 'https://admin.example.test';
        config.avaAdmin.serviceToken = 'test-service-token';
        let authorizationChecks = 0;
        Auth.getSession = req => req.auth;
        Identity.authorizeCapability = () => {
            authorizationChecks++;
            if (authorizationChecks > 1) throw Object.assign(new Error('revoked'), { statusCode: 403 });
        };
        axios.get = async () => ({ data: { calls: [{ id: 1, business_id: business.id,
            start_time: '2026-09-22T10:00:00Z', caller_number: '+79990000000' }] } });
        try {
            const response = await invoke(business.id, owner);
            assert.equal(response.statusCode, 403);
            assert.equal(JSON.stringify(response.body).includes('79990000000'), false);
            assert.equal(authorizationChecks, 2);
        } finally {
            axios.get = original.get;
            Identity.authorizeCapability = original.authorizeCapability;
        Auth.getSession = original.getSession;
            config.avaAdmin.apiUrl = original.apiUrl;
            config.avaAdmin.serviceToken = original.serviceToken;
        }
    });

    it('includes recently closed old tasks and recently sent old drafts in filtered feeds', async () => {
        createTestDB();
        const owner = enroll('activity-older-events@example.test');
        const business = Provisioning.createBusinessAtomic({ name: 'Older Stream' }, { ownerUserId: owner.userId }).instance;
        DB.createManagerTask({ taskId: 'old-task', instanceId: business.id, summary: 'Old task closed today' });
        DB.run('UPDATE manager_tasks SET createdAt = ?, closedAt = ?, status = ? WHERE instanceId = ? AND taskId = ?',
            ['2026-01-01 00:00:00', '2026-09-23T10:00:00Z', 'done', business.id, 'old-task']);
        DB.createFollowupDraft({ draftId: 'old-draft', instanceId: business.id, text: 'Old draft sent today' });
        DB.run('UPDATE followup_drafts SET createdAt = ?, sentAt = ?, status = ? WHERE instanceId = ? AND draftId = ?',
            ['2026-01-01 00:00:00', '2026-09-23T10:00:00Z', 'sent', business.id, 'old-draft']);
        for (let index = 0; index < 11; index++) {
            const taskId = `new-task-${index}`;
            const draftId = `new-draft-${index}`;
            DB.createManagerTask({ taskId, instanceId: business.id, summary: taskId });
            DB.createFollowupDraft({ draftId, instanceId: business.id, text: draftId });
            DB.run('UPDATE manager_tasks SET createdAt = ? WHERE instanceId = ? AND taskId = ?',
                ['2026-09-22 00:00:00', business.id, taskId]);
            DB.run('UPDATE followup_drafts SET createdAt = ? WHERE instanceId = ? AND draftId = ?',
                ['2026-09-22 00:00:00', business.id, draftId]);
        }
        const tasks = await invoke(business.id, owner, '10', 'task');
        assert.equal(tasks.statusCode, 200);
        assert.ok(tasks.body.events.some(event => event.id === 'task-closed-old-task'));
        const drafts = await invoke(business.id, owner, '10', 'followup');
        assert.equal(drafts.statusCode, 200);
        assert.ok(drafts.body.events.some(event => event.id === 'followup-sent-old-draft'));
    });
});
