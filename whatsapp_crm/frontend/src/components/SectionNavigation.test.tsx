// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import SectionNavigation from './SectionNavigation';
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ authenticated: true, role: 'customer', memberships: [{ businessId: 7, role: 'hotel_owner', capabilities: ['business.read', 'sales.read', 'sales.assign', 'business.manage'] }] }) }));
vi.mock('../context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId: 7 }) }));
afterEach(cleanup);
function Location() { const location = useLocation(); return <output>{location.pathname + location.search}</output>; }
describe('grouped product views', () => {
    it('preserves the selected results period and marks the current view after navigation', () => {
        render(<MemoryRouter initialEntries={['/analytics?days=7']}><SectionNavigation /><Location /></MemoryRouter>);
        expect(screen.getByRole('link', { name: 'Обзор' }).getAttribute('aria-current')).toBe('page');
        fireEvent.click(screen.getByRole('link', { name: 'Отчёты' }));
        expect(screen.getByText('/reports?days=7')).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Отчёты' }).getAttribute('aria-current')).toBe('page');
    });
    it('keeps deal and client pipelines distinct without leaking filters between entities', () => {
        render(<MemoryRouter initialEntries={['/deals?stage=proposal']}><SectionNavigation /><Location /></MemoryRouter>);
        fireEvent.click(screen.getByRole('link', { name: 'Клиенты по этапам' }));
        expect(screen.getByText('/leads')).toBeTruthy();
    });
});
