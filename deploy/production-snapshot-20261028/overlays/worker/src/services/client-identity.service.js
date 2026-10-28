'use strict';
const DB = require('./database.service');
const {createHash}=require('crypto');
function fail(code, statusCode = 400, extra = {}) { throw Object.assign(new Error(code), { code, statusCode, ...extra }); }
function normalize(kind, value) {
    const raw = String(value ?? '').trim();
    if (kind === 'avito' && /^[1-9]\d{0,29}:[A-Za-z0-9_-]{1,160}$/.test(raw)) return raw;
    if (kind === 'telegram' && /^-?[1-9]\d{0,19}$/.test(raw)) return raw;
    if (kind === 'whatsapp' && /^[1-9]\d{6,14}@(c\.us|s\.whatsapp\.net)$/.test(raw)) return raw.replace('@s.whatsapp.net', '@c.us');
    if (kind === 'email' && raw.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(raw)) return raw.toLowerCase();
    if (kind === 'vk' && /^[1-9]\d{0,9}$/.test(raw) && Number(raw)<2000000000) return raw;
    if (kind === 'max' && /^(?:user:[1-9]\d{0,19}|chat:-?[1-9]\d{0,19})$/.test(raw)) return raw;
    if (kind === 'phone' && /^\+?[\d ()-]+$/.test(raw)) {
        let digits = raw.replace(/\D/g, '');
        if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
        if (digits.length >= 7 && digits.length <= 15) return '+' + digits;
    }
    fail('INVALID_ALIAS');
}
const initialized = new WeakSet();
function schema() {
    if (initialized.has(DB.db)) return;
    DB.db.exec(`CREATE TABLE IF NOT EXISTS client_aliases (id INTEGER PRIMARY KEY, instanceId INTEGER NOT NULL, chatId TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, createdAt TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(instanceId,kind,value));
    CREATE TABLE IF NOT EXISTS client_redirects (instanceId INTEGER NOT NULL, oldChatId TEXT NOT NULL, chatId TEXT NOT NULL, UNIQUE(instanceId,oldChatId));
    CREATE TABLE IF NOT EXISTS client_merge_archive (id INTEGER PRIMARY KEY, instanceId INTEGER NOT NULL, targetChatId TEXT NOT NULL, sourceChatId TEXT NOT NULL, tableName TEXT NOT NULL, rowJson TEXT NOT NULL, createdAt TEXT DEFAULT CURRENT_TIMESTAMP);`);
    DB.ensureMessageOriginSchema();
    initialized.add(DB.db);
}
function canonical(instanceId, chatId) {
    schema(); let current = String(chatId); const seen = new Set();
    while (!seen.has(current)) { seen.add(current); const row = DB.get('SELECT chatId FROM client_redirects WHERE instanceId=? AND oldChatId=?',[instanceId,current]); if (!row) return current; current = row.chatId; }
    fail('IDENTITY_REDIRECT_CYCLE',409);
}
function resolve(instanceId, chatId) {
    schema(); const raw = String(chatId);
    let kind, value;
    if (raw.startsWith('avito:')) { kind='avito'; value=normalize(kind,raw.slice(6)); }
    else if (raw.startsWith('tg_')) { kind='telegram'; value=raw.slice(3); }
    else if (/^vk_[1-9]\d*$/.test(raw)) { kind='vk'; value=normalize(kind,raw.slice(3)); }
    else if (/^max_[1-9]\d*$/.test(raw)) { kind='max'; value=normalize(kind,'user:'+raw.slice(4)); }
    else if (/^(?:user|chat):-?\d+$/.test(raw)) { kind='max'; value=normalize(kind,raw); }
    else if (/^[1-9]\d{6,14}@(c\.us|s\.whatsapp\.net)$/.test(raw)) { kind='whatsapp'; value=normalize(kind,raw); }
    else if (/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(raw)) { kind='email'; value=normalize(kind,raw); }
    else if (/^\+?\d{7,15}$/.test(raw)) { kind='phone'; value=normalize(kind,raw); }
    let alias = kind && DB.get('SELECT chatId FROM client_aliases WHERE instanceId=? AND kind=? AND value=?',[instanceId,kind,value]);
    // A complete WhatsApp number is an exact phone identity. Never match LIDs,
    // usernames, suffixes or opaque chat identifiers to a phone alias.
    if (!alias && kind==='whatsapp') alias=DB.get("SELECT chatId FROM client_aliases WHERE instanceId=? AND kind='phone' AND value=?",[instanceId,normalize('phone',value.split('@')[0])]);
    if (!alias && kind==='phone') alias=DB.get("SELECT chatId FROM client_aliases WHERE instanceId=? AND kind='whatsapp' AND value=?",[instanceId,value.slice(1)+'@c.us']);
    return canonical(instanceId, alias?.chatId || raw);
}
function client(instanceId, chatId) {
    const id = canonical(instanceId, chatId);
    const row = DB.get('SELECT * FROM clients WHERE instanceId=? AND chatId=?',[instanceId,id]);
    if (!row) fail('CLIENT_NOT_FOUND',404); return row;
}
function list(instanceId, chatId) {
    const target = client(instanceId,chatId);
    const aliases=DB.all('SELECT id,kind,value FROM client_aliases WHERE instanceId=? AND chatId=? ORDER BY id',[instanceId,target.chatId]);
    const add=(kind,value)=> { if(!aliases.some(a=>a.kind===kind&&a.value===value)) aliases.unshift({id:null,kind,value,primary:true}); };
    if (/^tg_-?[1-9]\d*$/.test(target.chatId)) add('telegram',target.chatId.slice(3));
    if (/^[1-9]\d{6,14}@(c\.us|s\.whatsapp\.net)$/.test(target.chatId)) add('whatsapp',normalize('whatsapp',target.chatId));
    if (target.chatId.startsWith('avito:')) add('avito',normalize('avito',target.chatId.slice(6)));
    if (target.telegramChatId) add('telegram',String(target.telegramChatId));
    const validAdd=(kind,value)=>{try{add(kind,normalize(kind,value));}catch{ /* A legacy invalid contact cannot block the customer's other channels. */ }};
    if (target.emailAddress) validAdd('email',target.emailAddress);
    if (target.vkPeerId || target.vkUserId) validAdd('vk',target.vkPeerId || target.vkUserId);
    if (target.maxUserId) validAdd('max','user:'+target.maxUserId);
    if (target.maxChatId) validAdd('max','chat:'+target.maxChatId);
    return {canonicalChatId:target.chatId, aliases};
}
function preserveNativeContacts(instanceId, row, allowedOwners=[row.chatId]) {
    for (const alias of list(instanceId,row.chatId).aliases.filter(item=>item.primary&&['telegram','email','vk','max'].includes(item.kind))) {
        let value;try{value=normalize(alias.kind,alias.value);}catch{continue;}
        const existing=DB.get('SELECT chatId FROM client_aliases WHERE instanceId=? AND kind=? AND value=?',[instanceId,alias.kind,value]);
        if(existing&&!allowedOwners.includes(canonical(instanceId,existing.chatId)))fail('ALIAS_CONFLICT',409,{conflictingChatId:existing.chatId});
        DB.run('INSERT OR IGNORE INTO client_aliases(instanceId,chatId,kind,value) VALUES(?,?,?,?)',[instanceId,row.chatId,alias.kind,value]);
    }
}
function merge(instanceId, target, source) {
    if (target.chatId === source.chatId) return;
    if (DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customer_external_operations'")
        && DB.get("SELECT 1 FROM customer_external_operations WHERE instanceId=? AND chatId IN (?,?) AND status IN ('started','unknown') LIMIT 1",[instanceId,target.chatId,source.chatId]))
        fail('EXTERNAL_OUTCOME_UNKNOWN',409);

    require('./ava-workspace.store').mergeClient(instanceId,source.chatId,target.chatId);
    require('./ava-autopilot.store').mergeClient(instanceId,source.chatId,target.chatId);
    DB.run('UPDATE customer_deals SET clientChatId=?,revision=revision+1 WHERE instanceId=? AND clientChatId=?',[target.chatId,instanceId,source.chatId]);
    DB.run('UPDATE deal_stage_events SET clientChatId=? WHERE instanceId=? AND clientChatId=?',[target.chatId,instanceId,source.chatId]);
    const targetAssignee = target.assigneeUserId || null;
    const sourceAssignee = source.assigneeUserId || null;
    if (targetAssignee && sourceAssignee && targetAssignee !== sourceAssignee) fail('ASSIGNMENT_MERGE_CONFLICT',409);
    // The provider await is outside the send transaction. Moving either card
    // while an acknowledgement is unknown would invalidate that send's refs.
    const customerIds = [target, source].map(row => `crm_${instanceId}_${row.id}`);
    const drafts = DB.all(`SELECT status,metadataJson FROM followup_drafts
        WHERE instanceId=? AND (chatId IN (?,?) OR customerId IN (?,?) OR managerTaskId IN (
            SELECT taskId FROM manager_tasks WHERE instanceId=? AND (chatId IN (?,?) OR customerId IN (?,?))))`,
        [instanceId,target.chatId,source.chatId,...customerIds,instanceId,target.chatId,source.chatId,...customerIds]);
    const unresolved = new Set(['sending','pending','unknown','unknown-pending','unknown_pending','unconfirmed','delivery_pending','delivery_unconfirmed']);
    if (drafts.some(row => {
        let metadata;
        try { metadata=JSON.parse(row.metadataJson == null ? '{}' : row.metadataJson); } catch (_) { return true; }
        // Corrupt metadata cannot prove that the provider await has finished.
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return true;
        return [row.status,metadata.delivery_status,metadata.provider_status]
            .some(value => unresolved.has(String(value || '').trim().toLowerCase()));
    })) fail('FOLLOWUP_DELIVERY_PENDING',409);
    // Native contact columns can predate aliases. Preserve both cards' exact
    // contacts before choosing a primary, otherwise a later inbound can fork.
    preserveNativeContacts(instanceId,target,[target.chatId,source.chatId]);
    preserveNativeContacts(instanceId,source,[target.chatId,source.chatId]);
    // Archive complete original rows before moving references. Unique per-client
    // projections can collide; their complete source payload remains recoverable.
    const tables = DB.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    for (const {name} of tables) {
        if (['clients','client_redirects','client_aliases','client_merge_archive'].includes(name)) continue;
        const columns = DB.all(`PRAGMA table_info("${name}")`);
        if (!columns.some(c=>c.name==='instanceId') || !columns.some(c=>c.name==='chatId')) continue;
        const rows = DB.all(`SELECT rowid AS _rowid,* FROM "${name}" WHERE instanceId=? AND chatId=?`,[instanceId,source.chatId]);
        for (const row of rows) {
            DB.run('INSERT INTO client_merge_archive(instanceId,targetChatId,sourceChatId,tableName,rowJson) VALUES(?,?,?,?,?)',[instanceId,target.chatId,source.chatId,name,JSON.stringify(row)]);
            try { DB.run(`UPDATE "${name}" SET chatId=? WHERE rowid=?`,[target.chatId,row._rowid]); }
            catch (error) {
                if (!String(error.code).startsWith('SQLITE_CONSTRAINT_UNIQUE')) throw error;
                if (name === 'client_profiles') {
                    const current = DB.get('SELECT * FROM client_profiles WHERE instanceId=? AND chatId=?',[instanceId,target.chatId]);
                    for (const field of ['needs','budget','objections','timezone']) {
                        if (row[field] && row[field] !== current[field]) DB.run(`UPDATE client_profiles SET ${field}=? WHERE id=?`,[[current[field],row[field]].filter(Boolean).join('\n'),current.id]);
                    }
                    let first={},second={};
                    try { first=JSON.parse(current.rawProfileJson||'{}'); } catch (_) {}
                    try { second=JSON.parse(row.rawProfileJson||'{}'); } catch (_) {}
                    const raw={...second,...first,mergedProfiles:[...(first.mergedProfiles||[]),{sourceChatId:source.chatId,...second}]};
                    let interests=[];
                    for(const profile of [current,row]) try { interests.push(...JSON.parse(profile.interests||'[]')); } catch (_) {}
                    DB.run('UPDATE client_profiles SET interests=?,rawProfileJson=? WHERE id=?',[JSON.stringify([...new Set(interests)]),JSON.stringify(raw),current.id]);
                    DB.run('DELETE FROM client_profiles WHERE id=?',[row.id]);
                } else if (name === 'optimal_contact_times') {
                    DB.run('UPDATE optimal_contact_times SET responseCount=responseCount+? WHERE instanceId=? AND chatId=? AND dayOfWeek=? AND hourSlot=?',[row.responseCount,instanceId,target.chatId,row.dayOfWeek,row.hourSlot]);
                    DB.run('DELETE FROM optimal_contact_times WHERE id=?',[row.id]);
                } else throw error; // Fail atomically instead of stranding unknown conflicting data.
            }
        }
    }
    DB.run('INSERT INTO client_merge_archive(instanceId,targetChatId,sourceChatId,tableName,rowJson) VALUES(?,?,?,?,?)',[instanceId,target.chatId,source.chatId,'clients',JSON.stringify(source)]);
    for (const key of ['telegramChatId','emailAddress','vkUserId','vkPeerId','maxUserId','maxChatId','crmContactId','crmLeadId','assigneeUserId']) {
        if (!target[key] && source[key]) DB.run(`UPDATE clients SET ${key}=? WHERE instanceId=? AND chatId=?`,[source[key],instanceId,target.chatId]);
    }
    DB.run('UPDATE client_aliases SET chatId=? WHERE instanceId=? AND chatId=?',[target.chatId,instanceId,source.chatId]);
    DB.run('UPDATE client_redirects SET chatId=? WHERE instanceId=? AND chatId=?',[target.chatId,instanceId,source.chatId]);
    DB.run('INSERT INTO client_redirects(instanceId,oldChatId,chatId) VALUES(?,?,?)',[instanceId,source.chatId,target.chatId]);
    for (const {name} of tables) {
        const columns=DB.all(`PRAGMA table_info("${name}")`);
        if(columns.some(c=>c.name==='instanceId')&&columns.some(c=>c.name==='customerId')) DB.run(`UPDATE "${name}" SET customerId=? WHERE instanceId=? AND customerId=?`,[`crm_${instanceId}_${target.id}`,instanceId,`crm_${instanceId}_${source.id}`]);
    }
    let tags=[];
    for(const row of [target,source]) try { tags.push(...JSON.parse(row.tags||'[]')); } catch (_) {}
    DB.run('UPDATE clients SET tags=?,updatedAt=CURRENT_TIMESTAMP WHERE instanceId=? AND chatId=?',[JSON.stringify([...new Set(tags)]),instanceId,target.chatId]);
    if(source.lastMessageTime && (!target.lastMessageTime || source.lastMessageTime>target.lastMessageTime)) DB.run('UPDATE clients SET lastMessage=?,lastMessageTime=? WHERE instanceId=? AND chatId=?',[source.lastMessage,source.lastMessageTime,instanceId,target.chatId]);
    DB.run('INSERT INTO lead_status_history(instanceId,chatId,fromStatus,toStatus,reason,changedBy) VALUES(?,?,?,?,?,?)',[instanceId,target.chatId,source.leadStatus,target.leadStatus,'Карточки объединены пользователем. Статус основной карточки сохранён.','manager']);
    DB.run('DELETE FROM clients WHERE instanceId=? AND chatId=?',[instanceId,source.chatId]);
}
function attach(instanceId, chatId, data) {
    require('./ava-workspace.store').ensureSchema();
    require('./ava-autopilot.store').ensureSchema();
    schema(); const value=normalize(data.kind,data.value);
    return DB.db.transaction(()=> {
        const target=client(instanceId,chatId);
        const naturalId = data.kind==='telegram' ? `tg_${value}` : data.kind==='avito' ? `avito:${value}`
            : data.kind==='email' ? 'email_'+createHash('sha256').update(value).digest('hex')
                : data.kind==='vk' ? 'vk_'+value : data.kind==='max'&&value.startsWith('user:') ? 'max_'+value.slice(5) : value;
        const existingAlias=DB.get('SELECT chatId FROM client_aliases WHERE instanceId=? AND kind=? AND value=?',[instanceId,data.kind,value]);
        let existing=existingAlias ? client(instanceId,existingAlias.chatId) : DB.get('SELECT * FROM clients WHERE instanceId=? AND chatId=?',[instanceId,resolve(instanceId,naturalId)]);
        if (!existing && data.kind==='telegram') existing=DB.get('SELECT * FROM clients WHERE instanceId=? AND telegramChatId=?',[instanceId,value]);
        if (!existing && ['email','vk','max'].includes(data.kind)) {
            const candidates=data.kind==='email'
                ? DB.all('SELECT * FROM clients WHERE instanceId=? AND LOWER(emailAddress)=?',[instanceId,value])
                : data.kind==='vk' ? DB.all('SELECT * FROM clients WHERE instanceId=? AND (vkUserId=? OR vkPeerId=?)',[instanceId,value,value])
                    : DB.all(`SELECT * FROM clients WHERE instanceId=? AND ${value.startsWith('user:')?'maxUserId':'maxChatId'}=?`,[instanceId,value.slice(5)]);
            if(candidates.length>1)fail('AMBIGUOUS_CHANNEL_CARDS',409);
            existing=candidates[0];
        }
        if (!existing && data.kind==='phone') {
            const candidates=DB.all('SELECT * FROM clients WHERE instanceId=?',[instanceId]).filter(row=> {
                const raw=row.chatId.replace(/@(c\.us|s\.whatsapp\.net)$/,'');
                try { return normalize('phone',raw)===value; } catch (_) { return false; }
            });
            if(candidates.length>1) fail('AMBIGUOUS_PHONE_CARDS',409);
            existing=candidates[0];
        }
        if (existing && existing.chatId!==target.chatId) {
            if (data.confirmMerge!==true || data.mergeChatId!==existing.chatId) fail('ALIAS_CONFLICT',409,{conflictingChatId:existing.chatId});
            merge(instanceId,target,existing);
        } else if (data.mergeChatId) fail('MERGE_SELECTION_MISMATCH',409);
        preserveNativeContacts(instanceId,client(instanceId,target.chatId));
        DB.run('INSERT OR IGNORE INTO client_aliases(instanceId,chatId,kind,value) VALUES(?,?,?,?)',[instanceId,target.chatId,data.kind,value]);
        if (data.kind==='telegram') DB.run('UPDATE clients SET telegramChatId=? WHERE instanceId=? AND chatId=?',[value,instanceId,target.chatId]);
        if (data.kind==='email') DB.run('UPDATE clients SET emailAddress=? WHERE instanceId=? AND chatId=?',[value,instanceId,target.chatId]);
        if (data.kind==='vk') DB.run('UPDATE clients SET vkUserId=?,vkPeerId=? WHERE instanceId=? AND chatId=?',[value,value,instanceId,target.chatId]);
        if (data.kind==='max') DB.run(`UPDATE clients SET ${value.startsWith('user:')?'maxUserId':'maxChatId'}=? WHERE instanceId=? AND chatId=?`,[value.slice(5),instanceId,target.chatId]);
        return list(instanceId,target.chatId);
    }).immediate();
}
function unlink(instanceId,chatId,id) {
    const target=client(instanceId,chatId);
    const row=DB.get('SELECT * FROM client_aliases WHERE id=? AND instanceId=? AND chatId=?',[id,instanceId,target.chatId]);
    if (!row) fail('ALIAS_NOT_FOUND',404);
    const original=row.kind==='telegram'?`tg_${row.value}`:row.kind==='avito'?`avito:${row.value}`
        :row.kind==='email'?'email_'+createHash('sha256').update(row.value).digest('hex')
            :row.kind==='vk'?'vk_'+row.value:row.kind==='max'&&row.value.startsWith('user:')?'max_'+row.value.slice(5):row.value;
    const archived=DB.all("SELECT rowJson FROM client_merge_archive WHERE instanceId=? AND targetChatId=? AND tableName='clients'",[instanceId,target.chatId]);
    const mergedNative=archived.some(item=>{try{const old=JSON.parse(item.rowJson);
        return row.kind==='email'&&old.emailAddress&&normalize('email',old.emailAddress)===row.value
            ||row.kind==='vk'&&[old.vkUserId,old.vkPeerId].includes(row.value)
            ||row.kind==='max'&&(row.value==='user:'+old.maxUserId||row.value==='chat:'+old.maxChatId);
    }catch{return false;}});
    if (mergedNative || DB.get('SELECT 1 FROM client_redirects WHERE instanceId=? AND oldChatId=?',[instanceId,original]) || original===target.chatId) fail('MERGED_OR_PRIMARY_ALIAS_CANNOT_UNLINK',409);
    DB.run('DELETE FROM client_aliases WHERE id=?',[id]);
    if(row.kind==='telegram') DB.run('UPDATE clients SET telegramChatId=NULL WHERE instanceId=? AND chatId=? AND telegramChatId=?',[instanceId,target.chatId,row.value]);
    if(row.kind==='email') DB.run('UPDATE clients SET emailAddress=NULL WHERE instanceId=? AND chatId=? AND LOWER(emailAddress)=?',[instanceId,target.chatId,row.value]);
    if(row.kind==='vk') DB.run('UPDATE clients SET vkUserId=CASE WHEN vkUserId=? THEN NULL ELSE vkUserId END,vkPeerId=CASE WHEN vkPeerId=? THEN NULL ELSE vkPeerId END WHERE instanceId=? AND chatId=?',[row.value,row.value,instanceId,target.chatId]);
    if(row.kind==='max') DB.run(`UPDATE clients SET ${row.value.startsWith('user:')?'maxUserId':'maxChatId'}=NULL WHERE instanceId=? AND chatId=? AND ${row.value.startsWith('user:')?'maxUserId':'maxChatId'}=?`,[instanceId,target.chatId,row.value.slice(5)]);
    return list(instanceId,target.chatId);
}
module.exports={normalize,canonical,resolve,list,attach,unlink};
