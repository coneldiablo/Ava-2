'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const { createService, TABLE, DIMENSIONS } = require('../src/services/gemini-embeddings.service');

const unit = axis => Array.from({ length: DIMENSIONS }, (_, index) => index === axis ? 1 : 0);
async function setup() {
    createTestDB(); require('sqlite-vec').load(DB.db);
    DB.run("INSERT INTO instances(id,name,aiProvider,isActive) VALUES(1,'Gemini A','gemini',1),(2,'Gemini B','gemini',1),(3,'Legacy','aitunnel',1)");
    assert.strictEqual(DB.ensureVectorTable(3), true);
    const add = async (businessId, title, text) => {
        const kbId = DB.addKnowledgeBaseFile(businessId, `${title}.txt`, title, `hash-${businessId}-${title}`, 'text/plain', text.length, 1);
        await DB.addKnowledgeBaseChunks(kbId, [{ text, section: 'Услуги' }]);
        return DB.getChunksForKnowledgeBase(kbId)[0];
    };
    const a = await add(1, 'Own', 'Время заезда четырнадцать часов.');
    const b = await add(2, 'Foreign', 'Чужая информация о бизнесе.');
    const legacy = await add(3, 'Legacy', 'Старая подтверждённая информация.');
    assert.strictEqual(DB.addChunkToVectorTable(legacy.id, legacy.kbId, 3, [1, 0, 0], 'Legacy'), true);
    const calls = [];
    const service = createService({ vertex: {
        settings: () => ({ project: 'fixture-project', identity: 'synthetic-identity' }),
        accessToken: async () => 'synthetic-token',
    }, post: async (url, body, options) => {
        calls.push({ url, body, options });
        return { data: { predictions: [{ embeddings: { values: unit(0) } }] } };
    } });
    return { service, a, b, legacy, calls };
}

describe('Independent Gemini knowledge vector isolation', () => {
    it('keeps Gemini vectors separate from the populated legacy space and fences results by business', async () => {
        const { service, a, b, calls } = await setup();
        const legacyBefore = DB.all('SELECT rowid,chunkId,kbId,instanceId,embedding FROM kb_chunks_vec');
        assert.strictEqual(service.store({ ...a, embedding: unit(0) }, 1), true);
        assert.strictEqual(service.store({ ...b, embedding: unit(0) }, 2), true);
        assert.strictEqual(service.store({ ...b, embedding: unit(0) }, 1), false);
        const own = await service.search(1, 'Время заезда', 5);
        assert.strictEqual(own.length, 1); assert.strictEqual(own[0].id, a.id); assert.strictEqual(own[0].text, a.text);
        assert.deepStrictEqual(DB.all('SELECT rowid,chunkId,kbId,instanceId,embedding FROM kb_chunks_vec'), legacyBefore);
        assert.strictEqual(DB.get(`SELECT COUNT(*) AS n FROM ${TABLE}`).n, 2);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(new URL(calls[0].url).hostname, 'us-central1-aiplatform.googleapis.com');
        assert.ok(calls[0].url.endsWith('/gemini-embedding-001:predict'));
        assert.strictEqual(calls[0].body.instances[0].task_type, 'RETRIEVAL_QUERY');
        assert.strictEqual(calls[0].body.parameters.outputDimensionality, DIMENSIONS);
        assert.strictEqual(calls[0].options.proxy, false); assert.strictEqual(calls[0].options.maxRedirects, 0);
    });

    it('rejects stale edited chunks, deletes their Gemini vector and never stores a foreign chunk', async () => {
        const { service, a, b } = await setup();
        assert.strictEqual(service.store({ ...a, embedding: unit(0) }, 1), true);
        DB.run('UPDATE kb_chunks SET text=? WHERE id=?', ['Изменённая подтверждённая информация.', a.id]);
        assert.strictEqual(service.count(1, a.kbId), 0);
        assert.strictEqual(service.store({ ...a, embedding: unit(0) }, 1), false);
        assert.strictEqual(service.store({ ...b, embedding: unit(0) }, 1), false);
        assert.strictEqual(DB.get(`SELECT COUNT(*) AS n FROM ${TABLE}`).n, 0);
    });

    it('does not accept an embedding response after a business switches away from Gemini', async () => {
        const { a } = await setup();
        let release, entered;
        const started = new Promise(resolve => { entered = resolve; });
        const service = createService({ vertex: { settings: () => ({ project: 'fixture-project', identity: 'fixture-rotation' }), accessToken: async () => 'synthetic-token' },
            post: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
        const pending = service.embed(a.text, 1, 'RETRIEVAL_DOCUMENT'); await started;
        DB.run("UPDATE instances SET aiProvider='aitunnel' WHERE id=1");
        release({ data: { predictions: [{ embeddings: { values: unit(0) } }] } });
        await assert.rejects(pending, error => error.code === 'AI_MODEL_SETTINGS_CHANGED');
    });

    it('reports Gemini coverage from its own current vectors rather than the legacy table', async () => {
        const { service, a } = await setup();
        assert.strictEqual(service.store({ ...a, embedding: unit(0) }, 1), true);
        const RAG = require('../src/services/rag.service');
        const stats = await RAG.getStats(1);
        assert.strictEqual(stats.totalChunks, 1);
        assert.strictEqual(stats.chunksWithEmbeddings, 1);
        assert.strictEqual(stats.embeddingsCoverage, 100);
        assert.strictEqual(stats.embeddingDimensions, DIMENSIONS);
        assert.strictEqual(stats.vectorSearchAvailable, true);
    });

    it('rejects malformed or zero embeddings and fences its reusable cache by tenant, credential identity and task', async () => {
        const { a } = await setup();
        let identity = 'first-identity', count = 0, values = unit(0);
        const service = createService({ vertex: { settings: () => ({ project: 'fixture-project', identity }), accessToken: async () => 'synthetic-token' },
            post: async () => { count++; return { data: { predictions: [{ embeddings: { values } }] } }; } });
        for (const malformed of [[1, 0], Array(DIMENSIONS).fill(0), [...unit(0).slice(0, -1), Infinity]]) {
            values = malformed;
            await assert.rejects(service.embed(a.text, 1, 'RETRIEVAL_QUERY'), error => error.code === 'KNOWLEDGE_EMBEDDING_INVALID');
        }
        values = unit(0);
        const first = await service.embed(a.text, 1, 'RETRIEVAL_QUERY'); first[0] = 99;
        assert.strictEqual((await service.embed(a.text, 1, 'RETRIEVAL_QUERY'))[0], 1);
        assert.strictEqual(count, 4);
        await service.embed(a.text, 2, 'RETRIEVAL_QUERY'); assert.strictEqual(count, 5);
        identity = 'rotated-identity';
        await service.embed(a.text, 1, 'RETRIEVAL_QUERY'); assert.strictEqual(count, 6);
        await service.embed(a.text, 1, 'RETRIEVAL_DOCUMENT'); assert.strictEqual(count, 7);
    });

    it('cancels an in-flight embedding and applies a caller deadline without caching unfinished work', async () => {
        const { a } = await setup();
        let entered, calls = 0;
        const started = new Promise(resolve => { entered = resolve; });
        const service = createService({ vertex: { settings: () => ({ project: 'fixture-project', identity: 'cancel-identity' }), accessToken: async () => 'synthetic-token' },
            post: async (_url, _body, { signal }) => {
                calls++; entered();
                return new Promise((_, reject) => {
                    const cancel = () => reject(Object.assign(new Error('synthetic transport cancelled'), { code: 'ERR_CANCELED' }));
                    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
                });
            } });
        const controller = new AbortController();
        const pending = service.embed(a.text, 1, 'RETRIEVAL_QUERY', { signal: controller.signal });
        await started; controller.abort();
        await assert.rejects(pending, error => error.code === 'AI_CANCELED');
        const before = Date.now();
        await assert.rejects(service.embed(a.text, 1, 'RETRIEVAL_QUERY', { deadline: Date.now() + 20 }), error => error.code === 'AI_TIMEOUT');
        assert.ok(Date.now() - before < 500); assert.strictEqual(calls, 2);
    });

    it('updates Gemini document content and indexing stats without changing another business legacy vectors', async () => {
        const { service, a } = await setup();
        const legacyBefore = DB.all('SELECT rowid,chunkId,kbId,instanceId,embedding FROM kb_chunks_vec');
        assert.strictEqual(service.store({ ...a, embedding: unit(0) }, 1), true);
        const Gemini = require('../src/services/gemini-embeddings.service');
        const RAG = require('../src/services/rag.service');
        const generate = Gemini.generate;
        Gemini.generate = service.generate;
        try {
            const updated = await RAG.updateChunk(1, a.id, 'Заезд начинается после обеда, уточните точное время.', 'Обновлённые услуги');
            assert.strictEqual(updated.success, true);
            assert.strictEqual(service.count(1, a.kbId), 1);
            assert.deepStrictEqual(DB.all('SELECT rowid,chunkId,kbId,instanceId,embedding FROM kb_chunks_vec'), legacyBefore);
            const stats = await RAG.getStats(1);
            assert.strictEqual(stats.chunksWithEmbeddings, 1); assert.strictEqual(stats.embeddingsCoverage, 100);
            assert.strictEqual(DB.get('SELECT hasEmbeddings FROM knowledge_base WHERE id=?', [a.kbId]).hasEmbeddings, 1);
        } finally { Gemini.generate = generate; }
    });
});
