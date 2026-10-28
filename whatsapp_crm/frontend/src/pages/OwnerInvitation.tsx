import { FormEvent, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronLeft, Loader2, ShieldCheck } from 'lucide-react';
import AvaMark from '../components/AvaMark';
import './OnboardingGuide.css';

type Phase = 'checking' | 'welcome' | 'register' | 'verify_code' | 'complete' | 'invalid' | 'unknown';
const pendingKey = 'ava:owner-enrollment-pending';
const resumeKey = 'ava:owner-guide-resume';
const tokenKey = 'ava:owner-invite-token';
const verificationKey = 'ava:owner-verification-id';
const verificationEmailKey = 'ava:owner-verification-email';
const verificationAddressKey = 'ava:owner-verification-address';
const enrolledUserKey = 'ava:owner-enrolled-user-id';
function readSession(key: string) {
    try { return sessionStorage.getItem(key) || ''; } catch { return ''; }
}
function writeSession(key: string, value: string) {
    try { sessionStorage.setItem(key, value); } catch { /* Storage is optional. */ }
}
function clearVerification() {
    try { [verificationKey, verificationEmailKey, verificationAddressKey].forEach(key => sessionStorage.removeItem(key)); }
    catch { /* Storage is optional. */ }
}
function clearInvitation() {
    try { sessionStorage.removeItem(tokenKey); } catch { /* Storage is optional. */ }
    clearVerification();
}
function initialToken() {
    const hashToken = window.location.hash.slice(1);
    if (hashToken) {
        clearVerification();
        markEnrollmentPending(false);
        try { sessionStorage.removeItem(enrolledUserKey); } catch { /* Storage is optional. */ }
        try { sessionStorage.removeItem(resumeKey); } catch { /* Storage is optional. */ }
        writeSession(tokenKey, hashToken);
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        return hashToken;
    }
    return readSession(tokenKey);
}
function enrollmentPending() {
    try { return sessionStorage.getItem(pendingKey) === '1'; } catch { return false; }
}
function enrollmentCompleted() {
    try { return sessionStorage.getItem(resumeKey) === '1'; } catch { return false; }
}
function markEnrollmentPending(pending: boolean) {
    try { if (pending) sessionStorage.setItem(pendingKey, '1'); else sessionStorage.removeItem(pendingKey); } catch { /* Storage is optional. */ }
}

export default function OwnerInvitation() {
    const [token, setToken] = useState(initialToken);
    const [validationEpoch, setValidationEpoch] = useState(0);
    const [phase, setPhase] = useState<Phase>('checking');
    const [error, setError] = useState('');
    const [errorCode, setErrorCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [email, setEmail] = useState(() => readSession(verificationAddressKey));
    const [displayName, setDisplayName] = useState('');
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [verificationId, setVerificationId] = useState(() => readSession(verificationKey));
    const [code, setCode] = useState('');
    const [maskedEmail, setMaskedEmail] = useState(() => readSession(verificationEmailKey));
    const [enrolledUserId, setEnrolledUserId] = useState(() => readSession(enrolledUserKey));
    const [resendCooldown, setResendCooldown] = useState(0);
    const activeRequest = useRef<AbortController | null>(null);
    const cardTitle = useRef<HTMLHeadingElement | null>(null);

    useEffect(() => { if (phase !== 'checking') cardTitle.current?.focus(); }, [phase]);
    useEffect(() => {
        if (!busy) return;
        const warnBeforeLeaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
        window.addEventListener('beforeunload', warnBeforeLeaving);
        return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
    }, [busy]);

    useEffect(() => {
        if (resendCooldown <= 0) return;
        const timer = setInterval(() => setResendCooldown(t => Math.max(0, t - 1)), 1000);
        return () => clearInterval(timer);
    }, [resendCooldown]);

    useEffect(() => {
        const capture = () => {
            const next = window.location.hash.slice(1);
            if (!next) return;
            activeRequest.current?.abort();
            clearVerification();
            writeSession(tokenKey, next);
            setToken(next);
            setValidationEpoch(epoch => epoch + 1);
            setPhase('checking');
            setError('');
            setErrorCode('');
            setEmail(''); setDisplayName(''); setMaskedEmail('');
            setPassword(''); setConfirmation(''); setCode(''); setVerificationId('');
            markEnrollmentPending(false);
            try { sessionStorage.removeItem(enrolledUserKey); } catch { /* Storage is optional. */ }
            setEnrolledUserId('');
            try { sessionStorage.removeItem(resumeKey); } catch { /* Storage is optional. */ }
            window.history.replaceState(null, '', window.location.pathname + window.location.search);
        };
        window.addEventListener('hashchange', capture);
        window.addEventListener('popstate', capture);
        return () => { window.removeEventListener('hashchange', capture); window.removeEventListener('popstate', capture); activeRequest.current?.abort(); };
    }, []);

    useEffect(() => {
        if (!token) {
            setPhase(current => current === 'complete' || enrollmentCompleted() ? 'complete' : enrollmentPending() ? 'unknown' : 'invalid');
            return;
        }
        if (enrollmentPending()) { setPhase('unknown'); return; }
        if (readSession(verificationKey) && readSession(verificationEmailKey)) { setPhase('verify_code'); return; }
        const controller = new AbortController();
        activeRequest.current = controller;
        setPhase('checking');
        fetch('/api/owner-invitations/verify', { method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), signal: controller.signal })
            .then(async response => {
                const data = await response.json().catch(() => null);
                if (controller.signal.aborted) return;
                if (!response.ok || data?.valid !== true) {
                    if (data?.valid === false || data?.error_code === 'INVITATION_INVALID') clearInvitation();
                    throw new Error('Ссылка не действует. Попросите владельца AVA прислать актуальную ссылку.');
                }
                if (!controller.signal.aborted) setPhase('welcome');
            })
            .catch(() => { if (!controller.signal.aborted) { setPhase('invalid'); setError('Не удалось проверить ссылку. Откройте её ещё раз или обратитесь к администратору AVA.'); } });
        return () => { controller.abort(); if (activeRequest.current === controller) activeRequest.current = null; };
    }, [token, validationEpoch]);

    const messages: Record<string, string> = {
        ACCOUNT_ALREADY_EXISTS: 'Этот адрес уже используется в AVA. Войдите в существующий аккаунт или укажите другой адрес.',
        INVITATION_INVALID: 'Ссылка больше не действует. Попросите новую ссылку у администратора AVA.',
        INVITATION_IN_PROGRESS: 'Этот доступ уже создаётся. Подождите немного и попробуйте войти.',
        IDENTITY_RATE_LIMITED: 'Слишком много попыток. Повторите через минуту.',
        IDENTITY_ENROLLMENT_UNAVAILABLE: 'Регистрация временно недоступна. Повторите позже или обратитесь в поддержку AVA.',
        INVALID_VERIFICATION_CODE: 'Неверный код подтверждения. Проверьте цифры из письма.',
        VERIFICATION_CODE_EXPIRED: 'Срок действия кода истёк. Нажмите «Отправить код ещё раз».',
        MAX_ATTEMPTS_EXCEEDED: 'Превышено количество попыток. Запросите новый код.',
        RESEND_COOLDOWN: 'Повторная отправка возможна через 60 секунд.',
        EMAIL_INVALID: 'Проверьте правильность написания адреса почты.',
    };

    async function register(event: FormEvent) {
        event.preventDefault();
        if (busy) return;
        if (password.length < 12 || password !== confirmation) {
            setError('Пароль должен содержать не менее 12 символов. Проверьте, что пароли совпадают.');
            return;
        }
        setBusy(true); setError(''); setErrorCode('');
        const controller = new AbortController();
        activeRequest.current = controller;
        try {
            const response = await fetch('/api/owner-invitations/request-verification', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({ token, email: email.trim(), displayName: displayName.trim(), password }),
            });
            const data = await response.json().catch(() => null);
            if (controller.signal.aborted) return;
            if (!response.ok || data?.success !== true) {
                if (data?.error_code === 'INVITATION_INVALID') { clearInvitation(); setPhase('invalid'); }
                setErrorCode(data?.error_code || '');
                throw new Error(messages[data?.error_code] || 'Не удалось отправить код подтверждения. Проверьте данные и повторите попытку.');
            }
            setVerificationId(data.verification_id);
            setMaskedEmail(data.masked_email || email.trim());
            writeSession(verificationKey, data.verification_id);
            writeSession(verificationEmailKey, data.masked_email || email.trim());
            writeSession(verificationAddressKey, email.trim());
            setResendCooldown(60);
            setCode('');
            setPhase('verify_code');
        } catch (failure) {
            if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Не удалось подключиться к AVA.');
        } finally { if (activeRequest.current === controller) { activeRequest.current = null; setBusy(false); } }
    }

    async function resendCode() {
        if (busy || resendCooldown > 0) return;
        setBusy(true); setError(''); setErrorCode('');
        const controller = new AbortController();
        activeRequest.current = controller;
        try {
            const response = await fetch('/api/owner-invitations/resend-code', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({ token, verificationId, email: email.trim() }),
            });
            const data = await response.json().catch(() => null);
            if (controller.signal.aborted) return;
            if (!response.ok || data?.success !== true) {
                if (data?.error_code === 'INVITATION_INVALID') { clearInvitation(); setPhase('invalid'); }
                setErrorCode(data?.error_code || '');
                throw new Error(messages[data?.error_code] || 'Не удалось отправить код повторно.');
            }
            setResendCooldown(60);
            setCode('');
        } catch (failure) {
            if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Не удалось отправить код.');
        } finally { if (activeRequest.current === controller) { activeRequest.current = null; setBusy(false); } }
    }

    async function confirmCode(event: FormEvent) {
        event.preventDefault();
        if (busy) return;
        if (!/^\d{6}$/.test(code.trim())) {
            setError('Введите 6-значный код из письма.');
            return;
        }
        setBusy(true); setError(''); setErrorCode('');
        markEnrollmentPending(true);
        const controller = new AbortController();
        activeRequest.current = controller;
        try {
            const response = await fetch('/api/owner-invitations/redeem', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({ token, verificationId, code: code.trim() }),
            });
            const data = await response.json().catch(() => null);
            if (controller.signal.aborted) return;
            if (!response.ok || data?.success !== true) {
                if (!response.ok) markEnrollmentPending(false);
                if (data?.error_code === 'INVITATION_INVALID') { clearInvitation(); setPhase('invalid'); }
                setErrorCode(data?.error_code || '');
                throw new Error(messages[data?.error_code] || 'Не удалось активировать доступ. Проверьте код и повторите попытку.');
            }
            markEnrollmentPending(false);
            clearInvitation();
            setEnrolledUserId(data.user_id || '');
            if (data.user_id) writeSession(enrolledUserKey, data.user_id);
            try { sessionStorage.setItem(resumeKey, '1'); } catch { /* Storage is optional. */ }
            setToken(''); setVerificationId(''); setMaskedEmail(''); setEmail('');
            setPassword(''); setConfirmation(''); setCode(''); setPhase('complete');
        } catch (failure) {
            if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Не удалось подтвердить код.');
        } finally { if (activeRequest.current === controller) { activeRequest.current = null; setBusy(false); } }
    }

    const position = phase === 'complete' ? 3 : phase === 'verify_code' ? 2 : phase === 'register' ? 2 : 1;
    return <main className="ava-onboarding ava-onboarding-public">
        <div className="ava-onboarding-wrap">
            <header className="ava-onboarding-brand"><span className="ava-onboarding-mark"><AvaMark size={24} /></span><span>AVA <small>Ваш бизнес начинается здесь</small></span></header>
            <div className="ava-onboarding-public-grid">
                <section className="ava-onboarding-intro" aria-labelledby="owner-invite-title">
                    <p className="ava-onboarding-kicker">Личное пространство для вашего бизнеса</p>
                    <h1 id="owner-invite-title">Добро пожаловать <em>в AVA</em></h1>
                    <p>За несколько коротких шагов создадим доступ и ваш бизнес, настроим голос и знания, подключим каналы связи и проверим первый сценарий.</p>
                    <ol className="ava-onboarding-preview" aria-label="Что будет дальше">
                        <li><span>01</span> Создайте доступ и бизнес</li>
                        <li><span>02</span> Расскажите AVA, как отвечать клиентам</li>
                        <li><span>03</span> Добавьте знания и подключите каналы</li>
                        <li><span>04</span> Проверьте работу перед запуском</li>
                    </ol>
                    <p className="ava-onboarding-side-note"><ShieldCheck size={18} aria-hidden="true" /> Настройку можно продолжить позже из меню AVA.</p>
                </section>
                <section className="ava-onboarding-card" aria-labelledby="owner-card-title">
                    <div className="ava-onboarding-card-top"><span>Начало работы</span><strong>{position} / 3</strong></div>
                    <div className="ava-onboarding-meter" role="progressbar" aria-label="Шаг регистрации" aria-valuenow={position} aria-valuemin={1} aria-valuemax={3}><span style={{ width: `${position / 3 * 100}%` }} /></div>
                    {phase === 'checking' && <div className="ava-onboarding-state" role="status"><Loader2 className="ava-onboarding-spin" size={24} /><h2 id="owner-card-title">Проверяем приглашение</h2><p>Это займёт несколько секунд.</p></div>}
                    {phase === 'invalid' && <div className="ava-onboarding-state" role="alert"><h2 id="owner-card-title" ref={cardTitle} tabIndex={-1}>Приглашение не открыто</h2><p>{error || 'В адресе нет приглашения. Откройте исходную ссылку ещё раз. Если вы уже нажали «Создать доступ», сначала попробуйте войти.'}</p><a className="ava-onboarding-existing" href="/api/auth/sso/start">Попробовать войти <ArrowRight size={16} /></a></div>}
                    {phase === 'unknown' && <div className="ava-onboarding-state" role="status"><h2 id="owner-card-title" ref={cardTitle} tabIndex={-1}>Проверим доступ</h2><p>Страница обновилась во время регистрации. Доступ мог быть создан. Сначала попробуйте войти; если вход не удаётся, откройте исходную ссылку приглашения ещё раз.</p><a className="ava-onboarding-primary" href="/api/auth/sso/start">Попробовать войти <ArrowRight size={16} /></a></div>}
                    {phase === 'welcome' && <div className="ava-onboarding-state"><span className="ava-onboarding-success"><Check size={24} /></span><h2 id="owner-card-title" ref={cardTitle} tabIndex={-1}>Ссылка готова</h2><p>Создайте личный доступ. После входа AVA поможет создать бизнес и покажет следующие шаги прямо в рабочем пространстве.</p><button type="button" className="ava-onboarding-primary" onClick={() => setPhase('register')}>Начать настройку <ArrowRight size={18} /></button></div>}
                    {phase === 'register' && <form onSubmit={register} className="ava-onboarding-form" aria-busy={busy}>
                        <div><p className="ava-onboarding-kicker">Шаг 1 · Создайте доступ</p><h2 id="owner-card-title" ref={cardTitle} tabIndex={-1}>Давайте знакомиться</h2><p>После входа вы создадите свой бизнес и пройдёте настройку в AVA.</p></div>
                        <label>Ваше имя<input required maxLength={120} autoComplete="name" value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="Как к вам обращаться" /></label>
                        <label>Рабочая почта<input required type="email" maxLength={254} autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="name@company.ru" /></label>
                        <label>Пароль<input required type="password" minLength={12} maxLength={256} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /><small>Не менее 12 символов</small></label>
                        <label>Повторите пароль<input required type="password" minLength={12} maxLength={256} autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
                        {error && <p className="ava-onboarding-error" role="alert">{error}</p>}
                        {errorCode === 'ACCOUNT_ALREADY_EXISTS' && <a className="ava-onboarding-existing" href="/api/auth/sso/start">Войти в существующий аккаунт <ArrowRight size={16} /></a>}
                        <div className="ava-onboarding-form-actions"><button type="button" className="ava-onboarding-back" onClick={() => { setError(''); setPhase('welcome'); }}><ChevronLeft size={17} /> Назад</button><button type="submit" disabled={busy} className="ava-onboarding-primary">{busy ? <><Loader2 className="ava-onboarding-spin" size={17} /> Отправляем код…</> : <>Продолжить <ArrowRight size={17} /></>}</button></div>
                    </form>}
                    {phase === 'verify_code' && <form onSubmit={confirmCode} className="ava-onboarding-form" aria-busy={busy}>
                        <div><p className="ava-onboarding-kicker">Шаг 2 · Подтвердите почту</p><h2 id="owner-card-title" ref={cardTitle} tabIndex={-1}>Код подтверждения</h2><p>Мы отправили 6-значный код на <strong>{maskedEmail}</strong>. Проверьте входящие и папку «Спам».</p></div>
                        <label>Код из письма<input required type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" style={{ fontSize: '24px', letterSpacing: '6px', textAlign: 'center', fontWeight: 'bold' }} autoFocus /><small>6 цифр из письма</small></label>
                        {error && <p className="ava-onboarding-error" role="alert">{error}</p>}
                        <div className="ava-onboarding-form-actions">
                            <button type="button" className="ava-onboarding-back" onClick={() => { setError(''); setErrorCode(''); setPhase('register'); }}><ChevronLeft size={17} /> Изменить данные</button>
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                <button type="button" className="ava-onboarding-back" disabled={busy || resendCooldown > 0} onClick={resendCode}>{resendCooldown > 0 ? `Повторить (${resendCooldown}с)` : 'Отправить ещё раз'}</button>
                                <button type="submit" disabled={busy || code.length !== 6} className="ava-onboarding-primary">{busy ? <><Loader2 className="ava-onboarding-spin" size={17} /> Активируем…</> : <>Создать доступ <ArrowRight size={17} /></>}</button>
                            </div>
                        </div>
                    </form>}
                    {phase === 'complete' && <div className="ava-onboarding-state" role="status"><span className="ava-onboarding-success"><Check size={24} /></span><h2 id="owner-card-title" ref={cardTitle} tabIndex={-1}>Доступ создан</h2><p>Почта подтверждена. Теперь войдите в AVA под новым аккаунтом. Мини-гайд поможет создать бизнес и настроить его.</p>{enrolledUserId ? <a className="ava-onboarding-primary" href={`/api/auth/sso/start?enrolled_user=${encodeURIComponent(enrolledUserId)}`}>Войти и продолжить <ArrowRight size={18} /></a> : <p>Обновите страницу приглашения или обратитесь в поддержку AVA, чтобы подтвердить созданный доступ.</p>}</div>}
                </section>
            </div>
        </div>
    </main>;
}
