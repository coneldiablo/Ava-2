import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Activity as ActivityIcon, ClipboardList, MessageCircle, PhoneCall, RefreshCw, Send, UserRound } from 'lucide-react';
import { useInstance } from '../context/InstanceContext';
import { useAuth } from '../context/AuthContext';
import { canAccessRoute } from '../permissions';
import './Activity.css';

interface ActivityEvent {
    id: string;
    type: 'message' | 'status' | 'task' | 'followup' | 'call';
    chatId?: string | null;
    title: string;
    detail: string;
    senderName?: string | null;
    messageType?: string;
    occurredAt: string | null;
}

interface ActivityResponse { success: boolean; businessId: number; events: ActivityEvent[]; callHistoryStatus: 'ready' | 'unavailable' | 'not_requested' }
type Filter = 'all' | ActivityEvent['type'];

function formatDate(value: string | null): string {
    if (!value) return 'Время не указано';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Время не указано' : date.toLocaleString('ru-RU', {
        day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    });
}

export default function Activity() {
    const { currentInstanceId, currentInstance } = useInstance();
    return <ScopedActivity key={currentInstanceId ?? 'none'} businessId={currentInstanceId} businessName={currentInstance?.name || ''} />;
}

function ScopedActivity({ businessId, businessName }: { businessId: number | null; businessName: string }) {
    const [params] = useSearchParams();
    const auth = useAuth();
    const canViewAnalytics = canAccessRoute(auth, businessId, '/analytics');
    const [limit, setLimit] = useState(50);
    const [visibleCount, setVisibleCount] = useState(20);
    const [events, setEvents] = useState<ActivityEvent[]>([]);
    const [filter, setFilter] = useState<Filter>(['message', 'status', 'task', 'followup', 'call'].includes(params.get('type') || '') ? params.get('type') as Filter : 'all');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [callHistoryStatus, setCallHistoryStatus] = useState<'ready' | 'unavailable' | 'not_requested'>('not_requested');
    const [refresh, setRefresh] = useState(0);

    useEffect(() => {
        const controller = new AbortController();

        setError('');
        if (!businessId) { setLoading(false); return () => controller.abort(); }
        setLoading(true);
        fetch(`/api/businesses/${businessId}/activity?limit=${limit}&type=${filter}`, { credentials: 'same-origin', signal: controller.signal })
            .then(async response => {
                if (!response.ok) throw new Error(response.status === 403
                    ? 'Нет доступа к данным этого бизнеса.' : 'Не удалось загрузить ленту активности.');
                const result = await response.json() as ActivityResponse;
                if (!result.success || result.businessId !== businessId || !Array.isArray(result.events)) {
                    throw new Error('Ответ не соответствует выбранному бизнесу.');
                }
                if (controller.signal.aborted) return;
                setEvents(result.events);
                setCallHistoryStatus(result.callHistoryStatus === 'ready' || result.callHistoryStatus === 'not_requested'
                    ? result.callHistoryStatus : 'unavailable');
            })
            .catch((cause: Error) => { if (cause.name !== 'AbortError') setError(cause.message); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [businessId, filter, refresh, limit]);

    return <div className="activity-page">
        <header className="activity-page__heading">
            <div><p className="activity-page__eyebrow">AVA · ИСТОРИЯ БИЗНЕСА</p><h1>Активность</h1>
                <p className="activity-page__subtitle">Сообщения, звонки, задачи и повторные контакты{businessName ? ` · ${businessName}` : ''}</p></div>
            <button type="button" className="activity-page__refresh" onClick={() => setRefresh(value => value + 1)} disabled={loading || !businessId}>
                <RefreshCw size={17} aria-hidden="true" /> Обновить
            </button>
        </header>
        <nav className="activity-page__nav" aria-label="Связанные разделы">{canViewAnalytics && <Link to="/analytics">Аналитика</Link>}<Link to="/calls">Журнал звонков</Link><Link to="/conversations">Диалоги</Link></nav>

        {!businessId && <p className="activity-page__notice" role="status">Сначала выберите бизнес. <Link to="/instances">Открыть список бизнесов</Link></p>}
        {businessId && <div className="activity-page__filters" role="group" aria-label="Фильтр активности">
            {([['all', 'Всё'], ['message', 'Сообщения'], ['call', 'Звонки'], ['task', 'Задачи'], ['followup', 'Повторные контакты'], ['status', 'Статусы']] as [Filter, string][]).map(([value, label]) =>
                <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setEvents([]); setFilter(value); setLimit(50); setVisibleCount(20); }}>{label}</button>)}
        </div>}
        {businessId && !loading && !error && <p className="activity-page__count" role="status">Получено {events.length} последних событий{filter === 'all' ? '' : ' выбранного типа'}.</p>}
        {businessId && !loading && callHistoryStatus === 'unavailable' && <p className="activity-page__notice" role="status">История звонков временно недоступна. Остальные события показаны; отдельный журнал можно проверить в разделе «Звонки».</p>}
        {loading && <p className="activity-page__notice" role="status">Загружаем активность…</p>}
        {!loading && error && <div className="activity-page__notice activity-page__notice--error" role="alert">{error} <button type="button" onClick={() => setRefresh(value => value + 1)}>Повторить</button></div>}
        {!loading && !error && businessId && events.length === 0 && !(filter === 'call' && callHistoryStatus === 'unavailable') &&
            <p className="activity-page__empty">{filter === 'all'
                ? callHistoryStatus === 'unavailable' ? 'В CRM пока нет событий; историю звонков проверить не удалось.' : 'Пока нет сохранённых событий.'
                : 'Для этого фильтра событий нет.'}</p>}
        {events.length > 0 && <ol className="activity-page__list" aria-label="Недавняя активность">
            {events.slice(0, visibleCount).map(event => <li className="activity-page__event" key={event.id}>
                <span className={`activity-page__icon activity-page__icon--${event.type}`} aria-hidden="true">
                    {event.type === 'message' ? <MessageCircle size={17} /> : event.type === 'call' ? <PhoneCall size={17} />
                        : event.type === 'task' ? <ClipboardList size={17} /> : event.type === 'followup' ? <Send size={17} /> : <ActivityIcon size={17} />}
                </span>
                <div className="activity-page__body">
                    <div className="activity-page__event-head"><strong>{event.title === 'Черновик follow-up' ? 'Подготовлено сообщение' : event.title === 'Follow-up отправлен' ? 'Сообщение отправлено' : event.title}</strong>
                        <time dateTime={event.occurredAt || undefined}>{formatDate(event.occurredAt)}</time></div>
                    {event.senderName && <span className="activity-page__sender"><UserRound size={13} aria-hidden="true" /> {event.senderName}</span>}
                    <p>{event.detail}</p>
                    {event.type === 'call' ? <Link className="activity-page__client-link" to="/calls">Открыть журнал звонков</Link>
                        : event.chatId ? <Link className="activity-page__client-link" to={`/customers/${encodeURIComponent(event.chatId)}`}>Открыть карточку клиента</Link> : null}
                </div>
            </li>)}
        </ol>}
        {!loading && !error && (visibleCount < events.length || events.length === limit && limit < 100) && <button className="activity-page__refresh" type="button" onClick={() => { setVisibleCount(value => value + 20); if (visibleCount + 20 >= limit && limit < 100) setLimit(100); }}>Показать ещё</button>}
        {!loading && events.length === 100 && <p className="activity-page__notice">Здесь последние 100 событий. Более ранняя история доступна в карточке нужного клиента.</p>}
    </div>;
}
