import { FormEvent, useEffect, useRef, useState } from 'react';
import { useOnboarding } from '../context/OnboardingContext';
import { Link, useLocation } from 'react-router-dom';
import { useInstance } from '../context/InstanceContext';
import { useAuth } from '../context/AuthContext';
import BusinessSetupStatus from '../components/BusinessSetupStatus';
import ModuleNavigation from '../components/ModuleNavigation';
import AiModelSettings from '../components/AiModelSettings';
import VoiceSettings from '../components/VoiceSettings';
import TimeZoneSelect from '../components/TimeZoneSelect';
import { AssistantDraftEditor } from './AssistantBuilder';
import './CustomerSetup.css';
import {getTelephony} from '../api/telephony';

export default function CustomerSetup() {
    const { currentInstanceId } = useInstance();
    const auth = useAuth();
    const member = auth.memberships.find(item => item.businessId === currentInstanceId);
    const scope = `${auth.authenticated ? auth.userId || auth.loginName || "session" : "guest"}:${currentInstanceId}:${member?.role}:${[...(member?.capabilities || [])].sort().join(",")}`;
    if (!currentInstanceId) return <section className="customer-setup customer-setup-empty card p-6 space-y-4">
        <h1 className="text-2xl font-bold">Настройте свой бизнес в AVA</h1>
        <p>Создайте бизнес. AVA выделит ему отдельные знания и поставит подключение модулей в очередь.</p>
        <Link to="/instances" className="btn-primary min-h-[44px]">Создать бизнес</Link>
    </section>;
    // A new component per tenant also clears pending form and QR state.
    return <BusinessForm key={scope} businessId={currentInstanceId} />;
}

function BusinessForm({ businessId }: { businessId: number }) {
    const { hash } = useLocation();
    const { showGuide } = useOnboarding();
    const { refreshInstances } = useInstance();
    const auth = useAuth();
    const owner = auth.authenticated === true && !auth.permissionsLoading && auth.memberships.some(item => item.businessId === businessId && item.role === 'hotel_owner' && item.capabilities?.includes('business.manage'));
    const [profile, setProfile] = useState<Record<string, any> | null>(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [saveError, setSaveError] = useState('');
    const [saving, setSaving] = useState(false);
    const [managedPhones,setManagedPhones] = useState<boolean|null>(null);
    const [telephonyError,setTelephonyError] = useState(false);
    const [showDiagnostics, setShowDiagnostics] = useState(false);
    const [showAutoprompt, setShowAutoprompt] = useState(hash === '#business-autoprompt');
    const [autopromptMounted, setAutopromptMounted] = useState(hash === '#business-autoprompt');
    const [assistantSaving, setAssistantSaving] = useState(false);
    const assistantWrite = useRef(false);
    const profileVersion = useRef(0);
    const [reload, setReload] = useState(0);
    const alive = useRef(true);
    const savedProfileRef = useRef<Record<string, any> | null>(null);
    const pendingSave = useRef(false);
    const saveController = useRef<AbortController | null>(null);
    const profileReady = Boolean(profile);
    useEffect(() => {
        if (!profileReady || !['#business-profile', '#business-instructions', '#business-ai-model', '#business-voice', '#business-autoprompt', '#business-whatsapp', '#business-modules'].includes(hash)) return;
        const frame = requestAnimationFrame(() => {
            const target = document.getElementById(hash.slice(1));
            for (let node = target; node; node = node.parentElement) {
                if (node instanceof HTMLDetailsElement) node.open = true;
            }
            if (hash === '#business-autoprompt') { setShowAutoprompt(true); setAutopromptMounted(true); }
            target?.scrollIntoView({ block: 'start' });
        });
        return () => cancelAnimationFrame(frame);
    }, [hash, businessId, profileReady]);
    useEffect(() => {
        alive.current = true;
        let cancelled = false;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        const readVersion = profileVersion.current;
        setError(''); setTelephonyError(false);
        getTelephony(businessId,controller.signal).then(data=>{if(!controller.signal.aborted)setManagedPhones(data.managedMode);}).catch(()=>{if(!controller.signal.aborted)setTelephonyError(true);});
        fetch(`/api/hotel-profiles/${businessId}`, { credentials: 'same-origin', signal: controller.signal })
            .then(async response => { if (!response.ok) throw new Error(); return response.json(); })
            .then(data => {
                if (!data.success || Number(data.profile?.businessId) !== businessId) throw new Error();
                if (alive.current && !controller.signal.aborted && readVersion === profileVersion.current) {
                    const beforeRead = savedProfileRef.current;
                    setProfile(previous => {
                        const edits = previous && beforeRead ? Object.fromEntries(Object.entries(previous)
                            .filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(beforeRead[field]))) : {};
                        return { ...data.profile, ...edits };
                    });
                    savedProfileRef.current = data.profile;
                }
            })
            .catch(() => { if (alive.current && !cancelled && readVersion === profileVersion.current) setError('Не удалось загрузить настройки бизнеса. Повторите загрузку.'); })
            .finally(() => clearTimeout(timer));
        return () => { cancelled = true; alive.current = false; clearTimeout(timer); controller.abort(); saveController.current?.abort(); };
    }, [businessId, reload]);

    async function save(event: FormEvent) {
        event.preventDefault();
        if (!profile || !owner || pendingSave.current || assistantWrite.current) return;
        const writable = ['name','businessType','hotelTone','hotelTimezone','hotelWorkingHours','voiceGreetingTemplate','outboundOpenerTemplate','systemPrompt'];
        const payload = Object.fromEntries(writable.filter(field => (managedPhones===false || !['sipCallerId','sipAliases'].includes(field)) && Object.prototype.hasOwnProperty.call(profile, field)
            && JSON.stringify(profile[field]) !== JSON.stringify(savedProfileRef.current?.[field]))
            .map(field => [field, profile[field]]));
        if (!Object.keys(payload).length) { setNotice('Изменений нет.'); return; }
        pendingSave.current = true; setSaving(true); setSaveError(''); setNotice('');
        const controller = new AbortController(); saveController.current = controller;
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch(`/api/hotel-profiles/${businessId}`, { method: 'PUT', credentials: 'same-origin', signal: controller.signal,
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (!response.ok) throw new Error();
            const data = await response.json();
            if (!data.success || Number(data.profile?.businessId) !== businessId || controller.signal.aborted) throw new Error();
            const read = await fetch(`/api/hotel-profiles/${businessId}`, { credentials: 'same-origin', signal: controller.signal });
            if (!read.ok) throw new Error();
            const readback = await read.json();
            const matches = (expected: any, actual: any): boolean => typeof expected === 'string'
                ? typeof actual === 'string' && actual.trim() === expected.trim()
                : Array.isArray(expected) ? Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => matches(value, actual[index]))
                    : expected && typeof expected === 'object' ? actual && Object.entries(expected).every(([key, value]) => matches(value, actual[key])) : expected === actual;
            if (!readback.success || Number(readback.profile?.businessId) !== businessId || controller.signal.aborted
                || Object.entries(payload).some(([field, value]) => !matches(value, readback.profile[field]))) throw new Error();
            if (!alive.current) return;
            profileVersion.current += 1;
            savedProfileRef.current = readback.profile;
            setProfile(readback.profile); setNotice('Настройки сохранены. Они применятся к новым разговорам.');
            try { await refreshInstances(); } catch { /* The canonical profile was already checked. */ }
        } catch (_) { if (alive.current) setSaveError('Не удалось подтвердить сохранение. Введённый текст оставлен в форме. Повторите сохранение.'); }
        finally { clearTimeout(timer); pendingSave.current = false; if (alive.current) setSaving(false); }
    }
    function beginAssistantSave() {
        if (pendingSave.current || assistantWrite.current) return false;
        assistantWrite.current = true; setAssistantSaving(true);
        return true;
    }
    function endAssistantSave() {
        assistantWrite.current = false; if (alive.current) setAssistantSaving(false);
    }
    function generatedProfileSaved(updated: Record<string, unknown>, changedFields: string[]) {
        const before = savedProfileRef.current;
        profileVersion.current += 1; setError(''); setSaveError('');
        savedProfileRef.current = updated;
        setProfile(previous => {
            const edits = previous && before ? Object.fromEntries(Object.entries(previous).filter(([key, value]) =>
                !changedFields.includes(key) && JSON.stringify(value) !== JSON.stringify(before[key]))) : {};
            return { ...updated, ...edits };
        });
        setNotice('Инструкции сохранены.');
    }
    const change = (field: string, value: any) => { setProfile(current => current ? { ...current, [field]: value } : current); setNotice(''); setSaveError(''); };
    return <div className="customer-setup space-y-6 max-w-5xl">
        <header className="customer-setup-hero"><p className="customer-setup-eyebrow">{profile?.name || 'Ваш бизнес'}</p><h1>Настройки бизнеса</h1>
            <nav className="customer-setup-steps" aria-label="Разделы настроек бизнеса">
                <Link to="#business-profile">Профиль</Link>
                <Link to="#business-instructions">Инструкции и приветствие</Link>
                <Link to="#business-autoprompt" onClick={() => { setShowAutoprompt(true); setAutopromptMounted(true); }}>Инструкции по сайту</Link>
                <Link to="#business-voice">Голос и звонки</Link>
                <Link to="#business-ai-model">Модель для текста</Link>
                <Link to="/channels">Каналы связи</Link><Link to="/autopilot?tab=catalog">Товары и цены</Link>
            </nav>
            {showGuide && <Link to="/getting-started" className="customer-setup-guide-link">Продолжить настройку</Link>}
        </header>
        {error && <div role="alert" className="card p-4 text-red-700"><p>{error}</p><button type="button" className="btn-secondary mt-3" onClick={() => setReload(value => value + 1)}>Повторить загрузку настроек</button></div>}
        {!owner && <p className="card p-4">Настройки доступны для просмотра. Изменять их может владелец бизнеса.</p>}
        {profile && <form id="business-profile" onSubmit={save} className="customer-setup-panel card p-5 md:p-6 space-y-5" aria-busy={saving}>
            <div className="customer-setup-heading"><div><h2>Профиль бизнеса</h2></div></div>
            <fieldset disabled={!owner || saving || assistantSaving} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="Название бизнеса" id="business-name" value={profile.name} onChange={value => change('name', value)} required />
                    <TimeZoneSelect id="timezone" value={profile.hotelTimezone} onChange={value => change('hotelTimezone', value)} />
                </div>
                <Field label="Тон общения" id="tone" maxLength={500} value={profile.hotelTone} onChange={value => change('hotelTone', value)} />
                <details className="customer-setup-advanced">
                    <summary>Режим работы</summary>
                    <div className="grid gap-2 sm:grid-cols-2">
                        {([['mon','Понедельник'],['tue','Вторник'],['wed','Среда'],['thu','Четверг'],['fri','Пятница'],['sat','Суббота'],['sun','Воскресенье']] as const).map(([day, label]) => {
                            const hours = profile.hotelWorkingHours?.[day] || { enabled: true, start: '09:00', end: '18:00' };
                            const update = (patch: Record<string, unknown>) => change('hotelWorkingHours', { ...profile.hotelWorkingHours, [day]: { ...hours, ...patch } });
                            return <div key={day} className="customer-setup-hours rounded-xl border border-neu-surface-2 p-3 space-y-2">
                                <label className="customer-setup-day flex items-center gap-2"><input type="checkbox" checked={hours.enabled !== false} onChange={e => update({ enabled: e.target.checked })} />{label}</label>
                                <div className="flex items-center gap-2"><input type="time" className="input min-w-0" aria-label={`${label}: начало работы`} value={hours.start || '09:00'} disabled={hours.enabled === false} onChange={e => update({ start: e.target.value })} /><span>—</span><input type="time" className="input min-w-0" aria-label={`${label}: конец работы`} value={hours.end || '18:00'} disabled={hours.enabled === false} onChange={e => update({ end: e.target.value })} /></div>
                            </div>;
                        })}
                    </div>
                </details>
                <details id="business-instructions" className="customer-setup-instructions customer-setup-advanced space-y-4">
                    <summary>Инструкции и приветствие</summary>
                    <div><label htmlFor="assistant-instructions" className="label">Инструкции для ответов клиентам</label><textarea id="assistant-instructions" rows={7} maxLength={8000} className="input" value={profile.systemPrompt || ''} onChange={e => change('systemPrompt', e.target.value)} placeholder="Например: отвечай кратко и вежливо; если точной цены нет в знаниях, не придумывай её." /></div>
                    <p className="text-sm text-neu-muted"><Link to="#business-autoprompt" className="underline" onClick={() => { setShowAutoprompt(true); setAutopromptMounted(true); }}>Составить инструкции по сайту</Link> · <Link to="/knowledge-base" className="underline">Цены и услуги — в базе знаний</Link></p>
                <div><label htmlFor="greeting" className="label">Приветствие при входящем звонке</label><textarea id="greeting" rows={3} className="input" value={profile.voiceGreetingTemplate || ''} onChange={e => change('voiceGreetingTemplate', e.target.value)} /></div>
                <div><label htmlFor="opener" className="label">Начало исходящего звонка</label><textarea id="opener" rows={3} className="input" value={profile.outboundOpenerTemplate || ''} onChange={e => change('outboundOpenerTemplate', e.target.value)} /></div>
                <p className="text-sm text-neu-muted">{'{hotel_name}'} — название бизнеса. Изменения применятся к новым разговорам.</p>
                </details>
                <details className="customer-setup-advanced">
                    <summary>Номера для звонков</summary>
                    <div className="customer-setup-advanced-content space-y-4">
                        <div className="space-y-3">
                            <h3 className="customer-setup-subheading">Номера для звонков</h3>
                            {managedPhones===null ? <div><p role="status">{telephonyError?'Не удалось проверить подключение номеров. Повторите проверку или откройте раздел «Телефония».':'Проверяем подключение номеров…'}</p>{telephonyError && <Link to="/channels?channel=telephony" className="customer-setup-guide-link">Проверить телефонию</Link>}</div> : managedPhones ? <p>Номера подключены через AVA. Выберите основной номер в <Link to="/channels?channel=telephony" className="underline underline-offset-2">разделе «Телефония»</Link>.</p> : <div className="space-y-2">
                            <p>Входящий номер: <strong>{Array.isArray(profile.sipAliases) && profile.sipAliases[0] || 'Не подключён'}</strong></p>
                            <p>Номер для исходящих: <strong>{profile.sipCallerId || 'Не подключён'}</strong></p>
                            <Link to="/channels?channel=telephony" className="customer-setup-guide-link">Настроить телефонию</Link>
                            </div>}
                            <p className="text-sm text-neu-muted">Подключение и замена номера находятся в разделе «Каналы связи».</p>
                        </div>
                    </div>
                </details>
                <button type="submit" className="btn-primary min-h-[44px] focus-visible:outline focus-visible:outline-2">{saving ? 'Сохраняем…' : 'Сохранить настройки'}</button>
                {notice && <p role="status" className="font-medium">{notice}</p>}
                {saveError && <div role="alert" className="text-red-700"><p>{saveError}</p><button type="button" className="btn-secondary mt-3" onClick={() => setReload(value => value + 1)}>Проверить сохранённые настройки</button></div>}
            </fieldset>
        </form>}
        <details className="customer-setup-disclosure customer-setup-advanced">
            <summary>Модель для текста</summary>
            <AiModelSettings businessId={businessId} canEdit={owner} />
        </details>
        <details id="business-autoprompt" className="customer-setup-disclosure customer-setup-advanced customer-setup-autoprompt" open={showAutoprompt} onToggle={event => { setShowAutoprompt(event.currentTarget.open); if (event.currentTarget.open) setAutopromptMounted(true); }}>
            <summary id="business-autoprompt-title">Составить инструкции по сайту и соцсетям</summary>
            {autopromptMounted && <fieldset disabled={saving}><AssistantDraftEditor businessId={businessId} embedded showModelSettings={false} onProfileSaved={generatedProfileSaved} beforeSave={beginAssistantSave} onSaveSettled={endAssistantSave} /></fieldset>}
        </details>
        <details className="customer-setup-disclosure customer-setup-advanced">
            <summary>Голос и звонки</summary>
            <VoiceSettings businessId={businessId} />
        </details>
        <section id="business-whatsapp" className="customer-setup-panel card p-5 md:p-6 space-y-4">
            <div className="customer-setup-heading"><div><h2>Каналы связи</h2></div></div>
            <Link to="/channels" className="btn-primary inline-flex min-h-[44px] items-center">Настроить каналы связи</Link>
        </section>
        <section className="customer-setup-panel card p-5 md:p-6 space-y-4">
            <h2 className="text-xl font-semibold">База знаний</h2>
            <Link to="/knowledge-base" className="btn-secondary inline-flex min-h-[44px] items-center">Открыть базу знаний</Link>
        </section>
        <details id="business-modules" className="customer-setup-modules customer-setup-advanced" onToggle={event => setShowDiagnostics(event.currentTarget.open)}>
            <summary>Помощь с подключениями</summary>
            {showDiagnostics && <div className="customer-setup-advanced-content">
                <p className="text-sm text-neu-muted">Если подключение не завершилось, здесь можно проверить его и повторить настройку.</p>
                <ModuleNavigation key={businessId} businessId={businessId} />
                <BusinessSetupStatus businessId={businessId} canRetry={owner} customerView />
            </div>}
        </details>
    </div>;
}

function Field({ label, id, value, onChange, type = 'text', placeholder, required = false, maxLength }: {
    label: string; id: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string; required?: boolean; maxLength?: number;
}) {
    return <div><label htmlFor={id} className="label">{label}</label><input id={id} type={type} className="input min-h-[44px]" value={value || ''} placeholder={placeholder} required={required} maxLength={maxLength} onChange={e => onChange(e.target.value)} /></div>;
}
