import { formatBusinessDate } from '../businessTime';
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useInstance } from '../context/InstanceContext';
import { getClientProfile, buildClientProfile, getOptimalContactTime, generateOffer, getDynamicPricing, getMessages, getClientOrders, getCoffeeClientInsights, getSalesBrainClientContext, getFollowupDrafts, getSipAlias, setSipAlias, deleteSipAlias } from '../api';
import { User, Brain, Clock, Gift, DollarSign, ArrowLeft, Loader2, AlertCircle, RefreshCw, TrendingUp, Heart, MessageSquare, ShoppingBag, PhoneCall, Wrench, Sparkles, ListChecks, Link2, Trash2 } from 'lucide-react';
import CustomerIdentities from './CustomerIdentities';
import CustomerFollowups from './CustomerFollowups';
import CustomerCalls from './CustomerCalls';
import { channelLabel } from '../channelNames';
import './CustomerIntelligence.css';
import { isCoffeeBusiness } from '../businessProfiles';

interface Profile {
    needs: string;
    budget: string;
    objections: string;
    interests: string;
    communicationStyle: string;
    decisionSpeed: string;
    sentimentScore: number;
    conversionProbability: number;
    language: string;
    lastProfileUpdate: string;
}

interface ContactTimeData {
    bestSlots: { day: string; hour: number; score: number; responseCount: number }[];
    confidence: number;
}

interface Offer {
    offerText: string;
    discount: number;
    validUntil: string;
    reasoning: string;
    profile?: any;
    error?: string;
}

interface Pricing {
    discount: number;
    label: string;
    reasoning: string;
    appliedRules: string[];
}

interface ClientOrder {
    id: number;
    orderSummary: string;
    pickupTime?: string;
    status: string;
    baristaName?: string;
    createdAt?: string;
    acceptedAt?: string;
    completedAt?: string;
}

interface CoffeeInsights {
    ordersCount: number;
    successfulOrdersCount: number;
    completedOrdersCount: number;
    isRepeat: boolean;
    returnsCount: number;
    favoriteItems: { itemName: string; quantity: number }[];
    favoritePickupHour: number | null;
    averageCheck: number | null;
    ltv: number | null;
    categoryShare: { category: string; quantity: number }[];
    negativeFeedbacks: { text: string; createdAt: string; sentiment: string }[];
    segments: string[];
    aiNote: string;
}

interface SalesTimelineItem {
    type: 'message' | 'event' | 'tool_run' | 'ml_decision';
    channel?: string;
    role?: string;
    content: string;
    callId?: string;
    metadata?: Record<string, any>;
    timestamp?: string;
}

interface SalesBrainSummary {
    found?: boolean;
    summary_for_voice?: string;
    profile?: {
        interests?: string[];
        importantDates?: string[];
        objections?: string[];
        keyFacts?: string[];
        lastCallSummary?: string | null;
        lastCallAt?: string | null;
    };
    next_action?: {
        action?: string;
        message?: string;
    };
    client?: {
        leadStatus?: string;
    };
}

interface FollowupDraft {
    draft_id: string;
    text: string;
    status: string;
    created_at?: string;
    error?: string | null;
}

interface CustomerAlias {
    alias: string;
    link_type: string;
    confidence?: string;
    updated_at?: string;
}

export default function ClientProfile() {
    const { chatId: rawChatId } = useParams<{ chatId: string }>();
    const chatId = decodeURIComponent(rawChatId || '');
    const navigate = useNavigate();
    const { currentInstanceId, currentInstance } = useInstance();

    const [identityRevision, setIdentityRevision] = useState(0);
    const [profile, setProfile] = useState<Profile | null>(null);
    const [contactTime, setContactTime] = useState<ContactTimeData | null>(null);
    const [offer, setOffer] = useState<Offer | null>(null);
    const [pricing, setPricing] = useState<Pricing | null>(null);
    const [messageCount, setMessageCount] = useState(0);
    const [orders, setOrders] = useState<ClientOrder[]>([]);
    const [coffeeInsights, setCoffeeInsights] = useState<CoffeeInsights | null>(null);
    const [salesBrainSummary, setSalesBrainSummary] = useState<SalesBrainSummary | null>(null);
    const [salesTimeline, setSalesTimeline] = useState<SalesTimelineItem[]>([]);
    const [followupDrafts, setFollowupDrafts] = useState<FollowupDraft[]>([]);
    const [sipExtension, setSipExtension] = useState('');
    const [savedSipExtension, setSavedSipExtension] = useState('');

    const [loadingProfile, setLoadingProfile] = useState(false);
    const [buildingProfile, setBuildingProfile] = useState(false);
    const [loadingOffer, setLoadingOffer] = useState(false);
    const [savingSipAlias, setSavingSipAlias] = useState(false);
    useEffect(() => {
        if (!currentInstanceId || !chatId) return;
        loadAll();
    }, [currentInstanceId, chatId]);

    const loadAll = async () => {
        if (!currentInstanceId || !chatId) return;
        setLoadingProfile(true);
        try {
            const [profRes, ctRes, priceRes, msgRes, ordersRes, coffeeRes, salesBrainRes, draftsRes, aliasesRes] = await Promise.all([
                getClientProfile(currentInstanceId, chatId).catch(() => ({ success: false })),
                getOptimalContactTime(currentInstanceId, chatId).catch(() => ({ success: false })),
                getDynamicPricing(currentInstanceId, chatId).catch(() => ({ success: false })),
                getMessages(currentInstanceId, chatId).catch(() => ({ success: false, messages: [] })),
                getClientOrders(currentInstanceId, chatId).catch(() => ({ success: false, orders: [] })),
                isCoffeeBusiness(currentInstance)
                    ? getCoffeeClientInsights(currentInstanceId, chatId).catch(() => ({ success: false }))
                    : Promise.resolve({ success: false }),
                getSalesBrainClientContext(currentInstanceId, chatId).catch(() => ({
                    success: false,
                    summary: null,
                    timeline: []
                })),
                getFollowupDrafts(currentInstanceId, chatId).catch(() => ({ success: false, drafts: [] })),
                getSipAlias(currentInstanceId, chatId).catch(() => ({ success: false, aliases: [] })),
            ]);
            if (profRes.success && profRes.profile) setProfile(profRes.profile);
            if (ctRes.success && ctRes.data) setContactTime(ctRes.data);
            if (priceRes.success && priceRes.pricing) setPricing(priceRes.pricing);
            if (msgRes.success) setMessageCount(msgRes.messages?.length || 0);
            if (ordersRes.success) setOrders(ordersRes.orders || []);
            if (coffeeRes.success && coffeeRes.insights) setCoffeeInsights(coffeeRes.insights);
            if (salesBrainRes.success) {
                setSalesBrainSummary(salesBrainRes.summary || null);
                setSalesTimeline(salesBrainRes.timeline || []);
            }
            if (draftsRes.success) setFollowupDrafts(draftsRes.drafts || []);
            if (aliasesRes.success) {
                const sipAlias = (aliasesRes.aliases || []).find((alias: CustomerAlias) => alias.link_type === 'sip_extension');
                const value = sipAlias?.alias || '';
                setSavedSipExtension(value);
                setSipExtension(value);
            }
        } catch (e) { console.error(e); }
        setLoadingProfile(false);
    };

    const handleBuildProfile = async () => {
        if (!currentInstanceId || !chatId) return;
        setBuildingProfile(true);
        try {
            const res = await buildClientProfile(currentInstanceId, chatId);
            if (res.success && res.profile) setProfile(res.profile);
        } catch (e) { console.error(e); }
        setBuildingProfile(false);
    };

    const handleGenerateOffer = async () => {
        if (!currentInstanceId || !chatId) return;
        setLoadingOffer(true);
        try {
            const res = await generateOffer(currentInstanceId, chatId);
            if (res.success) setOffer(res.offer);
        } catch (e) { console.error(e); }
        setLoadingOffer(false);
    };

    const handleSaveSipAlias = async () => {
        if (!currentInstanceId || !chatId || !sipExtension.trim()) return;
        setSavingSipAlias(true);
        try {
            const res = await setSipAlias(currentInstanceId, chatId, sipExtension.trim());
            if (res.success) {
                setSavedSipExtension(res.alias || sipExtension.trim());
                setSipExtension(res.alias || sipExtension.trim());
            }
        } catch (e) { console.error(e); }
        setSavingSipAlias(false);
    };

    const handleDeleteSipAlias = async () => {
        if (!currentInstanceId || !chatId) return;
        setSavingSipAlias(true);
        try {
            const res = await deleteSipAlias(currentInstanceId, chatId);
            if (res.success) {
                setSavedSipExtension('');
                setSipExtension('');
            }
        } catch (e) { console.error(e); }
        setSavingSipAlias(false);
    };

    if (!currentInstanceId) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-center">
                <AlertCircle size={40} className="text-neu-muted mb-4" />
                <h2 className="text-xl font-bold text-neu-text mb-2">Выберите бизнес</h2>
            </div>
        );
    }

    const sentimentColor = profile
        ? profile.sentimentScore > 0.6 ? '#22c55e' : profile.sentimentScore > 0.4 ? '#f59e0b' : '#ef4444'
        : '#a0a0a8';

    const convColor = profile
        ? profile.conversionProbability > 60 ? '#22c55e' : profile.conversionProbability > 30 ? '#f59e0b' : '#ef4444'
        : '#a0a0a8';

    return (
        <div className="max-w-4xl mx-auto pb-10">
            {/* Header */}
            <div className="flex flex-wrap items-center gap-3 mb-6">
                <button type="button" aria-label="Вернуться к клиентам" onClick={() => navigate(-1)} className="p-2 hover:bg-neu-surface-2 rounded-xl text-neu-muted hover:text-neu-text transition-all hover:shadow-neu-raised-sm">
                    <ArrowLeft size={20} aria-hidden="true" />
                </button>
                <div>
                    <h1 className="text-2xl font-bold text-neu-text flex items-center gap-2">
                        <User size={24} className="text-accent-2" />
                        Профиль клиента
                    </h1>
                    <p className="text-neu-muted text-sm mt-0.5 font-mono">{chatId.replace('@c.us', '')}</p>
                </div>
                <div className="ml-auto flex flex-wrap gap-2">
                    <button onClick={handleBuildProfile} disabled={buildingProfile}
                        className="btn-secondary text-sm"
                        style={{ color: '#6c5ce7' }}>
                        {buildingProfile ? <Loader2 size={16} className="animate-spin" /> : <Brain size={16} />}
                        {profile ? 'Обновить профиль' : 'Построить профиль'}
                    </button>
                    <button type="button" aria-label="Обновить данные клиента" onClick={loadAll} disabled={loadingProfile} className="p-2 hover:bg-neu-surface-2 rounded-xl text-neu-muted hover:text-neu-text transition-all hover:shadow-neu-raised-sm">
                        <RefreshCw size={16} aria-hidden="true" className={loadingProfile ? 'animate-spin' : ''} />
                    </button>
                </div>
            </div>

            {loadingProfile && !profile && (
                <div className="flex justify-center py-12"><Loader2 size={28} className="animate-spin text-accent-2" /></div>
            )}

            <div className="card mb-6">
                <div className="card-header flex items-center gap-2">
                    <Link2 size={18} className="text-green-400" />
                    <h3 className="font-semibold text-neu-text">SIP → WhatsApp</h3>
                    {savedSipExtension && (
                        <span className="ml-auto text-xs font-mono text-green-400">
                            {savedSipExtension} привязан
                        </span>
                    )}
                </div>
                <div className="card-body">
                    <div className="flex flex-col sm:flex-row gap-2">
                        <input
                            value={sipExtension}
                            onChange={(event) => setSipExtension(event.target.value.replace(/\D+/g, '').slice(0, 20))}
                            placeholder="Например, 6003"
                            inputMode="numeric"
                            className="flex-1 min-w-0"
                        />
                        <button
                            onClick={handleSaveSipAlias}
                            disabled={savingSipAlias || !sipExtension.trim()}
                            className="btn-secondary"
                        >
                            {savingSipAlias ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
                            {savedSipExtension ? 'Заменить' : 'Привязать'}
                        </button>
                        {savedSipExtension && (
                            <button
                                onClick={handleDeleteSipAlias}
                                disabled={savingSipAlias}
                                className="p-2.5 text-red-400 hover:bg-red-400/10 rounded-lg"
                                title="Удалить SIP-привязку"
                            >
                                <Trash2 size={17} />
                            </button>
                        )}
                    </div>
                    <p className="text-xs text-neu-muted mt-2">
                        При звонке с этого SIP extension AVA найдет текущего WhatsApp-клиента и использует его контекст.
                    </p>
                </div>
            </div>

            {(salesBrainSummary?.summary_for_voice || salesTimeline.length > 0 || followupDrafts.length > 0) && (
                <div className="card mb-6">
                    <div className="card-header flex items-center gap-2">
                        <Brain size={18} className="text-accent-2" />
                        <h3 className="font-semibold text-neu-text">Единая история Sales Brain</h3>
                        {salesBrainSummary?.client?.leadStatus && (
                            <span className="ml-auto px-2.5 py-1 rounded-full text-xs font-semibold bg-accent-2/10 text-accent-2">
                                {salesBrainSummary.client.leadStatus}
                            </span>
                        )}
                    </div>
                    <div className="card-body">
                        {salesBrainSummary?.summary_for_voice && (
                            <div className="pb-4 mb-4 border-b border-white/5">
                                <p className="text-xs text-neu-muted mb-1">Контекст для звонка</p>
                                <p className="text-sm text-neu-text leading-relaxed">{salesBrainSummary.summary_for_voice}</p>
                                {salesBrainSummary.next_action?.message && (
                                    <div className="flex items-start gap-2 mt-3 text-sm">
                                        <ListChecks size={15} className="text-accent mt-0.5 flex-shrink-0" />
                                        <span className="text-neu-muted">
                                            Следующий шаг: <span className="text-neu-text">{salesBrainSummary.next_action.message}</span>
                                        </span>
                                    </div>
                                )}
                            </div>
                        )}

                        {(salesBrainSummary?.profile?.interests?.length
                            || salesBrainSummary?.profile?.importantDates?.length
                            || salesBrainSummary?.profile?.objections?.length
                            || salesBrainSummary?.profile?.lastCallSummary
                            || salesBrainSummary?.profile?.keyFacts?.length) && (
                            <div className="pb-4 mb-4 border-b border-white/5">
                                <p className="text-xs text-neu-muted mb-3">Память клиента</p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <MemoryBlock
                                        title="Интересы"
                                        items={salesBrainSummary?.profile?.interests || []}
                                        empty="Пока не выделены"
                                    />
                                    <MemoryBlock
                                        title="Даты"
                                        items={salesBrainSummary?.profile?.importantDates || []}
                                        empty="Пока не зафиксированы"
                                    />
                                    <MemoryBlock
                                        title="Возражения"
                                        items={(salesBrainSummary?.profile?.objections || []).map(formatObjectionMemory)}
                                        empty="Не обнаружены"
                                    />
                                    <div className="rounded-xl p-3 bg-neu-base shadow-neu-inset-sm">
                                        <p className="text-xs text-neu-muted mb-2">Последний звонок</p>
                                        {salesBrainSummary?.profile?.lastCallSummary ? (
                                            <>
                                                <p className="text-sm text-neu-text">{salesBrainSummary.profile.lastCallSummary}</p>
                                                {salesBrainSummary.profile.lastCallAt && (
                                                    <p className="text-[11px] text-neu-dim mt-2">
                                                        {formatBusinessDate(salesBrainSummary.profile.lastCallAt, true, currentInstance?.hotelTimezone)}
                                                    </p>
                                                )}
                                            </>
                                        ) : (
                                            <p className="text-sm text-neu-muted">Пока нет записанного звонка</p>
                                        )}
                                    </div>
                                </div>
                                {salesBrainSummary?.profile?.keyFacts?.length ? (
                                    <div className="mt-3 flex flex-wrap gap-2">
                                        {salesBrainSummary.profile.keyFacts.slice(0, 6).map((fact, index) => (
                                            <span
                                                key={`${fact}-${index}`}
                                                className="px-2.5 py-1 rounded-full text-xs font-semibold bg-accent-2/10 text-accent-2"
                                            >
                                                {fact}
                                            </span>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        )}

                        {salesTimeline.length > 0 && (
                            <div className="space-y-1 max-h-[560px] overflow-y-auto" tabIndex={0} aria-label="История общения">
                                {[...salesTimeline].filter(item => item.type !== 'tool_run' && item.type !== 'ml_decision' && !item.content?.startsWith('voice:internal')).reverse().slice(0, 30).map((item, index) => (
                                    <div
                                        key={`${item.type}-${item.timestamp || index}-${index}`}
                                        className="flex items-start gap-3 py-3 border-b border-white/5 last:border-0"
                                    >
                                        <TimelineIcon item={item} />
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                <span className="text-xs font-semibold text-neu-text">
                                                    {timelineLabel(item)}
                                                </span>
                                                {item.channel && (
                                                    <span className="text-[11px] text-neu-dim">{channelLabel(item.channel)}</span>
                                                )}
                                                <span className="ml-auto text-[11px] text-neu-dim">
                                                    {formatBusinessDate(item.timestamp, true, currentInstance?.hotelTimezone)}
                                                </span>
                                            </div>
                                            <p className="text-sm text-neu-muted mt-1 whitespace-pre-wrap break-words">
                                                {item.content}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {currentInstanceId && chatId && <div className="customer-intelligence mb-6"><CustomerIdentities key={`${currentInstanceId}:${chatId}`} instanceId={currentInstanceId} chatId={chatId} onLinked={() => { setIdentityRevision(value => value + 1); void loadAll(); }} /><CustomerCalls timeZone={currentInstance?.hotelTimezone} key={`calls:${currentInstanceId}:${chatId}:${identityRevision}`} instanceId={currentInstanceId} chatId={chatId} /><CustomerFollowups key={`tasks:${currentInstanceId}:${chatId}:${identityRevision}`} instanceId={currentInstanceId} chatId={chatId} /></div>}

            {orders.length > 0 && (
                <div className="card mb-6">
                    <div className="card-header flex items-center gap-2">
                        <ShoppingBag size={18} className="text-amber-400" />
                        <h3 className="font-semibold text-neu-text">История заказов</h3>
                        <span className="text-xs text-neu-muted ml-auto">Всего: {orders.length}</span>
                    </div>
                    <div className="card-body space-y-3">
                        {orders.slice(0, 5).map((order, idx) => (
                            <div key={order.id} className="rounded-xl p-3 bg-neu-base shadow-neu-inset-sm flex flex-col md:flex-row md:items-center gap-3">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="text-xs font-semibold text-neu-muted">#{order.id}</span>
                                        <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${order.status === 'accepted' || order.status === 'completed' ? 'text-green-400 bg-green-400/10' : order.status === 'rejected' || order.status === 'expired' ? 'text-red-400 bg-red-400/10' : 'text-amber-400 bg-amber-400/10'}`}>
                                            {formatOrderStatus(order.status)}
                                        </span>
                                        {idx === 0 && <span className="text-[11px] text-accent">последний</span>}
                                    </div>
                                    <p className="text-sm text-neu-text truncate">{order.orderSummary}</p>
                                    <p className="text-xs text-neu-muted mt-1">
                                        {order.pickupTime ? `Самовывоз: ${order.pickupTime}` : 'Время самовывоза не указано'}
                                        {order.baristaName ? ` · Бариста: ${order.baristaName}` : ''}
                                    </p>
                                </div>
                                <div className="text-xs text-neu-muted md:text-right">
                                    {order.createdAt ? formatBusinessDate(order.createdAt, true, currentInstance?.hotelTimezone) : ''}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {coffeeInsights && (
                <div className="card mb-6">
                    <div className="card-header flex items-center gap-2">
                        <ShoppingBag size={18} className="text-accent" />
                        <h3 className="font-semibold text-neu-text">Coffee Profile</h3>
                        <span className="text-xs text-neu-muted ml-auto">
                            {coffeeInsights.isRepeat ? 'повторный гость' : 'новый гость'}
                        </span>
                    </div>
                    <div className="card-body space-y-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <CoffeeMetric label="Заказов" value={coffeeInsights.ordersCount} />
                            <CoffeeMetric label="Возвратов" value={coffeeInsights.returnsCount} />
                            <CoffeeMetric label="Средний чек" value={coffeeInsights.averageCheck ? `${coffeeInsights.averageCheck} ₽` : '—'} />
                            <CoffeeMetric label="LTV" value={coffeeInsights.ltv ? `${coffeeInsights.ltv} ₽` : '—'} />
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <p className="text-xs text-neu-muted mb-2">Любимые позиции</p>
                                <div className="flex flex-wrap gap-2">
                                    {coffeeInsights.favoriteItems.length === 0 && <span className="text-sm text-neu-muted">Пока нет данных</span>}
                                    {coffeeInsights.favoriteItems.map((item) => (
                                        <span key={item.itemName} className="px-2.5 py-1 rounded-full text-xs font-semibold bg-accent/10 text-accent">
                                            {item.itemName} · {item.quantity}
                                        </span>
                                    ))}
                                </div>
                            </div>
                            <div>
                                <p className="text-xs text-neu-muted mb-2">Сегменты</p>
                                <div className="flex flex-wrap gap-2">
                                    {coffeeInsights.segments.map((segment) => (
                                        <span key={segment} className="px-2.5 py-1 rounded-full text-xs font-semibold bg-neu-base text-neu-text">
                                            {formatSegment(segment)}
                                        </span>
                                    ))}
                                    {coffeeInsights.segments.length === 0 && <span className="text-sm text-neu-muted">Сегменты не определены</span>}
                                </div>
                            </div>
                        </div>
                        <div className="rounded-xl p-3 bg-neu-base shadow-neu-inset-sm">
                            <p className="text-xs text-neu-muted mb-1">AI-заметка</p>
                            <p className="text-sm text-neu-text">{coffeeInsights.aiNote}</p>
                        </div>
                        {coffeeInsights.negativeFeedbacks.length > 0 && (
                            <div className="rounded-xl p-3 bg-red-500/10 border border-red-500/20">
                                <p className="text-xs text-red-300 mb-1">Негативный фидбек</p>
                                <p className="text-sm text-red-200">{coffeeInsights.negativeFeedbacks[0].text}</p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {!profile && !loadingProfile && (
                <div className="text-center py-16 rounded-xl neu-inset" style={{ border: '2px dashed rgba(255,255,255,0.06)' }}>
                    <Brain size={48} className="mx-auto text-neu-dim mb-4" />
                    <h3 className="text-lg font-semibold text-neu-text mb-2">Профиль не построен</h3>
                    <p className="text-sm text-neu-muted mb-4">
                        {messageCount < 3
                            ? `Недостаточно сообщений (${messageCount}/3). Нужно минимум 3 сообщения для анализа.`
                            : 'Нажмите «Построить профиль» для AI-анализа переписки.'}
                    </p>
                    {messageCount >= 3 && (
                        <button onClick={handleBuildProfile} disabled={buildingProfile} className="btn-primary mx-auto">
                            {buildingProfile ? <Loader2 size={16} className="animate-spin" /> : <Brain size={16} />}
                            Построить Digital Twin
                        </button>
                    )}
                </div>
            )}

            {profile && (
                <div className="space-y-6">
                    {/* Main stats row */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <MiniCard icon={<Heart size={18} />} label="Sentiment" value={`${Math.round(profile.sentimentScore * 100)}%`} color={sentimentColor} />
                        <MiniCard icon={<TrendingUp size={18} />} label="Конверсия" value={`${Math.round(profile.conversionProbability)}%`} color={convColor} />
                        <MiniCard icon={<MessageSquare size={18} />} label="Стиль" value={profile.communicationStyle === 'formal' ? 'Формальный' : profile.communicationStyle === 'emotional' ? 'Эмоциональный' : 'Обычный'} color="#8b5cf6" />
                        <MiniCard icon={<Clock size={18} />} label="Решения" value={profile.decisionSpeed === 'fast' ? 'Быстро' : profile.decisionSpeed === 'slow' ? 'Медленно' : 'Средне'} color="#3b82f6" />
                    </div>

                    {/* Profile details */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="card"><div className="card-header"><h3 className="font-semibold text-neu-text">🎯 Потребности</h3></div>
                            <div className="card-body"><p className="text-sm text-neu-text">{profile.needs || 'Не выявлены'}</p></div></div>
                        <div className="card"><div className="card-header"><h3 className="font-semibold text-neu-text">💰 Бюджет</h3></div>
                            <div className="card-body"><p className="text-sm text-neu-text">{profile.budget || 'Не указан'}</p></div></div>
                        <div className="card"><div className="card-header"><h3 className="font-semibold text-neu-text">⚠️ Возражения</h3></div>
                            <div className="card-body"><p className="text-sm text-neu-text">{profile.objections || 'Нет'}</p></div></div>
                        <div className="card"><div className="card-header"><h3 className="font-semibold text-neu-text">💡 Интересы</h3></div>
                            <div className="card-body">
                                {(() => {
                                    let interests: string[] = [];
                                    try { interests = JSON.parse(profile.interests || '[]'); } catch { interests = []; }
                                    return interests.length > 0 ? (
                                        <div className="flex flex-wrap gap-1.5">
                                            {interests.map((i: string, idx: number) => (
                                                <span key={idx} className="px-2.5 py-1 rounded-full text-xs font-semibold shadow-neu-raised-sm"
                                                    style={{ color: '#6c5ce7', background: 'rgba(108,92,231,0.1)' }}>{i}</span>
                                            ))}
                                        </div>
                                    ) : <p className="text-sm text-neu-muted">Не определены</p>;
                                })()}
                            </div></div>
                    </div>

                    {/* Optimal Contact Time */}
                    {contactTime && contactTime.bestSlots && contactTime.bestSlots.length > 0 && (
                        <div className="card">
                            <div className="card-header flex items-center gap-2">
                                <Clock size={18} className="text-accent" />
                                <h3 className="font-semibold text-neu-text">Лучшее время для связи</h3>
                                <span className="text-xs text-neu-muted ml-auto">Точность: {contactTime.confidence}%</span>
                            </div>
                            <div className="card-body">
                                <div className="grid grid-cols-3 gap-3">
                                    {contactTime.bestSlots.map((slot, idx) => (
                                        <div key={idx} className="rounded-xl p-3 text-center shadow-neu-inset-sm bg-neu-base">
                                            <p className="text-lg font-bold text-neu-text">{slot.day}</p>
                                            <p className="text-2xl font-bold text-accent">{slot.hour}:00</p>
                                            <p className="text-[10px] text-neu-muted mt-1">{slot.responseCount} ответов</p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Dynamic Pricing */}
                    {pricing && (
                        <div className="card">
                            <div className="card-header flex items-center gap-2">
                                <DollarSign size={18} className="text-green-400" />
                                <h3 className="font-semibold text-neu-text">Динамическое ценообразование</h3>
                            </div>
                            <div className="card-body">
                                <div className="flex items-center gap-4">
                                    <div className="text-center">
                                        <p className="text-3xl font-bold" style={{ color: pricing.discount > 0 ? '#22c55e' : '#a0a0a8' }}>
                                            {pricing.discount > 0 ? `-${pricing.discount}%` : '0%'}
                                        </p>
                                        <p className="text-xs text-neu-muted">Скидка</p>
                                    </div>
                                    <div className="flex-1">
                                        <p className="text-sm text-neu-text">{pricing.label}</p>
                                        <p className="text-xs text-neu-muted mt-1">{pricing.reasoning}</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Generate Offer */}
                    <div className="card">
                        <div className="card-header flex items-center gap-2">
                            <Gift size={18} className="text-pink-400" />
                            <h3 className="font-semibold text-neu-text">Персональное предложение</h3>
                        </div>
                        <div className="card-body">
                            {!offer ? (
                                <button onClick={handleGenerateOffer} disabled={loadingOffer}
                                    className="btn-secondary text-sm" style={{ color: '#ec4899' }}>
                                    {loadingOffer ? <Loader2 size={16} className="animate-spin" /> : <Gift size={16} />}
                                    Сгенерировать КП
                                </button>
                            ) : (
                                <div className="space-y-3">
                                    {offer.error ? (
                                        <p className="text-sm text-red-400">{offer.error}</p>
                                    ) : (
                                        <>
                                            <div className="rounded-xl p-4 shadow-neu-inset-sm bg-neu-base" style={{ borderLeft: '3px solid #ec4899' }}>
                                                <p className="text-sm text-neu-text leading-relaxed">{offer.offerText}</p>
                                            </div>
                                            {offer.discount > 0 && <p className="text-xs text-green-400">Скидка: {offer.discount}%</p>}
                                            {offer.reasoning && <p className="text-xs text-neu-muted">💡 {offer.reasoning}</p>}
                                            <button onClick={handleGenerateOffer} disabled={loadingOffer}
                                                className="flex items-center gap-2 text-xs text-pink-400 hover:text-pink-300 transition-colors">
                                                {loadingOffer ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                                                Перегенерировать
                                            </button>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Last update */}
                    {profile.lastProfileUpdate && (
                        <p className="text-xs text-neu-dim text-center">
                            Профиль обновлён: {formatBusinessDate(profile.lastProfileUpdate, true, currentInstance?.hotelTimezone)}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}

function formatOrderStatus(status: string) {
    const labels: Record<string, string> = {
        new: 'Новый',
        accepted: 'Принят',
        ready: 'Готов к выдаче',
        completed: 'Завершён',
        rejected: 'Отклонён',
        expired: 'Истёк'
    };
    return labels[status] || status;
}

function formatSegment(segment: string) {
    const labels: Record<string, string> = {
        new_guest: 'новый',
        repeat_guest: 'повторный',
        regular_guest: 'постоянный',
        unhappy_guest: 'недовольный',
        loves_coffee: 'любит кофе',
        orders_food: 'заказывает еду',
        evening_guest: 'вечерний гость',
    };
    return labels[segment] || segment;
}

function timelineLabel(item: SalesTimelineItem) {
    if (item.type === 'message') {
        return item.role === 'user' ? 'Сообщение клиента' : 'Ответ CRM';
    }
    if (item.type === 'tool_run') return 'Инструмент';
    if (item.type === 'ml_decision') return 'Решение модели';
    if (item.metadata?.kind === 'whatsapp_followup_draft') {
        return item.metadata.status === 'sent' ? 'WhatsApp follow-up отправлен' : 'Черновик WhatsApp follow-up';
    }
    if (item.metadata?.event_type === 'manager_task') return 'Задача менеджеру';
    if (item.channel === 'voice' || item.callId) return 'Звонок';
    return 'Событие CRM';
}

function formatObjectionMemory(value: string) {
    const labels: Record<string, string> = {
        price: 'цена',
        timing: 'сроки',
        trust: 'доверие'
    };
    return labels[value] || value;
}

function TimelineIcon({ item }: { item: SalesTimelineItem }) {
    const baseClass = 'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-neu-base shadow-neu-inset-sm';
    if (item.type === 'message') {
        return <div className={`${baseClass} text-blue-400`}><MessageSquare size={15} /></div>;
    }
    if (item.type === 'tool_run') {
        return <div className={`${baseClass} text-amber-400`}><Wrench size={15} /></div>;
    }
    if (item.type === 'ml_decision') {
        return <div className={`${baseClass} text-violet-400`}><Sparkles size={15} /></div>;
    }
    return <div className={`${baseClass} text-green-400`}><PhoneCall size={15} /></div>;
}

function CoffeeMetric({ label, value }: { label: string; value: string | number }) {
    return (
        <div className="rounded-xl p-3 bg-neu-base shadow-neu-inset-sm">
            <p className="text-xs text-neu-muted">{label}</p>
            <p className="text-lg font-bold text-neu-text mt-1">{value}</p>
        </div>
    );
}

function MemoryBlock({ title, items, empty }: { title: string; items: string[]; empty: string }) {
    return (
        <div className="rounded-xl p-3 bg-neu-base shadow-neu-inset-sm">
            <p className="text-xs text-neu-muted mb-2">{title}</p>
            {items.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                    {items.slice(0, 6).map((item, index) => (
                        <span
                            key={`${title}-${item}-${index}`}
                            className="px-2.5 py-1 rounded-full text-xs font-semibold bg-white/5 text-neu-text"
                        >
                            {item}
                        </span>
                    ))}
                </div>
            ) : (
                <p className="text-sm text-neu-muted">{empty}</p>
            )}
        </div>
    );
}

function MiniCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
    return (
        <div className="card p-4 hover:shadow-neu-hover transition-all duration-300">
            <div className="flex items-center gap-2 mb-2">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center shadow-neu-inset-sm"
                    style={{ backgroundColor: color + '12', color }}>{icon}</div>
            </div>
            <p className="text-lg font-bold text-neu-text">{value}</p>
            <p className="text-xs text-neu-muted">{label}</p>
        </div>
    );
}
