// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '../src/context/AuthContext';
import { useInstance } from '../src/context/InstanceContext';
import { OnboardingProvider, useOnboarding } from '../src/context/OnboardingContext';
import { OnboardingGuideRoute, OnboardingHomeGate } from '../src/components/OnboardingGate';
import OnboardingGuide from '../src/pages/OnboardingGuide';
import Sidebar from '../src/components/Sidebar';
import QuickJump from '../src/components/QuickJump';
import { onboardingSteps, type OnboardingState } from '../src/onboardingApi';

vi.mock('../src/context/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../src/context/InstanceContext', () => ({ useInstance: vi.fn() }));
vi.mock('../src/api', () => ({ createInstance: vi.fn(),
    getKnowledgeBaseStats: vi.fn().mockResolvedValue({ stats: { totalDocuments: 2 } }),
    getChannelStatus: vi.fn().mockResolvedValue({ success: true, channels: {} }) }));
vi.mock('../src/hooks/useReleaseFlags', () => ({ useReleaseFlags: () => ({ data: { flags: { workspace: false } } }) }));

// Text provider selection has its own persistence/race acceptance suite.
vi.mock('../src/components/AiModelSettings', () => ({ default: () => <div>AI вашего бизнеса</div> }));

const server = new Map<number, OnboardingState>();
let fetchMock: ReturnType<typeof vi.fn>;
const pending = (businessId: number): OnboardingState => ({ businessId, status: 'pending', confirmedSteps: [], completedAt: null });
const completed = (businessId: number): OnboardingState => ({ businessId, status: 'completed', confirmedSteps: [...onboardingSteps], completedAt: '2026-10-10T09:00:00.000Z' });
const response = (state: OnboardingState) => ({ ok: true, status: 200,
    json: async () => ({ success: true, onboarding: structuredClone(state) }) });
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
function selectBusiness(businessId: number | null = 7, role = 'hotel_owner', userId = 'owner-a') {
    vi.mocked(useAuth).mockReturnValue({ authenticated: true, permissionsLoading: false, userId,
        loginName: `${userId}@example.test`, displayName: userId, role: 'customer', canCreateBusiness: true,
        memberships: businessId ? [{ businessId, role, capabilities: role === 'hotel_owner'
            ? ['business.read', 'business.manage', 'sales.read', 'team.read', 'ai.use'] : ['business.read', 'sales.read'] }] : [],
        refreshAuth: vi.fn().mockResolvedValue(undefined), logout: vi.fn() } as any);
    vi.mocked(useInstance).mockReturnValue({ currentInstanceId: businessId,
        currentInstance: businessId ? { id: businessId, name: `Бизнес ${businessId}` } : null,
        instances: businessId ? [{ id: businessId, name: `Бизнес ${businessId}` }] : [], instancesState: 'ready',
        refreshInstances: vi.fn().mockResolvedValue(undefined), setInstanceId: vi.fn() } as any);
}
function StateProbe() {
    const state = useOnboarding();
    return <><button type="button" onClick={() => void state.confirmStep('voice')}>Подтвердить голос напрямую</button><output data-testid="state">{JSON.stringify({ phase: state.phase, businessId: state.state?.businessId,
        confirmed: state.state?.confirmedSteps, showGuide: state.showGuide })}</output></>;
}
function LocationProbe() { return <output data-testid="location">{useLocation().pathname}</output>; }
function Workspace({ path = '/', navigation = false }: { path?: string; navigation?: boolean }) {
    return <MemoryRouter initialEntries={[path]}><OnboardingProvider>
        <input aria-label="Локальный черновик" defaultValue="" /><StateProbe /><LocationProbe />
        {navigation && <><Sidebar open /><QuickJump open onClose={() => {}} /></>}
        <Routes>
            <Route path="/" element={<OnboardingHomeGate><h1>Главная бизнеса</h1></OnboardingHomeGate>} />
            <Route path="/getting-started" element={<OnboardingGuideRoute><OnboardingGuide /></OnboardingGuideRoute>} />
            <Route path="/integrations" element={<h1>Настройки бизнеса</h1>} />
            <Route path="/sales" element={<h1>Задачи менеджера</h1>} />
            <Route path="/today" element={<h1>Рабочий день</h1>} />
        </Routes>
    </OnboardingProvider></MemoryRouter>;
}
const onboardingCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/onboarding'));
const writes = () => onboardingCalls().filter(([, init]) => init?.method === 'POST');

beforeEach(() => {
    server.clear(); server.set(7, pending(7)); server.set(8, pending(8));
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key), clear: () => storage.clear() });
    sessionStorage.clear();
    selectBusiness();
    let draftApproved = true;
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const match = String(url).match(/^\/api\/businesses\/(\d+)\/onboarding(.*)$/);
        if (!match) {
            const draft = { id: 'draft-7', status: draftApproved ? 'approved' : 'draft', links: ['https://example.test'], supplement: '', systemPrompt: 'Проверенные инструкции', sources: [] };
            if (String(url).endsWith('/assistant-draft/approve')) draftApproved = true;
            return { ok: true, status: 200, json: async () => ({ success: true, businessId: 7,
                draft: { ...draft, status: draftApproved ? 'approved' : 'draft' },
                profile: { businessId: 7, name: 'Отель Маяк', businessType: 'hotel', systemPrompt: 'Проверенные инструкции' } }) };
        }
        const id = Number(match[1]), action = match[2];
        const state = server.get(id)!;
        if (init?.method === 'POST' && action.startsWith('/steps/')) {
            const step = action.slice('/steps/'.length) as typeof onboardingSteps[number];
            if (!state.confirmedSteps.includes(step)) state.confirmedSteps.push(step);
        }
        if (action === '/complete') {
            if (state.confirmedSteps.length !== onboardingSteps.length) return { ok: false, status: 409, json: async () => ({ success: false }) };
            state.status = 'completed'; state.completedAt = '2026-10-10T09:00:00.000Z';
        }
        return response(state);
    });
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('server-backed onboarding lifecycle', () => {
    it('requires five explicit acknowledgements, then hides navigation and stays completed after reload', async () => {
        localStorage.setItem('ava:guide:v1:owner-a@example.test:7', JSON.stringify({ step: 4, viewed: [0, 1, 2, 3, 4] }));
        const view = render(<Workspace navigation />);
        await screen.findByRole('heading', { name: 'Инструкции по ссылкам' });
        expect(screen.getByTestId('location').textContent).toBe('/getting-started');
        const finish = screen.getByRole('button', { name: 'Завершить настройку' });
        expect(finish.hasAttribute('disabled')).toBe(true);
        expect(server.get(7)?.status).toBe('pending');
        expect(writes()).toHaveLength(0);
        expect(await screen.findByRole('link', { name: 'Начало работы' })).toBeTruthy();
        expect(within(screen.getByRole('dialog')).getByText('Начало работы')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /Шаг 1 Бизнес/ }));
        for (const next of ['Голос и стиль', 'База знаний', 'Каналы связи', 'Инструкции по ссылкам']) {
            fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и продолжить' }));
            await screen.findByRole('heading', { name: next });
        }
        fireEvent.click(screen.getByRole('button', { name: 'Завершить настройку' }));
        await screen.findByRole('heading', { name: 'Настройки бизнеса' });
        expect(writes().map(([url]) => url)).toEqual([
            ...onboardingSteps.map(step => `/api/businesses/7/onboarding/steps/${step}`), '/api/businesses/7/onboarding/complete',
        ]);
        expect(server.get(7)).toMatchObject(completed(7));
        expect(screen.queryByRole('link', { name: 'Начало работы' })).toBeNull();
        expect(within(screen.getByRole('dialog')).queryByText('Начало работы')).toBeNull();
        view.unmount(); localStorage.clear();
        render(<Workspace path="/getting-started" />);
        await screen.findByRole('heading', { name: 'Настройки бизнеса' });
        expect(screen.getByTestId('location').textContent).toBe('/integrations');
        expect(writes()).toHaveLength(6);
    });

    it('prepares a links draft, saves the owner edit and completes only after explicit finish', async () => {
        server.get(7)!.confirmedSteps = [...onboardingSteps.slice(0, 4)];
        localStorage.setItem('ava:guide:v1:owner-a@example.test:7', JSON.stringify({ step: 4, viewed: [] }));
        const original = fetchMock.getMockImplementation()!;
        let storedPrompt = 'До настройки';
        let draft: any = null;
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.includes('/onboarding')) return original(url, init);
            const result = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ success: true, businessId: 7, ...data as object }) });
            if (url.endsWith('/assistant-draft')) {
                if (init?.method === 'POST') draft = { id: 'new-draft', status: 'draft', ...JSON.parse(String(init.body)),
                    systemPrompt: 'Созданные инструкции', sources: [{ url: 'https://example.test', title: 'Сайт бизнеса', status: 'read' }] };
                return result({ draft });
            }
            if (url.endsWith('/approve')) {
                storedPrompt = JSON.parse(String(init?.body)).systemPrompt;
                draft = { ...draft, status: 'approved', systemPrompt: storedPrompt };
            }
            return result({ draft, profile: { businessId: 7, name: 'Бизнес', systemPrompt: storedPrompt } });
        });
        render(<Workspace path="/getting-started" />);
        fireEvent.change(await screen.findByLabelText('Ссылки на страницы бизнеса'), { target: { value: 'https://example.test' } });
        const finish = screen.getByRole('button', { name: 'Завершить настройку' });
        expect(finish.hasAttribute('disabled')).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Подготовить инструкции' }));
        const prompt = await screen.findByLabelText('Инструкции ассистента');
        expect(storedPrompt).toBe('До настройки');
        fireEvent.change(prompt, { target: { value: 'Мои проверенные инструкции' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и сохранить' }));
        await waitFor(() => expect(finish.hasAttribute('disabled')).toBe(false));
        expect(storedPrompt).toBe('Мои проверенные инструкции');
        expect(server.get(7)?.status).toBe('pending');
        fireEvent.click(finish);
        await screen.findByRole('heading', { name: 'Настройки бизнеса' });
        expect(server.get(7)?.status).toBe('completed');
    });

    it('restores business completion for a different owner and preserves Home and Today', async () => {
        server.set(7, completed(7));
        const first = render(<Workspace />);
        await screen.findByRole('heading', { name: 'Главная бизнеса' });
        first.unmount(); selectBusiness(7, 'hotel_owner', 'owner-b');
        const second = render(<Workspace path="/getting-started" />);
        await screen.findByRole('heading', { name: 'Настройки бизнеса' });
        expect(screen.getByTestId('state').textContent).toContain('"showGuide":false');
        second.unmount(); render(<Workspace path="/today" />);
        expect(screen.getByRole('heading', { name: 'Рабочий день' })).toBeTruthy();
        expect(writes()).toHaveLength(0);
    });

    it.each(['manager', 'observer'])('bypasses owner setup for an invited %s', async role => {
        selectBusiness(7, role);
        const view = render(<Workspace />);
        expect(screen.getByRole('heading', { name: 'Главная бизнеса' })).toBeTruthy();
        expect(onboardingCalls()).toHaveLength(0);
        view.unmount(); render(<Workspace path="/getting-started" navigation />);
        await screen.findByRole('heading', { name: 'Рабочий день' });
        expect(screen.queryByRole('link', { name: 'Начало работы' })).toBeNull();
        expect(within(screen.getByRole('dialog')).queryByText('Начало работы')).toBeNull();
        expect(onboardingCalls()).toHaveLength(0);
    });

    it('permits first-business bootstrap without trying to load a nonexistent business', async () => {
        selectBusiness(null);
        render(<Workspace path="/getting-started" navigation />);
        expect(screen.getByLabelText('Название бизнеса')).toBeTruthy();
        expect(await screen.findByRole('link', { name: 'Начало работы' })).toBeTruthy();
        expect(within(screen.getByRole('dialog')).getByText('Начало работы')).toBeTruthy();
        expect(onboardingCalls()).toHaveLength(0);
    });

    it('discards a late response from business A after switching to completed business B', async () => {
        server.set(8, completed(8));
        const original = fetchMock.getMockImplementation()!;
        const lateA = deferred<ReturnType<typeof response>>();
        fetchMock.mockImplementation((url: string, init?: RequestInit) => url === '/api/businesses/7/onboarding' ? lateA.promise : original(url, init));
        const view = render(<Workspace />);
        await waitFor(() => expect(onboardingCalls()).toHaveLength(1));
        selectBusiness(8); view.rerender(<Workspace />);
        await screen.findByRole('heading', { name: 'Главная бизнеса' });
        await act(async () => { lateA.resolve(response(pending(7))); await lateA.promise; });
        expect(screen.getByTestId('state').textContent).toContain('"businessId":8');
        expect(screen.getByTestId('state').textContent).toContain('"phase":"completed"');
        expect(screen.getByTestId('location').textContent).toBe('/');
        selectBusiness(7); fetchMock.mockImplementation(original); view.rerender(<Workspace />);
        await screen.findByRole('heading', { name: 'Ваш бизнес' });
        expect(screen.getByTestId('state').textContent).toContain('"businessId":7');
    });

    it.each(['/', '/getting-started'])('holds a failed status request on %s and retries without redirect loops', async path => {
        fetchMock.mockRejectedValueOnce(new Error('offline'));
        render(<Workspace path={path} />);
        await screen.findByRole('alert');
        expect(screen.getByTestId('location').textContent).toBe(path);
        expect(onboardingCalls()).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
        await screen.findByRole('heading', { name: 'Ваш бизнес' });
        expect(screen.getByTestId('location').textContent).toBe('/getting-started');
        expect(onboardingCalls()).toHaveLength(2);
    });

    it('keeps legacy client handoff links available while onboarding is pending', async () => {
        render(<Workspace path="/?client=123&source=home" />);
        expect(screen.getByRole('heading', { name: 'Главная бизнеса' })).toBeTruthy();
        await waitFor(() => expect(screen.getByTestId('state').textContent).toContain('"phase":"pending"'));
        expect(screen.getByTestId('location').textContent).toBe('/');
    });

    it('prevents duplicate finish requests while the review acknowledgement is saving', async () => {
        server.get(7)!.confirmedSteps = [...onboardingSteps.slice(0, 4)];
        localStorage.setItem('ava:guide:v1:owner-a@example.test:7', JSON.stringify({ step: 4, viewed: [] }));
        const original = fetchMock.getMockImplementation()!;
        const review = deferred<ReturnType<typeof response>>();
        fetchMock.mockImplementation((url: string, init?: RequestInit) => url.endsWith('/steps/review') ? review.promise : original(url, init));
        render(<Workspace path="/getting-started" />);
        const finish = await screen.findByRole('button', { name: 'Завершить настройку' });
        await waitFor(() => expect(finish.hasAttribute('disabled')).toBe(false));
        fireEvent.click(finish); fireEvent.click(finish);
        expect(screen.getByRole('button', { name: 'Сохраняем…' }).hasAttribute('disabled')).toBe(true);
        expect(writes()).toHaveLength(1);
        server.get(7)!.confirmedSteps.push('review');
        await act(async () => { review.resolve(response(server.get(7)!)); await review.promise; });
        await screen.findByRole('heading', { name: 'Настройки бизнеса' });
        expect(writes().map(([url]) => url)).toEqual(['/api/businesses/7/onboarding/steps/review', '/api/businesses/7/onboarding/complete']);
    });

    it('retains acknowledged steps after a completion failure and completes only on explicit retry', async () => {
        server.get(7)!.confirmedSteps = [...onboardingSteps.slice(0, 4)];
        localStorage.setItem('ava:guide:v1:owner-a@example.test:7', JSON.stringify({ step: 4, viewed: [] }));
        const original = fetchMock.getMockImplementation()!;
        let completeAttempts = 0;
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (url.endsWith('/complete') && ++completeAttempts === 1) {
                return Promise.resolve({ ok: false, status: 503, json: async () => ({ success: false }) });
            }
            return original(url, init);
        });
        render(<Workspace path="/getting-started" />);
        const finish = await screen.findByRole('button', { name: 'Завершить настройку' });
        await waitFor(() => expect(finish.hasAttribute('disabled')).toBe(false));
        fireEvent.click(finish);
        await screen.findByRole('alert');
        expect(server.get(7)?.status).toBe('pending');
        expect(server.get(7)?.confirmedSteps).toEqual([...onboardingSteps]);
        expect(screen.getByTestId('location').textContent).toBe('/getting-started');
        expect(completeAttempts).toBe(1);
        fireEvent.click(screen.getByRole('button', { name: 'Завершить настройку' }));
        await screen.findByRole('heading', { name: 'Настройки бизнеса' });
        expect(completeAttempts).toBe(2);
        expect(server.get(7)?.confirmedSteps).toEqual([...onboardingSteps]);
        expect(server.get(7)?.status).toBe('completed');
    });


    it('keeps mounted workspace children across a business change', async () => {
        server.set(7, completed(7)); server.set(8, completed(8));
        const view = render(<Workspace />);
        await screen.findByRole('heading', { name: 'Главная бизнеса' });
        const draft = screen.getByLabelText('Локальный черновик');
        fireEvent.change(draft, { target: { value: 'Несохранённый текст' } });
        selectBusiness(8); view.rerender(<Workspace />);
        await waitFor(() => expect(screen.getByTestId('state').textContent).toContain('"businessId":8'));
        expect(screen.getByLabelText('Локальный черновик')).toBe(draft);
        expect((draft as HTMLInputElement).value).toBe('Несохранённый текст');
    });

    it('discards an old mutation after switching A to B and back to A', async () => {
        const original = fetchMock.getMockImplementation()!;
        const oldWrite = deferred<ReturnType<typeof response>>();
        fetchMock.mockImplementation((url: string, init?: RequestInit) => url === '/api/businesses/7/onboarding/steps/voice'
            ? oldWrite.promise : original(url, init));
        const view = render(<Workspace path="/today" />);
        await waitFor(() => expect(screen.getByTestId('state').textContent).toContain('"phase":"pending"'));
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить голос напрямую' }));
        expect(writes()).toHaveLength(1);
        selectBusiness(8); view.rerender(<Workspace path="/today" />);
        await waitFor(() => expect(screen.getByTestId('state').textContent).toContain('"businessId":8'));
        server.get(7)!.confirmedSteps = ['business', 'knowledge'];
        selectBusiness(7); view.rerender(<Workspace path="/today" />);
        await waitFor(() => expect(screen.getByTestId('state').textContent).toContain('"confirmed":["business","knowledge"]'));
        await act(async () => { oldWrite.resolve(response({ ...pending(7), confirmedSteps: ['voice'] })); await oldWrite.promise; });
        expect(screen.getByTestId('state').textContent).toContain('"confirmed":["business","knowledge"]');
        expect(screen.getByTestId('location').textContent).toBe('/today');
    });

    it('holds a direct guide URL while instances are loading before resolving owner state', async () => {
        vi.mocked(useInstance).mockReturnValue({ ...useInstance(), currentInstanceId: null, currentInstance: null, instancesState: 'loading' });
        const view = render(<Workspace path="/getting-started" />);
        expect(screen.getByText('Загружаем настройку бизнеса…').closest('[role="status"]')).toBeTruthy();
        expect(screen.queryByLabelText('Название бизнеса')).toBeNull();
        expect(screen.getByTestId('location').textContent).toBe('/getting-started');
        expect(onboardingCalls()).toHaveLength(0);
        selectBusiness(7); view.rerender(<Workspace path="/getting-started" />);
        await screen.findByRole('heading', { name: 'Ваш бизнес' });
        expect(onboardingCalls()).toHaveLength(1);
    });

    it('preserves a completed home subtree across permission checks and a failed onboarding refresh', async () => {
        server.set(7, completed(7));
        const Home = () => <MemoryRouter><OnboardingProvider><OnboardingHomeGate>
            <input aria-label="Черновик внутри главной" defaultValue="" />
        </OnboardingHomeGate></OnboardingProvider></MemoryRouter>;
        const view = render(<Home />);
        const draft = await screen.findByLabelText<HTMLInputElement>('Черновик внутри главной');
        fireEvent.change(draft, { target: { value: 'Сохранить ввод' } });
        vi.mocked(useAuth).mockReturnValue({ ...useAuth(), permissionsLoading: true });
        view.rerender(<Home />);
        expect(screen.getByLabelText('Черновик внутри главной')).toBe(draft);
        expect(onboardingCalls()).toHaveLength(1);
        fetchMock.mockRejectedValueOnce(new Error('503'));
        vi.mocked(useAuth).mockReturnValue({ ...useAuth(), permissionsLoading: false });
        view.rerender(<Home />);
        await waitFor(() => expect(onboardingCalls()).toHaveLength(2));
        await act(async () => {});
        expect(screen.getByLabelText('Черновик внутри главной')).toBe(draft); expect(draft.value).toBe('Сохранить ввод');
    });

    it('rejects direct onboarding mutations while the current grant is being checked', async () => {
        const view = render(<Workspace path="/today" />);
        await waitFor(() => expect(screen.getByTestId('state').textContent).toContain('"phase":"pending"'));
        vi.mocked(useAuth).mockReturnValue({ ...useAuth(), permissionsLoading: true });
        view.rerender(<Workspace path="/today" />);
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить голос напрямую' }));
        await act(async () => {});
        expect(writes()).toHaveLength(0);
        expect(screen.getByTestId('state').textContent).toContain('"phase":"pending"');
    });

    it('retries a failed instance list on the direct guide URL without redirecting', async () => {
        const refreshInstances = vi.fn().mockResolvedValue(undefined);
        vi.mocked(useInstance).mockReturnValue({ ...useInstance(), currentInstanceId: null, currentInstance: null,
            instancesState: 'error', refreshInstances });
        const view = render(<Workspace path="/getting-started" />);
        expect(screen.getByRole('alert').textContent).toContain('Не удалось загрузить бизнесы');
        fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
        expect(refreshInstances).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('location').textContent).toBe('/getting-started');
        expect(onboardingCalls()).toHaveLength(0);
        selectBusiness(7); view.rerender(<Workspace path="/getting-started" />);
        await screen.findByRole('heading', { name: 'Ваш бизнес' });
        expect(onboardingCalls()).toHaveLength(1);
    });

});
