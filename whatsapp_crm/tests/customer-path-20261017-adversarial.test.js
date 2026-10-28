'use strict';
// Independent integration regressions. All provider boundaries are fixtures;
// these checks perform no customer send, call or external AI request.
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Catalog = require('../src/services/ava-autopilot.store');
const Local = require('../src/services/knowledge-local.service');
const Logger = require('../src/utils/logger');

describe('Independent Oct16 product adversarial integration', () => {
    it('redacts both new webhook credentials including encoded equivalent paths', () => {
        for (const provider of ['amocrm', 'avito']) for (const prefix of ['/api/external-integrations', '/api/external%2Dintegrations']) {
            const result = Logger.safeRequestPath(`${prefix}/webhook/${provider}/1/fixture-opaque-secret?token=fixture-query-secret`);
            assert.ok(!result.includes('fixture-opaque-secret'));
            assert.ok(!result.includes('fixture-query-secret'));
            assert.match(result, /\[REDACTED\]/);
        }
    });

    it('an imported catalogue does not replace the existing answer to a return-policy question', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES(1,'Fixture'),(2,'Other')");
        const file = DB.addKnowledgeBaseFile(1, 'returns.txt', 'Правила возврата', 'adversarial-return', 'text/plain', 120, 1);
        await DB.addKnowledgeBaseChunks(file, [{ text: 'Электропастух можно вернуть в течение 14 дней после покупки при сохранении упаковки.', section: 'Возврат' }]);
        Catalog.saveOffer(1, { id: 'product', revision: 1, name: 'Электропастух', amountMinor: 125099, currency: 'RUB', active: true, publishedAt: new Date().toISOString() });
        const result = await Local.lookup(1, 'В течение какого срока можно вернуть электропастух?');
        assert.match(result?.answer || '', /14 дней/);
        assert.ok(result.citations.some(citation => citation.source_id === file));
        assert.strictEqual(await Local.lookup(2, 'В течение какого срока можно вернуть электропастух?'), null);
    });

    it('keeps published service prices answerable when their names mention delivery or installation', async () => {
        createTestDB(); DB.run("INSERT INTO instances(id,name) VALUES(1,'Fixture')");
        for (const [id, name] of [['delivery', 'Доставка электропастуха'], ['installation', 'Установка электропастуха']]) {
            Catalog.saveOffer(1, { id, revision: 1, name, amountMinor: 150000, currency: 'RUB', active: true, publishedAt: new Date().toISOString() });
            const answer = await Local.lookup(1, `Сколько стоит ${name.toLocaleLowerCase('ru')}?`);
            assert.ok(answer?.citations.some(item => item.source_id === `catalog:${id}`));
            assert.match(answer.answer, /1\s500,00/);
        }
    });

    it('deletes a disconnected integration with its business while preserving other tenants', async () => {
        createTestDB();
        const External = require('../src/services/integrations/store');
        DB.run("INSERT INTO instances(id,name) VALUES(1,'Fixture'),(2,'Other')"); External.schema();
        DB.run("INSERT INTO customer_external_connections(instanceId,provider,status,updatedAt) VALUES(1,'avito','disconnected',?),(2,'avito','disconnected',?)", [Date.now(), Date.now()]);
        External.begin(1, 'avito', 'completed-fixture', {}, 'fixture-client');
        External.finish(1, 'avito', 'completed-fixture', 'succeeded', { id: 'fixture-ack' });
        DB.run("INSERT INTO customer_external_exports VALUES(1,'amocrm','fixture-account','task','fixture-source','fixture-client','fixture-hash','done','fixture-provider-id',NULL,?)", [Date.now()]);
        await DB.deleteInstance(1);
        assert.strictEqual(DB.get('SELECT id FROM instances WHERE id=1'), undefined);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM customer_external_connections WHERE instanceId=1').n, 0);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM customer_external_operations WHERE instanceId=1').n, 0);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM customer_external_exports WHERE instanceId=1').n, 0);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM customer_external_connections WHERE instanceId=2').n, 1);
    });

    it('never erases an unresolved external write through business deletion', async () => {
        createTestDB();
        const External = require('../src/services/integrations/store');
        DB.run("INSERT INTO instances(id,name) VALUES(1,'Fixture')"); External.schema();
        External.begin(1, 'avito', 'unknown-fixture', {}, 'fixture-client');
        External.finish(1, 'avito', 'unknown-fixture', 'unknown');
        await assert.rejects(() => DB.deleteInstance(1), error => /EXTERNAL_|IN_PROGRESS/.test(error.code || ''));
        assert.ok(DB.get('SELECT id FROM instances WHERE id=1'));
        assert.strictEqual(External.operation(1, 'avito', 'unknown-fixture').status, 'unknown');
    });

    it('recovers a persisted PDF provider ACK after projection interruption without another provider send', async () => {
        createTestDB(); Identity.ensureSchema();
        DB.run("INSERT INTO instances(id,name,whatsappProvider,openWaSessionId,openWaUrl) VALUES(1,'Fixture','openwa','fixture-session','http://fixture.invalid')");
        DB.run("INSERT INTO ava_users(id,subject,email) VALUES('owner','owner','owner@example.test')");
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('owner',1,'hotel_owner')");
        const chatId = '79990000001@c.us';
        DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES(1,?,'Fixture buyer')", [chatId]);
        const auth = Identity.actor('owner');
        const Deals = require('../src/services/customer-deals.store');
        const Studio = require('../src/services/customer-studio.service');
        const Documents = require('../src/services/commercial-documents.service');
        const Workspace = require('../src/services/ava-workspace.service');
        const Recovery = require('../src/services/ava-send-recovery.service');
        const Router = require('../src/services/channel-router.service');
        const OpenWA = require('../src/services/openwa.service');
        const deal = Deals.create(1, { title: 'Fixture proposal', clientChatId: chatId }, 'owner');
        Catalog.saveOffer(1, { id: 'product', revision: 1, name: 'Fixture product', amountMinor: 12345, currency: 'RUB', active: true, publishedAt: new Date().toISOString() });
        Studio.save(auth, 1, deal.id, { revision: 0, dealRevision: deal.revision, text: 'Fixture proposal', catalogItems: [{ offerId: 'product', offerRevision: 1, quantity: 1 }], idempotencyKey: 'adversarial-material' });
        const selection = { kind: 'proposal', revision: 1 };
        const attachment = await Documents.prepareDelivery(auth, 1, deal.id, selection);
        const oldState = Router._getWhatsAppState, oldSend = OpenWA.sendDocument, oldText = OpenWA.sendMessage, oldProjection = Router._saveAcknowledged;
        let providerSends = 0;
        Router._getWhatsAppState = async () => ({ success: true, state: 'authorized' });
        OpenWA.sendDocument = async () => { providerSends++; return { success: true, providerMessageId: 'fixture-document-ack', safeToRetry: false }; };
        Router._saveAcknowledged = async () => { throw Object.assign(new Error('simulated projection interruption'), { code: 'FIXTURE_PROJECTION_INTERRUPTED' }); };
        try {
            const body = { text: 'Коммерческое предложение · PDF', idempotencyKey: attachment.documentKey };
            const first = await Workspace.reply(auth, 1, chatId, body, { attachment, beforeDispatch: () => Documents.deliverySnapshot(auth, 1, deal.id, selection) });
            assert.strictEqual(first.status, 'unknown');
            assert.strictEqual(DB.get('SELECT status FROM whatsapp_document_deliveries').status, 'accepted');
            Router._saveAcknowledged = oldProjection;
            assert.strictEqual((await Workspace.reply(auth, 1, chatId, body, { attachment })).status, 'unknown');
            assert.strictEqual(providerSends, 1);
            const detail = Recovery.detail(auth, 1, chatId);
            assert.ok(detail.evidence.some(item => item.providerMessageId === 'fixture-document-ack'), 'exact persisted document ACK must remain visible to existing send recovery');
            assert.throws(() => Recovery.reconcile(auth, 1, chatId, { actionId: detail.action.id, outcome: 'failed', confirmation: true, reason: 'Fixture owner verification' }), { code: 'WORKSPACE_RECOVERY_EVIDENCE_CONFLICT' });
            assert.strictEqual(Recovery.reconcile(auth, 1, chatId, { actionId: detail.action.id, outcome: 'sent', confirmation: true, reason: 'Fixture exact provider ACK' }).action.status, 'sent');
            assert.strictEqual(providerSends, 1);
            const reconciled = await Router.reconcileMessage(1, chatId, { channel: 'whatsapp', actionId: detail.action.id });
            assert.strictEqual(reconciled.status, 'sent');
            assert.strictEqual(reconciled.providerMessageId, 'fixture-document-ack');

            // A different user may choose exactly the same text/idempotency key
            // for an ordinary reply. That is not a trusted document dispatch.
            DB.run("INSERT INTO ava_users(id,subject,email) VALUES('second-owner','second-owner','second@example.test')");
            DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('second-owner',1,'hotel_owner')");
            const other = Identity.actor('second-owner');
            OpenWA.sendMessage = async () => ({ success: false, safeToRetry: false, statusCode: 503 });
            assert.strictEqual((await Workspace.reply(other, 1, chatId, body)).status, 'unknown');
            const fake = DB.get("SELECT id FROM ava_workspace_reply_actions WHERE businessId=1 AND userId='second-owner'");
            assert.strictEqual(DB.get('SELECT COUNT(*) n FROM ava_workspace_document_actions WHERE actionId=?', [fake.id]).n, 0);
            assert.strictEqual(Recovery.detail(other, 1, chatId, { actionId: fake.id }).evidence.length, 0);
            assert.strictEqual((await Router.reconcileMessage(1, chatId, { channel: 'whatsapp', actionId: fake.id })).status, 'unknown');
            assert.strictEqual(providerSends, 1);
        } finally { Router._getWhatsAppState = oldState; OpenWA.sendDocument = oldSend; OpenWA.sendMessage = oldText; Router._saveAcknowledged = oldProjection; }
    });
});
