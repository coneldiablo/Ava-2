// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BusinessGpt from '../src/pages/BusinessGpt';
import KnowledgeBase from '../src/pages/KnowledgeBase';
import Simulator from '../src/pages/Simulator';
import * as api from '../src/api';

const context = vi.hoisted(() => ({ businessId: 7, role: 'hotel_owner', membershipRole: 'hotel_owner' }));

vi.mock('../src/context/InstanceContext', () => ({
    useInstance: () => ({ currentInstanceId: context.businessId, currentInstance: { name: 'Тестовый бизнес' } }),
}));
vi.mock('../src/context/AuthContext', () => ({
    useAuth: () => ({ role: context.role, memberships: [{ businessId: context.businessId, role: context.membershipRole }] }),
}));
vi.mock('../src/api', () => ({
    getBusinessGptChats: vi.fn(), createBusinessGptChat: vi.fn(), getBusinessGptChat: vi.fn(), sendBusinessGptMessage: vi.fn(),
    getKnowledgeBaseFiles: vi.fn(), previewKnowledgeAnswer: vi.fn(), searchKnowledgeBase: vi.fn(),
    getNativeKnowledgeStatus: vi.fn(), getKnowledgeBaseStats: vi.fn(), getRAGAnalytics: vi.fn(), simulateChat: vi.fn(),
}));

const chat = { id: '11111111-1111-4111-8111-111111111111', title: 'Новый диалог', createdAt: '2026-09-25T10:00:00Z', updatedAt: '2026-09-25T10:00:00Z' };
const turn = { id: '22222222-2222-4222-8222-222222222222', requestId: '33333333-3333-4333-8333-333333333333', question: 'Когда заезд?', answer: 'Заезд после 14:00.', citations: [{ sourceId: 9, title: 'Правила заселения' }], sourceTimestamp: '2026-09-25T10:01:00Z', createdAt: '2026-09-25T10:01:00Z' };

beforeEach(() => {
    context.businessId = 7;
    context.role = 'hotel_owner';
    context.membershipRole = 'hotel_owner';
    vi.stubGlobal('crypto', { randomUUID: () => turn.requestId });
    vi.stubGlobal('scrollIntoView', vi.fn());
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.getNativeKnowledgeStatus).mockResolvedValue({ success: true, businessId: 7, onyx: 'configured', documents: [] });
    vi.mocked(api.getKnowledgeBaseFiles).mockResolvedValue({ success: true, files: [] });
    vi.mocked(api.getKnowledgeBaseStats).mockResolvedValue({ stats: {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('question surfaces', () => {
    it('opens a dashboard question as an editable draft without sending it automatically', async () => {
        vi.mocked(api.getBusinessGptChats).mockResolvedValue({ success: true, chats: [] });
        render(<MemoryRouter initialEntries={['/business-gpt?question=' + encodeURIComponent('Сколько клиентов в CRM?')]}><BusinessGpt /></MemoryRouter>);
        const input = await screen.findByLabelText('Вопрос для AVA');
        expect((input as HTMLTextAreaElement).value).toBe('Сколько клиентов в CRM?');
        expect(api.sendBusinessGptMessage).not.toHaveBeenCalled();
    });
    it('sends a Business GPT question in the selected business and shows a sourced answer', async () => {
        vi.mocked(api.getBusinessGptChats).mockResolvedValue({ success: true, chats: [] });
        vi.mocked(api.createBusinessGptChat).mockResolvedValue({ success: true, chat });
        vi.mocked(api.sendBusinessGptMessage).mockResolvedValue({ success: true, turn });
        vi.mocked(api.getBusinessGptChat).mockResolvedValue({ success: true, turns: [turn] });
        render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        const input = await screen.findByLabelText('Вопрос для AVA');
        await waitFor(() => expect(input.hasAttribute('disabled')).toBe(false));
        fireEvent.change(input, { target: { value: turn.question } });
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        await waitFor(() => expect(api.sendBusinessGptMessage).toHaveBeenCalledWith(7, chat.id, turn.question, turn.requestId, expect.any(AbortSignal)));
        expect(await screen.findByText(turn.answer)).toBeTruthy();
        expect(screen.getByText('Правила заселения')).toBeTruthy();
    });

    it('keeps the draft and request id after a Business GPT timeout so retry can replay safely', async () => {
        vi.mocked(api.getBusinessGptChats).mockResolvedValue({ success: true, chats: [chat] });
        vi.mocked(api.getBusinessGptChat).mockResolvedValue({ success: true, turns: [] });
        vi.mocked(api.sendBusinessGptMessage)
            .mockRejectedValueOnce({ response: { data: { code: 'PREVIEW_TIMEOUT' } } })
            .mockResolvedValueOnce({ success: true, turn });
        render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        const input = await screen.findByLabelText('Вопрос для AVA');
        await waitFor(() => expect(input.hasAttribute('disabled')).toBe(false));
        fireEvent.change(input, { target: { value: turn.question } });
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('не успела'));
        expect((input as HTMLTextAreaElement).value).toBe(turn.question);
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        await waitFor(() => expect(api.sendBusinessGptMessage).toHaveBeenCalledTimes(2));
        expect(vi.mocked(api.sendBusinessGptMessage).mock.calls[0][3]).toBe(vi.mocked(api.sendBusinessGptMessage).mock.calls[1][3]);
        expect(await screen.findByText(turn.answer)).toBeTruthy();
    });

    it('keeps a newly acknowledged answer visible if the history refresh fails', async () => {
        vi.mocked(api.getBusinessGptChats).mockResolvedValue({ success: true, chats: [] });
        vi.mocked(api.createBusinessGptChat).mockResolvedValue({ success: true, chat });
        vi.mocked(api.sendBusinessGptMessage).mockResolvedValue({ success: true, turn });
        vi.mocked(api.getBusinessGptChat).mockRejectedValue(new Error('history unavailable'));
        render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        const input = await screen.findByLabelText('Вопрос для AVA');
        await waitFor(() => expect(input.hasAttribute('disabled')).toBe(false));
        fireEvent.change(input, { target: { value: turn.question } });
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        expect(await screen.findByText(turn.answer)).toBeTruthy();
        await waitFor(() => expect(api.getBusinessGptChat).toHaveBeenCalled());
        expect(screen.getByText('Правила заселения')).toBeTruthy();
    });

    it('reconciles a timed-out first send when the saved turn appears in chat history', async () => {
        vi.mocked(api.getBusinessGptChats).mockResolvedValue({ success: true, chats: [] });
        vi.mocked(api.createBusinessGptChat).mockResolvedValue({ success: true, chat });
        vi.mocked(api.sendBusinessGptMessage).mockRejectedValue({ code: 'ECONNABORTED' });
        vi.mocked(api.getBusinessGptChat).mockResolvedValue({ success: true, chat, turns: [turn] });
        render(<MemoryRouter><BusinessGpt /></MemoryRouter>);
        const input = await screen.findByLabelText('Вопрос для AVA');
        await waitFor(() => expect(input.hasAttribute('disabled')).toBe(false));
        fireEvent.change(input, { target: { value: turn.question } });
        fireEvent.click(screen.getByRole('button', { name: 'Отправить вопрос' }));
        expect(await screen.findByText(turn.answer)).toBeTruthy();
        await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('keeps document preview but omits the separate customer search panel', async () => {
        vi.mocked(api.previewKnowledgeAnswer).mockResolvedValue({ success: true, businessId: 7, answer: turn.answer, citations: turn.citations });
        render(<MemoryRouter><KnowledgeBase /></MemoryRouter>);
        fireEvent.change(screen.getByLabelText('Вопрос для предварительного ответа'), { target: { value: turn.question } });
        fireEvent.click(screen.getByRole('button', { name: /Подготовить ответ/ }));
        expect(await screen.findByText(turn.answer)).toBeTruthy();
        expect(screen.getByText('Правила заселения')).toBeTruthy();
        expect(api.previewKnowledgeAnswer).toHaveBeenCalledWith(7, turn.question, expect.any(AbortSignal));
        expect(screen.queryByRole('heading', { name: 'Проверить поиск' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Найти в документах' })).toBeNull();
        expect(api.searchKnowledgeBase).not.toHaveBeenCalled();
    });

    it('reports preview timeout and cancels an in-flight retry', async () => {
        vi.mocked(api.previewKnowledgeAnswer)
            .mockRejectedValueOnce({ response: { data: { code: 'PREVIEW_TIMEOUT' } } })
            .mockImplementationOnce(() => new Promise(() => {}));
        render(<MemoryRouter><KnowledgeBase /></MemoryRouter>);
        fireEvent.change(screen.getByLabelText('Вопрос для предварительного ответа'), { target: { value: turn.question } });
        fireEvent.click(screen.getByRole('button', { name: /Подготовить ответ/ }));
        expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('не успела'));
        expect((screen.getByLabelText('Вопрос для предварительного ответа') as HTMLTextAreaElement).value).toBe(turn.question);
        fireEvent.click(screen.getByRole('button', { name: 'Повторить вопрос' }));
        await waitFor(() => expect(api.previewKnowledgeAnswer).toHaveBeenCalledTimes(2));
        const signal = vi.mocked(api.previewKnowledgeAnswer).mock.calls[1][2] as AbortSignal;
        expect(signal.aborted).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: 'Отменить' }));
        expect(signal.aborted).toBe(true);
        expect(screen.queryByText(/Ищем подтверждения/)).toBeNull();
        expect((screen.getByLabelText('Вопрос для предварительного ответа') as HTMLTextAreaElement).value).toBe(turn.question);
    });

    it('shows admin search errors without claiming that no documents matched', async () => {
        context.role = 'platform_admin';
        vi.mocked(api.searchKnowledgeBase).mockRejectedValue({ response: { status: 503 } });
        render(<MemoryRouter><KnowledgeBase /></MemoryRouter>);
        fireEvent.click(screen.getByRole('button', { name: 'Поиск' }));
        fireEvent.change(screen.getByLabelText('Запрос по документам'), { target: { value: turn.question } });
        fireEvent.click(screen.getByRole('button', { name: 'Найти' }));
        await waitFor(() => expect(api.searchKnowledgeBase).toHaveBeenCalledWith(7, turn.question, 'hybrid', 5, expect.any(AbortSignal)));
        expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Не удалось выполнить поиск'));
        expect(screen.queryByText('Ничего не найдено.')).toBeNull();
    });

    it('sends simulator messages with business scope and drops pending replies on business switch', async () => {
        vi.mocked(api.simulateChat)
            .mockResolvedValueOnce({ success: true, response: { reply: 'Тестовый ответ' } })
            .mockImplementationOnce(() => new Promise(() => {}));
        const view = render(<Simulator />);
        fireEvent.change(screen.getByLabelText('Сообщение для симулятора'), { target: { value: turn.question } });
        fireEvent.click(screen.getByRole('button', { name: 'Отправить сообщение симулятору' }));
        expect(await screen.findByText('Тестовый ответ')).toBeTruthy();
        expect(api.simulateChat).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 7, message: turn.question }), expect.any(AbortSignal));
        fireEvent.change(screen.getByLabelText('Сообщение для симулятора'), { target: { value: 'Ещё вопрос' } });
        fireEvent.click(screen.getByRole('button', { name: 'Отправить сообщение симулятору' }));
        await waitFor(() => expect(api.simulateChat).toHaveBeenCalledTimes(2));
        const signal = vi.mocked(api.simulateChat).mock.calls[1][1] as AbortSignal;
        context.businessId = 8;
        view.rerender(<Simulator />);
        expect(signal.aborted).toBe(true);
        expect(screen.queryByText('Тестовый ответ')).toBeNull();
    });

    it('does not offer the simulator composer to a manager', () => {
        context.membershipRole = 'manager';
        render(<Simulator />);
        expect(screen.getByText('Симулятор доступен владельцу выбранного бизнеса.')).toBeTruthy();
        expect(screen.queryByLabelText('Сообщение для симулятора')).toBeNull();
    });
});
