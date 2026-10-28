const { describe, it, assert, createTestDB } = require('./test-helper');
const crypto = require('crypto');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const { OidcService } = require('../src/services/identity/oidc.service');
const { KeycloakAdmin } = require('../src/services/identity/keycloak-admin');
const Revocations = require('../src/services/identity/revocation-worker');
const Access = require('../src/services/identity/customer-access');
const Provisioning = require('../src/services/provisioning/business-provisioning-store.service');
const platform = { userId: 'fixture-operator', platformRole: 'platform_admin' };

async function environment(fn) {
    const keys = ['AVA_CUSTOMER_ACCESS_ENABLED','AVA_OIDC_ISSUER','WHATSAPP_CRM_PUBLIC_URL','AVA_OIDC_CLIENT_ID',
        'AVA_OIDC_CLIENT_SECRET','SESSION_SECRET','AVA_PROCESS_ROLE','AVA_IDENTITY_ADMIN_ORIGIN'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { AVA_CUSTOMER_ACCESS_ENABLED: 'true', AVA_OIDC_ISSUER: 'https://identity.example.test/realms/ava',
        WHATSAPP_CRM_PUBLIC_URL: 'https://ava.example.test', AVA_OIDC_CLIENT_ID: 'ava-web',
        AVA_OIDC_CLIENT_SECRET: 'fixture-client-secret', SESSION_SECRET: 'fixture-session-secret-at-least-32-chars', AVA_PROCESS_ROLE: 'provisioning-worker' });
    delete process.env.AVA_IDENTITY_ADMIN_ORIGIN;
    try { await fn(); } finally { for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
}

// Actual openid-client and JOSE verification. Only the identity server HTTP
// responses are a fixture; these are NOT native Keycloak/SSO acceptance.
async function oidcFixture({ wrongAudience = false, wrongNonce = false, unknownSubject = false, foreignEndpoint = false, wrongSignature = false, expectedAccount = '' } = {}) {
    const oidc = await import(require.resolve('openid-client'));
    const jose = await import(require.resolve('jose'));
    const pair = await jose.generateKeyPair('RS256');
    const signingKey = wrongSignature ? (await jose.generateKeyPair('RS256')).privateKey : pair.privateKey;
    const jwk = { ...await jose.exportJWK(pair.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
    const issuer = process.env.AVA_OIDC_ISSUER;
    const invitation = Identity.createInvitation(platform, { email: 'owner@example.test' });
    const claim = Identity.claimInvitation(invitation.token);
    const owner = Identity.completeInvitation(claim, 'native-owner');
    let expectedUserId;
    if (expectedAccount === 'new') {
        const next = Identity.createInvitation(platform, { email: 'new@example.test' });
        expectedUserId = Identity.completeInvitation(Identity.claimInvitation(next.token), 'native-new').userId;
    } else if (expectedAccount === 'owner') expectedUserId = owner.userId;
    let flow, tokenRequests = 0;
    const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const request = async (input, options) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/.well-known/openid-configuration')) return json({
            issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: foreignEndpoint ? 'https://foreign.example.test/token' : `${issuer}/token`,
            jwks_uri: `${issuer}/certs`, end_session_endpoint: `${issuer}/logout`,
            response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        });
        if (url.pathname.endsWith('/certs')) return json({ keys: [jwk] });
        assert.strictEqual(url.href, `${issuer}/token`);
        tokenRequests++;
        const body = new URLSearchParams(options.body);
        assert.strictEqual(body.get('code_verifier'), flow.verifier);
        assert.strictEqual(body.get('redirect_uri'), 'https://ava.example.test/api/auth/sso/callback');
        const idToken = await new jose.SignJWT({ nonce: wrongNonce ? 'foreign-nonce' : flow.nonce, sid: 'native-session' })
            .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer)
            .setSubject(unknownSubject ? 'uninvited' : 'native-owner').setAudience(wrongAudience ? 'foreign-client' : 'ava-web')
            .setIssuedAt().setExpirationTime('5m').sign(signingKey);
        return json({ access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 300, id_token: idToken });
    };
    const service = new OidcService({ load: async () => ({ ...oidc,
        discovery: (server, client, metadata, auth, options) => oidc.discovery(server, client, metadata, auth, { ...options, [oidc.customFetch]: request }),
    }), loadJose: async () => ({ ...jose, createRemoteJWKSet: () => jose.createLocalJWKSet({keys:[jwk]}) }) });
    const begin = await service.begin(expectedUserId);
    flow = service.open(begin.cookie);
    return { service, begin, flow, tokenRequests: () => tokenRequests,
        logoutToken: async (extra = {}, invalidSignature = false) => new jose.SignJWT({sid:'native-session',
            events:{'http://schemas.openid.net/event/backchannel-logout':{}}, ...extra})
            .setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(issuer).setAudience('ava-web')
            .setJti(crypto.randomUUID()).setIssuedAt().setExpirationTime('5m')
            .sign(invalidSignature ? (await jose.generateKeyPair('RS256')).privateKey : pair.privateKey),
    };
}

describe('A07 OIDC, customer authorization and native revocation boundaries', () => {
    it('backchannel logout verifies the signature and event before revoking a session', () => environment(async () => {
        createTestDB();
        const test = await oidcFixture();
        const session = await test.service.complete(`state=${test.flow.state}&code=fixture-code`,test.begin.cookie);
        await assert.rejects(test.service.backchannelLogout(await test.logoutToken({},true)));
        await assert.rejects(test.service.backchannelLogout(await test.logoutToken({nonce:'forbidden'})));
        await assert.rejects(test.service.backchannelLogout(await test.logoutToken({events:{}})));
        assert.ok(Identity.session(session));
        const token = await test.logoutToken();
        await test.service.backchannelLogout(token);
        await test.service.backchannelLogout(token);
        assert.strictEqual(Identity.session(session),null);
    }));
    it('signed authorization code exchange validates PKCE and creates a revocable enrolled session', () => environment(async () => {
        createTestDB();
        const test = await oidcFixture();
        assert.strictEqual(new URL(test.begin.url).searchParams.get('code_challenge_method'), 'S256');
        assert.strictEqual(test.begin.cookie.includes(test.flow.verifier), false);
        const query = `state=${test.flow.state}&code=fixture-code`;
        const token = await test.service.complete(query, test.begin.cookie);
        assert.strictEqual(Identity.session(token).subject, 'native-owner');
        await assert.rejects(test.service.complete(query, test.begin.cookie));
        assert.strictEqual(test.tokenRequests(), 1, 'replay rejected before another token exchange');
        Identity.backchannelLogout({ sid: 'other-session', jti: crypto.randomUUID() });
        assert.ok(Identity.session(token));
        const jti = crypto.randomUUID();
        Identity.backchannelLogout({ sid: 'native-session', sub: 'native-owner', jti });
        Identity.backchannelLogout({ sid: 'native-session', sub: 'native-owner', jti });
        assert.strictEqual(Identity.session(token), null);
    }));

    it('post-enrollment login requires reauthentication and rejects an older Keycloak subject', () => environment(async () => {
        createTestDB();
        const test = await oidcFixture({ expectedAccount: 'new' });
        assert.strictEqual(new URL(test.begin.url).searchParams.get('prompt'), 'login');
        await assert.rejects(test.service.complete(`state=${test.flow.state}&code=fixture-code`, test.begin.cookie),
            { code: 'AVA_SSO_FAILED' });
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_sessions').n, 0);
    }));

    it('post-enrollment login accepts only its own immutable subject', () => environment(async () => {
        createTestDB();
        const test = await oidcFixture({ expectedAccount: 'owner' });
        const token = await test.service.complete(`state=${test.flow.state}&code=fixture-code`, test.begin.cookie);
        assert.strictEqual(Identity.session(token).subject, 'native-owner');
    }));

    for (const invalid of ['wrongAudience','wrongNonce','unknownSubject','wrongSignature']) it(`OIDC rejects ${invalid}`, () => environment(async () => {
        createTestDB();
        const test = await oidcFixture({ [invalid]: true });
        await assert.rejects(test.service.complete(`state=${test.flow.state}&code=fixture-code`, test.begin.cookie));
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_sessions').n, 0);
    }));

    it('discovery cannot redirect the client secret to another host; flow cookie tampering is rejected', () => environment(async () => {
        createTestDB();
        await assert.rejects(oidcFixture({ foreignEndpoint: true }));
        createTestDB();
        const test = await oidcFixture();
        const changedFirstCharacter = test.begin.cookie[0] === 'A' ? 'B' : 'A';
        const damaged = `${changedFirstCharacter}${test.begin.cookie.slice(1)}`;
        assert.throws(() => test.service.open(damaged));
        await assert.rejects(test.service.complete('state=foreign&code=fixture', test.begin.cookie));
        assert.strictEqual(test.tokenRequests(), 0);
    }));

    it('Keycloak enrollment reconciles by immutable AVA identity, never exposes or stores a password', () => environment(async () => {
        createTestDB();
        const invitation = Identity.createInvitation(platform, { email: 'owner@example.test' });
        let native, secretWrites = 0, authRequests = 0;
        const admin = new KeycloakAdmin({ request: async ({ method, url, data }) => {
            if (url.endsWith('/token')) { authRequests++; return { data: { access_token: 'fixture-native-admin', expires_in: 300 } }; }
            if (method === 'GET' && url.includes('?username=')) return { data: native ? [native] : [] };
            if (method === 'GET' && url.includes('?email=')) return { data: native ? [native] : [] };
            if (method === 'POST' && url.endsWith('/users')) { native = { ...data, id: 'native-subject' }; return { data: null }; }
            if (url.endsWith('/reset-password')) { secretWrites++; assert.strictEqual(data.value, 'fixture-password-long'); return { data: null }; }
            if (method === 'PUT') { native = { ...native, ...data }; return { data: null }; }
            return { data: native };
        } });
        assert.deepStrictEqual(await admin.redeem(invitation.token, 'fixture-password-long'), { success: true });
        assert.strictEqual(native.emailVerified, false);
        assert.deepStrictEqual(native.requiredActions, ['VERIFY_EMAIL']);
        assert.strictEqual(secretWrites, 1);
        assert.strictEqual(authRequests, 1);
        assert.ok(Identity.session(Identity.createSession('native-subject')));
        assert.strictEqual(JSON.stringify(DB.all('SELECT * FROM ava_users')).includes('fixture-password'), false);
        await assert.rejects(admin.redeem(invitation.token, 'fixture-password-long'), { code: 'INVITATION_INVALID' });
        process.env.AVA_PROCESS_ROLE = 'web';
        assert.throws(() => admin.config(), { code: 'IDENTITY_WORKER_REQUIRED' });
    }));

    it('native revoke queue survives a crash, bounds retries, and does not fake module logout', () => environment(async () => {
        createTestDB();
        const invitation = Identity.createInvitation(platform, { email: 'owner@example.test' });
        const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), 'native-owner');
        const hotel = Provisioning.createBusinessAtomic({ name: 'Private hotel' }, { ownerUserId: user.userId }).instance;
        DB.run("INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url) VALUES (?,?,'https://knowledge.example.test')", [hotel.id, `hotel_${hotel.id}`]);
        Identity.revokeUser(platform, user.userId);
        const calls = [];
        const admin = { call: async (method, path) => { calls.push([method,path]); return path.endsWith('/sessions') ? [] : { id: 'native-owner', attributes: { avaUserId: [user.userId] } }; } };
        await Revocations.processOne({ admin });
        const pending = DB.get('SELECT * FROM ava_identity_outbox');
        assert.strictEqual(pending.state, 'pending');
        assert.strictEqual(pending.keycloakRevoked, 1);
        assert.strictEqual(pending.lastErrorCode, 'NATIVE_MODULE_REVOCATION_NOT_VERIFIED');
        assert.ok(calls.some(item => item[0] === 'POST' && item[1].endsWith('/logout')));
        DB.run("UPDATE ava_identity_outbox SET state='leased',leasedUntil=0,attempts=8");
        assert.strictEqual(Revocations.lease(), null);
        assert.strictEqual(DB.get('SELECT state FROM ava_identity_outbox').state, 'failed');
    }));

    it('revocation during native enrollment wins and persists compensating logout', () => environment(async () => {
        createTestDB();
        const invitation = Identity.createInvitation(platform, { email: 'race@example.test' });
        let native, logouts = 0;
        const admin = new KeycloakAdmin({ request: async ({ method, url, data }) => {
            if (url.endsWith('/token')) return { data: { access_token: 'fixture-admin', expires_in: 300 } };
            if (url.includes('?username=')) return { data: native ? [native] : [] };
            if (method === 'GET' && url.includes('?email=')) return { data: native ? [native] : [] };
            if (method === 'POST' && url.endsWith('/users')) { native = { ...data, id: 'race-subject' }; return { data: null }; }
            if (url.endsWith('/reset-password')) return { data: null };
            if (method === 'PUT') {
                native = { ...native, ...data };
                if (data.enabled === true) Identity.revokeUser(platform, native.attributes.avaUserId[0]);
                return { data: null };
            }
            if (url.endsWith('/logout')) { logouts++; return { data: null }; }
            return { data: native };
        } });
        await assert.rejects(admin.redeem(invitation.token, 'fixture-password-long'), { code: 'INVITATION_LEASE_LOST' });
        assert.strictEqual(native.enabled, false);
        assert.strictEqual(logouts, 1);
        assert.strictEqual(DB.get('SELECT subject,enabled FROM ava_users').enabled, 0);
        assert.strictEqual(DB.get('SELECT subject FROM ava_users').subject, native.id);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_identity_outbox').n, 1);
        assert.throws(() => Identity.createSession(native.id));
    }));

    it('recovery invitation revokes old sessions immediately and waits for native revocation', () => environment(async () => {
        createTestDB();
        const first = Identity.createInvitation(platform, { email: 'owner@example.test' });
        const user = Identity.completeInvitation(Identity.claimInvitation(first.token), 'native-owner');
        const token = Identity.createSession(user.subject);
        const replacement = Identity.reissueInvitation(platform, user.userId);
        assert.strictEqual(Identity.session(token), null);
        assert.throws(() => Identity.claimInvitation(first.token), { code: 'INVITATION_INVALID' });
        assert.throws(() => Identity.claimInvitation(replacement.token), { code: 'PREVIOUS_ACCESS_REVOCATION_PENDING' });
        await Revocations.processOne({ admin: { call: async (_method, path) => path.endsWith('/sessions') ? []
            : { id: 'native-owner', attributes: { avaUserId: [user.userId] } } } });
        const restored = Identity.completeInvitation(Identity.claimInvitation(replacement.token), 'native-owner');
        assert.strictEqual(restored.userId, user.userId);
    }));

    it('customer routes reject foreign scope, native-key settings, and unknown administrative endpoints', () => environment(async () => {
        createTestDB();
        const invitation = Identity.createInvitation(platform, { email: 'owner@example.test' });
        const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), 'native-owner');
        const hotel = Provisioning.createBusinessAtomic({ name: 'Hotel' }, { ownerUserId: user.userId }).instance;
        const call = (method, path, params, body = {}) => {
            let status = 200, passed = false;
            const req = { auth: user, params, body, query: {},
                headers: { origin: 'https://ava.example.test' },
                protocol: 'https', get(name) { return name === 'host' ? 'ava.example.test' : undefined; } };
            Access.forRoute(method,path)(req, { status(code) { status=code; return this; }, json() {} }, () => { passed=true; });
            return { status, passed, body: req.body };
        };
        assert.strictEqual(call('get','/instances/:id/provisioning',{ id: hotel.id + 1 }).status, 403);
        assert.strictEqual(call('put','/instances/:id',{ id: hotel.id },{ businessId: hotel.id + 1 }).status, 403);
        assert.strictEqual(call('post','/admin/anything',{}).status, 403);
        const allowed = call('put','/instances/:id',{ id: hotel.id },{ name: 'New name', openWaApiKey: 'attacker', knowledgeBaseInstanceId: 99, sipTrunkNumber: 'foreign-trunk', voiceContextName: 'other_hotel', openWaStatus: 'ready' });
        assert.ok(allowed.passed);
        assert.deepStrictEqual(allowed.body, { name: 'New name' });
        const crossOrigin = { auth: user, params: { id: hotel.id }, body: { systemPrompt: 'Injected' },
            query: {}, headers: { origin: 'https://other.example.test' }, protocol: 'https',
            get(name) { return name === 'host' ? 'ava.example.test' : undefined; } };
        let crossOriginStatus = 200;
        Access.forRoute('put','/instances/:id')(crossOrigin,
            { status(code) { crossOriginStatus = code; return this; }, json() {} },
            () => { throw new Error('Cross-origin mutation passed'); });
        assert.strictEqual(crossOriginStatus, 403);
        DB.run("UPDATE ava_business_memberships SET role='manager' WHERE userId=?", [user.userId]);
        assert.strictEqual(call('get','/openwa/qr/:instanceId',{ instanceId: hotel.id }).status, 403);
        assert.strictEqual(Access.CUSTOMER_FIELDS.has('sipTrunkNumber'), false);
        assert.deepStrictEqual(Access.filterInstances([{ ...hotel, openWaApiKey: 'secret' }, { id: hotel.id + 1 }], user),
            [Object.fromEntries(Object.entries(hotel).filter(([key]) => Access.CUSTOMER_FIELDS.has(key)))]);
    }));

    it('customer profile DTO preserves Caller ID and SIP aliases without exposing or accepting trunk runtime identity', () => environment(async () => {
        createTestDB();
        const invitation = Identity.createInvitation(platform, { email: 'owner@example.test' });
        const user = Identity.completeInvitation(Identity.claimInvitation(invitation.token), 'native-owner');
        const hotel = Provisioning.createBusinessAtomic({ name: 'Hotel' }, { ownerUserId: user.userId }).instance;
        await DB.updateInstance(hotel.id, {
            sipCallerId: '79000000000',
            sipAliases: JSON.stringify(['74951234567', '1001']),
            sipTrunkNumber: 'runtime-trunk-registration-id',
            systemPrompt: 'Отвечай кратко и по базе знаний.',
        });

        // Exercise the production app's middleware and router order rather
        // than a test-only reconstruction of the profile endpoint.
        const Auth = require('../src/services/auth.service');
        const app = require('../src/app').app;
        const originalGetSession = Auth.getSession;
        const originalEnabled = Auth.config.enabled;
        Auth.config.enabled = true;
        Auth.getSession = () => user;
        const server = await new Promise(resolve => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        const origin = `http://127.0.0.1:${server.address().port}`;
        try {
            const readResponse = await fetch(`${origin}/api/hotel-profiles/${hotel.id}`);
            assert.strictEqual(readResponse.status, 200);
            const read = await readResponse.json();
            assert.strictEqual(read.profile.sipCallerId, '79000000000');
            assert.deepStrictEqual(read.profile.sipAliases, ['74951234567', '1001']);
            assert.strictEqual(read.profile.systemPrompt, 'Отвечай кратко и по базе знаний.');
            assert.strictEqual(Object.hasOwn(read.profile, 'sipTrunkNumber'), false);
            assert.strictEqual(Object.hasOwn(read.profile, 'pms'), false);
            assert.strictEqual(Object.hasOwn(read.profile, 'voiceContextName'), false);

            // This is the browser's actual no-edit path: the filtered GET DTO
            // is serialized back intact. Runtime fields injected by a client
            // are still removed before HotelProfileService sees the patch.
            const formPayload = { ...read.profile,
                sipTrunkNumber: 'attacker-trunk', voiceContextName: 'foreign-context',
                systemPrompt: 'Уточняй даты поездки.' };
            const writeResponse = await fetch(`${origin}/api/hotel-profiles/${hotel.id}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(formPayload),
            });
            assert.strictEqual(writeResponse.status, 200);
            const write = await writeResponse.json();
            assert.strictEqual(write.profile.sipCallerId, '79000000000');
            assert.deepStrictEqual(write.profile.sipAliases, ['74951234567', '1001']);
            assert.strictEqual(Object.hasOwn(write.profile, 'sipTrunkNumber'), false);
            const persisted = await DB.getInstance(hotel.id);
            assert.strictEqual(persisted.sipCallerId, '79000000000');
            assert.strictEqual(persisted.sipTrunkNumber, 'runtime-trunk-registration-id');
            assert.strictEqual(persisted.systemPrompt, 'Уточняй даты поездки.');

            // An older/partial customer DTO must not turn fields it did not
            // send into empty strings on an unrelated settings save.
            const partialFormPayload = { ...read.profile, hotelTone: 'calm' };
            delete partialFormPayload.sipCallerId;
            delete partialFormPayload.sipAliases;
            const partialResponse = await fetch(`${origin}/api/hotel-profiles/${hotel.id}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(partialFormPayload),
            });
            assert.strictEqual(partialResponse.status, 200);
            const partialSaved = (await partialResponse.json()).profile;
            assert.strictEqual(partialSaved.sipCallerId, '79000000000');
            assert.deepStrictEqual(partialSaved.sipAliases, ['74951234567', '1001']);
        } finally {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            Auth.getSession = originalGetSession;
            Auth.config.enabled = originalEnabled;
        }
    }));
});
