const { describe, it, assert, createTestDB } = require('./test-helper');
const crypto = require('crypto');
const DB = require('../src/services/database.service');
const Store = require('../src/services/provisioning/business-provisioning-store.service');
const Service = require('../src/services/provisioning/business-provisioning.service');
const Worker = require('../src/services/provisioning/business-provisioning-worker.service');
const Vault = require('../src/services/twenty/twenty-crypto');
const Twenty = require('../src/services/twenty/twenty.service');
const TwentyStore = require('../src/services/twenty/twenty-store.service');

describe('A02/A05 lifecycle and tenant-bound vault', () => {
    it('delayed Twenty health cannot verify a replacement key or resurrect a deleted link', async () => {
        process.env.TWENTY_CREDENTIALS_MASTER_KEY = '64'.repeat(32);
        createTestDB();
        const hotel = await DB.createInstance({ name: 'Race test' });
        Twenty.configure(hotel.id, { base_url: 'https://crm.example.test', api_key: 'fixture-one' });
        const original = Twenty.clientFactory;
        try {
            Twenty.clientFactory = () => ({ testConnection: async () => {
                Twenty.configure(hotel.id, { api_key: 'fixture-two' });
                return [];
            } });
            await assert.rejects(() => Twenty.test(hotel.id), { code: 'TWENTY_CONFIGURATION_CHANGED' });
            assert.strictEqual(TwentyStore.getIntegration(hotel.id).connectionStatus, 'not_tested');
            Twenty.clientFactory = () => ({ testConnection: async () => {
                Twenty.disconnect(hotel.id);
                return [];
            } });
            await assert.rejects(() => Twenty.test(hotel.id), { code: 'TWENTY_CONFIGURATION_CHANGED' });
            assert.strictEqual(TwentyStore.getIntegration(hotel.id), undefined);
        } finally { Twenty.clientFactory = original; }
    });
    it('crashes exhaust the lease budget and block dependent work', async () => {
        createTestDB();
        const business = Store.createBusinessAtomic({ name: 'Crash test' }).instance;
        DB.run("DELETE FROM business_provisioning_jobs WHERE businessId=? AND module NOT IN ('knowledge_base','onyx_runtime')", [business.id]);
        DB.run('UPDATE business_provisioning_jobs SET maxAttempts=2');
        for (let i = 0; i < 2; i++) {
            const [job] = Store.leaseJobs(1);
            assert.strictEqual(job.attempts, i + 1);
            DB.run("UPDATE business_provisioning_jobs SET leasedUntil=datetime('now','-1 second') WHERE id=?", [job.id]);
        }
        assert.deepStrictEqual(Store.leaseJobs(), []);
        const state = Store.getProvisioningStatus(business.id);
        assert.strictEqual(state.modules.knowledge_base.errorCode, 'PROVISIONING_ATTEMPTS_EXHAUSTED');
        assert.strictEqual(state.modules.onyx_runtime.status, 'BLOCKED');
        Store.retryJobs(business.id);
        assert.strictEqual(Store.leaseJobs(1)[0].attempts, 1);
    });

    it('HTTP creation and retry never execute privileged module work inline', async () => {
        createTestDB();
        const original = Worker.processQueue;
        let calls = 0;
        Worker.processQueue = async () => { calls++; };
        const role = process.env.AVA_PROCESS_ROLE;
        process.env.AVA_PROCESS_ROLE = 'web';
        try {
            const result = await Service.createBusiness({ name: 'Queued hotel' }, { syncProcess: true });
            DB.run("UPDATE business_provisioning_jobs SET status='FAILED'");
            await Service.retryProvisioning(result.instance.id, { syncProcess: true });
            await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(calls, 0);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM business_provisioning_jobs').n, 5);
        } finally {
            Worker.processQueue = original;
            if (role === undefined) delete process.env.AVA_PROCESS_ROLE; else process.env.AVA_PROCESS_ROLE = role;
        }
    });

    it('Twenty ciphertext cannot move across a business or credential field', () => {
        process.env.TWENTY_CREDENTIALS_MASTER_KEY = '64'.repeat(32);
        const encrypted = Vault.encryptJson({ apiKey: 'public-fixture' }, Vault.context(1));
        assert.deepStrictEqual(Vault.decryptJson(encrypted, Vault.context(1)), { apiKey: 'public-fixture' });
        assert.throws(() => Vault.decryptJson(encrypted, Vault.context(2)), { code: 'TWENTY_CREDENTIALS_INVALID' });
        assert.throws(() => Vault.decryptJson(encrypted, Vault.context(1, 'webhookSecretEncrypted')), { code: 'TWENTY_CREDENTIALS_INVALID' });
        assert.throws(() => Vault.decryptJson(encrypted), { code: 'TWENTY_CREDENTIAL_SCOPE_REQUIRED' });
    });

    it('legacy vault migration is atomic, repeatable and preserves credentials', async () => {
        process.env.TWENTY_CREDENTIALS_MASTER_KEY = '64'.repeat(32);
        createTestDB();
        const business = await DB.createInstance({ name: 'Legacy vault' });
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from('64'.repeat(32), 'hex'), iv);
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ apiKey: 'old-public-fixture' })), cipher.final()]);
        const legacy = ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
        DB.run("INSERT INTO twenty_workspace_links(id,businessId,baseUrl,apiKeyEncrypted) VALUES ('legacy',?,'https://crm.example.test',?)", [business.id, legacy]);
        assert.throws(() => Vault.decryptJson(legacy, Vault.context(business.id)), { code: 'TWENTY_CREDENTIALS_INVALID' });
        Vault.migrateLegacyCredentials(DB.db);
        const row = DB.get('SELECT * FROM twenty_workspace_links');
        assert.ok(row.apiKeyEncrypted.startsWith('v2.'));
        assert.strictEqual(Vault.decryptJson(row.apiKeyEncrypted, Vault.context(business.id)).apiKey, 'old-public-fixture');
        Vault.migrateLegacyCredentials(DB.db);
        assert.strictEqual(DB.get('SELECT apiKeyEncrypted FROM twenty_workspace_links').apiKeyEncrypted, row.apiKeyEncrypted);
        DB.run("UPDATE twenty_workspace_links SET webhookSecretEncrypted='v1.invalid.invalid.invalid'");
        assert.throws(() => Vault.migrateLegacyCredentials(DB.db));
        assert.strictEqual(DB.get('SELECT apiKeyEncrypted FROM twenty_workspace_links').apiKeyEncrypted, row.apiKeyEncrypted);
    });
});
