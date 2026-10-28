// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Dashboard from '../src/pages/Dashboard';

const mocks = vi.hoisted(() => ({
    activity: vi.fn(), metrics: vi.fn(), intelligence: vi.fn(),
    recommendations: vi.fn(), overview: vi.fn(), ask: vi.fn(), stats: vi.fn(), completeTask: vi.fn(), businessId: 7, role: 'platform_admin',
}));

vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({
    currentInstanceId: mocks.businessId, currentInstance: { id: mocks.businessId, name: 'Тестовый бизнес', businessType: 'standard' },
}) }));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ loginName: 'owner@example.test', role: mocks.role }) }));
vi.mock('../src/api', () => ({ getStats: mocks.stats }));
vi.mock('../src/pages/dashboardApi', () => ({
    getDashboardActivity: mocks.activity, getDashboardMetrics: mocks.metrics,
    getDashboardIntelligence: mocks.intelligence,
    completeDashboardTask: mocks.completeTask, getDashboardRecommendations: mocks.recommendations, getDashboardOverview: mocks.overview, askDashboardAva: mocks.ask,
}));

const activity = {
    success: true, instanceId: 7,
    period: { from: '2026-09-24T17:00:00Z', to: '2026-09-25T06:00:00Z', timezone: 'Europe/Moscow' },
    status: 'available', sourceComplete: false,
    coverage: { sampledRowsComplete: true, deals: 'partial', aiActions: 'partial', description: 'История сделок доступна частично.' },
    items: [
        { id: 'new_lead:1', category: 'client', kind: 'new_lead', title: 'Новый клиент А', description: 'Запись CRM', occurredAt: '2026-09-25T01:00:00Z', target: { type: 'client', id: 'chat-1', path: '/client/chat-1' }, source: { type: 'client', id: '1' } },
        { id: 'tool_run:1', category: 'ai', kind: 'tool_run', title: 'Вызов AVA', description: 'Успешный вызов инструмента', occurredAt: '2026-09-25T02:00:00Z', source: { type: 'tool_run', id: '1' } },
    ],
};
const makeOverview = (businessId: number, window: 'overnight' | 'yesterday') => ({
    success: true,
    overview: {
        businessId, window: { kind: window, timezone: 'Europe/Moscow', localDate: '2026-09-25',
            start: '2026-09-24T17:00:00Z', endExclusive: '2026-09-25T06:00:00Z', complete: true },
        asOf: '2026-09-25T07:00:00Z', status: 'partial', answerStatus: 'answered',
        summary: window === 'overnight' ? 'Ночью появился новый клиент.' : 'Вчера менеджер обработал заявку.',
        grounded: true, sources: [{ type: 'client', id: '1', createdAt: '2026-09-25T01:00:00Z' }],
        highlights: [{ id: 'client:1', type: 'new_lead', text: 'Создана запись клиента.',
            source: { type: 'client', id: '1', createdAt: '2026-09-25T01:00:00Z' } }],
        sourceRevision: 'revision-1', sourceUpdatedAt: '2026-09-25T01:00:00Z',
        generatedAt: '2026-09-25T07:00:00Z', summaryThrough: '2026-09-25T06:00:00Z',
        limitations: ['dedicated_inbound_call_history_unavailable'],
        counts: { clients: { status: 'available', count: 1 }, messages: { status: 'available', count: 2 },
            lead_status_history: { status: 'available', count: 0 }, customer_deals: { status: 'unavailable', count: null } },
    },
});

function showDashboard() {
    return render(<MemoryRouter><Dashboard /></MemoryRouter>);
}

beforeEach(() => {
    mocks.businessId = 7; mocks.role = 'platform_admin';
    mocks.activity.mockResolvedValue(activity);
    mocks.metrics.mockResolvedValue({ success: false });
    mocks.intelligence.mockResolvedValue({ success: false });
    mocks.recommendations.mockResolvedValue({ success: false });
    mocks.overview.mockImplementation((id: number, window: 'overnight' | 'yesterday') =>
        Promise.resolve(makeOverview(id, window)));
    mocks.stats.mockResolvedValue({ success: false });
    mocks.ask.mockResolvedValue({ success: true, answer: 'Один новый клиент.', sources: [{ type: 'client', id: '1' }], grounded: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('Dashboard activity and Ask AVA', () => {
    it('opens customer questions in the persistent assistant instead of making an isolated dashboard request', async () => {
        mocks.role = 'customer';
        function Location() { const location = useLocation(); return <output>{location.pathname + location.search}</output>; }
        render(<MemoryRouter><Dashboard /><Location /></MemoryRouter>);
        fireEvent.change(screen.getByLabelText('Вопрос для AVA'), { target: { value: 'Сколько клиентов всего в CRM?' } });
        fireEvent.click(screen.getByRole('button', { name: 'Открыть вопрос в помощнике AVA' }));
        expect(screen.getByText('/business-gpt?question=' + encodeURIComponent('Сколько клиентов всего в CRM?'))).toBeTruthy();
        expect(mocks.ask).not.toHaveBeenCalled();
    });

    it('keeps displayed data and the question during polling without regenerating daily summaries', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        mocks.stats.mockResolvedValueOnce({ success: true, stats: { totalClients: 321, activeLeads: 5, booked: 2, conversion: 1 } })
            .mockImplementation(() => new Promise(() => {}));
        showDashboard();
        expect(await screen.findByText('321')).toBeTruthy();
        await screen.findByText('Ночью появился новый клиент.');
        fireEvent.change(screen.getByLabelText('Вопрос для AVA'), { target: { value: 'Мой незавершённый вопрос' } });
        await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
        expect(screen.getByText('321')).toBeTruthy();
        expect(screen.getByDisplayValue('Мой незавершённый вопрос')).toBeTruthy();
        expect(screen.getByText('Ночью появился новый клиент.')).toBeTruthy();
        expect(mocks.overview).toHaveBeenCalledTimes(2);
    });
    it('shows grounded customer overviews without technical audit fields', async () => {
        showDashboard();
        expect(await screen.findByText('Ночью появился новый клиент.')).toBeTruthy();
        expect(screen.getByText('Вчера менеджер обработал заявку.')).toBeTruthy();
        expect(mocks.overview).toHaveBeenCalledWith(7, 'overnight', expect.anything());
        expect(mocks.overview).toHaveBeenCalledWith(7, 'yesterday', expect.anything());
        const night = screen.getByRole('region', { name: 'Что произошло за ночь' });
        expect(within(night).queryByText('Создана запись клиента.')).toBeNull();
        expect(within(night).queryByText(/По записям до/)).toBeNull();
        expect(within(night).queryByText(/client:1|dedicated_inbound|Источники:/)).toBeNull();
    });

    it('accepts the customer AI contract without audit sources and keeps the scroll area keyboard accessible', async () => {
        mocks.overview.mockImplementation((id: number, window: 'overnight' | 'yesterday') => Promise.resolve({success:true, overview: {
            businessId:id, window:{kind:window,timezone:'Europe/Moscow'}, status:'available',answerStatus:'answered',grounded:true,
            summary:'Подтверждённый вывод AVA',changes:['Клиент запросил встречу'],attention:['Уточнить время'],outcome:'Менеджеру нужен ответ',
        }}));
        showDashboard();
        expect(await screen.findAllByText('Подтверждённый вывод AVA')).toHaveLength(2);
        expect(screen.queryByText('Уточнить время')).toBeNull();
        expect(screen.getByLabelText('Что произошло за ночь: сведения AVA').getAttribute('tabindex')).toBe('0');
    });

    it.each(['answered', 'insufficient'])('shows grounded %s overview once when outcome repeats summary', async (answerStatus) => {
        const summary = 'Есть запрос клиента, но данных для оценки риска недостаточно.';
        mocks.overview.mockImplementation((id: number, window: 'overnight' | 'yesterday') => Promise.resolve({
            success: true, overview: { businessId: id, window: { kind: window, timezone: 'Europe/Moscow' },
                status: 'available', answerStatus, grounded: true, summary, outcome: `  ${summary}  `,
                changes: ['Поступил запрос'], attention: ['Уточнить детали'] },
        }));
        showDashboard();
        const night = screen.getByRole('region', { name: 'Что произошло за ночь' });
        expect(await within(night).findAllByText(summary)).toHaveLength(1);
        expect(within(night).queryByText('Уточнить детали')).toBeNull();
        expect(within(night).queryByText('Пока недостаточно событий для вывода.')).toBeNull();
    });

    it('does not show a CRM report when an AI overview fails', async () => {
        mocks.overview.mockImplementation((id: number, window: 'overnight' | 'yesterday') =>
            window === 'overnight' ? Promise.reject(new Error('provider unavailable')) : Promise.resolve(makeOverview(id, window)));
        showDashboard();
        const night = screen.getByRole('region', { name: 'Что произошло за ночь' });
        expect(await within(night).findByText('Не удалось подготовить обзор. Повторите попытку — остальная работа доступна.')).toBeTruthy();
        expect(screen.queryByText('Отчёт по CRM')).toBeNull();
        expect(screen.queryByText('PDF-отчёт')).toBeNull();
    });

    it('retries only the failed overview and preserves its last confirmed version', async () => {
        showDashboard();
        const night = screen.getByRole('region', { name: 'Что произошло за ночь' });
        await within(night).findByText('Ночью появился новый клиент.');
        mocks.overview.mockImplementation((id: number, window: 'overnight' | 'yesterday') =>
            window === 'overnight' ? Promise.reject(new Error('temporary outage')) : Promise.resolve(makeOverview(id, window)));
        fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));
        await within(night).findByText('Обзор не обновился. Сохранена последняя проверенная версия.');
        expect(within(night).getByText('Ночью появился новый клиент.')).toBeTruthy();
        mocks.overview.mockClear();
        mocks.overview.mockImplementation((id: number, window: 'overnight' | 'yesterday') => Promise.resolve(makeOverview(id, window)));
        fireEvent.click(within(night).getByRole('button', { name: 'Повторить обзор' }));
        await waitFor(() => expect(mocks.overview).toHaveBeenCalledTimes(1));
        expect(mocks.overview).toHaveBeenCalledWith(7, 'overnight', expect.anything());
        await waitFor(() => expect(within(night).queryByText('Обзор не обновился. Сохранена последняя проверенная версия.')).toBeNull());
    });

    it('keeps the question and allows a local retry after an AI failure', async () => {
        mocks.ask.mockRejectedValueOnce(new Error('offline'));
        showDashboard();
        fireEvent.change(screen.getByLabelText('Вопрос для AVA'), { target: { value: 'Кому перезвонить?' } });
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Повторить вопрос' }));
        await screen.findByText('Один новый клиент.');
        expect(mocks.ask).toHaveBeenCalledTimes(2);
        expect(screen.getByDisplayValue('Кому перезвонить?')).toBeTruthy();
    });

    it('ignores a late cancelled answer and permits the next question', async () => {
        let finish!: (value: unknown) => void;
        mocks.ask.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        showDashboard();
        fireEvent.change(screen.getByLabelText('Вопрос для AVA'), { target: { value: 'Что произошло?' } });
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        fireEvent.click(screen.getByRole('button', { name: 'Отменить вопрос' }));
        await act(async () => finish({ success: true, grounded: true, sources: [], answer: 'Поздний ответ' }));
        expect(screen.queryByText('Поздний ответ')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        await screen.findByText('Один новый клиент.');
    });

    it('shows three concrete priorities and confirms completion before mutation', async () => {
        mocks.intelligence.mockResolvedValue({ success: true, instanceId: 7,
            priorities: [1, 2, 3, 4].map(index => ({ id: `t${index}`, kind: 'task', title: `Задача ${index}`, reason: 'Клиент ждёт звонок', nextAction: 'Перезвонить', score: 99,
                target: { path: `/today?client=c${index}` }, completeAction: { method: 'PATCH', path: '/unused', body: { status: 'done' } } })),
            sentiment: { status: 'unavailable' }, deals: { status: 'available', items: [] }, dayPlan: { status: 'available', items: [], date: '2026-10-15' }, agents: { status: 'available', items: [{ name: 'private-agent-container', status: 'running' }] },
        });
        mocks.completeTask.mockResolvedValue({ success: true });
        showDashboard();
        const today = await screen.findByRole('region', { name: 'Что требует вашего внимания' });
        await within(today).findByText('Задача 1');
        expect(within(today).queryByText('Задача 4')).toBeNull();
        expect(screen.queryByText(/Priority Score|private-agent-container|99 баллов/)).toBeNull();
        fireEvent.click(within(today).getAllByRole('button', { name: 'Завершить задачу' })[0]);
        expect(mocks.completeTask).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить завершение' }));
        await waitFor(() => expect(mocks.completeTask).toHaveBeenCalledWith(7, 't1'));
    });

    it('discards an old business AI overview after switching businesses', async () => {
        let resolveOld!: (value: ReturnType<typeof makeOverview>) => void;
        mocks.overview.mockImplementation((id: number, window: 'overnight' | 'yesterday') =>
            id === 7 && window === 'overnight'
                ? new Promise(resolve => { resolveOld = resolve; })
                : Promise.resolve(makeOverview(id, window)));
        const view = showDashboard();
        mocks.businessId = 8;
        view.rerender(<MemoryRouter><Dashboard /></MemoryRouter>);
        const night = screen.getByRole('region', { name: 'Что произошло за ночь' });
        expect(await within(night).findByText('Ночью появился новый клиент.')).toBeTruthy();
        resolveOld({ ...makeOverview(7, 'overnight'), overview: {
            ...makeOverview(7, 'overnight').overview, summary: 'Секрет старого бизнеса',
        } });
        await waitFor(() => expect(within(night).queryByText('Секрет старого бизнеса')).toBeNull());
    });
    it('filters confirmed overnight records while retaining an exact new-client link', async () => {
        showDashboard();
        expect(await screen.findByText('Вызов AVA')).toBeTruthy();
        expect(screen.getAllByRole('article')).toHaveLength(2);
        const leadSummary = screen.getByRole('complementary', { name: 'Новые лиды за ночь' });
        expect(within(leadSummary).getByRole('link', { name: 'Открыть' }).getAttribute('href')).toBe('/client/chat-1');
        expect(screen.queryByText(/История сделок доступна частично/)).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'AI действия' }));
        expect(screen.getByRole('button', { name: 'AI действия' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getAllByRole('article')).toHaveLength(1);
        expect(within(screen.getByRole('article')).getByText('Вызов AVA')).toBeTruthy();
        expect(within(leadSummary).getByText('Новый клиент А')).toBeTruthy();
    });

    it('shows a failed activity request without fabricating a lead count', async () => {
        mocks.activity.mockRejectedValueOnce(new Error('unavailable'));
        showDashboard();
        expect(await screen.findByText('Не удалось загрузить события за ночь.')).toBeTruthy();
        expect(screen.queryByRole('complementary', { name: 'Новые лиды за ночь' })).toBeNull();
        expect(screen.getByRole('button', { name: 'AI действия' }).hasAttribute('disabled')).toBe(true);
    });

    it('uses the selected business when a suggested client-count question is submitted', async () => {
        mocks.ask.mockResolvedValueOnce({ success: true, answer: 'В CRM за всё время: 11 клиентов.',
            sources: [{ type: 'dashboard_aggregate', id: 'current:clients' }], grounded: true });
        showDashboard();
        fireEvent.click(screen.getByRole('button', { name: 'Сколько клиентов всего в CRM?' }));
        expect((screen.getByRole('textbox', { name: 'Вопрос для AVA' }) as HTMLInputElement).value).toBe('Сколько клиентов всего в CRM?');
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        await waitFor(() => expect(mocks.ask).toHaveBeenCalledWith(7, 'Сколько клиентов всего в CRM?', expect.anything()));
        expect(await screen.findByText('В CRM за всё время: 11 клиентов.')).toBeTruthy();
    });

    it('distinguishes an ungrounded answer from a knowledge base that is not ready', async () => {
        mocks.ask.mockResolvedValueOnce({ success: true, answer: 'Подтверждённого ответа нет.', sources: [], grounded: false, dataStatus: 'ungrounded' })
            .mockRejectedValueOnce({ isAxiosError: true, response: { data: { code: 'KNOWLEDGE_NOT_READY' } } });
        showDashboard();
        fireEvent.click(screen.getByRole('button', { name: 'Сколько клиентов всего в CRM?' }));
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        expect(await screen.findByText('Подтверждённого ответа нет.')).toBeTruthy();
        expect(screen.getByText('Недостаточно данных для ответа')).toBeTruthy();
        fireEvent.change(screen.getByRole('textbox', { name: 'Вопрос для AVA' }), { target: { value: 'Во сколько заезд?' } });
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        expect(await screen.findByText('База знаний этого бизнеса ещё не готова. Попробуйте позже.')).toBeTruthy();
    });

    it('ignores an old business response after the business changes', async () => {
        let resolveOld!: (value: typeof activity) => void;
        mocks.activity.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
            .mockResolvedValueOnce({ ...activity, instanceId: 8, sourceComplete: true, items: [] });
        const view = showDashboard();
        mocks.businessId = 8;
        view.rerender(<MemoryRouter><Dashboard /></MemoryRouter>);
        expect(await screen.findByText('За ночь подтверждённых событий нет.')).toBeTruthy();
        resolveOld(activity);
        await waitFor(() => expect(screen.queryByText('Новый клиент А')).toBeNull());
        expect(screen.queryByRole('complementary', { name: 'Новые лиды за ночь' })?.textContent).not.toContain('Новый клиент А');
    });
});
