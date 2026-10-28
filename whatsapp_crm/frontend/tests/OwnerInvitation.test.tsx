// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import OwnerInvitation from '../src/pages/OwnerInvitation';

const bearer = 'test-bearer-token';
const verificationId = 'verification-1';
const enrolledUserId = '11111111-1111-4111-8111-111111111111';
const success = (data: object) => ({ ok: true, json: async () => data });

function fillRegistration() {
    fireEvent.change(screen.getByLabelText('Ваше имя'), { target: { value: 'Мария' } });
    fireEvent.change(screen.getByLabelText('Рабочая почта'), { target: { value: 'owner@example.ru' } });
    fireEvent.change(screen.getByLabelText(/Пароль/), { target: { value: 'secure-password-123' } });
    fireEvent.change(screen.getByLabelText('Повторите пароль'), { target: { value: 'secure-password-123' } });
}

beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, '', '/owner-invite#test-bearer-token');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('owner invitation session', () => {
    it('keeps the OTP step and resend context across reload, then clears the session on completion', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(success({ valid: true }))
            .mockResolvedValueOnce(success({ success: true, verification_id: verificationId, masked_email: 'o***@example.ru' }))
            .mockResolvedValueOnce(success({ success: true }))
            .mockResolvedValueOnce(success({ success: true, user_id: enrolledUserId }));
        vi.stubGlobal('fetch', fetchMock);
        const first = render(<OwnerInvitation />);
        expect(window.location.hash).toBe('');
        expect(sessionStorage.getItem('ava:owner-invite-token')).toBe(bearer);
        fireEvent.click(await screen.findByRole('button', { name: /Начать настройку/ }));
        fillRegistration();
        fireEvent.click(screen.getByRole('button', { name: /Продолжить/ }));
        expect(await screen.findByRole('heading', { name: 'Код подтверждения' })).toBeTruthy();
        expect(sessionStorage.getItem('ava:owner-verification-id')).toBe(verificationId);
        expect(sessionStorage.getItem('ava:owner-verification-email')).toBe('o***@example.ru');
        first.unmount();
        render(<OwnerInvitation />);
        expect(await screen.findByRole('heading', { name: 'Код подтверждения' })).toBeTruthy();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        fireEvent.click(screen.getByRole('button', { name: /Отправить ещё раз/ }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
        expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ token: bearer, verificationId, email: 'owner@example.ru' });
        fireEvent.change(screen.getByLabelText(/Код из письма/), { target: { value: '123456' } });
        fireEvent.click(screen.getByRole('button', { name: /Создать доступ/ }));
        expect(await screen.findByRole('heading', { name: 'Доступ создан' })).toBeTruthy();
        expect(sessionStorage.getItem('ava:owner-invite-token')).toBeNull();
        expect(sessionStorage.getItem('ava:owner-verification-id')).toBeNull();
        expect(sessionStorage.getItem('ava:owner-verification-email')).toBeNull();
        expect(sessionStorage.getItem('ava:owner-verification-address')).toBeNull();
        expect(sessionStorage.getItem('ava:owner-guide-resume')).toBe('1');
        expect(sessionStorage.getItem('ava:owner-enrolled-user-id')).toBe(enrolledUserId);
        expect(screen.getByRole('link', { name: /Войти и продолжить/ }).getAttribute('href'))
            .toBe(`/api/auth/sso/start?enrolled_user=${enrolledUserId}`);
        cleanup();
        render(<OwnerInvitation />);
        expect(await screen.findByRole('heading', { name: 'Доступ создан' })).toBeTruthy();
        expect(screen.getByRole('link', { name: /Войти и продолжить/ }).getAttribute('href'))
            .toBe(`/api/auth/sso/start?enrolled_user=${enrolledUserId}`);
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('restores the token before OTP and revalidates after reload', async () => {
        const fetchMock = vi.fn().mockResolvedValue(success({ valid: true }));
        vi.stubGlobal('fetch', fetchMock);
        const first = render(<OwnerInvitation />);
        await screen.findByRole('button', { name: /Начать настройку/ });
        first.unmount();
        render(<OwnerInvitation />);
        expect(await screen.findByRole('button', { name: /Начать настройку/ })).toBeTruthy();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('clears an invalid invitation and does not offer registration', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ valid: false, error_code: 'INVITATION_INVALID' }) }));
        render(<OwnerInvitation />);
        await screen.findByRole('heading', { name: 'Приглашение не открыто' });
        expect(sessionStorage.getItem('ava:owner-invite-token')).toBeNull();
        expect(screen.queryByRole('button', { name: /Начать настройку/ })).toBeNull();
    });

    it('shows completion even if session storage is unavailable', async () => {
        vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('storage disabled'); }, setItem: () => { throw new Error('storage disabled'); }, removeItem: () => { throw new Error('storage disabled'); } });
        vi.stubGlobal('fetch', vi.fn()
            .mockResolvedValueOnce(success({ valid: true }))
            .mockResolvedValueOnce(success({ success: true, verification_id: verificationId, masked_email: 'o***@example.ru' }))
            .mockResolvedValueOnce(success({ success: true, user_id: enrolledUserId })));
        render(<OwnerInvitation />);
        fireEvent.click(await screen.findByRole('button', { name: /Начать настройку/ }));
        fillRegistration();
        fireEvent.click(screen.getByRole('button', { name: /Продолжить/ }));
        await screen.findByRole('heading', { name: 'Код подтверждения' });
        fireEvent.change(screen.getByLabelText(/Код из письма/), { target: { value: '123456' } });
        fireEvent.click(screen.getByRole('button', { name: /Создать доступ/ }));
        expect(await screen.findByRole('heading', { name: 'Доступ создан' })).toBeTruthy();
    });

    it('avoids revalidating while an enrollment may have completed during reload', async () => {
        sessionStorage.setItem('ava:owner-invite-token', bearer);
        sessionStorage.setItem('ava:owner-enrollment-pending', '1');
        window.history.replaceState(null, '', '/owner-invite');
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        render(<OwnerInvitation />);
        expect(await screen.findByRole('heading', { name: 'Проверим доступ' })).toBeTruthy();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('replaces a previous verification when a new hash arrives', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(success({ valid: true })));
        render(<OwnerInvitation />);
        await screen.findByRole('button', { name: /Начать настройку/ });
        sessionStorage.setItem('ava:owner-verification-id', 'old-id');
        window.history.pushState(null, '', '/owner-invite#next-bearer');
        fireEvent(window, new Event('hashchange'));
        await waitFor(() => expect(sessionStorage.getItem('ava:owner-invite-token')).toBe('next-bearer'));
        expect(sessionStorage.getItem('ava:owner-verification-id')).toBeNull();
        expect(window.location.hash).toBe('');
    });

    it('does not let a cancelled verification clear a newer invitation', async () => {
        let finishOld: ((response: object) => void) | undefined;
        const fetchMock = vi.fn()
            .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
            .mockResolvedValueOnce(success({ valid: true }));
        vi.stubGlobal('fetch', fetchMock);
        render(<OwnerInvitation />);
        window.history.pushState(null, '', '/owner-invite#next-bearer');
        fireEvent(window, new Event('hashchange'));
        await screen.findByRole('button', { name: /Начать настройку/ });
        await act(async () => {
            finishOld?.({ ok: false, json: async () => ({ valid: false, error_code: 'INVITATION_INVALID' }) });
            await Promise.resolve();
        });
        expect(sessionStorage.getItem('ava:owner-invite-token')).toBe('next-bearer');
    });
});
