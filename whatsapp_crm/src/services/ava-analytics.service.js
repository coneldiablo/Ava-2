'use strict';
const crypto = require('crypto');
const DB = require('./database.service');
const Identity = require('./identity/identity-store');
const Deals = require('./customer-deals.store');
const initialized = new WeakSet();
const DEFAULT_CRITERIA = [
    { id:'greeting', name:'Приветствие', mode:'require', phrases:['здравствуйте','добрый день','добрый вечер','доброе утро','привет'] },
    { id:'clarification', name:'Уточнение потребности', mode:'require', phrases:['подскажите','уточните','какой вариант','что для вас','какая услуга'] },
    { id:'unsupported_guarantee', name:'Категоричные обещания', mode:'avoid', phrases:['гарантирую на 100','сто процентов гарантируем','гарантированно получите'] },
];
function fail(code,statusCode=400) {throw Object.assign(new Error(code),{code,statusCode});}
function ensureSchema() {
    Deals.ensureSchema();
    if(initialized.has(DB.db))return;
    DB.db.exec(`CREATE TABLE IF NOT EXISTS ava_quality_criteria (
        businessId INTEGER PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 1,criteriaJson TEXT NOT NULL,
        updatedBy TEXT NOT NULL,updatedAt TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_messages_quality_source ON messages(instanceId,role,timestamp,id);`);
    initialized.add(DB.db);
}
function authorize(auth,businessId,capability='sales.assign') {
    if(!auth?.userId || Identity.actor(auth.userId).platformRole==='platform_admin') fail('ANALYTICS_ACCESS_DENIED',403);
    return Identity.authorizeCapability(auth,businessId,capability);
}
function date(value) {
    if(typeof value!=='string'||!value)return null;
    const normalized=/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)?value.replace(' ','T')+'Z':value;
    const timestamp=Date.parse(normalized);return Number.isFinite(timestamp)?timestamp:null;
}
function criteria(businessId) {
    ensureSchema();
    const row=DB.get('SELECT revision,criteriaJson,updatedAt FROM ava_quality_criteria WHERE businessId=?',[businessId]);
    return row?{revision:row.revision,criteria:JSON.parse(row.criteriaJson),updatedAt:row.updatedAt}
        :{revision:0,criteria:DEFAULT_CRITERIA.map(c=>({...c,phrases:[...c.phrases]})),updatedAt:null};
}
function saveCriteria(auth,businessId,input) {
    const id=authorize(auth,businessId,'business.manage');ensureSchema();
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['revision','criteria'].includes(k))
        ||!Number.isSafeInteger(input.revision)||!Array.isArray(input.criteria)||input.criteria.length<1||input.criteria.length>12)fail('QUALITY_CRITERIA_INVALID');
    const ids=new Set();
    const validated=input.criteria.map(rule=>{
        if(!rule||typeof rule!=='object'||Array.isArray(rule)||Object.keys(rule).some(k=>!['id','name','mode','phrases'].includes(k))
            ||typeof rule.id!=='string'||!/^[a-z][a-z0-9_]{0,40}$/.test(rule.id)||ids.has(rule.id)
            ||typeof rule.name!=='string'||!rule.name.trim()||rule.name.length>120||!['require','avoid'].includes(rule.mode)
            ||!Array.isArray(rule.phrases)||!rule.phrases.length||rule.phrases.length>20
            ||rule.phrases.some(p=>typeof p!=='string'||p.trim().length<3||p.length>100))fail('QUALITY_CRITERIA_INVALID');
        ids.add(rule.id);return {id:rule.id,name:rule.name.trim(),mode:rule.mode,phrases:[...new Set(rule.phrases.map(p=>p.trim().toLocaleLowerCase('ru')))]};
    });
    return DB.db.transaction(()=>{
        const old=criteria(id);if(input.revision!==old.revision)fail('QUALITY_REVISION_CONFLICT',409);
        DB.run(`INSERT INTO ava_quality_criteria(businessId,revision,criteriaJson,updatedBy,updatedAt) VALUES(?,?,?,?,?)
            ON CONFLICT(businessId) DO UPDATE SET revision=excluded.revision,criteriaJson=excluded.criteriaJson,updatedBy=excluded.updatedBy,updatedAt=excluded.updatedAt`,
        [id,old.revision+1,JSON.stringify(validated),auth.userId,new Date().toISOString()]);
        return {success:true,businessId:id,...criteria(id)};
    }).immediate();
}
function href(chatId,sourceId) {return '/?'+new URLSearchParams({client:chatId,source:String(sourceId)});}
function quality(id,since) {
    const configuration=criteria(id);
    // Only actual outgoing speech is checked. A partial message sample cannot
    // prove an omitted greeting or question: absence therefore stays insufficient.
    const messages=DB.all(`SELECT m.id,m.chatId,m.content,m.timestamp FROM messages m
        JOIN clients c ON c.instanceId=m.instanceId AND c.chatId=m.chatId
        WHERE m.instanceId=? AND m.role='assistant' AND julianday(m.timestamp)>=julianday(?)
        ORDER BY m.timestamp DESC,m.id DESC LIMIT 250`,[id,since]);
    require('./ava-workspace.store').ensureSchema();
    const transcripts=DB.all(`SELECT t.sourceId,t.chatId,t.text,e.callId FROM ava_call_transcript_sources t
        JOIN conversation_events e ON e.instanceId=t.businessId AND e.eventId=t.sourceId AND e.chatId=t.chatId
        WHERE t.businessId=? AND t.timestamp>=? ORDER BY t.timestamp DESC,t.sourceId DESC LIMIT 100`,[id,since]);
    const callSpeech=[];
    for(const t of transcripts)for(const line of t.text.split('\n')){
        const own=line.match(/^\s*(assistant|agent|manager|бот|менеджер|оператор)\s*:\s*(.+)$/i);
        if(own)callSpeech.push({id:t.sourceId,chatId:t.chatId,content:own[2],type:'call'});
    }
    const evidence=[...messages.map(m=>({...m,type:'message'})),...callSpeech];
    const cases=configuration.criteria.map(rule=>{
        const hits=evidence.filter(m=>rule.phrases.some(p=>String(m.content||'').toLocaleLowerCase('ru').includes(p)));
        return {id:rule.id,criterion:rule.name,mode:rule.mode,
            result:hits.length?(rule.mode==='avoid'?'not_met':'met'):'insufficient',
            checkedMessages:messages.length,matchedMessages:hits.length,
            evidence:hits.slice(0,3).map(m=>({sourceId:String(m.id),type:m.type,text:String(m.content).slice(0,300),chatId:m.chatId,href:href(m.chatId,m.id)}))};
    });
    return {revision:configuration.revision,cases,checkedMessages:messages.length,checkedCalls:transcripts.length,sampleComplete:messages.length<250&&transcripts.length<100,
        method:'literal_phrase_checks',note:'Проверены фразы команды в сохранённых ответах и расшифровках. Отсутствие фразы в выборке не доказывает нарушение.'};
}
function suggestions(id,since) {
    const rows=DB.all(`SELECT m.id,m.chatId,m.content FROM messages m
        JOIN clients c ON c.instanceId=m.instanceId AND c.chatId=m.chatId
        WHERE m.instanceId=? AND m.role='user' AND julianday(m.timestamp)>=julianday(?)
        ORDER BY m.timestamp DESC,m.id DESC LIMIT 1000`,[id,since]);
    const groups=new Map();
    for(const m of rows){
        const text=String(m.content||'').trim();if(text.length<12||text.length>500||!text.includes('?'))continue;
        const key=text.toLocaleLowerCase('ru').replace(/\s+/g,' ').replace(/[!?.,]/g,'');
        const group=groups.get(key)||{question:text,count:0,clients:new Set(),source:m};group.count++;group.clients.add(m.chatId);groups.set(key,group);
    }
    return [...groups.entries()].filter(([,g])=>g.clients.size>=2).sort((a,b)=>b[1].count-a[1].count||a[0].localeCompare(b[0])).slice(0,10)
        .map(([key,g])=>({id:crypto.createHash('sha256').update(id+':'+key).digest('hex').slice(0,24),question:g.question,count:g.count,
            customerCount:g.clients.size,sourceId:String(g.source.id),chatId:g.source.chatId,href:href(g.source.chatId,g.source.id),status:'suggested_topic'}));
}
function report(auth,businessId,options={}) {
    const id=authorize(auth,businessId);ensureSchema();DB.createSalesWorkspaceTables();
    const days=options.days===undefined?30:Number(options.days);if(![7,30,90].includes(days))fail('ANALYTICS_PERIOD_INVALID');
    const now=options.now instanceof Date?options.now:new Date();
    const since=new Date(now.getTime()-days*86400000).toISOString();
    const stageCounts=DB.all('SELECT stage,COUNT(*) count FROM customer_deals WHERE instanceId=? GROUP BY stage',[id]);
    const transitions=DB.all(`SELECT fromStage,toStage,COUNT(*) count FROM deal_stage_events
        WHERE instanceId=? AND source='transition' AND occurredAt>=? GROUP BY fromStage,toStage ORDER BY fromStage,toStage`,[id,since]);
    const timezone=require('./ava-autopilot.store').policy(id)?.timezone || 'Europe/Moscow';
    const today=require('./ava-autopilot.store').periodStart(timezone,now);
    const total=DB.get('SELECT COUNT(*) count FROM customer_deals WHERE instanceId=?',[id]).count;
    const tracked=DB.get(`SELECT COUNT(*) count FROM customer_deals d WHERE d.instanceId=? AND EXISTS
        (SELECT 1 FROM deal_stage_events e WHERE e.instanceId=d.instanceId AND e.dealId=d.id AND e.source='created')`,[id]).count;
    const closed=DB.all(`SELECT d.id,d.stage,d.createdAt,e.occurredAt FROM customer_deals d JOIN deal_stage_events e
        ON e.instanceId=d.instanceId AND e.dealId=d.id AND e.toStage=d.stage AND e.source='transition'
        WHERE d.instanceId=? AND d.stage IN ('won','lost') AND e.occurredAt>=?
        AND e.revision=(SELECT MAX(x.revision) FROM deal_stage_events x WHERE x.instanceId=d.instanceId AND x.dealId=d.id)
        AND EXISTS(SELECT 1 FROM deal_stage_events x WHERE x.instanceId=d.instanceId AND x.dealId=d.id AND x.source='created' AND x.toStage NOT IN ('won','lost'))`,[id,since]);
    const durations=closed.map(d=>({start:date(d.createdAt),end:date(d.occurredAt)})).filter(d=>d.start!==null&&d.end!==null&&d.end>=d.start).map(d=>(d.end-d.start)/86400000);
    const workload=DB.all(`SELECT u.id userId,u.displayName name,
        SUM(CASE WHEN t.status IN ('new','in_progress') THEN 1 ELSE 0 END) openTasks,
        SUM(CASE WHEN t.status IN ('new','in_progress') AND t.dueAt IS NOT NULL AND julianday(t.dueAt)<julianday(?) THEN 1 ELSE 0 END) overdueTasks
        FROM ava_business_memberships m JOIN ava_users u ON u.id=m.userId AND u.enabled=1
        LEFT JOIN manager_tasks t ON t.instanceId=m.businessId AND t.assigneeUserId=m.userId
        WHERE m.businessId=? AND m.enabled=1 AND m.role IN ('hotel_owner','sales_lead','manager') GROUP BY u.id ORDER BY openTasks DESC,u.id`,[now.toISOString(),id]);
    const risks=DB.all(`SELECT d.*,c.senderName FROM customer_deals d LEFT JOIN clients c
        ON c.instanceId=d.instanceId AND c.chatId=d.clientChatId WHERE d.instanceId=? AND d.stage NOT IN ('won','lost') ORDER BY d.updatedAt,d.id LIMIT 500`,[id])
        .map(d=>{const reasons=[];
            if(!d.nextAction||!d.nextActionAt)reasons.push('Следующее действие не назначено');
            if(d.nextActionAt&&d.nextActionAt<today)reasons.push('Срок следующего действия истёк');
            if(date(d.updatedAt)!==null&&now.getTime()-date(d.updatedAt)>7*86400000)reasons.push('Сделка без изменений более недели');
            return {chatId:d.clientChatId,dealId:d.id,title:d.title,reasons,amountMinor:d.amountMinor,currency:d.currency,href:d.clientChatId?href(d.clientChatId,'deal:'+d.id):'/deals'};})
        .filter(d=>d.reasons.length).slice(0,50);
    const lossReasons=DB.all("SELECT id,title,clientChatId,lostReason,updatedAt FROM customer_deals WHERE instanceId=? AND stage='lost' ORDER BY updatedAt DESC,id LIMIT 100",[id]).map(d=>({dealId:d.id,title:d.title,reason:d.lostReason||null,href:d.clientChatId?href(d.clientChatId,'deal:'+d.id):'/deals'}));
    authorize(auth,id);
    return {success:true,businessId:id,generatedAt:now.toISOString(),periodDays:days,periodStart:since,
        metrics:{stageCounts,transitions,winRate:closed.length?closed.filter(d=>d.stage==='won').length/closed.length*100:null,
            averageCycleDays:durations.length?durations.reduce((a,b)=>a+b,0)/durations.length:null,
            historyComplete:tracked===total,trackedDeals:tracked,totalDeals:total,closedSampleSize:closed.length,
            source:'deal_stage_events',moneyMeaning:'deal_value_not_confirmed_payment'},
        workload,risks,lossReasons,quality:quality(id,since),knowledgeSuggestions:suggestions(id,since)};
}
module.exports={ensureSchema,authorize,criteria,saveCriteria,report};
