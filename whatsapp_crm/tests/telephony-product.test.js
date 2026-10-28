'use strict';
const {test,beforeEach,afterEach}=require.main===module?require('node:test'):(()=>{
 const {it}=require('./test-helper');let setup=()=>{},cleanup=()=>{};
 return {beforeEach:fn=>{setup=fn;},afterEach:fn=>{cleanup=fn;},
 test:(name,fn)=>it(name,async()=>{try{await setup();await fn();}finally{await cleanup();}})};
})();
const assert=require('node:assert/strict');
const {createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service'),Identity=require('../src/services/identity/identity-store'),Auth=require('../src/services/auth.service');
const C=require('../src/services/telephony/campaigns'),Outbound=require('../src/services/ava-outbound.service'),D=require('../src/services/telephony/diagnostics');
let env,oldEnabled,original;
beforeEach(()=>{
 env={...process.env};oldEnabled=Auth.config.enabled;Auth.config.enabled=true;process.env.AVA_CUSTOMER_ACCESS_ENABLED='true';
 if(DB.db?.open)DB.db.close();createTestDB();Identity.ensureSchema();
 DB.run("INSERT INTO instances(id,name,isActive,sipCallerId,sipTrunkNumber,voiceContextName) VALUES(1,'One',1,'79990000001','owned-trunk','business-1'),(2,'Two',1,NULL,NULL,'business-2')");
 DB.run("INSERT INTO business_sip_aliases(alias,businessId) VALUES('79990000001',1)");
 process.env.AVA_TELEPHONY_LEGACY_DIDS='{"79990000001":1}';
 for(const [id,biz,role]of[['owner',1,'hotel_owner'],['manager',1,'manager'],['foreign',2,'hotel_owner']]){
 DB.run('INSERT INTO ava_users(id,subject,email,displayName) VALUES(?,?,?,?)',[id,id,id+'@example.test',id]);DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)',[id,biz,role]);}
 original={sync:Outbound.syncCampaign,status:Outbound.setCampaignStatus,get:Outbound.getCampaignStatus};
});
afterEach(()=>{process.env=env;Auth.config.enabled=oldEnabled;Object.assign(Outbound,{syncCampaign:original.sync,setCampaignStatus:original.status,getCampaignStatus:original.get});});
function draft(){const p=C.preview(1,'owner',{rows:[{phone:'8 (999) 000-00-02',name:'Test'},{phone:'+79990000002'},{phone:'garbage'}]});return C.create(1,'owner',{name:'Campaign',importId:p.importId},'draft-key-123').campaign;}
function evidence(id,status,businessId=1){return{success:true,sales_brain_campaign_id:id,ava_campaign:{id:'engine-id',business_id:businessId,external_source:'sales_brain',external_id:id,status}};}
test('legacy DID follows actual resolver; stale health never reports ready or leaks trunk',()=>{
 const own=D.snapshot(1);assert.equal(own.connections.length,1);assert.equal(own.connections[0].inbound.configured,true);assert.equal(own.connections[0].outbound.available,null);assert.equal(own.diagnostics.checks[1].state,'unknown');assert.equal(D.snapshot(2).connections.length,0);
 process.env.AVA_TELEPHONY_LEGACY_DIDS='{"79990000001":2}';assert.equal(D.snapshot(1).connections[0].inbound.configured,false);assert(!JSON.stringify(own).includes('owned-trunk'));
});
test('CSV quote/columns normalize+dedupe; create is idempotent scoped persistent draft',()=>{
 const p=C.preview(1,'owner',{csv:'Телефон;Имя\n8 (999) 000-00-02;"Имя; фамилия"\n+79990000002;Повтор\nno;Bad',phoneColumn:'Телефон',nameColumn:'Имя'});
 assert.deepEqual(p.counts,{total:3,accepted:1,invalid:1,duplicates:1});assert.equal(p.rows[0].name,'Имя; фамилия');
 const body={name:'Campaign',importId:p.importId,timezone:'Asia/Dubai'},d=C.create(1,'owner',body,'draft-key-123').campaign;
 assert.equal(C.create(1,'owner',body,'draft-key-123').campaign.campaignId,d.campaignId);assert.equal(C.details(1,d.campaignId).leads.length,1);assert.equal(d.contextId,'business-1');
 assert.throws(()=>C.create(1,'owner',{...body,name:'Changed'},'draft-key-123'),{code:'TELEPHONY_IDEMPOTENCY_CONFLICT'});assert.throws(()=>C.create(2,'foreign',body,'draft-key-123'),{code:'TELEPHONY_IMPORT_EXPIRED'});
});
test('invalid/expired preview and invalid callwindow fail before creating a campaign',()=>{
 const p=C.preview(1,'owner',{rows:[{phone:'79990000002'}]},1);
 assert.throws(()=>C.create(1,'owner',{name:'Old',importId:p.importId},'expired-key'),{code:'TELEPHONY_IMPORT_EXPIRED'});
 assert.throws(()=>C.create(1,'owner',{name:'Old',importId:p.importId,callWindow:{start:'18:00',end:'09:00'}},'invalid-key'),{code:'TELEPHONY_CALL_WINDOW_INVALID'});
 assert.throws(()=>C.preview(1,'owner',{rows:[],csv:'phone\n79990000002'}),{code:'TELEPHONY_INPUT_INVALID'});
});
test('start/pause/resume/stop apply to current runtime; each doubleclick dispatches once',async()=>{
 const d=draft();let requests=0;
 Outbound.syncCampaign=async(id,o)=>{requests++;assert.equal(o.syncLeads,false);assert.equal(o.maxConcurrent,1);return evidence(id,'running');};
 Outbound.setCampaignStatus=async(id,status,o)=>{requests++;if(status==='stopped')assert.equal(o.cancelPending,true);return evidence(id,status);};
 for(const[action,audience]of[['start',1],['pause'],['resume',1],['stop']]){
 const body={action,...(audience?{confirmAudience:audience}:{})},key='command-'+action;
 assert.equal((await C.command(1,'owner',d.campaignId,body,key)).command.state,'succeeded');await C.command(1,'owner',d.campaignId,body,key);}
 assert.equal(requests,4);assert.equal(C.details(1,d.campaignId).campaign.status,'stopped');
});
test('unknown ACK survives restart/newkey; only exact scoped read evidence clears fence',async()=>{
 const d=draft();let requests=0;Outbound.syncCampaign=async()=>{requests++;throw new Error('private secret');};
 await assert.rejects(()=>C.command(1,'owner',d.campaignId,{action:'start',confirmAudience:1},'command-start'),{code:'TELEPHONY_CAMPAIGN_OUTCOME_UNKNOWN'});
 assert.equal((await C.command(1,'owner',d.campaignId,{action:'start',confirmAudience:1},'command-start')).command.state,'unknown');
 delete require.cache[require.resolve('../src/services/telephony/campaigns')];const restarted=require('../src/services/telephony/campaigns');
 await assert.rejects(()=>restarted.command(1,'owner',d.campaignId,{action:'start',confirmAudience:1},'other-key-123'),{code:'TELEPHONY_CAMPAIGN_OUTCOME_UNKNOWN'});
 Outbound.getCampaignStatus=async()=>evidence(d.campaignId,'running',2);await assert.rejects(()=>C.reconcile(1,d.campaignId),{code:'TELEPHONY_CAMPAIGN_EVIDENCE_INVALID'});
 Outbound.getCampaignStatus=async()=>evidence(d.campaignId,'running');assert.equal((await C.reconcile(1,d.campaignId)).campaign.status,'running');assert.equal(requests,1);
});
test('start requires exact audience and own configured source',async()=>{
 const d=draft();let requests=0;Outbound.syncCampaign=async id=>{requests++;return evidence(id,'running');};
 await assert.rejects(()=>C.command(1,'owner',d.campaignId,{action:'start',confirmAudience:2},'command-start'),{code:'TELEPHONY_AUDIENCE_CONFIRMATION_REQUIRED'});
 DB.run('UPDATE instances SET sipTrunkNumber=NULL WHERE id=1');await assert.rejects(()=>C.command(1,'owner',d.campaignId,{action:'start',confirmAudience:1},'command-start'),{code:'TELEPHONY_SOURCE_UNAVAILABLE'});
 DB.run("UPDATE instances SET sipTrunkNumber='owned-trunk' WHERE id=1");await C.command(1,'owner',d.campaignId,{action:'start',confirmAudience:1},'command-start');
 await assert.rejects(()=>C.command(1,'owner',d.campaignId,{action:'start',confirmAudience:1},'other-start-key'),{code:'TELEPHONY_CAMPAIGN_STATE_CONFLICT'});assert.equal(requests,1);
});
test('legacy stale running state refreshes from runtime without starting calls and becomes startable',async()=>{
 const d=draft();DB.updateOutboundCampaign(d.campaignId,{status:'running',enabled:true});let dispatches=0;
 Outbound.syncCampaign=async id=>{dispatches++;return evidence(id,'running');};
 Outbound.getCampaignStatus=async()=>evidence(d.campaignId,'draft');
 const refreshed=await C.reconcile(1,d.campaignId);
 assert.equal(refreshed.runtimeStateConfirmed,true);assert.equal(refreshed.campaign.status,'draft');
 assert.equal(DB.getOutboundCampaign(d.campaignId).enabled,0);assert.equal(dispatches,0);
 await C.command(1,'owner',d.campaignId,{action:'start',confirmAudience:1},'repaired-start');
 assert.equal(dispatches,1);assert.equal(C.details(1,d.campaignId).campaign.status,'running');
});
test('state refresh rejects foreign runtime evidence, changed state and concurrent commands',async()=>{
 const d=draft();DB.updateOutboundCampaign(d.campaignId,{status:'running',enabled:true});
 Outbound.getCampaignStatus=async()=>evidence(d.campaignId,'draft',2);
 await assert.rejects(()=>C.reconcile(1,d.campaignId),{code:'TELEPHONY_CAMPAIGN_EVIDENCE_INVALID'});
 assert.equal(C.details(1,d.campaignId).campaign.status,'running');
 Outbound.getCampaignStatus=async()=>{DB.updateOutboundCampaign(d.campaignId,{status:'paused'});return evidence(d.campaignId,'draft');};
 await assert.rejects(()=>C.reconcile(1,d.campaignId),{code:'TELEPHONY_CAMPAIGN_STATE_CONFLICT'});
 assert.equal(C.details(1,d.campaignId).campaign.status,'paused');
 Outbound.getCampaignStatus=async()=>{DB.run("INSERT INTO ava_campaign_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",['racing-command',1,d.campaignId,'owner','racing-key','hash','resume','running','unknown',null,Date.now(),Date.now()]);return evidence(d.campaignId,'draft');};
 await assert.rejects(()=>C.reconcile(1,d.campaignId),{code:'TELEPHONY_CAMPAIGN_STATE_CONFLICT'});
 assert.equal(C.details(1,d.campaignId).campaign.command.state,'unknown');
 Outbound.getCampaignStatus=async()=>evidence(d.campaignId,'draft');
 await assert.rejects(()=>C.reconcile(1,d.campaignId),{code:'TELEPHONY_CAMPAIGN_EVIDENCE_INVALID'});
 assert.equal(C.details(1,d.campaignId).campaign.command.state,'unknown');
});
test('integrated CRM app real cookie HTTP enforces business/role/origin/revocation',async()=>{
 const app=require('../src/app').app;
 const sessions={};for(const id of ['owner','manager','foreign'])sessions[id]=Identity.createSession(id,id+'-session');
 const server=await new Promise(resolve=>{const l=app.listen(0,'127.0.0.1',()=>resolve(l));});const url=`http://127.0.0.1:${server.address().port}`;
 const h=id=>({Cookie:`crm_session=ava2:${sessions[id]}`,'Content-Type':'application/json',Origin:url});const base=url+'/api/businesses/1/outbound';
 try{
 assert.equal((await fetch(base+'/campaigns',{headers:h('foreign')})).status,403);
 assert.equal((await fetch(base+'/imports/preview',{method:'POST',headers:h('manager'),body:JSON.stringify({rows:[{phone:'79990000002'}]})})).status,403);
 assert.equal((await fetch(base+'/imports/preview',{method:'POST',headers:{...h('owner'),Origin:'https://evil.test'},body:JSON.stringify({rows:[{phone:'79990000002'}]})})).status,403);
 const r=await fetch(base+'/imports/preview',{method:'POST',headers:h('owner'),body:JSON.stringify({rows:[{phone:'79990000002'}]})});assert.equal(r.status,200);const preview=await r.json();assert.equal(preview.counts.accepted,1);
 const createBody={name:'HTTP campaign',importId:preview.importId};
 const made=await fetch(base+'/campaigns',{method:'POST',headers:{...h('owner'),'Idempotency-Key':'http-create-key'},body:JSON.stringify(createBody)});assert.equal(made.status,200);const created=await made.json();
 const repeated=await fetch(base+'/campaigns',{method:'POST',headers:{...h('owner'),'Idempotency-Key':'http-create-key'},body:JSON.stringify(createBody)});assert.equal((await repeated.json()).campaign.campaignId,created.campaign.campaignId);
 const settingsUrl=base+'/campaigns/'+created.campaign.campaignId+'/retry-settings';
 assert.equal((await fetch(settingsUrl,{method:'PATCH',headers:h('manager'),body:JSON.stringify({maxAttempts:3})})).status,403);
 assert.equal((await fetch(settingsUrl,{method:'PATCH',headers:{...h('owner'),Origin:'https://foreign.test'},body:JSON.stringify({maxAttempts:3})})).status,403);
 const updated=await fetch(settingsUrl,{method:'PATCH',headers:h('owner'),body:JSON.stringify({maxAttempts:3,retryIntervalMinutes:10})});assert.equal(updated.status,200);assert.equal((await updated.json()).campaign.retryIntervalMinutes,10);
 const forbiddenPatch=await fetch(url+'/api/sales-brain/outbound/campaigns/'+created.campaign.campaignId,{method:'PATCH',headers:h('owner'),body:JSON.stringify({enabled:true,status:'running'})});assert.equal(forbiddenPatch.status,409);
 let calls=0;Outbound.syncCampaign=async id=>{calls++;return evidence(id,'running');};
 const started=await fetch(base+'/campaigns/'+created.campaign.campaignId+'/commands',{method:'POST',headers:{...h('owner'),'Idempotency-Key':'http-start-key'},body:JSON.stringify({action:'start',confirmAudience:1})});assert.equal(started.status,200);
 const checked=await fetch(base+'/campaigns/'+created.campaign.campaignId,{headers:h('owner')});assert.equal((await checked.json()).campaign.status,'running');assert.equal(calls,1);
 const blockedSync=await fetch(url+'/api/sales-brain/outbound/campaigns/'+created.campaign.campaignId+'/sync-leads',{method:'POST',headers:h('owner'),body:'{}'});assert.equal(blockedSync.status,409);
 const d=draft();Outbound.syncCampaign=async id=>{DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='owner'");return evidence(id,'running');};
 const result=await fetch(base+'/campaigns/'+d.campaignId+'/commands',{method:'POST',headers:{...h('owner'),'Idempotency-Key':'start-command'},body:JSON.stringify({action:'start',confirmAudience:1})});assert.equal(result.status,403);assert.equal(DB.getOutboundCampaign(d.campaignId).status,'running');
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('501 imported contacts export through existing engine bridge without silent truncation or CRM expansion',async()=>{
 const rows=Array.from({length:501},(_,i)=>({phone:String(79990001000+i),name:'Contact '+i}));
 const p=C.preview(1,'owner',{rows});const d=C.create(1,'owner',{name:'Large',importId:p.importId},'large-import').campaign;
 const result=await require('../src/services/sales-brain.service').exportOutboundCampaignForAva({campaignId:d.campaignId,syncLeads:false});
 assert.equal(result.leads.length,501);assert.equal(new Set(result.leads.map(r=>r.phone_number)).size,501);
 assert.equal(C.details(1,d.campaignId).leads.length,501);
});
test('campaign schedule and attempt policy reach runtime export without expanding snapshot',async()=>{
 const p=C.preview(1,'owner',{rows:[{phone:'79990000002'}]});
 const d=C.create(1,'owner',{name:'Schedule',importId:p.importId,timezone:'Asia/Dubai',callWindow:{start:'10:15',end:'16:45'},maxAttempts:5},'schedule-draft').campaign;
 DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES(1,'79990000003','Outside snapshot')");
 const e=await require('../src/services/sales-brain.service').exportOutboundCampaignForAva({campaignId:d.campaignId,syncLeads:false,max_concurrent:1,min_interval_seconds_between_calls:10});
 assert.equal(e.campaign.business_id,1);assert.equal(e.campaign.timezone,'Asia/Dubai');
 assert.equal(e.campaign.daily_window_start_local,'10:15');assert.equal(e.campaign.daily_window_end_local,'16:45');
 assert.equal(e.campaign.max_attempts,5);assert.equal(e.campaign.max_concurrent,1);assert.equal(e.campaign.min_interval_seconds_between_calls,10);
 assert.equal(e.leads.length,1);assert.equal(e.leads[0].timezone,'Asia/Dubai');assert.equal(e.leads[0].context,'business-1');
});
test('late opt-out blocks start/resume, export and fresh scoped permission without adding audience',async()=>{
 const Permission=require('../src/services/telephony/campaign-permission');
 DB.run("INSERT INTO clients(instanceId,chatId,senderName,tags) VALUES(1,'79990000002','Snapshot','[]'),(2,'79990000002','Other tenant','[\"do_not_call\"]')");
 const d=draft(),lead=DB.listOutboundLeads(d.campaignId)[0];
 let dispatches=0;Outbound.syncCampaign=async id=>{dispatches++;return evidence(id,'running');};
 Outbound.setCampaignStatus=async(id,s)=>{dispatches++;return evidence(id,s);};
 const body={businessId:1,campaignId:d.campaignId,leadId:lead.leadId,phone:'+79990000002'};
 await C.command(1,'owner',d.campaignId,{action:'start',confirmAudience:1},'late-start-key');
 assert.equal(Permission.read(body).allowed,true);
 assert.throws(()=>Permission.read({...body,businessId:2}),{code:'TELEPHONY_CAMPAIGN_NOT_FOUND'});
 assert.throws(()=>Permission.read({...body,phone:'+79990000003'}),{code:'TELEPHONY_CAMPAIGN_NOT_FOUND'});
 await C.command(1,'owner',d.campaignId,{action:'pause'},'late-pause-key');
 DB.run("UPDATE clients SET tags='[\"do_not_call\"]' WHERE instanceId=1");
 assert.equal(Permission.read(body).reason,'do_not_call');
 await assert.rejects(()=>C.command(1,'owner',d.campaignId,{action:'resume',confirmAudience:1},'late-resume-key'),{code:'TELEPHONY_AUDIENCE_CONFIRMATION_REQUIRED'});
 assert.equal(dispatches,2);assert.equal(C.details(1,d.campaignId).campaign.audienceSize,0);
 const e=await require('../src/services/sales-brain.service').exportOutboundCampaignForAva({campaignId:d.campaignId,syncLeads:false});assert.equal(e.leads.length,0);
 DB.run("UPDATE clients SET tags='[]' WHERE instanceId=1");
 const p=C.preview(1,'owner',{rows:[{phone:'79990000002'}]});
 const fresh=C.create(1,'owner',{name:'Fresh',importId:p.importId},'fresh-late-draft').campaign;
 DB.run("UPDATE clients SET tags='[\"do_not_call\"]' WHERE instanceId=1");
 await assert.rejects(()=>C.command(1,'owner',fresh.campaignId,{action:'start',confirmAudience:1},'fresh-late-start'),{code:'TELEPHONY_AUDIENCE_CONFIRMATION_REQUIRED'});
 assert.equal(dispatches,2);
});
test('fresh campaign permission HTTP uses existing service-token boundary and rereads canonical opt-out',async()=>{
 process.env.CRM_SERVICE_API_TOKEN='synthetic-permission-token';
 const app=require('../src/app').app,d=draft(),lead=DB.listOutboundLeads(d.campaignId)[0];
 DB.updateOutboundCampaign(d.campaignId,{status:'running',enabled:true});
 const server=await new Promise(resolve=>{const l=app.listen(0,'127.0.0.1',()=>resolve(l));});
 const url=`http://127.0.0.1:${server.address().port}/api/internal/telephony/campaigns/can-dial`;
 const body={businessId:1,campaignId:d.campaignId,leadId:lead.leadId,phone:'+79990000002'};
 const post=payload=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic-permission-token'},body:JSON.stringify(payload)});
 try{
  assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);
  assert.equal((await(await post(body)).json()).allowed,true);
  DB.run("INSERT INTO clients(instanceId,chatId,senderName,tags) VALUES(1,'79990000002','Late canonical client','[\"do_not_call\"]')");
  const denied=await post(body);assert.equal(denied.status,200);assert.equal(denied.headers.get('cache-control'),'no-store');assert.equal((await denied.json()).allowed,false);
  assert.equal((await post({...body,businessId:2})).status,404);
  for(const state of ['dialing','unknown','completed']){
   DB.run('UPDATE outbound_leads SET state=? WHERE leadId=?',[state,lead.leadId]);
   require('../src/services/telephony/campaign-permission').refreshSnapshot(1,d.campaignId);
   assert.equal(DB.getOutboundLead(lead.leadId).state,state);
  }
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('call result links actual task/draft states and never claims delivery or leaks another tenant',()=>{
 DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES(1,'79990000002','Customer')");
 DB.run("INSERT INTO conversation_events(eventId,instanceId,chatId,channel,callId,sourceId,content) VALUES('evt',1,'79990000002','voice','call-one','post_call:call-one','Клиент попросил подборку')");
 DB.run("INSERT INTO manager_tasks(taskId,instanceId,chatId,callId,summary) VALUES('task',1,'79990000002','call-one','Проверить и отправить')");
 DB.run("INSERT INTO followup_drafts(draftId,instanceId,chatId,callId,managerTaskId,status) VALUES('draft',1,'79990000002','call-one','task','draft')");
 const Result=require('../src/services/telephony/call-result');const own=Result.read(Identity.actor('owner'),1,'call-one');
 assert.equal(own.tasks[0].taskId,'task');assert.equal(own.followups[0].state,'draft');assert.equal(own.followups[0].delivered,null);assert.equal(own.postProcessing,'pending');
 DB.run("INSERT INTO ml_decisions(decisionId,instanceId,chatId,taskType,outputJson) VALUES('dec',1,'79990000002','post_call',?)",[JSON.stringify({note:{event_id:'evt'}})]);
 assert.equal(Result.read(Identity.actor('owner'),1,'call-one').postProcessing,'saved');
 DB.run("UPDATE followup_drafts SET status='sent',sentAt='2026-10-17T20:00:00Z' WHERE draftId='draft'");assert.equal(Result.read(Identity.actor('owner'),1,'call-one').followups[0].state,'sent');
 for(const field of ['delivery_status','provider_status'])for(const state of ['sending','unknown','unknown_pending','delivery_unconfirmed']){
  DB.run("UPDATE followup_drafts SET metadataJson=? WHERE draftId='draft'",[JSON.stringify({[field]:state})]);
  assert.equal(Result.read(Identity.actor('owner'),1,'call-one').followups[0].state,'unknown');
 }
 DB.run("UPDATE followup_drafts SET metadataJson='{}',status='unknown' WHERE draftId='draft'");
 assert.equal(Result.read(Identity.actor('owner'),1,'call-one').followups[0].state,'unknown');
 assert.throws(()=>Result.read(Identity.actor('manager'),1,'call-one'));
 assert.equal(Result.read(Identity.actor('foreign'),2,'call-one').summary,null);
});
test('import respects confirmed cross-channel identities and existing do-not-call policy',()=>{
 DB.run("INSERT INTO clients(instanceId,chatId,senderName,tags) VALUES(1,'tg_555','Linked customer','[\"do_not_call\"]')");
 const Identities=require('../src/services/client-identity.service');Identities.resolve(1,'');
 DB.run("INSERT INTO client_aliases(instanceId,chatId,kind,value) VALUES(1,'tg_555','phone','+79990000002')");
 const d=draft(),lead=DB.listOutboundLeads(d.campaignId)[0];assert.equal(lead.chatId,'tg_555');assert.equal(lead.doNotCall,1);assert.equal(lead.state,'blocked');assert.equal(C.details(1,d.campaignId).campaign.audienceSize,0);
});
test('customer transcript bridge preserves scope, assignment, bounded content and revocation fence',async()=>{
 const axios=require('axios'),config=require('../src/config'),Result=require('../src/services/telephony/call-result');
 const savedGet=axios.get,savedConfig={...config.avaAdmin};
 Object.assign(config.avaAdmin,{apiUrl:'http://synthetic-engine',serviceToken:'synthetic-service-token'});
 DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId) VALUES(1,'79990000002','Customer','manager')");
 DB.run("INSERT INTO conversation_events(eventId,instanceId,chatId,channel,callId,sourceId,content) VALUES('evt',1,'79990000002','voice','call-one','post_call:call-one','Summary')");
 const source={success:true,business_id:1,record_id:'record-one',call_id:'call-one',turns:[{role:'user',text:'Question'},{role:'system',text:'private prompt'}]};
 try{
  axios.get=async(url)=>{assert(url.endsWith('/business/1/record-one/transcript'));return{data:source};};
  const response=await Result.transcript(Identity.actor('manager'),1,'record-one');assert.deepEqual(response.turns,[{role:'user',text:'Question'}]);
  source.business_id=2;await assert.rejects(()=>Result.transcript(Identity.actor('owner'),1,'record-one'),{code:'TELEPHONY_TRANSCRIPT_UNAVAILABLE'});source.business_id=1;
  await assert.rejects(()=>Result.transcript(Identity.actor('owner'),1,'record-one',()=>{throw Object.assign(new Error('revoked'),{statusCode:403});}),{statusCode:403});
  DB.run("UPDATE clients SET assigneeUserId='owner' WHERE instanceId=1");await assert.rejects(()=>Result.transcript(Identity.actor('manager'),1,'record-one'));
 }finally{axios.get=savedGet;Object.assign(config.avaAdmin,savedConfig);}
});

test('retry controls persist a fixed customer interval and reach engine export',async()=>{
 const p=C.preview(1,'owner',{rows:[{phone:'79990000002'}]});
 const created=C.create(1,'owner',{name:'Retries',importId:p.importId,maxAttempts:3,retryIntervalMinutes:17},'retry-controls');
 assert.equal(created.campaign.maxAttempts,3);assert.equal(created.campaign.retryIntervalMinutes,17);assert.equal(created.campaign.retryBackoffMultiplier,1);
 const e=await require('../src/services/sales-brain.service').exportOutboundCampaignForAva({campaignId:created.campaign.campaignId,syncLeads:false});
 assert.equal(e.campaign.max_attempts,3);assert.equal(e.campaign.retry_initial_delay_seconds,1020);assert.equal(e.campaign.retry_backoff_multiplier,1);assert.equal(e.campaign.retry_max_delay_seconds,1020);
 assert.equal(C.create(1,'owner',{name:'Retries',importId:p.importId,maxAttempts:3,retryIntervalMinutes:17},'retry-controls').campaign.campaignId,created.campaign.campaignId);
 assert.throws(()=>C.create(1,'owner',{name:'Retries',importId:p.importId,maxAttempts:3,retryIntervalMinutes:18},'retry-controls'),{code:'TELEPHONY_IDEMPOTENCY_CONFLICT'});
});
test('draft retry editing preserves legacy policies unless interval is explicitly changed and rejects active or foreign campaigns',()=>{
 const d=draft();DB.updateOutboundCampaign(d.campaignId,{retryPolicy:{delay_minutes:12,multiplier:3,custom:'retain'}});
 const previous=DB.getOutboundCampaign(d.campaignId).retryPolicyJson;
 assert.equal(C.details(1,d.campaignId).campaign.retryIntervalMinutes,12);
 assert.equal(C.updateRetrySettings(1,d.campaignId,{maxAttempts:4}).campaign.maxAttempts,4);
 assert.equal(DB.getOutboundCampaign(d.campaignId).retryPolicyJson,previous);
 assert.throws(()=>C.updateRetrySettings(2,d.campaignId,{maxAttempts:2}),{code:'TELEPHONY_CAMPAIGN_NOT_FOUND'});
 for(const value of [0,-1,1.5,1441,'3',null])assert.throws(()=>C.updateRetrySettings(1,d.campaignId,{retryIntervalMinutes:value}),{code:'TELEPHONY_RETRY_INTERVAL_INVALID'});
 const edited=C.updateRetrySettings(1,d.campaignId,{retryIntervalMinutes:30});assert.equal(edited.campaign.retryIntervalMinutes,30);assert.equal(edited.campaign.retryBackoffMultiplier,1);
 DB.updateOutboundCampaign(d.campaignId,{status:'running'});assert.throws(()=>C.updateRetrySettings(1,d.campaignId,{maxAttempts:2}),{code:'TELEPHONY_CAMPAIGN_STATE_CONFLICT'});
});
test('legacy pending draft creation keeps its pre-upgrade idempotency fingerprint',()=>{
 const p=C.preview(1,'owner',{rows:[{phone:'79990000002'}]});const body={name:'Legacy retry',importId:p.importId};
 const d=C.create(1,'owner',body,'legacy-idempotent').campaign;
 const canonical={name:body.name,importId:p.importId,sourceNumberId:null,timezone:'Europe/Moscow',callWindow:{start:'09:00',end:'18:00'},maxAttempts:1};
 assert.equal(DB.get('SELECT requestHash FROM ava_campaign_drafts WHERE campaignId=?',[d.campaignId]).requestHash,require('crypto').createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
 assert.equal(C.create(1,'owner',body,'legacy-idempotent').campaign.campaignId,d.campaignId);
});
