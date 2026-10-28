'use strict';
const crypto=require('crypto');
const DB=require('../database.service');
const Store=require('./store');
const Http=require('./http');
const provider='amocrm';
const positive=(v)=>Number.isSafeInteger(Number(v))&&Number(v)>0;
function mapping(input={}) {
    if(!input||typeof input!=='object'||Array.isArray(input))Store.fail('EXTERNAL_MAPPING_INVALID');
    const out={statusMap:{}};
    for(const k of ['pipelineId','responsibleUserId','taskTypeId'])if(input[k]!=null&&input[k]!=='') {if(!positive(input[k]))Store.fail('EXTERNAL_MAPPING_INVALID');out[k]=Number(input[k]);}
    for(const [k,v] of Object.entries(input.statusMap||{})) {
        if(!/^[a-z][a-z_]{0,50}$/.test(k)||!positive(v))Store.fail('EXTERNAL_MAPPING_INVALID');out.statusMap[k]=Number(v);
    }
    return out;
}
function publicOrigin() {
    try {const u=new URL(process.env.WHATSAPP_CRM_PUBLIC_URL);if(u.protocol!=='https:'||u.username||u.password)throw new Error();return u.origin;}catch(_){Store.fail('EXTERNAL_PUBLIC_URL_REQUIRED',503);}
}
function redirect(value) {
    const expected=publicOrigin()+'/api/external-integrations/callback/amocrm';
    if(value&&value!==expected)Store.fail('EXTERNAL_REDIRECT_INVALID');return expected;
}
function save(id,input,{actorId=null}={}) {
    const old=Store.get(id,provider),config={domain:Http.amoDomain(input.domain||old?.config.domain),redirectUri:redirect(input.redirectUri||old?.config.redirectUri),mapping:mapping(input.mapping||old?.config.mapping)};
    const credentials={...old?.credentials};
    for(const field of ['clientId','clientSecret'])if(input[field]!=null) {
        if(typeof input[field]!=='string'||!input[field].trim()||input[field].length>2000)Store.fail('EXTERNAL_CREDENTIAL_INVALID');credentials[field]=input[field].trim();
    }
    if(!credentials.clientId||!credentials.clientSecret)Store.fail('EXTERNAL_CREDENTIALS_REQUIRED');
    const changed=!!old&&(old.config.domain!==config.domain||old.credentials.clientId!==credentials.clientId||old.credentials.clientSecret!==credentials.clientSecret);
    if(changed){delete credentials.accessToken;delete credentials.refreshToken;delete credentials.expiresAt;}
    Store.save(id,provider,config,credentials);
    if(changed)Store.patch(id,provider,{status:'configured',accountId:null,accountName:null,capabilities:{},errorCode:null});
    const nonce=crypto.randomBytes(32).toString('base64url');
    Store.patch(id,provider,{authState:crypto.createHash('sha256').update(nonce).digest('hex'),authStateUntil:Date.now()+600000,authActorId:actorId});
    return {...Store.status(id,provider),authorizationUrl:`https://www.amocrm.ru/oauth?client_id=${encodeURIComponent(credentials.clientId)}&state=${encodeURIComponent(`${id}.${nonce}`)}&mode=popup`};
}
async function token(id,{code=null,beforeWrite=null}={}) {
    let row=Store.get(id,provider);if(!row)Store.fail('EXTERNAL_NOT_CONFIGURED',409);
    if(!code&&row.errorCode==='EXTERNAL_AUTH_OUTCOME_UNKNOWN')Store.fail('EXTERNAL_AUTH_OUTCOME_UNKNOWN',409);
    if(row.status==='disconnected')Store.fail('EXTERNAL_AUTH_REQUIRED',409);
    if(!code&&row.credentials.accessToken&&row.credentials.expiresAt>Date.now()+60000)return row.credentials.accessToken;
    if(!code&&!row.credentials.refreshToken)Store.fail('EXTERNAL_AUTH_REQUIRED',409);
    const lease=Store.lease(id,provider,{rotating:true});
    let dispatched=false,received=false;
    try {
        const grant=code?{grant_type:'authorization_code',code}:{grant_type:'refresh_token',refresh_token:row.credentials.refreshToken};
        if(beforeWrite)beforeWrite();dispatched=true;
        const data=await Http.request({method:'POST',url:`https://${row.config.domain}/oauth2/access_token`,data:{client_id:row.credentials.clientId,client_secret:row.credentials.clientSecret,redirect_uri:row.config.redirectUri,...grant}});
        if(!data?.access_token||!data?.refresh_token||!positive(data.expires_in))Store.fail('EXTERNAL_ACK_INVALID',502);
        received=true;if(beforeWrite)beforeWrite();
        Store.patch(id,provider,{credentials:{...row.credentials,accessToken:data.access_token,refreshToken:data.refresh_token,expiresAt:Date.now()+Number(data.expires_in)*1000},errorCode:null},lease.revision);
        return data.access_token;
    } catch(error) {
        const e=Http.providerError(error);
        if(dispatched&&!received&&e.safeToRetry!==true) {
            // A rotating refresh might have been consumed. Never reuse it.
            Store.patch(id,provider,{status:'reauth_required',errorCode:'EXTERNAL_AUTH_OUTCOME_UNKNOWN'},lease.revision);
            e.code='EXTERNAL_AUTH_OUTCOME_UNKNOWN';
        } else if(e.code==='EXTERNAL_REQUEST_REJECTED') Store.patch(id,provider,{status:'reauth_required',errorCode:'EXTERNAL_AUTH_REQUIRED'},lease.revision);
        throw e;
    } finally {Store.release(id,provider,lease.token);}
}
async function api(id,method,path,data,params,{softFail=false}={}) {
    if(!DB.get('SELECT 1 FROM instances WHERE id=? AND isActive=1',[Number(id)]))Store.fail('BUSINESS_NOT_FOUND',404);
    const row=Store.get(id,provider);if(!row)Store.fail('EXTERNAL_NOT_CONFIGURED',409);
    const access=await token(id);
    if(Store.get(id,provider)?.revision!==row.revision)Store.fail('EXTERNAL_CONNECTION_CHANGED',409,{safeToRetry:true});
    if(row.retryAt>Date.now())Store.fail('EXTERNAL_RATE_LIMITED',429,{retryAt:row.retryAt,safeToRetry:true});
    try{return await Http.request({method,url:`https://${row.config.domain}${path}`,headers:{Authorization:`Bearer ${access}`},data,params});}
    catch(e){throw softFail?e:Http.recordError(id,provider,e,row.revision);}
}
async function check(id) {
    const row=Store.get(id,provider);if(!row)Store.fail('EXTERNAL_NOT_CONFIGURED',409);
    const revision=row.revision;
    const account=await api(id,'GET','/api/v4/account');
    if(!positive(account?.id))Store.fail('EXTERNAL_ACCOUNT_INVALID',502);
    if(row.accountId&&String(account.id)!==row.accountId)Store.fail('EXTERNAL_ACCOUNT_CHANGED',409);
    await api(id,'GET','/api/v4/contacts',null,{limit:1});
    await api(id,'GET','/api/v4/leads',null,{limit:1});
    await api(id,'GET','/api/v4/tasks',null,{limit:1});
    Store.patch(id,provider,{accountId:String(account.id),accountName:String(account.name||row.config.domain).slice(0,255),status:'connected',errorCode:null,retryAt:null,lastSuccessAt:new Date().toISOString(),capabilities:{read:true,send:row.capabilities.send||'unverified'}},revision);
    if(!Store.progress(id,provider,`outbound-start:${account.id}`))initializeOutbound(id,String(account.id));
    return Store.status(id,provider);
}
async function connect(id,input={}, {beforeWrite=null}={}) {
    if(typeof input.code!=='string'||!input.code.trim()||input.code.length>4000)Store.fail('EXTERNAL_AUTH_CODE_REQUIRED');
    const row=Store.get(id,provider);if(row?.authLease&&row.authLeaseUntil>Date.now())Store.fail('EXTERNAL_AUTH_IN_PROGRESS',409);
    // An explicit new authorization is the only way to clear an unknown refresh.
    Store.patch(id,provider,{authLease:null,authLeaseUntil:null,status:'configured',errorCode:null});
    await token(id,{code:input.code.trim(),beforeWrite});return check(id);
}
async function callback(query) {
    const [id,nonce,...tail]=String(query.state||'').split('.');
    if(tail.length||!nonce||nonce.length<40)Store.fail('EXTERNAL_CALLBACK_INVALID',403);
    const row=Store.get(id,provider),hash=crypto.createHash('sha256').update(nonce).digest('hex');
    if(!row||row.authState!==hash||row.authStateUntil<Date.now()||!query.code)Store.fail('EXTERNAL_CALLBACK_INVALID',403);
    const authorize=()=>{
        if(!row.authActorId)Store.fail('EXTERNAL_CALLBACK_INVALID',403);
        const identity=require('../identity/identity-store');identity.authorizeCapability(identity.actor(row.authActorId),Number(id),'business.manage');
    };
    authorize();
    if(query.referer&&Http.amoDomain(query.referer)!==row.config.domain)Store.fail('EXTERNAL_CALLBACK_INVALID',403);
    const consumed=DB.run('UPDATE customer_external_connections SET authState=NULL,authStateUntil=NULL WHERE instanceId=? AND provider=? AND authState=?',[Number(id),provider,hash]);
    if(!consumed.changes)Store.fail('EXTERNAL_CALLBACK_INVALID',403);
    await connect(id,{code:query.code},{beforeWrite:authorize});return Number(id);
}
async function options(id) {
    const pipelines=await api(id,'GET','/api/v4/leads/pipelines');
    let users=[],usersUnavailable=false;
    try{users=(await api(id,'GET','/api/v4/users',null,{limit:250},{softFail:true}))?._embedded?.users||[];}catch(e){if(e.code!=='EXTERNAL_ACCESS_DENIED')throw e;usersUnavailable=true;}
    const account=await api(id,'GET','/api/v4/account',null,{with:'task_types'});
    return {pipelines:(pipelines?._embedded?.pipelines||[]).map(p=>({id:p.id,name:p.name,statuses:(p._embedded?.statuses||[]).map(s=>({id:s.id,name:s.name}))})),users:users.map(u=>({id:u.id,name:u.name})),usersUnavailable,taskTypes:(account?._embedded?.task_types||[]).map(t=>({id:t.id,name:t.name}))};
}
async function validateMapping(id,map) {
    if(!map.pipelineId&&!Object.keys(map.statusMap||{}).length&&!map.responsibleUserId&&!map.taskTypeId)return;
    const data=await options(id),pipeline=data.pipelines.find(p=>p.id===map.pipelineId);
    if((map.pipelineId||Object.keys(map.statusMap||{}).length)&&(!pipeline||Object.values(map.statusMap||{}).some(s=>!pipeline.statuses.some(v=>v.id===s))))Store.fail('EXTERNAL_MAPPING_NOT_AVAILABLE',409);
    if(map.responsibleUserId&&!data.users.some(u=>u.id===map.responsibleUserId))Store.fail('EXTERNAL_MAPPING_NOT_AVAILABLE',409);
    if(map.taskTypeId&&!data.taskTypes.some(t=>t.id===map.taskTypeId))Store.fail('EXTERNAL_MAPPING_NOT_AVAILABLE',409);
}
function phone(client) {
    const aliases=require('../client-identity.service').list(client.instanceId,client.chatId).aliases;
    const found=aliases.find(a=>a.kind==='phone')?.value||aliases.find(a=>a.kind==='whatsapp')?.value?.split('@')[0];
    return found&&/^\+?[1-9]\d{6,14}$/.test(found)?found:null;
}
async function syncClient(id,chatId,status=null,{kind='lead',text=null,sourceId=null,completeTill=null,legacy=null,beforeWrite=null}={}) {
    if(!DB.get('SELECT 1 FROM instances WHERE id=? AND isActive=1',[Number(id)]))Store.fail('BUSINESS_NOT_FOUND',404);
    id=Number(id);const client=await DB.getClient(id,chatId);if(!client)Store.fail('CLIENT_NOT_FOUND',404);
    if(kind==='task'&&(!sourceId||typeof text!=='string'||!text.trim()||!positive(completeTill)||Number(completeTill)<=Date.now()/1000))Store.fail('EXTERNAL_TASK_INVALID');
    let connection=Store.get(id,provider);
    // Legacy credentials remain runtime-only. Their operations still use the same durable ledger.
    const legacyMode=!connection&&legacy;
    if(!connection&&!legacyMode)Store.fail('EXTERNAL_NOT_CONFIGURED',409);
    const account=legacyMode?Http.amoDomain(legacy.amoCrmDomain):connection.accountId;
    if(!account)Store.fail('EXTERNAL_AUTH_REQUIRED',409);
    if(connection&&connection.status==='disconnected')Store.fail('EXTERNAL_AUTH_REQUIRED',409);
    const request=legacyMode?(method,path,data,params)=>Http.request({method,url:`https://${account}${path}`,data,params,headers:{Authorization:`Bearer ${legacy.amoCrmAccessToken}`}}):(method,path,data,params)=>{
        if(Store.get(id,provider)?.revision!==connection.revision)Store.fail('EXTERNAL_CONNECTION_CHANGED',409,{safeToRetry:true});
        return api(id,method,path,data,params);
    };
    const map=legacyMode?mapping():connection.config.mapping||{};
    if(!legacyMode)await validateMapping(id,map);
    const base=`${account}:${client.chatId}`;
    let link=Store.linked(id,provider,client.chatId,account);
    const oldInstance=await DB.getInstance(id);
    let sameLegacyAccount=!!legacyMode;
    try{sameLegacyAccount=sameLegacyAccount||Http.amoDomain(oldInstance?.amoCrmDomain)===connection?.config.domain;}catch(_){}
    if(!link&&sameLegacyAccount&&client.crmContactId&&client.crmLeadId) {
        // Verify the old IDs against THIS account before adopting them.
        await request('GET',`/api/v4/contacts/${encodeURIComponent(client.crmContactId)}`);
        await request('GET',`/api/v4/leads/${encodeURIComponent(client.crmLeadId)}`);
        link=Store.link(id,provider,client.chatId,account,{contactId:String(client.crmContactId),leadId:String(client.crmLeadId)});
    }
    if(!link?.contactId) {
        const p=phone(client),payload=[{name:String(client.name||client.senderName||'Клиент AVA').slice(0,255),...(p?{custom_fields_values:[{field_code:'PHONE',values:[{value:p,enum_code:'WORK'}]}]}:{})}];
        const created=await Http.write(id,provider,`contact:${base}`,{chatId:client.chatId},()=>request('POST','/api/v4/contacts',payload),{chatId:client.chatId,beforeSend:beforeWrite,validate:d=>positive(d?._embedded?.contacts?.[0]?.id)});
        link=Store.link(id,provider,client.chatId,account,{contactId:String(created._embedded.contacts[0].id)});
    }
    if(!link.leadId) {
        const payload=[{name:`Заявка AVA: ${client.name||client.senderName||'Клиент'}`.slice(0,255),...(map.pipelineId?{pipeline_id:map.pipelineId}:{}),...(map.statusMap?.[status||client.leadStatus]?{status_id:map.statusMap[status||client.leadStatus]}:{}),...(map.responsibleUserId?{responsible_user_id:map.responsibleUserId}:{}),_embedded:{contacts:[{id:Number(link.contactId)}]}}];
        const created=await Http.write(id,provider,`lead:${base}`,{contactId:link.contactId},()=>request('POST','/api/v4/leads',payload),{chatId:client.chatId,beforeSend:beforeWrite,validate:d=>positive(d?._embedded?.leads?.[0]?.id)});
        link=Store.link(id,provider,client.chatId,account,{leadId:String(created._embedded.leads[0].id)});
    }
    await DB.updateClientCrmIds(id,client.chatId,String(link.contactId),String(link.leadId));
    const state=status||client.leadStatus||'new';
    if(kind==='task') {
        if(!sourceId||typeof text!=='string'||!text.trim()||!positive(completeTill)||Number(completeTill)<=Date.now()/1000)Store.fail('EXTERNAL_TASK_INVALID');
        const payload=[{entity_id:Number(link.leadId),entity_type:'leads',text:text.slice(0,10000),complete_till:Number(completeTill),...(map.responsibleUserId?{responsible_user_id:map.responsibleUserId}:{}),...(map.taskTypeId?{task_type_id:map.taskTypeId}:{})}];
        const ack=await Http.write(id,provider,`task:${base}:${sourceId}`,payload,()=>request('POST','/api/v4/tasks',payload),{chatId:client.chatId,beforeSend:beforeWrite,validate:d=>positive(d?._embedded?.tasks?.[0]?.id)});
        return {success:true,leadId:link.leadId,taskId:String(ack._embedded.tasks[0].id)};
    }
    const event=sourceId||`${client.lastStatusChangeAt||'initial'}:${state}`;
    if(kind==='lead'&&map.statusMap?.[state]) {
        const payload={id:Number(link.leadId),pipeline_id:map.pipelineId,status_id:map.statusMap[state]};
        await Http.write(id,provider,`status:${base}:${event}`,payload,()=>request('PATCH',`/api/v4/leads/${link.leadId}`,payload),{chatId:client.chatId,beforeSend:beforeWrite,validate:d=>positive(d?.id)});
    }
    const noteText=typeof text==='string'&&text.trim()?text.slice(0,15000):`Статус лида: ${state}`;
    const notes=[{note_type:'common',params:{text:noteText}}];
    const note=await Http.write(id,provider,`note:${base}:${event}`,notes,()=>request('POST',`/api/v4/leads/${link.leadId}/notes`,notes),{chatId:client.chatId,beforeSend:beforeWrite,validate:d=>positive(d?._embedded?.notes?.[0]?.id)});
    if(!legacyMode&&Store.get(id,provider)?.revision===connection.revision)Store.patch(id,provider,{lastSuccessAt:new Date().toISOString(),status:'connected',errorCode:null,capabilities:{...connection.capabilities,send:true}},connection.revision);
    return {success:true,leadId:link.leadId,contactId:link.contactId,noteId:String(note._embedded.notes[0].id),updated:true};
}
async function attachExisting(id,input,beforeWrite=null) {
    if(input?.confirm!==true||typeof input.chatId!=='string'||!positive(input.contactId)||!positive(input.leadId))Store.fail('EXTERNAL_LINK_CONFIRMATION_REQUIRED');
    const row=Store.get(id,provider);if(!row?.accountId)Store.fail('EXTERNAL_AUTH_REQUIRED',409);
    const client=await DB.getClient(id,input.chatId);if(!client)Store.fail('CLIENT_NOT_FOUND',404);
    const contact=await api(id,'GET',`/api/v4/contacts/${Number(input.contactId)}`);
    const lead=await api(id,'GET',`/api/v4/leads/${Number(input.leadId)}`,null,{with:'contacts'});
    if(Number(contact?.id)!==Number(input.contactId)||Number(lead?.id)!==Number(input.leadId)||!lead._embedded?.contacts?.some(c=>Number(c.id)===Number(contact.id)))Store.fail('EXTERNAL_ENTITY_LINK_INVALID',409);
    if(beforeWrite)beforeWrite();
    DB.db.transaction(()=>{
        Store.link(id,provider,client.chatId,row.accountId,{contactId:String(contact.id),leadId:String(lead.id)});
        // The owner has explicitly confirmed the association and both entities
        // have been read back from this authenticated account. Reconcile only
        // the exact pending create slots, never arbitrary notes or tasks.
        for(const [kind,evidence] of [['contact',{_embedded:{contacts:[{id:contact.id}]}}],['lead',{_embedded:{leads:[{id:lead.id}]}}]]) {
            const key=`${kind}:${row.accountId}:${client.chatId}`;
            if(Store.operation(id,provider,key))Store.finish(id,provider,key,'succeeded',evidence);
        }
    }).immediate();
    await DB.updateClientCrmIds(id,client.chatId,String(contact.id),String(lead.id));
    return {linked:true,chatId:client.chatId,contactId:String(contact.id),leadId:String(lead.id)};
}
async function webhook(id,secret,body) {
    const row=Store.get(id,provider);
    const accountId=body.account?.id||body['account[id]'],subdomain=body.account?.subdomain||body['account[subdomain]'];
    if(!row?.webhookToken||!equal(secret,row.webhookToken)||(!accountId&&!subdomain)||accountId&&String(accountId)!==row.accountId||subdomain&&String(subdomain)!==row.config.domain.split('.')[0])Store.fail('EXTERNAL_CALLBACK_INVALID',403);
    const collect=groups=>{
        const ids=new Set();
        const visit=(value,depth=0)=>{
            if(!value||typeof value!=='object'||depth>5||ids.size>=50)return;
            if(/^[1-9]\d*$/.test(String(value.id||'')))ids.add(String(value.id));
            else for(const [key,child] of Object.entries(value))if(/^\d+$/.test(key))visit(child,depth+1);
        };
        for(const group of groups)visit(group);return [...ids];
    };
    const ids=collect(['update','status','add'].map(action=>body.leads?.[action]));
    const taskIds=collect(['tasks','task'].flatMap(entity=>['update','add'].map(action=>body[entity]?.[action])));
    const key=crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    // Persist identifiers before acknowledging. Provider payload never becomes
    // CRM facts directly: the worker re-fetches each entity with our token.
    return Store.enqueueCallback(id,provider,key,{accountId:row.accountId,ids,taskIds:[...new Set(taskIds)].slice(0,50)});
}
async function processCallback(callback) {
    const id=callback.instanceId,row=Store.get(id,provider);
    if(!row?.accountId||row.accountId!==callback.payload.accountId||row.status==='disconnected')Store.fail('EXTERNAL_ACCOUNT_CHANGED',409);
    for(const leadId of callback.payload.ids||[]) {
        const link=Store.entity(id,provider,row.accountId,'lead',leadId)||DB.get('SELECT * FROM customer_external_links WHERE instanceId=? AND provider=? AND accountId=? AND leadId=?',[Number(id),provider,row.accountId,leadId]);
        if(!link)continue;
        const lead=await api(id,'GET',`/api/v4/leads/${leadId}`);
        const local=Object.entries(row.config.mapping?.statusMap||{}).find(([,v])=>Number(v)===lead.status_id)?.[0];
        if(local)await DB.updateClientStatus(id,link.chatId,local,'Изменено в amoCRM','integration');
        if(lead.name)recordLead(id,row,link.chatId,lead);
    }
    for(const taskId of callback.payload.taskIds||[]) {
        const task=await api(id,'GET',`/api/v4/tasks/${taskId}`);
        if(task.entity_type!=='leads')continue;
        const link=Store.entity(id,provider,row.accountId,'lead',task.entity_id);
        if(link)await projectTask(id,row,link.chatId,task);
    }
    Store.patch(id,provider,{lastSuccessAt:new Date().toISOString(),errorCode:null});
}
let recovering=false;
async function recoverPending({poll=false}={}) {
    if(recovering||!DB.db)return;recovering=true;
    try {
        Store.schema();
        for(const callback of Store.callbacks(provider)) {
            try{await processCallback(callback);Store.finishCallback(callback);}catch(e){Store.finishCallback(callback,e);}
        }
        if(poll)for(const row of DB.all("SELECT e.instanceId,e.status,e.retryAt FROM customer_external_connections e JOIN instances i ON i.id=e.instanceId AND i.isActive=1 WHERE e.provider='amocrm' AND e.status IN ('connected','error','rate_limited') LIMIT 5")) {
            if(row.retryAt>Date.now())continue;
            if(row.status!=='connected') {try{await check(row.instanceId);}catch(_){continue;}}
            try{await recoverOutbound(row.instanceId);}catch(_){}
            try{await sync(row.instanceId);}catch(_){}
        }
        if(poll)await require('./amocrm-catalog').refreshDue();
    }finally{recovering=false;}
}
async function projectTask(id,row,chatId,task) {
    if(!positive(task.id)||task.entity_type!=='leads')return;
    const client=await DB.getClient(id,chatId);if(!client)return;
    const own=DB.get("SELECT sourceId FROM customer_external_exports WHERE instanceId=? AND provider=? AND accountId=? AND sourceType='task' AND providerId=?",[Number(id),provider,row.accountId,String(task.id)]);
    const taskId=own?.sourceId||`amo_${id}_${row.accountId}_${task.id}`,existing=DB.getManagerTask(id,taskId);
    const due=positive(task.complete_till)?new Date(Number(task.complete_till)*1000).toISOString():null;
    if(!existing)DB.createManagerTask({taskId,instanceId:Number(id),chatId:client.chatId,customerId:`crm_${id}_${client.id}`,summary:String(task.text||'Задача amoCRM').slice(0,10000),source:'amocrm',status:task.is_completed?'done':'new',dueAt:due,metadata:{accountId:row.accountId,externalTaskId:String(task.id),leadId:String(task.entity_id)}});
    else DB.run('UPDATE manager_tasks SET summary=?,dueAt=?,status=?,updatedAt=CURRENT_TIMESTAMP WHERE instanceId=? AND taskId=?',[String(task.text||'Задача amoCRM').slice(0,10000),due,task.is_completed?'done':existing.status==='done'?'new':existing.status,Number(id),taskId]);
}
function initializeOutbound(id,accountId) {
    Store.progress(id,provider,`outbound-start:${accountId}`,{
        eventRowId:DB.get('SELECT COALESCE(MAX(rowid),0) n FROM conversation_events WHERE instanceId=?',[Number(id)]).n,
        taskRowId:DB.get('SELECT COALESCE(MAX(rowid),0) n FROM manager_tasks WHERE instanceId=?',[Number(id)]).n});
}
function exportHash(type,row) {
    return crypto.createHash('sha256').update(JSON.stringify(type==='note'?[row.eventId,row.chatId,row.content]:[row.taskId,row.chatId,row.summary,row.status,row.dueAt,row.resolutionNote])).digest('hex');
}
async function recoverOutbound(id) {
    const connection=Store.get(id,provider);if(!connection?.accountId||connection.status!=='connected')return {notes:0,tasks:0};
    const start=Store.progress(id,provider,`outbound-start:${connection.accountId}`);
    if(!start){initializeOutbound(id,connection.accountId);return {notes:0,tasks:0};}
    const result={notes:0,tasks:0};
    for(const [type,table,minimum] of [['note','conversation_events',start.eventRowId],['task','manager_tasks',start.taskRowId]]) {
        const cursorKey=`outbound-scan:${connection.accountId}:${type}`,cursor=Store.progress(id,provider,cursorKey)||minimum;
        const filter=type==='note'?"AND s.channel='voice' AND s.callId IS NOT NULL AND s.role='manager_note' AND s.sourceId LIKE 'post_call:%'":"AND s.source<>'amocrm'";
        const rows=DB.all(`SELECT s.rowid sourceRowId,s.* FROM ${table} s WHERE s.instanceId=? AND s.rowid>? ${filter}
            AND EXISTS(SELECT 1 FROM customer_external_links l WHERE l.instanceId=s.instanceId AND l.chatId=s.chatId AND l.provider=? AND l.accountId=? AND l.leadId IS NOT NULL AND l.contactId IS NOT NULL)
            ORDER BY s.rowid LIMIT 10`,[Number(id),cursor,provider,connection.accountId]);
        for(const source of rows) {
            if(type==='note') {let metadata;try{metadata=JSON.parse(source.metadataJson||'{}');}catch(_){continue;}
                if(!['provided_summary','transcript_extract'].includes(metadata.summary_provenance)||!source.content?.trim())continue;}
            const sourceId=type==='note'?source.eventId:source.taskId,hash=exportHash(type,source);
            const existing=DB.get('SELECT * FROM customer_external_exports WHERE instanceId=? AND provider=? AND accountId=? AND sourceType=? AND sourceId=?',[Number(id),provider,connection.accountId,type,sourceId]);
            if(existing?.status==='unknown'||existing?.status==='started'||existing?.status==='complete'&&existing.sourceHash===hash)continue;
            if(type==='task'&&!Number.isFinite(Date.parse(source.dueAt||''))) {
                DB.run(`INSERT INTO customer_external_exports VALUES(?,?,?,?,?,?,?,'blocked',NULL,'EXTERNAL_TASK_DUE_REQUIRED',?)
                    ON CONFLICT(instanceId,provider,accountId,sourceType,sourceId) DO UPDATE SET status='blocked',sourceHash=excluded.sourceHash,errorCode=excluded.errorCode,updatedAt=excluded.updatedAt`,[Number(id),provider,connection.accountId,type,sourceId,source.chatId,hash,Date.now()]);continue;
            }
            if(type==='task'&&!['new','in_progress','done'].includes(source.status)) {
                DB.run(`INSERT INTO customer_external_exports VALUES(?,?,?,?,?,?,?,'blocked',NULL,'EXTERNAL_TASK_STATUS_UNSUPPORTED',?)
                    ON CONFLICT(instanceId,provider,accountId,sourceType,sourceId) DO UPDATE SET status='blocked',sourceHash=excluded.sourceHash,errorCode=excluded.errorCode,updatedAt=excluded.updatedAt`,[Number(id),provider,connection.accountId,type,sourceId,source.chatId,hash,Date.now()]);continue;
            }
            const reserved=DB.run(`INSERT INTO customer_external_exports VALUES(?,?,?,?,?,?,?,'started',?,NULL,?)
                ON CONFLICT(instanceId,provider,accountId,sourceType,sourceId) DO UPDATE SET status='started',sourceHash=excluded.sourceHash,errorCode=NULL,updatedAt=excluded.updatedAt WHERE status NOT IN ('unknown','started')`,
                [Number(id),provider,connection.accountId,type,sourceId,source.chatId,hash,existing?.providerId||null,Date.now()]);
            if(!reserved.changes)continue;
            const guard=()=>{
                const current=Store.get(id,provider),fresh=DB.get(`SELECT * FROM ${table} WHERE instanceId=? AND ${type==='note'?'eventId':'taskId'}=?`,[Number(id),sourceId]);
                if(current?.revision!==connection.revision||current.accountId!==connection.accountId||!fresh||exportHash(type,fresh)!==hash||!Store.linked(id,provider,source.chatId,connection.accountId)?.leadId)Store.fail('EXTERNAL_SOURCE_CHANGED',409,{safeToRetry:true});
            };
            try {
                let providerId=existing?.providerId||null;
                if(type==='note') {
                    const ack=await syncClient(id,source.chatId,null,{kind:'note',text:source.content,sourceId:`call:${source.eventId}`,beforeWrite:guard});providerId=ack.noteId;result.notes++;
                } else {
                    const link=Store.linked(id,provider,source.chatId,connection.accountId),map=connection.config.mapping||{};
                    const payload={entity_id:Number(link.leadId),entity_type:'leads',text:String(source.summary).slice(0,10000),complete_till:Math.floor(Date.parse(source.dueAt)/1000),...(map.taskTypeId?{task_type_id:map.taskTypeId}:{}),...(map.responsibleUserId?{responsible_user_id:map.responsibleUserId}:{})};
                    if(providerId) {
                        const patch={text:payload.text,complete_till:payload.complete_till,...(source.status==='done'?{is_completed:true,result:{text:String(source.resolutionNote||'Задача выполнена в AVA').slice(0,10000)}}:{is_completed:false})};
                        await Http.write(id,provider,`task-update:${connection.accountId}:${sourceId}:${hash}`,patch,()=>api(id,'PATCH',`/api/v4/tasks/${providerId}`,patch),{chatId:source.chatId,beforeSend:guard,validate:d=>Number(d?.id)===Number(providerId)});
                    } else {
                        const ack=await Http.write(id,provider,`task-export:${connection.accountId}:${sourceId}`,[payload],()=>api(id,'POST','/api/v4/tasks',[payload]),{chatId:source.chatId,beforeSend:guard,validate:d=>positive(d?._embedded?.tasks?.[0]?.id)});providerId=String(ack._embedded.tasks[0].id);
                        DB.run('UPDATE customer_external_exports SET providerId=? WHERE instanceId=? AND provider=? AND accountId=? AND sourceType=? AND sourceId=?',[providerId,Number(id),provider,connection.accountId,type,sourceId]);
                        if(source.status==='done') {
                            const completed={is_completed:true,result:{text:String(source.resolutionNote||'Задача выполнена в AVA').slice(0,10000)}};
                            await Http.write(id,provider,`task-finish:${connection.accountId}:${sourceId}:${hash}`,completed,()=>api(id,'PATCH',`/api/v4/tasks/${providerId}`,completed),{chatId:source.chatId,beforeSend:guard,validate:d=>Number(d?.id)===Number(providerId)});
                        }
                    }
                    result.tasks++;
                }
                DB.run("UPDATE customer_external_exports SET status='complete',providerId=?,errorCode=NULL,updatedAt=? WHERE instanceId=? AND provider=? AND accountId=? AND sourceType=? AND sourceId=?",[providerId,Date.now(),Number(id),provider,connection.accountId,type,sourceId]);
            } catch(e) {DB.run('UPDATE customer_external_exports SET status=?,errorCode=?,updatedAt=? WHERE instanceId=? AND provider=? AND accountId=? AND sourceType=? AND sourceId=?',[e.unknown?'unknown':'failed',e.code||'EXTERNAL_EXPORT_FAILED',Date.now(),Number(id),provider,connection.accountId,type,sourceId]);}
        }
        Store.progress(id,provider,cursorKey,rows.length===10?rows.at(-1).sourceRowId:minimum);
    }
    return result;
}

function recordLead(id,row,chatId,lead) {
    const sourceId=`amo:${row.accountId}:${lead.id}:${lead.updated_at||0}`;
    DB.createConversationEvent({eventId:'evt_amo_'+crypto.createHash('sha256').update(`${id}:${sourceId}`).digest('hex'),instanceId:Number(id),chatId,sourceId,channel:'amocrm',direction:'internal',content:`Сделка amoCRM: ${String(lead.name||'Заявка').slice(0,255)}`,metadata:{provider:'amocrm',leadId:String(lead.id),pipelineId:lead.pipeline_id,statusId:lead.status_id,price:lead.price||0}});
}
async function sync(id) {
    const row=Store.get(id,provider);if(!row?.accountId||row.status==='disconnected')Store.fail('EXTERNAL_AUTH_REQUIRED',409);
    const cursorKey=`lead-scan:${row.accountId}`,page=Store.progress(id,provider,cursorKey)||1;
    const response=await api(id,'GET','/api/v4/leads',null,{limit:20,page,with:'contacts'});
    const leads=response?._embedded?.leads||[];let imported=0,tasks=0;
    for(const lead of leads) {
        if(!positive(lead.id))continue;
        let link=Store.entity(id,provider,row.accountId,'lead',lead.id);
        const contactId=lead._embedded?.contacts?.find(c=>c.is_main)?.id||lead._embedded?.contacts?.[0]?.id;
        if(!link&&contactId)link=Store.entity(id,provider,row.accountId,'contact',contactId);
        let contact=null;
        if(!link&&positive(contactId))contact=await api(id,'GET',`/api/v4/contacts/${contactId}`);
        const chatId=link?.chatId||`amo:${row.accountId}:${positive(contactId)?'contact-'+contactId:'lead-'+lead.id}`;
        const client=await DB.getOrCreateClient(id,chatId,String(contact?.name||lead.name||'Клиент amoCRM').slice(0,255));
        // A CRM contact is not proof of a phone / messenger identity. Linking it
        // to an existing cross-channel customer remains an explicit confirmation.
        Store.link(id,provider,client.chatId,row.accountId,{contactId:positive(contactId)?String(contactId):null,leadId:String(lead.id)});
        const local=Object.entries(row.config.mapping?.statusMap||{}).find(([,v])=>Number(v)===lead.status_id)?.[0];
        if(local)await DB.updateClientStatus(id,client.chatId,local,'Изменено в amoCRM','integration');
        recordLead(id,row,client.chatId,lead);imported++;
        const taskResponse=await api(id,'GET','/api/v4/tasks',null,{'filter[entity_type]':'leads','filter[entity_id]':lead.id,limit:50});
        for(const task of taskResponse?._embedded?.tasks||[]) {
            if(!positive(task.id)||Number(task.entity_id)!==Number(lead.id)||task.entity_type!=='leads')continue;
            await projectTask(id,row,client.chatId,task);
            tasks++;
        }
    }
    Store.patch(id,provider,{lastSuccessAt:new Date().toISOString(),status:'connected',errorCode:null});
    const nextPage=leads.length===20?page+1:null;
    Store.progress(id,provider,cursorKey,nextPage||1);
    return {imported,tasks,partial:nextPage!=null,nextPage};
}
function equal(a,b) {const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
async function subscribe(id) {
    const secret=crypto.randomBytes(32).toString('base64url'),r=Store.get(id,provider);if(!r?.accountId)Store.fail('EXTERNAL_AUTH_REQUIRED',409);
    Store.patch(id,provider,{webhookToken:secret});
    const destination=`${publicOrigin()}/api/external-integrations/webhook/amocrm/${Number(id)}/${secret}`;
    await api(id,'POST','/api/v4/webhooks',{destination,settings:['add_lead','update_lead','status_lead','add_task','update_task']});
    return {subscribed:true};
}
module.exports={save,connect,callback,check,options,syncClient,sync,attachExisting,webhook,subscribe,recoverPending,recoverOutbound,initializeOutbound,api,mapping};
