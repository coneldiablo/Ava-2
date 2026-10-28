'use strict';
const crypto=require('crypto');
const DB=require('./database.service');
const Sales=require('./sales-workspace.service');
const SalesStore=require('./sales-workspace.store');
const Store=require('./ava-workspace.store');
const CustomerContext=require('./customer-context.service');
const Wait=require('./customer-wait.service');
const Collaboration=require('./ava-collaboration.service');
const ImprovementFlags=require('./ava-improvements-flags.service');
function fail(code,statusCode=400){throw Object.assign(new Error(code),{code,statusCode});}
function authorize(auth,businessId,capability='sales.read'){const actor=Sales.authorize(auth,businessId,capability);Store.ensureSchema();return actor;}
function keys(body,allowed){if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))fail('WORKSPACE_INPUT_INVALID');}
function text(value,max=800){if(typeof value!=='string'||!value.trim()||value.length>max)fail('WORKSPACE_INPUT_INVALID');return value.trim();}
function integer(value,fallback,max=100){if(value===undefined)return fallback;if(!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>max)fail('WORKSPACE_INPUT_INVALID');return Number(value);}
function time(value){if(!value)return null;const date=new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(value)?value:String(value).replace(' ','T')+'Z');return Number.isFinite(date.getTime())?date.toISOString():null;}
function parse(value,fallback={}){try{return JSON.parse(value||'{}');}catch(_){return fallback;}}
function readClient(auth,businessId,chatId){const actor=authorize(auth,businessId);DB.db.transaction(()=>require('./client-identity.service').canonical(actor.businessId,chatId)).immediate();const client=DB.db.transaction(()=>Store.scope(actor.businessId,chatId)).immediate();return {actor,client};}
function mutation(auth,businessId,chatId,capability='sales.write'){
    const actor=authorize(auth,businessId,capability);
    // Commit lazy identity schema before a denied mutation can roll it back;
    // IMMEDIATE also avoids concurrent read-to-write migration upgrades.
    DB.db.transaction(()=>require('./client-identity.service').canonical(actor.businessId,chatId)).immediate();
    return DB.db.transaction(()=>Sales.authorizeClientMutation(auth,businessId,chatId,{capability})).immediate();
}
function workspace(auth,businessId,query={}) {
    const actor=authorize(auth,businessId),view=query.view||(actor.role==='observer'?'overview':['hotel_owner','sales_lead'].includes(actor.role)?'team':'mine');
    if(!['mine','queue','team','overview'].includes(view)||query.query!==undefined&&(typeof query.query!=='string'||query.query.length>200))fail('WORKSPACE_INPUT_INVALID');
    if(query.channel!==undefined&&!['whatsapp','telegram','email','vk','max','instagram','avito'].includes(query.channel))fail('WORKSPACE_INPUT_INVALID');
    if(view==='team'&&!['hotel_owner','sales_lead'].includes(actor.role))fail('SALES_TEAM_VIEW_DENIED',403);
    const page=integer(query.page,1,100000),pageSize=integer(query.pageSize,30),now=Date.now();
    const settings=Store.businessSettings(actor.businessId),sla={responseDeadlineMinutes:settings.responseDeadlineMinutes||30,timezone:Store.timezone(actor.businessId),workHours:settings.workHours||{start:'00:00',end:'00:00'},workDays:settings.workDays||[1,2,3,4,5,6,7]};
    const unanswered=new Map(Wait.unanswered(actor.businessId).map(m=>[m.chatId,m]));
    const clientRows=SalesStore.clients(actor.businessId,view,actor.userId),taskRows=SalesStore.tasks(actor.businessId);
    const channelChats=query.channel?new Set(DB.all(`SELECT chatId FROM messages WHERE instanceId=? AND channel=?
        UNION SELECT chatId FROM clients WHERE instanceId=? AND preferredChannel=?`,
        [actor.businessId,query.channel,actor.businessId,query.channel]).map(r=>r.chatId)):null;
    const promiseRows=DB.all("SELECT * FROM ava_client_promises WHERE businessId=? AND status='open'",[actor.businessId]);
    const controlRows=new Map(DB.all('SELECT * FROM ava_conversation_control WHERE businessId=?',[actor.businessId]).map(r=>[r.chatId,r]));
    const snoozes=new Set(DB.all('SELECT chatId FROM ava_workspace_snoozes WHERE businessId=? AND userId=? AND julianday(until)>julianday(?)',[actor.businessId,actor.userId,new Date(now).toISOString()]).map(r=>r.chatId));
    const dealRows=DB.all("SELECT * FROM customer_deals WHERE instanceId=? AND stage NOT IN ('won','lost')",[actor.businessId]);
    const byChat=rows=>{const map=new Map();for(const row of rows){const chat=row.chatId||row.clientChatId;if(!map.has(chat))map.set(chat,[]);map.get(chat).push(row);}return map;};
    const tasks=byChat(taskRows),promises=byChat(promiseRows),deals=byChat(dealRows);
    const rows=[];
    for(const client of clientRows){
        if(channelChats&&!channelChats.has(client.chatId))continue;
        if(snoozes.has(client.chatId))continue;
        if(query.query&&!`${client.senderName} ${client.chatId} ${client.lastMessage||''}`.toLocaleLowerCase().includes(query.query.toLocaleLowerCase()))continue;
        const reasons=[],control=controlRows.get(client.chatId),ownTasks=tasks.get(client.chatId)||[],ownPromises=promises.get(client.chatId)||[];
        const add=(code,label,sourceId,dueAt)=>reasons.push({code,label,sourceId,...(dueAt?{dueAt}: {})});
        if(control?.mode==='human')add('needs_human',control.reason||'Требуется менеджер',client.chatId);
        const inbound=unanswered.get(client.chatId);if(inbound&&Wait.state(inbound,now,sla).overdue)add('response_overdue',`Нет ответа более ${sla.responseDeadlineMinutes} рабочих минут`,String(inbound.id));
        if(control?.activeSendStatus==='unknown')add('send_unknown','Результат отправки не подтверждён',control.activeSendId);
        for(const promise of ownPromises)if(promise.dueAt&&Date.parse(promise.dueAt)<now)add('promise_overdue',promise.summary,promise.id,promise.dueAt);
        for(const task of ownTasks)if(time(task.dueAt)&&Date.parse(time(task.dueAt))<now)add('task_overdue',task.summary,task.taskId,time(task.dueAt));
        if(!client.effectiveAssigneeUserId)add('unassigned','Нет ответственного',client.chatId);
        for(const deal of deals.get(client.chatId)||[])if(!deal.nextAction||now-Date.parse(time(deal.updatedAt))>7*86400000)add('stalled_deal',deal.nextAction?'Давно нет продвижения':'Не назначен следующий шаг',deal.id);
        if(!reasons.length&&ownTasks.length)add('task',ownTasks[0].summary,ownTasks[0].taskId,time(ownTasks[0].dueAt));
        if(!reasons.length&&ownPromises.length)add('promise',ownPromises[0].summary,ownPromises[0].id,ownPromises[0].dueAt);
        const rank=reasons.some(r=>r.code==='needs_human'||r.code==='send_unknown')?0:reasons.some(r=>r.code.endsWith('_overdue'))?1:!client.effectiveAssigneeUserId?2:reasons.some(r=>r.code==='stalled_deal')?3:4;
        rows.push({chatId:client.chatId,name:client.senderName,assigneeUserId:client.effectiveAssigneeUserId,assigneeName:client.assigneeName||null,status:client.leadStatus,controlMode:control?.mode||'ai',reasons,nextAction:reasons[0]?.label||'Открыть диалог',lastContactAt:time(client.lastMessageTime),rank});
    }
    rows.sort((a,b)=>a.rank-b.rank||String(a.lastContactAt||'').localeCompare(String(b.lastContactAt||''))||a.chatId.localeCompare(b.chatId));
    return {success:true,businessId:actor.businessId,view,currentUserId:actor.userId,capabilities:actor.capabilities,sla,
        summary:{needsHuman:rows.filter(r=>r.controlMode==='human').length,overdue:rows.filter(r=>r.reasons.some(x=>x.code.endsWith('_overdue'))).length,unassigned:rows.filter(r=>!r.assigneeUserId).length,aiActive:rows.filter(r=>r.controlMode==='ai').length},
        items:rows.slice((page-1)*pageSize,page*pageSize).map(({rank,...row})=>row),pagination:{page,pageSize,total:rows.length}};
}
function clientWorkspace(auth,businessId,chatId,query={}) {
    const actor=authorize(auth,businessId);
    const flags=ImprovementFlags.snapshot(actor.businessId).flags,enabled=flags.collaboration||flags.copilot;
    if(!enabled)return clientWorkspaceSnapshot(auth,businessId,chatId,false,query);
    Collaboration.ensureSchema();
    return DB.db.transaction(()=>clientWorkspaceSnapshot(auth,businessId,chatId,true,query)).immediate();
}
function clientWorkspaceSnapshot(auth,businessId,chatId,dialogueEnabled,query) {
    const {actor,client}=readClient(auth,businessId,chatId),id=actor.businessId,canonical=client.chatId;
    const context=CustomerContext.snapshot(id,canonical,query),history=CustomerContext.messages(id,canonical,query);
    const tasks=DB.all('SELECT * FROM manager_tasks WHERE instanceId=? AND chatId=? ORDER BY createdAt DESC,taskId LIMIT 100',[id,canonical]).map(Sales.taskView);
    const deals=DB.all('SELECT * FROM customer_deals WHERE instanceId=? AND clientChatId=? ORDER BY updatedAt DESC,id LIMIT 50',[id,canonical]).map(d=>({...d,amount:d.amountMinor/100}));
    const phone=DB.get("SELECT value FROM client_aliases WHERE instanceId=? AND chatId=? AND kind='phone' ORDER BY value LIMIT 1",[id,canonical])?.value||DB.get("SELECT normalizedPhone FROM customer_identity_links WHERE instanceId=? AND chatId=? AND normalizedPhone IS NOT NULL ORDER BY createdAt DESC LIMIT 1",[id,canonical])?.normalizedPhone||null;
    const promises=Store.promises(id,canonical);
    return {success:true,businessId:id,currentUserId:actor.userId,capabilities:actor.capabilities,timezone:Store.timezone(id),channelAccess:require('./avito.service').chatAccess(id,canonical),client:{chatId:canonical,name:client.senderName,status:client.leadStatus,phone,assigneeUserId:Store.activeAssignee(id,client.assigneeUserId)},control:Store.getControl(id,canonical),...(dialogueEnabled?{dialogueRevision:Collaboration.dialogueRevision(id,canonical)}:{}),...history,calls:context.calls,callPagination:context.callPagination,tasks,deals,promises,memory:context.memory,
        callBrief:{...context.callBrief,promises:promises.filter(p=>p.status==='open'),nextAction:deals.find(d=>d.nextAction)?.nextAction||context.callBrief.nextAction}};
}
function control(auth,businessId,chatId,body) {keys(body,['mode','revision','reason']);const {actor,row}=mutation(auth,businessId,chatId);return {success:true,businessId:actor.businessId,control:Store.setControl({businessId:actor.businessId,chatId:row.chatId,...body,actorUserId:actor.userId})};}
function listPromises(auth,businessId,query={}){const actor=authorize(auth,businessId);return {success:true,businessId:actor.businessId,promises:Store.promises(actor.businessId,query.chatId||null,query.status||null)};}
function createPromise(auth,businessId,body){keys(body,['chatId','summary','dueAt','sourceType','sourceId']);if(body.sourceType!==undefined&&body.sourceType!=='manual')fail('WORKSPACE_SOURCE_INVALID');const {actor,row}=mutation(auth,businessId,body.chatId);if(body.sourceId!=null&&!DB.get('SELECT id FROM messages WHERE instanceId=? AND chatId=? AND CAST(id AS TEXT)=?',[actor.businessId,row.chatId,String(body.sourceId)])&&!DB.get('SELECT eventId FROM conversation_events WHERE instanceId=? AND chatId=? AND eventId=?',[actor.businessId,row.chatId,String(body.sourceId)]))fail('WORKSPACE_SOURCE_INVALID');return {success:true,businessId:actor.businessId,promise:Store.createPromise({businessId:actor.businessId,chatId:row.chatId,summary:text(body.summary),dueAt:body.dueAt==null?null:Store.dateInstant(body.dueAt),duePrecision:body.dueAt?'instant':null,sourceType:'manual',sourceId:body.sourceId||null,assigneeUserId:row.assigneeUserId})};}
function updatePromise(auth,businessId,promiseId,body){keys(body,['status','revision']);if(!['done','cancelled'].includes(body.status)||!Number.isSafeInteger(body.revision)||body.revision<1)fail('WORKSPACE_INPUT_INVALID');const actor=authorize(auth,businessId,'sales.write');const promise=DB.get('SELECT * FROM ava_client_promises WHERE businessId=? AND id=?',[actor.businessId,promiseId]);if(!promise)fail('WORKSPACE_PROMISE_NOT_FOUND',404);mutation(auth,businessId,promise.chatId);const written=DB.run("UPDATE ava_client_promises SET status=?,revision=revision+1,completedBy=?,completionEvidence='manual_confirmation',updatedAt=? WHERE businessId=? AND id=? AND revision=? AND status='open'",[body.status,actor.userId,new Date().toISOString(),actor.businessId,promiseId,body.revision]);if(written.changes!==1)fail('WORKSPACE_PROMISE_CONFLICT',409);return {success:true,businessId:actor.businessId,promise:Store.promiseView(DB.get('SELECT * FROM ava_client_promises WHERE businessId=? AND id=?',[actor.businessId,promiseId]))};}
function search(auth,businessId,query={}) {
    const actor=authorize(auth,businessId),q=text(query.q,200),limit=integer(query.limit,20,50);
    const words=q.match(/[\p{L}\p{N}]+/gu)||[];if(!words.length)return {success:true,businessId:actor.businessId,results:[]};
    const match=words.slice(0,12).map(w=>'"'+w.replace(/"/g,'""')+'"*').join(' AND ');
    const rows=DB.all(`SELECT businessId,type,sourceId,chatId,title,snippet(ava_workspace_search,5,'','',' … ',24) AS snippet FROM ava_workspace_search WHERE ava_workspace_search MATCH ? AND businessId=? ORDER BY bm25(ava_workspace_search),type,sourceId LIMIT ?`,[match,actor.businessId,limit]);
    return {success:true,businessId:actor.businessId,results:rows.map(r=>({id:r.type+':'+r.sourceId,type:r.type,title:r.title,snippet:r.snippet,chatId:r.chatId,sourceId:r.sourceId,href:r.type==='deal'?`/deals?dealId=${encodeURIComponent(r.sourceId)}`:`/?client=${encodeURIComponent(r.chatId)}&source=${encodeURIComponent(r.sourceId)}`}))};
}
function savedViews(auth,businessId){const actor=authorize(auth,businessId);return {success:true,businessId:actor.businessId,views:DB.all('SELECT * FROM ava_saved_views WHERE businessId=? AND userId=? ORDER BY createdAt,id',[actor.businessId,actor.userId]).map(r=>({id:r.id,name:r.name,filters:parse(r.filtersJson)}))};}
function createSavedView(auth,businessId,body){keys(body,['name','filters']);keys(body.filters,['view','query','channel']);const actor=authorize(auth,businessId,'sales.write'),name=text(body.name,80),filters=body.filters;if(filters.channel!==undefined&&!['whatsapp','telegram','email','vk','max','instagram','avito'].includes(filters.channel))fail('WORKSPACE_INPUT_INVALID');if(!['mine','queue','team','overview'].includes(filters.view)||filters.query!==undefined&&(typeof filters.query!=='string'||filters.query.length>200))fail('WORKSPACE_INPUT_INVALID');if(filters.view==='team'&&!['hotel_owner','sales_lead'].includes(actor.role))fail('SALES_TEAM_VIEW_DENIED',403);const id='view_'+crypto.randomUUID();DB.run('INSERT INTO ava_saved_views(id,businessId,userId,name,filtersJson,createdAt) VALUES(?,?,?,?,?,?)',[id,actor.businessId,actor.userId,name,JSON.stringify(filters),new Date().toISOString()]);return {success:true,businessId:actor.businessId,view:{id,name,filters}};}
function deleteSavedView(auth,businessId,id){const actor=authorize(auth,businessId,'sales.write');if(DB.run('DELETE FROM ava_saved_views WHERE businessId=? AND userId=? AND id=?',[actor.businessId,actor.userId,id]).changes!==1)fail('WORKSPACE_VIEW_NOT_FOUND',404);return {success:true,businessId:actor.businessId};}
function snooze(auth,businessId,chatId,body){keys(body,['until']);const {actor,row}=mutation(auth,businessId,chatId),until=Store.dateInstant(body.until);if(Date.parse(until)<=Date.now()||Date.parse(until)>Date.now()+366*86400000)fail('WORKSPACE_INPUT_INVALID');DB.run('INSERT INTO ava_workspace_snoozes(businessId,userId,chatId,until) VALUES(?,?,?,?) ON CONFLICT(businessId,userId,chatId) DO UPDATE SET until=excluded.until',[actor.businessId,actor.userId,row.chatId,until]);return {success:true,businessId:actor.businessId,until};}
function replyStatus(auth,businessId,chatId,query={}){const {actor,client}=readClient(auth,businessId,chatId),key=text(query.idempotencyKey,200);const action=DB.get('SELECT * FROM ava_workspace_reply_actions WHERE businessId=? AND userId=? AND idempotencyKey=?',[actor.businessId,actor.userId,key]);if(action&&action.chatId!==client.chatId)fail('WORKSPACE_IDEMPOTENCY_CONFLICT',409);return action?replyResult(actor,action):{success:true,businessId:actor.businessId,status:'not_started',control:Store.getControl(actor.businessId,client.chatId)};}
function dialogueRevisionView(businessId,chatId){const flags=ImprovementFlags.snapshot(businessId).flags;return flags.collaboration||flags.copilot?{dialogueRevision:Collaboration.dialogueRevision(businessId,chatId)}:{};}
function replyResult(actor,action){const failureCode=action.status==='failed'&&['AVITO_CHAT_SUBSCRIPTION_REQUIRED','AVITO_CHAT_UNAVAILABLE'].includes(action.failureCode)?action.failureCode:null;return {success:true,businessId:actor.businessId,...(failureCode?{failureCode}:{}),status:action.status==='sending'?'unknown':action.status,...(action.messageId?{messageId:action.messageId}:{}),control:Store.getControl(actor.businessId,action.chatId),...dialogueRevisionView(actor.businessId,action.chatId)};}
async function reply(auth,businessId,chatId,body,preparedDelivery=null) {
    keys(body,['text','idempotencyKey','expectedDialogueRevision']);if(body.expectedDialogueRevision!==undefined&&!(typeof body.expectedDialogueRevision==='string'&&/^[1-9]\d{0,18}$/.test(body.expectedDialogueRevision)||Number.isSafeInteger(body.expectedDialogueRevision)&&body.expectedDialogueRevision>0))fail('WORKSPACE_INPUT_INVALID');const content=text(body.text,12000),key=text(body.idempotencyKey,200),{actor,row}=mutation(auth,businessId,chatId,'messages.send');
    const digest=crypto.createHash('sha256').update(content).digest('hex');let action,repeat=false,reservedDialogueRevision;
    const flags=ImprovementFlags.snapshot(actor.businessId).flags,dialogueEnabled=flags.collaboration||flags.copilot;
    if(dialogueEnabled)Collaboration.ensureSchema();
    DB.db.transaction(()=>{
        action=DB.get('SELECT * FROM ava_workspace_reply_actions WHERE businessId=? AND userId=? AND idempotencyKey=?',[actor.businessId,actor.userId,key]);
        if(action){if(action.chatId!==row.chatId||action.textHash!==digest)fail('WORKSPACE_IDEMPOTENCY_CONFLICT',409);repeat=true;return;}
        mutation(auth,businessId,row.chatId,'messages.send');
        if(dialogueEnabled&&body.expectedDialogueRevision!==undefined&&Collaboration.dialogueRevision(actor.businessId,row.chatId)!==String(body.expectedDialogueRevision))fail('WORKSPACE_DIALOGUE_CHANGED',409);
        // Reserve the shared durable slot before any provider work, regardless of key/session.
        const control=Store.setControl({businessId:actor.businessId,chatId:row.chatId,mode:'human',reason:'Менеджер отвечает клиенту',actorUserId:actor.userId});
        action={id:'reply_'+crypto.randomUUID(),businessId:actor.businessId,chatId:row.chatId,userId:actor.userId,idempotencyKey:key,textHash:digest,controlRevision:control.revision,status:'sending',text:content,dispatchOwnerJson:Store.replyDispatchOwner(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
        DB.run("INSERT INTO ava_workspace_reply_actions(id,businessId,chatId,userId,idempotencyKey,textHash,controlRevision,status,text,dispatchOwnerJson,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,'sending',?,?,?,?)",[action.id,action.businessId,action.chatId,action.userId,key,digest,action.controlRevision,content,action.dispatchOwnerJson,action.createdAt,action.updatedAt]);
        if(preparedDelivery){
            const attachment=preparedDelivery.attachment;
            const recipient=require('./channel-router.service')._recipient(actor.businessId,row,'whatsapp',row.chatId);
            if(!recipient||attachment.businessId!==actor.businessId||attachment.chatId!==row.chatId)fail('WORKSPACE_ATTACHMENT_INVALID',409);
            DB.run('INSERT INTO ava_workspace_document_actions VALUES(?,?,?,?,?)',[action.id,actor.businessId,attachment.documentKey,recipient,attachment.sha256]);
        }
        Store.beginHumanSend({businessId:actor.businessId,chatId:row.chatId,revision:control.revision,sendId:action.id});
        if(dialogueEnabled)reservedDialogueRevision=Collaboration.dialogueRevision(actor.businessId,row.chatId);
    }).immediate();
    if(repeat)return replyResult(actor,action);
    const beforeMessageId=DB.get('SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE instanceId=? AND chatId=?',[actor.businessId,row.chatId]).id;
    let outcome,dispatchStarted=false;
    try {
        mutation(auth,businessId,row.chatId,'messages.send');
        const beforeSend=()=>{
            if (preparedDelivery?.beforeDispatch) preparedDelivery.beforeDispatch();
            DB.db.transaction(()=>{
                mutation(auth,businessId,row.chatId,'messages.send');
                const current=DB.get('SELECT * FROM ava_conversation_control WHERE businessId=? AND chatId=?',[actor.businessId,row.chatId]);
                if(current?.mode!=='human'||current.revision!==action.controlRevision||current.activeSendId!==action.id||current.activeSendStatus!=='sending')fail('WORKSPACE_CONTROL_CONFLICT',409);
                if(dialogueEnabled){
                    const flags=ImprovementFlags.snapshot(actor.businessId).flags;
                    if(!flags.collaboration&&!flags.copilot)fail('WORKSPACE_FEATURE_DISABLED',409);
                    if(Collaboration.dialogueRevision(actor.businessId,row.chatId)!==reservedDialogueRevision)fail('WORKSPACE_DIALOGUE_CHANGED',409);
                }
                Store.markReplyDispatch({businessId:actor.businessId,chatId:row.chatId,actionId:action.id});
            }).immediate();
            dispatchStarted=true;
        };
        const dispatch = {origin:'authenticated_customer_reply',businessId:actor.businessId,userId:actor.userId,actionId:action.id,idempotencyKey:key,sendId:action.id,beforeSend};
        const router = require('./channel-router.service');
        const result = preparedDelivery
            ? await router.sendAttachmentDetailed(actor.businessId,row.chatId,preparedDelivery.attachment,content,dispatch)
            : await router.sendMessageDetailed(actor.businessId,row.chatId,content,null,dispatch);
        const postDispatchGuardFailure=dispatchStarted&&/^(ACCOUNT_|WORKSPACE_|CAPABILITY_|BUSINESS_|SALES_)/.test(result?.error||'');
        const knownFailure=/^(business_inactive|unsupported_channel|whatsapp_not_configured|whatsapp_not_authorized|whatsapp_state_check_failed|instagram_manual_reply_required|instagram_recipient_not_inbound|.*_recipient_missing|WORKSPACE_|CAPABILITY_|BUSINESS_|SALES_)/.test(result?.error||'');
        outcome={status:result?.unknown===true||result?.status==='unknown'||postDispatchGuardFailure?'unknown':result?.success===true?'sent':result?.safeToRetry===true||!dispatchStarted&&knownFailure?'failed':'unknown',messageId:result?.provider_message_id||result?.messageId||null,storedMessageId:result?.stored_message_id||null,failureCode:result?.safeToRetry===true||!dispatchStarted?result?.error:null,acknowledged:result?.success===true,providerMessageId:result?.provider_message_id||null};
    }catch(error){outcome={status:!dispatchStarted&&/^(ACCOUNT_|BUSINESS_|CAPABILITY_|SALES_|WORKSPACE_)/.test(error?.code||'')?'failed':'unknown',messageId:null,failureCode:!dispatchStarted?error?.code:null};}
    DB.db.transaction(()=>{
        if(outcome.acknowledged&&outcome.storedMessageId&&outcome.providerMessageId){
            try{Store.recordReplyAcknowledgement({businessId:actor.businessId,chatId:row.chatId,actionId:action.id,messageId:outcome.storedMessageId,providerMessageId:outcome.providerMessageId});}
            catch(error){
                if(!['WORKSPACE_RECOVERY_EVIDENCE_INVALID','WORKSPACE_RECOVERY_EVIDENCE_CONFLICT'].includes(error?.code))throw error;
                require('../utils/logger').warn('[Workspace] Provider acknowledged reply; local evidence binding requires review');
            }
        }
        const completedAt=new Date().toISOString();
        const changed=DB.run("UPDATE ava_workspace_reply_actions SET status=?,messageId=?,updatedAt=?,dispatchCompletedAt=? WHERE businessId=? AND id=? AND status='sending'",[outcome.status,outcome.messageId,completedAt,completedAt,actor.businessId,action.id]);
        if(changed.changes!==1)fail('WORKSPACE_SEND_CONFLICT',409);
        Store.endAiSend({businessId:actor.businessId,chatId:row.chatId,sendId:action.id,status:outcome.status});
    }).immediate();
    if(outcome.status==='failed'&&outcome.failureCode==='WORKSPACE_DIALOGUE_CHANGED')fail('WORKSPACE_DIALOGUE_CHANGED',409);
    if(outcome.status==='sent'){
        const saved=outcome.storedMessageId?DB.get("SELECT id FROM messages WHERE instanceId=? AND chatId=? AND id=? AND content=? AND role='assistant'",[actor.businessId,row.chatId,outcome.storedMessageId,content]):DB.get("SELECT id FROM messages WHERE instanceId=? AND chatId=? AND content=? AND role='assistant' AND id>? ORDER BY id DESC LIMIT 1",[actor.businessId,row.chatId,content,beforeMessageId]);
        if(saved)try{Store.recordManualMessage({businessId:actor.businessId,chatId:row.chatId,messageId:saved.id,userId:actor.userId});Store.ingestPromises({businessId:actor.businessId,chatId:row.chatId,sourceType:'message',sourceId:String(saved.id)});}catch(_){require('../utils/logger').warn('[Workspace] Promise extraction requires reconciliation after acknowledged reply');}
    }
    return replyResult(actor,{...action,...outcome});
}
async function mediaContent(auth,businessId,chatId,messageId,{signal}={}) {
    const {actor,client}=readClient(auth,businessId,chatId);
    const msgId=integer(messageId,0,1000000000);
    const message=DB.get("SELECT * FROM messages WHERE instanceId=? AND chatId=? AND id=? AND role='user'",[actor.businessId,client.chatId,msgId]);
    if(!message||!message.sourceMessageId)fail('WHATSAPP_MEDIA_NOT_FOUND',404);
    const Media=require('./whatsapp-media.service');
    const media=Media.get(actor.businessId,message.originChatId||client.chatId,message.sourceMessageId);
    if(!media)fail('WHATSAPP_MEDIA_NOT_FOUND',404);
    const instanceConfig=await DB.getInstance(actor.businessId);
    return Media.fetchContent(media,instanceConfig,{signal});
}
async function retryMedia(auth,businessId,chatId,messageId,{signal}={}) {
    const {actor,row}=mutation(auth,businessId,chatId,'sales.write');
    const msgId=integer(messageId,0,1000000000);
    return require('./whatsapp.service').retryMedia(actor.businessId,row.chatId,msgId,{signal});
}
module.exports={authorize,workspace,clientWorkspace,control,listPromises,createPromise,updatePromise,search,savedViews,createSavedView,deleteSavedView,snooze,reply,replyStatus,mediaContent,retryMedia};
