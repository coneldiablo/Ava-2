const Logger = require('../utils/logger');
const DB = require('./database.service');
const dns = require('node:dns').promises;
const net = require('node:net');
const crypto = require('node:crypto');

const SMTP_PORTS = new Set([465, 587]);
const IMAP_PORTS = new Set([993]);
const globalIpv6 = new net.BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');
const excludedIpv6 = new net.BlockList();
excludedIpv6.addSubnet('2001::', 23, 'ipv6'); // IETF protocol assignments, including Teredo.
excludedIpv6.addSubnet('2001:db8::', 32, 'ipv6'); // Documentation addresses.
excludedIpv6.addSubnet('2002::', 16, 'ipv6'); // 6to4 embeds an arbitrary IPv4 destination.

function isPublicIp(address) {
    const family = net.isIP(address);
    if (family === 4) {
        const [a, b, c] = address.split('.').map(Number);
        return a > 0 && a < 224 && a !== 10 && a !== 127
            && !(a === 100 && b >= 64 && b <= 127)
            && !(a === 169 && b === 254)
            && !(a === 172 && b >= 16 && b <= 31)
            && !(a === 192 && b === 0 && c === 0)
            && !(a === 192 && b === 0 && c === 2)
            && !(a === 192 && b === 88 && c === 99)
            && !(a === 192 && b === 168)
            && !(a === 198 && (b === 18 || b === 19))
            && !(a === 198 && b === 51 && c === 100)
            && !(a === 203 && b === 0 && c === 113);
    }
    if (family === 6) {
        // Only ordinary global unicast is supported. This also rejects IPv4-mapped,
        // NAT64, ULA, loopback, link-local and multicast addresses.
        return globalIpv6.check(address, 'ipv6') && !excludedIpv6.check(address, 'ipv6');
    }
    return false;
}

function validatePort(value, fallback, allowed) {
    const port = value == null || value === '' ? fallback : Number(value);
    if (!Number.isInteger(port) || !allowed.has(port)) throw new Error('Недопустимый порт почтового сервера');
    return port;
}

class EmailService {
    constructor() {
        this._transporters = new Map(); // instanceId -> nodemailer transport
        this._verifiedSmtp = new Set();
        this._verifiedImap = new Set();
        this._verifiedImapMailbox = new Set();
        this._imapTimers = new Map();
        this._imapInitialTimers = new Map();
        this._nodemailer = null;
        this._Imap = null;
        this._simpleParser = null;
        this._lookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });
        this._imapVerifyTimeoutMs = 12000;
    }

    async _resolvePublicAddress(hostname) {
        if (typeof hostname !== 'string' || !hostname || hostname.length > 253
            || (!net.isIP(hostname) && (!/^[a-z\d.-]+$/i.test(hostname)
                || hostname.startsWith('.') || hostname.endsWith('.') || hostname.includes('..')))) {
            throw new Error('Недопустимое имя почтового сервера');
        }
        const answers = net.isIP(hostname)
            ? [{ address: hostname, family: net.isIP(hostname) }]
            : await this._lookup(hostname);
        if (!Array.isArray(answers) || !answers.length
            || answers.some(({ address }) => !isPublicIp(address))) {
            throw new Error('Почтовый сервер должен иметь только публичные IP-адреса');
        }
        // Use the vetted address as the actual socket destination. The original
        // hostname remains the TLS SNI/certificate name; no second DNS lookup occurs.
        return answers[0].address;
    }

    async start() {
        try {
            this._nodemailer = require('nodemailer');
            this._Imap = require('imap');
            const { simpleParser } = require('mailparser');
            this._simpleParser = simpleParser;
        } catch (e) {
            Logger.warn('[Email] Email dependencies not fully installed. Email integration disabled.');
            return;
        }

        const instances = await DB.getInstances();
        for (const instance of instances) {
            if (instance.emailSmtpHost && instance.emailSmtpUser && instance.isActive) {
                this.testSmtp(instance.id).catch(e => Logger.warn(`[Email] SMTP verification failed for instance ${instance.id}:`, e.message));
            }
            if (instance.emailImapHost && instance.emailImapUser && instance.emailImapPass && instance.isActive) {
                await this._startImapPolling(instance);
            }
        }
        Logger.info(`[Email] 📧 Email service initialized (${this._transporters.size} SMTP, ${this._imapTimers.size} IMAP)`);
    }

    async _setupSmtp(instance) {
        if (!this._nodemailer) return;
        try {
            this._verifiedSmtp.delete(instance.id);
            this._transporters.get(instance.id)?.close();
            this._transporters.delete(instance.id);
            const port = validatePort(instance.emailSmtpPort, 587, SMTP_PORTS);
            const address = await this._resolvePublicAddress(instance.emailSmtpHost);
            const transport = this._nodemailer.createTransport({
                host: address,
                port,
                secure: port === 465,
                connectionTimeout: 10000,
                greetingTimeout: 10000,
                socketTimeout: 15000,
                tls: {
                    ...(!net.isIP(instance.emailSmtpHost) && { servername: instance.emailSmtpHost }),
                    rejectUnauthorized: true
                },
                auth: {
                    user: instance.emailSmtpUser,
                    pass: instance.emailSmtpPass
                }
            });
            this._transporters.set(instance.id, transport);
            return transport;
        } catch (e) {
            Logger.warn(`[Email] SMTP setup rejected for instance ${instance.id}:`, e.message);
            return null;
        }
    }

    async _startImapPolling(instance) {
        if (!this._Imap) return false;
        this._verifiedImap.delete(Number(instance.id));
        this._verifiedImapMailbox.delete(Number(instance.id));
        const previous = this._imapTimers.get(instance.id);
        if (previous) clearInterval(previous);
        this._imapTimers.delete(instance.id);
        const initial = this._imapInitialTimers.get(instance.id);
        if (initial) clearTimeout(initial);
        this._imapInitialTimers.delete(instance.id);
        if (!instance.isActive || !instance.emailImapHost || !instance.emailImapUser || !instance.emailImapPass) return false;
        try {
            validatePort(instance.emailImapPort, 993, IMAP_PORTS);
            await this._resolvePublicAddress(instance.emailImapHost);
        } catch (e) {
            Logger.warn(`[Email] IMAP setup rejected for instance ${instance.id}:`, e.message);
            return false;
        }
        // Poll every 60 seconds
        const timer = setInterval(() => this._checkImap(instance), 60 * 1000);
        this._imapTimers.set(instance.id, timer);
        // First check after 20s
        this._imapInitialTimers.set(instance.id, setTimeout(() => {
            this._imapInitialTimers.delete(instance.id);
            this._checkImap(instance);
        }, 20000));
        return true;
    }

    async _checkImap(instance) {
        const id = Number(instance.id);
        this._verifiedImapMailbox.delete(id);
        if (!this._Imap || !this._simpleParser) return;

        let address;
        let port;
        try {
            port = validatePort(instance.emailImapPort, 993, IMAP_PORTS);
            address = await this._resolvePublicAddress(instance.emailImapHost);
        } catch (e) {
            Logger.warn(`[Email] IMAP setup rejected for instance ${instance.id}:`, e.message);
            this._verifiedImap.delete(Number(instance.id));
            this._verifiedImapMailbox.delete(id);
            return;
        }

        return new Promise((resolve) => {
            try {
                const imap = new this._Imap({
                    user: instance.emailImapUser,
                    password: instance.emailImapPass,
                    host: address,
                    port,
                    tls: true,
                    tlsOptions: {
                        ...(!net.isIP(instance.emailImapHost) && { servername: instance.emailImapHost }),
                        rejectUnauthorized: true
                    },
                    connTimeout: 10000,
                    authTimeout: 10000,
                });

                imap.once('ready', () => {
                    this._verifiedImap.add(Number(instance.id));
                    imap.openBox('INBOX', false, (err, box) => {
                        if (err) {
                            this._verifiedImapMailbox.delete(id);
                            imap.end();
                            resolve();
                            return;
                        }

                        // Search unseen messages
                        imap.search(['UNSEEN'], (err, results) => {
                            if (err || !Array.isArray(results)) {
                                this._verifiedImapMailbox.delete(id);
                                imap.end();
                                resolve();
                                return;
                            }
                            this._verifiedImapMailbox.add(id);
                            if (results.length === 0) {
                                imap.end();
                                resolve();
                                return;
                            }

                            const processing = [];
                            const fetch = imap.fetch(results, { bodies: '', markSeen: true });
                            fetch.on('message', (msg) => {
                                let uid = null;
                                let parsedMessage = Promise.resolve(null);
                                msg.once('attributes', (attributes) => { uid = attributes.uid; });
                                msg.on('body', (stream) => {
                                    parsedMessage = new Promise((complete) => {
                                        this._simpleParser(stream, (parseError, parsed) => complete(parseError ? null : parsed));
                                    });
                                });
                                msg.once('end', () => {
                                    processing.push(parsedMessage.then((parsed) => {
                                        if (!parsed) return;
                                        const mailboxId = uid && box.uidvalidity ? `imap:${box.uidvalidity}:${uid}` : null;
                                        return this._processIncomingEmail(instance, parsed, mailboxId);
                                    }));
                                });
                            });
                            fetch.once('end', () => {
                                Promise.allSettled(processing).then(() => {
                                    imap.end();
                                    resolve();
                                });
                            });
                        });
                    });
                });

                imap.once('error', (err) => {
                    this._verifiedImap.delete(Number(instance.id));
                    this._verifiedImapMailbox.delete(id);
                    Logger.warn(`[Email] IMAP error for instance ${instance.id}: ${err.message}`);
                    resolve();
                });

                imap.once('end', () => resolve());
                imap.connect();

            } catch (e) {
                this._verifiedImap.delete(Number(instance.id));
                this._verifiedImapMailbox.delete(id);
                Logger.error(`[Email] IMAP check failed for instance ${instance.id}:`, e.message);
                resolve();
            }
        });
    }

    async _processIncomingEmail(instance, parsed, mailboxMessageId = null) {
        try {
            const fromAddress = parsed.from?.value?.[0]?.address;
            const fromName = parsed.from?.value?.[0]?.name || fromAddress;
            const subject = parsed.subject || '(без темы)';
            const textContent = parsed.text || parsed.html?.replace(/<[^>]*>/g, '') || '';

            if (!fromAddress) return;

            Logger.info(`[Email] [Instance ${instance.id}] Incoming email`);

            // Find or create client
            let client = await DB.getClientByEmail(instance.id, fromAddress);
            if (!client) {
                // Preserve the exact mailbox identity without collisions from character stripping.
                const internalChatId = `email_${crypto.createHash('sha256').update(fromAddress).digest('hex')}`;
                client = await DB.getOrCreateClient(instance.id, internalChatId, fromName);
                DB.run('UPDATE clients SET emailAddress = ?, preferredChannel = ? WHERE instanceId = ? AND chatId = ?',
                    [fromAddress, 'email', instance.id, internalChatId]);
                client = await DB.getClient(instance.id, internalChatId);
            }

            const messageContent = subject !== '(без темы)' ? `[${subject}] ${textContent}` : textContent;
            const saved = await DB.saveMessageWithChannel(instance.id, client.chatId, fromName, messageContent.substring(0, 5000), 'user', 'email', null, parsed.messageId || mailboxMessageId);
            if (!saved.inserted) return;

            // Process through AI
            const history = await DB.getClientHistory(instance.id, client.chatId, 20);
            const AIService = require('./ai.service');
            const context = {
                clientName: client.senderName,
                leadStatus: client.leadStatus,
                yclientsLink: instance.yclientsLink,
                systemPrompt: instance.systemPrompt,
                salesGoal: instance.salesGoal || 'call',
                instanceConfig: instance,
                instanceId: instance.id
            };

            try {
                const RAGService = require('./rag.service');
                const rag = await RAGService.buildConversationContext(instance.id, client.chatId, messageContent, { k: 5 });
                context.ragContext = rag.context;
                context.ragSearched = rag.searched;
                if (context.ragContext) {
                    Logger.info(`[RAG] Found Email context for instance ${instance.id}`);
                }
            } catch (e) {
                Logger.warn('[Email] RAG search failed:', e.message);
                context.ragContext = '';
            }

            const aiResponse = await AIService.getResponse(history, context);
            let replyText = typeof aiResponse === 'object' ? aiResponse.reply : aiResponse;

            if (typeof aiResponse === 'object' && aiResponse.status && aiResponse.status !== client.leadStatus) {
                try {
                    await DB.updateClientStatus(instance.id, client.chatId, aiResponse.status,
                        aiResponse.statusReasoning || 'AI auto-detection (Email)', 'ai');
                } catch (e) { /* ignore */ }
            }

            if (replyText) {
                const sent = await this.sendEmail(instance.id, fromAddress, `Re: ${subject}`, replyText);
                if (sent) {
                    await DB.saveMessageWithChannel(instance.id, client.chatId, 'Bot', replyText, 'assistant', 'email',
                        typeof aiResponse === 'object' ? aiResponse.thought : null);
                }
            }

        } catch (e) {
            Logger.error('[Email] Processing incoming email error:', e.message);
        }
    }

    async sendEmail(instanceId, to, subject, textBody, context = null) {
        const id = Number(instanceId);
        const transport = this._transporters.get(id);
        if (!transport || !this._verifiedSmtp.has(id)) {
            Logger.warn(`[Email] No verified SMTP transport for instance ${id}`);
            return false;
        }

        try {
            const instance = await DB.getInstance(instanceId);
            if (!instance?.isActive) return false;
            const fromName = instance.emailFromName || instance.name || 'CRM Bot';
            const fromAddress = instance.emailSmtpUser;
            const htmlBody = String(textBody).replace(/[&<>"']/g, char => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            })[char]).replace(/\n/g, '<br>');

            if (typeof context?.beforeSend === 'function') { const guard = context.beforeSend(); if (guard?.then) await guard; }
            await transport.sendMail({
                from: `"${fromName}" <${fromAddress}>`,
                to,
                subject,
                text: textBody,
                html: `<div style="font-family:sans-serif;font-size:14px;line-height:1.6">${htmlBody}</div>`
            });

            Logger.info(`[Email] Sent email for instance ${id}`);
            return true;
        } catch (e) {
            if (e?.safeToRetry === true && e?.code) throw e;
            Logger.error(`[Email] sendEmail failed:`, e.message);
            return false;
        }
    }

    async testSmtp(instanceId) {
        const instance = await DB.getInstance(instanceId);
        if (!instance?.isActive || !instance.emailSmtpHost || !instance.emailSmtpUser) {
            return { success: false, error: 'SMTP не настроен' };
        }

        const transport = await this._setupSmtp(instance);
        if (!transport) return { success: false, error: 'Не удалось создать SMTP транспорт' };

        try {
            await transport.verify();
            this._verifiedSmtp.add(Number(instanceId));
            return { success: true };
        } catch (e) {
            this._verifiedSmtp.delete(Number(instanceId));
            Logger.warn(`[Email] SMTP verification failed for instance ${instanceId}:`, e.message);
            return { success: false, error: 'Не удалось проверить SMTP. Проверьте сервер, порт и учётные данные.' };
        }
    }

    async verifyImap(instance) {
        const id = Number(instance.id);
        this._verifiedImap.delete(id);
        this._verifiedImapMailbox.delete(id);
        if (!instance.isActive || !this._Imap || !instance.emailImapHost || !instance.emailImapUser || !instance.emailImapPass) return false;

        return new Promise((resolve) => {
            let imap;
            let finished = false;
            const finish = (verified) => {
                if (finished) return;
                finished = true;
                clearTimeout(timeout);
                if (verified) this._verifiedImap.add(id);
                else this._verifiedImap.delete(id);
                if (imap) {
                    try {
                        if (verified) imap.end();
                        else imap.destroy();
                    } catch (_) { /* The connection may already be closed. */ }
                }
                resolve(verified);
            };
            const timeout = setTimeout(() => finish(false), this._imapVerifyTimeoutMs);

            (async () => {
                try {
                    const port = validatePort(instance.emailImapPort, 993, IMAP_PORTS);
                    const address = await this._resolvePublicAddress(instance.emailImapHost);
                    if (finished) return; // DNS may finish after the deadline; never connect then.
                    imap = new this._Imap({
                        user: instance.emailImapUser,
                        password: instance.emailImapPass,
                        host: address,
                        port,
                        tls: true,
                        tlsOptions: {
                            ...(!net.isIP(instance.emailImapHost) && { servername: instance.emailImapHost }),
                            rejectUnauthorized: true
                        },
                        connTimeout: 10000,
                        authTimeout: 10000
                    });
                    // `ready` means the server accepted the login. Do not open INBOX,
                    // search, fetch or mark any message read during verification.
                    imap.once('ready', () => finish(true));
                    imap.on('error', () => finish(false));
                    imap.once('end', () => finish(false));
                    imap.connect();
                } catch (_) {
                    // Never return or log provider errors: they can contain credentials.
                    finish(false);
                }
            })();
        });
    }

    async restartInstance(instanceId) {
        const instance = await DB.getInstance(instanceId);
        if (!instance?.isActive) return { success: false, error: 'Бизнес не активен' };
        const smtp = await this.testSmtp(Number(instanceId));
        const imapConfigured = Boolean(instance.emailImapHost && instance.emailImapUser && instance.emailImapPass);
        if (imapConfigured) await this._startImapPolling(instance);
        else {
            const timer = this._imapTimers.get(Number(instanceId));
            if (timer) clearInterval(timer);
            this._imapTimers.delete(Number(instanceId));
            const initial = this._imapInitialTimers.get(Number(instanceId));
            if (initial) clearTimeout(initial);
            this._imapInitialTimers.delete(Number(instanceId));
            this._verifiedImap.delete(Number(instanceId));
            this._verifiedImapMailbox.delete(Number(instanceId));
        }
        const imapVerified = imapConfigured ? await this.verifyImap(instance) : false;
        return { success: smtp.success, ...(smtp.error && { error: smtp.error }), smtpVerified: smtp.success, imapConfigured, imapVerified,
            imapMailboxVerified: this.isImapMailboxVerified(instanceId), imapPolling: this.isImapActive(Number(instanceId)) };
    }

    stopInstance(instanceId) {
        const id = Number(instanceId);
        this._verifiedSmtp.delete(id);
        this._verifiedImap.delete(id);
        this._verifiedImapMailbox.delete(id);
        this._transporters.get(id)?.close();
        this._transporters.delete(id);
        const interval = this._imapTimers.get(id);
        if (interval) clearInterval(interval);
        this._imapTimers.delete(id);
        const initial = this._imapInitialTimers.get(id);
        if (initial) clearTimeout(initial);
        this._imapInitialTimers.delete(id);
    }

    isSmtpActive(instanceId) {
        return this._verifiedSmtp.has(Number(instanceId));
    }

    isImapActive(instanceId) {
        return this._imapTimers.has(Number(instanceId));
    }

    isImapVerified(instanceId) {
        return this._verifiedImap.has(Number(instanceId));
    }

    isImapMailboxVerified(instanceId) {
        return this._verifiedImapMailbox.has(Number(instanceId));
    }
}

module.exports = new EmailService();
