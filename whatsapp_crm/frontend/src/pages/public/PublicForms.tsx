import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, Loader2, Mail } from 'lucide-react';
import { getPublicIdentityConfig, startRegistration, verifyRegistration, resendVerification, recoverPassword, getRegistrationStatus, PublicIdentityError } from '../../publicIdentityApi';
import PublicShell from './PublicShell';
import { enrollmentLoginUrl, saveEnrolledAccount } from './enrollmentSession';

const pendingKey = 'ava:public-registration';
const draftKey = 'ava:public-registration-draft';
type SafeDraft = { displayName: string; businessName: string; email: string; step: number };
function readSafeDraft(): SafeDraft {
    try {
        const value = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
        if (value && typeof value.displayName === 'string' && value.displayName.length <= 100
            && typeof value.businessName === 'string' && value.businessName.length <= 120
            && typeof value.email === 'string' && value.email.length <= 254) return { ...value, step: value.step === 1 ? 1 : 0 };
    } catch { /* Browser storage is optional. */ }
    return { displayName: '', businessName: '', email: '', step: 0 };
}
interface Pending { id: string; email: string; resendAt: number; expiresAt: number; passwordCorrection?: boolean }
function readPending(): Pending | null {
    try {
        const value = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
        return value && typeof value.id === 'string' && typeof value.email === 'string' && Number.isFinite(value.resendAt) && Number.isFinite(value.expiresAt) ? value : null;
    } catch { return null; }
}
function savePending(value: Pending | null) {
    try { if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value)); else sessionStorage.removeItem(pendingKey); } catch { /* Browser storage is optional. */ }
}
function useRequest() {
    const controller = useRef<AbortController | null>(null);
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [retryAt, setRetryAt] = useState(0);
    const [now, setNow] = useState(Date.now());
    useEffect(() => () => controller.current?.abort(), []);
    useEffect(() => { if (retryAt <= Date.now()) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [retryAt]);
    async function run<T,>(action: (signal: AbortSignal) => Promise<T>, done: (data: T) => void, failed?: (cause: unknown) => void) {
        if (controller.current || retryAt > Date.now()) return;
        const request = new AbortController(); controller.current = request; setBusy(true); setError('');
        try { const data = await action(request.signal); if (!request.signal.aborted) done(data); }
        catch (cause) { if (!request.signal.aborted) {
            failed?.(cause);
            setError(cause instanceof PublicIdentityError ? cause.message : 'Не удалось подтвердить действие. Попробуйте ещё раз.');
            if (cause instanceof PublicIdentityError && cause.retryAfter) setRetryAt(Date.now() + cause.retryAfter * 1000);
        } }
        finally { if (!request.signal.aborted) setBusy(false); if (controller.current === request) controller.current = null; }
    }
    return { busy, error, run, clear: () => setError(''), wait: Math.max(0, Math.ceil((retryAt - now) / 1000)) };
}
function Feedback({ error }: { error: string }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => { if (error) ref.current?.focus(); }, [error]);
    return error ? <div ref={ref} className="public-alert" role="alert" tabIndex={-1}>{error}</div> : null;
}
function Submit({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children: ReactNode }) {
    return <button className="public-button" type="submit" disabled={busy || disabled}>{busy ? <Loader2 className="public-spinner" size={18} aria-hidden="true" /> : null}{children}</button>;
}
function Availability({ kind, children }: { kind: 'registration' | 'recovery'; children: ReactNode }) {
    const [state, setState] = useState<'loading' | 'ready' | 'disabled' | 'error'>('loading'), [retry, setRetry] = useState(0);
    useEffect(() => {
        const controller = new AbortController(); setState('loading');
        getPublicIdentityConfig(controller.signal).then(config => {
            if (!controller.signal.aborted) setState(config[kind === 'registration' ? 'registrationEnabled' : 'recoveryEnabled'] ? 'ready' : 'disabled');
        }).catch(() => { if (!controller.signal.aborted) setState('error'); });
        return () => controller.abort();
    }, [kind, retry]);
    if (state === 'ready') return children;
    return <PublicShell><a className="public-back" href="/">← На главную</a><h1>{kind === 'registration' ? 'Создать бизнес' : 'Восстановить пароль'}</h1>
        {state === 'loading' ? <p className="public-status" role="status">Подготавливаем форму…</p> : <><p className="public-description" role="alert">{state === 'disabled' ? 'Сейчас это действие недоступно. Попробуйте позже.' : 'Не удалось загрузить форму. Проверьте соединение и повторите попытку.'}</p><button className="public-button secondary" onClick={() => setRetry(n => n + 1)}>Повторить</button><a className="public-link" href="/login">Вернуться ко входу</a></>}
    </PublicShell>;
}
export function Registration() { return <Availability kind="registration"><RegistrationForm /></Availability>; }
function RegistrationForm() {
    const [pending, setPending] = useState(readPending);
    const [step, setStep] = useState(() => readPending() ? 2 : readSafeDraft().step);
    const [displayName, setDisplayName] = useState(() => readSafeDraft().displayName), [businessName, setBusinessName] = useState(() => readSafeDraft().businessName), [email, setEmail] = useState(() => readSafeDraft().email);
    const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [visible, setVisible] = useState(false), [code, setCode] = useState('');
    const [validation, setValidation] = useState(''), [loginUrl, setLoginUrl] = useState(enrollmentLoginUrl), [resent, setResent] = useState(false), [now, setNow] = useState(Date.now());
    const request = useRequest(); const heading = useRef<HTMLHeadingElement>(null);
    const [existingAccount, setExistingAccount] = useState(false);
    const restoredChallenge = useRef(readPending());
    const challengeGeneration = useRef(0);
    const [statusError, setStatusError] = useState(false);
    useEffect(() => {
        try { sessionStorage.setItem(draftKey, JSON.stringify({ displayName, businessName, email, step: Math.min(step, 1) })); } catch { /* Storage is optional. */ }
    }, [displayName, businessName, email, step]);
    useEffect(() => {
        const restored = restoredChallenge.current;
        if (!restored) return;
        const controller = new AbortController();
        const generation = challengeGeneration.current;
        void getRegistrationStatus(restored.id, controller.signal).then(data => {
            if (controller.signal.aborted || challengeGeneration.current !== generation) return;
            if (data.status === 'completed' || data.status === 'existing_account') { savePending(null); setPending(null); if (data.status === 'existing_account') setExistingAccount(true); else if (data.login_url) { saveEnrolledAccount(new URL(data.login_url, window.location.origin).searchParams.get('enrolled_user') || ''); setLoginUrl(data.login_url); } return; }
            const next = { ...restored, email: data.masked_email, expiresAt: Date.now() + data.expires_in_ms, resendAt: Date.now() + data.resend_after_ms };
            savePending(next); setPending(next); setStatusError(false);
        }).catch(() => { if (!controller.signal.aborted && challengeGeneration.current === generation) setStatusError(true); });
        return () => controller.abort();
    }, []);
    useEffect(() => { heading.current?.focus(); }, [step, loginUrl, existingAccount]);
    useEffect(() => { if (!pending) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [pending]);
    const expired = pending ? pending.expiresAt <= now : false;
    const cooldown = Math.max(request.wait, pending ? Math.ceil((pending.resendAt - now) / 1000) : 0);
    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault(); setValidation('');
        if (step === 0) { setStep(1); return; }
        if (step === 1 || pending?.passwordCorrection) {
            if (password.length < 12 || password.length > 256) { setValidation('Используйте пароль длиной от 12 до 256 символов.'); return; }
            if (step === 1 && password.toLowerCase() === email.trim().toLowerCase()) { setValidation('Пароль не должен совпадать с электронной почтой.'); return; }
            if (password !== confirmation) { setValidation('Пароли не совпадают. Проверьте оба поля.'); return; }
        }
        if (step === 1) {
            await request.run(signal => startRegistration({ displayName: displayName.trim(), businessName: businessName.trim(), email: email.trim(), password }, signal), data => {
                ++challengeGeneration.current;
                const value = { id: data.verification_id, email: data.masked_email, resendAt: Date.now() + data.resend_after_ms, expiresAt: Date.now() + data.expires_in_ms };
                savePending(value); setPending(value); setPassword(''); setConfirmation(''); setStep(2);
            });
        } else if (pending) {
            await request.run(signal => verifyRegistration({ verification_id: pending.id, code, ...(pending.passwordCorrection ? { password } : {}) }, signal), data => {
                ++challengeGeneration.current; savePending(null); setCode(''); setPassword(''); setConfirmation(''); setPending(null);
                try { sessionStorage.removeItem(draftKey); } catch { /* optional */ }
                if (data.status === 'existing_account') { setExistingAccount(true); return; }
                saveEnrolledAccount(data.user_id); setLoginUrl(data.login_url);
            }, cause => {
                if (cause instanceof PublicIdentityError && cause.code === 'PASSWORD_POLICY') {
                    const next = { ...pending, passwordCorrection: true }; savePending(next); setPending(next); setPassword(''); setConfirmation('');
                }
            });
        }
    }
    function restart() { ++challengeGeneration.current; savePending(null); setStatusError(false); setPending(null); setCode(''); setPassword(''); setConfirmation(''); setResent(false); request.clear(); setValidation(''); setStep(0); }
    if (existingAccount) return <PublicShell><div className="public-success-icon"><Check size={24} aria-hidden="true" /></div><h1 ref={heading} tabIndex={-1}>У вас уже есть аккаунт</h1><p className="public-description">Почта подтверждена. Войдите в своё пространство или восстановите пароль — ваш бизнес и команда останутся на месте.</p><div className="public-actions"><a className="public-button" href="/api/auth/sso/start">Войти в AVA <ArrowRight size={18} aria-hidden="true" /></a><a className="public-button secondary" href="/forgot-password">Восстановить пароль</a></div></PublicShell>;
    if (loginUrl) return <PublicShell><div className="public-success-icon"><Check size={24} aria-hidden="true" /></div><h1 ref={heading} tabIndex={-1}>Почта подтверждена</h1><p className="public-description">Ваш бизнес создан. Войдите в аккаунт, чтобы настроить пространство для команды.</p><a className="public-button" href={loginUrl}>Перейти в AVA <ArrowRight size={18} aria-hidden="true" /></a></PublicShell>;
    return <PublicShell>
        <ol className="public-steps" aria-label="Шаги регистрации">{['О вас', 'Доступ', 'Подтверждение'].map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined}>{index + 1}. {label}</li>)}</ol>
        <h1 ref={heading} tabIndex={-1}>{step === 0 ? 'Начнём знакомство' : step === 1 ? 'Создайте свой аккаунт' : 'Проверьте почту'}</h1>
        <p className="public-description">{step === 0 ? 'Расскажите немного о себе и своём бизнесе.' : step === 1 ? 'На эту почту придёт код подтверждения.' : <>Введите шестизначный код из письма для <strong>{pending?.email}</strong>. Если письма нет, проверьте папку «Спам».</>}</p>
        <form onSubmit={submit} aria-busy={request.busy}>
            {step === 0 && <>
                <div className="public-field"><label htmlFor="register-name">Как вас зовут</label><input id="register-name" autoComplete="name" required maxLength={100} value={displayName} onChange={e => setDisplayName(e.target.value)} /></div>
                <div className="public-field"><label htmlFor="register-business">Название бизнеса</label><input id="register-business" autoComplete="organization" required maxLength={120} value={businessName} onChange={e => setBusinessName(e.target.value)} /></div>
            </>}
            {step === 1 && <>
                <div className="public-field"><label htmlFor="register-email">Электронная почта</label><input id="register-email" type="email" autoComplete="email" required maxLength={254} value={email} disabled={request.busy} onChange={e => setEmail(e.target.value)} /></div>
                <div className="public-field"><label htmlFor="register-password">Пароль</label><div className="public-password"><input id="register-password" type={visible ? 'text' : 'password'} autoComplete="new-password" required minLength={12} maxLength={256} aria-describedby="register-password-hint" value={password} disabled={request.busy} onChange={e => setPassword(e.target.value)} /><button type="button" aria-pressed={visible} onClick={() => setVisible(v => !v)}>{visible ? 'Скрыть' : 'Показать'}</button></div><small id="register-password-hint">От 12 до 256 символов. Пароль не должен совпадать с почтой или именем пользователя.</small></div>
                <div className="public-field"><label htmlFor="register-confirm">Повторите пароль</label><input id="register-confirm" type={visible ? 'text' : 'password'} autoComplete="new-password" required minLength={12} maxLength={256} aria-invalid={Boolean(validation)} aria-describedby={validation ? 'register-mismatch' : undefined} value={confirmation} disabled={request.busy} onChange={e => { setConfirmation(e.target.value); setValidation(''); }} />{validation && <small id="register-mismatch">{validation}</small>}</div>
            </>}
            {step === 2 && <div className="public-field"><label htmlFor="register-code">Код из письма</label><input id="register-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} disabled={request.busy} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} /></div>}
            {step === 2 && pending?.passwordCorrection && <>
                <p className="public-description">Выберите другой пароль, чтобы завершить регистрацию с этим же кодом.</p>
                <div className="public-field"><label htmlFor="replacement-password">Новый пароль</label><input id="replacement-password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} aria-describedby="replacement-hint" value={password} disabled={request.busy} onChange={e => setPassword(e.target.value)} /><small id="replacement-hint">От 12 до 256 символов. Пароль не должен совпадать с почтой или именем пользователя.</small></div>
                <div className="public-field"><label htmlFor="replacement-confirm">Повторите новый пароль</label><input id="replacement-confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={256} aria-invalid={Boolean(validation)} value={confirmation} disabled={request.busy} onChange={e => { setConfirmation(e.target.value); setValidation(''); }} /></div>
            </>}
            <Feedback error={request.error || validation} />
            <Submit busy={request.busy} disabled={request.wait > 0 || expired}>{request.busy ? 'Подождите…' : step === 0 ? 'Продолжить' : step === 1 ? 'Получить код' : 'Подтвердить почту'}</Submit>
            {request.wait > 0 && <p className="public-note" role="status">Повторить можно через {request.wait} сек.</p>}
        </form>
        {step === 2 && pending && <>
            {!expired && <p className="public-note">Код действует ещё {Math.max(1, Math.ceil((pending.expiresAt - now) / 60000))} мин. После повторной отправки используйте код из последнего письма.</p>}
            {statusError && <p className="public-note" role="status">Не удалось обновить срок действия. Попробуйте код из последнего письма или запросите его повторно.</p>}
            {expired && <p className="public-alert" role="alert">Срок действия кода истёк. Укажите почту ещё раз, чтобы получить новый код.</p>}
            <button className="public-button secondary" style={{ marginTop: 12 }} disabled={request.busy || cooldown > 0 || expired} onClick={() => { setResent(false); void request.run(signal => resendVerification(pending.id, signal), data => {
                ++challengeGeneration.current; const next = { ...pending, resendAt: Date.now() + data.resend_after_ms, expiresAt: Date.now() + data.expires_in_ms }; setPending(next); savePending(next); setCode(''); setResent(true);
            }); }}>{cooldown > 0 ? `Отправить повторно через ${cooldown} сек.` : 'Отправить код ещё раз'}</button>
            {resent && <p className="public-note" role="status">Запрос принят. Проверьте почту.</p>}
            <button className="public-back" disabled={request.busy} onClick={restart}>{expired ? 'Получить новый код' : 'Указать другую почту'}</button>
            <p className="public-note">Письмо не приходит? Проверьте адрес и папку «Спам». Если вы уже регистрировались, <a className="public-link" href="/login">войдите</a> или <a className="public-link" href="/forgot-password">восстановите пароль</a>.</p>
        </>}
        {step === 1 && <button className="public-back" disabled={request.busy} onClick={() => { request.clear(); setValidation(''); setStep(0); }}><ArrowLeft size={16} aria-hidden="true" /> Назад</button>}
        <p className="public-note">Уже есть аккаунт? <a className="public-link" href="/login">Войти</a></p>
    </PublicShell>;
}
export function PasswordRecovery() { return <Availability kind="recovery"><RecoveryForm /></Availability>; }
function RecoveryForm() {
    const [email, setEmail] = useState(''), [complete, setComplete] = useState(false); const request = useRequest();
    const heading = useRef<HTMLHeadingElement>(null);
    useEffect(() => { if (complete) heading.current?.focus(); }, [complete]);
    if (complete) return <PublicShell><div className="public-success-icon"><Mail size={24} aria-hidden="true" /></div><h1 ref={heading} tabIndex={-1}>Проверьте почту</h1><p className="public-description">Если для этой почты есть аккаунт AVA, на неё придёт письмо с инструкцией по смене пароля. Проверьте также папку «Спам».</p><p className="public-description">После смены пароля вернитесь в AVA и войдите с новым паролем.</p><a className="public-button" href="/login">Вернуться ко входу</a><button className="public-back" onClick={() => { request.clear(); setComplete(false); }}>Указать другую почту</button></PublicShell>;
    return <PublicShell><a className="public-back" href="/login"><ArrowLeft size={16} aria-hidden="true" /> Ко входу</a><h1>Забыли пароль?</h1><p className="public-description">Укажите почту вашего аккаунта. Мы поможем восстановить доступ.</p><form aria-busy={request.busy} onSubmit={event => { event.preventDefault(); void request.run(signal => recoverPassword(email.trim(), signal), () => setComplete(true)); }}>
        <div className="public-field"><label htmlFor="recovery-email">Электронная почта</label><input id="recovery-email" type="email" autoComplete="email" required maxLength={254} value={email} disabled={request.busy} onChange={e => setEmail(e.target.value)} /></div><Feedback error={request.error} /><Submit busy={request.busy} disabled={request.wait > 0}>{request.busy ? 'Подождите…' : 'Восстановить доступ'}</Submit>{request.wait > 0 && <p className="public-note" role="status">Повторить можно через {request.wait} сек.</p>}
    </form></PublicShell>;
}
