// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Sidebar from '../src/components/Sidebar';

const context = vi.hoisted(() => ({ businessId: null as number | null, canCreateBusiness: true, membershipActive: true, showGuide: true }));
vi.mock('../src/context/OnboardingContext', () => ({ useOnboarding: () => ({ showGuide: context.showGuide }) }));
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({
    instances: context.businessId ? [{ id: context.businessId, name: 'Мой бизнес' }] : [],
    currentInstanceId: context.businessId, currentInstance: context.businessId ? { id: context.businessId, name: 'Мой бизнес' } : null,
    setInstanceId: vi.fn(),
}) }));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({
    authenticated: true, permissionsLoading: false, userId: 'owner-user', displayName: 'Владелец',
    loginName: 'owner@example.test', role: 'customer', canCreateBusiness: context.canCreateBusiness,
    memberships: context.businessId && context.membershipActive ? [{ businessId: context.businessId, role: 'hotel_owner',
        capabilities: ['business.read', 'business.manage', 'team.read', 'team.manage', 'sales.read', 'sales.write', 'sales.assign', 'tasks.claim', 'tasks.manage', 'messages.send', 'ai.use'] }] : [], logout: vi.fn(),
}) }));

afterEach(() => { cleanup(); context.businessId = null; context.canCreateBusiness = true; context.membershipActive = true; context.showGuide = true; });

describe('onboarding navigation', () => {
    it('offers the guide before a business exists', () => {
        render(<MemoryRouter><Sidebar /></MemoryRouter>);
        expect(screen.getByRole('link', { name: 'Начало работы' }).getAttribute('href')).toBe('/getting-started');
    });

    it('does not offer first-business provisioning after access has been revoked', () => {
        context.canCreateBusiness = false;
        context.membershipActive = false;
        render(<MemoryRouter><Sidebar /></MemoryRouter>);
        expect(screen.queryByRole('link', { name: 'Начало работы' })).toBeNull();
        expect(screen.queryByRole('link', { name: 'Мои бизнесы' })).toBeNull();
        expect(screen.queryByRole('link', { name: 'Настройки бизнеса' })).toBeNull();
    });

    it('ignores a selected business whose membership is no longer present', () => {
        context.businessId = 7;
        context.canCreateBusiness = false;
        context.membershipActive = false;
        render(<MemoryRouter><Sidebar /></MemoryRouter>);
        expect(screen.queryByRole('link', { name: 'Настройки бизнеса' })).toBeNull();
        expect(screen.queryByRole('link', { name: 'Команда' })).toBeNull();
        expect(screen.queryByRole('link', { name: 'Начало работы' })).toBeNull();
    });

    it('removes the guide after server completion and keeps settings available', () => {
        context.businessId = 7;
        context.showGuide = false;
        render(<MemoryRouter><Sidebar /></MemoryRouter>);
        expect(screen.queryByRole('link', { name: 'Начало работы' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Ещё' }));
        expect(screen.getByRole('link', { name: 'Настройки бизнеса' })).toBeTruthy();
    });

    it('offers a pending owner the guide after a business is selected', () => {
        context.businessId = 7;
        render(<MemoryRouter><Sidebar /></MemoryRouter>);
        fireEvent.click(screen.getByRole('button', { name: 'Ещё' }));
        expect(screen.getByRole('link', { name: 'Начало работы' }).getAttribute('href')).toBe('/getting-started');
    });

});
