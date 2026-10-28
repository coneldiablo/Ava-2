// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearWorkspaceDrafts, useScopedDraft } from './useScopedDraft';

beforeEach(() => { clearWorkspaceDrafts(); sessionStorage.clear(); });
afterEach(cleanup);
const first = { userId: 'manager', businessId: 7, chatId: 'client-a', channel: 'telegram' };
describe('scoped workday drafts', () => {
    it('retains input through route unmounts while clients and channels have independent drafts', () => {
        const hook = renderHook(({ scope }) => useScopedDraft(scope, 'task', ''), { initialProps: { scope: first } });
        act(() => hook.result.current[1]('Перезвонить'));
        hook.rerender({ scope: { ...first, chatId: 'client-b' } }); expect(hook.result.current[0]).toBe('');
        hook.rerender({ scope: { ...first, channel: 'whatsapp' } }); expect(hook.result.current[0]).toBe('');
        hook.rerender({ scope: first }); expect(hook.result.current[0]).toBe('Перезвонить');
        const lateSetter = hook.result.current[1]; hook.unmount();
        act(() => lateSetter('late after unmount'));
        const reopened = renderHook(() => useScopedDraft(first, 'task', ''));
        expect(reopened.result.current[0]).toBe('Перезвонить');
    });
    it('clears the previous business root and reply storage, and fences a stale async setter', () => {
        const hook = renderHook(({ scope }) => useScopedDraft(scope, 'promise', ''), { initialProps: { scope: first } });
        act(() => hook.result.current[1]('До 15:00'));
        const staleSetter = hook.result.current[1];
        sessionStorage.setItem('ava:reply:manager:7:client-a', 'private');
        hook.rerender({ scope: { ...first, businessId: 8 } });
        expect(hook.result.current[0]).toBe(''); expect(sessionStorage.getItem('ava:reply:manager:7:client-a')).toBeNull();
        hook.rerender({ scope: first }); expect(hook.result.current[0]).toBe('');
        act(() => staleSetter('late old scope')); expect(hook.result.current[0]).toBe('');
    });
    it('clears previous identity and resets only the named current draft', () => {
        const hook = renderHook(({ scope }) => useScopedDraft(scope, 'copilot', () => ({ question: '' })), { initialProps: { scope: first } });
        act(() => hook.result.current[1]({ question: 'Что обещали?' }));
        hook.rerender({ scope: { ...first, userId: 'other' } }); expect(hook.result.current[0].question).toBe('');
        act(() => hook.result.current[1]({ question: 'Новый вопрос' })); act(() => hook.result.current[2]());
        expect(hook.result.current[0].question).toBe('');
        hook.rerender({ scope: first }); expect(hook.result.current[0].question).toBe('');
    });
});
