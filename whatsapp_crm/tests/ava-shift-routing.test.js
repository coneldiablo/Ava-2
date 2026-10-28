'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Identity=require('../src/services/identity/identity-store');
const Store=require('../src/services/ava-autopilot.store');
const Workspace=require('../src/services/ava-workspace.store');
const Canonical=require('../src/services/client-identity.service');
const Service=require('../src/services/ava-autopilot.service');
const Availability=require('../src/services/ava-availability.service');
const Module=require('module');

// The feature service belongs to integration. Exercise its specified interface
// without adding or changing a coordinator-owned module in this feature branch.
function flags(enabled,fn){const original=Module._load;Module._load=function(request,...args){
 if(request.endsWith('/ava-improvements-flags.service'))return {snapshot:()=>({flags:{shifts:enabled}}),assertEnabled:()=>{if(!enabled)throw Object.assign(new Error('AVA_FEATURE_DISABLED'),{code:'AVA_FEATURE_DISABLED',statusCode:409});}};
 return original.call(this,request,...args);
 };return Promise.resolve().then(fn).finally(()=>{Module._load=original;});}
function setup(){
 createTestDB();Identity.ensureSchema();DB.createSalesWorkspaceTables();
 DB.run("INSERT INTO instances(id,name,isActive) VALUES(1,'One',1),(2,'Two',1)");
 for(const [id,b] of [['manager',1],['owner',1],['foreign',2]]){
  DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)',[id,id+'@example.test',id]);
  DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)',[id,b,id==='owner'?'hotel_owner':'manager']);
 }
 DB.run("INSERT INTO clients(instanceId,chatId,senderName) VALUES(1,'first','First'),(1,'second','Second'),(2,'first','Foreign')");
 Store.ensureSchema();Workspace.ensureSchema();Availability.ensureSchema();
 const policy={id:'p',revision:1,state:'published',enabled:true,activated:true,timezone:'UTC',workDays:[1,2,3,4,5,6,7],workHours:{start:'00:00',end:'00:00'},routing:{enabled:true,memberIds:['manager']}};
 Store.savePolicy(1,policy,'owner',0);return {policy,owner:Identity.actor('owner'),manager:Identity.actor('manager')};
}
function configured(a,id,status='available',capacity=null){Availability.patch(a.owner,1,id,{revision:0,status,capacity});}
function assignment(chat='first',b=1){return DB.get('SELECT assigneeUserId FROM clients WHERE instanceId=? AND chatId=?',[b,chat]).assigneeUserId;}

describe('AVA shift routing atomic assignment and delivery fences',()=>{
 it('honors actual tenant allowlist and persisted shifts toggle without changing legacy routing',()=>{
  const a=setup(),Flags=require('../src/services/ava-improvements-flags.service');
  const previous=process.env.AVA_IMPROVEMENTS_BUSINESSES;
  try{
   delete process.env.AVA_IMPROVEMENTS_BUSINESSES;
   assert.strictEqual(Availability.routingAvailability(1).configured,false);
   assert.strictEqual(Service.routeCustomer(1,'first',a.policy),'manager');
   DB.run("UPDATE clients SET assigneeUserId=NULL WHERE instanceId=1 AND chatId='first'");
   process.env.AVA_IMPROVEMENTS_BUSINESSES='1';configured(a,'manager','off',1);
   assert.deepStrictEqual(Availability.routingAvailability(1).eligibleUserIds,[]);
   assert.strictEqual(Service.routeCustomer(1,'first',a.policy),null);
   const flag=Flags.snapshot(1);Flags.update(a.owner,1,{revision:flag.revision,flags:{shifts:false}});
   assert.strictEqual(Service.routeCustomer(1,'first',a.policy),'manager');
   assert.strictEqual(Availability.routingAvailability(2).configured,false);
  }finally{if(previous===undefined)delete process.env.AVA_IMPROVEMENTS_BUSINESSES;else process.env.AVA_IMPROVEMENTS_BUSINESSES=previous;}
 });
 it('preserves legacy distribution when feature is off even with persisted break/capacity',()=>flags(true,()=>{
  const a=setup();configured(a,'manager','break',1);
  return flags(false,()=>{assert.strictEqual(Service.routeCustomer(1,'first',a.policy),'manager');assert.strictEqual(Service.routeCustomer(1,'second',a.policy),'manager');});
 }));
 it('keeps unconfigured members eligible outside configured published hours without presence',()=>flags(true,()=>{
  const a=setup();const p={...a.policy,revision:2,workDays:[1],workHours:{start:'09:00',end:'10:00'}};Store.savePolicy(1,p,'owner',1);
  assert.strictEqual(Availability.routingSnapshot(1,{now:new Date('2026-10-06T12:00:00Z')}).eligibleMembers[0].userId,'manager');
  assert.strictEqual(Service.routeCustomer(1,'first',a.policy),'manager');
 }));
 it('counts active null-status clients, excludes completed clients, and leaves overflow in common queue',()=>flags(true,()=>{
  const a=setup();configured(a,'manager','available',1);
  DB.run("INSERT INTO clients(instanceId,chatId,senderName,assigneeUserId,leadStatus) VALUES(1,'done','Done','manager','won'),(2,'load','Foreign','manager','new')");
  DB.run("UPDATE clients SET leadStatus=NULL WHERE instanceId=1 AND chatId='first'");
  assert.strictEqual(Service.routeCustomer(1,'first',a.policy),'manager');
  assert.strictEqual(Service.routeCustomer(1,'second',a.policy),null);assert.strictEqual(assignment('second'),null);
  assert.strictEqual(Availability.routingSnapshot(1).members.find(m=>m.userId==='manager').currentLoad,1);
 }));
 it('preserves active assignee on break or at capacity, and routes stale removed assignee only to live members',()=>flags(true,()=>{
  const a=setup();configured(a,'manager','off',1);DB.run("UPDATE clients SET assigneeUserId='manager' WHERE instanceId=1 AND chatId='first'");
  assert.strictEqual(Service.routeCustomer(1,'first',a.policy),'manager');
  DB.run("UPDATE ava_business_memberships SET enabled=0 WHERE userId='manager'");
  const p={...a.policy,revision:2,routing:{enabled:true,memberIds:['manager','owner']}};Store.savePolicy(1,p,'owner',1);
  assert.strictEqual(Service.routeCustomer(1,'first',p),'owner');
 }));
 it('fences active send slot and uncertain autopilot or human reply without changing a stale assignee',()=>flags(true,()=>{
  const a=setup();DB.run("UPDATE clients SET assigneeUserId='foreign' WHERE instanceId=1 AND chatId='first'");
  const control=Workspace.getControl(1,'first');Workspace.beginAiSend({businessId:1,chatId:'first',revision:control.revision,sendId:'sending'});
  assert.strictEqual(Service.routeCustomer(1,'first',a.policy),null);assert.strictEqual(assignment(),'foreign');
  Workspace.endAiSend({businessId:1,chatId:'first',sendId:'sending',status:'sent'});
  const claim=Store.claim({businessId:1,chatId:'first',eventId:'event',kind:'reply'});Store.updateAction(1,claim.action.id,'unknown');
  assert.strictEqual(Service.routeCustomer(1,'first',a.policy),null);assert.strictEqual(assignment(),'foreign');
  Store.updateAction(1,claim.action.id,'failed');
  DB.run("INSERT INTO ava_workspace_reply_actions(id,businessId,chatId,userId,idempotencyKey,textHash,controlRevision,status,createdAt,updatedAt) VALUES('reply',1,'first','owner','key','hash',1,'unknown',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)");
  assert.strictEqual(Service.routeCustomer(1,'first',a.policy),null);assert.strictEqual(assignment(),'foreign');
 }));
 it('fences uncertain followup metadata and linked task drafts, with exact tenant scope',()=>flags(true,()=>{
  const a=setup();DB.run("INSERT INTO followup_drafts(draftId,instanceId,chatId,status,metadataJson) VALUES('foreign',2,'first','unknown','{}')");
  DB.run("INSERT INTO manager_tasks(taskId,instanceId,chatId,summary) VALUES('task',1,'first','Task')");
  DB.run("INSERT INTO followup_drafts(draftId,instanceId,managerTaskId,status,metadataJson) VALUES('local',1,'task','draft','{\"provider_status\":\"unknown_pending\"}')");
  assert.strictEqual(Service.routeCustomer(1,'first',a.policy),null);assert.strictEqual(assignment(),null);
  DB.run("UPDATE followup_drafts SET metadataJson='{}' WHERE draftId='local'");
  assert.strictEqual(Service.routeCustomer(1,'first',a.policy),'manager');assert.strictEqual(assignment('first',2),null);
 }));
 it('uses canonical aliases and deduplicates assignment/load on repeated routing',()=>flags(true,()=>{
  const a=setup();configured(a,'manager','available',1);Canonical.resolve(1,'first');
  DB.run("INSERT INTO client_aliases(instanceId,chatId,kind,value) VALUES(1,'first','telegram','1234')");
  assert.strictEqual(Service.routeCustomer(1,'tg_1234',a.policy),'manager');
  assert.strictEqual(Service.routeCustomer(1,'first',a.policy),'manager');
  assert.strictEqual(Service.routeCustomer(1,'second',a.policy),null);
 }));
 it('ignores a stale published argument after the live policy is paused or drafted',()=>flags(true,()=>{
  const a=setup();Store.savePolicy(1,{...a.policy,revision:2,state:'paused',enabled:false},'owner',1);
  assert.strictEqual(Service.routeCustomer(1,'first',a.policy),null);assert.strictEqual(assignment(),null);
  Store.savePolicy(1,{...a.policy,revision:3,state:'draft'},'owner',2);
  assert.strictEqual(Service.routeCustomer(1,'first',a.policy),null);assert.strictEqual(assignment(),null);
 }));
 it('uses the same published overnight weekday and timezone gate for autopilot and configured routing',()=>flags(true,()=>{
  const a=setup();configured(a,'manager');
  const p={...a.policy,revision:2,timezone:'Europe/Moscow',workDays:[1],workHours:{start:'22:00',end:'02:00'}};
  Store.savePolicy(1,p,'owner',1);
  for(const [instant,expected] of [['2026-10-05T19:00:00Z',true],['2026-10-05T22:00:00Z',true],['2026-10-05T23:00:00Z',false],['2026-10-04T22:00:00Z',false]]){
   const now=new Date(instant);assert.strictEqual(Service.inHours(p,now),expected);
   const snapshot=Availability.routingSnapshot(1,{now});assert.strictEqual(snapshot.withinHours,expected);
   assert.strictEqual(snapshot.eligibleMembers.length,expected?1:0);
  }
 }));
 it('serializes competing processes against one physical last capacity slot',()=>flags(true,async()=>{
  const a=setup();configured(a,'manager','available',1);
  const fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ava-shift-race-')),file=path.join(dir,'state.sqlite');
  await DB.db.backup(file);const children=[];
  const script=`const Module=require('module'),load=Module._load;Module._load=function(request,...args){if(request.endsWith('/ava-improvements-flags.service'))return {snapshot:()=>({flags:{shifts:true}})};return load.call(this,request,...args)};const DB=require('./src/services/database.service');DB.db=new(require('better-sqlite3'))(process.argv[1]);DB.db.pragma('busy_timeout = 10000');DB.db.pragma('foreign_keys = ON');const Service=require('./src/services/ava-autopilot.service'),Store=require('./src/services/ava-autopilot.store');process.send('ready');process.on('message',()=>{try{const result=Service.routeCustomer(1,process.argv[2],Store.policy(1));process.send({result});DB.db.close();process.exit(0)}catch(error){process.send({error:error.code||error.message});process.exit(1)}});`;
  try{
   const ready=[];const results=[];
   for(const chat of ['first','second']){
    const child=spawn(process.execPath,['-e',script,file,chat],{cwd:path.join(__dirname,'..'),env:process.env,stdio:['ignore','ignore','pipe','ipc']});children.push(child);
    ready.push(new Promise((resolve,reject)=>{child.on('message',v=>{if(v==='ready')resolve();});child.on('error',reject);child.on('exit',n=>{if(n)reject(new Error('routing child exit '+n));});}));
    results.push(new Promise((resolve,reject)=>{child.on('message',v=>{if(v&&Object.hasOwn(v,'result'))resolve(v.result);else if(v?.error)reject(new Error(v.error));});child.on('error',reject);child.on('exit',n=>{if(n)reject(new Error('routing child exit '+n));});}));
   }
   await Promise.all(ready);children.forEach(c=>c.send('go'));const assigned=await Promise.all(results);
   assert.deepStrictEqual(assigned.sort((x,y)=>String(x).localeCompare(String(y))),['manager',null].sort((x,y)=>String(x).localeCompare(String(y))));
   const persisted=new(require('better-sqlite3'))(file);try{assert.strictEqual(persisted.prepare("SELECT COUNT(*) n FROM clients WHERE instanceId=1 AND assigneeUserId='manager'").get().n,1);}finally{persisted.close();}
  }finally{children.forEach(c=>{if(c.exitCode===null)c.kill();});fs.rmSync(dir,{recursive:true,force:true});}
 }));
});
