// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { getAuthSession, login as loginRequest } from '../api';
import { AuthProvider, useAuth } from './AuthContext';

vi.mock('../api', () => ({ getAuthSession: vi.fn(), login: vi.fn(), logout: vi.fn(async () => ({})) }));
const owner = { authenticated: true, role: 'customer', userId: 'stable-owner', login: 'owner@example.test', displayName: 'Владелец', canCreateBusiness: true,
    memberships: [{ businessId: 7, role: 'hotel_owner', capabilities: ['business.read', 'business.manage'] }] };
let auth: ReturnType<typeof useAuth>;
function Probe() { auth = useAuth(); return <output>{JSON.stringify(auth)}</output>; }
const show = () => render(<AuthProvider><Probe /></AuthProvider>);
const ready = () => waitFor(() => expect(auth.loading).toBe(false));

describe('authoritative session refresh', () => {
    beforeEach(() => { vi.clearAllMocks(); vi.mocked(getAuthSession).mockResolvedValue(owner); });
    afterEach(cleanup);
    it('retains stable identity, display name and exact membership capabilities', async () => {
        show(); await ready();
        expect(auth.userId).toBe('stable-owner'); expect(auth.displayName).toBe('Владелец');
        expect(auth.memberships[0].capabilities).toEqual(['business.read', 'business.manage']);
        expect(auth.canCreateBusiness).toBe(false);
    });
    it('accepts user_id compatibility without inventing an admin role', async () => {
        vi.mocked(getAuthSession).mockResolvedValue({ authenticated: true, user_id: 'legacy-user', memberships: [] });
        show(); await ready(); expect(auth.userId).toBe('legacy-user'); expect(auth.role).toBe('customer');
    });
    it('closes operations during a 403 readback and applies a demoted membership', async () => {
        show(); await ready(); let resolve: (value: unknown) => void = () => {};
        vi.mocked(getAuthSession).mockReturnValueOnce(new Promise(value => { resolve = value; }));
        act(() => window.dispatchEvent(new Event('crm:forbidden')));
        expect(auth.permissionsLoading).toBe(true);
        await act(async () => resolve({ ...owner, memberships: [{ businessId: 7, role: 'observer', capabilities: ['business.read', 'sales.read'] }] }));
        expect(auth.permissionsLoading).toBe(false); expect(auth.memberships[0].role).toBe('observer');
    });
    it('retains identity and closes grants after a failed focus refresh until successful readback', async () => {
        show(); await ready(); vi.mocked(getAuthSession).mockRejectedValueOnce(new Error('network'));
        act(() => window.dispatchEvent(new Event('focus')));
        await waitFor(() => expect(auth.permissionsError).toBeTruthy());
        expect(auth.authenticated).toBe(true); expect(auth.userId).toBe('stable-owner'); expect(auth.permissionsLoading).toBe(true);
        await act(() => auth.refreshAuth());
        expect(auth.permissionsLoading).toBe(false); expect(auth.permissionsError).toBe('');
    });
    it('clears identity when the session endpoint confirms unauthorized', async () => {
        show(); await ready(); vi.mocked(getAuthSession).mockRejectedValueOnce({ response: { status: 401 } });
        act(() => window.dispatchEvent(new Event('focus')));
        await waitFor(() => expect(auth.authenticated).toBe(false));
        expect(auth.memberships).toEqual([]); expect(auth.userId).toBeNull(); expect(auth.permissionsLoading).toBe(false);
    });
    it('does not revive a session from a response completed after unauthorized', async () => {
        show(); await ready(); let resolve: (value: unknown) => void = () => {};
        vi.mocked(getAuthSession).mockReturnValueOnce(new Promise(value => { resolve = value; }));
        act(() => window.dispatchEvent(new Event('focus')));
        act(() => window.dispatchEvent(new Event('crm:unauthorized')));
        await act(async () => resolve(owner));
        expect(auth.authenticated).toBe(false); expect(auth.memberships).toEqual([]);
    });
    it('does not turn revoked membership into first-business provisioning', async () => {
        show(); await ready(); vi.mocked(getAuthSession).mockResolvedValueOnce({ ...owner, memberships: [] });
        await act(() => auth.refreshAuth());
        expect(auth.authenticated).toBe(true); expect(auth.memberships).toEqual([]); expect(auth.canCreateBusiness).toBe(false);
    });
    it('allows a fresh account to bootstrap only with the explicit backend flag', async () => {
        vi.mocked(getAuthSession).mockResolvedValue({ ...owner, memberships: [] });
        show(); await ready(); expect(auth.canCreateBusiness).toBe(true);
    });
    it('reads the authoritative session after login instead of adopting response identity', async () => {
        vi.mocked(getAuthSession).mockResolvedValueOnce({ authenticated: false });
        show(); await ready(); vi.mocked(loginRequest).mockResolvedValueOnce({ authenticated: true, userId: 'response-user', role: 'platform_admin' });
        await act(() => auth.login('owner@example.test', 'password'));
        expect(auth.userId).toBe('stable-owner'); expect(auth.role).toBe('customer');
        expect(screen.getByRole('status').textContent).toContain('stable-owner');
    });
});
