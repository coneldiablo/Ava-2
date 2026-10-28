'use strict';

const { createHash } = require('crypto');
const DB = require('./database.service');
const Deals = require('./customer-deals.store');
const Catalog = require('./ava-autopilot.store');
const Sales = require('./sales-workspace.service');
const Identity = require('./identity/identity-store');
const initialized = new WeakSet();

function fail(code, statusCode = 400) { throw Object.assign(new Error(code), { code, statusCode }); }
function keys(body, allowed) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !allowed.includes(key))) fail('STUDIO_INPUT_INVALID');
}
function ensureSchema() {
    if (initialized.has(DB.db)) return;
    DB.db.exec(`CREATE TABLE IF NOT EXISTS customer_studio_material_versions (
        businessId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        dealId TEXT NOT NULL REFERENCES customer_deals(id) ON DELETE CASCADE, revision INTEGER NOT NULL, userId TEXT NOT NULL,
        idempotencyKey TEXT NOT NULL, payloadHash TEXT NOT NULL, payloadJson TEXT NOT NULL,
        PRIMARY KEY(businessId,dealId,revision), UNIQUE(businessId,userId,idempotencyKey)
    )`);
    initialized.add(DB.db);
}
function material(businessId, dealId, revision) {
    ensureSchema();
    const row = revision === undefined
        ? DB.get('SELECT payloadJson FROM customer_studio_material_versions WHERE businessId=? AND dealId=? ORDER BY revision DESC LIMIT 1', [businessId, dealId])
        : DB.get('SELECT payloadJson FROM customer_studio_material_versions WHERE businessId=? AND dealId=? AND revision=?', [businessId, dealId, revision]);
    return row ? JSON.parse(row.payloadJson) : null;
}
function catalog(businessId) {
    return Catalog.publishedOffers(businessId).map(offer => ({ offerId: offer.id,
        offerRevision: offer.revision, name: offer.name, description: offer.description || '',
        amountMinor: offer.amountMinor, currency: offer.currency, terms: offer.terms || '',
        publishedAt: offer.publishedAt }));
}
function authorize(auth, businessId, dealId, capability = 'sales.write') {
    const id = Identity.authorizeCapability(auth, businessId, capability);
    const deal = Deals.get(id, dealId);
    if (!deal) fail('DEAL_NOT_FOUND', 404);
    if (deal.clientChatId) Sales.authorizeClientMutation(auth, id, deal.clientChatId, { capability });
    else {
        const member = Identity.actor(auth.userId).memberships.find(item => item.businessId === id);
        if (!member?.capabilities.includes('sales.assign') && deal.createdBy !== auth.userId) fail('STUDIO_DEAL_SCOPE_DENIED', 403);
    }
    return { businessId: id, deal };
}
function lines(businessId, items) {
    if (!Array.isArray(items) || items.length > 30) fail('STUDIO_INPUT_INVALID');
    const seen = new Set();
    return items.map(item => {
        keys(item, ['offerId', 'offerRevision', 'quantity']);
        if (typeof item.offerId !== 'string' || !item.offerId || seen.has(item.offerId)
            || !Number.isSafeInteger(item.offerRevision) || !Number.isSafeInteger(item.quantity)
            || item.quantity < 1 || item.quantity > 10000) fail('STUDIO_INPUT_INVALID');
        seen.add(item.offerId);
        const offer = Catalog.offer(businessId, item.offerId);
        if (!offer?.active || !offer.publishedAt || offer.revision !== item.offerRevision) fail('STUDIO_CATALOG_CHANGED', 409);
        const totalMinor = offer.amountMinor * item.quantity;
        if (!Number.isSafeInteger(totalMinor)) fail('STUDIO_INPUT_INVALID');
        return { offerId: offer.id, offerRevision: offer.revision, name: offer.name,
            quantity: item.quantity, amountMinor: offer.amountMinor, totalMinor,
            currency: offer.currency, terms: offer.terms || '' };
    });
}
function save(auth, businessId, dealId, body) {
    keys(body, ['revision', 'dealRevision', 'text', 'catalogItems', 'idempotencyKey']);
    if (!Number.isSafeInteger(body.revision) || body.revision < 0
        || !Number.isSafeInteger(body.dealRevision) || body.dealRevision < 1
        || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000
        || typeof body.idempotencyKey !== 'string' || !body.idempotencyKey.trim() || body.idempotencyKey.length > 200) fail('STUDIO_INPUT_INVALID');
    ensureSchema(); Catalog.ensureSchema(); Deals.ensureSchema();
    // Initialize the existing identity/sales schemas before a rejected save
    // can roll back their lazy migrations while leaving initialization cached.
    authorize(auth, businessId, dealId);
    const payloadHash = createHash('sha256').update(JSON.stringify({ dealId, revision: body.revision,
        dealRevision: body.dealRevision, text: body.text.trim(), catalogItems: body.catalogItems })).digest('hex');
    return DB.db.transaction(() => {
        const { businessId: id, deal } = authorize(auth, businessId, dealId);
        const prior = DB.get('SELECT payloadHash,payloadJson FROM customer_studio_material_versions WHERE businessId=? AND userId=? AND idempotencyKey=?', [id, auth.userId, body.idempotencyKey]);
        if (prior) {
            if (prior.payloadHash !== payloadHash) fail('STUDIO_IDEMPOTENCY_CONFLICT', 409);
            return { success: true, businessId: id, dealId, material: JSON.parse(prior.payloadJson), replayed: true };
        }
        const previous = material(id, dealId);
        if (body.revision !== (previous?.revision || 0)) fail('STUDIO_REVISION_CONFLICT', 409);
        if (body.dealRevision !== deal.revision) fail('STUDIO_DEAL_CHANGED', 409);
        const saved = { revision: body.revision + 1, dealRevision: deal.revision,
            text: body.text.trim(), catalogItems: lines(id, body.catalogItems),
            clientChatId: deal.clientChatId, createdAt: new Date().toISOString(), updatedBy: auth.userId };
        DB.run('INSERT INTO customer_studio_material_versions VALUES(?,?,?,?,?,?,?)',
            [id, dealId, saved.revision, auth.userId, body.idempotencyKey, payloadHash, JSON.stringify(saved)]);
        return { success: true, businessId: id, dealId, material: saved, replayed: false };
    }).immediate();
}
function handoff(auth, businessId, dealId, revision) {
    if (!Number.isSafeInteger(revision) || revision < 1) fail('STUDIO_INPUT_INVALID');
    const { businessId: id, deal } = authorize(auth, businessId, dealId, 'messages.send');
    require('./ava-release-flags.service').assertEnabled(id, 'workspace');
    const saved = material(id, dealId);
    if (!saved || saved.revision !== revision) fail('STUDIO_REVISION_CONFLICT', 409);
    if (!deal.clientChatId || saved.clientChatId !== deal.clientChatId) fail('STUDIO_RECIPIENT_REQUIRED', 409);
    if (saved.dealRevision !== deal.revision) fail('STUDIO_DEAL_CHANGED', 409);
    lines(id, saved.catalogItems.map(({ offerId, offerRevision, quantity }) => ({ offerId, offerRevision, quantity })));
    const recipient = DB.get('SELECT preferredChannel FROM clients WHERE instanceId=? AND chatId=?', [id, deal.clientChatId]);
    const channel = recipient?.preferredChannel || 'whatsapp';
    const channelCapabilities = require('./channel-router.service').getCapabilities(channel);
    const href = `/today?client=${encodeURIComponent(deal.clientChatId)}&material=${encodeURIComponent(dealId)}&materialRevision=${revision}`;
    return { success: true, businessId: id, dealId, material: saved, composer: { businessId: id,
        chatId: deal.clientChatId, text: saved.text, materialRevision: revision,
        channel, channelCapabilities, requiresHumanConfirmation: true, href } };
}
module.exports = { ensureSchema, catalog, material, save, handoff, authorize, validateLines: lines };
