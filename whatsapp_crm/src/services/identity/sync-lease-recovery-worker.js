'use strict';

const Access = require('./module-access-store');
const ModuleDeploymentClient = require('../provisioning/module-deployment-client');

const safeCode = error => /^(?:MODULE_SYNC_RECOVERY|DEPLOYMENT_|SYNC_RECOVERY_)[A-Z0-9_]{2,80}$/.test(error?.code || '')
    ? error.code : 'DEPLOYMENT_HELPER_FAILED';

// Disabled by default. This is a private provisioning-worker loop: the proof
// is accepted only from the root-owned Unix helper response in this call, and
// is never exposed as a broker/browser input.
async function processOne({ store = Access, client = new ModuleDeploymentClient() } = {}) {
    if (process.env.AVA_PROCESS_ROLE !== 'provisioning-worker') {
        throw Object.assign(new Error('MODULE_WORKER_REQUIRED'), { code: 'MODULE_WORKER_REQUIRED' });
    }
    if (process.env.AVA_TWENTY_SYNC_RECOVERY_ENABLED !== 'true') {
        return { processed: false, reason: 'MODULE_SYNC_RECOVERY_DISABLED' };
    }
    const claim = store.leaseSyncRecovery();
    if (!claim) return { processed: false, reason: 'MODULE_SYNC_RECOVERY_NOT_DUE' };
    let proof;
    try {
        proof = await client.syncRecovery(claim);
    } catch (error) {
        return { processed: true, result: store.finishSyncRecoveryAttempt(claim, {
            code: safeCode(error), retryable: error?.retryable === true,
        }) };
    }
    try {
        return { processed: true, result: store.acceptSyncRecoveryProof(claim, proof) };
    } catch (error) {
        // A malformed, stale, or identity-mismatched helper response is never
        // retried automatically. The original sync lease remains active.
        return { processed: true, result: store.finishSyncRecoveryAttempt(claim, {
            code: safeCode(error), retryable: false,
        }) };
    }
}

module.exports = { processOne, safeCode };
