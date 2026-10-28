import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, Check, ChevronLeft, CircleHelp, Headphones, MessageCircle, RefreshCw, Sparkles, Store } from 'lucide-react';
import { createInstance, getChannelStatus, getKnowledgeBaseStats } from '../api';
import { useAuth } from '../context/AuthContext';
import { useInstance } from '../context/InstanceContext';
import { useOnboarding } from '../context/OnboardingContext';
import { onboardingRequest, onboardingSteps } from '../onboardingApi';
import './OnboardingGuide.css';
import { AssistantDraftEditor } from './AssistantBuilder';

const steps = [
    { title: 'Ваш бизнес', short: 'Бизнес', icon: Store, description: 'Создайте пространство и задайте название и тип бизнеса.' },
    { title: 'Голос и стиль', short: 'Голос', icon: Headphones, description: 'Настройте тон общения, голос, приветствие и часы работы.' },
    { title: 'База знаний', short: 'Знания', icon: BookOpen, description: 'Добавьте услуги, цены и ответы на частые вопросы.' },
    { title: 'Каналы связи', short: 'Каналы', icon: MessageCircle, description: 'Выберите каналы, через которые клиенты будут обращаться к вам.' },
    { title: 'Инструкции по ссылкам', short: 'Правила', icon: Sparkles, description: 'Добавьте страницы бизнеса. AVA подготовит инструкции — проверьте и сохраните их.' },
] as const;
type GuideState = { step: number; viewed: number[] };
type ChannelSnapshot = { whatsapp?: boolean; whatsappConfigured?: boolean; telegram?: boolean; telegramConfigured?: boolean;
    email?: boolean; emailConfigured?: boolean; emailReceiving?: boolean };
type Snapshot = { profile?: { name?: string; businessType?: string; hotelTone?: string; voiceName?: string; hotelWorkingHours?: unknown };
    documents?: number; channels?: ChannelSnapshot; profileError?: boolean; knowledgeError?: boolean; channelError?: boolean };
const kinds = [
    { value: 'standard', label: 'Обычный бизнес', hint: 'Услуги и продажи' },
    { value: 'hotel', label: 'Отель', hint: 'Бронирования и гости' },
    { value: 'coffee_shop', label: 'Кофейня', hint: 'Заказы и самовывоз' },
] as const;

function readGuideState(key: string): GuideState {
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || 'null');
        return { step: Number.isInteger(parsed?.step) && parsed.step >= 0 && parsed.step < steps.length ? parsed.step : 0,
            viewed: Array.isArray(parsed?.viewed) ? parsed.viewed.filter((value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) < steps.length) : [] };
    } catch { return { step: 0, viewed: [] }; }
}

export default function OnboardingGuide() {
    const { currentInstanceId } = useInstance();
    const { userId, loginName } = useAuth();
    return <ScopedGuide key={`${userId || loginName}:${currentInstanceId ?? 'new'}`} storageKey={`ava:guide:v1:${loginName}:${currentInstanceId ?? 'new'}`} />;
}

function ScopedGuide({ storageKey }: { storageKey: string }) {
    const { currentInstanceId, currentInstance, instancesState, refreshInstances, setInstanceId } = useInstance();
    const { role, authenticated, permissionsLoading, memberships, canCreateBusiness, loginName: useLoginName, refreshAuth } = useAuth();
    const onboarding = useOnboarding();
    const canCreate = authenticated && !permissionsLoading && role !== 'platform_admin' && canCreateBusiness === true;
    const canEdit = authenticated && !permissionsLoading && role !== 'platform_admin' && memberships.some(item => item.businessId === currentInstanceId && item.role === 'hotel_owner' && item.capabilities?.includes('business.manage'));
    const [guide, setGuide] = useState<GuideState>(() => readGuideState(storageKey));
    const [snapshot, setSnapshot] = useState<Snapshot>({});
    const [checking, setChecking] = useState(false);
    const [createBusy, setCreateBusy] = useState(false);
    const [createError, setCreateError] = useState('');
    const [draftApproved, setDraftApproved] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const stepRequest = useRef(false);
    const approval = useRef({ approved: false, revision: 0 });
    const updateApproval = useCallback((approved: boolean) => {
        approval.current = { approved, revision: approval.current.revision + 1 };
        setDraftApproved(approved);
    }, []);
    const [businessName, setBusinessName] = useState('');
    const [businessType, setBusinessType] = useState<typeof kinds[number]['value']>('standard');
    const titleRef = useRef<HTMLHeadingElement>(null);
    const revision = useRef(0);
    const createRequest = useRef({ payload: '', key: '' });
    const profileRequest = useRef<AbortController | null>(null);

    useEffect(() => {
        try { localStorage.setItem(storageKey, JSON.stringify(guide)); } catch { /* Private browsing can disable storage. */ }
    }, [guide, storageKey]);

    const refresh = useCallback(async () => {
        if (!currentInstanceId) { setSnapshot({}); return; }
        const request = ++revision.current;
        profileRequest.current?.abort();
        const controller = new AbortController(); profileRequest.current = controller;
        const timer = setTimeout(() => controller.abort(), 20000);
        setChecking(true);
        const [profile, knowledge, channels] = await Promise.allSettled([
            fetch(`/api/hotel-profiles/${currentInstanceId}`, { credentials: 'same-origin', signal: controller.signal }).then(async response => {
                if (!response.ok) throw new Error('profile'); return response.json();
            }),
            getKnowledgeBaseStats(currentInstanceId),
            getChannelStatus(currentInstanceId),
        ]);
        clearTimeout(timer);
        if (request !== revision.current) return;
        setSnapshot({
            profile: profile.status === 'fulfilled' ? profile.value.profile : undefined,
            profileError: profile.status === 'rejected',
            documents: knowledge.status === 'fulfilled' && Number.isFinite(knowledge.value?.stats?.totalDocuments)
                ? knowledge.value.stats.totalDocuments : undefined,
            knowledgeError: knowledge.status === 'rejected',
            channels: channels.status === 'fulfilled' && channels.value?.success ? channels.value.channels : undefined,
            channelError: channels.status === 'rejected' || (channels.status === 'fulfilled' && !channels.value?.success),
        });
        setChecking(false);
    }, [currentInstanceId]);
    useEffect(() => { void refresh(); const activeRevision = revision; return () => { ++activeRevision.current; profileRequest.current?.abort(); }; }, [refresh]);

    function openStep(index: number) {
        setGuide(previous => ({ ...previous, step: index }));
        requestAnimationFrame(() => titleRef.current?.focus());
    }
    async function continueStep() {
        const finalStep = guide.step === steps.length - 1;
        const approvedRevision = approval.current.revision;
        if (!canEdit || stepRequest.current || (finalStep && !approval.current.approved)) return;
        stepRequest.current = true; setConfirming(true);
        try {
            if (!await onboarding.confirmStep(onboardingSteps[guide.step])) return;
            // An async acknowledgement cannot authorize completion of a changed draft.
            if (finalStep) {
                if (approval.current.approved && approval.current.revision === approvedRevision) await onboarding.complete();
                return;
            }
            openStep(guide.step + 1);
        } finally { stepRequest.current = false; setConfirming(false); }
    }
    async function createBusiness(event: FormEvent) {
        event.preventDefault();
        if (!canCreate || createBusy || !businessName.trim()) return;
        setCreateBusy(true); setCreateError('');
        try {
            const payload = { name: businessName.trim(), businessType,
                salesGoal: businessType === 'coffee_shop' ? 'coffee_pickup' : 'call' };
            const serialized = JSON.stringify(payload);
            if (createRequest.current.payload !== serialized) createRequest.current = { payload: serialized, key: crypto.randomUUID() };
            const result = await createInstance(payload, createRequest.current.key);
            const id = Number(result?.instance?.id ?? result?.id);
            if (!result?.success || !Number.isInteger(id) || id <= 0) throw new Error('invalid_response');
            let nextStep = 0;
            const ackController = new AbortController();
            const ackTimer = setTimeout(() => ackController.abort(), 15000);
            try { await onboardingRequest(id, '/steps/business', ackController.signal); nextStep = 1; }
            catch { /* Business exists; allow explicit confirmation on its first screen. */ }
            finally { clearTimeout(ackTimer); }
            await refreshAuth();
            await refreshInstances();
            try { localStorage.setItem(`ava:guide:v1:${useLoginName}:${id}`, JSON.stringify({ step: nextStep, viewed: [] })); } catch { /* optional */ }
            setInstanceId(id);
            createRequest.current = { payload: '', key: '' };
        } catch { setCreateError('Не удалось подтвердить создание бизнеса. Повторите попытку: повторный запрос с теми же данными не создаст дубликат.'); }
        finally { setCreateBusy(false); }
    }

    const step = steps[guide.step];
    const StepIcon = step.icon;
    const confirmed = onboarding.state?.confirmedSteps ?? [];
    const confirmedCount = confirmed.length;
    const canFinish = onboardingSteps.slice(0, -1).every(id => confirmed.includes(id));
    if (onboarding.phase === 'completed' && onboarding.state?.status === 'completed' && onboarding.state.businessId === currentInstanceId) return <main className="ava-onboarding ava-onboarding-inside">
        <section className="ava-guide-panel ava-guide-completed" aria-labelledby="ava-guide-completed-title">
            <span className="ava-guide-completed-icon" aria-hidden="true"><Check size={28} /></span>
            <p className="ava-onboarding-kicker">{currentInstance?.name || 'Ваш бизнес'}</p>
            <h1 id="ava-guide-completed-title">Настройка завершена</h1>
            <p>Ваши подтверждённые шаги сохранены. Инструкции, голос, ссылки бизнеса и каналы доступны в настройках.</p>
            <div className="ava-guide-completed-actions"><Link to="/" className="ava-onboarding-primary">Открыть главную <ArrowRight size={17} aria-hidden="true" /></Link><Link to="/today" className="ava-onboarding-link">Разобрать обращения</Link><Link to="/team" className="ava-onboarding-link">Пригласить команду</Link><Link to="/integrations" className="ava-onboarding-link">Настройки бизнеса</Link><Link to="/assistant-builder" className="ava-onboarding-link">Инструкции по ссылкам</Link></div>
        </section>
    </main>;
    return <main className="ava-onboarding ava-onboarding-inside">
        <header className="ava-guide-hero"><div><p className="ava-onboarding-kicker">Ваш первый маршрут в AVA</p><h1>Настроим <em>ваш бизнес</em></h1><p>Настройте нужное сейчас, остальное можно добавить позже. Ваш прогресс сохраняется для этого бизнеса.</p></div><div className="ava-guide-hero-mark" aria-hidden="true"><Sparkles size={34} /></div></header>
        <div className="ava-guide-layout">
            <nav className="ava-guide-rail" aria-label="Шаги настройки">
                <div className="ava-guide-rail-heading"><span>Ваш маршрут</span><strong>{confirmedCount} / {steps.length} пройдено</strong></div>
                <div className="ava-guide-rail-progress" role="progressbar" aria-label="Подтверждённые шаги" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={confirmedCount}><span style={{ width: `${confirmedCount / steps.length * 100}%` }} /></div>
                <ol>{steps.map((item, index) => { const Icon = item.icon; return <li key={item.title}><button type="button" aria-label={`Шаг ${index + 1} ${item.short}`} className={guide.step === index ? 'is-active' : ''} aria-current={guide.step === index ? 'step' : undefined} disabled={confirming || onboarding.busy} onClick={() => openStep(index)}><span className="ava-guide-step-icon">{confirmed.includes(onboardingSteps[index]) ? <Check size={18} /> : <Icon size={18} />}</span><span><small>Шаг {index + 1}</small><strong>{item.short}</strong></span></button></li>; })}</ol>
                <p>Можно вернуться к любому шагу. Знания, голос и каналы доступны в настройках и после завершения.</p>
            </nav>
            <section className="ava-guide-panel" aria-labelledby="ava-guide-step-title">
                <div className="ava-guide-panel-top"><span><StepIcon size={19} aria-hidden="true" /> Шаг {guide.step + 1} из {steps.length}</span><button type="button" onClick={() => void refresh()} disabled={!currentInstanceId || checking} aria-label="Обновить данные бизнеса"><RefreshCw size={18} className={checking ? 'ava-onboarding-spin' : ''} /></button></div>
                <h2 id="ava-guide-step-title" tabIndex={-1} ref={titleRef}>{step.title}</h2><p className="ava-guide-lead">{step.description}</p>
                {!canEdit && currentInstanceId && <p className="ava-guide-data-error">У вас доступ для просмотра. Изменять настройки может владелец бизнеса.</p>}
                {guide.step === 0 && <div className="ava-guide-body">
                    {currentInstanceId ? <div className="ava-guide-fact"><span className="ava-guide-fact-icon"><Store size={19} /></span><div><small>Выбранный бизнес</small><strong>{snapshot.profile?.name || currentInstance?.name || 'Название загружается'}</strong><p>Тип: {snapshot.profile?.businessType === 'hotel' ? 'отель' : snapshot.profile?.businessType === 'coffee_shop' ? 'кофейня' : snapshot.profile?.businessType === 'standard' ? 'обычный бизнес' : 'уточните в профиле'}.</p></div></div>
                        : instancesState === 'loading' ? <p role="status">Загружаем список бизнесов…</p>
                            : <form className="ava-guide-create" onSubmit={createBusiness}><div className="ava-guide-callout"><CircleHelp size={20} /><p>Создайте отдельное пространство для вашего бизнеса. Его название и тип можно будет уточнить в профиле.</p></div><label>Название бизнеса<input required maxLength={120} value={businessName} onChange={event => setBusinessName(event.target.value)} placeholder="Например, Отель «Маяк»" /></label><fieldset><legend>Тип бизнеса</legend><div className="ava-onboarding-type-grid">{kinds.map(kind => <label key={kind.value} className={businessType === kind.value ? 'is-selected' : ''}><input type="radio" name="guideBusinessType" checked={businessType === kind.value} onChange={() => setBusinessType(kind.value)} /><strong>{kind.label}</strong><small>{kind.hint}</small></label>)}</div></fieldset>{createError && <p role="alert" className="ava-onboarding-error">{createError}</p>}{canCreate ? <button className="ava-onboarding-primary" type="submit" disabled={createBusy}>{createBusy ? 'Создаём…' : 'Создать бизнес'} <ArrowRight size={17} /></button> : <p>Создание бизнеса недоступно для этого аккаунта. Войдите в аккаунт владельца или попросите его пригласить вас в команду.</p>}</form>}
                    {currentInstanceId && <><p>Название и тип сохраняются в профиле бизнеса. Проверьте их перед продолжением.</p><Link className="ava-onboarding-link" to="/integrations#business-profile">Открыть профиль бизнеса <ArrowRight size={17} /></Link></>}
                </div>}
                {guide.step === 1 && <div className="ava-guide-body"><div className="ava-guide-feature"><span>01</span><div><strong>Тон и правила общения</strong><p>Опишите, как AVA должна отвечать. Факты о ценах и услугах добавьте в базу знаний.</p></div></div><div className="ava-guide-feature"><span>02</span><div><strong>Голос и приветствие</strong><p>Выберите голос и фразу для входящего звонка. Сохранение не проверяет телефонию.</p></div></div><div className="ava-guide-feature"><span>03</span><div><strong>Часы и часовой пояс</strong><p>Укажите, когда работает бизнес, чтобы сценарии учитывали расписание.</p></div></div>{snapshot.profile && <p className="ava-guide-inline-status">Профиль загружен: {snapshot.profile.hotelTone ? 'тон задан' : 'тон можно уточнить'} · {snapshot.profile.voiceName ? 'голос выбран' : 'голос по умолчанию'}.</p>}<Link className="ava-onboarding-link" to="/integrations#business-voice">Настроить профиль и голос <ArrowRight size={17} /></Link></div>}
                {guide.step === 2 && <div className="ava-guide-body"><div className="ava-guide-fact"><span className="ava-guide-fact-icon"><BookOpen size={19} /></span><div><small>Документы в базе</small><strong>{snapshot.documents === undefined ? 'Статус не получен' : snapshot.documents}</strong><p>Количество документов не означает, что ответ AVA уже проверен.</p></div></div><p>Добавьте актуальные услуги, цены, правила и частые вопросы. Дождитесь обработки и задайте контрольный вопрос в блоке «Предварительный ответ».</p><Link className="ava-onboarding-link" to="/knowledge-base">Добавить знания и проверить ответ <ArrowRight size={17} /></Link></div>}
                {guide.step === 3 && <div className="ava-guide-body"><p>Подключайте только нужные каналы. В AVA доступны WhatsApp, Instagram, Telegram и почта. Для каждого проверьте статус и отправьте настоящее входящее сообщение.</p><div className="ava-guide-channel-grid">{(['whatsapp', 'telegram', 'email'] as const).map(key => <div key={key}><strong>{key === 'whatsapp' ? 'WhatsApp' : key === 'telegram' ? 'Telegram' : 'Почта'}</strong><span>{!snapshot.channels ? 'Статус не получен' : snapshot.channels[key] ? 'Подключён' : snapshot.channels[`${key}Configured`] ? 'Настроен, связь ещё не подтверждена' : 'Не подключён'}</span></div>)}<div><strong>Instagram</strong><span>Проверьте статус в разделе каналов</span></div></div><p className="ava-guide-muted">После подключения напишите в канал с другого аккаунта и найдите сообщение в «Обращениях».</p><Link className="ava-onboarding-link" to="/channels">Открыть каналы связи <ArrowRight size={17} /></Link></div>}
                {guide.step === 4 && currentInstanceId && <div className="ava-guide-body">
                    <fieldset className="ava-guide-editor" disabled={confirming || onboarding.busy} aria-label="Инструкции бизнеса"><AssistantDraftEditor key={currentInstanceId} businessId={currentInstanceId} embedded onApprovalChange={updateApproval} /></fieldset>
                    <p className="ava-guide-muted">После сохранения завершите настройку. Автопромпт останется в настройках бизнеса. Перед запуском проверьте ответ ассистента и настоящее входящее сообщение.</p>
                </div>}
                {(snapshot.profileError || snapshot.knowledgeError || snapshot.channelError) && <p className="ava-guide-data-error" role="status">Часть данных сейчас недоступна. Обновите состояние позже в соответствующем разделе.</p>}
                {guide.step > 0 && guide.step < 4 && <div className="ava-guide-callout"><CircleHelp size={20} aria-hidden="true" /><p>{guide.step === 1 ? 'Голос можно выбрать позже. До этого AVA использует текущие настройки звонков.' : guide.step === 2 ? 'Знания можно добавить позже. Без них AVA не сможет отвечать о ваших товарах, услугах и ценах.' : 'Каналы можно подключить позже. Пока они отключены, обращения из них не появятся в AVA.'}</p></div>}
                {onboarding.error && <p className="ava-guide-data-error" role="alert">{onboarding.error}</p>}
                {guide.step === steps.length - 1 && !canFinish && <p className="ava-guide-muted" role="status">Чтобы завершить мастер, подтвердите предыдущие четыре шага. Открытие шага не считается подтверждением.</p>}
                <footer className="ava-guide-footer"><button type="button" className="ava-onboarding-back" disabled={guide.step === 0 || onboarding.busy || confirming} onClick={() => openStep(guide.step - 1)}><ChevronLeft size={17} aria-hidden="true" /> Назад</button><button type="button" className="ava-onboarding-primary" disabled={!currentInstanceId || !canEdit || onboarding.phase !== 'pending' || onboarding.busy || confirming || (guide.step === steps.length - 1 && (!canFinish || !draftApproved))} onClick={() => void continueStep()}>{onboarding.busy || confirming ? 'Сохраняем…' : guide.step === steps.length - 1 ? 'Завершить настройку' : 'Подтвердить и продолжить'} <ArrowRight size={17} aria-hidden="true" /></button></footer>
                {currentInstanceId && canEdit && guide.step > 0 && guide.step < 4 && <button type="button" className="ava-guide-later" disabled={onboarding.busy || confirming || onboarding.phase !== 'pending'} onClick={() => void continueStep()}>Настроить позже</button>}
                {currentInstanceId && <Link className="ava-guide-later" to="/today">Продолжить позже</Link>}
            </section>
        </div>
    </main>;
}
