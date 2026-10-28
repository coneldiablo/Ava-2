// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RouteAccess } from './App';
import Layout from './components/Layout';
import { AuthProvider } from './context/AuthContext';
import { useBusinessAccess } from './permissions';
import { getAuthSession } from './api';

vi.mock('./api', async importOriginal => ({ ...await importOriginal<typeof import('./api')>(), getAuthSession: vi.fn() }));
vi.mock('./context/InstanceContext', () => ({
    useInstance: () => ({ currentInstanceId: 7, currentInstance: { id: 7, name: 'Бизнес' }, instancesState: 'ready', instances: [{ id: 7, name: 'Бизнес' }], setInstanceId: vi.fn(), refreshInstances: vi.fn() }),
    InstanceProvider: ({ children }: { children: React.ReactNode }) => children,
}));
const owner = { authenticated: true, role: 'customer', userId: 'owner-user', displayName: 'Владелец', login: 'owner@example.test',
    memberships: [{ businessId: 7, role: 'hotel_owner', capabilities: ['business.read', 'team.read', 'team.manage'] }] };
let mounts = 0;
function Editor() {
    const access = useBusinessAccess();
    const [value, setValue] = useState('');
    useEffect(() => { mounts += 1; }, []);
    return <label>Черновик<input value={value} onChange={event => setValue(event.target.value)} data-role={access.role} data-checking={access.checking} data-can-manage={access.can('team.manage')} /></label>;
}
const show = () => render(<AuthProvider><MemoryRouter initialEntries={['/team']}><Routes><Route element={<Layout />}><Route path="team" element={<RouteAccess><Editor /></RouteAccess>} /></Route></Routes></MemoryRouter></AuthProvider>);
function deferRefresh() {
    let resolve: (value: unknown) => void = () => {};
    vi.mocked(getAuthSession).mockReturnValueOnce(new Promise(value => { resolve = value; }));
    act(() => window.dispatchEvent(new Event('focus')));
    return resolve;
}

describe('mounted route state survives unchanged background authorization', () => {
    beforeEach(() => { mounts = 0; vi.clearAllMocks(); vi.mocked(getAuthSession).mockResolvedValue(owner); });
    afterEach(cleanup);
    it('retains a visible draft while focus refresh inerts the existing subtree and closes grants', async () => {
        show(); const input = await screen.findByLabelText<HTMLInputElement>('Черновик');
        fireEvent.change(input, { target: { value: 'Ссылка и набранный черновик' } });
        const resolve = deferRefresh();
        expect(screen.getByLabelText('Черновик')).toBe(input);
        expect(input.getAttribute('data-role')).toBe('hotel_owner');
        expect(input.getAttribute('data-checking')).toBe('true');
        expect(input.getAttribute('data-can-manage')).toBe('false');
        const blocked = input.closest<HTMLElement>('div')!;
        expect(blocked.inert).toBe(true); expect(blocked.style.visibility).not.toBe('hidden');
        await act(async () => resolve({ ...owner, memberships: owner.memberships.map(item => ({ ...item, capabilities: [...item.capabilities] })) }));
        expect(screen.getByLabelText('Черновик')).toBe(input); expect(input.value).toBe('Ссылка и набранный черновик');
        expect(blocked.inert).toBe(false); expect(input.getAttribute('data-can-manage')).toBe('true'); expect(mounts).toBe(1);
    });
    it('keeps the mounted draft through 503 and recovers live operations only after retry', async () => {
        show(); const input = await screen.findByLabelText<HTMLInputElement>('Черновик');
        fireEvent.change(input, { target: { value: 'Не терять при 503' } });
        vi.mocked(getAuthSession).mockRejectedValueOnce({ response: { status: 503 } });
        act(() => window.dispatchEvent(new Event('focus')));
        await screen.findByRole('button', { name: 'Повторить проверку' });
        expect(screen.getByLabelText('Черновик')).toBe(input); expect(input.value).toBe('Не терять при 503');
        expect(input.getAttribute('data-can-manage')).toBe('false'); expect(mounts).toBe(1);
        fireEvent.click(screen.getByRole('button', { name: 'Повторить проверку' }));
        await waitFor(() => expect(input.getAttribute('data-can-manage')).toBe('true'));
        expect(screen.getByLabelText('Черновик')).toBe(input); expect(mounts).toBe(1);
    });
    it('removes the mounted draft after authoritative membership revocation', async () => {
        show(); const input = await screen.findByLabelText<HTMLInputElement>('Черновик');
        fireEvent.change(input, { target: { value: 'До отзыва' } });
        const resolve = deferRefresh();
        await act(async () => resolve({ ...owner, canCreateBusiness: false, memberships: [] }));
        expect(screen.queryByLabelText('Черновик')).toBeNull(); expect(screen.getByText('Раздел недоступен')).toBeTruthy();
    });
    it('remounts and clears local form state after an actual capability/role change', async () => {
        show(); const input = await screen.findByLabelText<HTMLInputElement>('Черновик');
        fireEvent.change(input, { target: { value: 'До изменения роли' } });
        const resolve = deferRefresh();
        await act(async () => resolve({ ...owner, memberships: [{ businessId: 7, role: 'observer', capabilities: ['business.read', 'team.read'] }] }));
        const changed = screen.getByLabelText<HTMLInputElement>('Черновик');
        expect(changed).not.toBe(input); expect(changed.value).toBe('');
        expect(changed.getAttribute('data-role')).toBe('observer'); expect(changed.getAttribute('data-can-manage')).toBe('false');
        await waitFor(() => expect(mounts).toBe(2));
    });
});
