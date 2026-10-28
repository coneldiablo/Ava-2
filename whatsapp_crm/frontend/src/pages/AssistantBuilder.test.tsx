// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AssistantBuilder, { AssistantDraftEditor } from './AssistantBuilder';

// Text provider selection has its own persistence/race acceptance suite.
vi.mock('../components/AiModelSettings', () => ({ default: () => <div>AI вашего бизнеса</div> }));

const shared = vi.hoisted(() => ({ businessId: 7, userId: 'owner-1', role: 'hotel_owner', refresh: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ authenticated: true, userId: shared.userId, memberships: [7, 8].map(businessId => ({ businessId, role: shared.role, capabilities: ['business.read', 'business.manage'] })) }) }));
vi.mock('../context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: shared.businessId, refreshInstances: shared.refresh }) }));
const profile = (businessId = 7, systemPrompt = 'Active instructions') => ({ businessId, followupAutoSendEnabled: false, followupAutoSendRevision: 0, name: `Business ${businessId}`, systemPrompt, hotelTone: '', voiceName: '', voiceGreetingTemplate: '', outboundOpenerTemplate: '' });
const draft = (text = 'Draft instructions', status = 'draft') => ({ id: 'draft-7', status, links: ['https://example.com'], supplement: 'A café', systemPrompt: text, sources: [{ url: 'https://example.com', title: 'Our café', status: 'read' }] });
const response = (data: unknown, ok = true) => Promise.resolve({ ok, json: async () => data } as Response);
const fetchMock = vi.fn<typeof fetch>();
const voiceCatalog = { defaultProvider: 'google_live', providers: ['google_live', 'yandex_realtime'].map(id => ({ id, label: id === 'google_live' ? 'Google Live' : 'Яндекс', available: true, models: [], voices: [] })) };
function installFetch(restored: (ReturnType<typeof draft> & { suggestedSettings?: Record<string, unknown> }) | null = null) {
    fetchMock.mockImplementation((input, options) => {
        const url = String(input);
        const businessId = Number(url.match(/hotel-profiles\/(\d+)/)?.[1]);
        if (!options?.body) return response(url.endsWith('/assistant-draft') ? { success: true, businessId, draft: businessId === 7 ? restored : null } : { success: true, profile: profile(businessId) });
        return response({ success: false }, false);
    });
}
function installApproval(stored: ReturnType<typeof profile>, approved = draft(stored.systemPrompt, 'approved')) {
    const base = fetchMock.getMockImplementation()!;
    let applied = false;
    fetchMock.mockImplementation((input, options) => {
        if (String(input).endsWith('/approve')) {
            applied = true;
            return response({ success: true, businessId: 7, profile: stored, draft: approved });
        }
        if (applied && /hotel-profiles\/7$/.test(String(input)) && !options?.body) return response({ success: true, profile: stored });
        return base(input, options);
    });
}
const promptField = () => screen.getByLabelText('Инструкции ассистента') as HTMLTextAreaElement;

describe('AssistantBuilder', () => {
    beforeEach(() => {
        shared.businessId = 7; shared.userId = 'owner-1'; shared.role = 'hotel_owner'; shared.refresh.mockClear(); fetchMock.mockReset(); sessionStorage.clear();
        vi.stubGlobal('fetch', (input: RequestInfo | URL, options?: RequestInit) => String(input).endsWith('/voice-options') ? response(voiceCatalog) : fetchMock(input, options));
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
        installFetch();
    });
    afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

    it('does not show a cancelled StrictMode load as a failure', async () => {
        installFetch(draft());
        render(<StrictMode><AssistantBuilder /></StrictMode>);
        await screen.findByLabelText('Инструкции ассистента');
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('restores a persisted draft after remount without changing active instructions', async () => {
        installFetch(draft());
        const first = render(<AssistantBuilder />);
        await screen.findByLabelText('Инструкции ассистента');
        expect(promptField().value).toBe('Draft instructions');
        expect((screen.getByLabelText('Текущие инструкции') as HTMLTextAreaElement).value).toBe('Active instructions');
        first.unmount();
        render(<AssistantBuilder />);
        await screen.findByLabelText('Инструкции ассистента');
        expect(promptField().value).toBe('Draft instructions');
        expect(fetchMock.mock.calls.every(([, options]) => !options?.body)).toBe(true);
    });

    it('shows actionable generation failure and never announces success', async () => {
        render(<AssistantBuilder />);
        fireEvent.change(await screen.findByLabelText('Ссылки на страницы бизнеса'), { target: { value: 'https://example.com' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подготовить инструкции' }));
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('Проверьте доступность ссылок');
        expect(screen.queryByLabelText('Инструкции ассистента')).toBeNull();
        expect(screen.queryByText(/Сохранено\. Ассистент/)).toBeNull();
        expect(shared.refresh).not.toHaveBeenCalled();
    });

    it('approves the edited text and displays the authoritative saved profile', async () => {
        installFetch(draft());
        installApproval({ ...profile(7, 'Edited instructions'), name: 'Stored café name' });
        render(<AssistantBuilder />);
        await screen.findByLabelText('Инструкции ассистента');
        fireEvent.change(promptField(), { target: { value: 'Edited instructions' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и сохранить' }));
        await screen.findByText('Сохранено. Ассистент использует эти инструкции.');
        const approval = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/approve'))!;
        expect(JSON.parse(String(approval[1]?.body))).toEqual({ draftId: 'draft-7', systemPrompt: 'Edited instructions' });
        expect((screen.getByLabelText('Текущие инструкции') as HTMLTextAreaElement).value).toBe('Edited instructions');
        expect((screen.getByLabelText('Название бизнеса') as HTMLTextAreaElement).value).toBe('Stored café name');
        expect((screen.getByRole('button', { name: 'Сохранено' }) as HTMLButtonElement).disabled).toBe(true);
        expect(shared.refresh).toHaveBeenCalledOnce();
    });

    it('retains edits and reports unconfirmed saving on failure', async () => {
        installFetch(draft()); render(<AssistantBuilder />);
        await screen.findByLabelText('Инструкции ассистента');
        fireEvent.change(promptField(), { target: { value: 'Keep this edit' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и сохранить' }));
        expect((await screen.findByRole('alert')).textContent).toContain('Сохранение не подтверждено');
        expect(promptField().value).toBe('Keep this edit');
        expect(screen.queryByText(/Сохранено\. Ассистент/)).toBeNull();
        expect(shared.refresh).not.toHaveBeenCalled();
    });

    it('keeps restored approved drafts read-only while manual editing remains available', async () => {
        installFetch(draft('Already approved', 'approved'));
        render(<AssistantBuilder />);
        await screen.findByLabelText('Инструкции ассистента');
        expect(promptField().disabled).toBe(true);
        const approve = screen.getByRole('button', { name: 'Сохранено' }) as HTMLButtonElement;
        expect(approve.disabled).toBe(true);
        fireEvent.click(approve);
        expect(fetchMock.mock.calls.every(([, options]) => !options?.body)).toBe(true);
        const manual = screen.getByLabelText('Текущие инструкции') as HTMLTextAreaElement;
        expect(manual.disabled).toBe(false);
        fireEvent.change(manual, { target: { value: 'Manual update' } });
        expect(manual.value).toBe('Manual update');
        expect((screen.getByRole('button', { name: 'Сохранить ручные настройки' }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('accepts server canonicalization of leading and trailing whitespace', async () => {
        installFetch(draft());
        installApproval(profile(7, 'Canonical instructions'));
        render(<AssistantBuilder />);
        await screen.findByLabelText('Инструкции ассистента');
        fireEvent.change(promptField(), { target: { value: '  Canonical instructions\n  ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и сохранить' }));
        await screen.findByText('Сохранено. Ассистент использует эти инструкции.');
        const approval = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/approve'))!;
        expect(JSON.parse(String(approval[1]?.body)).systemPrompt).toBe('Canonical instructions');
        expect(promptField().value).toBe('Canonical instructions');
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('surfaces an actionable public backend failure without a false save confirmation', async () => {
        installFetch(draft());
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => String(input).endsWith('/approve') ? response({ success: false, message: 'Черновик изменился. Загрузите его снова.' }, false) : base(input, options));
        render(<AssistantBuilder />);
        await screen.findByLabelText('Инструкции ассистента');
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и сохранить' }));
        expect((await screen.findByRole('alert')).textContent).toContain('Черновик изменился. Загрузите его снова.');
        expect(screen.queryByText(/Сохранено\. Ассистент/)).toBeNull();
        expect(shared.refresh).not.toHaveBeenCalled();
    });

    it('rejects a success response whose saved text differs from the approved edit', async () => {
        installFetch(draft());
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => String(input).endsWith('/approve') ? response({ success: true, businessId: 7, profile: profile(7, 'Unexpected text'), draft: draft('Unexpected text', 'approved') }) : base(input, options));
        render(<AssistantBuilder />); await screen.findByLabelText('Инструкции ассистента');
        fireEvent.change(promptField(), { target: { value: 'My approved text' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и сохранить' }));
        await screen.findByRole('alert');
        expect(promptField().value).toBe('My approved text');
        expect(screen.queryByText(/Сохранено\. Ассистент/)).toBeNull();
        expect(shared.refresh).not.toHaveBeenCalled();
    });

    it('keeps approval unconfirmed when the saved profile still has the previous instructions', async () => {
        installFetch(draft());
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => String(input).endsWith('/approve')
            ? response({ success: true, businessId: 7, profile: profile(7, 'Draft instructions'), draft: draft('Draft instructions', 'approved') })
            : base(input, options));
        const approved = vi.fn();
        render(<AssistantDraftEditor businessId={7} embedded onApprovalChange={approved} />);
        await screen.findByLabelText('Инструкции ассистента');
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и сохранить' }));
        await screen.findByRole('alert');
        expect(promptField().value).toBe('Draft instructions');
        expect(approved).not.toHaveBeenCalledWith(true);
        expect(shared.refresh).not.toHaveBeenCalled();
    });

    it('saves Yandex selection with a durable readback and preserves instructions', async () => {
        let stored = { ...profile(), voiceAiProvider: 'google_live' };
        fetchMock.mockImplementation((input, options) => {
            if (String(input).endsWith('/assistant-draft')) return response({ success: true, businessId: 7, draft: null });
            if (options?.method === 'PUT') stored = { ...stored, ...JSON.parse(String(options.body)) };
            return response({ success: true, profile: stored });
        });
        const view = render(<AssistantBuilder />);
        const select = await screen.findByLabelText('Режим голоса');
        fireEvent.change(screen.getByLabelText('Текущие инструкции'), { target: { value: 'Unsaved manual instructions' } });
        fireEvent.change(select, { target: { value: 'yandex_realtime' } });
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить голос' }));
        await screen.findByText('Голос сохранён и проверен.');
        expect(stored.systemPrompt).toBe('Active instructions');
        expect(stored.voiceAiProvider).toBe('yandex_realtime');
        expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
        expect(JSON.parse(String(fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT')![1]?.body))).toEqual({ voiceAiProvider: 'yandex_realtime', voiceModel: '', voiceName: '' });
        expect((screen.getByLabelText('Текущие инструкции') as HTMLTextAreaElement).value).toBe('Unsaved manual instructions');
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить ручные настройки' }));
        await screen.findByText('Ручные настройки сохранены.');
        expect(stored.systemPrompt).toBe('Unsaved manual instructions');
        expect(stored.voiceAiProvider).toBe('yandex_realtime');
        expect(JSON.parse(String(fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT')[1][1]?.body))).toEqual({ systemPrompt: 'Unsaved manual instructions' });
        view.unmount(); render(<AssistantBuilder />);
        expect((await screen.findByLabelText('Режим голоса') as HTMLSelectElement).value).toBe('yandex_realtime');
    });

    it('rejects an unpersisted voice selection and keeps the edit available', async () => {
        fetchMock.mockImplementation((input) => String(input).endsWith('/assistant-draft') ? response({ success: true, businessId: 7, draft: null }) : response({ success: true, profile: { ...profile(), voiceAiProvider: 'google_live' } }));
        render(<AssistantBuilder />);
        fireEvent.change(await screen.findByLabelText('Режим голоса'), { target: { value: 'yandex_realtime' } });
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить голос' }));
        await screen.findByRole('alert');
        expect((screen.getByLabelText('Режим голоса') as HTMLSelectElement).value).toBe('yandex_realtime');
        expect(screen.queryByText('Голос сохранён и проверен.')).toBeNull();
        expect(shared.refresh).not.toHaveBeenCalled();
    });

    it('aborts old generation on business switch and ignores its late response', async () => {
        let resolveGeneration!: (value: Response) => void;
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => options?.body ? new Promise<Response>(resolve => { resolveGeneration = resolve; }) : base(input, options));
        const view = render(<AssistantBuilder />);
        fireEvent.change(await screen.findByLabelText('Ссылки на страницы бизнеса'), { target: { value: 'https://old-business.example' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подготовить инструкции' }));
        await waitFor(() => expect(resolveGeneration).toBeTruthy());
        const signal = fetchMock.mock.calls.find(([, options]) => options?.body)?.[1]?.signal;
        shared.businessId = 8; view.rerender(<AssistantBuilder />);
        await screen.findByLabelText('Ссылки на страницы бизнеса');
        expect(signal?.aborted).toBe(true);
        await act(async () => resolveGeneration(await response({ success: true, businessId: 7, draft: draft('Old business secrets') })));
        expect((screen.getByLabelText('Ссылки на страницы бизнеса') as HTMLTextAreaElement).value).toBe('');
        expect(screen.queryByLabelText('Инструкции ассистента')).toBeNull();
        expect(screen.queryByText('Old business secrets')).toBeNull();
        expect((screen.getByLabelText('Название бизнеса') as HTMLTextAreaElement).value).toBe('Business 8');
    });
    it('keeps the embedded editor focused on links and review without owner advanced settings', async () => {
        render(<AssistantDraftEditor businessId={7} embedded />);
        await screen.findByLabelText('Ссылки на страницы бизнеса');
        expect(screen.queryByRole('heading', { name: 'Ваш бизнес. Его голос.' })).toBeNull();
        expect(screen.queryByRole('navigation')).toBeNull();
        expect(screen.queryByLabelText('Режим голоса')).toBeNull();
        const supplement = screen.getByLabelText('Описание бизнеса (необязательно)');
        expect(supplement.closest('details')?.open).toBe(false);
    });

    it('preserves links and description across failure, retry loading, back and remount', async () => {
        const view = render(<AssistantDraftEditor businessId={7} embedded />);
        fireEvent.change(await screen.findByLabelText('Ссылки на страницы бизнеса'), { target: { value: 'https://keep.example' } });
        fireEvent.change(screen.getByLabelText('Описание бизнеса (необязательно)'), { target: { value: 'Keep our business description' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подготовить инструкции' }));
        await screen.findByRole('alert');
        expect(screen.getByLabelText('Описание бизнеса (необязательно)').closest('details')?.open).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
        await waitFor(() => expect((screen.getByRole('button', { name: 'Подготовить инструкции' }) as HTMLButtonElement).disabled).toBe(false));
        expect((screen.getByLabelText('Ссылки на страницы бизнеса') as HTMLTextAreaElement).value).toBe('https://keep.example');
        view.unmount();
        render(<AssistantDraftEditor businessId={7} embedded />);
        expect((await screen.findByLabelText('Ссылки на страницы бизнеса') as HTMLTextAreaElement).value).toBe('https://keep.example');
        expect((screen.getByLabelText('Описание бизнеса (необязательно)') as HTMLTextAreaElement).value).toBe('Keep our business description');
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => options?.body ? response({ success: true, businessId: 7, draft: draft() }) : base(input, options));
        fireEvent.click(screen.getByRole('button', { name: 'Подготовить инструкции' }));
        await screen.findByLabelText('Инструкции ассистента');
        fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
        expect((screen.getByLabelText('Ссылки на страницы бизнеса') as HTMLTextAreaElement).value).toBe('https://keep.example');
    });

    it('isolates unsent session edits between authenticated users and businesses', async () => {
        const view = render(<AssistantDraftEditor businessId={7} embedded />);
        fireEvent.change(await screen.findByLabelText('Ссылки на страницы бизнеса'), { target: { value: 'https://owner-one.example' } });
        view.rerender(<AssistantDraftEditor businessId={8} embedded />);
        expect((await screen.findByLabelText('Ссылки на страницы бизнеса') as HTMLTextAreaElement).value).toBe('');
        view.rerender(<AssistantDraftEditor businessId={7} embedded />);
        expect((await screen.findByLabelText('Ссылки на страницы бизнеса') as HTMLTextAreaElement).value).toBe('https://owner-one.example');
        shared.userId = 'owner-2'; view.rerender(<AssistantDraftEditor businessId={7} embedded />);
        expect((await screen.findByLabelText('Ссылки на страницы бизнеса') as HTMLTextAreaElement).value).toBe('');
    });

    it('ignores invalid stored edits and unavailable session storage', async () => {
        sessionStorage.setItem('ava:assistant-edits:v1:owner-1:7', '{broken');
        const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
        try {
            render(<AssistantDraftEditor businessId={7} embedded />);
            fireEvent.change(await screen.findByLabelText('Ссылки на страницы бизнеса'), { target: { value: 'https://editable.example' } });
            expect((screen.getByLabelText('Ссылки на страницы бизнеса') as HTMLTextAreaElement).value).toBe('https://editable.example');
            expect(screen.queryByRole('alert')).toBeNull();
        } finally { storage.mockRestore(); }
    });

    it('restores prompt, manual edits and opted-in settings and sends only approved proposals', async () => {
        const proposed = { ...draft(), suggestedSettings: { hotelTone: 'Friendly', hotelTimezone: 'Europe/Moscow', voiceGreetingTemplate: 'Hello' } };
        installFetch(proposed);
        const view = render(<AssistantBuilder />);
        fireEvent.change(await screen.findByLabelText('Инструкции ассистента'), { target: { value: 'Review this edited prompt' } });
        fireEvent.change(screen.getByLabelText('Название бизнеса'), { target: { value: 'Unsent business name' } });
        fireEvent.click(screen.getByRole('checkbox', { name: 'Применить: Тон общения' }));
        fireEvent.change(screen.getByLabelText('Предложение: Тон общения'), { target: { value: 'Warm and concise' } });
        expect((screen.getByRole('checkbox', { name: 'Применить: Часовой пояс' }) as HTMLInputElement).checked).toBe(false);
        view.unmount(); render(<AssistantBuilder />);
        expect((await screen.findByLabelText('Инструкции ассистента') as HTMLTextAreaElement).value).toBe('Review this edited prompt');
        expect((screen.getByLabelText('Название бизнеса') as HTMLTextAreaElement).value).toBe('Unsent business name');
        expect((screen.getByRole('checkbox', { name: 'Применить: Тон общения' }) as HTMLInputElement).checked).toBe(true);
        expect((screen.getByLabelText('Предложение: Тон общения') as HTMLTextAreaElement).value).toBe('Warm and concise');
        installApproval({ ...profile(7, 'Review this edited prompt'), hotelTone: 'Warm and concise' });
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и сохранить' }));
        await screen.findByText('Сохранено. Ассистент использует эти инструкции.');
        const approval = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/approve'))!;
        expect(JSON.parse(String(approval[1]?.body))).toEqual({ draftId: 'draft-7', systemPrompt: 'Review this edited prompt', settings: { hotelTone: 'Warm and concise' } });
    });

    it('does not confirm approval when selected settings differ from the server response', async () => {
        installFetch({ ...draft(), suggestedSettings: { hotelTone: 'Friendly' } });
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => String(input).endsWith('/approve') ? response({ success: true, businessId: 7, profile: profile(7, 'Draft instructions'), draft: draft('Draft instructions', 'approved') }) : base(input, options));
        const approved = vi.fn(); render(<AssistantDraftEditor businessId={7} embedded onApprovalChange={approved} />);
        fireEvent.click(await screen.findByRole('checkbox', { name: 'Применить: Тон общения' }));
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и сохранить' }));
        await screen.findByRole('alert');
        expect(approved).not.toHaveBeenCalledWith(true);
        expect(screen.queryByText('Сохранено. Ассистент использует эти инструкции.')).toBeNull();
    });

    it('only reports verified current approval and clears it on edit and unmount', async () => {
        installFetch(draft('Active instructions', 'approved'));
        const approved = vi.fn(); const view = render(<AssistantDraftEditor businessId={7} onApprovalChange={approved} />);
        expect(approved).toHaveBeenLastCalledWith(false);
        await screen.findByLabelText('Инструкции ассистента');
        expect(approved).toHaveBeenLastCalledWith(true);
        fireEvent.change(screen.getByLabelText('Текущие инструкции'), { target: { value: 'Unsent manual prompt' } });
        expect(approved).toHaveBeenLastCalledWith(false);
        view.unmount(); expect(approved).toHaveBeenLastCalledWith(false);
    });

    it('keeps completion closed while visible manual instructions have unsaved changes', async () => {
        installFetch(draft('Active instructions', 'approved'));
        const standalone = render(<AssistantBuilder />);
        await screen.findByLabelText('Текущие инструкции');
        fireEvent.change(screen.getByLabelText('Текущие инструкции'), { target: { value: 'Unsent manual instructions' } });
        standalone.unmount();
        const approved = vi.fn();
        const embedded = render(<AssistantDraftEditor businessId={7} embedded onApprovalChange={approved} />);
        await screen.findByLabelText('Инструкции ассистента');
        await waitFor(() => expect(approved).toHaveBeenLastCalledWith(false));
        expect(promptField().value).toBe('Active instructions');
        expect(screen.queryByLabelText('Текущие инструкции')).toBeNull();
        expect(fetchMock.mock.calls.every(([, options]) => !options?.body)).toBe(true);
        expect(sessionStorage.getItem('ava:assistant-edits:v1:owner-1:7')).toContain('Unsent manual instructions');
        embedded.unmount();
        render(<AssistantBuilder />);
        expect((await screen.findByLabelText('Текущие инструкции') as HTMLTextAreaElement).value).toBe('Unsent manual instructions');
    });

    it('keeps invited managers read-only even with a manage capability fixture', async () => {
        shared.role = 'manager'; installFetch(draft('Active instructions', 'approved'));
        const approved = vi.fn(); render(<AssistantDraftEditor businessId={7} embedded onApprovalChange={approved} />);
        await screen.findByLabelText('Инструкции ассистента');
        expect(promptField().disabled).toBe(true);
        expect(screen.queryByRole('button', { name: 'Сохранено' })).toBeNull();
        expect(approved).not.toHaveBeenCalledWith(true);
    });

    it('keeps a replaced draft edit in a recovery copy across reload and restores only by explicit choice', async () => {
        let current = draft();
        fetchMock.mockImplementation((input, options) => options?.body
            ? response({ success: false, message: 'Черновик устарел. Откройте последнюю инструкцию.' }, false)
            : response(String(input).endsWith('/assistant-draft') ? { success: true, businessId: 7, draft: current } : { success: true, profile: profile() }));
        const view = render(<AssistantBuilder />);
        fireEvent.change(await screen.findByLabelText('Инструкции ассистента'), { target: { value: 'Unique unsent owner text' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и сохранить' }));
        await screen.findByRole('alert');
        current = { ...draft('Replacement instructions'), id: 'replacement-8' };
        fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
        await waitFor(() => expect(promptField().value).toBe('Replacement instructions'));
        expect((screen.getByLabelText('Сохранённая копия 1') as HTMLTextAreaElement).value).toBe('Unique unsent owner text');
        expect(sessionStorage.getItem('ava:assistant-edits:v1:owner-1:7')).toContain('Unique unsent owner text');
        view.unmount(); render(<AssistantBuilder />);
        await screen.findByLabelText('Инструкции ассистента');
        expect(promptField().value).toBe('Replacement instructions');
        fireEvent.click(screen.getByText('Несохранённый текст (1)'));
        fireEvent.click(screen.getByRole('button', { name: 'Восстановить текст 1' }));
        expect(promptField().value).toBe('Unique unsent owner text');
        installApproval(profile(7, 'Unique unsent owner text'), { ...current, status: 'approved', systemPrompt: 'Unique unsent owner text' });
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и сохранить' }));
        await screen.findByText('Сохранено. Ассистент использует эти инструкции.');
        const approvals = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/approve'));
        const approval = approvals[approvals.length - 1]!;
        expect(JSON.parse(String(approval[1]?.body))).toMatchObject({ draftId: 'replacement-8', systemPrompt: 'Unique unsent owner text' });
    });

    it('preserves unsent manual fields after prompt approval and saves them separately', async () => {
        let stored = profile();
        fetchMock.mockImplementation((input, options) => {
            if (String(input).endsWith('/approve')) {
                stored = profile(7, 'Draft instructions');
                return response({ success: true, businessId: 7, profile: stored, draft: draft('Draft instructions', 'approved') });
            }
            if (options?.method === 'PUT') stored = { ...stored, ...JSON.parse(String(options.body)) };
            return response(String(input).endsWith('/assistant-draft') ? { success: true, businessId: 7, draft: draft() } : { success: true, profile: stored });
        });
        render(<AssistantBuilder />);
        await screen.findByLabelText('Инструкции ассистента');
        fireEvent.change(screen.getByLabelText('Название бизнеса'), { target: { value: 'Unique pending name' } });
        fireEvent.change(screen.getByLabelText('Текущие инструкции'), { target: { value: 'Pending manual instructions' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и сохранить' }));
        await screen.findByText('Сохранено. Ассистент использует эти инструкции.');
        expect((screen.getByLabelText('Название бизнеса') as HTMLTextAreaElement).value).toBe('Unique pending name');
        expect((screen.getByLabelText('Текущие инструкции') as HTMLTextAreaElement).value).toBe('Pending manual instructions');
        expect(stored.name).toBe('Business 7');
        expect(stored.systemPrompt).toBe('Draft instructions');
        expect(sessionStorage.getItem('ava:assistant-edits:v1:owner-1:7')).toContain('Unique pending name');
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить ручные настройки' }));
        await screen.findByText('Ручные настройки сохранены.');
        expect(stored.name).toBe('Unique pending name');
        expect(stored.systemPrompt).toBe('Pending manual instructions');
        const manual = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT')!;
        expect(JSON.parse(String(manual[1]?.body))).toEqual({ name: 'Unique pending name', systemPrompt: 'Pending manual instructions' });
    });

    it('ends a stalled generation at the 75 second deadline and preserves the input', async () => {
        render(<AssistantDraftEditor businessId={7} embedded />);
        fireEvent.change(await screen.findByLabelText('Ссылки на страницы бизнеса'), { target: { value: 'https://slow.example' } });
        const base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => options?.body ? new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))) : base(input, options));
        vi.useFakeTimers();
        fireEvent.click(screen.getByRole('button', { name: 'Подготовить инструкции' }));
        expect(screen.getByRole('status').textContent).toContain('Читаем страницы');
        await act(async () => { await vi.advanceTimersByTimeAsync(75000); });
        expect(screen.getByRole('alert').textContent).toContain('Не удалось подготовить инструкции');
        expect((screen.getByLabelText('Ссылки на страницы бизнеса') as HTMLTextAreaElement).value).toBe('https://slow.example');
        expect((screen.getByRole('button', { name: 'Повторить попытку' }) as HTMLButtonElement).disabled).toBe(false);
    });

});

describe('manual instructions in first-run setup', () => {
    beforeEach(() => {
        shared.businessId = 7; shared.userId = 'owner-1'; shared.role = 'hotel_owner'; fetchMock.mockReset(); sessionStorage.clear();
        vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; }); installFetch();
    });
    afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
    it('creates an editable manual draft without generation and activates it only after approval plus readback', async () => {
        const text = 'Помогайте клиентам выбрать электропастуха. Цены берите из каталога.';
        const base = fetchMock.getMockImplementation()!; let applied = false;
        fetchMock.mockImplementation((input, options) => {
            const url = String(input);
            if (url.endsWith('/assistant-draft/manual')) return response({ success: true, businessId: 7, draft: { ...draft(text), links: [], sources: [], supplement: '' } });
            if (url.endsWith('/approve')) { applied = true; return response({ success: true, businessId: 7, profile: profile(7, text), draft: draft(text, 'approved') }); }
            if (applied && /hotel-profiles\/7$/.test(url) && !options?.body) return response({ success: true, profile: profile(7, text) });
            return base(input, options);
        });
        const approval = vi.fn(); render(<AssistantDraftEditor businessId={7} embedded onApprovalChange={approval} />);
        fireEvent.change(await screen.findByLabelText('Ваши инструкции ассистенту'), { target: { value: text } });
        fireEvent.click(screen.getByRole('button', { name: 'Проверить ручные инструкции' }));
        await screen.findByLabelText('Инструкции ассистента');
        expect(fetchMock.mock.calls.some(([url, options]) => String(url).endsWith('/assistant-draft') && options?.body)).toBe(false);
        expect(applied).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и сохранить' }));
        await screen.findByText('Сохранено. Ассистент использует эти инструкции.');
        expect(approval).toHaveBeenLastCalledWith(true);
        expect(fetchMock.mock.calls.filter(([url, options]) => /hotel-profiles\/7$/.test(String(url)) && !options?.body).length).toBeGreaterThan(1);
    });
});
