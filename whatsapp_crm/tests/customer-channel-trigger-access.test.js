const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Access = require('../src/services/identity/customer-access');
const Auth = require('../src/services/auth.service');
const app = require('../src/app').app;

function actor(role) {
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Own hotel'),(2,'Other hotel')");
    const invite = Identity.createInvitation({ platformRole: 'platform_admin' },
        { email: `${role}@example.test`, businessId: 1, role });
    return Identity.completeInvitation(Identity.claimInvitation(invite.token), `${role}-subject`);
}

function check(auth, method, path, params, body = {}, origin = 'https://ava.example.test') {
    const previous = process.env.WHATSAPP_CRM_PUBLIC_URL;
    process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
    const req = { auth, params, body, query: {}, headers: { origin } };
    let passed = false, status = 200;
    try {
        Access.forRoute(method, path)(req, {
            status(value) { status = value; return this; }, json() {},
        }, () => { passed = true; });
    } finally {
        if (previous === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
        else process.env.WHATSAPP_CRM_PUBLIC_URL = previous;
    }
    return { passed, status, body: req.body };
}

describe('Customer channel and automation access', () => {
    it('accepts boolean sequence state through the customer API without changing tenant scope', async () => {
        const owner = actor('hotel_owner');
        const token = Identity.createSession(owner.subject, 'sequence-state-session');
        const previousEnabled = Auth.config.enabled;
        const previousCustomer = process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        Auth.config.enabled = true;
        process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
        const server = await new Promise(resolve => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        });
        try {
            const base = `http://127.0.0.1:${server.address().port}`;
            const headers = { Cookie: `crm_session=ava2:${token}`, Origin: base,
                'Content-Type': 'application/json' };
            const created = await fetch(`${base}/api/sequences/1`, {
                method: 'POST', headers, body: JSON.stringify({ name: 'Paused', isActive: false }),
            });
            assert.strictEqual(created.status, 200);
            const sequence = (await created.json()).sequence;
            assert.strictEqual(Number(sequence.isActive), 0);
            const foreign = await fetch(`${base}/api/sequences/2/${sequence.id}`, {
                method: 'PUT', headers, body: JSON.stringify({ isActive: true }),
            });
            assert.strictEqual(foreign.status, 403);
            const activated = await fetch(`${base}/api/sequences/1/${sequence.id}`, {
                method: 'PUT', headers, body: JSON.stringify({ isActive: true }),
            });
            assert.strictEqual(activated.status, 200);
            assert.strictEqual(Number((await activated.json()).sequence.isActive), 1);
        } finally {
            await new Promise(resolve => server.close(resolve));
            Auth.config.enabled = previousEnabled;
            if (previousCustomer === undefined) delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;
            else process.env.AVA_CUSTOMER_ACCESS_ENABLED = previousCustomer;
        }
    });

    it('lets a hotel owner configure only their own channels and filters unreviewed fields', () => {
        const owner = actor('hotel_owner');
        assert.ok(check(owner, 'get', '/channels/:instanceId/status', { instanceId: '1' }).passed);
        assert.strictEqual(check(owner, 'get', '/channels/:instanceId/status', { instanceId: '2' }).status, 403);
        const own = check(owner, 'put', '/channels/:instanceId/config', { instanceId: '1' },
            { telegramBotToken: 'token', businessId: 1, openWaSessionId: 'foreign' });
        assert.ok(own.passed);
        assert.deepStrictEqual(own.body, { telegramBotToken: 'token' });
        assert.strictEqual(check(owner, 'put', '/channels/:instanceId/config', { instanceId: '2' },
            { telegramBotToken: 'token' }).status, 403);
        assert.strictEqual(check(owner, 'put', '/channels/:instanceId/config', { instanceId: '1' },
            { telegramBotToken: 'token', businessId: 2 }).status, 403);
        assert.strictEqual(check(owner, 'put', '/channels/:instanceId/config', { instanceId: '1' },
            { telegramBotToken: 'token' }, 'https://evil.example').status, 403);
        assert.strictEqual(check(owner, 'post', '/channels/:instanceId/instagram/test',
            { instanceId: '1' }).status, 403);
        assert.ok(check(owner, 'delete', '/channels/:instanceId/:channel',
            { instanceId: '1', channel: 'telegram' }).passed);
        assert.strictEqual(check(owner, 'delete', '/channels/:instanceId/:channel',
            { instanceId: '2', channel: 'telegram' }).status, 403);
        assert.strictEqual(check(owner, 'delete', '/channels/:instanceId/:channel',
            { instanceId: '1', channel: 'whatsapp' }).status, 403);
    });

    it('permits manager reads but denies channel and automation changes', () => {
        const manager = actor('manager');
        for (const path of ['/channels/:instanceId/status', '/triggers/:instanceId',
            '/triggers/:instanceId/settings', '/triggers/:instanceId/log', '/sequences/:instanceId']) {
            assert.ok(check(manager, 'get', path, { instanceId: '1' }).passed, path);
            assert.strictEqual(check(manager, 'get', path, { instanceId: '2' }).status, 403, path);
        }
        for (const [method, path] of [
            ['put', '/channels/:instanceId/config'], ['post', '/channels/:instanceId/telegram/test'],
            ['delete', '/channels/:instanceId/:channel'],
            ['put', '/triggers/:instanceId/settings'], ['post', '/triggers/:instanceId'],
            ['post', '/sequences/:instanceId'],
        ]) assert.strictEqual(check(manager, method, path, { instanceId: '1', channel: 'telegram' }).status, 403, path);
    });

    it('checks persisted trigger, sequence and step parents before edits', () => {
        const owner = actor('hotel_owner');
        DB.run("INSERT INTO smart_triggers(id,instanceId,name,triggerType,actionType) VALUES (11,1,'Own','keyword','send_message'),(22,2,'Other','keyword','send_message')");
        DB.run("INSERT INTO message_sequences(id,instanceId,name) VALUES (33,1,'Own'),(44,2,'Other')");
        DB.run("INSERT INTO sequence_steps(id,sequenceId,stepOrder,messageTemplate) VALUES (55,33,1,'Own'),(66,44,1,'Other')");
        assert.ok(check(owner, 'put', '/triggers/:instanceId/:triggerId',
            { instanceId: '1', triggerId: '11' }, { name: 'Changed' }).passed);
        assert.strictEqual(check(owner, 'put', '/triggers/:instanceId/:triggerId',
            { instanceId: '1', triggerId: '22' }, { name: 'Changed' }).status, 404);
        assert.strictEqual(check(owner, 'delete', '/sequences/:instanceId/:seqId',
            { instanceId: '1', seqId: '44' }).status, 404);
        assert.ok(check(owner, 'put', '/sequences/:instanceId/:seqId',
            { instanceId: '1', seqId: '33' }, { isActive: 0 }).passed);
        assert.strictEqual(check(owner, 'put', '/sequences/:instanceId/:seqId',
            { instanceId: '1', seqId: '44' }, { isActive: 0 }).status, 404);
        const manager = Identity.completeInvitation(Identity.claimInvitation(
            Identity.createInvitation({ platformRole: 'platform_admin' },
                { email: 'sequence-manager@example.test', businessId: 1, role: 'manager' }).token
        ), 'sequence-manager-subject');
        assert.strictEqual(check(manager, 'put', '/sequences/:instanceId/:seqId',
            { instanceId: '1', seqId: '33' }, { isActive: 0 }).status, 403);
        assert.strictEqual(check(owner, 'put', '/sequences/:instanceId/:seqId/steps/:stepId',
            { instanceId: '1', seqId: '33', stepId: '66' }, { messageTemplate: 'Changed' }).status, 404);
        assert.strictEqual(check(owner, 'put', '/triggers/:instanceId/settings',
            { instanceId: '1' }, { smartTriggersEnabled: true, instanceId: 2 }).status, 403);
    });
});
