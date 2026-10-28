'use strict';

const {describe, it, assert, createTestDB} = require('./test-helper');
const Module = require('module');
const path = require('path');
const {createHash} = require('crypto');
const express = require('express');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Canonical = require('../src/services/client-identity.service');
const Catalog = require('../src/services/ava-autopilot.store');
const Workspace = require('../src/services/ava-workspace.store');
const AI = require('../src/services/ai.service');
const Channel = require('../src/services/channel-router.service');
const servicePath = path.resolve(__dirname, '../src/services/ava-copilot.service.js');
const routesPath = path.resolve(__dirname, '../src/routes/ava-copilot.routes.js');

function message(businessId, chatId, content) {
    return Number(DB.run('INSERT INTO messages(instanceId,chatId,senderName,role,content,channel) VALUES(?,?,?,?,?,?)',
        [businessId, chatId, 'Guest', 'user', content, 'whatsapp']).lastInsertRowid);
}

function knowledge(businessId, text, current = 1) {
    const kb = Number(DB.run('INSERT INTO knowledge_base(instanceId,filename,originalName,isCurrent) VALUES(?,?,?,?)',
        [businessId, 'policy.txt', 'Business policy', current]).lastInsertRowid);
    const searchText = require('../src/utils/rag-normalizer').normalizeSearchText(text);
    const chunk = Number(DB.run('INSERT INTO kb_chunks(kbId,chunkIndex,text,searchText) VALUES(?,?,?,?)', [kb, 0, text, searchText]).lastInsertRowid);
    return {kb, chunk};
}

function offer(businessId, id, published = true, active = true) {
    const row = {id, revision: 1, name: 'Монтаж', description: 'Установка оборудования', amountMinor: 123450,
        currency: 'RUB', terms: 'По согласованию', active, publishedAt: published ? '2026-10-07T09:00:00Z' : null};
    Catalog.saveOffer(businessId, row);
    if (published) Catalog.publishOffer(businessId, row);
    return row;
}

function setup() {
    createTestDB();
    Identity.ensureSchema();
    DB.createSalesWorkspaceTables();
    DB.run('INSERT INTO instances(id,name,isActive,aiProvider,yandexGptKey,yandexGptModelUri) VALUES(?,?,?,?,?,?),(?,?,?,?,?,?)',
        [1, 'Our business', 1, 'yandex', 'synthetic-key', 'gpt://synthetic/model',
            2, 'FOREIGN_BUSINESS_SECRET', 1, 'yandex', 'foreign-key', 'gpt://foreign/model']);
    for (const [id, role, businessId] of [['owner', 'hotel_owner', 1], ['lead', 'sales_lead', 1],
        ['manager', 'manager', 1], ['other', 'manager', 1], ['observer', 'observer', 1], ['foreign', 'hotel_owner', 2]]) {
        DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)', [id, id + '@test.example', id]);
        DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [id, businessId, role]);
    }
    DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,'guest','Guest','manager'),(1,'second','Other','other'),(1,'queue','Queue',NULL),(2,'guest','FOREIGN_CLIENT_SECRET','foreign')");
    Workspace.ensureSchema();
    Catalog.ensureSchema();
    const ownMessage = message(1, 'guest', 'Нужна установка. Пришлите условия.');
    const otherMessage = message(1, 'second', 'OTHER_CLIENT_SECRET');
    const foreignMessage = message(2, 'guest', 'FOREIGN_DIALOGUE_SECRET');
    const ownKnowledge = knowledge(1, 'Установку согласуем с клиентом. Оплата после подтверждения.');
    const oldKnowledge = knowledge(1, 'OBSOLETE_KNOWLEDGE_SECRET', 0);
    const foreignKnowledge = knowledge(2, 'FOREIGN_KNOWLEDGE_SECRET');
    const ownOffer = offer(1, 'own-offer');
    offer(1, 'draft-offer', false);
    offer(1, 'inactive-offer', true, false);
    offer(2, 'foreign-offer');
    DB.createConversationEvent({instanceId: 1, chatId: 'guest', eventId: 'own-call', callId: 'real-call', channel: 'voice', content: 'Обсудили установку.'});
    DB.createConversationEvent({instanceId: 2, chatId: 'guest', eventId: 'foreign-call', callId: 'foreign-call', channel: 'voice', content: 'FOREIGN_CALL_SECRET'});
    const actors = Object.fromEntries(['owner', 'lead', 'manager', 'other', 'observer', 'foreign'].map(id => [id, Identity.actor(id)]));
    return {...actors, ownMessage, otherMessage, foreignMessage, ownKnowledge, oldKnowledge, foreignKnowledge, ownOffer};
}

function reply(f, extra = {}) {
    return JSON.stringify({text: 'Здравствуйте! Уточним удобное время установки.', sourceIds: ['message:' + f.ownMessage, 'knowledge:' + f.ownKnowledge.chunk], ...extra});
}

function record(messages, ref) {
    const input = JSON.parse(messages.find(item => item.role === 'user').content);
    const found = input.records.find(item => item.ref === ref);
    assert.ok(found, 'Expected scoped prompt record ' + ref);
    return found;
}

function fact(messages, ref, value) {
    const found = record(messages, ref);
    assert.ok(Array.isArray(found.facts), 'Prompt record must expose an exact facts allowlist');
    const item = found.facts.find(candidate => candidate.value === value);
    assert.ok(item, 'Expected grounded fact ' + JSON.stringify(value) + ' on ' + ref);
    assert.strictEqual(typeof item.id, 'string');
    assert.ok(item.id);
    return item;
}

function factMessage(f, content = 'Встреча 07.10.2026 в 15:30. Подготовьте 2 варианта.') {
    DB.run('UPDATE messages SET content=? WHERE id=?', [content, f.ownMessage]);
    return 'message:' + f.ownMessage;
}

function dialogueRevision(businessId, chatId) {
    const rows = [DB.all('SELECT * FROM messages WHERE instanceId=? AND chatId=? ORDER BY id', [businessId, chatId]),
        DB.all('SELECT * FROM conversation_events WHERE instanceId=? AND chatId=? ORDER BY eventId', [businessId, chatId])];
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function effects() {
    return Object.fromEntries(['messages', 'conversation_events', 'manager_tasks', 'followup_drafts', 'ava_quotes',
        'ava_client_promises', 'ava_catalog_offers', 'ava_catalog_versions', 'ava_autopilot_actions', 'customer_deals'].map(table =>
        [table, DB.all('SELECT * FROM ' + table + ' ORDER BY rowid')]));
}

// Only the copilot modules see these temporary dependencies. This is important
// when run-tests loads other suites into the same process before executing ours.
async function copilot(f, model, work) {
    const load = Module._load;
    const originalAI = AI.generatePlainText;
    const originalResolver = AI._resolveProviderConfig;
    const originalSend = Channel.sendMessageDetailed;
    const control = {enabled: true, allowedBusinesses: new Set([1, 2]), revisionOverride: null, resolve: null, resolutions: [], calls: [], sends: 0};
    const flags = {assertEnabled(businessId, feature) {
        assert.ok(control.allowedBusinesses.has(Number(businessId)));
        assert.strictEqual(feature, 'copilot');
        if (!control.enabled) throw Object.assign(new Error('AVA_FEATURE_DISABLED'), {code: 'AVA_FEATURE_DISABLED', statusCode: 409});
    }};
    const collaboration = {dialogueRevision(businessId, chatId) {
        return control.revisionOverride ?? dialogueRevision(businessId, chatId);
    }};
    Module._load = function(request, parent, isMain) {
        if (parent && [servicePath, routesPath].includes(parent.filename)) {
            if (request.endsWith('/ava-improvements-flags.service') || request === './ava-improvements-flags.service') return flags;
            if (request.endsWith('/ava-collaboration.service') || request === './ava-collaboration.service') return collaboration;
        }
        return load.call(this, request, parent, isMain);
    };
    AI.generatePlainText = async (...args) => {
        control.calls.push(args);
        return typeof model === 'function' ? model(...args) : model;
    };
    AI._resolveProviderConfig = function(instance) {
        control.resolutions.push(instance.id);
        return control.resolve ? control.resolve(instance) : originalResolver.call(this, instance);
    };
    Channel.sendMessageDetailed = async () => { control.sends++; throw new Error('Draft generation attempted a send'); };
    delete require.cache[servicePath];
    delete require.cache[routesPath];
    try {
        const Service = require(servicePath);
        await work(Service, control);
        assert.strictEqual(control.sends, 0);
    } finally {
        Module._load = load;
        AI.generatePlainText = originalAI;
        AI._resolveProviderConfig = originalResolver;
        Channel.sendMessageDetailed = originalSend;
        delete require.cache[servicePath];
        delete require.cache[routesPath];
    }
}

function rejects(promise, code) {
    return assert.rejects(promise, error => error.code === code);
}

async function duringModel(f, mutate, expected, chatId = 'guest') {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    await copilot(f, async () => { entered(); await gate; return reply(f); }, async (Service, control) => {
        const pending = Service.generate(f.manager, 1, chatId, {intent: 'reply'});
        const rejection = rejects(pending, expected);
        await started;
        let afterMutation;
        try { mutate(control); afterMutation = effects(); } finally { release(); }
        await rejection;
        assert.strictEqual(control.calls.length, 1);
        assert.deepStrictEqual(effects(), afterMutation);
    });
}

async function http(actor, work) {
    const app = express();
    app.use(express.json({strict: false}));
    app.use((req, _res, next) => { req.auth = actor; next(); });
    app.use('/api', require(routesPath));
    const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const previous = process.env.WHATSAPP_CRM_PUBLIC_URL;
    process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
    try {
        await work((body = {intent: 'reply'}, options = {}) => {
            const headers = {'Content-Type': 'application/json', Origin: origin, ...options.headers};
            if (options.withoutOrigin) delete headers.Origin;
            return fetch(origin + '/api/businesses/' + (options.businessId ?? 1) + '/workspace/clients/' + (options.chatId ?? 'guest') + '/copilot' + (options.query ?? ''),
                {method: 'POST', headers, body: JSON.stringify(body), ...(options.signal ? {signal: options.signal} : {})});
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previous === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
        else process.env.WHATSAPP_CRM_PUBLIC_URL = previous;
    }
}

describe('AVA copilot scoped, cancellable drafts without business effects', () => {
    it('keeps unknown-send ownership fenced and exposes uncertainty to the model without retrying', async () => {
        const f = setup();
        Workspace.beginAiSend({businessId: 1, chatId: 'guest', sendId: 'uncertain-send'});
        Workspace.endAiSend({businessId: 1, chatId: 'guest', sendId: 'uncertain-send', status: 'unknown'});
        const before = effects(), controlBefore = Workspace.getControl(1, 'guest');
        await copilot(f, reply(f, {text: 'Проверить результат прежней отправки.'}), async (Service, control) => {
            const result = await Service.generate(f.manager, 1, 'guest', {intent: 'next_action'});
            assert.strictEqual(result.draft.kind, 'next_action');
            assert.strictEqual(JSON.parse(control.calls[0][0][1].content).control.sendStatus, 'unknown');
            assert.deepStrictEqual(Workspace.getControl(1, 'guest'), controlBefore);
            assert.deepStrictEqual(effects(), before);
            assert.throws(() => Workspace.beginAiSend({businessId: 1, chatId: 'guest', sendId: 'retry'}), error => error.code === 'WORKSPACE_SEND_IN_PROGRESS');
        });
    });
    it('returns grounded reply sources with genuine revision and excludes tenant and client secrets from the model', async () => {
        const f = setup(), before = effects();
        await copilot(f, reply(f), async (Service, control) => {
            const result = await Service.generate(f.manager, 1, 'guest', {intent: 'reply'});
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.businessId, 1);
            assert.strictEqual(result.draft.kind, 'reply');
            assert.ok(result.draft.id);
            assert.strictEqual(result.draft.text, JSON.parse(reply(f)).text);
            assert.strictEqual(result.dialogueRevision, dialogueRevision(1, 'guest'));
            assert.strictEqual(result.draft.task, undefined);
            assert.strictEqual(result.draft.offerId, undefined);
            assert.strictEqual(result.draft.sources.length, 2);
            assert.ok(result.draft.sources.some(source => source.type === 'message' && String(source.id) === String(f.ownMessage)));
            for (const source of result.draft.sources) {
                assert.strictEqual(typeof source.title, 'string');
                assert.strictEqual(typeof source.href, 'string');
                assert.ok(source.href.startsWith('/') && !source.href.startsWith('//'));
            }
            const prompt = JSON.stringify(control.calls[0][0]);
            for (const secret of ['FOREIGN_BUSINESS_SECRET', 'FOREIGN_CLIENT_SECRET', 'FOREIGN_DIALOGUE_SECRET', 'FOREIGN_CALL_SECRET', 'FOREIGN_KNOWLEDGE_SECRET', 'OTHER_CLIENT_SECRET', 'OBSOLETE_KNOWLEDGE_SECRET']) assert.ok(!prompt.includes(secret), secret);
            for (const credential of ['synthetic-key', 'foreign-key', 'gpt://synthetic/model', 'gpt://foreign/model']) assert.ok(!prompt.includes(credential), credential);
            assert.ok(!prompt.includes('foreign-offer') && !prompt.includes('draft-offer') && !prompt.includes('inactive-offer'));
            const options = control.calls[0][2];
            assert.ok(options.signal && Number.isFinite(options.deadline));
            assert.strictEqual(options.maxTokens, 1800);
            assert.strictEqual(options.fallbackModel, null);
            assert.deepStrictEqual(effects(), before);
        });
    });

    it('renders published offer price from minor units and creates no quote or sent offer', async () => {
        const f = setup(), before = effects();
        await copilot(f, reply(f, {text: 'Предлагаем монтаж: [[price:own-offer]].', sourceIds: ['offer:own-offer', 'knowledge:' + f.ownKnowledge.chunk], offerId: 'own-offer'}), async Service => {
            const result = await Service.generate(f.manager, 1, 'guest', {intent: 'offer'});
            assert.strictEqual(result.draft.kind, 'offer');
            assert.strictEqual(result.draft.offerId, 'own-offer');
            assert.ok(!result.draft.text.includes('[[price:'));
            assert.ok(/1[\s\u00a0\u202f]?234[,.]5/.test(result.draft.text), result.draft.text);
            assert.ok(result.draft.sources.some(source => source.type === 'offer' && source.id === 'own-offer'));
            assert.deepStrictEqual(effects(), before);
        });
    });

    it('returns a proposed next task without creating manager task, promise, deal or message', async () => {
        const f = setup(), before = effects();
        await copilot(f, reply(f, {text: 'Уточнить удобное время установки.'}), async Service => {
            const result = await Service.generate(f.manager, 1, 'guest', {intent: 'next_action'});
            assert.strictEqual(result.draft.kind, 'next_action');
            assert.deepStrictEqual(result.draft.task, {summary: 'Уточнить удобное время установки.', priority: 'normal'});
            assert.deepStrictEqual(effects(), before);
        });
    });

    it('grounds the next step in exact call, task, promise and deal records', async () => {
        const f = setup();
        const task = DB.createManagerTask({instanceId: 1, chatId: 'guest', summary: 'Уточнить установку', assigneeUserId: 'manager'});
        const promise = Workspace.createPromise({businessId: 1, chatId: 'guest', summary: 'Перезвонить'});
        const deal = require('../src/services/customer-deals.store').create(1, {title: 'Монтаж', clientChatId: 'guest'});
        const refs = ['client', 'call:own-call', 'task:' + task.taskId, 'promise:' + promise.id, 'deal:' + deal.id];
        const before = effects();
        await copilot(f, reply(f, {sourceIds: refs}), async Service => {
            const result = await Service.generate(f.manager, 1, 'guest', {intent: 'next_action'});
            assert.deepStrictEqual(result.draft.sources.map(source => source.type), ['client', 'call', 'task', 'promise', 'deal']);
            assert.deepStrictEqual(effects(), before);
        });
    });

    it('keeps tenant instructions inside user context and out of the system rules and credential data', async () => {
        const f = setup();
        DB.run("UPDATE instances SET systemPrompt='TENANT_INSTRUCTIONS: работаем только по записи.' WHERE id=1");
        await copilot(f, reply(f), async (Service, control) => {
            await Service.generate(f.manager, 1, 'guest', {intent: 'reply'});
            const [system, user] = control.calls[0][0];
            assert.strictEqual(system.role, 'system');
            assert.strictEqual(user.role, 'user');
            assert.ok(!system.content.includes('TENANT_INSTRUCTIONS'));
            assert.ok(user.content.includes('TENANT_INSTRUCTIONS'));
            assert.ok(!JSON.stringify([system, user]).includes('synthetic-key'));
        });
        await duringModel(f, () => DB.run("UPDATE instances SET systemPrompt='Новое правило бизнеса.' WHERE id=1"), 'COPILOT_CONTEXT_CHANGED');
    });

    it('rejects an oversized next task even though the text fits the reply limit', async () => {
        const f = setup(), before = effects();
        await copilot(f, reply(f, {text: 'x'.repeat(801)}), async Service => {
            await rejects(Service.generate(f.manager, 1, 'guest', {intent: 'next_action'}), 'COPILOT_INVALID_RESPONSE');
            assert.deepStrictEqual(effects(), before);
        });
    });

    it('allows owners and sales leads across assignments and resolves an assigned manager alias exactly', async () => {
        const f = setup();
        Canonical.attach(1, 'guest', {kind: 'telegram', value: '99110001'});
        await copilot(f, reply(f), async Service => {
            for (const actor of [f.owner, f.lead, f.manager]) assert.strictEqual((await Service.generate(actor, 1, 'tg_99110001', {intent: 'reply'})).success, true);
            await rejects(Service.generate(f.other, 1, 'tg_99110001', {intent: 'reply'}), 'SALES_CLIENT_SCOPE_DENIED');
        });
    });

    it('denies observers, other assignments, unclaimed clients and foreign actors before invoking the model', async () => {
        const f = setup(), before = effects();
        await copilot(f, reply(f), async (Service, control) => {
            for (const [actor, chatId, code] of [[f.observer, 'guest', 'CAPABILITY_DENIED'], [f.other, 'guest', 'SALES_CLIENT_SCOPE_DENIED'], [f.manager, 'queue', 'SALES_CLIENT_CLAIM_REQUIRED'], [f.foreign, 'guest', 'BUSINESS_ACCESS_DENIED']]) await rejects(Service.generate(actor, 1, chatId, {intent: 'reply'}), code);
            assert.strictEqual(control.calls.length, 0);
            assert.deepStrictEqual(effects(), before);
        });
    });

    it('rejects live role revocation after model await', async () => {
        const f = setup();
        await duringModel(f, () => DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId='manager'"), 'CAPABILITY_DENIED');
    });
    it('rejects live disabled membership after model await', async () => {
        const f = setup();
        await duringModel(f, () => DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='manager'"), 'BUSINESS_ACCESS_DENIED');
    });
    it('rejects reassignment after model await even with a stale auth snapshot', async () => {
        const f = setup();
        await duringModel(f, () => DB.run("UPDATE clients SET assigneeUserId='other' WHERE instanceId=1 AND chatId='guest'"), 'SALES_CLIENT_SCOPE_DENIED');
    });
    it('rejects a canonical client merge after model await', async () => {
        const f = setup();
        DB.run("UPDATE clients SET assigneeUserId='manager' WHERE instanceId=1 AND chatId='second'");
        Canonical.attach(1, 'guest', {kind: 'telegram', value: '99110001'});
        await duringModel(f, () => Canonical.attach(1, 'second', {kind: 'telegram', value: '99110001', confirmMerge: true, mergeChatId: 'guest'}), 'COPILOT_CONTEXT_CHANGED', 'tg_99110001');
    });
    it('rejects new inbound messages after model await', async () => {
        const f = setup();
        await duringModel(f, () => message(1, 'guest', 'Установка уже не нужна.'), 'COPILOT_CONTEXT_CHANGED');
    });
    it('rejects updated call evidence after model await', async () => {
        const f = setup();
        await duringModel(f, () => DB.run("UPDATE conversation_events SET content='Клиент отменил установку.' WHERE instanceId=1 AND eventId='own-call'"), 'COPILOT_CONTEXT_CHANGED');
    });
    it('honors the shared dialogue revision even without a new message row', async () => {
        const f = setup();
        await duringModel(f, control => { control.revisionOverride = 'changed-shared-revision'; }, 'COPILOT_CONTEXT_CHANGED');
    });
    it('keeps a draft valid when only another tenant dialogue changes', async () => {
        const f = setup();
        await copilot(f, async () => { message(2, 'guest', 'Foreign update'); return reply(f); }, async Service => {
            assert.strictEqual((await Service.generate(f.manager, 1, 'guest', {intent: 'reply'})).success, true);
        });
    });

    for (const [name, mutate] of [
        ['business settings', () => DB.run("UPDATE instances SET name='Renamed business' WHERE id=1")],
        ['provider credentials', () => DB.run("UPDATE instances SET yandexGptKey='new-synthetic-key' WHERE id=1")],
        ['provider model', () => DB.run("UPDATE instances SET yandexGptModelUri='gpt://synthetic/changed' WHERE id=1")],
        ['current knowledge', f => DB.run('UPDATE kb_chunks SET text=? WHERE id=?', ['Политика изменилась.', f.ownKnowledge.chunk])],
        ['knowledge publication', f => DB.run('UPDATE knowledge_base SET isCurrent=0 WHERE id=?', [f.ownKnowledge.kb])],
        ['published catalog price', f => Catalog.saveOffer(1, {...f.ownOffer, revision: 2, amountMinor: 234500})]
    ]) it('rejects changed ' + name + ' after model await', async () => {
        const f = setup();
        await duringModel(f, () => mutate(f), 'COPILOT_CONTEXT_CHANGED');
    });

    it('rejects unavailable knowledge storage instead of silently treating it as empty', async () => {
        const f = setup();
        DB.db.exec('DROP TABLE kb_chunks');
        await copilot(f, reply(f), async (Service, control) => {
            await rejects(Service.generate(f.manager, 1, 'guest', {intent: 'reply'}), 'COPILOT_KNOWLEDGE_UNAVAILABLE');
            assert.strictEqual(control.calls.length, 0);
        });
    });

    for (const intent of ['reply', 'next_action', 'offer']) it('supports grounded ' + intent + ' drafts with empty current knowledge', async () => {
        const f = setup();
        DB.run('UPDATE knowledge_base SET isCurrent=0 WHERE instanceId=1');
        const output = intent === 'offer'
            ? reply(f, {text: 'Монтаж: [[price:own-offer]].', sourceIds: ['offer:own-offer'], offerId: 'own-offer'})
            : reply(f, {sourceIds: ['message:' + f.ownMessage, 'call:own-call']});
        const before = effects();
        await copilot(f, output, async (Service, control) => {
            const result = await Service.generate(f.manager, 1, 'guest', {intent});
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.draft.kind, intent);
            assert.ok(result.draft.sources.every(source => source.type !== 'knowledge'));
            const input = JSON.parse(control.calls[0][0][1].content);
            assert.strictEqual(input.knowledgeState, 'empty');
            assert.deepStrictEqual(effects(), before);
        });
    });

    it('rejects a completely ungrounded assigned client when knowledge, history and published catalog are empty', async () => {
        const f = setup();
        DB.run('UPDATE knowledge_base SET isCurrent=0 WHERE instanceId=1');
        DB.run("DELETE FROM messages WHERE instanceId=1 AND chatId='guest'");
        DB.run("DELETE FROM conversation_events WHERE instanceId=1 AND chatId='guest'");
        Catalog.saveOffer(1, {...f.ownOffer, active: false});
        await copilot(f, reply(f, {sourceIds: ['client']}), async (Service, control) => {
            await rejects(Service.generate(f.manager, 1, 'guest', {intent: 'reply'}), 'COPILOT_KNOWLEDGE_EMPTY');
            assert.strictEqual(control.calls.length, 0);
        });
    });

    it('retrieves relevant older knowledge beyond the most recent twelve documents using real scoped FTS', async () => {
        const f = setup();
        const target = knowledge(1, 'Условия velocipede согласуются с клиентом.');
        for (let n = 0; n < 15; n++) knowledge(1, 'Нерелевантная справка об уборке офиса.');
        knowledge(2, 'velocipede FOREIGN_FTS_MATCH_SECRET');
        message(1, 'guest', 'Прошу условия velocipede.');
        await copilot(f, reply(f, {sourceIds: ['knowledge:' + target.chunk]}), async (Service, control) => {
            const result = await Service.generate(f.manager, 1, 'guest', {intent: 'reply'});
            assert.strictEqual(result.draft.sources[0].id, String(target.chunk));
            const prompt = JSON.stringify(control.calls[0][0]);
            assert.ok(prompt.includes('Условия velocipede'));
            assert.ok(!prompt.includes('FOREIGN_FTS_MATCH_SECRET'));
        });
    });

    it('selects a relevant published offer beyond the first fifteen catalog entries', async () => {
        const f = setup();
        for (let n = 0; n < 17; n++) {
            const irrelevant = offer(1, 'irrelevant-' + n);
            Catalog.saveOffer(1, {...irrelevant, name: 'Клининг', description: 'Уборка офиса', terms: ''});
        }
        const target = offer(1, 'velocipede-offer');
        Catalog.saveOffer(1, {...target, name: 'Velocipede', description: 'Условия velocipede', terms: ''});
        message(1, 'guest', 'Прошу предложение velocipede.');
        await copilot(f, reply(f, {text: 'Velocipede: [[price:velocipede-offer]].', sourceIds: ['offer:velocipede-offer'], offerId: 'velocipede-offer'}), async Service => {
            const result = await Service.generate(f.manager, 1, 'guest', {intent: 'offer'});
            assert.strictEqual(result.draft.offerId, 'velocipede-offer');
            assert.strictEqual(result.draft.sources[0].id, 'velocipede-offer');
        });
    });

    it('maps resolver failure to a public configuration error without exposing credentials or invoking the model', async () => {
        const f = setup();
        await copilot(f, reply(f), async (Service, control) => {
            control.resolve = () => { throw new Error('synthetic-private-resolver-secret'); };
            await rejects(Service.generate(f.manager, 1, 'guest', {intent: 'reply'}), 'COPILOT_AI_NOT_CONFIGURED');
            assert.strictEqual(control.calls.length, 0);
        });
    });

    it('uses legitimate resolver defaults when the tenant key and model are absent', async () => {
        const f = setup();
        DB.run('UPDATE instances SET yandexGptKey=NULL,yandexGptModelUri=NULL WHERE id=1');
        await copilot(f, reply(f), async (Service, control) => {
            let resolutions = 0;
            control.resolve = instance => {
                assert.strictEqual(instance.id, 1);
                assert.strictEqual(instance.yandexGptKey, null);
                resolutions++;
                return {provider: 'aitunnel', apiKey: 'synthetic-default-key', model: 'synthetic-default-model', temperature: 0.4};
            };
            assert.strictEqual((await Service.generate(f.manager, 1, 'guest', {intent: 'reply'})).success, true);
            assert.ok(resolutions >= 2);
            assert.strictEqual(control.calls[0][1].aiProvider, 'aitunnel');
            assert.strictEqual(control.calls[0][1].yandexGptKey, 'synthetic-default-key');
            assert.strictEqual(control.calls[0][1].yandexGptModelUri, 'synthetic-default-model');
            const prompt = JSON.stringify(control.calls[0][0]);
            assert.ok(!prompt.includes('synthetic-default-key') && !prompt.includes('synthetic-default-model'));
        });
    });

    it('honors the real resolver provider compatibility and pins an explicit tenant model', async () => {
        const f = setup();
        DB.run("UPDATE instances SET aiProvider='openrouter',yandexGptKey='synthetic-aitunnel',yandexGptModelUri='tenant-model' WHERE id=1");
        await copilot(f, reply(f), async (Service, control) => {
            assert.strictEqual((await Service.generate(f.manager, 1, 'guest', {intent: 'reply'})).success, true);
            assert.strictEqual(control.calls[0][1].aiProvider, 'aitunnel');
            assert.strictEqual(control.calls[0][1].yandexGptKey, 'synthetic-aitunnel');
            assert.strictEqual(control.calls[0][1].yandexGptModelUri, 'tenant-model');
        });
    });

    it('keeps two tenants isolated when the resolver returns a shared provider key and model', async () => {
        const f = setup();
        DB.run('UPDATE instances SET yandexGptKey=NULL,yandexGptModelUri=NULL');
        DB.run("UPDATE instances SET systemPrompt='OUR_TENANT_POLICY' WHERE id=1");
        DB.run("UPDATE instances SET systemPrompt='FOREIGN_TENANT_POLICY' WHERE id=2");
        const before = effects(), providerConfig = require('../src/config').aiTunnel;
        const previousKey = providerConfig.apiKey, previousModel = providerConfig.model;
        providerConfig.apiKey = 'synthetic-shared-key';
        providerConfig.model = 'synthetic-shared-model';
        try { await copilot(f, async messages => {
            const input = JSON.parse(messages[1].content);
            return input.business.name === 'Our business' ? reply(f) : reply(f, {sourceIds: ['message:' + f.foreignMessage, 'knowledge:' + f.foreignKnowledge.chunk]});
        }, async (Service, control) => {
            const own = await Service.generate(f.manager, 1, 'guest', {intent: 'reply'});
            const foreign = await Service.generate(f.foreign, 2, 'guest', {intent: 'reply'});
            assert.strictEqual(own.businessId, 1);
            assert.strictEqual(foreign.businessId, 2);
            assert.ok(own.draft.sources.some(source => source.id === String(f.ownMessage)));
            assert.ok(foreign.draft.sources.some(source => source.id === String(f.foreignMessage)));
            assert.deepStrictEqual(control.resolutions, [1, 1, 2, 2]);
            for (const [index, included, excluded] of [[0, 'OUR_TENANT_POLICY', 'FOREIGN_TENANT_POLICY'], [1, 'FOREIGN_TENANT_POLICY', 'OUR_TENANT_POLICY']]) {
                const [messages, config] = control.calls[index];
                const prompt = JSON.stringify(messages);
                assert.ok(prompt.includes(included) && !prompt.includes(excluded));
                assert.ok(!prompt.includes('synthetic-shared-key') && !prompt.includes('synthetic-shared-model'));
                assert.strictEqual(config.yandexGptKey, 'synthetic-shared-key');
                assert.strictEqual(config.yandexGptModelUri, 'synthetic-shared-model');
            }
            assert.deepStrictEqual(effects(), before);
        }); } finally {
            providerConfig.apiKey = previousKey;
            providerConfig.model = previousModel;
        }
    });

    it('rejects absent published offers for offer intent while permitting a grounded reply', async () => {
        const f = setup();
        Catalog.saveOffer(1, {...f.ownOffer, active: false});
        await copilot(f, reply(f), async (Service, control) => {
            await rejects(Service.generate(f.manager, 1, 'guest', {intent: 'offer'}), 'COPILOT_CATALOG_EMPTY');
            assert.strictEqual(control.calls.length, 0);
            assert.strictEqual((await Service.generate(f.manager, 1, 'guest', {intent: 'reply'})).success, true);
        });
    });

    it('validates service intents and denies caller-supplied instructions, sources and task fields before model work', async () => {
        const f = setup();
        await copilot(f, reply(f), async (Service, control) => {
            for (const body of [undefined, null, [], {}, {intent: 'send'}, {intent: 'reply', text: 'Injected'}, {intent: 'reply', sourceIds: ['client']}, {intent: 'next_action', task: {summary: 'Injected'}}]) await rejects(Service.generate(f.manager, 1, 'guest', body), 'COPILOT_INPUT_INVALID');
            assert.strictEqual(control.calls.length, 0);
        });
    });

    it('rejects malformed, ungrounded, oversized and injected model output without effects', async () => {
        const f = setup(), before = effects();
        const outputs = ['not-json', '[]', 'null', JSON.stringify({text: 'Hello', sourceIds: []}),
            reply(f, {text: 'x'.repeat(3001)}), reply(f, {sourceIds: ['message:invented']}),
            reply(f, {sourceIds: ['message:' + f.foreignMessage]}), reply(f, {sourceIds: ['message:' + f.otherMessage]}),
            reply(f, {sourceIds: ['call:foreign-call']}), reply(f, {sourceIds: ['knowledge:' + f.foreignKnowledge.chunk]}),
            reply(f, {sourceIds: ['knowledge:' + f.oldKnowledge.chunk]}), reply(f, {sourceIds: ['offer:foreign-offer']}),
            reply(f, {sourceIds: ['offer:draft-offer']}), reply(f, {sourceIds: ['offer:inactive-offer']}),
            reply(f, {sourceIds: [{type: 'message', id: f.ownMessage, href: 'https://attacker.example'}]}),
            reply(f, {task: {summary: 'Injected', priority: 'urgent'}})];
        for (const output of outputs) await copilot(f, output, async Service => {
            await rejects(Service.generate(f.manager, 1, 'guest', {intent: 'reply'}), 'COPILOT_INVALID_RESPONSE');
            assert.deepStrictEqual(effects(), before);
        });
    });

    it('rejects model-invented prices, unknown price placeholders and offer claims without an exact source', async () => {
        const f = setup(), before = effects();
        for (const text of ['Монтаж стоит 100 рублей.', 'Монтаж стоит сто рублей.', 'Монтаж стоит $100.', 'Монтаж стоит пятьдесят копеек.', 'Цена — пара центов.', 'Цена — сорок.', 'Цена — forty.', 'Цена — ١٠٠.', 'Скидка 10%.', 'Цена [[price:foreign-offer]].', 'Цена [[price:missing]].', 'Цена [[price:own-offer]].']) {
            await copilot(f, reply(f, {text}), async Service => {
                await rejects(Service.generate(f.manager, 1, 'guest', {intent: 'reply'}), 'COPILOT_INVALID_RESPONSE');
                assert.deepStrictEqual(effects(), before);
            });
        }
        for (const extra of [{offerId: 'foreign-offer'}, {offerId: 'draft-offer'}, {offerId: 'own-offer'},
            {offerId: 'own-offer', text: 'Цена [[price:own-offer]].'},
            {offerId: 'own-offer', sourceIds: ['offer:own-offer']}]) {
            await copilot(f, reply(f, extra), async Service => {
                await rejects(Service.generate(f.manager, 1, 'guest', {intent: 'offer'}), 'COPILOT_INVALID_RESPONSE');
            });
        }
    });

    it('allows harmless numerical words in Russian and English proposed next steps', async () => {
        const f = setup(), before = effects();
        for (const text of ['Предложить один следующий шаг.', 'Предложить два варианта.', 'Offer one option.']) {
            await copilot(f, reply(f, {text}), async Service => {
                const result = await Service.generate(f.manager, 1, 'guest', {intent: 'next_action'});
                assert.strictEqual(result.draft.text, text);
                assert.deepStrictEqual(result.draft.task, {summary: text, priority: 'normal'});
                assert.deepStrictEqual(effects(), before);
            });
        }
    });

    for (const intent of ['reply', 'next_action']) it('renders exact cited date, time and count facts for ' + intent, async () => {
        const f = setup(), ref = factMessage(f), before = effects();
        await copilot(f, async messages => {
            const date = fact(messages, ref, '07.10.2026'), time = fact(messages, ref, '15:30'), count = fact(messages, ref, '2 варианта');
            return reply(f, {text: `Встреча [[fact:${date.id}]] в [[fact:${time.id}]]. Подготовить [[fact:${count.id}]].`, sourceIds: [ref]});
        }, async Service => {
            const result = await Service.generate(f.manager, 1, 'guest', {intent});
            const expected = 'Встреча 07.10.2026 в 15:30. Подготовить 2 варианта.';
            assert.strictEqual(result.draft.text, expected);
            if (intent === 'next_action') assert.deepStrictEqual(result.draft.task, {summary: expected, priority: 'normal'});
            assert.ok(!result.draft.text.includes('[[fact:'));
            assert.strictEqual(result.draft.sources.length, 1);
            assert.strictEqual(result.draft.sources[0].id, String(f.ownMessage));
            assert.deepStrictEqual(effects(), before);
        });
    });

    it('rejects invented fact IDs and real fact IDs whose source was not cited', async () => {
        const f = setup(), ref = factMessage(f), before = effects();
        for (const fake of [false, true]) await copilot(f, async messages => {
            const date = fact(messages, ref, '07.10.2026');
            return reply(f, {text: `Встреча [[fact:${fake ? 'invented-fact' : date.id}]].`, sourceIds: fake ? [ref] : ['knowledge:' + f.ownKnowledge.chunk]});
        }, async Service => {
            await rejects(Service.generate(f.manager, 1, 'guest', {intent: 'reply'}), 'COPILOT_INVALID_RESPONSE');
            assert.deepStrictEqual(effects(), before);
        });
    });

    it('does not accept a fact ID captured from another tenant with identical date text', async () => {
        const f = setup(), ref = factMessage(f), foreignRef = 'message:' + f.foreignMessage;
        DB.run('UPDATE messages SET content=? WHERE id=?', ['Встреча 07.10.2026.', f.foreignMessage]);
        let foreignFact;
        await copilot(f, async messages => {
            const input = JSON.parse(messages.find(item => item.role === 'user').content);
            if (input.business.name === 'FOREIGN_BUSINESS_SECRET') {
                foreignFact = fact(messages, foreignRef, '07.10.2026');
                return reply(f, {sourceIds: [foreignRef]});
            }
            assert.notStrictEqual(fact(messages, ref, '07.10.2026').id, foreignFact.id);
            return reply(f, {text: `Встреча [[fact:${foreignFact.id}]].`, sourceIds: [ref]});
        }, async Service => {
            await Service.generate(f.foreign, 2, 'guest', {intent: 'reply'});
            await rejects(Service.generate(f.manager, 1, 'guest', {intent: 'reply'}), 'COPILOT_INVALID_RESPONSE');
        });
    });

    it('rejects replay of a fact from an older message excluded by the bounded prompt', async () => {
        const f = setup(), ref = factMessage(f);
        let capturedFact, latest;
        await copilot(f, async messages => {
            const records = JSON.parse(messages.find(item => item.role === 'user').content).records;
            if (!capturedFact) {
                capturedFact = fact(messages, ref, '07.10.2026');
                return reply(f, {sourceIds: [ref]});
            }
            assert.ok(!records.some(item => item.ref === ref));
            assert.ok(!records.some(item => item.facts?.some(candidate => candidate.id === capturedFact.id)));
            return reply(f, {text: `Встреча [[fact:${capturedFact.id}]].`, sourceIds: ['message:' + latest]});
        }, async Service => {
            await Service.generate(f.manager, 1, 'guest', {intent: 'reply'});
            for (let n = 0; n < 13; n++) latest = message(1, 'guest', 'Новый вопрос клиента.');
            await rejects(Service.generate(f.manager, 1, 'guest', {intent: 'reply'}), 'COPILOT_INVALID_RESPONSE');
        });
    });

    it('rejects a fact-bearing draft when the original source changes during model work', async () => {
        const f = setup(), ref = factMessage(f);
        let entered, release;
        const started = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        await copilot(f, async messages => {
            entered();
            const date = fact(messages, ref, '07.10.2026');
            await gate;
            return reply(f, {text: `Встреча [[fact:${date.id}]].`, sourceIds: [ref]});
        }, async Service => {
            const pending = Service.generate(f.manager, 1, 'guest', {intent: 'reply'});
            const rejected = rejects(pending, 'COPILOT_CONTEXT_CHANGED');
            await started;
            DB.run('UPDATE messages SET content=? WHERE id=?', ['Встреча перенесена на 08.10.2026.', f.ownMessage]);
            release();
            await rejected;
        });
    });

    it('does not turn monetary source values or metadata identifiers into facts', async () => {
        const f = setup(), ref = factMessage(f, 'Монтаж стоит 999 рублей. Встреча 07.10.2026 в 15:30. Нужно 2 варианта.');
        DB.run('UPDATE messages SET timestamp=? WHERE id=?', ['2031-04-05T06:07:00Z', f.ownMessage]);
        await copilot(f, async messages => {
            const own = record(messages, ref);
            assert.ok(Array.isArray(own.facts));
            assert.ok(!own.facts.some(candidate => /999|рубл|05\.04\.2031|06:07/.test(candidate.value)));
            fact(messages, ref, '07.10.2026');
            fact(messages, ref, '15:30');
            fact(messages, ref, '2 варианта');
            for (const reference of ['client', 'offer:own-offer', 'call:own-call']) {
                const item = record(messages, reference);
                assert.ok(!(item.facts || []).some(candidate => candidate.value === '123450' || candidate.value === String(f.ownMessage) || candidate.value === '2026-10-02'));
            }
            return reply(f, {sourceIds: [ref]});
        }, async Service => assert.strictEqual((await Service.generate(f.manager, 1, 'guest', {intent: 'reply'})).success, true));
    });

    it('renders task and promise due dates as deterministic business timezone facts', async () => {
        const f = setup();
        DB.run('INSERT INTO ava_autopilot_policies(businessId,revision,payloadJson,ownerUserId,updatedAt) VALUES(?,?,?,?,?)',
            [1, 1, JSON.stringify({timezone: 'Europe/Moscow'}), 'owner', '2026-10-07T09:00:00Z']);
        const task = DB.createManagerTask({instanceId: 1, chatId: 'guest', summary: 'Уточнить установку', assigneeUserId: 'manager', dueAt: '2026-10-07T12:30:00Z'});
        const promise = Workspace.createPromise({businessId: 1, chatId: 'guest', summary: 'Перезвонить', dueAt: '2026-10-07T12:30:00Z'});
        const refs = ['task:' + task.taskId, 'promise:' + promise.id], before = effects();
        for (const ref of refs) await copilot(f, async messages => {
            const input = JSON.parse(messages.find(item => item.role === 'user').content);
            assert.strictEqual(input.timezone, 'Europe/Moscow');
            const due = fact(messages, ref, '07.10.2026, 15:30');
            return reply(f, {text: `Уточнить установку [[fact:${due.id}]].`, sourceIds: [ref]});
        }, async Service => {
            const result = await Service.generate(f.manager, 1, 'guest', {intent: 'next_action'});
            assert.strictEqual(result.draft.text, 'Уточнить установку 07.10.2026, 15:30.');
            assert.strictEqual(result.draft.task.summary, result.draft.text);
            assert.deepStrictEqual(effects(), before);
        });
    });

    it('rejects valid fact markers reused as prices, discounts or priced quantities', async () => {
        const f = setup(), ref = factMessage(f), before = effects();
        for (const render of [id => `Цена — [[fact:${id}]].`, id => `Скидка [[fact:${id}]].`, id => `Price [[fact:${id}]].`,
            id => `Стоимость [[fact:${id}]] за комплект.`, id => `Предложение [[price:own-offer]] за [[fact:${id}]].`]) {
            await copilot(f, async messages => {
                const count = fact(messages, ref, '2 варианта');
                return reply(f, {text: render(count.id), sourceIds: [ref, 'offer:own-offer']});
            }, async Service => {
                await rejects(Service.generate(f.manager, 1, 'guest', {intent: 'reply'}), 'COPILOT_INVALID_RESPONSE');
                assert.deepStrictEqual(effects(), before);
            });
        }
    });

    it('rejects raw numerical facts outside exact fact markers despite matching source text', async () => {
        const f = setup(), ref = factMessage(f);
        for (const text of ['Встреча 07.10.2026.', 'Встреча в 15:30.', 'Подготовить 2 варианта.']) await copilot(f, reply(f, {text, sourceIds: [ref]}), async Service => {
            await rejects(Service.generate(f.manager, 1, 'guest', {intent: 'reply'}), 'COPILOT_INVALID_RESPONSE');
        });
    });

    it('blocks feature-off before generation and rechecks it after the model await', async () => {
        const f = setup();
        await copilot(f, reply(f), async (Service, control) => {
            control.enabled = false;
            await rejects(Service.generate(f.manager, 1, 'guest', {intent: 'reply'}), 'AVA_FEATURE_DISABLED');
            assert.strictEqual(control.calls.length, 0);
        });
        await duringModel(f, control => { control.enabled = false; }, 'AVA_FEATURE_DISABLED');
    });

    it('aborts an unresponsive model at its deadline and never returns its late draft', async () => {
        const f = setup(), before = effects();
        let signal, finish;
        await copilot(f, async (_messages, _config, options) => {
            signal = options.signal;
            return new Promise(resolve => { finish = resolve; });
        }, async Service => {
            await rejects(Service.generate(f.manager, 1, 'guest', {intent: 'reply'}, {timeoutMs: 15}), 'COPILOT_TIMEOUT');
            assert.strictEqual(signal.aborted, true);
            finish(reply(f));
            await Promise.resolve();
            assert.deepStrictEqual(effects(), before);
        });
    });

    it('propagates caller cancellation and ignores a model completing after abort', async () => {
        const f = setup(), before = effects(), controller = new AbortController();
        let entered, finish, signal;
        const started = new Promise(resolve => { entered = resolve; });
        await copilot(f, async (_messages, _config, options) => {
            signal = options.signal;
            entered();
            return new Promise(resolve => { finish = resolve; });
        }, async Service => {
            const pending = Service.generate(f.manager, 1, 'guest', {intent: 'reply'}, {signal: controller.signal});
            const rejected = rejects(pending, 'COPILOT_CANCELED');
            await started;
            controller.abort();
            await rejected;
            assert.strictEqual(signal.aborted, true);
            finish(reply(f));
            await Promise.resolve();
            assert.deepStrictEqual(effects(), before);
        });
    });

    it('does no model work for an already canceled caller', async () => {
        const f = setup(), controller = new AbortController();
        controller.abort();
        await copilot(f, reply(f), async (Service, control) => {
            await rejects(Service.generate(f.manager, 1, 'guest', {intent: 'reply'}, {signal: controller.signal}), 'COPILOT_CANCELED');
            assert.strictEqual(control.calls.length, 0);
        });
    });

    it('serves grounded same-origin HTTP drafts and rejects missing, foreign and cross-site origins', async () => {
        const f = setup(), before = effects();
        await copilot(f, reply(f), async (_Service, control) => http(f.manager, async request => {
            const response = await request();
            assert.strictEqual(response.status, 200);
            const body = await response.json();
            assert.strictEqual(body.success, true);
            assert.strictEqual(body.draft.kind, 'reply');
            assert.strictEqual(body.dialogueRevision, dialogueRevision(1, 'guest'));
            for (const options of [{withoutOrigin: true}, {headers: {Origin: 'https://foreign.example'}}, {headers: {'Sec-Fetch-Site': 'cross-site'}}]) assert.strictEqual((await request({intent: 'reply'}, options)).status, 403);
            assert.strictEqual(control.calls.length, 1);
            assert.deepStrictEqual(effects(), before);
        }));
    });

    it('enforces HTTP live capability, assignment and tenant scope before model work', async () => {
        const f = setup();
        await copilot(f, reply(f), async (_Service, control) => {
            for (const actor of [f.observer, f.other, f.foreign]) await http(actor, async request => {
                assert.strictEqual((await request()).status, 403);
            });
            await http(f.manager, async request => {
                assert.strictEqual((await request({intent: 'reply'}, {businessId: 2})).status, 403);
                assert.strictEqual((await request({intent: 'reply', businessId: 2})).status, 403);
                assert.strictEqual((await request({intent: 'reply'}, {query: '?instanceId=2'})).status, 403);
                assert.strictEqual((await request({intent: 'reply'}, {chatId: 'queue'})).status, 403);
            });
            assert.strictEqual(control.calls.length, 0);
        });
    });

    it('returns HTTP validation and feature-off errors without invoking the model or revealing upstream details', async () => {
        const f = setup();
        await copilot(f, reply(f), async (_Service, control) => http(f.manager, async request => {
            for (const body of [{}, {intent: 'send'}, {intent: 'reply', text: 'Injected instruction'}, [], null]) assert.strictEqual((await request(body)).status, 400);
            control.enabled = false;
            const response = await request();
            assert.strictEqual(response.status, 409);
            assert.strictEqual((await response.json()).code, 'AVA_FEATURE_DISABLED');
            assert.strictEqual(control.calls.length, 0);
        }));
        await copilot(f, async () => { throw new Error('synthetic-secret-from-provider'); }, async () => http(f.manager, async request => {
            const response = await request();
            assert.ok(response.status >= 500);
            assert.ok(!(await response.text()).includes('synthetic-secret-from-provider'));
        }));
    });

    it('cancels model work when the HTTP caller disconnects and leaves business records intact', async () => {
        const f = setup(), before = effects(), controller = new AbortController();
        let entered, modelSignal;
        const started = new Promise(resolve => { entered = resolve; });
        await copilot(f, async (_messages, _config, options) => {
            modelSignal = options.signal;
            entered();
            return new Promise(() => {});
        }, async () => http(f.manager, async request => {
            const pending = request({intent: 'reply'}, {signal: controller.signal});
            const rejected = assert.rejects(pending, error => error.name === 'AbortError');
            await started;
            let timer;
            const aborted = new Promise((resolve, reject) => {
                modelSignal.addEventListener('abort', resolve, {once: true});
                timer = setTimeout(() => reject(new Error('HTTP disconnect did not cancel generation')), 1000);
            });
            try {
                controller.abort();
                await rejected;
                await aborted;
                assert.strictEqual(modelSignal.aborted, true);
                assert.deepStrictEqual(effects(), before);
            } finally { clearTimeout(timer); }
        }));
    });
});
