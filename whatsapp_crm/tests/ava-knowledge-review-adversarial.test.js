'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Review = require('../src/services/ava-knowledge-review.service');

const flags = { assertEnabled(businessId, feature) {
    assert.strictEqual(businessId, 1);
    assert.strictEqual(feature, 'knowledgeReview');
} };

function setup() {
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES(1,'Synthetic'),(2,'Foreign')");
    for (const [id, role, businessId] of [
        ['owner', 'hotel_owner', 1], ['lead', 'sales_lead', 1],
        ['manager', 'manager', 1], ['other', 'manager', 1],
        ['observer', 'observer', 1], ['foreign', 'manager', 2],
    ]) {
        DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)', [id, `${id}@test.example`, id]);
        DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [id, businessId, role]);
    }
    DB.run(`INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId)
        VALUES(1,'guest','Guest','manager'),(1,'other-client','Other','other'),(2,'foreign-client','Foreign','foreign')`);
    Review.ensureSchema();
    return Object.fromEntries(['owner', 'lead', 'manager', 'other', 'observer', 'foreign']
        .map(id => [id, Identity.actor(id)]));
}

function options(generatePlainText, extra = {}) {
    return { flags, ai: { generatePlainText }, ...extra };
}

function source(chatId = 'guest', type = 'message', id = '1') { return { chatId, type, id }; }

function addMessage(chatId = 'guest', businessId = 1, content = 'Сколько стоит доставка?') {
    return String(DB.run(`INSERT INTO messages(instanceId,chatId,senderName,role,content,channel)
        VALUES(?,?,?,'user',?,'whatsapp')`, [businessId, chatId, 'Customer', content]).lastInsertRowid);
}

async function addAuthority(text = 'Доставка стоит 500 рублей.') {
    const digest = require('crypto').createHash('sha256').update(text).digest('hex');
    const documentId = DB.addKnowledgeBaseFile(1, 'authority.txt', 'Правила доставки', digest, 'text/plain', Buffer.byteLength(text), 1);
    await DB.addKnowledgeBaseChunks(documentId, [{ text, section: 'Доставка' }]);
    return { ...DB.getDocumentChunks(1, documentId)[0], documentId };
}

function passingCheck(chunk) {
    return JSON.stringify({ passed: true, reason: 'Подтверждено источником.', citations: [
        { documentId: chunk.documentId, chunkId: chunk.id, quote: chunk.text },
    ] });
}

function manualCheck() {
    return JSON.stringify({ passed: false, manualRequired: true,
        reason: 'Требуется подтверждение руководителя.', citations: [] });
}

function contentHash(question, answer) {
    return require('crypto').createHash('sha256').update(JSON.stringify({ answer, question })).digest('hex');
}

function attestation(draft) {
    return { confirm: true, revision: draft.check.revision,
        contentHash: draft.check.contentHash, sourceHash: draft.check.sourceHash };
}

describe('Knowledge review adversarial persistence and authorization', () => {
    it('rejects a source from another client, another business, or an inconsistent call transcript owner', async () => {
        const actors = setup();
        const guestMessage = addMessage('guest', 1);
        const foreignMessage = addMessage('foreign-client', 2, 'Private foreign question');
        await assert.rejects(Review.createDraft(actors.manager, 1, {
            question: 'Доставка?', source: source('guest', 'message', foreignMessage),
        }, options(async () => JSON.stringify({ answer: 'No.' }))),
        error => ['KNOWLEDGE_REVIEW_SOURCE_INVALID', 'SALES_CLIENT_SCOPE_DENIED'].includes(error.code));

        await assert.rejects(Review.createDraft(actors.manager, 1, {
            question: 'Доставка?', source: source('other-client', 'message', guestMessage),
        }, options(async () => JSON.stringify({ answer: 'No.' }))),
        error => ['KNOWLEDGE_REVIEW_SOURCE_INVALID', 'SALES_CLIENT_SCOPE_DENIED'].includes(error.code));

        DB.createConversationEvent({ instanceId: 1, chatId: 'guest', eventId: 'call-owned-by-guest', callId: 'call-1', channel: 'voice', content: null });
        DB.run(`INSERT INTO ava_call_transcript_sources(businessId,chatId,sourceId,text,sourceHash,timestamp)
            VALUES(1,'other-client','call-owned-by-guest','Private other-client transcript','fixture-hash',CURRENT_TIMESTAMP)`);
        await assert.rejects(Review.createDraft(actors.manager, 1, {
            question: 'Что обсудили?', source: source('guest', 'call', 'call-owned-by-guest'),
        }, options(async () => JSON.stringify({ answer: 'No.' }))),
        error => error.code === 'KNOWLEDGE_REVIEW_SOURCE_INVALID');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_knowledge_review_drafts').n, 0);
    });

    it('rejects source and assignment changes that occur while draft generation is in flight', async () => {
        const actors = setup();
        const messageId = addMessage();
        const ai = async () => {
            DB.run('UPDATE messages SET content=? WHERE id=?', ['Edited while AI was running', Number(messageId)]);
            return JSON.stringify({ answer: 'Unsupported stale answer.' });
        };
        await assert.rejects(Review.createDraft(actors.manager, 1, {
            question: 'Доставка?', source: source('guest', 'message', messageId),
        }, options(ai)), error => error.code === 'KNOWLEDGE_REVIEW_SOURCE_CHANGED');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_knowledge_review_drafts').n, 0);

        const currentMessage = addMessage('guest', 1, 'А когда доставка?');
        const reassignedAi = async () => {
            DB.run("UPDATE clients SET assigneeUserId='other' WHERE instanceId=1 AND chatId='guest'");
            return JSON.stringify({ answer: 'Ответ.' });
        };
        await assert.rejects(Review.createDraft(actors.manager, 1, {
            question: 'Срок доставки?', source: source('guest', 'message', currentMessage),
        }, options(reassignedAi)), error => error.code === 'SALES_CLIENT_SCOPE_DENIED');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_knowledge_review_drafts').n, 0);
    });

    it('cancels an in-flight provider request and persists no draft', async () => {
        const actors = setup();
        const messageId = addMessage();
        const controller = new AbortController();
        let entered;
        const started = new Promise(resolve => { entered = resolve; });
        const ai = (_messages, _config, providerOptions) => {
            entered();
            return new Promise((_, reject) => providerOptions.signal.addEventListener('abort', () => {
                reject(Object.assign(new Error('cancelled'), { code: 'AI_CANCELED' }));
            }, { once: true }));
        };
        const pending = Review.createDraft(actors.manager, 1, {
            question: 'Доставка?', source: source('guest', 'message', messageId),
        }, options(ai, { signal: controller.signal }));
        await started;
        controller.abort();
        await assert.rejects(pending, error => error.code === 'KNOWLEDGE_REVIEW_CANCELLED');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_knowledge_review_drafts').n, 0);
        assert.strictEqual(DB.get("SELECT status FROM ava_knowledge_review_operations").status, 'failed');
    });

    it('does not persist a passing check when authoritative chunks change during AI', async () => {
        const actors = setup();
        const chunk = await addAuthority();
        const messageId = addMessage();
        const draft = await Review.createDraft(actors.manager, 1, {
            question: 'Сколько стоит доставка?', source: source('guest', 'message', messageId),
        }, options(async () => JSON.stringify({ answer: 'Доставка стоит 500 рублей.' })));
        const ai = async () => {
            DB.run('UPDATE kb_chunks SET text=?,searchText=? WHERE id=?', [
                'Доставка теперь стоит 900 рублей.', 'доставка теперь стоит 900 рублей', chunk.id,
            ]);
            return passingCheck(chunk);
        };
        await assert.rejects(Review.checkDraft(actors.lead, 1, draft.draft.id, { revision: draft.draft.revision }, options(ai)),
            error => error.code === 'KNOWLEDGE_REVIEW_KNOWLEDGE_CHANGED');
        const stored = DB.get('SELECT checkJson,status FROM ava_knowledge_review_drafts WHERE id=?', [draft.draft.id]);
        assert.strictEqual(stored.checkJson, null);
        assert.strictEqual(stored.status, 'draft');
    });

    it('serializes concurrent publication so only one revision becomes current', async () => {
        const actors = setup();
        const chunk = await addAuthority();
        const messageId = addMessage();
        const draft = await Review.createDraft(actors.owner, 1, {
            question: 'Сколько стоит доставка?', source: source('guest', 'message', messageId),
        }, options(async () => JSON.stringify({ answer: 'Доставка стоит 500 рублей.' })));
        const checked = await Review.checkDraft(actors.lead, 1, draft.draft.id, { revision: draft.draft.revision },
            options(async () => passingCheck(chunk)));
        assert.strictEqual(checked.draft.check.passed, true, JSON.stringify(checked.draft.check));
        const body = { revision: checked.draft.revision, confirm: true };
        const [first, second] = await Promise.allSettled([
            Promise.resolve().then(() => Review.publishDraft(actors.owner, 1, draft.draft.id, body,
                options(async () => '', { idempotencyKey: 'publish-a' }))),
            Promise.resolve().then(() => Review.publishDraft(actors.owner, 1, draft.draft.id, body,
                options(async () => '', { idempotencyKey: 'publish-b' }))),
        ]);
        assert.strictEqual([first, second].filter(result => result.status === 'fulfilled').length, 1,
            JSON.stringify([first, second].map(result => result.status === 'rejected' ? result.reason.code : 'fulfilled')));
        const rejected = [first, second].find(result => result.status === 'rejected');
        assert.strictEqual(rejected.reason.code, 'KNOWLEDGE_REVIEW_REVISION_CONFLICT');
        assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM ava_knowledge_review_versions WHERE draftId=? AND kind='published'", [draft.draft.id]).n, 1);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM knowledge_base WHERE instanceId=1 AND isCurrent=1').n, 2);
    });

    it('binds manual confirmation to the exact draft and records human approval', async () => {
        const actors = setup();
        const firstSource = addMessage('guest', 1, 'Первый вопрос о доставке.');
        const secondSource = addMessage('guest', 1, 'Второй вопрос о доставке.');
        const create = answer => options(async () => JSON.stringify({ answer }));
        const first = await Review.createDraft(actors.owner, 1, {
            question: 'Первый вопрос?', source: source('guest', 'message', firstSource),
        }, create('Ответ один.'));
        const second = await Review.createDraft(actors.owner, 1, {
            question: 'Второй вопрос?', source: source('guest', 'message', secondSource),
        }, create('Ответ два.'));
        const checkedFirst = await Review.checkDraft(actors.lead, 1, first.draft.id,
            { revision: first.draft.revision }, options(async () => manualCheck()));
        const checkedSecond = await Review.checkDraft(actors.lead, 1, second.draft.id,
            { revision: second.draft.revision }, options(async () => manualCheck()));

        for (const checked of [checkedFirst.draft, checkedSecond.draft]) {
            assert.strictEqual(checked.check.status, 'manual_required');
            assert.strictEqual(checked.check.passed, false);
            assert.strictEqual(checked.check.needsConfirmation, true);
            assert.strictEqual(checked.check.contentHash, contentHash(checked.question, checked.answer));
            assert.ok(checked.check.sourceHash);
            assert.ok(checked.approval === null || checked.approval === undefined);
        }

        await assert.rejects(Promise.resolve().then(() => Review.publishDraft(actors.owner, 1, second.draft.id,
            { revision: checkedSecond.draft.revision, confirm: true, attestation: attestation(checkedFirst.draft) },
            options(async () => '', { idempotencyKey: 'cross-draft-attestation' }))),
        error => error.code === 'KNOWLEDGE_REVIEW_ATTESTATION_INVALID');

        const published = await Review.publishDraft(actors.owner, 1, second.draft.id,
            { revision: checkedSecond.draft.revision, confirm: true, attestation: attestation(checkedSecond.draft) },
            options(async () => '', { idempotencyKey: 'valid-human-attestation' }));
        assert.strictEqual(published.draft.approval.type, 'human_confirmed');
        assert.strictEqual(published.draft.approval.userId, 'owner');
        assert.strictEqual(published.draft.approval.contentHash, contentHash(published.draft.question, published.draft.answer));
        assert.strictEqual(published.draft.history[0].approval.type, 'human_confirmed');
    });

    it('rejects a stale attestation after an edit, source change, or corpus change', async () => {
        const actors = setup();
        const authority = await addAuthority();
        const messageId = addMessage();
        const draft = await Review.createDraft(actors.owner, 1, {
            question: 'Сколько стоит доставка?', source: source('guest', 'message', messageId),
        }, options(async () => JSON.stringify({ answer: 'Цена уточняется.' })));
        const checked = await Review.checkDraft(actors.lead, 1, draft.draft.id,
            { revision: draft.draft.revision }, options(async () => manualCheck()));
        const attest = attestation(checked.draft);

        const edited = await Review.updateDraft(actors.owner, 1, draft.draft.id,
            { revision: checked.draft.revision, answer: 'Уточнённый ответ.' },
            options(async () => '', { idempotencyKey: 'edit-after-manual-check' }));
        await assert.rejects(Promise.resolve().then(() => Review.publishDraft(actors.owner, 1, draft.draft.id,
            { revision: edited.draft.revision, confirm: true, attestation: attest },
            options(async () => '', { idempotencyKey: 'old-attestation-after-edit' }))),
        error => ['KNOWLEDGE_REVIEW_CHECK_REQUIRED', 'KNOWLEDGE_REVIEW_ATTESTATION_INVALID'].includes(error.code));

        const checkedAgain = await Review.checkDraft(actors.lead, 1, draft.draft.id,
            { revision: edited.draft.revision }, options(async () => manualCheck()));
        const currentAttestation = attestation(checkedAgain.draft);
        DB.run('UPDATE messages SET content=? WHERE id=?', ['Источник изменён.', Number(messageId)]);
        await assert.rejects(Promise.resolve().then(() => Review.publishDraft(actors.owner, 1, draft.draft.id,
            { revision: checkedAgain.draft.revision, confirm: true, attestation: currentAttestation },
            options(async () => '', { idempotencyKey: 'source-changed-after-check' }))),
        error => error.code === 'KNOWLEDGE_REVIEW_SOURCE_CHANGED');

        DB.run('UPDATE messages SET content=? WHERE id=?', ['Сколько стоит доставка?', Number(messageId)]);
        const checkedOnceMore = await Review.checkDraft(actors.lead, 1, draft.draft.id,
            { revision: checkedAgain.draft.revision }, options(async () => manualCheck()));
        const lastAttestation = attestation(checkedOnceMore.draft);
        DB.run('UPDATE kb_chunks SET text=?,searchText=? WHERE id=?', [
            'Новая цена доставки 900 рублей.', 'новая цена доставки 900 рублей', authority.id,
        ]);
        await assert.rejects(Promise.resolve().then(() => Review.publishDraft(actors.owner, 1, draft.draft.id,
            { revision: checkedOnceMore.draft.revision, confirm: true, attestation: lastAttestation },
            options(async () => '', { idempotencyKey: 'corpus-changed-after-check' }))),
        error => error.code === 'KNOWLEDGE_REVIEW_KNOWLEDGE_CHANGED');
    });

    it('does not let managers publish manually checked drafts or use manual attestation after AI failure', async () => {
        const actors = setup();
        const authority = await addAuthority();
        const messageId = addMessage();
        const draft = await Review.createDraft(actors.manager, 1, {
            question: 'Сколько стоит доставка?', source: source('guest', 'message', messageId),
        }, options(async () => JSON.stringify({ answer: 'Цена уточняется.' })));
        const checked = await Review.checkDraft(actors.lead, 1, draft.draft.id,
            { revision: draft.draft.revision }, options(async () => manualCheck()));
        const body = { revision: checked.draft.revision, confirm: true, attestation: attestation(checked.draft) };
        await assert.rejects(Promise.resolve().then(() => Review.publishDraft(actors.manager, 1, draft.draft.id, body,
            options(async () => '', { idempotencyKey: 'manager-manual-publish' }))),
        error => error.code === 'CAPABILITY_DENIED');

        const failedCases = [
            { name: 'timeout', run: async () => { throw Object.assign(new Error('timeout'), { code: 'AI_TIMEOUT' }); }, expected: 'timeout' },
            { name: 'provider-error', run: async () => { throw Object.assign(new Error('offline'), { code: 'AI_UNAVAILABLE' }); }, expected: 'unavailable' },
            { name: 'malformed', run: async () => 'not-json', expected: 'unavailable' },
        ];
        for (const failure of failedCases) {
            const nextMessage = addMessage('guest', 1, `Вопрос ${failure.name}?`);
            const nextDraft = await Review.createDraft(actors.owner, 1, {
                question: `Вопрос ${failure.name}?`, source: source('guest', 'message', nextMessage),
            }, options(async () => JSON.stringify({ answer: 'Ответ.' })));
            const failedCheck = await Review.checkDraft(actors.lead, 1, nextDraft.draft.id,
                { revision: nextDraft.draft.revision }, options(failure.run));
            assert.strictEqual(failedCheck.draft.check.status, failure.expected);
            assert.strictEqual(failedCheck.draft.check.passed, false);
            assert.strictEqual(failedCheck.draft.check.needsConfirmation, false);
            assert.strictEqual(failedCheck.draft.approval, null);
            const fabricated = { revision: failedCheck.draft.check.revision,
                contentHash: contentHash(failedCheck.draft.question, failedCheck.draft.answer),
                sourceHash: failedCheck.draft.check.sourceHash };
            await assert.rejects(Promise.resolve().then(() => Review.publishDraft(actors.owner, 1, nextDraft.draft.id,
                { revision: failedCheck.draft.revision, confirm: true, attestation: { confirm: true, ...fabricated } },
                options(async () => '', { idempotencyKey: `failed-ai-${failure.name}` }))),
            error => ['KNOWLEDGE_REVIEW_CHECK_REQUIRED', 'KNOWLEDGE_REVIEW_ATTESTATION_REQUIRED', 'KNOWLEDGE_REVIEW_ATTESTATION_INVALID'].includes(error.code));
        }
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM knowledge_base WHERE instanceId=1').n, 1);
        assert.ok(authority.id);
    });
});
