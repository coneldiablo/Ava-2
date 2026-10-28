'use strict';

// Real AVA SQLite + public grant route + private broker + gateway + native
// Twenty HTTP. Enrollment is seeded through the real invitation store, NOT
// Keycloak: this deliberately does not claim browser/OIDC/TLS acceptance.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { GatewayStore } = require('../store.cjs');
const { createGateway } = require('../server.cjs');
const { peerClient } = require('../peer-client.cjs');

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (value, code) => { if (!value) fail(code); };
const uuid = () => crypto.randomUUID();
const secret = file => {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        check(stat.isFile() && !(stat.mode & 0o077) && stat.size <= 256, 'QA_SECRET_FILE_INVALID');
        const value = fs.readFileSync(fd, 'utf8').trim();
        check(/^[A-Za-z0-9_-]{43}$/.test(value), 'QA_SECRET_VALUE_INVALID');
        return value;
    } finally { fs.closeSync(fd); }
};
const call = (origin, route, { method = 'POST', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const url = new URL(route, origin);
    check(url.protocol === 'http:' && ['127.0.0.1', 'server', 'native'].includes(url.hostname), 'QA_PRIVATE_HTTP_REQUIRED');
    const bytes = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(url, { method, timeout: 10000, headers: {
        ...(bytes == null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) }), ...headers,
    } }, res => {
        let size = 0; const chunks = [];
        res.on('data', part => { size += part.length; if (size > 512 * 1024) res.destroy(); else chunks.push(part); });
        res.on('error', reject);
        res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json;
            try { json = JSON.parse(text); } catch (_) { json = null; }
            resolve({ status: res.statusCode, headers: res.headers, json, text }); });
    });
    req.on('timeout', () => req.destroy(new Error('QA_HTTP_TIMEOUT')));
    req.on('error', reject); req.end(bytes);
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { if (!server?.listening) return resolve(); server.close(resolve); server.closeAllConnections?.(); });
const cookiePair = (response, name) => (response.headers['set-cookie'] || []).find(value => value.startsWith(name + '='))?.split(';')[0];

async function main() {
    process.umask(0o077);
    check(process.env.AVA_NATIVE_QA === 'true', 'QA_ONLY');
    check(process.env.DB_PATH === '/tmp/ava-bridge/ava.sqlite' && !fs.existsSync(process.env.DB_PATH), 'QA_EMPTY_DB_REQUIRED');
    const source = '/opt/ava-qa-source/whatsapp_crm';
    const ctx = JSON.parse(fs.readFileSync('/run/ava-native-context/context.json', 'utf8'));
    const recipeQa = [900011, 900012].includes(ctx.businessId);
    check((ctx.businessId === 900003 || recipeQa) && /^[a-f0-9-]{36}$/.test(ctx.deploymentId) && /^[a-f0-9-]{36}$/.test(ctx.nativeScope), 'QA_NATIVE_SCOPE_REQUIRED');
    const publicOrigin = process.env.SERVER_URL;
    check(recipeQa ? publicOrigin === `https://recipe-qa-${ctx.businessId}.crm.meludtech.tech`
        : /^https:\/\/ava-twenty-auth-qa-[a-f0-9]{12}\.crm\.meludtech\.tech$/.test(publicOrigin || ''), 'QA_HOST_REQUIRED');
    fs.mkdirSync('/tmp/ava-bridge', { mode: 0o700 });
    process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
    process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
    process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://wh.meludtech.tech';
    const avaOrigin = process.env.WHATSAPP_CRM_PUBLIC_URL;
    const DB = require(path.join(source, 'src/services/database.service'));
    const Identity = require(path.join(source, 'src/services/identity/identity-store'));
    const Provisioning = require(path.join(source, 'src/services/provisioning/business-provisioning-store.service'));
    const Twenty = require(path.join(source, 'src/services/twenty/twenty-store.service'));
    const Access = require(path.join(source, 'src/services/identity/module-access-store'));
    const brokerServer = require(path.join(source, 'src/services/identity/module-access-broker')).createServer();
    const router = require(path.join(source, 'src/routes/module-access.routes'));
    const gatewaySecret = () => secret('/run/ava-native-keys/gateway.key');
    const workerSecret = () => secret('/run/ava-native-keys/worker.key');
    const peerOrigin = recipeQa ? 'http://native:3902' : 'http://server:3902';
    const nativeOrigin = recipeQa ? 'http://native:3000' : 'http://server:3000';
    let publicServer, gateway, gatewayStore, proofBinding;
    const checks = [];
    const mark = (ok, name) => { check(ok, name); checks.push(name); };
    const nativePeer = peerClient({ origin: peerOrigin, peerSecret: gatewaySecret });
    const workerPeer = peerClient({ origin: peerOrigin, peerSecret: workerSecret });
    try {
        await DB.init();
        check(DB.get('SELECT count(*) AS n FROM instances').n === 0, 'QA_DB_NOT_EMPTY');
        // Reserve only the synthetic range in this new disposable AVA DB.
        DB.run("INSERT INTO sqlite_sequence(name,seq) VALUES('instances',?)", [ctx.businessId - 1]);
        const invitation = Identity.createInvitation({ userId: 'qa-admin', platformRole: 'platform_admin' },
            { email: `bridge-${uuid()}@qa.invalid`, displayName: 'AVA bridge QA' });
        const buyer = Identity.completeInvitation(Identity.claimInvitation(invitation.token), `qa:${uuid()}`);
        const business = Provisioning.createBusinessAtomic({ name: 'AVA native bridge QA' }, { ownerUserId: buyer.userId }).instance;
        mark(business.id === ctx.businessId, 'AVA_BUSINESS_SCOPE');
        const common = { businessId: business.id, deploymentId: ctx.deploymentId, nativeScope: ctx.nativeScope, revision: ctx.revision };
        const member = await workerPeer('/v1/provision', { ...common, userId: buyer.userId, subject: buyer.subject,
            role: 'hotel_owner', email: buyer.login, displayName: 'AVA bridge QA' });
        mark(member.userId === buyer.userId && member.permissions?.platformAdmin === false && member.permissions?.impersonation === false,
            'NATIVE_IDENTITY_NON_ADMIN');
        Twenty.upsertIntegration(business.id, { baseUrl: publicOrigin, workspaceId: ctx.nativeScope, enabled: true });
        const adapter = Access.configure({ businessId: business.id, module: 'twenty', publicOrigin });
        proofBinding = uuid();
        const proofSession = await nativePeer('/v1/sessions/create', { ...common, userId: buyer.userId, subject: buyer.subject,
            nativeUserId: member.nativeUserId, role: 'hotel_owner', bindingId: proofBinding, expiresAt: Date.now() + 300000 });
        const query = { query: 'query BridgeIdentity { currentUser { id } currentUserSessions { id workspaceId isCurrent } }' };
        const proofHeaders = { cookie: proofSession.nativeCookie, origin: publicOrigin, 'x-ava-native-peer': gatewaySecret(), 'x-ava-native-binding': proofBinding };
        await Access.verifyPrincipal({ adapterId: adapter.id, userId: buyer.userId, nativeUserId: member.nativeUserId, readback: async input => {
            const own = await call(nativeOrigin, '/metadata', { headers: proofHeaders, body: query });
            const foreign = await call(peerOrigin, '/v1/verify', { headers: { authorization: `Bearer ${workerSecret()}` },
                body: { ...common, businessId: 900004, userId: buyer.userId } });
            const admin = await call(nativeOrigin, '/admin-panel', { method: 'GET', headers: proofHeaders });
            const noPeer = await call(nativeOrigin, '/metadata', { headers: { cookie: proofSession.nativeCookie, origin: publicOrigin }, body: query });
            const wrongBinding = await call(nativeOrigin, '/metadata', { headers: { ...proofHeaders, 'x-ava-native-binding': uuid() }, body: query });
            const ownAccess = own.status === 200 && !own.json?.errors?.length && own.json?.data?.currentUser?.id === member.nativeUserId
                && own.json.data.currentUserSessions.some(item => item.id === proofSession.nativeSessionId && item.workspaceId === ctx.nativeScope && item.isCurrent);
            mark(ownAccess, 'NATIVE_EXACT_SESSION');
            mark(foreign.status === 403, 'NATIVE_FOREIGN_SCOPE_REJECTED');
            mark(admin.status === 403, 'NATIVE_ADMIN_DENIED');
            mark(noPeer.status === 403 && wrongBinding.status === 403, 'NATIVE_GUARD_REQUIRED');
            return { ...input, ownAccess, foreignAccessDenied: foreign.status === 403,
                platformAdminDenied: admin.status === 403, sessionGuardVerified: noPeer.status === 403 && wrongBinding.status === 403 };
        } });
        mark((await nativePeer('/v1/sessions/revoke', { bindingId: proofBinding })).nativeSessionAbsent === true, 'PROOF_SESSION_REMOVED');
        proofBinding = null;
        const brokerOrigin = await listen(brokerServer);
        const app = express(); app.use(express.json()); app.use('/api', router());
        publicServer = http.createServer(app); const avaHttp = await listen(publicServer);
        const config = { publicOrigin, avaOrigin, upstreamOrigin: nativeOrigin, adapterId: adapter.id,
            deploymentId: ctx.deploymentId, businessId: business.id, module: 'twenty', nativeScope: ctx.nativeScope };
        gatewayStore = new GatewayStore({ ...config, filename: '/tmp/ava-bridge/gateway.sqlite', encryptionKey: crypto.randomBytes(32) });
        gateway = createGateway({ config, store: gatewayStore, native: nativePeer, nativePeerSecret: gatewaySecret,
            broker: peerClient({ origin: brokerOrigin, adapterId: adapter.id, peerSecret: () => adapter.peerSecret }) });
        const gatewayOrigin = await listen(gateway.server), host = new URL(publicOrigin).host;
        const buyerSession = Identity.createSession(buyer.subject, `qa-sid:${uuid()}`, 600);
        const avaHeaders = { cookie: `crm_session=ava2:${buyerSession}`, origin: avaOrigin };
        const start = await call(gatewayOrigin, '/ava-auth/start', { method: 'GET', headers: { host } });
        const flowCookie = cookiePair(start, '__Host-ava_flow');
        mark(start.status === 302 && Boolean(flowCookie), 'GATEWAY_BROWSER_BOUND_FLOW');
        const flow = new URL(start.headers.location);
        const grant = await call(avaHttp, `/api/modules/${adapter.id}/grants`, { headers: avaHeaders,
            body: { code_challenge: flow.searchParams.get('code_challenge') } });
        mark(grant.status === 200 && grant.json.callbackUrl === `${publicOrigin}/ava-auth/callback`, 'AVA_HTTP_GRANT');
        const callbackOptions = { headers: { host, cookie: flowCookie, origin: avaOrigin, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ code: grant.json.code, state: flow.searchParams.get('state') }).toString() };
        const callback = await call(gatewayOrigin, '/ava-auth/callback', callbackOptions);
        const browserCookie = cookiePair(callback, '__Host-ava_module');
        mark(callback.status === 303 && Boolean(browserCookie), 'BROKER_GATEWAY_NATIVE_EXCHANGE');
        mark((callback.headers['set-cookie'] || []).every(item => !item.includes('__Host-twenty-session') && !/domain=/i.test(item)), 'HOST_ONLY_COOKIE_NO_NATIVE_TOKEN');
        mark((await call(gatewayOrigin, '/ava-auth/callback', callbackOptions)).status === 403, 'CALLBACK_REPLAY_DENIED');
        const browserHeaders = { host, origin: publicOrigin, cookie: browserCookie };
        const proxied = await call(gatewayOrigin, '/metadata', { headers: { ...browserHeaders, authorization: 'Bearer ignored-client-value',
            'x-ava-native-peer': 'ignored-client-value', 'x-ava-native-binding': uuid() }, body: query });
        mark(proxied.status === 200 && !proxied.json?.errors?.length && proxied.json?.data?.currentUser?.id === member.nativeUserId,
            'NATIVE_QUERY_THROUGH_REAL_GATEWAY');
        const navigation = await call(gatewayOrigin, '/ava-auth/context', { method: 'GET', headers: browserHeaders });
        mark(navigation.status === 200 && navigation.json.business_id === business.id && navigation.json.ava_url === avaOrigin, 'BUSINESS_NAVIGATION');
        mark((await call(gatewayOrigin, '/metadata', { headers: { ...browserHeaders, host: 'foreign.crm.meludtech.tech' }, body: query })).status === 403,
            'WRONG_HOST_DENIED');
        mark((await call(gatewayOrigin, '/metadata', { headers: browserHeaders,
            body: { operationName: 'SafeName', query: 'mutation SafeName { alias: generateApiKeyToken(apiKeyId: "x") }' } })).status === 403,
            'NATIVE_TOKEN_MINT_DENIED');
        const native = gatewayStore.session(browserCookie.split('=')[1]);
        mark((await call(gatewayOrigin, '/ava-auth/logout', { headers: browserHeaders })).status === 303, 'GLOBAL_LOGOUT');
        mark(Identity.session(buyerSession) === null && (await call(gatewayOrigin, '/metadata', { headers: browserHeaders, body: query })).status === 403,
            'AVA_AND_MODULE_SESSION_REVOKED');
        await gateway.cleanupOnce();
        mark(DB.get('SELECT state FROM ava_module_revocations WHERE bindingId=?', [native.bindingId])?.state === 'done', 'DURABLE_NATIVE_CLEANUP_DONE');
        mark((await call(nativeOrigin, '/metadata', { headers: { ...proofHeaders, cookie: native.nativeCookie,
            'x-ava-native-binding': native.bindingId }, body: query })).status === 403, 'OLD_NATIVE_COOKIE_REJECTED');
        process.stdout.write(JSON.stringify({ qa_only: true, business_id: business.id, checks,
            identity_enrollment: 'real_invitation_store_without_keycloak', transport: 'private_http_no_tls',
            second_twenty_deployment: false, production_access: false }) + '\n');
    } finally {
        if (proofBinding) await nativePeer('/v1/sessions/revoke', { bindingId: proofBinding }).catch(() => {});
        if (DB.db) {
            for (const row of DB.all('SELECT bindingId FROM ava_module_sessions WHERE bindingId IS NOT NULL')) {
                await nativePeer('/v1/sessions/revoke', { bindingId: row.bindingId }).catch(() => {});
            }
        }
        await Promise.all([close(gateway?.server), close(publicServer), close(brokerServer)]);
        gatewayStore?.close(); DB.db?.close();
    }
}

if (require.main === module) main().catch(error => {
    // No SQL, native payload, stack locals, cookie or peer secret in QA output.
    const code = /^[A-Z0-9_]{1,64}$/.test(error?.code) ? error.code : 'QA_BRIDGE_FAILED';
    process.stderr.write(JSON.stringify({ error_code: code }) + '\n'); process.exitCode = 1;
});
module.exports = { main };
