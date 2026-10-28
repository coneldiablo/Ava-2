// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import VoiceSettings from './VoiceSettings';

const session = vi.hoisted(() => ({
    authenticated: true, permissionsLoading: false, userId: 'owner-1', role: 'hotel_owner',
    capabilities: ['business.read', 'business.manage'],
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({
    ...session, loading: false, role: 'customer', loginName: session.userId,
    memberships: [7, 8].map(businessId => ({ businessId, role: session.role, capabilities: session.capabilities })),
}) }));

const google = { model: 'gemini-live-2.5', voiceName: 'Kore' };
const neuro = { model: 'gemini-3.8-flash', voiceName: 'voice_anna' };
const catalog = (businessId = 7) => ({ success: true, businessId, defaultProvider: 'google_live', providers: [
    { id: 'google_live', label: 'Google Live', available: true,
        models: [{ id: google.model, label: 'Gemini Live' }],
        voices: [{ id: 'Kore', label: 'Kore' }, { id: 'Puck', label: 'Puck' }],
        defaultModel: google.model, defaultVoiceName: google.voiceName },
    { id: 'neuro_gemini', label: 'Neuro + Gemini', available: true,
        models: [{ id: neuro.model, label: 'Gemini 3.8 Flash' }, { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' }],
        voices: [{ id: 'voice_anna', label: 'Анна', language: 'ru' }, { id: 'voice_boris', label: 'Борис', language: 'ru' }],
        defaultModel: neuro.model, defaultVoiceName: neuro.voiceName },
] });
const profile = (businessId = 7, provider = 'google_live', selected = provider === 'neuro_gemini' ? neuro : google) => ({
    businessId, name: `Business ${businessId}`, systemPrompt: 'Keep the tenant instructions',
    aiModel: 'existing-text-ai', voiceAiProvider: provider, voiceModel: selected.model, voiceName: selected.voiceName,
    followupAutoSendEnabled: false, followupAutoSendRevision: 0,
    voiceSettings: { google_live: { ...google }, neuro_gemini: { ...neuro } },
});
type Profile = ReturnType<typeof profile>;
type RequestCall = Parameters<typeof fetch>;
const response = (data: unknown, ok = true) => Promise.resolve({
    ok, status: ok ? 200 : 503, headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => data,
} as Response);
const audioResponse = () => Promise.resolve({
    ok: true, status: 200, headers: new Headers({ 'Content-Type': 'audio/wav' }),
    blob: async () => new Blob(['bounded audio fixture'], { type: 'audio/wav' }),
} as Response);
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const fetchMock = vi.fn<typeof fetch>();
const objects = { created: vi.fn(() => 'blob:voice-preview'), revoked: vi.fn() };
const players: FakeAudio[] = [];
let neverFinishesPlayback = false;
class FakeAudio extends EventTarget {
    src: string;
    preload = '';
    play = vi.fn(() => neverFinishesPlayback ? new Promise<void>(() => undefined) : Promise.resolve());
    pause = vi.fn();
    load = vi.fn();
    removeAttribute = vi.fn();
    constructor(src = '') { super(); this.src = src; players.push(this); }
}
const providerField = () => screen.getByLabelText('Режим голоса') as HTMLSelectElement;
const modelField = () => screen.getByLabelText('Модель для звонков') as HTMLSelectElement;
const voiceField = () => screen.getByLabelText('Голос') as HTMLSelectElement;
const selectNeuro = () => fireEvent.change(providerField(), { target: { value: 'neuro_gemini' } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Сохранить голос' }));
const preview = () => fireEvent.click(screen.getByRole('button', { name: 'Прослушать голос' }));
const writes = () => fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT');
const previews = () => fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/voice-preview'));
const body = (call: RequestCall) => JSON.parse(String(call[1]?.body));
const voicePanel = () => within(screen.getByRole('region', { name: 'Голос вашего ассистента' }));
const retryCatalog = () => fireEvent.click(voicePanel().getByRole('button', { name: 'Повторить загрузку каталога' }));
const abortableResponse = (options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
});

function installServer(initial: Profile = profile()) {
    const stored = new Map([[7, initial], [8, profile(8, 'neuro_gemini', { model: 'gemini-3.7-flash', voiceName: 'voice_boris' })]]);
    fetchMock.mockImplementation((input, options) => {
        const url = String(input);
        const id = Number(url.match(/hotel-profiles\/(\d+)/)?.[1]);
        if (url.endsWith('/voice-options')) return response(catalog(id));
        if (url.endsWith('/voice-preview')) return audioResponse();
        if (options?.method === 'PUT') {
            const patch = JSON.parse(String(options.body));
            const current = stored.get(id)!;
            const provider = patch.voiceAiProvider || 'google_live';
            const previous = current.voiceSettings[provider as keyof typeof current.voiceSettings];
            const selected = { model: patch.voiceModel ?? previous?.model ?? '', voiceName: patch.voiceName ?? previous?.voiceName ?? '' };
            stored.set(id, { ...current, voiceAiProvider: provider, voiceModel: selected.model, voiceName: selected.voiceName,
                voiceSettings: { ...current.voiceSettings, [provider]: selected } });
        }
        return response({ success: true, profile: stored.get(id) });
    });
    return stored;
}

describe('VoiceSettings', () => {
    beforeEach(() => {
        session.authenticated = true; session.permissionsLoading = false; session.userId = 'owner-1';
        session.role = 'hotel_owner'; session.capabilities = ['business.read', 'business.manage'];
        fetchMock.mockReset(); objects.created.mockClear(); objects.revoked.mockClear(); players.length = 0; neverFinishesPlayback = false;
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('Audio', FakeAudio);
        vi.stubGlobal('URL', class extends URL {
            static createObjectURL = objects.created;
            static revokeObjectURL = objects.revoked;
        });
        vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
        installServer();
    });
    afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

    it('offers catalog-backed model and voice dropdowns without a technical voice text field', async () => {
        const { container } = render(<VoiceSettings businessId={7} />);
        await screen.findByLabelText('Режим голоса');
        selectNeuro();
        expect(modelField().tagName).toBe('SELECT');
        expect(voiceField().tagName).toBe('SELECT');
        expect(within(voiceField()).getByRole('option', { name: /Анна/ })).toHaveProperty('value', 'voice_anna');
        expect(within(voiceField()).getByRole('option', { name: /Борис/ })).toHaveProperty('value', 'voice_boris');
        expect(container.querySelector('input[type="text"],textarea')).toBeNull();
        expect(screen.queryByText(/AudioSocket|SIP|ADC|thinking/i)).toBeNull();
    });

    it('saves only the chosen voice fields, verifies a fresh GET, and restores them after remount', async () => {
        const stored = installServer();
        const first = render(<VoiceSettings businessId={7} />);
        await screen.findByLabelText('Режим голоса'); selectNeuro();
        fireEvent.change(modelField(), { target: { value: 'gemini-3.7-flash' } });
        fireEvent.change(voiceField(), { target: { value: 'voice_boris' } });
        save();
        await screen.findByText('Голос сохранён и проверен.');
        expect(writes()).toHaveLength(1);
        expect(body(writes()[0])).toEqual({ voiceAiProvider: 'neuro_gemini', voiceModel: 'gemini-3.7-flash', voiceName: 'voice_boris' });
        const writeIndex = fetchMock.mock.calls.findIndex(([, options]) => options?.method === 'PUT');
        expect(fetchMock.mock.calls.slice(writeIndex + 1).some(([input, options]) => String(input) === '/api/hotel-profiles/7' && (!options?.method || options.method === 'GET'))).toBe(true);
        expect(stored.get(7)?.systemPrompt).toBe('Keep the tenant instructions');
        expect(stored.get(7)?.aiModel).toBe('existing-text-ai');
        first.unmount(); render(<VoiceSettings businessId={7} />);
        await screen.findByLabelText('Режим голоса');
        expect(providerField().value).toBe('neuro_gemini');
        expect(modelField().value).toBe('gemini-3.7-flash');
        expect(voiceField().value).toBe('voice_boris');
    });

    it('does not confirm an acknowledged PUT when durable readback differs and preserves the draft', async () => {
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => options?.method === 'PUT'
            ? response({ success: true, profile: profile(7, 'neuro_gemini', { ...neuro, voiceName: 'voice_boris' }) }) : base(input, options));
        render(<VoiceSettings businessId={7} />); await screen.findByLabelText('Режим голоса');
        selectNeuro(); fireEvent.change(voiceField(), { target: { value: 'voice_boris' } }); save();
        expect((await voicePanel().findByRole('alert')).textContent).toContain('Сохранение не подтверждено');
        expect(providerField().value).toBe('neuro_gemini'); expect(voiceField().value).toBe('voice_boris');
        expect(screen.queryByText('Голос сохранён и проверен.')).toBeNull();
        expect(screen.getByRole('button', { name: 'Сохранить голос' })).toHaveProperty('disabled', false);
    });

    it('retains model and voice after a failed save, then clears the error after a successful retry', async () => {
        const base = fetchMock.getMockImplementation()!;
        let fail = true;
        fetchMock.mockImplementation((input, options) => options?.method === 'PUT' && fail
            ? response({ success: false, message: 'Provider unavailable' }, false) : base(input, options));
        render(<VoiceSettings businessId={7} />); await screen.findByLabelText('Режим голоса'); selectNeuro();
        fireEvent.change(modelField(), { target: { value: 'gemini-3.7-flash' } });
        fireEvent.change(voiceField(), { target: { value: 'voice_boris' } }); save();
        await voicePanel().findByRole('alert');
        expect(modelField().value).toBe('gemini-3.7-flash'); expect(voiceField().value).toBe('voice_boris');
        fail = false; save(); await screen.findByText('Голос сохранён и проверен.');
        expect(voicePanel().queryByRole('alert')).toBeNull();
    });

    it('can restore the original voice after the server writes a change but its acknowledgement is lost', async () => {
        const stored = installServer(); const base = fetchMock.getMockImplementation()!;
        let acknowledgementLost = true;
        fetchMock.mockImplementation(async (input, options) => {
            const result = await base(input, options);
            if (options?.method === 'PUT' && acknowledgementLost) {
                acknowledgementLost = false;
                throw new Error('Connection dropped after commit');
            }
            return result;
        });
        render(<VoiceSettings businessId={7} />); await screen.findByLabelText('Режим голоса');
        fireEvent.change(voiceField(), { target: { value: 'Puck' } }); save();
        await voicePanel().findByRole('alert');
        expect(stored.get(7)?.voiceName).toBe('Puck');
        fireEvent.change(voiceField(), { target: { value: 'Kore' } });
        expect(screen.getByRole('button', { name: 'Сохранить голос' })).toHaveProperty('disabled', false);
        save(); await screen.findByText('Голос сохранён и проверен.');
        expect(writes()).toHaveLength(2);
        expect(body(writes()[1])).toMatchObject({ voiceAiProvider: 'google_live', voiceName: 'Kore' });
        expect(stored.get(7)?.voiceName).toBe('Kore');
    });

    it('shows canonical configured defaults returned by save and durable readback', async () => {
        const stored = installServer(profile(7, 'neuro_gemini', { model: 'gemini-3.7-flash', voiceName: 'voice_boris' }));
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (input, options) => {
            if (options?.method === 'PUT') {
                stored.set(7, profile(7, 'neuro_gemini'));
                return response({ success: true, profile: stored.get(7) });
            }
            return base(input, options);
        });
        render(<VoiceSettings businessId={7} />); await screen.findByLabelText('Режим голоса');
        fireEvent.change(modelField(), { target: { value: '' } });
        fireEvent.change(voiceField(), { target: { value: '' } }); save();
        await screen.findByText('Голос сохранён и проверен.');
        expect(body(writes()[0])).toEqual({ voiceAiProvider: 'neuro_gemini', voiceModel: '', voiceName: '' });
        expect(modelField().value).toBe(neuro.model); expect(voiceField().value).toBe(neuro.voiceName);
    });

    it('does not confirm a default-provider reset when the server keeps the previously selected provider', async () => {
        installServer(profile(7, 'neuro_gemini'));
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => options?.method === 'PUT'
            ? response({ success: true, profile: profile(7, 'neuro_gemini') }) : base(input, options));
        render(<VoiceSettings businessId={7} />); await screen.findByLabelText('Режим голоса');
        fireEvent.change(providerField(), { target: { value: '' } }); save();
        expect((await voicePanel().findByRole('alert')).textContent).toContain('Сохранение не подтверждено');
        expect(body(writes()[0]).voiceAiProvider).toBe('');
        expect(providerField().value).toBe('');
        expect(modelField().value).toBe(google.model); expect(voiceField().value).toBe(google.voiceName);
        expect(screen.queryByText('Голос сохранён и проверен.')).toBeNull();
        expect(screen.getByRole('button', { name: 'Сохранить голос' })).toHaveProperty('disabled', false);
    });

    it.each(['model', 'voice'] as const)('does not confirm a blank %s reset when the server retains its previous nondefault value', async resetField => {
        const old = profile(7, 'neuro_gemini', { model: 'gemini-3.7-flash', voiceName: 'voice_boris' });
        installServer(old);
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => options?.method === 'PUT'
            ? response({ success: true, profile: old }) : base(input, options));
        render(<VoiceSettings businessId={7} />); await screen.findByLabelText('Режим голоса');
        fireEvent.change(resetField === 'model' ? modelField() : voiceField(), { target: { value: '' } }); save();
        expect((await voicePanel().findByRole('alert')).textContent).toContain('Сохранение не подтверждено');
        expect(body(writes()[0])[resetField === 'model' ? 'voiceModel' : 'voiceName']).toBe('');
        expect(modelField().value).toBe(resetField === 'model' ? '' : 'gemini-3.7-flash');
        expect(voiceField().value).toBe(resetField === 'voice' ? '' : 'voice_boris');
        expect(screen.queryByText('Голос сохранён и проверен.')).toBeNull();
        expect(screen.getByRole('button', { name: 'Сохранить голос' })).toHaveProperty('disabled', false);
    });

    it('restores provider-specific saved values when switching back and does not submit the previous provider values', async () => {
        render(<VoiceSettings businessId={7} />); await screen.findByLabelText('Режим голоса');
        fireEvent.change(voiceField(), { target: { value: 'Puck' } });
        selectNeuro();
        expect(modelField().value).toBe(neuro.model); expect(voiceField().value).toBe(neuro.voiceName);
        fireEvent.change(providerField(), { target: { value: 'google_live' } });
        expect(modelField().value).toBe(google.model); expect(voiceField().value).toBe('Puck');
        selectNeuro(); save(); await screen.findByText('Голос сохранён и проверен.');
        expect(body(writes()[0])).toMatchObject({ voiceAiProvider: 'neuro_gemini' });
        expect(body(writes()[0]).voiceModel).not.toBe(google.model);
        expect(body(writes()[0]).voiceName).not.toBe('Puck');
        expect(body(writes()[0]).voiceName).not.toBe(google.voiceName);
    });

    it('keeps a saved selection when the catalog is unavailable and recovers on retry', async () => {
        installServer(profile(7, 'neuro_gemini', { ...neuro, voiceName: 'voice_boris' }));
        const base = fetchMock.getMockImplementation()!;
        let unavailable = true;
        fetchMock.mockImplementation((input, options) => String(input).endsWith('/voice-options') && unavailable
            ? response({ success: false }, false) : base(input, options));
        render(<VoiceSettings businessId={7} />);
        expect((await voicePanel().findByRole('alert')).textContent).toMatch(/каталог/i);
        unavailable = false; retryCatalog();
        await screen.findByRole('option', { name: /Борис/ });
        expect(providerField().value).toBe('neuro_gemini'); expect(voiceField().value).toBe('voice_boris');
        expect(writes()).toHaveLength(0); expect(voicePanel().queryByRole('alert')).toBeNull();
    });

    it('preserves an edited model and voice across a failed catalog refresh and retry', async () => {
        const base = fetchMock.getMockImplementation()!;
        let fail = false;
        fetchMock.mockImplementation((input, options) => String(input).endsWith('/voice-options') && fail
            ? response({ success: false }, false) : base(input, options));
        render(<VoiceSettings businessId={7} />); await screen.findByLabelText('Режим голоса'); selectNeuro();
        fireEvent.change(modelField(), { target: { value: 'gemini-3.7-flash' } });
        fireEvent.change(voiceField(), { target: { value: 'voice_boris' } });
        fail = true; fireEvent.click(screen.getByRole('button', { name: 'Обновить каталог голосов' }));
        await voicePanel().findByRole('alert');
        expect(modelField().value).toBe('gemini-3.7-flash'); expect(voiceField().value).toBe('voice_boris');
        expect(screen.getByRole('button', { name: 'Сохранить голос' })).toHaveProperty('disabled', true);
        fail = false; retryCatalog();
        await waitFor(() => expect(voicePanel().queryByRole('alert')).toBeNull());
        expect(modelField().value).toBe('gemini-3.7-flash'); expect(voiceField().value).toBe('voice_boris');
        save(); await screen.findByText('Голос сохранён и проверен.');
    });

    it.each([
        ['employee', () => { session.role = 'manager'; }],
        ['owner without manage capability', () => { session.capabilities = ['business.read']; }],
        ['permissions refresh', () => { session.permissionsLoading = true; }],
        ['signed-out account', () => { session.authenticated = false; }],
    ])('does not allow preview or saving for %s', async (_name, changeSession) => {
        changeSession(); render(<VoiceSettings businessId={7} />);
        await act(async () => { await Promise.resolve(); });
        const saveButton = screen.queryByRole('button', { name: 'Сохранить голос' });
        const previewButton = screen.queryByRole('button', { name: 'Прослушать голос' });
        if (saveButton) { expect(saveButton).toHaveProperty('disabled', true); fireEvent.click(saveButton); }
        if (previewButton) { expect(previewButton).toHaveProperty('disabled', true); fireEvent.click(previewButton); }
        expect(writes()).toHaveLength(0); expect(previews()).toHaveLength(0);
    });

    it('preserves the draft during a temporary permissions refresh while disabling actions and stopping audio', async () => {
        const view = render(<VoiceSettings businessId={7} />); await screen.findByLabelText('Режим голоса'); selectNeuro();
        fireEvent.change(voiceField(), { target: { value: 'voice_boris' } }); preview();
        await screen.findByRole('button', { name: 'Остановить' });
        session.permissionsLoading = true; view.rerender(<VoiceSettings businessId={7} />);
        expect(players[0].pause).toHaveBeenCalled(); expect(objects.revoked).toHaveBeenCalledWith('blob:voice-preview');
        expect(providerField()).toHaveProperty('disabled', true);
        expect(screen.getByRole('button', { name: 'Прослушать голос' })).toHaveProperty('disabled', true);
        expect(screen.getByRole('button', { name: 'Сохранить голос' })).toHaveProperty('disabled', true);
        session.permissionsLoading = false; view.rerender(<VoiceSettings businessId={7} />);
        expect(providerField().value).toBe('neuro_gemini'); expect(voiceField().value).toBe('voice_boris');
        expect(screen.getByRole('button', { name: 'Сохранить голос' })).toHaveProperty('disabled', false);
        expect(writes()).toHaveLength(0);
    });

    it('lets an employee read the persisted voice while keeping all selectors disabled', async () => {
        installServer(profile(7, 'neuro_gemini', { ...neuro, voiceName: 'voice_boris' }));
        session.role = 'manager'; render(<VoiceSettings businessId={7} />);
        await screen.findByLabelText('Режим голоса');
        expect(providerField().value).toBe('neuro_gemini'); expect(voiceField().value).toBe('voice_boris');
        expect(providerField()).toHaveProperty('disabled', true); expect(modelField()).toHaveProperty('disabled', true);
        expect(voiceField()).toHaveProperty('disabled', true);
        expect(screen.queryByRole('button', { name: 'Сохранить голос' })).toBeNull();
    });

    it('rejects a profile returned for a different business rather than rendering its settings', async () => {
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => String(input).endsWith('/voice-options')
            ? base(input, options) : response({ success: true, profile: profile(8, 'neuro_gemini') }));
        render(<VoiceSettings businessId={7} />);
        await voicePanel().findByRole('alert');
        expect(screen.queryByLabelText('Режим голоса')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Сохранить голос' })).toBeNull();
        expect(writes()).toHaveLength(0);
        expect(screen.queryByText('Business 8')).toBeNull();
    });

    it('rejects a catalog returned for a different business and does not enable editing', async () => {
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => String(input).endsWith('/voice-options')
            ? response(catalog(8)) : base(input, options));
        render(<VoiceSettings businessId={7} />);
        expect((await voicePanel().findByRole('alert')).textContent).toMatch(/каталог/i);
        expect(providerField()).toHaveProperty('disabled', true); expect(voiceField()).toHaveProperty('disabled', true);
        expect(writes()).toHaveLength(0);
    });

    it('ignores a late catalog response after the business changes and aborts its request', async () => {
        const late = deferred<Response>(); const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => String(input) === '/api/hotel-profiles/7/voice-options'
            ? late.promise : base(input, options));
        const view = render(<VoiceSettings businessId={7} />);
        await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/7/voice-options'))).toBe(true));
        const old = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/7/voice-options'))!;
        view.rerender(<VoiceSettings businessId={8} />); await screen.findByLabelText('Режим голоса');
        await act(async () => { late.resolve(await response({ ...catalog(7), providers: [{ ...catalog(7).providers[0], label: 'Stale catalog' }] })); });
        expect(old[1]?.signal?.aborted).toBe(true);
        expect(providerField().value).toBe('neuro_gemini'); expect(voiceField().value).toBe('voice_boris');
        expect(screen.queryByRole('option', { name: 'Stale catalog' })).toBeNull();
    });

    it('ignores profile and catalog responses from the previous account at the same business', async () => {
        const oldProfile = deferred<Response>(); const oldCatalog = deferred<Response>(); const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => session.userId === 'owner-1'
            ? (String(input).endsWith('/voice-options') ? oldCatalog.promise : oldProfile.promise) : base(input, options));
        const view = render(<VoiceSettings businessId={7} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        session.userId = 'owner-2'; view.rerender(<VoiceSettings businessId={7} />);
        await screen.findByLabelText('Режим голоса');
        await act(async () => {
            oldProfile.resolve(await response({ success: true, profile: profile(7, 'neuro_gemini') }));
            oldCatalog.resolve(await response(catalog(7)));
        });
        expect(providerField().value).toBe('google_live'); expect(voiceField().value).toBe('Kore');
        expect(voicePanel().queryByRole('alert')).toBeNull();
    });

    it.each(['business', 'account', 'permission'] as const)('does not apply a late save after a %s switch', async switchKind => {
        const late = deferred<Response>(); const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => options?.method === 'PUT' ? late.promise : base(input, options));
        const view = render(<VoiceSettings businessId={7} />);
        await screen.findByLabelText('Режим голоса'); selectNeuro(); save();
        await waitFor(() => expect(writes()).toHaveLength(1));
        const old = writes()[0];
        if (switchKind === 'account') session.userId = 'owner-2';
        if (switchKind === 'permission') session.role = 'manager';
        view.rerender(<VoiceSettings businessId={switchKind === 'business' ? 8 : 7} />);
        await act(async () => { late.resolve(await response({ success: true, profile: profile(7, 'neuro_gemini') })); });
        expect(old[1]?.signal?.aborted).toBe(true);
        expect(screen.queryByText('Голос сохранён и проверен.')).toBeNull();
        if (switchKind !== 'permission') {
            await screen.findByLabelText('Режим голоса');
            expect(voiceField().value).toBe(switchKind === 'business' ? 'voice_boris' : 'Kore');
        }
    });

    it('sends the selected provider and voice to preview and releases audio when stopped', async () => {
        render(<VoiceSettings businessId={7} />); await screen.findByLabelText('Режим голоса'); selectNeuro();
        fireEvent.change(voiceField(), { target: { value: 'voice_boris' } }); preview();
        await screen.findByRole('button', { name: 'Остановить' });
        expect(body(previews()[0])).toEqual({ provider: 'neuro_gemini', voiceName: 'voice_boris' });
        expect(players).toHaveLength(1); expect(players[0].play).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole('button', { name: 'Остановить' }));
        expect(players[0].pause).toHaveBeenCalled(); expect(objects.revoked).toHaveBeenCalledWith('blob:voice-preview');
    });

    it.each(['voice', 'provider', 'unmount'] as const)('stops and releases the previous audio on %s change', async change => {
        const view = render(<VoiceSettings businessId={7} />); await screen.findByLabelText('Режим голоса'); selectNeuro(); preview();
        await screen.findByRole('button', { name: 'Остановить' });
        const player = players[0];
        if (change === 'voice') fireEvent.change(voiceField(), { target: { value: 'voice_boris' } });
        if (change === 'provider') fireEvent.change(providerField(), { target: { value: 'google_live' } });
        if (change === 'unmount') view.unmount();
        expect(player.pause).toHaveBeenCalled(); expect(objects.revoked).toHaveBeenCalledWith('blob:voice-preview');
    });

    it.each(['business', 'provider', 'voice', 'account', 'permission', 'unmount'] as const)('does not start late preview audio after a %s switch', async switchKind => {
        const late = deferred<Response>(); const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => String(input).endsWith('/voice-preview') ? late.promise : base(input, options));
        const view = render(<VoiceSettings businessId={7} />); await screen.findByLabelText('Режим голоса'); selectNeuro(); preview();
        await waitFor(() => expect(previews()).toHaveLength(1));
        const old = previews()[0];
        if (switchKind === 'provider') fireEvent.change(providerField(), { target: { value: 'google_live' } });
        else if (switchKind === 'voice') fireEvent.change(voiceField(), { target: { value: 'voice_boris' } });
        else if (switchKind === 'unmount') view.unmount();
        else {
            if (switchKind === 'account') session.userId = 'owner-2';
            if (switchKind === 'permission') session.role = 'manager';
            view.rerender(<VoiceSettings businessId={switchKind === 'business' ? 8 : 7} />);
        }
        await act(async () => { late.resolve(await audioResponse()); });
        expect(old[1]?.signal?.aborted).toBe(true); expect(players).toHaveLength(0);
        expect(objects.created).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Остановить' })).toBeNull();
    });

    it('reports a failed preview without erasing edits and permits retry', async () => {
        const base = fetchMock.getMockImplementation()!;
        let fail = true;
        fetchMock.mockImplementation((input, options) => String(input).endsWith('/voice-preview') && fail
            ? response({ success: false }, false) : base(input, options));
        render(<VoiceSettings businessId={7} />); await screen.findByLabelText('Режим голоса'); selectNeuro();
        fireEvent.change(voiceField(), { target: { value: 'voice_boris' } }); preview();
        expect((await voicePanel().findByRole('alert')).textContent).toContain('Не удалось прослушать');
        expect(voiceField().value).toBe('voice_boris'); expect(players).toHaveLength(0);
        fail = false; preview(); await screen.findByRole('button', { name: 'Остановить' });
        expect(voicePanel().queryByRole('alert')).toBeNull();
    });

    it('bounds a catalog request that never returns and offers retry', async () => {
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => String(input).endsWith('/voice-options') ? abortableResponse(options) : base(input, options));
        vi.useFakeTimers(); render(<VoiceSettings businessId={7} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(30001); });
        expect(voicePanel().getByRole('alert').textContent).toMatch(/каталог/i);
        expect(screen.getByRole('button', { name: 'Повторить загрузку каталога' })).toHaveProperty('disabled', false);
        expect(writes()).toHaveLength(0);
    });

    it('bounds a save request that never returns while keeping its draft and retry', async () => {
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => options?.method === 'PUT' ? abortableResponse(options) : base(input, options));
        render(<VoiceSettings businessId={7} />); await screen.findByLabelText('Режим голоса'); selectNeuro();
        fireEvent.change(voiceField(), { target: { value: 'voice_boris' } });
        vi.useFakeTimers(); save();
        await act(async () => { await vi.advanceTimersByTimeAsync(30001); });
        expect(voicePanel().getByRole('alert').textContent).toContain('Сохранение не подтверждено');
        expect(voiceField().value).toBe('voice_boris');
        expect(screen.getByRole('button', { name: 'Сохранить голос' })).toHaveProperty('disabled', false);
        expect(screen.queryByText('Голос сохранён и проверен.')).toBeNull();
    });

    it('bounds a preview request that never returns and leaves the voice available for retry', async () => {
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => String(input).endsWith('/voice-preview') ? abortableResponse(options) : base(input, options));
        render(<VoiceSettings businessId={7} />); await screen.findByLabelText('Режим голоса'); selectNeuro();
        vi.useFakeTimers(); preview();
        await act(async () => { await vi.advanceTimersByTimeAsync(25001); });
        expect(voicePanel().getByRole('alert').textContent).toContain('Не удалось прослушать');
        expect(screen.getByRole('button', { name: 'Прослушать голос' })).toHaveProperty('disabled', false);
        expect(players).toHaveLength(0);
    });

    it('bounds playback when the browser never resolves play and releases its audio', async () => {
        render(<VoiceSettings businessId={7} />); await screen.findByLabelText('Режим голоса'); selectNeuro();
        neverFinishesPlayback = true; vi.useFakeTimers();
        await act(async () => { preview(); });
        expect(players).toHaveLength(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(30001); });
        expect(voicePanel().getByRole('alert').textContent).toMatch(/Не удалось завершить прослушивание/);
        expect(players[0].pause).toHaveBeenCalled(); expect(objects.revoked).toHaveBeenCalledWith('blob:voice-preview');
        expect(screen.getByRole('button', { name: 'Прослушать голос' })).toHaveProperty('disabled', false);
    });
});
