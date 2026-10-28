// Candidate integration gate. These tests intentionally fail until the three
// Command Center routers have been mounted on the functional dashboard base.
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const Deals = require('../src/services/customer-deals.store');
const app = require('../src/app').app;

function member(email, businessId, role) {
    const invitation = Identity.createInvitation({ platformRole: 'platform_admin' },
        { email, businessId, role });
    return Identity.completeInvitation(Identity.claimInvitation(invitation.token), `subject-${email}`);
}

function fixture() {
    createTestDB();
    Identity.ensureSchema();
    DB.run(`INSERT INTO instances(id,name,hotelTimezone) VALUES
        (1,'Acceptance A','UTC'),(2,'Acceptance B','UTC')`);
    const ownerA = member('dashboard-a@example.test', 1, 'hotel_owner');
    const managerA = member('dashboard-manager@example.test', 1, 'manager');
    const ownerB = member('dashboard-b@example.test', 2, 'hotel_owner');
    return { ownerA, managerA, ownerB };
}

async function withServer(fn) {
    const actors = fixture();
    const previous = { enabled: Auth.config.enabled, access: process.env.AVA_CUSTOMER_ACCESS_ENABLED,
        publicUrl: process.env.WHATSAPP_CRM_PUBLIC_URL };
    Auth.config.enabled = true;
    process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.WHATSAPP_CRM_PUBLIC_URL = base;
    async function request(actor, path, { method = 'GET', body, origin = base } = {}) {
        const token = actor && Identity.createSession(actor.subject, `dashboard-${actor.userId}`);
        const response = await fetch(`${base}/api${path}`, {
            method,
            headers: {
                ...(token ? { Cookie: `crm_session=ava2:${token}` } : {}),
                'Sec-Fetch-Site': 'same-origin',
                ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const contentType = response.headers.get('content-type') || '';
        return { status: response.status, body: contentType.includes('application/json') ? await response.json()
            : contentType.includes('application/pdf') ? Buffer.from(await response.arrayBuffer()) : await response.text(),
            contentType };
    }
    try { return await fn({ ...actors, request }); }
    finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        Auth.config.enabled = previous.enabled;
        if (previous.access === undefined) delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        else process.env.AVA_CUSTOMER_ACCESS_ENABLED = previous.access;
        if (previous.publicUrl === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
        else process.env.WHATSAPP_CRM_PUBLIC_URL = previous.publicUrl;
    }
}

function count(response) {
    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    assert.strictEqual(response.body.success, true);
    return response.body;
}

describe('Dashboard Command Center acceptance', () => {
    it('keeps 7/30/90-day metrics tenant-scoped, audited and separated by currency', async () => {
        await withServer(async ({ ownerA, managerA, ownerB, request }) => {
            DB.run(`INSERT INTO clients(instanceId,chatId,senderName,createdAt) VALUES
                (1,'shared','A recent',datetime('now','-5 days')),
                (1,'older','A month',datetime('now','-20 days')),
                (1,'oldest','A quarter',datetime('now','-70 days')),
                (1,'outside','A older',datetime('now','-100 days')),
                (2,'shared','B only',datetime('now','-1 day'))`);
            DB.run(`INSERT INTO messages(instanceId,chatId,senderName,content,role,timestamp) VALUES
                (1,'shared','A recent','in','user',datetime('now','-1 day')),
                (1,'shared','AVA','out','assistant',datetime('now','-1 day')),
                (2,'shared','B only','foreign','user',datetime('now','-1 day'))`);

            // Model a pre-migration win: the deal exists but has no audited close.
            const historical = Deals.create(1,
                { title: 'Historical KZT win', amount: 500, currency: 'KZT', stage: 'won' });
            DB.run('DELETE FROM dashboard_deal_won_events WHERE instanceId=? AND dealId=?',
                [1, historical.id]);
            const initial = count(await request(ownerA, '/dashboard/1/metrics?days=7'));
            assert.strictEqual(initial.kpis.deals.won, 0);
            assert.strictEqual(initial.sources.closedDeals.status, 'partial');

            Deals.create(1, { title: 'RUB open', amount: 120.50, currency: 'RUB' });
            Deals.create(1, { title: 'USD open', amount: 10, currency: 'USD' });
            const closed = Deals.create(1, { title: 'EUR win', amount: 25, currency: 'EUR' });
            Deals.update(1, closed.id, { stage: 'won', revision: closed.revision });
            Deals.create(2, { title: 'Foreign deal', amount: 999999, currency: 'RUB' });

            const expected = [[7, 1], [30, 2], [90, 3]];
            for (const [days, leads] of expected) {
                const body = count(await request(ownerA, `/dashboard/1/metrics?days=${days}`));
                assert.strictEqual(body.business_id, 1);
                assert.strictEqual(body.period.days, days);
                assert.strictEqual(body.period.timezone, 'UTC');
                assert.strictEqual(body.series.leads.length, days);
                assert.strictEqual(body.series.closedDeals.length, days);
                assert.strictEqual(body.kpis.leads.created, leads);
                assert.strictEqual(body.kpis.messages.inbound, 1);
                assert.strictEqual(body.kpis.messages.outbound, 1);
                assert.strictEqual(body.kpis.deals.won, 1, 'only audited transition is a dated win');
                assert.deepStrictEqual(body.kpis.deals.openAmounts,
                    [{ currency: 'RUB', amountMinor: 12050 }, { currency: 'USD', amountMinor: 1000 }]);
                assert.deepStrictEqual(body.kpis.deals.wonAmounts, [{ currency: 'EUR', amountMinor: 2500 }]);
                assert.strictEqual(body.kpis.ai.status, 'partial');
                assert.strictEqual(body.kpis.ai.recordedSuccessfulToolRuns, 0);
                assert.strictEqual(Object.hasOwn(body.kpis.deals, 'totalRevenue'), false);
            }
            assert.strictEqual(count(await request(managerA, '/dashboard/1/metrics?days=7')).business_id, 1);
            const foreign = count(await request(ownerB, '/dashboard/2/metrics?days=7'));
            assert.strictEqual(foreign.kpis.leads.created, 1);
            assert.strictEqual(foreign.kpis.messages.total, 1);
            assert.strictEqual((await request(ownerA, '/dashboard/2/metrics?days=7')).status, 403);
            assert.strictEqual((await request(ownerA, '/dashboard/1/metrics?days=7&businessId=2')).status, 403);
            assert.strictEqual((await request(ownerA, '/dashboard/1/metrics?days=8')).status, 400);
            assert.strictEqual((await request(ownerA, '/dashboard/invalid/metrics')).status, 400);
            assert.notStrictEqual((await request(null, '/dashboard/1/metrics?days=7')).status, 200);
            DB.run('UPDATE ava_business_memberships SET enabled=0 WHERE userId=? AND businessId=1', [ownerA.userId]);
            assert.strictEqual((await request(ownerA, '/dashboard/1/metrics?days=7')).status, 403,
                'revoked membership must be checked on the next request');
            DB.run('UPDATE instances SET isActive=0 WHERE id=2');
            assert([403, 404].includes((await request(ownerB, '/dashboard/2/metrics?days=7')).status),
                'inactive business must not return dashboard data');
        });
    });

    it('shows only evidenced risks and persists scoped task actions', async () => {
        await withServer(async ({ ownerA, ownerB, managerA, request }) => {
            const empty = count(await request(ownerA, '/dashboard/1/intelligence'));
            assert.deepStrictEqual(empty.priorities, []);
            assert.deepStrictEqual(empty.deals.items, []);
            assert.strictEqual(empty.sentiment.status, 'insufficient_data');
            assert.strictEqual(empty.agents.status, 'unavailable');

            DB.run(`INSERT INTO clients(instanceId,chatId,senderName) VALUES
                (1,'shared','A contact'),(2,'shared','B contact')`);
            DB.run(`INSERT INTO messages(instanceId,chatId,senderName,content,timestamp) VALUES
                (1,'shared','A contact','old',datetime('now','-8 days')),
                (2,'shared','B contact','recent',datetime('now'))`);
            const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
            const deal = Deals.create(1, { title: 'A overdue deal', clientChatId: 'shared',
                amount: 75, currency: 'USD', nextAction: 'Call the customer', nextActionAt: yesterday });
            Deals.create(2, { title: 'B private deal', clientChatId: 'shared', amount: 9999, currency: 'RUB' });
            const task = DB.createManagerTask({ instanceId: 1, assigneeUserId: managerA.userId, chatId: 'shared',
                summary: 'A urgent task', priority: 'urgent' });
            DB.createManagerTask({ instanceId: 2, chatId: 'shared',
                summary: 'B private task', priority: 'urgent' });

            const own = count(await request(managerA, '/dashboard/1/intelligence'));
            assert(own.deals.items.some(item => item.id === deal.id && item.currency === 'USD'));
            const priority = own.priorities.find(item => item.id === task.taskId);
            assert(priority);
            assert.strictEqual(priority.score, priority.scoreFactors.reduce((sum, factor) => sum + factor.points, 0));
            assert.strictEqual(priority.completeAction.method, 'PATCH');
            assert(!JSON.stringify(own).includes('B private'));
            assert.strictEqual((await request(ownerA, '/dashboard/2/intelligence')).status, 403);
            assert.strictEqual((await request(ownerA, '/dashboard/1/intelligence?businessId=2')).status, 403);
            assert.strictEqual((await request(ownerA, `/dashboard/2/tasks/${task.taskId}`,
                { method: 'PATCH', body: { status: 'done' } })).status, 403);
            assert.strictEqual((await request(ownerB, `/dashboard/2/tasks/${task.taskId}`,
                { method: 'PATCH', body: { status: 'done' } })).status, 404);
            assert.strictEqual((await request(managerA, `/dashboard/1/tasks/${task.taskId}`,
                { method: 'PATCH', body: { status: 'done' }, origin: 'https://foreign.test' })).status, 403);
            assert.strictEqual(DB.getManagerTask(1, task.taskId).status, 'new');
            const completed = count(await request(managerA, `/dashboard/1/tasks/${task.taskId}`,
                { method: 'PATCH', body: { status: 'done' } }));
            assert.strictEqual(completed.task.status, 'done');
            assert.strictEqual(DB.getManagerTask(1, task.taskId).status, 'done');
            assert(!count(await request(ownerA, '/dashboard/1/intelligence')).priorities
                .some(item => item.id === task.taskId));
        });
    });

    it('keeps briefing and Ask honest for an empty or foreign tenant', async () => {
        await withServer(async ({ ownerA, managerA, ownerB, request }) => {
            const briefing = count(await request(ownerA, '/dashboard/1/ai/briefing'));
            assert.strictEqual(briefing.briefing.businessId, 1);
            assert.strictEqual(briefing.briefing.eventCount, 0);
            assert.deepStrictEqual(briefing.briefing.recommendations, []);
            assert.strictEqual(briefing.briefing.sourceUpdatedAt, null);
            assert.strictEqual(briefing.briefing.capabilities.pdf, true);
            assert.strictEqual(typeof briefing.briefing.capabilities.audio.available, 'boolean');
            assert(!/сделки готовы|онлайн|online|priority score\s*92/i.test(briefing.briefing.summary));
            const recommendations = count(await request(ownerA, '/dashboard/1/ai/recommendations'));
            assert.deepStrictEqual(recommendations.recommendations, []);
            const pdf = await request(ownerA, '/dashboard/1/ai/briefing.pdf');
            assert.strictEqual(pdf.status, 200, 'briefing PDF must be available for the selected business');
            assert.match(pdf.contentType, /application\/pdf/);
            assert.strictEqual(pdf.body.subarray(0, 5).toString(), '%PDF-');
            if (!briefing.briefing.capabilities.audio.available) {
                const audio = await request(ownerA, '/dashboard/1/ai/briefing/audio');
                assert.strictEqual(audio.status, 503);
                assert.strictEqual(audio.body.code, 'AUDIO_UNAVAILABLE');
            }
            const answer = count(await request(managerA, '/dashboard/1/ai/ask',
                { method: 'POST', body: { question: 'Какой прогноз выручки?' } }));
            assert.strictEqual(answer.grounded, false);
            assert.deepStrictEqual(answer.sources, []);
            assert.match(answer.answer, /нет|нельзя|отсутств/i);
            assert.strictEqual((await request(ownerA, '/dashboard/2/ai/briefing')).status, 403);
            assert.strictEqual((await request(ownerB, '/dashboard/1/ai/recommendations')).status, 403);
            assert.strictEqual((await request(ownerA, '/dashboard/1/ai/ask',
                { method: 'POST', body: { question: 'Прогноз', businessId: 2 } })).status, 403);
            assert.strictEqual((await request(ownerA, '/dashboard/1/ai/ask',
                { method: 'POST', body: { question: 'Прогноз' }, origin: 'https://foreign.test' })).status, 403);
        });
    });
});
