'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Flags = require('../src/services/ava-improvements-flags.service');
const Release = require('../src/services/ava-release-flags.service');
const Workspace = require('../src/services/ava-workspace.service');
const Router = require('../src/services/channel-router.service');
const express = require('express');

function setup() {
    createTestDB();
    Identity.ensureSchema();
    DB.createSalesWorkspaceTables();
    DB.run("INSERT INTO instances(id,name) VALUES(1,'Acceptance One'),(2,'Acceptance Two')");
    for (const [id, role, business] of [['owner','hotel_owner',1],['lead','sales_lead',1],['manager','manager',1],['reader','observer',1],['foreign','hotel_owner',2]]) {
        DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)', [id, id + '@example.test', 'Same display name']);
        DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [id, business, role]);
    }
    DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,'guest','Guest','manager'),(2,'guest','Other guest','foreign')");
    return Object.fromEntries(['owner','lead','manager','reader','foreign'].map(id => [id, Identity.actor(id)]));
}

async function environment(values, fn) {
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    try { return await fn(); }
    finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

async function http(auth, fn, { boundary = false } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.auth = auth; next(); });
    if (boundary) app.use('/api', require('../src/services/identity/customer-role-boundary'));
    app.use('/api', require('../src/routes/ava-improvements-flags.routes'));
    app.use('/api', require('../src/routes/ava-workspace.routes'));
    const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
        await environment({ WHATSAPP_CRM_PUBLIC_URL: origin }, () => fn(async (method, path, body, headers = {}) => {
            const response = await fetch(origin + '/api/businesses/1' + path, {
                method, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: response.status, body: await response.json() };
        }));
    } finally { await new Promise(resolve => server.close(resolve)); }
}

describe('Section 6 acceptance: improvement flags and legacy API compatibility', () => {
    it('defaults all improvements off without changing existing workspace controls or manual reply contract', () => environment({ AVA_IMPROVEMENTS_BUSINESSES: '', AVA_WORKSPACE_BUSINESSES: '*' }, async () => {
        const actor = setup();
        assert.strictEqual(Flags.overview(actor.reader, 1).available, false);
        assert.ok(Object.values(Flags.snapshot(1).flags).every(value => value === false));
        for (const feature of Flags.FEATURES) assert.throws(() => Flags.assertEnabled(1, feature), error => error.code === 'WORKSPACE_FEATURE_DISABLED');
        const send = Router.sendMessageDetailed;
        let sends = 0;
        Router.sendMessageDetailed = async (_business, _chat, _text, _channel, context) => {
            context.beforeSend();
            sends++;
            return { success: true, provider_message_id: 'acceptance-legacy-ack' };
        };
        try {
            await http(actor.manager, async request => {
                const view = await request('GET', '/workspace/clients/guest');
                assert.strictEqual(view.status, 200);
                assert.strictEqual(view.body.businessId, 1);
                assert.strictEqual(view.body.client.chatId, 'guest');
                const body = { text: 'Подтверждаю время.', idempotencyKey: 'section6-legacy' };
                const sent = await request('POST', '/workspace/clients/guest/reply', body);
                assert.strictEqual(sent.status, 200);
                assert.strictEqual(sent.body.status, 'sent');
                assert.strictEqual((await request('POST', '/workspace/clients/guest/reply', body)).body.messageId, 'acceptance-legacy-ack');
                assert.strictEqual(sends, 1);
                const promise = await request('POST', '/promises', { chatId: 'guest', summary: 'Перезвонить клиенту' });
                assert.strictEqual(promise.status, 201);
                assert.strictEqual(promise.body.promise.chatId, 'guest');
            }, { boundary: true });
        } finally { Router.sendMessageDetailed = send; }
    }));

    it('keeps revisioned per-business toggles independent and cannot bypass either deployment allowlist', () => environment({ AVA_IMPROVEMENTS_BUSINESSES: '1', AVA_WORKSPACE_BUSINESSES: '*' }, () => {
        const actor = setup();
        const first = Flags.update(actor.owner, 1, { revision: 0, flags: { copilot: false } });
        assert.strictEqual(first.flags.copilot, false);
        assert.strictEqual(first.flags.shifts, true);
        const second = Flags.update(actor.owner, 1, { revision: first.revision, flags: { shifts: false } });
        assert.strictEqual(second.flags.copilot, false);
        assert.strictEqual(second.flags.collaboration, true);
        assert.strictEqual(Flags.snapshot(2).revision, 0);
        assert.strictEqual(Flags.snapshot(2).available, false);
        assert.throws(() => Flags.update(actor.foreign, 2, { revision: 0, flags: { copilot: true } }), error => error.code === 'WORKSPACE_FEATURE_DISABLED');
        assert.throws(() => Flags.update(actor.owner, 1, { revision: first.revision, flags: { shifts: true } }), error => error.code === 'WORKSPACE_FEATURES_REVISION_CONFLICT');
        Release.update(actor.owner, 1, { revision: 0, flags: { workspace: false } });
        assert.ok(Object.values(Flags.snapshot(1).flags).every(value => value === false));
        assert.throws(() => Flags.update(actor.owner, 1, { revision: second.revision, flags: { copilot: true } }), error => error.code === 'WORKSPACE_FEATURE_DISABLED');
        Release.update(actor.owner, 1, { revision: 1, flags: { workspace: true } });
        process.env.AVA_IMPROVEMENTS_BUSINESSES = '2';
        assert.strictEqual(Flags.snapshot(1).available, false);
        process.env.AVA_IMPROVEMENTS_BUSINESSES = '1';
        assert.strictEqual(Flags.snapshot(1).flags.copilot, false);
        assert.strictEqual(Flags.snapshot(1).flags.collaboration, true);
    }));

    it('rechecks exact live owner capability for toggle writes while allowing observer reads', () => environment({ AVA_IMPROVEMENTS_BUSINESSES: '*', AVA_WORKSPACE_BUSINESSES: '*' }, () => {
        const actor = setup();
        assert.strictEqual(Flags.overview(actor.reader, 1).success, true);
        for (const auth of [actor.manager, actor.reader, actor.lead]) {
            assert.throws(() => Flags.update(auth, 1, { revision: 0, flags: { attention: false } }), error => error.code === 'CAPABILITY_DENIED');
        }
        assert.throws(() => Flags.overview(actor.foreign, 1), error => error.code === 'BUSINESS_ACCESS_DENIED');
        DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='owner' AND businessId=1");
        assert.throws(() => Flags.update(actor.owner, 1, { revision: 0, flags: { attention: false } }), error => error.code === 'BUSINESS_ACCESS_DENIED');
        assert.strictEqual(Flags.snapshot(1).revision, 0);
    }));

    it('standalone feature router rejects tenant injection, cross-origin writes and malformed revisions', () => environment({ AVA_IMPROVEMENTS_BUSINESSES: '1', AVA_WORKSPACE_BUSINESSES: '*' }, async () => {
        const actor = setup();
        await http(actor.owner, async request => {
            assert.strictEqual((await request('GET', '/workspace/features')).body.businessId, 1);
            const body = { revision: 0, flags: { attention: false } };
            assert.strictEqual((await request('PATCH', '/workspace/features', body, { Origin: 'https://foreign.example' })).status, 403);
            assert.strictEqual((await request('PATCH', '/workspace/features', body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
            assert.strictEqual((await request('GET', '/workspace/features?businessId=2')).body.code, 'BUSINESS_SCOPE_MISMATCH');
            assert.strictEqual((await request('PATCH', '/workspace/features', { ...body, revision: '0' })).status, 400);
            assert.strictEqual((await request('PATCH', '/workspace/features', { ...body, flags: { attention: 'false' } })).status, 400);
            assert.strictEqual(Flags.snapshot(1).revision, 0);
            assert.strictEqual((await request('PATCH', '/workspace/features', body)).status, 200);
            assert.strictEqual((await request('PATCH', '/workspace/features', body)).status, 409);
        });
    }));

    it('retains feature settings across a physical SQLite reopen', () => environment({ AVA_IMPROVEMENTS_BUSINESSES: '*', AVA_WORKSPACE_BUSINESSES: '*' }, async () => {
        const actor = setup(), fs = require('fs'), os = require('os'), path = require('path');
        const Database = require('better-sqlite3');
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-section6-flags-'));
        const original = DB.db;
        Flags.update(actor.owner, 1, { revision: 0, flags: { knowledgeReview: false } });
        await original.backup(path.join(folder, 'state.db'));
        DB.db = new Database(path.join(folder, 'state.db'));
        try {
            const snapshot = Flags.overview(actor.owner, 1);
            assert.strictEqual(snapshot.revision, 1);
            assert.strictEqual(snapshot.flags.knowledgeReview, false);
            assert.strictEqual(snapshot.flags.queueFlow, true);
            assert.strictEqual(Flags.snapshot(2).revision, 0);
        } finally { DB.db.close(); DB.db = original; fs.rmSync(folder, { recursive: true, force: true }); }
    }));

    // Base e79275e contains the flag router but not its app mount/allowlist.
    // Integration mode requires the real auth and customer boundary as well.
    if (process.env.AVA_ACCEPTANCE_REQUIRE_FLAGS_MOUNT === '1') it('integration app serves scoped flag routes through real session authentication and live role boundary', () => environment({
        AVA_IMPROVEMENTS_BUSINESSES: '1', AVA_WORKSPACE_BUSINESSES: '*', AVA_CUSTOMER_ACCESS_ENABLED: 'true',
    }, async () => {
        setup();
        const Auth = require('../src/services/auth.service');
        const oldEnabled = Auth.config.enabled;
        Auth.config.enabled = true;
        for (const id of ['owner', 'reader', 'foreign']) DB.run('UPDATE ava_users SET subject=? WHERE id=?', ['section6-' + id, id]);
        const tokens = Object.fromEntries(['owner', 'reader', 'foreign'].map(id => [id, Identity.createSession('section6-' + id, 'section6-session-' + id)]));
        const app = require('../src/app').app;
        const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
        const origin = 'http://127.0.0.1:' + server.address().port;
        try {
            await environment({ WHATSAPP_CRM_PUBLIC_URL: origin }, async () => {
                const request = async (id, method = 'GET', body, requestOrigin = origin) => {
                    const response = await fetch(origin + '/api/businesses/1/workspace/features', {
                        method, headers: { Cookie: 'crm_session=ava2:' + tokens[id], Origin: requestOrigin, 'Content-Type': 'application/json' },
                        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    });
                    return { status: response.status, body: await response.json() };
                };
                const read = await request('reader');
                assert.strictEqual(read.status, 200);
                assert.strictEqual(read.body.businessId, 1);
                assert.strictEqual(read.body.flags.collaboration, true);
                assert.strictEqual((await request('foreign')).status, 403);
                const patch = { revision: 0, flags: { copilot: false } };
                assert.strictEqual((await request('reader', 'PATCH', patch)).status, 403);
                assert.strictEqual((await request('owner', 'PATCH', patch, 'https://foreign.example')).status, 403);
                assert.strictEqual(Flags.snapshot(1).revision, 0);
                assert.strictEqual((await request('owner', 'PATCH', patch)).status, 200);
                DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId='owner' AND businessId=1");
                assert.strictEqual((await request('owner', 'PATCH', { revision: 1, flags: { copilot: true } })).status, 403);
                assert.strictEqual(Flags.snapshot(1).flags.copilot, false);
            });
        } finally { await new Promise(resolve => server.close(resolve)); Auth.config.enabled = oldEnabled; }
    }));
});
