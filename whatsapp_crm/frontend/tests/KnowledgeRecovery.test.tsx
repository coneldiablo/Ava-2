// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import KnowledgeBase from '../src/pages/KnowledgeBase';
import * as api from '../src/api';
const scope = vi.hoisted(() => ({ id: 7 }));
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: scope.id, currentInstance: { name: `Business ${scope.id}` } }) }));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ role: 'customer', memberships: [{ businessId: scope.id, role: 'hotel_owner' }] }) }));
vi.mock('../src/api', () => ({ getKnowledgeBaseFiles: vi.fn(), getNativeKnowledgeStatus: vi.fn(), uploadKnowledgeBaseFiles: vi.fn(), getUploadStatus: vi.fn(), deleteNativeKnowledgeDocument: vi.fn(), previewKnowledgeAnswer: vi.fn(), searchKnowledgeBase: vi.fn() }));
const file = { id: 91, originalName: 'Stored rules', createdAt: '2026-09-28T10:00:00Z' };
const answer = (businessId = 7) => ({ success: true, businessId, answer: `Tenant ${businessId} check-in at ${businessId === 7 ? '14' : '17'}:00`, citations: [{ sourceId: businessId * 10, title: `Tenant ${businessId} rules` }] });
const show = () => render(<MemoryRouter><KnowledgeBase /></MemoryRouter>);
const ask = () => { fireEvent.change(screen.getByLabelText('Вопрос для предварительного ответа'), { target: { value: 'Check-in?' } }); fireEvent.click(screen.getByRole('button', { name: /Подготовить ответ/ })); };
beforeEach(() => { scope.id = 7; vi.mocked(api.getKnowledgeBaseFiles).mockResolvedValue({ success: true, files: [] }); vi.mocked(api.getNativeKnowledgeStatus).mockImplementation(async id => ({ success: true, businessId: id, onyx: 'configured', documents: [] })); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); });
describe('knowledge recovery', () => {
    it('reads persisted native indexing state after refresh without calling stored files ready', async () => {
        vi.mocked(api.getKnowledgeBaseFiles).mockResolvedValue({ success: true, files: [file] });
        vi.mocked(api.getNativeKnowledgeStatus).mockResolvedValue({ success: true, businessId: 7, onyx: 'configured', documents: [{ id: file.id, state: 'processing' }] });
        const first = show(); expect(await screen.findByText('Готовим для ответов')).toBeTruthy(); expect(screen.queryByText('Готово')).toBeNull();
        first.unmount(); show(); expect(await screen.findByText('Готовим для ответов')).toBeTruthy();
    });
    it('uses Enter and button as one path, locks duplicate events and shows actual sources', async () => {
        let resolve!: (value: ReturnType<typeof answer>) => void;
        vi.mocked(api.previewKnowledgeAnswer).mockImplementation(() => new Promise(done => { resolve = done; })); show();
        const input = screen.getByLabelText('Вопрос для предварительного ответа'); fireEvent.change(input, { target: { value: 'Check-in?' } }); fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.submit(input.closest('form')!);
        expect(api.previewKnowledgeAnswer).toHaveBeenCalledTimes(1); await act(async () => resolve(answer()));
        expect(await screen.findByText(answer().answer)).toBeTruthy(); expect(screen.getByText('Tenant 7 rules')).toBeTruthy(); expect(screen.queryByText(/Ответ сформирован только для проверки/)).toBeNull();
        fireEvent.keyDown(input, { key: 'Enter', shiftKey: true }); expect(api.previewKnowledgeAnswer).toHaveBeenCalledTimes(1);
    });
    it('drops cancelled responses after rapid retry and never displays tenant 7 content for tenant 8', async () => {
        let old!: (value: ReturnType<typeof answer>) => void;
        vi.mocked(api.previewKnowledgeAnswer).mockImplementationOnce(() => new Promise(done => { old = done; })).mockResolvedValueOnce(answer(7)).mockResolvedValueOnce(answer(8));
        const view = show(); ask(); fireEvent.click(screen.getByRole('button', { name: 'Отменить' })); ask(); expect(await screen.findByText(answer().answer)).toBeTruthy();
        scope.id = 8; view.rerender(<MemoryRouter><KnowledgeBase /></MemoryRouter>); expect(screen.queryByText(answer().answer)).toBeNull(); ask(); expect(await screen.findByText(answer(8).answer)).toBeTruthy();
        await act(async () => old(answer(7))); expect(screen.queryByText(answer().answer)).toBeNull(); expect(screen.getByText('Tenant 8 rules')).toBeTruthy();
    });
    it('retains the previous sourced answer and question when a new AI request fails, then retries locally', async () => {
        vi.mocked(api.previewKnowledgeAnswer).mockResolvedValueOnce(answer()).mockRejectedValueOnce({ response: { status: 503, data: { code: 'PREVIEW_UNAVAILABLE' } } }).mockResolvedValueOnce({ ...answer(), answer: 'Новый ответ' });
        show(); ask(); await screen.findByText(answer().answer);
        const input = screen.getByLabelText('Вопрос для предварительного ответа') as HTMLTextAreaElement;
        fireEvent.change(input, { target: { value: 'Другой вопрос?' } });
        fireEvent.click(screen.getByRole('button', { name: /Подготовить ответ/ }));
        await screen.findByRole('alert');
        expect(input.value).toBe('Другой вопрос?');
        expect(screen.getByText(answer().answer)).toBeTruthy();
        expect(screen.getByText('Последний ответ · Check-in?')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /Повторить вопрос/ }));
        await screen.findByText('Новый ответ');
        expect(api.previewKnowledgeAnswer).toHaveBeenLastCalledWith(7, 'Другой вопрос?', expect.any(AbortSignal));
    });
    it('rejects an answer tagged with another business', async () => {
        vi.mocked(api.previewKnowledgeAnswer).mockResolvedValue(answer(8)); show(); ask(); expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Не удалось')); expect(screen.queryByText(answer(8).answer)).toBeNull();
    });
    it.each([['PREVIEW_EMPTY', 'пока нет документов'], ['PREVIEW_INDEXING', 'ещё обрабатываются'], ['PREVIEW_UNGROUNDED', 'не нашлось достаточно подтверждений']])('renders %s as actual no-data/indexing', async (code, message) => {
        vi.mocked(api.previewKnowledgeAnswer).mockRejectedValue({ response: { status: 409, data: { code } } }); show(); ask(); expect(await screen.findByText(new RegExp(message))).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull(); expect(screen.queryByRole('article', { name: 'Предварительный ответ AVA' })).toBeNull();
    });
    it('renders service/read/status failures as errors without inventing empty documents', async () => {
        vi.mocked(api.getKnowledgeBaseFiles).mockRejectedValue(new Error('500')); vi.mocked(api.getNativeKnowledgeStatus).mockRejectedValue(new Error('503')); vi.mocked(api.previewKnowledgeAnswer).mockRejectedValue({ response: { status: 503, data: { code: 'PREVIEW_UNAVAILABLE' } } });
        show(); ask(); expect(await screen.findByText(/Не удалось загрузить документы/)).toBeTruthy(); expect(await screen.findByText(/Не удалось проверить обработку/)).toBeTruthy(); expect(await screen.findByText(/Не удалось подготовить предварительный ответ/)).toBeTruthy(); expect(screen.queryByText(/Пока нет документов/)).toBeNull();
    });
    it('acknowledges queued upload then processing and actual cited answer without false ready', async () => {
        vi.mocked(api.uploadKnowledgeBaseFiles).mockResolvedValue({ success: true, results: [{ success: true, originalName: file.originalName, jobId: 'job-7', queued: true }] }); vi.mocked(api.getUploadStatus).mockResolvedValue({ success: true, state: 'completed', percent: 100, result: { success: true } });
        vi.mocked(api.getKnowledgeBaseFiles).mockResolvedValueOnce({ success: true, files: [] }).mockResolvedValue({ success: true, files: [file] }); vi.mocked(api.getNativeKnowledgeStatus).mockResolvedValue({ success: true, businessId: 7, onyx: 'configured', documents: [{ id: file.id, state: 'submitted' }] }); vi.mocked(api.previewKnowledgeAnswer).mockResolvedValue(answer());
        show(); fireEvent.change(screen.getByLabelText('Загрузить файлы'), { target: { files: [new File(['Check-in at 14:00'], 'rules.txt', { type: 'text/plain' })] } }); expect(await screen.findByText('Текст обработан')).toBeTruthy(); expect(await screen.findByText('Передан в поиск')).toBeTruthy(); expect(api.getUploadStatus).toHaveBeenCalledWith(7, 'job-7', expect.any(AbortSignal)); expect(screen.queryByText('Готово')).toBeNull(); ask(); expect(await screen.findByText(answer().answer)).toBeTruthy(); expect(screen.getByText('Tenant 7 rules')).toBeTruthy();
    });
    it('retains text draft when an upload has no acknowledged entries', async () => {
        vi.mocked(api.uploadKnowledgeBaseFiles).mockResolvedValue({ success: true, results: [] }); show(); fireEvent.change(screen.getByLabelText('Название заметки'), { target: { value: 'Rules' } }); fireEvent.change(screen.getByLabelText('Содержание'), { target: { value: 'Important text' } }); fireEvent.click(screen.getByRole('button', { name: 'Добавить текст' })); expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Загрузка не подтверждена')); expect((screen.getByLabelText('Содержание') as HTMLTextAreaElement).value).toBe('Important text'); expect(screen.queryByText(/Документы загружены/)).toBeNull();
    });
    it('uses native scoped deletion and clears stale answer only on acknowledged deletion', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true); vi.mocked(api.getKnowledgeBaseFiles).mockResolvedValue({ success: true, files: [file] }); vi.mocked(api.previewKnowledgeAnswer).mockResolvedValue(answer()); vi.mocked(api.deleteNativeKnowledgeDocument).mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true, businessId: 7, documentId: file.id, deleted: true });
        show(); ask(); expect(await screen.findByText(answer().answer)).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: `Удалить ${file.originalName}` })); expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Не удалось удалить')); expect(screen.queryByText('Документ удалён.')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: `Удалить ${file.originalName}` })); expect(await screen.findByText('Документ удалён.')).toBeTruthy(); expect(api.deleteNativeKnowledgeDocument).toHaveBeenCalledWith(7, file.id, expect.any(AbortSignal)); expect(screen.queryByText(answer().answer)).toBeNull(); expect(screen.queryByText('Tenant 7 rules')).toBeNull();
    });
    it('aborts pending read, preview and upload on logout/unmount', async () => {
        vi.mocked(api.getKnowledgeBaseFiles).mockImplementation(() => new Promise(() => {})); vi.mocked(api.previewKnowledgeAnswer).mockImplementation(() => new Promise(() => {})); vi.mocked(api.uploadKnowledgeBaseFiles).mockImplementation(() => new Promise(() => {})); const view = show(); ask(); fireEvent.change(screen.getByLabelText('Загрузить файлы'), { target: { files: [new File(['Rules'], 'rules.txt', { type: 'text/plain' })] } });
        const read = vi.mocked(api.getKnowledgeBaseFiles).mock.calls[0][1]; const preview = vi.mocked(api.previewKnowledgeAnswer).mock.calls[0][2]; const upload = vi.mocked(api.uploadKnowledgeBaseFiles).mock.calls[0][2]; view.unmount(); expect(read?.aborted).toBe(true); expect(preview?.aborted).toBe(true); expect(upload?.aborted).toBe(true);
    });
});
