'use strict';

// Phase 2 is opt-in because the coordinator owns integrated acceptance execution.
if (process.env.AVA_ACCEPTANCE_PHASE2 === '1') {
    const crypto = require('crypto');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const {describe, it, assert, createTestDB} = require('./test-helper');
    const Database = require('better-sqlite3');
    const DB = require('../src/services/database.service');
    const Identity = require('../src/services/identity/identity-store');
    const Review = require('../src/services/ava-knowledge-review.service');
    const Flags = require('../src/services/ava-improvements-flags.service');
    const LocalKnowledge = require('../src/services/knowledge-local.service');

    const previousEnv = {};
    for (const name of ['AVA_ACCEPTANCE_PHASE2', 'AVA_IMPROVEMENTS_BUSINESSES', 'AVA_WORKSPACE_BUSINESSES']) {
        previousEnv[name] = process.env[name];
    }

    function hash(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
    function expectCode(fn, code) { assert.throws(fn, error => error.code === code); }
    async function expectRejected(promise, codes) {
        await assert.rejects(promise, error => codes.includes(error.code));
    }

    function setup() {
        createTestDB();
        Identity.ensureSchema();
        DB.createSalesWorkspaceTables();
        process.env.AVA_IMPROVEMENTS_BUSINESSES = '1';
        process.env.AVA_WORKSPACE_BUSINESSES = '1';
        DB.run("INSERT INTO instances(id,name,isActive) VALUES (1,'Acceptance One',1),(2,'Acceptance Two',1)");
        for (const [id, role, businessId] of [
            ['owner', 'hotel_owner', 1], ['lead', 'sales_lead', 1],
            ['manager', 'manager', 1], ['foreign', 'manager', 2],
        ]) {
            DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)', [id, `${id}@acceptance.invalid`, id]);
            DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [id, businessId, role]);
        }
        DB.run(`INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId)
            VALUES (1,'guest','Guest','manager'),(2,'foreign-guest','Foreign guest','foreign')`);
        Flags.ensureSchema();
        Review.ensureSchema();
        return Object.fromEntries(['owner', 'lead', 'manager', 'foreign'].map(id => [id, Identity.actor(id)]));
    }

    async function withHarness(fn) {
        const oldDb = DB.db;
        const actors = setup();
        try {
            assert.strictEqual(Flags.snapshot(1).flags.knowledgeReview, true, 'real rollout flags must enable this fixture');
            await fn(actors);
        } finally {
            if (DB.db?.open) DB.db.close();
            DB.db = oldDb;
            for (const [name, value] of Object.entries(previousEnv)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    }

    function addMessage(chatId = 'guest', businessId = 1, content = 'Клиент спрашивает об условиях доставки.') {
        return String(DB.run(`INSERT INTO messages(instanceId,chatId,senderName,role,content,channel)
            VALUES(?,?,?,'user',?,'whatsapp')`, [businessId, chatId, 'Customer', content]).lastInsertRowid);
    }

    async function addAuthority(text = 'Доставка доступна по предварительному согласованию.') {
        const documentId = DB.addKnowledgeBaseFile(1, 'acceptance-authority.txt', 'Правила доставки', hash(text), 'text/plain', Buffer.byteLength(text), 1);
        await DB.addKnowledgeBaseChunks(documentId, [{text, section: 'Доставка'}]);
        const chunk = DB.getDocumentChunks(1, documentId)[0];
        return {...chunk, documentId};
    }

    function source(id, chatId = 'guest') { return {type: 'message', id, chatId}; }
    function options(ai, extra = {}) { return {ai: {generatePlainText: ai}, ...extra}; }
    function answer(text) { return JSON.stringify({answer: text}); }
    function supported(chunk) {
        return JSON.stringify({passed: true, reason: 'Подтверждено независимым документом.', citations: [
            {documentId: chunk.documentId, chunkId: chunk.id, quote: chunk.text},
        ]});
    }
    function manualRequired(reason = 'Новые сведения требуют подтверждения руководителя.') {
        return JSON.stringify({passed: false, manualRequired: true, reason, citations: []});
    }
    function currentAttestation(draft) {
        assert.strictEqual(draft.check.status, 'manual_required');
        assert.strictEqual(draft.check.passed, false);
        assert.strictEqual(draft.check.needsConfirmation, true);
        return {confirm: true, revision: draft.check.revision,
            contentHash: draft.check.contentHash, sourceHash: draft.check.sourceHash};
    }
    async function createDraft(actor, sourceId, generatedAnswer = 'Доставка обсуждается с менеджером.', aiOptions) {
        return Review.createDraft(actor, 1,
            {question: 'Какие условия доставки?', source: source(sourceId)},
            aiOptions || options(async () => answer(generatedAnswer)));
    }
    async function checkWith(actor, draft, ai) {
        return Review.checkDraft(actor, 1, draft.id, {revision: draft.revision}, options(ai));
    }
    async function publish(actor, draft, extra = {}) {
        return Review.publishDraft(actor, 1, draft.id,
            {revision: draft.revision, confirm: true, ...extra}, options(async () => ''));
    }

    describe('AVA phase 2 knowledge review acceptance', () => {
        it('invalidates a checked version after editing and enforces owner/lead publication authority', async () => withHarness(async actors => {
            const chunk = await addAuthority();
            const sourceId = addMessage();
            const created = await createDraft(actors.manager, sourceId);
            const checked = (await checkWith(actors.lead, created.draft,
                async () => supported(chunk))).draft;
            assert.strictEqual(checked.check.status, 'passed');
            assert.strictEqual(checked.check.passed, true);

            const edited = Review.updateDraft(actors.manager, 1, checked.id,
                {revision: checked.revision, answer: 'Доставка доступна только после проверки адреса.'},
                options(async () => '')).draft;
            assert.strictEqual(edited.check, null);
            assert.strictEqual(edited.approval, null);
            await expectRejected(publish(actors.owner, edited), ['KNOWLEDGE_REVIEW_CHECK_REQUIRED']);

            const rechecked = (await checkWith(actors.owner, edited,
                async () => supported(chunk))).draft;
            await expectRejected(publish(actors.manager, rechecked), ['CAPABILITY_DENIED']);
            const approved = (await publish(actors.lead, rechecked)).draft;
            assert.strictEqual(approved.approval.type, 'ai_grounded');
            assert.strictEqual(approved.approval.userId, 'lead');
        }));

        it('allows manual publication only after an explicit attestation bound to current check hashes', async () => withHarness(async actors => {
            const sourceId = addMessage('guest', 1, 'Клиент сообщил новый ориентир по срокам.');
            const created = await createDraft(actors.owner, sourceId, 'Ориентир по срокам — два дня.');
            const checked = (await checkWith(actors.lead, created.draft,
                async () => manualRequired())).draft;
            const attestation = currentAttestation(checked);
            assert.ok(attestation.contentHash);
            assert.ok(attestation.sourceHash);
            await expectRejected(publish(actors.owner, checked), ['KNOWLEDGE_REVIEW_ATTESTATION_REQUIRED']);

            const published = (await publish(actors.owner, checked, {attestation})).draft;
            assert.strictEqual(published.approval.type, 'human_confirmed');
            assert.strictEqual(published.approval.userId, 'owner');
            assert.strictEqual(published.approval.revision, checked.check.revision);
            assert.strictEqual(published.check.passed, false);
            assert.strictEqual(published.check.status, 'manual_required');
        }));

        it('never accepts manual publication after a failed verdict or provider timeout', async () => withHarness(async actors => {
            const sourceId = addMessage();
            const created = await createDraft(actors.owner, sourceId);
            const invalid = (await checkWith(actors.lead, created.draft,
                async () => JSON.stringify({passed: 'yes', reason: 'malformed', citations: []}))).draft;
            assert.strictEqual(invalid.check.passed, false);
            assert.ok(['failed', 'unavailable'].includes(invalid.check.status));
            await expectRejected(publish(actors.owner, invalid, {attestation: {
                confirm: true, revision: invalid.check.revision,
                contentHash: invalid.check.contentHash, sourceHash: invalid.check.sourceHash,
            }}), ['KNOWLEDGE_REVIEW_CHECK_REQUIRED']);

            const timeout = (await Review.checkDraft(actors.lead, 1, created.draft.id,
                {revision: invalid.revision}, {timeoutMs: 5, ai: {generatePlainText: () => new Promise(() => {})}})).draft;
            assert.strictEqual(timeout.check.status, 'timeout');
            assert.strictEqual(timeout.check.passed, false);
            await expectRejected(publish(actors.owner, timeout, {attestation: {
                confirm: true, revision: timeout.check.revision,
                contentHash: timeout.check.contentHash, sourceHash: timeout.check.sourceHash,
            }}), ['KNOWLEDGE_REVIEW_CHECK_REQUIRED']);
        }));

        it('rejects cross-tenant source IDs and stale source or corpus hashes at publication', async () => withHarness(async actors => {
            const foreignMessageId = addMessage('foreign-guest', 2, 'Секрет другого бизнеса.');
            await expectRejected(createDraft(actors.manager, foreignMessageId),
                ['KNOWLEDGE_REVIEW_SOURCE_INVALID', 'SALES_CLIENT_SCOPE_DENIED']);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_knowledge_review_drafts').n, 0);

            const sourceId = addMessage();
            const created = await createDraft(actors.owner, sourceId);
            const checked = (await checkWith(actors.lead, created.draft,
                async () => manualRequired())).draft;
            const attestation = currentAttestation(checked);
            DB.run('UPDATE messages SET content=? WHERE id=?', ['Источник отредактирован после проверки.', Number(sourceId)]);
            await expectRejected(publish(actors.owner, checked, {attestation}), ['KNOWLEDGE_REVIEW_SOURCE_CHANGED']);

            DB.run('UPDATE messages SET content=? WHERE id=?', ['Клиент спрашивает об условиях доставки.', Number(sourceId)]);
            const refreshed = (await checkWith(actors.lead, checked,
                async () => manualRequired())).draft;
            const refreshedAttestation = currentAttestation(refreshed);
            const independent = await addAuthority('Независимое правило доставки: срок согласуется отдельно.');
            DB.run('UPDATE kb_chunks SET text=?,searchText=? WHERE id=?',
                ['Изменённая редакция независимого правила доставки.', 'измененная редакция независимого правила доставки', independent.id]);
            await expectRejected(publish(actors.owner, refreshed, {attestation: refreshedAttestation}),
                ['KNOWLEDGE_REVIEW_KNOWLEDGE_CHANGED']);
        }));

        it('restores the prior publication in current chunks and history after reopening SQLite', async () => withHarness(async actors => {
            const sourceId = addMessage();
            const firstAnswer = 'Доставка по городу занимает один день.';
            const secondAnswer = 'Доставка по городу занимает два дня.';
            let draft = (await createDraft(actors.owner, sourceId, firstAnswer)).draft;
            draft = (await checkWith(actors.lead, draft, async () => manualRequired())).draft;
            draft = (await publish(actors.owner, draft, {attestation: currentAttestation(draft)})).draft;
            const firstPublishedVersion = draft.history.find(version => version.kind === 'published');
            const documentId = draft.currentDocumentId;

            draft = Review.updateDraft(actors.owner, 1, draft.id,
                {revision: draft.revision, answer: secondAnswer}, options(async () => '')).draft;
            draft = (await checkWith(actors.lead, draft, async () => manualRequired())).draft;
            draft = (await publish(actors.lead, draft, {attestation: currentAttestation(draft)})).draft;
            assert.strictEqual(draft.currentDocumentId, documentId);
            assert.ok(DB.getDocumentChunks(1, documentId)[0].text.includes(secondAnswer));

            draft = (await Review.rollbackDraft(actors.owner, 1, draft.id,
                {revision: draft.revision, confirm: true}, options(async () => ''))).draft;
            assert.strictEqual(draft.answer, firstAnswer);
            assert.strictEqual(draft.currentDocumentId, documentId);
            assert.strictEqual(draft.history[0].kind, 'rollback');
            assert.strictEqual(draft.history[0].restoredVersionId, firstPublishedVersion.id);
            assert.ok(DB.getDocumentChunks(1, documentId)[0].text.includes(firstAnswer));
            assert.ok(DB.get('SELECT 1 FROM ava_knowledge_review_versions WHERE id=?', [firstPublishedVersion.id]));

            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-phase2-knowledge-'));
            const file = path.join(dir, 'acceptance.sqlite');
            try {
                await DB.db.backup(file);
                DB.db.close();
                DB.db = new Database(file);
                DB.db.pragma('foreign_keys = ON');
                const reopenedChunks = DB.getDocumentChunks(1, documentId);
                assert.strictEqual(reopenedChunks.length, 1);
                assert.ok(reopenedChunks[0].text.includes(firstAnswer));
                assert.ok(!reopenedChunks[0].text.includes(secondAnswer));
                const persisted = Review.list(actors.owner, 1, {}, {})
                    .drafts.find(item => item.id === draft.id);
                assert.strictEqual(persisted.answer, firstAnswer);
                assert.ok(persisted.history.some(version => version.id === firstPublishedVersion.id));
                assert.strictEqual(persisted.history[0].kind, 'rollback');
                const retrieved = await LocalKnowledge.lookup(1, 'Сколько занимает доставка по городу?');
                assert.ok(retrieved && retrieved.answer.includes(firstAnswer));
            } finally {
                if (DB.db?.open) DB.db.close();
                fs.rmSync(dir, {recursive: true, force: true});
            }
        }));
    });
} else {
    module.exports = {};
}
