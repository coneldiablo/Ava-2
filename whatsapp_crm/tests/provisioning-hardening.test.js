const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Store = require('../src/services/provisioning/business-provisioning-store.service');
const Worker = require('../src/services/provisioning/business-provisioning-worker.service');
const Credentials = require('../src/services/onyx/onyx-credentials');
const { OnyxProvisionerService } = require('../src/services/onyx/onyx-provisioner.service');
const { TwentyProvisionerService } = require('../src/services/twenty/twenty-provisioner.service');
const TwentyStore = require('../src/services/twenty/twenty-store.service');
const { decryptJson } = require('../src/services/twenty/twenty-crypto');
const { Worker: Thread } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

async function jobFixture() {
    createTestDB();
    const business = await DB.createInstance({ name: 'Hardening hotel' });
    DB.run("INSERT INTO business_provisioning_jobs(businessId,module,stage,status) VALUES (?,'knowledge_base','init','PENDING')", [business.id]);
    return business;
}
function controlPlane(overrides = {}) {
    const workspaces = [];
    return {
        workspaces,
        findWorkspace: async ({ slug }) => workspaces.find(ws => ws.subdomain === slug) || null,
        countWorkspaces: async () => workspaces.length,
        createWorkspace: async ({ slug }) => {
            const ws = { id: crypto.randomUUID(), subdomain: slug, activationStatus: 'ACTIVE', workspaceUrl: 'https://hotel.example.test' };
            workspaces.push(ws);
            return ws;
        },
        configureMembership: async () => ({ configured: true }),
        issueWorkspaceApiKey: async () => ({ apiKey: 'fixture-native-runtime-value' }),
        applySchemaManifest: async () => ({ objectsCreated: 0, fieldsCreated: 0, fieldsVerified: 1 }),
        testConnection: async () => true,
        ...overrides,
    };
}

describe('Provisioning audit regressions (local DB and explicit upstream contracts)', () => {
    it('background poller processes a real pending row without manual processQueue', async () => {
        await jobFixture();
        Worker.startBackgroundPoller(10);
        try {
            const deadline = Date.now() + 2000;
            while (Date.now() < deadline && DB.get('SELECT status FROM business_provisioning_jobs').status !== 'DONE') {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.strictEqual(DB.get('SELECT status FROM business_provisioning_jobs').status, 'DONE');
        } finally { Worker.stopBackgroundPoller(); }
    });

    it('two independent SQLite workers lease a job only once', async () => {
        await jobFixture();
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-queue-test-'));
        const databasePath = path.join(directory, 'queue.db');
        await DB.db.backup(databasePath);
        const run = () => new Promise((resolve, reject) => {
            const thread = new Thread(`
                const {workerData,parentPort}=require('worker_threads');
                const DB=require(workerData.dbModule);
                DB.db=new (require(workerData.sqlite))(workerData.path);
                const Store=require(workerData.storeModule);
                parentPort.postMessage(Store.leaseJobs(1).map(job=>job.id));
                DB.db.close();
            `, { eval: true, workerData: {
                path: databasePath, sqlite: require.resolve('better-sqlite3'),
                dbModule: require.resolve('../src/services/database.service'),
                storeModule: require.resolve('../src/services/provisioning/business-provisioning-store.service'),
            }});
            thread.once('message', resolve);
            thread.once('error', reject);
            thread.once('exit', code => { if (code) reject(new Error(`worker exited ${code}`)); });
        });
        try { assert.strictEqual((await Promise.all([run(),run()])).flat().length, 1); }
        finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });

    it('expired worker cannot overwrite checkpoint, renew lease or finalize', async () => {
        await jobFixture();
        const first = Store.leaseJobs(1)[0];
        DB.run("UPDATE business_provisioning_jobs SET leasedUntil=datetime('now','-1 second') WHERE id=?", [first.id]);
        assert.strictEqual(Store.renewLease(first.id, first.leaseToken), false);
        const second = Store.leaseJobs(1)[0];
        Store.updateJobCheckpoint(second.id, second.leaseToken, { owner: 'second' });
        assert.throws(() => Store.updateJobCheckpoint(first.id, first.leaseToken, { owner: 'first' }), { code: 'PROVISIONING_LEASE_LOST' });
        Store.finishJob(first.id, first.leaseToken, { status: 'DONE' });
        const row = DB.get('SELECT * FROM business_provisioning_jobs');
        assert.strictEqual(row.status, 'LEASED');
        assert.strictEqual(JSON.parse(row.checkpointJson).owner, 'second');
    });

    it('worker renews an in-flight lease and leaves waiting jobs unleased', async () => {
        const business=await jobFixture();
        DB.run("INSERT INTO business_provisioning_jobs(businessId,module,stage,status) VALUES (?,'whatsapp','init','PENDING')",[business.id]);
        const execute=Worker._executeJob, renew=Store.renewLease, interval=global.setInterval;
        let renewals=0, first=true;
        global.setInterval=(fn,ms,...args)=>interval(fn,ms===15000?5:ms,...args);
        Store.renewLease=(...args)=>{renewals++; return renew.apply(Store,args);};
        Worker._executeJob=async()=>{
            if(first) {
                first=false;
                assert.strictEqual(DB.get("SELECT status FROM business_provisioning_jobs WHERE module='whatsapp'").status,'PENDING');
                await new Promise(resolve=>setTimeout(resolve,30));
            }
            return {status:'DONE'};
        };
        try { await Worker.processQueue(); assert.ok(renewals>0); }
        finally { Worker._executeJob=execute; Store.renewLease=renew; global.setInterval=interval; }
    });

    it('disabled business cannot be leased, checkpointed, retried or finalized', async () => {
        const business = await jobFixture();
        const job = Store.leaseJobs(1)[0];
        DB.run('UPDATE instances SET isActive=0 WHERE id=?', [business.id]);
        assert.throws(() => Store.updateJobCheckpoint(job.id, job.leaseToken, {}), { code: 'PROVISIONING_LEASE_LOST' });
        assert.throws(() => Store.retryJobs(business.id));
        Store.finishJob(job.id, job.leaseToken, { status: 'DONE' });
        assert.strictEqual(DB.get('SELECT status FROM business_provisioning_jobs').status, 'LEASED');
        assert.deepStrictEqual(Store.leaseJobs(), []);
    });

    it('checkpoint sanitizer removes nested and legacy credentials', async () => {
        await jobFixture();
        DB.run('UPDATE business_provisioning_jobs SET checkpointJson=?', [JSON.stringify({apiKey:'secret', nested:{password:'password',token:'token'}, workspaceId:'native-id'})]);
        Store.sanitizeLegacyCheckpoints();
        const job = Store.leaseJobs(1)[0];
        assert.deepStrictEqual(JSON.parse(job.checkpointJson), {nested:{},workspaceId:'native-id'});
        Store.updateJobCheckpoint(job.id, job.leaseToken, {api_key:'secret', accessToken:'secret', refresh_token:'secret',
            credentials:{password:'secret'}, membershipConfigured:true});
        assert.deepStrictEqual(JSON.parse(DB.get('SELECT checkpointJson FROM business_provisioning_jobs').checkpointJson), {membershipConfigured:true});
        Store.finishJob(job.id, job.leaseToken, {status:'FAILED', retryable:false, checkpoint:{token:'secret',slug:'hotel'}});
        assert.deepStrictEqual(JSON.parse(DB.get('SELECT checkpointJson FROM business_provisioning_jobs').checkpointJson), {slug:'hotel'});
    });

    it('managed keys are encrypted, rotate immediately, and cannot cross business scope', async () => {
        const business = await jobFixture();
        process.env.ONYX_CREDENTIALS_MASTER_KEY = '33'.repeat(32);
        const ref = Credentials.save(business.id, 'first-fixture-native-key');
        assert.strictEqual(Credentials.resolve(business.id), 'first-fixture-native-key');
        const row = DB.get('SELECT * FROM onyx_tenant_credentials');
        assert.strictEqual(row.token, '');
        assert.ok(!JSON.stringify(row).includes('first-fixture-native-key'));
        assert.throws(() => Credentials.resolve(business.id+1, ref), {code:'ONYX_CREDENTIAL_UNAVAILABLE'});
        assert.throws(() => Credentials.open(row.token_encrypted, business.id+1, ref), {code:'ONYX_CREDENTIALS_INVALID'});
        Credentials.save(business.id, 'rotated-fixture-native-key');
        assert.strictEqual(Credentials.resolve(business.id), 'rotated-fixture-native-key');
        process.env[ref] = 'cached-old-key';
        Credentials.revoke(business.id);
        assert.strictEqual(process.env[ref], undefined);
        assert.throws(() => Credentials.resolve(business.id), {code:'ONYX_CREDENTIAL_UNAVAILABLE'});
    });

    it('legacy fake key is erased and never accepted as a native credential', async () => {
        const business = await jobFixture();
        DB.run('DROP TABLE onyx_tenant_credentials');
        DB.run('CREATE TABLE onyx_tenant_credentials(env_ref TEXT PRIMARY KEY, token TEXT NOT NULL, business_id INTEGER NOT NULL)');
        DB.run('INSERT INTO onyx_tenant_credentials VALUES (?,?,?)', [`ONYX_API_KEY_HOTEL_${business.id}`, 'sk-onyx-tenant-1-fake', business.id]);
        Credentials.ensureSchema();
        const row = DB.get('SELECT * FROM onyx_tenant_credentials');
        assert.strictEqual(row.token, '');
        assert.strictEqual(row.enabled, 0);
        assert.throws(() => Credentials.save(business.id, 'sk-onyx-tenant-1-fake'), {code:'ONYX_NATIVE_CREDENTIAL_REQUIRED'});
    });

    it('Twenty default path cannot fabricate native workspace/membership/API key', async () => {
        const business = await jobFixture();
        const p = new TwentyProvisionerService();
        await assert.rejects(p.provisionWorkspace(business.id, business), {code:'TWENTY_PROVISIONING_CREDENTIALS_REQUIRED'});
        await assert.rejects(p.createWorkspace({}), {code:'TWENTY_PROVISIONING_CREDENTIALS_REQUIRED'});
        await assert.rejects(p.configureMembership({}), {code:'TWENTY_PROVISIONING_CREDENTIALS_REQUIRED'});
        await assert.rejects(p.issueWorkspaceApiKey({}), {code:'TWENTY_PROVISIONING_CREDENTIALS_REQUIRED'});
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM twenty_workspace_links').n, 0);
    });

    it('lost Twenty create response reconciles by slug without a second create', async () => {
        process.env.TWENTY_CREDENTIALS_MASTER_KEY = '22'.repeat(32);
        const business = await jobFixture();
        const adapter = controlPlane();
        const create = adapter.createWorkspace;
        let creates = 0;
        adapter.createWorkspace = async input => { creates++; await create(input); throw new Error('Lost response'); };
        const p = new TwentyProvisionerService({apiAdapter:adapter});
        let checkpoint;
        await assert.rejects(p.provisionWorkspace(business.id,business,{}, {onCheckpoint:cp => {checkpoint=cp;}}), /Lost response/);
        assert.strictEqual(checkpoint.createRequested, true);
        assert.strictEqual(checkpoint.workspaceId, undefined);
        process.env.AVA_PUBLIC_BASE_URL = 'https://ava.example.test';
        process.env.TWENTY_CREDENTIALS_MASTER_KEY = '22'.repeat(32);
        const result = await p.provisionWorkspace(business.id,business,checkpoint);
        assert.strictEqual(creates, 1);
        assert.strictEqual(result.status, 'SKIPPED');
        assert.strictEqual(result.checkpoint.initialSyncVerified, false);
    });

    it('uncertain workspace identity never triggers a blind create', async () => {
        process.env.TWENTY_CREDENTIALS_MASTER_KEY = '22'.repeat(32);
        const business = await jobFixture();
        let creates=0;
        const p = new TwentyProvisionerService({apiAdapter:controlPlane({createWorkspace:async()=>{creates++;}})});
        await assert.rejects(p.provisionWorkspace(business.id,business,{createRequested:true,slug:'hotel'}), {code:'TWENTY_CREATE_RECONCILIATION_REQUIRED'});
        assert.strictEqual(creates, 0);
    });

    it('Twenty key is encrypted before a schema failure and absent from every checkpoint', async () => {
        const business = await jobFixture();
        process.env.TWENTY_CREDENTIALS_MASTER_KEY = '22'.repeat(32);
        const checkpoints=[];
        const p = new TwentyProvisionerService({apiAdapter:controlPlane({applySchemaManifest:async()=>{throw new Error('schema unavailable');}})});
        let failure;
        try { await p.provisionWorkspace(business.id,business,{}, {onCheckpoint:cp=>checkpoints.push(cp)}); }
        catch(error) { failure=error; }
        assert.ok(failure);
        assert.ok(!JSON.stringify([...checkpoints,failure.checkpoint]).includes('fixture-native-runtime-value'));
        assert.strictEqual(decryptJson(TwentyStore.getIntegrationUnsafe(business.id).apiKeyEncrypted, { businessId: business.id }).apiKey, 'fixture-native-runtime-value');
    });

    it('metadata API outage is not replaced by fabricated object IDs', async () => {
        const p = new TwentyProvisionerService({clientFactory:()=>({request:async()=>{throw Object.assign(new Error('Unavailable'),{statusCode:503});}})});
        await assert.rejects(p.applySchemaManifest('https://crm.example.test','fixture-key'), /Unavailable/);
    });

    it('metadata conflict requires a matching readback, not only HTTP 409', async () => {
        const manifest={standard_object_fields:{companies:['avaBusinessId']},field_definitions:{avaBusinessId:{type:'TEXT'}}};
        let reads=0;
        const p=new TwentyProvisionerService({clientFactory:()=>({request:async(method,url)=>{
            if(url.endsWith('/objects'))return {data:[{id:'native-object',namePlural:'companies'}]};
            if(method==='POST')throw Object.assign(new Error('Conflict'),{statusCode:409});
            reads++;
            return {data:reads===1?[]:[{id:'native-field',name:'avaBusinessId',objectMetadataId:'native-object',type:'NUMBER'}]};
        }})});
        await assert.rejects(p.applySchemaManifest('https://crm.example.test','fixture-key',manifest), {code:'TWENTY_SCHEMA_TYPE_MISMATCH'});
    });

    it('conflicting document owners are rejected before ingestion', async () => {
        const business=await jobFixture();
        const other=await DB.createInstance({name:'Other hotel'});
        DB.run("INSERT INTO knowledge_base(instanceId,business_id,title,filename,originalName,content) VALUES (?,?, 'x','x','x','foreign content')", [business.id,other.id]);
        let ingested=0;
        const p=new OnyxProvisionerService();
        await assert.rejects(p.syncBusinessDocuments(business.id,business.id,1,{ingestDocument:async()=>{ingested++;}}), {code:'ONYX_KNOWLEDGE_SCOPE_MISMATCH'});
        assert.strictEqual(ingested,0);
    });

    it('missing native model IDs and unverified version do not fall back to 1/v4.7', async () => {
        const business=await jobFixture();
        const p=new OnyxProvisionerService({gateway:{issueToken:()=>({token:'fixture'})}});
        await assert.rejects(p.ensurePrivateLlmProvider(business.id,{getLlmProviders:async()=>[],putLlmProvider:async()=>({})}), {code:'ONYX_MODEL_NOT_VERIFIED'});
        await assert.rejects(p.verifyOnyxCapabilities({getVersion:async()=>{throw new Error('404');},getHealth:async()=>({status:'healthy'})}), {code:'ONYX_VERSION_UNSUPPORTED'});
    });

    it('MCP bindings become visible only after native persona tools are read back', async () => {
        const business=await jobFixture();
        const name=`AVA Hotel ${business.id} sales`, baseUrl='https://onyx.example.test';
        DB.run(`INSERT INTO onyx_agent_bindings(business_id,role,onyx_base_url,persona_id,document_set_id,document_set_name,model_configuration_id,search_tool_id)
            VALUES (?,'sales',?,11,21,'fixture-set',31,41)`,[business.id,baseUrl]);
        const persona={name,is_public:false,document_sets:[{id:21}],default_model_configuration_id:31,tool_ids:[41],system_prompt:'Keep operator prompt'};
        const actions=['get_customer','get_booking','get_availability','get_hotel_info','get_call_history','get_campaign'];
        const publicUrl=process.env.WHATSAPP_CRM_PUBLIC_URL||process.env.APP_PUBLIC_URL||'https://app.crm.meludtech.tech';
        const client={baseUrl,
            getMcpServers:async()=>[{id:51,name:'AVA Read Actions',server_url:`${publicUrl.replace(/\/+$/,'')}/api/integrations/onyx/mcp`}],
            getMcpServerTools:async()=>actions.map((name,i)=>({id:61+i,name,mcp_server_id:51})),
            getPersona:async()=>persona, updateMcpServerTools:async()=>{}, updatePersona:async()=>({}),
        };
        const p=new OnyxProvisionerService();
        const bindings=[{role:'sales',personaId:11,name}];
        await assert.rejects(p.ensureMcpBindings(business.id,bindings,client),{code:'ONYX_CROSS_TENANT_VIOLATION'});
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM onyx_mcp_tool_bindings').n,0);
        client.updatePersona=async(_,payload)=>{Object.assign(persona,payload);};
        await p.ensureMcpBindings(business.id,bindings,client);
        assert.strictEqual(persona.system_prompt,'Keep operator prompt');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM onyx_mcp_tool_bindings').n,4);
        assert.ok(!persona.tool_ids.includes(65),'Sales must not receive call-history tool');
    });

    it('native Onyx HTTP key contract uses group_ids and actual returned key', async () => {
        const http=require('http');
        const {OnyxClient}=require('../src/services/onyx/onyx-client');
        let captured;
        const server=http.createServer((request,response)=>{
            let body='';request.on('data',chunk=>{body+=chunk;});request.on('end',()=>{
                captured={url:request.url,method:request.method,auth:request.headers.authorization,body:JSON.parse(body)};
                response.writeHead(200,{'Content-Type':'application/json'});
                response.end(JSON.stringify({api_key_id:17,api_key:'fixture-issued-by-native-endpoint',user_id:'fixture-service-user'}));
            });
        });
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        try {
            const client=new OnyxClient({baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'fixture-admin'});
            const key=await client.createApiKey('AVA_RUNTIME_KEY_1');
            assert.strictEqual(key.api_key,'fixture-issued-by-native-endpoint');
            assert.deepStrictEqual(captured,{url:'/admin/api-key',method:'POST',auth:'Bearer fixture-admin',body:{name:'AVA_RUNTIME_KEY_1',group_ids:[]}});
        } finally { await new Promise(resolve=>server.close(resolve)); }
    });
});
