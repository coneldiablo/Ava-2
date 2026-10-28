'use strict';

// Instagram API with Instagram Login, not the Page-mediated Facebook Login API.
// Meta reference: https://www.postman.com/meta/instagram/request/1rgmhuk/text-message
const crypto = require('crypto');
const DB = require('./database.service');
const Credentials = require('./channel-credentials');

const GRAPH_VERSION = 'v26.0';
const GRAPH_ORIGIN = 'https://graph.instagram.com';
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT = 1000;
const initialized = new WeakSet();
const scopedId = value => typeof value === 'string' && /^\d{1,30}$/.test(value);
const failure = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });

function ensureSchema() {
    if (!DB.db) throw failure('INSTAGRAM_STORAGE_UNAVAILABLE', 503);
    if (initialized.has(DB.db)) return;
    DB.db.exec(`
        CREATE TABLE IF NOT EXISTS instagram_accounts (
            businessId INTEGER PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
            igUserId TEXT NOT NULL UNIQUE,
            accessTokenEncrypted TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            webhookReceivedAt INTEGER,
            connectedAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS instagram_contacts (
            businessId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
            igScopedId TEXT NOT NULL,
            chatId TEXT NOT NULL,
            lastInboundAt INTEGER NOT NULL,
            PRIMARY KEY(businessId, igScopedId),
            UNIQUE(businessId, chatId)
        );
        CREATE TABLE IF NOT EXISTS instagram_inbound_events (
            igUserId TEXT NOT NULL,
            messageId TEXT NOT NULL,
            businessId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
            receivedAt INTEGER NOT NULL,
            PRIMARY KEY(igUserId, messageId)
        );
    `);
    initialized.add(DB.db);
}

function safeEqual(actual, expected) {
    const a = Buffer.from(String(actual || ''));
    const b = Buffer.from(String(expected || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function webhookConfig() {
    if (process.env.INSTAGRAM_CONNECTOR_ENABLED !== 'true') {
        throw failure('INSTAGRAM_EXTERNAL_SETUP_REQUIRED', 503);
    }
    const secret = process.env.INSTAGRAM_APP_SECRET;
    const verifyToken = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN;
    if (!secret || !verifyToken || secret.length < 16 || verifyToken.length < 16) {
        throw failure('INSTAGRAM_WEBHOOK_NOT_CONFIGURED', 503);
    }
    return { secret, verifyToken };
}

function verifyChallenge(query) {
    const { verifyToken } = webhookConfig();
    if (query['hub.mode'] !== 'subscribe' || !safeEqual(query['hub.verify_token'], verifyToken) ||
        typeof query['hub.challenge'] !== 'string' ||
        !/^[\x21-\x7e]{1,100}$/.test(query['hub.challenge'])) {
        throw failure('INSTAGRAM_CHALLENGE_INVALID', 403);
    }
    return query['hub.challenge'];
}

function verifySignature(body, signature) {
    const { secret } = webhookConfig();
    if (!Buffer.isBuffer(body) || body.length > 128 * 1024 ||
        !/^sha256=[0-9a-f]{64}$/i.test(String(signature || ''))) return false;
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    return safeEqual(String(signature).toLowerCase(), expected);
}

async function connect(businessId, token) {
    ensureSchema();
    webhookConfig();
    const id = Number(businessId);
    if (!Number.isSafeInteger(id) || id < 1 || !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [id])) {
        throw failure('BUSINESS_NOT_FOUND', 404);
    }
    if (typeof token !== 'string' || token.length < 16 || token.length > 4096 || /\s/.test(token)) {
        throw failure('INSTAGRAM_TOKEN_INVALID');
    }
    // The credential key must exist before contacting Meta or persisting anything.
    Credentials.masterKey() || (() => { throw failure('CHANNEL_CREDENTIALS_MASTER_KEY_REQUIRED', 503); })();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let profile;
    try {
        const response = await fetch(`${GRAPH_ORIGIN}/${GRAPH_VERSION}/me?fields=id,account_type`, {
            headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
        });
        if (!response.ok) throw failure('INSTAGRAM_TOKEN_INVALID', 400);
        profile = await response.json();
    } catch (error) {
        if (error.code) throw error;
        throw failure('INSTAGRAM_TOKEN_CHECK_UNAVAILABLE', 503);
    } finally {
        clearTimeout(timeout);
    }
    if (!scopedId(profile?.id) || !['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(profile?.account_type)) {
        throw failure('INSTAGRAM_PROFESSIONAL_ACCOUNT_REQUIRED');
    }
    const encrypted = Credentials.encrypt(token, id, 'instagramAccessToken');
    try {
        DB.db.transaction(() => {
            const previous = DB.get('SELECT igUserId FROM instagram_accounts WHERE businessId=?', [id]);
            DB.run(`INSERT INTO instagram_accounts (businessId,igUserId,accessTokenEncrypted,enabled,connectedAt)
                VALUES (?,?,?,?,?) ON CONFLICT(businessId) DO UPDATE SET
                igUserId=excluded.igUserId,accessTokenEncrypted=excluded.accessTokenEncrypted,
                enabled=1,webhookReceivedAt=NULL,connectedAt=excluded.connectedAt`,
            [id, profile.id, encrypted, 1, Date.now()]);
            // A new professional account has no conversation rights to contacts
            // of the old account, even when an IGSID happens to match.
            if (previous && previous.igUserId !== profile.id) {
                DB.run('DELETE FROM instagram_contacts WHERE businessId=?', [id]);
            }
        }).immediate();
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw failure('INSTAGRAM_ACCOUNT_ALREADY_BOUND', 409);
        throw error;
    }
    return status(id);
}

function status(businessId) {
    ensureSchema();
    const row = DB.get('SELECT igUserId,enabled,webhookReceivedAt FROM instagram_accounts WHERE businessId=?', [businessId]);
    const base = { configured: Boolean(row), mode: 'manual_replies_only',
        ...(row ? { igUserIdMasked: `••••${row.igUserId.slice(-4)}` } : {}) };
    let setupReady = true;
    try { webhookConfig(); if (!Credentials.masterKey()) setupReady = false; }
    catch (_) { setupReady = false; }
    if (!setupReady) return { ...base, state: 'external_setup_required',
        prerequisites: ['meta_developer_app', 'instagram_business_manage_messages', 'server_webhook_configuration'] };
    if (!row) return { ...base, state: 'not_configured' };
    if (!row.enabled || !row.webhookReceivedAt) return { ...base, state: 'pending_webhook' };
    return { ...base, state: Date.now() - row.webhookReceivedAt < WINDOW_MS
        ? 'inbox_receiving' : 'webhook_stale' };
}

function disconnect(businessId) {
    ensureSchema();
    DB.db.transaction(() => {
        DB.run('DELETE FROM instagram_contacts WHERE businessId=?', [businessId]);
        DB.run('DELETE FROM instagram_accounts WHERE businessId=?', [businessId]);
    }).immediate();
    // Historic messages and replay receipts intentionally remain.
    return status(businessId);
}

function receive(rawBody, signature) {
    if (!verifySignature(rawBody, signature)) throw failure('INSTAGRAM_SIGNATURE_INVALID', 403);
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); }
    catch (_) { throw failure('INSTAGRAM_PAYLOAD_INVALID'); }
    if (payload?.object !== 'instagram' || !Array.isArray(payload.entry)) {
        throw failure('INSTAGRAM_PAYLOAD_INVALID');
    }
    ensureSchema();
    let accepted = 0;
    let duplicate = 0;
    // A single delivery can contain multiple messages. Each one commits atomically.
    for (const entry of payload.entry) {
        if (!Array.isArray(entry?.messaging)) continue;
        for (const event of entry.messaging) {
            const sender = event?.sender?.id;
            const recipient = event?.recipient?.id;
            const message = event?.message;
            const timestamp = Number(event?.timestamp);
            if (!scopedId(sender) || !scopedId(recipient) || sender === recipient ||
                !scopedId(entry.id) || entry.id !== recipient || !message || message.is_echo ||
                typeof message.mid !== 'string' || message.mid.length < 1 || message.mid.length > 300 ||
                typeof message.text !== 'string' || !message.text.trim() || message.text.length > MAX_TEXT ||
                !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > Date.now() + 300000) continue;
            const account = DB.get(`SELECT a.businessId FROM instagram_accounts a
                JOIN instances i ON i.id=a.businessId WHERE a.igUserId=? AND a.enabled=1 AND i.isActive=1`, [recipient]);
            if (!account) continue;
            const eventTime = Math.min(timestamp, Date.now());
            const chatId = `ig:${sender}`;
            const inserted = DB.db.transaction(() => {
                const result = DB.run(`INSERT OR IGNORE INTO instagram_inbound_events
                    (igUserId,messageId,businessId,receivedAt) VALUES (?,?,?,?)`,
                [recipient, message.mid, account.businessId, Date.now()]);
                if (!result.changes) return false;
                DB.run(`INSERT INTO instagram_contacts (businessId,igScopedId,chatId,lastInboundAt)
                    VALUES (?,?,?,?) ON CONFLICT(businessId,igScopedId) DO UPDATE SET
                    lastInboundAt=MAX(lastInboundAt,excluded.lastInboundAt)`,
                [account.businessId, sender, chatId, eventTime]);
                DB.run(`INSERT INTO clients (instanceId,chatId,senderName,preferredChannel,lastStatusChangeAt)
                    VALUES (?,?,?,'instagram',CURRENT_TIMESTAMP) ON CONFLICT(instanceId,chatId) DO NOTHING`,
                [account.businessId, chatId, 'Instagram user']);
                DB.run(`INSERT INTO messages (instanceId,chatId,senderName,messageType,content,role,channel)
                    VALUES (?,?,?,'text',?,'user','instagram')`,
                [account.businessId, chatId, 'Instagram user', message.text.trim()]);
                DB.run(`UPDATE clients SET lastMessage=?,lastMessageTime=CURRENT_TIMESTAMP,updatedAt=CURRENT_TIMESTAMP
                    WHERE instanceId=? AND chatId=?`, [message.text.trim(), account.businessId, chatId]);
                DB.run('UPDATE instagram_accounts SET webhookReceivedAt=? WHERE businessId=?', [Date.now(), account.businessId]);
                return true;
            }).immediate();
            if (inserted) accepted++; else duplicate++;
        }
    }
    return { accepted, duplicate };
}

async function send(instanceId, chatId, text, context = null) {
    if (typeof chatId === 'string' && chatId.startsWith('igp:')) {
        try { return await require('../../instagram_private/server').reply(instanceId, chatId, text, context); }
        catch (cause) { return { success: false, channel: 'instagram',
            error: String(cause.code || 'INSTAGRAM_PRIVATE_UNAVAILABLE').toLowerCase() }; }
    }
    ensureSchema();
    try { webhookConfig(); }
    catch (_) { return { success: false, channel: 'instagram', error: 'instagram_external_setup_required' }; }
    const id = Number(instanceId);
    if (!Number.isSafeInteger(id) || id < 1 || typeof chatId !== 'string' ||
        typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
        return { success: false, channel: 'instagram', error: 'instagram_request_invalid' };
    }
    const row = DB.get(`SELECT a.igUserId,a.accessTokenEncrypted,c.igScopedId,c.lastInboundAt
        FROM instagram_accounts a JOIN instagram_contacts c ON c.businessId=a.businessId
        JOIN instances i ON i.id=a.businessId
        WHERE a.businessId=? AND c.chatId=? AND a.enabled=1 AND i.isActive=1`, [id, chatId]);
    if (!row || !scopedId(row.igUserId) || !scopedId(row.igScopedId)) {
        return { success: false, channel: 'instagram', error: 'instagram_recipient_not_inbound' };
    }
    const age = Date.now() - row.lastInboundAt;
    if (age < 0 || age >= WINDOW_MS) {
        return { success: false, channel: 'instagram', error: 'instagram_reply_window_closed' };
    }
    let token;
    try { token = Credentials.decrypt(row.accessTokenEncrypted, id, 'instagramAccessToken'); }
    catch (_) { return { success: false, channel: 'instagram', error: 'instagram_credential_unavailable' }; }
    if (!token || !Credentials.isEncrypted(row.accessTokenEncrypted)) {
        return { success: false, channel: 'instagram', error: 'instagram_credential_unavailable' };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        if (typeof context?.beforeSend === 'function') { const guard = context.beforeSend(); if (guard?.then) await guard; }
        const response = await fetch(`${GRAPH_ORIGIN}/${GRAPH_VERSION}/${row.igUserId}/messages`, {
            method: 'POST', signal: controller.signal,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipient: { id: row.igScopedId }, message: { text: text.trim() } }),
        });
        if (!response.ok) return { success: false, channel: 'instagram', error: 'instagram_provider_rejected' };
        const data = await response.json();
        if (!data?.message_id) return { success: false, channel: 'instagram', error: 'instagram_provider_response_invalid' };
        await DB.saveMessageWithChannel(id, chatId, 'Bot', text.trim(), 'assistant', 'instagram');
        return { success: true, channel: 'instagram', provider_message_id: data.message_id };
    } catch (cause) {
        if (cause?.safeToRetry === true && cause?.code) throw cause;
        return { success: false, channel: 'instagram', error: 'instagram_provider_unavailable' };
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { GRAPH_VERSION, ensureSchema, verifyChallenge, verifySignature,
    connect, disconnect, status, receive, send };
