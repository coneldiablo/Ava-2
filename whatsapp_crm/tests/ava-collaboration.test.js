'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Identity=require('../src/services/identity/identity-store');
const Store=require('../src/services/ava-workspace.store');
const Collaboration=require('../src/services/ava-collaboration.service');
const Workspace=require('../src/services/ava-workspace.service');
const Router=require('../src/services/channel-router.service');
const express=require('express');
function setup(enabled=true) {
    createTestDB();Identity.ensureSchema();
    process.env.AVA_IMPROVEMENTS_BUSINESSES=enabled?'1':'';
    DB.run("INSERT INTO instances(id,name) VALUES(1,'One'),(2,'Two')");
    for(const [id,role,business] of [['owner','hotel_owner',1],['lead','sales_lead',1],['one','manager',1],['two','manager',1],['observer','observer',1],['foreign','manager',2]]) {
        DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)',[id,id+'@test.example','Same name']);
        DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)',[id,business,role]);
    }
    DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,'guest','Guest','one'),(1,'second','Second','two'),(1,'queue','Queue',NULL),(2,'guest','Foreign','foreign')");
    Collaboration.ensureSchema();
    return Object.fromEntries(['owner','lead','one','two','observer','foreign'].map(id=>[id,Identity.actor(id)]));
}
function message(business=1,chat='guest',content='Inbound') {
    return Number(DB.run("INSERT INTO messages(instanceId,chatId,senderName,role,content) VALUES(?,?,?,'user',?)",[business,chat,'Guest',content]).lastInsertRowid);
}
function revision() {return Collaboration.dialogueRevision(1,'guest');}
function code(fn,name) {assert.throws(fn,e=>e.code===name);}
async function provider(fn,run) {const old=Router.sendMessageDetailed;Router.sendMessageDetailed=fn;try{await run();}finally{Router.sendMessageDetailed=old;}}
describe('AVA collaboration leases and transactional dialogue replies',()=>{
    it('uses 45s scoped leases, deduplicates users across sessions and never stores draft text',()=>{
        const a=setup(),before=revision();
        Collaboration.heartbeat(a.one,1,'guest',{sessionId:'tab1',typing:true});
        Collaboration.heartbeat(a.one,1,'guest',{sessionId:'tab2',typing:false});
        Collaboration.heartbeat(a.owner,1,'guest',{sessionId:'owner-tab',typing:false});
        let p=Collaboration.presence(a.observer,1,'guest');
        assert.strictEqual(p.participants.length,2);assert.ok(p.participants.find(x=>x.userId==='one').typing);
        assert.ok(Math.abs(Date.parse(p.participants[0].expiresAt)-Date.now()-45000)<1000);
        assert.strictEqual(p.dialogueRevision,before);
        code(()=>Collaboration.heartbeat(a.one,1,'guest',{sessionId:'tab',typing:true,text:'secret'}),'WORKSPACE_INPUT_INVALID');
        DB.run('UPDATE ava_collaboration_presence SET expiresAt=? WHERE userId=?',[Date.now()-1,'one']);
        assert.deepStrictEqual(Collaboration.presence(a.owner,1,'guest').participants.map(x=>x.userId),['owner']);
        const columns=DB.all('PRAGMA table_info(ava_collaboration_presence)').map(x=>x.name);assert.ok(!columns.includes('text'));
    });
    it('rechecks exact live assignment, role and tenant, resolving proven channel alias',()=>{
        const a=setup();require('../src/services/client-identity.service').attach(1,'guest',{kind:'telegram',value:'99110001'});
        Collaboration.heartbeat(a.one,1,'tg_99110001',{sessionId:'linked',typing:true});
        assert.strictEqual(Collaboration.presence(a.owner,1,'guest').participants[0].userId,'one');
        code(()=>Collaboration.heartbeat(a.two,1,'guest',{sessionId:'wrong',typing:true}),'SALES_CLIENT_SCOPE_DENIED');
        code(()=>Collaboration.heartbeat(a.one,1,'queue',{sessionId:'queue',typing:true}),'SALES_CLIENT_CLAIM_REQUIRED');
        code(()=>Collaboration.heartbeat(a.observer,1,'guest',{sessionId:'observer',typing:false}),'CAPABILITY_DENIED');
        code(()=>Collaboration.presence(a.foreign,1,'guest'),'BUSINESS_ACCESS_DENIED');
        DB.run("UPDATE clients SET assigneeUserId='two' WHERE instanceId=1 AND chatId='guest'");
        assert.strictEqual(Collaboration.presence(a.owner,1,'guest').participants.length,0);
        DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='one'");
        code(()=>Collaboration.heartbeat(a.one,1,'guest',{sessionId:'revoked',typing:true}),'BUSINESS_ACCESS_DENIED');
    });
    it('bounds session churn to ten leases per user/client and separates identical session IDs',()=>{
        const a=setup();for(let i=0;i<30;i++)Collaboration.heartbeat(a.one,1,'guest',{sessionId:'tab'+i,typing:false});
        Collaboration.heartbeat(a.owner,1,'guest',{sessionId:'tab29',typing:true});
        assert.strictEqual(DB.get("SELECT COUNT(*) AS n FROM ava_collaboration_presence WHERE userId='one'").n,10);
        assert.strictEqual(Collaboration.presence(a.owner,1,'guest').participants.length,2);
    });
    it('durably invalidates message insertion/edit/deletion, calls, transcripts and assignment, preserving tenant scope',()=>{
        setup();let previous=revision();const check=()=>{const next=revision();assert.ok(BigInt(next)>BigInt(previous));previous=next;};
        const id=message();check();DB.run('UPDATE messages SET content=? WHERE id=?',['Edited',id]);check();
        DB.run('DELETE FROM messages WHERE id=?',[id]);check();
        message(2,'guest','Foreign');assert.strictEqual(revision(),previous);
        DB.createConversationEvent({instanceId:1,chatId:'guest',eventId:'call1',callId:'real-call',channel:'voice',content:'Summary'});check();
        DB.run("UPDATE conversation_events SET content='New summary' WHERE eventId='call1'");check();
        Store.recordCallTranscript({businessId:1,chatId:'guest',sourceId:'call1',text:'user: hello',timestamp:'2026-10-07T00:00:00Z'});check();
        DB.run("UPDATE clients SET assigneeUserId='two' WHERE instanceId=1 AND chatId='guest'");check();
        assert.strictEqual(typeof revision(),'string');
    });
    it('returns coherent revision with client snapshot and rejects stale expected revision with no action/control mutation',async()=>{
        const a=setup(),view=Workspace.clientWorkspace(a.one,1,'guest'),control=Store.getControl(1,'guest');message();
        await provider(async()=>{throw Error('Must not send');},async()=>{
            await assert.rejects(()=>Workspace.reply(a.one,1,'guest',{text:'Old draft',idempotencyKey:'old',expectedDialogueRevision:view.dialogueRevision}),e=>e.code==='WORKSPACE_DIALOGUE_CHANGED'&&e.statusCode===409);
            assert.strictEqual(DB.get('SELECT COUNT(*) AS n FROM ava_workspace_reply_actions').n,0);
            assert.deepStrictEqual(Store.getControl(1,'guest'),control);
        });
    });
    it('rejects an incoming message during awaited preparation and releases only the undispatched slot',async()=>{
        for(const adapted of [false,true]) {
        const a=setup(),expected=Workspace.clientWorkspace(a.one,1,'guest').dialogueRevision;let sends=0;
        await provider(async(_id,_chat,_text,_channel,context)=>{await Promise.resolve();message();try{context.beforeSend();}catch(e){if(adapted)return {success:false,error:e.code,safeToRetry:true};throw e;}sends++;return {success:true};},async()=>{
            await assert.rejects(()=>Workspace.reply(a.one,1,'guest',{text:'Draft',idempotencyKey:'incoming',expectedDialogueRevision:expected}),e=>e.code==='WORKSPACE_DIALOGUE_CHANGED');
            assert.strictEqual(sends,0);assert.strictEqual(Store.getControl(1,'guest').sendInProgress,undefined);
            assert.strictEqual(DB.get('SELECT status FROM ava_workspace_reply_actions').status,'failed');
        });
        }
    });
    it('prevents two humans with different keys from dispatching together and preserves same-key ACK retry',async()=>{
        const a=setup();let enter,release,sends=0;const arrived=new Promise(r=>enter=r),hold=new Promise(r=>release=r);
        await provider(async(_id,_chat,_text,_channel,context)=>{context.beforeSend();sends++;enter();await hold;return {success:true,provider_message_id:'ack'};},async()=>{
            const body={text:'One answer',idempotencyKey:'first'},pending=Workspace.reply(a.one,1,'guest',body);
            await arrived;await assert.rejects(()=>Workspace.reply(a.owner,1,'guest',{text:'Second answer',idempotencyKey:'second'}),e=>e.code==='WORKSPACE_SEND_IN_PROGRESS');
            release();assert.strictEqual((await pending).status,'sent');assert.strictEqual((await Workspace.reply(a.one,1,'guest',body)).status,'sent');assert.strictEqual(sends,1);
        });
    });
    it('invalidates an old prepared revision even when ACK has no local saved message',async()=>{
        const a=setup(),expected=Workspace.clientWorkspace(a.owner,1,'guest').dialogueRevision;
        await provider(async(_id,_chat,_text,_channel,context)=>{context.beforeSend();return {success:true};},async()=>{
            assert.strictEqual((await Workspace.reply(a.owner,1,'guest',{text:'First',idempotencyKey:'1',expectedDialogueRevision:expected})).status,'sent');
            await assert.rejects(()=>Workspace.reply(a.owner,1,'guest',{text:'Second',idempotencyKey:'2',expectedDialogueRevision:expected}),e=>e.code==='WORKSPACE_DIALOGUE_CHANGED');
        });
    });
    it('keeps unknown fence for partial ACK and for coded exceptions after dispatch has begun',async()=>{
        for(const partial of ['partial','throw','router_error']) {
            const a=setup();await provider(async(_id,_chat,_text,_channel,context)=>{context.beforeSend();if(partial==='partial')return {success:false,status:'failed',unknown:true,safeToRetry:true};if(partial==='router_error')return {success:false,error:'WORKSPACE_UNAVAILABLE',safeToRetry:true};throw Object.assign(Error('Late failure'),{code:'WORKSPACE_UNAVAILABLE'});},async()=>{
                assert.strictEqual((await Workspace.reply(a.one,1,'guest',{text:'Maybe sent',idempotencyKey:'unknown'})).status,'unknown');
                assert.strictEqual(Store.getControl(1,'guest').sendStatus,'unknown');
                await assert.rejects(()=>Workspace.reply(a.owner,1,'guest',{text:'Again',idempotencyKey:'new'}),e=>e.code==='WORKSPACE_SEND_IN_PROGRESS');
                assert.strictEqual((await Workspace.reply(a.one,1,'guest',{text:'Maybe sent',idempotencyKey:'unknown'})).status,'unknown');
            });
        }
    });
    it('keeps feature-off legacy payload and replies usable, while presence stays unavailable',async()=>{
        const a=setup(false);assert.strictEqual(Workspace.clientWorkspace(a.one,1,'guest').dialogueRevision,undefined);
        code(()=>Collaboration.presence(a.one,1,'guest'),'WORKSPACE_FEATURE_DISABLED');
        await provider(async()=>({success:true}),async()=>assert.strictEqual((await Workspace.reply(a.one,1,'guest',{text:'Legacy',idempotencyKey:'legacy'})).status,'sent'));
    });
    it('returns and enforces dialogue revision for copilot alone with presence disabled',async()=>{
        const a=setup();require('../src/services/ava-improvements-flags.service').update(a.owner,1,{revision:0,flags:{collaboration:false,copilot:true}});
        const expected=Workspace.clientWorkspace(a.one,1,'guest').dialogueRevision;
        assert.strictEqual(typeof expected,'string');code(()=>Collaboration.presence(a.one,1,'guest'),'WORKSPACE_FEATURE_DISABLED');
        await provider(async(_id,_chat,_text,_channel,context)=>{context.beforeSend();return {success:true};},async()=>{
            const sent=await Workspace.reply(a.one,1,'guest',{text:'Copilot draft',idempotencyKey:'copilot-only',expectedDialogueRevision:expected});
            assert.strictEqual(sent.status,'sent');assert.strictEqual(typeof sent.dialogueRevision,'string');
            await assert.rejects(()=>Workspace.reply(a.one,1,'guest',{text:'Old draft',idempotencyKey:'stale-copilot',expectedDialogueRevision:expected}),e=>e.code==='WORKSPACE_DIALOGUE_CHANGED');
        });
    });
    it('reserves only one human reply across independent processes with different keys, with and without optimistic revision',async()=>{
        const fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process');
        for(const optimistic of [false,true]) {
            const a=setup(),expected=Workspace.clientWorkspace(a.owner,1,'guest').dialogueRevision;
            const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ava-human-race-')),file=path.join(dir,'fixture.db'),children=[];
            function event(child) {return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('IPC timeout')),15000);child.once('message',m=>{clearTimeout(timer);resolve(m);});child.once('error',e=>{clearTimeout(timer);reject(e);});});}
            try {
                await DB.db.backup(file);
                const ready=await Promise.all(['one','owner'].map(async actor=>{
                    const script=`const DB=require(${JSON.stringify(require.resolve('../src/services/database.service'))});
                        DB.db=new(require(${JSON.stringify(require.resolve('better-sqlite3'))}))(${JSON.stringify(file)});DB.db.pragma('busy_timeout=10000');DB.db.pragma('foreign_keys=ON');
                        const C=require(${JSON.stringify(require.resolve('../src/services/ava-collaboration.service'))});C.ensureSchema();
                        const W=require(${JSON.stringify(require.resolve('../src/services/ava-workspace.service'))});
                        const R=require(${JSON.stringify(require.resolve('../src/services/channel-router.service'))});
                        R.sendMessageDetailed=async(_id,_chat,_text,_channel,context)=>{context.beforeSend();process.send({dispatched:true});await new Promise(r=>process.once('message',r));return {success:true};};
                        process.send({ready:true});process.once('message',async()=>{let result,error;try{const r=await W.reply({userId:${JSON.stringify(actor)}},1,'guest',${JSON.stringify({text:actor+' answer',idempotencyKey:actor+'-key',...(optimistic?{expectedDialogueRevision:expected}:{})})});result=r.status;}catch(e){result=e.code;error=e.stack;}
                        process.send({result,error},()=>{DB.db.close();process.exit(0);});});`;
                    const child=spawn(process.execPath,['-e',script],{stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,AVA_IMPROVEMENTS_BUSINESSES:'1'}});children.push(child);
                    assert.ok((await event(child)).ready);return child;
                }));
                const first=ready.map(child=>event(child));for(const child of ready)child.send('go');
                const outcomes=await Promise.all(first),winner=outcomes.findIndex(r=>r.dispatched);
                assert.strictEqual(outcomes.filter(r=>r.dispatched).length,1);
                assert.ok(outcomes.some(r=>['WORKSPACE_SEND_IN_PROGRESS','WORKSPACE_DIALOGUE_CHANGED'].includes(r.result)),JSON.stringify(outcomes));
                const finished=event(ready[winner]);ready[winner].send('release');assert.strictEqual((await finished).result,'sent');
                const saved=new(require('better-sqlite3'))(file);try{assert.strictEqual(saved.prepare('SELECT COUNT(*) AS n FROM ava_workspace_reply_actions').get().n,1);assert.strictEqual(saved.prepare('SELECT status FROM ava_workspace_reply_actions').get().status,'sent');}finally{saved.close();}
            }finally{for(const child of children)if(child.exitCode===null)child.kill();fs.rmSync(dir,{recursive:true,force:true});}
        }
    });
    it('retains dialogue revision and unknown human fence after process restart',async()=>{
        const a=setup();await provider(async(_id,_chat,_text,_channel,context)=>{context.beforeSend();return {success:false,unknown:true};},async()=>{
            await Workspace.reply(a.one,1,'guest',{text:'Uncertain',idempotencyKey:'persisted'});
        });
        const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ava-collaboration-restart-')),file=path.join(dir,'fixture.db'),expected=revision();
        try {
            await DB.db.backup(file);
            const script=`const assert=require('assert'),DB=require(${JSON.stringify(require.resolve('../src/services/database.service'))});
                DB.db=new(require(${JSON.stringify(require.resolve('better-sqlite3'))}))(${JSON.stringify(file)});DB.db.pragma('foreign_keys=ON');
                const C=require(${JSON.stringify(require.resolve('../src/services/ava-collaboration.service'))});assert.strictEqual(C.dialogueRevision(1,'guest'),${JSON.stringify(expected)});
                const W=require(${JSON.stringify(require.resolve('../src/services/ava-workspace.service'))});
                assert.strictEqual(W.replyStatus({userId:'one'},1,'guest',{idempotencyKey:'persisted'}).status,'unknown');
                W.reply({userId:'owner'},1,'guest',{text:'Do not resend',idempotencyKey:'other'}).then(()=>process.exit(2),e=>{assert.strictEqual(e.code,'WORKSPACE_SEND_IN_PROGRESS');DB.db.close();});`;
            const result=spawnSync(process.execPath,['-e',script],{encoding:'utf8',timeout:15000});assert.strictEqual(result.status,0,result.stderr);
        }finally{fs.rmSync(dir,{recursive:true,force:true});}
    });
    it('enforces same-origin HTTP writes and returns finite envelopes for scope, flags and observers',async()=>{
        const a=setup();let auth=a.one;const app=express();app.use(express.json());app.use((req,_res,next)=>{req.auth=auth;next();});app.use('/api',require('../src/routes/ava-collaboration.routes'));app.use('/api',require('../src/routes/ava-workspace.routes'));
        const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
        const origin='http://127.0.0.1:'+server.address().port,old=process.env.WHATSAPP_CRM_PUBLIC_URL;process.env.WHATSAPP_CRM_PUBLIC_URL=origin;
        const request=(method='GET',body,customOrigin=origin)=>fetch(origin+'/api/businesses/1/workspace/clients/guest/presence',{method,headers:{Origin:customOrigin,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
        try {
            assert.strictEqual((await request()).status,200);assert.strictEqual((await request('POST',{sessionId:'s',typing:true})).status,200);
            assert.strictEqual((await request('POST',{sessionId:'s',typing:true},'https://foreign.example')).status,403);
            assert.strictEqual((await request('POST',{sessionId:'s',typing:true,businessId:2})).status,403);
            const expected=Workspace.clientWorkspace(a.one,1,'guest').dialogueRevision;message();
            const conflict=await fetch(origin+'/api/businesses/1/workspace/clients/guest/reply',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({text:'Keep draft',idempotencyKey:'http-conflict',expectedDialogueRevision:expected})});
            assert.strictEqual(conflict.status,409);assert.deepStrictEqual(await conflict.json(),{success:false,code:'WORKSPACE_DIALOGUE_CHANGED'});
            auth=a.observer;assert.strictEqual((await request()).status,200);assert.strictEqual((await request('POST',{sessionId:'s',typing:false})).status,403);
            process.env.AVA_IMPROVEMENTS_BUSINESSES='';const disabled=await request();assert.strictEqual(disabled.status,409);assert.deepStrictEqual(await disabled.json(),{success:false,code:'WORKSPACE_FEATURE_DISABLED'});
        }finally{await new Promise(r=>server.close(r));if(old===undefined)delete process.env.WHATSAPP_CRM_PUBLIC_URL;else process.env.WHATSAPP_CRM_PUBLIC_URL=old;}
    });
});
