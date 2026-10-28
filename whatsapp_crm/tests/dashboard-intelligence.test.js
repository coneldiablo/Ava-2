'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Deals = require('../src/services/customer-deals.store');
const Identity = require('../src/services/identity/identity-store');
const Intelligence = require('../src/services/dashboard/intelligence.service');
const routes = require('../src/routes/dashboard-intelligence.routes');
const express = require('express');

const NOW = new Date('2026-09-24T12:00:00Z');

async function setup() {
    createTestDB();
    Identity.ensureSchema();
    const a = await DB.createInstance({ name: 'A' });
    const b = await DB.createInstance({ name: 'B' });
    Deals.ensureSchema();
    return { a, b };
}

function seedUser(email, businessId) {
    const invite = Identity.createInvitation({ platformRole: 'platform_admin' },
        { email, businessId, role: 'hotel_owner' });
    return Identity.completeInvitation(Identity.claimInvitation(invite.token), `${email}-sub`);
}

describe('Dashboard intelligence', () => {
    it('returns honest empty states and no invented agent count', async () => {
        const { a } = await setup();
        const result = Intelligence.getIntelligence(a.id, { now: NOW });
        assert.deepStrictEqual(result.priorities, []);
        assert.deepStrictEqual(result.deals.items, []);
        assert.strictEqual(result.deals.status, 'available');
        assert.deepStrictEqual(result.dayPlan.items, []);
        assert.strictEqual(result.sentiment.status, 'insufficient_data');
        assert.strictEqual(result.agents.status, 'unavailable');
        assert.deepStrictEqual(result.agents.items, []);
    });

    it('uses scoped saved deals, actual contacts and explicit score factors', async () => {
        const { a, b } = await setup();
        await DB.getOrCreateClient(a.id, 'same@lid', 'A client');
        await DB.getOrCreateClient(b.id, 'same@lid', 'B client');
        const aDeal = Deals.create(a.id, { title: 'A deal', clientChatId: 'same@lid',
            amount: 1234.56, currency: 'EUR', stage: 'negotiation', nextAction: 'Call client', nextActionAt: '2026-09-20' });
        Deals.create(b.id, { title: 'Secret B deal', clientChatId: 'same@lid', amount: 99999,
            stage: 'proposal', nextAction: 'B action', nextActionAt: '2026-09-19' });
        DB.run("INSERT INTO messages(instanceId,chatId,senderName,role,content,timestamp) VALUES (?,?,?,?,?,?)",
            [a.id, 'same@lid', 'A client', 'user', 'Hello', '2026-09-16 10:00:00']);
        DB.run("INSERT INTO messages(instanceId,chatId,senderName,role,content,timestamp) VALUES (?,?,?,?,?,?)",
            [b.id, 'same@lid', 'B client', 'user', 'Secret', '2026-09-24 10:00:00']);
        const result = Intelligence.getIntelligence(a.id, { now: NOW });
        assert.strictEqual(result.deals.items.length, 1);
        const deal = result.deals.items[0];
        assert.strictEqual(deal.id, aDeal.id);
        assert.strictEqual(deal.amount, 1234.56);
        assert.strictEqual(deal.currency, 'EUR');
        assert.strictEqual(deal.stage, 'negotiation');
        assert.strictEqual(deal.lastContactAt, '2026-09-16 10:00:00');
        assert.strictEqual(deal.nextAction, 'Call client');
        assert.deepStrictEqual(deal.riskReasons.map(item => item.code),
            ['action_overdue', 'contact_stale_7d', 'negotiation_stalled']);
        assert.strictEqual(result.priorities[0].score,
            result.priorities[0].scoreFactors.reduce((sum, item) => sum + item.points, 0));
        assert.strictEqual(result.dayPlan.items[0].id, aDeal.id);
        assert.ok(deal.target.path.includes(encodeURIComponent(aDeal.id)));
        assert.ok(!JSON.stringify(result).includes('Secret B deal'));
    });

    it('shows only saved due tasks and handles idempotent scoped completion', async () => {
        const { a, b } = await setup();
        DB.createManagerTask({ instanceId: a.id, taskId: 'due-a', summary: 'Call A', priority: 'urgent',
            metadata: { dueAt: '2026-09-24' } });
        DB.createManagerTask({ instanceId: a.id, taskId: 'undated-a', summary: 'Later A' });
        DB.createManagerTask({ instanceId: b.id, taskId: 'due-b', summary: 'Secret B', priority: 'urgent',
            metadata: { dueAt: '2026-09-24' } });
        const result = Intelligence.getIntelligence(a.id, { now: NOW });
        assert.deepStrictEqual(result.dayPlan.items.map(item => item.id), ['due-a']);
        assert.strictEqual(result.dayPlan.unscheduledCount, 1);
        assert.strictEqual(result.priorities[0].id, 'due-a');
        assert.strictEqual(result.priorities[0].score, 55);
        assert.ok(!JSON.stringify(result).includes('Secret B'));
        assert.strictEqual(Intelligence.updateTask(a.id, 'due-a', 'done').idempotent, false);
        assert.strictEqual(Intelligence.updateTask(a.id, 'due-a', 'done').idempotent, true);
        assert.strictEqual(DB.getManagerTask(a.id, 'due-a').status, 'done');
        assert.throws(() => Intelligence.updateTask(a.id, 'due-b', 'done'), /task_not_found/);
    });

    it('requires recent, evidence-backed profiles and a five-client sample for sentiment', async () => {
        const { a } = await setup();
        for (let n = 0; n < 5; n++) {
            const chat = `guest-${n}@lid`;
            await DB.getOrCreateClient(a.id, chat, `Guest ${n}`);
            for (let message = 0; message < 3; message++) {
                DB.run('INSERT INTO messages(instanceId,chatId,senderName,role,content,timestamp) VALUES (?,?,?,?,?,?)',
                    [a.id, chat, 'Guest', 'user', 'Hello', '2026-09-23 10:00:00']);
            }
            DB.run('INSERT INTO client_profiles(instanceId,chatId,sentimentScore,rawProfileJson,lastProfileUpdate) VALUES (?,?,?,?,?)',
                [a.id, chat, n === 0 ? 0.2 : 0.8, JSON.stringify({ sentimentScore: n === 0 ? 0.2 : 0.8 }), '2026-09-23 11:00:00']);
        }
        assert.deepStrictEqual(
            [Intelligence.getIntelligence(a.id, { now: NOW }).sentiment.negative,
                Intelligence.getIntelligence(a.id, { now: NOW }).sentiment.positive], [1, 4]);
        DB.run("UPDATE client_profiles SET lastProfileUpdate='2026-07-01 00:00:00' WHERE chatId='guest-0@lid'");
        const stale = Intelligence.getIntelligence(a.id, { now: NOW }).sentiment;
        assert.strictEqual(stale.status, 'insufficient_data');
        assert.strictEqual(stale.sampleSize, 4);
    });

    it('marks missing optional deal and task sources unavailable without fabricated values', async () => {
        const { a } = await setup();
        DB.db.exec('DROP TABLE customer_deals');
        DB.db.exec('DROP TABLE manager_tasks');
        const result = Intelligence.getIntelligence(a.id, { now: NOW });
        assert.strictEqual(result.deals.status, 'unavailable');
        assert.deepStrictEqual(result.deals.items, []);
        assert.strictEqual(result.dayPlan.status, 'unavailable');
        assert.deepStrictEqual(result.priorities, []);
        assert.strictEqual(result.agents.status, 'unavailable');
    });

    it('enforces live business membership and same-origin task changes at the route', async () => {
        const { a, b } = await setup();
        const user = seedUser('dashboard-owner@example.test', a.id);
        DB.createManagerTask({ instanceId: a.id, taskId: 'safe-a', summary: 'Call A' });
        const app = express();
        app.use(express.json());
        app.use('/api', (req, _res, next) => { req.auth = user; next(); });
        app.use('/api', routes);
        const server = await new Promise(resolve => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        const origin = `http://127.0.0.1:${server.address().port}`;
        const previous = process.env.WHATSAPP_CRM_PUBLIC_URL;
        process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
        try {
            const own = await fetch(`${origin}/api/dashboard/${a.id}/intelligence`);
            assert.strictEqual(own.status, 200);
            const foreign = await fetch(`${origin}/api/dashboard/${b.id}/intelligence`);
            assert.strictEqual(foreign.status, 403);
            const blocked = await fetch(`${origin}/api/dashboard/${a.id}/tasks/safe-a`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }),
            });
            assert.strictEqual(blocked.status, 403);
            const changed = await fetch(`${origin}/api/dashboard/${a.id}/tasks/safe-a`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ status: 'done' }),
            });
            assert.strictEqual(changed.status, 200);
            assert.strictEqual((await changed.json()).task.status, 'done');
            DB.run('UPDATE ava_business_memberships SET enabled=0 WHERE userId=? AND businessId=?', [user.userId, a.id]);
            const revoked = await fetch(`${origin}/api/dashboard/${a.id}/intelligence`);
            assert.strictEqual(revoked.status, 403);
        } finally {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            if (previous === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
            else process.env.WHATSAPP_CRM_PUBLIC_URL = previous;
        }
    });
});
