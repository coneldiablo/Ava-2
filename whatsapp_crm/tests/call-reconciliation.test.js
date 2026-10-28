'use strict';
const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const DB=require('../src/services/database.service');
const {createTestDB}=require('./test-helper');
const R=require('../src/services/telephony/call-reconciliation');
beforeEach(()=>{if(DB.db?.open)DB.db.close();createTestDB();DB.run("INSERT INTO instances(id,name) VALUES(1,'One'),(2,'Two')");});
afterEach(()=>{if(DB.db?.open)DB.db.close();});
function fixture(){
 DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES(1,'canonical','Fixture')");
 const customerId='crm_1_'+DB.get("SELECT id FROM clients WHERE instanceId=1 AND chatId='canonical'").id;
 DB.createConversationEvent({eventId:'call-event',instanceId:1,chatId:'canonical',customerId,callId:'call-1',sourceId:'post_call:call-1',channel:'voice',role:'summary',content:'Synthetic summary'});
 DB.run("INSERT INTO manager_tasks(taskId,instanceId,chatId,customerId,callId,summary) VALUES('task-1',1,'stale',?,'call-1','Existing task')",[customerId]);
 DB.run("INSERT INTO ml_decisions(decisionId,instanceId,chatId,customerId,taskType,outputJson) VALUES('decision',1,'canonical',?,'post_call',?)",[customerId,JSON.stringify({note:{event_id:'call-event'},handoff_task:{task_id:'task-1',call_id:'call-1',customer_id:customerId}})]);
 DB.run("INSERT INTO followup_drafts(draftId,instanceId,chatId,customerId,callId,managerTaskId,status,originalText,text) VALUES('draft',1,'stale',?,'call-1','task-1','draft','Existing','Existing')",[customerId]);
 return customerId;
}
test('exact independently saved call/customer/task proof repairs links once without sends or duplicate tasks',()=>{
 fixture();assert.equal(R.inspect(1,'call-1')[0].reason,'repairable');
 assert.deepEqual(R.repair(1,'call-1','task-1','call-event'),{changed:true,reason:'repaired'});
 assert.equal(DB.get("SELECT chatId FROM manager_tasks WHERE taskId='task-1'").chatId,'canonical');
 assert.equal(DB.get("SELECT chatId FROM followup_drafts WHERE draftId='draft'").chatId,'canonical');
 assert.deepEqual(R.repair(1,'call-1','task-1','call-event'),{changed:false,reason:'already_consistent'});
 assert.equal(DB.get('SELECT count(*) n FROM manager_tasks').n,1);
 assert.equal(DB.get("SELECT count(*) n FROM conversation_events WHERE role='task'").n,1);
 assert.equal(DB.get("SELECT status FROM followup_drafts WHERE draftId='draft'").status,'draft');
});
test('missing history, customer, decision or wrong expected call cannot be guessed or repaired',()=>{
 const customer=fixture();
 assert.equal(R.repair(1,'call-1','task-1','changed').reason,'canonical_call_changed');
 DB.run("DELETE FROM ml_decisions");assert.equal(R.repair(1,'call-1','task-1','call-event').reason,'task_decision_unconfirmed');
 DB.run("UPDATE manager_tasks SET customerId=NULL");assert.equal(R.repair(1,'call-1','task-1','call-event').reason,'task_customer_unconfirmed');
 DB.run("UPDATE manager_tasks SET customerId=?",[customer]);DB.run('DELETE FROM clients');assert.equal(R.repair(1,'call-1','task-1','call-event').reason,'canonical_customer_unconfirmed');
 DB.run('DELETE FROM conversation_events');assert.equal(R.repair(1,'call-1','task-1','call-event').reason,'canonical_call_missing_or_ambiguous');
 assert.equal(DB.get("SELECT chatId FROM manager_tasks").chatId,'stale');
});
test('same call/task IDs do not cross business or current different-client identity',()=>{
 fixture();assert.deepEqual(R.repair(2,'call-1','task-1','call-event'),{changed:false,reason:'task_not_found'});
 DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES(1,'stale','Other')");
 assert.equal(R.repair(1,'call-1','task-1','call-event').reason,'task_identity_conflict');
});
for(const status of ['sending','unknown','sent'])test('external '+status+' is a fence, never relink or retry',()=>{
 fixture();DB.run('UPDATE followup_drafts SET status=?,metadataJson=?',[status,JSON.stringify({delivery_status:status})]);
 assert.equal(R.repair(1,'call-1','task-1','call-event').reason,'followup_external_outcome_fence');
 assert.equal(DB.get('SELECT chatId FROM followup_drafts').chatId,'stale');
});
test('transaction rechecks evidence after dry-run and rejects forged cross-tenant event references',()=>{
 const customer=fixture();assert.equal(R.inspect(1,'call-1')[0].reason,'repairable');
 DB.createConversationEvent({eventId:'foreign-event',instanceId:2,chatId:'foreign',customerId:customer,callId:'call-1',channel:'manager'});
 DB.run("UPDATE manager_tasks SET conversationEventId='foreign-event'");
 assert.equal(R.repair(1,'call-1','task-1','call-event').reason,'task_event_conflict');
 assert.equal(DB.get("SELECT chatId FROM manager_tasks").chatId,'stale');
});
test('new call task cannot be saved against missing, guessed or another-business customer',()=>{
 const customerId=fixture();
 assert.equal(R.assertCreationTarget({businessId:1,callId:'live',chatId:'canonical',customerId}).chatId,'canonical');
 for(const input of [
  {businessId:1,callId:'live',chatId:'missing',customerId},
  {businessId:2,callId:'live',chatId:'canonical',customerId},
  {businessId:1,callId:'live',chatId:'canonical',customerId:'crm_1_9999'},
  {businessId:1,callId:'live',chatId:'canonical',customerId:null},
 ])assert.throws(()=>R.assertCreationTarget(input),e=>e.code==='TELEPHONY_TASK_CUSTOMER_UNCONFIRMED');
 const existingTask=DB.get("SELECT * FROM manager_tasks WHERE taskId='task-1'");
 assert.throws(()=>R.assertCreationTarget({businessId:1,callId:'call-1',chatId:'canonical',customerId,existingTask}),e=>e.code==='TELEPHONY_TASK_IDENTITY_CONFLICT');
});
test('corrupt delivery metadata is not evidence permitting relinking',()=>{
 fixture();DB.run("UPDATE followup_drafts SET metadataJson='not-json'");
 assert.equal(R.repair(1,'call-1','task-1','call-event').reason,'followup_external_outcome_fence');
});
test('a draft already pointing at another current card is not moved',()=>{
 fixture();DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES(1,'other','Other')");
 DB.run("UPDATE followup_drafts SET chatId='other'");
 assert.equal(R.repair(1,'call-1','task-1','call-event').reason,'followup_identity_conflict');
});
