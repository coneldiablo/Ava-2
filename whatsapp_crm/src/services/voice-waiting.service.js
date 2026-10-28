'use strict';

const DEFAULT = Object.freeze({ enabled: true, phrases: Object.freeze(['Секунду, пожалуйста.']), afterSeconds: 3, repeatSeconds: 15, maxMessages: 1 });
function normalize(value = DEFAULT) {
    if (value === null) value = DEFAULT;
    const invalid = () => Object.assign(new Error('INVALID_VOICE_WAITING'), { code: 'INVALID_VOICE_WAITING', statusCode: 400 });
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'afterSeconds,enabled,maxMessages,phrases,repeatSeconds'
        || typeof value.enabled !== 'boolean' || !Array.isArray(value.phrases) || value.phrases.length < 1 || value.phrases.length > 5
        || value.phrases.some(p => typeof p !== 'string' || !p.trim() || p.trim().length > 160 || /[\x00-\x1f\x7f]/.test(p))
        || typeof value.afterSeconds !== 'number' || !Number.isFinite(value.afterSeconds) || value.afterSeconds < 1 || value.afterSeconds > 15
        || typeof value.repeatSeconds !== 'number' || !Number.isFinite(value.repeatSeconds) || value.repeatSeconds < 5 || value.repeatSeconds > 60
        || !Number.isInteger(value.maxMessages) || value.maxMessages < 1 || value.maxMessages > 2) throw invalid();
    return { enabled: value.enabled, phrases: value.phrases.map(p => p.trim()), afterSeconds: value.afterSeconds, repeatSeconds: value.repeatSeconds, maxMessages: value.maxMessages };
}
function parse(value) { try { return normalize(value); } catch { return normalize(); } }
module.exports = { normalize, parse };
