'use strict';
// Separate vector space: never mix Gemini vectors with legacy AITunnel vectors.
const crypto = require('node:crypto');
const axios = require('axios');
const DB = require('./database.service');
const Vertex = require('./gemini-text.service');
const TABLE = 'kb_chunks_vec_gemini_001_3072';
const META = 'kb_gemini_vectors_meta';
const MODEL = 'gemini-embedding-001';
const DIMENSIONS = 3072;
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const fail = code => Object.assign(new Error(code), { code });

function createService({ db = DB, vertex = Vertex, post = axios.post.bind(axios), dimensions = DIMENSIONS } = {}) {
    const cache = new Map(), rebuilds = new Map();
    let activeRebuilds = 0;
    function business(id) {
        if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw fail('KNOWLEDGE_SCOPE_INVALID');
        const row = db.get('SELECT aiProvider FROM instances WHERE id=? AND isActive=1', [Number(id)]);
        if (!row) throw fail('KNOWLEDGE_SCOPE_UNAVAILABLE');
        return row;
    }
    function selected(id) { return business(id).aiProvider === 'gemini'; }
    function ensure() {
        // Lazy and additive. The old vector table and its rows are untouched.
        db.db.transaction(() => {
            db.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING vec0(
                instanceId INTEGER PARTITION KEY, embedding float[${dimensions}], +chunkId INTEGER, +kbId INTEGER);
                CREATE TABLE IF NOT EXISTS ${META}(chunkId INTEGER PRIMARY KEY,instanceId INTEGER NOT NULL,
                    kbId INTEGER NOT NULL,contentHash TEXT NOT NULL);
                CREATE TRIGGER IF NOT EXISTS gemini_vector_meta_delete AFTER DELETE ON ${META} BEGIN
                    DELETE FROM ${TABLE} WHERE rowid=OLD.chunkId; END;
                CREATE TRIGGER IF NOT EXISTS gemini_vector_chunk_delete AFTER DELETE ON kb_chunks BEGIN
                    DELETE FROM ${META} WHERE chunkId=OLD.id; END;
                CREATE TRIGGER IF NOT EXISTS gemini_vector_chunk_edit AFTER UPDATE OF text ON kb_chunks
                    WHEN OLD.text IS NOT NEW.text BEGIN DELETE FROM ${META} WHERE chunkId=NEW.id; END;`);
        }).immediate();
    }
    async function embed(text, instanceId, task, { signal, deadline = Date.now() + 12000 } = {}) {
        if (!selected(instanceId)) throw fail('AI_MODEL_SETTINGS_CHANGED');
        if (typeof text !== 'string' || !text.trim() || text.length > 16000
            || !['RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY'].includes(task)) throw fail('KNOWLEDGE_INPUT_INVALID');
        const settings = vertex.settings();
        const key = `${instanceId}:${settings.identity}:${task}:${digest(text)}`;
        if (signal?.aborted) throw fail('AI_CANCELED');
        if (cache.has(key)) return [...cache.get(key)];
        const controller = new AbortController(), cancel = () => controller.abort();
        signal?.addEventListener('abort', cancel, { once: true });
        const remaining = Math.min(12000, deadline - Date.now());
        if (remaining <= 0) { signal?.removeEventListener('abort', cancel); throw fail('AI_TIMEOUT'); }
        const timer = setTimeout(cancel, remaining);
        try {
            const token = await vertex.accessToken({ signal: controller.signal, deadline });
            const location = 'us-central1'; // Embedding predict is served regionally.
            const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${settings.project}/locations/${location}/publishers/google/models/${MODEL}:predict`;
            const response = await post(url, { instances: [{ content: text, task_type: task }],
                parameters: { autoTruncate: false, outputDimensionality: dimensions } }, {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                signal: controller.signal, timeout: Math.max(1, deadline - Date.now()), proxy: false,
                maxRedirects: 0, maxContentLength: 256 * 1024, maxBodyLength: 128 * 1024,
            });
            if (controller.signal.aborted) throw fail('AI_TIMEOUT');
            if (!selected(instanceId)) throw fail('AI_MODEL_SETTINGS_CHANGED');
            const values = response.data?.predictions?.[0]?.embeddings?.values;
            if (!Array.isArray(values) || values.length !== dimensions || values.some(value => !Number.isFinite(value)))
                throw fail('KNOWLEDGE_EMBEDDING_INVALID');
            const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
            if (!(norm > 0) || !Number.isFinite(norm)) throw fail('KNOWLEDGE_EMBEDDING_INVALID');
            const normalized = values.map(value => value / norm);
            if (cache.size >= 512) cache.delete(cache.keys().next().value);
            cache.set(key, normalized);
            return [...normalized];
        } catch (error) {
            if (signal?.aborted) throw fail('AI_CANCELED');
            if (controller.signal.aborted) throw fail('AI_TIMEOUT');
            if (/^(?:AI_|KNOWLEDGE_)/.test(error.code || '')) throw error;
            throw fail('KNOWLEDGE_EMBEDDING_UNAVAILABLE');
        } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); }
    }
    function store(chunk, instanceId) {
        if (!selected(instanceId)) return false;
        if (!Array.isArray(chunk.embedding) || chunk.embedding.length !== dimensions
            || chunk.embedding.some(value => !Number.isFinite(value))) return false;
        ensure();
        return db.db.transaction(() => {
            const current = db.get(`SELECT c.id,c.kbId,c.text FROM kb_chunks c JOIN knowledge_base k ON k.id=c.kbId
                WHERE c.id=? AND k.instanceId=? AND k.isCurrent=1`, [chunk.id, Number(instanceId)]);
            if (!current || current.text !== chunk.text || !selected(instanceId)) return false;
            const bytes = Buffer.from(new Float32Array(chunk.embedding).buffer);
            db.db.prepare(`DELETE FROM ${META} WHERE chunkId=?`).run(current.id);
            db.db.prepare(`INSERT INTO ${TABLE}(rowid,instanceId,embedding,chunkId,kbId) VALUES(?,?,?,?,?)`)
                .run(BigInt(current.id), BigInt(instanceId), bytes, BigInt(current.id), BigInt(current.kbId));
            db.db.prepare(`INSERT INTO ${META}(chunkId,instanceId,kbId,contentHash) VALUES(?,?,?,?)`)
                .run(current.id, Number(instanceId), current.kbId, digest(current.text));
            return true;
        }).immediate();
    }
    async function generate(chunks, instanceId, options = {}) {
        const results = chunks.map(chunk => ({ ...chunk, embedding: null, embeddingProvider: 'gemini' }));
        let cursor = 0;
        const deadline = Math.min(options.deadline || Infinity, Date.now() + 60000);
        await Promise.all([0, 1].map(async () => {
            while (cursor < results.length && Date.now() < deadline && !options.signal?.aborted && selected(instanceId)) {
                const index = cursor++;
                try { results[index].embedding = await embed(results[index].text, instanceId, 'RETRIEVAL_DOCUMENT', { ...options, deadline }); }
                catch (_) { /* Retain readable chunks; incomplete indexing is explicit in existing stats. */ }
            }
        }));
        return results;
    }
    function count(instanceId, kbId) {
        ensure();
        return db.get(`SELECT COUNT(*) AS n FROM ${META} m JOIN kb_chunks c ON c.id=m.chunkId
            JOIN knowledge_base k ON k.id=c.kbId WHERE m.instanceId=? AND k.instanceId=? AND (? IS NULL OR k.id=?) AND k.isCurrent=1`,
        [Number(instanceId), Number(instanceId), kbId ?? null, kbId ?? null]).n;
    }
    function scheduleRebuild(instanceId) {
        if (rebuilds.has(instanceId) || activeRebuilds >= 2 || !selected(instanceId)) return;
        activeRebuilds++;
        const work = (async () => {
            ensure();
            const chunks = db.all(`SELECT c.id,c.kbId,c.text FROM kb_chunks c JOIN knowledge_base k ON k.id=c.kbId
                LEFT JOIN ${META} m ON m.chunkId=c.id WHERE k.instanceId=? AND k.isCurrent=1 AND m.chunkId IS NULL
                ORDER BY c.id LIMIT 100`, [Number(instanceId)]);
            for (const chunk of await generate(chunks, instanceId)) if (chunk.embedding) store(chunk, instanceId);
        })().catch(() => {}).finally(() => { activeRebuilds--; rebuilds.delete(instanceId); });
        rebuilds.set(instanceId, work);
    }
    async function search(instanceId, query, k = 5, options = {}) {
        if (!selected(instanceId)) return [];
        ensure();
        const count = db.get(`SELECT COUNT(*) AS n FROM ${META} WHERE instanceId=?`, [Number(instanceId)]).n;
        if (!count) { scheduleRebuild(instanceId); return []; }
        scheduleRebuild(instanceId);
        const vector = await embed(query, instanceId, 'RETRIEVAL_QUERY', { ...options, deadline: Math.min(options.deadline || Infinity, Date.now() + 3500) });
        if (!selected(instanceId)) return [];
        const rows = db.db.prepare(`SELECT chunkId,distance FROM ${TABLE} WHERE embedding MATCH ? AND k=? AND instanceId=? ORDER BY distance`)
            .all(Buffer.from(new Float32Array(vector).buffer), BigInt(Math.min(100, Math.max(1, k * 3))), BigInt(instanceId));
        return rows.flatMap(row => {
            const current = db.get(`SELECT c.id,c.kbId,c.text,c.section,k.originalName,m.contentHash FROM kb_chunks c
                JOIN knowledge_base k ON k.id=c.kbId JOIN ${META} m ON m.chunkId=c.id
                WHERE c.id=? AND k.instanceId=? AND m.instanceId=? AND k.isCurrent=1`, [row.chunkId, Number(instanceId), Number(instanceId)]);
            return current && digest(current.text) === current.contentHash ? [{ ...current, distance: row.distance }] : [];
        }).slice(0, k);
    }
    return { selected, embed, store, generate, search, count, scheduleRebuild };
}
module.exports = { ...createService(), createService, TABLE, META, MODEL, DIMENSIONS };
