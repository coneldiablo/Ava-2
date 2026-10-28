import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, LoaderCircle, MessageSquareText, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { useInstance } from '../context/InstanceContext';
import { useBusinessAccess } from '../permissions';
import { Link, useSearchParams } from 'react-router-dom';
import { hasUnresolvedPlaceholders } from './customerListHelpers';
import { createTemplate, deleteTemplate, getTemplates } from '../api';

type Template = { id: number; instanceId: number; label: string; text: string; createdAt?: string };

export default function QuickReplies() {
    const { currentInstanceId, currentInstance } = useInstance();
    const access = useBusinessAccess();
    return <BusinessQuickReplies key={`${currentInstanceId}:${access.userId}:${access.role}`}  businessId={currentInstanceId} businessName={currentInstance?.name || ''} />;
}

function BusinessQuickReplies({ businessId: currentInstanceId, businessName }: { businessId: number | null; businessName: string }) {
    const access = useBusinessAccess();
    const [params] = useSearchParams();
    const client = params.get('client') || '';
    const canManage = !access.checking && (access.isPlatformAdmin || access.can('business.manage'));
    const [query, setQuery] = useState('');
    const [limit, setLimit] = useState(20);
    const [templates, setTemplates] = useState<Template[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const [error, setError] = useState('');
    const [label, setLabel] = useState('');
    const [text, setText] = useState('');
    const shown = templates.filter(template => `${template.label} ${template.text}`.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')));

    const load = useCallback(async () => {
        if (!currentInstanceId) return;
        setLoading(true);
        setError('');
        try {
            const result = await getTemplates(currentInstanceId);
            if (!result.success || !Array.isArray(result.templates) || result.templates.some((template: Template) => template.instanceId !== currentInstanceId)) throw new Error('Не удалось загрузить шаблоны выбранного бизнеса. Повторите загрузку.');
            setTemplates(result.templates || []);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Не удалось загрузить шаблоны.');
        } finally { setLoading(false); }
    }, [currentInstanceId]);

    useEffect(() => { setTemplates([]); void load(); }, [load]);

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!currentInstanceId || !canManage || saving) return;
        setSaving(true); setError('');
        try {
            const result = await createTemplate(currentInstanceId, { label: label.trim(), text: text.trim() });
            if (!result.success) throw new Error('Не удалось сохранить шаблон. Текст сохранён в форме; повторите попытку.');
            if (result.template) setTemplates(items => [...items, result.template]);
            else await load();
            setLabel(''); setText('');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Не удалось сохранить шаблон.');
        } finally { setSaving(false); }
    };

    const remove = async (template: Template) => {
        if (!currentInstanceId || !canManage || deletingId !== null) return;
        setDeletingId(template.id); setError('');
        try {
            const result = await deleteTemplate(currentInstanceId, template.id);
            if (!result.success) throw new Error('Не удалось удалить шаблон. Обновите список и повторите попытку.');
            setTemplates(items => items.filter(item => item.id !== template.id));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Не удалось удалить шаблон.');
        } finally { setDeletingId(null); }
    };

    if (!currentInstanceId) return <main className="mx-auto max-w-5xl p-6 md:p-10">
        <section className="rounded-3xl border border-slate-200 bg-white/80 p-8 shadow-sm"><h1 className="text-2xl font-semibold text-slate-900">Быстрые ответы</h1><p className="mt-2 text-slate-600">Сначала выберите бизнес, чтобы управлять его шаблонами сообщений.</p></section>
    </main>;

    return <main className="mx-auto max-w-6xl space-y-8 p-5 md:p-10">
        <header className="relative overflow-hidden rounded-[28px] border border-violet-100 bg-gradient-to-br from-white via-white to-violet-50/80 p-7 shadow-[0_16px_50px_-32px_rgba(64,48,120,.28)] md:p-10">
            <div aria-hidden="true" className="absolute -right-8 -top-16 h-52 w-52 rounded-full bg-violet-200/30 blur-3xl" />
            <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
                <div className="max-w-2xl">
                    <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-violet-100 bg-white/80 px-3 py-1.5 text-xs font-medium text-violet-700"><Sparkles size={14} aria-hidden="true" /> Шаблоны команды</div>
                    <h1 className="text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">Быстрые ответы</h1>
                    <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600 md:text-base">Сохраняйте часто используемые сообщения и отвечайте клиентам быстрее. Шаблоны доступны только для выбранного бизнеса.</p>
                </div>
                <div className="rounded-2xl border border-white bg-white/80 px-4 py-3 text-sm shadow-sm"><span className="block text-xs text-slate-500">Выбранный бизнес</span><span className="font-medium text-slate-900">{businessName || `Бизнес #${currentInstanceId}`}</span></div>
            </div>
        </header>

        {error && <div role="alert" className="flex items-start justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"><span>{error}</span><button type="button" aria-label="Скрыть сообщение об ошибке" onClick={() => setError('')} className="min-h-[44px] min-w-[44px] -my-2 flex items-center justify-center rounded-xl hover:bg-rose-100">×</button></div>}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,.78fr)]">
            <section className="space-y-4" aria-labelledby="saved-title">
                <div className="flex items-center justify-between gap-3"><div><h2 id="saved-title" className="text-xl font-semibold text-slate-900">Ваши шаблоны</h2><p className="mt-1 text-sm text-slate-500">{templates.length} {templates.length === 1 ? 'ответ' : 'ответов'}</p></div>
                    <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500"><RefreshCw size={16} className={loading ? 'animate-spin' : ''} aria-hidden="true" /><span>Обновить</span></button>
                </div>
                <label className="block text-sm text-slate-700">Найти быстрый ответ<input type="search" value={query} onChange={event => { setQuery(event.target.value); setLimit(20); }} className="mt-2 min-h-[44px] w-full rounded-xl border border-slate-200 px-3" /></label>
                {loading && !templates.length ? <div role="status" className="flex min-h-48 items-center justify-center gap-3 rounded-3xl border border-slate-200 bg-white/70 text-sm text-slate-500"><LoaderCircle className="animate-spin" size={20} aria-hidden="true" /> Загружаем шаблоны…</div>
                    : shown.length === 0 ? <div className="flex min-h-56 flex-col items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white/60 px-6 text-center"><span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-50 text-violet-600"><MessageSquareText size={22} aria-hidden="true" /></span><h3 className="font-medium text-slate-900">{query ? 'Ответы не найдены' : 'Пока нет быстрых ответов'}</h3><p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">Создайте первый шаблон — например, приветствие или ответ на частый вопрос.</p></div>
                        : <ul className="space-y-3">{shown.slice(0, limit).map(template => <li key={template.id} className="group rounded-3xl border border-slate-200/80 bg-white/85 p-5 shadow-[0_8px_28px_-24px_rgba(15,23,42,.35)] transition hover:border-violet-200 hover:shadow-md">
                            <div className="flex items-start justify-between gap-3"><h3 className="min-w-0 break-words font-semibold text-slate-900">{template.label}</h3>{canManage && <button type="button" onClick={() => void remove(template)} disabled={deletingId !== null} aria-label={`Удалить шаблон «${template.label}»`} className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-500">{deletingId === template.id ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <Trash2 size={18} aria-hidden="true" />}</button>}</div>
                            <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{template.text}</p>
                            {hasUnresolvedPlaceholders(template.text) && <p className="mt-3 text-sm text-amber-800">В тексте есть подстановки. Заполните их в редакторе перед отправкой.</p>}
                            {!access.checking && access.can('messages.send') && <Link className="mt-3 inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-200 px-3 text-sm text-slate-800 focus-visible:outline focus-visible:outline-2" to={`/conversations?${client ? `client=${encodeURIComponent(client)}&chat=${encodeURIComponent(client)}&` : ''}template=${template.id}&businessId=${currentInstanceId}`}>{client ? 'Вставить в разговор' : 'Выбрать разговор'} <ArrowUpRight size={16} aria-hidden="true" /></Link>}
                        </li>)}</ul>}
                {shown.length > limit && <button type="button" className="min-h-[44px] rounded-xl border border-slate-200 px-4 text-sm" onClick={() => setLimit(value => value + 20)}>Показать ещё ({shown.length - limit})</button>}
            </section>

            <section aria-labelledby="create-title" className="h-fit rounded-3xl border border-slate-200/80 bg-white/90 p-5 shadow-[0_16px_48px_-32px_rgba(15,23,42,.34)] md:p-6">
                {!canManage ? <p className="text-sm leading-6 text-slate-600">Создавать и удалять шаблоны может владелец бизнеса. Менеджерам доступны сохранённые ответы.</p> : <>
                <div className="mb-5 flex items-start gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-[#6E56FF]"><Plus size={20} aria-hidden="true" /></span><div><h2 id="create-title" className="text-lg font-semibold text-slate-900">Новый шаблон</h2><p className="mt-1 text-sm text-slate-500">Добавьте название и текст сообщения.</p></div></div>
                <form onSubmit={submit} className="space-y-4">
                    <div><label htmlFor="quick-reply-label" className="mb-1.5 block text-sm font-medium text-slate-700">Название</label><input id="quick-reply-label" value={label} onChange={event => setLabel(event.target.value)} required maxLength={100} placeholder="Например, Приветствие" className="min-h-[48px] w-full rounded-xl border border-slate-200 bg-white px-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-violet-400 focus:ring-4 focus:ring-violet-100" /><p className="mt-1 text-right text-xs text-slate-400">{label.length}/100</p></div>
                    <div><label htmlFor="quick-reply-text" className="mb-1.5 block text-sm font-medium text-slate-700">Текст ответа</label><textarea id="quick-reply-text" value={text} onChange={event => setText(event.target.value)} required maxLength={5000} rows={7} placeholder="Здравствуйте! Чем можем помочь?" className="w-full resize-y rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm leading-6 text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-violet-400 focus:ring-4 focus:ring-violet-100" /><p className="mt-1 text-right text-xs text-slate-400">{text.length}/5000</p></div>
                    <button type="submit" disabled={saving || !label.trim() || !text.trim()} className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-[#6E56FF] px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-[#5B43E8] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600">{saving ? <><LoaderCircle size={17} className="animate-spin" aria-hidden="true" /> Сохраняем…</> : <>Сохранить шаблон <ArrowUpRight size={17} aria-hidden="true" /></>}</button>
                </form>
                </>}
            </section>
        </div>
    </main>;
}
