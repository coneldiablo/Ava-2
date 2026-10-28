import { useEffect, useId, useRef, useState } from 'react';
import { Check } from 'lucide-react';

type Props = { businessId: number; canRead: boolean; canEdit: boolean };
type Policy = { enabled: boolean; revision: number };
function parse(data: unknown, businessId: number): Policy {
    const d = data as { success?: boolean; profile?: { businessId?: number; followupAutoSendEnabled?: boolean; followupAutoSendRevision?: number } };
    const p = d?.profile;
    if (d?.success !== true || Number(p?.businessId) !== businessId || typeof p?.followupAutoSendEnabled !== 'boolean'
        || !Number.isSafeInteger(p.followupAutoSendRevision) || Number(p.followupAutoSendRevision) < 0) throw Error('invalid_profile');
    return { enabled: p.followupAutoSendEnabled, revision: Number(p.followupAutoSendRevision) };
}
export default function PostCallMessageSettings(props: Props) {
    return <PostCallPanel key={`${props.businessId}:${props.canRead}:${props.canEdit}`} {...props} />;
}
function PostCallPanel({ businessId, canRead, canEdit }: Props) {
    const id = useId(), active = useRef(true), pending = useRef(false), savingRequest = useRef<AbortController | null>(null);
    const [saved, setSaved] = useState<Policy | null>(null), [enabled, setEnabled] = useState(false);
    const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
    const [error, setError] = useState(''), [stale, setStale] = useState(false), [notice, setNotice] = useState('');
    useEffect(() => { active.current = true; return () => { active.current = false; savingRequest.current?.abort(); }; }, []);
    useEffect(() => {
        if (!canRead) return;
        let live = true;
        const c = new AbortController(), timer = setTimeout(() => c.abort(), 15000);
        void fetch(`/api/hotel-profiles/${businessId}`, { credentials: 'same-origin', signal: c.signal }).then(async r => {
            if (!r.ok) throw Error('load');
            const policy = parse(await r.json(), businessId);
            if (live && !c.signal.aborted) { setSaved(policy); setEnabled(policy.enabled); setError(''); setStale(false); }
        }).catch(() => { if (live) setError('Не удалось загрузить настройки сообщения после звонка.'); })
            .finally(() => { clearTimeout(timer); if (live) setLoading(false); });
        return () => { live = false; c.abort(); clearTimeout(timer); };
    }, [businessId, canRead, reload]);
    function retry() { setLoading(true); setError(''); setNotice(''); setReload(v => v + 1); }
    async function save() {
        if (!canEdit || !saved || pending.current || stale) return;
        const choice = enabled, previous = saved.revision;
        pending.current = true; setBusy(true); setError(''); setNotice(''); setStale(false);
        const c = new AbortController(); savingRequest.current = c; const timer = setTimeout(() => c.abort(), 15000);
        try {
            const url = `/api/hotel-profiles/${businessId}`;
            const r = await fetch(url, { method: 'PUT', credentials: 'same-origin', signal: c.signal, headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ followupAutoSendEnabled: choice, expectedFollowupRevision: previous }) });
            if (!r.ok) throw Error(r.status === 409 ? 'changed' : 'save');
            const readback = await fetch(url, { credentials: 'same-origin', signal: c.signal });
            if (!readback.ok) throw Error('readback');
            const policy = parse(await readback.json(), businessId);
            if (policy.enabled !== choice || policy.revision <= previous) throw Error('readback');
            if (active.current && !c.signal.aborted) { setSaved(policy); setNotice('Сохранено. Изменение действует для новых звонков.'); }
        } catch (e) {
            if (active.current) {
                const changed = e instanceof Error && e.message === 'changed'; setStale(true);
                setError(changed ? 'Настройки уже изменились. Обновите их перед сохранением.' : 'Не удалось подтвердить сохранение. Обновите настройки, чтобы увидеть действующий режим.');
            }
        } finally { clearTimeout(timer); pending.current = false; if (savingRequest.current === c) savingRequest.current = null; if (active.current) setBusy(false); }
    }
    if (!canRead) return null;
    return <section className="voice-settings" aria-labelledby={`${id}-title`} aria-busy={loading || busy}>
        <header className="voice-settings__header"><div><h3 id={`${id}-title`}>После звонка</h3><p>Отправьте запрошенную информацию в удобный клиенту канал.</p></div></header>
        {loading && <p role="status" className="voice-settings__feedback">Загружаем настройки…</p>}
        {saved && !loading && <fieldset disabled={!canEdit || busy || stale} className="voice-waiting-fields">
            <label><input type="checkbox" checked={enabled} onChange={e => { setEnabled(e.target.checked); setNotice(''); }} /> Отправлять запрошенные сообщения автоматически</label>
            <p>{enabled ? 'AVA отправит информацию в канал, который попросил клиент: WhatsApp, Telegram или другой связанный контакт. Если канал недоступен или нужна проверка, задачу получит менеджер.' : 'AVA подготовит сообщение, а менеджер проверит и отправит его из задачи.'}</p>
            {canEdit && <button type="button" className="voice-settings__button voice-settings__button--primary" disabled={enabled === saved.enabled} onClick={() => void save()}><Check size={16} aria-hidden="true" />{busy ? 'Сохраняем…' : 'Сохранить'}</button>}
        </fieldset>}
        {notice && <p role="status" className="voice-settings__state">{notice}</p>}
        {error && <p role="alert" className="voice-settings__error">{error}</p>}
        {error && (!saved || stale) && <button type="button" className="voice-settings__button" disabled={busy || loading} onClick={retry}>Обновить настройки сообщения</button>}
    </section>;
}
