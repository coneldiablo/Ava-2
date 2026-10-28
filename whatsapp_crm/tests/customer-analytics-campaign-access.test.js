const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Access = require('../src/services/identity/customer-access');

function fixture(role = 'hotel_owner') {
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Own business'),(2,'Foreign business')");
    const invite = Identity.createInvitation({ platformRole: 'platform_admin' },
        { email: 'analytics@example.test', businessId: 1, role });
    return Identity.completeInvitation(Identity.claimInvitation(invite.token), 'analytics-subject');
}

function check(actor, method, path, params, body = {}, query = {}, headers = {}) {
    let passed = false, status = 200, code;
    const previous = process.env.WHATSAPP_CRM_PUBLIC_URL;
    if (!previous) process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
    const req = { auth: actor, params, body, query,
        headers: { origin: new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin, ...headers } };
    try {
        Access.forRoute(method, path)(req, {
            status(value) { status = value; return this; },
            json(payload) { code = payload.code; },
        }, () => { passed = true; });
    } finally {
        if (!previous) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
    }
    return { passed, status, code, body: req.body };
}

async function getLeadsOverTime(actor, instanceId, days = 2) {
    const Auth = require('../src/services/auth.service');
    const app = require('../src/app').app;
    const oldEnabled = Auth.config.enabled, oldCustomer = process.env.AVA_CUSTOMER_ACCESS_ENABLED;
    Auth.config.enabled = true; process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
    const token = Identity.createSession(actor.subject, 'analytics-daily');
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/analytics/leads-over-time/${instanceId}?days=${days}`,
            { headers: { Cookie: `crm_session=ava2:${token}` } });
        return { status: response.status, body: await response.json() };
    } finally {
        Auth.config.enabled = oldEnabled;
        if (oldCustomer === undefined) delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        else process.env.AVA_CUSTOMER_ACCESS_ENABLED = oldCustomer;
        await new Promise(resolve => server.close(resolve));
    }
}

describe('Customer analytics and outbound campaign authorization', () => {
    it('counts each standard lead only on its first booked transition and isolates same chat IDs', async () => {
        const owner = fixture('hotel_owner');
        DB.run(`INSERT INTO clients(instanceId,chatId,senderName,createdAt) VALUES
            (1,'shared','Own',datetime('now','-1 day')),
            (1,'old','Old',datetime('now','-4 days')),
            (2,'shared','Foreign',datetime('now','-1 day')),
            (2,'foreign-only','Foreign only',datetime('now'))`);
        DB.run(`INSERT INTO lead_status_history(instanceId,chatId,fromStatus,toStatus,createdAt) VALUES
            (1,'shared','offer','booked',datetime('now','-1 day')),
            (1,'shared','booked','booked',datetime('now')),
            (1,'shared','offer','booked',datetime('now')),
            (1,'old','offer','booked',datetime('now','-4 days')),
            (1,'old','offer','booked',datetime('now')),
            (2,'shared','offer','booked',datetime('now')),
            (2,'foreign-only','offer','booked',datetime('now'))`);
        const { status, body } = await getLeadsOverTime(owner, 1);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.success, true);
        assert.deepStrictEqual(body.data.map(row => row.date),
            DB.all("SELECT date('now','-1 day') AS date UNION ALL SELECT date('now')").map(row => row.date));
        assert.deepStrictEqual(body.data.map(({ count, successTransitions }) => [count, successTransitions]),
            [[1, 1], [0, 0]]);
        assert.strictEqual((await getLeadsOverTime(owner, 2)).status, 403);
    });

    it('counts the first coffee pickup success across both accepted statuses on its event day', async () => {
        const owner = fixture('hotel_owner');
        DB.run("UPDATE instances SET businessType = 'coffee_shop', salesGoal = 'coffee_pickup' WHERE id = 1");
        DB.run(`INSERT INTO clients(instanceId,chatId,senderName,createdAt) VALUES
            (1,'pickup','Pickup',datetime('now','-4 days')),
            (1,'ready','Ready',datetime('now','-4 days')),
            (1,'booked-only','Booked',datetime('now','-4 days')),
            (1,'old-success','Old',datetime('now','-4 days'))`);
        DB.run(`INSERT INTO lead_status_history(instanceId,chatId,fromStatus,toStatus,createdAt) VALUES
            (1,'pickup','offer','pickup_confirmed',datetime('now','-1 day')),
            (1,'pickup','pickup_confirmed','ready_for_pickup',datetime('now')),
            (1,'ready','offer','ready_for_pickup',datetime('now')),
            (1,'booked-only','offer','booked',datetime('now')),
            (1,'old-success','offer','pickup_confirmed',datetime('now','-3 days')),
            (1,'old-success','offer','ready_for_pickup',datetime('now'))`);
        const { status, body } = await getLeadsOverTime(owner, 1);
        assert.strictEqual(status, 200);
        assert.deepStrictEqual(body.data.map(({ count, successTransitions }) => [count, successTransitions]),
            [[0, 1], [0, 1]]);
    });

    const readPaths = [
        '/stats/:instanceId', '/analytics/funnel/:instanceId', '/analytics/avg-time/:instanceId',
        '/analytics/export/:instanceId', '/analytics/activity-heatmap/:instanceId',
        '/analytics/messages-over-time/:instanceId', '/analytics/channel-breakdown/:instanceId',
        '/analytics/response-times/:instanceId', '/analytics/smart-summary/:instanceId',
        '/analytics/leads-over-time/:instanceId', '/analytics/forecast/:instanceId',
        '/knowledge-base/:instanceId/stats', '/knowledge-base/:instanceId/analytics',
        '/barista/stats/:instanceId', '/coffee/:instanceId/orders/analytics',
        '/coffee/:instanceId/items/analytics',
    ];

    it('allows only explicit statistics and knowledge search for members of the selected business', () => {
        for (const role of ['hotel_owner', 'manager']) {
            const actor = fixture(role);
            for (const path of readPaths) {
                assert.ok(check(actor, 'get', path, { instanceId: '1' }).passed, `${role} ${path}`);
                assert.strictEqual(check(actor, 'get', path, { instanceId: '2' }).status, 403, path);
                assert.strictEqual(check(actor, 'get', path, { instanceId: '1' }, {}, { businessId: 2 }).status, 403, path);
            }
            const searchPath = '/knowledge-base/:instanceId/search';
            assert.deepStrictEqual(check(actor, 'post', searchPath, { instanceId: '1' },
                { query: 'room', k: 3, modelId: undefined, extra: 'ignored' }).body, { query: 'room', k: 3 });
            assert.strictEqual(check(actor, 'post', searchPath, { instanceId: '2' }, { query: 'room' }).status, 403);
            assert.strictEqual(check(actor, 'post', searchPath, { instanceId: '1' }, { query: 'room', clientId: 'foreign' }).status, 403);
            assert.strictEqual(check(actor, 'get', '/analytics/not-reviewed/:instanceId', { instanceId: '1' }).status, 403);
            assert.strictEqual(check(actor, 'post', '/knowledge-base/:instanceId/rebuild-embeddings', { instanceId: '1' }).status, 403);
        }
    });

    it('checks the persisted campaign tenant before every read and owner mutation', () => {
        const owner = fixture('hotel_owner');
        DB.createOutboundCampaign({ campaignId: 'own', instanceId: 1, name: 'Own' });
        DB.createOutboundCampaign({ campaignId: 'foreign', instanceId: 2, name: 'Foreign' });
        const routes = [
            ['get', '/sales-brain/outbound/campaigns/:campaignId/leads', false],
            ['patch', '/sales-brain/outbound/campaigns/:campaignId', true],
            ['post', '/sales-brain/outbound/campaigns/:campaignId/sync-leads', true],
            ['post', '/sales-brain/outbound/campaigns/:campaignId/deploy-to-ava', true],
            ['post', '/sales-brain/outbound/campaigns/:campaignId/ava-status', true],
        ];
        for (const [method, path] of routes) {
            assert.ok(check(owner, method, path, { campaignId: 'own' }).passed, path);
            assert.strictEqual(check(owner, method, path, { campaignId: 'foreign' }).status, 403, path);
            assert.strictEqual(check(owner, method, path, { campaignId: 'missing' }).status, 404, path);
            assert.strictEqual(check(owner, method, path, { campaignId: 'own' }, { instanceId: 2 }).status, 403, path);
            assert.strictEqual(check(owner, method, path, { campaignId: 'own' }, { campaign_id: 'foreign' }).status, 403, path);
        }
        assert.ok(check(owner, 'get', '/sales-brain/outbound/campaigns/:instanceId', { instanceId: '1' }).passed);
        assert.strictEqual(check(owner, 'get', '/sales-brain/outbound/campaigns/:instanceId', { instanceId: '2' }).status, 403);
        assert.strictEqual(check(owner, 'post', '/sales-brain/outbound/campaigns', {}, { name: 'No scope' }).status, 400);
        assert.strictEqual(check(owner, 'post', '/sales-brain/outbound/campaigns', {}, { instanceId: 2 }).status, 403);
        const create = check(owner, 'post', '/sales-brain/outbound/campaigns', {},
            { instanceId: 1, name: 'New', context_id: 'unified_sales_agent', ignored: 'drop' });
        assert.deepStrictEqual(create.body, { instanceId: 1, name: 'New', context_id: 'unified_sales_agent' });
        assert.strictEqual(check(owner, 'post', '/sales-brain/outbound/campaigns', {}, { instanceId: 1, context_id: 'foreign-context' }).status, 403);
        assert.strictEqual(check(owner, 'post', '/sales-brain/outbound/campaigns', {}, { instanceId: 1 }, {}, { origin: 'https://evil.example' }).status, 403);
        assert.strictEqual(check(owner, 'patch', '/sales-brain/outbound/campaigns/:campaignId', { campaignId: 'own' }, { contextId: 'foreign-context' }).status, 403);
        assert.strictEqual(check(owner, 'patch', '/sales-brain/outbound/campaigns/:campaignId', { campaignId: 'own' }, { clientId: 'foreign' }).status, 403);
        assert.deepStrictEqual(check(owner, 'post', '/sales-brain/outbound/campaigns/:campaignId/deploy-to-ava',
            { campaignId: 'own' }, { start: true, model: undefined, ignored: 'drop' }).body, { start: true });
        DB.run("INSERT INTO ava_users(id,email,platformRole) VALUES ('operator','operator@example.test','platform_admin')");
        const operator = Identity.actor('operator');
        assert.ok(check(operator, 'patch', '/sales-brain/outbound/campaigns/:campaignId', { campaignId: 'foreign' },
            { contextId: 'operator-context' }).passed);
    });

    it('managers can read campaigns but cannot create, edit, sync or launch them', () => {
        const manager = fixture('manager');
        DB.createOutboundCampaign({ campaignId: 'own', instanceId: 1, name: 'Own' });
        assert.ok(check(manager, 'get', '/sales-brain/outbound/campaigns/:instanceId', { instanceId: '1' }).passed);
        assert.ok(check(manager, 'get', '/sales-brain/outbound/campaigns/:campaignId/leads', { campaignId: 'own' }).passed);
        for (const [method, path, params] of [
            ['post', '/sales-brain/outbound/campaigns', {}],
            ['patch', '/sales-brain/outbound/campaigns/:campaignId', { campaignId: 'own' }],
            ['post', '/sales-brain/outbound/campaigns/:campaignId/sync-leads', { campaignId: 'own' }],
            ['post', '/sales-brain/outbound/campaigns/:campaignId/deploy-to-ava', { campaignId: 'own' }],
            ['post', '/sales-brain/outbound/campaigns/:campaignId/ava-status', { campaignId: 'own' }],
        ]) assert.strictEqual(check(manager, method, path, params, { instanceId: 1 }).status, 403, path);
    });

    it('accepts an actual same-origin browser request when the optional public URL is unset', () => {
        const owner = fixture('hotel_owner');
        const previous = process.env.WHATSAPP_CRM_PUBLIC_URL;
        delete process.env.WHATSAPP_CRM_PUBLIC_URL;
        const req = {
            auth: owner, params: {}, body: { instanceId: 1, name: 'Draft' }, query: {},
            protocol: 'https', headers: { origin: 'https://wh.example.test', 'sec-fetch-site': 'same-origin' },
            get(name) { return name === 'host' ? 'wh.example.test' : undefined; },
        };
        let passed = false;
        try {
            Access.forRoute('post', '/sales-brain/outbound/campaigns')(req, {
                status() { return this; }, json() {},
            }, () => { passed = true; });
        } finally {
            if (previous !== undefined) process.env.WHATSAPP_CRM_PUBLIC_URL = previous;
        }
        assert.ok(passed);
        assert.strictEqual(req.body.instanceId, 1);
    });

    it('smart-summary counts active sequences only for the requested business', async () => {
        const manager = fixture('manager');
        DB.run("INSERT INTO message_sequences(id,instanceId,name) VALUES (11,1,'Own'),(22,2,'Foreign')");
        DB.run("INSERT INTO client_sequences(instanceId,chatId,sequenceId,status) VALUES (1,'a',11,'active'),(2,'b',22,'active'),(2,'c',22,'active')");
        const Auth = require('../src/services/auth.service');
        const app = require('../src/app').app;
        const oldEnabled = Auth.config.enabled, oldCustomer = process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        Auth.config.enabled = true; process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
        const token = Identity.createSession(manager.subject, 'analytics-native');
        const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
        try {
            const base = `http://127.0.0.1:${server.address().port}`;
            const headers = { Cookie: `crm_session=ava2:${token}` };
            const own = await fetch(`${base}/api/analytics/smart-summary/1`, { headers });
            assert.strictEqual(own.status, 200);
            assert.strictEqual((await own.json()).summary.activeSequences, 1);
            const foreign = await fetch(`${base}/api/analytics/smart-summary/2`, { headers });
            assert.strictEqual(foreign.status, 403);
        } finally {
            Auth.config.enabled = oldEnabled;
            if (oldCustomer === undefined) delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;
            else process.env.AVA_CUSTOMER_ACCESS_ENABLED = oldCustomer;
            await new Promise(resolve => server.close(resolve));
        }
    });

    it('rejects foreign campaign launch before calling the outbound integration', async () => {
        const owner = fixture('hotel_owner');
        DB.createOutboundCampaign({ campaignId: 'own', instanceId: 1, name: 'Own' });
        DB.createOutboundCampaign({ campaignId: 'foreign', instanceId: 2, name: 'Foreign' });
        const Auth = require('../src/services/auth.service');
        const AvaOutbound = require('../src/services/ava-outbound.service');
        const app = require('../src/app').app;
        const oldEnabled = Auth.config.enabled, oldCustomer = process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        const oldOrigin = process.env.WHATSAPP_CRM_PUBLIC_URL;
        const originalSync = AvaOutbound.syncCampaign;
        Auth.config.enabled = true; process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
        const token = Identity.createSession(owner.subject, 'campaign-native');
        let integrations = 0;
        AvaOutbound.syncCampaign = async campaignId => {
            integrations++;
            assert.strictEqual(campaignId, 'own');
            return { accepted: 0 };
        };
        const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
        try {
            const base = `http://127.0.0.1:${server.address().port}`;
            process.env.WHATSAPP_CRM_PUBLIC_URL = base;
            const headers = { Cookie: `crm_session=ava2:${token}`, Origin: base, 'Content-Type': 'application/json' };
            const deploy = (id, body = {}) => fetch(`${base}/api/sales-brain/outbound/campaigns/${id}/deploy-to-ava`,
                { method: 'POST', headers, body: JSON.stringify(body) });
            assert.strictEqual((await deploy('foreign', { start: true })).status, 403);
            assert.strictEqual(integrations, 0);
            assert.strictEqual((await deploy('own', { start: false, clientId: 'foreign' })).status, 403);
            assert.strictEqual(integrations, 0);
            const allowed = await deploy('own', { start: false });
            assert.strictEqual(allowed.status, 200);
            assert.strictEqual(integrations, 1);
            const editForeign = await fetch(`${base}/api/sales-brain/outbound/campaigns/foreign`,
                { method: 'PATCH', headers, body: JSON.stringify({ name: 'Hijacked' }) });
            assert.strictEqual(editForeign.status, 403);
            assert.strictEqual(DB.getOutboundCampaign('foreign').name, 'Foreign');
        } finally {
            AvaOutbound.syncCampaign = originalSync;
            Auth.config.enabled = oldEnabled;
            if (oldCustomer === undefined) delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;
            else process.env.AVA_CUSTOMER_ACCESS_ENABLED = oldCustomer;
            if (oldOrigin === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
            else process.env.WHATSAPP_CRM_PUBLIC_URL = oldOrigin;
            await new Promise(resolve => server.close(resolve));
        }
    });
});
