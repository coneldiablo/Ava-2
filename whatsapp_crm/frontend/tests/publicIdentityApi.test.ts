import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getLoginConfig, getPublicIdentityConfig, PublicIdentityError, recoverPassword, resendVerification,
    startRegistration, verifyRegistration,
} from '../src/publicIdentityApi';

const transport = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
});
const config = { success: true, registration_enabled: false, recovery_enabled: true, sso_enabled: true, minPasswordLength: 12, maxPasswordLength: 256, verification_method: 'email_code' };
const resent = { success: true, status: 'verification_requested', resend_after_ms: 60_000, expires_in_ms: 900_000 };
const started = { ...resent, verification_id: 'a'.repeat(43), masked_email: 'o***@example.test' };

beforeEach(() => {
    vi.stubGlobal('fetch', transport);
    transport.mockReset();
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('public identity transport', () => {
    it('sends replacement password only to the same proof verification endpoint', async () => {
        const user = '11111111-1111-4111-8111-111111111111';
        transport.mockResolvedValue(json({success:true,status:'completed',user_id:user,business_id:7,login_url:`/api/auth/sso/start?enrolled_user=${user}`}));
        const input = {verification_id:started.verification_id,code:'123456',password:'replacement-password'};
        await verifyRegistration(input);
        expect(transport).toHaveBeenCalledWith('/api/public/identity/registration/verify', expect.objectContaining({method:'POST',body:JSON.stringify(input)}));
    });

    it('loads explicit feature flags without the authenticated Axios interceptors', async () => {
        transport.mockResolvedValue(json(config));
        expect(await getPublicIdentityConfig()).toEqual({ registrationEnabled: false, recoveryEnabled: true, ssoEnabled: true, minPasswordLength: 12, maxPasswordLength: 256 });
        expect(transport).toHaveBeenCalledWith('/api/public/identity/config', expect.objectContaining({
            method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
            headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal),
        }));
    });

    it.each([
        [{}, 200],
        [{ registrationEnabled: 'true', recoveryEnabled: true }, 200],
        [{ registrationEnabled: true }, 200],
        [{ ...config, success: false }, 200],
        [{ ...config, registration_enabled: true }, 200],
        [{ ...config, minPasswordLength: 0 }, 200],
        [{ ...config, verification_method: 'email_link' }, 200],
    ])('rejects an incomplete or untyped configuration %j', async (body, status) => {
        transport.mockResolvedValue(json(body, status));
        await expect(getPublicIdentityConfig()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it('posts the registration input as JSON to the exact public route', async () => {
        const input = { email: 'owner@example.test', displayName: 'Анна', businessName: 'Кофейня', password: 'fixture-secret' };
        transport.mockResolvedValue(json(started, 202));
        expect(await startRegistration(input)).toEqual(started);
        expect(transport).toHaveBeenCalledWith('/api/public/identity/registration/start', expect.objectContaining({
            method: 'POST', body: JSON.stringify(input), credentials: 'same-origin',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        }));
    });

    it.each([
        ['resend', () => resendVerification('verification-id'), '/registration/resend', { verification_id: 'verification-id' }],
        ['recover', () => recoverPassword('owner@example.test'), '/password/recovery', { email: 'owner@example.test' }],
    ] as const)('posts %s credentials only in the body', async (_name, invoke, path, body) => {
        transport.mockResolvedValue(json(path === '/registration/resend' ? resent : { success: true }));
        await expect(invoke()).resolves.toEqual(path === '/registration/resend' ? resent : { success: true });
        expect(transport).toHaveBeenCalledWith(`/api/public/identity${path}`, expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }));
    });

    it('loads the public login mode with strict boolean validation', async () => {
        transport.mockResolvedValueOnce(json({ sso_enabled: false }));
        expect(await getLoginConfig()).toEqual({ sso_enabled: false });
        expect(transport).toHaveBeenCalledWith('/api/auth/config', expect.objectContaining({ method: 'GET' }));
        transport.mockResolvedValueOnce(json({ sso_enabled: 'true' }));
        await expect(getLoginConfig()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it('requires an HTTP 200 configuration response', async () => {
        transport.mockResolvedValueOnce(json({ sso_enabled: true }, 202));
        await expect(getLoginConfig()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 202 });
        transport.mockResolvedValueOnce(json(config, 202));
        await expect(getPublicIdentityConfig()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 202 });
    });

    const userId = '019c6e27-e55b-73d1-87d8-4e01f1f75043';
    const verified = { success: true, status: 'completed', user_id: userId, business_id: 42, login_url: `/api/auth/sso/start?enrolled_user=${userId}` };
    it('confirms enrollment only with user, business, and a matching local login URL', async () => {
        transport.mockResolvedValue(json(verified));
        const input = { verification_id: 'opaque+verification', code: '012345' };
        await expect(verifyRegistration(input)).resolves.toEqual(verified);
        expect(transport).toHaveBeenCalledWith('/api/public/identity/registration/verify', expect.objectContaining({ body: JSON.stringify(input) }));
    });

    it.each([
        { success: true },
        { ...verified, status: 'pending' },
        { ...verified, user_id: 'wrong' },
        { ...verified, business_id: 0 },
        { ...verified, business_id: '42' },
        { ...verified, login_url: 'https://outside.example/api/auth/sso/start' },
        { ...verified, login_url: '//outside.example/api/auth/sso/start' },
        { ...verified, login_url: '/api/auth/sso/start?enrolled_user=another-user' },
        { ...verified, login_url: `${verified.login_url}&redirect=https://outside.example` },
        { ...verified, login_url: `${verified.login_url}#unexpected` },
    ])('rejects incomplete enrollment or an untrusted login destination %j', async body => {
        transport.mockResolvedValue(json(body));
        await expect(verifyRegistration({ verification_id: 'opaque', code: '012345' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it.each([
        { success: true },
        { ...started, status: 'completed' },
        { ...started, verification_id: 'short' },
        { ...started, verification_id: `/${'a'.repeat(42)}` },
        { ...started, masked_email: '' },
        { ...started, resend_after_ms: -1 },
        { ...started, expires_in_ms: 0 },
    ])('requires actual verification metadata from registration %j', async body => {
        transport.mockResolvedValue(json(body));
        await expect(startRegistration({ email: 'a@example.test', password: 'fixture', businessName: 'B', displayName: 'A' }))
            .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it('keeps the opaque proof through resend without resubmitting account details', async () => {
        transport.mockResolvedValue(json({ ...resent, expires_in_ms: 500_000 }));
        await expect(resendVerification(started.verification_id)).resolves.toMatchObject({ expires_in_ms: 500_000 });
        expect(transport).toHaveBeenCalledWith('/api/public/identity/registration/resend', expect.objectContaining({
            body: JSON.stringify({ verification_id: started.verification_id }),
        }));
    });

    it.each([{ success: true }, { ...resent, status: 'completed' }, { ...resent, expires_in_ms: 0 }])('rejects incomplete resend metadata %j', async body => {
        transport.mockResolvedValue(json(body));
        await expect(resendVerification(started.verification_id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it.each([{}, { success: false }, { success: 'true' }, [], null])('never treats %j as confirmed success', async body => {
        transport.mockResolvedValue(json(body));
        await expect(recoverPassword('owner@example.test')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it.each([
        new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }),
        new Response(null, { status: 204 }),
        new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    ])('rejects a successful HTTP response with HTML, no body, or broken JSON', async response => {
        transport.mockResolvedValue(response);
        await expect(recoverPassword('owner@example.test')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it('maps known backend codes without exposing raw server messages', async () => {
        transport.mockResolvedValue(json({ success: false, code: 'INVALID_EMAIL', message: '<private provider detail>' }, 400));
        await expect(recoverPassword('wrong')).rejects.toMatchObject({
            name: 'PublicIdentityError', code: 'INVALID_EMAIL', status: 400, message: 'Проверьте адрес электронной почты.',
        });
    });

    it('preserves an unknown safe code but keeps the display message neutral', async () => {
        transport.mockResolvedValue(json({ error: 'ACCOUNT_EXISTS', message: 'owner@example.test exists' }, 409));
        await expect(startRegistration({ email: 'owner@example.test', displayName: 'A', businessName: 'B', password: 'P' }))
            .rejects.toMatchObject({ code: 'ACCOUNT_EXISTS', status: 409, message: 'AVA временно недоступна. Попробуйте позже.' });
    });

    it('preserves rate-limit delay from HTTP header in preference to the body', async () => {
        transport.mockResolvedValue(json({ code: 'IDENTITY_RATE_LIMITED', retryAfter: 9 }, 429, { 'Retry-After': '60' }));
        await expect(resendVerification('owner@example.test')).rejects.toMatchObject({ code: 'IDENTITY_RATE_LIMITED', retryAfter: 60 });
    });

    it('maps the existing identity error envelope without displaying server prose', async () => {
        transport.mockResolvedValue(json({ error_code: 'RESEND_COOLDOWN', error: 'private diagnostic', retry_after_seconds: 30 }, 429));
        await expect(resendVerification('owner@example.test')).rejects.toMatchObject({
            code: 'RESEND_COOLDOWN', retryAfter: 30, message: 'Подождите немного перед повторной отправкой кода.',
        });
    });

    it('keeps HTTP rate limits even when a proxy supplies broken JSON', async () => {
        transport.mockResolvedValue(new Response('{', { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } }));
        await expect(recoverPassword('owner@example.test')).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 60 });
    });

    it('supports Retry-After dates and seconds supplied in a JSON body', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-10T10:00:00Z'));
        transport.mockResolvedValueOnce(json({}, 429, { 'Retry-After': 'Sat, 10 Oct 2026 10:01:00 GMT' }));
        await expect(recoverPassword('owner@example.test')).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 60 });
        transport.mockResolvedValueOnce(json({ retryAfterSeconds: 2.1 }, 429));
        await expect(recoverPassword('owner@example.test')).rejects.toMatchObject({ retryAfter: 3 });
    });

    it('rejects network failures with a useful safe message', async () => {
        transport.mockRejectedValue(new TypeError('private network diagnostic'));
        const error = await recoverPassword('owner@example.test').catch(error => error);
        expect(error).toBeInstanceOf(PublicIdentityError);
        expect(error).toMatchObject({ code: 'NETWORK_ERROR' });
        expect(error.message).not.toContain('private');
    });

    it('does not dispatch a request with an already cancelled signal', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(getPublicIdentityConfig(controller.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
        expect(transport).not.toHaveBeenCalled();
    });

    it('cancels in-flight requests and removes the external abort listener', async () => {
        const controller = new AbortController();
        const removed = vi.spyOn(controller.signal, 'removeEventListener');
        transport.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }));
        const result = expect(getPublicIdentityConfig(controller.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
        controller.abort();
        await result;
        expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('times out instead of leaving a public form indefinitely loading', async () => {
        vi.useFakeTimers();
        transport.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }));
        const result = expect(getPublicIdentityConfig()).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
        await vi.advanceTimersByTimeAsync(20_000);
        await result;
        expect(vi.getTimerCount()).toBe(0);
    });
});
