import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getLoginConfig } from '../publicIdentityApi';
import PublicShell from './public/PublicShell';
import { enrollmentLoginUrl } from './public/enrollmentSession';

export default function Login() {
    const { login } = useAuth();
    const manual = new URLSearchParams(window.location.search).get('login') === 'manual';
    const [loginValue, setLoginValue] = useState('');
    const [password, setPassword] = useState('');
    const [visible, setVisible] = useState(false);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [sso, setSso] = useState<boolean | null>(null);
    const [configError, setConfigError] = useState(false);
    const [retry, setRetry] = useState(0);
    const alert = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const controller = new AbortController(); setConfigError(false); setSso(null);
        getLoginConfig(controller.signal).then(data => { if (!controller.signal.aborted) setSso(data.sso_enabled); })
            .catch(() => { if (!controller.signal.aborted) setConfigError(true); });
        return () => controller.abort();
    }, [retry]);
    useEffect(() => { if (error) alert.current?.focus(); }, [error]);
    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault(); if (busy) return;
        setBusy(true); setError('');
        try { await login(loginValue.trim(), password); setPassword(''); }
        catch { setError('Не удалось войти. Проверьте логин и пароль и попробуйте ещё раз.'); }
        finally { setBusy(false); }
    }
    return <PublicShell>
        <a href="/" className="public-back">← На главную</a>
        <h1>С возвращением</h1>
        <p className="public-description">Войдите, чтобы продолжить работу с клиентами и командой.</p>
        {configError ? <><div className="public-alert" role="alert">Не удалось подготовить вход. Проверьте соединение и попробуйте ещё раз.</div><button className="public-button secondary" onClick={() => setRetry(n => n + 1)}>Повторить</button></>
            : sso === null ? <p className="public-status" role="status">Подготавливаем вход…</p>
            : <>
                {sso && <a className="public-button" href={enrollmentLoginUrl() || '/api/auth/sso/start'}>Продолжить вход <ArrowRight size={18} aria-hidden="true" /></a>}
                {(!sso || manual) && <form onSubmit={submit} aria-busy={busy}>
                    <div className="public-field"><label htmlFor="public-login">Логин</label><input id="public-login" autoComplete="username" required maxLength={254} value={loginValue} onChange={e => setLoginValue(e.target.value)} disabled={busy} /></div>
                    <div className="public-field"><label htmlFor="public-password">Пароль</label><div className="public-password"><input id="public-password" type={visible ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /><button type="button" aria-pressed={visible} onClick={() => setVisible(v => !v)}>{visible ? 'Скрыть' : 'Показать'}</button></div></div>
                    {error && <div className="public-alert" role="alert" ref={alert} tabIndex={-1}>{error}</div>}
                    <button className="public-button" disabled={busy} type="submit">{busy && <Loader2 className="public-spinner" size={18} aria-hidden="true" />}{busy ? 'Входим…' : 'Войти'}</button>
                </form>}
                <a className="public-link" href="/forgot-password">Забыли пароль?</a>
            </>}
        <p className="public-note">Ещё нет бизнеса в AVA? <a className="public-link" href="/register">Создать бизнес</a></p>
    </PublicShell>;
}
