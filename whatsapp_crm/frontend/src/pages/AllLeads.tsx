import { customerDisplayName, formatCustomerPhone } from '../customerDisplay';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useInstance } from '../context/InstanceContext';
import { useBusinessAccess } from '../permissions';
import { canOperateCustomer } from '../customerPermissions';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import CustomerListScope from './CustomerListScope';
import { selectCustomerRows, hasUnresolvedPlaceholders } from './customerListHelpers';
import {
    getClients, updateClientStatus, getTemplates,
    updateClientTags, getAiSummary, getAiNextStep
} from '../api';
import {
    User, MessageSquare, AlertCircle, ChevronDown, ChevronUp,
    X, Send, Flame, Filter, Sparkles, Target, Loader2,
    Search, Download, CheckSquare, Square, ArrowUpDown,
    ChevronLeft, ChevronRight, Eye, MoreHorizontal, Columns3,
    Users, Activity
} from 'lucide-react';
import { COFFEE_PIPELINE, getPipeline, STANDARD_PIPELINE } from '../businessProfiles';
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
    tags: string;
    createdAt: string;
    updatedAt: string;
}

interface Template {
    id: number;
    instanceId: number;
    label: string;
    text: string;
}

const ALL_STATUSES = [...STANDARD_PIPELINE, ...COFFEE_PIPELINE];
const STATUS_MAP: Record<string, typeof ALL_STATUSES[0]> = {};
ALL_STATUSES.forEach(s => { STATUS_MAP[s.id] = s; });

const TAG_COLORS = [
    '#ef4444', '#f97316', '#f59e0b', '#22c55e', '#3b82f6',
    '#8b5cf6', '#ec4899', '#14b8a6', '#06b6d4', '#84cc16',
];

function getTagColor(tag: string): string {
    let hash = 0;
    for (let i = 0; i < tag.length; i++) hash = tag.charCodeAt(i) + ((hash << 5) - hash);
    return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

function parseTags(tagsStr: string | null | undefined): string[] {
    if (!tagsStr) return [];
    try {
        const parsed = JSON.parse(tagsStr);
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}

function getHoursAgo(dateStr: string | null | undefined): number {
    if (!dateStr) return 9999;
    return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60));
}

function formatTimeAgo(dateStr: string | null | undefined): string {
    if (!dateStr) return '—';
    const h = getHoursAgo(dateStr);
    if (h < 1) return 'только что';
    if (h < 24) return `${h}ч назад`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}д назад`;
    return `${Math.floor(d / 7)}нед назад`;
}

function activityColor(dateStr: string | null | undefined): string {
    const h = getHoursAgo(dateStr);
    if (h < 6) return '#22c55e';    // green — active
    if (h < 24) return '#f59e0b';   // yellow — today
    if (h < 72) return '#f97316';   // orange — cooling
    return '#ef4444';               // red — stale
}

type SortKey = 'name' | 'phone' | 'status' | 'lastMessage' | 'lastActivity' | 'created' | 'stuck';
type SortDir = 'asc' | 'desc';
type ActivityFilter = 'all' | 'active' | 'today' | 'stale';

const PER_PAGE_OPTIONS = [25, 50, 100];

export default function ScopedAllLeads() {
    const { currentInstanceId } = useInstance();
    const access = useBusinessAccess();
    return <AllLeads key={`${currentInstanceId}:${access.userId}:${access.role}`} />;
}

function AllLeads() {
    const access = useBusinessAccess();
    const canWrite = !access.checking && access.can('sales.write');
    const canSend = !access.checking && access.can('messages.send');
    const navigate = useNavigate();
    const [listParams] = useSearchParams();
    const { currentInstanceId, currentInstance } = useInstance();
    const statuses = useMemo(() => getPipeline(currentInstance), [currentInstance]);
    const [clients, setClients] = useState<Client[]>([]);
    const [loading, setLoading] = useState(true);
    const [sourceReady, setSourceReady] = useState(false);
    const [clientError, setClientError] = useState('');
    const [templates, setTemplates] = useState<Template[]>([]);

    // Filters
    const [searchQuery, setSearchQuery] = useState(listParams.get('q') || '');
    const [statusFilter, setStatusFilter] = useState<string[]>([]);
    const [tagFilter, setTagFilter] = useState<string[]>([]);
    const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
    const [showFilters, setShowFilters] = useState(false);

    // Sort
    const [sortKey, setSortKey] = useState<SortKey>('lastActivity');
    const [sortDir, setSortDir] = useState<SortDir>('desc');

    // Pagination
    const [page, setPage] = useState(1);
    const [perPage, setPerPage] = useState(25);

    // Selection
    const [selected, setSelected] = useState<Set<string>>(new Set());

    // Bulk action menu
    const [showBulkMenu, setShowBulkMenu] = useState(false);
    const bulkMenuRef = useRef<HTMLDivElement>(null);

    // Row detail
    const [expandedRow, setExpandedRow] = useState<string | null>(null);

    // Quick send
    const [sendingTemplate, setSendingTemplate] = useState<string | null>(null);
    const [sendSuccess] = useState<string | null>(null);

    // AI
    const [aiSummary, setAiSummary] = useState<Record<string, string>>({});
    const [aiNextStep, setAiNextStep] = useState<Record<string, string>>({});
    const [aiLoading, setAiLoading] = useState<Record<string, string>>({});

    // Bulk status change
    const [bulkSending, setBulkSending] = useState(false);
    const [batchTemplate, setBatchTemplate] = useState<Template | null>(null);

    useEffect(() => {
        if (!currentInstanceId) return;
        loadClients();
        loadTemplates();
        const interval = setInterval(loadClients, 15000);
        return () => clearInterval(interval);
    }, [currentInstanceId]);

    useEffect(() => {
        if (access.checking) return;
        setSelected(previous => new Set([...previous].filter(chatId => canOperateCustomer(access, clients.find(client => client.chatId === chatId), 'sales.write'))));
        setShowBulkMenu(false);
    }, [clients, canWrite, access.role, access.userId, access.checking]);

    // Close menus on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (bulkMenuRef.current && !bulkMenuRef.current.contains(e.target as Node)) setShowBulkMenu(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const loadClients = useCallback(async () => {
        if (!currentInstanceId) return;
        setLoading(true);
        try {
            const data = await getClients(currentInstanceId);
            if (!data.success || !Array.isArray(data.clients)) throw new Error('clients_unavailable');
            if (data.clients.some((client: Client) => client.instanceId !== currentInstanceId)) throw new Error('client_scope_mismatch');
            setClients(data.clients); setSourceReady(true); setClientError('');
        } catch (e) { console.error('Failed to load clients', e); setSourceReady(false); setClientError('Не удалось обновить клиентов. Повторите загрузку.'); }
        setLoading(false);
    }, [currentInstanceId]);

    const loadTemplates = useCallback(async () => {
        if (!currentInstanceId) return;
        try {
            const data = await getTemplates(currentInstanceId);
            if (data.success) setTemplates(data.templates || []);
        } catch (e) { console.error('Failed to load templates', e); }
    }, [currentInstanceId]);

    const scopedClients = useMemo(() => selectCustomerRows(clients, listParams, access.role, access.userId), [clients, listParams, access.role, access.userId]);

    // All unique tags
    const allTags = useMemo(() =>
        Array.from(new Set(clients.flatMap(c => parseTags(c.tags)))).sort()
    , [clients]);

    // Filtered + sorted + paginated
    const processedClients = useMemo(() => {
        let list = [...scopedClients];

        // Search
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase().trim();
            list = list.filter(c =>
                (c.senderName || '').toLowerCase().includes(q) ||
                c.chatId.replace('@c.us', '').includes(q) ||
                (c.lastMessage || '').toLowerCase().includes(q) ||
                parseTags(c.tags).some(t => t.toLowerCase().includes(q))
            );
        }

        // Status filter
        if (statusFilter.length > 0) {
            const allIds = statuses.map(s => s.id);
            list = list.filter(c => {
                const st = allIds.includes(c.leadStatus) ? c.leadStatus : 'new';
                return statusFilter.includes(st);
            });
        }

        // Tag filter
        if (tagFilter.length > 0) {
            list = list.filter(c => {
                const tags = parseTags(c.tags);
                return tagFilter.some(f => tags.includes(f));
            });
        }

        // Activity filter
        if (activityFilter !== 'all') {
            list = list.filter(c => {
                const h = getHoursAgo(c.lastMessageTime);
                if (activityFilter === 'active') return h < 6;
                if (activityFilter === 'today') return h < 24;
                if (activityFilter === 'stale') return h >= 72;
                return true;
            });
        }

        // Sort
        list.sort((a, b) => {
            let cmp = 0;
            switch (sortKey) {
                case 'name':
                    cmp = (a.senderName || '').localeCompare(b.senderName || '', 'ru');
                    break;
                case 'phone':
                    cmp = a.chatId.localeCompare(b.chatId);
                    break;
                case 'status': {
                    const order = statuses.map(s => s.id);
                    const ia = order.indexOf(a.leadStatus) === -1 ? 0 : order.indexOf(a.leadStatus);
                    const ib = order.indexOf(b.leadStatus) === -1 ? 0 : order.indexOf(b.leadStatus);
                    cmp = ia - ib;
                    break;
                }
                case 'lastMessage':
                    cmp = (a.lastMessage || '').localeCompare(b.lastMessage || '', 'ru');
                    break;
                case 'lastActivity':
                    cmp = new Date(a.lastMessageTime || 0).getTime() - new Date(b.lastMessageTime || 0).getTime();
                    break;
                case 'created':
                    cmp = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
                    break;
                case 'stuck':
                    cmp = getHoursAgo(a.lastStatusChangeAt || a.updatedAt) - getHoursAgo(b.lastStatusChangeAt || b.updatedAt);
                    break;
            }
            return sortDir === 'asc' ? cmp : -cmp;
        });

        return list;
    }, [scopedClients, searchQuery, statusFilter, tagFilter, activityFilter, sortKey, sortDir, statuses]);

    const totalPages = Math.max(1, Math.ceil(processedClients.length / perPage));
    const safePage = Math.min(page, totalPages);
    const pagedClients = processedClients.slice((safePage - 1) * perPage, safePage * perPage);

    // Stats
    const stats = useMemo(() => {
        const byStatus: Record<string, number> = {};
        statuses.forEach(s => { byStatus[s.id] = 0; });
        clients.forEach(c => {
            const st = statuses.find(s => s.id === c.leadStatus) ? c.leadStatus : 'new';
            byStatus[st] = (byStatus[st] || 0) + 1;
        });
        const active = clients.filter(c => getHoursAgo(c.lastMessageTime) < 24).length;
        const stale = clients.filter(c => getHoursAgo(c.lastMessageTime) >= 72).length;
        return { total: clients.length, byStatus, active, stale };
    }, [clients, statuses]);

    const toggleSort = (key: SortKey) => {
        if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        else { setSortKey(key); setSortDir('desc'); }
    };

    const toggleSelect = (chatId: string) => {
        if (!canOperateCustomer(access, clients.find(client => client.chatId === chatId), 'sales.write')) return;
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(chatId)) next.delete(chatId); else next.add(chatId);
            return next;
        });
    };

    const selectAll = () => {
        const eligible = pagedClients.filter(client => canOperateCustomer(access, client, 'sales.write'));
        if (selected.size === eligible.length) setSelected(new Set());
        else setSelected(new Set(eligible.map(client => client.chatId)));
    };

    const handleChangeStatus = async (chatId: string, newStatus: string) => {
        if (!canWrite || !currentInstanceId || !canOperateCustomer(access, clients.find(client => client.chatId === chatId), 'sales.write')) return;
        setClients(prev => prev.map(c => c.chatId === chatId ? { ...c, leadStatus: newStatus } : c));
        try {
            const result = await updateClientStatus(currentInstanceId, chatId, newStatus);
            if (!result.success) throw new Error('Status update failed');
        } catch { loadClients(); }
    };

    const handleBulkStatus = async (newStatus: string) => {
        if (!canWrite || !currentInstanceId || selected.size === 0) return;
        setBulkSending(true);
        const chatIds = Array.from(selected).filter(chatId => canOperateCustomer(access, clients.find(client => client.chatId === chatId), 'sales.write'));
        setClients(prev => prev.map(c => chatIds.includes(c.chatId) ? { ...c, leadStatus: newStatus } : c));
        setShowBulkMenu(false);
        try {
            await Promise.all(chatIds.map(id => updateClientStatus(currentInstanceId, id, newStatus)));
        } catch { loadClients(); }
        setBulkSending(false);
        setSelected(new Set());
    };

    const handleBulkTag = async (tag: string) => {
        if (!canWrite || !currentInstanceId || selected.size === 0 || !tag.trim()) return;
        const t = tag.trim();
        const chatIds = Array.from(selected).filter(chatId => canOperateCustomer(access, clients.find(client => client.chatId === chatId), 'sales.write'));
        setClients(prev => prev.map(c => {
            if (!chatIds.includes(c.chatId)) return c;
            const tags = parseTags(c.tags);
            if (tags.includes(t)) return c;
            return { ...c, tags: JSON.stringify([...tags, t]) };
        }));
        setShowBulkMenu(false);
        try {
            await Promise.all(chatIds.map(id => {
                const cl = clients.find(c => c.chatId === id);
                const tags = parseTags(cl?.tags);
                if (tags.includes(t)) return Promise.resolve();
                return updateClientTags(currentInstanceId, id, [...tags, t]);
            }));
        } catch { loadClients(); }
        setSelected(new Set());
    };

    const handleRemoveTag = async (chatId: string, tag: string) => {
        if (!canWrite || !currentInstanceId) return;
        const client = clients.find(item => item.chatId === chatId);
        if (!client || !canOperateCustomer(access, client, 'sales.write')) return;
        const newTags = parseTags(client.tags).filter(item => item !== tag);
        setClients(previous => previous.map(item => item.chatId === chatId ? { ...item, tags: JSON.stringify(newTags) } : item));
        try { await updateClientTags(currentInstanceId, chatId, newTags); } catch { void loadClients(); }
    };

    const handleSendTemplate = async (chatId: string, templateId: number, _text: string) => {
        if (!canSend || !currentInstanceId || !canOperateCustomer(access, clients.find(client => client.chatId === chatId), 'messages.send')) return;
        setSendingTemplate(`${chatId}:${templateId}`);
        navigate(`/today?client=${encodeURIComponent(chatId)}&template=${templateId}`);
    };

    const handleBulkSendTemplate = async (templateText: string) => {
        if (!canSend || !currentInstanceId || selected.size === 0) return;
        const template = templates.find(item => item.text === templateText);
        if (!template) return;
        setBatchTemplate(template); setShowBulkMenu(false);
    };

    const exportCSV = () => {
        const headers = ['Имя', 'Телефон', 'Статус', 'Теги', 'Последнее сообщение', 'Последняя активность', 'Создан'];
        const rows = processedClients.map(c => [
            c.senderName || '',
            c.chatId.replace('@c.us', ''),
            STATUS_MAP[c.leadStatus]?.label || c.leadStatus,
            parseTags(c.tags).join(', '),
            (c.lastMessage || '').replace(/"/g, '""'),
            c.lastMessageTime || '',
            c.createdAt || '',
        ]);
        const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `leads_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click(); URL.revokeObjectURL(url);
    };

    // Reset page when filters change
    useEffect(() => { setPage(1); }, [searchQuery, statusFilter, tagFilter, activityFilter, perPage]);

    if (!currentInstanceId) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-center">
                <div className="w-20 h-20 bg-[#22262f] rounded-2xl flex items-center justify-center mb-4">
                    <AlertCircle size={40} className="text-[#8b8fa3]" />
                </div>
                <h2 className="text-xl font-bold text-white mb-2">Нет активного бизнеса</h2>
                <p className="text-[#8b8fa3] mb-4">Выберите бизнес в левом меню.</p>
            </div>
        );
    }

    const SortHeader = ({ label, sortKeyName, className = '' }: { label: string; sortKeyName: SortKey; className?: string }) => (
        <button
            onClick={() => toggleSort(sortKeyName)}
            className={`flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider hover:text-white transition-colors ${
                sortKey === sortKeyName ? 'text-[#00c2ff]' : 'text-[#6b6f80]'
            } ${className}`}
        >
            {label}
            {sortKey === sortKeyName && (sortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
            {sortKey !== sortKeyName && <ArrowUpDown size={9} className="opacity-40" />}
        </button>
    );

    return (
        <div className="ava-sales-page ava-sales-list h-[calc(100vh-6rem)] flex flex-col">
            {/* Header */}
            <div className="ava-sales-heading mb-3">
                <div className="flex items-center justify-between flex-wrap gap-3">
                    <div>
                        <span className="ava-sales-eyebrow">AVA / Клиенты</span>
                        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
                            <Users size={25} aria-hidden="true" />
                            Клиенты
                        </h1>
                        <p className="text-[#8b8fa3] mt-1 text-sm">
                            Все клиенты текущего бизнеса: статусы, активность, фильтры и экспорт.
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Link
                            to={`/leads?${listParams.toString()}`}
                            className="flex items-center gap-1.5 bg-[#1e2128] border border-[#2a2e3a] rounded-lg px-3 py-2 text-xs text-[#8b8fa3] hover:text-[#00c2ff] hover:border-[#00c2ff]/40 transition-colors"
                        >
                            <Columns3 size={14} />
                            Канбан
                        </Link>
                        <button
                            onClick={exportCSV}
                            className="flex items-center gap-1.5 bg-[#1e2128] border border-[#2a2e3a] rounded-lg px-3 py-2 text-xs text-[#8b8fa3] hover:text-[#00c2ff] hover:border-[#00c2ff]/40 transition-colors"
                        >
                            <Download size={14} />
                            CSV
                        </button>
                    </div>
                </div>
            </div>

            <CustomerListScope role={access.role} />
            {batchTemplate && <section className="ava-customer-batch" aria-label="Проверка выбранных ответов">
                <h2>Проверить сообщения · {batchTemplate.label}</h2>
                <p>Откройте разговор каждого клиента, исправьте текст и подтвердите отправку.</p>
                <p className="whitespace-pre-wrap break-words">{batchTemplate.text}</p>
                {hasUnresolvedPlaceholders(batchTemplate.text) && <p role="status">Заполните подстановки перед отправкой.</p>}
                <ul>{clients.filter(client => selected.has(client.chatId) && canOperateCustomer(access, client, 'messages.send')).map(client => <li key={client.chatId}>
                    <Link to={`/today?client=${encodeURIComponent(client.chatId)}&template=${batchTemplate.id}`}>{client.senderName || client.chatId} · Проверить ответ</Link>
                </li>)}</ul><button type="button" onClick={() => setBatchTemplate(null)}>Закрыть проверку</button>
            </section>}
            {clientError && <p role="alert">{clientError} <button type="button" onClick={() => void loadClients()}>Повторить</button></p>}
            {/* Stats Bar */}
            <div className="mb-3 flex items-center gap-2 overflow-x-auto pb-1 kanban-scroll">
                <div className="flex items-center gap-1.5 bg-[#1e2128] border border-[#2a2e3a] rounded-lg px-3 py-2 flex-shrink-0">
                    <Users size={13} className="text-[#8b8fa3]" />
                    <span className="text-xs text-[#8b8fa3]">Всего:</span>
                    <span className="text-sm font-bold text-white">{sourceReady ? stats.total : '—'}</span>
                </div>
                {statuses.map(s => (
                    <button
                        key={s.id}
                        onClick={() => setStatusFilter(prev => prev.includes(s.id) ? prev.filter(x => x !== s.id) : [...prev, s.id])}
                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 flex-shrink-0 border text-xs transition-all ${
                            statusFilter.includes(s.id)
                                ? 'border-opacity-60 bg-opacity-20'
                                : 'border-[#2a2e3a] bg-[#1e2128]'
                        }`}
                        style={{
                            borderColor: statusFilter.includes(s.id) ? s.color + '60' : undefined,
                            backgroundColor: statusFilter.includes(s.id) ? s.color + '15' : undefined,
                        }}
                    >
                        <span className="ava-stage-dot" aria-hidden="true" />
                        <span style={{ color: s.color }} className="font-medium">{sourceReady ? stats.byStatus[s.id] || 0 : '—'}</span>
                    </button>
                ))}
                <div className="w-px h-6 bg-[#2a2e3a] flex-shrink-0" />
                <button
                    onClick={() => setActivityFilter(activityFilter === 'active' ? 'all' : 'active')}
                    className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 flex-shrink-0 border text-xs transition-all ${
                        activityFilter === 'active' ? 'border-green-500/40 bg-green-500/10' : 'border-[#2a2e3a] bg-[#1e2128]'
                    }`}
                >
                    <Activity size={12} className="text-green-400" />
                    <span className="text-green-400 font-medium">{sourceReady ? stats.active : '—'}</span>
                    <span className="text-[#6b6f80]">актив</span>
                </button>
                <button
                    onClick={() => setActivityFilter(activityFilter === 'stale' ? 'all' : 'stale')}
                    className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 flex-shrink-0 border text-xs transition-all ${
                        activityFilter === 'stale' ? 'border-red-500/40 bg-red-500/10' : 'border-[#2a2e3a] bg-[#1e2128]'
                    }`}
                >
                    <Flame size={12} className="text-red-400" />
                    <span className="text-red-400 font-medium">{sourceReady ? stats.stale : '—'}</span>
                    <span className="text-[#6b6f80]">остыв</span>
                </button>
            </div>

            {/* Search + Filter Toggle */}
            <div className="mb-3 flex items-center gap-2 flex-wrap">
                <div className="relative flex-1 min-w-[200px] max-w-[400px]">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6b6f80]" />
                    <input
                        type="text"
                        aria-label="Поиск клиентов"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="Поиск по имени, телефону, сообщению, тегу..."
                        className="w-full bg-[#1e2128] border border-[#2a2e3a] rounded-lg pl-9 pr-8 py-2 text-sm text-white placeholder-[#6b6f80] outline-none focus:border-[#00c2ff] transition-colors"
                    />
                    {searchQuery && (
                        <button onClick={() => setSearchQuery('')} aria-label="Очистить поиск" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6b6f80] hover:text-white">
                            <X size={14} />
                        </button>
                    )}
                </div>

                {allTags.length > 0 && (
                    <button
                        onClick={() => setShowFilters(!showFilters)}
                        className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs border transition-colors ${
                            showFilters || tagFilter.length > 0
                                ? 'bg-[#00c2ff]/10 border-[#00c2ff]/30 text-[#00c2ff]'
                                : 'bg-[#1e2128] border-[#2a2e3a] text-[#8b8fa3] hover:border-[#3a3e4a]'
                        }`}
                    >
                        <Filter size={13} />
                        Теги{tagFilter.length > 0 ? ` (${tagFilter.length})` : ''}
                    </button>
                )}

                {/* Active filters clear */}
                {(statusFilter.length > 0 || tagFilter.length > 0 || activityFilter !== 'all') && (
                    <button
                        onClick={() => { setStatusFilter([]); setTagFilter([]); setActivityFilter('all'); }}
                        className="flex items-center gap-1 text-xs text-[#6b6f80] hover:text-white transition-colors"
                    >
                        <X size={12} />
                        Сбросить фильтры
                    </button>
                )}

                <div className="ml-auto flex items-center gap-2 text-xs text-[#6b6f80]">
                    <span>{processedClients.length} из {clients.length}</span>
                </div>
            </div>

            {/* Tag filter panel */}
            {showFilters && allTags.length > 0 && (
                <div className="mb-3 flex items-center gap-2 flex-wrap bg-[#1e2128] border border-[#2a2e3a] rounded-lg p-3">
                    <span className="text-[10px] text-[#6b6f80] uppercase font-semibold tracking-wider mr-1">Теги:</span>
                    {allTags.map(tag => {
                        const color = getTagColor(tag);
                        const isActive = tagFilter.includes(tag);
                        return (
                            <button
                                key={tag}
                                onClick={() => setTagFilter(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag])}
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
                </div>
            )}

            {/* Bulk Actions Bar */}
            {canWrite && selected.size > 0 && (
                <div className="mb-3 flex items-center gap-3 bg-[#00c2ff]/10 border border-[#00c2ff]/30 rounded-lg px-4 py-2.5">
                    <span className="text-sm text-[#00c2ff] font-medium">Выбрано: {selected.size}</span>
                    <div className="flex-1" />

                    {/* Bulk status */}
                    <div className="relative" ref={bulkMenuRef}>
                        <button
                            onClick={() => setShowBulkMenu(!showBulkMenu)}
                            disabled={bulkSending}
                            className="flex items-center gap-1.5 bg-[#22262f] border border-[#2a2e3a] rounded-lg px-3 py-1.5 text-xs text-[#8b8fa3] hover:text-white transition-colors disabled:opacity-50"
                        >
                            {bulkSending ? <Loader2 size={12} className="animate-spin" /> : <MoreHorizontal size={13} />}
                            Действия
                            <ChevronDown size={11} />
                        </button>
                        {showBulkMenu && (
                            <div className="absolute top-full mt-2 right-0 z-50 min-w-[220px] max-w-[min(320px,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto rounded-xl border border-[#d9d9d9] bg-white py-1 shadow-xl">
                                <p className="px-3 py-1 text-[10px] text-[#6b6f80] uppercase font-semibold tracking-wider">Сменить статус</p>
                                {statuses.map(s => (
                                    <button
                                        key={s.id}
                                        onClick={() => handleBulkStatus(s.id)}
                                        className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-sm text-[#252525] transition-colors hover:bg-[#f2f2f2] focus-visible:bg-[#f2f2f2] focus-visible:outline-2 focus-visible:outline-[#111111]"
                                    >
                                        {s.label}
                                    </button>
                                ))}
                                {canSend && templates.length > 0 && (
                                    <>
                                        <div className="border-t border-[#2a2e3a] my-1" />
                                        <p className="px-3 py-1 text-[10px] text-[#6b6f80] uppercase font-semibold tracking-wider">Отправить шаблон</p>
                                        {templates.map(t => (
                                            <button
                                                key={t.id}
                                                onClick={() => handleBulkSendTemplate(t.text)}
                                                className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-sm text-[#252525] transition-colors hover:bg-[#f2f2f2] focus-visible:bg-[#f2f2f2] focus-visible:outline-2 focus-visible:outline-[#111111]"
                                            >
                                                <Send size={10} /> {t.label}
                                            </button>
                                        ))}
                                    </>
                                )}
                                <div className="border-t border-[#2a2e3a] my-1" />
                                <p className="px-3 py-1 text-[10px] text-[#6b6f80] uppercase font-semibold tracking-wider">Добавить тег</p>
                                <div className="px-3 py-1">
                                    <input
                                        type="text"
                                        placeholder="Введите тег + Enter"
                                        className="w-full bg-[#1a1d27] border border-[#2a2e3a] rounded px-2 py-1 text-xs text-white placeholder-[#6b6f80] outline-none"
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                handleBulkTag((e.target as HTMLInputElement).value);
                                                (e.target as HTMLInputElement).value = '';
                                            }
                                        }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    <button
                        onClick={() => setSelected(new Set())}
                        className="text-xs text-[#6b6f80] hover:text-white transition-colors"
                    >
                        Снять выделение
                    </button>
                </div>
            )}

            {/* Table */}
            {loading && clients.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                    <div className="w-8 h-8 border-2 border-[#00c2ff] border-t-transparent rounded-full animate-spin" />
                </div>
            ) : (
                <div className="ava-sales-table-wrap flex-1 overflow-auto rounded-xl border border-[#2a2e3a] bg-[#1e2128] kanban-scroll">
                    <table className="w-full min-w-[900px]">
                        <thead className="sticky top-0 z-10 bg-[#1a1d27] border-b border-[#2a2e3a]">
                            <tr>
                                <th className="px-3 py-2.5 text-left w-10">
                                    {canWrite && pagedClients.some(client => canOperateCustomer(access, client, 'sales.write')) && <button onClick={selectAll} aria-label="Выбрать всех клиентов на странице" className="text-[#6b6f80] hover:text-white transition-colors">
                                        {selected.size > 0 && selected.size === pagedClients.length
                                            ? <CheckSquare size={15} className="text-[#00c2ff]" />
                                            : <Square size={15} />}
                                    </button>}
                                </th>
                                <th className="px-3 py-2.5 text-left w-5"></th>
                                <th className="px-3 py-2.5 text-left"><SortHeader label="Имя" sortKeyName="name" /></th>
                                <th className="px-3 py-2.5 text-left"><SortHeader label="Телефон" sortKeyName="phone" /></th>
                                <th className="px-3 py-2.5 text-left"><SortHeader label="Статус" sortKeyName="status" /></th>
                                <th className="px-3 py-2.5 text-left">
                                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[#6b6f80]">Теги</span>
                                </th>
                                <th className="px-3 py-2.5 text-left"><SortHeader label="Сообщение" sortKeyName="lastMessage" /></th>
                                <th className="px-3 py-2.5 text-left"><SortHeader label="Активность" sortKeyName="lastActivity" /></th>
                                <th className="px-3 py-2.5 text-left"><SortHeader label="В воронке" sortKeyName="stuck" /></th>
                                <th className="px-3 py-2.5 text-left w-24">
                                    <span className="text-[11px] font-semibold uppercase tracking-wider text-[#6b6f80]">Действия</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {pagedClients.map(client => {
                                const tags = parseTags(client.tags);
                                const hStuck = getHoursAgo(client.lastStatusChangeAt || client.updatedAt);
                                const isBurning = hStuck >= 24;
                                const isExpanded = expandedRow === client.chatId;
                                const isSelected = selected.has(client.chatId);
                                const rowCanWrite = canOperateCustomer(access, client, 'sales.write');
                                const rowCanSend = canOperateCustomer(access, client, 'messages.send');
                                const rowCanUseAi = canOperateCustomer(access, client, 'ai.use');
                                const currentStatus = statuses.find(status => status.id === client.leadStatus)
                                    || STATUS_MAP[client.leadStatus];

                                return (
                                    <React.Fragment key={client.chatId}>
                                        <tr
                                            className={`border-b border-[#2a2e3a]/50 transition-colors ${
                                                isSelected ? 'bg-[#00c2ff]/5' : 'hover:bg-[#22262f]'
                                            } ${isBurning ? 'bg-orange-500/[0.03]' : ''}`}
                                        >
                                            {/* Checkbox */}
                                            <td className="px-3 py-2">
                                                {rowCanWrite && <button onClick={() => toggleSelect(client.chatId)} aria-label={`${isSelected ? 'Снять выделение' : 'Выбрать'}: ${client.senderName || client.chatId}`} className="text-[#6b6f80] hover:text-white transition-colors">
                                                    {isSelected
                                                        ? <CheckSquare size={15} className="text-[#00c2ff]" />
                                                        : <Square size={15} />}
                                                </button>}
                                            </td>

                                            {/* Activity dot */}
                                            <td className="px-1 py-2">
                                                <div
                                                    className="w-2.5 h-2.5 rounded-full mx-auto"
                                                    style={{ backgroundColor: activityColor(client.lastMessageTime) }}
                                                    title={formatTimeAgo(client.lastMessageTime)}
                                                />
                                            </td>

                                            {/* Name */}
                                            <td className="px-3 py-2">
                                                <div className="flex items-center gap-2">
                                                    {isBurning && <Flame size={12} className="text-orange-400 flex-shrink-0" />}
                                                    <span className="text-sm text-[#e4e6eb] font-medium truncate max-w-[160px]">
                                                        {customerDisplayName(client.senderName, undefined, client.chatId)}
                                                    </span>
                                                </div>
                                            </td>

                                            {/* Phone */}
                                            <td className="px-3 py-2">
                                                <span className="text-xs text-[#8b8fa3] font-mono">
                                                    {formatCustomerPhone(undefined, client.chatId) || 'Номер не указан'}
                                                </span>
                                            </td>

                                            {/* Status */}
                                            <td className="px-3 py-2 min-w-[220px]">
                                                {rowCanWrite ? <select
                                                    aria-label={`Статус клиента ${client.senderName || client.chatId}`}
                                                    title={currentStatus?.label || client.leadStatus}
                                                    value={client.leadStatus}
                                                    onChange={event => void handleChangeStatus(client.chatId, event.target.value)}
                                                    className="lead-status-select"
                                                    style={{ borderLeftColor: currentStatus?.color || '#6b6f80' }}
                                                >
                                                    {!statuses.some(status => status.id === client.leadStatus) && (
                                                        <option value={client.leadStatus}>
                                                            {currentStatus?.label || client.leadStatus}
                                                        </option>
                                                    )}
                                                    {statuses.map(status => (
                                                        <option key={status.id} value={status.id}>
                                                            {status.label}
                                                        </option>
                                                    ))}
                                                </select> : <span className="lead-status-select">{currentStatus?.label || 'Статус не указан'}</span>}
                                            </td>

                                            {/* Tags */}
                                            <td className="px-3 py-2">
                                                <div className="flex flex-wrap gap-1 max-w-[140px]">
                                                    {tags.slice(0, 3).map(tag => (
                                                        <span
                                                            key={tag}
                                                            className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                                                            style={{ backgroundColor: getTagColor(tag) + '20', color: getTagColor(tag) }}
                                                        >
                                                            #{tag}
                                                        </span>
                                                    ))}
                                                    {tags.length > 3 && (
                                                        <span className="text-[10px] text-[#6b6f80]">+{tags.length - 3}</span>
                                                    )}
                                                </div>
                                            </td>

                                            {/* Last message */}
                                            <td className="px-3 py-2">
                                                <p className="text-xs text-[#8b8fa3] truncate max-w-[180px]" title={client.lastMessage}>
                                                    {client.lastMessage || '—'}
                                                </p>
                                            </td>

                                            {/* Activity */}
                                            <td className="px-3 py-2">
                                                <span className="text-xs" style={{ color: activityColor(client.lastMessageTime) }}>
                                                    {formatTimeAgo(client.lastMessageTime)}
                                                </span>
                                            </td>

                                            {/* Stuck */}
                                            <td className="px-3 py-2">
                                                <span className={`text-xs ${isBurning ? 'text-orange-400 font-medium' : 'text-[#6b6f80]'}`}>
                                                    {hStuck < 1 ? '<1ч' : hStuck < 24 ? `${hStuck}ч` : `${Math.floor(hStuck / 24)}д ${hStuck % 24}ч`}
                                                </span>
                                            </td>

                                            {/* Actions */}
                                            <td className="px-3 py-2">
                                                <div className="flex items-center gap-1">
                                                    <button
                                                        onClick={() => setExpandedRow(isExpanded ? null : client.chatId)}
                                                        className="p-1 text-[#6b6f80] hover:text-[#00c2ff] transition-colors rounded"
                                                        title="Подробнее"
                                                    >
                                                        <Eye size={14} />
                                                    </button>
                                                    <Link
                                                        to={`/conversations?client=${encodeURIComponent(client.chatId)}`}
                                                        className="p-1 text-[#6b6f80] hover:text-white transition-colors rounded"
                                                        title="Диалог"
                                                    >
                                                        <MessageSquare size={14} />
                                                    </Link>
                                                    <Link
                                                        to={`/customers/${encodeURIComponent(client.chatId)}`}
                                                        className="p-1 text-[#6b6f80] hover:text-purple-400 transition-colors rounded"
                                                        title="Профиль клиента"
                                                        aria-label={`Открыть профиль ${client.senderName || client.chatId}`}
                                                    >
                                                        <User size={14} />
                                                    </Link>
                                                    <Link
                                                        to={`/leads?highlight=${encodeURIComponent(client.chatId)}`}
                                                        className="p-1 text-[#6b6f80] hover:text-blue-400 transition-colors rounded"
                                                        title="Найти на канбане"
                                                    >
                                                        <Columns3 size={14} />
                                                    </Link>
                                                </div>
                                            </td>
                                        </tr>

                                        {/* Expanded detail row */}
                                        {isExpanded && (
                                            <tr className="bg-[#1a1d27]">
                                                <td colSpan={10} className="px-6 py-4">
                                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                                        {/* Left: info */}
                                                        <div className="space-y-3">
                                                            <div>
                                                                <span className="text-[10px] text-[#6b6f80] uppercase tracking-wider">Последнее сообщение</span>
                                                                <p className="text-xs text-[#e4e6eb] mt-1 bg-[#22262f] rounded-lg p-2.5 border border-[#2a2e3a]">
                                                                    {client.lastMessage || 'Нет сообщений'}
                                                                </p>
                                                            </div>
                                                            <div className="flex gap-4 text-xs">
                                                                <div>
                                                                    <span className="text-[#6b6f80]">Создан: </span>
                                                                    <span className="text-[#8b8fa3]">{client.createdAt ? new Date(client.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</span>
                                                                </div>
                                                                <div>
                                                                    <span className="text-[#6b6f80]">Обновлён: </span>
                                                                    <span className="text-[#8b8fa3]">{client.updatedAt ? new Date(client.updatedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                                                                </div>
                                                            </div>
                                                            {/* Tags with edit */}
                                                            <div>
                                                                <span className="text-[10px] text-[#6b6f80] uppercase tracking-wider">Теги</span>
                                                                <div className="flex flex-wrap gap-1 mt-1">
                                                                    {tags.map(tag => (
                                                                        <span
                                                                            key={tag}
                                                                            className={`flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${rowCanWrite ? 'cursor-pointer hover:opacity-80' : ''}`}
                                                                            style={{ backgroundColor: getTagColor(tag) + '20', color: getTagColor(tag) }}
                                                                            role={rowCanWrite ? 'button' : undefined}
                                                                            tabIndex={rowCanWrite ? 0 : undefined}
                                                                            aria-label={rowCanWrite ? `Удалить метку ${tag}` : undefined}
                                                                            onKeyDown={event => { if (rowCanWrite && ['Enter', ' '].includes(event.key)) { event.preventDefault(); void handleRemoveTag(client.chatId, tag); } }}
                                                                            onClick={rowCanWrite ? () => { void handleRemoveTag(client.chatId, tag); } : undefined}
                                                                            title={rowCanWrite ? 'Удалить тег' : undefined}
                                                                        >
                                                                            #{tag} {rowCanWrite && <X size={8} />}
                                                                        </span>
                                                                    ))}
                                                                    {rowCanWrite && <input
                                                                        aria-label="Добавить тег клиенту"
                                                                        type="text"
                                                                        placeholder="+ тег"
                                                                        className="text-[10px] bg-transparent text-[#8b8fa3] placeholder-[#4a4d5a] outline-none w-16"
                                                                        onKeyDown={async (e) => {
                                                                            if (e.key === 'Enter' || e.key === ' ' || e.key === ',') {
                                                                                e.preventDefault();
                                                                                const val = (e.target as HTMLInputElement).value.trim().replace(/\s+/g, '_');
                                                                                if (!rowCanWrite || !val || !currentInstanceId) return;
                                                                                if (tags.includes(val)) { (e.target as HTMLInputElement).value = ''; return; }
                                                                                const newTags = [...tags, val];
                                                                                setClients(prev => prev.map(c => c.chatId === client.chatId ? { ...c, tags: JSON.stringify(newTags) } : c));
                                                                                (e.target as HTMLInputElement).value = '';
                                                                                try { await updateClientTags(currentInstanceId, client.chatId, newTags); } catch { loadClients(); }
                                                                            }
                                                                        }}
                                                                    />}
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {access.role === 'manager' && !rowCanWrite && <p className="text-xs">Доступен просмотр. <Link to="/sales?view=queue">Открыть рабочее пространство</Link></p>}

                                                        {/* Center: AI */}
                                                        {rowCanUseAi && <div className="space-y-2">
                                                            <div className="flex gap-1.5">
                                                                <button
                                                                    onClick={async () => {
                                                                        if (!rowCanUseAi || !currentInstanceId || aiLoading[client.chatId]) return;
                                                                        setAiLoading(p => ({ ...p, [client.chatId]: 'summary' }));
                                                                        try {
                                                                            const res = await getAiSummary(currentInstanceId, client.chatId);
                                                                            setAiSummary(p => ({ ...p, [client.chatId]: res.summary || 'Нет данных' }));
                                                                        } catch { setAiSummary(p => ({ ...p, [client.chatId]: 'Ошибка' })); }
                                                                        setAiLoading(p => ({ ...p, [client.chatId]: '' }));
                                                                    }}
                                                                    disabled={aiLoading[client.chatId] === 'summary'}
                                                                    className="flex-1 flex items-center justify-center gap-1 text-[10px] px-2 py-1.5 rounded-md border bg-purple-500/10 border-purple-500/20 text-purple-400 hover:bg-purple-500/20 transition-all disabled:opacity-50"
                                                                >
                                                                    {aiLoading[client.chatId] === 'summary' ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                                                                    AI Резюме
                                                                </button>
                                                                <button
                                                                    onClick={async () => {
                                                                        if (!rowCanUseAi || !currentInstanceId || aiLoading[client.chatId]) return;
                                                                        setAiLoading(p => ({ ...p, [client.chatId]: 'nextstep' }));
                                                                        try {
                                                                            const res = await getAiNextStep(currentInstanceId, client.chatId);
                                                                            setAiNextStep(p => ({ ...p, [client.chatId]: res.nextStep || res.action || 'Нет' }));
                                                                        } catch { setAiNextStep(p => ({ ...p, [client.chatId]: 'Ошибка' })); }
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
                                                                <div className="bg-purple-500/5 border border-purple-500/15 rounded-lg px-2.5 py-2">
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

                                                        {/* Right: Quick replies */}
                                                        {rowCanSend && templates.length > 0 && (
                                                            <div>
                                                                <span className="text-[10px] text-[#6b6f80] uppercase tracking-wider">Быстрые ответы</span>
                                                                <div className="flex flex-wrap gap-1.5 mt-1.5">
                                                                    {templates.map(tmpl => {
                                                                        const key = `${client.chatId}:${tmpl.id}`;
                                                                        const isSending = sendingTemplate === key;
                                                                        const isSuccess = sendSuccess === key;
                                                                        return (
                                                                            <button
                                                                                key={tmpl.id}
                                                                                onClick={() => { if (!isSending) handleSendTemplate(client.chatId, tmpl.id, tmpl.text); }}
                                                                                disabled={isSending}
                                                                                title={tmpl.text}
                                                                                className={`text-[10px] px-2 py-1 rounded-md border transition-all whitespace-nowrap ${isSuccess
                                                                                    ? 'bg-green-500/20 border-green-500/40 text-green-400'
                                                                                    : isSending
                                                                                        ? 'bg-[#1e2128] border-[#2a2e3a] text-[#6b6f80] opacity-50'
                                                                                        : 'bg-[#22262f] border-[#2a2e3a] text-[#8b8fa3] hover:border-[#00c2ff] hover:text-[#00c2ff]'
                                                                                }`}
                                                                            >
                                                                                {isSuccess ? '✓ Отправлено' : isSending ? '...' : tmpl.label}
                                                                            </button>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                );
                            })}

                            {sourceReady && pagedClients.length === 0 && (
                                <tr>
                                    <td colSpan={10} className="text-center py-12 text-[#6b6f80] text-sm">
                                        {searchQuery || statusFilter.length > 0 || tagFilter.length > 0 || activityFilter !== 'all'
                                            ? 'Ничего не найдено по вашим фильтрам'
                                            : 'Нет лидов'}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Pagination */}
            {processedClients.length > 0 && (
                <div className="mt-3 flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 text-xs text-[#6b6f80]">
                        <span>Показывать:</span>
                        {PER_PAGE_OPTIONS.map(n => (
                            <button
                                key={n}
                                onClick={() => setPerPage(n)}
                                className={`px-2 py-1 rounded transition-colors ${perPage === n ? 'bg-[#00c2ff]/15 text-[#00c2ff]' : 'hover:text-white'}`}
                            >
                                {n}
                            </button>
                        ))}
                    </div>

                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => setPage(p => Math.max(1, p - 1))}
                            disabled={safePage <= 1}
                            className="p-1.5 rounded text-[#6b6f80] hover:text-white disabled:opacity-30 transition-colors"
                        >
                            <ChevronLeft size={16} />
                        </button>

                        {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                            let pageNum: number;
                            if (totalPages <= 7) {
                                pageNum = i + 1;
                            } else if (safePage <= 4) {
                                pageNum = i + 1;
                            } else if (safePage >= totalPages - 3) {
                                pageNum = totalPages - 6 + i;
                            } else {
                                pageNum = safePage - 3 + i;
                            }
                            return (
                                <button
                                    key={pageNum}
                                    onClick={() => setPage(pageNum)}
                                    className={`w-8 h-8 rounded text-xs transition-colors ${
                                        safePage === pageNum
                                            ? 'bg-[#00c2ff] text-white font-bold'
                                            : 'text-[#6b6f80] hover:text-white hover:bg-[#22262f]'
                                    }`}
                                >
                                    {pageNum}
                                </button>
                            );
                        })}

                        <button
                            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                            disabled={safePage >= totalPages}
                            className="p-1.5 rounded text-[#6b6f80] hover:text-white disabled:opacity-30 transition-colors"
                        >
                            <ChevronRight size={16} />
                        </button>

                        <span className="text-xs text-[#6b6f80] ml-2">
                            Стр. {safePage} из {totalPages}
                        </span>
                    </div>
                </div>
            )}

            <style>{`
                .kanban-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
                .kanban-scroll::-webkit-scrollbar-track { background: transparent; }
                .kanban-scroll::-webkit-scrollbar-thumb { background-color: #2a2e3a; border-radius: 10px; }
                .kanban-scroll::-webkit-scrollbar-thumb:hover { background-color: #3b3f4f; }
            `}</style>
        </div>
    );
}
