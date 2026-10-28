'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const LocalKnowledge = require('../src/services/knowledge-local.service');
const RAG = require('../src/services/rag.service');

async function document(businessId, title, text) {
    const id = DB.addKnowledgeBaseFile(businessId, `${title}.txt`, title,
        `test-hash-${businessId}-${title}`, 'text/plain', text.length, 1);
    await DB.addKnowledgeBaseChunks(id, [{ text, section: 'Правила' }]);
    return id;
}

describe('Tenant-scoped local knowledge extraction', () => {
    it('answers a matching document question promptly from the current tenant and cites that document', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'A'),(2,'B')");
        const own = await document(1, 'Условия', 'Заезд с 14:00. Выезд до 12:00.');
        await document(2, 'Чужой документ', 'Заезд с 09:00.');
        assert.strictEqual(LocalKnowledge.hasIndexedContent(1), true);
        assert.strictEqual(LocalKnowledge.hasIndexedContent(2), true);
        const result = await LocalKnowledge.lookup(1, 'Во сколько заезд?');
        assert.ok(result);
        assert.match(result.answer, /14:00/);
        assert.ok(!result.answer.includes('09:00'));
        assert.deepStrictEqual(result.citations, [{ source_id: own, title: 'Условия' }]);
        assert.strictEqual(result.provenance, 'local_knowledge_extract');
        assert.ok(Number.isFinite(Date.parse(result.source_timestamp)));
    });

    it('refuses unrelated questions and stale document versions instead of presenting a lexical hit as an answer', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'A'),(2,'B')");
        const old = await document(1, 'Правила', 'Заезд с 14:00.');
        assert.strictEqual(await LocalKnowledge.lookup(1, 'Сколько стоит трансфер?'), null);
        DB.run('UPDATE knowledge_base SET isCurrent=0 WHERE id=?', [old]);
        assert.strictEqual(LocalKnowledge.hasIndexedContent(1), false);
        assert.strictEqual(await LocalKnowledge.lookup(1, 'Во сколько заезд?'), null);
        assert.strictEqual(await LocalKnowledge.lookup(2, 'Во сколько заезд?'), null);
    });

    it('recovers a cited tenant-owned answer when the full-text index has no entries', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'A'),(2,'B')");
        const own = await document(1, 'Заезд', 'Заезд начинается в 15:00.');
        await document(2, 'Чужой документ', 'Заезд начинается в 09:00.');
        DB.run('DELETE FROM kb_chunks_fts');
        const result = await LocalKnowledge.lookup(1, 'Во сколько заезд?');
        assert.match(result.answer, /15:00/);
        assert.ok(!result.answer.includes('09:00'));
        assert.deepStrictEqual(result.citations, [{ source_id: own, title: 'Заезд' }]);
    });

    it('finds an older answer after 256 unrelated chunks when FTS misses', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'A')");
        const own = DB.addKnowledgeBaseFile(1, 'rules.txt', 'Большие правила',
            'local-after-256', 'text/plain', 3000, 1);
        await DB.addKnowledgeBaseChunks(own, [
            ...Array.from({ length: 300 }, (_, index) => `Описание услуги номер ${index}.`),
            'Заезд начинается в 15:00.',
        ]);
        DB.run('DELETE FROM kb_chunks_fts');
        assert.strictEqual(LocalKnowledge.canConcludeNoMatch(1), false);
        const result = await LocalKnowledge.lookup(1, 'Во сколько заезд?');
        assert.match(result.answer, /15:00/);
        assert.deepStrictEqual(result.citations, [{ source_id: own, title: 'Большие правила' }]);
    });

    it('does not claim a complete local no-match beyond the bounded scan', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'A')");
        const own = DB.addKnowledgeBaseFile(1, 'rules.txt', 'Большие правила',
            'local-over-limit', 'text/plain', 6000, 1);
        await DB.addKnowledgeBaseChunks(own,
            Array.from({ length: 513 }, (_, index) => `Описание услуги номер ${index}.`));
        assert.strictEqual(LocalKnowledge.hasIndexedContent(1), true);
        assert.strictEqual(LocalKnowledge.canConcludeNoMatch(1), false);
    });

    it('never concludes semantic absence from a complete lexical scan', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'A')");
        await document(1, 'Правила', 'Выезд до 12:00. Для резервирования позвоните администратору.');
        assert.strictEqual(await LocalKnowledge.lookup(1, 'К какому часу следует освободить апартаменты?'), null);
        assert.strictEqual(LocalKnowledge.canConcludeNoMatch(1), false);
    });

    it('revalidates the exact tenant chunk after retrieval when its text changed', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (1,'A')");
        await document(1, 'Правила', 'Выезд до 12:00.');
        const original = RAG.searchKeyword;
        RAG.searchKeyword = async (...args) => {
            const results = await original.apply(RAG, args);
            DB.run("UPDATE kb_chunks SET text='Выезд до 11:00.'");
            return results;
        };
        try { assert.strictEqual(await LocalKnowledge.lookup(1, 'Во сколько выезд?'), null); }
        finally { RAG.searchKeyword = original; }
    });

    it('treats missing legacy local tables as no local content', async () => {
        createTestDB();
        DB.db.exec('DROP TABLE kb_chunks');
        assert.strictEqual(LocalKnowledge.hasIndexedContent(1), false);
        assert.strictEqual(await LocalKnowledge.lookup(1, 'Во сколько заезд?'), null);
    });
});
