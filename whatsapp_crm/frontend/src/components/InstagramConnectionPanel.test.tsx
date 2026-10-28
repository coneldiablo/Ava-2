// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import InstagramConnectionPanel from './InstagramConnectionPanel';
import {
    disconnectInstagramPrivate,
    getInstagramPrivateStatus,
    loginInstagramPrivate,
    pollInstagramPrivate,
} from '../api';

vi.mock('../api', () => ({
    getInstagramPrivateStatus: vi.fn(),
    loginInstagramPrivate: vi.fn(),
    pollInstagramPrivate: vi.fn(),
    disconnectInstagramPrivate: vi.fn(),
}));

const status = (state: 'disabled' | 'not_connected' | 'awaiting_inbound' | 'connected' | 'paused', extra = {}) => ({
    success: true, configured: state !== 'disabled' && state !== 'not_connected', state, ...extra,
});
const show = (canManage = true) => render(<MemoryRouter><InstagramConnectionPanel businessId={7} canManage={canManage} /></MemoryRouter>);

describe('InstagramConnectionPanel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getInstagramPrivateStatus).mockResolvedValue(status('not_connected'));
    });
    afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

    it('lets the owner begin login without approval text and requests 2FA only when Instagram does', async () => {
        vi.mocked(loginInstagramPrivate)
            .mockRejectedValueOnce({ response: { data: { code: 'INSTAGRAM_PRIVATE_TWO_FACTOR_REQUIRED' } } })
            .mockResolvedValueOnce(status('awaiting_inbound'));
        show();
        fireEvent.change(await screen.findByLabelText('Логин Instagram'), { target: { value: 'my_business' } });
        fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'secret' } });
        expect(screen.queryByLabelText('Код подтверждения')).toBeNull();
        expect(screen.queryByText(/согласованн|допуск|контрольн/i)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Войти в Instagram' }));
        const code = await screen.findByLabelText('Код подтверждения');
        expect(document.activeElement).toBe(code);
        expect((screen.getByLabelText('Пароль') as HTMLInputElement).value).toBe('');
        fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'secret' } });
        fireEvent.change(code, { target: { value: '123456' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить вход' }));
        await screen.findByText('Вход выполнен. Ждём новый Direct');
        expect(vi.mocked(loginInstagramPrivate)).toHaveBeenLastCalledWith(7, {
            username: 'my_business', password: 'secret', code: '123456',
        });
        expect(screen.queryByText('Instagram Direct подключён')).toBeNull();
    });

    it('confirms connection only after a new inbound is reported by the backend', async () => {
        vi.mocked(getInstagramPrivateStatus).mockResolvedValue(status('awaiting_inbound'));
        vi.mocked(pollInstagramPrivate)
            .mockResolvedValueOnce(status('awaiting_inbound', { inboundConfirmed: false }))
            .mockResolvedValueOnce(status('connected', { inboundConfirmed: true }));
        show();
        await screen.findByText('Вход выполнен. Ждём новый Direct');
        fireEvent.click(screen.getByRole('button', { name: 'Проверить входящие' }));
        await waitFor(() => expect(pollInstagramPrivate).toHaveBeenCalledTimes(1));
        expect(screen.queryByText('Instagram Direct подключён')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Проверить входящие' }));
        await screen.findByText('Instagram Direct подключён');
        expect(screen.getByRole('link', { name: /Открыть диалоги/ }).getAttribute('href')).toBe('/conversations');
    });

    it('shows challenge recovery and a paused retry path without credentials for a reader', async () => {
        vi.mocked(getInstagramPrivateStatus).mockResolvedValueOnce(status('not_connected'))
            .mockResolvedValueOnce(status('paused', { pauseReason: 'challenge_required' }));
        vi.mocked(loginInstagramPrivate).mockRejectedValue({ response: { data: { code: 'INSTAGRAM_PRIVATE_CHALLENGE_REQUIRED' } } });
        const view = show();
        fireEvent.change(await screen.findByLabelText('Логин Instagram'), { target: { value: 'business' } });
        fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'secret' } });
        fireEvent.click(screen.getByRole('button', { name: 'Войти в Instagram' }));
        expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('приложении Instagram'));
        fireEvent.click(screen.getByRole('button', { name: 'Обновить состояние' }));
        await screen.findByText('Подключение приостановлено');
        expect(screen.getByRole('button', { name: 'Отключить Instagram' })).toBeTruthy();
        view.unmount();
        vi.mocked(getInstagramPrivateStatus).mockResolvedValue(status('not_connected'));
        show(false);
        await screen.findByText('Войти может владелец бизнеса.');
        expect(screen.queryByLabelText('Пароль')).toBeNull();
        expect(disconnectInstagramPrivate).not.toHaveBeenCalled();
    });

    it('describes a disabled connector as unavailable without an approval gate', async () => {
        vi.mocked(getInstagramPrivateStatus).mockResolvedValue(status('disabled'));
        show();
        await screen.findByText('Подключение временно недоступно');
        expect(screen.queryByLabelText('Логин Instagram')).toBeNull();
        expect(screen.queryByText(/допуск|согласованн|контрольн/i)).toBeNull();
    });

    it('restores the last login failure and verification input after refreshing the page', async () => {
        vi.mocked(getInstagramPrivateStatus).mockResolvedValue(status('not_connected',{
            lastLoginError:'INSTAGRAM_PRIVATE_TWO_FACTOR_REQUIRED',lastLoginAt:Date.now(),
        }));
        show();
        const input=await screen.findByLabelText('Код подтверждения');
        expect(document.activeElement).toBe(input);
        expect((await screen.findByRole('alert')).textContent).toContain('код подтверждения');
        expect(screen.queryByText('Instagram Direct подключён')).toBeNull();
        expect(loginInstagramPrivate).not.toHaveBeenCalled();
    });
});
