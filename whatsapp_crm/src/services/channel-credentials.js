'use strict';

const crypto = require('crypto');

const SECRET_FIELDS = Object.freeze([
    'telegramBotToken', 'emailSmtpPass', 'emailImapPass', 'vkGroupToken', 'maxBotToken'
]);
const CREDENTIAL_FIELDS = Object.freeze([...SECRET_FIELDS, 'instagramAccessToken']);
const PREFIX = 'enc:v1:';

function masterKey() {
    const configured = process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
    if (!configured) return null;
    let key;
    if (/^[0-9a-fA-F]{64}$/.test(configured)) key = Buffer.from(configured, 'hex');
    else if (/^[A-Za-z0-9+/]{43}=$/.test(configured)) key = Buffer.from(configured, 'base64');
    if (!key || key.length !== 32) {
        throw new Error('CHANNEL_CREDENTIALS_MASTER_KEY must be 32 bytes encoded as hex or base64');
    }
    return key;
}

function isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
}

function aad(instanceId, field) {
    if (!Number.isSafeInteger(Number(instanceId)) || Number(instanceId) < 1 || !CREDENTIAL_FIELDS.includes(field)) {
        throw new Error('Invalid channel credential scope');
    }
    return Buffer.from(`ava-channel-credential:v1:${Number(instanceId)}:${field}`, 'utf8');
}

function encrypt(value, instanceId, field) {
    if (value == null || value === '') return value;
    const key = masterKey();
    if (!key) throw new Error('CHANNEL_CREDENTIALS_MASTER_KEY is required to save channel credentials');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(instanceId, field));
    const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`;
}

function decrypt(value, instanceId, field) {
    if (!isEncrypted(value)) return value; // Legacy plaintext; migrated by updateInstance.
    const key = masterKey();
    if (!key) throw new Error('CHANNEL_CREDENTIALS_MASTER_KEY is required to read encrypted channel credentials');
    try {
        const payload = Buffer.from(value.slice(PREFIX.length), 'base64url');
        if (payload.length < 29) throw new Error('invalid encrypted credential');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
        decipher.setAAD(aad(instanceId, field));
        decipher.setAuthTag(payload.subarray(12, 28));
        return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
    } catch (_) {
        throw new Error('Channel credential decryption failed');
    }
}

function decryptInstance(row) {
    if (!row) return row;
    const result = { ...row };
    for (const field of SECRET_FIELDS) {
        if (result[field] !== undefined) result[field] = decrypt(result[field], result.id, field);
    }
    return result;
}

module.exports = { SECRET_FIELDS, masterKey, isEncrypted, encrypt, decrypt, decryptInstance };
