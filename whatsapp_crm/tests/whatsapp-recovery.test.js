const { describe, it, assert, createTestDB } = require('./test-helper');
const DB = require('../src/services/database.service');
const WhatsApp = require('../src/services/whatsapp.service');
const AI = require('../src/services/ai.service');
const Onyx = require('../src/services/onyx-knowledge.service');
const RAG = require('../src/services/rag.service');
const Gateway = require('../src/services/whatsapp-gateway.service');
const OpenWA = require('../src/services/openwa.service');
const Green = require('../src/services/green-api.service');
const Push = require('../src/services/push.service');
const Triggers = require('../src/services/smart-triggers.service');
const Sequence = require('../src/services/sequence.service');
const Personalization = require('../src/services/personalization.service');
const Logger = require('../src/utils/logger');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i=0;i<100;i++) { if (check()) return; await pause(5); } assert.ok(check(), 'fixture did not complete'); }
async function fixture(fn) {
    createTestDB();
    const originals=[];
    const patch=(obj,key,value)=>{ const previous=obj[key]; originals.push(()=>obj[key]=previous); obj[key]=value; };
    const sends=[]; const calls=[]; const logs=[];
    patch(WhatsApp,'delayTime',2); patch(WhatsApp,'shortDelayTime',2); patch(WhatsApp,'maxBatchTime',15);
    patch(Onyx,'answer',async args=>{calls.push(args); return null;});
    patch(RAG,'buildConversationContext',async()=>({context:''}));
    patch(AI,'getResponse',async()=>({reply:'Fixture reply',action:'none'}));
    patch(Gateway,'getState',async()=>({success:true,effectiveState:'authorized'}));
    patch(Gateway,'sendMessage',async(instance,chatId,text)=>{sends.push({instanceId:instance.id,chatId,text});return {success:true,data:{idMessage:'fake-ack'}};});
    for (const [obj,key] of [[Push,'notifyNewLead'],[Triggers,'checkKeywordTriggers'],[Sequence,'onClientReply'],[Personalization,'analyzeContactTimes']]) patch(obj,key,async()=>{});
    for (const key of ['info','warn','error']) patch(Logger,key,(...args)=>logs.push(args.map(String).join(' ')));
    WhatsApp._stateCache = new Map();
    const business=await DB.createInstance({name:'Recovery fixture',openWaSessionId:'fixture-session'});
    await DB.updateInstance(business.id,{isActive:1,openWaSessionId:'fixture-session'});
    const event=(id='inbound-1',body='Fixture question')=>({event:'message.received',sessionId:'fixture-session',data:{id,from:'79991111111@c.us',body,fromMe:false}});
    try { await fn({business,sends,calls,logs,event,patch}); }
    finally { WhatsApp.batcher.clearAll(); for(const restore of originals.reverse()) restore(); }
}

describe('WhatsApp ingress and durable recovery',()=>{
    it('retries a saved inbound after generation failure and duplicate webhook without a second inbox row',async()=>fixture(async({business,sends,event,patch})=>{
        patch(AI,'getResponse',async()=>{throw Object.assign(new Error('fixture'),{code:'FIXTURE_MODEL_DOWN'});});
        await WhatsApp.processOpenWaWebhook(event(),business.id);
        await pause(35);
        assert.strictEqual(sends.length,0);
        patch(AI,'getResponse',async()=>({reply:'Recovered reply'}));
        // Recovery retries only the durable job; same provider ID must remain deduped.
        if (WhatsApp.recoverPending) DB.run('UPDATE whatsapp_reply_jobs SET nextAt=0');
        await WhatsApp.processOpenWaWebhook(event(),business.id);
        await until(()=>sends.length===1);
        await WhatsApp.processOpenWaWebhook(event(),business.id); await pause(25);
        assert.strictEqual(sends.length,1);
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='user'").n,1);
    }));
    it('recovers after the volatile queue is cleared without waiting for provider redelivery',async()=>fixture(async({business,sends,event})=>{
        await WhatsApp.processOpenWaWebhook(event(),business.id);
        WhatsApp.batcher.clearAll();
        await WhatsApp.recoverPending();
        await until(()=>sends.length===1);
        assert.strictEqual(DB.get('SELECT state FROM whatsapp_reply_jobs').state,'done');
    }));
    it('a stale running batch retains both ordered inbound messages in the replacement reply',async()=>fixture(async({business,sends,event,patch})=>{
        let release; let entered=false;
        patch(AI,'getResponse',async(_history,context)=>{if(!entered){entered=true;await new Promise(r=>release=r);} return {reply:context.currentBatchText};});
        await WhatsApp.processOpenWaWebhook(event('first','First fixture'),business.id);
        await until(()=>entered);
        await WhatsApp.processOpenWaWebhook(event('second','Second fixture'),business.id);
        release(); await pause(30);
        DB.run('UPDATE whatsapp_reply_jobs SET nextAt=0'); await WhatsApp.recoverPending();
        await until(()=>sends.length===1);
        assert.strictEqual(sends[0].text,'First fixture\nSecond fixture');
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM whatsapp_reply_jobs WHERE state='done'").n,2);
    }));
    it('does not replay an uncertain 5xx send or classify it as an assistant reply',async()=>fixture(async({business,sends,event,patch})=>{
        let attempts=0;
        patch(Gateway,'sendMessage',async()=>{attempts++;return {success:false,statusCode:503,code:'WHATSAPP_SEND_ACK_UNKNOWN'};});
        await WhatsApp.processOpenWaWebhook(event(),business.id); await pause(35);
        assert.strictEqual(DB.get('SELECT state FROM whatsapp_reply_jobs').state,'uncertain');
        await WhatsApp.processOpenWaWebhook(event(),business.id); await WhatsApp.recoverPending(); await pause(25);
        assert.strictEqual(attempts,1); assert.strictEqual(sends.length,0);
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='assistant'").n,0);
    }));
    it('repairs history after provider ACK and save failure without a second send',async()=>fixture(async({business,sends,event,patch})=>{
        const save=DB.saveMessage;
        patch(DB,'saveMessage',async(...args)=>{if(args[4]==='assistant')throw new Error('fixture save failure');return save.apply(DB,args);});
        await WhatsApp.processOpenWaWebhook(event(),business.id); await until(()=>sends.length===1); await pause(10);
        assert.strictEqual(DB.get('SELECT state FROM whatsapp_reply_jobs').state,'acknowledged');
        patch(DB,'saveMessage',save); await WhatsApp.recoverPending(); await WhatsApp.recoverPending();
        assert.strictEqual(sends.length,1); assert.strictEqual(DB.get('SELECT state FROM whatsapp_reply_jobs').state,'done');
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='assistant'").n,1);
    }));
    it('recovers expired processing but fences expired sending after restart',async()=>fixture(async({business,sends,event})=>{
        await WhatsApp.processOpenWaWebhook(event('pending'),business.id); WhatsApp.batcher.clearAll();
        DB.run("UPDATE whatsapp_reply_jobs SET state='processing',leaseUntil=0");
        await WhatsApp.recoverPending(); await until(()=>sends.length===1);
        await WhatsApp.processOpenWaWebhook(event('sending'),business.id); WhatsApp.batcher.clearAll();
        DB.run("UPDATE whatsapp_reply_jobs SET state='sending',leaseUntil=0 WHERE state='queued'");
        await WhatsApp.recoverPending(); await pause(20);
        assert.strictEqual(sends.length,1); assert.strictEqual(DB.get("SELECT state FROM whatsapp_reply_jobs ORDER BY messageId DESC LIMIT 1").state,'uncertain');
    }));
    it('rechecks reconnect without cached negative state and keeps bot enabled',async()=>fixture(async({business,sends,event,patch})=>{
        patch(Gateway,'getState',async()=>({success:true,effectiveState:'disconnected'}));
        await WhatsApp.processOpenWaWebhook(event(),business.id); await pause(30);
        assert.strictEqual(sends.length,0); assert.strictEqual((await DB.getInstance(business.id)).isActive,1);
        patch(Gateway,'getState',async()=>({success:true,effectiveState:'authorized'}));
        DB.run('UPDATE whatsapp_reply_jobs SET nextAt=0'); await WhatsApp.recoverPending(); await until(()=>sends.length===1);
    }));
    it('scopes identical source IDs and shared chat IDs to two businesses',async()=>fixture(async({business,sends,calls,event})=>{
        const other=await DB.createInstance({name:'Other fixture'}); await DB.updateInstance(other.id,{isActive:1});
        await WhatsApp.processOpenWaWebhook(event(),business.id); await WhatsApp.processOpenWaWebhook(event(),other.id);
        await until(()=>sends.length===2);
        assert.deepStrictEqual(sends.map(s=>s.instanceId).sort(),[business.id,other.id].sort());
        assert.deepStrictEqual(calls.map(c=>c.businessId).sort(),[business.id,other.id].sort());
    }));
    it('filters fromMe/status/group/unsupported events and preserves extended text for both providers',async()=>fixture(async({business,sends,event})=>{
        await WhatsApp.processOpenWaWebhook({...event('out'),data:{...event().data,fromMe:true}},business.id);
        await WhatsApp.processOpenWaWebhook({...event('status'),event:'message.ack'},business.id);
        await WhatsApp.processOpenWaWebhook({...event('group'),data:{...event().data,from:'fixture@g.us'}},business.id);
        await WhatsApp.processWebhook({typeWebhook:'incomingMessageReceived',idMessage:'media',senderData:{chatId:'79991111111@c.us'},messageData:{typeMessage:'locationMessage'}},business.id);
        await WhatsApp.processWebhook({typeWebhook:'incomingMessageReceived',idMessage:'green-extended',senderData:{chatId:'79991111111@c.us'},messageData:{typeMessage:'extendedTextMessage',extendedTextMessageData:{text:'Green extended'}}},business.id);
        await until(()=>sends.length===1);
        await WhatsApp.processOpenWaWebhook({event:'message.received',data:{id:'open-extended',from:'79991111111@c.us',message:{extendedTextMessage:{text:'Open extended'}}}},business.id);
        await until(()=>sends.length===2);
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='user'").n,2);
    }));
    it('continues with scoped local knowledge when Onyx fails and logs no fixture content',async()=>fixture(async({business,sends,event,patch,logs})=>{
        patch(Onyx,'answer',async()=>{throw new Error('fixture private provider error');});
        patch(RAG,'buildConversationContext',async()=>({context:'Scoped fixture source'}));
        patch(AI,'getResponse',async(_h,c)=>{assert.strictEqual(c.instanceId,business.id);assert.strictEqual(c.ragContext,'Scoped fixture source');return {reply:'Grounded fixture reply'};});
        await WhatsApp.processOpenWaWebhook(event(),business.id);await until(()=>sends.length===1);
        assert.ok(!logs.join('\n').includes('Fixture question'));assert.ok(!logs.join('\n').includes('79991111111@c.us'));
    }));
});

describe('WhatsApp recovery persistence and send fencing',()=>{
    it('installs its migration without replaying earlier WhatsApp history',async()=>fixture(async({business,sends})=>{
        await DB.getOrCreateClient(business.id,'79992222222@c.us','Fixture');
        await DB.saveMessage(business.id,'79992222222@c.us','Fixture','Archived fixture','user',null,'historic-id');
        await WhatsApp.recoverPending(); await pause(25);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM whatsapp_reply_jobs').n,0);
        assert.strictEqual(sends.length,0);
    }));
    it('rolls back the inbox insertion when durable job creation cannot commit',async()=>fixture(async({business,event})=>{
        WhatsApp._ensureReplySchema();
        DB.db.exec("CREATE TRIGGER reject_fixture_job BEFORE INSERT ON whatsapp_reply_jobs BEGIN SELECT RAISE(ABORT,'FIXTURE_JOB_FAILURE'); END");
        await assert.rejects(()=>WhatsApp.processOpenWaWebhook(event(),business.id),/FIXTURE_JOB_FAILURE/);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM messages').n,0);
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM whatsapp_reply_jobs').n,0);
    }));
    it('recovers queued jobs from a reopened SQLite file and does not replay completed replies',async()=>fixture(async({business,sends,event})=>{
        const fs=require('fs'); const os=require('os'); const path=require('path'); const SQLite=require('better-sqlite3');
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whatsapp-restart-')); const file=path.join(dir,'crm.db');
        await WhatsApp.processOpenWaWebhook(event(),business.id); WhatsApp.batcher.clearAll();
        await DB.db.backup(file); DB.db.close(); DB.db=new SQLite(file);
        try {
            await WhatsApp.recoverPending(); await until(()=>sends.length===1); await until(()=>DB.get('SELECT state FROM whatsapp_reply_jobs').state==='done');
            WhatsApp.batcher.clearAll(); DB.db.close(); DB.db=new SQLite(file);
            await WhatsApp.recoverPending(); await WhatsApp.processOpenWaWebhook(event(),business.id); await pause(25);
            assert.strictEqual(sends.length,1); assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='user'").n,1);
        } finally { DB.db.close(); fs.rmSync(dir,{recursive:true,force:true}); }
    }));
    it('a burst of repeated deliveries yields one ordered response and one row per source ID',async()=>fixture(async({business,sends,event})=>{
        for(let i=0;i<10;i++) { await WhatsApp.processOpenWaWebhook(event(`burst-${i}`,`Fixture ${i}`),business.id); await WhatsApp.processOpenWaWebhook(event(`burst-${i}`,`Fixture ${i}`),business.id); }
        await until(()=>sends.length===1);
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='user'").n,10);
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM whatsapp_reply_jobs WHERE state='done'").n,10);
    }));
    it('does not use a second transport after 5xx or missing primary acceptance proof',async()=>{
        const open=OpenWA.sendMessage,green=Green.sendMessage; let fallback=0;
        const cfg={id:1,openWaSessionId:'fixture',greenApiInstance:'fixture',greenApiToken:'fixture'};
        Green.sendMessage=async()=>{fallback++;return {success:true,data:{idMessage:'green-ack'}};};
        try {
            for(const result of [{success:false,statusCode:503},{success:true,data:{}}]) {
                OpenWA.sendMessage=async()=>result;
                const response=await Gateway.sendMessage(cfg,'79991111111@c.us','Fixture');
                assert.strictEqual(response.success,false); assert.strictEqual(response.safeToRetry,false);
            }
            assert.strictEqual(fallback,0);
        } finally { OpenWA.sendMessage=open;Green.sendMessage=green; }
    });
    it('bounds stalled read-only knowledge/model work with a coded deadline',async()=>fixture(async({patch})=>{
        await assert.rejects(()=>WhatsApp._withDeadline(new Promise(()=>{}),5,'WHATSAPP_AI_TIMEOUT'),e=>e.code==='WHATSAPP_AI_TIMEOUT');
    }));
});


describe('WhatsApp supported attachments',()=>{
    it('preserves supported GreenAPI and OpenWA media as durable inbound before batching',async()=>fixture(async({business,event,sends})=>{
        for(const typeMessage of ['imageMessage','videoMessage','documentMessage','audioMessage'])
            await WhatsApp.processWebhook({typeWebhook:'incomingMessageReceived',idMessage:typeMessage,senderData:{chatId:'79991111111@c.us'},messageData:{typeMessage}},business.id);
        for(const type of ['image','video','document','audio'])
            await WhatsApp.processOpenWaWebhook({event:'message.received',data:{id:type,from:'79991111111@c.us',type,fromMe:false}},business.id);
        await until(()=>sends.length===1);
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='user'").n,8);
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM whatsapp_reply_jobs WHERE state='done'").n,8);
    }));
});

describe('WhatsApp HTTP ingress contract',()=>{
    it('verifies session-scoped HMAC before inbox insertion and retries unmapped provider ingress',async()=>fixture(async({business,sends,event,logs})=>{
        const express=require('express'),crypto=require('crypto'),Connection=require('../src/services/whatsapp-connection.service');
        const previous=process.env.OPENWA_API_KEY;process.env.OPENWA_API_KEY='fixture-shared-webhook-key-32-chars';
        const app=express();app.use(express.json({verify:(req,_res,raw)=>req.rawBody=Buffer.from(raw)}));
        app.use('/api',require('../src/routes/api.routes'));
        const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
        const url=`http://127.0.0.1:${server.address().port}/api`;
        const post=async(path,body,signature)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...(signature?{'x-openwa-signature':signature}:{})},body:JSON.stringify(body)});
        try{
            const payload=event('http-message');const inst=await DB.getInstance(business.id);
            const sign=body=>'sha256='+crypto.createHmac('sha256',Connection.signingSecret(inst)).update(JSON.stringify(body)).digest('hex');
            assert.strictEqual((await post('/webhook/openwa',payload)).status,401);
            assert.strictEqual(DB.get('SELECT COUNT(*) n FROM messages').n,0);
            const tampered={...payload,data:{...payload.data,body:'PRIVATE_HTTP_CONTENT'}};
            assert.strictEqual((await post('/webhook/openwa',tampered,sign(payload))).status,401);
            assert.strictEqual((await post('/webhook/openwa',payload,sign(payload))).status,200);
            await until(()=>sends.length===1);
            assert.strictEqual((await post('/webhook',payload,sign(payload))).status,200);await pause(20);
            assert.strictEqual(sends.length,1);
            const other=await DB.createInstance({name:'Other webhook tenant'});await DB.updateInstance(other.id,{openWaSessionId:'other-session'});
            const crossed={...payload,sessionId:'other-session'};
            assert.strictEqual((await post('/webhook/openwa',crossed,sign(crossed))).status,401);
            assert.strictEqual((await post('/webhook/green-api',{instanceData:{idInstance:'not-mapped'}})).status,404);
            await DB.updateInstance(business.id,{greenApiInstance:'known-provider',greenApiToken:'fixture-green-token-at-least16'});
            const greenBody={instanceData:{idInstance:'known-provider'},typeWebhook:'incomingMessageReceived',idMessage:'green-http-id',senderData:{chatId:'79991111111@c.us'},messageData:{typeMessage:'textMessage',textMessageData:{textMessage:'Fixture Green HTTP'}}};
            assert.strictEqual((await post('/webhook/green-api',greenBody)).status,401);
            const token=Connection.greenWebhookToken(await DB.getInstance(business.id));
            const signedGreen=await fetch(url+'/webhook/green-api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(greenBody)});
            assert.strictEqual(signedGreen.status,200);await until(()=>sends.length===2);
            assert.strictEqual((await post('/webhook',{typeWebhook:'PRIVATE_HTTP_CONTENT',senderName:'PRIVATE_HTTP_NAME'})).status,200);
            assert.ok(!logs.join('\n').match(/PRIVATE_HTTP_CONTENT|PRIVATE_HTTP_NAME|fixture@c\.us|http-message/));
        }finally{await new Promise(resolve=>server.close(resolve));if(previous===undefined)delete process.env.OPENWA_API_KEY;else process.env.OPENWA_API_KEY=previous;}
    }));
});


describe('WhatsApp running lease handoff',()=>{
    it('fences a late generation and releases its exact lease after an orderly DB reopen',async()=>fixture(async({business,event,sends,patch})=>{
        const fs=require('fs'),os=require('os'),path=require('path'),SQLite=require('better-sqlite3');
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whatsapp-running-reopen-')),file=path.join(dir,'crm.db');
        let release,entered=false;
        patch(AI,'getResponse',async()=>{entered=true;await new Promise(r=>release=r);return {reply:'Old fenced fixture'};});
        await WhatsApp.processOpenWaWebhook(event(),business.id);await until(()=>entered);
        await DB.db.backup(file);DB.db.close();DB.db=new SQLite(file);
        try{
            release();await until(()=>DB.get('SELECT state FROM whatsapp_reply_jobs').state==='queued');
            assert.strictEqual(sends.length,0);assert.strictEqual(DB.get('SELECT leaseToken FROM whatsapp_reply_jobs').leaseToken,null);
            patch(AI,'getResponse',async()=>({reply:'New fixture reply'}));await WhatsApp.recoverPending();await until(()=>sends.length===1);
            assert.strictEqual(sends[0].text,'New fixture reply');
        }finally{DB.db.close();fs.rmSync(dir,{recursive:true,force:true});}
    }));
});
