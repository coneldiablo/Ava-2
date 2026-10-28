// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AcceptInvitation from '../src/pages/AcceptInvitation';

vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ authenticated: false, loading: false, refreshAuth: vi.fn() }) }));
const inspect = { success: true, acceptance: 'legacy', email: 'test@example.test', role: 'manager' };

const bearer = 'test-invite-token';

function fillPassword() {
    fireEvent.change(screen.getByLabelText('Новый пароль'), { target: { value: 'secure-password-123' } });
    fireEvent.change(screen.getByLabelText('Повторите пароль'), { target: { value: 'secure-password-123' } });
}

beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, '', '/invite/#test-invite-token');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('team invitation session', () => {
    it('captures the hash, restores it after reload, and clears it on activation', async () => {
        const fetchMock = vi.fn(async (url: string, _options?: RequestInit) => ({ ok: true, json: async () => url.endsWith('/inspect') ? inspect : ({ success: true }) }));
        vi.stubGlobal('fetch', fetchMock);
        const first = render(<AcceptInvitation />);
        expect(window.location.hash).toBe('');
        expect(sessionStorage.getItem('ava:invite-token')).toBe(bearer);
        first.unmount();
        render(<AcceptInvitation />);
        await screen.findByLabelText('Новый пароль');
        fillPassword();
        fireEvent.click(screen.getByRole('button', { name: 'Активировать доступ' }));
        expect(await screen.findByRole('heading', { name: 'Доступ готов' })).toBeTruthy();
        expect(sessionStorage.getItem('ava:invite-token')).toBeNull();
        expect(JSON.parse(fetchMock.mock.calls.find(([url]) => url.endsWith('/redeem'))?.[1]?.body as string)).toEqual({ token: bearer, password: 'secure-password-123' });
    });

    it('keeps the token for a recoverable failure', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: url.endsWith('/inspect'), json: async () => url.endsWith('/inspect') ? inspect : ({ error_code: 'IDENTITY_ENROLLMENT_UNAVAILABLE' }) })));
        render(<AcceptInvitation />);
        await screen.findByLabelText('Новый пароль');
        fillPassword();
        fireEvent.click(screen.getByRole('button', { name: 'Активировать доступ' }));
        await screen.findByText(/Сервис добавления сотрудника временно недоступен/);
        expect(sessionStorage.getItem('ava:invite-token')).toBe(bearer);
    });

    it('clears a confirmed invalid invitation', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error_code: 'INVITATION_INVALID' }) }));
        render(<AcceptInvitation />);
        await waitFor(() => expect(sessionStorage.getItem('ava:invite-token')).toBeNull());
        expect(screen.queryByRole('button', { name: 'Активировать доступ' })).toBeNull();
    });

    it('requires a link when the tab has no token and replaces it on a new hash', async () => {
        window.history.replaceState(null, '', '/invite');
        const first = render(<AcceptInvitation />);
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => inspect })));
        expect(screen.queryByRole('button', { name: 'Активировать доступ' })).toBeNull();
        expect(sessionStorage.getItem('ava:invite-token')).toBeNull();
        window.history.pushState(null, '', '/invite#next-invite-token');
        fireEvent(window, new Event('popstate'));
        await waitFor(() => expect(sessionStorage.getItem('ava:invite-token')).toBe('next-invite-token'));
        expect((await screen.findByRole('button', { name: 'Активировать доступ' })).hasAttribute('disabled')).toBe(false);
        expect(window.location.hash).toBe('');
        first.unmount();
    });
});
