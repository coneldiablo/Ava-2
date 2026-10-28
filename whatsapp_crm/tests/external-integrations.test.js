'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const axios=require('axios');
const DB=require('../src/services/database.service');
const Store=require('../src/services/integrations/store');
const Http=require('../src/services/integrations/http');
const Amo=require('../src/services/integrations/amocrm');
const Avito=require('../src/services/avito.service');
const CRM=require('../src/services/crm.service');
const original=axios.request;
async function fixture(fn) {
    createTestDB();process.env.CHANNEL_CREDENTIALS_MASTER_KEY='11'.repeat(32);process.env.WHATSAPP_CRM_PUBLIC_URL='https://ava.example.test';
    const a=await DB.createInstance({name:'A'}),b=await DB.createInstance({name:'B'});
    const client=await DB.getOrCreateClient(a.id,'79990000001@c.us','Fixture');
    try {await fn(a,b,client);}finally{axios.request=original;}
}
function amo(id,extra={}) {
    Store.save(id,'amocrm',{domain:'fixture.amocrm.ru',redirectUri:'https://ava.example.test/api/external-integrations/callback/amocrm',mapping:{statusMap:{}}},{clientId:'fixture-client',clientSecret:'fixture-secret',accessToken:'fixture-access',refreshToken:'fixture-refresh',expiresAt:Date.now()+3600000,...extra});
    Store.patch(id,'amocrm',{accountId:'101',accountName:'Fixture',status:'connected',capabilities:{read:true,send:'unverified'}});
}
function avito(id,extra={}) {
    Store.save(id,'avito',{}, {clientId:'avito-client',clientSecret:'avito-secret',accessToken:'avito-access',expiresAt:Date.now()+3600000,connectedAt:Date.now()-3600000,...extra});
    Store.patch(id,'avito',{accountId:'202',accountName:'Fixture',status:'connected',capabilities:{read:true,send:'unverified'}});
}
function response(data){return {data};}
function providerFailure(status,code=null) {return Object.assign(new Error('must not leak secret/provider-body'),{response:status?{status,headers:{},data:{token:'secret'}}:undefined,code});}
describe('A14/A15 external integrations — local provider fixtures',()=>{
it('encrypts secrets with tenant/provider AAD and never returns them in status',()=>fixture(async(a,b)=>{
    const r=Amo.save(a.id,{domain:'fixture.amocrm.ru',clientId:'x',clientSecret:'unique-secret'});
    const raw=DB.get('SELECT secrets FROM customer_external_connections').secrets;
    assert.ok(!raw.includes('unique-secret'));assert.ok(!JSON.stringify(r).includes('unique-secret'));
    assert.throws(()=>Store.decrypt(raw,b.id,'amocrm'),e=>e.code==='EXTERNAL_CREDENTIAL_READ_FAILED');
    assert.throws(()=>Store.decrypt(raw,a.id,'avito'),e=>e.code==='EXTERNAL_CREDENTIAL_READ_FAILED');
    assert.equal(Store.get(a.id,'amocrm').credentials.clientSecret,'unique-secret');
}));
it('requires master key before persisting any new credentials',()=>fixture(async(a)=>{
    delete process.env.CHANNEL_CREDENTIALS_MASTER_KEY;
    assert.throws(()=>Avito.save(a.id,{clientId:'x',clientSecret:'y'}),e=>e.code==='EXTERNAL_ENCRYPTION_KEY_REQUIRED');
    assert.equal(DB.get('SELECT COUNT(*) n FROM customer_external_connections').n,0);
}));
it('rejects arbitrary hosts, credentials, ports, redirects and local destinations',()=>fixture(async()=>{
    for(const input of ['localhost','127.0.0.1','http://fixture.amocrm.ru','fixture.amocrm.ru.evil.test','evil@fixture.amocrm.ru','fixture.amocrm.ru:443','fixture.amocrm.ru/path','fixture.amocrm.ru?x=1'])assert.throws(()=>Http.amoDomain(input));
    assert.equal(Http.amoDomain('https://fixture.amocrm.ru/'),'fixture.amocrm.ru');
}));
it('does not create another lead or contact when a legacy note fails',()=>fixture(async(a,b,client)=>{
    await DB.updateClientCrmIds(a.id,client.chatId,'301','401');const calls=[];
    axios.request=async c=>{calls.push(c);if(c.method==='GET')return response({id:1});throw providerFailure(503);};
    const config={id:a.id,amoCrmDomain:'fixture.amocrm.ru',amoCrmAccessToken:'legacy-token'};
    const first=await CRM.sendLeadToAmoCRM(config,{...client,crmContactId:'301',crmLeadId:'401'},'qualified');
    const second=await CRM.sendLeadToAmoCRM(config,client,'qualified');
    assert.equal(first.success,false);assert.equal(first.unknown,true);assert.equal(second.error,'EXTERNAL_OUTCOME_UNKNOWN');
    assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.ok(calls.every(c=>!['/api/v4/contacts','/api/v4/leads'].some(p=>c.method==='POST'&&c.url.endsWith(p))));
}));
it('retains a contact ACK and fences an unacknowledged lead create across retries',()=>fixture(async(a,b,client)=>{
    amo(a.id);let contacts=0,leads=0;
    axios.request=async c=>{if(c.url.endsWith('/contacts')){contacts++;return response({_embedded:{contacts:[{id:301}]}});}if(c.url.endsWith('/leads')){leads++;throw providerFailure(null,'ETIMEDOUT');}throw new Error('unexpected');};
    await assert.rejects(()=>Amo.syncClient(a.id,client.chatId,'new'),e=>e.unknown===true);
    await assert.rejects(()=>Amo.syncClient(a.id,client.chatId,'new'),e=>e.code==='EXTERNAL_OUTCOME_UNKNOWN');
    assert.equal(contacts,1);assert.equal(leads,1);assert.equal(Store.linked(a.id,'amocrm',client.chatId,'101').contactId,'301');
}));
it('replays provider ACK without creating duplicate notes/tasks',()=>fixture(async(a,b,client)=>{
    amo(a.id);const count={contacts:0,leads:0,notes:0,tasks:0};
    axios.request=async c=>{const kind=c.url.split('/').at(-1);count[kind]++;return response({_embedded:{[kind]:[{id:{contacts:301,leads:401,notes:501,tasks:601}[kind]}]}});};
    const one=await Amo.syncClient(a.id,client.chatId,'qualified'),two=await Amo.syncClient(a.id,client.chatId,'qualified');
    assert.equal(one.leadId,two.leadId);assert.deepEqual(count,{contacts:1,leads:1,notes:1,tasks:0});
    const task={kind:'task',text:'Позвонить',sourceId:'task-1',completeTill:Math.floor(Date.now()/1000)+3600};
    await Amo.syncClient(a.id,client.chatId,'qualified',task);await Amo.syncClient(a.id,client.chatId,'qualified',task);assert.equal(count.tasks,1);
}));
it('validates task input before any external mutation',()=>fixture(async(a,b,client)=>{
    amo(a.id);let calls=0;axios.request=async()=>{calls++;throw new Error();};
    await assert.rejects(()=>Amo.syncClient(a.id,client.chatId,'new',{kind:'task',text:'bad'}),e=>e.code==='EXTERNAL_TASK_INVALID');assert.equal(calls,0);
}));
it('does not reuse a rotating refresh token after an unknown outcome',()=>fixture(async(a)=>{
    amo(a.id,{expiresAt:0});let count=0;axios.request=async()=>{count++;throw providerFailure(null,'ETIMEDOUT');};
    await assert.rejects(()=>Amo.api(a.id,'GET','/api/v4/account'),e=>e.code==='EXTERNAL_AUTH_OUTCOME_UNKNOWN');
    await assert.rejects(()=>Amo.api(a.id,'GET','/api/v4/account'),e=>e.code==='EXTERNAL_AUTH_OUTCOME_UNKNOWN');
    assert.equal(count,1);assert.equal(Store.status(a.id,'amocrm').status,'reauth_required');
}));
it('persists rotating access and refresh tokens together and serializes refresh',()=>fixture(async(a)=>{
    amo(a.id,{expiresAt:0});let unblock;axios.request=async c=>{if(c.url.endsWith('/access_token')){await new Promise(r=>unblock=r);return response({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600});}return response({id:101});};
    const pending=Amo.api(a.id,'GET','/api/v4/account');
    await assert.rejects(()=>Amo.api(a.id,'GET','/api/v4/account'),e=>e.code==='EXTERNAL_AUTH_IN_PROGRESS');
    unblock();await pending;const r=Store.get(a.id,'amocrm');assert.equal(r.credentials.refreshToken,'new-refresh');assert.equal(r.credentials.accessToken,'new-access');
}));
it('protects configured mapping and refuses a status outside the selected pipeline',()=>fixture(async(a,b,client)=>{
    amo(a.id);Store.save(a.id,'amocrm',{...Store.get(a.id,'amocrm').config,mapping:{pipelineId:1,statusMap:{new:999}}},Store.get(a.id,'amocrm').credentials);
    let writes=0;axios.request=async c=>{if(c.method!=='GET')writes++;return response({_embedded:{pipelines:[{id:1,name:'A',_embedded:{statuses:[{id:2,name:'New'}]}}],users:[]}});};
    await assert.rejects(()=>Amo.syncClient(a.id,client.chatId,'new'),e=>e.code==='EXTERNAL_MAPPING_NOT_AVAILABLE');assert.equal(writes,0);
}));
it('refuses attaching one provider account to two different businesses',()=>fixture(async(a,b)=>{
    amo(a.id);Store.save(b.id,'amocrm',{domain:'fixture.amocrm.ru'},{clientId:'x',clientSecret:'y'});
    assert.throws(()=>Store.patch(b.id,'amocrm',{accountId:'101'}),e=>e.code==='EXTERNAL_ACCOUNT_ALREADY_CONNECTED');
}));
it('verifies Avito Messenger permission, not just a token or account lookup',()=>fixture(async(a)=>{
    Avito.save(a.id,{clientId:'x',clientSecret:'y'});let steps=0;
    axios.request=async c=>{steps++;if(c.url.endsWith('/token'))return response({access_token:'a',expires_in:3600});if(c.url.endsWith('/self'))return response({id:202,name:'Fixture'});throw providerFailure(403);};
    await assert.rejects(()=>Avito.connect(a.id),e=>e.code==='EXTERNAL_ACCESS_DENIED');assert.equal(Store.status(a.id,'avito').status,'access_denied');assert.equal(steps,3);assert.equal(Store.status(a.id,'avito').account,null);
}));
it('connects Avito with real read probe and marks send unverified until ACK',()=>fixture(async(a)=>{
    Avito.save(a.id,{clientId:'x',clientSecret:'y'});
    axios.request=async c=>response(c.url.endsWith('/token')?{access_token:'a',expires_in:3600}:c.url.endsWith('/self')?{id:202,name:'Fixture'}:{chats:[]});
    const s=await Avito.connect(a.id);assert.equal(s.account.id,'202');assert.equal(s.capabilities.read,true);assert.equal(s.capabilities.send,'unverified');
}));
it('rejects foreign or forged callbacks before accepting event content',()=>fixture(async(a)=>{
    avito(a.id);Store.patch(a.id,'avito',{webhookToken:'good-token'});let calls=0;axios.request=async()=>{calls++;return response({});};
    await assert.rejects(()=>Avito.webhook(a.id,'wrong',{payload:{value:{user_id:202,id:'x',chat_id:'chat'}}}),e=>e.code==='EXTERNAL_CALLBACK_INVALID');
    await assert.rejects(()=>Avito.webhook(a.id,'good-token',{payload:{value:{user_id:999,id:'x',chat_id:'chat'}}}),e=>e.code==='EXTERNAL_CALLBACK_INVALID');assert.equal(calls,0);
}));
it('imports confirmed Avito messages into one canonical card with durable inbound dedup',()=>fixture(async(a)=>{
    avito(a.id);const created=Math.floor(Date.now()/1000),m={id:'message-1',created,type:'text',author_id:303,content:{text:'Fixture question'}};
    axios.request=async c=>response(c.url.includes('/messages/')?{messages:[m]}:{id:'chat-1',users:[{id:202,name:'A'},{id:303,name:'B'}]});
    await Avito.importChat(a.id,'chat-1');await Avito.importChat(a.id,'chat-1');
    assert.equal(DB.get("SELECT COUNT(*) n FROM clients WHERE preferredChannel='avito'").n,1);assert.equal(DB.get("SELECT COUNT(*) n FROM messages WHERE channel='avito'").n,1);assert.equal(DB.get("SELECT COUNT(*) n FROM channel_inbound_jobs WHERE channel='avito'").n,1);
}));
it('does not queue automatic answers for history imported before activation',()=>fixture(async(a)=>{
    avito(a.id,{connectedAt:Date.now()+60000});
    axios.request=async c=>response(c.url.includes('/messages/')?{messages:[{id:'old',created:1,type:'text',author_id:303,content:{text:'Old message'}}]}:{id:'chat-1',users:[{id:202},{id:303}]});
    const result=await Avito.importChat(a.id,'chat-1');assert.equal(result.inserted,1);assert.equal(result.queued,0);
}));
it('fences an Avito send timeout, including repeat attempts after process loss',()=>fixture(async(a)=>{
    avito(a.id);const client=await DB.getOrCreateClient(a.id,'avito:202:chat-1','Fixture');Store.link(a.id,'avito',client.chatId,'202',{externalChatId:'chat-1'});
    let sends=0;axios.request=async()=>{sends++;throw providerFailure(null,'ETIMEDOUT');};
    const context={chatId:client.chatId,idempotencyKey:'fixture-send',beforeSend:()=>{}};
    const one=await Avito.sendMessageDetailed(a.id,'avito:202:chat-1','Hello',context),two=await Avito.sendMessageDetailed(a.id,'avito:202:chat-1','Hello',context);
    assert.equal(one.unknown,true);assert.equal(two.unknown,true);assert.equal(two.safeToRetry,false);assert.equal(sends,1);
}));
it('requires a shared send guard, scoped recipient and stable action identity',()=>fixture(async(a)=>{
    avito(a.id);const client=await DB.getOrCreateClient(a.id,'avito:202:chat-1','Fixture');Store.link(a.id,'avito',client.chatId,'202',{externalChatId:'chat-1'});let calls=0;axios.request=async()=>{calls++;return response({id:'sent'});};
    assert.equal((await Avito.sendMessageDetailed(a.id,'avito:202:chat-1','Hello',{})).error,'AVITO_SEND_GUARD_REQUIRED');
    assert.equal((await Avito.sendMessageDetailed(a.id,'avito:999:chat-1','Hello',{beforeSend(){}})).error,'AVITO_RECIPIENT_SCOPE_INVALID');
    assert.equal((await Avito.sendMessageDetailed(a.id,'avito:202:chat-1','Hello',{beforeSend(){}})).error,'EXTERNAL_IDEMPOTENCY_REQUIRED');assert.equal(calls,0);
}));
it('reconciles exact persisted Avito provider ACK and never resends it',()=>fixture(async(a)=>{
    avito(a.id);const client=await DB.getOrCreateClient(a.id,'avito:202:chat-1','Fixture');Store.link(a.id,'avito',client.chatId,'202',{externalChatId:'chat-1'});let sends=0;axios.request=async()=>{sends++;return response({id:'sent-1'});};
    const context={chatId:client.chatId,idempotencyKey:'fixture-send',beforeSend:()=>{}};
    await Avito.sendMessageDetailed(a.id,'avito:202:chat-1','Hello',context);await Avito.sendMessageDetailed(a.id,'avito:202:chat-1','Hello',context);
    assert.equal(sends,1);const proof=await Avito.reconcileMessage(a.id,client.chatId,{idempotencyKey:'fixture-send'});assert.equal(proof.status,'sent');assert.equal(proof.providerMessageId,'sent-1');
}));
it('disconnect destroys tokens and invalidates in-flight connection revisions',()=>fixture(async(a)=>{
    avito(a.id);const revision=Store.get(a.id,'avito').revision;Store.disconnect(a.id,'avito');
    assert.deepEqual(Store.get(a.id,'avito').credentials,{});assert.equal(Store.status(a.id,'avito').status,'disconnected');
    assert.throws(()=>Store.patch(a.id,'avito',{credentials:{accessToken:'stale'}},revision),e=>e.code==='EXTERNAL_CONNECTION_CHANGED');
    await assert.rejects(()=>Avito.api(a.id,'GET','/core/v1/accounts/self'),e=>e.code==='EXTERNAL_NOT_CONFIGURED');
}));
it('keeps multiple CRM deals for the same contact without losing webhook references',()=>fixture(async(a,b,client)=>{
    amo(a.id);Store.link(a.id,'amocrm',client.chatId,'101',{contactId:'301',leadId:'401'});Store.link(a.id,'amocrm',client.chatId,'101',{contactId:'301',leadId:'402'});
    assert.equal(Store.entity(a.id,'amocrm','101','lead','401').chatId,client.chatId);assert.equal(Store.entity(a.id,'amocrm','101','lead','402').chatId,client.chatId);
}));
it('imports CRM source contacts, deals, tasks and status idempotently into shared records',()=>fixture(async(a)=>{
    amo(a.id);Store.save(a.id,'amocrm',{...Store.get(a.id,'amocrm').config,mapping:{pipelineId:1,statusMap:{qualified:2}}},Store.get(a.id,'amocrm').credentials);
    axios.request=async c=>{
        if(c.url.endsWith('/leads'))return response({_embedded:{leads:[{id:401,name:'Verified deal',status_id:2,updated_at:100,_embedded:{contacts:[{id:301,is_main:true}]}}]}});
        if(c.url.endsWith('/contacts/301'))return response({id:301,name:'Verified name'});
        if(c.url.endsWith('/tasks'))return response({_embedded:{tasks:[{id:501,entity_id:401,entity_type:'leads',text:'Call back',complete_till:2000000000,is_completed:false}]}});
        throw new Error('unexpected path');
    };
    await Amo.sync(a.id);await Amo.sync(a.id);
    assert.equal(DB.get("SELECT COUNT(*) n FROM clients WHERE senderName='Verified name'").n,1);
    assert.equal(DB.get("SELECT COUNT(*) n FROM conversation_events WHERE channel='amocrm'").n,1);
    assert.equal(DB.get("SELECT COUNT(*) n FROM manager_tasks WHERE source='amocrm'").n,1);
    assert.equal(DB.get("SELECT leadStatus FROM clients WHERE senderName='Verified name'").leadStatus,'qualified');
}));
it('accepts callback into durable queue and verifies provider data only in the worker',()=>fixture(async(a)=>{
    avito(a.id);Store.patch(a.id,'avito',{webhookToken:'good'});let reads=0;
    axios.request=async c=>{reads++;return response(c.url.includes('/messages/')?{messages:[{id:'m1',created:1,type:'text',author_id:303,content:{text:'Verified provider text'}}]}:{id:'c1',users:[{id:303,name:'Peer only'}]});};
    const body={payload:{value:{user_id:202,chat_id:'c1',id:'m1',content:{text:'forged webhook text'}}}};
    assert.equal((await Avito.webhook(a.id,'good',body)).accepted,true);assert.equal((await Avito.webhook(a.id,'good',body)).duplicate,true);assert.equal(reads,0);
    await Avito.recoverPending({poll:false});assert.equal(reads,2);
    assert.equal(DB.get("SELECT content FROM messages WHERE channel='avito'").content,'Verified provider text');
    assert.equal(Store.callbacks('avito').length,0);
}));
it('requires current business permission and same-origin for settings mutations',()=>fixture(async(a,b)=>{
    const Identity=require('../src/services/identity/identity-store'),Auth=require('../src/services/auth.service'),router=require('../src/routes/customer-external-integrations.routes');
    const oldAuthorize=Identity.authorizeCapability,oldSession=Auth.getSession;
    Auth.getSession=req=>req.auth;Identity.authorizeCapability=(actor,id,cap)=>{if(actor.userId!=='owner'||id!==a.id)throw Object.assign(new Error('denied'),{code:'CAPABILITY_REQUIRED',statusCode:403});};
    const invoke=async(id,headers={},body={clientId:'x',clientSecret:'y'},actor='owner')=>{
        const handler=router.stack.find(l=>l.route?.path==='/external-integrations/:instanceId/:provider'&&l.route.methods.put).route.stack.at(-1).handle;
        const res={statusCode:200,set(){return this;},status(n){this.statusCode=n;return this;},json(data){this.body=data;return this;}};
        await handler({method:'PUT',params:{instanceId:String(id),provider:'avito'},body,query:{},auth:{userId:actor},get:k=>({'origin':'https://ava.example.test',...headers})[k]},res);return res;
    };
    try {
        assert.equal((await invoke(b.id)).statusCode,403);assert.equal((await invoke(a.id,{},undefined,'manager')).statusCode,403);
        assert.equal((await invoke(a.id,{origin:'https://evil.test'})).statusCode,403);
        assert.equal((await invoke(a.id,{}, {clientId:'x',clientSecret:'y',businessId:b.id})).statusCode,403);
        const good=await invoke(a.id);assert.equal(good.statusCode,200);assert.ok(!JSON.stringify(good.body).includes('clientSecret'));
    }finally{Identity.authorizeCapability=oldAuthorize;Auth.getSession=oldSession;}
}));
it('rechecks session before revealing results after awaited account verification',()=>fixture(async(a)=>{
    const Identity=require('../src/services/identity/identity-store'),Auth=require('../src/services/auth.service'),router=require('../src/routes/customer-external-integrations.routes');
    const oldAuthorize=Identity.authorizeCapability,oldSession=Auth.getSession;let valid=true;
    Auth.getSession=req=>valid?req.auth:null;Identity.authorizeCapability=()=>{};avito(a.id);
    axios.request=async c=>{if(c.url.endsWith('/self'))return response({id:202,name:'Private account'});valid=false;return response({chats:[]});};
    const handler=router.stack.find(l=>l.route?.path==='/external-integrations/:instanceId/:provider/check').route.stack.at(-1).handle;
    const res={statusCode:200,set(){return this;},status(n){this.statusCode=n;return this;},json(data){this.body=data;return this;}};
    try {await handler({method:'POST',params:{instanceId:String(a.id),provider:'avito'},body:{},query:{},auth:{userId:'owner'},get:k=>k==='origin'?'https://ava.example.test':null},res);assert.equal(res.statusCode,401);assert.ok(!JSON.stringify(res.body).includes('Private account'));}
    finally{Identity.authorizeCapability=oldAuthorize;Auth.getSession=oldSession;}
}));
it('integrates confirmed Avito identity, shared context, AI draft and router ACK without duplicate history',()=>fixture(async(a,b,client)=>{
    avito(a.id);const Canonical=require('../src/services/client-identity.service'),Jobs=require('../src/services/channel-jobs.store'),AI=require('../src/services/ai.service'),RAG=require('../src/services/rag.service');
    Canonical.attach(a.id,client.chatId,{kind:'avito',value:'202:chat-1'});
    const ai=AI.getResponse,rag=RAG.buildConversationContext;let sends=0,seenContext;
    AI.getResponse=async(history,context)=>{seenContext=context;assert.equal(history.at(-1).content,'Fixture incoming');return {reply:'Verified answer'};};RAG.buildConversationContext=async()=>({context:'Published knowledge',searched:true});
    axios.request=async c=>{
        if(c.method==='POST'){sends++;return response({id:'sent-1'});}
        return response(c.url.includes('/messages/')?{messages:[{id:'incoming-1',created:Math.floor(Date.now()/1000),type:'text',author_id:303,content:{text:'Fixture incoming'}}]}:{id:'chat-1',users:[{id:303,name:'Other party'}]});
    };
    try {
        await Avito.importChat(a.id,'chat-1');const job=Jobs.claim({channel:'avito',instanceId:a.id,chatId:client.chatId});assert.ok(job);
        await Avito.processJob(job);assert.equal(Jobs.get({instanceId:a.id,id:job.id}).status,'completed');assert.equal(sends,1);
        assert.equal(seenContext.customerContext.client.id,client.id);assert.equal(seenContext.ragContext,'Published knowledge');assert.equal(DB.get("SELECT COUNT(*) n FROM messages WHERE role='assistant' AND channel='avito'").n,1);
        const Router=require('../src/services/channel-router.service');
        const proof=await Router.reconcileMessage(a.id,client.chatId,{channel:'avito',idempotencyKey:`avito-reply:${job.id}`});assert.equal(proof.status,'sent');assert.equal(proof.providerMessageId,'sent-1');
        // A provider readback of our answer must dedupe the same saved ACK.
        axios.request=async c=>response(c.url.includes('/messages/')?{messages:[{id:'sent-1',created:Math.floor(Date.now()/1000),type:'text',author_id:202,content:{text:'Verified answer'}}]}:{id:'chat-1',users:[{id:303}]});
        await Avito.importChat(a.id,'chat-1');assert.equal(DB.get("SELECT COUNT(*) n FROM messages WHERE role='assistant' AND channel='avito'").n,1);
    }finally{AI.getResponse=ai;RAG.buildConversationContext=rag;}
}));
it('preserves an AI draft and sends nothing when a manager takes over during generation',()=>fixture(async(a)=>{
    avito(a.id);const Jobs=require('../src/services/channel-jobs.store'),AI=require('../src/services/ai.service'),RAG=require('../src/services/rag.service'),Control=require('../src/services/ava-workspace.store');
    const client=await DB.getOrCreateClient(a.id,'avito:202:chat-1','Fixture');Store.link(a.id,'avito',client.chatId,'202',{externalChatId:'chat-1'});
    Jobs.recordInbound({instanceId:a.id,chatId:client.chatId,originChatId:client.chatId,channel:'avito',providerMessageId:'chat-1:incoming',text:'Question',senderName:'Fixture',meta:{accountId:'202',avitoChatId:'chat-1'}});
    const job=Jobs.claim({channel:'avito',instanceId:a.id,chatId:client.chatId});let sends=0;axios.request=async()=>{sends++;return response({id:'bad'});};
    const ai=AI.getResponse,rag=RAG.buildConversationContext;RAG.buildConversationContext=async()=>({context:'Knowledge',searched:true});
    AI.getResponse=async()=>{const c=Control.getControl(a.id,client.chatId);Control.setControl({businessId:a.id,chatId:client.chatId,mode:'human',revision:c.revision});return {reply:'Preserved draft'};};
    try{await Avito.processJob(job);const saved=Jobs.get({instanceId:a.id,id:job.id});assert.equal(saved.status,'suppressed');assert.equal(saved.response.reply,'Preserved draft');assert.equal(sends,0);}
    finally{AI.getResponse=ai;RAG.buildConversationContext=rag;}
}));
it('reconciles Avito ledger evidence through the router recipient contract',()=>fixture(async(a,b,client)=>{
    avito(a.id);Store.link(a.id,'avito',client.chatId,'202',{externalChatId:'chat-1'});axios.request=async()=>response({id:'receipt-1'});
    const key='exact-operation';await Avito.sendMessageDetailed(a.id,'avito:202:chat-1','Hello',{chatId:client.chatId,idempotencyKey:key,beforeSend(){}});
    const result=await Avito.reconcileMessage(a.id,'avito:202:chat-1',{businessId:a.id,chatId:client.chatId,idempotencyKey:key});assert.equal(result.status,'sent');assert.equal(result.idempotencyKey,key);
    const wrong=await Avito.reconcileMessage(a.id,'avito:999:chat-1',{businessId:a.id,chatId:client.chatId,idempotencyKey:key});assert.equal(wrong.status,'unknown');
}));
it('does not resurrect a disconnected integration when an in-flight read fails',()=>fixture(async(a)=>{
    avito(a.id);axios.request=async()=>{Store.disconnect(a.id,'avito');throw providerFailure(503);};
    await assert.rejects(()=>Avito.api(a.id,'GET','/core/v1/accounts/self'));assert.equal(Store.status(a.id,'avito').status,'disconnected');assert.deepEqual(Store.get(a.id,'avito').credentials,{});
}));
it('keeps a positive ACK durable without reconnecting an account disconnected during sending',()=>fixture(async(a,b,client)=>{
    avito(a.id);Store.link(a.id,'avito',client.chatId,'202',{externalChatId:'chat-1'});
    axios.request=async()=>{Store.disconnect(a.id,'avito');return response({id:'sent-before-disconnect'});};
    const result=await Avito.sendMessageDetailed(a.id,'avito:202:chat-1','Hello',{chatId:client.chatId,idempotencyKey:'disconnect-flight',beforeSend(){}});
    assert.equal(result.success,true);assert.equal(Store.status(a.id,'avito').status,'disconnected');assert.equal(Store.operation(a.id,'avito','message:202:chat-1:disconnect-flight').status,'succeeded');
}));
it('requires explicit confirmation and provider association before resolving a create fence',()=>fixture(async(a,b,client)=>{
    amo(a.id);Store.begin(a.id,'amocrm',`contact:101:${client.chatId}`,{chatId:client.chatId},client.chatId);Store.finish(a.id,'amocrm',`contact:101:${client.chatId}`,'unknown');let linked=false;
    axios.request=async c=>response(c.url.includes('/contacts/')?{id:301}:{id:401,_embedded:{contacts:[{id:linked?301:999}]}});
    await assert.rejects(()=>Amo.attachExisting(a.id,{chatId:client.chatId,contactId:301,leadId:401}),e=>e.code==='EXTERNAL_LINK_CONFIRMATION_REQUIRED');
    await assert.rejects(()=>Amo.attachExisting(a.id,{chatId:client.chatId,contactId:301,leadId:401,confirm:true}),e=>e.code==='EXTERNAL_ENTITY_LINK_INVALID');
    assert.equal(Store.operation(a.id,'amocrm',`contact:101:${client.chatId}`).status,'unknown');linked=true;
    const done=await Amo.attachExisting(a.id,{chatId:client.chatId,contactId:301,leadId:401,confirm:true});assert.equal(done.linked,true);assert.equal(Store.operation(a.id,'amocrm',`contact:101:${client.chatId}`).status,'succeeded');
}));
it('exports only new post-call summaries of already linked canonical customers',()=>fixture(async(a,b,client)=>{
    amo(a.id);Store.link(a.id,'amocrm',client.chatId,'101',{contactId:'301',leadId:'401'});
    const note=(eventId,chatId=client.chatId,instanceId=a.id)=>DB.createConversationEvent({eventId,instanceId,chatId,channel:'voice',direction:'internal',role:'manager_note',callId:eventId,sourceId:`post_call:${eventId}`,content:'Confirmed summary '+eventId,metadata:{summary_provenance:'provided_summary'}});
    note('before-connection');Amo.initializeOutbound(a.id,'101');note('after-connection');
    const unlinked=await DB.getOrCreateClient(a.id,'79990000002@c.us','Unlinked');note('unlinked',unlinked.chatId);
    const foreign=await DB.getOrCreateClient(b.id,'79990000001@c.us','Foreign');note('foreign',foreign.chatId,b.id);
    let writes=0;axios.request=async c=>{assert.ok(c.url.endsWith('/leads/401/notes'));assert.ok(c.data[0].params.text.includes('after-connection'));writes++;return response({_embedded:{notes:[{id:501}]}});};
    const first=await Amo.recoverOutbound(a.id),again=await Amo.recoverOutbound(a.id);assert.equal(first.notes,1);assert.equal(again.notes,0);assert.equal(writes,1);assert.equal(await DB.getClientCount(a.id),2);
}));
it('exports manager task once, then updates and completes the same provider task ID',()=>fixture(async(a,b,client)=>{
    amo(a.id);Store.link(a.id,'amocrm',client.chatId,'101',{contactId:'301',leadId:'401'});Amo.initializeOutbound(a.id,'101');
    DB.createManagerTask({taskId:'new-task',instanceId:a.id,chatId:client.chatId,summary:'New task',dueAt:'2030-01-01T12:00:00.000Z'});
    DB.createManagerTask({taskId:'no-due',instanceId:a.id,chatId:client.chatId,summary:'No fabricated deadline'});
    const calls=[];axios.request=async c=>{calls.push(c);return response(c.method==='POST'?{_embedded:{tasks:[{id:701}]}}:{id:701});};
    assert.equal((await Amo.recoverOutbound(a.id)).tasks,1);await Amo.recoverOutbound(a.id);
    DB.run("UPDATE manager_tasks SET summary='Changed task' WHERE taskId='new-task'");assert.equal((await Amo.recoverOutbound(a.id)).tasks,1);
    DB.run("UPDATE manager_tasks SET status='done',resolutionNote='Reached client' WHERE taskId='new-task'");await Amo.recoverOutbound(a.id);
    assert.equal(calls.length,3);assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.ok(calls.slice(1).every(c=>c.url.endsWith('/tasks/701')));assert.equal(calls.at(-1).data.is_completed,true);assert.equal(calls.at(-1).data.result.text,'Reached client');
    assert.equal(DB.get("SELECT errorCode FROM customer_external_exports WHERE sourceId='no-due'").errorCode,'EXTERNAL_TASK_DUE_REQUIRED');
}));
it('keeps a task export timeout fenced instead of attempting another provider task',()=>fixture(async(a,b,client)=>{
    amo(a.id);Store.link(a.id,'amocrm',client.chatId,'101',{contactId:'301',leadId:'401'});Amo.initializeOutbound(a.id,'101');
    DB.createManagerTask({taskId:'uncertain-task',instanceId:a.id,chatId:client.chatId,summary:'Task',dueAt:'2030-01-01T12:00:00.000Z'});let writes=0;
    axios.request=async()=>{writes++;throw providerFailure(null,'ETIMEDOUT');};await Amo.recoverOutbound(a.id);await Amo.recoverOutbound(a.id);assert.equal(writes,1);assert.equal(DB.get("SELECT status FROM customer_external_exports WHERE sourceId='uncertain-task'").status,'unknown');
}));
it('parses the official singular task webhook and confirms it through authenticated GET',()=>fixture(async(a,b,client)=>{
    amo(a.id);Store.link(a.id,'amocrm',client.chatId,'101',{contactId:'301',leadId:'401'});Store.patch(a.id,'amocrm',{webhookToken:'fixture'});
    const body={account:{subdomain:'fixture'},task:{update:[{0:{id:'501',text:'UNTRUSTED',element_id:'401'}}]}};await Amo.webhook(a.id,'fixture',body);let reads=0;
    axios.request=async c=>{reads++;assert.ok(c.url.endsWith('/tasks/501'));return response({id:501,entity_type:'leads',entity_id:401,text:'Verified task',complete_till:2000000000,is_completed:true});};
    await Amo.recoverPending({poll:false});assert.equal(reads,1);assert.equal(DB.get("SELECT summary FROM manager_tasks WHERE source='amocrm'").summary,'Verified task');assert.equal(DB.get("SELECT status FROM manager_tasks WHERE source='amocrm'").status,'done');
}));
it('never answers an old-account Avito job through a newly linked account',()=>fixture(async(a,b,client)=>{
    avito(a.id);Store.link(a.id,'avito',client.chatId,'202',{externalChatId:'current-chat'});
    const Jobs=require('../src/services/channel-jobs.store');Jobs.recordInbound({instanceId:a.id,chatId:client.chatId,originChatId:client.chatId,channel:'avito',providerMessageId:'old-message',text:'Old account question',senderName:'Fixture',meta:{accountId:'999',avitoChatId:'old-chat'}});
    const job=Jobs.claim({channel:'avito',instanceId:a.id,chatId:client.chatId});let calls=0;axios.request=async()=>{calls++;return response({});};
    await Avito.processJob(job);assert.equal(calls,0);assert.equal(Jobs.get({instanceId:a.id,id:job.id}).status,'suppressed');
}));
});

describe('Avito automatic setup and current chat IDs',()=>{
it('accepts tilde chat IDs through listing, import, identity and outbound ACK',()=>fixture(async(a)=>{
    avito(a.id);const chatId='u2i-fixture~chat',created=Math.floor(Date.now()/1000);
    axios.request=async c=>response(c.method==='POST'?{id:'reply~ack'}:c.url.includes('/messages/')?{messages:[{id:'inbound~one',created,type:'text',author_id:303,content:{text:'Question'}}]}:c.url.endsWith('/chats')?{chats:[{id:chatId,users:[{id:303,name:'Fixture'}]}]}:{id:chatId,users:[{id:303,name:'Fixture'}]});
    const list=await Avito.chats(a.id);assert.equal(list.chats[0].id,chatId);
    const imported=await Avito.importChat(a.id,chatId);assert.equal(imported.inserted,1);
    assert.equal(require('../src/services/client-identity.service').resolve(a.id,`avito:202:${chatId}`),imported.chatId);
    const result=await Avito.sendMessageDetailed(a.id,`avito:202:${chatId}`,'Answer',{chatId:imported.chatId,idempotencyKey:'test',beforeSend:()=>{}});
    assert.equal(result.success,true);assert.equal(result.provider_message_id,'reply~ack');
    for(const value of ['bad/chat','bad?query','bad:chat','bad%2fchat','../chat'])assert.throws(()=>Avito.origin('202',value),e=>e.code==='AVITO_CHAT_INVALID');
}));
it('saves, verifies and subscribes from the single connect action',()=>fixture(async(a)=>{
    const calls=[];axios.request=async c=>{calls.push(c);return response(c.url.endsWith('/token')?{access_token:'t',expires_in:3600}:c.url.endsWith('/self')?{id:202,name:'Fixture'}:c.url.endsWith('/webhook')?{ok:true}:{chats:[]});};
    const status=await Avito.connect(a.id,{clientId:'x',clientSecret:'y'});
    assert.equal(status.status,'connected');assert.equal(status.capabilities.webhook,true);
    assert.equal(calls.filter(c=>c.url.endsWith('/webhook')).length,1);
    const secret=Store.get(a.id,'avito').webhookToken;
    await Avito.connect(a.id);assert.equal(Store.get(a.id,'avito').webhookToken,secret);
    assert.equal(calls.filter(c=>c.url.endsWith('/webhook')).length,1);
}));
it('retains a working callback secret when subscription repair fails',()=>fixture(async(a)=>{
    avito(a.id);Store.patch(a.id,'avito',{webhookToken:'existing-token'});
    axios.request=async()=>{throw providerFailure(503);};
    await assert.rejects(()=>Avito.subscribe(a.id));assert.equal(Store.get(a.id,'avito').webhookToken,'existing-token');
}));
});

describe('Avito catch-up replies',()=>{
it('imports an already answered question as history and queues only the new unanswered message',()=>fixture(async(a)=>{
    avito(a.id,{connectedAt:Date.now()-600000});const t=Math.floor(Date.now()/1000);
    const messages=[{id:'old-in',created:t-20,type:'text',author_id:303,content:{text:'Already answered'}},{id:'own-answer',created:t-10,type:'text',author_id:202,content:{text:'Existing answer'}},{id:'new-in',created:t,type:'text',author_id:303,content:{text:'New question'}}];
    axios.request=async c=>response(c.url.includes('/messages/')?{messages}:{id:'chat~history',users:[{id:303,name:'Peer'}]});
    await Avito.importChat(a.id,'chat~history');await Avito.importChat(a.id,'chat~history');
    assert.equal(DB.get("SELECT COUNT(*) n FROM messages WHERE channel='avito'").n,3);
    const jobs=DB.all("SELECT text FROM channel_inbound_jobs WHERE channel='avito'");assert.equal(jobs.length,1);assert.equal(jobs[0].text,'New question');
}));
});

describe('Avito partial provider access',()=>{
it('wraps a full provider window and repairs an out-of-range persisted cursor without an HTTP 400 loop',()=>fixture(async(a)=>{
    avito(a.id);const offsets=[];
    axios.request=async c=>{assert.ok(c.url.endsWith('/chats'));offsets.push(c.params.offset);return response({chats:Array.from({length:10},(_,i)=>({id:'chat-'+i,users:[]}))});};
    // Back off the fixture chats: this test exercises scan pagination only.
    for(let i=0;i<10;i++)Store.progress(a.id,'avito',`chat-access:202:chat-${i}`,{code:'AVITO_CHAT_SUBSCRIPTION_REQUIRED',attempts:1,retryAt:Date.now()+60000});
    Store.progress(a.id,'avito','chat-scan:202',1000);
    assert.equal((await Avito.sync(a.id)).nextOffset,null);
    assert.equal(Store.progress(a.id,'avito','chat-scan:202'),0);
    Store.progress(a.id,'avito','chat-scan:202',1010);
    await Avito.sync(a.id);assert.equal(Store.progress(a.id,'avito','chat-scan:202'),10);
    assert.deepEqual(offsets,[0,1000,0]);
    await assert.rejects(()=>Avito.chats(a.id,{offset:1010}),e=>e.code==='AVITO_OFFSET_INVALID');
}));
it('continues polling other chats after a chat-specific subscription refusal and backs it off',()=>fixture(async(a)=>{
    avito(a.id,{connectedAt:Date.now()+600000});let blockedReads=0;
    axios.request=async c=>{
        if(c.url.endsWith('/chats'))return response({chats:[{id:'limited',users:[]},{id:'available~chat',users:[]}]});
        if(c.url.includes('/limited/messages/')){blockedReads++;throw providerFailure(402);}
        if(c.url.includes('/messages/'))return response({messages:[{id:'m1',created:1,type:'text',author_id:303,content:{text:'History'}}]});
        return response({id:c.url.split('/').at(-1),users:[{id:303,name:'Fixture'}]});
    };
    const one=await Avito.sync(a.id),two=await Avito.sync(a.id);
    assert.equal(one.unavailable,1);assert.equal(one.imported,1);assert.equal(two.unavailable,1);assert.equal(blockedReads,1);
    const status=Store.status(a.id,'avito');assert.equal(status.status,'connected');assert.equal(status.error,null);assert.equal(status.exchange.historyRestrictedChats,1);
    Store.link(a.id,'avito','avito:202:available~chat','202',{externalChatId:'available~chat'});
    await DB.getOrCreateClient(a.id,'avito:202:limited','Limited');
    Store.link(a.id,'avito','avito:202:limited','202',{externalChatId:'limited'});
    assert.deepEqual(Avito.chatAccess(a.id,'avito:202:limited'),{channel:'avito',code:'AVITO_CHAT_SUBSCRIPTION_REQUIRED'});
    assert.equal(Avito.chatAccess(a.id,'avito:202:available~chat'),null);
    assert.equal(DB.get("SELECT COUNT(*) n FROM messages WHERE channel='avito'").n,1);
}));
it('retains global account permission failures instead of treating them as a chat restriction',()=>fixture(async(a)=>{
    avito(a.id);axios.request=async()=>{throw providerFailure(403);};
    await assert.rejects(()=>Avito.messages(a.id,'chat'),e=>e.code==='EXTERNAL_ACCESS_DENIED');
    assert.equal(Store.status(a.id,'avito').status,'access_denied');
}));
it('recovers incoming messages after one intermittent 402 without waiting an hour',()=>fixture(async(a)=>{
    const realNow=Date.now;let now=realNow(),reads=0,writes=0,denied=true;
    Date.now=()=>now;
    try {
        avito(a.id);
        axios.request=async c=>{
            if(c.method!=='GET'){writes++;throw new Error('unexpected write');}
            if(c.url.endsWith('/chats'))return response({chats:[{id:'unstable',users:[]}]});
            if(c.url.includes('/messages/')){reads++;if(denied)throw providerFailure(402);return response({messages:[{id:'new-inbound',created:Math.floor(now/1000),type:'text',author_id:303,content:{text:'Incoming after recovery'}}]});}
            return response({id:'unstable',users:[{id:303,name:'Peer'}]});
        };
        await Avito.sync(a.id);
        denied=false;now+=30000;await Avito.sync(a.id);assert.equal(reads,1);
        now+=31000;const recovered=await Avito.sync(a.id);
        assert.equal(reads,2);assert.equal(recovered.imported,1);assert.equal(writes,0);
        assert.equal(DB.get("SELECT COUNT(*) n FROM channel_inbound_jobs WHERE channel='avito'").n,1);
        assert.equal(Store.progress(a.id,'avito','chat-access:202:unstable'),null);
        await Avito.sync(a.id);
        assert.equal(DB.get("SELECT COUNT(*) n FROM channel_inbound_jobs WHERE channel='avito'").n,1);
    } finally {Date.now=realNow;}
}));
it('imports a new head-page message while continuing the older history scan',()=>fixture(async(a)=>{
    avito(a.id);Store.progress(a.id,'avito','chat-scan:202',500);
    const offsets=[];let writes=0;
    axios.request=async c=>{
        if(c.method!=='GET'){writes++;throw new Error('unexpected write');}
        if(c.url.endsWith('/chats')) {
            offsets.push(c.params.offset);
            return response({chats:c.params.offset===0?[{id:'new-head',users:[]}]:Array.from({length:10},(_,i)=>({id:'old-'+i,users:[]}))});
        }
        if(c.url.includes('/messages/'))return response({messages:c.url.includes('/new-head/')?[{id:'incoming-head',created:Math.floor(Date.now()/1000),type:'text',author_id:303,content:{text:'New question while scanning history'}}]:[]});
        return response({id:c.url.split('/').at(-1),users:[{id:303,name:'Peer'}]});
    };
    const result=await Avito.sync(a.id);
    assert.deepEqual(offsets,[0,500]);assert.equal(result.nextOffset,510);assert.equal(writes,0);
    assert.equal(DB.get("SELECT COUNT(*) n FROM channel_inbound_jobs WHERE channel='avito'").n,1);
    assert.equal(Store.progress(a.id,'avito','chat-scan:202'),510);
}));
it('keeps the history scan moving when an auxiliary newest chat is unavailable',()=>fixture(async(a)=>{
    avito(a.id);Store.progress(a.id,'avito','chat-scan:202',500);
    axios.request=async c=>{
        if(c.url.endsWith('/chats'))return response({chats:c.params.offset===0?[{id:'bad-head',users:[]}]:Array.from({length:10},(_,i)=>({id:'old-'+i,users:[]}))});
        if(c.url.includes('/bad-head'))throw providerFailure(503);
        if(c.url.includes('/messages/'))return response({messages:[]});
        return response({id:c.url.split('/').at(-1),users:[{id:303,name:'Peer'}]});
    };
    const result=await Avito.sync(a.id);
    assert.equal(result.nextOffset,510);assert.equal(result.unavailable,1);
    assert.equal(Store.progress(a.id,'avito','chat-scan:202'),510);
}));
it('still imports the newest message if the historical page fails',()=>fixture(async(a)=>{
    avito(a.id);Store.progress(a.id,'avito','chat-scan:202',500);
    axios.request=async c=>{
        if(c.url.endsWith('/chats')){if(c.params.offset!==0)throw providerFailure(503);return response({chats:[{id:'new-head',users:[]}]});}
        if(c.url.includes('/messages/'))return response({messages:[{id:'head-before-history-failure',created:Math.floor(Date.now()/1000),type:'text',author_id:303,content:{text:'New incoming'}}]});
        return response({id:'new-head',users:[{id:303,name:'Peer'}]});
    };
    await assert.rejects(()=>Avito.sync(a.id),e=>e.code==='EXTERNAL_PROVIDER_UNAVAILABLE');
    assert.equal(DB.get("SELECT COUNT(*) n FROM channel_inbound_jobs WHERE channel='avito'").n,1);
    assert.equal(Store.progress(a.id,'avito','chat-scan:202'),500);
}));
it('does not suppress global rate limits during newest-page polling',()=>fixture(async(a)=>{
    avito(a.id);Store.progress(a.id,'avito','chat-scan:202',500);let calls=0;
    axios.request=async()=>{calls++;throw providerFailure(429);};
    await assert.rejects(()=>Avito.sync(a.id),e=>e.code==='EXTERNAL_RATE_LIMITED');
    assert.equal(calls,1);assert.equal(Store.progress(a.id,'avito','chat-scan:202'),500);
    assert.equal(Store.status(a.id,'avito').status,'rate_limited');
}));
it('increases a persistent 402 cooldown up to an hour and resets after confirmed recovery',()=>fixture(async(a)=>{
    const realNow=Date.now;let now=realNow(),denied=true;
    Date.now=()=>now;
    try {
        avito(a.id,{expiresAt:now+86400000});
        axios.request=async()=>{if(denied)throw providerFailure(402);return response({messages:[]});};
        for(const delay of [60000,120000,240000,480000,960000,1920000,3600000,3600000]) {
            await assert.rejects(()=>Avito.messages(a.id,'unstable'),e=>e.code==='AVITO_CHAT_SUBSCRIPTION_REQUIRED');
            const access=Store.progress(a.id,'avito','chat-access:202:unstable');
            assert.equal(access.retryAt-now,delay);now=access.retryAt;
        }
        denied=false;await Avito.messages(a.id,'unstable');
        assert.equal(Store.progress(a.id,'avito','chat-access:202:unstable'),null);
        denied=true;await assert.rejects(()=>Avito.messages(a.id,'unstable'));
        assert.equal(Store.progress(a.id,'avito','chat-access:202:unstable').retryAt-now,60000);
    } finally {Date.now=realNow;}
}));
it('rechecks legacy one-hour cooldowns once their first minute has passed',()=>fixture(async(a)=>{
    avito(a.id);Store.progress(a.id,'avito','chat-access:202:legacy',{code:'AVITO_CHAT_SUBSCRIPTION_REQUIRED',retryAt:Date.now()+3600000-120000});
    let reads=0;
    axios.request=async c=>{
        if(c.url.endsWith('/chats'))return response({chats:[{id:'legacy',users:[]}]});
        if(c.url.includes('/messages/')){reads++;return response({messages:[]});}
        return response({id:'legacy',users:[{id:303,name:'Peer'}]});
    };
    const recovered=await Avito.sync(a.id);assert.equal(reads,1);assert.equal(recovered.unavailable,0);
    assert.equal(Store.progress(a.id,'avito','chat-access:202:legacy'),null);
}));
});
