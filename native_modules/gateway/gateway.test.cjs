'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { describe, it: test } = require('node:test');
const assert = require('node:assert/strict');
const { GatewayStore } = require('./store.cjs');
const { createGateway, allowedPath, nativeAccountSurface } = require('./server.cjs');
const { peerClient } = require('./peer-client.cjs');
const random = () => crypto.randomBytes(32).toString('base64url');
const digest = value => crypto.createHash('sha256').update(value).digest('base64url');
const origin = 'https://north.crm.meludtech.tech';
const ava = 'https://wh.meludtech.tech';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
function request(server, url, { method = 'GET', body = '', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method,
            headers: { Host: new URL(origin).host, Connection: 'close', 'Content-Length': Buffer.byteLength(body), ...headers } }, res => {
            const chunks = []; res.on('data', part => chunks.push(part));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject); req.end(body);
    });
}
function runtimeRequest(server, url, { method = 'POST', body = '', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method,
            headers: { Connection: 'close', 'Content-Length': Buffer.byteLength(body), ...headers } }, res => {
            const chunks = []; res.on('data', part => chunks.push(part));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject); req.end(body);
    });
}
async function eventually(predicate, timeout = 3000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('condition was not reached');
}
function it(name, run, module = 'twenty', runtime = false) {
    test(name, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-gateway-'));
        const config = { businessId: 731, module, deploymentId: crypto.randomUUID(), adapterId: crypto.randomUUID(),
            publicOrigin: origin, avaOrigin: ava, nativeScope: crypto.randomUUID(), revision: 1 };
        const key = crypto.randomBytes(32), filename = path.join(dir,'gateway.sqlite');
        const store = new GatewayStore({ filename, encryptionKey: key, ...config });
        const upstreamHits = [], runtimeHits = [], nativeCalls = [], brokerCalls = [];
        const state = { authorized: true, nativeWrongScope: false, deniedDuringCreate: false, nativeRevokeFailure: false, cleanupAbsent: true,
            runtimeAuthorized: true, runtimeUpstreamStatus: 200, runtimeHang: false };
        const grant = { sessionHandle: random(), bindingId: crypto.randomUUID(), expiresAt: Date.now() + 3500000,
            revision: 1, userId: crypto.randomUUID(), businessId: config.businessId, module: config.module,
            nativeScope: config.nativeScope, nativeUserId: crypto.randomUUID(), subject: crypto.randomUUID(), role: 'hotel_owner' };
        const runtimePrincipal = { servicePrincipalId: crypto.randomUUID(), subject: `ava-onyx-runtime:${config.businessId}`,
            nativeUserId: crypto.randomUUID(), businessId: config.businessId, nativeScope: config.nativeScope };
        const runtimeSecret = runtime ? random() : undefined;
        // Native identity is explicitly a fixture. The gateway, crypto, SQLite,
        // HTTP forwarding and streaming cancellation are real in these tests.
        const broker = async (route, body) => {
            brokerCalls.push({ route, body });
            if (route === '/v1/onyx-runtime/authorize') {
                if (!state.runtimeAuthorized) throw new Error('runtime access revoked');
                const principal = state.runtimePrincipal || runtimePrincipal;
                return state.runtimeCorrelation ? { ...principal, correlation_id: state.runtimeCorrelation } : principal;
            }
            if (route === '/v1/exchange') { assert.strictEqual(digest(body.verifier), state.challenge); return grant; }
            if (route === '/v1/authorize') {
                if (!state.authorized) throw new Error('private failure must not leak');
                const { sessionHandle, ...principal } = grant; return principal;
            }
            if (route === '/v1/logout' || route === '/v1/logout-all') { state.authorized = false; return { revoked: true }; }
            if (route === '/v1/revocations/lease') return { job: state.cleanupJob || null };
            if (route === '/v1/revocations/complete') { state.cleanupResult = body; return {}; }
            throw new Error('unexpected broker route');
        };
        const native = async (route, body) => {
            nativeCalls.push({ route, body });
            if (route === '/v1/sessions/create') {
                if (state.runtimeCreateStarted) state.runtimeCreateStarted();
                if (state.runtimeCreateDelay) await state.runtimeCreateDelay;
                if (state.runtimeCreateFailure) throw new Error('lost native create response');
                if (state.deniedDuringCreate) state.authorized = false;
                return { ...body, nativeScope: state.nativeWrongScope ? 'foreign' : body.nativeScope,
                    nativeCookie: 'session=fixture-native-secret', nativeSessionId: crypto.randomUUID() };
            }
            if (route === '/v1/sessions/revoke') { if (state.nativeRevokeFailure) throw new Error('native unavailable'); return { bindingId: body.bindingId, nativeSessionAbsent: state.cleanupAbsent }; }
            throw new Error('unexpected native route');
        };
        const respond = (req, res, hits) => {
            hits.push({ url: req.url, headers: req.headers });
            if (req.url === '/chat/send-chat-message' && state.runtimeHang) {
                state.runtimeStarted?.();
                return res.on('close', () => { state.runtimeClosed = true; });
            }
            if (req.url.startsWith('/chat/') && state.runtimeUpstreamStatus !== 200) {
                res.writeHead(state.runtimeUpstreamStatus, { 'Content-Type': 'application/json' });
                return res.end('{"detail":"fixture-native-secret"}');
            }
            if (req.url.startsWith('/chat/stop-chat-session/')) state.runtimeStopSeen = true;
            if (req.url === '/stream') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: started\n\n');
                const timer = setInterval(() => res.write('data: alive\n\n'), 100);
                res.on('close', () => { clearInterval(timer); state.streamClosed = true; });
                return;
            }
            res.writeHead(200, { 'Set-Cookie': 'session=wrong-browser-token', 'Content-Type': 'application/json' });
            res.end('{"native":true}');
        };
        const upstream = http.createServer((req, res) => respond(req, res, upstreamHits));
        const runtimeApi = http.createServer((req, res) => respond(req, res, runtimeHits));
        upstream.on('upgrade', (req, socket) => {
            upstreamHits.push({ url: req.url, headers: req.headers });
            socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
            socket.on('data', () => {}); socket.on('end', () => socket.end());
            socket.on('close', () => { state.wsClosed = true; }); socket.on('error', () => {});
        });
        await listen(upstream);
        await listen(runtimeApi);
        config.upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
        config.runtimeUpstreamOrigin = `http://127.0.0.1:${runtimeApi.address().port}`;
        const gateway = createGateway({ config, store, broker, native, nativePeerSecret: random,
            ...(runtime ? { runtimePeerSecret: () => runtimeSecret } : {}) });
        await listen(gateway.server);
        if (gateway.runtimeServer) await listen(gateway.runtimeServer);
        const login = async () => {
            const started = await request(gateway.server, '/ava-auth/start');
            const target = new URL(started.headers.location);
            state.challenge = target.searchParams.get('code_challenge');
            const result = await request(gateway.server, '/ava-auth/callback', { method: 'POST',
                headers: { Origin: ava, Cookie: started.headers['set-cookie'][0].split(';')[0], 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ state: target.searchParams.get('state'), code: random() }).toString() });
            return { ...result, cookie: result.headers['set-cookie']?.[0]?.split(';')[0] };
        };
        try { await run({ config, store, key, filename, grant, runtimePrincipal, runtimeSecret, state, upstreamHits, runtimeHits, nativeCalls, brokerCalls, login, ...gateway }); }
        finally {
            gateway.server.closeAllConnections(); gateway.runtimeServer?.closeAllConnections(); upstream.closeAllConnections(); runtimeApi.closeAllConnections();
            await Promise.all([gateway.server,gateway.runtimeServer,upstream,runtimeApi].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
            store.close(); fs.rmSync(dir, { recursive: true, force: true });
        }
    });
}

describe('A07 native gateway, actual HTTP and encrypted SQLite with native fixtures', () => {
    it('isolated Onyx machine listener authorizes every real HTTP chat lifecycle request and destroys each native session', async t => {
        assert.ok(t.runtimeServer);
        t.state.runtimeCorrelation = crypto.randomUUID();
        const peer = { 'X-AVA-Runtime-Peer': t.runtimeSecret, 'Content-Type': 'application/json' };
        const sessionId = crypto.randomUUID();
        const calls = [
            ['POST', '/v1/onyx-runtime/chat/create-chat-session', JSON.stringify({ persona_id: 7, incognito: true }), '/chat/create-chat-session'],
            ['POST', '/v1/onyx-runtime/chat/send-chat-message', JSON.stringify({ chat_session_id: sessionId, message: 'Где завтрак?', stream: false, include_citations: true, allowed_tool_ids: [7], forced_tool_id: 7, internal_search_filters: { document_set: ['hotel-731'] } }), '/chat/send-chat-message'],
            ['GET', `/v1/onyx-runtime/chat/get-chat-session/${sessionId}`, '', `/chat/get-chat-session/${sessionId}`],
            ['POST', `/v1/onyx-runtime/chat/stop-chat-session/${sessionId}`, '{}', `/chat/stop-chat-session/${sessionId}`],
            ['POST', `/v1/onyx-runtime/chat/end-incognito-session/${sessionId}`, '{}', `/chat/end-incognito-session/${sessionId}`],
        ];
        for (const [method, url, body] of calls) {
            const result = await runtimeRequest(t.runtimeServer, url, { method, body, headers: method === 'GET' ? { 'X-AVA-Runtime-Peer': t.runtimeSecret } : peer });
            assert.equal(result.status, 200);
        }
        assert.deepEqual(t.runtimeHits.map(hit => hit.url), calls.map(([, , , upstream]) => upstream));
        assert.equal(t.brokerCalls.filter(call => call.route === '/v1/onyx-runtime/authorize').length, calls.length * 2);
        assert.ok(t.brokerCalls.filter(call => call.route === '/v1/onyx-runtime/authorize').every(call => JSON.stringify(call.body) === '{}'));
        const creates = t.nativeCalls.filter(call => call.route === '/v1/sessions/create');
        const revokes = t.nativeCalls.filter(call => call.route === '/v1/sessions/revoke');
        assert.equal(creates.length, calls.length); assert.equal(revokes.length, calls.length);
        assert.ok(creates.every(call => call.body.userId === t.runtimePrincipal.servicePrincipalId
            && call.body.nativeUserId === t.runtimePrincipal.nativeUserId && call.body.subject === t.runtimePrincipal.subject
            && call.body.role === 'manager' && call.body.revision === t.config.revision));
        assert.ok(t.runtimeHits.every(hit => hit.headers.authorization === undefined && hit.headers['x-ava-runtime-peer'] === undefined
            && hit.headers['x-ava-native-binding'] && hit.headers.cookie === 'session=fixture-native-secret'));
    }, 'onyx', true);
    it('isolated Onyx machine listener rejects public/modeled identity inputs, stale peer and unexpected paths before the upstream', async t => {
        const peer = { 'X-AVA-Runtime-Peer': t.runtimeSecret, 'Content-Type': 'application/json' };
        const before = t.runtimeHits.length;
        for (const [url, body, headers] of [
            ['/v1/onyx-runtime/chat/send-chat-message', JSON.stringify({ chat_session_id: crypto.randomUUID(), message: 'x', stream: true }), peer],
            ['/v1/onyx-runtime/chat/send-chat-message', JSON.stringify({ chat_session_id: crypto.randomUUID(), message: 'x', stream: false, businessId: 999 }), peer],
            ['/v1/onyx-runtime/chat/send-chat-message', JSON.stringify({ chat_session_id: crypto.randomUUID(), message: 'x', stream: false }), { ...peer, 'X-AVA-Runtime-Peer': random() }],
            ['/v1/onyx-runtime/chat/send-chat-message', JSON.stringify({ chat_session_id: crypto.randomUUID(), message: 'x', stream: false }), { ...peer, Authorization: 'Bearer legacy-common-token' }],
            ['/v1/onyx-runtime/onyx-api/ingestion', '{}', peer],
        ]) assert.equal((await runtimeRequest(t.runtimeServer, url, { body, headers })).status, 403);
        t.state.runtimePrincipal = { ...t.runtimePrincipal, businessId: 999 };
        assert.equal((await runtimeRequest(t.runtimeServer, '/v1/onyx-runtime/chat/create-chat-session', { body: JSON.stringify({ persona_id: 7, incognito: true }), headers: peer })).status, 403);
        assert.equal(t.runtimeHits.length, before);
        assert.equal((await request(t.server, '/v1/onyx-runtime/chat/create-chat-session')).status, 403);
    }, 'onyx', true);
    it('isolated Onyx machine listener reaches the dedicated runtime API origin and never reflects an upstream error body', async t => {
        assert.notEqual(t.config.runtimeUpstreamOrigin, t.config.upstreamOrigin);
        t.state.runtimeUpstreamStatus = 500;
        const result = await runtimeRequest(t.runtimeServer, '/v1/onyx-runtime/chat/create-chat-session', {
            body: JSON.stringify({ persona_id: 7, incognito: true }),
            headers: { 'X-AVA-Runtime-Peer': t.runtimeSecret, 'Content-Type': 'application/json' },
        });
        assert.equal(result.status, 503);
        assert.deepEqual(JSON.parse(result.body), { error_code: 'AVA_ONYX_RUNTIME_UPSTREAM_UNAVAILABLE' });
        assert.doesNotMatch(result.body, /fixture-native-secret/);
        assert.ok(t.nativeCalls.some(call => call.route === '/v1/sessions/revoke'));
    }, 'onyx', true);
    it('isolated Onyx machine listener revokes a binding when native create has no response', async t => {
        t.state.runtimeCreateFailure = true;
        const result = await runtimeRequest(t.runtimeServer, '/v1/onyx-runtime/chat/create-chat-session', {
            body: JSON.stringify({ persona_id: 7, incognito: true }),
            headers: { 'X-AVA-Runtime-Peer': t.runtimeSecret, 'Content-Type': 'application/json' },
        });
        assert.equal(result.status, 403);
        const create = t.nativeCalls.find(call => call.route === '/v1/sessions/create');
        const revoke = t.nativeCalls.find(call => call.route === '/v1/sessions/revoke');
        assert.ok(create && revoke); assert.equal(revoke.body.bindingId, create.body.bindingId);
        assert.equal(t.runtimeHits.length, 0);
    }, 'onyx', true);
    it('isolated Onyx machine listener never forwards after disconnect during native session creation', async t => {
        let createStarted, releaseCreate;
        t.state.runtimeCreateStarted = () => createStarted();
        t.state.runtimeCreateDelay = new Promise(resolve => { releaseCreate = resolve; });
        const started = new Promise(resolve => { createStarted = resolve; });
        const body = JSON.stringify({ persona_id: 7, incognito: true });
        const req = http.request({ hostname: '127.0.0.1', port: t.runtimeServer.address().port,
            path: '/v1/onyx-runtime/chat/create-chat-session', method: 'POST', headers: {
                'X-AVA-Runtime-Peer': t.runtimeSecret, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
            } });
        req.on('error', () => {}); req.end(body);
        await started;
        req.destroy();
        // Let the TCP close reach the private listener while its native
        // create call is still deliberately unresolved.
        await new Promise(resolve => setTimeout(resolve, 50));
        releaseCreate();
        await eventually(() => t.nativeCalls.some(call => call.route === '/v1/sessions/revoke'));
        assert.equal(t.runtimeHits.length, 0);
    }, 'onyx', true);
    it('isolated Onyx machine listener fences an in-flight turn when broker changes principal within the same business', async t => {
        let started;
        t.state.runtimeHang = true;
        t.state.runtimeStarted = () => started();
        const startedAtUpstream = new Promise(resolve => { started = resolve; });
        const pending = runtimeRequest(t.runtimeServer, '/v1/onyx-runtime/chat/send-chat-message', {
            body: JSON.stringify({ chat_session_id: crypto.randomUUID(), message: 'Нужен ответ', stream: false }),
            headers: { 'X-AVA-Runtime-Peer': t.runtimeSecret, 'Content-Type': 'application/json' },
        });
        await startedAtUpstream;
        t.state.runtimePrincipal = { ...t.runtimePrincipal, nativeUserId: crypto.randomUUID() };
        const result = await pending;
        assert.equal(result.status, 403);
        await eventually(() => t.state.runtimeClosed === true);
        assert.ok(t.brokerCalls.filter(call => call.route === '/v1/onyx-runtime/authorize').length >= 2);
        assert.ok(t.nativeCalls.some(call => call.route === '/v1/sessions/revoke'));
    }, 'onyx', true);
    it('isolated Onyx machine listener cancels a disconnected send before revoking its native binding', async t => {
        let started;
        t.state.runtimeHang = true;
        t.state.runtimeStarted = () => started();
        const startedAtUpstream = new Promise(resolve => { started = resolve; });
        const body = JSON.stringify({ chat_session_id: crypto.randomUUID(), message: 'Отменить', stream: false });
        const req = http.request({ hostname: '127.0.0.1', port: t.runtimeServer.address().port,
            path: '/v1/onyx-runtime/chat/send-chat-message', method: 'POST', headers: {
                'X-AVA-Runtime-Peer': t.runtimeSecret, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
            } });
        req.on('error', () => {}); req.end(body);
        await startedAtUpstream;
        req.destroy();
        await eventually(() => t.state.runtimeStopSeen === true && t.state.runtimeClosed === true);
        assert.ok(t.nativeCalls.some(call => call.route === '/v1/sessions/revoke'));
    }, 'onyx', true);
    it('does not construct a machine listener until a distinct runtime peer is supplied', async t => {
        assert.equal(t.runtimeServer, null);
    }, 'onyx');
    it('Onyx auth metadata requires a current session and only permits exact GET', async t => {
        assert.strictEqual((await request(t.server, '/api/auth/type')).status, 403);
        const login = await t.login();
        const headers = { Cookie: login.cookie, Origin: origin };
        assert.strictEqual((await request(t.server, '/api/auth/type', { headers })).status, 200);
        const hits = t.upstreamHits.length;
        for (const path of ['/api/auth/type/', '/api/auth/login', '/api/auth/register', '/auth/type']) {
            assert.strictEqual((await request(t.server, path, { headers })).status, 403);
        }
        assert.strictEqual((await request(t.server, '/api/auth/type', { method: 'POST', headers })).status, 403);
        t.state.authorized = false;
        assert.strictEqual((await request(t.server, '/api/auth/type', { headers })).status, 403);
        assert.strictEqual(t.upstreamHits.length, hits);
    }, 'onyx');
    it('Onyx receives the same server-owned peer and binding, never client credentials', async t => {
        const login = await t.login();
        assert.strictEqual(login.status, 303);
        assert.strictEqual(login.headers.location, '/');
        const result = await request(t.server, '/api/me', { headers: {
            Cookie: login.cookie, 'X-AVA-Native-Peer': 'attacker', 'X-AVA-Native-Binding': crypto.randomUUID(),
            Authorization: 'Bearer attacker' } });
        assert.strictEqual(result.status, 200);
        assert.match(t.upstreamHits[0].headers['x-ava-native-peer'], /^[\w-]{43}$/);
        assert.strictEqual(t.upstreamHits[0].headers['x-ava-native-binding'], t.grant.bindingId);
        assert.strictEqual(t.upstreamHits[0].headers.authorization, undefined);
        assert.strictEqual(t.upstreamHits[0].headers.cookie, 'session=fixture-native-secret');
    }, 'onyx');
    it('Onyx independent credentials and account escalation routes are denied, guest operations remain available', async () => {
        for (const path of ['/api/auth/register','/api/auth/login','/api/users/me','/api/password/change-password',
            '/api/password/reset_password','/api/user/pats','/api/user/pats/123','/api/admin/api-key',
            '/api/manage/users','/api/manage/admin/users','/api/manage/admin/deactivate-user']) {
            assert.strictEqual(nativeAccountSurface('onyx',path),true,path);
        }
        for (const path of ['/api/me','/api/me/permissions','/api/user/preferences','/api/user/files','/api/chat/send-message']) {
            assert.strictEqual(nativeAccountSurface('onyx',path),false,path);
        }
    });
    it('browser-bound PKCE creates host-only opaque session; native credentials never reach browser', async t => {
        const login = await t.login();
        assert.strictEqual(login.status, 303);
        assert.strictEqual(login.headers.location, '/ava-auth/ready');
        assert.match(login.cookie, /^__Host-ava_module=[\w-]{43}$/);
        assert.match(login.headers['set-cookie'][0], /Path=\/; Secure; HttpOnly; SameSite=Lax/);
        assert.strictEqual(JSON.stringify(login).includes('fixture-native-secret'), false);
        const result = await request(t.server, '/graphql', { method: 'POST', body: '{}', headers: {
            Cookie: login.cookie + '; session=attacker', Origin: origin, Authorization: 'Bearer attacker',
            'X-AVA-Business-ID': '999', 'X-Forwarded-Host': 'foreign.crm.meludtech.tech' } });
        assert.strictEqual(result.status, 200); assert.strictEqual(result.headers['set-cookie'], undefined);
        assert.strictEqual(t.upstreamHits[0].headers.cookie, 'session=fixture-native-secret');
        assert.strictEqual(t.upstreamHits[0].headers.authorization, undefined);
        assert.strictEqual(t.upstreamHits[0].headers['x-ava-business-id'], undefined);
        assert.match(t.upstreamHits[0].headers['x-ava-native-peer'], /^[\w-]{43}$/);
        assert.strictEqual(t.upstreamHits[0].headers['x-ava-native-binding'],t.grant.bindingId);
        assert.strictEqual(t.upstreamHits[0].headers['x-forwarded-host'], new URL(origin).host);
        const persisted = JSON.stringify(t.store.db.prepare('SELECT * FROM ava_gateway_sessions').all());
        assert.strictEqual(persisted.includes('fixture-native-secret'), false);
        assert.strictEqual(persisted.includes(t.grant.sessionHandle), false);
    });
    it('Twenty entry bridge is authorized, same-origin, no-store, and exposes no native credential or cross-origin redirect', async t => {
        const login = await t.login();
        const denied = await request(t.server, '/ava-auth/ready');
        assert.equal(denied.status, 403);
        assert.equal((await request(t.server, '/ava-auth/ready', { headers: { Cookie: login.cookie, Origin: 'https://evil.test' } })).status, 403);
        const ready = await request(t.server, '/ava-auth/ready', { headers: { Cookie: login.cookie } });
        assert.equal(ready.status, 200);
        assert.equal(ready.headers['cache-control'], 'no-store');
        assert.match(ready.headers['content-security-policy'], /script-src 'self'/);
        assert.match(ready.body, /src="\/ava-auth\/twenty-entry\.js"/);
        assert.doesNotMatch(ready.body, /fixture-native-secret|https?:\/\//);
        const script = await request(t.server, '/ava-auth/twenty-entry.js', { headers: { Cookie: login.cookie } });
        assert.equal(script.status, 200);
        assert.equal(script.headers['cache-control'], 'no-store');
        assert.match(script.body, /localStorage\.setItem\('isCookieAuthActiveState','true'\)/);
        assert.match(script.body, /location\.replace\('\/objects\/companies'\)/);
        for (const key of ['currentUserState', 'currentWorkspaceState', 'currentUserWorkspaceState', 'currentWorkspaceMemberState']) {
            assert.match(script.body, new RegExp(`localStorage\\.removeItem\\('${key}'\\)`));
        }
        assert.doesNotMatch(script.body, /fixture-native-secret|document\.cookie|nativeCookie|sessionToken|tokenPair|authorization|bearer|https?:|location\.href/i);
        assert.equal(t.upstreamHits.length, 0);
        assert.equal((await request(t.server, '/ava-auth/twenty-entry.js')).status, 403);
    });
    it('Twenty signOut return path redirects without a session and ignores query data', async t => {
        const result = await request(t.server, '/welcome?next=https%3A%2F%2Fevil.test%2Fsteal');
        assert.equal(result.status, 302);
        assert.equal(result.headers.location, ava);
        assert.equal(result.headers['cache-control'], 'no-store');
        assert.equal(result.headers['referrer-policy'], 'no-referrer');
        assert.equal(t.upstreamHits.length, 0);
        const post = await request(t.server, '/welcome', { method: 'POST', headers: { Origin: origin } });
        assert.equal(post.status, 403);
        assert.equal(t.upstreamHits.length, 0);
    });
    it('Onyx does not inherit Twenty welcome redirect', async t => {
        const result = await request(t.server, '/welcome?next=/');
        assert.equal(result.status, 403);
        assert.equal(t.upstreamHits.length, 0);
    }, 'onyx');
    it('foreign store scope, switched ciphertext and invalid native grant are denied', async t => {
        assert.throws(() => new GatewayStore({ ...t.config, filename: t.filename, encryptionKey: t.key, businessId: 999 }));
        const login = await t.login();
        t.store.db.prepare('UPDATE ava_gateway_sessions SET nativeCookie=brokerHandle').run();
        assert.strictEqual((await request(t.server, '/', { headers: { Cookie: login.cookie } })).status, 403);
        assert.strictEqual(t.upstreamHits.length, 0);
        assert.throws(() => t.store.saveSession({ grant: { ...t.grant, businessId: 999 }, nativeCookie: 'x=y', nativeSessionId: 'x' }));
    });
    it('callback rejects a copied state from another browser and a replay', async t => {
        const first = await request(t.server, '/ava-auth/start'), target = new URL(first.headers.location);
        t.state.challenge = target.searchParams.get('code_challenge');
        const body = new URLSearchParams({ state: target.searchParams.get('state'), code: random() }).toString();
        const headers = { Origin: ava, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `__Host-ava_flow=${random()}` };
        assert.strictEqual((await request(t.server, '/ava-auth/callback', { method:'POST',body,headers })).status,403);
        headers.Cookie = first.headers['set-cookie'][0].split(';')[0];
        assert.strictEqual((await request(t.server, '/ava-auth/callback', { method:'POST',body,headers })).status,303);
        assert.strictEqual((await request(t.server, '/ava-auth/callback', { method:'POST',body,headers })).status,403);
        assert.strictEqual(t.nativeCalls.filter(x => x.route.endsWith('/create')).length,1);
    });
    for (const failure of ['nativeWrongScope','deniedDuringCreate']) it(`session race ${failure} revokes native binding and issues no browser session`, async t => {
        t.state[failure] = true;
        const login = await t.login();
        assert.strictEqual(login.status,403); assert.strictEqual(login.cookie,undefined);
        assert.ok(t.nativeCalls.some(x => x.route.endsWith('/revoke')));
        assert.strictEqual(t.store.db.prepare('SELECT count(*) AS n FROM ava_gateway_sessions').get().n,0);
    });
    it('foreign hosts, CSRF, missing sessions, private paths and duplicate cookies never reach native', async t => {
        const login = await t.login();
        for (const url of ['/v1/provision','/api/v1/provision','/%61va-internal/verify','/api/%2561va-internal/verify','//evil.test','/x/../v1/provision']) {
            assert.throws(() => allowedPath(url));
            assert.strictEqual((await request(t.server,url,{headers:{Cookie:login.cookie}})).status,403);
        }
        for (const headers of [{}, {Cookie:login.cookie,Host:'south.crm.meludtech.tech'},
            {Cookie:login.cookie,Origin:'https://evil.test'}, {Cookie:login.cookie+'; '+login.cookie}]) {
            assert.strictEqual((await request(t.server,'/',{headers})).status,403);
        }
        assert.strictEqual((await request(t.server,'/graphql',{method:'POST',headers:{Cookie:login.cookie}})).status,403);
        assert.strictEqual(t.upstreamHits.length,0);
    });
    it('global logout and broker outage deny requests, cleanup acknowledges actual absence only', async t => {
        const login = await t.login();
        assert.strictEqual((await request(t.server,'/ava-auth/logout',{method:'POST',headers:{Cookie:login.cookie,Origin:origin}})).status,303);
        assert.ok(t.brokerCalls.some(x => x.route === '/v1/logout-all'));
        assert.strictEqual((await request(t.server,'/',{headers:{Cookie:login.cookie}})).status,403);
        t.state.cleanupJob = { bindingId:t.grant.bindingId,leaseToken:crypto.randomUUID() };
        t.state.cleanupAbsent = false;
        assert.strictEqual(await t.cleanupOnce(),false); assert.strictEqual(t.state.cleanupResult.result,'retry');
        t.state.cleanupAbsent = true;
        assert.strictEqual(await t.cleanupOnce(),true); assert.strictEqual(t.state.cleanupResult.result,'native_session_absent');
    });
    it('Twenty GraphQL signOut revokes AVA and native sessions and returns schema shape', async t => {
        const login = await t.login();
        const result = await request(t.server, '/graphql', { method: 'POST', body: JSON.stringify({ query: 'mutation { bye: signOut }' }),
            headers: { Cookie: login.cookie, Origin: origin, 'Content-Type': 'application/json' } });
        assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body), { data: { bye: true } });
        assert.ok(t.brokerCalls.some(x => x.route === '/v1/logout-all'));
        assert.ok(t.nativeCalls.some(x => x.route === '/v1/sessions/revoke'));
        assert.match(result.headers['set-cookie'][0], /^__Host-ava_module=;/);
    });
    it('Twenty metadata signOut uses the same AVA logout boundary and rejects mixed auth documents', async t => {
        const login = await t.login();
        const before = t.upstreamHits.length;
        const denied = await request(t.server, '/metadata', { method: 'POST', body: JSON.stringify({ query: 'mutation { signOut currentUser }' }),
            headers: { Cookie: login.cookie, Origin: origin, 'Content-Type': 'application/json' } });
        assert.equal(denied.status, 403); assert.equal(t.upstreamHits.length, before);
        const result = await request(t.server, '/metadata', { method: 'POST', body: JSON.stringify({ query: 'mutation { out: signOut }' }),
            headers: { Cookie: login.cookie, Origin: origin, 'Content-Type': 'application/json' } });
        assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body), { data: { out: true } });
    });
    it('Twenty GraphQL signOut recognizes fragments, rejects forged operationName and foreign origin', async t => {
        const login = await t.login();
        const forged = await request(t.server, '/graphql', { method: 'POST', body: JSON.stringify({ query: 'query { currentUser }', operationName: 'SignOut' }),
            headers: { Cookie: login.cookie, Origin: origin, 'Content-Type': 'application/json' } });
        assert.equal(forged.status, 200);
        const foreign = await request(t.server, '/graphql', { method: 'POST', body: JSON.stringify({ query: 'mutation { signOut }' }),
            headers: { Cookie: login.cookie, Origin: 'https://evil.test', 'Content-Type': 'application/json' } });
        assert.equal(foreign.status, 403);
        const fragment = JSON.stringify({ query: 'mutation { ...Logout } fragment Logout on Mutation { out: signOut }' });
        const ok = await request(t.server, '/graphql', { method: 'POST', body: fragment,
            headers: { Cookie: login.cookie, Origin: origin, 'Content-Type': 'application/json' } });
        assert.equal(ok.status, 200);
    });
    it('Twenty GraphQL signOut keeps local revoke on native revoke failure and reports unavailable', async t => {
        const login = await t.login(); t.state.nativeRevokeFailure = true;
        const result = await request(t.server, '/graphql', { method: 'POST', body: JSON.stringify({ query: 'mutation { signOut }' }),
            headers: { Cookie: login.cookie, Origin: origin, 'Content-Type': 'application/json' } });
        assert.equal(result.status, 503); assert.equal(JSON.parse(result.body).data.signOut, false);
        assert.equal((await request(t.server, '/', { headers: { Cookie: login.cookie } })).status, 403);
    });
    it('revocation closes an already running SSE stream and upstream work', async t => {
        const login = await t.login();
        await new Promise((resolve,reject) => {
            const req = http.get({host:'127.0.0.1',port:t.server.address().port,path:'/stream',headers:{Host:new URL(origin).host,Cookie:login.cookie}},res => {
                let started = false;
                res.on('data',()=> { started=true; t.state.authorized=false; });
                res.on('error',()=>{}); res.on('close',()=> { try { assert.ok(started); resolve(); } catch(e) { reject(e); } });
            });
            req.setTimeout(5000,()=>req.destroy(new Error('stream was not revoked'))); req.on('error',reject);
        });
        await new Promise(resolve=>setTimeout(resolve,30));
        assert.strictEqual(t.state.streamClosed,true);
    });
    it('revocation closes a WebSocket and its native socket', async t => {
        const login = await t.login();
        await new Promise((resolve,reject)=> {
            const socket = net.connect(t.server.address().port,'127.0.0.1',()=>socket.write(
                `GET /voice HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nOrigin: ${origin}\r\nCookie: ${login.cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
            let started=false;
            socket.on('data',data=> { if (String(data).includes('101 Switching')) { started=true; t.state.authorized=false; } });
            socket.on('error',reject); socket.on('close',()=> { try { assert.ok(started); resolve(); } catch(e) { reject(e); } });
            socket.setTimeout(5000,()=>socket.destroy(new Error('websocket was not revoked')));
        });
        await new Promise(resolve=>setTimeout(resolve,30)); assert.strictEqual(t.state.wsClosed,true);
    });
    it('private peer does not follow redirects or reflect a server secret', async () => {
        const peer = http.createServer((_req,res)=> {res.writeHead(302,{Location:'http://127.0.0.1:1/leak'}); res.end('do-not-echo');});
        await listen(peer);
        try {
            const client = peerClient({origin:`http://127.0.0.1:${peer.address().port}`,peerSecret:random});
            await assert.rejects(client('/v1/authorize',{}),{message:'AVA_MODULE_ACCESS_DENIED'});
        } finally { await new Promise(resolve=>peer.close(resolve)); }
    });
});
