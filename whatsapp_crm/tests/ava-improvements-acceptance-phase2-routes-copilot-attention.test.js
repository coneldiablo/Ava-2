'use strict';
if (process.env.AVA_ACCEPTANCE_PHASE2 !== '1') return;

const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const Identity = require('../src/services/identity/identity-store');
const Auth = require('../src/services/auth.service');
const AI = require('../src/services/ai.service');
const Flags = require('../src/services/ava-improvements-flags.service');
const Workspace = require('../src/services/ava-workspace.service');
const Control = require('../src/services/ava-workspace.store');
const Collaboration = require('../src/services/ava-collaboration.service');
const Availability = require('../src/services/ava-availability.service');
const Copilot = require('../src/services/ava-copilot.service');
const Attention = require('../src/services/ava-attention.service');
const Autopilot = require('../src/services/ava-autopilot.service');
const Review = require('../src/services/ava-knowledge-review.service');
const Canonical = require('../src/services/client-identity.service');
const chat = '79998887766@c.us';

async function fixture(fn) {
    const previousDb = DB.db, enabled = Auth.config.enabled, generate = AI.generatePlainText;
    const env = Object.fromEntries(['AVA_IMPROVEMENTS_BUSINESSES', 'AVA_WORKSPACE_BUSINESSES', 'AVA_CUSTOMER_ACCESS_ENABLED', 'WHATSAPP_CRM_PUBLIC_URL'].map(key => [key, process.env[key]]));
    Object.assign(process.env, { AVA_IMPROVEMENTS_BUSINESSES: '*', AVA_WORKSPACE_BUSINESSES: '*', AVA_CUSTOMER_ACCESS_ENABLED: 'true' });
    const db = createTestDB();
    try {
        Identity.ensureSchema(); DB.createSalesWorkspaceTables();
        DB.run("INSERT INTO instances(id,name,isActive,aiProvider,yandexGptKey,yandexGptModelUri) VALUES(1,'Local business',1,'yandex','synthetic-key','gpt://synthetic/model'),(2,'FOREIGN_BUSINESS_SECRET',1,'yandex','synthetic-key-two','gpt://synthetic-two/model')");
        for (const [id, role, business] of [['owner','hotel_owner',1], ['lead','sales_lead',1], ['manager','manager',1], ['peer','manager',1], ['observer','observer',1], ['foreign','hotel_owner',2]]) {
            DB.run('INSERT INTO ava_users(id,subject,email,displayName) VALUES(?,?,?,?)', [id, 'phase2-' + id, id + '@example.test', id]);
            DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)', [id,business,role]);
        }
        DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,?,'Customer','manager'),(1,'peer-chat','Peer','peer'),(1,'queue','Queue',NULL),(2,?,'FOREIGN_CUSTOMER_SECRET','foreign')", [chat,chat]);
        Control.ensureSchema(); Collaboration.ensureSchema(); Availability.ensureSchema(); Review.ensureSchema();
        Canonical.attach(1, chat, {kind:'telegram', value:'88001122'});
        const message = await DB.saveMessageWithChannel(1, chat, 'Guest', 'Уточните условия, пожалуйста.', 'user', 'whatsapp');
        await DB.saveMessageWithChannel(2, chat, 'Foreign', 'FOREIGN_MESSAGE_SECRET', 'user', 'whatsapp');
        const actors = Object.fromEntries(['owner','lead','manager','peer','observer','foreign'].map(id => [id,Identity.actor(id)]));
        AI.generatePlainText = async () => JSON.stringify({text:'Уточним условия и удобное время.', sourceIds:['message:' + message.id]});
        await fn(actors, message.id);
    } finally {
        AI.generatePlainText = generate; Auth.config.enabled = enabled;
        db.close(); DB.db = previousDb;
        for (const [key,value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
}

async function http(actors, fn) {
    Auth.config.enabled = true;
    const tokens = Object.fromEntries(Object.keys(actors).map(id => [id,Identity.createSession('phase2-' + id,'phase2-session-' + id)]));
    const app = require('../src/app').app;
    const server = await new Promise(resolve => { const value = app.listen(0,'127.0.0.1',() => resolve(value)); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    process.env.WHATSAPP_CRM_PUBLIC_URL = origin;
    try {
        await fn(async (actor, method, suffix, body, headers = {}) => {
            const response = await fetch(origin + '/api/businesses/1' + suffix, {
                method, headers:{Cookie:'crm_session=ava2:' + tokens[actor],Origin:origin,'Content-Type':'application/json',...headers},
                ...(body === undefined ? {} : {body:JSON.stringify(body)}),
            });
            const raw = await response.text();
            let data; try { data = JSON.parse(raw); } catch (_) { throw new Error('Non-JSON route response ' + method + ' ' + suffix + ' status=' + response.status); }
            return {status:response.status,body:data};
        });
    } finally { await new Promise(resolve => server.close(resolve)); }
}
const test = (name, fn) => it('phase2 app/copilot/attention: ' + name, () => fixture(fn));
const totals = () => Object.fromEntries(['messages','manager_tasks','ava_quotes','ava_client_promises','ava_knowledge_review_drafts'].map(table => [table,DB.get('SELECT COUNT(*) n FROM ' + table).n]));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise,resolve}; }
async function bounded(promise) { let timer; try { return await Promise.race([promise,new Promise((_,reject) => { timer=setTimeout(() => reject(new Error('Phase2 interleaving exceeded 5s')),5000); })]); } finally { clearTimeout(timer); } }

describe('Independent phase2 real app integration, copilot and attention', () => {
    test('real session-auth endpoints expose documented envelopes and exact live role boundaries', async a => {
        let aiCalls=0; const original=AI.generatePlainText;
        AI.generatePlainText=async(...args) => { aiCalls++; return original(...args); };
        await http(a,async request => {
            for (const suffix of ['/workspace/availability','/workspace/attention','/workspace/knowledge-review','/workspace/clients/tg_88001122/presence']) {
                const read=await request('observer','GET',suffix);
                assert.strictEqual(read.status,200,suffix);
                assert.strictEqual(read.body.success,true); assert.strictEqual(read.body.businessId,1);
                assert.strictEqual((await request('foreign','GET',suffix)).status,403,suffix);
                assert.strictEqual((await request('owner','GET',suffix + '?businessId=2')).status,403,suffix);
            }
            for (const [method,suffix,body] of [
                ['POST','/workspace/clients/tg_88001122/presence',{sessionId:'browser',typing:true}],
                ['PATCH','/workspace/availability/manager',{revision:0,status:'off'}],
                ['POST','/workspace/clients/tg_88001122/copilot',{intent:'reply'}],
                ['POST','/workspace/knowledge-review/drafts',{question:'Условия?',source:{type:'message',id:'1',chatId:chat}}],
            ]) {
                assert.strictEqual((await request('observer',method,suffix,body)).status,403,suffix);
                assert.strictEqual((await request('owner',method,suffix,body,{Origin:'https://foreign.example'})).status,403,suffix);
            }
            assert.strictEqual(aiCalls,0);
            assert.strictEqual((await request('manager','PATCH','/workspace/availability/peer',{revision:0,status:'off'})).status,403);
            assert.strictEqual((await request('lead','PATCH','/workspace/availability/manager',{revision:0,status:'break',capacity:2})).status,200);
            const before=totals();
            const draft=await request('manager','POST','/workspace/clients/tg_88001122/copilot',{intent:'reply'});
            assert.strictEqual(draft.status,200); assert.strictEqual(draft.body.businessId,1);
            assert.strictEqual(typeof draft.body.dialogueRevision,'string'); assert.strictEqual(draft.body.draft.kind,'reply');
            assert.strictEqual(aiCalls,1); assert.deepStrictEqual(totals(),before);
        });
    });

    test('all new routes return feature-disabled after authorization while existing client/task/control APIs stay usable', async a => {
        Flags.update(a.owner,1,{revision:0,flags:Object.fromEntries(Flags.FEATURES.map(key => [key,false]))});
        await http(a,async request => {
            for (const [method,suffix,body] of [
                ['GET','/workspace/availability'],['GET','/workspace/attention'],['GET','/workspace/knowledge-review'],
                ['GET','/workspace/clients/' + encodeURIComponent(chat) + '/presence'],
                ['POST','/workspace/clients/' + encodeURIComponent(chat) + '/copilot',{intent:'reply'}],
            ]) {
                const off=await request('owner',method,suffix,body);
                assert.strictEqual(off.status,409,suffix + ' disabled status');
                assert.strictEqual(off.body.code,'WORKSPACE_FEATURE_DISABLED',suffix + ' disabled code');
                assert.strictEqual((await request('foreign',method,suffix,body)).status,403,suffix + ' authorize before flags');
            }
            const view=await request('manager','GET','/workspace/clients/tg_88001122');
            assert.strictEqual(view.status,200); assert.strictEqual(view.body.client.chatId,chat);
            assert.strictEqual((await request('manager','POST','/workspace/clients/tg_88001122/control',{mode:'human'})).status,200);
            assert.strictEqual((await request('manager','POST','/sales-workspace/tasks',{chatId:chat,summary:'Связаться с клиентом'})).status,201);
        });
    });

    test('copilot uses actual dialogue helper, rejects slow revocation, same-client inbound and knowledge change without effects', async (a,messageId) => {
        for (const change of ['revocation','inbound','knowledge']) {
            const began=deferred(), release=deferred();
            AI.generatePlainText=async(messages) => {
                assert.ok(messages[1].content.includes('Уточните условия'));
                assert.ok(!messages[1].content.includes('FOREIGN_MESSAGE_SECRET'));
                began.resolve(); return bounded(release.promise);
            };
            const before=totals();
            const pending=Copilot.generate(a.manager,1,'tg_88001122',{intent:'next_action'});
            try {
                await bounded(began.promise);
                if(change==='revocation') DB.run("UPDATE ava_business_memberships SET role='observer' WHERE businessId=1 AND userId='manager'");
                if(change==='inbound') await DB.saveMessageWithChannel(1,chat,'Guest','Новая просьба клиента','user','telegram');
                if(change==='knowledge') DB.run("INSERT INTO knowledge_base(instanceId,filename,originalName) VALUES(1,'new.txt','New knowledge')");
                if(change==='knowledge') DB.run("INSERT INTO kb_chunks(kbId,chunkIndex,text,searchText) VALUES(last_insert_rowid(),0,'Новые условия','новые условия')");
                release.resolve(JSON.stringify({text:'Уточнить условия с клиентом.',sourceIds:['message:' + messageId]}));
                await assert.rejects(() => bounded(pending),error => ['CAPABILITY_DENIED','COPILOT_CONTEXT_CHANGED'].includes(error.code),change);
                assert.strictEqual(totals().manager_tasks,before.manager_tasks);
                assert.strictEqual(totals().ava_quotes,before.ava_quotes);
                assert.strictEqual(totals().ava_client_promises,before.ava_client_promises);
            } finally {
                release.resolve(JSON.stringify({text:'Уточнить условия с клиентом.',sourceIds:['message:' + messageId]}));
                await pending.catch(() => {});
                DB.run("UPDATE ava_business_memberships SET role='manager' WHERE businessId=1 AND userId='manager'");
            }
        }
    });

    test('foreign inbound does not invalidate own copilot; published catalog controls price; finite timeout and cancellation', async (a,messageId) => {
        const began=deferred(), release=deferred();
        AI.generatePlainText=async() => { began.resolve(); return bounded(release.promise); };
        const own=Copilot.generate(a.manager,1,chat,{intent:'reply'});
        await bounded(began.promise);
        await DB.saveMessageWithChannel(2,chat,'Foreign','FOREIGN_MESSAGE_CHANGED','user','whatsapp');
        release.resolve(JSON.stringify({text:'Уточним условия.',sourceIds:['message:' + messageId]}));
        const result=await bounded(own);
        assert.strictEqual(result.dialogueRevision,Collaboration.dialogueRevision(1,chat));
        const Store=require('../src/services/ava-autopilot.store');
        const offer={id:'phase2-offer',revision:1,name:'Монтаж',description:'По согласованию',terms:'',amountMinor:123450,currency:'RUB',active:true,publishedAt:new Date().toISOString()};
        Store.saveOffer(1,offer); Store.publishOffer(1,offer);
        AI.generatePlainText=async() => JSON.stringify({text:'Монтаж: [[price:phase2-offer]].',sourceIds:['offer:phase2-offer'],offerId:'phase2-offer'});
        const priced=await Copilot.generate(a.manager,1,chat,{intent:'offer'});
        assert.strictEqual(priced.draft.text,'Монтаж: 1234.50 RUB.');
        AI.generatePlainText=async() => JSON.stringify({text:'Монтаж стоит 5 рублей.',sourceIds:['offer:phase2-offer'],offerId:'phase2-offer'});
        await assert.rejects(() => Copilot.generate(a.manager,1,chat,{intent:'offer'}),error => error.code==='COPILOT_INVALID_RESPONSE');
        AI.generatePlainText=async() => new Promise(() => {});
        await assert.rejects(() => Copilot.generate(a.manager,1,chat,{intent:'reply'},{timeoutMs:20}),error => error.code==='COPILOT_TIMEOUT');
        const controller=new AbortController(); controller.abort();
        await assert.rejects(() => Copilot.generate(a.manager,1,chat,{intent:'reply'},{signal:controller.signal}),error => error.code==='COPILOT_CANCELED');
    });

    test('attention deduplicates persisted reasons, suppresses completed/answered/snoozed items, links queue exhaustion', async a => {
        DB.run("UPDATE messages SET timestamp=? WHERE instanceId=1",[new Date(Date.now()-3600000).toISOString()]);
        const task=DB.createManagerTask({instanceId:1,chatId:chat,summary:'Перезвонить',dueAt:new Date(Date.now()-60000).toISOString(),assigneeUserId:'manager'});
        const promise=Workspace.createPromise(a.manager,1,{chatId:chat,summary:'Уточнить',dueAt:new Date(Date.now()-60000).toISOString()}).promise;
        let items=Attention.list(a.manager,1).items;
        assert.ok(items.some(item => item.type==='response_overdue'));
        assert.ok(items.some(item => item.type==='task_overdue'));
        assert.ok(items.some(item => item.type==='promise_overdue'));
        assert.strictEqual(new Set(items.map(item => item.id)).size,items.length);
        assert.ok(items.every(item => item.chatId!== 'peer-chat'));
        await DB.saveMessageWithChannel(1,chat,'Manager','Отвечено','assistant','whatsapp');
        DB.run("UPDATE manager_tasks SET status='done' WHERE instanceId=1 AND taskId=?",[task.taskId]);
        Workspace.updatePromise(a.manager,1,promise.id,{revision:promise.revision,status:'done'});
        items=Attention.list(a.manager,1).items;
        assert.ok(!items.some(item => item.chatId===chat && ['response_overdue','task_overdue','promise_overdue'].includes(item.type)));
        Control.setControl({businessId:1,chatId:chat,mode:'human'});
        Control.beginHumanSend({businessId:1,chatId:chat,sendId:'phase2-uncertain'});
        Control.endAiSend({businessId:1,chatId:chat,sendId:'phase2-uncertain',status:'unknown'});
        assert.strictEqual(Attention.list(a.manager,1).items.filter(item => item.chatId===chat && item.type==='send_unknown').length,1);
        Workspace.snooze(a.manager,1,chat,{until:new Date(Date.now()+3600000).toISOString()});
        assert.ok(!Attention.list(a.manager,1).items.some(item => item.chatId===chat));
        assert.ok(Attention.list(a.owner,1).items.some(item => item.chatId===chat && item.type==='send_unknown'));
        const policy=Autopilot.updatePolicy(a.owner,1,{revision:0,enabled:true,routing:{enabled:true,memberIds:['manager','peer']}}).policy;
        const simulation=Autopilot.simulations(a.owner,1,{revision:policy.revision}).simulation;
        Autopilot.publish(a.owner,1,{revision:policy.revision,simulationId:simulation.id});
        Availability.patch(a.owner,1,'manager',{revision:0,status:'available',capacity:1});
        Availability.patch(a.owner,1,'peer',{revision:0,status:'off'});
        const empty=Attention.list(a.owner,1).items.filter(item => item.chatId==='queue' && item.type==='no_available_member');
        assert.strictEqual(empty.length,1); assert.strictEqual(empty[0].href,'/today?client=queue');
    });
});
