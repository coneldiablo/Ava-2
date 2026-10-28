// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import ReleaseGate from '../src/components/ReleaseGate';
import ReleaseControls from '../src/components/ReleaseControls';
import QuickJump from '../src/components/QuickJump';
import { api } from '../src/api';
import { getReleaseFlags } from '../src/avaWorkspace';
import { notifyReleaseFlagsChanged } from '../src/hooks/useReleaseFlags';
import { useBusinessAccess } from '../src/permissions';
const state = vi.hoisted(() => ({ businessId: 7 as number | null, userId: 'owner', role: 'hotel_owner', loading: false, flags: { workspace: true, analytics: true, autopilot: true }, revision: 2, available: true, conflict: false }));
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: state.businessId }) }));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ authenticated: true, userId: state.userId, role: 'customer', permissionsLoading: state.loading, memberships: state.businessId ? [{ businessId: state.businessId, role: state.role, capabilities: ['business.read', 'sales.read', 'team.read', ...(state.role === 'hotel_owner' ? ['business.manage', 'sales.assign'] : [])] }] : [] }) }));
vi.mock('../src/api', () => ({ api: { request: vi.fn() } }));
function snapshot(businessId = state.businessId) { return { data: { success: true, businessId, revision: state.revision, flags: { ...state.flags }, availability: { workspace: true, analytics: true, autopilot: state.available } } }; }
function Location() { const location = useLocation(); return <output data-testid="location">{location.search}</output>; }
function DraftEditor() {
    const access = useBusinessAccess();
    return <><input aria-label="Черновик в рабочем месте" defaultValue="" /><button disabled={!access.can('sales.assign')}>Назначить задачу</button></>;
}
function show(element: React.ReactNode) { return render(<MemoryRouter initialEntries={['/?client=old%40c.us&source=call-source']}>{element}<Location /></MemoryRouter>); }
beforeEach(() => {
    vi.clearAllMocks(); Object.assign(state, { businessId: 7, userId: 'owner', role: 'hotel_owner', loading: false, flags: { workspace: true, analytics: true, autopilot: true }, revision: 2, available: true, conflict: false });
    vi.mocked(api.request).mockImplementation(async config => {
        const id = Number(String(config.url).split('/')[2]);
        if (config.method === 'put') {
            if (state.conflict) throw { response: { data: { code: 'AVA_RELEASE_REVISION_CONFLICT' } } };
            const body = config.data as { flags: Partial<typeof state.flags> }; state.flags = { ...state.flags, ...body.flags }; state.revision++;
        }
        if (String(config.url).includes('/search?')) return { data: { success: true, businessId: id, results: [] } } as never;
        return snapshot(id) as never;
    });
});
afterEach(cleanup);
describe('business rollout flags', () => {
    it('keeps the mounted editor across permission checks and failed flag refreshes while mutations stay locked', async () => {
        const element = () => <ReleaseGate feature="workspace"><DraftEditor /></ReleaseGate>;
        const view = show(element());
        const draft = await screen.findByLabelText<HTMLInputElement>('Черновик в рабочем месте');
        fireEvent.change(draft, { target: { value: 'Не потерять вопрос' } });
        state.loading = true; view.rerender(<MemoryRouter>{element()}<Location /></MemoryRouter>);
        expect(screen.getByLabelText('Черновик в рабочем месте')).toBe(draft);
        expect(draft.value).toBe('Не потерять вопрос');
        expect((screen.getByRole('button', { name: 'Назначить задачу' }) as HTMLButtonElement).disabled).toBe(true);
        expect(api.request).toHaveBeenCalledTimes(1);
        vi.mocked(api.request).mockRejectedValueOnce(new Error('503'));
        act(() => notifyReleaseFlagsChanged(7, 'owner'));
        await waitFor(() => expect(api.request).toHaveBeenCalledTimes(2));
        await act(async () => {});
        expect(screen.getByLabelText('Черновик в рабочем месте')).toBe(draft); expect(draft.value).toBe('Не потерять вопрос');
        state.loading = false; view.rerender(<MemoryRouter>{element()}<Location /></MemoryRouter>);
        expect((screen.getByRole('button', { name: 'Назначить задачу' }) as HTMLButtonElement).disabled).toBe(false);
        act(() => notifyReleaseFlagsChanged(7, 'owner'));
        await waitFor(() => expect(api.request).toHaveBeenCalledTimes(3));
        expect(screen.getByLabelText('Черновик в рабочем месте')).toBe(draft);
    });
    it('waits for scoped flags without mounting either screen or losing the initial deep link', async () => {
        let resolve!: (value: ReturnType<typeof snapshot>) => void;
        vi.mocked(api.request).mockReturnValueOnce(new Promise(value => { resolve = value; }) as never);
        show(<ReleaseGate feature="workspace" fallback={<p>Существующие продажи</p>}><p>Новая очередь</p></ReleaseGate>);
        expect(screen.queryByText('Новая очередь')).toBeNull(); expect(screen.queryByText('Существующие продажи')).toBeNull();
        expect(screen.getByTestId('location').textContent).toBe('?client=old%40c.us&source=call-source');
        await act(async () => resolve(snapshot()));
        expect(screen.getByText('Новая очередь')).toBeTruthy(); expect(screen.getByTestId('location').textContent).toContain('source=call-source');
    });
    it('falls back to existing sales when the workspace is disabled', async () => {
        state.flags.workspace = false;
        show(<ReleaseGate feature="workspace" fallback={<p>Существующие продажи</p>}><p>Новая очередь</p></ReleaseGate>);
        await screen.findByText('Существующие продажи'); expect(screen.queryByText('Новая очередь')).toBeNull();
    });
    it('shows a clear disabled analytics state with a working existing-report link', async () => {
        state.flags.analytics = false; show(<ReleaseGate feature="analytics"><p>Радар руководителя</p></ReleaseGate>);
        await screen.findByText('Новая аналитика отключена'); expect(screen.getByRole('link', { name: 'Открыть аналитику каналов' }).getAttribute('href')).toBe('/analytics'); expect(screen.queryByText('Радар руководителя')).toBeNull();
    });
    it('aborts old-business loading and ignores its delayed release response', async () => {
        let resolve!: (value: ReturnType<typeof snapshot>) => void;
        vi.mocked(api.request).mockReturnValueOnce(new Promise(value => { resolve = value; }) as never);
        const view = show(<ReleaseGate feature="workspace" fallback={<p>Старый экран</p>}><p>Новая очередь</p></ReleaseGate>);
        await waitFor(() => expect(api.request).toHaveBeenCalled()); const oldSignal = vi.mocked(api.request).mock.calls[0][0].signal;
        state.businessId = 8; state.flags.workspace = false;
        view.rerender(<MemoryRouter><ReleaseGate feature="workspace" fallback={<p>Старый экран</p>}><p>Новая очередь</p></ReleaseGate><Location /></MemoryRouter>);
        await screen.findByText('Старый экран'); expect(oldSignal?.aborted).toBe(true);
        await act(async () => resolve({ data: { success: true, businessId: 7, revision: 2, flags: { workspace: true, analytics: true, autopilot: true }, availability: { workspace: true, analytics: true, autopilot: true } } }));
        expect(screen.queryByText('Новая очередь')).toBeNull(); expect(screen.getByText('Старый экран')).toBeTruthy();
    });
    it('does not search FTS when workspace rollout is disabled', async () => {
        state.flags.workspace = false; show(<QuickJump open onClose={() => {}} />);
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Анна' } });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
        expect(vi.mocked(api.request).mock.calls.some(([config]) => String(config.url).includes('/search?'))).toBe(false);
    });
    it('saves only changed release flags with CAS independently of scenario policies', async () => {
        show(<ReleaseControls businessId={7} />); const toggle = await screen.findByRole('checkbox', { name: /Самостоятельный AI/ });
        fireEvent.click(toggle); fireEvent.click(screen.getByRole('button', { name: 'Сохранить выпуск функций' }));
        await waitFor(() => expect(api.request).toHaveBeenCalledWith(expect.objectContaining({ url: '/businesses/7/release-flags', method: 'put', data: { revision: 2, flags: { autopilot: false } } })));
        await waitFor(() => expect((screen.getByRole('checkbox', { name: /Самостоятельный AI/ }) as HTMLInputElement).checked).toBe(false));
        expect(vi.mocked(api.request).mock.calls.some(([config]) => String(config.url).includes('/autopilot/policy'))).toBe(false);
    });
    it('removes unsaved owner controls after demotion and never writes through the old role', async () => {
        const view = show(<ReleaseControls businessId={7} />); fireEvent.click(await screen.findByRole('checkbox', { name: /Самостоятельный AI/ }));
        state.role = 'observer'; view.rerender(<MemoryRouter><ReleaseControls businessId={7} /></MemoryRouter>);
        expect(screen.queryByRole('button', { name: 'Сохранить выпуск функций' })).toBeNull(); expect(screen.queryByRole('checkbox')).toBeNull();
        expect(vi.mocked(api.request).mock.calls.some(([config]) => config.method === 'put')).toBe(false);
    });
    it('reports revision conflict without pretending that release was saved', async () => {
        state.conflict = true; show(<ReleaseControls businessId={7} />); fireEvent.click(await screen.findByRole('checkbox', { name: /Самостоятельный AI/ })); fireEvent.click(screen.getByRole('button', { name: 'Сохранить выпуск функций' }));
        await screen.findByText('Переключатели изменились. Обновите их и повторите сохранение.'); expect(screen.queryByText('Переключатели выпуска сохранены для этого бизнеса.')).toBeNull();
    });
    it('keeps unavailable pilot functions disabled for the owner', async () => {
        state.available = false; state.flags.autopilot = false; show(<ReleaseControls businessId={7} />);
        const toggle = await screen.findByRole('checkbox', { name: /Самостоятельный AI/ }); expect((toggle as HTMLInputElement).disabled).toBe(true); expect((toggle as HTMLInputElement).checked).toBe(false);
    });
    it('rejects malformed and wrong-business flags before enabling a screen', async () => {
        vi.mocked(api.request).mockResolvedValueOnce({ data: { success: true, businessId: 7, revision: 1, flags: { workspace: 'true', analytics: true, autopilot: true } } } as never);
        await expect(getReleaseFlags(7)).rejects.toMatchObject({ code: 'WORKSPACE_RESPONSE_INVALID' });
        vi.mocked(api.request).mockResolvedValueOnce(snapshot(8) as never); await expect(getReleaseFlags(7)).rejects.toMatchObject({ code: 'WORKSPACE_RESPONSE_INVALID' });
    });
});
