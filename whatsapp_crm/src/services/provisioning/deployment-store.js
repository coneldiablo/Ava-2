'use strict';
const crypto = require('crypto');
const DB = require('../database.service');
const PINNED = Object.freeze({
    twenty: '6da524b8903ec16a3eeea4b2e4a5fb63dbfc1c58',
    onyx: 'a1b9e02eb65cc114c65381cbef5e555e1753ed0a',
});
const fail = code => Object.assign(new Error(code), { code, retryable: false });
const reservedSlugs = new Set(['www','admin','auth','api','support','mail','localhost']);
function worker() {
    if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') throw fail('DEPLOYMENT_WORKER_REQUIRED');
}
function business(id) {
    if (!Number.isSafeInteger(id) || id < 1 || !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1', [id])) throw fail('DEPLOYMENT_BUSINESS_INACTIVE');
}
function get(id, businessId) {
    const row = DB.get('SELECT * FROM ava_module_deployments WHERE id=? AND businessId=?', [id, businessId]);
    if (!row) throw fail('DEPLOYMENT_SCOPE_MISMATCH');
    return row;
}
function getWorkerDeployment({ deploymentId, businessId, expectedRevision }) {
    worker(); business(businessId);
    const row = get(deploymentId, businessId);
    if (!Number.isSafeInteger(expectedRevision) || row.revision !== expectedRevision) throw fail('DEPLOYMENT_REVISION_CHANGED');
    return row;
}

// Called inside the existing business-creation transaction, before any external
// side effect. Existing tenant deployments are never adopted or overwritten.
function requestForBusiness(businessId, name, modules = Object.keys(PINNED)) {
    if (!DB.db.inTransaction) throw fail('DEPLOYMENT_TRANSACTION_REQUIRED');
    business(businessId);
    if (!Array.isArray(modules) || modules.length < 1 || new Set(modules).size !== modules.length
        || modules.some(module => typeof module !== 'string' || !Object.prototype.hasOwnProperty.call(PINNED, module))) {
        throw fail('DEPLOYMENT_MODULE_SELECTION_INVALID');
    }
    let route = DB.get('SELECT slug FROM ava_business_routes WHERE businessId=?', [businessId]);
    if (!route) {
        const candidate = String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
        const base = candidate && !reservedSlugs.has(candidate) ? candidate : 'hotel';
        const slug = `${base}-${businessId}`;
        DB.run('INSERT INTO ava_business_routes(businessId,slug,createdAt) VALUES (?,?,?)', [businessId, slug, Date.now()]);
        route = { slug };
    }
    for (const module of modules) {
        if (DB.get('SELECT id FROM ava_module_deployments WHERE businessId=? AND module=?', [businessId, module])) continue;
        const id = crypto.randomUUID(), namespace = `ava_${id.replaceAll('-', '')}`;
        const hostname = `${route.slug}.${module === 'twenty' ? 'crm' : 'knowledge'}.meludtech.tech`;
        DB.run(`INSERT INTO ava_module_deployments(id,businessId,module,hostname,namespace,sourceCommit,correlationId,createdAt,updatedAt)
            VALUES (?,?,?,?,?,?,?,?,?)`, [id, businessId, module, hostname, namespace, PINNED[module], crypto.randomUUID(), Date.now(), Date.now()]);
    }
    return list(businessId);
}

function list(businessId) {
    return DB.all('SELECT * FROM ava_module_deployments WHERE businessId=? ORDER BY module', [businessId]).map(safe);
}
function safe(row) {
    return { business_id: row.businessId, module: row.module, deployment_id: row.id, hostname: row.hostname,
        revision: row.revision, state: row.state, last_verified_at: row.lastVerifiedAt,
        next_retry_at: row.nextRetryAt, error_code: row.lastErrorCode, correlation_id: row.correlationId,
        allowed_actions: [] };
}

// Capacity samples are obtained by the privileged helper, not browser input.
// Outstanding reservations are deducted until running containers have been
// observed in that sample, avoiding the two-worker oversubscription race.
function reserve({ deploymentId, businessId, expectedRevision, memoryMiB, capacity }) {
    worker();
    if (!Number.isSafeInteger(memoryMiB) || memoryMiB < 256 || memoryMiB > 16384
        || !capacity || !Number.isSafeInteger(capacity.totalMiB) || !Number.isSafeInteger(capacity.availableMiB)
        || capacity.totalMiB < 1024 || capacity.availableMiB < 0 || capacity.availableMiB > capacity.totalMiB
        || !Number.isSafeInteger(capacity.observedAt) || Date.now() - capacity.observedAt > 30000 || capacity.observedAt > Date.now()
        || !Array.isArray(capacity.runningDeploymentIds) || capacity.runningDeploymentIds.some(id => !/^[a-f0-9-]{36}$/.test(id))) throw fail('DEPLOYMENT_CAPACITY_SAMPLE_INVALID');
    return DB.db.transaction(() => {
        business(businessId);
        const row = get(deploymentId, businessId);
        if (row.revision !== expectedRevision || ['disabled','quarantined'].includes(row.state)) throw fail('DEPLOYMENT_REVISION_CHANGED');
        if (row.reservedMemoryMiB > 0 && row.reservedMemoryMiB !== memoryMiB) throw fail('DEPLOYMENT_RESERVATION_MEMORY_CHANGED');
        // A failed deployment has no public retry transition. Its reservation
        // stays charged until a separately fenced recovery/cleanup workflow.
        if (row.state === 'failed') return safe(row);
        if (['reserved','provisioning','verified'].includes(row.state)) return safe(row);
        const running = new Set(capacity.runningDeploymentIds);
        // Disabling a deployment does not prove its containers are gone. Keep
        // the capacity charged until a separately verified cleanup releases it.
        const reservations = DB.all('SELECT id,businessId,reservedMemoryMiB FROM ava_module_deployments WHERE reservedMemoryMiB>0');
        const businesses = new Set(reservations.map(item => item.businessId)); businesses.add(businessId);
        for (const legacy of DB.all(`SELECT i.id FROM instances i WHERE i.isActive=1 AND (
            EXISTS (SELECT 1 FROM twenty_workspace_links t WHERE t.businessId=i.id AND t.enabled=1 AND t.workspaceId IS NOT NULL)
            OR EXISTS (SELECT 1 FROM onyx_tenant_links o WHERE o.business_id=i.id AND o.status!='DISABLED'))`)) {
            businesses.add(legacy.id);
        }
        const unobserved = reservations.filter(item => !running.has(item.id)).reduce((n, item) => n + item.reservedMemoryMiB, 0);
        // Existing reservations, including this row on a retried capacity
        // check, are already part of `unobserved`; charge only a new claim.
        const incrementalMemoryMiB = row.reservedMemoryMiB > 0 ? 0 : memoryMiB;
        const fits = businesses.size <= 5 && capacity.availableMiB - unobserved - incrementalMemoryMiB >= Math.ceil(capacity.totalMiB * 0.2);
        DB.run(`UPDATE ava_module_deployments SET state=?,reservedMemoryMiB=?,lastErrorCode=?,updatedAt=? WHERE id=? AND revision=?`,
            [fits ? 'reserved' : 'capacity_required', fits ? (row.reservedMemoryMiB || memoryMiB) : row.reservedMemoryMiB,
                fits ? null : 'CAPACITY_REQUIRED', Date.now(), row.id, row.revision]);
        return safe(get(row.id, businessId));
    }).immediate();
}

function lease({ deploymentId, businessId, expectedRevision }) {
    worker();
    return DB.db.transaction(() => {
        business(businessId);
        const row = get(deploymentId, businessId), now = Date.now();
        if (row.revision !== expectedRevision) throw fail('DEPLOYMENT_REVISION_CHANGED');
        if (row.state === 'provisioning' && row.leasedUntil > now) return null;
        if (!['reserved','provisioning'].includes(row.state) || row.nextRetryAt > now) return null;
        if (row.attempts >= 8) {
            DB.run("UPDATE ava_module_deployments SET state='failed',lastErrorCode='DEPLOYMENT_ATTEMPTS_EXHAUSTED',leaseToken=NULL,leasedUntil=NULL WHERE id=?", [row.id]);
            return null;
        }
        const token = crypto.randomUUID();
        DB.run("UPDATE ava_module_deployments SET state='provisioning',leaseToken=?,leasedUntil=?,attempts=attempts+1,updatedAt=? WHERE id=?", [token, now + 60000, now, row.id]);
        return { ...get(row.id, businessId), requiresReconciliation: row.attempts > 0 };
    }).immediate();
}
function failAttempt(input, { code, retryable }) {
    worker();
    if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(code) || typeof retryable !== 'boolean') throw fail('DEPLOYMENT_FAILURE_CODE_INVALID');
    return DB.db.transaction(() => {
        const row = assertLease(input), now = Date.now();
        const retry = retryable && row.attempts < 8;
        const nextRetryAt = retry ? now + Math.min(3600000, 60000 * (2 ** (row.attempts - 1))) : null;
        const update = DB.run(`UPDATE ava_module_deployments SET state=?,nextRetryAt=?,lastErrorCode=?,leaseToken=NULL,leasedUntil=NULL,updatedAt=?
            WHERE id=? AND leaseToken=? AND revision=?`,
        [retry ? 'reserved' : 'failed', nextRetryAt, code, now, row.id, input.leaseToken, input.expectedRevision]);
        if (update.changes !== 1) throw fail('DEPLOYMENT_LEASE_LOST');
        return safe(get(row.id, row.businessId));
    }).immediate();
}
function assertLease(input) {
    business(input.businessId);
    const row = get(input.deploymentId, input.businessId);
    if (row.revision !== input.expectedRevision || row.state !== 'provisioning'
        || row.leaseToken !== input.leaseToken || row.leasedUntil <= Date.now()) throw fail('DEPLOYMENT_LEASE_LOST');
    return row;
}
function heartbeat(input) {
    worker();
    return DB.db.transaction(() => {
        const row = assertLease(input);
        DB.run('UPDATE ava_module_deployments SET leasedUntil=? WHERE id=? AND leaseToken=?', [Date.now() + 60000, row.id, input.leaseToken]);
        return true;
    }).immediate();
}
async function verify(input, readback) {
    worker();
    if (typeof readback !== 'function') throw fail('DEPLOYMENT_NATIVE_PROOF_REQUIRED');
    const initial = assertLease(input);
    const proof = await readback({ deploymentId: initial.id, businessId: initial.businessId, module: initial.module,
        namespace: initial.namespace, hostname: initial.hostname, sourceCommit: initial.sourceCommit, revision: initial.revision });
    return DB.db.transaction(() => {
        worker(); const row = assertLease(input);
        if (!proof || proof.deploymentId !== row.id || proof.businessId !== row.businessId || proof.revision !== row.revision || proof.module !== row.module
            || proof.namespace !== row.namespace || proof.hostname !== row.hostname || proof.sourceCommit !== row.sourceCommit
            || !/^sha256:[a-f0-9]{64}$/.test(proof.imageDigest || '')
            || proof.tlsVerified !== true || proof.nativeIdentityVerified !== true || proof.storageIsolationVerified !== true
            || proof.foreignAccessDenied !== true || proof.bootstrapExcludedFromRuntime !== true
            || !/^module\/[a-f0-9-]{36}\/runtime\/v[1-9][0-9]*$/.test(proof.secretReference || '')
            || !proof.secretReference.startsWith(`module/${row.id}/`)) throw fail('DEPLOYMENT_NATIVE_PROOF_INCOMPLETE');
        DB.run(`UPDATE ava_module_deployments SET state='verified',imageDigest=?,secretReference=?,lastVerifiedAt=?,
            lastErrorCode=NULL,leaseToken=NULL,leasedUntil=NULL,updatedAt=? WHERE id=? AND leaseToken=? AND revision=?`,
        [proof.imageDigest, proof.secretReference, Date.now(), Date.now(), row.id, input.leaseToken, input.expectedRevision]);
        return safe(get(row.id, row.businessId));
    }).immediate();
}
function disable({ deploymentId, businessId, expectedRevision }) {
    worker();
    return DB.db.transaction(() => {
        const row = get(deploymentId, businessId);
        if (row.revision !== expectedRevision) throw fail('DEPLOYMENT_REVISION_CHANGED');
        DB.run(`UPDATE ava_module_deployments SET state='disabled',revision=revision+1,lastVerifiedAt=NULL,
            leaseToken=NULL,leasedUntil=NULL,updatedAt=? WHERE id=? AND revision=?`, [Date.now(), row.id, expectedRevision]);
        // Namespace/data ownership is immutable. Disabled resources remain
        // reserved and are never returned to a warm pool for another business.
        return safe(get(row.id, businessId));
    }).immediate();
}
module.exports = { requestForBusiness, list, reserve, lease, heartbeat, failAttempt, getWorkerDeployment, verify, disable, PINNED };
