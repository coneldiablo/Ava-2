// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useTodayPresence } from './useTodayPresence';
import { getPresence, postPresence } from '../improvementsApi';
vi.mock('../improvementsApi', () => ({ getPresence: vi.fn(), postPresence: vi.fn() }));
const response = { success: true, businessId: 7, dialogueRevision: 'r1', participants: [] };
describe('visible workday presence lease', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); vi.mocked(postPresence).mockResolvedValue(response); vi.mocked(getPresence).mockResolvedValue(response); });
    afterEach(() => { cleanup(); vi.useRealTimers(); });
    it('renews every 15s with one stable session and stops after unmount', async () => {
        const hook = renderHook(() => useTodayPresence(7, 'card', 'employee', true, true)); await act(async () => {});
        expect(postPresence).toHaveBeenCalledTimes(1); const sessionId = vi.mocked(postPresence).mock.calls[0][2].sessionId;
        await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); expect(postPresence).toHaveBeenCalledTimes(2); expect(vi.mocked(postPresence).mock.calls[1][2]).toEqual({ sessionId, typing: false });
        hook.unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(30000); }); expect(postPresence).toHaveBeenCalledTimes(2);
    });
    it('debounces rapid typing, publishes typing and expires it after five seconds', async () => {
        const hook = renderHook(() => useTodayPresence(7, 'card', 'employee', true, true)); await act(async () => {});
        act(() => { hook.result.current.typing(); hook.result.current.typing(); }); expect(postPresence).toHaveBeenCalledTimes(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(1500); }); expect(postPresence).toHaveBeenCalledTimes(2); expect(vi.mocked(postPresence).mock.calls[1][2].typing).toBe(true);
        await act(async () => { await vi.advanceTimersByTimeAsync(4500); }); expect(vi.mocked(postPresence).mock.calls.slice(-1)[0]![2].typing).toBe(false);
    });
    it('hidden tab stops claiming presence and focus resumes it', async () => {
        renderHook(() => useTodayPresence(7, 'card', 'employee', true, true)); await act(async () => {});
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); act(() => { document.dispatchEvent(new Event('visibilitychange')); }); await act(async () => { await vi.advanceTimersByTimeAsync(45000); }); expect(postPresence).toHaveBeenCalledTimes(1);
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); await act(async () => { window.dispatchEvent(new Event('focus')); }); expect(postPresence).toHaveBeenCalledTimes(2);
    });
    it('read-only viewers use GET and old-client pending responses are aborted and ignored', async () => {
        let finish!: (value: typeof response) => void;
        vi.mocked(getPresence).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const hook = renderHook(({chatId}) => useTodayPresence(7, chatId, 'observer', true, false), { initialProps: { chatId: 'card1' } }); const oldSignal = vi.mocked(getPresence).mock.calls[0][2]!;
        hook.rerender({ chatId: 'card2' }); await act(async () => {}); expect(oldSignal.aborted).toBe(true);
        await act(async () => { finish({ ...response, dialogueRevision: 'stale' }); }); expect(hook.result.current.data?.dialogueRevision).toBe('r1'); expect(postPresence).not.toHaveBeenCalled();
    });
    it('refreshes presence after a canonical dialogue reload and ignores an older pending heartbeat', async () => {
        let finish!: (value: typeof response) => void;
        vi.mocked(postPresence).mockResolvedValueOnce(response).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ...response, dialogueRevision: 'r2' });
        const hook = renderHook(({ revision }) => useTodayPresence(7, 'card', 'employee', true, true, revision), { initialProps: { revision: 'r1' } });
        await act(async () => {});
        const sessionId = vi.mocked(postPresence).mock.calls[0][2].sessionId;
        await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
        const oldSignal = vi.mocked(postPresence).mock.calls[1][3]!;
        hook.rerender({ revision: 'r2' });
        await act(async () => {});
        expect(oldSignal.aborted).toBe(true);
        expect(postPresence).toHaveBeenCalledTimes(3);
        expect(vi.mocked(postPresence).mock.calls[2][2].sessionId).toBe(sessionId);
        expect(hook.result.current.data?.dialogueRevision).toBe('r2');
        await act(async () => { finish(response); });
        expect(hook.result.current.data?.dialogueRevision).toBe('r2');
    });

});
