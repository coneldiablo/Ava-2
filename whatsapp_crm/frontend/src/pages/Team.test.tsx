// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Team from './Team';
import type { TeamInvitation } from '../teamSales';
import { createTeamInvitation, getBusinessTeam, removeTeamMember, resendTeamInvitation, updateTeamMemberRole } from '../api';
import { getAvailability, updateAvailability } from '../improvementsApi';
const fixture = vi.hoisted(() => ({ businessId: 7, userId: 'owner', actorRole: 'hotel_owner', canManage: true, canAssign: true, checking: false, role: 'manager', revision: 0, invitations: [] as TeamInvitation[] }));
vi.mock('../context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: fixture.businessId, currentInstance: { name: `Бизнес ${fixture.businessId}` } }) }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ userId: fixture.userId }) }));
vi.mock('../permissions', () => ({ useBusinessAccess: () => ({ role: fixture.actorRole, membership: fixture.actorRole === 'platform_admin' ? null : { businessId: fixture.businessId, role: fixture.actorRole, capabilities: ['sales.read'] }, userId: fixture.userId, checking: fixture.checking, can: (capability: string) => !fixture.checking && (capability === 'team.manage' ? fixture.canManage : capability === 'sales.assign' ? fixture.canAssign : capability === 'sales.write' ? fixture.actorRole !== 'observer' : true) }) }));
vi.mock('../api', () => ({
    getBusinessTeam: vi.fn(async (id: number) => ({ success: true, businessId: id, currentUserId: fixture.userId, capabilities: ['team.read', 'sales.read', ...(fixture.canManage ? ['team.manage'] : []), ...(fixture.canAssign ? ['sales.assign'] : [])], members: [{ userId: 'owner', email: 'owner@example.test', displayName: 'Владелец', role: 'hotel_owner', capabilities: [] }, { userId: 'employee', email: 'employee@example.test', displayName: 'Анна', role: fixture.role, capabilities: [] }], invitations: fixture.invitations, roleOptions: [{ role: 'manager', label: 'Менеджер', capabilities: [] }, { role: 'sales_lead', label: 'Руководитель продаж', capabilities: [] }, { role: 'observer', label: 'Наблюдатель', capabilities: [] }] })),
    getSalesWorkspace: vi.fn(async (id: number, view: string) => ({ success: true, businessId: id, view, currentUserId: fixture.userId, capabilities: ['sales.read'], summary: { openTasks: 3, overdueTasks: 1, pendingFollowups: 0, unassignedClients: 1 }, members: [{ userId: 'employee', displayName: 'Анна', email: 'employee@example.test', role: 'manager', openTasks: 3, overdueTasks: 1 }], tasks: [{ taskId: 'task1', chatId: 'customer/a', summary: 'Перезвонить клиенту', assigneeUserId: 'employee' }], clients: [], pagination: { page: 1, pageSize: 30, totalTasks: 3, totalClients: 0 } })),
    createTeamInvitation: vi.fn(async () => ({ success: true, inviteUrl: `${window.location.origin}/invite#secret`, expiresAt: '2026-10-03T10:00:00Z' })),
    updateTeamMemberRole: vi.fn(async (_id: number, _user: string, role: string) => { fixture.role = role; return { success: true }; }),
    removeTeamMember: vi.fn(async () => ({ success: true })), renewTeamInvitation: vi.fn(), resendTeamInvitation: vi.fn(), revokeTeamInvitation: vi.fn(),
}));
vi.mock('../improvementsApi', () => ({
    getAvailability: vi.fn(async (id: number) => ({ success: true, businessId: id, members: [{ userId: 'owner', name: 'Владелец', status: 'available', capacity: null, currentLoad: 0, revision: 1 }, { userId: 'employee', name: 'Анна', status: 'available', capacity: 5, currentLoad: 4, revision: 7 }] })),
    updateAvailability: vi.fn(async (id: number, userId: string, body: { revision: number; status: string; capacity?: number | null }) => ({ success: true, businessId: id, member: { userId, name: 'Анна', status: body.status, capacity: body.capacity ?? null, currentLoad: 4, revision: body.revision + 1 } })),
}));
describe('Team actual readback and access', () => {
    beforeEach(() => { vi.clearAllMocks(); fixture.businessId = 7; fixture.userId = 'owner'; fixture.actorRole = 'hotel_owner'; fixture.canAssign = true; fixture.checking = false; fixture.canManage = true; fixture.role = 'manager'; fixture.invitations = []; });
    afterEach(cleanup);
    it('creates the selected role and re-reads active invitations', async () => {
        render(<Team/>); await screen.findByText('Анна');
        fireEvent.change(screen.getByLabelText('Рабочая почта'), { target: { value: 'new@example.test' } });
        fireEvent.change(screen.getByLabelText('Роль в бизнесе'), { target: { value: 'observer' } });
        fireEvent.click(screen.getByRole('button', { name: 'Пригласить' }));
        await screen.findByDisplayValue(`${window.location.origin}/invite#secret`);
        expect(createTeamInvitation).toHaveBeenCalledWith(7, { email: 'new@example.test', role: 'observer' }, expect.any(AbortSignal));
        expect(getBusinessTeam).toHaveBeenCalledTimes(2);
    });
    it('keeps a usable link on email failure and retries with a new confirmed link', async () => {
        vi.mocked(createTeamInvitation).mockResolvedValueOnce({ success: true, invitationId: 31, inviteUrl: `${window.location.origin}/invite#failed-mail-link`, expiresAt: '2026-10-13', delivery: { state: 'failed', attempts: 1, errorCode: 'SMTP_AUTH_FAILED' } });
        vi.mocked(resendTeamInvitation).mockResolvedValueOnce({ success: true, invitationId: 31, inviteUrl: `${window.location.origin}/invite#resent-link`, expiresAt: '2026-10-13', delivery: { state: 'smtp_accepted', attempts: 2 } });
        render(<Team/>); await screen.findByText('Анна');
        fireEvent.change(screen.getByLabelText('Рабочая почта'), { target: { value: 'new@example.test' } });
        fireEvent.click(screen.getByRole('button', { name: 'Пригласить' }));
        await screen.findByDisplayValue(`${window.location.origin}/invite#failed-mail-link`);
        expect(screen.getAllByText(/Письмо не отправлено/).length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole('button', { name: 'Отправить письмо ещё раз' }));
        await screen.findByDisplayValue(`${window.location.origin}/invite#resent-link`);
        expect(resendTeamInvitation).toHaveBeenCalledWith(7, 31, expect.any(AbortSignal));
        expect(screen.queryByDisplayValue(`${window.location.origin}/invite#failed-mail-link`)).toBeNull();
        expect(screen.getAllByText(/Доставка во входящие пока не подтверждена/).length).toBeGreaterThan(0);
        expect(screen.getByText(/Ссылка обновлена: прежняя ссылка больше не действует/)).toBeTruthy();
        expect(getBusinessTeam).toHaveBeenCalledTimes(3);
    });
    it('hides the old link when a resend result is uncertain', async () => {
        fixture.invitations = [{ id: 31, email: 'new@example.test', role: 'manager', expiresAt: '2026-10-13', state: 'pending' }];
        vi.mocked(createTeamInvitation).mockResolvedValueOnce({ success: true, invitationId: 31, inviteUrl: `${window.location.origin}/invite#prior-link`, expiresAt: '2026-10-13' });
        vi.mocked(resendTeamInvitation).mockRejectedValueOnce(new Error('Network failure'));
        render(<Team/>); await screen.findByText('Анна');
        fireEvent.change(screen.getByLabelText('Рабочая почта'), { target: { value: 'new@example.test' } });
        fireEvent.click(screen.getByRole('button', { name: 'Пригласить' }));
        await screen.findByDisplayValue(`${window.location.origin}/invite#prior-link`);
        fireEvent.click(screen.getAllByRole('button', { name: 'Отправить письмо ещё раз' })[0]);
        await screen.findByRole('alert');
        expect(screen.queryByDisplayValue(`${window.location.origin}/invite#prior-link`)).toBeNull();
        expect(screen.getByText('new@example.test')).toBeTruthy();
    });
    it('reads historical delivery honestly and shows a retry cooldown without losing the row', async () => {
        fixture.invitations = [{ id: 42, email: 'waiting@example.test', role: 'observer', expiresAt: '2026-10-13', state: 'pending', delivery: { state: 'not_attempted', attempts: 0 } }];
        vi.mocked(resendTeamInvitation).mockRejectedValueOnce({ response: { data: { code: 'INVITATION_RESEND_COOLDOWN' } } });
        render(<Team/>); await screen.findByText('waiting@example.test');
        expect(screen.getByText(/Отправка письма не подтверждена/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Отправить письмо ещё раз' }));
        expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Письмо недавно отправлялось. Подождите минуту и повторите попытку.');
        expect(screen.getByText('waiting@example.test')).toBeTruthy();
    });
    it('disables retry while SMTP delivery is pending and for expired invitations', async () => {
        fixture.invitations = [
            { id: 42, email: 'sending@example.test', role: 'observer', expiresAt: '2026-10-13', state: 'pending', delivery: { state: 'sending', attempts: 1 } },
            { id: 43, email: 'expired@example.test', role: 'observer', expiresAt: '2026-10-01', state: 'expired' },
        ];
        render(<Team/>); await screen.findByText('sending@example.test');
        expect(screen.getAllByRole('button', { name: 'Отправить письмо ещё раз' }).every(button => button.hasAttribute('disabled'))).toBe(true);
        expect(resendTeamInvitation).not.toHaveBeenCalled();
    });
    it('persists role and shows server role after save', async () => {
        render(<Team/>); await screen.findByText('Анна');
        fireEvent.click(screen.getByRole('button', { name: 'Изменить роль' }));
        fireEvent.change(screen.getByLabelText('Роль для Анна'), { target: { value: 'sales_lead' } });
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить роль' }));
        await screen.findByText('Руководитель продаж');
        expect(updateTeamMemberRole).toHaveBeenCalledWith(7, 'employee', 'sales_lead', expect.any(AbortSignal));
        expect(screen.queryByLabelText('Роль для Анна')).toBeNull();
    });
    it('requires exact business confirmation before removing membership', async () => {
        render(<Team/>); await screen.findByText('Анна');
        fireEvent.click(screen.getByRole('button', { name: 'Удалить доступ' }));
        expect(removeTeamMember).not.toHaveBeenCalled();
        expect(screen.getByText(/Его аккаунт AVA сохранится/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Удалить доступ к «Бизнес 7»' }));
        await waitFor(() => expect(removeTeamMember).toHaveBeenCalledWith(7, 'employee', expect.any(AbortSignal)));
    });
    it('shows a failed read as unavailable and has no false empty list', async () => {
        vi.mocked(getBusinessTeam).mockRejectedValueOnce(new Error()); render(<Team/>);
        await screen.findByRole('alert'); expect(screen.queryByText('В этом бизнесе пока нет сотрудников.')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Пригласить' })).toBeNull();
    });
    it('readonly roles never show access mutations', async () => {
        fixture.canManage = false; render(<Team/>); await screen.findByText('Анна');
        expect(screen.queryByRole('button', { name: 'Изменить роль' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Удалить доступ' })).toBeNull();
    });
    it('retains the confirmed invite link during pending unchanged permission refresh', async () => {
        const view = render(<Team/>); await screen.findByText('Анна');
        fireEvent.change(screen.getByLabelText('Рабочая почта'), { target: { value: 'new@example.test' } }); fireEvent.click(screen.getByRole('button', { name: 'Пригласить' }));
        await screen.findByDisplayValue(`${window.location.origin}/invite#secret`);
        fixture.checking = true; view.rerender(<Team/>); expect(screen.getByDisplayValue(`${window.location.origin}/invite#secret`)).toBeTruthy();
        fixture.checking = false; view.rerender(<Team/>); expect(screen.getByDisplayValue(`${window.location.origin}/invite#secret`)).toBeTruthy();
    });
    it('drops a late invitation result when business changes', async () => {
        let resolve!: (result: any) => void; vi.mocked(createTeamInvitation).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
        const view = render(<Team/>); await screen.findByText('Анна');
        fireEvent.change(screen.getByLabelText('Рабочая почта'), { target: { value: 'new@example.test' } }); fireEvent.click(screen.getByRole('button', { name: 'Пригласить' }));
        fixture.businessId = 8; view.rerender(<Team/>); await screen.findByText(/Бизнес 8 ·/);
        resolve({ success: true, inviteUrl: `${window.location.origin}/invite#obsolete`, expiresAt: '2026-10-03' });
        await waitFor(() => expect(screen.queryByDisplayValue(`${window.location.origin}/invite#obsolete`)).toBeNull());
    });
    it('preserves the invitation form after a failed refresh and blocks changes until recovery', async () => {
        render(<Team/>); await screen.findByText('Анна');
        fireEvent.change(screen.getByLabelText('Рабочая почта'), { target: { value: 'unfinished@example.test' } });
        vi.mocked(getBusinessTeam).mockRejectedValueOnce(new Error('Network failure'));
        fireEvent.click(screen.getByRole('button', { name: 'Обновить команду' }));
        await screen.findByText(/Не удалось обновить команду/);
        expect(screen.getByDisplayValue('unfinished@example.test')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Пригласить' }).hasAttribute('disabled')).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Пригласить' }).hasAttribute('disabled')).toBe(false));
        expect(screen.getByDisplayValue('unfinished@example.test')).toBeTruthy();
    });
    it('keeps forms but blocks invitation, role and shift writes while permissions are checked', async () => {
        const view = render(<Team/>); await screen.findByText('Анна');
        fireEvent.change(screen.getByLabelText('Рабочая почта'), { target: { value: 'unfinished@example.test' } });
        fireEvent.click(await screen.findByRole('button', { name: 'Изменить смену · Анна' }));
        fireEvent.change(screen.getByLabelText('Смена · Анна'), { target: { value: 'break' } });
        fixture.checking = true; view.rerender(<Team/>);
        expect(screen.getByDisplayValue('unfinished@example.test')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Пригласить' }).hasAttribute('disabled')).toBe(true);
        expect(screen.getByRole('button', { name: 'Изменить роль' }).hasAttribute('disabled')).toBe(true);
        expect(screen.getByRole('button', { name: 'Сохранить смену' }).hasAttribute('disabled')).toBe(true);
        fireEvent.submit(screen.getByRole('button', { name: 'Пригласить' }).closest('form')!);
        fireEvent.submit(screen.getByRole('button', { name: 'Сохранить смену' }).closest('form')!);
        expect(createTeamInvitation).not.toHaveBeenCalled(); expect(updateAvailability).not.toHaveBeenCalled();
        fixture.checking = false; view.rerender(<Team/>);
        expect((screen.getByLabelText('Смена · Анна') as HTMLSelectElement).value).toBe('break');
    });
    it('lets a leader update shift and capacity with the exact server revision without access management', async () => {
        fixture.canManage = false; fixture.actorRole = 'sales_lead';
        render(<Team/>); await screen.findByText('Открытых задач: 3 · просрочено: 1');
        expect(screen.queryByRole('button', { name: 'Пригласить' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Изменить смену · Анна' }));
        fireEvent.change(screen.getByLabelText('Смена · Анна'), { target: { value: 'break' } });
        fireEvent.change(screen.getByLabelText('Лимит активных клиентов · Анна'), { target: { value: '6' } });
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить смену' }));
        await waitFor(() => expect(updateAvailability).toHaveBeenCalledWith(7, 'employee', { revision: 7, status: 'break', capacity: 6 }, expect.any(AbortSignal)));
        expect(screen.getByRole('link', { name: 'Открыть задачи команды' }).getAttribute('href')).toBe('/sales?view=team');
    });
    it('limits a manager to their own shift and links to the actual claim queue', async () => {
        fixture.canManage = false; fixture.canAssign = false; fixture.userId = 'employee'; fixture.actorRole = 'manager';
        render(<Team/>); fireEvent.click(await screen.findByRole('button', { name: 'Моя смена' }));
        expect(screen.queryByRole('button', { name: /Изменить смену · Владелец/ })).toBeNull();
        expect(screen.queryByLabelText(/Лимит активных клиентов/)).toBeNull();
        fireEvent.change(screen.getByLabelText('Смена · Анна'), { target: { value: 'off' } });
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить смену' }));
        await waitFor(() => expect(updateAvailability).toHaveBeenCalledWith(7, 'employee', { revision: 7, status: 'off' }, expect.any(AbortSignal)));
        expect(screen.getByRole('link', { name: 'Взять свободную задачу' }).getAttribute('href')).toBe('/sales?view=queue');
    });
    it('retains edited shift values on revision conflict and offers server refresh', async () => {
        vi.mocked(updateAvailability).mockRejectedValueOnce({ response: { data: { code: 'AVAILABILITY_REVISION_CONFLICT' } } });
        render(<Team/>); fireEvent.click(await screen.findByRole('button', { name: 'Изменить смену · Анна' }));
        fireEvent.change(screen.getByLabelText('Смена · Анна'), { target: { value: 'break' } });
        fireEvent.click(screen.getByRole('button', { name: 'Сохранить смену' }));
        await screen.findByText(/Смену уже изменил другой сотрудник/);
        expect((screen.getByLabelText('Смена · Анна') as HTMLSelectElement).value).toBe('break');
        expect(screen.getByRole('button', { name: 'Обновить смены' })).toBeTruthy();
    });
    it('shows real departure work and the redistribution contract before access is removed', async () => {
        render(<Team/>); await screen.findByText('Открытых задач: 3 · просрочено: 1');
        fireEvent.click(screen.getByRole('button', { name: 'Удалить доступ' }));
        expect(screen.getByText(/Открытых задач: 3 · просрочено: 1. Активных клиентов: 4/)).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Перезвонить клиенту' }).getAttribute('href')).toBe('/customers/customer%2Fa');
        expect(screen.getByText(/Если результат отправки ещё неизвестен/)).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Открыть без ответственного' }).getAttribute('href')).toBe('/sales?view=queue');
        expect(removeTeamMember).not.toHaveBeenCalled();
    });
    it('rejects an invitation link outside the current origin and retains its form', async () => {
        vi.mocked(createTeamInvitation).mockResolvedValueOnce({ success: true, inviteUrl: 'https://untrusted.example/invite#secret', expiresAt: '2026-10-16' });
        render(<Team/>); await screen.findByText('Анна');
        fireEvent.change(screen.getByLabelText('Рабочая почта'), { target: { value: 'new@example.test' } });
        fireEvent.click(screen.getByRole('button', { name: 'Пригласить' }));
        await screen.findByText(/Изменение не подтверждено/);
        expect(screen.queryByDisplayValue('https://untrusted.example/invite#secret')).toBeNull();
        expect(screen.getByDisplayValue('new@example.test')).toBeTruthy();
    });
    it('does not call disabled shifts an off-duty team or lose the task route', async () => {
        vi.mocked(getAvailability).mockRejectedValueOnce({ response: { data: { code: 'WORKSPACE_FEATURE_DISABLED' } } });
        render(<Team/>); await screen.findByText(/Смены пока не включены/);
        expect(screen.queryByText('Не на смене')).toBeNull();
        expect(screen.getByRole('link', { name: 'Открыть задачи команды' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Моя смена' })).toBeNull();
    });
    it('clears unfinished forms when the authenticated user changes in the same business', async () => {
        const view = render(<Team/>); await screen.findByText('Анна');
        fireEvent.change(screen.getByLabelText('Рабочая почта'), { target: { value: 'previous-user@example.test' } });
        fixture.userId = 'employee'; view.rerender(<Team/>);
        await screen.findByText('Анна · вы');
        expect(screen.queryByDisplayValue('previous-user@example.test')).toBeNull();
    });
});
