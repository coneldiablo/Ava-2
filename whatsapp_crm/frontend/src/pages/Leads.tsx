import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useInstance } from '../context/InstanceContext';
import { useAuth } from '../context/AuthContext';
import { useBusinessAccess } from '../permissions';
import { canOperateCustomer } from '../customerPermissions';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import CustomerListScope from './CustomerListScope';
import { selectCustomerRows } from './customerListHelpers';
import {
    getClients, deleteLead, updateClientStatus, getStatusHistory, getTemplates,
    updateClientTags, getAiSummary, getAiNextStep
} from '../api';
import {
    User, Clock, MessageSquare, AlertCircle, Brain, ChevronDown, ChevronUp,
    ArrowRight, Tag, X, Plus, Send, Flame, Filter, Sparkles, Target, Loader2,
    Search, LayoutGrid, List, ChevronRight, ArrowUpDown
} from 'lucide-react';
import { getPipeline } from '../businessProfiles';
import './Leads.css';

interface Client {
    id: number;
    instanceId: number;
    chatId: string;
    assigneeUserId?: string | null;
    senderName: string;
    leadStatus: string;
    lastMessage: string;
    lastMessageTime: string;
    lastStatusChangeAt: string;
    tags: string; // JSON array stored as string
    createdAt: string;
    updatedAt: string;
}

interface Template {
    id: number;
    instanceId: number;
    label: string;
    text: string;
}

interface StatusHistoryEntry {
    id: number;
    fromStatus: string;
    toStatus: string;
    reason: string;
    changedBy: string;
    createdAt: string;
}

// Tag colors cycle
const TAG_COLORS = [
    '#ef4444', '#f97316', '#f59e0b', '#22c55e', '#3b82f6',
    '#8b5cf6', '#ec4899', '#14b8a6', '#06b6d4', '#84cc16',
];

function getTagColor(tag: string): string {
    let hash = 0;
    for (let i = 0; i < tag.length; i++) {
        hash = tag.charCodeAt(i) + ((hash << 5) - hash);
    }
    return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

function parseTags(tagsStr: string | null | undefined): string[] {
    if (!tagsStr) return [];
    try {
        const parsed = JSON.parse(tagsStr);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

type SortMode = 'newest' | 'oldest' | 'burning' | 'alpha';
const SORT_OPTIONS: { id: SortMode; label: string }[] = [
    { id: 'newest', label: 'Новые ↑' },
    { id: 'oldest', label: 'Старые ↑' },
    { id: 'burning', label: 'Требуют внимания' },
    { id: 'alpha', label: 'А-Я' },
];

const CARDS_PER_PAGE = 10;

function getHoursStuck(dateStr: string | null | undefined): number {
    if (!dateStr) return 0;
    const then = new Date(dateStr).getTime();
    const now = Date.now();
    return Math.floor((now - then) / (1000 * 60 * 60));
}

function sortClients(clients: Client[], mode: SortMode): Client[] {
    const arr = [...clients];
    switch (mode) {
        case 'newest':
            return arr.sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
        case 'oldest':
            return arr.sort((a, b) => new Date(a.updatedAt || a.createdAt).getTime() - new Date(b.updatedAt || b.createdAt).getTime());
        case 'burning':
            return arr.sort((a, b) => {
                const ha = getHoursStuck(a.lastStatusChangeAt || a.updatedAt);
                const hb = getHoursStuck(b.lastStatusChangeAt || b.updatedAt);
                return hb - ha;
            });
        case 'alpha':
            return arr.sort((a, b) => (a.senderName || '').localeCompare(b.senderName || '', 'ru'));
        default:
            return arr;
    }
}

export default function ScopedLeads() {
    const { currentInstanceId } = useInstance();
    const access = useBusinessAccess();
    return <Leads key={`${currentInstanceId}:${access.userId}:${access.role}`} />;
}

function Leads() {
    const { role } = useAuth();
    const platformAdmin = role === 'platform_admin';
    const access = useBusinessAccess();
    const canWrite = !access.checking && access.can('sales.write');
    const canSend = !access.checking && access.can('messages.send');
    const navigate = useNavigate();
    const [listParams] = useSearchParams();
    const { currentInstanceId, currentInstance } = useInstance();
    const columns = useMemo(() => getPipeline(currentInstance), [currentInstance]);
    const statusOrder = useMemo(() => columns.filter(status => status.id !== 'junk').map(status => status.id), [columns]);
    const statusLabels = useMemo(
        () => Object.fromEntries(columns.map(status => [status.id, status.label])) as Record<string, string>,
        [columns]
    );
    const [clients, setClients] = useState<Client[]>([]);
    const [loading, setLoading] = useState(true);
    const [sourceReady, setSourceReady] = useState(false);
    const [clientError, setClientError] = useState('');
    const [templates, setTemplates] = useState<Template[]>([]);
    const [expandedCard, setExpandedCard] = useState<string | null>(null);
    const [statusHistory, setStatusHistory] = useState<Record<string, StatusHistoryEntry[]>>({});
    const [loadingHistory, setLoadingHistory] = useState<string | null>(null);
    const [tagFilter, setTagFilter] = useState<string[]>([]);
    const [sendingTemplate, setSendingTemplate] = useState<string | null>(null); // chatId:templateId
    const [sendSuccess] = useState<string | null>(null);
    // Per-card tag input state
    const [tagInputs, setTagInputs] = useState<Record<string, string>>({});
    const tagInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
    // AI Summary & Next Step state
    const [aiSummary, setAiSummary] = useState<Record<string, string>>({});
    const [aiNextStep, setAiNextStep] = useState<Record<string, string>>({});
    const [aiLoading, setAiLoading] = useState<Record<string, string>>({});
    // Scalability state
    const [searchQuery, setSearchQuery] = useState(listParams.get('q') || '');
    const [compactView, setCompactView] = useState(false);
    const [collapsedCols, setCollapsedCols] = useState<Record<string, boolean>>({});
    const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
    const [sortMode, setSortMode] = useState<SortMode>('newest');
    const [showSortMenu, setShowSortMenu] = useState(false);
    const sortMenuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!currentInstanceId) return;
        loadClients();
        loadTemplates();
        const interval = setInterval(loadClients, 15000);
        return () => clearInterval(interval);
    }, [currentInstanceId]);

    // Close sort menu on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
                setShowSortMenu(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const scopedClients = useMemo(() => selectCustomerRows(clients, listParams, access.role, access.userId), [clients, listParams, access.role, access.userId]);

    // Filtered clients by search
    const filteredClients = useMemo(() => {
        if (!searchQuery.trim()) return scopedClients;
        const q = searchQuery.toLowerCase().trim();
        return scopedClients.filter(c =>
            (c.senderName || '').toLowerCase().includes(q) ||
            c.chatId.replace('@c.us', '').includes(q) ||
            (c.lastMessage || '').toLowerCase().includes(q) ||
            parseTags(c.tags).some(t => t.toLowerCase().includes(q))
        );
    }, [scopedClients, searchQuery]);

    const toggleColumn = (colId: string) => {
        setCollapsedCols(prev => ({ ...prev, [colId]: !prev[colId] }));
    };

    const showMore = (colId: string) => {
        setVisibleCounts(prev => ({ ...prev, [colId]: (prev[colId] || CARDS_PER_PAGE) + CARDS_PER_PAGE }));
    };

    const loadClients = useCallback(async () => {
        if (!currentInstanceId) return;
        setLoading(true);
        try {
            const data = await getClients(currentInstanceId);
            if (!data.success || !Array.isArray(data.clients)) throw new Error('clients_unavailable');
            if (data.clients.some((client: Client) => client.instanceId !== currentInstanceId)) throw new Error('client_scope_mismatch');
            setClients(data.clients); setSourceReady(true); setClientError('');
        } catch (e) {
            console.error('Failed to load clients', e);
            setSourceReady(false); setClientError('Не удалось обновить клиентов. Повторите загрузку.');
        }
        setLoading(false);
    }, [currentInstanceId]);

    const loadTemplates = useCallback(async () => {
        if (!currentInstanceId) return;
        try {
            const data = await getTemplates(currentInstanceId);
            if (data.success) setTemplates(data.templates || []);
        } catch (e) {
            console.error('Failed to load templates', e);
        }
    }, [currentInstanceId]);

    const loadStatusHistory = async (chatId: string) => {
        if (!currentInstanceId) return;
        setLoadingHistory(chatId);
        try {
            const data = await getStatusHistory(currentInstanceId, chatId);
            if (data.success) {
                setStatusHistory(prev => ({ ...prev, [chatId]: data.history || [] }));
            }
        } catch (e) {
            console.error('Failed to load status history', e);
        }
        setLoadingHistory(null);
    };

    const toggleCard = (chatId: string) => {
        if (expandedCard === chatId) {
            setExpandedCard(null);
        } else {
            setExpandedCard(chatId);
            if (!statusHistory[chatId]) {
                loadStatusHistory(chatId);
            }
        }
    };

    const handleDrop = async (e: React.DragEvent<HTMLDivElement>, status: string) => {
        e.preventDefault();
        const chatId = e.dataTransfer.getData('chatId');
        if (!canWrite || !chatId || !currentInstanceId) return;

        const clientIndex = clients.findIndex(c => c.chatId === chatId);
        if (clientIndex === -1 || !canOperateCustomer(access, clients[clientIndex], 'sales.write')) return;

        const originalStatus = clients[clientIndex].leadStatus;
        if (originalStatus === status) return;

        let isBackward = false;
        if (status !== 'junk') {
            const fromIdx = statusOrder.indexOf(originalStatus);
            const toIdx = statusOrder.indexOf(status);
            if (fromIdx !== -1 && toIdx !== -1 && toIdx < fromIdx) {
                isBackward = true;
            }
        }
        if (originalStatus === 'junk' && status !== 'junk') {
            isBackward = true;
        }

        if (isBackward) {
            const fromLabel = statusLabels[originalStatus] || originalStatus;
            const toLabel = statusLabels[status] || status;
            const clientName = clients[clientIndex].senderName || clients[clientIndex].chatId;
            if (!confirm(
                `⚠️ Перемещение назад по воронке!\n\n` +
                `Клиент: ${clientName}\n` +
                `Из: "${fromLabel}" → В: "${toLabel}"\n\n` +
                `Это действие администратора. Продолжить?`
            )) {
                return;
            }
        }

        const newClients = [...clients];
        newClients[clientIndex] = { ...newClients[clientIndex], leadStatus: status };
        setClients(newClients);

        try {
            const result = await updateClientStatus(currentInstanceId, chatId, status);
            if (!result.success) throw new Error('Update failed');
            loadStatusHistory(chatId);
        } catch (error) {
            console.error('Failed to update status', error);
            const revertedClients = [...newClients];
            revertedClients[clientIndex] = { ...revertedClients[clientIndex], leadStatus: originalStatus };
            setClients(revertedClients);
        }
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        if (!canWrite) return;
        e.preventDefault();
        e.currentTarget.classList.add('ring-2', 'ring-[#00c2ff]');
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        e.currentTarget.classList.remove('ring-2', 'ring-[#00c2ff]');
    };

    const handleSendTemplate = async (chatId: string, templateId: number, _text: string) => {
        if (!canSend || !currentInstanceId || !canOperateCustomer(access, clients.find(client => client.chatId === chatId), 'messages.send')) return;
        setSendingTemplate(`${chatId}:${templateId}`);
        navigate(`/today?client=${encodeURIComponent(chatId)}&template=${templateId}`);
    };

    const handleAddTag = async (chatId: string, newTag: string) => {
        const trimmed = newTag.trim().replace(/\s+/g, '_');
        if (!canWrite || !trimmed || !currentInstanceId) return;

        const client = clients.find(c => c.chatId === chatId);
        if (!client || !canOperateCustomer(access, client, 'sales.write')) return;

        const existingTags = parseTags(client.tags);
        if (existingTags.includes(trimmed)) return;

        const updatedTags = [...existingTags, trimmed];

        // Optimistic update
        setClients(prev => prev.map(c =>
            c.chatId === chatId ? { ...c, tags: JSON.stringify(updatedTags) } : c
        ));
        setTagInputs(prev => ({ ...prev, [chatId]: '' }));

        try {
            await updateClientTags(currentInstanceId, chatId, updatedTags);
        } catch (e) {
            console.error('Failed to update tags', e);
            // Revert
            setClients(prev => prev.map(c =>
                c.chatId === chatId ? { ...c, tags: client.tags } : c
            ));
        }
    };

    const handleRemoveTag = async (chatId: string, tagToRemove: string) => {
        if (!canWrite || !currentInstanceId) return;

        const client = clients.find(c => c.chatId === chatId);
        if (!client || !canOperateCustomer(access, client, 'sales.write')) return;

        const existingTags = parseTags(client.tags);
        const updatedTags = existingTags.filter(t => t !== tagToRemove);

        setClients(prev => prev.map(c =>
            c.chatId === chatId ? { ...c, tags: JSON.stringify(updatedTags) } : c
        ));

        try {
            await updateClientTags(currentInstanceId, chatId, updatedTags);
        } catch (e) {
            console.error('Failed to remove tag', e);
            setClients(prev => prev.map(c =>
                c.chatId === chatId ? { ...c, tags: client.tags } : c
            ));
        }
    };

    const handleDeleteLead = async (chatId: string) => {
        if (!platformAdmin || !canWrite || !currentInstanceId) return;
        
        const client = clients.find(c => c.chatId === chatId);
        if (!client || !canOperateCustomer(access, client, 'sales.write')) return;

        const clientName = client.senderName || client.chatId.replace('@c.us', '');
        
        if (!confirm(
            `⚠️ Удалить лида и всю историю?\n\n` +
            `Клиент: ${clientName}\n` +
            `Это действие удалит ВСЕ данные: сообщения, историю статусов, профили и т.д.\n\n` +
            `После удаления клиент сможет написать снова и будет распознан как новый.\n\n` +
            `Продолжить?`
        )) {
            return;
        }

        // Optimistic removal
        setClients(prev => prev.filter(c => c.chatId !== chatId));

        try {
            await deleteLead(currentInstanceId, chatId);
        } catch (e) {
            console.error('Failed to delete lead', e);
            // Revert on error
            loadClients();
            alert('Ошибка при удалении лида. Попробуйте ещё раз.');
        }
    };

    const toggleTagFilter = (tag: string) => {
        setTagFilter(prev =>
            prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
        );
    };

    // Collect all unique tags across all clients
    const allTags = Array.from(new Set(
        clients.flatMap(c => parseTags(c.tags))
    )).sort();

    const totalFiltered = filteredClients.length;
    const totalAll = clients.length;
    const needsAttention = clients.filter(client => getHoursStuck(client.lastStatusChangeAt || client.updatedAt) >= 24).length;
    const inProgress = clients.filter(client => client.leadStatus !== 'new' && client.leadStatus !== 'junk' && client.leadStatus !== 'booked' && client.leadStatus !== 'pickup_confirmed').length;

    if (!currentInstanceId) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-center">
                <div className="w-20 h-20 bg-[#22262f] rounded-2xl flex items-center justify-center mb-4">
                    <AlertCircle size={40} className="text-[#8b8fa3]" />
                </div>
                <h2 className="text-xl font-bold text-white mb-2">Нет активного бизнеса</h2>
                <p className="text-[#8b8fa3] mb-4">Выберите бизнес в левом меню для просмотра лидов.</p>
            </div>
        );
    }

    return (
        <div className="ava-sales-page ava-sales-board h-[calc(100vh-6rem)] flex flex-col">
            {/* Header */}
            <div className="ava-sales-heading mb-3">
                <div className="flex items-center justify-between flex-wrap gap-3">
                    <div>
                        <span className="ava-sales-eyebrow">AVA / Клиенты</span>
                        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
                            <Brain size={25} className="ava-sales-ai-icon" aria-hidden="true" />
                            Воронка клиентов
                        </h1>
                        <p className="text-[#8b8fa3] mt-1 text-sm">
                            {canWrite ? 'Управляйте этапами клиентов. Перетащите карточку или откройте таблицу для изменения статуса с клавиатуры.' : 'Просматривайте этапы клиентов и историю общения.'}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-[#8b8fa3]">
                        <span className="bg-[#22262f] px-2.5 py-1 rounded-lg border border-[#2a2e3a]">
                            {!sourceReady ? '—' : totalFiltered === totalAll
                                ? `${totalAll} лидов`
                                : `${totalFiltered} из ${totalAll}`}
                        </span>
                        <Link
                            to={`/clients?${listParams.toString()}`}
                            className="flex items-center gap-1.5 bg-[#1e2128] border border-[#2a2e3a] rounded-lg px-3 py-1.5 text-[#8b8fa3] hover:text-[#00c2ff] hover:border-[#00c2ff]/40 transition-colors"
                        >
                            <User size={13} />
                            Таблица
                        </Link>
                    </div>
                </div>
            </div>

            <CustomerListScope role={access.role} />
            {clientError && <p role="alert">{clientError} <button type="button" onClick={() => void loadClients()}>Повторить</button></p>}
            <div className="ava-sales-kpis" aria-label="Показатели воронки">
                <div className="ava-sales-kpi ava-sales-kpi-dark"><span>Всего клиентов</span><strong>{sourceReady ? totalAll.toLocaleString('ru-RU') : '—'}</strong><small>В текущем бизнесе</small></div>
                <div className="ava-sales-kpi"><span>В работе</span><strong>{sourceReady ? inProgress.toLocaleString('ru-RU') : '—'}</strong><small>На этапах воронки</small></div>
                <div className="ava-sales-kpi"><span>Требуют внимания</span><strong>{sourceReady ? needsAttention.toLocaleString('ru-RU') : '—'}</strong><small>Без смены статуса более 24 часов</small></div>
            </div>

            {/* Toolbar: Search + View Toggle + Sort */}
            <div className="mb-3 flex items-center gap-2 flex-wrap">
                {/* Search */}
                <div className="relative flex-1 min-w-[200px] max-w-[360px]">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6b6f80]" />
                    <input
                        type="text"
                        aria-label="Поиск клиентов в воронке"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="Поиск по имени, телефону, сообщению, тегу..."
                        className="w-full bg-[#1e2128] border border-[#2a2e3a] rounded-lg pl-9 pr-8 py-2 text-sm text-white placeholder-[#6b6f80] outline-none focus:border-[#00c2ff] transition-colors"
                    />
                    {searchQuery && (
                        <button
                            onClick={() => setSearchQuery('')}
                            aria-label="Очистить поиск"
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6b6f80] hover:text-white"
                        >
                            <X size={14} />
                        </button>
                    )}
                </div>

                {/* Sort */}
                <div className="relative" ref={sortMenuRef}>
                    <button
                        onClick={() => setShowSortMenu(!showSortMenu)}
                        aria-expanded={showSortMenu}
                        className="flex items-center gap-1.5 bg-[#1e2128] border border-[#2a2e3a] rounded-lg px-3 py-2 text-xs text-[#8b8fa3] hover:border-[#3a3e4a] transition-colors"
                    >
                        <ArrowUpDown size={13} />
                        {SORT_OPTIONS.find(s => s.id === sortMode)?.label}
                    </button>
                    {showSortMenu && (
                        <div className="absolute top-full mt-1 right-0 bg-[#22262f] border border-[#2a2e3a] rounded-lg shadow-xl z-50 min-w-[140px] py-1">
                            {SORT_OPTIONS.map(opt => (
                                <button
                                    key={opt.id}
                                    onClick={() => { setSortMode(opt.id); setShowSortMenu(false); }}
                                    className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                                        sortMode === opt.id
                                            ? 'text-[#00c2ff] bg-[#00c2ff]/10'
                                            : 'text-[#8b8fa3] hover:text-white hover:bg-[#2a2e3a]'
                                    }`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* View Toggle */}
                <div className="flex items-center bg-[#1e2128] border border-[#2a2e3a] rounded-lg overflow-hidden">
                    <button
                        onClick={() => setCompactView(false)}
                        aria-label="Полные карточки"
                        aria-pressed={!compactView}
                        className={`p-2 transition-colors ${!compactView ? 'bg-[#00c2ff]/15 text-[#00c2ff]' : 'text-[#6b6f80] hover:text-[#8b8fa3]'}`}
                        title="Полные карточки"
                    >
                        <LayoutGrid size={14} />
                    </button>
                    <button
                        onClick={() => setCompactView(true)}
                        aria-label="Компактный вид"
                        aria-pressed={compactView}
                        className={`p-2 transition-colors ${compactView ? 'bg-[#00c2ff]/15 text-[#00c2ff]' : 'text-[#6b6f80] hover:text-[#8b8fa3]'}`}
                        title="Компактный вид"
                    >
                        <List size={14} />
                    </button>
                </div>
            </div>

            {/* Tag Filter Bar */}
            {allTags.length > 0 && (
                <div className="mb-3 flex items-center gap-2 flex-wrap">
                    <div className="flex items-center gap-1.5 text-[#8b8fa3] text-xs">
                        <Filter size={13} />
                        <span>Теги:</span>
                    </div>
                    {allTags.map(tag => {
                        const color = getTagColor(tag);
                        const isActive = tagFilter.includes(tag);
                        return (
                            <button
                                key={tag}
                                onClick={() => toggleTagFilter(tag)}
                                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition-all border"
                                style={{
                                    backgroundColor: isActive ? color + '30' : 'transparent',
                                    color: isActive ? color : '#8b8fa3',
                                    borderColor: isActive ? color + '60' : '#2a2e3a',
                                }}
                            >
                                #{tag}
                                {isActive && <X size={10} />}
                            </button>
                        );
                    })}
                    {tagFilter.length > 0 && (
                        <button
                            onClick={() => setTagFilter([])}
                            className="text-xs text-[#6b6f80] hover:text-white transition-colors ml-1"
                        >
                            Сбросить
                        </button>
                    )}
                </div>
            )}

            {loading && clients.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                    <div className="w-8 h-8 border-2 border-[#00c2ff] border-t-transparent rounded-full animate-spin"></div>
                </div>
            ) : (
                <div className="ava-sales-columns flex-1 flex gap-3 overflow-x-auto pb-4 kanban-scroll" aria-label="Этапы воронки">
                    {columns.map(col => {
                        const allIds = columns.map(x => x.id);
                        let colClients = filteredClients.filter(c =>
                            c.leadStatus === col.id || (col.id === 'new' && !allIds.includes(c.leadStatus))
                        );
                        // Apply tag filter
                        if (tagFilter.length > 0) {
                            colClients = colClients.filter(c => {
                                const tags = parseTags(c.tags);
                                return tagFilter.some(f => tags.includes(f));
                            });
                        }
                        // Apply sort
                        colClients = sortClients(colClients, sortMode);

                        const isCollapsed = collapsedCols[col.id] || false;
                        const visibleCount = visibleCounts[col.id] || CARDS_PER_PAGE;
                        const visibleClients = colClients.slice(0, visibleCount);
                        const hasMore = colClients.length > visibleCount;
                        const remaining = colClients.length - visibleCount;

                        // Collapsed column
                        if (isCollapsed) {
                            return (
                                <div
                                    key={col.id}
                                    className="w-[44px] flex-shrink-0 flex flex-col bg-[#1e2128] border border-[#2a2e3a] rounded-xl overflow-hidden transition-all cursor-pointer hover:bg-[#22262f]"
                                    onClick={() => toggleColumn(col.id)}
                                    role="button"
                                    tabIndex={0}
                                    aria-label={`Развернуть этап ${col.title}`}
                                    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleColumn(col.id); } }}
                                    onDrop={(e) => { e.currentTarget.classList.remove('ring-2', 'ring-[#00c2ff]'); handleDrop(e, col.id); }}
                                    onDragOver={handleDragOver}
                                    onDragLeave={handleDragLeave}
                                >
                                    <div className="flex flex-col items-center py-4 gap-2">
                                        <ChevronRight size={14} className="text-[#6b6f80]" />
                                        <span className="ava-stage-dot" aria-hidden="true" />
                                        <span
                                            className="text-xs font-bold px-1.5 py-0.5 rounded-md min-w-[20px] text-center"
                                            style={{ backgroundColor: col.color + '20', color: col.color }}
                                        >
                                            {sourceReady ? colClients.length : '—'}
                                        </span>
                                        <span className="text-[10px] text-[#6b6f80] writing-vertical" style={{ writingMode: 'vertical-lr', textOrientation: 'mixed' }}>
                                            {col.title}
                                        </span>
                                    </div>
                                </div>
                            );
                        }

                        return (
                            <div
                                key={col.id}
                                className={`flex-shrink-0 flex flex-col bg-[#1e2128] border border-[#2a2e3a] rounded-xl overflow-hidden transition-all ${compactView ? 'w-[260px]' : 'w-[300px]'}`}
                                onDrop={(e) => { e.currentTarget.classList.remove('ring-2', 'ring-[#00c2ff]'); handleDrop(e, col.id); }}
                                onDragOver={handleDragOver}
                                onDragLeave={handleDragLeave}
                            >
                                {/* Column Header */}
                                <div className="px-3 py-2.5 border-b border-[#2a2e3a] flex items-center justify-between sticky top-0 bg-[#1e2128]/95 backdrop-blur z-10">
                                    <button
                                        onClick={() => toggleColumn(col.id)}
                                        aria-expanded="true"
                                        aria-label={`Свернуть этап ${col.title}`}
                                        className="flex items-center gap-2 hover:opacity-80 transition-opacity"
                                        title="Свернуть колонку"
                                    >
                                        <ChevronDown size={13} className="text-[#6b6f80]" />
                                        <span className="ava-stage-dot" aria-hidden="true" />
                                        <h3 className="font-semibold text-white text-sm">{col.title}</h3>
                                    </button>
                                    <span
                                        className="text-xs font-bold px-2 py-0.5 rounded-md min-w-[24px] text-center"
                                        style={{ backgroundColor: col.color + '20', color: col.color }}
                                    >
                                        {sourceReady ? colClients.length : '—'}
                                    </span>
                                </div>

                                {/* Cards List */}
                                <div className="flex-1 overflow-y-auto p-2 space-y-2 kanban-scroll">
                                    {visibleClients.map(client => {
                                        const isExpanded = expandedCard === client.chatId;
                                        const history = statusHistory[client.chatId] || [];
                                        const isLoadingHist = loadingHistory === client.chatId;
                                        const tags = parseTags(client.tags);
                                        const hoursStuck = getHoursStuck(client.lastStatusChangeAt || client.updatedAt);
                                        const isBurning = hoursStuck >= 24;
                                        const tagInput = tagInputs[client.chatId] || '';
                                        const cardCanWrite = canOperateCustomer(access, client, 'sales.write');
                                        const cardCanSend = canOperateCustomer(access, client, 'messages.send');
                                        const cardCanUseAi = canOperateCustomer(access, client, 'ai.use');

                                        /* ===== COMPACT VIEW ===== */
                                        if (compactView) {
                                            return (
                                                <div
                                                    key={client.chatId}
                                                    draggable={cardCanWrite}
                                                    onDragStart={(e) => { if (cardCanWrite) e.dataTransfer.setData('chatId', client.chatId); }}
                                                    className={`flex items-center gap-2 bg-[#22262f] border rounded-lg px-2.5 py-1.5 cursor-grab active:cursor-grabbing transition-all group ${
                                                        isBurning
                                                            ? 'border-orange-500/40'
                                                            : 'border-[#2a2e3a] hover:border-gray-500'
                                                    }`}
                                                >
                                                    {isBurning && <Flame size={11} className="text-orange-400 flex-shrink-0" />}
                                                    <span className="text-xs text-[#e4e6eb] truncate flex-1 font-medium">
                                                        {client.senderName || client.chatId.replace('@c.us', '')}
                                                    </span>
                                                    {tags.length > 0 && (
                                                        <span className="text-[9px] text-[#6b6f80] flex-shrink-0">#{tags[0]}{tags.length > 1 ? ` +${tags.length - 1}` : ''}</span>
                                                    )}
                                                    {client.lastMessageTime && (
                                                        <span className="text-[9px] text-[#4a4d5a] flex-shrink-0">
                                                            {new Date(client.lastMessageTime).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                                                        </span>
                                                    )}
                                                    <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                                        <Link
                                                            to={`/conversations?client=${encodeURIComponent(client.chatId)}`}
                                                            className="text-[#6b6f80] hover:text-white"
                                                            title="Диалог"
                                                            aria-label={`Открыть диалог ${client.senderName || client.chatId}`}
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
                                                            <MessageSquare size={11} />
                                                        </Link>
                                                        <Link
                                                            to={platformAdmin ? `/client/${encodeURIComponent(client.chatId)}` : `/customers/${encodeURIComponent(client.chatId)}`}
                                                            className="text-[#6b6f80] hover:text-purple-400"
                                                            title="Профиль клиента"
                                                            aria-label={`Открыть профиль ${client.senderName || client.chatId}`}
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
                                                            <User size={11} />
                                                        </Link>
                                                        {platformAdmin && <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleDeleteLead(client.chatId);
                                                            }}
                                                            className="text-[#6b6f80] hover:text-red-400"
                                                            title="Удалить лида и всю историю"
                                                        >
                                                            <X size={11} />
                                                        </button>}
                                                    </div>
                                                </div>
                                            );
                                        }

                                        /* ===== FULL VIEW ===== */
                                        return (
                                            <div
                                                key={client.chatId}
                                                draggable={cardCanWrite}
                                                onDragStart={(e) => { if (cardCanWrite) e.dataTransfer.setData('chatId', client.chatId); }}
                                                className={`bg-[#22262f] border rounded-lg cursor-grab active:cursor-grabbing transition-all group ${isBurning
                                                    ? 'border-orange-500/40 shadow-[0_0_12px_rgba(249,115,22,0.15)]'
                                                    : 'border-[#2a2e3a] hover:border-gray-500'
                                                    }`}
                                            >
                                                {/* Card Header */}
                                                <div className="p-3 pb-2">
                                                    <div className="flex items-start justify-between mb-1.5">
                                                        <div className="flex items-center gap-2 font-medium text-[#e4e6eb] truncate text-sm">
                                                            <User size={14} className="text-[#8b8fa3] flex-shrink-0" />
                                                            <span className="truncate">{client.senderName}</span>
                                                        </div>
                                                        <div className="flex items-center gap-1.5 flex-shrink-0">
                                                            {/* 🔥 Burning Badge */}
                                                            {isBurning && (
                                                                <span
                                                                    className="flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/30"
                                                                    title={`Лид не двигался ${hoursStuck}ч`}
                                                                >
                                                                    <Flame size={9} />
                                                                    {hoursStuck >= 48
                                                                        ? `${Math.floor(hoursStuck / 24)}д`
                                                                        : `${hoursStuck}ч`}
                                                                </span>
                                                            )}
                                                            <Link
                                                                to={platformAdmin ? `/client/${encodeURIComponent(client.chatId)}` : `/customers/${encodeURIComponent(client.chatId)}`}
                                                                className="text-[#8b8fa3] hover:text-purple-400 transition-colors"
                                                                title="Профиль клиента"
                                                                onClick={(e) => e.stopPropagation()}
                                                            >
                                                                <User size={14} />
                                                            </Link>
                                                            <Link
                                                                to={`/conversations?client=${encodeURIComponent(client.chatId)}`}
                                                                className="text-[#8b8fa3] hover:text-white transition-colors"
                                                                title="Перейти к диалогу"
                                                                onClick={(e) => e.stopPropagation()}
                                                            >
                                                                <MessageSquare size={14} />
                                                            </Link>
                                                            {platformAdmin && <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleDeleteLead(client.chatId);
                                                                }}
                                                                className="text-[#8b8fa3] hover:text-red-400 transition-colors"
                                                                title="Удалить лида и всю историю"
                                                            >
                                                                <X size={14} />
                                                            </button>}
                                                        </div>
                                                    </div>

                                                    {client.lastMessage && (
                                                        <p className="text-xs text-[#8b8fa3] line-clamp-2 mb-1.5 bg-[#1e2128] p-2 rounded border border-[#2a2e3a]/50">
                                                            {client.lastMessage}
                                                        </p>
                                                    )}

                                                    {/* Tags Display */}
                                                    {tags.length > 0 && (
                                                        <div className="flex flex-wrap gap-1 mb-1.5">
                                                            {tags.map(tag => {
                                                                const color = getTagColor(tag);
                                                                return (
                                                                    <span
                                                                        key={tag}
                                                                        role={cardCanWrite ? 'button' : undefined}
                                                                        tabIndex={cardCanWrite ? 0 : undefined}
                                                                        aria-label={cardCanWrite ? `Удалить метку ${tag}` : undefined}
                                                                        onKeyDown={event => { if (cardCanWrite && ['Enter', ' '].includes(event.key)) { event.preventDefault(); void handleRemoveTag(client.chatId, tag); } }}
                                                                        className={`flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium group/tag ${cardCanWrite ? 'cursor-pointer hover:opacity-80' : ''}`}
                                                                        style={{ backgroundColor: color + '20', color }}
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            handleRemoveTag(client.chatId, tag);
                                                                        }}
                                                                        title={cardCanWrite ? 'Нажмите чтобы удалить тег' : undefined}
                                                                    >
                                                                        #{tag}
                                                                        {cardCanWrite && <X size={8} className="opacity-0 group-hover/tag:opacity-100 transition-opacity" />}
                                                                    </span>
                                                                );
                                                            })}
                                                        </div>
                                                    )}

                                                    {/* Tag Input */}
                                                    {cardCanWrite && <div className="flex items-center gap-1 mb-1">
                                                        <Tag size={11} className="text-[#6b6f80] flex-shrink-0" />
                                                        <input
                                                            ref={el => { tagInputRefs.current[client.chatId] = el; }}
                                                            type="text"
                                                            value={tagInput}
                                                            placeholder="+ тег..."
                                                            className="flex-1 bg-transparent text-[11px] text-[#8b8fa3] placeholder-[#4a4d5a] outline-none min-w-0"
                                                            onChange={(e) => setTagInputs(prev => ({ ...prev, [client.chatId]: e.target.value }))}
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter' || e.key === ' ' || e.key === ',') {
                                                                    e.preventDefault();
                                                                    handleAddTag(client.chatId, tagInput);
                                                                }
                                                            }}
                                                            onClick={(e) => e.stopPropagation()}
                                                            onDragStart={(e) => e.stopPropagation()}
                                                        />
                                                        {tagInput && (
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleAddTag(client.chatId, tagInput);
                                                                }}
                                                                className="text-[#00c2ff] hover:text-white transition-colors"
                                                            >
                                                                <Plus size={11} />
                                                            </button>
                                                        )}
                                                    </div>}

                                                    <div className="flex items-center justify-between text-[11px] text-[#6b6f80]">
                                                        <span>{client.chatId.replace('@c.us', '')}</span>
                                                        {client.lastMessageTime && (
                                                            <div className="flex items-center gap-1">
                                                                <Clock size={12} />
                                                                {new Date(client.lastMessageTime).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>

                                                {/* AI Summary & Next Step */}
                                                {cardCanUseAi && <div className="px-3 pb-2 border-t border-[#2a2e3a]/50 pt-2">
                                                    <div className="flex gap-1.5 mb-1">
                                                        <button
                                                            onClick={async (e) => {
                                                                e.stopPropagation();
                                                                if (!cardCanUseAi || !currentInstanceId || aiLoading[client.chatId]) return;
                                                                setAiLoading(p => ({ ...p, [client.chatId]: 'summary' }));
                                                                try {
                                                                    const res = await getAiSummary(currentInstanceId, client.chatId);
                                                                    setAiSummary(p => ({ ...p, [client.chatId]: res.summary || 'Нет данных' }));
                                                                } catch { setAiSummary(p => ({ ...p, [client.chatId]: 'Ошибка загрузки' })); }
                                                                setAiLoading(p => ({ ...p, [client.chatId]: '' }));
                                                            }}
                                                            disabled={aiLoading[client.chatId] === 'summary'}
                                                            className="flex-1 flex items-center justify-center gap-1 text-[10px] px-2 py-1.5 rounded-md border bg-purple-500/10 border-purple-500/20 text-purple-400 hover:bg-purple-500/20 transition-all disabled:opacity-50"
                                                        >
                                                            {aiLoading[client.chatId] === 'summary' ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                                                            Резюме
                                                        </button>
                                                        <button
                                                            onClick={async (e) => {
                                                                e.stopPropagation();
                                                                if (!cardCanUseAi || !currentInstanceId || aiLoading[client.chatId]) return;
                                                                setAiLoading(p => ({ ...p, [client.chatId]: 'nextstep' }));
                                                                try {
                                                                    const res = await getAiNextStep(currentInstanceId, client.chatId);
                                                                    setAiNextStep(p => ({ ...p, [client.chatId]: res.nextStep || res.action || 'Нет рекомендаций' }));
                                                                } catch { setAiNextStep(p => ({ ...p, [client.chatId]: 'Ошибка загрузки' })); }
                                                                setAiLoading(p => ({ ...p, [client.chatId]: '' }));
                                                            }}
                                                            disabled={aiLoading[client.chatId] === 'nextstep'}
                                                            className="flex-1 flex items-center justify-center gap-1 text-[10px] px-2 py-1.5 rounded-md border bg-amber-500/10 border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-all disabled:opacity-50"
                                                        >
                                                            {aiLoading[client.chatId] === 'nextstep' ? <Loader2 size={10} className="animate-spin" /> : <Target size={10} />}
                                                            Следующий шаг
                                                        </button>
                                                    </div>
                                                    {aiSummary[client.chatId] && (
                                                        <div className="bg-purple-500/5 border border-purple-500/15 rounded-lg px-2.5 py-2 mb-1">
                                                            <p className="text-[10px] text-purple-300/70 font-medium mb-0.5 flex items-center gap-1"><Sparkles size={9} /> Резюме:</p>
                                                            <p className="text-[10px] text-[#e4e6eb] leading-relaxed">{aiSummary[client.chatId]}</p>
                                                        </div>
                                                    )}
                                                    {aiNextStep[client.chatId] && (
                                                        <div className="bg-amber-500/5 border border-amber-500/15 rounded-lg px-2.5 py-2">
                                                            <p className="text-[10px] text-amber-300/70 font-medium mb-0.5 flex items-center gap-1"><Target size={9} /> Следующий шаг:</p>
                                                            <p className="text-[10px] text-[#e4e6eb] leading-relaxed">{aiNextStep[client.chatId]}</p>
                                                        </div>
                                                    )}
                                                </div>}

                                                {/* Quick Reply Templates */}
                                                {cardCanSend && templates.length > 0 && (
                                                    <div className="px-3 pb-2 border-t border-[#2a2e3a]/50 pt-2">
                                                        <p className="text-[10px] text-[#6b6f80] mb-1.5 flex items-center gap-1">
                                                            <Send size={9} />
                                                            Быстрые ответы:
                                                        </p>
                                                        <div className="flex gap-1.5 overflow-x-auto pb-1 kanban-scroll" style={{ scrollbarWidth: 'none' }}>
                                                            {templates.map(tmpl => {
                                                                const key = `${client.chatId}:${tmpl.id}`;
                                                                const isSending = sendingTemplate === key;
                                                                const isSuccess = sendSuccess === key;
                                                                return (
                                                                    <button
                                                                        key={tmpl.id}
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            if (!isSending) handleSendTemplate(client.chatId, tmpl.id, tmpl.text);
                                                                        }}
                                                                        disabled={isSending}
                                                                        title={tmpl.text}
                                                                        className={`flex-shrink-0 text-[10px] px-2 py-1 rounded-md border transition-all whitespace-nowrap ${isSuccess
                                                                            ? 'bg-green-500/20 border-green-500/40 text-green-400'
                                                                            : isSending
                                                                                ? 'bg-[#1e2128] border-[#2a2e3a] text-[#6b6f80] opacity-50'
                                                                                : 'bg-[#1e2128] border-[#2a2e3a] text-[#8b8fa3] hover:border-[#00c2ff] hover:text-[#00c2ff]'
                                                                            }`}
                                                                    >
                                                                        {isSuccess ? '✓ Отправлено' : isSending ? '...' : tmpl.label}
                                                                    </button>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                )}

                                                {access.role === 'manager' && !cardCanWrite && <p className="px-3 pb-2 text-xs">Доступен просмотр. <Link to="/sales?view=queue">Открыть рабочее пространство</Link></p>}

                                                {/* AI Thinking Toggle */}
                                                <button
                                                    onClick={() => toggleCard(client.chatId)}
                                                    className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] text-[#8b8fa3] hover:text-[#00c2ff] transition-colors border-t border-[#2a2e3a]/50 bg-[#1e2128]/50"
                                                >
                                                    <Brain size={12} />
                                                    <span>Мышление ИИ</span>
                                                    {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                                </button>

                                                {/* Expanded: AI Status History */}
                                                {isExpanded && (
                                                    <div className="px-3 pb-3 border-t border-[#2a2e3a]">
                                                        {isLoadingHist ? (
                                                            <div className="flex items-center justify-center py-4">
                                                                <div className="w-4 h-4 border-2 border-[#00c2ff] border-t-transparent rounded-full animate-spin" />
                                                            </div>
                                                        ) : history.length === 0 ? (
                                                            <p className="text-[11px] text-[#6b6f80] py-3 text-center italic">
                                                                Нет истории переходов. ИИ ещё не менял статус.
                                                            </p>
                                                        ) : (
                                                            <div className="space-y-2 pt-3 max-h-[200px] overflow-y-auto kanban-scroll">
                                                                {history.map((entry) => (
                                                                    <div key={entry.id} className="bg-[#1a1d27] rounded-lg p-2.5 border border-[#2a2e3a]/50">
                                                                        <div className="flex items-center gap-1.5 mb-1.5">
                                                                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{
                                                                                backgroundColor: (columns.find(c => c.id === entry.fromStatus)?.color || '#6b6f80') + '20',
                                                                                color: columns.find(c => c.id === entry.fromStatus)?.color || '#6b6f80'
                                                                            }}>
                                                                                {statusLabels[entry.fromStatus] || entry.fromStatus}
                                                                            </span>
                                                                            <ArrowRight size={10} className="text-[#6b6f80]" />
                                                                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{
                                                                                backgroundColor: (columns.find(c => c.id === entry.toStatus)?.color || '#6b6f80') + '20',
                                                                                color: columns.find(c => c.id === entry.toStatus)?.color || '#6b6f80'
                                                                            }}>
                                                                                {statusLabels[entry.toStatus] || entry.toStatus}
                                                                            </span>
                                                                            <span className={`ml-auto text-[9px] px-1 py-0.5 rounded ${entry.changedBy === 'ai'
                                                                                ? 'bg-purple-500/10 text-purple-400'
                                                                                : 'bg-blue-500/10 text-blue-400'
                                                                                }`}>
                                                                                {entry.changedBy === 'ai' ? '🤖 ИИ' : '👤 Вручную'}
                                                                            </span>
                                                                        </div>
                                                                        {entry.reason && (
                                                                            <p className="text-[10px] text-[#8b8fa3] leading-relaxed">
                                                                                💭 {entry.reason.substring(0, 200)}{entry.reason.length > 200 ? '...' : ''}
                                                                            </p>
                                                                        )}
                                                                        <p className="text-[9px] text-[#4a4d5a] mt-1">
                                                                            {new Date(entry.createdAt).toLocaleString('ru-RU', {
                                                                                day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
                                                                            })}
                                                                        </p>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}

                                    {/* Show More Button */}
                                    {hasMore && (
                                        <button
                                            onClick={() => showMore(col.id)}
                                            className="w-full py-2 text-xs text-[#8b8fa3] hover:text-[#00c2ff] transition-colors border border-dashed border-[#2a2e3a] rounded-lg hover:border-[#00c2ff]/40 flex items-center justify-center gap-1.5"
                                        >
                                            <ChevronDown size={13} />
                                            Ещё {remaining} {remaining === 1 ? 'карточка' : remaining < 5 ? 'карточки' : 'карточек'}
                                        </button>
                                    )}

                                    {sourceReady && colClients.length === 0 && (
                                        <div className="h-full min-h-[80px] flex items-center justify-center border-2 border-dashed border-[#2a2e3a] rounded-xl text-[#6b6f80] text-xs">
                                            {searchQuery ? 'Не найдено' : tagFilter.length > 0 ? 'Нет совпадений' : 'Пусто'}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            <style>{`
                .kanban-scroll::-webkit-scrollbar {
                    width: 6px;
                    height: 6px;
                }
                .kanban-scroll::-webkit-scrollbar-track {
                    background: transparent;
                }
                .kanban-scroll::-webkit-scrollbar-thumb {
                    background-color: #2a2e3a;
                    border-radius: 10px;
                }
                .kanban-scroll::-webkit-scrollbar-thumb:hover {
                    background-color: #3b3f4f;
                }
            `}</style>
        </div>
    );
}
