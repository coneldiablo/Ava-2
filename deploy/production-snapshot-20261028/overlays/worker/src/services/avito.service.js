'use strict';
const crypto=require('crypto');
const DB=require('./database.service');
const Store=require('./integrations/store');
const Http=require('./integrations/http');
const provider='avito',base='https://api.avito.ru';
let recovering=false;
function externalId(value) {const s=String(value||'');if(!/^[A-Za-z0-9_-]{1,150}$/.test(s))Store.fail('AVITO_CHAT_INVALID');return s;}
function origin(account,chat) {return `avito:${externalId(account)}:${externalId(chat)}`;}
function save(id,input) {
    const row=Store.get(id,provider),credentials={...row?.credentials};
    for(const k of ['clientId','clientSecret'])if(input[k]!=null){if(typeof input[k]!=='string'||!input[k].trim()||input[k].length>2000)Store.fail('EXTERNAL_CREDENTIAL_INVALID');credentials[k]=input[k].trim();}
    if(!credentials.clientId||!credentials.clientSecret)Store.fail('EXTERNAL_CREDENTIALS_REQUIRED');
    const changed=!!row&&(credentials.clientId!==row.credentials.clientId||credentials.clientSecret!==row.credentials.clientSecret);
    if(changed){delete credentials.accessToken;delete credentials.expiresAt;delete credentials.connectedAt;}
    Store.save(id,provider,{},credentials);
    if(changed)Store.patch(id,provider,{status:'configured',accountId:null,accountName:null,capabilities:{},errorCode:null,webhookToken:null});
    return Store.status(id,provider);
}
async function token(id) {
    const row=Store.get(id,provider);if(!row?.credentials.clientId||row.status==='disconnected')Store.fail('EXTERNAL_NOT_CONFIGURED',409);
    if(row.credentials.accessToken&&row.credentials.expiresAt>Date.now()+60000)return row.credentials.accessToken;
    const lease=Store.lease(id,provider);
    try {
        const data=await Http.request({method:'POST',url:base+'/token',headers:{'Content-Type':'application/x-www-form-urlencoded'},data:new URLSearchParams({grant_type:'client_credentials',client_id:row.credentials.clientId,client_secret:row.credentials.clientSecret}).toString()});
        if(!data?.access_token||!Number.isFinite(Number(data.expires_in))||Number(data.expires_in)<1)Store.fail('EXTERNAL_ACK_INVALID',502);
        Store.patch(id,provider,{credentials:{...row.credentials,accessToken:data.access_token,expiresAt:Date.now()+Number(data.expires_in)*1000},errorCode:null},lease.revision);
        return data.access_token;
    }catch(e){throw Http.recordError(id,provider,e,lease.revision);}finally{Store.release(id,provider,lease.token);}
}
async function api(id,method,path,data,params) {
    if(!DB.get('SELECT 1 FROM instances WHERE id=? AND isActive=1',[Number(id)]))Store.fail('BUSINESS_NOT_FOUND',404);
    const row=Store.get(id,provider);if(!row)Store.fail('EXTERNAL_NOT_CONFIGURED',409);
    const access=await token(id);
    if(Store.get(id,provider)?.revision!==row.revision)Store.fail('EXTERNAL_CONNECTION_CHANGED',409,{safeToRetry:true});
    if(row.retryAt>Date.now())Store.fail('EXTERNAL_RATE_LIMITED',429,{retryAt:row.retryAt,safeToRetry:true});
    try{return await Http.request({method,url:base+path,headers:{Authorization:`Bearer ${access}`},data,params});}
    catch(error){const e=Http.providerError(error);if(e.code==='EXTERNAL_AUTH_REQUIRED'&&Store.get(id,provider)?.revision===row.revision)Store.patch(id,provider,{credentials:{...row.credentials,accessToken:null,expiresAt:0}},row.revision);throw Http.recordError(id,provider,e,row.revision);}
}
function accountRow(id) {if(!DB.get('SELECT 1 FROM instances WHERE id=? AND isActive=1',[Number(id)]))Store.fail('BUSINESS_NOT_FOUND',404);const row=Store.get(id,provider);if(!row?.accountId||row.status==='disconnected')Store.fail('EXTERNAL_AUTH_REQUIRED',409);return row;}
async function check(id) {
    const row=Store.get(id,provider);if(!row)Store.fail('EXTERNAL_NOT_CONFIGURED',409);
    const account=await api(id,'GET','/core/v1/accounts/self');
    if(!/^[1-9]\d*$/.test(String(account?.id||'')))Store.fail('EXTERNAL_ACCOUNT_INVALID',502);
    if(row.accountId&&String(account.id)!==row.accountId)Store.fail('EXTERNAL_ACCOUNT_CHANGED',409);
    // Read permission must be proven. A token and successful /self alone do not prove Messenger access.
    await api(id,'GET',`/messenger/v2/accounts/${account.id}/chats`,null,{limit:1});
    const current=Store.get(id,provider);
    Store.patch(id,provider,{status:'connected',accountId:String(account.id),accountName:String(account.name||'Авито').slice(0,255),errorCode:null,retryAt:null,lastSuccessAt:new Date().toISOString(),capabilities:{read:true,send:row.capabilities.send||'unverified'},credentials:{...current.credentials,connectedAt:current.credentials.connectedAt||Date.now()}},row.revision);
    return Store.status(id,provider);
}
async function connect(id) {return check(id);}
async function chats(id,{offset=0,limit=50}={}) {
    const row=accountRow(id);if(!Number.isSafeInteger(Number(offset))||Number(offset)<0||Number(offset)>10000)Store.fail('AVITO_OFFSET_INVALID');
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)Store.fail('AVITO_LIMIT_INVALID');
    const data=await api(id,'GET',`/messenger/v2/accounts/${row.accountId}/chats`,null,{limit,offset:Number(offset)});
    if(!Array.isArray(data?.chats))Store.fail('EXTERNAL_ACK_INVALID',502);
    Store.patch(id,provider,{lastSuccessAt:new Date().toISOString(),status:'connected',errorCode:null});
    return {chats:data.chats.map(chat=>({id:externalId(chat.id),title:String(chat.context?.value?.title||'Диалог Авито').slice(0,500),updated:chat.updated||chat.created||null,
        users:(chat.users||[]).filter(u=>String(u.id)!==row.accountId).map(u=>({id:String(u.id),name:String(u.name||'Клиент Авито').slice(0,255)})),
        clientChatId:Store.linked(id,provider,origin(row.accountId,chat.id),row.accountId)?.chatId||null})),nextOffset:data.chats.length===limit?Number(offset)+limit:null};
}
async function messages(id,chatId,{offset=0}={}) {
    const row=accountRow(id);
    const data=await api(id,'GET',`/messenger/v3/accounts/${row.accountId}/chats/${externalId(chatId)}/messages/`,null,{limit:100,offset});
    const list=Array.isArray(data)?data:data?.messages;
    if(!Array.isArray(list))Store.fail('EXTERNAL_ACK_INVALID',502);return list;
}
async function importChat(id,externalChatId,{onlyMessageId=null}={}) {
    const row=accountRow(id),chatId=externalId(externalChatId),natural=origin(row.accountId,chatId);
    // The authenticated account must be able to read this chat. Callback payload is not accepted as proof.
    const chat=await api(id,'GET',`/messenger/v2/accounts/${row.accountId}/chats/${chatId}`);
    // Ownership is proven by the authenticated account-specific GET. Avito
    // may return only the other party in `users`; our own user need not appear.
    if(chat?.id!==chatId||!Array.isArray(chat.users))Store.fail('AVITO_CHAT_NOT_OWNED',403);
    const peer=chat.users.find(u=>String(u.id)!==row.accountId);
    if(!peer)Store.fail('AVITO_CHAT_NOT_OWNED',403);
    const all=await messages(id,chatId),selected=onlyMessageId?all.filter(m=>String(m.id)===String(onlyMessageId)):all;
    if(onlyMessageId&&!selected.length)Store.fail('AVITO_EVENT_NOT_CONFIRMED',409);
    const client=await DB.getOrCreateClient(id,natural,String(peer.name||'Клиент Авито').slice(0,255));
    DB.run('UPDATE clients SET preferredChannel=? WHERE instanceId=? AND chatId=?',['avito',Number(id),client.chatId]);
    Store.link(id,provider,client.chatId,row.accountId,{externalChatId:chatId});
    const Jobs=require('./channel-jobs.store');
    let inserted=0,queued=0;
    for(const m of [...selected].sort((a,b)=>(a.created||0)-(b.created||0))) {
        if(m.type!=='text'||typeof m.content?.text!=='string'||!m.content.text.trim()||!m.id)continue;
        const outgoing=String(m.author_id)===row.accountId;
        if(!outgoing&&String(m.author_id)!==String(peer.id))continue;
        const text=m.content.text.slice(0,100000),pid=`${chatId}:${externalId(m.id)}`;
        // Imported history builds shared context but must never trigger old automatic replies.
        const fresh=!outgoing&&Number(m.created)*1000>=Number(row.credentials.connectedAt||Date.now());
        if(fresh) {
            const saved=Jobs.recordInbound({instanceId:Number(id),chatId:client.chatId,originChatId:natural,channel:'avito',providerMessageId:pid,text,senderName:String(peer.name||'Клиент Авито'),meta:{accountId:row.accountId,avitoChatId:chatId}});
            if(saved.inserted){inserted++;queued++;}
        } else {
            const saved=await DB.saveMessageWithChannel(id,natural,outgoing?'Менеджер':String(peer.name||'Клиент Авито'),text,outgoing?'assistant':'user','avito',null,pid);
            if(saved.inserted)inserted++;
        }
    }
    Store.patch(id,provider,{lastSuccessAt:new Date().toISOString(),errorCode:null,status:'connected'});
    return {chatId:client.chatId,inserted,queued};
}
function recipient(id,chatId) {
    const r=Store.get(id,provider);if(!r?.accountId||r.status==='disconnected')return null;
    const link=Store.linked(id,provider,chatId,r.accountId);
    return link?.externalChatId?origin(r.accountId,link.externalChatId):null;
}
async function sendMessageDetailed(id,target,text,context={}) {
    let dispatched=false;
    try {
        if(typeof text!=='string'||!text.trim()||text.length>10000)Store.fail('AVITO_TEXT_INVALID');
        const row=accountRow(id),parts=String(target||'').split(':');
        if(parts.length!==3||parts[0]!=='avito'||parts[1]!==row.accountId)Store.fail('AVITO_RECIPIENT_SCOPE_INVALID',403);
        const externalChatId=externalId(parts[2]),natural=origin(row.accountId,externalChatId);
        const canonical=require('./client-identity.service').resolve(id,context.chatId||natural);
        const link=Store.linked(id,provider,canonical,row.accountId);
        if(!link||link.externalChatId!==externalChatId||recipient(id,canonical)!==natural)Store.fail('AVITO_RECIPIENT_NOT_LINKED',403);
        if(typeof context.beforeSend!=='function')Store.fail('AVITO_SEND_GUARD_REQUIRED',403);
        const key=context.idempotencyKey||context.actionId||context.sendId;
        if(!key)Store.fail('EXTERNAL_IDEMPOTENCY_REQUIRED');
        // Preflight token acquisition is not a message send and is safely repeatable for client_credentials.
        await token(id);
        const payload={message:{text},type:'text'};
        const ack=await Http.write(id,provider,`message:${row.accountId}:${externalChatId}:${key}`,payload,async()=>{
            dispatched=true;return api(id,'POST',`/messenger/v1/accounts/${row.accountId}/chats/${externalChatId}/messages`,payload);
        },{chatId:canonical,beforeSend:async()=>{
            if(Store.get(id,provider)?.revision!==row.revision||recipient(id,canonical)!==natural)Store.fail('EXTERNAL_CONNECTION_CHANGED',409,{safeToRetry:true});
            await context.beforeSend();
        },validate:d=>!!d?.id||!!d?.message?.id});
        const providerId=externalId(ack.id||ack.message.id);
        if(Store.get(id,provider)?.revision===row.revision)Store.patch(id,provider,{lastSuccessAt:new Date().toISOString(),errorCode:null,status:'connected',capabilities:{...row.capabilities,send:true}},row.revision);
        return {success:true,channel:'avito',provider_message_id:providerId,source_message_id:`${externalChatId}:${providerId}`,origin_chat_id:natural,safeToRetry:false};
    } catch(error) {
        const unknown=error.unknown===true||(dispatched&&error.safeToRetry!==true);
        return {success:false,channel:'avito',error:error?.code||'AVITO_SEND_FAILED',safeToRetry:!unknown&&(!dispatched||error.safeToRetry===true),unknown};
    }
}
async function reconcileMessage(id,chatId,evidence={}) {
    if(evidence.businessId!=null&&Number(evidence.businessId)!==Number(id))return {status:'unknown',reason:'AVITO_SCOPE_INVALID'};
    const row=accountRow(id),canonical=require('./client-identity.service').resolve(id,evidence.chatId||chatId);
    const link=Store.linked(id,provider,canonical,row.accountId);
    if(!link)return {status:'unknown',reason:'AVITO_RECIPIENT_NOT_LINKED'};
    if(String(chatId).startsWith('avito:')&&String(chatId)!==origin(row.accountId,link.externalChatId))return {status:'unknown',reason:'AVITO_SCOPE_INVALID'};
    const key=evidence.idempotencyKey||evidence.actionId||evidence.sendId;
    const pid=evidence.providerMessageId||evidence.provider_message_id;
    if(key){const op=Store.operation(id,provider,`message:${row.accountId}:${link.externalChatId}:${key}`);
        if(op?.status==='succeeded'){const ack=JSON.parse(op.evidenceJson),found=String(ack.id||ack.message.id);
            if(!pid||String(pid)===found)return {status:'sent',providerMessageId:found,idempotencyKey:String(key),evidence:'persisted_provider_ack'};}}
    if(pid) {
        const found=(await messages(id,link.externalChatId)).find(m=>String(m.id)===String(pid)&&String(m.author_id)===row.accountId);
        if(found)return {status:'sent',providerMessageId:String(pid),...(key?{idempotencyKey:String(key)}:{}),evidence:'provider_message_readback'};
    }
    return {status:'unknown',reason:'AVITO_PROVIDER_OUTCOME_UNCONFIRMED'};
}
async function sync(id) {
    const row=accountRow(id),key=`chat-scan:${row.accountId}`,offset=Store.progress(id,provider,key)||0;
    let count=0,imported=0;
    // Persist the scan cursor only after the page is complete. Interrupted
    // pages repeat safely through durable provider-message IDs.
    const page=await chats(id,{offset,limit:10});
    for(const chat of page.chats){const result=await importChat(id,chat.id);count++;imported+=result.inserted;}
    Store.progress(id,provider,key,page.nextOffset||0);
    return {chats:count,imported,partial:page.nextOffset!=null,nextOffset:page.nextOffset};
}
async function webhook(id,secret,body) {
    const row=accountRow(id),provided=Buffer.from(String(secret||'')),expected=Buffer.from(row.webhookToken||'');
    if(!expected.length||provided.length!==expected.length||!crypto.timingSafeEqual(provided,expected))Store.fail('EXTERNAL_CALLBACK_INVALID',403);
    const value=body?.payload?.value;
    if(String(value?.user_id)!==row.accountId||!value.chat_id||!value.id)Store.fail('EXTERNAL_CALLBACK_INVALID',403);
    return Store.enqueueCallback(id,provider,`${row.accountId}:${externalId(value.chat_id)}:${externalId(value.id)}`,{accountId:row.accountId,chatId:externalId(value.chat_id),messageId:externalId(value.id)});
}
async function subscribe(id) {
    const row=accountRow(id),secret=crypto.randomBytes(32).toString('base64url');
    let url;try{const u=new URL(process.env.WHATSAPP_CRM_PUBLIC_URL);if(u.protocol!=='https:'||u.username||u.password)throw new Error();url=u.origin;}catch(_){Store.fail('EXTERNAL_PUBLIC_URL_REQUIRED',503);}
    Store.patch(id,provider,{webhookToken:secret});
    await api(id,'POST','/messenger/v3/webhook',{url:`${url}/api/external-integrations/webhook/avito/${Number(id)}/${secret}`});
    return {subscribed:true};
}
async function processJob(job) {
    const Jobs=require('./channel-jobs.store'),Context=require('./channel-context.service');
    try {
        if(job.status==='acknowledged') {
            const saved=await DB.saveMessageWithChannel(job.instanceId,job.originChatId,'AVA',job.response?.reply||'', 'assistant','avito',null,`${job.meta.avitoChatId}:${job.outgoingProviderMessageId}`);
            Jobs.complete(job,{providerMessageId:job.outgoingProviderMessageId,storedMessageId:saved.id||job.storedMessageId||null});return;
        }
        const client=await DB.getClient(job.instanceId,job.chatId),instance=await DB.getInstance(job.instanceId);
        if(!client||!instance?.isActive){Jobs.suppress(job,'BUSINESS_INACTIVE');return;}
        const connection=accountRow(job.instanceId),expected=origin(job.meta.accountId,job.meta.avitoChatId);
        const assertOrigin=()=>{
            const current=Store.get(job.instanceId,provider);
            if(current?.revision!==connection.revision||current.accountId!==String(job.meta.accountId)||recipient(job.instanceId,client.chatId)!==expected||require('./client-identity.service').resolve(job.instanceId,expected)!==client.chatId)Store.fail('AVITO_INBOUND_ACCOUNT_CHANGED',409,{safeToRetry:true});
        };
        assertOrigin();
        const snapshot=job.guardSnapshot||Context.capture(job.instanceId,client.chatId);
        Context.assertCanSend(job.instanceId,client.chatId,snapshot,{origin:'ai'});
        if(require('./ava-autopilot.store').policy(job.instanceId)?.activated){Jobs.suppress(job,'AUTOPILOT_CHANNEL_UNSUPPORTED');return;}
        let response=job.response;
        if(!response) {
            const history=await DB.getClientHistory(job.instanceId,client.chatId,20);
            const context={...require('./channel-customer-context.service').aiContext(job.instanceId,client.chatId),clientName:client.senderName,leadStatus:client.leadStatus,
                systemPrompt:instance.systemPrompt,salesGoal:instance.salesGoal||'call',instanceConfig:instance,instanceId:job.instanceId,currentBatchText:job.text};
            const rag=await require('./rag.service').buildConversationContext(job.instanceId,client.chatId,job.text,{k:5});context.ragContext=rag.context;context.ragSearched=rag.searched;
            response=await require('./ai.service').getResponse(history,context);
        }
        response=typeof response==='string'?{reply:response}:response;
        if(!response?.reply){Jobs.suppress(job,'AVITO_EMPTY_RESPONSE');return;}
        if(!Jobs.prepare(job,response,snapshot))Store.fail('CHANNEL_LEASE_LOST',409);
        Context.assertCanSend(job.instanceId,client.chatId,snapshot,{origin:'ai'});
        const result=await require('./channel-router.service').sendMessageDetailed(job.instanceId,client.chatId,response.reply,'avito',{
            businessId:job.instanceId,origin:'ai',idempotencyKey:`avito-reply:${job.id}`,channelSnapshot:snapshot,
            beforeSend:()=>{assertOrigin();if(!Jobs.markSending(job))Store.fail('CHANNEL_LEASE_LOST',409,{safeToRetry:true});}});
        if(!result.success){if(result.safeToRetry) {
            if(['AVITO_INBOUND_ACCOUNT_CHANGED','WORKSPACE_HUMAN_CONTROL','AUTOPILOT_CHANNEL_UNSUPPORTED'].includes(result.error))Jobs.suppress(job,result.error);
            else Jobs.retry(job,result.error,{definiteNoSideEffect:true,delayMs:10000,guardSnapshot:Context.capture(job.instanceId,client.chatId)});
        }else Jobs.unknown(job,result.error);return;}
        Jobs.ack(job,{providerMessageId:result.provider_message_id});
        Jobs.complete(job,{providerMessageId:result.provider_message_id,storedMessageId:result.stored_message_id||null});
    }catch(e){if(['WORKSPACE_HUMAN_CONTROL','AUTOPILOT_CHANNEL_UNSUPPORTED','AVITO_INBOUND_ACCOUNT_CHANGED'].includes(e.code))Jobs.suppress(job,e.code);else Jobs.retry(job,e.code||'AVITO_PROCESSING_FAILED',{delayMs:10000,clearResponse:e.code==='WORKSPACE_DIALOGUE_CHANGED'});}
}
async function recoverPending({poll=true}={}) {
    if(recovering||!DB.db)return;recovering=true;
    try {
        Store.schema();const Jobs=require('./channel-jobs.store');Jobs.recoverExpiredLeases({channel:'avito'});
        for(const callback of Store.callbacks(provider)) {
            try {
                if(accountRow(callback.instanceId).accountId!==callback.payload.accountId)Store.fail('EXTERNAL_ACCOUNT_CHANGED',409);
                await importChat(callback.instanceId,callback.payload.chatId,{onlyMessageId:callback.payload.messageId});Store.finishCallback(callback);
            }catch(e){Store.finishCallback(callback,e);}
        }
        if(poll)for(const row of DB.all("SELECT instanceId FROM customer_external_connections WHERE provider='avito' AND status IN ('connected','error','rate_limited') ORDER BY lastSuccessAt ASC LIMIT 5")) {
            try{await sync(row.instanceId);}catch(_){}
        }
        for(const pending of Jobs.pending({channel:'avito',limit:30})) {
            if(pending.status==='acknowledged'){await processJob(pending);continue;}
            const job=Jobs.claimBatch({channel:'avito',instanceId:pending.instanceId,chatId:pending.chatId,leaseMs:120000});
            if(job)await processJob(job);
        }
    }finally{recovering=false;}
}
module.exports={save,connect,check,chats,messages,importChat,recipient,sendMessageDetailed,reconcileMessage,sync,webhook,subscribe,recoverPending,processJob,api,origin};
