const crypto = require('crypto');

const VERSION = 'v2';
const FIELDS = new Set(['apiKeyEncrypted', 'webhookSecretEncrypted', 'webhookTokenEncrypted']);

function context(businessId, field = 'apiKeyEncrypted') {
    const id = Number(businessId);
    if (!Number.isSafeInteger(id) || id < 1 || !FIELDS.has(field)) {
        throw Object.assign(new Error('Twenty credential scope is required'), { code: 'TWENTY_CREDENTIAL_SCOPE_REQUIRED' });
    }
    return { businessId: id, field };
}

function aad(scope) {
    const checked = context(scope?.businessId, scope?.field);
    return Buffer.from(`ava:twenty:${checked.businessId}:${checked.field}:${VERSION}`);
}

function masterKey() {
    const raw = String(process.env.TWENTY_CREDENTIALS_MASTER_KEY || '').trim();
    if (!raw) {
        const error = new Error('TWENTY_CREDENTIALS_MASTER_KEY is not configured');
        error.code = 'TWENTY_MASTER_KEY_MISSING';
        throw error;
    }

    let key = Buffer.alloc(0);
    if (/^[0-9a-f]{64}$/i.test(raw)) {
        key = Buffer.from(raw, 'hex');
    } else {
        try { key = Buffer.from(raw, 'base64'); } catch (_) { key = Buffer.alloc(0); }
    }
    if (key.length !== 32) {
        const error = new Error('TWENTY_CREDENTIALS_MASTER_KEY must be 32 bytes (hex or base64)');
        error.code = 'TWENTY_MASTER_KEY_INVALID';
        throw error;
    }
    return key;
}

function encryptJson(value, scope) {
    const associatedData = aad(scope);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
    cipher.setAAD(associatedData);
    const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(value || {}), 'utf8')),
        cipher.final(),
    ]);
    return [
        VERSION,
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ciphertext.toString('base64url'),
    ].join('.');
}

function decryptJson(value, scope, { allowLegacy = false } = {}) {
    const associatedData = aad(scope);
    const parts = String(value || '').split('.');
    const [version, ivRaw, tagRaw, ciphertextRaw] = parts;
    if (parts.length !== 4 || (version !== VERSION && !(allowLegacy && version === 'v1')) || !ivRaw || !tagRaw || !ciphertextRaw) {
        const error = new Error('Encrypted Twenty credential payload is invalid');
        error.code = 'TWENTY_CREDENTIALS_INVALID';
        throw error;
    }
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivRaw, 'base64url'));
        if (version === VERSION) decipher.setAAD(associatedData);
        decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
            decipher.final(),
        ]).toString('utf8');
        return JSON.parse(plaintext);
    } catch (_) {
        throw Object.assign(new Error('Twenty credential authentication failed'), { code: 'TWENTY_CREDENTIALS_INVALID' });
    }
}

function migrateLegacyCredentials(db) {
    // Only this migration reads unbound v1. All runtime reads require v2 AAD.
    // The complete migration rolls back if any ciphertext cannot be decrypted.
    db.transaction(() => {
        for (const row of db.prepare('SELECT businessId,apiKeyEncrypted,webhookSecretEncrypted,webhookTokenEncrypted FROM twenty_workspace_links').all()) {
            for (const field of FIELDS) {
                if (!String(row[field] || '').startsWith('v1.')) continue;
                const scope = context(row.businessId, field);
                const value = encryptJson(decryptJson(row[field], scope, { allowLegacy: true }), scope);
                db.prepare(`UPDATE twenty_workspace_links SET ${field}=? WHERE businessId=? AND ${field}=?`).run(value, row.businessId, row[field]);
            }
        }
    }).immediate();
}

function randomOpaqueToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function timingSafeHexEqual(leftHex, rightHex) {
    if (!/^[0-9a-f]+$/i.test(String(leftHex || '')) || !/^[0-9a-f]+$/i.test(String(rightHex || ''))) {
        return false;
    }
    const left = Buffer.from(String(leftHex), 'hex');
    const right = Buffer.from(String(rightHex), 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyWebhookSignature({ secret, timestamp, rawBody, signature }) {
    const received = String(signature || '').trim().replace(/^(sha256=|v1=)/i, '');
    const expected = crypto
        .createHmac('sha256', String(secret || ''))
        .update(`${timestamp}:${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '')}`)
        .digest('hex');
    return timingSafeHexEqual(expected, received);
}

module.exports = {
    context,
    migrateLegacyCredentials,
    encryptJson,
    decryptJson,
    randomOpaqueToken,
    sha256,
    timingSafeHexEqual,
    verifyWebhookSignature,
};
