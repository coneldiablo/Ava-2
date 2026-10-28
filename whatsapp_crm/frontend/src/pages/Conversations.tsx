import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Bot, ChevronRight, Clock3, Inbox, Loader2, MessageCircle, RefreshCw, Search, Send, Sparkles, Target, UserRound } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInstance } from '../context/InstanceContext';
import { useAuth } from '../context/AuthContext';
import { useBusinessAccess } from '../permissions';
import { canOperateCustomer } from '../customerPermissions';
import { useScopedDraft } from '../hooks/useScopedDraft';
import { getAiNextStep, getAiSummary, getClients, getMessages, getTemplates, sendMessageToClient } from '../api';
import { type WorkspaceMedia } from '../avaWorkspace';
import MediaAttachment from '../components/MediaAttachment';
import './Conversations.css';
import { messageChannelLabels as channelLabels, channelLabel } from '../channelNames';

interface Client {
    id: number;
    instanceId: number;
    chatId: string;
    assigneeUserId?: string | null;
    senderName: string;
    leadStatus: string;
    lastMessage: string;
    lastMessageTime: string;
    preferredChannel?: string;
    channels: string[];
}

interface Message {
    id: number;
    chatId: string;
    assigneeUserId?: string | null;
    senderName: string;
    content: string;
    role: string;
    aiThought: string | null;
    timestamp: string;
    channel?: string;
    media?: WorkspaceMedia | null;
}

interface QuickReplyTemplate {
    id: number;
    instanceId: number;
    label: string;
    text: string;
}

type AiField = 'summary' | 'nextStep';
type AiResult = { status: 'idle' | 'loading' | 'error' | 'empty' | 'success'; text: string };
type AiPanel = Record<AiField, AiResult>;
const emptyAiPanel = (): AiPanel => ({ summary: { status: 'idle', text: '' }, nextStep: { status: 'idle', text: '' } });

const statusLabels: Record<string, string> = {
    new: 'Новый', qualified: 'Квалифицирован', audit: 'Аудит', offer: 'Предложение',
    pickup_confirmed: 'Самовывоз подтверждён', ready_for_pickup: 'Готов к выдаче',
    booked: 'Записан', junk: 'Отказ',
};

function displayName(client?: Client) {
    return client?.senderName?.trim() || 'Клиент';
}

function formatTimestamp(timestamp: string, full = false) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('ru-RU', full
        ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
        : { hour: '2-digit', minute: '2-digit' });
}

export default function Conversations() {
    const { currentInstanceId } = useInstance();
    // A business switch remounts the page, discarding another tenant's selection
    // and any responses that are still in flight.
    return <BusinessConversations key={currentInstanceId ?? 'none'} currentInstanceId={currentInstanceId} />;
}

function BusinessConversations({ currentInstanceId }: { currentInstanceId: number | null }) {
    const { role } = useAuth();
    const access = useBusinessAccess();
    const [params, setParams] = useSearchParams();
    const pendingTemplate = params.get('template') || '';
    const templateBusiness = params.get('businessId');

    const [clients, setClients] = useState<Client[]>([]);
    const [selectedChatId, setSelectedChatId] = useState<string | null>(() =>
        params.get('chat') || params.get('client'));
    const [messages, setMessages] = useState<Message[]>([]);
    const [search, setSearch] = useState('');
    const requestedChannel = params.get('channel');
    const channelFilter = ['whatsapp', 'telegram', 'email', 'vk', 'max', 'instagram', 'avito'].includes(requestedChannel || '') ? requestedChannel! : 'all';
    const setChannelFilter = (channel: string) => setParams(previous => {
        const next = new URLSearchParams(previous);
        if (channel === 'all') next.delete('channel'); else next.set('channel', channel);
        next.delete('chat'); next.delete('client');
        setSelectedChatId(null);
        return next;
    });
    const selectedClient = clients.find(client => client.chatId === selectedChatId);
    const canSend = canOperateCustomer(access, selectedClient, 'messages.send');
    const canUseAi = canOperateCustomer(access, selectedClient, 'ai.use');
    const [loadingClients, setLoadingClients] = useState(true);
    const [loadingMessages, setLoadingMessages] = useState(false);
    const [clientError, setClientError] = useState(false);
    const [messageError, setMessageError] = useState(false);
    const [draft, setDraft] = useScopedDraft({ userId: access.userId, businessId: currentInstanceId || 0, chatId: selectedChatId || '' }, 'legacy-conversation-reply', '');
    const [quickReplies, setQuickReplies] = useState<QuickReplyTemplate[]>([]);
    const [quickRepliesLoading, setQuickRepliesLoading] = useState(false);
    const [quickRepliesError, setQuickRepliesError] = useState(false);
    const [quickRepliesLoaded, setQuickRepliesLoaded] = useState(false);
    const [quickRepliesRevision, setQuickRepliesRevision] = useState(0);
    const [templateError, setTemplateError] = useState('');
    const insertedTemplateRef = useRef('');
    const [sending, setSending] = useState(false);
    const [sendFeedback, setSendFeedback] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
    const [aiPanel, setAiPanel] = useState<AiPanel>(emptyAiPanel);
    const [aiPanelScope, setAiPanelScope] = useState('');
    const aiRequestIds = useRef<Record<AiField, number>>({ summary: 0, nextStep: 0 });
    const aiScopeRef = useRef({ instanceId: currentInstanceId, chatId: selectedChatId, lastMessageId: null as number | null });
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const replyTextareaRef = useRef<HTMLTextAreaElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const selectedChatIdRef = useRef(selectedChatId);
    const shouldScrollToBottomRef = useRef(false);
    const lastMessageId = messages.length ? messages[messages.length - 1].id : null;
    const currentAiScope = JSON.stringify([currentInstanceId, selectedChatId, lastMessageId]);
    const visibleAiPanel = aiPanelScope === currentAiScope ? aiPanel : emptyAiPanel();
    aiScopeRef.current = { instanceId: currentInstanceId, chatId: selectedChatId, lastMessageId };

    useEffect(() => {
        aiRequestIds.current.summary += 1;
        aiRequestIds.current.nextStep += 1;
        setAiPanelScope(currentAiScope);
        setAiPanel(emptyAiPanel());
    }, [currentAiScope]);

    const selectConversation = (chatId: string | null) => {
        selectedChatIdRef.current = chatId;
        aiScopeRef.current = { instanceId: currentInstanceId, chatId, lastMessageId: null };
        aiRequestIds.current.summary += 1;
        aiRequestIds.current.nextStep += 1;
        setAiPanelScope('');
        setAiPanel(emptyAiPanel());
        setSelectedChatId(chatId);
        // Clear the old transcript synchronously so it can never render beneath
        // the newly selected client's header while the next request starts.
        setMessages([]);
        setLoadingMessages(Boolean(chatId));
        setSendFeedback(null);
        setMessageError(false);
        const next = new URLSearchParams(params);
        if (chatId) { next.set('chat', chatId); next.set('client', chatId); }
        else { next.delete('chat'); next.delete('client'); }
        setParams(next, { replace: true });
    };

    useLayoutEffect(() => {
        const requested = params.get('chat') || params.get('client');
        if (requested !== selectedChatIdRef.current) selectConversation(requested);
    }, [params]);

    const generateAiContext = async (field: AiField) => {
        if (!canUseAi || !currentInstanceId || !selectedChatId || messages.length === 0 || loadingMessages || visibleAiPanel[field].status === 'loading') return;
        const scope = { instanceId: currentInstanceId, chatId: selectedChatId, lastMessageId };
        const requestId = ++aiRequestIds.current[field];
        setAiPanelScope(currentAiScope);
        setAiPanel(current => ({ ...current, [field]: { status: 'loading', text: '' } }));
        try {
            const result = field === 'summary' ? await getAiSummary(scope.instanceId, scope.chatId) : await getAiNextStep(scope.instanceId, scope.chatId);
            const latest = aiScopeRef.current;
            if (aiRequestIds.current[field] !== requestId || latest.instanceId !== scope.instanceId
                || latest.chatId !== scope.chatId || latest.lastMessageId !== scope.lastMessageId) return;
            if (!result?.success) throw new Error('ai_unavailable');
            const text = typeof (field === 'summary' ? result.summary : result.nextStep) === 'string'
                ? String(field === 'summary' ? result.summary : result.nextStep).trim() : '';
            setAiPanel(current => ({ ...current, [field]: { status: text ? 'success' : 'empty', text } }));
        } catch {
            const latest = aiScopeRef.current;
            if (aiRequestIds.current[field] === requestId && latest.instanceId === scope.instanceId
                && latest.chatId === scope.chatId && latest.lastMessageId === scope.lastMessageId) {
                setAiPanel(current => ({ ...current, [field]: { status: 'error', text: '' } }));
            }
        }
    };

    const isNearMessagesBottom = () => {
        const container = messagesContainerRef.current;
        if (!container) return true;
        return container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    };

    useEffect(() => {
        if (!currentInstanceId) return;
        void loadClients(true);
        const interval = setInterval(() => void loadClients(false), 15000);
        return () => clearInterval(interval);
    }, [currentInstanceId]);

    useEffect(() => {
        if (!currentInstanceId || !canSend) { setQuickReplies([]); setQuickRepliesLoaded(false); return; }
        let active = true;
        setQuickReplies([]);
        setQuickRepliesError(false);
        setQuickRepliesLoaded(false);
        setQuickRepliesLoading(true);
        getTemplates(currentInstanceId)
            .then(result => {
                if (!active) return;
                if (!result?.success || !Array.isArray(result.templates)
                    || result.templates.some((item: QuickReplyTemplate) => item.instanceId !== currentInstanceId
                        || !Number.isSafeInteger(item.id) || typeof item.text !== 'string' || typeof item.label !== 'string')) throw new Error('Quick replies unavailable');
                setQuickReplies((result.templates || []).map((item: QuickReplyTemplate) => ({
                    id: item.id, instanceId: item.instanceId, label: item.label, text: item.text,
                })));
                setQuickRepliesLoaded(true);
            })
            .catch(() => { if (active) setQuickRepliesError(true); })
            .finally(() => { if (active) setQuickRepliesLoading(false); });
        return () => { active = false; };
    }, [currentInstanceId, canSend, quickRepliesRevision]);

    useEffect(() => {
        selectedChatIdRef.current = selectedChatId;
        if (!selectedChatId || !currentInstanceId) return;
        setMessages([]);
        void loadMessages(selectedChatId, { forceScroll: true, showLoading: true });
        const interval = setInterval(() => void loadMessages(selectedChatId), 5000);
        return () => clearInterval(interval);
    }, [selectedChatId, currentInstanceId]);

    useEffect(() => {
        if (!shouldScrollToBottomRef.current) return;
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
        shouldScrollToBottomRef.current = false;
    }, [messages]);

    const loadClients = async (showLoading: boolean) => {
        if (!currentInstanceId) return;
        if (showLoading) setLoadingClients(true);
        try {
            const data = await getClients(currentInstanceId);
            if (data.success) {
                const nextClients = (data.clients || []) as Client[];
                setClients(nextClients);
                setClientError(false);
                if (selectedChatIdRef.current && !nextClients.some(client => client.chatId === selectedChatIdRef.current)) {
                    selectConversation(null);
                }
            } else setClientError(true);
        } catch (error) {
            console.error('Failed to load clients', error);
            setClientError(true);
        } finally {
            if (showLoading) setLoadingClients(false);
        }
    };

    const loadMessages = async (
        chatId: string,
        options: { forceScroll?: boolean; showLoading?: boolean } = {}
    ) => {
        if (!currentInstanceId) return;
        const shouldScrollAfterUpdate = options.forceScroll || isNearMessagesBottom();
        if (options.showLoading) setLoadingMessages(true);
        try {
            const data = await getMessages(currentInstanceId, chatId);
            if (selectedChatIdRef.current === chatId) {
                if (data.success) {
                    shouldScrollToBottomRef.current = shouldScrollAfterUpdate;
                    setMessages(data.messages || []);
                    setMessageError(false);
                } else setMessageError(true);
            }
        } catch (error) {
            console.error('Failed to load messages', error);
            if (selectedChatIdRef.current === chatId) setMessageError(true);
        } finally {
            if (options.showLoading && selectedChatIdRef.current === chatId) setLoadingMessages(false);
        }
    };

    const handleSend = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const text = draft.trim();
        if (!canSend || !currentInstanceId || !selectedClient || !text || sending) return;
        const chatId = selectedClient.chatId;
        setSending(true);
        setSendFeedback(null);
        try {
            const result = await sendMessageToClient(currentInstanceId, chatId, text);
            if (!result?.success) throw new Error(result?.error || 'Не удалось отправить сообщение.');
            if (selectedChatIdRef.current === chatId) {
                setDraft('');
                setSendFeedback({ type: 'success', text: 'Сообщение отправлено.' });
                await loadMessages(chatId, { forceScroll: true });
            }
        } catch (error) {
            console.error('Failed to send conversation reply', error);
            if (selectedChatIdRef.current === chatId) setSendFeedback({ type: 'error', text: error instanceof Error && error.message !== 'Network Error'
                ? error.message : 'Не удалось отправить сообщение. Проверьте подключение канала и повторите попытку.' });
        } finally {
            setSending(false);
        }
    };

    const insertQuickReply = (templateId: string, append = false) => {
        if (!canSend || sending || !selectedClient) return false;
        const template = quickReplies.find(item => String(item.id) === templateId);
        if (!template || template.instanceId !== currentInstanceId) return false;
        const textarea = replyTextareaRef.current;
        const start = append ? draft.length : textarea?.selectionStart ?? draft.length;
        const end = append ? draft.length : textarea?.selectionEnd ?? draft.length;
        const separator = start > 0 && draft[start - 1] !== '\n' ? '\n' : '';
        const suffix = end < draft.length && !template.text.endsWith('\n') ? '\n' : '';
        const insertion = `${separator}${template.text}${suffix}`;
        const nextDraft = `${draft.slice(0, start)}${insertion}${draft.slice(end)}`;
        const caret = start + insertion.length;
        setDraft(nextDraft);
        setSendFeedback(null);
        window.requestAnimationFrame(() => {
            const current = replyTextareaRef.current;
            if (!current) return;
            current.focus();
            current.setSelectionRange(caret, caret);
        });
        return true;
    };

    useEffect(() => {
        if (!pendingTemplate) { setTemplateError(''); return; }
        if (templateBusiness && templateBusiness !== String(currentInstanceId)) {
            setTemplateError('Этот шаблон относится к другому бизнесу. Выберите быстрый ответ текущего бизнеса.'); return;
        }
        if (!selectedClient || !canSend || sending || quickRepliesLoading || !quickRepliesLoaded || quickRepliesError) return;
        if (!/^[1-9][0-9]*$/.test(pendingTemplate) || !quickReplies.some(item => String(item.id) === pendingTemplate)) {
            setTemplateError('Выбранный шаблон не найден в этом бизнесе. Выберите другой быстрый ответ.'); return;
        }
        const identity = `${currentInstanceId}:${selectedChatId}:${pendingTemplate}`;
        if (insertedTemplateRef.current === identity) return;
        if (!insertQuickReply(pendingTemplate, true)) return;
        insertedTemplateRef.current = identity; setTemplateError('');
        setSendFeedback({ type: 'success', text: 'Шаблон добавлен в черновик. Проверьте текст перед отправкой.' });
        const next = new URLSearchParams(params); next.delete('template'); setParams(next, { replace: true });
    }, [pendingTemplate, templateBusiness, currentInstanceId, selectedChatId, selectedClient, canSend, sending,
        quickRepliesLoading, quickRepliesLoaded, quickRepliesError, quickReplies, draft, params, setParams]);

    if (!currentInstanceId) {
        return <div className="conversation-no-business">Выберите бизнес в боковом меню, чтобы увидеть его диалоги.</div>;
    }

    const availableChannels = [...new Set(clients.flatMap(client => client.channels || []).map(channel => channel.toLowerCase())
        .filter((channel): channel is string => Boolean(channel && channelLabels[channel])))];
    const filteredClients = clients.filter(client => {
        const matchesChannel = channelFilter === 'all' || (client.channels || []).some(channel => channel.toLowerCase() === channelFilter);
        const query = search.trim().toLocaleLowerCase('ru-RU');
        return matchesChannel && (!query || displayName(client).toLocaleLowerCase('ru-RU').includes(query)
            || client.chatId.toLocaleLowerCase('ru-RU').includes(query));
    });
    return <section className={`conversation-page${selectedChatId ? ' has-selection' : ''}`} aria-label="Диалоги бизнеса">
        <div className="conversation-page-heading">
            <div>
                <p className="conversation-kicker">ОБЩЕНИЕ С КЛИЕНТАМИ</p>
                <h1>Диалоги</h1>
                <p>История сообщений выбранного бизнеса в одном месте.</p>
            </div>
            <span className="conversation-total"><MessageCircle size={17} aria-hidden="true" />{loadingClients || clientError ? '—' : clients.length} {clients.length === 1 ? 'клиент' : 'клиентов'}</span>
        </div>

        <div className="conversation-workspace">
            <aside className="conversation-list-panel" aria-label="Список диалогов">
                <div className="conversation-list-tools">
                    <h2><Inbox size={18} aria-hidden="true" /> Входящие</h2>
                    <label className="conversation-search">
                        <Search size={18} aria-hidden="true" />
                        <span className="sr-only">Поиск по имени или идентификатору клиента</span>
                        <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Найти клиента" />
                    </label>
                    {availableChannels.length > 0 && <div className="conversation-filters" aria-label="Фильтр по каналу">
                        <button type="button" className={channelFilter === 'all' ? 'is-active' : ''}
                            aria-pressed={channelFilter === 'all'} onClick={() => setChannelFilter('all')}>Все</button>
                        {availableChannels.map(channel => <button type="button" key={channel}
                            className={channelFilter === channel ? 'is-active' : ''}
                            aria-pressed={channelFilter === channel} onClick={() => setChannelFilter(channel)}>
                            {channelLabels[channel]}
                        </button>)}
                    </div>}
                </div>

                <div className="conversation-client-list">
                    {clientError && <div className="conversation-list-feedback" role="alert">
                        Не удалось обновить диалоги. <button type="button" onClick={() => void loadClients(true)}>Повторить</button>
                    </div>}
                    {loadingClients && clients.length === 0 ? <p className="conversation-list-feedback" role="status">Загружаем диалоги…</p>
                        : filteredClients.length === 0 ? <div className="conversation-list-feedback">
                            <MessageCircle size={28} aria-hidden="true" />
                            <p>{search || channelFilter !== 'all' ? 'По этому запросу диалогов нет' : 'Диалогов пока нет'}</p>
                        </div> : filteredClients.map(client => <button type="button" key={client.chatId}
                            className={`conversation-client${selectedChatId === client.chatId ? ' is-selected' : ''}`}
                            aria-pressed={selectedChatId === client.chatId}
                            onClick={() => selectConversation(client.chatId)}>
                            <span className="conversation-client-avatar" aria-hidden="true"><UserRound size={18} /></span>
                            <span className="conversation-client-body">
                                <span className="conversation-client-top"><strong>{displayName(client)}</strong>
                                    <time>{formatTimestamp(client.lastMessageTime, true)}</time></span>
                                <span className="conversation-client-preview">{client.lastMessage || 'Нет сообщений'}</span>
                                <span className="conversation-client-bottom"><span className="conversation-client-status">{statusLabels[client.leadStatus] || client.leadStatus || 'Без статуса'}</span>
                                    {(client.channels || []).filter(channel => channelLabels[channel.toLowerCase()]).map(channel =>
                                        <span key={channel} className="conversation-client-channel">{channelLabels[channel.toLowerCase()]}</span>)}
                                </span>
                            </span>
                            <ChevronRight size={17} className="conversation-client-chevron" aria-hidden="true" />
                        </button>)}
                </div>
            </aside>

            <div className="conversation-chat-panel">
                {templateError && <p className="conversation-message-feedback" role="alert">{templateError}</p>}
                {!selectedChatId ? <div className="conversation-empty-chat">
                    <span className="conversation-empty-icon"><MessageCircle size={29} aria-hidden="true" /></span>
                    <h2>Выберите диалог</h2>
                    <p>Откройте клиента слева, чтобы увидеть историю общения.</p>
                </div> : <>
                    <header className="conversation-chat-header">
                        <button type="button" className="conversation-back" aria-label="Вернуться к списку диалогов" onClick={() => selectConversation(null)}>
                            <ArrowLeft size={21} aria-hidden="true" />
                        </button>
                        <span className="conversation-chat-avatar" aria-hidden="true"><UserRound size={20} /></span>
                        <div className="conversation-chat-person">
                            <h2>{displayName(selectedClient)}</h2>
                            <p>{selectedChatId}</p>
                        </div>
                        <Link className="conversation-customer-link" to={`/customers/${encodeURIComponent(selectedChatId)}`}>Карточка клиента</Link>
                        <span className="conversation-chat-status">{statusLabels[selectedClient?.leadStatus || ''] || selectedClient?.leadStatus || 'Без статуса'}</span>
                    </header>

                    <div ref={messagesContainerRef} className="conversation-messages" role="log" aria-label={`История переписки: ${displayName(selectedClient)}`}>
                        {messageError && <div className="conversation-message-feedback" role="alert">
                            Не удалось обновить сообщения. <button type="button" onClick={() => void loadMessages(selectedChatId, { showLoading: true })}>Повторить</button>
                        </div>}
                        {loadingMessages && messages.length === 0 ? <p className="conversation-message-feedback" role="status">Загружаем сообщения…</p>
                            : messages.length === 0 ? <p className="conversation-message-feedback">Сообщений пока нет.</p>
                                : messages.map(message => {
                                    const fromAva = message.role === 'assistant';
                                    return <div key={message.id} className={`conversation-message-row${fromAva ? ' from-ava' : ' from-client'}`}>
                                        <span className="conversation-message-avatar" aria-hidden="true">{fromAva ? <Bot size={16} /> : <UserRound size={16} />}</span>
                                        <div className="conversation-message-bubble">
                                            <div className="conversation-message-heading">
                                                <strong>{fromAva ? 'AVA' : displayName(selectedClient)}</strong>
                                                {message.channel && channelLabels[message.channel.toLowerCase()] && <span>{channelLabels[message.channel.toLowerCase()]}</span>}
                                            </div>
                                            <p className="conversation-message-content">{message.content || 'Сообщение без текста'}</p>
                                            {message.media && currentInstanceId && <MediaAttachment
                                                media={message.media}
                                                businessId={currentInstanceId}
                                                chatId={selectedChatId}
                                                messageId={message.id}
                                                canRetry={Boolean(canSend && message.media.canRetry)}
                                                onRetried={() => { void loadMessages(selectedChatId); void loadClients(false); }}
                                            />}
                                            {role === 'platform_admin' && fromAva && message.aiThought && <details className="conversation-ai-thought">
                                                <summary>Диагностика ответа</summary><p>{message.aiThought}</p>
                                            </details>}
                                            <time className="conversation-message-time" dateTime={message.timestamp}><Clock3 size={12} aria-hidden="true" />{formatTimestamp(message.timestamp)}</time>
                                        </div>
                                    </div>;
                                })}
                        <div ref={messagesEndRef} />
                    </div>
                    {pendingTemplate && !access.checking && !canSend && <p className="conversation-message-feedback" role="alert">У вас нет права отвечать в этом диалоге. Шаблон не вставлен.</p>}
                    {canSend ? <form className="conversation-composer" onSubmit={handleSend}>
                        <label htmlFor="conversation-reply">Ваш ответ</label>
                        {selectedClient?.preferredChannel && <span className="conversation-composer-channel">Отправка через {channelLabel(selectedClient.preferredChannel)}</span>}
                        {quickReplies.length > 0 && <label className="conversation-quick-reply-picker" htmlFor="conversation-quick-reply">
                            <span>Вставить быстрый ответ</span>
                            <select id="conversation-quick-reply" value="" onChange={event => insertQuickReply(event.target.value)}>
                                <option value="" disabled>Выберите шаблон</option>
                                {quickReplies.map(template => <option key={template.id} value={template.id}>{template.label}</option>)}
                            </select>
                        </label>}
                        {quickRepliesError && <p className="conversation-quick-reply-note" role="status">Шаблоны недоступны. Можно написать ответ вручную. <button type="button" onClick={() => setQuickRepliesRevision(value => value + 1)}>Повторить загрузку шаблонов</button></p>}
                        {quickRepliesLoading && <p className="conversation-quick-reply-note" role="status">Загружаем быстрые ответы…</p>}
                        <div className="conversation-composer-row">
                            <textarea ref={replyTextareaRef} id="conversation-reply" value={draft} onChange={event => { setDraft(event.target.value); setSendFeedback(null); }}
                                placeholder="Напишите сообщение клиенту…" rows={2} disabled={!selectedClient || sending} />
                            <button type="submit" className="conversation-send-button" disabled={!selectedClient || sending || !draft.trim()}>
                                <Send size={17} aria-hidden="true" />{sending ? 'Отправка…' : 'Отправить'}
                            </button>
                        </div>
                        <p className={`conversation-send-feedback${sendFeedback ? ` is-${sendFeedback.type}` : ''}`} role={sendFeedback?.type === 'error' ? 'alert' : 'status'} aria-live="polite">
                            {sendFeedback?.text || 'Сообщение отправится только после нажатия кнопки.'}
                        </p>
                    </form> : <p className="conversation-send-feedback">Доступен просмотр переписки.{access.role === 'manager' && <Link to="/sales?view=queue"> Открыть рабочее пространство</Link>}</p>}
                </>}
            </div>
            {selectedChatId && canUseAi && <aside className="conversation-ai-panel" aria-label="Подсказки по диалогу">
                <div className="conversation-ai-heading"><span className="conversation-ai-heading-icon"><Sparkles size={19} aria-hidden="true" /></span><div><h2>Контекст диалога</h2><p>Подсказки AI, проверьте перед использованием</p></div></div>
                <AiContextSection title="Краткое резюме" icon={<Sparkles size={16} aria-hidden="true" />} result={visibleAiPanel.summary}
                    onGenerate={() => void generateAiContext('summary')} disabled={!messages.length || loadingMessages || messageError} />
                <AiContextSection title="Следующий шаг" icon={<Target size={16} aria-hidden="true" />} result={visibleAiPanel.nextStep}
                    onGenerate={() => void generateAiContext('nextStep')} disabled={!messages.length || loadingMessages || messageError} />
                <p className="conversation-ai-note">Создаются только по вашему нажатию. Не сохраняются как факты CRM и не отправляются клиенту.</p>
            </aside>}
        </div>
    </section>;
}

function AiContextSection({ title, icon, result, onGenerate, disabled }: {
    title: string; icon: ReactNode; result: AiResult; onGenerate: () => void; disabled: boolean;
}) {
    return <section className="conversation-ai-section" aria-label={title}>
        <div className="conversation-ai-section-heading">{icon}<h3>{title}</h3></div>
        {result.status === 'success' && <p className="conversation-ai-result">{result.text}</p>}
        {result.status === 'loading' && <p className="conversation-ai-feedback" role="status"><Loader2 size={16} className="conversation-ai-spinner" aria-hidden="true" /> Готовим подсказку…</p>}
        {result.status === 'error' && <p className="conversation-ai-feedback is-error" role="alert">Не удалось получить подсказку. Переписка остаётся доступной.</p>}
        {result.status === 'empty' && <p className="conversation-ai-feedback">Сервис не вернул подсказку для этого диалога.</p>}
        {result.status === 'idle' && <p className="conversation-ai-feedback">{disabled ? 'Откройте диалог с сообщениями.' : 'Нажмите кнопку, чтобы создать подсказку.'}</p>}
        <button type="button" className="conversation-ai-action" onClick={onGenerate} disabled={disabled || result.status === 'loading'}>
            {result.status === 'error' ? <RefreshCw size={16} aria-hidden="true" /> : icon}
            {result.status === 'loading' ? 'Создаём…' : result.status === 'error' ? 'Повторить' : result.status === 'success' ? 'Обновить' : 'Создать'}
            <span className="sr-only"> — {title.toLowerCase()}</span>
        </button>
    </section>;
}
