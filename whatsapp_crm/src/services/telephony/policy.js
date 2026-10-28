'use strict';
const LIMITS = Object.freeze({ numbers: 3, install: 150000, monthly: 50000, dailySeconds: 1800,
    maxCallSeconds: 300, quoteMs: 120000, graceMs: 7 * 86400000, warningMs: 3 * 86400000 });
function fail(code, statusCode = 400) { throw Object.assign(new Error(code), { code, statusCode }); }
function did(value) {
    let number = String(value ?? '').replace(/[+()\s-]/g, '');
    if (/^8\d{10}$/.test(number)) number = '7' + number.slice(1);
    if (/^\d{10}$/.test(number)) number = '7' + number;
    if (!/^7\d{10}$/.test(number)) fail('TELEPHONY_NUMBER_INVALID');
    return number;
}
// Convert decimal prices without floating point rounding or absent=>free coercion.
function kopecks(value) {
    if (!['string', 'number'].includes(typeof value)) fail('TELEPHONY_PRICE_INVALID');
    const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(value));
    if (!match) fail('TELEPHONY_PRICE_INVALID');
    return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}
function pilot(businessId, env = process.env) {
    return env.AVA_TELEPHONY_PURCHASE_ENABLED === 'true' && String(env.AVA_TELEPHONY_PILOT_BUSINESSES || '')
        .split(',').map(x => x.trim()).includes(String(businessId));
}
function assertPilot(businessId) { if (!pilot(businessId)) fail('TELEPHONY_PILOT_DISABLED', 409); }
function day(now = Date.now()) { return new Date(now + 3 * 3600000).toISOString().slice(0, 10); }
function fields(body, allowed) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k)))
        fail('TELEPHONY_INPUT_INVALID');
}
module.exports = { LIMITS, fail, did, kopecks, pilot, assertPilot, day, fields };
