import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, CircleAlert, Instagram, RefreshCw } from 'lucide-react';
import {
    disconnectInstagramPrivate,
    getInstagramPrivateStatus,
    loginInstagramPrivate,
    pollInstagramPrivate,
    type InstagramPrivateStatus,
} from '../api';
import './InstagramConnectionPanel.css';

export type InstagramConnectionPanelProps = {
    businessId: number;
    canManage: boolean;
};

function errorCode(cause: unknown) {
    const error = cause as { response?: { data?: { code?: string } } };
    return error?.response?.data?.code || '';
}

function errorMessage(code: string) {
    const messages: Record<string, string> = {
        INSTAGRAM_PRIVATE_TWO_FACTOR_REQUIRED: 'Instagram запросил код подтверждения. Введите его вместе с логином и паролем.',
        INSTAGRAM_PRIVATE_CHALLENGE_REQUIRED: 'Instagram запросил проверку входа. Завершите её в приложении Instagram, затем повторите вход здесь.',
        INSTAGRAM_PRIVATE_RATE_LIMITED: 'Instagram временно ограничил запросы. Подождите несколько минут и повторите попытку.',
        INSTAGRAM_PRIVATE_LOGIN_COOLDOWN: 'Слишком много попыток входа. Подождите перед повтором.',
        INSTAGRAM_PRIVATE_LOGIN_IN_PROGRESS: 'Вход уже проверяется. Дождитесь результата и обновите состояние.',
        INSTAGRAM_PRIVATE_OPERATION_IN_PROGRESS: 'Дождитесь завершения текущей операции Instagram и повторите действие.',
        INSTAGRAM_PRIVATE_LOGIN_FAILED: 'Instagram не подтвердил вход. Проверьте данные и повторите попытку позже.',
        INSTAGRAM_PRIVATE_LOGIN_REQUIRED: 'Сессия Instagram закончилась. Войдите снова после проверки аккаунта в Instagram.',
        INSTAGRAM_PRIVATE_CREDENTIALS_INVALID: 'Проверьте логин, пароль и код подтверждения.',
        INSTAGRAM_PRIVATE_CONNECTION_UNAVAILABLE: 'Сервер AVA не может связаться с Instagram. Повторите проверку позже; данные для входа менять не нужно.',
        INSTAGRAM_PRIVATE_UPSTREAM_ERROR: 'Instagram не завершил запрос. Проверьте аккаунт в приложении Instagram и повторите попытку позже.',
        INSTAGRAM_PRIVATE_WORKER_UNAVAILABLE: 'Сервис Instagram временно недоступен. Повторите проверку позже.',
        INSTAGRAM_PRIVATE_WORKER_TIMEOUT: 'Instagram не ответил вовремя. Состояние входа сохранено; повторите попытку позже.',
        INSTAGRAM_PRIVATE_DEPENDENCY_MISSING: 'Сервис Instagram временно недоступен. Повторите проверку позже.',
        INSTAGRAM_PRIVATE_ACCOUNT_BOUND: 'Этот аккаунт уже подключён к другому бизнесу.',
        INSTAGRAM_PRIVATE_DISABLED: 'Подключение Instagram сейчас недоступно. Повторите проверку позже.',
        INSTAGRAM_PRIVATE_ALREADY_CONFIGURED: 'Аккаунт уже подключён. Обновите состояние.',
        BUSINESS_ACCESS_DENIED: 'У вас нет доступа к настройкам Instagram этого бизнеса.',
        CUSTOMER_ACCESS_REQUIRED: 'Войдите в кабинет бизнеса, чтобы управлять Instagram.',
    };
    return messages[code] || 'Не удалось выполнить действие. Проверьте соединение и повторите попытку.';
}

function pauseMessage(reason?: string) {
    if (reason === 'rate_limited') return 'Instagram временно ограничил запросы. Подождите несколько минут перед повторным входом.';
    if (reason === 'challenge_required' || reason === 'two_factor_required') {
        return 'Instagram запросил подтверждение. Выполните проверку в приложении Instagram перед повторным входом.';
    }
    if (reason === 'login_required') return 'Сессия закончилась. Проверьте аккаунт в Instagram и войдите снова.';
    return 'Приём и ответы временно остановлены. Проверьте аккаунт в Instagram перед повторным входом.';
}

export default function InstagramConnectionPanel({ businessId, canManage }: InstagramConnectionPanelProps) {
    const [status, setStatus] = useState<InstagramPrivateStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [needsCode, setNeedsCode] = useState(false);
    const codeInput = useRef<HTMLInputElement>(null);

    useEffect(() => { if (needsCode) codeInput.current?.focus(); }, [needsCode]);

    const refresh = useCallback(async (signal?: AbortSignal) => {
        setLoading(true);
        try {
            const result = await getInstagramPrivateStatus(businessId, signal);
            if (!signal?.aborted) { setStatus(result); setError(result.lastLoginError ? errorMessage(result.lastLoginError) : '');
                if (result.lastLoginError === 'INSTAGRAM_PRIVATE_TWO_FACTOR_REQUIRED') setNeedsCode(true); }
        } catch (cause) {
            if (!signal?.aborted) setError(errorMessage(errorCode(cause)));
        } finally {
            if (!signal?.aborted) setLoading(false);
        }
    }, [businessId]);

    useEffect(() => {
        const controller = new AbortController();
        setStatus(null);
        setError('');
        setUsername('');
        setPassword('');
        setCode('');
        setNeedsCode(false);
        void refresh(controller.signal);
        return () => controller.abort();
    }, [refresh]);

    // The server polls Direct in the background. Refresh only while confirmation is pending.
    useEffect(() => {
        if (status?.state !== 'awaiting_inbound') return;
        const timer = window.setInterval(() => { void refresh(); }, 30_000);
        return () => window.clearInterval(timer);
    }, [refresh, status?.state]);

    const login = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!canManage || busy || !username.trim() || !password) return;
        setBusy(true);
        setError('');
        try {
            const result = await loginInstagramPrivate(businessId, {
                username: username.trim(), password, ...(needsCode && code ? { code } : {}),
            });
            setStatus(result);
            setUsername('');
            setNeedsCode(false);
        } catch (cause) {
            const reason = errorCode(cause);
            if (reason === 'INSTAGRAM_PRIVATE_TWO_FACTOR_REQUIRED') setNeedsCode(true);
            setError(errorMessage(reason));
        } finally {
            setPassword('');
            setCode('');
            setBusy(false);
        }
    };

    const poll = async () => {
        if (!canManage || busy) return;
        setBusy(true);
        setError('');
        try { setStatus(await pollInstagramPrivate(businessId)); }
        catch (cause) {
            const message = errorMessage(errorCode(cause));
            await refresh();
            setError(message);
        } finally { setBusy(false); }
    };

    const disconnect = async () => {
        if (!canManage || busy || !window.confirm('Отключить Instagram? Приём и ответы остановятся, история диалогов сохранится.')) return;
        setBusy(true);
        setError('');
        try { setStatus(await disconnectInstagramPrivate(businessId)); }
        catch (cause) { setError(errorMessage(errorCode(cause))); }
        finally { setBusy(false); }
    };

    const connected = status?.state === 'connected' && status.inboundConfirmed === true;
    const awaitingInbound = status?.state === 'awaiting_inbound' || (status?.state === 'connected' && !connected);
    const step = connected ? 3 : awaitingInbound ? 2 : 1;

    return <section className="ava-ig-panel" aria-labelledby="ava-ig-title">
        <div className="ava-ig-heading">
            <span className="ava-ig-icon"><Instagram size={22} aria-hidden="true" /></span>
            <div><p className="ava-ig-kicker">КАНАЛ СООБЩЕНИЙ</p><h2 id="ava-ig-title">Instagram Direct</h2></div>
            {status && <span className={`ava-ig-badge ${connected ? 'is-connected' : ''}`}>
                {connected ? <Check size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}
                {connected ? 'Подключён' : status.state === 'paused' ? 'Приостановлен' : awaitingInbound ? 'Ждём Direct' : 'Не подключён'}
            </span>}
        </div>
        <p className="ava-ig-intro">Войдите в свой Instagram-аккаунт. После входа отправьте в него новое сообщение Direct с другого аккаунта и проверьте приём в AVA.</p>
        <ol className="ava-ig-steps" aria-label="Этапы подключения Instagram">
            {['Войти в Instagram', 'Получить новый Direct', 'Подключение подтверждено'].map((label, index) =>
                <li key={label} className={index + 1 < step ? 'is-complete' : index + 1 === step ? 'is-current' : ''}
                    aria-current={index + 1 === step ? 'step' : undefined}>
                    <span>{index + 1}</span>{label}
                </li>)}
        </ol>

        {!status && <div className="ava-ig-state" role="status">
            {loading ? 'Проверяем состояние Instagram…' : 'Не удалось получить состояние Instagram. Нажмите «Обновить состояние».'}
        </div>}
        {status?.state === 'disabled' && <div className="ava-ig-state" role="status">
            <strong>Подключение временно недоступно</strong><span>Попробуйте обновить состояние позже.</span>
        </div>}
        {status?.state === 'not_connected' && (canManage ? <form className="ava-ig-form" onSubmit={login}>
            <p>Для входа используйте данные своего Instagram-аккаунта. Если Instagram запросит код, введите его здесь при повторной попытке.</p>
            <label>Логин Instagram<input value={username} onChange={event => setUsername(event.target.value)}
                autoComplete="username" spellCheck={false} required disabled={busy} /></label>
            <label>Пароль<input type="password" value={password} onChange={event => setPassword(event.target.value)}
                autoComplete="current-password" required disabled={busy} /></label>
            {needsCode && <label>Код подтверждения<input ref={codeInput} value={code} onChange={event => setCode(event.target.value)}
                inputMode="numeric" pattern="[0-9]{6,8}" autoComplete="one-time-code" required disabled={busy} /></label>}
            <button type="submit" className="ava-ig-primary" disabled={busy}>
                {busy ? 'Проверяем вход…' : needsCode ? 'Подтвердить вход' : 'Войти в Instagram'}
            </button>
        </form> : <p className="ava-ig-note">Войти может владелец бизнеса.</p>)}
        {awaitingInbound && <div className="ava-ig-state" role="status">
            <strong>Вход выполнен. Ждём новый Direct</strong>
            <span>Отправьте новое сообщение на этот аккаунт Instagram с другого аккаунта. Затем нажмите «Проверить входящие». Подключение подтвердится после сохранения сообщения в диалогах AVA.</span>
        </div>}
        {connected && <div className="ava-ig-state is-connected" role="status">
            <strong>Instagram Direct подключён</strong><span>Новое входящее сообщение получено и сохранено в AVA. Теперь можно отвечать в диалогах.</span>
        </div>}
        {status?.state === 'paused' && <div className="ava-ig-state" role="status">
            <strong>Подключение приостановлено</strong>
            <span>{pauseMessage(status.pauseReason)} После проверки отключите текущую сессию и войдите снова.</span>
        </div>}
        {status?.accountMasked && <p className="ava-ig-note">Аккаунт: {status.accountMasked}</p>}
        {error && <p className="ava-ig-error" role="alert">{error}</p>}
        <div className="ava-ig-actions">
            {awaitingInbound && canManage && <button type="button" className="ava-ig-primary" onClick={() => void poll()} disabled={busy}>
                {busy ? 'Проверяем…' : 'Проверить входящие'}
            </button>}
            {connected && <Link className="ava-ig-primary" to="/conversations">Открыть диалоги <ChevronRight size={16} aria-hidden="true" /></Link>}
            <button type="button" onClick={() => void refresh()} disabled={busy || loading}>
                <RefreshCw size={16} aria-hidden="true" />{loading ? 'Обновляем…' : 'Обновить состояние'}
            </button>
            {status?.configured && canManage && <button type="button" className="ava-ig-disconnect" onClick={() => void disconnect()} disabled={busy}>
                Отключить Instagram
            </button>}
        </div>
    </section>;
}
