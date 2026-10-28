const { EventEmitter } = require('node:events');
const { describe, it, assert } = require('./test-helper');
const Email = require('../src/services/email.service');

describe('Customer-configurable email network boundaries', () => {
    it('rejects private, loopback, link-local, mapped and documentation addresses', async () => {
        const oldLookup = Email._lookup;
        try {
            for (const address of [
                '127.0.0.1', '10.2.3.4', '169.254.169.254', '172.18.0.2',
                '192.168.1.1', '100.100.100.200', '192.0.2.1', '198.18.0.1',
                '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2002:c0a8:0101::',
                '2001:db8::1', '2001::1'
            ]) {
                const host = address.includes(':') ? 'mail.example.org' : address;
                Email._lookup = async () => [{ address, family: address.includes(':') ? 6 : 4 }];
                await assert.rejects(() => Email._resolvePublicAddress(host), /публичные IP-адреса/);
            }
            await assert.rejects(() => Email._resolvePublicAddress('https://user:pass@mail.example.org'), /Недопустимое/);
            await assert.rejects(() => Email._resolvePublicAddress('mail.example.org@127.0.0.1'), /Недопустимое/);
        } finally { Email._lookup = oldLookup; }
    });

    it('rejects a hostname with mixed public/private DNS answers', async () => {
        const oldLookup = Email._lookup;
        try {
            Email._lookup = async () => [
                { address: '8.8.8.8', family: 4 },
                { address: 'fd00::1', family: 6 }
            ];
            await assert.rejects(() => Email._resolvePublicAddress('mail.example.org'), /публичные IP-адреса/);
        } finally { Email._lookup = oldLookup; }
    });

    it('pins SMTP to a validated address and keeps the original hostname for TLS', async () => {
        const oldLookup = Email._lookup;
        const oldMailer = Email._nodemailer;
        let config;
        try {
            Email._lookup = async () => [{ address: '8.8.8.8', family: 4 }];
            Email._nodemailer = { createTransport: options => {
                config = options;
                return { close() {} };
            } };
            const instance = { id: 99901, emailSmtpHost: 'mail.example.org', emailSmtpPort: '587',
                emailSmtpUser: 'user', emailSmtpPass: 'secret' };
            assert.ok(await Email._setupSmtp(instance));
            assert.strictEqual(config.host, '8.8.8.8');
            assert.strictEqual(config.tls.servername, 'mail.example.org');
            assert.strictEqual(config.tls.rejectUnauthorized, true);
            instance.emailSmtpPort = '6379';
            assert.strictEqual(await Email._setupSmtp(instance), null);
            assert.strictEqual(Email._transporters.has(instance.id), false);
        } finally {
            Email.stopInstance(99901);
            Email._lookup = oldLookup;
            Email._nodemailer = oldMailer;
        }
    });

    it('pins IMAP per connection and rejects unsafe resolutions before opening a socket', async () => {
        const oldLookup = Email._lookup;
        const oldImap = Email._Imap;
        const oldParser = Email._simpleParser;
        const seen = [];
        class FakeImap extends EventEmitter {
            constructor(options) { super(); seen.push(options); }
            connect() { queueMicrotask(() => this.emit('end')); }
        }
        try {
            Email._Imap = FakeImap;
            Email._simpleParser = () => {};
            Email._lookup = async () => [{ address: '8.8.4.4', family: 4 }];
            const instance = { id: 99902, emailImapHost: 'imap.example.org', emailImapPort: 993,
                emailImapUser: 'user', emailImapPass: 'secret' };
            await Email._checkImap(instance);
            assert.strictEqual(seen[0].host, '8.8.4.4');
            assert.strictEqual(seen[0].tlsOptions.servername, 'imap.example.org');
            assert.strictEqual(seen[0].tlsOptions.rejectUnauthorized, true);
            Email._lookup = async () => [{ address: '127.0.0.1', family: 4 }];
            await Email._checkImap(instance);
            assert.strictEqual(seen.length, 1);
            instance.emailImapPort = 143;
            assert.strictEqual(await Email._startImapPolling(instance), false);
            assert.strictEqual(Email.isImapActive(instance.id), false);
        } finally {
            Email.stopInstance(99902);
            Email._lookup = oldLookup;
            Email._Imap = oldImap;
            Email._simpleParser = oldParser;
        }
    });
});
