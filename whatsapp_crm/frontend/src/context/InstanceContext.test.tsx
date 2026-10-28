// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { getInstances } from '../api';
import { InstanceProvider, useInstance } from './InstanceContext';

const shared = vi.hoisted(() => ({ userId: 'employee', memberships: [{ businessId: 7, role: 'manager', capabilities: ['business.read'] }] }));
vi.mock('./AuthContext', () => ({ useAuth: () => ({ authenticated: true, role: 'customer', userId: shared.userId, memberships: shared.memberships }) }));
vi.mock('../api', () => ({ getInstances: vi.fn() }));
let instance: ReturnType<typeof useInstance>;
function Probe() { instance = useInstance(); return <output>{instance.currentInstanceId}</output>; }
const show = () => render(<InstanceProvider><Probe /></InstanceProvider>);
const rows = [{ id: 7, name: 'Первый', isActive: 1 }, { id: 8, name: 'Второй', isActive: 1 }, { id: 9, name: 'Отключён', isActive: 0 }];

describe('business selection uses live membership and bounded request lifetime', () => {
    beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); shared.userId = 'employee'; shared.memberships = [{ businessId: 7, role: 'manager', capabilities: ['business.read'] }]; vi.mocked(getInstances).mockResolvedValue({ success: true, instances: rows }); });
    afterEach(cleanup);
    it('filters foreign and inactive businesses from both list and exposed selection', async () => {
        show(); await waitFor(() => expect(instance.instancesState).toBe('ready'));
        expect(instance.instances.map(row => row.id)).toEqual([7]);
        act(() => instance.setInstanceId(8)); expect(instance.currentInstanceId).toBe(7);
    });
    it('drops revoked businesses immediately even before replacement fetch completes', async () => {
        const view = show(); await waitFor(() => expect(instance.instancesState).toBe('ready'));
        vi.mocked(getInstances).mockReturnValueOnce(new Promise(() => {})); shared.memberships = [];
        view.rerender(<InstanceProvider><Probe /></InstanceProvider>);
        expect(instance.currentInstanceId).toBeNull(); expect(instance.instances).toEqual([]);
    });
    it('ignores old business-list responses after memberships change', async () => {
        let resolve: (value: unknown) => void = () => {};
        vi.mocked(getInstances).mockReturnValueOnce(new Promise(value => { resolve = value; }));
        const view = show(); shared.memberships = [{ businessId: 8, role: 'observer', capabilities: ['business.read'] }];
        view.rerender(<InstanceProvider><Probe /></InstanceProvider>);
        await waitFor(() => expect(instance.currentInstanceId).toBe(8));
        await act(async () => resolve({ success: true, instances: [rows[0]] }));
        expect(instance.currentInstanceId).toBe(8); expect(instance.instances[0].name).toBe('Второй');
    });
    it('opens a preferred invitation business only after it appears in the allowed list', async () => {
        shared.memberships.push({ businessId: 8, role: 'manager', capabilities: ['business.read'] });
        sessionStorage.setItem('ava:preferred-business', '8'); show();
        await waitFor(() => expect(instance.currentInstanceId).toBe(8));
        expect(sessionStorage.getItem('ava:preferred-business')).toBeNull();
    });
    it('does not open a foreign preferred invitation business', async () => {
        sessionStorage.setItem('ava:preferred-business', '8'); show();
        await waitFor(() => expect(instance.instancesState).toBe('ready')); expect(instance.currentInstanceId).toBe(7);
    });
    it('keeps the scoped selection and reports a refresh failure instead of empty success', async () => {
        show(); await waitFor(() => expect(instance.instancesState).toBe('ready'));
        vi.mocked(getInstances).mockRejectedValueOnce(new Error('unavailable'));
        await act(() => instance.refreshInstances());
        expect(instance.instancesState).toBe('error'); expect(instance.currentInstanceId).toBe(7); expect(instance.instances.map(row => row.id)).toEqual([7]);
    });
    it('masks the previous identity list immediately even when the replacement user has the same business', async () => {
        const view = show(); await waitFor(() => expect(instance.currentInstanceId).toBe(7));
        let finish!: (value: unknown) => void;
        vi.mocked(getInstances).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
        shared.userId = 'replacement'; view.rerender(<InstanceProvider><Probe /></InstanceProvider>);
        expect(instance.currentInstanceId).toBeNull(); expect(instance.instances).toEqual([]);
        await act(async () => finish({ success: true, instances: [{ id: 7, name: 'Свежий список' }] }));
        expect(instance.currentInstance?.name).toBe('Свежий список');
    });
});
