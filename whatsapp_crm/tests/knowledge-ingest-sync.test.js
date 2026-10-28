'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const RAG = require('../src/services/rag.service');
const Native = require('../src/services/customer-native-knowledge.service');
const Access = require('../src/services/identity/module-access-store');
const crypto = require('node:crypto');

function fixture() {
    createTestDB();
    DB.run("INSERT INTO instances(id,name) VALUES (7,'Synthetic A'),(8,'Synthetic B')");
    for (const businessId of [7, 8]) DB.run(`INSERT INTO onyx_tenant_links
        (business_id,onyx_tenant_id,onyx_base_url,status) VALUES (?,?,?,'STAGING')`,
    [businessId, `hotel_${businessId}`, 'https://onyx.example.test/api']);
}

async function withoutEmbeddings(fn) {
    const index = RAG._indexDocumentChunks;
    const embeddings = RAG.generateEmbeddings;
    RAG._indexDocumentChunks = async (instanceId, kbId) => {
        // The durable event must exist even while optional embeddings are slow.
        assert.equal(DB.get(`SELECT COUNT(*) AS n FROM onyx_sync_outbox
            WHERE business_id=? AND source_id=? AND status='PENDING'`, [instanceId, kbId]).n, 1);
        return { vectorCount: 0 };
    };
    RAG.generateEmbeddings = async chunks => chunks;
    try { await fn(); }
    finally { RAG._indexDocumentChunks = index; RAG.generateEmbeddings = embeddings; }
}

function acknowledge(businessId, kbId) {
    const hash = Native.snapshot(businessId, kbId).hash;
    DB.run(`UPDATE onyx_sync_outbox SET status='COMPLETED' WHERE business_id=? AND source_id=?`, [businessId, kbId]);
    DB.run(`INSERT INTO onyx_document_links(business_id,entity_type,source_id,onyx_document_id,content_hash)
        VALUES (?,'knowledge',?,?,?)`, [businessId, kbId, `ava:${businessId}:knowledge:${kbId}`, hash]);
}

function nativeFixture() {
    fixture();
    // Initialize the actual module schema before creating a verified native
    // anchor. No private keys or HTTP transports are needed by source writes.
    assert.throws(() => Access.getCurrentAdapter(crypto.randomUUID()), { code: 'MODULE_ADAPTER_UNAVAILABLE' });
    const deploymentId = crypto.randomUUID();
    const namespace = `ava_${deploymentId.replaceAll('-', '')}`;
    DB.run(`INSERT INTO ava_module_deployments
        (id,businessId,module,hostname,namespace,state,revision,correlationId,createdAt,updatedAt)
        VALUES (?,7,'onyx','synthetic-native.example.test',?,'verified',3,?,?,?)`,
    [deploymentId, namespace, crypto.randomUUID(), Date.now(), Date.now()]);
    DB.run('UPDATE onyx_tenant_links SET onyx_tenant_id=? WHERE business_id=7', [namespace]);
    DB.run(`CREATE TABLE onyx_native_runtime_document_links (
        deployment_id TEXT NOT NULL, deployment_revision INTEGER NOT NULL,
        business_id INTEGER NOT NULL, entity_type TEXT NOT NULL, source_id INTEGER NOT NULL,
        onyx_document_id TEXT NOT NULL, content_hash TEXT NOT NULL,
        PRIMARY KEY(deployment_id,entity_type,source_id))`);
    return deploymentId;
}

async function nativeUpload(fn) {
    const index = RAG._indexDocumentChunks;
    const embeddings = RAG.generateEmbeddings;
    RAG._indexDocumentChunks = async () => ({ vectorCount: 0 });
    RAG.generateEmbeddings = async chunks => chunks;
    try { await fn(); } finally { RAG._indexDocumentChunks = index; RAG.generateEmbeddings = embeddings; }
}

describe('Knowledge ingest source to durable Onyx sync', () => {
    it('queues parsed upload before embeddings and isolates the same name in another business', async () => {
        fixture();
        await withoutEmbeddings(async () => {
            for (const businessId of [7, 8]) {
                const result = await RAG.processDocument(businessId,
                    Buffer.from(`Контрольный маркер SYNTHETIC_${businessId}. Заезд в ${businessId === 7 ? '15:23' : '18:47'}. Дополнительные контрольные сведения.`),
                    'synthetic.txt', 'text/plain');
                assert.equal(result.success, true, result.error);
                assert.deepEqual(result.nativeSync, { state: 'processing', queued: true });
                const event = DB.get('SELECT * FROM onyx_sync_outbox WHERE business_id=?', [businessId]);
                const source = JSON.parse(event.payload_json);
                assert.equal(source.external_id, `ava:${businessId}:knowledge:${result.kbId}`);
                assert.ok(source.content.includes(`SYNTHETIC_${businessId}`));
                assert.equal(Native.status(businessId).documents[0].state, 'processing');
            }
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM onyx_sync_outbox').n, 2);
        });
    });

    it('autoqueues edits and deleting the last chunk queues an idempotent DELETE, not stale text', async () => {
        fixture();
        await withoutEmbeddings(async () => {
            const upload = await RAG.processDocument(7, Buffer.from('Контрольный маркер ALPHA. Заезд в 15:23. Дополнительные контрольные сведения.'), 'synthetic.txt', 'text/plain');
            acknowledge(7, upload.kbId);
            const chunk = DB.getDocumentChunks(7, upload.kbId)[0];
            const edited = await RAG.updateChunk(7, chunk.id, 'Контрольный маркер BETA. Заезд в 16:24.', null);
            assert.equal(edited.nativeSync.state, 'processing');
            assert.equal(Native.status(7).documents[0].state, 'processing');
            const event = DB.get("SELECT payload_json FROM onyx_sync_outbox WHERE status='PENDING'");
            assert.ok(JSON.parse(event.payload_json).content.includes('BETA'));
            const removed = await RAG.deleteChunk(7, chunk.id);
            assert.deepEqual(removed.nativeSync, { state: 'empty', queued: true });
            assert.equal(Native.status(7).documents[0].state, 'empty');
            assert.deepEqual(Native.enqueue(7, upload.kbId), { state: 'empty', queued: false });
            assert.equal(DB.get("SELECT COUNT(*) AS n FROM onyx_sync_outbox WHERE operation='DELETE'").n, 1);
            assert.equal(DB.get("SELECT COUNT(*) AS n FROM onyx_sync_outbox WHERE operation='UPSERT' AND status='PENDING'").n, 0);
        });
    });

    it('preserves a locally saved source when Onyx is unconfigured and reports that state explicitly', async () => {
        fixture();
        DB.run('DELETE FROM onyx_tenant_links WHERE business_id=7');
        const index = RAG._indexDocumentChunks;
        RAG._indexDocumentChunks = async () => ({ vectorCount: 0 });
        try {
            const result = await RAG.processDocument(7, Buffer.from('SYNTHETIC_LOCAL_SOURCE. Проверяем сохранение документа.'), 'local.txt', 'text/plain');
            assert.equal(result.success, true);
            assert.deepEqual(result.nativeSync, { state: 'unavailable', queued: false, code: 'ONYX_NOT_CONFIGURED' });
            assert.ok(Native.snapshot(7, result.kbId).content.includes('SYNTHETIC_LOCAL_SOURCE'));
            assert.equal(Native.status(7).documents[0].state, 'unavailable');
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM onyx_sync_outbox').n, 0);
        } finally { RAG._indexDocumentChunks = index; }
    });

    it('does not accept a matching hash projected from a foreign source and deletes only its own canonical ID', async () => {
        fixture();
        await withoutEmbeddings(async () => {
            const upload = await RAG.processDocument(7, Buffer.from('SYNTHETIC_SCOPE_GUARD. Проверка изоляции подтверждённого документа.'), 'scope.txt', 'text/plain');
            acknowledge(7, upload.kbId);
            DB.run("UPDATE onyx_document_links SET onyx_document_id='ava:8:knowledge:777' WHERE business_id=7");
            assert.equal(Native.status(7).documents[0].state, 'needs_sync');
            assert.deepEqual(Native.enqueue(7, upload.kbId), { state: 'processing', queued: true });
            Native.remove(7, upload.kbId);
            const deletion = JSON.parse(DB.get("SELECT payload_json FROM onyx_sync_outbox WHERE operation='DELETE'").payload_json);
            assert.equal(deletion.external_id, `ava:7:knowledge:${upload.kbId}`);
        });
    });

    it('keeps native upload/edit/delete on durable sources and requires the exact own current projection', async () => {
        const deploymentId = nativeFixture();
        await nativeUpload(async () => {
            const upload = await RAG.processDocument(7, Buffer.from('SYNTHETIC_NATIVE_ALPHA. Заезд в 15:23. Проверяем собственный native источник.'), 'native.txt', 'text/plain');
            assert.equal(upload.success, true);
            assert.deepEqual(upload.nativeSync, { state: 'needs_sync', queued: false });
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM onyx_sync_outbox').n, 0);
            const source = Native.snapshot(7, upload.kbId);
            DB.run(`INSERT INTO onyx_native_runtime_document_links VALUES (?,3,7,'knowledge',?,?,?)`,
                [deploymentId, upload.kbId, encodeURIComponent(`ava:7:knowledge:${upload.kbId}`), source.hash]);
            assert.equal(Native.status(7).documents[0].state, 'submitted');
            assert.deepEqual(Native.enqueue(7, upload.kbId), { state: 'submitted', queued: false });
            const chunk = DB.getDocumentChunks(7, upload.kbId)[0];
            const edited = await RAG.updateChunk(7, chunk.id, 'SYNTHETIC_NATIVE_BETA. Заезд в 16:24. Новая версия источника.', null);
            assert.deepEqual(edited.nativeSync, { state: 'needs_sync', queued: false });
            assert.equal(Native.status(7).documents[0].state, 'needs_sync');
            assert.ok(Native.snapshot(7, upload.kbId).content.includes('SYNTHETIC_NATIVE_BETA'));
            const removed = await RAG.deleteChunk(7, chunk.id);
            assert.deepEqual(removed.nativeSync, { state: 'empty', queued: false });
            assert.equal(Native.status(7).documents[0].state, 'empty');
            Native.remove(7, upload.kbId);
            assert.deepEqual(Native.status(7).documents, []);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM onyx_sync_outbox').n, 0);
        });
    });

    it('rejects native foreign IDs, foreign business, stale deployment revisions and a revoked deployment without legacy fallback', async () => {
        const deploymentId = nativeFixture();
        await nativeUpload(async () => {
            const own = await RAG.processDocument(7, Buffer.from('SYNTHETIC_NATIVE_OWN. Проверка собственного документа.'), 'same.txt', 'text/plain');
            const other = await RAG.processDocument(8, Buffer.from('SYNTHETIC_NATIVE_OTHER. Соседний документ сохраняется.'), 'same.txt', 'text/plain');
            const otherBefore = Native.snapshot(8, other.kbId);
            const hash = Native.snapshot(7, own.kbId).hash;
            DB.run(`INSERT INTO onyx_native_runtime_document_links VALUES (?,3,7,'knowledge',?,?,?)`,
                [deploymentId, own.kbId, `ava:7:knowledge:${own.kbId}`, hash]);
            for (const [column, value] of [['onyx_document_id','ava:8:knowledge:777'], ['business_id',8], ['deployment_revision',2], ['deployment_id',crypto.randomUUID()]]) {
                DB.run(`UPDATE onyx_native_runtime_document_links SET ${column}=?`, [value]);
                assert.equal(Native.status(7).documents[0].state, 'needs_sync');
                assert.deepEqual(Native.enqueue(7, own.kbId), { state: 'needs_sync', queued: false });
                DB.run('UPDATE onyx_native_runtime_document_links SET deployment_id=?,deployment_revision=3,business_id=7,onyx_document_id=?',
                    [deploymentId, `ava:7:knowledge:${own.kbId}`]);
            }
            DB.run("UPDATE ava_module_deployments SET state='disabled',revision=4 WHERE id=?", [deploymentId]);
            assert.equal(Native.status(7).documents[0].state, 'unavailable');
            assert.throws(() => Native.enqueue(7, own.kbId), { code:'ONYX_NATIVE_DEPLOYMENT_NOT_READY' });
            Native.remove(7, own.kbId);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM onyx_sync_outbox WHERE business_id=7').n, 0);
            assert.deepEqual(Native.snapshot(8, other.kbId), otherBefore);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM onyx_sync_outbox WHERE business_id=8').n, 1);
        });
    });
});
