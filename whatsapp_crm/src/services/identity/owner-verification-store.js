'use strict';

const crypto = require('crypto');
const DB = require('../database.service');
const Identity = require('./identity-store');
const SystemMailer = require('./system-mailer.service');
const scrubbedDatabases = new WeakSet();

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const failure = (code, statusCode = 400, extra = {}) => Object.assign(new Error(code), { code, statusCode, ...extra });


function getEncryptionKey() {
    const raw = String(process.env.SESSION_SECRET || process.env.TWENTY_CREDENTIALS_MASTER_KEY || '').trim();
    if (!raw) throw failure('VERIFICATION_ENCRYPTION_KEY_MISSING', 503);
    return crypto.createHash('sha256').update(raw).digest();
}

function encryptSecret(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptSecret(encrypted) {
    const [ivStr, tagStr, ctStr] = String(encrypted || '').split('.');
    if (!ivStr || !tagStr || !ctStr) throw failure('ENCRYPTION_PAYLOAD_INVALID', 500);
    const iv = Buffer.from(ivStr, 'base64url');
    const tag = Buffer.from(tagStr, 'base64url');
    const ct = Buffer.from(ctStr, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function maskEmail(email) {
    const [user, domain] = String(email || '').split('@');
    if (!user || !domain) return email;
    const maskedUser = user.length <= 2 ? `${user[0]}*` : `${user[0]}${'*'.repeat(Math.min(user.length - 2, 4))}${user[user.length - 1]}`;
    return `${maskedUser}@${domain}`;
}

class OwnerVerificationStore {
    ensureSchema() {
        if (!DB.db) throw failure('IDENTITY_STORAGE_UNAVAILABLE', 503);
        Identity.ensureSchema();
        DB.db.exec(`
            CREATE TABLE IF NOT EXISTS ava_owner_email_verifications (
                id TEXT PRIMARY KEY,
                linkId TEXT NOT NULL REFERENCES ava_owner_invitation_links(id),
                email TEXT NOT NULL,
                displayName TEXT NOT NULL DEFAULT '',
                passwordEncrypted TEXT NOT NULL,
                codeHash TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                resendAfterMs INTEGER NOT NULL,
                expiresAtMs INTEGER NOT NULL,
                verifiedAtMs INTEGER,
                createdAtMs INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ava_owner_email_verifications_link_email
                ON ava_owner_email_verifications(linkId, email, createdAtMs DESC);
        `);
        // Older successful enrollments retained a decryptable password. Once
        // verifiedAtMs is set, retry is forbidden and this value is no longer
        // needed. Run the migration once per DB connection before any read.
        if (!scrubbedDatabases.has(DB.db)) {
            DB.run(`UPDATE ava_owner_email_verifications SET passwordEncrypted=''
                WHERE verifiedAtMs IS NOT NULL AND passwordEncrypted!=''`);
            scrubbedDatabases.add(DB.db);
        }
    }

    async initiateVerification(token, { email, displayName, password }) {
        this.ensureSchema();
        const address = String(email || '').trim().toLowerCase();
        const name = String(displayName || '').trim();
        const rawPassword = String(password || '');

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) {
            throw failure('EMAIL_INVALID', 400);
        }
        if (rawPassword.length < 12 || rawPassword.length > 256) {
            throw failure('PASSWORD_POLICY', 400);
        }

        const link = Identity.validOwnerLink(token);

        // Check if an active account already exists with this email
        const existing = DB.get('SELECT id, enabled FROM ava_users WHERE lower(email)=?', [address]);
        if (existing && existing.enabled) {
            throw failure('ACCOUNT_ALREADY_EXISTS', 409);
        }

        const now = Date.now();
        // Check rate limiting on recent code requests
        const recentAttempts = DB.get(
            'SELECT COUNT(*) AS n FROM ava_owner_email_verifications WHERE linkId=? AND email=? AND createdAtMs>?',
            [link.id, address, now - 3600000]
        ).n;
        if (recentAttempts >= 10) {
            throw failure('IDENTITY_RATE_LIMITED', 429);
        }

        // Generate 6-digit code
        const code = String(crypto.randomInt(100000, 999999));
        const verificationId = crypto.randomUUID();
        const encryptedPassword = encryptSecret(rawPassword);
        const expiresAtMs = now + 15 * 60 * 1000; // 15 minutes TTL
        const resendAfterMs = now + 60 * 1000; // 60 seconds cooldown

        DB.run(
            `INSERT INTO ava_owner_email_verifications(
                id, linkId, email, displayName, passwordEncrypted, codeHash,
                attempts, resendAfterMs, expiresAtMs, createdAtMs
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
            [verificationId, link.id, address, name, encryptedPassword, hash(code), resendAfterMs, expiresAtMs, now]
        );

        try {
            await SystemMailer.sendVerificationCodeEmail({ to: address, code, displayName: name });
        } catch (error) {
            DB.run('DELETE FROM ava_owner_email_verifications WHERE id=?', [verificationId]);
            throw error;
        }

        return {
            verificationId,
            email: address,
            maskedEmail: maskEmail(address),
            resendAfterMs,
            expiresAtMs,
        };
    }

    async resendVerificationCode(token, { verificationId, email }) {
        this.ensureSchema();
        const link = Identity.validOwnerLink(token);
        const address = String(email || '').trim().toLowerCase();

        const row = DB.get(
            `SELECT * FROM ava_owner_email_verifications WHERE id=? AND linkId=? AND lower(email)=? AND verifiedAtMs IS NULL`,
            [verificationId, link.id, address]
        );
        if (!row) {
            throw failure('VERIFICATION_NOT_FOUND', 404);
        }

        const now = Date.now();
        if (now < row.resendAfterMs) {
            const waitSeconds = Math.ceil((row.resendAfterMs - now) / 1000);
            throw failure('RESEND_COOLDOWN', 429, { waitSeconds });
        }

        const newCode = String(crypto.randomInt(100000, 999999));
        const newExpiresAt = now + 15 * 60 * 1000;
        const newResendAfter = now + 60 * 1000;

        DB.run(
            `UPDATE ava_owner_email_verifications
             SET codeHash=?, attempts=0, expiresAtMs=?, resendAfterMs=?
             WHERE id=?`,
            [hash(newCode), newExpiresAt, newResendAfter, row.id]
        );

        try {
            await SystemMailer.sendVerificationCodeEmail({
                to: address, code: newCode, displayName: row.displayName,
            });
        } catch (error) {
            DB.run(`UPDATE ava_owner_email_verifications
                    SET codeHash=?, attempts=?, expiresAtMs=?, resendAfterMs=?
                    WHERE id=? AND codeHash=?`,
                [row.codeHash, row.attempts, row.expiresAtMs, row.resendAfterMs, row.id, hash(newCode)]);
            throw error;
        }

        return {
            success: true,
            resendAfterMs: newResendAfter,
            expiresAtMs: newExpiresAt,
        };
    }

    verifyCode(token, { verificationId, code }) {
        this.ensureSchema();
        const link = Identity.validOwnerLink(token);
        const cleanCode = String(code || '').trim();

        if (!/^\d{6}$/.test(cleanCode)) {
            throw failure('INVALID_VERIFICATION_CODE', 400);
        }

        const row = DB.get(
            `SELECT * FROM ava_owner_email_verifications WHERE id=? AND linkId=? AND verifiedAtMs IS NULL`,
            [verificationId, link.id]
        );
        if (!row) {
            throw failure('VERIFICATION_NOT_FOUND', 404);
        }

        const now = Date.now();
        if (now > row.expiresAtMs) {
            throw failure('VERIFICATION_CODE_EXPIRED', 400);
        }

        if (row.attempts >= 5) {
            throw failure('MAX_ATTEMPTS_EXCEEDED', 429);
        }

        if (hash(cleanCode) !== row.codeHash) {
            const nextAttempts = row.attempts + 1;
            DB.run(`UPDATE ava_owner_email_verifications SET attempts=? WHERE id=?`, [nextAttempts, row.id]);
            const attemptsLeft = Math.max(0, 5 - nextAttempts);
            if (attemptsLeft === 0) {
                throw failure('MAX_ATTEMPTS_EXCEEDED', 429, { attemptsLeft: 0 });
            }
            throw failure('INVALID_VERIFICATION_CODE', 400, { attemptsLeft });
        }

        const password = decryptSecret(row.passwordEncrypted);
        return {
            verificationId: row.id,
            email: row.email,
            displayName: row.displayName,
            password,
        };
    }

    finishEnrollment(invitationId, verificationId) {
        this.ensureSchema();
        return DB.db.transaction(() => {
            if (!Identity.finishOwnerInvitationUse(invitationId)) return false;
            const verification = DB.get('SELECT id FROM ava_owner_email_verifications WHERE id=?',
                [verificationId]);
            if (!verification) throw failure('VERIFICATION_NOT_FOUND', 404);
            // Keep the proof fields for an exact owner/email repair while
            // removing the password in this same transaction. Repeated calls
            // also scrub rows completed by the previous implementation.
            const changed = DB.run(`UPDATE ava_owner_email_verifications
                SET verifiedAtMs=COALESCE(verifiedAtMs,?),passwordEncrypted=''
                WHERE id=?`, [Date.now(), verificationId]);
            if (changed.changes !== 1) throw failure('VERIFICATION_NOT_FOUND', 404);
            return true;
        }).immediate();
    }
}

module.exports = new OwnerVerificationStore();
