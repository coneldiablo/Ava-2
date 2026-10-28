// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from '../src/pages/Dashboard';
import { BusinessTrend } from '../src/pages/DashboardCharts';
import type { DashboardDays, DashboardMetrics } from '../src/pages/dashboardApi';

const mocks = vi.hoisted(() => ({ businessId: 7, metrics: vi.fn(), intelligence: vi.fn(), activity: vi.fn(), overview: vi.fn(), recommendations: vi.fn(), stats: vi.fn(), ask: vi.fn() }));
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: mocks.businessId, currentInstance: { id: mocks.businessId, name: `Бизнес ${mocks.businessId}`, hotelTimezone: 'Europe/Moscow' } }) }));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ loginName: 'owner', role: 'platform_admin' }) }));
vi.mock('../src/api', () => ({ getStats: mocks.stats }));
vi.mock('../src/pages/dashboardApi', () => ({ getDashboardMetrics: mocks.metrics, getDashboardIntelligence: mocks.intelligence, getDashboardActivity: mocks.activity, getDashboardOverview: mocks.overview, getDashboardRecommendations: mocks.recommendations, askDashboardAva: mocks.ask, completeDashboardTask: vi.fn() }));

function metrics(businessId = 7, days: DashboardDays = 30): DashboardMetrics {
    return { success: true, business_id: businessId, period: { days, timezone: 'Europe/Moscow', start: '2026-10-01T21:00:00Z', endExclusive: '2026-10-03T21:00:00Z', asOf: '2026-10-03T12:00:00Z' },
        kpis: { leads: { total: 19, created: 5, active: 12 }, messages: { inbound: 7, outbound: 4, total: 11 }, deals: { created: 1, open: 1, won: 1, lost: 0, openAmounts: [], wonAmounts: [] }, ai: { recordedSuccessfulToolRuns: 6, status: 'partial' } },
        series: { leads: [{ date: '2026-10-02', count: 2 }, { date: '2026-10-03', count: 3 }], closedDeals: [{ date: '2026-10-02', count: 0, amounts: [] }, { date: '2026-10-03', count: 1, amounts: [] }] },
        dealFunnel: [{ stage: 'new', count: 1, amounts: [] }, { stage: 'qualified', count: 0, amounts: [] }],
        currentFunnel: { status: 'available', scope: 'all_open', totalOpen: 8, items: [{ stage: 'new', count: 3, amounts: [{ currency: 'RUB', amountMinor: 125050 }] }, { stage: 'qualified', count: 5, amounts: [{ currency: 'USD', amountMinor: 9900 }] }] },
        sources: { closedDeals: { status: 'partial', description: 'internal source description' }, ai: { status: 'partial', description: 'tool_runs' } } };
}
function show() { return render(<MemoryRouter><Dashboard /></MemoryRouter>); }
beforeEach(() => {
    vi.clearAllMocks(); mocks.businessId = 7;
    mocks.metrics.mockImplementation((id: number, days: DashboardDays) => Promise.resolve(metrics(id, days)));
    for (const fn of [mocks.intelligence, mocks.activity, mocks.overview, mocks.recommendations, mocks.stats]) fn.mockResolvedValue({ success: false });
});
afterEach(cleanup);

describe('Dashboard grounded infographics', () => {
    it('puts Ask AVA first, keeps current work separate from the period and links Russian stages to actual filters', async () => {
        show();
        const funnel = screen.getByRole('region', { name: 'Воронка сделок' });
        expect((await within(funnel).findByRole('link', { name: 'Квалификация 5' })).getAttribute('href')).toBe('/deals?stage=qualified');
        expect(within(funnel).getByRole('link', { name: 'Новые 3' }).getAttribute('href')).toBe('/deals?stage=new');
        const snapshot = screen.getByRole('region', { name: 'Открытые сделки' });
        expect(snapshot.textContent).toContain('8 в работе');
        expect(snapshot.textContent).toContain('1 250,50'); expect(snapshot.textContent).toContain('99,00');
        const question = screen.getByLabelText('Вопрос для AVA'), chart = screen.getByRole('region', { name: 'Динамика бизнеса' });
        expect(question.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        fireEvent.click(screen.getByRole('button', { name: '7 дн.' }));
        await waitFor(() => expect(mocks.metrics).toHaveBeenCalledWith(7, 7, expect.anything()));
        expect(await within(funnel).findByRole('link', { name: 'Квалификация 5' })).toBeTruthy();
        expect(snapshot.textContent).toContain('8 в работе');
        expect(screen.queryByText('qualified')).toBeNull();
        expect(screen.queryByText(/internal source description|tool_runs/)).toBeNull();
    });

    it('uses keyboard-equivalent date selection, a working legend and an exact table for chart data', async () => {
        render(<BusinessTrend metrics={metrics()} fallback="Загрузка" />);
        const slider = screen.getByRole('slider', { name: 'Дата на графике' });
        expect(slider.getAttribute('aria-valuetext')).toContain('3 окт.');
        fireEvent.change(slider, { target: { value: '0' } });
        expect(slider.getAttribute('aria-valuetext')).toContain('Новые клиенты: 2. Успешные сделки: 0.');
        fireEvent.click(screen.getByRole('button', { name: 'Следующий день на графике' }));
        expect(slider.getAttribute('aria-valuetext')).toContain('Новые клиенты: 3. Успешные сделки: 1.');
        const leads = screen.getByRole('button', { name: 'Новые клиенты' }), won = screen.getByRole('button', { name: 'Успешные сделки' });
        fireEvent.click(leads); expect(leads.getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(won); expect(won.getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(screen.getByText('Показать данные по дням'));
        const rows = within(screen.getByRole('table')).getAllByRole('row');
        expect(rows).toHaveLength(3); expect(rows[1].textContent).toBe('2 окт.20'); expect(rows[2].textContent).toBe('3 окт.31');
    });

    it('shows missing source values as unavailable while keeping real zeros as zeros', () => {
        const data = metrics(); data.sources.closedDeals.status = 'unavailable'; data.series.leads[0].count = 0;
        data.series.leads[1].count = 0;
        const view = render(<BusinessTrend metrics={data} fallback="Загрузка" />);
        expect(screen.getByRole('button', { name: 'Успешные сделки · нет данных' }).hasAttribute('disabled')).toBe(true);
        fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });
        expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toContain('Новые клиенты: 0. Успешные сделки: нет данных.');
        expect(screen.queryByText('За этот период новых клиентов и учтённых успешных сделок нет.')).toBeNull();
        expect(screen.getByText('В доступной дневной истории новых событий пока нет.')).toBeTruthy();
        const missing = { ...data, series: { ...data.series, leads: [{ date: '2026-10-02', count: 0 }] } };
        view.rerender(<BusinessTrend metrics={missing} fallback="Загрузка" />);
        fireEvent.change(screen.getByRole('slider'), { target: { value: '1' } });
        expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toContain('Новые клиенты: нет данных');
        fireEvent.click(screen.getByText('Показать данные по дням'));
        expect(within(screen.getByRole('table')).getAllByRole('row')[2].textContent).toBe('3 окт.нет данныхнет данных');
    });

    it('keeps a zero current funnel distinct from unavailable data and never promotes clients into deals', async () => {
        const data = metrics(); data.currentFunnel = { status: 'available', scope: 'all_open', totalOpen: 0, items: [{ stage: 'new', count: 0, amounts: [] }] };
        mocks.metrics.mockResolvedValue(data); show();
        const funnel = screen.getByRole('region', { name: 'Воронка сделок' });
        expect(await within(funnel).findByText('Открытых сделок пока нет')).toBeTruthy();
        expect(within(funnel).getByRole('link', { name: 'Перейти к сделкам' }).getAttribute('href')).toBe('/deals');
        const cards = screen.getByRole('region', { name: 'Основные показатели бизнеса' });
        expect(within(cards).getByRole('link', { name: /Клиентов всего 19/ })).toBeTruthy();
        mocks.metrics.mockResolvedValue({ ...data, currentFunnel: { status: 'unavailable', scope: 'all_open', totalOpen: null, items: [] } });
        fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));
        await within(funnel).findByText('Текущая воронка недоступна. Повторите загрузку показателей.');
        expect(within(funnel).queryByText('Открытых сделок пока нет')).toBeNull();
        mocks.metrics.mockResolvedValue(data);
        fireEvent.click(within(funnel).getByRole('button', { name: 'Повторить загрузку воронки' }));
        await within(funnel).findByText('Открытых сделок пока нет');
    });

    it('preserves loading/error/retry without manufacturing KPI values', async () => {
        mocks.metrics.mockRejectedValueOnce(new Error('unavailable')); show();
        await screen.findByRole('button', { name: 'Повторить загрузку' });
        const cards = screen.getByRole('region', { name: 'Основные показатели бизнеса' });
        expect(within(cards).getAllByText('—')).toHaveLength(4);
        expect(within(cards).queryByText('0')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку' }));
        await within(cards).findByText('19');
        expect(screen.getByRole('region', { name: 'Общение с клиентами' }).textContent).toContain('Получено от клиентов7');
    });

    it('ignores old business metrics after switching business and does not leak old chart data', async () => {
        let finish!: (value: DashboardMetrics) => void;
        mocks.metrics.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const view = show(); mocks.businessId = 8; view.rerender(<MemoryRouter><Dashboard /></MemoryRouter>);
        await screen.findByRole('link', { name: 'Квалификация 5' });
        const old = metrics(7); old.currentFunnel!.items[1].count = 999;
        await act(async () => finish(old));
        expect(screen.queryByRole('link', { name: 'Квалификация 999' })).toBeNull();
        expect(screen.getByRole('link', { name: 'Квалификация 5' })).toBeTruthy();
    });

    it('opens exact deal sources and real collection pages without confusing a client row ID with its chat', async () => {
        mocks.ask.mockResolvedValue({ success: true, grounded: true, answer: 'Сделка ожидает ответа.', sources: [{ type: 'customer_deal', id: 'deal/one' }, { type: 'client', id: '123' }, { type: 'knowledge', id: 'internal-document-id' }] });
        show(); fireEvent.change(screen.getByLabelText('Вопрос для AVA'), { target: { value: 'Что происходит?' } });
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' })); await screen.findByText('Сделка ожидает ответа.');
        fireEvent.click(screen.getByText('На чём основан ответ'));
        const sources = screen.getByText('На чём основан ответ').closest('details')!;
        expect(within(sources).getByRole('link', { name: 'Сделки' }).getAttribute('href')).toBe('/deals?dealId=deal%2Fone');
        expect(within(sources).getByRole('link', { name: 'Карточки клиентов' }).getAttribute('href')).toBe('/clients');
        expect(within(sources).getByRole('link', { name: 'База знаний' }).getAttribute('href')).toBe('/knowledge-base');
        expect(sources.textContent).not.toMatch(/123|internal-document-id/);
    });
});
