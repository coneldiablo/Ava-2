'use strict';
const crypto = require('crypto');
const DB = require('../database.service');
const Identity = require('./identity-store');
const Admin = require('./keycloak-admin');
const initialized = new WeakSet();
const GENERIC_RESULT = Object.freeze({ success: true,
    message: 'Если адрес зарегистрирован, письмо для восстановления будет отправлено.' });
const WINDOW_MS = 3600000, TTL_MS = 600000;
const UNKNOWN_OUTCOME = 'IDENTITY_RECOVERY_OUTCOME_UNKNOWN';
const failure = code => Object.assign(new Error(code), { code, statusCode: 503 });

function ensureSchema() {
    Identity.ensureSchema();
    if (initialized.has(DB.db)) return;
    DB.db.exec(`CREATE TABLE IF NOT EXISTS ava_password_recovery_limits (
        keyHash TEXT PRIMARY KEY, windowStart INTEGER NOT NULL, count INTEGER NOT NULL, lastRequestAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ava_password_recovery_jobs (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES ava_users(id), subject TEXT NOT NULL, email TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','sending','done','failed')),
        createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        nextAttemptAt INTEGER NOT NULL, leaseToken TEXT, leasedUntil INTEGER, lastErrorCode TEXT
    );
    CREATE INDEX IF NOT EXISTS ava_password_recovery_pending ON ava_password_recovery_jobs(state,nextAttemptAt);`);
    initialized.add(DB.db);
}
function privateHash(scope, value) {
    const secret = String(process.env.SESSION_SECRET || '');
    if (secret.length < 32) throw failure('IDENTITY_CONFIGURATION_INVALID');
    return crypto.createHmac('sha256', secret).update(`ava:password-recovery:${scope}:${value}`).digest('hex');
}
function eligible(target) {
    const users = DB.all('SELECT * FROM ava_users WHERE lower(email)=? LIMIT 2', [target.email]);
    return users.length === 1 && users[0].id === target.userId && users[0].subject === target.subject
        && users[0].enabled === 1 && !DB.get("SELECT id FROM ava_identity_outbox WHERE userId=? AND state!='done'", [target.userId]);
}
function request({ email, rateLimitKey } = {}) {
    ensureSchema();
    const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
    // Malformed addresses have the same response; HTTP body limits are enforced
    // by the router and counters never contain raw emails or source IPs.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) return { ...GENERIC_RESULT };
    const emailKey = privateHash('email', address), sourceKey = privateHash('source', String(rateLimitKey || 'unknown').slice(0, 255));
    DB.db.transaction(() => {
        const now = Date.now();
        DB.run('DELETE FROM ava_password_recovery_limits WHERE windowStart<?', [now - WINDOW_MS]);
        // Unknown dispatches are durable fences, including across expiry/restarts.
        DB.run("DELETE FROM ava_password_recovery_jobs WHERE expiresAt<? AND state!='sending' AND COALESCE(lastErrorCode,'')!=?", [now - 86400000, UNKNOWN_OUTCOME]);
        const emailLimit = DB.get('SELECT * FROM ava_password_recovery_limits WHERE keyHash=?', [emailKey]);
        const sourceLimit = DB.get('SELECT * FROM ava_password_recovery_limits WHERE keyHash=?', [sourceKey]);
        if ((emailLimit && (emailLimit.count >= 3 || emailLimit.lastRequestAt > now - 60000))
            || (sourceLimit && sourceLimit.count >= 20)) return;
        for (const key of [emailKey, sourceKey]) DB.run(`INSERT INTO ava_password_recovery_limits VALUES (?,?,1,?)
            ON CONFLICT(keyHash) DO UPDATE SET count=count+1,lastRequestAt=excluded.lastRequestAt`, [key, now, now]);
        const users = DB.all('SELECT id AS userId,subject,email,enabled FROM ava_users WHERE lower(email)=? LIMIT 2', [address]);
        const user = users[0];
        if (users.length !== 1 || !user.subject || !eligible(user)) return;
        if (DB.get("SELECT id FROM ava_password_recovery_jobs WHERE userId=? AND subject=? AND email=? AND (lastErrorCode=? OR state='sending')",
            [user.userId, user.subject, address, UNKNOWN_OUTCOME])) return;
        if (DB.get("SELECT id FROM ava_password_recovery_jobs WHERE userId=? AND state IN ('pending','sending') AND expiresAt>?", [user.userId, now])) return;
        DB.run(`INSERT INTO ava_password_recovery_jobs(id,userId,subject,email,state,createdAt,expiresAt,nextAttemptAt)
            VALUES (?,?,?,?,'pending',?,?,?)`, [crypto.randomUUID(), user.userId, user.subject, address, now, now + TTL_MS, now]);
    }).immediate();
    return { ...GENERIC_RESULT };
}
function assertLease(job) {
    const now = Date.now();
    const row = DB.get("SELECT id FROM ava_password_recovery_jobs WHERE id=? AND state='sending' AND leaseToken=? AND leasedUntil>? AND expiresAt>?",
        [job.id, job.leaseToken, now, now]);
    if (!row || !eligible(job)) throw failure('IDENTITY_RECOVERY_TARGET_INVALID');
}
async function processOne({ admin = Admin } = {}) {
    if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') throw failure('IDENTITY_WORKER_REQUIRED');
    ensureSchema();
    const job = DB.db.transaction(() => {
        const now = Date.now();
        // The worker may have stopped after Keycloak accepted the email and
        // before the local ACK. A stale sending lease never permits redispatch.
        DB.run("UPDATE ava_password_recovery_jobs SET state='failed',leaseToken=NULL,leasedUntil=NULL,lastErrorCode=? WHERE state='sending' AND (leasedUntil<=? OR expiresAt<=?)", [UNKNOWN_OUTCOME, now, now]);
        DB.run("UPDATE ava_password_recovery_jobs SET state='failed',leaseToken=NULL,leasedUntil=NULL,lastErrorCode='RECOVERY_EXPIRED' WHERE expiresAt<=? AND state='pending'", [now]);
        const row = DB.get(`SELECT * FROM ava_password_recovery_jobs WHERE expiresAt>? AND nextAttemptAt<=?
            AND state='pending' ORDER BY createdAt LIMIT 1`, [now, now]);
        if (!row) return null;
        const unknown = DB.get('SELECT id FROM ava_password_recovery_jobs WHERE userId=? AND subject=? AND email=? AND lastErrorCode=?',
            [row.userId, row.subject, row.email, UNKNOWN_OUTCOME]);
        if (unknown || row.attempts >= 3 || !eligible(row)) {
            DB.run("UPDATE ava_password_recovery_jobs SET state='failed',leaseToken=NULL,leasedUntil=NULL,lastErrorCode=? WHERE id=?", [unknown ? UNKNOWN_OUTCOME : 'IDENTITY_RECOVERY_TARGET_INVALID', row.id]);
            return null;
        }
        const leaseToken = crypto.randomBytes(32).toString('base64url');
        DB.run("UPDATE ava_password_recovery_jobs SET state='sending',leaseToken=?,leasedUntil=?,attempts=attempts+1 WHERE id=?", [leaseToken, now + 60000, row.id]);
        return { ...row, leaseToken, attempts: row.attempts + 1 };
    }).immediate();
    if (!job) return false;
    try {
        assertLease(job);
        await admin.sendPasswordRecovery({ userId: job.userId, subject: job.subject, email: job.email }, () => assertLease(job));
        assertLease(job);
        DB.run("UPDATE ava_password_recovery_jobs SET state='done',leaseToken=NULL,leasedUntil=NULL,lastErrorCode=NULL WHERE id=? AND leaseToken=?", [job.id, job.leaseToken]);
    } catch (error) {
        const unknown = error.nativeMutationAmbiguous === true;
        const retry = !unknown && error.code === 'IDENTITY_PROVIDER_UNAVAILABLE' && job.attempts < 3 && job.expiresAt > Date.now();
        DB.run(`UPDATE ava_password_recovery_jobs SET state=?,nextAttemptAt=?,leaseToken=NULL,leasedUntil=NULL,lastErrorCode=? WHERE id=? AND leaseToken=?`,
            [retry ? 'pending' : 'failed', Date.now() + 60000 * job.attempts,
                unknown ? UNKNOWN_OUTCOME : retry ? 'IDENTITY_PROVIDER_UNAVAILABLE' : 'IDENTITY_RECOVERY_FAILED', job.id, job.leaseToken]);
    }
    return true;
}
module.exports = { request, processOne, ensureSchema, GENERIC_RESULT };
