import { useState, useEffect, useRef, useCallback } from 'react';
import { useInstance } from '../context/InstanceContext';
import { getTriggers, createTrigger, updateTrigger, deleteTrigger, getTriggerLog, getTriggerSettings, updateTriggerSettings, getSequences, createSequence, updateSequence, deleteSequence, getSequenceSteps, addSequenceStep, deleteSequenceStep } from '../api';
import { useAuth } from '../context/AuthContext';
import './SmartTriggers.css';
import { Zap, Plus, Trash2, Pencil, Clock, AlertCircle, Loader2, ChevronDown, ChevronUp, ListOrdered, ArrowRight, X, Check, Info, Eye, EyeOff, VolumeX, KeyRound, RefreshCw, UserPlus, CalendarClock, Frown, MessageSquare, Bell, Gift } from 'lucide-react';
import { COFFEE_PIPELINE, getPipeline, STANDARD_PIPELINE } from '../businessProfiles';

// =============================================
// Constants
// =============================================

const TRIGGER_TYPES = [
    { id: 'silence',       label: 'Клиент молчит',       icon: <VolumeX size={20} />, desc: 'Клиент перестал писать на N часов',        color: '#6e56ff' },
    { id: 'keyword',       label: 'Ключевое слово',      icon: <KeyRound size={20} />, desc: 'Клиент написал определённое слово/фразу',  color: '#6e56ff' },
    { id: 'status_change', label: 'Смена статуса',        icon: <RefreshCw size={20} />, desc: 'Лид перешёл в нужный статус',             color: '#6e56ff' },
    { id: 'new_lead',      label: 'Новый лид',           icon: <UserPlus size={20} />, desc: 'Появился новый клиент',                    color: '#6e56ff' },
    { id: 'time_based',    label: 'По расписанию',        icon: <CalendarClock size={20} />, desc: 'Каждый день в определённый час',           color: '#6e56ff' },
    { id: 'sentiment',     label: 'Плохое настроение',    icon: <Frown size={20} />, desc: 'Настроение клиента ниже порога',           color: '#6e56ff' },
];

const ACTION_TYPES = [
    { id: 'send_message',   label: 'Отправить сообщение',  icon: <MessageSquare size={20} />, desc: 'Бот напишет клиенту' },
    { id: 'change_status',  label: 'Сменить статус',       icon: <RefreshCw size={20} />, desc: 'Перевести лид в другой статус' },
    { id: 'notify_manager', label: 'Уведомить менеджера',  icon: <Bell size={20} />, desc: 'Push-уведомление менеджеру' },
    { id: 'start_sequence', label: 'Запустить цепочку',    icon: <ListOrdered size={20} />, desc: 'Добавить клиента в автоматическую серию' },
    { id: 'send_offer',     label: 'Сгенерировать КП',     icon: <Gift size={20} />, desc: 'AI создаст персональное предложение' },
];

const LEAD_STATUSES = [...STANDARD_PIPELINE, ...COFFEE_PIPELINE];

const DAY_NAMES = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

// =============================================
// Types
// =============================================

interface Trigger {
    id: number; instanceId: number; name: string; isActive: number; triggerType: string;
    conditions: string; actionType: string; actionData: string; priority: number;
    maxExecutions: number; cooldownMinutes: number; createdAt: string;
}
interface Sequence { id: number; instanceId: number; name: string; description: string; isActive: number; createdAt: string; deliveryFailureCount?: number; unfinishedEnrollmentCount?: number; }
interface SequenceStep { id: number; sequenceId: number; stepOrder: number; delayMinutes: number; messageTemplate: string; useAiPersonalization: number; channelOverride?: string | null; }

// --- Visual form state (not JSON!) ---
interface ConditionForm {
    silenceHours: number;
    statuses: string[];
    targetStatus: string;
    keywords: string[];
    keywordInput: string;
    hour: number;
    days: number[];
    sentimentThreshold: number;
}
interface ActionForm {
    message: string;
    status: string;
    sequenceId: number;
}

const defaultCondition = (): ConditionForm => ({
    silenceHours: 24, statuses: [], targetStatus: 'qualified', keywords: [], keywordInput: '',
    hour: 10, days: [1, 2, 3, 4, 5], sentimentThreshold: 30,
});
const defaultAction = (): ActionForm => ({ message: '', status: 'qualified', sequenceId: 0 });

function savedObject(raw: string): Record<string, unknown> {
    try {
        const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch { return {}; }
}

function hydrateConditions(raw: string): ConditionForm {
    const saved = savedObject(raw);
    const defaults = defaultCondition();
    return {
        ...defaults,
        silenceHours: typeof saved.silenceHours === 'number' ? saved.silenceHours : defaults.silenceHours,
        statuses: Array.isArray(saved.statuses) ? saved.statuses.filter((s): s is string => typeof s === 'string') : [],
        targetStatus: typeof saved.targetStatus === 'string' ? saved.targetStatus : defaults.targetStatus,
        keywords: Array.isArray(saved.keywords) ? saved.keywords.filter((s): s is string => typeof s === 'string') : [],
        hour: typeof saved.hour === 'number' ? saved.hour : defaults.hour,
        days: Array.isArray(saved.days) ? saved.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6) : defaults.days,
        sentimentThreshold: typeof saved.threshold === 'number' ? Math.round(saved.threshold * 100) : defaults.sentimentThreshold,
    };
}

function hydrateAction(raw: string): ActionForm {
    const saved = savedObject(raw);
    const defaults = defaultAction();
    return {
        message: typeof saved.message === 'string' ? saved.message : defaults.message,
        status: typeof saved.status === 'string' ? saved.status : defaults.status,
        sequenceId: typeof saved.sequenceId === 'number' ? saved.sequenceId : defaults.sequenceId,
    };
}

// =============================================
// Helper: parse saved trigger data for human-friendly display
// =============================================
function parseTriggerConditions(type: string, raw: string, statuses = LEAD_STATUSES): string {
    try {
        const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
        switch (type) {
            case 'silence': {
                const h = c.silenceHours || '?';
                const sts = c.statuses?.length ? c.statuses.map((s: string) => statuses.find(l => l.id === s)?.label || s).join(', ') : 'все';
                return `Молчит ${h}ч · Статусы: ${sts}`;
            }
            case 'keyword': return `Слова: ${(c.keywords || []).join(', ')}`;
            case 'status_change': return `При переходе в «${statuses.find(l => l.id === c.targetStatus)?.label || c.targetStatus}»`;
            case 'new_lead': return 'При появлении нового лида';
            case 'time_based': {
                const ds = (c.days || []).map((d: number) => DAY_NAMES[d]).join(', ');
                return `Каждый ${ds} в ${c.hour || 0}:00`;
            }
            case 'sentiment': return `Тональность ниже ${c.threshold || 30}%`;
            default: return '';
        }
    } catch { return ''; }
}

function parseTriggerAction(type: string, raw: string, statuses = LEAD_STATUSES): string {
    try {
        const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
        switch (type) {
            case 'send_message': return a.message ? `«${a.message.substring(0, 60)}${a.message.length > 60 ? '...' : ''}»` : '';
            case 'change_status': return `→ ${statuses.find(l => l.id === a.status)?.label || a.status}`;
            case 'notify_manager': return 'Push менеджеру';
            case 'start_sequence': return `Цепочка #${a.sequenceId}`;
            case 'send_offer': return 'AI генерирует КП';
            default: return '';
        }
    } catch { return ''; }
}

// =============================================
// Main Component
// =============================================

export default function SmartTriggers() {
    const { currentInstanceId } = useInstance();
    const { userId } = useAuth();
    return <SmartTriggersBusiness key={`${userId}:${currentInstanceId}`} />;
}
function SmartTriggersBusiness() {
    const { currentInstanceId, currentInstance } = useInstance();
    const { role, memberships } = useAuth();
    const canEdit = role === 'platform_admin' || memberships.some(m => m.businessId === currentInstanceId && m.role === 'hotel_owner');
    const leadStatuses = getPipeline(currentInstance);
    const [triggers, setTriggers] = useState<Trigger[]>([]);
    const [sequences, setSequences] = useState<Sequence[]>([]);
    const [log, setLog] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [masterEnabled, setMasterEnabled] = useState(false);
    const [masterBusy, setMasterBusy] = useState(false);
    const [masterError, setMasterError] = useState('');
    const [operationError, setOperationError] = useState('');
    const [triggerBusyId, setTriggerBusyId] = useState<number | null>(null);
    const triggerLock = useRef(false);
    const [tab, setTab] = useState<'triggers' | 'sequences' | 'log'>('triggers');

    // --- Trigger wizard state ---
    const [wizardOpen, setWizardOpen] = useState(false);
    const [editingTriggerId, setEditingTriggerId] = useState<number | null>(null);
    const wizardRef = useRef<HTMLDivElement>(null);
    const wizardTriggerRef = useRef<HTMLElement | null>(null);
    const savingTriggerRef = useRef(false);
    const [wizardStep, setWizardStep] = useState(0); // 0=event, 1=condition, 2=action, 3=settings
    const [triggerName, setTriggerName] = useState('');
    const [triggerType, setTriggerType] = useState('silence');
    const [actionType, setActionType] = useState('send_message');
    const [cond, setCond] = useState<ConditionForm>(defaultCondition());
    const [act, setAct] = useState<ActionForm>(defaultAction());
    const [cooldownMinutes, setCooldownMinutes] = useState(60);
    const [maxExecutions, setMaxExecutions] = useState(0);
    const [savingTrigger, setSavingTrigger] = useState(false);
    const [previewTriggerId, setPreviewTriggerId] = useState<number | null>(null);
    const [previewText, setPreviewText] = useState('');
    const [previewBusy, setPreviewBusy] = useState(false);
    const [previewError, setPreviewError] = useState('');
    const [previewResult, setPreviewResult] = useState<{ matched: boolean; matchedKeyword: string | null } | null>(null);
    const previewAbortRef = useRef<AbortController | null>(null);

    // --- Sequence state ---
    const [showSeqForm, setShowSeqForm] = useState(false);
    const [seqForm, setSeqForm] = useState({ name: '', description: '' });
    const [expandedSeq, setExpandedSeq] = useState<number | null>(null);
    const [seqSteps, setSeqSteps] = useState<Record<number, SequenceStep[]>>({});
    const [loadingSeqSteps, setLoadingSeqSteps] = useState<number[]>([]);
    const [seqStepErrors, setSeqStepErrors] = useState<Record<number, string>>({});
    const [sequenceBusyId, setSequenceBusyId] = useState<number | null>(null);
    const [newStep, setNewStep] = useState({ messageTemplate: '', delayMinutes: 60, useAiPersonalization: false });
    const sequenceTenantRef = useRef<number | null>(currentInstanceId);
    sequenceTenantRef.current = currentInstanceId;

    const closeWizard = useCallback(() => {
        if (savingTriggerRef.current) return;
        if (editingTriggerId !== null && !window.confirm('Закрыть редактирование без сохранения изменений?')) return;
        setWizardOpen(false);
    }, [editingTriggerId]);

    const loadData = useCallback(async () => {
        if (!currentInstanceId) return;
        const requestedTenant = currentInstanceId;
        setLoading(true);
        setOperationError('');
        try {
            const [tRes, sRes, lRes, settingsRes] = await Promise.all([
                getTriggers(requestedTenant), getSequences(requestedTenant), getTriggerLog(requestedTenant), getTriggerSettings(requestedTenant),
            ]);
            if (sequenceTenantRef.current !== requestedTenant) return;
            if (tRes.success) setTriggers(tRes.triggers || []);
            if (sRes.success) setSequences(sRes.sequences || []);
            if (lRes.success) setLog(lRes.log || []);
            if (settingsRes.success) setMasterEnabled(Boolean(settingsRes.smartTriggersEnabled));
        } catch { if (sequenceTenantRef.current === requestedTenant) setOperationError('Не удалось обновить сценарии. Сохранённые правила не изменены. Повторите загрузку.'); }
        if (sequenceTenantRef.current === requestedTenant) setLoading(false);
    }, [currentInstanceId]);

    useEffect(() => {
        setExpandedSeq(null);
        setSeqSteps({});
        setLoadingSeqSteps([]);
        setSeqStepErrors({});
        if (currentInstanceId) loadData();
    }, [currentInstanceId, loadData]);
    useEffect(() => {
        previewAbortRef.current?.abort();
        setPreviewTriggerId(null); setPreviewText(''); setPreviewResult(null); setPreviewError(''); setPreviewBusy(false);
        return () => previewAbortRef.current?.abort();
    }, [currentInstanceId]);
    useEffect(() => {
        if (!wizardOpen) return;
        const dialog = wizardRef.current;
        dialog?.querySelector<HTMLButtonElement>('[data-wizard-close]')?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); closeWizard(); return; }
            if (event.key !== 'Tab' || !dialog) return;
            const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'))
                .filter(element => element.getClientRects().length > 0);
            const first = controls[0], last = controls[controls.length - 1];
            if (!first || !last) return;
            if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
                event.preventDefault(); last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
                event.preventDefault(); first.focus();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => { document.removeEventListener('keydown', onKeyDown); wizardTriggerRef.current?.focus(); };
    }, [wizardOpen, closeWizard]);

    // --- Data loading ---
    // --- Wizard: build JSON from visual form & create ---
    const openWizard = () => {
        wizardTriggerRef.current = document.activeElement as HTMLElement | null;
        setEditingTriggerId(null); setOperationError('');
        setWizardOpen(true); setWizardStep(0);
        setTriggerName(''); setTriggerType('silence'); setActionType('send_message');
        setCond(defaultCondition()); setAct(defaultAction());
        setCooldownMinutes(60); setMaxExecutions(0);
    };

    const openEditWizard = (trigger: Trigger) => {
        if (!canEdit) return;
        wizardTriggerRef.current = document.activeElement as HTMLElement | null;
        setEditingTriggerId(trigger.id); setOperationError('');
        setTriggerName(trigger.name); setTriggerType(trigger.triggerType); setActionType(trigger.actionType);
        setCond(hydrateConditions(trigger.conditions)); setAct(hydrateAction(trigger.actionData));
        setCooldownMinutes(trigger.cooldownMinutes); setMaxExecutions(trigger.maxExecutions);
        setWizardStep(0); setWizardOpen(true);
    };

    const buildConditionsJSON = (): any => {
        switch (triggerType) {
            case 'silence': return cond.statuses.length > 0
                ? { silenceHours: cond.silenceHours, statuses: cond.statuses }
                : { silenceHours: cond.silenceHours };
            case 'keyword': return { keywords: cond.keywords };
            case 'status_change': return { targetStatus: cond.targetStatus };
            case 'new_lead': return {};
            case 'time_based': return { hour: cond.hour, days: cond.days };
            case 'sentiment': return { threshold: cond.sentimentThreshold / 100 };
            default: return {};
        }
    };

    const buildActionJSON = (): any => {
        switch (actionType) {
            case 'send_message': return { message: act.message };
            case 'change_status': return { status: act.status };
            case 'notify_manager': return {};
            case 'start_sequence': return { sequenceId: act.sequenceId };
            case 'send_offer': return {};
            default: return {};
        }
    };

    const autoName = (): string => {
        const tt = TRIGGER_TYPES.find(t => t.id === triggerType);
        const at = ACTION_TYPES.find(a => a.id === actionType);
        return `${tt?.label || triggerType} → ${at?.label || actionType}`;
    };

    const handleSaveTrigger = async () => {
        if (!currentInstanceId || !canEdit || savingTriggerRef.current) return;
        savingTriggerRef.current = true;
        setSavingTrigger(true); setOperationError('');
        const name = triggerName.trim() || autoName();
        try {
            const payload = {
                name, triggerType, actionType,
                conditions: buildConditionsJSON(), actionData: buildActionJSON(),
                cooldownMinutes, maxExecutions,
            };
            const res = editingTriggerId === null
                ? await createTrigger(currentInstanceId, { ...payload, priority: 0 })
                : await updateTrigger(currentInstanceId, editingTriggerId, payload);
            if (res.success && res.trigger) {
                if (editingTriggerId === null) setTriggers(prev => [...prev, res.trigger]);
                else setTriggers(prev => prev.map(trigger => trigger.id === editingTriggerId ? res.trigger : trigger));
                setWizardOpen(false);
            } else setOperationError('Не удалось сохранить триггер. Проверьте условия и попробуйте ещё раз.');
        } catch { setOperationError('Не удалось сохранить сценарий. Введённые условия сохранены — повторите попытку.'); }
        savingTriggerRef.current = false;
        setSavingTrigger(false);
    };

    const handleToggleTrigger = async (trigger: Trigger) => {
        if (!currentInstanceId || !canEdit || triggerLock.current) return;
        triggerLock.current = true; setTriggerBusyId(trigger.id); setOperationError('');
        const requestedTenant = currentInstanceId;
        const isActive = trigger.isActive ? 0 : 1;
        try {
            const result = await updateTrigger(requestedTenant, trigger.id, { isActive });
            if (!result.success) throw new Error('Update not confirmed');
            if (sequenceTenantRef.current === requestedTenant) setTriggers(previous => previous.map(item => item.id === trigger.id ? { ...item, isActive } : item));
        } catch { if (sequenceTenantRef.current === requestedTenant) setOperationError('Не удалось изменить сценарий. Проверьте состояние перед повторной попыткой.'); }
        finally { triggerLock.current = false; if (sequenceTenantRef.current === requestedTenant) setTriggerBusyId(null); }
    };

    const handleMasterToggle = async () => {
        if (!currentInstanceId || !canEdit) return;
        if (!masterEnabled && !window.confirm(`Включить автоматизацию для этого бизнеса? ${triggers.filter(t => t.isActive).length} активных правил смогут отправлять сообщения клиентам при наступлении условий.`)) return;
        setMasterBusy(true);
        setMasterError('');
        try {
            const result = await updateTriggerSettings(currentInstanceId, !masterEnabled);
            if (!result.success) throw new Error('settings_failed');
            setMasterEnabled(Boolean(result.smartTriggersEnabled));
        } catch {
            setMasterError('Не удалось изменить состояние автоматизации. Попробуйте ещё раз.');
        } finally { setMasterBusy(false); }
    };

    const handleDeleteTrigger = async (id: number) => {
        if (!currentInstanceId || !canEdit || triggerLock.current || !confirm('Удалить этот сценарий?')) return;
        const requestedTenant = currentInstanceId;
        triggerLock.current = true; setTriggerBusyId(id); setOperationError('');
        try {
            const result = await deleteTrigger(requestedTenant, id);
            if (!result.success) throw new Error('Delete not confirmed');
            if (sequenceTenantRef.current === requestedTenant) setTriggers(previous => previous.filter(item => item.id !== id));
        } catch { if (sequenceTenantRef.current === requestedTenant) setOperationError('Не удалось удалить сценарий. Он остаётся в списке; обновите состояние перед повторной попыткой.'); }
        finally { triggerLock.current = false; if (sequenceTenantRef.current === requestedTenant) setTriggerBusyId(null); }
    };

    const openPreview = (id: number) => {
        previewAbortRef.current?.abort();
        setPreviewTriggerId(previous => previous === id ? null : id);
        setPreviewText(''); setPreviewResult(null); setPreviewError(''); setPreviewBusy(false);
    };

    const runPreview = async () => {
        if (!currentInstanceId || previewTriggerId === null || !previewText.trim() || previewBusy) return;
        const controller = new AbortController();
        previewAbortRef.current?.abort();
        previewAbortRef.current = controller;
        setPreviewBusy(true); setPreviewError(''); setPreviewResult(null);
        try {
            const response = await fetch(`/api/businesses/${currentInstanceId}/triggers/${previewTriggerId}/preview`, {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sampleText: previewText }), signal: controller.signal,
            });
            if (!response.ok) throw new Error('preview_failed');
            const result: { success?: boolean; matched?: boolean; matchedKeyword?: string | null; dryRun?: boolean; actionExecuted?: boolean } = await response.json();
            if (!result.success || result.dryRun !== true || result.actionExecuted !== false
                || typeof result.matched !== 'boolean') throw new Error('invalid_preview');
            if (!controller.signal.aborted) setPreviewResult({ matched: result.matched, matchedKeyword: result.matchedKeyword || null });
        } catch {
            if (!controller.signal.aborted) setPreviewError('Не удалось проверить фразу. Повторите попытку.');
        } finally {
            if (!controller.signal.aborted) setPreviewBusy(false);
        }
    };

    // --- Sequences ---
    const handleCreateSequence = async () => {
        if (!currentInstanceId || !seqForm.name) return;
        const requestedTenant = currentInstanceId;
        const res = await createSequence(requestedTenant, seqForm);
        if (sequenceTenantRef.current === requestedTenant && res.success) { setSequences(prev => [...prev, res.sequence]); setShowSeqForm(false); setSeqForm({ name: '', description: '' }); }
    };
    const handleDeleteSequence = async (id: number) => {
        const unfinished = sequences.find(sequence => sequence.id === id)?.unfinishedEnrollmentCount || 0;
        if (!currentInstanceId || !window.confirm(`Удалить цепочку? Это также удалит ${unfinished} незавершённых прохождений клиентов и остановит их сообщения. Продолжить?`)) return;
        const requestedTenant = currentInstanceId;
        const res = await deleteSequence(requestedTenant, id);
        if (sequenceTenantRef.current === requestedTenant && res.success) setSequences(prev => prev.filter(s => s.id !== id));
    };
    const handleToggleSequence = async (sequence: Sequence) => {
        if (!currentInstanceId || !canEdit || sequenceBusyId !== null) return;
        const nextState = sequence.isActive ? 0 : 1;
        if (nextState && sequence.unfinishedEnrollmentCount && !window.confirm(
            `Включить цепочку «${sequence.name}»? ${sequence.unfinishedEnrollmentCount} клиентов продолжат прохождение; просроченные сообщения могут отправиться сразу.`
        )) return;
        const requestedTenant = currentInstanceId;
        setSequenceBusyId(sequence.id);
        setOperationError('');
        try {
            const result = await updateSequence(requestedTenant, sequence.id, { isActive: nextState });
            if (sequenceTenantRef.current !== requestedTenant) return;
            if (!result.success) throw new Error('sequence_update_failed');
            setSequences(previous => previous.map(item => item.id === sequence.id
                ? { ...item, isActive: nextState } : item));
        } catch {
            if (sequenceTenantRef.current === requestedTenant) {
                setOperationError('Не удалось изменить состояние цепочки. Повторите попытку.');
            }
        } finally {
            if (sequenceTenantRef.current === requestedTenant) setSequenceBusyId(null);
        }
    };
    const loadSteps = async (seqId: number) => {
        if (!currentInstanceId) return;
        const requestedTenant = currentInstanceId;
        setLoadingSeqSteps(prev => prev.includes(seqId) ? prev : [...prev, seqId]);
        setSeqStepErrors(prev => ({ ...prev, [seqId]: '' }));
        try {
            const res = await getSequenceSteps(requestedTenant, seqId);
            if (sequenceTenantRef.current !== requestedTenant) return;
            if (!res.success) throw new Error('steps_unavailable');
            setSeqSteps(prev => ({ ...prev, [seqId]: res.steps || [] }));
            if (typeof res.unfinishedEnrollmentCount === 'number') {
                setSequences(prev => prev.map(sequence => sequence.id === seqId
                    ? { ...sequence, unfinishedEnrollmentCount: res.unfinishedEnrollmentCount } : sequence));
            }
        } catch {
            if (sequenceTenantRef.current === requestedTenant) {
                setSeqStepErrors(prev => ({ ...prev, [seqId]: 'Не удалось загрузить шаги. Проверьте подключение и повторите.' }));
            }
        } finally {
            if (sequenceTenantRef.current === requestedTenant) {
                setLoadingSeqSteps(prev => prev.filter(id => id !== seqId));
            }
        }
    };
    const handleAddStep = async (seqId: number) => {
        if (!currentInstanceId || !newStep.messageTemplate) return;
        if ((sequences.find(sequence => sequence.id === seqId)?.unfinishedEnrollmentCount || 0) > 0) return;
        const requestedTenant = currentInstanceId;
        try {
            const res = await addSequenceStep(requestedTenant, seqId, { ...newStep, useAiPersonalization: newStep.useAiPersonalization ? 1 : 0 });
            if (sequenceTenantRef.current !== requestedTenant) return;
            if (!res.success) throw new Error('step_add_failed');
            await loadSteps(seqId);
            setNewStep({ messageTemplate: '', delayMinutes: 60, useAiPersonalization: false });
        } catch (error) {
            if (sequenceTenantRef.current === requestedTenant) {
                const locked = (error as { response?: { status?: number } }).response?.status === 409;
                setSeqStepErrors(prev => ({ ...prev, [seqId]: locked
                    ? 'Шаги заблокированы: в цепочке есть незавершённые клиенты. Дождитесь завершения их прохождений.'
                    : 'Не удалось добавить шаг. Проверьте подключение и повторите.' }));
                if (locked) void loadData();
            }
        }
    };
    const handleDeleteStep = async (seqId: number, stepId: number) => {
        if (!currentInstanceId || (sequences.find(sequence => sequence.id === seqId)?.unfinishedEnrollmentCount || 0) > 0
            || !window.confirm('Удалить этот сохранённый шаг? Действие нельзя отменить.')) return;
        const requestedTenant = currentInstanceId;
        try {
            const res = await deleteSequenceStep(requestedTenant, seqId, stepId);
            if (sequenceTenantRef.current !== requestedTenant) return;
            if (!res.success) throw new Error('step_delete_failed');
            await loadSteps(seqId);
        } catch (error) {
            if (sequenceTenantRef.current === requestedTenant) {
                const locked = (error as { response?: { status?: number } }).response?.status === 409;
                setSeqStepErrors(prev => ({ ...prev, [seqId]: locked
                    ? 'Шаги заблокированы: в цепочке есть незавершённые клиенты. Дождитесь завершения их прохождений.'
                    : 'Не удалось удалить шаг. Обновите цепочку и повторите.' }));
                if (locked) void loadData();
            }
        }
    };

    // --- Guard ---
    if (!currentInstanceId) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-center">
                <AlertCircle size={40} className="text-[#8b8fa3] mb-4" />
                <h2 className="text-xl font-bold text-white mb-2">Выберите бизнес</h2>
            </div>
        );
    }

    // =============================================
    // Render
    // =============================================
    return (
        <div className="ava-automation max-w-6xl mx-auto pb-10">
            {/* Header */}
            <div className="ava-automation-heading mb-6">
                <p className="ava-automation-eyebrow">ОПЕРАЦИИ / АВТОМАТИЗАЦИЯ</p>
                <h1 className="text-2xl font-bold text-white flex items-center gap-3">
                    <Zap size={28} className="text-amber-400" />
                    Автоматизация
                </h1>
                <p className="text-[#8b8fa3] mt-1 text-sm">Триггеры срабатывают на события, цепочки отправляют серию сообщений</p>
            </div>

            <section className="ava-automation-master" aria-label="Состояние автоматизации">
                <div><strong>{masterEnabled ? 'Автоматизация включена' : 'Автоматизация выключена'}</strong>
                    <p>{masterEnabled ? 'Активные правила могут выполняться и отправлять сообщения по условиям.' : 'Правила и цепочки можно подготовить, но они не будут исполняться до включения.'}</p></div>
                {canEdit && <button type="button" onClick={() => void handleMasterToggle()} disabled={masterBusy} aria-pressed={masterEnabled}>{masterBusy ? 'Сохраняем…' : masterEnabled ? 'Выключить' : 'Включить'}</button>}
            </section>
            {masterError && <p role="alert" className="ava-automation-error">{masterError}</p>}
            {operationError && !wizardOpen && <p role="alert" className="ava-automation-error">{operationError} <button type="button" className="btn-secondary" disabled={loading} onClick={() => void loadData()}>Обновить сценарии</button></p>}

            <section className="ava-automation-overview" aria-label="Сводка автоматизации">
                <article><span>Правила</span><strong>{triggers.length}</strong><small>{triggers.filter(trigger => Boolean(trigger.isActive)).length} включено</small></article>
                <article><span>Цепочки сообщений</span><strong>{sequences.length}</strong><small>Сохранённые последовательности</small></article>
                <article><span>Выполнения</span><strong>{log.length}</strong><small>Записи в загруженной истории</small></article>
            </section>

            {/* Tabs */}
            <nav className="ava-automation-tabs mb-6" aria-label="Разделы автоматизации">
                {([['triggers', 'Триггеры', triggers.length], ['sequences', 'Цепочки', sequences.length], ['log', 'История', log.length]] as const).map(([key, label, count]) => (
                    <button key={key} type="button" onClick={() => setTab(key)} aria-pressed={tab === key}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === key ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-[#22262f] text-[#8b8fa3] border border-[#2a2e3a] hover:text-white'}`}>
                        {label}
                        <span className="ava-automation-tab-count" aria-label={`${count} записей`}>{count}</span>
                    </button>
                ))}
            </nav>

            {loading && <div className="flex justify-center py-12"><Loader2 size={28} className="animate-spin text-amber-400" /></div>}

            {/* ===== TRIGGERS TAB ===== */}
            {!loading && tab === 'triggers' && (
                <div>
                    <div className="flex justify-between items-center mb-4">
                        <span className="text-sm text-[#8b8fa3]">{triggers.length} триггер(ов)</span>
                        <button onClick={openWizard} disabled={!canEdit} title={!canEdit ? 'Доступно владельцу бизнеса' : undefined} className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 text-amber-400 rounded-lg hover:bg-amber-500/20 border border-amber-500/20 text-sm font-medium disabled:opacity-50">
                            <Plus size={16} /> Новый триггер
                        </button>
                    </div>

                    {/* Trigger cards */}
                    <div className="space-y-3">
                        {triggers.map(trigger => {
                            const tt = TRIGGER_TYPES.find(t => t.id === trigger.triggerType);
                            const at = ACTION_TYPES.find(a => a.id === trigger.actionType);
                            const condText = parseTriggerConditions(trigger.triggerType, trigger.conditions, leadStatuses);
                            const actText = parseTriggerAction(trigger.actionType, trigger.actionData, leadStatuses);
                            return (
                                <div key={trigger.id} className={`card overflow-hidden transition-opacity ${trigger.isActive || previewTriggerId === trigger.id ? '' : 'opacity-50'}`}>
                                    <div className="card-body">
                                        <div className="flex flex-wrap sm:flex-nowrap items-start gap-4">
                                            {/* Icon */}
                                            <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
                                                style={{ backgroundColor: (tt?.color || '#f59e0b') + '18' }}>
                                                {tt?.icon || <Zap size={20} aria-hidden="true" />}
                                            </div>
                                            {/* Info */}
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <h3 className="text-white font-semibold text-sm truncate">{trigger.name}</h3>
                                                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${trigger.isActive ? 'bg-green-500/15 text-green-400' : 'bg-[#2a2e3a] text-[#6b6f80]'}`}>
                                                        {trigger.isActive ? 'Вкл' : 'Выкл'}
                                                    </span>
                                                </div>
                                                {/* Visual pipeline */}
                                                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                                    <span className="px-2 py-0.5 rounded-md bg-[#22262f] text-[#c4c7d0] border border-[#2a2e3a]">
                                                        {tt?.icon} {condText || tt?.label}
                                                    </span>
                                                    <ArrowRight size={12} className="text-[#6b6f80]" />
                                                    <span className="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/20">
                                                        {at?.icon} {actText || at?.label}
                                                    </span>
                                                </div>
                                                {/* Meta */}
                                                {trigger.cooldownMinutes > 0 && (
                                                    <p className="text-[10px] text-[#6b6f80] mt-1.5 flex items-center gap-1">
                                                        <Clock size={10} />
                                                        Не чаще 1 раза в {trigger.cooldownMinutes >= 60 ? `${Math.round(trigger.cooldownMinutes / 60)}ч` : `${trigger.cooldownMinutes}мин`}
                                                        {trigger.maxExecutions > 0 && <span> · макс. {trigger.maxExecutions} раз</span>}
                                                    </p>
                                                )}
                                            </div>
                                            {/* Actions */}
                                            <div className="flex items-center gap-1 flex-shrink-0">
                                                {trigger.triggerType === 'keyword' && <button type="button" onClick={() => openPreview(trigger.id)}
                                                    className="ava-trigger-preview-toggle" aria-expanded={previewTriggerId === trigger.id}
                                                    aria-controls={`ava-trigger-preview-${trigger.id}`} aria-label={`Проверить триггер ${trigger.name}`}>
                                                    Проверить
                                                </button>}
                                                {canEdit && <button type="button" onClick={() => openEditWizard(trigger)} className="min-w-11 min-h-11 p-2 flex items-center justify-center hover:bg-[#2a2e3a] rounded-lg transition-colors text-[#8b8fa3] hover:text-white" title="Редактировать" aria-label={`Редактировать триггер ${trigger.name}`}>
                                                    <Pencil size={16} aria-hidden="true" />
                                                </button>}
                                                <button onClick={() => handleToggleTrigger(trigger)} disabled={!canEdit || triggerBusyId !== null} className="min-w-11 min-h-11 p-2 flex items-center justify-center hover:bg-[#2a2e3a] rounded-lg transition-colors disabled:opacity-50" title={trigger.isActive ? 'Выключить' : 'Включить'} aria-label={`${trigger.isActive ? 'Выключить' : 'Включить'} триггер ${trigger.name}`}>
                                                    {trigger.isActive ? <Eye size={16} className="text-green-400" /> : <EyeOff size={16} className="text-[#6b6f80]" />}
                                                </button>
                                                <button onClick={() => handleDeleteTrigger(trigger.id)} disabled={!canEdit || triggerBusyId !== null} className="min-w-11 min-h-11 p-2 flex items-center justify-center hover:bg-red-500/10 rounded-lg transition-colors text-[#6b6f80] hover:text-red-400 disabled:opacity-50" aria-label={`Удалить триггер ${trigger.name}`}>
                                                    <Trash2 size={16} />
                                                </button>
                                            </div>
                                        </div>
                                        {trigger.triggerType === 'keyword' && previewTriggerId === trigger.id && (
                                            <form id={`ava-trigger-preview-${trigger.id}`} className="ava-trigger-preview" onSubmit={event => { event.preventDefault(); void runPreview(); }}>
                                                <label htmlFor={`ava-trigger-sample-${trigger.id}`}>Проверка на примере сообщения</label>
                                                <p>Введите фразу клиента. Покажем только совпадение с сохранёнными словами — ничего не отправим и не запустим.</p>
                                                <div className="ava-trigger-preview-controls">
                                                    <input id={`ava-trigger-sample-${trigger.id}`} type="text" maxLength={2000}
                                                        value={previewText} onChange={event => { setPreviewText(event.target.value); setPreviewResult(null); setPreviewError(''); }}
                                                        placeholder="Например: Сколько стоит номер?" autoComplete="off" />
                                                    <button type="submit" disabled={!previewText.trim() || previewBusy}>{previewBusy ? 'Проверяем…' : 'Проверить фразу'}</button>
                                                </div>
                                                {previewError && <p role="alert" className="ava-trigger-preview-error">{previewError}</p>}
                                                {previewResult && <p role="status" className={`ava-trigger-preview-result ${previewResult.matched ? 'is-match' : 'is-no-match'}`}>
                                                    {previewResult.matched
                                                        ? `Совпадение: «${previewResult.matchedKeyword}». Действие не выполнялось.`
                                                        : 'Совпадений нет. Действие не выполнялось.'}
                                                </p>}
                                            </form>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                        {triggers.length === 0 && !wizardOpen && (
                            <div className="text-center py-16 border-2 border-dashed border-[#2a2e3a] rounded-xl">
                                <Zap size={40} className="mx-auto text-[#3a3e4a] mb-3" />
                                <h3 className="text-white font-semibold mb-1">Нет триггеров</h3>
                                <p className="text-sm text-[#8b8fa3] mb-4">Создайте первый триггер — бот будет автоматически реагировать на события</p>
                                <button onClick={openWizard} disabled={!canEdit} className="inline-flex items-center gap-2 px-5 py-2.5 bg-amber-500/10 text-amber-400 rounded-xl hover:bg-amber-500/20 border border-amber-500/20 text-sm font-medium disabled:opacity-50">
                                    <Plus size={16} /> Создать триггер
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ===== WIZARD MODAL ===== */}
            {wizardOpen && (
                <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={closeWizard}>
                    <div ref={wizardRef} role="dialog" aria-modal="true" aria-labelledby="ava-trigger-wizard-title" aria-busy={savingTrigger} className="bg-[#1a1d27] rounded-2xl border border-[#2a2e3a] w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
                        {/* Wizard header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-[#2a2e3a]">
                            <div>
                                <h2 id="ava-trigger-wizard-title" className="text-lg font-bold text-white">{editingTriggerId === null ? 'Новый триггер' : 'Редактировать триггер'}</h2>
                                <p className="text-xs text-[#8b8fa3]">Шаг {wizardStep + 1} из 4</p>
                            </div>
                            <button type="button" data-wizard-close aria-label="Закрыть мастер триггера" disabled={savingTrigger} onClick={closeWizard} className="min-w-11 min-h-11 p-2 flex items-center justify-center hover:bg-[#22262f] rounded-lg text-[#8b8fa3] hover:text-white disabled:opacity-50"><X size={18} aria-hidden="true" /></button>
                        </div>

                        {/* Progress */}
                        <div className="px-6 pt-4 pb-2">
                            <div className="flex gap-1">
                                {['Событие', 'Условия', 'Действие', 'Финал'].map((s, i) => (
                                    <div key={i} className="flex-1">
                                        <div className={`h-1.5 rounded-full transition-all ${i <= wizardStep ? 'bg-amber-400' : 'bg-[#2a2e3a]'}`} />
                                        <p className={`text-[10px] mt-1 ${i <= wizardStep ? 'text-amber-400' : 'text-[#6b6f80]'}`}>{s}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                        {operationError && <p role="alert" className="ava-automation-error mx-6 mt-2">{operationError}</p>}

                        <div className="px-6 py-5">
                            {/* STEP 0: Choose trigger type */}
                            {wizardStep === 0 && (
                                <div>
                                    <h3 className="text-white font-semibold mb-1">Когда это должно сработать?</h3>
                                    <p className="text-xs text-[#8b8fa3] mb-4">Выберите событие, которое запустит автоматическое действие</p>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        {TRIGGER_TYPES.map(t => (
                                            <button key={t.id} type="button" aria-pressed={triggerType === t.id} onClick={() => { if (triggerType !== t.id) { setTriggerType(t.id); setCond(defaultCondition()); } }}
                                                className={`flex items-start gap-3 p-4 rounded-xl border text-left transition-all ${triggerType === t.id ? 'border-amber-500/50 bg-amber-500/5' : 'border-[#2a2e3a] bg-[#22262f] hover:border-[#3a3e4a]'}`}>
                                                <span className="text-2xl">{t.icon}</span>
                                                <div>
                                                    <p className={`font-medium text-sm ${triggerType === t.id ? 'text-amber-400' : 'text-white'}`}>{t.label}</p>
                                                    <p className="text-[11px] text-[#8b8fa3] mt-0.5">{t.desc}</p>
                                                </div>
                                                {triggerType === t.id && <Check size={16} className="text-amber-400 ml-auto mt-1 flex-shrink-0" />}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* STEP 1: Conditions (visual!) */}
                            {wizardStep === 1 && (
                                <div>
                                    <h3 className="text-white font-semibold mb-1">Настройте условия</h3>
                                    <p className="text-xs text-[#8b8fa3] mb-5">Уточните, при каких именно обстоятельствах сработает триггер</p>

                                    {triggerType === 'silence' && (
                                        <div className="space-y-5">
                                            <div>
                                                <label className="label" htmlFor="trigger-silenceHours">Сколько часов клиент молчит?</label>
                                                <div className="flex items-center gap-4">
                                                    <input id="trigger-silenceHours" aria-label="Часы молчания клиента" type="range" min={1} max={168} value={cond.silenceHours}
                                                        onChange={e => setCond({ ...cond, silenceHours: Number(e.target.value) })}
                                                        className="flex-1 accent-amber-400" />
                                                    <div className="w-20 text-center">
                                                        <span className="text-2xl font-bold text-amber-400">{cond.silenceHours}</span>
                                                        <span className="text-xs text-[#8b8fa3] ml-1">ч</span>
                                                    </div>
                                                </div>
                                                <div className="flex justify-between text-[10px] text-[#6b6f80] mt-1">
                                                    <span>1 час</span><span>1 день</span><span>3 дня</span><span>1 неделя</span>
                                                </div>
                                            </div>
                                            <div>
                                                <label className="label">Только для лидов в статусах (необязательно)</label>
                                                <div className="flex flex-wrap gap-2 mt-1">
                                                    {leadStatuses.map(s => {
                                                        const sel = cond.statuses.includes(s.id);
                                                        return (
                                                            <button key={s.id} onClick={() => setCond({ ...cond, statuses: sel ? cond.statuses.filter(x => x !== s.id) : [...cond.statuses, s.id] })}
                                                                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${sel ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-[#2a2e3a] bg-[#22262f] text-[#8b8fa3] hover:text-white'}`}>
                                                                <span className="w-2 h-2 rounded-full inline-block mr-1.5" style={{ backgroundColor: s.color }} />
                                                                {s.label}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                                <p className="text-[10px] text-[#6b6f80] mt-1.5">Если не выбрать — сработает для всех статусов</p>
                                            </div>
                                        </div>
                                    )}

                                    {triggerType === 'keyword' && (
                                        <div className="space-y-4">
                                            <div>
                                                <label className="label">Ключевые слова / фразы</label>
                                                <p className="text-[10px] text-[#6b6f80] mb-2">Триггер сработает если клиент напишет одно из этих слов</p>
                                                <div className="flex gap-2">
                                                    <input className="input flex-1" value={cond.keywordInput} placeholder="Введите слово и нажмите Enter или +"
                                                        onChange={e => setCond({ ...cond, keywordInput: e.target.value })}
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter' && cond.keywordInput.trim()) {
                                                                e.preventDefault();
                                                                setCond({ ...cond, keywords: [...cond.keywords, cond.keywordInput.trim()], keywordInput: '' });
                                                            }
                                                        }} />
                                                    <button onClick={() => { if (cond.keywordInput.trim()) setCond({ ...cond, keywords: [...cond.keywords, cond.keywordInput.trim()], keywordInput: '' }); }}
                                                        className="px-3 py-2 bg-amber-500/10 text-amber-400 rounded-lg border border-amber-500/20 hover:bg-amber-500/20" disabled={!cond.keywordInput.trim()}>
                                                        <Plus size={16} />
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="flex flex-wrap gap-2 min-h-[36px]">
                                                {cond.keywords.map((kw, i) => (
                                                    <span key={i} className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-500/15 text-purple-300 rounded-lg text-xs font-medium border border-purple-500/20">
                                                        🔑 {kw}
                                                        <button onClick={() => setCond({ ...cond, keywords: cond.keywords.filter((_, j) => j !== i) })} className="text-purple-400 hover:text-white"><X size={12} /></button>
                                                    </span>
                                                ))}
                                                {cond.keywords.length === 0 && <span className="text-xs text-[#6b6f80] italic">Добавьте хотя бы одно слово</span>}
                                            </div>
                                            <div className="bg-purple-500/5 border border-purple-500/15 rounded-xl px-4 py-3">
                                                <p className="text-xs text-purple-300/80">
                                                    <Info size={12} className="inline mr-1" />
                                                    Поиск нечувствителен к регистру. Например «цена» сработает и на «Цена» и на «ЦЕНА»
                                                </p>
                                            </div>
                                        </div>
                                    )}

                                    {triggerType === 'status_change' && (
                                        <div>
                                            <label className="label">Когда лид переходит в статус:</label>
                                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2">
                                                {leadStatuses.map(s => (
                                                    <button key={s.id} onClick={() => setCond({ ...cond, targetStatus: s.id })}
                                                        className={`flex items-center gap-2 p-3 rounded-xl border transition-all text-left ${cond.targetStatus === s.id ? 'border-amber-500/40 bg-amber-500/5' : 'border-[#2a2e3a] bg-[#22262f] hover:border-[#3a3e4a]'}`}>
                                                        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                                                        <span className={`text-sm ${cond.targetStatus === s.id ? 'text-amber-300 font-medium' : 'text-white'}`}>{s.label}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {triggerType === 'new_lead' && (
                                        <div className="bg-green-500/5 border border-green-500/15 rounded-xl px-5 py-6 text-center">
                                            <span className="text-4xl">🆕</span>
                                            <p className="text-white font-medium mt-3">Сработает при появлении нового клиента</p>
                                            <p className="text-xs text-[#8b8fa3] mt-1">Дополнительных настроек не требуется</p>
                                        </div>
                                    )}

                                    {triggerType === 'time_based' && (
                                        <div className="space-y-5">
                                            <div>
                                                <label className="label">В какой час отправлять? (по серверному времени)</label>
                                                <div className="flex items-center gap-4">
                                                    <input id="trigger-hour" aria-label="Час отправки" type="range" min={0} max={23} value={cond.hour}
                                                        onChange={e => setCond({ ...cond, hour: Number(e.target.value) })}
                                                        className="flex-1 accent-cyan-400" />
                                                    <div className="w-24 text-center bg-[#22262f] rounded-xl py-2 border border-[#2a2e3a]">
                                                        <span className="text-2xl font-bold text-cyan-400">{String(cond.hour).padStart(2, '0')}:00</span>
                                                    </div>
                                                </div>
                                            </div>
                                            <div>
                                                <label className="label">В какие дни?</label>
                                                <div className="flex flex-wrap gap-2 mt-1" role="group" aria-label="Дни отправки">
                                                    {DAY_NAMES.map((name, i) => {
                                                        const sel = cond.days.includes(i);
                                                        return (
                                                            <button key={i} type="button" aria-pressed={sel} onClick={() => setCond({ ...cond, days: sel ? cond.days.filter(d => d !== i) : [...cond.days, i] })}
                                                                className={`w-11 h-11 rounded-xl text-xs font-bold transition-all ${sel ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' : 'bg-[#22262f] text-[#6b6f80] border-[#2a2e3a]'} border`}>
                                                                {name}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                                <div className="flex gap-2 mt-2">
                                                    <button onClick={() => setCond({ ...cond, days: [1,2,3,4,5] })} className="text-[10px] text-cyan-400 hover:underline">Будни</button>
                                                    <button onClick={() => setCond({ ...cond, days: [0,6] })} className="text-[10px] text-cyan-400 hover:underline">Выходные</button>
                                                    <button onClick={() => setCond({ ...cond, days: [0,1,2,3,4,5,6] })} className="text-[10px] text-cyan-400 hover:underline">Каждый день</button>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {triggerType === 'sentiment' && (
                                        <div className="space-y-4">
                                            <div>
                                                <label className="label">Порог настроения клиента</label>
                                                <p className="text-[10px] text-[#6b6f80] mb-3">Триггер сработает если оценка настроения клиента опустится ниже этого значения</p>
                                                <div className="flex items-center gap-4">
                                                    <input id="trigger-sentimentThreshold" aria-label="Порог настроения клиента" type="range" min={5} max={80} value={cond.sentimentThreshold}
                                                        onChange={e => setCond({ ...cond, sentimentThreshold: Number(e.target.value) })}
                                                        className="flex-1 accent-red-400" />
                                                    <div className="w-20 text-center">
                                                        <span className="text-2xl font-bold text-red-400">{cond.sentimentThreshold}%</span>
                                                    </div>
                                                </div>
                                                <div className="flex justify-between text-[10px] text-[#6b6f80] mt-1">
                                                    <span>😡 Очень плохо</span><span>😐 Нейтрально</span><span>😊 Хорошо</span>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* STEP 2: Action (visual!) */}
                            {wizardStep === 2 && (
                                <div>
                                    <h3 className="text-white font-semibold mb-1">Что сделать?</h3>
                                    <p className="text-xs text-[#8b8fa3] mb-4">Выберите действие, которое выполнится при срабатывании</p>

                                    {/* Action type selector */}
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-5">
                                        {ACTION_TYPES.map(a => (
                                            <button key={a.id} type="button" aria-pressed={actionType === a.id} onClick={() => { if (actionType !== a.id) { setActionType(a.id); setAct(defaultAction()); } }}
                                                className={`flex items-center gap-3 p-3 rounded-xl border transition-all text-left ${actionType === a.id ? 'border-amber-500/40 bg-amber-500/5' : 'border-[#2a2e3a] bg-[#22262f] hover:border-[#3a3e4a]'}`}>
                                                <span className="text-lg">{a.icon}</span>
                                                <div>
                                                    <p className={`text-sm font-medium ${actionType === a.id ? 'text-amber-300' : 'text-white'}`}>{a.label}</p>
                                                    <p className="text-[10px] text-[#8b8fa3]">{a.desc}</p>
                                                </div>
                                            </button>
                                        ))}
                                    </div>

                                    {/* Action-specific fields */}
                                    {actionType === 'send_message' && (
                                        <div className="space-y-3">
                                            <div>
                                                <label className="label">Текст сообщения</label>
                                                <textarea className="input h-28" value={act.message} onChange={e => setAct({ ...act, message: e.target.value })}
                                                    placeholder="Здравствуйте! Остались ли у вас вопросы? Буду рад помочь 😊" />
                                            </div>
                                            <div>
                                                <p className="text-[10px] text-[#8b8fa3] mb-1.5">Вставить переменную:</p>
                                                <div className="flex gap-2">
                                                    {[{ tag: '{clientName}', label: 'Имя клиента' }].map(v => (
                                                        <button key={v.tag} onClick={() => setAct({ ...act, message: act.message + v.tag })}
                                                            className="px-2.5 py-1 bg-[#22262f] border border-[#2a2e3a] rounded-lg text-[11px] text-[#8b8fa3] hover:text-white hover:border-amber-500/30 transition-all font-mono">
                                                            {v.tag} <span className="text-[#6b6f80] ml-1 font-sans">{v.label}</span>
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                            {/* Message templates */}
                                            <div>
                                                <p className="text-[10px] text-[#8b8fa3] mb-1.5">Или выберите готовый шаблон:</p>
                                                <div className="flex flex-wrap gap-1.5">
                                                    {[
                                                        'Здравствуйте, {clientName}! Остались ли у вас вопросы? 😊',
                                                        'Добрый день! Мы подготовили для вас специальное предложение. Интересно?',
                                                        'Привет! Заметили, что вы давно не заходили. Может, есть вопросы?',
                                                        '{clientName}, напоминаем — у нас есть свободные слоты на этой неделе! 📅',
                                                    ].map((tpl, i) => (
                                                        <button key={i} onClick={() => setAct({ ...act, message: tpl })}
                                                            className="px-2.5 py-1.5 bg-[#22262f] border border-[#2a2e3a] rounded-lg text-[11px] text-[#8b8fa3] hover:text-white hover:border-amber-500/30 transition-all text-left">
                                                            {tpl.substring(0, 50)}...
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {actionType === 'change_status' && (
                                        <div>
                                            <label className="label">Перевести лид в статус:</label>
                                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2">
                                                {leadStatuses.map(s => (
                                                    <button key={s.id} onClick={() => setAct({ ...act, status: s.id })}
                                                        className={`flex items-center gap-2 p-3 rounded-xl border transition-all ${act.status === s.id ? 'border-amber-500/40 bg-amber-500/5' : 'border-[#2a2e3a] bg-[#22262f] hover:border-[#3a3e4a]'}`}>
                                                        <span className="w-3 h-3 rounded-full" style={{ backgroundColor: s.color }} />
                                                        <span className={`text-sm ${act.status === s.id ? 'text-amber-300 font-medium' : 'text-white'}`}>{s.label}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {actionType === 'notify_manager' && (
                                        <div className="bg-blue-500/5 border border-blue-500/15 rounded-xl px-5 py-6 text-center">
                                            <span className="text-4xl">🔔</span>
                                            <p className="text-white font-medium mt-3">Push-уведомление менеджеру</p>
                                            <p className="text-xs text-[#8b8fa3] mt-1">Придёт уведомление в браузер с именем клиента</p>
                                        </div>
                                    )}

                                    {actionType === 'start_sequence' && (
                                        <div>
                                            <label className="label">Выберите цепочку:</label>
                                            {sequences.length > 0 ? (
                                                <div className="grid grid-cols-1 gap-2 mt-2">
                                                    {sequences.map(seq => (
                                                        <button key={seq.id} onClick={() => setAct({ ...act, sequenceId: seq.id })}
                                                            className={`flex items-center gap-3 p-3 rounded-xl border transition-all text-left ${act.sequenceId === seq.id ? 'border-amber-500/40 bg-amber-500/5' : 'border-[#2a2e3a] bg-[#22262f] hover:border-[#3a3e4a]'}`}>
                                                            <ListOrdered size={18} className={act.sequenceId === seq.id ? 'text-amber-400' : 'text-[#8b8fa3]'} />
                                                            <div>
                                                                <p className={`text-sm ${act.sequenceId === seq.id ? 'text-amber-300 font-medium' : 'text-white'}`}>{seq.name}</p>
                                                                {seq.description && <p className="text-[10px] text-[#8b8fa3]">{seq.description}</p>}
                                                            </div>
                                                        </button>
                                                    ))}
                                                </div>
                                            ) : (
                                                <p className="text-sm text-[#8b8fa3] mt-2 bg-[#22262f] p-4 rounded-xl border border-[#2a2e3a]">
                                                    Нет цепочек. Сначала создайте цепочку на вкладке «Цепочки».
                                                </p>
                                            )}
                                        </div>
                                    )}

                                    {actionType === 'send_offer' && (
                                        <div className="bg-pink-500/5 border border-pink-500/15 rounded-xl px-5 py-6 text-center">
                                            <span className="text-4xl">🎁</span>
                                            <p className="text-white font-medium mt-3">AI сгенерирует персональное КП</p>
                                            <p className="text-xs text-[#8b8fa3] mt-1">На основе профиля клиента бот создаст и отправит коммерческое предложение</p>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* STEP 3: Name + Settings */}
                            {wizardStep === 3 && (
                                <div className="space-y-5">
                                    <h3 className="text-white font-semibold mb-1">Финальные настройки</h3>

                                    {/* Preview */}
                                    <div className="bg-[#22262f] rounded-xl p-4 border border-[#2a2e3a]">
                                        <p className="text-[10px] text-[#6b6f80] uppercase tracking-wider mb-2">Превью триггера</p>
                                        <div className="flex items-center gap-2 text-sm">
                                            <span>{TRIGGER_TYPES.find(t => t.id === triggerType)?.icon}</span>
                                            <span className="text-white font-medium">{TRIGGER_TYPES.find(t => t.id === triggerType)?.label}</span>
                                            <ArrowRight size={14} className="text-[#6b6f80]" />
                                            <span>{ACTION_TYPES.find(a => a.id === actionType)?.icon}</span>
                                            <span className="text-amber-300 font-medium">{ACTION_TYPES.find(a => a.id === actionType)?.label}</span>
                                        </div>
                                    </div>

                                    <div>
                                        <label className="label" htmlFor="trigger-triggerName">Название триггера (необязательно)</label>
                                        <input id="trigger-triggerName" className="input" value={triggerName} onChange={e => setTriggerName(e.target.value)}
                                            placeholder={autoName()} />
                                        <p className="text-[10px] text-[#6b6f80] mt-1">Если оставить пустым — имя сгенерируется автоматически</p>
                                    </div>

                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <div>
                                            <label className="label" htmlFor="trigger-cooldownMinutes">Не чаще чем раз в...</label>
                                            <select id="trigger-cooldownMinutes" className="input" value={cooldownMinutes} onChange={e => setCooldownMinutes(Number(e.target.value))}>
                                                {![0, 5, 15, 30, 60, 180, 360, 720, 1440, 10080].includes(cooldownMinutes) &&
                                                    <option value={cooldownMinutes}>{cooldownMinutes} минут (текущее значение)</option>}
                                                <option value={0}>Без ограничений</option>
                                                <option value={5}>5 минут</option>
                                                <option value={15}>15 минут</option>
                                                <option value={30}>30 минут</option>
                                                <option value={60}>1 час</option>
                                                <option value={180}>3 часа</option>
                                                <option value={360}>6 часов</option>
                                                <option value={720}>12 часов</option>
                                                <option value={1440}>1 день</option>
                                                <option value={10080}>1 неделя</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label className="label" htmlFor="trigger-maxExecutions">Максимум срабатываний на клиента</label>
                                            <select id="trigger-maxExecutions" className="input" value={maxExecutions} onChange={e => setMaxExecutions(Number(e.target.value))}>
                                                {![0, 1, 2, 3, 5, 10].includes(maxExecutions) &&
                                                    <option value={maxExecutions}>{maxExecutions} раз (текущее значение)</option>}
                                                <option value={0}>Без лимита</option>
                                                <option value={1}>1 раз</option>
                                                <option value={2}>2 раза</option>
                                                <option value={3}>3 раза</option>
                                                <option value={5}>5 раз</option>
                                                <option value={10}>10 раз</option>
                                            </select>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Footer buttons */}
                        <div className="flex items-center justify-between px-6 py-4 border-t border-[#2a2e3a]">
                            <button disabled={savingTrigger} onClick={() => { if (wizardStep > 0) setWizardStep(wizardStep - 1); else closeWizard(); }}
                                className="min-h-11 px-4 py-2 text-sm text-[#8b8fa3] hover:text-white transition-colors">
                                {wizardStep === 0 ? 'Отмена' : '← Назад'}
                            </button>
                            {wizardStep < 3 ? (
                                <button onClick={() => setWizardStep(wizardStep + 1)}
                                    disabled={wizardStep === 1 && triggerType === 'keyword' && cond.keywords.length === 0}
                                    className="min-h-11 px-5 py-2 bg-amber-500 text-black rounded-lg text-sm font-semibold hover:bg-amber-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                                    Далее →
                                </button>
                            ) : (
                                <button onClick={handleSaveTrigger} disabled={savingTrigger || (actionType === 'send_message' && !act.message.trim()) || (actionType === 'start_sequence' && !act.sequenceId)}
                                    className="min-h-11 px-5 py-2 bg-amber-500 text-black rounded-lg text-sm font-semibold hover:bg-amber-400 transition-colors disabled:opacity-40 flex items-center gap-2">
                                    {savingTrigger ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                                    {savingTrigger ? 'Сохраняем…' : editingTriggerId === null ? 'Создать триггер' : 'Сохранить изменения'}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ===== SEQUENCES TAB ===== */}
            {!loading && tab === 'sequences' && (
                <div>
                    <div className="ava-sequence-safety" role="note">
                        <strong>Схема показывает сохранённые шаги цепочки.</strong>
                        <span>Выключенная цепочка не отправляет сообщения и не принимает новых клиентов. При повторном включении просроченные шаги могут отправиться сразу. Шаги нельзя менять, пока клиенты проходят цепочку, включая приостановленные и ожидающие проверки после ошибки доставки.</span>
                    </div>
                    <div className="flex justify-between items-center mb-4">
                        <span className="text-sm text-[#8b8fa3]">{sequences.length} цепочек</span>
                        <button onClick={() => setShowSeqForm(!showSeqForm)} disabled={!canEdit} className="flex items-center gap-2 px-4 py-2 bg-blue-500/10 text-blue-400 rounded-lg hover:bg-blue-500/20 border border-blue-500/20 text-sm font-medium disabled:opacity-50">
                            <Plus size={16} /> Новая цепочка
                        </button>
                    </div>

                    {showSeqForm && (
                        <div className="card mb-6">
                            <div className="card-body space-y-3">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="label" htmlFor="sequence-name">Название</label>
                                        <input id="sequence-name" className="input" value={seqForm.name} onChange={e => setSeqForm({ ...seqForm, name: e.target.value })} placeholder="Онбординг новых клиентов" />
                                    </div>
                                    <div>
                                        <label className="label" htmlFor="sequence-description">Описание</label>
                                        <input id="sequence-description" className="input" value={seqForm.description} onChange={e => setSeqForm({ ...seqForm, description: e.target.value })} placeholder="Серия приветственных сообщений" />
                                    </div>
                                </div>
                                <button onClick={handleCreateSequence} disabled={!canEdit || !seqForm.name} className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-400 text-sm font-medium disabled:opacity-40">
                                    <Plus size={16} /> Создать
                                </button>
                            </div>
                        </div>
                    )}

                    <div className="space-y-3">
                        {sequences.map(seq => {
                            const isExpanded = expandedSeq === seq.id;
                            const steps = seqSteps[seq.id] || [];
                            return (
                                <div key={seq.id} className="card">
                                    <div className="card-body">
                                        <div className="flex items-center gap-3">
                                            <button type="button" aria-expanded={isExpanded} aria-controls={`sequence-steps-${seq.id}`} className="flex flex-1 items-center gap-3 text-left min-w-0" onClick={() => {
                                                if (isExpanded) { setExpandedSeq(null); } else { setExpandedSeq(seq.id); loadSteps(seq.id); }
                                            }}>
                                                <ListOrdered size={20} className="text-blue-400 flex-shrink-0" aria-hidden="true" />
                                                <span className="flex-1 min-w-0"><span className="block text-white font-medium text-sm">{seq.name}</span>
                                                    {seq.description && <span className="block text-xs text-[#8b8fa3]">{seq.description}</span>}
                                                    {!!seq.deliveryFailureCount && <span className="block text-xs text-red-500" role="status">{seq.deliveryFailureCount} отправок требуют ручной проверки — автоматический повтор остановлен</span>}</span>
                                                <span className={`text-xs px-2 py-1 rounded-md ${seq.isActive ? 'bg-green-500/15 text-green-300' : 'bg-[#2a2e3a] text-[#d0d2d9]'}`}>{seq.isActive ? 'Включена' : 'Выключена'}</span>
                                                {!!seq.unfinishedEnrollmentCount && <span className="ava-sequence-enrollment-count">{seq.unfinishedEnrollmentCount} незавершённых</span>}
                                                <span className="text-xs text-[#8b8fa3] flex-shrink-0">{seqSteps[seq.id] ? `${steps.length} шагов` : 'шаги'}</span>
                                                {isExpanded ? <ChevronUp size={16} className="text-[#8b8fa3]" aria-hidden="true" /> : <ChevronDown size={16} className="text-[#8b8fa3]" aria-hidden="true" />}
                                            </button>
                                            <button type="button" onClick={() => void handleToggleSequence(seq)} disabled={!canEdit || sequenceBusyId !== null}
                                                className="min-h-11 min-w-11 inline-flex items-center justify-center hover:bg-[#2a2e3a] rounded-lg text-[#d0d2d9] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:opacity-50"
                                                aria-label={`${seq.isActive ? 'Выключить' : 'Включить'} цепочку ${seq.name}`} aria-pressed={Boolean(seq.isActive)}
                                                title={seq.isActive ? 'Выключить цепочку' : 'Включить цепочку'}>
                                                {sequenceBusyId === seq.id ? <Loader2 size={18} className="animate-spin" aria-hidden="true" />
                                                    : seq.isActive ? <Eye size={18} aria-hidden="true" /> : <EyeOff size={18} aria-hidden="true" />}
                                            </button>
                                            <button type="button" onClick={() => handleDeleteSequence(seq.id)} disabled={!canEdit} className="min-h-11 min-w-11 inline-flex items-center justify-center hover:bg-red-500/10 rounded-lg text-[#8b8fa3] hover:text-red-400 disabled:opacity-50" aria-label={`Удалить цепочку ${seq.name}`}>
                                                <Trash2 size={14} />
                                            </button>
                                        </div>

                                                {isExpanded && (
                                                    <div id={`sequence-steps-${seq.id}`} className="mt-4 border-t border-[#2a2e3a] pt-4 space-y-3">
                                                {seqStepErrors[seq.id] && <div className="ava-sequence-step-error" role="alert">
                                                    <span>{seqStepErrors[seq.id]}</span>
                                                    <button type="button" onClick={() => void loadSteps(seq.id)}>Повторить загрузку</button>
                                                </div>}
                                                {loadingSeqSteps.includes(seq.id) && <p className="ava-sequence-loading" role="status"><Loader2 size={16} className="animate-spin" aria-hidden="true" /> Загружаем сохранённые шаги…</p>}
                                                {!loadingSeqSteps.includes(seq.id) && !seqStepErrors[seq.id] && <div className="ava-sequence-canvas" aria-label={`Сохранённая линейная цепочка: ${seq.name}`} aria-busy={loadingSeqSteps.includes(seq.id)}>
                                                    <div className="ava-sequence-entry">
                                                        <span className="ava-sequence-entry-icon"><ListOrdered size={18} aria-hidden="true" /></span>
                                                        <div><strong>Вход в цепочку</strong><p>Назначение вручную или действием существующего триггера</p></div>
                                                    </div>
                                                    {steps.length === 0 ? <div className="ava-sequence-empty">Сохранённых шагов пока нет.</div> : <ol className="ava-sequence-steps">
                                                        {[...steps].sort((a, b) => a.stepOrder - b.stepOrder).map((step, idx) => {
                                                            const delay = step.delayMinutes >= 60
                                                                ? `${Math.floor(step.delayMinutes / 60)} ч${step.delayMinutes % 60 ? ` ${step.delayMinutes % 60} мин` : ''}`
                                                                : `${step.delayMinutes} мин`;
                                                            const channel = step.channelOverride || 'Канал клиента (по умолчанию WhatsApp)';
                                                            return <li key={step.id} className="ava-sequence-step">
                                                                <article className="ava-sequence-step-card">
                                                                    <div className="ava-sequence-step-heading"><span>Шаг {idx + 1} · Сообщение</span><span>{idx === 0 ? `Первое отправление через ${delay}` : `Пауза перед шагом: ${delay}`}</span></div>
                                                                    <p className="ava-sequence-step-message">{step.messageTemplate}</p>
                                                                    <div className="ava-sequence-step-meta"><span><MessageSquare size={14} aria-hidden="true" />{channel}</span>{step.useAiPersonalization ? <span><Zap size={14} aria-hidden="true" />AI-персонализация</span> : <span>Шаблон без AI-персонализации</span>}</div>
                                                                </article>
                                                            </li>;
                                                        })}
                                                    </ol>}
                                                    <div className="ava-sequence-exit">Конец последовательности{steps.length > 0 ? ` · ${steps.length} сохранённых шагов` : ''}</div>
                                                </div>}
                                                {!!seq.unfinishedEnrollmentCount && <p className="ava-sequence-locked" role="status">Изменение шагов временно заблокировано: {seq.unfinishedEnrollmentCount} клиентов ещё не завершили цепочку.</p>}
                                                {steps.length > 0 && <div className="ava-sequence-existing-controls" aria-label="Управление сохранёнными шагами">
                                                    <span>Управление шагами</span>
                                                    {steps.map((step, idx) => <button key={step.id} type="button" onClick={() => void handleDeleteStep(seq.id, step.id)} disabled={!canEdit || !!seq.unfinishedEnrollmentCount}
                                                        aria-label={`Удалить шаг ${idx + 1} цепочки ${seq.name}`}><Trash2 size={15} aria-hidden="true" /> Удалить шаг {idx + 1}</button>)}
                                                </div>}

                                                {/* Add step */}
                                                <div className="bg-[#1e2128] rounded-xl p-4 border border-dashed border-[#2a2e3a]">
                                                    <p className="text-xs text-[#8b8fa3] mb-3">Добавить шаг:</p>
                                                    <div className="space-y-3">
                                                        <textarea className="input h-20 text-sm" value={newStep.messageTemplate} onChange={e => setNewStep({ ...newStep, messageTemplate: e.target.value })}
                                                            placeholder="Привет, {clientName}! Как дела? Остались вопросы?" />
                                                        <div className="flex items-center gap-3">
                                                            <div className="flex-1">
                                                                <label className="text-[10px] text-[#6b6f80]">Задержка перед отправкой</label>
                                                                <select className="input text-sm mt-0.5" value={newStep.delayMinutes} onChange={e => setNewStep({ ...newStep, delayMinutes: Number(e.target.value) })}>
                                                                    <option value={5}>5 минут</option>
                                                                    <option value={15}>15 минут</option>
                                                                    <option value={30}>30 минут</option>
                                                                    <option value={60}>1 час</option>
                                                                    <option value={180}>3 часа</option>
                                                                    <option value={360}>6 часов</option>
                                                                    <option value={720}>12 часов</option>
                                                                    <option value={1440}>1 день</option>
                                                                    <option value={2880}>2 дня</option>
                                                                    <option value={4320}>3 дня</option>
                                                                    <option value={10080}>1 неделя</option>
                                                                </select>
                                                            </div>
                                                            <label className="flex items-center gap-2 cursor-pointer mt-4">
                                                                <input type="checkbox" checked={newStep.useAiPersonalization}
                                                                    onChange={e => setNewStep({ ...newStep, useAiPersonalization: e.target.checked })}
                                                                    className="w-4 h-4 rounded bg-[#22262f] border-[#2a2e3a] accent-purple-500" />
                                                                <span className="text-xs text-[#8b8fa3]">AI-персонализация</span>
                                                            </label>
                                                            <button type="button" onClick={() => handleAddStep(seq.id)} disabled={!canEdit || !!seq.unfinishedEnrollmentCount || !newStep.messageTemplate.trim()}
                                                                aria-label={`Добавить шаг в цепочку ${seq.name}`} className="mt-4 min-h-11 min-w-11 inline-flex items-center justify-center px-4 py-2 bg-blue-500/10 text-blue-400 rounded-lg hover:bg-blue-500/20 border border-blue-500/20 text-sm disabled:opacity-30">
                                                                <Plus size={16} />
                                                            </button>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                        {sequences.length === 0 && !showSeqForm && (
                            <div className="text-center py-16 border-2 border-dashed border-[#2a2e3a] rounded-xl">
                                <ListOrdered size={40} className="mx-auto text-[#3a3e4a] mb-3" />
                                <h3 className="text-white font-semibold mb-1">Нет цепочек</h3>
                                <p className="text-sm text-[#8b8fa3] mb-4">Создайте серию автоматических сообщений для клиентов</p>
                                <button onClick={() => setShowSeqForm(true)} disabled={!canEdit} className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-500/10 text-blue-400 rounded-xl hover:bg-blue-500/20 border border-blue-500/20 text-sm font-medium disabled:opacity-50">
                                    <Plus size={16} /> Создать цепочку
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ===== LOG TAB ===== */}
            {!loading && tab === 'log' && (
                <div>
                    <p className="text-sm text-[#8b8fa3] mb-4">{log.length > 0 ? `Последние ${log.length} срабатываний` : 'Лог выполнений триггеров'}</p>
                    <div className="space-y-2">
                        {log.map((entry: any) => {
                            const tt = TRIGGER_TYPES.find(t => t.id === entry.triggerType);
                            const at = ACTION_TYPES.find(a => a.id === entry.actionType);
                            return (
                                <div key={entry.id} className="flex items-center gap-3 bg-[#22262f] rounded-lg px-4 py-3 border border-[#2a2e3a]">
                                    <span className="text-lg">{tt?.icon || <Zap size={20} aria-hidden="true" />}</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm text-white font-medium">{entry.triggerName || `Триггер #${entry.triggerId}`}</span>
                                            <ArrowRight size={12} className="text-[#6b6f80]" />
                                            <span className="text-xs text-amber-300">{at?.icon} {at?.label || entry.actionType}</span>
                                        </div>
                                        <p className="text-[10px] text-[#6b6f80] mt-0.5">
                                            Клиент: {entry.chatId?.replace('@c.us', '').replace('tg_', 'TG: ').replace('email_', '📧 ')}
                                        </p>
                                    </div>
                                    <span className="text-[10px] text-[#6b6f80] flex-shrink-0">{new Date(entry.createdAt).toLocaleString('ru-RU')}</span>
                                </div>
                            );
                        })}
                        {log.length === 0 && (
                            <div className="text-center py-16 border-2 border-dashed border-[#2a2e3a] rounded-xl">
                                <Zap size={40} className="mx-auto text-[#3a3e4a] mb-3" />
                                <h3 className="text-white font-semibold mb-1">История пуста</h3>
                                <p className="text-sm text-[#8b8fa3]">Когда триггеры начнут срабатывать — записи появятся здесь</p>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
