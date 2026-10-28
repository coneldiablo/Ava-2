'use strict';
// HTTP fixtures exercise production sync code. Native Twenty acceptance is a
// separate, licensed environment gate; these tests do not claim it passed.
const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Store = require('../src/services/twenty/twenty-store.service');
const Service = require('../src/services/twenty/twenty.service');
const { TwentyClient } = require('../src/services/twenty/twenty-client');

async function fixture(fn) {
    createTestDB();
    const oldRole = process.env.AVA_PROCESS_ROLE, oldKey = process.env.TWENTY_CREDENTIALS_MASTER_KEY;
    const oldFactory = Service.clientFactory;
    process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
    process.env.TWENTY_CREDENTIALS_MASTER_KEY = '22'.repeat(32);
    const hotel = require('../src/services/provisioning/business-provisioning-store.service')
        .createBusinessAtomic({ name: 'Bootstrap hotel', businessType: 'hotel' }).instance;
    Service.configure(hotel.id, { base_url: 'https://crm.example.test', workspace_id: 'new-workspace', api_key: 'fixture-only-key', enabled: true, mode: 'shadow' });
    DB.run(`UPDATE business_provisioning_jobs SET status='LEASED',leaseToken='fixture-lease',leasedUntil=datetime('now','+120 seconds'),checkpointJson=?
        WHERE businessId=? AND module='crm_workspace'`, [JSON.stringify({ createRequested: true, workspaceId: 'new-workspace', schemaApplied: true }), hotel.id]);
    const remote = new Map(), requests = [];
    Service.clientFactory = () => ({
        createRecord: async (object, payload) => { requests.push(['create',object,payload]); remote.set(payload.id, payload); return payload; },
        updateRecord: async (object, id, payload) => { requests.push(['update',object,payload]); remote.set(id, {...payload,id}); return {id}; },
        getRecord: async (_object,id) => { requests.push(['read',id]); return remote.get(id); },
    });
    try { await fn({hotel,remote,requests}); }
    finally {
        Service.clientFactory = oldFactory;
        if (oldRole === undefined) delete process.env.AVA_PROCESS_ROLE; else process.env.AVA_PROCESS_ROLE = oldRole;
        if (oldKey === undefined) delete process.env.TWENTY_CREDENTIALS_MASTER_KEY; else process.env.TWENTY_CREDENTIALS_MASTER_KEY = oldKey;
    }
}

describe('A03 real initial projection and A05 sync fencing', () => {
    it('old revision readback cannot certify a changed integration', () => fixture(async ({hotel}) => {
        Store.queueBootstrapSync(hotel.id);
        await Service.processOutbox(10);
        assert.strictEqual(Store.bootstrapVerification(hotel.id), true);
        Store.updateStatus(hotel.id, { mappings: { person: 'changedProjection' } });
        assert.strictEqual(Store.bootstrapVerification(hotel.id), false);
    }));

    it('repeated sync worker crashes exhaust attempts and expired worker cannot finish', () => fixture(async ({hotel}) => {
        Store.queueBootstrapSync(hotel.id);
        for (let attempt = 1; attempt <= 8; attempt++) {
            const [job] = Store.leaseOutbox(1, 5);
            assert.strictEqual(job.attempts, attempt);
            DB.run("UPDATE twenty_sync_outbox SET leasedUntil=datetime('now','-1 second') WHERE eventId=?", [job.eventId]);
            assert.strictEqual(Store.finishOutbox(job.eventId,job.leaseToken,{status:'DONE'}), false);
            assert.deepStrictEqual(Store.leaseOutbox(1), []);
            DB.run("UPDATE twenty_sync_outbox SET nextAttemptAt=datetime('now','-1 second')");
        }
        assert.deepStrictEqual(Store.leaseOutbox(1), []);
        assert.strictEqual(DB.get('SELECT status FROM twenty_sync_outbox').status,'DEAD');
        assert.strictEqual(DB.get('SELECT attempts FROM twenty_sync_outbox').attempts,8);
        assert.strictEqual(Store.bootstrapVerification(hotel.id),false);
    }));
    it('only worker-authorized initial rows write in shadow and are read back', () => fixture(async ({hotel,requests,remote}) => {
        assert.strictEqual(Store.queueBootstrapSync(hotel.id), 1);
        DB.run('INSERT INTO clients(instanceId,chatId,senderName) VALUES (?,?,?)', [hotel.id, '79990000000@c.us', 'Later guest']);
        await Service.processOutbox(10);
        assert.strictEqual(remote.size, 1);
        assert.strictEqual(requests[0][1], 'companies');
        assert.ok(requests.some(row => row[0] === 'read'));
        assert.ok(DB.get('SELECT verifiedAt FROM twenty_bootstrap_events').verifiedAt);
        assert.strictEqual(DB.get("SELECT status FROM twenty_sync_outbox WHERE sourceTable='clients'").status, 'SHADOWED');
        assert.strictEqual([...remote.values()][0].avaBusinessId, String(hotel.id));
    }));

    it('web process and pre-existing workspace cannot authorize bootstrap writes', () => fixture(async ({hotel}) => {
        process.env.AVA_PROCESS_ROLE = 'web';
        assert.throws(() => Store.queueBootstrapSync(hotel.id), { code: 'TWENTY_BOOTSTRAP_WORKER_REQUIRED' });
        process.env.AVA_PROCESS_ROLE = 'provisioning-worker';
        DB.run("UPDATE business_provisioning_jobs SET checkpointJson='{}' WHERE businessId=?", [hotel.id]);
        assert.throws(() => Store.queueBootstrapSync(hotel.id), { code: 'TWENTY_BOOTSTRAP_NOT_AUTHORIZED' });
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM twenty_bootstrap_events').n, 0);
    }));

    it('disable during POST prevents stale readback, link and success evidence', () => fixture(async ({hotel,requests}) => {
        Store.queueBootstrapSync(hotel.id);
        Service.clientFactory = () => ({ createRecord: async (_object,payload) => {
            Store.updateStatus(hotel.id, { enabled: false, connectionStatus: 'disabled' });
            return payload;
        }, getRecord: async () => { requests.push('forbidden-read'); } });
        await Service.processOutbox(1);
        assert.deepStrictEqual(requests, []);
        assert.strictEqual(Store.getIntegration(hotel.id).enabled, 0);
        assert.strictEqual(Store.getIntegration(hotel.id).connectionStatus, 'disabled');
        assert.strictEqual(DB.get('SELECT verifiedAt FROM twenty_bootstrap_events').verifiedAt, null);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM twenty_record_links').n, 0);
    }));

    it('mismatched readback never becomes verified initial synchronization', () => fixture(async ({hotel}) => {
        Store.queueBootstrapSync(hotel.id);
        let id;
        Service.clientFactory = () => ({ createRecord: async (_object,payload) => { id=payload.id; return payload; },
            getRecord: async () => ({id,avaBusinessId:'foreign-business'}) });
        await Service.processOutbox(1);
        assert.strictEqual(DB.get('SELECT verifiedAt FROM twenty_bootstrap_events').verifiedAt, null);
        assert.strictEqual(DB.get('SELECT lastErrorCode FROM twenty_sync_outbox').lastErrorCode, 'TWENTY_READBACK_MISMATCH');
    }));

    it('HTTP retries check revocation and cannot follow redirects with credentials', async () => {
        let active = true, calls = 0;
        const client = new TwentyClient({ baseUrl:'https://crm.example.test', apiKey:'fixture-only', transport: { request: async options => {
            assert.strictEqual(options.maxRedirects, 0);
            assert.strictEqual(options.proxy, false);
            calls++; active=false;
            throw Object.assign(new Error('fixture outage'), {response:{status:503}});
        } } });
        await assert.rejects(client.request('POST','/rest/companies',{assertActive:()=>{
            if (!active) throw Object.assign(new Error('revoked'),{code:'TWENTY_SYNC_FENCED'});
        }}),{code:'TWENTY_SYNC_FENCED'});
        assert.strictEqual(calls,1);
    });
});
