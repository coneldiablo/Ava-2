// @vitest-environment jsdom
import { Suspense, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Outlet, useLocation } from 'react-router-dom';
import App from '../src/App';
import { onboardingSteps } from '../src/onboardingApi';
import { canAccessRoute, type PermissionSession } from '../src/permissions';

const state = vi.hoisted(() => ({
    role: 'hotel_owner', businessId: 7 as number | null, loading: false,
    authenticated: true, workspace: true, bootstrap: false,
    memberships: [{ businessId: 7, role: 'hotel_owner', capabilities: ['business.read', 'sales.read', 'team.read', 'business.manage', 'sales.assign', 'ai.use'] }],
}));
vi.mock('../src/context/AuthContext', () => ({
    AuthProvider: ({ children }: { children: ReactNode }) => children,
    useAuth: () => ({ authenticated: state.authenticated, loading: false, role: state.role === 'platform_admin' ? state.role : 'customer',
        permissionsLoading: state.loading, memberships: state.memberships, canCreateBusiness: state.bootstrap,
        refreshAuth: vi.fn(), loginName: 'review', userId: 'review-user' }),
}));
vi.mock('../src/context/InstanceContext', () => ({
    InstanceProvider: ({ children }: { children: ReactNode }) => children,
    useInstance: () => ({ currentInstanceId: state.businessId, instancesState: 'ready', refreshInstances: vi.fn() }),
}));
vi.mock('../src/components/Layout', () => ({ default: () => <Suspense fallback={<p>loading page</p>}><Outlet /></Suspense> }));
vi.mock('../src/hooks/useReleaseFlags', () => ({ useReleaseFlags: () => ({ data: { flags: { workspace: state.workspace } }, loading: false, checking: false }) }));
vi.mock('../src/pages/Dashboard', () => ({ default: () => <p>dashboard page</p> }));
vi.mock('../src/pages/TodayWorkspace', () => ({ default: function TodayPage() { const location = useLocation(); return <p>today page {location.search}</p>; } }));
vi.mock('../src/pages/SalesWorkspace', () => ({ default: () => <p>sales page</p> }));
vi.mock('../src/pages/Team', () => ({ default: () => <p>team page</p> }));
vi.mock('../src/pages/Autopilot', () => ({ default: () => <p>autopilot page</p> }));
vi.mock('../src/pages/CustomerIntelligence', () => ({ default: () => <p>customer page</p> }));
vi.mock('../src/pages/OnboardingGuide', () => ({ default: () => <p>onboarding page</p> }));
vi.mock('../src/pages/Login', () => ({ default: () => <p>login page</p> }));
vi.mock('../src/pages/AcceptInvitation', () => ({ default: () => null }));
vi.mock('../src/pages/OwnerInvitation', () => ({ default: () => null }));
vi.mock('../src/pages/ModuleAccess', () => ({ default: () => null }));
vi.mock('../src/api', () => ({ getVapidPublicKey: vi.fn(), subscribePush: vi.fn() }));

function show(path: string) { window.history.replaceState(null, '', path); return render(<App />); }
function selectRole(role: string) { state.role = role; state.memberships[0].role = role; }
beforeEach(() => {
    Object.assign(state, { role: 'hotel_owner', businessId: 7, loading: false, authenticated: true, workspace: true, bootstrap: false,
        memberships: [{ businessId: 7, role: 'hotel_owner', capabilities: ['business.read', 'sales.read', 'team.read', 'business.manage', 'sales.assign', 'ai.use'] }] });
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/businesses/7/onboarding' && init?.method === 'GET') return { ok: true, status: 200, json: async () => ({
            success: true, onboarding: { businessId: 7, status: 'completed', confirmedSteps: [...onboardingSteps], completedAt: '2026-10-10T09:00:00.000Z' },
        }) };
        throw new Error('No external requests allowed in routing regression tests');
    }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('restored dashboard route contract', () => {
    it.each([true, false])('owner home mounts Dashboard independently of workspace flag %s', async workspace => {
        state.workspace = workspace; show('/');
        expect(await screen.findByText('dashboard page')).toBeTruthy();
        expect(screen.queryByText(/today page|sales page/)).toBeNull();
    });
    it('platform operator retains Dashboard', async () => { selectRole('platform_admin'); show('/'); expect(await screen.findByText('dashboard page')).toBeTruthy(); });
    it.each(['sales_lead', 'manager', 'observer'])('%s preserves its existing home workspace', async role => {
        selectRole(role); show('/'); expect(await screen.findByText('today page')).toBeTruthy();
        expect(screen.queryByText('dashboard page')).toBeNull();
    });
    it('home follows the exact current business membership in a mixed-role account', async () => {
        state.memberships = [
            { businessId: 8, role: 'hotel_owner', capabilities: ['business.read', 'sales.read'] },
            { businessId: 7, role: 'observer', capabilities: ['business.read', 'sales.read'] },
        ];
        show('/'); expect(await screen.findByText('today page')).toBeTruthy();
        expect(screen.queryByText('dashboard page')).toBeNull();
    });
    it('legacy search and evidence URLs still open the selected client and source', async () => {
        show('/?client=exact%40chat&source=call-42#evidence');
        expect(await screen.findByText('today page ?client=exact%40chat&source=call-42')).toBeTruthy();
        expect(window.location.hash).toBe('#evidence');
        expect(screen.queryByText('dashboard page')).toBeNull();
    });
    it.each(['hotel_owner', 'sales_lead', 'manager', 'observer'])('%s retains explicit today deep links', async role => {
        selectRole(role); show('/today?client=exact%40chat&source=call-42');
        expect(await screen.findByText('today page ?client=exact%40chat&source=call-42')).toBeTruthy();
    });
    it('today preserves the existing sales fallback while disabled', async () => { state.workspace = false; show('/today'); expect(await screen.findByText('sales page')).toBeTruthy(); });
    it.each([['/sales', 'sales page'], ['/team', 'team page'], ['/autopilot', 'autopilot page'], ['/customers/exact%40chat', 'customer page']])('preserves %s', async (path, page) => {
        show(path); expect(await screen.findByText(page)).toBeTruthy();
    });
    it('new owner bootstrap still opens onboarding', async () => { state.businessId = null; state.memberships = []; state.bootstrap = true; show('/'); expect(await screen.findByText('onboarding page')).toBeTruthy(); });
    it.each(['/', '/today', '/team', '/sales', '/autopilot', '/customers/contact'])('does not mount protected content in an unrelated business at %s', async path => {
        state.businessId = 8; show(path); expect(await screen.findByText('Раздел недоступен')).toBeTruthy();
        expect(screen.queryByText(/dashboard page|today page|sales page|team page|autopilot page|customer page/)).toBeNull();
    });
    it('does not mount home while membership refresh is pending', () => { state.loading = true; show('/'); expect(screen.getByText('Проверяем доступ к бизнесу…')).toBeTruthy(); expect(screen.queryByText('dashboard page')).toBeNull(); });
    it.each(['hotel_owner', 'sales_lead', 'manager', 'observer'])('%s today requires exact membership and business read grant', role => {
        const auth: PermissionSession = { authenticated: true, role: 'customer', memberships: [{ businessId: 7, role, capabilities: ['business.read', 'sales.read'] }] };
        expect(canAccessRoute(auth, 7, '/today/?client=contact#source')).toBe(true);
        expect(canAccessRoute(auth, 8, '/today')).toBe(false);
        expect(canAccessRoute({ ...auth, permissionsLoading: true }, 7, '/today')).toBe(false);
        expect(canAccessRoute({ ...auth, memberships: [{ businessId: 7, role, capabilities: ['business.read'] }] }, 7, '/today')).toBe(true);
        expect(canAccessRoute({ ...auth, memberships: [{ businessId: 7, role, capabilities: ['sales.read'] }] }, 7, '/today')).toBe(false);
    });
});
