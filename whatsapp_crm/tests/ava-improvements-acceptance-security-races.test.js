'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Canonical = require('../src/services/client-identity.service');
const Workspace = require('../src/services/ava-workspace.service');
const Control = require('../src/services/ava-workspace.store');
const Autopilot = require('../src/services/ava-autopilot.service');
const Actions = require('../src/services/ava-autopilot.store');
const Router = require('../src/services/channel-router.service');
const Green = require('../src/services/green-api.service');
const RAG = require('../src/services/rag.service');

const CHAT = '79990000001@c.us';
const ALIAS = 'tg_99110001';
const actors = ['owner', 'lead', 'manager', 'peer', 'observer', 'foreign'];

// Use the established real-schema helper, then exercise a physical temporary DB.
// Never initialize the application's configured/customer database.
async function fixture(fn) {
    const previous = DB.db;
    const previousAllowlist = process.env.AVA_IMPROVEMENTS_BUSINESSES;
    // Baseline invariants and old-caller characterizations always run feature-off,
    // independently of a shell/root runner's global deployment allowlist.
    process.env.AVA_IMPROVEMENTS_BUSINESSES = '';
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-acceptance-security-'));
    const file = path.join(directory, 'fixture.sqlite');
    const seed = createTestDB();
    try {
        Identity.ensureSchema();
        DB.run("INSERT INTO instances(id,name,isActive,whatsappProvider,greenApiInstance,greenApiToken) VALUES(1,'One',1,'green_api','fixture','fixture'),(2,'Two',1,'green_api','fixture-two','fixture-two')");
        for (const [id, role, business] of [
            ['owner', 'hotel_owner', 1], ['lead', 'sales_lead', 1],
            ['manager', 'manager', 1], ['peer', 'manager', 1],
            ['observer', 'observer', 1], ['foreign', 'hotel_owner', 2],
        ]) {
            DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)', [id, id + '@example.test', 'Same display name']);
            DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [id, business, role]);
        }
        DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,?,'Same customer','manager'),(1,'peer-client','Peer','peer'),(2,?,'Same customer','foreign')", [CHAT, CHAT]);
        Control.ensureSchema();
        Actions.ensureSchema();
        Canonical.attach(1, CHAT, { kind: 'telegram', value: '99110001' });
        DB.run("INSERT INTO knowledge_base(instanceId,filename,originalName) VALUES(1,'fixture.txt','fixture.txt')");
        await seed.backup(file);
        seed.close();
        DB.db = new Database(file);
        DB.db.pragma('foreign_keys = ON');
        DB.db.pragma('busy_timeout = 5000');
        await fn(Object.fromEntries(actors.map(id => [id, Identity.actor(id)])), {
            reopen() {
                DB.db.close();
                DB.db = new Database(file);
                DB.db.pragma('foreign_keys = ON');
            },
        });
    } finally {
        if (DB.db && DB.db !== previous && DB.db.open) DB.db.close();
        if (seed.open) seed.close();
        DB.db = previous;
        if (previousAllowlist === undefined) delete process.env.AVA_IMPROVEMENTS_BUSINESSES;
        else process.env.AVA_IMPROVEMENTS_BUSINESSES = previousAllowlist;
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function acceptance(name, fn) { it('section6 security: ' + name, () => fixture(fn)); }
function errorCode(fn, code) { assert.throws(fn, error => error.code === code); }
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
async function bounded(promise) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Acceptance interleaving exceeded 5s')), 5000);
        })]);
    } finally { clearTimeout(timer); }
}
async function transport(fn) {
    const state = Router._getWhatsAppState;
    const send = Green.sendMessage;
    Router._getWhatsAppState = async () => ({ success: true, state: 'authorized' });
    let calls = 0;
    Green.sendMessage = async () => { calls++; return { success: true, data: { idMessage: 'fixture-ack-' + calls } }; };
    try { await fn(() => calls); }
    finally { Router._getWhatsAppState = state; Green.sendMessage = send; }
}
function enable(a) {
    const policy = Autopilot.updatePolicy(a.owner, 1, { revision: 0, enabled: true }).policy;
    const simulation = Autopilot.simulations(a.owner, 1, { revision: policy.revision }).simulation;
    assert.strictEqual(simulation.passed, true);
    Autopilot.publish(a.owner, 1, { revision: policy.revision, simulationId: simulation.id });
}
async function inbound(text, business = 1) {
    const message = await DB.saveMessageWithChannel(business, CHAT, 'Customer', text, 'user', 'whatsapp');
    return { businessId: business, chatId: CHAT, text, eventId: 'message:' + message.id };
}
function knowledge() {
    return { answer: 'Монтаж включён.', citations: [{ document_id: String(DB.get('SELECT id FROM knowledge_base WHERE instanceId=1').id) }] };
}

describe('AVA improvements section 6: real service security and deterministic races (baseline)', () => {
    acceptance('canonical aliases and equal names never grant cross-tenant or peer write authority', async a => {
        await transport(async calls => {
            assert.strictEqual(Workspace.clientWorkspace(a.peer, 1, ALIAS).client.chatId, CHAT);
            for (const [actor, code] of [[a.peer, 'SALES_CLIENT_SCOPE_DENIED'], [a.observer, 'CAPABILITY_DENIED'], [a.foreign, 'BUSINESS_ACCESS_DENIED']]) {
                await assert.rejects(() => Workspace.reply(actor, 1, ALIAS, { text: 'Denied', idempotencyKey: 'denied-' + actor.userId }), error => error.code === code);
            }
            errorCode(() => Workspace.clientWorkspace(a.manager, 2, CHAT), 'BUSINESS_ACCESS_DENIED');
            const sent = await Workspace.reply(a.manager, 1, ALIAS, { text: 'Scoped reply', idempotencyKey: 'canonical' });
            assert.strictEqual(sent.status, 'sent');
            assert.strictEqual(calls(), 1);
            assert.strictEqual(DB.get('SELECT chatId FROM ava_workspace_reply_actions').chatId, CHAT);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM messages WHERE instanceId=2').n, 0);
        });
    });

    for (const [label, mutate] of [
        ['role becomes observer', () => DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId='manager' AND businessId=1")],
        ['membership is disabled', () => DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='manager' AND businessId=1")],
        ['user is disabled', () => DB.run("UPDATE ava_users SET enabled=0 WHERE id='manager'")],
        ['client moves to peer', () => DB.run("UPDATE clients SET assigneeUserId='peer' WHERE instanceId=1 AND chatId=?", [CHAT])],
    ]) {
        acceptance('live revocation during provider preparation: ' + label, async a => {
            await transport(async calls => {
                const entered = deferred(), release = deferred();
                Router._getWhatsAppState = async () => { entered.resolve(); await bounded(release.promise); return { success: true, state: 'authorized' }; };
                const pending = Workspace.reply(a.manager, 1, ALIAS, { text: 'Must not leave', idempotencyKey: 'revoked' });
                try {
                    await bounded(entered.promise);
                    mutate();
                    release.resolve();
                    assert.strictEqual((await bounded(pending)).status, 'failed');
                    assert.strictEqual(calls(), 0);
                    assert.strictEqual(Control.getControl(1, CHAT).sendInProgress, undefined);
                    assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM messages').n, 0);
                    assert.strictEqual(DB.get('SELECT status FROM ava_workspace_reply_actions').status, 'failed');
                } finally { release.resolve(); await pending; }
            });
        });
    }

    for (const other of ['owner', 'manager']) {
        acceptance('overlapping human replies with different keys reject second reservation (' + other + ')', async a => {
            await transport(async calls => {
                const entered = deferred(), release = deferred();
                Router._getWhatsAppState = async () => { entered.resolve(); await bounded(release.promise); return { success: true, state: 'authorized' }; };
                const pending = Workspace.reply(a.manager, 1, CHAT, { text: 'First', idempotencyKey: 'browser-one' });
                try {
                    await bounded(entered.promise);
                    await assert.rejects(() => Workspace.reply(a[other], 1, ALIAS, { text: 'Second', idempotencyKey: 'browser-two' }), error => error.code === 'WORKSPACE_SEND_IN_PROGRESS');
                    assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_workspace_reply_actions').n, 1);
                    release.resolve();
                    assert.strictEqual((await bounded(pending)).status, 'sent');
                    assert.strictEqual(calls(), 1);
                    assert.strictEqual(Workspace.clientWorkspace(a.manager, 1, CHAT).messages.at(-1).authorUserId, 'manager');
                    assert.strictEqual(Control.getControl(1, CHAT).mode, 'human');
                } finally { release.resolve(); await pending; }
            });
        });
    }

    acceptance('same-key pending retry is unknown and cannot dispatch or duplicate authorship', async a => {
        await transport(async calls => {
            const entered = deferred(), release = deferred();
            Router._getWhatsAppState = async () => { entered.resolve(); await bounded(release.promise); return { success: true, state: 'authorized' }; };
            const body = { text: 'Only once', idempotencyKey: 'same-session-retry' };
            const pending = Workspace.reply(a.manager, 1, CHAT, body);
            try {
                await bounded(entered.promise);
                assert.strictEqual((await Workspace.reply(a.manager, 1, ALIAS, body)).status, 'unknown');
                assert.strictEqual(calls(), 0);
                release.resolve();
                assert.strictEqual((await bounded(pending)).status, 'sent');
                assert.strictEqual((await Workspace.reply(a.manager, 1, CHAT, body)).status, 'sent');
                assert.strictEqual(calls(), 1);
                assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_workspace_message_authorship').n, 1);
            } finally { release.resolve(); await pending; }
        });
    });

    for (const [label, result] of [
        ['HTTP success without message ID', { success: true, data: {} }],
        ['ambiguous timeout', { success: false, statusCode: 504 }],
    ]) {
        acceptance('real gateway fences ' + label + ' across SQLite reopen', async (a, disk) => {
            await transport(async () => {
                let calls = 0;
                Green.sendMessage = async () => { calls++; return result; };
                const body = { text: 'Uncertain', idempotencyKey: 'uncertain' };
                assert.strictEqual((await Workspace.reply(a.manager, 1, CHAT, body)).status, 'unknown');
                assert.strictEqual(calls, 1);
                assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM messages').n, 0);
                disk.reopen();
                assert.strictEqual((await Workspace.reply(a.manager, 1, ALIAS, body)).status, 'unknown');
                assert.strictEqual(Workspace.replyStatus(a.manager, 1, CHAT, { idempotencyKey: body.idempotencyKey }).status, 'unknown');
                await assert.rejects(() => Workspace.reply(a.owner, 1, CHAT, { text: 'Try again', idempotencyKey: 'different-user-and-key' }), error => error.code === 'WORKSPACE_SEND_IN_PROGRESS');
                errorCode(() => Workspace.control(a.owner, 1, CHAT, { mode: 'ai' }), 'WORKSPACE_SEND_IN_PROGRESS');
                errorCode(() => Control.beginAiSend({ businessId: 1, chatId: CHAT, sendId: 'late-ai' }), 'WORKSPACE_HUMAN_CONTROL');
                assert.strictEqual(Control.getControl(1, CHAT).sendStatus, 'unknown');
                assert.strictEqual(calls, 1);
            });
        });
    }

    acceptance('baseline legacy human reply accepts fresh inbound while awaiting provider readiness', async a => {
        await transport(async calls => {
            const entered = deferred(), release = deferred();
            Router._getWhatsAppState = async () => { entered.resolve(); await bounded(release.promise); return { success: true, state: 'authorized' }; };
            const pending = Workspace.reply(a.manager, 1, CHAT, { text: 'Existing composer reply', idempotencyKey: 'legacy-inbound-race' });
            try {
                await bounded(entered.promise);
                await inbound('Changed request');
                release.resolve();
                assert.strictEqual((await bounded(pending)).status, 'sent');
                assert.strictEqual(calls(), 1);
                assert.strictEqual(Workspace.clientWorkspace(a.manager, 1, CHAT).messages.length, 2);
                // Characterization of callers without expectedDialogueRevision, not acceptance
                // of the new collaboration revision contract.
            } finally { release.resolve(); await pending; }
        });
    });

    acceptance('human takeover during awaited knowledge blocks AI and preserves explicit ownership', async a => {
        enable(a);
        const original = RAG.answerFromKnowledge;
        const entered = deferred(), release = deferred();
        RAG.answerFromKnowledge = async () => { entered.resolve(); return bounded(release.promise); };
        try {
            await transport(async calls => {
                const pending = Autopilot.handleInbound(await inbound('Как работает монтаж?'));
                try {
                    await bounded(entered.promise);
                    Workspace.control(a.manager, 1, ALIAS, { mode: 'human' });
                    release.resolve(knowledge());
                    const result = await bounded(pending);
                    assert.strictEqual(result.action.status, 'blocked');
                    assert.strictEqual(calls(), 0);
                    assert.strictEqual(Control.getControl(1, CHAT).mode, 'human');
                    assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM messages WHERE role='assistant'").n, 0);
                    const human = await Workspace.reply(a.manager, 1, CHAT, { text: 'I am answering', idempotencyKey: 'human-after-ai' });
                    assert.strictEqual(human.status, 'sent');
                    assert.strictEqual(calls(), 1);
                    const message = Workspace.clientWorkspace(a.manager, 1, CHAT).messages.at(-1);
                    assert.strictEqual(message.authorType, 'human');
                    assert.strictEqual(message.authorUserId, 'manager');
                } finally { release.resolve(knowledge()); await pending; }
            });
        } finally { RAG.answerFromKnowledge = original; }
    });

    acceptance('BASELINE DEFECT probe: newer same-client inbound does not cancel awaited AI knowledge reply', async a => {
        const previousAllowlist = process.env.AVA_IMPROVEMENTS_BUSINESSES;
        // Strict phase2 asserts the opted-in collaboration contract. The default
        // characterization intentionally preserves the feature-off old caller.
        if (process.env.AVA_ACCEPTANCE_REQUIRE_INBOUND_FENCE === '1') process.env.AVA_IMPROVEMENTS_BUSINESSES = '1';
        enable(a);
        const original = RAG.answerFromKnowledge;
        const entered = deferred(), release = deferred();
        RAG.answerFromKnowledge = async () => { entered.resolve(); return bounded(release.promise); };
        try {
            await transport(async calls => {
                const initial = await inbound('Как работает монтаж?');
                const pending = Autopilot.handleInbound(initial);
                try {
                    await bounded(entered.promise);
                    const newer = await inbound('Не отвечайте на старый вопрос, нужен менеджер');
                    assert.ok(Number(newer.eventId.split(':')[1]) > Number(initial.eventId.split(':')[1]));
                    release.resolve(knowledge());
                    const result = await bounded(pending);
                    if (process.env.AVA_ACCEPTANCE_REQUIRE_INBOUND_FENCE === '1') {
                        assert.strictEqual(calls(), 0, 'SR-01: stale AI answer reached provider after newer inbound');
                        assert.strictEqual(result.action.status, 'blocked');
                        assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM messages WHERE role='assistant'").n, 0);
                    } else {
                        // A green baseline probe reproduces the documented defect.
                        assert.strictEqual(result.status, 'sent');
                        assert.strictEqual(calls(), 1);
                        assert.strictEqual(DB.get("SELECT content FROM messages WHERE role='assistant'").content, 'Монтаж включён.');
                    }
                } finally { release.resolve(knowledge()); await pending; }
            });
        } finally {
            RAG.answerFromKnowledge = original;
            if (previousAllowlist === undefined) delete process.env.AVA_IMPROVEMENTS_BUSINESSES;
            else process.env.AVA_IMPROVEMENTS_BUSINESSES = previousAllowlist;
        }
    });

    acceptance('AI dispatch awaiting ACK fences human sends, then unknown fences both after reopen', async (a, disk) => {
        enable(a);
        await transport(async () => {
            const entered = deferred(), release = deferred();
            let calls = 0;
            Green.sendMessage = async () => { calls++; entered.resolve(); return bounded(release.promise); };
            const initial = await inbound('Привет');
            const pending = Autopilot.handleInbound(initial);
            try {
                await bounded(entered.promise);
                await assert.rejects(() => Workspace.reply(a.manager, 1, CHAT, { text: 'Race', idempotencyKey: 'human-racing-ai' }), error => error.code === 'WORKSPACE_SEND_IN_PROGRESS');
                errorCode(() => Workspace.control(a.owner, 1, CHAT, { mode: 'human' }), 'WORKSPACE_SEND_IN_PROGRESS');
                release.resolve({ success: true, data: {} });
                assert.strictEqual((await bounded(pending)).status, 'unknown');
                disk.reopen();
                assert.strictEqual((await Autopilot.handleInbound(initial)).action.status, 'unknown');
                assert.strictEqual(Control.getControl(1, CHAT).sendStatus, 'unknown');
                errorCode(() => Control.beginAiSend({ businessId: 1, chatId: CHAT, sendId: 'new-ai' }), 'WORKSPACE_SEND_IN_PROGRESS');
                errorCode(() => Workspace.control(a.manager, 1, ALIAS, { mode: 'human' }), 'WORKSPACE_SEND_IN_PROGRESS');
                assert.strictEqual(calls, 1);
            } finally { release.resolve({ success: false, statusCode: 504 }); await pending; }
        });
    });
});
