import { useBusinessDate, utcDate, businessTimeZone } from '../businessTime';
import { customerDisplayName, formatCustomerPhone } from '../customerDisplay';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Brain, Clock3, MessageCircle, RefreshCw, UserRound } from 'lucide-react';
import { useInstance } from '../context/InstanceContext';
import { getPipeline } from '../businessProfiles';
import { useBusinessAccess } from '../permissions';
import { canOperateCustomer } from '../customerPermissions';
import { type WorkspaceMedia } from '../avaWorkspace';
import MediaAttachment from '../components/MediaAttachment';
import CustomerNameEditor from '../components/CustomerNameEditor';
import './CustomerIntelligence.css';
import CustomerIdentities from './CustomerIdentities';
import CustomerFollowups from './CustomerFollowups';
import CustomerCalls from './CustomerCalls';
import { channelLabel } from '../channelNames';

interface Customer {
    id: number;
    instanceId: number;
    chatId: string;
    assigneeUserId?: string | null;
    senderName: string;
    leadStatus: string;
    tags: string[];
    createdAt: string | null;
    updatedAt: string | null;
    lastMessageTime: string | null;
}

interface Message {
    id: number;
    senderName: string | null;
    messageType: string | null;
    content: string | null;
    role: string | null;
    timestamp: string | null;
    channel?: string | null;
    media?: WorkspaceMedia | null;
}

interface StatusChange {
    id: number;
    fromStatus: string | null;
    toStatus: string;
    createdAt: string | null;
}

interface SavedMemory {
    provenance: 'saved_ai_profile';
    interests: string[];
    objections: string[];
    importantDates: string[];
    keyFacts: string[];
    lastCallSummary: string | null;
    lastCallAt: string | null;
    lastProfileUpdate: string | null;
}

interface GeneratedMemory {
    provenance: 'ai_generated';
    status: 'ai_summary' | 'generation_pending' | 'policy_refresh_required' | 'unavailable';
    summary: string | null;
    interests: string[];
    objections: string[];
    importantDates: string[];
    sourceUpdatedAt: string | null;
    generatedAt: string | null;
    sourceComplete: boolean;
}

interface CustomerResponse {
    success: boolean;
    canonicalChatId?: string;
    client: Customer;
    messages: Message[];
    messageCount: number;
    messagesTruncated: boolean;
    statusHistory: StatusChange[];
    customerMemory: SavedMemory | null;
    generatedMemory: { conversation: GeneratedMemory | null; call: GeneratedMemory | null };
    messagePagination?: { hasMore: boolean; nextCursor: string | null; total: number; limit: number };
    customerContext?: {
        callBrief?: { request?: string | null; lastSummary?: string | null; nextAction?: string | null };
        memory?: { summary?: string | null; sourceUpdatedAt?: string | null; sourceComplete?: boolean };
        sources?: { type: string; timestamp?: string | null; text?: string; href?: string }[];
    };
    tasks?: { id?: string; taskId?: string; summary: string; status: string; dueAt?: string | null; assigneeUserId?: string | null; assigneeName?: string | null }[];
}

function MemoryList({ title, items }: { title: string; items: string[] }) {
    if (!items.length) return null;
    return <div className="customer-intelligence__memory-group">
        <h3>{title}</h3>
        <ul className="customer-intelligence__memory-tags">{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
    </div>;
}

function GeneratedMemoryBlock({ title, memory }: { title: string; memory: GeneratedMemory | null }) {
    const dateLabel = useBusinessDate();
    if (!memory) return null;
    return <div className="customer-intelligence__memory-block">
        <h3>{title}</h3>
        {memory.status === 'generation_pending'
            ? <p className="customer-intelligence__memory-note">Готовим итог общения. История уже доступна ниже.</p>
            : memory.status === 'policy_refresh_required'
                ? <p className="customer-intelligence__memory-note">Итог нужно обновить. Откройте историю, чтобы проверить договорённости.</p>
                : memory.status !== 'ai_summary'
                    ? <p className="customer-intelligence__memory-note">Не удалось получить итог. История общения доступна ниже.</p>
                    : <>
                        <p className="customer-intelligence__memory-note">AI-сводка, не проверенный факт. Источник: {dateLabel(memory.sourceUpdatedAt, true)} · Сформирована: {dateLabel(memory.generatedAt, true)}{!memory.sourceComplete && ' · Источник неполный'}</p>
                        {memory.summary && <p className="customer-intelligence__memory-summary">{memory.summary}</p>}
                        <MemoryList title="Интересы" items={memory.interests} />
                        <MemoryList title="Возражения" items={memory.objections} />
                        <MemoryList title="Важные даты" items={memory.importantDates} />
                        {!memory.summary && !memory.interests.length && !memory.objections.length && !memory.importantDates.length &&
                            <p className="customer-intelligence__memory-note">В этой сводке нет сведений о запросе клиента.</p>}
                    </>}
    </div>;
}

type TimelineItem =
    | { kind: 'message'; key: string; timestamp: string | null; message: Message }
    | { kind: 'status'; key: string; timestamp: string | null; status: StatusChange };

function messageRoleLabel(role: string | null | undefined): string {
    if (role === 'user') return 'Сообщение клиента';
    if (role === 'assistant') return 'Ответ ассистента';
    return 'Сообщение';
}

export default function CustomerIntelligence() {
    const { currentInstanceId } = useInstance();
    const { chatId } = useParams<{ chatId: string }>();
    const access = useBusinessAccess();
    return <ScopedCustomerIntelligence key={`${currentInstanceId}:${chatId}:${access.userId || 'session'}`} instanceId={currentInstanceId} />;
}

function ScopedCustomerIntelligence({ instanceId }: { instanceId: number | null }) {
    const dateLabel = useBusinessDate();
    const { chatId } = useParams<{ chatId: string }>();
    const [searchParams] = useSearchParams();
    const requestedDraftId = searchParams.get('followup')?.trim() || '';
    const { currentInstance } = useInstance();
    const access = useBusinessAccess();
    const [data, setData] = useState<CustomerResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [refreshKey, setRefreshKey] = useState(0);
    const [timelineLimit, setTimelineLimit] = useState(30);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyError, setHistoryError] = useState('');
    const [timelineFilter, setTimelineFilter] = useState<'all' | 'message' | 'status'>('all');
    const statusLabels = useMemo(() => Object.fromEntries(
        getPipeline(currentInstance).map(item => [item.id, item.label])
    ) as Record<string, string>, [currentInstance]);
    const statusName = useCallback((status: string | null | undefined) =>
        (status ? statusLabels[status] || 'Другой статус' : 'Не указан'), [statusLabels]);

    useEffect(() => {
        const controller = new AbortController();
        setError('');
        if (!instanceId || !chatId) {
            setLoading(false);
            return () => controller.abort();
        }
        setLoading(true);
        fetch(`/api/customer-intelligence/${instanceId}/${encodeURIComponent(chatId)}`, {
            credentials: 'same-origin', signal: controller.signal,
        })
            .then(async response => {
                if (response.status === 401) window.dispatchEvent(new Event('crm:unauthorized'));
                if (response.status === 403) window.dispatchEvent(new Event('crm:forbidden'));
                if (response.status === 401 || response.status === 403) setData(null);
                if (!response.ok) throw new Error(response.status === 404
                    ? 'Клиент не найден в выбранном бизнесе.'
                    : response.status === 403 ? 'Нет доступа к данным этого бизнеса.'
                        : 'Не удалось загрузить данные клиента.');
                const result = await response.json() as CustomerResponse;
                if (controller.signal.aborted) return;
                if (!result.success || result.client.instanceId !== instanceId || result.client.chatId !== (result.canonicalChatId || chatId)) {
                    throw new Error('Ответ не соответствует выбранному клиенту.');
                }
                setData(result);
            })
            .catch((cause: Error) => {
                if (cause.name !== 'AbortError') setError(cause instanceof TypeError || cause instanceof SyntaxError ? 'Не удалось загрузить данные клиента. Проверьте соединение и повторите.' : cause.message);
            })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [instanceId, chatId, refreshKey]);

    useEffect(() => { setTimelineLimit(30); }, [timelineFilter, chatId]);

    const timeline = useMemo<TimelineItem[]>(() => {
        if (!data) return [];
        const items: TimelineItem[] = [
            ...data.messages.map(message => ({ kind: 'message' as const, key: `message-${message.id}`, timestamp: message.timestamp, message })),
            ...data.statusHistory.map(status => ({ kind: 'status' as const, key: `status-${status.id}`, timestamp: status.createdAt, status })),
        ];
        return items.sort((a, b) => (utcDate(b.timestamp)?.getTime() || 0) - (utcDate(a.timestamp)?.getTime() || 0));
    }, [data]);
    const visibleTimeline = useMemo(() => timelineFilter === 'all'
        ? timeline : timeline.filter(item => item.kind === timelineFilter), [timeline, timelineFilter]);

    const loadEarlier = async () => {
        const cursor = data?.messagePagination?.nextCursor;
        if (!data || !cursor || historyLoading || !instanceId || !chatId) return;
        setHistoryLoading(true); setHistoryError('');
        try {
            const response = await fetch(`/api/customer-intelligence/${instanceId}/${encodeURIComponent(data.client.chatId)}?before=${encodeURIComponent(cursor)}&messageLimit=30`, { credentials: 'same-origin' });
            if (response.status === 401) window.dispatchEvent(new Event('crm:unauthorized'));
            if (response.status === 403) window.dispatchEvent(new Event('crm:forbidden'));
            if (response.status === 401 || response.status === 403) setData(null);
            const result = await response.json() as CustomerResponse;
            if (!response.ok || !result.success || result.client?.instanceId !== instanceId || result.client.chatId !== data.client.chatId || !Array.isArray(result.messages))
                throw new Error('Не удалось загрузить ранние сообщения. Повторите попытку; текущая история сохранена.');
            setData(previous => {
                if (!previous || previous.client.chatId !== result.client.chatId || previous.client.instanceId !== result.client.instanceId) return previous;
                const messages = [...new Map([...previous.messages, ...result.messages].map(message => [message.id, message])).values()];
                return { ...previous, messages, messagesTruncated: messages.length < previous.messageCount, messagePagination: result.messagePagination };
            });
            setTimelineLimit(value => value + 30);
        } catch { setHistoryError('Не удалось загрузить ранние сообщения. Повторите попытку; текущая история сохранена.'); }
        finally { setHistoryLoading(false); }
    };

    const readyMemories = [data?.generatedMemory?.conversation, data?.generatedMemory?.call].filter((memory): memory is GeneratedMemory => memory?.status === 'ai_summary' && Boolean(memory.summary));
    const fallbackSummaries = [
        ...readyMemories.map(memory => ({ text: memory.summary!, at: memory.sourceUpdatedAt, source: 'Итог общения AVA' })),
        ...(data?.customerMemory?.lastCallSummary ? [{ text: data.customerMemory.lastCallSummary, at: data.customerMemory.lastCallAt, source: 'Итог звонка AVA' }] : []),
    ].sort((a, b) => (utcDate(b.at)?.getTime() || 0) - (utcDate(a.at)?.getTime() || 0));
    const freshSummary = data?.customerContext?.memory?.summary || fallbackSummaries[0]?.text;
    const nextTask = data?.tasks?.filter(task => ['new', 'open', 'in_progress'].includes(task.status)).sort((a, b) => (utcDate(a.dueAt)?.getTime() || Infinity) - (utcDate(b.dueAt)?.getTime() || Infinity))[0];
    const request = data?.customerContext?.callBrief?.request;
    const agreement = freshSummary || data?.customerContext?.callBrief?.lastSummary;
    const nextAction = nextTask?.summary || data?.customerContext?.callBrief?.nextAction;
    const workspaceHref = `/today?client=${encodeURIComponent(data?.client.chatId || chatId || '')}`;

    return <section className="customer-intelligence">
        <nav className="customer-intelligence__back" aria-label="Навигация клиента">
            <Link to="/clients"><ArrowLeft size={17} aria-hidden="true" /> К клиентам</Link>
        </nav>

        <div className="customer-intelligence__heading">
            <div>
                <p className="customer-intelligence__eyebrow">КАРТОЧКА КЛИЕНТА</p>
                {data ? <CustomerNameEditor key={`${instanceId}:${data.client.chatId}`} businessId={instanceId!} chatId={data.client.chatId} name={data.client.senderName} canEdit={canOperateCustomer(access,data.client,'sales.write')} heading="h1" onSaved={name=>{setData(previous=>previous?{...previous,client:{...previous.client,senderName:name}}:previous);}} /> : <h1>Клиент</h1>}{data && formatCustomerPhone(undefined, data.client.chatId) && customerDisplayName(data.client.senderName, undefined, data.client.chatId) !== formatCustomerPhone(undefined, data.client.chatId) && <p className="customer-intelligence__phone">{formatCustomerPhone(undefined, data.client.chatId)}</p>}
                <p className="customer-intelligence__subtitle">Запрос, договорённости и следующий шаг в одном месте</p>
            </div>
            <button type="button" className="customer-intelligence__refresh" onClick={() => setRefreshKey(value => value + 1)} disabled={loading}>
                <RefreshCw size={17} aria-hidden="true" /> Обновить
            </button>
        </div>

        {!instanceId && <div className="customer-intelligence__notice" role="status">Сначала выберите бизнес.</div>}
        {loading && <div className="customer-intelligence__notice" role="status">{data ? 'Обновляем данные, ваша работа сохранена…' : 'Загружаем данные клиента…'}</div>}
        {error && <div className="customer-intelligence__notice customer-intelligence__notice--error" role="alert">{error} {data && 'Показаны ранее загруженные сведения.'} <button type="button" className="customer-intelligence__refresh" disabled={loading} onClick={() => setRefreshKey(value => value + 1)}>Повторить</button></div>}

        {data && <div className="customer-intelligence__layout">
            <section className="customer-intelligence__card customer-intelligence__context-card" aria-labelledby="customer-context-title">
                <h2 id="customer-context-title">Что происходит с клиентом</h2>
                <dl className="customer-intelligence__context">
                    <div><dt>Потребность</dt><dd>{request || 'Запрос отдельно не зафиксирован. Проверьте последнее обращение в истории.'}</dd></div>
                    <div><dt>Последняя договорённость</dt><dd>{agreement || 'Итог ещё не подготовлен. Сообщения и звонки доступны ниже.'}</dd></div>
                    <div><dt>Следующий шаг</dt><dd>{nextAction || 'Следующий шаг не назначен. Уточните его в рабочем дне.'}</dd>
                        {nextTask && <p className="customer-intelligence__caption">{nextTask.assigneeName ? `Ответственный: ${nextTask.assigneeName}` : nextTask.assigneeUserId ? 'Ответственный назначен' : 'Нужен ответственный'}{nextTask.dueAt ? ` · ${dateLabel(nextTask.dueAt, true)}` : ' · Без срока'}</p>}
                    </div>
                </dl>
                {agreement && <p className="customer-intelligence__memory-note">Итог AVA · {dateLabel(data.customerContext?.memory?.sourceUpdatedAt || fallbackSummaries[0]?.at, true)}. Перед действием проверьте важные условия в истории.</p>}
                <div className="customer-intelligence__filters"><Link className="customer-intelligence__refresh" to={workspaceHref}>{nextAction ? 'Выполнить следующий шаг' : 'Открыть рабочий день'}</Link><a className="customer-intelligence__refresh" href="#customer-followups-title">Подготовленные сообщения</a><a className="customer-intelligence__refresh" href="#customer-timeline-title">История общения</a></div>
            </section>
            <section className="customer-intelligence__card" aria-labelledby="customer-overview-title">
                <div className="customer-intelligence__section-title">
                    <UserRound size={19} aria-hidden="true" /><h2 id="customer-overview-title">Общие сведения</h2>
                </div>
                <dl className="customer-intelligence__facts">
                    <div><dt>Статус</dt><dd><span className="customer-intelligence__status">{statusName(data.client.leadStatus)}</span></dd></div>
                    <div><dt>Первое обращение</dt><dd>{dateLabel(data.client.createdAt)}</dd></div>
                    <div><dt>Последнее сообщение</dt><dd>{dateLabel(data.client.lastMessageTime, true)}</dd></div>
                    <div><dt>Сообщений в истории</dt><dd>{data.messageCount.toLocaleString('ru-RU')}</dd></div>
                </dl>
                {data.client.tags.length > 0 && <div className="customer-intelligence__tags" aria-label="Метки клиента">
                    {data.client.tags.map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}
                </div>}
            </section>

            <section className="customer-intelligence__card" aria-labelledby="customer-memory-title">
                <div className="customer-intelligence__section-title">
                    <Brain size={19} aria-hidden="true" /><h2 id="customer-memory-title">Сведения о клиенте</h2>
                </div>
                <details className="customer-intelligence__details"><summary>Потребности, важные даты и источники</summary>
                <p className="customer-intelligence__caption">AVA выделила эти сведения из общения. Уточняйте важные условия у клиента.</p>
                {!data.customerMemory
                    ? <p className="customer-intelligence__empty">Сохранённого профиля пока нет.</p>
                    : <>
                        <p className="customer-intelligence__memory-source">
                            Профиль обновлён: {dateLabel(data.customerMemory.lastProfileUpdate, true)} · AI-данные, не подтверждённые факты
                        </p>
                        <MemoryList title="Интересы" items={data.customerMemory.interests} />
                        <MemoryList title="Возражения" items={data.customerMemory.objections} />
                        <MemoryList title="Важные даты" items={data.customerMemory.importantDates} />
                        <MemoryList title="Ключевые сведения" items={data.customerMemory.keyFacts} />
                        {data.customerMemory.lastCallSummary && <div className="customer-intelligence__memory-group">
                            <h3>Последний звонок</h3>
                            <p className="customer-intelligence__memory-summary">{data.customerMemory.lastCallSummary}</p>
                            {data.customerMemory.lastCallAt && <p className="customer-intelligence__memory-note">Дата звонка: {dateLabel(data.customerMemory.lastCallAt, true)}</p>}
                        </div>}
                        {!data.customerMemory.interests.length && !data.customerMemory.objections.length && !data.customerMemory.importantDates.length && !data.customerMemory.keyFacts.length && !data.customerMemory.lastCallSummary &&
                            <p className="customer-intelligence__empty">В сохранённом профиле пока нет сведений для показа.</p>}
                    </>}
                <GeneratedMemoryBlock title="Сводка переписки" memory={data.generatedMemory?.conversation} />
                <GeneratedMemoryBlock title="Сводка звонков" memory={data.generatedMemory?.call} />
                </details>
            </section>

            <CustomerCalls timeZone={currentInstance?.hotelTimezone} key={`calls:${data.client.chatId}`} instanceId={instanceId!} chatId={data.client.chatId} refreshToken={refreshKey} />
            <CustomerFollowups key={`followups:${data.client.chatId}`} instanceId={instanceId!} chatId={data.client.chatId} customerName={data.client.senderName} refreshToken={refreshKey} requestedDraftId={requestedDraftId} />
            <CustomerIdentities key={`identities:${data.client.chatId}`} instanceId={instanceId!} chatId={data.client.chatId} customerName={data.client.senderName} refreshToken={refreshKey} assigneeUserId={data.client.assigneeUserId} onLinked={() => setRefreshKey(value => value + 1)} />

            <section className="customer-intelligence__card customer-intelligence__timeline-card" aria-labelledby="customer-timeline-title">
                <div className="customer-intelligence__section-title">
                    <Clock3 size={19} aria-hidden="true" /><h2 id="customer-timeline-title">История взаимодействий</h2><span className="customer-intelligence__caption">{businessTimeZone(currentInstance?.hotelTimezone)}</span>
                </div>
                <p className="customer-intelligence__caption">Сообщения и изменения статуса, сохранённые в CRM.</p>
                {(data.messagePagination?.hasMore || data.messagesTruncated) && <p className="customer-intelligence__limit">Загружено {data.messages.length.toLocaleString('ru-RU')} сообщений из {data.messageCount.toLocaleString('ru-RU')}.{!data.messagePagination && <> Более раннюю историю можно проверить в <Link to={workspaceHref}>рабочем дне</Link>.</>}</p>}
                <div className="customer-intelligence__filters" role="group" aria-label="Фильтр истории">
                    <button type="button" aria-pressed={timelineFilter === 'all'} onClick={() => setTimelineFilter('all')}>
                        Всё <span>{data.messages.length + data.statusHistory.length}</span>
                    </button>
                    <button type="button" aria-pressed={timelineFilter === 'message'} onClick={() => setTimelineFilter('message')}>
                        Сообщения <span>{data.messages.length}</span>
                    </button>
                    <button type="button" aria-pressed={timelineFilter === 'status'} onClick={() => setTimelineFilter('status')}>
                        Статусы <span>{data.statusHistory.length}</span>
                    </button>
                </div>
                {visibleTimeline.length === 0
                    ? <p className="customer-intelligence__empty">{timeline.length === 0 ? 'История пока пуста.' : 'Нет записей этого типа.'}</p>
                    : <ol className="customer-intelligence__timeline" tabIndex={0} aria-label="История взаимодействий, прокручиваемый список">
                        {visibleTimeline.slice(0, timelineLimit).map(item => <li key={item.key} className="customer-intelligence__event">
                            <span className="customer-intelligence__event-icon" aria-hidden="true">
                                {item.kind === 'message' ? <MessageCircle size={16} /> : <Clock3 size={16} />}
                            </span>
                            <div className="customer-intelligence__event-body">
                                <div className="customer-intelligence__event-head">
                                    <strong>{item.kind === 'message'
                                        ? messageRoleLabel(item.message.role)
                                        : `Статус: ${statusName(item.status.toStatus)}`}</strong>
                                    <time dateTime={item.timestamp || undefined}>{dateLabel(item.timestamp, true)}</time>
                                </div>
                                {item.kind === 'message'
                                    ? <><span className="customer-intelligence__channel">{channelLabel(item.message.channel)}</span>
                                        <p className="customer-intelligence__message">{item.message.content?.trim() || 'Сообщение без текста'}</p>
                                        {item.message.media && instanceId && <MediaAttachment
                                            media={item.message.media}
                                            businessId={instanceId}
                                            chatId={data.client.chatId}
                                            messageId={item.message.id}
                                            canRetry={Boolean(canOperateCustomer(access, data.client, 'sales.write') && item.message.media.canRetry)}
                                            onRetried={() => setRefreshKey(value => value + 1)}
                                        />}</>
                                    : <p className="customer-intelligence__status-note">{statusName(item.status.fromStatus)} → {statusName(item.status.toStatus)}</p>}
                            </div>
                        </li>)}
                    </ol>}
                {visibleTimeline.length > timelineLimit && <button type="button" className="customer-intelligence__refresh" onClick={() => setTimelineLimit(value => value + 30)}>Показать ещё ({visibleTimeline.length - timelineLimit})</button>}
                {visibleTimeline.length <= timelineLimit && timelineFilter !== 'status' && data.messagePagination?.hasMore && data.messagePagination.nextCursor && <button type="button" className="customer-intelligence__refresh" disabled={historyLoading} onClick={() => void loadEarlier()}>{historyLoading ? 'Загружаем…' : 'Показать предыдущие сообщения'}</button>}
                {historyError && <p role="alert" className="customer-intelligence__notice--error">{historyError}</p>}
            </section>
        </div>}
    </section>;
}
