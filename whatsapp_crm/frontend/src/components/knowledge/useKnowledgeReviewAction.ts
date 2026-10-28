import { useEffect, useRef, useState } from 'react';

/** Keep late answers out of a new business, user, or permission scope. */
export function useKnowledgeReviewAction() {
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [conflict, setConflict] = useState(false);
    const [uncertain, setUncertain] = useState(false);
    const request = useRef(0);
    const alive = useRef(false);
    const controller = useRef<AbortController | null>(null);
    const locked = useRef(false);
    const retryTask = useRef<(() => Promise<void>) | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout>>();
    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; controller.current?.abort(); clearTimeout(timer.current); retryTask.current = null; };
    }, []);
    async function run<T>(kind: string, task: (signal: AbortSignal) => Promise<T>, apply: (result: T) => void, success: string) {
        if (locked.current) return;
        locked.current = true;
        const sequence = ++request.current;
        const abort = new AbortController();
        controller.current = abort;
        // task closes over the original immutable body and idempotency key.
        retryTask.current = () => run(kind, task, apply, success);
        setBusy(kind); setError(''); setNotice(''); setConflict(false);
        try {
            const result = await Promise.race([task(abort.signal), new Promise<never>((_resolve, reject) => {
                timer.current = setTimeout(() => { abort.abort(); reject(Object.assign(new Error(), { code: 'TIMEOUT' })); }, 32000);
            })]);
            if (!alive.current || sequence !== request.current || abort.signal.aborted) return;
            apply(result); setNotice(success); setConflict(false); setUncertain(false); retryTask.current = null;
        } catch (failure) {
            if (!alive.current || sequence !== request.current) return;
            const detail = failure as { code?: string; response?: { status?: number; data?: { code?: string } } };
            const status = detail.response?.status;
            const code = detail.response?.data?.code ?? detail.code ?? '';
            if (!status || code === 'KNOWLEDGE_REVIEW_OPERATION_PENDING') {
                setUncertain(true); setError('Не удалось подтвердить результат. Обновите список или повторите тот же запрос, чтобы проверить сохранение.');
            } else {
                setUncertain(false); retryTask.current = null;
                if (/CHECK_REQUIRED|CHECK_FAILED/.test(code)) {
                    setConflict(true); setError('Проверьте текущую сохранённую редакцию перед публикацией.');
                } else if (/REVISION|CONFLICT|STALE|CHANGED/.test(code)) {
                    setConflict(true); setError('Ответ или его источник изменился. Ваш текст сохранён на экране. Загрузите актуальную редакцию перед продолжением.');
                } else if (status === 403) {
                    setError('Доступ к этому действию изменился. Обновите предложения и проверьте доступ к бизнесу.');
                } else if (code === 'KNOWLEDGE_REVIEW_ROLLBACK_UNAVAILABLE') {
                    setConflict(true); setError('Предыдущая публикация недоступна для восстановления. Обновите историю редакций.');
                } else if (code === 'KNOWLEDGE_REVIEW_OPERATION_EXPIRED') {
                    setError('Предыдущая попытка не завершилась. Обновите список перед новой попыткой.');
                } else {
                    setError(kind === 'create' ? 'Не удалось подготовить черновик. Проверьте информацию в базе знаний и повторите.' : kind === 'check' ? 'Не удалось выполнить проверку. Попробуйте ещё раз.' : 'Не удалось сохранить изменения. Обновите список и повторите.');
                }
            }
        } finally {
            if (sequence === request.current) {
                clearTimeout(timer.current); locked.current = false; if (alive.current) setBusy('');
            }
        }
    }
    function cancel() {
        ++request.current; controller.current?.abort(); clearTimeout(timer.current); locked.current = false; setBusy('');
        setNotice('Ожидание отменено. Обновите список или повторите тот же запрос, чтобы проверить результат.'); setUncertain(true);
    }
    return { busy, error, notice, conflict, uncertain, run, cancel, retry: () => retryTask.current?.(), clear: () => { retryTask.current = null; setError(''); setNotice(''); setConflict(false); setUncertain(false); } };
}
