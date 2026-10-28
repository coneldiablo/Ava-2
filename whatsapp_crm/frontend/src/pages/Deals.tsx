import { customerDisplayName } from '../customerDisplay';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChartNoAxesColumnIncreasing, Check, LayoutGrid, List, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { useInstance } from '../context/InstanceContext';
import { useBusinessAccess } from '../permissions';
import { canOperateCustomer, canOperateDeal } from '../customerPermissions';
import { Link, useSearchParams } from 'react-router-dom';
import './Deals.css';

type Stage = 'new' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost';
type View = 'kanban' | 'list' | 'timeline' | 'forecast';
type Currency = 'RUB' | 'USD' | 'EUR' | 'KZT';
interface Deal {
    id: string; instanceId: number; clientChatId: string | null; title: string;
    amount: number; currency: Currency; stage: Stage; ownerName: string;
    lostReason?: string; nextAction: string; nextActionAt: string | null; notes: string;
    revision: number; updatedAt: string; createdBy?: string | null;
}
interface Client { chatId: string; senderName?: string; assigneeUserId?: string | null }
interface Total { stage: Stage; currency: Currency; count: number; amountMinor: number }
const STAGES: { key: Stage; label: string }[] = [
    { key: 'new', label: 'Новые' }, { key: 'qualified', label: 'Квалификация' },
    { key: 'proposal', label: 'Предложение' }, { key: 'negotiation', label: 'Переговоры' },
    { key: 'won', label: 'Успешно' }, { key: 'lost', label: 'Не состоялась' },
];
const isStage = (value: string | null): value is Stage => Boolean(value && STAGES.some(stage => stage.key === value));
const initialForm = { title: '', clientChatId: '', amount: '0', currency: 'RUB' as Currency,
    stage: 'new' as Stage, ownerName: '', nextAction: '', nextActionAt: '', notes: '', lostReason: '' };
type Form = typeof initialForm;

function money(value: number, currency: Currency) {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(path, { credentials: 'same-origin', ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers } });
    if (response.status === 401) window.dispatchEvent(new Event('crm:unauthorized'));
    if (response.status === 403) window.dispatchEvent(new Event('crm:forbidden'));
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.success) {
        if (response.status === 409) throw new Error('Сделка изменилась. Обновите список и повторите действие.');
        if (response.status === 403) throw new Error('Нет прав на изменение сделок этого бизнеса.');
        throw new Error('Не удалось выполнить действие. Проверьте данные и попробуйте снова.');
    }
    return body as T;
}

// A keyed tenant boundary prevents an old business's asynchronous reads or
// mutation callbacks from populating the newly selected business's UI.
export default function Deals() {
    const { currentInstanceId } = useInstance();
    const access = useBusinessAccess();
    return <DealsForBusiness key={`${currentInstanceId}:${access.userId}:${access.role}`} />;
}

function DealsForBusiness() {
    const { currentInstanceId, currentInstance } = useInstance();
    const access = useBusinessAccess();
    const [searchParams, setSearchParams] = useSearchParams();
    const linkedDealId = searchParams.get('dealId')?.trim() || '';
    const rawStage=searchParams.get('stage');
    const stateFilter = searchParams.get('state') || '';
    const currencyFilter = searchParams.get('currency') || '';
    const clientFilter = searchParams.get('client') || '';
    const mineOnly = searchParams.get('mine') === '1' || (access.role === 'manager' && searchParams.get('mine') !== '0');
    const stageFilter: Stage | '' = isStage(rawStage) ? rawStage : '';
    const canEdit = !access.checking && access.can('sales.write') && (access.role !== 'manager' || Boolean(access.userId));
    const [deals, setDeals] = useState<Deal[]>([]);
    const [linkedDeal, setLinkedDeal] = useState<Deal | null>(null);
    const [linkedState, setLinkedState] = useState<'idle' | 'loading' | 'ready' | 'missing'>('idle');
    const [totals, setTotals] = useState<Total[]>([]);
    const [clients, setClients] = useState<Client[]>([]);
    const [view, setView] = useState<View>('kanban');
    const [query, setQuery] = useState('');
    const [form, setForm] = useState<Form>(initialForm);
    const [editing, setEditing] = useState<Deal | null>(null);
    const [formOpen, setFormOpen] = useState(false);
    const [loading, setLoading] = useState(true);
    const [totalsReady, setTotalsReady] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [feedback, setFeedback] = useState('');
    const firstInput = useRef<HTMLInputElement>(null);
    const formRef = useRef<HTMLElement>(null);

    async function refresh(instanceId: number, signal?: AbortSignal) {
        setLoading(true);
        setError('');
        try {
            const [dealData, clientData] = await Promise.all([
                api<{ business_id: number; deals: Deal[]; totals: Total[] }>(`/api/deals/${instanceId}`, { signal }),
                api<{ clients: Client[] }>(`/api/clients/${instanceId}`, { signal }),
            ]);
            if (signal?.aborted) return;
            if (dealData.business_id !== instanceId || !Array.isArray(dealData.deals) || !Array.isArray(dealData.totals) || !Array.isArray(clientData.clients)) throw new Error('Данные бизнеса не совпадают.');
            setDeals(dealData.deals);
            setTotals(dealData.totals);
            setClients(clientData.clients); setTotalsReady(true);
        } catch (cause) {
            if (signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')) return;
            setTotalsReady(false);
            setError(cause instanceof Error ? cause.message : 'Не удалось загрузить сделки.');
        } finally { if (!signal?.aborted) setLoading(false); }
    }

    useEffect(() => {
        setDeals([]); setTotals([]); setClients([]); setFormOpen(false); setEditing(null);
        if (!currentInstanceId) return;
        const controller = new AbortController();
        void refresh(currentInstanceId, controller.signal);
        return () => controller.abort();
    }, [currentInstanceId]);

    useEffect(() => {
        if (!currentInstanceId || !linkedDealId) {
            setLinkedDeal(null);
            setLinkedState('idle');
            return;
        }
        const controller = new AbortController();
        const businessId = currentInstanceId;
        setLinkedDeal(null);
        setLinkedState('loading');
        setView('list');
        void api<{ business_id: number; deal: Deal }>(`/api/deals/${businessId}/${encodeURIComponent(linkedDealId)}`, { signal: controller.signal })
            .then(result => {
                if (result.business_id !== businessId || result.deal.instanceId !== businessId) throw new Error('Business mismatch');
                setLinkedDeal(result.deal);
                setLinkedState('ready');
            })
            .catch(cause => {
                if (controller.signal.aborted || (cause instanceof Error && cause.name === 'AbortError')) return;
                setLinkedDeal(null);
                setLinkedState('missing');
            });
        return () => controller.abort();
    }, [currentInstanceId, linkedDealId]);

    function showAllDeals() {
        setSearchParams(previous => {
            const next = new URLSearchParams(previous);
            next.delete('dealId');
            return next;
        }, { replace: true });
    }

    const filtered = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase('ru');
        const visible = (linkedDealId ? (linkedDeal ? [linkedDeal] : []) : deals).filter(deal =>
            (!stageFilter || deal.stage === stageFilter) && (!currencyFilter || deal.currency === currencyFilter)
            && (!clientFilter || deal.clientChatId === clientFilter)
            && (stateFilter !== 'open' || !['won', 'lost'].includes(deal.stage))
            && (stateFilter !== 'closed' || ['won', 'lost'].includes(deal.stage))
            && (!mineOnly || (deal.clientChatId ? clients.some(client => client.chatId === deal.clientChatId && client.assigneeUserId === access.userId && !!access.userId) : !!access.userId && deal.createdBy === access.userId)));
        return needle ? visible.filter(item => [item.title, item.ownerName, item.clientChatId, item.nextAction]
            .some(value => String(value || '').toLocaleLowerCase('ru').includes(needle))) : visible;
    }, [deals, linkedDeal, linkedDealId, query, stageFilter, stateFilter, currencyFilter, clientFilter, mineOnly, clients, access.userId]);
    const clientNames = useMemo(() => new Map(clients.map(client => [client.chatId, customerDisplayName(client.senderName, undefined, client.chatId)])), [clients]);
    const closed = totals.filter(item => item.stage === 'won' || item.stage === 'lost').reduce((sum, item) => sum + item.count, 0);
    const won = totals.filter(item => item.stage === 'won').reduce((sum, item) => sum + item.count, 0);
    const openRub = totals.filter(item => item.currency === 'RUB' && !['won', 'lost'].includes(item.stage))
        .reduce((sum, item) => sum + item.amountMinor, 0) / 100;
    const otherCurrencies = [...new Set(totals.filter(item => item.currency !== 'RUB').map(item => item.currency))];
    const datedDeals = useMemo(() => filtered.filter(deal => Boolean(deal.nextActionAt))
        .slice().sort((a, b) => (a.nextActionAt || '').localeCompare(b.nextActionAt || '') || a.title.localeCompare(b.title, 'ru')),
    [filtered]);
    const undatedDeals = useMemo(() => filtered.filter(deal => !deal.nextActionAt), [filtered]);
    const forecastDatedDeals = useMemo(() => datedDeals.filter(deal => deal.stage !== 'won' && deal.stage !== 'lost'), [datedDeals]);
    const forecastUndatedDeals = useMemo(() => undatedDeals.filter(deal => deal.stage !== 'won' && deal.stage !== 'lost'), [undatedDeals]);
    const forecastPeriods = useMemo(() => {
        const periods = new Map<string, Deal[]>();
        forecastDatedDeals.forEach(deal => {
            const key = (deal.nextActionAt || '').slice(0, 7);
            if (!key) return;
            periods.set(key, [...(periods.get(key) || []), deal]);
        });
        return [...periods.entries()].sort(([a], [b]) => a.localeCompare(b));
    }, [forecastDatedDeals]);

    function openCreate(stage: Stage = 'new') {
        if (!canEdit) return;
        setEditing(null); setForm({ ...initialForm, stage }); setError(''); setFormOpen(true);
        setTimeout(() => { formRef.current?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); firstInput.current?.focus(); }, 0);
    }
    function openEdit(deal: Deal) {
        if (access.checking || !canOperateDeal(access, deal, clients, 'sales.write')) return;
        setEditing(deal);
        setForm({ title: deal.title, clientChatId: deal.clientChatId || '', amount: String(deal.amount),
            currency: deal.currency, stage: deal.stage, ownerName: deal.ownerName || '',
            nextAction: deal.nextAction || '', nextActionAt: deal.nextActionAt || '', notes: deal.notes || '', lostReason: deal.lostReason || '' });
        setError(''); setFormOpen(true);
        setTimeout(() => { formRef.current?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); firstInput.current?.focus(); }, 0);
    }
    async function save(event: React.FormEvent) {
        event.preventDefault();
        if (!canEdit || !currentInstanceId || saving || (editing && !canOperateDeal(access, editing, clients, 'sales.write'))) return;
        if (form.clientChatId && !canOperateCustomer(access, clients.find(client => client.chatId === form.clientChatId), 'sales.write')) { setError('Выберите клиента, назначенного вам, или создайте сделку без клиента.'); return; }
        setSaving(true); setError(''); setFeedback('');
        try {
            const payload = { ...form, amount: Number(form.amount), clientChatId: form.clientChatId || null,
                nextActionAt: form.nextActionAt || null };
            if (editing) await api(`/api/deals/${currentInstanceId}/${editing.id}`, {
                method: 'PUT', body: JSON.stringify({ ...payload, revision: editing.revision }),
            });
            else await api(`/api/deals/${currentInstanceId}`, { method: 'POST', body: JSON.stringify(payload) });
            setFormOpen(false); setEditing(null); setFeedback(editing ? 'Сделка обновлена.' : 'Сделка создана.');
            await refresh(currentInstanceId);
        } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить сделку.'); }
        finally { setSaving(false); }
    }
    async function remove(deal: Deal) {
        if (access.checking || !canOperateDeal(access, deal, clients, 'sales.write') || !currentInstanceId || !window.confirm(`Удалить сделку «${deal.title}»? Восстановить её здесь нельзя.`)) return;
        setSaving(true); setError(''); setFeedback('');
        try {
            await api(`/api/deals/${currentInstanceId}/${deal.id}`, { method: 'DELETE',
                body: JSON.stringify({ revision: deal.revision }) });
            setFeedback('Сделка удалена.');
            if (editing?.id === deal.id) { setFormOpen(false); setEditing(null); }
            await refresh(currentInstanceId);
        } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось удалить сделку.'); }
        finally { setSaving(false); }
    }
    function card(deal: Deal) {
        return <article className={`ava-deal-card ava-deal-card--${deal.stage}`} key={deal.id}>
            <div className="ava-deal-card-top"><span className="ava-deal-avatar" aria-hidden="true">{deal.title.slice(0, 2).toLocaleUpperCase('ru')}</span><h3><Link to={`/deals?dealId=${encodeURIComponent(deal.id)}&mine=0`}>{deal.title}</Link></h3></div>
            <p className="ava-deal-amount">{money(deal.amount, deal.currency)}</p>
            <p className="ava-deal-muted">{deal.clientChatId ? <Link to={`/customers/${encodeURIComponent(deal.clientChatId)}`}>{clientNames.get(deal.clientChatId) || deal.clientChatId}</Link> : 'Клиент не привязан'}</p>
            {!deal.nextAction && <p className="ava-deal-muted">Следующий шаг не указан</p>}
            {deal.nextAction && <p className="ava-deal-action">Далее: {deal.nextAction}{deal.nextActionAt ? ` · ${deal.nextActionAt}` : ''}</p>}
            {canOperateDeal(access, deal, clients, 'ai.use') && !access.isPlatformAdmin && <Link className="ava-deal-studio-link" to={`/studio?dealId=${encodeURIComponent(deal.id)}`}>Подготовить предложение</Link>}
            {access.role === 'manager' && deal.clientChatId && !canOperateDeal(access, deal, clients, 'sales.write') && <Link className="ava-deal-muted" to="/sales?view=queue">Открыть рабочее пространство</Link>}
            <div className="ava-deal-card-footer"><span>{deal.ownerName || 'Ответственный не назначен'}</span>
                {canOperateDeal(access, deal, clients, 'sales.write') && <div className="ava-deal-card-buttons">
                    <button type="button" onClick={() => openEdit(deal)} aria-label={`Изменить сделку ${deal.title}`} title="Изменить"><Pencil size={16} aria-hidden="true" /></button>
                    <button type="button" onClick={() => void remove(deal)} aria-label={`Удалить сделку ${deal.title}`} title="Удалить" disabled={saving}><Trash2 size={16} aria-hidden="true" /></button>
                </div>}</div>
        </article>;
    }

    return <div className="ava-deals">
        <header className="ava-deals-header"><div><p className="ava-deals-eyebrow">CRM · {currentInstance?.name || 'Выберите бизнес'}</p><h1>Сделки</h1><p>Запросы клиентов, которые вы ведёте к покупке: этап, сумма и следующий шаг.</p></div>
            <div className="ava-deals-header-actions"><button type="button" className="ava-deals-secondary" onClick={() => currentInstanceId && void refresh(currentInstanceId)} disabled={loading || !currentInstanceId}><RefreshCw size={17} aria-hidden="true" /> Обновить</button>
                {canEdit && <button type="button" className="ava-deals-primary" onClick={() => openCreate()} disabled={!currentInstanceId}><Plus size={18} aria-hidden="true" /> Новая сделка</button>}</div>
        </header>
        {!currentInstanceId && <div className="ava-deals-state">Выберите бизнес, чтобы работать со сделками.</div>}
        {error && <div role="alert" className="ava-deals-error">{error}</div>}
        {feedback && <div role="status" className="ava-deals-success"><Check size={17} aria-hidden="true" /> {feedback}</div>}
        {linkedDealId && <div className="ava-deals-state" role={linkedState === 'missing' ? 'alert' : 'status'}>
            {linkedState === 'ready' ? 'Показана выбранная сделка.' : linkedState === 'missing' ? 'Сделка не найдена в выбранном бизнесе.' : 'Открываем сделку…'}
            <button type="button" className="ava-deals-secondary" onClick={showAllDeals}>Показать все сделки</button>
        </div>}
        {currentInstanceId && <>
            <section className="ava-deals-kpis" aria-label="Показатели сделок">
                <Link to="/deals?state=open&currency=RUB&mine=0" className="ava-deals-kpi ava-deals-kpi--dark"><span>Открытая воронка · RUB</span><strong>{totalsReady ? money(openRub, 'RUB') : '—'}</strong><small>{otherCurrencies.length ? `Другие валюты (${otherCurrencies.join(', ')}) показаны отдельно в сделках.` : 'Сумма активных сделок · не оплата'}</small></Link>
                <Link to="/deals?state=open&mine=0" className="ava-deals-kpi"><span>Активные сделки</span><strong>{totalsReady ? totals.filter(item => !['won', 'lost'].includes(item.stage)).reduce((sum, item) => sum + item.count, 0) : '—'}</strong><small>На всех рабочих этапах</small></Link>
                <Link to="/deals?stage=won&mine=0" className="ava-deals-kpi"><span>Успешные сделки</span><strong>{totalsReady ? won : '—'}</strong><small>{!totalsReady ? 'Показатели недоступны' : closed ? `Конверсия среди закрытых: ${Math.round((won / closed) * 100)}%` : 'Нет закрытых сделок для расчёта конверсии'}</small></Link>
            </section>
            {(stateFilter || currencyFilter || clientFilter || mineOnly) && <p className="ava-deals-view-note" role="status">Выборка: {mineOnly ? 'мои сделки · ' : ''}{stateFilter === 'open' ? 'открытые · ' : stateFilter === 'closed' ? 'закрытые · ' : ''}{currencyFilter}{clientFilter ? ' · выбранного клиента' : ''} <Link to="/deals?mine=0">Все доступные сделки</Link></p>}
            <div className="aw-stage-filter"><label htmlFor="aw-deal-stage-filter">Этап сделки</label><select id="aw-deal-stage-filter" value={stageFilter} onChange={event=>setSearchParams(previous=>{const next=new URLSearchParams(previous);if(event.target.value)next.set('stage',event.target.value);else next.delete('stage');return next;})}><option value="">Все этапы</option>{STAGES.map(stage=><option value={stage.key} key={stage.key}>{stage.label}</option>)}</select></div>
            {deals.length >= 500 && <p className="ava-deals-view-note">В списке первые 500 сделок; показатели выше учитывают все сохранённые сделки. Конкретную сделку можно открыть по её ссылке.</p>}
            <section className="ava-deals-toolbar" aria-label="Управление воронкой"><div className="ava-deals-view" role="group" aria-label="Вид сделок">
                <button type="button" className={view === 'kanban' ? 'is-active' : ''} aria-pressed={view === 'kanban'} onClick={() => setView('kanban')}><LayoutGrid size={16} aria-hidden="true" /> Канбан</button>
                <button type="button" className={view === 'list' ? 'is-active' : ''} aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={16} aria-hidden="true" /> Список</button>
                <button type="button" className={view === 'timeline' ? 'is-active' : ''} aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}><CalendarDays size={16} aria-hidden="true" /> План по датам</button>
                <button type="button" className={view === 'forecast' ? 'is-active' : ''} aria-pressed={view === 'forecast'} onClick={() => setView('forecast')}><ChartNoAxesColumnIncreasing size={16} aria-hidden="true" /> Прогноз</button></div>
                <label className="ava-deals-search"><Search size={17} aria-hidden="true" /><span className="sr-only">Поиск сделок</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Поиск сделок" /></label>
                <span className="ava-deals-count">{loading ? 'Загрузка…' : `${filtered.length} сделок`}</span>
            </section>
            {!linkedDealId && deals.length >= 500 && <p className="ava-deals-warning" role="status">Показаны последние 500 сделок. Для полной истории потребуется расширить выборку.</p>}
            {totalsReady && !error && !loading && linkedState !== 'loading' && linkedState !== 'missing' && !filtered.length && <div className="ava-deals-state"><h2>{query || stageFilter ? 'По вашему запросу сделок нет' : 'Сделок пока нет'}</h2><p>{query || stageFilter ? 'Измените поисковый запрос или этап.' : canEdit ? 'Создайте первую сделку и добавьте клиента или следующий шаг.' : 'В выбранном бизнесе пока нет сделок.'}</p>{!query && !linkedDealId && canEdit && <button type="button" className="ava-deals-primary" onClick={() => openCreate()}><Plus size={17} aria-hidden="true" /> Добавить сделку</button>}</div>}
            {filtered.length > 0 && (view === 'kanban' ? <div className="ava-deals-kanban" aria-label="Воронка сделок">{STAGES.map(stage => {
                const stageDeals = filtered.filter(deal => deal.stage === stage.key);
                const stageRub = stageDeals.filter(item => item.currency === 'RUB')
                    .reduce((sum, item) => sum + item.amount, 0);
                return <section className="ava-deals-column" key={stage.key} aria-label={`${stage.label}: ${stageDeals.length} сделок`}><div className="ava-deals-column-head"><h2>{stage.label} <span>{stageDeals.length}</span></h2><p>{money(stageRub, 'RUB')} · RUB</p></div>
                    <div className="ava-deals-column-body">{stageDeals.map(card)}{canEdit && <button type="button" className="ava-deals-add" onClick={() => openCreate(stage.key)}><Plus size={16} aria-hidden="true" /> Добавить</button>}</div></section>;
            })}</div> : view === 'list' ? <div className="ava-deals-list" aria-label="Список сделок">{filtered.map(deal => <div key={deal.id} className="ava-deals-list-row"><div>{card(deal)}</div><span className="ava-deals-stage-label">{STAGES.find(stage => stage.key === deal.stage)?.label}</span></div>)}</div> : view === 'timeline' ? <section className="ava-deals-timeline" aria-label="План действий по датам"><p className="ava-deals-view-note">План следующих действий по указанной в сделке дате. Это не история событий.</p>
                {datedDeals.map(deal => <article className="ava-deals-timeline-item" key={deal.id}><time dateTime={deal.nextActionAt || undefined}>{new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${deal.nextActionAt}T00:00:00Z`))}</time><div><h2>{deal.title}</h2><p>{deal.nextAction || 'Следующее действие не указано'}</p><span>{STAGES.find(stage => stage.key === deal.stage)?.label} · {deal.ownerName || 'Ответственный не назначен'}</span></div><strong>{money(deal.amount, deal.currency)}</strong>{canOperateDeal(access, deal, clients, 'sales.write') && <button type="button" onClick={() => openEdit(deal)} aria-label={`Изменить сделку ${deal.title}`}><Pencil size={16} aria-hidden="true" /></button>}</article>)}
                {!!undatedDeals.length && <div className="ava-deals-undated"><h2>Без даты следующего действия <span>{undatedDeals.length}</span></h2><div className="ava-deals-forecast-cards">{undatedDeals.map(deal => <div key={deal.id} className="ava-deals-forecast-card"><div><strong>{deal.title}</strong><span>{deal.nextAction || 'Действие не указано'} · {STAGES.find(stage => stage.key === deal.stage)?.label}</span></div><b>{money(deal.amount, deal.currency)}</b></div>)}</div></div>}</section> : <section className="ava-deals-forecast" aria-label="Невзвешенный прогноз по открытым сделкам"><p className="ava-deals-view-note">Суммы только открытых сделок по дате следующего действия — не прогноз даты оплаты. Вероятность закрытия не задана и не рассчитывается. Валюты показаны отдельно.</p>
                {!forecastDatedDeals.length && !forecastUndatedDeals.length && <div className="ava-deals-state"><h2>Открытых сделок нет</h2><p>Новые сделки появятся здесь после создания; закрытые сделки в прогноз не входят.</p></div>}
                {forecastPeriods.map(([period, periodDeals]) => <section className="ava-deals-forecast-period" key={period}><header><h2>{new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${period}-01T00:00:00Z`))}</h2><span>{periodDeals.length} сделок</span></header>{STAGES.filter(stage => periodDeals.some(deal => deal.stage === stage.key)).map(stage => { const stageDeals = periodDeals.filter(deal => deal.stage === stage.key); const currencies = [...new Set(stageDeals.map(deal => deal.currency))]; return <div className="ava-deals-forecast-stage" key={stage.key}><h3>{stage.label}</h3><div>{currencies.map(currency => <p key={currency}><span>{currency}</span><strong>{money(stageDeals.filter(deal => deal.currency === currency).reduce((sum, deal) => sum + deal.amount, 0), currency)}</strong><small>{stageDeals.filter(deal => deal.currency === currency).length} сделок</small></p>)}</div></div>; })}</section>)}
                {!!forecastUndatedDeals.length && <section className="ava-deals-forecast-period ava-deals-forecast-undated"><header><h2>Дата действия не указана</h2><span>{forecastUndatedDeals.length} сделок · вне периодов</span></header>{[...new Set(forecastUndatedDeals.map(deal => deal.currency))].map(currency => <p key={currency}><span>{currency}</span><strong>{money(forecastUndatedDeals.filter(deal => deal.currency === currency).reduce((sum, deal) => sum + deal.amount, 0), currency)}</strong></p>)}</section>}
            </section>)}
        </>}
        {formOpen && canEdit && (!editing || canOperateDeal(access, editing, clients, 'sales.write')) && <section ref={formRef} className="ava-deals-editor" aria-label={editing ? 'Изменить сделку' : 'Новая сделка'}><div className="ava-deals-editor-head"><div><p className="ava-deals-eyebrow">CRM</p><h2>{editing ? 'Изменить сделку' : 'Новая сделка'}</h2></div><button type="button" onClick={() => { setFormOpen(false); setEditing(null); }} aria-label="Закрыть форму"><X size={20} aria-hidden="true" /></button></div>
            <form onSubmit={event => void save(event)}><div className="ava-deals-form-grid"><label>Название сделки *<input ref={firstInput} required maxLength={180} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label>
                <div><label htmlFor="deal-client">Клиент</label><select id="deal-client" value={form.clientChatId} onChange={event => setForm({ ...form, clientChatId: event.target.value })}><option value="">Без клиента</option>{clients.filter(client => canOperateCustomer(access, client, 'sales.write')).map(client => <option key={client.chatId} value={client.chatId}>{client.senderName?.trim() || 'Клиент без имени'}</option>)}</select></div>
                <label>Сумма<input type="number" min="0" max="90000000000000" step="0.01" required value={form.amount} onChange={event => setForm({ ...form, amount: event.target.value })} /></label>
                <div><label htmlFor="deal-currency">Валюта</label><select id="deal-currency" value={form.currency} onChange={event => setForm({ ...form, currency: event.target.value as Currency })}>{(['RUB', 'USD', 'EUR', 'KZT'] as Currency[]).map(currency => <option key={currency} value={currency}>{currency}</option>)}</select></div>
                <div><label htmlFor="deal-stage">Этап</label><select id="deal-stage" value={form.stage} onChange={event => setForm({ ...form, stage: event.target.value as Stage })}>{STAGES.map(stage => <option key={stage.key} value={stage.key}>{stage.label}</option>)}</select></div>
                <div><label htmlFor="deal-lost-reason">Причина потери</label>{form.stage !== 'lost' && <small id="deal-lost-help">Укажите при закрытии сделки без результата</small>}<textarea id="deal-lost-reason" aria-describedby={form.stage !== 'lost' ? 'deal-lost-help' : undefined} maxLength={500} value={form.lostReason} onChange={event => setForm({ ...form, lostReason: event.target.value })} /></div>
                <label>Ответственный<input maxLength={120} value={form.ownerName} onChange={event => setForm({ ...form, ownerName: event.target.value })} placeholder="Имя менеджера" /></label>
                <label>Следующее действие<input maxLength={280} value={form.nextAction} onChange={event => setForm({ ...form, nextAction: event.target.value })} placeholder="Например, уточнить даты" /></label>
                <label>Дата действия<input type="date" value={form.nextActionAt} onChange={event => setForm({ ...form, nextActionAt: event.target.value })} /></label></div>
                <label className="ava-deals-notes">Заметка<textarea rows={3} maxLength={2000} value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} /></label>
                <div className="ava-deals-form-actions"><button type="button" className="ava-deals-secondary" onClick={() => { setFormOpen(false); setEditing(null); }}>Отмена</button><button type="submit" className="ava-deals-primary" disabled={saving}>{saving ? 'Сохраняем…' : editing ? 'Сохранить' : 'Создать сделку'}</button></div>
            </form></section>}
    </div>;
}
