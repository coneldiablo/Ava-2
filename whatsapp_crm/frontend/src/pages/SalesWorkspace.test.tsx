// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { clearWorkspaceDrafts } from '../hooks/useScopedDraft';
import SalesWorkspace, { dueInstant } from './SalesWorkspace';
import { claimSalesTask, createSalesTask, getSalesWorkspace, updateSalesTask } from '../api';
const fixture = vi.hoisted(() => ({ businessId: 7, userId: 'employee', role: 'manager', checking: false, summary: 'Позвонить Анне', done: false, claims: false, capabilities: ['business.read', 'sales.read', 'sales.write', 'tasks.claim', 'messages.send', 'ai.use'] as string[] }));
vi.mock('../context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: fixture.businessId, currentInstance: { name: `Бизнес ${fixture.businessId}` } }) }));
vi.mock('../permissions', () => ({ useBusinessAccess: () => ({ role: fixture.role, userId: fixture.userId, checking: fixture.checking, membership: { role: fixture.role, capabilities: fixture.capabilities }, can: (cap: string) => !fixture.checking && fixture.capabilities.includes(cap) }) }));
vi.mock('../api', () => ({
    getSalesWorkspace: vi.fn(async (id: number, view: string) => ({ success: true, businessId: id, view, currentUserId: fixture.userId, capabilities: fixture.capabilities, summary: { openTasks: fixture.done ? 0 : 1, overdueTasks: 0, pendingFollowups: 0, unassignedClients: 0 }, members: [{ userId: 'employee', displayName: 'Анна', email: 'anna@example.test', role: 'manager', openTasks: 1, overdueTasks: 0 }], tasks: fixture.done ? [] : [{ taskId: 'task-1', chatId: 'card', customerName: 'Клиент Анна', summary: fixture.summary, status: 'new', priority: 'normal', dueAt: null, assigneeUserId: view === 'queue' && !fixture.claims ? null : fixture.userId, assigneeName: view === 'queue' && !fixture.claims ? null : 'Анна', followupDraftId: null }], clients: [], pagination: { page: 1, pageSize: 30, totalTasks: fixture.done ? 0 : 1, totalClients: 0 } })),
    updateSalesTask: vi.fn(async (_id: number, _task: string, input: { summary: string; status: string }) => { fixture.summary = input.summary; fixture.done = input.status === 'done'; return { success: true }; }),
    claimSalesTask: vi.fn(async () => { fixture.claims = true; return { success: true }; }), assignSalesClient: vi.fn(),
    getClients: vi.fn(async () => ({ success: true, clients: [{ chatId: 'anna-card', senderName: 'Клиент Анна' }] })), createSalesTask: vi.fn(async () => ({ success: true })),
}));
const show = (path = '/sales') => render(<MemoryRouter initialEntries={[path]}><SalesWorkspace/></MemoryRouter>);
describe('Sales workspace capabilities and readback', () => {
    beforeEach(() => { vi.clearAllMocks(); clearWorkspaceDrafts(); fixture.businessId = 7; fixture.userId = 'employee'; fixture.checking = false; fixture.role = 'manager'; fixture.summary = 'Позвонить Анне'; fixture.done = false; fixture.claims = false; fixture.capabilities = ['business.read','sales.read','sales.write','tasks.claim','messages.send','ai.use']; });
    afterEach(cleanup);
    it('manager has own landing and no team assignment controls', async () => { show(); await screen.findByText('Позвонить Анне'); expect(screen.getByRole('heading', { name: 'Задачи', level: 1 })).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Вся команда' })).toBeNull(); });
    it('edits an own task and displays readback rather than optimistic data', async () => {
        show(); await screen.findByText('Позвонить Анне'); fireEvent.click(screen.getByRole('button', { name: 'Изменить' }));
        fireEvent.change(screen.getByLabelText('Что нужно сделать'), { target: { value: 'Согласовать встречу' } }); fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
        await screen.findByText('Согласовать встречу'); expect(getSalesWorkspace).toHaveBeenCalledTimes(2);
        expect(updateSalesTask).toHaveBeenCalledWith(7, 'task-1', expect.objectContaining({ summary: 'Согласовать встречу', dueAt: null }), expect.any(AbortSignal));
    });
    it('completion closes task and never implies message delivery', async () => {
        show(); await screen.findByText('Позвонить Анне'); fireEvent.click(screen.getByRole('button', { name: 'Изменить' }));
        fireEvent.change(screen.getByLabelText('Состояние задачи'), { target: { value: 'done' } }); fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
        await screen.findByText('У вас нет открытых задач.'); expect(screen.getByRole('status').textContent).toContain('Статус отправки сообщения проверяется');
    });
    it('queue claim uses task endpoint and re-reads the list', async () => {
        show('/sales?view=queue'); await screen.findByRole('button', { name: 'Взять задачу' }); fireEvent.click(screen.getByRole('button', { name: 'Взять задачу' }));
        await waitFor(() => expect(claimSalesTask).toHaveBeenCalledWith(7, 'task-1', expect.any(AbortSignal))); await waitFor(() => expect(getSalesWorkspace).toHaveBeenCalledTimes(2));
    });
    it('observer sees real task without mutations', async () => {
        fixture.role = 'observer'; fixture.capabilities = ['business.read','sales.read','team.read']; show(); await screen.findByText('Позвонить Анне');
        expect(getSalesWorkspace).toHaveBeenCalledWith(7, 'overview', 1, expect.any(AbortSignal));
        expect(screen.getByRole('button', { name: 'Все доступные' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.queryByRole('button', { name: 'Мои задачи' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Вся команда' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Новая задача' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Изменить' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Взять задачу' })).toBeNull();
    });
    it('lead defaults to the full department and workload', async () => { fixture.role = 'sales_lead'; fixture.capabilities.push('sales.assign','tasks.manage'); show(); await screen.findByRole('heading', { name: 'Нагрузка команды' }); expect(getSalesWorkspace).toHaveBeenCalledWith(7, 'team', 1, expect.any(AbortSignal)); });
    it('failed source has dashes and no false empty state', async () => {
        vi.mocked(getSalesWorkspace).mockRejectedValueOnce(new Error()); show(); await screen.findByRole('alert'); expect(screen.queryByText('У вас нет открытых задач.')).toBeNull(); expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    });
    it('creates durable task on exact selected customer', async () => {
        show(); await screen.findByText('Позвонить Анне'); fireEvent.click(screen.getByRole('button', { name: 'Новая задача' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Клиент Анна' })); fireEvent.change(screen.getByLabelText('Что нужно сделать'), { target: { value: 'Уточнить оплату' } }); fireEvent.click(screen.getByRole('button', { name: 'Создать задачу' }));
        await waitFor(() => expect(createSalesTask).toHaveBeenCalledWith(7, { chatId: 'anna-card', summary: 'Уточнить оплату', dueAt: null, priority: 'normal' }, expect.any(AbortSignal)));
    });
    it('retains a nested new-task draft during pending unchanged permission refresh', async () => {
        const view = show(); await screen.findByText('Позвонить Анне'); fireEvent.click(screen.getByRole('button', { name: 'Новая задача' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Клиент Анна' })); fireEvent.change(screen.getByLabelText('Что нужно сделать'), { target: { value: 'Черновик до проверки прав' } });
        fixture.checking = true; view.rerender(<MemoryRouter><SalesWorkspace/></MemoryRouter>); expect(screen.getByDisplayValue('Черновик до проверки прав')).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Создать задачу' }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.submit(screen.getByLabelText('Что нужно сделать').closest('form')!); expect(createSalesTask).not.toHaveBeenCalled();
        fixture.checking = false; view.rerender(<MemoryRouter><SalesWorkspace/></MemoryRouter>); expect(screen.getByDisplayValue('Черновик до проверки прав')).toBeTruthy();
    });
    it('preserves the list and draft on 503, blocks stale submit, and resets only after confirmed create', async () => {
        show(); await screen.findByText('Позвонить Анне'); fireEvent.click(screen.getByRole('button', { name: 'Новая задача' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Клиент Анна' }));
        fireEvent.change(screen.getByLabelText('Что нужно сделать'), { target: { value: 'Черновик при 503' } });
        vi.mocked(getSalesWorkspace).mockRejectedValueOnce({ response: { status: 503 } });
        fireEvent.click(screen.getByRole('button', { name: 'Обновить задачи' })); await screen.findByRole('alert');
        expect(screen.getByText('Позвонить Анне')).toBeTruthy(); expect(screen.getByDisplayValue('Черновик при 503')).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Создать задачу' }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.submit(screen.getByLabelText('Что нужно сделать').closest('form')!); expect(createSalesTask).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
        await waitFor(() => expect((screen.getByRole('button', { name: 'Создать задачу' }) as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(screen.getByRole('button', { name: 'Создать задачу' }));
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Создать задачу' })).toBeNull());
        await waitFor(() => expect((screen.getByRole('button', { name: 'Новая задача' }) as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(screen.getByRole('button', { name: 'Новая задача' }));
        expect((screen.getByLabelText('Что нужно сделать') as HTMLTextAreaElement).value).toBe('');
        expect(screen.getByLabelText('Клиент')).toBeTruthy();
    });
    it('restores the new-task form, exact customer and fields after filter and route transitions', async () => {
        render(<MemoryRouter initialEntries={['/sales']}><Routes><Route path="sales" element={<SalesWorkspace/>}/><Route path="customers/:id" element={<Link to="/sales">К задачам</Link>}/></Routes></MemoryRouter>);
        await screen.findByText('Позвонить Анне'); fireEvent.click(screen.getByRole('button', { name: 'Новая задача' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Клиент Анна' }));
        fireEvent.change(screen.getByLabelText('Что нужно сделать'), { target: { value: 'Вернуться к предложению' } });
        fireEvent.change(screen.getByLabelText('Срок · ваше местное время'), { target: { value: '2026-10-16T11:30' } });
        fireEvent.change(screen.getByLabelText('Приоритет'), { target: { value: 'urgent' } });
        fireEvent.click(screen.getByRole('button', { name: 'Без ответственного' }));
        await waitFor(() => expect(getSalesWorkspace).toHaveBeenLastCalledWith(7, 'queue', 1, expect.any(AbortSignal)));
        expect(screen.getByDisplayValue('Вернуться к предложению')).toBeTruthy();
        fireEvent.click(screen.getByRole('link', { name: 'Клиент Анна' })); fireEvent.click(screen.getByRole('link', { name: 'К задачам' }));
        await screen.findByDisplayValue('Вернуться к предложению');
        expect((screen.getByLabelText('Приоритет') as HTMLSelectElement).value).toBe('urgent');
        expect((screen.getByLabelText('Срок · ваше местное время') as HTMLInputElement).value).toBe('2026-10-16T11:30');
        expect(screen.getByRole('button', { name: 'Выбрать другого' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Без ответственного' }).getAttribute('aria-pressed')).toBe('true');
    });
    it('restores an open task editor and every edited field after route unmount', async () => {
        render(<MemoryRouter initialEntries={['/sales']}><Routes><Route path="sales" element={<SalesWorkspace/>}/><Route path="customers/:id" element={<Link to="/sales">К задачам</Link>}/></Routes></MemoryRouter>);
        await screen.findByText('Позвонить Анне'); fireEvent.click(screen.getByRole('button', { name: 'Изменить' }));
        fireEvent.change(screen.getByLabelText('Что нужно сделать'), { target: { value: 'Завтра подтвердить встречу' } });
        fireEvent.change(screen.getByLabelText('Состояние задачи'), { target: { value: 'in_progress' } });
        fireEvent.change(screen.getByLabelText('Приоритет'), { target: { value: 'high' } });
        fireEvent.click(screen.getByRole('link', { name: 'Клиент Анна' })); fireEvent.click(screen.getByRole('link', { name: 'К задачам' }));
        await screen.findByDisplayValue('Завтра подтвердить встречу');
        expect((screen.getByLabelText('Состояние задачи') as HTMLSelectElement).value).toBe('in_progress');
        expect((screen.getByLabelText('Приоритет') as HTMLSelectElement).value).toBe('high');
    });
    it.each(['businessId', 'userId'] as const)('clears the previous draft scope after changing %s', async field => {
        const view = show(); await screen.findByText('Позвонить Анне'); fireEvent.click(screen.getByRole('button', { name: 'Новая задача' }));
        fireEvent.change(screen.getByLabelText('Что нужно сделать'), { target: { value: 'Предыдущий scope' } });
        if (field === 'businessId') fixture.businessId = 8; else fixture.userId = 'other-employee';
        view.rerender(<MemoryRouter><SalesWorkspace/></MemoryRouter>);
        expect(screen.queryByDisplayValue('Предыдущий scope')).toBeNull();
        await waitFor(() => expect((screen.getByRole('button', { name: 'Новая задача' }) as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(screen.getByRole('button', { name: 'Новая задача' }));
        expect((screen.getByLabelText('Что нужно сделать') as HTMLTextAreaElement).value).toBe('');
        if (field === 'businessId') fixture.businessId = 7; else fixture.userId = 'employee';
        view.rerender(<MemoryRouter><SalesWorkspace/></MemoryRouter>);
        expect(screen.queryByDisplayValue('Предыдущий scope')).toBeNull();
    });
    it('converts a local due date to an explicit instant', () => { const instant = dueInstant('2026-10-02T18:30'); expect(instant).toMatch(/Z$/); expect(Date.parse(instant!)).toBe(new Date('2026-10-02T18:30').getTime()); expect(dueInstant('')).toBeNull(); });
});
