'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Identity=require('../src/services/identity/identity-store');
const Release=require('../src/services/ava-release-flags.service');
function setup(){
 createTestDB();Identity.ensureSchema();DB.createSalesWorkspaceTables();
 DB.run("INSERT INTO instances(id,name) VALUES(1,'One'),(2,'Two')");
 for(const [id,role,b] of [['owner','hotel_owner',1],['manager','manager',1],['reader','observer',1],['other','hotel_owner',2]]){
  DB.run('INSERT INTO ava_users(id,email,displayName) VALUES(?,?,?)',[id,id+'@example.test',id]);
  DB.run('INSERT INTO ava_business_memberships(userId,businessId,role) VALUES(?,?,?)',[id,b,role]);
 }
 return Object.fromEntries(['owner','manager','reader','other'].map(id=>[id,Identity.actor(id)]));
}
const reject=(fn,code)=>assert.throws(fn,e=>e.code===code);
describe('AVA per-business reversible rollout controls',()=>{
 it('uses independent business switches with CAS and fresh owner authority',()=>{
  const a=setup();assert.deepStrictEqual(Release.overview(a.reader,1).flags,{workspace:true,analytics:true,autopilot:true});
  const saved=Release.update(a.owner,1,{revision:0,flags:{workspace:false,autopilot:false}});
  assert.strictEqual(saved.revision,1);assert.strictEqual(saved.flags.analytics,true);assert.strictEqual(Release.getFlags(2).workspace,true);
  reject(()=>Release.assertEnabled(1,'workspace'),'AVA_FEATURE_DISABLED');
  reject(()=>Release.update(a.owner,1,{revision:0,flags:{workspace:true}}),'AVA_RELEASE_REVISION_CONFLICT');
  for(const auth of [a.manager,a.reader])reject(()=>Release.update(auth,1,{revision:1,flags:{workspace:true}}),'CAPABILITY_DENIED');
  reject(()=>Release.overview(a.other,1),'BUSINESS_ACCESS_DENIED');
  reject(()=>Release.update(a.owner,1,{revision:1,flags:{autopilot:'true'}}),'AVA_RELEASE_INPUT_INVALID');
  DB.run("UPDATE ava_business_memberships SET role='observer' WHERE userId='owner' AND businessId=1");
  reject(()=>Release.update(a.owner,1,{revision:1,flags:{workspace:true}}),'CAPABILITY_DENIED');
 });
 it('recovers a schema created inside a transaction that later rolls back',()=>{
  const a=setup();
  assert.throws(()=>DB.db.transaction(()=>{Release.ensureSchema();throw new Error('rollback');}).immediate(),/rollback/);
  assert.strictEqual(DB.get("SELECT name FROM sqlite_master WHERE name='ava_release_flags'"),undefined);
  assert.strictEqual(Release.overview(a.owner,1).revision,0);
  assert.strictEqual(Release.update(a.owner,1,{revision:0,flags:{workspace:false}}).flags.workspace,false);
 });
 it('honors deployment allowlists and does not permit owner bypass',()=>{
  const a=setup(),previous=process.env.AVA_WORKSPACE_BUSINESSES;
  try{process.env.AVA_WORKSPACE_BUSINESSES='2';assert.strictEqual(Release.getFlags(1).workspace,false);assert.strictEqual(Release.getFlags(2).workspace,true);
   reject(()=>Release.update(a.owner,1,{revision:0,flags:{workspace:true}}),'AVA_RELEASE_NOT_AVAILABLE');
   process.env.AVA_WORKSPACE_BUSINESSES='';assert.strictEqual(Release.getFlags(2).workspace,false);
  }finally{if(previous===undefined)delete process.env.AVA_WORKSPACE_BUSINESSES;else process.env.AVA_WORKSPACE_BUSINESSES=previous;}
 });
 it('keeps switches after a physical SQLite reopen and removes business metadata',async()=>{
  const fs=require('fs'),os=require('os'),path=require('path'),Database=require('better-sqlite3'),a=setup();
  Release.update(a.owner,1,{revision:0,flags:{analytics:false}});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ava-flags-')),file=path.join(directory,'state.sqlite'),original=DB.db;await original.backup(file);DB.db=new Database(file);
  try{assert.strictEqual(Release.overview(a.owner,1).flags.analytics,false);assert.strictEqual(Release.overview(a.owner,1).revision,1);Release.removeBusiness(1);assert.strictEqual(DB.get('SELECT COUNT(*) n FROM ava_release_flags').n,0);}
  finally{DB.db.close();DB.db=original;fs.rmSync(directory,{recursive:true,force:true});}
 });
 it('enforces mounted tenant/origin guards and disables only new feature APIs',async()=>{
  const a=setup(),express=require('express'),app=express();let actor=a.owner;app.use(express.json());app.use((req,res,next)=>{req.auth=actor;next();});
  app.use('/api',require('../src/services/identity/customer-role-boundary'));
  for(const file of ['ava-release-flags','ava-workspace','ava-analytics','ava-autopilot'])app.use('/api',require('../src/routes/'+file+'.routes'));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const origin='http://127.0.0.1:'+server.address().port,base=origin+'/api/businesses/1';
  try{
   assert.strictEqual((await fetch(base+'/release-flags')).status,200);
   const input={method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:0,flags:{workspace:false,analytics:false}})};
   assert.strictEqual((await fetch(base+'/release-flags',input)).status,403);
   const saved=await fetch(base+'/release-flags',{...input,headers:{...input.headers,Origin:origin}});assert.strictEqual(saved.status,200);
   for(const feature of ['/workspace','/search?q=hello','/promises','/saved-views','/workspace/analytics']){const response=await fetch(base+feature);assert.strictEqual(response.status,409);assert.strictEqual((await response.json()).code,'AVA_FEATURE_DISABLED');}
   assert.strictEqual((await fetch(base+'/autopilot')).status,200);
   assert.strictEqual((await fetch(base+'/release-flags?businessId=2')).status,403);
   actor=a.other;assert.strictEqual((await fetch(base+'/release-flags')).status,403);
  }finally{await new Promise(resolve=>server.close(resolve));}
 });
});
