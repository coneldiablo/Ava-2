'use strict';

const DB = require('./database.service');
const Identity = require('./identity/identity-store');
const STEPS = Object.freeze(['business', 'voice', 'knowledge', 'channels', 'review']);
const initialized = new WeakSet();
const failure = (code, statusCode = 403) => Object.assign(new Error(code), { code, statusCode });

function ensureSchema() {
    if (!DB.db) throw failure('ONBOARDING_STORAGE_UNAVAILABLE', 503);
    if (initialized.has(DB.db)) return;
    DB.db.exec(`CREATE TABLE IF NOT EXISTS ava_business_onboarding (
        businessId INTEGER PRIMARY KEY REFERENCES instances(id),
        confirmedSteps TEXT NOT NULL DEFAULT '[]',
        completedAt TEXT, completedBy TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        CHECK ((completedAt IS NULL AND completedBy IS NULL)
            OR (completedAt IS NOT NULL AND completedBy IS NOT NULL))
    )`);
    DB.db.exec(`CREATE TABLE IF NOT EXISTS ava_business_preparation (businessId INTEGER PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,revision INTEGER NOT NULL,payloadJson TEXT NOT NULL,updatedAt TEXT NOT NULL)`);
    initialized.add(DB.db);
}

function authorize(current, businessId, mutation = false) {
    // Reject coercible scope aliases (1e0, 01, whitespace, arrays) everywhere,
    // including direct service callers, before touching business state.
    if (!['string', 'number'].includes(typeof businessId)
        || !/^[1-9]\d*$/.test(String(businessId))
        || !Number.isSafeInteger(Number(businessId))) throw failure('BUSINESS_SCOPE_REQUIRED', 400);
    const live = current?.userId ? Identity.actor(current.userId) : current;
    if (mutation && (!live?.userId || live.platformRole === 'platform_admin'
        || !live.memberships.some(item => item.businessId === Number(businessId) && item.role === 'hotel_owner'))) {
        throw failure('ONBOARDING_OWNER_REQUIRED');
    }
    return Identity.authorizeCapability(live, businessId, mutation ? 'business.manage' : 'business.read');
}

function state(businessId) {
    const row = DB.get('SELECT confirmedSteps,completedAt FROM ava_business_onboarding WHERE businessId=?', [businessId]);
    return {
        businessId,
        status: row?.completedAt ? 'completed' : 'pending',
        confirmedSteps: row ? JSON.parse(row.confirmedSteps) : [],
        completedAt: row?.completedAt || null,
    };
}

function get(current, businessId) {
    const scope = authorize(current, businessId);
    ensureSchema();
    // Reading or visiting a step never records progress or completes onboarding.
    return state(scope);
}

function confirmStep(current, businessId, stepId) {
    const scope = authorize(current, businessId, true);
    if (!STEPS.includes(stepId)) throw failure('ONBOARDING_STEP_INVALID', 400);
    ensureSchema();
    return DB.db.transaction(() => {
        // Recheck after acquiring the writer lock: another runtime may have
        // revoked ownership while this connection waited for that lock.
        authorize(current, scope, true);
        const previous = state(scope);
        if (previous.status === 'completed' || previous.confirmedSteps.includes(stepId)) return previous;
        const confirmedSteps = STEPS.filter(step => step === stepId || previous.confirmedSteps.includes(step));
        const now = new Date().toISOString();
        DB.run(`INSERT INTO ava_business_onboarding (businessId,confirmedSteps,createdAt,updatedAt)
            VALUES (?,?,?,?) ON CONFLICT(businessId) DO UPDATE
            SET confirmedSteps=excluded.confirmedSteps,updatedAt=excluded.updatedAt`,
        [scope, JSON.stringify(confirmedSteps), now, now]);
        return state(scope);
    }).immediate();
}

function complete(current, businessId) {
    const scope = authorize(current, businessId, true);
    ensureSchema();
    return DB.db.transaction(() => {
        authorize(current, scope, true);
        const previous = state(scope);
        if (previous.status === 'completed') return previous;
        if (!STEPS.every(step => previous.confirmedSteps.includes(step))) throw failure('ONBOARDING_STEPS_REQUIRED', 409);
        const now = new Date().toISOString();
        DB.run(`UPDATE ava_business_onboarding SET completedAt=?,completedBy=?,updatedAt=?
            WHERE businessId=? AND completedAt IS NULL`, [now, current.userId, now, scope]);
        return state(scope);
    }).immediate();
}

function preparation(current, businessId) {
    const scope = authorize(current, businessId); ensureSchema();
    const row = DB.get('SELECT revision,payloadJson,updatedAt FROM ava_business_preparation WHERE businessId=?', [scope]);
    return row ? { businessId: scope, revision: row.revision, ...JSON.parse(row.payloadJson), updatedAt: row.updatedAt }
        : { businessId: scope, revision: 0, links: [], supplement: '', updatedAt: null };
}
function savePreparation(current, businessId, body) {
    const scope = authorize(current, businessId, true); ensureSchema();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['revision','links','supplement'].includes(k))
        || !Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.supplement !== 'string' || body.supplement.length > 8000) throw failure('ONBOARDING_REQUEST_INVALID', 400);
    let links; try { links = require('./assistant-public-pages.service').normalizeLinks(body.links); } catch { throw failure('ONBOARDING_REQUEST_INVALID', 400); }
    return DB.db.transaction(() => {
        authorize(current, scope, true);
        const previous = preparation(current, scope);
        if (previous.revision !== body.revision) throw failure('ONBOARDING_PREPARATION_CHANGED', 409);
        const next = { links, supplement: body.supplement.trim() }, now = new Date().toISOString();
        DB.run('INSERT INTO ava_business_preparation VALUES (?,?,?,?) ON CONFLICT(businessId) DO UPDATE SET revision=excluded.revision,payloadJson=excluded.payloadJson,updatedAt=excluded.updatedAt', [scope, previous.revision + 1, JSON.stringify(next), now]);
        return preparation(current, scope);
    }).immediate();
}

// Confirmations acknowledge the owner's review. They do not certify that a
// channel, knowledge provider or voice runtime is connected or production-ready.
module.exports = { STEPS, ensureSchema, get, confirmStep, complete, preparation, savePreparation };
