'use strict';
// Independent regression: real app, cookie sessions and in-memory SQLite.
// The catalog boundary is synthetic; no provider or provisioning work is dispatched.
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function bounded(promise) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('create acceptance did not reach the catalog boundary')), 5000);
        })]);
    } finally { clearTimeout(timer); }
}

function durableState() {
    return Object.fromEntries([
        ['instances', 'id'],
        ['ava_business_memberships', 'userId,businessId'],
        ['business_provisioning_jobs', 'id'],
        ['business_idempotency_keys', 'idempotencyKey'],
        ['business_sip_aliases', 'alias'],
    ].map(([table, order]) => [table, DB.all(`SELECT * FROM ${table} ORDER BY ${order}`)]));
}

describe('Independent Neuro Gemini business creation acceptance', () => {
    it('does not create a business, membership or provisioning jobs after its cookie is revoked during voice validation', async () => {
        createTestDB(); Identity.ensureSchema();
        DB.run("INSERT INTO instances(id,name,businessType) VALUES (1,'Create acceptance owner','hotel')");
        const invite = Identity.createInvitation({ platformRole: 'platform_admin' }, {
            email: 'create-owner@acceptance.example.test', businessId: 1, role: 'hotel_owner',
        });
        const owner = Identity.completeInvitation(Identity.claimInvitation(invite.token), 'create-acceptance-owner');
        DB.run('UPDATE ava_users SET businessQuota=4 WHERE id=?', [owner.userId]);
        const Auth = require('../src/services/auth.service');
        const Options = require('../src/services/voice-options.service');
        const previous = { enabled: Auth.config.enabled, getOptions: Options.getOptions };
        const keys = ['AVA_CUSTOMER_ACCESS_ENABLED', 'WHATSAPP_CRM_PUBLIC_URL'];
        const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
        const entered = deferred(), released = deferred();
        const sessions = [];
        let gated = false;
        let pending;
        let server;
        Auth.config.enabled = true; process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
        Options.getOptions = async () => {
            if (gated) { entered.resolve(); await released.promise; }
            return { providers: [{ id: 'neuro_gemini', available: true,
                models: [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }],
                voices: [{ id: 'edsel', label: 'Edsel' }],
            }] };
        };
        try {
            const app = require('../src/app').app;
            server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
            const origin = `http://127.0.0.1:${server.address().port}`;
            process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
            const session = () => {
                const token = Identity.createSession(owner.subject, 'create-acceptance-native-session');
                sessions.push(token); return token;
            };
            const create = (token, name, alias, idempotencyKey) => fetch(`${origin}/api/instances`, {
                method: 'POST',
                headers: { Cookie: `crm_session=ava2:${token}`, Origin: origin,
                    'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
                body: JSON.stringify({ name, sipAliases: [alias], voiceAiProvider: 'neuro_gemini',
                    voiceModel: 'gemini-3.8-flash', voiceName: 'edsel' }),
            });
            const controlToken = session();
            const beforeControl = await create(controlToken, 'Valid create before revocation', '91001', 'create-acceptance-before');
            assert.strictEqual(beforeControl.status, 200, 'valid voice setup must create a business before the revocation probe');
            assert.strictEqual((await beforeControl.json()).success, true);
            const before = durableState();

            const revokedToken = session(); gated = true;
            pending = create(revokedToken, 'Must never be created', '91002', 'create-acceptance-revoked');
            await bounded(entered.promise);
            Identity.revokeSession(revokedToken);
            assert.strictEqual(Identity.session(revokedToken), null);
            released.resolve();
            const denied = await bounded(pending);
            const deniedBody = await denied.json();
            const after = durableState();
            assert.strictEqual(denied.status, 403, `revoked cookie must stop creation; received ${denied.status} (success=${deniedBody.success})`);
            assert.strictEqual(deniedBody.success, false);
            assert.deepStrictEqual(after, before, 'revoked creation must preserve businesses, memberships, jobs, idempotency records and SIP aliases');

            gated = false;
            const afterControl = await create(session(), 'Valid create after revocation', '91003', 'create-acceptance-after');
            assert.strictEqual(afterControl.status, 200, 'a fresh session must still be able to create after the rejected request');
            assert.strictEqual((await afterControl.json()).success, true);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM instances').n, before.instances.length + 1);
        } finally {
            released.resolve();
            if (pending) await pending.catch(() => {});
            for (const token of sessions) Identity.revokeSession(token);
            if (server) await new Promise(resolve => server.close(resolve));
            Options.getOptions = previous.getOptions; Auth.config.enabled = previous.enabled;
            for (const key of keys) if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
        }
    });
});
