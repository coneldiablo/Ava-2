import React, { createContext, useContext, useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { getInstances } from '../api';
import { useAuth } from './AuthContext';
import { setWorkspaceDraftRoot } from '../hooks/useScopedDraft';

interface Instance {
    id: number;
    name: string;
    [key: string]: any;
    greenApiInstance?: string;
    greenApiToken?: string;
    aiProvider?: string;
    geminiModel?: string;
    yandexGptKey?: string;
    yandexGptFolderId?: string;
    yandexGptModelUri?: string;
    aiTemperature?: string;
    aiResponseFormat?: string;
    systemPrompt?: string;
    businessType?: 'standard' | 'coffee_shop';
    salesGoal?: string;
    yclientsLink?: string;
    yclientsCompanyId?: string;
    yclientsFormId?: string;
    crmIntegration?: string;
    amoCrmAccessToken?: string;
    amoCrmDomain?: string;
    bitrix24WebhookUrl?: string;
    isActive?: number;
}

interface InstanceContextType {
    instances: Instance[];
    instancesState: 'loading' | 'ready' | 'error';
    currentInstanceId: number | null;
    currentInstance: Instance | null;
    setInstanceId: (id: number) => void;
    refreshInstances: () => Promise<void>;
}

const InstanceContext = createContext<InstanceContextType | undefined>(undefined);

export function InstanceProvider({ children }: { children: React.ReactNode }) {
    const { authenticated, role, memberships, userId, loginName } = useAuth();
    const [instances, setInstances] = useState<Instance[]>([]);
    const [instancesState, setInstancesState] = useState<'loading' | 'ready' | 'error'>('loading');
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const scope = JSON.stringify([authenticated, userId ?? loginName, role === 'platform_admin']);
    const [loadedScope, setLoadedScope] = useState(scope);
    const requestScope = useRef(scope);
    const refreshRevision = useRef(0);
    const membershipKey = JSON.stringify([...new Set(memberships.filter(item => item.capabilities?.includes('business.read')).map(item => item.businessId))].sort((a, b) => a - b));
    const accessibleIds = useMemo(() => new Set(memberships.filter(item => item.capabilities?.includes('business.read')).map(item => item.businessId)), [membershipKey]);
    const availableInstances = authenticated && loadedScope === scope ? instances.filter(instance => role === 'platform_admin' || accessibleIds.has(instance.id)) : [];
    const currentInstanceId = availableInstances.some(instance => instance.id === selectedId) ? selectedId : availableInstances[0]?.id ?? null;

    const refreshInstances = useCallback(async () => {
        const revision = ++refreshRevision.current;
        if (requestScope.current !== scope) {
            requestScope.current = scope; setLoadedScope(scope); setInstances([]); setSelectedId(null);
        }
        if (!authenticated) { setLoadedScope(scope); setInstances([]); setSelectedId(null); setInstancesState('ready'); return; }
        setInstancesState('loading');
        try {
            const data = await getInstances();
            if (revision !== refreshRevision.current) return;
            if (data.success !== true || !Array.isArray(data.instances)) throw new Error('BUSINESSES_UNAVAILABLE');
            const rawInstances: Instance[] = data.instances;
            const activeInstances = rawInstances.filter(instance => Number(instance.isActive ?? 1) !== 0);
            const visible = role === 'platform_admin' && activeInstances.length === 0 ? rawInstances : activeInstances;
            const allowed = visible.filter(instance => role === 'platform_admin' || accessibleIds.has(instance.id));
            setLoadedScope(scope);
            setInstances(allowed);
            let preferred: number | null = null;
            try {
                const stored = Number(sessionStorage.getItem('ava:preferred-business'));
                if (allowed.some(instance => instance.id === stored)) {
                    preferred = stored;
                    sessionStorage.removeItem('ava:preferred-business');
                }
            } catch { /* Browser storage can be disabled. */ }
            setSelectedId(current => preferred ?? (allowed.some(instance => instance.id === current) ? current : allowed[0]?.id ?? null));
            setInstancesState('ready');
        } catch {
            if (revision !== refreshRevision.current) return;
            // Keep the last scoped list through a temporary outage; route mutations stay locked.
            setInstancesState('error');
        }
    }, [authenticated, role, accessibleIds, scope]);

    useEffect(() => {
        void refreshInstances();
        return () => { ++refreshRevision.current; };
    }, [refreshInstances]);

    useLayoutEffect(() => {
        if (loadedScope === scope && (currentInstanceId || instancesState === 'ready')) setWorkspaceDraftRoot(userId ?? loginName, currentInstanceId);
    }, [userId, loginName, currentInstanceId, instancesState, loadedScope, scope]);

    const setInstanceId = (id: number) => {
        // Exposed selection is always resolved against the allowed server list.
        if (Number.isSafeInteger(id) && id > 0) setSelectedId(id);
    };
    return <InstanceContext.Provider value={{ instances: availableInstances, instancesState: loadedScope === scope ? instancesState : 'loading', currentInstanceId,
        currentInstance: availableInstances.find(instance => instance.id === currentInstanceId) ?? null,
        setInstanceId, refreshInstances }}>{children}</InstanceContext.Provider>;
}

export function useInstance() {
    const context = useContext(InstanceContext);
    if (!context) throw new Error('useInstance must be used within InstanceProvider');
    return context;
}
