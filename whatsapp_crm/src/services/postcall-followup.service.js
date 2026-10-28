'use strict';
const {createHash,randomUUID}=require('crypto');
const DB=require('./database.service');
const KEY='_postCallFollowup';
const parse=value=>{try{const parsed=typeof value==='string'?JSON.parse(value):value;return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};}catch{return{};}};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code,statusCode:409});};
const flag=value=>value===true||value===1;
let running=false;

function policy(row={}){
 const value=parse(row.voiceSettings)[KEY]||{};
 const valid=value.version===1&&Number.isSafeInteger(value.revision)&&value.revision>0
  &&Number.isSafeInteger(value.draftCutoff)&&Number.isSafeInteger(value.eventCutoff)&&Number.isFinite(value.enabledAtMs);
 return {enabled:flag(row.followupAutoSendEnabled)&&valid&&value.enabled===true,revision:valid?value.revision:0,
  draftCutoff:valid?value.draftCutoff:0,eventCutoff:valid?value.eventCutoff:0,enabledAtMs:valid?value.enabledAtMs:0};
}
// Called inside DB.updateInstance's final immediate transaction, after async
// catalogue validation. Never copy a private policy from an earlier read.
function planWrite(data,row,voicePatch={}){
 const before=policy(row),latest=parse(row.voiceSettings),output={};
 if(Object.hasOwn(data,'expectedFollowupRevision')&&(!Number.isSafeInteger(data.expectedFollowupRevision)||data.expectedFollowupRevision!==before.revision))fail('FOLLOWUP_SETTINGS_CHANGED');
 let privateValue=latest[KEY];
 if(Object.hasOwn(data,'followupAutoSendEnabled')){
  if(![true,false,0,1].includes(data.followupAutoSendEnabled))throw Object.assign(new Error('INVALID_FOLLOWUP_POLICY'),{code:'INVALID_FOLLOWUP_POLICY',statusCode:400});
  const enabled=flag(data.followupAutoSendEnabled);
  if(enabled!==before.enabled||!privateValue){
   privateValue={version:1,enabled,revision:before.revision+1,enabledAtMs:Date.now(),
    draftCutoff:Number(DB.get('SELECT COALESCE(MAX(rowid),0) n FROM followup_drafts WHERE instanceId=?',[row.id]).n),
    eventCutoff:Number(DB.get('SELECT COALESCE(MAX(rowid),0) n FROM conversation_events WHERE instanceId=?',[row.id]).n)};
  }
  output.followupAutoSendEnabled=Number(enabled);
 }
 if(privateValue&&(Object.hasOwn(voicePatch,'voiceSettings')||Object.hasOwn(data,'followupAutoSendEnabled'))){
  output.voiceSettings=JSON.stringify({...parse(voicePatch.voiceSettings||row.voiceSettings),[KEY]:privateValue});
 }
 return output;
}
function transcript(businessId,eventId){return DB.get('SELECT text FROM ava_call_transcript_sources WHERE businessId=? AND sourceId=?',[businessId,eventId])?.text||'';}
function currentDraft(businessId,draftId){return DB.get('SELECT rowid AS draftRowid,* FROM followup_drafts WHERE instanceId=? AND draftId=?',[businessId,draftId]);}
function marker(draft){return parse(draft?.metadataJson).autoDispatch||{};}
function put(draft,autoDispatch,fields={}){return DB.updateFollowupDraft(draft.instanceId,draft.draftId,{...fields,metadata:{autoDispatch}});}
function eventFor(draft,auto){return DB.get('SELECT rowid AS eventRowid,* FROM conversation_events WHERE instanceId=? AND eventId=? AND chatId=? AND callId=? AND sourceId=?',
 [draft.instanceId,auto.callEventId,draft.chatId,draft.callId,'post_call:'+draft.callId]);}
function basicGuard(draft,auto,{token=null,dispatch=false}={}){
 const row=DB.get('SELECT * FROM instances WHERE id=?',[draft.instanceId]),p=policy(row);
 if(!row?.isActive||!p.enabled||auto.policyRevision!==p.revision||auto.enabledAtMs!==p.enabledAtMs)fail('FOLLOWUP_POLICY_CHANGED');
 if(draft.draftRowid<=p.draftCutoff||draft.source!=='post_call'||!draft.callId||draft.editedAt||draft.approvedAt||draft.sentAt||draft.status!=='draft')fail('FOLLOWUP_REVIEW_REQUIRED');
 const source=eventFor(draft,auto);
 if(!source||source.eventRowid<=p.eventCutoff||source.customerId!==draft.customerId||hash(transcript(draft.instanceId,source.eventId))!==auto.transcriptHash)fail('FOLLOWUP_SOURCE_CHANGED');
 const startedAt=Date.parse(parse(source.metadataJson).call_started_at);
 if(!Number.isFinite(startedAt)||startedAt<=p.enabledAtMs||startedAt>Date.now())fail('FOLLOWUP_CALL_BEFORE_ACTIVATION');
 const prior=DB.all('SELECT * FROM followup_drafts WHERE instanceId=? AND callId=? AND draftId!=?',[draft.instanceId,draft.callId,draft.draftId]);
 if(prior.some(other=>other.status==='sent'||require('./sales-brain.service').followupDeliveryPending(other)))fail('FOLLOWUP_CALL_ALREADY_DISPATCHED');
 if(DB.get("SELECT 1 FROM tool_runs WHERE instanceId=? AND callId=? AND toolName IN ('send_followup','mcp_sales_send_followup','send_whatsapp_followup','mcp_sales_send_whatsapp_followup') AND json_valid(resultRedactedJson) AND (json_extract(resultRedactedJson,'$.sent')=1 OR json_extract(resultRedactedJson,'$.status') IN ('pending','sending','unknown') OR json_extract(resultRedactedJson,'$.error') IN ('delivery_pending','delivery_unconfirmed')) LIMIT 1",[draft.instanceId,draft.callId]))fail('FOLLOWUP_CALL_ALREADY_DISPATCHED');
 if(!DB.get('SELECT 1 FROM clients WHERE instanceId=? AND chatId=? AND ?=?||id',[draft.instanceId,draft.chatId,draft.customerId,`crm_${draft.instanceId}_`]))fail('FOLLOWUP_IDENTITY_CHANGED');
 if(require('./ava-autopilot.store').policy(draft.instanceId)?.activated)fail('AUTOPILOT_ACTION_NOT_ALLOWED');
 require('./ava-workspace.store').assertAiAllowed(draft.instanceId,draft.chatId);
 if(token&&auto.claimToken!==token)fail('FOLLOWUP_CLAIM_LOST');
 const requested=require('./sales-brain.service').followupRequest(transcript(draft.instanceId,source.eventId)).channel;
 if(!requested||requested!==(auto.requestedChannel||'whatsapp'))fail('FOLLOWUP_REQUEST_CHANGED');
 if(dispatch&&(!['prepared','sending'].includes(auto.state)||!auto.preparedTextHash||hash(draft.text)!==auto.preparedTextHash))fail('FOLLOWUP_REVIEW_REQUIRED');
 if(auto.channelSnapshot)require('./channel-context.service').assertCanSend(draft.instanceId,draft.chatId,auto.channelSnapshot,{origin:'legacy_ai_followup'});
 if(dispatch){
  const selection=parse(draft.metadataJson);
  if(selection.channel!==requested||selection.channel!==auto.target?.channel||selection.recipient!==auto.target?.recipient
   ||!require('./sales-brain.service').followupChannelTargets(draft.instanceId,draft.chatId).some(target=>target.channel===requested&&target.recipient===selection.recipient))fail('FOLLOWUP_RECIPIENT_CHANGED');
  assertFacts(draft.instanceId,auto.factProof);
 }
 return {row,p,source};
}
function enqueue({businessId,draftId,eventId,consent,requestedChannel}){
 if(consent!==true)return {queued:false,reason:'explicit_request_required'};
 return DB.db.transaction(()=>{
  const row=DB.get('SELECT * FROM instances WHERE id=?',[businessId]),p=policy(row),draft=currentDraft(businessId,draftId);
  if(!p.enabled||!draft)return {queued:false,reason:'manual_approval'};
  const previous=marker(draft);if(previous.version===1)return{queued:['queued','preparing','prepared','sending'].includes(previous.state),idempotent:true};
  const actualRequest=require('./sales-brain.service').followupRequest(transcript(businessId,eventId));
  if(!actualRequest.channel||requestedChannel&&requestedChannel!==actualRequest.channel)return{queued:false,reason:'explicit_request_required'};
  if(actualRequest.channel==='instagram')return{queued:false,reason:'channel_requires_manager'};
  const auto={version:1,state:'queued',requestedChannel:actualRequest.channel,policyRevision:p.revision,enabledAtMs:p.enabledAtMs,callEventId:eventId,
   transcriptHash:hash(transcript(businessId,eventId)),consent:true,attempts:0,nextAt:Date.now(),claimToken:null,leaseUntil:0};
  try{basicGuard(draft,auto);}catch(error){return{queued:false,reason:error.code||'manual_approval'};}
  put(draft,auto);return{queued:true};
 }).immediate();
}
function knowledgeHash(businessId,kbId){
 const rows=DB.all('SELECT c.id,c.text FROM kb_chunks c JOIN knowledge_base k ON k.id=c.kbId WHERE k.instanceId=? AND k.id=? AND k.isCurrent=1 ORDER BY c.id',[businessId,kbId]);
 return rows.length?hash(rows):null;
}
function assertFacts(businessId,proof){
 if(proof?.kind==='catalog'){
  const Store=require('./ava-autopilot.store');
  if(!Array.isArray(proof.offers)||!proof.offers.length)fail('FOLLOWUP_FACTS_CHANGED');
  for(const ref of proof.offers){const current=Store.offer(businessId,ref.id);if(!current?.active||!current.publishedAt||current.revision!==ref.revision||hash(current)!==ref.hash)fail('FOLLOWUP_FACTS_CHANGED');}
 }else if(proof?.kind==='knowledge'){
  if(knowledgeHash(businessId,proof.kbId)!==proof.hash)fail('FOLLOWUP_FACTS_CHANGED');
 }else fail('FOLLOWUP_FACTS_REQUIRED');
}
// Knowledge may contain the assistant's operating prompt as well as product
// facts. Never copy role-play, template placeholders, or instructions addressed
// to the agent into an automatic customer message. Keep the whole clean passage
// (including its final conditions); contaminated sources require manager review.
function customerFacingFacts(value){
 if(typeof value!=='string'||!value.trim()||value.length>1800)return false;
 return !/(?:mcp_|tool_|source_id|call_id|manager_task|источники:|следующий шаг:|system\s*:|assistant\s*:|\b(?:draft|pending)\b|(?:клиент|покупатель|менеджер|ассистент|оператор|амина)\s*:\s*[«"„]|[«"][^»"\n]{0,120}[»"]\s*(?:клиент|амина)\s*:|\[(?:модель|цена|сумма|имя|товар|название)[^\]]*\]|если\s+(?:имя|клиент)\b[^.!?]{0,120}(?:назван|спрос|говор|запрос|задерж)|(?:не\s+задерживать|перейти\s+к\s+запросу|далее\s+озвучить|ты\s+(?:голосовой|помощник|ассистент)|системн(?:ый|ая)\s+(?:промпт|инструкция)|правила\s+для\s+(?:ассистента|модели)|(?:назначение|основание|статус|навигация)\s*:|ПРОВЕРИТЬ|требу(?:ет|ют)\s+(?:заполнения|проверки|подтверждения)|не\s+(?:использовать|выдавать|утверждать)|(?:нужно|следует|должна)\s+(?:спросить|уточнить|предложить|сказать)|сценарии?\s+диалог|системн(?:ый|ая)))/iu.test(value);
}
async function prepareMessage(draft,auto,row){
 const metadata=parse(draft.metadataJson),question=String(metadata.request||'').trim();
 if(!question)fail('FOLLOWUP_FACTS_REQUIRED');
 const Local=require('./knowledge-local.service'),Store=require('./ava-autopilot.store');
 const candidates=Local.catalogContext(draft.instanceId,question);
 const offers=Local.isCatalogRequest(question,candidates)?candidates.slice(0,2):[];
 let facts,proof;
 if(offers.length){
  facts=offers.map(offer=>`${offer.name}: ${(offer.amountMinor/100).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})} ${offer.currency}.${offer.terms?' '+offer.terms:''}`).join('\n');
  proof={kind:'catalog',offers:offers.map(offer=>{const current=Store.offer(draft.instanceId,offer.offerId);return{id:offer.offerId,revision:offer.revision,hash:hash(current)};})};
 }else{
  const found=await Local.lookup(draft.instanceId,question),ref=found?.citations?.[0];
  if(!found||found.provenance!=='local_knowledge_extract'||!Number.isSafeInteger(ref?.source_id))fail('FOLLOWUP_FACTS_REQUIRED');
  // Select a clean, complete factual paragraph rather than the complete KB
  // chunk: some business documents mix product facts and internal role-play.
  // The selected paragraph keeps its adjacent price/warranty conditions.
  const chunks=DB.all('SELECT c.id,c.text FROM kb_chunks c JOIN knowledge_base k ON k.id=c.kbId WHERE k.instanceId=? AND k.id=? AND k.isCurrent=1 ORDER BY c.id',[draft.instanceId,ref.source_id]);
  const candidates=[];
  for(const chunk of chunks){
   const paragraphs=chunk.text.split(/\n\s*\n/u);
   for(const value of paragraphs){
    const text=value.replace(/\s+/g,' ').trim();
    if(customerFacingFacts(text)&&text.length>=30&&!candidates.some(item=>item.text===text))candidates.push({id:chunk.id,kbId:ref.source_id,text});
   }
  }
  const query=question.replace(/(?:пришлите|пришли|отправьте|отправь|скиньте|скинь|пожалуйста|whats?app|ватс?ап\w*|телеграм\w*|telegram|сообщени\w*)/giu,' ');
  const selected=require('./rag.service')._selectAnswerChunk(candidates,query);
  if(!selected?.matchedTokens?.length||!selected.result?.text)fail('FOLLOWUP_FACTS_REQUIRED');
  facts=selected.result.text;proof={kind:'knowledge',kbId:ref.source_id,hash:knowledgeHash(draft.instanceId,ref.source_id)};
 }
 if(!customerFacingFacts(facts))fail('FOLLOWUP_FACTS_REQUIRED');
 assertFacts(draft.instanceId,proof);
 // A greeting has no factual content and must not depend on a second model
 // request after the call. A provider timeout used to block otherwise valid
 // materials here. Facts remain exact, current, tenant-scoped source text.
 const final=['Спасибо за разговор! Вот информация по вашему вопросу:',facts].join('\n\n');
 if(final.length>2200)fail('FOLLOWUP_AI_REVIEW_REQUIRED');
 return{text:final,proof};
}
function automaticSendAllowed(draft,token){
 if(typeof token!=='string'||!token)return false;
 try{const current=currentDraft(draft.instanceId,draft.draftId);basicGuard(current,marker(current),{token,dispatch:true});return true;}catch{return false;}
}
function requiresApproval(draft,token){return draft.status!=='approved'&&!automaticSendAllowed(draft,token);}
function finish(draftId,businessId,token,state,errorCode=null){
 return DB.db.transaction(()=>{
  const draft=currentDraft(businessId,draftId);if(!draft)return;
  const auto=marker(draft);if(auto.claimToken!==token)return;
  const fields=state==='needs_review'?{failureReason:'Проверьте материалы и отправьте сообщение клиенту вручную.'}:{};
  put(draft,{...auto,state,errorCode,claimToken:null,leaseUntil:0},fields);
  if(state==='sent'&&draft.managerTaskId){const task=DB.getManagerTask(businessId,draft.managerTaskId);if(task?.source==='post_call_followup'&&task.status==='new'&&task.chatId===draft.chatId&&task.callId===draft.callId)DB.updateManagerTask(businessId,task.taskId,{status:'done',resolutionNote:'AVA отправила клиенту материалы после звонка.'});}
 }).immediate();
}
async function dispatch(businessId,draftId){
 const token=randomUUID(),claimed=DB.db.transaction(()=>{
  const draft=currentDraft(businessId,draftId);if(!draft)return null;
  const auto=marker(draft),now=Date.now();
  if(auto.version!==1||!['queued','preparing','prepared'].includes(auto.state)||auto.nextAt>now||auto.leaseUntil>now)return null;
  if(draft.status==='sent'){const recoverToken=randomUUID();put(draft,{...auto,claimToken:recoverToken});finish(draftId,businessId,recoverToken,'sent');return null;}
  if(require('./sales-brain.service').followupDeliveryPending(draft)){put(draft,{...auto,state:'unknown'});return null;}
  try{basicGuard(draft,auto);}catch(error){put(draft,{...auto,state:'needs_review',errorCode:error.code||'FOLLOWUP_REVIEW_REQUIRED'});return null;}
  const snapshot=require('./channel-context.service').capture(businessId,draft.chatId);
  const value={...auto,state:'preparing',claimToken:token,leaseUntil:now+120000,attempts:auto.attempts+1,channelSnapshot:snapshot};
  put(draft,value);return{draft,auto:value};
 }).immediate();
 if(!claimed)return{handled:false};
 let sending=false;
 try{
  const current=await DB.getInstance(businessId),requested=claimed.auto.requestedChannel||'whatsapp';
  if(requested==='whatsapp'){
   const gateway=require('./whatsapp-gateway.service'),config=gateway.getConfig(current);
   if(!config.hasOpenWa&&!config.hasGreenApi)fail('WHATSAPP_NOT_CONFIGURED');
   const state=await gateway.getState(current);if(!state.success||state.effectiveState!=='authorized')fail('WHATSAPP_NOT_AUTHORIZED');
  }
  const targets=(await require('./sales-brain.service').followupChannels(businessId,claimed.draft.chatId)).filter(target=>target.channel===requested);
  const target=targets.length===1?targets[0]:null;
  if(!target)fail('FOLLOWUP_CHANNEL_UNAVAILABLE');
  const prepared=await prepareMessage(claimed.draft,claimed.auto,current);
  DB.db.transaction(()=>{
   const draft=currentDraft(businessId,draftId),auto=marker(draft);basicGuard(draft,auto,{token});
   if(hash(draft.text)!==hash(claimed.draft.text))fail('FOLLOWUP_REVIEW_REQUIRED');
   DB.updateFollowupDraft(businessId,draftId,{text:prepared.text,metadata:{channel:target.channel,recipient:target.recipient,
    autoDispatch:{...auto,target:{channel:target.channel,recipient:target.recipient},state:'prepared',preparedTextHash:hash(prepared.text),factProof:prepared.proof}}});
  }).immediate();
  DB.db.transaction(()=>{const draft=currentDraft(businessId,draftId),auto=marker(draft);basicGuard(draft,auto,{token,dispatch:true});}).immediate();sending=true;
  const result=await require('./sales-brain.service').sendFollowup({instanceId:businessId,draftId,confirmed:true,autoDispatchToken:token,phase:'post_call_auto'});
  const latest=currentDraft(businessId,draftId);
  if(result.sent===true||latest?.status==='sent'){finish(draftId,businessId,token,'sent');return{handled:true,status:'sent'};}
  const unknown=require('./sales-brain.service').followupDeliveryPending(latest)||result.status==='pending';
  finish(draftId,businessId,token,unknown?'unknown':'needs_review',unknown?'DELIVERY_UNCONFIRMED':result.error||'FOLLOWUP_REVIEW_REQUIRED');
  return{handled:true,status:unknown?'unknown':'needs_review'};
 }catch(error){
  const latest=currentDraft(businessId,draftId),unknown=sending&&require('./sales-brain.service').followupDeliveryPending(latest);
  finish(draftId,businessId,token,unknown?'unknown':'needs_review',/^[A-Z_]+$/.test(error.code||'')?error.code:'FOLLOWUP_REVIEW_REQUIRED');
  return{handled:true,status:unknown?'unknown':'needs_review'};
 }
}
async function recover({limit=20}={}){
 if(running||!DB.db?.open)return{processed:0};running=true;
 try{
  // A process may die after beginning a send. Never lease/retry those rows.
  DB.run("UPDATE followup_drafts SET metadataJson=json_set(metadataJson,'$.autoDispatch.state','unknown','$.delivery_status','unknown') WHERE json_valid(metadataJson) AND json_extract(metadataJson,'$.autoDispatch.state')='sending' AND COALESCE(json_extract(metadataJson,'$.autoDispatch.leaseUntil'),0)<?",[Date.now()]);
  const rows=DB.all("SELECT instanceId,draftId FROM followup_drafts WHERE json_valid(metadataJson) AND json_extract(metadataJson,'$.autoDispatch.version')=1 AND json_extract(metadataJson,'$.autoDispatch.state') IN ('queued','preparing','prepared') AND COALESCE(json_extract(metadataJson,'$.autoDispatch.leaseUntil'),0)<=? ORDER BY createdAt,draftId LIMIT ?",[Date.now(),Math.max(1,Math.min(100,limit))]);
  let processed=0;for(const row of rows){const result=await dispatch(row.instanceId,row.draftId);if(result.handled)processed++;}return{processed};
 }finally{running=false;}
}
module.exports={policy,planWrite,enqueue,recover,dispatch,automaticSendAllowed,requiresApproval};
