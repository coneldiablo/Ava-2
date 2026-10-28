import { useEffect, useId, useRef, useState } from 'react';
import { Check } from 'lucide-react';
type Waiting = { enabled: boolean; phrases: string[]; afterSeconds: number; repeatSeconds: number; maxMessages: number };
const defaults: Waiting = { enabled: true, phrases: ['Секунду, пожалуйста.'], afterSeconds: 3, repeatSeconds: 15, maxMessages: 1 };
const same = (a: Waiting, b: Waiting) => JSON.stringify(a) === JSON.stringify(b);

type Props = { businessId: number; canRead: boolean; canEdit: boolean; revision: number };
export default function VoiceWaitingSettings(props: Props) {
    return <VoiceWaitingPanel key={`${props.businessId}:${props.canRead}:${props.canEdit}:${props.revision}`} {...props} />;
}
function VoiceWaitingPanel({ businessId, canRead, canEdit, revision }: Props) {
    const id = useId(), active = useRef(true), editAllowed = useRef(canEdit); editAllowed.current = canEdit;
    const [provider, setProvider] = useState(''), [draft, setDraft] = useState<Waiting>(defaults), [saved, setSaved] = useState<Waiting>(defaults);
    const [text, setText] = useState(defaults.phrases.join('\n')), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [loadAttempt, setLoadAttempt] = useState(0);
    const pending = useRef(false), requests = useRef(new Set<AbortController>());
    useEffect(() => { active.current = true; return () => { active.current = false; requests.current.forEach(c => c.abort()); }; }, []);
    useEffect(() => {
        if (!canRead) return;
        const c = new AbortController(); requests.current.add(c); const timer = setTimeout(() => c.abort(), 15000);
        void fetch(`/api/hotel-profiles/${businessId}`, { credentials: 'same-origin', signal: c.signal }).then(async r => {
            if (!r.ok) throw Error('load'); const data = await r.json();
            if (data.success !== true || Number(data.profile?.businessId) !== businessId) throw Error('scope');
            if (c.signal.aborted || !active.current) return;
            const value: Waiting = data.profile.voiceWaiting || defaults;
            setProvider(data.profile.voiceAiProvider); setDraft(value); setSaved(value); setText(value.phrases.join('\n')); setError('');
        }).catch(() => { if (active.current) setError('Не удалось загрузить фразы ожидания.'); })
          .finally(() => { clearTimeout(timer); requests.current.delete(c); });
        return () => { c.abort(); clearTimeout(timer); requests.current.delete(c); };
    }, [businessId, canRead, revision, loadAttempt]);
    const phrases = text.split('\n').map(p => p.trim()).filter(Boolean);
    const phraseValid = phrases.length > 0 && phrases.length <= 5 && phrases.every(p => p.length <= 160);
    const value = draft.enabled ? { ...draft, phrases } : { ...saved, enabled: false, phrases: phraseValid ? phrases : saved.phrases };
    const valid = !draft.enabled || phraseValid
        && draft.afterSeconds >= 1 && draft.afterSeconds <= 15 && draft.repeatSeconds >= 5 && draft.repeatSeconds <= 60;
    async function save() {
        if (!canEdit || !valid || pending.current) return;
        pending.current = true; setBusy(true); setError(''); setNotice('');
        const c = new AbortController(); requests.current.add(c); const timer = setTimeout(() => c.abort(), 15000);
        try {
            const url = `/api/hotel-profiles/${businessId}`;
            const response = await fetch(url, { method: 'PUT', credentials: 'same-origin', signal: c.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voiceWaiting: value, expectedVoiceProvider: provider }) });
            if (!response.ok) throw Error(response.status === 409 ? 'changed' : 'save');
            const readback = await fetch(url, { credentials: 'same-origin', signal: c.signal }); if (!readback.ok) throw Error('readback');
            const data = await readback.json();
            if (data.success !== true || Number(data.profile?.businessId) !== businessId || data.profile.voiceAiProvider !== provider || !same(data.profile.voiceWaiting, value)) throw Error('readback');
            if (active.current && editAllowed.current) { setSaved(value); setNotice('Сохранено для следующих звонков.'); }
        } catch (e) { if (active.current) setError(e instanceof Error && e.message === 'changed' ? 'Режим голоса изменился. Обновите настройки перед сохранением. Ваш текст остался в форме.' : 'Сохранение не подтверждено. Ваш текст остался в форме — попробуйте ещё раз.'); }
        finally { clearTimeout(timer); requests.current.delete(c); pending.current = false; if (active.current) setBusy(false); }
    }
    if (!canRead || (provider && provider !== 'neuro_gemini')) return null;
    return <section className="voice-settings" aria-labelledby={`${id}-title`} aria-busy={busy}>
        <header className="voice-settings__header"><div><h3 id={`${id}-title`}>Когда AVA готовит ответ</h3><p>Настройте короткую фразу или оставьте ожидание без слов.</p></div></header>
        {provider && <fieldset disabled={!canEdit || busy} className="voice-waiting-fields">
            <label><input type="checkbox" checked={draft.enabled} onChange={e => { setDraft({ ...draft, enabled: e.target.checked }); setNotice(''); }} /> Произносить фразу ожидания</label>
            {draft.enabled && <>
                <div className="voice-settings__field"><label htmlFor={`${id}-phrases`}>Что говорить</label><textarea id={`${id}-phrases`} rows={2} value={text} onChange={e => { setText(e.target.value); setNotice(''); }} aria-describedby={`${id}-hint`} maxLength={804} /><p id={`${id}-hint`}>До пяти фраз, каждая с новой строки.</p></div>
                <details><summary>Когда и сколько раз</summary><div className="voice-settings__grid">
                    <label className="voice-settings__field">После паузы, секунд<input type="number" min={1} max={15} value={draft.afterSeconds} onChange={e => setDraft({ ...draft, afterSeconds: Number(e.target.value) })} /></label>
                    <label className="voice-settings__field">Повторять за один ответ<select value={draft.maxMessages} onChange={e => setDraft({ ...draft, maxMessages: Number(e.target.value) })}><option value={1}>Один раз</option><option value={2}>До двух раз</option></select></label>
                    {draft.maxMessages === 2 && <label className="voice-settings__field">Пауза до повтора, секунд<input type="number" min={5} max={60} value={draft.repeatSeconds} onChange={e => setDraft({ ...draft, repeatSeconds: Number(e.target.value) })} /></label>}
                </div></details>
                {!valid && <p role="alert" className="voice-settings__error">Добавьте от одной до пяти фраз, до 160 символов каждая. Пауза — от 1 до 15 секунд.</p>}
            </>}
            <button type="button" className="voice-settings__button voice-settings__button--primary" disabled={!valid || same(value, saved)} onClick={() => void save()}><Check size={16} aria-hidden="true" />{busy ? 'Сохраняем…' : 'Сохранить'}</button>
        </fieldset>}
        {notice && <p role="status" className="voice-settings__state">{notice}</p>}{error && <p role="alert" className="voice-settings__error">{error}</p>}
        {!provider && error && <button type="button" className="voice-settings__button" onClick={() => { setError(''); setLoadAttempt(n => n + 1); }}>Повторить загрузку</button>}
    </section>;
}
