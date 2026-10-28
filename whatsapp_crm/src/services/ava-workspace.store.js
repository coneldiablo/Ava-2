'use strict';
const crypto = require('crypto');
const os = require('os');
const DB = require('./database.service');
const Canonical = require('./client-identity.service');
const initialized = new WeakSet();
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const dispatchOwner = {hostname:os.hostname(),pid:process.pid,processToken:crypto.randomUUID()};
function fail(code, statusCode = 400) { throw Object.assign(new Error(code), {code, statusCode}); }
function scope(businessId, chatId) {
    const id = Number(businessId);
    if (!Number.isSafeInteger(id) || id < 1) fail('BUSINESS_SCOPE_REQUIRED');
    if (typeof chatId !== 'string' || !chatId || chatId.length > 300) fail('WORKSPACE_INPUT_INVALID');
    const canonical = Canonical.resolve(id, chatId);
    const row = DB.get('SELECT * FROM clients WHERE instanceId=? AND chatId=?', [id, canonical]);
    if (!row) fail('WORKSPACE_CLIENT_NOT_FOUND', 404);
    return row;
}
function ensureSchema() {
    if (!DB.db) fail('WORKSPACE_UNAVAILABLE', 503);
    if (initialized.has(DB.db)) return;
    require('./identity/identity-store').ensureSchema();
    DB.createSalesWorkspaceTables();
    require('./customer-deals.store').ensureSchema();
    DB.db.exec(`
        CREATE TABLE IF NOT EXISTS ava_conversation_control (
            businessId INTEGER NOT NULL, chatId TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'ai' CHECK(mode IN ('ai','human')),
            revision INTEGER NOT NULL DEFAULT 1, reason TEXT, actorUserId TEXT,
            activeSendId TEXT, activeSendStatus TEXT, updatedAt TEXT NOT NULL,
            PRIMARY KEY(businessId,chatId), FOREIGN KEY(businessId,chatId) REFERENCES clients(instanceId,chatId) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS ava_client_promises (
            id TEXT PRIMARY KEY, businessId INTEGER NOT NULL, chatId TEXT NOT NULL, summary TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','cancelled')), dueAt TEXT,
            duePrecision TEXT, deadlineUnresolved INTEGER NOT NULL DEFAULT 0, assigneeUserId TEXT,
            sourceType TEXT NOT NULL, sourceId TEXT, sourceText TEXT, sourceOffset INTEGER,
            revision INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
            completedBy TEXT, completionEvidence TEXT, FOREIGN KEY(businessId,chatId) REFERENCES clients(instanceId,chatId) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS ava_promises_scope ON ava_client_promises(businessId,chatId,status,dueAt);
        CREATE UNIQUE INDEX IF NOT EXISTS ava_promises_evidence ON ava_client_promises(businessId,sourceType,sourceId,sourceOffset) WHERE sourceType<>'manual';
        CREATE TABLE IF NOT EXISTS ava_call_transcript_sources (
            businessId INTEGER NOT NULL, chatId TEXT NOT NULL, sourceId TEXT NOT NULL, text TEXT NOT NULL,
            sourceHash TEXT NOT NULL, timestamp TEXT NOT NULL, PRIMARY KEY(businessId,sourceId),
            FOREIGN KEY(businessId,chatId) REFERENCES clients(instanceId,chatId) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS ava_workspace_snoozes (
            businessId INTEGER NOT NULL, userId TEXT NOT NULL, chatId TEXT NOT NULL, until TEXT NOT NULL,
            PRIMARY KEY(businessId,userId,chatId), FOREIGN KEY(businessId,chatId) REFERENCES clients(instanceId,chatId) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS ava_saved_views (
            id TEXT PRIMARY KEY, businessId INTEGER NOT NULL REFERENCES instances(id), userId TEXT NOT NULL,
            name TEXT NOT NULL, filtersJson TEXT NOT NULL, createdAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ava_workspace_message_authorship (
            businessId INTEGER NOT NULL, chatId TEXT NOT NULL, messageId INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            userId TEXT, origin TEXT NOT NULL CHECK(origin='human'), createdAt TEXT NOT NULL,
            PRIMARY KEY(businessId,messageId), FOREIGN KEY(businessId,chatId) REFERENCES clients(instanceId,chatId) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS ava_workspace_reply_actions (
            id TEXT PRIMARY KEY, businessId INTEGER NOT NULL, chatId TEXT NOT NULL, userId TEXT NOT NULL,
            idempotencyKey TEXT NOT NULL, textHash TEXT NOT NULL, controlRevision INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('sending','sent','failed','unknown')), messageId TEXT,
            createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(businessId,userId,idempotencyKey),
            FOREIGN KEY(businessId,chatId) REFERENCES clients(instanceId,chatId) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS ava_workspace_document_actions (
            actionId TEXT PRIMARY KEY REFERENCES ava_workspace_reply_actions(id) ON DELETE CASCADE,
            businessId INTEGER NOT NULL, documentKey TEXT NOT NULL, recipient TEXT NOT NULL, sha256 TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ava_workspace_reply_scope ON ava_workspace_reply_actions(businessId,chatId,status,createdAt);
        CREATE TABLE IF NOT EXISTS ava_workspace_reply_evidence (
            actionId TEXT PRIMARY KEY REFERENCES ava_workspace_reply_actions(id) ON DELETE CASCADE,
            businessId INTEGER NOT NULL, chatId TEXT NOT NULL, messageId INTEGER NOT NULL,
            providerMessageId TEXT NOT NULL, textHash TEXT NOT NULL, createdAt TEXT NOT NULL,
            UNIQUE(businessId,messageId)
        );
        CREATE TABLE IF NOT EXISTS ava_workspace_reply_resolutions (
            id TEXT PRIMARY KEY, actionId TEXT NOT NULL UNIQUE REFERENCES ava_workspace_reply_actions(id) ON DELETE CASCADE,
            businessId INTEGER NOT NULL, chatId TEXT NOT NULL, previousStatus TEXT NOT NULL,
            outcome TEXT NOT NULL CHECK(outcome IN ('sent','failed')), actorUserId TEXT NOT NULL,
            actorRole TEXT NOT NULL CHECK(actorRole IN ('hotel_owner','sales_lead')),
            method TEXT NOT NULL CHECK(method IN ('provider_ack','leadership_confirmation')),
            reason TEXT NOT NULL, evidenceMessageId INTEGER, providerMessageId TEXT, createdAt TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS ava_workspace_search USING fts5(
            businessId UNINDEXED, type UNINDEXED, sourceId UNINDEXED, chatId UNINDEXED, title, content, tokenize='unicode61'
        );
    `);
    // Additive migration: old reservations retain their key/hash and unknown outcome.
    const replyColumns = new Set(DB.all('PRAGMA table_info(ava_workspace_reply_actions)').map(row=>row.name));
    for (const column of ['text','dispatchStartedAt','dispatchCompletedAt','dispatchOwnerJson']) {
        if (!replyColumns.has(column)) DB.db.exec(`ALTER TABLE ava_workspace_reply_actions ADD COLUMN ${column} TEXT`);
    }
    const definitions = [
        {table:'clients',type:'client',id:'chatId',chat:'chatId',title:"COALESCE(senderName,'')",content:"COALESCE(lastMessage,'')"},
        {table:'messages',type:'message',id:'id',chat:'chatId',title:"COALESCE(senderName,'Сообщение')",content:"COALESCE(content,'')"},
        {table:'customer_deals',type:'deal',id:'id',chat:'clientChatId',title:'title',content:"COALESCE(notes,'') || ' ' || COALESCE(nextAction,'')"},
        {table:'conversation_events',type:'call',id:'eventId',chat:'chatId',title:"COALESCE(callId,'Звонок')",content:"COALESCE(content,'')",condition:"callId IS NOT NULL"},
    ];
    for (const d of definitions) {
        const expression = (value, alias) => value.replace(/\b(senderName|lastMessage|content|notes|nextAction|title|callId)\b/g, alias + '.$1');
        const callContent = alias => `COALESCE((SELECT text FROM ava_call_transcript_sources WHERE businessId=${alias}.instanceId AND sourceId=${alias}.eventId),${expression(d.content,alias)})`;
        const insert = alias => `INSERT INTO ava_workspace_search(businessId,type,sourceId,chatId,title,content) SELECT ${alias}.instanceId,'${d.type}',CAST(${alias}.${d.id} AS TEXT),${alias}.${d.chat},${expression(d.title,alias)},${d.type==='call'?callContent(alias):expression(d.content,alias)}${d.condition ? ` WHERE ${alias}.${d.condition}` : ''};`;
        DB.db.exec(`CREATE TRIGGER IF NOT EXISTS ava_search_${d.table}_insert AFTER INSERT ON ${d.table} BEGIN ${insert('NEW')} END;
            CREATE TRIGGER IF NOT EXISTS ava_search_${d.table}_delete AFTER DELETE ON ${d.table} BEGIN DELETE FROM ava_workspace_search WHERE businessId=OLD.instanceId AND type='${d.type}' AND sourceId=CAST(OLD.${d.id} AS TEXT); END;
            CREATE TRIGGER IF NOT EXISTS ava_search_${d.table}_update AFTER UPDATE ON ${d.table} BEGIN DELETE FROM ava_workspace_search WHERE businessId=OLD.instanceId AND type='${d.type}' AND sourceId=CAST(OLD.${d.id} AS TEXT); ${insert('NEW')} END;`);
        DB.run(`INSERT INTO ava_workspace_search(businessId,type,sourceId,chatId,title,content)
            SELECT s.instanceId,'${d.type}',CAST(s.${d.id} AS TEXT),s.${d.chat},${expression(d.title,'s')},${d.type==='call'?callContent('s'):expression(d.content,'s')} FROM ${d.table} s
            WHERE ${d.condition ? 's.' + d.condition + ' AND ' : ''}NOT EXISTS(SELECT 1 FROM ava_workspace_search f WHERE f.businessId=s.instanceId AND f.type=? AND f.sourceId=CAST(s.${d.id} AS TEXT))`, [d.type]);
    }
    initialized.add(DB.db);
}
function controlRow(businessId,chatId) {
    ensureSchema(); const client=scope(businessId,chatId);
    DB.run('INSERT OR IGNORE INTO ava_conversation_control(businessId,chatId,updatedAt) VALUES(?,?,?)',[client.instanceId,client.chatId,new Date().toISOString()]);
    return DB.get('SELECT * FROM ava_conversation_control WHERE businessId=? AND chatId=?',[client.instanceId,client.chatId]);
}
function controlView(row) { return {mode:row.mode,revision:row.revision,reason:row.reason || null,updatedAt:row.updatedAt,...(row.activeSendId?{sendInProgress:true,sendStatus:row.activeSendStatus}: {})}; }
function getControl(businessId,chatId) { return controlView(controlRow(businessId,chatId)); }
function setControl({businessId,chatId,mode,reason=null,revision,actorUserId=null}) {
    if (!['ai','human'].includes(mode) || reason!=null && (typeof reason!=='string'||reason.length>500) || revision!==undefined && (!Number.isSafeInteger(revision)||revision<1)) fail('WORKSPACE_INPUT_INVALID');
    ensureSchema();
    return DB.db.transaction(()=> {
        const row=controlRow(businessId,chatId);
        if(revision!==undefined && row.revision!==revision) fail('WORKSPACE_CONTROL_CONFLICT',409);
        if(row.activeSendId) fail('WORKSPACE_SEND_IN_PROGRESS',409);
        DB.run('UPDATE ava_conversation_control SET mode=?,revision=revision+1,reason=?,actorUserId=?,updatedAt=? WHERE businessId=? AND chatId=? AND revision=?',[mode,reason,actorUserId,new Date().toISOString(),row.businessId,row.chatId,row.revision]);
        if(mode==='human' && DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='whatsapp_reply_jobs'"))
            require('./whatsapp.service').cancelPending(row.businessId,row.chatId,'WHATSAPP_HUMAN_TAKEOVER');
        return getControl(row.businessId,row.chatId);
    }).immediate();
}
function assertAiAllowed(businessId,chatId,revision) {
    const row=controlRow(businessId,chatId);
    if(row.mode!=='ai') fail('WORKSPACE_HUMAN_CONTROL',409);
    if(revision!==undefined && row.revision!==revision) fail('WORKSPACE_CONTROL_CONFLICT',409);
    if(row.activeSendId) fail('WORKSPACE_SEND_IN_PROGRESS',409);
    return controlView(row);
}
function beginSend({businessId,chatId,revision,sendId,mode}) {
    if(typeof sendId!=='string'||!sendId||sendId.length>250) fail('WORKSPACE_INPUT_INVALID');
    return DB.db.transaction(()=> {
        const row=controlRow(businessId,chatId);
        if(row.mode!==mode) fail(mode==='ai'?'WORKSPACE_HUMAN_CONTROL':'WORKSPACE_CONTROL_CONFLICT',409);
        if(revision!==undefined && row.revision!==revision) fail('WORKSPACE_CONTROL_CONFLICT',409);
        if(row.activeSendId) fail('WORKSPACE_SEND_IN_PROGRESS',409);
        DB.run("UPDATE ava_conversation_control SET activeSendId=?,activeSendStatus='sending' WHERE businessId=? AND chatId=?",[sendId,row.businessId,row.chatId]);
        return controlView(row);
    }).immediate();
}
function beginAiSend(input) {return beginSend({...input,mode:'ai'});}
function beginHumanSend(input) {return beginSend({...input,mode:'human'});}
function endAiSend({businessId,chatId,sendId,status}) {
    if(!['sent','failed','unknown'].includes(status)) fail('WORKSPACE_INPUT_INVALID');
    const row=controlRow(businessId,chatId);
    if(row.activeSendId!==sendId) fail('WORKSPACE_SEND_CONFLICT',409);
    if(status==='unknown') DB.run("UPDATE ava_conversation_control SET activeSendStatus='unknown' WHERE businessId=? AND chatId=? AND activeSendId=?",[row.businessId,row.chatId,sendId]);
    else DB.run('UPDATE ava_conversation_control SET activeSendId=NULL,activeSendStatus=NULL WHERE businessId=? AND chatId=? AND activeSendId=?',[row.businessId,row.chatId,sendId]);
    return getControl(row.businessId,row.chatId);
}
function markReplyDispatch({businessId,chatId,actionId}) {
    ensureSchema();const client=scope(businessId,chatId);
    return DB.db.transaction(()=>{
    const action=DB.get("SELECT a.id FROM ava_workspace_reply_actions a JOIN ava_conversation_control c ON c.businessId=a.businessId AND c.chatId=a.chatId WHERE a.businessId=? AND a.chatId=? AND a.id=? AND a.status='sending' AND a.dispatchStartedAt IS NULL AND c.activeSendId=a.id AND c.activeSendStatus='sending' AND c.mode='human' AND c.revision=a.controlRevision",[client.instanceId,client.chatId,actionId]);
    if(!action)fail('WORKSPACE_SEND_CONFLICT',409);
    DB.run('UPDATE ava_workspace_reply_actions SET dispatchStartedAt=?,dispatchOwnerJson=COALESCE(dispatchOwnerJson,?) WHERE businessId=? AND id=?',[new Date().toISOString(),replyDispatchOwner(),client.instanceId,actionId]);
    }).immediate();
}
function replyDispatchOwner() {return JSON.stringify(dispatchOwner);}
function abandonedReplyDispatch(action) {
    let owner;try{owner=JSON.parse(action.dispatchOwnerJson);}catch(_){return false;}
    if(!owner||owner.hostname!==dispatchOwner.hostname||!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.processToken!=='string'||!owner.processToken)return false;
    // A container restart reuses PID 1 and hostname, but cannot retain this
    // process's random token. The previous incarnation is demonstrably gone.
    if(owner.pid===dispatchOwner.pid&&owner.processToken!==dispatchOwner.processToken)return true;
    try{process.kill(owner.pid,0);return false;}catch(error){return error.code==='ESRCH';}
}
// Called only by the authenticated reply path with the adapter's exact stored ID and ACK.
// Similar message text alone is deliberately insufficient to establish provenance.
function recordReplyAcknowledgement({businessId,chatId,actionId,messageId,providerMessageId}) {
    ensureSchema();const client=scope(businessId,chatId);
    if(Number.isSafeInteger(providerMessageId))providerMessageId=String(providerMessageId);
    if(!Number.isSafeInteger(messageId)||messageId<1||typeof providerMessageId!=='string'||!providerMessageId.trim()||providerMessageId.length>500)fail('WORKSPACE_RECOVERY_EVIDENCE_INVALID');
    return DB.db.transaction(()=>{
    const action=DB.get('SELECT * FROM ava_workspace_reply_actions WHERE businessId=? AND chatId=? AND id=?',[client.instanceId,client.chatId,actionId]);
    const message=DB.get("SELECT content FROM messages WHERE instanceId=? AND chatId=? AND id=? AND role IN ('assistant','manager','human','agent')",[client.instanceId,client.chatId,messageId]);
    if(!action||!action.dispatchStartedAt||!message||hash(message.content)!==action.textHash||action.messageId&&action.messageId!==providerMessageId)fail('WORKSPACE_RECOVERY_EVIDENCE_INVALID');
    const existing=DB.get('SELECT * FROM ava_workspace_reply_evidence WHERE actionId=? OR (businessId=? AND messageId=?)',[actionId,client.instanceId,messageId]);
    if(existing){if(existing.actionId!==actionId||existing.messageId!==messageId||existing.providerMessageId!==providerMessageId)fail('WORKSPACE_RECOVERY_EVIDENCE_CONFLICT',409);return existing;}
    DB.run('INSERT INTO ava_workspace_reply_evidence(actionId,businessId,chatId,messageId,providerMessageId,textHash,createdAt) VALUES(?,?,?,?,?,?,?)',[actionId,client.instanceId,client.chatId,messageId,providerMessageId,action.textHash,new Date().toISOString()]);
    return DB.get('SELECT * FROM ava_workspace_reply_evidence WHERE actionId=?',[actionId]);
    }).immediate();
}
function recordManualMessage({businessId,chatId,messageId,userId=null}) {ensureSchema();const client=scope(businessId,chatId);const message=DB.get("SELECT id FROM messages WHERE instanceId=? AND chatId=? AND id=? AND role IN ('assistant','manager','human','agent')",[client.instanceId,client.chatId,messageId]);if(!message)fail('WORKSPACE_SOURCE_INVALID');DB.run("INSERT OR IGNORE INTO ava_workspace_message_authorship(businessId,chatId,messageId,userId,origin,createdAt) VALUES(?,?,?,?,'human',?)",[client.instanceId,client.chatId,messageId,userId,new Date().toISOString()]);}
function activeAssignee(businessId,userId) {
    if(!userId) return null;
    return DB.get(`SELECT u.id FROM ava_users u JOIN ava_business_memberships m ON m.userId=u.id WHERE u.id=? AND u.enabled=1 AND m.businessId=? AND m.enabled=1 AND m.role IN ('hotel_owner','sales_lead','manager')`,[userId,businessId])?.id || null;
}
function promiseView(row) {
    return {id:row.id,chatId:row.chatId,summary:row.summary,status:row.status,dueAt:row.dueAt,assigneeUserId:activeAssignee(row.businessId,row.assigneeUserId),sourceType:row.sourceType,sourceId:row.sourceId,sourceText:row.sourceText,sourceOffset:row.sourceOffset,revision:row.revision,createdAt:row.createdAt,duePrecision:row.duePrecision,deadlineUnresolved:!!row.deadlineUnresolved,completedBy:row.completedBy,completionEvidence:row.completionEvidence};
}
function promises(businessId,chatId=null,status=null) {
    ensureSchema(); const params=[Number(businessId)],clauses=['businessId=?'];
    if(chatId!==null){clauses.push('chatId=?');params.push(scope(businessId,chatId).chatId);}
    if(status!==null){if(!['open','done','cancelled'].includes(status)) fail('WORKSPACE_INPUT_INVALID');clauses.push('status=?');params.push(status);}
    return DB.all(`SELECT * FROM ava_client_promises WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC,id LIMIT 500`,params).map(promiseView);
}
function createPromise({businessId,chatId,summary,dueAt=null,duePrecision=null,deadlineUnresolved=false,sourceType='manual',sourceId=null,sourceText=null,sourceOffset=null,assigneeUserId=null,createdAt=new Date().toISOString()}) {
    ensureSchema(); const client=scope(businessId,chatId);
    const id=sourceType==='manual'?'promise_'+crypto.randomUUID():'promise_'+hash(`${client.instanceId}:${sourceType}:${sourceId}:${sourceOffset}`);
    DB.run(`INSERT OR IGNORE INTO ava_client_promises(id,businessId,chatId,summary,dueAt,duePrecision,deadlineUnresolved,assigneeUserId,sourceType,sourceId,sourceText,sourceOffset,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,client.instanceId,client.chatId,summary,dueAt,duePrecision,deadlineUnresolved?1:0,activeAssignee(client.instanceId,assigneeUserId??client.assigneeUserId),sourceType,sourceId==null?null:String(sourceId),sourceText,sourceOffset,createdAt,new Date().toISOString()]);
    return promiseView(DB.get('SELECT * FROM ava_client_promises WHERE businessId=? AND id=?',[client.instanceId,id]));
}
function dateInstant(value) {
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value))) fail('WORKSPACE_INPUT_INVALID');
    const calendar=new Date(value.slice(0,10)+'T00:00:00Z');
    if(calendar.toISOString().slice(0,10)!==value.slice(0,10)) fail('WORKSPACE_INPUT_INVALID');
    return new Date(value).toISOString();
}
function businessSettings(businessId) {if(!DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ava_autopilot_policies'"))return {};const row=DB.get('SELECT payloadJson FROM ava_autopilot_policies WHERE businessId=?',[businessId]);try{return JSON.parse(row?.payloadJson||'{}');}catch(_){return {};}}
function workingMinutes(start,end,{timezone:tz='Europe/Moscow',workHours={start:'00:00',end:'00:00'},workDays=[1,2,3,4,5,6,7]}={},stopAfter=Infinity) {
    const from=new Date(start).getTime(),to=new Date(end).getTime();if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from)return 0;
    const p=localParts(new Date(from),tz),last=localParts(new Date(to),tz),firstDay=Date.UTC(p.year,p.month-1,p.day),lastDay=Date.UTC(last.year,last.month-1,last.day);
    const minute=value=>{const [h,m]=value.split(':').map(Number);return h*60+m;},a=minute(workHours.start),b=minute(workHours.end),ranges=a===b?[[0,1440]]:a<b?[[a,b]]:[[0,b],[a,1440]];let total=0;
    for(let date=firstDay;date<=lastDay;date+=86400000){const d=new Date(date);if(!workDays.includes(d.getUTCDay()||7))continue;for(const [begin,finish]of ranges){const next=new Date(date+(finish===1440?86400000:0)),left=zonedInstant(d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate(),Math.floor(begin/60),begin%60,0,tz),right=zonedInstant(next.getUTCFullYear(),next.getUTCMonth()+1,next.getUTCDate(),finish===1440?0:Math.floor(finish/60),finish%60,0,tz);if(left&&right)total+=Math.max(0,Math.min(to,Date.parse(right))-Math.max(from,Date.parse(left)))/60000;if(total>=stopAfter)return total;}}return total;
}
function timezone(businessId) {
    const row=DB.get('SELECT * FROM instances WHERE id=?',[businessId]);
    const policyTimezone=businessSettings(businessId).timezone;
    const value=policyTimezone||row?.timezone||row?.timeZone||(row?.businessType==='hotel'?row?.hotelTimezone:null)||'Europe/Moscow';
    try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format(new Date());return value;}catch(_){return 'Europe/Moscow';}
}
function localParts(timestamp,tz) {
    return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(timestamp).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
}
function zonedInstant(year,month,day,hour,minute,second,tz) {
    const target=Date.UTC(year,month-1,day,hour,minute,second);let value=target;
    for(let n=0;n<3;n++){const p=localParts(new Date(value),tz);value+=target-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);}
    const p=localParts(new Date(value),tz);
    return p.year===year&&p.month===month&&p.day===day&&p.hour===hour&&p.minute===minute?new Date(value).toISOString():null;
}
function deadline(text,timestamp,businessId) {
    const iso=text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})/);
    if(iso){try{return {dueAt:dateInstant(iso[0]),duePrecision:'instant',deadlineUnresolved:false};}catch(_){return {dueAt:null,duePrecision:null,deadlineUnresolved:true};}}
    const tz=timezone(businessId),today=localParts(new Date(timestamp),tz);
    let {year,month,day}=today,hasDate=false;
    const relative=text.match(/\b(today|tomorrow)\b|(?:^|\s)(сегодня|завтра|послезавтра)(?=\s|[,!.?]|$)/i);
    if(relative){const term=relative[0].trim().toLowerCase();const d=new Date(Date.UTC(year,month-1,day+(term==='завтра'||term==='tomorrow'?1:term==='послезавтра'?2:0)));year=d.getUTCFullYear();month=d.getUTCMonth()+1;day=d.getUTCDate();hasDate=true;}
    const calendar=text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/),short=text.match(/(?:^|\s)(\d{1,2})\.(\d{2})(?:\.(\d{4}))?(?=\s|[,!]|$)/);
    if(calendar){year=+calendar[1];month=+calendar[2];day=+calendar[3];hasDate=true;}else if(short){day=+short[1];month=+short[2];year=short[3]?+short[3]:year;hasDate=true;}
    const clock=text.match(/(?:\b|\s)([01]?\d|2[0-3]):([0-5]\d)(?=\s|[,!.?]|$)/);
    if(!hasDate)return {dueAt:null,duePrecision:null,deadlineUnresolved:/на днях|позже|недел|завтра|today|tomorrow|soon|later|next|\d|когда/i.test(text)};
    const valid=new Date(Date.UTC(year,month-1,day));
    if(valid.getUTCFullYear()!==year||valid.getUTCMonth()+1!==month||valid.getUTCDate()!==day)return {dueAt:null,duePrecision:null,deadlineUnresolved:true};
    const dueAt=zonedInstant(year,month,day,clock?+clock[1]:23,clock?+clock[2]:59,clock?0:59,tz);
    return {dueAt,duePrecision:clock?'instant':'day',deadlineUnresolved:!dueAt};
}
function recordCallTranscript({businessId,chatId,sourceId,text,timestamp}) {
    ensureSchema();const client=scope(businessId,chatId);
    const event=DB.get('SELECT * FROM conversation_events WHERE instanceId=? AND chatId=? AND eventId=? AND callId IS NOT NULL',[client.instanceId,client.chatId,String(sourceId)]);
    if(!event||typeof text!=='string'||!text||text.length>200000)fail('WORKSPACE_SOURCE_INVALID');
    const existing=DB.get('SELECT * FROM ava_call_transcript_sources WHERE businessId=? AND sourceId=?',[client.instanceId,String(sourceId)]);
    if(existing&&(existing.chatId!==client.chatId||existing.sourceHash!==hash(text)))fail('WORKSPACE_SOURCE_CONFLICT',409);
    DB.run('INSERT OR IGNORE INTO ava_call_transcript_sources(businessId,chatId,sourceId,text,sourceHash,timestamp) VALUES(?,?,?,?,?,?)',[client.instanceId,client.chatId,String(sourceId),text,hash(text),timestamp?dateInstant(timestamp):new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(event.createdAt)?event.createdAt:event.createdAt.replace(' ','T')+'Z').toISOString()]);
    DB.run("UPDATE ava_workspace_search SET content=? WHERE businessId=? AND type='call' AND sourceId=?",[text,client.instanceId,String(sourceId)]);
    return existing||DB.get('SELECT * FROM ava_call_transcript_sources WHERE businessId=? AND sourceId=?',[client.instanceId,String(sourceId)]);
}
function ingestPromises({businessId,chatId,sourceType,sourceId,text,timestamp,assigneeUserId}) {
    ensureSchema();const client=scope(businessId,chatId);let source,parts=[];
    if(sourceType==='message') {
        source=DB.get('SELECT * FROM messages WHERE instanceId=? AND chatId=? AND CAST(id AS TEXT)=?',[client.instanceId,client.chatId,String(sourceId)]);
        if(!source||!['assistant','manager','human','agent'].includes(source.role))return [];
        if(text!==undefined&&text!==source.content)fail('WORKSPACE_SOURCE_INVALID');
        text=source.content;timestamp=source.timestamp;
        parts=[{text,offset:0}];
    } else if(sourceType==='call'||sourceType==='event') {
        source=DB.get('SELECT * FROM ava_call_transcript_sources WHERE businessId=? AND chatId=? AND sourceId=?',[client.instanceId,client.chatId,String(sourceId)]);
        if(!source)fail('WORKSPACE_SOURCE_INVALID');
        if(text!==undefined&&text!==source.text)fail('WORKSPACE_SOURCE_INVALID');
        text=source.text;timestamp=source.timestamp;
        let offset=0;
        for(const line of text.split('\n')){const own=line.match(/^\s*(assistant|agent|manager|bot|operator|бот|менеджер|оператор)\s*:\s*(.+)$/i);if(own)parts.push({text:own[2],offset:offset+line.indexOf(own[2])});offset+=line.length+1;}
        sourceType='call';
    } else fail('WORKSPACE_SOURCE_INVALID');
    const instant=new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(timestamp)?timestamp:timestamp.replace(' ','T')+'Z');
    if(!Number.isFinite(instant.getTime()))fail('WORKSPACE_SOURCE_INVALID');
    const results=[];
    for(const part of parts) {
        const chunks=part.text.matchAll(/(?:[^.!?\n]|\.(?=\d))+(?:[.!?](?=\s|$)|$)/g);
        for(const match of chunks){const sentence=match[0].trim();
            if(!/(?:^|[\s,])(пришлю|отправлю|отправим|подготовлю|подготовим|перезвоню|перезвоним|свяжусь|свяжемся|проверю|проверим|уточню|уточним|вернусь|вернемся)(?=[\s,!:.]|$)|\b(?:I|we)(?:\s+(?:will|shall)|['’]ll)\s+(?:send|call|prepare|check|contact|confirm)\b/i.test(sentence)||/\?|(?:^|\s)не\s+(?:пришлю|отправлю|отправим|подготовлю|подготовим|перезвоню|перезвоним|свяжусь|свяжемся|проверю|проверим|уточню|уточним|вернусь|вернемся)|если|\bif\b|вы сказали|клиент сказал|клиент обещал|(?:quote|цитата)\s*:/i.test(sentence))continue;
            const offset=part.offset+match.index+match[0].indexOf(sentence);
            results.push(createPromise({businessId:client.instanceId,chatId:client.chatId,summary:sentence.slice(0,800),sourceType,sourceId:String(sourceId),sourceText:sentence,sourceOffset:offset,assigneeUserId,...deadline(sentence,instant,client.instanceId),createdAt:instant.toISOString()}));
        }
    }
    return results;
}
function cleanupMember(businessId,userId) {ensureSchema();DB.run('UPDATE ava_client_promises SET assigneeUserId=NULL WHERE businessId=? AND assigneeUserId=?',[businessId,userId]);DB.run('DELETE FROM ava_saved_views WHERE businessId=? AND userId=?',[businessId,userId]);DB.run('DELETE FROM ava_workspace_snoozes WHERE businessId=? AND userId=?',[businessId,userId]);}
function assertNoPendingSend(businessId,chatId=null) {const clause=chatId===null?'':' AND chatId=?',params=chatId===null?[businessId]:[businessId,chatId];if(DB.get('SELECT 1 FROM ava_conversation_control WHERE businessId=? AND activeSendId IS NOT NULL'+clause,params)||DB.get("SELECT 1 FROM ava_workspace_reply_actions WHERE businessId=? AND status IN ('sending','unknown')"+clause,params))fail('WORKSPACE_SEND_IN_PROGRESS',409);}
function unlinkClient(businessId,chatId) {ensureSchema();return DB.db.transaction(()=>{assertNoPendingSend(businessId,chatId);for(const table of ['ava_client_promises','ava_call_transcript_sources','ava_conversation_control','ava_workspace_snoozes','ava_workspace_reply_actions','ava_workspace_message_authorship'])DB.run(`DELETE FROM ${table} WHERE businessId=? AND chatId=?`,[businessId,chatId]);}).immediate();}
function removeBusiness(businessId){ensureSchema();return DB.db.transaction(()=>{assertNoPendingSend(businessId);for(const table of ['ava_client_promises','ava_call_transcript_sources','ava_conversation_control','ava_workspace_snoozes','ava_workspace_reply_actions','ava_workspace_message_authorship','ava_saved_views','ava_workspace_search'])DB.run(`DELETE FROM ${table} WHERE businessId=?`,[businessId]);}).immediate();}
function mergeClient(businessId,fromChatId,toChatId) {
    ensureSchema();if(!DB.db.inTransaction)fail('WORKSPACE_TRANSACTION_REQUIRED',503);
    const controls=DB.all('SELECT * FROM ava_conversation_control WHERE businessId=? AND chatId IN (?,?)',[businessId,fromChatId,toChatId]);
    assertNoPendingSend(businessId,fromChatId);assertNoPendingSend(businessId,toChatId);
    if(controls.some(c=>c.mode==='human')) {const target=controlRow(businessId,toChatId);setControl({businessId,chatId:toChatId,mode:'human',revision:target.revision,reason:'Объединение клиента: участие менеджера сохранено'});}
    DB.run('DELETE FROM ava_conversation_control WHERE businessId=? AND chatId=?',[businessId,fromChatId]);
    DB.run('INSERT OR IGNORE INTO ava_workspace_snoozes SELECT businessId,userId,?,until FROM ava_workspace_snoozes WHERE businessId=? AND chatId=?',[toChatId,businessId,fromChatId]);DB.run('DELETE FROM ava_workspace_snoozes WHERE businessId=? AND chatId=?',[businessId,fromChatId]);
    for(const table of ['ava_client_promises','ava_call_transcript_sources','ava_workspace_reply_actions','ava_workspace_reply_evidence','ava_workspace_reply_resolutions','ava_workspace_message_authorship'])DB.run(`UPDATE ${table} SET chatId=? WHERE businessId=? AND chatId=?`,[toChatId,businessId,fromChatId]);
}
module.exports={ensureSchema,scope,getControl,setControl,assertAiAllowed,beginAiSend,beginHumanSend,endAiSend,markReplyDispatch,replyDispatchOwner,abandonedReplyDispatch,recordReplyAcknowledgement,recordManualMessage,recordCallTranscript,ingestPromises,promises,createPromise,promiseView,activeAssignee,dateInstant,timezone,businessSettings,workingMinutes,cleanupMember,unlinkClient,removeBusiness,mergeClient};
