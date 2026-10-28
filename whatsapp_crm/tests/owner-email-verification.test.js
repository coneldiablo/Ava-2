const express = require('express');
const axios = require('axios');
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const Sso = require('../src/services/identity/oidc.service');
const VerificationStore = require('../src/services/identity/owner-verification-store');
const SystemMailer = require('../src/services/identity/system-mailer.service');

process.env.SESSION_SECRET ||= 'owner-verification-test-key-not-for-production';

const admin = { userId: 'operator', platformRole: 'platform_admin' };

describe('Owner email verification flow', () => {
    it('scrubs ciphertext left by completed enrollments on a fresh database connection', () => {
        createTestDB();
        const link = Identity.createOwnerInvitationLink(admin, { label: 'Legacy Owner' });
        DB.db.exec(`CREATE TABLE ava_owner_email_verifications (
            id TEXT PRIMARY KEY,linkId TEXT NOT NULL,email TEXT NOT NULL,
            displayName TEXT NOT NULL DEFAULT '',passwordEncrypted TEXT NOT NULL,
            codeHash TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
            resendAfterMs INTEGER NOT NULL,expiresAtMs INTEGER NOT NULL,
            verifiedAtMs INTEGER,createdAtMs INTEGER NOT NULL)`);
        DB.run(`INSERT INTO ava_owner_email_verifications
            (id,linkId,email,passwordEncrypted,codeHash,resendAfterMs,expiresAtMs,verifiedAtMs,createdAtMs)
            VALUES (?,?,?,?,?,?,?,?,?)`,
        ['old', link.id, 'old@example.test', 'legacy-ciphertext', 'code-hash', 0, 0, 123, 100]);
        VerificationStore.ensureSchema();
        const row = DB.get('SELECT * FROM ava_owner_email_verifications WHERE id=?', ['old']);
        assert.strictEqual(row.passwordEncrypted, '');
        assert.strictEqual(row.verifiedAtMs, 123);
        assert.strictEqual(row.linkId, link.id);
        assert.strictEqual(row.email, 'old@example.test');
        assert.strictEqual(row.createdAtMs, 100);
    });

    it('does not acknowledge an unsent code or keep a usable verification after SMTP failure', async () => {
        createTestDB();
        const link = Identity.createOwnerInvitationLink(admin, { label: 'SMTP Failure' });
        const originalSend = SystemMailer.sendVerificationCodeEmail;
        SystemMailer.sendVerificationCodeEmail = async () => { throw new Error('private SMTP diagnostic'); };
        try {
            await assert.rejects(VerificationStore.initiateVerification(link.token, {
                email: 'unavailable@example.test', displayName: 'Owner', password: 'Correct-Password-1234',
            }));
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_owner_email_verifications').n, 0);
        } finally { SystemMailer.sendVerificationCodeEmail = originalSend; }
    });

    it('restores the prior code and cooldown if SMTP resend fails', async () => {
        createTestDB();
        const link = Identity.createOwnerInvitationLink(admin, { label: 'SMTP Resend Failure' });
        const originalSend = SystemMailer.sendVerificationCodeEmail;
        SystemMailer.sendVerificationCodeEmail = async () => ({ success: true });
        try {
            const issued = await VerificationStore.initiateVerification(link.token, {
                email: 'resend@example.test', displayName: 'Owner', password: 'Correct-Password-1234',
            });
            DB.run('UPDATE ava_owner_email_verifications SET resendAfterMs=? WHERE id=?',
                [Date.now() - 1, issued.verificationId]);
            const before = DB.get('SELECT codeHash, resendAfterMs, expiresAtMs FROM ava_owner_email_verifications WHERE id=?',
                [issued.verificationId]);
            SystemMailer.sendVerificationCodeEmail = async () => { throw new Error('SMTP unavailable'); };
            await assert.rejects(VerificationStore.resendVerificationCode(link.token, {
                verificationId: issued.verificationId, email: 'resend@example.test',
            }));
            const after = DB.get('SELECT codeHash, resendAfterMs, expiresAtMs FROM ava_owner_email_verifications WHERE id=?',
                [issued.verificationId]);
            assert.deepStrictEqual(after, before);
        } finally { SystemMailer.sendVerificationCodeEmail = originalSend; }
    });

    it('generates secure OTP, enforces attempt limits, resend cooldown and expiry', async () => {
        createTestDB();
        const link = Identity.createOwnerInvitationLink(admin, { label: 'Verification Test' });

        let capturedCode;
        const originalSend = SystemMailer.sendVerificationCodeEmail;
        SystemMailer.sendVerificationCodeEmail = async ({ code }) => {
            capturedCode = code;
            return { messageId: 'test-123' };
        };

        try {
            const pending = await VerificationStore.initiateVerification(link.token, {
                email: 'test.owner@meludtech.tech',
                displayName: 'Test Owner',
                password: 'Correct-Password-1234'
            });

            assert.ok(pending.verificationId);
            assert.strictEqual(pending.maskedEmail, 't****r@meludtech.tech');
            assert.strictEqual(typeof capturedCode, 'string');
            assert.strictEqual(capturedCode.length, 6);

            // Verification record in DB does not expose raw password or plain code
            const rawRow = DB.get('SELECT * FROM ava_owner_email_verifications WHERE id = ?', [pending.verificationId]);
            assert.strictEqual(rawRow.codeHash.length, 64);
            assert.ok(!rawRow.codeHash.includes(capturedCode));
            assert.ok(!rawRow.passwordEncrypted.includes('Correct-Password-1234'));

            // Attempt with wrong code
            assert.throws(() => {
                VerificationStore.verifyCode(link.token, {
                    verificationId: pending.verificationId,
                    code: '000000'
                });
            }, (err) => {
                assert.strictEqual(err.code, 'INVALID_VERIFICATION_CODE');
                assert.strictEqual(err.attemptsLeft, 4);
                return true;
            });

            // Resend cooldown enforced
            await assert.rejects(async () => {
                await VerificationStore.resendVerificationCode(link.token, {
                    verificationId: pending.verificationId,
                    email: 'test.owner@meludtech.tech'
                });
            }, (err) => {
                assert.strictEqual(err.code, 'RESEND_COOLDOWN');
                assert.ok(err.waitSeconds > 0);
                return true;
            });

            // Fast-forward cooldown to allow resend
            DB.run('UPDATE ava_owner_email_verifications SET resendAfterMs = ? WHERE id = ?', [
                Date.now() - 1000,
                pending.verificationId
            ]);

            const resent = await VerificationStore.resendVerificationCode(link.token, {
                verificationId: pending.verificationId,
                email: 'test.owner@meludtech.tech'
            });
            assert.strictEqual(resent.success, true);
            const newCode = capturedCode;
            assert.strictEqual(typeof newCode, 'string');
            assert.strictEqual(newCode.length, 6);

            // Exhaust remaining 5 attempts with wrong code
            for (let i = 0; i < 5; i++) {
                try {
                    VerificationStore.verifyCode(link.token, {
                        verificationId: pending.verificationId,
                        code: '999999'
                    });
                    assert.fail('Should have thrown');
                } catch (err) {
                    if (i === 4) {
                        assert.strictEqual(err.code, 'MAX_ATTEMPTS_EXCEEDED');
                    } else {
                        assert.strictEqual(err.code, 'INVALID_VERIFICATION_CODE');
                    }
                }
            }

            // Exceeded attempts blocks even with correct code
            assert.throws(() => {
                VerificationStore.verifyCode(link.token, {
                    verificationId: pending.verificationId,
                    code: newCode
                });
            }, { code: 'MAX_ATTEMPTS_EXCEEDED' });

        } finally {
            SystemMailer.sendVerificationCodeEmail = originalSend;
        }
    });

    it('correct code stays reusable until enrollment completes, then becomes consumed', async () => {
        createTestDB();
        const link = Identity.createOwnerInvitationLink(admin, { label: 'Consume Test' });

        let capturedCode;
        const originalSend = SystemMailer.sendVerificationCodeEmail;
        SystemMailer.sendVerificationCodeEmail = async ({ code }) => {
            capturedCode = code;
            return { messageId: 'test-123' };
        };

        try {
            const pending = await VerificationStore.initiateVerification(link.token, {
                email: 'valid.owner@meludtech.tech',
                displayName: 'Valid Owner',
                password: 'Ultra-Secure-Password-999'
            });

            const verified = VerificationStore.verifyCode(link.token, {
                verificationId: pending.verificationId,
                code: capturedCode
            });

            assert.strictEqual(verified.email, 'valid.owner@meludtech.tech');
            assert.strictEqual(verified.displayName, 'Valid Owner');
            assert.strictEqual(verified.password, 'Ultra-Secure-Password-999');
            assert.strictEqual(DB.get('SELECT verifiedAtMs FROM ava_owner_email_verifications WHERE id=?',
                [pending.verificationId]).verifiedAtMs, null);

            const use = Identity.beginOwnerInvitationUse(link.token, verified);
            assert.strictEqual(VerificationStore.finishEnrollment(use.invitationId, pending.verificationId), false);
            Identity.failOwnerInvitationUse(use.invitationId);
            const beforeRetry = DB.get('SELECT * FROM ava_owner_email_verifications WHERE id=?', [pending.verificationId]);
            assert.strictEqual(beforeRetry.verifiedAtMs, null);
            assert.ok(beforeRetry.passwordEncrypted.length > 0, 'a failed worker must leave the password available for retry');
            const retry = Identity.beginOwnerInvitationUse(link.token, verified);
            const claim = Identity.claimInvitation(retry.childToken);
            Identity.completeInvitation(claim, 'native-owner');
            assert.strictEqual(VerificationStore.finishEnrollment(retry.invitationId, pending.verificationId), true);
            assert.strictEqual(VerificationStore.finishEnrollment(retry.invitationId, pending.verificationId), true);
            const completed = DB.get('SELECT * FROM ava_owner_email_verifications WHERE id=?', [pending.verificationId]);
            assert.strictEqual(completed.passwordEncrypted, '');
            assert.ok(completed.verifiedAtMs);
            assert.strictEqual(completed.linkId, beforeRetry.linkId);
            assert.strictEqual(completed.email, beforeRetry.email);
            assert.strictEqual(completed.createdAtMs, beforeRetry.createdAtMs);
            assert.strictEqual(completed.codeHash, beforeRetry.codeHash);

            // The previous implementation could leave ciphertext in a row
            // already marked complete. Reconciliation scrubs that row too.
            DB.run('UPDATE ava_owner_email_verifications SET passwordEncrypted=? WHERE id=?',
                ['legacy-ciphertext', pending.verificationId]);
            assert.strictEqual(VerificationStore.finishEnrollment(retry.invitationId, pending.verificationId), true);
            assert.strictEqual(DB.get('SELECT passwordEncrypted FROM ava_owner_email_verifications WHERE id=?',
                [pending.verificationId]).passwordEncrypted, '');

            // Cannot verify twice
            assert.throws(() => {
                VerificationStore.verifyCode(link.token, {
                    verificationId: pending.verificationId,
                    code: capturedCode
                });
            }, { code: 'VERIFICATION_NOT_FOUND' });
        } finally {
            SystemMailer.sendVerificationCodeEmail = originalSend;
        }
    });

    it('handles verification through identity HTTP routes with system mailer', async () => {
        createTestDB();
        const priorUrl = process.env.WHATSAPP_CRM_PUBLIC_URL;
        const priorAuth = Auth.config.enabled;
        const priorGetSession = Auth.getSession;
        const priorSso = Sso.enabled;
        const priorPost = axios.post;

        process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
        Auth.config.enabled = true;
        Auth.getSession = () => admin;
        Sso.enabled = () => true;

        const sentEmails = [];
        const originalSendVerification = SystemMailer.sendVerificationCodeEmail;
        SystemMailer.sendVerificationCodeEmail = async (params) => {
            sentEmails.push(params);
            return { messageId: 'mock-msg-123' };
        };

        let workerCalls = 0;
        let failAfterCommit = false;
        axios.post = async (_url, body) => {
            workerCalls++;
            if (workerCalls === 1) throw new Error('worker unavailable');
            const claim = Identity.claimInvitation(body.token);
            Identity.completeInvitation(claim, `native-${claim.userId}`);
            if (failAfterCommit) throw new Error('worker reply lost');
            return { data: { success: true } };
        };

        const app = express();
        app.set('trust proxy', true);
        app.use(express.json());
        app.use('/api', require('../src/routes/identity.routes'));
        const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
        const base = `http://127.0.0.1:${server.address().port}`;

        const post = (path, body, origin = 'https://ava.example.test') => fetch(`${base}/api${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: origin,
                'X-Forwarded-For': '198.51.100.25' },
            body: JSON.stringify(body),
        });

        try {
            // 1. Create owner link
            const created = await (await post('/owner-invitations', { label: 'Route Test' })).json();
            const token = new URL(created.url).hash.slice(1);

            const bypass = await post('/owner-invitations/redeem', {
                token, email: 'invited.boss@meludtech.tech', password: 'Boss-Password-123'
            });
            assert.strictEqual(bypass.status, 400);
            assert.strictEqual((await bypass.json()).error_code, 'VERIFICATION_REQUIRED');
            assert.strictEqual(workerCalls, 0);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_users').n, 0);

            // 2. Request verification code (Step 1)
            const reqRes = await post('/owner-invitations/request-verification', {
                token,
                email: 'invited.boss@meludtech.tech',
                displayName: 'Invited Boss',
                password: 'Boss-Password-123'
            });
            assert.strictEqual(reqRes.status, 200);
            const reqData = await reqRes.json();
            assert.strictEqual(reqData.success, true);
            assert.ok(reqData.verification_id);
            assert.strictEqual(reqData.masked_email, 'i****s@meludtech.tech');
            assert.strictEqual(sentEmails.length, 1);
            assert.strictEqual(sentEmails[0].to, 'invited.boss@meludtech.tech');

            const missingCode = await post('/owner-invitations/redeem', {
                token, verificationId: reqData.verification_id,
                email: 'invited.boss@meludtech.tech', password: 'Boss-Password-123',
            });
            assert.strictEqual(missingCode.status, 400);
            assert.strictEqual((await missingCode.json()).error_code, 'INVALID_VERIFICATION_CODE');
            assert.strictEqual(workerCalls, 0);

            const issuedCode = sentEmails[0].code;

            // 3. Resend code too early -> 429 RESEND_COOLDOWN
            const earlyResend = await post('/owner-invitations/resend-code', {
                token,
                verificationId: reqData.verification_id,
                email: 'invited.boss@meludtech.tech'
            });
            assert.strictEqual(earlyResend.status, 429);
            const earlyData = await earlyResend.json();
            assert.strictEqual(earlyData.error_code, 'RESEND_COOLDOWN');
            assert.ok(earlyData.retry_after_seconds > 0);

            // 4. Submit wrong OTP code in redeem -> 400 INVALID_VERIFICATION_CODE
            const badRedeem = await post('/owner-invitations/redeem', {
                token,
                verificationId: reqData.verification_id,
                code: '000000'
            });
            assert.strictEqual(badRedeem.status, 400);
            const badRedeemData = await badRedeem.json();
            assert.strictEqual(badRedeemData.error_code, 'INVALID_VERIFICATION_CODE');
            assert.strictEqual(badRedeemData.attempts_remaining, 4);

            // 5. A worker failure leaves the code valid and a single disabled user for retry.
            const failedRedeem = await post('/owner-invitations/redeem', {
                token,
                verificationId: reqData.verification_id,
                code: issuedCode
            });
            assert.strictEqual(failedRedeem.status, 503);
            assert.strictEqual(DB.get('SELECT verifiedAtMs FROM ava_owner_email_verifications WHERE id=?',
                [reqData.verification_id]).verifiedAtMs, null);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_users').n, 1);
            const failedUserId = DB.get('SELECT userId FROM ava_owner_invitation_uses').userId;

            // 6. Retrying the same verified code reuses that user and succeeds.
            const goodRedeem = await post('/owner-invitations/redeem', {
                token, verificationId: reqData.verification_id, code: issuedCode
            });
            assert.strictEqual(goodRedeem.status, 200);
            const goodRedeemData = await goodRedeem.json();
            assert.strictEqual(goodRedeemData.success, true);
            assert.strictEqual(workerCalls, 2);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_users').n, 1);
            assert.deepStrictEqual(DB.all('SELECT DISTINCT userId FROM ava_owner_invitation_uses').map(row => row.userId),
                [failedUserId]);
            assert.ok(DB.get('SELECT verifiedAtMs FROM ava_owner_email_verifications WHERE id=?',
                [reqData.verification_id]).verifiedAtMs);
            assert.strictEqual(DB.get('SELECT passwordEncrypted FROM ava_owner_email_verifications WHERE id=?',
                [reqData.verification_id]).passwordEncrypted, '');

            // 7. Verification entry cannot be re-used
            const reuseRedeem = await post('/owner-invitations/redeem', {
                token,
                verificationId: reqData.verification_id,
                code: issuedCode
            });
            assert.strictEqual(reuseRedeem.status, 404);
            const reuseData = await reuseRedeem.json();
            assert.strictEqual(reuseData.error_code, 'VERIFICATION_NOT_FOUND');

            // A lost HTTP response after the worker commits is reconciled as success.
            const secondLink = await (await post('/owner-invitations', { label: 'Lost Reply' })).json();
            const secondToken = new URL(secondLink.url).hash.slice(1);
            const secondRequest = await (await post('/owner-invitations/request-verification', {
                token: secondToken, email: 'lost.reply@example.test', displayName: 'Lost Reply',
                password: 'Another-Password-123',
            })).json();
            const secondCode = sentEmails.at(-1).code;
            failAfterCommit = true;
            const reconciled = await post('/owner-invitations/redeem', {
                token: secondToken, verificationId: secondRequest.verification_id, code: secondCode,
            });
            assert.strictEqual(reconciled.status, 200);
            const reconciledData = await reconciled.json();
            assert.strictEqual(reconciledData.success, true);
            assert.match(reconciledData.user_id, /^[a-f0-9-]{36}$/);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_users WHERE email=?',
                ['lost.reply@example.test']).n, 1);
            assert.ok(DB.get('SELECT verifiedAtMs FROM ava_owner_email_verifications WHERE id=?',
                [secondRequest.verification_id]).verifiedAtMs);
            assert.strictEqual(DB.get('SELECT passwordEncrypted FROM ava_owner_email_verifications WHERE id=?',
                [secondRequest.verification_id]).passwordEncrypted, '');
            assert.strictEqual((await post('/owner-invitations/redeem', {
                token: secondToken, verificationId: secondRequest.verification_id, code: secondCode,
            })).status, 404);
        } finally {
            SystemMailer.sendVerificationCodeEmail = originalSendVerification;
            await new Promise(resolve => server.close(resolve));
            if (priorUrl === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL; else process.env.WHATSAPP_CRM_PUBLIC_URL = priorUrl;
            Auth.config.enabled = priorAuth;
            Auth.getSession = priorGetSession;
            Sso.enabled = priorSso;
            axios.post = priorPost;
        }
    });
});
