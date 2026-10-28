'use strict';

const nodemailer = require('nodemailer');
const { describe, it, assert } = require('./test-helper');
const Mailer = require('../src/services/identity/system-mailer.service');

describe('Owner verification SMTP boundary', () => {
    for (const from of ['noreply@example.test', '"AVA Security" <noreply@example.test>']) {
        it(`preserves a valid SMTP envelope for invitations and codes with sender ${from}`, async () => {
            const keys = ['SYSTEM_SMTP_FROM', 'WHATSAPP_CRM_PUBLIC_URL'];
            const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
            const previousTransport = Mailer._transporter;
            const stream = nodemailer.createTransport({ streamTransport: true, buffer: true });
            const envelopes = [];
            try {
                process.env.SYSTEM_SMTP_FROM = from;
                process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
                Mailer._transporter = { sendMail: async message => {
                    const info = await stream.sendMail(message);
                    envelopes.push(info.envelope);
                    return { ...info, accepted: [message.to], rejected: [] };
                } };
                await Mailer.sendTeamInvitationEmail({ to: 'colleague@example.test', role: 'manager',
                    inviteUrl: `https://ava.example.test/invite#${'a'.repeat(43)}` });
                await Mailer.sendVerificationCodeEmail({ to: 'colleague@example.test', code: '123456' });
                assert.strictEqual(envelopes.length, 2);
                for (const envelope of envelopes) {
                    assert.strictEqual(envelope.from, 'noreply@example.test');
                    assert.deepStrictEqual(envelope.to, ['colleague@example.test']);
                }
            } finally {
                stream.close();
                Mailer._transporter = previousTransport;
                for (const key of keys) {
                    if (previous[key] === undefined) delete process.env[key];
                    else process.env[key] = previous[key];
                }
            }
        });
    }

    it('fails closed when SMTP credentials are absent', async () => {
        const user = process.env.SYSTEM_SMTP_USER;
        const pass = process.env.SYSTEM_SMTP_PASS;
        const transporter = Mailer._transporter;
        try {
            delete process.env.SYSTEM_SMTP_USER;
            delete process.env.SYSTEM_SMTP_PASS;
            Mailer._transporter = null;
            await assert.rejects(Mailer.sendVerificationCodeEmail({
                to: 'owner@example.test', code: '123456', displayName: 'Owner',
            }), { code: 'IDENTITY_ENROLLMENT_UNAVAILABLE', statusCode: 503 });
        } finally {
            if (user === undefined) delete process.env.SYSTEM_SMTP_USER;
            else process.env.SYSTEM_SMTP_USER = user;
            if (pass === undefined) delete process.env.SYSTEM_SMTP_PASS;
            else process.env.SYSTEM_SMTP_PASS = pass;
            Mailer._transporter = transporter;
        }
    });

    it('bounds SMTP phases and returns a fixed failure without leaking a code', async () => {
        const user = process.env.SYSTEM_SMTP_USER;
        const pass = process.env.SYSTEM_SMTP_PASS;
        const originalCreate = nodemailer.createTransport;
        const transporter = Mailer._transporter;
        let options;
        try {
            process.env.SYSTEM_SMTP_USER = 'fixture@example.test';
            process.env.SYSTEM_SMTP_PASS = 'fixture-only';
            Mailer._transporter = null;
            nodemailer.createTransport = config => {
                options = config;
                return { sendMail: async () => { throw new Error('SMTP rejected code 123456'); } };
            };
            await assert.rejects(Mailer.sendVerificationCodeEmail({
                to: 'owner@example.test', code: '123456', displayName: 'Owner',
            }), error => error.code === 'IDENTITY_ENROLLMENT_UNAVAILABLE'
                && !error.message.includes('123456'));
            assert.strictEqual(options.connectionTimeout, 6000);
            assert.strictEqual(options.greetingTimeout, 6000);
            assert.strictEqual(options.socketTimeout, 8000);
        } finally {
            nodemailer.createTransport = originalCreate;
            Mailer._transporter = transporter;
            if (user === undefined) delete process.env.SYSTEM_SMTP_USER;
            else process.env.SYSTEM_SMTP_USER = user;
            if (pass === undefined) delete process.env.SYSTEM_SMTP_PASS;
            else process.env.SYSTEM_SMTP_PASS = pass;
        }
    });
});
