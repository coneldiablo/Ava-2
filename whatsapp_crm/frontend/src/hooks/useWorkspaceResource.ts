import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceError } from '../avaWorkspace';

export function useResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>) {
    const loader = useRef(load); loader.current = load;
    const [version, setVersion] = useState(0);
    const [state, setState] = useState<{ key: string | null; data: T | null; loading: boolean; error: string }>({ key: null, data: null, loading: Boolean(key), error: '' });
    const reload = useCallback(() => setVersion(value => value + 1), []);
    useEffect(() => {
        if (!key) { setState({ key, data: null, loading: false, error: '' }); return; }
        const controller = new AbortController(); let alive = true;
        setState(previous => ({ key, data: previous.key === key ? previous.data : null, loading: true, error: '' }));
        loader.current(controller.signal).then(data => { if (alive && !controller.signal.aborted) setState({ key, data, loading: false, error: '' }); })
            .catch(error => { if (alive && !controller.signal.aborted) setState(previous => ({ key, data: previous.key === key ? previous.data : null, loading: false, error: workspaceError(error, 'Не удалось загрузить данные. Проверьте соединение и повторите.') })); });
        return () => { alive = false; controller.abort(); };
    }, [key, version]);
    const current=state.key === key ? state : { data:null,loading:Boolean(key),error:'' };
    return { data:current.data,loading:current.loading,refreshing:current.loading && current.data !== null,error:current.error,reload };
}
export function useAction() {
    const alive = useRef(true), lock = useRef(false), controller = useRef<AbortController | null>(null);
    const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
    useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
    async function run(key: string, task: (signal: AbortSignal) => Promise<string | void>, after?: () => void) {
        if (lock.current) return;
        lock.current = true; setBusy(key); setError(''); setNotice(''); controller.current = new AbortController();
        try { const result = await task(controller.current.signal); if (alive.current) { setNotice(result || 'Изменения сохранены.'); after?.(); } }
        catch (failure) { if (alive.current) setError(workspaceError(failure)); }
        finally { lock.current = false; if (alive.current) setBusy(''); }
    }
    return { busy, error, notice, run, clear: () => { setError(''); setNotice(''); } };
}
