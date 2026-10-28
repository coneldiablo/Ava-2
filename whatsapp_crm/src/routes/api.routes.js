const express = require('express');
const router = express.Router();
const CustomerAccess = require('../services/identity/customer-access');
// Attach authorization after Express has resolved route params, before every
// handler (including upload middleware). New routes default to customer-denied.
for (const method of ['get','post','put','patch','delete']) {
    const register = router[method].bind(router);
    router[method] = (path, ...handlers) => register(path, CustomerAccess.forRoute(method, path), ...handlers);
}
// Customer middleware provides exact canonical assignment checks. Refresh the
// cookie after preparatory awaits, immediately before a paid/send side effect.
function reauthorizeCustomerClientAction(req) {
    if (!req.auth?.userId) return null;
    const current = require('../services/auth.service').getSession(req);
    if (!current || current.userId !== req.auth.userId) throw Object.assign(new Error('BUSINESS_ACCESS_DENIED'), {code:'BUSINESS_ACCESS_DENIED',statusCode:403});
    if (current.platformRole === 'platform_admin') return null;
    if (typeof req.reauthorizeCustomerAction !== 'function') throw Object.assign(new Error('CUSTOMER_ACTION_AUTHORIZATION_REQUIRED'), {code:'CUSTOMER_ACTION_AUTHORIZATION_REQUIRED',statusCode:403});
    return req.reauthorizeCustomerAction();
}
function customerActionDenied(res, error) {
    if (error?.statusCode !== 403) return false;
    res.status(403).json({success:false,code:error.code || 'BUSINESS_ACCESS_DENIED',error:'Недостаточно прав для этого действия.'});
    return true;
}
function reauthorizeBusinessCreation(req) {
    if (!req.auth?.userId) return;
    const current = require('../services/auth.service').getSession(req);
    if (!current || String(current.userId) !== String(req.auth.userId)) {
        throw Object.assign(new Error('BUSINESS_ACCESS_DENIED'), { code: 'BUSINESS_ACCESS_DENIED', statusCode: 403 });
    }
}

const DB = require('../services/database.service');
const AIService = require('../services/ai.service');
const WhatsAppService = require('../services/whatsapp.service');
const GreenApiService = require('../services/green-api.service');
const OpenWaService = require('../services/openwa.service');
const WhatsAppConnection = require('../services/whatsapp-connection.service');
const WhatsAppGatewayService = require('../services/whatsapp-gateway.service');
const PushService = require('../services/push.service');
const RAGService = require('../services/rag.service');
const SalesBrain = require('../services/sales-brain.service');
const AvaOutboundService = require('../services/ava-outbound.service');
const HotelProfileService = require('../services/hotel-profile.service');
const AssistantDraftService = require('../services/assistant-draft.service');
const Logger = require('../utils/logger');
const {
    VALID_STATUSES,
    BUSINESS_TYPES,
    getStatusesForBusiness,
    resolveBusinessType
} = require('../utils/constants');

const SECRET_INSTANCE_FIELDS = new Set([
    'greenApiToken',
    'openWaApiKey',
    'openRouterKey',
    'yandexGptKey',
    'amoCrmAccessToken',
    'bitrix24WebhookUrl',
    'telegramBotToken',
    'emailSmtpPass',
    'emailImapPass',
    'vkGroupToken',
    'maxBotToken',
    'yookassaSecretKey',
    'baristaBotToken',
    'baristaInviteCode'
]);

function maskSecret(value) {
    if (value === undefined || value === null || value === '') return value;
    const text = String(value);
    if (text.length <= 8) return '***';
    return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function sanitizeInstance(instance) {
    if (!instance) return instance;
    const safe = { ...instance, ...require('../services/voice-settings.service').project(instance) };
    for (const field of SECRET_INSTANCE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(safe, field)) {
            safe[field] = maskSecret(safe[field]);
        }
    }
    return safe;
}

function sanitizeInstances(instances = []) {
    return instances.map(sanitizeInstance);
}

function sendModelError(res, error, fallbackCode = 'AI_MODELS_UNAVAILABLE') {
    const statuses = { INVALID_AI_PROVIDER: 400, INVALID_AI_MODEL: 400, AI_MODEL_UNAVAILABLE: 400,
        AI_MODEL_ACCESS_REVOKED: 403, AI_MODEL_SETTINGS_CHANGED: 409,
        AI_PROVIDER_NOT_CONFIGURED: 503, AI_MODELS_TIMEOUT: 504,
        AI_MODELS_UNAUTHORIZED: 502, AI_MODELS_INVALID_RESPONSE: 502,
        AI_MODELS_UNAVAILABLE: 502, AI_MODEL_SAVE_FAILED: 500 };
    const code = Object.hasOwn(statuses, error.code) ? error.code : fallbackCode;
    Logger.warn('AI model operation failed', { code });
    return res.status(statuses[code]).json({ success: false, code, error: code });
}

function reauthorizeModelAccess(req, owner = false) {
    if (!req.auth?.userId) return; // Existing legacy operator/service authentication.
    try {
        const actor = require('../services/auth.service').getSession(req);
        if (!actor || actor.userId !== req.auth.userId || actor.platformRole !== req.auth.platformRole) {
            throw new Error('session unavailable');
        }
        require('../services/identity/identity-store').authorizeBusiness(actor,
            req.params.instanceId || req.params.id, { owner });
        req.auth = actor;
    } catch (_) {
        throw Object.assign(new Error('AI_MODEL_ACCESS_REVOKED'), { code: 'AI_MODEL_ACCESS_REVOKED' });
    }
}

function looksMaskedSecret(value) {
    if (value === undefined || value === null) return false;
    const text = String(value);
    return text === '***' || /^[^*]{1,4}\*{3}[^*]{1,4}$/.test(text);
}

async function preserveMaskedSecrets(instanceId, payload = {}) {
    const clean = { ...payload };
    const current = await DB.getInstance(instanceId);
    for (const field of SECRET_INSTANCE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(clean, field)) continue;
        const value = clean[field];
        if (value === '') continue;
        if (looksMaskedSecret(value)) {
            const maskedCurrent = maskSecret(current?.[field]);
            if (!current?.[field] || value === maskedCurrent || looksMaskedSecret(value)) {
                delete clean[field];
            }
        }
    }
    return clean;
}

// --- Health Check ---

router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});

// --- Instances (Businesses) ---

router.get('/instances', async (req, res) => {
    try {
        const instances = await DB.getInstances();
        res.json({ success: true, instances: sanitizeInstances(CustomerAccess.filterInstances(instances, req.auth)) });
    } catch (e) {
        Logger.error('GET /instances error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/instances', async (req, res) => {
    try {
        if (!req.body.name || !req.body.name.trim()) {
            return res.status(400).json({ success: false, error: 'name is required' });
        }
        if (req.body.businessType && !BUSINESS_TYPES.includes(req.body.businessType)) {
            return res.status(400).json({ success: false, error: 'invalid businessType' });
        }
        const BusinessProvisioningService = require('../services/provisioning/business-provisioning.service');
        const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotencyKey || null;
        const result = await BusinessProvisioningService.createBusiness(req.body, {
            idempotencyKey, ownerUserId: req.auth?.userId,
            beforeWrite: () => reauthorizeBusinessCreation(req),
        });
        res.json({
            success: true,
            instance: sanitizeInstance(CustomerAccess.filterInstances([result.instance], req.auth)[0]),
            provisioning: result.provisioning,
            isExisting: result.isExisting,
        });
    } catch (e) {
        Logger.error('POST /instances error:', e);
        res.status(e.statusCode || 500).json({ success: false, error: e.message, code: e.code || undefined });
    }
});

router.get('/instances/:id/provisioning', async (req, res) => {
    try {
        const BusinessProvisioningService = require('../services/provisioning/business-provisioning.service');
        const provisioning = await BusinessProvisioningService.getProvisioningStatus(req.params.id);
        if (!provisioning) {
            return res.status(404).json({ success: false, error: 'business not found' });
        }
        res.json({ success: true, provisioning });
    } catch (e) {
        Logger.error('GET /instances/:id/provisioning error:', e);
        res.status(e.statusCode || 500).json({ success: false, error: e.message });
    }
});

router.post('/instances/:id/provisioning/retry', async (req, res) => {
    try {
        const BusinessProvisioningService = require('../services/provisioning/business-provisioning.service');
        const result = await BusinessProvisioningService.retryProvisioning(req.params.id, {
            module: req.body?.module || null,
        });
        res.json({ success: true, ...result });
    } catch (e) {
        Logger.error('POST /instances/:id/provisioning/retry error:', e);
        res.status(e.statusCode || 500).json({ success: false, error: e.message });
    }
});

router.put('/instances/:id', async (req, res) => {
    try {
        const current = await DB.getInstance(req.params.id);
        if (!current) return res.status(404).json({ success: false, error: 'Instance not found' });
        const updatePayload = await preserveMaskedSecrets(req.params.id, req.body);
        const changesTextAI = ['aiProvider','geminiModel','yandexGptModelUri','yandexGptKey'].some(key => Object.hasOwn(updatePayload, key));
        const textRevision = row => JSON.stringify([row.aiProvider, row.geminiModel, row.yandexGptModelUri, row.yandexGptKey]);
        if (Object.hasOwn(updatePayload, 'aiProvider') && !['aitunnel','yandex','gemini'].includes(updatePayload.aiProvider)
            && !require('../services/voice-provider.service').VOICE_AI_PROVIDERS.has(updatePayload.aiProvider)) {
            return sendModelError(res, { code: 'INVALID_AI_PROVIDER' });
        }
        if (Object.hasOwn(updatePayload, 'geminiModel')) {
            if (!require('../services/gemini-text.service').MODELS.includes(updatePayload.geminiModel)) return sendModelError(res, { code: 'INVALID_AI_MODEL' });
        }
        if (updatePayload.aiProvider === 'gemini') {
            if (!require('../services/gemini-text.service').selectable(current)) return sendModelError(res, { code: 'AI_PROVIDER_NOT_CONFIGURED' });
            AIService._resolveProviderConfig({ ...current, ...updatePayload });
        }
        if (updatePayload.aiProvider === 'aitunnel') AIService._resolveProviderConfig({ ...current, ...updatePayload });
        const changesModel = Object.hasOwn(req.body || {}, 'yandexGptModelUri');
        let validatedKey;
        if (changesModel) {
            const selected = req.body.yandexGptModelUri;
            if (selected !== '' && !AIService.isValidModelId(selected)) {
                return sendModelError(res, { code: 'INVALID_AI_MODEL' });
            }
            // Keep existing IDs during a catalogue outage; validate only a new choice.
            const changesKey = Object.hasOwn(updatePayload, 'yandexGptKey')
                && updatePayload.yandexGptKey !== current.yandexGptKey;
            if (selected && (selected !== current.yandexGptModelUri || changesKey)) {
                const effectiveKey = changesKey ? updatePayload.yandexGptKey : current.yandexGptKey;
                validatedKey = AIService._resolveProviderConfig({ yandexGptKey: effectiveKey }).apiKey;
                const models = await AIService.getAvailableModels(effectiveKey);
                if (!models.some(model => model.id === selected)) {
                    return sendModelError(res, { code: 'AI_MODEL_UNAVAILABLE' });
                }
            }
            const latest = await DB.getInstance(req.params.id);
            reauthorizeModelAccess(req, true);
            if (!latest || latest.yandexGptKey !== current.yandexGptKey
                || (validatedKey && validatedKey !== AIService._resolveProviderConfig({ yandexGptKey:
                    Object.hasOwn(updatePayload, 'yandexGptKey') ? updatePayload.yandexGptKey : latest.yandexGptKey }).apiKey)) {
                return sendModelError(res, { code: 'AI_MODEL_SETTINGS_CHANGED' });
            }
        }
        const instance = await DB.updateInstance(req.params.id, updatePayload, {
            beforeWrite: () => {
                if (req.auth?.userId) CustomerAccess.reauthorize(req, req.params.id, 'business.manage');
                if (changesTextAI) {
                    if (updatePayload.aiProvider === 'gemini' && !require('../services/gemini-text.service').selectable(current)) throw Object.assign(new Error('AI_PROVIDER_NOT_CONFIGURED'), { code: 'AI_PROVIDER_NOT_CONFIGURED', statusCode: 503 });
                    const row = require('../services/channel-credentials').decryptInstance(DB.get('SELECT * FROM instances WHERE id=?', [req.params.id]));
                    if (!row || textRevision(row) !== textRevision(current)) throw Object.assign(new Error('AI_MODEL_SETTINGS_CHANGED'), { code: 'AI_MODEL_SETTINGS_CHANGED', statusCode: 409 });
                }
            },
        });
        if (['aiProvider','geminiModel'].some(key => ['gemini','aitunnel'].includes(req.body?.aiProvider) && Object.hasOwn(req.body, key) && instance?.[key] !== req.body[key])
            || (Object.hasOwn(req.body || {}, 'geminiModel') && instance?.geminiModel !== req.body.geminiModel)
            || (changesModel && instance?.yandexGptModelUri !== req.body.yandexGptModelUri)) {
            return sendModelError(res, { code: 'AI_MODEL_SAVE_FAILED' });
        }
        res.json({ success: true, instance: instance
            ? sanitizeInstance(CustomerAccess.filterInstances([instance], req.auth)[0]) : instance });
    } catch (e) {
        if (['aiProvider','geminiModel','yandexGptModelUri'].some(key => Object.hasOwn(req.body || {}, key))) return sendModelError(res, e, 'AI_MODEL_SAVE_FAILED');
        Logger.error('PUT /instances/:id error:', e);
        res.status(e.statusCode || 500).json({ success: false, error: e.message, code: e.code || undefined });
    }
});

router.delete('/instances/:id', async (req, res) => {
    try {
        await DB.deleteInstance(req.params.id);
        res.json({ success: true });
    } catch (e) {
        Logger.error('DELETE /instances/:id error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Hotel Profiles ---

router.get('/hotel-profiles', async (req, res) => {
    try {
        const profiles = await HotelProfileService.list();
        res.json({ success: true, profiles: CustomerAccess.filterInstances(profiles, req.auth) });
    } catch (e) {
        Logger.error('GET /hotel-profiles error:', e);
        res.status(e.statusCode || 500).json({ success: false, error: e.message });
    }
});

router.get('/hotel-profiles/:id', async (req, res) => {
    try {
        const profile = await HotelProfileService.get(req.params.id);
        if (!profile) {
            return res.status(404).json({ success: false, error: 'hotel profile not found' });
        }
        res.json({ success: true, profile });
    } catch (e) {
        Logger.error('GET /hotel-profiles/:id error:', e);
        res.status(e.statusCode || 500).json({ success: false, error: e.message });
    }
});

router.post('/hotel-profiles', async (req, res) => {
    try {
        const profile = await HotelProfileService.create(req.body || {}, {
            ownerUserId: req.auth?.userId, beforeWrite: () => reauthorizeBusinessCreation(req),
        });
        res.status(201).json({ success: true, profile });
    } catch (e) {
        Logger.error('POST /hotel-profiles error:', e);
        res.status(e.statusCode || 500).json({ success: false, error: e.message });
    }
});

router.put('/hotel-profiles/:id', async (req, res) => {
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    try {
        const profile = await HotelProfileService.update(req.params.id, req.body || {}, {
            signal: controller.signal,
            beforeWrite: () => { if (req.auth?.userId) CustomerAccess.reauthorize(req, req.params.id, 'business.manage'); },
        });
        if (res.destroyed) return;
        res.json({ success: true, profile });
    } catch (e) {
        if (res.destroyed) return;
        res.status(e.statusCode || 500).json({ success: false, error: e.code || e.message, code: e.code || undefined });
    } finally {
        res.removeListener('close', cancel);
    }
});

require('./voice-settings.routes').register(router);

// Public-page generation stores a draft; activation is a separate atomic service operation.
for (const [method, suffix, operation] of [
    ['get', '/assistant-draft', 'get'],
    ['post', '/assistant-draft', 'generate'],
    ['post', '/assistant-draft/manual', 'manual'],
    ['post', '/assistant-draft/approve', 'approve'],
]) {
    router[method](`/hotel-profiles/:id${suffix}`, async (req, res) => {
        const businessId = Number(req.params.id);
        if (!Number.isSafeInteger(businessId) || businessId < 1) {
            return res.status(400).json({ success: false, error: 'BUSINESS_SCOPE_REQUIRED',
                message: 'Укажите корректный бизнес.' });
        }
        const controller = operation === 'generate' ? new AbortController() : null;
        const cancel = () => { if (!res.writableEnded) controller?.abort(); };
        if (controller) res.once('close', cancel);
        try {
            const recheck = () => { if (req.auth?.userId) CustomerAccess.reauthorize(req, businessId, operation === 'get' ? 'business.read' : 'business.manage'); };
            recheck();
            const result = await AssistantDraftService[operation](businessId, req.body || {}, { signal: controller?.signal, beforeWrite: recheck });
            recheck();
            if (res.destroyed) return;
            if (operation === 'approve') return res.json({ success: true, businessId,
                draft: result.draft, profile: CustomerAccess.filterCustomerProfile(result.profile, req.auth) });
            return res.json({ success: true, businessId, draft: result });
        } catch (error) {
            if (res.destroyed) return;
            const expected = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 600
                && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code);
            const status = expected ? error.statusCode : 500;
            return res.status(status).json({ success: false,
                error: expected ? error.code : 'ASSISTANT_DRAFT_FAILED',
                message: expected && typeof error.publicMessage === 'string' ? error.publicMessage
                    : 'Не удалось обработать инструкции ассистента. Попробуйте ещё раз.' });
        } finally {
            if (controller) res.removeListener('close', cancel);
        }
    });
}

// --- Clients ---

router.get('/clients/:instanceId', async (req, res) => {
    try {
        const clients = await DB.getClients(req.params.instanceId);
        res.json({ success: true, clients });
    } catch (e) {
        Logger.error('GET /clients/:instanceId error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.put('/clients/:instanceId/:chatId/status', async (req, res) => {
    try {
        const { status, reason } = req.body;
        const instance = await DB.getInstance(req.params.instanceId);
        if (!instance) {
            return res.status(404).json({ success: false, error: 'Instance not found' });
        }
        const allowedStatuses = getStatusesForBusiness(instance);
        if (!status || !allowedStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                error: `Invalid status for ${resolveBusinessType(instance)}. Valid: ${allowedStatuses.join(', ')}`
            });
        }
        const authorized = reauthorizeCustomerClientAction(req);
        const destination = authorized?.row?.chatId || req.params.chatId;
        await DB.updateClientStatus(req.params.instanceId, destination, status, reason || 'Manual (Admin Panel)', 'manual');
        res.json({ success: true });
    } catch (e) {
        if (customerActionDenied(res, e)) return;
        Logger.error('PUT /clients/:instanceId/:chatId/status error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/clients/:instanceId/:chatId/status-history', async (req, res) => {
    try {
        const history = await DB.getStatusHistory(req.params.instanceId, req.params.chatId);
        res.json({ success: true, history });
    } catch (e) {
        Logger.error('GET /clients/:instanceId/:chatId/status-history error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/clients/:instanceId/:chatId/orders', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const orders = await DB.getOrdersByClient(
            req.params.instanceId,
            decodeURIComponent(req.params.chatId),
            limit
        );
        res.json({ success: true, orders });
    } catch (e) {
        Logger.error('GET /clients/:instanceId/:chatId/orders error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/clients/:instanceId/:chatId/sales-brain', async (req, res) => {
    try {
        const instanceId = parseInt(req.params.instanceId);
        const chatId = decodeURIComponent(req.params.chatId);
        const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 100));
        const [summary, timeline] = await Promise.all([
            SalesBrain.customerSummary({ instanceId, chatId }),
            SalesBrain.getTimeline({ instanceId, chatId, limit })
        ]);

        res.json({
            success: true,
            summary,
            timeline: timeline.timeline || []
        });
    } catch (e) {
        Logger.error('GET /clients/:instanceId/:chatId/sales-brain error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/clients/:instanceId/:chatId/followup-drafts', async (req, res) => {
    try {
        const instanceId = parseInt(req.params.instanceId);
        const chatId = decodeURIComponent(req.params.chatId);
        const result = await SalesBrain.listFollowupDrafts({
            instanceId,
            chatId,
            limit: Math.max(1, Math.min(parseInt(req.query.limit) || 20, 100))
        });
        res.json({ success: true, drafts: result.drafts || [] });
    } catch (e) {
        Logger.error('GET /clients/:instanceId/:chatId/followup-drafts error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/clients/:instanceId/:chatId/followup-channels', async (req, res) => {
    try { res.json({ success: true, channels: await SalesBrain.followupChannels(Number(req.params.instanceId), req.params.chatId) }); }
    catch (_) { res.status(400).json({ success: false, error: 'channels_unavailable' }); }
});
router.post('/sales-brain/followup-drafts/:draftId/claim', async (req, res) => {
    try {
    const result = SalesBrain.claimFollowupDraft({ instanceId: req.body?.instanceId,
        draftId: req.params.draftId, actor: req.auth?.userId || null });
    res.status(result.success ? 200 : result.error === 'task_assigned_to_another_manager' ? 409 : 400).json(result);
    } catch (_) { res.status(500).json({ success: false, error: 'task_claim_failed' }); }
});

router.patch('/sales-brain/followup-drafts/:draftId', async (req, res) => {
    try { res.json(await SalesBrain.editFollowupDraft({ ...req.body, draftId: req.params.draftId, actor: req.auth?.userId || null })); }
    catch (_) { res.status(400).json({ success: false, error: 'draft_edit_failed' }); }
});

router.post('/sales-brain/followup-drafts/:draftId/send', async (req, res) => {
    try {
        const result = await SalesBrain.approveWhatsAppFollowup({
            ...(req.body || {}),
            draftId: req.params.draftId,
            actor: req.auth?.userId || null,
            confirmed: true,
            phase: 'manager_approval'
        });
        res.json(result);
    } catch (e) {
        Logger.error('POST /sales-brain/followup-drafts/:draftId/send error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/clients/:instanceId/:chatId/sip-alias', async (req, res) => {
    try {
        const result = await SalesBrain.getCustomerAliases({
            instanceId: parseInt(req.params.instanceId),
            chatId: decodeURIComponent(req.params.chatId)
        });
        res.json(result);
    } catch (e) {
        Logger.error('GET /clients/:instanceId/:chatId/sip-alias error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.put('/clients/:instanceId/:chatId/sip-alias', async (req, res) => {
    try {
        const result = await SalesBrain.bindCustomerAlias({
            instanceId: parseInt(req.params.instanceId),
            chatId: decodeURIComponent(req.params.chatId),
            extension: req.body.extension || req.body.alias,
            linkType: 'sip_extension',
            replaceExisting: true,
            createdBy: 'crm_ui'
        });
        res.status(result.success ? 200 : 400).json(result);
    } catch (e) {
        Logger.error('PUT /clients/:instanceId/:chatId/sip-alias error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.delete('/clients/:instanceId/:chatId/sip-alias', async (req, res) => {
    try {
        const result = await SalesBrain.removeCustomerAlias({
            instanceId: parseInt(req.params.instanceId),
            chatId: decodeURIComponent(req.params.chatId),
            linkType: 'sip_extension'
        });
        res.json(result);
    } catch (e) {
        Logger.error('DELETE /clients/:instanceId/:chatId/sip-alias error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Sales Brain outbound campaigns (browser-authenticated management) ---

function campaignWriteScope(req, campaignId = null) {
    const DB = require('../services/database.service');
    const row = campaignId ? DB.getOutboundCampaign(campaignId) : null;
    if (campaignId && !row) throw Object.assign(new Error('TELEPHONY_CAMPAIGN_NOT_FOUND'),{statusCode:404});
    const id = Number(row?.instanceId || req.body?.instanceId || req.body?.instance_id);
    require('../services/identity/customer-access').reauthorize(req,id,'business.manage');
    const allowed = new Set([`${req.protocol}://${req.get('host')}`]);
    if(process.env.WHATSAPP_CRM_PUBLIC_URL) allowed.add(new URL(process.env.WHATSAPP_CRM_PUBLIC_URL).origin);
    if(!allowed.has(req.get('origin')) || req.get('sec-fetch-site')==='cross-site') throw Object.assign(new Error('CUSTOMER_ORIGIN_REQUIRED'),{statusCode:403});
    require('../services/telephony/campaigns').ensureSchema();
    return {id,row};
}

function campaignSafeError(res,error) {
    const code = /^(TELEPHONY_|CUSTOMER_|BUSINESS_)[A-Z_]+$/.test(error.code||error.message||'') ? error.code||error.message : 'TELEPHONY_UNAVAILABLE';
    return res.status(error.statusCode||503).json({success:false,error:code,code});
}

router.get('/sales-brain/outbound/campaigns/:instanceId', async (req, res) => {
    try {
        const result = await SalesBrain.listOutboundCampaigns({
            instanceId: parseInt(req.params.instanceId),
            includeDisabled: true
        });
        res.json({ success: true, ...result });
    } catch (e) {
        Logger.error('GET /sales-brain/outbound/campaigns error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/sales-brain/outbound/campaigns', async (req, res) => {
    try {
        const {id}=campaignWriteScope(req);
        if(req.body?.enabled || req.body?.status && req.body.status!=='draft') throw Object.assign(new Error('TELEPHONY_CAMPAIGN_STATE_CONFLICT'),{statusCode:409});
        const result = await SalesBrain.createOutboundCampaign({...req.body,instanceId:id,enabled:false,status:'draft'});
        res.json(result);
    } catch (e) {
        campaignSafeError(res,e);
    }
});

router.patch('/sales-brain/outbound/campaigns/:campaignId', async (req, res) => {
    try {
        const {row}=campaignWriteScope(req,req.params.campaignId);
        const DB=require('../services/database.service');
        if(row.status!=='draft' || req.body?.status!==undefined || req.body?.enabled!==undefined ||
            DB.get('SELECT id FROM ava_campaign_commands WHERE campaignId=?',[row.campaignId]))
            throw Object.assign(new Error('TELEPHONY_CAMPAIGN_STATE_CONFLICT'),{statusCode:409});
        const result = await SalesBrain.updateOutboundCampaign({
            ...(req.body || {}),
            campaignId: req.params.campaignId
        });
        res.json(result);
    } catch (e) {
        campaignSafeError(res,e);
    }
});

router.post('/sales-brain/outbound/campaigns/:campaignId/sync-leads', async (req, res) => {
    try {
        const {row}=campaignWriteScope(req,req.params.campaignId);
        const DB=require('../services/database.service');
        if(row.status!=='draft' || DB.get('SELECT campaignId FROM ava_campaign_drafts WHERE campaignId=?',[row.campaignId]) ||
            DB.get('SELECT id FROM ava_campaign_commands WHERE campaignId=?',[row.campaignId]))
            throw Object.assign(new Error('TELEPHONY_CAMPAIGN_STATE_CONFLICT'),{statusCode:409});
        const result = await SalesBrain.syncOutboundCampaignLeads({
            ...(req.body || {}),
            campaignId: req.params.campaignId
        });
        res.json(result);
    } catch (e) {
        campaignSafeError(res,e);
    }
});

router.get('/sales-brain/outbound/campaigns/:campaignId/leads', async (req, res) => {
    try {
        const result = await SalesBrain.listOutboundLeads({
            campaignId: req.params.campaignId,
            state: req.query.state,
            limit: req.query.limit
        });
        res.json({ success: true, ...result });
    } catch (e) {
        Logger.error('GET /sales-brain/outbound/campaigns/leads error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/sales-brain/outbound/campaigns/:campaignId/deploy-to-ava', async (req, res) => {
    try {
        const {id}=campaignWriteScope(req,req.params.campaignId);
        const result=await require('../services/telephony/campaigns').command(id,req.auth.userId,req.params.campaignId,
            {action:req.body?.start?'start':'prepare',...(req.body?.confirmAudience!==undefined?{confirmAudience:req.body.confirmAudience}:{}),...(req.body?.sourceNumberId!==undefined?{sourceNumberId:req.body.sourceNumberId}:{})},
            req.get('Idempotency-Key'),{reauthorize:()=>campaignWriteScope(req,req.params.campaignId)});
        res.status(result.success?200:202).json(result);
    } catch(e) { campaignSafeError(res,e); }
});

router.post('/sales-brain/outbound/campaigns/:campaignId/ava-status', async (req, res) => {
    try {
        const {id,row}=campaignWriteScope(req,req.params.campaignId);
        const action={running:row.status==='draft'?'start':'resume',paused:'pause',stopped:'stop'}[req.body?.status];
        const result=await require('../services/telephony/campaigns').command(id,req.auth.userId,req.params.campaignId,
            {action,...(req.body?.confirmAudience!==undefined?{confirmAudience:req.body.confirmAudience}:{})},
            req.get('Idempotency-Key'),{reauthorize:()=>campaignWriteScope(req,req.params.campaignId)});
        res.status(result.success?200:202).json(result);
    } catch(e) { campaignSafeError(res,e); }
});

router.delete('/clients/:instanceId/:chatId', async (req, res) => {
    try {
        await DB.deleteLead(req.params.instanceId, req.params.chatId);
        res.json({ success: true });
    } catch (e) {
        Logger.error('DELETE /clients/:instanceId/:chatId error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Messages for a client ---

router.get('/messages/:instanceId/:chatId', async (req, res) => {
    try {
        const instanceId = Number(req.params.instanceId);
        const messages = await DB.getMessages(instanceId, req.params.chatId);
        const Media = DB.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='whatsapp_media_inputs'")
            ? require('../services/whatsapp-media.service') : null;
        // Internal model reasoning is available to platform diagnostics, not to
        // a hotel's customer-facing conversation or its browser network tab.
        const publicMessages = messages.map(message => {
            const safe = { ...message };
            if (req.auth?.userId && req.auth.platformRole !== 'platform_admin') delete safe.aiThought;
            if (Media && message.sourceMessageId) {
                const mediaRow = Media.get(instanceId, message.originChatId || message.chatId, message.sourceMessageId);
                if (mediaRow) {
                    safe.media = {
                        ...Media.managerStatus(mediaRow),
                        messageId: message.id,
                        mediaUrl: `/api/businesses/${instanceId}/workspace/clients/${encodeURIComponent(message.chatId)}/messages/${message.id}/media`,
                    };
                }
            }
            return safe;
        });
        res.json({ success: true, messages: publicMessages });
    } catch (e) {
        Logger.error('GET /messages error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Stats ---

router.get('/stats/:instanceId', async (req, res) => {
    try {
        const stats = await DB.getStats(req.params.instanceId);
        res.json({ success: true, stats });
    } catch (e) {
        Logger.error('GET /stats/:instanceId error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Simulator state: track leadStatus across messages in-memory with limit
const simulatorState = new Map(); // instanceId -> leadStatus
const MAX_SIMULATOR_STATE_SIZE = 1000;

router.post('/simulate', async (req, res) => {
    try {
        const { message, history, instanceId } = req.body;

        // Retrieve or initialize simulator lead status for this instance
        const simKey = `${req.auth?.userId || 'operator'}:${instanceId || 'default'}`;
        let currentLeadStatus = simulatorState.get(simKey) || 'new';

        // Reset if history is empty (new conversation)
        if (!history || history.length === 0) {
            currentLeadStatus = 'new';
        }

        let context = {
            clientName: 'Тестовый Клиент',
            leadStatus: currentLeadStatus,
            systemPrompt: 'Ты полезный ассистент.',
            instanceConfig: {}
        };

        if (instanceId) {
            const instance = await DB.getInstance(instanceId);
            if (instance) {
                context = {
                    clientName: 'Тестовый Клиент',
                    leadStatus: currentLeadStatus,
                    systemPrompt: instance.systemPrompt || 'Ты полезный ассистент.',
                    yclientsLink: instance.yclientsLink,
                    salesGoal: instance.salesGoal || 'call',
                    instanceId: instance.id,
                    instanceConfig: {
                        aiProvider: instance.aiProvider,
                        geminiModel: instance.geminiModel,
                        openRouterKey: instance.openRouterKey,
                        openRouterModel: instance.openRouterModel,
                        yandexGptKey: instance.yandexGptKey,
                        yandexGptFolderId: instance.yandexGptFolderId,
                        yandexGptModelUri: instance.yandexGptModelUri,
                        aiTemperature: instance.aiTemperature,
                        aiResponseFormat: instance.aiResponseFormat,
                    }
                };

                try {
                    const rag = await RAGService.buildConversationContext(
                        instance.id,
                        `simulator:${simKey}`,
                        message,
                        { k: 5, history: Array.isArray(history) ? history : [] }
                    );
                    context.ragContext = rag.context;
                    context.ragSearched = rag.searched;

                    if (rag.context) {
                        Logger.info(`[RAG] Found simulator context (query: "${rag.query.substring(0, 50)}...")`);
                    }
                } catch (ragError) {
                    Logger.warn('[Simulator] RAG search failed:', ragError.message);
                    context.ragContext = '';
                    context.ragSearched = false;
                }
            }
        }

        const conversationHistory = Array.isArray(history) ? [...history] : [];
        const lastMessage = conversationHistory[conversationHistory.length - 1];
        if (
            message &&
            (!lastMessage || lastMessage.role !== 'user' || lastMessage.content !== message)
        ) {
            conversationHistory.push({ role: 'user', content: message });
        }

        const generated = await AIService.getResponse(conversationHistory, {
            ...context, dryRun: true, effectsDisabled: true, toolsEnabled: false, allowedTools: [],
        });
        if (req.auth?.userId) require('../services/identity/customer-access').reauthorize(req, instanceId, 'business.manage');
        // Never forward model-supplied action/tool/order payloads to callers.
        const response = { reply: typeof generated?.reply === 'string' ? generated.reply : '',
            status: VALID_STATUSES.includes(generated?.status) ? generated.status : null,
            action: 'none', thought: typeof generated?.thought === 'string' ? generated.thought : null,
            statusReasoning: typeof generated?.statusReasoning === 'string' ? generated.statusReasoning : null };

        // Track lead status changes from AI response in simulator
        if (response && typeof response === 'object' && response.status && VALID_STATUSES.includes(response.status)) {
            if (simulatorState.size >= MAX_SIMULATOR_STATE_SIZE) {
                // simple LRU: remove first key
                const firstKey = simulatorState.keys().next().value;
                simulatorState.delete(firstKey);
            }
            simulatorState.set(simKey, response.status);
        }

        res.json({ success: true, response,
            capabilities: { dryRun: true, effectsDisabled: true, toolsEnabled: false } });
    } catch (e) {
        Logger.error('POST /simulate error:', e);
        if (e.statusCode === 403) return res.status(403).json({ success: false, code: 'BUSINESS_ACCESS_DENIED' });
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Webhooks (Unified / OpenWA / GreenAPI) ---

// GET endpoint for webhook connectivity test
router.get('/webhook', (req, res) => {
    Logger.info('[WEBHOOK-TEST] GET /api/webhook called — webhook URL is reachable!');
    res.json({ success: true, message: 'Webhook endpoint is reachable', timestamp: new Date().toISOString() });
});

// GET endpoint for OpenWA test
router.get('/webhook/openwa', (req, res) => {
    res.json({ success: true, message: 'OpenWA webhook endpoint is reachable', timestamp: new Date().toISOString() });
});

// Dedicated OpenWA webhook endpoint
router.post('/webhook/openwa', async (req, res) => {
    try {
        const body = req.body || {};
        const instance = body.sessionId ? await DB.getInstanceByOpenWaSession(body.sessionId) : null;
        if (!WhatsAppConnection.verifyWebhook(req, instance)) {
            Logger.warn('[WhatsAppWebhook] OPENWA_UNAUTHORIZED');
            return res.status(401).json({ success: false, code: 'WHATSAPP_WEBHOOK_UNAUTHORIZED' });
        }
        await WhatsAppService.processOpenWaWebhook(body, instance.id);
        res.json({ success: true, source: 'openwa' });
    } catch (e) {
        Logger.error('[WhatsAppWebhook] OPENWA_FAILED', WhatsAppService._safeErrorCode(e));
        res.status(500).json({ success: false, code: 'WHATSAPP_WEBHOOK_FAILED' });
    }
});

// Dedicated GreenAPI webhook endpoint
router.post('/webhook/green-api', async (req, res) => {
    try {
        const body = req.body || {};
        const idInstance = body.instanceData?.idInstance?.toString();
        const instance = idInstance ? await DB.getInstanceByGreenApi(idInstance) : null;
        if (!instance) return res.status(404).json({ success: false, code: 'WHATSAPP_INSTANCE_NOT_FOUND' });
        if (!WhatsAppConnection.verifyGreenWebhook(req, instance)) return res.status(401).json({ success: false, code: 'WHATSAPP_WEBHOOK_UNAUTHORIZED' });
        await WhatsAppService.processWebhook(body, instance.id);
        res.json({ success: true, source: 'green_api' });
    } catch (e) {
        Logger.error('[WhatsAppWebhook] GREEN_API_FAILED', WhatsAppService._safeErrorCode(e));
        res.status(500).json({ success: false, code: 'WHATSAPP_WEBHOOK_FAILED' });
    }
});

// Unified Webhook endpoint with auto-detection
router.post('/webhook', async (req, res) => {
    try {
        const body = req.body || {};
        if (body.instanceData) {
            const idInstance = body.instanceData.idInstance?.toString();
            const instance = idInstance ? await DB.getInstanceByGreenApi(idInstance) : null;
            if (!instance) return res.status(404).json({ success: false, code: 'WHATSAPP_INSTANCE_NOT_FOUND' });
            if (!WhatsAppConnection.verifyGreenWebhook(req, instance)) return res.status(401).json({ success: false, code: 'WHATSAPP_WEBHOOK_UNAUTHORIZED' });
            await WhatsAppService.processWebhook(body, instance.id);
            return res.json({ success: true, source: 'green_api' });
        }
        if (body.sessionId || ['message.received', 'message:created', 'session.status'].includes(body.event)) {
            const instance = body.sessionId ? await DB.getInstanceByOpenWaSession(body.sessionId) : null;
            if (!WhatsAppConnection.verifyWebhook(req, instance)) {
                Logger.warn('[WhatsAppWebhook] OPENWA_UNAUTHORIZED');
                return res.status(401).json({ success: false, code: 'WHATSAPP_WEBHOOK_UNAUTHORIZED' });
            }
            await WhatsAppService.processOpenWaWebhook(body, instance.id);
            return res.json({ success: true, source: 'openwa' });
        }
        Logger.warn('[WhatsAppWebhook] UNSUPPORTED_EVENT');
        res.json({ success: true, source: 'unrecognized' });
    } catch (e) {
        Logger.error('[WhatsAppWebhook] PROCESSING_FAILED', WhatsAppService._safeErrorCode(e));
        res.status(500).json({ success: false, code: 'WHATSAPP_WEBHOOK_FAILED' });
    }
});

// =============================================
// GREEN-API Management Routes
// =============================================

/**
 * Server-side status cache to avoid GREEN-API rate limits (429).
 * Key: instanceId, Value: { data, timestamp }
 * TTL: 30 seconds — cached result is returned if fresh enough.
 * Use ?force=1 query param to bypass cache.
 */
const statusCache = new Map();
const STATUS_CACHE_TTL = 30 * 1000; // 30 seconds

/**
 * Helper: Get & validate GREEN-API credentials from DB for a given instanceId
 */
async function getGreenApiCreds(instanceId) {
    const instance = await DB.getInstance(instanceId);
    if (!instance) {
        return { error: 'Instance not found', status: 404 };
    }
    if (!instance.greenApiInstance || !instance.greenApiToken) {
        return { error: 'GREEN-API credentials not configured. Enter ID Instance and API Token first.', status: 400 };
    }
    return { instance };
}

/**
 * GET /api/green-api/status/:instanceId?force=1
 * Returns GREEN-API instance state + WhatsApp account info.
 * Uses server-side cache (30s) to avoid rate limiting.
 */
router.get('/green-api/status/:instanceId', async (req, res) => {
    try {
        const instanceId = req.params.instanceId;
        const forceRefresh = req.query.force === '1';

        // Check cache first
        const cached = statusCache.get(instanceId);
        if (!forceRefresh && cached && (Date.now() - cached.timestamp) < STATUS_CACHE_TTL) {
            return res.json({ ...cached.data, cached: true });
        }

        const creds = await getGreenApiCreds(instanceId);
        if (creds.error) return res.status(creds.status).json({ success: false, error: creds.error });

        const { instance } = creds;
        const stateResult = await GreenApiService.getStateInstance(
            instance.greenApiInstance, instance.greenApiToken, instance.greenApiUrl
        );

        let waSettings = null;
        if (stateResult.success && stateResult.data?.stateInstance === 'authorized') {
            const waResult = await GreenApiService.getWaSettings(
                instance.greenApiInstance, instance.greenApiToken, instance.greenApiUrl
            );
            if (waResult.success) waSettings = waResult.data;
        }

        const responseData = {
            success: stateResult.success,
            state: stateResult.data,
            waSettings,
            error: stateResult.error
        };

        // Store in cache only if we got a valid response
        if (stateResult.success) {
            statusCache.set(instanceId, { data: responseData, timestamp: Date.now() });
        }

        res.json(responseData);
    } catch (e) {
        Logger.error('GET /green-api/status error:', e);
        // On error, try returning stale cache if available
        const cached = statusCache.get(req.params.instanceId);
        if (cached) {
            return res.json({ ...cached.data, cached: true, stale: true });
        }
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/green-api/qr/:instanceId
 * Returns QR code (base64) for WhatsApp authorization
 */
router.get('/green-api/qr/:instanceId', async (req, res) => {
    try {
        const creds = await getGreenApiCreds(req.params.instanceId);
        if (creds.error) return res.status(creds.status).json({ success: false, error: creds.error });

        const { instance } = creds;
        const result = await GreenApiService.getQR(
            instance.greenApiInstance, instance.greenApiToken, instance.greenApiUrl
        );

        res.json({
            success: result.success,
            ...result.data,
            error: result.error
        });
    } catch (e) {
        Logger.error('GET /green-api/qr error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * POST /api/green-api/setup-webhook/:instanceId
 * Auto-configures GREEN-API to send webhooks to this server
 */
router.post('/green-api/setup-webhook/:instanceId', async (req, res) => {
    try {
        const creds = await getGreenApiCreds(req.params.instanceId);
        if (creds.error) return res.status(creds.status).json({ success: false, error: creds.error });

        const { instance } = creds;

        // Determine webhook URL from request body or auto-detect
        // We use host port detection to avoid localhost mapping to https
        const host = req.get('host');
        const resolvedProtocol = (host.includes('localhost') || host.includes('127.0.0.1')) ? 'http' : req.protocol;
        const webhookUrl = req.body.webhookUrl || `${resolvedProtocol}://${host}/api/webhook`;

        const settings = {
            webhookUrl: webhookUrl,
            webhookUrlToken: WhatsAppConnection.greenWebhookToken(instance),
            incomingWebhook: 'yes',
            outgoingWebhook: 'no',
            outgoingMessageWebhook: 'no',
            outgoingAPIMessageWebhook: 'no',
            stateWebhook: 'yes',
            deviceWebhook: 'no',
            keepOnlineStatus: 'yes',
            pollMessageWebhook: 'no',
            incomingBlockWebhook: 'no',
            incomingCallWebhook: 'no',
            editedMessageWebhook: 'no',
            deletedMessageWebhook: 'no',
            markIncomingMessagesReaded: 'yes',
            markIncomingMessagesReadedOnReply: 'yes',
            delaySendMessagesMilliseconds: 3000,
        };

        const result = await GreenApiService.setSettings(
            instance.greenApiInstance, instance.greenApiToken, instance.greenApiUrl, settings
        );

        res.json({
            success: result.success,
            webhookUrl,
            data: result.data,
            error: result.error
        });
    } catch (e) {
        Logger.error('POST /green-api/setup-webhook error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * POST /api/green-api/logout/:instanceId
 * Disconnects WhatsApp account from GREEN-API instance
 */
router.post('/green-api/logout/:instanceId', async (req, res) => {
    try {
        const creds = await getGreenApiCreds(req.params.instanceId);
        if (creds.error) return res.status(creds.status).json({ success: false, error: creds.error });

        const { instance } = creds;
        const result = await GreenApiService.logout(
            instance.greenApiInstance, instance.greenApiToken, instance.greenApiUrl
        );

        res.json({
            success: result.success,
            data: result.data,
            error: result.error
        });
    } catch (e) {
        Logger.error('POST /green-api/logout error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * POST /api/green-api/reboot/:instanceId
 * Reboots GREEN-API instance
 */
router.post('/green-api/reboot/:instanceId', async (req, res) => {
    try {
        const creds = await getGreenApiCreds(req.params.instanceId);
        if (creds.error) return res.status(creds.status).json({ success: false, error: creds.error });

        const { instance } = creds;
        const result = await GreenApiService.reboot(
            instance.greenApiInstance, instance.greenApiToken, instance.greenApiUrl
        );

        res.json({
            success: result.success,
            data: result.data,
            error: result.error
        });
    } catch (e) {
        Logger.error('POST /green-api/reboot error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// =============================================
// OpenWA & Unified Gateway Management Routes
// =============================================

const openWaStatusCache = new Map();
const OPENWA_CACHE_TTL = 15 * 1000; // 15 seconds

router.post('/openwa/connect/:instanceId', async (req, res) => {
    const result = await WhatsAppConnection.connect(req.params.instanceId);
    openWaStatusCache.delete(String(req.params.instanceId));
    res.status(result.success ? 200 : result.statusCode || 503).json(result);
});

router.post('/openwa/replace/:instanceId', async (req, res) => {
    if (req.body?.confirm !== true) return res.status(400).json({ success: false, code: 'WHATSAPP_REPLACE_CONFIRMATION_REQUIRED' });
    const result = await WhatsAppConnection.replaceConnection(req.params.instanceId, req.body.expected_session_id);
    openWaStatusCache.delete(String(req.params.instanceId));
    res.status(result.success ? 200 : result.statusCode || 503).json(result);
});

async function getOpenWaCreds(instanceId, autoAssign = false) {
    const instance = await DB.getInstance(instanceId);
    if (!instance) {
        return { error: 'Инстанс не найден', status: 404 };
    }
    if (!instance.openWaSessionId) {
        if (autoAssign) {
            const defaultSession = `ava-business-${instance.id}`;
            await DB.updateInstance(instance.id, { openWaSessionId: defaultSession });
            instance.openWaSessionId = defaultSession;
        } else {
            return { error: 'Нажмите «Подключить WhatsApp», чтобы связать телефон с бизнесом.', status: 400, notConfigured: true };
        }
    }
    return { instance };
}

/**
 * GET /api/openwa/status/:instanceId?force=1
 */
router.get('/openwa/status/:instanceId', async (req, res) => {
    try {
        const instanceId = req.params.instanceId;
        const instance = await DB.getInstance(instanceId);
        if (!instance) return res.status(404).json({ success: false, error: 'Инстанс не найден' });

        if (!instance.openWaSessionId) {
            return res.json({
                success: true,
                state: {
                    stateInstance: 'notConfigured',
                    rawStatus: 'notConfigured',
                    phone: null,
                    pushName: null
                }
            });
        }

        const forceRefresh = req.query.force === '1';
        const cached = openWaStatusCache.get(instanceId);
        if (!forceRefresh && cached && (Date.now() - cached.timestamp) < OPENWA_CACHE_TTL) {
            return res.json({ ...cached.data, cached: true });
        }

        const stateResult = await OpenWaService.getState(
            instance.openWaUrl || 'http://localhost:2785',
            instance.openWaApiKey || '',
            instance.openWaSessionId
        );

        if (!stateResult.success) {
            return res.json({
                ...WhatsAppConnection.failure(),
                state: { stateInstance: 'disconnected', rawStatus: 'disconnected' }
            });
        }

        const connectionError = WhatsAppConnection.stateFailure(stateResult.data);
        const responseData = {
            success: true,
            state: { ...stateResult.data, session: undefined, connectionErrorCode: connectionError?.code || null,
                lastError: connectionError?.error || (stateResult.data.lastError ? WhatsAppConnection.failure().error : null) }
        };

        openWaStatusCache.set(instanceId, { data: responseData, timestamp: Date.now() });
        res.json(responseData);
    } catch (e) {
        Logger.error('GET /openwa/status error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/openwa/qr/:instanceId
 */
router.get('/openwa/qr/:instanceId', async (req, res) => {
    try {
        const creds = await getOpenWaCreds(req.params.instanceId, true);
        if (creds.error) return res.status(creds.status).json({ success: false, error: creds.error });

        const { instance } = creds;
        const result = await WhatsAppConnection.getQRResult(instance);

        res.json(result);
    } catch (e) {
        Logger.error('GET /openwa/qr error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * POST /api/openwa/create-session/:instanceId
 */
router.post('/openwa/create-session/:instanceId', async (req, res) => {
    try {
        const result = await WhatsAppConnection.connect(req.params.instanceId);
        openWaStatusCache.delete(String(req.params.instanceId));
        res.json({ ...result, data: result.success ? { id: result.session_id } : undefined });
    } catch (e) {
        Logger.error('POST /openwa/create-session error:', e);
        res.status(500).json(WhatsAppConnection.failure());
    }
});

/**
 * POST /api/openwa/start/:instanceId
 */
router.post('/openwa/start/:instanceId', async (req, res) => {
    try {
        const result = await WhatsAppConnection.connect(req.params.instanceId);
        openWaStatusCache.delete(String(req.params.instanceId));
        res.json(result);
    } catch (e) {
        Logger.error('POST /openwa/start error:', e);
        res.status(500).json(WhatsAppConnection.failure());
    }
});

/**
 * POST /api/openwa/stop/:instanceId
 */
router.post('/openwa/stop/:instanceId', async (req, res) => {
    try {
        const creds = await getOpenWaCreds(req.params.instanceId);
        if (creds.error) return res.status(creds.status).json({ success: false, error: creds.error });

        const { instance } = creds;
        const result = await OpenWaService.stopSession(
            instance.openWaUrl,
            instance.openWaApiKey,
            instance.openWaSessionId
        );

        res.json(result);
    } catch (e) {
        Logger.error('POST /openwa/stop error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * POST /api/openwa/logout/:instanceId
 */
router.post('/openwa/logout/:instanceId', async (req, res) => {
    try {
        const creds = await getOpenWaCreds(req.params.instanceId);
        if (creds.error) return res.status(creds.status).json({ success: false, error: creds.error });

        const { instance } = creds;
        const result = await OpenWaService.logout(
            instance.openWaUrl,
            instance.openWaApiKey,
            instance.openWaSessionId
        );

        if (!result.success) return res.status(503).json({ success: false, error: 'WHATSAPP_DISCONNECT_UNAVAILABLE' });
        openWaStatusCache.delete(String(req.params.instanceId));
        res.json({ success: true });
    } catch (e) {
        Logger.error('POST /openwa/logout error:', e?.code || e?.name || 'unknown');
        res.status(503).json({ success: false, error: 'WHATSAPP_DISCONNECT_UNAVAILABLE' });
    }
});

/**
 * POST /api/openwa/setup-webhook/:instanceId
 */
router.post('/openwa/setup-webhook/:instanceId', async (req, res) => {
    try {
        const creds = await getOpenWaCreds(req.params.instanceId);
        if (creds.error) return res.status(creds.status).json({ success: false, error: creds.error });

        const { instance } = creds;
        const result = await WhatsAppConnection.ensureWebhook(instance);
        res.json(result);
    } catch (e) {
        Logger.error('POST /openwa/setup-webhook error:', e);
        res.status(500).json(WhatsAppConnection.failure());
    }
});

/**
 * GET /api/whatsapp-gateway/status/:instanceId
 * Returns status of both OpenWA and GreenAPI plus active gateway.
 */
router.get('/whatsapp-gateway/status/:instanceId', async (req, res) => {
    try {
        const instance = await DB.getInstance(req.params.instanceId);
        if (!instance) return res.status(404).json({ success: false, error: 'Instance not found' });

        const status = await WhatsAppGatewayService.getState(instance, req.query.force === '1');
        res.json(status);
    } catch (e) {
        Logger.error('GET /whatsapp-gateway/status error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// =============================================
// AI Features Routes (Feature 5 & 6)
// =============================================

/**
 * POST /api/ai/summary/:instanceId/:chatId
 * Returns a 3-line AI-generated summary of the conversation.
 */
router.post('/ai/summary/:instanceId/:chatId', async (req, res) => {
    try {
        const { instanceId, chatId } = req.params;
        const messages = await DB.getMessages(instanceId, decodeURIComponent(chatId));
        const instance = await DB.getInstance(instanceId);
        if (!instance) return res.status(404).json({ success: false, error: 'Instance not found' });
        if (!messages.length) return res.status(409).json({ success: false, error: 'CONVERSATION_EMPTY' });

        reauthorizeCustomerClientAction(req);
        const summary = await AIService.getSummary(messages, instance);
        reauthorizeCustomerClientAction(req);
        res.json({ success: true, summary });
    } catch (e) {
        if (customerActionDenied(res, e)) return;
        Logger.error('POST /ai/summary error:', e?.code || e?.name || 'unknown');
        res.status(503).json({ success: false, error: 'AI_SUMMARY_UNAVAILABLE' });
    }
});

/**
 * POST /api/ai/next-step/:instanceId/:chatId
 * Returns a specific recommended action for the manager.
 */
router.post('/ai/next-step/:instanceId/:chatId', async (req, res) => {
    try {
        const { instanceId, chatId } = req.params;
        const messages = await DB.getMessages(instanceId, decodeURIComponent(chatId));
        const instance = await DB.getInstance(instanceId);
        if (!instance) return res.status(404).json({ success: false, error: 'Instance not found' });
        if (!messages.length) return res.status(409).json({ success: false, error: 'CONVERSATION_EMPTY' });

        const client = await DB.getClient(instanceId, decodeURIComponent(chatId));
        const currentStatus = client ? client.leadStatus : 'new';

        reauthorizeCustomerClientAction(req);
        const nextStep = await AIService.getNextStep(messages, currentStatus, instance);
        reauthorizeCustomerClientAction(req);
        res.json({ success: true, nextStep });
    } catch (e) {
        if (customerActionDenied(res, e)) return;
        Logger.error('POST /ai/next-step error:', e?.code || e?.name || 'unknown');
        res.status(503).json({ success: false, error: 'AI_NEXT_STEP_UNAVAILABLE' });
    }
});

/**
 * GET /api/ai/models/:instanceId
 * Returns list of available AI models from the provider.
 */
router.get('/ai/providers/:instanceId', async (req, res) => {
    try {
        const instance = await DB.getInstance(req.params.instanceId);
        if (!instance) return res.status(404).json({ success: false, error: 'Instance not found' });
        reauthorizeModelAccess(req);
        res.json({ success: true, ...AIService.providerCatalog(instance) });
    } catch (error) { return sendModelError(res, error); }
});

router.get('/ai/models/:instanceId', async (req, res) => {
    try {
        const instance = await DB.getInstance(req.params.instanceId);
        if (!instance) return res.status(404).json({ success: false, error: 'Instance not found' });
        const provider = req.query.provider || AIService._normalizeProvider(instance.aiProvider);
        if (!['gemini','aitunnel'].includes(provider)) return sendModelError(res, { code: 'INVALID_AI_PROVIDER' });
        const revision = row => JSON.stringify([row.aiProvider, row.geminiModel, row.yandexGptModelUri, row.yandexGptKey]);
        const resolvedBefore = AIService._resolveProviderConfig({ ...instance, aiProvider: provider });
        const models = await AIService.getModelsForProvider(instance, provider);
        const latest = await DB.getInstance(req.params.instanceId);
        reauthorizeModelAccess(req);
        if (!latest || revision(latest) !== revision(instance)
            || resolvedBefore.apiKey !== AIService._resolveProviderConfig({ ...latest, aiProvider: provider }).apiKey
            || resolvedBefore.credentialRevision !== AIService._resolveProviderConfig({ ...latest, aiProvider: provider }).credentialRevision) return sendModelError(res, { code: 'AI_MODEL_SETTINGS_CHANGED' });
        const defaultModel = AIService.providerCatalog(instance).providers.find(item => item.id === provider).defaultModel;
        const selectedModel = provider === 'gemini' ? instance.geminiModel || defaultModel : instance.yandexGptModelUri || defaultModel;
        res.json({ success: true, provider, models, selectedModel, defaultModel });
    } catch (error) { return sendModelError(res, error); }
});

// =============================================
// ANALYTICS Routes
// =============================================

/**
 * GET /api/analytics/funnel/:instanceId
 * Returns transition counts between statuses from lead_status_history.
 * Suitable for building a Sankey/funnel diagram.
 */
router.get('/analytics/funnel/:instanceId', async (req, res) => {
    try {
        const { instanceId } = req.params;
        const transitions = await DB.getFunnelTransitions(instanceId);

        // Current pipeline counts for node sizing
        const pipeline = {};
        const statusRows = DB.all(
            "SELECT leadStatus, COUNT(*) as count FROM clients WHERE instanceId = ? GROUP BY leadStatus",
            [instanceId]
        );
        statusRows.forEach(r => { pipeline[r.leadStatus] = r.count; });

        // Calculate drop-offs between main funnel stages
        const instance = await DB.getInstance(instanceId);
        const FUNNEL_STAGES = resolveBusinessType(instance) === 'coffee_shop'
            ? ['new', 'qualified', 'audit', 'offer', 'pickup_confirmed', 'ready_for_pickup']
            : ['new', 'qualified', 'audit', 'offer', 'booked'];
        const holes = FUNNEL_STAGES.slice(0, -1).map(from => {
            const to = FUNNEL_STAGES[FUNNEL_STAGES.indexOf(from) + 1];
            const advanced = transitions.find(t => t.fromStatus === from && t.toStatus === to);
            const advancedCount = advanced ? advanced.count : 0;
            const totalFromStatus = transitions.filter(t => t.fromStatus === from).reduce((s, t) => s + t.count, 0);
            const dropRate = totalFromStatus > 0 ? Math.round(((totalFromStatus - advancedCount) / totalFromStatus) * 100) : 0;
            return { from, to, advancedCount, totalFromStatus, dropRate };
        });

        const bottleneck = holes.reduce((worst, h) => h.dropRate > (worst?.dropRate || 0) ? h : worst, null);

        res.json({ success: true, transitions, pipeline, holes, bottleneck });
    } catch (e) {
        Logger.error('GET /analytics/funnel error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/analytics/avg-time/:instanceId
 * Returns average time leads spend in each status (bottleneck detection).
 */
router.get('/analytics/avg-time/:instanceId', async (req, res) => {
    try {
        const data = await DB.getAvgTimePerStatus(req.params.instanceId);
        const stages = data.filter(d => !['junk', 'pickup_confirmed', 'ready_for_pickup', 'booked'].includes(d.status) && d.sampleCount > 0);
        const bottleneck = stages.reduce((worst, s) => s.avgHours > (worst?.avgHours || 0) ? s : worst, null);
        res.json({ success: true, data, bottleneck });
    } catch (e) {
        Logger.error('GET /analytics/avg-time error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/analytics/export/:instanceId?format=csv|xlsx&from=YYYY-MM-DD&to=YYYY-MM-DD
 * Exports all leads with status history as CSV or Excel file.
 */
router.get('/analytics/export/:instanceId', async (req, res) => {
    try {
        const { instanceId } = req.params;
        const { format = 'csv', from: dateFrom = null, to: dateTo = null } = req.query;

        // Spreadsheet applications may execute untrusted customer text as a
        // formula even in a quoted CSV field. Keep the exported value literal.
        const safeCell = (value) => {
            if (value === null || value === undefined) return '';
            if (typeof value !== 'string') return value;
            return /^[\s\u0000-\u001f]*[=+\-@]/u.test(value) ? `'${value}` : value;
        };

        const leads = await DB.getLeadsForExport(instanceId, dateFrom, dateTo);

        if (format === 'xlsx') {
            const writeExcelFile = require('write-excel-file/node');

            const leadsData = leads.map(l => ({
                'ID': l.id,
                'Имя': l.senderName,
                'Телефон/ChatId': l.chatId,
                'Статус': l.leadStatus,
                'Последнее сообщение': l.lastMessage || '',
                'Дата создания': l.createdAt,
                'Дата обновления': l.updatedAt,
            }));

            const historyData = [];
            for (const l of leads) {
                for (const h of (l.statusHistory || [])) {
                    historyData.push({
                        'Имя клиента': l.senderName,
                        'ChatId': l.chatId,
                        'Из статуса': h.fromStatus || '—',
                        'В статус': h.toStatus,
                        'Причина': h.reason || '',
                        'Кто изменил': h.changedBy,
                        'Дата': h.createdAt,
                    });
                }
            }

            const makeSheet = (name, rows) => {
                const safeRows = rows.length ? rows : [{ 'Нет данных': '' }];
                const headers = Object.keys(safeRows[0]);
                return {
                    sheet: name,
                    data: [
                        headers.map((header) => ({ value: header, fontWeight: 'bold' })),
                        ...safeRows.map((row) => headers.map((header) => safeCell(row[header]))),
                    ],
                    columns: headers.map((header) => ({
                        width: Math.min(60, Math.max(14, header.length + 2)),
                    })),
                    stickyRowsCount: 1,
                };
            };
            const buf = await writeExcelFile([
                makeSheet('Лиды', leadsData),
                makeSheet('История статусов', historyData),
            ]).toBuffer();
            const dateStr = new Date().toISOString().split('T')[0];
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="leads_${instanceId}_${dateStr}.xlsx"`);
            return res.send(buf);

        } else {
            // CSV with BOM for Excel UTF-8
            const esc = v => `"${String(safeCell(v)).replace(/"/g, '""')}"`;
            const lines = [
                ['ID', 'Имя', 'Телефон/ChatId', 'Статус', 'Последнее сообщение', 'Дата создания', 'Дата обновления', 'История статусов'].join(',')
            ];
            for (const l of leads) {
                const historyStr = (l.statusHistory || []).map(h => `${h.fromStatus || '—'}→${h.toStatus}`).join(' | ');
                lines.push([l.id, esc(l.senderName), esc(l.chatId), esc(l.leadStatus), esc(l.lastMessage), esc(l.createdAt), esc(l.updatedAt), esc(historyStr)].join(','));
            }
            const dateStr = new Date().toISOString().split('T')[0];
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="leads_${instanceId}_${dateStr}.csv"`);
            return res.send('\uFEFF' + lines.join('\n'));
        }
    } catch (e) {
        Logger.error('GET /analytics/export error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/analytics/activity-heatmap/:instanceId
 * Returns message counts grouped by day-of-week and hour for heatmap visualization
 */
router.get('/analytics/activity-heatmap/:instanceId', async (req, res) => {
    try {
        const { instanceId } = req.params;
        const rows = DB.all(`
            SELECT 
                CAST(strftime('%w', timestamp) AS INTEGER) as dayOfWeek,
                CAST(strftime('%H', timestamp) AS INTEGER) as hour,
                COUNT(*) as count
            FROM messages
            WHERE instanceId = ?
            GROUP BY dayOfWeek, hour
        `, [instanceId]);
        res.json({ success: true, heatmap: rows });
    } catch (e) {
        Logger.error('GET /analytics/activity-heatmap error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/analytics/messages-over-time/:instanceId?days=30
 * Returns daily message counts for the last N days
 */
router.get('/analytics/messages-over-time/:instanceId', async (req, res) => {
    try {
        const { instanceId } = req.params;
        const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
        const daysParam = '-' + days + ' days';
        const rows = DB.all(`
            SELECT 
                date(timestamp) as date,
                SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) as incoming,
                SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) as outgoing,
                COUNT(*) as total
            FROM messages
            WHERE instanceId = ? AND timestamp >= datetime('now', ?)
            GROUP BY date(timestamp)
            ORDER BY date ASC
        `, [instanceId, daysParam]);
        res.json({ success: true, data: rows, days });
    } catch (e) {
        Logger.error('GET /analytics/messages-over-time error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/analytics/channel-breakdown/:instanceId
 * Returns message counts grouped by channel
 */
router.get('/analytics/channel-breakdown/:instanceId', async (req, res) => {
    try {
        const { instanceId } = req.params;
        const rows = DB.all(`
            SELECT 
                COALESCE(channel, 'whatsapp') as channel,
                COUNT(*) as count
            FROM messages
            WHERE instanceId = ?
            GROUP BY channel
        `, [instanceId]);
        res.json({ success: true, channels: rows });
    } catch (e) {
        Logger.error('GET /analytics/channel-breakdown error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/analytics/response-times/:instanceId
 * Returns average bot response time (time between user message and bot reply)
 */
router.get('/analytics/response-times/:instanceId', async (req, res) => {
    try {
        const { instanceId } = req.params;
        // Get pairs of user message -> next assistant message to compute response times
        const rows = DB.all(`
            SELECT m1.chatId,
                   m1.timestamp as userTime,
                   MIN(m2.timestamp) as botTime
            FROM messages m1
            JOIN messages m2 ON m1.instanceId = m2.instanceId 
                AND m1.chatId = m2.chatId 
                AND m2.role = 'assistant'
                AND m2.timestamp > m1.timestamp
                AND m2.timestamp <= datetime(m1.timestamp, '+1 hour')
            WHERE m1.instanceId = ? AND m1.role = 'user'
                AND m1.timestamp >= datetime('now', '-30 days')
            GROUP BY m1.id
            LIMIT 1000
        `, [instanceId]);

        const times = rows.map(r => {
            const diff = (new Date(r.botTime).getTime() - new Date(r.userTime).getTime()) / 1000;
            return diff;
        }).filter(t => t > 0 && t < 3600);

        const avgSeconds = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;
        const medianSeconds = times.length > 0 ? times.sort((a, b) => a - b)[Math.floor(times.length / 2)] : 0;
        const under30s = times.filter(t => t <= 30).length;
        const under60s = times.filter(t => t <= 60).length;
        const under300s = times.filter(t => t <= 300).length;

        res.json({
            success: true,
            responseTime: {
                avgSeconds: Math.round(avgSeconds),
                medianSeconds: Math.round(medianSeconds),
                totalSamples: times.length,
                under30s, under60s, under300s,
            }
        });
    } catch (e) {
        Logger.error('GET /analytics/response-times error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/analytics/smart-summary/:instanceId
 * Returns AI-powered summary insights about the business performance
 */
router.get('/analytics/smart-summary/:instanceId', async (req, res) => {
    try {
        const { instanceId } = req.params;
        const stats = await DB.getStats(instanceId);
        const clients = await DB.getClients(instanceId);
        const triggerLog = DB.all('SELECT COUNT(*) as count FROM trigger_log WHERE instanceId = ?', [instanceId]);
        const profiles = DB.all('SELECT COUNT(*) as count FROM client_profiles WHERE instanceId = ?', [instanceId]);
        const seqActive = DB.all("SELECT COUNT(*) as count FROM client_sequences WHERE instanceId = ? AND status = 'active'", [instanceId]);

        // Lead velocity: new leads in last 7 days vs previous 7 days
        const newThisWeek = DB.all("SELECT COUNT(*) as c FROM clients WHERE instanceId = ? AND createdAt >= datetime('now', '-7 days')", [instanceId]);
        const newPrevWeek = DB.all("SELECT COUNT(*) as c FROM clients WHERE instanceId = ? AND createdAt >= datetime('now', '-14 days') AND createdAt < datetime('now', '-7 days')", [instanceId]);

        const thisWeekCount = newThisWeek[0]?.c || 0;
        const prevWeekCount = newPrevWeek[0]?.c || 0;
        const velocityChange = prevWeekCount > 0 ? Math.round(((thisWeekCount - prevWeekCount) / prevWeekCount) * 100) : (thisWeekCount > 0 ? 100 : 0);

        // Conversion rate
        const totalClients = clients.length;
        const bookedClients = clients.filter(c => ['pickup_confirmed', 'ready_for_pickup', 'booked'].includes(c.leadStatus)).length;
        const conversionRate = totalClients > 0 ? Math.round((bookedClients / totalClients) * 100) : 0;

        // Active/inactive leads
        const now = Date.now();
        const activeLeads = clients.filter(c => {
            if (['pickup_confirmed', 'ready_for_pickup', 'booked', 'junk'].includes(c.leadStatus)) return false;
            const lastMsg = c.lastMessageTime ? new Date(c.lastMessageTime).getTime() : 0;
            return (now - lastMsg) < 3 * 24 * 60 * 60 * 1000; // 3 days
        }).length;
        const staleLeads = clients.filter(c => {
            if (['pickup_confirmed', 'ready_for_pickup', 'booked', 'junk'].includes(c.leadStatus)) return false;
            const lastMsg = c.lastMessageTime ? new Date(c.lastMessageTime).getTime() : 0;
            return (now - lastMsg) >= 3 * 24 * 60 * 60 * 1000;
        }).length;

        // Messages today
        const msgsToday = stats.messagesToday || 0;

        res.json({
            success: true,
            summary: {
                totalClients,
                conversionRate,
                bookedClients,
                activeLeads,
                staleLeads,
                msgsToday,
                thisWeekLeads: thisWeekCount,
                velocityChange,
                triggersExecuted: triggerLog[0]?.count || 0,
                profilesBuilt: profiles[0]?.count || 0,
                activeSequences: seqActive[0]?.count || 0,
                statsByStatus: stats.statsByStatus || {},
            }
        });
    } catch (e) {
        Logger.error('GET /analytics/smart-summary error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/analytics/leads-over-time/:instanceId?days=30
 * Returns new leads and first successful status transitions per day.
 */
router.get('/analytics/leads-over-time/:instanceId', async (req, res) => {
    try {
        const { instanceId } = req.params;
        const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
        // Inclusive of today: days=30 means exactly 30 calendar rows, not 31.
        const daysParam = '-' + (days - 1) + ' days';
        const instance = await DB.getInstance(instanceId);
        const successStatuses = resolveBusinessType(instance || {}) === 'coffee_shop'
            ? ['pickup_confirmed', 'ready_for_pickup']
            : ['booked'];
        const statusPlaceholders = successStatuses.map(() => '?').join(', ');
        const rows = DB.all(`
            WITH RECURSIVE dates(date) AS (
                SELECT date('now', ?)
                UNION ALL
                SELECT date(date, '+1 day') FROM dates WHERE date < date('now')
            ), new_leads AS (
                SELECT date(createdAt) AS date, COUNT(*) AS count
                FROM clients
                WHERE instanceId = ? AND date(createdAt) >= date('now', ?)
                GROUP BY date(createdAt)
            ), first_success AS (
                SELECT h.chatId, MIN(h.createdAt) AS firstAt
                FROM lead_status_history h
                JOIN clients c ON c.instanceId = h.instanceId AND c.chatId = h.chatId
                WHERE h.instanceId = ? AND h.toStatus IN (${statusPlaceholders})
                  AND (h.fromStatus IS NULL OR h.fromStatus <> h.toStatus)
                GROUP BY h.chatId
            ), successes AS (
                SELECT date(firstAt) AS date, COUNT(*) AS successTransitions
                FROM first_success
                WHERE date(firstAt) >= date('now', ?)
                GROUP BY date(firstAt)
            )
            SELECT dates.date, COALESCE(new_leads.count, 0) AS count,
                   COALESCE(successes.successTransitions, 0) AS successTransitions
            FROM dates
            LEFT JOIN new_leads ON new_leads.date = dates.date
            LEFT JOIN successes ON successes.date = dates.date
            ORDER BY dates.date ASC
        `, [daysParam, instanceId, daysParam, instanceId, ...successStatuses, daysParam]);
        res.json({ success: true, data: rows });
    } catch (e) {
        Logger.error('GET /analytics/leads-over-time error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// =============================================
// Templates (Quick Replies)
// =============================================

router.get('/templates/:instanceId', async (req, res) => {
    try {
        const instanceId = Number(req.params.instanceId);
        if (!Number.isSafeInteger(instanceId) || instanceId < 1) {
            return res.status(400).json({ success: false, error: 'invalid instanceId' });
        }
        const templates = await DB.getTemplates(instanceId);
        res.json({ success: true, templates });
    } catch (e) {
        Logger.error('GET /templates error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/templates/:instanceId', async (req, res) => {
    try {
        const instanceId = Number(req.params.instanceId);
        if (!Number.isSafeInteger(instanceId) || instanceId < 1) {
            return res.status(400).json({ success: false, error: 'invalid instanceId' });
        }
        const { label, text } = req.body;
        if (typeof label !== 'string' || !label.trim() || label.trim().length > 100
            || typeof text !== 'string' || !text.trim() || text.trim().length > 5000) {
            return res.status(400).json({ success: false, error: 'label (1–100) and text (1–5000) are required' });
        }
        const template = await DB.createTemplate(instanceId, label.trim(), text.trim());
        res.json({ success: true, template });
    } catch (e) {
        Logger.error('POST /templates error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.delete('/templates/:instanceId/:templateId', async (req, res) => {
    try {
        const instanceId = Number(req.params.instanceId);
        const templateId = Number(req.params.templateId);
        if (!Number.isSafeInteger(instanceId) || instanceId < 1 || !Number.isSafeInteger(templateId) || templateId < 1) {
            return res.status(400).json({ success: false, error: 'invalid template or instance id' });
        }
        const result = await DB.deleteTemplate(instanceId, templateId);
        if (!result.changes) return res.status(404).json({ success: false, error: 'template not found' });
        res.json({ success: true });
    } catch (e) {
        Logger.error('DELETE /templates error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// =============================================
// Send Message (for Quick Replies in Kanban)
// =============================================

router.post('/clients/:instanceId/:chatId/send-message', async (req, res) => {
    let fence = null;
    let providerStarted = false;
    let authorizationError = null;
    const Workspace = require('../services/ava-workspace.store');
    const finish = status => {
        if (!fence) return;
        Workspace.endAiSend({ businessId: fence.businessId, chatId: fence.chatId, sendId: fence.sendId, status });
        fence = null;
    };
    try {
        const { instanceId, chatId } = req.params;
        const { text, channel } = req.body;
        if (typeof text !== 'string' || !text.trim() || text.length > 12000) {
            return res.status(400).json({ success: false, error: 'text is required' });
        }

        const decodedChatId = decodeURIComponent(chatId);
        const ChannelRouter = require('../services/channel-router.service');
        const client = await DB.getClient(instanceId, decodedChatId);
        const effectiveChannel = decodedChatId.startsWith('igp:') ? 'instagram'
            : channel || client?.preferredChannel || 'whatsapp';
        let context = null;
        if (effectiveChannel === 'instagram') {
            if (!req.auth?.userId || req.auth.platformRole === 'platform_admin') {
                return res.status(403).json({ success: false, code: 'CUSTOMER_ACCESS_REQUIRED' });
            }
            try {
                const Identity = require('../services/identity/identity-store');
                Identity.authorizeBusiness(req.auth, instanceId);
            } catch (_) {
                return res.status(403).json({ success: false, code: 'BUSINESS_ACCESS_DENIED' });
            }
            context = { origin: 'authenticated_customer_reply', businessId: Number(instanceId) };
        }
        const authorized = reauthorizeCustomerClientAction(req);
        const destination = authorized?.row?.chatId || require('../services/client-identity.service').resolve(Number(instanceId), decodedChatId);
        Workspace.ensureSchema();
        const control = DB.db.transaction(() => {
            reauthorizeCustomerClientAction(req);
            const current = Workspace.setControl({ businessId: Number(instanceId), chatId: destination,
                mode: 'human', reason: 'Менеджер отвечает клиенту', actorUserId: req.auth?.userId || null });
            const sendId = 'manual_legacy_' + require('crypto').randomUUID();
            Workspace.beginHumanSend({ businessId: Number(instanceId), chatId: destination, revision: current.revision, sendId });
            fence = { businessId: Number(instanceId), chatId: destination, sendId };
            return current;
        }).immediate();
        const beforeMessageId = DB.get('SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE instanceId=? AND chatId=?', [Number(instanceId), destination]).id;
        context = { ...(context || {}), origin: 'authenticated_customer_reply',
            businessId: Number(instanceId), sendId: fence.sendId, beforeSend: () => {
            try {
                const live = reauthorizeCustomerClientAction(req);
                if (live?.row && live.row.chatId !== destination) throw Object.assign(new Error('SALES_CLIENT_SCOPE_DENIED'), { code: 'SALES_CLIENT_SCOPE_DENIED', statusCode: 403 });
                const current = Workspace.getControl(Number(instanceId), destination);
                if (current.mode !== 'human' || current.revision !== control.revision) throw Object.assign(new Error('WORKSPACE_CONTROL_CONFLICT'), { code: 'WORKSPACE_CONTROL_CONFLICT', statusCode: 409 });
            } catch (error) { authorizationError = error; throw error; }
            providerStarted = true;
        }};
        if (effectiveChannel === 'instagram') {
            const result = await ChannelRouter.sendMessageDetailed(instanceId, destination, text,
                'instagram', context);
            if (authorizationError) throw authorizationError;
            if (!result.success) {
                finish(result.safeToRetry === true || /window_closed|recipient_not_inbound|request_invalid|setup_required|manual_reply_required|credential_unavailable|provider_rejected|_DISABLED|_THREAD_NOT_FOUND|_LOGIN_REQUIRED|_RATE_LIMITED|_OPERATION_IN_PROGRESS/.test(result.error || '') ? 'failed' : 'unknown');
                const code = ['instagram_reply_window_closed', 'instagram_recipient_not_inbound',
                    'instagram_request_invalid', 'instagram_external_setup_required',
                    'instagram_manual_reply_required', 'instagram_credential_unavailable',
                    'instagram_provider_rejected', 'instagram_provider_response_invalid',
                    'instagram_provider_unavailable', 'INSTAGRAM_PRIVATE_DISABLED',
                    'INSTAGRAM_PRIVATE_THREAD_NOT_FOUND', 'INSTAGRAM_PRIVATE_LOGIN_REQUIRED',
                    'INSTAGRAM_PRIVATE_RATE_LIMITED', 'INSTAGRAM_PRIVATE_OPERATION_IN_PROGRESS',
                    'INSTAGRAM_PRIVATE_SEND_RESULT_UNKNOWN', 'INSTAGRAM_PRIVATE_UNAVAILABLE'].includes(result.error)
                    ? result.error : 'instagram_send_unavailable';
                const status = code === 'instagram_request_invalid' ? 400
                    : ['instagram_reply_window_closed', 'instagram_recipient_not_inbound',
                        'INSTAGRAM_PRIVATE_THREAD_NOT_FOUND', 'INSTAGRAM_PRIVATE_OPERATION_IN_PROGRESS'].includes(code) ? 409
                        : code === 'instagram_manual_reply_required' ? 403 : 503;
                return res.status(status).json({ success: false, code });
            }
            finish('sent');
            const saved = DB.get("SELECT id FROM messages WHERE instanceId=? AND chatId=? AND role='assistant' AND content=? AND id>? ORDER BY id DESC LIMIT 1", [Number(instanceId), destination, text, beforeMessageId]);
            if (saved) try { Workspace.recordManualMessage({ businessId: Number(instanceId), chatId: destination, messageId: saved.id, userId: req.auth?.userId || null }); Workspace.ingestPromises({ businessId: Number(instanceId), chatId: destination, sourceType: 'message', sourceId: String(saved.id) }); } catch (_) { Logger.warn('[Workspace] Promise extraction requires reconciliation after acknowledged reply'); }
            return res.json({ success: true });
        }
        // Preserve the established route contract for existing channels: a
        // missing explicit channel is resolved inside ChannelRouter.
        reauthorizeCustomerClientAction(req);
        const success = await ChannelRouter.sendMessage(instanceId, destination, text,
            channel || null, context);

        if (authorizationError) throw authorizationError;
        if (!success) {
            finish(providerStarted ? 'unknown' : 'failed');
            return res.status(500).json({ success: false, error: 'Failed to send message' });
        }

        finish('sent');
        const saved = DB.get("SELECT id FROM messages WHERE instanceId=? AND chatId=? AND role='assistant' AND content=? AND id>? ORDER BY id DESC LIMIT 1", [Number(instanceId), destination, text, beforeMessageId]);
        if (saved) try { Workspace.recordManualMessage({ businessId: Number(instanceId), chatId: destination, messageId: saved.id, userId: req.auth?.userId || null }); Workspace.ingestPromises({ businessId: Number(instanceId), chatId: destination, sourceType: 'message', sourceId: String(saved.id) }); } catch (_) { Logger.warn('[Workspace] Promise extraction requires reconciliation after acknowledged reply'); }
        res.json({ success: true });
    } catch (e) {
        finish(providerStarted && !authorizationError ? 'unknown' : 'failed');
        if (e?.code?.startsWith('WORKSPACE_')) return res.status(e.statusCode || 503).json({ success: false, code: e.code });
        if (customerActionDenied(res, e)) return;
        Logger.error('POST /clients send-message error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// =============================================
// Lead Tags
// =============================================

router.put('/clients/:instanceId/:chatId/tags', async (req, res) => {
    try {
        const { tags } = req.body;
        if (!Array.isArray(tags)) {
            return res.status(400).json({ success: false, error: 'tags must be an array of strings' });
        }
        const authorized = reauthorizeCustomerClientAction(req);
        const destination = authorized?.row?.chatId || decodeURIComponent(req.params.chatId);
        await DB.updateClientTags(req.params.instanceId, destination, tags);
        res.json({ success: true });
    } catch (e) {
        if (customerActionDenied(res, e)) return;
        Logger.error('PUT /clients tags error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// =============================================
// Web Push Notifications
// =============================================

router.get('/push/vapid-public-key', (req, res) => {
    PushService.init();
    const key = PushService.getPublicKey();
    if (!key) {
        return res.status(500).json({ success: false, error: 'VAPID not initialized' });
    }
    res.json({ success: true, publicKey: key });
});

router.post('/push/subscribe', async (req, res) => {
    try {
        const { subscription, instanceId } = req.body;
        if (!subscription || !subscription.endpoint || !subscription.keys) {
            return res.status(400).json({ success: false, error: 'Invalid subscription object' });
        }
        await DB.savePushSubscription(
            subscription.endpoint,
            subscription.keys.p256dh,
            subscription.keys.auth,
            instanceId || null
        );
        res.json({ success: true });
    } catch (e) {
        Logger.error('POST /push/subscribe error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/push/unsubscribe', async (req, res) => {
    try {
        const { endpoint } = req.body;
        if (!endpoint) {
            return res.status(400).json({ success: false, error: 'endpoint required' });
        }
        await DB.deletePushSubscription(endpoint);
        res.json({ success: true });
    } catch (e) {
        Logger.error('POST /push/unsubscribe error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Test push notification (for debugging)
router.post('/push/test', async (req, res) => {
    try {
        const { instanceId } = req.body;
        await PushService.sendToAll(instanceId || null, {
            type: 'test',
            title: '🔔 Тестовое уведомление',
            body: 'Push-уведомления работают корректно!',
        });
        res.json({ success: true });
    } catch (e) {
        Logger.error('POST /push/test error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// =============================================
// PERSONALIZATION Routes
// =============================================

const PersonalizationService = require('../services/personalization.service');
const LanguageService = require('../services/language.service');
const ChannelRouterService = require('../services/channel-router.service');

router.get('/personalization/profile/:instanceId/:chatId', async (req, res) => {
    try {
        const profile = await DB.getClientProfile(req.params.instanceId, decodeURIComponent(req.params.chatId));
        res.json({ success: true, profile });
    } catch (e) {
        Logger.error('GET /personalization/profile error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/personalization/profile/:instanceId/:chatId', async (req, res) => {
    try {
        const profile = await PersonalizationService.buildClientProfile(req.params.instanceId, decodeURIComponent(req.params.chatId));
        res.json({ success: true, profile });
    } catch (e) {
        Logger.error('POST /personalization/profile error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/personalization/contact-time/:instanceId/:chatId', async (req, res) => {
    try {
        const data = await PersonalizationService.getOptimalContactTime(req.params.instanceId, decodeURIComponent(req.params.chatId));
        res.json({ success: true, data });
    } catch (e) {
        Logger.error('GET /personalization/contact-time error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/personalization/offer/:instanceId/:chatId', async (req, res) => {
    try {
        const offer = await PersonalizationService.generatePersonalizedOffer(req.params.instanceId, decodeURIComponent(req.params.chatId));
        res.json({ success: true, offer });
    } catch (e) {
        Logger.error('POST /personalization/offer error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/personalization/pricing/:instanceId/:chatId', async (req, res) => {
    try {
        const pricing = await PersonalizationService.getDynamicPricing(req.params.instanceId, decodeURIComponent(req.params.chatId));
        res.json({ success: true, pricing });
    } catch (e) {
        Logger.error('GET /personalization/pricing error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// =============================================
// SMART TRIGGERS Routes
// =============================================

const TRIGGER_TYPES = new Set(['silence', 'status_change', 'keyword', 'time_based', 'new_lead', 'sentiment']);
const TRIGGER_ACTIONS = new Set(['send_message', 'change_status', 'notify_manager', 'start_sequence', 'send_offer']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function validateTriggerPayload(instanceId, payload, existing = null) {
    const value = { conditions: {}, actionData: {}, ...existing, ...payload };
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160 ||
        !TRIGGER_TYPES.has(value.triggerType) || !TRIGGER_ACTIONS.has(value.actionType)) return 'invalid_trigger';
    for (const key of ['conditions', 'actionData']) {
        if (typeof value[key] === 'string') {
            try { value[key] = JSON.parse(value[key]); } catch (_) { return `invalid_${key}`; }
        }
        if (!isRecord(value[key]) || JSON.stringify(value[key]).length > 8192) return `invalid_${key}`;
    }
    for (const [key, max] of [['priority', 1000], ['maxExecutions', 100000], ['cooldownMinutes', 525600]]) {
        if (value[key] !== undefined && (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > max)) return `invalid_${key}`;
    }
    if (value.isActive !== undefined && value.isActive !== 0 && value.isActive !== 1 &&
        value.isActive !== true && value.isActive !== false) return 'invalid_isActive';
    const conditions = value.conditions;
    if (conditions.statuses !== undefined && (!Array.isArray(conditions.statuses) || conditions.statuses.length > 20 ||
        conditions.statuses.some(status => !VALID_STATUSES.includes(status)))) return 'invalid_statuses';
    if (value.triggerType === 'keyword' && (!Array.isArray(conditions.keywords) ||
        conditions.keywords.length === 0 || conditions.keywords.length > 20 ||
        conditions.keywords.some(keyword => typeof keyword !== 'string' || !keyword.trim() || keyword.length > 80))) return 'invalid_keywords';
    if (value.triggerType === 'silence' && conditions.silenceHours !== undefined &&
        (!Number.isFinite(conditions.silenceHours) || conditions.silenceHours < 1 || conditions.silenceHours > 8760)) return 'invalid_silence_hours';
    if (value.triggerType === 'status_change' &&
        !VALID_STATUSES.includes(conditions.targetStatus)) return 'invalid_target_status';
    if (value.triggerType === 'time_based' &&
        (!Number.isInteger(conditions.hour) || conditions.hour < 0 || conditions.hour > 23 ||
        (conditions.days !== undefined && (!Array.isArray(conditions.days) || conditions.days.length === 0 ||
            conditions.days.some(day => !Number.isInteger(day) || day < 0 || day > 6))))) return 'invalid_schedule';
    if (value.triggerType === 'sentiment' && conditions.threshold !== undefined &&
        (!Number.isFinite(conditions.threshold) || conditions.threshold <= 0 || conditions.threshold > 1)) return 'invalid_threshold';
    const action = value.actionData;
    if (value.actionType === 'send_message' &&
        (typeof action.message !== 'string' || !action.message.trim() || action.message.length > 4000)) return 'invalid_message';
    if (value.actionType === 'change_status' &&
        !VALID_STATUSES.includes(action.status)) return 'invalid_status';
    if (value.actionType === 'start_sequence') {
        if (!Number.isSafeInteger(Number(action.sequenceId))) return 'invalid_sequence_id';
        const sequence = await DB.getSequence(action.sequenceId);
        if (!sequence || Number(sequence.instanceId) !== Number(instanceId)) return 'invalid_sequence_id';
    }
    return null;
}

router.get('/triggers/:instanceId/settings', async (req, res) => {
    try {
        const instance = await DB.getInstance(req.params.instanceId);
        if (!instance) return res.status(404).json({ success: false, error: 'instance_not_found' });
        res.json({ success: true, smartTriggersEnabled: Boolean(instance.smartTriggersEnabled) });
    } catch (e) {
        Logger.error('GET /triggers/settings error:', e);
        res.status(500).json({ success: false, error: 'trigger_settings_failed' });
    }
});

router.put('/triggers/:instanceId/settings', async (req, res) => {
    try {
        if (typeof req.body?.smartTriggersEnabled !== 'boolean') {
            return res.status(400).json({ success: false, error: 'smartTriggersEnabled_boolean_required' });
        }
        const instance = await DB.getInstance(req.params.instanceId);
        if (!instance) return res.status(404).json({ success: false, error: 'instance_not_found' });
        await DB.updateInstance(req.params.instanceId, { smartTriggersEnabled: req.body.smartTriggersEnabled ? 1 : 0 });
        res.json({ success: true, smartTriggersEnabled: req.body.smartTriggersEnabled });
    } catch (e) {
        Logger.error('PUT /triggers/settings error:', e);
        res.status(500).json({ success: false, error: 'trigger_settings_failed' });
    }
});

router.get('/triggers/:instanceId', async (req, res) => {
    try {
        const triggers = await DB.getTriggers(req.params.instanceId);
        res.json({ success: true, triggers });
    } catch (e) {
        Logger.error('GET /triggers error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/triggers/:instanceId', async (req, res) => {
    try {
        const error = await validateTriggerPayload(req.params.instanceId, req.body);
        if (error) return res.status(400).json({ success: false, error });
        let trigger = await DB.createTrigger(req.params.instanceId, req.body);
        // DB.createTrigger has a legacy `value || 60` default, which would
        // silently turn an explicit zero-minute cooldown back into 60.
        if (req.body.cooldownMinutes === 0) {
            trigger = await DB.updateTrigger(trigger.id, { cooldownMinutes: 0 });
        }
        res.json({ success: true, trigger });
    } catch (e) {
        Logger.error('POST /triggers error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.put('/triggers/:instanceId/:triggerId', async (req, res) => {
    try {
        const existing = await DB.getTrigger(req.params.triggerId);
        if (!existing || Number(existing.instanceId) !== Number(req.params.instanceId)) {
            return res.status(404).json({ success: false, error: 'trigger_not_found' });
        }
        const error = await validateTriggerPayload(req.params.instanceId, req.body, existing);
        if (error) return res.status(400).json({ success: false, error });
        const trigger = await DB.updateTrigger(req.params.triggerId, req.body);
        res.json({ success: true, trigger });
    } catch (e) {
        Logger.error('PUT /triggers error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.delete('/triggers/:instanceId/:triggerId', async (req, res) => {
    try {
        const existing = await DB.getTrigger(req.params.triggerId);
        if (!existing || Number(existing.instanceId) !== Number(req.params.instanceId)) {
            return res.status(404).json({ success: false, error: 'trigger_not_found' });
        }
        await DB.deleteTrigger(req.params.triggerId);
        res.json({ success: true });
    } catch (e) {
        Logger.error('DELETE /triggers error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/triggers/:instanceId/log', async (req, res) => {
    try {
        const log = await DB.getTriggerLog(req.params.instanceId);
        res.json({ success: true, log });
    } catch (e) {
        Logger.error('GET /triggers/log error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// =============================================
// SEQUENCES Routes
// =============================================

function validateSequencePayload(payload, existing = null) {
    const value = { ...existing, ...payload };
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160) return 'invalid_sequence_name';
    if (value.description != null && (typeof value.description !== 'string' || value.description.length > 2000)) return 'invalid_description';
    if (payload.isActive !== undefined && ![0, 1, false, true].includes(payload.isActive)) return 'invalid_sequence_state';
    if (payload.targetSegment !== undefined && (!isRecord(payload.targetSegment) || JSON.stringify(payload.targetSegment).length > 4096)) return 'invalid_target_segment';
    return null;
}

function validateSequenceStepPayload(payload, existing = null) {
    const value = { ...existing, ...payload };
    if (typeof value.messageTemplate !== 'string' || !value.messageTemplate.trim() || value.messageTemplate.length > 4000) return 'invalid_message_template';
    if (value.delayMinutes !== undefined && (!Number.isInteger(value.delayMinutes) || value.delayMinutes < 1 || value.delayMinutes > 525600)) return 'invalid_delay_minutes';
    if (value.stepOrder !== undefined && (!Number.isInteger(value.stepOrder) || value.stepOrder < 1 || value.stepOrder > 10000)) return 'invalid_step_order';
    if (value.channelOverride != null && !['whatsapp', 'telegram', 'email', 'vk', 'max'].includes(value.channelOverride)) return 'invalid_channel_override';
    return null;
}

function sendSequenceStepMutationError(res, error) {
    if (error?.code !== 'sequence_has_unfinished_enrollments') return false;
    res.status(409).json({
        success: false,
        error: 'sequence_has_unfinished_enrollments',
        unfinishedEnrollmentCount: Number(error.unfinishedEnrollmentCount || 0)
    });
    return true;
}

async function sendSequenceStepConflictIfLocked(req, res) {
    const unfinishedEnrollmentCount = await DB.getSequenceUnfinishedEnrollmentCount(req.params.seqId);
    if (unfinishedEnrollmentCount < 1) return false;
    res.status(409).json({
        success: false,
        error: 'sequence_has_unfinished_enrollments',
        unfinishedEnrollmentCount
    });
    return true;
}

async function requireScopedSequence(req, res, requireStep = false) {
    const sequence = await DB.getSequence(req.params.seqId);
    if (!sequence || Number(sequence.instanceId) !== Number(req.params.instanceId)) {
        res.status(404).json({ success: false, error: 'sequence_not_found' });
        return false;
    }
    if (requireStep) {
        const step = await DB.get('SELECT id FROM sequence_steps WHERE id = ? AND sequenceId = ?',
            [req.params.stepId, sequence.id]);
        if (!step) {
            res.status(404).json({ success: false, error: 'sequence_step_not_found' });
            return false;
        }
    }
    return true;
}

router.get('/sequences/:instanceId', async (req, res) => {
    try {
        const sequences = await DB.getSequences(req.params.instanceId);
        res.json({ success: true, sequences });
    } catch (e) {
        Logger.error('GET /sequences error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/sequences/:instanceId', async (req, res) => {
    try {
        const error = validateSequencePayload(req.body);
        if (error) return res.status(400).json({ success: false, error });
        const sequence = await DB.createSequence(req.params.instanceId, req.body);
        res.json({ success: true, sequence });
    } catch (e) {
        Logger.error('POST /sequences error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.put('/sequences/:instanceId/:seqId', async (req, res) => {
    try {
        if (!await requireScopedSequence(req, res)) return;
        const error = validateSequencePayload(req.body, await DB.getSequence(req.params.seqId));
        if (error) return res.status(400).json({ success: false, error });
        const sequence = await DB.updateSequence(req.params.seqId, req.body);
        res.json({ success: true, sequence });
    } catch (e) {
        Logger.error('PUT /sequences error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.delete('/sequences/:instanceId/:seqId', async (req, res) => {
    try {
        if (!await requireScopedSequence(req, res)) return;
        await DB.deleteSequence(req.params.seqId);
        res.json({ success: true });
    } catch (e) {
        Logger.error('DELETE /sequences error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/sequences/:instanceId/:seqId/steps', async (req, res) => {
    try {
        if (!await requireScopedSequence(req, res)) return;
        const steps = await DB.getSequenceSteps(req.params.seqId);
        const unfinishedEnrollmentCount = await DB.getSequenceUnfinishedEnrollmentCount(req.params.seqId);
        res.json({ success: true, steps, unfinishedEnrollmentCount });
    } catch (e) {
        Logger.error('GET /sequences/steps error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/sequences/:instanceId/:seqId/steps', async (req, res) => {
    try {
        if (!await requireScopedSequence(req, res)) return;
        if (await sendSequenceStepConflictIfLocked(req, res)) return;
        const error = validateSequenceStepPayload(req.body);
        if (error) return res.status(400).json({ success: false, error });
        const step = await DB.addSequenceStep(req.params.seqId, req.body);
        res.json({ success: true, step });
    } catch (e) {
        if (sendSequenceStepMutationError(res, e)) return;
        Logger.error('POST /sequences/steps error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.put('/sequences/:instanceId/:seqId/steps/:stepId', async (req, res) => {
    try {
        if (!await requireScopedSequence(req, res, true)) return;
        if (await sendSequenceStepConflictIfLocked(req, res)) return;
        const existing = await DB.get('SELECT * FROM sequence_steps WHERE id = ?', [req.params.stepId]);
        const error = validateSequenceStepPayload(req.body, existing);
        if (error) return res.status(400).json({ success: false, error });
        const step = await DB.updateSequenceStep(req.params.stepId, req.body);
        res.json({ success: true, step });
    } catch (e) {
        if (sendSequenceStepMutationError(res, e)) return;
        Logger.error('PUT /sequences/steps error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.delete('/sequences/:instanceId/:seqId/steps/:stepId', async (req, res) => {
    try {
        if (!await requireScopedSequence(req, res, true)) return;
        if (await sendSequenceStepConflictIfLocked(req, res)) return;
        await DB.deleteSequenceStep(req.params.stepId);
        res.json({ success: true });
    } catch (e) {
        if (sendSequenceStepMutationError(res, e)) return;
        Logger.error('DELETE /sequences/steps error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/sequences/:instanceId/:seqId/assign/:chatId', async (req, res) => {
    try {
        if (!await requireScopedSequence(req, res)) return;
        if (!await DB.getClient(req.params.instanceId, decodeURIComponent(req.params.chatId))) {
            return res.status(404).json({ success: false, error: 'client_not_found' });
        }
        const result = await DB.assignClientToSequence(req.params.instanceId, decodeURIComponent(req.params.chatId), parseInt(req.params.seqId));
        res.json({ success: true, clientSequence: result });
    } catch (e) {
        if (e?.code === 'sequence_disabled') return res.status(409).json({ success: false, error: e.code });
        Logger.error('POST /sequences/assign error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/sequences/:instanceId/:seqId/bulk-assign', async (req, res) => {
    try {
        if (!await requireScopedSequence(req, res)) return;
        const { chatIds } = req.body;
        if (!Array.isArray(chatIds)) return res.status(400).json({ success: false, error: 'chatIds array required' });
        if (chatIds.length > 500 || !chatIds.every(id => typeof id === 'string' && id.length <= 255)) {
            return res.status(400).json({ success: false, error: 'invalid_chat_ids' });
        }
        const results = [];
        for (const chatId of chatIds) {
            if (!await DB.getClient(req.params.instanceId, chatId)) {
                return res.status(404).json({ success: false, error: 'client_not_found' });
            }
        }
        for (const chatId of chatIds) {
            const r = await DB.assignClientToSequence(req.params.instanceId, chatId, parseInt(req.params.seqId));
            results.push(r);
        }
        res.json({ success: true, count: results.length });
    } catch (e) {
        if (e?.code === 'sequence_disabled') return res.status(409).json({ success: false, error: e.code });
        Logger.error('POST /sequences/bulk-assign error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// =============================================
// CHANNELS Routes
// =============================================

// Saves only the connector settings already supported by the backend. Tokens
// are write-only here; the caller must pass an unchanged masked value or omit
// a secret to keep it. Authorization (owner + same-origin) is enforced by
// CustomerAccess.forRoute before this handler.
const CHANNEL_CONFIG_FIELDS = new Set([
    'telegramBotToken', 'emailSmtpHost', 'emailSmtpPort', 'emailSmtpUser', 'emailSmtpPass',
    'emailImapHost', 'emailImapPort', 'emailImapUser', 'emailImapPass', 'emailFromName',
    'vkGroupToken', 'vkGroupId', 'maxBotToken'
]);
const CHANNEL_PORT_FIELDS = new Set(['emailSmtpPort', 'emailImapPort']);

router.put('/channels/:instanceId/config', async (req, res) => {
    try {
        const instance = await DB.getInstance(req.params.instanceId);
        if (!instance) return res.status(404).json({ success: false, error: 'instance_not_found' });
        const body = req.body || {};
        const keys = Object.keys(body);
        if (keys.length === 0 || keys.some(key => !CHANNEL_CONFIG_FIELDS.has(key))) {
            return res.status(400).json({ success: false, error: 'invalid_channel_config_fields' });
        }
        const update = {};
        for (const key of keys) {
            const value = body[key];
            if (typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) {
                return res.status(400).json({ success: false, error: 'invalid_channel_config_value' });
            }
            if (CHANNEL_PORT_FIELDS.has(key) && value !== '' &&
                (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) {
                return res.status(400).json({ success: false, error: 'invalid_channel_port' });
            }
            if (SECRET_INSTANCE_FIELDS.has(key) && looksMaskedSecret(value)) continue;
            update[key] = value.trim();
        }
        // Validate replacement credentials before writing them. Otherwise the
        // follow-up test/restart could stop a working poller for a bad token.
        const candidate = { ...instance, ...update };
        const replacements = [
            {
                changed: update.telegramBotToken && update.telegramBotToken !== instance.telegramBotToken,
                existing: instance.telegramBotToken,
                service: () => require('../services/telegram.service'),
            },
            {
                changed: (update.vkGroupToken && update.vkGroupToken !== instance.vkGroupToken) ||
                    (update.vkGroupId && update.vkGroupId !== instance.vkGroupId),
                existing: instance.vkGroupToken,
                service: () => require('../services/vk.service'),
            },
            {
                changed: update.maxBotToken && update.maxBotToken !== instance.maxBotToken,
                existing: instance.maxBotToken,
                service: () => require('../services/max.service'),
            },
        ];
        for (const replacement of replacements) {
            if (replacement.existing && replacement.changed &&
                !await replacement.service().validateCredentials(candidate)) {
                return res.status(400).json({ success: false, error: 'channel_credentials_invalid' });
            }
        }
        if (Object.keys(update).length > 0) await DB.updateInstance(req.params.instanceId, update);
        res.json({ success: true, savedFields: Object.keys(update) });
    } catch (e) {
        Logger.error('PUT /channels/config error:', e?.code || e?.name || 'unknown');
        res.status(500).json({ success: false, error: 'channel_config_failed' });
    }
});

const CHANNEL_DISCONNECT_FIELDS = Object.freeze({
    telegram: ['telegramBotToken', 'telegramBotUsername'],
    email: ['emailSmtpHost', 'emailSmtpPort', 'emailSmtpUser', 'emailSmtpPass',
        'emailImapHost', 'emailImapPort', 'emailImapUser', 'emailImapPass', 'emailFromName'],
    vk: ['vkGroupToken', 'vkGroupId', 'vkGroupName'],
    max: ['maxBotToken', 'maxBotName', 'maxBotUsername'],
});

router.delete('/channels/:instanceId/:channel', async (req, res) => {
    try {
        const channel = req.params.channel;
        const fields = CHANNEL_DISCONNECT_FIELDS[channel];
        if (!fields) return res.status(400).json({ success: false, error: 'unsupported_channel' });
        const instance = await DB.getInstance(req.params.instanceId);
        if (!instance) return res.status(404).json({ success: false, error: 'instance_not_found' });
        await DB.updateInstance(instance.id, Object.fromEntries(fields.map(field => [field, ''])));
        if (channel === 'telegram') await require('../services/telegram.service')._stopBot(instance.id);
        if (channel === 'email') require('../services/email.service').stopInstance(instance.id);
        if (channel === 'vk') await require('../services/vk.service')._stopBot(instance.id);
        if (channel === 'max') await require('../services/max.service')._stopPolling(instance.id);
        res.json({ success: true, channel });
    } catch (e) {
        Logger.error('DELETE /channels error:', e?.code || e?.name || 'unknown');
        res.status(500).json({ success: false, error: 'channel_disconnect_failed' });
    }
});

router.get('/channels/:instanceId/status', async (req, res) => {
    try {
        const status = await ChannelRouterService.getChannelStatus(req.params.instanceId);
        res.json({ success: true, channels: status });
    } catch (e) {
        Logger.error('GET /channels/status error:', e?.code || e?.name || 'unknown');
        res.status(500).json({ success: false, error: 'channel_status_failed' });
    }
});

router.post('/channels/:instanceId/telegram/test', async (req, res) => {
    try {
        const TelegramService = require('../services/telegram.service');
        const restarted = await TelegramService.restartBot(parseInt(req.params.instanceId));
        res.json({ success: restarted });
    } catch (e) {
        Logger.error('POST /channels/telegram/test error:', e?.code || e?.name || 'unknown');
        res.status(500).json({ success: false, error: 'telegram_connection_failed' });
    }
});

router.post('/channels/:instanceId/email/test', async (req, res) => {
    try {
        const EmailService = require('../services/email.service');
        const result = await EmailService.restartInstance(parseInt(req.params.instanceId));
        res.json(result);
    } catch (e) {
        Logger.error('POST /channels/email/test error:', e?.code || e?.name || 'unknown');
        res.status(500).json({ success: false, error: 'Проверка почты не удалась' });
    }
});

router.post('/channels/:instanceId/vk/test', async (req, res) => {
    try {
        const VkService = require('../services/vk.service');
        const restarted = await VkService.restartBot(parseInt(req.params.instanceId));
        res.json({ success: restarted });
    } catch (e) {
        Logger.error('POST /channels/vk/test error:', e?.code || e?.name || 'unknown');
        res.status(500).json({ success: false, error: 'vk_connection_failed' });
    }
});

router.post('/channels/:instanceId/max/test', async (req, res) => {
    try {
        const MaxService = require('../services/max.service');
        const restarted = await MaxService.restartBot(parseInt(req.params.instanceId));
        res.json({ success: restarted });
    } catch (e) {
        Logger.error('POST /channels/max/test error:', e?.code || e?.name || 'unknown');
        res.status(500).json({ success: false, error: 'max_connection_failed' });
    }
});

// =============================================
// LANGUAGE Routes
// =============================================

router.post('/language/detect', (req, res) => {
    try {
        const { text } = req.body;
        const language = LanguageService.detectLanguage(text || '');
        const name = LanguageService.getLanguageName(language);
        res.json({ success: true, language, name });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/language/translate', async (req, res) => {
    try {
        const { text, from, to, instanceId } = req.body;
        let instanceConfig = {};
        if (instanceId) {
            instanceConfig = await DB.getInstance(instanceId) || {};
        }
        const translated = await LanguageService.translateMessage(text, from, to, instanceConfig);
        res.json({ success: true, translated });
    } catch (e) {
        Logger.error('POST /language/translate error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// =============================================
// KNOWLEDGE BASE (RAG) Routes
// =============================================

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const knowledgeBaseUpload = require('../services/knowledge-upload.service');
const DocumentQueue = require('../queues/document-queue');

// GET /api/knowledge-base/:instanceId - List all uploaded files
router.get('/knowledge-base/:instanceId', async (req, res) => {
    try {
        const instanceId = parseInt(req.params.instanceId);
        if (isNaN(instanceId)) {
            return res.status(400).json({ success: false, error: 'Invalid instanceId' });
        }
        
        const files = await DB.getKnowledgeBaseFiles(instanceId);
        const stats = await RAGService.getStats(instanceId);
        
        res.json({ 
            success: true, 
            files,
            stats
        });
    } catch (e) {
        Logger.error('GET /knowledge-base error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/knowledge-base/:instanceId/upload - Upload document
router.post('/knowledge-base/:instanceId/upload', knowledgeBaseUpload, async (req, res) => {
    try {
        const instanceId = parseInt(req.params.instanceId);
        if (isNaN(instanceId)) {
            return res.status(400).json({ success: false, error: 'Invalid instanceId' });
        }

        const files = [
            ...(Array.isArray(req.files) ? req.files : []),
            ...((req.files && req.files.files) || []),
            ...((req.files && req.files.file) || []),
            ...(req.file ? [req.file] : [])
        ];
        if (files.length === 0) {
            return res.status(400).json({ success: false, error: 'Файлы не загружены' });
        }

        const allowedTypes = [
            'application/pdf',
            'text/plain',
            'text/csv',
            'text/markdown',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'image/png',
            'image/jpeg',
            'image/jpg'
        ];

        const results = [];
        for (const file of files) {
            if (!allowedTypes.includes(file.mimetype)) {
                results.push({ originalName: file.originalname, success: false, error: `Unsupported format: ${file.mimetype}` });
                continue;
            }

            if (DocumentQueue.isAvailable()) {
                const jobId = await DocumentQueue.addDocumentJob(instanceId, file.buffer, file.originalname, file.mimetype);
                if (jobId) {
                    results.push({ originalName: file.originalname, success: true, jobId, queued: true });
                    continue;
                }
            }

            const startTime = Date.now();
            const result = await RAGService.processDocument(
                instanceId,
                file.buffer,
                file.originalname,
                file.mimetype
            );
            const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

            results.push({
                originalName: file.originalname,
                ...result,
                processingTime: result.success ? `${processingTime}s` : undefined
            });
        }

        const hasSuccess = results.some(r => r.success);
        const hasFailure = results.some(r => !r.success);

        if (hasSuccess && !hasFailure) {
            res.json({ success: true, results });
        } else if (hasSuccess && hasFailure) {
            res.json({ success: true, results, partial: true });
        } else {
            const statusCode = results[0]?.isDuplicate ? 409 : 400;
            res.status(statusCode).json({ success: false, results });
        }
    } catch (e) {
        Logger.error('POST /knowledge-base/upload error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/knowledge-base/:instanceId/upload-status/:jobId - Check upload job status
router.get('/knowledge-base/:instanceId/upload-status/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const instanceId = parseInt(req.params.instanceId);
        if (isNaN(instanceId)) {
            return res.status(400).json({ success: false, error: 'Invalid instanceId' });
        }
        const status = await DocumentQueue.getJobStatus(instanceId, jobId);
        if (!status) {
            return res.status(404).json({ success: false, error: 'Job not found' });
        }
        res.json({ success: true, ...status });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE /api/knowledge-base/:instanceId/:fileId - Delete document
router.delete('/knowledge-base/:instanceId/:fileId', async (req, res) => {
    try {
        const fileId = parseInt(req.params.fileId);
        const instanceId = parseInt(req.params.instanceId);
        
        if (isNaN(fileId) || isNaN(instanceId)) {
            return res.status(400).json({ success: false, error: 'Invalid fileId or instanceId' });
        }
        
        const result = require('../services/customer-native-knowledge.service').remove(instanceId, fileId);
        res.json({ success: true, message: 'Document and all chunks deleted', ...result });
    } catch (e) {
        const code = ['DOCUMENT_NOT_FOUND', 'ONYX_NOT_CONFIGURED', 'DOCUMENT_SYNC_IN_PROGRESS'].includes(e?.code)
            ? e.code : 'KNOWLEDGE_UNAVAILABLE';
        res.status(e.statusCode || 503).json({ success: false, code });
    }
});

// POST /api/knowledge-base/:instanceId/search - Search knowledge base
router.post('/knowledge-base/:instanceId/search', async (req, res) => {
    try {
        const instanceId = parseInt(req.params.instanceId);
        if (isNaN(instanceId)) {
            return res.status(400).json({ success: false, error: 'Invalid instanceId' });
        }
        
        const { query, searchType = 'hybrid', k = 5 } = req.body;
        
        if (!query) {
            return res.status(400).json({ success: false, error: 'query is required' });
        }
        
        const searchResult = await RAGService.runSearchPipeline(instanceId, query, {
            searchType,
            k
        });
        const results = searchResult.effectiveResults;
        
        res.json({ 
            success: true, 
            query,
            searchType: searchResult.searchType,
            responseTimeMs: searchResult.responseTimeMs,
            resultsCount: results.length,
            results: results.map(r => ({
                id: r.id,
                text: r.text,
                section: r.section,
                originalName: r.originalName,
                score: r.combinedScore || r.score,
                keywordScore: r.keywordScore,
                vectorScore: r.vectorScore,
                searchType: r.searchType,
                reranked: r.reranked || false
            }))
        });
    } catch (e) {
        Logger.error('POST /knowledge-base/search error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/knowledge-base/:instanceId/rebuild-embeddings - Rebuild missing embeddings
router.post('/knowledge-base/:instanceId/rebuild-embeddings', async (req, res) => {
    try {
        const instanceId = parseInt(req.params.instanceId);
        if (isNaN(instanceId)) {
            return res.status(400).json({ success: false, error: 'Invalid instanceId' });
        }
        
        const result = await RAGService.rebuildEmbeddings(instanceId);
        res.json(result);
    } catch (e) {
        Logger.error('POST /knowledge-base/rebuild-embeddings error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/knowledge-base/:instanceId/stats - Get RAG statistics
router.get('/knowledge-base/:instanceId/stats', async (req, res) => {
    try {
        const instanceId = parseInt(req.params.instanceId);
        if (isNaN(instanceId)) {
            return res.status(400).json({ success: false, error: 'Invalid instanceId' });
        }
        
        const stats = await RAGService.getStats(instanceId);
        res.json({ success: true, stats });
    } catch (e) {
        Logger.error('GET /knowledge-base/stats error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/knowledge-base/:instanceId/document/:kbId/chunks - Get document chunks
router.get('/knowledge-base/:instanceId/document/:kbId/chunks', async (req, res) => {
    try {
        const instanceId = parseInt(req.params.instanceId);
        const kbId = parseInt(req.params.kbId);
        if (isNaN(instanceId) || isNaN(kbId)) {
            return res.status(400).json({ success: false, error: 'Invalid instanceId or kbId' });
        }
        const chunks = await RAGService.getDocumentChunks(instanceId, kbId);
        const current = DB.get('SELECT id FROM knowledge_base WHERE id=? AND instanceId=? AND isCurrent=1', [kbId, instanceId]);
        const source = current && chunks.some(chunk => String(chunk.text || '').trim())
            ? require('../services/customer-native-knowledge.service').snapshot(instanceId, kbId) : null;
        res.set('Cache-Control', 'no-store').json({ success: true, chunks,
            ...(source ? { hash: source.editHash, sourceHash: source.hash } : {}) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE /api/knowledge-base/:instanceId/chunks/:chunkId - Delete a single chunk
router.delete('/knowledge-base/:instanceId/chunks/:chunkId', async (req, res) => {
    try {
        const chunkId = parseInt(req.params.chunkId);
        if (isNaN(chunkId)) {
            return res.status(400).json({ success: false, error: 'Invalid chunkId' });
        }
        const instanceId = parseInt(req.params.instanceId);
        if (isNaN(instanceId)) {
            return res.status(400).json({ success: false, error: 'Invalid instanceId' });
        }
        const result = await RAGService.deleteChunk(instanceId, chunkId);
        res.json({ success: true, message: 'Chunk deleted', ...result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// PUT /api/knowledge-base/:instanceId/chunks/:chunkId - Update a chunk
router.put('/knowledge-base/:instanceId/chunks/:chunkId', async (req, res) => {
    try {
        const chunkId = parseInt(req.params.chunkId);
        if (isNaN(chunkId)) {
            return res.status(400).json({ success: false, error: 'Invalid chunkId' });
        }
        const instanceId = parseInt(req.params.instanceId);
        if (isNaN(instanceId)) {
            return res.status(400).json({ success: false, error: 'Invalid instanceId' });
        }
        const { text, section, expectedHash } = req.body;
        if (!text) {
            return res.status(400).json({ success: false, error: 'text is required' });
        }
        const result = await RAGService.updateChunk(instanceId, chunkId, text, section, {
            expectedHash,
            beforeWrite: () => {
                if (req.auth?.userId) CustomerAccess.reauthorize(req, instanceId, 'business.manage');
            }
        });
        res.json({ success: true, message: 'Chunk updated', ...result });
    } catch (e) {
        const known = new Set(['INVALID_CHUNK', 'CHUNK_NOT_FOUND', 'DOCUMENT_NOT_FOUND',
            'DOCUMENT_EMPTY', 'DOCUMENT_REVISION_CONFLICT', 'DOCUMENT_SYNC_IN_PROGRESS', 'BUSINESS_ACCESS_DENIED']);
        res.status(known.has(e.code) ? e.statusCode || 500 : 500).json({
            success: false, error: known.has(e.code) ? e.message : 'Не удалось обновить источник',
            ...(known.has(e.code) ? { code: e.code } : {})
        });
    }
});

// GET /api/knowledge-base/:instanceId/analytics - Get RAG search analytics
router.get('/knowledge-base/:instanceId/analytics', async (req, res) => {
    try {
        const instanceId = parseInt(req.params.instanceId);
        if (isNaN(instanceId)) {
            return res.status(400).json({ success: false, error: 'Invalid instanceId' });
        }
        const analytics = DB.getRAGSearchAnalytics(instanceId);
        res.json({ success: true, analytics });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/knowledge-base/:instanceId/migrate-embeddings - Recreate vector table with new dimensions
router.post('/knowledge-base/:instanceId/migrate-embeddings', async (req, res) => {
    try {
        const instanceId = parseInt(req.params.instanceId);
        if (isNaN(instanceId)) {
            return res.status(400).json({ success: false, error: 'Invalid instanceId' });
        }
        const { dimensions } = req.body;
        if (!dimensions || dimensions < 1) {
            return res.status(400).json({ success: false, error: 'dimensions is required (positive integer)' });
        }
        const result = await RAGService.migrateEmbeddings(dimensions);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/knowledge-base/:instanceId/versions/:originalName - Get document version history
router.get('/knowledge-base/:instanceId/versions/:originalName', async (req, res) => {
    try {
        const instanceId = parseInt(req.params.instanceId);
        const originalName = req.params.originalName;
        if (isNaN(instanceId)) {
            return res.status(400).json({ success: false, error: 'Invalid instanceId' });
        }
        const versions = await DB.getAllKnowledgeBaseVersions(instanceId, originalName);
        res.json({ success: true, versions });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// =============================================
// YOOKASSA PAYMENTS Routes
// =============================================

const YookassaService = require('../services/yookassa.service');

router.get('/payments/:instanceId', async (req, res) => {
    try {
        const payments = await DB.getPaymentsByInstance(parseInt(req.params.instanceId));
        res.json({ success: true, payments });
    } catch (e) {
        Logger.error('GET /payments error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/payments/:instanceId/create', async (req, res) => {
    try {
        const { chatId, amount, description } = req.body;
        if (!chatId || !amount) {
            return res.status(400).json({ success: false, error: 'chatId and amount are required' });
        }
        const result = await YookassaService.createPaymentLink(
            parseInt(req.params.instanceId), chatId, parseFloat(amount), description || 'Оплата'
        );
        res.json({ success: true, ...result });
    } catch (e) {
        Logger.error('POST /payments/create error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// YooKassa Webhook — called by YooKassa servers when payment status changes
router.post('/payments/webhook', async (req, res) => {
    try {
        const event = req.body;
        Logger.info('[YooKassa Webhook] Received event:', JSON.stringify(event).substring(0, 200));

        if (event.event === 'payment.succeeded' && event.object) {
            const payment = event.object;
            const paymentId = payment.id;
            const metadata = payment.metadata || {};
            const instanceId = parseInt(metadata.instanceId);
            const chatId = metadata.chatId;

            // Update payment status in DB
            await DB.updatePaymentStatus(paymentId, 'succeeded');
            Logger.success(`[YooKassa] Оплата ${paymentId} успешна! Chat: ${chatId}`);

            if (instanceId && chatId) {
                // Update lead status to 'booked'
                try {
                    await DB.updateClientStatus(instanceId, chatId, 'booked', 'Оплата получена через ЮKassa', 'system');
                    Logger.success(`[YooKassa] Лид ${chatId} переведён в "booked" после оплаты`);
                } catch (e) {
                    Logger.warn('[YooKassa] Failed to update lead status:', e.message);
                }

                // Send confirmation message to client
                try {
                    const instanceConfig = await DB.getInstance(instanceId);
                    if (instanceConfig) {
                        const amount = payment.amount?.value || '?';
                        const confirmMsg = `✅ Ваш платёж на сумму ${amount} ₽ успешно принят! Спасибо за покупку! 🎉\n\nМы уже начинаем работу. Если есть вопросы — пишите в любое время.`;
                        await WhatsAppGatewayService.sendMessage(
                            instanceConfig,
                            chatId,
                            confirmMsg
                        );
                        // Save the confirmation message
                        await DB.saveMessage(instanceId, chatId, 'Bot', confirmMsg, 'assistant', 'Автоматическое подтверждение оплаты ЮKassa');
                    }
                } catch (e) {
                    Logger.warn('[YooKassa] Failed to send confirmation message:', e.message);
                }
            }
        } else if (event.event === 'payment.canceled' && event.object) {
            await DB.updatePaymentStatus(event.object.id, 'canceled');
            Logger.warn(`[YooKassa] Оплата ${event.object.id} отменена`);
        }

        // YooKassa expects 200 OK
        res.status(200).json({ success: true });
    } catch (e) {
        Logger.error('[YooKassa Webhook] Error:', e);
        res.status(200).json({ success: true }); // Always return 200 to YooKassa
    }
});

// =============================================
// REVENUE FORECASTING Routes
// =============================================

router.get('/analytics/forecast/:instanceId', async (req, res) => {
    try {
        const instanceId = Number(req.params.instanceId);
        if (!Number.isSafeInteger(instanceId) || instanceId < 1) {
            return res.status(400).json({ success: false, error: 'invalid_instance_id' });
        }
        // The customer-deals table is lazily created in older installations.
        // Profile budgets are free text, not priced deals or earned revenue.
        require('../services/customer-deals.store').ensureSchema();
        const rows = DB.all(`SELECT d.id, d.clientChatId, d.title, d.amountMinor, d.currency,
                d.stage, d.nextActionAt, d.updatedAt, c.senderName AS clientName
            FROM customer_deals d
            LEFT JOIN clients c ON c.instanceId=d.instanceId AND c.chatId=d.clientChatId
            WHERE d.instanceId=? ORDER BY d.updatedAt DESC,d.id DESC`, [instanceId]);
        const byCurrency = new Map();
        let activeDeals = 0;
        let completedDeals = 0;
        const deals = [];
        for (const row of rows) {
            const open = row.stage !== 'won' && row.stage !== 'lost';
            if (open) activeDeals++;
            if (row.stage === 'won') completedDeals++;
            if (open || row.stage === 'won') {
                const bucket = byCurrency.get(row.currency) || {
                    currency: row.currency, openAmountMinor: 0, wonAmountMinor: 0, openDeals: 0, wonDeals: 0
                };
                if (open) { bucket.openAmountMinor += row.amountMinor; bucket.openDeals++; }
                if (row.stage === 'won') { bucket.wonAmountMinor += row.amountMinor; bucket.wonDeals++; }
                byCurrency.set(row.currency, bucket);
            }
            if (open && deals.length < 20) deals.push({
                id: row.id, chatId: row.clientChatId, title: row.title, name: row.clientName || row.title,
                clientName: row.clientName || null, stage: row.stage, status: row.stage,
                amount: row.amountMinor / 100, currency: row.currency,
                nextActionAt: row.nextActionAt || null
            });
        }
        const amountsByCurrency = [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency))
            .map(({ currency, openAmountMinor, wonAmountMinor, openDeals, wonDeals }) => ({
                currency, openAmount: openAmountMinor / 100, wonAmount: wonAmountMinor / 100,
                openDeals, wonDeals
            }));
        // This is only captured YooKassa payment volume. It is RUB-only and
        // cannot be represented as all-channel or all-currency business revenue.
        const paymentRows = DB.all(`SELECT amount FROM payments WHERE instanceId=? AND status='succeeded'`, [instanceId]);
        const succeededPaymentsRUB = Math.round(paymentRows.reduce((sum, row) => sum + Number(row.amount || 0), 0) * 100) / 100;

        res.json({
            success: true,
            forecast: {
                source: 'customer_deals',
                amountsByCurrency,
                succeededPaymentsRUB,
                activeDeals,
                completedDeals,
                deals,
                // Keep old keys present, but never manufacture RUB totals from
                // mixed currencies or a probability model that does not exist.
                totalPipelineValue: null,
                weightedPipelineValue: null,
                totalRevenue: null,
                conversionRate: null
            }
        });
    } catch (e) {
        Logger.error('GET /analytics/forecast error:', e?.code || e?.name || 'unknown');
        res.status(500).json({ success: false, error: 'forecast_unavailable' });
    }
});

// =============================================
// BARISTA BOT Routes
// =============================================

/**
 * GET /api/barista/orders/:instanceId
 * Returns active orders for the barista panel
 */
router.get('/barista/orders/:instanceId', async (req, res) => {
    try {
        const orders = await DB.getActiveOrders(parseInt(req.params.instanceId));
        res.json({ success: true, orders });
    } catch (e) {
        Logger.error('GET /barista/orders error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/barista/orders/:instanceId/all?limit=50
 * Returns all orders (including completed/rejected)
 */
router.get('/barista/orders/:instanceId/all', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const orders = await DB.all(
            'SELECT * FROM orders WHERE instanceId = ? ORDER BY createdAt DESC LIMIT ?',
            [parseInt(req.params.instanceId), limit]
        );
        res.json({ success: true, orders });
    } catch (e) {
        Logger.error('GET /barista/orders/all error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/barista/stats/:instanceId
 * Returns order statistics
 */
router.get('/barista/stats/:instanceId', async (req, res) => {
    try {
        const stats = await DB.getOrderStats(parseInt(req.params.instanceId));
        res.json({ success: true, stats });
    } catch (e) {
        Logger.error('GET /barista/stats error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/barista/staff/:instanceId
 * Returns registered barista staff
 */
router.get('/barista/staff/:instanceId', async (req, res) => {
    try {
        const staff = await DB.getBaristaStaff(parseInt(req.params.instanceId));
        res.json({ success: true, staff });
    } catch (e) {
        Logger.error('GET /barista/staff error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * DELETE /api/barista/staff/:instanceId/:telegramChatId
 * Removes a barista from staff
 */
router.delete('/barista/staff/:instanceId/:telegramChatId', async (req, res) => {
    try {
        await DB.removeBaristaStaff(parseInt(req.params.instanceId), req.params.telegramChatId);
        res.json({ success: true });
    } catch (e) {
        Logger.error('DELETE /barista/staff error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * POST /api/barista/restart/:instanceId
 * Restarts the barista bot for an instance
 */
router.post('/barista/restart/:instanceId', async (req, res) => {
    try {
        const BaristaBotService = require('../services/barista-bot.service');
        const result = await BaristaBotService.restartBot(
            parseInt(req.params.instanceId),
            {
                baristaBotToken: req.body?.baristaBotToken,
                baristaInviteCode: req.body?.baristaInviteCode
            }
        );
        res.status(result.error === 'Instance not found' ? 404 : 200).json({
            ...result,
            message: result.success ? 'Bot restarted' : result.error
        });
    } catch (e) {
        Logger.error('POST /barista/restart error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// =============================================
// CoffeeOps Routes
// =============================================

router.get('/coffee/:instanceId/dashboard', async (req, res) => {
    try {
        const dashboard = await DB.getCoffeeDashboard(parseInt(req.params.instanceId));
        res.json({ success: true, dashboard });
    } catch (e) {
        Logger.error('GET /coffee/dashboard error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/coffee/:instanceId/orders/analytics', async (req, res) => {
    try {
        const analytics = await DB.getCoffeeOrderAnalytics(parseInt(req.params.instanceId), req.query.days);
        res.json({ success: true, analytics });
    } catch (e) {
        Logger.error('GET /coffee/orders/analytics error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/coffee/:instanceId/items/analytics', async (req, res) => {
    try {
        const analytics = await DB.getCoffeeItemAnalytics(parseInt(req.params.instanceId), req.query.days);
        res.json({ success: true, analytics });
    } catch (e) {
        Logger.error('GET /coffee/items/analytics error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/coffee/:instanceId/clients/:chatId/insights', async (req, res) => {
    try {
        const insights = await DB.getCoffeeClientInsights(
            parseInt(req.params.instanceId),
            decodeURIComponent(req.params.chatId)
        );
        res.json({ success: true, insights });
    } catch (e) {
        Logger.error('GET /coffee/clients/insights error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/coffee/:instanceId/stop-list', async (req, res) => {
    try {
        const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
        const items = await DB.getCoffeeStopList(parseInt(req.params.instanceId), includeInactive);
        res.json({ success: true, items });
    } catch (e) {
        Logger.error('GET /coffee/stop-list error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/coffee/:instanceId/stop-list', async (req, res) => {
    try {
        const item = await DB.addCoffeeStopListItem(parseInt(req.params.instanceId), req.body || {});
        res.json({ success: true, item });
    } catch (e) {
        Logger.error('POST /coffee/stop-list error:', e);
        res.status(400).json({ success: false, error: e.message });
    }
});

router.put('/coffee/:instanceId/stop-list/:itemId', async (req, res) => {
    try {
        const item = await DB.updateCoffeeStopListItem(
            parseInt(req.params.instanceId),
            parseInt(req.params.itemId),
            req.body || {}
        );
        res.json({ success: true, item });
    } catch (e) {
        Logger.error('PUT /coffee/stop-list error:', e);
        res.status(400).json({ success: false, error: e.message });
    }
});

router.delete('/coffee/:instanceId/stop-list/:itemId', async (req, res) => {
    try {
        const deleted = await DB.deleteCoffeeStopListItem(
            parseInt(req.params.instanceId),
            parseInt(req.params.itemId)
        );
        res.json({ success: true, deleted });
    } catch (e) {
        Logger.error('DELETE /coffee/stop-list error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.put('/coffee/:instanceId/operations-mode', async (req, res) => {
    try {
        const instance = await DB.updateCoffeeOperationsMode(parseInt(req.params.instanceId), req.body || {});
        res.json({ success: true, instance: sanitizeInstance(instance) });
    } catch (e) {
        Logger.error('PUT /coffee/operations-mode error:', e);
        res.status(400).json({ success: false, error: e.message });
    }
});

module.exports = router;
module.exports.sanitizeInstance = sanitizeInstance;
module.exports.sanitizeInstances = sanitizeInstances;
