import { useEffect, useRef, useState } from 'react';
import { useInstance } from '../context/InstanceContext';
import { useAuth } from '../context/AuthContext';
import { simulateChat } from '../api';
import { Send, Bot, User, Trash2, X } from 'lucide-react';

function errorText(error: unknown) {
    const failure = error as { code?: string; response?: { status?: number } };
    if (failure?.code === 'ECONNABORTED' || failure?.code === 'ETIMEDOUT') {
        return 'Ответ не успел прийти. Повторите сообщение.';
    }
    if (failure?.response?.status === 403) return 'Доступ к симулятору этого бизнеса изменился.';
    return 'Не удалось получить ответ симулятора. Повторите сообщение позже.';
}

export default function Simulator() {
    const { currentInstanceId } = useInstance();
    const { role, memberships, userId, permissionsLoading } = useAuth();
    if (!currentInstanceId) {
        return <div className="flex items-center justify-center h-full"><p className="text-neu-muted">Выберите бизнес для тестирования</p></div>;
    }
    if (role !== 'platform_admin' && !memberships.some(item => item.businessId === currentInstanceId && item.role === 'hotel_owner')) {
        return <div className="flex items-center justify-center h-full"><p className="text-neu-muted">Симулятор доступен владельцу выбранного бизнеса.</p></div>;
    }
    const membership = memberships.find(item => item.businessId === currentInstanceId);
    const scope = `${currentInstanceId}:${userId ?? ''}:${role}:${membership?.role ?? ''}:${membership?.capabilities?.slice().sort().join(',') ?? ''}`;
    return <SimulatorContent key={scope} businessId={currentInstanceId} permissionsLoading={Boolean(permissionsLoading)} />;
}

function SimulatorContent({ businessId, permissionsLoading }: { businessId: number; permissionsLoading: boolean }) {
    const [messages, setMessages] = useState<{ role: string, content: string }[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [pendingQuestion, setPendingQuestion] = useState('');
    const [error, setError] = useState('');
    const [noEffectsConfirmed, setNoEffectsConfirmed] = useState(false);
    const requestRef = useRef<AbortController | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => () => { requestRef.current?.abort(); requestRef.current = null; }, []);

    const handleSend = async (event: React.FormEvent) => {
        event.preventDefault();
        const question = input.trim();
        if (!question || requestRef.current || permissionsLoading) return;

        const controller = new AbortController();
        requestRef.current = controller;
        const userMsg = { role: 'user', content: question };
        setPendingQuestion(question);
        setNoEffectsConfirmed(false);
        setError('');
        setLoading(true);

        try {
            const res = await simulateChat({
                message: question,
                history: messages,
                instanceId: businessId
            }, controller.signal);

            if (controller.signal.aborted || requestRef.current !== controller) return;
            const reply = typeof res.response === 'object' ? res.response?.reply : res.response;
            if (res.success !== true || typeof reply !== 'string' || !reply.trim()) throw new Error('Invalid simulator response');
            setNoEffectsConfirmed(res.capabilities?.dryRun === true && res.capabilities?.effectsDisabled === true && res.capabilities?.toolsEnabled === false);
            setMessages(prev => [...prev, userMsg, { role: 'assistant', content: reply }]);
            setInput(current => current.trim() === question ? '' : current);
        } catch (error) {
            if (!controller.signal.aborted && requestRef.current === controller) setError(errorText(error));
        } finally {
            if (requestRef.current === controller) { requestRef.current = null; setLoading(false); setPendingQuestion(''); }
        }
    };

    const cancelSend = (event: React.MouseEvent<HTMLButtonElement>) => {
        // Cancel swaps this form button back to submit before its native default action.
        event.preventDefault();
        requestRef.current?.abort(); requestRef.current = null; setLoading(false); setPendingQuestion('');
        setError('Ожидание отменено. Сообщение сохранено — его можно повторить.');
        inputRef.current?.focus();
    };

    const handleClear = () => { requestRef.current?.abort(); requestRef.current = null; setLoading(false); setPendingQuestion(''); setError(''); setMessages([]); setNoEffectsConfirmed(false); };

    return (
        <div className="flex flex-col h-[calc(100vh-3rem)] max-w-3xl mx-auto">
            <div className="flex justify-between items-center mb-4">
                <div>
                    <h1 className="text-2xl font-bold text-neu-text">Проверка ассистента</h1>
                    <p className="text-neu-muted text-sm mt-1">Тестовый разговор с текущими настройками и знаниями выбранного бизнеса.</p>
                </div>
                {(messages.length > 0 || loading) && (
                    <button type="button" onClick={handleClear} className="btn-secondary text-sm">
                        <Trash2 size={16} /> Очистить
                    </button>
                )}
            </div>

            {noEffectsConfirmed && <p className="text-sm text-neu-muted mb-3" role="status">Только проверка ответов: внешние действия отключены.</p>}
            <div className="card flex-1 flex flex-col">
                {/* Messages */}
                <div className="flex-1 overflow-auto p-4 space-y-4">
                    {messages.length === 0 && !loading && (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="w-16 h-16 bg-neu-surface-2 rounded-2xl flex items-center justify-center mb-4 shadow-neu-raised-sm">
                                <Bot size={32} className="text-neu-muted" />
                            </div>
                            <p className="text-neu-muted text-sm">Напишите сообщение, чтобы начать тестирование</p>
                            <p className="text-neu-dim text-xs mt-1">Бот использует настройки текущего бизнеса</p>
                        </div>
                    )}
                    {[...messages, ...(pendingQuestion ? [{ role: 'user', content: pendingQuestion }] : [])].map((msg, idx) => (
                        <div key={idx} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                            {msg.role === 'assistant' && (
                                <div className="w-8 h-8 rounded-full bg-accent-2/20 flex items-center justify-center flex-shrink-0 mt-1 shadow-neu-raised-sm">
                                    <Bot size={16} className="text-accent-2" />
                                </div>
                            )}
                            <div className={`min-w-0 max-w-[82%] sm:max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed transition-colors duration-200 motion-reduce:transition-none shadow-neu-raised-sm ${msg.role === 'user'
                                    ? 'conversation-outgoing rounded-tr-md'
                                    : 'conversation-incoming rounded-tl-md'
                                }`}>
                                <span className="whitespace-pre-wrap break-words">{msg.content}</span>
                            </div>
                            {msg.role === 'user' && (
                                <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center flex-shrink-0 mt-1 shadow-neu-raised-sm">
                                    <User size={16} className="text-accent" />
                                </div>
                            )}
                        </div>
                    ))}
                    {loading && (
                        <div className="flex gap-2 items-center" role="status" aria-label="Ожидаем ответ симулятора">
                            <div className="w-8 h-8 rounded-full bg-accent-2/20 flex items-center justify-center flex-shrink-0 shadow-neu-raised-sm">
                                <Bot size={16} className="text-accent-2" />
                            </div>
                            <div className="bg-neu-surface-2 rounded-2xl rounded-tl-md px-4 py-3 shadow-neu-raised-sm">
                                <div className="flex gap-1">
                                    <div className="w-2 h-2 bg-neu-muted rounded-full animate-bounce motion-reduce:animate-none" style={{ animationDelay: '0ms' }}></div>
                                    <div className="w-2 h-2 bg-neu-muted rounded-full animate-bounce motion-reduce:animate-none" style={{ animationDelay: '150ms' }}></div>
                                    <div className="w-2 h-2 bg-neu-muted rounded-full animate-bounce motion-reduce:animate-none" style={{ animationDelay: '300ms' }}></div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {/* Input */}
                {error && <div className="px-4"><p className="text-red-700" role="alert">{error}</p><button type="button" className="btn-secondary min-h-[44px] mt-2" disabled={!input.trim() || loading || permissionsLoading} onClick={() => inputRef.current?.form?.requestSubmit()}>Повторить сообщение</button></div>}
                {permissionsLoading && <p className="px-4 text-neu-muted" role="status">Проверяем доступ к бизнесу…</p>}
                <form onSubmit={event => void handleSend(event)} className="p-4 flex gap-3" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                    <label className="sr-only" htmlFor="simulator-message">Сообщение для симулятора</label>
                    <input
                        ref={inputRef}
                        id="simulator-message"
                        className="flex-1 input"
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        placeholder="Напишите сообщение..."
                        disabled={loading || permissionsLoading}
                    />
                    {loading ? <button type="button" aria-label="Отменить ожидание ответа" onClick={cancelSend} className="btn-secondary min-h-[44px] px-4"><X size={18} aria-hidden="true" /></button> : <button type="submit" aria-label="Отправить сообщение симулятору" disabled={permissionsLoading || !input.trim()} className="btn-primary min-h-[44px] px-4">
                        <Send size={18} aria-hidden="true" />
                    </button>}
                </form>
            </div>
        </div>
    );
}
