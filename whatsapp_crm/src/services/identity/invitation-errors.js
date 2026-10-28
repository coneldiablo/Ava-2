'use strict';

// Only fixed application messages cross the public enrollment boundary.
// Never forward upstream response bodies, credentials or exception messages.
const errors = Object.freeze({
    INVITATION_INVALID: [400, 'Приглашение недействительно, уже использовано или отменено. Откройте последнюю выданную ссылку.'],
    INVITATION_AUTHENTICATION_REQUIRED: [401, 'Войдите в учётную запись, на которую выдано приглашение.'],
    INVITATION_ACCOUNT_MISMATCH: [403, 'Приглашение выдано другой учётной записи. Войдите с указанным в приглашении email.'],
    INVITATION_EXISTING_ACCOUNT_REQUIRED: [409, 'Учётная запись уже существует. Войдите в неё и примите приглашение без смены пароля.'],
    ACCOUNT_ALREADY_MEMBER: [409, 'Эта учётная запись уже состоит в команде бизнеса.'],
    ACCOUNT_NOT_ACTIVE: [403, 'Учётная запись недоступна. Обратитесь к администратору AVA.'],
    PASSWORD_POLICY: [400, 'Пароль должен содержать от 12 до 256 символов.'],
    ACCOUNT_ALREADY_EXISTS: [409, 'Учётная запись с этим email уже существует. Войдите в неё или обратитесь в поддержку AVA.'],
    TEAM_ENROLLMENT_RECONCILIATION_REQUIRED: [409, 'Создание доступа прервано. Нужна проверка администратором AVA перед повторным приглашением.'],
    INVITATION_IN_PROGRESS: [409, 'Активация уже выполняется. Подождите минуту и повторите попытку.'],
    PREVIOUS_ACCESS_REVOCATION_PENDING: [409, 'Завершается отзыв предыдущего доступа. Повторите активацию через минуту.'],
    INVITATION_LEASE_LOST: [409, 'Состояние приглашения изменилось. Откройте последнюю ссылку или запросите новую.'],
    IDENTITY_ORIGIN_REQUIRED: [403, 'Откройте приглашение на wh.meludtech.tech в новой вкладке и повторите активацию.'],
    BUSINESS_NOT_FOUND: [409, 'Бизнес недоступен. Обратитесь к администратору AVA.'],
    IDENTITY_RATE_LIMITED: [429, 'Слишком много попыток. Повторите через минуту.'],
    IDENTITY_ENROLLMENT_UNAVAILABLE: [503, 'Сервис активации временно недоступен. Повторите позже или передайте код ошибки поддержке AVA.'],
    EMAIL_INVALID: [400, 'Некорректный адрес электронной почты.'],
    INVALID_VERIFICATION_CODE: [400, 'Неверный код подтверждения. Проверьте код из письма и повторите попытку.'],
    VERIFICATION_CODE_EXPIRED: [400, 'Срок действия кода подтверждения истёк. Запросите новый код.'],
    MAX_ATTEMPTS_EXCEEDED: [429, 'Превышено количество попыток ввода кода. Запросите новый код.'],
    RESEND_COOLDOWN: [429, 'Повторная отправка кода возможна через 60 секунд.'],
    VERIFICATION_NOT_FOUND: [404, 'Сессия подтверждения не найдена или уже завершена. Начните регистрацию сначала.'],
    VERIFICATION_REQUIRED: [400, 'Подтвердите адрес электронной почты кодом из письма.'],
});

function invitationFailure(error, requestId) {
    const candidate = error?.response?.data?.error || error?.code;
    const code = typeof candidate === 'string' && Object.hasOwn(errors, candidate) ? candidate : 'IDENTITY_ENROLLMENT_UNAVAILABLE';
    const [status, message] = errors[code];
    const body = { success: false, error: message, error_code: code, request_id: requestId };
    if (error?.attemptsLeft !== undefined) body.attempts_remaining = error.attemptsLeft;
    if (error?.waitSeconds !== undefined) body.retry_after_seconds = error.waitSeconds;
    return { status, body };
}

module.exports = { invitationFailure };
