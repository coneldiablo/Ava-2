#!/usr/bin/env node
'use strict';
// Default SELECT/GET-only. Run before deploying strict GreenAPI webhook auth.
// --apply requires a NEW absolute mode0600 backup path; --rollback consumes it.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),SQLite=require('better-sqlite3');
// Self-contained so it can run against the old container before strict-auth
// cutover. Keep the v1 derivation identical to whatsapp-connection.service.
function greenWebhookToken(instance) {
 const master=String(process.env.GREEN_API_WEBHOOK_MASTER_KEY||instance.greenApiToken||'').trim();
 if(master.length<16||!instance.id||!instance.greenApiInstance)throw new Error('WHATSAPP_NOT_CONFIGURED');
 return crypto.createHmac('sha256',master).update(`ava:green-api:webhook:v1:${instance.id}:${instance.greenApiInstance}`).digest('hex');
}
const args=process.argv.slice(2);const mode=args[0]||'--dry-run';
if(!['--dry-run','--verify','--apply','--rollback'].includes(mode))throw new Error('INVALID_MIGRATION_MODE');
const backupPath=args[1];
if(['--apply','--rollback'].includes(mode)&&(!backupPath||!path.isAbsolute(backupPath)))throw new Error('ABSOLUTE_BACKUP_PATH_REQUIRED');
const hash=s=>crypto.createHash('sha256').update(String(s)).digest('hex');
const db=new SQLite(process.env.DB_PATH||path.join(__dirname,'../crm_v2.db'),{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
const tenants=db.prepare("SELECT * FROM instances WHERE trim(COALESCE(greenApiInstance,''))<>'' AND trim(COALESCE(greenApiToken,''))<>''").all();
const settingsFields=['webhookUrl','webhookUrlToken','incomingWebhook','outgoingWebhook','outgoingMessageWebhook','outgoingAPIMessageWebhook','stateWebhook','deviceWebhook'];
const snapshot=settings=>Object.fromEntries(settingsFields.map(k=>[k,settings[k]??'']));
function url(i,method){const base=new URL(i.greenApiUrl||'https://api.green-api.com');if(base.protocol!=='https:'||base.username||base.password)throw new Error('UNSAFE_PROVIDER_URL');return `${base.href.replace(/\/+$/,'')}/waInstance${encodeURIComponent(i.greenApiInstance)}/${method}/${encodeURIComponent(i.greenApiToken)}`;}
async function request(i,method,body){const res=await fetch(url(i,method),{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(10000)});if(!res.ok)throw new Error('PROVIDER_SETTINGS_UNAVAILABLE');return res.json();}
function sameExceptToken(before,after){return settingsFields.filter(k=>k!=='webhookUrlToken').every(k=>(before[k]??'')===(after[k]??''));}
async function main(){
 const plan=[];
 for(const i of tenants){const settings=await request(i,'getSettings');const expected=greenWebhookToken(i);plan.push({i,before:snapshot(settings),expected,matches:settings.webhookUrlToken===expected||settings.webhookUrlToken===`Bearer ${expected}`});}
 const summary={mode,configuredTenants:plan.length,needsMigration:plan.filter(p=>!p.matches).length};
 if(mode==='--dry-run'){console.log(JSON.stringify(summary));return;}
 if(mode==='--verify'){console.log(JSON.stringify({...summary,verified:summary.needsMigration===0}));if(summary.needsMigration)process.exitCode=1;return;}
 let backup;
 if(mode==='--apply'){
  backup={version:1,createdAt:new Date().toISOString(),entries:plan.map(p=>({businessId:p.i.id,providerHash:hash(p.i.greenApiInstance),before:p.before,expectedTokenHash:hash(p.expected)}))};
  const fd=fs.openSync(backupPath,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(backup));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 }else{
  if(fs.statSync(backupPath).mode&0o077)throw new Error('BACKUP_PERMISSIONS_UNSAFE');
  backup=JSON.parse(fs.readFileSync(backupPath,'utf8'));if(backup.version!==1||!Array.isArray(backup.entries))throw new Error('INVALID_BACKUP');
 }
 let changed=0,pendingReadbacks=0;
 for(const p of plan){const entry=backup.entries.find(e=>e.businessId===p.i.id&&e.providerHash===hash(p.i.greenApiInstance));
  if(!entry)throw new Error('PROVIDER_BINDING_CHANGED');
  const current=db.prepare('SELECT greenApiInstance,greenApiToken FROM instances WHERE id=?').get(p.i.id);
  if(current.greenApiInstance!==p.i.greenApiInstance||current.greenApiToken!==p.i.greenApiToken)throw new Error('PROVIDER_BINDING_CHANGED');
  const target=mode==='--apply'?p.expected:entry.before.webhookUrlToken;
  if(mode==='--rollback'&&!p.matches&&p.before.webhookUrlToken!==target)throw new Error('PROVIDER_TOKEN_CHANGED');
  if(mode==='--apply'&&!sameExceptToken(entry.before,p.before))throw new Error('PROVIDER_SETTINGS_CHANGED');
  if(p.before.webhookUrlToken!==target){const ack=await request(p.i,'setSettings',{webhookUrlToken:target});if(ack.saveSettings!==true)throw new Error('PROVIDER_SAVE_NOT_CONFIRMED');changed++;}
  const readback=await request(p.i,'getSettings');
  if(!sameExceptToken(p.before,readback))throw new Error('PROVIDER_SETTINGS_CHANGED');
  if(readback.webhookUrlToken!==target&&readback.webhookUrlToken!==`Bearer ${target}`)pendingReadbacks++;
 }
 console.log(JSON.stringify({...summary,changed,verified:pendingReadbacks===0,pendingReadbacks}));
 // SetSettings may take up to five minutes. Exit2 means acknowledged but not
 // verified; run SELECT/GET-only --verify later before enabling strict ingress.
 if(pendingReadbacks)process.exitCode=2;
}
main().catch(()=>{console.error('GREEN_WEBHOOK_MIGRATION_FAILED');process.exitCode=1;}).finally(()=>db.close());
