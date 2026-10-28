import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import { getAiModels, getAiProviders, getInstances, updateInstance, type AiModel, type TextAiProvider } from '../api';
import { useInstance } from '../context/InstanceContext';
import { useAuth } from '../context/AuthContext';

type Selection = { provider: TextAiProvider; model: string };
type Settings = { selection: Selection; models: Record<TextAiProvider, string> };
type Provider = { id: TextAiProvider; name: string; configured: boolean; defaultModel: string };
const same = (a: Selection | null, b: Selection | null) => a?.provider === b?.provider && a?.model === b?.model;
const providerId = (value: unknown): TextAiProvider => {
    if (value === 'gemini') return 'gemini';
    if (['aitunnel', 'yandex', 'google_live', 'openai_realtime', 'yandex_realtime', 'deepgram', 'local', 'neuro_gemini', ''].includes(String(value ?? ''))) return 'aitunnel';
    throw new Error('invalid provider');
};
function storedSettings(data: any, businessId: number): Settings {
    const instance = data?.success === true && Array.isArray(data.instances)
        ? data.instances.find((item: { id: number }) => item?.id === businessId) : null;
    if (!instance || (instance.yandexGptModelUri != null && typeof instance.yandexGptModelUri !== 'string')
        || (instance.geminiModel != null && typeof instance.geminiModel !== 'string')) throw new Error('invalid instance');
    const models = { aitunnel: instance.yandexGptModelUri ?? '', gemini: instance.geminiModel ?? '' };
    const provider = providerId(instance.aiProvider);
    return { models, selection: { provider, model: models[provider] } };
}
function providerCatalogue(data: any): Provider[] {
    if (data?.success !== true || !Array.isArray(data.providers) || data.providers.length !== 2
        || data.providers.some((p: any) => !p || !['aitunnel', 'gemini'].includes(p.id) || typeof p.name !== 'string'
            || typeof p.configured !== 'boolean' || typeof p.defaultModel !== 'string')
        || new Set(data.providers.map((p: Provider) => p.id)).size !== 2) throw new Error('invalid providers');
    return data.providers;
}

export default function AiModelSettings({ businessId, canEdit }: { businessId: number; canEdit: boolean }) {
    const auth = useAuth();
    const member = auth.memberships.find(item => item.businessId === businessId);
    const canRead = auth.authenticated && (auth.role === 'platform_admin' || member?.capabilities?.includes('business.read') === true);
    const owner = canRead && (auth.role === 'platform_admin'
        || (member?.role === 'hotel_owner' && member.capabilities?.includes('business.manage') === true));
    const identity = auth.authenticated ? auth.userId || auth.loginName || 'session' : 'guest';
    return <ModelForm key={`${identity}:${businessId}:${canRead}:${owner}`} businessId={businessId} canRead={canRead} canEdit={canEdit && owner && !auth.permissionsLoading} />;
}

function ModelForm({ businessId, canRead, canEdit }: { businessId: number; canRead: boolean; canEdit: boolean }) {
    const { refreshInstances } = useInstance();
    const id = useId();
    const [selection, setSelection] = useState<Selection | null>(null);
    const [saved, setSaved] = useState<Settings | null>(null);
    const [providers, setProviders] = useState<Provider[]>([]);
    const [providersError, setProvidersError] = useState('');
    const [models, setModels] = useState<AiModel[]>([]);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [modelsError, setModelsError] = useState('');
    const [catalogueProvider, setCatalogueProvider] = useState<TextAiProvider | null>(null);
    const [settingsLoading, setSettingsLoading] = useState(canRead);
    const [settingsError, setSettingsError] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState('');
    const [saveUncertain, setSaveUncertain] = useState(false);
    const [notice, setNotice] = useState('');
    const drafts = useRef<Partial<Record<TextAiProvider, string>>>({});
    const modelsRequest = useRef<AbortController | null>(null);
    const providersRequest = useRef<AbortController | null>(null);
    const settingsRequest = useRef<AbortController | null>(null);
    const saveRequest = useRef<AbortController | null>(null);

    const loadSettings = useCallback(async () => {
        if (!canRead) return;
        settingsRequest.current?.abort();
        const controller = new AbortController(); settingsRequest.current = controller;
        const current = () => !controller.signal.aborted && settingsRequest.current === controller;
        setSettingsLoading(true); setSettingsError('');
        try {
            const data = await getInstances(controller.signal);
            if (!current()) return;
            const settings = storedSettings(data, businessId);
            setSelection(settings.selection); setSaved(settings); drafts.current = {}; setSaveUncertain(false);
        } catch {
            if (current()) setSettingsError('Не удалось загрузить сохранённую модель. Попробуйте ещё раз.');
        } finally { if (current()) { setSettingsLoading(false); settingsRequest.current = null; } }
    }, [businessId, canRead]);

    const loadProviders = useCallback(async () => {
        if (!canRead) return;
        providersRequest.current?.abort();
        const controller = new AbortController(); providersRequest.current = controller;
        const current = () => !controller.signal.aborted && providersRequest.current === controller;
        setProvidersError('');
        try {
            const data = providerCatalogue(await getAiProviders(businessId, controller.signal));
            if (current()) setProviders(data);
        } catch { if (current()) setProvidersError('Не удалось загрузить доступные AI. Повторите загрузку.'); }
        finally { if (current()) providersRequest.current = null; }
    }, [businessId, canRead]);

    const loadModels = useCallback(async (provider: TextAiProvider) => {
        if (!canRead) return;
        modelsRequest.current?.abort();
        const controller = new AbortController(); modelsRequest.current = controller;
        const current = () => !controller.signal.aborted && modelsRequest.current === controller;
        setModelsLoading(true); setModelsError('');
        try {
            const data = await getAiModels(businessId, controller.signal, provider);
            if (!current()) return;
            if (data?.success !== true || (data.provider !== undefined && data.provider !== provider) || !Array.isArray(data.models)
                || data.models.some((model: AiModel) => !model || typeof model.id !== 'string' || !model.id
                    || model.id.length > 256 || /\s|\p{Cc}/u.test(model.id)
                    || (model.name !== undefined && typeof model.name !== 'string'))) throw new Error('invalid catalogue');
            const catalogue = Array.from(new Map<string, AiModel>(data.models.map((model: AiModel) => [model.id, model])).values());
            setModels(catalogue); setCatalogueProvider(provider);
            if (!catalogue.length) setModelsError('Список моделей пока пуст. Попробуйте обновить его позже.');
        } catch { if (current()) setModelsError('Не удалось загрузить список моделей. Попробуйте ещё раз.'); }
        finally { if (current()) { setModelsLoading(false); modelsRequest.current = null; } }
    }, [businessId, canRead]);

    useEffect(() => {
        const cancel = () => {
            modelsRequest.current?.abort(); modelsRequest.current = null;
            providersRequest.current?.abort(); providersRequest.current = null;
            settingsRequest.current?.abort(); settingsRequest.current = null;
            saveRequest.current?.abort(); saveRequest.current = null;
        };
        const unauthorized = () => {
            cancel(); setSelection(null); setSaved(null); setModels([]); setProviders([]); setCatalogueProvider(null);
            setModelsLoading(false); setSettingsLoading(false); setSaving(false); setNotice(''); setSaveUncertain(false);
        };
        window.addEventListener('crm:unauthorized', unauthorized);
        void loadSettings(); void loadProviders();
        return () => { cancel(); window.removeEventListener('crm:unauthorized', unauthorized); };
    }, [loadSettings, loadProviders]);
    const selectedProvider = selection?.provider ?? 'aitunnel';
    useEffect(() => { void loadModels(selectedProvider); }, [selectedProvider, loadModels]);

    useEffect(() => {
        const defaultModel = providers.find(p => p.id === 'gemini')?.defaultModel;
        if (!saved || saved.models.gemini || !defaultModel) return;
        const settings = { ...saved, models: { ...saved.models, gemini: defaultModel },
            selection: saved.selection.provider === 'gemini' && !saved.selection.model ? { ...saved.selection, model: defaultModel } : saved.selection };
        setSaved(settings);
        setSelection(current => current?.provider === 'gemini' && !current.model ? { ...current, model: defaultModel } : current);
    }, [providers, saved]);

    function changeProvider(provider: TextAiProvider) {
        if (!selection || !canEdit || saving || settingsLoading || !providers.find(p => p.id === provider)?.configured) return;
        drafts.current[selection.provider] = selection.model;
        const remembered = drafts.current[provider] ?? saved?.models[provider];
        const next = remembered || (provider === 'gemini' ? providers.find(p => p.id === provider)?.defaultModel ?? '' : remembered ?? '');
        setModels([]); setCatalogueProvider(null); setModelsError(''); setNotice('');
        if (!saveUncertain) setSaveError('');
        setSelection({ provider, model: next });
    }
    async function save(event: FormEvent) {
        event.preventDefault();
        if (!canEdit || settingsLoading || providersError || !selection || !saved || (same(selection, saved.selection) && !saveUncertain) || saveRequest.current
            || !providers.find(p => p.id === selection.provider)?.configured || catalogueProvider !== selection.provider || modelsError) return;
        const expected = { ...selection };
        const patch: Record<string, string> = { [expected.provider === 'gemini' ? 'geminiModel' : 'yandexGptModelUri']: expected.model };
        if (expected.provider !== saved.selection.provider || saveUncertain) patch.aiProvider = expected.provider;
        const controller = new AbortController(); saveRequest.current = controller;
        const current = () => !controller.signal.aborted && saveRequest.current === controller;
        let acknowledged = false;
        setSaving(true); setSaveError(''); setNotice('');
        try {
            const response = await updateInstance(businessId, patch, controller.signal);
            if (!current()) return;
            const ack = storedSettings({ success: response?.success, instances: response?.instance ? [response.instance] : [] }, businessId);
            if (!same(ack.selection, expected)) throw new Error('invalid acknowledgement');
            acknowledged = true;
            const readback = await getInstances(controller.signal);
            if (!current()) return;
            const settings = storedSettings(readback, businessId);
            if (!same(settings.selection, expected)) throw new Error('unconfirmed save');
            setSaved(settings); drafts.current = {}; setSaveUncertain(false); setNotice('Модель сохранена.');
            try { await refreshInstances(); } catch { /* Canonical settings were already verified. */ }
        } catch (error: any) {
            if (current()) {
                const code = !acknowledged && error?.response?.data?.code;
                const unavailable = ['AI_MODEL_UNAVAILABLE', 'INVALID_AI_MODEL', 'AI_PROVIDER_NOT_CONFIGURED', 'INVALID_AI_PROVIDER'].includes(code);
                if (!unavailable) setSaveUncertain(true);
                setSaveError(code === 'AI_PROVIDER_NOT_CONFIGURED' ? 'Этот AI временно недоступен. Выберите другой или повторите позже.'
                    : unavailable ? 'Эта модель больше недоступна. Обновите список и выберите другую.'
                        : 'Не удалось подтвердить сохранение. Выбор оставлен в форме; повторите попытку.');
            }
        } finally { if (current()) { setSaving(false); saveRequest.current = null; } }
    }

    const savedModel = saved?.models[selectedProvider] ?? '';
    const retainedModels = Array.from(new Set([selection?.model, savedModel].filter((value): value is string => !!value)))
        .filter(value => !models.some(model => model.id === value));
    const providerName = selectedProvider === 'gemini' ? 'Gemini' : 'AITunnel';
    const available = providers.find(p => p.id === selectedProvider)?.configured === true;
    const dirty = selection && saved && (!same(selection, saved.selection) || saveUncertain);
    return <section id="business-ai-model" className="customer-setup-panel card p-5 md:p-6 space-y-4" aria-labelledby={`${id}-title`}>
        <div><h2 id={`${id}-title`}>AI вашего бизнеса</h2><p className="text-sm text-neu-muted mt-1">Одна модель для ответов клиентам, инструкций ассистента, вопросов AVA и итогов дня.</p></div>
        {!canRead ? <p>Выберите бизнес, к которому у вас есть доступ.</p> : <>
        {settingsLoading && <p role="status">Загружаем сохранённую модель…</p>}
        {settingsError && <div role="alert"><p>{settingsError}</p><button type="button" onClick={loadSettings} className="btn-secondary min-h-[44px] mt-2">Повторить загрузку модели</button></div>}
        {providersError && <div role="alert"><p>{providersError}</p><button type="button" onClick={loadProviders} className="btn-secondary min-h-[44px] mt-2">Повторить загрузку AI</button></div>}
        <form onSubmit={save} className="space-y-3" aria-busy={saving}>
            <div><label htmlFor={`${id}-provider`} className="label">AI для текстовых задач</label>
                <select id={`${id}-provider`} value={selectedProvider} className="input w-full min-w-0 min-h-[44px]" disabled={!canEdit || saving || settingsLoading || !selection || !providers.length || Boolean(providersError)} onChange={event => changeProvider(event.target.value as TextAiProvider)}>
                    {!providers.length && <option value={selectedProvider}>{providerName}</option>}
                    {providers.map(p => <option key={p.id} value={p.id} disabled={!p.configured}>{p.name}{!p.configured ? ' · недоступен' : ''}</option>)}
                </select>
            </div>
            <label htmlFor={`${id}-model`} className="label">Модель {providerName}</label>
            <div className="flex gap-2 min-w-0">
                <select id={`${id}-model`} value={selection?.model ?? ''} onChange={event => { if (selection) { drafts.current[selectedProvider] = event.target.value; setSelection({ ...selection, model: event.target.value }); } if (!saveUncertain) setSaveError(''); setNotice(''); }}
                    disabled={!canEdit || saving || settingsLoading || !selection || !models.length || !available}
                    aria-busy={modelsLoading} aria-describedby={modelsError ? `${id}-model-error` : modelsLoading ? `${id}-model-loading` : undefined}
                    className="input flex-1 min-w-0 min-h-[44px]">
                    {!selection?.model && <option value="" disabled>Выберите модель</option>}
                    {retainedModels.map(value => <option key={value} value={value}>{value} — {value === savedModel ? 'сохранённая модель' : 'выбранная модель'}</option>)}
                    {models.map(model => <option key={model.id} value={model.id}>{model.name && model.name !== model.id ? selectedProvider === 'gemini' ? model.name : `${model.name} · ${model.id}` : model.id}</option>)}
                </select>
                <button type="button" onClick={() => void loadModels(selectedProvider)} disabled={modelsLoading || saving} aria-label="Обновить список моделей" title="Обновить список моделей"
                    className="btn-secondary min-w-[44px] min-h-[44px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
                    <RefreshCw size={16} aria-hidden="true" className={modelsLoading ? 'animate-spin motion-reduce:animate-none' : ''} />
                </button>
            </div>
            {modelsLoading && <p id={`${id}-model-loading`} role="status" className="text-sm text-neu-muted">Загружаем список моделей…</p>}
            {modelsError && <p id={`${id}-model-error`} role="alert" className="text-sm text-red-700">{modelsError}</p>}
            {catalogueProvider === selectedProvider && !modelsLoading && !modelsError && savedModel && !models.some(model => model.id === savedModel)
                && <p role="status" className="text-sm text-neu-muted">Сохранённая модель сейчас отсутствует в списке. Можно выбрать другую модель.</p>}
            {canEdit && <button type="submit" disabled={saving || settingsLoading || !dirty || !available || catalogueProvider !== selectedProvider || Boolean(modelsError) || Boolean(providersError)}
                className="btn-primary min-h-[44px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">{saving ? 'Сохраняем модель…' : 'Сохранить модель'}</button>}
            {notice && <p role="status">{notice}</p>}
            {saveError && <p role="alert" className="text-sm text-red-700">{saveError}</p>}
            <p className="text-sm text-neu-muted">После сохранения новые текстовые запросы используют выбранную модель. Голос для звонков настраивается отдельно.</p>
        </form>
        </>}
    </section>;
}
