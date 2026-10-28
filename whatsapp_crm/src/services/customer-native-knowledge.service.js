'use strict';

const crypto = require('crypto');
const DB = require('./database.service');

const fail = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });

function scopedLink(link, businessId, documentId, hash) {
    try { return link?.content_hash === hash && typeof link.onyx_document_id === 'string'
        && decodeURIComponent(link.onyx_document_id) === `ava:${businessId}:knowledge:${documentId}`; }
    catch (_) { return false; }
}

function document(businessId, documentId) {
    const row = DB.get(`SELECT id, originalName, mimeType, isCurrent, contentHash FROM knowledge_base
        WHERE id=? AND instanceId=? AND isCurrent=1`, [documentId, businessId]);
    if (!row) throw fail('DOCUMENT_NOT_FOUND', 404);
    return row;
}

function snapshot(businessId, documentId) {
    const row = document(businessId, documentId);
    const chunks = DB.getDocumentChunks(businessId, documentId);
    const content = chunks.map(chunk => chunk.text).join('\n\n').trim();
    if (!content) throw fail('DOCUMENT_EMPTY');
    // Imported documents use the hash of their extracted text as the version
    // recorded in onyx_document_links. Chunk boundaries change that text, so
    // hashing the joined chunks here marks a correctly linked document stale.
    // Edits replace contentHash with the current chunk hash in database.service.
    const editHash = crypto.createHash('sha256').update(JSON.stringify([businessId, documentId,
        chunks.map(chunk => [chunk.id, chunk.text, chunk.section ?? null])])).digest('hex');
    return { row, chunks, content, editHash, hash: row.contentHash || crypto.createHash('sha256').update(content).digest('hex') };
}

function linkState(businessId) {
    const link = DB.get('SELECT status FROM onyx_tenant_links WHERE business_id=?', [businessId]);
    return link && ['STAGING', 'ACTIVE', 'ACTIVE_LIVE'].includes(link.status) ? link.status : null;
}

function nativeDeployment(businessId) {
    // The new native-only integration anchor has the immutable namespace as
    // its scope. Legacy hotel links must continue to use the legacy outbox.
    if (!DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ava_module_deployments'")) return null;
    return DB.get(`SELECT d.id,d.revision,d.state FROM ava_module_deployments d JOIN onyx_tenant_links t ON t.business_id=d.businessId
        WHERE d.businessId=? AND d.module='onyx'
        AND t.onyx_tenant_id=d.namespace AND t.status IN ('STAGING','ACTIVE','ACTIVE_LIVE')`, [businessId]) || null;
}

function nativeLink(businessId, documentId, deployment) {
    if (!DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='onyx_native_runtime_document_links'")) return null;
    return DB.get(`SELECT content_hash,onyx_document_id FROM onyx_native_runtime_document_links
        WHERE business_id=? AND entity_type='knowledge' AND source_id=?
        AND deployment_id=? AND deployment_revision=?`, [businessId, documentId, deployment.id, deployment.revision]);
}

function enqueue(businessId, documentId) {
    return DB.db.transaction(() => {
        // Serialize the lookup and insertion across CRM processes. A retry with
        // the same content must reuse the existing in-flight operation.
        if (!linkState(businessId)) throw fail('ONYX_NOT_CONFIGURED', 503);
        const native = nativeDeployment(businessId);
        if (native && native.state !== 'verified') throw fail('ONYX_NATIVE_DEPLOYMENT_NOT_READY', 503);
        let source;
        try { source = snapshot(businessId, documentId); }
        catch (error) {
            if (error.code !== 'DOCUMENT_EMPTY') throw error;
            if (native) return { state: 'empty', queued: false };
            // Deleting the last chunk revokes the indexed document as well.
            // The source record stays visible as empty; never ingest old text.
            if (DB.get(`SELECT event_id FROM onyx_sync_outbox WHERE business_id=?
                AND entity_type='knowledge' AND source_id=? AND status='PROCESSING' LIMIT 1`, [businessId, documentId])) {
                throw fail('DOCUMENT_SYNC_IN_PROGRESS');
            }
            DB.run(`UPDATE onyx_sync_outbox SET status='DEAD', last_error_code='DOCUMENT_EMPTY',
                updated_at=CURRENT_TIMESTAMP WHERE business_id=? AND entity_type='knowledge'
                AND source_id=? AND operation='UPSERT' AND status IN ('PENDING','RETRY')`, [businessId, documentId]);
            const linked = DB.get(`SELECT onyx_document_id FROM onyx_document_links
                WHERE business_id=? AND entity_type='knowledge' AND source_id=?`, [businessId, documentId]);
            const pending = DB.get(`SELECT event_id FROM onyx_sync_outbox WHERE business_id=?
                AND entity_type='knowledge' AND source_id=? AND operation='DELETE'
                AND status IN ('PENDING','RETRY') LIMIT 1`, [businessId, documentId]);
            if (linked && !pending) DB.run(`INSERT INTO onyx_sync_outbox
                (event_id,business_id,entity_type,source_id,operation,payload_json,status,next_attempt_at)
                VALUES (?,?,'knowledge',?,'DELETE',?,'PENDING',CURRENT_TIMESTAMP)`,
            [crypto.randomUUID(), businessId, documentId, JSON.stringify({ external_id: `ava:${businessId}:knowledge:${documentId}` })]);
            return { state: 'empty', queued: Boolean(linked && !pending) };
        }
        const { row, content, hash } = source;
        if (native) {
            // The privileged native reconciler reads these durably saved
            // sources and handles writes/deletes with its private worker key.
            // Do not send native-only anchors through the legacy API-key path.
            return { state: scopedLink(nativeLink(businessId, documentId, native), businessId, documentId, hash)
                ? 'submitted' : 'needs_sync', queued: false };
        }
        const synced = DB.get(`SELECT content_hash,onyx_document_id FROM onyx_document_links
        WHERE business_id=? AND entity_type='knowledge' AND source_id=?`, [businessId, documentId]);
        if (scopedLink(synced, businessId, documentId, hash)) return { state: 'submitted', queued: false };
        const pending = DB.get(`SELECT event_id FROM onyx_sync_outbox
        WHERE business_id=? AND entity_type='knowledge' AND source_id=?
          AND operation='UPSERT' AND status IN ('PENDING','RETRY','PROCESSING')
          AND json_extract(payload_json, '$.content_hash')=? LIMIT 1`, [businessId, documentId, hash]);
        if (pending) return { state: 'processing', queued: false };
        const inFlight = DB.get(`SELECT event_id FROM onyx_sync_outbox
            WHERE business_id=? AND entity_type='knowledge' AND source_id=?
              AND operation='UPSERT' AND status='PROCESSING' LIMIT 1`, [businessId, documentId]);
        if (inFlight) throw fail('DOCUMENT_SYNC_IN_PROGRESS');
        DB.run(`UPDATE onyx_sync_outbox SET status='DEAD', last_error_code='SUPERSEDED_BY_EDIT',
            updated_at=CURRENT_TIMESTAMP WHERE business_id=? AND entity_type='knowledge'
            AND source_id=? AND operation='UPSERT' AND status IN ('PENDING','RETRY')`, [businessId, documentId]);
        DB.run(`INSERT INTO onyx_sync_outbox
        (event_id,business_id,entity_type,source_id,operation,payload_json,status,next_attempt_at)
        VALUES (?,?, 'knowledge',?,'UPSERT',?,'PENDING',CURRENT_TIMESTAMP)`, [
        crypto.randomUUID(), businessId, documentId, JSON.stringify({
            external_id: `ava:${businessId}:knowledge:${documentId}`,
            title: row.originalName, content, content_hash: hash,
            source_url: `/hotels/${businessId}/knowledge-base`,
        }),
        ]);
        return { state: 'processing', queued: true };
    }).immediate();
}

function status(businessId) {
    const link = linkState(businessId);
    const native = nativeDeployment(businessId);
    const rows = DB.all(`SELECT id FROM knowledge_base WHERE instanceId=? AND isCurrent=1 ORDER BY id`, [businessId]);
    const documents = rows.map(({ id }) => {
        const item = { id, state: 'unavailable' };
        if (!link) return item;
        if (native && native.state !== 'verified') return item;
        let hash;
        try { hash = snapshot(businessId, id).hash; }
        catch (_) { return { id, state: 'empty' }; }
        const synced = native ? nativeLink(businessId, id, native) : DB.get(`SELECT content_hash,onyx_document_id,last_synced_at FROM onyx_document_links
            WHERE business_id=? AND entity_type='knowledge' AND source_id=?`, [businessId, id]);
        if (scopedLink(synced, businessId, id, hash)) return { id, state: 'submitted', submittedAt: synced.last_synced_at };
        if (native) return { id, state: 'needs_sync' };
        const latest = DB.get(`SELECT status,last_error_code FROM onyx_sync_outbox
            WHERE business_id=? AND entity_type='knowledge' AND source_id=? AND operation='UPSERT'
            ORDER BY id DESC LIMIT 1`, [businessId, id]);
        return { id, state: ['PENDING','RETRY','PROCESSING'].includes(latest?.status) ? 'processing'
            : latest?.status === 'DEAD' ? 'failed' : 'needs_sync' };
    });
    return { businessId, onyx: link ? 'configured' : 'unavailable', documents };
}

function remove(businessId, documentId) {
    return DB.db.transaction(() => {
        const row = document(businessId, documentId);
        const native = nativeDeployment(businessId);
        const inFlight = DB.get(`SELECT event_id FROM onyx_sync_outbox
            WHERE business_id=? AND entity_type='knowledge' AND source_id=? AND status='PROCESSING' LIMIT 1`,
        [businessId, documentId]);
        if (inFlight) throw fail('DOCUMENT_SYNC_IN_PROGRESS');
        const linked = DB.get(`SELECT onyx_document_id FROM onyx_document_links
            WHERE business_id=? AND entity_type='knowledge' AND source_id=?`, [businessId, documentId]);
        if (linked && !linkState(businessId)) throw fail('ONYX_NOT_CONFIGURED', 503);
        DB.run(`UPDATE onyx_sync_outbox SET status='DEAD', last_error_code='DOCUMENT_DELETED',
            updated_at=CURRENT_TIMESTAMP WHERE business_id=? AND entity_type='knowledge'
            AND source_id=? AND status IN ('PENDING','RETRY')`, [businessId, documentId]);
        if (linked && !native) DB.run(`INSERT INTO onyx_sync_outbox
            (event_id,business_id,entity_type,source_id,operation,payload_json,status,next_attempt_at)
            VALUES (?,?,'knowledge',?,'DELETE',?,'PENDING',CURRENT_TIMESTAMP)`, [
            crypto.randomUUID(), businessId, documentId,
            JSON.stringify({ external_id: `ava:${businessId}:knowledge:${documentId}` }),
        ]);
        try {
            DB.run(`DELETE FROM kb_chunks_vec WHERE chunkId IN
                (SELECT id FROM kb_chunks WHERE kbId=?)`, [documentId]);
        } catch (_) { /* Older deployments may not have a vector table. */ }
        DB.run('DELETE FROM knowledge_base WHERE id=? AND instanceId=?', [documentId, businessId]);
        const previous = DB.get(`SELECT id FROM knowledge_base WHERE instanceId=? AND originalName=?
            ORDER BY version DESC, createdAt DESC LIMIT 1`, [businessId, row.originalName]);
        if (previous) DB.run(`UPDATE knowledge_base SET isCurrent=CASE WHEN id=? THEN 1 ELSE 0 END
            WHERE instanceId=? AND originalName=?`, [previous.id, businessId, row.originalName]);
        return { deleted: 1 };
    }).immediate();
}

async function updateChunk(businessId, documentId, chunkId, input, { beforeWrite = () => {} } = {}) {
    const RAG = require('./rag.service');
    const refreshStats = () => {
        try { RAG._recalculateStats(businessId, documentId); }
        catch (error) {
            // Optional vector support may be unavailable while text/FTS and
            // the external index remain usable. Never roll back an owner edit
            // merely to initialize a missing vector extension for statistics.
            if (!/no such module: vec0|no such table: kb_chunks_(?:gemini|vec)/.test(error.message || '')) throw error;
            DB.updateKnowledgeBaseStats(documentId, DB.getDocumentChunks(businessId, documentId).length, false);
        }
    };
    const saved = DB.db.transaction(() => {
        beforeWrite();
        const source = snapshot(businessId, documentId);
        if (input.expectedHash !== undefined && input.expectedHash !== source.editHash) throw fail('DOCUMENT_REVISION_CONFLICT');
        const chunk = DB.getChunkById(businessId, chunkId);
        if (!chunk || chunk.kbId !== documentId) throw fail('CHUNK_NOT_FOUND', 404);
        // Refuse before saving: a worker already sending old text cannot be
        // atomically superseded. The owner can retry once that sync finishes.
        if (DB.get(`SELECT 1 FROM onyx_sync_outbox WHERE business_id=? AND entity_type='knowledge'
            AND source_id=? AND status='PROCESSING' LIMIT 1`, [businessId, documentId])) throw fail('DOCUMENT_SYNC_IN_PROGRESS');
        const updated = DB.updateChunkContent(businessId, chunkId, input.text, input.section);
        if (DB.get("SELECT 1 FROM sqlite_master WHERE name='kb_chunks_vec'")) DB.run('DELETE FROM kb_chunks_vec WHERE chunkId=?', [chunkId]);
        const hash = snapshot(businessId, documentId).editHash;
        // Text, FTS/hash, old-vector invalidation and durable sync are one write.
        const sync = RAG._queueNativeKnowledge(businessId, documentId);
        refreshStats();
        return { chunk: updated, hash, sync };
    }).immediate();
    let generated;
    try { [generated] = await RAG.generateEmbeddings([{ id: chunkId, kbId: documentId, text: input.text, section: input.section }], businessId); }
    catch (_) { /* The saved source and outbox remain usable without embeddings. */ }
    return DB.db.transaction(() => {
        beforeWrite();
        // A second edit/delete during embedding must not restore an old vector.
        const current = snapshot(businessId, documentId);
        if (current.editHash !== saved.hash) throw fail('DOCUMENT_REVISION_CONFLICT');
        if (generated?.embedding) {
            if (generated.embeddingProvider === 'gemini') require('./gemini-embeddings.service').store(generated, businessId);
            else DB.addChunkToVectorTable(chunkId, documentId, businessId, generated.embedding, saved.chunk.originalName);
        }
        refreshStats();
        return { hash: current.editHash, sourceHash: current.hash, chunk: { id: chunkId, text: input.text, section: input.section }, sync: saved.sync };
    }).immediate();
}

module.exports = { snapshot, enqueue, status, remove, updateChunk };
