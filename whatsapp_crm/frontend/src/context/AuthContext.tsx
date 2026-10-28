import { createContext, useContext, useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { getAuthSession, login as loginRequest, logout as logoutRequest } from '../api';
import type { BusinessMembership } from '../permissions';
import { clearWorkspaceDrafts } from '../hooks/useScopedDraft';

interface AuthContextValue {
    authenticated: boolean;
    loading: boolean;
    permissionsLoading: boolean;
    permissionsError: string;
    loginName: string;
    displayName: string;
    userId: string | null;
    role: string;
    memberships: BusinessMembership[];
    canCreateBusiness: boolean;
    refreshAuth: () => Promise<void>;
    login: (login: string, password: string) => Promise<void>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const emptySession = { authenticated: false, loginName: '', displayName: '', userId: null as string | null,
    role: 'customer', memberships: [] as BusinessMembership[], canCreateBusiness: false };

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [session, setSession] = useState(emptySession);
    const [loading, setLoading] = useState(true);
    const [permissionsLoading, setPermissionsLoading] = useState(true);
    const [permissionsError, setPermissionsError] = useState('');
    const revision = useRef(0);
    const authenticatedRef = useRef(false);
    const hadMembership = useRef(false);
    const identity = useRef<string | null>(null);
    const refreshAuth = useCallback(async () => {
        const request = ++revision.current;
        setPermissionsLoading(true); setPermissionsError('');
        let confirmed = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const data = await Promise.race([getAuthSession(), new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error('SESSION_REFRESH_TIMEOUT')), 15000);
            })]);
            if (request !== revision.current) return;
            const authenticated = data.authenticated === true;
            const userId = typeof (data.userId ?? data.user_id) === 'string' ? (data.userId ?? data.user_id) : null;
            if ((identity.current !== null && identity.current !== userId) || !authenticated) {
                clearWorkspaceDrafts(); hadMembership.current = false;
            }
            identity.current = authenticated ? userId : null;
            const memberships: BusinessMembership[] = authenticated && Array.isArray(data.memberships)
                ? data.memberships.filter((item: BusinessMembership) => Number.isSafeInteger(item.businessId) && item.businessId > 0
                    && typeof item.role === 'string').map((item: BusinessMembership) => ({ businessId: item.businessId,
                    role: item.role, capabilities: Array.isArray(item.capabilities) ? item.capabilities.filter(value => typeof value === 'string') : [] })) : [];
            if (memberships.length) hadMembership.current = true;
            authenticatedRef.current = authenticated;
            setSession(authenticated ? {
                authenticated, loginName: typeof data.login === 'string' ? data.login : '',
                displayName: typeof data.displayName === 'string' ? data.displayName : '',
                userId,
                role: typeof data.role === 'string' ? data.role : 'customer', memberships,
                canCreateBusiness: data.canCreateBusiness === true && !hadMembership.current,
            } : emptySession);
            confirmed = true;
        } catch (error) {
            if (request === revision.current) {
                const status = (error as { response?: { status?: number } })?.response?.status;
                if (status === 401 || status === 403 || !authenticatedRef.current) {
                    authenticatedRef.current = false; identity.current = null;
                    clearWorkspaceDrafts(); setSession(emptySession);
                } else {
                    // Retain the last read-only snapshot; no mutation has a live grant until retry succeeds.
                    setPermissionsError('Не удалось проверить права. Введённые данные сохранены; повторите проверку перед действием.');
                }
            }
            throw error;
        } finally {
            clearTimeout(timeout);
            if (request === revision.current) { setPermissionsLoading(!confirmed && authenticatedRef.current); setLoading(false); }
        }
    }, []);

    useEffect(() => {
        void refreshAuth().catch(() => { /* Authentication failure leaves access closed. */ });
        const handleUnauthorized = () => {
            ++revision.current;
            authenticatedRef.current = false;
            identity.current = null; clearWorkspaceDrafts();
            setSession(emptySession);
            setPermissionsLoading(false); setPermissionsError('');
            setLoading(false);
        };
        const handleRefresh = () => {
            if (authenticatedRef.current) void refreshAuth().catch(() => { /* A transient failure retains the locked snapshot. */ });
        };
        const handleVisibility = () => { if (document.visibilityState === 'visible') handleRefresh(); };
        window.addEventListener('crm:unauthorized', handleUnauthorized);
        window.addEventListener('crm:forbidden', handleRefresh);
        window.addEventListener('focus', handleRefresh);
        document.addEventListener('visibilitychange', handleVisibility);
        return () => {
            ++revision.current;
            window.removeEventListener('crm:unauthorized', handleUnauthorized);
            window.removeEventListener('crm:forbidden', handleRefresh);
            window.removeEventListener('focus', handleRefresh);
            document.removeEventListener('visibilitychange', handleVisibility);
        };
    }, [refreshAuth]);

    const login = useCallback(async (loginValue: string, password: string) => {
        const request = ++revision.current;
        await loginRequest(loginValue, password);
        if (request !== revision.current) return;
        clearWorkspaceDrafts(); identity.current = null;
        authenticatedRef.current = false; setSession(emptySession);
        hadMembership.current = false;
        await refreshAuth();
    }, [refreshAuth]);

    const logout = useCallback(async () => {
        ++revision.current;
        authenticatedRef.current = false;
        identity.current = null; clearWorkspaceDrafts();
        setSession(emptySession);
        setPermissionsLoading(false); setPermissionsError('');
        hadMembership.current = false;
        try {
            const result = await logoutRequest();
            if (result.logout_url) window.location.assign(result.logout_url);
        } finally { setSession(emptySession); }
    }, []);

    const value = useMemo(() => ({ ...session, loading, permissionsLoading, permissionsError, refreshAuth, login, logout }),
        [session, loading, permissionsLoading, permissionsError, refreshAuth, login, logout]);
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (!context) throw new Error('useAuth must be used within AuthProvider');
    return context;
}
