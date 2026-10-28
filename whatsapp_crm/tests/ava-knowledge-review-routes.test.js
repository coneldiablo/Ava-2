'use strict';

const { describe, it, assert, createTestDB } = require('./test-helper');
const express = require('express');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Sales = require('../src/services/sales-workspace.service');

function setup() {
    createTestDB(); Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES(1,'Synthetic business'),(2,'Foreign business')");
    for (const [userId, businessId] of [['owner', 1], ['foreign', 2]]) {
        DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)', [userId, userId+'@test.example', 'Synthetic owner']);
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,'hotel_owner')", [userId,businessId]);
    }
}

async function http(service, fn, userId = 'owner') {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.auth = { userId }; next(); });
    app.use('/api', require('../src/routes/ava-knowledge-review.routes').createRouter(service));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const origin = 'http://127.0.0.1:'+server.address().port;
    const previous = process.env.WHATSAPP_CRM_PUBLIC_URL;
    process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
    try {
        await fn((method, path, body, headers = {}) => fetch(origin+'/api/businesses/1/workspace/knowledge-review'+path, {
            method, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }), origin);
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previous === undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;
        else process.env.WHATSAPP_CRM_PUBLIC_URL = previous;
    }
}

function adapter(calls) {
    const service = { authorize: (auth, id) => Sales.authorize(auth, id) };
    for (const method of ['list','createDraft','updateDraft','checkDraft','publishDraft','rollbackDraft']) {
        service[method] = async (...args) => {
            calls.push({ method, args });
            return { success: true, businessId: args[1], draft: { id: 'synthetic' } };
        };
    }
    return service;
}

function liveAdapter(options) {
    const Review=require('../src/services/ava-knowledge-review.service');
    const service={authorize:(auth,id)=>Review.authorize(auth,id,'sales.read',options)};
    for(const name of ['list','createDraft','updateDraft','checkDraft','publishDraft','rollbackDraft']) {
        service[name]=(...args)=>{
            args[args.length-1]={...args.at(-1),...options};
            return Review[name](...args);
        };
    }
    return service;
}

describe('Knowledge review HTTP transport boundaries', () => {
    it('maps all actions, revisions, human confirmation, idempotency and cancellation signal', async () => {
        setup(); const calls = [];
        await http(adapter(calls), async request => {
            assert.strictEqual((await request('GET','?limit=20')).status, 200);
            assert.strictEqual((await request('POST','/drafts',{ question: 'Delivery?', source: { type: 'message', id: '1', chatId: 'guest' } }, { 'Idempotency-Key': 'create-1' })).status, 201);
            assert.strictEqual((await request('PATCH','/drafts/draft-1',{revision:1,question:'Delivery?',answer:'Tomorrow'})).status, 200);
            for (const action of ['check','publish','rollback']) {
                assert.strictEqual((await request('POST','/drafts/draft-1/'+action,{revision:2,confirm:true},{'Idempotency-Key':action+'-1'})).status,200);
            }
        });
        assert.deepStrictEqual(calls.map(c=>c.method), ['list','createDraft','updateDraft','checkDraft','publishDraft','rollbackDraft']);
        assert.deepStrictEqual(calls[0].args[2], {limit:'20'});
        assert.strictEqual(calls[1].args.at(-1).idempotencyKey, 'create-1');
        assert.strictEqual(calls[3].args[2], 'draft-1');
        assert.deepStrictEqual(calls[4].args[3], {revision:2,confirm:true});
        assert.ok(calls.every(c=>c.args.at(-1).signal instanceof AbortSignal));
        assert.ok(calls.every(c=>c.args[1]===1));
    });
    it('blocks foreign origin, missing origin, cross-site metadata and contradictory business scope before service effects', async () => {
        setup(); const calls=[];
        await http(adapter(calls), async request => {
            for (const headers of [{Origin:'https://foreign.example'},{Origin:''},{'Sec-Fetch-Site':'cross-site'}]) {
                const response=await request('POST','/drafts',{},headers);
                assert.strictEqual(response.status,403);
                assert.strictEqual((await response.json()).code,'KNOWLEDGE_REVIEW_ORIGIN_REQUIRED');
            }
            assert.strictEqual((await request('POST','/drafts',{businessId:2})).status,403);
            assert.strictEqual((await request('GET','?instance_id=2')).status,403);
        });
        assert.strictEqual(calls.length,0);
    });
    it('uses live account membership on every HTTP request', async () => {
        setup(); const calls=[];
        await http(adapter(calls), async request => {
            assert.strictEqual((await request('GET','')).status,200);
            DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='owner'");
            assert.strictEqual((await request('GET','')).status,403);
        });
        assert.strictEqual(calls.length,1);
        await http(adapter(calls), async request => assert.strictEqual((await request('GET','')).status,403), 'foreign');
        assert.strictEqual(calls.length,1);
    });
    it('returns only safe typed errors and never provider exception details', async () => {
        setup(); const service=adapter([]);
        service.checkDraft=async()=>{throw Object.assign(new Error('KNOWLEDGE_REVIEW_CONFLICT'),{code:'KNOWLEDGE_REVIEW_CONFLICT',statusCode:409});};
        service.createDraft=async()=>{throw new Error('sensitive provider request payload');};
        await http(service,async request=>{
            let response=await request('POST','/drafts/d/check',{revision:1});
            assert.strictEqual(response.status,409);
            assert.deepStrictEqual(await response.json(),{success:false,code:'KNOWLEDGE_REVIEW_CONFLICT'});
            response=await request('POST','/drafts',{});
            assert.strictEqual(response.status,503);
            assert.deepStrictEqual(await response.json(),{success:false,code:'KNOWLEDGE_REVIEW_UNAVAILABLE'});
        });
    });
    it('aborts pending AI work when the browser disconnects', async () => {
        setup(); const service=adapter([]);
        let entered, cancelled;
        const started=new Promise(resolve=>{entered=resolve;});
        const stopped=new Promise(resolve=>{cancelled=resolve;});
        service.createDraft=async(...args)=>{
            const signal=args.at(-1).signal;
            entered();
            return new Promise((_,reject)=>signal.addEventListener('abort',()=>{
                cancelled();
                reject(Object.assign(new Error('cancelled'),{code:'KNOWLEDGE_REVIEW_CANCELLED',statusCode:409}));
            },{once:true}));
        };
        await http(service,async(_request,origin)=>{
            const controller=new AbortController();
            const pending=fetch(origin+'/api/businesses/1/workspace/knowledge-review/drafts',{
                method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
                body:'{}',signal:controller.signal,
            }).catch(error=>error);
            await started; controller.abort();
            let timer;
            try {
                await Promise.race([stopped,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('AI cancellation was not forwarded')),2000);})]);
                assert.strictEqual((await pending).name,'AbortError');
            } finally { clearTimeout(timer); }
        });
    });
    it('executes the real local service lifecycle over HTTP and exposes the approved answer through current retrieval',async()=>{
        setup();
        DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES(1,'guest','Synthetic client')");
        const sourceId=Number(DB.run("INSERT INTO messages(instanceId,chatId,senderName,role,content) VALUES(1,'guest','Synthetic client','user','Как работает доставка?')").lastInsertRowid);
        const authority='Стандартная доставка бесплатно. Экспресс доставка стоит 500 рублей.';
        const documentId=Number(DB.addKnowledgeBaseFile(1,'synthetic.txt','Условия доставки','synthetic-authority-hash','text/plain'));
        await DB.addKnowledgeBaseChunks(documentId,[authority]);
        const chunkId=DB.getDocumentChunks(1,documentId)[0].id;
        const service=liveAdapter({flags:{assertEnabled(){}},ai:{generatePlainText:async messages=>{
            const prompt=JSON.parse(messages[1].content);
            return JSON.stringify(prompt.candidateAnswer===undefined?{answer:'Стандартная доставка бесплатно.'}:{passed:true,reason:'Supported by independent policy.',citations:[{documentId,chunkId,quote:authority}]});
        }}});
        await http(service,async request=>{
            const send=async(method,path,body,key)=>{
                const response=await request(method,path,body,key?{'Idempotency-Key':key}:{});
                const data=await response.json();
                assert.ok(response.ok,JSON.stringify(data));return data;
            };
            let {draft}=await send('POST','/drafts',{question:'Как работает доставка?',source:{type:'message',id:String(sourceId),chatId:'guest'}},'http-create');
            assert.strictEqual(draft.revision,1);
            draft=(await send('PATCH','/drafts/'+draft.id,{revision:draft.revision,answer:'Экспресс доставка стоит 500 рублей.'},'http-edit')).draft;
            draft=(await send('POST','/drafts/'+draft.id+'/check',{revision:draft.revision},'http-check')).draft;
            assert.strictEqual(draft.check.status,'passed');
            const body={revision:draft.revision,confirm:true};
            draft=(await send('POST','/drafts/'+draft.id+'/publish',body,'http-publish')).draft;
            assert.strictEqual(draft.status,'published');
            assert.strictEqual(draft.sync.state,'local_only');
            const replay=await send('POST','/drafts/'+draft.id+'/publish',body,'http-publish');
            assert.strictEqual(replay.draft.revision,draft.revision);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM knowledge_base').n,2);
            const chunks=DB.getDocumentChunks(1,draft.currentDocumentId);
            assert.ok(chunks[0].text.includes('500 рублей'));
            assert.ok(DB.searchChunksByFTS5(1,'экспресс',10).some(row=>row.kbId===draft.currentDocumentId));
            const list=await send('GET','?chatId=guest');
            assert.strictEqual(list.drafts[0].id,draft.id);
            assert.strictEqual(list.candidates[0].source.id,String(sourceId));
            assert.strictEqual(list.versions.length,draft.history.length);
        });
    });
    it('fails closed when the feature is off before any real service mutation',async()=>{
        setup();
        const service=liveAdapter({flags:{assertEnabled(){throw Object.assign(new Error('off'),{code:'AVA_IMPROVEMENTS_DISABLED',statusCode:404});}}});
        await http(service,async request=>{
            for(const [method,path,body] of [['GET','',undefined],['POST','/drafts',{}]]) {
                const response=await request(method,path,body);
                assert.strictEqual(response.status,404);
                assert.deepStrictEqual(await response.json(),{success:false,code:'AVA_IMPROVEMENTS_DISABLED'});
            }
        });
        assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM knowledge_base").n,0);
    });
    it('preserves the actual deployment and owner feature-off error instead of reporting an outage',async()=>{
        const previousAllowlist=process.env.AVA_IMPROVEMENTS_BUSINESSES;
        const previousWorkspace=process.env.AVA_WORKSPACE_BUSINESSES;
        const Flags=require('../src/services/ava-improvements-flags.service');
        try {
            process.env.AVA_WORKSPACE_BUSINESSES='*';
            for(const mode of ['deployment','business']) {
                setup();
                process.env.AVA_IMPROVEMENTS_BUSINESSES=mode==='deployment'?'':'*';
                if(mode==='business') Flags.update({userId:'owner'},1,{revision:0,flags:{knowledgeReview:false}});
                await http(undefined,async request=>{
                    for(const [method,path,body] of [['GET','',undefined],['POST','/drafts',{}],['POST','/drafts/synthetic/check',{revision:1}]]) {
                        const response=await request(method,path,body);
                        assert.strictEqual(response.status,409);
                        assert.deepStrictEqual(await response.json(),{success:false,code:'WORKSPACE_FEATURE_DISABLED'});
                    }
                });
                assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM knowledge_base').n,0);
                assert.strictEqual(DB.get("SELECT 1 FROM sqlite_master WHERE name='ava_knowledge_review_operations'"),undefined);
            }
        } finally {
            if(previousAllowlist===undefined) delete process.env.AVA_IMPROVEMENTS_BUSINESSES;
            else process.env.AVA_IMPROVEMENTS_BUSINESSES=previousAllowlist;
            if(previousWorkspace===undefined) delete process.env.AVA_WORKSPACE_BUSINESSES;
            else process.env.AVA_WORKSPACE_BUSINESSES=previousWorkspace;
        }
    });
    it('preserves the actual safe flags-storage failure code without exposing malformed stored data',async()=>{
        setup();
        const Flags=require('../src/services/ava-improvements-flags.service');Flags.ensureSchema();
        DB.run('INSERT INTO ava_improvement_flags VALUES(1,1,?,?,?)',['{private-invalid-json','owner',new Date().toISOString()]);
        await http(undefined,async request=>{
            const response=await request('GET','');
            assert.strictEqual(response.status,503);
            assert.deepStrictEqual(await response.json(),{success:false,code:'WORKSPACE_FEATURES_UNAVAILABLE'});
        });
    });
    it('requires an explicit current-answer attestation over HTTP to publish new knowledge into an empty corpus',async()=>{
        setup();
        DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES(1,'guest','Synthetic client')");
        const sourceId=Number(DB.run("INSERT INTO messages(instanceId,chatId,senderName,role,content) VALUES(1,'guest','Synthetic client','user','Какой пароль Wi-Fi?')").lastInsertRowid);
        const service=liveAdapter({flags:{assertEnabled(){}},ai:{generatePlainText:async messages=>{
            const prompt=JSON.parse(messages[1].content);
            return JSON.stringify(prompt.candidateAnswer===undefined?{answer:'Пароль гостевого Wi-Fi: synthetic-guest.'}:{passed:false,manualRequired:true,reason:'Требуется подтверждение ответственного сотрудника.',citations:[]});
        }}});
        await http(service,async request=>{
            let response=await request('POST','/drafts',{question:'Какой пароль Wi-Fi?',source:{type:'message',id:String(sourceId),chatId:'guest'}},{'Idempotency-Key':'manual-http-create'});
            assert.strictEqual(response.status,201);
            let draft=(await response.json()).draft;
            response=await request('POST','/drafts/'+draft.id+'/check',{revision:draft.revision},{'Idempotency-Key':'manual-http-check'});
            assert.strictEqual(response.status,200);
            draft=(await response.json()).draft;
            assert.strictEqual(draft.check.status,'manual_required');
            assert.strictEqual(draft.check.passed,false);
            assert.strictEqual(draft.check.needsConfirmation,true);
            assert.strictEqual(draft.status,'draft');
            response=await request('POST','/drafts/'+draft.id+'/publish',{revision:draft.revision,confirm:true});
            assert.strictEqual(response.status,409);
            assert.strictEqual((await response.json()).code,'KNOWLEDGE_REVIEW_ATTESTATION_REQUIRED');
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM knowledge_base').n,0);
            response=await request('POST','/drafts/'+draft.id+'/publish',{
                revision:draft.revision,confirm:true,
                attestation:{confirm:true,revision:draft.check.revision,contentHash:draft.check.contentHash,sourceHash:draft.check.sourceHash},
            },{'Idempotency-Key':'manual-http-publish'});
            assert.strictEqual(response.status,200);
            draft=(await response.json()).draft;
            assert.strictEqual(draft.status,'published');
            assert.strictEqual(draft.approval.type,'human_confirmed');
            assert.strictEqual(draft.approval.userId,'owner');
            assert.strictEqual(draft.check.passed,false);
            assert.strictEqual(draft.check.status,'manual_required');
            assert.strictEqual(draft.history[0].approval.type,'human_confirmed');
            assert.strictEqual(DB.getDocumentChunks(1,draft.currentDocumentId)[0].text.includes('synthetic-guest'),true);
        });
    });
});
