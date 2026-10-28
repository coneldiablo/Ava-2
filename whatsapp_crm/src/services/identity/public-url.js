'use strict';

let cachedValue;
let cachedEnvironment;
let cachedHref;

function getPublicUrl() {
    const value = String(process.env.WHATSAPP_CRM_PUBLIC_URL || '').trim();
    const environment = process.env.NODE_ENV;
    if (value === cachedValue && environment === cachedEnvironment && cachedHref) {
        return new URL(cachedHref);
    }

    let url;
    try { url = new URL(value); } catch (_) { /* Reject with a fixed error below. */ }
    const localHttp = (environment === 'test' || environment === 'development')
        && ['localhost', '127.0.0.1', '[::1]'].includes(url?.hostname);
    if (!url || (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHttp))
        || !url.hostname || url.username || url.password || url.search || url.hash
        || url.pathname !== '/') {
        throw Object.assign(new Error('WHATSAPP_CRM_PUBLIC_URL must be a valid HTTPS origin (local HTTP is allowed only in test/development)'),
            { code: 'PUBLIC_URL_INVALID', statusCode: 503 });
    }

    cachedValue = value;
    cachedEnvironment = environment;
    cachedHref = url.href;
    return new URL(cachedHref);
}

module.exports = { getPublicUrl };
