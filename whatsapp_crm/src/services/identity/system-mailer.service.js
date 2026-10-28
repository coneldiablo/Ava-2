'use strict';

const nodemailer = require('nodemailer');
const Logger = require('../../utils/logger');
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

class SystemMailerService {
    constructor() {
        this._transporter = null;
    }

    _getTransporter() {
        if (this._transporter) return this._transporter;

        const host = String(process.env.SYSTEM_SMTP_HOST || 'mail.hosting.reg.ru').trim();
        const port = Number(process.env.SYSTEM_SMTP_PORT || 465);
        const user = String(process.env.SYSTEM_SMTP_USER || '').trim();
        const pass = String(process.env.SYSTEM_SMTP_PASS || '').trim();
        const secure = port === 465 || String(process.env.SYSTEM_SMTP_SECURE || 'true').toLowerCase() === 'true';

        if (!host || !user || !pass) {
            throw Object.assign(new Error('Verification SMTP is not configured'),
                { code: 'IDENTITY_ENROLLMENT_UNAVAILABLE', statusCode: 503 });
        }

        this._transporter = nodemailer.createTransport({
            host,
            port,
            secure,
            auth: { user, pass },
            connectionTimeout: 6000,
            greetingTimeout: 6000,
            socketTimeout: 8000,
            tls: {
                rejectUnauthorized: true,
                servername: host,
            },
        });

        return this._transporter;
    }

    classifySmtpFailure(error) {
        if (error.code === 'SMTP_NOT_CONFIGURED') return { state: 'failed', errorCode: 'SMTP_NOT_CONFIGURED' };
        if (error.code === 'EAUTH') return { state: 'failed', errorCode: 'SMTP_AUTH_FAILED' };
        if (error.command === 'DATA' && !error.responseCode) return { state: 'unknown', errorCode: 'SMTP_OUTCOME_UNKNOWN' };
        if (error.code === 'EENVELOPE') return { state: 'failed', errorCode: 'SMTP_RECIPIENT_REJECTED' };
        if (error.code === 'EMESSAGE' || error.responseCode >= 400) return { state: 'failed', errorCode: 'SMTP_MESSAGE_REJECTED' };
        if (['ETLS','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID'].includes(error.code)) return { state: 'failed', errorCode: 'SMTP_TLS_FAILED' };
        if (['ECONNREFUSED','EDNS','ENOTFOUND','EAI_AGAIN'].includes(error.code)
            || (error.code === 'ETIMEDOUT' && ['EHLO','HELO','STARTTLS','AUTH','MAIL FROM','RCPT TO'].includes(error.command))) return { state: 'failed', errorCode: 'SMTP_CONNECTION_FAILED' };
        return { state: 'unknown', errorCode: 'SMTP_OUTCOME_UNKNOWN' };
    }

    async sendTeamInvitationEmail({ to, displayName, inviteUrl, role }) {
        const cleanTo = String(to || '').trim().toLowerCase();
        const url = new URL(inviteUrl);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanTo) || cleanTo.length > 254
            || url.origin !== require('./public-url').getPublicUrl().origin || url.pathname !== '/invite'
            || !/^#[\w-]{43}$/.test(url.hash) || !['manager','sales_lead','observer'].includes(role)) {
            throw Object.assign(new Error('Invalid invitation message'), { code: 'EMESSAGE' });
        }
        let transporter;
        try { transporter = this._getTransporter(); }
        catch (_) { throw Object.assign(new Error('SMTP not configured'), { code: 'SMTP_NOT_CONFIGURED' }); }
        const name = String(displayName || 'коллега').trim();
        const roleName = { manager: 'Менеджер', sales_lead: 'Руководитель продаж', observer: 'Наблюдатель' }[role];
        const fromAddress = String(process.env.SYSTEM_SMTP_FROM || process.env.SYSTEM_SMTP_USER || '').trim();
        const info = await transporter.sendMail({
            from: fromAddress, to: cleanTo,
            subject: 'Приглашение в команду AVA',
            text: `Здравствуйте, ${name}. Вас пригласили в команду AVA. Роль: ${roleName}.\nОткройте приглашение: ${url.href}\nСсылка действует 24 часа. Если у вас есть аккаунт AVA, войдите с почтой приглашения. Для нового аккаунта подтвердите почту кодом.`,
            html: `<p>Здравствуйте, ${escapeHtml(name)}.</p><p>Вас пригласили в команду AVA. Роль: ${roleName}.</p><p><a href="${escapeHtml(url.href)}">Принять приглашение</a></p><p>Ссылка действует 24 часа. Войдите с почтой приглашения или подтвердите почту кодом при создании аккаунта.</p>`,
        });
        if (!Array.isArray(info?.accepted) || !info.accepted.some(address => String(address).toLowerCase() === cleanTo)
            || info.rejected?.some(address => String(address).toLowerCase() === cleanTo)) {
            throw Object.assign(new Error('SMTP did not accept recipient'), { code: 'EENVELOPE' });
        }
        return { state: 'smtp_accepted' };
    }

    async sendVerificationCodeEmail({ to, code, displayName }) {
        const cleanTo = String(to || '').trim().toLowerCase();
        const cleanCode = String(code || '').trim();
        const cleanName = String(displayName || 'Владелец бизнеса').trim();
        const htmlName = escapeHtml(cleanName);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanTo) || cleanTo.length > 254 || !/^\d{6}$/.test(cleanCode)) {
            throw Object.assign(new Error('Invalid verification message'), { code: 'IDENTITY_ENROLLMENT_UNAVAILABLE', statusCode: 503 });
        }
        const fromAddress = String(process.env.SYSTEM_SMTP_FROM || process.env.SYSTEM_SMTP_USER || 'noreply@meludtech.tech').trim();

        const transporter = this._getTransporter();

        const html = `
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Код подтверждения AVA</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f7f7f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1c1c1e;">
    <table border="0" cellpadding="0" cellspacing="0" width="100%" style="table-layout: fixed;">
        <tr>
            <td align="center" style="padding: 40px 16px;">
                <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 520px; background-color: #ffffff; border-radius: 20px; border: 1px solid #e5e5ea; overflow: hidden; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.04);">
                    <tr>
                        <td style="padding: 36px 36px 20px; text-align: left;">
                            <div style="display: inline-block; width: 40px; height: 40px; background-color: #111111; border-radius: 10px; text-align: center; line-height: 40px; color: #f2f2f2; font-weight: bold; font-size: 20px; margin-bottom: 24px;">A</div>
                            <h1 style="margin: 0 0 12px; font-size: 22px; font-weight: 700; color: #111111; letter-spacing: -0.02em;">Подтверждение регистрации</h1>
                            <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.5; color: #636366;">Здравствуйте, ${htmlName}. Введите этот код на странице регистрации AVA для подтверждения рабочей почты:</p>
                            
                            <div style="background-color: #f2f2f7; border-radius: 14px; padding: 20px; text-align: center; margin: 0 0 24px; border: 1px solid #e5e5ea;">
                                <span style="font-family: 'SF Mono', Monaco, Menlo, Consolas, monospace; font-size: 34px; font-weight: 700; letter-spacing: 8px; color: #111111; display: inline-block; padding-left: 8px;">${cleanCode}</span>
                            </div>

                            <p style="margin: 0 0 12px; font-size: 13px; line-height: 1.5; color: #8e8e93;">Код действует 15 минут и может быть использован только один раз.</p>
                            <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #8e8e93;">Если вы не регистрировались в AVA, просто проигнорируйте это письмо.</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 20px 36px 32px; border-top: 1px solid #f2f2f7; background-color: #fafafa; text-align: left;">
                            <p style="margin: 0; font-size: 12px; line-height: 1.4; color: #aeaeb2;">AVA — Платформа голосовых ассистентов и CRM для бизнеса.<br>&copy; 2026 AVA Platform. Все права защищены.</p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
        `.trim();

        const text = `Здравствуйте, ${cleanName}.\n\nВаш код подтверждения для завершения регистрации в AVA:\n\n${cleanCode}\n\nКод действует 15 минут.\nЕсли вы не запрашивали доступ в AVA, проигнорируйте это сообщение.`;

        try {
            await transporter.sendMail({
                from: fromAddress,
                to: cleanTo,
                subject: `Код подтверждения AVA: ${cleanCode}`,
                text,
                html,
            });
            Logger.info('[SystemMailer] SMTP accepted verification message');
            return { success: true };
        } catch (error) {
            Logger.error('[SystemMailer] Verification SMTP send failed');
            throw Object.assign(new Error('Verification SMTP send failed'),
                { code: 'IDENTITY_ENROLLMENT_UNAVAILABLE', statusCode: 503 });
        }
    }
}

module.exports = new SystemMailerService();
