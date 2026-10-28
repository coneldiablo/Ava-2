import { describe, expect, it } from 'vitest';
import { canAccessRoute, getBusinessLanding, getBusinessMembership, hasCapability, hasMembershipCapability, isBusinessBootstrap, type PermissionSession } from './permissions';

const read = ['business.read', 'sales.read', 'team.read'];
const sessions: Record<string, PermissionSession> = {
    hotel_owner: { authenticated: true, role: 'customer', memberships: [{ businessId: 7, role: 'hotel_owner', capabilities: [...read, 'business.manage', 'team.manage', 'sales.write', 'sales.assign', 'tasks.claim', 'tasks.manage', 'messages.send', 'ai.use'] }] },
    sales_lead: { authenticated: true, role: 'customer', memberships: [{ businessId: 7, role: 'sales_lead', capabilities: [...read, 'sales.write', 'sales.assign', 'tasks.claim', 'tasks.manage', 'messages.send', 'ai.use'] }] },
    manager: { authenticated: true, role: 'customer', memberships: [{ businessId: 7, role: 'manager', capabilities: [...read, 'sales.write', 'tasks.claim', 'messages.send', 'ai.use'] }] },
    observer: { authenticated: true, role: 'customer', memberships: [{ businessId: 7, role: 'observer', capabilities: read }] },
};

describe('business capability and route policy', () => {
    it.each(Object.keys(sessions))('allows current %s sales reads and exact customer links', role => {
        const auth = sessions[role];
        for (const path of ['/', '/sales', '/conversations', '/leads', '/deals', '/all-leads', '/team', '/calls', '/customers/contact%40chat', '/client/contact']) expect(canAccessRoute(auth, 7, path)).toBe(true);
        expect(canAccessRoute(auth, 8, '/sales')).toBe(false);
        expect(getBusinessMembership(auth, 8)).toBeNull();
    });
    it.each(['sales_lead', 'manager', 'observer'])('blocks %s owner configuration via direct URL', role => {
        for (const path of ['/channels', '/instances', '/triggers', '/simulator', '/getting-started']) expect(canAccessRoute(sessions[role], 7, path)).toBe(false);
    });
    it.each(['sales_lead', 'manager', 'observer'])('allows %s to read business and assistant settings only in their own business', role => {
        for (const path of ['/integrations', '/assistant-builder']) {
            expect(canAccessRoute(sessions[role], 7, path)).toBe(true);
            expect(canAccessRoute(sessions[role], 8, path)).toBe(false);
            expect(canAccessRoute({ ...sessions[role], permissionsLoading: true }, 7, path)).toBe(false);
        }
        expect(hasCapability(sessions[role], 7, 'business.manage')).toBe(false);
    });
    it('allows owner configuration and supervisor reports only with live capabilities', () => {
        expect(canAccessRoute(sessions.hotel_owner, 7, '/channels')).toBe(true);
        expect(canAccessRoute(sessions.sales_lead, 7, '/reports')).toBe(true);
        expect(canAccessRoute(sessions.manager, 7, '/reports')).toBe(false);
        expect(canAccessRoute(sessions.observer, 7, '/analytics')).toBe(false);
        expect(canAccessRoute({ ...sessions.hotel_owner, memberships: [{ businessId: 7, role: 'hotel_owner', capabilities: read }] }, 7, '/channels')).toBe(false);
    });
    it('blocks observer mutations and every AI surface', () => {
        for (const capability of ['sales.write', 'messages.send', 'ai.use', 'tasks.claim', 'tasks.manage'] as const) expect(hasCapability(sessions.observer, 7, capability)).toBe(false);
        for (const path of ['/business-gpt', '/studio', '/knowledge-base', '/simulator']) expect(canAccessRoute(sessions.observer, 7, path)).toBe(false);
    });
    it('does not derive grants from a stored role, missing capabilities, or stale refresh', () => {
        const missing = { authenticated: true, role: 'customer', memberships: [{ businessId: 7, role: 'hotel_owner' }] };
        expect(hasCapability(missing, 7, 'business.manage')).toBe(false);
        expect(canAccessRoute(missing, 7, '/')).toBe(false);
        expect(hasCapability({ ...sessions.hotel_owner, permissionsLoading: true }, 7, 'ai.use')).toBe(false);
        expect(canAccessRoute({ ...sessions.hotel_owner, authenticated: false }, 7, '/channels')).toBe(false);
    });
    it('preserves explicit platform operator routes and rejects unknown paths', () => {
        const admin = { authenticated: true, role: 'platform_admin' };
        expect(canAccessRoute(admin, null, '/integrations')).toBe(true);
        expect(canAccessRoute(admin, null, '/client/person')).toBe(true);
        expect(canAccessRoute(admin, null, '/business-gpt')).toBe(false);
        expect(canAccessRoute(sessions.hotel_owner, 7, '/not-a-route')).toBe(false);
    });
    it('accepts bounded pathname forms but rejects broader customer path matches', () => {
        expect(canAccessRoute(sessions.manager, 7, '/customers/name/?draft=123#notes')).toBe(true);
        expect(canAccessRoute(sessions.manager, 7, '/customers/name/admin')).toBe(false);
    });
    it('rejects unknown capabilities and role names even when present in a malformed session', () => {
        expect(hasCapability({ authenticated: true, role: 'platform_admin' }, 7, 'invented.action')).toBe(false);
        expect(hasCapability({ authenticated: true, role: 'customer', memberships: [{ businessId: 7, role: 'unknown_role', capabilities: ['business.manage'] }] }, 7, 'business.manage')).toBe(false);
    });
    it('sets employee landing and gates bootstrap on an explicit backend grant', () => {
        expect(getBusinessLanding(sessions.hotel_owner, 7)).toBe('/');
        for (const role of ['manager', 'sales_lead', 'observer']) expect(getBusinessLanding(sessions[role], 7)).toBe('/today');
        expect(getBusinessLanding({ ...sessions.manager, permissionsLoading: true }, 7)).toBe('/');
        expect(getBusinessLanding(sessions.manager, 8)).toBe('/');
        const revoked = { authenticated: true, role: 'customer', memberships: [] };
        expect(isBusinessBootstrap(revoked, null)).toBe(false);
        expect(canAccessRoute(revoked, null, '/instances')).toBe(false);
        const bootstrap = { ...revoked, canCreateBusiness: true };
        expect(getBusinessLanding(bootstrap, null)).toBe('/getting-started');
        expect(canAccessRoute(bootstrap, null, '/instances')).toBe(true);
        expect(canAccessRoute(bootstrap, null, '/channels')).toBe(false);
        expect(canAccessRoute(bootstrap, 7, '/instances')).toBe(false);
    });
});


describe('operator business workspace boundary', () => {
    it('requires an actual scoped membership while keeping operator tools available', () => {
        const operator = { authenticated: true, role: 'platform_admin', memberships: [] };
        expect(canAccessRoute(operator, 7, '/today')).toBe(false);
        expect(canAccessRoute(operator, 7, '/outbound')).toBe(false);
        expect(canAccessRoute(operator, 7, '/conversations')).toBe(true);
        const member = { ...operator, memberships: [{ businessId: 7, role: 'manager', capabilities: ['sales.read'] }] };
        expect(canAccessRoute(member, 7, '/today')).toBe(true);
        expect(canAccessRoute(member, 7, '/outbound')).toBe(true);
        expect(canAccessRoute(member, 8, '/today')).toBe(false);
        expect(hasMembershipCapability(member, 7, 'sales.assign')).toBe(false);
        expect(hasMembershipCapability(member, 7, 'sales.read')).toBe(true);
        expect(hasCapability(operator, 7, 'sales.assign')).toBe(true); // operator tools retain their platform policy
        expect(hasMembershipCapability(operator, 7, 'sales.assign')).toBe(false);
    });
});
