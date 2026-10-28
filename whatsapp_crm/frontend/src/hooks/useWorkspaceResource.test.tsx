// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useResource } from './useWorkspaceResource';

afterEach(cleanup);
describe('workspace snapshot recovery', () => {
    it('retains data through a failed background request and recovers on explicit retry', async () => {
        const load = vi.fn().mockResolvedValueOnce({ value: 'confirmed' }).mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce({ value: 'updated' });
        const hook = renderHook(() => useResource<{ value: string }>('user:7:client', load));
        await waitFor(() => expect(hook.result.current.data?.value).toBe('confirmed'));
        act(() => hook.result.current.reload());
        expect(hook.result.current.refreshing).toBe(true);
        expect(hook.result.current.data?.value).toBe('confirmed');
        await waitFor(() => expect(hook.result.current.loading).toBe(false));
        expect(hook.result.current.data?.value).toBe('confirmed'); expect(hook.result.current.error).toBeTruthy();
        act(() => hook.result.current.reload());
        await waitFor(() => expect(hook.result.current.data?.value).toBe('updated'));
        expect(hook.result.current.error).toBe('');
    });
    it('immediately masks an old scope and ignores its late response even after switching back', async () => {
        let finish!: (value: { value: string }) => void;
        const load = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
            .mockResolvedValueOnce({ value: 'second' }).mockResolvedValueOnce({ value: 'fresh-first' });
        const hook = renderHook(({ key }) => useResource<{ value: string }>(key, load), { initialProps: { key: 'first' } });
        const oldSignal = load.mock.calls[0][0] as AbortSignal;
        hook.rerender({ key: 'second' }); expect(hook.result.current.data).toBeNull(); expect(oldSignal.aborted).toBe(true);
        await waitFor(() => expect(hook.result.current.data?.value).toBe('second'));
        hook.rerender({ key: 'first' }); expect(hook.result.current.data).toBeNull();
        await waitFor(() => expect(hook.result.current.data?.value).toBe('fresh-first'));
        await act(async () => finish({ value: 'stale-first' }));
        expect(hook.result.current.data?.value).toBe('fresh-first');
    });
});
