const { EventEmitter } = require('node:events');
const { describe, it, assert } = require('./test-helper');
const DB = require('../src/services/database.service');
const Email = require('../src/services/email.service');
const ChannelRouter = require('../src/services/channel-router.service');

const instance = {
    id: 99931, isActive: true,
    emailSmtpHost: 'smtp.example.org', emailSmtpPort: 587,
    emailSmtpUser: 'user@example.org', emailSmtpPass: 'smtp-secret',
    emailImapHost: 'imap.example.org', emailImapPort: 993,
    emailImapUser: 'user@example.org', emailImapPass: 'imap-secret'
};

async function withFakes(Imap, run, { smtpFails = false } = {}) {
    const old = {
        getInstance: DB.getInstance, lookup: Email._lookup,
        nodemailer: Email._nodemailer, Imap: Email._Imap, parser: Email._simpleParser,
        timeout: Email._imapVerifyTimeoutMs
    };
    const smtp = { verifies: 0, sends: 0 };
    DB.getInstance = async () => ({ ...instance });
    Email._lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    Email._nodemailer = { createTransport: () => ({
        verify: async () => { smtp.verifies++; if (smtpFails) throw new Error('invalid credentials'); },
        sendMail: async () => { smtp.sends++; },
        close() {}
    }) };
    Email._Imap = Imap;
    Email._simpleParser = async () => {};
    Email._imapVerifyTimeoutMs = 25;
    try { await run(smtp); } finally {
        Email.stopInstance(instance.id);
        DB.getInstance = old.getInstance;
        Email._lookup = old.lookup;
        Email._nodemailer = old.nodemailer;
        Email._Imap = old.Imap;
        Email._simpleParser = old.parser;
        Email._imapVerifyTimeoutMs = old.timeout;
    }
}

describe('Email verification distinguishes SMTP, IMAP login and polling', () => {
    it('verifies IMAP login without opening or reading a mailbox', async () => {
        const connections = [];
        class ReadyImap extends EventEmitter {
            constructor(options) { super(); this.options = options; connections.push(this); }
            connect() { queueMicrotask(() => this.emit('ready')); }
            end() { this.ended = true; }
            destroy() { this.destroyed = true; }
            openBox() { throw new Error('verification must not open INBOX'); }
            search() { throw new Error('verification must not search'); }
            fetch() { throw new Error('verification must not fetch'); }
        }
        await withFakes(ReadyImap, async (smtp) => {
            const result = await Email.restartInstance(instance.id);
            assert.deepStrictEqual(result, {
                success: true, smtpVerified: true, imapConfigured: true,
                imapVerified: true, imapMailboxVerified: false, imapPolling: true
            });
            assert.strictEqual(smtp.verifies, 1);
            assert.strictEqual(smtp.sends, 0);
            assert.strictEqual(connections.length, 1);
            assert.strictEqual(connections[0].options.host, '8.8.8.8');
            assert.strictEqual(connections[0].options.tlsOptions.servername, 'imap.example.org');
            assert.strictEqual(connections[0].options.tlsOptions.rejectUnauthorized, true);
            assert.strictEqual(connections[0].ended, true);
            const status = await ChannelRouter.getChannelStatus(String(instance.id));
            assert.strictEqual(status.emailSmtpVerified, true);
            assert.strictEqual(status.emailImapVerified, true);
            assert.strictEqual(status.emailImapMailboxVerified, false);
            assert.strictEqual(status.emailImapPolling, true);
            assert.strictEqual(status.emailReceiving, false);
            assert.strictEqual(status.email, false);
        });
    });

    it('reports rejected IMAP login separately while leaving the polling schedule intact', async () => {
        class RejectedImap extends EventEmitter {
            connect() { queueMicrotask(() => this.emit('error', new Error('secret from provider'))); }
            destroy() {}
        }
        await withFakes(RejectedImap, async () => {
            const result = await Email.restartInstance(instance.id);
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.smtpVerified, true);
            assert.strictEqual(result.imapConfigured, true);
            assert.strictEqual(result.imapVerified, false);
            assert.strictEqual(result.imapPolling, true);
            const status = await ChannelRouter.getChannelStatus(String(instance.id));
            assert.strictEqual(status.emailSmtpVerified, true);
            assert.strictEqual(status.emailImapConfigured, true);
            assert.strictEqual(status.emailImapVerified, false);
            assert.strictEqual(status.emailImapMailboxVerified, false);
            assert.strictEqual(status.emailImapPolling, true);
            assert.strictEqual(status.emailReceiving, false);
            assert.strictEqual(status.email, false);
            assert.ok(!JSON.stringify(result).includes('secret'));
        });
    });

    it('times out a stalled IMAP connection and does not claim verification', async () => {
        let destroyed = false;
        class StalledImap extends EventEmitter {
            connect() {}
            destroy() { destroyed = true; }
        }
        await withFakes(StalledImap, async () => {
            const result = await Email.restartInstance(instance.id);
            assert.strictEqual(result.imapVerified, false);
            assert.strictEqual(result.imapPolling, true);
            assert.strictEqual(destroyed, true);
        });
    });

    it('checks IMAP independently when SMTP verification fails', async () => {
        class ReadyImap extends EventEmitter {
            connect() { queueMicrotask(() => this.emit('ready')); }
            end() {}
        }
        await withFakes(ReadyImap, async () => {
            const result = await Email.restartInstance(instance.id);
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.smtpVerified, false);
            assert.strictEqual(result.imapVerified, true);
            assert.strictEqual(result.imapPolling, true);
            const status = await ChannelRouter.getChannelStatus(String(instance.id));
            assert.strictEqual(status.emailSmtpVerified, false);
            assert.strictEqual(status.emailReceiving, false);
            assert.strictEqual(status.email, false);
        }, { smtpFails: true });
    });

    it('keeps receiving false when login succeeds but INBOX cannot be opened', async () => {
        class UnreadableInbox extends EventEmitter {
            connect() { queueMicrotask(() => this.emit('ready')); }
            openBox(_name, _readOnly, callback) { callback(new Error('INBOX access denied')); }
            end() { this.emit('end'); }
        }
        await withFakes(UnreadableInbox, async () => {
            await Email.restartInstance(instance.id);
            await Email._checkImap(instance);
            const status = await ChannelRouter.getChannelStatus(String(instance.id));
            assert.strictEqual(status.emailImapVerified, true);
            assert.strictEqual(status.emailImapMailboxVerified, false);
            assert.strictEqual(status.emailImapPolling, true);
            assert.strictEqual(status.emailReceiving, false);
            assert.strictEqual(status.email, false);
        });
    });

    it('keeps receiving false when INBOX opens but unread search fails', async () => {
        class UnsearchableInbox extends EventEmitter {
            connect() { queueMicrotask(() => this.emit('ready')); }
            openBox(_name, _readOnly, callback) { callback(null, {}); }
            search(_query, callback) { callback(new Error('search denied')); }
            end() { this.emit('end'); }
        }
        await withFakes(UnsearchableInbox, async () => {
            await Email.restartInstance(instance.id);
            await Email._checkImap(instance);
            const status = await ChannelRouter.getChannelStatus(String(instance.id));
            assert.strictEqual(status.emailImapVerified, true);
            assert.strictEqual(status.emailImapMailboxVerified, false);
            assert.strictEqual(status.emailReceiving, false);
            assert.strictEqual(status.email, false);
        });
    });

    it('reports receiving only after INBOX opens and an empty unread search succeeds', async () => {
        class ReadableInbox extends EventEmitter {
            connect() { queueMicrotask(() => this.emit('ready')); }
            openBox(_name, _readOnly, callback) { callback(null, {}); }
            search(_query, callback) { callback(null, []); }
            end() { this.emit('end'); }
        }
        await withFakes(ReadableInbox, async () => {
            await Email.restartInstance(instance.id);
            await Email._checkImap(instance);
            const status = await ChannelRouter.getChannelStatus(String(instance.id));
            assert.strictEqual(status.emailImapVerified, true);
            assert.strictEqual(status.emailImapMailboxVerified, true);
            assert.strictEqual(status.emailReceiving, true);
            assert.strictEqual(status.email, true);
        });
    });
});
