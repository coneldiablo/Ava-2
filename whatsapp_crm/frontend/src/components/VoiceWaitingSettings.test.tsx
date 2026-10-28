// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import VoiceWaitingSettings from './VoiceWaitingSettings';

type Waiting = { enabled: boolean; phrases: string[]; afterSeconds: number; repeatSeconds: number; maxMessages: number };
const initial: Waiting = { enabled: true, phrases: ['Секунду, пожалуйста.'], afterSeconds: 3, repeatSeconds: 15, maxMessages: 1 };
const profile = (businessId = 7, waiting: Waiting = initial, provider = 'neuro_gemini') => ({ success: true, profile: { businessId, voiceAiProvider: provider, voiceWaiting: waiting } });
const response = (value: unknown, code = 200) => ({ ok: code < 400, status: code, json: async () => value } as Response);
const fetchMock = vi.fn<typeof fetch>();
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const writes = () => fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT');
function form(businessId = 7, canEdit = true, revision = 0) { return <VoiceWaitingSettings businessId={businessId} canRead canEdit={canEdit} revision={revision} />; }
function server() {
    const stored = new Map([[7, profile()], [8, profile(8, { ...initial, phrases: ['Фраза второго бизнеса.'] })]]);
    fetchMock.mockImplementation(async (input, options) => {
        const id = Number(String(input).match(/hotel-profiles\/(\d+)/)?.[1]);
        if (options?.method === 'PUT') {
            const body = JSON.parse(String(options.body));
            stored.set(id, profile(id, body.voiceWaiting));
        }
        return response(stored.get(id));
    });
    return stored;
}
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
const textarea = () => screen.getByLabelText('Что говорить') as HTMLTextAreaElement;

describe('Voice waiting client settings', () => {
    beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); server(); });
    afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

    it('saves custom phrases with the loaded provider, confirms GET readback and restores them after remount', async () => {
        const stored = server(), first = render(form());
        await screen.findByLabelText('Что говорить');
        fireEvent.change(textarea(), { target: { value: 'Уточняю ваш вопрос.\nСейчас проверю.' } });
        save(); await screen.findByText('Сохранено для следующих звонков.');
        expect(writes()).toHaveLength(1);
        expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ voiceWaiting: { ...initial, phrases: ['Уточняю ваш вопрос.', 'Сейчас проверю.'] }, expectedVoiceProvider: 'neuro_gemini' });
        expect(stored.get(7)?.profile.voiceWaiting.phrases).toEqual(['Уточняю ваш вопрос.', 'Сейчас проверю.']);
        first.unmount(); render(form()); await screen.findByLabelText('Что говорить');
        expect(textarea().value).toBe('Уточняю ваш вопрос.\nСейчас проверю.');
    });

    it('allows silent waiting and preserves the saved text when phrases are disabled', async () => {
        render(form()); await screen.findByLabelText('Что говорить');
        fireEvent.change(textarea(), { target: { value: 'Сейчас уточню.' } });
        fireEvent.click(screen.getByLabelText('Произносить фразу ожидания'));
        expect(screen.queryByLabelText('Что говорить')).toBeNull();
        save(); await screen.findByText('Сохранено для следующих звонков.');
        expect(JSON.parse(String(writes()[0][1]?.body)).voiceWaiting).toEqual({ ...initial, phrases: ['Сейчас уточню.'], enabled: false });
    });

    it('can disable waiting after clearing the phrase draft', async () => {
        render(form()); await screen.findByLabelText('Что говорить');
        fireEvent.change(textarea(), { target: { value: '' } });
        fireEvent.click(screen.getByLabelText('Произносить фразу ожидания'));
        save(); await screen.findByText('Сохранено для следующих звонков.');
        expect(JSON.parse(String(writes()[0][1]?.body)).voiceWaiting).toEqual({ ...initial, enabled: false });
    });

    it('shows a timed out load and can retry without leaving a blank form', async () => {
        fetchMock.mockRejectedValueOnce(new DOMException('Timed out', 'AbortError'));
        render(form());
        expect((await screen.findByRole('alert')).textContent).toContain('Не удалось загрузить');
        fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
        await screen.findByLabelText('Что говорить');
        expect(textarea().value).toBe(initial.phrases[0]);
    });

    it('retains the edited draft on an error and confirms a later retry', async () => {
        const implementation = fetchMock.getMockImplementation()!; let fail = true;
        fetchMock.mockImplementation((input, options) => options?.method === 'PUT' && fail ? Promise.resolve(response({}, 503)) : implementation(input, options));
        render(form()); await screen.findByLabelText('Что говорить'); fireEvent.change(textarea(), { target: { value: 'Не терять этот текст.' } }); save();
        expect((await screen.findByRole('alert')).textContent).toContain('Ваш текст остался');
        expect(textarea().value).toBe('Не терять этот текст.'); expect(screen.queryByText('Сохранено для следующих звонков.')).toBeNull();
        fail = false; save(); await screen.findByText('Сохранено для следующих звонков.');
    });

    it('does not confirm a PUT whose canonical readback disagrees and retains the draft', async () => {
        const implementation = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => options?.method === 'PUT' ? Promise.resolve(response({ success: true })) : implementation(input, options));
        render(form()); await screen.findByLabelText('Что говорить'); fireEvent.change(textarea(), { target: { value: 'Мой новый текст.' } }); save();
        expect((await screen.findByRole('alert')).textContent).toContain('Сохранение не подтверждено');
        expect(textarea().value).toBe('Мой новый текст.'); expect(screen.queryByText('Сохранено для следующих звонков.')).toBeNull();
    });

    it('renders a manager read-only, does not write and hides unsupported provider controls', async () => {
        const view = render(form(7, false)); await screen.findByLabelText('Что говорить');
        expect(textarea().closest('fieldset')?.disabled).toBe(true); save(); expect(writes()).toHaveLength(0);
        view.unmount(); fetchMock.mockResolvedValue(response(profile(7, initial, 'yandex_realtime')));
        render(form()); await waitFor(() => expect(screen.queryByText('Когда AVA готовит ответ')).toBeNull());
    });

    it('disables the old business form until the new business has loaded', async () => {
        const second = deferred<Response>();
        fetchMock.mockImplementation(async input => {
            if (String(input).endsWith('/8')) return second.promise;
            return response(profile());
        });
        const view = render(form()); await screen.findByLabelText('Что говорить');
        fireEvent.change(textarea(), { target: { value: 'Текст первого бизнеса.' } });
        view.rerender(form(8));
        const button = screen.queryByRole('button', { name: 'Сохранить' });
        if (button) fireEvent.click(button);
        expect(writes()).toHaveLength(0);
        await act(async () => { second.resolve(response(profile(8, { ...initial, phrases: ['Второй бизнес.'] }))); });
        expect((await screen.findByLabelText('Что говорить') as HTMLTextAreaElement).value).toBe('Второй бизнес.');
    });

    it('ignores a previous business GET that resolves after the new business GET', async () => {
        const first = deferred<Response>();
        fetchMock.mockImplementation(async input => String(input).endsWith('/7') ? first.promise : response(profile(8, { ...initial, phrases: ['Второй бизнес.'] })));
        const view = render(form()); view.rerender(form(8));
        await screen.findByLabelText('Что говорить'); expect(textarea().value).toBe('Второй бизнес.');
        await act(async () => { first.resolve(response(profile(7, { ...initial, phrases: ['Поздний первый бизнес.'] }))); });
        expect(textarea().value).toBe('Второй бизнес.');
    });

    it('aborts an in-flight old-business save and does not show its result or overwrite the new business state', async () => {
        const pending = deferred<Response>(), implementation = fetchMock.getMockImplementation()!; let oldSignal: AbortSignal | null | undefined;
        fetchMock.mockImplementation((input, options) => {
            if (options?.method === 'PUT') { oldSignal = options.signal; return pending.promise; }
            return implementation(input, options);
        });
        const view = render(form()); await screen.findByLabelText('Что говорить'); fireEvent.change(textarea(), { target: { value: 'Сохранение первого бизнеса.' } }); save();
        view.rerender(form(8));
        await waitFor(() => expect((screen.getByLabelText('Что говорить') as HTMLTextAreaElement).value).toBe('Фраза второго бизнеса.'));
        expect(oldSignal?.aborted).toBe(true);
        await act(async () => { pending.resolve(response({ success: true })); });
        expect(textarea().value).toBe('Фраза второго бизнеса.');
        expect(screen.queryByText('Сохранено для следующих звонков.')).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
