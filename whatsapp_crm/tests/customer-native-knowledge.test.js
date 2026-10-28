'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const express = require('express');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const Native = require('../src/services/customer-native-knowledge.service');
const DB = require('../src/services/database.service');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const RAG = require('../src/services/rag.service');

async function withServer(run) {
    const authorize = Identity.authorizeCapability, getSession = Auth.getSession;
    Auth.getSession = req => req.auth;
    const state = Native.status;
    const enqueue = Native.enqueue;
    const oldOrigin = process.env.WHATSAPP_CRM_PUBLIC_URL;
    process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
    Identity.authorizeCapability = (auth, businessId, capability) => {
        if (auth.userId !== 'owner-a' || businessId !== 7 || capability === 'business.manage' && auth.role !== 'owner') {
            throw Object.assign(new Error('denied'), { statusCode: 403 });
        }
        return businessId;
    };
    Native.status = businessId => ({ businessId, onyx: 'configured', documents: [{ id: 11, state: 'needs_sync' }] });
    Native.enqueue = (businessId, id) => ({ businessId, documentId: id, state: 'processing', queued: true });
    const app = express();
    app.use(express.json());
    app.use('/api', (req, _res, next) => {
        req.auth = { userId: req.get('X-Test-User') || 'owner-a', role: req.get('X-Test-Role') || 'owner' };
        next();
    });
    app.use('/api', require('../src/routes/customer-knowledge-preview.routes'));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}/api/businesses`;
    try { await run(base); }
    finally {
        await new Promise(resolve => server.close(resolve));
        Identity.authorizeCapability = authorize; Auth.getSession = getSession;
        Native.status = state;
        Native.enqueue = enqueue;
        if (oldOrigin === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
        else process.env.WHATSAPP_CRM_PUBLIC_URL = oldOrigin;
    }
}

describe('Customer native knowledge boundary', () => {
    it('reports revoked access after a durable edit without exposing the saved source', async () => {
        createTestDB();
        DB.run("INSERT INTO instances(id,name) VALUES (7,'Synthetic source')");
        DB.run("INSERT INTO onyx_tenant_links(business_id,onyx_tenant_id,onyx_base_url,status) VALUES (7,'hotel_7','https://example.test/api','STAGING')");
        const id = DB.addKnowledgeBaseFile(7, 'synthetic.txt', 'synthetic.txt', 'old-hash', 'text/plain', 50, 1);
        DB.run('INSERT INTO kb_chunks(kbId,chunkIndex,text) VALUES (?,0,?)', [id, 'SYNTHETIC_ORIGINAL']);
        const chunkId = DB.getDocumentChunks(7, id)[0].id;
        const enqueue = Native.enqueue, embeddings = RAG.generateEmbeddings;
        try {
            await withServer(async base => {
                Native.enqueue = enqueue;
                RAG.generateEmbeddings = async chunks => {
                    Identity.authorizeCapability = () => { throw Object.assign(new Error('revoked'), { statusCode: 403 }); };
                    return chunks;
                };
                const response = await fetch(`${base}/7/knowledge/documents/${id}/chunks/${chunkId}`, {
                    method: 'PUT', headers: { Origin: 'https://ava.example.test', 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: 'SYNTHETIC_EDIT_SAVED' }),
                });
                assert.equal(response.status, 403);
                assert.deepEqual(await response.json(), { success: false, code: 'BUSINESS_ACCESS_DENIED' });
                assert.equal(DB.getChunkById(7, chunkId).text, 'SYNTHETIC_EDIT_SAVED');
                assert.equal(DB.get("SELECT COUNT(*) AS n FROM onyx_sync_outbox WHERE status='PENDING'").n, 1);
                assert.ok(JSON.parse(DB.get('SELECT payload_json FROM onyx_sync_outbox').payload_json).content.includes('SYNTHETIC_EDIT_SAVED'));
            });
        } finally { RAG.generateEmbeddings = embeddings; }
    });

    it('denies direct cross-business requests and owner-only sync for a manager', async () => {
        await withServer(async base => {
            assert.equal((await fetch(`${base}/8/knowledge/native-status`)).status, 403);
            assert.equal((await fetch(`${base}/8/knowledge/documents/11/sync`, {
                method: 'POST', headers: { Origin: 'https://ava.example.test', 'Content-Type': 'application/json' }, body: '{}',
            })).status, 403);
            assert.equal((await fetch(`${base}/7/knowledge/documents/11/sync`, {
                method: 'POST', headers: { Origin: 'https://ava.example.test', 'Content-Type': 'application/json', 'X-Test-Role': 'manager' }, body: '{}',
            })).status, 403);
            assert.equal((await fetch(`${base}/7/knowledge/documents/11/sync`, {
                method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}',
            })).status, 403);
            const accepted = await fetch(`${base}/7/knowledge/documents/11/sync`, {
                method: 'POST', headers: { Origin: 'https://ava.example.test', 'Content-Type': 'application/json' }, body: '{}',
            });
            assert.equal(accepted.status, 200);
            assert.equal((await accepted.json()).queued, true);
        });
    });

    it('returns only scoped safe status fields', async () => {
        await withServer(async base => {
            const result = await (await fetch(`${base}/7/knowledge/native-status`)).json();
            assert.deepEqual(result, { success: true, businessId: 7, onyx: 'configured',
                documents: [{ id: 11, state: 'needs_sync' }] });
        });
    });

    it('deduplicates an already queued document and rejects foreign document ids', () => {
        const get = DB.get, chunks = DB.getDocumentChunks, run = DB.run, connection = DB.db;
        let inserts = 0;
        try {
            DB.get = (sql, params) => {
                if (sql.includes('onyx_tenant_links')) return { status: 'ACTIVE' };
                if (sql.includes('knowledge_base')) return params[0] === 11 && params[1] === 7
                    ? { id: 11, originalName: 'Правила.txt', isCurrent: 1 } : null;
                if (sql.includes('onyx_document_links')) return null;
                if (sql.includes('onyx_sync_outbox')) return { event_id: 'existing' };
                return null;
            };
            DB.getDocumentChunks = () => [{ text: 'Заселение после 14:00.' }];
            DB.run = () => { inserts++; };
            DB.db = { transaction: fn => ({ immediate: fn }) };
            assert.deepEqual(Native.enqueue(7, 11), { state: 'processing', queued: false });
            assert.equal(inserts, 0);
            assert.throws(() => Native.enqueue(8, 11), { code: 'DOCUMENT_NOT_FOUND' });
        } finally { DB.get = get; DB.getDocumentChunks = chunks; DB.run = run; DB.db = connection; }
    });

    it('queues one scoped Onyx event per content and atomically queues deletion', () => {
        const previous = DB.db;
        const database = new Database(':memory:');
        DB.db = database;
        try {
            database.exec(`
                CREATE TABLE knowledge_base(id INTEGER PRIMARY KEY,instanceId INTEGER,originalName TEXT,
                    mimeType TEXT,contentHash TEXT,isCurrent INTEGER,version INTEGER,createdAt TEXT);
                CREATE TABLE kb_chunks(id INTEGER PRIMARY KEY,kbId INTEGER,chunkIndex INTEGER,text TEXT,section TEXT);
                CREATE TABLE onyx_tenant_links(business_id INTEGER PRIMARY KEY,status TEXT);
                CREATE TABLE onyx_document_links(business_id INTEGER,entity_type TEXT,source_id INTEGER,
                    onyx_document_id TEXT,content_hash TEXT,last_synced_at TEXT);
                CREATE TABLE onyx_sync_outbox(id INTEGER PRIMARY KEY,event_id TEXT,business_id INTEGER,
                    entity_type TEXT,source_id INTEGER,operation TEXT,payload_json TEXT,status TEXT,
                    next_attempt_at TEXT,last_error_code TEXT,updated_at TEXT);
            `);
            database.exec(`INSERT INTO onyx_tenant_links VALUES (7,'ACTIVE'),(8,'ACTIVE');
                INSERT INTO knowledge_base VALUES (11,7,'Правила.txt','text/plain',NULL,1,1,CURRENT_TIMESTAMP);
                INSERT INTO knowledge_base VALUES (22,8,'Чужой.txt','text/plain',NULL,1,1,CURRENT_TIMESTAMP);
                INSERT INTO kb_chunks VALUES (31,11,0,'Заселение после 14:00.',NULL);
                INSERT INTO kb_chunks VALUES (32,22,0,'Заселение после 16:00.',NULL);`);
            assert.deepEqual(Native.enqueue(7, 11), { state: 'processing', queued: true });
            assert.deepEqual(Native.enqueue(7, 11), { state: 'processing', queued: false });
            assert.equal(DB.get("SELECT COUNT(*) AS count FROM onyx_sync_outbox WHERE business_id=7").count, 1);
            assert.equal(Native.status(8).documents[0].id, 22);
            assert.throws(() => Native.enqueue(7, 22), { code: 'DOCUMENT_NOT_FOUND' });
            DB.run(`INSERT INTO onyx_document_links
                (business_id,entity_type,source_id,onyx_document_id,content_hash)
                VALUES (7,'knowledge',11,'ava:7:knowledge:11','old')`);
            const result = Native.remove(7, 11);
            assert.equal(result.deleted, 1);
            assert.equal(DB.get('SELECT id FROM knowledge_base WHERE id=11'), undefined);
            assert.equal(DB.get("SELECT status FROM onyx_sync_outbox WHERE operation='UPSERT'").status, 'DEAD');
            assert.equal(DB.get("SELECT COUNT(*) AS count FROM onyx_sync_outbox WHERE operation='DELETE'").count, 1);
            assert.equal(JSON.parse(DB.get("SELECT payload_json FROM onyx_sync_outbox WHERE operation='DELETE'").payload_json).external_id,
                'ava:7:knowledge:11');
        } finally { database.close(); DB.db = previous; }
    });

    it('keeps an imported document linked until its chunks change, then syncs the edited version', () => {
        const previous = DB.db;
        const database = new Database(':memory:');
        DB.db = database;
        try {
            database.exec(`
                CREATE TABLE knowledge_base(id INTEGER PRIMARY KEY,instanceId INTEGER,originalName TEXT,
                    mimeType TEXT,contentHash TEXT,isCurrent INTEGER);
                CREATE TABLE kb_chunks(id INTEGER PRIMARY KEY,kbId INTEGER,chunkIndex INTEGER,
                    text TEXT,searchText TEXT,section TEXT);
                CREATE TABLE onyx_tenant_links(business_id INTEGER PRIMARY KEY,status TEXT);
                CREATE TABLE onyx_document_links(business_id INTEGER,entity_type TEXT,source_id INTEGER,
                    onyx_document_id TEXT,content_hash TEXT,last_synced_at TEXT);
                CREATE TABLE onyx_sync_outbox(id INTEGER PRIMARY KEY,event_id TEXT,business_id INTEGER,
                    entity_type TEXT,source_id INTEGER,operation TEXT,payload_json TEXT,status TEXT,
                    next_attempt_at TEXT,last_error_code TEXT,updated_at TEXT);
            `);
            const original = 'Заселение после 14:00.\n\nЗавтрак с 07:00 до 10:00.';
            const importedHash = crypto.createHash('md5').update(original).digest('hex');
            DB.run("INSERT INTO knowledge_base VALUES (11,7,'Правила.txt','text/plain',?,1)", [importedHash]);
            DB.run("INSERT INTO kb_chunks VALUES (31,11,0,'Заселение после 14:00.',NULL,NULL)");
            DB.run("INSERT INTO kb_chunks VALUES (32,11,1,'Завтрак с 07:00 до 10:00.',NULL,NULL)");
            DB.run("INSERT INTO onyx_tenant_links VALUES (7,'ACTIVE')");
            DB.run("INSERT INTO onyx_document_links VALUES (7,'knowledge',11,'ava:7:knowledge:11',?,CURRENT_TIMESTAMP)", [importedHash]);

            assert.equal(DB.getDocumentChunks(7, 11).length, 2);
            assert.equal(Native.snapshot(7, 11).hash, importedHash);
            assert.equal(Native.status(7).documents[0].state, 'submitted');
            assert.deepEqual(Native.enqueue(7, 11), { state: 'submitted', queued: false });
            assert.equal(DB.get('SELECT COUNT(*) AS count FROM onyx_sync_outbox').count, 0);

            DB.updateChunkContent(7, 31, 'Заселение после 14:00.', 'Время заезда');
            assert.equal(Native.status(7).documents[0].state, 'submitted');

            DB.updateChunkContent(7, 31, 'Заселение после 15:00.', null);
            const changed = crypto.createHash('sha256').update('Заселение после 15:00.\n\nЗавтрак с 07:00 до 10:00.').digest('hex');
            assert.equal(DB.get('SELECT contentHash FROM knowledge_base WHERE id=11').contentHash, changed);
            assert.equal(Native.status(7).documents[0].state, 'needs_sync');
            assert.deepEqual(Native.enqueue(7, 11), { state: 'processing', queued: true });
            const event = DB.get('SELECT payload_json FROM onyx_sync_outbox');
            assert.equal(JSON.parse(event.payload_json).content_hash, changed);
            assert.equal(Native.status(7).documents[0].state, 'processing');

            DB.run('UPDATE onyx_document_links SET content_hash=? WHERE source_id=11', [changed]);
            assert.equal(Native.status(7).documents[0].state, 'submitted');
            DB.deleteChunkById(7, 32);
            assert.notEqual(DB.get('SELECT contentHash FROM knowledge_base WHERE id=11').contentHash, changed);
            assert.notEqual(Native.status(7).documents[0].state, 'submitted');
        } finally { database.close(); DB.db = previous; }
    });
});
