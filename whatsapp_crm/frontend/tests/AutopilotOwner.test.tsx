// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Autopilot from '../src/pages/Autopilot';

const mocks = vi.hoisted(() => ({ get: vi.fn(), request: vi.fn() }));
const policy = { id: 'p', revision: 1, state: 'draft', enabled: false, scenarioIds: ['qualification'], allowedActions: ['reply', 'handoff'], dailyMessageLimit: 100, dailyTokenLimit: 100000, dailyVoiceSecondsLimit: 7200, responseDeadlineMinutes: 30, workDays: [1, 2, 3, 4, 5, 6, 7], timezone: 'Europe/Moscow', workHours: { start: '00:00', end: '00:00' }, routing: { enabled: false, memberIds: [] } };
const response = { success: true, businessId: 7, policy, capabilities: ['business.manage'], templates: [{ id: 'qualification', name: 'Уточнить запрос', description: 'Помощь клиенту' }], actions: [], usage: { requests: 0, tokens: null, voiceSeconds: null, estimatedCost: null, currency: 'RUB', actions: 0, handovers: 0, periodStart: '2026-10-15' } };
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: 7 }) }));
vi.mock('../src/permissions', () => ({ useBusinessAccess: () => ({ role: 'hotel_owner', userId: 'owner', can: () => true }) }));
vi.mock('../src/api', () => ({ getChannelStatus: vi.fn(async () => ({success:true,channels:{whatsapp:true,instagram:false}})), getBusinessTeam: vi.fn(async () => ({ members: [] })) }));
vi.mock('../src/components/ReleaseControls', () => ({ default: () => null }));
vi.mock('../src/hooks/useReleaseFlags', () => ({ useReleaseFlags: () => ({ data: { flags: { autopilot: true } }, loading: false, error: '', reload: vi.fn() }) }));
vi.mock('../src/avaWorkspace', async original => ({ ...await original<typeof import('../src/avaWorkspace')>(), getAutopilot: mocks.get, workspaceRequest: mocks.request }));
beforeEach(() => { mocks.get.mockReset().mockResolvedValue(response); mocks.request.mockReset(); });
afterEach(cleanup);
const show = () => render(<MemoryRouter><Autopilot /></MemoryRouter>);

it('requires canonical readback before confirming saved rules', async () => {
    mocks.request.mockImplementation(async (_id, _path, _method, payload) => {
        const saved = { ...policy, ...payload, revision: 2 };
        mocks.get.mockResolvedValue({ ...response, policy: saved });
        return { success: true, businessId: 7, policy: saved };
    });
    show();
    fireEvent.change(await screen.findByLabelText('Сообщения'), { target: { value: '105' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить правила' }));
    await screen.findByText('Сохранение правил подтверждено. Проверьте новую версию перед включением.');
    expect(mocks.request).toHaveBeenCalledWith(7, '/autopilot/policy', 'put', expect.objectContaining({ revision: 1, dailyMessageLimit: 105 }), expect.any(AbortSignal));
    expect(mocks.get.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('link', { name: 'Открыть очередь' }).getAttribute('href')).toBe('/today');
});

it('retains edits and gives readback recovery when the saved version cannot be read', async () => {
    mocks.request.mockImplementation(async () => {
        mocks.get.mockRejectedValue(new Error('offline'));
        return { success: true, businessId: 7, policy: { ...policy, revision: 2 } };
    });
    show();
    fireEvent.change(await screen.findByLabelText('Сообщения'), { target: { value: '105' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить правила' }));
    await screen.findByRole('button', { name: 'Проверить сохранённые правила' });
    expect(screen.getByDisplayValue('105')).toBeTruthy();
    expect(screen.queryByText('Сохранение правил подтверждено. Проверьте новую версию перед включением.')).toBeNull();
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
});
