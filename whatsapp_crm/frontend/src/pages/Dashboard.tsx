import { useNavigate } from 'react-router-dom';
import { usePeriod } from '../hooks/usePeriod';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { isAxiosError } from 'axios';
import { Activity, ArrowRight, BarChart3, BookOpen, BriefcaseBusiness, Building2, Check, FilePenLine, Inbox, Megaphone, MessageCircle, MessageSquareText, Radio, Send, Settings2, Sparkles, Users, UserPlus, Zap } from 'lucide-react';
import { getStats } from '../api';
import { isCoffeeBusiness } from '../businessProfiles';
import { useAuth } from '../context/AuthContext';
import { useInstance } from '../context/InstanceContext';
import { askDashboardAva, completeDashboardTask, getDashboardActivity, getDashboardIntelligence, getDashboardMetrics, getDashboardOverview, getDashboardRecommendations, type DashboardActivityItem, type DashboardActivityResponse, type DashboardAskResponse, type DashboardDeal, type DashboardIntelligence, type DashboardMetrics, type DashboardOverview, type DashboardRecommendation, type DashboardTarget, type DashboardTask } from './dashboardApi';
import { BusinessTrend, MessageBalance } from './DashboardCharts';
import './Dashboard.css';

type Loadable<T> = { businessId: number | null; status: 'loading' | 'ready' | 'error'; value: T | null };
type LegacyStats = { totalClients: number; activeLeads: number; booked: number; pickupConfirmed: number; conversion: number };
const count = new Intl.NumberFormat('ru-RU');
const dateTime = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const initial = <T,>(): Loadable<T> => ({ businessId: null, status: 'loading', value: null });
const current = <T,>(state: Loadable<T>, id: number) => state.businessId === id ? state.value : null;
const stateLabel = <T,>(state: Loadable<T>, id: number, empty: string) => state.businessId !== id || state.status === 'loading' ? 'Загружаем данные…' : state.status === 'error' ? 'Не удалось загрузить данные.' : empty;
const formatDateTime = (value?: string | null, timezone?: string) => {
    if (!value) return null;
    const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
    if (Number.isNaN(Date.parse(normalized))) return null;
    try { return timezone ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(new Date(normalized)) : dateTime.format(new Date(normalized)); }
    catch { return dateTime.format(new Date(normalized)); }
};
const formatAmountMinor = ({ currency, amountMinor }: { currency: string; amountMinor: number }) => {
    try { return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amountMinor / 100); }
    catch { return `${count.format(amountMinor / 100)} ${currency}`; }
};
const formatAmounts = (amounts?: { currency: string; amountMinor: number }[]) => amounts?.length ? amounts.map(formatAmountMinor).join(' · ') : 'Сумма не указана';
const formatDealAmount = (deal: DashboardDeal) => {
    if (deal.amount == null || !deal.currency) return 'Сумма не указана';
    try { return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: deal.currency, maximumFractionDigits: 2 }).format(deal.amount); }
    catch { return `${count.format(deal.amount)} ${deal.currency}`; }
};
const targetPath = (target?: DashboardTarget | null) => target?.path?.startsWith('/') && !target.path.startsWith('//') ? target.path : null;
type ActivityFilter = 'all' | DashboardActivityItem['category'];
type DealFilter = 'all' | 'high' | 'silent' | 'stalled';
const activityFilters: { value: ActivityFilter; label: string }[] = [
    { value: 'all', label: 'Все' }, { value: 'ai', label: 'AI действия' },
    { value: 'team', label: 'Команда' }, { value: 'client', label: 'Клиенты' },
];
const dealFilters: { value: DealFilter; label: string }[] = [
    { value: 'all', label: 'Все' }, { value: 'high', label: 'Высокий риск' },
    { value: 'silent', label: 'Тихие' }, { value: 'stalled', label: 'Стагнация' },
];
const matchesDealFilter = (deal: DashboardDeal, filter: DealFilter) => filter === 'all'
    || (filter === 'high' && deal.score >= 55)
    || (filter === 'silent' && deal.riskReasons.some(factor => factor.code.startsWith('contact_stale_')))
    || (filter === 'stalled' && deal.riskReasons.some(factor => ['negotiation_stalled', 'next_action_missing'].includes(factor.code)));
const recommendationPath = (item: DashboardRecommendation, intelligence: DashboardIntelligence | null) => {
    const deal = item.sources?.find(source => source.type === 'customer_deal');
    if (deal) return `/deals?dealId=${encodeURIComponent(deal.id)}`;
    const taskId = item.id.startsWith('task:') ? item.id.slice(5) : null;
    return targetPath(intelligence?.priorities.find(priority => priority.kind === 'task' && priority.id === taskId)?.target);
};

export default function Dashboard() {
    const { currentInstance, currentInstanceId } = useInstance();
    const { role } = useAuth();
    const [days, setDays] = usePeriod();
    const navigate = useNavigate();
    const [refresh, setRefresh] = useState(0);
    const [overviewRefresh, setOverviewRefresh] = useState(0);
    const [metricsState, setMetricsState] = useState<Loadable<DashboardMetrics>>(initial);
    const [intelligenceState, setIntelligenceState] = useState<Loadable<DashboardIntelligence>>(initial);
    const [overnightState, setOvernightState] = useState<Loadable<DashboardOverview>>(initial);
    const [yesterdayState, setYesterdayState] = useState<Loadable<DashboardOverview>>(initial);
    const [activityState, setActivityState] = useState<Loadable<DashboardActivityResponse>>(initial);
    const [recommendationState, setRecommendationState] = useState<Loadable<DashboardRecommendation[]>>(initial);
    const [legacyState, setLegacyState] = useState<Loadable<LegacyStats>>(initial);
    const [question, setQuestion] = useState('');
    const [askState, setAskState] = useState<{ businessId: number; question: string; status: 'asking' | 'ready' | 'error' | 'empty' | 'indexing'; answer?: DashboardAskResponse } | null>(null);
    const [askError, setAskError] = useState('Не удалось получить ответ. Попробуйте ещё раз.');
    const [taskBusyId, setTaskBusyId] = useState<string | null>(null);
    const [taskError, setTaskError] = useState<string | null>(null);
    const [dealQuery, setDealQuery] = useState('');
    const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
    const [dealFilter, setDealFilter] = useState<DealFilter>('all');
    const [showAllDeals, setShowAllDeals] = useState(false);
    const [confirmTask, setConfirmTask] = useState<Pick<DashboardTask, 'id' | 'title' | 'completeAction'> | null>(null);
    const overviewAbort = useRef<Partial<Record<'overnight' | 'yesterday', AbortController>>>({});
    const askAbort = useRef<AbortController | null>(null);
    const activeBusinessId = useRef<number | null>(currentInstanceId);
    activeBusinessId.current = currentInstanceId;

    useEffect(() => {
        askAbort.current?.abort();
        askAbort.current = null;
        setAskState(null);
        setAskError('Не удалось получить ответ. Попробуйте ещё раз.');
        setQuestion('');
        setDealQuery('');
        setActivityFilter('all');
        setDealFilter('all');
        setShowAllDeals(false);
        setConfirmTask(null);
        setTaskBusyId(null);
        setTaskError(null);
        setOvernightState(initial());
        setYesterdayState(initial());
    }, [currentInstanceId]);
    useEffect(() => () => {
        askAbort.current?.abort();
    }, []);
    useEffect(() => {
        if (!currentInstanceId) return;
        const interval = window.setInterval(() => setRefresh(value => value + 1), 60_000);
        return () => window.clearInterval(interval);
    }, [currentInstanceId]);
    useEffect(() => {
        if (!currentInstanceId) return;
        const key = () => {
            const zone = currentInstance?.hotelTimezone || 'UTC';
            try {
                const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
                const local = Object.fromEntries(parts.map(part => [part.type, part.value]));
                return `${local.year}-${local.month}-${local.day}:${Number(local.hour) >= 9}`;
            } catch { return `${new Date().toISOString().slice(0, 10)}:${new Date().getUTCHours() >= 9}`; }
        };
        let previous = key();
        const check = () => {
            const next = key();
            if (next !== previous) { previous = next; setOverviewRefresh(value => value + 1); }
        };
        const interval = window.setInterval(check, 60_000);
        document.addEventListener('visibilitychange', check);
        return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', check); };
    }, [currentInstanceId, currentInstance?.hotelTimezone]);

    useEffect(() => {
        if (!currentInstanceId) return;
        const id = currentInstanceId;
        const controller = new AbortController();
        setIntelligenceState(previous => previous.businessId === id && previous.value ? previous : { businessId: id, status: 'loading', value: null });
        setActivityState(previous => previous.businessId === id && previous.value ? previous : { businessId: id, status: 'loading', value: null });
        setRecommendationState(previous => previous.businessId === id && previous.value ? previous : { businessId: id, status: 'loading', value: null });
        setLegacyState(previous => previous.businessId === id && previous.value ? previous : { businessId: id, status: 'loading', value: null });
        void getDashboardIntelligence(id, controller.signal).then(response => {
            const valid = response.success && response.instanceId === id;
            if (!controller.signal.aborted) setIntelligenceState(previous => ({ businessId: id, status: valid ? 'ready' : 'error', value: valid ? response : previous.businessId === id ? previous.value : null }));
        }).catch(() => { if (!controller.signal.aborted) setIntelligenceState(previous => ({ businessId: id, status: 'error', value: previous.businessId === id ? previous.value : null })); });
        void getDashboardActivity(id, controller.signal).then(response => {
            const valid = response.success && response.instanceId === id && ['available', 'unavailable'].includes(response.status)
                && Array.isArray(response.items) && response.items.every(item => ['ai', 'team', 'client'].includes(item.category));
            if (!controller.signal.aborted) setActivityState(previous => ({ businessId: id, status: valid ? 'ready' : 'error', value: valid ? response : previous.businessId === id ? previous.value : null }));
        }).catch(() => { if (!controller.signal.aborted) setActivityState(previous => ({ businessId: id, status: 'error', value: previous.businessId === id ? previous.value : null })); });
        void getDashboardRecommendations(id, controller.signal).then(response => {
            if (!controller.signal.aborted) setRecommendationState(previous => ({ businessId: id, status: response.success ? 'ready' : 'error', value: response.success ? response.recommendations : previous.businessId === id ? previous.value : null }));
        }).catch(() => { if (!controller.signal.aborted) setRecommendationState(previous => ({ businessId: id, status: 'error', value: previous.businessId === id ? previous.value : null })); });
        void getStats(id).then(response => {
            if (!controller.signal.aborted) setLegacyState(previous => ({ businessId: id, status: response.success && response.stats ? 'ready' : 'error', value: response.success ? response.stats : previous.businessId === id ? previous.value : null }));
        }).catch(() => { if (!controller.signal.aborted) setLegacyState(previous => ({ businessId: id, status: 'error', value: previous.businessId === id ? previous.value : null })); });
        return () => controller.abort();
    }, [currentInstanceId, refresh]);
    const requestOverview = useCallback(async (kind: 'overnight' | 'yesterday') => {
        if (!currentInstanceId) return;
        const businessId = currentInstanceId;
        const setter = kind === 'overnight' ? setOvernightState : setYesterdayState;
        overviewAbort.current[kind]?.abort();
        const controller = new AbortController();
        overviewAbort.current[kind] = controller;
        setter(previous => ({ businessId, status: 'loading', value: previous.businessId === businessId ? previous.value : null }));
        try {
            const response = await getDashboardOverview(businessId, kind, controller.signal);
            const value = response.overview;
            const valid = response.success === true && value?.businessId === businessId
                && value.window?.kind === kind && ['available', 'partial', 'unavailable'].includes(value.status)
                && ['answered', 'insufficient', 'empty', 'unavailable'].includes(value.answerStatus)
                && typeof value.summary === 'string' && typeof value.grounded === 'boolean'
                && (!value.changes || Array.isArray(value.changes)) && (!value.attention || Array.isArray(value.attention));
            if (!valid) throw new Error('Invalid overview');
            if (!controller.signal.aborted && activeBusinessId.current === businessId) {
                setter(previous => ({ businessId, status: value.answerStatus === 'unavailable' ? 'error' : 'ready',
                    value: value.answerStatus === 'unavailable' && previous.businessId === businessId && previous.value ? previous.value : value }));
            }
        } catch {
            if (!controller.signal.aborted && activeBusinessId.current === businessId) {
                setter(previous => ({ businessId, status: 'error', value: previous.businessId === businessId ? previous.value : null }));
            }
        }
    }, [currentInstanceId]);
    useEffect(() => {
        void requestOverview('overnight');
        void requestOverview('yesterday');
        const controllers = overviewAbort.current;
        return () => { controllers.overnight?.abort(); controllers.yesterday?.abort(); };
    }, [requestOverview, overviewRefresh]);
    useEffect(() => {
        if (!currentInstanceId) return;
        const id = currentInstanceId;
        const controller = new AbortController();
        setMetricsState(previous => previous.businessId === id && previous.value ? previous : { businessId: id, status: 'loading', value: null });
        void getDashboardMetrics(id, days, controller.signal).then(response => {
            const valid = response.success && response.business_id === id && response.period.days === days;
            if (!controller.signal.aborted) setMetricsState(previous => ({ businessId: id, status: valid ? 'ready' : 'error', value: valid ? response : previous.businessId === id && previous.value?.period.days === days ? previous.value : null }));
        }).catch(() => { if (!controller.signal.aborted) setMetricsState(previous => ({ businessId: id, status: 'error', value: previous.businessId === id ? previous.value : null })); });
        return () => controller.abort();
    }, [currentInstanceId, days, refresh]);

    if (!currentInstance || !currentInstanceId) return <section className="command-center cc-empty" aria-labelledby="cc-no-business"><Building2 aria-hidden="true" /><h1 id="cc-no-business">Пока нет выбранного бизнеса</h1><p>Добавьте бизнес, чтобы видеть его показатели и план работы.</p><Link to="/instances" className="cc-button cc-button--dark">Перейти к бизнесам</Link></section>;
    const id = currentInstanceId;
    const metricResponse = current(metricsState, id);
    const metrics = metricResponse?.period.days === days ? metricResponse : null;
    const intelligence = current(intelligenceState, id);
    const overnight = current(overnightState, id);
    const yesterday = current(yesterdayState, id);
    const activity = current(activityState, id);
    const recommendations = current(recommendationState, id);
    const legacy = current(legacyState, id);
    const sentiment = intelligence?.sentiment;
    const sentimentReady = sentiment?.status === 'available' && sentiment.sampleSize > 0 && sentiment.positive != null && sentiment.neutral != null && sentiment.negative != null;
    const positivePct = sentimentReady ? Math.round(sentiment!.positive! / sentiment!.sampleSize * 100) : 0;
    const negativePct = sentimentReady ? Math.round(sentiment!.negative! / sentiment!.sampleSize * 100) : 0;
    const neutralPct = Math.max(0, 100 - positivePct - negativePct);
    const filteredDeals = intelligence?.deals.items.filter(deal => matchesDealFilter(deal, dealFilter)
        && deal.title.toLocaleLowerCase('ru-RU').includes(dealQuery.trim().toLocaleLowerCase('ru-RU'))) ?? [];
    const filteredActivity = activity?.status === 'available'
        ? activity.items.filter(item => activityFilter === 'all' || item.category === activityFilter) : [];
    const newLeads = activity?.status === 'available' ? activity.items.filter(item => item.kind === 'new_lead') : [];

    const updateQuestion = (value: string) => {
        if (value === question) return;
        askAbort.current?.abort();
        askAbort.current = null;
        setAskState(null);
        setQuestion(value);
    };
    const submitAsk = async (event?: FormEvent<HTMLFormElement>) => {
        event?.preventDefault();
        const text = question.trim();
        if (!text || askAbort.current) return;
        if (role !== 'platform_admin') { navigate('/business-gpt?question=' + encodeURIComponent(text)); return; }
        const controller = new AbortController();
        askAbort.current = controller;
        setAskError('Не удалось получить ответ. Попробуйте ещё раз.');
        setAskState({ businessId: id, question: text, status: 'asking' });
        try {
            const response = await askDashboardAva(id, text, controller.signal);
            if (!controller.signal.aborted && activeBusinessId.current === id) {
                const valid = response.success === true && typeof response.answer === 'string' && !!response.answer.trim()
                    && Array.isArray(response.sources) && typeof response.grounded === 'boolean'
                    && (response.answerStatus !== 'answered' || response.grounded === true);
                setAskState({ businessId: id, question: text, status: valid ? 'ready' : 'error', answer: valid ? response : undefined });
            }
        } catch (error) {
            if (!controller.signal.aborted && activeBusinessId.current === id) {
                const code = isAxiosError(error) ? error.response?.data?.code : null;
                setAskError(code === 'KNOWLEDGE_EMPTY' ? 'В базе знаний пока нет документов с текстом. Добавьте документ или заметку.' : code === 'KNOWLEDGE_INDEXING' ? 'Документы ещё обрабатываются. Дождитесь завершения обработки и повторите вопрос.' : code === 'KNOWLEDGE_NOT_READY' ? 'База знаний этого бизнеса ещё не готова. Попробуйте позже.' : code === 'KNOWLEDGE_UNAVAILABLE' ? 'База знаний AVA сейчас недоступна. Попробуйте позже.' : code === 'KNOWLEDGE_TIMEOUT' ? 'База знаний AVA не ответила вовремя. Попробуйте ещё раз.' : code === 'DASHBOARD_MODEL_TIMEOUT' ? 'AVA не успела ответить. Попробуйте ещё раз.' : code === 'DASHBOARD_MODEL_BUSY' ? 'AVA обрабатывает другой вопрос. Повторите попытку через несколько секунд.' : code === 'DASHBOARD_MODEL_UNAVAILABLE' || code === 'DASHBOARD_MODEL_INVALID' || code === 'DASHBOARD_FACTS_UNAVAILABLE' ? 'Сейчас не удалось проверить данные бизнеса. Попробуйте ещё раз.' : isAxiosError(error) && ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code || '') ? 'AVA не ответила вовремя. Попробуйте ещё раз.' : code === 'ASK_RATE_LIMITED' ? 'Слишком много вопросов за минуту. Попробуйте позже.' : 'Не удалось получить ответ. Попробуйте ещё раз.');
                setAskState({ businessId: id, question: text, status: code === 'KNOWLEDGE_EMPTY' ? 'empty' : code === 'KNOWLEDGE_INDEXING' ? 'indexing' : 'error' });
            }
        } finally {
            if (askAbort.current === controller) askAbort.current = null;
        }
    };
    const cancelAsk = () => { askAbort.current?.abort(); askAbort.current = null; setAskState(null); };
    const finishTask = async (task: Pick<DashboardTask, 'id' | 'completeAction'>) => {
        if (!task.completeAction || taskBusyId) return;
        setTaskBusyId(task.id);
        setTaskError(null);
        try { const result = await completeDashboardTask(id, task.id); if (result?.success !== true) throw new Error('Task not confirmed'); if (activeBusinessId.current === id) { setConfirmTask(null); setRefresh(value => value + 1); } }
        catch { if (activeBusinessId.current === id) setTaskError('Не удалось завершить задачу. Попробуйте ещё раз.'); }
        finally { if (activeBusinessId.current === id) setTaskBusyId(null); }
    };
    return <div className="command-center">
        <header className="cc-heading"><div><span className="cc-eyebrow">{currentInstance.name}</span><h1>Главная</h1><p>Результат бизнеса и решения на сегодня</p></div><div className="cc-actions"><span className="cc-freshness" role="status">{metrics?.period.asOf ? `Показатели на ${formatDateTime(metrics.period.asOf, currentInstance.hotelTimezone) ?? 'последнюю проверку'}` : stateLabel(metricsState, id, 'Показатели недоступны')}</span><button className="cc-button" type="button" onClick={() => { setRefresh(value => value + 1); setOverviewRefresh(value => value + 1); }}>Обновить</button></div></header>
        <section className="cc-card cc-today" aria-labelledby="cc-today-title">
            <div className="cc-card-header"><div><span className="cc-eyebrow">Сегодня</span><h2 id="cc-today-title">Что требует вашего внимания</h2></div><Link className="cc-button" to="/today">Все обращения <ArrowRight size={15} aria-hidden="true" /></Link></div>
            <ul className="cc-owner-priorities">{intelligence?.priorities.slice(0, 3).map((item, index) => <li key={`${item.kind}-${item.id}`}><span className="cc-priority-index">{index + 1}</span><div><h3>{item.title}</h3><p>{item.reason}</p><span className="cc-item-meta">{item.nextAction}</span><div className="cc-actions">{targetPath(item.target) && <Link className="cc-button" to={targetPath(item.target)!}>Открыть обращение <ArrowRight size={14} aria-hidden="true" /></Link>}{item.completeAction && <button className="cc-button" type="button" disabled={!!taskBusyId} onClick={() => { setTaskError(null); setConfirmTask(item); }}>Завершить задачу</button>}</div></div></li>)}</ul>
            {!intelligence?.priorities.length && <Empty text={stateLabel(intelligenceState, id, 'Срочных действий нет.')} />}
            {intelligenceState.status === 'error' && <p className="cc-source-note" role="alert">{intelligence ? 'Список пока не обновился; показаны последние проверенные действия.' : 'Не удалось проверить приоритеты.'} <button className="cc-button" type="button" onClick={() => setRefresh(value => value + 1)}>Повторить проверку</button></p>}
            {confirmTask && <div className="cc-task-confirm" role="group" aria-label="Подтверждение завершения задачи"><p>Завершить задачу «{confirmTask.title}»? Это отмечает выполнение задачи; доставка сообщения и оплата проверяются отдельно.</p><button className="cc-button cc-button--dark" type="button" disabled={!!taskBusyId} onClick={() => void finishTask(confirmTask)}>{taskBusyId ? 'Сохраняем…' : 'Подтвердить завершение'}</button><button className="cc-button" type="button" disabled={!!taskBusyId} onClick={() => { setConfirmTask(null); setTaskError(null); }}>Отмена</button>{taskError && <p role="alert">{taskError}</p>}</div>}
        </section>
        <section className={role === 'platform_admin' ? 'cc-card cc-hero' : 'cc-card cc-assistant-entry'} aria-labelledby="cc-hero-title"><h2 id="cc-hero-title">Помощник AVA</h2><form className="cc-ask-form" onSubmit={submitAsk}><Sparkles size={18} aria-hidden="true" /><label className="sr-only" htmlFor="cc-ask-input">Вопрос для AVA</label><input id="cc-ask-input" value={question} onChange={event => updateQuestion(event.target.value)} placeholder="Спросить о бизнесе" maxLength={1200} /><button type="submit" aria-label={role === 'platform_admin' ? 'Отправить вопрос' : 'Открыть вопрос в помощнике AVA'} disabled={!question.trim() || askState?.status === 'asking'}><Send size={17} aria-hidden="true" /></button></form><div className="cc-suggestions" aria-label="Примеры вопросов">{['Сколько клиентов всего в CRM?', 'Как идёт мой бизнес?'].map(text => <button key={text} type="button" onClick={() => { updateQuestion(text); document.getElementById('cc-ask-input')?.focus(); }}>{text}</button>)}</div>{askState?.businessId === id && askState.question === question.trim() && <div className="cc-ask-answer" role="status">{askState.status === 'asking' ? <><p>AVA анализирует доступные данные…</p><button className="cc-button" type="button" onClick={cancelAsk}>Отменить вопрос</button></> : ['error', 'empty', 'indexing'].includes(askState.status) ? <><p role="alert">{askError}</p>{askState.status === 'empty' ? <Link className="cc-button" to="/knowledge-base">Добавить знания</Link> : <button className="cc-button" type="button" onClick={() => void submitAsk()}>Повторить вопрос</button>}</> : <><strong>{askState.answer?.grounded ? askState.answer.answerStatus === 'insufficient' ? 'Что известно' : 'Ответ AVA' : 'Недостаточно данных для ответа'}</strong><p>{askState.answer?.answer}</p>{askState.answer?.grounded && <Sources sources={askState.answer.sources} />}</>}</div>}</section>
        <div className="cc-period-toolbar"><div><h2>Бизнес в цифрах</h2><p>За последние {days} дней</p></div><div className="cc-filter-row" aria-label="Период графика">{([7, 30, 90] as const).map(value => <button key={value} type="button" className="cc-chip" aria-pressed={days === value} onClick={() => setDays(value)}>{value} дн.</button>)}</div></div>
        <MetricCards metrics={metrics} fallback={stateLabel(metricsState, id, "Показатели недоступны")} />

        <details className="cc-details cc-result-details" open={role === 'platform_admin'}><summary>Динамика и обзор бизнеса</summary>
        <div className="cc-overview-grid" aria-label="Обзоры событий бизнеса">
            <OverviewCard title="Что произошло за ночь" state={overnightState} overview={overnight} businessId={id} retry={() => void requestOverview('overnight')} />
            <OverviewCard title="Итоги вчерашнего дня" state={yesterdayState} overview={yesterday} businessId={id} retry={() => void requestOverview('yesterday')} />
        </div>
        <div className="cc-grid">
            {metricsState.status === 'error' && <p className="cc-span-12 cc-source-note" role="alert">{metrics ? 'Показатели пока не обновились; показаны последние проверенные значения.' : 'Не удалось загрузить показатели.'} <button className="cc-button" type="button" onClick={() => setRefresh(value => value + 1)}>Повторить загрузку</button></p>}
            <Panel className="cc-span-8" eyebrow="Выбранный период" title="Динамика бизнеса"><BusinessTrend key={`${id}:${days}`} metrics={metrics} fallback={stateLabel(metricsState, id, 'Данных за период пока нет.')} /></Panel>
            <Panel className="cc-span-4" eyebrow="Текущая работа" title="Воронка сделок"><Funnel retry={() => setRefresh(value => value + 1)} metrics={metrics} fallback={stateLabel(metricsState, id, 'Сделок за период пока нет.')} /></Panel>
            <Panel className="cc-span-6" eyebrow="Выбранный период" title="Общение с клиентами" action={<Link className="cc-button" to="/conversations">Диалоги <ArrowRight size={14} aria-hidden="true" /></Link>}><MessageBalance metrics={metrics} fallback={stateLabel(metricsState, id, 'Данные о сообщениях недоступны.')} /></Panel>
            <Panel className="cc-span-6" eyebrow="Потенциал продаж" title="Открытые сделки" action={<Link className="cc-button" to="/deals">Все сделки <ArrowRight size={14} aria-hidden="true" /></Link>}><DealSnapshot retry={() => setRefresh(value => value + 1)} metrics={metrics} fallback={stateLabel(metricsState, id, 'Данные о сделках недоступны.')} /></Panel>
            <Panel className="cc-span-12" eyebrow="Где нужно решение" title="Сделки, требующие внимания" action={intelligence?.deals.status === 'available' && intelligence.deals.items.length ? <div className="cc-deal-controls"><div className="cc-filter-row" aria-label="Фильтр сделок по риску">{dealFilters.map(filter => <button key={filter.value} type="button" className="cc-chip" aria-pressed={dealFilter === filter.value} onClick={() => setDealFilter(filter.value)}>{filter.label}</button>)}</div><label className="sr-only" htmlFor="cc-deal-search">Поиск сделки</label><input id="cc-deal-search" className="cc-search" value={dealQuery} onChange={event => setDealQuery(event.target.value)} placeholder="Найти сделку" /></div> : undefined}><RiskDeals deals={showAllDeals ? filteredDeals : filteredDeals.slice(0, 3)} status={intelligence?.deals.status} fallback={stateLabel(intelligenceState, id, 'Сделок, требующих внимания, нет.')} searched={!!dealQuery.trim() || dealFilter !== 'all'} />{filteredDeals.length > 3 && <button className="cc-button" type="button" aria-expanded={showAllDeals} onClick={() => setShowAllDeals(value => !value)}>{showAllDeals ? 'Показать первые три' : `Показать все (${filteredDeals.length})`}</button>}<Link className="cc-button" to="/deals">Все сделки <ArrowRight size={14} aria-hidden="true" /></Link></Panel>
        </div>
        </details>
        <details className="cc-details"><summary>Подробнее о работе бизнеса</summary><div className="cc-grid">
            <Panel className="cc-span-4" eyebrow="Качество общения" title="Тональность коммуникаций">{sentimentReady && sentiment ? <><div className="cc-sentiment" role="img" aria-label={`Позитив ${positivePct}%, нейтрально ${neutralPct}%, негатив ${negativePct}%`}><span style={{ width: `${positivePct}%`, background: '#238a69' }} /><span style={{ width: `${neutralPct}%`, background: '#aaa' }} /><span style={{ width: `${negativePct}%`, background: '#c35b59' }} /></div><div className="cc-sentiment-legend"><span><i style={{ background: '#238a69' }} />Позитив {positivePct}%</span><span><i style={{ background: '#aaa' }} />Нейтрально {neutralPct}%</span><span><i style={{ background: '#c35b59' }} />Негатив {negativePct}%</span></div><p className="cc-small cc-muted">{count.format(sentiment.sampleSize)} профилей · {sentiment.windowDays} дн. · AI оценка профилей с 3+ сообщениями</p></> : <Empty text={sentiment?.status === 'insufficient_data' ? 'Недостаточно сообщений для оценки тональности.' : sentiment?.status === 'unavailable' ? 'Оценка тональности недоступна.' : stateLabel(intelligenceState, id, 'Пока нет данных о тональности.')} />}</Panel>
            <Panel className="cc-span-12" eyebrow="События бизнеса" title="Подробности событий" action={<div className="cc-filter-row" aria-label="Фильтр событий за ночь">{activityFilters.map(filter => <button key={filter.value} type="button" className="cc-chip" aria-pressed={activityFilter === filter.value} disabled={activity?.status !== 'available'} onClick={() => setActivityFilter(filter.value)}>{filter.label}</button>)}</div>}>
                <details><summary className="cc-button">Показать события за ночь</summary>
                {activity?.status === 'available' ? <>
                    {!activity.sourceComplete && <p className="cc-source-note" role="status">Показаны подтверждённые события из доступных источников.</p>}
                    <div className="cc-activity-layout">
                        <div className="cc-activity-list" tabIndex={0} aria-label="События за ночь">
                            {filteredActivity.map(item => <article className="cc-activity-item" key={item.id}>
                                <span className="cc-badge">{item.category === 'ai' ? 'AI' : item.category === 'team' ? 'Команда' : 'Клиенты'}</span>
                                <time dateTime={item.occurredAt} className="cc-item-meta">{formatDateTime(item.occurredAt, activity.period.timezone) || item.occurredAt}</time>
                                <div className="cc-item-title">{item.title}</div>
                                <p className="cc-item-description">{item.description}</p>

                                {targetPath(item.target) && <Link className="cc-button" to={targetPath(item.target)!}>Открыть обращение <ArrowRight size={14} aria-hidden="true" /></Link>}
                            </article>)}
                            {!filteredActivity.length && <Empty text={activityFilter === 'all' ? 'За ночь подтверждённых событий нет.' : 'Событий этой категории за ночь нет.'} />}
                        </div>
                        <aside className="cc-new-leads" aria-label="Новые лиды за ночь">
                            <span className="cc-eyebrow">Новые лиды</span>
                            <strong className="cc-new-leads-count">{newLeads.length}</strong>
                            <span className="cc-small cc-muted">{activity.sourceComplete ? 'в ленте за ночь' : 'в доступной части ленты за ночь'}</span>
                            <p className="cc-small cc-muted">Новые записи клиентов ещё не означают квалифицированные лиды.</p>
                            {newLeads.slice(0, 3).map(item => <div className="cc-new-lead" key={item.id}><strong>{item.title}</strong>{targetPath(item.target) && <Link to={targetPath(item.target)!}>Открыть</Link>}</div>)}
                            {newLeads.length > 3 && <span className="cc-small cc-muted">Ещё {newLeads.length - 3}</span>}
                            {!newLeads.length && <p className="cc-small cc-muted">Новых записей клиентов в доступной ленте нет.</p>}
                            <Link className="cc-button" to="/leads">Все лиды <ArrowRight size={14} aria-hidden="true" /></Link>
                        </aside>
                    </div>
                </> : <Empty text={activity?.status === 'unavailable' ? 'Лента событий за ночь сейчас недоступна.' : activityState.businessId === id && activityState.status === 'error' ? 'Не удалось загрузить события за ночь.' : stateLabel(activityState, id, 'Лента событий за ночь недоступна.')} />}
                </details>
            </Panel>
            <Panel className="cc-span-12" eyebrow="Рекомендации AVA" title="Что AVA рекомендует">
                <div className="cc-recommendations">{recommendations?.map(item => <article className="cc-recommendation" key={item.id}><span className="cc-badge">{item.priority ? ({ high: 'В первую очередь', medium: 'На сегодня', low: 'Можно запланировать' } as Record<string, string>)[item.priority] || 'Рекомендация AVA' : 'Рекомендация AVA'}</span><div className="cc-item-title cc-recommendation-title">{item.title}</div><p className="cc-item-description">{item.reason}</p>{item.action && <p className="cc-item-meta">Следующий шаг: {item.action}</p>}<Sources sources={item.sources} />{recommendationPath(item, intelligence) && <Link className="cc-button" to={recommendationPath(item, intelligence)!}>Открыть обращение <ArrowRight size={14} aria-hidden="true" /></Link>}</article>)}</div>
                {!recommendations?.length && <Empty text={stateLabel(recommendationState, id, 'Новых рекомендаций нет.')} />}
            </Panel>
            <Panel className="cc-span-6" eyebrow="Сегодня" title="План на день">{taskError && <div className="cc-empty cc-error" role="alert">{taskError}</div>}{intelligence?.dayPlan.status === 'available' && intelligence.dayPlan.items.length ? <div>{intelligence.dayPlan.items.map(task => <div className="cc-today-row" key={`${task.kind}-${task.id}`}><div><strong>{task.title}</strong><div className="cc-item-meta">{task.dueAt === intelligence.dayPlan.date ? 'Сегодня' : task.dueAt ? `Срок: ${task.dueAt}` : 'Без срока'} · {task.status === 'in_progress' ? 'В работе' : task.status === 'new' ? 'Новая' : 'Открыта'}</div></div>{targetPath(task.target) && <Link to={targetPath(task.target)!} aria-label={`Открыть: ${task.title}`}><ArrowRight size={17} /></Link>}{task.completeAction && task.status !== 'done' && <button className="cc-button" type="button" disabled={taskBusyId === task.id} onClick={() => { setTaskError(null); setConfirmTask(task); }} aria-label={`Завершить задачу: ${task.title}`}><Check size={14} aria-hidden="true" /></button>}</div>)}</div> : <Empty text={intelligence?.dayPlan.status === 'unavailable' ? 'План на день недоступен.' : stateLabel(intelligenceState, id, 'Задач на сегодня нет.')} />}{!!intelligence?.dayPlan.unscheduledCount && <p className="cc-small cc-muted">Без срока: {count.format(intelligence.dayPlan.unscheduledCount)}</p>}</Panel>
            <Panel className="cc-span-6" eyebrow="Операционные показатели" title="Клиенты и обращения"><div className="cc-agent-row"><span>Клиентов всего</span><strong>{legacy ? count.format(legacy.totalClients) : '—'}</strong></div><div className="cc-agent-row"><span>Активных лидов</span><strong>{legacy ? count.format(legacy.activeLeads) : '—'}</strong></div><div className="cc-agent-row"><span>{isCoffeeBusiness(currentInstance) ? 'Подтверждённых самовывозов' : 'Успешных заявок'}</span><strong>{legacy ? count.format(isCoffeeBusiness(currentInstance) ? legacy.pickupConfirmed : legacy.booked) : '—'}</strong></div><div className="cc-agent-row"><span>Конверсия без отказов</span><strong>{legacy ? `${legacy.conversion}%` : '—'}</strong></div>{!legacy && <Empty text={stateLabel(legacyState, id, 'Операционные показатели недоступны.')} />}</Panel>
        </div></details>
        <details className="cc-details cc-legacy"><summary>Все разделы</summary><Panel eyebrow="Навигация" title="Быстрые действия"><div id="cc-links-title" className="sr-only">Быстрые действия</div><div className="cc-links"><ActionLink to="/conversations" icon={<Inbox />} title="Клиенты и диалоги" /><ActionLink to="/leads" icon={<Users />} title="Воронка лидов" /><ActionLink to="/deals" icon={<BriefcaseBusiness />} title="Сделки" />{role !== 'platform_admin' && <ActionLink to="/studio" icon={<FilePenLine />} title="Предложения и документы" />}<ActionLink to="/analytics" icon={<BarChart3 />} title="Аналитика" />{role !== 'platform_admin' && <ActionLink to="/reports" icon={<BarChart3 />} title="Отчёты" />}<ActionLink to="/activity" icon={<Activity />} title="Активность" /><ActionLink to="/outbound" icon={<Megaphone />} title="Исходящие кампании" /><ActionLink to="/calls" icon={<MessageCircle />} title="История звонков" /><ActionLink to="/knowledge-base" icon={<BookOpen />} title="База знаний" /><ActionLink to="/channels" icon={<Radio />} title="Каналы связи" /><ActionLink to="/triggers" icon={<Zap />} title="Автоматизация" /><ActionLink to="/quick-replies" icon={<MessageSquareText />} title="Быстрые ответы" /><ActionLink to="/team" icon={<UserPlus />} title="Команда" /><ActionLink to="/integrations" icon={<Settings2 />} title="Настройки" /></div></Panel></details>
    </div>;
}

function OverviewCard({ title, state, overview, businessId, retry }: { title: string; state: Loadable<DashboardOverview>; overview: DashboardOverview | null; businessId: number; retry: () => void }) {
    const usable = (overview?.answerStatus === 'answered' || overview?.answerStatus === 'insufficient') && overview.grounded && !!overview.summary.trim();
    const loading = state.businessId !== businessId || state.status === 'loading';
    const failed = !loading && (state.status === 'error' || overview?.answerStatus === 'unavailable');
    const message = loading ? 'AVA изучает события бизнеса…'
        : failed ? 'Не удалось подготовить обзор. Повторите попытку — остальная работа доступна.'
            : overview?.answerStatus === 'empty' ? (title === 'Что произошло за ночь' ? 'За ночь новых обращений в AVA нет.' : 'Вчера новых обращений в AVA не было.')
                : 'Пока недостаточно событий для вывода.';
    return <section className="cc-overview-card" aria-label={title} aria-busy={loading}>
        <div className="cc-overview-head"><div><span className="cc-eyebrow cc-eyebrow--ai">Обзор AVA</span><h2>{title}</h2></div></div>
        <div className="cc-overview-body" tabIndex={0} aria-label={`${title}: сведения AVA`}>
            <p className={usable ? 'cc-overview-summary' : 'cc-overview-summary cc-muted'} role="status">{usable ? overview.summary : message}</p>
        </div>
        {usable && overview?.status === 'partial' && <p className="cc-source-note">Обзор учитывает доступные события; часть данных пока недоступна.</p>}
        {usable && overview?.answerStatus === 'insufficient' && <p className="cc-source-note">События подтверждены, но их недостаточно для полного вывода.</p>}
        {usable && failed && <p className="cc-source-note" role="alert">Обзор не обновился. Сохранена последняя проверенная версия.</p>}
        {usable && loading && <p className="cc-source-note" role="status">Проверяем обновления…</p>}
        {failed && <button className="cc-button" type="button" onClick={retry}>Повторить обзор</button>}
    </section>;
}
function Panel({ eyebrow, title, action, className = '', children }: { eyebrow: string; title: string; action?: ReactNode; className?: string; children: ReactNode }) { const titleId = useId(); return <section className={`cc-card ${className}`} aria-labelledby={titleId}><div className="cc-card-header"><div><span className="cc-eyebrow">{eyebrow}</span><h2 id={titleId}>{title}</h2></div>{action}</div>{children}</section>; }
function Empty({ text }: { text: string }) { return <p className="cc-empty" role="status">{text}</p>; }
function Sources({ sources }: { sources?: { type: string; id: string }[] }) {
    const destinations: Record<string, [string, string]> = { knowledge: ['База знаний', '/knowledge-base'],
        customer_deal: ['Сделки', '/deals'], manager_task: ['Задачи команды', '/today'], client: ['Карточки клиентов', '/clients'],
        message: ['Переписка', '/conversations'], call: ['Звонки', '/calls'], sales_event: ['События клиентов', '/activity'],
        dashboard_aggregate: ['Показатели бизнеса', '/analytics'] };
    const groups = [...new Set(sources?.map(source => source.type))];
    return groups.length ? <details className="cc-answer-sources"><summary>На чём основан ответ</summary><ul className="cc-source-links">{groups.map(type => {
        const destination = destinations[type];
        const records = sources!.filter(source => source.type === type);
        // Only deal IDs have a corresponding exact-record URL. A client source
        // ID is a row ID, not a chat ID; other sources open their real collection.
        const path = type === 'customer_deal' && records.length === 1 && records[0].id ? `/deals?dealId=${encodeURIComponent(records[0].id)}` : destination?.[1];
        return <li key={type}>{path ? <Link to={path}>{destination[0]}<ArrowRight size={13} aria-hidden="true" /></Link> : <span>Записи бизнеса</span>}</li>;
    })}</ul></details> : null;
}
function ActionLink({ to, icon, title }: { to: string; icon: ReactNode; title: string }) { return <Link className="cc-action-link" to={to}><span aria-hidden="true">{icon}</span>{title}<ArrowRight size={14} aria-hidden="true" /></Link>; }
const stageLabels: Record<string, string> = { new: 'Новые', qualified: 'Квалификация', proposal: 'Предложение', negotiation: 'Переговоры', won: 'Успешно', lost: 'Не состоялась' };
const stageLabel = (stage?: string | null) => stage ? stageLabels[stage] || 'Другой этап' : 'Этап не указан';
const safeCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? count.format(Number(value)) : '—';
function MetricCards({ metrics, fallback }: { metrics: DashboardMetrics | null; fallback: string }) {
    const cards = [
        { title: 'Клиентов всего', value: metrics?.kpis.leads.total, detail: 'За всё время', path: '/clients', icon: <Users size={19} /> },
        { title: 'Новые клиенты', value: metrics?.kpis.leads.created, detail: 'За выбранный период', path: '/leads', icon: <UserPlus size={19} /> },
        { title: 'Сообщения', value: metrics?.kpis.messages.total, detail: 'За выбранный период', path: '/conversations', icon: <MessageSquareText size={19} /> },
        { title: 'Успешные сделки', value: metrics?.sources.closedDeals.status === 'unavailable' ? undefined : metrics?.kpis.deals.won, detail: metrics?.sources.closedDeals.status === 'partial' ? 'По учтённым закрытиям' : 'За выбранный период', path: '/deals?stage=won', icon: <Check size={19} /> },
    ];
    return <section className="cc-metric-cards" aria-label="Основные показатели бизнеса">{cards.map(card => <Link className="cc-metric-card" key={card.title} to={card.path}><span className="cc-metric-card-head"><span>{card.title}</span><i aria-hidden="true">{card.icon}</i></span><strong>{safeCount(card.value)}</strong><span className="cc-small cc-muted">{card.value == null ? metrics ? 'Данные недоступны' : fallback : card.detail}</span><ArrowRight className="cc-metric-card-arrow" size={16} aria-hidden="true" /></Link>)}</section>;
}
function DealSnapshot({ metrics, fallback, retry }: { metrics: DashboardMetrics | null; fallback: string; retry: () => void }) {
    if (!metrics) return <Empty text={fallback} />;
    const snapshot = metrics.currentFunnel;
    if (snapshot?.status === 'unavailable') return <><Empty text="Не удалось загрузить открытые сделки. Повторите загрузку показателей." /><button className="cc-button" type="button" onClick={retry}>Повторить загрузку сделок</button></>;
    const items = snapshot?.items ?? metrics.dealFunnel.filter(item => !['won','lost'].includes(item.stage));
    const total = snapshot?.totalOpen ?? metrics.kpis.deals.open;
    const amounts = new Map<string, bigint>();
    for (const item of items) for (const amount of item.amounts) if (Number.isSafeInteger(amount.amountMinor) && amount.amountMinor >= 0) amounts.set(amount.currency, (amounts.get(amount.currency) ?? 0n) + BigInt(amount.amountMinor));
    return <><p className="cc-snapshot-value">{safeCount(total)} <span>в работе</span></p><p className="cc-small cc-muted">{snapshot ? 'Все открытые сделки, включая созданные раньше' : 'Среди сделок, созданных за выбранный период'}</p><div className="cc-snapshot-amounts">{amounts.size ? [...amounts].map(([currency, minor]) => <strong key={currency}>{minor <= BigInt(Number.MAX_SAFE_INTEGER) ? formatAmountMinor({ currency, amountMinor: Number(minor) }) : `Суммы в ${currency} — в списке сделок`}</strong>) : <span className="cc-muted">{total === 0 ? 'Открытых сделок пока нет' : 'Суммы не указаны'}</span>}</div>{!!total && <p className="cc-small cc-muted">Суммы сделок — ожидаемые продажи, а не поступившие оплаты.</p>}</>;
}
function Funnel({ metrics, fallback, retry }: { metrics: DashboardMetrics | null; fallback: string; retry: () => void }) {
    if (!metrics) return <Empty text={fallback} />;
    const snapshot = metrics.currentFunnel;
    if (snapshot?.status === 'unavailable') return <><Empty text="Текущая воронка недоступна. Повторите загрузку показателей." /><button className="cc-button" type="button" onClick={retry}>Повторить загрузку воронки</button></>;
    const steps = snapshot?.items ?? metrics.dealFunnel;
    if (!steps.length || steps.every(step => step.count === 0)) return <div className="cc-funnel-empty"><BriefcaseBusiness size={28} aria-hidden="true" /><p>{snapshot ? 'Открытых сделок пока нет' : 'За выбранный период сделки ещё не созданы'}</p><span className="cc-small cc-muted">Звонки и переписки уже есть в карточках клиентов. Создайте сделку, когда появится конкретная возможность продажи.</span><Link className="cc-button" to="/deals">Перейти к сделкам <ArrowRight size={14} aria-hidden="true" /></Link></div>;
    const peak = Math.max(1, ...steps.map(step => step.count));
    return <><p className="cc-small cc-muted">{snapshot ? 'Все открытые сделки · без ограничения по дате создания' : 'Сделки, созданные за выбранный период'}</p><ol className="cc-funnel-list">{steps.map(step => <li className="cc-pipeline-row" key={step.stage}><Link to={`/deals?stage=${encodeURIComponent(step.stage)}`}><span>{stageLabel(step.stage)}</span><strong>{safeCount(step.count)}</strong><ArrowRight size={14} aria-hidden="true" /></Link><div className="cc-pipeline-bar" aria-hidden="true"><span style={{ width: `${step.count / peak * 100}%` }} /></div>{step.amounts.length > 0 && <div className="cc-item-meta">{formatAmounts(step.amounts)}</div>}</li>)}</ol></>;
}
function RiskDeals({ deals, status, fallback, searched }: { deals: DashboardDeal[]; status?: string; fallback: string; searched: boolean }) {
    if (status === 'unavailable') return <Empty text="Данные о рискованных сделках сейчас недоступны." />;
    if (!deals.length) return <Empty text={searched ? 'По выбранным условиям сделок нет.' : fallback} />;
    return <div className="cc-table-wrap" tabIndex={0} aria-label="Таблица сделок, требующих внимания"><table className="cc-table"><thead><tr><th>Сделка</th><th>Сумма</th><th>Этап</th><th>Причина внимания</th><th>Следующее действие</th><th>Объект</th></tr></thead><tbody>{deals.map(deal => <tr key={deal.id}><td><strong>{deal.title}</strong><span className="cc-item-meta">Контакт: {formatDateTime(deal.lastContactAt) || 'нет данных'}</span></td><td>{formatDealAmount(deal)}</td><td>{stageLabel(deal.stage)}</td><td>{deal.riskReasons.length ? deal.riskReasons.map(factor => factor.evidence).join('; ') : '—'}</td><td>{deal.nextAction || '—'}{deal.nextActionAt && <span className="cc-item-meta">Срок: {deal.nextActionAt}</span>}</td><td>{targetPath(deal.target) ? <Link to={targetPath(deal.target)!}>Открыть</Link> : <span className="cc-muted">Нет ссылки</span>}</td></tr>)}</tbody></table></div>;
}
