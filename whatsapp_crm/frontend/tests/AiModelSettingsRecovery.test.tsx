// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AiModelSettings from '../src/components/AiModelSettings';
import CustomerSetup from '../src/pages/CustomerSetup';

const fixture = vi.hoisted(() => ({
    businessId: 4, canEdit: true, permissionsLoading: false, userId: 'owner', instances: [] as any[], server: new Map<number, any>(),
    refreshInstances: vi.fn(),
    api: {
        getAiModels: vi.fn(), getAiProviders: vi.fn(), updateInstance: vi.fn(), getInstances: vi.fn(),
        getOpenWaStatus: vi.fn(), getOpenWaQR: vi.fn(), logoutOpenWa: vi.fn(),
        connectWhatsApp: vi.fn(), replaceWhatsApp: vi.fn(),
    },
}));
vi.mock('../src/api/telephony',()=>({getTelephony:vi.fn(async()=>({managedMode:false}))}));
vi.mock('../src/api', () => fixture.api);
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({
    currentInstanceId: fixture.businessId, currentInstance: fixture.server.get(fixture.businessId), instances: fixture.instances, refreshInstances: fixture.refreshInstances,
}) }));
vi.mock('../src/components/BusinessSetupStatus', () => ({ default: () => null }));
vi.mock('../src/components/ModuleNavigation', () => ({ default: () => null }));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ authenticated: true, permissionsLoading: fixture.permissionsLoading, userId: fixture.userId, role: 'customer', memberships: [{ businessId: fixture.businessId, role: fixture.canEdit ? 'hotel_owner' : 'manager', capabilities: ['business.read', ...(fixture.canEdit ? ['business.manage'] : [])] }] }) }));

const savedFour = 'legacy/tenant-four:2026-08';
const savedNineteen = 'provider/tenant-nineteen-v1';
const selected = 'provider/new-model:2026-09';
const catalogFour = { success: true, models: [{ id: selected, name: 'Новая модель' }, { id: 'provider/second', name: 'Вторая модель' }] };
const catalogNineteen = { success: true, models: [{ id: savedNineteen, name: 'Модель бизнеса 19' }, { id: 'provider/nineteen-extra' }] };
const missingSavedModelStatus = 'Сохранённая модель сейчас отсутствует в списке. Можно выбрать другую модель.';
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
function modelSelect() { return screen.getByRole('combobox', { name: 'Модель AITunnel' }) as HTMLSelectElement; }
function modelIds() { return within(modelSelect()).getAllByRole('option').map(option => (option as HTMLOptionElement).value); }
function saveButton() { return screen.getByRole('button', { name: /Сохранить модель|Сохраняем|Сохранение/ }); }
function showSettings() { return render(<AiModelSettings key={fixture.businessId} businessId={fixture.businessId} canEdit={fixture.canEdit} />); }
function retryCatalog() { return screen.getByRole('button', { name: 'Обновить список моделей' }); }
async function selectNewModel() {
    await waitFor(() => expect(modelIds()).toContain(selected));
    fireEvent.change(modelSelect(), { target: { value: selected } });
    expect(modelSelect().value).toBe(selected);
}

beforeEach(() => {
    vi.resetAllMocks();
    fixture.businessId = 4;
    fixture.canEdit = true;
    fixture.userId = 'owner';
    fixture.permissionsLoading = false;
    fixture.instances = [
        { id: 4, name: 'Бизнес четыре', businessType: 'standard', aiProvider: 'yandex', yandexGptModelUri: savedFour, whatsappProvider: 'openwa' },
        { id: 19, name: 'Бизнес девятнадцать', businessType: 'standard', aiProvider: 'yandex', yandexGptModelUri: savedNineteen, whatsappProvider: 'openwa' },
    ];
    fixture.server = new Map(fixture.instances.map(instance => [instance.id, { ...instance }]));
    fixture.api.getAiProviders.mockResolvedValue({ success: true, providers: [{ id: 'aitunnel', name: 'AITunnel', configured: true, defaultModel: 'gpt-oss-120b' }, { id: 'gemini', name: 'Gemini', configured: true, defaultModel: 'gemini-3.8-flash' }] });
    fixture.api.getAiModels.mockImplementation((id: number) => Promise.resolve(id === 4 ? catalogFour : catalogNineteen));
    fixture.api.updateInstance.mockImplementation((id: number, data: any) => {
        fixture.server.set(id, { ...fixture.server.get(id), ...data });
        return Promise.resolve({ success: true, instance: { ...fixture.server.get(id) } });
    });
    fixture.api.getInstances.mockImplementation(() => Promise.resolve({ success: true, instances: [...fixture.server.values()].map(instance => ({ ...instance })) }));
    fixture.refreshInstances.mockImplementation(async () => { fixture.instances = [...fixture.server.values()].map(instance => ({ ...instance })); });
    fixture.api.getOpenWaStatus.mockResolvedValue({ success: true, state: { stateInstance: 'notConfigured' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/voice-options') ? { providers: [], defaultProvider: '' } : { success: true, profile: { businessId: fixture.businessId, name: 'Fixture бизнес', hotelTimezone: 'Europe/Moscow' } } })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AITunnel model selection and confirmed saving', () => {
    it.each([true, false])('mounts the real model settings in CustomerSetup with owner edit access=%s', async canEdit => {
        fixture.canEdit = canEdit;
        render(<MemoryRouter initialEntries={['/integrations']}><CustomerSetup /></MemoryRouter>);
        await waitFor(() => expect(modelSelect().value).toBe(savedFour));
        expect(fixture.api.getAiModels).toHaveBeenCalledWith(4, expect.any(AbortSignal), 'aitunnel');
        expect(fixture.api.getInstances).toHaveBeenCalledWith(expect.any(AbortSignal));
        expect(modelSelect().disabled).toBe(!canEdit);
        const button = screen.queryByRole('button', { name: 'Сохранить модель' });
        if (canEdit) {
            expect(button).toBeTruthy();
            await selectNewModel();
            fireEvent.click(button!);
            expect(await screen.findByText(/Модель сохранена|Модель успешно сохранена/)).toBeTruthy();
            expect(fixture.api.updateInstance).toHaveBeenCalledWith(4, { yandexGptModelUri: selected }, expect.any(AbortSignal));
        } else {
            expect(button === null || button.hasAttribute('disabled')).toBe(true);
            expect(fixture.api.updateInstance).not.toHaveBeenCalled();
        }
    });

    it('ignores a late initial saved-model response after the customer switches business', async () => {
        const old = deferred<{ success: boolean; instances: any[] }>();
        fixture.api.getInstances.mockReturnValueOnce(old.promise);
        const view = showSettings();
        const signal = fixture.api.getInstances.mock.calls[0][0] as AbortSignal;
        fixture.businessId = 19;
        view.rerender(<AiModelSettings key={fixture.businessId} businessId={fixture.businessId} canEdit />);
        await waitFor(() => expect(modelSelect().value).toBe(savedNineteen));
        expect(signal.aborted).toBe(true);
        await act(async () => { old.resolve({ success: true, instances: [{ id: 4, yandexGptModelUri: savedFour }] }); });
        expect(modelSelect().value).toBe(savedNineteen);
        expect(modelIds()).not.toContain(savedFour);
        expect(fixture.api.updateInstance).not.toHaveBeenCalled();
    });

    it.each([
        ['failed saved-settings envelope', { success: false }],
        ['missing tenant record', { success: true, instances: [{ id: 19, yandexGptModelUri: savedNineteen }] }],
        ['non-string saved model', { success: true, instances: [{ id: 4, yandexGptModelUri: 91 }] }],
    ])('blocks changes after %s and reloads the confirmed value on retry', async (_label, response) => {
        fixture.api.getInstances.mockResolvedValueOnce(response);
        showSettings();
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(modelSelect().value).toBe('');
        expect(modelSelect().disabled).toBe(true);
        expect(saveButton().hasAttribute('disabled')).toBe(true);
        expect(fixture.api.updateInstance).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку модели' }));
        await waitFor(() => expect(modelSelect().value).toBe(savedFour));
        expect(screen.queryByRole('alert')).toBeNull();
        expect(fixture.api.getInstances).toHaveBeenCalledTimes(2);
    });

    it('keeps the exact saved model while the catalogue is loading and after a stale catalogue arrives', async () => {
        const pending = deferred<typeof catalogFour>();
        fixture.api.getAiModels.mockReturnValueOnce(pending.promise);
        showSettings();
        expect(modelSelect().tagName).toBe('SELECT');
        await waitFor(() => expect(modelSelect().value).toBe(savedFour));
        expect(modelIds()).toContain(savedFour);
        expect(screen.queryByText(missingSavedModelStatus)).toBeNull();
        expect(fixture.api.getAiModels).toHaveBeenCalledWith(4, expect.any(AbortSignal), 'aitunnel');
        expect(fixture.api.updateInstance).not.toHaveBeenCalled();
        await act(async () => { pending.resolve(catalogFour); });
        await waitFor(() => expect(modelIds()).toContain(selected));
        expect(modelSelect().value).toBe(savedFour);
        expect(modelIds().filter(id => id === savedFour)).toHaveLength(1);
        expect(screen.getByText(missingSavedModelStatus).getAttribute('role')).toBe('status');
        expect(fixture.api.updateInstance).not.toHaveBeenCalled();
    });

    it('saves the exact selected ID, confirms durable readback, and restores it after remount', async () => {
        const view = showSettings();
        await selectNewModel();
        fireEvent.click(saveButton());
        expect(await screen.findByText(/Модель сохранена|Модель успешно сохранена/)).toBeTruthy();
        expect(fixture.api.updateInstance).toHaveBeenCalledWith(4, { yandexGptModelUri: selected }, expect.any(AbortSignal));
        expect(fixture.api.getInstances).toHaveBeenCalledWith(expect.any(AbortSignal));
        expect(fixture.refreshInstances).toHaveBeenCalledTimes(1);
        expect(fixture.server.get(4).yandexGptModelUri).toBe(selected);
        expect(fixture.server.get(19).yandexGptModelUri).toBe(savedNineteen);
        view.unmount();
        showSettings();
        await waitFor(() => expect(modelSelect().value).toBe(selected));
        expect(modelIds()).toContain(selected);
    });

    it('does not claim success until the stored instance has been read back', async () => {
        const readback = deferred<{ success: boolean; instances: any[] }>();
        showSettings();
        await selectNewModel();
        fixture.api.getInstances.mockReturnValueOnce(readback.promise);
        fireEvent.click(saveButton());
        await waitFor(() => expect(fixture.api.getInstances).toHaveBeenCalledTimes(2));
        expect(screen.queryByText(/Модель сохранена|Модель успешно сохранена/)).toBeNull();
        expect(fixture.refreshInstances).not.toHaveBeenCalled();
        await act(async () => { readback.resolve({ success: true, instances: [{ ...fixture.server.get(4) }] }); });
        expect(await screen.findByText(/Модель сохранена|Модель успешно сохранена/)).toBeTruthy();
    });

    it('preserves a missing catalogue model without inventing a fallback or sending a save', async () => {
        showSettings();
        await waitFor(() => expect(modelSelect().value).toBe(savedFour));
        expect(modelIds()).toEqual([savedFour, selected, 'provider/second']);
        expect(within(modelSelect()).getByRole('option', { name: `${savedFour} — сохранённая модель` })).toHaveProperty('value', savedFour);
        expect(screen.getByText(missingSavedModelStatus).getAttribute('role')).toBe('status');
        expect(saveButton().hasAttribute('disabled')).toBe(true);
        expect(fixture.api.updateInstance).not.toHaveBeenCalled();
    });

    it('allows returning to the saved model missing from the catalogue before sending a save', async () => {
        showSettings();
        await selectNewModel();
        const oldOption = within(modelSelect()).getByRole('option', { name: `${savedFour} — сохранённая модель` });
        expect(oldOption).toHaveProperty('value', savedFour);
        fireEvent.change(modelSelect(), { target: { value: savedFour } });
        expect(modelSelect().value).toBe(savedFour);
        expect(saveButton().hasAttribute('disabled')).toBe(true);
        expect(screen.getByText(missingSavedModelStatus)).toBeTruthy();
        expect(fixture.api.updateInstance).not.toHaveBeenCalled();
    });

    it('does not auto-select a catalogue entry when the saved model is empty', async () => {
        fixture.server.get(4).yandexGptModelUri = '';
        showSettings();
        await waitFor(() => expect(modelIds()).toContain(selected));
        expect(modelSelect().value).toBe('');
        expect(modelIds()).not.toContain('gpt-oss-120b');
        expect(fixture.api.updateInstance).not.toHaveBeenCalled();
    });

    it('reports a catalogue error safely, preserves the value, and permits retry', async () => {
        fixture.api.getAiModels.mockRejectedValueOnce({ response: { data: { error: 'Provider rejected sk-fixture-secret at internal.gateway' } } });
        showSettings();
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.queryByText(/sk-fixture-secret|internal.gateway|Provider rejected/)).toBeNull();
        expect(screen.queryByText(missingSavedModelStatus)).toBeNull();
        expect(modelSelect().value).toBe(savedFour);
        fireEvent.click(retryCatalog());
        await waitFor(() => expect(modelIds()).toContain(selected));
        expect(screen.queryByRole('alert')).toBeNull();
        expect(modelSelect().value).toBe(savedFour);
        expect(screen.getByText(missingSavedModelStatus)).toBeTruthy();
        expect(fixture.api.getAiModels).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['failed envelope', { success: false, models: catalogFour.models, error: 'Private provider failure' }],
        ['missing array', { success: true }],
        ['invalid entries', { success: true, models: [{ name: 'Missing ID' }] }],
        ['empty ID', { success: true, models: [{ id: '' }] }],
        ['null response', null],
    ])('keeps a %s catalogue response in error', async (_label, response) => {
        fixture.api.getAiModels.mockResolvedValueOnce(response);
        showSettings();
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(modelSelect().value).toBe(savedFour);
        expect(modelIds().filter(Boolean)).toEqual([savedFour]);
        expect(screen.queryByText('Private provider failure')).toBeNull();
    });

    it.each([
        ['failed save', { success: false }],
        ['malformed save', {}],
        ['missing saved instance', { success: true }],
        ['wrong saved tenant', { success: true, instance: { id: 19, yandexGptModelUri: selected } }],
        ['different acknowledged model', { success: true, instance: { id: 4, yandexGptModelUri: savedFour } }],
    ])('does not report success for a %s response', async (_label, response) => {
        fixture.api.updateInstance.mockResolvedValueOnce(response);
        showSettings();
        await selectNewModel();
        fireEvent.click(saveButton());
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.queryByText(/Модель сохранена|Модель успешно сохранена/)).toBeNull();
        expect(modelSelect().value).toBe(selected);
        expect(fixture.api.getInstances).toHaveBeenCalledTimes(1);
        expect(fixture.refreshInstances).not.toHaveBeenCalled();
    });

    it.each([
        ['different stored model', { success: true, instances: [{ id: 4, yandexGptModelUri: savedFour }] }],
        ['wrong tenant', { success: true, instances: [{ id: 19, yandexGptModelUri: selected }] }],
        ['failed readback', { success: false }],
    ])('does not report success with %s', async (_label, response) => {
        showSettings();
        await selectNewModel();
        fixture.api.getInstances.mockResolvedValueOnce(response);
        fireEvent.click(saveButton());
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.queryByText(/Модель сохранена|Модель успешно сохранена/)).toBeNull();
        expect(modelSelect().value).toBe(selected);
        expect(fixture.refreshInstances).not.toHaveBeenCalled();
    });

    it('keeps the selected draft after a save failure and permits a confirmed retry', async () => {
        fixture.api.updateInstance.mockRejectedValueOnce(new Error('fixture save transport error'));
        showSettings();
        await selectNewModel();
        fireEvent.click(saveButton());
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(modelSelect().value).toBe(selected);
        fireEvent.click(saveButton());
        expect(await screen.findByText(/Модель сохранена|Модель успешно сохранена/)).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
        expect(fixture.api.updateInstance).toHaveBeenCalledTimes(2);
    });

    it.each(['readback failure', 'lost PUT acknowledgement'] as const)(
        'saves the old choice again after a durable write with %s', async failure => {
            showSettings();
            await selectNewModel();
            expect(within(modelSelect()).getByRole('option', { name: `${savedFour} — сохранённая модель` })).toHaveProperty('value', savedFour);
            if (failure === 'readback failure') {
                fixture.api.getInstances.mockRejectedValueOnce(new Error('Controlled readback timeout'));
            } else {
                fixture.api.updateInstance.mockImplementationOnce(async (id: number, data: any) => {
                    fixture.server.set(id, { ...fixture.server.get(id), ...data });
                    throw Object.assign(new Error('Controlled ACK timeout after persisted write'), { code: 'ECONNABORTED' });
                });
            }
            fireEvent.click(saveButton());
            expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Не удалось подтвердить сохранение'));
            expect(fixture.server.get(4).yandexGptModelUri).toBe(selected);
            expect(screen.queryByText(/Модель сохранена|Модель успешно сохранена/)).toBeNull();
            expect(fixture.refreshInstances).not.toHaveBeenCalled();

            expect(within(modelSelect()).getByRole('option', { name: `${savedFour} — сохранённая модель` })).toHaveProperty('value', savedFour);
            fireEvent.change(modelSelect(), { target: { value: savedFour } });
            expect(modelSelect().value).toBe(savedFour);
            expect(screen.getByRole('alert').textContent).toContain('Не удалось подтвердить сохранение');
            expect(saveButton().hasAttribute('disabled')).toBe(false);
            fireEvent.click(saveButton());

            expect(await screen.findByText('Модель сохранена.')).toBeTruthy();
            expect(fixture.api.updateInstance).toHaveBeenCalledTimes(2);
            expect(fixture.api.updateInstance.mock.calls[0]).toEqual([4, { yandexGptModelUri: selected }, expect.any(AbortSignal)]);
            expect(fixture.api.updateInstance.mock.calls[1]).toEqual([4, { aiProvider: 'aitunnel', yandexGptModelUri: savedFour }, expect.any(AbortSignal)]);
            expect(fixture.server.get(4).yandexGptModelUri).toBe(savedFour);
            expect(fixture.server.get(19).yandexGptModelUri).toBe(savedNineteen);
            expect(fixture.refreshInstances).toHaveBeenCalledTimes(1);
            expect(screen.queryByRole('alert')).toBeNull();
        },
    );

    it('keeps a definitive unavailable-model rejection separate from uncertain persistence', async () => {
        fixture.api.getAiModels.mockResolvedValueOnce({
            success: true, models: [...catalogFour.models, { id: savedFour, name: 'Прежняя модель' }],
        });
        fixture.api.updateInstance.mockRejectedValueOnce({ response: { data: { code: 'AI_MODEL_UNAVAILABLE' } } });
        showSettings();
        await selectNewModel();
        fireEvent.click(saveButton());
        expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Эта модель больше недоступна. Обновите список и выберите другую.');
        expect(fixture.server.get(4).yandexGptModelUri).toBe(savedFour);
        fireEvent.change(modelSelect(), { target: { value: savedFour } });
        expect(saveButton().hasAttribute('disabled')).toBe(true);
        expect(screen.queryByRole('alert')).toBeNull();
        expect(fixture.api.updateInstance).toHaveBeenCalledTimes(1);
        expect(fixture.refreshInstances).not.toHaveBeenCalled();
    });

    it('rejects duplicate clicks during a save and its confirmation readback', async () => {
        const pending = deferred<{ success: boolean; instance: any }>();
        fixture.api.updateInstance.mockReturnValueOnce(pending.promise);
        showSettings();
        await selectNewModel();
        const button = saveButton();
        const form = button.closest('form')!;
        fireEvent.submit(form);
        fireEvent.submit(form);
        fireEvent.click(button);
        expect(fixture.api.updateInstance).toHaveBeenCalledTimes(1);
        fixture.server.get(4).yandexGptModelUri = selected;
        await act(async () => { pending.resolve({ success: true, instance: { id: 4, yandexGptModelUri: selected } }); });
        expect(await screen.findByText(/Модель сохранена|Модель успешно сохранена/)).toBeTruthy();
    });

    it('aborts an old catalogue and ignores its late response after switching businesses', async () => {
        const old = deferred<typeof catalogFour>();
        fixture.api.getAiModels.mockReturnValueOnce(old.promise);
        const view = showSettings();
        const signal = fixture.api.getAiModels.mock.calls[0][1] as AbortSignal;
        fixture.businessId = 19;
        view.rerender(<AiModelSettings key={fixture.businessId} businessId={fixture.businessId} canEdit={fixture.canEdit} />);
        await waitFor(() => expect(modelIds()).toContain(savedNineteen));
        expect(signal.aborted).toBe(true);
        expect(modelSelect().value).toBe(savedNineteen);
        await act(async () => { old.resolve(catalogFour); });
        expect(modelSelect().value).toBe(savedNineteen);
        expect(modelIds()).not.toContain(selected);
        expect(modelIds()).not.toContain(savedFour);
        expect(fixture.api.getAiModels).toHaveBeenLastCalledWith(19, expect.any(AbortSignal), 'aitunnel');
    });

    it('aborts an old save and ignores late acknowledgement after switching businesses', async () => {
        const old = deferred<{ success: boolean; instance: any }>();
        fixture.api.updateInstance.mockReturnValueOnce(old.promise);
        const view = showSettings();
        await selectNewModel();
        fireEvent.click(saveButton());
        const signal = fixture.api.updateInstance.mock.calls[0][2] as AbortSignal;
        fixture.businessId = 19;
        view.rerender(<AiModelSettings key={fixture.businessId} businessId={fixture.businessId} canEdit={fixture.canEdit} />);
        expect(signal.aborted).toBe(true);
        await act(async () => { old.resolve({ success: true, instance: { id: 4, yandexGptModelUri: selected } }); });
        expect(modelSelect().value).toBe(savedNineteen);
        expect(screen.queryByText(/Модель сохранена|Модель успешно сохранена/)).toBeNull();
        expect(fixture.api.getInstances).toHaveBeenCalledTimes(2);
        expect(fixture.refreshInstances).not.toHaveBeenCalled();
    });

    it('ignores late save readback from the old business after switching businesses', async () => {
        const old = deferred<{ success: boolean; instances: any[] }>();
        const view = showSettings();
        await selectNewModel();
        fixture.api.getInstances.mockReturnValueOnce(old.promise);
        fireEvent.click(saveButton());
        await waitFor(() => expect(fixture.api.getInstances).toHaveBeenCalledTimes(2));
        const signal = fixture.api.getInstances.mock.calls[1][0] as AbortSignal;
        fixture.businessId = 19;
        view.rerender(<AiModelSettings key={fixture.businessId} businessId={fixture.businessId} canEdit={fixture.canEdit} />);
        expect(signal.aborted).toBe(true);
        await act(async () => { old.resolve({ success: true, instances: [{ id: 4, yandexGptModelUri: selected }] }); });
        expect(modelSelect().value).toBe(savedNineteen);
        expect(screen.queryByText(/Модель сохранена|Модель успешно сохранена/)).toBeNull();
        expect(fixture.refreshInstances).not.toHaveBeenCalled();
    });

    it('aborts catalogue and save operations on unmount and suppresses late refresh', async () => {
        const load = deferred<typeof catalogFour>();
        const save = deferred<{ success: boolean; instance: any }>();
        const view = showSettings();
        await selectNewModel();
        fixture.api.getAiModels.mockReturnValueOnce(load.promise);
        fixture.api.updateInstance.mockReturnValueOnce(save.promise);
        fireEvent.click(retryCatalog());
        fireEvent.click(saveButton());
        const loadSignal = fixture.api.getAiModels.mock.calls[1][1] as AbortSignal;
        const saveSignal = fixture.api.updateInstance.mock.calls[0][2] as AbortSignal;
        view.unmount();
        expect(loadSignal.aborted).toBe(true);
        expect(saveSignal.aborted).toBe(true);
        await act(async () => { load.resolve(catalogFour); save.resolve({ success: true, instance: { id: 4, yandexGptModelUri: selected } }); });
        expect(fixture.refreshInstances).not.toHaveBeenCalled();
        expect(fixture.api.getInstances).toHaveBeenCalledTimes(1);
    });
});


const geminiCatalog = { success: true, provider: 'gemini', models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' }] };
function providerSelect() { return screen.getByRole('combobox', { name: 'AI для текстовых задач' }) as HTMLSelectElement; }
function geminiSelect() { return screen.getByRole('combobox', { name: 'Модель Gemini' }) as HTMLSelectElement; }
function useBothCatalogs() {
    fixture.api.getAiModels.mockImplementation((id: number, _signal: AbortSignal, provider: string) => Promise.resolve(provider === 'gemini' ? geminiCatalog : id === 4 ? catalogFour : catalogNineteen));
}
async function switchGemini() {
    await waitFor(() => expect(providerSelect().disabled).toBe(false));
    fireEvent.change(providerSelect(), { target: { value: 'gemini' } });
    await waitFor(() => expect(geminiSelect().disabled).toBe(false));
}
describe('shared Gemini text AI business setting', () => {
    it('switches and durably saves Gemini without overwriting the saved AITunnel model or voice', async () => {
        fixture.server.get(4).voiceAiProvider = 'neuro_gemini';
        fixture.server.get(4).voiceName = 'anna';
        fixture.server.get(4).systemPrompt = 'Keep these business instructions';
        useBothCatalogs();
        const view = showSettings();
        await switchGemini();
        fireEvent.change(geminiSelect(), { target: { value: 'gemini-3.7-flash' } });
        fireEvent.click(saveButton());
        expect(await screen.findByText('Модель сохранена.')).toBeTruthy();
        expect(fixture.api.updateInstance).toHaveBeenCalledWith(4, { aiProvider: 'gemini', geminiModel: 'gemini-3.7-flash' }, expect.any(AbortSignal));
        expect(fixture.server.get(4)).toMatchObject({ aiProvider: 'gemini', geminiModel: 'gemini-3.7-flash', yandexGptModelUri: savedFour, voiceAiProvider: 'neuro_gemini', voiceName: 'anna', systemPrompt: 'Keep these business instructions' });
        fireEvent.change(providerSelect(), { target: { value: 'aitunnel' } });
        await waitFor(() => expect(modelSelect().value).toBe(savedFour));
        fireEvent.click(saveButton());
        expect(await screen.findByText('Модель сохранена.')).toBeTruthy();
        expect(fixture.server.get(4)).toMatchObject({ aiProvider: 'aitunnel', yandexGptModelUri: savedFour, geminiModel: 'gemini-3.7-flash' });
        view.unmount(); showSettings();
        await waitFor(() => expect(modelSelect().value).toBe(savedFour));
    });
    it('allows switching to Gemini even when the AITunnel model catalog fails', async () => {
        useBothCatalogs();
        fixture.api.getAiModels.mockRejectedValueOnce(new Error('private-key/internal-AITunnel-error'));
        showSettings();
        expect(await screen.findByRole('alert')).toBeTruthy();
        await switchGemini();
        expect(screen.queryByRole('alert')).toBeNull();
        expect(geminiSelect().value).toBe('gemini-3.8-flash');
        fireEvent.click(saveButton());
        expect(await screen.findByText('Модель сохранена.')).toBeTruthy();
        expect(fixture.server.get(4).aiProvider).toBe('gemini');
    });
    it('restores unsaved model drafts independently when switching between providers', async () => {
        useBothCatalogs(); showSettings(); await selectNewModel();
        await switchGemini();
        fireEvent.change(geminiSelect(), { target: { value: 'gemini-3.7-flash' } });
        fireEvent.change(providerSelect(), { target: { value: 'aitunnel' } });
        await waitFor(() => expect(modelSelect().disabled).toBe(false));
        expect(modelSelect().value).toBe(selected);
        await switchGemini();
        expect(geminiSelect().value).toBe('gemini-3.7-flash');
        expect(fixture.api.updateInstance).not.toHaveBeenCalled();
    });
    it('ignores a late AITunnel catalog after Gemini has been selected', async () => {
        const old = deferred<typeof catalogFour>();
        useBothCatalogs(); fixture.api.getAiModels.mockReturnValueOnce(old.promise);
        showSettings();
        const signal = fixture.api.getAiModels.mock.calls[0][1] as AbortSignal;
        await switchGemini();
        expect(signal.aborted).toBe(true);
        await act(async () => old.resolve(catalogFour));
        expect(geminiSelect().value).toBe('gemini-3.8-flash');
        expect(within(geminiSelect()).queryByRole('option', { name: 'Новая модель' })).toBeNull();
        expect(fixture.api.getAiModels).toHaveBeenLastCalledWith(4, expect.any(AbortSignal), 'gemini');
    });
    it('keeps the Gemini draft on an unconfigured-provider rejection without exposing provider details', async () => {
        useBothCatalogs(); showSettings(); await switchGemini();
        fixture.api.updateInstance.mockRejectedValueOnce({ response: { data: { code: 'AI_PROVIDER_NOT_CONFIGURED', error: 'secret-key ADC internal-account' } } });
        fireEvent.click(saveButton());
        expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Этот AI временно недоступен. Выберите другой или повторите позже.');
        expect(geminiSelect().value).toBe('gemini-3.8-flash');
        expect(screen.queryByText(/secret-key|ADC|internal-account/)).toBeNull();
        expect(fixture.server.get(4).aiProvider).toBe('yandex');
    });
    it('aborts a pending Gemini save and clears its draft when the account changes on the same business', async () => {
        const old = deferred<any>(); useBothCatalogs();
        const view = showSettings(); await switchGemini();
        fixture.api.updateInstance.mockReturnValueOnce(old.promise);
        fireEvent.click(saveButton());
        const signal = fixture.api.updateInstance.mock.calls[0][2] as AbortSignal;
        fixture.userId = 'different-owner';
        view.rerender(<AiModelSettings key={4} businessId={4} canEdit />);
        await waitFor(() => expect(modelSelect().value).toBe(savedFour));
        expect(signal.aborted).toBe(true);
        await act(async () => old.resolve({ success: true, instance: { id: 4, aiProvider: 'gemini', geminiModel: 'gemini-3.8-flash' } }));
        expect(screen.queryByText('Модель сохранена.')).toBeNull();
        expect(fixture.refreshInstances).not.toHaveBeenCalled();
    });
    it('keeps both provider and model controls read-only for managers', async () => {
        fixture.canEdit = false; useBothCatalogs(); showSettings();
        await waitFor(() => expect(modelSelect().value).toBe(savedFour));
        expect(providerSelect().disabled).toBe(true);
        fireEvent.change(providerSelect(), { target: { value: 'gemini' } });
        expect(providerSelect().value).toBe('aitunnel');
        expect(fixture.api.updateInstance).not.toHaveBeenCalled();
    });
    it('rejects a catalog returned for the wrong provider and keeps the selected model draft', async () => {
        useBothCatalogs(); showSettings();
        await waitFor(() => expect(providerSelect().disabled).toBe(false));
        fixture.api.getAiModels.mockResolvedValueOnce({ ...geminiCatalog, provider: 'aitunnel' });
        fireEvent.change(providerSelect(), { target: { value: 'gemini' } });
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(geminiSelect().value).toBe('gemini-3.8-flash');
        expect(saveButton().hasAttribute('disabled')).toBe(true);
        expect(fixture.api.updateInstance).not.toHaveBeenCalled();
    });
});


describe('legacy voice provider compatibility in text settings', () => {
    it.each(['google_live', 'openai_realtime', 'yandex_realtime', 'deepgram', 'local', 'neuro_gemini'])('permits Gemini switch when old aiProvider is %s', async legacyProvider => {
        fixture.server.get(4).aiProvider = legacyProvider;
        fixture.server.get(4).voiceAiProvider = legacyProvider;
        useBothCatalogs(); showSettings();
        await waitFor(() => expect(modelSelect().value).toBe(savedFour));
        expect(providerSelect().value).toBe('aitunnel');
        await switchGemini(); fireEvent.click(saveButton());
        expect(await screen.findByText('Модель сохранена.')).toBeTruthy();
        expect(fixture.server.get(4)).toMatchObject({ aiProvider: 'gemini', voiceAiProvider: legacyProvider, yandexGptModelUri: savedFour });
        expect(fixture.api.updateInstance).toHaveBeenCalledWith(4, { aiProvider: 'gemini', geminiModel: 'gemini-3.8-flash' }, expect.any(AbortSignal));
    });
});


describe('server-owned Gemini model defaults', () => {
    it('displays and selects the inherited Gemini default from the server catalog', async () => {
        fixture.server.get(4).aiProvider = 'gemini';
        fixture.server.get(4).geminiModel = null;
        fixture.api.getAiProviders.mockResolvedValue({ success: true, providers: [
            { id: 'gemini', name: 'Gemini', configured: true, defaultModel: 'gemini-3.7-flash' },
            { id: 'aitunnel', name: 'AITunnel', configured: true, defaultModel: 'gpt-oss-120b' },
        ] });
        useBothCatalogs(); showSettings();
        await waitFor(() => expect(geminiSelect().value).toBe('gemini-3.7-flash'));
        expect(saveButton().hasAttribute('disabled')).toBe(true);
        expect(fixture.api.updateInstance).not.toHaveBeenCalled();
    });
});


describe('permission refresh keeps the current business draft', () => {
    it('disables saving during a permission refresh without clearing the Gemini draft', async () => {
        useBothCatalogs(); const view = showSettings(); await switchGemini();
        fireEvent.change(geminiSelect(), { target: { value: 'gemini-3.7-flash' } });
        fixture.permissionsLoading = true;
        view.rerender(<AiModelSettings key={4} businessId={4} canEdit={false} />);
        expect(geminiSelect().value).toBe('gemini-3.7-flash');
        expect(providerSelect().disabled).toBe(true);
        fixture.permissionsLoading = false;
        view.rerender(<AiModelSettings key={4} businessId={4} canEdit />);
        expect(geminiSelect().value).toBe('gemini-3.7-flash');
        expect(providerSelect().disabled).toBe(false);
        expect(fixture.api.updateInstance).not.toHaveBeenCalled();
    });
});
