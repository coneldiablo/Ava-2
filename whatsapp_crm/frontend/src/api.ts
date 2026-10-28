import axios from 'axios';
import type { InviteRole, InviteResult, TeamResponse, SalesWorkspaceResponse, SalesView, SalesTaskInput, SalesTaskUpdate } from './teamSales';

export const api = axios.create({
    baseURL: '/api',
    withCredentials: true,
});

// CRM waits for knowledge retrieval and private-session cleanup before replying.
const KNOWLEDGE_ANSWER_TIMEOUT_MS = 45_000;
const KNOWLEDGE_STATUS_TIMEOUT_MS = 15_000;

api.interceptors.response.use(
    response => response,
    error => {
        const requestUrl = String(error.config?.url || '');
        if (error.response?.status === 401 && !requestUrl.startsWith('/auth/')) {
            window.dispatchEvent(new Event('crm:unauthorized'));
        }
        if (error.response?.status === 403 && !requestUrl.startsWith('/auth/')) {
            window.dispatchEvent(new Event('crm:forbidden'));
        }
        return Promise.reject(error);
    }
);

export const getAuthSession = () => api.get('/auth/me').then(res => res.data);
export const login = (login: string, password: string) =>
    api.post('/auth/login', { login, password }).then(res => res.data);
export const logout = () => api.post('/auth/logout').then(res => res.data);
export const createModuleGrant = (adapterId: string, codeChallenge: string, signal?: AbortSignal) =>
    api.post(`/modules/${encodeURIComponent(adapterId)}/grants`, { code_challenge: codeChallenge },
        { signal, timeout: 15000 }).then(res => res.data as { code: string; callbackUrl: string; expiresAt: number });

export const getInstances = (signal?: AbortSignal) => api.get('/instances', { signal, timeout: 15_000 }).then(res => res.data);
export const getBusinessTeam = (businessId: number, signal?: AbortSignal) =>
    api.get(`/businesses/${businessId}/team`, { signal }).then(res => res.data as TeamResponse);
export const createTeamInvitation = (businessId: number, data: { email: string; role: InviteRole; displayName?: string }, signal?: AbortSignal) =>
    api.post(`/businesses/${businessId}/team/invitations`, data, { signal }).then(res => res.data as InviteResult);
export const inviteBusinessManager = (businessId: number, email: string) => createTeamInvitation(businessId, { email, role: 'manager' });
export const updateTeamMemberRole = (businessId: number, userId: string | number, role: InviteRole, signal?: AbortSignal) =>
    api.patch(`/businesses/${businessId}/team/members/${encodeURIComponent(userId)}`, { role }, { signal }).then(res => res.data as { success: boolean });
export const removeTeamMember = (businessId: number, userId: string | number, signal?: AbortSignal) =>
    api.delete(`/businesses/${businessId}/team/members/${encodeURIComponent(userId)}`, { signal }).then(res => res.data as { success: boolean });
export const renewTeamInvitation = (businessId: number, invitationId: string | number, signal?: AbortSignal) =>
    api.post(`/businesses/${businessId}/team/invitations/${encodeURIComponent(invitationId)}/renew`, {}, { signal }).then(res => res.data as InviteResult);
export const resendTeamInvitation = (businessId: number, invitationId: string | number, signal?: AbortSignal) =>
    api.post(`/businesses/${businessId}/team/invitations/${encodeURIComponent(invitationId)}/resend`, {}, { signal }).then(res => res.data as InviteResult);
export const revokeTeamInvitation = (businessId: number, invitationId: string | number, signal?: AbortSignal) =>
    api.delete(`/businesses/${businessId}/team/invitations/${encodeURIComponent(invitationId)}`, { signal }).then(res => res.data as { success: boolean });
export const getSalesWorkspace = (businessId: number, view: SalesView, page = 1, signal?: AbortSignal) =>
    api.get(`/businesses/${businessId}/sales-workspace`, { params: { view, page, pageSize: 30 }, signal }).then(res => res.data as SalesWorkspaceResponse);
export const createSalesTask = (businessId: number, data: SalesTaskInput, signal?: AbortSignal) =>
    api.post(`/businesses/${businessId}/sales-workspace/tasks`, data, { signal }).then(res => res.data as { success: boolean });
export const updateSalesTask = (businessId: number, taskId: string, data: SalesTaskUpdate, signal?: AbortSignal) =>
    api.patch(`/businesses/${businessId}/sales-workspace/tasks/${encodeURIComponent(taskId)}`, data, { signal }).then(res => res.data as { success: boolean });
export const claimSalesTask = (businessId: number, taskId: string, signal?: AbortSignal) =>
    api.post(`/businesses/${businessId}/sales-workspace/tasks/${encodeURIComponent(taskId)}/claim`, {}, { signal }).then(res => res.data as { success: boolean });
export const assignSalesClient = (businessId: number, chatId: string, assigneeUserId: string | null, signal?: AbortSignal) =>
    api.put(`/businesses/${businessId}/sales-workspace/clients/${encodeURIComponent(chatId)}/assignee`, { assigneeUserId }, { signal }).then(res => res.data as { success: boolean });
export const renameSalesClient = (businessId: number, chatId: string, name: string, previousName: string, signal?: AbortSignal) =>
    api.put(`/businesses/${businessId}/sales-workspace/clients/${encodeURIComponent(chatId)}/name`, { name, previousName }, { signal, timeout: 15_000 }).then(res => res.data as { success: boolean; businessId:number; client:{chatId:string;name:string} });
export const previewKnowledgeAnswer = (businessId: number, question: string, signal?: AbortSignal) =>
    api.post(`/businesses/${businessId}/knowledge/preview`, { question },
        { signal, timeout: KNOWLEDGE_ANSWER_TIMEOUT_MS }).then(res => res.data);
export const getBusinessGptChats = (businessId: number, signal?: AbortSignal) =>
    api.get(`/businesses/${businessId}/business-gpt/chats`, { signal, timeout: KNOWLEDGE_STATUS_TIMEOUT_MS }).then(res => res.data);
export const createBusinessGptChat = (businessId: number, signal?: AbortSignal) =>
    api.post(`/businesses/${businessId}/business-gpt/chats`, {}, { signal, timeout: KNOWLEDGE_STATUS_TIMEOUT_MS }).then(res => res.data);
export const getBusinessGptChat = (businessId: number, chatId: string, signal?: AbortSignal) =>
    api.get(`/businesses/${businessId}/business-gpt/chats/${encodeURIComponent(chatId)}`, { signal, timeout: KNOWLEDGE_STATUS_TIMEOUT_MS }).then(res => res.data);
export const sendBusinessGptMessage = (businessId: number, chatId: string, question: string, requestId: string, signal?: AbortSignal) =>
    api.post(`/businesses/${businessId}/business-gpt/chats/${encodeURIComponent(chatId)}/messages`,
        { question, requestId }, { signal, timeout: KNOWLEDGE_ANSWER_TIMEOUT_MS }).then(res => res.data);
export const createInstance = (data: any, idempotencyKey?: string) => api.post('/instances', data,
    idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined).then(res => res.data);
export const getProvisioningStatus = (id: number, signal?: AbortSignal) =>
    api.get(`/instances/${id}/provisioning`, { signal }).then(res => res.data);
export const retryProvisioning = (id: number, module: string) =>
    api.post(`/instances/${id}/provisioning/retry`, { module }).then(res => res.data);
export const updateInstance = (id: number, data: any, signal?: AbortSignal) =>
    api.put(`/instances/${id}`, data, { signal, timeout: 15_000 }).then(res => res.data);
export const deleteInstance = (id: number) => api.delete(`/instances/${id}`).then(res => res.data);
export const simulateChat = (data: any, signal?: AbortSignal) => api.post('/simulate', data, { signal, timeout: KNOWLEDGE_ANSWER_TIMEOUT_MS }).then(res => res.data);
export const getClients = (instanceId: number, signal?: AbortSignal) => api.get(`/clients/${instanceId}`, { signal }).then(res => res.data);
export const deleteLead = (instanceId: number, chatId: string) => api.delete(`/clients/${instanceId}/${encodeURIComponent(chatId)}`).then(res => res.data);
export const updateClientStatus = (instanceId: number, chatId: string, status: string) => api.put(`/clients/${instanceId}/${encodeURIComponent(chatId)}/status`, { status }).then(res => res.data);
export const getStatusHistory = (instanceId: number, chatId: string) => api.get(`/clients/${instanceId}/${encodeURIComponent(chatId)}/status-history`).then(res => res.data);
export const getClientOrders = (instanceId: number, chatId: string, limit = 20) =>
    api.get(`/clients/${instanceId}/${encodeURIComponent(chatId)}/orders?limit=${limit}`).then(res => res.data);
export const getSalesBrainClientContext = (instanceId: number, chatId: string, limit = 50) =>
    api.get(`/clients/${instanceId}/${encodeURIComponent(chatId)}/sales-brain?limit=${limit}`).then(res => res.data);
export const getFollowupDrafts = (instanceId: number, chatId: string, limit = 20) =>
    api.get(`/clients/${instanceId}/${encodeURIComponent(chatId)}/followup-drafts?limit=${limit}`).then(res => res.data);
export const sendFollowupDraft = (draftId: string) =>
    api.post(`/sales-brain/followup-drafts/${encodeURIComponent(draftId)}/send`).then(res => res.data);
export const getSipAlias = (instanceId: number, chatId: string) =>
    api.get(`/clients/${instanceId}/${encodeURIComponent(chatId)}/sip-alias`).then(res => res.data);
export const setSipAlias = (instanceId: number, chatId: string, extension: string) =>
    api.put(`/clients/${instanceId}/${encodeURIComponent(chatId)}/sip-alias`, { extension }).then(res => res.data);
export const deleteSipAlias = (instanceId: number, chatId: string) =>
    api.delete(`/clients/${instanceId}/${encodeURIComponent(chatId)}/sip-alias`).then(res => res.data);
export const getMessages = (instanceId: number, chatId: string) => api.get(`/messages/${instanceId}/${encodeURIComponent(chatId)}`).then(res => res.data);
export const getStats = (instanceId: number) => api.get(`/stats/${instanceId}`).then(res => res.data);

// --- Sales Brain Outbound ---
export const getSalesBrainOutboundCampaigns = (instanceId: number) =>
    api.get(`/sales-brain/outbound/campaigns/${instanceId}`, { timeout: 20000 }).then(res => res.data);
export const createSalesBrainOutboundCampaign = (data: any) =>
    api.post('/sales-brain/outbound/campaigns', data).then(res => res.data);
export const updateSalesBrainOutboundCampaign = (campaignId: string, data: any) =>
    api.patch(`/sales-brain/outbound/campaigns/${encodeURIComponent(campaignId)}`, data).then(res => res.data);
export const syncSalesBrainOutboundLeads = (campaignId: string) =>
    api.post(`/sales-brain/outbound/campaigns/${encodeURIComponent(campaignId)}/sync-leads`).then(res => res.data);
export const getSalesBrainOutboundLeads = (campaignId: string, state?: string) => {
    const query = state ? `?state=${encodeURIComponent(state)}` : '';
    return api.get(`/sales-brain/outbound/campaigns/${encodeURIComponent(campaignId)}/leads${query}`).then(res => res.data);
};
export const deploySalesBrainCampaignToAva = (
    campaignId: string,
    options: {
        sourceNumberId?: string;
        start?: boolean;
        syncLeads?: boolean;
        maxConcurrent?: number;
        minIntervalSecondsBetweenCalls?: number;
    } = {}
) => api.post(
    `/sales-brain/outbound/campaigns/${encodeURIComponent(campaignId)}/deploy-to-ava`,
    options
).then(res => res.data);
export const setSalesBrainCampaignAvaStatus = (
    campaignId: string,
    status: 'running' | 'paused' | 'stopped',
    cancelPending = false
) => api.post(
    `/sales-brain/outbound/campaigns/${encodeURIComponent(campaignId)}/ava-status`,
    { status, cancelPending }
).then(res => res.data);

// --- GREEN-API Management ---
export const getGreenApiStatus = (instanceId: number, force = false) =>
    api.get(`/green-api/status/${instanceId}${force ? '?force=1' : ''}`).then(res => res.data);
export const getGreenApiQR = (instanceId: number) => api.get(`/green-api/qr/${instanceId}`).then(res => res.data);
export const setupGreenApiWebhook = (instanceId: number, webhookUrl?: string) =>
    api.post(`/green-api/setup-webhook/${instanceId}`, webhookUrl ? { webhookUrl } : {}).then(res => res.data);
export const greenApiLogout = (instanceId: number) => api.post(`/green-api/logout/${instanceId}`).then(res => res.data);
export const greenApiReboot = (instanceId: number) => api.post(`/green-api/reboot/${instanceId}`).then(res => res.data);

// --- OpenWA Management ---
export const getOpenWaStatus = (instanceId: number, force = false) =>
    api.get(`/openwa/status/${instanceId}${force ? '?force=1' : ''}`, { timeout: 12000 }).then(res => res.data);
export const getOpenWaQR = (instanceId: number) => api.get(`/openwa/qr/${instanceId}`, { timeout: 18000 }).then(res => res.data);
export const connectWhatsApp = (instanceId: number) => api.post(`/openwa/connect/${instanceId}`, {}, { timeout: 90000 }).then(res => res.data);
export const replaceWhatsApp = (instanceId: number, expectedSessionId: string) => api.post(`/openwa/replace/${instanceId}`, { confirm: true, expected_session_id: expectedSessionId }, { timeout: 90000 }).then(res => res.data);
export const createOpenWaSession = (instanceId: number, name?: string) =>
    api.post(`/openwa/create-session/${instanceId}`, name ? { name } : {}).then(res => res.data);
export const startOpenWaSession = (instanceId: number) => api.post(`/openwa/start/${instanceId}`).then(res => res.data);
export const stopOpenWaSession = (instanceId: number) => api.post(`/openwa/stop/${instanceId}`).then(res => res.data);
export const logoutOpenWa = (instanceId: number) => api.post(`/openwa/logout/${instanceId}`, {}, { timeout: 18000 }).then(res => res.data);
export const setupOpenWaWebhook = (instanceId: number, webhookUrl?: string) =>
    api.post(`/openwa/setup-webhook/${instanceId}`, webhookUrl ? { webhookUrl } : {}).then(res => res.data);

// --- WhatsApp Unified Gateway Status ---
export const getWhatsAppGatewayStatus = (instanceId: number, force = false) =>
    api.get(`/whatsapp-gateway/status/${instanceId}${force ? '?force=1' : ''}`).then(res => res.data);

// --- Templates ---
export const getTemplates = (instanceId: number) => api.get(`/templates/${instanceId}`).then(res => res.data);
export const createTemplate = (instanceId: number, data: { label: string; text: string }) => api.post(`/templates/${instanceId}`, data).then(res => res.data);
export const deleteTemplate = (instanceId: number, templateId: number) => api.delete(`/templates/${instanceId}/${templateId}`).then(res => res.data);

// --- Send Message (Quick Reply) ---
export const sendMessageToClient = (instanceId: number, chatId: string, text: string) =>
    api.post(`/clients/${instanceId}/${encodeURIComponent(chatId)}/send-message`, { text })
        .then(res => res.data)
        .catch(error => {
            if (!chatId.startsWith('igp:')) throw error;
            const code = error?.response?.data?.code;
            const messages: Record<string, string> = {
                INSTAGRAM_PRIVATE_DISABLED: 'Instagram Direct временно недоступен. Проверьте состояние канала.',
                INSTAGRAM_PRIVATE_THREAD_NOT_FOUND: 'Этот диалог больше не связан с подключённым Instagram-аккаунтом.',
                INSTAGRAM_PRIVATE_LOGIN_REQUIRED: 'Сессия Instagram закончилась. Откройте «Каналы связи» и войдите снова.',
                INSTAGRAM_PRIVATE_RATE_LIMITED: 'Instagram временно ограничил запросы. Повторите позже.',
                INSTAGRAM_PRIVATE_OPERATION_IN_PROGRESS: 'Instagram ещё обрабатывает предыдущий запрос. Повторите позже.',
                INSTAGRAM_PRIVATE_SEND_RESULT_UNKNOWN: 'Не удалось подтвердить отправку. Проверьте диалог в Instagram перед повторной попыткой.',
                instagram_recipient_not_inbound: 'Ответ возможен только в существующем входящем диалоге Instagram.',
                instagram_manual_reply_required: 'Отправить ответ может только сотрудник этого бизнеса.',
            };
            throw new Error(messages[code] || 'Не удалось отправить сообщение в Instagram. Проверьте состояние канала.');
        });

// --- Tags ---
export const updateClientTags = (instanceId: number, chatId: string, tags: string[]) =>
    api.put(`/clients/${instanceId}/${encodeURIComponent(chatId)}/tags`, { tags }).then(res => res.data);

// --- Push Notifications ---
export const getVapidPublicKey = () => api.get('/push/vapid-public-key').then(res => res.data);
export const subscribePush = (subscription: PushSubscriptionJSON, instanceId?: number) =>
    api.post('/push/subscribe', { subscription, instanceId }).then(res => res.data);
export const unsubscribePush = (endpoint: string) =>
    api.post('/push/unsubscribe', { endpoint }).then(res => res.data);
export const testPushNotification = (instanceId?: number) =>
    api.post('/push/test', { instanceId }).then(res => res.data);

// --- Analytics ---
export const getAnalyticsFunnel = (instanceId: number) =>
    api.get(`/analytics/funnel/${instanceId}`).then(res => res.data);
export const getAnalyticsAvgTime = (instanceId: number) =>
    api.get(`/analytics/avg-time/${instanceId}`).then(res => res.data);
export const getAnalyticsExportUrl = (instanceId: number, format: string, dateFrom?: string, dateTo?: string) => {
    const params = new URLSearchParams({ format });
    if (dateFrom) params.set('from', dateFrom);
    if (dateTo) params.set('to', dateTo);
    return `/api/analytics/export/${instanceId}?${params.toString()}`;
};
export const getAnalyticsHeatmap = (instanceId: number) =>
    api.get(`/analytics/activity-heatmap/${instanceId}`).then(res => res.data);
export const getAnalyticsMessagesOverTime = (instanceId: number, days = 30) =>
    api.get(`/analytics/messages-over-time/${instanceId}?days=${days}`).then(res => res.data);
export const getAnalyticsChannelBreakdown = (instanceId: number) =>
    api.get(`/analytics/channel-breakdown/${instanceId}`).then(res => res.data);
export const getAnalyticsResponseTimes = (instanceId: number) =>
    api.get(`/analytics/response-times/${instanceId}`).then(res => res.data);
export const getAnalyticsSmartSummary = (instanceId: number) =>
    api.get(`/analytics/smart-summary/${instanceId}`).then(res => res.data);
export const getAnalyticsLeadsOverTime = (instanceId: number, days = 30) =>
    api.get(`/analytics/leads-over-time/${instanceId}?days=${days}`).then(res => res.data);
export const getCallAnalytics = (instanceId: number, days: 7 | 30 | 90 = 30) =>
    api.get(`/calls/stats/${instanceId}`, { params: { days } }).then(res => res.data);

// --- AI Features ---
export type AiModel = { id: string; name?: string };
export type TextAiProvider = 'aitunnel' | 'gemini';
export const getAiProviders = (instanceId: number, signal?: AbortSignal) =>
    api.get(`/ai/providers/${instanceId}`, { signal, timeout: 15_000 }).then(res => res.data);
export const getAiModels = (instanceId: number, signal?: AbortSignal, provider?: TextAiProvider) =>
    api.get(`/ai/models/${instanceId}`, { signal, timeout: 20_000, ...(provider ? { params: { provider } } : {}) }).then(res => res.data);
export const getAiSummary = (instanceId: number, chatId: string) =>
    api.post(`/ai/summary/${instanceId}/${encodeURIComponent(chatId)}`).then(res => res.data);
export const getAiNextStep = (instanceId: number, chatId: string) =>
    api.post(`/ai/next-step/${instanceId}/${encodeURIComponent(chatId)}`).then(res => res.data);

// --- Personalization ---
export const getClientProfile = (instanceId: number, chatId: string) =>
    api.get(`/personalization/profile/${instanceId}/${encodeURIComponent(chatId)}`).then(res => res.data);
export const buildClientProfile = (instanceId: number, chatId: string) =>
    api.post(`/personalization/profile/${instanceId}/${encodeURIComponent(chatId)}`).then(res => res.data);
export const getOptimalContactTime = (instanceId: number, chatId: string) =>
    api.get(`/personalization/contact-time/${instanceId}/${encodeURIComponent(chatId)}`).then(res => res.data);
export const generateOffer = (instanceId: number, chatId: string) =>
    api.post(`/personalization/offer/${instanceId}/${encodeURIComponent(chatId)}`).then(res => res.data);
export const getDynamicPricing = (instanceId: number, chatId: string) =>
    api.get(`/personalization/pricing/${instanceId}/${encodeURIComponent(chatId)}`).then(res => res.data);

// --- Smart Triggers ---
export const getTriggers = (instanceId: number) =>
    api.get(`/triggers/${instanceId}`).then(res => res.data);
export const createTrigger = (instanceId: number, data: any) =>
    api.post(`/triggers/${instanceId}`, data).then(res => res.data);
export const updateTrigger = (instanceId: number, triggerId: number, data: any) =>
    api.put(`/triggers/${instanceId}/${triggerId}`, data).then(res => res.data);
export const deleteTrigger = (instanceId: number, triggerId: number) =>
    api.delete(`/triggers/${instanceId}/${triggerId}`).then(res => res.data);
export const getTriggerLog = (instanceId: number) =>
    api.get(`/triggers/${instanceId}/log`).then(res => res.data);

// --- Sequences ---
export const getSequences = (instanceId: number) =>
    api.get(`/sequences/${instanceId}`).then(res => res.data);
export const createSequence = (instanceId: number, data: any) =>
    api.post(`/sequences/${instanceId}`, data).then(res => res.data);
export const updateSequence = (instanceId: number, seqId: number, data: any) =>
    api.put(`/sequences/${instanceId}/${seqId}`, data).then(res => res.data);
export const deleteSequence = (instanceId: number, seqId: number) =>
    api.delete(`/sequences/${instanceId}/${seqId}`).then(res => res.data);
export const getSequenceSteps = (instanceId: number, seqId: number) =>
    api.get(`/sequences/${instanceId}/${seqId}/steps`).then(res => res.data);
export const addSequenceStep = (instanceId: number, seqId: number, data: any) =>
    api.post(`/sequences/${instanceId}/${seqId}/steps`, data).then(res => res.data);
export const updateSequenceStep = (instanceId: number, seqId: number, stepId: number, data: any) =>
    api.put(`/sequences/${instanceId}/${seqId}/steps/${stepId}`, data).then(res => res.data);
export const deleteSequenceStep = (instanceId: number, seqId: number, stepId: number) =>
    api.delete(`/sequences/${instanceId}/${seqId}/steps/${stepId}`).then(res => res.data);
export const assignToSequence = (instanceId: number, seqId: number, chatId: string) =>
    api.post(`/sequences/${instanceId}/${seqId}/assign/${encodeURIComponent(chatId)}`).then(res => res.data);
export const bulkAssignSequence = (instanceId: number, seqId: number, chatIds: string[]) =>
    api.post(`/sequences/${instanceId}/${seqId}/bulk-assign`, { chatIds }).then(res => res.data);

// --- Channels ---
export const getChannelStatus = (instanceId: number, signal?: AbortSignal) =>
    api.get(`/channels/${instanceId}/status`, { signal, timeout: 15000 }).then(res => res.data);
export const saveChannelConfig = (instanceId: number, data: Record<string, string>, signal?: AbortSignal) =>
    api.put(`/channels/${instanceId}/config`, data, { signal, timeout: 30000 }).then(res => res.data);
export const disconnectChannel = (instanceId: number, channel: 'telegram' | 'email' | 'vk' | 'max', signal?: AbortSignal) =>
    api.delete(`/channels/${instanceId}/${channel}`, { signal, timeout: 30000 }).then(res => res.data);
export const getTriggerSettings = (instanceId: number) =>
    api.get(`/triggers/${instanceId}/settings`).then(res => res.data);
export const updateTriggerSettings = (instanceId: number, smartTriggersEnabled: boolean) =>
    api.put(`/triggers/${instanceId}/settings`, { smartTriggersEnabled }).then(res => res.data);
export const testTelegram = (instanceId: number, signal?: AbortSignal) =>
    api.post(`/channels/${instanceId}/telegram/test`, undefined, { signal, timeout: 30000 }).then(res => res.data);
export const testEmail = (instanceId: number, signal?: AbortSignal) =>
    api.post(`/channels/${instanceId}/email/test`, undefined, { signal, timeout: 30000 }).then(res => res.data);
export const testVk = (instanceId: number, signal?: AbortSignal) =>
    api.post(`/channels/${instanceId}/vk/test`, undefined, { signal, timeout: 30000 }).then(res => res.data);
export const testMax = (instanceId: number, signal?: AbortSignal) =>
    api.post(`/channels/${instanceId}/max/test`, undefined, { signal, timeout: 30000 }).then(res => res.data);

// --- Instagram Direct customer connector (private API) ---
export type InstagramPrivateStatus = {
    success: boolean;
    configured: boolean;
    state: 'disabled' | 'not_connected' | 'awaiting_inbound' | 'connected' | 'paused';
    accountMasked?: string;
    pauseReason?: string;
    inboundConfirmed?: boolean;
    accepted?: number;
    skipped?: boolean;
    lastLoginError?: string;
    lastLoginAt?: number;
    retryAt?: number;
};
export const getInstagramPrivateStatus = (businessId: number, signal?: AbortSignal) =>
    api.get(`/businesses/${businessId}/instagram-private`, { signal }).then(res => res.data as InstagramPrivateStatus);
export const loginInstagramPrivate = (businessId: number, credentials: { username: string; password: string; code?: string }) =>
    api.post(`/businesses/${businessId}/instagram-private/login`, credentials, { timeout: 60000 })
        .then(res => res.data as InstagramPrivateStatus);
export const pollInstagramPrivate = (businessId: number) =>
    api.post(`/businesses/${businessId}/instagram-private/poll`, {}, { timeout: 60000 })
        .then(res => res.data as InstagramPrivateStatus);
export const disconnectInstagramPrivate = (businessId: number) =>
    api.delete(`/businesses/${businessId}/instagram-private`).then(res => res.data as InstagramPrivateStatus);

// --- Legacy official Instagram connector (kept for existing bindings) ---
export type InstagramConnectorStatus = {
    success: boolean;
    configured: boolean;
    state: 'external_setup_required' | 'not_configured' | 'pending_webhook' | 'inbox_receiving' | 'webhook_stale';
    mode: 'manual_replies_only';
    prerequisites?: string[];
    igUserIdMasked?: string;
};
export const getInstagramStatus = (businessId: number, signal?: AbortSignal) =>
    api.get(`/businesses/${businessId}/instagram`, { signal }).then(res => res.data as InstagramConnectorStatus);
export const connectInstagram = (businessId: number, accessToken: string) =>
    api.post(`/businesses/${businessId}/instagram`, { access_token: accessToken }).then(res => res.data as InstagramConnectorStatus);
export const disconnectInstagram = (businessId: number) =>
    api.delete(`/businesses/${businessId}/instagram`).then(res => res.data as { success: boolean });

// --- Language ---
export const detectLanguage = (text: string) =>
    api.post('/language/detect', { text }).then(res => res.data);
export const translateText = (text: string, from: string, to: string, instanceId?: number) =>
    api.post('/language/translate', { text, from, to, instanceId }).then(res => res.data);

// --- Knowledge Base (RAG) ---
export interface NativeKnowledgeStatus {
    success: boolean;
    businessId: number;
    onyx: 'configured' | 'unavailable';
    documents: { id: number; state: string; submittedAt?: string }[];
}
export type CustomerKnowledgeChunk = { id: number; text: string; section: string | null };
export const getCustomerKnowledgeChunks = async (businessId: number, documentId: number, signal?: AbortSignal) => {
    const { data } = await api.get(`/businesses/${businessId}/knowledge/documents/${documentId}/chunks`, { signal, timeout: KNOWLEDGE_STATUS_TIMEOUT_MS });
    if (data.success !== true || data.businessId !== businessId || data.documentId !== documentId || !Array.isArray(data.chunks)
        || data.chunks.some((chunk: CustomerKnowledgeChunk) => !Number.isSafeInteger(chunk.id) || chunk.id < 1 || typeof chunk.text !== 'string' || (chunk.section !== null && typeof chunk.section !== 'string'))) throw new Error('Invalid document text');
    return data as { success: true; businessId: number; documentId: number; hash?: string; chunks: CustomerKnowledgeChunk[] };
};
export const updateCustomerKnowledgeChunk = async (businessId: number, documentId: number, chunkId: number, body: { text: string; section: string | null; expectedHash?: string }, signal?: AbortSignal) => {
    const { data } = await api.put(`/businesses/${businessId}/knowledge/documents/${documentId}/chunks/${chunkId}`, body, { signal, timeout: KNOWLEDGE_STATUS_TIMEOUT_MS });
    if (data.success !== true || data.businessId !== businessId || data.documentId !== documentId) throw new Error('Invalid document save');
    return data;
};
export const deleteNativeKnowledgeDocument = (businessId: number, documentId: number, signal?: AbortSignal) =>
    api.delete(`/businesses/${businessId}/knowledge/documents/${documentId}`,
        { signal, timeout: KNOWLEDGE_STATUS_TIMEOUT_MS }).then(res => res.data);
export const getNativeKnowledgeStatus = (businessId: number, signal?: AbortSignal) =>
    api.get<NativeKnowledgeStatus>(`/businesses/${businessId}/knowledge/native-status`,
        { signal, timeout: KNOWLEDGE_STATUS_TIMEOUT_MS }).then(res => res.data);

export const getKnowledgeBaseFiles = (instanceId: number, signal?: AbortSignal) =>
    api.get(`/knowledge-base/${instanceId}`, { signal, timeout: KNOWLEDGE_STATUS_TIMEOUT_MS }).then(res => res.data);

export const uploadKnowledgeBaseFiles = (instanceId: number, files: File[], signal?: AbortSignal) => {
    const formData = new FormData();
    files.forEach(f => formData.append('files', f));
    return api.post(`/knowledge-base/${instanceId}/upload`, formData, {
        signal, timeout: 90_000, headers: { 'X-AVA-Upload-Filename-Encoding': 'utf-8' }
    }).then(res => res.data);
};

export const uploadKnowledgeBaseFile = (instanceId: number, file: File) =>
    uploadKnowledgeBaseFiles(instanceId, [file]);

export const getUploadStatus = (instanceId: number, jobId: string, signal?: AbortSignal) =>
    api.get(`/knowledge-base/${instanceId}/upload-status/${encodeURIComponent(jobId)}`, { signal, timeout: KNOWLEDGE_STATUS_TIMEOUT_MS }).then(res => res.data);

export const deleteKnowledgeBaseFile = (instanceId: number, fileId: number) =>
    api.delete(`/knowledge-base/${instanceId}/${fileId}`).then(res => res.data);

export const searchKnowledgeBase = (instanceId: number, query: string, searchType: string = 'hybrid', k: number = 5, signal?: AbortSignal) =>
    api.post(`/knowledge-base/${instanceId}/search`, { query, searchType, k }, { signal, timeout: KNOWLEDGE_ANSWER_TIMEOUT_MS }).then(res => res.data);

export const getKnowledgeBaseStats = (instanceId: number) =>
    api.get(`/knowledge-base/${instanceId}/stats`).then(res => res.data);

export const rebuildKnowledgeBaseEmbeddings = (instanceId: number) =>
    api.post(`/knowledge-base/${instanceId}/rebuild-embeddings`).then(res => res.data);

export const getDocumentChunks = (instanceId: number, kbId: number) =>
    api.get(`/knowledge-base/${instanceId}/document/${kbId}/chunks`).then(res => res.data);

export const deleteChunk = (instanceId: number, chunkId: number) =>
    api.delete(`/knowledge-base/${instanceId}/chunks/${chunkId}`).then(res => res.data);

export const updateChunk = (instanceId: number, chunkId: number, text: string, section?: string) =>
    api.put(`/knowledge-base/${instanceId}/chunks/${chunkId}`, { text, section }).then(res => res.data);

export const getRAGAnalytics = (instanceId: number) =>
    api.get(`/knowledge-base/${instanceId}/analytics`).then(res => res.data);

export const migrateEmbeddings = (instanceId: number, dimensions: number) =>
    api.post(`/knowledge-base/${instanceId}/migrate-embeddings`, { dimensions }).then(res => res.data);

export const getDocumentVersions = (instanceId: number, originalName: string) =>
    api.get(`/knowledge-base/${instanceId}/versions/${encodeURIComponent(originalName)}`).then(res => res.data);

// --- Payments (YooKassa) ---
export const getPayments = (instanceId: number) =>
    api.get(`/payments/${instanceId}`).then(res => res.data);
export const createPayment = (instanceId: number, chatId: string, amount: number, description?: string) =>
    api.post(`/payments/${instanceId}/create`, { chatId, amount, description }).then(res => res.data);

// --- Revenue Forecast ---
export const getRevenueForecast = (instanceId: number) =>
    api.get(`/analytics/forecast/${instanceId}`).then(res => res.data);

// --- Barista Bot ---
export const getBaristaStaff = (instanceId: number) =>
    api.get(`/barista/staff/${instanceId}`).then(res => res.data);
export const deleteBaristaStaff = (instanceId: number, telegramChatId: string) =>
    api.delete(`/barista/staff/${instanceId}/${telegramChatId}`).then(res => res.data);
export const restartBaristaBot = (
    instanceId: number,
    settings?: { baristaBotToken?: string; baristaInviteCode?: string }
) => api.post(`/barista/restart/${instanceId}`, settings || {}).then(res => res.data);

// --- CoffeeOps ---
export const getCoffeeDashboard = (instanceId: number) =>
    api.get(`/coffee/${instanceId}/dashboard`).then(res => res.data);
export const getCoffeeOrderAnalytics = (instanceId: number, days = 30) =>
    api.get(`/coffee/${instanceId}/orders/analytics?days=${days}`).then(res => res.data);
export const getCoffeeItemAnalytics = (instanceId: number, days = 30) =>
    api.get(`/coffee/${instanceId}/items/analytics?days=${days}`).then(res => res.data);
export const getCoffeeClientInsights = (instanceId: number, chatId: string) =>
    api.get(`/coffee/${instanceId}/clients/${encodeURIComponent(chatId)}/insights`).then(res => res.data);
export const getCoffeeStopList = (instanceId: number, includeInactive = false) =>
    api.get(`/coffee/${instanceId}/stop-list${includeInactive ? '?includeInactive=1' : ''}`).then(res => res.data);
export const createCoffeeStopListItem = (instanceId: number, data: any) =>
    api.post(`/coffee/${instanceId}/stop-list`, data).then(res => res.data);
export const updateCoffeeStopListItem = (instanceId: number, itemId: number, data: any) =>
    api.put(`/coffee/${instanceId}/stop-list/${itemId}`, data).then(res => res.data);
export const deleteCoffeeStopListItem = (instanceId: number, itemId: number) =>
    api.delete(`/coffee/${instanceId}/stop-list/${itemId}`).then(res => res.data);
export const updateCoffeeOperationsMode = (instanceId: number, data: any) =>
    api.put(`/coffee/${instanceId}/operations-mode`, data).then(res => res.data);

// --- PMS / Bnovo Integration ---
export interface PmsIntegration {
    business_id: number;
    provider: string;
    enabled: boolean;
    mode: string;
    currency: string;
    masked_account: string | null;
    external_hotel_id: string | null;
    mappings?: {
        available_room_types?: { id: string; name: string }[];
        available_tariffs?: { id: string; name: string }[];
        capabilities?: {
            bookings?: boolean;
            booking_requests?: boolean;
            room_types?: boolean;
            tariffs?: boolean;
            availability?: boolean;
        };
        [key: string]: any;
    };
    connection_status: 'not_configured' | 'not_tested' | 'connected' | 'connected_limited' | 'error' | string;
    polling_status?: string;
    webhook_status?: string;
    last_sync_at?: string | null;
    last_successful_availability_at?: string | null;
    last_webhook_at?: string | null;
    last_error?: { code: string; message?: string } | null;
    credentials_configured: boolean;
    diagnostics?: any;
}

export interface PmsBooking {
    business_id: number;
    provider: string;
    booking_id: string;
    booking_number: string;
    status: string;
    arrival: string;
    departure: string;
    customer_name?: string;
    customer?: { name?: string | null; surname?: string | null };
    amount?: number;
    currency?: string;
}

export const getPmsIntegration = (businessId: number, signal?: AbortSignal) =>
    api.get(`/businesses/${businessId}/pms`, { signal, timeout: 30000 }).then(res => res.data as { success: boolean; businessId: number; pms: PmsIntegration | null });

export const configurePmsIntegration = (businessId: number, data: { account_id?: string | number; api_password?: string; external_hotel_id?: string; currency?: string; enabled?: boolean }, signal?: AbortSignal) =>
    api.put(`/businesses/${businessId}/pms`, data, { signal, timeout: 30000 }).then(res => res.data as { success: boolean; businessId: number; pms: PmsIntegration });

export const disconnectPmsIntegration = (businessId: number, signal?: AbortSignal) =>
    api.delete(`/businesses/${businessId}/pms`, { signal, timeout: 30000 }).then(res => res.data as { success: boolean; businessId: number; deleted: boolean });

export const testPmsIntegration = (businessId: number, signal?: AbortSignal) =>
    api.post(`/businesses/${businessId}/pms/test`, {}, { signal, timeout: 30000 }).then(res => res.data as { success: boolean; businessId: number; pms: PmsIntegration; capabilities?: any });

export const syncPmsIntegration = (businessId: number, signal?: AbortSignal) =>
    api.post(`/businesses/${businessId}/pms/sync`, {}, { signal, timeout: 30000 }).then(res => res.data as { success: boolean; businessId: number; queued: number });

export const connectPmsWebhooks = (businessId: number, publicBaseUrl?: string, signal?: AbortSignal) =>
    api.post(`/businesses/${businessId}/pms/webhooks`, { public_base_url: publicBaseUrl }, { signal, timeout: 30000 }).then(res => res.data as { success: boolean; businessId: number; pms: PmsIntegration });

export const getPmsBookings = (businessId: number, limit = 50, signal?: AbortSignal) =>
    api.get(`/businesses/${businessId}/pms/bookings`, { params: { limit }, signal, timeout: 30000 }).then(res => res.data as { success: boolean; businessId: number; bookings: PmsBooking[] });

export const getPmsBookingRequests = (businessId: number, limit = 50, signal?: AbortSignal) =>
    api.get(`/businesses/${businessId}/pms/booking-requests`, { params: { limit }, signal, timeout: 30000 }).then(res => res.data as { success: boolean; businessId: number; booking_requests: any[] });

export default api;
