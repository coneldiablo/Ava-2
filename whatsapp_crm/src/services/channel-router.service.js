const crypto = require('crypto');
const Logger = require('../utils/logger');
const DB = require('./database.service');
const GreenApiService = require('./green-api.service');
const WhatsAppGatewayService = require('./whatsapp-gateway.service');
const Canonical = require('./client-identity.service');
const ChannelContext = require('./channel-context.service');
const Store = require('./ava-workspace.store');
const evidenceSchema = new WeakSet();
const channels = new Set(['whatsapp', 'telegram', 'email', 'vk', 'max', 'instagram', 'avito']);
function fail(code, statusCode = 409) { throw Object.assign(new Error(code), { code, statusCode, safeToRetry: true }); }

class ChannelRouterService {
    constructor() {
        this.whatsappStateCache = new Map();
    }

    async sendMessage(instanceId, chatId, text, channel = null, context = null) {
        const result = await this.sendMessageDetailed(instanceId, chatId, text, channel, context);
        return result.success;
    }

    async sendAttachmentDetailed(instanceId, chatId, attachment, caption, context) {
        if (context?.origin !== 'authenticated_customer_reply' || !Buffer.isBuffer(attachment?.buffer)
            || attachment.mimeType !== 'application/pdf' || attachment.buffer.length > 10 * 1024 * 1024
            || !attachment.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))
            || !/^[a-f0-9]{64}$/.test(attachment.sha256 || '')
            || crypto.createHash('sha256').update(attachment.buffer).digest('hex') !== attachment.sha256) {
            return {success:false,channel:'whatsapp',error:'WORKSPACE_ATTACHMENT_INVALID',safeToRetry:true};
        }
        return this.sendMessageDetailed(instanceId, chatId, caption, 'whatsapp', {...context, attachment});
    }

    _recipient(instanceId, client, channel, requestedChatId) {
        const aliases = Canonical.list(instanceId, client.chatId).aliases;
        if (channel === 'whatsapp') {
            const valid = value => typeof value === 'string' && /^[^@\s]+@(c\.us|s\.whatsapp\.net|g\.us|lid)$/.test(value);
            if (valid(requestedChatId) && Canonical.resolve(instanceId, requestedChatId) === client.chatId) return requestedChatId.replace('@s.whatsapp.net', '@c.us');
            if (valid(client.chatId)) return client.chatId.replace('@s.whatsapp.net', '@c.us');
            const linked = aliases.find(a => a.kind === 'whatsapp');
            if (linked) return linked.value;
            const phone = aliases.find(a => a.kind === 'phone')?.value || (/^\+?[1-9]\d{6,14}$/.test(client.chatId) ? client.chatId : null);
            if (phone) return phone.replace(/^\+/, '') + '@c.us';
        } else if (channel === 'telegram') {
            return String(client.telegramChatId || aliases.find(a => a.kind === 'telegram')?.value || '') || null;
        } else if (channel === 'email') return client.emailAddress || null;
        else if (channel === 'vk') return client.vkPeerId || client.vkUserId || null;
        else if (channel === 'max') return client.maxChatId ? 'chat:' + client.maxChatId : client.maxUserId ? 'user:' + client.maxUserId : null;
        else if (channel === 'instagram') return client.chatId;
        else if (channel === 'avito') return require('./avito.service').recipient(instanceId, client.chatId);
        return null;
    }

    async sendMessageDetailed(instanceId, chatId, text, channel = null, context = null) {
        let effectiveChannel = channel || 'whatsapp', ownLease = null, result = null, dispatchStarted = false;
        try {
            const id = Number(instanceId);
            if (!Number.isSafeInteger(id) || id < 1 || typeof chatId !== 'string' || !chatId) fail('BUSINESS_SCOPE_REQUIRED', 400);
            if (context?.businessId != null && Number(context.businessId) !== id) fail('BUSINESS_SCOPE_REQUIRED', 403);
            const instance = await DB.getInstance(id);
            if (!instance?.isActive) return { success: false, channel: effectiveChannel, error: 'business_inactive', safeToRetry: true };
            const client = await DB.getClient(id, chatId);
            if (!client) fail('WORKSPACE_CLIENT_NOT_FOUND', 404);
            effectiveChannel = channel || client.preferredChannel || 'whatsapp';
            if (!channels.has(effectiveChannel)) return { success: false, channel: effectiveChannel, error: 'unsupported_channel', safeToRetry: true };
            if ((chatId.startsWith('igp:') || client.chatId.startsWith('igp:')) &&
                (effectiveChannel !== 'instagram' || client.preferredChannel !== 'instagram')) {
                return { success: false, channel: 'instagram', error: 'instagram_recipient_not_inbound', safeToRetry: true };
            }
            if (effectiveChannel === 'instagram' && (context?.origin !== 'authenticated_customer_reply' || Number(context.businessId) !== id)) {
                return { success: false, channel: 'instagram', error: 'instagram_manual_reply_required', safeToRetry: true };
            }
            const recipient = this._recipient(id, client, effectiveChannel, chatId);
            if (!recipient) return { success: false, channel: effectiveChannel, error: 'channel_recipient_not_linked', safeToRetry: true };
            let snapshot = context?.channelSnapshot || ChannelContext.capture(id, client.chatId);
            let leaseId = context?.sendId || (typeof context?.beforeSend === 'function' ? snapshot.activeSendId : null);
            let checkedUpstream = false;
            const options = () => ({ origin: context?.origin, sendId: leaseId });
            const assertRecipient = () => {
                if (!DB.get('SELECT 1 FROM instances WHERE id=? AND isActive=1', [id])) fail('BUSINESS_NOT_FOUND', 404);
                const live = Store.scope(id, chatId);
                if (live.chatId !== client.chatId || this._recipient(id, live, effectiveChannel, chatId) !== recipient) fail('WORKSPACE_DIALOGUE_CHANGED');
            };
            const beforeSend = () => {
                ChannelContext.assertCanSend(id, chatId, snapshot, options());
                assertRecipient();
                const first = !checkedUpstream;
                const finish = () => {
                    assertRecipient();
                    const current = ChannelContext.capture(id, chatId);
                    // An upstream transaction may reserve its lease here. It has
                    // already validated the prepared dialogue before that write.
                    if (first && typeof context?.beforeSend === 'function' && !snapshot.activeSendId && current.activeSendId && current.activeSendStatus === 'sending' && current.mode === snapshot.mode && current.controlRevision === snapshot.controlRevision) {
                        snapshot = current;
                        leaseId = current.activeSendId;
                    } else ChannelContext.assertCanSend(id, chatId, snapshot, options());
                    if (!current.activeSendId) {
                        leaseId = 'channel-router:' + crypto.randomUUID();
                        const begin = current.mode === 'human' ? Store.beginHumanSend : Store.beginAiSend;
                        begin({ businessId: id, chatId: client.chatId, revision: current.controlRevision, sendId: leaseId });
                        ownLease = { businessId: id, chatId: client.chatId, sendId: leaseId };
                        snapshot = ChannelContext.capture(id, chatId);
                    }
                    checkedUpstream = true;
                    dispatchStarted = true;
                };
                if (first && typeof context?.beforeSend === 'function') {
                    const guard = context.beforeSend();
                    if (guard?.then) return guard.then(finish);
                }
                return finish();
            };
            const dispatch = { ...(context || {}), businessId: id, chatId: client.chatId, beforeSend };
            if (effectiveChannel === 'whatsapp') result = await this._sendWhatsAppDetailed(id, client.chatId, text, dispatch, recipient);
            else if (effectiveChannel === 'telegram') result = await this._sendTelegram(id, client, text, dispatch, recipient);
            else if (effectiveChannel === 'email') result = await this._sendEmail(id, client, text, dispatch, recipient);
            else if (effectiveChannel === 'vk') result = await this._sendVk(id, client, text, dispatch, recipient);
            else if (effectiveChannel === 'max') result = await this._sendMax(id, client, text, dispatch, recipient);
            else if (effectiveChannel === 'avito') result = await this._sendAvito(id, client, text, dispatch, recipient);
            else if (client.chatId.startsWith('igp:')) result = await require('../../instagram_private/server').reply(id, client.chatId, text, dispatch);
            else result = await require('./instagram.service').send(id, client.chatId, text, dispatch);
            if (!result?.success && !dispatchStarted && result?.unknown !== true) result = { ...result, safeToRetry: true, unknown: false };
            if (result?.success && result.provider_message_id) this._rememberAck(id, client.chatId, effectiveChannel, result.provider_message_id, dispatch, result.stored_message_id);
            return result;
        } catch (e) {
            Logger.error('[ChannelRouter] sendMessage error:', e?.code || 'channel_send_exception');
            result = { success: false, channel: effectiveChannel,
                error: /^((WORKSPACE|AUTOPILOT|SALES|BUSINESS|CAPABILITY|IDENTITY|INSTAGRAM_PRIVATE)_[A-Z_]+)$/.test(e?.code || '') ? e.code : 'channel_send_exception',
                safeToRetry: !dispatchStarted || e?.safeToRetry === true,
                unknown: dispatchStarted && e?.safeToRetry !== true };
            return result;
        } finally {
            if (ownLease) Store.endAiSend({ ...ownLease, status: result?.success ? 'sent' : result?.safeToRetry === true ? 'failed' : 'unknown' });
        }
    }

    ensureSchema() {
            if (!evidenceSchema.has(DB.db)) {
                DB.db.exec(`CREATE TABLE IF NOT EXISTS ava_channel_delivery_evidence (
                    businessId INTEGER NOT NULL, chatId TEXT NOT NULL, channel TEXT NOT NULL,
                    providerMessageId TEXT NOT NULL, idempotencyKey TEXT, storedMessageId INTEGER, createdAt TEXT NOT NULL,
                    PRIMARY KEY(businessId,chatId,channel,providerMessageId),
                    FOREIGN KEY(businessId,chatId) REFERENCES clients(instanceId,chatId) ON DELETE CASCADE
                ); CREATE INDEX IF NOT EXISTS ava_channel_delivery_key ON ava_channel_delivery_evidence(businessId,chatId,channel,idempotencyKey);`);
                evidenceSchema.add(DB.db);
            }
    }

    _rememberAck(instanceId, chatId, channel, providerId, context, storedMessageId = null) {
        if (typeof providerId !== 'string' && typeof providerId !== 'number') return;
        try {
            this.ensureSchema();
            const key = context?.actionId || context?.sendId || context?.idempotencyKey || null;
            DB.run(`INSERT INTO ava_channel_delivery_evidence VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(businessId,chatId,channel,providerMessageId) DO UPDATE SET
                storedMessageId=COALESCE(ava_channel_delivery_evidence.storedMessageId,excluded.storedMessageId)`, [Number(instanceId), chatId, channel, String(providerId), key == null ? null : String(key), storedMessageId || null, new Date().toISOString()]);
        } catch (_) { Logger.warn('[ChannelRouter] Provider ACK evidence needs reconciliation'); }
    }

    async _saveAcknowledged(instanceId, clientChatId, text, channel, result, context) {
        if (!result?.success) return { ...result, channel, safeToRetry: result?.safeToRetry === true, unknown: result?.safeToRetry !== true };
        this._rememberAck(instanceId, clientChatId, channel, result.provider_message_id, context);
        let storedMessageId = result.stored_message_id || null;
        try {
            const saved = await DB.saveMessageWithChannel(instanceId, result.origin_chat_id || clientChatId, 'Bot', text, 'assistant', channel, null, result.source_message_id || null);
            storedMessageId = saved?.id || storedMessageId;
        } catch (_) { Logger.warn('[ChannelRouter] Acknowledged message history requires repair'); }
        return { ...result, channel, stored_message_id: storedMessageId, safeToRetry: false, unknown: false };
    }

    async _sendWhatsApp(instanceId, chatId, text) {
        const result = await this.sendMessageDetailed(instanceId, chatId, text, 'whatsapp');
        return result.success;
    }

    async _sendWhatsAppDetailed(instanceId, chatId, text, context = null, recipient = chatId) {
        const instance = await DB.getInstance(instanceId);
        const { hasOpenWa, hasGreenApi } = WhatsAppGatewayService.getConfig(instance);
        if (!instance || (!hasOpenWa && !hasGreenApi)) return { success: false, channel: 'whatsapp', error: 'whatsapp_not_configured', safeToRetry: true, state: 'notConfigured' };
        const stateResult = await this._getWhatsAppState(instance);
        if (!stateResult.success) return { success: false, channel: 'whatsapp', error: 'whatsapp_state_check_failed', safeToRetry: true, state: 'error' };
        const state = stateResult.state || 'unknown';
        if (state !== 'authorized') return { success: false, channel: 'whatsapp', error: 'whatsapp_not_authorized', safeToRetry: true, state };
        if (context?.attachment) {
            const result = await require('./whatsapp-attachments.service').send(instance, recipient, context.attachment, {beforeDispatch:context.beforeSend});
            return this._saveAcknowledged(instanceId, chatId, text, 'whatsapp', {...result,
                source_message_id:'document:' + crypto.createHash('sha256').update(context.attachment.documentKey + ':' + recipient).digest('hex'),
                origin_chat_id:recipient, provider_message_id:result.provider_message_id || result.providerMessageId || null,
                error:result.success ? null : result.code || 'whatsapp_attachment_failed'}, context);
        }
        const ack = await WhatsAppGatewayService.sendMessage(instance, recipient, text, context);
        return this._saveAcknowledged(instanceId, chatId, text, 'whatsapp', {
            ...ack, state, error: ack.success ? null : ack.error || ack.code || 'whatsapp_send_failed',
            provider_message_id: ack.data?.idMessage || ack.data?.messageId || ack.data?.id || null
        }, context);
    }

    async _sendTelegram(instanceId, client, text, context, recipient) {
        const service = require('./telegram.service');
        const result = await service.sendMessageDetailed(instanceId, recipient, text, context);
        return this._saveAcknowledged(instanceId, client.chatId, text, 'telegram', result, context);
    }

    async _sendAvito(instanceId, client, text, context, recipient) {
        const result = await require('./avito.service').sendMessageDetailed(instanceId, recipient, text, context);
        return this._saveAcknowledged(instanceId, client.chatId, text, 'avito', result, context);
    }

    async _sendEmail(instanceId, client, text, context, recipient) {
        const success = await require('./email.service').sendEmail(instanceId, recipient, 'Сообщение от менеджера', text, context);
        return this._saveAcknowledged(instanceId, client.chatId, text, 'email', { success: success === true }, context);
    }

    async _sendVk(instanceId, client, text, context, recipient) {
        const success = await require('./vk.service').sendMessage(instanceId, recipient, text, context);
        return this._saveAcknowledged(instanceId, client.chatId, text, 'vk', { success: success === true }, context);
    }

    async _sendMax(instanceId, client, text, context, recipient) {
        const isChat = recipient.startsWith('chat:');
        const success = await require('./max.service').sendMessage(instanceId, isChat ? recipient.slice(5) : null, isChat ? null : recipient.slice(5), text, context);
        return this._saveAcknowledged(instanceId, client.chatId, text, 'max', { success: success === true }, context);
    }

    // Read-only: exact durable ACK or an adapter's explicit evidence capability.
    // Missing evidence cannot prove failure and never authorizes another send.
    async reconcileMessage(instanceId, chatId, evidence = {}) {
        let channel = evidence.channel || 'unknown';
        const unknown = reason => ({ status: 'unknown', channel, reason });
        try {
            const id = Number(instanceId);
            if (!Number.isSafeInteger(id) || id < 1 || typeof chatId !== 'string' || !chatId || evidence.businessId != null && Number(evidence.businessId) !== id) return unknown('scope_invalid');
            const client = await DB.getClient(id, chatId);
            if (!client) return unknown('client_not_found');
            channel = evidence.channel || client.preferredChannel || 'whatsapp';
            if (!channels.has(channel)) return unknown('unsupported_channel');
            const providerId = evidence.providerMessageId || evidence.provider_message_id;
            const key = evidence.idempotencyKey || evidence.actionId || evidence.sendId;
            const jobId = evidence.jobId;
            if ((!providerId && !key && !jobId) || [providerId, key, jobId].some(v => v != null && (!['string', 'number'].includes(typeof v) || !String(v).length || String(v).length > 300))) return unknown('message_evidence_required');
            const actionId=evidence.actionId || evidence.sendId;
            if(channel==='whatsapp'&&actionId&&DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ava_workspace_document_actions'")&&DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='whatsapp_document_deliveries'")){
                const document=DB.get(`SELECT d.providerMessageId FROM ava_workspace_document_actions r
                    JOIN ava_workspace_reply_actions a ON a.id=r.actionId AND a.businessId=r.businessId
                    JOIN whatsapp_document_deliveries d ON d.businessId=r.businessId AND d.documentKey=r.documentKey AND d.recipient=r.recipient AND d.sha256=r.sha256
                    WHERE r.actionId=? AND r.businessId=? AND a.chatId=? AND d.status='accepted' AND d.providerMessageId IS NOT NULL`,[String(actionId),id,client.chatId]);
                if(document&&(!providerId||String(providerId)===document.providerMessageId))return {status:'sent',channel,providerMessageId:document.providerMessageId,evidence:'persisted_document_provider_ack'};
            }
            if ((providerId || key) && DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ava_channel_delivery_evidence'")) {
                const clauses = ['businessId=?', 'chatId=?', 'channel=?'], params = [id, client.chatId, channel];
                if (providerId) { clauses.push('providerMessageId=?'); params.push(String(providerId)); }
                if (key) { clauses.push('idempotencyKey=?'); params.push(String(key)); }
                const rows = DB.all('SELECT providerMessageId,idempotencyKey,storedMessageId FROM ava_channel_delivery_evidence WHERE ' + clauses.join(' AND ') + ' LIMIT 2', params);
                if (rows.length === 1) return { status: 'sent', channel, providerMessageId: rows[0].providerMessageId, evidence: 'persisted_provider_ack', ...(rows[0].storedMessageId ? { storedMessageId: rows[0].storedMessageId } : {}) };
                if (rows.length > 1) return unknown('evidence_ambiguous');
            }
            if (channel === 'telegram' && DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_inbound_jobs'")) {
                const clauses = ['instanceId=?', 'chatId=?', "channel='telegram'"], params = [id, client.chatId];
                if (providerId) { clauses.push('outgoingProviderMessageId=?'); params.push(String(providerId)); }
                if (key) { clauses.push("('telegram-reply:' || COALESCE(batchKey,id))=?"); params.push(String(key)); }
                if (jobId) { clauses.push('id=?'); params.push(String(jobId)); }
                const rows = DB.all('SELECT status,outgoingProviderMessageId,storedMessageId FROM channel_inbound_jobs WHERE ' + clauses.join(' AND ') + ' LIMIT 51', params);
                const acknowledged = rows.filter(row => ['acknowledged', 'completed'].includes(row.status) && row.outgoingProviderMessageId);
                const providerIds = new Set(acknowledged.map(row => row.outgoingProviderMessageId));
                if (providerIds.size === 1) {
                    const row = acknowledged[0];
                    return { status: 'sent', channel, providerMessageId: row.outgoingProviderMessageId, evidence: 'durable_channel_job_ack', ...(row.storedMessageId ? { storedMessageId: row.storedMessageId } : {}) };
                }
                if (providerIds.size > 1) return unknown('evidence_ambiguous');
                if (rows.length && rows.every(row => ['failed', 'suppressed'].includes(row.status) && !row.outgoingProviderMessageId)) return { status: 'failed', channel, evidence: 'durable_channel_job_no_send' };
                if (rows.some(row => ['sending', 'unknown'].includes(row.status))) return unknown('provider_outcome_unknown');
            }
            const adapter = channel === 'whatsapp' ? WhatsAppGatewayService : channel === 'telegram' ? require('./telegram.service') : channel === 'email' ? require('./email.service') : channel === 'vk' ? require('./vk.service') : channel === 'max' ? require('./max.service') : channel === 'avito' ? require('./avito.service') : client.chatId.startsWith('igp:') ? require('../../instagram_private/server') : require('./instagram.service');
            if (typeof adapter.reconcileMessage !== 'function') return unknown('adapter_reconciliation_unsupported');
            const recipient = this._recipient(id, client, channel, chatId);
            if (!recipient) return unknown('channel_recipient_not_linked');
            const instance = await DB.getInstance(id);
            const result = await adapter.reconcileMessage(channel === 'whatsapp' ? instance : id, recipient, { businessId: id, chatId: client.chatId, providerMessageId: providerId ? String(providerId) : null, idempotencyKey: key ? String(key) : null });
            if (!result || !['sent', 'delivered', 'failed', 'not_sent'].includes(result.status) || providerId && String(result.providerMessageId || '') !== String(providerId) || !providerId && String(result.idempotencyKey || '') !== String(key)) return unknown('provider_evidence_unconfirmed');
            return { status: ['sent', 'delivered'].includes(result.status) ? 'sent' : 'failed', channel, providerMessageId: result.providerMessageId || null, evidence: 'provider_lookup' };
        } catch (_) { return unknown('reconciliation_unavailable'); }
    }

    getCapabilities(channel = null) {
        const common = { canonicalIdentity: true, tenantScoped: true, sharedRouterControl: true, readOnlyReconciliation: true, providerLookup: false };
        const result = Object.fromEntries([...channels].map(name => [name, { ...common,
            durableInbound: ['whatsapp', 'telegram', 'avito'].includes(name),
            sharedControl: ['whatsapp', 'telegram', 'avito'].includes(name),
            customerContext: ['whatsapp', 'telegram', 'avito'].includes(name),
            supportedAutopilot: name === 'whatsapp',
            autopilot: name === 'whatsapp',
            reconciliation: { provider: false, persistedEvidence: ['whatsapp', 'telegram', 'instagram', 'avito'].includes(name) }
        }]));
        return channel ? result[channel] || null : result;
    }

    async getPreferredChannel(instanceId, chatId) {
        const messages = await DB.all(
            'SELECT channel, COUNT(*) as cnt FROM messages WHERE instanceId = ? AND chatId = ? AND channel IS NOT NULL GROUP BY channel ORDER BY cnt DESC LIMIT 1',
            [instanceId, chatId]
        );

        if (messages && messages.length > 0) {
            const preferred = messages[0].channel;
            await DB.updateClientChannel(instanceId, chatId, preferred);
            return preferred;
        }
        return 'whatsapp';
    }

    async getChannelStatus(instanceId) {
        const instance = await DB.getInstance(instanceId);
        if (!instance) return { whatsapp: false, telegram: false, email: false, vk: false, max: false, instagram: false };
        const id = Number(instance.id);

        const TelegramService = require('./telegram.service');
        const EmailService = require('./email.service');
        const VkService = require('./vk.service');
        const MaxService = require('./max.service');
        const emailSmtpVerified = EmailService.isSmtpActive(id);
        const emailImapConfigured = Boolean(instance.emailImapHost && instance.emailImapUser && instance.emailImapPass);
        const emailImapVerified = EmailService.isImapVerified(id);
        const emailImapMailboxVerified = EmailService.isImapMailboxVerified(id);
        const emailImapPolling = EmailService.isImapActive(id);

        const { hasOpenWa, hasGreenApi } = WhatsAppGatewayService.getConfig(instance);
        const whatsappConfigured = hasOpenWa || hasGreenApi;
        let whatsappState = whatsappConfigured ? 'unknown' : 'notConfigured';
        if (whatsappConfigured) {
            const stateResult = await this._getWhatsAppState(instance);
            whatsappState = stateResult.success
                ? stateResult.state || 'unknown'
                : 'error';
        }

        const instagramStatus = require('../../instagram_private/server').status(id);
        const instagramReceiving = instagramStatus.state === 'connected' && instagramStatus.inboundConfirmed === true;

        let bnovo = false;
        let bnovoConfigured = false;
        let bnovoStatus = 'not_configured';
        let bnovoExternalHotelId = null;
        let bnovoMaskedAccount = null;
        try {
            const PmsService = require('./pms/pms.service');
            const pms = PmsService.get(id);
            if (pms) {
                bnovoConfigured = Boolean(pms.credentials_configured);
                bnovo = pms.connection_status === 'connected' || pms.connection_status === 'connected_limited';
                bnovoStatus = pms.connection_status || (bnovoConfigured ? 'not_tested' : 'not_configured');
                bnovoExternalHotelId = pms.external_hotel_id || null;
                bnovoMaskedAccount = pms.masked_account || null;
            }
        } catch (_) {}

        return {
            channelCapabilities: this.getCapabilities(),
            whatsapp: whatsappState === 'authorized',
            whatsappConfigured,
            whatsappAuthorized: whatsappState === 'authorized',
            whatsappState,
            telegram: TelegramService.isActive(id),
            telegramConfigured: Boolean(instance.telegramBotToken),
            email: emailSmtpVerified && emailImapVerified && emailImapMailboxVerified && emailImapPolling,
            emailConfigured: Boolean(instance.emailSmtpHost && instance.emailSmtpUser && instance.emailSmtpPass),
            emailSmtpVerified,
            emailImapConfigured,
            emailImapVerified,
            emailImapMailboxVerified,
            emailImapPolling,
            emailReceiving: emailImapVerified && emailImapMailboxVerified && emailImapPolling,
            vk: VkService.isActive(id),
            vkConfigured: Boolean(instance.vkGroupToken),
            max: MaxService.isActive(id),
            maxConfigured: Boolean(instance.maxBotToken),
            instagram: instagramReceiving,
            instagramConfigured: instagramStatus.configured,
            instagramState: instagramStatus.state,
            instagramInboundConfirmed: instagramStatus.inboundConfirmed === true,
            bnovo,
            bnovoConfigured,
            bnovoStatus,
            bnovoExternalHotelId,
            bnovoMaskedAccount,
            telegramBotUsername: instance.telegramBotUsername || null,
            emailAddress: instance.emailSmtpUser || null,
            vkGroupName: instance.vkGroupName || null,
            maxBotName: instance.maxBotName || null,
            maxBotUsername: instance.maxBotUsername || null
        };
    }

    async _getWhatsAppState(instance, ttlMs = 15000) {
        const cacheKey = String(instance.id || instance.openWaSessionId || instance.greenApiInstance || 'default');
        const cached = this.whatsappStateCache.get(cacheKey);
        if (cached && Date.now() - cached.checkedAt < ttlMs) {
            return {
                success: true,
                state: cached.state,
                data: { stateInstance: cached.state },
                cached: true
            };
        }

        const result = await WhatsAppGatewayService.getState(instance);
        if (result.success) {
            const state = result.effectiveState || 'unknown';
            this.whatsappStateCache.set(cacheKey, { state, checkedAt: Date.now() });
            return { ...result, state };
        }
        // Never authorize an outbound send from a stale cached state when the
        // gateway is unavailable. A session may have disconnected meanwhile.
        return result;
    }
}

module.exports = new ChannelRouterService();
