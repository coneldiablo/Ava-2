// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFeatures, featureKeys, type WorkspaceFeaturesResponse } from '../src/improvementsApi';
import { notifyWorkspaceFeaturesChanged, useWorkspaceFeatures } from '../src/hooks/useWorkspaceFeatures';
vi.mock('../src/improvementsApi', async () => ({ ...(await vi.importActual('../src/improvementsApi')), getFeatures: vi.fn() }));
const flags = Object.fromEntries(featureKeys.map(key => [key, true])) as WorkspaceFeaturesResponse['flags'];
const response = (businessId: number): WorkspaceFeaturesResponse => ({ success: true, businessId, revision: 0, available: true, flags, updatedAt: null });
let resolve: (value: WorkspaceFeaturesResponse) => void;
beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());
describe('workspace feature scope and recovery', () => {
    it('immediately hides previous business flags and aborts stale response', async () => {
        vi.mocked(getFeatures).mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValueOnce(response(8));
        const hook = renderHook(({ businessId }) => useWorkspaceFeatures(businessId, 'manager'), { initialProps: { businessId: 7 } });
        const oldSignal = vi.mocked(getFeatures).mock.calls[0][1]!;
        hook.rerender({ businessId: 8 });
        expect(hook.result.current.features).toBeNull();
        expect(oldSignal.aborted).toBe(true);
        await waitFor(() => expect(hook.result.current.features?.businessId).toBe(8));
        await act(async () => resolve(response(7)));
        expect(hook.result.current.features?.businessId).toBe(8);
    });
    it('unavailable feature endpoint settles and retains legacy UI', async () => {
        vi.mocked(getFeatures).mockRejectedValue(new Error('unavailable'));
        const hook = renderHook(() => useWorkspaceFeatures(7, 'manager'));
        await waitFor(() => expect(hook.result.current.loading).toBe(false));
        expect(hook.result.current.features).toBeNull();
    });
    it('revalidates focus and only matching business/user changes', async () => {
        vi.mocked(getFeatures).mockResolvedValue(response(7));
        const hook = renderHook(() => useWorkspaceFeatures(7, 'manager'));
        await waitFor(() => expect(hook.result.current.features).not.toBeNull());
        act(() => notifyWorkspaceFeaturesChanged(8, 'manager'));
        expect(getFeatures).toHaveBeenCalledTimes(1);
        act(() => notifyWorkspaceFeaturesChanged(7, 'other'));
        expect(getFeatures).toHaveBeenCalledTimes(1);
        act(() => notifyWorkspaceFeaturesChanged(7, 'manager'));
        await waitFor(() => expect(getFeatures).toHaveBeenCalledTimes(2));
        act(() => window.dispatchEvent(new Event('focus')));
        await waitFor(() => expect(getFeatures).toHaveBeenCalledTimes(3));
    });
});
