import { api } from './api';
import type { SalesTask, SalesView } from './teamSales';

export type ScopedResponse = { success: boolean; businessId: number; capabilities?: string[]; currentUserId?: string };
export type WorkspaceRow = { chatId: string; name: string; assigneeUserId: string | null; assigneeName: string | null; status: string; controlMode: 'ai' | 'human'; reasons: { code: string; label: string; sourceId?: string | number | null; dueAt?: string | null }[]; nextAction: string | null; lastContactAt: string | null };
export type WorkspaceResponse = ScopedResponse & { view: SalesView; summary: { needsHuman: number; overdue: number; unassigned: number; aiActive: number }; items: WorkspaceRow[]; pagination: { page: number; pageSize: number; total: number } };
export type PromiseItem = { id: string; chatId: string; summary: string; status: 'open' | 'done' | 'cancelled'; dueAt: string | null; deadlineUnresolved?: boolean; duePrecision?: 'day' | 'instant' | null; assigneeUserId: string | null; sourceType: string; sourceId: string | number | null; sourceText: string | null; sourceOffset?: number | null; revision: number; createdAt: string };
export type Control = { mode: 'ai' | 'human'; revision: number; reason: string | null; updatedAt: string; sendInProgress?:boolean; sendStatus?:string };
export type ReleaseFlags = { workspace: boolean; analytics: boolean; autopilot: boolean };
export type ReleaseFlagsResponse = ScopedResponse & { revision: number; flags: ReleaseFlags; availability?: Partial<ReleaseFlags> };
export type WorkspaceMedia = {
    providerMessageId: string;
    messageId?: number | string;
    kind: 'image' | 'audio' | 'unsupported';
    status: 'pending' | 'ready' | 'failed';
    caption?: string;
    recognizedText?: string | null;
    errorCode?: string | null;
    downloaded?: boolean;
    mimeType?: string | null;
    byteLength?: number | null;
    canRetry?: boolean;
    label: string;
    detail?: string | null;
    mediaUrl?: string;
};
export type WorkspaceMessage = { id: string | number; role: string; senderName?: string | null; authorType?:'human'|'ai'|'team'|'client'; content: string; timestamp: string; channel: string; media?: WorkspaceMedia | null };
export type WorkspaceCall = { id: string | number; callId?: string; timestamp: string; summary?: string; durationSeconds?: number; transcript?: string; sourceLink?: string };
export type MessagePagination = { hasMore: boolean; nextCursor: string | null; total: number; limit: number };
export type ReplyRecoveryResponse = ScopedResponse & { chatId: string; canResolve: boolean; action: null | { id: string; status: string; text: string | null; textHash: string; userId: string; createdAt: string; updatedAt: string; messageId?: number | null; abandonedDispatch?: boolean; resolution?: unknown }; evidence: { messageId: number; kind: string; createdAt?: string }[]; history: unknown[]; control: Control };
export type WorkspaceClientResponse = ScopedResponse & { channelAccess?:{channel:'avito';code:'AVITO_CHAT_SUBSCRIPTION_REQUIRED'|'AVITO_CHAT_UNAVAILABLE'}|null; dialogueRevision?: string; timezone?: string; messagePagination?: MessagePagination; callPagination?: MessagePagination; callBrief?: {request:string|null;lastSummary:string|null;objections:string[];nextAction:string|null}; client: { chatId: string; name: string; status: string; assigneeUserId: string | null; phone?: string | null }; control: Control; messages: WorkspaceMessage[]; calls: WorkspaceCall[]; tasks: SalesTask[]; deals: { id: string; title: string; stage: string; amount?: number; currency?: string; nextAction?: string; nextActionAt?: string | null }[]; promises: PromiseItem[]; memory: { sources?:{sourceId:string;type:string;timestamp:string|null;text:string;href:string}[]; summary: string | null; keyFacts: string[]; objections: string[]; sourceUpdatedAt: string | null; sourceComplete: boolean } };
export type SearchResult = { id: string; type: 'client' | 'deal' | 'message' | 'call'; title: string; snippet: string; chatId?: string; href: string; sourceId?: string | number };
export type SavedView = { id: string; name: string; filters: { view: SalesView; query?: string; channel?: string } };
export type Offer = { id: string; name: string; description: string; amountMinor: number; currency: string; terms: string; active: boolean; revision: number; publishedAt?: string | null };
export type Quote = { id: string; chatId: string; offerId: string; offerRevision: number; quantity: number; totalMinor: number; currency: string; text: string; status: 'draft' | 'sent' | 'failed' | 'unknown'; revision: number; createdAt: string };
export type Policy = { activated?: boolean; id: string; revision: number; state: 'draft' | 'published' | 'paused'; enabled: boolean; scenarioIds: string[]; allowedActions: string[]; dailyMessageLimit: number; dailyTokenLimit: number; dailyVoiceSecondsLimit: number; responseDeadlineMinutes: number; workDays: number[]; timezone: string; workHours: { start: string; end: string }; routing: { enabled: boolean; memberIds: string[] }; publishedAt?: string | null };
export type Simulation = { id: string; policyRevision: number; passed: boolean; cases: { id: string; name: string; passed: boolean; reason: string }[]; createdAt: string; comparison?: { previousId?: string; previousPassed?: boolean; changedCases: string[] } | null };
export type Usage = { requests: number; tokens: number | null; voiceSeconds: number | null; estimatedCost: number | null; currency: string; actions: number; handovers: number; periodStart: string };
export type AutopilotAction = { id: string; eventId?: string; chatId?: string; action?: string; type?: string; kind?: string; status: string; reason?: string | null; policyRevision?: number; createdAt?: string; result?: { status?: string; messageId?: string } | null };
export type AutopilotResponse = ScopedResponse & { policy: Policy | null; humanPausedCount?: number; replyReadiness?: {mode:'legacy'|'published'|'paused';reason:string|null}; channelCapabilities?: Record<string,{supportedAutopilot:boolean}>; simulation?: Simulation | null; usageNotes?: {tokens?:string;cost?:string;voiceLimit?:string}; templates: { id: string; name: string; description: string }[]; usage: Usage; actions: AutopilotAction[]; policyHistory?: { revision: number; state: string; enabled: boolean; publishedAt?: string | null }[] };
export type WorkspaceAnalyticsResponse = ScopedResponse & { metrics: { stageCounts: Record<string, number> | { stage: string; count: number }[]; transitions: number | { fromStage?: string; toStage?: string; count?: number; createdAt?: string }[]; winRate: number | null; averageCycleDays: number | null; historyComplete: boolean; lossReasons?: {reason:string;count:number}[]; trackedDeals?: number; totalDeals?: number; closedSampleSize?: number }; workload: { userId: string; name: string; openTasks: number; overdueTasks: number }[]; risks: { chatId: string; dealId?: string; title: string; reasons: string[]; href: string }[]; lossReasons?:{dealId:string;title:string;reason:string|null;href:string}[]; quality: { method?: string; note?: string; checkedMessages?: number; checkedCalls?: number; sampleComplete?: boolean; cases: { criterion: string; result: 'met' | 'not_met' | 'insufficient'; evidence: { sourceId: string | number; text: string; href: string }[] }[] }; knowledgeSuggestions: { id: string; question: string; sourceId: string | number; href: string }[]; usage?: Usage };

export async function workspaceRequest<T extends ScopedResponse>(businessId: number, path: string, method: 'get' | 'post' | 'put' | 'patch' | 'delete' = 'get', data?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await api.request<T>({ url: `/businesses/${businessId}${path}`, method, data, signal, timeout: method === 'get' ? 15000 : 45000 });
    if (!response.data.success || response.data.businessId !== businessId) throw Object.assign(new Error('Scoped response rejected'), { code: 'WORKSPACE_RESPONSE_INVALID' });
    return response.data;
}
export async function getReleaseFlags(id: number, signal?: AbortSignal) {
    const result = await workspaceRequest<ReleaseFlagsResponse>(id, '/release-flags', 'get', undefined, signal);
    if (!Number.isSafeInteger(result.revision) || result.revision < 0 || !result.flags || ['workspace','analytics','autopilot'].some(key => typeof result.flags[key as keyof ReleaseFlags] !== 'boolean')) throw Object.assign(new Error('Invalid release flags'), { code: 'WORKSPACE_RESPONSE_INVALID' });
    return result;
}
export const getWorkday = (id: number, view: SalesView, page: number, signal?: AbortSignal, channel?: string) => workspaceRequest<WorkspaceResponse>(id, `/workspace?view=${view}&page=${page}&pageSize=30${channel ? `&channel=${encodeURIComponent(channel)}` : ''}`, 'get', undefined, signal);
export const getClientWorkspace = (id: number, chatId: string, signal?: AbortSignal, history?: { before?: string; messageLimit?: number; callBefore?: string; callLimit?: number }) => {
    const query = new URLSearchParams();
    if (history?.before) query.set('before', history.before);
    if (history?.messageLimit) query.set('messageLimit', String(history.messageLimit));
    if (history?.callBefore) query.set('callBefore', history.callBefore);
    if (history?.callLimit) query.set('callLimit', String(history.callLimit));
    return workspaceRequest<WorkspaceClientResponse>(id, `/workspace/clients/${encodeURIComponent(chatId)}${query.size ? `?${query}` : ''}`, 'get', undefined, signal);
};
export async function getReplyTemplate(id: number, templateId: number, signal?: AbortSignal): Promise<{ id: number; text: string }> {
    const response = await api.get(`/templates/${id}`, { signal, timeout: 15000 });
    const data = response.data as { success: boolean; templates?: { id: number; instanceId: number; text: string }[] };
    const template = data.templates?.find(item => item.id === templateId && item.instanceId === id);
    if (!data.success || !template || typeof template.text !== 'string') throw Object.assign(new Error('Template unavailable'), { code: 'WORKSPACE_TEMPLATE_UNAVAILABLE' });
    return template;
}
export type StudioHandoffResponse = ScopedResponse & {
    dealId: string | number;
    material: { revision: number; text: string };
    composer: { businessId: number; chatId: string; text: string; materialRevision: number; requiresHumanConfirmation: true };
};
export async function getStudioHandoff(businessId: number, dealId: string, revision: number, chatId: string, signal?: AbortSignal) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw Object.assign(new Error('Invalid Studio material revision'), { code: 'WORKSPACE_RESPONSE_INVALID' });
    const result = await workspaceRequest<StudioHandoffResponse>(businessId, `/studio/proposals/${encodeURIComponent(dealId)}/handoff?revision=${revision}`, 'get', undefined, signal);
    if (String(result.dealId) !== dealId
        || !result.material || result.material.revision !== revision || typeof result.material.text !== 'string'
        || !result.composer || result.composer.businessId !== businessId || result.composer.chatId !== chatId
        || result.composer.materialRevision !== revision || result.composer.requiresHumanConfirmation !== true
        || result.composer.text !== result.material.text) throw Object.assign(new Error('Studio handoff scope or revision mismatch'), { code: 'WORKSPACE_RESPONSE_INVALID' });
    return result;
}
export const getReplyRecovery = (id: number, chatId: string, signal?: AbortSignal) => workspaceRequest<ReplyRecoveryResponse>(id, `/workspace/clients/${encodeURIComponent(chatId)}/reply-recovery`, 'get', undefined, signal);
export const resolveReplyRecovery = (id: number, chatId: string, input: { actionId: string; outcome: 'sent' | 'failed'; confirmation: true; reason: string; evidenceMessageId?: number }, signal?: AbortSignal) => workspaceRequest<ReplyRecoveryResponse>(id, `/workspace/clients/${encodeURIComponent(chatId)}/reply-recovery`, 'post', input, signal);
export const retryWorkspaceMedia = (id: number, chatId: string, messageId: number | string, signal?: AbortSignal) =>
    workspaceRequest<ScopedResponse & { chatId: string; messageId: number; content: string; media: WorkspaceMedia }>(
        id,
        `/workspace/clients/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(String(messageId))}/media/retry`,
        'post',
        {},
        signal
    );
export const searchWorkspace = (id: number, query: string, signal?: AbortSignal) => workspaceRequest<ScopedResponse & { results: SearchResult[] }>(id, `/search?q=${encodeURIComponent(query)}&limit=20`, 'get', undefined, signal);
export const getSavedViews = (id: number, signal?: AbortSignal) => workspaceRequest<ScopedResponse & { views: SavedView[] }>(id, '/saved-views', 'get', undefined, signal);
export const getAutopilot = (id: number, signal?: AbortSignal) => workspaceRequest<AutopilotResponse>(id, '/autopilot', 'get', undefined, signal);
export const getCatalog = (id: number, signal?: AbortSignal) => workspaceRequest<ScopedResponse & { offers: Offer[] }>(id, '/catalog', 'get', undefined, signal);
export const getQuotes = (id: number, chatId: string, signal?: AbortSignal) => workspaceRequest<ScopedResponse & { quotes: Quote[] }>(id, `/quotes?chatId=${encodeURIComponent(chatId)}`, 'get', undefined, signal);
export const getWorkspaceAnalytics = (id: number, days: number, signal?: AbortSignal) => workspaceRequest<WorkspaceAnalyticsResponse>(id, `/workspace/analytics?days=${days}`, 'get', undefined, signal);
export function requestKey() { return globalThis.crypto?.randomUUID?.() || `ava-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
export function sourceHref(href: string | undefined, fallback = '/') {
    const target = href?.startsWith('/') && !href.startsWith('//') && !href.includes('\\') && Array.from(href).every(character => character.charCodeAt(0) >= 32) ? href : fallback;
    if (target.startsWith('/?')) {
        const params = new URLSearchParams(target.slice(2).split('#')[0]);
        if (params.has('client') || params.has('source')) return `/today${target.slice(1)}`;
    }
    return target;
}
export function promiseDueLabel(item: Pick<PromiseItem, 'dueAt' | 'duePrecision' | 'deadlineUnresolved'>, timezone = 'Europe/Moscow') {
    if (!item.dueAt) return item.deadlineUnresolved ? 'Нужно уточнить срок' : 'Срок не указан';
    const date = new Date(item.dueAt); if (!Number.isFinite(date.getTime())) return 'Дата недоступна';
    try { return new Intl.DateTimeFormat('ru-RU', item.duePrecision === 'day' ? { dateStyle: 'medium', timeZone: timezone } : { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(date); } catch { return 'Дата недоступна'; }
}
export function actionReasonLabel(reason: string | null | undefined) {
    if (!reason) return '';
    const labels: Record<string,string> = { missing_price:'Нет опубликованной цены — передано менеджеру', proposal_not_allowed:'Предложение требует менеджера', unclear_date:'Срок нужно уточнить', human_requested:'Клиент попросил менеджера', human_request:'Клиент попросил менеджера', complaint:'Жалоба передана менеджеру', limit:'Лимит исчерпан', quota:'Лимит исчерпан', human_control:'Менеджер управляет разговором', tenant_injection:'Запрос чужих данных остановлен', durable_unique_claim:'Повтор события остановлен', unknown_never_replayed:'Повторная отправка при неизвестном результате остановлена', mocked_dispatch:'Проверено на тестовом канале', manual_quote:'Менеджер отправил предложение', manual_reply:'Менеджер ответил клиенту', AUTOPILOT_DISABLED:'Автопилот выключен', AUTOPILOT_REVISION_CONFLICT:'Правила изменились', WORKSPACE_HUMAN_CONTROL:'Разговор у менеджера', AUTOPILOT_MESSAGE_LIMIT:'Лимит сообщений исчерпан', AUTOPILOT_TOKEN_LIMIT:'Лимит токенов исчерпан', WORKSPACE_CONTROL_CONFLICT:'Управление разговором изменилось' };
    return labels[reason] || 'Действие проверено по правилам бизнеса';
}

export function controlReasonLabel(reason:string|null|undefined) { if(!reason)return 'Режим управления разговором'; return /^[A-Za-z][A-Za-z0-9_]+$/.test(reason) ? actionReasonLabel(reason) : reason; }

export function moneyMinor(amount: number, currency: string) {
    if (!Number.isFinite(amount)) return '—';
    try { return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount / 100); } catch { return `${(amount / 100).toLocaleString('ru-RU')} ${currency}`; }
}
export const stageLabel = (stage: string) => (({ new: 'Новые', qualified: 'Квалификация', proposal: 'Предложение', negotiation: 'Переговоры', won: 'Успешно', lost: 'Не состоялась' } as Record<string, string>)[stage] || stage);
export const deliveryLabel = (status: string) => (({ draft: 'Черновик', sent: 'Отправлено', failed: 'Ошибка отправки', unknown: 'Результат уточняется', pending: 'В очереди', sending: 'Отправляется', done: 'Выполнено', succeeded: 'Выполнено', completed: 'Выполнено', handed_off: 'Передано менеджеру', skipped: 'Пропущено', blocked: 'Остановлено' } as Record<string, string>)[status] || status);
export function workspaceError(error: unknown, fallback = 'Не удалось выполнить действие. Повторите после обновления.') {
    const value = error as { response?: { data?: { code?: string } }; code?: string };
    const code = value.response?.data?.code || value.code || '';
    const errors: Record<string, string> = {
        KNOWLEDGE_REVIEW_REVISION_CONFLICT: 'Ответ уже изменён. Обновите данные, сохранив свой текст.',
        KNOWLEDGE_REVIEW_CHECK_REQUIRED: 'Сначала проверьте текущую версию ответа.',
        KNOWLEDGE_REVIEW_SOURCE_CHANGED: 'Источник обращения изменился. Обновите данные.',
        KNOWLEDGE_REVIEW_KNOWLEDGE_CHANGED: 'База знаний изменилась. Повторите проверку ответа.',
        KNOWLEDGE_REVIEW_AI_TIMEOUT: 'Подготовка или проверка ответа заняла слишком много времени. Попробуйте снова.',
        KNOWLEDGE_REVIEW_AI_UNAVAILABLE: 'Помощник временно недоступен. Попробуйте позже.',
        KNOWLEDGE_REVIEW_NO_AUTHORITY: 'В базе знаний недостаточно сведений для проверки ответа.',
        KNOWLEDGE_REVIEW_CONFIRMATION_REQUIRED: 'Подтвердите публикацию или восстановление ответа.',
        WORKSPACE_DIALOGUE_CHANGED: 'Разговор изменился. Обновите его перед отправкой. Ваш текст сохранён.',
        COPILOT_CONTEXT_CHANGED: 'Разговор изменился. Обновите его и подготовьте новую подсказку.',
        COPILOT_TIMEOUT: 'Подготовка ответа заняла слишком много времени. Попробуйте снова.',
        COPILOT_KNOWLEDGE_EMPTY: 'В базе знаний пока недостаточно сведений для ответа.',
        COPILOT_CATALOG_EMPTY: 'Сначала опубликуйте предложение в каталоге.',
        COPILOT_AI_NOT_CONFIGURED: 'Для подсказок нужно настроить помощника бизнеса.',
        WORKSPACE_FEATURES_REVISION_CONFLICT: 'Настройки изменились. Обновите их перед сохранением.',
        WORKSPACE_FEATURE_DISABLED: 'Эта функция сейчас отключена для бизнеса.',
        WORKSPACE_FEATURES_INPUT_INVALID: 'Проверьте настройки функций.',
        AVAILABILITY_REVISION_CONFLICT: 'Статус сотрудника изменился. Обновите данные.',
        WORKSPACE_CONTROL_CONFLICT: 'Управление разговором изменилось. Обновите данные и повторите действие.',
        WORKSPACE_TEMPLATE_UNAVAILABLE: 'Шаблон недоступен в выбранном бизнесе. Выберите другой быстрый ответ.',
        WORKSPACE_RECOVERY_RESOLVE_DENIED: 'Подтвердить результат может только владелец или руководитель.',
        WORKSPACE_RECOVERY_CONFLICT: 'Состояние отправки уже изменилось. Обновите проверку.',
        WORKSPACE_RECOVERY_EVIDENCE_INVALID: 'Данные канала не относятся к этой отправке. Обновите проверку.',
        WORKSPACE_RECOVERY_EVIDENCE_CONFLICT: 'Данные канала подтверждают отправку. Выберите соответствующий результат.',
        WORKSPACE_RECOVERY_NOT_FOUND: 'Эта попытка отправки больше недоступна. Обновите проверку.',
        WORKSPACE_REPLY_RECOVERY_CONFLICT: 'Результат уже уточнён другим сотрудником. Обновите данные.',
        WORKSPACE_REPLY_RECOVERY_INPUT_INVALID: 'Укажите результат, причину и подтверждение проверки.',
        WORKSPACE_HISTORY_CURSOR_INVALID: 'Ссылка на историю устарела. Обновите историю клиента.',
        SALES_CLIENT_ASSIGNED: 'Клиента уже взял другой сотрудник. Обновите очередь.',
        SALES_TASK_ASSIGNED: 'Задачу уже взял другой сотрудник. Обновите список.',
        WORKSPACE_SEND_IN_PROGRESS: 'Предыдущая отправка ещё уточняется. Повторная отправка заблокирована.',
        WORKSPACE_REPLY_FAILED: 'Канал не принял сообщение. Текст сохранён. Проверьте подключение перед новой попыткой.',
        AVITO_CHAT_SUBSCRIPTION_REQUIRED: 'Авито не принял сообщение: для этого диалога нужна подписка с API мессенджера. Проверьте подписку в кабинете Авито. Текст сохранён.',
        AVITO_CHAT_UNAVAILABLE: 'Авито не предоставляет доступ к этому диалогу. Проверьте его в кабинете Авито. Текст сохранён.',
        SALES_CLIENT_CLAIM_REQUIRED: 'Сначала возьмите клиента в работу.',
        SALES_CLIENT_SCOPE_DENIED: 'Клиент назначен другому сотруднику. Обновите очередь.',
        CAPABILITY_DENIED: 'Ваши права изменились. Доступ будет обновлён.', BUSINESS_ACCESS_DENIED: 'Доступ к этому бизнесу изменился.',
        WORKSPACE_PROMISE_CONFLICT: 'Обещание уже изменилось. Обновите данные.', AUTOPILOT_REVISION_CONFLICT: 'Правила уже изменены. Обновите данные.', QUALITY_REVISION_CONFLICT: 'Критерии изменились. Обновите их перед сохранением.', QUALITY_CRITERIA_INVALID: 'Проверьте названия и фразы критериев.', AUTOPILOT_INPUT_INVALID: 'Проверьте правила, лимиты и выбранных сотрудников.', AUTOPILOT_PUBLISHED_OFFER_REQUIRED: 'Сначала опубликуйте предложение в каталоге.', AUTOPILOT_QUOTE_OFFER_CHANGED: 'Цена или условия изменились. Подготовьте новое предложение.', WORKSPACE_INPUT_INVALID: 'Проверьте введённые данные и срок.', AUTOPILOT_CHANNEL_UNSUPPORTED: 'Этот канал пока не поддерживает отправку предложения.', AUTOPILOT_POLICY_CONFLICT: 'Политика уже изменена. Обновите её перед сохранением.',
        AUTOPILOT_SIMULATION_REQUIRED: 'Проверьте текущую версию политики в лаборатории перед публикацией.',
        AUTOPILOT_SIMULATION_FAILED: 'Проверка сценариев не пройдена. Исправьте настройки и повторите её.',
        CATALOG_OFFER_CONFLICT: 'Предложение уже изменено. Обновите каталог.', CATALOG_OFFER_NOT_PUBLISHED: 'Сначала опубликуйте предложение в каталоге.',
        WORKSPACE_CHANNEL_UNSUPPORTED: 'Этот канал не поддерживает отправку из AVA.', WORKSPACE_RESPONSE_INVALID: 'Источник вернул данные другого бизнеса или некорректный ответ.',
        AVA_RELEASE_REVISION_CONFLICT: 'Переключатели изменились. Обновите их и повторите сохранение.',
        AVA_RELEASE_NOT_AVAILABLE: 'Эта функция пока недоступна для выбранного бизнеса.',
        AVA_RELEASE_UNAVAILABLE: 'Не удалось загрузить переключатели выпуска. Повторите позже.',
        AVA_FEATURE_DISABLED: 'Владелец отключил эту функцию для бизнеса.',
        RELEASE_FLAGS_REVISION_CONFLICT: 'Переключатели изменились. Обновите их и повторите сохранение.',
        BUSINESS_FEATURE_DISABLED: 'Владелец отключил эту функцию для бизнеса.',
        AUTOPILOT_LIMIT_REACHED: 'Лимит автопилота исчерпан.', QUOTE_DELIVERY_PENDING: 'Результат отправки предложения уточняется. Не отправляйте его повторно.',
        AI_TIMEOUT: 'Распознавание вложения заняло слишком много времени. Попробуйте ещё раз или ответьте клиенту вручную.',
        AI_UNAVAILABLE: 'Сервис распознавания вложений временно недоступен. Попробуйте позже или ответьте вручную.',
        AI_AUTH_UNAVAILABLE: 'Авторизация AI временно недоступна. Повторите попытку позже.',
        WHATSAPP_MEDIA_AI_INVALID: 'Не удалось разобрать ответ модели по вложению. Повторите распознавание.',
        WHATSAPP_MEDIA_UNAVAILABLE: 'Не удалось скачать вложение из канала WhatsApp. Проверьте подключение и повторите попытку.',
        WHATSAPP_MEDIA_CONNECTION_UNAVAILABLE: 'Сессия WhatsApp переподключена или недоступна. Проверьте подключение канала.',
        WHATSAPP_MEDIA_EXPIRED: 'Вложение больше недоступно в WhatsApp. Попросите клиента отправить файл повторно.',
        WHATSAPP_MEDIA_TOO_LARGE: 'Файл превышает допустимый размер 10 МБ.',
        WHATSAPP_MEDIA_TOO_LONG: 'Голосовое сообщение длиннее трёх минут.',
        WHATSAPP_MEDIA_CORRUPT: 'Файл повреждён или имеет неподдерживаемый формат.',
        WHATSAPP_MEDIA_TYPE_MISMATCH: 'Формат файла не совпадает с типом вложения.',
        WHATSAPP_MEDIA_TYPE_UNSUPPORTED: 'Этот тип вложения не распознаётся автоматически.',
        WHATSAPP_MEDIA_MODEL_UNSUPPORTED: 'Для распознавания вложений требуется модель Gemini.',
        WHATSAPP_MEDIA_NOT_FOUND: 'Вложение не найдено.',
    };
    return errors[code] || fallback;
}
