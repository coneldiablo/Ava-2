/** Public enrollment requests deliberately bypass the authenticated CRM client. */
export interface PublicIdentityConfig {
    registrationEnabled: boolean;
    recoveryEnabled: boolean;
    ssoEnabled: boolean;
    minPasswordLength: number;
    maxPasswordLength: number;
}

interface PublicIdentityConfigResponse {
    success: true;
    sso_enabled: boolean;
    registration_enabled: boolean;
    recovery_enabled: boolean;
    minPasswordLength: number;
    maxPasswordLength: number;
    verification_method: 'email_code';
    invitation_required?: boolean;
}

export interface RegistrationInput {
    email: string;
    displayName: string;
    businessName: string;
    password: string;
}

export interface PublicIdentitySuccess {
    success: true;
}

export interface VerifiedRegistration extends PublicIdentitySuccess {
    status: 'completed';
    user_id: string;
    business_id: number;
    login_url: string;
}

export interface ExistingRegistration extends PublicIdentitySuccess {
    status: 'existing_account';
    next_action: 'sign_in_or_recover';
    login_url: '/api/auth/sso/start';
    recovery_url: '/forgot-password';
}
export interface RegistrationStatus extends PublicIdentitySuccess {
    login_url?: string;
    status: 'verification_requested' | 'processing' | 'completed' | 'existing_account' | 'expired' | 'locked' | 'delivery_failed';
    masked_email: string;
    expires_in_ms: number;
    resend_after_ms: number;
}
export interface RegistrationResent extends PublicIdentitySuccess {
    status: 'verification_requested';
    resend_after_ms: number;
    expires_in_ms: number;
}

export interface RegistrationStarted extends RegistrationResent {
    verification_id: string;
    masked_email: string;
}

export interface RegistrationVerificationInput {
    verification_id: string;
    code: string;
    password?: string;
}

export interface PublicLoginConfig {
    sso_enabled: boolean;
}

const REQUEST_TIMEOUT_MS = 20_000;
const API_ROOT = '/api/public/identity';
const MESSAGES: Record<string, string> = {
    INVALID_EMAIL: 'Проверьте адрес электронной почты.',
    EMAIL_INVALID: 'Проверьте адрес электронной почты.',
    IDENTITY_EMAIL_INVALID: 'Проверьте адрес электронной почты.',
    INVALID_PASSWORD: 'Выберите более надёжный пароль.',
    IDENTITY_PASSWORD_INVALID: 'Выберите более надёжный пароль.',
    WEAK_PASSWORD: 'Выберите более надёжный пароль.',
    PASSWORD_POLICY: 'Пароль должен содержать от 12 до 256 символов и не совпадать с почтой или именем пользователя.',
    INVALID_INPUT: 'Проверьте заполненные поля.',
    VALIDATION_ERROR: 'Проверьте заполненные поля.',
    REGISTRATION_INPUT_INVALID: 'Проверьте заполненные поля.',
    REGISTRATION_PROOF_INVALID: 'Подтверждение устарело. Начните регистрацию заново.',
    ACCOUNT_ALREADY_EXISTS: 'Продолжить регистрацию не удалось. Попробуйте войти или восстановить пароль.',
    REGISTRATION_IN_PROGRESS: 'Создание бизнеса ещё выполняется. Подождите немного и повторите.',
    REGISTRATION_RETRY_PENDING: 'Создание бизнеса ещё выполняется. Подождите немного и повторите.',
    REGISTRATION_UNAVAILABLE: 'Создание бизнеса сейчас недоступно. Попробуйте позже.',
    REGISTRATION_EMAIL_UNAVAILABLE: 'Не удалось отправить код. Попробуйте позже.',
    REGISTRATION_DISABLED: 'Создание бизнеса сейчас недоступно. Попробуйте позже.',
    IDENTITY_REGISTRATION_DISABLED: 'Создание бизнеса сейчас недоступно. Попробуйте позже.',
    RECOVERY_DISABLED: 'Восстановление пароля сейчас недоступно. Попробуйте позже.',
    IDENTITY_RECOVERY_DISABLED: 'Восстановление пароля сейчас недоступно. Попробуйте позже.',
    INVALID_TOKEN: 'Ссылка недействительна. Запросите новое письмо.',
    TOKEN_EXPIRED: 'Срок действия ссылки истёк. Запросите новое письмо.',
    IDENTITY_TOKEN_INVALID: 'Ссылка недействительна. Запросите новое письмо.',
    IDENTITY_TOKEN_EXPIRED: 'Срок действия ссылки истёк. Запросите новое письмо.',
    INVALID_CODE: 'Код не подошёл. Проверьте письмо и попробуйте ещё раз.',
    CODE_EXPIRED: 'Срок действия кода истёк. Запросите новый код.',
    VERIFICATION_INVALID: 'Код не подошёл. Проверьте письмо и попробуйте ещё раз.',
    VERIFICATION_EXPIRED: 'Срок действия кода истёк. Запросите новый код.',
    INVALID_VERIFICATION_CODE: 'Код не подошёл. Проверьте письмо и попробуйте ещё раз.',
    VERIFICATION_CODE_EXPIRED: 'Срок действия кода истёк. Запросите новый код.',
    MAX_ATTEMPTS_EXCEEDED: 'Слишком много неверных попыток. Запросите новый код.',
    RESEND_COOLDOWN: 'Подождите немного перед повторной отправкой кода.',
    VERIFICATION_NOT_FOUND: 'Подтверждение завершено или устарело. Начните регистрацию заново.',
    VERIFICATION_REQUIRED: 'Введите код подтверждения из письма.',
    RATE_LIMITED: 'Слишком много попыток. Подождите и повторите.',
    IDENTITY_RATE_LIMITED: 'Слишком много попыток. Подождите и повторите.',
    IDENTITY_ORIGIN_REQUIRED: 'Обновите страницу и попробуйте ещё раз.',
    NETWORK_ERROR: 'Не удалось связаться с AVA. Проверьте подключение и попробуйте снова.',
    REQUEST_TIMEOUT: 'Ответ занимает больше времени, чем обычно. Попробуйте снова.',
    REQUEST_CANCELLED: 'Запрос отменён.',
    INVALID_RESPONSE: 'Не удалось получить ответ от AVA. Попробуйте позже.',
    SERVICE_UNAVAILABLE: 'AVA временно недоступна. Попробуйте позже.',
};

export class PublicIdentityError extends Error {
    readonly code: string;
    readonly status?: number;
    /** Seconds until the server permits another attempt. */
    readonly retryAfter?: number;

    constructor(code: string, status?: number, retryAfter?: number) {
        super(MESSAGES[code] || MESSAGES.SERVICE_UNAVAILABLE);
        this.name = 'PublicIdentityError';
        this.code = code;
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function retryDelay(response: Response, payload: unknown): number | undefined {
    const header = response.headers.get('retry-after');
    if (header !== null) {
        if (/^\d+$/.test(header.trim())) {
            const seconds = Number(header.trim());
            if (Number.isFinite(seconds)) return seconds;
        }
        const date = Date.parse(header);
        if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
    }
    const delay = isRecord(payload) ? (payload.retry_after_seconds ?? payload.retryAfterSeconds ?? payload.retryAfter) : undefined;
    return typeof delay === 'number' && Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : undefined;
}

function failure(response: Response, payload: unknown): PublicIdentityError {
    const candidate = isRecord(payload) ? (payload.error_code ?? payload.code ?? payload.error) : undefined;
    // Never display upstream messages, email/account existence, HTML or provider details.
    const code = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(candidate)
        ? candidate : response.status === 429 ? 'RATE_LIMITED' : 'SERVICE_UNAVAILABLE';
    return new PublicIdentityError(code, response.status, retryDelay(response, payload));
}

async function request<T>(path: string, body: unknown | undefined, validate: (value: unknown) => value is T, signal?: AbortSignal, root = API_ROOT): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    if (signal?.aborted) throw new PublicIdentityError('REQUEST_CANCELLED');
    signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(`${root}${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            redirect: 'error',
            headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: controller.signal,
        });
        const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
        let payload: unknown;
        if (contentType === 'application/json' || /^application\/[\w.+-]+\+json$/.test(contentType)) {
            try { payload = await response.json(); }
            catch {
                if (controller.signal.aborted) throw new PublicIdentityError(timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_CANCELLED');
                if (!response.ok) throw failure(response, undefined);
                throw new PublicIdentityError('INVALID_RESPONSE', response.status);
            }
        }
        if (!response.ok) throw failure(response, payload);
        if (body === undefined && response.status !== 200) throw new PublicIdentityError('INVALID_RESPONSE', response.status);
        if (!validate(payload)) throw new PublicIdentityError('INVALID_RESPONSE', response.status);
        return payload;
    } catch (error) {
        if (error instanceof PublicIdentityError) throw error;
        if (controller.signal.aborted) throw new PublicIdentityError(timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_CANCELLED');
        throw new PublicIdentityError('NETWORK_ERROR');
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
    }
}

const validConfig = (value: unknown): value is PublicIdentityConfigResponse => isRecord(value)
    && value.success === true && typeof value.registration_enabled === 'boolean' && typeof value.recovery_enabled === 'boolean'
    && typeof value.sso_enabled === 'boolean' && value.minPasswordLength === 12 && value.maxPasswordLength === 256
    && value.verification_method === 'email_code'
    && (value.registration_enabled ? value.invitation_required === false : value.invitation_required === undefined || typeof value.invitation_required === 'boolean');
const validSuccess = (value: unknown): value is PublicIdentitySuccess => isRecord(value) && value.success === true;
const validLoginConfig = (value: unknown): value is PublicLoginConfig => isRecord(value)
    && value.success !== false && typeof value.sso_enabled === 'boolean';
function validVerifiedRegistration(value: unknown): value is VerifiedRegistration | ExistingRegistration {
    if (isRecord(value) && value.success === true && value.status === 'existing_account') return value.next_action === 'sign_in_or_recover'
        && value.login_url === '/api/auth/sso/start' && value.recovery_url === '/forgot-password';
    if (!validSuccess(value) || !isRecord(value) || value.status !== 'completed'
        || typeof value.user_id !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value.user_id)
        || !Number.isSafeInteger(value.business_id) || Number(value.business_id) <= 0
        || typeof value.login_url !== 'string' || !value.login_url.startsWith('/api/auth/sso/start?')) return false;
    const url = new URL(value.login_url, 'https://ava.invalid');
    return url.origin === 'https://ava.invalid' && url.pathname === '/api/auth/sso/start'
        && url.hash === '' && [...url.searchParams].length === 1
        && url.searchParams.get('enrolled_user') === value.user_id;
}

function validResent(value: unknown): value is RegistrationResent {
    return validSuccess(value) && isRecord(value) && value.status === 'verification_requested'
        && Number.isSafeInteger(value.resend_after_ms) && Number(value.resend_after_ms) >= 0
        && Number.isSafeInteger(value.expires_in_ms) && Number(value.expires_in_ms) > 0;
}
function validStarted(value: unknown): value is RegistrationStarted {
    return validResent(value) && isRecord(value)
        && typeof value.verification_id === 'string' && /^[a-z\d_-]{43}$/i.test(value.verification_id)
        && typeof value.masked_email === 'string' && value.masked_email.length > 0 && value.masked_email.length <= 254
        && value.masked_email.includes('@');
}

export const getPublicIdentityConfig = async (signal?: AbortSignal): Promise<PublicIdentityConfig> => {
    const response = await request('/config', undefined, validConfig, signal);
    return {
        registrationEnabled: response.registration_enabled, recoveryEnabled: response.recovery_enabled,
        ssoEnabled: response.sso_enabled, minPasswordLength: response.minPasswordLength, maxPasswordLength: response.maxPasswordLength,
    };
};
export const getLoginConfig = (signal?: AbortSignal) => request('/config', undefined, validLoginConfig, signal, '/api/auth');
export const startRegistration = (input: RegistrationInput, signal?: AbortSignal) => request('/registration/start', input, validStarted, signal);
export const verifyRegistration = (input: RegistrationVerificationInput, signal?: AbortSignal) => request('/registration/verify', input, validVerifiedRegistration, signal);
export const resendVerification = (verificationId: string, signal?: AbortSignal) => request('/registration/resend', { verification_id: verificationId }, validResent, signal);
export const recoverPassword = (email: string, signal?: AbortSignal) => request('/password/recovery', { email }, validSuccess, signal);

export const getRegistrationStatus = (verificationId: string, signal?: AbortSignal) => request('/registration/status', { verification_id: verificationId }, (value: unknown): value is RegistrationStatus => isRecord(value)
    && value.success === true && ['verification_requested', 'processing', 'completed', 'existing_account', 'expired', 'locked', 'delivery_failed'].includes(String(value.status))
    && typeof value.masked_email === 'string' && value.masked_email.includes('@')
    && Number.isFinite(value.expires_in_ms) && Number(value.expires_in_ms) >= 0
    && Number.isFinite(value.resend_after_ms) && Number(value.resend_after_ms) >= 0
    && (value.status !== 'completed' || typeof value.login_url === 'string' && /^\/api\/auth\/sso\/start\?enrolled_user=[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value.login_url)), signal);
