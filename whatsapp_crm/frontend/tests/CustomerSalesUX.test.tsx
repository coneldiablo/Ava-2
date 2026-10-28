// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { hasUnresolvedPlaceholders, selectCustomerRows } from '../src/pages/customerListHelpers';
import Reports from '../src/pages/Reports';
import QuickReplies from '../src/pages/QuickReplies';
import * as api from '../src/api';
import { getWorkspaceAnalytics } from '../src/avaWorkspace';

vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: 4, currentInstance: { id: 4, name: 'Бизнес' } }) }));
vi.mock('../src/permissions', () => ({ useBusinessAccess: () => ({ userId: 'manager', role: 'manager', checking: false, can: (capability: string) => capability === 'messages.send', isPlatformAdmin: false }) }));
vi.mock('../src/api', () => ({ getTemplates: vi.fn(), createTemplate: vi.fn(), deleteTemplate: vi.fn(), getAnalyticsExportUrl: vi.fn(), getAnalyticsLeadsOverTime: vi.fn(), getAnalyticsMessagesOverTime: vi.fn(), getCallAnalytics: vi.fn() }));
vi.mock('../src/avaWorkspace', () => ({ getWorkspaceAnalytics: vi.fn(), stageLabel: (stage: string) => stage === 'won' ? 'Успешно' : 'Новые' }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const rows = [
    { chatId: 'own', assigneeUserId: 'manager', leadStatus: 'new', createdAt: '2026-10-15T10:00:00Z' },
    { chatId: 'other', assigneeUserId: 'other', leadStatus: 'won', createdAt: '2026-10-14T10:00:00Z' },
    { chatId: 'free', assigneeUserId: null, leadStatus: 'new', createdAt: '2026-10-15T10:00:00Z' },
];
describe('customer source selections', () => {
    it('defaults a manager to exact assignments and fails closed without identity', () => {
        expect(selectCustomerRows(rows, new URLSearchParams(), 'manager', 'manager').map(row => row.chatId)).toEqual(['own']);
        expect(selectCustomerRows(rows, new URLSearchParams(), 'manager', null)).toEqual([]);
    });
    it('shows an observer the permitted read response and selects only unassigned queue rows', () => {
        expect(selectCustomerRows(rows, new URLSearchParams(), 'observer')).toHaveLength(3);
        expect(selectCustomerRows(rows, new URLSearchParams('view=queue'), 'manager', 'manager').map(row => row.chatId)).toEqual(['free']);
    });
    it('applies report date and stage selections without combining people', () => {
        expect(selectCustomerRows(rows, new URLSearchParams('view=all&status=new&createdFrom=2026-10-15&createdTo=2026-10-15'), 'hotel_owner').map(row => row.chatId)).toEqual(['own', 'free']);
    });
    it('recognizes unresolved fields and accepts filled normal prose', () => {
        for (const value of ['Здравствуйте, {{name}}', '{client_name}', '%CLIENT_NAME%', '[[phone]]']) expect(hasUnresolvedPlaceholders(value)).toBe(true);
        expect(hasUnresolvedPlaceholders('Здравствуйте, Мария. Встреча завтра в 15:00.')).toBe(false);
    });
    it('loads the team metric contract for the exact linked report period', async () => {
        vi.mocked(getWorkspaceAnalytics).mockResolvedValue({ success: true, businessId: 4, metrics: { stageCounts: [{ stage: 'won', count: 2 }], winRate: 50, averageCycleDays: 3, closedSampleSize: 4 } } as never);
        render(<MemoryRouter initialEntries={['/reports?type=deals&days=7']}><Reports /></MemoryRouter>);
        await screen.findByText('50%');
        expect(getWorkspaceAnalytics).toHaveBeenCalledWith(4, 7);
        expect(screen.getByRole('link', { name: 'Успешно 2' }).getAttribute('href')).toBe('/deals?stage=won&mine=0');
    });
    it('opens a selected customer template in the editable composer without a send call', async () => {
        vi.mocked(api.getTemplates).mockResolvedValue({ success: true, templates: [{ id: 8, instanceId: 4, label: 'Встреча', text: 'Здравствуйте, {{name}}' }] });
        render(<MemoryRouter initialEntries={['/quick-replies?client=own']}><QuickReplies /></MemoryRouter>);
        expect((await screen.findByRole('link', { name: 'Вставить в разговор' })).getAttribute('href')).toBe('/conversations?client=own&chat=own&template=8&businessId=4');
        expect(screen.getByText(/Заполните их в редакторе/)).toBeTruthy();
        expect(api.createTemplate).not.toHaveBeenCalled();
    });
    it('rejects a template response from another business and gives recovery', async () => {
        vi.mocked(api.getTemplates).mockResolvedValue({ success: true, templates: [{ id: 8, instanceId: 99, label: 'Чужой', text: 'Чужой текст' }] });
        render(<MemoryRouter><QuickReplies /></MemoryRouter>);
        await screen.findByRole('alert');
        expect(screen.queryByText('Чужой текст')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));
        expect(api.getTemplates).toHaveBeenCalledTimes(2);
    });
});
