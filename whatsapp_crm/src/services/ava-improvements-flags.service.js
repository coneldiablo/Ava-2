'use strict';
const DB = require('./database.service');
const Release = require('./ava-release-flags.service');
const FEATURES = Object.freeze(['queueFlow', 'collaboration', 'shifts', 'attention', 'copilot', 'knowledgeReview']);
function fail(code, statusCode = 400) { throw Object.assign(new Error(code), {code, statusCode}); }
function ensureSchema() {
    if (!DB.db?.open) fail('WORKSPACE_FEATURES_UNAVAILABLE', 503);
    DB.db.exec(`CREATE TABLE IF NOT EXISTS ava_improvement_flags (
        businessId INTEGER PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, flagsJson TEXT NOT NULL, updatedBy TEXT NOT NULL, updatedAt TEXT NOT NULL
    )`);
}
function allowed(businessId) {
    const entries = (process.env.AVA_IMPROVEMENTS_BUSINESSES || '').split(',').map(value => value.trim()).filter(Boolean);
    return entries.includes('*') || entries.includes(String(businessId));
}
function snapshot(businessId) {
    ensureSchema();
    const id = Number(businessId);
    if (!Number.isSafeInteger(id) || id < 1) fail('WORKSPACE_FEATURES_INPUT_INVALID');
    const row = DB.get('SELECT * FROM ava_improvement_flags WHERE businessId=?', [id]);
    let configured = {};
    if (row) {
        try { configured = JSON.parse(row.flagsJson); } catch (_) { fail('WORKSPACE_FEATURES_UNAVAILABLE', 503); }
        if (!configured || typeof configured !== 'object' || Array.isArray(configured)) fail('WORKSPACE_FEATURES_UNAVAILABLE', 503);
    }
    const available = allowed(id) && Release.getFlags(id).workspace === true;
    return {revision: row?.revision || 0, available, flags: Object.fromEntries(FEATURES.map(feature =>
        [feature, available && (row ? configured[feature] === true : true)])), updatedAt: row?.updatedAt || null};
}
function assertEnabled(businessId, feature) {
    if (!FEATURES.includes(feature)) fail('WORKSPACE_FEATURES_INPUT_INVALID');
    if (!snapshot(businessId).flags[feature]) fail('WORKSPACE_FEATURE_DISABLED', 409);
}
function overview(auth, businessId) {
    const actor = Release.authorize(auth, businessId);
    return {success: true, businessId: actor.businessId, ...snapshot(actor.businessId)};
}
function update(auth, businessId, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['revision', 'flags'].includes(key))
        || !Number.isSafeInteger(body.revision) || body.revision < 0 || !body.flags || typeof body.flags !== 'object' || Array.isArray(body.flags)
        || !Object.keys(body.flags).length || Object.keys(body.flags).some(key => !FEATURES.includes(key) || typeof body.flags[key] !== 'boolean')) fail('WORKSPACE_FEATURES_INPUT_INVALID');
    ensureSchema();
    return DB.db.transaction(() => {
        const actor = Release.authorize(auth, businessId, 'business.manage');
        const previous = snapshot(actor.businessId);
        if (previous.revision !== body.revision) fail('WORKSPACE_FEATURES_REVISION_CONFLICT', 409);
        if (!previous.available && Object.values(body.flags).some(Boolean)) fail('WORKSPACE_FEATURE_DISABLED', 409);
        const row = DB.get('SELECT flagsJson FROM ava_improvement_flags WHERE businessId=?', [actor.businessId]);
        const configured = row ? JSON.parse(row.flagsJson) : Object.fromEntries(FEATURES.map(feature => [feature, true]));
        DB.run(`INSERT INTO ava_improvement_flags VALUES(?,?,?,?,?) ON CONFLICT(businessId) DO UPDATE SET
            revision=excluded.revision,flagsJson=excluded.flagsJson,updatedBy=excluded.updatedBy,updatedAt=excluded.updatedAt`,
            [actor.businessId, previous.revision + 1, JSON.stringify({...configured, ...body.flags}), actor.userId, new Date().toISOString()]);
        return {success: true, businessId: actor.businessId, ...snapshot(actor.businessId)};
    }).immediate();
}
module.exports = {FEATURES, ensureSchema, snapshot, assertEnabled, overview, update};
