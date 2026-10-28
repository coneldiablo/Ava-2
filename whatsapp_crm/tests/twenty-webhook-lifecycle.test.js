'use strict';
// SQLite transaction/lease tests; native event delivery remains a separate gate.
const {describe,it,assert,createTestDB} = require('./test-helper');
const DB = require('../src/services/database.service');
const Service = require('../src/services/twenty/twenty.service');
const Store = require('../src/services/twenty/twenty-store.service');

async function fixture(fn) {
    createTestDB();
    const old = process.env.TWENTY_CREDENTIALS_MASTER_KEY;
    process.env.TWENTY_CREDENTIALS_MASTER_KEY = '42'.repeat(32);
    try {
        const hotel = await DB.createInstance({name:'Webhook lifecycle fixture'});
        Service.configure(hotel.id,{base_url:'https://crm.example.test',workspace_id:'workspace-fixture',api_key:'fixture-only',enabled:true});
        DB.run("INSERT INTO manager_tasks(taskId,instanceId,summary) VALUES ('fixture-task',?,'Fixture')",[hotel.id]);
        Store.upsertRecordLink({businessId:hotel.id,entityType:'manager_task',sourceTable:'manager_tasks',sourceId:'fixture-task',twentyObject:'tasks',twentyRecordId:'remote-fixture'});
        const event = {deliveryId:'fixture-delivery',businessId:hotel.id,workspaceId:'workspace-fixture',eventType:'task.updated',twentyObject:'task',twentyRecordId:'remote-fixture',payloadHash:'fixture-hash',payload:{data:{id:'remote-fixture',status:'DONE'}}};
        await fn({hotel,event});
    } finally {
        if (old === undefined) delete process.env.TWENTY_CREDENTIALS_MASTER_KEY;
        else process.env.TWENTY_CREDENTIALS_MASTER_KEY = old;
    }
}

describe('Twenty webhook lifecycle fencing',()=>{
    it('a queued webhook cannot change CRM after key replacement',()=>fixture(async ({hotel,event})=>{
        Store.saveWebhook(event);
        Service.configure(hotel.id,{api_key:'replacement-fixture'});
        assert.strictEqual(Service.processWebhookInbox(),0);
        assert.strictEqual(DB.get("SELECT status FROM manager_tasks WHERE taskId='fixture-task'").status,'new');
        assert.strictEqual(DB.get('SELECT lastErrorCode FROM twenty_webhook_inbox').lastErrorCode,'TWENTY_WEBHOOK_CONFIGURATION_CHANGED');
    }));
    it('disable then enable does not revive an old authenticated payload',()=>fixture(async ({hotel,event})=>{
        Store.saveWebhook(event);
        Service.configure(hotel.id,{enabled:false});
        Service.configure(hotel.id,{enabled:true});
        assert.strictEqual(Service.processWebhookInbox(),0);
        assert.strictEqual(Store.getIntegration(hotel.id).lastWebhookAt,null);
        Store.saveWebhook({...event,deliveryId:'new-authenticated-delivery'});
        assert.strictEqual(Service.processWebhookInbox(),1);
        assert.strictEqual(DB.get("SELECT status FROM manager_tasks WHERE taskId='fixture-task'").status,'done');
    }));
    it('store rejects cross-business or changed-payload delivery collisions',()=>fixture(async ({hotel,event})=>{
        Store.saveWebhook(event);
        assert.throws(()=>Store.saveWebhook({...event,payloadHash:'changed'}),{code:'TWENTY_WEBHOOK_DELIVERY_CONFLICT'});
        const other = await DB.createInstance({name:'Other fixture'});
        Service.configure(other.id,{base_url:'https://other.example.test',api_key:'other-fixture',enabled:true});
        assert.throws(()=>Store.saveWebhook({...event,businessId:other.id,workspaceId:null}),{code:'TWENTY_WEBHOOK_DELIVERY_CONFLICT'});
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM twenty_webhook_inbox').n,1);
    }));
    it('rejects a connection revision changed after signature verification',()=>fixture(async ({hotel,event})=>{
        const revision=Store.getIntegration(hotel.id).revision;
        Service.configure(hotel.id,{api_key:'replacement-fixture'});
        assert.throws(()=>Store.saveWebhook({...event,expectedRevision:revision}),{code:'TWENTY_WEBHOOK_CONFIGURATION_CHANGED'});
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM twenty_webhook_inbox').n,0);
    }));
    it('counts crashes as attempts and rejects an expired owner',()=>fixture(async ({event})=>{
        Store.saveWebhook(event);
        for (let attempt=1;attempt<=8;attempt++) {
            const [job]=Store.leaseWebhook(1,5);
            assert.strictEqual(job.attempts,attempt);
            DB.run("UPDATE twenty_webhook_inbox SET leasedUntil=datetime('now','-1 second') WHERE id=?",[job.id]);
            assert.throws(()=>Store.assertWebhookLease(job),{code:'TWENTY_WEBHOOK_FENCED'});
            assert.strictEqual(Store.finishWebhook(job.id,job.leaseToken,{status:'DONE'}),false);
            assert.deepStrictEqual(Store.leaseWebhook(1),[]);
            DB.run("UPDATE twenty_webhook_inbox SET nextAttemptAt=datetime('now','-1 second')");
        }
        assert.strictEqual(DB.get('SELECT status FROM twenty_webhook_inbox').status,'DEAD');
        assert.deepStrictEqual(Store.leaseWebhook(1),[]);
    }));
    it('CRM mutation, evidence and completion roll back together',()=>fixture(async ({hotel,event})=>{
        Store.saveWebhook(event);
        const original=Store.audit;
        Store.audit=()=>{throw new Error('fixture storage failure');};
        try { Service.processWebhookInbox(); }
        finally { Store.audit=original; }
        assert.strictEqual(DB.get("SELECT status FROM manager_tasks WHERE taskId='fixture-task'").status,'new');
        assert.strictEqual(Store.getIntegration(hotel.id).lastWebhookAt,null);
        assert.strictEqual(DB.get('SELECT status FROM twenty_webhook_inbox').status,'PENDING');
    }));
    it('legacy unbound queued rows remain visible but cannot be applied',()=>fixture(async ({event})=>{
        Store.saveWebhook(event);
        DB.run('UPDATE twenty_webhook_inbox SET integrationRevision=NULL');
        DB.createTwentyTables();
        assert.strictEqual(DB.get('SELECT lastErrorCode FROM twenty_webhook_inbox').lastErrorCode,'TWENTY_WEBHOOK_LEGACY_REVERIFICATION_REQUIRED');
        assert.strictEqual(Service.processWebhookInbox(),0);
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM twenty_webhook_inbox').n,1);
    }));
});
