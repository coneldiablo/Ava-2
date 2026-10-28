'use strict';
const Client = require('./module-deployment-client');
// Conservative whole-contour budgets, not observed idle RSS.
const BUDGET = Object.freeze({ twenty: 4352, onyx: 12800 });
const fail = (code, retryable = true) => Object.assign(new Error(code), { code, retryable });
const identityKeys = ['deploymentId', 'businessId', 'module', 'revision', 'hostname', 'namespace', 'sourceCommit'];

function sameDeployment(response, row) {
    const expected = { ...row, deploymentId: row.id };
    if (!response || identityKeys.some(key => response[key] !== expected[key])
        || !['absent', 'prepared', 'running', 'degraded'].includes(response.state)) {
        throw fail('DEPLOYMENT_HELPER_PROTOCOL_INVALID', false);
    }
    return response;
}
function awaitingVerification(row) {
    return {
        status: 'BLOCKED', stage: 'requires_verification', errorCode: 'NATIVE_BUSINESS_VERIFICATION_REQUIRED',
        checkpoint: { deploymentId: row.id, deploymentRevision: row.revision, infrastructureVerified: true },
        userNextStep: 'Кабинет подготовлен; AVA проверяет права, данные и синхронизацию',
    };
}
class IsolatedModuleProvisioner {
    constructor({ store, client, access, knowledgeOverlay = false, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
        this.store = store || require('./deployment-store');
        this.client = client || new Client();
        this.access = access || require('../identity/module-access-store');
        this.setIntervalFn = setIntervalFn;
        this.clearIntervalFn = clearIntervalFn;
        this.knowledgeOverlay = knowledgeOverlay === true;
    }
    finishInfrastructure(row) {
        const result = awaitingVerification(row);
        try {
            const adapter = this.access.activateDeployment({ deploymentId: row.id, businessId: row.businessId, expectedRevision: row.revision });
            result.checkpoint.moduleAdapterId = adapter.id;
            result.checkpoint.moduleAdapterRevision = adapter.revision;
        } catch (error) {
            // Missing CRM/knowledge synchronization is a business-level gate,
            // not a reason to re-create healthy infrastructure or rotate peers.
            const safe = new Set(['MODULE_INTEGRATION_UNAVAILABLE', 'MODULE_ENROLLMENT_CHANGED',
                'MODULE_EXISTING_ADAPTER_MIGRATION_REQUIRED', 'MODULE_DEPLOYMENT_NOT_VERIFIED']);
            if (!safe.has(error.code)) throw error;
            result.checkpoint.accessErrorCode = error.code;
        }
        // Membership readback, native data sync and browser acceptance still
        // follow; activating a peer alone must never return READY.
        return result;
    }
    async run(job, module) {
        if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') throw fail('DEPLOYMENT_WORKER_REQUIRED', false);
        if (process.env.AVA_ISOLATED_MODULES_ENABLED !== 'true') throw fail('DEPLOYMENT_FEATURE_DISABLED', false);
        if (!process.env.AVA_MODULE_DEPLOYMENT_SOCKET) throw fail('DEPLOYMENT_HELPER_UNAVAILABLE', false);
        const listed = this.store.list(job.businessId).find(value => value.module === module);
        if (!listed) throw fail('DEPLOYMENT_SCOPE_MISMATCH', false);
        const scope = { deploymentId: listed.deployment_id, businessId: job.businessId, expectedRevision: listed.revision };
        const row = this.store.getWorkerDeployment(scope);
        const budget = module === 'onyx' && this.knowledgeOverlay ? 13824 : BUDGET[module];
        if (!budget) throw fail('DEPLOYMENT_MODULE_UNSUPPORTED', false);
        if (row.state === 'verified') return this.finishInfrastructure(row);
        if (['disabled', 'quarantined', 'failed'].includes(row.state)) throw fail(row.lastErrorCode || 'DEPLOYMENT_NOT_ELIGIBLE', false);
        if (row.nextRetryAt > Date.now()) throw Object.assign(fail('DEPLOYMENT_RETRY_NOT_DUE'), { nextRetryAt: row.nextRetryAt });
        const reserved = this.store.reserve({ ...scope, memoryMiB: budget, capacity: await this.client.capacity() });
        if (reserved.state === 'capacity_required') return {
            status: 'BLOCKED', stage: 'capacity_required', errorCode: 'CAPACITY_REQUIRED',
            checkpoint: { deploymentId: row.id, deploymentRevision: row.revision },
            userNextStep: 'Для отдельного кабинета требуется больше свободной памяти сервера',
        };
        const lease = this.store.lease(scope);
        if (!lease) throw Object.assign(fail('DEPLOYMENT_LEASE_UNAVAILABLE'), {
            nextRetryAt: Math.max(Date.now() + 60000, Number(row.leasedUntil) || 0, Number(row.nextRetryAt) || 0),
        });
        // Wire contract excludes expectedRevision, a local store-only field.
        const wire = { deploymentId: lease.id, businessId: lease.businessId, revision: lease.revision, leaseToken: lease.leaseToken };
        const local = { ...scope, leaseToken: lease.leaseToken };
        let lost = false;
        const checkLease = () => {
            if (lost) throw fail('DEPLOYMENT_LEASE_LOST', false);
            this.store.heartbeat(local);
        };
        const heartbeat = this.setIntervalFn(() => {
            try { this.store.heartbeat(local); } catch (_) { lost = true; }
        }, 15000);
        heartbeat?.unref?.();
        try {
            const reconciled = sameDeployment(await this.client.reconcile(wire), lease);
            checkLease();
            if (['absent', 'prepared', 'degraded'].includes(reconciled.state)) {
                const launched = sameDeployment(await this.client.provision(wire), lease);
                checkLease();
                if (launched.state !== 'running') throw fail('DEPLOYMENT_NOT_RUNNING');
            }
            const enrollment = await this.client.enrollment(wire);
            checkLease();
            this.access.prepareDeployment(wire, enrollment);
            await this.store.verify(local, () => this.client.verify(wire));
            return this.finishInfrastructure(lease);
        } catch (error) {
            const safe = fail(Client.safeErrorCode(error.code), error.retryable !== false);
            const requiresSetup = ['DEPLOYMENT_RECIPE_REQUIRED', 'DEPLOYMENT_NATIVE_VERIFIER_REQUIRED', 'DEPLOYMENT_GATEWAY_REQUIRED'].includes(safe.code);
            try {
                // Parent job is BLOCKED for missing release configuration, not
                // auto-polled. Keep its deployment resumable for an authorized
                // retry after setup; do not reset the lifetime attempt count.
                const failed = this.store.failAttempt(local, { code: safe.code, retryable: requiresSetup || safe.retryable });
                safe.nextRetryAt = failed.next_retry_at;
                safe.retryable = !requiresSetup && failed.state === 'reserved';
            } catch (fence) {
                throw fail(Client.safeErrorCode(fence.code), false);
            }
            throw safe;
        } finally { this.clearIntervalFn(heartbeat); }
    }
}
module.exports = IsolatedModuleProvisioner;
