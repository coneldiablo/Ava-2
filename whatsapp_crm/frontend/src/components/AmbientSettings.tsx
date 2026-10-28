import { useEffect, useId, useRef, useState } from 'react';
import { Check, Headphones, Play, Square } from 'lucide-react';
import { primePreviewAudio } from './previewAudio';
import './VoiceSettings.css';
type Setting = { enabled: boolean; preset: 'office'; volume: number };
type AmbientCatalog = { available: boolean; presets: { id: string; label: string }[]; effective: Setting; previewAvailable: boolean };
const same = (left: Setting, right: Setting) => left.enabled === right.enabled && left.preset === right.preset && left.volume === right.volume;
const valid = (value: unknown): value is Setting => Boolean(value && typeof value === 'object' && typeof (value as Setting).enabled === 'boolean' && (value as Setting).preset === 'office' && Number.isFinite((value as Setting).volume) && (value as Setting).volume >= 0 && (value as Setting).volume <= 1);
export default function AmbientSettings({ businessId, canRead, canEdit }: { businessId: number; canRead: boolean; canEdit: boolean }) {
    const id = useId();
    const [catalog, setCatalog] = useState<AmbientCatalog | null>(null), [selection, setSelection] = useState<Setting | null>(null), [saved, setSaved] = useState<Setting | null>(null);
    const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [playing, setPlaying] = useState(false), [revision, setRevision] = useState(0);
    const active = useRef(true), controllers = useRef(new Set<AbortController>()), pending = useRef(false), audio = useRef<HTMLAudioElement | null>(null), objectUrl = useRef(''), preview = useRef<AbortController | null>(null);
    const primedAudio = useRef<ReturnType<typeof primePreviewAudio>>(null);
    const currentEdit = useRef(canEdit); currentEdit.current = canEdit;
    function stop() { primedAudio.current?.stop(); primedAudio.current = null; preview.current?.abort(); preview.current = null; audio.current?.pause(); if (audio.current) audio.current.src = ''; audio.current = null; if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = ''; setPlaying(false); }
    async function request(path: string, controller: AbortController, body?: unknown) {
        controllers.current.add(controller); const timer = setTimeout(() => controller.abort(), 20000);
        try { const response = await fetch(`/api/hotel-profiles/${businessId}${path}`, { credentials: 'same-origin', signal: controller.signal, ...(body === undefined ? {} : { method: path ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }); if (!response.ok) throw new Error('unavailable'); return response; }
        finally { clearTimeout(timer); controllers.current.delete(controller); }
    }
    useEffect(() => { active.current = true; return () => { active.current = false; controllers.current.forEach(controller => controller.abort()); stop(); }; }, []);
    useEffect(() => {
        if (!canRead) return; let cancelled = false; const controller = new AbortController(); setLoading(true);
        void Promise.all([request('/voice-options', controller).then(response => response.json()), request('', controller).then(response => response.json())]).then(([options, profile]) => {
            if (cancelled) return;
            // Older providers may not expose background sound; their existing voice controls remain available.
            if (!options.ambientAudio) { setCatalog(null); return; }
            if (!valid(options.ambientAudio.effective) || profile.success !== true || Number(profile.profile?.businessId) !== businessId || (profile.profile.voiceAmbient !== null && profile.profile.voiceAmbient !== undefined && !valid(profile.profile.voiceAmbient))) throw new Error('invalid');
            const setting: Setting = profile.profile.voiceAmbient || options.ambientAudio.effective;
            setCatalog(options.ambientAudio); setSelection(setting); setSaved(setting); setError('');
        }).catch(() => { if (!cancelled) setError('Не удалось загрузить настройки фона. Повторите загрузку.'); }).finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; controller.abort(); };
        // The keyed parent owns the business and identity scope.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [businessId, canRead, revision]);
    const dirty = selection && saved && !same(selection, saved);
    function edit(patch: Partial<Setting>) { if (!canEdit || busy) return; stop(); setSelection(value => value ? { ...value, ...patch } : value); setError(''); setNotice(''); }
    async function save() {
        if (!selection || !dirty || !currentEdit.current || pending.current) return; pending.current = true; setBusy(true); setError(''); setNotice(''); stop(); const controller = new AbortController();
        try {
            await request('', controller, { voiceAmbient: selection });
            const data = await request('', controller).then(response => response.json());
            if (data.success !== true || Number(data.profile?.businessId) !== businessId || !valid(data.profile.voiceAmbient) || !same(data.profile.voiceAmbient, selection)) throw new Error('readback');
            if (active.current && currentEdit.current) { setSaved(data.profile.voiceAmbient); setNotice('Фон сохранён. Изменения применятся к следующим звонкам этого бизнеса.'); }
        } catch { if (active.current) setError('Сохранение фона не подтверждено. Настройки оставлены в форме — повторите сохранение.'); }
        finally { pending.current = false; if (active.current) setBusy(false); }
    }
    async function listen() {
        if (!selection || !canEdit || busy) return; if (audio.current || preview.current) { stop(); return; }
        const controller = new AbortController(); preview.current = controller; setPlaying(true); setError('');
        primedAudio.current = primePreviewAudio();
        try {
            const response = await request('/ambient-preview', controller, { preset: selection.preset, volume: selection.volume });
            if (!/^audio\//.test(response.headers.get('content-type') || '')) throw new Error('invalid_audio');
            const blob = await response.blob(); if (controller.signal.aborted || !active.current) return;
            if (!blob.size || blob.size > 1024 * 1024) throw Error('invalid_audio');
            if (primedAudio.current) { await primedAudio.current.play(blob, stop); return; }
            objectUrl.current = URL.createObjectURL(blob); const player = new Audio(objectUrl.current); audio.current = player; player.onended = stop; player.onerror = () => { stop(); setError('Не удалось прослушать фон. Попробуйте ещё раз.'); }; await player.play();
        } catch { if (active.current && !controller.signal.aborted) { stop(); setError('Не удалось прослушать фон. Попробуйте ещё раз.'); } }
    }
    if (!canRead || (!catalog && !error)) return null;
    return <section className="voice-settings" aria-labelledby={`${id}-title`} aria-busy={loading || busy}>
        <div className="voice-settings__header"><Headphones size={20} aria-hidden="true" /><div><h3 id={`${id}-title`}>Фон звонка</h3><p>Тихие звуки офиса под голосом ассистента и в паузах.</p></div></div>
        {loading ? <p role="status">Загружаем настройки фона…</p> : catalog && selection && <fieldset disabled={!canEdit || busy} className="space-y-4 min-w-0">
            <label className="flex min-h-11 items-center gap-3"><input type="checkbox" disabled={!catalog.available && !selection.enabled} checked={selection.enabled} onChange={event => edit({ enabled: event.target.checked })} className="h-5 w-5" />Добавить фон офиса</label>
            {!catalog.available && <p>Фон пока недоступен для этого подключения. Выбранные настройки сохранены.</p>}
            <div className="voice-settings__field"><label htmlFor={`${id}-volume`}>Громкость фона · {Math.round(selection.volume * 100)}%</label><input id={`${id}-volume`} type="range" min={0} max={1} step={0.05} value={selection.volume} disabled={!selection.enabled || !catalog.available} onChange={event => edit({ volume: Number(event.target.value) })} className="w-full min-h-11" aria-valuetext={`${Math.round(selection.volume * 100)} процентов`} /><div className="flex justify-between text-sm text-neu-muted"><span>Тише</span><span>Громче</span></div></div>
            <div className="voice-settings__footer">{catalog.previewAvailable && <button className="voice-settings__button" type="button" disabled={selection.volume === 0 || !catalog.available} onClick={() => void listen()}>{playing ? <Square size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}{playing ? 'Остановить фон' : 'Прослушать фон'}</button>}<button type="button" className="voice-settings__button voice-settings__button--primary" disabled={!dirty || (selection.enabled && !catalog.available)} onClick={() => void save()}><Check size={16} aria-hidden="true" />{busy ? 'Сохраняем…' : 'Сохранить фон'}</button></div>
        </fieldset>}
        {notice && <p role="status" className="voice-settings__state">{notice}</p>}{error && <div role="alert" className="voice-settings__error"><p>{error}</p><button className="voice-settings__button" type="button" disabled={busy || loading} onClick={() => setRevision(value => value + 1)}>Повторить загрузку фона</button></div>}
    </section>;
}
