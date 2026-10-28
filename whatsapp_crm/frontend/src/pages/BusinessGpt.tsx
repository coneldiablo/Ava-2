import PageHeader from '../components/PageHeader';
import { useEffect, useRef, useState } from 'react';
import { BookOpen, Loader2, MessageSquarePlus, Send, Sparkles, X, RefreshCw } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInstance } from '../context/InstanceContext';
import { useAuth } from '../context/AuthContext';
import { createBusinessGptChat, getBusinessGptChat, getBusinessGptChats, sendBusinessGptMessage } from '../api';
import './BusinessGpt.css';

type Chat = { id: string; title: string; createdAt: string; updatedAt: string };
type Citation = { sourceId: number; title: string };
type AnswerSourceKind = 'document' | 'business' | 'customer' | 'deal' | 'task' | 'call' | 'memory';
type AnswerSource = { kind: AnswerSourceKind; title: string; observedAt: string; sourceId?: string | number };
type AnswerContext = { kind: 'documents' | 'crm' | 'mixed'; businessId: number; customerChatId: string | null; limitations: string[] };
type Turn = { id: string; requestId: string; question: string; answer: string; citations: Citation[];
    sourceTimestamp: string; createdAt: string; answerContext?: AnswerContext; sources?: AnswerSource[] };

const sourceLabels: Record<AnswerSourceKind, string> = {
    document: 'Документ', business: 'Данные бизнеса', customer: 'Карточка клиента', deal: 'Сделка',
    task: 'Задача', call: 'Звонок', memory: 'Контекст клиента',
};

const errors: Record<string, string> = {
    PREVIEW_UNGROUNDED: 'В базе знаний не нашлось подтверждённого ответа. Попробуйте уточнить вопрос или добавить документ.',
    PREVIEW_NO_MATCH: 'В загруженных документах не найден точный ответ. Уточните вопрос или добавьте документ с нужной информацией.',
    PREVIEW_NOT_READY: 'Поиск по базе знаний пока недоступен. Попробуйте позже.',
    PREVIEW_EMPTY: 'В базе знаний пока нет документов. Добавьте документ и дождитесь обработки.',
    PREVIEW_INDEXING: 'Документы ещё обрабатываются. Задайте вопрос после завершения обработки.',
    PREVIEW_TIMEOUT: 'AVA не успела подготовить ответ. Проверьте историю диалога или повторите вопрос.',
    KNOWLEDGE_UNAVAILABLE: 'Не удалось получить подтверждённый ответ из базы знаний. Попробуйте позже.',
    CHAT_RATE_LIMITED: 'Слишком много запросов. Подождите минуту и попробуйте снова.',
    CHAT_BUSY: 'Предыдущий вопрос ещё обрабатывается. Подождите его завершения.',
    BUSINESS_ACCESS_DENIED: 'Доступ к этому бизнесу изменился. Выберите доступный бизнес.',
    CHAT_NOT_FOUND: 'Диалог недоступен. Выберите другой диалог или создайте новый.',
};

function errorText(error: unknown) {
    const requestError = error as { code?: string; response?: { data?: { code?: string } } };
    if (requestError?.code === 'ECONNABORTED' || requestError?.code === 'ETIMEDOUT') {
        return 'Ответ не успел прийти. Проверьте историю диалога или повторите вопрос.';
    }
    const code = requestError?.response?.data?.code;
    return code && errors[code] ? errors[code] : 'Не удалось выполнить действие. Проверьте соединение и попробуйте снова.';
}

function record(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function textValue(value: unknown): value is string {
    return typeof value === 'string' && Boolean(value.trim());
}
function validSource(value: unknown): value is AnswerSource {
    return record(value) && typeof value.kind === 'string' && Object.prototype.hasOwnProperty.call(sourceLabels, value.kind)
        && textValue(value.title) && textValue(value.observedAt) && Number.isFinite(Date.parse(value.observedAt))
        && (value.sourceId === undefined || textValue(value.sourceId)
            || (typeof value.sourceId === 'number' && Number.isFinite(value.sourceId)));
}
function validContext(value: unknown, businessId: number): value is AnswerContext {
    return record(value) && typeof value.kind === 'string' && ['documents', 'crm', 'mixed'].includes(value.kind)
        && value.businessId === businessId && (value.customerChatId === null || textValue(value.customerChatId))
        && Array.isArray(value.limitations) && value.limitations.every(textValue);
}
function validTurn(value: unknown, businessId: number): value is Turn {
    if (!record(value) || !textValue(value.id) || typeof value.question !== 'string' || !textValue(value.answer)
        || !Array.isArray(value.citations) || !value.citations.every(citation => record(citation)
            && Number.isSafeInteger(citation.sourceId) && Number(citation.sourceId) > 0 && textValue(citation.title))
        || typeof value.createdAt !== 'string' || typeof value.sourceTimestamp !== 'string') return false;
    const typed = value.answerContext !== undefined || value.sources !== undefined;
    if (typed && (!validContext(value.answerContext, businessId) || !Array.isArray(value.sources)
        || value.sources.length === 0 || !value.sources.every(validSource))) return false;
    // Only the explicitly scoped CRM contract can omit legacy document citations.
    return value.citations.length > 0 || (typed && record(value.answerContext) && value.answerContext.kind === 'crm');
}
function turnSources(turn: Turn): AnswerSource[] {
    return turn.sources ?? turn.citations.map(citation => ({
        kind: 'document', title: citation.title, observedAt: turn.sourceTimestamp,
    }));
}
function answerLabel(turn: Turn) {
    return turn.answerContext?.kind === 'crm' ? 'Ответ по данным бизнеса'
        : turn.answerContext?.kind === 'mixed' ? 'Ответ по документам и данным бизнеса' : 'Ответ по документам';
}

export default function BusinessGpt() {
    const { currentInstanceId, currentInstance } = useInstance();
    const { userId, role, memberships, permissionsLoading } = useAuth();
    const membership = memberships.find(item => item.businessId === currentInstanceId);
    const scope = `${currentInstanceId}:${userId ?? ''}:${role}:${membership?.role ?? ''}:${membership?.capabilities?.slice().sort().join(',') ?? ''}`;
    if (!currentInstanceId) return <section className="card p-6"><h1>Помощник AVA</h1><p>Сначала выберите бизнес.</p><Link to="/instances">Мои бизнесы</Link></section>;
    return <BusinessGptContent key={scope} permissionsLoading={Boolean(permissionsLoading)} businessId={currentInstanceId} businessName={currentInstance?.name || 'вашего бизнеса'} />;
}

function BusinessGptContent({ businessId, permissionsLoading }: { businessId: number; businessName: string; permissionsLoading: boolean }) {
    const [chats, setChats] = useState<Chat[]>([]);
    const [chatId, setChatId] = useState<string | null>(null);
    const [turns, setTurns] = useState<Turn[]>([]);
    const [params, setParams] = useSearchParams();
    const [draft, setDraft] = useState(() => (params.get('question') || '').slice(0, 1200));
    useEffect(() => {
        if (!params.has('question')) return;
        const next = new URLSearchParams(params); next.delete('question'); setParams(next, { replace: true });
    }, [params, setParams]);
    const [loading, setLoading] = useState(true);
    const [loadingChat, setLoadingChat] = useState(false);
    const [creating, setCreating] = useState(false);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState('');
    const [errorCode, setErrorCode] = useState('');
    const [listFailed, setListFailed] = useState(false);
    const [listRevision, setListRevision] = useState(0);
    const [historyFailed, setHistoryFailed] = useState(false);
    const [historyRevision, setHistoryRevision] = useState(0);
    const busyRef = useRef(false);
    const requestRef = useRef<AbortController | null>(null);
    const selectedChatRef = useRef<string | null>(null);
    const displayedChatRef = useRef<string | null>(null);
    const draftsRef = useRef(new Map<string, string>());
    const pendingChatRef = useRef<string | null>(null);
    const pendingRequestRef = useRef(new Map<string, { question: string; requestId: string }>());
    const initialTurnRef = useRef<{ chatId: string; turn: Turn } | null>(null);
    const endRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => () => { requestRef.current?.abort(); requestRef.current = null; }, []);

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setListFailed(false);
        setError('');
        setErrorCode('');
        getBusinessGptChats(businessId, controller.signal).then(data => {
            if (controller.signal.aborted) return;
            if (data.success !== true || !Array.isArray(data.chats)) throw new Error('Invalid chat list');
            setChats(data.chats || []);
            const selected = selectedChatRef.current && data.chats.some((chat: Chat) => chat.id === selectedChatRef.current)
                ? selectedChatRef.current : data.chats?.[0]?.id || null;
            selectedChatRef.current = selected;
            setChatId(selected);
        }).catch(error => { if (!controller.signal.aborted) { setListFailed(true); setError(errorText(error)); setErrorCode(''); } })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [businessId, listRevision]);

    useEffect(() => {
        if (!chatId) { displayedChatRef.current = null; setTurns([]); setLoadingChat(false); setHistoryFailed(false); return; }
        const controller = new AbortController();
        const initialTurn = initialTurnRef.current?.chatId === chatId ? initialTurnRef.current.turn : null;
        initialTurnRef.current = null;
        if (displayedChatRef.current !== chatId) setTurns(initialTurn ? [initialTurn] : []);
        displayedChatRef.current = chatId;
        setLoadingChat(true);
        setHistoryFailed(false);
        getBusinessGptChat(businessId, chatId, controller.signal).then(data => {
            if (controller.signal.aborted || selectedChatRef.current !== chatId) return;
            if (data.success !== true || !Array.isArray(data.turns) || !data.turns.every((turn: unknown) => validTurn(turn, businessId))) throw new Error('Invalid chat history');
            setTurns(current => {
                const fetchedIds = new Set(data.turns.map((turn: Turn) => turn.id));
                return [...data.turns, ...current.filter(turn => !fetchedIds.has(turn.id))]
                    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
            });
            const pending = pendingRequestRef.current.get(chatId);
            if (pending && data.turns.some((turn: Turn) => turn.requestId === pending.requestId)) {
                pendingRequestRef.current.delete(chatId);
                setDraft(current => current.trim() === pending.question ? '' : current);
                draftsRef.current.delete(chatId);
                setError('');
                if (data.chat) setChats(current => current.map(chat => chat.id === chatId ? data.chat : chat));
            }
        }).catch(error => { if (!controller.signal.aborted && selectedChatRef.current === chatId) { setHistoryFailed(true); setError(errorText(error)); setErrorCode(''); } })
            .finally(() => { if (!controller.signal.aborted) setLoadingChat(false); });
        return () => controller.abort();
    }, [businessId, chatId, historyRevision]);

    useEffect(() => { endRef.current?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'end' }); }, [turns, sending]);

    const startChat = async () => {
        if (busyRef.current || loading || permissionsLoading) return;
        busyRef.current = true;
        const controller = new AbortController();
        requestRef.current = controller;
        setCreating(true);
        setError('');
        setErrorCode('');
        try {
            const data = await createBusinessGptChat(businessId, controller.signal);
            if (controller.signal.aborted || requestRef.current !== controller) return;
            if (data.success !== true || !data.chat?.id) throw new Error('Invalid created chat');
            setChats(current => [data.chat, ...current]);
            selectedChatRef.current = data.chat.id;
            setChatId(data.chat.id);
            setTurns([]);
            draftsRef.current.set(chatId || 'new', draft);
            setDraft('');
            inputRef.current?.focus();
        } catch (error) { if (!controller.signal.aborted) setError(errorText(error)); }
        finally { if (requestRef.current === controller) { requestRef.current = null; busyRef.current = false; setCreating(false); } }
    };

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        const question = draft.trim();
        if (!question || question.length > 1200 || busyRef.current || loading || loadingChat || listFailed || permissionsLoading
            || selectedChatRef.current !== chatId) return;
        busyRef.current = true;
        const controller = new AbortController();
        requestRef.current = controller;
        setSending(true);
        setError('');
        setErrorCode('');
        let createdChatId: string | null = null;
        try {
            let target = chatId;
            if (!target) {
                const created = await createBusinessGptChat(businessId, controller.signal);
                if (controller.signal.aborted || requestRef.current !== controller) return;
                if (created.success !== true || !created.chat?.id) throw new Error('Invalid created chat');
                target = created.chat.id;
                createdChatId = target;
                setChats(current => [created.chat, ...current]);
            }
            pendingChatRef.current = target;
            draftsRef.current.set(target!, question);
            const pending = pendingRequestRef.current.get(target!);
            const requestId = pending?.question === question
                ? pending.requestId : crypto.randomUUID();
            pendingRequestRef.current.set(target!, { question, requestId });
            const data = await sendBusinessGptMessage(businessId, target!, question, requestId, controller.signal);
            if (controller.signal.aborted || requestRef.current !== controller) return;
            if (data.success !== true || !validTurn(data.turn, businessId)) {
                throw new Error('Invalid chat answer');
            }
            pendingRequestRef.current.delete(target!);
            draftsRef.current.delete(target!);
            pendingChatRef.current = null;
            if (!chatId) { initialTurnRef.current = { chatId: target!, turn: data.turn }; selectedChatRef.current = target; setChatId(target); }
            else setTurns(current => current.some(turn => turn.id === data.turn.id) ? current : [...current, data.turn]);
            setDraft('');
            setChats(current => current.map(chat => chat.id === target ? {
                ...chat, title: chat.title === 'Новый диалог' ? question.slice(0, 80) : chat.title,
                updatedAt: data.turn.createdAt,
            } : chat).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
        } catch (error) {
            if (controller.signal.aborted || requestRef.current !== controller) return;
            if (createdChatId) { selectedChatRef.current = createdChatId; setChatId(createdChatId); }
            setError(errorText(error));
            setErrorCode((error as { response?: { data?: { code?: string } } })?.response?.data?.code || '');
        }
        finally { if (requestRef.current === controller) { requestRef.current = null; busyRef.current = false; setSending(false); inputRef.current?.focus(); } }
    };

    const cancelSend = () => {
        requestRef.current?.abort();
        requestRef.current = null;
        busyRef.current = false;
        setSending(false);
        if (pendingChatRef.current && !selectedChatRef.current) {
            selectedChatRef.current = pendingChatRef.current;
            setChatId(pendingChatRef.current);
        }
        setError('Ожидание отменено. Вопрос сохранён. Проверьте историю или повторите вопрос.');
        setErrorCode('REQUEST_CANCELLED');
        inputRef.current?.focus();
    };

    const selectChat = (id: string) => {
        if (id === selectedChatRef.current || creating) return;
        requestRef.current?.abort();
        requestRef.current = null;
        busyRef.current = false;
        draftsRef.current.set(selectedChatRef.current || 'new', draft);
        selectedChatRef.current = id;
        pendingChatRef.current = null;
        setSending(false);
        setDraft(draftsRef.current.get(id) || '');
        setError('');
        setErrorCode('');
        setChatId(id);
    };

    return <section className="business-gpt" aria-labelledby="business-gpt-title">
        <PageHeader id="business-gpt-title" title="Помощник AVA" description="История диалогов сохраняется здесь." />
        <div className="business-gpt__layout">
            <aside className="business-gpt__history" aria-label="История диалогов">
                <button className="business-gpt__new" type="button" onClick={startChat} disabled={sending || creating || loading || listFailed || permissionsLoading}><MessageSquarePlus size={18} /> {creating ? 'Создаём диалог…' : 'Новый диалог'}</button>
                <h2>Мои диалоги</h2>
                {loading ? <p className="business-gpt__muted">Загрузка...</p> : listFailed ? <button type="button" onClick={() => setListRevision(current => current + 1)}>Повторить загрузку диалогов</button> : chats.length ? <ul>{chats.map(chat =>
                    <li key={chat.id}><button type="button" className={chat.id === chatId ? 'is-selected' : ''}
                        aria-current={chat.id === chatId ? 'page' : undefined} onClick={() => selectChat(chat.id)} disabled={creating}>
                        <span>{chat.title}</span><time dateTime={chat.updatedAt}>{new Date(chat.updatedAt).toLocaleDateString('ru-RU')}</time>
                    </button></li>)}</ul> : <p className="business-gpt__muted">Диалогов пока нет.</p>}
            </aside>
            <div className="business-gpt__conversation">
                <div className="business-gpt__messages" role="log" aria-label="Сообщения диалога" aria-live="polite" aria-relevant="additions">
                    {loadingChat && <p className="business-gpt__muted" role="status">Загрузка диалога...</p>}
                    {turns.length ? turns.map(item =>
                        <div className="business-gpt__turn" key={item.id}>
                            <p className="business-gpt__question">{item.question}</p>
                            <article className="business-gpt__answer"><span className="business-gpt__answer-label"><Sparkles size={15} aria-hidden="true" /> {answerLabel(item)}</span>
                                <p>{item.answer}</p><details className="business-gpt__sources"><summary>{!item.answerContext || item.answerContext.kind === 'documents' ? 'Использованные документы' : 'Источники ответа'} ({turnSources(item).length})</summary><ul>{turnSources(item).map((source, index) =>
                                    <li key={`${source.kind}-${index}`}><BookOpen size={14} aria-hidden="true" /><span>{source.title}<small>{sourceLabels[source.kind]} · {new Date(source.observedAt).toLocaleString('ru-RU')}</small></span></li>)}</ul></details>
                                {!!item.answerContext?.limitations.length && <div className="business-gpt__limitations" role="note" aria-label="Ограничения ответа"><strong>Что пока нельзя подтвердить</strong><ul>{item.answerContext.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></div>}
                                <small>Данные на: {new Date(item.sourceTimestamp).toLocaleString('ru-RU')}</small>
                            </article>
                        </div>) : !loadingChat && <div className="business-gpt__welcome"><Sparkles size={28} aria-hidden="true" /><h2>Спросите о бизнесе</h2>
                            <p>Документы, клиенты, сделки и задачи.</p></div>}
                    {sending && <p className="business-gpt__pending" role="status"><Loader2 size={18} className="business-gpt__spin" /> Проверяю доступные данные и источники...</p>}
                    <div ref={endRef} />
                </div>
                <div className="business-gpt__composer">
                    {error && <p className="business-gpt__error" role={['PREVIEW_UNGROUNDED', 'PREVIEW_NO_MATCH', 'PREVIEW_EMPTY', 'PREVIEW_INDEXING', 'PREVIEW_NOT_READY'].includes(errorCode) ? 'status' : 'alert'}>{error}</p>}
                    {(historyFailed || (error && chatId && pendingRequestRef.current.has(chatId))) && <button className="business-gpt__recovery" type="button" disabled={loadingChat || sending} onClick={() => { setError(''); setHistoryRevision(current => current + 1); }}><RefreshCw size={16} aria-hidden="true" />{historyFailed ? 'Повторить загрузку истории' : 'Проверить историю'}</button>}
                    {error && draft.trim() && !sending && !listFailed && <button className="business-gpt__recovery" type="button" disabled={loadingChat || permissionsLoading} onClick={() => inputRef.current?.form?.requestSubmit()}>Повторить вопрос</button>}
                    {permissionsLoading && <p className="business-gpt__muted" role="status">Проверяем доступ к бизнесу…</p>}
                    <form onSubmit={submit}><label className="sr-only" htmlFor="business-gpt-question">Вопрос для AVA</label>
                        <textarea ref={inputRef} id="business-gpt-question" rows={3} maxLength={1200} value={draft}
                            onChange={event => setDraft(event.target.value)} disabled={sending || creating || loading || loadingChat || listFailed || permissionsLoading}
                            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
                            placeholder="Например: условия заселения" />
                        {sending ? <button type="button" aria-label="Отменить ожидание ответа" onClick={cancelSend}><X size={18} aria-hidden="true" /></button> : <button type="submit" disabled={!draft.trim() || creating || loading || loadingChat || listFailed || permissionsLoading} aria-label="Отправить вопрос"><Send size={18} aria-hidden="true" /></button>}</form>
                </div>
            </div>
        </div>
    </section>;
}
