// @vitest-environment jsdom
// Independent acceptance: overlay this file on an immutable frontend snapshot.
// Only upstream HTTP/media boundaries are mocked; the shipped components are used.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import VoiceSettings from '../src/components/VoiceSettings';
import CustomerSetup from '../src/pages/CustomerSetup';
import AssistantBuilder from '../src/pages/AssistantBuilder';

const session = vi.hoisted(() => ({
    userId: 'acceptance-owner-A', authenticated: true, permissionsLoading: false,
    role: 'hotel_owner', capabilities: ['business.read', 'business.manage'], businessId: 101,
    refreshInstances: vi.fn(),
}));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({
    ...session, memberships: [101, 202].map(businessId => ({ businessId, role: session.role, capabilities: session.capabilities })),
}) }));
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: session.businessId, refreshInstances: session.refreshInstances }) }));
vi.mock('../src/context/OnboardingContext', () => ({ useOnboarding: () => ({ showGuide: false }) }));
vi.mock('../src/api/telephony', () => ({ getTelephony: vi.fn(async () => ({ managedMode: true })) }));
vi.mock('../src/components/AiModelSettings', () => ({ default: () => <div>Existing CRM text model settings</div> }));
vi.mock('../src/components/BusinessSetupStatus', () => ({ default: () => <div>Existing service status</div> }));
vi.mock('../src/components/ModuleNavigation', () => ({ default: () => <div>Existing module navigation</div> }));

const GOOGLE = { model: 'google-call-model', voiceName: 'Kore' };
const NEURO = { model: 'gemini-3.8-flash', voiceName: 'edsel' };
const ALTERNATE = { model: 'gemini-3.7-flash', voiceName: 'luna' };
const defaults = { google_live: GOOGLE, neuro_gemini: NEURO };
const catalog = (businessId: number) => ({ businessId, defaultProvider: 'google_live', providers: [
    { id: 'google_live', label: 'Google acceptance voice', available: true, defaultModel: GOOGLE.model, defaultVoiceName: GOOGLE.voiceName,
        models: [{ id: GOOGLE.model, label: 'Google call model' }], voices: [{ id: 'Kore', label: 'Kore' }, { id: 'Puck', label: 'Puck' }] },
    { id: 'neuro_gemini', label: 'Neuro acceptance voice', available: true, defaultModel: NEURO.model, defaultVoiceName: NEURO.voiceName,
        models: [{ id: NEURO.model, label: 'Gemini 3.8' }, { id: ALTERNATE.model, label: 'Gemini 3.7' }],
        voices: [{ id: 'edsel', label: 'Edsel' }, { id: 'luna', label: 'Luna' }] },
] });
const profile = (businessId = 101) => ({
    businessId, followupAutoSendEnabled: false, followupAutoSendRevision: 0, name: `Acceptance business ${businessId}`, hotelTone: 'Calm', hotelTimezone: 'Europe/Moscow',
    systemPrompt: `Tenant instructions ${businessId}`, voiceGreetingTemplate: 'Hello {hotel_name}', outboundOpenerTemplate: 'Calling from {hotel_name}',
    aiModel: 'crm-text-model-must-survive', voiceAiProvider: businessId === 101 ? 'google_live' : 'neuro_gemini',
    voiceModel: businessId === 101 ? GOOGLE.model : ALTERNATE.model, voiceName: businessId === 101 ? GOOGLE.voiceName : ALTERNATE.voiceName,
    voiceSettings: { google_live: { ...GOOGLE }, neuro_gemini: { ...(businessId === 101 ? NEURO : ALTERNATE) } },
});
type Profile = ReturnType<typeof profile>;
type HttpCall = { url: string; init: RequestInit };
const calls: HttpCall[] = [];
const fetchMock = vi.fn<typeof fetch>();
const records = new Map<number, Profile>();
const json = (value: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => value } as Response);
const audioResponse = (blob: Blob | Promise<Blob> = new Blob(['acceptance-only-audio'], { type: 'audio/wav' })) => ({
    ok: true, status: 200, headers: new Headers({ 'Content-Type': 'audio/wav' }), blob: async () => blob,
} as Response);
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
}
function server(url: string, init: RequestInit = {}) {
    const id = Number(url.match(/hotel-profiles\/(\d+)/)?.[1]);
    if (url.endsWith('/voice-options')) return json(catalog(id));
    if (url.endsWith('/voice-preview')) return audioResponse();
    if (url.endsWith('/assistant-draft')) return json({ success: true, businessId: id, draft: null });
    if (init.method === 'PUT') {
        const patch = JSON.parse(String(init.body));
        const old = records.get(id)!;
        if ('voiceAiProvider' in patch) {
            const provider = (patch.voiceAiProvider || 'google_live') as keyof typeof defaults;
            const previous = old.voiceSettings[provider] || defaults[provider];
            const selected = { model: patch.voiceModel === '' ? defaults[provider].model : patch.voiceModel ?? previous.model,
                voiceName: patch.voiceName === '' ? defaults[provider].voiceName : patch.voiceName ?? previous.voiceName };
            records.set(id, { ...old, voiceAiProvider: provider, voiceModel: selected.model, voiceName: selected.voiceName,
                voiceSettings: { ...old.voiceSettings, [provider]: selected } });
        } else records.set(id, { ...old, ...patch });
    }
    return json({ success: true, profile: records.get(id) });
}
function install(intercept?: (url: string, init: RequestInit) => Response | Promise<Response> | undefined) {
    fetchMock.mockImplementation(async (input, init = {}) => {
        const url = String(input); calls.push({ url, init });
        return intercept?.(url, init) ?? server(url, init);
    });
}
const written = () => calls.filter(call => call.init.method === 'PUT');
const previews = () => calls.filter(call => call.url.endsWith('/voice-preview'));
const patch = (call: HttpCall) => JSON.parse(String(call.init.body));
const provider = () => screen.getByLabelText('Режим голоса') as HTMLSelectElement;
const model = () => screen.getByLabelText('Модель для звонков') as HTMLSelectElement;
const voice = () => screen.getByLabelText('Голос') as HTMLSelectElement;
const choose = (control: HTMLSelectElement, value: string) => fireEvent.change(control, { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Сохранить голос' }));
const preview = () => fireEvent.click(screen.getByRole('button', { name: 'Прослушать голос' }));
const ready = async () => { await waitFor(() => expect(provider().disabled).toBe(false)); };
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const urls = { create: vi.fn(() => `blob:acceptance-${players.length + 1}`), revoke: vi.fn() };
const players: AcceptanceAudio[] = [];
class AcceptanceAudio {
    src: string;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    play = vi.fn(async () => undefined);
    pause = vi.fn();
    load = vi.fn();
    removeAttribute = vi.fn();
    constructor(src = '') { this.src = src; players.push(this); }
}

beforeEach(() => {
    vi.clearAllMocks(); calls.length = 0; players.length = 0; records.clear();
    session.userId = 'acceptance-owner-A'; session.authenticated = true; session.permissionsLoading = false;
    session.role = 'hotel_owner'; session.capabilities = ['business.read', 'business.manage']; session.businessId = 101;
    session.refreshInstances.mockResolvedValue(undefined); sessionStorage.clear();
    records.set(101, profile(101)); records.set(202, profile(202));
    vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('Audio', AcceptanceAudio);
    vi.stubGlobal('URL', class extends URL { static createObjectURL = urls.create; static revokeObjectURL = urls.revoke; });
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    Element.prototype.scrollIntoView = vi.fn(); install();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('independent Neuro Gemini frontend acceptance', () => {
    it('keeps simultaneous businesses independent through save, readback and a fresh render', async () => {
        const a = render(<VoiceSettings businessId={101} />); await ready();
        choose(provider(), 'neuro_gemini'); choose(model(), ALTERNATE.model); choose(voice(), ALTERNATE.voiceName); save();
        await screen.findByText('Голос сохранён и проверен.'); a.unmount();
        const b = render(<VoiceSettings businessId={202} />); await ready();
        choose(model(), NEURO.model); choose(voice(), NEURO.voiceName); save();
        await screen.findByText('Голос сохранён и проверен.'); b.unmount();
        render(<VoiceSettings businessId={101} />); await ready();
        expect([model().value, voice().value]).toEqual([ALTERNATE.model, ALTERNATE.voiceName]);
        expect([records.get(202)?.voiceModel, records.get(202)?.voiceName]).toEqual([NEURO.model, NEURO.voiceName]);
        for (const call of written()) {
            expect(Object.keys(patch(call)).sort()).toEqual(['voiceAiProvider', 'voiceModel', 'voiceName']);
            expect(call.init.credentials).toBe('same-origin');
        }
        expect(records.get(101)?.systemPrompt).toBe('Tenant instructions 101');
        expect(records.get(202)?.aiModel).toBe('crm-text-model-must-survive');
    });

    it('restores each unsaved provider draft without submitting values from the provider being left', async () => {
        render(<VoiceSettings businessId={101} />); await ready();
        choose(voice(), 'Puck'); choose(provider(), 'neuro_gemini');
        choose(model(), ALTERNATE.model); choose(voice(), ALTERNATE.voiceName);
        choose(provider(), 'google_live'); expect(voice().value).toBe('Puck');
        choose(provider(), 'neuro_gemini');
        expect([model().value, voice().value]).toEqual([ALTERNATE.model, ALTERNATE.voiceName]); save();
        await screen.findByText('Голос сохранён и проверен.');
        expect(patch(written()[0])).toEqual({ voiceAiProvider: 'neuro_gemini', voiceModel: ALTERNATE.model, voiceName: ALTERNATE.voiceName });
        expect(records.get(101)?.voiceSettings.google_live.voiceName).toBe('Kore');
    });

    it.each(['account', 'business', 'grant'] as const)('rejects an old profile body that finishes parsing after a %s change', async change => {
        const body = deferred<unknown>(); let delayed = false;
        install((url, init) => {
            if (!delayed && url === '/api/hotel-profiles/101' && !init.method) {
                delayed = true; return { ...json(null), json: () => body.promise } as Response;
            }
        });
        const view = render(<VoiceSettings businessId={101} />); await flush();
        const old = calls.find(call => call.url === '/api/hotel-profiles/101')!;
        if (change === 'account') session.userId = 'acceptance-owner-B';
        if (change === 'grant') session.capabilities = ['business.read'];
        view.rerender(<VoiceSettings businessId={change === 'business' ? 202 : 101} />);
        await act(async () => body.resolve({ success: true, profile: { ...profile(101), voiceAiProvider: 'neuro_gemini', voiceModel: ALTERNATE.model, voiceName: 'luna' } }));
        await waitFor(() => expect(voice().value).toBe(change === 'business' ? 'luna' : 'Kore'));
        expect(old.init.signal?.aborted).toBe(true);
        expect(screen.queryByText('Голос сохранён и проверен.')).toBeNull();
        if (change === 'grant') expect(provider().disabled).toBe(true);
    });

    it('ignores an old catalog body parsed after account replacement at the same business', async () => {
        const body = deferred<unknown>(); let delayed = false;
        install(url => {
            if (!delayed && url.endsWith('/voice-options')) { delayed = true; return { ...json(null), json: () => body.promise } as Response; }
        });
        const view = render(<VoiceSettings businessId={101} />); await flush();
        session.userId = 'acceptance-owner-B'; view.rerender(<VoiceSettings businessId={101} />); await ready();
        await act(async () => body.resolve({ ...catalog(101), providers: [{ ...catalog(101).providers[0], label: 'Catalog from prior account' }] }));
        expect(screen.queryByRole('option', { name: 'Catalog from prior account' })).toBeNull();
        expect(screen.getByRole('option', { name: 'Neuro acceptance voice' })).toBeTruthy();
    });

    it('does not read back or confirm a save whose PUT body parses after the business changes', async () => {
        const body = deferred<unknown>();
        install((_url, init) => init.method === 'PUT' ? { ...json(null), json: () => body.promise } as Response : undefined);
        const view = render(<VoiceSettings businessId={101} />); await ready();
        choose(provider(), 'neuro_gemini'); save(); await waitFor(() => expect(written()).toHaveLength(1));
        const count = calls.filter(call => call.url === '/api/hotel-profiles/101' && !call.init.method).length;
        view.rerender(<VoiceSettings businessId={202} />); await ready();
        await act(async () => body.resolve({ success: true, profile: { ...profile(101), voiceAiProvider: 'neuro_gemini', voiceModel: NEURO.model, voiceName: NEURO.voiceName } }));
        expect(calls.filter(call => call.url === '/api/hotel-profiles/101' && !call.init.method)).toHaveLength(count);
        expect([model().value, voice().value]).toEqual([ALTERNATE.model, ALTERNATE.voiceName]);
        expect(screen.queryByText('Голос сохранён и проверен.')).toBeNull();
    });

    it('does not accept an old save readback whose body parses after account replacement', async () => {
        const body = deferred<unknown>(); let wrote = false, readbackStarted = false;
        install((url, init) => {
            if (init.method === 'PUT') { wrote = true; return server(url, init); }
            if (wrote && session.userId === 'acceptance-owner-A' && url === '/api/hotel-profiles/101') { readbackStarted = true; return { ...json(null), json: () => body.promise } as Response; }
        });
        const view = render(<VoiceSettings businessId={101} />); await ready();
        choose(provider(), 'neuro_gemini'); save();
        await waitFor(() => expect(readbackStarted).toBe(true));
        session.userId = 'acceptance-owner-B'; records.set(101, profile(101));
        view.rerender(<VoiceSettings businessId={101} />); await ready();
        await act(async () => body.resolve({ success: true, profile: { ...profile(101), voiceAiProvider: 'neuro_gemini', voiceModel: NEURO.model, voiceName: NEURO.voiceName } }));
        expect([provider().value, voice().value]).toEqual(['google_live', 'Kore']);
        expect(screen.queryByText('Голос сохранён и проверен.')).toBeNull();
    });

    it('refuses confirmation when PUT and GET agree on a different explicit requested voice', async () => {
        install((url, init) => {
            if (init.method !== 'PUT') return;
            const current = records.get(101)!;
            records.set(101, { ...current, voiceAiProvider: 'neuro_gemini', voiceModel: ALTERNATE.model, voiceName: 'edsel' });
            return server(url);
        });
        render(<VoiceSettings businessId={101} />); await ready();
        choose(provider(), 'neuro_gemini'); choose(model(), ALTERNATE.model); choose(voice(), 'luna'); save();
        expect((await screen.findByRole('alert')).textContent).toMatch(/Сохранение не подтверждено/);
        expect([model().value, voice().value]).toEqual([ALTERNATE.model, 'luna']);
        expect(screen.queryByText('Голос сохранён и проверен.')).toBeNull();
    });

    it('preserves an edited draft through catalog failure, retry, then canonical save', async () => {
        let fail = false;
        install(url => url.endsWith('/voice-options') && fail ? json({}, false) : undefined);
        render(<VoiceSettings businessId={101} />); await ready();
        choose(provider(), 'neuro_gemini'); choose(model(), ALTERNATE.model); choose(voice(), 'luna');
        fail = true; fireEvent.click(screen.getByRole('button', { name: 'Обновить каталог голосов' }));
        await screen.findByRole('alert');
        expect([model().value, voice().value]).toEqual([ALTERNATE.model, 'luna']);
        expect(screen.getByRole('button', { name: 'Сохранить голос' })).toHaveProperty('disabled', true);
        expect(written()).toHaveLength(0);
        fail = false; fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку каталога' })); await ready();
        expect([model().value, voice().value]).toEqual([ALTERNATE.model, 'luna']); save();
        await screen.findByText('Голос сохранён и проверен.');
    });

    it.each(['business', 'account', 'grant', 'provider', 'model', 'voice'] as const)('does not allocate or play a preview blob that completes after a %s change', async change => {
        const blob = deferred<Blob>(); install(url => url.endsWith('/voice-preview') ? audioResponse(blob.promise) : undefined);
        const view = render(<VoiceSettings businessId={101} />); await ready();
        choose(provider(), 'neuro_gemini'); preview(); await waitFor(() => expect(previews()).toHaveLength(1));
        if (change === 'provider') choose(provider(), 'google_live');
        if (change === 'model') choose(model(), ALTERNATE.model);
        if (change === 'voice') choose(voice(), 'luna');
        if (change === 'account') session.userId = 'acceptance-owner-B';
        if (change === 'grant') session.capabilities = ['business.read'];
        if (['business', 'account', 'grant'].includes(change)) view.rerender(<VoiceSettings businessId={change === 'business' ? 202 : 101} />);
        await act(async () => blob.resolve(new Blob(['late fixture'], { type: 'audio/wav' })));
        expect(previews()[0].init.signal?.aborted).toBe(true);
        expect(urls.create).not.toHaveBeenCalled(); expect(players).toHaveLength(0);
    });

    it('revokes each playing preview and makes old media callbacks harmless after replacement', async () => {
        render(<VoiceSettings businessId={101} />); await ready(); choose(provider(), 'neuro_gemini'); preview();
        await screen.findByRole('button', { name: 'Остановить' });
        const oldPlayer = players[0]; const lateEnd = oldPlayer.onended!; const lateError = oldPlayer.onerror!; const oldUrl = oldPlayer.src;
        choose(voice(), 'luna');
        expect(oldPlayer.pause).toHaveBeenCalledOnce(); expect(oldPlayer.removeAttribute).toHaveBeenCalledWith('src');
        expect(oldPlayer.load).toHaveBeenCalledOnce(); expect(urls.revoke).toHaveBeenCalledWith(oldUrl);
        preview(); await screen.findByRole('button', { name: 'Остановить' });
        act(() => { lateEnd(); lateError(); });
        expect(players[1].pause).not.toHaveBeenCalled();
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.getByRole('button', { name: 'Остановить' })).toBeTruthy();
        act(() => players[1].onended!());
        expect(urls.revoke).toHaveBeenCalledWith(players[1].src);
        expect(screen.getByRole('button', { name: 'Прослушать голос' })).toBeTruthy();
    });

    it.each(['account', 'business', 'grant', 'checking'] as const)('pauses and revokes already playing audio on %s change', async change => {
        const view = render(<VoiceSettings businessId={101} />); await ready(); choose(provider(), 'neuro_gemini'); preview();
        await screen.findByRole('button', { name: 'Остановить' });
        const playing = players[0];
        if (change === 'account') session.userId = 'acceptance-owner-B';
        if (change === 'grant') session.capabilities = ['business.read'];
        if (change === 'checking') session.permissionsLoading = true;
        view.rerender(<VoiceSettings businessId={change === 'business' ? 202 : 101} />);
        expect(playing.pause).toHaveBeenCalledOnce(); expect(playing.load).toHaveBeenCalledOnce();
        expect(urls.revoke).toHaveBeenCalledWith(playing.src);
        expect(screen.queryByRole('button', { name: 'Остановить' })).toBeNull();
    });

    it.each(['text/plain', 'application/json'] as const)('rejects a successful preview with %s content without losing the draft', async contentType => {
        install(url => url.endsWith('/voice-preview') ? { ...audioResponse(), headers: new Headers({ 'Content-Type': contentType }) } as Response : undefined);
        render(<VoiceSettings businessId={101} />); await ready(); choose(provider(), 'neuro_gemini'); choose(voice(), 'luna'); preview();
        await screen.findByRole('alert'); expect(voice().value).toBe('luna');
        expect(players).toHaveLength(0); expect(urls.create).not.toHaveBeenCalled();
    });

    it.each([0, 8 * 1024 * 1024 + 1])('does not play a successful preview body of invalid size %s', async size => {
        install(url => url.endsWith('/voice-preview') ? audioResponse(new Blob([new Uint8Array(size)], { type: 'audio/wav' })) : undefined);
        render(<VoiceSettings businessId={101} />); await ready(); choose(provider(), 'neuro_gemini'); preview();
        await screen.findByRole('alert'); expect(voice().value).toBe('edsel');
        expect(players).toHaveLength(0); expect(urls.create).not.toHaveBeenCalled();
    });

    it('releases preview bytes after browser playback rejection and leaves retry available', async () => {
        vi.stubGlobal('Audio', class extends AcceptanceAudio { play = vi.fn(async () => { throw new Error('browser blocked playback'); }); });
        render(<VoiceSettings businessId={101} />); await ready(); choose(provider(), 'neuro_gemini'); preview();
        await screen.findByRole('alert');
        expect(players).toHaveLength(1); expect(players[0].pause).toHaveBeenCalledOnce();
        expect(urls.revoke).toHaveBeenCalledWith(players[0].src);
        expect(screen.getByRole('button', { name: 'Прослушать голос' })).toHaveProperty('disabled', false);
    });

    it.each(['customer settings', 'assistant manual settings'] as const)('saving %s preserves a newer independently saved voice and CRM text model', async surface => {
        render(<MemoryRouter>{surface === 'customer settings' ? <CustomerSetup /> : <AssistantBuilder />}</MemoryRouter>);
        await ready(); choose(provider(), 'neuro_gemini'); choose(model(), ALTERNATE.model); choose(voice(), 'luna'); save();
        await screen.findByText('Голос сохранён и проверен.');
        if (surface === 'assistant manual settings') fireEvent.click(screen.getByText('Ручные настройки и звонки'));
        fireEvent.change(screen.getByLabelText('Название бизнеса'), { target: { value: 'Updated business name' } });
        fireEvent.click(screen.getByRole('button', { name: surface === 'customer settings' ? 'Сохранить настройки' : 'Сохранить ручные настройки' }));
        await waitFor(() => expect(written()).toHaveLength(2));
        expect(patch(written()[1])).toEqual({ name: 'Updated business name' });
        expect([records.get(101)?.voiceAiProvider, records.get(101)?.voiceModel, records.get(101)?.voiceName]).toEqual(['neuro_gemini', ALTERNATE.model, 'luna']);
        expect(records.get(101)?.aiModel).toBe('crm-text-model-must-survive');
    });
});
