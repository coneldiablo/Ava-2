// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BusinessGpt from '../src/pages/BusinessGpt';
import Simulator from '../src/pages/Simulator';
import * as api from '../src/api';

const context = vi.hoisted(() => ({ businessId: 7 as number | null }));
vi.mock('../src/context/InstanceContext', () => ({
    useInstance: () => ({ currentInstanceId: context.businessId, currentInstance: { name: `Бизнес ${context.businessId}` } }),
}));
vi.mock('../src/context/AuthContext', () => ({
    useAuth: () => ({ role: 'hotel_owner', memberships: [{ businessId: context.businessId, role: 'hotel_owner' }] }),
}));
vi.mock('../src/api', () => ({
    getBusinessGptChats: vi.fn(), createBusinessGptChat: vi.fn(), getBusinessGptChat: vi.fn(),
    sendBusinessGptMessage: vi.fn(), simulateChat: vi.fn(),
}));

const chatA = { id: '11111111-1111-4111-8111-111111111111', title: 'Диалог A', createdAt: '2026-09-28T10:00:00Z', updatedAt: '2026-09-28T10:00:00Z' };
const chatB = { ...chatA, id: '22222222-2222-4222-8222-222222222222', title: 'Диалог B' };
const requestId = '33333333-3333-4333-8333-333333333333';
const turnA = { id: '44444444-4444-4444-8444-444444444444', requestId, question: 'Правила бизнеса A?', answer: 'Ответ только бизнеса A', citations: [{ sourceId: 71, title: 'Документ бизнеса A' }], sourceTimestamp: chatA.createdAt, createdAt: chatA.createdAt };
const turnB = { ...turnA, id: '55555555-5555-4555-8555-555555555555', question: 'Правила бизнеса B?', answer: 'Ответ только бизнеса B', citations: [{ sourceId: 81, title: 'Документ бизнеса B' }] };

const crmTurn = { ...turnA, question: 'Какие сделки требуют внимания?', answer: 'Есть одна открытая сделка.', citations: [],
    answerContext: { kind: 'crm' as const, businessId: 7, customerChatId: null, limitations: ['Оплата по сумме сделки не подтверждена.'] },
    sources: [{ kind: 'deal' as const, title: 'Открытая сделка', observedAt: chatA.createdAt, sourceId: 'internal-deal-id' }] };

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    return { promise, resolve, reject };
}

async function gptInput() {
    const input = await screen.findByLabelText('Вопрос для AVA') as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    return input;
}
function sendGpt(input: HTMLTextAreaElement, question = turnA.question) {
    fireEvent.change(input, { target: { value: question } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
}
function sendSimulator(question = 'Вопрос A') {
    fireEvent.change(screen.getByLabelText('Сообщение для симулятора'), { target: { value: question } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить сообщение симулятору' }));
}

beforeEach(() => {
    vi.resetAllMocks();
    context.businessId = 7;
    vi.stubGlobal('crypto', { randomUUID: () => requestId });
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.getBusinessGptChats).mockImplementation(async businessId => ({ success: true, chats: [businessId === 7 ? chatA : chatB] }));
    vi.mocked(api.getBusinessGptChat).mockResolvedValue({ success: true, turns: [] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Business GPT request recovery', () => {
    it('accepts a scoped CRM answer without document citations and shows typed sources and material limits', async () => {
        vi.mocked(api.sendBusinessGptMessage).mockResolvedValue({ success: true, turn: crmTurn });
        render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        sendGpt(await gptInput(), crmTurn.question);
        await screen.findByText(crmTurn.answer);
        expect(screen.getByText('Ответ по данным бизнеса')).toBeTruthy();
        expect(screen.getByText(/Источники ответа/)).toBeTruthy();
        expect(screen.getByText('Открытая сделка')).toBeTruthy();
        expect(screen.getByText(crmTurn.answerContext.limitations[0])).toBeTruthy();
        expect(screen.queryByText(/Использованные документы/)).toBeNull();
        expect(screen.queryByText('internal-deal-id')).toBeNull();
        expect(api.sendBusinessGptMessage).toHaveBeenCalledWith(7, chatA.id, crmTurn.question, requestId, expect.any(AbortSignal));
    });

    it('accepts scoped CRM turns when loading saved history', async () => {
        vi.mocked(api.getBusinessGptChat).mockResolvedValue({ success: true, turns: [crmTurn] });
        render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        await screen.findByText(crmTurn.answer);
        expect((await gptInput()).value).toBe('');
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('accepts mixed sources only with valid document citations and labels the sources together', async () => {
        const mixed = { ...turnA, answerContext: { ...crmTurn.answerContext, kind: 'mixed' }, sources: [
            ...crmTurn.sources, { kind: 'document', title: 'Правила бизнеса', observedAt: chatA.createdAt },
        ] };
        vi.mocked(api.sendBusinessGptMessage).mockResolvedValue({ success: true, turn: mixed });
        render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        sendGpt(await gptInput());
        await screen.findByText(turnA.answer);
        expect(screen.getByText('Ответ по документам и данным бизнеса')).toBeTruthy();
        expect(screen.getByText(/Источники ответа/)).toBeTruthy();
    });

    it.each([
        ['another business', { ...crmTurn, answerContext: { ...crmTurn.answerContext, businessId: 8 } }],
        ['string business id', { ...crmTurn, answerContext: { ...crmTurn.answerContext, businessId: '7' } }],
        ['missing context', { ...crmTurn, answerContext: undefined }],
        ['no sources', { ...crmTurn, sources: [] }],
        ['unknown source kind', { ...crmTurn, sources: [{ ...crmTurn.sources[0], kind: 'container' }] }],
        ['empty source title', { ...crmTurn, sources: [{ ...crmTurn.sources[0], title: ' ' }] }],
        ['invalid source observation time', { ...crmTurn, sources: [{ ...crmTurn.sources[0], observedAt: 'invalid' }] }],
        ['invalid limitations', { ...crmTurn, answerContext: { ...crmTurn.answerContext, limitations: [42] } }],
        ['documents without citations', { ...crmTurn, answerContext: { ...crmTurn.answerContext, kind: 'documents' } }],
        ['mixed without citations', { ...crmTurn, answerContext: { ...crmTurn.answerContext, kind: 'mixed' } }],
        ['malformed document citation', { ...turnA, citations: [{ sourceId: 'not-a-number', title: 'Rules' }] }],
        ['legacy answer without citations', { ...turnA, citations: [] }],
    ])('rejects %s and retains the submitted question', async (_name, turn) => {
        vi.mocked(api.sendBusinessGptMessage).mockResolvedValue({ success: true, turn });
        render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        const input = await gptInput(); sendGpt(input);
        await screen.findByRole('alert');
        expect(input.value).toBe(turnA.question);
        expect(screen.queryByText(turn.answer)).toBeNull();
        expect(screen.queryByText('internal-deal-id')).toBeNull();
    });

    it('aborts a pending write on business switch and ignores a late answer from tenant A', async () => {
        const pending = deferred<{ success: boolean; turn: typeof turnA }>();
        vi.mocked(api.sendBusinessGptMessage).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ success: true, turn: turnB });
        const view = render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        sendGpt(await gptInput());
        const signal = vi.mocked(api.sendBusinessGptMessage).mock.calls[0][4]!;
        context.businessId = 8;
        view.rerender(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        expect(signal.aborted).toBe(true);
        const inputB = await gptInput();
        await act(async () => pending.resolve({ success: true, turn: turnA }));
        expect(screen.queryByText(turnA.answer)).toBeNull();
        expect(screen.queryByText('Документ бизнеса A')).toBeNull();
        sendGpt(inputB, turnB.question);
        expect(await screen.findByText(turnB.answer)).toBeTruthy();
        expect(api.sendBusinessGptMessage).toHaveBeenLastCalledWith(8, chatB.id, turnB.question, requestId, expect.any(AbortSignal));
    });

    it('cancels waiting without losing the question and reuses its request id when retried', async () => {
        const pending = deferred<{ success: boolean; turn: typeof turnA }>();
        vi.mocked(api.sendBusinessGptMessage).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ success: true, turn: turnA });
        render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        const input = await gptInput(); sendGpt(input);
        const signal = vi.mocked(api.sendBusinessGptMessage).mock.calls[0][4]!;
        fireEvent.click(screen.getByRole('button', { name: 'Отменить ожидание ответа' }));
        expect(signal.aborted).toBe(true);
        expect(input.value).toBe(turnA.question);
        fireEvent.click(screen.getByRole('button', { name: 'Повторить вопрос' }));
        await screen.findByText(turnA.answer);
        await act(async () => pending.resolve({ success: true, turn: { ...turnA, answer: 'Отменённый ответ' } }));
        expect(screen.queryByText('Отменённый ответ')).toBeNull();
        expect(vi.mocked(api.sendBusinessGptMessage).mock.calls.map(call => call[3])).toEqual([requestId, requestId]);
    });

    it('restores an unsent question after switching to another chat and back', async () => {
        vi.mocked(api.getBusinessGptChats).mockResolvedValue({ success: true, chats: [chatA, chatB] });
        render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        fireEvent.change(await gptInput(), { target: { value: 'Незавершённый вопрос' } });
        fireEvent.click(screen.getByRole('button', { name: /Диалог B/ }));
        await gptInput();
        fireEvent.click(screen.getByRole('button', { name: /Диалог A/ }));
        expect((await gptInput()).value).toBe('Незавершённый вопрос');
    });

    it('cancels chat A send when selecting chat B and does not append its late result', async () => {
        vi.mocked(api.getBusinessGptChats).mockResolvedValue({ success: true, chats: [chatA, chatB] });
        vi.mocked(api.getBusinessGptChat).mockImplementation(async (_businessId, chatId) => ({ success: true, turns: chatId === chatB.id ? [turnB] : [] }));
        const pending = deferred<{ success: boolean; turn: typeof turnA }>();
        vi.mocked(api.sendBusinessGptMessage).mockReturnValue(pending.promise);
        render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        sendGpt(await gptInput());
        const signal = vi.mocked(api.sendBusinessGptMessage).mock.calls[0][4]!;
        fireEvent.click(screen.getByRole('button', { name: /Диалог B/ }));
        expect(signal.aborted).toBe(true);
        expect(await screen.findByText(turnB.answer)).toBeTruthy();
        await act(async () => pending.resolve({ success: true, turn: turnA }));
        expect(screen.queryByText(turnA.answer)).toBeNull();
        expect((await gptInput()).value).toBe('');
    });

    it('ignores a late history response when a different chat is selected', async () => {
        vi.mocked(api.getBusinessGptChats).mockResolvedValue({ success: true, chats: [chatA, chatB] });
        const pending = deferred<{ success: boolean; turns: typeof turnA[] }>();
        vi.mocked(api.getBusinessGptChat).mockImplementation((_businessId, chatId) => chatId === chatA.id ? pending.promise : Promise.resolve({ success: true, turns: [turnB] }));
        render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        fireEvent.click(await screen.findByRole('button', { name: /Диалог B/ }));
        expect(await screen.findByText(turnB.answer)).toBeTruthy();
        expect(vi.mocked(api.getBusinessGptChat).mock.calls[0][2]?.aborted).toBe(true);
        await act(async () => pending.resolve({ success: true, turns: [turnA] }));
        expect(screen.queryByText(turnA.answer)).toBeNull();
    });

    it('uses the same request for Enter and button and blocks an immediate second submit', async () => {
        const pending = deferred<{ success: boolean; turn: typeof turnA }>();
        vi.mocked(api.sendBusinessGptMessage).mockReturnValue(pending.promise);
        render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        const input = await gptInput();
        fireEvent.change(input, { target: { value: turnA.question } });
        fireEvent.keyDown(input, { key: 'Enter' });
        fireEvent.submit(input.form!);
        expect(api.sendBusinessGptMessage).toHaveBeenCalledTimes(1);
        expect(api.sendBusinessGptMessage).toHaveBeenCalledWith(7, chatA.id, turnA.question, requestId, expect.any(AbortSignal));
        await act(async () => pending.resolve({ success: true, turn: turnA }));
        expect(await screen.findByText(turnA.answer)).toBeTruthy();
        expect(screen.getByText('Документ бизнеса A')).toBeTruthy();
        expect(screen.queryByText(/Проверьте важную информацию/)).toBeNull();
    });

    it('preserves draft and requestId after server failure and retries a single saved exchange', async () => {
        vi.mocked(api.sendBusinessGptMessage).mockRejectedValueOnce({ response: { data: { code: 'KNOWLEDGE_UNAVAILABLE' } } }).mockResolvedValueOnce({ success: true, turn: turnA });
        render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        const input = await gptInput();
        sendGpt(input);
        expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Не удалось получить'));
        expect(input.value).toBe(turnA.question);
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        expect(await screen.findByText(turnA.answer)).toBeTruthy();
        expect(vi.mocked(api.sendBusinessGptMessage).mock.calls.map(call => call[3])).toEqual([requestId, requestId]);
        expect(screen.getAllByText(turnA.answer)).toHaveLength(1);
    });

    it.each([
        ['PREVIEW_EMPTY', 'пока нет документов'],
        ['PREVIEW_INDEXING', 'ещё обрабатываются'],
        ['PREVIEW_UNGROUNDED', 'не нашлось подтверждённого ответа'],
    ])('shows the backend %s state without fabricating an answer', async (code, expected) => {
        vi.mocked(api.sendBusinessGptMessage).mockRejectedValue({ response: { data: { code } } });
        render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        const input = await gptInput();
        sendGpt(input);
        await waitFor(() => expect(screen.getByRole('status')).toHaveProperty('textContent', expect.stringContaining(expected)));
        expect(input.value).toBe(turnA.question);
        expect(screen.queryByText(turnA.answer)).toBeNull();
    });

    it('keeps the composer blocked when chat listing failed and lets the user reload', async () => {
        vi.mocked(api.getBusinessGptChats).mockRejectedValueOnce({ response: { status: 503 } }).mockResolvedValueOnce({ success: true, chats: [chatA] });
        render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect((screen.getByLabelText('Вопрос для AVA') as HTMLTextAreaElement).disabled).toBe(true);
        expect(screen.queryByText('Диалогов пока нет.')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Повторить загрузку диалогов' }));
        await gptInput();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('aborts chat creation on logout/unmount and never starts a message afterwards', async () => {
        vi.mocked(api.getBusinessGptChats).mockResolvedValue({ success: true, chats: [] });
        const pending = deferred<{ success: boolean; chat: typeof chatA }>();
        vi.mocked(api.createBusinessGptChat).mockReturnValue(pending.promise);
        const view = render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        sendGpt(await gptInput());
        const signal = vi.mocked(api.createBusinessGptChat).mock.calls[0][1]!;
        view.unmount();
        expect(signal.aborted).toBe(true);
        await act(async () => pending.resolve({ success: true, chat: chatA }));
        expect(api.sendBusinessGptMessage).not.toHaveBeenCalled();
    });
});

describe('Simulator request recovery', () => {
    it.each([
        ['confirmed', { dryRun: true, effectsDisabled: true, toolsEnabled: false }, true],
        ['legacy', undefined, false],
        ['missing effect flag', { dryRun: true, toolsEnabled: false }, false],
        ['enabled effects', { dryRun: true, effectsDisabled: false, toolsEnabled: false }, false],
        ['enabled tools', { dryRun: true, effectsDisabled: true, toolsEnabled: true }, false],
        ['string flags', { dryRun: 'true', effectsDisabled: true, toolsEnabled: false }, false],
    ])('shows no-effects confirmation only for exact server capabilities: %s', async (_name, capabilities, confirmed) => {
        vi.mocked(api.simulateChat).mockResolvedValue({ success: true, response: 'Тестовый ответ', capabilities });
        render(<Simulator />); sendSimulator(); await screen.findByText('Тестовый ответ');
        expect(Boolean(screen.queryByText('Только проверка ответов: внешние действия отключены.'))).toBe(confirmed);
    });

    it('removes previous no-effects confirmation when the next response uses the legacy contract', async () => {
        vi.mocked(api.simulateChat).mockResolvedValueOnce({ success: true, response: 'Проверенный ответ', capabilities: { dryRun: true, effectsDisabled: true, toolsEnabled: false } })
            .mockResolvedValueOnce({ success: true, response: 'Ответ старого сервера' });
        render(<Simulator />); sendSimulator(); await screen.findByText('Проверенный ответ');
        expect(screen.getByText('Только проверка ответов: внешние действия отключены.')).toBeTruthy();
        sendSimulator('Другой вопрос'); await screen.findByText('Ответ старого сервера');
        expect(screen.queryByText('Только проверка ответов: внешние действия отключены.')).toBeNull();
    });

    it('keeps failed drafts, submits empty initial history, and retries without duplicate failed user turns', async () => {
        vi.mocked(api.simulateChat).mockRejectedValueOnce({ response: { status: 500 } }).mockResolvedValueOnce({ success: true, response: { reply: 'Ответ симулятора A' } });
        render(<Simulator />);
        sendSimulator();
        expect(await screen.findByRole('alert')).toBeTruthy();
        const input = screen.getByLabelText('Сообщение для симулятора') as HTMLInputElement;
        expect(input.value).toBe('Вопрос A');
        expect(screen.queryByText('Вопрос A')).toBeNull();
        fireEvent.submit(input.form!);
        expect(await screen.findByText('Ответ симулятора A')).toBeTruthy();
        expect(vi.mocked(api.simulateChat).mock.calls.map(call => call[0])).toEqual([
            { instanceId: 7, message: 'Вопрос A', history: [] },
            { instanceId: 7, message: 'Вопрос A', history: [] },
        ]);
        expect(screen.getAllByText('Вопрос A')).toHaveLength(1);
        expect(input.value).toBe('');
    });

    it('cancels waiting without clearing completed context or the pending message', async () => {
        const pending = deferred<{ success: boolean; response: string }>();
        vi.mocked(api.simulateChat).mockResolvedValueOnce({ success: true, response: 'Первый ответ' }).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ success: true, response: 'Ответ повтора' });
        render(<Simulator />); sendSimulator(); await screen.findByText('Первый ответ'); sendSimulator('Следующий вопрос');
        const signal = vi.mocked(api.simulateChat).mock.calls[1][1]!;
        fireEvent.click(screen.getByRole('button', { name: 'Отменить ожидание ответа' }));
        expect(signal.aborted).toBe(true);
        expect(screen.getByText('Первый ответ')).toBeTruthy();
        expect((screen.getByLabelText('Сообщение для симулятора') as HTMLInputElement).value).toBe('Следующий вопрос');
        fireEvent.click(screen.getByRole('button', { name: 'Повторить сообщение' }));
        await screen.findByText('Ответ повтора');
        expect(vi.mocked(api.simulateChat).mock.calls[2][0].history).toEqual([{ role: 'user', content: 'Вопрос A' }, { role: 'assistant', content: 'Первый ответ' }]);
        await act(async () => pending.resolve({ success: true, response: 'Поздний ответ' }));
        expect(screen.queryByText('Поздний ответ')).toBeNull();
    });

    it('passes only completed history and resets history after clearing the chat', async () => {
        vi.mocked(api.simulateChat).mockResolvedValue({ success: true, response: 'Готовый ответ' });
        render(<Simulator />);
        sendSimulator();
        expect(await screen.findByText('Готовый ответ')).toBeTruthy();
        sendSimulator('Продолжение');
        await waitFor(() => expect(api.simulateChat).toHaveBeenCalledTimes(2));
        expect(vi.mocked(api.simulateChat).mock.calls[1][0].history).toEqual([{ role: 'user', content: 'Вопрос A' }, { role: 'assistant', content: 'Готовый ответ' }]);
        await waitFor(() => expect((screen.getByLabelText('Сообщение для симулятора') as HTMLInputElement).disabled).toBe(false));
        fireEvent.click(screen.getByRole('button', { name: 'Очистить' }));
        sendSimulator('Новый разговор');
        await waitFor(() => expect(api.simulateChat).toHaveBeenCalledTimes(3));
        expect(vi.mocked(api.simulateChat).mock.calls[2][0].history).toEqual([]);
    });

    it('ignores a canceled old reply after clear and rapid retry', async () => {
        const pending = deferred<{ success: boolean; response: string }>();
        vi.mocked(api.simulateChat).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ success: true, response: 'Ответ повтора' });
        render(<Simulator />);
        sendSimulator();
        const signal = vi.mocked(api.simulateChat).mock.calls[0][1]!;
        fireEvent.click(screen.getByRole('button', { name: 'Очистить' }));
        expect(signal.aborted).toBe(true);
        fireEvent.submit((screen.getByLabelText('Сообщение для симулятора') as HTMLInputElement).form!);
        expect(await screen.findByText('Ответ повтора')).toBeTruthy();
        await act(async () => pending.resolve({ success: true, response: 'Поздний старый ответ' }));
        expect(screen.queryByText('Поздний старый ответ')).toBeNull();
        expect(screen.getAllByText('Вопрос A')).toHaveLength(1);
    });

    it('aborts on tenant switch and keeps the new tenant conversation free of old replies', async () => {
        const pending = deferred<{ success: boolean; response: string }>();
        vi.mocked(api.simulateChat).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ success: true, response: 'Ответ симулятора B' });
        const view = render(<Simulator />);
        sendSimulator();
        const signal = vi.mocked(api.simulateChat).mock.calls[0][1]!;
        context.businessId = 8;
        view.rerender(<Simulator />);
        expect(signal.aborted).toBe(true);
        sendSimulator('Вопрос B');
        expect(await screen.findByText('Ответ симулятора B')).toBeTruthy();
        expect(api.simulateChat).toHaveBeenLastCalledWith({ instanceId: 8, message: 'Вопрос B', history: [] }, expect.any(AbortSignal));
        await act(async () => pending.resolve({ success: true, response: 'Ответ симулятора A' }));
        expect(screen.queryByText('Ответ симулятора A')).toBeNull();
    });

    it('blocks same-tick duplicate submission and preserves draft on timeout or empty reply', async () => {
        const pending = deferred<{ success: boolean; response: string }>();
        vi.mocked(api.simulateChat).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ success: true, response: '' });
        const view = render(<Simulator />);
        sendSimulator();
        const input = screen.getByLabelText('Сообщение для симулятора') as HTMLInputElement;
        fireEvent.submit(input.form!);
        expect(api.simulateChat).toHaveBeenCalledTimes(1);
        await act(async () => pending.reject({ code: 'ECONNABORTED' }));
        expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('не успел'));
        expect(input.value).toBe('Вопрос A');
        fireEvent.submit(input.form!);
        expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Не удалось получить'));
        expect(input.value).toBe('Вопрос A');
        view.unmount();
    });
});
