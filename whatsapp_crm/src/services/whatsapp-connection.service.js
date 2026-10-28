const crypto = require('crypto');
const DB = require('./database.service');
const Gateway = require('./openwa.service');

const pending = new Map();
function failure(code = 'WHATSAPP_UNAVAILABLE', statusCode = 503) {
    const messages = {
        WHATSAPP_UNAVAILABLE: 'Не удалось подключить WhatsApp. Повторите попытку через минуту. Если ошибка повторяется, обратитесь в поддержку AVA.',
        WHATSAPP_NOT_CONFIGURED: 'Подключение WhatsApp ещё не настроено в AVA. Обратитесь в поддержку.',
        WHATSAPP_SESSION_SCOPE: 'Это подключение уже связано с другим бизнесом. Обратитесь в поддержку AVA.',
        WHATSAPP_ACCOUNT_CHANGED: 'QR-код отсканирован другим WhatsApp-аккаунтом. Используйте прежний номер или создайте отдельное подключение для смены номера. История CRM сохраняется.',
        WHATSAPP_CONNECTION_CHANGED: 'Подключение уже изменилось. Обновите страницу перед сменой номера.',
        WHATSAPP_BUSY: 'Подключение уже выполняется. Дождитесь результата и обновите статус.',
        BUSINESS_NOT_FOUND: 'Бизнес не найден или отключён.',
    };
    return { success: false, code, statusCode, error: messages[code] || messages.WHATSAPP_UNAVAILABLE };
}

function stateFailure(state) {
    if (state?.rawStatus === 'failed' && /^Link rejected: this session is bound to /.test(String(state.lastError || ''))) {
        return failure('WHATSAPP_ACCOUNT_CHANGED', 409);
    }
    return null;
}

async function getQRResult(instance) {
    const qr = await Gateway.getQR(instance.openWaUrl, instance.openWaApiKey, instance.openWaSessionId);
    if (qr.success) return qr;
    if (qr.statusCode === 400 || qr.statusCode === 409) {
        const state = await Gateway.getState(instance.openWaUrl, instance.openWaApiKey, instance.openWaSessionId);
        if (!state.success) return failure();
        const blocked = stateFailure(state.data);
        if (blocked) return blocked;
        if (state.data?.rawStatus === 'ready') return { success: true, type: 'alreadyLogged' };
        if (['created', 'initializing', 'authenticating', 'qr_ready'].includes(state.data?.rawStatus)) {
            return { success: true, type: 'pending', status: state.data.rawStatus };
        }
    }
    return failure();
}

function signingSecret(instance) {
    const master = String(process.env.OPENWA_WEBHOOK_MASTER_KEY || Gateway.resolveApiKey(instance.openWaApiKey) || '');
    if (master.length < 16 || !instance.id || !instance.openWaSessionId) throw new Error('WHATSAPP_NOT_CONFIGURED');
    return crypto.createHmac('sha256', master)
        .update(`ava:openwa:webhook:v1:${instance.id}:${instance.openWaSessionId}`).digest('hex');
}

function verifyWebhook(req, instance) {
    if (!instance || req.body?.sessionId !== instance.openWaSessionId || !Buffer.isBuffer(req.rawBody)) return false;
    try {
        const expected = 'sha256=' + crypto.createHmac('sha256', signingSecret(instance)).update(req.rawBody).digest('hex');
        const actual = String(req.headers['x-openwa-signature'] || '');
        return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
    } catch (_) { return false; }
}

// GREEN-API delivers webhookUrlToken as Authorization: Bearer <token>.
// Derivation stays inside this business/provider binding; no credential is
// copied into API responses, logs, or another tenant's configuration.
function greenWebhookToken(instance) {
    const master = String(process.env.GREEN_API_WEBHOOK_MASTER_KEY || instance?.greenApiToken || '').trim();
    if (master.length < 16 || !instance?.id || !instance.greenApiInstance) throw new Error('WHATSAPP_NOT_CONFIGURED');
    return crypto.createHmac('sha256', master)
        .update(`ava:green-api:webhook:v1:${instance.id}:${instance.greenApiInstance}`).digest('hex');
}

function verifyGreenWebhook(req, instance) {
    if (!instance || String(req.body?.instanceData?.idInstance || '') !== String(instance.greenApiInstance)) return false;
    try {
        const expected = `Bearer ${greenWebhookToken(instance)}`;
        const actual = String(req.headers?.authorization || '');
        return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
    } catch (_) { return false; }
}

async function ensureWebhook(instance) {
    let url;
    try {
        const base = new URL(process.env.WHATSAPP_CRM_PUBLIC_URL || process.env.PUBLIC_BASE_URL || '');
        if (base.protocol !== 'https:' || base.username || base.password) return failure('WHATSAPP_NOT_CONFIGURED');
        url = new URL('/api/webhook/openwa', base).href;
        const secret = signingSecret(instance);
        const result = await Gateway.setupWebhook(instance.openWaUrl, instance.openWaApiKey, instance.openWaSessionId, url, secret);
        return result.success ? { success: true } : failure();
    } catch (_) { return failure('WHATSAPP_NOT_CONFIGURED'); }
}

async function connectOnce(id) {
    let instance = await DB.getInstance(id);
    if (!instance || instance.isActive === 0) return failure('BUSINESS_NOT_FOUND', 404);
    if (instance.openWaSessionId && DB.db.prepare('SELECT id FROM instances WHERE openWaSessionId=? AND id<>?').get(instance.openWaSessionId, id)) {
        return failure('WHATSAPP_SESSION_SCOPE', 409);
    }
    let state = instance.openWaSessionId
        ? await Gateway.getState(instance.openWaUrl, instance.openWaApiKey, instance.openWaSessionId)
        : { success: false, statusCode: 404 };
    if (!state.success && state.statusCode !== 404) return failure();
    const blocked = stateFailure(state.data);
    if (blocked) return blocked;
    if (!state.success) {
        const created = await Gateway.createSession(instance.openWaUrl, instance.openWaApiKey, `ava-business-${id}`);
        if (!created.success || !created.data?.id) return failure();
        await DB.updateInstance(id, { openWaSessionId: created.data.id });
        instance = { ...instance, openWaSessionId: created.data.id };
        state = { success: true, data: { rawStatus: 'created', engineLoaded: false } };
    }
    const hook = await ensureWebhook(instance);
    if (!hook.success) return hook;
    const status = state.data?.rawStatus;
    if (state.data?.engineLoaded === false || ['created', 'disconnected', 'failed', 'action_required'].includes(status)) {
        const started = await Gateway.startSession(instance.openWaUrl, instance.openWaApiKey, instance.openWaSessionId);
        if (!started.success) return failure();
    }
    const qr = await getQRResult(instance);
    return { ...qr, session_id: instance.openWaSessionId };
}

function connect(businessId) {
    if (!/^[1-9]\d*$/.test(String(businessId)) || !Number.isSafeInteger(Number(businessId))) return Promise.resolve(failure('BUSINESS_NOT_FOUND', 404));
    const id = Number(businessId);
    if (!pending.has(id)) {
        const operation = connectOnce(id).catch(() => failure()).finally(() => pending.delete(id));
        pending.set(id, operation);
    }
    return pending.get(id);
}

async function replaceOnce(id, expectedSessionId) {
    const instance = await DB.getInstance(id);
    if (!instance || instance.isActive === 0) return failure('BUSINESS_NOT_FOUND', 404);
    if (!expectedSessionId || instance.openWaSessionId !== expectedSessionId) return failure('WHATSAPP_CONNECTION_CHANGED', 409);
    if (DB.db.prepare('SELECT id FROM instances WHERE openWaSessionId=? AND id<>?').get(expectedSessionId, id)) {
        return failure('WHATSAPP_SESSION_SCOPE', 409);
    }
    const state = await Gateway.getState(instance.openWaUrl, instance.openWaApiKey, expectedSessionId);
    if (!state.success && state.statusCode !== 404) return failure();
    // Create the replacement before stopping a working number. Never delete its
    // provider history or CRM messages; the old session remains a stopped archive.
    // OpenWA limits names to 50 characters. UUIDs make even a one-digit
    // business ID exceed that limit and prevent replacement before QR starts.
    const created = await Gateway.createSession(instance.openWaUrl, instance.openWaApiKey,
        `ava-business-${id}-${crypto.randomBytes(10).toString('hex')}`);
    if (!created.success || !created.data?.id) return failure();
    const next = { ...instance, openWaSessionId: created.data.id };
    if (!(await ensureWebhook(next)).success) return failure();
    if (state.success && state.data?.engineLoaded !== false) {
        if (!(await Gateway.stopSession(instance.openWaUrl, instance.openWaApiKey, expectedSessionId)).success) return failure();
    }
    const changed = DB.db.prepare('UPDATE instances SET openWaSessionId=?, openWaStatus=NULL WHERE id=? AND openWaSessionId=? AND isActive=1')
        .run(next.openWaSessionId, id, expectedSessionId);
    if (changed.changes !== 1) return failure('WHATSAPP_CONNECTION_CHANGED', 409);
    return connectOnce(id);
}

function replaceConnection(businessId, expectedSessionId) {
    if (!/^[1-9]\d*$/.test(String(businessId)) || !Number.isSafeInteger(Number(businessId))) return Promise.resolve(failure('BUSINESS_NOT_FOUND', 404));
    const id = Number(businessId);
    if (pending.has(id)) return Promise.resolve(failure('WHATSAPP_BUSY', 409));
    const operation = replaceOnce(id, expectedSessionId).catch(() => failure()).finally(() => pending.delete(id));
    pending.set(id, operation);
    return operation;
}

module.exports = { connect, replaceConnection, ensureWebhook, signingSecret, verifyWebhook, greenWebhookToken, verifyGreenWebhook, failure, stateFailure, getQRResult };
