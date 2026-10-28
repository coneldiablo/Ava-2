// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useKnowledgeReviewAction } from './useKnowledgeReviewAction';
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('knowledge action finite requests', () => {
    it('ends a hung request and exposes retry without applying a late result', async () => {
        vi.useFakeTimers(); let finish!: (value: string) => void;
        const task = vi.fn((_signal: AbortSignal) => new Promise<string>(resolve => { finish = resolve; })); const apply = vi.fn();
        const view = renderHook(() => useKnowledgeReviewAction());
        act(() => { void view.result.current.run('create', task, apply, 'Готово'); }); expect(view.result.current.busy).toBe('create');
        await act(async () => { await vi.advanceTimersByTimeAsync(32001); }); expect(view.result.current.busy).toBe(''); expect(view.result.current.uncertain).toBe(true); expect(task.mock.calls[0][0].aborted).toBe(true);
        await act(async () => finish('Late')); expect(apply).not.toHaveBeenCalled();
        task.mockImplementationOnce(async () => 'Confirmed'); await act(async () => { await view.result.current.retry(); }); expect(apply).toHaveBeenCalledWith('Confirmed'); expect(view.result.current.uncertain).toBe(false);
    });
    it('maps a missing current check before the general 409 branch', async () => {
        const view = renderHook(() => useKnowledgeReviewAction());
        await act(async () => { await view.result.current.run('publish', async () => { throw { response: { status: 409, data: { code: 'KNOWLEDGE_REVIEW_CHECK_REQUIRED' } } }; }, vi.fn(), 'Published'); });
        expect(view.result.current.error).toBe('Проверьте текущую сохранённую редакцию перед публикацией.'); expect(view.result.current.conflict).toBe(true);
    });
    it('aborts an operation and releases its deadline on unmount', () => {
        vi.useFakeTimers(); const task = vi.fn((_signal: AbortSignal) => new Promise<never>(() => {})); const view = renderHook(() => useKnowledgeReviewAction());
        act(() => { void view.result.current.run('check', task, vi.fn(), 'Checked'); }); view.unmount(); expect(task.mock.calls[0][0].aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    });
});
