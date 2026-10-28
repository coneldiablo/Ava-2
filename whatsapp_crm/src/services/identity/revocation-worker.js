'use strict';
const crypto = require('crypto');
const DB = require('../database.service');
const Identity = require('./identity-store');
const Admin = require('./keycloak-admin');
const fail = code => Object.assign(new Error(code), { code });

function lease() {
    Identity.ensureSchema();
    return DB.db.transaction(() => {
        // A registration can reuse its disabled native subject after cleanup.
        // An expired lease does not prove the previous native mutation ended;
        // retain its barrier until that invocation explicitly terminates.
        DB.run(`UPDATE ava_identity_outbox SET state='pending',leaseToken=NULL,leasedUntil=NULL
            WHERE state='leased' AND leasedUntil<=? AND NOT EXISTS (
                SELECT 1 FROM ava_invitations i WHERE i.userId=ava_identity_outbox.userId
                    AND i.createdBy LIKE 'self-registration:%')`, [Date.now()]);
        DB.run("UPDATE ava_identity_outbox SET state='failed',lastErrorCode='IDENTITY_REVOCATION_ATTEMPTS_EXHAUSTED' WHERE state='pending' AND attempts>=8");
        const job = DB.get("SELECT * FROM ava_identity_outbox WHERE state='pending' AND nextAttemptAt<=? ORDER BY createdAt LIMIT 1", [Date.now()]);
        if (!job) return null;
        const leaseToken = crypto.randomUUID();
        DB.run("UPDATE ava_identity_outbox SET state='leased',leaseToken=?,leasedUntil=?,attempts=attempts+1 WHERE id=?", [leaseToken, Date.now() + 60000, job.id]);
        const selfRegistration = !!DB.get("SELECT id FROM ava_invitations WHERE userId=? AND createdBy LIKE 'self-registration:%' LIMIT 1", [job.userId]);
        return { ...job, leaseToken, attempts: job.attempts + 1, selfRegistration };
    }).immediate();
}

function assertLease(job) {
    if (!DB.get("SELECT id FROM ava_identity_outbox WHERE id=? AND state='leased' AND leaseToken=? AND leasedUntil>?", [job.id, job.leaseToken, Date.now()])) throw fail('IDENTITY_REVOCATION_LEASE_LOST');
}

async function processOne({ admin = Admin, revokeModules, keycloakOnly = false } = {}) {
    if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') return false;
    const job = lease();
    if (!job) return false;
    try {
        const user = DB.get('SELECT * FROM ava_users WHERE id=?', [job.userId]);
        if (job.action === 'revoke_memberships' && user.enabled) throw fail('IDENTITY_REVOCATION_STATE_CHANGED');
        if (user.subject && !job.keycloakRevoked) {
            const path = `/users/${encodeURIComponent(user.subject)}`;
            const native = await admin.call('GET', path);
            assertLease(job);
            if (native?.id !== user.subject || native.attributes?.avaUserId?.[0] !== user.id) throw fail('IDENTITY_NATIVE_OWNER_UNVERIFIED');
            if (job.action === 'revoke_memberships') {
                await admin.call('PUT', path, { enabled: false });
                assertLease(job);
            }
            await admin.call('POST', `${path}/logout`);
            assertLease(job);
            const sessions = await admin.call('GET', `${path}/sessions`);
            assertLease(job);
            if (!Array.isArray(sessions) || sessions.length) throw fail('IDENTITY_NATIVE_LOGOUT_UNVERIFIED');
            DB.run('UPDATE ava_identity_outbox SET keycloakRevoked=1 WHERE id=? AND leaseToken=?', [job.id, job.leaseToken]);
        }
        // A bounded AVA-only pilot has no native module login/session surface.
        // Its worker may complete the Keycloak portion without even reading
        // legacy Twenty/Onyx link tables. This option is internal to the
        // identity-only entrypoint; the normal worker retains full cleanup.
        if (keycloakOnly === true) {
            assertLease(job);
            DB.run("UPDATE ava_identity_outbox SET state='done',leaseToken=NULL,leasedUntil=NULL,lastErrorCode=NULL WHERE id=? AND leaseToken=?", [job.id, job.leaseToken]);
            return true;
        }
        // Native module cookies may survive IdP logout. Do not claim a full
        // revoke merely because Keycloak has acknowledged it.
        const linked = DB.get(`SELECT m.businessId FROM ava_business_memberships m WHERE m.userId=? AND (
            EXISTS (SELECT 1 FROM twenty_workspace_links t WHERE t.businessId=m.businessId AND t.workspaceId IS NOT NULL)
            OR EXISTS (SELECT 1 FROM onyx_tenant_links o WHERE o.business_id=m.businessId)) LIMIT 1`, [job.userId]);
        if (linked) {
            if (!revokeModules) throw fail('NATIVE_MODULE_REVOCATION_NOT_VERIFIED');
            if (await revokeModules(user, job.action) !== true) throw fail('NATIVE_MODULE_REVOCATION_NOT_VERIFIED');
        }
        assertLease(job);
        DB.run("UPDATE ava_identity_outbox SET state='done',leaseToken=NULL,leasedUntil=NULL,lastErrorCode=NULL WHERE id=? AND leaseToken=?", [job.id, job.leaseToken]);
    } catch (error) {
        if (job.selfRegistration && error.nativeMutationAmbiguous === true) {
            // A timed-out/failed transport can leave PUT or POST executing at
            // Keycloak after this invocation returns. Automatic retry or a
            // replacement enrollment must wait for explicit reconciliation.
            DB.run(`UPDATE ava_identity_outbox SET lastErrorCode='IDENTITY_REVOCATION_RECONCILIATION_REQUIRED'
                WHERE id=? AND leaseToken=? AND state='leased'`, [job.id, job.leaseToken]);
            return true;
        }
        const code = /^[A-Z_]{3,80}$/.test(error.code || '') ? error.code : 'IDENTITY_REVOCATION_FAILED';
        DB.run(`UPDATE ava_identity_outbox SET state=?,leaseToken=NULL,leasedUntil=NULL,lastErrorCode=?,nextAttemptAt=?
            WHERE id=? AND leaseToken=? AND state='leased'`,
        [job.attempts >= 8 ? 'failed' : 'pending', code, Date.now() + Math.min(3600000, 60000 * 2 ** (job.attempts - 1)), job.id, job.leaseToken]);
    }
    return true;
}
module.exports = { processOne, lease };
