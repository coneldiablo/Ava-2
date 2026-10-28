'use strict';

// One-time repair for an owner who completed AVA's email code before the
// Keycloak enrollment fix. Defaults to a read-only preview.
const Database = require('better-sqlite3');
const path = require('path');
const KeycloakAdmin = require('./keycloak-admin');

function ownerProof(db, userId) {
    if (!/^[a-f0-9-]{36}$/i.test(String(userId || ''))) throw new Error('INVALID_USER_ID');
    const uses = db.prepare(`SELECT u.id,u.subject,u.email,o.linkId,o.createdAtMs
        FROM ava_users u JOIN ava_owner_invitation_uses o ON o.userId=u.id
        JOIN ava_invitations i ON i.id=o.invitationId
        WHERE u.id=? AND u.enabled=1 AND u.subject IS NOT NULL
          AND o.state='completed' AND i.state='consumed'`).all(userId);
    if (uses.length !== 1) throw new Error('OWNER_ENROLLMENT_NOT_UNIQUE');
    const owner = uses[0];
    const proofs = db.prepare(`SELECT id FROM ava_owner_email_verifications
        WHERE linkId=? AND lower(email)=lower(?) AND createdAtMs<=?
          AND verifiedAtMs>=?`).all(owner.linkId, owner.email, owner.createdAtMs, owner.createdAtMs);
    if (proofs.length !== 1) throw new Error('EMAIL_CODE_PROOF_NOT_UNIQUE');
    return owner;
}

async function reconcileOwnerEmail({ db, admin = KeycloakAdmin, userId, apply = false }) {
    const owner = ownerProof(db, userId);
    const username = `ava-${owner.id}`;
    const userPath = `/users?username=${encodeURIComponent(username)}&exact=true`;
    const users = await admin.call('GET', userPath);
    if (!Array.isArray(users) || users.length !== 1) throw new Error('NATIVE_USER_NOT_UNIQUE');
    const user = users[0];
    if (user.id !== owner.subject || user.username !== username
        || user.email?.toLowerCase() !== owner.email.toLowerCase()
        || user.attributes?.avaUserId?.[0] !== owner.id || user.enabled !== true) {
        throw new Error('NATIVE_IDENTITY_MISMATCH');
    }
    const requiredActions = (user.requiredActions || []).filter(action => action !== 'VERIFY_EMAIL');
    const changeNeeded = user.emailVerified !== true || requiredActions.length !== (user.requiredActions || []).length;
    if (!apply || !changeNeeded) return { eligible: true, changeNeeded, updated: false };
    await admin.call('PUT', `/users/${encodeURIComponent(user.id)}`, { emailVerified: true, requiredActions });
    const current = await admin.call('GET', `/users/${encodeURIComponent(user.id)}`);
    if (current?.id !== user.id || current.emailVerified !== true
        || current.requiredActions?.includes('VERIFY_EMAIL')) throw new Error('NATIVE_READBACK_MISMATCH');
    return { eligible: true, changeNeeded: true, updated: true };
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 2 || args.length > 3 || args[0] !== '--user-id'
        || (args.length === 3 && args[2] !== '--apply')) throw new Error('USAGE');
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../../../crm_v2.db');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const result = await reconcileOwnerEmail({ db, userId: args[1], apply: args[2] === '--apply' });
        process.stdout.write(JSON.stringify(result) + '\n');
    } finally { db.close(); }
}

if (require.main === module) main().catch(error => {
    process.stderr.write(`OWNER_EMAIL_REPAIR_FAILED code=${error.message || 'UNKNOWN'}\n`);
    process.exitCode = 1;
});
module.exports = { ownerProof, reconcileOwnerEmail };
