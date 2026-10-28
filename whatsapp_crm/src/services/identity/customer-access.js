'use strict';
const Identity = require('./identity-store');
const DB = require('../database.service');

const CUSTOMER_FIELDS = new Set([
    'id','name','businessType','salesGoal','isActive','createdAt','updatedAt',
    'hotelTone','hotelTimezone','hotelWorkingHours','knowledgeBaseInstanceId',
    'sipCallerId','sipAliases','voiceContextName','voiceAiProvider','voiceModel','voiceName','voiceSettings','voiceAmbient','voiceWaiting',
    'voiceGreetingTemplate','outboundOpenerTemplate','systemPrompt','aiProvider','geminiModel','aiTemperature','aiResponseFormat','yandexGptModelUri','followupAutoSendEnabled','followupAutoSendRevision',
    'openWaSessionId','openWaStatus','whatsappProvider','greenApiInstance',
]);
const CUSTOMER_PROFILE_FIELDS = new Set([
    'id','businessId','business_id','instanceId','instance_id','name','businessType','isActive','createdAt','updatedAt',
    'hotelTone','hotelTimezone','hotelWorkingHours','sipCallerId','sipAliases','voiceAiProvider','voiceModel','voiceName','voiceSettings','voiceAmbient','voiceWaiting',
    'voiceGreetingTemplate','outboundOpenerTemplate','systemPrompt','followupAutoSendEnabled','followupAutoSendRevision',
]);
// Runtime routing and integration identities are assigned by the platform.
// A customer cannot select another hotel's context, SIP trunk or WA session.
const CUSTOMER_WRITABLE = new Set(['name','businessType','salesGoal','hotelTone','hotelTimezone',
    'hotelWorkingHours','sipCallerId','sipAliases','voiceAiProvider','voiceModel','voiceName','voiceAmbient','voiceWaiting','expectedVoiceProvider',
    'voiceGreetingTemplate','outboundOpenerTemplate','systemPrompt','followupAutoSendEnabled','expectedFollowupRevision']);
const READ_ROUTES = new Set([
    '/instances', '/hotel-profiles', '/hotel-profiles/:id', '/instances/:id/provisioning', '/ai/models/:instanceId', '/ai/providers/:instanceId',
    '/clients/:instanceId', '/messages/:instanceId/:chatId', '/stats/:instanceId',
    '/knowledge-base/:instanceId', '/knowledge-base/:instanceId/stats',
    '/knowledge-base/:instanceId/upload-status/:jobId', '/templates/:instanceId',
    '/openwa/status/:instanceId', '/whatsapp-gateway/status/:instanceId',
    '/clients/:instanceId/:chatId/status-history',
    '/clients/:instanceId/:chatId/followup-drafts', '/clients/:instanceId/:chatId/followup-channels',
    '/analytics/funnel/:instanceId', '/analytics/avg-time/:instanceId',
    '/analytics/export/:instanceId', '/analytics/activity-heatmap/:instanceId',
    '/analytics/messages-over-time/:instanceId', '/analytics/channel-breakdown/:instanceId',
    '/analytics/response-times/:instanceId', '/analytics/smart-summary/:instanceId',
    '/analytics/leads-over-time/:instanceId', '/analytics/forecast/:instanceId',
    '/knowledge-base/:instanceId/analytics', '/barista/stats/:instanceId',
    '/coffee/:instanceId/orders/analytics', '/coffee/:instanceId/items/analytics',
]);
const CAMPAIGN_ROUTES = new Map([
    ['get /sales-brain/outbound/campaigns/:instanceId', { owner: false }],
    ['get /sales-brain/outbound/campaigns/:campaignId/leads', { owner: false }],
    ['patch /sales-brain/outbound/campaigns/:campaignId', { owner: true }],
    ['post /sales-brain/outbound/campaigns/:campaignId/sync-leads', { owner: true }],
    ['post /sales-brain/outbound/campaigns/:campaignId/deploy-to-ava', { owner: true }],
    ['post /sales-brain/outbound/campaigns/:campaignId/ava-status', { owner: true }],
]);
const CAMPAIGN_WRITABLE = new Set([
    'name','sourceFilter','source_filter','timezone','callWindow','call_window',
    'maxAttempts','max_attempts','retryPolicy','retry_policy','postCallAction','post_call_action',
    'enabled','status',
]);
const CAMPAIGN_ACTION_FIELDS = new Map([
    ['post /sales-brain/outbound/campaigns/:campaignId/sync-leads', []],
    ['post /sales-brain/outbound/campaigns/:campaignId/deploy-to-ava',
        ['start','syncLeads','maxConcurrent','minIntervalSecondsBetweenCalls','sourceNumberId','confirmAudience']],
    ['post /sales-brain/outbound/campaigns/:campaignId/ava-status', ['status','cancelPending','confirmAudience']],
]);
const SCOPE_FIELDS = ['business_id','businessId','instanceId','instance_id'];
const CLIENT_MODEL_FIELDS = ['clientId','client_id','customerId','customer_id','model','modelId','model_id'];
const CHANNEL_CONFIG_FIELDS = new Set([
    'telegramBotToken', 'emailSmtpHost', 'emailSmtpPort', 'emailSmtpUser',
    'emailSmtpPass', 'emailImapHost', 'emailImapPort', 'emailImapUser',
    'emailImapPass', 'emailFromName', 'vkGroupToken', 'vkGroupId', 'maxBotToken',
]);
const TRIGGER_CREATE_FIELDS = new Set([
    'name', 'triggerType', 'conditions', 'actionType', 'actionData',
    'priority', 'maxExecutions', 'cooldownMinutes',
]);
const TRIGGER_UPDATE_FIELDS = new Set([...TRIGGER_CREATE_FIELDS, 'isActive']);
const SEQUENCE_FIELDS = new Set(['name', 'description', 'targetSegment', 'isActive']);
const STEP_FIELDS = new Set([
    'stepOrder', 'delayMinutes', 'messageTemplate', 'useAiPersonalization', 'channelOverride',
]);

function deny(code, statusCode = 403) {
    throw Object.assign(new Error(code), { statusCode });
}

function assertScope(req, instanceId, { rejectModelClient = false } = {}) {
    for (const source of [req.body, req.query]) {
        for (const key of SCOPE_FIELDS) {
            if (source?.[key] != null && Number(source[key]) !== Number(instanceId)) deny('BUSINESS_SCOPE_MISMATCH');
        }
        if (rejectModelClient && CLIENT_MODEL_FIELDS.some(key => source?.[key] != null)) deny('CUSTOMER_SCOPE_OVERRIDE_DENIED');
    }
}

function pickFields(source, allowed) {
    return Object.fromEntries(Object.entries(source || {}).filter(([key]) => allowed.has(key)));
}

function assertCustomerOrigin(req) {
    const configured = process.env.WHATSAPP_CRM_PUBLIC_URL;
    const accepted = new Set();
    if (configured) accepted.add(new URL(configured).origin);
    // A reverse-proxied installation may not set the optional public URL.
    // The browser's Origin must still match the host it is actually using.
    if (req.get?.('host')) accepted.add(`${req.protocol}://${req.get('host')}`);
    if (!req.headers?.origin || !accepted.has(req.headers.origin)
        || req.headers?.['sec-fetch-site'] === 'cross-site') {
        deny('CUSTOMER_ORIGIN_REQUIRED');
    }
}
// Reviewed operational actions belong to a hotel's owner AND managers, not
// the platform administrator. Keep a method-specific allowlist; destructive
// deletion and provider/runtime configuration remain unavailable here.
const CLIENT_ACTIONS = new Map([
    ['put /clients/:instanceId/:chatId/status', ['status','reason']],
    ['put /clients/:instanceId/:chatId/tags', ['tags']],
    ['post /clients/:instanceId/:chatId/send-message', ['text']],
    ['post /ai/summary/:instanceId/:chatId', []],
    ['post /ai/next-step/:instanceId/:chatId', []],
]);
const OWNER_ROUTES = new Set([
    '/instances/:id', '/instances/:id/provisioning/retry', '/hotel-profiles/:id',
    '/openwa/connect/:instanceId', '/openwa/replace/:instanceId', '/openwa/logout/:instanceId',
    '/openwa/qr/:instanceId',
    '/knowledge-base/:instanceId/upload', '/knowledge-base/:instanceId/:fileId',
    '/templates/:instanceId', '/templates/:instanceId/:templateId',
]);


// An actor snapshot proves the request's initial identity, not that its cookie
// survived an awaited DB/provider operation. Check both immediately before
// releasing private data or invoking another privileged operation.
function reauthorize(req, businessId, capability = 'business.read') {
    const current = require('../auth.service').getSession(req);
    if (!req.auth?.userId && req.auth?.platformRole === 'platform_admin' && current?.platformRole === 'platform_admin') {
        return Identity.authorizeCapability(current, businessId, capability);
    }
    if (!current || !req.auth?.userId || String(current.userId) !== String(req.auth.userId)) {
        deny('BUSINESS_ACCESS_DENIED');
    }
    return Identity.authorizeCapability(current, businessId, capability);
}

function filterCustomerProfile(profile, auth) {
    if (!profile || !auth?.userId || auth.platformRole === 'platform_admin') return profile;
    return Object.fromEntries(Object.entries(profile).filter(([key]) => CUSTOMER_PROFILE_FIELDS.has(key)));
}

function wrapCustomerProfileResponse(res, auth) {
    const json = res.json.bind(res);
    res.json = (payload) => {
        if (!payload?.profile) return json(payload);
        return json({ ...payload, profile: filterCustomerProfile(payload.profile, auth) });
    };
}

function forRoute(method, path) {
    return (req, res, next) => {
        // Break-glass operator and existing service paths remain separate from
        // customer sessions. Unreviewed endpoints are denied to customers.
        if (!req.auth?.userId) return next();
        try {
            if (req.auth.platformRole === 'platform_admin'
                && Identity.actor(req.auth.userId).platformRole === 'platform_admin') return next();
            if (path.startsWith('/businesses/:businessId/pms') || path.startsWith('/hotel-profiles/:id/pms')) {
                const rawId = req.params.businessId ?? req.params.id;
                const businessId = Number(rawId);
                if (!Number.isSafeInteger(businessId) || businessId < 1) deny('BUSINESS_SCOPE_REQUIRED', 400);
                const read = method === 'get';
                Identity.authorizeCapability(req.auth, businessId, read ? 'business.read' : 'business.manage');
                assertScope(req, businessId, { rejectModelClient: true });
                if (!read) assertCustomerOrigin(req);
                return next();
            }
            if (path === '/hotel-profiles/:id/voice-options' || path === '/hotel-profiles/:id/voice-preview' || path === '/hotel-profiles/:id/ambient-preview') {
                const instanceId = Number(req.params.id);
                if (!Number.isSafeInteger(instanceId) || instanceId < 1) deny('BUSINESS_SCOPE_REQUIRED', 400);
                const read = method === 'get' && path.endsWith('/voice-options');
                if (!read && !(method === 'post' && (path.endsWith('/voice-preview') || path.endsWith('/ambient-preview')))) deny('CUSTOMER_ROUTE_NOT_AVAILABLE');
                Identity.authorizeCapability(req.auth, instanceId, read ? 'business.read' : 'business.manage');
                assertScope(req, instanceId);
                if (!read) assertCustomerOrigin(req);
                return next();
            }
            if (path === '/hotel-profiles/:id/assistant-draft'
                || path === '/hotel-profiles/:id/assistant-draft/approve'
                || path === '/hotel-profiles/:id/assistant-draft/manual') {
                const instanceId = Number(req.params.id);
                if (!Number.isSafeInteger(instanceId) || instanceId < 1) deny('BUSINESS_SCOPE_REQUIRED', 400);
                const read = method === 'get' && path === '/hotel-profiles/:id/assistant-draft';
                if (!read && method !== 'post') deny('CUSTOMER_ROUTE_NOT_AVAILABLE');
                Identity.authorizeCapability(req.auth, instanceId, read ? 'business.read' : 'business.manage');
                assertScope(req, instanceId, { rejectModelClient: true });
                if (!read) {
                    assertCustomerOrigin(req);
                    req.body = pickFields(req.body, new Set(path.endsWith('/approve')
                        ? ['draftId', 'systemPrompt', 'settings'] : path.endsWith('/manual') ? ['systemPrompt', 'links', 'supplement'] : ['links', 'supplement']));
                }
                if (path.endsWith('/approve')) wrapCustomerProfileResponse(res, req.auth);
                return next();
            }
            if (['/sales-brain/followup-drafts/:draftId', '/sales-brain/followup-drafts/:draftId/send', '/sales-brain/followup-drafts/:draftId/claim'].includes(path)) {
                if (!((method === 'patch' && path === '/sales-brain/followup-drafts/:draftId') || (method === 'post' && (path.endsWith('/send') || path.endsWith('/claim'))))) deny('CUSTOMER_ROUTE_NOT_AVAILABLE');
                const instanceId = Number(req.body?.instanceId);
                if (!Number.isSafeInteger(instanceId) || instanceId < 1) deny('BUSINESS_SCOPE_REQUIRED', 400);
                Identity.authorizeCapability(req.auth, instanceId, path.endsWith('/send')
                    ? 'messages.send' : path.endsWith('/claim') ? 'tasks.claim' : 'sales.write');
                assertScope(req, instanceId, { rejectModelClient: true });
                assertCustomerOrigin(req);
                if (!DB.getFollowupDraft(instanceId, req.params.draftId)) deny('DRAFT_NOT_FOUND', 404);
                req.body = pickFields(req.body, new Set(method === 'patch'
                    ? ['instanceId', 'text', 'channel', 'recipient'] : ['instanceId']));
                return next();
            }
            if (method === 'post' && path === '/simulate') {
                const body = req.body;
                const instanceId = body?.instanceId;
                if (!body || typeof body !== 'object' || Array.isArray(body)
                    || !Number.isSafeInteger(instanceId) || instanceId < 1
                    || Object.keys(req.query || {}).length
                    || Object.keys(body).some(key => !['instanceId', 'message', 'history'].includes(key))
                    || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 1200
                    || !Array.isArray(body.history) || body.history.length > 20
                    || body.history.some(turn => !turn || typeof turn !== 'object' || Array.isArray(turn)
                        || !['user', 'assistant'].includes(turn.role)
                        || typeof turn.content !== 'string' || !turn.content.trim() || turn.content.length > 4000)) {
                    deny('INVALID_SIMULATION_REQUEST', 400);
                }
                Identity.authorizeCapability(req.auth, instanceId, 'business.manage');
                assertCustomerOrigin(req);
                assertScope(req, instanceId, { rejectModelClient: true });
                req.body = {
                    instanceId,
                    message: body.message.trim(),
                    history: body.history.map(turn => ({ role: turn.role, content: turn.content })),
                };
                return next();
            }
            if (path.startsWith('/channels/:instanceId/') || path.startsWith('/triggers/:instanceId')
                || path.startsWith('/sequences/:instanceId')) {
                const instanceId = Number(req.params.instanceId);
                if (!Number.isSafeInteger(instanceId) || instanceId < 1) deny('BUSINESS_SCOPE_REQUIRED', 400);
                const read = method === 'get';
                const channelRead = path === '/channels/:instanceId/status' && read;
                const channelConfig = path === '/channels/:instanceId/config' && method === 'put';
                const channelDisconnect = path === '/channels/:instanceId/:channel' && method === 'delete'
                    && ['telegram', 'email', 'vk', 'max'].includes(req.params.channel);
                const channelTest = /^\/channels\/:instanceId\/(telegram|email|vk|max)\/test$/.test(path) && method === 'post';
                const triggerRoute = path === '/triggers/:instanceId'
                    && ['get', 'post'].includes(method);
                const triggerLog = path === '/triggers/:instanceId/log' && read;
                const triggerSettings = path === '/triggers/:instanceId/settings'
                    && ['get', 'put'].includes(method);
                const triggerItem = path === '/triggers/:instanceId/:triggerId'
                    && ['put', 'delete'].includes(method);
                const sequenceRoute = path === '/sequences/:instanceId'
                    && ['get', 'post'].includes(method);
                const sequenceItem = path === '/sequences/:instanceId/:seqId'
                    && ['put', 'delete'].includes(method);
                const sequenceSteps = path === '/sequences/:instanceId/:seqId/steps'
                    && ['get', 'post'].includes(method);
                const sequenceStep = path === '/sequences/:instanceId/:seqId/steps/:stepId'
                    && ['put', 'delete'].includes(method);
                if (!(channelRead || channelConfig || channelDisconnect || channelTest || triggerRoute || triggerLog
                    || triggerSettings || triggerItem || sequenceRoute || sequenceItem
                    || sequenceSteps || sequenceStep)) deny('CUSTOMER_ROUTE_NOT_AVAILABLE');
                Identity.authorizeCapability(req.auth, instanceId, read ? 'business.read' : 'business.manage');
                assertScope(req, instanceId, { rejectModelClient: true });
                if (!read) assertCustomerOrigin(req);
                if (req.params.triggerId) {
                    const trigger = DB.get('SELECT instanceId FROM smart_triggers WHERE id = ?', [req.params.triggerId]);
                    if (!trigger || Number(trigger.instanceId) !== instanceId) deny('TRIGGER_NOT_FOUND', 404);
                }
                if (req.params.seqId) {
                    const sequence = DB.get('SELECT instanceId FROM message_sequences WHERE id = ?', [req.params.seqId]);
                    if (!sequence || Number(sequence.instanceId) !== instanceId) deny('SEQUENCE_NOT_FOUND', 404);
                }
                if (req.params.stepId) {
                    const step = DB.get('SELECT sequenceId FROM sequence_steps WHERE id = ?', [req.params.stepId]);
                    if (!step || Number(step.sequenceId) !== Number(req.params.seqId)) deny('STEP_NOT_FOUND', 404);
                }
                if (channelConfig) req.body = pickFields(req.body, CHANNEL_CONFIG_FIELDS);
                else if (triggerSettings && method === 'put') req.body = pickFields(req.body, new Set(['smartTriggersEnabled']));
                else if (triggerRoute && method === 'post') req.body = pickFields(req.body, TRIGGER_CREATE_FIELDS);
                else if (triggerItem && method === 'put') req.body = pickFields(req.body, TRIGGER_UPDATE_FIELDS);
                else if (sequenceRoute && method === 'post') req.body = pickFields(req.body, SEQUENCE_FIELDS);
                else if (sequenceItem && method === 'put') req.body = pickFields(req.body, SEQUENCE_FIELDS);
                else if (sequenceSteps && method === 'post') req.body = pickFields(req.body, STEP_FIELDS);
                else if (sequenceStep && method === 'put') req.body = pickFields(req.body, STEP_FIELDS);
                return next();
            }
            if (method === 'post' && path === '/knowledge-base/:instanceId/search') {
                Identity.authorizeCapability(req.auth, req.params.instanceId, 'ai.use');
                assertCustomerOrigin(req);
                assertScope(req, req.params.instanceId, { rejectModelClient: true });
                req.body = pickFields(req.body, new Set(['query','searchType','k']));
                return next();
            }
            if (method === 'post' && path === '/sales-brain/outbound/campaigns') {
                assertCustomerOrigin(req);
                const instanceId = req.body?.instanceId ?? req.body?.instance_id;
                Identity.authorizeCapability(req.auth, instanceId, 'business.manage');
                assertScope(req, instanceId, { rejectModelClient: true });
                if (req.body?.contextId != null && req.body.contextId !== 'unified_sales_agent') deny('CUSTOMER_CONTEXT_OVERRIDE_DENIED');
                if (req.body?.context_id != null && req.body.context_id !== 'unified_sales_agent') deny('CUSTOMER_CONTEXT_OVERRIDE_DENIED');
                req.body = { ...pickFields(req.body, CAMPAIGN_WRITABLE), instanceId: Number(instanceId), context_id: 'unified_sales_agent' };
                return next();
            }
            const campaignRoute = CAMPAIGN_ROUTES.get(`${method} ${path}`);
            if (campaignRoute) {
                if (campaignRoute.owner) assertCustomerOrigin(req);
                const campaign = req.params.campaignId ? DB.getOutboundCampaign(req.params.campaignId) : null;
                if (req.params.campaignId && !campaign) deny('CAMPAIGN_NOT_FOUND', 404);
                const instanceId = campaign?.instanceId ?? req.params.instanceId;
                Identity.authorizeCapability(req.auth, instanceId, campaignRoute.owner ? 'business.manage' : 'sales.read');
                assertScope(req, instanceId, { rejectModelClient: true });
                if (req.params.campaignId) {
                    for (const source of [req.body, req.query]) for (const key of ['campaignId','campaign_id']) {
                        if (source?.[key] != null && String(source[key]) !== String(req.params.campaignId)) deny('CAMPAIGN_SCOPE_MISMATCH');
                    }
                }
                if (method === 'patch') {
                    if (req.body?.contextId != null || req.body?.context_id != null) deny('CUSTOMER_CONTEXT_OVERRIDE_DENIED');
                    req.body = pickFields(req.body, CAMPAIGN_WRITABLE);
                } else if (CAMPAIGN_ACTION_FIELDS.has(`${method} ${path}`)) {
                    req.body = pickFields(req.body, new Set(CAMPAIGN_ACTION_FIELDS.get(`${method} ${path}`)));
                }
                return next();
            }
            const operationalFields = CLIENT_ACTIONS.get(`${method} ${path}`);
            if (operationalFields) {
                const capability = path.includes('/send-message') ? 'messages.send'
                    : path.startsWith('/ai/') ? 'ai.use' : 'sales.write';
                Identity.authorizeCapability(req.auth, req.params.instanceId, capability);
                assertCustomerOrigin(req);
                for (const source of [req.body, req.query]) for (const key of ['business_id','businessId','instanceId','instance_id']) {
                    if (source?.[key] != null && Number(source[key]) !== Number(req.params.instanceId)) {
                        throw Object.assign(new Error('BUSINESS_SCOPE_MISMATCH'), { statusCode: 403 });
                    }
                }
                const businessId = Number(req.params.instanceId);
                const Sales = require('../sales-workspace.service');
                const { row } = Sales.authorizeClientMutation(req.auth, businessId, req.params.chatId, { capability });
                req.params.chatId = row.chatId;
                // The final handler calls this after preparation awaits and
                // directly before its DB mutation or provider dispatch.
                req.reauthorizeCustomerAction = () => {
                    reauthorize(req, businessId, capability);
                    const authorized = Sales.authorizeClientMutation(req.auth, businessId, row.chatId, { capability });
                    req.params.chatId = authorized.row.chatId;
                    return authorized;
                };
                req.body = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => operationalFields.includes(key)));
                return next();
            }
            if (method === 'post' && path === '/instances') {
                const current = Identity.actor(req.auth.userId);
                if (current.businessQuota < 1 && !current.memberships.some(item => item.role === 'hotel_owner')) {
                    deny('BUSINESS_ACCESS_DENIED');
                }
                assertCustomerOrigin(req);
                req.body = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => CUSTOMER_WRITABLE.has(key)));
                return next();
            }
            const owner = method !== 'get' || path === '/openwa/qr/:instanceId';
            if (!(owner ? OWNER_ROUTES : READ_ROUTES).has(path)) throw Object.assign(new Error('CUSTOMER_ROUTE_NOT_AVAILABLE'), { statusCode: 403 });
            if (method !== 'get') assertCustomerOrigin(req);
            if (['/instances/:id','/hotel-profiles/:id'].includes(path) && !['get','put'].includes(method)) {
                throw Object.assign(new Error('CUSTOMER_ROUTE_NOT_AVAILABLE'), { statusCode: 403 });
            }
            const id = req.params.instanceId || req.params.id;
            if (id) {
                Identity.authorizeCapability(req.auth, id, owner ? 'business.manage' : 'business.read');
                for (const source of [req.body, req.query]) for (const key of ['business_id','businessId','instanceId','instance_id']) {
                    if (source?.[key] != null && Number(source[key]) !== Number(id)) throw Object.assign(new Error('BUSINESS_SCOPE_MISMATCH'), { statusCode: 403 });
                }
                if (owner && ['/instances/:id','/hotel-profiles/:id'].includes(path)) {
                    req.body = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => CUSTOMER_WRITABLE.has(key)
                        || (path === '/instances/:id' && ['aiProvider','geminiModel','yandexGptModelUri'].includes(key))));
                }
                if (path === '/hotel-profiles/:id') wrapCustomerProfileResponse(res, req.auth);
            }
            next();
        } catch (error) {
            if (path.includes('/assistant-draft')) {
                return res.status(error.statusCode || 403).json({ success: false,
                    error: error.code || error.message, message: 'Недостаточно прав для этого действия.' });
            }
            res.status(error.statusCode || 403).json({ success: false, code: error.code || error.message, error: 'Недостаточно прав для этого действия.' });
        }
    };
}


// The global customer boundary consumes the same reviewed route inventory as
// forRoute. Entries are method specific: future endpoints stay denied until
// both their capability and scoped handler have been reviewed.
const routePolicies = new Map();
function policy(method, path, capability) { routePolicies.set(`${method} ${path}`, capability); }
for (const path of READ_ROUTES) policy('get', path, 'business.read');
for (const [method, path] of [
    ['put','/instances/:id'], ['post','/instances/:id/provisioning/retry'],
    ['put','/hotel-profiles/:id'], ['post','/openwa/connect/:instanceId'],
    ['post','/openwa/replace/:instanceId'], ['post','/openwa/logout/:instanceId'],
    ['get','/openwa/qr/:instanceId'], ['post','/knowledge-base/:instanceId/upload'],
    ['delete','/knowledge-base/:instanceId/:fileId'], ['post','/templates/:instanceId'],
    ['delete','/templates/:instanceId/:templateId'],
    ['post','/hotel-profiles/:id/assistant-draft'],
    ['post','/hotel-profiles/:id/assistant-draft/approve'], ['post','/hotel-profiles/:id/assistant-draft/manual'], ['post','/simulate'],
    ['post','/sales-brain/outbound/campaigns'], ['post','/instances'],
]) policy(method, path, 'business.manage');
policy('get', '/hotel-profiles/:id/assistant-draft', 'business.read');
policy('get', '/hotel-profiles/:id/voice-options', 'business.read');
policy('post', '/hotel-profiles/:id/voice-preview', 'business.manage');
policy('post', '/hotel-profiles/:id/ambient-preview', 'business.manage');
for (const [key, fields] of CLIENT_ACTIONS) {
    const [method, path] = key.split(' ');
    policy(method, path, path.includes('/send-message') ? 'messages.send'
        : path.startsWith('/ai/') ? 'ai.use' : 'sales.write');
}
for (const [key, options] of CAMPAIGN_ROUTES) {
    const [method, path] = key.split(' ');
    policy(method, path, options.owner ? 'business.manage' : 'sales.read');
}
policy('post', '/knowledge-base/:instanceId/search', 'ai.use');
policy('patch', '/sales-brain/followup-drafts/:draftId', 'sales.write');
policy('post', '/sales-brain/followup-drafts/:draftId/send', 'messages.send');
policy('post', '/sales-brain/followup-drafts/:draftId/claim', 'tasks.claim');
for (const path of ['/channels/:instanceId/status', '/triggers/:instanceId',
    '/triggers/:instanceId/log', '/triggers/:instanceId/settings',
    '/sequences/:instanceId', '/sequences/:instanceId/:seqId/steps']) policy('get', path, 'business.read');
for (const [method, path] of [
    ['put','/channels/:instanceId/config'], ['delete','/channels/:instanceId/:channel'],
    ...['telegram','email','vk','max'].map(channel => ['post', `/channels/:instanceId/${channel}/test`]),
    ['post','/triggers/:instanceId'], ['put','/triggers/:instanceId/settings'],
    ['put','/triggers/:instanceId/:triggerId'], ['delete','/triggers/:instanceId/:triggerId'],
    ['post','/sequences/:instanceId'], ['put','/sequences/:instanceId/:seqId'],
    ['delete','/sequences/:instanceId/:seqId'], ['post','/sequences/:instanceId/:seqId/steps'],
    ['put','/sequences/:instanceId/:seqId/steps/:stepId'],
    ['delete','/sequences/:instanceId/:seqId/steps/:stepId'],
]) policy(method, path, 'business.manage');
for (const prefix of ['/businesses/:businessId/pms', '/hotel-profiles/:id/pms']) {
    policy('get', prefix, 'business.read');
    policy('put', prefix, 'business.manage');
    policy('delete', prefix, 'business.manage');
    policy('post', prefix + '/test', 'business.manage');
    policy('post', prefix + '/sync', 'business.manage');
    policy('post', prefix + '/webhooks', 'business.manage');
    policy('get', prefix + '/bookings', 'business.read');
    policy('get', prefix + '/booking-requests', 'business.read');
}

function filterInstances(instances, auth) {
    if (!auth?.userId || auth.platformRole === 'platform_admin') return instances;
    const allowed = new Set(Identity.actor(auth.userId).memberships.map(item => item.businessId));
    return instances.filter(row => allowed.has(Number(row.id ?? row.business_id)))
        .map(row => ({...Object.fromEntries(Object.entries(row).filter(([key]) => CUSTOMER_FIELDS.has(key))),
            ...require('../voice-settings.service').project(row),
            followupAutoSendEnabled: require('../postcall-followup.service').policy(row).enabled,
            followupAutoSendRevision: require('../postcall-followup.service').policy(row).revision}));
}
// Only public new-account team enrollment may be paused. Existing-account
// acceptance and owner/platform registration keep their separate proof paths.
function teamNewAccountEnabled() {
    return String(process.env.AVA_TEAM_NEW_ACCOUNT_ENABLED || '').trim().toLowerCase() !== 'false';
}

function assertTeamNewAccountEnabled(invitation) {
    if (invitation?.acceptanceMode === 'team'
        && !(invitation.userEnabled && invitation.subject) && !teamNewAccountEnabled()) {
        throw Object.assign(new Error('TEAM_NEW_ACCOUNT_UNAVAILABLE'), { code: 'TEAM_NEW_ACCOUNT_UNAVAILABLE', statusCode: 503 });
    }
}

module.exports = { forRoute, filterInstances, filterCustomerProfile, CUSTOMER_FIELDS, CUSTOMER_PROFILE_FIELDS, routePolicies, reauthorize,
    teamNewAccountEnabled, assertTeamNewAccountEnabled };
