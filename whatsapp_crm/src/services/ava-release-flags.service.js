'use strict';
const DB = require('./database.service');
const Sales = require('./sales-workspace.service');
const initialized = new WeakSet();
const FEATURES = Object.freeze(['workspace', 'analytics', 'autopilot']);
function fail(code, statusCode=400) { throw Object.assign(new Error(code), {code, statusCode}); }
function ensureSchema() {
    if (!DB.db?.open) fail('AVA_RELEASE_UNAVAILABLE', 503);
    if (initialized.has(DB.db) && DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ava_release_flags'")) return;
    DB.db.exec(`CREATE TABLE IF NOT EXISTS ava_release_flags (
        businessId INTEGER PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, flagsJson TEXT NOT NULL, updatedBy TEXT NOT NULL, updatedAt TEXT NOT NULL
    )`);
    initialized.add(DB.db);
}
function availability(businessId) {
    return Object.fromEntries(FEATURES.map(feature => {
        const value = process.env['AVA_' + feature.toUpperCase() + '_BUSINESSES'];
        const entries = value == null ? ['*'] : value.split(',').map(part => part.trim()).filter(Boolean);
        return [feature, entries.includes('*') || entries.includes(String(businessId))];
    }));
}
function snapshot(businessId) {
    ensureSchema();
    const row = DB.get('SELECT * FROM ava_release_flags WHERE businessId=?', [businessId]);
    const configured = row ? JSON.parse(row.flagsJson) : Object.fromEntries(FEATURES.map(feature => [feature, true]));
    const available = availability(businessId);
    return {revision: row?.revision || 0, flags: Object.fromEntries(FEATURES.map(feature => [feature, available[feature] && configured[feature] === true])), availability: available, updatedAt: row?.updatedAt || null};
}
function getFlags(businessId) { return snapshot(Number(businessId)).flags; }
function assertEnabled(businessId, feature) {
    if (!FEATURES.includes(feature)) fail('AVA_RELEASE_INPUT_INVALID');
    if (!getFlags(businessId)[feature]) fail('AVA_FEATURE_DISABLED', 409);
}
function authorize(auth, businessId, capability='sales.read') {
    if (!auth?.userId || auth.platformRole === 'platform_admin') fail('BUSINESS_ACCESS_DENIED', 403);
    return Sales.authorize(auth, businessId, capability);
}
function overview(auth, businessId) {
    const actor = authorize(auth, businessId);
    return {success: true, businessId: actor.businessId, ...snapshot(actor.businessId)};
}
function update(auth, businessId, body) {
    ensureSchema();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['revision','flags'].includes(key))
        || !Number.isSafeInteger(body.revision) || body.revision < 0 || !body.flags || typeof body.flags !== 'object' || Array.isArray(body.flags)
        || !Object.keys(body.flags).length || Object.keys(body.flags).some(key => !FEATURES.includes(key) || typeof body.flags[key] !== 'boolean')) fail('AVA_RELEASE_INPUT_INVALID');
    return DB.db.transaction(() => {
        const actor = authorize(auth, businessId, 'business.manage');
        const previous = snapshot(actor.businessId);
        if (body.revision !== previous.revision) fail('AVA_RELEASE_REVISION_CONFLICT', 409);
        if (Object.entries(body.flags).some(([feature, enabled]) => enabled && !previous.availability[feature])) fail('AVA_RELEASE_NOT_AVAILABLE', 403);
        const current = DB.get('SELECT flagsJson FROM ava_release_flags WHERE businessId=?', [actor.businessId]);
        const configured = current ? JSON.parse(current.flagsJson) : Object.fromEntries(FEATURES.map(feature => [feature, true]));
        const next = {...configured, ...body.flags};
        DB.run('INSERT INTO ava_release_flags VALUES(?,?,?,?,?) ON CONFLICT(businessId) DO UPDATE SET revision=excluded.revision,flagsJson=excluded.flagsJson,updatedBy=excluded.updatedBy,updatedAt=excluded.updatedAt',
            [actor.businessId, previous.revision + 1, JSON.stringify(next), actor.userId, new Date().toISOString()]);
        return {success: true, businessId: actor.businessId, ...snapshot(actor.businessId)};
    }).immediate();
}
function removeBusiness(businessId) { ensureSchema(); DB.run('DELETE FROM ava_release_flags WHERE businessId=?', [businessId]); }
module.exports = {FEATURES, ensureSchema, snapshot, getFlags, assertEnabled, authorize, overview, update, removeBusiness};
