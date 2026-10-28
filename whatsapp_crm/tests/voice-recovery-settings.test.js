'use strict';
const {describe,it,assert,createTestDB}=require('./test-helper');
const DB=require('../src/services/database.service');
const Profiles=require('../src/services/hotel-profile.service');
const Settings=require('../src/services/voice-settings.service');
const Waiting=require('../src/services/voice-waiting.service');
const Options=require('../src/services/voice-options.service');

const custom={enabled:true,phrases:['Сейчас уточню.','Проверяю информацию.'],afterSeconds:4,repeatSeconds:20,maxMessages:2};
function catalog(){return{providers:['neuro_gemini','yandex_realtime','google_live'].map(id=>{
 const value=Options.getDefaults(id);return{id,available:true,models:[{id:value.model}],voices:[{id:value.voiceName}]};
})};}
async function fixture(fn){
 createTestDB();const original=Options.getOptions;Options.getOptions=async()=>catalog();
 try{
  const a=await DB.createInstance({name:'Waiting A',businessType:'hotel'}),b=await DB.createInstance({name:'Waiting B',businessType:'hotel'});
  await Profiles.update(a.id,{voiceAiProvider:'neuro_gemini'});await Profiles.update(b.id,{voiceAiProvider:'neuro_gemini'});
  await fn({a,b});
 }finally{Options.getOptions=original;}
}
function raw(id){return DB.get('SELECT * FROM instances WHERE id=?',[id]);}

describe('Voice waiting persistence and provider concurrency',()=>{
 it('projects an independent default without writing on read or adding schema',()=>fixture(async({a,b})=>{
  const before=raw(a.id),schema=DB.all("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");
  assert.deepStrictEqual((await Profiles.get(a.id)).voiceWaiting,Waiting.normalize());
  assert.deepStrictEqual((await Profiles.get(b.id)).voiceWaiting,Waiting.normalize());
  assert.deepStrictEqual(raw(a.id),before);
  assert.deepStrictEqual(DB.all("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"),schema);
  assert.ok(!DB.all('PRAGMA table_info(instances)').some(column=>column.name==='voiceWaiting'));
 }));

 it('saves custom phrases into the current provider JSON and confirms canonical readback without changing text AI or voices',()=>fixture(async({a,b})=>{
  await DB.updateInstance(a.id,{systemPrompt:'Keep this business prompt',aiProvider:'gemini',geminiModel:'gemini-3.8-flash'});
  const before=raw(a.id),other=raw(b.id);
  await Profiles.update(a.id,{voiceWaiting:{...custom,phrases:['  Сейчас уточню.  ','Проверяю информацию.']},expectedVoiceProvider:'neuro_gemini'});
  const value=await Profiles.get(a.id),row=raw(a.id);
  assert.deepStrictEqual(value.voiceWaiting,custom);assert.deepStrictEqual(JSON.parse(row.voiceSettings).neuro_gemini.progress,custom);
  for(const field of ['voiceAiProvider','voiceModel','voiceName','aiProvider','geminiModel','systemPrompt'])assert.equal(row[field],before[field]);
  assert.deepStrictEqual(raw(b.id),other);
  assert.deepStrictEqual((await Profiles.get(b.id)).voiceWaiting,Waiting.normalize());
 }));

 it('turns phrases off and retains the custom text without fetching a provider catalogue',()=>fixture(async({a})=>{
  await Profiles.update(a.id,{voiceWaiting:custom,expectedVoiceProvider:'neuro_gemini'});
  const previous=Options.getOptions;Options.getOptions=async()=>{throw Error('No remote lookup for a local phrase change');};
  try{
   await Profiles.update(a.id,{voiceWaiting:{...custom,enabled:false},expectedVoiceProvider:'neuro_gemini'});
   assert.deepStrictEqual((await Profiles.get(a.id)).voiceWaiting,{...custom,enabled:false});
  }finally{Options.getOptions=previous;}
 }));

 it('keeps independent waiting preferences for each provider and restores them when switching back',()=>fixture(async({a})=>{
  await Profiles.update(a.id,{voiceWaiting:custom,expectedVoiceProvider:'neuro_gemini'});
  const neuro=await Profiles.get(a.id);
  await Profiles.update(a.id,{voiceAiProvider:'yandex_realtime'});
  assert.deepStrictEqual((await Profiles.get(a.id)).voiceWaiting,Waiting.normalize());
  const yandex={...custom,enabled:false,phrases:['Уточняю.'],maxMessages:1};
  await Profiles.update(a.id,{voiceWaiting:yandex,expectedVoiceProvider:'yandex_realtime'});
  await Profiles.update(a.id,{voiceAiProvider:'neuro_gemini'});
  const returned=await Profiles.get(a.id);
  assert.deepStrictEqual(returned.voiceWaiting,custom);assert.equal(returned.voiceModel,neuro.voiceModel);assert.equal(returned.voiceName,neuro.voiceName);
  await Profiles.update(a.id,{voiceAiProvider:'yandex_realtime'});
  assert.deepStrictEqual((await Profiles.get(a.id)).voiceWaiting,yandex);
 }));

 it('rejects invalid waiting input and a caller-supplied provider map without altering saved selections',()=>fixture(async({a})=>{
  await Profiles.update(a.id,{voiceWaiting:custom,expectedVoiceProvider:'neuro_gemini'});const before=raw(a.id);
  for(const value of [{...custom,phrases:[]},{...custom,phrases:['x'.repeat(161)]},{...custom,phrases:['bad\nphrase']},{...custom,maxMessages:3},{...custom,afterSeconds:0},{...custom,repeatSeconds:61},{...custom,enabled:'true'},{...custom,extra:true}]){
   await assert.rejects(()=>Profiles.update(a.id,{voiceWaiting:value,expectedVoiceProvider:'neuro_gemini'}),error=>error.code==='INVALID_VOICE_WAITING');
   assert.deepStrictEqual(raw(a.id),before);
  }
  await assert.rejects(()=>DB.updateInstance(a.id,{voiceSettings:{neuro_gemini:{progress:custom}}}),error=>error.code==='VOICE_SETTINGS_READ_ONLY');
  assert.deepStrictEqual(raw(a.id),before);
 }));

 it('rejects stale expected provider and leaves both provider maps intact',()=>fixture(async({a})=>{
  await Profiles.update(a.id,{voiceWaiting:custom,expectedVoiceProvider:'neuro_gemini'});
  await Profiles.update(a.id,{voiceAiProvider:'yandex_realtime'});const before=raw(a.id);
  await assert.rejects(()=>Profiles.update(a.id,{voiceWaiting:{...custom,enabled:false},expectedVoiceProvider:'neuro_gemini'}),error=>error.code==='VOICE_SETTINGS_CHANGED'&&error.statusCode===409);
  assert.deepStrictEqual(raw(a.id),before);
 }));

 it('rechecks a provider switch that commits after preparation and before the final SQLite transaction',()=>fixture(async({a})=>{
  const prepare=Settings.prepareWrite;let switched=false;
  Settings.prepareWrite=async(...args)=>{
   const result=await prepare(...args);
   if(!switched){switched=true;const defaults=Options.getDefaults('yandex_realtime');DB.run('UPDATE instances SET voiceAiProvider=?,voiceModel=?,voiceName=? WHERE id=?',['yandex_realtime',defaults.model,defaults.voiceName,a.id]);}
   return result;
  };
  try{
   await assert.rejects(()=>Profiles.update(a.id,{voiceWaiting:custom,expectedVoiceProvider:'neuro_gemini'}),error=>error.code==='VOICE_SETTINGS_CHANGED');
   assert.equal((await Profiles.get(a.id)).voiceAiProvider,'yandex_realtime');
   assert.ok(!JSON.parse(raw(a.id).voiceSettings).neuro_gemini.progress);
  }finally{Settings.prepareWrite=prepare;}
 }));

 it('real HTTP allows owner save/readback, manager read only and rejects a foreign business',()=>fixture(async({a,b})=>{
  const Identity=require('../src/services/identity/identity-store'),Auth=require('../src/services/auth.service'),express=require('express');
  Identity.ensureSchema();
  DB.run("INSERT INTO ava_users(id,email,displayName) VALUES('waiting-owner','waiting-owner@example.test','Owner'),('waiting-manager','waiting-manager@example.test','Manager')");
  DB.run("INSERT INTO ava_business_memberships(userId,businessId,role) VALUES('waiting-owner',?,'hotel_owner'),('waiting-manager',?,'manager')",[a.id,a.id]);
  const sessions={owner:Identity.actor('waiting-owner'),manager:Identity.actor('waiting-manager')},previous=Auth.getSession,oldUrl=process.env.WHATSAPP_CRM_PUBLIC_URL;
  process.env.WHATSAPP_CRM_PUBLIC_URL='https://ava.example.test';Auth.getSession=req=>sessions[req.get('x-test-actor')]||null;
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.auth=Auth.getSession(req);next();});app.use('/api',require('../src/routes/api.routes'));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const request=async(id,actor,method='GET')=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/hotel-profiles/${id}`,{method,headers:{origin:'https://ava.example.test','x-test-actor':actor,'content-type':'application/json'},...(method==='PUT'?{body:JSON.stringify({voiceWaiting:custom,expectedVoiceProvider:'neuro_gemini'})}:{})});return{status:response.status,body:await response.json()};};
  try{
   assert.equal((await request(a.id,'owner','PUT')).status,200);
   assert.deepStrictEqual((await Profiles.get(a.id)).voiceWaiting,custom,'HTTP customer write must reach canonical SQLite settings');
   assert.deepStrictEqual((await request(a.id,'owner')).body.profile.voiceWaiting,custom);
   assert.equal((await request(a.id,'manager')).status,200);assert.equal((await request(a.id,'manager','PUT')).status,403);
   assert.equal((await request(b.id,'owner')).status,403);assert.equal((await request(b.id,'owner','PUT')).status,403);
   assert.deepStrictEqual((await Profiles.get(b.id)).voiceWaiting,Waiting.normalize());
   await Profiles.update(a.id,{voiceAiProvider:'yandex_realtime'});const before=raw(a.id);
   assert.equal((await request(a.id,'owner','PUT')).status,409,'HTTP must retain expectedVoiceProvider for the concurrency check');
   assert.deepStrictEqual(raw(a.id),before);
  }finally{await new Promise(resolve=>server.close(resolve));Auth.getSession=previous;if(oldUrl===undefined)delete process.env.WHATSAPP_CRM_PUBLIC_URL;else process.env.WHATSAPP_CRM_PUBLIC_URL=oldUrl;}
 }));
});
