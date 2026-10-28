// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from '../src/App';
import { onboardingSteps } from '../src/onboardingApi';
const fixture = vi.hoisted(() => ({ businessId: 7, role: 'customer', membershipRole: 'hotel_owner', workspace: true }));
vi.mock('../src/context/AuthContext', () => ({ AuthProvider: ({ children }: { children: React.ReactNode }) => children,
    useAuth: () => ({ authenticated: true, loading: false, permissionsLoading: false, role: fixture.role,
        memberships: fixture.role === 'platform_admin' ? [] : [{ businessId: 7, role: fixture.membershipRole, capabilities: ['business.read', 'sales.read', 'business.manage', 'sales.assign', 'team.read', 'ai.use'] }], logout: vi.fn() }) }));
vi.mock('../src/context/InstanceContext', () => ({ InstanceProvider: ({ children }: { children: React.ReactNode }) => children,
    useInstance: () => ({ currentInstanceId: fixture.businessId, currentInstance: { id: fixture.businessId, name: 'Business' },
        instances: [{ id: 7, name: 'Business' }, { id: 8, name: 'Other business' }], instancesState: 'ready', setInstanceId: vi.fn() }) }));
vi.mock('../src/components/ReleaseGate', () => ({ default: ({ children, fallback }: { children: React.ReactNode; fallback: React.ReactNode }) => fixture.workspace ? children : fallback }));
vi.mock('../src/hooks/useReleaseFlags', () => ({ useReleaseFlags: () => ({ data: { flags: { workspace: false } } }) }));
vi.mock('../src/pages/Dashboard', () => ({ default: () => <div>Business dashboard</div> }));
vi.mock('../src/pages/TodayWorkspace', () => ({ default: () => <div>Personal workspace</div> }));
vi.mock('../src/pages/Conversations', () => ({ default: () => <div>Operator inbox</div> }));
vi.mock('../src/pages/SalesWorkspace', () => ({ default: () => <div>Sales fallback</div> }));
vi.mock('../src/pages/Analytics', () => ({ default: () => <div>Analytics</div> }));
beforeEach(() => { fixture.businessId = 7; fixture.role = 'customer'; fixture.membershipRole = 'hotel_owner'; fixture.workspace = true;
    window.history.replaceState(null, '', '/'); sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/businesses/7/onboarding' && init?.method === 'GET') return { ok: true, status: 200, json: async () => ({
            success: true, onboarding: { businessId: 7, status: 'completed', confirmedSteps: [...onboardingSteps], completedAt: '2026-10-10T09:00:00.000Z' },
        }) };
        throw new Error(`Unexpected request: ${url}`);
    }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = async () => { const view = render(<App />); await act(async () => {}); return view; };
describe('home and workday routing', () => {
    it.each(['hotel_owner', 'platform_admin'])('restores dashboard home for %s', async role => {
        if (role === 'platform_admin') fixture.role = role; else fixture.membershipRole = role;
        await mount(); expect(await screen.findByText('Business dashboard')).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Главная' }).getAttribute('aria-current')).toBe('page');
        fireEvent.click(screen.getByRole('button', { name: 'Ещё' }));
        if (role === 'platform_admin') expect(screen.queryByRole('link', { name: 'Рабочий день' })).toBeNull();
        else expect(screen.getByRole('link', { name: 'Сегодня' }).getAttribute('href')).toBe('/today');
    });
    it.each(['sales_lead', 'manager', 'observer'])('redirects the common home to the role workday for %s', async role => {
        fixture.membershipRole = role; await mount(); expect(await screen.findByText('Personal workspace')).toBeTruthy();
        expect(screen.queryByText('Business dashboard')).toBeNull();
        expect(window.location.pathname).toBe('/today');
    });
    it.each(['hotel_owner', 'sales_lead', 'manager', 'observer', 'platform_admin'])('opens workday deep links for %s', async role => {
        if (role === 'platform_admin') fixture.role = role; else fixture.membershipRole = role;
        window.history.replaceState(null, '', '/today?client=client&view=mine'); await mount();
        if (role === 'platform_admin') { expect(await screen.findByText('Раздел недоступен')).toBeTruthy(); return; }
        expect(await screen.findByText('Personal workspace')).toBeTruthy();
        const label = role === 'manager' ? 'Мой день' : role === 'observer' ? 'Обзор' : role === 'platform_admin' ? 'Рабочий день' : 'Сегодня';
        expect(screen.getByRole('link', { name: label }).getAttribute('aria-current')).toBe('page');
        expect(document.querySelector('a[href="/"][aria-current="page"]')).toBeNull();
        expect(window.location.search).toBe('?client=client&view=mine');
    });
    it.each(['hotel_owner', 'sales_lead', 'manager', 'observer', 'platform_admin'])('opens saved legacy client URLs for %s', async role => {
        if (role === 'platform_admin') fixture.role = role; else fixture.membershipRole = role;
        window.history.replaceState(null, '', '/?client=a%2Fb&source=42#aw-source-42'); await mount();
        if (role === 'platform_admin') { expect(await screen.findByText('Operator inbox')).toBeTruthy(); expect(window.location.pathname + window.location.search + window.location.hash).toBe('/conversations?client=a%2Fb&source=42#aw-source-42'); return; }
        expect(await screen.findByText('Personal workspace')).toBeTruthy();
        expect(window.location.pathname + window.location.search + window.location.hash).toBe('/today?client=a%2Fb&source=42#aw-source-42');
    });
    it('uses sales fallback when workspace is disabled', async () => {
        fixture.workspace = false; window.history.replaceState(null, '', '/today'); await mount(); expect(await screen.findByText('Sales fallback')).toBeTruthy();
    });
    it('preserves quick navigation, back and reload at the workday URL', async () => {
        const view = await mount(); fireEvent.click(screen.getByRole('button', { name: 'Поиск и переход' }));
        fireEvent.click(screen.getByRole('button', { name: /Рабочее пространство Сегодня/ }));
        expect(await screen.findByText('Personal workspace')).toBeTruthy();
        view.unmount(); await mount(); expect(await screen.findByText('Personal workspace')).toBeTruthy();
        await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)); });
        expect(await screen.findByText('Business dashboard')).toBeTruthy(); expect(window.location.pathname).toBe('/');
    });
    it('changes owner home to personal home after membership changes', async () => {
        const view = await mount(); expect(await screen.findByText('Business dashboard')).toBeTruthy();
        fixture.membershipRole = 'manager'; view.rerender(<App />); expect(await screen.findByText('Personal workspace')).toBeTruthy();
        expect(screen.queryByText('Business dashboard')).toBeNull();
    });
    it.each(['/', '/today'])('blocks access after switching to an unauthorized business on %s', async path => {
        window.history.replaceState(null, '', path); const view = await mount(); fixture.businessId = 8; view.rerender(<App />);
        expect(await screen.findByText('Раздел недоступен')).toBeTruthy(); expect(screen.queryByText('Business dashboard')).toBeNull();
        expect(screen.queryByText('Personal workspace')).toBeNull(); expect(screen.queryByRole('link', { name: 'Рабочий день' })).toBeNull();
    });
    it('clears client context when switching businesses on the workday route', async () => {
        window.history.replaceState(null, '', '/today?client=old&source=42&q=old&view=mine&page=2&keep=yes');
        const view = await mount(); fixture.businessId = 8; view.rerender(<App />);
        await act(async () => {}); expect(window.location.search).toBe('?keep=yes');
    });
    it.each([['/', 'Главная'], ['/today', 'Сегодня']])('labels the document for %s without repeating the page heading', async (path, title) => {
        window.history.replaceState(null, '', path); await mount(); expect(document.title).toBe(`${title} · AVA`);
    });
    it('renders each destination once for admin analytics navigation', async () => {
        fixture.role = 'platform_admin'; window.history.replaceState(null, '', '/analytics'); await mount();
        const links = Array.from(document.querySelectorAll('nav a')).map(link => link.getAttribute('href'));
        expect(new Set(links).size).toBe(links.length);
    });
});
