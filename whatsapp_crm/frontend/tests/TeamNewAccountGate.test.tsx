// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AcceptInvitation from '../src/pages/AcceptInvitation';

const auth = vi.hoisted(() => ({ authenticated: false, loading: false, loginName: 'member@example.test', displayName: 'Участник', refreshAuth: vi.fn() }));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => auth }));
const details = { success: true, acceptance: 'new_account', email: 'member@example.test', role: 'manager', businessId: 1, businessName: 'Команда' };
beforeEach(() => {
    auth.authenticated = false; auth.loading = false; sessionStorage.clear();
    window.history.replaceState(null, '', '/invite#fixture-token');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Team new account availability', () => {
    it('shows a precise next step instead of password/code forms when new registration is paused', async () => {
        sessionStorage.setItem('ava:invite-verification', JSON.stringify({ id: 'old-code', email: 'm***@example.test', nextResend: 0 }));
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ...details, newAccountEnabled: false }) }));
        vi.stubGlobal('fetch', fetchMock); render(<AcceptInvitation />);
        await screen.findByText(/Создание нового аккаунта для команды временно недоступно/);
        expect(screen.getByRole('link', { name: 'Войти в AVA' }).getAttribute('href')).toBe('/api/auth/sso/start');
        expect(screen.queryByLabelText('Новый пароль')).toBeNull(); expect(screen.queryByLabelText('Код из письма')).toBeNull();
        expect(sessionStorage.getItem('ava:invite-token')).toBe('fixture-token');
        expect(sessionStorage.getItem('ava:invite-verification')).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('switches to the paused view if availability changes after inspection', async () => {
        const fetchMock = vi.fn(async (url: string) => ({ ok: url.endsWith('/inspect'), status: url.endsWith('/inspect') ? 200 : 503,
            json: async () => url.endsWith('/inspect') ? details : { success: false, error_code: 'TEAM_NEW_ACCOUNT_UNAVAILABLE' } }));
        vi.stubGlobal('fetch', fetchMock); render(<AcceptInvitation />);
        await screen.findByLabelText('Новый пароль');
        fireEvent.change(screen.getByLabelText('Новый пароль'), { target: { value: 'a-valid-team-password' } });
        fireEvent.change(screen.getByLabelText('Повторите пароль'), { target: { value: 'a-valid-team-password' } });
        fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
        await screen.findByRole('alert');
        expect(screen.getByRole('link', { name: 'Войти в AVA' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Получить код' })).toBeNull();
        expect(screen.queryByLabelText('Новый пароль')).toBeNull();
        expect(sessionStorage.getItem('ava:invite-enrolling')).toBeNull();
    });

    it('keeps existing-account acceptance with the same account even when the new-account flag is false', async () => {
        auth.authenticated = true;
        const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/inspect')
            ? { ...details, acceptance: 'existing_account', newAccountEnabled: false } : { success: true } }));
        vi.stubGlobal('fetch', fetchMock); render(<AcceptInvitation />);
        fireEvent.click(await screen.findByRole('button', { name: 'Присоединиться к команде' }));
        await screen.findByRole('heading', { name: 'Доступ готов' });
        expect(auth.refreshAuth).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/accept'))).toBe(true);
        expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/request-verification'))).toBe(false);
    });

    it('keeps legacy owner/platform activation unchanged', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ...details, acceptance: 'legacy', newAccountEnabled: false }) })));
        render(<AcceptInvitation />);
        expect(await screen.findByRole('button', { name: 'Активировать доступ' })).toBeTruthy();
        expect(screen.getByLabelText('Новый пароль')).toBeTruthy();
        expect(screen.queryByText(/Создание нового аккаунта для команды временно недоступно/)).toBeNull();
    });
});
