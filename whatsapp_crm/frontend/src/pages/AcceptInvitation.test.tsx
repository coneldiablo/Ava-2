// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AcceptInvitation from './AcceptInvitation';
import { actionError } from '../teamSales';
const auth = vi.hoisted(() => ({ authenticated: false, loading: false, loginName: 'anna@example.test', displayName: 'Анна', refreshAuth: vi.fn(), logout: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));
let acceptance = 'new_account';
const response = (data: object, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
describe('Invitation identity and verification', () => {
    beforeEach(() => { sessionStorage.clear(); auth.authenticated = false; auth.refreshAuth.mockReset(); auth.logout.mockReset(); acceptance = 'new_account'; window.history.replaceState(null, '', '/invite#one-secret'); vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('inspect') ? response({ success: true, businessId: 7, businessName: 'AVA Отель', email: 'anna@example.test', role: 'manager', acceptance }) : url.endsWith('request-verification') ? response({ success: true, verification_id: 'verification-one', masked_email: 'a***@example.test', resend_after_ms: 60000 }) : response({ success: true, user_id: 'employee' }))); });
    afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
    it('existing account accepts with current identity and no password or account change', async () => {
        acceptance = 'existing_account'; auth.authenticated = true; render(<AcceptInvitation/>); fireEvent.click(await screen.findByRole('button', { name: 'Присоединиться к команде' }));
        await screen.findByRole('heading', { name: 'Доступ готов' }); expect(screen.queryByLabelText('Новый пароль')).toBeNull();
        const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/accept')); expect(JSON.parse(call?.[1]?.body as string)).toEqual({ token: 'one-secret' }); expect(auth.refreshAuth).toHaveBeenCalledTimes(1); expect(sessionStorage.getItem('ava:preferred-business')).toBe('7');
    });
    it('signed out existing account preserves token and requests SSO', async () => {
        acceptance = 'existing_account'; render(<AcceptInvitation/>); const login = await screen.findByRole('link', { name: 'Войти в AVA' }); expect(login.getAttribute('href')).toBe('/api/auth/sso/start'); expect(sessionStorage.getItem('ava:invite-token')).toBe('one-secret'); expect(window.location.hash).toBe(''); expect(screen.queryByLabelText('Новый пароль')).toBeNull();
    });
    it('new user requests verification before redeem and clears password', async () => {
        render(<AcceptInvitation/>); fireEvent.change(await screen.findByLabelText('Новый пароль'), { target: { value: 'long-secret-password' } }); fireEvent.change(screen.getByLabelText('Повторите пароль'), { target: { value: 'long-secret-password' } }); fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
        await screen.findByLabelText('Код из письма'); expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/redeem'))).toBe(false); expect(sessionStorage.getItem('ava:invite-verification')).not.toContain('long-secret-password');
        fireEvent.change(screen.getByLabelText('Код из письма'), { target: { value: '123456' } }); fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и создать доступ' })); await screen.findByRole('heading', { name: 'Доступ готов' });
        const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/redeem')); expect(JSON.parse(call?.[1]?.body as string)).toEqual({ token: 'one-secret', verificationId: 'verification-one', code: '123456' });
    });
    it('recovers an account created since inspection through existing-account sign-in', async () => {
        render(<AcceptInvitation/>);
        fireEvent.change(await screen.findByLabelText('Новый пароль'), { target: { value: 'long-secret-password' } });
        fireEvent.change(screen.getByLabelText('Повторите пароль'), { target: { value: 'long-secret-password' } });
        vi.mocked(fetch).mockResolvedValueOnce(response({ success: false, error_code: 'INVITATION_EXISTING_ACCOUNT_REQUIRED' }, 409));
        fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
        expect(await screen.findByRole('link', { name: 'Войти в AVA' })).toBeTruthy();
        expect(screen.queryByLabelText('Новый пароль')).toBeNull();
        expect(sessionStorage.getItem('ava:invite-token')).toBe('one-secret');
        expect(sessionStorage.getItem('ava:invite-verification')).toBeNull();
    });
    it('preserves the invitation after account mismatch and supports signing out', async () => {
        acceptance = 'existing_account'; auth.authenticated = true;
        render(<AcceptInvitation/>);
        const join = await screen.findByRole('button', { name: 'Присоединиться к команде' });
        vi.mocked(fetch).mockResolvedValueOnce(response({ success: false, error_code: 'INVITATION_ACCOUNT_MISMATCH' }, 403));
        fireEvent.click(join);
        expect(await screen.findByText(/Текущий аккаунт не подходит/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Выйти из текущего аккаунта' }));
        await waitFor(() => expect(auth.logout).toHaveBeenCalledTimes(1));
        expect(sessionStorage.getItem('ava:invite-token')).toBe('one-secret');
        expect(auth.refreshAuth).not.toHaveBeenCalled();
    });
    it('shows a recoverable activation-service failure without claiming a code was sent', async () => {
        render(<AcceptInvitation/>);
        fireEvent.change(await screen.findByLabelText('Новый пароль'), { target: { value: 'long-secret-password' } });
        fireEvent.change(screen.getByLabelText('Повторите пароль'), { target: { value: 'long-secret-password' } });
        vi.mocked(fetch).mockResolvedValueOnce(response({ success: false, error_code: 'IDENTITY_ENROLLMENT_UNAVAILABLE' }, 503));
        fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
        expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Сервис добавления сотрудника временно недоступен. Повторите попытку позже.');
        expect(screen.getByLabelText('Новый пароль')).toBeTruthy();
        expect(screen.queryByLabelText('Код из письма')).toBeNull();
        expect(sessionStorage.getItem('ava:invite-verification')).toBeNull();
    });
    it('restarts verification when the server confirms the proof session expired', async () => {
        window.history.replaceState(null, '', '/invite'); sessionStorage.setItem('ava:invite-token', 'one-secret');
        sessionStorage.setItem('ava:invite-verification', JSON.stringify({ id: 'expired-proof', email: 'a***@example.test', nextResend: 0 }));
        render(<AcceptInvitation/>); await screen.findByLabelText('Код из письма');
        vi.mocked(fetch).mockResolvedValueOnce(response({ success: false, error_code: 'VERIFICATION_NOT_FOUND' }, 404));
        fireEvent.change(screen.getByLabelText('Код из письма'), { target: { value: '123456' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и создать доступ' }));
        await screen.findByLabelText('Новый пароль');
        expect(sessionStorage.getItem('ava:invite-verification')).toBeNull();
        expect(sessionStorage.getItem('ava:invite-enrolling')).toBeNull();
        expect(sessionStorage.getItem('ava:invite-token')).toBe('one-secret');
    });
    it('wrong verification code retains form for correction', async () => {
        render(<AcceptInvitation/>); fireEvent.change(await screen.findByLabelText('Новый пароль'), { target: { value: 'long-secret-password' } }); fireEvent.change(screen.getByLabelText('Повторите пароль'), { target: { value: 'long-secret-password' } }); fireEvent.click(screen.getByRole('button', { name: 'Получить код' })); await screen.findByLabelText('Код из письма');
        vi.mocked(fetch).mockResolvedValueOnce(response({ success: false, error_code: 'INVALID_VERIFICATION_CODE' }, 400)); fireEvent.change(screen.getByLabelText('Код из письма'), { target: { value: '123456' } }); fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и создать доступ' }));
        await screen.findByText('Неверный код. Проверьте шесть цифр из письма.'); expect(screen.getByLabelText('Код из письма')).toBeTruthy(); expect(sessionStorage.getItem('ava:invite-enrolling')).toBeNull();
    });
    it('resumes persisted verification after reload without password', async () => {
        window.history.replaceState(null, '', '/invite'); sessionStorage.setItem('ava:invite-token', 'one-secret'); sessionStorage.setItem('ava:invite-verification', JSON.stringify({ id: 'persisted', email: 'a***@example.test', nextResend: Date.now() + 60000 })); render(<AcceptInvitation/>);
        await screen.findByLabelText('Код из письма'); expect(screen.queryByLabelText('Новый пароль')).toBeNull(); expect(screen.getByRole('button', { name: /Отправить снова через/ }).hasAttribute('disabled')).toBe(true);
    });
    it('repairs a legacy persisted deadline once and enables resend within one minute across reloads', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
        const start = Date.UTC(2026, 9, 11, 12); vi.setSystemTime(start);
        window.history.replaceState(null, '', '/invite'); sessionStorage.setItem('ava:invite-token', 'one-secret');
        sessionStorage.setItem('ava:invite-verification', JSON.stringify({ id: 'legacy-proof', email: 'a***@example.test', nextResend: start * 2 + 60000 }));
        const first = render(<AcceptInvitation/>); await screen.findByLabelText('Код из письма');
        expect(JSON.parse(sessionStorage.getItem('ava:invite-verification')!).nextResend).toBe(start + 60000);
        await act(() => vi.advanceTimersByTimeAsync(30000));
        first.unmount(); render(<AcceptInvitation/>); await screen.findByLabelText('Код из письма');
        expect(screen.getByRole('button', { name: 'Отправить снова через 30 с' }).hasAttribute('disabled')).toBe(true);
        expect(JSON.parse(sessionStorage.getItem('ava:invite-verification')!).nextResend).toBe(start + 60000);
        await act(() => vi.advanceTimersByTimeAsync(30000));
        expect(screen.getByRole('button', { name: 'Отправить код ещё раз' }).hasAttribute('disabled')).toBe(false);
    });
    it('preserves an ordinary persisted cooldown after reload', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
        const start = Date.UTC(2026, 9, 11, 12); vi.setSystemTime(start);
        window.history.replaceState(null, '', '/invite'); sessionStorage.setItem('ava:invite-token', 'one-secret');
        const saved = JSON.stringify({ id: 'ordinary-proof', email: 'a***@example.test', nextResend: start + 25000 });
        sessionStorage.setItem('ava:invite-verification', saved);
        render(<AcceptInvitation/>); await screen.findByLabelText('Код из письма');
        expect(sessionStorage.getItem('ava:invite-verification')).toBe(saved);
        expect(screen.getByRole('button', { name: 'Отправить снова через 25 с' }).hasAttribute('disabled')).toBe(true);
        await act(() => vi.advanceTimersByTimeAsync(25000));
        expect(screen.getByRole('button', { name: 'Отправить код ещё раз' }).hasAttribute('disabled')).toBe(false);
    });
    it('normalizes an invalid persisted cooldown to a finite stored deadline', async () => {
        window.history.replaceState(null, '', '/invite'); sessionStorage.setItem('ava:invite-token', 'one-secret');
        const start = Date.now();
        sessionStorage.setItem('ava:invite-verification', JSON.stringify({ id: 'invalid-cooldown', email: 'a***@example.test', nextResend: 'invalid' }));
        render(<AcceptInvitation/>); await screen.findByLabelText('Код из письма');
        const deadline = JSON.parse(sessionStorage.getItem('ava:invite-verification')!).nextResend;
        expect(Number.isFinite(deadline)).toBe(true); expect(deadline).toBeGreaterThanOrEqual(start);
        expect(deadline).toBeLessThanOrEqual(Date.now() + 60000);
        expect(screen.getByRole('button', { name: /Отправить снова через/ }).textContent).not.toContain('NaN');
    });
    it('bounds a mixed-version absolute resend response to one minute', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
        const start = Date.UTC(2026, 9, 11, 12); vi.setSystemTime(start);
        render(<AcceptInvitation/>);
        fireEvent.change(await screen.findByLabelText('Новый пароль'), { target: { value: 'long-secret-password' } });
        fireEvent.change(screen.getByLabelText('Повторите пароль'), { target: { value: 'long-secret-password' } });
        vi.mocked(fetch).mockResolvedValueOnce(response({ success: true, verification_id: 'mixed-version-proof', masked_email: 'a***@example.test', resend_after_ms: start + 60000 }));
        fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
        await screen.findByLabelText('Код из письма');
        expect(JSON.parse(sessionStorage.getItem('ava:invite-verification')!).nextResend).toBe(start + 60000);
        await act(() => vi.advanceTimersByTimeAsync(60000));
        fireEvent.click(screen.getByRole('button', { name: 'Отправить код ещё раз' }));
        await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/resend-code'))).toBe(true));
    });
    it('explains the operator action required for a stale enrollment barrier', async () => {
        acceptance = 'existing_account'; auth.authenticated = true;
        render(<AcceptInvitation/>); const join = await screen.findByRole('button', { name: 'Присоединиться к команде' });
        vi.mocked(fetch).mockResolvedValueOnce(response({ success: false, error_code: 'TEAM_ENROLLMENT_RECONCILIATION_REQUIRED' }, 409));
        fireEvent.click(join);
        expect((await screen.findByRole('alert')).textContent).toContain('требует проверки администратором AVA');
        expect(actionError({ code: 'TEAM_ENROLLMENT_RECONCILIATION_REQUIRED' }, 'fallback')).toContain('Обратитесь в поддержку');
        expect(sessionStorage.getItem('ava:invite-token')).toBe('one-secret');
        expect(screen.queryByRole('heading', { name: 'Доступ готов' })).toBeNull();
    });
    it('checks an uncertain enrollment through inspect only and reports required operator recovery', async () => {
        window.history.replaceState(null, '', '/invite'); sessionStorage.setItem('ava:invite-token', 'one-secret');
        sessionStorage.setItem('ava:invite-enrolling', '1');
        vi.mocked(fetch).mockResolvedValueOnce(response({ success: false, error_code: 'TEAM_ENROLLMENT_RECONCILIATION_REQUIRED' }, 409));
        render(<AcceptInvitation/>);
        expect(screen.getByText(/попросите владельца бизнеса обратиться в поддержку AVA для проверки доступа/)).toBeTruthy();
        expect(fetch).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Проверить состояние' }));
        expect((await screen.findByRole('alert')).textContent).toContain('требует проверки администратором AVA');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe('/api/invitations/inspect');
        expect(sessionStorage.getItem('ava:invite-enrolling')).toBeNull();
        expect(sessionStorage.getItem('ava:invite-token')).toBe('one-secret');
        expect(screen.queryByRole('button', { name: 'Подтвердить и создать доступ' })).toBeNull();
    });
    it('aborts a hung redeem after 65 seconds and preserves uncertain enrollment for read-only checking', async () => {
        window.history.replaceState(null, '', '/invite'); sessionStorage.setItem('ava:invite-token', 'one-secret');
        const proof = JSON.stringify({ id: 'persisted', email: 'a***@example.test', nextResend: 0 });
        sessionStorage.setItem('ava:invite-verification', proof);
        render(<AcceptInvitation/>); await screen.findByLabelText('Код из письма');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let requestSignal: AbortSignal | null = null;
        vi.mocked(fetch).mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
            requestSignal = options?.signal as AbortSignal;
            requestSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }));
        fireEvent.change(screen.getByLabelText('Код из письма'), { target: { value: '123456' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и создать доступ' }));
        await act(() => vi.advanceTimersByTimeAsync(64999));
        expect(screen.getByRole('button', { name: 'Подтверждаем…' }).hasAttribute('disabled')).toBe(true);
        await act(() => vi.advanceTimersByTimeAsync(1));
        expect((requestSignal as unknown as AbortSignal).aborted).toBe(true);
        expect(screen.getByRole('button', { name: 'Проверить состояние' }).hasAttribute('disabled')).toBe(false);
        expect(screen.queryByLabelText('Код из письма')).toBeNull();
        expect(sessionStorage.getItem('ava:invite-enrolling')).toBe('1');
        expect(sessionStorage.getItem('ava:invite-token')).toBe('one-secret');
        expect(sessionStorage.getItem('ava:invite-verification')).toBe(proof);
        expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/redeem'))).toHaveLength(1);
    });
    it('treats a lost existing-account acceptance reply as uncertain and does not replay acceptance', async () => {
        acceptance = 'existing_account'; auth.authenticated = true;
        render(<AcceptInvitation/>); const join = await screen.findByRole('button', { name: 'Присоединиться к команде' });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        vi.mocked(fetch).mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }));
        fireEvent.click(join); await act(() => vi.advanceTimersByTimeAsync(20000));
        expect(screen.getByRole('button', { name: 'Проверить состояние' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Присоединиться к команде' })).toBeNull();
        expect(sessionStorage.getItem('ava:invite-enrolling')).toBe('1');
        expect(sessionStorage.getItem('ava:invite-token')).toBe('one-secret');
        expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/accept'))).toHaveLength(1);
    });
    it('aborts a hung inspect after 20 seconds and allows another read-only inspection', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let requestSignal: AbortSignal | null = null;
        vi.mocked(fetch).mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
            requestSignal = options?.signal as AbortSignal;
            requestSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }));
        render(<AcceptInvitation/>);
        await act(() => vi.advanceTimersByTimeAsync(20000));
        expect((requestSignal as unknown as AbortSignal).aborted).toBe(true);
        expect(screen.getByRole('alert').textContent).toContain('AVA не ответила вовремя');
        expect(screen.getByRole('button', { name: 'Проверить ещё раз' }).hasAttribute('disabled')).toBe(false);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Проверить ещё раз' })); });
        expect(screen.getByLabelText('Новый пароль')).toBeTruthy();
        expect(sessionStorage.getItem('ava:invite-token')).toBe('one-secret');
        expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).endsWith('/inspect'))).toBe(true);
    });
    it('network uncertainty does not retry an enrollment automatically', async () => {
        window.history.replaceState(null, '', '/invite'); sessionStorage.setItem('ava:invite-token', 'one-secret'); sessionStorage.setItem('ava:invite-verification', JSON.stringify({ id: 'persisted', email: 'a***@example.test', nextResend: 0 })); render(<AcceptInvitation/>); await screen.findByLabelText('Код из письма');
        vi.mocked(fetch).mockRejectedValueOnce(new Error('Network')); fireEvent.change(screen.getByLabelText('Код из письма'), { target: { value: '123456' } }); fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и создать доступ' })); await screen.findByRole('link', { name: 'Войти в AVA' }); expect(screen.queryByLabelText('Код из письма')).toBeNull();
        await waitFor(() => expect(sessionStorage.getItem('ava:invite-enrolling')).toBe('1'));
    });
});
