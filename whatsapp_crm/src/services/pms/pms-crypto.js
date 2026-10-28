const crypto = require('crypto');

const VERSION = 'v1';

function masterKey() {
    const raw = String(process.env.PMS_CREDENTIALS_MASTER_KEY || '').trim();
    if (!raw) {
        const error = new Error('PMS_CREDENTIALS_MASTER_KEY is not configured');
        error.code = 'PMS_MASTER_KEY_MISSING';
        throw error;
    }

    let key;
    if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
    else {
        try { key = Buffer.from(raw, 'base64'); } catch (_) { key = Buffer.alloc(0); }
    }
    if (key.length !== 32) {
        const error = new Error('PMS_CREDENTIALS_MASTER_KEY must be 32 bytes (hex or base64)');
        error.code = 'PMS_MASTER_KEY_INVALID';
        throw error;
    }
    return key;
}

function encryptJson(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
    const plaintext = Buffer.from(JSON.stringify(value || {}), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptJson(value) {
    const [version, ivRaw, tagRaw, ciphertextRaw] = String(value || '').split('.');
    if (version !== VERSION || !ivRaw || !tagRaw || !ciphertextRaw) {
        const error = new Error('Encrypted PMS credential payload is invalid');
        error.code = 'PMS_CREDENTIALS_INVALID';
        throw error;
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
        decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext);
}

function randomOpaqueToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function hashOpaqueToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function safeEqualHash(expectedHex, token) {
    const actual = Buffer.from(hashOpaqueToken(token), 'hex');
    const expected = Buffer.from(String(expectedHex || ''), 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = { encryptJson, decryptJson, randomOpaqueToken, hashOpaqueToken, safeEqualHash };
