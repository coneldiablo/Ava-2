const SECRET_PATTERNS = [
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
    /([?&](?:token|password|secret|api[_-]?key)=)[^&#\s]+/gi,
    /(["']?(?:token|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
    /(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi,
];

function redact(value, limit = 800) {
    let text = String(value?.message || value || '').replace(/[\r\n\t]+/g, ' ');
    for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '$1[REDACTED]');
    for (const secret of [
        process.env.PMS_CREDENTIALS_MASTER_KEY,
        process.env.CRM_SERVICE_API_TOKEN,
        process.env.WHATSAPP_CRM_API_TOKEN,
        ...Object.entries(process.env).filter(([name]) => /(?:TOKEN|PASSWORD|SECRET|API_KEY|MASTER_KEY)/i.test(name)).map(([,value]) => value),
    ]) {
        if (secret && secret.length >= 6) text = text.split(secret).join('[REDACTED]');
    }
    text = text.replace(/\s+/g, ' ').trim();
    return text.slice(0, Math.max(1, Number(limit) || 800));
}

function digits(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizePhone(value) {
    let result = digits(value);
    if (result.length === 11 && result.startsWith('8')) result = `7${result.slice(1)}`;
    return result;
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase().slice(0, 254);
}

function safeId(value) {
    return String(value ?? '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 160);
}

function correlationId(value) {
    return safeId(value) || `pms_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function isoNow() { return new Date().toISOString(); }

module.exports = { redact, digits, normalizePhone, normalizeEmail, safeId, correlationId, parseJson, isoNow };
