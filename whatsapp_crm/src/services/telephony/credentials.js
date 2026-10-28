'use strict';
const crypto = require('crypto');
const { fail } = require('./policy');
function key() {
    const value = process.env.AVA_TELEPHONY_MASTER_KEY || '';
    if (!/^[a-f\d]{64}$/i.test(value)) fail('TELEPHONY_VAULT_NOT_CONFIGURED', 503);
    return Buffer.from(value, 'hex');
}
function scope(phone) { return Buffer.from(`ava-phone:v1:${phone.businessId}:${phone.id}:${phone.sipResourceId}`); }
function encrypt(value, phone) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    cipher.setAAD(scope(phone));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}
function decrypt(value, phone) {
    try {
        const bytes = Buffer.from(value, 'base64url'), decipher = crypto.createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
        decipher.setAAD(scope(phone)); decipher.setAuthTag(bytes.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    } catch (_) { fail('TELEPHONY_VAULT_READ_FAILED', 503); }
}
module.exports = { key, encrypt, decrypt };
