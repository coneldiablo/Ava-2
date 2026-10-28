// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import CustomerSetup from './CustomerSetup';

const state = vi.hoisted(() => ({ role: 'hotel_owner', refresh: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ authenticated: true, userId: 'fixture-owner', role: 'customer',
    memberships: [{ businessId: 7, role: state.role, capabilities: ['business.read', 'business.manage'] }] }) }));
vi.mock('../context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: 7, refreshInstances: state.refresh }) }));
vi.mock('../context/OnboardingContext', () => ({ useOnboarding: () => ({ showGuide: false }) }));
vi.mock('../components/AiModelSettings', () => ({ default: () => <div>Модель текста</div> }));
vi.mock('../components/VoiceSettings', () => ({ default: () => <div>Настройки звонков</div> }));
vi.mock('../api/telephony', () => ({ getTelephony: async () => ({ managedMode: true }) }));

let profile: Record<string, unknown>;
let writes: Record<string, unknown>[];
const draft = { id: 'fixture-draft', status: 'draft', links: ['https://example.com'], supplement: '',
    systemPrompt: 'Новые инструкции', sources: [], suggestedSettings: { hotelTimezone: 'Europe/Moscow' } };
const json = (value: unknown) => Promise.resolve({ ok: true, json: async () => value } as Response);
beforeEach(() => {
    state.role = 'hotel_owner'; state.refresh.mockReset(); sessionStorage.clear(); writes = [];
    profile = { businessId: 7, name: 'Наш бизнес', hotelTimezone: 'UTC', hotelTone: 'Вежливо', hotelWorkingHours: {},
        systemPrompt: 'Старые инструкции', voiceGreetingTemplate: 'Здравствуйте', outboundOpenerTemplate: '', sipAliases: ['79990000001'] };
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/assistant-draft/approve')) {
            const body = JSON.parse(String(options?.body));
            profile = { ...profile, systemPrompt: body.systemPrompt, ...body.settings };
            return json({ success: true, businessId: 7, profile: { ...profile }, draft: { ...draft, status: 'approved', systemPrompt: body.systemPrompt } });
        }
        if (url.endsWith('/assistant-draft')) return json({ success: true, businessId: 7, draft });
        if (url.endsWith('/onboarding/preparation')) return json({ success: true, businessId: 7, preparation: { businessId: 7, revision: 0, links: [], supplement: '' } });
        if (url === '/api/hotel-profiles/7' && options?.method === 'PUT') {
            const patch = JSON.parse(String(options.body)); writes.push(patch); profile = { ...profile, ...patch };
        }
        return json({ success: true, profile: { ...profile } });
    }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const show = (path = '/integrations') => render(<MemoryRouter initialEntries={[path]}><CustomerSetup /></MemoryRouter>);

it('saves selected timezone through the existing profile API, without pretending to connect a phone', async () => {
    show();
    const zone = await screen.findByRole('combobox', { name: 'Часовой пояс' });
    fireEvent.change(zone, { target: { value: 'Europe/Moscow' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await screen.findByText('Настройки сохранены. Они применятся к новым разговорам.');
    expect(writes).toEqual([{ hotelTimezone: 'Europe/Moscow' }]);
    expect(profile.hotelTimezone).toBe('Europe/Moscow');
    expect(screen.getByRole('link', { name: 'Настроить каналы связи' }).getAttribute('href')).toBe('/channels');
    expect(screen.queryByRole('textbox', { name: 'Входящий номер бизнеса' })).toBeNull();
});

it('approves inline instructions and selected timezone while preserving unrelated unsaved profile edits', async () => {
    show('/integrations#business-autoprompt');
    await screen.findByLabelText('Инструкции ассистента');
    expect(screen.queryByRole('link', { name: 'Открыть автопромпт' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Название бизнеса'), { target: { value: 'Несохранённое имя' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Применить: Часовой пояс' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и сохранить' }));
    await waitFor(() => expect((screen.getByLabelText('Инструкции для ответов клиентам') as HTMLTextAreaElement).value).toBe('Новые инструкции'));
    expect((screen.getByLabelText('Название бизнеса') as HTMLInputElement).value).toBe('Несохранённое имя');
    expect((screen.getByRole('combobox', { name: 'Часовой пояс' }) as HTMLSelectElement).value).toBe('Europe/Moscow');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await screen.findByText('Настройки сохранены. Они применятся к новым разговорам.');
    expect(writes).toEqual([{ name: 'Несохранённое имя' }]);
    expect(profile.systemPrompt).toBe('Новые инструкции');
    expect(profile.hotelTimezone).toBe('Europe/Moscow');
});

it('keeps business settings read-only for a manager', async () => {
    state.role = 'manager'; show();
    const zone = await screen.findByRole('combobox', { name: 'Часовой пояс' }) as HTMLSelectElement;
    expect(zone.closest('fieldset')?.disabled).toBe(true);
    expect(writes).toEqual([]);
});
