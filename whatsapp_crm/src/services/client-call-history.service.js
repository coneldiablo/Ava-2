'use strict';
const axios=require('axios');
const {createHash}=require('crypto');
const config=require('../config');
const DB=require('./database.service');
const Identities=require('./client-identity.service');
function normalizedPhone(value) {
 try { return Identities.normalize('phone',String(value||'').replace(/@(c\.us|s\.whatsapp\.net)$/,'')); } catch (_) { return null; }
}
function exactPhones(instanceId,chatId) {
 const identity=Identities.list(instanceId,chatId);
 const phones=new Set();
 for(const value of [identity.canonicalChatId,...identity.aliases.filter(a=>['phone','whatsapp'].includes(a.kind)).map(a=>a.value)]) {
  const phone=normalizedPhone(value);if(phone)phones.add(phone);
 }
 for(const link of DB.getIdentityLinksByChat(instanceId,identity.canonicalChatId)) {
  if(['exact','manual'].includes(link.confidence)) { const phone=normalizedPhone(link.normalizedPhone);if(phone)phones.add(phone); }
 }
 return phones;
}
async function page(instanceId,chatId,cursor=1) {
 const phones=exactPhones(instanceId,chatId);
 if(!phones.size)return {calls:[],nextPage:null,sourceComplete:true};
 const {apiUrl,serviceToken,timeoutMs}=config.avaAdmin;
 if(!apiUrl||!serviceToken)throw Object.assign(new Error('CALL_HISTORY_UNAVAILABLE'),{statusCode:503});
 const start=Math.max(1,Math.min(Math.trunc(Number(cursor)||1),100000));
 const calls=[];const seen=new Set();let nextPage=start;let complete=false;
 // Scan source pages, never infer a match from name/suffix or cross-tenant row.
 // A bounded continuation lets the card reach older calls without a long request.
 for(let offset=0;offset<3;offset++) {
  const response=await axios.get(`${apiUrl}/api/internal/calls/business/${instanceId}`,{params:{page:nextPage,page_size:50},headers:{Authorization:`Bearer ${serviceToken}`,Accept:'application/json'},timeout:Math.min(Number(timeoutMs)||5000,5000)});
  const source=response.data||{};const rows=Array.isArray(source.calls)?source.calls:[];
  if(source.business_id!=null&&Number(source.business_id)!==instanceId||rows.some(row=>Number(row.business_id)!==instanceId))throw new Error('CALL_HISTORY_SCOPE_MISMATCH');
  for(const row of rows) {
   const remote=row.direction==='outbound'?row.called_number:row.caller_number;
   if(!phones.has(normalizedPhone(remote)))continue;
   const key=String(row.call_id||row.id||'');if(!key||seen.has(key))continue;seen.add(key);
   calls.push({id:createHash('sha256').update(`${instanceId}:${key}`).digest('hex').slice(0,20),timestamp:row.start_time||null,direction:row.direction==='outbound'?'outbound':'inbound',outcome:typeof row.outcome==='string'?row.outcome:null,durationSeconds:Number.isFinite(row.duration_seconds)&&row.duration_seconds>=0?row.duration_seconds:null});
  }
  const totalPages=Math.max(1,Number(source.total_pages)||1);
  if(nextPage>=totalPages){complete=true;nextPage=null;break;}nextPage++;
 }
 return {calls,nextPage,sourceComplete:complete};
}
module.exports={page,exactPhones,normalizedPhone};
