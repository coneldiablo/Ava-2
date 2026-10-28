'use strict';
const DB = require('./database.service');
const Sales = require('./sales-workspace.service');
const Store = require('./ava-workspace.store');
const Flags = require('./ava-improvements-flags.service');
const initialized = new WeakSet();
const LEASE_MS = 45000;
function fail(code, statusCode = 400) { throw Object.assign(new Error(code), {code, statusCode}); }
function ensureSchema() {
    Store.ensureSchema();
    if (initialized.has(DB.db)) return;
    DB.db.exec(`CREATE TABLE IF NOT EXISTS ava_dialogue_revisions (
        businessId INTEGER NOT NULL, chatId TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(businessId,chatId),
        FOREIGN KEY(businessId,chatId) REFERENCES clients(instanceId,chatId) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ava_collaboration_presence (
        businessId INTEGER NOT NULL, chatId TEXT NOT NULL, userId TEXT NOT NULL REFERENCES ava_users(id) ON DELETE CASCADE,
        sessionId TEXT NOT NULL, typing INTEGER NOT NULL CHECK(typing IN (0,1)), expiresAt INTEGER NOT NULL,
        PRIMARY KEY(businessId,chatId,userId,sessionId),
        FOREIGN KEY(businessId,chatId) REFERENCES clients(instanceId,chatId) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS ava_presence_expiry ON ava_collaboration_presence(expiresAt);`);
    // Source-table triggers work for every ingest path and across server processes.
    const sources = [
        ['messages', 'instanceId', null],
        ['conversation_events', 'instanceId', 'callId IS NOT NULL'],
        ['ava_call_transcript_sources', 'businessId', null],
        ['ava_conversation_control', 'businessId', null],
        ['ava_workspace_reply_actions', 'businessId', null],
    ];
    for (const [table, business, condition] of sources) {
        const bump = alias => `INSERT INTO ava_dialogue_revisions(businessId,chatId,revision)
            SELECT ${alias}.${business},${alias}.chatId,2 WHERE EXISTS(SELECT 1 FROM clients
                WHERE instanceId=${alias}.${business} AND chatId=${alias}.chatId)
            ${condition ? `AND ${alias}.${condition}` : ''}
            ON CONFLICT(businessId,chatId) DO UPDATE SET revision=revision+1;`;
        // Dispatch timestamps/owner are bookkeeping for the already reserved
        // action. Invalidating its own prepared dialogue would block every send.
        if (table === 'ava_workspace_reply_actions') DB.db.exec('DROP TRIGGER IF EXISTS ava_dialogue_ava_workspace_reply_actions_update');
        const updateColumns = table === 'ava_workspace_reply_actions'
            ? ' OF businessId,chatId,userId,idempotencyKey,textHash,controlRevision,status,text' : '';
        DB.db.exec(`CREATE TRIGGER IF NOT EXISTS ava_dialogue_${table}_insert AFTER INSERT ON ${table} BEGIN ${bump('NEW')} END;
            CREATE TRIGGER IF NOT EXISTS ava_dialogue_${table}_delete AFTER DELETE ON ${table} BEGIN ${bump('OLD')} END;
            CREATE TRIGGER IF NOT EXISTS ava_dialogue_${table}_update AFTER UPDATE${updateColumns} ON ${table} BEGIN ${bump('OLD')} ${bump('NEW')} END;`);
    }
    // Assignment/channel changes also invalidate a reply prepared for an old context.
    DB.db.exec(`CREATE TRIGGER IF NOT EXISTS ava_dialogue_client_update
        AFTER UPDATE OF assigneeUserId,preferredChannel ON clients
        WHEN OLD.assigneeUserId IS NOT NEW.assigneeUserId OR OLD.preferredChannel IS NOT NEW.preferredChannel
        BEGIN INSERT INTO ava_dialogue_revisions(businessId,chatId,revision) VALUES(NEW.instanceId,NEW.chatId,2)
        ON CONFLICT(businessId,chatId) DO UPDATE SET revision=revision+1; END;`);
    initialized.add(DB.db);
}
function dialogueRevision(businessId, chatId) {
    ensureSchema();
    DB.db.transaction(()=>require('./client-identity.service').canonical(businessId,chatId)).immediate();
    return DB.db.transaction(()=>{
        const client = Store.scope(businessId, chatId);
        return String(DB.get('SELECT revision FROM ava_dialogue_revisions WHERE businessId=? AND chatId=?', [client.instanceId, client.chatId])?.revision || 1);
    }).immediate();
}
function authorize(auth, businessId, chatId, write = false) {
    const actor = Sales.authorize(auth, businessId, write ? 'sales.write' : 'sales.read');
    Flags.assertEnabled(actor.businessId, 'collaboration');
    ensureSchema();
    DB.db.transaction(()=>require('./client-identity.service').canonical(actor.businessId,chatId)).immediate();
    const client = DB.db.transaction(()=>{
        const current=Store.scope(actor.businessId,chatId);
        if(write)Sales.authorizeClientMutation(auth,actor.businessId,current.chatId);
        return current;
    }).immediate();
    return {actor, client};
}
function snapshot(actor, client, now) {
    const rows = DB.all(`SELECT p.userId,u.displayName AS name,MAX(p.typing) AS typing,MAX(p.expiresAt) AS expiresAt
        FROM ava_collaboration_presence p JOIN ava_users u ON u.id=p.userId AND u.enabled=1
        JOIN ava_business_memberships m ON m.userId=p.userId AND m.businessId=p.businessId AND m.enabled=1
        WHERE p.businessId=? AND p.chatId=? AND p.expiresAt>? AND
            (m.role IN ('hotel_owner','sales_lead') OR (m.role='manager' AND p.userId=?))
        GROUP BY p.userId,u.displayName ORDER BY p.userId LIMIT 100`,
    [actor.businessId,client.chatId,now,Store.activeAssignee(actor.businessId,client.assigneeUserId)]);
    return {success:true,businessId:actor.businessId,participants:rows.map(r=>({...r,typing:!!r.typing,expiresAt:new Date(r.expiresAt).toISOString()})),
        dialogueRevision:dialogueRevision(actor.businessId,client.chatId)};
}
function presence(auth, businessId, chatId) {
    const {actor,client}=authorize(auth,businessId,chatId);
    return snapshot(actor,client,Date.now());
}
function heartbeat(auth, businessId, chatId, body) {
    if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(k=>!['sessionId','typing'].includes(k))
        || typeof body.sessionId!=='string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.sessionId) || typeof body.typing!=='boolean') fail('WORKSPACE_INPUT_INVALID');
    const {actor,client}=authorize(auth,businessId,chatId,true),now=Date.now();
    return DB.db.transaction(()=>{
        DB.run('DELETE FROM ava_collaboration_presence WHERE expiresAt<=?', [now]);
        // Bound session churn by each authenticated actor; keep at most ten leases.
        DB.run(`DELETE FROM ava_collaboration_presence WHERE businessId=? AND chatId=? AND userId=? AND sessionId<>?
            AND sessionId NOT IN (SELECT sessionId FROM ava_collaboration_presence WHERE businessId=? AND chatId=? AND userId=?
                AND sessionId<>? ORDER BY expiresAt DESC,sessionId LIMIT 9)`,
        [actor.businessId,client.chatId,actor.userId,body.sessionId,actor.businessId,client.chatId,actor.userId,body.sessionId]);
        DB.run(`INSERT INTO ava_collaboration_presence VALUES(?,?,?,?,?,?) ON CONFLICT(businessId,chatId,userId,sessionId)
            DO UPDATE SET typing=excluded.typing,expiresAt=excluded.expiresAt`,[actor.businessId,client.chatId,actor.userId,body.sessionId,body.typing?1:0,now+LEASE_MS]);
        return snapshot(actor,client,now);
    }).immediate();
}
module.exports = {ensureSchema,dialogueRevision,presence,heartbeat,LEASE_MS};
