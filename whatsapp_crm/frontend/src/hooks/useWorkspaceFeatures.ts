import { useEffect } from 'react';
import { getFeatures } from '../improvementsApi';
import { useResource } from './useWorkspaceResource';

export const workspaceFeaturesChanged = 'ava:workspace-features-changed';
export function notifyWorkspaceFeaturesChanged(businessId: number, userId: string | null | undefined) {
    window.dispatchEvent(new CustomEvent(workspaceFeaturesChanged, { detail: { businessId, userId } }));
}
/** Unknown or unavailable flags always retain the legacy UI. */
export function useWorkspaceFeatures(businessId: number | null | undefined, userId: string | null | undefined) {
    const resource = useResource(businessId && userId ? `${businessId}:${userId}:workspace-features` : null, signal => getFeatures(businessId!, signal));
    const refresh = resource.reload;
    useEffect(() => {
        if (!businessId || !userId) return;
        const revalidate = () => { if (document.visibilityState !== 'hidden') refresh(); };
        const changed = (event: Event) => {
            const detail = (event as CustomEvent<{ businessId: number; userId: string }>).detail;
            if (detail?.businessId === businessId && detail.userId === userId) refresh();
        };
        window.addEventListener('focus', revalidate);
        document.addEventListener('visibilitychange', revalidate);
        window.addEventListener(workspaceFeaturesChanged, changed);
        const timer = window.setInterval(revalidate, 60000);
        return () => { window.clearInterval(timer); window.removeEventListener('focus', revalidate); document.removeEventListener('visibilitychange', revalidate); window.removeEventListener(workspaceFeaturesChanged, changed); };
    }, [businessId, userId, refresh]);
    return { features: resource.data?.available ? resource.data : null, loading: resource.loading, error: resource.error, refresh };
}
