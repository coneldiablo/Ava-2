'use strict';
const DB = require('../database.service');
const Sales = require('../sales-workspace.service');
const Identity = require('../identity/identity-store');
const { fail } = require('./policy');
function read(auth,businessId,callId) {
    if (typeof callId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(callId)) fail('TELEPHONY_CALL_INVALID');
    Identity.authorizeCapability(auth,businessId,'business.read');
    const event = DB.get('SELECT * FROM conversation_events WHERE instanceId=? AND callId=? AND sourceId=? LIMIT 1',[businessId,callId,`post_call:${callId}`]);
    if (!event?.chatId) return {success:true,businessId,callId,postProcessing:'pending',client:null,summary:null,tasks:[],followups:[]};
    const {row:client} = Sales.authorizeClientMutation(auth,businessId,event.chatId,{capability:'business.read'});
    const tasks = DB.all('SELECT taskId,summary,status,assigneeUserId,dueAt FROM manager_tasks WHERE instanceId=? AND callId=? AND chatId=? ORDER BY createdAt',[businessId,callId,client.chatId]);
    const followups = DB.all('SELECT draftId,status,sentAt,managerTaskId,metadataJson FROM followup_drafts WHERE instanceId=? AND callId=? AND chatId=? ORDER BY createdAt',[businessId,callId,client.chatId]).map(draft => {
        // Sent means acknowledged by the existing adapter. Delivery to the
        // recipient requires a separate provider receipt which is not stored here.
        const state = Sales.deliveryPending(draft) ? 'unknown' : draft.status==='sent' && draft.sentAt ? 'sent' : 'draft';
        return {draftId:draft.draftId,taskId:draft.managerTaskId||null,state,status:draft.status,sentAt:draft.sentAt||null,delivered:null,deliveryState:'not_verified'};
    });
    const completed = DB.get("SELECT decisionId FROM ml_decisions WHERE instanceId=? AND chatId=? AND taskType='post_call' AND json_valid(outputJson) AND json_extract(outputJson,'$.note.event_id')=? LIMIT 1",[businessId,client.chatId,event.eventId]);
    return {success:true,businessId,callId,postProcessing:completed?'saved':'pending',
        client:{chatId:client.chatId,name:client.senderName||null,url:`/clients/${encodeURIComponent(client.chatId)}`},
        summary:typeof event.content==='string'?event.content.slice(0,12000):null,tasks,followups};
}
async function transcript(auth,businessId,recordId,reauthorize = () => {}) {
    if(typeof recordId!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(recordId)) fail('TELEPHONY_CALL_INVALID');
    Identity.authorizeCapability(auth,businessId,'business.read');
    const {apiUrl,serviceToken,timeoutMs}=require('../../config').avaAdmin;
    if(!apiUrl||!serviceToken) fail('TELEPHONY_TRANSCRIPT_UNAVAILABLE',503);
    let response;
    try {
        response=await require('axios').get(`${apiUrl}/api/internal/calls/business/${businessId}/${encodeURIComponent(recordId)}/transcript`,{
            headers:{Authorization:`Bearer ${serviceToken}`,Accept:'application/json'},timeout:Math.min(Number(timeoutMs)||10000,10000),maxRedirects:0,maxContentLength:256*1024});
    } catch(_) {fail('TELEPHONY_TRANSCRIPT_UNAVAILABLE',503);}
    reauthorize();
    const source=response.data;
    if(source?.success!==true||Number(source.business_id)!==businessId||source.record_id!==recordId||!Array.isArray(source.turns)||source.turns.length>500)
        fail('TELEPHONY_TRANSCRIPT_UNAVAILABLE',503);
    const result=read(auth,businessId,source.call_id);
    // An unfinished post-call may not yet have a canonical client. Only a
    // supervisor can inspect that unassigned call, never another manager.
    if(!result.client) Identity.authorizeCapability(auth,businessId,'sales.assign');
    const turns=source.turns.filter(turn=>turn&&['user','assistant'].includes(turn.role)&&typeof turn.text==='string')
        .map(turn=>({role:turn.role,text:turn.text.slice(0,8000)}));
    return {success:true,businessId,recordId,callId:source.call_id,turns};
}
module.exports={read,transcript};
