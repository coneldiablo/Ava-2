import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Headphones, Loader2, Play, RotateCcw, Square } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import FadeContent from './react-bits/FadeContent';
import './VoiceSettings.css';
import AmbientSettings from './AmbientSettings';
import VoiceWaitingSettings from './VoiceWaitingSettings';
import PostCallMessageSettings from './PostCallMessageSettings';
import { primePreviewAudio } from './previewAudio';

type Choice = { id: string; label: string; language?: string };
type Provider = { id: string; label: string; available: boolean; models: Choice[]; voices: Choice[]; defaultModel?: string; defaultVoiceName?: string; capabilities?: { voicePreview?: boolean } };
type Catalog = { providers: Provider[]; defaultProvider: string };
type Selection = { provider: string; model: string; voiceName: string };
type VoiceProfile = { selection: Selection; settings: Record<string, { model: string; voiceName: string }> };
const sameSelection = (a: Selection, b: Selection) => a.provider === b.provider && a.model === b.model && a.voiceName === b.voiceName;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const string = (value: unknown) => typeof value === 'string' ? value : '';

function voiceProfile(data: unknown, businessId: number): VoiceProfile {
    if (!record(data) || data.success !== true || !record(data.profile) || Number(data.profile.businessId) !== businessId) throw new Error('invalid_profile');
    const p = data.profile;
    const settings: VoiceProfile['settings'] = {};
    if (record(p.voiceSettings)) for (const [key, value] of Object.entries(p.voiceSettings)) {
        if (record(value)) settings[key] = { model: string(value.model), voiceName: string(value.voiceName) };
    }
    return { selection: { provider: string(p.voiceAiProvider), model: string(p.voiceModel), voiceName: string(p.voiceName) }, settings };
}
function voiceCatalog(data: unknown, businessId: number): Catalog {
    const choices = (value: unknown): value is Choice[] => Array.isArray(value) && value.every(item => record(item) && typeof item.id === 'string' && Boolean(item.id.trim()) && typeof item.label === 'string' && Boolean(item.label.trim()) && (item.language === undefined || typeof item.language === 'string'));
    if (!record(data) || data.success === false || (data.businessId !== undefined && Number(data.businessId) !== businessId) || typeof data.defaultProvider !== 'string' || !Array.isArray(data.providers)
        || !data.providers.every(p => record(p) && typeof p.id === 'string' && Boolean(p.id.trim()) && typeof p.label === 'string' && Boolean(p.label.trim()) && typeof p.available === 'boolean' && choices(p.models) && choices(p.voices)
            && (p.defaultModel === undefined || typeof p.defaultModel === 'string') && (p.defaultVoiceName === undefined || typeof p.defaultVoiceName === 'string'))) throw new Error('invalid_catalog');
    return data as Catalog;
}

// Remount on account/grant changes as well as business changes. No old request or
// unsaved selection can cross the identity boundary, even for the same business.
export default function VoiceSettings({ businessId }: { businessId: number }) {
    const auth = useAuth();
    const [revision, setRevision] = useState(0);
    const member = auth.memberships.find(item => item.businessId === businessId);
    const canRead = auth.authenticated === true && member?.capabilities?.includes('business.read') === true;
    const canEdit = canRead && member?.role === 'hotel_owner' && member.capabilities?.includes('business.manage') === true;
    const identity = auth.authenticated ? auth.userId || auth.loginName || 'session' : 'guest';
    return <div key={`${identity}:${businessId}:${canRead}:${canEdit}`}><VoicePanel businessId={businessId} canRead={canRead} owner={canEdit} checking={Boolean(auth.permissionsLoading)} onSaved={() => setRevision(v => v + 1)} /><VoiceWaitingSettings businessId={businessId} canRead={canRead} canEdit={canEdit && !auth.permissionsLoading} revision={revision} /><PostCallMessageSettings businessId={businessId} canRead={canRead} canEdit={canEdit && !auth.permissionsLoading} /><AmbientSettings businessId={businessId} canRead={canRead} canEdit={canEdit && !auth.permissionsLoading} /></div>;
}

function VoicePanel({ businessId, canRead, owner, checking, onSaved }: { businessId: number; canRead: boolean; owner: boolean; checking: boolean; onSaved: () => void }) {
    const canEdit = owner && !checking;
    const id = useId();
    const [profile, setProfile] = useState<VoiceProfile | null>(null);
    const [selection, setSelection] = useState<Selection | null>(null);
    const [catalog, setCatalog] = useState<Catalog | null>(null);
    const [loading, setLoading] = useState(canRead);
    const [catalogLoading, setCatalogLoading] = useState(canRead);
    const [loadError, setLoadError] = useState('');
    const [catalogError, setCatalogError] = useState('');
    const [saveError, setSaveError] = useState('');
    const [unconfirmed, setUnconfirmed] = useState(false);
    const [previewError, setPreviewError] = useState('');
    const [notice, setNotice] = useState('');
    const [saving, setSaving] = useState(false);
    const [audioState, setAudioState] = useState<'idle' | 'loading' | 'playing'>('idle');
    const drafts = useRef<Record<string, Selection>>({});
    const epoch = useRef(0);
    const controllers = useRef(new Set<AbortController>());
    const savePending = useRef(false);
    const previewController = useRef<AbortController | null>(null);
    const previewSequence = useRef(0);
    const audio = useRef<HTMLAudioElement | null>(null);
    const primedAudio = useRef<ReturnType<typeof primePreviewAudio>>(null);
    const audioUrl = useRef('');
    const audioTimer = useRef<ReturnType<typeof setTimeout>>();

    const request = useCallback(async <T,>(path: string, init: RequestInit, parse: (r: Response) => Promise<T>, controller = new AbortController()): Promise<T> => {
        controllers.current.add(controller);
        const timer = setTimeout(() => controller.abort(), path === '/voice-preview' ? 25000 : 30000);
        try {
            const response = await fetch(`/api/hotel-profiles/${businessId}${path}`, { ...init, credentials: 'same-origin', signal: controller.signal });
            if (!response.ok || controller.signal.aborted) throw new Error('request_failed');
            const value = await parse(response);
            if (controller.signal.aborted) throw new Error('cancelled');
            return value;
        } finally { clearTimeout(timer); controllers.current.delete(controller); }
    }, [businessId]);
    const stopPreview = useCallback(() => {
        primedAudio.current?.stop(); primedAudio.current = null;
        ++previewSequence.current;
        previewController.current?.abort(); previewController.current = null;
        clearTimeout(audioTimer.current);
        if (audio.current) {
            audio.current.onended = null; audio.current.onerror = null;
            audio.current.pause(); audio.current.removeAttribute('src'); audio.current.load(); audio.current = null;
        }
        if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
        audioUrl.current = '';
        setAudioState('idle');
    }, []);
    const loadProfile = useCallback(async () => {
        if (!canRead) return;
        const generation = epoch.current;
        setLoading(true); setLoadError('');
        try {
            const data = voiceProfile(await request('', {}, r => r.json()), businessId);
            if (generation !== epoch.current) return;
            setProfile(data); setSelection(data.selection); drafts.current = {};
        } catch { if (generation === epoch.current) setLoadError('Не удалось загрузить голос. Повторите загрузку.'); }
        finally { if (generation === epoch.current) setLoading(false); }
    }, [businessId, canRead, request]);
    const loadCatalog = useCallback(async () => {
        if (!canRead) return;
        const generation = epoch.current;
        stopPreview(); setPreviewError('');
        setCatalogLoading(true); setCatalogError('');
        try {
            const data = voiceCatalog(await request('/voice-options', {}, r => r.json()), businessId);
            if (generation === epoch.current) setCatalog(data);
        } catch { if (generation === epoch.current) setCatalogError('Каталог голосов недоступен. Ваш выбор сохранён в форме. Повторите загрузку.'); }
        finally { if (generation === epoch.current) setCatalogLoading(false); }
    }, [businessId, canRead, request, stopPreview]);
    useEffect(() => {
        ++epoch.current;
        void loadProfile(); void loadCatalog();
        const active = controllers.current;
        return () => { ++epoch.current; active.forEach(controller => controller.abort()); stopPreview(); };
    }, [loadProfile, loadCatalog, stopPreview]);
    useEffect(() => { if (!canEdit) stopPreview(); }, [canEdit, stopPreview]);

    const providerId = selection?.provider || catalog?.defaultProvider || '';
    const provider = catalog?.providers.find(item => item.id === providerId);
    const previewVoice = selection?.voiceName || provider?.defaultVoiceName || '';
    const dirty = Boolean(selection && profile && (!sameSelection(selection, profile.selection) || unconfirmed));
    const editable = canEdit && !loading && !saving;
    const selectable = editable && !catalogLoading && Boolean(catalog) && !catalogError;
    function edit(next: Selection) {
        if (!editable) return;
        stopPreview(); setPreviewError(''); setSaveError(''); setNotice('');
        drafts.current[next.provider] = next; setSelection(next);
    }
    function selectProvider(value: string) {
        if (!selection || !selectable) return;
        const nextProvider = catalog?.providers.find(item => item.id === (value || catalog.defaultProvider));
        if (!nextProvider?.available) return;
        drafts.current[selection.provider] = selection;
        const saved = profile?.settings[nextProvider.id];
        edit(drafts.current[value] || { provider: value, model: saved?.model ?? nextProvider.defaultModel ?? '', voiceName: saved?.voiceName ?? nextProvider.defaultVoiceName ?? '' });
    }
    async function preview() {
        if (audioState !== 'idle') { stopPreview(); return; }
        if (!canEdit || !selection || !provider?.available || provider.capabilities?.voicePreview === false || !provider.voices.some(voice => voice.id === previewVoice) || saving) return;
        stopPreview(); setPreviewError(''); setAudioState('loading');
        primedAudio.current = primePreviewAudio();
        const sequence = previewSequence.current;
        const generation = epoch.current;
        const controller = new AbortController(); previewController.current = controller;
        try {
            const blob = await request('/voice-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: providerId, voiceName: previewVoice }) }, async response => {
                if (!/^audio\//i.test(response.headers.get('Content-Type') || '')) throw new Error('invalid_audio');
                const value = await response.blob();
                if (!value.size || value.size > 8 * 1024 * 1024) throw new Error('invalid_audio');
                return value;
            }, controller);
            if (sequence !== previewSequence.current || generation !== epoch.current) return;
            if (primedAudio.current) {
                audioTimer.current = setTimeout(() => { if (sequence === previewSequence.current) stopPreview(); }, 30000);
                await primedAudio.current.play(blob, () => { if (sequence === previewSequence.current) stopPreview(); });
                if (sequence === previewSequence.current && generation === epoch.current) setAudioState('playing');
                return;
            }
            audioUrl.current = URL.createObjectURL(blob);
            const player = new Audio(audioUrl.current); audio.current = player;
            player.onended = () => { if (sequence === previewSequence.current) stopPreview(); };
            player.onerror = () => { if (sequence === previewSequence.current) { stopPreview(); setPreviewError('Не удалось прослушать голос. Повторите попытку.'); } };
            // Also bound a browser that never resolves/rejects play().
            audioTimer.current = setTimeout(() => { if (sequence === previewSequence.current) { stopPreview(); setPreviewError('Не удалось завершить прослушивание. Повторите попытку.'); } }, 30000);
            await player.play();
            if (sequence === previewSequence.current && generation === epoch.current) setAudioState('playing');
        } catch {
            if (sequence === previewSequence.current && generation === epoch.current) { stopPreview(); setPreviewError('Не удалось прослушать голос. Повторите попытку или выберите другой голос.'); }
        }
    }
    async function save() {
        if (!selection || !profile || !canEdit || !dirty || savePending.current || !provider?.available || catalogError || catalogLoading) return;
        const generation = epoch.current;
        const patch: Record<string, string> = { voiceAiProvider: selection.provider };
        // Values come only from this provider. Preserve legacy values by omitting
        // them; the server restores its own saved provider entry on a switch.
        if (unconfirmed || selection.model !== profile.selection.model || selection.provider !== profile.selection.provider) {
            if (!selection.model || provider.models.some(item => item.id === selection.model)) patch.voiceModel = selection.model;
        }
        if (unconfirmed || selection.voiceName !== profile.selection.voiceName || selection.provider !== profile.selection.provider) {
            if (!selection.voiceName || provider.voices.some(item => item.id === selection.voiceName)) patch.voiceName = selection.voiceName;
        }
        savePending.current = true; setSaving(true); setSaveError(''); setNotice(''); stopPreview();
        try {
            const stored = voiceProfile(await request('', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }, r => r.json()), businessId);
            const readback = voiceProfile(await request('', {}, r => r.json()), businessId);
            if (generation !== epoch.current) return;
            const expectedModel = patch.voiceModel === '' ? provider.defaultModel : patch.voiceModel;
            const expectedVoice = patch.voiceName === '' ? provider.defaultVoiceName : patch.voiceName;
            if (!sameSelection(stored.selection, readback.selection)
                || readback.selection.provider !== providerId
                || (expectedModel !== undefined && readback.selection.model !== expectedModel)
                || (expectedVoice !== undefined && readback.selection.voiceName !== expectedVoice)) throw new Error('save_not_verified');
            setProfile(readback); setSelection(readback.selection); drafts.current = {}; setUnconfirmed(false);
            setNotice('Голос сохранён и проверен.');
            onSaved();
        } catch { if (generation === epoch.current) { setUnconfirmed(true); setSaveError('Сохранение не подтверждено. Ваш выбор остался в форме. Повторите сохранение.'); } }
        finally { savePending.current = false; if (generation === epoch.current) setSaving(false); }
    }
    const summaryProvider = catalog?.providers.find(item => item.id === (profile?.selection.provider || catalog.defaultProvider));
    const summaryModel = summaryProvider?.models.find(item => item.id === profile?.selection.model)?.label;
    const summaryVoice = summaryProvider?.voices.find(item => item.id === profile?.selection.voiceName)?.label;
    return <section id="business-voice" className="voice-settings" aria-labelledby={`${id}-title`} aria-busy={loading || saving}>
        <FadeContent duration={240}><header className="voice-settings__header"><span className="voice-settings__icon"><Headphones size={22} aria-hidden="true" /></span><div><p className="voice-settings__eyebrow">ОБЩЕНИЕ ПО ТЕЛЕФОНУ</p><h2 id={`${id}-title`}>Голос вашего ассистента</h2><p>Выберите, как AVA будет звучать в звонках с клиентами.</p></div></header></FadeContent>
        {!canRead ? <p className="voice-settings__hint">Настройки голоса доступны участникам этого бизнеса после проверки доступа.</p> : <>
            {checking ? <p role="status" className="voice-settings__hint">Проверяем доступ. Ваш выбор остаётся в форме.</p> : !canEdit && <p className="voice-settings__hint">Вы можете просматривать настройки. Менять голос и слушать пример может владелец бизнеса.</p>}
            {loading && <p role="status" className="voice-settings__feedback">Загружаем голос…</p>}
            {loadError && <div role="alert" className="voice-settings__error"><p>{loadError}</p><button type="button" className="voice-settings__button" onClick={() => void loadProfile()}>Повторить загрузку голоса</button></div>}
            {selection && <>
                <div className="voice-settings__grid">
                    <div className="voice-settings__field"><label htmlFor={`${id}-provider`}>Режим голоса</label><select id={`${id}-provider`} value={selection.provider} disabled={!selectable} onChange={event => selectProvider(event.target.value)}>
                        <option value="">По умолчанию{catalog?.defaultProvider ? ` · ${catalog.providers.find(p => p.id === catalog.defaultProvider)?.label || 'платформа'}` : ''}</option>
                        {selection.provider && !catalog?.providers.some(item => item.id === selection.provider) && <option value={selection.provider}>Сохранённый режим</option>}
                        {catalog?.providers.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.label}{!item.available ? ' · недоступен' : ''}</option>)}
                    </select></div>
                    <div className="voice-settings__field"><label htmlFor={`${id}-model`}>Модель для звонков</label><select id={`${id}-model`} value={selection.model} disabled={!selectable || !provider?.available || !provider.models.length} aria-describedby={`${id}-model-hint`} onChange={event => edit({ ...selection, model: event.target.value })}>
                        <option value="">По умолчанию</option>
                        {selection.model && !provider?.models.some(item => item.id === selection.model) && <option value={selection.model}>Сохранённая модель</option>}
                        {provider?.models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select><p id={`${id}-model-hint`}>Модель AI для переписки настраивается отдельно.</p></div>
                    <div className="voice-settings__field"><label htmlFor={`${id}-voice`}>Голос</label><select id={`${id}-voice`} value={selection.voiceName} disabled={!selectable || !provider?.available || !provider.voices.length} onChange={event => edit({ ...selection, voiceName: event.target.value })}>
                        <option value="">По умолчанию</option>
                        {selection.voiceName && !provider?.voices.some(item => item.id === selection.voiceName) && <option value={selection.voiceName}>Сохранённый голос</option>}
                        {provider?.voices.map(item => <option key={item.id} value={item.id}>{item.label}{item.language ? ` · ${item.language}` : ''}</option>)}
                    </select></div>
                    {provider?.capabilities?.voicePreview !== false && <div className="voice-settings__preview"><button type="button" className="voice-settings__button" disabled={!canEdit || saving || (audioState === 'idle' && (!selectable || !provider?.available || !provider.voices.some(item => item.id === previewVoice)))} onClick={() => void preview()}>
                        {audioState === 'loading' ? <Loader2 size={17} aria-hidden="true" className="voice-settings__spin" /> : audioState === 'playing' ? <Square size={15} aria-hidden="true" /> : <Play size={17} aria-hidden="true" />}{audioState === 'idle' ? 'Прослушать голос' : audioState === 'loading' ? 'Отменить прослушивание' : 'Остановить'}
                    </button><p>Короткий пример выбранного голоса.</p></div>}
                </div>
                {catalogLoading && <p role="status" className="voice-settings__feedback">Загружаем каталог голосов…</p>}
                {catalogError && <div role="alert" className="voice-settings__error"><p>{catalogError}</p><button type="button" className="voice-settings__button" onClick={() => void loadCatalog()}><RotateCcw size={16} aria-hidden="true" />Повторить загрузку каталога</button></div>}
                {!catalogLoading && !catalogError && (!provider?.available || !provider.voices.length) && <div className="voice-settings__feedback"><p>Этот режим или его голоса временно недоступны. Текущие настройки сохранены; выберите другой режим или повторите загрузку каталога.</p><button type="button" className="voice-settings__button" onClick={() => void loadCatalog()}>Обновить каталог голосов</button></div>}
                {previewError && <p role="alert" className="voice-settings__error">{previewError}</p>}
                <div className="voice-settings__footer">{owner && <button type="button" className="voice-settings__button voice-settings__button--primary" disabled={!dirty || !selectable || !provider?.available} onClick={() => void save()}>{saving ? <Loader2 size={17} aria-hidden="true" className="voice-settings__spin" /> : <Check size={17} aria-hidden="true" />}{saving ? 'Сохраняем и проверяем…' : 'Сохранить голос'}</button>}<p role="status" className="voice-settings__state">{saving ? 'Проверяем сохранённые настройки…' : dirty ? 'Есть несохранённые изменения' : notice || (profile ? 'Показаны сохранённые настройки' : '')}</p>{!catalogError && provider?.available && Boolean(provider.voices.length) && <button type="button" className="voice-settings__button" disabled={catalogLoading || saving} onClick={() => void loadCatalog()}>Обновить каталог голосов</button>}</div>
                {saveError && <p role="alert" className="voice-settings__error">{saveError}</p>}
                {profile && <p className="voice-settings__readback">Сохранено: {summaryProvider?.label || 'текущий режим'} · {summaryModel || (profile.selection.model ? 'сохранённая модель' : 'модель по умолчанию')} · {summaryVoice || (profile.selection.voiceName ? 'сохранённый голос' : 'голос по умолчанию')}.</p>}
                <p className="voice-settings__hint">После сохранения этот голос будет использоваться в новых звонках. Текущий разговор продолжится с прежними настройками.</p>
            </>}
        </>}
    </section>;
}
