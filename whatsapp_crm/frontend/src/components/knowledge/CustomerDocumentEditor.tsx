import { useEffect, useId, useRef, useState } from 'react';
import { getCustomerKnowledgeChunks, updateCustomerKnowledgeChunk, type CustomerKnowledgeChunk } from '../../api';

export default function CustomerDocumentEditor({ businessId, documentId, name, onSaved, onClose }: {
    businessId: number; documentId: number; name: string; onSaved: () => void; onClose: () => void;
}) {
    const id = useId();
    const [chunks, setChunks] = useState<CustomerKnowledgeChunk[]>([]);
    const [selected, setSelected] = useState<number | null>(null);
    const [text, setText] = useState('');
    const [section, setSection] = useState('');
    const [hash, setHash] = useState<string>();
    const [conflict, setConflict] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const controller = useRef<AbortController | null>(null);
    const alive = useRef(true);
    const pending = useRef(false);
    const select = (chunk: CustomerKnowledgeChunk) => { setSelected(chunk.id); setText(chunk.text); setSection(chunk.section || ''); setNotice(''); };
    async function load(signal: AbortSignal) {
        setLoading(true); setError('');
        try {
            const data = await getCustomerKnowledgeChunks(businessId, documentId, signal);
            if (signal.aborted || !alive.current) return;
            setChunks(data.chunks); setHash(data.hash); setConflict(false);
            if (data.chunks.length) select(data.chunks[0]);
        } catch { if (!signal.aborted && alive.current) setError('Не удалось открыть текст. Повторите загрузку.'); }
        finally { if (!signal.aborted && alive.current) setLoading(false); }
    }
    function reload() { controller.current?.abort(); const next = new AbortController(); controller.current = next; void load(next.signal); }
    useEffect(() => { alive.current = true; reload(); return () => { alive.current = false; controller.current?.abort(); }; }, [businessId, documentId]);
    async function save(event: React.FormEvent) {
        event.preventDefault();
        if (pending.current || loading || conflict || selected === null || !text.trim()) return;
        pending.current = true; setBusy(true); setError(''); setNotice('');
        const next = new AbortController(); controller.current = next;
        try {
            await updateCustomerKnowledgeChunk(businessId, documentId, selected, { text: text.trim(), section: section.trim() || null, ...(hash ? { expectedHash: hash } : {}) }, next.signal);
            const readback = await getCustomerKnowledgeChunks(businessId, documentId, next.signal);
            if (next.signal.aborted || !alive.current) return;
            const saved = readback.chunks.find(chunk => chunk.id === selected);
            if (!saved || saved.text !== text.trim() || (saved.section || '') !== section.trim()) throw new Error();
            setChunks(readback.chunks); setHash(readback.hash); select(saved);
            setNotice('Текст сохранён. Готовность обновления для ответов показана в списке документов.'); onSaved();
        } catch (reason) {
            if (!next.signal.aborted && alive.current) {
                const code = (reason as { response?: { data?: { code?: string } } })?.response?.data?.code;
                setConflict(code === 'DOCUMENT_REVISION_CONFLICT');
                setError(code === 'DOCUMENT_REVISION_CONFLICT' ? 'Документ уже изменил другой сотрудник. Ваш вариант оставлен в форме. Скопируйте правки перед загрузкой текущего текста.' : 'Не удалось подтвердить сохранение. Ваш текст оставлен в форме. Проверьте соединение и сохраните снова.');
            }
        }
        finally { pending.current = false; if (alive.current && !next.signal.aborted) setBusy(false); }
    }
    return <section className="space-y-3 border-t border-neu-surface-2 pt-4" aria-label={`Текст документа ${name}`} aria-busy={loading || busy}>
        <h3 className="font-semibold">Изменить текст · {name}</h3>
        {loading && <p role="status">Открываем текст…</p>}
        {error && <p role="alert" className="text-red-700">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {!loading && !chunks.length && !error && <p>Текст пока не подготовлен. Дождитесь обработки документа и повторите загрузку.</p>}
        {!loading && chunks.length > 0 && <form onSubmit={event => void save(event)} className="space-y-3">
            <label className="label" htmlFor={`${id}-chunk`}>Часть документа</label><select id={`${id}-chunk`} className="input" value={selected ?? ''} disabled={busy} onChange={event => { const chunk = chunks.find(item => item.id === Number(event.target.value)); if (chunk) select(chunk); }}>{chunks.map((chunk, index) => <option key={chunk.id} value={chunk.id}>{index + 1} · {chunk.section || 'Без заголовка'}</option>)}</select>
            <label className="label" htmlFor={`${id}-section`}>Заголовок раздела</label><input id={`${id}-section`} className="input" maxLength={200} disabled={busy} value={section} onChange={event => setSection(event.target.value)}/>
            <label className="label" htmlFor={`${id}-text`}>Текст документа</label><textarea id={`${id}-text`} className="input" rows={7} required maxLength={10000} disabled={busy} value={text} onChange={event => setText(event.target.value)}/>
            <button className="btn-secondary min-h-[44px]" disabled={busy || conflict || !text.trim()}>{busy ? 'Сохраняем и проверяем…' : 'Сохранить текст'}</button>
        </form>}
        <div className="flex gap-3 flex-wrap"><button type="button" className="btn-secondary min-h-[44px]" disabled={loading || busy} onClick={reload}>Повторить загрузку текста</button><button type="button" className="btn-secondary min-h-[44px]" disabled={busy} onClick={onClose}>Закрыть редактор</button></div>
    </section>;
}
