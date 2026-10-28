'use strict';
// One deployment, one upstream. No host-based fallback or bootstrap API.
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { tokenPattern, deny } = require('./store.cjs');
const TwentyLogout = require('./twenty-logout.cjs');
const TwentyEntry = require('./twenty-entry.cjs');
const COOKIE = '__Host-ava_module';
const FLOW = '__Host-ava_flow';
const RUNTIME_PREFIX = '/v1/onyx-runtime';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const runtimeFailure = (code = 'AVA_ONYX_RUNTIME_DENIED', status = 403) => Object.assign(new Error(code), { code, status });
const samePrincipal = (a, b) => ['bindingId','businessId','module','nativeScope','nativeUserId','userId','subject','role','revision']
    .every(key => a[key] === b[key]) && b.expiresAt > Date.now();
const publicUrl = value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
        || url.pathname !== '/' || url.search || url.hash || !url.hostname.endsWith('.meludtech.tech')) throw deny();
    return url;
};
function cookies(req) {
    const result = new Map();
    for (const part of (req.headers.cookie || '').split(';')) {
        const at = part.indexOf('='); if (at < 0) continue;
        const name = part.slice(0, at).trim();
        if (result.has(name)) throw deny();
        result.set(name, part.slice(at + 1).trim());
    }
    return result;
}
function form(req) {
    return new Promise((resolve, reject) => {
        if (!/^application\/x-www-form-urlencoded(?:;.*)?$/i.test(req.headers['content-type'] || '')) return reject(deny());
        let length = 0; const chunks = [];
        req.on('data', chunk => { length += chunk.length; if (length > 4096) { reject(deny()); req.destroy(); } else chunks.push(chunk); });
        req.on('error', () => reject(deny()));
        req.on('end', () => {
            const data = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
            if ([...data.keys()].sort().join(',') !== 'code,state' || !tokenPattern.test(data.get('code') || '')
                || !tokenPattern.test(data.get('state') || '')) return reject(deny());
            resolve(Object.fromEntries(data));
        });
    });
}
function allowedPath(raw) {
    if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) throw deny();
    let path = raw.split('?')[0];
    for (let i = 0; i < 3; i++) {
        const decoded = decodeURIComponent(path);
        if (decoded === path) break;
        path = decoded;
    }
    if (/[\\\x00-\x1f%]/.test(path) || path.includes('//') || path.split('/').some(item => item === '.' || item === '..')
        || /^\/(?:api\/)?(?:ava-internal|v1|metrics|debug)(?:\/|$)/i.test(path)) throw deny();
    return path;
}
function nativeAccountSurface(module, path) {
    if (module !== 'onyx') return false;
    // Pinned v4.7.0 routers. Ordinary /me, preferences, files and chat remain
    // available; native self-registration/password/PATs cannot create a second
    // credential that outlives AVA membership revocation.
    return /^\/(?:api\/)?(?:auth|users|password|user\/pats|admin\/api-key)(?:\/|$)/i.test(path)
        || /^\/(?:api\/)?manage\/(?:admin\/)?users(?:\/|$)/i.test(path)
        || /^\/(?:api\/)?manage\/admin\/(?:deactivate-user|activate-user|delete-user|remove-invited-user)(?:\/|$)/i.test(path);
}
function runtimeRoute(method, raw) {
    if (typeof raw !== 'string' || raw.includes('?') || raw.includes('#')) return null;
    const routes = {
        [`POST ${RUNTIME_PREFIX}/chat/create-chat-session`]: { upstream: '/chat/create-chat-session', body: 'create' },
        [`POST ${RUNTIME_PREFIX}/chat/send-chat-message`]: { upstream: '/chat/send-chat-message', body: 'send' },
    };
    const fixed = routes[`${method} ${raw}`];
    if (fixed) return fixed;
    const match = new RegExp(`^(GET|POST)${RUNTIME_PREFIX}/chat/(get-chat-session|stop-chat-session|end-incognito-session)/(${UUID.source.slice(1, -1)})$`, 'i').exec(`${method}${raw}`);
    if (!match) return null;
    const [, actualMethod, action, sessionId] = match;
    if ((action === 'get-chat-session') !== (actualMethod === 'GET')) return null;
    return { upstream: `/chat/${action}/${sessionId}`, body: actualMethod === 'GET' ? 'none' : 'empty' };
}
function runtimeBody(kind, value) {
    const keys = value => Object.keys(value).sort().join(',');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw deny();
    if (kind === 'none' || kind === 'empty') {
        if (keys(value)) throw deny();
        return value;
    }
    if (kind === 'create') {
        if (keys(value) !== 'incognito,persona_id' || !Number.isSafeInteger(value.persona_id) || value.persona_id < 1 || value.incognito !== true) throw deny();
        return value;
    }
    const allowed = new Set(['chat_session_id','message','stream','include_citations','allowed_tool_ids','forced_tool_id','internal_search_filters','mcp_headers']);
    if (Object.keys(value).some(key => !allowed.has(key)) || !UUID.test(value.chat_session_id || '')
        || typeof value.message !== 'string' || !value.message.trim() || Buffer.byteLength(value.message) > 64 * 1024
        || value.stream !== false || (value.include_citations !== undefined && typeof value.include_citations !== 'boolean')) throw deny();
    if (value.allowed_tool_ids !== undefined && (!Array.isArray(value.allowed_tool_ids) || value.allowed_tool_ids.length > 32
        || value.allowed_tool_ids.some(id => !Number.isSafeInteger(id) || id < 1))) throw deny();
    if (value.forced_tool_id !== undefined && (!Number.isSafeInteger(value.forced_tool_id) || value.forced_tool_id < 1
        || !value.allowed_tool_ids?.includes(value.forced_tool_id))) throw deny();
    const filters = value.internal_search_filters;
    if (filters !== undefined && (!filters || typeof filters !== 'object' || Array.isArray(filters)
        || Object.keys(filters).some(key => !['document_set','tags'].includes(key))
        || (filters.document_set !== undefined && (!Array.isArray(filters.document_set) || filters.document_set.length > 8
            || filters.document_set.some(item => typeof item !== 'string' || !item || item.length > 256)))
        || (filters.tags !== undefined && (!Array.isArray(filters.tags) || filters.tags.length > 16 || filters.tags.some(tag => !tag || typeof tag !== 'object'
            || Array.isArray(tag) || keys(tag) !== 'tag_key,tag_value' || typeof tag.tag_key !== 'string' || typeof tag.tag_value !== 'string'
            || !tag.tag_key || !tag.tag_value || tag.tag_key.length > 128 || tag.tag_value.length > 512))))) throw deny();
    const headers = value.mcp_headers;
    if (headers !== undefined && (!headers || typeof headers !== 'object' || Array.isArray(headers)
        || keys(headers) !== 'X-AVA-Execution' || !tokenPattern.test(headers['X-AVA-Execution'] || ''))) throw deny();
    if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) throw deny();
    return value;
}
function readRuntimeJson(req, maxBytes = 256 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0; const chunks = [];
        req.on('data', chunk => { size += chunk.length; if (size > maxBytes) { req.destroy(); reject(deny()); } else chunks.push(chunk); });
        req.on('error', () => reject(deny()));
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(deny()); }
        });
    });
}
function sameRuntimePrincipal(value, config) {
    const keys = value && Object.keys(value).sort().join(',');
    return value && (keys === 'businessId,nativeScope,nativeUserId,servicePrincipalId,subject'
        || (keys === 'businessId,correlation_id,nativeScope,nativeUserId,servicePrincipalId,subject'
            && CANONICAL_UUID.test(value.correlation_id || '')))
        && value.businessId === config.businessId && value.nativeScope === config.nativeScope
        && UUID.test(value.servicePrincipalId || '') && UUID.test(value.nativeUserId || '')
        && typeof value.subject === 'string' && value.subject.length > 0 && value.subject.length <= 256;
}
function sameRuntimeIdentity(left, right) {
    return Boolean(left && right) && left.businessId === right.businessId && left.nativeScope === right.nativeScope
        && left.servicePrincipalId === right.servicePrincipalId && left.nativeUserId === right.nativeUserId
        && left.subject === right.subject;
}
function createGateway({ config, store, broker, native, nativePeerSecret, runtimePeerSecret }) {
    const origin = publicUrl(config.publicOrigin), ava = publicUrl(config.avaOrigin);
    const upstream = new URL(config.upstreamOrigin);
    if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password
        || upstream.pathname !== '/' || upstream.search || upstream.hash || !/^[0-9a-f-]{36}$/.test(config.adapterId)
        || !/^[0-9a-f-]{36}$/.test(config.deploymentId) || !['twenty','onyx'].includes(config.module)
        || typeof nativePeerSecret !== 'function') throw deny();
    const secureCookie = (name, value, seconds) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, seconds)}`;
    async function authorized(req) {
        const session = store.session(cookies(req).get(COOKIE));
        const current = await broker('/v1/authorize', { sessionHandle: session.sessionHandle });
        if (!samePrincipal(session, current)) { store.revoke(session.bindingId); throw deny(); }
        return session;
    }
    function verifyGrant(grant) {
        if (grant.businessId !== config.businessId || grant.module !== config.module || grant.nativeScope !== config.nativeScope
            || !['hotel_owner','manager'].includes(grant.role) || !Number.isSafeInteger(grant.revision)
            || !/^[0-9a-f-]{36}$/.test(grant.userId || '') || !/^[0-9a-f-]{36}$/.test(grant.bindingId || '')
            || !tokenPattern.test(grant.sessionHandle || '') || grant.expiresAt <= Date.now()) throw deny();
    }
    function forwardHeaders(req, session, upgrade = false) {
        const result = {};
        const excluded = new Set(['host','cookie','authorization','connection','upgrade','forwarded','proxy-authorization','proxy-connection',
            'keep-alive','transfer-encoding','te','trailer']);
        for (const [key, value] of Object.entries(req.headers)) {
            if (!excluded.has(key) && !key.startsWith('x-ava-') && !key.startsWith('x-forwarded-')) result[key] = value;
        }
        result.host = origin.host;
        result.cookie = session.nativeCookie;
        result['x-forwarded-proto'] = 'https';
        result['x-forwarded-host'] = origin.host;
        result['x-forwarded-for'] = req.socket.remoteAddress;
        const peerSecret = nativePeerSecret();
        if (!tokenPattern.test(peerSecret || '')) throw deny();
        result['x-ava-native-peer'] = peerSecret;
        result['x-ava-native-binding'] = session.bindingId;
        if (upgrade) { result.connection = 'Upgrade'; result.upgrade = 'websocket'; }
        return result;
    }
    function responseHeaders(headers, upgrade = false) {
        const result = { ...headers };
        for (const key of ['set-cookie','server','x-powered-by','connection','keep-alive','transfer-encoding','trailer']) delete result[key];
        // A native redirect cannot move credentials or files outside this guard.
        if (result.location && new URL(result.location, origin).origin !== origin.origin) throw deny();
        result['cache-control'] = 'no-store';
        result['referrer-policy'] = 'no-referrer';
        result['x-content-type-options'] = 'nosniff';
        result['x-frame-options'] = 'DENY';
        if (upgrade) { result.connection = 'Upgrade'; result.upgrade = 'websocket'; }
        return result;
    }
    function continuousCheck(session, stop) {
        let busy = false;
        const timer = setInterval(async () => {
            if (busy) return;
            busy = true;
            try {
                const current = await broker('/v1/authorize', { sessionHandle: session.sessionHandle });
                if (!samePrincipal(session, current)) throw deny();
            } catch (_) { store.revoke(session.bindingId); stop(); }
            finally { busy = false; }
        }, 1000);
        timer.unref();
        return () => clearInterval(timer);
    }
    const transport = upstream.protocol === 'https:' ? https : http;
    const server = http.createServer(async (req, res) => {
        const fail = () => {
            if (res.headersSent) return res.destroy();
            res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
            res.end('{"error_code":"AVA_MODULE_ACCESS_DENIED"}');
        };
        try {
            if (req.headers.host !== origin.host) throw deny();
            const path = allowedPath(req.url);
            if (path === '/healthz' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end('{"ok":true}');
            }
            if (path === '/ava-auth/start' && req.method === 'GET') {
                const flow = store.beginFlow();
                const target = new URL('/module-access', ava);
                target.search = new URLSearchParams({ adapter_id: config.adapterId, state: flow.state, code_challenge: flow.challenge }).toString();
                res.writeHead(302, { Location: target.href, 'Set-Cookie': secureCookie(FLOW, flow.cookie, 60),
                    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
            }
            if (path === '/ava-auth/callback' && req.method === 'POST') {
                if (req.headers.origin !== ava.origin) throw deny();
                const fields = await form(req), verifier = store.consumeFlow(fields.state, cookies(req).get(FLOW));
                const grant = await broker('/v1/exchange', { code: fields.code, verifier });
                verifyGrant(grant);
                try {
                    const receipt = await native('/v1/sessions/create', {
                        businessId: config.businessId, deploymentId: config.deploymentId, bindingId: grant.bindingId,
                        userId: grant.userId, nativeUserId: grant.nativeUserId, nativeScope: grant.nativeScope,
                        subject: grant.subject, role: grant.role, revision: grant.revision, expiresAt: grant.expiresAt });
                    if (receipt.bindingId !== grant.bindingId || receipt.nativeUserId !== grant.nativeUserId
                        || receipt.nativeScope !== grant.nativeScope || receipt.userId !== grant.userId
                        || receipt.businessId !== config.businessId || receipt.deploymentId !== config.deploymentId) throw deny();
                    if (!samePrincipal(grant, await broker('/v1/authorize', { sessionHandle: grant.sessionHandle }))) throw deny();
                    const value = store.saveSession({ grant, nativeCookie: receipt.nativeCookie, nativeSessionId: receipt.nativeSessionId });
                    res.writeHead(303, { Location: config.module === 'twenty' ? TwentyEntry.READY_PATH : '/', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
                        'Set-Cookie': [secureCookie(COOKIE, value, Math.floor((grant.expiresAt - Date.now()) / 1000)), secureCookie(FLOW, '', 0)] });
                    return res.end();
                } catch (_) {
                    // A lost native response is reconciled by bindingId, not by minting a second identity.
                    await broker('/v1/logout', { sessionHandle: grant.sessionHandle }).catch(() => {});
                    await native('/v1/sessions/revoke', { bindingId: grant.bindingId }).catch(() => {});
                    throw deny();
                }
            }
            // Twenty's native signOut clears the module cookie before routing
            // the browser to its standard sign-in path.  Keep this exact,
            // unauthenticated GET as a fixed return to AVA; all API and POST
            // paths continue through the authenticated boundary below.
            if (config.module === 'twenty' && path === '/welcome' && req.method === 'GET') {
                res.writeHead(302, {
                    Location: ava.origin,
                    'Cache-Control': 'no-store',
                    'Referrer-Policy': 'no-referrer',
                });
                return res.end();
            }
            const nativeLogout = config.module === 'onyx' && path === '/api/auth/logout';
            if (path.startsWith('/ava-auth/') || nativeLogout) {
                if (config.module === 'twenty' && path === TwentyEntry.READY_PATH && req.method === 'GET') {
                    if (req.headers['sec-fetch-site'] === 'cross-site'
                        || (req.headers.origin && req.headers.origin !== origin.origin)) throw deny();
                    await authorized(req);
                    return TwentyEntry.writeReady(res);
                }
                if (config.module === 'twenty' && path === TwentyEntry.SCRIPT_PATH && req.method === 'GET') {
                    if (req.headers['sec-fetch-site'] === 'cross-site'
                        || (req.headers.origin && req.headers.origin !== origin.origin)) throw deny();
                    await authorized(req);
                    return TwentyEntry.writeEntryScript(res);
                }
                if (path === '/ava-auth/context' && req.method === 'GET') {
                    if (req.headers['sec-fetch-site'] === 'cross-site'
                        || (req.headers.origin && req.headers.origin !== origin.origin)) throw deny();
                    const session = await authorized(req);
                    const context = await broker('/v1/navigation', { sessionHandle: session.sessionHandle });
                    if (context.business_id !== config.businessId || context.module !== config.module) throw deny();
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                    return res.end(JSON.stringify({ ...context, ava_url: ava.origin, logout_path: '/ava-auth/logout' }));
                }
                if ((!nativeLogout && path !== '/ava-auth/logout') || req.method !== 'POST' || req.headers.origin !== origin.origin) throw deny();
                const session = store.session(cookies(req).get(COOKIE));
                await broker('/v1/logout-all', { sessionHandle: session.sessionHandle });
                store.revoke(session.bindingId);
                await native('/v1/sessions/revoke', { bindingId: session.bindingId }).catch(() => {});
                res.writeHead(nativeLogout ? 204 : 303, { ...(nativeLogout ? {} : {Location: ava.origin}), 'Cache-Control': 'no-store', 'Set-Cookie': secureCookie(COOKIE, '', 0) });
                return res.end();
            }
            let bufferedBody = null;
            let twentySignOut = false;
            let twentySignOutAliases = [];
            if (config.module === 'twenty' && (path === '/graphql' || path === '/metadata') && req.method === 'POST') {
                if (req.headers.origin !== origin.origin || req.headers['sec-fetch-site'] === 'cross-site') throw deny();
                const inspected = await TwentyLogout.inspect(req);
                bufferedBody = inspected.body || null;
                if (inspected.ambiguous) throw deny();
                twentySignOut = inspected.matched;
                twentySignOutAliases = inspected.aliases || [];
            }
            // Read-only metadata is needed by Onyx's authenticated UI. It
            // still goes through the normal broker/session checks below.
            const onyxAuthMetadata = config.module === 'onyx' && req.method === 'GET' && path === '/api/auth/type';
            if (nativeAccountSurface(config.module, path) && !onyxAuthMetadata) throw deny();
            if (req.headers['sec-fetch-site'] === 'cross-site'
                || (req.headers.origin && req.headers.origin !== origin.origin)
                || (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin !== origin.origin)
                || Number(req.headers['content-length'] || 0) > 64 * 1024 * 1024) throw deny();
            const session = await authorized(req);
            if (req.aborted || res.destroyed) throw deny();
            if (twentySignOut) {
                await broker('/v1/logout-all', { sessionHandle: session.sessionHandle });
                store.revoke(session.bindingId);
                let nativeError = false;
                try {
                    const receipt = await native('/v1/sessions/revoke', { bindingId: session.bindingId });
                    if (receipt?.bindingId !== session.bindingId || receipt?.nativeSessionAbsent !== true) throw new Error('native revoke unconfirmed');
                }
                catch (_) { nativeError = true; }
                res.writeHead(nativeError ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                    'Set-Cookie': secureCookie(COOKIE, '', 0) });
                const data = Object.fromEntries(twentySignOutAliases.map(alias => [alias, !nativeError]));
                return res.end(JSON.stringify(nativeError ? { errors: [{ message: 'Sign out could not be confirmed' }], data } : { data }));
            }
            const target = transport.request(new URL(req.url, upstream), { method: req.method, headers: forwardHeaders(req, session) });
            const cancel = () => { target.destroy(); res.destroy(); };
            const clear = continuousCheck(session, cancel);
            target.setTimeout(120000, cancel);
            res.on('close', () => { clear(); target.destroy(); });
            req.on('aborted', cancel);
            let size = 0;
            req.on('data', chunk => { size += chunk.length; if (size > 64 * 1024 * 1024) cancel(); });
            target.on('response', async remote => {
                remote.pause();
                try {
                    if (!samePrincipal(session, await broker('/v1/authorize', { sessionHandle: session.sessionHandle }))) throw deny();
                    res.writeHead(remote.statusCode, responseHeaders(remote.headers));
                    remote.on('error', cancel); remote.pipe(res);
                } catch (_) { remote.destroy(); cancel(); }
            });
            target.on('error', () => { clear(); fail(); });
            if (bufferedBody !== null) target.end(bufferedBody); else req.pipe(target);
        } catch (_) { fail(); }
    });
    server.on('upgrade', async (req, socket, head) => {
        try {
            if (req.headers.host !== origin.host || req.headers.origin !== origin.origin
                || req.headers.upgrade?.toLowerCase() !== 'websocket' || allowedPath(req.url).startsWith('/ava-auth/')
                || nativeAccountSurface(config.module, allowedPath(req.url))) throw deny();
            const session = await authorized(req);
            if (socket.destroyed) throw deny();
            const target = transport.request(new URL(req.url, upstream), { headers: forwardHeaders(req, session, true) });
            const clear = continuousCheck(session, () => { target.destroy(); socket.destroy(); });
            const abort = () => { clear(); target.destroy(); socket.destroy(); };
            target.setTimeout(120000, abort); socket.on('close', abort); target.on('error', abort);
            target.on('response', abort);
            target.on('upgrade', async (response, remote, initial) => {
                try {
                    if (!samePrincipal(session, await broker('/v1/authorize', { sessionHandle: session.sessionHandle }))) throw deny();
                    socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(responseHeaders(response.headers, true))
                        .map(([key, value]) => `${key}: ${value}`).join('\r\n') + '\r\n\r\n');
                    if (head.length) remote.write(head);
                    if (initial.length) socket.write(initial);
                    socket.on('close', () => remote.destroy()); remote.on('error', abort); remote.on('close', abort);
                    socket.pipe(remote); remote.pipe(socket);
                } catch (_) { remote.destroy(); abort(); }
            });
            target.end();
        } catch (_) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
    });
    server.requestTimeout = 120000; server.headersTimeout = 10000; server.maxHeadersCount = 64; server.maxConnections = 256;
    async function cleanupOnce() {
        const leased = await broker('/v1/revocations/lease', {});
        if (!leased.job) return false;
        const { bindingId, leaseToken } = leased.job;
        store.revoke(bindingId);
        let result = 'retry';
        try {
            const receipt = await native('/v1/sessions/revoke', { bindingId });
            if (receipt.bindingId === bindingId && receipt.nativeSessionAbsent === true) result = 'native_session_absent';
        } catch (_) { /* retry is persisted by AVA, never log native errors */ }
        await broker('/v1/revocations/complete', { bindingId, leaseToken, result });
        return result === 'native_session_absent';
    }
    // This listener is deliberately not part of the public HTTP server above.
    // Deployment wiring must bind it only to the AVA runtime network.  Keeping
    // it absent without a separately mounted secret makes an accidental public
    // port expose no machine surface at all.
    let runtimeServer = null;
    if (runtimePeerSecret !== undefined) {
        if (config.module !== 'onyx' || !Number.isSafeInteger(config.revision) || config.revision < 1
            || typeof runtimePeerSecret !== 'function') throw deny();
        let runtimeUpstream;
        try {
            runtimeUpstream = new URL(config.runtimeUpstreamOrigin);
            if (!['http:', 'https:'].includes(runtimeUpstream.protocol) || !runtimeUpstream.hostname || runtimeUpstream.username || runtimeUpstream.password
                || runtimeUpstream.pathname !== '/' || runtimeUpstream.search || runtimeUpstream.hash) throw deny();
            const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(runtimeUpstream.hostname.toLowerCase());
            if (!loopback && !(runtimeUpstream.protocol === 'http:' && runtimeUpstream.hostname === 'api' && runtimeUpstream.port === '8080')) throw deny();
        } catch (_) { throw deny(); }
        const runtimeSecret = () => {
            const value = runtimePeerSecret();
            if (!tokenPattern.test(value || '')) throw deny();
            return value;
        };
        const runtimeReply = (res, status, body) => {
            if (res.destroyed || res.writableEnded) return;
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
            res.end(body);
        };
        const runtimeDenied = (res, error = runtimeFailure()) => runtimeReply(res, Number(error?.status) || 403,
            JSON.stringify({ error_code: error?.code === 'AVA_ONYX_RUNTIME_UPSTREAM_UNAVAILABLE'
                ? 'AVA_ONYX_RUNTIME_UPSTREAM_UNAVAILABLE' : 'AVA_ONYX_RUNTIME_DENIED' }));
        const authenticateRuntime = req => {
            if (req.headers.origin || req.headers.cookie || req.headers.authorization || req.headers['sec-fetch-site']
                || Object.keys(req.headers).some(key => key.startsWith('x-ava-') && key !== 'x-ava-runtime-peer')) throw deny();
            const supplied = req.headers['x-ava-runtime-peer'];
            const expected = runtimeSecret();
            if (typeof supplied !== 'string' || !tokenPattern.test(supplied)
                || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw deny();
        };
        const createRuntimeSession = async (principal, bindingId) => {
            if (!UUID.test(bindingId || '')) throw deny();
            const request = { businessId: config.businessId, deploymentId: config.deploymentId, nativeScope: config.nativeScope,
                userId: principal.servicePrincipalId, subject: principal.subject, role: 'manager', revision: config.revision,
                bindingId, nativeUserId: principal.nativeUserId, expiresAt: Date.now() + 60000 };
            const receipt = await native('/v1/sessions/create', request);
            if (!receipt || receipt.businessId !== request.businessId || receipt.deploymentId !== request.deploymentId
                || receipt.nativeScope !== request.nativeScope || receipt.userId !== request.userId
                || receipt.nativeUserId !== request.nativeUserId || receipt.bindingId !== bindingId
                || typeof receipt.nativeCookie !== 'string' || !/^[A-Za-z0-9_-]+=[A-Za-z0-9._~-]+$/.test(receipt.nativeCookie)
                || typeof receipt.nativeSessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.nativeSessionId)) throw deny();
            return { bindingId, nativeCookie: receipt.nativeCookie };
        };
        const revokeRuntimeSession = async bindingId => {
            const receipt = await native('/v1/sessions/revoke', { bindingId });
            if (!receipt || receipt.bindingId !== bindingId || receipt.nativeSessionAbsent !== true) throw deny();
        };
        const forwardRuntime = (route, body, session, registerCancel) => new Promise((resolve, reject) => {
            const peerSecret = nativePeerSecret();
            if (!tokenPattern.test(peerSecret || '')) return reject(deny());
            let settled = false;
            const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };
            const target = (runtimeUpstream.protocol === 'https:' ? https : http).request(new URL(route.upstream, runtimeUpstream), {
                method: route.body === 'none' ? 'GET' : 'POST',
                headers: {
                    host: runtimeUpstream.host, accept: 'application/json', 'content-type': 'application/json',
                    'content-length': String(Buffer.byteLength(body)), cookie: session.nativeCookie,
                    'x-forwarded-proto': 'https', 'x-forwarded-host': origin.host,
                    'x-ava-native-peer': peerSecret, 'x-ava-native-binding': session.bindingId,
                },
            });
            const cancel = () => { target.destroy(); settle(reject, deny()); };
            registerCancel?.(cancel);
            target.setTimeout(60000, cancel);
            target.on('error', () => settle(reject, deny()));
            target.on('response', remote => {
                const chunks = []; let size = 0;
                if (remote.statusCode < 200 || remote.statusCode >= 300) {
                    remote.resume();
                    return settle(reject, runtimeFailure('AVA_ONYX_RUNTIME_UPSTREAM_UNAVAILABLE', remote.statusCode >= 500 ? 503 : 502));
                }
                remote.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) remote.destroy(deny()); else chunks.push(chunk); });
                remote.on('error', () => settle(reject, runtimeFailure('AVA_ONYX_RUNTIME_UPSTREAM_UNAVAILABLE', 503)));
                remote.on('end', () => {
                    const raw = Buffer.concat(chunks);
                    try { if (raw.length) JSON.parse(raw.toString('utf8')); } catch (_) { return settle(reject, runtimeFailure('AVA_ONYX_RUNTIME_UPSTREAM_UNAVAILABLE', 502)); }
                    settle(resolve, { status: remote.statusCode, body: raw });
                });
            });
            target.end(body);
        });
        const stopRuntimeGeneration = async (sessionId, session) => {
            if (!UUID.test(sessionId || '')) return;
            await forwardRuntime({ upstream: `/chat/stop-chat-session/${sessionId}`, body: 'empty' }, '{}', session);
        };
        const continuousRuntimeCheck = (expectedPrincipal, stop) => {
            let busy = false;
            const timer = setInterval(async () => {
                if (busy) return;
                busy = true;
                try {
                    const principal = await broker('/v1/onyx-runtime/authorize', {});
                    if (!sameRuntimePrincipal(principal, config) || !sameRuntimeIdentity(principal, expectedPrincipal)) throw deny();
                } catch (_) { stop(); }
                finally { busy = false; }
            }, 1000);
            timer.unref();
            return () => clearInterval(timer);
        };
        runtimeServer = http.createServer(async (req, res) => {
            let bindingId, session, route, clearCheck = () => {}, cancelUpstream = () => {}, stopPromise, replied = false, aborted = false;
            const cancelForDisconnect = () => {
                cancelUpstream();
                if (route?.body === 'send' && session && !stopPromise) {
                    stopPromise = stopRuntimeGeneration(session.input.chat_session_id, session).catch(() => {});
                }
            };
            const markAborted = () => { if (!replied) { aborted = true; cancelForDisconnect(); } };
            // A client can vanish while the private native peer is still
            // minting its session; req.aborted arrives before res.close in
            // that case, so check both boundaries before forwarding.
            req.once('aborted', markAborted);
            res.once('close', markAborted);
            try {
                route = runtimeRoute(req.method, req.url);
                if (!route || Number(req.headers['content-length'] || 0) > 256 * 1024) throw deny();
                authenticateRuntime(req);
                if (route.body === 'none') {
                    if (Number(req.headers['content-length'] || 0) !== 0) throw deny();
                } else if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw deny();
                const input = route.body === 'none' ? {} : runtimeBody(route.body, await readRuntimeJson(req));
                if (aborted) throw deny();
                const principal = await broker('/v1/onyx-runtime/authorize', {});
                if (aborted || !sameRuntimePrincipal(principal, config)) throw deny();
                bindingId = crypto.randomUUID();
                session = await createRuntimeSession(principal, bindingId);
                if (aborted) throw deny();
                session.input = input;
                clearCheck = continuousRuntimeCheck(principal, cancelForDisconnect);
                const result = await forwardRuntime(route, route.body === 'none' ? '' : JSON.stringify(input), session,
                    cancel => { cancelUpstream = cancel; });
                const current = await broker('/v1/onyx-runtime/authorize', {});
                if (aborted || !sameRuntimePrincipal(current, config) || !sameRuntimeIdentity(current, principal)) throw deny();
                // Do not tell the caller the turn completed while its native
                // credential is still live.  A failed revoke turns the whole
                // request into a safe denial and the binding remains only for
                // native durable reconciliation.
                await revokeRuntimeSession(bindingId);
                bindingId = undefined;
                replied = true;
                runtimeReply(res, result.status, result.body);
            } catch (error) {
                runtimeDenied(res, error);
            } finally {
                clearCheck();
                if (stopPromise) await stopPromise;
                if (bindingId) await revokeRuntimeSession(bindingId).catch(() => {
                    if (!res.writableEnded) runtimeDenied(res, runtimeFailure('AVA_ONYX_RUNTIME_UPSTREAM_UNAVAILABLE', 503));
                });
            }
        });
        runtimeServer.requestTimeout = 65000; runtimeServer.headersTimeout = 10000;
        runtimeServer.maxHeadersCount = 20; runtimeServer.maxConnections = 64;
    }
    return { server, runtimeServer, cleanupOnce };
}
module.exports = { createGateway, allowedPath, samePrincipal, nativeAccountSurface, runtimeRoute, sameRuntimeIdentity };
