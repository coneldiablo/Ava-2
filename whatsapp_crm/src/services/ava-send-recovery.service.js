'use strict';
const crypto=require('crypto');
const DB=require('./database.service');
const Store=require('./ava-workspace.store');
const Sales=require('./sales-workspace.service');
const Canonical=require('./client-identity.service');
const leadership=new Set(['hotel_owner','sales_lead']);
function fail(code,statusCode=400){throw Object.assign(new Error(code),{code,statusCode});}
function text(value,max=200){if(typeof value!=='string'||!value.trim()||value.length>max)fail('WORKSPACE_INPUT_INVALID');return value.trim();}
function keys(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail('WORKSPACE_INPUT_INVALID');}
function scoped(auth,businessId,chatId,write=false){
    const actor=Sales.authorize(auth,businessId,write?'sales.write':'sales.read');
    if(write&&!leadership.has(actor.role))fail('WORKSPACE_RECOVERY_RESOLVE_DENIED',403);
    Store.ensureSchema();
    DB.db.transaction(()=>Canonical.canonical(actor.businessId,chatId)).immediate();
    return {actor,client:Store.scope(actor.businessId,chatId)};
}
function canRead(actor,action){return actor.role!=='manager'||action.userId===actor.userId;}
function resolutionView(row){return row?{id:row.id,actionId:row.actionId,previousStatus:row.previousStatus,outcome:row.outcome,actorUserId:row.actorUserId,actorRole:row.actorRole,method:row.method,reason:row.reason,evidenceMessageId:row.evidenceMessageId,providerMessageId:row.providerMessageId,createdAt:row.createdAt}:null;}
function evidenceFor(action){
    const own=DB.get('SELECT * FROM ava_workspace_reply_evidence WHERE actionId=? AND businessId=? AND chatId=? AND textHash=?',[action.id,action.businessId,action.chatId,action.textHash]);
    if(own)return own;
    if(DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='whatsapp_document_deliveries'")){
        // Created only by trusted document dispatch, not caller-selected keys.
        const document=DB.get(`SELECT d.providerMessageId,d.updatedAt FROM ava_workspace_document_actions r
            JOIN whatsapp_document_deliveries d ON d.businessId=r.businessId AND d.documentKey=r.documentKey AND d.recipient=r.recipient AND d.sha256=r.sha256
            WHERE r.actionId=? AND r.businessId=? AND d.status='accepted' AND d.providerMessageId IS NOT NULL`,[action.id,action.businessId]);
        if(document)return {messageId:null,providerMessageId:document.providerMessageId,createdAt:new Date(document.updatedAt).toISOString()};
    }
    if(!DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ava_channel_delivery_evidence'"))return null;
    // Channel ACK can be durable before workspace receives the adapter result.
    // Correlate the server-generated action ID or an already-known provider ID;
    // caller-chosen idempotency keys can collide across users and are insufficient.
    const params=[action.businessId,action.chatId,action.id],provider=action.messageId?' OR providerMessageId=?':'';
    if(action.messageId)params.push(String(action.messageId));
    const rows=DB.all(`SELECT providerMessageId,storedMessageId,createdAt FROM ava_channel_delivery_evidence WHERE businessId=? AND chatId=? AND (idempotencyKey=?${provider}) LIMIT 2`,params);
    return rows.length===1?{messageId:rows[0].storedMessageId||null,providerMessageId:rows[0].providerMessageId,createdAt:rows[0].createdAt}:null;
}
function actionView(action,resolution){return {id:action.id,status:action.status,text:action.text||null,textHash:action.textHash,userId:action.userId,createdAt:action.createdAt,updatedAt:action.updatedAt,dispatchStartedAt:action.dispatchStartedAt,dispatchCompletedAt:action.dispatchCompletedAt,messageId:action.messageId||null,resolution,abandonedDispatch:action.status==='sending'&&Store.abandonedReplyDispatch(action)};}
function response(actor,client,action){
    const resolution=action?resolutionView(DB.get('SELECT * FROM ava_workspace_reply_resolutions WHERE businessId=? AND chatId=? AND actionId=?',[actor.businessId,client.chatId,action.id])):null;
    const evidence=action?evidenceFor(action):null;
    return {success:true,businessId:actor.businessId,chatId:client.chatId,canResolve:leadership.has(actor.role),action:action?actionView(action,resolution):null,evidence:evidence?[{messageId:evidence.messageId,providerMessageId:evidence.providerMessageId,kind:'provider_ack',createdAt:evidence.createdAt}]:[],history:resolution?[resolution]:[],control:Store.getControl(actor.businessId,client.chatId)};
}
function detail(auth,businessId,chatId,query={}){
    keys(query,['actionId']);const {actor,client}=scoped(auth,businessId,chatId);
    let action;
    if(query.actionId!==undefined){action=DB.get('SELECT * FROM ava_workspace_reply_actions WHERE businessId=? AND chatId=? AND id=?',[actor.businessId,client.chatId,text(query.actionId)]);if(!action||!canRead(actor,action))fail('WORKSPACE_RECOVERY_NOT_FOUND',404);}
    else{const own=actor.role==='manager'?' AND userId=?':'',params=[actor.businessId,client.chatId,...(own?[actor.userId]:[])];action=DB.get(`SELECT * FROM ava_workspace_reply_actions WHERE businessId=? AND chatId=?${own} ORDER BY CASE WHEN status IN ('sending','unknown') THEN 0 ELSE 1 END,createdAt DESC,id DESC LIMIT 1`,params);}
    return response(actor,client,action);
}
function reconcile(auth,businessId,chatId,body){
    keys(body,['actionId','outcome','confirmation','reason','evidenceMessageId']);
    const actionId=text(body.actionId),reason=text(body.reason,1000);
    if(!['sent','failed'].includes(body.outcome)||body.confirmation!==true||reason.length<5||body.evidenceMessageId!==undefined&&(!Number.isSafeInteger(body.evidenceMessageId)||body.evidenceMessageId<1))fail('WORKSPACE_INPUT_INVALID');
    // Prepare lazy identity schema outside the transaction so denied writes cannot cache rolled-back schema.
    const prepared=scoped(auth,businessId,chatId,true);
    return DB.db.transaction(()=>{
        const {actor,client}=scoped(auth,businessId,prepared.client.chatId,true);
        const action=DB.get('SELECT * FROM ava_workspace_reply_actions WHERE businessId=? AND chatId=? AND id=?',[actor.businessId,client.chatId,actionId]);
        if(!action)fail('WORKSPACE_RECOVERY_NOT_FOUND',404);
        const evidence=evidenceFor(action);
        if(body.evidenceMessageId!==undefined&&(!evidence||evidence.messageId!==body.evidenceMessageId))fail('WORKSPACE_RECOVERY_EVIDENCE_INVALID');
        if(evidence&&body.outcome!=='sent')fail('WORKSPACE_RECOVERY_EVIDENCE_CONFLICT',409);
        const existing=DB.get('SELECT * FROM ava_workspace_reply_resolutions WHERE actionId=? AND businessId=?',[actionId,actor.businessId]);
        if(existing){if(existing.outcome!==body.outcome)fail('WORKSPACE_RECOVERY_CONFLICT',409);return response(actor,client,action);}
        if(action.status!=='unknown'&&!(action.status==='sending'&&Store.abandonedReplyDispatch(action)))fail('WORKSPACE_RECOVERY_CONFLICT',409);
        const control=DB.get('SELECT * FROM ava_conversation_control WHERE businessId=? AND chatId=?',[actor.businessId,client.chatId]);
        if(!control||control.activeSendId!==action.id)fail('WORKSPACE_SEND_CONFLICT',409);
        const now=new Date().toISOString();
        DB.run('INSERT INTO ava_workspace_reply_resolutions(id,actionId,businessId,chatId,previousStatus,outcome,actorUserId,actorRole,method,reason,evidenceMessageId,providerMessageId,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',['resolution_'+crypto.randomUUID(),action.id,actor.businessId,client.chatId,action.status,body.outcome,actor.userId,actor.role,evidence?'provider_ack':'leadership_confirmation',reason,evidence?.messageId||null,evidence?.providerMessageId||null,now]);
        const changed=DB.run('UPDATE ava_workspace_reply_actions SET status=?,messageId=COALESCE(?,messageId),updatedAt=? WHERE businessId=? AND chatId=? AND id=? AND status=?',[body.outcome,evidence?.providerMessageId||null,now,actor.businessId,client.chatId,action.id,action.status]);
        if(changed.changes!==1)fail('WORKSPACE_RECOVERY_CONFLICT',409);
        const released=DB.run('UPDATE ava_conversation_control SET activeSendId=NULL,activeSendStatus=NULL,revision=revision+1,updatedAt=? WHERE businessId=? AND chatId=? AND activeSendId=?',[now,actor.businessId,client.chatId,action.id]);
        if(released.changes!==1)fail('WORKSPACE_SEND_CONFLICT',409);
        return response(actor,client,DB.get('SELECT * FROM ava_workspace_reply_actions WHERE businessId=? AND id=?',[actor.businessId,action.id]));
    }).immediate();
}
module.exports={detail,reconcile};
