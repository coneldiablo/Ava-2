import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

export type WorkspaceDraftScope = { userId?: string | null; businessId: number; chatId?: string; channel?: string };
const prefix = 'ava:workspace-draft:v1:';
const drafts = new Map<string, unknown>();
let activeRoot: string | null = null;
const rootKey = (userId: string, businessId: number) => `${encodeURIComponent(userId)}:${businessId}:`;

function removeStored(matches: (key: string) => boolean) {
    try {
        for (let index = sessionStorage.length - 1; index >= 0; index--) {
            const key = sessionStorage.key(index);
            if (key && matches(key)) sessionStorage.removeItem(key);
        }
    } catch { /* Memory remains usable when browser storage is disabled. */ }
}

/** Called only for a stable identity/business change, never for a permission refresh. */
export function setWorkspaceDraftRoot(userId: string | null | undefined, businessId: number | null) {
    const next = userId && businessId ? rootKey(userId, businessId) : null;
    if (activeRoot === next) return;
    if (activeRoot === null && next) {
        for (const key of drafts.keys()) if (!key.startsWith(prefix + next)) drafts.delete(key);
        removeStored(key => (key.startsWith(prefix) && !key.startsWith(prefix + next))
            || (key.startsWith('ava:reply:') && !key.startsWith(`ava:reply:${next}`)));
    }
    if (activeRoot) {
        const previous = activeRoot;
        for (const key of drafts.keys()) if (key.startsWith(prefix + previous)) drafts.delete(key);
        removeStored(key => key.startsWith(prefix + previous) || key.startsWith(`ava:reply:${previous}`));
    }
    activeRoot = next;
}

/** Explicit sign-out and confirmed identity replacement cannot revive an old draft. */
export function clearWorkspaceDrafts() {
    drafts.clear(); activeRoot = null;
    removeStored(key => key.startsWith(prefix) || key.startsWith('ava:reply:'));
}

function readDraft<T>(key: string | null, initial: T | (() => T)): T {
    if (key && drafts.has(key)) return drafts.get(key) as T;
    if (key) {
        try {
            const stored = sessionStorage.getItem(key);
            if (stored !== null) { const value = JSON.parse(stored) as T; drafts.set(key, value); return value; }
        } catch { /* A corrupt/unavailable record falls back to the caller's initial value. */ }
    }
    return typeof initial === 'function' ? (initial as () => T)() : initial;
}

/** Route/component unmounts retain input; identity/business switches clear the previous root. */
export function useScopedDraft<T>(scope: WorkspaceDraftScope, name: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>, () => void] {
    const root = scope.userId && scope.businessId > 0 ? rootKey(scope.userId, scope.businessId) : null;
    const key = root ? `${prefix}${root}${JSON.stringify([scope.chatId ?? '', scope.channel ?? '', name])}` : null;
    const latest = useRef({ key });
    if (latest.current.key !== key) latest.current = { key };
    const generation = latest.current;
    const mounted = useRef(true);
    const [stored, setStored] = useState(() => ({ generation, value: readDraft(key, initial) }));
    const value = stored.generation === generation ? stored.value : readDraft(key, initial);
    const valueRef = useRef(value); valueRef.current = value;
    useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useLayoutEffect(() => { if (root) setWorkspaceDraftRoot(scope.userId, scope.businessId); }, [root, scope.userId, scope.businessId]);
    const setValue = useCallback<Dispatch<SetStateAction<T>>>(update => {
        if (!key || !mounted.current || activeRoot !== root || latest.current !== generation) return;
        const next = typeof update === 'function' ? (update as (previous: T) => T)(valueRef.current) : update;
        valueRef.current = next; drafts.set(key, next);
        try { sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* Keep the in-memory draft. */ }
        setStored({ generation, value: next });
    }, [key, root, generation]);
    const reset = useCallback(() => {
        if (!key || !mounted.current || activeRoot !== root || latest.current !== generation) return;
        drafts.delete(key);
        try { sessionStorage.removeItem(key); } catch { /* In-memory reset still applies. */ }
        const next = typeof initial === 'function' ? (initial as () => T)() : initial;
        valueRef.current = next; setStored({ generation, value: next });
    }, [key, root, generation, initial]);
    return [value, setValue, reset];
}
