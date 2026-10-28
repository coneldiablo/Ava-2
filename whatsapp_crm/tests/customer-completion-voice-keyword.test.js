'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const RAG = require('../src/services/rag.service');
const config = require('../src/config');
const axios = require('axios');

async function document(businessId, title, text, current = 1) {
    const id = DB.addKnowledgeBaseFile(businessId, title + '.txt', title,
        'voice-fast-' + businessId + '-' + title, 'text/plain', text.length, 1);
    await DB.addKnowledgeBaseChunks(id, [{ text, section: 'Регламент' }]);
    if (!current) DB.run('UPDATE knowledge_base SET isCurrent=0 WHERE id=?', [id]);
    return DB.get(`SELECT c.id,c.kbId,c.text,c.section,k.originalName FROM kb_chunks c
        JOIN knowledge_base k ON k.id=c.kbId WHERE k.id=?`, [id]);
}

async function fixture(run) {
    if (DB.db?.open) DB.db.close();
    createTestDB();
    DB.run("INSERT INTO instances(id,name) VALUES(1,'Own'),(2,'Foreign')");
    const own = await document(1, 'Правила', 'Заезд с 14:00. Выезд до 12:00.');
    const saved = { vector: RAG.searchVector, keyword: RAG.searchKeyword, pipeline: RAG.runSearchPipeline,
        post: axios.post, clientPost: RAG.apiClient.post, threshold: config.rag.minConfidence,
        rerank: config.cohere.rerankingEnabled };
    const ctx = { own, vectorCalls: 0, keywordCalls: 0, pipelineTypes: [], vectorResults: [], afterKeyword: null, providerCalls: 0 };
    config.rag.minConfidence = 0.3; config.cohere.rerankingEnabled = false;
    const deny = () => { ctx.providerCalls++; throw new Error('LIVE_PROVIDER_FORBIDDEN'); };
    axios.post = deny; RAG.apiClient.post = deny;
    RAG.searchVector = async () => { ctx.vectorCalls++; return ctx.vectorResults; };
    RAG.searchKeyword = async (...args) => {
        ctx.keywordCalls++;
        if (ctx.failKeywordOnce) { ctx.failKeywordOnce = false; throw new Error('KEYWORD_FIXTURE_UNAVAILABLE'); }
        const results = await saved.keyword.apply(RAG, args);
        if (ctx.afterKeyword) await ctx.afterKeyword(results, ctx.keywordCalls);
        return results;
    };
    RAG.runSearchPipeline = async (...args) => { ctx.pipelineTypes.push(args[2].searchType); return saved.pipeline.apply(RAG, args); };
    try { await run(ctx); assert.strictEqual(ctx.providerCalls, 0); }
    finally {
        RAG.searchVector = saved.vector; RAG.searchKeyword = saved.keyword; RAG.runSearchPipeline = saved.pipeline;
        axios.post = saved.post; RAG.apiClient.post = saved.clientPost;
        config.rag.minConfidence = saved.threshold; config.cohere.rerankingEnabled = saved.rerank;
        if (DB.db?.open) DB.db.close();
    }
}
const ask = options => RAG.answerFromKnowledge(1, 'Во сколько заезд?', { channel: 'voice', ...options });
const logs = () => DB.all('SELECT searchType,resultsCount,wasUsedByAI FROM rag_search_log ORDER BY id');

describe('Voice keyword-first retrieval without changing the RAG answer contract', () => {
    it('answers exact keyword facts without vector, keeps citation tail and logs one accepted search', async () => {
        for (const options of [{}, { searchType: 'hybrid' }]) await fixture(async ctx => {
            const result = await ask(options);
            assert.strictEqual(ctx.vectorCalls, 0);
            assert.deepStrictEqual(ctx.pipelineTypes, ['keyword']);
            assert.strictEqual(result.answer, 'Заезд с 14:00.');
            assert.strictEqual(result.spoken, result.answer);
            assert.strictEqual(result.confidence, 1);
            assert.deepStrictEqual(result.citations, [{ document_id: String(ctx.own.kbId), chunk_id: String(ctx.own.id),
                score: 1, title: 'Правила', section: 'Регламент' }]);
            assert.deepStrictEqual(result.missing_info, []);
            for (const flag of ['should_handoff', 'requires_manager', 'manager_task_created']) assert.strictEqual(result[flag], false);
            assert.ok(Number.isFinite(result.response_time_ms));
            assert.deepStrictEqual(logs(), [{ searchType: 'keyword', resultsCount: 1, wasUsedByAI: 1 }]);
        });
    });

    it('keeps the old hybrid fallback after a real keyword miss and respects the same confidence threshold', async () => fixture(async ctx => {
        DB.run('DELETE FROM kb_chunks_fts');
        ctx.vectorResults = [{ ...ctx.own, score: 0.9 }];
        const result = await ask();
        assert.strictEqual(ctx.vectorCalls, 1);
        assert.ok(ctx.keywordCalls >= 2);
        assert.deepStrictEqual(ctx.pipelineTypes, ['hybrid']);
        assert.match(result.answer, /14:00/);
        assert.strictEqual(logs().length, 1);
        assert.strictEqual(logs()[0].searchType, 'hybrid');
        DB.run('DELETE FROM rag_search_log'); config.rag.minConfidence = 1.1;
        const rejected = await ask();
        assert.deepStrictEqual(rejected.citations, []);
        assert.deepStrictEqual(rejected.missing_info, ['Во сколько заезд?']);
        assert.deepStrictEqual(logs(), [{ searchType: 'hybrid', resultsCount: 0, wasUsedByAI: 0 }]);
    }));

    it('does not accept a keyword hit without an informative anchor or log the raw probe as an AI answer', async () => fixture(async ctx => {
        await document(1, 'Описание', 'Отель расположен рядом с рекой.');
        const result = await RAG.answerFromKnowledge(1, 'Какой отель?', { channel: 'voice' });
        assert.ok(ctx.keywordCalls >= 2);
        assert.strictEqual(ctx.vectorCalls, 1);
        assert.deepStrictEqual(ctx.pipelineTypes, ['hybrid']);
        assert.deepStrictEqual(result.citations, []);
        assert.deepStrictEqual(result.missing_info, ['Какой отель?']);
        assert.strictEqual(logs().length, 1);
    }));

    it('selects only this tenant current documents and never returns foreign or obsolete matches', async () => fixture(async ctx => {
        await document(2, 'Чужие правила', 'Заезд с 09:00. Заезд без ограничений.');
        await document(1, 'Прошлая версия', 'Заезд с 10:00. Заезд без ограничений.', 0);
        const result = await ask();
        assert.strictEqual(ctx.vectorCalls, 0);
        assert.deepStrictEqual(result.citations.map(ref => ref.document_id), [String(ctx.own.kbId)]);
        assert.ok(!/09:00|10:00/.test(result.answer));
        DB.run('UPDATE knowledge_base SET isCurrent=0 WHERE id=?', [ctx.own.kbId]);
        const unavailable = await ask();
        assert.deepStrictEqual(unavailable.citations, []);
        assert.deepStrictEqual(unavailable.missing_info, ['Во сколько заезд?']);
        assert.strictEqual(ctx.vectorCalls, 1);
    }));

    it('leaves WhatsApp, no-channel and explicit keyword/vector/other search profiles unchanged', async () => {
        for (const options of [{ channel: 'whatsapp' }, { channel: undefined },
            { searchType: 'keyword' }, { searchType: 'vector' }, { searchType: 'legacy-custom' }]) await fixture(async ctx => {
            ctx.vectorResults = [{ ...ctx.own, score: 0.9 }];
            await ask(options);
            const type = options.searchType || 'hybrid';
            assert.deepStrictEqual(ctx.pipelineTypes, [type]);
            assert.strictEqual(ctx.vectorCalls, type === 'keyword' ? 0 : 1);
            assert.strictEqual(ctx.keywordCalls, type === 'vector' ? 0 : 1);
            assert.strictEqual(logs().length, 1);
        });
    });

    it('falls back on optional probe errors or a vanished second keyword result instead of serving a stale fact', async () => {
        await fixture(async ctx => {
            ctx.failKeywordOnce = true;
            const result = await ask();
            assert.match(result.answer, /14:00/);
            assert.strictEqual(ctx.vectorCalls, 1);
            assert.deepStrictEqual(ctx.pipelineTypes, ['hybrid']);
            assert.strictEqual(logs().length, 1);
        });
        await fixture(async ctx => {
            ctx.afterKeyword = (_rows, count) => { if (count === 1) DB.run('UPDATE knowledge_base SET isCurrent=0 WHERE id=?', [ctx.own.kbId]); };
            const result = await ask();
            assert.strictEqual(ctx.vectorCalls, 1);
            assert.deepStrictEqual(ctx.pipelineTypes, ['keyword', 'hybrid']);
            assert.deepStrictEqual(result.citations, []);
            assert.deepStrictEqual(result.missing_info, ['Во сколько заезд?']);
            // These are two actual pipelines after the source-change race;
            // the unlogged preliminary read is never counted as an answer.
            assert.deepStrictEqual(logs(), [
                { searchType: 'keyword', resultsCount: 0, wasUsedByAI: 0 },
                { searchType: 'hybrid', resultsCount: 0, wasUsedByAI: 0 },
            ]);
        });
        await fixture(async ctx => {
            // Keep a deliberately lagging FTS entry, but change the joined
            // current text so a second keyword hit has no answer-topic anchor.
            ctx.afterKeyword = (_rows, count) => {
                if (count === 1) DB.run("UPDATE kb_chunks SET text='Питание по будням.' WHERE id=?", [ctx.own.id]);
            };
            const result = await ask();
            assert.strictEqual(ctx.vectorCalls, 1);
            assert.deepStrictEqual(ctx.pipelineTypes, ['keyword', 'hybrid']);
            assert.deepStrictEqual(result.citations, []);
            assert.deepStrictEqual(result.missing_info, ['Во сколько заезд?']);
        });
    });
});
