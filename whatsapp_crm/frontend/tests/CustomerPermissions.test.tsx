// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Leads from '../src/pages/Leads';
import AllLeads from '../src/pages/AllLeads';
import Conversations from '../src/pages/Conversations';
import Deals from '../src/pages/Deals';
import CustomerFollowups from '../src/pages/CustomerFollowups';
import CustomerIdentities from '../src/pages/CustomerIdentities';
import CustomerCalls from '../src/pages/CustomerCalls';
import * as api from '../src/api';

const fixture = vi.hoisted(() => ({ capabilities: [] as string[], userId: 'manager-id' as string | null, role: 'observer', checking: false }));
vi.mock('../src/permissions', () => ({ useBusinessAccess: () => ({
  checking: fixture.checking, role: fixture.role, userId: fixture.userId, isPlatformAdmin: false,
  membership: { capabilities: fixture.capabilities },
  can: (capability: string) => fixture.capabilities.includes(capability),
}) }));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ role: fixture.role }) }));
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({
  currentInstanceId: 4, currentInstance: { id: 4, name: 'Бизнес' },
}) }));
vi.mock('../src/api', () => ({ getClients: vi.fn(), getTemplates: vi.fn(), getMessages: vi.fn(), getStatusHistory: vi.fn(),
  deleteLead: vi.fn(), updateClientStatus: vi.fn(), sendMessageToClient: vi.fn(), updateClientTags: vi.fn(), getAiSummary: vi.fn(), getAiNextStep: vi.fn(),
}));

const client = { assigneeUserId: 'manager-id', id: 1, instanceId: 4, chatId: 'client', senderName: 'Мария', leadStatus: 'new', tags: '["важный"]',
  channels: ['telegram'], lastMessage: 'Здравствуйте', lastMessageTime: '2026-10-02T10:00:00Z', createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-02T10:00:00Z' };
const deal = { id: 'deal', instanceId: 4, clientChatId: 'client', title: 'Заезд Марии', amount: 100, currency: 'RUB', stage: 'new',
  ownerName: 'Менеджер', nextAction: '', nextActionAt: null, notes: '', revision: 1, updatedAt: '2026-10-02T10:00:00Z' };
const response = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body });
function LocationProbe() { const location = useLocation(); return <output data-testid="route">{location.pathname}{location.search}</output>; }
const router = (element: React.ReactNode, route = '/clients?view=all&mine=0') => <MemoryRouter initialEntries={[route]}>{element}<LocationProbe /></MemoryRouter>;
const draft = (assignment: string | null | undefined, status = 'draft') => ({ draft_id: 'draft', text: 'Сообщение после звонка', status,
  ...(assignment !== undefined ? { assigneeUserId: assignment } : {}) });
const manager = () => { fixture.role = 'manager'; fixture.capabilities = ['sales.write', 'messages.send', 'tasks.claim', 'ai.use']; };
const followupsFetch = (item: ReturnType<typeof draft>) => vi.fn((url: string, options?: RequestInit) => {
  if (url.endsWith('followup-drafts')) return response({ success: true, drafts: [item] });
  if (url.endsWith('followup-channels')) return response({ success: true, channels: [{ channel: 'telegram', recipient: '42', label: 'Telegram' }] });
  if (options?.method === 'PATCH') return response({ success: true });
  return response({ success: true, draft: { ...item, assigneeUserId: 'manager-id' } });
});

beforeEach(() => {
  fixture.checking = false; fixture.role = 'observer'; fixture.userId = 'manager-id'; fixture.capabilities = ['business.read', 'sales.read', 'team.read'];
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.clearAllMocks(); window.history.replaceState({}, '', '/');
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(api.getClients).mockResolvedValue({ success: true, clients: [client] });
  vi.mocked(api.getTemplates).mockResolvedValue({ success: true, templates: [{ id: 1, instanceId: 4, label: 'Приветствие', text: 'Привет' }] });
  vi.mocked(api.getMessages).mockResolvedValue({ success: true, messages: [{ id: 1, content: 'Здравствуйте', timestamp: client.lastMessageTime, role: 'user', channel: 'telegram' }] });
  vi.mocked(api.getStatusHistory).mockResolvedValue({ success: true, history: [] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('customer capability visibility', () => {
  it('keeps observer kanban readable with no draggable cards, tag editing, paid AI or sends', async () => {
    render(router(<Leads />));
    await screen.findByText('Мария');
    expect(document.querySelector('[draggable="true"]')).toBeNull();
    expect(screen.queryByPlaceholderText('+ тег...')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Резюме' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Приветствие' })).toBeNull();
    fireEvent.click(screen.getAllByText('#важный').find(element => element.tagName === 'SPAN')!);
    expect(api.updateClientTags).not.toHaveBeenCalled();
    expect(screen.getByTitle('Профиль клиента').getAttribute('href')).toBe('/customers/client');
  });
  it('shows observer customer statuses as text and removes bulk operations and expanded mutation controls', async () => {
    render(router(<AllLeads />));
    await screen.findByText('Мария');
    expect(screen.queryByRole('combobox', { name: /Статус клиента/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Выбрать всех клиентов на странице' })).toBeNull();
    fireEvent.click(screen.getByTitle('Подробнее'));
    expect(screen.queryByPlaceholderText('+ тег')).toBeNull();
    expect(screen.queryByRole('button', { name: 'AI Резюме' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Приветствие' })).toBeNull();
    expect(api.getAiSummary).not.toHaveBeenCalled();
  });
  it('keeps an observer transcript visible and omits the send composer and AI action panel', async () => {
    window.history.replaceState({}, '', '/conversations?chat=client');
    render(router(<Conversations />, '/conversations?chat=client'));
    await waitFor(() => expect(api.getMessages).toHaveBeenCalled());
    expect(await screen.findByRole('log')).toHaveProperty('textContent', expect.stringContaining('Здравствуйте'));
    expect(screen.queryByLabelText('Ваш ответ')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Отправить' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Подсказки по диалогу' })).toBeNull();
    expect(api.getTemplates).not.toHaveBeenCalled();
  });
  it('keeps observer deals readable without creation, editing, deletion or paid proposal actions', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => response(url.includes('/deals/')
      ? { success: true, business_id: 4, deals: [deal], totals: [] } : { success: true, clients: [client] })));
    render(router(<Deals />)); await screen.findByText('Заезд Марии');
    expect(screen.queryByRole('button', { name: 'Новая сделка' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Изменить сделку/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Удалить сделку/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Подготовить предложение' })).toBeNull();
  });
  it('allows the sales lead to edit deals using capabilities', async () => {
    fixture.role = 'sales_lead'; fixture.capabilities = ['sales.write'];
    vi.stubGlobal('fetch', vi.fn((url: string) => response(url.includes('/deals/')
      ? { success: true, business_id: 4, deals: [deal], totals: [] } : { success: true, clients: [client] })));
    render(router(<Deals />)); await screen.findByText('Заезд Марии');
    expect(screen.getByRole('button', { name: 'Новая сделка' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Изменить сделку Заезд Марии' }));
    expect(screen.getByLabelText('Название сделки *')).toHaveProperty('value', 'Заезд Марии');
  });
  it('shows linked contacts to an observer without linking, merging or unlinking controls', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response({ success: true, aliases: [{ id: 4, kind: 'telegram', value: '42' }], clients: [] })));
    render(<CustomerIdentities instanceId={4} chatId="client" onLinked={() => {}} />);
    await screen.findByText('Telegram · Связан');
    expect(screen.queryByText('Отвязать')).toBeNull(); expect(screen.queryByLabelText('Канал')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Привязать контакт' })).toBeNull();
  });
  it.each([['other', 'другому менеджеру'], [undefined, 'неизвестно'], ['manager-id', 'наблюдателю'], [null, 'без ответственного']])(
    'omits observer followup mutations for assignment %s (%s)', async assignment => {
      const fetch = followupsFetch(draft(assignment)); vi.stubGlobal('fetch', fetch);
      render(<CustomerFollowups instanceId={4} chatId="client" />); await screen.findByText('Сообщение после звонка');
      expect(screen.queryByText('Открыть задачу')).toBeNull(); expect(screen.queryByText('Взять задачу')).toBeNull();
      expect(fetch.mock.calls.filter(call => call[1]?.method)).toHaveLength(0);
    });
  it.each([['other', 'чужое назначение'], [undefined, 'нет точного назначения']])(
    'fails closed for a manager followup with %s (%s)', async assignment => {
      manager(); const fetch = followupsFetch(draft(assignment)); vi.stubGlobal('fetch', fetch);
      render(<CustomerFollowups instanceId={4} chatId="client" />); await screen.findByText('Сообщение после звонка');
      expect(screen.queryByText('Открыть задачу')).toBeNull(); expect(screen.queryByText('Взять задачу')).toBeNull();
      expect(fetch.mock.calls.filter(call => call[1]?.method)).toHaveLength(0);
    });
  it('opens a manager own assignment without claiming it again', async () => {
    manager(); const fetch = followupsFetch(draft('manager-id')); vi.stubGlobal('fetch', fetch);
    render(<CustomerFollowups instanceId={4} chatId="client" />);
    fireEvent.click(await screen.findByText('Открыть задачу')); await screen.findByLabelText('Сообщение клиенту');
    expect(fetch.mock.calls.filter(call => call[1]?.method)).toHaveLength(0);
    expect(screen.getByText('Отправить клиенту')).toBeTruthy();
  });
  it('claims a proven unassigned followup atomically before editing', async () => {
    manager(); const fetch = followupsFetch(draft(null)); vi.stubGlobal('fetch', fetch);
    render(<CustomerFollowups instanceId={4} chatId="client" />);
    fireEvent.click(await screen.findByText('Взять задачу')); await screen.findByLabelText('Сообщение клиенту');
    expect(fetch.mock.calls.filter(call => call[1]?.method).map(call => call[1]?.method)).toEqual(['POST']);
  });
  it.each(['pending', 'sent', 'sending', 'unknown', 'unknown_pending', 'delivery_pending', 'rejected', 'unconfirmed'])('does not reopen a %s followup even when assigned to the manager', async status => {
    manager(); vi.stubGlobal('fetch', followupsFetch(draft('manager-id', status)));
    render(<CustomerFollowups instanceId={4} chatId="client" />); await screen.findByText('Сообщение после звонка');
    expect(screen.queryByText('Открыть задачу')).toBeNull();
  });
  it('closes the open editor immediately when capabilities are revoked', async () => {
    manager(); const fetch = followupsFetch(draft('manager-id')); vi.stubGlobal('fetch', fetch);
    const view = render(<CustomerFollowups instanceId={4} chatId="client" />);
    fireEvent.click(await screen.findByText('Открыть задачу')); await screen.findByLabelText('Сообщение клиенту');
    fixture.capabilities = ['sales.read']; view.rerender(<CustomerFollowups instanceId={4} chatId="client" />);
    expect(screen.queryByLabelText('Сообщение клиенту')).toBeNull();
    expect(fetch.mock.calls.filter(call => call[1]?.method)).toHaveLength(0);
  });
  it('blocks sending if assignment changes in save readback', async () => {
    manager(); let reads = 0;
    const fetch = vi.fn((url: string, _options?: RequestInit) => {
      if (url.endsWith('followup-drafts')) return response({ success: true, drafts: [draft(++reads === 1 ? 'manager-id' : 'other')] });
      if (url.endsWith('followup-channels')) return response({ success: true, channels: [{ channel: 'telegram', recipient: '42', label: 'Telegram' }] });
      return response({ success: true });
    }); vi.stubGlobal('fetch', fetch);
    render(<CustomerFollowups instanceId={4} chatId="client" />);
    fireEvent.click(await screen.findByText('Открыть задачу')); await screen.findByLabelText('Сообщение клиенту');
    fireEvent.change(screen.getByLabelText('Связанный канал'), { target: { value: '0' } });
    fireEvent.click(screen.getByText('Отправить клиенту'));
    fireEvent.click(screen.getByLabelText('Я проверил адресата и текст сообщения'));
    fireEvent.click(screen.getByText('Подтвердить отправку')); await screen.findByRole('alert');
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0);
    expect(screen.queryByLabelText('Сообщение клиенту')).toBeNull();
  });

  it.each(['hotel_owner', 'sales_lead'])('allows %s to review a followup assigned to another teammate', async role => {
    fixture.role = role; fixture.capabilities = ['sales.write', 'messages.send', 'tasks.manage'];
    const fetch = followupsFetch(draft('other')); vi.stubGlobal('fetch', fetch);
    render(<CustomerFollowups instanceId={4} chatId="client" />);
    fireEvent.click(await screen.findByText('Открыть задачу')); await screen.findByLabelText('Сообщение клиенту');
    expect(screen.getByText('Отправить клиенту')).toBeTruthy();
    expect(fetch.mock.calls.filter(call => call[1]?.method)).toHaveLength(0);
  });
  it('fails closed when the exact manager session identity is unavailable', async () => {
    manager(); fixture.userId = null; vi.stubGlobal('fetch', followupsFetch(draft('manager-id')));
    render(<CustomerFollowups instanceId={4} chatId="client" />); await screen.findByText('Сообщение после звонка');
    expect(screen.queryByText('Открыть задачу')).toBeNull();
  });
  it('shows unavailable kanban counts after a source failure and real zero only after a successful empty read', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(api.getClients).mockRejectedValueOnce(new Error('source offline'));
    render(router(<Leads />)); await screen.findByRole('alert');
    const counts = () => [...document.querySelectorAll('[aria-label="Показатели воронки"] strong')].map(element => element.textContent);
    expect(counts()).toEqual(['—', '—', '—']);
    vi.mocked(api.getClients).mockResolvedValue({ success: true, clients: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(counts()).toEqual(['0', '0', '0'])); log.mockRestore();
  });
  it('does not present table source failure as an empty customer list', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(api.getClients).mockResolvedValue({ success: false });
    render(router(<AllLeads />)); await screen.findByRole('alert');
    expect(screen.getByText('Всего:').nextElementSibling?.textContent).toBe('—');
    expect(screen.queryByText('Нет лидов')).toBeNull(); log.mockRestore();
  });
  it('requires review when persisted text differs from the requested message and makes no send request', async () => {
    manager(); const fetch = followupsFetch(draft('manager-id')); vi.stubGlobal('fetch', fetch);
    render(<CustomerFollowups instanceId={4} chatId="client" />);
    fireEvent.click(await screen.findByText('Открыть задачу')); await screen.findByLabelText('Сообщение клиенту');
    fireEvent.change(screen.getByLabelText('Сообщение клиенту'), { target: { value: 'Изменённое сообщение' } });
    fireEvent.change(screen.getByLabelText('Связанный канал'), { target: { value: '0' } });
    fireEvent.click(screen.getByText('Отправить клиенту'));
    fireEvent.click(screen.getByLabelText('Я проверил адресата и текст сообщения'));
    fireEvent.click(screen.getByText('Подтвердить отправку')); await screen.findByRole('alert');
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0);
    expect(screen.getByLabelText('Сообщение клиенту')).toHaveProperty('value', 'Сообщение после звонка');
  });
  it.each(['revocation', 'unmount'])('does not continue an in-flight save with a send after %s', async interruption => {
    manager(); let finishSave!: (value: unknown) => void;
    const saveResponse = new Promise(resolve => { finishSave = resolve; });
    const fetch = vi.fn((url: string, options?: RequestInit) => {
      if (options?.method === 'PATCH') return saveResponse;
      if (url.endsWith('followup-drafts')) return response({ success: true, drafts: [draft('manager-id')] });
      if (url.endsWith('followup-channels')) return response({ success: true, channels: [{ channel: 'telegram', recipient: '42', label: 'Telegram' }] });
      return response({ success: true });
    }); vi.stubGlobal('fetch', fetch);
    const view = render(<CustomerFollowups instanceId={4} chatId="client" />);
    fireEvent.click(await screen.findByText('Открыть задачу')); await screen.findByLabelText('Сообщение клиенту');
    fireEvent.change(screen.getByLabelText('Связанный канал'), { target: { value: '0' } });
    fireEvent.click(screen.getByText('Отправить клиенту'));
    fireEvent.click(screen.getByLabelText('Я проверил адресата и текст сообщения'));
    fireEvent.click(screen.getByText('Подтвердить отправку'));
    await waitFor(() => expect(fetch.mock.calls.some(call => call[1]?.method === 'PATCH')).toBe(true));
    if (interruption === 'unmount') view.unmount();
    else { fixture.capabilities = ['sales.read']; view.rerender(<CustomerFollowups instanceId={4} chatId="client" />); }
    await act(async () => { finishSave({ ok: true, status: 200, json: async () => ({ success: true }) }); });
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0);
  });
  it('requests immediate authentication refresh when a raw card read returns revoked access', async () => {
    const handler = vi.fn(); window.addEventListener('crm:forbidden', handler);
    vi.stubGlobal('fetch', vi.fn(() => response({ success: false }, 403)));
    render(<CustomerCalls instanceId={4} chatId="client" />); await screen.findByRole('alert');
    expect(handler).toHaveBeenCalledTimes(1); window.removeEventListener('crm:forbidden', handler);
  });

  it('focuses a linked followup without claiming it or opening an editor', async () => {
    manager();
    const fetch = vi.fn((url: string) => response(url.includes('/followup-drafts')
      ? { success: true, drafts: [draft('manager-id')] } : { success: true, channels: [] }));
    vi.stubGlobal('fetch', fetch);
    render(<CustomerFollowups instanceId={4} chatId="client" requestedDraftId="draft" />);
    const requested = await screen.findByLabelText('Задача по открытой ссылке');
    await waitFor(() => expect(document.activeElement).toBe(requested));
    expect(screen.queryByLabelText('Сообщение клиенту')).toBeNull();
    expect(fetch.mock.calls.some(call => call[0].endsWith('followup-drafts?limit=100'))).toBe(true);
    expect(fetch.mock.calls).toHaveLength(2);
  });
  it('clearly reports a linked followup outside the bounded list and makes no mutation', async () => {
    const fetch = vi.fn((url: string) => response(url.includes('/followup-drafts')
      ? { success: true, drafts: [draft('other')] } : { success: true, channels: [] }));
    vi.stubGlobal('fetch', fetch);
    render(<CustomerFollowups instanceId={4} chatId="client" requestedDraftId="missing" />);
    await screen.findByText('Задача по ссылке не найдена в текущем списке. Здесь показываем до 100 последних задач клиента.');
    expect(screen.queryByLabelText('Задача по открытой ссылке')).toBeNull();
    expect(fetch.mock.calls).toHaveLength(2);
  });

  it('does not offer claiming an unassigned followup when session user identity is missing', async () => {
    manager(); fixture.userId = null; const fetch = followupsFetch(draft(null)); vi.stubGlobal('fetch', fetch);
    render(<CustomerFollowups instanceId={4} chatId="client" />); await screen.findByText('Сообщение после звонка');
    expect(screen.queryByText('Взять задачу')).toBeNull();
    expect(fetch.mock.calls.filter(call => call[1]?.method)).toHaveLength(0);
  });

  it.each([null, 'other', undefined])('keeps a manager customer kanban readonly until exact client assignment (%s)', async assigneeUserId => {
    manager(); vi.mocked(api.getClients).mockResolvedValue({ success: true, clients: [{ ...client, assigneeUserId }] });
    render(router(<Leads />)); await screen.findByText('Мария');
    expect(document.querySelector('[draggable="true"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Резюме' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Приветствие' })).toBeNull();
    expect(screen.queryByPlaceholderText('+ тег...')).toBeNull();
    expect(screen.getByRole('link', { name: 'Открыть рабочее пространство' }).getAttribute('href')).toBe('/sales?view=queue');
  });
  it('opens the editable reply for the exactly assigned client without sending, and preserves context/tag actions', async () => {
    manager(); vi.mocked(api.sendMessageToClient).mockResolvedValue({ success: true });
    vi.mocked(api.getAiSummary).mockResolvedValue({ success: true, summary: 'Подтверждённое назначение' });
    vi.mocked(api.updateClientTags).mockResolvedValue({ success: true });
    render(router(<Leads />)); await screen.findByText('Мария');
    expect(document.querySelector('[draggable="true"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Приветствие' }));
    expect(api.sendMessageToClient).not.toHaveBeenCalled();
    expect(screen.getByTestId('route').textContent).toBe('/today?client=client&template=1');
    fireEvent.click(screen.getByRole('button', { name: 'Резюме' }));
    await waitFor(() => expect(api.getAiSummary).toHaveBeenCalledWith(4, 'client'));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Удалить метку важный' }), { key: 'Enter' });
    await waitFor(() => expect(api.updateClientTags).toHaveBeenCalledWith(4, 'client', []));
  });
  it.each([null, 'other', undefined])('hides manager table mutations for canonical client assignment %s', async assigneeUserId => {
    manager(); vi.mocked(api.getClients).mockResolvedValue({ success: true, clients: [{ ...client, assigneeUserId }] });
    render(router(<AllLeads />)); await screen.findByText('Мария');
    expect(screen.queryByRole('combobox', { name: /Статус клиента/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Выбрать всех клиентов на странице' })).toBeNull();
    fireEvent.click(screen.getByTitle('Подробнее'));
    expect(screen.queryByRole('button', { name: 'Приветствие' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'AI Резюме' })).toBeNull();
    expect(screen.queryByPlaceholderText('+ тег')).toBeNull();
  });
  it('limits bulk manager actions to exact own canonical assignments in a mixed business-wide read', async () => {
    manager(); vi.mocked(api.updateClientStatus).mockResolvedValue({ success: true });
    vi.mocked(api.getClients).mockResolvedValue({ success: true, clients: [client, { ...client, id: 2, chatId: 'other-client', senderName: 'Алия', assigneeUserId: 'other' }] });
    render(router(<AllLeads />)); await screen.findByText('Мария');
    expect(screen.getByText('Алия')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать всех клиентов на странице' }));
    expect(screen.getByText('Выбрано: 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Действия/ }));
    const menu = screen.getByText('Сменить статус').parentElement!;
    fireEvent.click(menu.querySelector('button')!);
    await waitFor(() => expect(api.updateClientStatus).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateClientStatus).mock.calls[0].slice(0, 2)).toEqual([4, 'client']);
  });
  it('keeps a manager unassigned conversation readable and requires claiming the canonical client before sending or AI', async () => {
    manager(); vi.mocked(api.getClients).mockResolvedValue({ success: true, clients: [{ ...client, assigneeUserId: null }] });
    window.history.replaceState({}, '', '/conversations?chat=client'); render(router(<Conversations />, '/conversations?chat=client'));
    await waitFor(() => expect(api.getMessages).toHaveBeenCalled());
    expect(screen.queryByLabelText('Ваш ответ')).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Подсказки по диалогу' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Открыть рабочее пространство' })).toBeTruthy();
  });
  it('opens the manager composer for the exact own canonical client', async () => {
    manager(); window.history.replaceState({}, '', '/conversations?chat=client'); render(router(<Conversations />, '/conversations?chat=client'));
    expect(await screen.findByLabelText('Ваш ответ')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeTruthy();
  });
  it.each([null, 'other', undefined])('keeps manager identity linking readonly for canonical client assignment %s', async assigneeUserId => {
    manager(); vi.stubGlobal('fetch', vi.fn(() => response({ success: true, aliases: [{ id: 1, kind: 'telegram', value: '42' }], clients: [] })));
    render(<CustomerIdentities instanceId={4} chatId="client" assigneeUserId={assigneeUserId} onLinked={() => {}} />);
    await screen.findByText('Telegram · Связан');
    expect(screen.queryByText('Отвязать')).toBeNull(); expect(screen.queryByLabelText('Канал')).toBeNull();
  });
  it('gates manager deal mutations by linked client assignment or exact unlinked creator', async () => {
    manager(); const rows = [
      { ...deal, id: 'own', title: 'Моя связанная сделка' },
      { ...deal, id: 'foreign', clientChatId: 'foreign-client', title: 'Чужая связанная сделка' },
      { ...deal, id: 'self-created', clientChatId: null, createdBy: 'manager-id', title: 'Моя самостоятельная сделка' },
      { ...deal, id: 'legacy', clientChatId: null, createdBy: null, title: 'Старая сделка без автора' },
      { ...deal, id: 'foreign-created', clientChatId: null, createdBy: 'other', title: 'Чужая самостоятельная сделка' },
    ];
    vi.stubGlobal('fetch', vi.fn((url: string) => response(url.includes('/deals/')
      ? { success: true, business_id: 4, deals: rows, totals: [] } : { success: true, clients: [client, { ...client, chatId: 'foreign-client', senderName: 'Алия', assigneeUserId: 'other' }] })));
    render(router(<Deals />)); await screen.findByText('Моя связанная сделка');
    expect(screen.getByRole('button', { name: 'Изменить сделку Моя связанная сделка' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Изменить сделку Моя самостоятельная сделка' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Изменить сделку Чужая связанная сделка' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Изменить сделку Старая сделка без автора' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Удалить сделку Чужая самостоятельная сделка' })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Подготовить предложение' })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Новая сделка' }));
    const selector = screen.getByLabelText('Клиент') as HTMLSelectElement;
    expect([...selector.options].map(option => option.textContent)).toEqual(['Без клиента', 'Мария']);
  });
  it('preserves an open followup draft while access is being rechecked and blocks actions until the check completes', async () => {
    manager(); vi.stubGlobal('fetch', followupsFetch(draft('manager-id')));
    const view = render(<CustomerFollowups instanceId={4} chatId="client" />);
    fireEvent.click(await screen.findByText('Открыть задачу')); await screen.findByLabelText('Сообщение клиенту');
    fireEvent.change(screen.getByLabelText('Сообщение клиенту'), { target: { value: 'Текст до проверки доступа' } });
    fixture.checking = true; fixture.capabilities = []; view.rerender(<CustomerFollowups instanceId={4} chatId="client" />);
    expect(screen.queryByLabelText('Сообщение клиенту')).toBeNull();
    fixture.checking = false; manager(); view.rerender(<CustomerFollowups instanceId={4} chatId="client" />);
    expect(screen.getByLabelText('Сообщение клиенту')).toHaveProperty('value', 'Текст до проверки доступа');
  });
});

describe('customer tag editing', () => {
  it('ignores an existing tag when entered again in the client table', async () => {
    manager();
    render(router(<AllLeads />));
    fireEvent.click(await screen.findByRole('button', { name: 'Подробнее' }));
    const input = screen.getByLabelText('Добавить тег клиенту');
    fireEvent.change(input, { target: { value: 'важный' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.updateClientTags).not.toHaveBeenCalled();
    expect(input).toHaveProperty('value', '');
  });
});
