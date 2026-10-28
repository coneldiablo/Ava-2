'use strict';
const {randomUUID}=require('crypto');
const DB=require('./database.service');
const initialized=new WeakSet();
function ensureSchema(){
 if(!DB.db?.open) throw Object.assign(new Error('AUTOPILOT_UNAVAILABLE'),{code:'AUTOPILOT_UNAVAILABLE',statusCode:503});
 if(initialized.has(DB.db)) return;
 DB.db.exec(`
 CREATE TABLE IF NOT EXISTS ava_autopilot_policies(businessId INTEGER PRIMARY KEY,revision INTEGER NOT NULL,payloadJson TEXT NOT NULL,ownerUserId TEXT NOT NULL,updatedAt TEXT NOT NULL,FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ava_autopilot_policy_versions(businessId INTEGER NOT NULL,revision INTEGER NOT NULL,payloadJson TEXT NOT NULL,createdAt TEXT NOT NULL,PRIMARY KEY(businessId,revision),FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ava_catalog_offers(id TEXT PRIMARY KEY,businessId INTEGER NOT NULL,revision INTEGER NOT NULL,payloadJson TEXT NOT NULL,createdAt TEXT NOT NULL,FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE);
 CREATE INDEX IF NOT EXISTS ava_catalog_scope ON ava_catalog_offers(businessId);
 CREATE TABLE IF NOT EXISTS ava_catalog_versions(businessId INTEGER NOT NULL,offerId TEXT NOT NULL,revision INTEGER NOT NULL,payloadJson TEXT NOT NULL,publishedAt TEXT NOT NULL,PRIMARY KEY(businessId,offerId,revision),FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ava_quotes(id TEXT PRIMARY KEY,businessId INTEGER NOT NULL,chatId TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,payloadJson TEXT NOT NULL,createdAt TEXT NOT NULL,FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE);
 CREATE INDEX IF NOT EXISTS ava_quotes_scope ON ava_quotes(businessId,chatId);
 CREATE TABLE IF NOT EXISTS ava_autopilot_simulations(id TEXT PRIMARY KEY,businessId INTEGER NOT NULL,policyRevision INTEGER NOT NULL,fingerprint TEXT NOT NULL,payloadJson TEXT NOT NULL,createdAt TEXT NOT NULL,FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ava_autopilot_actions(id TEXT PRIMARY KEY,businessId INTEGER NOT NULL,chatId TEXT NOT NULL,eventId TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,policyRevision INTEGER,controlRevision INTEGER,quoteId TEXT,payloadJson TEXT NOT NULL DEFAULT '{}',providerStarted INTEGER NOT NULL DEFAULT 0,leaseToken TEXT,leaseUntil INTEGER NOT NULL DEFAULT 0,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,UNIQUE(businessId,eventId),FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE);
 CREATE INDEX IF NOT EXISTS ava_autopilot_action_scope ON ava_autopilot_actions(businessId,chatId,status);
 CREATE TABLE IF NOT EXISTS ava_voice_admissions(businessId INTEGER NOT NULL,callId TEXT NOT NULL,chatId TEXT NOT NULL,policyRevision INTEGER NOT NULL,createdAt TEXT NOT NULL,endedAt TEXT,PRIMARY KEY(businessId,callId),FOREIGN KEY(businessId,chatId) REFERENCES clients(instanceId,chatId) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ava_autopilot_usage(id TEXT PRIMARY KEY,businessId INTEGER NOT NULL,eventId TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 0,tokens INTEGER,voiceSeconds REAL NOT NULL DEFAULT 0,voiceKnown INTEGER NOT NULL DEFAULT 1,actions INTEGER NOT NULL DEFAULT 0,handovers INTEGER NOT NULL DEFAULT 0,costMinor INTEGER,currency TEXT NOT NULL DEFAULT 'RUB',createdAt TEXT NOT NULL,UNIQUE(businessId,eventId),FOREIGN KEY(businessId) REFERENCES instances(id) ON DELETE CASCADE);
 CREATE INDEX IF NOT EXISTS ava_autopilot_usage_scope ON ava_autopilot_usage(businessId,createdAt);
 `);
 for(const [name,definition] of [['leaseToken','TEXT'],['leaseUntil','INTEGER NOT NULL DEFAULT 0']])if(!DB.all('PRAGMA table_info(ava_autopilot_actions)').some(c=>c.name===name))DB.db.exec(`ALTER TABLE ava_autopilot_actions ADD COLUMN ${name} ${definition}`);
 if(!DB.all('PRAGMA table_info(ava_autopilot_usage)').some(c=>c.name==='voiceKnown'))DB.db.exec('ALTER TABLE ava_autopilot_usage ADD COLUMN voiceKnown INTEGER NOT NULL DEFAULT 1');
 initialized.add(DB.db);
}
const decode=r=>r?JSON.parse(r.payloadJson):null;
function policy(b){ensureSchema();return decode(DB.get('SELECT payloadJson FROM ava_autopilot_policies WHERE businessId=?',[b]));}
function policyOwner(b){ensureSchema();return DB.get('SELECT ownerUserId FROM ava_autopilot_policies WHERE businessId=?',[b])?.ownerUserId;}
function savePolicy(b,p,owner,expected){ensureSchema();return DB.db.transaction(()=>{
 const previous=policy(b);if((previous?.revision||0)!==expected) fail('AUTOPILOT_REVISION_CONFLICT',409);
 DB.run('INSERT INTO ava_autopilot_policies(businessId,revision,payloadJson,ownerUserId,updatedAt) VALUES(?,?,?,?,?) ON CONFLICT(businessId) DO UPDATE SET revision=excluded.revision,payloadJson=excluded.payloadJson,ownerUserId=excluded.ownerUserId,updatedAt=excluded.updatedAt',[b,p.revision,JSON.stringify(p),owner,new Date().toISOString()]);
 DB.run('INSERT INTO ava_autopilot_policy_versions VALUES(?,?,?,?) ON CONFLICT(businessId,revision) DO UPDATE SET payloadJson=excluded.payloadJson',[b,p.revision,JSON.stringify(p),new Date().toISOString()]);return p;
}).immediate();}
function offers(b){ensureSchema();return DB.all('SELECT payloadJson FROM ava_catalog_offers WHERE businessId=? ORDER BY createdAt,id',[b]).map(decode);}
function offer(b,id){ensureSchema();return decode(DB.get('SELECT payloadJson FROM ava_catalog_offers WHERE businessId=? AND id=?',[b,id]));}
function saveOffer(b,o,expected=null){ensureSchema();return DB.db.transaction(()=>{
 const prev=offer(b,o.id);if(expected!==null&&prev?.revision!==expected)fail('AUTOPILOT_REVISION_CONFLICT',409);
 DB.run('INSERT INTO ava_catalog_offers VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payloadJson=excluded.payloadJson',[o.id,b,o.revision,JSON.stringify(o),o.createdAt||new Date().toISOString()]);return o;
}).immediate();}
function publishOffer(b,o){return DB.db.transaction(()=>{saveOffer(b,o,o.revision);DB.run('INSERT INTO ava_catalog_versions VALUES(?,?,?,?,?) ON CONFLICT(businessId,offerId,revision) DO NOTHING',[b,o.id,o.revision,JSON.stringify(o),o.publishedAt]);return o;}).immediate();}
function publishedOffers(b){return offers(b).filter(o=>o.publishedAt&&o.active);}
function quote(b,id){ensureSchema();return decode(DB.get('SELECT payloadJson FROM ava_quotes WHERE businessId=? AND id=?',[b,id]));}
function quotes(b,chatId){ensureSchema();return DB.all('SELECT payloadJson FROM ava_quotes WHERE businessId=? AND chatId=? ORDER BY createdAt DESC,id LIMIT 100',[b,chatId]).map(decode);}
function saveQuote(b,q,expected=null){ensureSchema();return DB.db.transaction(()=>{
 const previous=quote(b,q.id);if(expected!==null&&previous?.revision!==expected)fail('AUTOPILOT_REVISION_CONFLICT',409);
 DB.run('INSERT INTO ava_quotes VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status,payloadJson=excluded.payloadJson',[q.id,b,q.chatId,q.revision,q.status,JSON.stringify(q),q.createdAt]);return q;
}).immediate();}
function simulation(b,id){ensureSchema();return decode(DB.get('SELECT payloadJson FROM ava_autopilot_simulations WHERE businessId=? AND id=?',[b,id]));}
function latestSimulation(b){ensureSchema();return decode(DB.get('SELECT payloadJson FROM ava_autopilot_simulations WHERE businessId=? ORDER BY createdAt DESC,id LIMIT 1',[b]));}
function saveSimulation(b,s,fingerprint){ensureSchema();DB.run('INSERT INTO ava_autopilot_simulations VALUES(?,?,?,?,?,?)',[s.id,b,s.policyRevision,fingerprint,JSON.stringify({...s,fingerprint}),s.createdAt]);return s;}
function actionView(r){if(!r)return null;const meta=decode(r)||{};return {id:r.id,chatId:r.chatId,eventId:r.eventId,kind:r.kind,status:r.status,policyRevision:r.policyRevision,controlRevision:r.controlRevision,quoteId:r.quoteId,createdAt:r.createdAt,updatedAt:r.updatedAt,...meta};}
function action(b,id){ensureSchema();return actionView(DB.get('SELECT * FROM ava_autopilot_actions WHERE businessId=? AND id=?',[b,id]));}
function actionForEvent(b,event){ensureSchema();return actionView(DB.get('SELECT * FROM ava_autopilot_actions WHERE businessId=? AND eventId=?',[b,event]));}
function actions(b){ensureSchema();return DB.all('SELECT * FROM ava_autopilot_actions WHERE businessId=? ORDER BY createdAt DESC,id LIMIT 100',[b]).map(actionView);}
function retryable(b,id){ensureSchema();return Boolean(DB.get("SELECT 1 FROM ava_autopilot_actions WHERE businessId=? AND id=? AND status='claimed' AND providerStarted=0 AND leaseUntil<?",[b,id,Date.now()]));}
function claim({businessId,chatId,eventId,kind,policyRevision,controlRevision,quoteId=null,details={}}){
 ensureSchema();return DB.db.transaction(()=>{
  const id=randomUUID(),token=randomUUID(),now=new Date().toISOString(),until=Date.now()+120000;
  const r=DB.run('INSERT INTO ava_autopilot_actions(id,businessId,chatId,eventId,kind,status,policyRevision,controlRevision,quoteId,payloadJson,providerStarted,leaseToken,leaseUntil,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(businessId,eventId) DO NOTHING',[id,businessId,chatId,eventId,kind,'claimed',policyRevision??null,controlRevision??null,quoteId,JSON.stringify(details),0,token,until,now,now]);
  let claimed=r.changes===1;
  if(!claimed){const existing=actionForEvent(businessId,eventId);if(existing?.chatId===chatId&&retryable(businessId,existing.id)){const change=DB.run("UPDATE ava_autopilot_actions SET leaseToken=?,leaseUntil=?,kind=?,policyRevision=?,controlRevision=?,payloadJson=?,updatedAt=? WHERE businessId=? AND id=? AND status='claimed' AND providerStarted=0 AND leaseUntil<?",[token,until,kind,policyRevision??null,controlRevision??null,JSON.stringify(details),now,businessId,existing.id,Date.now()]);claimed=change.changes===1;}}
  return {claimed,claimToken:claimed?token:null,action:actionForEvent(businessId,eventId)};
 }).immediate();
}
function assertClaim(b,id,token){ensureSchema();if(!DB.get("SELECT 1 FROM ava_autopilot_actions WHERE businessId=? AND id=? AND status='claimed' AND leaseToken=? AND leaseUntil>=? AND providerStarted=0",[b,id,token,Date.now()]))fail('AUTOPILOT_ACTION_CLAIM_LOST',409);}
function updateAction(b,id,status,details={}){const previous=action(b,id);if(!previous)fail('AUTOPILOT_ACTION_NOT_FOUND',404);const {id:_,chatId,eventId,kind,policyRevision,controlRevision,quoteId,status:oldStatus,createdAt,updatedAt,...meta}=previous;DB.run('UPDATE ava_autopilot_actions SET status=?,payloadJson=?,updatedAt=? WHERE businessId=? AND id=?',[status,JSON.stringify({...meta,...details}),new Date().toISOString(),b,id]);return action(b,id);}
function markSending(b,id,token){return DB.db.transaction(()=>{const row=DB.get('SELECT * FROM ava_autopilot_actions WHERE businessId=? AND id=?',[b,id]);if(!row||row.status!=='claimed'||token&&row.leaseToken!==token||row.leaseUntil<Date.now())fail('AUTOPILOT_ACTION_CLAIM_LOST',409);DB.run("UPDATE ava_autopilot_actions SET status='sending',providerStarted=1,updatedAt=? WHERE businessId=? AND id=?",[new Date().toISOString(),b,id]);}).immediate();}
function pendingCustomer(b,chat){ensureSchema();return Boolean(DB.get("SELECT 1 FROM ava_autopilot_actions WHERE businessId=? AND chatId=? AND status IN ('sending','unknown')",[b,chat]));}
function recordUsage(b,event,input={}){ensureSchema();const n=(x)=>Number.isFinite(Number(x))&&Number(x)>=0?Number(x):0;const tokens=input.tokens==null?null:n(input.tokens);DB.run('INSERT INTO ava_autopilot_usage(id,businessId,eventId,requests,tokens,voiceSeconds,actions,handovers,costMinor,currency,createdAt,voiceKnown) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(businessId,eventId) DO UPDATE SET handovers=MAX(ava_autopilot_usage.handovers,excluded.handovers)',[randomUUID(),b,event,n(input.requests),tokens,n(input.voiceSeconds),n(input.actions),n(input.handovers),input.costMinor==null?null:n(input.costMinor),input.currency||'RUB',input.timestamp||new Date().toISOString(),Object.hasOwn(input,'voiceSeconds')&&input.voiceSeconds===null?0:1]);}
function periodStart(timezone='Europe/Moscow',now=new Date()){const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});const parts=Object.fromEntries(fmt.formatToParts(now).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return `${parts.year}-${parts.month}-${parts.day}`;}
function usage(b,timezone='Europe/Moscow',now=new Date()){
 ensureSchema();const day=periodStart(timezone,now);const rows=DB.all('SELECT * FROM ava_autopilot_usage WHERE businessId=? AND createdAt>=?',[b,new Date(now.getTime()-48*3600*1000).toISOString()]).filter(r=>periodStart(timezone,new Date(r.createdAt))===day);
 const sum=k=>rows.reduce((n,r)=>n+(r[k]||0),0),costRows=rows.filter(r=>r.costMinor!=null);return {requests:sum('requests'),tokens:rows.some(r=>r.tokens==null)?null:sum('tokens'),voiceSeconds:rows.some(r=>!r.voiceKnown)?null:sum('voiceSeconds'),estimatedCost:costRows.length===rows.length&&rows.length?sum('costMinor')/100:null,currency:'RUB',actions:sum('actions'),handovers:sum('handovers'),periodStart:day};
}
function messagesUsed(b,tz){const day=periodStart(tz);return DB.all("SELECT createdAt FROM ava_autopilot_actions WHERE businessId=? AND kind IN ('reply','quote') AND status IN ('claimed','sending','sent','unknown') AND createdAt>=?",[b,new Date(Date.now()-48*3600*1000).toISOString()]).filter(r=>periodStart(tz,new Date(r.createdAt))===day).length;}
function guardCustomer(b,chat){if(pendingCustomer(b,chat))fail('AUTOPILOT_DELIVERY_PENDING',409);}
function unlinkClient(b,chat){ensureSchema();guardCustomer(b,chat);for(const t of ['ava_quotes','ava_autopilot_actions'])DB.run(`DELETE FROM ${t} WHERE businessId=? AND chatId=?`,[b,chat]);}
function removeBusiness(b){ensureSchema();if(DB.get("SELECT 1 FROM ava_autopilot_actions WHERE businessId=? AND status IN ('sending','unknown')",[b]))fail('AUTOPILOT_DELIVERY_PENDING',409);for(const t of ['ava_autopilot_policies','ava_autopilot_policy_versions','ava_catalog_offers','ava_catalog_versions','ava_quotes','ava_autopilot_simulations','ava_autopilot_actions','ava_autopilot_usage','ava_voice_admissions'])DB.run(`DELETE FROM ${t} WHERE businessId=?`,[b]);}
function mergeClient(b,from,to){ensureSchema();if(!DB.db.inTransaction)fail('AUTOPILOT_TRANSACTION_REQUIRED',503);guardCustomer(b,from);guardCustomer(b,to);for(const q of DB.all('SELECT payloadJson FROM ava_quotes WHERE businessId=? AND chatId=?',[b,from]).map(decode))saveQuote(b,{...q,chatId:to},q.revision);DB.run('UPDATE ava_autopilot_actions SET chatId=? WHERE businessId=? AND chatId=?',[to,b,from]);DB.run('UPDATE ava_voice_admissions SET chatId=? WHERE businessId=? AND chatId=?',[to,b,from]);}
function cleanupMember(b,userId){ensureSchema();const p=policy(b);if(!p)return;const routing={...p.routing,memberIds:p.routing.memberIds.filter(id=>id!==userId)};routing.enabled=routing.enabled&&routing.memberIds.length>0;if(policyOwner(b)===userId||routing.memberIds.length!==p.routing.memberIds.length)savePolicy(b,{...p,routing,state:'paused',enabled:false,revision:p.revision+1},policyOwner(b),p.revision);}
function version(b,r){ensureSchema();return decode(DB.get('SELECT payloadJson FROM ava_autopilot_policy_versions WHERE businessId=? AND revision=?',[b,r]));}
function fail(code,statusCode=400){throw Object.assign(new Error(code),{code,statusCode});}
module.exports={assertClaim,retryable,unlinkClient,removeBusiness,mergeClient,cleanupMember,version,ensureSchema,policy,policyOwner,savePolicy,offers,offer,saveOffer,publishOffer,publishedOffers,quote,quotes,saveQuote,simulation,latestSimulation,saveSimulation,actions,action,actionForEvent,claim,updateAction,markSending,pendingCustomer,recordUsage,usage,periodStart,messagesUsed};
