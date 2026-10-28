import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, BriefcaseBusiness, RefreshCw, Search, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getPipeline } from '../businessProfiles';
import { useInstance } from '../context/InstanceContext';
import { useBusinessAccess } from '../permissions';
import './Opportunities.css';

interface Deal {
    id: string;
    instanceId: number;
    clientChatId: string | null;
    title: string;
    amount: number;
    currency: string;
    stage: string;
    ownerName: string;
    nextAction: string;
    nextActionAt: string | null;
    updatedAt: string;
    createdBy?: string | null;
}

interface Client {
    assigneeUserId?: string | null;
    instanceId: number;
    chatId: string;
    senderName: string;
    leadStatus: string;
    lastMessage: string;
    lastMessageTime: string;
    updatedAt: string;
}

type Data = { deals: Deal[]; clients: Client[] };
const DEAL_STAGE_NAMES: Record<string, string> = {
    new: 'Новая', qualified: 'Квалификация', proposal: 'Предложение', negotiation: 'Переговоры',
};

async function readJson(path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await fetch(path, { credentials: 'same-origin', signal });
    if (response.status === 401) window.dispatchEvent(new Event('crm:unauthorized'));
    if (response.status === 403) window.dispatchEvent(new Event('crm:forbidden'));
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || body.success !== true) throw new Error('Не удалось загрузить данные CRM. Попробуйте обновить страницу.');
    return body;
}

function dateLabel(value?: string | null): string {
    if (!value) return 'Дата не указана';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Дата не указана' : new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' }).format(date);
}

function amountLabel(amount: number, currency: string): string | null {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    try { return new Intl.NumberFormat('ru-RU', { style: 'currency', currency }).format(amount); }
    catch { return null; }
}

export default function Opportunities() {
    const { currentInstanceId } = useInstance();
    const access = useBusinessAccess();
    return <OpportunitiesForBusiness key={`${currentInstanceId}:${access.userId}:${access.role}`}  instanceId={currentInstanceId} />;
}

function OpportunitiesForBusiness({ instanceId }: { instanceId: number | null }) {
    const { currentInstance } = useInstance();
    const access = useBusinessAccess();
    const [dealLimit, setDealLimit] = useState(20);
    const [leadLimit, setLeadLimit] = useState(20);
    const [data, setData] = useState<Data>({ deals: [], clients: [] });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [query, setQuery] = useState('');
    const [revision, setRevision] = useState(0);

    useEffect(() => {
        if (!instanceId) return;
        const controller = new AbortController();
        setLoading(true);
        setError('');
        Promise.all([
            readJson(`/api/deals/${instanceId}`, controller.signal),
            readJson(`/api/clients/${instanceId}`, controller.signal),
        ]).then(([dealBody, clientBody]) => {
            if (controller.signal.aborted) return;
            const deals = dealBody.deals;
            const clients = clientBody.clients;
            if (Number(dealBody.business_id) !== instanceId || !Array.isArray(deals) || !Array.isArray(clients)
                || deals.some(item => !item || Number(item.instanceId) !== instanceId)
                || clients.some(item => !item || Number(item.instanceId) !== instanceId)) {
                throw new Error('Данные бизнеса не совпадают. Обновите страницу.');
            }
            setData({ deals: deals as Deal[], clients: clients as Client[] });
        }).catch(cause => {
            if (!controller.signal.aborted) {
                setError(cause instanceof Error ? cause.message : 'Не удалось загрузить данные CRM.');
            }
        }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [instanceId, revision]);

    const pipeline = useMemo(() => getPipeline(currentInstance), [currentInstance]);
    const statusNames = useMemo(() => new Map(pipeline.map(status => [status.id, status.label])), [pipeline]);
    const activeStatuses = useMemo(() => new Set(pipeline.filter(status => !['junk', 'booked', 'ready_for_pickup'].includes(status.id)).map(status => status.id)), [pipeline]);
    const activeDeals = useMemo(() => data.deals.filter(deal => !['won', 'lost'].includes(deal.stage) && (access.role !== 'manager' || !!access.userId && (deal.clientChatId ? data.clients.some(client => client.chatId === deal.clientChatId && client.assigneeUserId === access.userId) : deal.createdBy === access.userId))), [data.deals, data.clients, access.role, access.userId]);
    const linkedChatIds = useMemo(() => new Set(activeDeals.map(deal => deal.clientChatId).filter(Boolean)), [activeDeals]);
    const activeLeads = useMemo(() => data.clients.filter(client => activeStatuses.has(client.leadStatus) && !linkedChatIds.has(client.chatId) && (access.role !== 'manager' || !!access.userId && client.assigneeUserId === access.userId)), [data.clients, activeStatuses, linkedChatIds, access.role, access.userId]);
    const clientNames = useMemo(() => new Map(data.clients.map(client => [client.chatId, client.senderName || client.chatId])), [data.clients]);
    const needle = query.trim().toLocaleLowerCase('ru');
    const shownDeals = activeDeals.filter(deal => !needle || [deal.title, deal.ownerName, deal.nextAction,
        deal.clientChatId ? clientNames.get(deal.clientChatId) : ''].some(value => String(value || '').toLocaleLowerCase('ru').includes(needle)))
        .sort((a, b) => (a.nextActionAt || '9999').localeCompare(b.nextActionAt || '9999') || b.updatedAt.localeCompare(a.updatedAt));
    const shownLeads = activeLeads.filter(client => !needle || [client.senderName, client.lastMessage, statusNames.get(client.leadStatus)]
        .some(value => String(value || '').toLocaleLowerCase('ru').includes(needle)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return <main className="ava-opportunities">
        <header className="ava-opportunities-header">
            <div>
                <span className="ava-opportunities-eyebrow">Клиенты · Следующие действия</span>
                <h1>Открытые запросы</h1>
                <p>Продолжите работу по сохранённым сделкам и обращениям. Откройте клиента, чтобы проверить договорённость и следующий шаг.</p>
            </div>
            <button className="ava-opportunities-refresh" type="button" onClick={() => setRevision(value => value + 1)} disabled={!instanceId || loading}>
                <RefreshCw size={17} aria-hidden="true" /> Обновить
            </button>
        </header>

        {!instanceId && <div className="ava-opportunities-state">Выберите бизнес, чтобы увидеть открытые запросы клиентов.</div>}
        {instanceId && <>
            {error && <div className="ava-opportunities-error" role="alert">{error} <button type="button" onClick={() => setRevision(value => value + 1)}>Повторить</button></div>}
            <section className="ava-opportunities-summary" aria-label="Сводка по текущему бизнесу">
                <a href="#opportunities-deals-title"><BriefcaseBusiness size={20} aria-hidden="true" /><span>Открытые сделки в списке</span><strong>{loading || error ? '—' : activeDeals.length}</strong></a>
                <a href="#opportunities-leads-title"><Users size={20} aria-hidden="true" /><span>Обращения без открытой сделки</span><strong>{loading || error ? '—' : activeLeads.length}</strong></a>
            </section>
            {!loading && !error && data.deals.length >= 500 && <p className="ava-opportunities-limit">Показаны первые 500 сделок. Для поиска среди остальных откройте раздел «Сделки».</p>}
            <div className="ava-opportunities-toolbar">
                <label className="ava-opportunities-search"><Search size={18} aria-hidden="true" /><span className="sr-only">Поиск возможностей</span>
                    <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Поиск по сделкам и обращениям" />
                </label>
                <span role="status">{loading ? 'Загрузка…' : error ? 'Данные недоступны' : `${shownDeals.length + shownLeads.length} записей`}</span>
            </div>
            {!loading && !error && shownDeals.length + shownLeads.length === 0 && <div className="ava-opportunities-state">
                {needle ? 'По запросу ничего не найдено. Измените поиск или очистите поле.' : 'Открытых сделок и обращений пока нет.'}
            </div>}
            {!loading && !error && shownDeals.length > 0 && <section className="ava-opportunities-section" aria-labelledby="opportunities-deals-title">
                <div className="ava-opportunities-section-head"><div><h2 id="opportunities-deals-title">Открытые сделки</h2><p>Суммы показаны только там, где они заполнены в сделке.</p></div><Link to="/deals">Все сделки <ArrowRight size={16} aria-hidden="true" /></Link></div>
                <div className="ava-opportunities-grid">{shownDeals.slice(0, dealLimit).map(deal => <article className="ava-opportunity-card" key={deal.id}>
                    <div className="ava-opportunity-card-top"><span className="ava-opportunity-kind">Сделка · {DEAL_STAGE_NAMES[deal.stage] || deal.stage}</span><span>{deal.nextActionAt ? `Следующее действие: ${dateLabel(deal.nextActionAt)}` : 'Дата действия не указана'}</span></div>
                    <h3>{deal.title}</h3><p>Почему здесь: {deal.nextAction ? `в сделке записано «${deal.nextAction}»` : 'у сделки ещё не записан следующий шаг'}.</p>
                    <p>{deal.clientChatId ? `Клиент: ${clientNames.get(deal.clientChatId) || deal.clientChatId}` : 'Клиент не привязан'}</p>
                    {deal.nextAction && <p className="ava-opportunity-next">Далее: {deal.nextAction}</p>}
                    <div className="ava-opportunity-card-foot"><strong>{amountLabel(deal.amount, deal.currency) || 'Сумма не указана'}</strong><Link to={`/deals?dealId=${encodeURIComponent(deal.id)}&mine=0`}>Открыть сделку <ArrowRight size={15} aria-hidden="true" /></Link></div>
                </article>)}</div>
                {shownDeals.length > dealLimit && <button className="ava-opportunities-refresh" type="button" onClick={() => setDealLimit(value => value + 20)}>Показать ещё сделки ({shownDeals.length - dealLimit})</button>}
            </section>}
            {!loading && !error && shownLeads.length > 0 && <section className="ava-opportunities-section" aria-labelledby="opportunities-leads-title">
                <div className="ava-opportunities-section-head"><div><h2 id="opportunities-leads-title">Обращения без открытой сделки</h2><p>Текущие этапы воронки; закрытые и спам-обращения исключены.</p></div><Link to="/leads">Воронка <ArrowRight size={16} aria-hidden="true" /></Link></div>
                <div className="ava-opportunities-grid">{shownLeads.slice(0, leadLimit).map(client => <article className="ava-opportunity-card" key={client.chatId}>
                    <div className="ava-opportunity-card-top"><span className="ava-opportunity-kind">Обращение · {statusNames.get(client.leadStatus) || client.leadStatus}</span><span>Обновлено: {dateLabel(client.updatedAt)}</span></div>
                    <h3>{client.senderName || client.chatId}</h3><p>Почему здесь: клиент на активном этапе, открытая сделка не привязана.</p>
                    {client.lastMessage && <p className="ava-opportunity-message">{client.lastMessage}</p>}
                    <div className="ava-opportunity-card-foot"><span>Сделка не создана</span><Link to={`/customers/${encodeURIComponent(client.chatId)}`}>Открыть клиента <ArrowRight size={15} aria-hidden="true" /></Link></div>
                </article>)}</div>
                {shownLeads.length > leadLimit && <button className="ava-opportunities-refresh" type="button" onClick={() => setLeadLimit(value => value + 20)}>Показать ещё обращения ({shownLeads.length - leadLimit})</button>}
            </section>}
        </>}
    </main>;
}
