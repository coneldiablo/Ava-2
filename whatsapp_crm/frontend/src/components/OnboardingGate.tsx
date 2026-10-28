import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useOnboarding } from '../context/OnboardingContext';
import { useAuth } from '../context/AuthContext';
import { useInstance } from '../context/InstanceContext';
import { canAccessRoute, getBusinessLanding, getSessionMembership, isBusinessBootstrap } from '../permissions';

function OnboardingStatus() {
    const { phase, reload } = useOnboarding();
    return <div className="card p-6" role={phase === 'error' ? 'alert' : 'status'}>
        <p>{phase === 'error' ? 'Не удалось загрузить настройку бизнеса.' : 'Загружаем настройку бизнеса…'}</p>
        {phase === 'error' && <button type="button" className="btn-secondary mt-4 min-h-11" onClick={reload}>Повторить</button>}
    </div>;
}

export function OnboardingHomeGate({ children }: { children: ReactNode }) {
    const { phase } = useOnboarding();
    const { search } = useLocation();
    const params = new URLSearchParams(search);
    // Preserve existing customer links, including the Home -> Today handoff.
    if (params.has('client') || params.has('source')) return children;
    if (phase === 'loading' || phase === 'error') return <OnboardingStatus />;
    if (phase === 'pending') return <Navigate to="/getting-started" replace />;
    return children;
}

export function OnboardingGuideRoute({ children }: { children: ReactNode }) {
    const auth = useAuth(); const { currentInstanceId, instancesState, refreshInstances } = useInstance();
    const { phase, state } = useOnboarding();
    // A direct URL can arrive before the business list. Resolve it before choosing a landing page.
    if ((auth.loading || auth.permissionsLoading || instancesState === 'loading') && !state) return <OnboardingStatus />;
    if (instancesState === 'error' && !currentInstanceId) return <div className="card p-6" role="alert"><p>Не удалось загрузить бизнесы.</p>
        <button type="button" className="btn-secondary mt-4 min-h-11" onClick={() => void refreshInstances()}>Повторить</button></div>;
    if (isBusinessBootstrap(auth, currentInstanceId)) return children;
    const owner = auth.role !== 'platform_admin' && getSessionMembership(auth, currentInstanceId)?.role === 'hotel_owner';
    if (!owner) return <Navigate to={getBusinessLanding(auth, currentInstanceId) === '/getting-started' ? '/' : getBusinessLanding(auth, currentInstanceId)} replace />;
    if (!canAccessRoute({ ...auth, permissionsLoading: false }, currentInstanceId, '/getting-started')) return <Navigate to="/" replace />;
    if (phase === 'loading' || phase === 'error') return <OnboardingStatus />;
    if (phase === 'completed') return <Navigate to="/integrations" replace />;
    return children;
}
