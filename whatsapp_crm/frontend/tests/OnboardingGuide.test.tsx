// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OnboardingGuide from '../src/pages/OnboardingGuide';
import { useAuth } from '../src/context/AuthContext';
import { useInstance } from '../src/context/InstanceContext';
import { useOnboarding } from '../src/context/OnboardingContext';
import { createInstance, getChannelStatus, getKnowledgeBaseStats } from '../src/api';

vi.mock('../src/context/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../src/context/InstanceContext', () => ({ useInstance: vi.fn() }));
vi.mock('../src/context/OnboardingContext', () => ({ useOnboarding: vi.fn() }));
vi.mock('../src/api', () => ({ createInstance: vi.fn(), getKnowledgeBaseStats: vi.fn(), getChannelStatus: vi.fn() }));

const businessId = 7;
beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
        clear: () => { values.clear(); },
    });
    vi.mocked(useOnboarding).mockReturnValue({ phase: 'pending', state: { businessId, status: 'pending', confirmedSteps: [], completedAt: null },
        showGuide: true, busy: false, error: '', reload: vi.fn(), confirmStep: vi.fn().mockResolvedValue(true), complete: vi.fn().mockResolvedValue(true) });
    vi.mocked(useAuth).mockReturnValue({ authenticated: true, userId: 'owner-user', permissionsLoading: false, canCreateBusiness: true, loginName: 'owner@example.ru', role: 'customer',
        memberships: [{ businessId, role: 'hotel_owner', capabilities: ['business.read', 'business.manage'] }], refreshAuth: vi.fn().mockResolvedValue(undefined) } as any);
    vi.mocked(useInstance).mockReturnValue({ currentInstanceId: businessId,
        currentInstance: { id: businessId, name: 'Отель Маяк' }, instancesState: 'ready',
        refreshInstances: vi.fn().mockResolvedValue(undefined), setInstanceId: vi.fn() } as any);
    vi.mocked(getKnowledgeBaseStats).mockResolvedValue({ stats: { totalDocuments: 2 } } as any);
    vi.mocked(getChannelStatus).mockResolvedValue({ success: true, channels: { telegramConfigured: true, telegram: false } } as any);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ profile: { name: 'Отель Маяк', businessType: 'hotel' } }) }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('owner setup guide', () => {
    it('replaces the wizard with settings links only after durable completion for this business', () => {
        vi.mocked(useOnboarding).mockReturnValue({ ...useOnboarding(), phase: 'completed', showGuide: false,
            state: { businessId, status: 'completed', confirmedSteps: ['business', 'profile', 'knowledge', 'channels', 'assistant'], completedAt: '2026-10-15T10:00:00Z' } } as any);
        render(<MemoryRouter><OnboardingGuide /></MemoryRouter>);
        expect(screen.getByRole('heading', { name: 'Настройка завершена' })).toBeTruthy();
        expect(screen.queryByLabelText('Шаги настройки')).toBeNull();
        expect(screen.queryByRole('button', { name: /Подтвердить и продолжить/ })).toBeNull();
        expect(screen.getByRole('link', { name: 'Настройки бизнеса' }).getAttribute('href')).toBe('/integrations');
        expect(screen.getByRole('link', { name: 'Инструкции по ссылкам' }).getAttribute('href')).toBe('/assistant-builder');
    });
    it('keeps the step across visits and never presents configured Telegram as verified', async () => {
        const mount = () => render(<MemoryRouter><OnboardingGuide /></MemoryRouter>);
        const first = mount();
        fireEvent.click(screen.getByRole('button', { name: /Шаг 4 Каналы/ }));
        await screen.findByText('Настроен, связь ещё не подтверждена');
        expect(localStorage.getItem('ava:guide:v1:owner@example.ru:7')).toContain('"step":3');
        first.unmount();
        mount();
        expect(screen.getByRole('heading', { name: 'Каналы связи' })).toBeTruthy();
        expect(screen.queryByText('Telegram подключён')).toBeNull();
    });

    it.each([true, false])('creates a business once and advances only if server business acknowledgement succeeds: %s', async acknowledged => {
        const setInstanceId = vi.fn();
        vi.mocked(useInstance).mockReturnValue({ currentInstanceId: null, currentInstance: null,
            instancesState: 'ready', refreshInstances: vi.fn().mockResolvedValue(undefined), setInstanceId } as any);
        vi.mocked(createInstance).mockResolvedValue({ success: true, instance: { id: 11 } } as any);
        vi.mocked(fetch).mockResolvedValue({ ok: acknowledged, status: acknowledged ? 200 : 503, json: async () => ({
            success: acknowledged, onboarding: { businessId: 11, status: 'pending', confirmedSteps: ['business'], completedAt: null },
        }) } as Response);
        render(<MemoryRouter><OnboardingGuide /></MemoryRouter>);
        expect(screen.getByRole('button', { name: /Подтвердить и продолжить/ }).hasAttribute('disabled')).toBe(true);
        fireEvent.change(screen.getByLabelText('Название бизнеса'), { target: { value: 'Отель Волна' } });
        fireEvent.click(screen.getByRole('button', { name: /Создать бизнес/ }));
        await waitFor(() => expect(setInstanceId).toHaveBeenCalledWith(11));
        expect(vi.mocked(createInstance).mock.calls[0][0]).toMatchObject({ name: 'Отель Волна', businessType: 'standard' });
        expect(vi.mocked(createInstance).mock.calls[0][1]).toMatch(/[a-f0-9-]{36}/);
        expect(localStorage.getItem('ava:guide:v1:owner@example.ru:11')).toContain(`"step":${acknowledged ? 1 : 0}`);
        expect(createInstance).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith('/api/businesses/11/onboarding/steps/business', expect.objectContaining({ method: 'POST' }));
    });

    it('does not let a jump to the last screen complete unconfirmed steps', () => {
        render(<MemoryRouter><OnboardingGuide /></MemoryRouter>);
        fireEvent.click(screen.getByRole('button', { name: /Шаг 5 Правила/ }));
        const finish = screen.getByRole('button', { name: 'Завершить настройку' });
        expect(finish.hasAttribute('disabled')).toBe(true);
        fireEvent.click(finish);
        expect(useOnboarding().confirmStep).not.toHaveBeenCalled();
        expect(useOnboarding().complete).not.toHaveBeenCalled();
        expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    });

});
