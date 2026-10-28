const Logger = require('../utils/logger');
const DB = require('./database.service');
const WhatsAppGatewayService = require('./whatsapp-gateway.service');
const {createHash,randomUUID} = require('crypto');
const ChannelRouter = require('./channel-router.service');
const ChannelContext = require('./channel-context.service');
const Workspace = require('./ava-workspace.store');
const Autopilot = require('./ava-autopilot.store');
const initialized = new WeakSet();
const fail = code => { throw Object.assign(new Error(code),{code,statusCode:409,safeToRetry:true}); };

// Default follow-up settings (can be overridden per instance)
const DEFAULT_DELAY_HOURS = 48;
const DEFAULT_TEXT = 'Добрый день! Остались ли у вас вопросы? Буду рад помочь 😊';
const CHECK_INTERVAL_MS = 60 * 1000; // Check every minute

class FollowUpService {
    constructor() {
        this._timer = null;
        this._running = false;
    }

    /**
     * Start the background follow-up checker.
     * Call once at server startup.
     */
    start() {
        if (this._timer) return; // Already running
        Logger.info('[FollowUp] 🕐 Auto follow-up service started (checks every 60s)');
        this._timer = setInterval(() => this._check(), CHECK_INTERVAL_MS);
        // Run the first check shortly after startup
        setTimeout(() => this._check(), 5000);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
            Logger.info('[FollowUp] Stopped.');
        }
    }

    /**
     * Main check: iterate over all active instances,
     * look for leads that have been silent too long.
     */
    async _check() {
        if (this._running) return; // Prevent overlapping runs
        this._running = true;
        try {
            await require('./postcall-followup.service').recover();
            const instances = await DB.getInstances();
            for (const instance of instances) {
                if (!instance.isActive) continue;
                if (!instance.followUpEnabled || instance.followUpEnabled === '0' || instance.followUpEnabled === 0) continue;
                const { hasOpenWa, hasGreenApi } = WhatsAppGatewayService.getConfig(instance);
                if (!hasOpenWa && !hasGreenApi) continue;

                await this._checkInstance(instance);
            }
        } catch (e) {
            Logger.error('[FollowUp] Check error:', e.message);
        } finally {
            this._running = false;
        }
    }

    wakePostCall() {
        // The item is already durable in followup_drafts. This wake-up only
        // reduces latency; the normal startup/minute loop recovers a restart.
        if (this._timer) void require('./postcall-followup.service').recover()
            .catch(() => Logger.warn('[FollowUp] Post-call work retained for recovery'));
    }

    async _checkInstance(instance) {
        this._ensureSchema();
        await this._repairPending(instance.id);
        // Published Autopilot owns scheduled sends for this business.
        if (Autopilot.policy(instance.id)?.activated) return;
        const delayHours = parseFloat(instance.followUpDelay || DEFAULT_DELAY_HOURS);
        const followUpText = (instance.followUpText && instance.followUpText.trim())
            ? instance.followUpText.trim()
            : DEFAULT_TEXT;

        const silentClients = await DB.getSilentClientsForFollowUp(instance.id, delayHours);

        if (silentClients.length === 0) return;

        // ──────────────────────────────────────────────────────────
        // Check WhatsApp authorization ONCE per instance
        // ──────────────────────────────────────────────────────────
        try {
            const stateResult = await WhatsAppGatewayService.getState(instance);
            if (!stateResult.success || stateResult.effectiveState !== 'authorized') {
                Logger.warn(`[FollowUp] Instance ${instance.id} WhatsApp not authorized (${stateResult.effectiveState || 'unknown'}), skipping all follow-ups`);
                return;
            }
        } catch (e) {
            Logger.warn(`[FollowUp] Instance ${instance.id} — could not verify WhatsApp state: ${e.message}. Skipping.`);
            return;
        }

        Logger.info(`[FollowUp] Instance ${instance.id} (${instance.name}): ${silentClients.length} silent lead(s) need follow-up`);

        for (const client of silentClients) {
            await this._sendFollowUp(instance, client, followUpText);
        }
    }

    async _sendFollowUp(instance, client, text) {
        let action = null;
        try {
            this._ensureSchema();
            if (Number(client.instanceId) !== Number(instance.id)) fail('BUSINESS_SCOPE_REQUIRED');
            const snapshot = ChannelContext.capture(instance.id,client.chatId);
            action = DB.db.transaction(() => {
                ChannelContext.assertCanSend(instance.id,client.chatId,snapshot,{origin:'legacy_ai_followup'});
                const live = this._eligible(instance.id,snapshot.chatId,text);
                return this._claim(instance.id,live,text);
            }).immediate();
            if (!action) return;
            const beforeSend = () => DB.db.transaction(() => {
                ChannelContext.assertCanSend(instance.id,snapshot.chatId,snapshot,{origin:'legacy_ai_followup'});
                this._eligible(instance.id,snapshot.chatId,text);
                const current = DB.get("SELECT * FROM legacy_followup_actions WHERE instanceId=? AND id=? AND state='reserved' AND leaseToken=? AND leaseUntil>?",
                    [instance.id,action.id,action.leaseToken,Date.now()]);
                if (!current) fail('WORKSPACE_SEND_CONFLICT');
                Workspace.beginAiSend({businessId:instance.id,chatId:snapshot.chatId,revision:snapshot.controlRevision,sendId:action.id});
                DB.run("UPDATE legacy_followup_actions SET state='sending',updatedAt=? WHERE instanceId=? AND id=? AND leaseToken=?",
                    [Date.now(),instance.id,action.id,action.leaseToken]);
            }).immediate();
            const result = await ChannelRouter.sendMessageDetailed(instance.id,snapshot.chatId,text,'whatsapp',
                {origin:'legacy_ai_followup',businessId:Number(instance.id),channelSnapshot:snapshot,
                    actionId:action.id,sendId:action.id,idempotencyKey:action.id,beforeSend});
            if (result?.success === true && result.provider_message_id) this._complete(action,result);
            else this._failed(action,result?.safeToRetry === true,result?.error);
        } catch (e) {
            if (action) {
                const current = DB.get('SELECT state FROM legacy_followup_actions WHERE instanceId=? AND id=?',[action.instanceId,action.id]);
                if (current?.state !== 'sent') this._failed(action,current?.state === 'reserved',e.code);
            }
            Logger.warn('[FollowUp] Work retained:',/^[A-Z_]+$/.test(e?.code || '') ? e.code : 'FOLLOWUP_UNAVAILABLE');
        }
    }

    ensureSchema() { this._ensureSchema(); }

    _ensureSchema() {
        Workspace.ensureSchema();
        Autopilot.ensureSchema();
        if (initialized.has(DB.db)) return;
        DB.db.exec(`CREATE TABLE IF NOT EXISTS legacy_followup_actions (
            id TEXT PRIMARY KEY,instanceId INTEGER NOT NULL,chatId TEXT NOT NULL,cycleKey TEXT NOT NULL,text TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('reserved','sending','sent','failed','unknown')),
            leaseToken TEXT,leaseUntil INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 1,nextAt INTEGER NOT NULL DEFAULT 0,
            providerMessageId TEXT,storedMessageId INTEGER,errorCode TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,
            UNIQUE(instanceId,chatId,cycleKey),FOREIGN KEY(instanceId,chatId) REFERENCES clients(instanceId,chatId) ON DELETE CASCADE);
            CREATE INDEX IF NOT EXISTS legacy_followup_pending ON legacy_followup_actions(instanceId,chatId,state);`);
        initialized.add(DB.db);
    }

    _eligible(instanceId,chatId,text) {
        const instance = DB.get('SELECT * FROM instances WHERE id=?',[instanceId]);
        if (!instance?.isActive || !instance.followUpEnabled || instance.followUpEnabled === '0') fail('AUTOPILOT_ACTION_NOT_ALLOWED');
        if (Autopilot.policy(instanceId)?.activated) fail('AUTOPILOT_POLICY_CHANGED');
        const configuredText = instance.followUpText?.trim() || DEFAULT_TEXT;
        if (text !== configuredText) fail('WORKSPACE_DIALOGUE_CHANGED');
        const delay = parseFloat(instance.followUpDelay || DEFAULT_DELAY_HOURS);
        const row = DB.get(`SELECT * FROM clients WHERE instanceId=? AND chatId=? AND followUpSentAt IS NULL
            AND leadStatus NOT IN ('pickup_confirmed','ready_for_pickup','booked','junk')
            AND (lastMessageTime IS NULL OR (julianday('now')-julianday(lastMessageTime))*24>=?)`,[instanceId,chatId,delay]);
        if (!row) fail('WORKSPACE_DIALOGUE_CHANGED');
        if (Autopilot.pendingCustomer(instanceId,chatId)) fail('WORKSPACE_SEND_IN_PROGRESS');
        return row;
    }

    _claim(instanceId,client,text) {
        const now = Date.now();
        // Only an expired reservation is known not to have reached the provider.
        if (DB.get(`SELECT 1 FROM legacy_followup_actions WHERE instanceId=? AND chatId=?
            AND (state IN ('sending','unknown') OR state='reserved' AND leaseUntil>?)`,[instanceId,client.chatId,now])) return null;
        const messageId = DB.get('SELECT COALESCE(MAX(id),0) id FROM messages WHERE instanceId=? AND chatId=?',[instanceId,client.chatId]).id;
        const statusId = DB.get('SELECT COALESCE(MAX(id),0) id FROM lead_status_history WHERE instanceId=? AND chatId=?',[instanceId,client.chatId]).id;
        const cycleKey = createHash('sha256').update(JSON.stringify([messageId,statusId,client.leadStatus,client.lastStatusChangeAt])).digest('hex');
        const previous = DB.get('SELECT * FROM legacy_followup_actions WHERE instanceId=? AND chatId=? AND cycleKey=?',[instanceId,client.chatId,cycleKey]);
        if (previous && (previous.state === 'sent' || previous.attempts >= 8 || previous.nextAt > now)) return null;
        const id = previous?.id || 'legacy-followup:' + randomUUID(),leaseToken=randomUUID();
        DB.run(`INSERT INTO legacy_followup_actions(id,instanceId,chatId,cycleKey,text,state,leaseToken,leaseUntil,createdAt,updatedAt)
            VALUES(?,?,?,?,?,'reserved',?,?,?,?) ON CONFLICT(instanceId,chatId,cycleKey) DO UPDATE SET
            text=excluded.text,state='reserved',leaseToken=excluded.leaseToken,leaseUntil=excluded.leaseUntil,
            attempts=legacy_followup_actions.attempts+1,errorCode=NULL,updatedAt=excluded.updatedAt`,
            [id,instanceId,client.chatId,cycleKey,text,leaseToken,now+120000,now,now]);
        return DB.get('SELECT * FROM legacy_followup_actions WHERE instanceId=? AND id=?',[instanceId,id]);
    }

    _complete(action,result) {
        DB.db.transaction(() => {
            const row = DB.get('SELECT * FROM legacy_followup_actions WHERE instanceId=? AND id=? AND leaseToken=?',[action.instanceId,action.id,action.leaseToken]);
            if (!row || row.state === 'sent') return;
            if (result.stored_message_id) DB.run("UPDATE messages SET messageType='followup' WHERE id=? AND instanceId=? AND chatId=? AND role='assistant'",
                [result.stored_message_id,action.instanceId,action.chatId]);
            DB.run('UPDATE clients SET followUpSentAt=CURRENT_TIMESTAMP WHERE instanceId=? AND chatId=?',[action.instanceId,action.chatId]);
            DB.run("UPDATE legacy_followup_actions SET state='sent',providerMessageId=?,storedMessageId=?,errorCode=NULL,updatedAt=? WHERE instanceId=? AND id=?",
                [String(result.provider_message_id),result.stored_message_id || null,Date.now(),action.instanceId,action.id]);
            this._finishSlot(action,'sent');
        }).immediate();
    }

    _finishSlot(action,status) {
        const control=DB.get('SELECT activeSendId FROM ava_conversation_control WHERE businessId=? AND chatId=?',[action.instanceId,action.chatId]);
        if (control?.activeSendId === action.id) Workspace.endAiSend({businessId:action.instanceId,chatId:action.chatId,sendId:action.id,status});
    }

    _failed(action,safeToRetry,error) {
        DB.db.transaction(() => {
            const row=DB.get('SELECT state FROM legacy_followup_actions WHERE instanceId=? AND id=? AND leaseToken=?',[action.instanceId,action.id,action.leaseToken]);
            if (!row || row.state === 'sent' || row.state === 'unknown') return;
            const status=safeToRetry ? 'failed' : 'unknown';
            DB.run('UPDATE legacy_followup_actions SET state=?,nextAt=?,errorCode=?,updatedAt=? WHERE instanceId=? AND id=?',
                [status,Date.now()+CHECK_INTERVAL_MS,/^[A-Za-z0-9_]{1,100}$/.test(error || '') ? error : 'FOLLOWUP_SEND_UNCONFIRMED',Date.now(),action.instanceId,action.id]);
            this._finishSlot(action,status);
        }).immediate();
    }

    async _repairPending(instanceId) {
        for (const action of DB.all("SELECT * FROM legacy_followup_actions WHERE instanceId=? AND state IN ('sending','unknown') ORDER BY createdAt LIMIT 100",[instanceId])) {
            const evidence=await ChannelRouter.reconcileMessage(instanceId,action.chatId,{channel:'whatsapp',actionId:action.id});
            if (evidence.status === 'sent' && evidence.providerMessageId) this._complete(action,
                {provider_message_id:evidence.providerMessageId,stored_message_id:evidence.storedMessageId});
            else if (action.state === 'sending' && action.leaseUntil <= Date.now()) this._failed(action,false,'FOLLOWUP_SEND_ACK_UNKNOWN');
        }
    }
}

module.exports = new FollowUpService();
