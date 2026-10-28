// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import Sidebar from './Sidebar';
import QuickJump from './QuickJump';
import Layout from './Layout';

const shared = vi.hoisted(() => ({ businessId: 7 as number | null, loading: false, role: 'manager', capabilities: ['business.read', 'team.read', 'sales.read', 'sales.write', 'tasks.claim', 'messages.send', 'ai.use'], mounts: 0 }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ authenticated: true, role: 'customer', permissionsLoading: shared.loading, userId: 'employee', loginName: 'employee@example.test', displayName: 'Анна', logout: vi.fn(),
    memberships: [{ businessId: shared.businessId, role: shared.role, capabilities: shared.capabilities }] }) }));
vi.mock('../context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: shared.businessId, currentInstance: shared.businessId ? { id: shared.businessId, name: 'Бизнес' } : null, instances: shared.businessId ? [{ id: shared.businessId, name: 'Бизнес' }] : [], setInstanceId: vi.fn() }) }));
vi.mock('../hooks/useReleaseFlags', () => ({ useReleaseFlags: () => ({ data: { success: true, businessId: shared.businessId, revision: 1, flags: { workspace: true, analytics: true, autopilot: true } }, loading: false, error: '', checking: false, canRead: true, reload: vi.fn() }) }));
const selectionMounted = vi.fn();
function SelectionProbe() {
    const { search } = useLocation(); const businessId = shared.businessId;
    useEffect(() => { selectionMounted(businessId, search); }, [businessId, search]);
    return <span data-testid="selection-scope">{businessId}:{search}</span>;
}
function Probe() { const instance = ++shared.mounts; return <span>Страница {instance}</span>; }

describe('visible navigation follows route permissions', () => {
    beforeEach(() => { shared.businessId = 7; shared.loading = false; shared.role = 'manager'; shared.capabilities = ['business.read', 'team.read', 'sales.read', 'sales.write', 'tasks.claim', 'messages.send', 'ai.use']; shared.mounts = 0; selectionMounted.mockClear(); });
    afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
    it('shows employee workspace, team and read-only settings while omitting owner actions', () => {
        render(<MemoryRouter><Sidebar /></MemoryRouter>);
        expect(screen.getByRole('link', { name: 'Мой день' })).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Ещё' }));
        expect(screen.getByRole('link', { name: 'Команда' })).toBeTruthy();
        expect(screen.queryByRole('link', { name: 'Каналы связи' })).toBeNull();
        expect(screen.getByRole('link', { name: 'Настройки бизнеса' }).getAttribute('href')).toBe('/integrations');
        expect(screen.queryByRole('link', { name: 'Отчёты' })).toBeNull();
        expect(screen.getByText('Анна')).toBeTruthy();
    });
    it('offers exactly the same restricted routes in the quick picker', () => {
        shared.role = 'observer'; shared.capabilities = ['business.read', 'team.read', 'sales.read'];
        render(<MemoryRouter><QuickJump open onClose={() => {}} /></MemoryRouter>);
        const dialog = within(screen.getByRole('dialog'));
        expect(dialog.getByRole('button', { name: 'Рабочее пространство Обзор' })).toBeTruthy();
        expect(dialog.queryByRole('button', { name: /Материалы и предложения|Помощник по бизнесу|Каналы связи|База знаний/ })).toBeNull();
        expect(dialog.getByRole('button', { name: 'Настройки Команда' })).toBeTruthy();
        expect(dialog.getByRole('button', { name: 'Настройки Настройки бизнеса' })).toBeTruthy();
        expect(dialog.queryByRole('button', { name: /Инструкции по ссылкам/ })).toBeNull();
    });
    it('offers owner priorities and always exposes other allowed tools through More', () => {
        shared.role = 'hotel_owner'; shared.capabilities.push('business.manage', 'team.manage', 'sales.assign');
        render(<MemoryRouter><Sidebar /></MemoryRouter>);
        const primary = within(document.querySelector<HTMLElement>('.crm-nav-primary')!);
        expect(primary.getAllByRole('link').map(link => link.textContent)).toEqual(['Главная', 'Сегодня', 'Клиенты', 'Сделки', 'Результаты']);
        expect(primary.getByRole('link', { name: 'Сегодня' }).getAttribute('href')).toBe('/today');
        expect(screen.queryByRole('link', { name: 'Обращения' })).toBeNull();
        expect(primary.getByRole('link', { name: 'Сделки' }).getAttribute('href')).toBe('/deals');
        expect(screen.queryByRole('link', { name: 'Каналы связи' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Ещё' }));
        expect(screen.getByRole('link', { name: 'Каналы связи' })).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Настройки бизнеса' })).toBeTruthy();
    });
    it.each(['/', '/clients', '/today'])('keeps all allowed tools discoverable from %s without guessing another URL', path => {
        render(<MemoryRouter initialEntries={[path]}><Sidebar /></MemoryRouter>);
        const more = screen.getByRole('button', { name: 'Ещё' });
        if (more.getAttribute('aria-expanded') === 'false') fireEvent.click(more);
        expect(screen.getByRole('link', { name: 'История звонков' }).getAttribute('href')).toBe('/calls');
        expect(screen.getByRole('link', { name: 'Сделки' }).getAttribute('href')).toBe('/deals');
        expect(screen.queryByRole('link', { name: 'Клиенты по этапам' })).toBeNull();
        expect(screen.getByRole('link', { name: 'База знаний' }).getAttribute('href')).toBe('/knowledge-base');
        expect(screen.getByRole('link', { name: 'Задачи' }).getAttribute('href')).toBe('/sales');
        expect(screen.queryByRole('link', { name: 'Каналы связи' })).toBeNull();
    });
    it.each([['manager', 'Мой день'], ['sales_lead', 'Сегодня'], ['observer', 'Обзор']])('agrees on the %s workday label in menu, search and header', (role, label) => {
        shared.role = role;
        if (role === 'observer') shared.capabilities = ['business.read', 'team.read', 'sales.read'];
        render(<MemoryRouter initialEntries={['/today']}><Routes><Route element={<Layout />}><Route path="today" element={<Probe />} /></Route></Routes></MemoryRouter>);
        expect(screen.getByRole('link', { name: label }).getAttribute('aria-current')).toBe('page');
        expect(document.title).toBe(`${label} · AVA`);
        fireEvent.click(screen.getByRole('button', { name: 'Поиск и переход' }));
        expect(screen.getByRole('button', { name: `Рабочее пространство ${label}` })).toBeTruthy();
    });
    it('keeps the task route and task title distinct from the workday', () => {
        render(<MemoryRouter initialEntries={['/sales']}><Routes><Route element={<Layout />}><Route path="sales" element={<Probe />} /></Route></Routes></MemoryRouter>);
        expect(screen.getByRole('link', { name: 'Задачи' }).getAttribute('aria-current')).toBe('page');
        expect(document.title).toBe('Задачи · AVA');
    });
    it('hides and disables the closed mobile drawer for keyboard and assistive technology', () => {
        vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
        const view = render(<MemoryRouter><Sidebar /></MemoryRouter>);
        const drawer = document.querySelector<HTMLElement>('.crm-sidebar')!;
        expect(drawer.inert).toBe(true);
        expect(drawer.getAttribute('aria-hidden')).toBe('true');
        expect(screen.queryByRole('link', { name: 'Мой день' })).toBeNull();
        view.rerender(<MemoryRouter><Sidebar open /></MemoryRouter>);
        expect(drawer.inert).toBe(false);
        expect(drawer.getAttribute('aria-hidden')).toBeNull();
        expect(screen.getByRole('link', { name: 'Мой день' })).toBeTruthy();
    });
    it('moves mobile menu focus only after inert state and drawer visibility frames are committed', () => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        render(<MemoryRouter><Routes><Route element={<Layout />}><Route path="/" element={<Probe />} /></Route></Routes></MemoryRouter>);
        const opener = screen.getByRole('button', { name: 'Открыть меню' });
        const close = document.querySelector<HTMLButtonElement>('.crm-sidebar-close')!;
        const main = document.querySelector<HTMLElement>('.crm-shell-main')!;
        opener.focus(); fireEvent.click(opener);
        expect(main.inert).toBe(true); expect(document.activeElement).not.toBe(close);
        act(() => { frames.shift()?.(0); });
        expect(document.activeElement).not.toBe(close);
        act(() => { frames.shift()?.(16); });
        expect(document.activeElement).toBe(close);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(main.inert).toBe(false); expect(document.activeElement).toBe(opener);
    });
    it.each(['/', '/conversations'])('clears the old customer selection before mounting business %s after a switch', (path) => {
        const search = '?client=old-client&source=message-1&q=old-filter&view=team&page=3&keep=1';
        const tree = <MemoryRouter initialEntries={[`${path}${search}`]}><Routes><Route element={<Layout />}><Route path={path} element={<SelectionProbe />} /></Route></Routes></MemoryRouter>;
        const view = render(tree);
        expect(selectionMounted).toHaveBeenCalledWith(7, search);
        shared.businessId = 8;
        view.rerender(<MemoryRouter initialEntries={[`${path}${search}`]}><Routes><Route element={<Layout />}><Route path={path} element={<SelectionProbe />} /></Route></Routes></MemoryRouter>);
        expect(screen.getByTestId('selection-scope').textContent).toBe('8:?keep=1');
        expect(selectionMounted).toHaveBeenCalledWith(8, '?keep=1');
        expect(selectionMounted.mock.calls.filter(([businessId, query]) => businessId === 8 && query.includes('old-client'))).toEqual([]);
    });
    it.each(['/', '/conversations'])('preserves the deep link during initial business hydration on %s and clears a later switch through null', (path) => {
        shared.businessId = null; shared.loading = true;
        const search = '?client=79990000001%40c.us&source=fixture-call-source&q=initial&view=mine&page=1&keep=1';
        const tree = <MemoryRouter initialEntries={[`${path}${search}`]}><Routes><Route element={<Layout />}><Route path={path} element={<SelectionProbe />} /></Route></Routes></MemoryRouter>;
        const view = render(tree);
        shared.businessId = 7; shared.loading = false;
        view.rerender(<MemoryRouter initialEntries={[`${path}${search}`]}><Routes><Route element={<Layout />}><Route path={path} element={<SelectionProbe />} /></Route></Routes></MemoryRouter>);
        expect(screen.getByTestId('selection-scope').textContent).toBe(`7:${search}`);
        expect(selectionMounted).toHaveBeenCalledWith(7, search);
        shared.businessId = null; shared.loading = true;
        view.rerender(<MemoryRouter initialEntries={[`${path}${search}`]}><Routes><Route element={<Layout />}><Route path={path} element={<SelectionProbe />} /></Route></Routes></MemoryRouter>);
        shared.businessId = 8; shared.loading = false;
        view.rerender(<MemoryRouter initialEntries={[`${path}${search}`]}><Routes><Route element={<Layout />}><Route path={path} element={<SelectionProbe />} /></Route></Routes></MemoryRouter>);
        expect(screen.getByTestId('selection-scope').textContent).toBe('8:?keep=1');
        expect(selectionMounted.mock.calls.filter(([businessId, query]) => businessId === 8 && query.includes('79990000001'))).toEqual([]);
    });
    it('remounts the rendered page when business or capabilities change', () => {
        const view = render(<MemoryRouter><Routes><Route element={<Layout />}><Route path="/" element={<Probe />} /></Route></Routes></MemoryRouter>);
        expect(screen.getByText('Страница 1')).toBeTruthy();
        shared.businessId = 8; view.rerender(<MemoryRouter><Routes><Route element={<Layout />}><Route path="/" element={<Probe />} /></Route></Routes></MemoryRouter>);
        expect(screen.getByText('Страница 2')).toBeTruthy();
        shared.role = 'observer'; shared.capabilities = ['business.read', 'sales.read', 'team.read'];
        view.rerender(<MemoryRouter><Routes><Route element={<Layout />}><Route path="/" element={<Probe />} /></Route></Routes></MemoryRouter>);
        expect(screen.getByText('Страница 3')).toBeTruthy();
    });
});
