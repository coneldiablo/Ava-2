import { useCallback, useEffect, useRef, useState } from 'react';
import { getPresence, postPresence, type PresenceResponse } from '../improvementsApi';
import { requestKey, workspaceError } from '../avaWorkspace';

/** A visible tab renews its lease; hidden tabs expire naturally without claiming activity. */
export function useTodayPresence(businessId: number, chatId: string, userId: string | null | undefined, enabled: boolean, canParticipate: boolean, dialogueRevision?: string) {
    const scope = JSON.stringify([businessId, chatId, userId]);
    const [stored, setStored] = useState<{ scope: string; data: PresenceResponse } | null>(null);
    const data = stored?.scope === scope ? stored.data : null;
    const [error, setError] = useState('');
    const session = useRef(requestKey()), typingUntil = useRef(0), publish = useRef<() => void>(() => {});
    const typing = useCallback(() => { typingUntil.current = Date.now() + 5000; publish.current(); }, []);
    useEffect(() => {
        setError(''); typingUntil.current = 0;
        if (!enabled || !userId) return;
        let alive = true, pending = false, lastPublished = 0;
        let controller: AbortController | null = null;
        let typingPublishTimer: number | undefined;
        const tick = async (force = true) => {
            if (!alive || document.visibilityState === 'hidden' || pending || (!force && Date.now() - lastPublished < 1500)) return;
            pending = true; lastPublished = Date.now(); controller = new AbortController();
            try {
                const result = canParticipate
                    ? await postPresence(businessId, chatId, { sessionId: session.current, typing: Date.now() < typingUntil.current }, controller.signal)
                    : await getPresence(businessId, chatId, controller.signal);
                if (alive && !controller.signal.aborted) { setStored({ scope, data: result }); setError(''); }
            } catch (failure) { if (alive && !controller.signal.aborted) setError(workspaceError(failure, 'Не удалось обновить присутствие команды.')); }
            finally { pending = false; }
        };
        publish.current = () => { clearTimeout(typingPublishTimer); typingPublishTimer = window.setTimeout(() => { void tick(); }, Math.max(0, 1500 - (Date.now() - lastPublished))); };
        const refresh = () => { void tick(); };
        const visibility = () => { if (document.visibilityState === 'hidden') controller?.abort(); else refresh(); };
        refresh();
        const timer = window.setInterval(refresh, 15000);
        // Clear typing soon after input ends, without waiting for the next heartbeat.
        const typingTimer = window.setInterval(() => { if (typingUntil.current && Date.now() >= typingUntil.current) { typingUntil.current = 0; refresh(); } }, 1000);
        window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', visibility);
        return () => { alive = false; controller?.abort(); clearTimeout(typingPublishTimer); publish.current = () => {}; clearInterval(timer); clearInterval(typingTimer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visibility); };
    }, [businessId, chatId, userId, enabled, canParticipate, scope, dialogueRevision]);
    return { data, error, typing };
}
