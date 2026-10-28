'use strict';
const express = require('express');
const axios = require('axios');
const Auth = require('../services/auth.service');
const Identity = require('../services/identity/identity-store');
const Sso = require('../services/identity/oidc.service');
const crypto = require('crypto');
const Logger = require('../utils/logger');
const { invitationFailure } = require('../services/identity/invitation-errors');
const OwnerVerificationStore = require('../services/identity/owner-verification-store');
const TeamVerification = require('../services/identity/team-verification-store');
const TeamEnrollment = require('../services/identity/customer-access');
const { getPublicUrl } = require('../services/identity/public-url');
const Registration = require('../services/identity/self-registration.service');
const PasswordRecovery = require('../services/identity/password-recovery.service');
const router = express.Router();
const flowCookie = 'ava_oidc_flow';
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth/sso', maxAge: 600000 };
const attempts = new Map();
function publicLimit(req, res, next) {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.expires <= now) attempts.delete(key);
    const backchannel = req.path === '/auth/sso/backchannel-logout';
    const key = `${backchannel ? 'backchannel' : 'public'}:${req.ip || req.socket.remoteAddress}`;
    const current = attempts.get(key) || { count: 0, expires: now + 60000 };
    if (current.count >= (backchannel ? 300 : 15) || (!attempts.has(key) && attempts.size >= 10000)) {
        res.setHeader('Retry-After', '60');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(429).json(req.path.startsWith('/public/identity/')
            ? { success: false, error_code: 'IDENTITY_RATE_LIMITED', error: 'Повторите через минуту.', request_id: crypto.randomUUID() }
            : { error: 'Повторите через минуту.' });
    }
    current.count++;
    attempts.set(key, current);
    next();
}
function operator(req, res, next) {
    try {
        if (!req.auth || req.headers.origin !== getPublicUrl().origin) return res.sendStatus(403);
        req.identityActor = req.auth.userId ? req.auth : { platformRole: 'platform_admin', userId: 'break-glass' };
        Identity.requirePlatformAdmin(req.identityActor);
        next();
    } catch (_) { res.sendStatus(403); }
}
function operatorRead(req, res, next) {
    try {
        if (!req.auth) return res.sendStatus(403);
        req.identityActor = req.auth.userId ? req.auth : { platformRole: 'platform_admin', userId: 'break-glass' };
        Identity.requirePlatformAdmin(req.identityActor);
        next();
    } catch (_) { res.sendStatus(403); }
}

router.get('/auth/config', (_req, res) => res.json({ sso_enabled: Sso.enabled(), invitation_required: true }));
router.get('/public/identity/config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, sso_enabled: Sso.enabled(), registration_enabled: Registration.enabled(),
        recovery_enabled: Sso.enabled(), invitation_required: !Registration.enabled(),
        minPasswordLength: 12, maxPasswordLength: 256, password_not_email: true, verification_method: 'email_code' });
});
const registrationErrors = {
    EMAIL_INVALID: 'Укажите корректную почту.', PASSWORD_POLICY: 'Пароль должен содержать от 12 до 256 символов и не совпадать с почтой или именем пользователя.',
    REGISTRATION_INPUT_INVALID: 'Укажите имя и название бизнеса.', INVALID_VERIFICATION_CODE: 'Неверный код подтверждения.',
    REGISTRATION_PROOF_INVALID: 'Начните регистрацию заново.', VERIFICATION_CODE_EXPIRED: 'Срок действия кода истёк.',
    IDENTITY_RATE_LIMITED: 'Слишком много запросов. Повторите позже.', RESEND_COOLDOWN: 'Повторите отправку через минуту.',
    MAX_ATTEMPTS_EXCEEDED: 'Лимит попыток исчерпан. Начните регистрацию заново после истечения кода.',
    ACCOUNT_ALREADY_EXISTS: 'Для этой почты используйте вход или восстановление пароля.',
    REGISTRATION_IN_PROGRESS: 'Регистрация ещё обрабатывается. Повторите подтверждение позже.',
    REGISTRATION_RETRY_PENDING: 'Регистрация ещё не завершена. Повторите подтверждение позже.',
    REGISTRATION_UNAVAILABLE: 'Регистрация временно недоступна.',
    REGISTRATION_EMAIL_UNAVAILABLE: 'Не удалось отправить код. Повторите запрос позже.',
    IDENTITY_ORIGIN_REQUIRED: 'Откройте страницу AVA и повторите запрос.',
};
function publicIdentityError(res, error) {
    const code = Object.hasOwn(registrationErrors, error?.code) ? error.code : 'REGISTRATION_UNAVAILABLE';
    const status = code === 'REGISTRATION_UNAVAILABLE' ? 503 : code === 'IDENTITY_ORIGIN_REQUIRED' ? 403 : (error.statusCode || 400);
    if (status === 429 || code === 'REGISTRATION_RETRY_PENDING' || code === 'REGISTRATION_IN_PROGRESS') res.setHeader('Retry-After', '60');
    return res.status(status).json({ success: false, error_code: code, error: registrationErrors[code], request_id: crypto.randomUUID() });
}
for (const [path, action] of [
    ['registration/status', req => Registration.status(req.body || {})],
    ['registration/start', req => Registration.start(req.body || {}, req.ip)],
    ['registration/resend', req => Registration.resend(req.body || {}, req.ip)],
    ['registration/verify', req => Registration.verify(req.body || {})],
    ['password/recovery', req => {
        if (!Sso.enabled()) throw { code: 'REGISTRATION_UNAVAILABLE', statusCode: 503 };
        return PasswordRecovery.request({ email: req.body?.email, rateLimitKey: req.ip });
    }],
]) router.post(`/public/identity/${path}`, publicLimit, express.json({ limit: '4kb' }), async (req, res) => {
    try {
        invitationOrigin(req, res);
        if (path.startsWith('registration/') && Auth.getSession(req)?.userId) throw { code: 'ACCOUNT_ALREADY_EXISTS', statusCode: 409 };
        const result = await action(req);
        res.status(path === 'password/recovery' ? 202 : 200).json(result);
    } catch (error) { publicIdentityError(res, error); }
});
router.get('/auth/sso/start', publicLimit, async (req, res) => {
    try {
        const expectedUserId = req.query.enrolled_user;
        if (expectedUserId !== undefined && (typeof expectedUserId !== 'string'
            || !/^[a-f0-9-]{36}$/i.test(expectedUserId))) return res.sendStatus(400);
        const flow = await Sso.begin(expectedUserId);
        if (expectedUserId) res.clearCookie(Auth.cookieName, {
            httpOnly: true, secure: Auth._isSecureRequest(req), sameSite: 'lax', path: '/',
        });
        res.cookie(flowCookie, flow.cookie, cookieOptions);
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(flow.url);
    } catch (_) { res.status(503).send('Единый вход пока недоступен. Обратитесь в поддержку AVA.'); }
});
router.get('/auth/sso/callback', async (req, res) => {
    try {
        const cookies = Auth._parseCookies(req.headers.cookie || '');
        res.clearCookie(flowCookie, cookieOptions);
        const query = req.originalUrl.split('?')[1] || '';
        const token = await Sso.complete(query, cookies[flowCookie]);
        Auth._setSessionCookie(req, res, `ava2:${token}`);
        res.setHeader('Cache-Control', 'no-store');
        res.redirect('/');
    } catch (_) { res.status(401).send('Вход не подтверждён. Получите приглашение AVA или повторите вход.'); }
});
router.post('/auth/sso/backchannel-logout', publicLimit, express.urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
    try {
        await Sso.backchannelLogout(req.body?.logout_token);
        res.setHeader('Cache-Control', 'no-store');
        res.sendStatus(200);
    } catch (_) { res.sendStatus(400); }
});
router.post('/invitations', Auth.requireAuth.bind(Auth), operator, (req, res) => {
    try {
        const base = getPublicUrl();
        if (req.headers.origin !== base.origin || !req.auth) return res.sendStatus(403);
        const current = req.auth.userId ? req.auth : { platformRole: 'platform_admin', userId: 'break-glass' };
        const result = Identity.createInvitation(current, req.body);
        const link = new URL('/invite', base);
        // Fragment is not included in access logs or the Referer header.
        link.hash = result.token;
        res.setHeader('Cache-Control', 'no-store');
        res.json({ success: true, invitation_id: result.invitationId, url: link.href, expires_in: result.expiresInSeconds });
    } catch (error) { res.status(error.statusCode || 400).json({ success: false, error: error.code || 'INVITATION_CREATE_FAILED' }); }
});
router.post('/owner-invitations', Auth.requireAuth.bind(Auth), operator, (req, res) => {
    try {
        const base = getPublicUrl();
        if (req.headers.origin !== base.origin) return res.sendStatus(403);
        const result = Identity.createOwnerInvitationLink(req.identityActor, req.body || {});
        const url = new URL('/owner-invite', base);
        url.hash = result.token;
        res.setHeader('Cache-Control', 'no-store');
        res.json({ success: true, id: result.id, label: result.label, url: url.href });
    } catch (error) { res.status(error.statusCode || 400).json({ success: false, error_code: error.code || 'INVITATION_CREATE_FAILED' }); }
});
router.get('/owner-invitations', Auth.requireAuth.bind(Auth), operatorRead, (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ success: true, links: Identity.listOwnerInvitationLinks(req.identityActor) });
    } catch (error) { res.status(error.statusCode || 400).json({ success: false, error_code: error.code || 'INVITATION_LIST_FAILED' }); }
});
router.post('/owner-invitations/:id/revoke', Auth.requireAuth.bind(Auth), operator, (req, res) => {
    try {
        Identity.revokeOwnerInvitationLink(req.identityActor, req.params.id);
        res.setHeader('Cache-Control', 'no-store');
        res.json({ success: true });
    } catch (error) { res.status(error.statusCode || 400).json({ success: false, error_code: error.code || 'INVITATION_REVOKE_FAILED' }); }
});
router.post('/owner-invitations/verify', publicLimit, (req, res) => {
    const requestId = crypto.randomUUID();
    res.setHeader('Cache-Control', 'no-store');
    try {
        if (req.headers.origin !== getPublicUrl().origin) throw { code: 'IDENTITY_ORIGIN_REQUIRED' };
        Identity.validOwnerLink(req.body?.token);
        res.json({ valid: true });
    } catch (error) {
        const result = invitationFailure(error, requestId);
        res.status(result.status).json(result.body);
    }
});
router.post('/owner-invitations/request-verification', publicLimit, async (req, res) => {
    const requestId = crypto.randomUUID();
    res.setHeader('Cache-Control', 'no-store');
    try {
        if (!Sso.enabled()) throw { code: 'IDENTITY_ENROLLMENT_UNAVAILABLE' };
        if (req.headers.origin !== getPublicUrl().origin) throw { code: 'IDENTITY_ORIGIN_REQUIRED' };
        const result = await OwnerVerificationStore.initiateVerification(req.body?.token, req.body || {});
        res.json({
            success: true,
            verification_id: result.verificationId,
            masked_email: result.maskedEmail,
            resend_after_ms: result.resendAfterMs,
        });
    } catch (error) {
        const failure = invitationFailure(error, requestId);
        Logger.warn(`[Identity] verification request failed code=${failure.body.error_code} requestId=${requestId}`);
        res.status(failure.status).json(failure.body);
    }
});
router.post('/owner-invitations/resend-code', publicLimit, async (req, res) => {
    const requestId = crypto.randomUUID();
    res.setHeader('Cache-Control', 'no-store');
    try {
        if (req.headers.origin !== getPublicUrl().origin) throw { code: 'IDENTITY_ORIGIN_REQUIRED' };
        const result = await OwnerVerificationStore.resendVerificationCode(req.body?.token, req.body || {});
        res.json({
            success: true,
            resend_after_ms: result.resendAfterMs,
        });
    } catch (error) {
        const failure = invitationFailure(error, requestId);
        Logger.warn(`[Identity] resend code failed code=${failure.body.error_code} requestId=${requestId}`);
        res.status(failure.status).json(failure.body);
    }
});
router.post('/owner-invitations/redeem', publicLimit, async (req, res) => {
    const requestId = crypto.randomUUID();
    let use;
    let verificationId;
    res.setHeader('Cache-Control', 'no-store');
    try {
        if (!Sso.enabled()) throw { code: 'IDENTITY_ENROLLMENT_UNAVAILABLE' };
        if (req.headers.origin !== getPublicUrl().origin) throw { code: 'IDENTITY_ORIGIN_REQUIRED' };
        
        if (!req.body?.verificationId) throw { code: 'VERIFICATION_REQUIRED' };
        const verified = OwnerVerificationStore.verifyCode(req.body?.token, {
            verificationId: req.body.verificationId,
            code: req.body?.code,
        });
        verificationId = verified.verificationId;
        const enrollmentPayload = { email: verified.email, displayName: verified.displayName };
        const rawPassword = verified.password;

        if (typeof rawPassword !== 'string' || rawPassword.length < 12
            || rawPassword.length > 256) throw { code: 'PASSWORD_POLICY' };
        // Create a distinct, short-lived child invite and disabled user for
        // this redemption. The existing worker then performs native enrollment.
        // Its old image only needs the established one-time invite contract.
        use = Identity.beginOwnerInvitationUse(req.body?.token, enrollmentPayload);
        await axios.post('http://provisioning_worker:3900/invitations/redeem', {
            token: use.childToken, password: rawPassword,
        }, { headers: { Authorization: `Bearer ${process.env.AVA_IDENTITY_BROKER_TOKEN || ''}` },
            timeout: 55000, maxRedirects: 0, proxy: false, maxContentLength: 4096 });
        if (!OwnerVerificationStore.finishEnrollment(use.invitationId, verificationId)) throw { code: 'IDENTITY_ENROLLMENT_UNAVAILABLE' };
        res.json({ success: true, user_id: use.userId });
    } catch (error) {
        // A lost worker response may follow a successful commit. Reconcile
        // the child invitation before cancelling an in-flight enrollment.
        let completed = false;
        if (use) {
            try {
                completed = OwnerVerificationStore.finishEnrollment(use.invitationId, verificationId);
                if (!completed && Identity.failOwnerInvitationUse(use.invitationId)) {
                    completed = OwnerVerificationStore.finishEnrollment(use.invitationId, verificationId);
                }
            }
            catch (_) { /* Storage failure is reported as a fixed public outage. */ }
        }
        if (completed) return res.json({ success: true, user_id: use.userId });
        const result = invitationFailure(error, requestId);
        Logger.warn(`[Identity] owner enrollment failed code=${result.body.error_code} requestId=${requestId}`);
        res.status(result.status).json(result.body);
    }
});
router.post('/access/:userId/revoke', Auth.requireAuth.bind(Auth), operator, (req, res) => {
    try {
        Identity.revokeUser(req.identityActor, req.params.userId);
        res.json({ success: true, local_access_revoked: true, native_revocation_pending: true });
    } catch (error) { res.status(error.statusCode || 400).json({ error: error.code || 'ACCESS_REVOKE_FAILED' }); }
});
router.post('/access/:userId/reinvite', Auth.requireAuth.bind(Auth), operator, (req, res) => {
    try {
        const result = Identity.reissueInvitation(req.identityActor, req.params.userId, req.body);
        const url = new URL('/invite', getPublicUrl());
        url.hash = result.token;
        res.setHeader('Cache-Control', 'no-store');
        res.json({ success: true, url: url.href, expires_in: result.expiresInSeconds, native_revocation_pending: true });
    } catch (error) { res.status(error.statusCode || 400).json({ error: error.code || 'INVITATION_CREATE_FAILED' }); }
});
function invitationOrigin(req,res) {
    res.setHeader('Cache-Control','no-store');
    if (req.headers.origin!==getPublicUrl().origin || (req.get('sec-fetch-site') && req.get('sec-fetch-site')!=='same-origin')) throw {code:'IDENTITY_ORIGIN_REQUIRED'};
}
function invitationError(res,error,requestId=crypto.randomUUID()) {
    if (error?.code==='TEAM_NEW_ACCOUNT_UNAVAILABLE') return res.status(503).json({success:false,
        error_code:'TEAM_NEW_ACCOUNT_UNAVAILABLE',request_id:requestId,
        error:'Создание нового аккаунта для команды временно недоступно. Если у вас уже есть аккаунт AVA, войдите с почтой из приглашения. Иначе попросите владельца бизнеса повторить приглашение позже.'});
    const result=invitationFailure(error,requestId);
    return res.status(result.status).json(result.body);
}
router.post('/invitations/inspect',publicLimit,(req,res)=>{
    try {
        invitationOrigin(req,res);
        const details=Identity.inspectInvitation(req.body?.token);
        res.json({success:true,...details,newAccountEnabled:details.acceptance!=='new_account' || TeamEnrollment.teamNewAccountEnabled()});
    }
    catch(error) { invitationError(res,error); }
});
router.post('/invitations/accept',publicLimit,(req,res)=>{
    try {
        invitationOrigin(req,res);
        const current=Auth.getSession(req);
        if (!current?.userId) throw {code:'INVITATION_AUTHENTICATION_REQUIRED'};
        const invite=Identity.inspectInvitation(req.body?.token);
        const joined=Identity.acceptInvitation(current,req.body?.token);
        res.json({success:true,user_id:joined.userId,businessId:invite.businessId});
    } catch(error) { invitationError(res,error); }
});
router.post('/invitations/request-verification',publicLimit,async(req,res)=>{
    try {
        invitationOrigin(req,res);
        if (!Sso.enabled()) throw {code:'IDENTITY_ENROLLMENT_UNAVAILABLE'};
        if (Auth.getSession(req)?.userId) throw {code:'INVITATION_ACCOUNT_MISMATCH'};
        TeamEnrollment.assertTeamNewAccountEnabled(Identity.pendingTeamInvitation(req.body?.token));
        const result=await TeamVerification.initiateVerification(req.body?.token,req.body || {});
        res.json({success:true,verification_id:result.verificationId,masked_email:result.maskedEmail,resend_after_ms:result.resendAfterMs});
    } catch(error) { invitationError(res,error); }
});
router.post('/invitations/resend-code',publicLimit,async(req,res)=>{
    try {
        invitationOrigin(req,res);
        if (Auth.getSession(req)?.userId) throw {code:'INVITATION_ACCOUNT_MISMATCH'};
        TeamEnrollment.assertTeamNewAccountEnabled(Identity.pendingTeamInvitation(req.body?.token));
        const result=await TeamVerification.resendVerificationCode(req.body?.token,req.body || {});
        res.json({success:true,resend_after_ms:result.resendAfterMs});
    } catch(error) { invitationError(res,error); }
});
router.post('/invitations/redeem', publicLimit, async (req, res) => {
    let teamEnrollment;
    const requestId = crypto.randomUUID();
    res.setHeader('Cache-Control', 'no-store');
    try {
        if (!Sso.enabled()) throw { code: 'IDENTITY_ENROLLMENT_UNAVAILABLE' };
        if (req.headers.origin !== getPublicUrl().origin) throw { code: 'IDENTITY_ORIGIN_REQUIRED' };
        if (!/^[\w-]{43}$/.test(req.body?.token || '')) throw { code: 'INVITATION_INVALID' };
        const invited=Identity.pendingTeamInvitation(req.body.token);
        TeamEnrollment.assertTeamNewAccountEnabled(invited);
        if (invited.acceptanceMode==='team') {
            invitationOrigin(req,res);
            if (Auth.getSession(req)?.userId) throw {code:'INVITATION_ACCOUNT_MISMATCH'};
            if (!req.body?.verificationId) throw {code:'VERIFICATION_REQUIRED'};
            teamEnrollment=TeamVerification.verifyCode(req.body.token,req.body);
        }
        const password=teamEnrollment?teamEnrollment.password:req.body?.password;
        if (typeof password !== 'string' || password.length < 12
            || password.length > 256) throw { code: 'PASSWORD_POLICY' };
        const response = await axios.post('http://provisioning_worker:3900/invitations/redeem', {
            token: req.body?.token, password, ...(teamEnrollment ? { verificationId: req.body.verificationId } : {}),
        }, { headers: { Authorization: `Bearer ${process.env.AVA_IDENTITY_BROKER_TOKEN || ''}` },
            timeout: 55000, maxRedirects: 0, proxy: false, maxContentLength: 4096 });
        res.setHeader('Cache-Control', 'no-store');
        if (teamEnrollment) {
            if (!TeamVerification.completed(teamEnrollment.invitationId,req.body.verificationId)) throw {code:'IDENTITY_ENROLLMENT_UNAVAILABLE'};
            return res.json({success:true,user_id:teamEnrollment.userId});
        }
        res.json(response.data);
    } catch (error) {
        if (teamEnrollment && TeamVerification.completed(teamEnrollment.invitationId,req.body.verificationId)) return res.json({success:true,user_id:teamEnrollment.userId});
        if (error?.code==='TEAM_NEW_ACCOUNT_UNAVAILABLE') return invitationError(res,error,requestId);
        const failure = invitationFailure(error, requestId);
        Logger.warn(`[Identity] invitation activation failed code=${failure.body.error_code} requestId=${requestId}`);
        res.status(failure.status).json(failure.body);
    }
});
module.exports = router;
