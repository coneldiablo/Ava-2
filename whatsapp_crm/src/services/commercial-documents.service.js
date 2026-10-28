'use strict';

const { createHash } = require('crypto');
const path = require('path');
const PDFDocument = require('pdfkit');
const DB = require('./database.service');
const Studio = require('./customer-studio.service');

function fail(code, statusCode = 400) { throw Object.assign(new Error(code), { code, statusCode }); }
function ensureSchema() {
    Studio.ensureSchema();
    DB.db.exec(`CREATE TABLE IF NOT EXISTS customer_commercial_invoice_versions (
        businessId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        dealId TEXT NOT NULL REFERENCES customer_deals(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, userId TEXT NOT NULL, idempotencyKey TEXT NOT NULL,
        payloadHash TEXT NOT NULL, payloadJson TEXT NOT NULL,
        PRIMARY KEY(businessId,dealId,revision), UNIQUE(businessId,userId,idempotencyKey))`);
}
function keys(body, names) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !names.includes(key))) fail('DOCUMENT_INPUT_INVALID');
}
function text(value, max, required = false) {
    if (value === undefined || value === null) { if (required) fail('DOCUMENT_REQUISITES_REQUIRED', 422); return ''; }
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) fail('DOCUMENT_INPUT_INVALID');
    const result = value.trim();
    if (required && !result) fail('DOCUMENT_REQUISITES_REQUIRED', 422);
    return result;
}
function day(value, required = false) {
    const result = text(value, 10, required);
    if (!result && !required) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) fail('DOCUMENT_INPUT_INVALID');
    return result;
}
function party(body, seller) {
    const names = seller ? ['name','inn','kpp','address','bankName','bik','account','correspondentAccount'] : ['name','inn','address'];
    keys(body, names);
    const result = Object.fromEntries(names.map(name => [name, text(body[name], name === 'address' ? 500 : 200,
        name === 'name' || seller && ['inn','address','bankName','bik','account'].includes(name))]));
    if (result.inn && !/^(?:\d{10}|\d{12})$/.test(result.inn)
        || seller && (!/^\d{9}$/.test(result.bik) || !/^\d{20}$/.test(result.account)
            || result.kpp && !/^\d{9}$/.test(result.kpp) || result.correspondentAccount && !/^\d{20}$/.test(result.correspondentAccount))) fail('DOCUMENT_REQUISITES_INVALID', 422);
    return result;
}
function read(auth, businessId, dealId, revision) {
    const { businessId: id } = Studio.authorize(auth, businessId, dealId, 'sales.read');
    ensureSchema();
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) fail('DOCUMENT_INPUT_INVALID');
    const row = revision === undefined ? DB.get('SELECT payloadJson FROM customer_commercial_invoice_versions WHERE businessId=? AND dealId=? ORDER BY revision DESC LIMIT 1', [id,dealId])
        : DB.get('SELECT payloadJson FROM customer_commercial_invoice_versions WHERE businessId=? AND dealId=? AND revision=?', [id,dealId,revision]);
    return row ? JSON.parse(row.payloadJson) : null;
}
function list(auth, businessId, dealId) {
    const { businessId: id } = Studio.authorize(auth, businessId, dealId, 'sales.read');
    ensureSchema();
    const materialVersions = DB.all('SELECT revision,payloadJson FROM customer_studio_material_versions WHERE businessId=? AND dealId=? ORDER BY revision DESC', [id,dealId])
        .map(row => ({ revision: row.revision, createdAt: JSON.parse(row.payloadJson).createdAt }));
    const invoiceVersions = DB.all('SELECT payloadJson FROM customer_commercial_invoice_versions WHERE businessId=? AND dealId=? ORDER BY revision DESC', [id,dealId])
        .map(row => JSON.parse(row.payloadJson));
    return { success: true, businessId: id, dealId, materialVersions, invoiceVersions };
}
function issue(auth, businessId, dealId, body) {
    keys(body, ['revision','materialRevision','number','issuedOn','dueOn','seller','buyer','note','requisitesConfirmed','idempotencyKey']);
    if (!Number.isSafeInteger(body.revision) || body.revision < 0 || !Number.isSafeInteger(body.materialRevision) || body.materialRevision < 1
        || body.requisitesConfirmed !== true || typeof body.idempotencyKey !== 'string' || !body.idempotencyKey.trim() || body.idempotencyKey.length > 200) fail('DOCUMENT_INPUT_INVALID');
    const fields = { number: text(body.number, 60, true), issuedOn: day(body.issuedOn, true), dueOn: day(body.dueOn),
        seller: party(body.seller, true), buyer: party(body.buyer, false), note: text(body.note, 2000) };
    if (fields.dueOn && fields.dueOn < fields.issuedOn) fail('DOCUMENT_INPUT_INVALID');
    ensureSchema();
    Studio.authorize(auth, businessId, dealId);
    const payloadHash = createHash('sha256').update(JSON.stringify({ dealId, revision: body.revision, materialRevision: body.materialRevision, ...fields })).digest('hex');
    return DB.db.transaction(() => {
        const { businessId: id, deal } = Studio.authorize(auth, businessId, dealId);
        const prior = DB.get('SELECT payloadHash,payloadJson FROM customer_commercial_invoice_versions WHERE businessId=? AND userId=? AND idempotencyKey=?', [id,auth.userId,body.idempotencyKey]);
        if (prior) {
            if (prior.payloadHash !== payloadHash) fail('DOCUMENT_IDEMPOTENCY_CONFLICT', 409);
            return { success: true, businessId: id, dealId, invoice: JSON.parse(prior.payloadJson), replayed: true };
        }
        const previous = read(auth, id, dealId);
        if (body.revision !== (previous?.revision || 0)) fail('DOCUMENT_REVISION_CONFLICT', 409);
        const material = Studio.material(id, dealId);
        if (!material || material.revision !== body.materialRevision || material.dealRevision !== deal.revision || material.clientChatId !== deal.clientChatId) fail('DOCUMENT_MATERIAL_CHANGED', 409);
        const items = Studio.validateLines(id, material.catalogItems.map(({ offerId,offerRevision,quantity }) => ({ offerId,offerRevision,quantity })))
            .map(item => ({ ...item, terms: item.terms || '' }));
        const currencies = new Set(items.map(item => item.currency));
        const totalMinor = items.reduce((sum,item) => sum + item.totalMinor, 0);
        if (!items.length || currencies.size !== 1 || !Number.isSafeInteger(totalMinor) || totalMinor <= 0) fail('DOCUMENT_ITEMS_REQUIRED', 422);
        const invoice = { revision: body.revision + 1, materialRevision: material.revision, dealRevision: deal.revision,
            clientChatId: deal.clientChatId, ...fields, items, totalMinor, currency: items[0].currency,
            status: 'issued', requisitesConfirmed: true, paymentStatus: 'not_recorded', fiscalReceipt: false,
            createdAt: new Date().toISOString(), createdBy: auth.userId };
        DB.run('INSERT INTO customer_commercial_invoice_versions VALUES(?,?,?,?,?,?,?)', [id,dealId,invoice.revision,auth.userId,body.idempotencyKey,payloadHash,JSON.stringify(invoice)]);
        return { success: true, businessId: id, dealId, invoice, replayed: false };
    }).immediate();
}

const money = (amount,currency) => `${(amount / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
const date = value => value.split('-').reverse().join('.');
function render(document) {
    return new Promise((resolve,reject) => {
        const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 48, left: 48, right: 48 }, bufferPages: true,
            info: { Title: document.kind === 'invoice' ? `Счет ${document.number}` : 'Коммерческое предложение', Author: document.businessName,
                ...(document.createdAt ? { CreationDate: new Date(document.createdAt), ModDate: new Date(document.createdAt) } : {}) } });
        const chunks = [];
        doc.on('data', data => chunks.push(data)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
        try {
            doc.font(path.join(__dirname, 'dashboard/assets/NotoSans.ttf'));
            const width = doc.page.width - 96;
            doc.fillColor('#6D54C7').fontSize(10).text(document.businessName, { width });
            doc.moveDown().fillColor('#171717').fontSize(23).text(document.kind === 'invoice' ? `Счет на оплату № ${document.number}` : 'Коммерческое предложение', { width });
            doc.moveDown(0.5).fontSize(10).fillColor('#666666').text(document.kind === 'invoice'
                ? `От ${date(document.issuedOn)}${document.dueOn ? ' · Оплатить до ' + date(document.dueOn) : ''} · Версия ${document.revision}` : `Для ${document.clientName} · Версия ${document.revision}`);
            doc.moveDown(1.5).fillColor('#252525');
            if (document.kind === 'invoice') {
                const s = document.seller, b = document.buyer;
                doc.fontSize(10).text(`Поставщик: ${s.name}\nИНН ${s.inn}${s.kpp ? ' · КПП ' + s.kpp : ''}\n${s.address}\n${s.bankName} · БИК ${s.bik}\nР/с ${s.account}${s.correspondentAccount ? '\nК/с ' + s.correspondentAccount : ''}`, { width });
                doc.moveDown().text(`Покупатель: ${b.name}${b.inn ? '\nИНН ' + b.inn : ''}${b.address ? '\n' + b.address : ''}`, { width });
                doc.moveDown(1.5);
            } else if (document.text) { doc.fontSize(11).text(document.text, { width, lineGap: 3 }); doc.moveDown(1.5); }
            if (document.items.length) {
                doc.fontSize(10);
                const columns = [0, 260, 300, 398], widths = [248, 32, 86, 100];
                const row = (cells, header = false) => {
                    const heights = cells.map((cell,i) => doc.heightOfString(String(cell), { width: widths[i], lineGap: 2 }));
                    const height = Math.max(26, ...heights.map(h => h + 16));
                    if (doc.y + height > doc.page.height - 70) { doc.addPage(); }
                    const y = doc.y;
                    if (header) doc.rect(48,y,width,height).fill('#F0EBFC');
                    cells.forEach((cell,i) => doc.fillColor('#252525').text(String(cell), 48 + columns[i], y + 8,
                        { width: widths[i], lineGap: 2, align: i ? 'right' : 'left' }));
                    doc.moveTo(48,y + height).lineTo(48 + width,y + height).strokeColor('#E4E2E9').stroke();
                    doc.y = y + height; doc.x = 48;
                };
                row(['Наименование','Кол.','Цена','Сумма'], true);
                document.items.forEach(item => row([item.name,item.quantity,money(item.amountMinor,item.currency),money(item.totalMinor,item.currency)]));
                doc.moveDown().fontSize(15).text(document.kind === 'invoice' ? `Итого: ${money(document.totalMinor,document.currency)}`
                    : [...new Set(document.items.map(i => i.currency))].map(currency => `Итого: ${money(document.items.filter(i => i.currency === currency).reduce((s,i) => s+i.totalMinor,0),currency)}`).join('\n'), { width, align: 'right' });
            }
            doc.moveDown().fontSize(10).fillColor('#555555');
            if (document.note) { doc.text(document.note, { width, lineGap: 3 }); doc.moveDown(); }
            if (document.kind !== 'invoice') doc.text('Наличие и сроки выполнения согласовываются отдельно.', { width });
            else doc.text('Этот документ является счетом на оплату. Не является кассовым чеком и не подтверждает получение оплаты. Налоговые условия - согласно договору сторон.', { width });
            const range = doc.bufferedPageRange();
            for (let i = range.start; i < range.start + range.count; i++) {
                doc.switchToPage(i);
                const bottom = doc.page.margins.bottom;
                doc.page.margins.bottom = 0;
                doc.fontSize(8).fillColor('#888888').text(`AVA · ${i + 1} / ${range.count}`, 48, doc.page.height - 36, { width, lineBreak: false, align: 'right' });
                doc.page.margins.bottom = bottom;
            }
            doc.end();
        } catch (error) { reject(error); doc.end(); }
    });
}
async function proposalPdf(auth, businessId, dealId, revision) {
    const { businessId: id, deal } = Studio.authorize(auth,businessId,dealId,'sales.read');
    if (!Number.isSafeInteger(revision) || revision < 1) fail('DOCUMENT_INPUT_INVALID');
    const saved = Studio.material(id,dealId,revision);
    if (!saved) fail('DOCUMENT_NOT_FOUND',404);
    const business = DB.get('SELECT name FROM instances WHERE id=?', [id]);
    const client = DB.get('SELECT senderName FROM clients WHERE instanceId=? AND chatId=?', [id,saved.clientChatId]);
    const buffer = await render({ kind: 'proposal', businessName: business.name, clientName: client?.senderName || 'клиента',
        revision: saved.revision, createdAt: saved.createdAt, text: saved.text, items: saved.catalogItems });
    Studio.authorize(auth,id,deal.id,'sales.read');
    return buffer;
}
async function invoicePdf(auth,businessId,dealId,revision) {
    const invoice = read(auth,businessId,dealId,revision);
    if (!invoice) fail('DOCUMENT_NOT_FOUND',404);
    const business = DB.get('SELECT name FROM instances WHERE id=?', [Number(businessId)]);
    const buffer = await render({ kind: 'invoice', businessName: business.name, ...invoice });
    Studio.authorize(auth,businessId,dealId,'sales.read');
    return buffer;
}
function deliverySnapshot(auth,businessId,dealId,selection) {
    keys(selection,['kind','revision']);
    if (!['proposal','invoice'].includes(selection.kind) || !Number.isSafeInteger(selection.revision) || selection.revision < 1) fail('DOCUMENT_INPUT_INVALID');
    const { businessId: id,deal } = Studio.authorize(auth,businessId,dealId,'messages.send');
    require('./ava-release-flags.service').assertEnabled(id,'workspace');
    if (!deal.clientChatId) fail('STUDIO_RECIPIENT_REQUIRED',409);
    const material = Studio.material(id,dealId), invoice = selection.kind === 'invoice' ? read(auth,id,dealId) : null;
    if (!material || material.dealRevision !== deal.revision || material.clientChatId !== deal.clientChatId) fail('DOCUMENT_MATERIAL_CHANGED',409);
    if (selection.kind === 'proposal' ? material.revision !== selection.revision
        : !invoice || invoice.revision !== selection.revision || invoice.materialRevision !== material.revision
            || invoice.dealRevision !== deal.revision || invoice.clientChatId !== deal.clientChatId) fail('DOCUMENT_REVISION_CONFLICT',409);
    Studio.validateLines(id,material.catalogItems.map(({offerId,offerRevision,quantity})=>({offerId,offerRevision,quantity})));
    return {businessId:id,dealId,kind:selection.kind,revision:selection.revision,materialRevision:material.revision,
        chatId:deal.clientChatId,documentKey:`commercial:${id}:${dealId}:${selection.kind}:${selection.revision}`};
}
async function prepareDelivery(auth,businessId,dealId,selection) {
    const before = deliverySnapshot(auth,businessId,dealId,selection);
    const buffer = selection.kind === 'proposal' ? await proposalPdf(auth,businessId,dealId,selection.revision)
        : await invoicePdf(auth,businessId,dealId,selection.revision);
    const current = deliverySnapshot(auth,businessId,dealId,selection);
    if (JSON.stringify(current) !== JSON.stringify(before)) fail('DOCUMENT_MATERIAL_CHANGED',409);
    return {...current,buffer,mimeType:'application/pdf',filename:`${selection.kind}-v${selection.revision}.pdf`,
        sha256:createHash('sha256').update(buffer).digest('hex')};
}
module.exports = { ensureSchema, list, read, issue, proposalPdf, invoicePdf, render, prepareDelivery, deliverySnapshot };
