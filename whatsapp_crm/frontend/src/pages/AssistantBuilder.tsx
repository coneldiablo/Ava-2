import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Link2, Loader2, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useInstance } from '../context/InstanceContext';
import FadeContent from '../components/react-bits/FadeContent';
import VoiceSettings from '../components/VoiceSettings';
import AiModelSettings from '../components/AiModelSettings';
import TimeZoneSelect from '../components/TimeZoneSelect';
import './AssistantBuilder.css';

type Profile = { name: string; hotelTone: string; systemPrompt: string; voiceGreetingTemplate: string; outboundOpenerTemplate: string };
const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type WorkingHours = Record<typeof days[number], { enabled: boolean; start: string; end: string }>;
type SuggestedSettings = { hotelTone?: string; hotelTimezone?: string; hotelWorkingHours?: WorkingHours; voiceGreetingTemplate?: string; outboundOpenerTemplate?: string };
const settingLabels = { hotelTone: 'Тон общения', hotelTimezone: 'Часовой пояс', hotelWorkingHours: 'Рабочее время', voiceGreetingTemplate: 'Приветствие при входящем звонке', outboundOpenerTemplate: 'Начало исходящего звонка' };
function settingsFrom(value: unknown): SuggestedSettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const input = value as Record<string, unknown>;
    const result: SuggestedSettings = {};
    for (const key of ['hotelTone', 'hotelTimezone', 'voiceGreetingTemplate', 'outboundOpenerTemplate'] as const) {
        if (typeof input[key] === 'string' && input[key].length <= 8000) result[key] = input[key];
    }
    const hours = input.hotelWorkingHours as WorkingHours | undefined;
    if (hours && days.every(day => hours[day] && typeof hours[day].enabled === 'boolean' && /^\d{2}:\d{2}$/.test(hours[day].start) && /^\d{2}:\d{2}$/.test(hours[day].end))) result.hotelWorkingHours = hours;
    return result;
}
type RecoveredPrompt = { draftId: string; prompt: string };
type LocalEdits = { recovery?: RecoveredPrompt[]; links?: string; supplement?: string; prompt?: string; draftId?: string; step?: number; manual?: Partial<Profile>; suggestions?: SuggestedSettings; selected?: string[] };
function readEdits(key: string | null): LocalEdits {
    if (!key) return {};
    try {
        const value = JSON.parse(sessionStorage.getItem(key) || 'null');
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        const result: LocalEdits = {};
        for (const field of ['links', 'supplement', 'prompt', 'draftId'] as const) if (typeof value[field] === 'string' && value[field].length <= 16000) result[field] = value[field];
        if (value.step === 0 || value.step === 1) result.step = value.step;
        if (value.manual && typeof value.manual === 'object') result.manual = Object.fromEntries(fields.filter(field => typeof value.manual[field] === 'string' && value.manual[field].length <= 8000).map(field => [field, value.manual[field]]));
        result.recovery = Array.isArray(value.recovery) ? value.recovery.filter((item: unknown): item is RecoveredPrompt => {
            if (!item || typeof item !== 'object') return false;
            const entry = item as RecoveredPrompt;
            return typeof entry.draftId === 'string' && entry.draftId.length <= 16000 && typeof entry.prompt === 'string' && entry.prompt.length <= 8000;
        }) : [];
        result.suggestions = settingsFrom(value.suggestions);
        result.selected = Array.isArray(value.selected) ? value.selected.filter((field: unknown) => typeof field === 'string' && Object.prototype.hasOwnProperty.call(settingLabels, field)) : [];
        return result;
    } catch { return {}; }
}
type Draft = { id: string; status: 'draft' | 'approved'; links: string[]; supplement: string; systemPrompt: string; suggestedSettings?: SuggestedSettings; sources: { url: string; title: string; status: 'read' | 'unavailable' }[] };
const fields: (keyof Profile)[] = ['name', 'hotelTone', 'systemPrompt', 'voiceGreetingTemplate', 'outboundOpenerTemplate'];
function profileFrom(value: Record<string, unknown>): Profile { return Object.fromEntries(fields.map(key => [key, typeof value[key] === 'string' ? value[key] : ''])) as Profile; }
class PublicFailure extends Error {}
function validDraft(value: unknown): value is Draft {
    if (!value || typeof value !== 'object') return false;
    const d = value as Draft;
    return typeof d.id === 'string' && ['draft', 'approved'].includes(d.status) && typeof d.systemPrompt === 'string' && d.systemPrompt.length <= 8000 && typeof d.supplement === 'string' && Array.isArray(d.links) && d.links.every(x => typeof x === 'string') && Array.isArray(d.sources) && d.sources.every(x => typeof x.url === 'string' && typeof x.title === 'string' && ['read', 'unavailable'].includes(x.status));
}
export default function AssistantBuilder() {
    const { currentInstanceId } = useInstance();
    if (!currentInstanceId) return <section className="assistant-builder assistant-builder__empty card"><Sparkles aria-hidden="true" /><h1>Настройте ассистента</h1><p>Выберите бизнес, для которого AVA будет отвечать клиентам.</p><Link to="/instances" className="btn-primary">Мои бизнесы</Link></section>;
    return <AssistantDraftEditor businessId={currentInstanceId} />;
}
type EditorProps = { businessId: number; embedded?: boolean; showModelSettings?: boolean; onApprovalChange?: (approved: boolean) => void; onProfileSaved?: (profile: Record<string, unknown>, changedFields: string[]) => void; beforeSave?: () => boolean; onSaveSettled?: () => void };
export function AssistantDraftEditor(props: EditorProps) {
    const { userId, loginName, authenticated } = useAuth();
    const identity = authenticated ? userId || loginName : null;
    const storageKey = identity ? `ava:assistant-edits:v1:${encodeURIComponent(identity)}:${props.businessId}` : null;
    return <Builder key={`${identity || 'guest'}:${props.businessId}`} {...props} storageKey={storageKey} />;
}
function Builder({ businessId, embedded = false, showModelSettings = true, onApprovalChange, onProfileSaved, beforeSave, onSaveSettled, storageKey }: EditorProps & { storageKey: string | null }) {
    const auth = useAuth();
    const { memberships } = auth;
    const { refreshInstances } = useInstance();
    const owner = auth.authenticated === true && !auth.permissionsLoading && memberships.some(x => x.businessId === businessId && x.role === 'hotel_owner' && x.capabilities?.includes('business.manage'));
    const [profile, setProfile] = useState<Profile | null>(null);
    const [saved, setSaved] = useState<Profile | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const local = useRef<LocalEdits>(readEdits(storageKey));
    const [recovery, setRecovery] = useState<RecoveredPrompt[]>(local.current.recovery || []);
    function keepPrompt(draftId: string | undefined, text: string | undefined) {
        if (!draftId || !text?.trim()) return;
        setRecovery(previous => previous.some(item => item.draftId === draftId && item.prompt === text)
            ? previous : [...previous, { draftId, prompt: text }]);
    }
    const [links, setLinks] = useState(local.current.links || '');
    const [supplement, setSupplement] = useState(local.current.supplement || '');
    const [prompt, setPrompt] = useState(local.current.prompt || '');
    const [step, setStep] = useState(local.current.step || 0);
    const [suggestions, setSuggestions] = useState<SuggestedSettings>({});
    const [selected, setSelected] = useState<string[]>([]);
    const [descriptionOpen, setDescriptionOpen] = useState(Boolean(local.current.supplement));
    const [failedAction, setFailedAction] = useState<'generate' | 'approve' | 'manual' | 'write' | null>(null);
    const [busy, setBusy] = useState('load');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [reload, setReload] = useState(0);
    const alive = useRef(true);
    const pending = useRef(false);
    const controllers = useRef(new Set<AbortController>());
    const heading = useRef<HTMLHeadingElement>(null);
    const preparationRevision = useRef<number | null>(null);
    const [preparationError, setPreparationError] = useState('');
    const [savingSources, setSavingSources] = useState(false);
    async function request(path: string, body?: unknown, method = 'POST') {
        const controller = new AbortController(); controllers.current.add(controller);
        const timer = window.setTimeout(() => controller.abort(), path === '/assistant-draft' && body !== undefined ? 75000 : 30000);
        try {
            const response = await fetch(`/api/hotel-profiles/${businessId}${path}`, { credentials: 'same-origin', signal: controller.signal, method: body === undefined ? 'GET' : method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
            const data = await response.json();
            if (controller.signal.aborted) throw new Error('cancelled');
            if (!response.ok || !data.success) {
                const message = typeof data.message === 'string' && data.message.length <= 500 && /[А-Яа-яЁё]/.test(data.message) && !/[A-Z]{3,}_[A-Z_]+/.test(data.message) ? data.message : '';
                if (message) throw new PublicFailure(message);
                throw new Error('request_failed');
            }
            if (path && Number(data.businessId) !== businessId) throw new Error('wrong_business');
            return data;
        } finally { clearTimeout(timer); controllers.current.delete(controller); }
    }
    useEffect(() => {
        alive.current = true;
        let cancelled = false;
        pending.current = true;
        setBusy('load'); setError('');
        void (async () => {
            try {
                const [p, d] = await Promise.all([request(''), request('/assistant-draft')]);
                if (!p.profile || Number(p.profile.businessId) !== businessId || (d.draft !== null && !validDraft(d.draft))) throw new Error('invalid');
                if (cancelled || !alive.current) return;
                const initial = profileFrom(p.profile); setProfile({ ...initial, ...local.current.manual }); setSaved(initial);
                setDraft(d.draft);
                const sameDraft = d.draft && local.current.draftId === d.draft.id;
                if (!sameDraft && local.current.prompt !== d.draft?.systemPrompt) keepPrompt(local.current.draftId, local.current.prompt);
                if (d.draft) {
                    setLinks(local.current.links ?? d.draft.links.join('\n'));
                    setSupplement(local.current.supplement ?? d.draft.supplement);
                    setPrompt(sameDraft && local.current.prompt !== undefined ? local.current.prompt : d.draft.systemPrompt);
                    setStep(local.current.step ?? 1);
                    setSuggestions(sameDraft && local.current.suggestions ? local.current.suggestions : settingsFrom(d.draft.suggestedSettings));
                    setSelected(sameDraft ? local.current.selected || [] : []);
                } else { setStep(0); setPrompt(''); setSuggestions({}); setSelected([]); }
                setFailedAction(null);
            } catch (failure) { if (!cancelled && alive.current) setError(failure instanceof PublicFailure ? failure.message : 'Не удалось загрузить настройки. Проверьте соединение и повторите загрузку.'); }
            finally { if (!cancelled && alive.current) { pending.current = false; setBusy(''); } }
        })();
        const activeControllers = controllers.current;
        return () => { cancelled = true; alive.current = false; activeControllers.forEach(c => c.abort()); };
        // The keyed business component owns requests; a reload starts only after loading ends.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [businessId, reload]);
    useEffect(() => {
        // Do not persist blank loading state over edits restored on mount.
        if (!profile || busy === 'load') return;
        const manual = Object.fromEntries(fields.filter(key => profile[key] !== saved?.[key]).map(key => [key, profile[key]]));
        local.current = { links, supplement, prompt, draftId: draft?.id, step, manual, suggestions, selected, recovery };
        if (storageKey) { try { sessionStorage.setItem(storageKey, JSON.stringify(local.current)); } catch { /* A blocked/full session store must not block editing. */ } }
    }, [links, supplement, prompt, draft, step, profile, saved, suggestions, selected, recovery, busy, storageKey]);
    async function preparationRequest(signal: AbortSignal, body?: unknown) {
        const response = await fetch(`/api/businesses/${businessId}/onboarding/preparation`, { credentials: 'same-origin', signal, ...(body === undefined ? {} : { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
        if (!response.ok) throw new Error('sources_unavailable');
        return { data: await response.json() };
    }
    useEffect(() => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        preparationRequest(controller.signal).then(({ data }) => {
            if (controller.signal.aborted || data.success !== true || data.preparation?.businessId !== businessId || !Number.isSafeInteger(data.preparation.revision) || !Array.isArray(data.preparation.links)) return;
            preparationRevision.current = data.preparation.revision;
            if (local.current.links === undefined) setLinks(data.preparation.links.join('\n'));
            if (local.current.supplement === undefined) setSupplement(data.preparation.supplement || '');
        }).catch(() => { /* The local draft and generation remain available; explicit save can retry. */ });
        return () => { clearTimeout(timeout); controller.abort(); };
        // Business-scoped input is restored once; local edits always win.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [businessId]);
    async function saveSources() {
        if (!owner || busy || savingSources || pending.current) return;
        pending.current = true; setSavingSources(true); setPreparationError('');
        const request = new AbortController(); controllers.current.add(request);
        const timeout = setTimeout(() => request.abort(), 20000);
        try {
            if (preparationRevision.current === null) {
                const read = await preparationRequest(request.signal);
                if (read.data?.success !== true || read.data.preparation?.businessId !== businessId || !Number.isSafeInteger(read.data.preparation.revision)) throw new Error('invalid');
                preparationRevision.current = read.data.preparation.revision;
            }
            const inputLinks = [...new Set(links.split(/\n/).map(value => value.trim()).filter(Boolean))];
            const result = await preparationRequest(request.signal, { revision: preparationRevision.current, links: inputLinks, supplement });
            const readback = await preparationRequest(request.signal);
            const stored = readback.data?.preparation;
            if (result.data?.success !== true || readback.data?.success !== true || stored?.businessId !== businessId || !Number.isSafeInteger(stored.revision) || JSON.stringify(stored.links) !== JSON.stringify(inputLinks) || stored.supplement !== supplement) throw new Error('readback');
            preparationRevision.current = stored.revision;
            if (alive.current) setNotice('Ссылки и описание сохранены. Можно продолжить настройку позже.');
        } catch { if (alive.current) setPreparationError('Сохранение ссылок не подтверждено. Ваш ввод сохранён в этой вкладке. Если другой владелец изменил ссылки, откройте настройки заново и сравните их перед сохранением.'); }
        finally { clearTimeout(timeout); controllers.current.delete(request); if (alive.current) { pending.current = false; setSavingSources(false); } }
    }
    const currentApproval = Boolean(owner && !busy && !error && draft?.status === 'approved' && prompt.trim() && prompt.trim() === draft.systemPrompt.trim() && prompt.trim() === saved?.systemPrompt.trim() && profile?.systemPrompt.trim() === saved?.systemPrompt.trim());
    useEffect(() => { onApprovalChange?.(currentApproval); }, [currentApproval, onApprovalChange]);
    useEffect(() => () => onApprovalChange?.(false), [onApprovalChange]);
    function edit(action: () => void) { if (!owner || busy) return; action(); setError(''); setNotice(''); }
    async function run(kind: 'generate' | 'approve' | 'manual' | 'write') {
        if (!owner || pending.current || !profile) return;
        let parsed: string[] = [];
        if (kind === 'generate') {
            parsed = [...new Set(links.split(/\n/).map(x => x.trim()).filter(Boolean))];
            try { if (parsed.length > 12 || parsed.some(x => !['http:', 'https:'].includes(new URL(x).protocol)) || (!parsed.length && !supplement.trim())) throw new Error(); }
            catch { setError('Добавьте до 12 полных ссылок с https:// или опишите бизнес.'); document.getElementById('assistant-links')?.focus(); return; }
        }
        if (kind === 'approve' && draft?.status === 'approved') { setError('Этот черновик уже сохранён. Подготовьте новый или измените инструкции в ручных настройках.'); return; }
        if (kind === 'approve' && (!draft || !prompt.trim() || prompt.length > 8000)) { setError('Заполните инструкции: от 1 до 8000 символов.'); document.getElementById('assistant-draft')?.focus(); return; }
        if (kind === 'write' && (!profile.systemPrompt.trim() || profile.systemPrompt.length > 8000)) { setError('Напишите инструкции: от 1 до 8000 символов.'); return; }
        if (kind === 'manual' && (!profile.name.trim() || profile.systemPrompt.length > 8000)) { setError('Укажите название бизнеса и инструкции до 8000 символов.'); return; }
        const changesProfile = kind === 'approve' || kind === 'manual';
        if (changesProfile && beforeSave && !beforeSave()) { setError('Дождитесь сохранения настроек бизнеса и повторите.'); return; }
        pending.current = true; setBusy(kind); setError(''); setNotice(''); setFailedAction(null);
        try {
            if (kind === 'generate' || kind === 'write') {
                const data = kind === 'write' ? await request('/assistant-draft/manual', { systemPrompt: profile.systemPrompt.trim(), links: [], supplement }) : await request('/assistant-draft', { links: parsed, supplement });
                if (!validDraft(data.draft) || data.draft.status !== 'draft') throw new Error('invalid');
                if (!alive.current) return;
                if (prompt !== draft?.systemPrompt) keepPrompt(draft?.id, prompt);
                setDraft(data.draft); setPrompt(data.draft.systemPrompt); setSuggestions(settingsFrom(data.draft.suggestedSettings)); setSelected([]); setStep(1);
                requestAnimationFrame(() => heading.current?.focus());
            } else {
                const patch = Object.fromEntries(fields.filter(key => profile[key] !== saved?.[key]).map(key => [key, profile[key]]));
                const settings = Object.fromEntries(Object.entries(suggestions).filter(([key]) => selected.includes(key)));
                const data = kind === 'approve' ? await request('/assistant-draft/approve', { draftId: draft!.id, systemPrompt: prompt.trim(), ...(Object.keys(settings).length ? { settings } : {}) }) : await request('', patch, 'PUT');
                if (!data.profile || Number(data.profile.businessId) !== businessId || (kind === 'approve' && (!validDraft(data.draft) || data.draft.id !== draft!.id || data.draft.status !== 'approved' || data.profile.systemPrompt !== prompt.trim() || data.draft.systemPrompt !== prompt.trim()))) throw new Error('invalid');
                const readback = await request('');
                const expected = kind === 'approve' ? { systemPrompt: prompt.trim(), ...settings } : patch;
                if (!readback.profile || Number(readback.profile.businessId) !== businessId || Object.entries(expected).some(([key, value]) => typeof value === 'string'
                    ? String(readback.profile[key] ?? '').trim() !== value.trim()
                    : days.some(day => {
                        const actual = readback.profile[key]?.[day]; const desired = (value as WorkingHours)[day];
                        return !actual || actual.enabled !== desired.enabled || actual.start !== desired.start || actual.end !== desired.end;
                    }))) throw new Error('save_not_verified');
                data.profile = readback.profile;
                if (kind === 'approve' && Object.entries(settings).some(([key, value]) => typeof value === 'string' ? String(data.profile[key] ?? '').trim() !== value.trim() : days.some(day => {
                    const actual = data.profile[key]?.[day]; const expected = (value as WorkingHours)[day];
                    return !actual || actual.enabled !== expected.enabled || actual.start !== expected.start || actual.end !== expected.end;
                }))) throw new Error('save_not_verified');
                if (!alive.current) return;
                const stored = profileFrom(data.profile);
                // Approval sends only the prompt and selected suggestions; retain every unsent manual edit.
                setProfile(kind === 'approve' ? { ...stored, ...patch } : stored); setSaved(stored);
                if (kind === 'approve') { setDraft(data.draft); setPrompt(stored.systemPrompt); }
                onProfileSaved?.(data.profile, Object.keys(expected));
                setNotice(kind === 'approve' ? 'Сохранено. Ассистент использует эти инструкции.' : 'Ручные настройки сохранены.');
                try { await refreshInstances(); } catch { /* The business profile was already read back. */ }
            }
        } catch (failure) { if (alive.current) { setFailedAction(kind); if (kind === 'generate') setDescriptionOpen(true); setError(failure instanceof PublicFailure ? failure.message : kind === 'generate' ? 'Не удалось подготовить инструкции. Проверьте доступность ссылок, добавьте описание бизнеса и повторите.' : 'Сохранение не подтверждено. Ваш текст остался в форме. Повторите сохранение; если черновик изменился, повторите загрузку.'); } }
        finally { if (changesProfile) onSaveSettled?.(); if (alive.current) { pending.current = false; setBusy(''); } }
    }
    const dirty = profile && fields.some(key => profile[key] !== saved?.[key]);
    const approved = draft?.status === 'approved';
    const outdated = draft?.status === 'approved' && draft.systemPrompt.trim() !== saved?.systemPrompt.trim();
    return <section className={`assistant-builder${embedded ? ' assistant-builder--embedded' : ''}`} aria-label={embedded ? 'Инструкции ассистента бизнеса' : undefined} aria-labelledby={embedded ? undefined : 'assistant-builder-title'}>
        {!embedded && <FadeContent><header className="assistant-builder__hero"><div className="assistant-builder__hero-icon"><Sparkles aria-hidden="true" size={25} /></div><div><p className="assistant-builder__eyebrow">AVA / АССИСТЕНТ ВАШЕГО БИЗНЕСА</p><h1 id="assistant-builder-title">Ваш бизнес. Его голос.</h1><p>Добавьте страницы бизнеса — AVA подготовит инструкции для общения с клиентами. Проверьте текст перед сохранением.</p></div></header></FadeContent>}
        {showModelSettings && <AiModelSettings businessId={businessId} canEdit={owner} />}
        {!owner && <p className="assistant-builder__info">Изменять настройки может только владелец бизнеса.</p>}
        {busy && <p role="status" className="assistant-builder__loading"><Loader2 aria-hidden="true" className="assistant-builder__spin" size={18} />{busy === 'load' ? 'Загружаем настройки…' : busy === 'generate' ? 'Читаем страницы и готовим инструкции…' : 'Сохраняем и проверяем результат…'}</p>}
        {error && <div className="assistant-builder__error" role="alert"><p>{error}</p>{!busy && <div className="assistant-builder__retry">{failedAction && <button className="btn-secondary" onClick={() => void run(failedAction)}>Повторить попытку</button>}<button className="btn-secondary" onClick={() => setReload(x => x + 1)}>Повторить загрузку</button></div>}</div>}
        {recovery.length > 0 && <details className="assistant-builder__manual">
            <summary>Несохранённый текст ({recovery.length})</summary>
            <p className="assistant-builder__help">Черновик обновился. Ваш прежний текст сохранён отдельно. Сравните его с текущей инструкцией перед восстановлением.</p>
            <div className="assistant-builder__fields">{recovery.map((entry, index) => <div className="assistant-builder__field" key={`${entry.draftId}:${index}`}>
                <label htmlFor={`recovery-${index}`}>Сохранённая копия {index + 1}</label>
                <textarea id={`recovery-${index}`} readOnly value={entry.prompt} rows={5} />
                <button type="button" className="btn-secondary assistant-builder__action" disabled={!owner || Boolean(busy) || !draft || draft.status === 'approved'} onClick={() => edit(() => {
                    if (prompt !== draft?.systemPrompt) keepPrompt(draft?.id, prompt);
                    setPrompt(entry.prompt); setStep(1);
                })}>Восстановить текст {index + 1}</button>
            </div>)}</div>
        </details>}
        {profile && <><div className="assistant-builder__layout">{!embedded && <nav className="assistant-builder__steps" aria-label="Шаги настройки">{['Добавьте ссылки', 'Проверьте инструкции'].map((title, i) => <button key={title} className={`assistant-builder__step${step === i ? ' is-active' : ''}`} aria-current={step === i ? 'step' : undefined} disabled={Boolean(busy) || (i === 1 && !draft)} onClick={() => { setStep(i); requestAnimationFrame(() => heading.current?.focus()); }}><span className="assistant-builder__step-icon">{i === 0 ? <Link2 aria-hidden="true" size={18} /> : <Check aria-hidden="true" size={18} />}</span><span><small>ШАГ {i + 1} ИЗ 2</small><strong>{title}</strong></span></button>)}<p className="assistant-builder__aside-note">Вы решаете, какие инструкции будет использовать ассистент.</p></nav>}
        <div className="assistant-builder__panel" aria-busy={Boolean(busy)}><div className="assistant-builder__panel-head">{!embedded && <span>0{step + 1} / 02</span>}<h2 ref={heading} tabIndex={-1}>{step === 0 ? 'Добавьте ссылки' : 'Проверьте инструкции'}</h2><p>{step === 0 ? 'Сайт, соцсети или публичные страницы с услугами и описанием бизнеса.' : 'Уточните факты и правила ответа. Сохранение включит эти инструкции.'}</p></div>
        {embedded && approved && profile.systemPrompt.trim() !== saved?.systemPrompt.trim() && <div className="assistant-builder__info"><p>У вас есть несохранённый ручной текст. Вернитесь к ссылкам, чтобы проверить его, или продолжите с уже сохранёнными инструкциями.</p><button type="button" className="btn-secondary assistant-builder__action" disabled={Boolean(busy)} onClick={() => edit(() => { keepPrompt(draft?.id, profile.systemPrompt); setProfile(value => value ? { ...value, systemPrompt: saved?.systemPrompt || '' } : value); })}>Продолжить с сохранёнными инструкциями</button></div>}
        {approved && step === 1 && <p className="assistant-builder__info">Инструкции сохранены. Чтобы обновить их по страницам бизнеса, вернитесь к ссылкам и подготовьте новый черновик.</p>}
        {step === 0 ? <div className="assistant-builder__fields"><Field id="assistant-links" label="Ссылки на страницы бизнеса" value={links} disabled={!owner || Boolean(busy)} onChange={v => edit(() => setLinks(v))} hint="По одной полной ссылке на строку, до 12 страниц." rows={5} /><details className="assistant-builder__description" open={descriptionOpen} onToggle={e => setDescriptionOpen(e.currentTarget.open)}><summary>Добавить описание бизнеса</summary><Field id="assistant-supplement" label="Описание бизнеса (необязательно)" value={supplement} disabled={!owner || Boolean(busy)} onChange={v => edit(() => setSupplement(v))} hint="Добавьте то, чего нет на страницах: чем вы занимаетесь и как помогаете клиентам." rows={4} /></details><button type="button" className="btn-secondary assistant-builder__action" disabled={!owner || Boolean(busy) || savingSources} onClick={() => void saveSources()}>{savingSources ? 'Сохраняем ссылки…' : 'Сохранить ссылки и описание'}</button>{preparationError && <p className="assistant-builder__error" role="alert">{preparationError}</p>}<details className="assistant-builder__description"><summary>Написать инструкции самостоятельно</summary><p className="assistant-builder__help">Опишите, чем помогает бизнес, как общаться с клиентом и когда передавать разговор менеджеру. Можно продолжить без чтения ссылок и генерации.</p><Field id="assistant-manual-draft" label="Ваши инструкции ассистенту" value={profile.systemPrompt} disabled={!owner || Boolean(busy)} onChange={value => edit(() => setProfile(current => current ? { ...current, systemPrompt: value } : current))} rows={8} /><button className="btn-secondary assistant-builder__action" type="button" disabled={!owner || Boolean(busy) || !profile.systemPrompt.trim()} onClick={() => void run('write')}>Проверить ручные инструкции</button></details></div> : <div className="assistant-builder__fields">{draft && <div className="assistant-builder__tip"><div><p>Прочитано страниц: {draft.sources.filter(x => x.status === 'read').length} из {draft.sources.length}.{draft.supplement.trim() && ' Учтено ваше описание.'}</p>{draft.sources.length > 0 && <ul className="assistant-builder__sources">{draft.sources.map((s, i) => <li key={`${s.url}-${i}`}>{s.title || s.url} — {s.status === 'read' ? 'прочитано' : 'не удалось прочитать'}</li>)}</ul>}</div></div>}<Field id="assistant-draft" label="Инструкции ассистента" value={prompt} disabled={!owner || Boolean(busy) || approved} onChange={v => edit(() => setPrompt(v))} rows={12} /><span className="assistant-builder__help">{prompt.length} / 8000 символов</span>{Object.keys(suggestions).length > 0 && <SuggestedFields suggestions={suggestions} selected={selected} disabled={!owner || Boolean(busy) || approved} onSelect={key => edit(() => setSelected(values => values.includes(key) ? values.filter(value => value !== key) : [...values, key]))} onChange={value => edit(() => setSuggestions(value))} />}</div>}
        <div className="assistant-builder__footer">{step === 1 && <button className="btn-secondary assistant-builder__action" disabled={Boolean(busy)} onClick={() => setStep(0)}><ArrowLeft size={17} aria-hidden="true" />Назад</button>}{owner && <button className="btn-primary assistant-builder__action" disabled={Boolean(busy) || (step === 1 && (approved || outdated))} onClick={() => void run(step === 0 ? 'generate' : 'approve')}>{step === 0 ? 'Подготовить инструкции' : approved ? 'Сохранено' : 'Подтвердить и сохранить'}</button>}</div>{notice && <p role="status" className="assistant-builder__message">{notice}</p>}</div></div>
        {!embedded && <VoiceSettings businessId={businessId} />}
        {!embedded && <details className="assistant-builder__manual"><summary>Ручные настройки и звонки</summary><div className="assistant-builder__fields">{fields.map(key => <Field key={key} id={`manual-${key}`} label={{ name: 'Название бизнеса', hotelTone: 'Тон общения', systemPrompt: 'Текущие инструкции', voiceGreetingTemplate: 'Приветствие при входящем звонке', outboundOpenerTemplate: 'Начало исходящего звонка' }[key]} value={profile[key]} rows={key === 'systemPrompt' ? 8 : 3} disabled={!owner || Boolean(busy)} onChange={v => edit(() => setProfile(p => p ? { ...p, [key]: v } : p))} />)}{owner && <button className="btn-secondary assistant-builder__action" disabled={!dirty || Boolean(busy)} onClick={() => void run('manual')}>Сохранить ручные настройки</button>}</div></details>}</>}
    </section>;
}
function Field({ id, label, value, disabled, onChange, hint, rows }: { id: string; label: string; value: string; disabled: boolean; onChange: (value: string) => void; hint?: string; rows: number }) {
    return <div className="assistant-builder__field"><label htmlFor={id}>{label}</label>{hint && <p id={`${id}-help`}>{hint}</p>}<textarea id={id} value={value} rows={rows} maxLength={8000} disabled={disabled} aria-describedby={hint ? `${id}-help` : undefined} onChange={e => onChange(e.target.value)} /></div>;
}

function SuggestedFields({ suggestions, selected, disabled, onSelect, onChange }: { suggestions: SuggestedSettings; selected: string[]; disabled: boolean; onSelect: (key: string) => void; onChange: (value: SuggestedSettings) => void }) {
    const dayLabels = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
    return <fieldset className="assistant-builder__suggestions"><legend>Предложенные настройки</legend><p>Отметьте только те изменения, которые хотите сохранить. Остальные настройки останутся прежними.</p>{(Object.keys(suggestions) as (keyof SuggestedSettings)[]).map(key => <div className="assistant-builder__suggestion" key={key}>
        <label className="assistant-builder__opt-in"><input type="checkbox" disabled={disabled} checked={selected.includes(key)} onChange={() => onSelect(key)} />Применить: {settingLabels[key]}</label>
        {key === 'hotelWorkingHours' ? <div className="assistant-builder__hours">{days.map((day, index) => {
            const hours = suggestions.hotelWorkingHours![day];
            const change = (value: Partial<typeof hours>) => onChange({ ...suggestions, hotelWorkingHours: { ...suggestions.hotelWorkingHours!, [day]: { ...hours, ...value } } });
            return <div className="assistant-builder__day" key={day}><label><input type="checkbox" checked={hours.enabled} disabled={disabled} onChange={e => change({ enabled: e.target.checked })} />{dayLabels[index]}</label><label><span className="assistant-builder__sr-only">{dayLabels[index]}: начало</span><input type="time" value={hours.start} disabled={disabled || !hours.enabled} onChange={e => change({ start: e.target.value })} /></label><span aria-hidden="true">—</span><label><span className="assistant-builder__sr-only">{dayLabels[index]}: окончание</span><input type="time" value={hours.end} disabled={disabled || !hours.enabled} onChange={e => change({ end: e.target.value })} /></label></div>;
        })}</div> : key === 'hotelTimezone' ? <TimeZoneSelect id={`suggested-${key}`} label={`Предложение: ${settingLabels[key]}`} value={suggestions.hotelTimezone} disabled={disabled} onChange={value => onChange({ ...suggestions, hotelTimezone: value })} /> : <Field id={`suggested-${key}`} label={`Предложение: ${settingLabels[key]}`} value={suggestions[key] || ''} disabled={disabled} rows={2} onChange={value => onChange({ ...suggestions, [key]: value })} />}
    </div>)}</fieldset>;
}
