'use strict';
// Real Google calls with synthetic content, on an isolated disposable database.
const fs = require('node:fs');
if (!process.env.DB_PATH?.startsWith('/verify/') || fs.existsSync(process.env.DB_PATH)) throw Error('ISOLATED_NEW_DATABASE_REQUIRED');
const output = console.log.bind(console); console.log = console.info = console.warn = console.error = () => {};
const DB = require('/app/src/services/database.service');
const AI = require('/app/src/services/ai.service');
const Gemini = require('/app/src/services/gemini-text.service');
const checks = [];
let syntheticOverviewSample = null;
let phase = null, phaseStarted = null;
async function check(name, work) { const started=Date.now();phase=name;phaseStarted=started; await work(); checks.push({name,pass:true,ms:Date.now()-started}); }
(async () => {
 await DB.init();
 const business = await DB.createInstance({name:'Synthetic Gemini release verification'});
 DB.run("UPDATE instances SET aiProvider='gemini',geminiModel='gemini-3.8-flash',systemPrompt=? WHERE id=?", ['Вы помощник гостиницы. Заезд с 14:00. Отвечайте кратко по-русски, неизвестное уточняйте.', business.id]);
 const instance = DB.get('SELECT * FROM instances WHERE id=?',[business.id]);
 for (const model of Gemini.MODELS) await check('native-'+model, async () => {
  const text=await AI.generatePlainText([{role:'user',content:'Ответь только JSON {"ready":true}.'}],{...instance,geminiModel:model},{json:true,maxTokens:4096,timeout:45000,validate:raw=>{if(JSON.parse(raw).ready!==true)throw Error('PROBE_INVALID_JSON');}});
  if(JSON.parse(text).ready!==true)throw Error('PROBE_NATIVE_FAILED');
 });
 await check('customer-reply',async()=>{
  const response=await AI.getResponse([{role:'user',content:'Во сколько заезд?'}],{instanceConfig:instance});
  if(!response || typeof response.reply!=='string' || !response.reply.trim())throw Error('PROBE_CUSTOMER_REPLY_INVALID');
 });
 await check('dashboard-summary',async()=>{
  const result=await require('/app/src/services/dashboard/ai.model').generate({businessId:business.id,question:'Что произошло за ночь?',windowKind:'overnight',range:{from:'2026-10-13T18:00:00Z',to:'2026-10-14T06:00:00Z'},rawFacts:[{id:'synthetic-booking',summary:'Клиент подтвердил бронирование и ждёт ответа менеджера.',subject:{type:'lead',name:'Проверочный клиент'},source:{type:'conversation_event',id:'synthetic-event',createdAt:'2026-10-14T04:00:00Z'}}]});
  if(!result.grounded || result.provenance!=='gemini_crm' || !result.answer)throw Error('PROBE_DASHBOARD_INVALID');
 });
 await check('durable-human-overview',async()=>{
  const dashboard=require('/app/src/services/dashboard/ai');
  const zone=instance.hotelTimezone||'UTC';
  const window=require('/app/src/services/dashboard/facts').windowFor('overnight',new Date(),zone,true);
  const at=new Date(Date.parse(window.start)+3600000).toISOString();
  DB.run("INSERT INTO conversation_events(eventId,instanceId,channel,direction,role,content,createdAt) VALUES (?,?,?,?,?,?,?)",['release-night-inquiry',business.id,'whatsapp','inbound','user','Клиент запросил бронирование и ждёт уточнения доступных номеров.',at]);
  const first=await dashboard.overview(business.id,'overnight');
  const second=await dashboard.overview(business.id,'overnight');
  if(!first.grounded||!first.window.complete||!first.summary||first.generatedAt!==second.generatedAt)throw Error('PROBE_DURABLE_OVERVIEW_INVALID');
  if(/\bUTC\b|\d{1,2}:\d{2}|выборк|подтвержд[её]нн|контекст CRM|за всё время/iu.test(first.summary))throw Error('PROBE_OVERVIEW_COPY_INVALID');
  if(DB.get('SELECT COUNT(*) AS n FROM dashboard_period_overviews WHERE businessId=? AND content IS NOT NULL',[business.id]).n!==1)throw Error('PROBE_OVERVIEW_STORAGE_INVALID');
  syntheticOverviewSample=first.summary;
 });
 await check('assistant-autoprompt',async()=>{
  const result=await require('/app/src/services/assistant-draft.service').generate(business.id,{links:[],supplement:'Синтетическая гостиница для проверки. Заезд с 14:00, выезд до 12:00. Помощник отвечает гостям, уточняет даты и количество гостей. Стоимость узнавать у менеджера. Не придумывать цены.'});
  if(result.status!=='draft'||!result.systemPrompt?.trim()||result.modelReceipt?.provider!=='gemini')throw Error('PROBE_AUTOPROMPT_INVALID');
 });
 await check('onyx-sse-tool-roundtrip',async()=>{
  const {OnyxLlmGateway}=require('/app/src/services/onyx-llm-gateway.service');
  const gateway=new OnyxLlmGateway();
  const credential=gateway.issueToken(business.id);let frames=0;const calls=[];
  const messages=[{role:'user',content:'Вызови инструмент check_availability с датой 2026-10-20. Ничего другого не делай.'}];
  const tools=[{type:'function',function:{name:'check_availability',description:'Проверить наличие свободных номеров.',parameters:{type:'object',properties:{date:{type:'string'}},required:['date']}}}];
  await gateway.complete('Bearer '+credential.token,{model:credential.model,stream:true,max_tokens:2048,messages,tools,tool_choice:{type:'function',function:{name:'check_availability'}}},{onChunk:chunk=>{frames++;for(const choice of chunk.choices||[])for(const call of choice.delta?.tool_calls||[])calls.push(call);}});
  const plainCalls=calls.map(({id,type,function:fn})=>({id,type,function:fn})); // Standard clients omit vendor fields.
  if(!frames||plainCalls.length!==1||plainCalls[0].function.name!=='check_availability'||JSON.parse(plainCalls[0].function.arguments).date!=='2026-10-20')throw Error('PROBE_SSE_TOOL_INVALID');
  const second=await gateway.complete('Bearer '+credential.token,{model:credential.model,stream:false,max_tokens:2048,tools,tool_choice:'none',messages:[...messages,{role:'assistant',content:null,tool_calls:plainCalls},{role:'tool',tool_call_id:plainCalls[0].id,content:JSON.stringify({available:true,date:'2026-10-20'})},{role:'user',content:'Теперь кратко сообщи результат проверки.'}]});
  if(!second.result?.choices?.[0]?.message?.content?.trim())throw Error('PROBE_TOOL_REPLAY_INVALID');
 });
 await check('knowledge-embedding',async()=>{
  const service=require('/app/src/services/gemini-embeddings.service');
  const values=await service.embed('Заезд в гостиницу с 14:00.',business.id,'RETRIEVAL_DOCUMENT');
  if(values.length!==3072||values.some(v=>!Number.isFinite(v)))throw Error('PROBE_EMBEDDING_INVALID');
 });
 DB.db.close();output(JSON.stringify({pass:true,provider:'gemini',syntheticOnly:true,customerMessagesSent:false,checks,syntheticOverviewSample}));
})().then(()=>process.exit(0)).catch(error=>{output(JSON.stringify({pass:false,syntheticOnly:true,checks,failedPhase:phase,failedElapsedMs:Date.now()-phaseStarted,errorCode:/^[A-Z_]+$/.test(error.code||'')?error.code:/^[A-Z_]+$/.test(error.message||'')?error.message:error.name}));process.exit(1);});
