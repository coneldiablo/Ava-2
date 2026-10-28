const {describe,it,assert,createTestDB} = require('./test-helper');
const DB = require('../src/services/database.service');
const Telegram = require('../src/services/telegram.service');
const Jobs = require('../src/services/channel-jobs.store');
const Workspace = require('../src/services/ava-workspace.store');
const Canonical = require('../src/services/client-identity.service');
const AI = require('../src/services/ai.service');
const RAG = require('../src/services/rag.service');
const Triggers = require('../src/services/smart-triggers.service');
const Sequence = require('../src/services/sequence.service');
const Personalization = require('../src/services/personalization.service');
const Logger = require('../src/utils/logger');
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(check) { for(let n=0;n<150;n++){if(check())return;await pause(5);} assert.ok(check(),'fixture did not complete'); }
async function fixture(fn) {
    const restore=[];
    const patch=(obj,key,value)=>{const original=obj[key];restore.push(()=>obj[key]=original);obj[key]=value;};
    for (const key of ['info','warn','error']) patch(Logger,key,()=>{});
    createTestDB();
    Telegram.batcher.clearAll();Telegram._bots.clear();Telegram.inFlight.clear();
    patch(Telegram,'delayTime',2);patch(Telegram,'shortDelayTime',2);patch(Telegram,'maxBatchTime',10);
    patch(RAG,'buildConversationContext',async()=>({context:'',searched:true}));
    patch(AI,'getResponse',async()=>({reply:'Fixture reply'}));
    patch(Triggers,'checkKeywordTriggers',async()=>{});patch(Sequence,'onClientReply',async()=>{});
    patch(Personalization,'shouldUpdateProfile',async()=>false);
    const business=await DB.createInstance({name:'Telegram fixture'});
    await DB.updateInstance(business.id,{isActive:1});
    const sends=[];
    const bot={sendMessage:async(chat,text)=>{sends.push({chat:String(chat),text});return {message_id:900+sends.length};}};
    Telegram._bots.set(business.id,bot);
    const event=(message_id=1,text='Fixture question',id=321)=>({message_id,text,chat:{id,type:'private'},from:{id,is_bot:false,first_name:'Fixture'}});
    const retry=async()=>{DB.run("UPDATE channel_inbound_jobs SET availableAt=0 WHERE status='retry'");await Telegram.recoverPending();};
    try { await fn({business,bot,sends,event,patch,retry}); }
    finally { Telegram.batcher.clearAll();Telegram._bots.clear();await until(()=>Telegram.inFlight.size===0);for(const undo of restore.reverse())undo(); }
}

describe('Telegram durable channel processing',()=>{
    it('does not transparently replay a network-ambiguous send in the real Telegram transport',async()=>{
        const Compat=require('../src/services/telegram-bot-compat');
        let attempts=0;
        const bot=new Compat('fixture:token',{fetch:async()=>{attempts++;throw new Error('fixture disconnected after dispatch');}});
        await assert.rejects(()=>bot.sendMessage('321','Fixture'));
        assert.strictEqual(attempts,1);
    });
    it('recovers saved inbound after volatile batching is lost and dedupes replay',async()=>fixture(async({business,sends,event})=>{
        await Telegram._handleMessage(business.id,event());Telegram.batcher.clearAll();
        assert.strictEqual(DB.get('SELECT COUNT(*) n FROM channel_inbound_jobs').n,1);
        await Telegram.recoverPending();await until(()=>DB.get('SELECT status FROM channel_inbound_jobs').status==='completed');
        await Telegram._handleMessage(business.id,event());await Telegram.recoverPending();await pause(15);
        assert.strictEqual(sends.length,1);assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='user'").n,1);
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='assistant'").n,1);
    }));
    it('retries transient AI failure from durable work',async()=>fixture(async({business,sends,event,patch,retry})=>{
        patch(AI,'getResponse',async()=>{throw Object.assign(new Error('fixture'),{code:'FIXTURE_AI_DOWN'});});
        await Telegram._handleMessage(business.id,event());await until(()=>DB.get('SELECT status FROM channel_inbound_jobs')?.status==='retry');
        assert.strictEqual(sends.length,0);
        patch(AI,'getResponse',async()=>({reply:'Recovered'}));await retry();await until(()=>sends.length===1);
        await until(()=>DB.get('SELECT status FROM channel_inbound_jobs').status==='completed');
    }));
    it('does not generate when the manager already controls the canonical client',async()=>fixture(async({business,sends,event,patch})=>{
        await DB.getOrCreateClient(business.id,'tg_321','Fixture');
        Workspace.setControl({businessId:business.id,chatId:'tg_321',mode:'human'});
        let calls=0;patch(AI,'getResponse',async()=>{calls++;return {reply:'Forbidden'};});
        await Telegram._handleMessage(business.id,event());await until(()=>DB.get('SELECT status FROM channel_inbound_jobs')?.status==='suppressed');
        assert.strictEqual(calls,0);assert.strictEqual(sends.length,0);
    }));
    it('preserves generated response when takeover happens during AI and sends nothing',async()=>fixture(async({business,sends,event,patch})=>{
        patch(AI,'getResponse',async()=>{Workspace.setControl({businessId:business.id,chatId:'tg_321',mode:'human'});return {reply:'Saved draft'};});
        await Telegram._handleMessage(business.id,event());await until(()=>DB.get('SELECT status FROM channel_inbound_jobs')?.status==='suppressed');
        assert.strictEqual(sends.length,0);assert.strictEqual(JSON.parse(DB.get('SELECT responseJson FROM channel_inbound_jobs').responseJson).reply,'Saved draft');
        assert.strictEqual(Workspace.getControl(business.id,'tg_321').sendInProgress,undefined);
    }));
    it('uses call memory from a verified Telegram alias and excludes the other tenant',async()=>fixture(async({business,sends,event,patch})=>{
        const customer=await DB.getOrCreateClient(business.id,'79990000001@c.us','Fixture');
        Canonical.attach(business.id,customer.chatId,{kind:'telegram',value:'321'});
        const other=await DB.createInstance({name:'Other fixture'});await DB.updateInstance(other.id,{isActive:1});
        await DB.getOrCreateClient(other.id,'79990000001@c.us','Other');
        const Memory=require('../src/services/crm-memory-store.service');Memory.initSchema(DB.db);
        const policy=require('../src/services/crm-memory-policy.json');
        const insert=(id,summary)=>DB.run(`INSERT INTO crm_memory_summaries(summaryId,instanceId,chatId,kind,sourceKey,sourceHash,summaryJson,sourceUpdatedAt,generatedAt,model,promptVersion,sourceComplete)
            VALUES(?,?,?,'call',?,'fixture',?,'2026-10-15T10:00:00Z','2026-10-15T10:01:00Z','fixture',?,1)`,
            ['summary-'+id,id,customer.chatId,'call-'+id,JSON.stringify({domain:Memory.domain(id),relevance:'relevant',summary}),policy.version]);
        insert(business.id,'Agreed delivery on Friday');insert(other.id,'Other tenant private fact');
        let context;patch(AI,'getResponse',async(_history,value)=>{context=value;return {reply:'Context consumed'};});
        await Telegram._handleMessage(business.id,event());await until(()=>sends.length===1);
        assert.ok(context.lastCallSummary.includes('Friday'));
        assert.ok(!JSON.stringify(context.customerContext).includes('Other tenant private fact'));
        assert.strictEqual(DB.get("SELECT chatId FROM messages WHERE role='user'").chatId,customer.chatId);
    }));
    it('keeps an unknown send fenced through restart, replay and a second inbound',async()=>fixture(async({business,bot,sends,event,patch})=>{
        let attempts=0;patch(bot,'sendMessage',async()=>{attempts++;throw Object.assign(new Error('fixture'),{code:'NETWORK_TIMEOUT'});});
        await Telegram._handleMessage(business.id,event());await until(()=>DB.get('SELECT status FROM channel_inbound_jobs')?.status==='unknown');
        Telegram.batcher.clearAll();await Telegram._handleMessage(business.id,event());
        await Telegram._handleMessage(business.id,event(2,'New question'));await Telegram.recoverPending();await pause(30);
        assert.strictEqual(attempts,1);assert.strictEqual(sends.length,0);
        assert.strictEqual(Workspace.getControl(business.id,'tg_321').sendStatus,'unknown');
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='assistant'").n,0);
    }));
    it('does not send to a Telegram contact unlinked during generation',async()=>fixture(async({business,sends,event,patch})=>{
        const customer=await DB.getOrCreateClient(business.id,'79990000002@c.us','Fixture');
        Canonical.attach(business.id,customer.chatId,{kind:'telegram',value:'321'});
        patch(AI,'getResponse',async()=>{
            const alias=Canonical.list(business.id,customer.chatId).aliases.find(row=>row.kind==='telegram'&&row.id);
            Canonical.unlink(business.id,customer.chatId,alias.id);
            return {reply:'Retained draft'};
        });
        await Telegram._handleMessage(business.id,event());await until(()=>DB.get('SELECT status FROM channel_inbound_jobs')?.status==='suppressed');
        assert.strictEqual(sends.length,0);
        assert.strictEqual(DB.get('SELECT lastErrorCode FROM channel_inbound_jobs').lastErrorCode,'CHANNEL_RECIPIENT_UNLINKED');
    }));
    it('regenerates a stale batch with the new inbound and sends one current reply',async()=>fixture(async({business,sends,event,patch,retry})=>{
        let release,entered=false;
        patch(AI,'getResponse',async(_history,context)=>{if(!entered){entered=true;await new Promise(resolve=>release=resolve);}return {reply:context.currentBatchText};});
        await Telegram._handleMessage(business.id,event(1,'First'));await until(()=>entered);
        await Telegram._handleMessage(business.id,event(2,'Second'));release();
        await until(()=>DB.get("SELECT COUNT(*) n FROM channel_inbound_jobs WHERE status='retry'").n>0);
        await retry();await until(()=>sends.length===1);
        await until(()=>DB.get("SELECT COUNT(*) n FROM channel_inbound_jobs WHERE status='completed'").n===2);
        assert.strictEqual(sends[0].text,'First\nSecond');
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='assistant'").n,1);
    }));
    it('repairs acknowledged grouped history without repeating provider dispatch',async()=>fixture(async({business,sends,event,patch})=>{
        const save=DB.saveMessageWithChannel;
        patch(DB,'saveMessageWithChannel',async(...args)=>{if(args[4]==='assistant')throw new Error('fixture history failure');return save.apply(DB,args);});
        await Telegram._handleMessage(business.id,event(1,'First'));await Telegram._handleMessage(business.id,event(2,'Second'));
        await until(()=>DB.get("SELECT COUNT(*) n FROM channel_inbound_jobs WHERE status='acknowledged'").n===2);
        patch(DB,'saveMessageWithChannel',save);await Telegram.recoverPending();await Telegram.recoverPending();
        assert.strictEqual(sends.length,1);assert.strictEqual(DB.get("SELECT COUNT(*) n FROM messages WHERE role='assistant'").n,1);
        assert.strictEqual(DB.get("SELECT COUNT(*) n FROM channel_inbound_jobs WHERE status='completed'").n,2);
    }));
    it('classifies explicit Telegram 429 as safe and rechecks control immediately before sending',async()=>fixture(async({business,bot,sends,event,patch,retry})=>{
        let attempts=0;patch(bot,'sendMessage',async()=>{attempts++;if(attempts===1)throw Object.assign(new Error('fixture'),{errorCode:429});sends.push({text:'ack'});return {message_id:987};});
        await Telegram._handleMessage(business.id,event());await until(()=>DB.get('SELECT status FROM channel_inbound_jobs')?.status==='retry');
        assert.strictEqual(Workspace.getControl(business.id,'tg_321').sendInProgress,undefined);
        await retry();await until(()=>sends.length===1);
        await until(()=>DB.get('SELECT status FROM channel_inbound_jobs').status==='completed');
        let called=false;const result=await Telegram.sendMessageDetailed(business.id,'321','Blocked',{beforeSend:()=>{called=true;throw Object.assign(new Error('fixture'),{code:'WORKSPACE_HUMAN_CONTROL'});}});
        assert.ok(called);assert.strictEqual(result.safeToRetry,true);assert.strictEqual(attempts,2);
    }));
});
