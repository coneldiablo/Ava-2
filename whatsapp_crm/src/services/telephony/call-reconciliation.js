'use strict';
// No inference, provider requests, customer creation, task creation, or sends.
// Only repair an existing task's internal links from independently saved proof.
const {createHash}=require('crypto');
const DB=require('../database.service');
const Sales=require('../sales-workspace.service');
const {fail}=require('./policy');
function scope(businessId,callId){
 if(!Number.isSafeInteger(businessId)||businessId<1||typeof callId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(callId))fail('TELEPHONY_CALL_INVALID');
}
function json(value){try{const parsed=JSON.parse(value||'{}');return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};}catch(_){return {};}}
function evidence(businessId,callId,task){
 const events=DB.all('SELECT * FROM conversation_events WHERE instanceId=? AND callId=? AND sourceId=?',[businessId,callId,`post_call:${callId}`]);
 if(events.length!==1)return {reason:'canonical_call_missing_or_ambiguous'};
 const event=events[0];
 const client=DB.get('SELECT * FROM clients WHERE instanceId=? AND chatId=?',[businessId,event.chatId]);
 if(!client||event.customerId!==`crm_${businessId}_${client.id}`)return {reason:'canonical_customer_unconfirmed'};
 if(task.customerId!==event.customerId)return {reason:'task_customer_unconfirmed'};
 if(task.chatId&&task.chatId!==client.chatId&&DB.get('SELECT id FROM clients WHERE instanceId=? AND chatId=?',[businessId,task.chatId]))return {reason:'task_identity_conflict'};
 const decisions=DB.all("SELECT * FROM ml_decisions WHERE instanceId=? AND chatId=? AND customerId=? AND taskType='post_call'",[businessId,client.chatId,event.customerId]);
 const proof=decisions.some(row=>{
  const output=json(row.outputJson),handoff=output.handoff_task||{};
  return output.note?.event_id===event.eventId&&(handoff.task_id===task.taskId||handoff.taskId===task.taskId)
   && String(handoff.call_id||handoff.callId||'')===callId
   && String(handoff.customer_id||handoff.customerId||'')===event.customerId;
 });
 if(!proof)return {reason:'task_decision_unconfirmed'};
 const drafts=DB.all('SELECT * FROM followup_drafts WHERE instanceId=? AND managerTaskId=?',[businessId,task.taskId]);
 if(drafts.some(d=>d.callId!==callId||d.customerId!==event.customerId))return {reason:'followup_identity_conflict'};
 if(drafts.some(d=>d.chatId&&d.chatId!==client.chatId&&DB.get('SELECT id FROM clients WHERE instanceId=? AND chatId=?',[businessId,d.chatId])))return {reason:'followup_identity_conflict'};
 if(drafts.some(d=>{try{const meta=JSON.parse(d.metadataJson||'{}');return !meta||typeof meta!=='object'||Array.isArray(meta);}catch(_){return true;}}))return {reason:'followup_external_outcome_fence'};
 if(drafts.some(d=>Sales.deliveryPending(d)||d.status==='sent'||d.sentAt))return {reason:'followup_external_outcome_fence'};
 const previous=task.conversationEventId&&DB.get('SELECT * FROM conversation_events WHERE eventId=?',[task.conversationEventId]);
 if(previous&&(Number(previous.instanceId)!==businessId||previous.callId!==callId||previous.customerId!==event.customerId||previous.chatId!==client.chatId))return {reason:'task_event_conflict'};
 const complete=task.chatId===client.chatId&&Boolean(previous)&&drafts.every(d=>d.chatId===client.chatId);
 return {reason:complete?'already_consistent':'repairable',event,client,drafts,previous};
}
function assertCreationTarget({businessId,callId,chatId,customerId,existingTask=null}){
 scope(businessId,callId);
 const client=DB.get('SELECT * FROM clients WHERE instanceId=? AND chatId=?',[businessId,chatId]);
 if(!client||customerId!==`crm_${businessId}_${client.id}`)fail('TELEPHONY_TASK_CUSTOMER_UNCONFIRMED',409);
 if(existingTask&&(Number(existingTask.instanceId)!==businessId||existingTask.callId!==callId
  ||existingTask.chatId!==chatId||existingTask.customerId!==customerId))fail('TELEPHONY_TASK_IDENTITY_CONFLICT',409);
 return client;
}
function inspect(businessId,callId){
 scope(businessId,callId);
 return DB.all('SELECT * FROM manager_tasks WHERE instanceId=? AND callId=? ORDER BY taskId',[businessId,callId]).map(task=>{
  const result=evidence(businessId,callId,task);
  return {taskId:task.taskId,reason:result.reason,eventId:result.event?.eventId||null};
 });
}
function repair(businessId,callId,taskId,expectedEventId){
 scope(businessId,callId);
 if(typeof taskId!=='string'||!taskId||typeof expectedEventId!=='string'||!expectedEventId)fail('TELEPHONY_INPUT_INVALID');
 return DB.db.transaction(()=>{
  const task=DB.get('SELECT * FROM manager_tasks WHERE instanceId=? AND callId=? AND taskId=?',[businessId,callId,taskId]);
  if(!task)return {changed:false,reason:'task_not_found'};
  const result=evidence(businessId,callId,task);
  if(!['repairable','already_consistent'].includes(result.reason))return {changed:false,reason:result.reason};
  if(result.event.eventId!==expectedEventId)return {changed:false,reason:'canonical_call_changed'};
  if(result.reason==='already_consistent')return {changed:false,reason:result.reason};
  const eventId=result.previous?.eventId||'evt_task_repair_'+createHash('sha256').update(`${businessId}:${taskId}`).digest('hex');
  const collision=DB.get('SELECT * FROM conversation_events WHERE eventId=?',[eventId]);
  if(collision&&(Number(collision.instanceId)!==businessId||collision.callId!==callId||collision.customerId!==task.customerId||collision.chatId!==result.client.chatId))return {changed:false,reason:'task_event_conflict'};
  if(!collision)DB.createConversationEvent({eventId,instanceId:businessId,chatId:result.client.chatId,customerId:task.customerId,
   channel:'manager',direction:'internal',role:'task',content:task.summary,callId,
   metadata:{source:'exact_call_link_repair',canonicalCallEventId:expectedEventId}});
  DB.run('UPDATE manager_tasks SET chatId=?,conversationEventId=?,updatedAt=CURRENT_TIMESTAMP WHERE instanceId=? AND callId=? AND taskId=?',[result.client.chatId,eventId,businessId,callId,taskId]);
  for(const draft of result.drafts)DB.run('UPDATE followup_drafts SET chatId=?,updatedAt=CURRENT_TIMESTAMP WHERE instanceId=? AND draftId=?',[result.client.chatId,businessId,draft.draftId]);
  return {changed:true,reason:'repaired'};
 }).immediate();
}
module.exports={inspect,repair,assertCreationTarget};
