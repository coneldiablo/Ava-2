// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from '../src/pages/Dashboard';

const mocks = vi.hoisted(() => ({
    businessId: 4 as number | null, ask: vi.fn(), activity: vi.fn(),
    metrics: vi.fn(), intelligence: vi.fn(), recommendations: vi.fn(), overview: vi.fn(), stats: vi.fn(),
}));
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({
    currentInstanceId: mocks.businessId,
    currentInstance: mocks.businessId ? { id: mocks.businessId, name: `Бизнес ${mocks.businessId}`, businessType: 'standard' } : null,
}) }));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ loginName: 'fixture@example.test', role: 'platform_admin' }) }));
vi.mock('../src/api', () => ({ getStats: mocks.stats }));
vi.mock('../src/pages/dashboardApi', () => ({
    askDashboardAva: mocks.ask, getDashboardActivity: mocks.activity,
    getDashboardMetrics: mocks.metrics, getDashboardIntelligence: mocks.intelligence,
    getDashboardRecommendations: mocks.recommendations,
    getDashboardOverview: mocks.overview,
    completeDashboardTask: vi.fn(),
}));

const crmAnswer = {
    success: true, answer: 'В бизнесе 4 одна сделка требует внимания.',
    sources: [{ type: 'customer_deal', id: 'tenant-4-deal' }], grounded: true, provenance: 'crm_records',
};
const knowledgeAnswer = {
    success: true, answer: 'Заезд в бизнесе 19 после 15:00.',
    sources: [{ type: 'knowledge', id: 'tenant-19-rules', title: 'Правила бизнеса 19' }],
    grounded: true, provenance: 'onyx_knowledge',
};
function show() { return render(<MemoryRouter><Dashboard /></MemoryRouter>); }
function formQuestion(question = 'Какие сделки требуют внимания?') {
    const input = screen.getByRole('textbox', { name: 'Вопрос для AVA' });
    fireEvent.change(input, { target: { value: question } });
    return input.closest('form')!;
}
function revealAnswerSources() {
    const summary = screen.getByText('На чём основан ответ');
    const disclosure = summary.closest('details')!;
    expect(disclosure.hasAttribute('open')).toBe(false);
    fireEvent.click(summary);
    expect(disclosure.hasAttribute('open')).toBe(true);
    return within(disclosure);
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

beforeEach(() => {
    vi.resetAllMocks();
    mocks.businessId = 4;
    for (const fn of [mocks.metrics, mocks.intelligence, mocks.recommendations, mocks.overview, mocks.stats]) {
        fn.mockResolvedValue({ success: false });
    }
    mocks.activity.mockImplementation((instanceId: number) => Promise.resolve({
        success: true, instanceId, status: 'available', items: [], sourceComplete: true,
        period: { from: '2026-09-27T17:00:00Z', to: '2026-09-28T06:00:00Z', timezone: 'Europe/Moscow' },
    }));
    mocks.ask.mockResolvedValue(crmAnswer);
});
afterEach(cleanup);

describe('Dashboard answer recovery and tenant boundaries', () => {
    it.each([
        ['empty answer', { ...crmAnswer, answer: '   ' }],
        ['missing answer', { success: true, sources: [], grounded: true }],
        ['missing sources', { success: true, answer: 'Invalid response', grounded: true }],
        ['missing grounded state', { success: true, answer: 'Invalid response', sources: [] }],
        ['failure envelope', { success: false, answer: 'Invalid response', sources: [], grounded: true }],
        ['null envelope', null],
    ])('keeps %s in error without displaying a successful response', async (_label, response) => {
        mocks.ask.mockResolvedValueOnce(response);
        show();
        fireEvent.submit(formQuestion());
        expect(await screen.findByText('Не удалось получить ответ. Попробуйте ещё раз.')).toBeTruthy();
        expect(screen.queryByText(/^Ответ AVA/)).toBeNull();
        expect(screen.queryByText('Invalid response')).toBeNull();
        expect(screen.queryByText(/AVA анализирует/)).toBeNull();
        expect(screen.getByRole('button', { name: 'Отправить вопрос' }).hasAttribute('disabled')).toBe(false);
    });

    it('shows grounded insufficient risk explanation and its sources without pretending a forecast', async () => {
        const answer = 'В CRM есть две открытые сделки. Истории переходов и отказов недостаточно, чтобы оценить риск срыва.';
        mocks.ask.mockResolvedValueOnce({ success: true, answerStatus: 'insufficient', grounded: true,
            answer, provenance: 'aitunnel_crm', sources: [{ type: 'customer_deal', id: 'scoped-deal' }] });
        show();
        fireEvent.submit(formQuestion('Какие сделки рискуют сорваться?'));
        expect(await screen.findByText(answer)).toBeTruthy();
        expect(screen.getByText('Что известно')).toBeTruthy();
        expect(revealAnswerSources().getByText('Сделки')).toBeTruthy();
        expect(screen.queryByText(/scoped-deal|aitunnel_crm/)).toBeNull();
        expect(screen.queryByText('Недостаточно данных для ответа')).toBeNull();
        expect(screen.queryByText(/Ответ не подтверждён источниками/)).toBeNull();
    });

    it('shows a deterministic CRM answer with disclosed sources and hides internal record IDs', async () => {
        show();
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        expect(mocks.ask).not.toHaveBeenCalled();
        fireEvent.submit(formQuestion());
        expect(await screen.findByText(crmAnswer.answer)).toBeTruthy();
        expect(screen.getByText('Ответ AVA')).toBeTruthy();
        expect(revealAnswerSources().getByText('Сделки')).toBeTruthy();
        expect(screen.queryByText(/tenant-4-deal|crm_records/)).toBeNull();
        expect(screen.queryByText(/Ответ не подтверждён источниками/)).toBeNull();
        expect(screen.queryByText(/LLM|языковая модель/i)).toBeNull();
    });

    it('hides the old answer when the question changes and displays only the new answer', async () => {
        const second = { ...crmAnswer, answer: 'Во втором вопросе найдено два события.' };
        mocks.ask.mockResolvedValueOnce(crmAnswer).mockResolvedValueOnce(second);
        show();
        fireEvent.submit(formQuestion('Вопрос A'));
        expect(await screen.findByText(crmAnswer.answer)).toBeTruthy();
        const form = formQuestion('Вопрос B');
        expect(screen.queryByText(crmAnswer.answer)).toBeNull();
        fireEvent.submit(form);
        expect(await screen.findByText(second.answer)).toBeTruthy();
        expect(screen.queryByText(crmAnswer.answer)).toBeNull();
        expect(mocks.ask).toHaveBeenLastCalledWith(4, 'Вопрос B', expect.any(AbortSignal));
    });

    it('aborts a pending question when the text changes and ignores its late result', async () => {
        const old = deferred<typeof crmAnswer>();
        const second = { ...crmAnswer, answer: 'Ответ только на вопрос B.' };
        mocks.ask.mockReturnValueOnce(old.promise).mockResolvedValueOnce(second);
        show();
        fireEvent.submit(formQuestion('Вопрос A'));
        const signal = mocks.ask.mock.calls[0][2] as AbortSignal;
        const form = formQuestion('Вопрос B');
        expect(signal.aborted).toBe(true);
        expect(screen.queryByText(/AVA анализирует/)).toBeNull();
        fireEvent.submit(form);
        expect(await screen.findByText(second.answer)).toBeTruthy();
        await act(async () => { old.resolve(crmAnswer); });
        expect(screen.queryByText(crmAnswer.answer)).toBeNull();
        expect(screen.getByText(second.answer)).toBeTruthy();
    });

    it('shows an Onyx answer and the sources returned for the selected business', async () => {
        mocks.businessId = 19;
        mocks.ask.mockResolvedValueOnce(knowledgeAnswer);
        show();
        fireEvent.submit(formQuestion('Когда заезд?'));
        expect(await screen.findByText(knowledgeAnswer.answer)).toBeTruthy();
        expect(mocks.ask).toHaveBeenCalledWith(19, 'Когда заезд?', expect.any(AbortSignal));
        expect(screen.getByText('Ответ AVA')).toBeTruthy();
        expect(revealAnswerSources().getByText('База знаний')).toBeTruthy();
        expect(screen.queryByText(/tenant-19-rules|onyx_knowledge/)).toBeNull();
        expect(screen.queryByText(/tenant-4-deal/)).toBeNull();
    });

    it('uses one request for overlapping Enter/form and button submits, then permits retry', async () => {
        const pending = deferred<typeof crmAnswer>();
        mocks.ask.mockReturnValueOnce(pending.promise);
        show();
        const form = formQuestion('  Какие сделки требуют внимания?  ');
        fireEvent.submit(form);
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        fireEvent.submit(form);
        expect(mocks.ask).toHaveBeenCalledTimes(1);
        expect(mocks.ask).toHaveBeenCalledWith(4, 'Какие сделки требуют внимания?', expect.any(AbortSignal));
        expect(screen.getByText(/AVA анализирует/)).toBeTruthy();
        await act(async () => { pending.resolve(crmAnswer); });
        expect(await screen.findByText(crmAnswer.answer)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        await waitFor(() => expect(mocks.ask).toHaveBeenCalledTimes(2));
    });

    it('aborts business 4, answers for business 19, and ignores a late business 4 reply', async () => {
        const old = deferred<typeof crmAnswer>();
        mocks.ask.mockReturnValueOnce(old.promise).mockResolvedValueOnce(knowledgeAnswer);
        const view = show();
        fireEvent.submit(formQuestion());
        const signal = mocks.ask.mock.calls[0][2] as AbortSignal;
        mocks.businessId = 19;
        view.rerender(<MemoryRouter><Dashboard /></MemoryRouter>);
        expect(signal.aborted).toBe(true);
        expect((screen.getByRole('textbox', { name: 'Вопрос для AVA' }) as HTMLInputElement).value).toBe('');
        expect(screen.queryByText(/AVA анализирует/)).toBeNull();
        fireEvent.submit(formQuestion('Когда заезд?'));
        expect(await screen.findByText(knowledgeAnswer.answer)).toBeTruthy();
        await act(async () => { old.resolve(crmAnswer); });
        expect(screen.queryByText(crmAnswer.answer)).toBeNull();
        expect(screen.queryByText(/tenant-4-deal/)).toBeNull();
        expect(screen.getByText(knowledgeAnswer.answer)).toBeTruthy();
    });

    it.each([
        ['KNOWLEDGE_TIMEOUT', 'База знаний AVA не ответила вовремя. Попробуйте ещё раз.'],
        ['KNOWLEDGE_UNAVAILABLE', 'База знаний AVA сейчас недоступна. Попробуйте позже.'],
        ['KNOWLEDGE_NOT_READY', 'База знаний этого бизнеса ещё не готова. Попробуйте позже.'],
        ['ASK_RATE_LIMITED', 'Слишком много вопросов за минуту. Попробуйте позже.'],
    ])('recovers from %s without showing an empty success', async (code, message) => {
        mocks.ask.mockRejectedValueOnce({ isAxiosError: true, response: { data: { code } } }).mockResolvedValueOnce(crmAnswer);
        show();
        fireEvent.submit(formQuestion());
        expect(await screen.findByText(message)).toBeTruthy();
        expect(screen.queryByText(/^Ответ AVA/)).toBeNull();
        fireEvent.submit(formQuestion());
        expect(await screen.findByText(crmAnswer.answer)).toBeTruthy();
        expect(screen.queryByText(message)).toBeNull();
        expect(mocks.ask).toHaveBeenCalledTimes(2);
    });

    it('handles a browser request timeout and clears the error after retry', async () => {
        mocks.ask.mockRejectedValueOnce({ isAxiosError: true, code: 'ECONNABORTED' }).mockResolvedValueOnce(crmAnswer);
        show();
        fireEvent.submit(formQuestion());
        expect(await screen.findByText('AVA не ответила вовремя. Попробуйте ещё раз.')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        expect(await screen.findByText(crmAnswer.answer)).toBeTruthy();
        expect(screen.queryByText(/не ответила вовремя/)).toBeNull();
    });

    it('drops a pending answer when logout removes the active business', async () => {
        const pending = deferred<typeof crmAnswer>();
        mocks.ask.mockReturnValueOnce(pending.promise);
        const view = show();
        fireEvent.submit(formQuestion());
        const signal = mocks.ask.mock.calls[0][2] as AbortSignal;
        mocks.businessId = null;
        view.rerender(<MemoryRouter><Dashboard /></MemoryRouter>);
        expect(signal.aborted).toBe(true);
        expect(screen.getByText('Пока нет выбранного бизнеса')).toBeTruthy();
        await act(async () => { pending.resolve(crmAnswer); });
        expect(screen.queryByText(crmAnswer.answer)).toBeNull();
        expect(screen.queryByRole('textbox', { name: 'Вопрос для AVA' })).toBeNull();
    });

    it('aborts the question and dashboard read requests on unmount', async () => {
        const pending = deferred<typeof crmAnswer>();
        mocks.ask.mockReturnValueOnce(pending.promise);
        const view = show();
        fireEvent.submit(formQuestion());
        const questionSignal = mocks.ask.mock.calls[0][2] as AbortSignal;
        const readSignal = mocks.activity.mock.calls[0][1] as AbortSignal;
        view.unmount();
        expect(questionSignal.aborted).toBe(true);
        expect(readSignal.aborted).toBe(true);
        await act(async () => { pending.resolve(crmAnswer); });
        expect(screen.queryByText(crmAnswer.answer)).toBeNull();
    });
    it.each([
        ['KNOWLEDGE_EMPTY', 'В базе знаний пока нет документов с текстом. Добавьте документ или заметку.'],
        ['KNOWLEDGE_INDEXING', 'Документы ещё обрабатываются. Дождитесь завершения обработки и повторите вопрос.'],
    ])('renders backend %s as its actual state without inventing an answer', async (code, message) => {
        mocks.ask.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { code } } });
        show();
        fireEvent.change(screen.getByLabelText('Вопрос для AVA'), { target: { value: 'Когда заселение?' } });
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        expect(await screen.findByText(message)).toBeTruthy();
        expect(screen.queryByText('Ответ AVA')).toBeNull();
    });

});
