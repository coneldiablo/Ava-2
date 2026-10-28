const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Access = require('../src/services/identity/customer-access');
const draftPath = '/hotel-profiles/:id/assistant-draft';
function fixture(role = 'hotel_owner') {
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Own'),(2,'Foreign')");
    const invite = Identity.createInvitation({ platformRole: 'platform_admin' },
        { email: 'draft@example.test', businessId: 1, role });
    return Identity.completeInvitation(Identity.claimInvitation(invite.token), 'draft-subject');
}
function authorize(actor, method, path = draftPath, options = {}) {
    let passed = false, status = 200, payload;
    const req = { auth: actor, params: { id: options.id ?? '1' }, query: options.query || {},
        body: options.body || {}, headers: { origin: 'https://ava.example.test', ...options.headers } };
    const previous = process.env.WHATSAPP_CRM_PUBLIC_URL;
    process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
    const res = { status(value) { status = value; return this; }, json(value) { payload = value; return this; } };
    try { Access.forRoute(method, path)(req, res, () => { passed = true; }); }
    finally {
        if (previous === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
        else process.env.WHATSAPP_CRM_PUBLIC_URL = previous;
    }
    return { passed, status, payload, req, res, response: () => payload };
}
describe('Assistant draft customer boundary', () => {
    it('allows member reads, reserves both mutations to owners and denies foreign tenants', () => {
        const manager = fixture('manager');
        assert.strictEqual(authorize(manager, 'get').passed, true);
        assert.strictEqual(authorize(manager, 'post').status, 403);
        assert.strictEqual(authorize(manager, 'post', draftPath + '/approve').status, 403);
        assert.strictEqual(authorize(manager, 'get', draftPath, { id: '2' }).status, 403);
        const owner = fixture();
        assert.strictEqual(authorize(owner, 'post').passed, true);
        assert.strictEqual(authorize(owner, 'post', draftPath + '/approve', { id: '2' }).status, 403);
        for (const id of ['0', '-1', 'abc', '1.1', '9007199254740992']) {
            assert.strictEqual(authorize(owner, 'get', draftPath, { id }).status, 400);
        }
    });
    it('requires same-origin writes and rejects body/query scope and model overrides', () => {
        const owner = fixture();
        for (const headers of [{ origin: undefined }, { origin: 'https://evil.test' },
            { 'sec-fetch-site': 'cross-site' }]) {
            assert.strictEqual(authorize(owner, 'post', draftPath, { headers }).status, 403);
            assert.strictEqual(authorize(owner, 'post', draftPath + '/approve', { headers }).status, 403);
        }
        for (const method of ['get', 'post']) for (const source of ['body', 'query']) {
            for (const field of ['businessId', 'business_id', 'instanceId', 'instance_id']) {
                assert.strictEqual(authorize(owner, method, draftPath, { [source]: { [field]: 2 } }).status, 403);
            }
            for (const field of ['model', 'modelId', 'clientId', 'customer_id']) {
                assert.strictEqual(authorize(owner, method, draftPath, { [source]: { [field]: 1 } }).status, 403);
            }
        }
    });
    it('passes only input fields and filters the authoritative approval profile', () => {
        const owner = fixture();
        const generation = authorize(owner, 'post', draftPath, { body: {
            links: ['https://example.test'], supplement: 'Details', voiceName: 'override', systemPrompt: 'active', businessId: 1 } });
        assert.deepStrictEqual(generation.req.body, { links: ['https://example.test'], supplement: 'Details' });
        const approval = authorize(owner, 'post', draftPath + '/approve', { body: {
            draftId: 'draft-id', systemPrompt: 'Edited', settings: { hotelTone: 'Friendly' }, links: [], openRouterKey: 'secret' } });
        assert.deepStrictEqual(approval.req.body, { draftId: 'draft-id', systemPrompt: 'Edited', settings: { hotelTone: 'Friendly' } });
        approval.res.json({ success: true, businessId: 1, draft: { id: 'draft-id' },
            profile: { id: 1, systemPrompt: 'Edited', voiceName: 'Original', openRouterKey: 'secret' } });
        assert.deepStrictEqual(approval.response().profile, { id: 1, systemPrompt: 'Edited', voiceName: 'Original' });
        assert.strictEqual(authorize(owner, 'delete').status, 403);
    });
    it('preserves explicitly approved settings for validation and rejects nested provider overrides', async () => {
        const owner = fixture();
        const Service = require('../src/services/assistant-draft.service');
        const AI = require('../src/services/ai.service');
        const generate = AI.generatePlainText;
        AI.generatePlainText = async () => JSON.stringify({ systemPrompt: 'Business assistant instruction' });
        try {
            const draft = await Service.generate(1, { links: [], supplement: 'Business offers repair services in Moscow.' });
            const blocked = authorize(owner, 'post', draftPath + '/approve', { body: {
                draftId: draft.id, systemPrompt: 'Edited', settings: { voiceAiProvider: 'other' } } });
            assert.strictEqual(blocked.passed, true);
            assert.throws(() => Service.approve(1, blocked.req.body), e => e.code === 'INVALID_DRAFT_SETTINGS');
            assert.strictEqual(Service.get(1).status, 'draft');
            const approval = authorize(owner, 'post', draftPath + '/approve', { body: {
                draftId: draft.id, systemPrompt: 'Edited', settings: { hotelTone: 'Friendly' } } });
            assert.strictEqual(Service.approve(1, approval.req.body).profile.hotelTone, 'Friendly');
            assert.notStrictEqual((await DB.getInstance(2)).hotelTone, 'Friendly');
        } finally { AI.generatePlainText = generate; }
    });
    it('returns HTTP draft contracts and hides unexpected service exceptions', async () => {
        const owner = fixture();
        const Auth = require('../src/services/auth.service');
        const Service = require('../src/services/assistant-draft.service');
        const app = require('../src/app').app;
        const old = { enabled: Auth.config.enabled, access: process.env.AVA_CUSTOMER_ACCESS_ENABLED,
            origin: process.env.WHATSAPP_CRM_PUBLIC_URL, get: Service.get };
        Auth.config.enabled = true;
        process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
        const token = Identity.createSession(owner.subject, 'draft-http-session');
        const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
        const origin = `http://127.0.0.1:${server.address().port}`;
        process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
        let calls = 0;
        Service.get = async id => { calls++; assert.strictEqual(id, 1); return null; };
        const request = id => fetch(`${origin}/api/hotel-profiles/${id}/assistant-draft`, {
            headers: { Cookie: `crm_session=ava2:${token}` } });
        try {
            const read = await request(1);
            assert.strictEqual(read.status, 200);
            assert.deepStrictEqual(await read.json(), { success: true, businessId: 1, draft: null });
            assert.strictEqual((await request(2)).status, 403);
            assert.strictEqual(calls, 1);
            Service.get = async () => { throw new Error('provider-secret'); };
            const failed = await request(1);
            assert.strictEqual(failed.status, 500);
            assert.strictEqual((await failed.text()).includes('provider-secret'), false);
            Service.get = async () => { throw Object.assign(new Error('internal'), {
                statusCode: 409, code: 'ASSISTANT_DRAFT_BUSY', publicMessage: 'Try later' }); };
            const busy = await request(1);
            assert.strictEqual(busy.status, 409);
            assert.deepStrictEqual(await busy.json(), { success: false, error: 'ASSISTANT_DRAFT_BUSY', message: 'Try later' });
        } finally {
            Auth.config.enabled = old.enabled; Service.get = old.get;
            for (const [key, value] of [['AVA_CUSTOMER_ACCESS_ENABLED', old.access], ['WHATSAPP_CRM_PUBLIC_URL', old.origin]]) {
                if (value === undefined) delete process.env[key]; else process.env[key] = value;
            }
            await new Promise(resolve => server.close(resolve));
        }
    });

});
