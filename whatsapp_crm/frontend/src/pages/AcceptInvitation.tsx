import { FormEvent, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Mail, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { roleLabel } from '../teamSales';
import './Team.css';

type Details = { businessId: number; businessName: string; email: string; role: string; acceptance: 'existing_account' | 'new_account' | 'legacy'; newAccountEnabled?: boolean };
type Verification = { id: string; email: string; nextResend: number };
const resendCooldownMs = 60000;
const tokenKey = 'ava:invite-token', verificationKey = 'ava:invite-verification', pendingKey = 'ava:invite-enrolling';
function read(key: string) { try { return sessionStorage.getItem(key) || ''; } catch { return ''; } }
function write(key: string, value: string) { try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch { /* Storage is optional; verification stays in current tab. */ } }
function initialToken() {
    const token = window.location.hash.slice(1);
    if (token) { write(tokenKey, token); write(verificationKey, ''); write(pendingKey, ''); window.history.replaceState(null, '', window.location.pathname + window.location.search); }
    return token || read(tokenKey);
}
function initialVerification(): Verification | null {
    try {
        const saved = JSON.parse(read(verificationKey) || 'null');
        if (!saved) return null;
        if (typeof saved.id !== 'string' || !saved.id || typeof saved.email !== 'string' || !saved.email) { write(verificationKey, ''); return null; }
        const latest = Date.now() + resendCooldownMs;
        const nextResend = typeof saved.nextResend === 'number' && Number.isFinite(saved.nextResend)
            ? Math.max(0, Math.min(saved.nextResend, latest)) : latest;
        const normalized = { id: saved.id, email: saved.email, nextResend };
        // Persist the repaired deadline so another reload cannot start a new minute.
        if (nextResend !== saved.nextResend) write(verificationKey, JSON.stringify(normalized));
        return normalized;
    } catch { write(verificationKey, ''); return null; }
}
const unavailableMessage = 'Создание нового аккаунта для команды временно недоступно. Если у вас уже есть аккаунт AVA, войдите с почтой из приглашения. Иначе попросите владельца бизнеса повторить приглашение позже.';
const errors: Record<string, string> = {
    TEAM_NEW_ACCOUNT_UNAVAILABLE: unavailableMessage,
    INVITATION_INVALID: 'Ссылка больше не действует. Попросите владельца бизнеса прислать новую.',
    INVITATION_ACCOUNT_MISMATCH: 'Войдите с почтой, указанной в приглашении. Текущий аккаунт не подходит.',
    INVITATION_IDENTITY_MISMATCH: 'Войдите с почтой, указанной в приглашении. Текущий аккаунт не подходит.',
    INVITATION_AUTHENTICATION_REQUIRED: 'Войдите в AVA с приглашённой почтой, затем откройте эту ссылку снова.',
    INVITATION_EXISTING_ACCOUNT_REQUIRED: 'Этот аккаунт уже существует. Войдите с приглашённой почтой и примите доступ.',
    ACCOUNT_NOT_ACTIVE: 'Аккаунт пока недоступен. Обратитесь к администратору AVA.',
    IDENTITY_ENROLLMENT_UNAVAILABLE: 'Сервис добавления сотрудника временно недоступен. Повторите попытку позже.',
    TEAM_ENROLLMENT_RECONCILIATION_REQUIRED: 'Добавление сотрудника требует проверки администратором AVA. Попросите владельца бизнеса обратиться в поддержку для завершения доступа.',
    PASSWORD_POLICY: 'Используйте пароль от 12 до 256 символов, который не совпадает с вашей почтой.',
    VERIFICATION_NOT_FOUND: 'Подтверждение почты истекло. Задайте пароль и запросите новый код.',
    VERIFICATION_REQUIRED: 'Подтвердите почту кодом из письма.',
    PREVIOUS_ACCESS_REVOCATION_PENDING: 'Предыдущий доступ ещё закрывается. Повторите добавление через минуту.',
    INVITATION_AUTH_REQUIRED: 'Войдите в AVA с приглашённой почтой, затем откройте эту ссылку снова.',
    ACCOUNT_ALREADY_MEMBER: 'У вас уже есть доступ к этому бизнесу. Откройте AVA.',
    ACCOUNT_ALREADY_EXISTS: 'Этот аккаунт уже существует. Войдите с приглашённой почтой и откройте ссылку снова.',
    INVALID_VERIFICATION_CODE: 'Неверный код. Проверьте шесть цифр из письма.', VERIFICATION_CODE_EXPIRED: 'Код истёк. Отправьте код ещё раз.',
    MAX_ATTEMPTS_EXCEEDED: 'Слишком много попыток. Запросите новый код.', RESEND_COOLDOWN: 'Повторная отправка пока недоступна. Подождите немного.',
    IDENTITY_RATE_LIMITED: 'Слишком много попыток. Повторите через минуту.', INVITATION_IN_PROGRESS: 'Доступ ещё создаётся. Подождите и попробуйте войти.',
};
export default function AcceptInvitation() {
    const auth = useAuth();
    const [token, setToken] = useState(initialToken), [details, setDetails] = useState<Details | null>(null), [verification, setVerification] = useState(initialVerification);
    const [phase, setPhase] = useState<'checking' | 'ready' | 'complete' | 'unknown' | 'invalid'>(() => read(pendingKey) ? 'unknown' : 'checking');
    const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [code, setCode] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0), [now, setNow] = useState(Date.now());
    const active = useRef<AbortController | null>(null), title = useRef<HTMLHeadingElement>(null);
    const cooldown = verification ? Math.max(0, Math.ceil((verification.nextResend - now) / 1000)) : 0;
    useEffect(() => {
        const capture = () => { const next = window.location.hash.slice(1); if (!next) return; active.current?.abort(); write(tokenKey, next); write(verificationKey, ''); write(pendingKey, ''); setToken(next); setDetails(null); setVerification(null); setPassword(''); setConfirmation(''); setCode(''); setError(''); setBusy(false); setPhase('checking'); setRetry(n => n + 1); window.history.replaceState(null, '', window.location.pathname + window.location.search); };
        window.addEventListener('hashchange', capture); window.addEventListener('popstate', capture);
        return () => { active.current?.abort(); window.removeEventListener('hashchange', capture); window.removeEventListener('popstate', capture); };
    }, []);
    useEffect(() => { if (phase !== 'checking') title.current?.focus(); }, [phase]);
    useEffect(() => { if (!verification) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [verification]);
    useEffect(() => {
        if (!token) { setPhase('invalid'); return; }
        if (read(pendingKey)) { setPhase('unknown'); return; }
        const controller = new AbortController(); active.current = controller; setPhase('checking');
        request('inspect', { token }, controller.signal).then(data => {
            if (controller.signal.aborted) return;
            if (!['existing_account', 'new_account', 'legacy'].includes(data.acceptance)) throw new Error();
            setDetails(data);
            if (data.acceptance === 'new_account' && data.newAccountEnabled === false) {
                write(verificationKey, ''); setVerification(null); setPassword(''); setConfirmation(''); setCode('');
            }
            setPhase('ready');
        }).catch(cause => { if (!controller.signal.aborted) { if ((cause as { code?: string })?.code === 'INVITATION_INVALID') { write(tokenKey, ''); write(verificationKey, ''); setVerification(null); } setPhase('invalid'); setError(cause instanceof Error ? cause.message : 'Не удалось проверить приглашение.'); } });
        return () => controller.abort();
    }, [token, retry]);
    async function request(path: string, body: object, signal: AbortSignal) {
        const bounded = new AbortController();
        const abort = () => bounded.abort();
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; bounded.abort(); }, path === 'redeem' ? 65000 : 20000);
        try {
            const response = await fetch(`/api/invitations/${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: bounded.signal });
            const data = await response.json().catch(cause => { if (bounded.signal.aborted) throw cause; return null; });
            if (!response.ok || data?.success !== true) {
                const errorCode = data?.code || data?.error_code;
                if (response.status === 401) window.dispatchEvent(new Event('crm:unauthorized'));
                if (response.status === 403) window.dispatchEvent(new Event('crm:forbidden'));
                throw Object.assign(new Error(errors[errorCode] || 'Не удалось подтвердить действие. Попробуйте ещё раз.'), { confirmedFailure: true, code: errorCode });
            }
            return data;
        } catch (cause) {
            if (timedOut) throw new Error('AVA не ответила вовремя. Проверьте состояние и повторите попытку.');
            throw cause;
        } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    }
    async function perform(path: string, body: object, complete = false) {
        if (busy) return;
        setBusy(true); setError(''); const controller = new AbortController(); active.current = controller;
        if (complete) write(pendingKey, '1');
        try {
            const data = await request(path, body, controller.signal);
            if (controller.signal.aborted) return;
            if (complete) {
                write(pendingKey, ''); write(tokenKey, ''); write(verificationKey, '');
                if (details?.businessId) write('ava:preferred-business', String(details.businessId));
                setPassword(''); setConfirmation(''); setCode(''); setPhase('complete');
                if (details?.acceptance === 'existing_account') await auth.refreshAuth();
            } else {
                const duration = Number(data.resend_after_ms);
                const boundedDuration = Number.isFinite(duration) && duration >= 0 ? Math.min(duration, resendCooldownMs) : resendCooldownMs;
                const next = { id: data.verification_id || verification?.id, email: data.masked_email || verification?.email || details?.email, nextResend: Date.now() + boundedDuration };
                if (!next.id || !next.email) throw new Error('Не удалось получить код. Повторите попытку.');
                setVerification(next); write(verificationKey, JSON.stringify(next)); setPassword(''); setConfirmation(''); setCode('');
            }
        } catch (cause) {
            if (!controller.signal.aborted) {
                setError(cause instanceof Error ? cause.message : 'Не удалось подключиться к AVA.');
                if ((cause as { code?: string })?.code === 'INVITATION_INVALID') { write(tokenKey, ''); write(verificationKey, ''); setPhase('invalid'); }
                const errorCode = (cause as { code?: string })?.code;
                if (['ACCOUNT_ALREADY_EXISTS', 'INVITATION_EXISTING_ACCOUNT_REQUIRED', 'INVITATION_AUTHENTICATION_REQUIRED', 'INVITATION_AUTH_REQUIRED'].includes(errorCode || '')) {
                    setDetails(current => current ? { ...current, acceptance: 'existing_account' } : current);
                    write(verificationKey, ''); write(pendingKey, ''); setVerification(null); setPassword(''); setConfirmation(''); setCode('');
                }
                if (errorCode === 'VERIFICATION_NOT_FOUND') { write(verificationKey, ''); setVerification(null); setCode(''); }
                if (errorCode === 'TEAM_NEW_ACCOUNT_UNAVAILABLE') {
                    setDetails(current => current ? { ...current, newAccountEnabled: false } : current);
                    write(verificationKey, ''); write(pendingKey, ''); setVerification(null); setPassword(''); setConfirmation(''); setCode('');
                }
                if (read(pendingKey)) {
                    if ((cause as { confirmedFailure?: boolean })?.confirmedFailure) write(pendingKey, '');
                    else setPhase('unknown');
                }
            }
        } finally { if (active.current === controller && !controller.signal.aborted) { active.current = null; setBusy(false); } }
    }
    async function switchAccount() {
        if (busy) return; setBusy(true); setError('');
        try { await auth.logout(); }
        catch { setError('Не удалось завершить текущую сессию. Повторите попытку.'); }
        finally { setBusy(false); }
    }
    function register(event: FormEvent) { event.preventDefault(); if (password.length < 12 || password !== confirmation) { setError('Используйте не менее 12 символов. Пароли должны совпадать.'); return; } void perform(details?.acceptance === 'legacy' ? 'redeem' : 'request-verification', { token, password }, details?.acceptance === 'legacy'); }
    function verify(event: FormEvent) { event.preventDefault(); if (!/^\d{6}$/.test(code.trim())) { setError('Введите шесть цифр из письма.'); return; } void perform('redeem', { token, verificationId: verification?.id, code: code.trim() }, true); }
    return <main className="min-h-screen flex items-center justify-center p-4"><section className="ava-team team-card w-full max-w-lg p-6" aria-busy={busy || phase === 'checking'}><p className="team-eyebrow">AVA · ПРИГЛАШЕНИЕ В КОМАНДУ</p><h1 ref={title} tabIndex={-1} className="text-2xl font-semibold mb-4">{phase === 'complete' ? 'Доступ готов' : 'Добро пожаловать в команду'}</h1>
        {phase === 'checking' ? <p role="status">Проверяем приглашение…</p> : phase === 'complete' ? <div role="status"><Check size={28} aria-hidden="true"/><p className="my-4">{details?.acceptance === 'existing_account' ? `Теперь вы в команде «${details.businessName}». Ваша роль: ${roleLabel(details.role)}. Ваш текущий аккаунт сохранён.` : `Почта подтверждена, доступ к бизнесу «${details?.businessName || 'Команда AVA'}» создан. Ваша роль: ${roleLabel(details?.role || '')}. Войдите в AVA с приглашённой почтой.`}</p><a className="team-primary px-4 py-3" href={details?.acceptance === 'existing_account' ? '/sales' : '/api/auth/sso/start'}>Открыть AVA<ArrowRight size={17} aria-hidden="true"/></a></div> : phase === 'unknown' ? <div><p className="my-4">Результат создания доступа пока не подтверждён. Попробуйте войти с приглашённой почтой. Если войти не удаётся, попросите владельца бизнеса обратиться в поддержку AVA для проверки доступа.</p><a className="team-primary px-4 py-3" href="/api/auth/sso/start">Войти в AVA</a><button className="team-secondary mt-4 w-full" onClick={() => { write(pendingKey, ''); setError(''); setPhase('checking'); setRetry(n => n + 1); }}>Проверить состояние</button></div> : phase === 'invalid' ? <div><p role="alert">{error || 'Откройте полную ссылку приглашения от владельца бизнеса.'}</p>{token && <button className="team-secondary mt-4" onClick={() => { setError(''); setRetry(n => n + 1); }}>Проверить ещё раз</button>}</div> : details && <>
        <div className="rounded-xl p-4 mb-5" style={{ background: 'var(--ai-soft)' }}><strong>{details.businessName || 'Команда AVA'}</strong><p className="mt-2 text-sm">{details.email}</p><p className="mt-1 text-sm">{roleLabel(details.role)}</p></div>
        {error && <p className="team-inline-error mx-0" id="invitation-error" role="alert">{error}</p>}
        {details.acceptance === 'existing_account' ? <div><p className="mb-4 text-sm">{auth.loading ? 'Проверяем текущий аккаунт…' : auth.authenticated ? `Вы вошли как ${auth.displayName || auth.loginName}. Доступ добавится к вашему текущему аккаунту.` : 'Войдите с приглашённой почтой и откройте эту ссылку снова. Она сохранена в этой вкладке.'}</p>{auth.authenticated ? <button className="team-primary w-full" disabled={busy || auth.loading} onClick={() => void perform('accept', { token }, true)}><ShieldCheck size={17} aria-hidden="true"/>{busy ? 'Добавляем доступ…' : 'Присоединиться к команде'}</button> : !auth.loading && <a href="/api/auth/sso/start" className="team-primary px-4 py-3">Войти в AVA</a>}{auth.authenticated && <button className="team-secondary w-full mt-3" disabled={busy || auth.loading} onClick={() => void switchAccount()}>Выйти из текущего аккаунта</button>}</div>
        : details.acceptance === 'new_account' && details.newAccountEnabled === false ? <div>
            {!error && <p role="status" className="mb-4">{unavailableMessage}</p>}
            <a href="/api/auth/sso/start" className="team-primary px-4 py-3">Войти в AVA<ArrowRight size={17} aria-hidden="true"/></a>
        </div>
        : auth.authenticated ? <div><p className="mb-4">Сейчас вы вошли как {auth.displayName || auth.loginName}. Завершите текущую сессию, чтобы зарегистрировать сотрудника с почтой из приглашения. Ссылка сохранена в этой вкладке.</p><button className="team-secondary w-full" disabled={busy || auth.loading} onClick={() => void switchAccount()}>Выйти из текущего аккаунта</button></div>
        : verification && details.acceptance === 'new_account' ? <form onSubmit={verify} className="space-y-4"><p className="text-sm"><Mail size={17} className="inline mr-2" aria-hidden="true"/>Код отправлен на {verification.email}.</p><div><label htmlFor="invite-code">Код из письма</label><input id="invite-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} value={code} disabled={busy} onChange={e => setCode(e.target.value)} aria-describedby={error ? 'invitation-error' : undefined}/></div><button className="team-primary w-full" disabled={busy}>{busy ? 'Подтверждаем…' : 'Подтвердить и создать доступ'}</button><button type="button" className="team-secondary w-full" disabled={busy || cooldown > 0} onClick={() => void perform('resend-code', { token, verificationId: verification.id })}>{cooldown ? `Отправить снова через ${cooldown} с` : 'Отправить код ещё раз'}</button></form>
        : <form onSubmit={register} className="space-y-4"><p className="text-sm">Задайте личный пароль — не менее 12 символов.{details.acceptance === 'new_account' ? ' Затем подтвердите почту кодом из письма.' : ''}</p><div><label htmlFor="new-password">Новый пароль</label><input id="new-password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={password} disabled={busy || auth.loading} onChange={e => setPassword(e.target.value)} aria-describedby={error ? 'invitation-error' : undefined}/></div><div><label htmlFor="confirm-password">Повторите пароль</label><input id="confirm-password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={confirmation} disabled={busy || auth.loading} onChange={e => setConfirmation(e.target.value)}/></div><button className="team-primary w-full" disabled={busy || auth.loading}>{busy ? 'Подождите…' : details.acceptance === 'legacy' ? 'Активировать доступ' : 'Получить код'}</button></form>}
        </>}
    </section></main>;
}
