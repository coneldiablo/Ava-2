const { describe, it, assert, createTestDB } = require('./test-helper');
const express = require('express');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Deals = require('../src/services/customer-deals.store');
const routes = require('../src/routes/customer-studio.routes');

function owner(email, businessId) {
    const invitation = Identity.createInvitation({ platformRole: 'platform_admin' },
        { email, businessId, role: 'hotel_owner' });
    return Identity.completeInvitation(Identity.claimInvitation(invitation.token), `${email}-subject`);
}

async function fixture() {
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name,systemPrompt,greenApiToken) VALUES (1,'Отель Альфа','PRIVATE_SYSTEM_PROMPT','PRIVATE_KEY'),(2,'Отель Бета','PRIVATE_OTHER_PROMPT','PRIVATE_OTHER_KEY')");
    DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES (1,'same@lid','Гость Альфа'),(2,'same@lid','Гость Бета')");
    const a = owner('studio-a@example.test', 1);
    const b = owner('studio-b@example.test', 2);
    const aDeal = Deals.create(1, { title: 'Семейный отдых', clientChatId: 'same@lid',
        amount: 122500.75, currency: 'RUB', notes: 'PRIVATE_MANAGER_NOTE; скидка 90%; номер доступен' }, a.userId);
    const bDeal = Deals.create(2, { title: 'Чужая сделка', clientChatId: 'same@lid', amount: 1 }, b.userId);
    const app = express();
    app.use(express.json());
    app.use('/api', (req, res, next) => {
        const token = req.get('x-test-user');
        if (!token) return res.status(401).json({ success: false });
        req.auth = token === 'a' ? a : token === 'b' ? b : null;
        next();
    });
    app.use('/api', routes);
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    return { origin, server, aDeal, bDeal, a };
}

async function get(origin, path, who = 'a') {
    return fetch(`${origin}${path}`, { headers: who ? { 'x-test-user': who } : {} });
}

describe('Customer Studio proposal drafts', () => {
    it('saves catalog snapshots durably with revision and retry guards, and hands off without dispatch', async () => {
        const { origin, server, aDeal } = await fixture();
        const Catalog = require('../src/services/ava-autopilot.store');
        Catalog.saveOffer(1, { id: 'published-own', revision: 3, name: 'Семейный пакет',
            description: 'Завтрак', amountMinor: 750000, currency: 'RUB', terms: 'Уточнить даты',
            active: true, publishedAt: '2026-10-15T10:00:00Z' });
        Catalog.saveOffer(2, { id: 'published-foreign', revision: 1, name: 'PRIVATE_FOREIGN',
            amountMinor: 1, currency: 'RUB', active: true, publishedAt: '2026-10-15T10:00:00Z' });
        Catalog.saveOffer(1, { id: 'draft-own', revision: 1, name: 'PRIVATE_UNPUBLISHED',
            amountMinor: 1, currency: 'RUB', active: true, publishedAt: null });
        const path = `/api/businesses/1/studio/proposals/${aDeal.id}`;
        const request = (method, suffix, body, who = 'a') => fetch(origin + path + suffix, { method,
            headers: { 'x-test-user': who, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const Router = require('../src/services/channel-router.service');
        const oldSend = Router.sendMessageDetailed;
        let sends = 0;
        Router.sendMessageDetailed = async () => { sends++; throw Error('handoff must not send'); };
        try {
            const draft = await (await get(origin, path)).json();
            assert.deepStrictEqual(draft.catalog.map(item => item.offerId), ['published-own']);
            assert.strictEqual(draft.material, null);
            const body = { revision: 0, dealRevision: aDeal.revision, text: 'Проверьте предложение',
                catalogItems: [{ offerId: 'published-own', offerRevision: 3, quantity: 2 }], idempotencyKey: 'studio-save-1' };
            const savedResponse = await request('PUT', '/material', body);
            assert.strictEqual(savedResponse.status, 200);
            const saved = await savedResponse.json();
            assert.strictEqual(saved.material.revision, 1);
            assert.strictEqual(saved.material.catalogItems[0].totalMinor, 1500000);
            assert.strictEqual((await (await request('PUT', '/material', body)).json()).replayed, true);
            assert.strictEqual((await request('PUT', '/material', { ...body, text: 'Изменённый текст' })).status, 409);
            assert.strictEqual((await request('PUT', '/material', { ...body, idempotencyKey: 'stale' })).status, 409);
            assert.strictEqual((await (await get(origin, path)).json()).material.text, body.text);
            const handoff = await request('POST', '/handoff', { revision: 1 });
            assert.strictEqual(handoff.status, 200);
            const result = await handoff.json();
            assert.strictEqual(result.composer.requiresHumanConfirmation, true);
            assert.strictEqual(result.composer.chatId, 'same@lid');
            assert.ok(result.composer.href.includes('materialRevision=1'));
            assert.strictEqual((await get(origin, path + '/handoff?revision=1')).status, 200);
            assert.strictEqual(sends, 0);
            assert.strictEqual((await request('POST', '/handoff', { revision: 1 }, 'b')).status, 403);
            Catalog.saveOffer(1, { ...Catalog.offer(1, 'published-own'), revision: 4, publishedAt: null }, 3);
            assert.strictEqual((await request('POST', '/handoff', { revision: 1 })).status, 409);
            assert.strictEqual(sends, 0);
        } finally { Router.sendMessageDetailed = oldSend; await new Promise(resolve => server.close(resolve)); }
    });

    it('rejects unverified catalog prices, foreign products and a changed deal', async () => {
        const { origin, server, aDeal } = await fixture();
        const path = `/api/businesses/1/studio/proposals/${aDeal.id}/material`;
        const body = { revision: 0, dealRevision: aDeal.revision, text: 'Материал',
            catalogItems: [{ offerId: 'missing-foreign', offerRevision: 1, quantity: 1 }], idempotencyKey: 'save' };
        const save = value => fetch(origin + path, { method: 'PUT', headers: {
            'x-test-user': 'a', Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
        try {
            assert.strictEqual((await save(body)).status, 409);
            assert.strictEqual((await save({ ...body, catalogItems: [{ ...body.catalogItems[0], amountMinor: 1 }] })).status, 400);
            Deals.update(1, aDeal.id, { revision: aDeal.revision, title: 'Новая потребность' });
            assert.strictEqual((await save({ ...body, catalogItems: [] })).status, 409);
        } finally { await new Promise(resolve => server.close(resolve)); }
    });

    it('is reachable through the real app auth boundary with an owner session', async () => {
        const { server: fixtureServer, aDeal, a } = await fixture();
        const Auth = require('../src/services/auth.service');
        const app = require('../src/app').app;
        const oldEnabled = Auth.config.enabled;
        const oldCustomer = process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        Auth.config.enabled = true;
        process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
        const token = Identity.createSession(a.subject, 'qa-studio-app');
        const server = await new Promise(resolve => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        try {
            const path = `/api/businesses/1/studio/proposals/${aDeal.id}`;
            const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
                headers: { Cookie: `crm_session=ava2:${token}` },
            });
            assert.strictEqual(response.status, 200);
            const body = await response.json();
            assert.strictEqual(body.businessId, 1);
            assert.strictEqual(body.dealId, aDeal.id);
        } finally {
            Auth.config.enabled = oldEnabled;
            if (oldCustomer === undefined) delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;
            else process.env.AVA_CUSTOMER_ACCESS_ENABLED = oldCustomer;
            await new Promise(resolve => server.close(resolve));
            await new Promise(resolve => fixtureServer.close(resolve));
        }
    });

    it('requires authentication and live membership, hides foreign deals, and binds client names to both scope keys', async () => {
        const { origin, server, aDeal, bDeal } = await fixture();
        const path = id => `/api/businesses/1/studio/proposals/${id}`;
        try {
            assert.strictEqual((await get(origin, path(aDeal.id), null)).status, 401);
            assert.strictEqual((await get(origin, path(aDeal.id), 'b')).status, 403);
            assert.strictEqual((await get(origin, path(bDeal.id))).status, 404);
            const response = await get(origin, path(aDeal.id));
            assert.strictEqual(response.status, 200);
            const data = await response.json();
            assert.strictEqual(data.source.clientName, 'Гость Альфа');
            assert.strictEqual(data.source.hotelName, 'Отель Альфа');
            assert.ok(!JSON.stringify(data).includes('Гость Бета'));
            const bResponse = await get(origin, `/api/businesses/2/studio/proposals/${bDeal.id}`, 'b');
            assert.strictEqual(bResponse.status, 200);
            const bData = await bResponse.json();
            assert.strictEqual(bData.source.clientName, 'Гость Бета');
            assert.strictEqual(bData.source.hotelName, 'Отель Бета');
            assert.ok(!JSON.stringify(bData).includes('Гость Альфа'));
            assert.strictEqual((await get(origin, `${path(aDeal.id)}?businessId=2`)).status, 403);
            assert.strictEqual((await get(origin, `${path(aDeal.id)}?amount=1`)).status, 403);
            DB.run('UPDATE ava_business_memberships SET enabled=0 WHERE userId=? AND businessId=1',
                [Identity.actor(aDeal.createdBy).userId]);
            assert.strictEqual((await get(origin, path(aDeal.id))).status, 403);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    it('renders only verified deal amount, marks unknown terms, stays deterministic and read-only', async () => {
        const { origin, server, aDeal } = await fixture();
        const path = `/api/businesses/1/studio/proposals/${aDeal.id}`;
        try {
            const before = DB.db.totalChanges;
            const oneResponse = await get(origin, path);
            assert.strictEqual(oneResponse.status, 200);
            const one = await oneResponse.json();
            const two = await (await get(origin, path)).json();
            assert.deepStrictEqual(two, one);
            assert.strictEqual(DB.db.totalChanges, before);
            assert.strictEqual(one.source.amountMinor, 12250075);
            assert.ok(one.draftText.includes('122 500,75 ₽'));
            assert.ok(one.draftText.includes('Итоговую стоимость необходимо подтвердить'));
            assert.ok(one.requiresManagerConfirmation.includes('Скидки и специальные условия'));
            assert.ok(!one.draftText.includes('90%'));
            assert.ok(!one.draftText.includes('номер доступен'));
            assert.ok(!JSON.stringify(one).includes('PRIVATE_'));
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
});
