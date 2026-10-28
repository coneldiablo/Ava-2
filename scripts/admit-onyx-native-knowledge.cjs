#!/usr/bin/env node
'use strict';
// Run only in the provisioning-worker release environment after the actual
// bootstrap/retrieval CLI. It grants no principal from browser/request input.
const fs = require('node:fs');
const path = require('node:path');
const fail = () => { throw new Error('ONYX_NATIVE_ADMISSION_FAILED'); };
function readProof(filename) {
    if (!path.isAbsolute(filename)) fail();
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const meta = fs.fstatSync(fd);
        if (!meta.isFile() || meta.uid !== 0 || (meta.mode & 0o077) || meta.size > 131072) fail();
        const proof = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (!proof || typeof proof !== 'object' || Array.isArray(proof)) fail();
        return proof;
    } finally { fs.closeSync(fd); }
}
function currentSources(db, businessId) {
    const columns = db.prepare('PRAGMA table_info(knowledge_base)').all().map(row => row.name);
    const guard = columns.includes('business_id') ? ' AND (business_id IS NULL OR business_id=instanceId)' : '';
    const docs = db.prepare(`SELECT id,contentHash,version FROM knowledge_base WHERE instanceId=? AND isCurrent=1${guard}`).all(businessId);
    const result = {};
    for (const doc of docs) {
        const chunks = db.prepare('SELECT text FROM kb_chunks WHERE kbId=? ORDER BY chunkIndex,id').all(doc.id);
        if (!chunks.map(row => row.text || '').join('\n\n').trim()) continue;
        if (!/^(?:[0-9a-f]{32}|[0-9a-f]{64})$/.test(doc.contentHash || '') || !Number.isSafeInteger(doc.version) || doc.version < 1) fail();
        result[`ava:${businessId}:knowledge:${doc.id}`] = { source_id: String(doc.id), revision: doc.version, content_hash: doc.contentHash };
    }
    return result;
}
function matchesSources(left, right) {
    if (!right || Object.keys(left).sort().join(',') !== Object.keys(right).sort().join(',')) return false;
    return Object.keys(left).every(key => Object.keys(right[key] || {}).sort().join(',') === 'content_hash,revision,source_id'
        && Object.keys(left[key]).every(field => left[key][field] === right[key][field]));
}
function matchesIndexSources(sources, indexed) {
    if (!indexed || typeof indexed !== 'object' || Array.isArray(indexed)
        || Object.keys(sources).sort().join(',') !== Object.keys(indexed).sort().join(',')) return false;
    return Object.keys(sources).every(key => Object.keys(indexed[key] || {}).sort().join(',') === 'content_hash,onyx_document_id,source_id'
        && indexed[key].onyx_document_id === encodeURIComponent(key)
        && indexed[key].source_id === sources[key].source_id && indexed[key].content_hash === sources[key].content_hash);
}
function validateReadback(proof, request, candidate, sources, now = Date.now()) {
    if (!/^[0-9a-f]{64}$/.test(proof.peerSecretHash || '') || typeof proof.integrationId !== 'string' || !proof.integrationId
        || !Number.isSafeInteger(proof.checkedAt) || now < proof.checkedAt || now - proof.checkedAt > 60000
        || !['adapterId','adapterRevision','businessId','deploymentId','deploymentRevision','integrationRevision',
            'nativeScope','servicePrincipalId','subject','nativeUserId'].every(key => proof[key] === request[key])
        || proof.revision !== request.deploymentRevision || proof.servicePrincipalId !== candidate.servicePrincipalId
        || proof.peerSecretHash !== candidate.peerSecretHash || proof.integrationId !== candidate.integrationId
        || !['ownAccess', 'foreignAccessDenied', 'sourceKnowledgeVerified', 'cleanupVerified'].every(key => proof[key] === true)
        || proof.indexReadinessVerified !== true || proof.indexProbeMethod !== 'default_document_index_random_acl_v1'
        || !matchesIndexSources(sources, proof.indexedDocuments)
        || !matchesSources(sources, proof.documents)) fail();
    return proof;
}
async function main() {
    if (process.getuid?.() !== 0 || process.env.AVA_PROCESS_ROLE !== 'provisioning-worker' || process.argv.slice(2).join(',') !== '--run') fail();
    const DB = require('../whatsapp_crm/src/services/database.service');
    const Runtime = require('../whatsapp_crm/src/services/identity/onyx-runtime-access');
    const Access = require('../whatsapp_crm/src/services/identity/module-access-store');
    const Database = require('../whatsapp_crm/node_modules/better-sqlite3');
    DB.db = new Database(process.env.AVA_CRM_DB_PATH, { fileMustExist: true });
    try {
        const filename = process.env.AVA_ONYX_RUNTIME_READBACK_FILE;
        const initial = readProof(filename);
        const row = DB.db.prepare("SELECT id FROM ava_module_adapters WHERE businessId=? AND module='onyx' AND enabled=1").get(initial.businessId);
        if (!row) fail();
        const candidate = Runtime.candidate({ adapterId: row.id });
        await Runtime.admit({ adapterId: row.id, readback: async request => {
            const proof = readProof(filename);
            const current = Access.getCurrentAdapter(row.id);
            return validateReadback(proof, request, { ...candidate, peerSecretHash: current.peerSecretHash,
                integrationId: current.integrationId }, currentSources(DB.db, request.businessId));
        } });
        process.stdout.write(JSON.stringify({ businessId: initial.businessId, runtimeAdmitted: true }) + '\n');
    } finally { DB.db.close(); }
}
if (require.main === module) main().catch(() => { process.stderr.write('ONYX_NATIVE_ADMISSION_FAILED\n'); process.exitCode = 1; });
module.exports = { matchesSources, matchesIndexSources, currentSources, readProof, validateReadback };
