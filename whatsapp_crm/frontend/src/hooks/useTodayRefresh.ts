import { useEffect } from 'react';

export function useTodayRefresh(enabled: boolean, reload: () => void, interval = 30000) {
    useEffect(() => {
        if (!enabled) return;
        const refresh = () => { if (document.visibilityState !== 'hidden') reload(); };
        const timer = window.setInterval(refresh, interval);
        window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
        return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
    }, [enabled, reload, interval]);
}

