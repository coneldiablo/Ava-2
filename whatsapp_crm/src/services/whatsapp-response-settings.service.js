'use strict';
const DB = require('./database.service');
const initialized = new WeakSet();
function ensureSchema() {
    if (initialized.has(DB.db)) return;
    DB.db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_response_settings (
        businessId INTEGER PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
        delaySeconds INTEGER NOT NULL DEFAULT 0 CHECK(delaySeconds BETWEEN 0 AND 300),
        revision INTEGER NOT NULL DEFAULT 1,updatedAt INTEGER NOT NULL,
        typingEnabled INTEGER NOT NULL DEFAULT 0 CHECK(typingEnabled IN (0,1))
    )`);
    if(!DB.all('PRAGMA table_info(whatsapp_response_settings)').some(c=>c.name==='typingEnabled'))
        DB.db.exec('ALTER TABLE whatsapp_response_settings ADD COLUMN typingEnabled INTEGER NOT NULL DEFAULT 0 CHECK(typingEnabled IN (0,1))');
    initialized.add(DB.db);
}
function tenant(value) { if (!Number.isSafeInteger(Number(value)) || Number(value)<1) throw Object.assign(new Error('BUSINESS_INVALID'),{code:'BUSINESS_INVALID',statusCode:400}); return Number(value); }
function get(businessId) {
    ensureSchema(); const row=DB.get('SELECT * FROM whatsapp_response_settings WHERE businessId=?',[tenant(businessId)]);
    return {delaySeconds:row?.delaySeconds || 0,revision:row?.revision || 0,maxDelaySeconds:300,...(row?.typingEnabled?{typingEnabled:true}:{})};
}
function save(businessId,input={}) {
    ensureSchema(); const id=tenant(businessId);
    if (!Number.isInteger(input.delaySeconds) || input.delaySeconds<0 || input.delaySeconds>300
        || !Number.isInteger(input.revision) || input.revision<0 || Object.keys(input).some(k=>!['delaySeconds','revision','typingEnabled'].includes(k))
        || (input.typingEnabled!==undefined&&typeof input.typingEnabled!=='boolean'))
        throw Object.assign(new Error('WHATSAPP_RESPONSE_SETTINGS_INVALID'),{code:'WHATSAPP_RESPONSE_SETTINGS_INVALID',statusCode:400});
    return DB.db.transaction(()=>{
        const current=get(id); if(current.revision!==input.revision) throw Object.assign(new Error('WHATSAPP_RESPONSE_SETTINGS_CHANGED'),{code:'WHATSAPP_RESPONSE_SETTINGS_CHANGED',statusCode:409});
        DB.run(`INSERT INTO whatsapp_response_settings(businessId,delaySeconds,revision,updatedAt,typingEnabled) VALUES(?,?,?,?,?)
            ON CONFLICT(businessId) DO UPDATE SET delaySeconds=excluded.delaySeconds,revision=excluded.revision,updatedAt=excluded.updatedAt,typingEnabled=excluded.typingEnabled`,[id,input.delaySeconds,input.revision+1,Date.now(),Number(input.typingEnabled??current.typingEnabled??false)]);
        // Recalculate only unsent work. An accepted/unknown send is never reset.
        if(DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='whatsapp_reply_jobs'"))
            DB.run(`UPDATE whatsapp_reply_jobs SET nextAt=MAX(0,(SELECT MAX(other.createdAt) FROM whatsapp_reply_jobs other
                    WHERE other.instanceId=whatsapp_reply_jobs.instanceId AND other.chatId=whatsapp_reply_jobs.chatId)+?),leaseToken=NULL,state='queued'
                WHERE instanceId=? AND state IN ('queued','processing')`,[input.delaySeconds*1000,id]);
        return get(id);
    }).immediate();
}
module.exports={ensureSchema,get,save};
