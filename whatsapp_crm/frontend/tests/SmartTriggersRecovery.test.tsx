// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SmartTriggers from '../src/pages/SmartTriggers';

const state = vi.hoisted(() => ({ businessId: 7, read: vi.fn(), update: vi.fn() }));
const trigger = { id: 1, instanceId: 7, name: 'Уточнить запрос', isActive: 1, triggerType: 'keyword', conditions: '{"keywords":["цена"]}', actionType: 'send_message', actionData: '{"message":"Здравствуйте"}', priority: 0, maxExecutions: 0, cooldownMinutes: 60, createdAt: '2026-10-15' };
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: state.businessId, currentInstance: { businessType: 'standard' } }) }));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ userId: 'owner', role: 'customer', memberships: [{ businessId: state.businessId, role: 'hotel_owner' }] }) }));
vi.mock('../src/api', async original => ({ ...await original<typeof import('../src/api')>(), getTriggers: state.read, updateTrigger: state.update, getSequences: vi.fn(async () => ({ success: true, sequences: [] })), getTriggerLog: vi.fn(async () => ({ success: true, log: [] })), getTriggerSettings: vi.fn(async () => ({ success: true, smartTriggersEnabled: true })) }));
beforeEach(() => { state.businessId = 7; state.read.mockReset().mockResolvedValue({ success: true, triggers: [trigger] }); state.update.mockReset(); });
afterEach(cleanup);

it('keeps the last state and offers local recovery when a rule switch fails', async () => {
    state.update.mockRejectedValue(new Error('offline'));
    render(<SmartTriggers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Выключить триггер Уточнить запрос' }));
    await screen.findByText('Не удалось изменить сценарий. Проверьте состояние перед повторной попыткой.');
    expect(screen.getByRole('button', { name: 'Выключить триггер Уточнить запрос' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Обновить сценарии' }));
    await waitFor(() => expect(state.read).toHaveBeenCalledTimes(2));
});

it('masks the previous business rules immediately while the new scope loads', async () => {
    const view = render(<SmartTriggers />);
    await screen.findByText('Уточнить запрос');
    state.read.mockImplementation(() => new Promise(() => {}));
    state.businessId = 8;
    view.rerender(<SmartTriggers />);
    expect(screen.queryByText('Уточнить запрос')).toBeNull();
});
