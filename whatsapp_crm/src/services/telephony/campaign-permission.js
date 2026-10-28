'use strict';
const DB=require('../database.service');
const {fields,fail}=require('./policy');
function normalized(value){return String(value||'').replace(/\D/g,'');}
function optedOut(businessId,lead){
 const Identity=require('../client-identity.service'),Sales=require('../sales-brain.service');
 const ids=[lead.chatId,Identity.resolve(businessId,lead.phone),Identity.resolve(businessId,lead.phone+'@c.us'),lead.phone,lead.phone+'@c.us'].filter(Boolean);
 return DB.all(`SELECT * FROM clients WHERE instanceId=? AND chatId IN (${ids.map(()=>'?').join(',')})`,[businessId,...ids]).some(row=>Sales.isDoNotCallClient(row));
}
function refreshSnapshot(businessId,campaignId){
 // Only revoke existing unstarted snapshot rows. Never add contacts, revive an
 // opt-out, or alter a completed/active/unknown outcome.
 for(const lead of DB.all("SELECT * FROM outbound_leads WHERE instanceId=? AND campaignId=? AND state='pending'",[businessId,campaignId])){
  if(optedOut(businessId,lead))DB.run("UPDATE outbound_leads SET doNotCall=1,state='blocked' WHERE leadId=? AND instanceId=? AND state='pending'",[lead.leadId,businessId]);
 }
}
function read(body){
 fields(body,['businessId','campaignId','leadId','phone']);
 const {businessId,campaignId,leadId}=body;
 if(!Number.isSafeInteger(businessId)||businessId<1||![campaignId,leadId].every(v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(v))||typeof body.phone!=='string'||!/^\+?[1-9]\d{7,14}$/.test(body.phone))fail('TELEPHONY_INPUT_INVALID');
 const campaign=DB.getOutboundCampaign(campaignId);
 const lead=DB.get('SELECT * FROM outbound_leads WHERE leadId=? AND campaignId=? AND instanceId=?',[leadId,campaignId,businessId]);
 if(!campaign||Number(campaign.instanceId)!==businessId||!lead||normalized(lead.phone)!==normalized(body.phone))fail('TELEPHONY_CAMPAIGN_NOT_FOUND',404);
 let reason=null;
 if(lead.doNotCall||optedOut(businessId,lead))reason='do_not_call';
 else if(['blocked','completed','unknown','canceled'].includes(lead.state))reason='lead_not_callable';
 else if(campaign.status!=='running'||!campaign.enabled)reason='campaign_not_running';
 return {businessId,campaignId,leadId,allowed:reason===null,reason};
}
module.exports={read,refreshSnapshot,optedOut};
