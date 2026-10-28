// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import KnowledgeReview from './KnowledgeReview';
import { getKnowledgeReview, createKnowledgeDraft, updateKnowledgeDraft, checkKnowledgeDraft, publishKnowledgeDraft, rollbackKnowledgeDraft, type KnowledgeReviewDraft, type KnowledgeReviewCheck, type KnowledgeReviewVersion } from '../../improvementsApi';
const fixture = vi.hoisted(() => ({ enabled: true, userId: 'owner', role: 'hotel_owner', businessId: 7, checking: false, caps: ['sales.read', 'sales.write', 'sales.assign', 'ai.use'], drafts: [] as KnowledgeReviewDraft[] }));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ authenticated: true, userId: fixture.userId, role: 'customer', permissionsLoading: fixture.checking, memberships: [{ businessId: fixture.businessId, role: fixture.role, capabilities: fixture.caps }] }) }));
vi.mock('../../hooks/useWorkspaceFeatures', () => ({ useWorkspaceFeatures: () => ({ features: fixture.enabled ? { flags: { knowledgeReview: true } } : null }) }));
vi.mock('../../improvementsApi', () => ({ getKnowledgeReview: vi.fn(), createKnowledgeDraft: vi.fn(), updateKnowledgeDraft: vi.fn(), checkKnowledgeDraft: vi.fn(), publishKnowledgeDraft: vi.fn(), rollbackKnowledgeDraft: vi.fn() }));
const source = { type: 'message' as const, id: 'source-message', chatId: 'assigned-dialogue' };
const date = '2026-10-06T15:00:00Z';
const candidate = { source, text: 'Когда можно заселиться?', createdAt: date };
const check = (revision = 2, version = 1, overrides: Partial<KnowledgeReviewCheck> = {}): KnowledgeReviewCheck => ({ status: 'passed', passed: true, reason: 'Подтверждено правилами проживания.', citations: [{ documentId: 12, chunkId: 19, quote: 'Заселение с 14:00.' }], version, revision, sourceHash: 'source', knowledgeHash: 'knowledge', checkedBy: 'owner', checkedAt: date, ...overrides });
const draft = (overrides: Partial<KnowledgeReviewDraft> = {}): KnowledgeReviewDraft => ({ id: 'draft-opaque', question: candidate.text, answer: 'Заселение с 14:00.', source, status: 'draft', revision: 1, version: 1, authorUserId: fixture.userId, check: null, currentDocumentId: null, sync: null, createdAt: date, updatedAt: date, history: [], ...overrides });
const version = (overrides: Partial<KnowledgeReviewVersion> = {}): KnowledgeReviewVersion => ({ id: 'version-opaque', draftId: 'draft-opaque', revision: 3, version: 1, kind: 'published', question: candidate.text, answer: 'Заселение с 13:00.', actorUserId: 'owner', check: check(2), documentId: 10, restoredVersionId: null, createdAt: date, ...overrides });
function result(value: KnowledgeReviewDraft) { fixture.drafts = [value]; return { success: true as const, businessId: fixture.businessId, draft: value }; }
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
async function open() { const item = await screen.findByRole('button', { name: /Когда можно заселиться.*Черновик|Когда можно заселиться.*Проверен|Когда можно заселиться.*Опубликован/ }); fireEvent.click(item); await screen.findByLabelText('Ответ'); }
async function propose() { fireEvent.click(await screen.findByRole('button', { name: `Предложить ответ: ${candidate.text}` })); fireEvent.click(button('Подготовить черновик')); }
beforeEach(() => {
    vi.resetAllMocks(); fixture.enabled = true; fixture.businessId = 7; fixture.userId = 'owner'; fixture.role = 'hotel_owner'; fixture.checking = false; fixture.caps = ['sales.read', 'sales.write', 'sales.assign', 'ai.use']; fixture.drafts = [draft()];
    vi.mocked(getKnowledgeReview).mockImplementation(async id => ({ success: true, businessId: id, drafts: [...fixture.drafts], candidates: [candidate], versions: fixture.drafts.flatMap(item => item.history) }));
    vi.mocked(createKnowledgeDraft).mockImplementation(async () => result(draft()));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Knowledge review current revisions and explicit approval', () => {
    it('does not query or change the page when disabled or flags are unavailable', () => { fixture.enabled = false; render(<KnowledgeReview businessId={7} />); expect(screen.queryByText('Улучшение ответов AVA')).toBeNull(); expect(getKnowledgeReview).not.toHaveBeenCalled(); });
    it.each(['hotel_owner', 'sales_lead'])('preserves %s publication access in the disclosed review panel', async role => {
        fixture.role = role; fixture.drafts = [draft({ status: 'checked', revision: 2, check: check() })];
        render(<KnowledgeReview businessId={7} collapsed />);
        const disclosure = screen.getByText('Ответы из обращений').closest('details')!;
        expect(disclosure.open).toBe(false);
        fireEvent.click(screen.getByText('Ответы из обращений'));
        await open();
        expect(button('Опубликовать ответ').disabled).toBe(false);
        expect(screen.queryByText('source-message')).toBeNull();
    });
    it('lets an observer read without generation, editing, checking or publication', async () => {
        fixture.role = 'observer'; fixture.caps = ['sales.read']; render(<KnowledgeReview businessId={7} />); await open();
        expect((screen.getByLabelText('Ответ') as HTMLTextAreaElement).readOnly).toBe(true); expect(screen.queryByRole('button', { name: /Предложить ответ/ })).toBeNull(); expect(screen.queryByRole('button', { name: 'Проверить ответ' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Опубликовать ответ' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Сохранить редакцию' })).toBeNull();
    });
    it('proposes from the exact scoped source but gives managers no approval', async () => {
        fixture.role = 'manager'; fixture.userId = 'manager'; fixture.caps = ['sales.read', 'sales.write', 'ai.use']; fixture.drafts = []; render(<KnowledgeReview businessId={7} />); await propose(); await screen.findByLabelText('Ответ');
        expect(createKnowledgeDraft).toHaveBeenCalledWith(7, { question: candidate.text, source }, expect.any(AbortSignal), expect.any(String)); expect(screen.queryByRole('button', { name: 'Проверить ответ' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Опубликовать ответ' })).toBeNull(); expect(screen.queryByText('source-message')).toBeNull();
    });
    it('keeps another manager author draft readonly', async () => {
        fixture.role = 'manager'; fixture.userId = 'manager'; fixture.caps = ['sales.read', 'sales.write', 'ai.use']; fixture.drafts = [draft({ authorUserId: 'another-manager' })]; render(<KnowledgeReview businessId={7} />); await open(); expect((screen.getByLabelText('Ответ') as HTMLTextAreaElement).readOnly).toBe(true); expect(screen.queryByRole('button', { name: 'Сохранить редакцию' })).toBeNull();
    });
    it('saves edits and checks the new revision before explicit publication', async () => {
        fixture.drafts = [draft({ status: 'checked', revision: 2, check: check() })];
        vi.mocked(updateKnowledgeDraft).mockImplementation(async (_business, _id, body) => result(draft({ question: body.question, answer: body.answer, revision: body.revision + 1, version: 2 })));
        vi.mocked(checkKnowledgeDraft).mockImplementation(async (_business, _id, revision) => result(draft({ status: 'checked', answer: 'Заселение с 15:00.', revision: revision + 1, version: 2, check: check(revision + 1, 2) })));
        vi.mocked(publishKnowledgeDraft).mockImplementation(async (_business, _id, revision) => result(draft({ status: 'published', answer: 'Заселение с 15:00.', revision: revision + 1, version: 2, check: check(revision, 2) })));
        render(<KnowledgeReview businessId={7} />); await open(); expect(button('Опубликовать ответ').disabled).toBe(false);
        fireEvent.change(screen.getByLabelText('Ответ'), { target: { value: 'Заселение с 15:00.' } }); expect(button('Опубликовать ответ').disabled).toBe(true); expect(button('Проверить ответ').disabled).toBe(true);
        fireEvent.click(button('Сохранить редакцию')); await waitFor(() => expect(button('Проверить ответ').disabled).toBe(false)); expect(button('Опубликовать ответ').disabled).toBe(true);
        expect(updateKnowledgeDraft).toHaveBeenCalledWith(7, 'draft-opaque', { revision: 2, question: candidate.text, answer: 'Заселение с 15:00.' }, expect.any(AbortSignal), expect.any(String));
        fireEvent.click(button('Проверить ответ')); await waitFor(() => expect(button('Опубликовать ответ').disabled).toBe(false)); expect(checkKnowledgeDraft).toHaveBeenCalledWith(7, 'draft-opaque', 3, expect.any(AbortSignal), expect.any(String)); expect(publishKnowledgeDraft).not.toHaveBeenCalled();
        fireEvent.click(button('Опубликовать ответ')); expect(await screen.findByRole('alertdialog')).toBeTruthy(); expect(publishKnowledgeDraft).not.toHaveBeenCalled(); expect(document.activeElement).toBe(button('Отмена'));
        fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(button('Подтвердить публикацию')); fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' }); expect(screen.queryByRole('alertdialog')).toBeNull();
        fireEvent.click(button('Опубликовать ответ')); fireEvent.click(button('Подтвердить публикацию')); await screen.findByText('Ответ опубликован в базе знаний.'); expect(publishKnowledgeDraft).toHaveBeenCalledWith(7, 'draft-opaque', 4, expect.any(AbortSignal), expect.any(String));
    });
    it.each(['failed', 'unavailable', 'timeout'] as const)('blocks publication after %s verification', async status => { fixture.drafts = [draft({ revision: 2, check: check(2, 1, { status, passed: false }) })]; render(<KnowledgeReview businessId={7} />); await open(); expect(button('Опубликовать ответ').disabled).toBe(true); expect(publishKnowledgeDraft).not.toHaveBeenCalled(); });
    it('requires explicit owner attestation for new business facts and never claims an AI pass', async () => {
        const manualCheck = check(2, 1, { status: 'manual_required', passed: false, needsConfirmation: true, contentHash: 'current-content', citations: [] });
        fixture.drafts = [draft({ revision: 2, check: manualCheck, answer: 'Новая услуга — поздний выезд до 18:00.' })];
        vi.mocked(publishKnowledgeDraft).mockImplementationOnce(async () => result(draft({ status: 'published', revision: 3, answer: 'Новая услуга — поздний выезд до 18:00.', approval: { type: 'human_confirmed', userId: 'owner', revision: 2, version: 1, sourceHash: 'source', contentHash: 'current-content', approvedAt: date } })));
        render(<KnowledgeReview businessId={7} />); await open(); expect(screen.queryByText('Проверка пройдена')).toBeNull(); expect(screen.getByText('Нужно подтверждение сведений бизнеса')).toBeTruthy();
        fireEvent.click(button('Опубликовать ответ')); expect(screen.getByRole('alertdialog').textContent).toContain('Новая услуга — поздний выезд до 18:00.'); expect(button('Подтвердить публикацию').disabled).toBe(true);
        fireEvent.click(button('Подтвердить публикацию')); expect(publishKnowledgeDraft).not.toHaveBeenCalled();
        fireEvent.click(screen.getByLabelText('Подтверждаю эти сведения как актуальную информацию бизнеса')); fireEvent.click(button('Подтвердить публикацию')); await screen.findByText('Ответ опубликован в базе знаний.');
        expect(publishKnowledgeDraft).toHaveBeenCalledWith(7, 'draft-opaque', 2, expect.any(AbortSignal), expect.any(String), { confirm: true, revision: 2, contentHash: 'current-content', sourceHash: 'source' });
    });
    it('invalidates manual confirmation on an edit and cannot substitute provider failure for manual review', async () => {
        fixture.drafts = [draft({ revision: 2, check: check(2, 1, { status: 'manual_required', passed: false, needsConfirmation: true, contentHash: 'content' }) })];
        const view = render(<KnowledgeReview businessId={7} />); await open(); fireEvent.change(screen.getByLabelText('Ответ'), { target: { value: 'Изменённый новый факт' } }); expect(button('Опубликовать ответ').disabled).toBe(true);
        fixture.userId = 'next-owner'; fixture.drafts = [draft({ revision: 2, check: check(2, 1, { status: 'unavailable', passed: false, needsConfirmation: true, contentHash: 'content' }) })]; view.rerender(<KnowledgeReview businessId={7} />); await open(); expect(button('Опубликовать ответ').disabled).toBe(true); expect(screen.queryByLabelText('Подтверждаю эти сведения как актуальную информацию бизнеса')).toBeNull();
    });
    it('does not offer managers manual approval for new facts', async () => {
        fixture.role = 'manager'; fixture.userId = 'manager'; fixture.caps = ['sales.read', 'sales.write', 'ai.use']; fixture.drafts = [draft({ revision: 2, check: check(2, 1, { status: 'manual_required', passed: false, needsConfirmation: true, contentHash: 'content' }) })];
        render(<KnowledgeReview businessId={7} />); await open(); expect(screen.queryByRole('button', { name: 'Опубликовать ответ' })).toBeNull();
    });
    it('blocks stale previously passed content and revision', async () => { fixture.drafts = [draft({ status: 'checked', revision: 4, version: 2, check: check(2, 1) })]; render(<KnowledgeReview businessId={7} />); await open(); expect(button('Опубликовать ответ').disabled).toBe(true); });
    it('restores the exact older publication only after confirmation', async () => {
        fixture.drafts = [draft({ status: 'published', revision: 7, version: 2, currentDocumentId: 10, history: [version({ id: 'latest', revision: 7, version: 2 }), version()] })]; vi.mocked(rollbackKnowledgeDraft).mockImplementation(async () => result(draft({ status: 'published', revision: 8, version: 3, answer: 'Заселение с 13:00.' })));
        render(<KnowledgeReview businessId={7} />); await open(); fireEvent.click(screen.getByText('История редакций')); fireEvent.click(button('Восстановить редакцию 1')); expect(rollbackKnowledgeDraft).not.toHaveBeenCalled(); fireEvent.click(button('Подтвердить восстановление')); await screen.findByText('Предыдущая редакция восстановлена.'); expect(rollbackKnowledgeDraft).toHaveBeenCalledWith(7, 'draft-opaque', 7, 'version-opaque', expect.any(AbortSignal), expect.any(String));
    });
    it('retains local text on conflict and only replaces it on explicit reload', async () => {
        vi.mocked(updateKnowledgeDraft).mockRejectedValueOnce({ response: { status: 409, data: { code: 'KNOWLEDGE_REVIEW_REVISION_CONFLICT' } } }); render(<KnowledgeReview businessId={7} />); await open(); fireEvent.change(screen.getByLabelText('Ответ'), { target: { value: 'Мой несохранённый ответ' } }); fireEvent.click(button('Сохранить редакцию')); await screen.findByRole('alert'); expect(screen.getByDisplayValue('Мой несохранённый ответ')).toBeTruthy();
        fixture.drafts = [draft({ revision: 2, answer: 'Ответ другого сотрудника' })]; fireEvent.click(button('Обновить предложения')); await waitFor(() => expect(button('Обновить предложения').disabled).toBe(false)); expect(screen.getByDisplayValue('Мой несохранённый ответ')).toBeTruthy(); fireEvent.click(button('Загрузить актуальную редакцию')); expect(screen.getByDisplayValue('Ответ другого сотрудника')).toBeTruthy();
    });
});

describe('Knowledge review cancellation and identity resets', () => {
    it('recovers after cancelled creation and an empty refetch using the original body and key', async () => {
        fixture.drafts = []; let finish!: (value: any) => void; vi.mocked(createKnowledgeDraft).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); render(<KnowledgeReview businessId={7} />); await propose(); await screen.findByText('Готовим черновик…'); fireEvent.click(button('Отменить ожидание')); expect(vi.mocked(createKnowledgeDraft).mock.calls[0][2]?.aborted).toBe(true);
        fireEvent.click(button('Обновить предложения')); await waitFor(() => expect(button('Обновить предложения').disabled).toBe(false)); fireEvent.click(button('Повторить тот же запрос')); await screen.findByLabelText('Ответ'); const calls = vi.mocked(createKnowledgeDraft).mock.calls; expect(calls).toHaveLength(2); expect(calls[1][1]).toEqual(calls[0][1]); expect(calls[1][3]).toBe(calls[0][3]);
        await act(async () => finish({ success: true, businessId: 7, draft: draft({ answer: 'Опоздавший результат' }) })); expect(screen.queryByDisplayValue('Опоздавший результат')).toBeNull();
    });
    it('retries an unknown publication with the same revision and key', async () => {
        fixture.drafts = [draft({ status: 'checked', revision: 2, check: check() })]; vi.mocked(publishKnowledgeDraft).mockRejectedValueOnce(new Error('network')).mockImplementationOnce(async () => result(draft({ status: 'published', revision: 3 })));
        render(<KnowledgeReview businessId={7} />); await open(); fireEvent.click(button('Опубликовать ответ')); fireEvent.click(button('Подтвердить публикацию')); await screen.findByRole('alert'); await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull()); fireEvent.click(button('Повторить тот же запрос')); await screen.findByText('Ответ опубликован в базе знаний.'); const calls = vi.mocked(publishKnowledgeDraft).mock.calls; expect(calls).toHaveLength(2); expect(calls[1][2]).toBe(calls[0][2]); expect(calls[1][4]).toBe(calls[0][4]);
    });
    it('ignores generation from a previous business', async () => {
        let finish!: (value: any) => void; vi.mocked(createKnowledgeDraft).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const view = render(<KnowledgeReview businessId={7} />); await propose(); fixture.businessId = 8; fixture.drafts = []; view.rerender(<KnowledgeReview businessId={8} />); await screen.findByText('Пока нет сохранённых предложений.'); await act(async () => finish({ success: true, businessId: 7, draft: draft({ answer: 'Ответ прошлого бизнеса' }) })); expect(screen.queryByDisplayValue('Ответ прошлого бизнеса')).toBeNull(); expect(vi.mocked(createKnowledgeDraft).mock.calls[0][2]?.aborted).toBe(true);
    });
    it('ignores a previous user check and clears their editor', async () => {
        let finish!: (value: any) => void; vi.mocked(checkKnowledgeDraft).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const view = render(<KnowledgeReview businessId={7} />); await open(); fireEvent.click(button('Проверить ответ')); fixture.userId = 'new-user'; view.rerender(<KnowledgeReview businessId={7} />); await screen.findByText('Выберите вопрос или черновик'); await act(async () => finish({ success: true, businessId: 7, draft: draft({ check: check(), status: 'checked', revision: 2 }) })); expect(screen.queryByLabelText('Ответ')).toBeNull(); expect(vi.mocked(checkKnowledgeDraft).mock.calls[0][3]?.aborted).toBe(true);
    });
    it('cancels and discards generation when permissions are revoked', async () => {
        let finish!: (value: any) => void; vi.mocked(createKnowledgeDraft).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const view = render(<KnowledgeReview businessId={7} />); await propose(); fixture.caps = ['sales.read']; view.rerender(<KnowledgeReview businessId={7} />); await screen.findByText('Выберите вопрос или черновик'); await act(async () => finish({ success: true, businessId: 7, draft: draft({ answer: 'Закрытый ответ' }) })); expect(screen.queryByDisplayValue('Закрытый ответ')).toBeNull();
    });
    it('preserves input on focus refresh and disables actions during access checks', async () => {
        const view = render(<KnowledgeReview businessId={7} />); await open(); fireEvent.change(screen.getByLabelText('Ответ'), { target: { value: 'Сохранить мой ввод' } }); fixture.checking = true; view.rerender(<KnowledgeReview businessId={7} />); expect(screen.getByDisplayValue('Сохранить мой ввод')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Опубликовать ответ' })).toBeNull();
        fixture.checking = false; view.rerender(<KnowledgeReview businessId={7} />); fireEvent(window, new Event('focus')); await waitFor(() => expect(getKnowledgeReview).toHaveBeenCalledTimes(2)); expect(screen.getByDisplayValue('Сохранить мой ввод')).toBeTruthy();
    });
    it('shows a failed read without a fake empty list or permanent spinner', async () => { vi.mocked(getKnowledgeReview).mockRejectedValueOnce(new Error()); render(<KnowledgeReview businessId={7} />); await screen.findByRole('alert'); expect(screen.queryByText('Пока нет сохранённых предложений.')).toBeNull(); expect(screen.queryByText('Загружаем предложения…')).toBeNull(); });
});
