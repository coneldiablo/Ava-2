import { useAuth } from './context/AuthContext';
import { useInstance } from './context/InstanceContext';
import { getRoleWorkspace } from './workspaceNavigation';

export type Capability = 'business.read' | 'business.manage' | 'team.read' | 'team.manage'
    | 'sales.read' | 'sales.write' | 'sales.assign' | 'tasks.claim' | 'tasks.manage' | 'messages.send' | 'ai.use';
export type BusinessMembership = { businessId: number; role: string; capabilities?: string[] };
export type PermissionSession = {
    authenticated?: boolean;
    role?: string;
    memberships?: BusinessMembership[];
    permissionsLoading?: boolean;
    canCreateBusiness?: boolean;
};

const capabilityVocabulary = new Set<string>(['business.read', 'business.manage', 'team.read', 'team.manage', 'sales.read', 'sales.write', 'sales.assign', 'tasks.claim', 'tasks.manage', 'messages.send', 'ai.use']);
const businessRoles = new Set(['hotel_owner', 'sales_lead', 'manager', 'observer']);

export function getSessionMembership(auth: PermissionSession, businessId: number | null | undefined): BusinessMembership | null {
    if (!auth.authenticated || !Number.isSafeInteger(businessId) || Number(businessId) < 1) return null;
    return auth.memberships?.find(item => item.businessId === businessId && businessRoles.has(item.role)) ?? null;
}

// A snapshot can describe the mounted workspace while a fresh grant is pending.
export function getBusinessMembership(auth: PermissionSession, businessId: number | null | undefined): BusinessMembership | null {
    return auth.permissionsLoading ? null : getSessionMembership(auth, businessId);
}

export function hasCapability(auth: PermissionSession, businessId: number | null | undefined, capability: string): boolean {
    if (!capabilityVocabulary.has(capability)) return false;
    if (!auth.authenticated || auth.permissionsLoading) return false;
    if (auth.role === 'platform_admin') return true;
    return getBusinessMembership(auth, businessId)?.capabilities?.includes(capability) === true;
}

// Business workspaces authorize using the membership even for a platform operator.
export function hasMembershipCapability(auth: PermissionSession, businessId: number | null | undefined, capability: string): boolean {
    return capabilityVocabulary.has(capability) && getBusinessMembership(auth, businessId)?.capabilities?.includes(capability) === true;
}

export function isBusinessBootstrap(auth: PermissionSession, businessId: number | null | undefined): boolean {
    return auth.authenticated === true && !auth.permissionsLoading && auth.role !== 'platform_admin'
        && auth.canCreateBusiness === true && !businessId && auth.memberships?.length === 0;
}

const adminRoutes = new Set(['/', '/integrations', '/simulator', '/instances', '/conversations', '/leads', '/deals',
    '/opportunities', '/all-leads', '/clients', '/analytics', '/coffee', '/triggers', '/channels', '/knowledge-base',
    '/calls', '/quick-replies', '/team', '/activity']);
const readRoutes = new Set(['/clients', '/autopilot', '/sales', '/conversations', '/leads', '/deals', '/opportunities', '/all-leads', '/calls', '/activity', '/outbound', '/quick-replies']);
const ownerRoutes = new Set(['/channels', '/instances', '/triggers', '/simulator', '/getting-started']);
const aiRoutes = new Set(['/business-gpt', '/studio', '/knowledge-base']);

export function canAccessRoute(auth: PermissionSession, businessId: number | null | undefined, path: string): boolean {
    if (!auth.authenticated || auth.permissionsLoading) return false;
    const pathname = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
    const clientRoute = /^\/(?:client|customers)\/[^/]+$/.test(pathname);
    if (auth.role === 'platform_admin') {
        if (pathname === '/today' || pathname === '/outbound') return getSessionMembership(auth, businessId)?.capabilities?.includes('sales.read') === true;
        return adminRoutes.has(pathname) || clientRoute;
    }
    if (isBusinessBootstrap(auth, businessId)) return ['/', '/getting-started', '/instances'].includes(pathname);
    if (!hasCapability(auth, businessId, 'business.read')) return false;
    if (pathname === '/' || pathname === '/today' || pathname === '/integrations' || pathname === '/assistant-builder') return true;
    if (clientRoute || readRoutes.has(pathname)) return hasCapability(auth, businessId, 'sales.read');
    if (pathname === '/team') return hasCapability(auth, businessId, 'team.read');
    if (ownerRoutes.has(pathname)) return hasCapability(auth, businessId, 'business.manage');
    if (aiRoutes.has(pathname)) return hasCapability(auth, businessId, 'ai.use');
    if (pathname === '/workspace-analytics') return hasCapability(auth, businessId, 'sales.assign');
    if (pathname === '/analytics' || pathname === '/reports') {
        const role = getBusinessMembership(auth, businessId)?.role;
        return ['hotel_owner', 'sales_lead'].includes(role ?? '') && hasCapability(auth, businessId, 'sales.read');
    }
    return false;
}

export function getBusinessLanding(auth: PermissionSession, businessId: number | null | undefined): string {
    if (isBusinessBootstrap(auth, businessId)) return '/getting-started';
    const role = auth.role === 'platform_admin' ? auth.role : getBusinessMembership(auth, businessId)?.role;
    const landing = getRoleWorkspace(role).landing;
    return canAccessRoute(auth, businessId, landing) ? landing : '/';
}

export function getWorkspaceLabel(auth: PermissionSession, businessId: number | null | undefined): string {
    const role = auth.role === 'platform_admin' ? auth.role : getSessionMembership(auth, businessId)?.role;
    return getRoleWorkspace(role).label;
}

export function useBusinessAccess({ membershipOnly = false }: { membershipOnly?: boolean } = {}) {
    const auth = useAuth();
    const { currentInstanceId } = useInstance();
    const membership = getSessionMembership(auth, currentInstanceId);
    return { checking: Boolean(auth.permissionsLoading), role: membership?.role ?? '', userId: auth.userId, membership,
        isPlatformAdmin: auth.authenticated && !auth.permissionsLoading && auth.role === 'platform_admin',
        can: (capability: string) => membershipOnly ? hasMembershipCapability(auth, currentInstanceId, capability) : hasCapability(auth, currentInstanceId, capability) };
}
