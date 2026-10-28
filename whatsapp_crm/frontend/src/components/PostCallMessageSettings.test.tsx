// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PostCallMessageSettings from './PostCallMessageSettings';

const fetchMock = vi.fn<typeof fetch>();
const profile = (businessId = 7, enabled = false, revision = 0) => ({ success: true,
    profile: { businessId, followupAutoSendEnabled: enabled, followupAutoSendRevision: revision } });
const response = (data: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status,
    json: async () => structuredClone(data) } as Response);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const panel = () => within(screen.getByRole('region', { name: 'После звонка' }));
const choice = () => panel().getByRole('checkbox', { name: 'Отправлять запрошенные сообщения автоматически' }) as HTMLInputElement;
const save = () => fireEvent.click(panel().getByRole('button', { name: 'Сохранить' }));
const reload = () => fireEvent.click(panel().getByRole('button', { name: 'Обновить настройки сообщения' }));
const writes = () => fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT');
const body = (index: number) => JSON.parse(String(writes()[index][1]?.body));
const form = (businessId = 7, canRead = true, canEdit = true) => <PostCallMessageSettings businessId={businessId} canRead={canRead} canEdit={canEdit} />;
function server() {
    const stored = new Map([[7, profile()], [8, profile(8, true, 4)]]);
    fetchMock.mockImplementation(async (input, options) => {
        if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const id = Number(String(input).match(/hotel-profiles\/(\d+)$/)?.[1]);
        const current = stored.get(id);
        if (!current) return response({}, 404);
        if (options?.method === 'PUT') {
            const patch = JSON.parse(String(options.body));
            if (patch.expectedFollowupRevision !== current.profile.followupAutoSendRevision) return response({}, 409);
            stored.set(id, profile(id, patch.followupAutoSendEnabled, patch.expectedFollowupRevision + 1));
        }
        return response(stored.get(id));
    });
    return stored;
}

describe('Post-call WhatsApp policy', () => {
    beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); server(); });
    afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

    it('uses the scoped GET, writes the boolean with its revision and verifies fresh canonical readback', async () => {
        const stored = server(), view = render(form());
        await panel().findByRole('checkbox');
        expect(choice().checked).toBe(false);
        expect(fetchMock.mock.calls[0][0]).toBe('/api/hotel-profiles/7');
        expect(fetchMock.mock.calls[0][1]?.credentials).toBe('same-origin');
        fireEvent.click(choice()); save();
        await panel().findByText('Сохранено. Изменение действует для новых звонков.');
        expect(writes()).toHaveLength(1);
        expect(body(0)).toEqual({ followupAutoSendEnabled: true, expectedFollowupRevision: 0 });
        expect(writes()[0][0]).toBe('/api/hotel-profiles/7');
        expect(writes()[0][1]?.credentials).toBe('same-origin');
        const index = fetchMock.mock.calls.findIndex(([, options]) => options?.method === 'PUT');
        expect(fetchMock.mock.calls.slice(index + 1).some(([url, options]) => url === '/api/hotel-profiles/7' && !options?.method)).toBe(true);
        expect(stored.get(7)).toEqual(profile(7, true, 1));
        view.unmount(); render(form()); await panel().findByRole('checkbox');
        expect(choice().checked).toBe(true);
        fireEvent.click(choice()); save();
        await panel().findByText('Сохранено. Изменение действует для новых звонков.');
        expect(body(1)).toEqual({ followupAutoSendEnabled: false, expectedFollowupRevision: 1 });
        expect(stored.get(7)).toEqual(profile(7, false, 2));
    });

    it('does not fetch without read access and renders a manager read-only without any writes', async () => {
        const view = render(form(7, false, false));
        expect(screen.queryByRole('region')).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
        view.rerender(form(7, true, false)); await panel().findByRole('checkbox');
        expect(choice().closest('fieldset')?.disabled).toBe(true);
        expect(panel().queryByRole('button', { name: 'Сохранить' })).toBeNull();
        expect(writes()).toHaveLength(0);
    });

    it('does not overwrite on 409 and requires explicit canonical reload before the next change', async () => {
        const stored = server(); render(form()); await panel().findByRole('checkbox');
        fireEvent.click(choice()); stored.set(7, profile(7, true, 1)); save();
        expect((await panel().findByRole('alert')).textContent).toContain('Настройки уже изменились');
        expect(choice().checked).toBe(true); expect(choice().closest('fieldset')?.disabled).toBe(true);
        save(); expect(writes()).toHaveLength(1);
        expect(fetchMock.mock.calls.filter(([, options]) => !options?.method)).toHaveLength(1);
        reload(); await waitFor(() => expect(choice().closest('fieldset')?.disabled).toBe(false));
        fireEvent.click(choice()); save();
        await panel().findByText('Сохранено. Изменение действует для новых звонков.');
        expect(body(1)).toEqual({ followupAutoSendEnabled: false, expectedFollowupRevision: 1 });
    });

    it('aborts and ignores both a late GET and a late save when switching business', async () => {
        const oldGet = deferred<Response>(), base = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => String(input).endsWith('/7') ? oldGet.promise : base(input, options));
        const first = render(form());
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const oldReadSignal = fetchMock.mock.calls[0][1]?.signal;
        first.rerender(form(8)); await panel().findByRole('checkbox');
        expect(choice().checked).toBe(true); expect(oldReadSignal?.aborted).toBe(true);
        await act(async () => { oldGet.resolve(response(profile())); });
        expect(choice().checked).toBe(true); expect(writes()).toHaveLength(0);
        first.unmount(); fetchMock.mockClear();

        const stored = server(), lateSave = deferred<Response>(), normal = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation((input, options) => options?.method === 'PUT' && String(input).endsWith('/7') ? lateSave.promise : normal(input, options));
        const second = render(form()); await panel().findByRole('checkbox');
        fireEvent.click(choice()); save(); await waitFor(() => expect(writes()).toHaveLength(1));
        const oldWriteSignal = writes()[0][1]?.signal;
        second.rerender(form(8)); await panel().findByRole('checkbox');
        expect(oldWriteSignal?.aborted).toBe(true); expect(choice().checked).toBe(true);
        await act(async () => { lateSave.resolve(response(profile(7, true, 1))); });
        expect(choice().checked).toBe(true); expect(panel().queryByRole('alert')).toBeNull();
        expect(panel().queryByText(/Сохранено/)).toBeNull();
        fireEvent.click(choice()); save(); await panel().findByText('Сохранено. Изменение действует для новых звонков.');
        expect(writes()[1][0]).toBe('/api/hotel-profiles/8');
        expect(body(1)).toEqual({ followupAutoSendEnabled: false, expectedFollowupRevision: 4 });
        expect(stored.get(8)).toEqual(profile(8, false, 5));
    });

    it('keeps the choice on failure and permits a deliberate retry after reading the actual mode', async () => {
        const normal = fetchMock.getMockImplementation()!; let unavailable = true;
        fetchMock.mockImplementation((input, options) => options?.method === 'PUT' && unavailable ? Promise.resolve(response({}, 503)) : normal(input, options));
        render(form()); await panel().findByRole('checkbox'); fireEvent.click(choice()); save();
        expect((await panel().findByRole('alert')).textContent).toContain('Не удалось подтвердить сохранение');
        expect(choice().checked).toBe(true); expect(choice().closest('fieldset')?.disabled).toBe(true);
        expect(panel().queryByText(/Сохранено/)).toBeNull();
        unavailable = false; reload(); await waitFor(() => expect(choice().closest('fieldset')?.disabled).toBe(false));
        expect(choice().checked).toBe(false); fireEvent.click(choice()); save();
        await panel().findByText('Сохранено. Изменение действует для новых звонков.');
        expect(writes()).toHaveLength(2); expect(body(1).expectedFollowupRevision).toBe(0);
    });

    it('fails closed on missing/invalid/scoped fields and never trusts an invalid canonical readback', async () => {
        for (const fields of [{ followupAutoSendEnabled: undefined }, { followupAutoSendEnabled: 'false' },
            { followupAutoSendRevision: undefined }, { followupAutoSendRevision: -1 },
            { followupAutoSendRevision: .5 }, { businessId: 8 }]) {
            fetchMock.mockResolvedValue(response({ success: true, profile: { ...profile().profile, ...fields } }));
            const view = render(form()); await panel().findByRole('alert');
            expect(panel().queryByRole('checkbox')).toBeNull(); expect(writes()).toHaveLength(0); view.unmount();
        }
        fetchMock.mockReset(); server(); const normal = fetchMock.getMockImplementation()!; let written = false;
        fetchMock.mockImplementation(async (input, options) => {
            if (options?.method === 'PUT') { written = true; return normal(input, options); }
            return written ? response(profile(7, true, 0)) : normal(input, options);
        });
        render(form()); await panel().findByRole('checkbox'); fireEvent.click(choice()); save();
        await panel().findByRole('alert'); expect(panel().queryByText(/Сохранено/)).toBeNull();
        expect(choice().closest('fieldset')?.disabled).toBe(true);
    });

    it('recovers a lost acknowledgement after the server enabled sending and can explicitly turn it off', async () => {
        const stored = server(), normal = fetchMock.getMockImplementation()!; let acknowledgementLost = true;
        fetchMock.mockImplementation(async (input, options) => {
            const result = await normal(input, options);
            if (options?.method === 'PUT' && acknowledgementLost) { acknowledgementLost = false; throw Error('Lost acknowledgement after commit'); }
            return result;
        });
        render(form()); await panel().findByRole('checkbox'); fireEvent.click(choice()); save();
        await panel().findByRole('alert');
        expect(stored.get(7)).toEqual(profile(7, true, 1));
        expect(choice().checked).toBe(true); expect(choice().closest('fieldset')?.disabled).toBe(true);
        save(); expect(writes()).toHaveLength(1);
        reload(); await waitFor(() => expect(choice().closest('fieldset')?.disabled).toBe(false));
        expect(choice().checked).toBe(true); fireEvent.click(choice()); save();
        await panel().findByText('Сохранено. Изменение действует для новых звонков.');
        expect(body(1)).toEqual({ followupAutoSendEnabled: false, expectedFollowupRevision: 1 });
        expect(stored.get(7)).toEqual(profile(7, false, 2));
    });
});
