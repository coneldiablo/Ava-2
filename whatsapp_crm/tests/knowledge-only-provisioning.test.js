'use strict';
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Store = require('../src/services/provisioning/business-provisioning-store.service');
const { BusinessProvisioningWorker } = require('../src/services/provisioning/business-provisioning-worker.service');
const { startRuntime } = require('../provisioning-worker');

const unrelated = () => DB.all(`SELECT * FROM business_provisioning_jobs
    WHERE module NOT IN ('knowledge_base','onyx_runtime') ORDER BY id`);

describe('Knowledge-only provisioning queue', () => {
    it('leaves unrelated pending, expired, exhausted and dependent jobs byte-for-byte unchanged', async () => {
        createTestDB();
        const businesses = Array.from({ length: 4 }, (_, index) => Store.createBusinessAtomic({ name: `Synthetic ${index}` }).instance);
        DB.run(`UPDATE business_provisioning_jobs SET status='LEASED', leaseToken='fixture-token',
            leasedUntil=datetime('now','-1 day'), checkpointJson='{"token":"fixture-only"}'
            WHERE businessId=? AND module='crm_workspace'`, [businesses[0].id]);
        DB.run(`UPDATE business_provisioning_jobs SET attempts=maxAttempts
            WHERE businessId=? AND module='telephony_sip'`, [businesses[1].id]);
        DB.run(`UPDATE business_provisioning_jobs SET status='FAILED'
            WHERE businessId=? AND module='whatsapp'`, [businesses[2].id]);
        DB.run(`UPDATE business_provisioning_jobs SET dependsOnModule='whatsapp'
            WHERE businessId=? AND module='crm_workspace'`, [businesses[2].id]);
        const before = unrelated();
        Store.sanitizeLegacyCheckpoints({ knowledgeOnly: true });
        const worker = new BusinessProvisioningWorker();
        worker._knowledgeOnly = true;
        const modules = [];
        worker._runOnyxRuntimeModule = async job => {
            modules.push(job.module);
            return { status: 'DONE', checkpoint: { fixture: true } };
        };
        assert.equal(await worker.processQueue(2), businesses.length * 2);
        assert.deepEqual(unrelated(), before);
        assert.equal(modules.length, businesses.length);
        assert.equal(DB.get(`SELECT COUNT(*) AS n FROM business_provisioning_jobs
            WHERE module IN ('knowledge_base','onyx_runtime') AND status='DONE'`).n, businesses.length * 2);
        assert.equal(await worker.processQueue(), 0);
        assert.deepEqual(unrelated(), before);
    });

    it('knowledge-only mode still recovers and bounds its own stale leases', async () => {
        createTestDB();
        const business = Store.createBusinessAtomic({ name: 'Synthetic recovery' }).instance;
        DB.run(`UPDATE business_provisioning_jobs SET status='LEASED', attempts=maxAttempts,
            leasedUntil=datetime('now','-1 day'), leaseToken='fixture-expired'
            WHERE businessId=? AND module='knowledge_base'`, [business.id]);
        const before = unrelated();
        assert.deepEqual(Store.leaseJobs(10, 60, { knowledgeOnly: true }), []);
        assert.equal(DB.get("SELECT status FROM business_provisioning_jobs WHERE module='knowledge_base'").status, 'FAILED');
        assert.equal(DB.get("SELECT status FROM business_provisioning_jobs WHERE module='onyx_runtime'").status, 'BLOCKED');
        assert.deepEqual(unrelated(), before);
    });

    it('requests only an isolated Onyx deployment for a new tenant and never falls back to a shared URL', async () => {
        createTestDB();
        const business = Store.createBusinessAtomic({ name: 'Synthetic native tenant' }).instance;
        const oldFeature = process.env.AVA_ISOLATED_MODULES_ENABLED, oldUrl = process.env.ONYX_BASE_URL;
        process.env.AVA_ISOLATED_MODULES_ENABLED = 'false';
        process.env.ONYX_BASE_URL = 'https://shared.example.test/api';
        const worker = new BusinessProvisioningWorker();
        worker._knowledgeOnly = true;
        const before = unrelated();
        try {
            assert.equal(await worker.processQueue(2), 2);
            assert.equal(DB.get("SELECT status FROM business_provisioning_jobs WHERE module='knowledge_base'").status, 'DONE');
            assert.deepEqual(DB.get("SELECT status,lastErrorCode FROM business_provisioning_jobs WHERE module='onyx_runtime'"),
                { status: 'BLOCKED', lastErrorCode: 'DEPLOYMENT_FEATURE_DISABLED' });
            const rows = DB.all('SELECT businessId,module,state FROM ava_module_deployments');
            assert.deepEqual(rows, [{ businessId: business.id, module: 'onyx', state: 'requested' }]);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM onyx_tenant_links').n, 0);
            assert.deepEqual(unrelated(), before);
            assert.equal(await worker.processQueue(), 0);
            assert.equal(DB.get('SELECT COUNT(*) AS n FROM ava_module_deployments').n, 1);
        } finally {
            if (oldFeature === undefined) delete process.env.AVA_ISOLATED_MODULES_ENABLED;
            else process.env.AVA_ISOLATED_MODULES_ENABLED = oldFeature;
            if (oldUrl === undefined) delete process.env.ONYX_BASE_URL;
            else process.env.ONYX_BASE_URL = oldUrl;
        }
    });

    it('starts only the opted-in knowledge poller while full jobs and Twenty recovery remain disabled', async () => {
        const calls = [], timers = [];
        const worker = {
            _pollerTimer: { ref: () => calls.push('ref') },
            startBackgroundPoller: (interval, options) => calls.push({ interval, ...options }),
            stopBackgroundPoller: () => calls.push('stop'),
        };
        const runtime = await startRuntime({
            env: { AVA_PROVISIONING_JOBS_ENABLED: 'false', AVA_KNOWLEDGE_PROVISIONING_ENABLED: 'true',
                AVA_TWENTY_SYNC_RECOVERY_ENABLED: 'true' },
            db: { init: async () => {}, db: { close: () => calls.push('close') } },
            identityStore: { ensureSchema: () => {} },
            identityBrokerService: { start: () => ({ close: () => {} }) },
            loadProvisioningWorker: () => worker,
            loadRevocationWorker: () => ({ processOne: async options => calls.push(options) }),
            loadRecoveryWorker: () => { throw new Error('Unrelated recovery worker loaded'); },
            schedule: callback => { timers.push(callback); return callback; }, cancel: () => {},
        });
        assert.equal(runtime.provisioningJobsEnabled, false);
        assert.equal(runtime.knowledgeProvisioningEnabled, true);
        assert.ok(calls.some(item => item.interval === 3000 && item.knowledgeOnly === true));
        assert.equal(timers.length, 1);
        await timers[0]();
        assert.ok(calls.some(item => item.keycloakOnly === true));
        await runtime.shutdown();
        assert.ok(calls.includes('stop'));
    });
});
