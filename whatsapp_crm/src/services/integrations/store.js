'use strict';
const crypto = require('crypto');
const DB = require('../database.service');
const Credentials = require('../channel-credentials');
const initialized = new WeakSet();
function fail(code, statusCode = 400, extra = {}) { throw Object.assign(new Error(code), {code,statusCode,...extra}); }
function scope(id, provider) {
    if (!Number.isSafeInteger(Number(id)) || Number(id)<1 || !['amocrm','avito'].includes(provider)) fail('EXTERNAL_SCOPE_INVALID');
    return Number(id);
}
function schema() {
    if (initialized.has(DB.db)) return;
    DB.db.exec(`CREATE TABLE IF NOT EXISTS customer_external_connections (
        instanceId INTEGER NOT NULL REFERENCES instances(id), provider TEXT NOT NULL,
        configJson TEXT NOT NULL DEFAULT '{}', secrets TEXT, status TEXT NOT NULL DEFAULT 'configured',
        accountId TEXT, accountName TEXT, capabilitiesJson TEXT NOT NULL DEFAULT '{}',
        lastSuccessAt TEXT, errorCode TEXT, retryAt INTEGER, revision INTEGER NOT NULL DEFAULT 1,
        authLease TEXT, authLeaseUntil INTEGER, authState TEXT, authStateUntil INTEGER, authActorId TEXT,
        webhookToken TEXT, updatedAt INTEGER NOT NULL,
        PRIMARY KEY(instanceId,provider));
    CREATE UNIQUE INDEX IF NOT EXISTS external_account_owner ON customer_external_connections(provider,accountId) WHERE accountId IS NOT NULL;
    CREATE TABLE IF NOT EXISTS customer_external_operations (
        instanceId INTEGER NOT NULL, provider TEXT NOT NULL, operationKey TEXT NOT NULL, chatId TEXT,
        payloadHash TEXT NOT NULL, status TEXT NOT NULL, evidenceJson TEXT, errorCode TEXT,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY(instanceId,provider,operationKey));
    CREATE TABLE IF NOT EXISTS customer_external_links (
        instanceId INTEGER NOT NULL, provider TEXT NOT NULL, chatId TEXT NOT NULL,
        accountId TEXT NOT NULL, contactId TEXT, leadId TEXT, externalChatId TEXT,
        importedAt INTEGER, PRIMARY KEY(instanceId,provider,accountId,chatId));
    CREATE UNIQUE INDEX IF NOT EXISTS external_chat_link ON customer_external_links(instanceId,provider,accountId,externalChatId) WHERE externalChatId IS NOT NULL;`);
    DB.db.exec(`CREATE TABLE IF NOT EXISTS customer_external_entities (
        instanceId INTEGER NOT NULL,provider TEXT NOT NULL,accountId TEXT NOT NULL,
        kind TEXT NOT NULL,externalId TEXT NOT NULL,chatId TEXT NOT NULL,
        PRIMARY KEY(instanceId,provider,accountId,kind,externalId));`);
    DB.db.exec(`CREATE TABLE IF NOT EXISTS customer_external_progress (
        instanceId INTEGER NOT NULL,provider TEXT NOT NULL,progressKey TEXT NOT NULL,valueJson TEXT NOT NULL,
        PRIMARY KEY(instanceId,provider,progressKey));`);
    DB.db.exec(`CREATE TABLE IF NOT EXISTS customer_external_callbacks (
        instanceId INTEGER NOT NULL,provider TEXT NOT NULL,eventKey TEXT NOT NULL,payloadJson TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL,
        errorCode TEXT,createdAt INTEGER NOT NULL,PRIMARY KEY(instanceId,provider,eventKey));`);
    DB.db.exec(`CREATE TABLE IF NOT EXISTS customer_external_exports (
        instanceId INTEGER NOT NULL,provider TEXT NOT NULL,accountId TEXT NOT NULL,
        sourceType TEXT NOT NULL,sourceId TEXT NOT NULL,chatId TEXT NOT NULL,
        sourceHash TEXT NOT NULL,status TEXT NOT NULL,providerId TEXT,errorCode TEXT,updatedAt INTEGER NOT NULL,
        PRIMARY KEY(instanceId,provider,accountId,sourceType,sourceId));`);
    if(!DB.all('PRAGMA table_info(customer_external_connections)').some(c=>c.name==='authActorId'))DB.db.exec('ALTER TABLE customer_external_connections ADD COLUMN authActorId TEXT');
    if(!DB.all('PRAGMA table_info(customer_external_operations)').some(c=>c.name==='chatId'))DB.db.exec('ALTER TABLE customer_external_operations ADD COLUMN chatId TEXT');
    initialized.add(DB.db);
}
function encrypt(value,id,provider) {
    const key=Credentials.masterKey(); if(!key) fail('EXTERNAL_ENCRYPTION_KEY_REQUIRED',503);
    const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);
    c.setAAD(Buffer.from(`ava-external:v1:${scope(id,provider)}:${provider}`));
    const data=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);
    return 'ext:v1:'+Buffer.concat([iv,c.getAuthTag(),data]).toString('base64url');
}
function decrypt(value,id,provider) {
    if(!value) return {};
    try {
        const b=Buffer.from(value.slice(7),'base64url'),d=crypto.createDecipheriv('aes-256-gcm',Credentials.masterKey(),b.subarray(0,12));
        d.setAAD(Buffer.from(`ava-external:v1:${scope(id,provider)}:${provider}`)); d.setAuthTag(b.subarray(12,28));
        return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8'));
    } catch(_) { fail('EXTERNAL_CREDENTIAL_READ_FAILED',503); }
}
function get(id,provider) {
    schema(); id=scope(id,provider);
    const r=DB.get('SELECT * FROM customer_external_connections WHERE instanceId=? AND provider=?',[id,provider]);
    return r?{...r,config:JSON.parse(r.configJson),credentials:decrypt(r.secrets,id,provider),capabilities:JSON.parse(r.capabilitiesJson)}:null;
}
function save(id,provider,config,credentials) {
    schema(); id=scope(id,provider);
    return DB.db.transaction(()=>{
    if(!DB.get('SELECT 1 FROM instances WHERE id=? AND isActive=1',[id])) fail('BUSINESS_NOT_FOUND',404);
    const old=get(id,provider);
    if(old?.authLease && old.authLeaseUntil>Date.now()) fail('EXTERNAL_AUTH_IN_PROGRESS',409);
    DB.run(`INSERT INTO customer_external_connections(instanceId,provider,configJson,secrets,status,updatedAt)
        VALUES(?,?,?,?,'configured',?) ON CONFLICT(instanceId,provider) DO UPDATE SET
        configJson=excluded.configJson,secrets=excluded.secrets,revision=revision+1,updatedAt=excluded.updatedAt`,
        [id,provider,JSON.stringify(config),encrypt(credentials,id,provider),Date.now()]);
    return get(id,provider);
    }).immediate();
}
function patch(id,provider,values,revision=null) {
    schema(); id=scope(id,provider);
    const allowed=['status','accountId','accountName','lastSuccessAt','errorCode','retryAt','authLease','authLeaseUntil','authState','authStateUntil','authActorId','webhookToken'];
    const update=Object.fromEntries(Object.entries(values).filter(([k])=>allowed.includes(k)));
    if(values.credentials) update.secrets=encrypt(values.credentials,id,provider);
    if(values.capabilities) update.capabilitiesJson=JSON.stringify(values.capabilities);
    update.updatedAt=Date.now();
    try { const r=DB.run(`UPDATE customer_external_connections SET ${Object.keys(update).map(k=>k+'=?').join(',')}
        WHERE instanceId=? AND provider=?${revision==null?'':' AND revision=?'}`,
        [...Object.values(update),id,provider,...(revision==null?[]:[revision])]);
        if(!r.changes) fail('EXTERNAL_CONNECTION_CHANGED',409);
    } catch(e) { if(String(e.code).startsWith('SQLITE_CONSTRAINT')) fail('EXTERNAL_ACCOUNT_ALREADY_CONNECTED',409); throw e; }
    return get(id,provider);
}
function disconnect(id,provider) {
    const r=get(id,provider); if(!r)return;
    DB.run(`UPDATE customer_external_connections SET secrets=NULL,status='disconnected',accountId=NULL,accountName=NULL,
        capabilitiesJson='{}',authLease=NULL,authLeaseUntil=NULL,authState=NULL,authActorId=NULL,webhookToken=NULL,revision=revision+1,updatedAt=?
        WHERE instanceId=? AND provider=?`,[Date.now(),Number(id),provider]);
}
function lease(id,provider,{rotating=false}={}) {
    const r=get(id,provider); if(!r)fail('EXTERNAL_NOT_CONFIGURED',409);
    const now=Date.now(),token=crypto.randomUUID();
    if(r.authLease && r.authLeaseUntil<=now && rotating) {
        patch(id,provider,{status:'reauth_required',errorCode:'EXTERNAL_AUTH_OUTCOME_UNKNOWN'}); fail('EXTERNAL_AUTH_OUTCOME_UNKNOWN',409);
    }
    const held=DB.run(`UPDATE customer_external_connections SET authLease=?,authLeaseUntil=?
        WHERE instanceId=? AND provider=? AND revision=? AND (authLease IS NULL OR authLeaseUntil<?)`,
        [token,now+30000,Number(id),provider,r.revision,now]);
    if(!held.changes) fail('EXTERNAL_AUTH_IN_PROGRESS',409);
    return {token,revision:r.revision};
}
function release(id,provider,token) { DB.run('UPDATE customer_external_connections SET authLease=NULL,authLeaseUntil=NULL WHERE instanceId=? AND provider=? AND authLease=?',[Number(id),provider,token]); }
function begin(id,provider,key,payload,chatId=null) {
    schema();id=scope(id,provider);
    if(typeof key!=='string'||!key||key.length>300)fail('EXTERNAL_IDEMPOTENCY_REQUIRED');
    const hash=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return DB.db.transaction(()=>{
        const old=DB.get('SELECT * FROM customer_external_operations WHERE instanceId=? AND provider=? AND operationKey=?',[id,provider,key]);
        if(old) {
            if(old.payloadHash!==hash)fail('EXTERNAL_IDEMPOTENCY_CONFLICT',409);
            if(old.status==='succeeded')return {replay:true,evidence:JSON.parse(old.evidenceJson||'{}')};
            // A crashed process, timeout or successful write with lost ACK is a fence.
            if(old.status!=='failed')fail('EXTERNAL_OUTCOME_UNKNOWN',409,{unknown:true,safeToRetry:false});
            DB.run("UPDATE customer_external_operations SET status='started',errorCode=NULL,updatedAt=? WHERE instanceId=? AND provider=? AND operationKey=?",[Date.now(),id,provider,key]);
        } else DB.run("INSERT INTO customer_external_operations(instanceId,provider,operationKey,chatId,payloadHash,status,createdAt,updatedAt) VALUES(?,?,?,?,?,'started',?,?)",[id,provider,key,chatId,hash,Date.now(),Date.now()]);
        return {replay:false};
    }).immediate();
}
function finish(id,provider,key,status,evidence={},errorCode=null) {
    DB.run('UPDATE customer_external_operations SET status=?,evidenceJson=?,errorCode=?,updatedAt=? WHERE instanceId=? AND provider=? AND operationKey=?',[status,JSON.stringify(evidence),errorCode,Date.now(),Number(id),provider,key]);
}
function operation(id,provider,key) {schema();return DB.get('SELECT * FROM customer_external_operations WHERE instanceId=? AND provider=? AND operationKey=?',[Number(id),provider,key]);}
function link(id,provider,chatId,accountId,data={}) {
    schema(); return DB.db.transaction(()=>{
    const canonical=require('../client-identity.service').resolve(id,chatId);
    if(!DB.get('SELECT 1 FROM clients WHERE instanceId=? AND chatId=?',[Number(id),canonical]))fail('CLIENT_NOT_FOUND',404);
    for(const [field,kind] of [['contactId','contact'],['leadId','lead']])if(data[field]) {
        const old=entity(id,provider,accountId,kind,data[field]);
        if(old&&require('../client-identity.service').resolve(id,old.chatId)!==canonical)fail('EXTERNAL_ENTITY_LINK_CONFLICT',409);
        DB.run(`INSERT INTO customer_external_entities(instanceId,provider,accountId,kind,externalId,chatId)
            VALUES(?,?,?,?,?,?) ON CONFLICT(instanceId,provider,accountId,kind,externalId) DO UPDATE SET chatId=excluded.chatId`,[Number(id),provider,String(accountId),kind,String(data[field]),canonical]);
    }
    DB.run(`INSERT INTO customer_external_links(instanceId,provider,chatId,accountId,contactId,leadId,externalChatId,importedAt)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(instanceId,provider,accountId,chatId) DO UPDATE SET
        contactId=COALESCE(excluded.contactId,contactId),leadId=COALESCE(excluded.leadId,leadId),externalChatId=COALESCE(excluded.externalChatId,externalChatId),importedAt=excluded.importedAt`,
        [Number(id),provider,canonical,String(accountId),data.contactId||null,data.leadId||null,data.externalChatId||null,Date.now()]);
    return linked(id,provider,canonical,accountId);
    }).immediate();
}
function linked(id,provider,chatId,accountId) {schema();return DB.get('SELECT * FROM customer_external_links WHERE instanceId=? AND provider=? AND chatId=? AND accountId=?',[Number(id),provider,require('../client-identity.service').resolve(id,chatId),String(accountId)]);}
function entity(id,provider,accountId,kind,externalId){schema();return DB.get('SELECT * FROM customer_external_entities WHERE instanceId=? AND provider=? AND accountId=? AND kind=? AND externalId=?',[Number(id),provider,String(accountId),kind,String(externalId)]);}
function progress(id,provider,key,value) {
    schema();scope(id,provider);
    if(value!==undefined)DB.run('INSERT INTO customer_external_progress VALUES(?,?,?,?) ON CONFLICT(instanceId,provider,progressKey) DO UPDATE SET valueJson=excluded.valueJson',[Number(id),provider,key,JSON.stringify(value)]);
    const r=DB.get('SELECT valueJson FROM customer_external_progress WHERE instanceId=? AND provider=? AND progressKey=?',[Number(id),provider,key]);
    return r?JSON.parse(r.valueJson):null;
}
function enqueueCallback(id,provider,key,payload) {
    schema();scope(id,provider);
    const inserted=DB.run('INSERT OR IGNORE INTO customer_external_callbacks(instanceId,provider,eventKey,payloadJson,nextAt,createdAt) VALUES(?,?,?,?,?,?)',[Number(id),provider,key,JSON.stringify(payload),Date.now(),Date.now()]);
    return {accepted:true,duplicate:!inserted.changes};
}
function callbacks(provider) {schema();return DB.all("SELECT * FROM customer_external_callbacks WHERE provider=? AND status='queued' AND nextAt<=? AND attempts<8 ORDER BY createdAt LIMIT 20",[provider,Date.now()]).map(r=>({...r,payload:JSON.parse(r.payloadJson)}));}
function finishCallback(row,error=null) {DB.run('UPDATE customer_external_callbacks SET status=?,attempts=attempts+1,nextAt=?,errorCode=? WHERE instanceId=? AND provider=? AND eventKey=?',[error?(row.attempts>=7?'failed':'queued'):'done',Date.now()+Math.min(600000,10000*Math.pow(2,row.attempts)),error?.code||null,row.instanceId,row.provider,row.eventKey]);}
const messages={EXTERNAL_NOT_CONFIGURED:['Сначала подключите аккаунт.','Добавьте данные подключения.'],EXTERNAL_ACCESS_DENIED:['У аккаунта нет доступа к этому API.','Проверьте разрешения интеграции и доступ к Messenger в Авито.'],EXTERNAL_AUTH_REQUIRED:['Нужно снова подключить аккаунт.','Обновите авторизацию.'],EXTERNAL_AUTH_OUTCOME_UNKNOWN:['Подключение не подтверждено.','Подключите аккаунт заново.'],EXTERNAL_RATE_LIMITED:['Сервис временно ограничил запросы.','Повторите после указанного времени.'],EXTERNAL_TIMEOUT:['Сервис не ответил вовремя.','Проверьте подключение позже.'],EXTERNAL_OUTCOME_UNKNOWN:['Результат действия пока не подтверждён.','Проверьте историю у провайдера перед повтором.']};
function status(id,provider) {
    const r=get(id,provider);
    if(!r)return {provider,status:'not_configured',configured:false,account:null,capabilities:{},mapping:{},lastSuccessAt:null,error:null};
    const exchange={pendingCallbacks:DB.get("SELECT COUNT(*) n FROM customer_external_callbacks WHERE instanceId=? AND provider=? AND status='queued'",[Number(id),provider]).n,
        failedCallbacks:DB.get("SELECT COUNT(*) n FROM customer_external_callbacks WHERE instanceId=? AND provider=? AND status='failed'",[Number(id),provider]).n,
        unconfirmedActions:DB.get("SELECT COUNT(*) n FROM customer_external_exports WHERE instanceId=? AND provider=? AND accountId=? AND status IN ('unknown','started')",[Number(id),provider,r.accountId]).n,
        unconfirmedWrites:DB.get("SELECT COUNT(*) n FROM customer_external_operations WHERE instanceId=? AND provider=? AND status IN ('unknown','started')",[Number(id),provider]).n,
        blockedExports:DB.get("SELECT COUNT(*) n FROM customer_external_exports WHERE instanceId=? AND provider=? AND accountId=? AND status='blocked'",[Number(id),provider,r.accountId]).n};
    if(provider==='avito'&&r.accountId)exchange.historyRestrictedChats=DB.get(`SELECT COUNT(*) n FROM customer_external_progress
        WHERE instanceId=? AND provider=? AND progressKey LIKE ? AND json_extract(valueJson,'$.code')='AVITO_CHAT_SUBSCRIPTION_REQUIRED'`,
        [Number(id),provider,`chat-access:${r.accountId}:%`]).n;
    const blocked=exchange.blockedExports&&DB.get("SELECT errorCode FROM customer_external_exports WHERE instanceId=? AND provider=? AND accountId=? AND status='blocked' ORDER BY updatedAt DESC LIMIT 1",[Number(id),provider,r.accountId]);
    const code=exchange.unconfirmedActions||exchange.unconfirmedWrites?'EXTERNAL_OUTCOME_UNKNOWN':r.errorCode||blocked?.errorCode||null;
    const msg=code==='EXTERNAL_TASK_DUE_REQUIRED'?['Для передачи задачи нужен срок.','Укажите срок в задаче клиента.']:code==='EXTERNAL_TASK_STATUS_UNSUPPORTED'?['Этот статус задачи не передаётся в CRM.','Проверьте задачу в подключённой CRM.']:messages[code]||['Не удалось завершить обмен.','Проверьте подключение.'];
    return {provider,status:r.status,configured:!!r.credentials.clientId,account:r.accountId?{id:r.accountId,name:r.accountName,domain:r.config.domain||null}:null,
        config:{...(r.config.domain?{domain:r.config.domain}:{}),...(r.config.redirectUri?{redirectUri:r.config.redirectUri}:{}),clientId:r.credentials.clientId||null},
        capabilities:r.capabilities,mapping:r.config.mapping||{},exchange,lastSuccessAt:r.lastSuccessAt,error:code?{code,message:msg[0],action:msg[1],...(r.retryAt?{retryAt:r.retryAt}:{})}:null};
}
module.exports={scope,schema,get,save,patch,disconnect,lease,release,begin,finish,operation,link,linked,entity,progress,enqueueCallback,callbacks,finishCallback,status,fail,encrypt,decrypt};
