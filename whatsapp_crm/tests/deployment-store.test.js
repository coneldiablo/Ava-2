'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { describe, it: register, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Provisioning = require('../src/services/provisioning/business-provisioning-store.service');
const Deployment = require('../src/services/provisioning/deployment-store');
const JobWorker = require('../src/services/provisioning/business-provisioning-worker.service');
function it(name, fn) {
    register(name, async () => {
        const previous = [process.env.AVA_ISOLATED_MODULES_ENABLED, process.env.AVA_PROCESS_ROLE];
        createTestDB(); process.env.AVA_ISOLATED_MODULES_ENABLED = 'true'; process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        try { await fn(); } finally {
            ['AVA_ISOLATED_MODULES_ENABLED','AVA_PROCESS_ROLE'].forEach((key, i) => {
                if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
            });
        }
    });
}
function hotel(name = 'North hotel') {
    const value = Provisioning.createBusinessAtomic({ name }).instance;
    return { businessId: value.id, ...DB.get("SELECT id AS deploymentId,revision AS expectedRevision FROM ava_module_deployments WHERE businessId=? AND module='onyx'", [value.id]) };
}
function capacity(availableMiB = 6000) { return { totalMiB: 20000, availableMiB, observedAt: Date.now(), runningDeploymentIds: [] }; }
function reserve(value, sample = capacity()) { return Deployment.reserve({ ...value, memoryMiB: 1536, capacity: sample }); }
function leased(value, sample) { reserve(value, sample); return { ...value, leaseToken: Deployment.lease(value).leaseToken }; }
const proof = async input => ({ ...input, imageDigest: `sha256:${'a'.repeat(64)}`,
    secretReference: `module/${input.deploymentId}/runtime/v1`, tlsVerified: true, nativeIdentityVerified: true,
    storageIsolationVerified: true, foreignAccessDenied: true, bootstrapExcludedFromRuntime: true });

describe('A02/A04 isolated deployment ownership, capacity and recovery', () => {
    it('can explicitly request only the Onyx contour for an existing business', () => {
        const previous = process.env.AVA_ISOLATED_MODULES_ENABLED;
        process.env.AVA_ISOLATED_MODULES_ENABLED = 'false';
        const value = Provisioning.createBusinessAtomic({ name: 'Alleya existing' }).instance;
        if (previous === undefined) delete process.env.AVA_ISOLATED_MODULES_ENABLED;
        else process.env.AVA_ISOLATED_MODULES_ENABLED = previous;
        DB.db.transaction(() => Deployment.requestForBusiness(value.id, value.name, ['onyx']))();
        assert.deepStrictEqual(Deployment.list(value.id).map(row => row.module), ['onyx']);
        assert.throws(() => DB.db.transaction(() => Deployment.requestForBusiness(value.id, value.name, ['onyx', 'onyx']))(),
            { code: 'DEPLOYMENT_MODULE_SELECTION_INVALID' });
        assert.throws(() => DB.db.transaction(() => Deployment.requestForBusiness(value.id, value.name, ['twenty', 'bad']))(),
            { code: 'DEPLOYMENT_MODULE_SELECTION_INVALID' });
    });

    it('business, stable addresses, independent namespaces and jobs are one transaction', () => {
        const a = hotel('Аллея Resort'), b = hotel('Аллея Resort');
        const first = Deployment.list(a.businessId), second = Deployment.list(b.businessId);
        assert.strictEqual(first.length, 2); assert.strictEqual(second.length, 2);
        assert.ok(first.every(row => row.state === 'requested'));
        assert.ok(first.every(row => !second.some(other => row.hostname === other.hostname)));
        assert.strictEqual(DB.get('SELECT count(DISTINCT namespace) AS n FROM ava_module_deployments').n, 4);
        assert.strictEqual(JSON.stringify(first).includes('secretReference'), false);
        assert.throws(() => Deployment.requestForBusiness(a.businessId, 'changed'), { code: 'DEPLOYMENT_TRANSACTION_REQUIRED' });
        DB.db.transaction(() => Deployment.requestForBusiness(a.businessId, 'changed'))();
        assert.deepStrictEqual(Deployment.list(a.businessId), first);
    });
    it('double submit creates exactly one business deployment pair and SIP conflict rolls back all rows', () => {
        const input = { name: 'North', sipAliases: ['+7 999 123 45 67'] };
        const first = Provisioning.createBusinessAtomic(input, { idempotencyKey: 'north' });
        const again = Provisioning.createBusinessAtomic(input, { idempotencyKey: 'north' });
        assert.strictEqual(first.instance.id, again.instance.id);
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM ava_module_deployments').n, 2);
        assert.throws(() => Provisioning.createBusinessAtomic({ ...input, name: 'South' }), { code: 'SIP_ALIAS_CONFLICT' });
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM ava_business_routes').n, 1);
        assert.strictEqual(DB.get('SELECT count(*) AS n FROM instances').n, 1);
    });
    it('requires a fresh valid capacity sample, leaves 20 percent headroom and charges disabled reservations', () => {
        const a = hotel(), b = hotel('South');
        assert.throws(() => reserve(a, { ...capacity(), observedAt: Date.now() - 31000 }), { code: 'DEPLOYMENT_CAPACITY_SAMPLE_INVALID' });
        assert.strictEqual(reserve(a).state, 'reserved');
        assert.strictEqual(reserve(a).state, 'reserved');
        Deployment.disable(a);
        assert.strictEqual(reserve(b).state, 'capacity_required');
        assert.strictEqual(Deployment.list(b.businessId).find(row => row.module === 'onyx').error_code, 'CAPACITY_REQUIRED');
    });
    it('two real SQLite connections racing a reservation cannot overbook capacity', async () => {
        const a = hotel(), b = hotel('South');
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-capacity-'));
        try {
            const database = path.join(directory, 'state.db'); await DB.db.backup(database);
            const script = `const { parentPort, workerData } = require('worker_threads');
                const Database = require('better-sqlite3');
                const DB = require(workerData.root + '/src/services/database.service');
                DB.db = new Database(workerData.database); DB.db.pragma('busy_timeout=5000');
                process.env.AVA_PROCESS_ROLE='provisioning-worker';
                const Store = require(workerData.root + '/src/services/provisioning/deployment-store');
                try { parentPort.postMessage(Store.reserve({...workerData.value,memoryMiB:1536,
                    capacity:{totalMiB:20000,availableMiB:6000,observedAt:Date.now(),runningDeploymentIds:[]}}).state); }
                finally { DB.db.close(); }`;
            const run = value => new Promise((resolve, reject) => {
                const worker = new Worker(script, { eval: true, workerData: { database, value, root: path.resolve(__dirname, '..') } });
                worker.once('message', resolve); worker.once('error', reject);
                worker.once('exit', code => { if (code !== 0) reject(new Error('reservation worker failed')); });
            });
            const states = await Promise.all([run(a), run(b)]);
            assert.deepStrictEqual(states.sort(), ['capacity_required','reserved']);
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
    it('fresh lease cannot be stolen; expired lease requires reconcile and crashes exhaust attempts', () => {
        const a = hotel(); reserve(a);
        const first = Deployment.lease(a); assert.strictEqual(first.requiresReconciliation, false);
        assert.strictEqual(Deployment.lease(a), null);
        DB.run('UPDATE ava_module_deployments SET leasedUntil=? WHERE id=?', [Date.now() - 1, a.deploymentId]);
        const next = Deployment.lease(a); assert.strictEqual(next.requiresReconciliation, true);
        assert.notStrictEqual(next.leaseToken, first.leaseToken);
        assert.throws(() => Deployment.heartbeat({ ...a, leaseToken: first.leaseToken }), { code: 'DEPLOYMENT_LEASE_LOST' });
        for (let i = 0; i < 7; i++) {
            DB.run('UPDATE ava_module_deployments SET leasedUntil=? WHERE id=?', [Date.now() - 1, a.deploymentId]);
            Deployment.lease(a);
        }
        assert.strictEqual(DB.get('SELECT state FROM ava_module_deployments WHERE id=?', [a.deploymentId]).state, 'failed');
    });
    it('wrong business, missing isolation proof, expired lease and late success after disable never verify', async () => {
        const a = leased(hotel()), b = hotel('South');
        assert.throws(() => Deployment.lease({ ...a, businessId: b.businessId }), { code: 'DEPLOYMENT_SCOPE_MISMATCH' });
        await assert.rejects(Deployment.verify(a, async input => ({ ...await proof(input), foreignAccessDenied: false })), { code: 'DEPLOYMENT_NATIVE_PROOF_INCOMPLETE' });
        await assert.rejects(Deployment.verify(a, async input => {
            Deployment.disable(a); return proof(input);
        }), { code: 'DEPLOYMENT_LEASE_LOST' });
        assert.strictEqual(Deployment.list(a.businessId).find(row => row.module === 'onyx').state, 'disabled');
    });
    it('exact native readback pins source, image and secret reference without returning credentials', async () => {
        const a = leased(hotel());
        const result = await Deployment.verify(a, proof);
        assert.strictEqual(result.state, 'verified');
        assert.ok(result.last_verified_at); assert.strictEqual(JSON.stringify(result).includes('runtime/v1'), false);
        const stored = DB.get('SELECT * FROM ava_module_deployments WHERE id=?', [a.deploymentId]);
        assert.strictEqual(stored.sourceCommit, Deployment.PINNED.onyx);
        assert.strictEqual(stored.leaseToken, null);
    });
    it('worker raw deployment is scope and revision fenced, never a web-facing safe view', () => {
        const a = hotel(), b = hotel('South');
        const raw = Deployment.getWorkerDeployment(a);
        assert.strictEqual(raw.id, a.deploymentId); assert.strictEqual(raw.businessId, a.businessId);
        assert.throws(() => Deployment.getWorkerDeployment({ ...a, businessId: b.businessId }), { code: 'DEPLOYMENT_SCOPE_MISMATCH' });
        assert.throws(() => Deployment.getWorkerDeployment({ ...a, expectedRevision: a.expectedRevision + 1 }), { code: 'DEPLOYMENT_REVISION_CHANGED' });
        const role = process.env.AVA_PROCESS_ROLE; delete process.env.AVA_PROCESS_ROLE;
        assert.throws(() => Deployment.getWorkerDeployment(a), { code: 'DEPLOYMENT_WORKER_REQUIRED' }); process.env.AVA_PROCESS_ROLE = role;
    });
    it('retry failure keeps its reservation, backs off, and reconciles every later lease', () => {
        const a = hotel(); const first = leased(a);
        const retry = Deployment.failAttempt(first, { code: 'NATIVE_TIMEOUT', retryable: true });
        assert.strictEqual(retry.state, 'reserved'); assert.ok(retry.next_retry_at > Date.now());
        assert.strictEqual(DB.get('SELECT reservedMemoryMiB,attempts FROM ava_module_deployments WHERE id=?', [a.deploymentId]).reservedMemoryMiB, 1536);
        assert.strictEqual(Deployment.lease(a), null);
        assert.throws(() => Deployment.reserve({ ...a, memoryMiB: 2048, capacity: capacity() }), { code: 'DEPLOYMENT_RESERVATION_MEMORY_CHANGED' });
        DB.run('UPDATE ava_module_deployments SET nextRetryAt=? WHERE id=?', [Date.now() - 1, a.deploymentId]);
        const second = Deployment.lease(a); assert.strictEqual(second.requiresReconciliation, true);
    });
    it('non-retryable failure remains terminal and retains its capacity reservation', () => {
        const a = hotel(); const first = leased(a);
        const failed = Deployment.failAttempt(first, { code: 'NATIVE_CONFIGURATION_INVALID', retryable: false });
        assert.strictEqual(failed.state, 'failed'); assert.deepStrictEqual(failed.allowed_actions, []);
        assert.strictEqual(DB.get('SELECT reservedMemoryMiB FROM ava_module_deployments WHERE id=?', [a.deploymentId]).reservedMemoryMiB, 1536);
        const result = Deployment.reserve({ ...a, memoryMiB: 1536, capacity: capacity() });
        assert.strictEqual(result.state, 'failed');
        assert.strictEqual(DB.get('SELECT reservedMemoryMiB FROM ava_module_deployments WHERE id=?', [a.deploymentId]).reservedMemoryMiB, 1536);
        assert.strictEqual(Deployment.lease(a), null);
    });
    it('exhausted failures are terminal and stale failures cannot alter disabled or re-leased work', () => {
        const a = hotel(); let current = leased(a);
        for (let attempt = 1; attempt <= 8; attempt++) {
            const result = Deployment.failAttempt(current, { code: 'NATIVE_TIMEOUT', retryable: true });
            if (attempt < 8) { DB.run('UPDATE ava_module_deployments SET nextRetryAt=? WHERE id=?', [Date.now() - 1, a.deploymentId]); current = { ...a, leaseToken: Deployment.lease(a).leaseToken }; }
            else assert.strictEqual(result.state, 'failed');
        }
        assert.strictEqual(Deployment.lease(a), null);
        assert.strictEqual(Deployment.reserve({ ...a, memoryMiB: 1536, capacity: capacity() }).state, 'failed');
        const b = leased(hotel('West'), capacity(8192)); Deployment.disable(b);
        assert.throws(() => Deployment.failAttempt(b, { code: 'NATIVE_TIMEOUT', retryable: true }), { code: 'DEPLOYMENT_LEASE_LOST' });
        const c = hotel('East'); const old = leased(c, capacity(12000));
        Deployment.failAttempt(old, { code: 'NATIVE_TIMEOUT', retryable: true }); DB.run('UPDATE ava_module_deployments SET nextRetryAt=? WHERE id=?', [Date.now() - 1, c.deploymentId]);
        Deployment.lease(c); assert.throws(() => Deployment.failAttempt(old, { code: 'NATIVE_TIMEOUT', retryable: true }), { code: 'DEPLOYMENT_LEASE_LOST' });
    });
    it('native proof receives and returns the current revision', async () => {
        const a = leased(hotel()); let seen;
        await Deployment.verify(a, async input => { seen = input.revision; return proof(input); });
        assert.strictEqual(seen, a.expectedRevision);
        const b = leased(hotel('South'), capacity(8192));
        await assert.rejects(Deployment.verify(b, async input => ({ ...await proof(input), revision: input.revision + 1 })), { code: 'DEPLOYMENT_NATIVE_PROOF_INCOMPLETE' });
    });
    it('isolated businesses do not fall back to the shared legacy provisioner or claim readiness', async () => {
        const a = hotel();
        const job = DB.get("SELECT * FROM business_provisioning_jobs WHERE businessId=? AND module='onyx_runtime'", [a.businessId]);
        const result = await JobWorker._runOnyxRuntimeModule(job, DB.get('SELECT * FROM instances WHERE id=?', [a.businessId]), {});
        assert.strictEqual(result.status, 'BLOCKED');
        assert.strictEqual(result.errorCode, 'DEPLOYMENT_HELPER_UNAVAILABLE');
    });
});
