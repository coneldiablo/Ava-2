// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AiModelSettings from '../src/components/AiModelSettings';

const fixture = vi.hoisted(() => ({
    userId: 'acceptance-owner', businessId: 1,
    instances: [] as any[], getInstances: vi.fn(), getAiProviders: vi.fn(),
    getAiModels: vi.fn(), updateInstance: vi.fn(), refreshInstances: vi.fn(),
}));
vi.mock('../src/api', () => ({ getInstances: fixture.getInstances, getAiProviders: fixture.getAiProviders,
    getAiModels: fixture.getAiModels, updateInstance: fixture.updateInstance }));
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({ refreshInstances: fixture.refreshInstances }) }));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ authenticated: true,
    userId: fixture.userId, role: 'customer', permissionsLoading: false,
    memberships: [{ businessId: fixture.businessId, role: 'hotel_owner', capabilities: ['business.read', 'business.manage'] }],
}) }));
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
const providerSelect = () => screen.getByRole('combobox', { name: 'AI для текстовых задач' }) as HTMLSelectElement;
const modelSelect = () => screen.getByRole('combobox', { name: 'Модель Gemini' }) as HTMLSelectElement;

beforeEach(() => {
    vi.resetAllMocks(); fixture.userId = 'acceptance-owner'; fixture.businessId = 1;
    fixture.instances = [{ id: 1, aiProvider: 'gemini', geminiModel: null, yandexGptModelUri: 'old-model',
        voiceAiProvider: 'neuro_gemini', voiceModel: 'gemini-3.8-flash', voiceName: 'edsel' }];
    fixture.getInstances.mockImplementation(async () => ({ success: true, instances: fixture.instances.map(row => ({ ...row })) }));
    fixture.getAiProviders.mockResolvedValue({ success: true, provider: 'gemini', model: 'gemini-3.7-flash', providers: [
        { id: 'gemini', name: 'Gemini', configured: true, defaultModel: 'gemini-3.7-flash' },
        { id: 'aitunnel', name: 'AITunnel', configured: false, defaultModel: 'gpt-oss-120b' },
    ] });
    fixture.getAiModels.mockImplementation(async (_id: number, _signal: AbortSignal, provider: string) => ({ success: true, provider,
        defaultModel: 'gemini-3.7-flash', selectedModel: 'gemini-3.7-flash',
        models: provider === 'gemini' ? [{ id: 'gemini-3.7-flash' }, { id: 'gemini-3.8-flash' }] : [] }));
    fixture.updateInstance.mockImplementation(async (id: number, patch: Record<string, unknown>) => {
        const row = fixture.instances.find(item => item.id === id); Object.assign(row, patch);
        return { success: true, instance: { ...row } };
    });
});
afterEach(cleanup);

describe('Independent Gemini text picker acceptance', () => {
    it('displays the inherited server model and preserves text/voice isolation when saving a different model', async () => {
        render(<AiModelSettings businessId={1} canEdit />);
        await waitFor(() => expect(modelSelect().value).toBe('gemini-3.7-flash'));
        expect(providerSelect().value).toBe('gemini');
        expect(fixture.updateInstance).not.toHaveBeenCalled();
        fireEvent.change(modelSelect(), { target: { value: 'gemini-3.8-flash' } });
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить модель' }));
        expect(await screen.findByText('Модель сохранена.')).toBeTruthy();
        expect(fixture.updateInstance).toHaveBeenCalledWith(1, { geminiModel: 'gemini-3.8-flash' }, expect.any(AbortSignal));
        expect(fixture.instances[0].yandexGptModelUri).toBe('old-model');
        expect(fixture.instances[0].voiceName).toBe('edsel');
        expect(fixture.instances[0].voiceModel).toBe('gemini-3.8-flash');
    });

    it('aborts an old-business save and ignores its late acknowledgment after business and account change', async () => {
        fixture.instances[0].geminiModel = 'gemini-3.7-flash';
        const pending = deferred<any>(); fixture.updateInstance.mockReturnValueOnce(pending.promise);
        const view = render(<AiModelSettings businessId={1} canEdit />);
        await waitFor(() => expect(modelSelect().value).toBe('gemini-3.7-flash'));
        fireEvent.change(modelSelect(), { target: { value: 'gemini-3.8-flash' } });
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить модель' }));
        await waitFor(() => expect(fixture.updateInstance).toHaveBeenCalledTimes(1));
        const signal = fixture.updateInstance.mock.calls[0][2] as AbortSignal;
        fixture.userId = 'second-owner'; fixture.businessId = 2;
        fixture.instances = [{ id: 2, aiProvider: 'gemini', geminiModel: 'gemini-3.7-flash' }];
        view.rerender(<AiModelSettings businessId={2} canEdit />);
        await waitFor(() => expect(modelSelect().value).toBe('gemini-3.7-flash'));
        expect(signal.aborted).toBe(true);
        await act(async () => pending.resolve({ success: true, instance: { id: 1, aiProvider: 'gemini', geminiModel: 'gemini-3.8-flash' } }));
        expect(modelSelect().value).toBe('gemini-3.7-flash');
        expect(screen.queryByText('Модель сохранена.')).toBeNull();
        expect(fixture.refreshInstances).not.toHaveBeenCalled();
        expect(fixture.getInstances).toHaveBeenCalledTimes(2);
    });
});
