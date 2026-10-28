'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Identity=require('../src/services/identity/identity-store');
const Sales=require('../src/services/sales-workspace.service');
const routes=require('../src/routes/sales-workspace.routes');
const express=require('express');
function setup() {
    createTestDB();Identity.ensureSchema();DB.createSalesWorkspaceTables();
    DB.run("INSERT INTO instances(id,name) VALUES(1,'One'),(2,'Two')");
    for(const [id,role,business] of [['owner','hotel_owner',1],['lead','sales_lead',1],['one','manager',1],['two','manager',1],['read','observer',1],['other','manager',2]]) {
        DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)',[id,id+'@example.test','Same display name']);
        DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)',[id,business,role]);
    }
    DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES(1,'guest','Guest'),(1,'second','Second'),(2,'guest','Foreign')");
    return Object.fromEntries(['owner','lead','one','two','read','other'].map(id=>[id,Identity.actor(id)]));
}
function expectCode(fn,code) {assert.throws(fn,e=>e.code===code);}
function task(assigneeUserId=null,extra={}) {return DB.createManagerTask({instanceId:1,chatId:'guest',summary:'Call guest',assigneeUserId,...extra});}
async function http(auth,fn) {
    const app=express();app.use(express.json());app.use((req,_res,next)=> {req.auth=auth;next();});app.use('/api',routes);
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const origin='http://127.0.0.1:'+server.address().port,previous=process.env.WHATSAPP_CRM_PUBLIC_URL;process.env.WHATSAPP_CRM_PUBLIC_URL=origin;
    const request=async(method,path,body,headers={})=>fetch(origin+'/api/businesses/1/sales-workspace'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    try {await fn(request,origin);} finally {await new Promise(r=>server.close(r));if(previous===undefined) delete process.env.WHATSAPP_CRM_PUBLIC_URL;else process.env.WHATSAPP_CRM_PUBLIC_URL=previous;}
}
describe('Durable sales workspace exact identity and role isolation',()=> {
    it('renames a canonical customer over HTTP and preserves the name on provider reimport',async()=> {
        const a=setup();require('../src/services/client-identity.service').attach(1,'guest',{kind:'telegram',value:'900000001'});
        Sales.assignClient(a.owner,1,'guest',{assigneeUserId:'one'});
        await http(a.one,async request=>{
            const result=await request('PUT','/clients/tg_900000001/name',{name:'  Анна, доставка в пятницу  ',previousName:'Guest'});
            assert.equal(result.status,200);assert.equal((await result.json()).client.chatId,'guest');
            assert.equal((await request('PUT','/clients/guest/name',{name:'Outdated edit',previousName:'Guest'})).status,409);
            assert.equal((await request('PUT','/clients/guest/name',{name:'Denied',previousName:'Анна, доставка в пятницу'},{Origin:'https://foreign.test'})).status,403);
        });
        const client=await DB.getOrCreateClient(1,'tg_900000001','Telegram profile');
        assert.equal(client.senderName,'Анна, доставка в пятницу');assert.equal(client.senderNameManual,1);
        assert.equal(DB.updateClientNameFromSource(1,'guest','Remote CRM name').changes,0);
        assert.equal((await DB.getClient(1,'guest')).senderName,client.senderName);
        assert.equal((await DB.getClient(2,'guest')).senderName,'Foreign');
        Sales.renameClient(a.owner,1,'guest',{name:'Анна',previousName:client.senderName});
        assert.equal((await DB.getClient(1,'guest')).senderName,'Анна');
        assert.equal(DB.updateClientNameFromSource(1,'second','Imported name').changes,1);
    });
    it('enforces name edit permissions, tenant boundaries and input validation at the endpoint',async()=> {
        const a=setup();Sales.assignClient(a.owner,1,'guest',{assigneeUserId:'one'});
        for(const id of ['owner','lead','one','two','read','other'])await http(a[id],async request=>{
            const r=await request('PUT','/clients/guest/name',{name:'Guest',previousName:'Guest'});
            assert.equal(r.status,['owner','lead','one'].includes(id)?200:403,id);
        });
        for(const name of ['', '   ', 'a'.repeat(181), 'Line\nTwo', 'Hidden\u202Ename', 123])
            expectCode(()=>Sales.renameClient(a.owner,1,'guest',{name,previousName:'Guest'}),'SALES_CLIENT_NAME_INVALID');
        expectCode(()=>Sales.renameClient(a.owner,1,'guest',{name:'Valid',previousName:'Guest',instanceId:2}),'SALES_INPUT_INVALID');
        expectCode(()=>Sales.renameClient(a.one,1,'second',{name:'Valid',previousName:'Second'}),'SALES_CLIENT_CLAIM_REQUIRED');
        expectCode(()=>Sales.renameClient(a.owner,1,'missing',{name:'Valid',previousName:'Guest'}),'SALES_CLIENT_NOT_FOUND');
    });
    it('serves real HTTP for every role with live permissions and exact business scope',async()=> {
        const a=setup();task('one');
        assert.strictEqual(Sales.workspace(a.owner,1,{view:'team'}).tasks.length,1);
        assert.strictEqual(Sales.workspace(a.lead,1,{view:'team'}).members.length,5);
        for(const actor of [a.one,a.read]) {Sales.workspace(actor,1,{view:'mine'});Sales.workspace(actor,1,{view:'queue'});expectCode(()=>Sales.workspace(actor,1,{view:'team'}),'SALES_TEAM_VIEW_DENIED');}
        expectCode(()=>Sales.createTask(a.other,1,{chatId:'guest',summary:'Denied'}),'BUSINESS_ACCESS_DENIED');
        expectCode(()=>Sales.workspace(a.one,2),'BUSINESS_ACCESS_DENIED');
        for(const id of ['owner','lead','one','read']) await http(a[id],async request=> {
            assert.strictEqual((await request('GET','?view=mine')).status,200);
            assert.strictEqual((await request('GET','?view=team')).status,['owner','lead'].includes(id)?200:403);
            assert.strictEqual((await request('POST','/tasks',{chatId:'guest',summary:'HTTP task'})).status,id==='read'?403:201);
        });
    });
    it('enforces the complete direct HTTP mutation role matrix for owner/lead/manager/observer',async()=> {
        for(const id of ['owner','lead','one','read']) {
            const a=setup(),own=task(id==='read'?'one':id),unassigned=task(),foreign=task('two');
            await http(a[id],async request=> {
                const manager=id==='one',observer=id==='read';
                const checks=[
                    ['PATCH','/tasks/'+own.taskId,{status:'in_progress'},observer?403:200],
                    ['PATCH','/tasks/'+foreign.taskId,{status:'done'},observer||manager?403:200],
                    ['POST','/tasks/'+unassigned.taskId+'/claim',{},observer?403:200],
                    ['PUT','/clients/guest/assignee',{assigneeUserId:id},observer?403:200],
                    ['PUT','/clients/second/assignee',{assigneeUserId:'two'},observer||manager?403:200],
                    ['POST','/tasks',{chatId:'guest',summary:'Task for teammate',assigneeUserId:'two'},observer||manager?403:201],
                ];
                for(const [method,path,body,status] of checks) {
                    const response=await request(method,path,body);assert.strictEqual(response.status,status,`${id} ${method} ${path} ${JSON.stringify(await response.json())}`);
                }
            });
        }
    });
    it('never treats display names, wrong-business, disabled or observer users as assignees',()=> {
        const a=setup(),old=task(null,{assignee:'Same display name'});
        assert.strictEqual(Sales.workspace(a.one,1,{view:'mine'}).tasks.length,0);
        assert.strictEqual(Sales.workspace(a.one,1,{view:'queue'}).tasks.length,1);
        for(const invalid of ['Same display name','other','read','missing']) expectCode(()=>Sales.updateTask(a.owner,1,old.taskId,{assigneeUserId:invalid}),'SALES_ASSIGNEE_INVALID');
        DB.run('UPDATE ava_users SET enabled=0 WHERE id=?',['two']);
        expectCode(()=>Sales.updateTask(a.lead,1,old.taskId,{assigneeUserId:'two'}),'SALES_ASSIGNEE_INVALID');
        Sales.updateTask(a.lead,1,old.taskId,{assigneeUserId:'one'});
        assert.strictEqual(Sales.workspace(a.one,1).tasks[0].assigneeUserId,'one');
        expectCode(()=>Sales.authorizeClientMutation(a.one,1,'guest'),'SALES_CLIENT_CLAIM_REQUIRED');
        Sales.assignClient(a.lead,1,'guest',{assigneeUserId:'one'});
        assert.strictEqual(Sales.authorizeClientMutation(a.one,1,'guest',{capability:'messages.send'}).row.assigneeUserId,'one');
        expectCode(()=>Sales.authorizeClientMutation(a.other,1,'guest'),'BUSINESS_ACCESS_DENIED');
        expectCode(()=>Sales.authorizeClientMutation(a.read,1,'guest',{capability:'ai.use'}),'CAPABILITY_DENIED');
        const secondManager={userId:'two'};DB.run("UPDATE ava_users SET enabled=1 WHERE id='two'");
        expectCode(()=>Sales.authorizeClientMutation(secondManager,1,'guest'),'SALES_CLIENT_SCOPE_DENIED');
        Sales.authorizeClientMutation(a.owner,1,'guest');Sales.authorizeClientMutation(a.lead,1,'guest',{capability:'messages.send'});
    });
    it('guards canonical alias mutations and requires explicit queue claim while keeping business reads',()=> {
        const a=setup();require('../src/services/client-identity.service').attach(1,'guest',{kind:'telegram',value:'900000001'});
        assert.strictEqual(Sales.workspace(a.two,1,{view:'queue'}).clients.length,2);
        expectCode(()=>Sales.authorizeClientMutation(a.one,1,'tg_900000001'),'SALES_CLIENT_CLAIM_REQUIRED');
        Sales.assignClient(a.one,1,'tg_900000001',{assigneeUserId:'one'});
        assert.strictEqual(Sales.authorizeClientMutation(a.one,1,'tg_900000001',{capability:'messages.send'}).row.chatId,'guest');
        expectCode(()=>Sales.authorizeClientMutation(a.two,1,'tg_900000001'),'SALES_CLIENT_SCOPE_DENIED');
        expectCode(()=>Sales.authorizeClientMutation(a.other,1,'tg_900000001'),'BUSINESS_ACCESS_DENIED');
        Sales.authorizeClientMutation(a.lead,1,'tg_900000001',{capability:'ai.use'});
        Sales.assignClient(a.owner,1,'guest',{assigneeUserId:null});
        expectCode(()=>Sales.authorizeClientMutation(a.one,1,'tg_900000001'),'SALES_CLIENT_CLAIM_REQUIRED');
        Sales.assignClient(a.one,1,'guest',{assigneeUserId:'one'});
        DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId='one' AND businessId=1");
        expectCode(()=>Sales.authorizeClientMutation(a.one,1,'tg_900000001',{capability:'messages.send'}),'CAPABILITY_DENIED');
    });
    it('persists manual task edits, exact owner scope and explicit UTC instants',()=> {
        const a=setup(),result=Sales.createTask(a.one,1,{chatId:'guest',summary:'Manual task',priority:'urgent',dueAt:'2026-10-02T18:30:00+03:00'});
        const row=DB.getManagerTask(1,result.task.taskId);
        assert.strictEqual(row.assigneeUserId,'one');assert.strictEqual(row.createdByUserId,'one');assert.strictEqual(row.dueAt,'2026-10-02T15:30:00.000Z');
        expectCode(()=>Sales.updateTask(a.two,1,row.taskId,{status:'done'}),'SALES_TASK_SCOPE_DENIED');
        Sales.updateTask(a.one,1,row.taskId,{summary:'Edited',dueAt:null,status:'done'});
        assert.strictEqual(DB.getManagerTask(1,row.taskId).summary,'Edited');assert.strictEqual(DB.getManagerTask(1,row.taskId).dueAt,null);
        assert.strictEqual(Sales.workspace(a.one,1).tasks.length,0);
        Sales.updateTask(a.one,1,row.taskId,{status:'new'});assert.strictEqual(Sales.workspace(a.one,1).tasks.length,1);
        for(const date of ['2026-10-02','2026-10-02T18:30:00','2026-02-30T18:30:00Z','2026-10-02T25:30:00Z']) expectCode(()=>Sales.updateTask(a.one,1,row.taskId,{dueAt:date}),'SALES_INPUT_INVALID');
        Sales.assignClient(a.lead,1,'guest',{assigneeUserId:'two'});
        expectCode(()=>Sales.createTask(a.one,1,{chatId:'guest',summary:'Wrong client'}),'SALES_CLIENT_SCOPE_DENIED');
    });
    it('counts records beyond legacy 200 limits before stable pagination and workload',()=> {
        const a=setup();for(let n=0;n<245;n++) task(n%2===0?'one':null,{taskId:'bulk_'+String(n).padStart(4,'0'),dueAt:n%3===0?'2000-01-01T00:00:00.000Z':null});
        task('one',{status:'done'});
        for(let n=0;n<5;n++) DB.createFollowupDraft({instanceId:1,chatId:'guest',text:'Draft '+n,status:n===4?'sent':'draft'});
        const view=Sales.workspace(a.lead,1,{view:'team',page:2,pageSize:100});
        assert.strictEqual(view.summary.openTasks,245);assert.strictEqual(view.pagination.totalTasks,245);assert.strictEqual(view.tasks.length,100);
        assert.strictEqual(view.summary.overdueTasks,82);assert.strictEqual(view.summary.pendingFollowups,4);
        assert.strictEqual(view.members.find(m=>m.userId==='one').openTasks,123);assert.strictEqual(view.summary.unassignedClients,2);
        const all=Sales.workspace(a.lead,1,{view:'team',page:1,pageSize:100}).tasks;
        assert.strictEqual(new Set([...all,...view.tasks].map(t=>t.taskId)).size,200);
        for(const query of [{page:0},{page:'1x'},{pageSize:101},{view:'invented'}]) expectCode(()=>Sales.workspace(a.one,1,query),'SALES_INPUT_INVALID');
    });
    it('claims atomically with one winner and idempotent repeat, leaders redistribute',async()=> {
        const a=setup(),row=task();
        await http(a.one,async request=> {
            assert.strictEqual((await request('POST','/tasks/'+row.taskId+'/claim',{})).status,200);
            const repeat=await request('POST','/tasks/'+row.taskId+'/claim',{});assert.strictEqual((await repeat.json()).idempotent,true);
        });
        expectCode(()=>Sales.claimTask(a.two,1,row.taskId),'SALES_TASK_ASSIGNED');
        assert.strictEqual(Sales.assignClient(a.one,1,'guest',{assigneeUserId:'one'}).idempotent,false);
        assert.strictEqual(Sales.assignClient(a.one,1,'guest',{assigneeUserId:'one'}).idempotent,true);
        expectCode(()=>Sales.assignClient(a.two,1,'guest',{assigneeUserId:'two'}),'SALES_CLIENT_ASSIGNED');
        expectCode(()=>Sales.assignClient(a.one,1,'guest',{assigneeUserId:null}),'CAPABILITY_DENIED');
        Sales.assignClient(a.lead,1,'guest',{assigneeUserId:'two'});assert.strictEqual(Sales.workspace(a.two,1).clients[0].chatId,'guest');
        Sales.updateTask(a.lead,1,row.taskId,{status:'done'});expectCode(()=>Sales.claimTask(a.lead,1,row.taskId),'SALES_TASK_CLOSED');
    });
    it('lets only one of two independent processes claim the same task/client concurrently',async()=> {
        const a=setup(),row=task();
        const fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process');
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ava-sales-race-')),file=path.join(dir,'fixture.db');
        await DB.db.backup(file);
        const serviceFile=require.resolve('../src/services/sales-workspace.service'),dbFile=require.resolve('../src/services/database.service');
        const sqliteFile=require.resolve('better-sqlite3');
        const children=[];
        try {
            const ready=await Promise.all(['one','two'].map(userId=>new Promise((resolve,reject)=> {
                const script=`const DB=require(${JSON.stringify(dbFile)});DB.db=new (require(${JSON.stringify(sqliteFile)}))(${JSON.stringify(file)});DB.db.pragma('busy_timeout=10000');DB.db.pragma('foreign_keys=ON');const Sales=require(${JSON.stringify(serviceFile)});process.send({ready:true});process.on('message',()=>{let task,client;try{task=Sales.claimTask({userId:${JSON.stringify(userId)}},1,${JSON.stringify(row.taskId)}).success;}catch(e){task=e.code;}try{client=Sales.assignClient({userId:${JSON.stringify(userId)}},1,'guest',{assigneeUserId:${JSON.stringify(userId)}}).success;}catch(e){client=e.code;}DB.db.close();process.send({task,client},()=>process.exit(0));});`;
                const child=spawn(process.execPath,['-e',script],{stdio:['ignore','ignore','pipe','ipc']});children.push(child);
                child.once('error',reject);child.once('message',message=>message.ready?resolve(child):reject(Error('not ready')));
            })));
            const results=await Promise.all(ready.map(child=>new Promise((resolve,reject)=> {
                const timer=setTimeout(()=> {child.kill();reject(Error('claim timeout'));},15000);
                child.once('message',message=> {clearTimeout(timer);resolve(message);});child.send('go');
            })));
            assert.deepStrictEqual(results.map(r=>r.task).sort(),[true,'SALES_TASK_ASSIGNED'].sort());
            assert.deepStrictEqual(results.map(r=>r.client).sort(),[true,'SALES_CLIENT_ASSIGNED'].sort());
            const reopened=new (require('better-sqlite3'))(file);
            assert.ok(['one','two'].includes(reopened.prepare('SELECT assigneeUserId FROM manager_tasks WHERE taskId=?').get(row.taskId).assigneeUserId));
            assert.strictEqual(reopened.pragma('integrity_check',{simple:true}),'ok');reopened.close();
        } finally {for(const child of children) if(child.exitCode===null) child.kill();fs.rmSync(dir,{recursive:true,force:true});}
    });
    it('reads a newly created manual task after a separate-process restart',async()=> {
        const a=setup(),created=Sales.createTask(a.lead,1,{chatId:'second',summary:'Persistent manual',assigneeUserId:'two',dueAt:'2026-10-03T09:00:00Z'});
        const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ava-sales-restart-')),file=path.join(dir,'fixture.db');
        try {
            await DB.db.backup(file);
            const script=`const DB=require(${JSON.stringify(require.resolve('../src/services/database.service'))});DB.db=new(require(${JSON.stringify(require.resolve('better-sqlite3'))}))(${JSON.stringify(file)});const Sales=require(${JSON.stringify(require.resolve('../src/services/sales-workspace.service'))});const view=Sales.workspace({userId:'two'},1);const row=view.tasks.find(t=>t.taskId===${JSON.stringify(created.task.taskId)});if(!row||row.summary!=='Persistent manual'||row.assigneeUserId!=='two'||row.dueAt!=='2026-10-03T09:00:00.000Z')process.exit(2);DB.db.close();`;
            const result=spawnSync(process.execPath,['-e',script],{encoding:'utf8',timeout:15000});assert.strictEqual(result.status,0,result.stderr);
        }finally {fs.rmSync(dir,{recursive:true,force:true});}
    });
    it('guards pending/unknown sends on assignment and never fabricates delivery by completing a task',()=> {
        const a=setup(),row=task('one'),draft=DB.createFollowupDraft({instanceId:1,chatId:'guest',managerTaskId:row.taskId,text:'Message',metadata:{delivery_status:'pending'}});
        DB.run('UPDATE clients SET assigneeUserId=? WHERE instanceId=1 AND chatId=?',['one','guest']);
        for(const state of ['pending','sending','unknown','unknown_pending','unknown-pending']) {
            DB.updateFollowupDraft(1,draft.draftId,{metadata:{delivery_status:state}});
            expectCode(()=>Sales.updateTask(a.lead,1,row.taskId,{assigneeUserId:'two'}),'SALES_DELIVERY_PENDING');
            expectCode(()=>Sales.assignClient(a.lead,1,'guest',{assigneeUserId:'two'}),'SALES_DELIVERY_PENDING');
        }
        Sales.updateTask(a.one,1,row.taskId,{status:'done'});
        const unchanged=DB.getFollowupDraft(1,draft.draftId);assert.strictEqual(unchanged.status,'draft');assert.strictEqual(unchanged.sentAt,null);assert.strictEqual(JSON.parse(unchanged.metadataJson).delivery_status,'unknown-pending');
    });
    it('blocks client reassignment for task-only drafts and unresolved provider status evidence',()=> {
        const a=setup(),row=task('one'),draft=DB.createFollowupDraft({instanceId:1,managerTaskId:row.taskId,text:'Provider unresolved',metadata:{provider_status:'unknown'}});
        expectCode(()=>Sales.assignClient(a.lead,1,'guest',{assigneeUserId:'two'}),'SALES_DELIVERY_PENDING');
        expectCode(()=>Sales.updateTask(a.lead,1,row.taskId,{assigneeUserId:'two'}),'SALES_DELIVERY_PENDING');
        for(const metadata of ['{broken','[]','null','false','123','']) {
            DB.run('UPDATE followup_drafts SET metadataJson=? WHERE draftId=?',[metadata,draft.draftId]);
            expectCode(()=>Sales.assignClient(a.lead,1,'guest',{assigneeUserId:'two'}),'SALES_DELIVERY_PENDING');
        }
    });
    it('cleans inside membership transaction with rollback, pending reconciliation and other-business preservation',()=> {
        const a=setup(),row=task('one'),draft=DB.createFollowupDraft({instanceId:1,chatId:'guest',managerTaskId:row.taskId,text:'Message',metadata:{delivery_status:'pending',provider_message_id:'fixture-ack'}});
        DB.run('UPDATE clients SET assigneeUserId=? WHERE instanceId=1 AND chatId=?',['one','guest']);
        DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('one',2,'manager')");
        const other=DB.createManagerTask({instanceId:2,chatId:'guest',summary:'Other',assigneeUserId:'one'});
        expectCode(()=>Sales.cleanupMemberAssignments(1,'one'),'SALES_CLEANUP_TRANSACTION_REQUIRED');
        assert.throws(()=>DB.db.transaction(()=> {Sales.cleanupMemberAssignments(1,'one',{reason:'removed'});throw Error('rollback');}).immediate());
        assert.strictEqual(DB.getManagerTask(1,row.taskId).assigneeUserId,'one');
        DB.db.transaction(()=> {assert.deepStrictEqual(Sales.cleanupMemberAssignments(1,'one',{reason:'removed'}),{clients:1,tasks:1,reconciliation:1});DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE businessId=1 AND userId='one'");}).immediate();
        assert.strictEqual(DB.getManagerTask(1,row.taskId).assigneeUserId,null);assert.strictEqual(DB.getManagerTask(2,other.taskId).assigneeUserId,'one');
        const metadata=JSON.parse(DB.getFollowupDraft(1,draft.draftId).metadataJson);assert.strictEqual(metadata.delivery_status,'pending');assert.strictEqual(metadata.provider_message_id,'fixture-ack');assert.strictEqual(metadata.assignment_reconciliation_required,true);
        expectCode(()=>Sales.workspace(a.one,1),'BUSINESS_ACCESS_DENIED');expectCode(()=>Sales.claimTask(a.two,1,row.taskId),'SALES_DELIVERY_PENDING');
        DB.updateFollowupDraft(1,draft.draftId,{metadata:{delivery_status:'failed'}});Sales.claimTask(a.two,1,row.taskId);
        assert.strictEqual(JSON.parse(DB.getFollowupDraft(1,draft.draftId).metadataJson).assignment_reconciliation_required,undefined);
    });
    it('denies stale demoted/revoked HTTP actors, cross-origin and absent capability API',async()=> {
        const a=setup(),row=task('one');
        await http(a.one,async request=> {
            assert.strictEqual((await request('POST','/tasks/'+row.taskId+'/claim',{}, {Origin:'https://foreign.example.test'})).status,403);
            assert.strictEqual((await request('POST','/tasks',{chatId:'guest',summary:'No origin'}, {Origin:''})).status,403);
            assert.strictEqual((await request('POST','/tasks',{chatId:'guest',summary:'Cross',businessId:2})).status,403);
            DB.run("UPDATE ava_business_memberships SET role='observer' WHERE businessId=1 AND userId='one'");
            assert.strictEqual((await request('PATCH','/tasks/'+row.taskId,{status:'done'})).status,403);
            assert.strictEqual((await request('GET','?view=mine')).status,200);
            DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE businessId=1 AND userId='one'");
            assert.strictEqual((await request('GET','?view=mine')).status,403);
            const capability=Identity.authorizeCapability;Identity.authorizeCapability=undefined;
            try {const response=await request('GET','?view=mine');assert.strictEqual(response.status,503);assert.strictEqual((await response.json()).code,'SALES_WORKSPACE_UNAVAILABLE');}finally {Identity.authorizeCapability=capability;}
            DB.run("UPDATE ava_business_memberships SET enabled=1 WHERE businessId=1 AND userId='one'");
            DB.db.exec('DROP TABLE followup_drafts');
            const unavailable=await request('GET','?view=queue');assert.strictEqual(unavailable.status,503);
            const unavailableBody=await unavailable.json();assert.strictEqual(unavailableBody.code,'SALES_WORKSPACE_UNAVAILABLE');assert.strictEqual(unavailableBody.summary,undefined);
        });
    });
});
