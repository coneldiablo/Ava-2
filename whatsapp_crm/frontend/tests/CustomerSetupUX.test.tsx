// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { getTelephony } from '../src/api/telephony';
import CustomerSetup from '../src/pages/CustomerSetup';

const fixture = vi.hoisted(() => ({ refreshInstances: vi.fn(), showGuide: false }));
vi.mock('../src/api/telephony',()=>({getTelephony:vi.fn()}));
vi.mock('../src/context/OnboardingContext', () => ({ useOnboarding: () => ({ showGuide: fixture.showGuide }) }));
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({
    currentInstanceId: 7, currentInstance: { id: 7, name: 'Аллея Resort' }, refreshInstances: fixture.refreshInstances,
}) }));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({
    authenticated: true, userId: 'owner', memberships: [{ businessId: 7, role: 'hotel_owner', capabilities: ['business.read', 'business.manage'] }],
}) }));
vi.mock('../src/components/VoiceSettings', () => ({ default: () => <div>Настройки голоса</div> }));
vi.mock('../src/components/AiModelSettings', () => ({ default: () => <div>Модель AI</div> }));
vi.mock('../src/components/BusinessSetupStatus', () => ({ default: () => <div>Статус сервисов</div> }));
vi.mock('../src/components/ModuleNavigation', () => ({ default: () => <div>Список модулей</div> }));

const profile = { businessId: 7, name: 'Аллея Resort', hotelTimezone: 'Europe/Moscow', voiceName: '', sipAliases: ['+79990000000'],
    sipCallerId: '+79990000001', systemPrompt: 'Текущие инструкции', voiceAiProvider: 'google_live' };

beforeEach(() => {
    vi.clearAllMocks(); fixture.showGuide = false;
    vi.mocked(getTelephony).mockResolvedValue({managedMode:false} as never);
    Element.prototype.scrollIntoView = vi.fn();
    fixture.refreshInstances.mockResolvedValue(undefined);
    let stored = { ...profile };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, options?: RequestInit) => {
        if (options?.method === 'PUT') stored = { ...stored, ...JSON.parse(String(options.body)) };
        return {
        ok: true,
        json: async () => _url.endsWith('/voice-options') ? { providers: [], defaultProvider: 'google_live' } : options?.method === 'PUT'
            ? { success: true, profile: stored }
            : { success: true, profile: stored },
    }; }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('customer business settings', () => {
    it('confirms edited instructions with a separate readback and preserves the voice provider', async () => {
        render(<MemoryRouter><CustomerSetup /></MemoryRouter>);
        fireEvent.change(await screen.findByLabelText('Инструкции для ответов клиентам'), { target: { value: 'Новые правила бизнеса' } });
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
        await screen.findByText(/Настройки сохранены. Они применятся к новым разговорам./);
        const calls = vi.mocked(fetch).mock.calls;
        const writeIndex = calls.findIndex(([, init]) => init?.method === 'PUT');
        expect(JSON.parse(String(calls[writeIndex][1]?.body))).toEqual({ systemPrompt: 'Новые правила бизнеса' });
        expect(calls.slice(writeIndex + 1).some(([url, init]) => url === '/api/hotel-profiles/7' && !init?.method)).toBe(true);
    });

    it('retains edited text when PUT is acknowledged but canonical readback disagrees', async () => {
        vi.mocked(fetch).mockImplementation(async (url, init) => ({ ok: true, json: async () => String(url).endsWith('/voice-options')
            ? { providers: [], defaultProvider: 'google_live' } : { success: true, profile: init?.method === 'PUT' ? { ...profile, ...JSON.parse(String(init.body)) } : profile },
        } as Response));
        render(<MemoryRouter><CustomerSetup /></MemoryRouter>);
        const input = await screen.findByLabelText('Инструкции для ответов клиентам');
        fireEvent.change(input, { target: { value: 'Мой новый текст' } });
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
        await screen.findByText(/Не удалось подтвердить сохранение/);
        expect((input as HTMLTextAreaElement).value).toBe('Мой новый текст');
        expect(screen.queryByText(/Настройки сохранены. Они применятся к новым разговорам./)).toBeNull();
        expect(fixture.refreshInstances).not.toHaveBeenCalled();
        const readsBefore = vi.mocked(fetch).mock.calls.filter(([url, init]) => url === '/api/hotel-profiles/7' && !init?.method).length;
        fireEvent.click(screen.getByRole('button', { name: 'Проверить сохранённые настройки' }));
        await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => url === '/api/hotel-profiles/7' && !init?.method).length).toBeGreaterThan(readsBefore));
        expect((input as HTMLTextAreaElement).value).toBe('Мой новый текст');
        expect(screen.queryByText(/Настройки сохранены. Они применятся к новым разговорам./)).toBeNull();
    });

    it.each(['business-profile', 'business-instructions'])('scrolls to %s only after the asynchronous profile is mounted', async section => {
        render(<MemoryRouter initialEntries={[`/integrations#${section}`]}><CustomerSetup /></MemoryRouter>);
        await screen.findByLabelText('Инструкции для ответов клиентам');
        await waitFor(() => expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts.some(target => target?.id === section)).toBe(true));
    });

    it('recovers a failed profile load locally', async () => {
        const base = vi.mocked(fetch).getMockImplementation()!;
        let failedReads = 0;
        vi.mocked(fetch).mockImplementation((url, init) => {
            if (url === '/api/hotel-profiles/7' && !init?.method && failedReads++ < 1) return Promise.reject(new Error('offline'));
            return base(url, init);
        });
        render(<MemoryRouter><CustomerSetup /></MemoryRouter>);
        fireEvent.click(await screen.findByRole('button', { name: 'Повторить загрузку настроек' }));
        await screen.findByDisplayValue('Аллея Resort');
        expect(screen.queryByText(/Не удалось загрузить настройки бизнеса/)).toBeNull();
    });
    it('keeps manual fields unavailable while managed status is unknown or unavailable', async()=>{
        vi.mocked(getTelephony).mockRejectedValueOnce(new Error('unavailable'));
        render(<MemoryRouter><CustomerSetup /></MemoryRouter>);
        await screen.findByDisplayValue('Аллея Resort');
        fireEvent.click(screen.getByText('Номера для звонков', {selector:'summary'}));
        await screen.findByText(/Не удалось проверить подключение номеров/);
        expect(screen.queryByLabelText('Номер для исходящих звонков')).toBeNull();
    });
    it('hides manual number fields for managed businesses while preserving ordinary profile edits', async()=>{
        vi.mocked(getTelephony).mockResolvedValueOnce({managedMode:true} as never);
        render(<MemoryRouter><CustomerSetup /></MemoryRouter>);
        await screen.findByDisplayValue('Аллея Resort');
        fireEvent.click(screen.getByText('Номера для звонков', {selector:'summary'}));
        expect(screen.queryByLabelText('Входящий номер бизнеса')).toBeNull();
        expect(screen.queryByLabelText('Номер для исходящих звонков')).toBeNull();
        expect(screen.getByRole('link',{name:'разделе «Телефония»'}).getAttribute('href')).toBe('/channels?channel=telephony');
        fireEvent.change(screen.getByDisplayValue('Аллея Resort'),{target:{value:'Новое имя'}});
        fireEvent.click(screen.getByRole('button',{name:'Сохранить настройки'}));
        await waitFor(()=>expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/hotel-profiles/7',expect.objectContaining({method:'PUT',body:JSON.stringify({name:'Новое имя'})})));
    });
    it('sends WhatsApp setup to channels and removes the completed guide', async () => {
        render(<MemoryRouter initialEntries={['/integrations']}><CustomerSetup /></MemoryRouter>);
        await screen.findByDisplayValue('Аллея Resort');
        expect(screen.getByRole('link', { name: 'Настроить каналы связи' }).getAttribute('href')).toBe('/channels');
        expect(screen.queryByRole('link', { name: 'Продолжить настройку' })).toBeNull();
        expect(screen.getByRole('link', { name: 'Инструкции по сайту' }).getAttribute('href')).toBe('/integrations#business-autoprompt');
        expect(screen.queryByRole('link', { name: 'Повторить пошаговую настройку' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Подключить WhatsApp' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Сменить номер WhatsApp' })).toBeNull();
    });

    it('keeps phone changes in channel setup and diagnostics collapsed while saving ordinary instructions', async () => {
        render(<MemoryRouter initialEntries={['/integrations']}><CustomerSetup /></MemoryRouter>);
        await screen.findByDisplayValue('Аллея Resort');
        const advanced = screen.getByText('Номера для звонков', {selector:'summary'}).closest('details')!;
        const diagnostics = screen.getByText('Помощь с подключениями').closest('details')!;
        expect(advanced.hasAttribute('open')).toBe(false);
        expect(diagnostics.hasAttribute('open')).toBe(false);
        expect(screen.queryByText('Статус сервисов')).toBeNull();
        fireEvent.click(screen.getByText('Номера для звонков', {selector:'summary'}));
        expect(advanced.hasAttribute('open')).toBe(true);
        expect(screen.queryByLabelText('Номер для исходящих звонков')).toBeNull();
        expect(screen.getByRole('link', {name:'Настроить телефонию'}).getAttribute('href')).toBe('/channels?channel=telephony');
        fireEvent.change(screen.getByLabelText('Инструкции для ответов клиентам'), { target: { value: 'Новые инструкции' } });
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
        await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/hotel-profiles/7', expect.objectContaining({
            method: 'PUT', body: JSON.stringify({ systemPrompt: 'Новые инструкции' }),
        })));
        fireEvent.click(screen.getByText('Помощь с подключениями'));
        expect(await screen.findByText('Статус сервисов')).toBeTruthy();
    });

    it('opens the optional diagnostics when the setup guide links to them', async () => {
        render(<MemoryRouter initialEntries={['/integrations#business-modules']}><CustomerSetup /></MemoryRouter>);
        expect(await screen.findByText('Статус сервисов')).toBeTruthy();
        expect(screen.getByText('Помощь с подключениями').closest('details')?.open).toBe(true);
    });

    it('keeps a pending guide accessible from ordinary settings', async () => {
        fixture.showGuide = true;
        render(<MemoryRouter initialEntries={['/integrations']}><CustomerSetup /></MemoryRouter>);
        await screen.findByDisplayValue('Аллея Resort');
        expect(screen.getByRole('link', { name: 'Продолжить настройку' }).getAttribute('href')).toBe('/getting-started');
    });

});
