import { customerDisplayName, formatCustomerPhone } from '../customerDisplay';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useBusinessAccess } from '../permissions';
import { ArrowLeft, ArrowRight, PhoneCall, PhoneIncoming, PhoneOutgoing, RefreshCw } from 'lucide-react';
import CallResultPanel from '../components/CallResultPanel';
import { useInstance } from '../context/InstanceContext';

interface CallRow {
    id: string;
    call_id: string;
    business_id: number;
    caller_number?: string | null;
    caller_name?: string | null;
    called_number?: string | null;
    direction?: string | null;
    outcome?: string | null;
    start_time?: string | null;
    duration_seconds?: number | null;
    provider_name?: string | null;
    campaign_id?: string | null;
    recording_file?: string | null;
    recording_url?: string | null;
    phone_number_id?: string | null;
    clientChatId?: string | null;
    summary?: string | null;
    nextAction?: string | null;
}

interface CallPage {
    calls: CallRow[];
    total: number;
    total_pages: number;
}

const OUTCOMES: Record<string, string> = {
    completed: 'Завершён', answered: 'Ответили', no_answer: 'Без ответа',
    busy: 'Занято', failed: 'Ошибка', canceled: 'Отменён', transferred: 'Переведён',
    voicemail: 'Автоответчик', voicemail_drop: 'Сообщение оставлено',
    abandoned: 'Звонок прервался',
};

function formatDate(value?: string | null) {
    if (!value) return 'Время не указано';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Время не указано' : date.toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDuration(value?: number | null) {
    if (!Number.isFinite(value) || value == null || value < 0) return '—';
    const seconds = Math.floor(value);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function CallRecording({call,businessId}:{call:CallRow;businessId:number}) {
    const [failed,setFailed]=useState(false);
    const expected=`/api/calls/${businessId}/${encodeURIComponent(call.id)}/recording.wav`;
    if(call.business_id!==businessId || call.recording_url!==expected)return null;
    return <div className="min-w-0 space-y-2 sm:col-span-3">
        <audio controls preload="none" src={call.recording_url} className="w-full max-w-full"
            aria-label={`Запись звонка ${call.caller_name || call.caller_number || call.id}`}
            onError={()=>setFailed(true)} />
        {failed && <p role="status" className="text-sm text-neu-muted">Запись пока недоступна. Обновите историю и повторите воспроизведение.</p>}
    </div>;
}

export default function Calls() {
    const {currentInstanceId}=useInstance();
    const access = useBusinessAccess();
    return <ScopedCalls key={`${currentInstanceId}:${access.userId}:${access.role}`}/>;
}
function ScopedCalls() {
    const { currentInstanceId, currentInstance } = useInstance();
    const access = useBusinessAccess();
    const [params, setParams] = useSearchParams();
    const page = Math.max(1, Math.min(100000, Math.trunc(Number(params.get('page')) || 1)));
    function setPage(value: number) { setParams(previous => { const next = new URLSearchParams(previous); next.set('page', String(value)); return next; }); }
    const [data, setData] = useState<CallPage | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [revision, setRevision] = useState(0);

    useEffect(() => {
        if (!currentInstanceId) return;
        const controller = new AbortController();
        let cancelled = false;
        const timer = setTimeout(() => controller.abort(), 20000);
        setLoading(true);
        setError('');
        fetch(`/api/calls/${currentInstanceId}?page=${page}&page_size=20`, {
            credentials: 'same-origin', signal: controller.signal,
        }).then(async response => {
            if (response.status === 401) window.dispatchEvent(new Event('crm:unauthorized'));
            if (!response.ok) throw new Error('Не удалось загрузить историю звонков. Попробуйте обновить.');
            const result = await response.json();
            if (!result.success || Number(result.business_id) !== currentInstanceId || !Array.isArray(result.calls) || result.calls.some((call: CallRow) => call.business_id !== currentInstanceId)) throw new Error('История звонков недоступна.');
            if(controller.signal.aborted)return;
            setData({ calls: result.calls || [], total: result.total || 0, total_pages: result.total_pages || 1 });
        }).catch(err => {
            if (!cancelled) setError(controller.signal.aborted ? 'История звонков загружается дольше обычного. Повторите загрузку.' : err.message || 'Не удалось загрузить историю звонков.');
        }).finally(() => { clearTimeout(timer); if (!cancelled) setLoading(false); });
        return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
    }, [currentInstanceId, page, revision]);

    return (
        <div className="mx-auto max-w-6xl space-y-7 pb-10">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.25em] text-neu-muted">Связь · {currentInstance?.name || 'Бизнес'}</p>
                    <h1 className="mt-2 font-clash-display text-3xl font-bold text-neu-text sm:text-4xl">История звонков</h1>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-neu-muted">Входящие и исходящие звонки выбранного бизнеса. Кампания и результат видны для каждого сохранённого вызова.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Link to="/outbound" className="inline-flex min-h-11 items-center rounded-full border border-[#111111]/15 px-5 text-sm font-semibold text-neu-text hover:bg-[#111111]/5 focus-visible:outline focus-visible:outline-2">К кампаниям</Link>
                    <button type="button" onClick={() => setRevision(value => value + 1)} disabled={loading || !currentInstanceId} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-[#111111] px-5 text-sm font-semibold hover:bg-[#282828] focus-visible:outline focus-visible:outline-2 disabled:opacity-50" style={{ color: '#fff' }}>
                        <RefreshCw size={16} aria-hidden="true" /> Обновить
                    </button>
                </div>
            </header>

            {!currentInstanceId ? <div className="card p-8 text-center">Выберите бизнес, чтобы увидеть его звонки.</div> : null}
            {error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-800"><span>{error}</span><button type="button" onClick={() => setRevision(value => value + 1)} disabled={loading || !currentInstanceId} className="min-h-10 rounded-full border border-red-300 px-4 font-semibold hover:bg-red-100 focus-visible:outline focus-visible:outline-2 disabled:opacity-50">Повторить</button></div> : null}

            <section className="overflow-hidden rounded-[28px] border border-[#111111]/10 bg-white/85 shadow-sm" aria-label="Журнал звонков">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#111111]/10 px-5 py-4 sm:px-7">
                    <div className="flex items-center gap-3">
                        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#111111]" style={{ color: '#fff' }}><PhoneCall size={18} aria-hidden="true" /></span>
                        <div><h2 className="font-semibold text-neu-text">Звонки</h2><p className="text-xs text-neu-muted">{data ? `${data.total} всего` : loading ? 'Загрузка данных' : error ? 'Данные пока недоступны' : 'Выберите бизнес'}</p></div>
                    </div>
                    {loading ? <span className="text-sm text-neu-muted" role="status">Обновляем…</span> : null}
                </div>
                {!loading && !error && data?.calls.length === 0 ? (
                    <div className="px-6 py-16 text-center"><PhoneCall className="mx-auto text-neu-muted" size={30} aria-hidden="true" /><h3 className="mt-4 text-lg font-semibold">Звонков пока нет</h3><p className="mt-2 text-sm text-neu-muted">После первого вызова история появится здесь.</p></div>
                ) : null}
                {data?.calls.length ? <div className="divide-y divide-[#111111]/10">
                    {data.calls.map(call => {
                        const outgoing = call.direction === 'outbound';
                        const number = outgoing ? call.called_number : call.caller_number;
                        const callerName = call.caller_name?.trim();
                        return <article key={call.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,.8fr)] sm:items-center sm:px-7">
                            <div className="flex min-w-0 items-center gap-3">
                                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#111111]/5 text-neu-text">{outgoing ? <PhoneOutgoing size={19} aria-hidden="true" /> : <PhoneIncoming size={19} aria-hidden="true" />}</span>
                                <div className="min-w-0"><p className="break-words font-semibold text-neu-text">{customerDisplayName(callerName, number)}</p>{callerName && number ? <p className="break-all text-sm text-neu-muted">{formatCustomerPhone(number) || number}</p> : null}<p className="text-xs text-neu-muted">{outgoing ? 'Исходящий' : 'Входящий'} · {formatDate(call.start_time)}</p></div>
                            </div>
                            <div className="text-sm"><p className="font-medium text-neu-text">{OUTCOMES[String(call.outcome || '')] || 'Статус уточняется'}</p><p className="mt-1 text-neu-muted">Длительность {formatDuration(call.duration_seconds)}</p>{call.nextAction && <p className="mt-2">Далее: {call.nextAction}</p>}{call.clientChatId && <Link className="inline-flex min-h-11 items-center underline" to={`/customers/${encodeURIComponent(call.clientChatId)}`}>Открыть клиента</Link>}</div>
                            {access.isPlatformAdmin && <details className="min-w-0 text-xs text-neu-muted"><summary className="cursor-pointer font-medium text-neu-text">Сведения о звонке</summary><div className="mt-2 space-y-1"><p className="break-all">ID: {call.call_id || 'не указан'}</p>{call.provider_name ? <p>Провайдер: {call.provider_name}</p> : null}{call.outcome && !OUTCOMES[call.outcome] ? <p>Код результата: {call.outcome}</p> : null}{call.campaign_id ? <><p className="break-all">Кампания: {call.campaign_id}</p><Link to="/outbound" className="inline-block underline decoration-[#111111]/30 underline-offset-2 hover:text-neu-text focus-visible:outline focus-visible:outline-2">Открыть кампании</Link></> : null}</div></details>}
                            {call.summary && <p className="break-words text-sm leading-6 sm:col-span-3">{call.summary}</p>}
                            {call.call_id && <CallResultPanel key={`${call.id}:${call.call_id}`} businessId={currentInstanceId!} callId={call.call_id} recordId={call.id}/>}
                            <CallRecording key={`${call.recording_url}:${revision}`} call={call} businessId={currentInstanceId!}/>
                        </article>;
                    })}
                </div> : null}
                {data && data.total_pages > 1 ? <div className="flex items-center justify-between border-t border-[#111111]/10 px-5 py-4 sm:px-7">
                    <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)} className="inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold hover:bg-[#111111]/5 focus-visible:outline focus-visible:outline-2 disabled:opacity-40"><ArrowLeft size={16} aria-hidden="true" /> Назад</button>
                    <span className="text-sm text-neu-muted">{page} из {data.total_pages}</span>
                    <button type="button" disabled={page >= data.total_pages || loading} onClick={() => setPage(page + 1)} className="inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold hover:bg-[#111111]/5 focus-visible:outline focus-visible:outline-2 disabled:opacity-40">Далее <ArrowRight size={16} aria-hidden="true" /></button>
                </div> : null}
            </section>
        </div>
    );
}
