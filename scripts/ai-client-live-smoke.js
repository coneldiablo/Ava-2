'use strict';
const fs = require('fs');
const axios = require('/app/node_modules/axios');
const DB = require('/app/src/services/database.service');
const config = require('/app/src/config');
const AI = require('/app/src/services/dashboard/ai');
const Drafts = require('/app/src/services/assistant-draft.service');
const probes = [], upstream = [];
let captureIndex=0;
const originalPost = axios.post;
axios.post = async function(url, body, options) {
    const start = Date.now();
    const item = { model: String(body?.model || ''), outputBudget: body?.max_tokens ?? body?.max_completion_tokens ?? null,
        timeoutMs: options?.timeout ?? null, responseFormat: body?.response_format?.type || null,
        hasReasoningParameter: body?.reasoning_effort != null || body?.thinking != null || body?.reasoning != null };
    upstream.push(item);
    try {
        const result = await originalPost.call(this, url, body, options);
        item.status = result.status; item.finishReason = result.data?.choices?.[0]?.finish_reason || null;
        item.responseChars = String(result.data?.choices?.[0]?.message?.content || '').length;
        item.elapsedMs = Date.now() - start;
        if(process.env.AI_SMOKE_CAPTURE==='true')fs.writeFileSync('/check/packet-'+(++captureIndex)+'.private.json',JSON.stringify({body,response:result.data}),{mode:0o600});
        return result;
    } catch (error) {
        item.status = error.response?.status || null; item.elapsedMs = Date.now() - start;
        item.errorCode = /^[A-Z_0-9]{1,64}$/.test(error.code || '') ? error.code : 'UPSTREAM_ERROR';
        throw error;
    }
};
async function check(name, fn, validate) {
    if(process.env.PROBE_NAMES&&!process.env.PROBE_NAMES.split(',').includes(name))return;
    const before = upstream.length, at = Date.now();
    let receipt;
    try {
        const result = await fn();
        const assertion = validate(result);
        receipt = {name,passed: assertion.passed,elapsedMs:Date.now()-at,upstreamRequests:upstream.length-before,modelReceipt:result?.modelReceipt||null,...assertion};
    } catch (error) {
        receipt = {name,passed:false,elapsedMs:Date.now()-at,upstreamRequests:upstream.length-before,
            errorCode:/^[A-Z_0-9]{1,64}$/.test(error.code||'')?error.code:'PROBE_FAILED'};
    }
    probes.push(receipt); console.log('SAFE_AI_PROBE '+JSON.stringify(receipt));
}
function answer(result) {
    const text=String(result?.answer||result?.summary||result?.overview?.summary||'');
    return {passed: text.trim().length>0 && result?.answerStatus==='answered' && result?.grounded===true,
        answerStatus:result?.answerStatus||null,grounded:result?.grounded===true,
        answerChars:text.length,sourceCount:Array.isArray(result?.sources)?result.sources.length:null};
}
async function main() {
    await DB.init();
    const activeBefore = DB.get('SELECT systemPrompt FROM instances WHERE id=1').systemPrompt;
    await check('ask_client_count_mimo',()=>AI.ask(1,AI.period({}),'Сколько клиентов в моём бизнесе?'),answer);
    await check('ask_business_mimo',()=>AI.ask(1,AI.period({}),'Как идёт мой бизнес? Что требует внимания?'),answer);
    await check('ask_risk_mimo',()=>AI.ask(1,AI.period({}),'Кто из клиентов рискует уйти?'),result=>{const a=answer(result);return {...a,passed:a.answerChars>0&&a.grounded&&['answered','insufficient'].includes(a.answerStatus)};});
    for(const kind of ['yesterday','overnight'])await check('overview_'+kind+'_mimo',()=>AI.overview(1,kind),result=>{
        const a=answer(result);const text=JSON.stringify({summary:result?.summary,changes:result?.changes,attention:result?.attention,outcome:result?.outcome});
        const clean=!/(?:mcp_sales_|tool_call_|conversation_event|sourceIds|(?:\b(?:done|high|in_progress|manager_note|internal|draft)\b)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.test(text);
        return {...a,customerTextClean:clean,passed:a.answerChars>0&&a.grounded&&['answered','insufficient'].includes(a.answerStatus)&&clean};
    });
    await check('assistant_draft_mimo',()=>Drafts.generate(1,{links:[],supplement:'Синтетическая техническая проверка: бизнес консультирует гостей по услугам. Ассистент отвечает по известным правилам, неизвестные условия уточняет у сотрудника. Не обещает неподтверждённые цены или бронирование.'}),result=>({passed:result?.status==='draft'&&typeof result.systemPrompt==='string'&&result.systemPrompt.length>20&&result.systemPrompt.length<=8000,status:result?.status||null,promptChars:result?.systemPrompt?.length||0}));
    if(DB.get('SELECT systemPrompt FROM instances WHERE id=1').systemPrompt!==activeBefore)throw Object.assign(new Error('active prompt changed'),{code:'ACTIVE_PROMPT_CHANGED'});
    DB.run("INSERT INTO instances(id,name,businessType,isActive) VALUES(900001,'Synthetic default-model probe','standard',1)");
    await DB.getOrCreateClient(900001,'79990000001','Synthetic QA client');
    await DB.saveMessageWithChannel(900001,'79990000001','Synthetic QA client','Хочу узнать об услугах и консультации.','user','whatsapp',null,'synthetic-qa-message');
    await check('new_business_default_model',()=>AI.ask(900001,AI.period({}),'Расскажи о текущем состоянии моего бизнеса.'),result=>{
        const a=answer(result);return {...a,passed:a.answerChars>0&&a.grounded&&['answered','insufficient'].includes(a.answerStatus)};
    });
    const CallHistory=require('/app/src/services/client-call-history.service');
    const phoneClient=DB.all('SELECT chatId FROM clients WHERE instanceId=1 ORDER BY id DESC').find(row=>CallHistory.normalizedPhone(row.chatId));
    let callHistory={passed:false,errorCode:'NO_PHONE_FIXTURE'};
    if(phoneClient){try{const result=await CallHistory.page(1,phoneClient.chatId);callHistory={passed:true,matchedCalls:result.calls.length,sourceComplete:result.sourceComplete,hasContinuation:result.nextPage!=null};}
        catch(error){callHistory={passed:false,errorCode:/^[A-Z_0-9]{1,64}$/.test(error.code||'')?error.code:'CALL_HISTORY_CHECK_FAILED'};}}
    const receipt={scope:'isolated_production_db_snapshot_real_aitunnel',passed:probes.every(x=>x.passed)&&probes.every(x=>x.upstreamRequests>0)&&callHistory.passed,probes,upstream,callHistory,
        productionDbWritten:false,realMessagesSent:false,activePromptUnchanged:true,httpRoutesAcceptance:false,safariAcceptance:false};
    fs.writeFileSync('/check/live-ai-receipt.json',JSON.stringify(receipt,null,2));console.log('SAFE_AI_RESULT '+JSON.stringify(receipt));
    DB.db.close();process.exit(receipt.passed?0:1);
}
main().catch(()=>{console.log('SAFE_AI_FATAL '+JSON.stringify({passed:false}));process.exit(1);});
