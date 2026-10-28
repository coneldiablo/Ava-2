'use strict';
const crypto = require('crypto');
const DB = require('../database.service');
const Identity = require('../identity/identity-store');
const { LIMITS, fail, did, assertPilot, day } = require('./policy');
const initialized = new WeakSet();
const uuid = () => crypto.randomUUID();
const BALANCE_SETTLEMENT_MS = 120000;
const json = value => JSON.stringify(value);
function ensureSchema() {
    if (!DB.db?.open) fail('TELEPHONY_UNAVAILABLE', 503);
    if (initialized.has(DB.db)) return;
    DB.db.exec(`
        CREATE TABLE IF NOT EXISTS ava_phone_numbers (
            id TEXT PRIMARY KEY, businessId INTEGER NOT NULL REFERENCES instances(id), number TEXT NOT NULL,
            origin TEXT NOT NULL DEFAULT 'managed', applicationId TEXT NOT NULL,
            state TEXT NOT NULL, isPrimary INTEGER NOT NULL DEFAULT 0,
            installKopecks INTEGER NOT NULL, monthlyKopecks INTEGER NOT NULL,
            sipResourceId TEXT, sipName TEXT NOT NULL, endpoint TEXT NOT NULL, encryptedCredentials TEXT,
            inboundReady INTEGER NOT NULL DEFAULT 0, outboundReady INTEGER NOT NULL DEFAULT 0,
            inboundVerifiedAt INTEGER, outboundVerifiedAt INTEGER,
            releaseAt INTEGER, releaseReason TEXT, warningAt INTEGER, activatedAt INTEGER,
            generation INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ava_phone_ownership ON ava_phone_numbers(number) WHERE state<>'released';
        CREATE UNIQUE INDEX IF NOT EXISTS ava_phone_primary ON ava_phone_numbers(businessId) WHERE isPrimary=1 AND state<>'released';
        CREATE INDEX IF NOT EXISTS ava_phone_business ON ava_phone_numbers(businessId,state);
        CREATE TABLE IF NOT EXISTS ava_phone_manual_profiles (
            businessId INTEGER PRIMARY KEY REFERENCES instances(id), sipCallerId TEXT, sipTrunkNumber TEXT
        );
        CREATE TABLE IF NOT EXISTS ava_phone_existing_profiles (
            phoneId TEXT PRIMARY KEY REFERENCES ava_phone_numbers(id), mode TEXT NOT NULL, aliasExisted INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ava_phone_sip_ownership ON ava_phone_numbers(applicationId,sipResourceId)
            WHERE state<>'released' AND sipResourceId IS NOT NULL;
        CREATE TABLE IF NOT EXISTS ava_phone_quotes (
            id TEXT PRIMARY KEY, businessId INTEGER NOT NULL REFERENCES instances(id), number TEXT NOT NULL,
            typeId INTEGER NOT NULL, regionId INTEGER NOT NULL, categoryId INTEGER NOT NULL,
            installKopecks INTEGER NOT NULL, monthlyKopecks INTEGER NOT NULL,
            numberInstall INTEGER NOT NULL, numberMonthly INTEGER NOT NULL, sipInstall INTEGER NOT NULL, sipMonthly INTEGER NOT NULL,
            expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ava_phone_operations (
            id TEXT PRIMARY KEY, businessId INTEGER NOT NULL REFERENCES instances(id), phoneId TEXT REFERENCES ava_phone_numbers(id),
            kind TEXT NOT NULL, stage TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
            actorUserId TEXT, fundingMode TEXT NOT NULL DEFAULT 'ava_pilot', grantId TEXT,
            idempotencyKey TEXT, requestHash TEXT, inputJson TEXT NOT NULL DEFAULT '{}', resultJson TEXT,
            lockId TEXT, lockAt INTEGER, spendReserved INTEGER NOT NULL DEFAULT 0, spendHoldUntil INTEGER,
            leaseToken TEXT, leaseUntil INTEGER, nextAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
            errorCode TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
            UNIQUE(businessId,idempotencyKey)
        );
        CREATE INDEX IF NOT EXISTS ava_phone_queue ON ava_phone_operations(state,nextAt,leaseUntil);
        CREATE TABLE IF NOT EXISTS ava_phone_calls (
            id TEXT PRIMARY KEY, businessId INTEGER NOT NULL REFERENCES instances(id), phoneId TEXT NOT NULL REFERENCES ava_phone_numbers(id),
            direction TEXT NOT NULL, day TEXT NOT NULL, reservedSeconds INTEGER NOT NULL,
            usedSeconds INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, channelId TEXT,
            createdAt INTEGER NOT NULL, answeredAt INTEGER, finishedAt INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ava_phone_one_outbound ON ava_phone_calls(businessId) WHERE state='reserved' AND direction='outbound';
        CREATE TABLE IF NOT EXISTS ava_phone_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ava_phone_alerts (
            id TEXT PRIMARY KEY, businessId INTEGER, phoneId TEXT, code TEXT NOT NULL, createdAt INTEGER NOT NULL,
            resolvedAt INTEGER, notifiedAt INTEGER
        );
        CREATE TRIGGER IF NOT EXISTS ava_phone_deactivation AFTER UPDATE OF isActive ON instances
        WHEN NEW.isActive=0 AND OLD.isActive<>0 BEGIN
            UPDATE ava_phone_numbers SET state='grace',releaseReason='business_inactive',
                releaseAt=CAST(strftime('%s','now') AS INTEGER)*1000+604800000,
                generation=generation+1,updatedAt=CAST(strftime('%s','now') AS INTEGER)*1000
                WHERE businessId=NEW.id AND state='active';
        END;
    `);
    // DDL performed inside a caller transaction may still roll back.
    if(!DB.db.inTransaction) initialized.add(DB.db);
}
function transaction(fn) { ensureSchema(); return DB.db.transaction(fn).immediate(); }
function phone(id) { ensureSchema(); return DB.get('SELECT * FROM ava_phone_numbers WHERE id=?', [id]); }
function operation(id) { ensureSchema(); return DB.get('SELECT * FROM ava_phone_operations WHERE id=?', [id]); }
function publicPhone(row) {
    return row && Object.fromEntries(['id','businessId','number','origin','state','isPrimary','installKopecks','monthlyKopecks',
        'inboundReady','outboundReady','inboundVerifiedAt','outboundVerifiedAt','releaseAt','warningAt','createdAt'].map(k => [k, row[k]]));
}
function publicOperation(row) {
    return row && { id: row.id, phoneId: row.phoneId, kind: row.kind, stage: row.stage, state: row.state,
        errorCode: row.errorCode, result: row.resultJson ? JSON.parse(row.resultJson) : null, createdAt: row.createdAt };
}
function insertOperation({ businessId, phoneId = null, kind, stage, actorUserId = null, input = {}, key = null, hash = null,
    spend = 0, now = Date.now(), fundingMode = 'ava_pilot', grantId = null }) {
    const id = uuid();
    DB.run(`INSERT INTO ava_phone_operations(id,businessId,phoneId,kind,stage,actorUserId,inputJson,idempotencyKey,requestHash,
        spendReserved,nextAt,createdAt,updatedAt,fundingMode,grantId) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id,businessId,phoneId,kind,stage,actorUserId,json(input),key,hash,spend,now,now,now,fundingMode,grantId]);
    return operation(id);
}
function request(businessId, kind, input, actorUserId, now = Date.now()) {
    return transaction(() => {
        if(kind!=='catalog' && kind!=='inventory') assertPilot(businessId);
        const existing = DB.get(`SELECT * FROM ava_phone_operations WHERE businessId=? AND kind=?
            AND state IN ('pending','running','reconciling') AND inputJson=? ORDER BY createdAt DESC LIMIT 1`, [businessId,kind,json(input)]);
        if (existing) return existing;
        if (DB.get('SELECT COUNT(*) AS n FROM ava_phone_operations WHERE businessId=? AND createdAt>?', [businessId,now-60000]).n >= 12)
            fail('TELEPHONY_RATE_LIMIT',429);
        return insertOperation({ businessId,kind,stage:kind,input,actorUserId,now });
    });
}
function createOrder(businessId, quoteId, key, actorUserId, now = Date.now()) {
    return transaction(() => {
        if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) fail('TELEPHONY_IDEMPOTENCY_REQUIRED');
        const hash = crypto.createHash('sha256').update(json({ quoteId })).digest('hex');
        const existing = DB.get('SELECT * FROM ava_phone_operations WHERE businessId=? AND idempotencyKey=?',[businessId,key]);
        if (existing) {
            if (existing.requestHash !== hash) fail('TELEPHONY_IDEMPOTENCY_CONFLICT',409);
            return existing;
        }
        assertPilot(businessId);
        Identity.authorizeCapability({ userId: actorUserId },businessId,'business.manage');
        const quote = DB.get('SELECT * FROM ava_phone_quotes WHERE id=? AND businessId=?',[quoteId,businessId]);
        if (!quote || quote.expiresAt <= now) fail('TELEPHONY_QUOTE_EXPIRED',409);
        if (quote.installKopecks > LIMITS.install || quote.monthlyKopecks > LIMITS.monthly) fail('TELEPHONY_PRICE_LIMIT',409);
        if (DB.get("SELECT COUNT(*) AS n FROM ava_phone_numbers WHERE businessId=? AND state<>'released'",[businessId]).n >= LIMITS.numbers)
            fail('TELEPHONY_NUMBER_LIMIT',409);
        const alias = DB.get('SELECT businessId FROM business_sip_aliases WHERE alias=?',[quote.number]);
        if (alias || DB.get("SELECT id FROM ava_phone_numbers WHERE number=? AND state<>'released'",[quote.number]))
            fail('TELEPHONY_NUMBER_ALREADY_BOUND',409);
        const balance = meta('balance');
        if (!balance || balance.updatedAt < now-90000) fail('TELEPHONY_BALANCE_PENDING',409);
        const reserved = reservedSpend();
        const spend = quote.installKopecks + quote.monthlyKopecks;
        if (JSON.parse(balance.value).kopecks - reserved < spend) fail('TELEPHONY_BALANCE_LOW',409);
        if(!DB.get("SELECT id FROM ava_phone_numbers WHERE businessId=? AND state<>'released'",[businessId])) {
            DB.run('INSERT OR IGNORE INTO ava_phone_manual_profiles(businessId,sipCallerId,sipTrunkNumber) SELECT id,sipCallerId,sipTrunkNumber FROM instances WHERE id=?',[businessId]);
        }
        const id=uuid(), endpoint=`ava-phone-${id.replaceAll('-','')}`;
        DB.run(`INSERT INTO ava_phone_numbers(id,businessId,number,applicationId,state,installKopecks,monthlyKopecks,
            sipName,endpoint,createdAt,updatedAt) VALUES(?,?,?,?,'provisioning',?,?,?,?,?,?)`,
        [id,businessId,quote.number,process.env.EXOLVE_APPLICATION_UUID || '',quote.installKopecks,quote.monthlyKopecks,
            `ava_${id.replaceAll('-','')}`,endpoint,now,now]);
        const job=insertOperation({ businessId,phoneId:id,kind:'purchase',stage:'validate',actorUserId,key,hash,spend,input:quote,now });
        syncProjection(businessId);
        return job;
    });
}
function meta(key) { ensureSchema(); return DB.get('SELECT * FROM ava_phone_meta WHERE key=?',[key]); }
function setMeta(key,value,now=Date.now()) {
    ensureSchema(); DB.run('INSERT INTO ava_phone_meta(key,value,updatedAt) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt',[key,json(value),now]);
}
// A timer cannot establish whether a balance snapshot includes a debit. Hold all
// uncertain spend for at least two minutes after terminal completion, then
// until a read that STARTED after that settlement window returns. Exolve may
// still serve the pre-purchase cached balance immediately after a successful Buy.
function reservedSpend() {
    return DB.get('SELECT COALESCE(SUM(spendReserved),0) AS n FROM ava_phone_operations').n;
}
function recordBalance(kopecks, startedAt, now=Date.now()) {
    return transaction(()=>{
        if(!Number.isSafeInteger(kopecks) || kopecks<0) fail('TELEPHONY_PRICE_INVALID');
        const old=meta('balance');
        if(old && (JSON.parse(old.value).readStartedAt || old.updatedAt)>startedAt) return;
        setMeta('balance',{kopecks,readStartedAt:startedAt},now);
        DB.run(`UPDATE ava_phone_operations SET spendReserved=0,spendHoldUntil=NULL
            WHERE state IN ('done','failed','canceled') AND spendReserved>0
            AND MAX(COALESCE(spendHoldUntil,0),updatedAt+?)<?`,[BALANCE_SETTLEMENT_MS,startedAt]);
    });
}
function assertLease(job, now=Date.now()) {
    const current=operation(job.id);
    if(!current || current.leaseToken!==job.leaseToken || current.leaseUntil<=now || current.state!=='running')
        fail('TELEPHONY_LEASE_LOST',409);
    return current;
}
function syncProjection(businessId) {
    const rows=DB.all("SELECT id,state FROM ava_phone_numbers WHERE businessId=? AND state<>'released'",[businessId]);
    const ready=rows.some(p=>p.state==='active');
    DB.run(`UPDATE business_provisioning_jobs SET status=?,stage=?,lastErrorCode=NULL,checkpointJson=?,userNextStep=?
        WHERE businessId=? AND module='telephony_sip' AND status<>'LEASED'`,[
        ready?'DONE':rows.length?'BLOCKED':'SKIPPED',ready?'ready':rows.length?'awaiting_setup':'requires_verification',
        json({managedPhoneIds:rows.map(p=>p.id)}),ready?'Номер подключён; проверьте реальный звонок':'Состояние номеров доступно в разделе Каналы → Телефония',businessId]);
}
// A release_check has no host/provider side effects. Later unsent releases
// are restored by the worker after verifying/reapplying their host endpoint.
function restoreBusiness(businessId, now=Date.now()) {
    if(!DB.get('SELECT id FROM instances WHERE id=? AND isActive=1',[businessId])) return;
    for(const p of DB.all("SELECT * FROM ava_phone_numbers WHERE businessId=? AND releaseReason='business_inactive' AND state IN ('grace','releasing')",[businessId])) {
        const job=DB.get("SELECT * FROM ava_phone_operations WHERE phoneId=? AND kind='release' AND state<>'canceled' ORDER BY createdAt DESC LIMIT 1",[p.id]);
        if(job && (job.stage!=='release_check' || (job.leaseUntil && job.leaseUntil>now))) continue;
        if(job) DB.run("UPDATE ava_phone_operations SET state='canceled',leaseToken=NULL,leaseUntil=NULL,updatedAt=? WHERE id=?",[now,job.id]);
        DB.run("UPDATE ava_phone_numbers SET state='active',releaseAt=NULL,releaseReason=NULL,warningAt=NULL,inboundReady=CASE WHEN origin='external' THEN 0 ELSE 1 END,outboundReady=CASE WHEN origin='external' OR id IN (SELECT phoneId FROM ava_phone_existing_profiles WHERE mode='inbound_only') THEN 0 ELSE 1 END,generation=generation+CASE WHEN origin='external' THEN 0 ELSE 1 END,updatedAt=? WHERE id=?",[now,p.id]);
        if(p.origin==='external') {
            // The existing business-deactivation trigger advances generation.
            // Restore via a durable, drained reapply rather than trusting the old host revision.
            const actor=DB.get("SELECT actorUserId FROM ava_phone_operations WHERE phoneId=? AND kind='external_apply' AND actorUserId IS NOT NULL ORDER BY createdAt DESC,rowid DESC LIMIT 1",[p.id]);
            DB.run("UPDATE ava_phone_numbers SET state='provisioning' WHERE id=?",[p.id]);
            insertOperation({businessId,phoneId:p.id,kind:'external_apply',stage:'external_validate',actorUserId:actor?.actorUserId,input:{revision:p.generation},now,fundingMode:'external'});
        }
        DB.run("UPDATE ava_phone_alerts SET resolvedAt=? WHERE phoneId=? AND code='TELEPHONY_RELEASE_WARNING'",[now,p.id]);
    }
    syncProjection(businessId);
}
function lease(now=Date.now(), kinds=null) {
    return transaction(() => {
        const row = DB.get(`SELECT * FROM ava_phone_operations WHERE state IN ('pending','running','reconciling')
            AND nextAt<=? AND (leaseUntil IS NULL OR leaseUntil<=?) ${kinds?'AND kind IN ('+kinds.map(()=>'?').join(',')+')':''} ORDER BY nextAt,createdAt LIMIT 1`,[now,now,...(kinds || [])]);
        if (!row) return null;
        const token=uuid();
        DB.run("UPDATE ava_phone_operations SET leaseToken=?,leaseUntil=?,state='running',attempts=attempts+1 WHERE id=?",[token,now+60000,row.id]);
        return {...operation(row.id),leaseToken:token};
    });
}
function advance(job, stage, values={}, now=Date.now()) {
    const allowed=['state','lockId','lockAt','resultJson','errorCode','spendReserved','spendHoldUntil'];
    if (Object.keys(values).some(k=>!allowed.includes(k))) fail('TELEPHONY_STATE_INVALID',500);
    if(['done','failed','canceled'].includes(values.state) && (values.spendReserved ?? job.spendReserved)>0) {
        values={...values,spendHoldUntil:Math.max(now+BALANCE_SETTLEMENT_MS,values.spendHoldUntil || 0)};
    }
    const entries=Object.entries(values);
    const changed=DB.run(`UPDATE ava_phone_operations SET stage=?,updatedAt=?${entries.map(([k])=>`,${k}=?`).join('')}
        WHERE id=? AND leaseToken=? AND leaseUntil>?`,[stage,now,...entries.map(([,v])=>v),job.id,job.leaseToken,now]);
    if (!changed.changes) fail('TELEPHONY_LEASE_LOST',409);
    Object.assign(job,values,{stage});
}
function defer(job, code=null, now=Date.now(), delay=10000) {
    DB.run(`UPDATE ava_phone_operations SET state='reconciling',errorCode=?,nextAt=?,leaseToken=NULL,leaseUntil=NULL,updatedAt=?
        WHERE id=? AND leaseToken=? AND leaseUntil>? AND state='running'`,[code,now+delay,now,job.id,job.leaseToken,now]);
}
function alert(code, phoneRow=null, now=Date.now()) {
    ensureSchema();
    const id=`${code}:${phoneRow?.id || 'provider'}`;
    DB.run(`INSERT INTO ava_phone_alerts(id,businessId,phoneId,code,createdAt) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET notifiedAt=CASE WHEN resolvedAt IS NOT NULL THEN NULL ELSE notifiedAt END,
            createdAt=CASE WHEN resolvedAt IS NOT NULL THEN excluded.createdAt ELSE createdAt END,resolvedAt=NULL`,[id,phoneRow?.businessId || null,phoneRow?.id || null,code,now]);
}
function activate(job, now=Date.now(), options={}) {
    return transaction(() => {
        advance(job,'active',{state:'done',errorCode:null},now);
        const p=phone(job.phoneId);
        if(!(options.existing && job.fundingMode==='existing_operator')) Identity.authorizeCapability({userId:job.actorUserId},p.businessId,'business.manage');
        if(options.existing && p.origin==='existing') require('./existing').assertGrant(p.businessId,p.number);
        else if(!(options.external&&p.origin==='external')) assertPilot(p.businessId);
        if (p.state!=='provisioning') fail('TELEPHONY_ACTIVATION_CHANGED',409);
        const conflict=DB.get('SELECT businessId FROM business_sip_aliases WHERE alias=? AND businessId<>?',[p.number,p.businessId]);
        if (conflict) fail('TELEPHONY_NUMBER_ALREADY_BOUND',409);
        DB.run('INSERT OR IGNORE INTO business_sip_aliases(alias,businessId) VALUES(?,?)',[p.number,p.businessId]);
        const i=DB.get('SELECT sipAliases FROM instances WHERE id=? AND isActive=1',[p.businessId]);
        if (!i) fail('BUSINESS_NOT_FOUND',404);
        const aliases=[...new Set([...JSON.parse(i.sipAliases || '[]'),p.number])];
        const currentProfile=DB.get('SELECT sipCallerId,sipTrunkNumber FROM instances WHERE id=?',[p.businessId]);
        const primary=options.external&&p.isPrimary===1||!DB.get("SELECT id FROM ava_phone_numbers WHERE businessId=? AND isPrimary=1 AND state<>'released'",[p.businessId])
            &&(!options.external||!currentProfile.sipCallerId&&!currentProfile.sipTrunkNumber);
        DB.run("UPDATE ava_phone_numbers SET state='active',inboundReady=1,outboundReady=?,isPrimary=?,activatedAt=?,updatedAt=? WHERE id=?",[options.outbound===false?0:1,primary?1:0,now,now,p.id]);
        DB.run(`UPDATE instances SET sipAliases=?${primary?',sipCallerId=?,sipTrunkNumber=?':''} WHERE id=?`,
            primary?[json(aliases),p.number,p.endpoint,p.businessId]:[json(aliases),p.businessId]);
        syncProjection(p.businessId);
        DB.run('UPDATE ava_phone_alerts SET resolvedAt=? WHERE phoneId=? AND resolvedAt IS NULL',[now,p.id]);
        return phone(p.id);
    });
}
function resolve(number) {
    ensureSchema(); const normalized=did(number);
    const row=DB.get(`SELECT p.*,i.voiceContextName FROM ava_phone_numbers p JOIN instances i ON i.id=p.businessId
        WHERE p.number=? AND p.state='active' AND p.inboundReady=1 AND i.isActive=1`,[normalized]);
    if (!row) {
        // Explicit, operator-verified legacy routes only. A disabled managed DID
        // can never escape into a legacy mapping or the default business.
        if(DB.get("SELECT id FROM ava_phone_numbers WHERE number=? AND state<>'released'",[normalized])) fail('TELEPHONY_DID_UNAVAILABLE',404);
        let legacy={};try {legacy=JSON.parse(process.env.AVA_TELEPHONY_LEGACY_DIDS || '{}');} catch(_) {}
        const businessId=legacy[normalized];
        const i=Number.isSafeInteger(businessId) && DB.get(`SELECT i.id,i.voiceContextName FROM instances i
            JOIN business_sip_aliases a ON a.businessId=i.id WHERE a.alias=? AND i.id=? AND i.isActive=1`,[normalized,businessId]);
        if(!i) fail('TELEPHONY_DID_UNAVAILABLE',404);
        return {businessId:i.id,phoneId:null,number:normalized,contextName:i.voiceContextName || `business-${i.id}`,legacy:true};
    }
    if(row.origin==='existing') require('./existing').assertGrant(row.businessId,row.number);
    return { businessId:row.businessId,phoneId:row.id,number:row.number,contextName:row.voiceContextName || `business-${row.businessId}` };
}
function source(businessId, sourceId=null) {
    ensureSchema();
    if(!Number.isSafeInteger(businessId) || businessId<1) fail('TELEPHONY_SCOPE_INVALID');
    if(sourceId!=null && (typeof sourceId!=='string' || !/^[a-f0-9-]{36}$/.test(sourceId))) fail('TELEPHONY_SOURCE_UNAVAILABLE',409);
    const managed=DB.get("SELECT id FROM ava_phone_numbers WHERE businessId=? AND state<>'released'",[businessId]);
    if (!managed && !sourceId) return { managed:false };
    const row=sourceId?phone(sourceId):DB.get("SELECT * FROM ava_phone_numbers WHERE businessId=? AND isPrimary=1 AND state='active'",[businessId]);
    if(!row&&!sourceId&&!DB.get("SELECT 1 FROM ava_phone_numbers WHERE businessId=? AND state<>'released' AND origin<>'external'",[businessId])){
        const legacy=DB.get('SELECT sipCallerId,sipTrunkNumber FROM instances WHERE id=? AND isActive=1',[businessId]);
        if(legacy?.sipTrunkNumber&&!legacy.sipTrunkNumber.startsWith('ava-phone-')&&DB.get('SELECT 1 FROM business_sip_aliases WHERE businessId=? AND alias=?',[businessId,legacy.sipCallerId]))return{managed:false};
    }
    if (!row || row.businessId!==businessId || row.state!=='active' || !row.outboundReady
        || !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1',[businessId])) fail('TELEPHONY_SOURCE_UNAVAILABLE',409);
    if(row.origin==='existing') require('./existing').assertGrant(row.businessId,row.number);
    if (process.env.AVA_TELEPHONY_OUTBOUND_ENABLED!=='true') fail('TELEPHONY_OUTBOUND_DISABLED',409);
    return { managed:true,phoneId:row.id,number:row.number,endpoint:row.endpoint,maxSeconds:LIMITS.maxCallSeconds };
}
function dailyUsage(businessId, now=Date.now()) {
    ensureSchema();
    const start=Date.parse(day(now)+'T00:00:00+03:00'), end=start+86400000;
    return DB.all(`SELECT state,reservedSeconds,usedSeconds,finishedAt FROM ava_phone_calls
        WHERE businessId=? AND direction='outbound' AND (state='reserved' OR
        (finishedAt>? AND finishedAt-usedSeconds*1000<?))`,[businessId,start,end]).reduce((total,c)=>total+
        (c.state==='reserved'?c.reservedSeconds:Math.max(0,Math.ceil((Math.min(c.finishedAt,end)-Math.max(c.finishedAt-c.usedSeconds*1000,start))/1000))),0);
}
function reserveCall({businessId,sourceId=null,callId,direction='outbound',number=null}, now=Date.now()) {
    return transaction(()=>{
        if(!['inbound','outbound'].includes(direction) || !Number.isSafeInteger(businessId) || businessId<1) fail('TELEPHONY_CALL_INVALID');
        if (typeof callId!=='string' || !/^[\w.:-]{1,120}$/.test(callId)) fail('TELEPHONY_CALL_INVALID');
        const old=DB.get('SELECT * FROM ava_phone_calls WHERE id=?',[callId]);
        if (old) {
            if(old.businessId!==businessId || old.direction!==direction || old.state!=='reserved'
                || (sourceId && old.phoneId!==sourceId) || (direction==='inbound' && phone(old.phoneId)?.number!==did(number))) fail('TELEPHONY_CALL_CONFLICT',409);
            const p=phone(old.phoneId);
            if (direction==='outbound') return {...source(businessId,p.id),callId,maxSeconds:old.reservedSeconds};
            return {...resolve(p.number),callId};
        }
        const route=direction==='outbound'?source(businessId,sourceId):resolve(number);
        if(direction==='inbound' && route.businessId!==businessId) fail('TELEPHONY_SCOPE_MISMATCH',403);
        if(direction==='inbound' && route.legacy) return {...route,managed:false};
        if (route.managed===false) return route;
        if(route.businessId!=null && route.businessId!==businessId) fail('TELEPHONY_SCOPE_MISMATCH',403);
        let seconds=0;
        if(direction==='outbound') {
            if(DB.get("SELECT id FROM ava_phone_calls WHERE businessId=? AND direction='outbound' AND state='reserved'",[businessId]))
                fail('TELEPHONY_CONCURRENT_LIMIT',409);
            const spent=dailyUsage(businessId,now);
            seconds=Math.min(LIMITS.maxCallSeconds,LIMITS.dailySeconds-spent);
            if(seconds<=0) fail('TELEPHONY_DAILY_LIMIT',409);
            const last=DB.get("SELECT MAX(createdAt) AS t FROM ava_phone_calls WHERE businessId=? AND direction='outbound'",[businessId]).t;
            if(last && now-last<10000) fail('TELEPHONY_INTERVAL_LIMIT',409);
        }
        DB.run(`INSERT INTO ava_phone_calls(id,businessId,phoneId,direction,day,reservedSeconds,state,createdAt)
            VALUES(?,?,?,?,?,?,'reserved',?)`,[callId,businessId,route.phoneId,direction,day(now),seconds,now]);
        return {...route,callId,maxSeconds:seconds};
    });
}
function finishCall(callId,{businessId,seconds=0,channelId=null},now=Date.now()) {
    return transaction(()=>{
        const c=DB.get('SELECT * FROM ava_phone_calls WHERE id=?',[callId]);
        if(!c || c.businessId!==businessId) fail('TELEPHONY_CALL_NOT_FOUND',404);
        if((channelId!==null && (typeof channelId!=='string' || !/^[\w.:-]{1,120}$/.test(channelId))) || !Number.isFinite(seconds) || seconds<0 || seconds>86400) fail('TELEPHONY_CALL_INVALID');
        if(c.state==='finished') return {success:true};
        DB.run("UPDATE ava_phone_calls SET state='finished',usedSeconds=?,channelId=COALESCE(?,channelId),answeredAt=?,finishedAt=? WHERE id=?",[Math.ceil(seconds),channelId,seconds>0?now-Math.ceil(seconds)*1000:null,now,callId]);
        const field=c.direction==='inbound'?'inboundVerifiedAt':'outboundVerifiedAt';
        if(seconds>0) DB.run(`UPDATE ava_phone_numbers SET ${field}=? WHERE id=?`,[now,c.phoneId]);
        return {success:true};
    });
}
function primary(businessId,id) {
    return transaction(()=>{
        const p=phone(id);
        if(!p || p.businessId!==businessId || p.state!=='active') fail('TELEPHONY_SOURCE_UNAVAILABLE',409);
        DB.run('UPDATE ava_phone_numbers SET isPrimary=0 WHERE businessId=?',[businessId]);
        DB.run('UPDATE ava_phone_numbers SET isPrimary=1 WHERE id=?',[id]);
        DB.run('UPDATE instances SET sipCallerId=?,sipTrunkNumber=? WHERE id=?',[p.number,p.endpoint,businessId]);
        return publicPhone(phone(id));
    });
}
function release(businessId,id,cancel=false,now=Date.now()) {
    return transaction(()=>{
        const p=phone(id);
        if(!p || p.businessId!==businessId || !['managed','existing'].includes(p.origin)) fail('TELEPHONY_NUMBER_NOT_FOUND',404);
        const deleting=DB.get("SELECT id FROM ava_phone_operations WHERE phoneId=? AND kind='release' AND state<>'canceled'",[id]);
        if(deleting || !['active','grace'].includes(p.state)) fail('TELEPHONY_RELEASE_IN_PROGRESS',409);
        if(cancel && !DB.get('SELECT id FROM instances WHERE id=? AND isActive=1',[businessId])) fail('BUSINESS_NOT_FOUND',404);
        DB.run(`UPDATE ava_phone_numbers SET state=?,releaseAt=?,releaseReason=?,warningAt=NULL,generation=generation+1,updatedAt=? WHERE id=?`,
            [cancel?'active':'grace',cancel?null:now+LIMITS.graceMs,cancel?null:'owner_request',now,id]);
        syncProjection(businessId);
        if(cancel) DB.run("UPDATE ava_phone_alerts SET resolvedAt=? WHERE phoneId=? AND code='TELEPHONY_RELEASE_WARNING'",[now,id]);
        return publicPhone(phone(id));
    });
}
function protectProfile(businessId, values) {
    ensureSchema();
    const rows=DB.all("SELECT * FROM ava_phone_numbers WHERE state<>'released'");
    if(rows.some(p=>p.businessId===Number(businessId)) && ['sipCallerId','sipTrunkNumber','sipAliases'].some(k=>values[k]!==undefined)) {
        const current=DB.get('SELECT sipAliases,sipCallerId,sipTrunkNumber FROM instances WHERE id=?',[businessId]);
        for(const k of ['sipAliases','sipCallerId','sipTrunkNumber']) {
            const a=k==='sipAliases' && typeof current?.[k]==='string'?JSON.parse(current[k]):current?.[k];
            const b=k==='sipAliases' && typeof values[k]==='string'?JSON.parse(values[k]):values[k];
            if(values[k]!==undefined && json(a)!==json(b)) fail('TELEPHONY_MANAGED_PROFILE_READ_ONLY',409);
        }
    }
    const aliases=values.sipAliases===undefined?[]:typeof values.sipAliases==='string'?JSON.parse(values.sipAliases):values.sipAliases;
    for(const value of [...(Array.isArray(aliases)?aliases:[]),values.sipCallerId,values.sipTrunkNumber].filter(Boolean)) {
        if(typeof value==='string' && value.trim().startsWith('ava-phone-')
            && !rows.some(p=>p.businessId===Number(businessId) && p.endpoint===value.trim())) fail('TELEPHONY_NUMBER_ALREADY_BOUND',409);
        let normalized; try { normalized=did(value); } catch (_) { continue; }
        if(rows.some(p=>p.number===normalized && p.businessId!==Number(businessId))) fail('TELEPHONY_NUMBER_ALREADY_BOUND',409);
    }
}
module.exports={ensureSchema,transaction,uuid,phone,operation,publicPhone,publicOperation,insertOperation,request,createOrder,
    meta,setMeta,recordBalance,reservedSpend,assertLease,syncProjection,restoreBusiness,lease,advance,defer,alert,activate,resolve,source,dailyUsage,reserveCall,finishCall,primary,release,protectProfile};
