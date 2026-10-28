'use strict';
// Real AVA SQLite/store/worker; helper responses below are contract fixtures,
// explicitly not evidence of a native CRM deployment or customer login.
const { describe, it: register, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Store = require('../src/services/provisioning/business-provisioning-store.service');
const Deployment = require('../src/services/provisioning/deployment-store');
const Isolated = require('../src/services/provisioning/isolated-module-provisioner');
const Worker = require('../src/services/provisioning/business-provisioning-worker.service');
const crypto = require('crypto');
function it(name, test) {
    register(name, async () => {
        const keys = ['AVA_PROCESS_ROLE', 'AVA_MODULE_DEPLOYMENT_SOCKET', 'AVA_ISOLATED_MODULES_ENABLED'];
        const previous = keys.map(key => process.env[key]);
        process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        process.env.AVA_MODULE_DEPLOYMENT_SOCKET = '/tmp/helper-fixture.sock';
        process.env.AVA_ISOLATED_MODULES_ENABLED = 'true';
        createTestDB();
        try { await test(); } finally {
            keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
            Worker._isolatedProvisioner = null;
        }
    });
}
function setup() {
    const instance = Store.createBusinessAtomic({ name: 'North' }).instance;
    const row = Deployment.list(instance.id).find(value => value.module === 'twenty');
    return { instance, row };
}
function ident(input) {
    assert.deepStrictEqual(Object.keys(input).sort(), ['businessId', 'deploymentId', 'leaseToken', 'revision']);
    const row = Deployment.getWorkerDeployment({ deploymentId: input.deploymentId, businessId: input.businessId, expectedRevision: input.revision });
    return { deploymentId: row.id, businessId: row.businessId, module: row.module, revision: row.revision,
        hostname: row.hostname, namespace: row.namespace, sourceCommit: row.sourceCommit };
}
function proof(input) {
    return { ...ident(input), imageDigest: `sha256:${'a'.repeat(64)}`, secretReference: `module/${input.deploymentId}/runtime/v1`,
        tlsVerified: true, nativeIdentityVerified: true, storageIsolationVerified: true, foreignAccessDenied: true, bootstrapExcludedFromRuntime: true };
}
function client() {
    return { capacity: async () => ({ totalMiB: 65536, availableMiB: 60000, observedAt: Date.now(), runningDeploymentIds: [] }),
        reconcile: async input => ({ ...ident(input), state: 'absent' }),
        provision: async input => ({ ...ident(input), state: 'running' }),
        enrollment: async input => ({ ...ident(input), adapterId: input.deploymentId,
            nativeScope: '11111111-1111-4111-8111-111111111111',
            peerSecretHash: crypto.createHash('sha256').update('fixed-fixture-peer-secret').digest('hex') }),
        verify: async input => proof(input) };
}
const runner = helper => new Isolated({ store: Deployment, client: helper });
describe('isolated provisioner real store', () => {
    it('reserves the full Onyx contour including native auth and gateway without claiming buyer readiness', async () => {
        const { instance } = setup(), helper = client();
        helper.enrollment = async input => ({ ...ident(input), adapterId: input.deploymentId,
            nativeScope: ident(input).namespace,
            peerSecretHash: crypto.createHash('sha256').update('fixed-fixture-peer-secret').digest('hex') });
        const out = await runner(helper).run({ businessId: instance.id }, 'onyx');
        const row = DB.get("SELECT * FROM ava_module_deployments WHERE businessId=? AND module='onyx'", [instance.id]);
        assert.strictEqual(row.reservedMemoryMiB, 12800);
        assert.strictEqual(out.status, 'BLOCKED');
        assert.strictEqual(out.stage, 'requires_verification');
        assert.strictEqual(DB.get('SELECT nativeScope FROM ava_module_enrollments WHERE deploymentId=?', [row.id]).nativeScope, row.namespace);
    });
    it('reserves the additional knowledge API budget only for explicitly selected new Onyx overlays', async () => {
        const { instance } = setup(), helper = client();
        helper.enrollment = async input => ({ ...ident(input), adapterId: input.deploymentId,
            nativeScope: ident(input).namespace,
            peerSecretHash: crypto.createHash('sha256').update('fixed-fixture-peer-secret').digest('hex') });
        const provisioner = new Isolated({ store: Deployment, client: helper, knowledgeOverlay: true });
        assert.equal((await provisioner.run({ businessId: instance.id }, 'onyx')).status, 'BLOCKED');
        assert.equal(DB.get("SELECT reservedMemoryMiB FROM ava_module_deployments WHERE businessId=? AND module='onyx'", [instance.id]).reservedMemoryMiB, 13824);
        helper.enrollment = client().enrollment;
        assert.equal((await provisioner.run({ businessId: instance.id }, 'twenty')).status, 'BLOCKED');
        assert.equal(DB.get("SELECT reservedMemoryMiB FROM ava_module_deployments WHERE businessId=? AND module='twenty'", [instance.id]).reservedMemoryMiB, 4352);
    });
    it('marks verified infrastructure but never claims business readiness', async () => {
        const { instance } = setup(), helper = client();
        const out = await runner(helper).run({ businessId: instance.id }, 'twenty');
        assert.strictEqual(out.stage, 'requires_verification');
        assert.strictEqual(out.status, 'BLOCKED');
        assert.strictEqual(Deployment.list(instance.id).find(value => value.module === 'twenty').state, 'verified');
        helper.capacity = async () => { throw new Error('already verified must not launch again'); };
        assert.strictEqual((await runner(helper).run({ businessId: instance.id }, 'twenty')).status, 'BLOCKED');
    });
    it('resumes prepared peer after exact CRM link exists without repeating deployment or invalidating it', async () => {
        const { instance, row } = setup(), helper = client();
        const pending = await runner(helper).run({ businessId: instance.id }, 'twenty');
        assert.strictEqual(pending.checkpoint.accessErrorCode, 'MODULE_INTEGRATION_UNAVAILABLE');
        const prepared = DB.get('SELECT * FROM ava_module_enrollments WHERE deploymentId=?', [row.deployment_id]);
        require('../src/services/twenty/twenty-store.service').upsertIntegration(instance.id,
            { baseUrl: prepared.publicOrigin, workspaceId: prepared.nativeScope, enabled: true });
        helper.capacity = async () => assert.fail('verified deployment must never relaunch');
        const resumed = await runner(helper).run({ businessId: instance.id }, 'twenty');
        assert.strictEqual(resumed.checkpoint.moduleAdapterId, row.deployment_id);
        assert.strictEqual(resumed.checkpoint.moduleAdapterRevision, 1);
        assert.strictEqual(resumed.status, 'BLOCKED'); // Buyer/native data proof still required.
        assert.deepStrictEqual(await runner(helper).run({ businessId: instance.id }, 'twenty'), resumed);
        assert.strictEqual(DB.get('SELECT count(*) n FROM ava_module_adapters').n, 1);
        assert.strictEqual(DB.get('SELECT peerSecretHash FROM ava_module_adapters').peerSecretHash, prepared.peerSecretHash);
    });
    it('lost response retries by reconciling running state, without a second create', async () => {
        const { instance, row } = setup(), helper = client();
        let created = 0;
        helper.provision = async () => { created++; throw Object.assign(new Error('Bearer private-fixture'), { code: 'DEPLOYMENT_HELPER_BUSY', retryable: true }); };
        await assert.rejects(runner(helper).run({ businessId: instance.id }, 'twenty'), error => error.code === 'DEPLOYMENT_HELPER_BUSY' && !error.message.includes('private'));
        const failed = DB.get('SELECT * FROM ava_module_deployments WHERE id=?', [row.deployment_id]);
        assert.strictEqual(failed.attempts, 1); assert.strictEqual(failed.state, 'reserved');
        assert.ok(failed.nextRetryAt > Date.now() + 59000);
        await assert.rejects(runner(helper).run({ businessId: instance.id }, 'twenty'), { code: 'DEPLOYMENT_RETRY_NOT_DUE' });
        assert.strictEqual(DB.get('SELECT attempts FROM ava_module_deployments WHERE id=?', [row.deployment_id]).attempts, 1);
        DB.run('UPDATE ava_module_deployments SET nextRetryAt=? WHERE id=?', [Date.now() - 1, row.deployment_id]);
        helper.reconcile = async input => ({ ...ident(input), state: 'running' });
        await runner(helper).run({ businessId: instance.id }, 'twenty');
        assert.strictEqual(created, 1);
    });
    it('disable during provision fences success and late failure', async () => {
        const { instance } = setup(), helper = client();
        helper.provision = async input => {
            const result = { ...ident(input), state: 'running' };
            Deployment.disable({ deploymentId: input.deploymentId, businessId: input.businessId, expectedRevision: input.revision });
            return result;
        };
        await assert.rejects(runner(helper).run({ businessId: instance.id }, 'twenty'), { code: 'DEPLOYMENT_LEASE_LOST' });
        const row = Deployment.list(instance.id).find(value => value.module === 'twenty');
        assert.strictEqual(row.state, 'disabled'); assert.strictEqual(row.last_verified_at, null);
    });
    it('foreign reconcile identity is rejected before launching any process', async () => {
        const { instance } = setup(), helper = client();
        helper.reconcile = async input => ({ ...ident(input), businessId: instance.id + 1, state: 'absent' });
        helper.provision = async () => { assert.fail('foreign deployment must never launch'); };
        await assert.rejects(runner(helper).run({ businessId: instance.id }, 'twenty'), { code: 'DEPLOYMENT_HELPER_PROTOCOL_INVALID' });
    });
    it('insufficient capacity and disabled feature have no launch side effects', async () => {
        const { instance } = setup(), helper = client();
        helper.capacity = async () => ({ totalMiB: 65536, availableMiB: 1000, observedAt: Date.now(), runningDeploymentIds: [] });
        helper.reconcile = async () => { assert.fail('capacity must be reserved first'); };
        assert.strictEqual((await runner(helper).run({ businessId: instance.id }, 'twenty')).stage, 'capacity_required');
        process.env.AVA_ISOLATED_MODULES_ENABLED = 'false';
        await assert.rejects(runner(helper).run({ businessId: instance.id }, 'twenty'), { code: 'DEPLOYMENT_FEATURE_DISABLED' });
    });
    it('outer worker preserves durable deployment retry time instead of blocking forever', async () => {
        const { instance, row } = setup(), helper = client();
        DB.run("DELETE FROM business_provisioning_jobs WHERE module!='crm_workspace'");
        helper.provision = async () => { throw Object.assign(new Error('private'), { code: 'DEPLOYMENT_HELPER_TIMEOUT', retryable: true }); };
        Worker._isolatedProvisioner = runner(helper);
        assert.strictEqual(await Worker.processQueue(1), 1);
        const job = DB.get("SELECT * FROM business_provisioning_jobs WHERE module='crm_workspace'");
        const deployment = DB.get('SELECT * FROM ava_module_deployments WHERE id=?', [row.deployment_id]);
        assert.strictEqual(job.status, 'PENDING');
        assert.ok(Date.parse(job.nextAttemptAt + 'Z') >= deployment.nextRetryAt - 1000);
        assert.strictEqual(job.lastErrorMessage, 'DEPLOYMENT_HELPER_TIMEOUT');
    });
    it('missing approved recipe blocks parent but preserves bounded resume after setup', async () => {
        const { instance, row } = setup(), helper = client();
        DB.run("DELETE FROM business_provisioning_jobs WHERE module!='crm_workspace'");
        helper.reconcile = async () => { throw Object.assign(new Error('safe'), { code: 'DEPLOYMENT_RECIPE_REQUIRED', retryable: false }); };
        Worker._isolatedProvisioner = runner(helper);
        await Worker.processQueue(1);
        assert.strictEqual(DB.get("SELECT status FROM business_provisioning_jobs WHERE module='crm_workspace'").status, 'BLOCKED');
        const deployment = DB.get('SELECT * FROM ava_module_deployments WHERE id=?', [row.deployment_id]);
        assert.strictEqual(deployment.state, 'reserved'); assert.strictEqual(deployment.attempts, 1);
        assert.ok(deployment.reservedMemoryMiB > 0);
        assert.strictEqual(await Worker.processQueue(1), 0);
    });
});
