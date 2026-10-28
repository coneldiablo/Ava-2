const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Deals = require('../src/services/customer-deals.store');
const routes = require('../src/routes/customer-deals.routes');
const express = require('express');

function setup() {
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Hotel A'),(2,'Hotel B')");
    DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES (1,'same@lid','Guest A'),(2,'same@lid','Guest B')");
    const invite = Identity.createInvitation({ platformRole: 'platform_admin' },
        { email: 'deals-owner@example.test', businessId: 1, role: 'hotel_owner' });
    const owner = Identity.completeInvitation(Identity.claimInvitation(invite.token), 'deals-owner-subject');
    const managerInvite = Identity.createInvitation({ platformRole: 'platform_admin' },
        { email: 'deals-manager@example.test', businessId: 1, role: 'manager' });
    const manager = Identity.completeInvitation(Identity.claimInvitation(managerInvite.token), 'deals-manager-subject');
    return { owner, manager };
}

function request(auth, method, path, body, origin = 'https://ava.example.test') {
    const pieces = path.split('/').filter(Boolean);
    const req = { auth, method, protocol: 'https',
        params: { instanceId: pieces[1], dealId: pieces[2] },
        body: body || {}, query: {},
        get(name) { return ({ origin, host: 'ava.example.test' })[name.toLowerCase()]; },
    };
    let status = 200, data = null, passed = false;
    const res = { status(value) { status = value; return this; }, json(value) { data = value; return this; } };
    routes.stack[0].handle(req, res, () => { passed = true; });
    if (passed) {
        const route = routes.stack.find(layer => layer.route
            && layer.route.path === (pieces.length === 2 ? '/deals/:instanceId' : '/deals/:instanceId/:dealId')
            && layer.route.methods[method.toLowerCase()]);
        route.route.stack[0].handle(req, res);
    }
    return { status, data };
}

describe('Customer deals tenant-scoped storage and API', () => {
    it('serves scoped deals through actual Express routing and rejects another hotel', async () => {
        const { owner } = setup();
        const app = express();
        app.use(express.json());
        app.use('/api', (req, _res, next) => { req.auth = owner; next(); });
        app.use('/api', routes);
        app.use('/api', require('../src/routes/api.routes'));
        const server = await new Promise(resolve => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        const origin = `http://127.0.0.1:${server.address().port}`;
        const previous = process.env.WHATSAPP_CRM_PUBLIC_URL;
        process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
        try {
            const created = await fetch(`${origin}/api/deals/1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
                body: JSON.stringify({ title: 'Семейная поездка', amount: 12000 }),
            });
            assert.strictEqual(created.status, 201);
            const body = await created.json();
            assert.strictEqual(body.deal.instanceId, 1);
            const own = await fetch(`${origin}/api/deals/1`);
            assert.strictEqual((await own.json()).deals.length, 1);
            const exact = await fetch(`${origin}/api/deals/1/${body.deal.id}`);
            assert.strictEqual(exact.status, 200);
            assert.strictEqual((await exact.json()).deal.id, body.deal.id);
            assert.strictEqual((await fetch(`${origin}/api/deals/1/missing`)).status, 404);
            const foreign = await fetch(`${origin}/api/deals/2`);
            assert.strictEqual(foreign.status, 403);
            assert.strictEqual((await fetch(`${origin}/api/deals/2/${body.deal.id}`)).status, 403);
            const ownClients = await fetch(`${origin}/api/clients/1`);
            assert.strictEqual(ownClients.status, 200);
            assert.deepStrictEqual((await ownClients.json()).clients.map(client => client.senderName), ['Guest A']);
            const foreignClients = await fetch(`${origin}/api/clients/2`);
            assert.strictEqual(foreignClients.status, 403);
        } finally {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            if (previous === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
            else process.env.WHATSAPP_CRM_PUBLIC_URL = previous;
        }
    });
    it('creates, reads, updates and deletes real deals only for the selected business', () => {
        const { owner } = setup();
        const previous = process.env.WHATSAPP_CRM_PUBLIC_URL;
        process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
        try {
            const created = request(owner, 'POST', '/deals/1', {
                title: 'Заявка на свадьбу', clientChatId: 'same@lid', amount: 122500.75,
                currency: 'RUB', ownerName: 'Менеджер', nextAction: 'Уточнить даты',
                nextActionAt: '2026-10-10', stage: 'qualified',
            });
            assert.strictEqual(created.status, 201);
            assert.strictEqual(created.data.deal.amount, 122500.75);
            assert.strictEqual(created.data.deal.instanceId, 1);
            const id = created.data.deal.id;
            const listed = request(owner, 'GET', '/deals/1');
            assert.strictEqual(listed.data.deals.length, 1);
            assert.strictEqual(listed.data.totals[0].amountMinor, 12250075);
            assert.strictEqual(request(owner, 'GET', '/deals/2').status, 403);
            assert.strictEqual(request(owner, 'PUT', `/deals/2/${id}`, { title: 'Steal', revision: 1 }).status, 403);
            const updated = request(owner, 'PUT', `/deals/1/${id}`, { stage: 'won', revision: 1 });
            assert.strictEqual(updated.status, 200);
            assert.strictEqual(updated.data.deal.revision, 2);
            assert.strictEqual(request(owner, 'PUT', `/deals/1/${id}`, { stage: 'lost', revision: 1 }).status, 409);
            assert.strictEqual(request(owner, 'DELETE', `/deals/1/${id}`, { revision: 2 }).status, 200);
            assert.strictEqual(request(owner, 'GET', '/deals/1').data.deals.length, 0);
        } finally {
            if (previous === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
            else process.env.WHATSAPP_CRM_PUBLIC_URL = previous;
        }
    });

    it('rejects foreign clients, forged scope and cross-site writes while allowing scoped manager work', () => {
        const { owner, manager } = setup();
        const previous = process.env.WHATSAPP_CRM_PUBLIC_URL;
        process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
        try {
            assert.strictEqual(request(owner, 'POST', '/deals/1', { title: 'No', clientChatId: 'other@lid' }).status, 404);
            assert.strictEqual(request(owner, 'POST', '/deals/1', { title: 'No', instanceId: 2 }).status, 403);
            assert.strictEqual(request(owner, 'POST', '/deals/1', { title: 'No' }, 'https://evil.example').status, 403);
            assert.strictEqual(request(owner, 'POST', '/deals/1', { title: 'No', amount: -3 }).status, 400);
            assert.strictEqual(request(owner, 'POST', '/deals/1', { title: 'No', stage: 'forged' }).status, 400);
            assert.strictEqual(request(manager, 'GET', '/deals/1').status, 200);
            assert.strictEqual(request(manager, 'POST', '/deals/1', { title: 'Manager deal' }).status, 201);
            assert.strictEqual(request(manager, 'POST', '/deals/2', { title: 'Foreign deal' }).status, 403);
            assert.strictEqual(request({ login: 'legacy-signed-admin' }, 'GET', '/deals/1').status, 200);
            assert.strictEqual(request(null, 'GET', '/deals/1').status, 403);
        } finally {
            if (previous === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
            else process.env.WHATSAPP_CRM_PUBLIC_URL = previous;
        }
    });

    it('separates the same phone in two businesses and refuses a cross-business client link', () => {
        setup();
        const one = Deals.create(1, { title: 'First', clientChatId: 'same@lid', amount: 100 });
        const two = Deals.create(2, { title: 'Second', clientChatId: 'same@lid', amount: 200 });
        assert.deepStrictEqual(Deals.list(1).deals.map(item => item.id), [one.id]);
        assert.deepStrictEqual(Deals.list(2).deals.map(item => item.id), [two.id]);
        assert.strictEqual(Deals.get(2, one.id), null);
        assert.throws(() => Deals.create(1, { title: 'Bad', clientChatId: 'missing@lid' }), /DEAL_CLIENT_NOT_FOUND/);
    });

    it('preserves a deal but unlinks its client when the lead is deleted', async () => {
        setup();
        const deal = Deals.create(1, { title: 'Retained sale', clientChatId: 'same@lid' });
        DB.run("INSERT INTO messages(instanceId,chatId,senderName,content) VALUES (1,'same@lid','Guest A','Hello')");
        await DB.deleteLead(1, 'same@lid');
        assert.strictEqual(DB.get("SELECT id FROM clients WHERE instanceId=1 AND chatId='same@lid'"), undefined);
        assert.strictEqual(DB.get("SELECT id FROM messages WHERE instanceId=1 AND chatId='same@lid'"), undefined);
        assert.strictEqual(Deals.get(1, deal.id).clientChatId, null);
        assert.strictEqual(Deals.get(1, deal.id).revision, 2);
        assert.strictEqual(DB.get("SELECT id FROM clients WHERE instanceId=2 AND chatId='same@lid'").id > 0, true);
    });

    it('rolls back lead history and deal unlinking if client deletion fails', async () => {
        setup();
        const deal = Deals.create(1, { title: 'Still linked', clientChatId: 'same@lid' });
        DB.run("INSERT INTO messages(instanceId,chatId,senderName,content) VALUES (1,'same@lid','Guest A','Keep')");
        DB.db.exec(`CREATE TRIGGER fail_client_delete BEFORE DELETE ON clients
            WHEN OLD.instanceId=1 BEGIN SELECT RAISE(ABORT, 'simulated delete failure'); END`);
        await assert.rejects(DB.deleteLead(1, 'same@lid'), /simulated delete failure/);
        assert.strictEqual(DB.get("SELECT content FROM messages WHERE instanceId=1 AND chatId='same@lid'").content, 'Keep');
        assert.strictEqual(DB.get("SELECT id FROM clients WHERE instanceId=1 AND chatId='same@lid'").id > 0, true);
        assert.strictEqual(Deals.get(1, deal.id).clientChatId, 'same@lid');
        assert.strictEqual(Deals.get(1, deal.id).revision, 1);
    });

    it('deletes scoped deals before their business and leaves another business intact', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'Hotel A'),(2,'Hotel B')");
        DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES (1,'same@lid','Guest A'),(2,'same@lid','Guest B')");
        const first = Deals.create(1, { title: 'First', clientChatId: 'same@lid' });
        const second = Deals.create(2, { title: 'Second', clientChatId: 'same@lid' });
        await DB.deleteInstance(1);
        assert.strictEqual(DB.get('SELECT id FROM instances WHERE id=1'), undefined);
        assert.strictEqual(Deals.get(1, first.id), null);
        assert.strictEqual(Deals.get(2, second.id).clientChatId, 'same@lid');
    });

    it('rolls back business deals and clients if business deletion fails', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'Hotel A')");
        DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES (1,'guest@lid','Guest')");
        const deal = Deals.create(1, { title: 'Keep', clientChatId: 'guest@lid' });
        DB.db.exec(`CREATE TRIGGER fail_instance_delete BEFORE DELETE ON instances
            WHEN OLD.id=1 BEGIN SELECT RAISE(ABORT, 'simulated business delete failure'); END`);
        await assert.rejects(DB.deleteInstance(1), /simulated business delete failure/);
        assert.ok(DB.get('SELECT id FROM instances WHERE id=1'));
        assert.ok(DB.get("SELECT id FROM clients WHERE instanceId=1 AND chatId='guest@lid'"));
        assert.strictEqual(Deals.get(1, deal.id).clientChatId, 'guest@lid');
    });
});
