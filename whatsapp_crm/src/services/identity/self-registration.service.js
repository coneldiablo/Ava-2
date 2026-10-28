'use strict';
const crypto = require('crypto');
const axios = require('axios');
const DB = require('../database.service');
const Identity = require('./identity-store');
const Mailer = require('./system-mailer.service');
const Provisioning = require('../provisioning/business-provisioning-store.service');
const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const accepted = (verificationId, email, remaining = 900000) => ({ success: true, status: 'verification_requested',
    ...(verificationId ? { verification_id: verificationId, masked_email: email.replace(/^(.).*(@.*)$/, '$1***$2') } : {}),
    resend_after_ms: 60000, expires_in_ms: remaining,
    message: 'Введите код из письма. Если аккаунт уже есть, после подтверждения поможем войти или восстановить доступ.' });
const normalizeEmail = email => typeof email === 'string' ? email.trim().toLowerCase() : '';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const codeHash = (id, code) => crypto.createHmac('sha256', key()).update(`${id}:${code}`).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
function validatePassword(password, email) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 256
        || password.toLowerCase() === email.toLowerCase()) throw fail('PASSWORD_POLICY');
}
function key() {
    const secret = process.env.SESSION_SECRET || '';
    if (secret.length < 32) throw fail('REGISTRATION_UNAVAILABLE', 503);
    return crypto.createHash('sha256').update(`ava:registration:v1:${secret}`).digest();
}
function seal(value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    cipher.setAAD(Buffer.from('ava:registration:v1'));
    const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes].map(item => item.toString('base64url')).join('.');
}
function open(value) {
    const [iv, tag, bytes] = value.split('.').map(item => Buffer.from(item, 'base64url'));
    const cipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    cipher.setAAD(Buffer.from('ava:registration:v1'));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(bytes), cipher.final()]).toString('utf8');
}

class SelfRegistration {
    enabled() { return process.env.AVA_SELF_REGISTRATION_ENABLED === 'true'
        && process.env.AVA_CUSTOMER_ACCESS_ENABLED === 'true'; }
    ensureSchema({ cleanup = true } = {}) {
        Identity.ensureSchema();
        DB.db.exec(`CREATE TABLE IF NOT EXISTS ava_self_registrations (
            id TEXT PRIMARY KEY, tokenHash TEXT NOT NULL UNIQUE, codeHash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, email TEXT NOT NULL,
            displayName TEXT NOT NULL, businessName TEXT NOT NULL, passwordEncrypted TEXT NOT NULL,
            state TEXT NOT NULL, createdAtMs INTEGER NOT NULL, expiresAtMs INTEGER NOT NULL,
            resendAfterMs INTEGER NOT NULL, sendCount INTEGER NOT NULL DEFAULT 1,
            verifiedAtMs INTEGER, userId TEXT REFERENCES ava_users(id),
            invitationId TEXT REFERENCES ava_invitations(id), childTokenEncrypted TEXT,
            businessId INTEGER REFERENCES instances(id));
            CREATE INDEX IF NOT EXISTS ava_self_registration_email ON ava_self_registrations(email,createdAtMs);
            CREATE TABLE IF NOT EXISTS ava_registration_requests (
                id TEXT PRIMARY KEY,emailHash TEXT NOT NULL,ipHash TEXT NOT NULL,createdAtMs INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS ava_registration_requests_time ON ava_registration_requests(createdAtMs);`);
        if (!DB.all('PRAGMA table_info(ava_self_registrations)').some(column => column.name === 'flow')) DB.db.exec("ALTER TABLE ava_self_registrations ADD COLUMN flow TEXT NOT NULL DEFAULT 'registration'");
        if (cleanup) DB.run(`UPDATE ava_self_registrations SET passwordEncrypted='',childTokenEncrypted=NULL
            WHERE expiresAtMs<=? OR state='completed'`, [Date.now()]);
    }
    limit(email, rateLimitKey) {
        const now = Date.now();
        DB.db.transaction(() => {
            DB.run('DELETE FROM ava_registration_requests WHERE createdAtMs<=?', [now - 3600000]);
            const emailHash = crypto.createHmac('sha256', key()).update(`limit:email:${email}`).digest('hex');
            const ipHash = crypto.createHmac('sha256', key()).update(`limit:source:${String(rateLimitKey || 'unknown').slice(0,255)}`).digest('hex');
            if (DB.get('SELECT COUNT(*) n FROM ava_registration_requests WHERE emailHash=?', [emailHash]).n >= 5
                || DB.get('SELECT COUNT(*) n FROM ava_registration_requests WHERE ipHash=?', [ipHash]).n >= 30) {
                throw fail('IDENTITY_RATE_LIMITED', 429);
            }
            DB.run('INSERT INTO ava_registration_requests VALUES (?,?,?,?)', [crypto.randomUUID(), emailHash, ipHash, now]);
        }).immediate();
    }
    async start(input = {}, rateLimitKey) {
        if (!this.enabled()) throw fail('REGISTRATION_UNAVAILABLE', 503);
        this.ensureSchema();
        const email = normalizeEmail(input.email);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw fail('EMAIL_INVALID');
        validatePassword(input.password, email);
        const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
        const businessName = typeof input.businessName === 'string' ? input.businessName.trim() : '';
        if (!displayName || displayName.length > 120 || !businessName || businessName.length > 120) throw fail('REGISTRATION_INPUT_INVALID');
        this.limit(email, rateLimitKey);
        const token = random(), id = crypto.randomUUID(), now = Date.now();
        const code = String(crypto.randomInt(100000, 1000000));
        const passwordEncrypted = seal(input.password);
        const inserted = DB.db.transaction(() => {
            // Only a proven, never-activated orphan of THIS registration path
            // may be resumed after expiry. Invited/legacy/completed accounts
            // remain reserved; email alone never selects a live identity.
            const matches = DB.all('SELECT * FROM ava_users WHERE lower(email)=? LIMIT 2', [email]);
            const existing = matches[0];
            let resumeUserId = null, flow = 'registration';
            if (existing) {
                const prior = DB.get(`SELECT * FROM ava_self_registrations WHERE userId=?
                    AND expiresAtMs<=? AND state!='completed' AND businessId IS NULL ORDER BY createdAtMs DESC LIMIT 1`, [existing.id, now]);
                if (matches.length !== 1 || !prior || existing.enabled || existing.platformRole !== 'customer' || existing.businessQuota !== 1
                    || DB.get('SELECT userId FROM ava_business_memberships WHERE userId=?', [existing.id])
                    || DB.get("SELECT id FROM ava_invitations WHERE userId=? AND (createdBy NOT LIKE 'self-registration:%' OR businessId IS NOT NULL OR role!='hotel_owner')", [existing.id])
                    || DB.get('SELECT id FROM ava_owner_invitation_uses WHERE userId=?', [existing.id])) flow = 'access';
                if (flow === 'registration') {
                    resumeUserId = existing.id;
                    DB.run("UPDATE ava_self_registrations SET state='superseded',passwordEncrypted='',childTokenEncrypted=NULL WHERE id=?", [prior.id]);
                // Retain an old worker's lease as an inter-attempt barrier.
                // The old worker must finish or expire before a new claim.
                DB.run("UPDATE ava_invitations SET state='revoked' WHERE id=? AND state IN ('pending','redeeming')", [prior.invitationId]);
                }
            }
            const active = DB.get('SELECT * FROM ava_self_registrations WHERE email=? AND expiresAtMs>?', [email, now]);
            if (active && (active.userId || active.resendAfterMs > now)) throw fail('RESEND_COOLDOWN', 429);
            if (active) DB.run("UPDATE ava_self_registrations SET expiresAtMs=?,passwordEncrypted='',childTokenEncrypted=NULL WHERE id=?", [now, active.id]);
            DB.run(`INSERT INTO ava_self_registrations
                (id,tokenHash,codeHash,email,displayName,businessName,passwordEncrypted,state,createdAtMs,expiresAtMs,resendAfterMs,userId,flow)
                VALUES (?,?,?,?,?,?,?,'sending',?,?,?,?,?)`,
            [id, hash(token), codeHash(id, code), email, displayName, businessName, flow === 'access' ? '' : passwordEncrypted, now, now + 900000, now + 60000, resumeUserId, flow]);
            return true;
        }).immediate();
        if (inserted) {
            try { await this.deliver(id, code); }
            catch (error) {
                DB.run("UPDATE ava_self_registrations SET expiresAtMs=?,passwordEncrypted='' WHERE id=?", [Date.now(), id]);
                throw error;
            }
        }
        return accepted(token, email);
    }
    async deliver(id, code) {
        const row = DB.get('SELECT * FROM ava_self_registrations WHERE id=?', [id]);
        try {
            await Mailer.sendVerificationCodeEmail({ to: row.email, displayName: row.displayName, code });
            DB.run("UPDATE ava_self_registrations SET state='ready' WHERE id=? AND codeHash=? AND state='sending'",
                [id, codeHash(id, code)]);
        } catch (_) {
            DB.run("UPDATE ava_self_registrations SET state='delivery_failed' WHERE id=? AND codeHash=? AND state='sending'",
                [id, codeHash(id, code)]);
            throw fail('REGISTRATION_EMAIL_UNAVAILABLE', 503);
        }
    }
    async resend({ verification_id: verificationId } = {}, rateLimitKey) {
        if (!this.enabled()) throw fail('REGISTRATION_UNAVAILABLE', 503);
        this.ensureSchema();
        if (typeof verificationId !== 'string' || !/^[\w-]{43}$/.test(verificationId)) throw fail('REGISTRATION_PROOF_INVALID');
        const now = Date.now(); let code = String(crypto.randomInt(100000, 1000000));
        // Capability lookup keeps resend independent of email/account enumeration.
        const row = DB.get('SELECT * FROM ava_self_registrations WHERE tokenHash=?', [hash(verificationId)]);
        this.limit(row?.email || verificationId, rateLimitKey);
        if (!row) throw fail('REGISTRATION_PROOF_INVALID');
        while (codeHash(row.id, code) === row.codeHash) code = String(crypto.randomInt(100000, 1000000));
        const remaining = row.expiresAtMs - now;
        DB.db.transaction(() => {
            const current = DB.get('SELECT * FROM ava_self_registrations WHERE id=?', [row.id]);
            if (remaining <= 0) throw fail('VERIFICATION_CODE_EXPIRED');
            if (current.state === 'existing_verified' || current.verifiedAtMs !== null) throw fail('REGISTRATION_IN_PROGRESS', 409);
            if (now < current.resendAfterMs) throw fail('RESEND_COOLDOWN', 429);
            if (current.sendCount >= 3 || current.attempts >= 5) throw fail('MAX_ATTEMPTS_EXCEEDED', 429);
            DB.run("UPDATE ava_self_registrations SET codeHash=?,state='sending',resendAfterMs=?,sendCount=sendCount+1 WHERE id=?",
                [codeHash(row.id, code), now + 60000, row.id]);
        }).immediate();
        await this.deliver(row.id, code);
        return accepted(verificationId, row.email, remaining);
    }
    status({ verification_id: verificationId } = {}) {
        if (!this.enabled()) throw fail('REGISTRATION_UNAVAILABLE', 503);
        this.ensureSchema();
        if (typeof verificationId !== 'string' || !/^[\w-]{43}$/.test(verificationId)) throw fail('REGISTRATION_PROOF_INVALID');
        const row = DB.get('SELECT * FROM ava_self_registrations WHERE tokenHash=?', [hash(verificationId)]);
        if (!row) throw fail('REGISTRATION_PROOF_INVALID');
        const remaining = Math.max(0, row.expiresAtMs - Date.now());
        return { ...accepted(verificationId, row.email, remaining),
            status: remaining === 0 ? 'expired' : row.state === 'completed' ? 'completed' : row.state === 'existing_verified' ? 'existing_account' : row.state === 'delivery_failed' ? 'delivery_failed' : row.state === 'enrolling' ? 'processing' : 'verification_requested',
            resend_after_ms: Math.max(0, row.resendAfterMs - Date.now()),
            ...(remaining > 0 && row.state === 'completed' && row.userId ? { login_url: `/api/auth/sso/start?enrolled_user=${row.userId}` } : {}),
            ...(row.attempts >= 5 ? { status: 'locked' } : {}) };
    }
    checkCode(verificationId, code) {
        this.ensureSchema();
        if (typeof verificationId !== 'string' || !/^[\w-]{43}$/.test(verificationId)) throw fail('REGISTRATION_PROOF_INVALID');
        // Commit failed-attempt counts before throwing; a transaction rollback
        // must never restore the attacker's remaining guesses.
        const error = DB.db.transaction(() => {
            const row = DB.get('SELECT * FROM ava_self_registrations WHERE tokenHash=?', [hash(verificationId)]);
            if (!row) return fail('REGISTRATION_PROOF_INVALID');
            if (row.expiresAtMs <= Date.now()) return fail('VERIFICATION_CODE_EXPIRED');
            if (row.state === 'sending' || row.state === 'delivery_failed') return fail('REGISTRATION_EMAIL_UNAVAILABLE', 503);
            if (row.attempts >= 5) return fail('MAX_ATTEMPTS_EXCEEDED', 429);
            if (typeof code !== 'string' || !/^\d{6}$/.test(code)
                || !crypto.timingSafeEqual(Buffer.from(codeHash(row.id, code)), Buffer.from(row.codeHash))) {
                DB.run('UPDATE ava_self_registrations SET attempts=attempts+1 WHERE id=?', [row.id]);
                return fail(row.attempts === 4 ? 'MAX_ATTEMPTS_EXCEEDED' : 'INVALID_VERIFICATION_CODE', row.attempts === 4 ? 429 : 400);
            }
            return null;
        }).immediate();
        if (error) throw error;
    }
    proofForInvitation(invitation) {
        this.ensureSchema();
        if (!String(invitation.createdBy).startsWith('self-registration:')) return null;
        const row = DB.get(`SELECT r.* FROM ava_self_registrations r JOIN ava_users u ON u.id=r.userId
            WHERE r.id=? AND r.invitationId=? AND r.userId=? AND lower(u.email)=r.email
            AND r.verifiedAtMs IS NOT NULL AND r.verifiedAtMs<=? AND r.expiresAtMs>?
            AND r.state='enrolling' AND u.enabled=0`,
        [invitation.createdBy.slice('self-registration:'.length), invitation.id, invitation.userId, Date.now(), Date.now()]);
        if (!row) throw fail('INVITATION_LEASE_LOST', 409);
        return row;
    }
    prepare(token) {
        if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) throw fail('REGISTRATION_PROOF_INVALID');
        this.ensureSchema();
        return DB.db.transaction(() => {
            const row = DB.get('SELECT * FROM ava_self_registrations WHERE tokenHash=? AND expiresAtMs>?', [hash(token), Date.now()]);
            if (!row) throw fail('REGISTRATION_PROOF_INVALID');
            if (row.state === 'completed') return row;
            if (!['ready','enrolling'].includes(row.state)) throw fail('REGISTRATION_EMAIL_UNAVAILABLE', 503);
            if (!row.userId) {
                if (DB.get('SELECT id FROM ava_users WHERE lower(email)=?', [row.email])) throw fail('ACCOUNT_ALREADY_EXISTS', 409);
                row.userId = crypto.randomUUID();
                DB.run('INSERT INTO ava_users(id,email,displayName,businessQuota,enabled) VALUES (?,?,?,1,0)',
                    [row.userId, row.email, row.displayName]);
            }
            if (row.verifiedAtMs === null) DB.run("UPDATE ava_self_registrations SET userId=?,verifiedAtMs=?,state='enrolling' WHERE id=?", [row.userId, Date.now(), row.id]);
            const user = DB.get('SELECT * FROM ava_users WHERE id=?', [row.userId]);
            const invitation = row.invitationId && DB.get('SELECT * FROM ava_invitations WHERE id=?', [row.invitationId]);
            if (invitation?.state === 'consumed' && user?.enabled && user.subject) return row;
            if (!user || user.enabled || user.email.toLowerCase() !== row.email
                || DB.get("SELECT id FROM ava_identity_outbox WHERE userId=? AND state!='done'", [row.userId])) throw fail('REGISTRATION_RETRY_PENDING', 409);
            if (DB.get('SELECT id FROM ava_invitations WHERE userId=? AND leaseToken IS NOT NULL',
                [row.userId])) throw fail('REGISTRATION_IN_PROGRESS', 409);
            if (!invitation || invitation.state === 'revoked' || invitation.expiresAt <= Date.now()) {
                row.invitationId = crypto.randomUUID();
                const childToken = random();
                row.childTokenEncrypted = seal(childToken);
                DB.run('INSERT INTO ava_invitations(id,tokenHash,userId,businessId,role,expiresAt,createdBy) VALUES (?,?,?,NULL,?,?,?)',
                    [row.invitationId, hash(childToken), row.userId, 'hotel_owner', Math.min(row.expiresAtMs, Date.now() + 120000), `self-registration:${row.id}`]);
                DB.run('UPDATE ava_self_registrations SET invitationId=?,childTokenEncrypted=? WHERE id=?',
                    [row.invitationId, row.childTokenEncrypted, row.id]);
            }
            return row;
        }).immediate();
    }
    finishIdentityEnrollment(invitation, subject) {
        const row = DB.get("SELECT * FROM ava_self_registrations WHERE id=? AND invitationId=? AND userId=? AND state='enrolling'", [invitation.registrationId, invitation.id, invitation.userId]);
        if (!row || Identity.actor(row.userId).subject !== subject) throw fail('REGISTRATION_RETRY_PENDING', 503);
        const result = Provisioning.createBusinessAtomic({ name: row.businessName, businessType: 'standard' },
            { ownerUserId: row.userId, idempotencyKey: `self-registration:${row.id}` });
        DB.run("UPDATE ava_self_registrations SET state='completed',businessId=?,passwordEncrypted='',childTokenEncrypted=NULL WHERE id=?", [result.instance.id, row.id]);
    }
    async verify({ verification_id: token, code, password: correctedPassword } = {}, { redeem = async (childToken, password) => axios.post('http://provisioning_worker:3900/invitations/redeem',
        { token: childToken, password }, { headers: { Authorization: `Bearer ${process.env.AVA_IDENTITY_BROKER_TOKEN || ''}` },
            timeout: 55000, maxRedirects: 0, proxy: false, maxContentLength: 4096 }) } = {}) {
        if (!this.enabled()) throw fail('REGISTRATION_UNAVAILABLE', 503);
        this.checkCode(token, code);
        const access = DB.get('SELECT flow FROM ava_self_registrations WHERE tokenHash=?', [hash(token)]);
        if (access?.flow === 'access') {
            DB.run("UPDATE ava_self_registrations SET state='existing_verified',verifiedAtMs=COALESCE(verifiedAtMs,?),passwordEncrypted='' WHERE tokenHash=?", [Date.now(), hash(token)]);
            // Email possession reveals the next step, never grants a session, resets
            // a password or binds the supplied password to another person's user.
            return { success: true, status: 'existing_account', next_action: 'sign_in_or_recover',
                login_url: '/api/auth/sso/start', recovery_url: '/forgot-password' };
        }
        if (correctedPassword !== undefined) DB.db.transaction(() => {
            const current = DB.get('SELECT * FROM ava_self_registrations WHERE tokenHash=?', [hash(token)]);
            const invitation = current.invitationId && DB.get('SELECT * FROM ava_invitations WHERE id=?', [current.invitationId]);
            // An exact retry can still carry the password after the successful
            // response was lost. Completion receipts never validate or reset it.
            if (current.state === 'completed' || invitation?.state === 'consumed') return;
            validatePassword(correctedPassword, current.email);
            if (invitation?.leaseToken) throw fail('REGISTRATION_IN_PROGRESS', 409);
            DB.run('UPDATE ava_self_registrations SET passwordEncrypted=? WHERE id=?', [seal(correctedPassword), current.id]);
        }).immediate();
        const row = this.prepare(token);
        if (row.state !== 'completed') {
            const invitation = DB.get('SELECT state FROM ava_invitations WHERE id=?', [row.invitationId]);
            if (invitation?.state !== 'consumed') {
                if (!row.passwordEncrypted) throw fail('PASSWORD_POLICY');
                try { await redeem(open(row.childTokenEncrypted), open(row.passwordEncrypted)); }
                catch (error) {
                    this.ensureSchema();
                    // A lost HTTP reply after the worker commit must not create/reset again.
                    if (DB.get('SELECT state FROM ava_invitations WHERE id=?', [row.invitationId])?.state !== 'consumed') {
                        if (error?.response?.data?.error === 'PASSWORD_POLICY') {
                            DB.run("UPDATE ava_self_registrations SET passwordEncrypted='' WHERE id=?", [row.id]);
                            throw fail('PASSWORD_POLICY');
                        }
                        throw fail('REGISTRATION_RETRY_PENDING', 503);
                    }
                }
            }
        }
        return DB.db.transaction(() => {
            const current = DB.get('SELECT * FROM ava_self_registrations WHERE id=?', [row.id]);
            const user = Identity.actor(current.userId);
            if (user.email.toLowerCase() !== current.email || !user.subject
                || DB.get('SELECT state FROM ava_invitations WHERE id=?', [current.invitationId])?.state !== 'consumed') throw fail('REGISTRATION_RETRY_PENDING', 503);
            const result = Provisioning.createBusinessAtomic({ name: current.businessName, businessType: 'standard' },
                { ownerUserId: current.userId, idempotencyKey: `self-registration:${current.id}` });
            DB.run("UPDATE ava_self_registrations SET state='completed',businessId=?,passwordEncrypted='',childTokenEncrypted=NULL WHERE id=?",
                [result.instance.id, current.id]);
            return { success: true, status: 'completed', user_id: current.userId, business_id: result.instance.id,
                login_url: `/api/auth/sso/start?enrolled_user=${current.userId}`,
                provisioning: Provisioning.getProvisioningStatus(result.instance.id) };
        }).immediate();
    }
}
module.exports = new SelfRegistration();
