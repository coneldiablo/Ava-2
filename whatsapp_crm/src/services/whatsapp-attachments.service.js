'use strict';
const crypto=require('crypto');
const DB=require('./database.service');
const OpenWA=require('./openwa.service');
const initialized=new WeakSet();
function ensureSchema(){
    if(initialized.has(DB.db))return;
    DB.db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_document_deliveries(
        businessId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,documentKey TEXT NOT NULL,recipient TEXT NOT NULL,
        sha256 TEXT NOT NULL,sessionId TEXT NOT NULL,status TEXT NOT NULL,leaseToken TEXT,leaseUntil INTEGER NOT NULL,
        providerMessageId TEXT,errorCode TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,
        PRIMARY KEY(businessId,documentKey,recipient)
    )`);initialized.add(DB.db);
}
function result(row,replayed=false){return{success:row.status==='accepted',status:row.status==='accepted'?'accepted':row.status==='failed'?'failed':'unknown',
    providerMessageId:row.providerMessageId||null,provider_message_id:row.providerMessageId||null,replayed,
    safeToRetry:row.status==='failed',code:row.errorCode||undefined};}
async function send(instance,recipient,document,{beforeDispatch}={}){
    ensureSchema();
    const invalid=()=>({success:false,status:'failed',safeToRetry:true,code:'WHATSAPP_DOCUMENT_INVALID'});
    if(!instance?.id||document?.businessId!==instance.id||typeof beforeDispatch!=='function'||typeof document.documentKey!=='string'
        ||document.documentKey.length>250||!document.documentKey.startsWith(`commercial:${instance.id}:`)
        ||!Buffer.isBuffer(document.buffer)||document.buffer.length>10*1024*1024||document.buffer.subarray(0,5).toString()!=='%PDF-'
        ||document.mimeType!=='application/pdf'||typeof document.filename!=='string'||!document.filename.endsWith('.pdf')
        ||/[\r\n/\\\x00]/.test(document.filename)||document.filename.length>200||typeof recipient!=='string'
        ||!/^\d{7,15}@(c\.us|s\.whatsapp\.net)$|^[A-Za-z0-9]+@lid$/.test(recipient))return invalid();
    const digest=crypto.createHash('sha256').update(document.buffer).digest('hex');
    if(digest!==document.sha256)return invalid();
    if(!instance.openWaSessionId||instance.whatsappProvider==='green_api')return{success:false,status:'failed',safeToRetry:true,code:'WHATSAPP_DOCUMENT_PROVIDER_UNSUPPORTED'};
    const scope=[instance.id,document.documentKey,recipient],token=crypto.randomUUID();
    const claimed=DB.db.transaction(()=>{
        const row=DB.get('SELECT * FROM whatsapp_document_deliveries WHERE businessId=? AND documentKey=? AND recipient=?',scope);
        if(row&&row.sha256!==digest)return{error:invalid()};
        if(row&&['accepted','unknown'].includes(row.status))return{error:result(row,true)};
        if(row&&row.status==='dispatching'){
            if(row.leaseUntil>Date.now())return{error:{success:false,status:'unknown',safeToRetry:false,code:'WHATSAPP_DOCUMENT_IN_PROGRESS'}};
            DB.run("UPDATE whatsapp_document_deliveries SET status='unknown',errorCode='WHATSAPP_DOCUMENT_ACK_UNKNOWN' WHERE businessId=? AND documentKey=? AND recipient=?",scope);
            return{error:{success:false,status:'unknown',safeToRetry:false,code:'WHATSAPP_DOCUMENT_ACK_UNKNOWN'}};
        }
        if(row&&row.status==='reserved'&&row.leaseUntil>Date.now())return{error:{success:false,status:'failed',safeToRetry:true,code:'WHATSAPP_DOCUMENT_IN_PROGRESS'}};
        DB.run(`INSERT INTO whatsapp_document_deliveries(businessId,documentKey,recipient,sha256,sessionId,status,leaseToken,leaseUntil,createdAt,updatedAt)
            VALUES(?,?,?,?,?,'reserved',?,?,?,?) ON CONFLICT(businessId,documentKey,recipient) DO UPDATE SET
            sessionId=excluded.sessionId,status='reserved',leaseToken=excluded.leaseToken,leaseUntil=excluded.leaseUntil,errorCode=NULL,updatedAt=excluded.updatedAt`,
            [...scope,digest,instance.openWaSessionId,token,Date.now()+60000,Date.now(),Date.now()]);
        return{ok:true};
    }).immediate();
    if(claimed.error)return claimed.error;
    let dispatching=false;
    try{
        await beforeDispatch();
        const current=DB.get('SELECT isActive,openWaSessionId,whatsappProvider FROM instances WHERE id=?',[instance.id]);
        if(!current?.isActive||current.openWaSessionId!==instance.openWaSessionId||current.whatsappProvider==='green_api')throw Object.assign(new Error(),{code:'WHATSAPP_DOCUMENT_CONNECTION_CHANGED'});
        const updated=DB.run("UPDATE whatsapp_document_deliveries SET status='dispatching',updatedAt=? WHERE businessId=? AND documentKey=? AND recipient=? AND leaseToken=? AND status='reserved' AND leaseUntil>?",[Date.now(),...scope,token,Date.now()]);
        if(updated.changes!==1)throw Object.assign(new Error(),{code:'WHATSAPP_DOCUMENT_LEASE_LOST'});
        dispatching=true;
        const sent=await OpenWA.sendDocument(instance.openWaUrl,instance.openWaApiKey,instance.openWaSessionId,recipient,document);
        const status=sent.success?'accepted':sent.safeToRetry?'failed':'unknown';
        DB.run('UPDATE whatsapp_document_deliveries SET status=?,providerMessageId=?,errorCode=?,updatedAt=? WHERE businessId=? AND documentKey=? AND recipient=? AND leaseToken=?',
            [status,sent.providerMessageId||null,sent.code||null,Date.now(),...scope,token]);
        return result(DB.get('SELECT * FROM whatsapp_document_deliveries WHERE businessId=? AND documentKey=? AND recipient=?',scope));
    }catch(error){
        const status=dispatching?'unknown':'failed';
        const code=dispatching?'WHATSAPP_DOCUMENT_ACK_UNKNOWN':/^([A-Z_]+)$/.test(error.code||'')?error.code:'WHATSAPP_DOCUMENT_GUARD_FAILED';
        DB.run('UPDATE whatsapp_document_deliveries SET status=?,errorCode=?,updatedAt=? WHERE businessId=? AND documentKey=? AND recipient=? AND leaseToken=?',[status,code,Date.now(),...scope,token]);
        return{success:false,status,safeToRetry:!dispatching,code};
    }
}
module.exports={ensureSchema,send};
