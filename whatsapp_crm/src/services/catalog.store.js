'use strict';
// Import bookkeeping points to the existing published Autopilot catalogue.
// Prices, quotes and manager tools therefore keep a single source of truth.
const DB = require('./database.service');
const Catalog = require('./ava-autopilot.store');
function ensureSchema() {
    Catalog.ensureSchema();
    DB.db.exec(`CREATE TABLE IF NOT EXISTS customer_catalog_imports (
        id TEXT PRIMARY KEY, businessId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        createdBy TEXT NOT NULL, filename TEXT NOT NULL, rowsJson TEXT NOT NULL, baseJson TEXT NOT NULL,
        createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'preview',
        receiptJson TEXT, commitHash TEXT, idempotencyKey TEXT,
        UNIQUE(businessId,createdBy,idempotencyKey));
        CREATE TABLE IF NOT EXISTS customer_catalog_keys (
        businessId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
        productKey TEXT NOT NULL, offerId TEXT NOT NULL REFERENCES ava_catalog_offers(id) ON DELETE CASCADE,
        PRIMARY KEY(businessId,productKey), UNIQUE(businessId,offerId));`);
}
function get(businessId, id) { ensureSchema(); return DB.get('SELECT * FROM customer_catalog_imports WHERE businessId=? AND id=?', [businessId,id]); }
function listPublished(businessId) { ensureSchema(); return Catalog.publishedOffers(businessId); }
module.exports = { ensureSchema, get, listPublished, Catalog };
