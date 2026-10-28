'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const Onboarding = require('../src/services/onboarding-state.service');

function fixture() {
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Onboarding business'),(2,'Second owned business'),(3,'Foreign business')");
    const users = {};
    for (const role of ['hotel_owner', 'other_owner', 'manager', 'observer', 'platform_admin']) {
        DB.run(`INSERT INTO ava_users(id,subject,email,displayName,platformRole) VALUES (?,?,?,?,?)`,
            [role, `${role}-subject`, `${role}@example.test`, role, role === 'platform_admin' ? role : 'customer']);
        if (role !== 'platform_admin') DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES (?,1,?)',
            [role, role === 'other_owner' ? 'hotel_owner' : role]);
        users[role] = { actor: Identity.actor(role), token: Identity.createSession(`${role}-subject`, `${role}-sid`) };
    }
    DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES ('hotel_owner',2,'hotel_owner')");
    return users;
}

function service(run) {
    const users = fixture();
    try { return run(users); } finally { DB.db.close(); }
}

async function runtime(run, { authEnabled = true, boundary = true } = {}) {
    const users = fixture();
    const oldEnabled = Auth.config.enabled;
    const oldCustomer = process.env.AVA_CUSTOMER_ACCESS_ENABLED;
    const oldUrl = process.env.WHATSAPP_CRM_PUBLIC_URL;
    Auth.config.enabled = authEnabled;
    process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
    process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
    const app = express();
    app.use(express.json());
    app.use('/api', Auth.requireAuth.bind(Auth));
    app.use('/api', require('../src/routes/onboarding-state.routes'));
    if (boundary) app.use('/api', require('../src/services/identity/customer-role-boundary'));
    let leaked = 0;
    app.all('/api/businesses/:businessId/onboarding/unreviewed', (_req, res) => { leaked++; res.json({ success: true }); });
    app.post('/api/unreviewed', (_req, res) => { leaked++; res.json({ success: true }); });
    const listener = await new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
    const request = (role, suffix = '', method = 'GET', body, headers = {}, businessId = 1) => fetch(
        `http://127.0.0.1:${listener.address().port}/api/businesses/${businessId}/onboarding${suffix}`, {
            method,
            headers: { ...(role ? { Cookie: `crm_session=ava2:${users[role].token}` } : {}),
                Origin: 'https://ava.example.test', 'Content-Type': 'application/json', ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    try { await run({ users, request, leaked: () => leaked }); }
    finally {
        await new Promise(resolve => listener.close(resolve));
        Auth.config.enabled = oldEnabled;
        if (oldCustomer === undefined) delete process.env.AVA_CUSTOMER_ACCESS_ENABLED;
        else process.env.AVA_CUSTOMER_ACCESS_ENABLED = oldCustomer;
        if (oldUrl === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
        else process.env.WHATSAPP_CRM_PUBLIC_URL = oldUrl;
        DB.db.close();
    }
}

describe('Business onboarding: durable owner acknowledgements', () => {
    it('persists source/manual preparation with readback, isolation and stale edit protection without completing onboarding', () => service(users => {
        const owner = users.hotel_owner.actor;
        const saved = Onboarding.savePreparation(owner, 1, { revision: 0, links: ['https://example.com'], supplement: 'Confirmed services' });
        assert.strictEqual(saved.revision, 1);
        assert.deepStrictEqual(Onboarding.preparation(owner, 1), saved);
        assert.deepStrictEqual(Onboarding.preparation(owner, 2).links, []);
        assert.strictEqual(Onboarding.get(owner, 1).status, 'pending');
        assert.throws(() => Onboarding.savePreparation(owner, 1, { revision: 0, links: [], supplement: 'stale' }), { code: 'ONBOARDING_PREPARATION_CHANGED' });
        assert.throws(() => Onboarding.savePreparation(users.manager.actor, 1, { revision: 1, links: [], supplement: '' }), { code: 'ONBOARDING_OWNER_REQUIRED' });
        assert.throws(() => Onboarding.savePreparation(owner, 1, { revision: 1, links: ['http://127.0.0.1'], supplement: '' }), { code: 'ONBOARDING_REQUEST_INVALID' });
    }));
    it('does not create progress by reading or permit completion with missing acknowledgements', () => service(users => {
        assert.deepStrictEqual(Onboarding.get(users.hotel_owner.actor, 1), {
            businessId: 1, status: 'pending', confirmedSteps: [], completedAt: null,
        });
        assert.throws(() => Onboarding.complete(users.hotel_owner.actor, 1), { code: 'ONBOARDING_STEPS_REQUIRED', statusCode: 409 });
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM ava_business_onboarding').n, 0);
        Onboarding.confirmStep(users.hotel_owner.actor, 1, 'review');
        assert.throws(() => Onboarding.complete(users.hotel_owner.actor, 1), { code: 'ONBOARDING_STEPS_REQUIRED' });
    }));

    it('requires explicit completion after all steps and keeps completion and audit immutable across owners', () => service(users => {
        for (const step of Onboarding.STEPS) Onboarding.confirmStep(users.hotel_owner.actor, 1, step);
        assert.strictEqual(Onboarding.get(users.hotel_owner.actor, 1).status, 'pending');
        const done = Onboarding.complete(users.hotel_owner.actor, 1);
        assert.strictEqual(done.status, 'completed');
        assert.ok(!Number.isNaN(Date.parse(done.completedAt)));
        const row = DB.get('SELECT * FROM ava_business_onboarding WHERE businessId=1');
        assert.strictEqual(row.completedBy, 'hotel_owner');
        assert.deepStrictEqual(Onboarding.complete(users.other_owner.actor, 1), done);
        assert.deepStrictEqual(Onboarding.confirmStep(users.other_owner.actor, 1, 'business'), done);
        assert.deepStrictEqual(DB.get('SELECT * FROM ava_business_onboarding WHERE businessId=1'), row);
        assert.deepStrictEqual(Onboarding.get(users.manager.actor, 1), done);
        assert.deepStrictEqual(Onboarding.get(users.hotel_owner.actor, 2).confirmedSteps, []);
    }));

    it('keeps repeated step confirmations idempotent and rejects invalid steps and scope aliases', () => service(users => {
        const first = Onboarding.confirmStep(users.hotel_owner.actor, 1, 'business');
        const row = DB.get('SELECT * FROM ava_business_onboarding WHERE businessId=1');
        assert.deepStrictEqual(Onboarding.confirmStep(users.hotel_owner.actor, 1, 'business'), first);
        assert.deepStrictEqual(DB.get('SELECT * FROM ava_business_onboarding WHERE businessId=1'), row);
        assert.throws(() => Onboarding.confirmStep(users.hotel_owner.actor, 1, 'skip'), { code: 'ONBOARDING_STEP_INVALID' });
        for (const id of ['01', '1e0', '1.0', ' 1', [1], 0, -1, '9007199254740992']) {
            assert.throws(() => Onboarding.get(users.hotel_owner.actor, id), { code: 'BUSINESS_SCOPE_REQUIRED' });
        }
    }));

    it('persists completed state across actual database close and reopen', async () => {
        const users = fixture();
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-onboarding-'));
        const databasePath = path.join(directory, 'state.sqlite');
        try {
            for (const step of Onboarding.STEPS) Onboarding.confirmStep(users.hotel_owner.actor, 1, step);
            const done = Onboarding.complete(users.hotel_owner.actor, 1);
            await DB.db.backup(databasePath);
            DB.db.close();
            DB.db = new Database(databasePath);
            DB.db.pragma('foreign_keys = ON');
            assert.deepStrictEqual(Onboarding.get(users.hotel_owner.actor, 1), done);
            assert.strictEqual(Onboarding.get(users.hotel_owner.actor, 2).status, 'pending');
            assert.strictEqual(DB.get('SELECT completedBy FROM ava_business_onboarding WHERE businessId=1').completedBy, 'hotel_owner');
        } finally {
            if (DB.db.open) DB.db.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});

describe('Onboarding HTTP: live session, exact scope and default-deny boundary', () => {
    it('allows member/admin reads, only owner mutations, and rejects cross-business access', async () => runtime(async ({ request }) => {
        for (const role of ['hotel_owner', 'other_owner', 'manager', 'observer', 'platform_admin']) {
            assert.strictEqual((await request(role)).status, 200, role);
            assert.strictEqual((await request(role, '/steps/business', 'POST', {})).status,
                ['hotel_owner', 'other_owner'].includes(role) ? 200 : 403, role);
        }
        assert.strictEqual((await request('hotel_owner', '', 'GET', undefined, {}, 2)).status, 200);
        assert.strictEqual((await request('hotel_owner', '', 'GET', undefined, {}, 3)).status, 403);
        assert.strictEqual((await request('manager', '/complete', 'POST', {})).status, 403);
        assert.strictEqual((await request('platform_admin', '/complete', 'POST', {})).status, 403);
        assert.strictEqual((await request('platform_admin', '', 'GET', undefined, {}, 3)).status, 200);
    }));

    it('completes via explicit HTTP acknowledgements, survives new session and isolates business switching', async () => runtime(async ({ request, users }) => {
        let response = await request('hotel_owner', '/complete', 'POST', {});
        assert.strictEqual(response.status, 409);
        assert.strictEqual((await response.json()).code, 'ONBOARDING_STEPS_REQUIRED');
        for (const step of Onboarding.STEPS) {
            response = await request('hotel_owner', `/steps/${step}`, 'POST');
            assert.strictEqual(response.status, 200);
            assert.strictEqual((await response.json()).onboarding.status, 'pending');
        }
        const done = (await (await request('hotel_owner', '/complete', 'POST', {})).json()).onboarding;
        assert.strictEqual(done.status, 'completed');
        users.hotel_owner.token = Identity.createSession('hotel_owner-subject', 'new-login');
        assert.deepStrictEqual((await (await request('hotel_owner')).json()).onboarding, done);
        assert.deepStrictEqual((await (await request('other_owner')).json()).onboarding, done);
        assert.strictEqual((await (await request('hotel_owner', '', 'GET', undefined, {}, 2)).json()).onboarding.status, 'pending');
        assert.deepStrictEqual((await (await request('hotel_owner')).json()).onboarding, done);
    }));

    it('rechecks demotion, membership revocation, inactive business and disabled account with cached cookies', async () => runtime(async ({ request }) => {
        assert.strictEqual((await request('hotel_owner', '/steps/business', 'POST')).status, 200);
        DB.run("UPDATE ava_business_memberships SET role='manager' WHERE userId='hotel_owner' AND businessId=1");
        assert.strictEqual((await request('hotel_owner', '/steps/voice', 'POST')).status, 403);
        assert.strictEqual((await request('hotel_owner')).status, 200);
        DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='hotel_owner' AND businessId=1");
        assert.strictEqual((await request('hotel_owner')).status, 403);
        DB.run('UPDATE instances SET isActive=0 WHERE id=1');
        assert.strictEqual((await request('other_owner')).status, 403);
        assert.strictEqual((await request('platform_admin')).status, 404);
        DB.run("UPDATE ava_users SET enabled=0 WHERE id='manager'");
        assert.ok([401, 403].includes((await request('manager')).status));
        assert.deepStrictEqual(JSON.parse(DB.get('SELECT confirmedSteps FROM ava_business_onboarding').confirmedSteps), ['business']);
    }));

    it('rejects revoked sessions and anonymous requests before returning or changing progress', async () => runtime(async ({ request }) => {
        assert.strictEqual((await request(null)).status, 401);
        DB.run("UPDATE ava_sessions SET revokedAt=? WHERE userId='hotel_owner'", [Date.now()]);
        assert.strictEqual((await request('hotel_owner')).status, 401);
        assert.strictEqual((await request('hotel_owner', '/steps/business', 'POST')).status, 401);
    }));

    it('guards itself when global auth/boundary are disabled and denies forged caller roles', async () => runtime(async ({ request }) => {
        assert.strictEqual((await request(null)).status, 401);
        assert.strictEqual((await request(null, '/steps/business', 'POST', {}, { 'X-User-Id': 'hotel_owner' })).status, 401);
        assert.strictEqual((await request('manager', '/steps/business', 'POST', { role: 'hotel_owner' })).status, 400);
        assert.strictEqual((await request('manager', '/steps/business', 'POST', {})).status, 403);
        assert.strictEqual((await request('hotel_owner', '/steps/business', 'POST', {})).status, 200);
    }, { authEnabled: false, boundary: false }));

    it('rejects unexpected body/query and numeric aliases without creating a row', async () => runtime(async ({ request }) => {
        for (const body of [{ businessId: 2 }, { instanceId: 1 }, { completed: true }, { confirmedSteps: Onboarding.STEPS }, []]) {
            assert.strictEqual((await request('hotel_owner', '/steps/business', 'POST', body)).status, 400);
        }
        for (const suffix of ['?businessId=2', '?instanceId=1', '?cache=123']) {
            assert.strictEqual((await request('hotel_owner', suffix)).status, 400);
        }
        assert.strictEqual((await request('hotel_owner', '/steps/business', 'POST', {}, { 'Content-Type': 'text/plain' })).status, 400);
        for (const scope of ['01', '1e0', '1.0', '0', '-1', '9007199254740992']) {
            assert.strictEqual((await request('hotel_owner', '', 'GET', undefined, {}, scope)).status, 400, scope);
        }
        assert.strictEqual((await request('hotel_owner', '/steps/skip', 'POST', {})).status, 400);
        Onboarding.ensureSchema();
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM ava_business_onboarding').n, 0);
    }));

    it('requires same-origin mutations and leaves unreviewed paths denied by the boundary', async () => runtime(async ({ request, leaked }) => {
        for (const headers of [{ Origin: '' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
            assert.strictEqual((await request('hotel_owner', '/steps/business', 'POST', {}, headers)).status, 403);
        }
        for (const role of ['hotel_owner', 'manager', 'observer']) {
            assert.strictEqual((await request(role, '/unreviewed', 'POST', {})).status, 403);
            assert.strictEqual((await request(role, '/steps/business', 'PUT', {})).status, 403);
        }
        assert.strictEqual(leaked(), 0);
        assert.strictEqual((await request('hotel_owner', '/steps/business', 'POST', {}, { 'Sec-Fetch-Site': 'same-origin' })).status, 200);
    }));

    it('returns only fixed public outage codes on unexpected storage failures', async () => runtime(async ({ request }) => {
        const original = DB.get;
        DB.get = function (sql, ...args) {
            if (sql.startsWith('SELECT confirmedSteps,completedAt')) throw new Error('private provider credential fixture');
            return original.call(this, sql, ...args);
        };
        try {
            const response = await request('hotel_owner');
            const text = await response.text();
            assert.strictEqual(response.status, 503);
            assert.strictEqual(JSON.parse(text).code, 'ONBOARDING_UNAVAILABLE');
            assert.ok(!text.includes('private provider credential fixture'));
        } finally { DB.get = original; }
    }));
});
