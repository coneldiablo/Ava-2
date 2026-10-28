'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Readable } = require('node:stream');
const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Preview = require('../src/services/knowledge-preview-ai.service');
const config = require('../src/config');

const auth = { userId: 'preview-owner' };
const quote = 'Заселение возможно с 14:00. Ранний заезд согласуется отдельно.';
function document(businessId, content = quote, { current = 1, count = 1 } = {}) {
    const id = DB.run(`INSERT INTO knowledge_base(instanceId,filename,originalName,contentHash,chunkCount,isCurrent,version)
        VALUES(?,?,?,?,?,?,1)`, [businessId, 'fixture.txt', 'Правила бизнеса', 'fixture-hash-' + businessId, count, current]).lastInsertRowid;
    const chunkId = DB.run('INSERT INTO kb_chunks(kbId,chunkIndex,text) VALUES(?,0,?)', [id, content]).lastInsertRowid;
    return { id: Number(id), chunkId: Number(chunkId), content };
}
const selection = doc => ({ supported: true, evidence: [{ sourceId: doc.id, chunkId: doc.chunkId }] });
function response(value, reason = 'STOP') {
    return { data: Readable.from(['data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: typeof value === 'string' ? value : JSON.stringify(value) }] }, ...(reason ? { finishReason: reason } : {}) }] }) + '\n\n']) };
}
async function fixture(run) {
    if (DB.db?.open) DB.db.close();
    createTestDB(); Identity.ensureSchema();
    const own = await DB.createInstance({ name: 'Own small corpus' }), foreign = await DB.createInstance({ name: 'Foreign corpus' });
    await DB.updateInstance(own.id, { aiProvider: 'gemini', geminiModel: 'gemini-3.7-flash' });
    DB.run("INSERT INTO ava_users(id,subject,email) VALUES('preview-owner','preview-subject','preview@example.test')");
    DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('preview-owner',?,'hotel_owner')", [own.id]);
    const doc = document(own.id), privateDoc = document(foreign.id, 'FOREIGN-PRIVATE: никому не показывать этот текст.');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-native-preview-'));
    const adc = path.join(directory, 'adc.json');
    fs.writeFileSync(adc, JSON.stringify({ type: 'service_account', client_email: 'fixture@example.test', private_key: 'fixture-only-key' }), { mode: 0o600 });
    const names = ['GEMINI_PROJECT_ID', 'GEMINI_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_TEXT_ENABLED'];
    const env = Object.fromEntries(names.map(name => [name, process.env[name]]));
    const oldPost = axios.post, oldToken = GoogleAuth.prototype.getAccessToken, oldKey = config.aiTunnel.apiKey;
    Object.assign(process.env, { GEMINI_PROJECT_ID: 'project-fixture', GEMINI_LOCATION: 'global', GOOGLE_APPLICATION_CREDENTIALS: adc, GEMINI_TEXT_ENABLED: 'true' });
    GoogleAuth.prototype.getAccessToken = async () => 'fixture-token';
    const calls = [], ctx = { own: own.id, foreign: foreign.id, doc, privateDoc, adc, calls, post: async () => response(selection(doc)) };
    axios.post = async (...args) => { calls.push(args); return ctx.post(...args); };
    try { await run(ctx); } finally {
        axios.post = oldPost; GoogleAuth.prototype.getAccessToken = oldToken; config.aiTunnel.apiKey = oldKey;
        for (const name of names) if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
        fs.rmSync(directory, { recursive: true, force: true });
        if (DB.db?.open) DB.db.close();
    }
}
const ask = (ctx, options) => Preview.answer(auth, ctx.own, 'Можно ли приехать до обеда?', options);

describe('Native complete small-corpus AI evidence preview', () => {
    it('uses the actual selected business Gemini once and returns only verified semantic source quotes', () => fixture(async ctx => {
        document(ctx.own, 'Парковка для гостей расположена справа от входа.');
        document(ctx.own, 'OLD-CURRENT-FALSE must not enter the model.', { current: 0 });
        const result = await ask(ctx);
        assert.strictEqual(result.answer, quote); assert.strictEqual(result.provenance, 'native_knowledge_ai_selection');
        assert.deepStrictEqual(result.citations, [{ source_id: ctx.doc.id, chunk_id: ctx.doc.chunkId, quote, title: 'Правила бизнеса' }]);
        assert.ok(Number.isFinite(Date.parse(result.source_timestamp))); assert.strictEqual(ctx.calls.length, 1);
        const [url, body, options] = ctx.calls[0];
        assert.ok(url.includes('/gemini-3.7-flash:streamGenerateContent')); assert.strictEqual(options.proxy, false);
        const input = JSON.parse(body.contents[0].parts[0].text);
        assert.strictEqual(input.chunks.length, 2); assert.strictEqual(input.question, 'Можно ли приехать до обеда?');
        assert.ok(!JSON.stringify(body).includes('FOREIGN-PRIVATE')); assert.ok(!JSON.stringify(body).includes('OLD-CURRENT-FALSE'));
        assert.strictEqual(body.tools, undefined); assert.ok(options.timeout <= 12000);
    }));

    it('returns null without any model dispatch for empty, incomplete, oversized or too-many-chunks corpus', () => fixture(async ctx => {
        DB.run('DELETE FROM knowledge_base WHERE instanceId=?', [ctx.own]);
        assert.strictEqual(await ask(ctx), null);
        const doc = document(ctx.own, quote, { count: 2 });
        assert.strictEqual(await ask(ctx), null);
        DB.run('UPDATE knowledge_base SET chunkCount=1 WHERE id=?', [doc.id]);
        DB.run('UPDATE kb_chunks SET text=? WHERE kbId=?', ['x'.repeat(6001), doc.id]);
        assert.strictEqual(await ask(ctx), null);
        DB.run('UPDATE kb_chunks SET text=? WHERE kbId=?', ['x'.repeat(60001), doc.id]);
        assert.strictEqual(await ask(ctx), null);
        DB.run('UPDATE kb_chunks SET text=? WHERE kbId=?', [quote, doc.id]);
        for (let n = 1; n < 65; n++) DB.run('INSERT INTO kb_chunks(kbId,chunkIndex,text) VALUES(?,?,?)', [doc.id, n, quote]);
        DB.run('UPDATE knowledge_base SET chunkCount=65 WHERE id=?', [doc.id]);
        assert.strictEqual(await ask(ctx), null); assert.strictEqual(ctx.calls.length, 0);
    }));

    it('preserves the existing Onyx route when legacy local knowledge tables are not initialized', () => fixture(async ctx => {
        DB.db.exec('DROP TABLE kb_chunks');
        assert.strictEqual(await ask(ctx), null);
        DB.db.pragma('foreign_keys=OFF'); DB.db.exec('DROP TABLE knowledge_base');
        assert.strictEqual(await ask(ctx), null);
        assert.strictEqual(ctx.calls.length, 0);
    }));

    it('preserves the Onyx seam with no local DB handle while still checking authorization first', () => fixture(async ctx => {
        const database = DB.db, authorize = Identity.authorizeCapability; let checks = 0;
        Identity.authorizeCapability = () => { checks++; return ctx.own; };
        DB.db = null;
        try {
            assert.strictEqual(await ask(ctx), null); assert.strictEqual(checks, 1);
            Identity.authorizeCapability = () => { throw Object.assign(new Error('denied'), { code: 'BUSINESS_ACCESS_DENIED', statusCode: 403 }); };
            await assert.rejects(ask(ctx), error => error.code === 'BUSINESS_ACCESS_DENIED');
            assert.strictEqual(ctx.calls.length, 0);
        } finally { DB.db = database; Identity.authorizeCapability = authorize; }
    }));

    it('preserves Onyx only for unavailable direct AI configuration before dispatch, never unauthorized scope', () => fixture(async ctx => {
        const adc = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        process.env.GOOGLE_APPLICATION_CREDENTIALS = '/missing-local-fixture-adc';
        assert.strictEqual(await ask(ctx), null);
        process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
        await DB.updateInstance(ctx.own, { aiProvider: 'aitunnel', yandexGptKey: '' }); config.aiTunnel.apiKey = '';
        assert.strictEqual(await ask(ctx), null);
        DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='preview-owner'");
        await assert.rejects(ask(ctx), error => error.code === 'BUSINESS_ACCESS_DENIED');
        assert.strictEqual(ctx.calls.length, 0);
    }));

    it('rechecks the caller session after configuration await and provider await', () => fixture(async ctx => {
        const getInstance = DB.getInstance; let revoked = false;
        const reauthorize = () => { if (revoked) throw Object.assign(new Error('revoked'), { code: 'BUSINESS_ACCESS_DENIED', statusCode: 403 }); };
        DB.getInstance = async (...args) => { const value = await getInstance.apply(DB, args); revoked = true; return value; };
        try { await assert.rejects(ask(ctx, { reauthorize }), error => error.code === 'BUSINESS_ACCESS_DENIED'); }
        finally { DB.getInstance = getInstance; }
        assert.strictEqual(ctx.calls.length, 0);
        revoked = false; ctx.post = async () => { revoked = true; return response(selection(ctx.doc)); };
        await assert.rejects(ask(ctx, { reauthorize }), error => error.code === 'BUSINESS_ACCESS_DENIED');
        assert.strictEqual(ctx.calls.length, 1);
    }));

    it('returns whole chunks preserving number and negation and rejects model-selected dangerous substrings', () => fixture(async ctx => {
        const entire = 'Стоимость: 1500 рублей за ночь. Завтрак не включён в стоимость.';
        DB.run('UPDATE kb_chunks SET text=? WHERE id=?', [entire, ctx.doc.chunkId]);
        for (const quote of ['500 рублей за ночь.', 'включён в стоимость.']) {
            ctx.post = async () => response({ supported: true, evidence: [{ sourceId: ctx.doc.id, chunkId: ctx.doc.chunkId, quote }] });
            await assert.rejects(ask(ctx), error => error.code === 'KNOWLEDGE_PREVIEW_AI_INVALID');
        }
        ctx.post = async () => response(selection(ctx.doc));
        const result = await ask(ctx);
        assert.strictEqual(result.answer, entire); assert.strictEqual(result.citations[0].quote, entire);
        assert.ok(result.answer.includes('1500 рублей')); assert.ok(result.answer.includes('не включён'));
        assert.strictEqual(ctx.calls.length, 3);
    }));

    it('rejects foreign tenant access before dispatch and never accepts foreign source evidence', () => fixture(async ctx => {
        await assert.rejects(Preview.answer(auth, ctx.foreign, 'Question?'), error => error.code === 'BUSINESS_ACCESS_DENIED');
        assert.strictEqual(ctx.calls.length, 0);
        ctx.post = async () => response(selection(ctx.privateDoc));
        await assert.rejects(ask(ctx), error => error.code === 'KNOWLEDGE_PREVIEW_AI_UNGROUNDED');
        assert.strictEqual(ctx.calls.length, 1);
    }));

    it('rejects changed current text, content hash, document version, deletion, replacement or new corpus member after await', () => fixture(async ctx => {
        for (const mutate of [
            () => DB.run('UPDATE kb_chunks SET text=? WHERE id=?', ['Changed authoritative text for the business.', ctx.doc.chunkId]),
            () => DB.run("UPDATE knowledge_base SET contentHash='changed' WHERE id=?", [ctx.doc.id]),
            () => DB.run('UPDATE knowledge_base SET version=version+1 WHERE id=?', [ctx.doc.id]),
            () => DB.run('DELETE FROM knowledge_base WHERE id=?', [ctx.doc.id]),
            () => DB.run('UPDATE knowledge_base SET isCurrent=0 WHERE id=?', [ctx.doc.id]),
            () => document(ctx.own, 'Новый текущий документ содержит другой действующий факт.'),
        ]) {
            const saved = DB.db.serialize();
            ctx.post = async () => { mutate(); return response(selection(ctx.doc)); };
            await assert.rejects(ask(ctx), error => error.code === 'KNOWLEDGE_PREVIEW_SOURCE_CHANGED');
            // Restore only this isolated in-memory fixture for the next race.
            const Database = require('better-sqlite3'); DB.db.close(); DB.db = new Database(saved); DB.db.pragma('foreign_keys=ON');
        }
        assert.strictEqual(ctx.calls.length, 6);
    }));

    it('does not mix a concurrent foreign-corpus edit into the own verified answer', () => fixture(async ctx => {
        ctx.post = async () => { DB.run('UPDATE kb_chunks SET text=? WHERE id=?', ['FOREIGN MODIFIED fact.', ctx.privateDoc.chunkId]); return response(selection(ctx.doc)); };
        assert.strictEqual((await ask(ctx)).answer, quote);
    }));

    it('rechecks revoked membership, disabled account and disabled business after the provider await', () => fixture(async ctx => {
        for (const statement of ["UPDATE ava_business_memberships SET enabled=0 WHERE userId='preview-owner'", "UPDATE ava_users SET enabled=0 WHERE id='preview-owner'", 'UPDATE instances SET isActive=0 WHERE id=' + ctx.own]) {
            ctx.post = async () => { DB.run(statement); return response(selection(ctx.doc)); };
            await assert.rejects(ask(ctx), error => error.statusCode === 403);
            DB.run("UPDATE ava_business_memberships SET enabled=1 WHERE userId='preview-owner'"); DB.run("UPDATE ava_users SET enabled=1 WHERE id='preview-owner'"); DB.run('UPDATE instances SET isActive=1 WHERE id=?', [ctx.own]);
        }
    }));

    it('rejects a selected model or credential revision changed during generation', () => fixture(async ctx => {
        ctx.post = async () => { DB.run("UPDATE instances SET geminiModel='gemini-3.8-flash' WHERE id=?", [ctx.own]); return response(selection(ctx.doc)); };
        await assert.rejects(ask(ctx), error => error.code === 'KNOWLEDGE_PREVIEW_CONFIG_CHANGED');
        ctx.post = async () => { fs.writeFileSync(ctx.adc, JSON.stringify({ type: 'service_account', client_email: 'fixture-new@example.test', private_key: 'fixture-new-key' })); return response(selection(ctx.doc)); };
        await assert.rejects(ask(ctx), error => error.code === 'KNOWLEDGE_PREVIEW_CONFIG_CHANGED');
        ctx.post = async () => { DB.run("UPDATE instances SET aiProvider='aitunnel',yandexGptKey='fixture-other-key',yandexGptModelUri='fixture-other-model' WHERE id=?", [ctx.own]); return response(selection(ctx.doc)); };
        await assert.rejects(ask(ctx), error => error.code === 'KNOWLEDGE_PREVIEW_CONFIG_CHANGED');
        assert.strictEqual(ctx.calls.length, 3);
    }));

    it('returns explicit no-answer for a full small corpus instead of invented facts or an Onyx fallback', () => fixture(async ctx => {
        ctx.post = async () => response({ supported: false, evidence: [] });
        await assert.rejects(ask(ctx), error => error.code === 'KNOWLEDGE_PREVIEW_NO_ANSWER' && error.statusCode === 409);
        assert.strictEqual(ctx.calls.length, 1);
    }));

    it('rejects empty evidence, wrong source/chunk, malformed JSON and model prose or tool fields', () => fixture(async ctx => {
        for (const output of [
            { supported: true, evidence: [] },
            { supported: true, evidence: [{ sourceId: ctx.doc.id, chunkId: ctx.doc.chunkId + 999 }] },
            { supported: true, evidence: [{ sourceId: ctx.privateDoc.id, chunkId: ctx.doc.chunkId }] },
            { supported: true, evidence: [selection(ctx.doc).evidence[0], selection(ctx.doc).evidence[0]] },
            { ...selection(ctx.doc), answer: 'Unchecked model prose must never become the answer.' },
            { ...selection(ctx.doc), tool_calls: [{ name: 'send_message' }] },
            '{"supported":true,"evidence":',
        ]) {
            ctx.post = async () => response(output);
            await assert.rejects(ask(ctx), error => ['KNOWLEDGE_PREVIEW_AI_INVALID', 'KNOWLEDGE_PREVIEW_AI_UNGROUNDED'].includes(error.code));
        }
        assert.strictEqual(ctx.calls.length, 7);
    }));

    it('does not accept partial/no-STOP or truncated streams and never retries the selected model', () => fixture(async ctx => {
        for (const reason of [null, 'MAX_TOKENS', 'SAFETY']) {
            ctx.post = async () => response(selection(ctx.doc), reason);
            await assert.rejects(ask(ctx), error => error.code === 'KNOWLEDGE_PREVIEW_AI_INVALID');
        }
        assert.strictEqual(ctx.calls.length, 3);
    }));

    it('requires a full terminal stop/no-tool OpenAI result when the same business selects AITunnel', () => fixture(async ctx => {
        await DB.updateInstance(ctx.own, { aiProvider: 'aitunnel', yandexGptKey: 'fixture-aitunnel-key', yandexGptModelUri: 'fixture-selected-model' });
        const complete = finish_reason => ({ data: { choices: [{ finish_reason, message: { role: 'assistant', content: JSON.stringify(selection(ctx.doc)) } }] } });
        ctx.post = async () => complete(undefined);
        await assert.rejects(ask(ctx), error => error.code === 'KNOWLEDGE_PREVIEW_AI_INVALID');
        ctx.post = async () => complete('stop');
        assert.strictEqual((await ask(ctx)).answer, quote); assert.strictEqual(ctx.calls[1][1].model, 'fixture-selected-model');
        ctx.post = async () => {
            const value = complete('stop'); value.data.choices[0].message.tool_calls = [{ type: 'function', function: { name: 'send_message', arguments: '{}' } }]; return value;
        };
        await assert.rejects(ask(ctx), error => error.code === 'KNOWLEDGE_PREVIEW_AI_INVALID');
        assert.strictEqual(ctx.calls.length, 3);
    }));

    it('maps provider failure safely with one call and no synthetic answer', () => fixture(async ctx => {
        ctx.post = async () => { throw new Error('provider-private-response-secret'); };
        await assert.rejects(ask(ctx), error => error.code === 'KNOWLEDGE_PREVIEW_AI_UNAVAILABLE' && !error.message.includes('secret'));
        assert.strictEqual(ctx.calls.length, 1);
    }));

    it('honors pre-abort, parent cancellation and overall deadline without completing partial work', () => fixture(async ctx => {
        const already = new AbortController(); already.abort();
        await assert.rejects(ask(ctx, { signal: already.signal }), error => error.code === 'KNOWLEDGE_PREVIEW_CANCELED');
        assert.strictEqual(ctx.calls.length, 0);
        const streams = [];
        ctx.post = async () => { const stream = new Readable({ read() {} }); streams.push(stream); return { data: stream }; };
        const controller = new AbortController(), pending = ask(ctx, { signal: controller.signal });
        const abortTimer = setTimeout(() => controller.abort(), 20);
        await assert.rejects(pending, error => error.code === 'KNOWLEDGE_PREVIEW_CANCELED'); clearTimeout(abortTimer);
        await assert.rejects(ask(ctx, { timeoutMs: 20 }), error => error.code === 'KNOWLEDGE_PREVIEW_TIMEOUT');
        assert.strictEqual(ctx.calls.length, 2); assert.ok(streams.every(stream => stream.destroyed));
    }));
});
