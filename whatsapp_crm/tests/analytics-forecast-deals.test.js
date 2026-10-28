const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Deals = require('../src/services/customer-deals.store');
const routes = require('../src/routes/api.routes');

const forecastRoute = routes.stack.find(layer => layer.route?.path === '/analytics/forecast/:instanceId');
const forecastHandler = forecastRoute.route.stack.at(-1).handle;

async function forecast(instanceId) {
    let status = 200;
    let body;
    await forecastHandler({ params: { instanceId: String(instanceId) } }, {
        status(value) { status = value; return this; },
        json(value) { body = value; return this; }
    });
    return { status, body };
}

describe('Deal-derived analytics forecast', () => {
    it('does not turn profile budgets or pseudo probabilities into pipeline value', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'Own'),(2,'Foreign')");
        DB.run("INSERT INTO clients(instanceId,chatId,senderName,leadStatus) VALUES (1,'same','Own client','qualified'),(2,'same','Foreign client','qualified')");
        DB.run("INSERT INTO client_profiles(instanceId,chatId,budget,conversionProbability) VALUES (1,'same','99 999 USD',0.99)");
        const ownRub = Deals.create(1, { title: 'Own RUB', clientChatId: 'same', amount: 1250.50,
            currency: 'RUB', stage: 'proposal', nextActionAt: '2026-10-01' });
        Deals.create(1, { title: 'Own EUR', amount: 50, currency: 'EUR', stage: 'qualified' });
        Deals.create(1, { title: 'Won USD', amount: 70, currency: 'USD', stage: 'won' });
        Deals.create(1, { title: 'Lost RUB', amount: 999, currency: 'RUB', stage: 'lost' });
        Deals.create(1, { title: 'Lost-only KZT', amount: 3000, currency: 'KZT', stage: 'lost' });
        Deals.create(2, { title: 'Foreign RUB', clientChatId: 'same', amount: 100000, currency: 'RUB', stage: 'proposal' });
        DB.run("INSERT INTO payments(paymentId,instanceId,chatId,amount,status) VALUES ('paid-own',1,'same',23.75,'succeeded'),('pending-own',1,'same',500,'pending'),('paid-foreign',2,'same',1000,'succeeded')");

        const { status, body } = await forecast(1);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.forecast.source, 'customer_deals');
        assert.deepStrictEqual(body.forecast.amountsByCurrency, [
            { currency: 'EUR', openAmount: 50, wonAmount: 0, openDeals: 1, wonDeals: 0 },
            { currency: 'RUB', openAmount: 1250.50, wonAmount: 0, openDeals: 1, wonDeals: 0 },
            { currency: 'USD', openAmount: 0, wonAmount: 70, openDeals: 0, wonDeals: 1 }
        ]);
        assert.ok(!body.forecast.amountsByCurrency.some(row => row.currency === 'KZT'));
        assert.strictEqual(body.forecast.activeDeals, 2);
        assert.strictEqual(body.forecast.completedDeals, 1);
        assert.strictEqual(body.forecast.succeededPaymentsRUB, 23.75);
        assert.strictEqual(body.forecast.totalPipelineValue, null);
        assert.strictEqual(body.forecast.weightedPipelineValue, null);
        assert.strictEqual(body.forecast.totalRevenue, null);
        assert.strictEqual(body.forecast.conversionRate, null);
        assert.strictEqual(body.forecast.deals.length, 2);
        assert.deepStrictEqual(body.forecast.deals.find(deal => deal.id === ownRub.id), {
            id: ownRub.id, chatId: 'same', title: 'Own RUB', name: 'Own client',
            clientName: 'Own client', stage: 'proposal', status: 'proposal', amount: 1250.50,
            currency: 'RUB', nextActionAt: '2026-10-01'
        });

        const foreign = await forecast(2);
        assert.strictEqual(foreign.body.forecast.activeDeals, 1);
        assert.strictEqual(foreign.body.forecast.amountsByCurrency[0].openAmount, 100000);
        assert.strictEqual(foreign.body.forecast.succeededPaymentsRUB, 1000);
    });

    it('returns empty honest totals for a legacy database without deals', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'Legacy')");
        DB.run("INSERT INTO clients(instanceId,chatId,senderName,leadStatus) VALUES (1,'lead','Budget lead','offer')");
        DB.run("INSERT INTO client_profiles(instanceId,chatId,budget,conversionProbability) VALUES (1,'lead','500000',0.8)");
        const { status, body } = await forecast(1);
        assert.strictEqual(status, 200);
        assert.deepStrictEqual(body.forecast.amountsByCurrency, []);
        assert.deepStrictEqual(body.forecast.deals, []);
        assert.strictEqual(body.forecast.activeDeals, 0);
        assert.strictEqual(body.forecast.succeededPaymentsRUB, 0);
    });

    it('aggregates every scoped deal even when the visible list is capped at twenty', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'Many deals')");
        for (let index = 0; index < 21; index++) {
            Deals.create(1, { title: `Deal ${index}`, amount: 10, currency: 'RUB', stage: 'new' });
        }
        const { body } = await forecast(1);
        assert.strictEqual(body.forecast.activeDeals, 21);
        assert.strictEqual(body.forecast.amountsByCurrency[0].openAmount, 210);
        assert.strictEqual(body.forecast.deals.length, 20);
    });

    it('rejects invalid business identifiers before querying data', async () => {
        createTestDB();
        const response = await forecast('1other');
        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.error, 'invalid_instance_id');
    });
});
