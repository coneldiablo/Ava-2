import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useInstance } from './InstanceContext';
import { getSessionMembership, hasCapability, isBusinessBootstrap } from '../permissions';
import { onboardingRequest, type OnboardingState, type OnboardingStep } from '../onboardingApi';

type OnboardingValue = {
    phase: 'idle' | 'loading' | 'pending' | 'completed' | 'error';
    state: OnboardingState | null;
    showGuide: boolean;
    busy: boolean;
    error: string;
    reload: () => void;
    confirmStep: (step: OnboardingStep) => Promise<boolean>;
    complete: () => Promise<boolean>;
};
const idle: OnboardingValue = { phase: 'idle', state: null, showGuide: false, busy: false, error: '',
    reload: () => {}, confirmStep: async () => false, complete: async () => false };
const OnboardingContext = createContext<OnboardingValue>(idle);

export function OnboardingProvider({ children }: { children: ReactNode }) {
    const auth = useAuth();
    const { currentInstanceId, instancesState } = useInstance();
    const snapshot = { ...auth, permissionsLoading: false };
    const owner = auth.role !== 'platform_admin' && getSessionMembership(snapshot, currentInstanceId)?.role === 'hotel_owner'
        && hasCapability(snapshot, currentInstanceId, 'business.manage');
    const bootstrap = instancesState === 'ready' && isBusinessBootstrap(auth, currentInstanceId);
    // Mask a previous tenant synchronously while keeping Layout's business-switch history mounted.
    const scope = JSON.stringify([auth.userId, currentInstanceId, owner]);
    return <ScopedOnboarding scope={scope} businessId={owner ? currentInstanceId : null}
        canWrite={!auth.permissionsLoading && instancesState === 'ready' && owner}
        bootstrap={bootstrap}>{children}</ScopedOnboarding>;
}

function ScopedOnboarding({ scope, businessId, bootstrap, canWrite, children }: { scope: string; businessId: number | null; bootstrap: boolean; canWrite: boolean; children: ReactNode }) {
    const [stored, setStored] = useState<{ scope: string; phase: OnboardingValue['phase']; state: OnboardingState | null; error: string }>({
        scope, phase: businessId ? 'loading' : 'idle', state: null, error: '',
    });
    const phase = stored.scope === scope ? stored.phase : businessId ? 'loading' : 'idle';
    const state = stored.scope === scope ? stored.state : null;
    const error = stored.scope === scope ? stored.error : '';
    const [busyScope, setBusyScope] = useState<string | null>(null);
    const busy = busyScope === scope;
    const [revision, setRevision] = useState(0);
    const active = useRef(true);
    const latestScope = useRef({ scope });
    if (latestScope.current.scope !== scope) latestScope.current = { scope };
    const mutation = useRef<AbortController | null>(null);
    const liveWrite = useRef(canWrite); liveWrite.current = canWrite;
    const reload = useCallback(() => setRevision(value => value + 1), []);
    useEffect(() => {
        active.current = true;
        return () => { active.current = false; mutation.current?.abort(); };
    }, []);
    useEffect(() => {
        mutation.current?.abort(); mutation.current = null; setBusyScope(null);
        if (!businessId || !canWrite) return;
        const controller = new AbortController();
        let current = true;
        const timeout = setTimeout(() => controller.abort(), 15000);
        setStored(previous => previous.scope === scope && previous.state ? { ...previous, error: '' }
            : { scope, phase: 'loading', state: null, error: '' });
        void onboardingRequest(businessId, '', controller.signal).then(result => {
            if (!current || latestScope.current.scope !== scope) return;
            setStored({ scope, state: result, phase: result.status, error: '' });
        }).catch(() => {
            if (current && latestScope.current.scope === scope) setStored(previous => ({ scope,
                state: previous.scope === scope ? previous.state : null,
                phase: previous.scope === scope && previous.state ? previous.phase : 'error',
                error: 'Не удалось обновить настройку. Подтверждённые шаги сохранены; повторите попытку.' }));
        }).finally(() => clearTimeout(timeout));
        return () => { current = false; clearTimeout(timeout); controller.abort(); };
    }, [businessId, revision, scope, canWrite]);

    const write = async (action: string) => {
        if (!businessId || !liveWrite.current || !active.current || latestScope.current.scope !== scope || mutation.current || phase !== 'pending') return false;
        const requestScope = latestScope.current;
        const controller = new AbortController(); mutation.current = controller;
        const timeout = setTimeout(() => controller.abort(), 15000);
        setBusyScope(scope); setStored(previous => ({ ...previous, error: '' }));
        try {
            const result = await onboardingRequest(businessId, action, controller.signal);
            if (!active.current || controller.signal.aborted || latestScope.current !== requestScope) return false;
            setStored({ scope, state: result, phase: result.status, error: '' }); return true;
        } catch {
            if (active.current && latestScope.current === requestScope) setStored(previous => ({ ...previous,
                error: 'Не удалось сохранить шаг. Повторите попытку: подтверждённые шаги сохранятся.' }));
            return false;
        } finally {
            clearTimeout(timeout);
            if (mutation.current === controller) mutation.current = null;
            if (active.current && latestScope.current === requestScope) setBusyScope(null);
        }
    };
    return <OnboardingContext.Provider value={{ phase, state, busy, error, reload,
        showGuide: bootstrap || phase === 'pending' || phase === 'error',
        confirmStep: step => write(`/steps/${step}`), complete: () => write('/complete') }}>{children}</OnboardingContext.Provider>;
}

export const useOnboarding = () => useContext(OnboardingContext);
