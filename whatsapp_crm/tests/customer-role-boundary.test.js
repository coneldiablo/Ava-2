'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const express = require('express');
const axios = require('axios');
const config = require('../src/config');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const Access = require('../src/services/identity/customer-access');
const Boundary = require('../src/services/identity/customer-role-boundary');
const AI = require('../src/services/dashboard/ai');
const Audio = require('../src/services/dashboard/ai.audio');
const LocalKnowledge = require('../src/services/knowledge-local.service');
const NativeCrm = require('../src/services/customer-native-crm.service');
const ROLES = ['hotel_owner','sales_lead','manager','observer'];

function fixture() {
    createTestDB();
    Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES (1,'Role business'),(2,'Foreign business')");
    DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES (1,'own','Own'),(2,'foreign','Foreign')");
    const users = {};
    for (const role of ROLES) {
        DB.run('INSERT INTO ava_users(id,subject,email,displayName) VALUES (?,?,?,?)',
            [role, `${role}-subject`, `${role}@example.test`, role]);
        DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES (?,1,?)', [role,role]);
        users[role] = { actor: Identity.actor(role), token: Identity.createSession(`${role}-subject`, `${role}-sid`) };
    }
    DB.run("UPDATE clients SET assigneeUserId='manager' WHERE instanceId=1 AND chatId='own'");
    DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES (1,'other','Other assigned','sales_lead'),(1,'queue','Unassigned',NULL)");
    const Canonical=require('../src/services/client-identity.service');
    Canonical.attach(1,'own',{kind:'phone',value:'+79990000011'});
    Canonical.attach(1,'other',{kind:'phone',value:'+79990000012'});
    return users;
}

async function runtime(run, { boundary = true, actualApi = false } = {}) {
    const users = fixture();
    const oldEnabled = Auth.config.enabled, oldCustomer = process.env.AVA_CUSTOMER_ACCESS_ENABLED;
    const oldUrl = process.env.WHATSAPP_CRM_PUBLIC_URL;
    Auth.config.enabled = true;
    process.env.AVA_CUSTOMER_ACCESS_ENABLED = 'true';
    process.env.WHATSAPP_CRM_PUBLIC_URL = 'https://ava.example.test';
    const app = express();
    app.use(express.json());
    app.use('/api', Auth.requireAuth.bind(Auth));
    if (boundary) app.use('/api', Boundary);
    app.use('/api', require('../src/routes/customer-deals.routes'));
    app.use('/api', require('../src/routes/customer-calls.routes'));
    app.use('/api', require('../src/routes/dashboard-intelligence.routes'));
    app.use('/api', require('../src/routes/customer-native-crm.routes'));
    app.use('/api', require('../src/routes/sales-workspace.routes'));
    app.use('/api', require('../src/routes/dashboard-ai.routes'));
    app.use('/api', require('../src/routes/customer-knowledge-preview.routes'));
    app.use('/api', require('../src/routes/customer-business-gpt.routes'));
    app.use('/api', require('../src/routes/client-identity.routes'));
    if (actualApi) app.use('/api', require('../src/routes/api.routes'));
    const calls = { operational: 0, settings: 0, unexpected: 0 };
    const preparation = { beforeDispatch: async()=>{} };
    app.put('/api/clients/:instanceId/:chatId/status', Access.forRoute('put','/clients/:instanceId/:chatId/status'), (req,res) => {
        req.reauthorizeCustomerAction?.();
        calls.operational++;
        DB.run('UPDATE clients SET leadStatus=? WHERE instanceId=? AND chatId=?', [req.body.status, req.params.instanceId, req.params.chatId]);
        res.json({success:true});
    });
    app.post('/api/clients/:instanceId/:chatId/send-message', Access.forRoute('post','/clients/:instanceId/:chatId/send-message'), async (req,res) => {
        try {
            await preparation.beforeDispatch();
            req.reauthorizeCustomerAction?.();
            calls.operational++; res.json({success:true,chatId:req.params.chatId});
        } catch(error) {res.status(error.statusCode||403).json({success:false,code:error.code||error.message});}
    });
    for (const [method,path] of [ ['put','/clients/:instanceId/:chatId/tags'], ['post','/ai/summary/:instanceId/:chatId'], ['post','/ai/next-step/:instanceId/:chatId'] ]) {
        app[method](`/api${path}`, Access.forRoute(method,path), (req,res)=>{calls.operational++;res.json({success:true,chatId:req.params.chatId});});
    }
    app.put('/api/channels/:instanceId/config', Access.forRoute('put','/channels/:instanceId/config'), (_req,res) => {
        calls.settings++; res.json({success:true});
    });
    app.post('/api/new-unreviewed-mutation', (_req,res) => { calls.unexpected++; res.json({success:true}); });
    app.get('/api/dashboard/:businessId/ai/briefingXpdf', (_req,res) => { calls.unexpected++; res.json({success:true}); });
    app.get('/api/health', (_req,res) => { calls.unexpected++; res.json({success:true}); });
    const listener = await new Promise(resolve => { const server = app.listen(0,'127.0.0.1',()=>resolve(server)); });
    const base = `http://127.0.0.1:${listener.address().port}`;
    const request = (role, path, method='GET', body, extras={}) => fetch(`${base}/api${path}`, {
        method,
        headers: { Cookie:`crm_session=ava2:${users[role].token}`, Origin:'https://ava.example.test',
            'Content-Type':'application/json', ...extras },
        ...(body === undefined ? {} : {body:JSON.stringify(body)}),
    });
    try { await run({users, request, calls, preparation}); }
    finally {
        await new Promise(resolve=>listener.close(resolve));
        Auth.config.enabled = oldEnabled;
        if (oldCustomer === undefined) delete process.env.AVA_CUSTOMER_ACCESS_ENABLED; else process.env.AVA_CUSTOMER_ACCESS_ENABLED = oldCustomer;
        if (oldUrl === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL; else process.env.WHATSAPP_CRM_PUBLIC_URL = oldUrl;
    }
}

describe('Customer role boundary: direct HTTP with real live sessions', () => {
    it('keeps all roles same-business reads and permits durable deal writes only for active sales roles', async () => runtime(async ({request}) => {
        for (const role of ROLES) {
            assert.strictEqual((await request(role,'/deals/1')).status,200,role);
            assert.strictEqual((await request(role,'/deals/2')).status,403,role);
            const result = await request(role,'/deals/1','POST',{title:`${role} deal`});
            assert.strictEqual(result.status,role==='observer'?403:201,role);
        }
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM customer_deals').n,3);
    }));

    it('denies observer operational messages/status and owner settings, including forged role/capabilities', async () => runtime(async ({request,calls}) => {
        for (const role of ROLES) {
            const forged = {status:'qualified',role:'hotel_owner',capabilities:['sales.write','business.manage'],userId:'hotel_owner'};
            assert.strictEqual((await request(role,'/clients/1/own/status','PUT',forged)).status,role==='observer'?403:200,role);
            assert.strictEqual((await request(role,'/clients/1/own/send-message','POST',{text:'Fixture only'})).status,role==='observer'?403:200,role);
            assert.strictEqual((await request(role,'/channels/1/config','PUT',{telegramBotToken:'fixture-token'})).status,role==='hotel_owner'?200:403,role);
            assert.strictEqual((await request(role,'/channels/2/config','PUT',{})).status,403,role);
        }
        assert.strictEqual(calls.operational,6);
        assert.strictEqual(calls.settings,1);
    }));

    it('blocks unreviewed routes for every customer, including owner and read aliases with an unescaped PDF dot', async () => runtime(async ({request,calls}) => {
        for (const role of ROLES) {
            assert.strictEqual((await request(role,'/new-unreviewed-mutation','POST',{})).status,403,role);
            assert.strictEqual((await request(role,'/dashboard/1/ai/briefingXpdf')).status,403,role);
        }
        assert.strictEqual((await request('observer','/dashboard/1/ai/briefing.pdf')).status,200);
        assert.strictEqual(calls.unexpected,0);
    }));

    it('rechecks a still-valid cookie after business revocation, demotion and account disable', async () => runtime(async ({request,users}) => {
        assert.strictEqual((await request('manager','/deals/1','POST',{title:'Allowed before demotion'})).status,201);
        DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId='manager' AND businessId=1");
        assert.strictEqual(users.manager.actor.memberships[0].role,'manager');
        assert.strictEqual((await request('manager','/deals/1','POST',{title:'Denied after demotion'})).status,403);
        assert.strictEqual((await request('manager','/deals/1')).status,200);
        DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='manager' AND businessId=1");
        assert.strictEqual((await request('manager','/deals/1')).status,403);
        DB.run("UPDATE ava_users SET enabled=0 WHERE id='observer'");
        const disabled = await request('observer','/deals/1');
        assert.ok([401,403].includes(disabled.status));
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM customer_deals').n,1);
    }));

    it('rejects cross-business body/query overrides and cross-site mutations before any write', async () => runtime(async ({request,calls}) => {
        assert.strictEqual((await request('manager','/clients/1/own/status','PUT',{status:'qualified',businessId:2})).status,403);
        assert.strictEqual((await request('manager','/deals/1?instanceId=2','POST',{title:'Foreign'})).status,403);
        assert.strictEqual((await request('hotel_owner','/channels/1/config','PUT',{}, {Origin:'https://evil.example'})).status,403);
        assert.strictEqual((await request('manager','/clients/1/own/send-message','POST',{text:'Fixture'}, {'Sec-Fetch-Site':'cross-site'})).status,403);
        assert.strictEqual(calls.operational,0);
        assert.strictEqual(calls.settings,0);
    }));

    it('denies observer paid GET overview/audio before providers and keeps read briefing available', async () => runtime(async ({request}) => {
        const oldOverview=AI.overview, oldCapability=Audio.capability, oldProbe=Audio.probe, oldSynthesize=Audio.synthesize;
        let overviewCalls=0, audioCalls=0;
        AI.overview=async()=>{overviewCalls++;return {businessId:1,status:'fixture'};};
        Audio.capability=()=>({available:true}); Audio.probe=async()=>({available:true});
        Audio.synthesize=async()=>{audioCalls++;return Buffer.from('fixture audio');};
        try {
            assert.strictEqual((await request('observer','/dashboard/1/ai/briefing')).status,200);
            for (const role of ROLES) {
                assert.strictEqual((await request(role,'/dashboard/1/ai/overview?window=yesterday')).status,role==='observer'?403:200,role);
                assert.strictEqual((await request(role,'/dashboard/1/ai/briefing/audio')).status,role==='observer'?403:200,role);
            }
            assert.strictEqual(overviewCalls,3); assert.strictEqual(audioCalls,3);
        } finally {AI.overview=oldOverview;Audio.capability=oldCapability;Audio.probe=oldProbe;Audio.synthesize=oldSynthesize;}
    }));

    it('blocks paid generation even when standalone routers are mounted without the global boundary', async () => runtime(async ({request}) => {
        const oldOverview=AI.overview,oldLookup=LocalKnowledge.lookup;
        let providerCalls=0;
        AI.overview=async()=>{providerCalls++;return {};};
        LocalKnowledge.lookup=async()=>{providerCalls++;return null;};
        try {
            assert.strictEqual((await request('observer','/deals/1','POST',{title:'Blocked'})).status,403);
            assert.strictEqual((await request('observer','/businesses/1/crm/tasks','POST',{summary:'Blocked'})).status,403);
            assert.strictEqual((await request('observer','/businesses/1/business-gpt/chats','POST',{})).status,403);
            assert.strictEqual((await request('observer','/businesses/1/knowledge/preview','POST',{question:'Blocked'})).status,403);
            assert.strictEqual((await request('observer','/dashboard/1/ai/overview?window=yesterday')).status,403);
            assert.strictEqual(providerCalls,0);
        } finally {AI.overview=oldOverview;LocalKnowledge.lookup=oldLookup;}
    }, {boundary:false}));

    it('rechecks capability after asynchronous paid generation before returning an answer', async () => runtime(async ({request}) => {
        const oldOverview=AI.overview;
        AI.overview=async()=>{
            DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId='manager' AND businessId=1");
            return {businessId:1,answer:'Must remain hidden after demotion'};
        };
        try {
            const response=await request('manager','/dashboard/1/ai/overview?window=yesterday');
            assert.strictEqual(response.status,403);
            assert.ok(!JSON.stringify(await response.json()).includes('Must remain hidden'));
        } finally {AI.overview=oldOverview;}
    }));


    it('protects legacy dashboard completion with actual task assignments and foreign-business scope', async () => runtime(async ({request}) => {
        for (const role of ROLES) {
            DB.createManagerTask({instanceId:1,taskId:`own-${role}`,summary:'Assigned manager fixture',assigneeUserId:'manager'});
            DB.createManagerTask({instanceId:1,taskId:`other-${role}`,summary:'Assigned lead fixture',assigneeUserId:'sales_lead'});
            assert.strictEqual((await request(role,`/dashboard/1/tasks/own-${role}`,'PATCH',{status:'done'})).status,role==='observer'?403:200,role);
            assert.strictEqual((await request(role,`/dashboard/1/tasks/other-${role}`,'PATCH',{status:'done'})).status,['hotel_owner','sales_lead'].includes(role)?200:403,role);
            assert.strictEqual((await request(role,`/dashboard/2/tasks/own-${role}`,'PATCH',{status:'done'})).status,403,role);
        }
        assert.strictEqual(DB.getManagerTask(1,'other-manager').status,'new');
        assert.strictEqual(DB.getManagerTask(1,'own-observer').status,'new');
    }));

    it('queues native CRM tasks only for active sales roles before any native delivery', async () => runtime(async ({request}) => {
        DB.run(`INSERT INTO twenty_workspace_links(id,businessId,baseUrl,apiKeyEncrypted,enabled,mode,connectionStatus)
            VALUES ('fixture-twenty',1,'https://twenty.example.test','fixture-only',1,'live','connected')`);
        for (const [index,role] of ROLES.entries()) {
            const headers={'Idempotency-Key':`550e8400-e29b-41d4-a716-44665544000${index}`};
            const result=await request(role,'/businesses/1/crm/tasks','POST',{summary:`Task for ${role}`},headers);
            assert.strictEqual(result.status,role==='observer'?403:202,role);
            if(role!=='observer') assert.strictEqual((await result.json()).task.nativeStatus,'pending');
            assert.strictEqual((await request(role,'/businesses/2/crm/tasks','POST',{summary:'Wrong business'},headers)).status,403,role);
        }
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM manager_tasks').n,3);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM twenty_sync_outbox').n,3);
    }));

    it('drops local knowledge answers after cookie revocation or live role demotion during lookup', async () => runtime(async ({request}) => {
        const oldLookup=LocalKnowledge.lookup;
        const answer={answer:'Private delayed fixture',citations:[{source_id:1,title:'Fixture'}],source_timestamp:new Date().toISOString()};
        try {
            LocalKnowledge.lookup=async()=>{
                DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId='manager'");
                return answer;
            };
            let response=await request('manager','/businesses/1/knowledge/preview','POST',{question:'Fixture question'});
            assert.strictEqual(response.status,403);
            assert.ok(!JSON.stringify(await response.json()).includes(answer.answer));
            LocalKnowledge.lookup=async()=>{
                DB.run("UPDATE ava_sessions SET revokedAt=? WHERE userId='sales_lead'",[Date.now()]);
                return answer;
            };
            response=await request('sales_lead','/businesses/1/knowledge/preview','POST',{question:'Fixture question'});
            assert.strictEqual(response.status,403);
            assert.ok(!JSON.stringify(await response.json()).includes(answer.answer));
        } finally {LocalKnowledge.lookup=oldLookup;}
    }));

    it('rechecks AI permission before billed synthesis after an awaited provider capability probe', async () => runtime(async ({request}) => {
        const oldCapability=Audio.capability,oldProbe=Audio.probe,oldSynthesize=Audio.synthesize;
        let calls=0;
        Audio.capability=()=>({available:true});
        Audio.probe=async()=>{
            DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId='manager'");
            return {available:true};
        };
        Audio.synthesize=async()=>{calls++;return Buffer.from('fixture');};
        try {
            assert.strictEqual((await request('manager','/dashboard/1/ai/briefing/audio')).status,403);
            assert.strictEqual(calls,0);
        } finally {Audio.capability=oldCapability;Audio.probe=oldProbe;Audio.synthesize=oldSynthesize;}
    }));


    it('denies delayed call history after membership removal or original cookie revocation', async () => runtime(async ({request}) => {
        const oldGet=axios.get,oldApi=config.avaAdmin.apiUrl,oldToken=config.avaAdmin.serviceToken;
        config.avaAdmin.apiUrl='https://fixture.internal';config.avaAdmin.serviceToken='fixture-token';
        try {
            for(const role of ['manager','sales_lead']) {
                let enter,release;
                const entered=new Promise(resolve=>{enter=resolve;});
                const gate=new Promise(resolve=>{release=resolve;});
                axios.get=async()=>{
                    enter();await gate;
                    return {data:{calls:[{business_id:1,caller_name:'Delayed private fixture'}],total:1}};
                };
                const pending=request(role,'/calls/1');
                await entered;
                if(role==='manager') DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId=? AND businessId=1",[role]);
                else DB.run('UPDATE ava_sessions SET revokedAt=? WHERE userId=?',[Date.now(),role]);
                release();
                const response=await pending;
                assert.strictEqual(response.status,403,role);
                assert.ok(!JSON.stringify(await response.json()).includes('Delayed private fixture'));
            }
        } finally {axios.get=oldGet;config.avaAdmin.apiUrl=oldApi;config.avaAdmin.serviceToken=oldToken;}
    }));


    it('actual API status handler rechecks assignment after DB preparation and never persists a late unclaimed write', async()=>runtime(async({request})=>{
        const read=DB.getInstance;
        DB.getInstance=async(...args)=>{const instance=await read.apply(DB,args);DB.run("UPDATE clients SET assigneeUserId=NULL WHERE instanceId=1 AND chatId='own'");return instance;};
        try {
            const response=await request('manager','/clients/1/own/status','PUT',{status:'qualified'});
            assert.equal(response.status,403);assert.equal((await response.json()).code,'SALES_CLIENT_CLAIM_REQUIRED');
            assert.equal(DB.get("SELECT leadStatus FROM clients WHERE instanceId=1 AND chatId='own'").leadStatus,'new');
        } finally {DB.getInstance=read;}
    },{actualApi:true}));

    it('actual API send handler rechecks assignment after awaited client preparation before fixture provider', async()=>runtime(async({request})=>{
        const read=DB.getClient,Channel=require('../src/services/channel-router.service'),send=Channel.sendMessage;let sends=0;
        DB.getClient=async(...args)=>{const row=await read.apply(DB,args);DB.run("UPDATE clients SET assigneeUserId='sales_lead' WHERE instanceId=1 AND chatId='own'");return row;};
        Channel.sendMessage=async()=>{sends++;return true;};
        try {
            const response=await request('manager','/clients/1/own/send-message','POST',{text:'Fixture must never be sent'});
            assert.equal(response.status,403);assert.equal((await response.json()).code,'SALES_CLIENT_SCOPE_DENIED');assert.equal(sends,0);
        } finally {DB.getClient=read;Channel.sendMessage=send;}
    },{actualApi:true}));

    it('requires manager canonical client assignment for all legacy writes, messages and paid AI, then permits an explicit queue claim', async () => runtime(async ({users,request}) => {
        for(const [method,path,body] of [
            ['PUT','/clients/1/other/status',{status:'qualified'}],['PUT','/clients/1/other/tags',{tags:['fixture']}],
            ['POST','/clients/1/other/send-message',{text:'Fixture'}],['POST','/ai/summary/1/other',{}],
            ['POST','/ai/next-step/1/other',{}],['POST','/clients/1/%2B79990000012/send-message',{text:'Alias fixture'}],
        ]) {
            assert.strictEqual((await request('manager',path,method,body)).status,403,path);
            for(const role of ['hotel_owner','sales_lead']) assert.strictEqual((await request(role,path,method,body)).status,200,role+path);
            assert.strictEqual((await request('observer',path,method,body)).status,403,path);
        }
        const canonical=await request('manager','/clients/1/%2B79990000011/send-message','POST',{text:'Assigned alias fixture'});
        assert.strictEqual(canonical.status,200);assert.strictEqual((await canonical.json()).chatId,'own');
        assert.strictEqual((await request('manager','/clients/1/queue/status','PUT',{status:'qualified'})).status,403);
        assert.strictEqual(DB.get("SELECT assigneeUserId FROM clients WHERE instanceId=1 AND chatId='queue'").assigneeUserId,null);
        require('../src/services/sales-workspace.service').assignClient(users.manager.actor,1,'queue',{assigneeUserId:'manager'});
        assert.strictEqual((await request('manager','/clients/1/queue/status','PUT',{status:'qualified'})).status,200);
    }));

    it('rechecks exact client assignment after awaited message preparation before fixture dispatch', async () => runtime(async ({request,calls,preparation}) => {
        let enter,release;
        const entered=new Promise(resolve=>{enter=resolve;});
        const gate=new Promise(resolve=>{release=resolve;});
        preparation.beforeDispatch=async()=>{enter();await gate;};
        const pending=request('manager','/clients/1/own/send-message','POST',{text:'Must not dispatch'});
        await entered;
        DB.run("UPDATE clients SET assigneeUserId='sales_lead' WHERE instanceId=1 AND chatId='own'");
        release();
        assert.strictEqual((await pending).status,403);assert.strictEqual(calls.operational,0);
    }));

    it('denies native task creation for another manager client and the unclaimed queue while canonicalizing own aliases', async () => runtime(async ({request}) => {
        DB.run(`INSERT INTO twenty_workspace_links(id,businessId,baseUrl,apiKeyEncrypted,enabled,mode,connectionStatus)
            VALUES ('client-scope-native',1,'https://twenty.example.test','fixture-only',1,'live','connected')`);
        const headers={'Idempotency-Key':'550e8400-e29b-41d4-a716-446655449991'};
        for(const chatId of ['other','+79990000012','queue']) {
            assert.strictEqual((await request('manager','/businesses/1/crm/tasks','POST',{summary:'Denied fixture',chatId},headers)).status,403,chatId);
        }
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM manager_tasks').n,0);
        assert.strictEqual((await request('manager','/businesses/1/crm/tasks','POST',{summary:'Assigned fixture',chatId:'+79990000011'},headers)).status,202);
        assert.strictEqual(DB.get('SELECT chatId FROM manager_tasks').chatId,'own');
    }));


    it('checks old and new linked clients for deal writes and uses exact creator for unlinked manager deals', async () => runtime(async ({request}) => {
        const Deals=require('../src/services/customer-deals.store');
        for(const chatId of ['other','+79990000012','queue']) {
            assert.strictEqual((await request('manager','/deals/1','POST',{title:'Denied linked fixture',clientChatId:chatId})).status,403,chatId);
        }
        const created=await request('manager','/deals/1','POST',{title:'Own alias deal',clientChatId:'+79990000011'});
        assert.strictEqual(created.status,201);
        const own=(await created.json()).deal;assert.strictEqual(own.clientChatId,'own');
        assert.strictEqual((await request('manager',`/deals/1/${own.id}`,'PUT',{clientChatId:'other',revision:1})).status,403);
        assert.strictEqual(Deals.get(1,own.id).clientChatId,'own');
        const other=Deals.create(1,{title:'Lead linked fixture',clientChatId:'other'},'hotel_owner');
        assert.strictEqual((await request('manager',`/deals/1/${other.id}`,'PUT',{clientChatId:'own',revision:1})).status,403);
        assert.strictEqual((await request('manager',`/deals/1/${other.id}`,'DELETE',{revision:1})).status,403);
        for(const createdBy of [null,'hotel_owner','sales_lead']) {
            const legacy=Deals.create(1,{title:'Unlinked fixture',ownerName:'manager'},createdBy);
            assert.strictEqual((await request('manager',`/deals/1/${legacy.id}`,'PUT',{stage:'qualified',revision:1})).status,403);
            assert.strictEqual((await request('manager',`/deals/1/${legacy.id}`,'DELETE',{revision:1})).status,403);
            assert.strictEqual((await request('sales_lead',`/deals/1/${legacy.id}`,'PUT',{stage:'qualified',revision:1})).status,200);
        }
        const mine=Deals.create(1,{title:'Exact creator fixture'},'manager');
        assert.strictEqual((await request('manager',`/deals/1/${mine.id}`,'PUT',{stage:'qualified',revision:1})).status,200);
        assert.strictEqual((await request('manager',`/deals/1/${mine.id}`,'DELETE',{revision:2})).status,200);
        assert.strictEqual((await request('manager',`/deals/1/${other.id}`)).status,200,'Business reads remain compatible');
    }));

    it('protects canonical identity mutations on another client and requires a queue claim', async () => runtime(async ({request}) => {
        const value={kind:'phone',value:'+79990000013'};
        assert.strictEqual((await request('manager','/clients/1/other/identities','POST',value)).status,403);
        assert.strictEqual((await request('manager','/clients/1/queue/identities','POST',value)).status,403);
        assert.strictEqual((await request('observer','/clients/1/own/identities','POST',value)).status,403);
        assert.strictEqual((await request('manager','/clients/1/%2B79990000011/identities','POST',value)).status,200);
        assert.strictEqual((await request('manager','/clients/1/other/identities')).status,200);
    }));

    it('uses fresh role and enabled membership even when a caller supplies a stale privileged actor', () => {
        const users=fixture();
        const req={auth:{...users.observer.actor,platformRole:'platform_admin'},method:'POST',path:'/new-unreviewed-mutation',body:{},query:{},get:()=>undefined};
        let status=200,passed=false;
        Boundary(req,{status(value){status=value;return this;},json(){}},()=>{passed=true;});
        assert.strictEqual(passed,false);assert.strictEqual(status,403);
        DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='hotel_owner'");
        let allowed=false;
        Access.forRoute('put','/channels/:instanceId/config')({auth:users.hotel_owner.actor,params:{instanceId:'1'},body:{},query:{},headers:{}},
            {status(value){status=value;return this;},json(){}},()=>{allowed=true;});
        assert.strictEqual(allowed,false);assert.strictEqual(status,403);
    });
});

describe('Customer name route through the authenticated capability boundary',()=>{
    it('allows owner, lead and assigned manager and denies observer, other assignee and foreign scope',()=>runtime(async({request})=>{
        for(const role of ROLES){
            const response=await request(role,'/businesses/1/sales-workspace/clients/own/name','PUT',{name:'Own',previousName:'Own'});
            assert.equal(response.status,role==='observer'?403:200,role);
        }
        assert.equal((await request('manager','/businesses/1/sales-workspace/clients/other/name','PUT',{name:'Denied',previousName:'Other assigned'})).status,403);
        assert.equal((await request('hotel_owner','/businesses/2/sales-workspace/clients/foreign/name','PUT',{name:'Denied',previousName:'Foreign'})).status,403);
        assert.equal((await request('manager','/businesses/1/sales-workspace/clients/own/name','PUT',{name:'Denied',previousName:'Own'},{Origin:'https://foreign.test'})).status,403);
        assert.equal((await DB.getClient(1,'own')).senderName,'Own');
    }));
});
