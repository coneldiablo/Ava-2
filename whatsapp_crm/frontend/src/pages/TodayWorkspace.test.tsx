// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TodayWorkspace from './TodayWorkspace';
import { getClientWorkspace, getWorkday, getReplyRecovery, resolveReplyRecovery, getStudioHandoff, retryWorkspaceMedia, workspaceRequest } from '../avaWorkspace';
import { generateCopilot, getAttention, getAvailability, getPresence, postPresence, updateAvailability } from '../improvementsApi';
import { clearWorkspaceDrafts } from '../hooks/useScopedDraft';
import { assignSalesClient, createSalesTask } from '../api';
const fixture = vi.hoisted(() => ({ businessId: 7, userId: 'employee', role: 'manager', enabled: true, revision: 'r1', presenceRevision: 'r1', sendInProgress: false, checking: false, assignee: 'employee' as string | null, capabilities: ['business.read','sales.read','sales.write','tasks.claim','messages.send','ai.use'] as string[] }));
vi.mock('../context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: fixture.businessId, currentInstance: { name: `Бизнес ${fixture.businessId}` } }) }));
vi.mock('../permissions', () => ({ useBusinessAccess: () => ({ role: fixture.role, userId: fixture.userId, checking: fixture.checking, membership: { capabilities: fixture.capabilities }, can: (cap: string) => !fixture.checking && fixture.capabilities.includes(cap) }) }));
vi.mock('../hooks/useWorkspaceFeatures', () => ({ useWorkspaceFeatures: () => ({ features: fixture.enabled ? { available: true, flags: { queueFlow: true, collaboration: true, shifts: true, attention: true, copilot: true } } : null }) }));
vi.mock('../api', () => ({ api: {}, assignSalesClient: vi.fn(async () => { fixture.assignee = fixture.userId; return { success: true }; }), updateSalesTask: vi.fn(), createSalesTask: vi.fn(async () => ({ success: true })) }));
vi.mock('../avaWorkspace', async () => {
    const original = await vi.importActual<typeof import('../avaWorkspace')>('../avaWorkspace');
    return { ...original,
        getWorkday: vi.fn(async (id: number, view: string) => ({ success: true, businessId: id, view, capabilities: fixture.capabilities, summary: { needsHuman: 2, overdue: 0, unassigned: 0, aiActive: 0 }, items: ['Анна','Борис'].map((name,index) => ({ chatId: `card${index + 1}`, name: `Клиент ${name}`, assigneeUserId: fixture.assignee, assigneeName: 'Менеджер', controlMode: 'human', reasons: [], nextAction: null })), pagination: { page: 1, pageSize: 30, total: 2 } })),
        getClientWorkspace: vi.fn(async (id: number, chatId: string) => ({ success: true, businessId: id, dialogueRevision: fixture.revision, capabilities: fixture.capabilities, client: { chatId, name: chatId === 'card1' ? 'Анна' : 'Борис', assigneeUserId: fixture.assignee, status: 'new' }, control: { mode: 'human', revision: 1, sendInProgress: fixture.sendInProgress, sendStatus: fixture.sendInProgress ? 'unknown' : undefined }, messages: [], calls: [], tasks: [], deals: [], promises: [], memory: { summary: null, keyFacts: [], objections: [], sourceUpdatedAt: null, sourceComplete: true } })),
        getStudioHandoff: vi.fn(async (id: number, dealId: string, revision: number, chatId: string) => ({ success: true, businessId: id, dealId, material: { revision, text: 'Сохранённый материал' }, composer: { businessId: id, chatId, text: 'Сохранённый материал', materialRevision: revision, requiresHumanConfirmation: true } })),
        getReplyTemplate: vi.fn(async () => ({ id: 9, text: 'Здравствуйте, {{имя}}!' })),
        getReplyRecovery: vi.fn(async (id: number, chatId: string) => ({ success: true, businessId: id, chatId, canResolve: fixture.role === 'sales_lead', action: { id: 'original-action', status: 'unknown', text: 'Исходный ответ', userId: 'employee', textHash: 'hash', createdAt: '', updatedAt: '' }, evidence: [], history: [], control: { mode: 'human', revision: 1, reason: null, updatedAt: '' } })),
        resolveReplyRecovery: vi.fn(async (id: number, chatId: string) => ({ success: true, businessId: id, chatId })),
        getSavedViews: vi.fn(async (id: number) => ({ success: true, businessId: id, views: [] })),
        getCatalog: vi.fn(async (id: number) => ({ success: true, businessId: id, offers: [] })),
        getQuotes: vi.fn(async (id: number) => ({ success: true, businessId: id, quotes: [] })),
        retryWorkspaceMedia: vi.fn(async (id: number) => ({ success: true, businessId: id })),
        workspaceRequest: vi.fn(async (id: number) => ({ success: true, businessId: id, status: 'sent' })),
    };
});
vi.mock('../improvementsApi', () => ({
    getPresence: vi.fn(async (id: number) => ({ success: true, businessId: id, dialogueRevision: fixture.presenceRevision, participants: [] })),
    postPresence: vi.fn(async (id: number) => ({ success: true, businessId: id, dialogueRevision: fixture.presenceRevision, participants: [{ userId: 'other', name: 'Елена', typing: true, expiresAt: new Date(Date.now()+45000).toISOString() }] })),
    getAttention: vi.fn(async (id: number) => ({ success: true, businessId: id, items: [], counts: { total: 0, returned: 0, byType: {} } })),
    getAvailability: vi.fn(async (id: number) => ({ success: true, businessId: id, members: [{ userId: fixture.userId, name: 'Менеджер', status: 'available', revision: 2, capacity: null, currentLoad: 2 }, { userId: 'other', name: 'Елена', status: 'break', revision: 3, capacity: 5, currentLoad: 1 }] })),
    updateAvailability: vi.fn(async (id: number) => ({ success: true, businessId: id })),
    generateCopilot: vi.fn(async (id: number, _chatId: string, intent: string) => ({ success: true, businessId: id, dialogueRevision: fixture.revision, draft: { id: 'draft1', kind: intent, text: 'Подсказка менеджеру', sources: [], ...(intent === 'offer' ? { offerId: 'offer1' } : {}), ...(intent === 'next_action' ? { task: { summary: 'Подсказка менеджеру', priority: 'normal' } } : {}) } })),
}));
const show = (path = '/today?client=card1') => render(<MemoryRouter initialEntries={[path]}><TodayWorkspace /></MemoryRouter>);
const reply = () => screen.getByLabelText('Ответ клиенту') as HTMLTextAreaElement;
const row = (name: string) => screen.getByText(`Клиент ${name}`, { selector: 'strong' }).closest('button')!;
describe('Today integrated improvements', () => {
    it('shows the provider subscription refusal as an error and preserves the draft',async()=>{
        vi.mocked(workspaceRequest).mockResolvedValueOnce({success:true,businessId:7,status:'failed',failureCode:'AVITO_CHAT_SUBSCRIPTION_REQUIRED'} as never);
        show();await screen.findByLabelText('Ответ клиенту');fireEvent.change(reply(),{target:{value:'Сохранённый ответ'}});fireEvent.click(screen.getByRole('button',{name:'Отправить'}));
        const alert=await screen.findByRole('alert');expect(alert.textContent).toContain('нужна подписка с API мессенджера');expect(reply()).toHaveProperty('value','Сохранённый ответ');expect(screen.queryByText('Отправлено в канал. Доставка клиенту ещё не подтверждена.')).toBeNull();
    });
    beforeEach(() => { vi.clearAllMocks(); clearWorkspaceDrafts(); sessionStorage.clear(); fixture.businessId = 7; fixture.userId = 'employee'; fixture.role = 'manager'; fixture.enabled = true; fixture.revision = 'r1'; fixture.presenceRevision = 'r1'; fixture.sendInProgress = false; fixture.checking = false; fixture.assignee = 'employee'; fixture.capabilities = ['business.read','sales.read','sales.write','tasks.claim','messages.send','ai.use']; });
    afterEach(cleanup);
    it('opens an imported Avito conversation and replies through the existing workspace route',async()=>{
        fixture.revision='5';fixture.presenceRevision='5';
        vi.mocked(getClientWorkspace).mockResolvedValueOnce({success:true,businessId:7,dialogueRevision:'5',capabilities:fixture.capabilities,client:{chatId:'avito:123:abc',name:'Клиент Авито',assigneeUserId:'employee',status:'new'},control:{mode:'human',revision:1,sendInProgress:false},messages:[{id:'avito-message',role:'user',content:'Нужен комплект',channel:'avito',timestamp:'2026-10-18T10:00:00Z'}],calls:[],tasks:[],deals:[],promises:[],memory:{summary:null,keyFacts:[],objections:[],sourceUpdatedAt:null,sourceComplete:true}} as never);
        show('/today?client=avito%3A123%3Aabc');await screen.findByText('Клиент · Авито');
        fireEvent.change(reply(),{target:{value:'Здравствуйте, подготовим предложение'}});
        fireEvent.click(screen.getByRole('button',{name:'Отправить'}));
        await waitFor(()=>expect(workspaceRequest).toHaveBeenCalledWith(7,'/workspace/clients/avito%3A123%3Aabc/reply','post',expect.objectContaining({text:'Здравствуйте, подготовим предложение',expectedDialogueRevision:'5'}),expect.any(AbortSignal)));
    });
    it('retains legacy workday and does not call new APIs when flags are unavailable', async () => {
        fixture.enabled = false; show(); await screen.findByRole('heading', { name: 'Анна' });
        expect(screen.queryByRole('button', { name: 'Начать очередь' })).toBeNull(); expect(screen.queryByText('Смена и команда')).toBeNull(); expect(postPresence).not.toHaveBeenCalled(); expect(getAvailability).not.toHaveBeenCalled(); expect(getAttention).not.toHaveBeenCalled();
    });
    it('Begin/Next retains search, queue scroll and each client draft', async () => {
        show('/today?view=mine&q=Клиент'); await screen.findByText('Клиент Анна');
        const list = screen.getByRole('region', { name: 'Очередь клиентов' }).querySelector('ul')!; list.scrollTop = 120;
        fireEvent.click(screen.getByRole('button', { name: 'Начать очередь' })); await screen.findByRole('heading', { name: 'Анна' }); fireEvent.change(reply(), { target: { value: 'Черновик Анны' } });
        fireEvent.click(screen.getAllByRole('button', { name: 'Следующий клиент' }).slice(-1)[0]!); await screen.findByRole('heading', { name: 'Борис' }); expect(reply().value).toBe('');
        fireEvent.change(reply(), { target: { value: 'Черновик Бориса' } }); fireEvent.click(row('Анна')); await screen.findByRole('heading', { name: 'Анна' }); expect(reply().value).toBe('Черновик Анны'); expect(screen.getByRole('searchbox').getAttribute('value')).toBe('Клиент'); expect(list.scrollTop).toBe(120);
    });
    it('revision conflict preserves text, refreshes context and does not leave an unknown reservation', async () => {
        vi.mocked(workspaceRequest).mockRejectedValueOnce({ response: { data: { code: 'WORKSPACE_DIALOGUE_CHANGED' } } });
        show(); await screen.findByRole('heading', { name: 'Анна' }); fireEvent.change(reply(), { target: { value: 'Ответ до конфликта' } }); fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
        await screen.findByRole('alert'); await waitFor(() => expect(getClientWorkspace).toHaveBeenCalledTimes(2)); expect(reply().value).toBe('Ответ до конфликта');
        expect(JSON.parse(sessionStorage.getItem('ava:reply:employee:7:card1')!).state).toBe('draft');
        expect(workspaceRequest).toHaveBeenCalledWith(7, '/workspace/clients/card1/reply', 'post', expect.objectContaining({ expectedDialogueRevision: 'r1', text: 'Ответ до конфликта' }), expect.any(AbortSignal));
    });
    it('unknown network result stays fenced across history refresh and remount', async () => {
        vi.mocked(workspaceRequest).mockRejectedValueOnce(new Error('network')); const view = show(); await screen.findByRole('heading', { name: 'Анна' }); fireEvent.change(reply(), { target: { value: 'Неизвестная отправка' } }); fireEvent.click(screen.getByRole('button', { name: 'Отправить' })); await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'Обновить историю клиента' })); await waitFor(() => expect(getClientWorkspace).toHaveBeenCalledTimes(2)); expect(reply().disabled).toBe(true);
        view.unmount(); show(); await screen.findByRole('heading', { name: 'Анна' }); expect(reply().disabled).toBe(true); expect(screen.getByRole('button', { name: 'Отправить' }).hasAttribute('disabled')).toBe(true); expect(workspaceRequest).toHaveBeenCalledTimes(1);
    });
    it('presence change asks to refresh context while preserving an editable draft', async () => {
        fixture.presenceRevision = 'r2'; show(); await screen.findByText('В диалоге появились изменения. Черновик сохранён.'); fireEvent.change(reply(), { target: { value: 'Сохрани меня' } }); expect(screen.getByRole('button', { name: 'Отправить' }).hasAttribute('disabled')).toBe(true);
        fixture.revision = 'r2'; fireEvent.click(screen.getByRole('button', { name: 'Обновить контекст' })); await waitFor(() => expect(screen.queryByText('В диалоге появились изменения. Черновик сохранён.')).toBeNull()); expect(reply().value).toBe('Сохрани меня');
    });
    it('Copilot appends reviewed text into the existing composer without sending', async () => {
        show(); await screen.findByRole('button', { name: 'Черновик ответа' }); fireEvent.change(reply(), { target: { value: 'Мой текст' } }); fireEvent.click(screen.getByRole('button', { name: 'Черновик ответа' })); await screen.findByLabelText('Проверьте и отредактируйте'); fireEvent.change(screen.getByLabelText('Проверьте и отредактируйте'), { target: { value: 'Проверенный текст' } }); fireEvent.click(screen.getByRole('button', { name: 'Вставить в ответ' })); await waitFor(() => expect(reply().value).toBe('Мой текст\n\nПроверенный текст')); expect(workspaceRequest).not.toHaveBeenCalled();
    });
    it('offer and task effects happen only after human confirmation on the exact customer', async () => {
        show(); await screen.findByRole('button', { name: 'Предложение' }); fireEvent.click(screen.getByRole('button', { name: 'Предложение' })); await screen.findByRole('button', { name: 'Подтвердить предложение' }); expect(workspaceRequest).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Подтвердить предложение' })); await waitFor(() => expect(workspaceRequest).toHaveBeenCalledWith(7, '/quotes', 'post', { chatId: 'card1', offerId: 'offer1', quantity: 1 }, expect.any(AbortSignal)));
        await waitFor(() => expect(screen.queryByLabelText('Проверьте и отредактируйте')).toBeNull()); fireEvent.click(screen.getByRole('button', { name: 'Следующее действие' })); await screen.findByRole('button', { name: 'Подтвердить задачу' }); expect(createSalesTask).not.toHaveBeenCalled(); fireEvent.change(screen.getByLabelText('Проверьте и отредактируйте'), { target: { value: 'Согласовать встречу' } }); fireEvent.click(screen.getByRole('button', { name: 'Подтвердить задачу' })); await waitFor(() => expect(createSalesTask).toHaveBeenCalledWith(7, { chatId: 'card1', summary: 'Согласовать встречу', dueAt: null, priority: 'normal' }, expect.any(AbortSignal)));
    });
    it('manager changes own shift only and observer performs no new writes', async () => {
        const view = show(); await screen.findByLabelText('Смена: Менеджер'); expect(screen.queryByLabelText('Смена: Елена')).toBeNull(); fireEvent.change(screen.getByLabelText('Смена: Менеджер'), { target: { value: 'break' } }); await waitFor(() => expect(updateAvailability).toHaveBeenCalledWith(7, 'employee', { revision: 2, status: 'break' }, expect.any(AbortSignal)));
        view.unmount(); vi.clearAllMocks(); fixture.role = 'observer'; fixture.capabilities = ['business.read','sales.read','team.read']; show(); await screen.findByRole('heading', { name: 'Анна' }); expect(screen.queryByLabelText('Ответ клиенту')).toBeNull(); expect(screen.queryByLabelText('Смена: Менеджер')).toBeNull(); expect(screen.queryByRole('button', { name: 'Черновик ответа' })).toBeNull(); expect(getPresence).toHaveBeenCalled(); expect(postPresence).not.toHaveBeenCalled(); expect(updateAvailability).not.toHaveBeenCalled();
    });
    it('supervisor capacity and status writes use exact member revision', async () => {
        fixture.role = 'sales_lead'; fixture.capabilities.push('sales.assign'); show(); await screen.findByLabelText('Лимит клиентов: Елена');
        fireEvent.change(screen.getByLabelText('Лимит клиентов: Елена'), { target: { value: '8' } }); fireEvent.click(screen.getAllByRole('button', { name: 'Сохранить лимит' })[1]);
        await waitFor(() => expect(updateAvailability).toHaveBeenCalledWith(7, 'other', { revision: 3, status: 'break', capacity: 8 }, expect.any(AbortSignal)));
    });
    it('Copilot remains finite and disabled when dialogue version is missing', async () => {
        fixture.revision = ''; show(); await screen.findByText(/Контекст помощника пока недоступен/); expect(screen.getByRole('button', { name: 'Черновик ответа' }).hasAttribute('disabled')).toBe(true); expect(generateCopilot).not.toHaveBeenCalled();
    });
    it('task confirmation rechecks current context before creating a task', async () => {
        show(); await screen.findByRole('button', { name: 'Следующее действие' }); fireEvent.click(screen.getByRole('button', { name: 'Следующее действие' })); await screen.findByRole('button', { name: 'Подтвердить задачу' });
        fixture.revision = 'r2'; fireEvent.click(screen.getByRole('button', { name: 'Подтвердить задачу' })); await screen.findByRole('alert'); expect(createSalesTask).not.toHaveBeenCalled(); expect(screen.getByLabelText('Проверьте и отредактируйте')).toBeTruthy();
    });
    it('Next continues into the next server page without clearing search or client draft', async () => {
        vi.mocked(getWorkday).mockImplementationOnce(async (id, view) => ({ success: true, businessId: id, view, summary: { needsHuman: 1, overdue: 0, unassigned: 0, aiActive: 0 }, items: [{ chatId: 'card1', name: 'Клиент Анна', assigneeUserId: 'employee', assigneeName: 'Менеджер', status: 'new', controlMode: 'human', reasons: [], nextAction: null, lastContactAt: null }], pagination: { page: 1, pageSize: 1, total: 2 } }));
        vi.mocked(getWorkday).mockImplementationOnce(async (id, view) => ({ success: true, businessId: id, view, summary: { needsHuman: 1, overdue: 0, unassigned: 0, aiActive: 0 }, items: [{ chatId: 'card2', name: 'Клиент Борис', assigneeUserId: 'employee', assigneeName: 'Менеджер', status: 'new', controlMode: 'human', reasons: [], nextAction: null, lastContactAt: null }], pagination: { page: 2, pageSize: 1, total: 2 } }));
        show('/today?view=mine&q=Клиент'); await screen.findByRole('button', { name: 'Начать очередь' }); fireEvent.click(screen.getByRole('button', { name: 'Начать очередь' })); await screen.findByRole('heading', { name: 'Анна' }); fireEvent.change(reply(), { target: { value: 'Остался в первой карточке' } }); fireEvent.click(screen.getAllByRole('button', { name: 'Следующий клиент' }).slice(-1)[0]); await screen.findByRole('heading', { name: 'Борис' });
        expect(getWorkday).toHaveBeenLastCalledWith(7, 'mine', 2, expect.any(AbortSignal)); expect(screen.getByRole('searchbox').getAttribute('value')).toBe('Клиент'); expect(JSON.parse(sessionStorage.getItem('ava:reply:employee:7:card1')!).text).toBe('Остался в первой карточке');
    });
    it('business switch cancels slow Copilot and never exposes old draft in new scope', async () => {
        let finish!: (value: Awaited<ReturnType<typeof generateCopilot>>) => void;
        vi.mocked(generateCopilot).mockImplementationOnce((_id, _chatId, _intent, signal) => new Promise(resolve => { finish = resolve; expect(signal).toBeInstanceOf(AbortSignal); }));
        const view = show(); await screen.findByRole('button', { name: 'Черновик ответа' }); fireEvent.click(screen.getByRole('button', { name: 'Черновик ответа' })); await waitFor(() => expect(generateCopilot).toHaveBeenCalled()); const signal = vi.mocked(generateCopilot).mock.calls[0][3]!;
        fixture.businessId = 8; view.rerender(<MemoryRouter initialEntries={['/today?client=card1']}><TodayWorkspace /></MemoryRouter>); await screen.findByText('Бизнес 8'); expect(signal.aborted).toBe(true); finish({ success: true, businessId: 7, dialogueRevision: 'r1', draft: { id: 'old', kind: 'reply', text: 'Чужой черновик', sources: [] } }); await screen.findByRole('heading', { name: 'Анна' }); expect(screen.queryByText('Чужой черновик')).toBeNull();
    });
    it('observer reads the useful overview without a write capability', async () => {
        fixture.role = 'observer'; fixture.capabilities = ['business.read', 'sales.read'];
        show('/today'); await screen.findByText('Клиент Анна');
        expect(getWorkday).toHaveBeenLastCalledWith(7, 'overview', 1, expect.any(AbortSignal));
        expect(screen.getByRole('button', { name: 'Все доступные' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.queryByRole('button', { name: 'Взять в работу' })).toBeNull();
    });
    it('task, promise and edited Copilot survive 503, Next and a route remount', async () => {
        const view = show(); await screen.findByRole('button', { name: 'Добавить задачу' });
        fireEvent.click(screen.getByRole('button', { name: 'Добавить задачу' }));
        fireEvent.change(screen.getByLabelText('Следующее действие'), { target: { value: 'Сохранённая задача' } });
        fireEvent.click(screen.getByRole('button', { name: 'Добавить обещание' }));
        fireEvent.change(screen.getByLabelText('Что обещали клиенту'), { target: { value: 'Сохранённое обещание' } });
        fireEvent.click(screen.getByRole('button', { name: 'Черновик ответа' }));
        await screen.findByLabelText('Проверьте и отредактируйте');
        fireEvent.change(screen.getByLabelText('Проверьте и отредактируйте'), { target: { value: 'Отредактированная подсказка' } });
        vi.mocked(getClientWorkspace).mockRejectedValueOnce(new Error('503'));
        fireEvent.click(screen.getByRole('button', { name: 'Обновить историю клиента' }));
        await screen.findByRole('alert');
        expect((screen.getByLabelText('Следующее действие') as HTMLTextAreaElement).value).toBe('Сохранённая задача');
        expect(screen.getByLabelText('Следующее действие').closest('fieldset')?.disabled).toBe(true);
        fireEvent.click(row('Борис')); await screen.findByRole('heading', { name: 'Борис' });
        expect(screen.queryByLabelText('Следующее действие')).toBeNull();
        fireEvent.click(row('Анна')); await screen.findByRole('heading', { name: 'Анна' });
        expect((screen.getByLabelText('Что обещали клиенту') as HTMLTextAreaElement).value).toBe('Сохранённое обещание');
        view.unmount(); show('/conversations'); await screen.findByRole('heading', { name: 'Анна' });
        expect((screen.getByLabelText('Следующее действие') as HTMLTextAreaElement).value).toBe('Сохранённая задача');
        expect((screen.getByLabelText('Проверьте и отредактируйте') as HTMLTextAreaElement).value).toBe('Отредактированная подсказка');
        expect(createSalesTask).not.toHaveBeenCalled();
    });
    it('permission revalidation retains forms but blocks writes until a live grant', async () => {
        const view = show(); await screen.findByRole('button', { name: 'Добавить задачу' });
        fireEvent.click(screen.getByRole('button', { name: 'Добавить задачу' }));
        fireEvent.change(screen.getByLabelText('Следующее действие'), { target: { value: 'Жду права' } });
        fixture.checking = true; view.rerender(<MemoryRouter initialEntries={['/today?client=card1']}><TodayWorkspace /></MemoryRouter>);
        expect((screen.getByLabelText('Следующее действие') as HTMLTextAreaElement).value).toBe('Жду права');
        expect(screen.getByLabelText('Следующее действие').closest('fieldset')?.disabled).toBe(true);
        fireEvent.submit(screen.getByLabelText('Следующее действие').closest('form')!);
        expect(createSalesTask).not.toHaveBeenCalled();
    });
    it('older history prepends by stable id and preserves the reading position', async () => {
        const latest = await vi.mocked(getClientWorkspace).getMockImplementation()!(7, 'card1');
        const message = (id: number, content: string) => ({ id, content, role: 'user', channel: 'whatsapp', timestamp: `2026-10-15T10:0${id}:00Z` });
        vi.mocked(getClientWorkspace).mockResolvedValueOnce({ ...latest, messages: [message(2, 'Новое сообщение')], messagePagination: { hasMore: true, nextCursor: 'opaque-cursor', total: 2, limit: 1 } });
        vi.mocked(getClientWorkspace).mockResolvedValueOnce({ ...latest, messages: [message(1, 'Старое сообщение'), message(2, 'Новое сообщение')], messagePagination: { hasMore: false, nextCursor: null, total: 2, limit: 1 } });
        show(); await screen.findByText('Новое сообщение');
        const history = screen.getByLabelText('История общения');
        Object.defineProperty(history, 'scrollHeight', { configurable: true, get: () => history.querySelectorAll('article').length * 120 }); history.scrollTop = 40;
        fireEvent.click(screen.getByRole('button', { name: 'Показать предыдущие сообщения' }));
        await screen.findByText('Старое сообщение');
        expect(getClientWorkspace).toHaveBeenLastCalledWith(7, 'card1', expect.any(AbortSignal), { before: 'opaque-cursor' });
        expect(screen.getAllByText('Новое сообщение')).toHaveLength(1);
        expect(Array.from(history.querySelectorAll('article p')).map(node => node.textContent)).toEqual(['Старое сообщение', 'Новое сообщение']);
        expect(history.scrollTop).toBe(160);
    });
    it('lead recovery requires an explicit checked outcome and never replays the reply', async () => {
        fixture.role = 'sales_lead'; fixture.capabilities.push('sales.assign'); fixture.sendInProgress = true;
        show(); await screen.findByLabelText('Как проверили результат');
        expect(resolveReplyRecovery).not.toHaveBeenCalled();
        fireEvent.change(screen.getByLabelText('Как проверили результат'), { target: { value: 'Проверил отправленные сообщения в канале' } });
        expect(screen.getByRole('button', { name: 'Подтвердить результат' }).hasAttribute('disabled')).toBe(true);
        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить результат' }));
        await waitFor(() => expect(resolveReplyRecovery).toHaveBeenCalledWith(7, 'card1', { actionId: 'original-action', outcome: 'sent', confirmation: true, reason: 'Проверил отправленные сообщения в канале' }, expect.any(AbortSignal)));
        expect(workspaceRequest).not.toHaveBeenCalled(); expect(getReplyRecovery).toHaveBeenCalled();
    });
    it('claiming an unassigned customer refreshes the open card immediately', async () => {
        fixture.assignee = null; show(); await screen.findByRole('heading', { name: 'Анна' });
        expect(screen.queryByLabelText('Ответ клиенту')).toBeNull();
        fireEvent.click(screen.getAllByRole('button', { name: 'Взять в работу' })[0]);
        await screen.findByLabelText('Ответ клиенту');
        expect(assignSalesClient).toHaveBeenCalledWith(7, 'card1', 'employee', expect.any(AbortSignal));
        expect(getClientWorkspace).toHaveBeenCalledTimes(2);
    });
    it('template links preview an editable reply and block unresolved substitutions', async () => {
        show('/today?client=card1&template=9'); await waitFor(() => expect(reply().value).toBe('Здравствуйте, {{имя}}!'));
        expect(screen.getByRole('button', { name: 'Отправить' }).hasAttribute('disabled')).toBe(true);
        expect(workspaceRequest).not.toHaveBeenCalled();
        fireEvent.change(reply(), { target: { value: 'Здравствуйте, Анна!' } });
        expect(screen.getByRole('button', { name: 'Отправить' }).hasAttribute('disabled')).toBe(false);
    });

    it('Studio handoff appends to the exact customer draft once, remains editable and never sends', async () => {
        sessionStorage.setItem('ava:reply:employee:7:card1', JSON.stringify({ text: 'Мой черновик', idempotencyKey: 'draft-key', state: 'draft' }));
        const view = show('/today?client=card1&material=deal1&materialRevision=2');
        await waitFor(() => expect(reply().value).toBe('Мой черновик\n\nСохранённый материал'));
        expect(getStudioHandoff).toHaveBeenCalledWith(7, 'deal1', 2, 'card1', expect.any(AbortSignal));
        fireEvent.change(reply(), { target: { value: 'Проверенный материал менеджера' } });
        view.unmount(); show('/today?client=card1&material=deal1&materialRevision=2');
        await waitFor(() => expect(getStudioHandoff).toHaveBeenCalledTimes(2));
        expect(reply().value).toBe('Проверенный материал менеджера');
        expect(workspaceRequest).not.toHaveBeenCalled();
    });
    it('Studio version conflict leaves the existing draft intact and offers local recovery', async () => {
        sessionStorage.setItem('ava:reply:employee:7:card1', JSON.stringify({ text: 'Сохранить мой текст', idempotencyKey: 'draft-key', state: 'draft' }));
        vi.mocked(getStudioHandoff).mockRejectedValueOnce({ response: { data: { code: 'STUDIO_MATERIAL_CONFLICT' } } });
        show('/today?client=card1&material=deal1&materialRevision=1');
        await screen.findByText(/Предложение не добавлено/);
        expect(reply().value).toBe('Сохранить мой текст');
        expect(screen.getByRole('button', { name: 'Повторить загрузку материала' })).toBeTruthy();
        expect(workspaceRequest).not.toHaveBeenCalled();
    });
    it('Studio insertion waits for live reply permission during revalidation', async () => {
        fixture.checking = true;
        const view = show('/today?client=card1&material=deal1&materialRevision=2');
        await waitFor(() => expect(getStudioHandoff).toHaveBeenCalled());
        expect(reply().value).toBe('');
        expect(screen.getByRole('button', { name: 'Отправить' }).hasAttribute('disabled')).toBe(true);
        fixture.checking = false;
        view.rerender(<MemoryRouter initialEntries={['/today?client=card1&material=deal1&materialRevision=2']}><TodayWorkspace /></MemoryRouter>);
        await waitFor(() => expect(reply().value).toBe('Сохранённый материал'));
        expect(workspaceRequest).not.toHaveBeenCalled();
    });
    it('renders failed WhatsApp media attachment state, opens preview and retries recognition without sending a reply', async () => {
        vi.mocked(getClientWorkspace).mockResolvedValueOnce({
            success: true, businessId: 7, dialogueRevision: 'r1', capabilities: fixture.capabilities,
            client: { chatId: 'card1', name: 'Анна', assigneeUserId: 'employee', status: 'new' },
            control: { mode: 'human', revision: 1, sendInProgress: false },
            messages: [{
                id: 42, role: 'user', content: '[Пользователь отправил медиафайл]', channel: 'whatsapp', timestamp: '2026-10-23T12:00:00Z',
                media: {
                    providerMessageId: 'wamid-42', messageId: 42, kind: 'image', status: 'failed',
                    errorCode: 'AI_TIMEOUT', downloaded: true, canRetry: true,
                    label: 'Вложение получено, но распознавание не завершилось',
                    detail: 'Модель не успела ответить вовремя. Нажмите «Повторить распознавание» или ответьте клиенту вручную.',
                    mediaUrl: '/api/businesses/7/workspace/clients/card1/messages/42/media',
                }
            }],
            calls: [], tasks: [], deals: [], promises: [],
            memory: { summary: null, keyFacts: [], objections: [], sourceUpdatedAt: null, sourceComplete: true }
        } as never);
        show('/today?client=card1');
        await screen.findByText('Вложение получено, но распознавание не завершилось');
        fireEvent.click(screen.getByRole('button', { name: 'Открыть изображение' }));
        expect(screen.getByRole('img', { name: 'Изображение от клиента' }).getAttribute('src')).toBe('/api/businesses/7/workspace/clients/card1/messages/42/media');
        fireEvent.click(screen.getByRole('button', { name: 'Повторить распознавание' }));
        await waitFor(() => expect(retryWorkspaceMedia).toHaveBeenCalledWith(7, 'card1', 42, expect.any(AbortSignal)));
        expect(workspaceRequest).not.toHaveBeenCalledWith(7, '/workspace/clients/card1/reply', expect.anything(), expect.anything(), expect.anything());
    });

});

describe('Workspace channel destination',()=>{
    afterEach(cleanup);
    it('requests an Avito queue from the server and offers all channels',async()=>{
        vi.clearAllMocks();clearWorkspaceDrafts();sessionStorage.clear();fixture.businessId=7;fixture.userId='employee';fixture.role='manager';fixture.enabled=false;fixture.capabilities=['business.read','sales.read'];
        show('/today?channel=avito');
        await screen.findByRole('heading',{name:'Диалоги Авито'});
        expect(getWorkday).toHaveBeenCalledWith(7,'mine',1,expect.any(AbortSignal),'avito');
        fireEvent.click(screen.getByRole('button',{name:'Все каналы'}));
        await waitFor(()=>expect(getWorkday).toHaveBeenLastCalledWith(7,'mine',1,expect.any(AbortSignal)));
        expect(screen.queryByText('Канал: Авито')).toBeNull();
    });
});
