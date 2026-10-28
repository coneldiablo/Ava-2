'use strict';

// Private Instagram is a separate opt-in connector. The official Meta connector
// remains in src/services/instagram.service.js and uses different tables/routes.
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const DB = require('../src/services/database.service');
const Credentials = require('../src/services/channel-credentials');

// 20 threads × 20 bounded text messages plus the bounded session object.
const MAX_OUTPUT = 2 * 1024 * 1024;
const POLL_LEASE_MS = 90_000;
const POLL_INTERVAL_MS = 120_000;
const LOGIN_CONTEXT_MS = 15 * 60_000;
const error = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const numericId = value => typeof value === 'string' && /^[1-9][0-9]{0,39}$/.test(value);
const cleanText = (value, max) => typeof value === 'string' && value.trim() && value.length <= max &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const initialized = new WeakSet();

function enabled() {
    return process.env.INSTAGRAM_PRIVATE_CONNECTOR_ENABLED === 'true' &&
        Boolean(Credentials.masterKey());
}

function encrypt(value, businessId, purpose = 'session') {
    const key = Credentials.masterKey();
    if (!key) throw error('INSTAGRAM_PRIVATE_KEY_REQUIRED', 503);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(purpose === 'session' ? `ava-instagram-private:v1:${businessId}` : `ava-instagram-private:${purpose}:v1:${businessId}`));
    const payload = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return `enc:v1:${Buffer.concat([iv, cipher.getAuthTag(), payload]).toString('base64url')}`;
}

function decrypt(value, businessId, purpose = 'session') {
    if (typeof value !== 'string' || !value.startsWith('enc:v1:')) throw error('INSTAGRAM_PRIVATE_SESSION_UNAVAILABLE', 503);
    const key = Credentials.masterKey();
    if (!key) throw error('INSTAGRAM_PRIVATE_KEY_REQUIRED', 503);
    try {
        const payload = Buffer.from(value.slice(7), 'base64url');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
        decipher.setAAD(Buffer.from(purpose === 'session' ? `ava-instagram-private:v1:${businessId}` : `ava-instagram-private:${purpose}:v1:${businessId}`));
        decipher.setAuthTag(payload.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8'));
    } catch (_) { throw error('INSTAGRAM_PRIVATE_SESSION_UNAVAILABLE', 503); }
}

function schema() {
    if (!DB.db) throw error('INSTAGRAM_PRIVATE_STORAGE_UNAVAILABLE', 503);
    if (initialized.has(DB.db)) return;
    DB.db.exec(`
        CREATE TABLE IF NOT EXISTS instagram_private_accounts (
            businessId INTEGER PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
            accountId TEXT NOT NULL UNIQUE,
            username TEXT NOT NULL,
            sessionEncrypted TEXT,
            state TEXT NOT NULL CHECK(state IN ('awaiting_inbound','connected','paused','disabled')),
            pauseReason TEXT,
            inboundConfirmedAt INTEGER,
            connectedAt INTEGER NOT NULL DEFAULT 0,
            leaseUntil INTEGER NOT NULL DEFAULT 0,
            nextPollAt INTEGER NOT NULL DEFAULT 0,
            updatedAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS instagram_private_account_claims (
            accountId TEXT PRIMARY KEY,
            businessId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS instagram_private_login_attempts (
            businessId INTEGER PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
            windowStartedAt INTEGER NOT NULL,
            attempts INTEGER NOT NULL,
            lockedUntil INTEGER NOT NULL DEFAULT 0,
            leaseUntil INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS instagram_private_login_contexts (
            businessId INTEGER PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
            usernameHash TEXT NOT NULL,
            settingsEncrypted TEXT,
            expiresAt INTEGER NOT NULL,
            lastErrorCode TEXT NOT NULL,
            updatedAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS instagram_private_threads (
            businessId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
            accountId TEXT NOT NULL,
            threadId TEXT NOT NULL,
            chatId TEXT NOT NULL,
            lastInboundAt INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(businessId,accountId,threadId),
            UNIQUE(businessId,chatId)
        );
        CREATE TABLE IF NOT EXISTS instagram_private_receipts (
            accountId TEXT NOT NULL,
            messageId TEXT NOT NULL,
            businessId INTEGER NOT NULL,
            receivedAt INTEGER NOT NULL,
            PRIMARY KEY(accountId,messageId)
        );
    `);
    const columns = new Set(DB.db.prepare('PRAGMA table_info(instagram_private_accounts)').all().map(row => row.name));
    if (!columns.has('connectedAt')) DB.db.exec('ALTER TABLE instagram_private_accounts ADD COLUMN connectedAt INTEGER NOT NULL DEFAULT 0');
    DB.run('UPDATE instagram_private_accounts SET connectedAt=updatedAt WHERE connectedAt=0');
    initialized.add(DB.db);
}

function publicStatus(businessId) {
    schema();
    if (!enabled()) return { state: 'disabled', configured: false, reason: 'connector_disabled_or_key_required' };
    const row = DB.get(`SELECT accountId,username,state,pauseReason,inboundConfirmedAt FROM instagram_private_accounts
        WHERE businessId=?`, [businessId]);
    if (!row || row.state === 'disabled') {
        const failed = DB.get('SELECT lastErrorCode,updatedAt FROM instagram_private_login_contexts WHERE businessId=?', [businessId]);
        const attempt = DB.get('SELECT lockedUntil FROM instagram_private_login_attempts WHERE businessId=?', [businessId]);
        return { state: 'not_connected', configured: false,
            ...(failed ? {lastLoginError: failed.lastErrorCode, lastLoginAt: failed.updatedAt} : {}),
            ...(attempt?.lockedUntil > Date.now() ? {retryAt: attempt.lockedUntil} : {}) };
    }
    return { state: row.state, configured: true,
        accountMasked: `••••${row.accountId.slice(-4)}`,
        pauseReason: row.pauseReason || undefined,
        inboundConfirmed: Boolean(row.inboundConfirmedAt) };
}

function requireEnabled() {
    if (!enabled()) throw error('INSTAGRAM_PRIVATE_DISABLED', 503);
}

function validBusiness(businessId) {
    const id = Number(businessId);
    if (!Number.isSafeInteger(id) || id < 1 || !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [id])) {
        throw error('BUSINESS_NOT_FOUND', 404);
    }
    return id;
}

function reserveLoginAttempt(businessId) {
    const now = Date.now();
    const outcome = DB.db.transaction(() => {
        const row = DB.get('SELECT * FROM instagram_private_login_attempts WHERE businessId=?', [businessId]);
        if (row?.lockedUntil > now) return 'INSTAGRAM_PRIVATE_LOGIN_COOLDOWN';
        if (row?.leaseUntil > now) return 'INSTAGRAM_PRIVATE_LOGIN_IN_PROGRESS';
        const sameWindow = row && now - row.windowStartedAt < 15 * 60_000;
        const attempts = sameWindow ? row.attempts + 1 : 1;
        const lockedUntil = attempts > 5 ? now + 15 * 60_000 : 0;
        DB.run(`INSERT INTO instagram_private_login_attempts
            (businessId,windowStartedAt,attempts,lockedUntil,leaseUntil) VALUES (?,?,?,?,?)
            ON CONFLICT(businessId) DO UPDATE SET windowStartedAt=excluded.windowStartedAt,
            attempts=excluded.attempts,lockedUntil=excluded.lockedUntil,leaseUntil=excluded.leaseUntil`,
        [businessId, sameWindow ? row.windowStartedAt : now, attempts, lockedUntil,
            lockedUntil ? 0 : now + 90_000]);
        return lockedUntil ? 'INSTAGRAM_PRIVATE_LOGIN_COOLDOWN' : null;
    }).immediate();
    if (outcome) throw error(outcome, 429);
}

function releaseLoginAttempt(businessId, providerCode) {
    const now = Date.now();
    const pause = providerCode === 'INSTAGRAM_PRIVATE_RATE_LIMITED' ? 5 * 60_000
        : providerCode === 'INSTAGRAM_PRIVATE_CHALLENGE_REQUIRED' ? 60_000 : 0;
    DB.run(`UPDATE instagram_private_login_attempts SET leaseUntil=0,
        lockedUntil=MAX(lockedUntil,?) WHERE businessId=?`, [now + pause, businessId]);
}

function runPythonOnce(request) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.env.INSTAGRAM_PRIVATE_PYTHON || 'python3', ['-m', 'instagram_private.worker'], {
            cwd: path.resolve(__dirname, '..'), stdio: ['pipe', 'pipe', 'ignore'], env: process.env,
        });
        let output = '';
        let tooLarge = false;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, request.action === 'prepare-login' ? 10_000 : 45_000);
        child.stdout.on('data', chunk => {
            output += chunk.toString('utf8');
            if (output.length > MAX_OUTPUT) { tooLarge = true; child.kill('SIGKILL'); }
        });
        child.on('error', () => { clearTimeout(timer); reject(error('INSTAGRAM_PRIVATE_WORKER_UNAVAILABLE', 503)); });
        child.on('close', code => {
            clearTimeout(timer);
            if (timedOut) return reject(error('INSTAGRAM_PRIVATE_WORKER_TIMEOUT', 503));
            if (tooLarge || code !== 0) return reject(error('INSTAGRAM_PRIVATE_WORKER_UNAVAILABLE', 503));
            let result;
            try { result = JSON.parse(output); } catch (_) { return reject(error('INSTAGRAM_PRIVATE_WORKER_UNAVAILABLE', 503)); }
            if (!result || typeof result.ok !== 'boolean') return reject(error('INSTAGRAM_PRIVATE_WORKER_UNAVAILABLE', 503));
            if (!result.ok) {
                const code = `INSTAGRAM_PRIVATE_${String(result.code || 'worker_error').toUpperCase()}`;
                const status = /(?:RATE_LIMITED|LOGIN_COOLDOWN)$/.test(code) ? 429 : /(?:CONNECTION_UNAVAILABLE|DEPENDENCY_MISSING|WORKER_ERROR|UPSTREAM_ERROR)$/.test(code) ? 503 : 409;
                return reject(Object.assign(error(code, status), {loginSettings: result.login_settings}));
            }
            resolve(result.data);
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(request) + '\n');
    });
}

async function runPython(request) {
    let settings = request.settings;
    if (request.action === 'login' && !settings) {
        // Generate the stable device before network I/O so a timed-out first
        // login can continue with the same identity on the owner's next try.
        settings = (await runPythonOnce({action:'prepare-login'})).settings;
        if (!settings || typeof settings !== 'object') throw error('INSTAGRAM_PRIVATE_WORKER_UNAVAILABLE',503);
    }
    try { return await runPythonOnce({...request,...(settings ? {settings} : {})}); }
    catch (cause) {
        if (request.action === 'login' && !cause.loginSettings) cause.loginSettings = settings;
        throw cause;
    }
}

function loginHash(businessId, username) {
    return crypto.createHmac('sha256', Credentials.masterKey()).update(`${businessId}:${username.toLowerCase()}`).digest('hex');
}

function rememberLogin(id, usernameHash, cause, code) {
    let settings = cause.loginSettings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Buffer.byteLength(JSON.stringify(settings)) > 262144) settings = null;
    const previous = DB.get('SELECT * FROM instagram_private_login_contexts WHERE businessId=?',[id]);
    const now = Date.now();
    const encrypted = settings ? encrypt(settings,id,'pending-login') : previous?.usernameHash === usernameHash && previous.expiresAt > now ? previous.settingsEncrypted : null;
    DB.run(`INSERT INTO instagram_private_login_contexts VALUES(?,?,?,?,?,?)
        ON CONFLICT(businessId) DO UPDATE SET usernameHash=excluded.usernameHash,
        settingsEncrypted=excluded.settingsEncrypted,expiresAt=excluded.expiresAt,
        lastErrorCode=excluded.lastErrorCode,updatedAt=excluded.updatedAt`,
        [id,usernameHash,encrypted,now+LOGIN_CONTEXT_MS,code,now]);
}

class PrivateInstagramService {
    constructor(runner = runPython) { this.runner = runner; }

    status(businessId) { return publicStatus(businessId); }

    async login(businessId, input) {
        schema(); requireEnabled();
        const id = validBusiness(businessId);
        const username = input?.username?.trim();
        if (!cleanText(username, 100) || !cleanText(input?.password, 1024) ||
            (input?.code != null && !/^[0-9]{6,8}$/.test(input.code))) {
            throw error('INSTAGRAM_PRIVATE_CREDENTIALS_INVALID');
        }
        const current = DB.get('SELECT state FROM instagram_private_accounts WHERE businessId=?', [id]);
        if (current && current.state !== 'disabled') throw error('INSTAGRAM_PRIVATE_ALREADY_CONFIGURED', 409);
        reserveLoginAttempt(id);
        const usernameHash = loginHash(id,username);
        const pending = DB.get('SELECT * FROM instagram_private_login_contexts WHERE businessId=?',[id]);
        let response;
        try {
            const settings = pending?.usernameHash === usernameHash && pending.expiresAt > Date.now() && pending.settingsEncrypted
                ? decrypt(pending.settingsEncrypted,id,'pending-login') : null;
            response = await this.runner({ action: 'login', username, password: input.password, code: input.code || null,
                ...(settings ? {settings} : {}) });
        }
        catch (cause) {
            const safeError = this.handleProviderError(id, cause, false);
            try { rememberLogin(id,usernameHash,cause,safeError.code); }
            finally { releaseLoginAttempt(id, safeError.code); }
            throw safeError;
        }
        if (!numericId(response?.account_id) || !response.settings || typeof response.settings !== 'object') {
            releaseLoginAttempt(id);
            throw error('INSTAGRAM_PRIVATE_WORKER_UNAVAILABLE', 503);
        }
        try {
            const encrypted = encrypt(response.settings, id);
            DB.db.transaction(() => {
                const existing = DB.get(`SELECT state,accountId,sessionEncrypted FROM instagram_private_accounts
                    WHERE businessId=?`, [id]);
                if (existing && existing.state !== 'disabled') throw error('INSTAGRAM_PRIVATE_ALREADY_CONFIGURED', 409);
                if (existing?.sessionEncrypted != null) throw error('INSTAGRAM_PRIVATE_ALREADY_CONFIGURED', 409);
                if (existing && existing.accountId !== response.account_id) {
                    DB.run('DELETE FROM instagram_private_account_claims WHERE accountId=? AND businessId=?',
                        [existing.accountId, id]);
                }
                const other = DB.get('SELECT businessId FROM instagram_private_account_claims WHERE accountId=?', [response.account_id]);
                if (other && other.businessId !== id) {
                    // Older releases retained a claim after disconnect. Reclaim only an
                    // account whose session was already erased by that business.
                    const old = DB.get(`SELECT state,sessionEncrypted FROM instagram_private_accounts
                        WHERE businessId=? AND accountId=?`, [other.businessId, response.account_id]);
                    if (old && (old.state !== 'disabled' || old.sessionEncrypted !== null)) {
                        throw error('INSTAGRAM_PRIVATE_ACCOUNT_BOUND', 409);
                    }
                    DB.run('DELETE FROM instagram_private_accounts WHERE businessId=? AND accountId=?',
                        [other.businessId, response.account_id]);
                    DB.run('DELETE FROM instagram_private_account_claims WHERE accountId=? AND businessId=?',
                        [response.account_id, other.businessId]);
                }
                DB.run(`INSERT OR IGNORE INTO instagram_private_account_claims (accountId,businessId) VALUES (?,?)`,
                    [response.account_id, id]);
                DB.run(`INSERT INTO instagram_private_accounts
                    (businessId,accountId,username,sessionEncrypted,state,connectedAt,updatedAt)
                    VALUES (?,?,?,?,'awaiting_inbound',?,?)
                    ON CONFLICT(businessId) DO UPDATE SET accountId=excluded.accountId,username=excluded.username,
                    sessionEncrypted=excluded.sessionEncrypted,state='awaiting_inbound',pauseReason=NULL,
                    inboundConfirmedAt=NULL,connectedAt=excluded.connectedAt,leaseUntil=0,nextPollAt=0,
                    updatedAt=excluded.updatedAt`,
                [id, response.account_id, username, encrypted, Date.now(), Date.now()]);
                DB.run('DELETE FROM instagram_private_login_contexts WHERE businessId=?',[id]);
            }).immediate();
        } catch (cause) {
            if (cause.code === 'SQLITE_CONSTRAINT_UNIQUE') throw error('INSTAGRAM_PRIVATE_ACCOUNT_BOUND', 409);
            throw cause;
        } finally {
            releaseLoginAttempt(id);
        }
        return this.status(id);
    }

    handleProviderError(businessId, cause, persist = true) {
        const code = typeof cause?.code === 'string' && /^INSTAGRAM_PRIVATE_[A-Z_]+$/.test(cause.code)
            ? cause.code : 'INSTAGRAM_PRIVATE_WORKER_UNAVAILABLE';
        const reason = code.replace('INSTAGRAM_PRIVATE_', '').toLowerCase();
        if (persist && ['challenge_required', 'rate_limited', 'login_required', 'two_factor_required',
            'send_result_unknown', 'account_mismatch'].includes(reason)) {
            DB.run(`UPDATE instagram_private_accounts SET state='paused',pauseReason=?,leaseUntil=0,updatedAt=?
                WHERE businessId=? AND state!='disabled'`, [reason, Date.now(), businessId]);
        }
        return error(code, cause?.statusCode || 503);
    }

    async poll(businessId, force = false) {
        schema(); requireEnabled();
        const id = validBusiness(businessId);
        const now = Date.now();
        const claim = DB.run(`UPDATE instagram_private_accounts SET leaseUntil=? WHERE businessId=?
            AND state IN ('awaiting_inbound','connected') AND sessionEncrypted IS NOT NULL AND leaseUntil<? AND (nextPollAt<=? OR ?=1)`,
        [now + POLL_LEASE_MS, id, now, now, force ? 1 : 0]);
        if (!claim.changes) return { accepted: 0, skipped: true, ...this.status(id) };
        const row = DB.get('SELECT accountId,sessionEncrypted,connectedAt FROM instagram_private_accounts WHERE businessId=?', [id]);
        try {
            const response = await this.runner({ action: 'poll', settings: decrypt(row.sessionEncrypted, id) });
            if (response?.account_id !== row.accountId || !Array.isArray(response.threads)) {
                throw error('INSTAGRAM_PRIVATE_ACCOUNT_MISMATCH', 409);
            }
            let accepted = 0;
            // PR #38 adds sourceMessageId to the shared save method. Use it once
            // integrated; keep a local atomic receipt path on the base commit.
            const sharedDedupe = DB.db.prepare('PRAGMA table_info(messages)').all()
                .some(column => column.name === 'sourceMessageId');
            for (const thread of response.threads) {
                if (!numericId(thread?.id) || !numericId(thread?.peer_id) || !Array.isArray(thread.messages)) continue;
                for (const message of [...thread.messages].reverse()) {
                    if (!numericId(message?.id) || !numericId(message?.sender_id) ||
                        message.sender_id !== thread.peer_id || message.sender_id === row.accountId ||
                        !cleanText(message?.text, 2000) || !Number.isSafeInteger(message.timestamp_ms) ||
                        message.timestamp_ms < row.connectedAt || message.timestamp_ms > Date.now() + 300_000) continue;
                    const chatId = `igp:${row.accountId}:${message.sender_id}`;
                    const receivedAt = Date.now();
                    if (sharedDedupe) {
                        const active = DB.db.transaction(() => {
                            const still = DB.get(`SELECT accountId,state FROM instagram_private_accounts WHERE businessId=?`, [id]);
                            if (!still || still.accountId !== row.accountId || !['awaiting_inbound','connected'].includes(still.state)) return false;
                            DB.run(`INSERT INTO instagram_private_threads (businessId,accountId,threadId,chatId)
                                VALUES (?,?,?,?) ON CONFLICT(businessId,accountId,threadId) DO NOTHING`,
                            [id, row.accountId, thread.id, chatId]);
                            DB.run(`INSERT INTO clients (instanceId,chatId,senderName,preferredChannel,lastStatusChangeAt)
                                VALUES (?,?,?,'instagram',CURRENT_TIMESTAMP)
                                ON CONFLICT(instanceId,chatId) DO NOTHING`, [id, chatId, 'Instagram Direct']);
                            return true;
                        }).immediate();
                        if (!active) continue;
                        const result = await DB.saveMessageWithChannel(id, chatId, 'Instagram Direct',
                            message.text, 'user', 'instagram', null, message.id);
                        if (result.inserted) {
                            accepted++;
                            DB.run(`UPDATE instagram_private_threads SET lastInboundAt=?
                                WHERE businessId=? AND accountId=? AND threadId=?`,
                            [receivedAt, id, row.accountId, thread.id]);
                            DB.run(`UPDATE instagram_private_accounts SET state='connected',
                                inboundConfirmedAt=COALESCE(inboundConfirmedAt,?),pauseReason=NULL,updatedAt=?
                                WHERE businessId=? AND accountId=? AND state IN ('awaiting_inbound','connected')`,
                            [receivedAt, receivedAt, id, row.accountId]);
                        }
                        continue;
                    }
                    const inserted = DB.db.transaction(() => {
                        const still = DB.get(`SELECT accountId,state FROM instagram_private_accounts WHERE businessId=?`, [id]);
                        if (!still || still.accountId !== row.accountId || !['awaiting_inbound','connected'].includes(still.state)) return false;
                        const receipt = DB.run(`INSERT OR IGNORE INTO instagram_private_receipts
                            (accountId,messageId,businessId,receivedAt) VALUES (?,?,?,?)`,
                        [row.accountId, message.id, id, Date.now()]);
                        if (!receipt.changes) return false;
                        DB.run(`INSERT INTO instagram_private_threads (businessId,accountId,threadId,chatId) VALUES (?,?,?,?)
                            ON CONFLICT(businessId,accountId,threadId) DO NOTHING`, [id, row.accountId, thread.id, chatId]);
                        DB.run(`UPDATE instagram_private_threads SET lastInboundAt=?
                            WHERE businessId=? AND accountId=? AND threadId=?`,
                        [receivedAt, id, row.accountId, thread.id]);
                        DB.run(`INSERT INTO clients (instanceId,chatId,senderName,preferredChannel,lastStatusChangeAt)
                            VALUES (?,?,?,'instagram',CURRENT_TIMESTAMP)
                            ON CONFLICT(instanceId,chatId) DO NOTHING`, [id, chatId, 'Instagram Direct']);
                        DB.run(`INSERT INTO messages (instanceId,chatId,senderName,messageType,content,role,channel)
                            VALUES (?,?,?,'text',?,'user','instagram')`,
                        [id, chatId, 'Instagram Direct', message.text]);
                        DB.run(`UPDATE clients SET lastMessage=?,lastMessageTime=CURRENT_TIMESTAMP,updatedAt=CURRENT_TIMESTAMP
                            WHERE instanceId=? AND chatId=?`, [message.text, id, chatId]);
                        DB.run(`UPDATE instagram_private_accounts SET state='connected',inboundConfirmedAt=COALESCE(inboundConfirmedAt,?),
                            pauseReason=NULL,updatedAt=? WHERE businessId=?`, [receivedAt, receivedAt, id]);
                        return true;
                    }).immediate();
                    if (inserted) accepted++;
                }
            }
            if (response.settings) DB.run(`UPDATE instagram_private_accounts SET sessionEncrypted=?,updatedAt=?
                WHERE businessId=? AND accountId=? AND state!='disabled'`,
            [encrypt(response.settings, id), Date.now(), id, row.accountId]);
            return { accepted, ...this.status(id) };
        } catch (cause) { throw this.handleProviderError(id, cause); }
        finally { DB.run(`UPDATE instagram_private_accounts SET leaseUntil=0,nextPollAt=? WHERE businessId=? AND accountId=?`,
            [Date.now() + POLL_INTERVAL_MS, id, row.accountId]); }
    }

    async reply(businessId, chatId, text, context = null) {
        schema(); requireEnabled();
        const id = validBusiness(businessId);
        if (!cleanText(text, 1000)) throw error('INSTAGRAM_PRIVATE_TEXT_INVALID');
        const row = DB.db.transaction(() => {
            const current = DB.get(`SELECT a.accountId,a.sessionEncrypted,t.threadId FROM instagram_private_accounts a
                JOIN instagram_private_threads t ON t.businessId=a.businessId AND t.accountId=a.accountId
                WHERE a.businessId=? AND t.chatId=? AND a.state='connected' AND a.inboundConfirmedAt IS NOT NULL
                  AND t.lastInboundAt>=a.inboundConfirmedAt`, [id, chatId]);
            if (!current) return null;
            const now = Date.now();
            const claim = DB.run(`UPDATE instagram_private_accounts SET leaseUntil=?
                WHERE businessId=? AND accountId=? AND state='connected' AND leaseUntil<?`,
            [now + POLL_LEASE_MS, id, current.accountId, now]);
            if (!claim.changes) throw error('INSTAGRAM_PRIVATE_OPERATION_IN_PROGRESS', 409);
            return current;
        }).immediate();
        if (!row) throw error('INSTAGRAM_PRIVATE_THREAD_NOT_FOUND', 404);
        try {
            let response;
            if (typeof context?.beforeSend === 'function') { const guard = context.beforeSend(); if (guard?.then) await guard; }
            try { response = await this.runner({ action: 'reply', settings: decrypt(row.sessionEncrypted, id),
                thread_id: row.threadId, text: text.trim() }); }
            catch (cause) {
                const uncertain = ['INSTAGRAM_PRIVATE_WORKER_TIMEOUT','INSTAGRAM_PRIVATE_WORKER_UNAVAILABLE'].includes(cause.code)
                    ? error('INSTAGRAM_PRIVATE_SEND_RESULT_UNKNOWN',503) : cause;
                throw this.handleProviderError(id, uncertain);
            }
            if (response?.account_id !== row.accountId || !numericId(response?.message_id)) {
                throw this.handleProviderError(id, error('INSTAGRAM_PRIVATE_SEND_RESULT_UNKNOWN', 503));
            }
            DB.run(`INSERT INTO messages (instanceId,chatId,senderName,messageType,content,role,channel)
                VALUES (?,?,?,'text',?,'assistant','instagram')`, [id, chatId, 'Менеджер', text.trim()]);
            DB.run(`UPDATE clients SET lastMessage=?,lastMessageTime=CURRENT_TIMESTAMP,updatedAt=CURRENT_TIMESTAMP
                WHERE instanceId=? AND chatId=?`, [text.trim(), id, chatId]);
            if (response.settings) DB.run(`UPDATE instagram_private_accounts SET sessionEncrypted=? WHERE businessId=? AND accountId=?`,
                [encrypt(response.settings, id), id, row.accountId]);
            return { success: true, channel: 'instagram', provider_message_id: String(response.message_id) };
        } finally {
            DB.run(`UPDATE instagram_private_accounts SET leaseUntil=0 WHERE businessId=? AND accountId=?`,
                [id, row.accountId]);
        }
    }

    disconnect(businessId) {
        schema(); const id = validBusiness(businessId);
        DB.db.transaction(() => {
            const activeLogin = DB.get('SELECT leaseUntil FROM instagram_private_login_attempts WHERE businessId=?', [id]);
            if (activeLogin?.leaseUntil > Date.now()) throw error('INSTAGRAM_PRIVATE_OPERATION_IN_PROGRESS', 409);
            const row = DB.get('SELECT accountId,leaseUntil FROM instagram_private_accounts WHERE businessId=?', [id]);
            DB.run('DELETE FROM instagram_private_login_contexts WHERE businessId=?',[id]);
            if (!row) return;
            if (row.leaseUntil > Date.now()) throw error('INSTAGRAM_PRIVATE_OPERATION_IN_PROGRESS', 409);
            DB.run('DELETE FROM instagram_private_accounts WHERE businessId=?', [id]);
            DB.run('DELETE FROM instagram_private_account_claims WHERE accountId=? AND businessId=?',
                [row.accountId, id]);
        }).immediate();
        return this.status(id);
    }

    async pollDue() {
        if (!enabled() || !DB.db) return;
        schema();
        const ids = DB.db.prepare(`SELECT businessId FROM instagram_private_accounts WHERE state IN ('awaiting_inbound','connected')
            AND nextPollAt<=? AND leaseUntil<? LIMIT 10`).all(Date.now(), Date.now());
        for (const { businessId } of ids) {
            try { await this.poll(businessId); } catch (_) { /* status is persisted; never log provider details */ }
        }
    }
}

module.exports = new PrivateInstagramService();
module.exports.PrivateInstagramService = PrivateInstagramService;
module.exports.ensureSchema = schema;
