import { useEffect } from 'react';
import { useInstance } from '../context/InstanceContext';
import { useAuth } from '../context/AuthContext';
import { hasCapability, useBusinessAccess } from '../permissions';
import { getReleaseFlags } from '../avaWorkspace';
import { useResource } from './useWorkspaceResource';

const changedEvent = 'ava:release-flags-changed';
export function notifyReleaseFlagsChanged(businessId: number, userId: string | null | undefined) {
    window.dispatchEvent(new CustomEvent(changedEvent, { detail: { businessId, userId } }));
}
export function useReleaseFlags(enabled = true) {
    const { currentInstanceId } = useInstance(); const access = useBusinessAccess();
    const auth = useAuth();
    // A permission recheck locks writes without changing the mounted feature's stable read scope.
    const canRead = enabled && Boolean(currentInstanceId) && auth.role !== 'platform_admin'
        && hasCapability({ ...auth, permissionsLoading: false }, currentInstanceId, 'sales.read');
    const grants = access.membership?.capabilities?.join(',') || '';
    const resource = useResource(canRead ? `${access.userId}:${currentInstanceId}:${access.role}:${grants}:release-flags` : null, signal => getReleaseFlags(currentInstanceId!, signal));
    const reload = resource.reload;
    useEffect(() => {
        if (!canRead) return;
        const changed = (event: Event) => {
            const detail = (event as CustomEvent<{ businessId: number; userId: string | null | undefined }>).detail;
            if (detail?.businessId === currentInstanceId && detail.userId === access.userId) reload();
        };
        window.addEventListener(changedEvent, changed);
        return () => window.removeEventListener(changedEvent, changed);
    }, [canRead, currentInstanceId, access.userId, reload]);
    return { ...resource, checking: access.checking, canRead };
}
