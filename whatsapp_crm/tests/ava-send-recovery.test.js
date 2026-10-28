'use strict';
const crypto=require('crypto');
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Identity=require('../src/services/identity/identity-store');
const Store=require('../src/services/ava-workspace.store');
const Recovery=require('../src/services/ava-send-recovery.service');
function setup(legacy=false){
    createTestDB();Identity.ensureSchema();
    DB.run("INSERT INTO instances(id,name) VALUES(1,'One'),(2,'Two')");
    for(const [id,role,business] of [['owner','hotel_owner',1],['lead','sales_lead',1],['one','manager',1],['two','manager',1],['observer','observer',1],['foreign','hotel_owner',2]]){
        DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)',[id,id+'@test.example',id]);
        DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)',[id,business,role]);
    }
    DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,'guest','Guest','one'),(1,'second','Second','two'),(2,'guest','Foreign','foreign')");
    if(legacy)DB.db.exec("CREATE TABLE ava_workspace_reply_actions(id TEXT PRIMARY KEY,businessId INTEGER NOT NULL,chatId TEXT NOT NULL,userId TEXT NOT NULL,idempotencyKey TEXT NOT NULL,textHash TEXT NOT NULL,controlRevision INTEGER NOT NULL,status TEXT NOT NULL,messageId TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,UNIQUE(businessId,userId,idempotencyKey))");
    Store.ensureSchema();
    return Object.fromEntries(['owner','lead','one','two','observer','foreign'].map(id=>[id,Identity.actor(id)]));
}
function reserve({id='reply-fixture',businessId=1,chatId='guest',userId='one',content='Hello',status='unknown',legacy=false}={}){
    const control=Store.setControl({businessId,chatId,mode:'human'}),now='2000-01-01T00:00:00.000Z';
    DB.run('INSERT INTO ava_workspace_reply_actions(id,businessId,chatId,userId,idempotencyKey,textHash,controlRevision,status,createdAt,updatedAt,text,dispatchOwnerJson) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[id,businessId,chatId,userId,'key-'+id,crypto.createHash('sha256').update(content).digest('hex'),control.revision,'sending',now,now,legacy?null:content,Store.replyDispatchOwner()]);
    Store.beginHumanSend({businessId,chatId,revision:control.revision,sendId:id});
    DB.db.transaction(()=>Store.markReplyDispatch({businessId,chatId,actionId:id})).immediate();
    if(status==='unknown'){DB.run("UPDATE ava_workspace_reply_actions SET status='unknown',dispatchCompletedAt=? WHERE id=?",[now,id]);Store.endAiSend({businessId,chatId,sendId:id,status});}
    return id;
}
function message(businessId=1,chatId='guest',content='Hello'){return Number(DB.run("INSERT INTO messages(instanceId,chatId,senderName,role,content,channel) VALUES(?,?,'Sender','assistant',?,'whatsapp')",[businessId,chatId,content]).lastInsertRowid);}
function resolve(auth,actionId,outcome='failed',extra={}){return Recovery.reconcile(auth,1,'guest',{actionId,outcome,confirmation:true,reason:'Результат проверен руководителем',...extra});}
function code(fn,expected){assert.throws(fn,error=>error.code===expected);}
describe('AVA unknown reply recovery with durable evidence and audited leadership resolution',()=>{
    it('adds nullable metadata to legacy reservations without changing the original key or hash',()=>{
        const a=setup(true),id=reserve({legacy:true});
        const before=DB.get('SELECT * FROM ava_workspace_reply_actions WHERE id=?',[id]);
        assert.strictEqual(Recovery.detail(a.owner,1,'guest').action.text,null);
        const result=resolve(a.owner,id);
        const after=DB.get('SELECT * FROM ava_workspace_reply_actions WHERE id=?',[id]);
        assert.strictEqual(after.idempotencyKey,before.idempotencyKey);assert.strictEqual(after.textHash,before.textHash);
        assert.strictEqual(result.action.resolution.method,'leadership_confirmation');
        assert.strictEqual(result.action.resolution.previousStatus,'unknown');
        assert.strictEqual(result.control.mode,'human');assert.strictEqual(result.control.sendInProgress,undefined);
    });
    it('reads without expiry or retry and restricts managers to their own status and leaders to live authority',()=>{
        const a=setup(),id=reserve();
        assert.strictEqual(Recovery.detail(a.one,1,'guest').action.id,id);
        assert.strictEqual(Recovery.detail(a.two,1,'guest').action,null);
        code(()=>Recovery.detail(a.two,1,'guest',{actionId:id}),'WORKSPACE_RECOVERY_NOT_FOUND');
        assert.strictEqual(Recovery.detail(a.observer,1,'guest').action.status,'unknown');
        code(()=>resolve(a.one,id),'WORKSPACE_RECOVERY_RESOLVE_DENIED');
        code(()=>resolve(a.observer,id),'CAPABILITY_DENIED');
        code(()=>Recovery.detail(a.foreign,1,'guest'),'BUSINESS_ACCESS_DENIED');
        assert.strictEqual(Store.getControl(1,'guest').sendStatus,'unknown');
        assert.strictEqual(DB.get('SELECT updatedAt FROM ava_workspace_reply_actions WHERE id=?',[id]).updatedAt,'2000-01-01T00:00:00.000Z');
        DB.run("UPDATE ava_business_memberships SET role='manager' WHERE userId='owner' AND businessId=1");
        code(()=>resolve(a.owner,id),'WORKSPACE_RECOVERY_RESOLVE_DENIED');
    });
    it('requires explicit confirmation, a reason, and exact client/business scoped actions',()=>{
        const a=setup(),id=reserve();
        code(()=>resolve(a.owner,id,'failed',{confirmation:false}),'WORKSPACE_INPUT_INVALID');
        code(()=>resolve(a.owner,id,'failed',{reason:' '}),'WORKSPACE_INPUT_INVALID');
        code(()=>Recovery.reconcile(a.owner,1,'second',{actionId:id,outcome:'failed',confirmation:true,reason:'Checked outcome'}),'WORKSPACE_RECOVERY_NOT_FOUND');
        code(()=>resolve(a.owner,id,'failed',{text:'do not send'}),'WORKSPACE_INPUT_INVALID');
        assert.strictEqual(Store.getControl(1,'guest').sendStatus,'unknown');
    });
    it('rejects similar text, unbound evidence and cross-client/business message IDs',()=>{
        const a=setup(),id=reserve();
        const same=message(),other=message(1,'second'),foreign=message(2,'guest');
        for(const evidenceMessageId of [same,other,foreign])code(()=>resolve(a.owner,id,'sent',{evidenceMessageId}),'WORKSPACE_RECOVERY_EVIDENCE_INVALID');
        for(const messageId of [other,foreign])code(()=>Store.recordReplyAcknowledgement({businessId:1,chatId:'guest',actionId:id,messageId,providerMessageId:'ack'}),'WORKSPACE_RECOVERY_EVIDENCE_INVALID');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_workspace_reply_resolutions').n,0);
        assert.strictEqual(Store.getControl(1,'guest').sendStatus,'unknown');
    });
    it('reconciles exact durable ACK provenance and prevents contradictory manual confirmation',()=>{
        const a=setup(),id=reserve(),messageId=message();
        Store.recordReplyAcknowledgement({businessId:1,chatId:'guest',actionId:id,messageId,providerMessageId:'provider-ack'});
        code(()=>resolve(a.lead,id,'failed'),'WORKSPACE_RECOVERY_EVIDENCE_CONFLICT');
        const result=resolve(a.lead,id,'sent',{evidenceMessageId:messageId});
        assert.strictEqual(result.action.status,'sent');assert.strictEqual(result.action.messageId,'provider-ack');
        assert.strictEqual(result.action.resolution.method,'provider_ack');
        assert.strictEqual(result.action.resolution.actorUserId,'lead');assert.strictEqual(result.action.resolution.evidenceMessageId,messageId);
        assert.strictEqual(result.history.length,1);assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_workspace_reply_actions').n,1);
        const next=reserve({id:'next',status:'sending'}),revision=Store.getControl(1,'guest').revision;
        assert.strictEqual(resolve(a.owner,id,'sent').action.resolution.id,result.action.resolution.id);
        assert.strictEqual(Store.getControl(1,'guest').revision,revision);
        assert.strictEqual(DB.get('SELECT activeSendId FROM ava_conversation_control WHERE businessId=1 AND chatId=?',['guest']).activeSendId,next);
    });
    it('uses durable channel ACK before local history only with exact server action correlation',()=>{
        const a=setup(),id=reserve();
        DB.db.exec('CREATE TABLE ava_channel_delivery_evidence(businessId INTEGER,chatId TEXT,providerMessageId TEXT,idempotencyKey TEXT,storedMessageId INTEGER,createdAt TEXT)');
        DB.run('INSERT INTO ava_channel_delivery_evidence VALUES(?,?,?,?,NULL,?)',[1,'guest','channel-ack','key-'+id,new Date().toISOString()]);
        assert.strictEqual(Recovery.detail(a.owner,1,'guest').evidence.length,0);
        DB.run('UPDATE ava_channel_delivery_evidence SET idempotencyKey=?',[id]);
        assert.strictEqual(Recovery.detail(a.owner,1,'guest').evidence[0].providerMessageId,'channel-ack');
        code(()=>resolve(a.owner,id,'failed'),'WORKSPACE_RECOVERY_EVIDENCE_CONFLICT');
        const result=resolve(a.owner,id,'sent');
        assert.strictEqual(result.action.resolution.method,'provider_ack');
        assert.strictEqual(result.action.messageId,'channel-ack');
        assert.strictEqual(result.action.resolution.evidenceMessageId,null);
    });
    it('preserves the old idempotency key after confirmed failure and never calls the provider on replay',async()=>{
        const a=setup(),id=reserve();resolve(a.owner,id);
        const Router=require('../src/services/channel-router.service'),original=Router.sendMessageDetailed;let calls=0;
        Router.sendMessageDetailed=async()=>{calls++;throw Error('Unexpected provider call');};
        try{const result=await require('../src/services/ava-workspace.service').reply(a.one,1,'guest',{text:'Hello',idempotencyKey:'key-'+id});assert.strictEqual(result.status,'failed');assert.strictEqual(calls,0);}
        finally{Router.sendMessageDetailed=original;}
        code(()=>resolve(a.owner,id,'sent'),'WORKSPACE_RECOVERY_CONFLICT');
        assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_workspace_reply_resolutions').n,1);
    });
    it('persists actual reply reservation, dispatch timestamps and exact provider ACK before replay',async()=>{
        const a=setup(),Workspace=require('../src/services/ava-workspace.service');
        const Router=require('../src/services/channel-router.service'),original=Router.sendMessageDetailed;
        const body={text:'Durable authenticated answer',idempotencyKey:'integrated-provider-ack'};
        let calls=0,savedId,actionId;
        Router.sendMessageDetailed=async(businessId,chatId,content,_channel,context)=>{
            calls++;
            const reserved=DB.get('SELECT * FROM ava_workspace_reply_actions WHERE businessId=? AND userId=? AND idempotencyKey=?',[businessId,a.one.userId,body.idempotencyKey]);
            assert.strictEqual(reserved.text,body.text);assert.strictEqual(reserved.status,'sending');
            assert.strictEqual(reserved.dispatchOwnerJson,Store.replyDispatchOwner());
            assert.strictEqual(reserved.dispatchStartedAt,null);assert.strictEqual(reserved.dispatchCompletedAt,null);
            actionId=reserved.id;
            assert.strictEqual(context.actionId,actionId);assert.strictEqual(context.sendId,actionId);assert.strictEqual(context.idempotencyKey,body.idempotencyKey);
            context.beforeSend();
            assert.ok(DB.get('SELECT dispatchStartedAt FROM ava_workspace_reply_actions WHERE id=?',[actionId]).dispatchStartedAt);
            savedId=message(businessId,chatId,content);
            return {success:true,stored_message_id:savedId,provider_message_id:'exact-integration-ack'};
        };
        try{
            const result=await Workspace.reply(a.one,1,'guest',body);
            const action=DB.get('SELECT * FROM ava_workspace_reply_actions WHERE id=?',[actionId]);
            const evidence=DB.get('SELECT * FROM ava_workspace_reply_evidence WHERE actionId=?',[actionId]);
            assert.strictEqual(result.status,'sent');assert.strictEqual(action.status,'sent');
            assert.strictEqual(action.text,body.text);assert.strictEqual(action.messageId,'exact-integration-ack');
            assert.ok(Number.isFinite(Date.parse(action.dispatchStartedAt)));
            assert.ok(Date.parse(action.dispatchCompletedAt)>=Date.parse(action.dispatchStartedAt));
            assert.strictEqual(JSON.parse(action.dispatchOwnerJson).pid,process.pid);
            assert.strictEqual(evidence.messageId,savedId);assert.strictEqual(evidence.providerMessageId,'exact-integration-ack');
            assert.strictEqual(evidence.textHash,action.textHash);assert.strictEqual(evidence.chatId,'guest');assert.strictEqual(evidence.businessId,1);
            assert.strictEqual(result.control.sendInProgress,undefined);
            assert.strictEqual((await Workspace.reply(a.one,1,'guest',body)).status,'sent');assert.strictEqual(calls,1);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_workspace_reply_actions').n,1);
        }finally{Router.sendMessageDetailed=original;}
    });
    it('keeps acknowledged success when optional local ACK evidence cannot be bound',async()=>{
        const a=setup(),Router=require('../src/services/channel-router.service'),original=Router.sendMessageDetailed;
        Router.sendMessageDetailed=async(_business,_chat,_text,_channel,context)=>{
            context.beforeSend();
            return {success:true,stored_message_id:999999,provider_message_id:'actual-ack'};
        };
        try{
            const result=await require('../src/services/ava-workspace.service').reply(a.one,1,'guest',{text:'Acknowledged',idempotencyKey:'bad-local-binding'});
            assert.strictEqual(result.status,'sent');assert.strictEqual(result.messageId,'actual-ack');
            assert.strictEqual(Store.getControl(1,'guest').sendInProgress,undefined);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_workspace_reply_evidence').n,0);
            assert.strictEqual(DB.get('SELECT status FROM ava_workspace_reply_actions WHERE idempotencyKey=?',['bad-local-binding']).status,'sent');
        }finally{Router.sendMessageDetailed=original;}
    });
    it('keeps live and unverifiable sending fenced, but permits audited recovery after confirmed owner process exit',()=>{
        const a=setup(),id=reserve({status:'sending'});
        code(()=>resolve(a.owner,id),'WORKSPACE_RECOVERY_CONFLICT');
        DB.run('UPDATE ava_workspace_reply_actions SET dispatchOwnerJson=NULL WHERE id=?',[id]);
        code(()=>resolve(a.owner,id),'WORKSPACE_RECOVERY_CONFLICT');
        const {spawnSync}=require('child_process'),child=spawnSync(process.execPath,['-e',''],{timeout:5000});
        assert.strictEqual(child.status,0);
        const owner=JSON.parse(Store.replyDispatchOwner());owner.pid=child.pid;
        DB.run('UPDATE ava_workspace_reply_actions SET dispatchOwnerJson=? WHERE id=?',[JSON.stringify(owner),id]);
        assert.strictEqual(Recovery.detail(a.owner,1,'guest').action.abandonedDispatch,true);
        const result=resolve(a.owner,id);assert.strictEqual(result.action.status,'failed');
        assert.strictEqual(result.action.resolution.previousStatus,'sending');
        assert.strictEqual(result.control.sendInProgress,undefined);
    });
    it('serializes competing leadership resolutions across independent SQLite processes',async()=>{
        setup();const id=reserve(),fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process');
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ava-recovery-race-')),file=path.join(dir,'fixture.db'),children=[];
        try{
            await DB.db.backup(file);
            const ready=await Promise.all(['sent','failed'].map(outcome=>new Promise((resolve,reject)=>{
                const script=`const D=require(${JSON.stringify(require.resolve('../src/services/database.service'))});D.db=new(require(${JSON.stringify(require.resolve('better-sqlite3'))}))(${JSON.stringify(file)});D.db.pragma('busy_timeout=10000');D.db.pragma('foreign_keys=ON');const R=require(${JSON.stringify(require.resolve('../src/services/ava-send-recovery.service'))});R.detail({userId:'owner'},1,'guest');process.send({ready:true});process.on('message',()=>{let result;try{R.reconcile({userId:'owner'},1,'guest',{actionId:${JSON.stringify(id)},outcome:${JSON.stringify(outcome)},confirmation:true,reason:'Confirmed by supervisor'});result='resolved';}catch(e){result=e.code;}D.db.close();process.send({result},()=>process.exit(0));});`;
                const child=spawn(process.execPath,['-e',script],{stdio:['ignore','ignore','pipe','ipc']});children.push(child);child.once('error',reject);child.once('message',()=>resolve(child));
            })));
            const results=await Promise.all(ready.map(child=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Race timeout'));},15000);child.once('message',value=>{clearTimeout(timer);resolve(value.result);});child.send('go');})));
            assert.strictEqual(results.filter(value=>value==='resolved').length,1);
            assert.ok(results.includes('WORKSPACE_RECOVERY_CONFLICT'));
            const reopened=new(require('better-sqlite3'))(file);try{assert.strictEqual(reopened.prepare('SELECT COUNT(*) AS n FROM ava_workspace_reply_resolutions').get().n,1);assert.strictEqual(reopened.prepare('SELECT activeSendId FROM ava_conversation_control WHERE businessId=1 AND chatId=?').get('guest').activeSendId,null);}finally{reopened.close();}
        }finally{for(const child of children)if(child.exitCode===null)child.kill();fs.rmSync(dir,{recursive:true,force:true});}
    });
    it('serves the additive recovery routes with existing business and origin guards',async()=>{
        const a=setup(),id=reserve(),express=require('express'),app=express();
        app.use(express.json());app.use((req,_res,next)=>{req.auth=a[req.get('x-test-role')||'owner'];next();});app.use('/api',require('../src/routes/ava-workspace.routes'));
        const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),origin='http://127.0.0.1:'+server.address().port,previous=process.env.WHATSAPP_CRM_PUBLIC_URL;
        process.env.WHATSAPP_CRM_PUBLIC_URL=origin;
        const url=origin+'/api/businesses/1/workspace/clients/guest/reply-recovery',body={actionId:id,outcome:'failed',confirmation:true,reason:'Supervisor checked outcome'};
        try{
            const read=await fetch(url,{headers:{'x-test-role':'observer'}});assert.strictEqual(read.status,200);assert.strictEqual((await read.json()).canResolve,false);
            const post=headers=>fetch(url,{method:'POST',headers:{'content-type':'application/json',Origin:origin,...headers},body:JSON.stringify(body)});
            assert.strictEqual((await post({'x-test-role':'one'})).status,403);
            assert.strictEqual((await post({Origin:'https://foreign.example'})).status,403);
            const resolved=await post({'x-test-role':'lead'});assert.strictEqual(resolved.status,200);assert.strictEqual((await resolved.json()).action.status,'failed');
        }finally{await new Promise(resolve=>server.close(resolve));if(previous===undefined)delete process.env.WHATSAPP_CRM_PUBLIC_URL;else process.env.WHATSAPP_CRM_PUBLIC_URL=previous;}
    });
});
