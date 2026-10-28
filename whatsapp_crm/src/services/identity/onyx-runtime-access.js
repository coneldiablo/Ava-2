'use strict';

// Machine identity for the AVA -> isolated Onyx gateway.  This is deliberately
// independent of the browser/UI adapter flow: a healthy container, a tenant
// link, or an old peer credential is never an admission decision.
const crypto = require('crypto');
const DB = require('../database.service');
const ModuleAccess = require('./module-access-store');

const initialized = new WeakSet();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (code, statusCode = 403) => Object.assign(new Error(code), { code, statusCode });

function schema() {
    if (initialized.has(DB.db)) return;
    DB.db.exec(`
        CREATE TABLE IF NOT EXISTS ava_onyx_runtime_principals (
            id TEXT PRIMARY KEY,
            businessId INTEGER NOT NULL UNIQUE REFERENCES instances(id),
            adapterId TEXT NOT NULL UNIQUE REFERENCES ava_module_adapters(id),
            adapterRevision INTEGER NOT NULL,
            deploymentId TEXT NOT NULL,
            deploymentRevision INTEGER NOT NULL,
            integrationRevision INTEGER NOT NULL,
            nativeScope TEXT NOT NULL,
            servicePrincipalId TEXT NOT NULL UNIQUE,
            subject TEXT NOT NULL UNIQUE,
            nativeUserId TEXT NOT NULL UNIQUE,
            admittedAt INTEGER NOT NULL,
            revokedAt INTEGER
        );
        CREATE INDEX IF NOT EXISTS ava_onyx_runtime_principals_adapter
            ON ava_onyx_runtime_principals(adapterId, revokedAt);
    `);
    initialized.add(DB.db);
}

function workerOnly() {
    if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') throw fail('ONYX_RUNTIME_WORKER_REQUIRED');
}

function exactKeys(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

// The module-access store remains the one place that understands an adapter's
// peer secret, active business, integration, deployment and attachment mode.
// Do not replace this with a raw adapter query: that would silently bypass its
// revision and disable checks.
function accessApi() {
    const authenticatePeer = ModuleAccess.authenticatePeer || ModuleAccess.peer;
    const getCurrentAdapter = ModuleAccess.getCurrentAdapter || ModuleAccess.currentAdapter;
    if (typeof authenticatePeer !== 'function' || typeof getCurrentAdapter !== 'function') {
        throw fail('ONYX_RUNTIME_ACCESS_STORE_UNAVAILABLE', 503);
    }
    return { authenticatePeer, getCurrentAdapter };
}

function currentAdapter(adapterId) {
    if (typeof adapterId !== 'string' || !UUID.test(adapterId)) throw fail('ONYX_RUNTIME_ADAPTER_INVALID');
    const adapter = accessApi().getCurrentAdapter(adapterId);
    if (!adapter || adapter.id !== adapterId || adapter.module !== 'onyx'
        || adapter.attachmentMode !== 'isolated_workspace_ui'
        || !Number.isSafeInteger(adapter.businessId) || adapter.businessId < 1
        || !Number.isSafeInteger(adapter.revision) || adapter.revision < 1
        || !UUID.test(adapter.deploymentId || '') || !Number.isSafeInteger(adapter.deploymentRevision) || adapter.deploymentRevision < 1
        || !Number.isSafeInteger(adapter.integrationRevision) || adapter.integrationRevision < 1
        || typeof adapter.nativeScope !== 'string' || adapter.nativeScope.length < 1) {
        throw fail('ONYX_RUNTIME_CONFIGURATION_CHANGED');
    }
    return adapter;
}

function sameBinding(adapter, row) {
    return row && row.adapterId === adapter.id && row.businessId === adapter.businessId
        && row.adapterRevision === adapter.revision && row.deploymentId === adapter.deploymentId
        && row.deploymentRevision === adapter.deploymentRevision
        && row.integrationRevision === adapter.integrationRevision && row.nativeScope === adapter.nativeScope;
}

function sameAdapter(first, second) {
    return first && second && first.id === second.id && first.businessId === second.businessId
        && first.revision === second.revision && first.deploymentId === second.deploymentId
        && first.deploymentRevision === second.deploymentRevision
        && first.integrationRevision === second.integrationRevision && first.nativeScope === second.nativeScope;
}

function uuidV5(namespaceId, name) {
    const bytes = crypto.createHash('sha1')
        .update(Buffer.from(namespaceId.replaceAll('-', ''), 'hex'))
        .update(name, 'utf8').digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function principalFor(adapter, existing) {
    if (existing) return existing;
    // Retry of failed readback must not create a growing set of native users.
    const servicePrincipalId = uuidV5(adapter.deploymentId, `ava-runtime-principal:${adapter.businessId}`);
    // Match the pinned native Config.native_user_id UUIDv5 contract exactly.
    const nativeUserId = uuidV5(adapter.deploymentId, `ava-user:${servicePrincipalId}`);
    // Neither browser input nor a model response participates in these names.
    return {
        id: crypto.randomUUID(),
        businessId: adapter.businessId,
        adapterId: adapter.id,
        servicePrincipalId,
        subject: `ava-onyx-runtime:${adapter.businessId}`,
        nativeUserId,
        nativeScope: adapter.nativeScope,
    };
}

// Read-only candidate for worker bootstrap; admission still requires native
// readback proof before persisting an active principal.
function candidate(input) {
    workerOnly(); schema();
    if (!exactKeys(input, ['adapterId'])) throw fail('ONYX_RUNTIME_CANDIDATE_INVALID', 400);
    const adapter = currentAdapter(input.adapterId);
    const existing = DB.get('SELECT * FROM ava_onyx_runtime_principals WHERE businessId=?', [adapter.businessId]);
    if (existing && existing.adapterId !== adapter.id) throw fail('ONYX_RUNTIME_CONFIGURATION_CHANGED');
    return safePrincipal(principalFor(adapter, existing));
}

function proofMatches(proof, adapter, principal) {
    return proof && proof.adapterId === adapter.id && proof.adapterRevision === adapter.revision
        && proof.businessId === adapter.businessId && proof.deploymentId === adapter.deploymentId
        && proof.deploymentRevision === adapter.deploymentRevision
        && proof.integrationRevision === adapter.integrationRevision && proof.nativeScope === adapter.nativeScope
        && proof.servicePrincipalId === principal.servicePrincipalId && proof.subject === principal.subject
        && proof.nativeUserId === principal.nativeUserId && proof.ownAccess === true
        && proof.foreignAccessDenied === true && proof.sourceKnowledgeVerified === true;
}

function safePrincipal(row) {
    return {
        servicePrincipalId: row.servicePrincipalId,
        subject: row.subject,
        nativeUserId: row.nativeUserId,
        businessId: row.businessId,
        nativeScope: row.nativeScope,
    };
}

/**
 * Worker-only admission. readback is an in-process native Onyx check, not a
 * request payload. It must prove both this tenant's source knowledge access
 * and denial of a foreign tenant before the machine principal is persisted.
 */
async function admit(input) {
    workerOnly(); schema();
    if (!exactKeys(input, ['adapterId', 'readback']) || typeof input.readback !== 'function') {
        throw fail('ONYX_RUNTIME_ADMISSION_INVALID', 400);
    }
    const { adapterId, readback } = input;
    const initial = currentAdapter(adapterId);
    const existing = DB.get('SELECT * FROM ava_onyx_runtime_principals WHERE businessId=?', [initial.businessId]);
    if (existing && existing.adapterId !== initial.id) throw fail('ONYX_RUNTIME_CONFIGURATION_CHANGED');
    const candidate = principalFor(initial, existing);
    const pendingProof = readback({
        adapterId: initial.id,
        adapterRevision: initial.revision,
        businessId: initial.businessId,
        deploymentId: initial.deploymentId,
        deploymentRevision: initial.deploymentRevision,
        integrationRevision: initial.integrationRevision,
        nativeScope: initial.nativeScope,
        servicePrincipalId: candidate.servicePrincipalId,
        subject: candidate.subject,
        nativeUserId: candidate.nativeUserId,
    });
    if (!pendingProof || typeof pendingProof.then !== 'function') throw fail('ONYX_RUNTIME_READBACK_REQUIRED', 503);
    const proof = await pendingProof;
    return DB.db.transaction(() => {
        workerOnly();
        // Re-read after the asynchronous native probe. This prevents granting
        // a principal for a deployment, tenant or business that changed while
        // the readback was in flight.
        const current = currentAdapter(adapterId);
        if (!sameAdapter(initial, current)) {
            throw fail('ONYX_RUNTIME_CONFIGURATION_CHANGED');
        }
        if (!proofMatches(proof, current, candidate)) throw fail('ONYX_RUNTIME_PROOF_INCOMPLETE');
        const latest = DB.get('SELECT * FROM ava_onyx_runtime_principals WHERE businessId=?', [current.businessId]);
        if (latest && (latest.adapterId !== current.id || latest.servicePrincipalId !== candidate.servicePrincipalId
            || latest.subject !== candidate.subject || latest.nativeUserId !== candidate.nativeUserId)) {
            throw fail('ONYX_RUNTIME_ADMISSION_RACE', 409);
        }
        const now = Date.now();
        if (latest) {
            DB.run(`UPDATE ava_onyx_runtime_principals SET adapterRevision=?,deploymentId=?,deploymentRevision=?,
                integrationRevision=?,nativeScope=?,admittedAt=?,revokedAt=NULL WHERE businessId=?`,
            [current.revision, current.deploymentId, current.deploymentRevision, current.integrationRevision,
                current.nativeScope, now, current.businessId]);
        } else {
            DB.run(`INSERT INTO ava_onyx_runtime_principals(id,businessId,adapterId,adapterRevision,deploymentId,
                deploymentRevision,integrationRevision,nativeScope,servicePrincipalId,subject,nativeUserId,admittedAt)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [candidate.id, current.businessId, current.id, current.revision, current.deploymentId,
                current.deploymentRevision, current.integrationRevision, current.nativeScope,
                candidate.servicePrincipalId, candidate.subject, candidate.nativeUserId, now]);
        }
        return safePrincipal(DB.get('SELECT * FROM ava_onyx_runtime_principals WHERE businessId=?', [current.businessId]));
    }).immediate();
}

// The gateway calls this for every machine request. No memory cache is used:
// disabled businesses/adapters and changed revisions are denied immediately.
function authorize(input) {
    schema();
    if (!exactKeys(input, ['adapterId', 'peerSecret'])) throw fail('ONYX_RUNTIME_AUTHORIZATION_INVALID', 400);
    const { adapterId, peerSecret } = input;
    const authenticated = accessApi().authenticatePeer(adapterId, peerSecret);
    const adapter = currentAdapter(adapterId);
    if (!sameAdapter(authenticated, adapter)) {
        throw fail('ONYX_RUNTIME_CONFIGURATION_CHANGED');
    }
    const row = DB.get('SELECT * FROM ava_onyx_runtime_principals WHERE adapterId=? AND revokedAt IS NULL', [adapter.id]);
    if (!sameBinding(adapter, row)) throw fail('ONYX_RUNTIME_NOT_ADMITTED');
    return safePrincipal(row);
}

// Revocation is worker-only; it deliberately needs no peer secret and does
// not return principal details. A disabled adapter will also deny even if a
// worker has not yet reached this cleanup step.
function revoke(input) {
    workerOnly(); schema();
    if (!exactKeys(input, ['adapterId']) || typeof input.adapterId !== 'string' || !UUID.test(input.adapterId)) {
        throw fail('ONYX_RUNTIME_REVOCATION_INVALID', 400);
    }
    const { adapterId } = input;
    const changed = DB.run('UPDATE ava_onyx_runtime_principals SET revokedAt=COALESCE(revokedAt,?) WHERE adapterId=?',
        [Date.now(), adapterId]);
    return { revoked: changed.changes === 1 };
}

module.exports = { authorize, admit, candidate, revoke };
