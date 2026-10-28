'use strict';
const { describe,it,assert,createTestDB } = require('./test-helper');
const fs = require('fs');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Deals = require('../src/services/customer-deals.store');
const Studio = require('../src/services/customer-studio.service');
const Catalog = require('../src/services/ava-autopilot.store');
const Documents = require('../src/services/commercial-documents.service');
function fixture() {
    createTestDB(); Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES(1,'Электропастух'),(2,'Чужой бизнес')");
    for (const [id,businessId] of [['own',1],['foreign',2]]) {
        DB.run('INSERT INTO ava_users(id,subject,email) VALUES(?,?,?)',[id,id,id+'@example.test']);
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,'hotel_owner')",[id,businessId]);
    }
    DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES(1,'same@lid','Покупатель Альфа'),(2,'same@lid','Чужой покупатель')");
    const auth = Identity.actor('own'), other = Identity.actor('foreign');
    const deal = Deals.create(1,{ title: 'Подбор оборудования', clientChatId: 'same@lid' },'own');
    Catalog.saveOffer(1,{ id: 'kit', revision: 1, name: 'Комплект электропастуха для овец', amountMinor: 125099,
        currency: 'RUB', active: true, publishedAt: new Date().toISOString() });
    Studio.save(auth,1,deal.id,{ revision: 0,dealRevision: deal.revision,text: 'Подобрали комплект для вашего хозяйства. Оборудование и условия согласуем перед отправкой.',
        catalogItems: [{ offerId: 'kit',offerRevision: 1,quantity: 2 }],idempotencyKey: 'material-one' });
    const body = { revision: 0,materialRevision: 1,number: 'АВА-001',issuedOn: '2026-10-18',dueOn: '2026-10-25',
        seller: { name: 'ООО Пример',inn: '7701234567',address: 'Москва, улица Примерная, 1',bankName: 'Банк Пример',bik: '044525225',account: '40702810900000000001' },
        buyer: { name: 'ООО Покупатель',inn: '7707654321' },note: 'Оплата по договору. Доставка согласуется отдельно.',requisitesConfirmed: true,idempotencyKey: 'invoice-one' };
    return { auth,other,deal,body };
}
describe('Verified versioned commercial documents',() => {
    it('issues exact saved catalogue prices once, preserves revisions/readback, and makes real Cyrillic PDFs',async () => {
        const { auth,deal,body } = fixture();
        const first = Documents.issue(auth,1,deal.id,body);
        assert.strictEqual(first.invoice.totalMinor,250198);
        assert.strictEqual(first.invoice.paymentStatus,'not_recorded');
        assert.strictEqual(first.invoice.fiscalReceipt,false);
        assert.strictEqual(Documents.issue(auth,1,deal.id,body).replayed,true);
        assert.deepStrictEqual(Documents.read(auth,1,deal.id,1),first.invoice);
        const second = Documents.issue(auth,1,deal.id,{...body,revision: 1,number: 'АВА-001-исправлен',idempotencyKey: 'invoice-two'});
        assert.strictEqual(second.invoice.revision,2);
        assert.strictEqual(Documents.list(auth,1,deal.id).invoiceVersions.length,2);
        const proposal = await Documents.proposalPdf(auth,1,deal.id,1), invoice = await Documents.invoicePdf(auth,1,deal.id,2);
        for (const pdf of [proposal,invoice]) { assert.strictEqual(pdf.subarray(0,5).toString(),'%PDF-'); assert.ok(pdf.length > 1000); }
        assert.ok(proposal.equals(await Documents.proposalPdf(auth,1,deal.id,1)));
        assert.ok(invoice.equals(await Documents.invoicePdf(auth,1,deal.id,2)));
        if (process.env.AVA_DOCUMENT_QA_DIR) {
            fs.mkdirSync(process.env.AVA_DOCUMENT_QA_DIR,{recursive: true});
            fs.writeFileSync(process.env.AVA_DOCUMENT_QA_DIR+'/proposal.pdf',proposal);
            fs.writeFileSync(process.env.AVA_DOCUMENT_QA_DIR+'/invoice.pdf',invoice);
        }
    });
    it('prepares an immutable attachment for the shared delivery ledger without a provider send and rejects stale versions',async()=>{
        const {auth,deal,body}=fixture();Documents.issue(auth,1,deal.id,body);
        const document=await Documents.prepareDelivery(auth,1,deal.id,{kind:'invoice',revision:1});
        assert.strictEqual(document.chatId,'same@lid');assert.strictEqual(document.mimeType,'application/pdf');
        assert.strictEqual(document.documentKey,`commercial:1:${deal.id}:invoice:1`);assert.match(document.sha256,/^[a-f0-9]{64}$/);
        assert.strictEqual(document.sha256,(await Documents.prepareDelivery(auth,1,deal.id,{kind:'invoice',revision:1})).sha256);
        Catalog.saveOffer(1,{...Catalog.offer(1,'kit'),revision:2,amountMinor:90000},1);
        await assert.rejects(()=>Documents.prepareDelivery(auth,1,deal.id,{kind:'invoice',revision:1}),{code:'STUDIO_CATALOG_CHANGED'});
        // Historical download is still available; it does not authorize a new send.
        assert.ok((await Documents.invoicePdf(auth,1,deal.id,1)).length>1000);
    });
    it('rejects stale inputs, missing/unconfirmed requisites, invalid sums and forged payment state',() => {
        const {auth,deal,body} = fixture();
        assert.throws(() => Documents.issue(auth,1,deal.id,{...body,requisitesConfirmed: false}),{code:'DOCUMENT_INPUT_INVALID'});
        assert.throws(() => Documents.issue(auth,1,deal.id,{...body,seller:{...body.seller,account:''}}),{code:'DOCUMENT_REQUISITES_REQUIRED'});
        assert.throws(() => Documents.issue(auth,1,deal.id,{...body,paid:true}),{code:'DOCUMENT_INPUT_INVALID'});
        assert.throws(() => Documents.issue(auth,1,deal.id,{...body,revision:1}),{code:'DOCUMENT_REVISION_CONFLICT'});
        assert.throws(() => Documents.issue(auth,1,deal.id,{...body,issuedOn:'2026-02-30'}),{code:'DOCUMENT_INPUT_INVALID'});
        Documents.issue(auth,1,deal.id,body);
        assert.throws(() => Documents.issue(auth,1,deal.id,{...body,note:'изменено'}),{code:'DOCUMENT_IDEMPOTENCY_CONFLICT'});
        Catalog.saveOffer(1,{...Catalog.offer(1,'kit'),revision:2,amountMinor:999999},1);
        assert.throws(() => Documents.issue(auth,1,deal.id,{...body,revision:1,idempotencyKey:'changed'}),{code:'STUDIO_CATALOG_CHANGED'});
        assert.strictEqual(Documents.read(auth,1,deal.id,1).totalMinor,250198);
    });
    it('denies other businesses, revoked owners and managers without the assigned client',async () => {
        const {auth,other,deal,body} = fixture();
        assert.throws(() => Documents.issue(other,1,deal.id,body),{code:'BUSINESS_ACCESS_DENIED'});
        await assert.rejects(() => Documents.proposalPdf(other,1,deal.id,1),{code:'BUSINESS_ACCESS_DENIED'});
        DB.run("INSERT INTO ava_users(id,subject,email) VALUES('manager','manager','manager@example.test')");
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('manager',1,'manager')");
        assert.throws(()=>Documents.list(Identity.actor('manager'),1,deal.id),{code:'SALES_CLIENT_CLAIM_REQUIRED'});
        DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='own'");
        assert.throws(() => Documents.list(auth,1,deal.id),{code:'BUSINESS_ACCESS_DENIED'});
    });
    it('serves downloadable PDFs through the scoped router and rejects foreign-origin issue',async () => {
        const {auth,deal,body} = fixture();
        const express = require('express'), app = express(), Auth = require('../src/services/auth.service'); app.use(express.json());
        const oldEnabled=Auth.config.enabled,oldCustomer=process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        Auth.config.enabled=true;process.env.AVA_CUSTOMER_ACCESS_ENABLED='true';
        const token=Identity.createSession('own','commercial-router-test'),headers={Cookie:`crm_session=ava2:${token}`};
        app.use(Auth.requireAuth.bind(Auth)); app.use('/api',require('../src/routes/customer-commercial-documents.routes'));
        const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
        const origin=`http://127.0.0.1:${server.address().port}`, base=`${origin}/api/businesses/1/studio/proposals/${deal.id}/documents`;
        try {
            const issued = await fetch(base+'/invoices',{method:'POST',headers:{...headers,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
            assert.strictEqual(issued.status,200);
            const response = await fetch(base+'/invoices/1.pdf',{headers});assert.strictEqual(response.status,200);
            assert.match(response.headers.get('content-type'),/application\/pdf/);assert.match(response.headers.get('content-disposition'),/attachment/);
            assert.strictEqual(Buffer.from(await response.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
            const rejected=await fetch(base+'/invoices',{method:'POST',headers:{...headers,Origin:'https://foreign.example.test','Content-Type':'application/json'},body:JSON.stringify(body)});
            assert.strictEqual(rejected.status,403);
            assert.strictEqual((await fetch(base+'/proposal.pdf?revision=1&businessId=2',{headers})).status,400);
            const original=Documents.invoicePdf;let entered,release;
            const seen=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
            Documents.invoicePdf=async(...args)=>{entered();await held;return original(...args);};
            try {
                const pending=fetch(base+'/invoices/1.pdf',{headers});await seen;
                DB.run("UPDATE ava_sessions SET revokedAt=? WHERE userId='own'",[Date.now()]);release();
                assert.strictEqual((await pending).status,403);
            }finally{Documents.invoicePdf=original;}
            DB.run("UPDATE ava_sessions SET revokedAt=? WHERE userId='own'",[Date.now()]);
            assert.strictEqual((await fetch(base+'/invoices/1.pdf',{headers})).status,401);
        } finally {await new Promise(resolve=>server.close(resolve));Auth.config.enabled=oldEnabled;if(oldCustomer===undefined)delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;else process.env.AVA_CUSTOMER_ACCESS_ENABLED=oldCustomer;}
    });
});
