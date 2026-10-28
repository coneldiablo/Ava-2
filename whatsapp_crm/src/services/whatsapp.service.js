const crypto = require('crypto');
const Logger = require('../utils/logger');
const config = require('../config');
const AIService = require('./ai.service');
const DB = require('./database.service');
const CRMService = require('./crm.service');
const WhatsAppGatewayService = require('./whatsapp-gateway.service');
const PushService = require('./push.service');
const LanguageService = require('./language.service');
const PersonalizationService = require('./personalization.service');
const CustomerContext = require('./channel-customer-context.service');
const MessageBatcher = require('./message-batcher.service');
const PmsIntentService = require('./pms/pms-intent.service');
const PmsService = require('./pms/pms.service');
const ResponseSettings = require('./whatsapp-response-settings.service');
const Media = require('./whatsapp-media.service');
const ProductContext = require('./channel-product-context.service');

class WhatsAppService {
    constructor() {
        this.batcher = new MessageBatcher(config.whatsappMessageBatching);
        this.queue = this.batcher.entries; // Backward-compatible inspection handle.
        this.delayTime = this.batcher.defaultIdleMs;
        this.shortDelayTime = this.batcher.defaultShortIdleMs;
        this.maxBatchTime = this.batcher.defaultMaxMs;
        this.onyxWaitMs = config.whatsappOnyx.waitMs;
        this.onyxHedgeMs = config.whatsappOnyx.hedgeMs;
        this.inFlight = new Map();
        this.recoveryTimer = setInterval(() => {
            if (DB.db?.open) this.recoverPending().catch(e => Logger.error('[WhatsApp] Recovery failed:', this._safeErrorCode(e)));
        }, 5000);
        this.recoveryTimer.unref();
    }

    async processWebhook(body, instanceId) {
        const events = Array.isArray(body?.events) ? body.events : [body];
        for (const event of events) {
            if (event?.typeWebhook !== 'incomingMessageReceived') continue;
            const data = event.messageData;
            const chatId = event.senderData?.chatId;
            if (!this._isDirectChat(chatId) || !data) continue;
            const entry = ProductContext.greenEntry(data);
            const media = ['imageMessage','videoMessage','documentMessage','audioMessage'];
            const text = data.typeMessage === 'textMessage' ? data.textMessageData?.textMessage
                : ['extendedTextMessage','quotedMessage'].includes(data.typeMessage) ? data.extendedTextMessageData?.text
                : media.includes(data.typeMessage) ? `[Пользователь отправил медиафайл/вложение: ${data.typeMessage}]`
                : entry ? '[Пользователь прислал карточку товара]' : null;
            if (typeof text !== 'string' || !text.trim()) continue;
            await this._handleIncomingMessage(instanceId, chatId, event.senderData?.senderName || 'Клиент', text, event.idMessage,
                media.includes(data.typeMessage)?{kind:data.typeMessage==='imageMessage'?'image':data.typeMessage==='audioMessage'?'audio':'unsupported',provider:'green_api'}:null, entry ? {entry,provider:'green_api'} : null);
        }
    }

    async processOpenWaWebhook(body, instanceId) {
        const event = body?.event || body?.type;
        const data = body?.data || body;
        // A status event with a body/from field is still not an inbound message.
        if (event && !['message.received', 'message:created'].includes(event)) return;
        if (!data || data.fromMe === true || data.id?.fromMe === true || data.direction === 'outgoing') return;
        const chatId = data.chatId || data.from;
        if (data.isGroupMsg || !this._isDirectChat(chatId)) return;
        const entry = ProductContext.openwaEntry(data);
        const media = ['image','video','document','audio','ptt','voice','sticker'];
        const text = data.body || data.text || data.message?.conversation || data.message?.extendedTextMessage?.text
            || (media.includes(data.type) ? `[Пользователь отправил медиафайл: ${data.type}]` : entry ? '[Пользователь прислал карточку товара]' : null);
        if (typeof text !== 'string' || !text.trim()) return;
        const sourceMessageId = typeof data.id === 'string' ? data.id : data.id?._serialized || data.id?.id || null;
        await this._handleIncomingMessage(instanceId, chatId, data.pushName || data.contact?.pushName || data.contact?.name || data.senderName || 'Клиент', text, sourceMessageId,
            media.includes(data.type)?{kind:data.type==='image'?'image':['audio','ptt','voice'].includes(data.type)?'audio':'unsupported',provider:'openwa',sessionId:body.sessionId,caption:data.body||data.text||''}:null, entry ? {entry,provider:'openwa'} : null);
    }

    _isDirectChat(chatId) {
        return typeof chatId === 'string' && /@(c\.us|s\.whatsapp\.net|lid)$/.test(chatId);
    }

    cancelPending(instanceId,chatId=null,reason='WHATSAPP_AUTOMATION_CANCELLED') {
        this._ensureReplySchema();
        const canonical=chatId?require('./client-identity.service').resolve(instanceId,chatId):null;
        const args=[/^[A-Z_]{1,64}$/.test(reason)?reason:'WHATSAPP_AUTOMATION_CANCELLED',instanceId];
        if(canonical)args.push(canonical);
        const changed=DB.run(`UPDATE whatsapp_reply_jobs SET state='done',leaseToken=NULL,errorCode=?
            WHERE instanceId=? ${canonical?'AND chatId=?':''} AND state IN ('queued','processing')`,args).changes;
        for(const key of this.batcher.entries.keys())if(key.startsWith(`${instanceId}:whatsapp:`)&&(!canonical||key===`${instanceId}:whatsapp:${canonical}`))this.batcher.clear(key);
        return{cancelled:changed};
    }

    // This trigger participates in saveMessage's transaction: an acknowledged
    // webhook cannot leave a saved inbound without a durable processing job.
    // Existing history is deliberately not replayed during schema installation.
    _ensureReplySchema() {
        if (this.replyDb === DB.db) return;
        ResponseSettings.ensureSchema(); Media.ensureSchema();
        DB.db.transaction(()=>DB.db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_reply_jobs (
            messageId INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            instanceId INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
            chatId TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
            attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0,
            leaseToken TEXT, leaseUntil INTEGER NOT NULL DEFAULT 0,
            replyGroup INTEGER, replyText TEXT, replyThought TEXT, errorCode TEXT,
            createdAt INTEGER NOT NULL DEFAULT (CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))
        );
        CREATE INDEX IF NOT EXISTS idx_whatsapp_reply_pending ON whatsapp_reply_jobs(state,nextAt);
        DROP TRIGGER IF EXISTS whatsapp_inbound_reply_job;
        CREATE TRIGGER whatsapp_inbound_reply_job AFTER INSERT ON messages
        WHEN NEW.role='user' AND NEW.channel='whatsapp'
        BEGIN INSERT INTO whatsapp_reply_jobs(messageId,instanceId,chatId,nextAt) VALUES(NEW.id,NEW.instanceId,NEW.chatId,
            CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)+COALESCE((SELECT delaySeconds*1000 FROM whatsapp_response_settings WHERE businessId=NEW.instanceId),0)); END;`)).immediate();
        this.replyDb = DB.db;
    }

    _enqueueJob(row, meta = {}) {
        const key = `${row.instanceId}:whatsapp:${row.chatId}`;
        if (this.batcher.entries.get(key)?.messages.some(m => m.meta.messageId === row.messageId)) return;
        const remaining=Math.max(0,(row.nextAt||0)-Date.now());
        return this.batcher.enqueue({ key, text: row.content,
            meta: { ...meta, messageId: row.messageId, instanceId: row.instanceId, chatId: row.chatId,
                receivedAt: row.createdAt, channel: 'whatsapp' },
            idleMs: Math.max(this.delayTime,remaining), shortIdleMs: Math.max(this.shortDelayTime,remaining), maxMs: Math.max(this.maxBatchTime,remaining+1),
            onFlush: (batch, token) => this._processQueuedBatch(row.instanceId, row.chatId, batch, token) });
    }

    async recoverPending() {
        this._ensureReplySchema();
        const now = Date.now();
        DB.run(`UPDATE whatsapp_reply_jobs SET chatId=(SELECT m.chatId FROM messages m WHERE m.id=whatsapp_reply_jobs.messageId AND m.instanceId=whatsapp_reply_jobs.instanceId)
            WHERE state IN ('queued','processing') AND EXISTS(SELECT 1 FROM messages m WHERE m.id=whatsapp_reply_jobs.messageId
                AND m.instanceId=whatsapp_reply_jobs.instanceId AND m.chatId<>whatsapp_reply_jobs.chatId)`);
        await require('./ava-autopilot.service').processDueActions();
        DB.run("UPDATE whatsapp_reply_jobs SET state='uncertain',errorCode='WHATSAPP_SEND_ACK_UNKNOWN' WHERE state='sending' AND leaseUntil<?", [now]);
        DB.run("UPDATE whatsapp_reply_jobs SET state=CASE WHEN attempts>=8 THEN 'failed' ELSE 'queued' END,leaseToken=NULL WHERE state='processing' AND leaseUntil<?", [now]);
        // Provider ACK was already persisted. Repair local history without sending again.
        for (const row of DB.all("SELECT * FROM whatsapp_reply_jobs WHERE state='acknowledged' GROUP BY replyGroup")) {
            const origin=DB.get('SELECT originChatId FROM messages WHERE instanceId=? AND id=?',[row.instanceId,row.replyGroup])?.originChatId||row.chatId;
            const saved = await DB.saveMessage(row.instanceId, origin, 'Bot', row.replyText, 'assistant', row.replyThought, `whatsapp-reply:${row.replyGroup}`);
            if (saved?.id) require('./ava-workspace.store').ingestPromises({businessId:row.instanceId,chatId:row.chatId,sourceType:'message',sourceId:String(saved.id)});
            DB.run("UPDATE whatsapp_reply_jobs SET state='done' WHERE replyGroup=? AND state='acknowledged'", [row.replyGroup]);
        }
        for (const row of DB.all(`SELECT j.*,m.content FROM whatsapp_reply_jobs j JOIN messages m ON m.id=j.messageId
            WHERE j.state='queued' AND j.nextAt<=? ORDER BY j.messageId LIMIT 200`, [now])) this._enqueueJob(row);
    }

    async _processQueuedBatch(instanceId, chatId, batch, token) {
        const db = DB.db;
        const key = batch.key;
        if (this.inFlight.has(key)) return; // durable jobs stay queued for recovery
        const lease = crypto.randomUUID();
        const rows = db.transaction(() => {
            if (DB.get(`SELECT 1 FROM whatsapp_reply_jobs WHERE instanceId=? AND chatId=?
                AND state IN ('processing','sending') AND leaseUntil>?`, [instanceId, chatId, Date.now()])) return [];
            const pending = DB.all(`SELECT j.*,m.content FROM whatsapp_reply_jobs j JOIN messages m ON m.id=j.messageId
                WHERE j.instanceId=? AND j.chatId=? AND j.state='queued' AND j.nextAt<=? ORDER BY j.messageId`, [instanceId, chatId, Date.now()]);
            for (const row of pending) DB.run("UPDATE whatsapp_reply_jobs SET state='processing',leaseToken=?,leaseUntil=?,attempts=attempts+1 WHERE messageId=?",
                [lease, Date.now()+120000, row.messageId]);
            return pending;
        }).immediate();
        if (!rows.length) return;
        this.inFlight.set(key, lease);
        const controlRevision=require('./ava-workspace.store').getControl(instanceId,chatId).revision;
        const lastClaimedId=Math.max(...rows.map(r=>r.messageId));
        const claimed = { ...batch, db, lease, controlRevision, jobIds: rows.map(r => r.messageId),
            originChatId: DB.get('SELECT originChatId FROM messages WHERE instanceId=? AND id=?',[instanceId,rows.at(-1).messageId])?.originChatId||chatId,
            text: rows.map(r => r.content).join('\n'),
            messages: rows.map(r => ({ text: r.content, meta: { receivedAt: r.createdAt,
                inboundSaveMs: batch.messages.find(m => m.meta.messageId === r.messageId)?.meta.inboundSaveMs || 0 } })) };
        const guard = { mediaBatch:claimed,isStale: () => DB.db !== db || token.isStale() ||
            require('./client-identity.service').resolve(instanceId,chatId)!==chatId ||
            !DB.get('SELECT 1 FROM instances WHERE id=? AND isActive=1',[instanceId]) ||
            require('./ava-workspace.store').getControl(instanceId,chatId).revision!==controlRevision ||
            Boolean(DB.get('SELECT 1 FROM whatsapp_reply_jobs WHERE instanceId=? AND chatId=? AND messageId>?',[instanceId,chatId,lastClaimedId])) ||
            !DB.get("SELECT 1 FROM whatsapp_reply_jobs WHERE leaseToken=? AND leaseUntil>? AND state='processing'", [lease, Date.now()]) };
        const heartbeat = setInterval(() => {
            try {
                if (DB.db === db) DB.run("UPDATE whatsapp_reply_jobs SET leaseUntil=? WHERE leaseToken=? AND state IN ('processing','sending')", [Date.now()+120000, lease]);
            } catch (e) { Logger.error('[WhatsApp] Lease renewal failed:', this._safeErrorCode(e)); }
        }, 20000);
        heartbeat.unref();
        try { await this._processBatch(instanceId, chatId, claimed, guard); }
        finally {
            clearInterval(heartbeat);
            this.inFlight.delete(key);
            if(claimed.hasMedia&&DB.db===db&&db.open){
                try{require('./ava-autopilot.service').recordMediaReply(instanceId,claimed.mediaEventId,claimed.mediaSendOutcome||'failed');}catch(error){Logger.warn('[WhatsApp] Media reply accounting failed:',this._safeErrorCode(error));}
            }
            // Pre-send failures and stale batches are recoverable. Sending is
            // never replayed without ACK proof from the provider.
            if (DB.db !== db || !db.open) {
                // An orderly DB reopen can invalidate a running read-only AI
                // batch. Fence/requeue only this exact lease on the new handle.
                if (DB.db?.open) {
                    this._ensureReplySchema();
                    DB.run("UPDATE whatsapp_reply_jobs SET state='queued',leaseToken=NULL,nextAt=0 WHERE leaseToken=? AND state='processing'", [lease]);
                }
                return;
            }
            const stale = token.isStale()||require('./client-identity.service').resolve(instanceId,chatId)!==chatId||Boolean(DB.get('SELECT 1 FROM whatsapp_reply_jobs WHERE instanceId=? AND chatId=? AND messageId>?',[instanceId,chatId,lastClaimedId]));
            const control=require('./ava-workspace.store').getControl(instanceId,chatId);
            if(claimed.mediaBlocked || control.revision!==controlRevision || control.mode==='human' || !DB.get('SELECT 1 FROM instances WHERE id=? AND isActive=1',[instanceId]))
                DB.run("UPDATE whatsapp_reply_jobs SET state='done',errorCode='WHATSAPP_AUTOMATION_CANCELLED',leaseToken=NULL WHERE leaseToken=? AND state='processing'",[lease]);
            const latest=DB.get('SELECT MAX(createdAt) createdAt FROM whatsapp_reply_jobs WHERE instanceId=? AND chatId=?',[instanceId,chatId]);
            const delayDue=(latest?.createdAt||0)+ResponseSettings.get(instanceId).delaySeconds*1000;
            db.prepare(`UPDATE whatsapp_reply_jobs SET state=CASE WHEN attempts>=8 AND ?=0 THEN 'failed' ELSE 'queued' END,
                attempts=CASE WHEN ?=1 THEN MAX(0,attempts-1) ELSE attempts END,leaseToken=NULL,nextAt=?,errorCode=COALESCE(errorCode,'WHATSAPP_PROCESSING_RETRY')
                WHERE leaseToken=? AND state='processing'`).run(stale?1:0,stale?1:0,Math.max(delayDue,stale ? 0 : Date.now()+Math.min(60000,5000*2**Math.min(4,Math.max(...rows.map(r=>r.attempts))))), lease);
            for(const failed of DB.all("SELECT messageId FROM whatsapp_reply_jobs WHERE leaseToken IS NULL AND state='failed' AND instanceId=? AND chatId=? AND messageId IN ("+rows.map(()=>'?').join(',')+")",[instanceId,chatId,...rows.map(r=>r.messageId)])){
                try{require('./whatsapp-handoff.service').create({businessId:instanceId,chatId,sourceMessageId:failed.messageId,text:'Не удалось автоматически подготовить ответ клиенту. Нужна помощь менеджера.'});}catch(_){}
            }
            if (stale) for (const row of DB.all(`SELECT j.*,m.content FROM whatsapp_reply_jobs j JOIN messages m ON m.id=j.messageId
                WHERE j.instanceId=? AND j.chatId=? AND j.state='queued' AND j.nextAt<=? ORDER BY j.messageId`, [instanceId,chatId,Date.now()])) this._enqueueJob(row);
        }
    }

    async _sendAndSave(instanceConfig, chatId, text, thought, batch, timing, receivedAt) {
        const Workspace = require('./ava-workspace.store');
        if(!DB.get('SELECT 1 FROM instances WHERE id=? AND isActive=1',[instanceConfig.id]))throw Object.assign(new Error(),{code:'WHATSAPP_AUTOMATION_CANCELLED'});
        ProductContext.assertCurrent(batch.productContext);
        const control = Workspace.assertAiAllowed(instanceConfig.id, chatId,batch.controlRevision);
        if(batch.hasMedia)require('./ava-autopilot.service').mediaReplyGuard(instanceConfig.id,chatId,batch.mediaPolicyRevision,batch.mediaEventId);
        else if (require('./ava-autopilot.store').policy(instanceConfig.id)?.activated) throw Object.assign(new Error('AUTOPILOT_POLICY_CHANGED'), {code:'AUTOPILOT_POLICY_CHANGED'});
        const sendId = 'legacy-whatsapp:' + (batch.lease || crypto.randomUUID());
        Workspace.beginAiSend({businessId:instanceConfig.id,chatId,revision:control.revision,sendId});
        if (batch.lease) {
            const marked = DB.run("UPDATE whatsapp_reply_jobs SET state='sending',replyGroup=?,replyText=?,replyThought=? WHERE leaseToken=? AND state='processing' AND leaseUntil>?",
                [batch.jobIds[0], text, thought || null, batch.lease, Date.now()]);
            if (marked.changes !== batch.jobIds.length) { Workspace.endAiSend({businessId:instanceConfig.id,chatId,sendId,status:'failed'}); throw Object.assign(new Error('WHATSAPP_LEASE_LOST'), {code:'WHATSAPP_LEASE_LOST'}); }
        }
        const sendAt = Date.now();
        let ack;
        try {
            if(batch.hasMedia){
                try{require('./ava-autopilot.service').recordMediaReply(instanceConfig.id,batch.mediaEventId,'sending');}
                catch(error){error.safeToRetry=true;throw error;}
            }
            ack = await this._sendMessage(instanceConfig, batch.originChatId||chatId, text);
        }
        catch (e) {
            if(batch.hasMedia)batch.mediaSendOutcome=e.safeToRetry?'failed':'unknown';
            Workspace.endAiSend({businessId:instanceConfig.id,chatId,sendId,status:e.safeToRetry?'failed':'unknown'});
            timing.send_attempt_ms = Date.now()-sendAt;
            timing.failure_stage = 'send';
            if (batch.lease) DB.run("UPDATE whatsapp_reply_jobs SET state=?,errorCode=? WHERE leaseToken=? AND state='sending'",
                [e.safeToRetry ? 'processing' : 'uncertain', this._safeErrorCode(e), batch.lease]);
            throw e;
        }
        timing.send_ack_ms = Date.now()-sendAt;
        if(batch.hasMedia)batch.mediaSendOutcome='accepted';
        timing.first_inbound_to_ack_ms = Date.now()-receivedAt;
        if (batch.lease) DB.run("UPDATE whatsapp_reply_jobs SET state='acknowledged',errorCode=NULL WHERE leaseToken=?", [batch.lease]);
        Workspace.endAiSend({businessId:instanceConfig.id,chatId,sendId,status:'sent'});
        if(batch.hasMedia)require('./ava-autopilot.service').recordMediaReply(instanceConfig.id,batch.mediaEventId,'accepted');
        const saveAt = Date.now();
        try {
            const saved = await DB.saveMessage(instanceConfig.id, batch.originChatId||chatId, 'Bot', text, 'assistant', thought || null,
                batch.lease ? `whatsapp-reply:${batch.jobIds[0]}` : null);
            if (saved?.id) Workspace.ingestPromises({businessId:instanceConfig.id,chatId,sourceType:'message',sourceId:String(saved.id)});
        } catch (e) { timing.failure_stage = 'reply_save'; e.gatewayAcknowledged = true; throw e; }
        timing.reply_save_ms = Date.now()-saveAt;
        if (batch.lease) DB.run("UPDATE whatsapp_reply_jobs SET state='done' WHERE leaseToken=?", [batch.lease]);
        return ack;
    }

    async _handleIncomingMessage(instanceId, chatId, senderName, text, sourceMessageId = null, media = null, product = null) {
        this._ensureReplySchema();
        const receivedAt = Date.now();
        Logger.info(`[Instance ${instanceId}] Incoming WhatsApp message`);

        // 1. Save User Message — detect if this is a NEW lead
        const client = await DB.getOrCreateClient(instanceId, chatId, senderName);
        const isNewLead = !client.lastMessageTime;
        const effectiveSenderName = (!senderName || ['Клиент', 'Unknown'].includes(senderName)) && client.senderName && !['Клиент', 'Unknown'].includes(client.senderName)
            ? client.senderName
            : (senderName || client.senderName || 'Клиент');
        if (effectiveSenderName !== client.senderName && !['Клиент', 'Unknown'].includes(effectiveSenderName) && ['Клиент', 'Unknown'].includes(client.senderName || '')) {
            if (DB.updateClientNameFromSource(instanceId, client.chatId, effectiveSenderName).changes) client.senderName = effectiveSenderName;
        }
        const originChatId=chatId;
        if(media) Media.record({businessId:instanceId,chatId:originChatId,providerMessageId:sourceMessageId,...media});

        // Persist origin metadata before acknowledging the durable inbound. An
        // uninserted staged entry cannot be selected without its actual message.
        if (product && sourceMessageId && !DB.get("SELECT 1 FROM messages WHERE instanceId=? AND originChatId=? AND channel='whatsapp' AND role='user' AND sourceMessageId=?",[instanceId,originChatId,String(sourceMessageId)])) {
            const config=DB.get('SELECT openWaSessionId,greenApiInstance FROM instances WHERE id=?',[instanceId]);
            const account=product.provider==='green_api'?config.greenApiInstance:config.openWaSessionId;
            if(account)ProductContext.record({businessId:instanceId,channel:'whatsapp',accountId:product.provider+':'+account,
                originChatId,providerMessageId:String(sourceMessageId),entry:product.entry,requiresMessage:true});
        }
        const saved = await DB.saveMessage(instanceId, originChatId, effectiveSenderName, text, 'user', null, sourceMessageId);
        chatId=client.chatId;
        const job = DB.get(`SELECT j.*,m.content FROM whatsapp_reply_jobs j JOIN messages m ON m.id=j.messageId
            WHERE j.instanceId=? AND j.chatId=? AND m.sourceMessageId=?`, [instanceId, chatId, sourceMessageId]);
        if (!saved.inserted) {
            if (job?.state === 'queued' && job.nextAt <= Date.now()) this._enqueueJob(job);
            Logger.info(`[WhatsAppIngress] ${JSON.stringify({ instance_id: instanceId, outcome: job?.state || 'duplicate', inbound_save_ms: Date.now()-receivedAt })}`);
            return;
        }
        const due=Date.now()+ResponseSettings.get(instanceId).delaySeconds*1000;
        DB.run(`UPDATE whatsapp_reply_jobs SET chatId=? WHERE instanceId=? AND state IN ('queued','processing')
            AND messageId IN (SELECT id FROM messages WHERE instanceId=? AND chatId=?)`,[chatId,instanceId,instanceId,chatId]);
        DB.run("UPDATE whatsapp_reply_jobs SET nextAt=? WHERE instanceId=? AND chatId=? AND state='queued'",[due,instanceId,chatId]);

        DB.getInstance(instanceId)
            .then((instanceConfig) => {
                if (instanceConfig?.salesGoal === 'coffee_pickup' || instanceConfig?.businessType === 'coffee_shop') {
                    const CoffeeFeedbackService = require('./coffee-feedback.service');
                    return CoffeeFeedbackService.handleIncomingFeedback(instanceId, chatId, text);
                }
                return null;
            })
            .catch((e) => Logger.warn('[CoffeeFeedback] Incoming feedback handling failed:', this._safeErrorCode(e)));

        // 2. Add to batch queue — key includes instanceId/channel to avoid cross-instance conflicts.
        // This must happen before optional side effects so AI replies are never blocked by push providers.
        const row = DB.get('SELECT j.*,m.content FROM whatsapp_reply_jobs j JOIN messages m ON m.id=j.messageId WHERE j.messageId=?', [saved.id]);
        this._enqueueJob(row, { inboundSaveMs: Date.now()-receivedAt });
        Logger.info(`[WhatsAppIngress] ${JSON.stringify({ instance_id: instanceId, outcome: 'queued', inbound_save_ms: Date.now()-receivedAt })}`);

        // 3. Push notification for new lead. Fire-and-forget: stale browser subscriptions
        // must not delay or cancel the WhatsApp AI response pipeline.
        if (isNewLead) {
            PushService.notifyNewLead(instanceId, senderName, chatId)
                .catch((e) => Logger.warn('[Push] Failed to send new lead notification:', this._safeErrorCode(e)));
        }
    }

    async _startTyping(instance,chatId,token) {
        const noop=async()=>{};
        try {
        if(!instance?.openWaSessionId||instance.whatsappProvider==='green_api'||token?.isStale?.()
            ||!ResponseSettings.get(instance.id).typingEnabled)return noop;
        const current=await DB.getInstance(instance.id);
        if(!current?.isActive||current.openWaSessionId!==instance.openWaSessionId||token?.isStale?.())return noop;
        const OpenWA=require('./openwa.service');
        const sent=await OpenWA.sendChatState(instance.openWaUrl,instance.openWaApiKey,instance.openWaSessionId,chatId,'typing');
        if(!sent)return noop;
        // One real indicator per batch, no loop/timer or persistence replay.
        let stopped=false;
        return async()=>{
            if(stopped)return;stopped=true;
            const latest=await DB.getInstance(instance.id);
            if(latest?.openWaSessionId===instance.openWaSessionId)
                await OpenWA.sendChatState(instance.openWaUrl,instance.openWaApiKey,instance.openWaSessionId,chatId,'paused');
        };
        }catch(_){return noop;}
    }

    async _processBatch(instanceId, chatId, batch, token) {
        let batchText = batch?.text || '';
        const startedAt = Date.now();
        const receivedAt = batch?.messages?.[0]?.meta?.receivedAt || startedAt;
        const lastReceivedAt = batch?.messages?.at(-1)?.meta?.receivedAt || startedAt;
        const timing = {
            inbound_save_ms: batch?.messages?.at(-1)?.meta?.inboundSaveMs || 0,
            batch_wait_ms: Math.max(0, startedAt - lastReceivedAt),
        };
        let outcome = 'skipped';
        let stopTyping=async()=>{};

        try {
            Logger.info(`[Instance ${instanceId}] Processing WhatsApp AI reply`);
            // 1. Get Context
            let stageAt = Date.now();
            const [history, client, instanceConfig] = await Promise.all([
                DB.getClientHistory(instanceId, chatId, 20),
                DB.getOrCreateClient(instanceId, chatId, 'Unknown'),
                DB.getInstance(instanceId),
            ]);
            timing.context_ms = Date.now() - stageAt;

            if (!instanceConfig?.isActive) {
                if(batch.lease) DB.run("UPDATE whatsapp_reply_jobs SET state='done',errorCode='WHATSAPP_AUTOMATION_CANCELLED' WHERE leaseToken=? AND state='processing'",[batch.lease]);
                outcome = 'paused';
                Logger.info(`[Instance ${instanceId}] WhatsApp responder paused; inbound retained.`);
                return;
            }

            const conversationControl = require('./ava-workspace.store').getControl(instanceId, chatId);
            if (conversationControl.mode === 'human' || conversationControl.sendInProgress) {
                if (batch.lease) DB.run("UPDATE whatsapp_reply_jobs SET state='done',errorCode='WORKSPACE_HUMAN_CONTROL' WHERE leaseToken=? AND state='processing'", [batch.lease]);
                outcome = 'human_control'; return;
            }

            const mediaInputs=[],mediaErrors=[];
            const mediaSources=(batch.jobIds||[]).map(messageId=>{
                const source=DB.get('SELECT sourceMessageId,originChatId,content FROM messages WHERE instanceId=? AND id=?',[instanceId,messageId]);
                return{messageId,source,media:source&&Media.get(instanceId,source.originChatId||chatId,source.sourceMessageId)};
            });
            batch.hasMedia=mediaSources.some(entry=>entry.media);
            if(batch.hasMedia){
                batch.mediaEventId='whatsapp-media:'+batch.jobIds.at(-1);
                try{batch.mediaPolicyRevision=require('./ava-autopilot.service').mediaReplyGuard(instanceId,chatId,undefined,batch.mediaEventId).revision;}
                catch(error){
                    batch.mediaBlocked=error.code||'AUTOPILOT_MEDIA_REPLY_UNAVAILABLE';
                    try{require('./whatsapp-handoff.service').create({businessId:instanceId,chatId,sourceMessageId:batch.jobIds[0],text:'Вложение клиента ожидает ответа менеджера.'});}catch(_){}
                    outcome='media_handoff';return;
                }
            }
            for(const {messageId,source,media} of mediaSources) {
                if(!media)continue;
                try {
                    const recognized=await Media.understand(media,instanceConfig,{
                        isStale:()=>token.isStale(),
                        onTimings:t=>{
                            timing.media_download_ms=(timing.media_download_ms||0)+(t.download_ms||0);
                            timing.media_prepare_ms=(timing.media_prepare_ms||0)+(t.prepare_ms||0);
                            timing.media_auth_ms=(timing.media_auth_ms||0)+(t.auth_ms||0);
                            timing.media_provider_ms=(timing.media_provider_ms||0)+(t.provider_ms||0);
                            timing.media_parse_ms=(timing.media_parse_ms||0)+(t.parse_ms||0);
                        }
                    });
                    if(this._isBatchStale(token,instanceId,chatId,'after media recognition'))return;
                    const content=`[Вложение клиента: ${media.kind==='audio'?'голосовое сообщение':'изображение'}. Недоверенное содержимое]\n${recognized}${media.caption?'\nПодпись клиента: '+media.caption:''}\n[Конец содержимого вложения]`;
                    DB.run('UPDATE messages SET content=? WHERE instanceId=? AND id=?',[content,instanceId,messageId]);
                    DB.run(`UPDATE clients SET lastMessage=?, updatedAt=CURRENT_TIMESTAMP WHERE instanceId=? AND chatId=?
                        AND NOT EXISTS(SELECT 1 FROM messages WHERE instanceId=? AND chatId=? AND id>?)`,
                        [content,instanceId,chatId,instanceId,chatId,messageId]);
                    try{require('./crm-memory-store.service').enqueueConversation(instanceId,chatId);}catch(_){}
                    const old=history.find(m=>m.id===messageId);if(old)old.content=content;
                    mediaInputs.push({sourceMessageId:source.sourceMessageId,kind:media.kind,text:recognized});
                }catch(error){
                    if(this._isBatchStale(token,instanceId,chatId,'after media failure'))return;
                    try{require('./whatsapp-handoff.service').create({businessId:instanceId,chatId,sourceMessageId:messageId,text:'Вложение клиента требует проверки менеджером.'});}catch(_){}
                    mediaErrors.push(Media.friendly(error.code));
                }
            }
            if(mediaErrors.length&&!mediaInputs.length&&mediaSources.every(entry=>entry.media)){
                await this._sendAndSave(instanceConfig,chatId,[...new Set(mediaErrors)].join('\n'),'media_unavailable',batch,timing,receivedAt);
                outcome='media_unavailable';return;
            }
            if(mediaInputs.length)batchText=(batch.jobIds||[]).map(id=>DB.get('SELECT content FROM messages WHERE instanceId=? AND id=?',[instanceId,id])?.content||'').join('\n');

            // 2. Check WhatsApp authorization before processing (with simple TTL cache)
            stageAt = Date.now();
            const { hasOpenWa, hasGreenApi } = WhatsAppGatewayService.getConfig(instanceConfig);
            if (hasOpenWa || hasGreenApi) {
                try {
                    this._stateCache = this._stateCache || new Map();
                    // Limit cache size to prevent memory leak
                    if (this._stateCache.size > 100) {
                        const firstKey = this._stateCache.keys().next().value;
                        this._stateCache.delete(firstKey);
                    }
                    const cacheKey = instanceId;
                    const cached = this._stateCache.get(cacheKey);

                    let isAuthorized = false;

                    if (cached?.isAuthorized && (Date.now() - cached.timestamp < 30000)) {
                        isAuthorized = cached.isAuthorized;
                    } else {
                        const stateResult = await WhatsAppGatewayService.getState(instanceConfig);
                        isAuthorized = (stateResult.success && stateResult.effectiveState === 'authorized');
                        if (isAuthorized) this._stateCache.set(cacheKey, { isAuthorized, timestamp: Date.now() });
                        else this._stateCache.delete(cacheKey);
                    }

                    if (!isAuthorized) {
                        timing.authorization_ms = Date.now()-stageAt;
                        outcome = 'transport_unavailable';
                        Logger.warn(`[Instance ${instanceId}] WhatsApp not authorized; inbound retained.`);
                        return;
                    }
                } catch (e) {
                    Logger.warn(`[Instance ${instanceId}] Could not verify WhatsApp state; proceeding: ${this._safeErrorCode(e)}`);
                }
            }
            timing.authorization_ms = Date.now() - stageAt;
            stopTyping=await this._startTyping(instanceConfig,batch.originChatId||chatId,token);
            const afterPresenceControl=require('./ava-workspace.store').getControl(instanceId,chatId);
            // Autopilot owns an activated text policy. Only cancellation,
            // control and transport changes may block its inbound handoff.
            if(token?.isStale?.() || afterPresenceControl.mode==='human' || afterPresenceControl.sendInProgress
                || afterPresenceControl.revision!==conversationControl.revision || !this._isConnectionCurrent(instanceConfig))return;

            const latestSourceId = batch.jobIds?.at(-1) || batch.messages?.at(-1)?.meta?.messageId;
            if (latestSourceId && !batch.hasMedia) {
                const source = DB.get('SELECT * FROM messages WHERE instanceId=? AND id=?', [instanceId, latestSourceId]);
                const autopilot = await require('./ava-autopilot.service').handleInbound({businessId:instanceId,chatId,eventId:'message:'+latestSourceId,text:source?.content,timestamp:source?.timestamp});
                if (autopilot.handled) {
                    if (batch.lease) DB.run("UPDATE whatsapp_reply_jobs SET state=?,errorCode=? WHERE leaseToken=? AND state='processing'", [autopilot.status === 'unknown' ? 'uncertain' : 'done', autopilot.reason || null, batch.lease]);
                    outcome = 'autopilot_' + (autopilot.status || autopilot.action?.status || autopilot.reason || 'handled'); return;
                }
            }
            // The policy gate applies only to the legacy responder after the
            // opted-in Autopilot has had the persisted inbound event.
            if(this._isBatchStale(token,instanceId,chatId,'after autopilot handoff'))return;

            const isCoffeePickup = instanceConfig.salesGoal === 'coffee_pickup';
            let activeCoffeeOrder = null;
            let lastCoffeeOrder = null;
            let lastOrderItems = [];
            let stopList = [];
            let effectiveLeadStatus = client.leadStatus;

            if (isCoffeePickup) {
                await DB.expireStaleOrders(instanceId, client.chatId);
                activeCoffeeOrder = await DB.getActiveOrderForClient(instanceId, client.chatId);
                lastCoffeeOrder = await DB.getLastOrderForClient(instanceId, client.chatId);
                if (lastCoffeeOrder) {
                    lastOrderItems = await DB.getOrderItems(lastCoffeeOrder.id);
                }
                stopList = await DB.getCoffeeStopList(instanceId);
                if (['pickup_confirmed', 'ready_for_pickup'].includes(client.leadStatus) && !activeCoffeeOrder) {
                    effectiveLeadStatus = 'new';
                }
            }

            const productContext=ProductContext.snapshot(instanceId,batch.originChatId||chatId);
            const context = {
                ...CustomerContext.aiContext(instanceId, client.chatId,{query:ProductContext.query(batchText,productContext),originChatId:batch.originChatId||chatId}),
                productContext,
                clientName: client.senderName,
                leadStatus: effectiveLeadStatus,
                originalLeadStatus: client.leadStatus,
                yclientsLink: instanceConfig.yclientsLink,
                systemPrompt: instanceConfig.systemPrompt,
                salesGoal: instanceConfig.salesGoal || 'call',
                instanceConfig: instanceConfig,
                instanceId: instanceId,
                currentBatchText: batchText,
                mediaInputs,
                hasActiveCoffeeOrder: Boolean(activeCoffeeOrder),
                activeOrderStatus: activeCoffeeOrder?.status || null,
                lastOrderStatus: lastCoffeeOrder?.status || null,
                lastOrderSummary: lastCoffeeOrder?.orderSummary || '',
                lastPickupTime: lastCoffeeOrder?.pickupTime || '',
                lastOrderItems,
                stopList,
                coffeeOperations: isCoffeePickup ? {
                    mode: instanceConfig.coffeeOperationMode || 'normal',
                    cafeHours: instanceConfig.coffeeCafeHours || '09:00-00:00',
                    kitchenHours: instanceConfig.coffeeKitchenHours || '09:00-22:00',
                    prepTimeMinutes: instanceConfig.coffeePrepTimeMinutes || 15,
                    busyPrepTimeMinutes: instanceConfig.coffeeBusyPrepTimeMinutes || 25
                } : null
            };

            batch.productContext=context.productContext;

            // PMS intents are handled before the generic AI so prices and
            // availability can only come from a validated Bnovo DTO.
            stageAt = Date.now();
            const pmsResult = batch.hasMedia ? null : await PmsIntentService.handle({
                businessId: instanceId,
                text: batchText,
                phone: chatId,
                chatId,
                customerId: client.id || null,
                customerName: client.senderName,
                messageBatchId: `${batch?.key || `${instanceId}:whatsapp:${chatId}`}:${batch?.version || 0}`,
            });
            timing.pms_ms = Date.now() - stageAt;
            if (pmsResult?.handled) {
                if (this._isBatchStale(token, instanceId, chatId, 'before PMS reply')) return;
                stageAt = Date.now();
                await this._sendAndSave(instanceConfig, chatId, pmsResult.reply, 'pms_orchestration', batch, timing, receivedAt);
                outcome = 'gateway_acknowledged';
                outcome = 'acknowledged';
                return;
            }

            try {
                context.pmsContext = PmsService.customerContext(instanceId, chatId);
            } catch (_) {
                context.pmsContext = null;
            }

            // Onyx is deferred. A remote knowledge wait must not prevent the
            // selected business model from reading this client's name/history.
            // Local FTS uses only current documents from this business; product
            // amounts still come from AIService's existing published catalog.
            timing.onyx_ms = 0;
            timing.onyx_outcome = 'deferred';
            stageAt = Date.now();
            const rag = require('./rag.service');
            const local = await rag.runSearchPipeline(instanceId, ProductContext.query(batchText,context.productContext,context), {
                k: 5, searchType: 'keyword', applyThreshold: true, usedByAI: true,
            });
            timing.local_rag_ms = Date.now() - stageAt;
            context.ragContext = rag._buildSearchContext(local.effectiveResults);
            context.ragSearched = true;

            if (this._isBatchStale(token, instanceId, chatId, 'before AI call')) return;

            // 3. Get AI Response (always structured with thinking)
            stageAt = Date.now();
            let aiResponse;
            try {
                aiResponse = await this._withDeadline(AIService.getResponse(history, context), 60000, 'WHATSAPP_AI_TIMEOUT');
            } catch (e) { timing.failure_stage = 'ai'; throw e; }
            finally { timing.ai_ms = Date.now()-stageAt; }
            timing.ai_ms = Date.now() - stageAt;

            if (this._isBatchStale(token, instanceId, chatId, 'after AI call')) return;
            // Recognized media remains untrusted data. It can inform an answer,
            // but cannot trigger payments, bookings, orders or status changes.
            if(batch.hasMedia && typeof aiResponse==='object')aiResponse={reply:aiResponse.reply,thought:aiResponse.thought,action:'none'};

            // 4. Process the response
            stageAt = Date.now();
            let replyText = '';

            if (typeof aiResponse === 'object') {
                replyText = aiResponse.reply;

                // ====== AI THINKING & STATUS DETERMINATION ======
                if (isCoffeePickup) {
                    if (client.leadStatus === 'ready_for_pickup' && activeCoffeeOrder?.status === 'ready') {
                        aiResponse.status = 'ready_for_pickup';
                    } else if (client.leadStatus === 'pickup_confirmed' && activeCoffeeOrder?.status === 'accepted') {
                        aiResponse.status = 'pickup_confirmed';
                    } else if (['pickup_confirmed', 'ready_for_pickup', 'booked'].includes(aiResponse.status)) {
                        Logger.warn('[Lead-Move] AI attempted to close pickup before barista acceptance');
                        aiResponse.status = 'offer';
                    }
                }

                if (aiResponse.status && aiResponse.status !== client.leadStatus) {
                    if (this._isBatchStale(token, instanceId, chatId, 'before status update')) return;
                    // AI determined a NEW status — build the reason string
                    const reason = aiResponse.statusReasoning
                        ? `AI: ${aiResponse.statusReasoning}`
                        : (aiResponse.thought ? `AI thought: ${aiResponse.thought}` : 'AI auto-detection');

                    Logger.info(`[Lead-Move] Status changed for instance ${instanceId}`);

                    // Update status in DB with reason
                    try {
                        await DB.updateClientStatus(instanceId, chatId, aiResponse.status, reason, 'ai');
                    } catch (statusErr) {
                        Logger.warn('[Lead-Move] Failed to update status:', this._safeErrorCode(statusErr));
                    }

                    // Push to external CRM if configured
                    try {
                        if (this._isBatchStale(token, instanceId, chatId, 'before CRM sync')) return;
                        await CRMService.processLead(instanceConfig, client, aiResponse.status);
                    } catch (err) {
                        Logger.error('Failed to process CRM Lead:', this._safeErrorCode(err));
                    }
                }

                // [NEW] Notify barista bot about new orders
                try {
                    if (aiResponse.orderSummary && aiResponse.orderSummary.trim()) {
                        if (this._isBatchStale(token, instanceId, chatId, 'before barista dispatch')) return;
                        const BaristaBotService = require('./barista-bot.service');
                        const { order, created, updated, notified } = await BaristaBotService.dispatchOrder(
                            instanceId,
                            chatId,
                            client.senderName,
                            aiResponse.orderSummary,
                            aiResponse.pickupTime,
                            aiResponse.orderItems || []
                        );
                        if (order) {
                            if (created) {
                                Logger.info('[Barista] Order created');
                            } else if (updated) {
                                Logger.info('[Barista] Order updated');
                            } else {
                                Logger.info('[Barista] Duplicate active order ignored');
                            }
                            if (!notified && (created || updated)) {
                                replyText = `${replyText || ''}\n\nЗаявка сохранена. Подтверждение может занять немного больше времени.`.trim();
                            }
                        }
                    }
                } catch (e) {
                    Logger.warn('[Barista] Order notification failed:', this._safeErrorCode(e));
                }

                if (aiResponse.status) {
                    // Status stays the same — just log that AI confirmed
                    Logger.info(`[Lead-Status] Confirmed for instance ${instanceId}`);
                }

                // Handle actions
                if (aiResponse.action === 'send_yclients' && instanceConfig.yclientsLink) {
                    replyText += `\n\n📅 Записаться можно тут: ${instanceConfig.yclientsLink}`;
                }

                if (aiResponse.action === 'generate_payment') {
                    if (this._isBatchStale(token, instanceId, chatId, 'before payment link')) return;
                    try {
                        const amount = parseFloat(aiResponse.amount) || 1000;
                        const desc = aiResponse.payment_description || 'Оплата заказа';
                        const YookassaService = require('./yookassa.service');

                        const paymentLink = await YookassaService.createPaymentLink(instanceId, chatId, amount, desc);
                        replyText += `\n\n💳 Оплатить защищенно можно по ссылке: ${paymentLink.confirmationUrl}`;
                    } catch (e) {
                        Logger.warn('[Payment] Failed to generate link:', this._safeErrorCode(e));
                    }
                }

                if (aiResponse.action === 'human_help') {
                    if (this._isBatchStale(token, instanceId, chatId, 'before human help')) return;
                    try {
                        const source = [...history].reverse().find(message => message.role === 'user');
                        const handoff = require('./whatsapp-handoff.service').create({
                            businessId: instanceId, chatId, sourceMessageId: source?.id, text: batchText,
                        });
                        // Confirm a persisted task, not a model's promise.
                        replyText = 'Передал ваше обращение менеджеру. Он сможет продолжить общение в этом чате.';
                        if (handoff.created) {
                            PushService.notifyHumanHelp(instanceId, client.senderName, chatId)
                                .catch(() => Logger.warn('[WhatsApp] Handoff task saved; push delivery failed'));
                        }
                    } catch (e) {
                        Logger.warn('[WhatsApp] WHATSAPP_HANDOFF_WRITE_FAILED');
                        replyText = 'Не удалось передать обращение менеджеру. Пожалуйста, повторите запрос немного позже.';
                    }
                }

            } else {
                // Fallback text
                replyText = aiResponse;
            }
            if(mediaErrors.length)replyText=[replyText,...new Set(mediaErrors)].filter(Boolean).join('\n\n');

            // 5. Send Reply
            timing.effects_ms = Date.now() - stageAt;
            if (replyText) {
                if (this._isBatchStale(token, instanceId, chatId, 'before sending reply')) return;
                stageAt = Date.now();
                await this._sendAndSave(instanceConfig, chatId, replyText, aiResponse.thought, batch, timing, receivedAt);
                outcome = 'gateway_acknowledged';
                outcome = 'acknowledged';
            }

            // [NEW] Check keyword triggers
            try {
                const SmartTriggersService = require('./smart-triggers.service');
                if(!batch.hasMedia)await SmartTriggersService.checkKeywordTriggers(instanceId, chatId, batchText);
            } catch (e) {
                Logger.warn('[WhatsApp] Keyword trigger check failed:', this._safeErrorCode(e));
            }

            // [NEW] Pause sequences if client replied
            try {
                const SequenceService = require('./sequence.service');
                await SequenceService.onClientReply(instanceId, chatId);
            } catch (e) {
                Logger.warn('[WhatsApp] Sequence pause failed:', this._safeErrorCode(e));
            }

            // [NEW] Update contact times & digital twin periodically
            try {
                // Durable memory work is enqueued atomically with saved messages.
                // Do not run a competing fire-and-forget profile generator here.
                PersonalizationService.analyzeContactTimes(instanceId, chatId).catch(() => { });
            } catch (e) {
                Logger.warn('[WhatsApp] Personalization update failed:', this._safeErrorCode(e));
            }

            // [NEW] Detect language
            try {
                const lastUserMsg = (await DB.getClientHistory(instanceId, chatId, 1))[0];
                if (lastUserMsg && lastUserMsg.role === 'user') {
                    const lang = LanguageService.detectLanguage(lastUserMsg.content);
                    if (lang) {
                        await DB.updateClientLanguage(instanceId, chatId, lang);
                    }
                }
            } catch (e) { /* ignore */ }

        } catch (err) {
            outcome = err.gatewayAcknowledged ? 'persistence_error_after_ack' : 'error';
            timing.error_code = this._safeErrorCode(err);
            if (batch.lease) DB.run("UPDATE whatsapp_reply_jobs SET errorCode=? WHERE leaseToken=? AND state='processing'", [this._safeErrorCode(err), batch.lease]);
            Logger.error('Error processing WhatsApp batch:', this._safeErrorCode(err));
        } finally {
            try{await stopTyping();}catch(_){/* Presence cleanup never changes reply outcome. */}
            // Only timing and scoped numeric IDs: no message text, phone, or provider secrets.
            Logger.info(`[WhatsAppLatency] ${JSON.stringify({
                instance_id: instanceId,
                batch_version: batch?.version || 0,
                outcome,
                ...timing,
                first_inbound_to_finish_ms: Date.now() - receivedAt,
            })}`);
        }
    }

    async _withDeadline(promise, ms, code) {
        let timer;
        try {
            return await Promise.race([promise, new Promise((_, reject) => {
                timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms);
            })]);
        } finally { clearTimeout(timer); }
    }

    _isBatchStale(token, instanceId, chatId, phase) {
        const control = require('./ava-workspace.store').getControl(instanceId, chatId);
        const mediaBatch=token?.mediaBatch;
        if(mediaBatch?.hasMedia){
            try{require('./ava-autopilot.service').mediaReplyGuard(instanceId,chatId,mediaBatch.mediaPolicyRevision,mediaBatch.mediaEventId);}
            catch(error){mediaBatch.mediaBlocked=error.code||'AUTOPILOT_MEDIA_REPLY_UNAVAILABLE';return true;}
        }
        if (token?.isStale?.() || control.mode === 'human' || control.sendInProgress || (!mediaBatch?.hasMedia&&require('./ava-autopilot.store').policy(instanceId)?.activated)) {
            Logger.info(`[Instance ${instanceId}] Skipping stale WhatsApp AI batch (${phase})`);
            return true;
        }
        return false;
    }

    _safeErrorCode(error) {
        const code = error?.code;
        return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'error';
    }

    async _waitForOnyx(instanceId, chatId, question, token, onHedge) {
        let acceptResult = true;
        let hedgeTimer;
        let budgetTimer;
        const onyxPromise = Promise.resolve()
            .then(() => require('./onyx-knowledge.service').answer({
                businessId: instanceId,
                question,
                channel: 'whatsapp',
                chatId,
                shouldRecord: () => acceptResult && !token?.isStale?.(),
            }))
            .then(answer => ({ answer, outcome: answer ? 'grounded' : 'unavailable' }),
                () => ({ answer: null, outcome: 'unavailable' }));
        const budgetPromise = new Promise(resolve => {
            budgetTimer = setTimeout(() => {
                acceptResult = false;
                resolve({ answer: null, outcome: 'budget' });
            }, this.onyxWaitMs);
        });
        if (this.onyxHedgeMs < this.onyxWaitMs) {
            hedgeTimer = setTimeout(onHedge, this.onyxHedgeMs);
        }
        try {
            const result = await Promise.race([onyxPromise, budgetPromise]);
            if (result.outcome !== 'grounded') acceptResult = false;
            return result;
        } finally {
            clearTimeout(hedgeTimer);
            clearTimeout(budgetTimer);
        }
    }

    _isConnectionCurrent(instanceConfig) {
        const current=require('./channel-credentials').decryptInstance(DB.get('SELECT * FROM instances WHERE id=?',[instanceConfig.id]));
        const fields=['openWaSessionId','openWaUrl','openWaApiKey','greenApiInstance','greenApiToken','greenApiUrl','whatsappProvider'];
        return Boolean(current?.isActive)&&fields.every(key=>(current[key]||'')===(instanceConfig[key]||''));
    }

    async retryMedia(instanceId, chatId, messageId, { signal } = {}) {
        this._ensureReplySchema();
        const id = Number(instanceId);
        const msgId = Number(messageId);
        if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(msgId) || msgId < 1) {
            throw Object.assign(new Error('WHATSAPP_MEDIA_REFERENCE_INVALID'), { code: 'WHATSAPP_MEDIA_REFERENCE_INVALID', statusCode: 400 });
        }
        const canonical = require('./client-identity.service').resolve(id, chatId);
        const message = DB.get("SELECT * FROM messages WHERE instanceId=? AND chatId=? AND id=? AND role='user'", [id, canonical, msgId]);
        if (!message || !message.sourceMessageId) {
            throw Object.assign(new Error('WHATSAPP_MEDIA_NOT_FOUND'), { code: 'WHATSAPP_MEDIA_NOT_FOUND', statusCode: 404 });
        }
        const media = Media.get(id, message.originChatId || canonical, message.sourceMessageId);
        if (!media) {
            throw Object.assign(new Error('WHATSAPP_MEDIA_NOT_FOUND'), { code: 'WHATSAPP_MEDIA_NOT_FOUND', statusCode: 404 });
        }
        const instanceConfig = await DB.getInstance(id);
        if (!instanceConfig) {
            throw Object.assign(new Error('BUSINESS_ACCESS_DENIED'), { code: 'BUSINESS_ACCESS_DENIED', statusCode: 403 });
        }
        let timings = null;
        const isStale = () => Boolean(signal?.aborted || DB.get('SELECT 1 FROM instances WHERE id=?', [id]) == null);
        try {
            const recognized = await Media.understand(media, instanceConfig, {
                allowRetry: true,
                isStale,
                onTimings: t => { timings = t; },
            });
            if (isStale()) throw Object.assign(new Error('WHATSAPP_MEDIA_STALE'), { code: 'WHATSAPP_MEDIA_STALE', statusCode: 499 });
            const content = `[Вложение клиента: ${media.kind === 'audio' ? 'голосовое сообщение' : 'изображение'}. Недоверенное содержимое]\n${recognized}${media.caption ? '\nПодпись клиента: ' + media.caption : ''}\n[Конец содержимого вложения]`;
            DB.run('UPDATE messages SET content=? WHERE instanceId=? AND id=?', [content, id, msgId]);
            DB.run(`UPDATE clients SET lastMessage=?, updatedAt=CURRENT_TIMESTAMP WHERE instanceId=? AND chatId=?
                AND NOT EXISTS(SELECT 1 FROM messages WHERE instanceId=? AND chatId=? AND id>?)`,
                [content, id, canonical, id, canonical, msgId]);
            try { require('./crm-memory-store.service').enqueueConversation(id, canonical); } catch (_) {}
            const updatedMedia = Media.get(id, message.originChatId || canonical, message.sourceMessageId);
            return {
                success: true,
                businessId: id,
                chatId: canonical,
                messageId: msgId,
                content,
                media: Media.managerStatus(updatedMedia),
                timings,
            };
        } catch (error) {
            const updatedMedia = Media.get(id, message.originChatId || canonical, message.sourceMessageId);
            const statusMap = {
                AI_TIMEOUT: 504,
                WHATSAPP_MEDIA_STALE: 499,
                WHATSAPP_MEDIA_NOT_FOUND: 404,
                WHATSAPP_MEDIA_EXPIRED: 410,
                WHATSAPP_MEDIA_TOO_LARGE: 413,
                WHATSAPP_MEDIA_TOO_LONG: 422,
                WHATSAPP_MEDIA_CORRUPT: 422,
                WHATSAPP_MEDIA_TYPE_MISMATCH: 422,
                WHATSAPP_MEDIA_TYPE_UNSUPPORTED: 422,
            };
            throw Object.assign(new Error(error.code || 'WHATSAPP_MEDIA_UNAVAILABLE'), {
                code: error.code || 'WHATSAPP_MEDIA_UNAVAILABLE',
                statusCode: statusMap[error.code] || 502,
                media: Media.managerStatus(updatedMedia),
                timings: error.timings || timings,
            });
        }
    }

    async _sendMessage(instanceConfig, chatId, text) {
        const beforeSend=()=>{
            if(!this._isConnectionCurrent(instanceConfig))
                throw Object.assign(new Error('WHATSAPP_CONNECTION_CHANGED'),{code:'WHATSAPP_CONNECTION_CHANGED',safeToRetry:true});
        };
        beforeSend();
        const result = await WhatsAppGatewayService.sendMessage(
            instanceConfig,
            chatId,
            text,
            {beforeSend}
        );
        if (!result.success) {
            throw Object.assign(new Error('WHATSAPP_SEND_FAILED'), { code: result.code || 'WHATSAPP_SEND_FAILED', safeToRetry: result.safeToRetry === true });
        }
        return result.data;
    }

}

module.exports = new WhatsAppService();
