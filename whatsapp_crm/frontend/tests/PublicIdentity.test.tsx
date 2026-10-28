// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import PublicWelcome from '../src/pages/public/PublicWelcome';
import Login from '../src/pages/Login';
import { PasswordRecovery, Registration } from '../src/pages/public/PublicForms';
import { PublicIdentityError } from '../src/publicIdentityApi';

const api = vi.hoisted(() => ({
    getPublicIdentityConfig: vi.fn(), getLoginConfig: vi.fn(), startRegistration: vi.fn(),
    verifyRegistration: vi.fn(), getRegistrationStatus: vi.fn(), resendVerification: vi.fn(), recoverPassword: vi.fn(), login: vi.fn(),
}));
vi.mock('../src/publicIdentityApi', async importOriginal => ({
    ...await importOriginal<typeof import('../src/publicIdentityApi')>(), ...api,
}));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ login: api.login }) }));

const storageKey = 'ava:public-registration';
const proof = 'v'.repeat(43);
const password = 'a-long-unique-password';
const userId = '11111111-1111-4111-8111-111111111111';
const loginUrl = `/api/auth/sso/start?enrolled_user=${userId}`;
const started = {
    success: true, status: 'verification_requested', verification_id: proof,
    masked_email: 'o***@example.ru', resend_after_ms: 60_000, expires_in_ms: 900_000,
};
const completed = { success: true, status: 'completed', user_id: userId, business_id: 42, login_url: loginUrl };
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function registrationCredentials() {
    fireEvent.change(await screen.findByLabelText('Как вас зовут'), { target: { value: 'Мария' } });
    fireEvent.change(screen.getByLabelText('Название бизнеса'), { target: { value: 'Кофейня' } });
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }));
    fireEvent.change(screen.getByLabelText('Электронная почта'), { target: { value: 'owner@example.ru' } });
    fireEvent.change(screen.getByLabelText('Пароль', { exact: true }), { target: { value: password } });
    fireEvent.change(screen.getByLabelText('Повторите пароль'), { target: { value: password } });
}
function restoreProof(overrides: Record<string, unknown> = {}) {
    sessionStorage.setItem(storageKey, JSON.stringify({
        id: proof, email: started.masked_email, resendAt: Date.now() + 60_000,
        expiresAt: Date.now() + 900_000, ...overrides,
    }));
}

beforeEach(() => {
    vi.resetAllMocks();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    api.getPublicIdentityConfig.mockResolvedValue({ registrationEnabled: true, recoveryEnabled: true });
    api.getLoginConfig.mockResolvedValue({ sso_enabled: true });
    api.getRegistrationStatus.mockRejectedValue(new Error('Status offline'));
    api.startRegistration.mockResolvedValue(started);
    api.verifyRegistration.mockResolvedValue(completed);
    api.resendVerification.mockResolvedValue({ success: true, status: 'verification_requested', resend_after_ms: 60_000, expires_in_ms: 800_000 });
    api.recoverPassword.mockResolvedValue({ success: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('public entry and login', () => {
    it('offers a deliberate choice without starting SSO or requesting config', () => {
        render(<PublicWelcome />);
        expect(screen.getAllByRole('link', { name: /^Войти/ }).some(link => link.getAttribute('href') === '/login')).toBe(true);
        expect(screen.getByRole('link', { name: /Создать бизнес/ }).getAttribute('href')).toBe('/register');
        expect(api.getLoginConfig).not.toHaveBeenCalled();
        expect(api.login).not.toHaveBeenCalled();
        expect(window.location.pathname).toBe('/');
    });

    it('does not expose manual fallback on config failure, then retries explicitly', async () => {
        window.history.replaceState(null, '', '/login?login=manual');
        api.getLoginConfig.mockRejectedValueOnce(new Error('offline'));
        render(<Login />);
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.queryByLabelText('Пароль')).toBeNull();
        expect(screen.queryByRole('link', { name: /Продолжить вход/ })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
        expect(await screen.findByRole('link', { name: /Продолжить вход/ })).toBeTruthy();
        expect(api.getLoginConfig).toHaveBeenCalledTimes(2);
    });

    it('offers SSO without auto-navigating or exposing a password form', async () => {
        render(<Login />);
        const link = await screen.findByRole('link', { name: /Продолжить вход/ });
        expect(link.getAttribute('href')).toBe('/api/auth/sso/start');
        expect(screen.queryByLabelText('Пароль')).toBeNull();
        expect(api.login).not.toHaveBeenCalled();
    });
});

describe('public registration', () => {
    it('keeps availability errors out of the form and allows retry', async () => {
        api.getPublicIdentityConfig.mockRejectedValueOnce(new Error('offline'));
        render(<Registration />);
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.queryByLabelText('Как вас зовут')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
        expect(await screen.findByLabelText('Как вас зовут')).toBeTruthy();
    });

    it('validates password confirmation before sending registration', async () => {
        render(<Registration />);
        await registrationCredentials();
        fireEvent.change(screen.getByLabelText('Повторите пароль'), { target: { value: 'different-password' } });
        fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
        expect(screen.getByRole('alert').textContent).toContain('Пароли не совпадают');
        expect(api.startRegistration).not.toHaveBeenCalled();
        expect(screen.getByLabelText('Повторите пароль').getAttribute('aria-invalid')).toBe('true');
    });

    it('does not enter confirmation or persist data after start failure; supports retry', async () => {
        api.startRegistration.mockRejectedValueOnce(new PublicIdentityError('NETWORK_ERROR'));
        render(<Registration />);
        await registrationCredentials();
        fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.queryByLabelText('Код из письма')).toBeNull();
        expect(sessionStorage.getItem(storageKey)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
        expect(await screen.findByLabelText('Код из письма')).toBeTruthy();
        expect(api.startRegistration).toHaveBeenCalledTimes(2);
    });

    it('stores only proof, masked email and timing metadata and restores confirmation after reload', async () => {
        const first = render(<Registration />);
        await registrationCredentials();
        fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
        await screen.findByLabelText('Код из письма');
        expect(api.startRegistration).toHaveBeenCalledWith({ displayName: 'Мария', businessName: 'Кофейня', email: 'owner@example.ru', password }, expect.any(AbortSignal));
        const saved = JSON.parse(sessionStorage.getItem(storageKey)!);
        expect(saved).toMatchObject({ id: proof, email: started.masked_email });
        expect(Object.keys(saved).sort()).toEqual(['email', 'expiresAt', 'id', 'resendAt']);
        fireEvent.change(screen.getByLabelText('Код из письма'), { target: { value: '123456' } });
        expect(sessionStorage.getItem(storageKey)).not.toContain('123456');
        expect(sessionStorage.getItem(storageKey)).not.toContain(password);
        expect(sessionStorage.getItem(storageKey)).not.toContain('owner@example.ru');
        first.unmount();
        render(<Registration />);
        const code = await screen.findByLabelText('Код из письма');
        expect((code as HTMLInputElement).value).toBe('');
        expect(screen.getByText(started.masked_email)).toBeTruthy();
        expect(api.startRegistration).toHaveBeenCalledTimes(1);
        expect(window.location.search + window.location.hash).toBe('');
    });

    it('preserves the same proof after final-contract resend and restarts its cooldown', async () => {
        restoreProof({ resendAt: Date.now() - 1 });
        render(<Registration />);
        await screen.findByLabelText('Код из письма');
        fireEvent.click(screen.getByRole('button', { name: 'Отправить код ещё раз' }));
        await screen.findByText('Запрос принят. Проверьте почту.');
        expect(api.resendVerification).toHaveBeenCalledWith(proof, expect.any(AbortSignal));
        expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toMatchObject({ id: proof, email: started.masked_email });
        expect((screen.getByRole('button', { name: /Отправить повторно через/ }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('enforces resend cooldown while still allowing the first verification attempt', async () => {
        restoreProof();
        render(<Registration />);
        await screen.findByLabelText('Код из письма');
        expect((screen.getByRole('button', { name: /Отправить повторно через/ }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: 'Подтвердить почту' }) as HTMLButtonElement).disabled).toBe(false);
        expect(api.resendVerification).not.toHaveBeenCalled();
    });

    it('expires the restored proof and requires starting again instead of sending it', async () => {
        restoreProof({ expiresAt: Date.now() - 1, resendAt: Date.now() - 1 });
        render(<Registration />);
        await screen.findByLabelText('Код из письма');
        expect(screen.getByRole('alert').textContent).toContain('Срок действия кода истёк');
        const verify = screen.getByRole('button', { name: 'Подтвердить почту' }) as HTMLButtonElement;
        const resend = screen.getByRole('button', { name: 'Отправить код ещё раз' }) as HTMLButtonElement;
        expect(verify.disabled).toBe(true);
        expect(resend.disabled).toBe(true);
        fireEvent.click(verify);
        fireEvent.click(resend);
        expect(api.verifyRegistration).not.toHaveBeenCalled();
        expect(api.resendVerification).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Получить новый код' }));
        expect(screen.getByLabelText('Как вас зовут')).toBeTruthy();
        expect(sessionStorage.getItem(storageKey)).toBeNull();
    });

    it('honors server retry delay for a verification error and unlocks when it elapses', async () => {
        restoreProof({ resendAt: Date.now() - 1 });
        api.verifyRegistration.mockRejectedValueOnce(new PublicIdentityError('IDENTITY_RATE_LIMITED', 429, 2));
        render(<Registration />);
        const code = await screen.findByLabelText('Код из письма');
        vi.useFakeTimers();
        fireEvent.change(code, { target: { value: '123456' } });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Подтвердить почту' })); });
        expect(screen.getByRole('alert').textContent).toContain('Слишком много попыток');
        expect((screen.getByRole('button', { name: 'Подтвердить почту' }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: /Отправить повторно через/ }) as HTMLButtonElement).disabled).toBe(true);
        await act(async () => { vi.advanceTimersByTime(2_100); });
        expect((screen.getByRole('button', { name: 'Подтвердить почту' }) as HTMLButtonElement).disabled).toBe(false);
        expect(api.verifyRegistration).toHaveBeenCalledTimes(1);
    });

    it('normalizes pasted OTP, shows confirmed completion only after verify and clears the proof', async () => {
        restoreProof();
        render(<Registration />);
        fireEvent.change(await screen.findByLabelText('Код из письма'), { target: { value: '12 34-56' } });
        expect((screen.getByLabelText('Код из письма') as HTMLInputElement).value).toBe('123456');
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить почту' }));
        expect(await screen.findByRole('heading', { name: 'Почта подтверждена' })).toBeTruthy();
        expect(api.verifyRegistration).toHaveBeenCalledWith({ verification_id: proof, code: '123456' }, expect.any(AbortSignal));
        expect(screen.getByRole('link', { name: /Перейти в AVA/ }).getAttribute('href')).toBe(loginUrl);
        expect(sessionStorage.getItem(storageKey)).toBeNull();
    });

    it('keeps confirmation and proof when verified response is rejected by the API validator', async () => {
        restoreProof();
        api.verifyRegistration.mockRejectedValueOnce(new PublicIdentityError('INVALID_RESPONSE'));
        render(<Registration />);
        fireEvent.change(await screen.findByLabelText('Код из письма'), { target: { value: '123456' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить почту' }));
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'Почта подтверждена' })).toBeNull();
        expect(screen.queryByRole('link', { name: /Перейти в AVA/ })).toBeNull();
        expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toMatchObject({ id: proof });
    });

    it('clears previous proof and OTP when changing the registration address', async () => {
        restoreProof();
        render(<Registration />);
        fireEvent.change(await screen.findByLabelText('Код из письма'), { target: { value: '123456' } });
        fireEvent.click(screen.getByRole('button', { name: 'Указать другую почту' }));
        expect(screen.getByLabelText('Как вас зовут')).toBeTruthy();
        expect(sessionStorage.getItem(storageKey)).toBeNull();
        expect(screen.queryByLabelText('Код из письма')).toBeNull();
    });

    it('aborts a deferred start on unmount and cannot overwrite a newer registration proof', async () => {
        const oldRequest = deferred<typeof started>();
        api.startRegistration.mockReturnValueOnce(oldRequest.promise);
        const first = render(<Registration />);
        await registrationCredentials();
        fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
        const signal = api.startRegistration.mock.calls[0][1] as AbortSignal;
        expect((screen.getByLabelText('Электронная почта') as HTMLInputElement).disabled).toBe(true);
        first.unmount();
        expect(signal.aborted).toBe(true);
        restoreProof({ id: 'n'.repeat(43), email: 'n***@example.ru' });
        await act(async () => { oldRequest.resolve(started); await oldRequest.promise; });
        expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toMatchObject({ id: 'n'.repeat(43), email: 'n***@example.ru' });
    });

    it('ignores deferred verification completion after unmount instead of clearing newer proof', async () => {
        const oldRequest = deferred<typeof completed>();
        api.verifyRegistration.mockReturnValueOnce(oldRequest.promise);
        restoreProof();
        const first = render(<Registration />);
        fireEvent.change(await screen.findByLabelText('Код из письма'), { target: { value: '123456' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить почту' }));
        const signal = api.verifyRegistration.mock.calls[0][1] as AbortSignal;
        first.unmount();
        restoreProof({ id: 'n'.repeat(43) });
        await act(async () => { oldRequest.resolve(completed); await oldRequest.promise; });
        expect(signal.aborted).toBe(true);
        expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toMatchObject({ id: 'n'.repeat(43) });
    });
});

describe('password recovery', () => {
    it('shows the same neutral accepted response for any email, only after successful API completion', async () => {
        const request = deferred<{ success: true }>();
        api.recoverPassword.mockReturnValueOnce(request.promise);
        render(<PasswordRecovery />);
        fireEvent.change(await screen.findByLabelText('Электронная почта'), { target: { value: 'unknown@example.ru' } });
        fireEvent.click(screen.getByRole('button', { name: 'Восстановить доступ' }));
        expect(screen.queryByRole('heading', { name: 'Проверьте почту' })).toBeNull();
        expect((screen.getByLabelText('Электронная почта') as HTMLInputElement).disabled).toBe(true);
        await act(async () => { request.resolve({ success: true }); await request.promise; });
        expect(screen.getByRole('heading', { name: 'Проверьте почту' })).toBeTruthy();
        expect(screen.getByText(/Если для этой почты есть аккаунт AVA/)).toBeTruthy();
        expect(screen.queryByText('unknown@example.ru')).toBeNull();
    });

    it('shows errors without a false accepted result and permits a deliberate retry', async () => {
        api.recoverPassword.mockRejectedValueOnce(new PublicIdentityError('NETWORK_ERROR'));
        render(<PasswordRecovery />);
        fireEvent.change(await screen.findByLabelText('Электронная почта'), { target: { value: 'owner@example.ru' } });
        fireEvent.click(screen.getByRole('button', { name: 'Восстановить доступ' }));
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'Проверьте почту' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Восстановить доступ' }));
        expect(await screen.findByRole('heading', { name: 'Проверьте почту' })).toBeTruthy();
        expect(api.recoverPassword).toHaveBeenCalledTimes(2);
    });

    it('ignores a deferred accepted response after navigating away', async () => {
        const request = deferred<{ success: true }>();
        api.recoverPassword.mockReturnValueOnce(request.promise);
        const first = render(<PasswordRecovery />);
        fireEvent.change(await screen.findByLabelText('Электронная почта'), { target: { value: 'owner@example.ru' } });
        fireEvent.click(screen.getByRole('button', { name: 'Восстановить доступ' }));
        const signal = api.recoverPassword.mock.calls[0][1] as AbortSignal;
        first.unmount();
        render(<PasswordRecovery />);
        await screen.findByLabelText('Электронная почта');
        await act(async () => { request.resolve({ success: true }); await request.promise; });
        expect(signal.aborted).toBe(true);
        expect(screen.queryByRole('heading', { name: 'Проверьте почту' })).toBeNull();
        expect((screen.getByLabelText('Электронная почта') as HTMLInputElement).value).toBe('');
    });
});

describe('registration password correction', () => {
    it('retries the same proof and code with a replacement password', async () => {
        restoreProof(); api.verifyRegistration.mockRejectedValueOnce(new PublicIdentityError('PASSWORD_POLICY', 400));
        render(<Registration />);
        fireEvent.change(await screen.findByLabelText('Код из письма'), { target: { value: '123456' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить почту' }));
        expect(await screen.findByLabelText('Новый пароль')).toBeTruthy();
        expect((screen.getByLabelText('Код из письма') as HTMLInputElement).value).toBe('123456');
        const replacement = 'another-long-password';
        fireEvent.change(screen.getByLabelText('Новый пароль'), { target: { value: replacement } });
        fireEvent.change(screen.getByLabelText('Повторите новый пароль'), { target: { value: replacement } });
        expect(sessionStorage.getItem(storageKey)).not.toContain(replacement);
        expect(sessionStorage.getItem(storageKey)).not.toContain('123456');
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить почту' }));
        expect(await screen.findByText('Почта подтверждена')).toBeTruthy();
        expect(api.verifyRegistration.mock.calls[1][0]).toEqual({verification_id:proof,code:'123456',password:replacement});
        expect(api.startRegistration).not.toHaveBeenCalled();
    });
    it('restores replacement fields after reload without passwords or codes', async () => {
        restoreProof({passwordCorrection:true}); render(<Registration />);
        expect(await screen.findByLabelText('Новый пароль')).toBeTruthy();
        expect((screen.getByLabelText('Новый пароль') as HTMLInputElement).value).toBe('');
        expect((screen.getByLabelText('Код из письма') as HTMLInputElement).value).toBe('');
    });
    it('retains replacement on retry-pending and respects Retry-After', async () => {
        restoreProof({passwordCorrection:true}); api.verifyRegistration.mockRejectedValueOnce(new PublicIdentityError('REGISTRATION_RETRY_PENDING',409,60));
        render(<Registration />);
        fireEvent.change(await screen.findByLabelText('Код из письма'), {target:{value:'123456'}});
        fireEvent.change(screen.getByLabelText('Новый пароль'), {target:{value:'replacement-password'}});
        fireEvent.change(screen.getByLabelText('Повторите новый пароль'), {target:{value:'replacement-password'}});
        fireEvent.click(screen.getByRole('button',{name:'Подтвердить почту'}));
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect((screen.getByLabelText('Новый пароль') as HTMLInputElement).value).toBe('replacement-password');
        expect((screen.getByRole('button',{name:'Подтвердить почту'}) as HTMLButtonElement).disabled).toBe(true);
        expect(sessionStorage.getItem(storageKey)).not.toContain('replacement-password');
        expect(api.startRegistration).not.toHaveBeenCalled();
    });
    it('rejects password equal to email before starting registration', async () => {
        render(<Registration />); await registrationCredentials();
        fireEvent.change(screen.getByLabelText('Пароль',{exact:true}), {target:{value:'owner@example.ru'}});
        fireEvent.change(screen.getByLabelText('Повторите пароль'), {target:{value:'owner@example.ru'}});
        fireEvent.click(screen.getByRole('button',{name:'Получить код'}));
        expect(screen.getByRole('alert').textContent).toContain('не должен совпадать');
        expect(api.startRegistration).not.toHaveBeenCalled();
    });
});

describe('recoverable registration journey', () => {
    it('preserves safe fields before the code step without persisting credentials', async () => {
        const view = render(<Registration />); await registrationCredentials(); view.unmount();
        render(<Registration />);
        expect(await screen.findByDisplayValue('owner@example.ru')).toBeTruthy();
        expect((screen.getByLabelText('Пароль', { exact: true }) as HTMLInputElement).value).toBe('');
        expect(sessionStorage.getItem('ava:public-registration-draft')).toContain('Кофейня');
        expect(JSON.stringify(sessionStorage)).not.toContain(password);
    });
    it('offers existing-account login and recovery only after OTP proof without binding a new account', async () => {
        restoreProof(); api.verifyRegistration.mockResolvedValueOnce({ success: true, status: 'existing_account', next_action: 'sign_in_or_recover', login_url: '/api/auth/sso/start', recovery_url: '/forgot-password' });
        render(<Registration />); fireEvent.change(await screen.findByLabelText('Код из письма'), { target: { value: '123456' } });
        fireEvent.click(screen.getByRole('button', { name: 'Подтвердить почту' }));
        expect(await screen.findByRole('heading', { name: 'У вас уже есть аккаунт' })).toBeTruthy();
        expect(screen.getByRole('link', { name: /Войти в AVA/ }).getAttribute('href')).toBe('/api/auth/sso/start');
        expect(screen.getByRole('link', { name: 'Восстановить пароль' }).getAttribute('href')).toBe('/forgot-password');
        expect(sessionStorage.getItem('ava:public-enrolled-account')).toBeNull();
        expect(sessionStorage.getItem(storageKey)).toBeNull();
    });
    it('reconciles a restored challenge against server timing and email', async () => {
        restoreProof({ expiresAt: Date.now() - 1 });
        api.getRegistrationStatus.mockResolvedValueOnce({ success: true, status: 'verification_requested', masked_email: 'n***@example.ru', expires_in_ms: 120000, resend_after_ms: 10000 });
        render(<Registration />); expect(await screen.findByText('n***@example.ru')).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Подтвердить почту' }) as HTMLButtonElement).disabled).toBe(false);
        expect(JSON.parse(sessionStorage.getItem(storageKey)!).id).toBe(proof);
    });
});
