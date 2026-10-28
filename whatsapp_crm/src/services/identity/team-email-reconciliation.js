'use strict';
const crypto = require('crypto');
const DB = require('../database.service');
const Admin = require('./keycloak-admin');
const fail = code => Object.assign(new Error(code), { code, statusCode: 409 });
const validId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);

// Deliberately SELECT-only: the operator command must not run migrations or
// change AVA authority while inspecting an already completed enrollment.
function proof(invitationId, verificationId) {
    const row = DB.get(`SELECT i.id,i.tokenHash,i.userId,i.businessId,i.role,i.acceptanceMode,i.state,i.expiresAt,
        i.leaseToken,i.leasedUntil,u.subject,u.email,u.enabled,u.platformRole,
        m.enabled AS membershipEnabled,m.role AS membershipRole,b.isActive,
        v.id AS verificationId,v.invitationTokenHash,v.email AS proofEmail,v.createdAtMs,
        v.verifiedAtMs,v.expiresAtMs,v.completedAtMs
        FROM ava_invitations i JOIN ava_users u ON u.id=i.userId
        JOIN ava_team_email_verifications v ON v.invitationId=i.id AND v.id=?
        JOIN ava_business_memberships m ON m.userId=i.userId AND m.businessId=i.businessId
        JOIN instances b ON b.id=i.businessId WHERE i.id=?`, [verificationId, invitationId]);
    const now = Date.now();
    if (!row || row.acceptanceMode !== 'team' || row.state !== 'consumed'
        || !['sales_lead', 'manager', 'observer'].includes(row.role)
        || row.leaseToken !== null || row.leasedUntil !== null
        || row.enabled !== 1 || row.platformRole !== 'customer' || row.membershipEnabled !== 1
        || row.membershipRole !== row.role || row.isActive !== 1
        || typeof row.subject !== 'string' || !row.subject || row.subject.length > 255
        || typeof row.email !== 'string' || !row.email
        || typeof row.proofEmail !== 'string' || row.proofEmail.toLowerCase() !== row.email.toLowerCase()
        || row.invitationTokenHash !== row.tokenHash || !/^[a-f0-9]{64}$/.test(row.tokenHash)
        || !Number.isSafeInteger(row.createdAtMs) || !Number.isSafeInteger(row.verifiedAtMs)
        || !Number.isSafeInteger(row.completedAtMs) || !Number.isSafeInteger(row.expiresAtMs)
        || row.createdAtMs <= 0 || row.verifiedAtMs < row.createdAtMs
        || row.verifiedAtMs >= row.expiresAtMs || row.completedAtMs < row.verifiedAtMs
        || row.completedAtMs >= row.expiresAtMs || row.completedAtMs >= row.expiresAt || row.completedAtMs > now
        || DB.get('SELECT COUNT(*) n FROM ava_users WHERE lower(email)=lower(?)', [row.email]).n !== 1
        || DB.get("SELECT COUNT(*) n FROM ava_identity_outbox WHERE userId=? AND state!='done'", [row.userId]).n !== 0) {
        throw fail('TEAM_EMAIL_RECONCILIATION_PROOF_INVALID');
    }
    return row;
}
function matches(user, target) {
    return user?.id === target.subject && user.username === `ava-${target.userId}`
        && user.enabled === true && typeof user.email === 'string'
        && user.email.toLowerCase() === target.email.toLowerCase()
        && Array.isArray(user.attributes?.avaUserId) && user.attributes.avaUserId.length === 1
        && user.attributes.avaUserId[0] === target.userId
        && typeof user.emailVerified === 'boolean'
        && Array.isArray(user.requiredActions) && user.requiredActions.every(value => typeof value === 'string');
}
function state(user) { return JSON.stringify({ emailVerified: user.emailVerified, requiredActions: user.requiredActions }); }
async function reconcile({ invitationId, verificationId, apply = false, admin = Admin } = {}) {
    if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') throw fail('IDENTITY_WORKER_REQUIRED');
    if (!validId(invitationId) || !validId(verificationId) || typeof apply !== 'boolean') throw fail('TEAM_EMAIL_RECONCILIATION_SCOPE_REQUIRED');
    const target = proof(invitationId, verificationId), fingerprint = JSON.stringify(target);
    const assertProof = () => {
        if (JSON.stringify(proof(invitationId, verificationId)) !== fingerprint) throw fail('TEAM_EMAIL_RECONCILIATION_PROOF_CHANGED');
    };
    const call = async (method, path, data) => {
        // A 401 on PUT requires a fresh operator run: silently redispatching a
        // patch could overwrite native requiredActions changed since the read.
        const result = await admin.call(method, path, data, method === 'PUT', assertProof);
        assertProof();
        return result;
    };
    const path = `/users/${encodeURIComponent(target.subject)}`;
    const native = await call('GET', path);
    if (!matches(native, target)) throw fail('TEAM_EMAIL_RECONCILIATION_NATIVE_CONFLICT');
    for (const query of [`email=${encodeURIComponent(target.email)}`, `username=${encodeURIComponent(`ava-${target.userId}`)}`]) {
        const users = await call('GET', `/users?${query}&exact=true`);
        if (!Array.isArray(users) || users.length !== 1 || !matches(users[0], target)
            || state(users[0]) !== state(native)) throw fail('TEAM_EMAIL_RECONCILIATION_NATIVE_CONFLICT');
    }
    // Use a fresh native representation immediately before choosing the patch;
    // concurrent changes to requiredActions fail closed rather than dropping an action.
    const current = await call('GET', path);
    if (!matches(current, target) || state(current) !== state(native)) throw fail('TEAM_EMAIL_RECONCILIATION_NATIVE_CONFLICT');
    const requiredActions = current.requiredActions.filter(action => action !== 'VERIFY_EMAIL');
    if (current.emailVerified === true && requiredActions.length === current.requiredActions.length) return { status: 'already_verified', changed: false, readbackVerified: true };
    if (!apply) return { status: 'repair_required', changed: false, readbackVerified: true };
    // No password, enabled flag, identity mapping, role or other required action
    // is written. KeycloakAdmin rechecks proof after token acquisition/401 refresh.
    try {
        await call('PUT', path, { emailVerified: true, requiredActions });
        const readback = await call('GET', path);
        if (!matches(readback, target) || readback.emailVerified !== true
            || JSON.stringify(readback.requiredActions) !== JSON.stringify(requiredActions)) {
            throw fail('TEAM_EMAIL_RECONCILIATION_READBACK_FAILED');
        }
    } catch (error) {
        // The command never claims rollback after a dispatched native change.
        error.nativeMutationAmbiguous = true;
        throw error;
    }
    return { status: 'repaired', changed: true, readbackVerified: true };
}
function scopeDigest(invitationId, verificationId) {
    return crypto.createHash('sha256').update(JSON.stringify([invitationId, verificationId])).digest('hex');
}
module.exports = { reconcile, scopeDigest };
