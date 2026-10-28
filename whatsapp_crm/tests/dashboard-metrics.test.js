'use strict';

const { describe, it, assert, createTestDB, runAll } = require('./test-helper');
const express = require('express');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Deals = require('../src/services/customer-deals.store');
const Metrics = require('../src/services/dashboard/metrics');
const routes = require('../src/routes/dashboard-metrics.routes');

function setup() {
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name,hotelTimezone) VALUES (1,'Hotel A','Europe/Moscow'),(2,'Hotel B','UTC')");
    const invitation = Identity.createInvitation({ platformRole: 'platform_admin' },
        { email: 'dashboard-owner@example.test', businessId: 1, role: 'hotel_owner' });
    return Identity.completeInvitation(Identity.claimInvitation(invitation.token), 'dashboard-owner-subject');
}

async function withServer(auth, callback) {
    const app = express();
    app.use('/api', (req, _res, next) => { req.auth = auth; next(); });
    app.use('/api', routes);
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try { await callback(`http://127.0.0.1:${server.address().port}`); }
    finally { await new Promise(resolve => server.close(resolve)); }
}

describe('Dashboard tenant metrics', () => {
    it('keeps older open deals in the additive current funnel without changing period counts', () => {
        setup(); Metrics.ensureSchema();
        DB.run(`INSERT INTO customer_deals(id,instanceId,title,amountMinor,currency,stage,createdAt) VALUES
            ('old-open',1,'Old open',125050,'RUB','qualified','2025-01-01 08:00:00'),
            ('recent-open',1,'Recent open',5500,'USD','proposal','2026-09-24 08:00:00'),
            ('old-won',1,'Old won',99999,'RUB','won','2025-01-01 08:00:00'),
            ('old-lost',1,'Old lost',99999,'RUB','lost','2025-01-01 08:00:00'),
            ('foreign-open',2,'Foreign',999999,'RUB','new','2025-01-01 08:00:00')`);
        for (const days of [7,30,90]) {
            const result=Metrics.getMetrics(1,days,'2026-09-24T12:00:00Z');
            assert.strictEqual(result.kpis.deals.created,1);
            assert.strictEqual(result.kpis.deals.open,1);
            assert.strictEqual(result.dealFunnel.find(item=>item.stage==='qualified').count,0);
            assert.deepStrictEqual(result.currentFunnel,{status:'available',scope:'all_open',totalOpen:2,items:[
                {stage:'new',count:0,amounts:[]},
                {stage:'qualified',count:1,amounts:[{currency:'RUB',amountMinor:125050}]},
                {stage:'proposal',count:1,amounts:[{currency:'USD',amountMinor:5500}]},
                {stage:'negotiation',count:0,amounts:[]},
            ]});
        }
    });

    it('does not manufacture deals from callers and distinguishes an unavailable current snapshot from zero', () => {
        setup();
        DB.run("INSERT INTO clients(instanceId,chatId,senderName,createdAt,leadStatus) VALUES (1,'caller','Caller','2026-09-24 08:00:00','qualified')");
        const empty=Metrics.getMetrics(1,7,'2026-09-24T12:00:00Z');
        assert.strictEqual(empty.kpis.leads.total,1);
        assert.strictEqual(empty.currentFunnel.status,'available');
        assert.strictEqual(empty.currentFunnel.totalOpen,0);
        assert.ok(empty.currentFunnel.items.every(item=>item.count===0));
        const all=DB.all.bind(DB);
        DB.all=(sql,params)=>{
            if(sql.includes("stage IN ('new','qualified','proposal','negotiation')"))throw new Error('isolated source failure');
            return all(sql,params);
        };
        try {
            const result=Metrics.getMetrics(1,7,'2026-09-24T12:00:00Z');
            assert.strictEqual(result.success,true);
            assert.strictEqual(result.kpis.leads.total,1);
            assert.deepStrictEqual(result.currentFunnel,{status:'unavailable',scope:'all_open',totalOpen:null,items:[]});
        } finally { DB.all=all; }
    });

    it('returns explicit zero bins and distinct deal stages for an empty business', () => {
        setup();
        const result = Metrics.getMetrics(1, 7, '2026-09-24T12:00:00Z');
        assert.strictEqual(result.business_id, 1);
        assert.strictEqual(result.period.timezone, 'Europe/Moscow');
        assert.strictEqual(result.period.start, '2026-09-17T21:00:00.000Z');
        assert.strictEqual(result.period.endExclusive, '2026-09-24T21:00:00.000Z');
        assert.deepStrictEqual(result.kpis.leads, { created: 0, total: 0, active: 0 });
        assert.deepStrictEqual(result.kpis.messages, { inbound: 0, outbound: 0, total: 0 });
        assert.deepStrictEqual(result.kpis.deals, { created: 0, open: 0, won: 0, lost: 0,
            openAmounts: [], wonAmounts: [] });
        assert.strictEqual(result.series.leads.length, 7);
        assert.strictEqual(result.series.closedDeals.length, 7);
        assert.ok(result.series.leads.every(day => day.count === 0));
        assert.deepStrictEqual(result.dealFunnel.map(row => row.stage),
            ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost']);
        assert.ok(result.dealFunnel.every(row => row.count === 0));
        assert.strictEqual(result.sources.closedDeals.status, 'partial');
        assert.strictEqual(result.sources.ai.status, 'partial');
    });

    it('bins UTC timestamps by business local day, including a DST transition', () => {
        setup();
        DB.run(`INSERT INTO clients(instanceId,chatId,senderName,createdAt,leadStatus) VALUES
            (1,'before','A','2026-09-23 20:59:59','new'),
            (1,'after','B','2026-09-23 21:00:00','qualified'),
            (2,'foreign','C','2026-09-23 21:00:00','new')`);
        const result = Metrics.getMetrics(1, 7, '2026-09-24T12:00:00Z');
        assert.strictEqual(result.series.leads.find(day => day.date === '2026-09-23').count, 1);
        assert.strictEqual(result.series.leads.find(day => day.date === '2026-09-24').count, 1);
        assert.strictEqual(result.kpis.leads.created, 2);
        const dst = Metrics.period(7, 'America/New_York', '2026-03-08T12:00:00Z');
        assert.strictEqual(dst.endExclusive, '2026-03-09T04:00:00.000Z');
        assert.strictEqual(dst.start, '2026-03-02T05:00:00.000Z');
        assert.strictEqual(Metrics.period(30, 'UTC', '2026-09-24T12:00:00Z').dates.length, 30);
        assert.strictEqual(Metrics.period(90, 'UTC', '2026-09-24T12:00:00Z').dates.length, 90);
    });

    it('keeps currency amounts separate and counts audited won transitions only', () => {
        setup();
        Metrics.ensureSchema();
        DB.run(`INSERT INTO customer_deals(id,instanceId,title,amountMinor,currency,stage,createdAt)
            VALUES ('rub',1,'RUB deal',125050,'RUB','qualified','2026-09-24 08:00:00'),
                   ('usd',1,'USD deal',9900,'USD','new','2026-09-24 08:00:00'),
                   ('usd-won',1,'USD win',5500,'USD','qualified','2026-09-24 08:00:00'),
                   ('eur',1,'EUR deal',2200,'EUR','proposal','2026-09-24 08:00:00'),
                   ('foreign',2,'Foreign',999999,'RUB','qualified','2026-09-24 08:00:00')`);
        DB.run("UPDATE customer_deals SET stage='won' WHERE instanceId=1 AND id='rub'");
        DB.run("UPDATE customer_deals SET stage='new' WHERE instanceId=1 AND id='rub'");
        DB.run("UPDATE customer_deals SET stage='won' WHERE instanceId=1 AND id='rub'");
        DB.run("UPDATE customer_deals SET stage='won' WHERE instanceId=1 AND id='usd-won'");
        DB.run("UPDATE dashboard_deal_won_events SET occurredAt='2026-09-24 09:00:00' WHERE instanceId=1");
        DB.run(`INSERT INTO tool_runs(toolRunId,instanceId,toolName,status,createdAt) VALUES
            ('good',1,'create_task','ok','2026-09-24 10:00:00'),
            ('bad',1,'create_task','failed','2026-09-24 10:00:00'),
            ('foreign',2,'create_task','ok','2026-09-24 10:00:00')`);
        DB.run(`INSERT INTO messages(instanceId,chatId,senderName,role,timestamp) VALUES
            (1,'x','Client','user','2026-09-24 10:00:00'),
            (1,'x','Bot','assistant','2026-09-24 10:01:00'),
            (2,'x','Client','user','2026-09-24 10:00:00')`);
        const result = Metrics.getMetrics(1, 7, '2026-09-24T12:00:00Z');
        assert.deepStrictEqual(result.kpis.deals.openAmounts,
            [{ currency: 'EUR', amountMinor: 2200 }, { currency: 'USD', amountMinor: 9900 }]);
        assert.deepStrictEqual(result.kpis.deals.wonAmounts,
            [{ currency: 'RUB', amountMinor: 125050 }, { currency: 'USD', amountMinor: 5500 }]);
        assert.strictEqual(result.kpis.deals.won, 2);
        assert.strictEqual(result.dealFunnel.find(stage => stage.stage === 'won').count, 2);
        assert.deepStrictEqual(result.dealFunnel.find(stage => stage.stage === 'new').amounts,
            [{ currency: 'USD', amountMinor: 9900 }]);
        assert.strictEqual(result.series.closedDeals.find(day => day.date === '2026-09-24').count, 2);
        assert.deepStrictEqual(result.kpis.messages, { inbound: 1, outbound: 1, total: 2 });
        assert.deepStrictEqual(result.kpis.ai, { recordedSuccessfulToolRuns: 1, status: 'partial' });
    });

    it('does not invent close dates for deals won before tracking was installed', () => {
        setup();
        // Simulate a database created by the older deal module before this
        // migration installed the won-transition triggers.
        DB.db.exec(`CREATE TABLE customer_deals (
            id TEXT PRIMARY KEY,instanceId INTEGER,clientChatId TEXT,title TEXT,
            amountMinor INTEGER,currency TEXT,stage TEXT,createdAt TEXT,updatedAt TEXT
        )`);
        DB.run(`INSERT INTO customer_deals(id,instanceId,title,amountMinor,currency,stage,createdAt)
            VALUES ('legacy',1,'Old win',50000,'RUB','won','2026-09-24 08:00:00')`);
        const result = Metrics.getMetrics(1, 7, '2026-09-24T12:00:00Z');
        assert.strictEqual(result.dealFunnel.find(stage => stage.stage === 'won').count, 1);
        assert.strictEqual(result.kpis.deals.won, 0);
        assert.deepStrictEqual(result.kpis.deals.wonAmounts, []);
        assert.strictEqual(result.sources.closedDeals.status, 'partial');
    });

    it('audits store create/update in the deal transaction and rolls back failed closes', () => {
        setup();
        const initial = Deals.create(1, { title: 'Won at creation', amount: 25.5, stage: 'won' });
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM dashboard_deal_won_events WHERE instanceId=?', [1]).n, 1);
        const sameStage = Deals.update(1, initial.id, { stage: 'won', revision: initial.revision });
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM dashboard_deal_won_events WHERE instanceId=?', [1]).n, 1);
        const reopened = Deals.update(1, initial.id, { stage: 'proposal', revision: sameStage.revision });
        Deals.update(1, initial.id, { stage: 'won', revision: reopened.revision });
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM dashboard_deal_won_events WHERE instanceId=?', [1]).n, 2);
        const open = Deals.create(1, { title: 'Open', amount: 10, stage: 'qualified' });
        assert.throws(() => DB.db.transaction(() => {
            DB.run("UPDATE customer_deals SET stage='won' WHERE instanceId=? AND id=?", [1, open.id]);
            throw new Error('simulated failure');
        }).immediate(), /simulated failure/);
        assert.strictEqual(Deals.get(1, open.id).stage, 'qualified');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM dashboard_deal_won_events WHERE instanceId=?', [1]).n, 2);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM dashboard_deal_won_events WHERE instanceId=?', [2]).n, 0);
    });

    it('rejects foreign, inactive, unauthenticated and malformed requests before exposing data', async () => {
        const owner = setup();
        await withServer(owner, async base => {
            const own = await fetch(`${base}/api/dashboard/1/metrics?days=7`);
            assert.strictEqual(own.status, 200);
            const foreign = await fetch(`${base}/api/dashboard/2/metrics?days=7`);
            assert.strictEqual(foreign.status, 403);
            assert.strictEqual((await foreign.json()).code, 'DASHBOARD_ACCESS_DENIED');
            const forged = await fetch(`${base}/api/dashboard/1/metrics?business_id=2`);
            assert.strictEqual(forged.status, 403);
            const days = await fetch(`${base}/api/dashboard/1/metrics?days=8`);
            assert.strictEqual(days.status, 400);
            const invalid = await fetch(`${base}/api/dashboard/no/metrics`);
            assert.strictEqual(invalid.status, 400);
            DB.run('UPDATE instances SET isActive=0 WHERE id=1');
            const inactive = await fetch(`${base}/api/dashboard/1/metrics`);
            assert.strictEqual(inactive.status, 403); // revoked live membership
        });
        await withServer(null, async base => {
            const response = await fetch(`${base}/api/dashboard/1/metrics`);
            assert.strictEqual(response.status, 403);
        });
        await withServer({ platformRole: 'platform_admin', userId: 'platform-admin' }, async base => {
            const missing = await fetch(`${base}/api/dashboard/999/metrics`);
            assert.strictEqual(missing.status, 404);
            const inactive = await fetch(`${base}/api/dashboard/1/metrics`);
            assert.strictEqual(inactive.status, 404);
        });
    });

    it('returns a safe unavailable response when a metrics source fails', async () => {
        const owner = setup();
        DB.db.exec('DROP TABLE tool_runs');
        await withServer(owner, async base => {
            const response = await fetch(`${base}/api/dashboard/1/metrics`);
            assert.strictEqual(response.status, 503);
            assert.deepStrictEqual(await response.json(),
                { success: false, code: 'DASHBOARD_METRICS_UNAVAILABLE' });
        });
    });
});

if (require.main === module) {
    runAll().then(ok => { if (!ok) process.exitCode = 1; });
}
