#!/usr/bin/env node
'use strict';

// Run against a complete checkout, never against copied implementations:
// NODE_PATH=/path/to/shared/node_modules node ava-copilot-integrated.cjs /path/to/ava
const fs = require('fs');
const path = require('path');
const {createRequire} = require('module');
const {createHash} = require('crypto');
const {execFileSync} = require('child_process');
const root = path.resolve(process.argv[2] || path.join(__dirname, '../..'));
const crm = path.join(root, 'whatsapp_crm');
const sourceFiles = ['tests/test-helper.js', 'src/services/database.service.js',
    'src/services/identity/identity-store.js', 'src/services/identity/customer-role-boundary.js',
    'src/services/ava-improvements-flags.service.js', 'src/services/ava-collaboration.service.js',
    'src/services/ava-workspace.service.js', 'src/services/ava-workspace.store.js',
    'src/services/ava-copilot.service.js', 'src/routes/ava-copilot.routes.js', 'src/routes/ava-collaboration.routes.js'];
const missing = sourceFiles.filter(file => !fs.existsSync(path.join(crm, file)));
if (missing.length) {
    console.error('Integrated copilot harness needs a complete AVA checkout with collaboration installed.');
    console.error('Target: ' + root + '\nMissing: ' + missing.join(', '));
    console.error('Pass that checkout as argv[2]; the harness does not copy services or substitute revision/flags helpers.');
    process.exit(2);
}

const targetRequire = createRequire(path.join(crm, 'package.json'));
const load = file => targetRequire(path.join(crm, file));
const {describe, it, assert, createTestDB, runAll} = load('tests/test-helper.js');
const DB = load('src/services/database.service.js');
const Identity = load('src/services/identity/identity-store.js');
const Boundary = load('src/services/identity/customer-role-boundary.js');
const Flags = load('src/services/ava-improvements-flags.service.js');
const Collaboration = load('src/services/ava-collaboration.service.js');
const Store = load('src/services/ava-workspace.store.js');
const Workspace = load('src/services/ava-workspace.service.js');
const Copilot = load('src/services/ava-copilot.service.js');
const Catalog = load('src/services/ava-autopilot.store.js');
const AI = load('src/services/ai.service.js');
const Channel = load('src/services/channel-router.service.js');
const express = targetRequire('express');
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file,
    createHash('sha256').update(fs.readFileSync(path.join(crm, file))).digest('hex')]));
const head = () => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
const provenance = {target: root, head: head(), sourceSha256: hashes()};
console.log('INTEGRATED_SOURCE ' + JSON.stringify(provenance));

const environmentKeys = ['AVA_IMPROVEMENTS_BUSINESSES', 'AVA_WORKSPACE_BUSINESSES', 'WHATSAPP_CRM_PUBLIC_URL'];
const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
const originalAI = AI.generatePlainText, originalSend = Channel.sendMessageDetailed;
let model, modelCalls = 0, sends = 0;
AI.generatePlainText = async (...args) => { modelCalls++; return model(...args); };
Channel.sendMessageDetailed = async () => { sends++; throw new Error('Forbidden external send in integrated draft harness'); };

function message(businessId = 1, content = 'Пришлите условия установки.') {
    return Number(DB.run("INSERT INTO messages(instanceId,chatId,senderName,role,content,channel) VALUES(?,'guest','Guest','user',?,'whatsapp')", [businessId, content]).lastInsertRowid);
}
function setup(available = true) {
    if (DB.db?.open) DB.db.close();
    const db = createTestDB();
    assert.strictEqual(DB.db, db, 'Fixture must use the actual target database singleton');
    process.env.AVA_IMPROVEMENTS_BUSINESSES = available ? '1,2' : '';
    process.env.AVA_WORKSPACE_BUSINESSES = '*';
    Identity.ensureSchema();
    DB.createSalesWorkspaceTables();
    DB.run("INSERT INTO instances(id,name,isActive,aiProvider,yandexGptKey,yandexGptModelUri) VALUES(1,'Integrated tenant',1,'aitunnel','synthetic-key','synthetic-model'),(2,'FOREIGN_BUSINESS_SECRET',1,'aitunnel','synthetic-key','synthetic-model')");
    for (const [userId, role, businessId] of [['owner', 'hotel_owner', 1], ['manager', 'manager', 1], ['other', 'manager', 1], ['observer', 'observer', 1], ['foreign', 'hotel_owner', 2]]) {
        DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)', [userId, userId + '@test.example', userId]);
        DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [userId, businessId, role]);
    }
    DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,'guest','Guest','manager'),(1,'other-client','Other','other'),(2,'guest','FOREIGN_CLIENT_SECRET','foreign')");
    Collaboration.ensureSchema();
    const ownMessage = message(), foreignMessage = message(2, 'FOREIGN_MESSAGE_SECRET');
    const kb = Number(DB.run("INSERT INTO knowledge_base(instanceId,filename,originalName) VALUES(1,'policy.txt','Conditions')").lastInsertRowid);
    const chunk = Number(DB.run("INSERT INTO kb_chunks(kbId,chunkIndex,text,searchText) VALUES(?,0,'Установка по согласованию.','установк согласован')", [kb]).lastInsertRowid);
    DB.createConversationEvent({instanceId: 1, chatId: 'guest', eventId: 'own-call', callId: 'actual-call', channel: 'voice', content: 'Клиент уточнил условия установки.'});
    DB.createConversationEvent({instanceId: 2, chatId: 'guest', eventId: 'foreign-call', callId: 'foreign-call', channel: 'voice', content: 'FOREIGN_CALL_SECRET'});
    Store.recordCallTranscript({businessId: 1, chatId: 'guest', sourceId: 'own-call', text: 'user: Нужна установка.\nassistant: Согласуем условия.', timestamp: '2026-10-07T09:00:00Z'});
    Catalog.ensureSchema();
    const actors = Object.fromEntries(['owner', 'manager', 'other', 'observer', 'foreign'].map(id => [id, Identity.actor(id)]));
    Store.getControl(1, 'guest');
    Store.getControl(2, 'guest');
    modelCalls = 0; sends = 0;
    const fixture = {...actors, ownMessage, foreignMessage, kb, chunk};
    model = async () => output(fixture);
    return fixture;
}
function output(f) {
    return JSON.stringify({text: 'Здравствуйте! Уточним удобное время установки.', sourceIds: ['message:' + f.ownMessage, 'call:own-call', 'knowledge:' + f.chunk]});
}
const revision = (businessId = 1) => Collaboration.dialogueRevision(businessId, 'guest');
function updateFlags(f, values) { return Flags.update(f.owner, 1, {revision: Flags.snapshot(1).revision, flags: values}); }
const rejected = (pending, code) => assert.rejects(pending, error => error.code === code);
function effects() {
    return Object.fromEntries(['messages', 'conversation_events', 'ava_call_transcript_sources', 'ava_conversation_control',
        'ava_workspace_reply_actions', 'manager_tasks', 'followup_drafts', 'ava_quotes', 'ava_catalog_offers',
        'ava_client_promises', 'customer_deals'].map(table => [table, DB.all('SELECT * FROM ' + table + ' ORDER BY rowid')]));
}
async function duringAI(f, mutate, errorCode = 'COPILOT_CONTEXT_CHANGED', revisionMustChange = true) {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    model = async () => { entered(); await gate; return output(f); };
    const beforeRevision = revision();
    const pending = Copilot.generate(f.manager, 1, 'guest', {intent: 'reply'}, {timeoutMs: 1000});
    const failure = rejected(pending, errorCode);
    await started;
    let afterMutation;
    try {
        mutate();
        if (revisionMustChange) assert.notStrictEqual(revision(), beforeRevision, 'Real source triggers must advance the dialogue revision');
        afterMutation = effects();
    } finally { release(); }
    await failure;
    assert.deepStrictEqual(effects(), afterMutation);
    assert.strictEqual(modelCalls, 1);
    assert.strictEqual(sends, 0);
}

async function http(f, work) {
    let actor = f.owner;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.auth = actor; next(); });
    app.use('/api', Boundary);
    app.use('/api', load('src/routes/ava-workspace.routes.js'));
    app.use('/api', load('src/routes/ava-collaboration.routes.js'));
    app.use('/api', load('src/routes/ava-copilot.routes.js'));
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const oldOrigin = process.env.WHATSAPP_CRM_PUBLIC_URL;
    process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
    try {
        await work(async (user, options = {}) => {
            actor = f[user];
            const headers = {'Content-Type': 'application/json', Origin: origin, ...options.headers};
            if (options.withoutOrigin) delete headers.Origin;
            return fetch(origin + '/api/businesses/' + (options.businessId || 1) + '/workspace/clients/' + (options.chatId || 'guest') + (options.endpoint || '/copilot'),
                {method: 'POST', headers, body: JSON.stringify(options.body || {intent: 'reply'})});
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (oldOrigin === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
        else process.env.WHATSAPP_CRM_PUBLIC_URL = oldOrigin;
    }
}

describe('Integrated copilot with real flags, source triggers and customer HTTP boundary', () => {
    it('fails closed under the real default improvement allowlist', async () => {
        const f = setup(false);
        assert.strictEqual(Flags.snapshot(1).flags.copilot, false);
        await rejected(Copilot.generate(f.manager, 1, 'guest', {intent: 'reply'}), 'WORKSPACE_FEATURE_DISABLED');
        assert.strictEqual(modelCalls, 0);
    });
    it('returns the actual revision with copilot alone and preserves an unknown send fence', async () => {
        const f = setup();
        updateFlags(f, {copilot: true, collaboration: false});
        assert.throws(() => Collaboration.presence(f.manager, 1, 'guest'), error => error.code === 'WORKSPACE_FEATURE_DISABLED');
        Store.beginAiSend({businessId: 1, chatId: 'guest', sendId: 'preexisting-unknown'});
        Store.endAiSend({businessId: 1, chatId: 'guest', sendId: 'preexisting-unknown', status: 'unknown'});
        const expected = revision(), before = effects();
        const result = await Copilot.generate(f.manager, 1, 'guest', {intent: 'reply'});
        assert.strictEqual(result.dialogueRevision, expected);
        assert.strictEqual(Workspace.clientWorkspace(f.manager, 1, 'guest').dialogueRevision, expected);
        assert.strictEqual(Store.getControl(1, 'guest').sendStatus, 'unknown');
        assert.deepStrictEqual(effects(), before);
        assert.strictEqual(sends, 0);
    });
    it('rejects real inbound insertion and existing message edits during AI work', async () => {
        for (const edit of [false, true]) {
            const f = setup();
            await duringAI(f, () => edit ? DB.run('UPDATE messages SET content=? WHERE id=?', ['Отмена установки.', f.ownMessage]) : message(1, 'Новый вопрос клиента.'));
        }
    });
    it('rejects call evidence edits through the actual event source trigger', async () => {
        const f = setup();
        await duringAI(f, () => DB.run("UPDATE conversation_events SET content='Клиент отменил заказ.' WHERE instanceId=1 AND eventId='own-call'"));
    });
    it('rejects transcript source changes through the actual transcript trigger', async () => {
        const f = setup();
        await duringAI(f, () => DB.run("UPDATE ava_call_transcript_sources SET text='user: Отмена.',sourceHash='synthetic-updated-hash' WHERE businessId=1 AND sourceId='own-call'"));
    });
    it('rejects a control takeover through the actual control trigger', async () => {
        const f = setup();
        await duringAI(f, () => Store.setControl({businessId: 1, chatId: 'guest', mode: 'human', actorUserId: 'owner'}));
    });
    it('rejects revoked message sources and changed current knowledge during AI work', async () => {
        for (const knowledgeChange of [false, true]) {
            const f = setup();
            await duringAI(f, () => knowledgeChange ? DB.run('UPDATE kb_chunks SET text=? WHERE id=?', ['Условия изменились.', f.chunk]) : DB.run('DELETE FROM messages WHERE id=?', [f.ownMessage]), 'COPILOT_CONTEXT_CHANGED', !knowledgeChange);
        }
    });
    it('keeps an awaited draft valid when only another business events change', async () => {
        const f = setup(), expected = revision(), foreignBefore = revision(2);
        model = async () => {
            message(2, 'Foreign inbound');
            DB.run("UPDATE conversation_events SET content='FOREIGN_CHANGED_SECRET' WHERE instanceId=2 AND eventId='foreign-call'");
            return output(f);
        };
        const result = await Copilot.generate(f.manager, 1, 'guest', {intent: 'reply'});
        assert.strictEqual(result.dialogueRevision, expected);
        assert.strictEqual(revision(), expected);
        assert.notStrictEqual(revision(2), foreignBefore);
        assert.strictEqual(sends, 0);
    });
    it('does not treat real presence heartbeats as dialogue evidence changes', async () => {
        const f = setup(), expected = revision(), before = effects();
        model = async () => {
            const presence = Collaboration.heartbeat(f.manager, 1, 'guest', {sessionId: 'actual-presence', typing: true});
            assert.strictEqual(presence.dialogueRevision, expected);
            Collaboration.heartbeat(f.owner, 1, 'guest', {sessionId: 'owner-presence', typing: false});
            return output(f);
        };
        assert.strictEqual((await Copilot.generate(f.manager, 1, 'guest', {intent: 'reply'})).dialogueRevision, expected);
        assert.strictEqual(revision(), expected);
        assert.strictEqual(Collaboration.presence(f.owner, 1, 'guest').participants.length, 2);
        assert.deepStrictEqual(effects(), before);
    });
    it('rechecks live copilot disablement while collaboration stays independently usable', async () => {
        const f = setup();
        await duringAI(f, () => updateFlags(f, {copilot: false, collaboration: true}), 'WORKSPACE_FEATURE_DISABLED', false);
        assert.strictEqual(Flags.snapshot(1).flags.collaboration, true);
        assert.strictEqual(Collaboration.heartbeat(f.manager, 1, 'guest', {sessionId: 'still-independent', typing: false}).success, true);
    });
    it('rechecks actual live role and assignment after the model await', async () => {
        for (const assignment of [false, true]) {
            const f = setup();
            await duringAI(f, () => assignment ? DB.run("UPDATE clients SET assigneeUserId='other' WHERE instanceId=1 AND chatId='guest'") : DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId='manager'"), assignment ? 'SALES_CLIENT_SCOPE_DENIED' : 'CAPABILITY_DENIED', assignment);
        }
    });
    it('serves the full real HTTP boundary for owner/assigned/observer/foreign/origin and preserves unknown sends', async () => {
        const f = setup();
        updateFlags(f, {copilot: true, collaboration: false});
        Store.beginAiSend({businessId: 1, chatId: 'guest', sendId: 'http-unknown'});
        Store.endAiSend({businessId: 1, chatId: 'guest', sendId: 'http-unknown', status: 'unknown'});
        const before = effects();
        await http(f, async request => {
            for (const user of ['owner', 'manager']) {
                const response = await request(user);
                assert.strictEqual(response.status, 200);
                const body = await response.json();
                assert.strictEqual(body.dialogueRevision, revision());
                assert.strictEqual(body.draft.kind, 'reply');
            }
            for (const user of ['observer', 'other', 'foreign']) assert.strictEqual((await request(user)).status, 403, user);
            for (const options of [{withoutOrigin: true}, {headers: {Origin: 'https://foreign.example'}}, {headers: {'Sec-Fetch-Site': 'cross-site'}}, {businessId: 2}, {body: {intent: 'reply', businessId: 2}}]) assert.strictEqual((await request('manager', options)).status, 403);
            assert.strictEqual((await request('manager', {endpoint: '/presence', body: {sessionId: 'disabled', typing: false}})).status, 409);
            assert.strictEqual(modelCalls, 2);
        });
        assert.deepStrictEqual(effects(), before);
        assert.strictEqual(sends, 0);
    });
});

async function main() {
    try {
        const success = await runAll();
        assert.strictEqual(head(), provenance.head, 'Target HEAD changed during verification; rerun the harness');
        assert.deepStrictEqual(hashes(), provenance.sourceSha256, 'Target source changed during verification; rerun the harness');
        console.log('INTEGRATED_RESULT ' + JSON.stringify({success, target: root, head: provenance.head,
            actualRevisionHelper: true, actualFlags: true, actualHttpBoundary: true, aiCallsAreStubbed: true, providerSends: sends}));
        process.exitCode = success ? 0 : 1;
    } finally {
        AI.generatePlainText = originalAI;
        Channel.sendMessageDetailed = originalSend;
        for (const key of environmentKeys) {
            if (originalEnvironment[key] === undefined) delete process.env[key];
            else process.env[key] = originalEnvironment[key];
        }
        if (DB.db?.open) DB.db.close();
    }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
