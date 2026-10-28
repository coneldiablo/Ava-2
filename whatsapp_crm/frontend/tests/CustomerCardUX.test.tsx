// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CustomerIntelligence from '../src/pages/CustomerIntelligence';
import CustomerFollowups from '../src/pages/CustomerFollowups';

const access = vi.hoisted(() => ({ role: 'manager', userId: 'staff', capabilities: ['sales.write', 'messages.send', 'tasks.claim'] }));
vi.mock('../src/permissions', () => ({ useBusinessAccess: () => ({ ...access, checking: false, membership: { capabilities: access.capabilities }, can: (capability: string) => access.capabilities.includes(capability) }) }));
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: 4, currentInstance: { id: 4 } }) }));
const response = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body });
const draft = { draft_id: 'prepared', text: 'Согласовать доставку', status: 'draft', assigneeUserId: 'staff', manager_task_id: 'task', channel: 'telegram', recipient: '42' };
const snapshot = () => ({ success: true, canonicalChatId: 'client', client: { id: 1, instanceId: 4, chatId: 'client', senderName: 'Клиент', tags: [], leadStatus: 'new' },
  messages: [{ id: 2, content: 'Новое сообщение', role: 'user', timestamp: '2026-10-15T11:00:00Z', channel: 'telegram' }], statusHistory: [], messageCount: 2, messagesTruncated: true,
  messagePagination: { hasMore: true, nextCursor: 'opaque/cursor', total: 2, limit: 30 }, customerMemory: { lastCallSummary: 'Старый итог', lastCallAt: '2026-10-01T10:00:00Z', interests: [], objections: [], importantDates: [], keyFacts: [] },
  generatedMemory: { conversation: { status: 'generation_pending' }, call: { status: 'ai_summary', summary: 'Свежая договорённость о доставке', sourceUpdatedAt: '2026-10-15T10:00:00Z', interests: [], objections: [], importantDates: [], sourceComplete: true } },
});
const card = () => render(<MemoryRouter initialEntries={['/customers/client']}><Routes><Route path="/customers/:chatId" element={<CustomerIntelligence />} /></Routes></MemoryRouter>);
function childResponse(url: string) {
  if (url.includes('followup-drafts')) return response({ success: true, drafts: [draft] });
  if (url.includes('followup-channels')) return response({ success: true, channels: [{ channel: 'telegram', recipient: '42', label: 'Telegram' }] });
  if (url.includes('/calls')) return response({ success: true, instanceId: 4, calls: [], nextPage: null, sourceComplete: true });
  return response({ success: true, aliases: [], clients: [] });
}
beforeEach(() => {
  access.role = 'manager'; access.userId = 'staff'; access.capabilities = ['sales.write', 'messages.send', 'tasks.claim'];
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('customer card working context', () => {
  it('uses the fresh ready summary and preserves the open editor during refresh failure', async () => {
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => url.startsWith('/api/customer-intelligence') ? ++reads === 1 ? response(snapshot()) : response({ success: false }, 503) : childResponse(url)));
    card();
    const context = await screen.findByRole('region', { name: 'Что происходит с клиентом' });
    expect(within(context).getByText('Свежая договорённость о доставке')).toBeTruthy();
    expect(within(context).queryByText('Старый итог')).toBeNull();
    fireEvent.click(await screen.findByText('Открыть задачу'));
    fireEvent.change(screen.getByLabelText('Сообщение клиенту'), { target: { value: 'Незавершённый ответ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Обновить', exact: true }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('Сообщение клиенту')).toHaveProperty('value', 'Незавершённый ответ');
    expect(screen.getByText(/Показаны ранее загруженные сведения/)).toBeTruthy();
  });
  it('merges a scoped older page by stable message id without duplicating current messages', async () => {
    const fetch = vi.fn((url: string) => url.startsWith('/api/customer-intelligence') ? response(url.includes('before=') ? { ...snapshot(), messages: [...snapshot().messages, { id: 1, content: 'Ранняя договорённость', role: 'user', timestamp: '2026-10-01T10:00:00Z' }], messagePagination: { hasMore: false, nextCursor: null, total: 2, limit: 30 } } : snapshot()) : childResponse(url));
    vi.stubGlobal('fetch', fetch); card();
    fireEvent.click(await screen.findByText('Показать предыдущие сообщения'));
    await screen.findByText('Ранняя договорённость');
    expect(screen.getAllByText('Новое сообщение')).toHaveLength(1);
    expect(fetch.mock.calls.some(([url]) => url.endsWith('?before=opaque%2Fcursor&messageLimit=30'))).toBe(true);
  });
  it('rejects a history page for a different customer and keeps the loaded history', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => url.startsWith('/api/customer-intelligence') ? response(url.includes('before=') ? { ...snapshot(), client: { ...snapshot().client, chatId: 'foreign' }, messages: [{ id: 99, content: 'Чужая история' }] } : snapshot()) : childResponse(url)));
    card(); fireEvent.click(await screen.findByText('Показать предыдущие сообщения'));
    await screen.findByRole('alert');
    expect(screen.queryByText('Чужая история')).toBeNull();
    expect(screen.getByText('Новое сообщение')).toBeTruthy();
  });
});

describe('followup review and assignment', () => {
  it('invalidates confirmation when text changes and requires checking the saved recipient', async () => {
    const fetch = vi.fn((url: string, options?: RequestInit) => options?.method === 'PATCH' ? response({ success: true }) : url.includes('followup-drafts') ? response({ success: true, drafts: [{ ...draft, recipient: 'different' }] }) : childResponse(url));
    vi.stubGlobal('fetch', fetch); render(<CustomerFollowups instanceId={4} chatId="client" />);
    fireEvent.click(await screen.findByText('Открыть задачу'));
    fireEvent.change(screen.getByLabelText('Связанный канал'), { target: { value: '0' } });
    fireEvent.click(screen.getByText('Отправить клиенту'));
    fireEvent.click(screen.getByLabelText('Я проверил адресата и текст сообщения'));
    fireEvent.change(screen.getByLabelText('Сообщение клиенту'), { target: { value: 'Проверка изменилась' } });
    expect(screen.queryByText('Подтвердить отправку')).toBeNull();
    fireEvent.change(screen.getByLabelText('Сообщение клиенту'), { target: { value: draft.text } });
    fireEvent.click(screen.getByText('Отправить клиенту'));
    fireEvent.click(screen.getByLabelText('Я проверил адресата и текст сообщения'));
    fireEvent.click(screen.getByText('Подтвердить отправку'));
    await screen.findByText('Сохранённый адресат отличается. Проверьте канал перед отправкой.');
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  });
  it('shows assignment success only after the exact assignee is read back', async () => {
    access.role = 'sales_lead'; access.capabilities = ['sales.write', 'messages.send', 'tasks.manage', 'sales.assign'];
    let assigned = false;
    const fetch = vi.fn((url: string, options?: RequestInit) => {
      if (url.includes('/sales-workspace?')) return response({ success: true, businessId: 4, members: [{ userId: 'colleague', displayName: 'Сотрудник' }] });
      if (options?.method === 'PATCH') { assigned = true; return response({ success: true, businessId: 4 }); }
      if (url.includes('followup-drafts')) return response({ success: true, drafts: [{ ...draft, assigneeUserId: assigned ? 'colleague' : 'staff' }] });
      return childResponse(url);
    });
    vi.stubGlobal('fetch', fetch); render(<CustomerFollowups instanceId={4} chatId="client" />);
    await screen.findByRole('option', { name: 'Сотрудник' });
    fireEvent.change(screen.getByLabelText('Назначить сотруднику'), { target: { value: 'colleague' } });
    fireEvent.click(screen.getByRole('button', { name: 'Назначить', exact: true }));
    await screen.findByText('Ответственный назначен. Задача доступна сотруднику в рабочем дне.');
    expect(fetch.mock.calls.some(([url, options]) => url.endsWith('/sales-workspace/tasks/task') && options?.body === JSON.stringify({ assigneeUserId: 'colleague' }))).toBe(true);
    expect(screen.getByText('Ответственный: Сотрудник')).toBeTruthy();
  });
  it('keeps an uncertain send visible after automatic status refresh and never calls it sent', async () => {
    const fetch = vi.fn((url: string, options?: RequestInit) => {
      if (url.endsWith('/send')) return Promise.reject(new TypeError('Failed to fetch'));
      if (options?.method === 'PATCH') return response({ success: true });
      return childResponse(url);
    });
    vi.stubGlobal('fetch', fetch); render(<CustomerFollowups instanceId={4} chatId="client" />);
    fireEvent.click(await screen.findByText('Открыть задачу'));
    fireEvent.click(screen.getByText('Отправить клиенту'));
    fireEvent.click(screen.getByLabelText('Я проверил адресата и текст сообщения'));
    fireEvent.click(screen.getByText('Подтвердить отправку'));
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url.includes('followup-drafts')).length).toBeGreaterThan(2));
    expect(screen.getByText('Результат отправки пока не установлен. Обновите задачи перед следующим действием; повторная отправка заблокирована до проверки.')).toBeTruthy();
    expect(screen.queryByText('Сообщение отправлено.')).toBeNull();
    expect(screen.queryByText('Failed to fetch')).toBeNull();
  });
});
