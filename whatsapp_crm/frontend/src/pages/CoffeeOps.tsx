import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle, BarChart3, CheckCircle2, Clock, Coffee, ClipboardList,
    Loader2, Plus, RefreshCw, Settings2, Trash2
} from 'lucide-react';
import { useInstance } from '../context/InstanceContext';
import {
    createCoffeeStopListItem,
    deleteCoffeeStopListItem,
    getCoffeeDashboard,
    getCoffeeItemAnalytics,
    getCoffeeOrderAnalytics,
    updateCoffeeOperationsMode,
    updateCoffeeStopListItem,
} from '../api';
import { isCoffeeBusiness } from '../businessProfiles';

type Dashboard = {
    settings: {
        mode: string;
        cafeHours: string;
        kitchenHours: string;
        prepTimeMinutes: number;
        busyPrepTimeMinutes: number;
        feedbackDelayMinutes: number;
    };
    today: {
        messages: number;
        clients: number;
        ordersCreated: number;
        ordersAccepted: number;
        ready: number;
        completed: number;
        rejected: number;
        expired: number;
        repeatOrders: number;
        avgAiResponseSeconds: number | null;
        avgBaristaAcceptSeconds: number | null;
        avgPrepSeconds: number | null;
    };
    losses: {
        askedButNoOrder: number;
        formedNotAccepted: number;
        rejected: number;
        expired: number;
        unstructuredOrders: number;
    };
    popularItems: ItemStat[];
    stopList: StopListItem[];
};

type Order = {
    id: number;
    clientName?: string;
    orderSummary: string;
    pickupTime?: string;
    status: string;
    createdAt: string;
};

type StopListItem = {
    id: number;
    itemName: string;
    reason?: string;
    addedBy?: string;
    isActive: number;
};

type ItemStat = {
    itemName: string;
    category?: string;
    quantity: number;
    orders: number;
    revenue?: number;
};

type ItemAnalytics = {
    topItems: ItemStat[];
    topCategories: { category: string; quantity: number; orders: number }[];
    topModifiers: { modifier: string; count: number }[];
    unstructuredOrders: number;
};

type OrderAnalytics = {
    active: Order[];
    latest: Order[];
};

const MODE_LABELS: Record<string, string> = {
    normal: 'Обычный режим',
    busy: 'Много заказов',
    kitchen_closed: 'Кухня закрыта',
    closed: 'Кофейня закрыта',
};

function fmtSeconds(value: number | null): string {
    if (value === null || value === undefined) return '—';
    if (value < 60) return `${value}с`;
    return `${Math.round(value / 60)}м`;
}

function statusLabel(status: string): string {
    const labels: Record<string, string> = {
        new: 'Передан бариста',
        accepted: 'Готовится',
        ready: 'Готов к выдаче',
        completed: 'Выдан',
        rejected: 'Отклонён',
        expired: 'Истёк',
    };
    return labels[status] || status;
}

export default function CoffeeOps() {
    const { currentInstance, currentInstanceId, refreshInstances } = useInstance();
    const [dashboard, setDashboard] = useState<Dashboard | null>(null);
    const [items, setItems] = useState<ItemAnalytics | null>(null);
    const [orders, setOrders] = useState<OrderAnalytics | null>(null);
    const [loading, setLoading] = useState(false);
    const [savingMode, setSavingMode] = useState(false);
    const [newStopItem, setNewStopItem] = useState('');
    const [newStopReason, setNewStopReason] = useState('');
    const [settings, setSettings] = useState({
        mode: 'normal',
        coffeeCafeHours: '09:00-00:00',
        coffeeKitchenHours: '09:00-22:00',
        coffeePrepTimeMinutes: 15,
        coffeeBusyPrepTimeMinutes: 25,
        coffeeFeedbackDelayMinutes: 90,
    });

    const isCoffee = isCoffeeBusiness(currentInstance);

    const loadData = useCallback(async () => {
        if (!currentInstanceId || !isCoffee) return;
        setLoading(true);
        try {
            const [dashboardRes, itemsRes, ordersRes] = await Promise.all([
                getCoffeeDashboard(currentInstanceId),
                getCoffeeItemAnalytics(currentInstanceId, 30),
                getCoffeeOrderAnalytics(currentInstanceId, 30),
            ]);
            if (dashboardRes.success) {
                setDashboard(dashboardRes.dashboard);
                setSettings({
                    mode: dashboardRes.dashboard.settings.mode,
                    coffeeCafeHours: dashboardRes.dashboard.settings.cafeHours,
                    coffeeKitchenHours: dashboardRes.dashboard.settings.kitchenHours,
                    coffeePrepTimeMinutes: dashboardRes.dashboard.settings.prepTimeMinutes,
                    coffeeBusyPrepTimeMinutes: dashboardRes.dashboard.settings.busyPrepTimeMinutes,
                    coffeeFeedbackDelayMinutes: dashboardRes.dashboard.settings.feedbackDelayMinutes,
                });
            }
            if (itemsRes.success) setItems(itemsRes.analytics);
            if (ordersRes.success) setOrders(ordersRes.analytics);
        } finally {
            setLoading(false);
        }
    }, [currentInstanceId, isCoffee]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    const activeOrders = useMemo(() => orders?.active || [], [orders]);
    const latestOrders = useMemo(() => orders?.latest || [], [orders]);
    const topItems = items?.topItems?.length ? items.topItems : dashboard?.popularItems || [];

    const saveMode = async () => {
        if (!currentInstanceId) return;
        setSavingMode(true);
        try {
            await updateCoffeeOperationsMode(currentInstanceId, settings);
            await refreshInstances();
            await loadData();
        } finally {
            setSavingMode(false);
        }
    };

    const addStopItem = async () => {
        if (!currentInstanceId || !newStopItem.trim()) return;
        await createCoffeeStopListItem(currentInstanceId, {
            itemName: newStopItem.trim(),
            reason: newStopReason.trim(),
            addedBy: 'CRM',
        });
        setNewStopItem('');
        setNewStopReason('');
        await loadData();
    };

    const toggleStopItem = async (item: StopListItem) => {
        if (!currentInstanceId) return;
        await updateCoffeeStopListItem(currentInstanceId, item.id, { isActive: !item.isActive });
        await loadData();
    };

    const removeStopItem = async (item: StopListItem) => {
        if (!currentInstanceId) return;
        await deleteCoffeeStopListItem(currentInstanceId, item.id);
        await loadData();
    };

    if (!currentInstance) {
        return <EmptyState title="Нет активного бизнеса" text="Создайте или выберите бизнес." />;
    }

    if (!isCoffee) {
        return (
            <EmptyState
                title="Раздел доступен для кофеен"
                text="Выберите тип бизнеса «Кофейня» в онбординге или настройках бизнеса."
            />
        );
    }

    return (
        <div className="max-w-7xl mx-auto">
            <div className="flex items-start justify-between gap-4 mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-neu-text">Кофейня</h1>
                    <p className="text-neu-muted mt-1">
                        AI-оператор, заказы, стоп-лист и операционная аналитика: <span className="text-accent font-medium">{currentInstance.name}</span>
                    </p>
                </div>
                <button className="btn-secondary flex items-center gap-2" onClick={loadData} disabled={loading}>
                    {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                    Обновить
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5 mb-6">
                <Kpi icon={<ClipboardList size={20} />} label="Заказов сегодня" value={dashboard?.today.ordersCreated ?? '—'} />
                <Kpi icon={<CheckCircle2 size={20} />} label="Выдано" value={dashboard?.today.completed ?? '—'} />
                <Kpi icon={<RefreshCw size={20} />} label="Повторные" value={dashboard?.today.repeatOrders ?? '—'} />
                <Kpi icon={<Clock size={20} />} label="Среднее приготовление" value={fmtSeconds(dashboard?.today.avgPrepSeconds ?? null)} />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 mb-6">
                <div className="card xl:col-span-2">
                    <div className="card-header flex items-center justify-between">
                        <h3 className="font-semibold text-neu-text flex items-center gap-2">
                            <BarChart3 size={18} className="text-accent" />
                            Сегодня
                        </h3>
                        <span className="text-xs text-neu-muted">AI: {fmtSeconds(dashboard?.today.avgAiResponseSeconds ?? null)}</span>
                    </div>
                    <div className="card-body grid grid-cols-2 md:grid-cols-4 gap-3">
                        <MiniMetric label="Обращений" value={dashboard?.today.clients ?? 0} />
                        <MiniMetric label="Принято" value={dashboard?.today.ordersAccepted ?? 0} />
                        <MiniMetric label="Готово" value={dashboard?.today.ready ?? 0} />
                        <MiniMetric label="Отклонено" value={dashboard?.today.rejected ?? 0} />
                        <MiniMetric label="Истекло" value={dashboard?.today.expired ?? 0} />
                        <MiniMetric label="Ждут бариста" value={dashboard?.losses.formedNotAccepted ?? 0} />
                        <MiniMetric label="Без структуры" value={dashboard?.losses.unstructuredOrders ?? 0} />
                        <MiniMetric label="Принятие бариста" value={fmtSeconds(dashboard?.today.avgBaristaAcceptSeconds ?? null)} />
                    </div>
                </div>

                <div className="card">
                    <div className="card-header">
                        <h3 className="font-semibold text-neu-text flex items-center gap-2">
                            <Settings2 size={18} className="text-accent" />
                            Режим работы
                        </h3>
                    </div>
                    <div className="card-body space-y-3">
                        <select
                            className="input"
                            value={settings.mode}
                            onChange={(e) => setSettings({ ...settings, mode: e.target.value })}
                        >
                            {Object.entries(MODE_LABELS).map(([mode, label]) => (
                                <option key={mode} value={mode}>{label}</option>
                            ))}
                        </select>
                        <TextInput label="Кофейня" value={settings.coffeeCafeHours} onChange={(value) => setSettings({ ...settings, coffeeCafeHours: value })} />
                        <TextInput label="Кухня" value={settings.coffeeKitchenHours} onChange={(value) => setSettings({ ...settings, coffeeKitchenHours: value })} />
                        <NumberInput label="Готовка, мин" value={settings.coffeePrepTimeMinutes} onChange={(value) => setSettings({ ...settings, coffeePrepTimeMinutes: value })} />
                        <NumberInput label="Загрузка, мин" value={settings.coffeeBusyPrepTimeMinutes} onChange={(value) => setSettings({ ...settings, coffeeBusyPrepTimeMinutes: value })} />
                        <button className="btn-primary w-full" onClick={saveMode} disabled={savingMode}>
                            {savingMode ? 'Сохраняю...' : 'Сохранить режим'}
                        </button>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 mb-6">
                <div className="card">
                    <div className="card-header">
                        <h3 className="font-semibold text-neu-text flex items-center gap-2">
                            <AlertTriangle size={18} className="text-amber-400" />
                            Стоп-лист
                        </h3>
                    </div>
                    <div className="card-body space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2">
                            <input className="input" placeholder="Позиция" value={newStopItem} onChange={(e) => setNewStopItem(e.target.value)} />
                            <input className="input" placeholder="Причина" value={newStopReason} onChange={(e) => setNewStopReason(e.target.value)} />
                            <button className="btn-primary flex items-center gap-2" onClick={addStopItem}>
                                <Plus size={16} />
                                Добавить
                            </button>
                        </div>
                        <div className="space-y-2">
                            {(dashboard?.stopList || []).length === 0 && (
                                <p className="text-sm text-neu-muted">Стоп-лист пуст. AI может предлагать все позиции из базы знаний.</p>
                            )}
                            {(dashboard?.stopList || []).map((item) => (
                                <div key={item.id} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-neu-surface-2">
                                    <div>
                                        <p className="font-medium text-neu-text">{item.itemName}</p>
                                        <p className="text-xs text-neu-muted">{item.reason || 'Без причины'}</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button className="btn-secondary text-xs" onClick={() => toggleStopItem(item)}>
                                            {item.isActive ? 'Отключить' : 'Включить'}
                                        </button>
                                        <button className="p-2 rounded-lg text-red-400 hover:bg-red-500/10" onClick={() => removeStopItem(item)}>
                                            <Trash2 size={16} />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="card">
                    <div className="card-header">
                        <h3 className="font-semibold text-neu-text flex items-center gap-2">
                            <Coffee size={18} className="text-accent" />
                            Популярные позиции
                        </h3>
                    </div>
                    <div className="card-body space-y-3">
                        {topItems.length === 0 && <p className="text-sm text-neu-muted">Пока нет структурированных позиций.</p>}
                        {topItems.slice(0, 10).map((item) => (
                            <div key={`${item.itemName}-${item.category || ''}`} className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm font-medium text-neu-text">{item.itemName}</p>
                                    <p className="text-xs text-neu-muted">{item.category || 'Без категории'} · {item.orders} заказов</p>
                                </div>
                                <span className="text-sm font-bold text-accent">{item.quantity}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                <OrdersCard title="Активные заказы" orders={activeOrders} />
                <OrdersCard title="Последние заказы" orders={latestOrders.slice(0, 10)} />
            </div>
        </div>
    );
}

function EmptyState({ title, text }: { title: string; text: string }) {
    return (
        <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-20 h-20 bg-neu-surface rounded-2xl flex items-center justify-center mb-4 shadow-neu-raised">
                <Coffee size={40} className="text-neu-muted" />
            </div>
            <h2 className="text-xl font-bold text-neu-text mb-2">{title}</h2>
            <p className="text-neu-muted mb-4">{text}</p>
        </div>
    );
}

function Kpi({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
    return (
        <div className="card p-5">
            <div className="w-10 h-10 rounded-xl bg-accent/10 text-accent flex items-center justify-center mb-3 shadow-neu-inset-sm">{icon}</div>
            <p className="text-2xl font-bold text-neu-text">{value}</p>
            <p className="text-sm text-neu-muted mt-1">{label}</p>
        </div>
    );
}

function MiniMetric({ label, value }: { label: string; value: string | number }) {
    return (
        <div className="p-3 rounded-xl bg-neu-surface-2">
            <p className="text-xs text-neu-muted">{label}</p>
            <p className="text-lg font-bold text-neu-text mt-1">{value}</p>
        </div>
    );
}

function TextInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
    return (
        <label className="block">
            <span className="text-xs text-neu-muted mb-1 block">{label}</span>
            <input className="input" value={value} onChange={(e) => onChange(e.target.value)} />
        </label>
    );
}

function NumberInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
    return (
        <label className="block">
            <span className="text-xs text-neu-muted mb-1 block">{label}</span>
            <input className="input" type="number" min={0} value={value} onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)} />
        </label>
    );
}

function OrdersCard({ title, orders }: { title: string; orders: Order[] }) {
    return (
        <div className="card">
            <div className="card-header">
                <h3 className="font-semibold text-neu-text">{title}</h3>
            </div>
            <div className="card-body space-y-3">
                {orders.length === 0 && <p className="text-sm text-neu-muted">Нет заказов.</p>}
                {orders.map((order) => (
                    <div key={order.id} className="p-3 rounded-xl bg-neu-surface-2">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-sm font-semibold text-neu-text">#{order.id} · {order.clientName || 'Клиент'}</p>
                                <p className="text-sm text-neu-muted mt-1">{order.orderSummary}</p>
                                <p className="text-xs text-neu-muted mt-1">{order.pickupTime || 'Время не указано'}</p>
                            </div>
                            <span className="text-xs px-2 py-1 rounded-lg bg-accent/10 text-accent whitespace-nowrap">
                                {statusLabel(order.status)}
                            </span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
