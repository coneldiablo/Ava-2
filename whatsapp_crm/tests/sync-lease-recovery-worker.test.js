'use strict';

const { describe, it, assert } = require('./test-helper');
const RecoveryWorker = require('../src/services/identity/sync-lease-recovery-worker');

const claim = Object.freeze({ contractVersion: 'ava-sync-recovery-v1', recoveryId: 'recovery-id' });

async function enabled(run) {
    const role = process.env.AVA_PROCESS_ROLE, flag = process.env.AVA_TWENTY_SYNC_RECOVERY_ENABLED;
    process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
    process.env.AVA_TWENTY_SYNC_RECOVERY_ENABLED = 'true';
    try { await run(); } finally {
        if (role === undefined) delete process.env.AVA_PROCESS_ROLE; else process.env.AVA_PROCESS_ROLE = role;
        if (flag === undefined) delete process.env.AVA_TWENTY_SYNC_RECOVERY_ENABLED;
        else process.env.AVA_TWENTY_SYNC_RECOVERY_ENABLED = flag;
    }
}

describe('Twenty sync recovery worker boundary', () => {
    it('is inert unless the explicit recovery release flag is enabled', async () => {
        const role = process.env.AVA_PROCESS_ROLE, flag = process.env.AVA_TWENTY_SYNC_RECOVERY_ENABLED;
        process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        delete process.env.AVA_TWENTY_SYNC_RECOVERY_ENABLED;
        let leased = false;
        try {
            const result = await RecoveryWorker.processOne({ store: { leaseSyncRecovery() { leased = true; } }, client: {} });
            assert.deepStrictEqual(result, { processed: false, reason: 'MODULE_SYNC_RECOVERY_DISABLED' });
            assert.strictEqual(leased, false);
        } finally {
            if (role === undefined) delete process.env.AVA_PROCESS_ROLE; else process.env.AVA_PROCESS_ROLE = role;
            if (flag === undefined) delete process.env.AVA_TWENTY_SYNC_RECOVERY_ENABLED;
            else process.env.AVA_TWENTY_SYNC_RECOVERY_ENABLED = flag;
        }
    });

    it('accepts only the direct helper result through the store terminal transaction', async () => enabled(async () => {
        const proof = { exact: 'helper-proof' };
        const calls = [];
        const store = {
            leaseSyncRecovery: () => claim,
            acceptSyncRecoveryProof: (receivedClaim, receivedProof) => {
                calls.push(['accept', receivedClaim, receivedProof]);
                return { state: 'readback_required' };
            },
        };
        const result = await RecoveryWorker.processOne({ store, client: { syncRecovery: async value => {
            calls.push(['helper', value]); return proof;
        } } });
        assert.deepStrictEqual(result, { processed: true, result: { state: 'readback_required' } });
        assert.deepStrictEqual(calls, [['helper', claim], ['accept', claim, proof]]);
    }));

    it('keeps failures in retry or blocked state without accepting a death boolean', async () => enabled(async () => {
        const completions = [];
        const store = {
            leaseSyncRecovery: () => claim,
            finishSyncRecoveryAttempt: (received, result) => {
                completions.push([received, result]);
                return { state: result.retryable ? 'pending' : 'blocked' };
            },
        };
        const transient = Object.assign(new Error('socket lost'), { code: 'DEPLOYMENT_HELPER_TIMEOUT', retryable: true });
        const first = await RecoveryWorker.processOne({ store, client: { syncRecovery: async () => { throw transient; } } });
        assert.strictEqual(first.result.state, 'pending');
        assert.deepStrictEqual(completions[0], [claim, { code: 'DEPLOYMENT_HELPER_TIMEOUT', retryable: true }]);

        store.acceptSyncRecoveryProof = () => { throw Object.assign(new Error('bad proof'), { code: 'MODULE_SYNC_RECOVERY_PROOF_INVALID' }); };
        const second = await RecoveryWorker.processOne({ store, client: { syncRecovery: async () => ({ accepted: true }) } });
        assert.strictEqual(second.result.state, 'blocked');
        assert.deepStrictEqual(completions[1], [claim, { code: 'MODULE_SYNC_RECOVERY_PROOF_INVALID', retryable: false }]);
    }));
});
