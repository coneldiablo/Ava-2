import { useEffect, useState, useCallback, useRef } from 'react';
import { useInstance } from '../context/InstanceContext';
import { updateInstance, getGreenApiStatus, getGreenApiQR, setupGreenApiWebhook, greenApiLogout, greenApiReboot, getOpenWaStatus, getOpenWaQR, createOpenWaSession, startOpenWaSession, stopOpenWaSession, logoutOpenWa, setupOpenWaWebhook, getTemplates, createTemplate, deleteTemplate, testPushNotification, getBaristaStaff, deleteBaristaStaff, restartBaristaBot } from '../api';
import { Save, Brain, Calendar, Thermometer, CheckCircle, Database, RefreshCw, LogOut, Power, QrCode, Link, AlertCircle, Phone, Loader2, Bell, MessageSquare, Plus, Trash2, Send, Target, Coffee, Users, UserMinus } from 'lucide-react';
import { getBusinessType, isCoffeeBusiness } from '../businessProfiles';
import { connectWhatsApp, replaceWhatsApp } from '../api';
import BusinessSetupStatus from '../components/BusinessSetupStatus';
import AiModelSettings from '../components/AiModelSettings';

const WHATSAPP_CONNECTION_ERROR = 'Не удалось подключить WhatsApp. Нажмите «Подключить WhatsApp» ещё раз через минуту. Если ошибка повторяется, обратитесь в поддержку AVA.';
const whatsappError = (code?: string) => ({
    WHATSAPP_ACCOUNT_CHANGED: 'QR-код отсканирован другим WhatsApp-аккаунтом. Используйте прежний номер или нажмите «Сменить номер». История CRM сохранится.',
    WHATSAPP_CONNECTION_CHANGED: 'Подключение уже изменилось. Обновите страницу перед сменой номера.',
    WHATSAPP_BUSY: 'Подключение уже выполняется. Дождитесь результата и обновите статус.',
} as Record<string, string>)[code || ''] || WHATSAPP_CONNECTION_ERROR;

// ===================== Types =====================

type ConnectionState = 'notConfigured' | 'loading' | 'authorized' | 'notAuthorized' | 'blocked' | 'starting' | 'disconnected' | 'yellowCard' | 'sleepMode' | 'error';

interface WaSettings {
    wid?: string;
    phone?: string;
    pushName?: string;
    avatar?: string;
}

// ===================== Main Component =====================

export default function Integrations() {
    const { instances, currentInstanceId, refreshInstances } = useInstance();
    const activeInstanceRef = useRef(currentInstanceId);
    activeInstanceRef.current = currentInstanceId;
    const [formData, setFormData] = useState<any>({});
    const [loading, setLoading] = useState(false);
    const [saved, setSaved] = useState(false);
    const [saveError, setSaveError] = useState('');

    // GREEN-API connection state
    const [connectionState, setConnectionState] = useState<ConnectionState>('notConfigured');
    const [waSettings, setWaSettings] = useState<WaSettings | null>(null);
    const [qrCode, setQrCode] = useState<string | null>(null);
    const [qrLoading, setQrLoading] = useState(false);
    const [statusLoading, setStatusLoading] = useState(false);
    const [webhookLoading, setWebhookLoading] = useState(false);
    const [webhookResult, setWebhookResult] = useState<{ success: boolean; url?: string } | null>(null);
    const [actionLoading, setActionLoading] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const qrIntervalRef = useRef<any>(null);

    // OpenWA connection state
    const [openWaState, setOpenWaState] = useState<ConnectionState>('notConfigured');
    const [openWaPhone, setOpenWaPhone] = useState<string | null>(null);
    const [openWaPushName, setOpenWaPushName] = useState<string | null>(null);
    const [openWaQrCode, setOpenWaQrCode] = useState<string | null>(null);
    const [openWaQrLoading, setOpenWaQrLoading] = useState(false);
    const [openWaStatusLoading, setOpenWaStatusLoading] = useState(false);
    const [openWaWebhookLoading, setOpenWaWebhookLoading] = useState(false);
    const [openWaWebhookResult, setOpenWaWebhookResult] = useState<{ success: boolean; url?: string } | null>(null);
    const [openWaActionLoading, setOpenWaActionLoading] = useState<string | null>(null);
    const [openWaActionError, setOpenWaActionError] = useState<string | null>(null);
    const [openWaSessionLoading, setOpenWaSessionLoading] = useState(false);
    const [showOpenWaQr, setShowOpenWaQr] = useState(false);
    const [showGreenApiQr, setShowGreenApiQr] = useState(false);
    const openWaQrIntervalRef = useRef<any>(null);

    useEffect(() => {
        setShowOpenWaQr(false);
        setSaved(false);
        setSaveError('');
        setLoading(false);
        setTemplates([]);
        setNewTemplateLabel('');
        setNewTemplateText('');
        setQrCode(null);
        setShowGreenApiQr(false);
        setWaSettings(null);
        setActionError(null);
        setOpenWaQrCode(null);
        setOpenWaPhone(null);
        setOpenWaPushName(null);
        setOpenWaActionError(null);
        setOpenWaSessionLoading(false);
        setOpenWaQrLoading(false);
        setOpenWaState('loading');
    }, [currentInstanceId]);

    // Templates state
    const [templates, setTemplates] = useState<any[]>([]);
    const [newTemplateLabel, setNewTemplateLabel] = useState('');
    const [newTemplateText, setNewTemplateText] = useState('');
    const [templateLoading, setTemplateLoading] = useState(false);
    const [pushTestLoading, setPushTestLoading] = useState(false);
    const [pushTestResult, setPushTestResult] = useState<string | null>(null);

    // Barista Bot State
    const [baristaStaff, setBaristaStaff] = useState<any[]>([]);
    const [baristaStaffLoading, setBaristaStaffLoading] = useState(false);
    const [restartLoading, setRestartLoading] = useState(false);
    const [restartResult, setRestartResult] = useState<string | null>(null);

    useEffect(() => {
        const inst = instances.find(i => i.id === currentInstanceId);
        if (inst) {
            setFormData({
                ...inst,
                aiProvider: inst.aiProvider || 'yandex',
                yandexGptModelUri: inst.yandexGptModelUri || 'gpt-oss-120b',
                aiResponseFormat: inst.aiResponseFormat || 'json_object',
            });
        } else setFormData({});
        // Load templates for this instance
        if (currentInstanceId) {
            getTemplates(currentInstanceId).then(d => {
                if (activeInstanceRef.current === currentInstanceId && d.success) setTemplates(d.templates || []);
            }).catch(() => { });
        }
    }, [currentInstanceId, instances]);

    // Fetch GREEN-API status when instance changes
    // force=true bypasses server cache (used only for manual refresh button)
    const checkStatus = useCallback(async (force = false) => {
        if (!currentInstanceId) return;
        const inst = instances.find(i => i.id === currentInstanceId);
        if (!inst?.greenApiInstance || !inst?.greenApiToken) {
            setConnectionState('notConfigured');
            setWaSettings(null);
            setQrCode(null);
            return;
        }

        setStatusLoading(true);
        setActionError(null);
        try {
            const data = await getGreenApiStatus(currentInstanceId, force);
            if (data.success && data.state) {
                const state = data.state.stateInstance as ConnectionState;
                setConnectionState(state);
                setWaSettings(data.waSettings || null);
            } else {
                // Don't show error state if we had a previous good state
                if (!data.error?.includes('429')) {
                    setConnectionState('error');
                }
                setActionError(data.error || 'Failed to get status');
            }
        } catch (e: any) {
            const errMsg = e.response?.data?.error || e.message || '';
            const is429 = e.response?.status === 429 || errMsg.includes('429');
            // On rate limit, keep last known state, show soft warning
            if (is429) {
                // Don't change connectionState — keep whatever we had
                setActionError('Слишком частые запросы к GREEN-API. Подождите немного.');
            } else {
                setConnectionState('error');
                setActionError(errMsg);
            }
        }
        setStatusLoading(false);
    }, [currentInstanceId, instances]);

    // Fetch OpenWA status
    const checkOpenWaStatus = useCallback(async (force = false) => {
        if (!currentInstanceId) return;
        const inst = instances.find(i => i.id === currentInstanceId);
        if (!inst?.openWaSessionId && !formData.openWaSessionId) {
            setOpenWaState('notConfigured');
            setOpenWaPhone(null);
            setOpenWaPushName(null);
            setOpenWaQrCode(null);
            return;
        }

        setOpenWaStatusLoading(true);
        if (force) setOpenWaActionError(null);
        try {
            const data = await getOpenWaStatus(currentInstanceId, force);
            if (activeInstanceRef.current !== currentInstanceId) return;
            if (data.success && data.state) {
                const state = data.state.stateInstance as ConnectionState;
                setOpenWaState(state);
                setOpenWaPhone(data.state.phone || null);
                setOpenWaPushName(data.state.pushName || null);
                if (data.state.connectionErrorCode) {
                    setOpenWaActionError(whatsappError(data.state.connectionErrorCode));
                    setOpenWaQrCode(null);
                    setShowOpenWaQr(false);
                } else if (state === 'authorized') {
                    setOpenWaActionError(null);
                    setOpenWaQrCode(null);
                    setShowOpenWaQr(false);
                }
            } else if (!data.success && data.error) {
                setOpenWaState('error');
                if (force) {
                    setOpenWaActionError(WHATSAPP_CONNECTION_ERROR);
                }
            }
        } catch (e: any) {
            if (activeInstanceRef.current !== currentInstanceId) return;
            setOpenWaState('error');
            if (force) {
                setOpenWaActionError(WHATSAPP_CONNECTION_ERROR);
            }
        }
        setOpenWaStatusLoading(false);
    }, [currentInstanceId, instances, formData.openWaSessionId]);

    // Fetch OpenWA QR
    const fetchOpenWaQR = useCallback(async () => {
        if (!currentInstanceId) return;
        setOpenWaQrLoading(true);
        try {
            const data = await getOpenWaQR(currentInstanceId);
            if (activeInstanceRef.current !== currentInstanceId) return;
            if (data.success) {
                setOpenWaActionError(null);
                if (data.type === 'qrCode' || data.message?.startsWith('data:image')) {
                    setOpenWaQrCode(data.message);
                } else if (data.type === 'alreadyLogged') {
                    setOpenWaQrCode(null);
                    setShowOpenWaQr(false);
                    checkOpenWaStatus(true);
                } else if (data.type === 'pending') {
                    setOpenWaQrCode(null);
                    setOpenWaState('starting');
                }
            } else {
                setOpenWaActionError(whatsappError(data.code));
                if (data.code === 'WHATSAPP_ACCOUNT_CHANGED') {
                    setOpenWaState('blocked');
                    setOpenWaQrCode(null);
                    setShowOpenWaQr(false);
                }
            }
        } catch (e: any) {
            if (activeInstanceRef.current !== currentInstanceId) return;
            setOpenWaActionError(WHATSAPP_CONNECTION_ERROR);
        }
        setOpenWaQrLoading(false);
    }, [currentInstanceId, checkOpenWaStatus]);

    useEffect(() => {
        checkStatus(false);
        checkOpenWaStatus(false);
        return () => {
            if (qrIntervalRef.current) clearInterval(qrIntervalRef.current);
            if (openWaQrIntervalRef.current) clearInterval(openWaQrIntervalRef.current);
        };
    }, [checkStatus, checkOpenWaStatus]);

    // Start OpenWA QR polling when notAuthorized
    useEffect(() => {
        if (openWaQrIntervalRef.current) {
            clearInterval(openWaQrIntervalRef.current);
            openWaQrIntervalRef.current = null;
        }
        if (showOpenWaQr && !openWaSessionLoading && openWaState !== 'authorized') {
            fetchOpenWaQR();
            openWaQrIntervalRef.current = setInterval(() => {
                fetchOpenWaQR();
            }, 5000);
        } else {
            setOpenWaQrCode(null);
        }
        return () => {
            if (openWaQrIntervalRef.current) clearInterval(openWaQrIntervalRef.current);
        };
    }, [openWaState, fetchOpenWaQR, showOpenWaQr, openWaSessionLoading]);

    // Auto-fetch QR when not authorized
    const fetchQR = useCallback(async () => {
        if (!currentInstanceId) return;
        setQrLoading(true);
        try {
            const data = await getGreenApiQR(currentInstanceId);
            if (data.success) {
                if (data.type === 'qrCode') {
                    setQrCode(data.message);
                } else if (data.type === 'alreadyLogged') {
                    setQrCode(null);
                    checkStatus();
                } else if (data.type === 'error') {
                    setQrCode(null);
                    setActionError(data.message);
                }
            } else {
                setActionError(data.error || 'QR error');
            }
        } catch (e: any) {
            setActionError(e.response?.data?.error || e.message);
        }
        setQrLoading(false);
    }, [currentInstanceId, checkStatus]);

    // Start QR polling when notAuthorized
    useEffect(() => {
        if (qrIntervalRef.current) {
            clearInterval(qrIntervalRef.current);
            qrIntervalRef.current = null;
        }
        if (connectionState === 'notAuthorized') {
            fetchQR();
            qrIntervalRef.current = setInterval(() => {
                fetchQR();
            }, 5000);
        } else {
            setQrCode(null);
        }
        return () => {
            if (qrIntervalRef.current) clearInterval(qrIntervalRef.current);
        };
    }, [connectionState, fetchQR]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
        setSaved(false);
    };

    const handleBusinessTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const businessType = e.target.value;
        if (businessType !== getBusinessType(formData)) {
            const confirmed = window.confirm(
                'Тип бизнеса изменит названия и финальную стадию воронки. Существующие клиенты сохранятся. Продолжить?'
            );
            if (!confirmed) return;
        }
        setFormData({
            ...formData,
            businessType,
            salesGoal: businessType === 'coffee_shop' ? 'coffee_pickup' : 'call',
        });
        setSaved(false);
    };

    const loadBaristaStaff = useCallback(async () => {
        if (!currentInstanceId) return;
        setBaristaStaffLoading(true);
        try {
            const data = await getBaristaStaff(currentInstanceId);
            if (data.success) {
                setBaristaStaff(data.staff || []);
            }
        } catch (e) { }
        setBaristaStaffLoading(false);
    }, [currentInstanceId]);

    useEffect(() => {
        if (currentInstanceId) {
            loadBaristaStaff();
        }
    }, [currentInstanceId, loadBaristaStaff]);

    const handleRestartBaristaBot = async () => {
        if (!currentInstanceId) return;
        setRestartLoading(true);
        setRestartResult(null);
        try {
            const data = await restartBaristaBot(currentInstanceId, {
                baristaBotToken: String(formData.baristaBotToken || '').trim(),
                baristaInviteCode: String(formData.baristaInviteCode || '').trim()
            });
            if (data.success) {
                setFormData((current: any) => ({
                    ...current,
                    baristaInviteCode: data.inviteCode || current.baristaInviteCode,
                    baristaBotUsername: data.botUsername || current.baristaBotUsername
                }));
                setRestartResult('Бот баристы успешно запущен/перезапущен.');
                await refreshInstances();
            } else {
                setRestartResult(data.message || 'Ошибка запуска бота.');
            }
        } catch (e: any) {
            setRestartResult(e.response?.data?.error || e.message || 'Ошибка подключения к серверу.');
        }
        setRestartLoading(false);
    };

    const handleDeleteBarista = async (tgChatId: string, name: string) => {
        if (!currentInstanceId || !confirm(`Удалить баристу "${name}"?`)) return;
        try {
            const res = await deleteBaristaStaff(currentInstanceId, tgChatId);
            if (res.success) {
                setBaristaStaff(prev => prev.filter(b => b.telegramChatId !== tgChatId));
            } else {
                alert(res.error || 'Ошибка удаления');
            }
        } catch (e) {
            alert('Ошибка удаления');
        }
    };

    const handleGenerateBaristaInviteCode = async () => {
        if (!currentInstanceId) return;
        const bytes = new Uint8Array(8);
        window.crypto.getRandomValues(bytes);
        const code = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        setFormData((current: any) => ({ ...current, baristaInviteCode: code }));
        setRestartResult(null);
        try {
            await updateInstance(currentInstanceId, { baristaInviteCode: code });
            await refreshInstances();
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (e: any) {
            setSaved(false);
            setRestartResult(e.response?.data?.error || 'Не удалось сохранить код приглашения.');
        }
    };

    const handleSave = async () => {
        if (!currentInstanceId || loading) return;
        const savingBusiness = currentInstanceId;
        setLoading(true);
        setSaveError('');
        try {
            // Provider/model selectors own their canonical saves. A stale parent form
            // must not overwrite either text or call settings.
            const independent = new Set(['aiProvider', 'geminiModel', 'yandexGptModelUri', 'voiceAiProvider', 'voiceModel', 'voiceName', 'voiceSettings']);
            await updateInstance(currentInstanceId, Object.fromEntries(Object.entries(formData).filter(([field]) => !independent.has(field))));
            await refreshInstances();
            if (activeInstanceRef.current !== savingBusiness) return;
            setSaved(true);
            setTimeout(() => { if (activeInstanceRef.current === savingBusiness) setSaved(false); }, 3000);
            // Re-check status after saving credentials
            setTimeout(() => { if (activeInstanceRef.current === savingBusiness) void checkStatus(); }, 500);
        } catch (e) {
            if (activeInstanceRef.current === savingBusiness) setSaveError('Не удалось сохранить настройки. Введённые значения оставлены в форме; повторите попытку.');
        }
        if (activeInstanceRef.current === savingBusiness) setLoading(false);
    };

    const handleSetupWebhook = async () => {
        if (!currentInstanceId) return;
        setWebhookLoading(true);
        setWebhookResult(null);
        setActionError(null);
        try {
            const data = await setupGreenApiWebhook(currentInstanceId);
            setWebhookResult({ success: data.success, url: data.webhookUrl });
            if (!data.success) setActionError(data.error);
        } catch (e: any) {
            setWebhookResult({ success: false });
            setActionError(e.response?.data?.error || e.message);
        }
        setWebhookLoading(false);
    };

    const handleLogout = async () => {
        if (!currentInstanceId || !confirm('Отключить аккаунт WhatsApp от этого инстанса?')) return;
        setActionLoading('logout');
        setActionError(null);
        try {
            await greenApiLogout(currentInstanceId);
            await checkStatus();
        } catch (e: any) {
            setActionError(e.response?.data?.error || e.message);
        }
        setActionLoading(null);
    };

    const handleReboot = async () => {
        if (!currentInstanceId) return;
        setActionLoading('reboot');
        setActionError(null);
        try {
            await greenApiReboot(currentInstanceId);
            setTimeout(() => checkStatus(), 3000);
        } catch (e: any) {
            setActionError(e.response?.data?.error || e.message);
        }
        setActionLoading(null);
    };

    const handleScanOpenWaQR = async (replace = false) => {
        if (!currentInstanceId) return;
        const expectedSessionId = instances.find(i => i.id === currentInstanceId)?.openWaSessionId || formData.openWaSessionId;
        if (replace && !window.confirm('Сменить WhatsApp-номер этого бизнеса? Прежнее подключение будет остановлено. История CRM и настройки сохранятся. Затем отсканируйте новый QR другим номером.')) return;
        setShowOpenWaQr(true);
        setOpenWaQrCode(null);
        setOpenWaActionError(null);
        setOpenWaSessionLoading(true);
        setOpenWaState('starting');
        try {
            const data = replace ? await replaceWhatsApp(currentInstanceId, expectedSessionId) : await connectWhatsApp(currentInstanceId);
            if (activeInstanceRef.current !== currentInstanceId) return;
            if (!data.success) {
                setOpenWaActionError(whatsappError(data.code));
                setShowOpenWaQr(false);
                setOpenWaState('error');
                return;
            }
            setFormData((prev: any) => ({ ...prev, openWaSessionId: data.session_id }));
            if (data.type === 'qrCode') setOpenWaQrCode(data.message);
            if (data.type === 'alreadyLogged') {
                setShowOpenWaQr(false);
                setOpenWaState('authorized');
            }
            await refreshInstances();
            if (activeInstanceRef.current === currentInstanceId) await checkOpenWaStatus(true);
        } catch (e) {
            if (activeInstanceRef.current !== currentInstanceId) return;
            setOpenWaActionError(whatsappError((e as any)?.response?.data?.code));
            setShowOpenWaQr(false);
            setOpenWaState('error');
        } finally {
            if (activeInstanceRef.current === currentInstanceId) setOpenWaSessionLoading(false);
        }
    };

    const handleScanGreenApiQR = () => {
        setShowGreenApiQr(true);
        fetchQR();
    };

    const handleCreateOpenWaSession = async () => {
        if (!currentInstanceId) return;
        setOpenWaSessionLoading(true);
        setOpenWaActionError(null);
        try {
            const data = await createOpenWaSession(currentInstanceId);
            if (data.success && data.data?.id) {
                setFormData((prev: any) => ({ ...prev, openWaSessionId: data.data.id }));
                await refreshInstances();
                setTimeout(() => checkOpenWaStatus(true), 1000);
            } else {
                setOpenWaActionError(data.error || 'Не удалось создать сессию');
            }
        } catch (e: any) {
            setOpenWaActionError(e.response?.data?.error || e.message);
        }
        setOpenWaSessionLoading(false);
    };

    const handleStartOpenWa = async () => {
        if (!currentInstanceId) return;
        setOpenWaActionLoading('start');
        setOpenWaActionError(null);
        try {
            const data = await startOpenWaSession(currentInstanceId);
            if (!data.success) setOpenWaActionError(data.error);
            setTimeout(() => checkOpenWaStatus(true), 1500);
        } catch (e: any) {
            setOpenWaActionError(e.response?.data?.error || e.message);
        }
        setOpenWaActionLoading(null);
    };

    const handleStopOpenWa = async () => {
        if (!currentInstanceId) return;
        setOpenWaActionLoading('stop');
        setOpenWaActionError(null);
        try {
            await stopOpenWaSession(currentInstanceId);
            setTimeout(() => checkOpenWaStatus(true), 1000);
        } catch (e: any) {
            setOpenWaActionError(e.response?.data?.error || e.message);
        }
        setOpenWaActionLoading(null);
    };

    const handleLogoutOpenWa = async () => {
        if (!currentInstanceId || !confirm('Отключить аккаунт WhatsApp от OpenWA?')) return;
        setOpenWaActionLoading('logout');
        setOpenWaActionError(null);
        try {
            await logoutOpenWa(currentInstanceId);
            setTimeout(() => checkOpenWaStatus(true), 1000);
        } catch (e: any) {
            setOpenWaActionError(e.response?.data?.error || e.message);
        }
        setOpenWaActionLoading(null);
    };

    const handleSetupOpenWaWebhook = async () => {
        if (!currentInstanceId) return;
        setOpenWaWebhookLoading(true);
        setOpenWaWebhookResult(null);
        setOpenWaActionError(null);
        try {
            const data = await setupOpenWaWebhook(currentInstanceId);
            setOpenWaWebhookResult({ success: data.success, url: data.webhookUrl });
            if (!data.success) setOpenWaActionError(data.error);
        } catch (e: any) {
            setOpenWaWebhookResult({ success: false });
            setOpenWaActionError(e.response?.data?.error || e.message);
        }
        setOpenWaWebhookLoading(false);
    };

    if (!currentInstanceId) {
        return (
            <div className="flex items-center justify-center h-full">
                <p className="text-[#8b8fa3]">Выберите бизнес в боковом меню</p>
            </div>
        );
    }

    return (
        <div className="max-w-4xl mx-auto pb-10">
            <div className="flex flex-wrap gap-3 justify-between items-center mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-white">Настройки</h1>
                    <p className="text-[#8b8fa3] text-sm mt-1">Интеграции и конфигурация AI для текущего бизнеса</p>
                </div>
                <button onClick={handleSave} disabled={loading} className="btn-primary">
                    {loading ? (
                        <span className="flex items-center gap-2">
                            <Loader2 size={16} className="animate-spin" />
                            Сохранение...
                        </span>
                    ) : saved ? (
                        <span className="flex items-center gap-2"><CheckCircle size={18} /> Сохранено!</span>
                    ) : (
                        <span className="flex items-center gap-2"><Save size={18} /> Сохранить</span>
                    )}
                </button>
            </div>
            {saveError && <p role="alert" className="mb-4 text-red-600">{saveError}</p>}
            <BusinessSetupStatus key={currentInstanceId} businessId={currentInstanceId} />

            <div className="space-y-6">
                <Section title="Профиль бизнеса" subtitle="Определяет логику AI и стадии воронки" icon={<Target size={20} className="text-violet-400" />}>
                    <div>
                        <label className="label">Тип бизнеса</label>
                        <select
                            name="businessType"
                            value={getBusinessType(formData)}
                            onChange={handleBusinessTypeChange}
                            className="input"
                        >
                            <option value="hotel">Отель</option>
                            <option value="standard">Обычный бизнес</option>
                            <option value="coffee_shop">Кофейня</option>
                        </select>
                        <p className="text-xs text-[#8b8fa3] mt-1">
                            {isCoffeeBusiness(formData)
                                ? 'Воронка заказов заканчивается подтверждённым самовывозом после принятия бариста.'
                                : getBusinessType(formData) === 'hotel'
                                    ? 'Единый профиль отеля используется в WhatsApp CRM и AVA для звонков, SIP, кампаний и базы знаний.'
                                    : 'Стандартная воронка продаж заканчивается успешной сделкой или записью.'}
                        </p>
                    </div>
                </Section>

                {/* ========== WHATSAPP GATEWAY (OPENWA + GREENAPI FALLBACK) ========== */}
                <Section title="WhatsApp" subtitle="Подключите телефон бизнеса. AVA автоматически настроит получение сообщений и связь с CRM.">
                    {/* Gateway Mode Selector */}
                    <div className="neu-flat p-4 mb-6">
                        <label className="label font-bold text-[var(--text-primary)] mb-2">
                            Режим отправки WhatsApp
                        </label>
                        <select
                            name="whatsappProvider"
                            value={formData.whatsappProvider || 'openwa'}
                            onChange={handleChange}
                            className="input"
                        >
                            <option value="openwa">OpenWA — Основной (с авто-переходом на Green API при сбое)</option>
                            <option value="green_api">Только Green API (резервный шлюз)</option>
                        </select>
                        <p className="text-xs text-[var(--text-secondary)] mt-2">
                            {formData.whatsappProvider === 'green_api'
                                ? 'Сообщения отправляются только через Green API.'
                                : 'По умолчанию все сообщения отправляются через OpenWA. Если OpenWA не отвечает или сессия разорвана, сообщение мгновенно отправляется через Green API.'}
                        </p>
                    </div>

                    {/* OpenWA Connection Options (Advanced) */}
                    <details className="mb-6 neu-flat p-4 group">
                        <summary className="text-xs font-bold text-[var(--text-secondary)] uppercase tracking-wider cursor-pointer select-none hover:text-[var(--text-primary)] transition-colors">
                            Продвинутые параметры шлюза OpenWA
                        </summary>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 pt-3 border-t border-[var(--neu-border)]">
                            <div>
                                <label className="label">OpenWA Host URL</label>
                                <input
                                    name="openWaUrl"
                                    value={formData.openWaUrl || ''}
                                    onChange={handleChange}
                                    className="input"
                                    placeholder="Системный шлюз OpenWA (по умолчанию)"
                                />
                            </div>
                            <div>
                                <label className="label">OpenWA API Key (X-API-Key)</label>
                                <input
                                    name="openWaApiKey"
                                    value={formData.openWaApiKey || ''}
                                    onChange={handleChange}
                                    className="input"
                                    type="password"
                                    placeholder="Системный ключ (по умолчанию)"
                                />
                            </div>
                            <div>
                                <div className="flex items-center justify-between">
                                    <label className="label">Session ID</label>
                                    <button
                                        type="button"
                                        onClick={handleCreateOpenWaSession}
                                        disabled={openWaSessionLoading}
                                        className="text-xs text-[var(--text-primary)] hover:underline flex items-center gap-1 font-bold"
                                    >
                                        {openWaSessionLoading ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
                                        Создать
                                    </button>
                                </div>
                                <input
                                    name="openWaSessionId"
                                    value={formData.openWaSessionId || ''}
                                    onChange={handleChange}
                                    className="input"
                                    placeholder="Авто-генерация"
                                />
                            </div>
                        </div>
                    </details>

                    {/* OpenWA Status Panel */}
                    <div className="neu-flat p-5 mb-8">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="font-semibold text-[var(--text-primary)] flex items-center gap-2">
                                <Power size={16} /> Подключение WhatsApp
                            </h3>
                            <button
                                onClick={() => checkOpenWaStatus(true)}
                                disabled={openWaStatusLoading}
                                className="min-h-11 px-2 focus-visible:outline focus-visible:outline-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center gap-1 transition-colors font-medium"
                            >
                                <RefreshCw size={12} className={openWaStatusLoading ? 'animate-spin' : ''} />
                                Обновить
                            </button>
                        </div>

                        {/* Status Badge */}
                        <div className="flex items-center gap-3 mb-4">
                            <StatusBadge state={openWaState} />
                            {openWaPhone && (
                                <span className="text-sm text-[var(--text-secondary)] flex items-center gap-1.5 font-medium">
                                    <Phone size={14} className="text-[var(--text-primary)]" />
                                    +{openWaPhone}
                                    {openWaPushName && <span className="text-[var(--text-primary)]">({openWaPushName})</span>}
                                </span>
                            )}
                        </div>

                        {/* Error message */}
                        {openWaActionError && (
                            <div role="alert" className="flex items-start gap-2 bg-red-500/10 text-red-600 px-4 py-3 rounded-2xl mb-4 text-sm border border-red-500/20">
                                <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
                                <span>{openWaActionError}</span>
                            </div>
                        )}

                        {/* QR Code Panel */}
                        {showOpenWaQr && (
                            <div className="neu-inset p-6 mb-4 flex flex-col items-center border border-[var(--neu-border)]">
                                <div className="flex items-center justify-between w-full max-w-sm mb-4">
                                    <span className="font-semibold text-[var(--text-primary)]">Подключите WhatsApp на телефоне</span>
                                    <button
                                        type="button"
                                        onClick={() => setShowOpenWaQr(false)}
                                        className="min-h-11 px-2 focus-visible:outline focus-visible:outline-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                                    >
                                        Скрыть
                                    </button>
                                </div>
                                {(openWaQrLoading || openWaSessionLoading) && !openWaQrCode ? (
                                    <div role="status" className="w-full max-w-[264px] min-h-[264px] flex flex-col gap-3 items-center justify-center">
                                        <Loader2 size={32} className="animate-spin text-[var(--text-primary)]" />
                                        <span className="text-sm text-[var(--text-secondary)]">Готовим подключение…</span>
                                    </div>
                                ) : openWaQrCode ? (
                                    <div className="bg-white p-3.5 rounded-2xl border border-[var(--neu-border)] shadow-sm">
                                        <img
                                            src={openWaQrCode.startsWith('data:') ? openWaQrCode : `data:image/png;base64,${openWaQrCode}`}
                                            alt="QR-код для подключения WhatsApp текущего бизнеса"
                                            className="w-full max-w-[240px] aspect-square"
                                        />
                                    </div>
                                ) : (
                                    <div className="w-full max-w-md p-5 bg-black/[0.02] border border-[var(--neu-border)] rounded-2xl text-center">
                                        <p className="text-sm font-semibold text-[var(--text-primary)] mb-1">
                                            Готовим QR-код
                                        </p>
                                        <p className="text-xs text-[var(--text-secondary)] mb-3">
                                            Обычно это занимает несколько секунд. Код появится автоматически.
                                        </p>
                                        <p className="text-xs text-[var(--text-secondary)]">
                                            Если код долго не появляется, нажмите «Подключить WhatsApp» ещё раз.
                                        </p>
                                    </div>
                                )}
                                <p className="text-xs text-[var(--text-secondary)] mt-4 text-center max-w-sm">
                                    WhatsApp → Связанные устройства → Привязка устройства
                                </p>
                            </div>
                        )}

                        {/* OpenWA Action Buttons */}
                        <div className="flex flex-wrap gap-2.5">
                            <button
                                type="button"
                                onClick={() => handleScanOpenWaQR()}
                                disabled={openWaSessionLoading}
                                className="btn-primary min-h-11 focus-visible:outline focus-visible:outline-2 text-xs px-4 py-2"
                            >
                                {openWaQrLoading ? <Loader2 size={13} className="animate-spin" /> : null}
                                {openWaSessionLoading ? 'Подключаем…' : showOpenWaQr && openWaQrCode ? 'Обновить QR-код' : 'Подключить WhatsApp'}
                            </button>
                            {(formData.openWaSessionId || openWaPhone) && (
                                <button type="button" onClick={() => handleScanOpenWaQR(true)} disabled={openWaSessionLoading}
                                    className="btn-secondary min-h-11 px-4 py-2 text-xs focus-visible:outline focus-visible:outline-2">
                                    Сменить номер
                                </button>
                            )}
                            <details className="w-full mt-2">
                                <summary className="min-h-11 flex items-center cursor-pointer text-sm text-[var(--text-secondary)]">Управление подключением</summary>
                                <div className="flex flex-wrap gap-2.5">
                            <button
                                onClick={handleStartOpenWa}
                                disabled={openWaActionLoading === 'start'}
                                className="btn-secondary text-xs px-4 py-2 border-emerald-600/30 text-emerald-800 hover:bg-emerald-600 hover:text-white"
                            >
                                {openWaActionLoading === 'start' ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
                                Запустить сессию
                            </button>
                            <button
                                onClick={handleSetupOpenWaWebhook}
                                disabled={openWaWebhookLoading}
                                className="btn-secondary text-xs px-4 py-2"
                            >
                                {openWaWebhookLoading ? <Loader2 size={13} className="animate-spin" /> : <Link size={13} />}
                                Настроить Webhook
                            </button>
                            <button
                                onClick={handleStopOpenWa}
                                disabled={openWaActionLoading === 'stop'}
                                className="btn-secondary text-xs px-4 py-2 border-amber-600/30 text-amber-800 hover:bg-amber-600 hover:text-white"
                            >
                                {openWaActionLoading === 'stop' ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
                                Остановить
                            </button>
                            {openWaState === 'authorized' && (
                                <button
                                    onClick={handleLogoutOpenWa}
                                    disabled={openWaActionLoading === 'logout'}
                                    className="btn-secondary text-xs px-4 py-2 border-red-600/30 text-red-700 hover:bg-red-600 hover:text-white"
                                >
                                    {openWaActionLoading === 'logout' ? <Loader2 size={13} className="animate-spin" /> : <LogOut size={13} />}
                                    Отключить
                                </button>
                            )}
                                </div>
                            </details>
                        </div>

                        {openWaWebhookResult && (
                            <div className={`mt-3 text-sm px-4 py-3 rounded-2xl flex items-start gap-2 border ${openWaWebhookResult.success
                                ? 'bg-emerald-500/10 text-emerald-800 border-emerald-500/20'
                                : 'bg-red-500/10 text-red-700 border-red-500/20'
                                }`}>
                                {openWaWebhookResult.success ? <CheckCircle size={16} className="mt-0.5 flex-shrink-0" /> : <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />}
                                <div>
                                    <p className="font-medium">{openWaWebhookResult.success ? 'Webhook успешно настроен' : 'Ошибка настройки Webhook'}</p>
                                    {openWaWebhookResult.url && <p className="text-xs opacity-75 mt-0.5 font-mono">{openWaWebhookResult.url}</p>}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* ========== GREEN API FALLBACK ========== */}
                    <div className="border-t border-[var(--neu-border)] pt-6">
                        <div className="mb-4">
                            <h3 className="font-semibold text-[var(--text-primary)] text-base">Запасной шлюз: Green API (Fallback)</h3>
                        </div>
                        <p className="text-xs text-[var(--text-secondary)] mb-4">
                            Используется автоматически, если OpenWA недоступен или выдал ошибку доставки.
                        </p>

                        {/* Credentials */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                            <div>
                                <label className="label">ID Instance (Green API)</label>
                                <input
                                    name="greenApiInstance"
                                    value={formData.greenApiInstance || ''}
                                    onChange={handleChange}
                                    className="input"
                                    placeholder="1103433560"
                                />
                            </div>
                            <div>
                                <label className="label">API Token (Green API)</label>
                                <input
                                    name="greenApiToken"
                                    value={formData.greenApiToken || ''}
                                    onChange={handleChange}
                                    className="input"
                                    type="password"
                                    placeholder="a96c709411904028..."
                                />
                            </div>
                        </div>
                        <div className="mb-4">
                            <label className="label">Green API URL (опционально)</label>
                            <input
                                name="greenApiUrl"
                                value={formData.greenApiUrl || 'https://api.green-api.com'}
                                onChange={handleChange}
                                className="input"
                                placeholder="https://api.green-api.com"
                            />
                        </div>

                        {/* Green API Status Panel */}
                        <div className="neu-flat p-5">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="font-semibold text-[var(--text-primary)] flex items-center gap-2">
                                    <Power size={16} /> Статус подключения Green API
                                </h3>
                                <button
                                    onClick={() => checkStatus(true)}
                                    disabled={statusLoading}
                                    className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center gap-1 transition-colors font-medium"
                                >
                                    <RefreshCw size={12} className={statusLoading ? 'animate-spin' : ''} />
                                    Обновить
                                </button>
                            </div>

                            {/* Status Badge */}
                            <div className="flex items-center gap-3 mb-4">
                                <StatusBadge state={connectionState} />
                                {waSettings?.phone && (
                                    <span className="text-sm text-[var(--text-secondary)] flex items-center gap-1.5 font-medium">
                                        <Phone size={14} className="text-[var(--text-primary)]" />
                                        +{waSettings.phone}
                                        {waSettings.pushName && <span className="text-[var(--text-primary)]">({waSettings.pushName})</span>}
                                    </span>
                                )}
                            </div>

                            {/* Error message */}
                            {actionError && (
                                <div className="flex items-start gap-2 bg-red-500/10 text-red-600 px-4 py-3 rounded-2xl mb-4 text-sm border border-red-500/20">
                                    <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
                                    <span>{actionError}</span>
                                </div>
                            )}

                            {/* QR Code Panel */}
                            {(showGreenApiQr || connectionState === 'notAuthorized') && (
                                <div className="neu-inset p-6 mb-4 flex flex-col items-center border border-[var(--neu-border)]">
                                    <div className="flex items-center justify-between w-full max-w-sm mb-4">
                                        <span className="font-semibold text-[var(--text-primary)]">Сканируйте QR-код Green API</span>
                                        <button
                                            type="button"
                                            onClick={() => setShowGreenApiQr(false)}
                                            className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                                        >
                                            Скрыть
                                        </button>
                                    </div>
                                    {qrLoading && !qrCode ? (
                                        <div className="w-[264px] h-[264px] flex items-center justify-center">
                                            <Loader2 size={32} className="animate-spin text-[var(--text-primary)]" />
                                        </div>
                                    ) : qrCode ? (
                                        <div className="bg-white p-3.5 rounded-2xl border border-[var(--neu-border)] shadow-sm">
                                            <img
                                                src={`data:image/png;base64,${qrCode}`}
                                                alt="QR Code"
                                                className="w-[240px] h-[240px]"
                                            />
                                        </div>
                                    ) : (
                                        <div className="w-[264px] h-[264px] flex items-center justify-center text-[var(--text-secondary)] text-sm">
                                            QR-код недоступен
                                        </div>
                                    )}
                                    <p className="text-xs text-[var(--text-secondary)] mt-4 text-center max-w-sm">
                                        Откройте <strong>WhatsApp Business</strong> на телефоне → Настройки → Привязанные устройства → Привязать устройство
                                    </p>
                                    <p className="text-xs text-[var(--text-secondary)] mt-1">
                                        QR обновляется автоматически каждые 5 секунд
                                    </p>
                                </div>
                            )}

                            {/* Action Buttons */}
                            <div className="flex flex-wrap gap-2.5">
                                <button
                                    type="button"
                                    onClick={handleScanGreenApiQR}
                                    disabled={qrLoading}
                                    className="btn-primary text-xs px-4 py-2"
                                >
                                    {qrLoading ? <Loader2 size={13} className="animate-spin" /> : null}
                                    {showGreenApiQr && qrCode ? 'Обновить QR-код' : 'Сканировать QR-код'}
                                </button>
                                <button
                                    onClick={handleSetupWebhook}
                                    disabled={webhookLoading || connectionState === 'error'}
                                    className="btn-secondary text-xs px-4 py-2"
                                >
                                    {webhookLoading ? <Loader2 size={13} className="animate-spin" /> : <Link size={13} />}
                                    Настроить Webhook
                                </button>
                                <button
                                    onClick={handleReboot}
                                    disabled={actionLoading === 'reboot'}
                                    className="btn-secondary text-xs px-4 py-2 border-amber-600/30 text-amber-800 hover:bg-amber-600 hover:text-white"
                                >
                                    {actionLoading === 'reboot' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                                    Перезагрузить
                                </button>
                                {connectionState === 'authorized' && (
                                    <button
                                        onClick={handleLogout}
                                        disabled={actionLoading === 'logout'}
                                        className="btn-secondary text-xs px-4 py-2 border-red-600/30 text-red-700 hover:bg-red-600 hover:text-white"
                                    >
                                        {actionLoading === 'logout' ? <Loader2 size={13} className="animate-spin" /> : <LogOut size={13} />}
                                        Отключить
                                    </button>
                                )}
                            </div>

                            {/* Webhook result */}
                            {webhookResult && (
                                <div className={`mt-3 text-sm px-4 py-3 rounded-2xl flex items-start gap-2 border ${webhookResult.success
                                    ? 'bg-emerald-500/10 text-emerald-800 border-emerald-500/20'
                                    : 'bg-red-500/10 text-red-700 border-red-500/20'
                                    }`}>
                                    {webhookResult.success ? <CheckCircle size={16} className="mt-0.5 flex-shrink-0" /> : <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />}
                                    <div>
                                        {webhookResult.success
                                            ? <>Webhook настроен: <code className="text-xs bg-black/5 px-1.5 py-0.5 rounded font-mono">{webhookResult.url}</code></>
                                            : 'Ошибка настройки webhook'
                                        }
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </Section>

                {/* ========== AI BRAIN ========== */}
                <Section title="AI Мозг" subtitle="Провайдер, модель и промпт" icon={<Brain size={20} className="text-purple-400" />}>
                    {currentInstanceId && <AiModelSettings businessId={currentInstanceId} canEdit />}
                    <details className="mt-4">
                        <summary className="cursor-pointer min-h-[44px]">Дополнительные настройки текстового AI</summary>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                            <div><label htmlFor="legacy-ai-format" className="label">Формат ответа</label><select id="legacy-ai-format" name="aiResponseFormat" value={formData.aiResponseFormat || 'json_object'} onChange={handleChange} className="input min-h-[44px]">
                                <option value="json_object">JSON (Универсальный Агент)</option><option value="text">Обычный текст</option>
                            </select></div>
                            <div><label htmlFor="legacy-aitunnel-key" className="label">AITunnel API Ключ</label><input id="legacy-aitunnel-key" name="yandexGptKey" value={formData.yandexGptKey || ''} onChange={handleChange} className="input min-h-[44px]" type="password" autoComplete="new-password" placeholder="sk-..." /></div>
                        </div>
                    </details>

                    <div className="mt-4">
                        <div className="flex items-center gap-2 mb-1.5">
                            <Thermometer size={14} className="text-orange-400" />
                            <label className="label mb-0">Температура: <span className="text-[#00c2ff] font-bold">{formData.aiTemperature || '0.3'}</span></label>
                        </div>
                        <input
                            name="aiTemperature"
                            type="range"
                            min="0" max="1" step="0.1"
                            value={formData.aiTemperature || 0.3}
                            onChange={handleChange}
                            className="w-full h-2 bg-[#22262f] rounded-lg appearance-none cursor-pointer accent-[#00c2ff]"
                        />
                        <div className="flex justify-between text-[10px] text-[#8b8fa3] mt-1">
                            <span>Строгий (0.0)</span>
                            <span>Креативный (1.0)</span>
                        </div>
                    </div>

                    <div className="mt-4">
                        <div className="flex items-center gap-2 mb-1.5">
                            <Target size={14} className="text-emerald-400" />
                            <label className="label mb-0">Цель продажи</label>
                        </div>
                        {isCoffeeBusiness(formData) ? (
                            <>
                                <div className="input flex items-center gap-2 text-amber-300">
                                    <Coffee size={16} />
                                    Заказ на самовывоз с подтверждением бариста
                                </div>
                                <p className="text-xs text-[#8b8fa3] mt-1">Для кофейни эта цель задаётся автоматически профилем бизнеса.</p>
                            </>
                        ) : (
                            <>
                                <select name="salesGoal" value={formData.salesGoal || 'call'} onChange={handleChange} className="input">
                                    <option value="call">📞 Созвон / Зум-колл</option>
                                    <option value="payment">💳 Оплата</option>
                                    <option value="human_handoff">👤 Передать живому менеджеру</option>
                                    <option value="booking">📅 Запись (YClients)</option>
                                </select>
                                <p className="text-xs text-[#8b8fa3] mt-1">К чему AI должен вести клиента на финальном этапе воронки</p>
                            </>
                        )}
                    </div>

                    <div className="mt-6">
                        <label className="label">Системный Промпт</label>
                        <p className="text-xs text-[#8b8fa3] mb-2">Опишите роль бота, прайс-лист, скрипты продаж</p>
                        <textarea
                            name="systemPrompt"
                            value={formData.systemPrompt || ''}
                            onChange={handleChange}
                            rows={8}
                            className="input h-auto font-mono text-sm leading-relaxed"
                            placeholder={"Ты — администратор салона красоты «Beauty».\nНаши услуги:\n- Стрижка: 1500₽\n- Окрашивание: 4000₽\n\nПравила:\n- Будь вежливым и профессиональным\n- Предлагай запись, если клиент заинтересован"}
                        />
                    </div>
                </Section>

                {/* ========== YCLIENTS ========== */}
                <Section title="YClients" subtitle="Онлайн-запись" icon={<Calendar size={20} className="text-orange-400" />}>
                    <div>
                        <label className="label">Ссылка на запись</label>
                        <input name="yclientsLink" value={formData.yclientsLink || ''} onChange={handleChange} className="input" placeholder="https://n1234.yclients.com/..." />
                        <p className="text-xs text-[#8b8fa3] mt-1">Бот отправит эту ссылку, когда клиент подтвердит запись</p>
                    </div>
                </Section>

                {/* ========== QUICK REPLY TEMPLATES ========== */}
                <Section title="Быстрые ответы" subtitle="Шаблоны сообщений для отправки в 1 клик из Kanban" icon={<MessageSquare size={20} className="text-[#00c2ff]" />}>
                    <p className="text-xs text-[#8b8fa3] mb-4">
                        Создайте шаблоны — они появятся на каждой карточке в разделе <strong className="text-white">Лиды</strong>.
                        При нажатии сообщение отправляется клиенту через WhatsApp мгновенно.
                    </p>

                    {/* Existing templates list */}
                    {templates.length > 0 && (
                        <div className="mb-4 space-y-2">
                            {templates.map((t: any) => (
                                <div key={t.id} className="flex items-start gap-3 bg-[#22262f] rounded-xl px-4 py-3 border border-[#2a2e3a]">
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-white truncate">{t.label}</p>
                                        <p className="text-xs text-[#8b8fa3] mt-0.5 line-clamp-2">{t.text}</p>
                                    </div>
                                    <button
                                        onClick={async () => {
                                            if (!currentInstanceId || !confirm(`Удалить шаблон "${t.label}"?`)) return;
                                            await deleteTemplate(currentInstanceId, t.id);
                                            setTemplates(prev => prev.filter(x => x.id !== t.id));
                                        }}
                                        className="text-[#6b6f80] hover:text-red-400 transition-colors flex-shrink-0"
                                        title="Удалить"
                                    >
                                        <Trash2 size={15} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {templates.length === 0 && (
                        <div className="text-center py-6 border-2 border-dashed border-[#2a2e3a] rounded-xl text-[#6b6f80] text-sm mb-4">
                            Нет шаблонов. Создайте первый ниже 👇
                        </div>
                    )}

                    {/* Add new template */}
                    <div className="bg-[#22262f] rounded-xl p-4 border border-[#2a2e3a] space-y-3">
                        <p className="text-xs font-medium text-[#8b8fa3]">Добавить шаблон</p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                                <label className="label">Название кнопки</label>
                                <input
                                    value={newTemplateLabel}
                                    onChange={e => setNewTemplateLabel(e.target.value)}
                                    className="input"
                                    placeholder="Добрый день!"
                                />
                            </div>
                            <div>
                                <label className="label">Текст сообщения</label>
                                <input
                                    value={newTemplateText}
                                    onChange={e => setNewTemplateText(e.target.value)}
                                    className="input"
                                    placeholder="Добрый день! Чем могу помочь?"
                                    onKeyDown={async e => {
                                        if (e.key === 'Enter' && newTemplateLabel && newTemplateText && currentInstanceId) {
                                            setTemplateLoading(true);
                                            const res = await createTemplate(currentInstanceId, { label: newTemplateLabel, text: newTemplateText });
                                            if (res.success) { setTemplates(prev => [...prev, res.template]); setNewTemplateLabel(''); setNewTemplateText(''); }
                                            setTemplateLoading(false);
                                        }
                                    }}
                                />
                            </div>
                        </div>
                        <button
                            disabled={!newTemplateLabel || !newTemplateText || templateLoading}
                            onClick={async () => {
                                if (!currentInstanceId || !newTemplateLabel || !newTemplateText) return;
                                setTemplateLoading(true);
                                try {
                                    const res = await createTemplate(currentInstanceId, { label: newTemplateLabel, text: newTemplateText });
                                    if (res.success) { setTemplates(prev => [...prev, res.template]); setNewTemplateLabel(''); setNewTemplateText(''); }
                                } catch { }
                                setTemplateLoading(false);
                            }}
                            className="flex items-center gap-2 text-sm px-4 py-2 bg-[#00c2ff]/10 text-[#00c2ff] rounded-lg hover:bg-[#00c2ff]/20 transition-all disabled:opacity-40 border border-[#00c2ff]/20"
                        >
                            {templateLoading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                            Добавить шаблон
                        </button>
                    </div>

                    {/* Popular presets */}
                    <div className="mt-4">
                        <p className="text-xs text-[#6b6f80] mb-2">Быстрые пресеты (нажмите чтобы добавить):</p>
                        <div className="flex flex-wrap gap-2">
                            {[
                                { label: '👋 Приветствие', text: 'Добрый день! Чем могу вам помочь?' },
                                { label: '📋 Отправь КП', text: 'Высылаем наше коммерческое предложение. Пожалуйста, ознакомьтесь!' },
                                { label: '✅ Запись подтверждена', text: 'Ваша запись подтверждена! Ждём вас.' },
                                { label: '📞 Перезвоним', text: 'Мы вам перезвоним в ближайшее время. Удобно?' },
                                { label: '🤔 Есть вопросы?', text: 'Добрый день! Остались ли у вас вопросы? С удовольствием помогу!' },
                            ].map(preset => (
                                <button
                                    key={preset.label}
                                    onClick={() => { setNewTemplateLabel(preset.label); setNewTemplateText(preset.text); }}
                                    className="text-[11px] px-2.5 py-1 rounded-full bg-[#22262f] border border-[#2a2e3a] text-[#8b8fa3] hover:text-white hover:border-[#00c2ff]/40 transition-all"
                                >
                                    {preset.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </Section>

                {/* ========== CRM ========== */}
                <Section title="Экспорт в CRM" subtitle="Отправка лидов во внешние системы" icon={<Database size={20} className="text-blue-400" />}>
                    <div className="mb-4">
                        <label className="label">CRM Система</label>
                        <select name="crmIntegration" value={formData.crmIntegration || 'none'} onChange={handleChange} className="input">
                            <option value="none">Отключено</option>
                            <option value="amocrm">AmoCRM</option>
                            <option value="bitrix24">Bitrix24</option>
                        </select>
                    </div>

                    {formData.crmIntegration === 'amocrm' && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 animate-in fade-in slide-in-from-top-2">
                            <div>
                                <label className="label">Домен AmoCRM</label>
                                <input name="amoCrmDomain" value={formData.amoCrmDomain || ''} onChange={handleChange} className="input" placeholder="test.amocrm.ru" />
                            </div>
                            <div>
                                <label className="label">Долгоживущий Access Token</label>
                                <input name="amoCrmAccessToken" value={formData.amoCrmAccessToken || ''} onChange={handleChange} className="input" type="password" placeholder="eyJhb..." />
                                <p className="text-xs text-[#8b8fa3] mt-1">Токен из интеграции AmoCRM</p>
                            </div>
                        </div>
                    )}

                    {formData.crmIntegration === 'bitrix24' && (
                        <div className="mt-4 animate-in fade-in slide-in-from-top-2">
                            <label className="label">URL Входящего Вебхука (Bitrix24)</label>
                            <input name="bitrix24WebhookUrl" value={formData.bitrix24WebhookUrl || ''} onChange={handleChange} className="input" placeholder="https://b24-xyz.bitrix24.ru/rest/1/abcxyz/" />
                            <p className="text-xs text-[#8b8fa3] mt-1">Убедитесь, что вебхук имеет права на редактирование CRM (crm)</p>
                        </div>
                    )}
                </Section>

                {/* ========== YOOKASSA PAYMENTS ========== */}
                <Section title="ЮKassa (Оплаты)" subtitle="Приём платежей от клиентов через WhatsApp" icon={<Database size={20} className="text-emerald-400" />}>
                    <p className="text-xs text-[#8b8fa3] mb-4">
                        Подключите ЮKassa для автоматической генерации ссылок на оплату. AI-агент «Closer» будет отправлять ссылки клиентам, готовым к покупке.
                        После оплаты статус лида автоматически сменится на «Успешно».
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="label">Shop ID</label>
                            <input
                                name="yookassaShopId"
                                value={formData.yookassaShopId || ''}
                                onChange={handleChange}
                                className="input"
                                placeholder="123456"
                            />
                            <p className="text-xs text-[#8b8fa3] mt-1">ID вашего магазина в ЮKassa</p>
                        </div>
                        <div>
                            <label className="label">Секретный ключ</label>
                            <input
                                name="yookassaSecretKey"
                                value={formData.yookassaSecretKey || ''}
                                onChange={handleChange}
                                className="input"
                                type="password"
                                placeholder="test_..."
                            />
                            <p className="text-xs text-[#8b8fa3] mt-1">Секретный ключ из настроек ЮKassa</p>
                        </div>
                    </div>
                    <div className="mt-4 bg-emerald-500/5 border border-emerald-500/20 rounded-xl px-4 py-3">
                        <p className="text-xs text-emerald-300/80">
                            💡 <strong>Как это работает:</strong> Когда клиент в статусе «Предложение» соглашается на цену, AI автоматически генерирует защищённую ссылку на оплату и отправляет в чат. После успешной оплаты лид переходит в «Успешно».
                        </p>
                    </div>
                    <div className="mt-3 bg-[#22262f] rounded-xl px-4 py-3 border border-[#2a2e3a]">
                        <p className="text-xs text-[#8b8fa3]">
                            📌 <strong>Webhook URL:</strong> Укажите в настройках ЮKassa url: <code className="bg-[#1a1d27] px-1.5 py-0.5 rounded text-[#e4e6eb]">{typeof window !== 'undefined' ? window.location.origin : ''}/api/payments/webhook</code>
                        </p>
                    </div>
                </Section>

                {/* ========== TELEGRAM BOT ========== */}
                <Section title="Telegram Bot" subtitle="Автоматический бот в Telegram" icon={<MessageSquare size={20} className="text-[#0088cc]" />}>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="label">Bot Token</label>
                            <input name="telegramBotToken" value={formData.telegramBotToken || ''} onChange={handleChange} className="input" type="password" placeholder="123456789:ABCDefgh..." />
                            <p className="text-xs text-[#8b8fa3] mt-1">Получите токен у @BotFather в Telegram</p>
                        </div>
                        <div>
                            <label className="label">Username бота</label>
                            <input name="telegramBotUsername" value={formData.telegramBotUsername || ''} onChange={handleChange} className="input" placeholder="my_crm_bot" disabled />
                            <p className="text-xs text-[#8b8fa3] mt-1">Заполнится автоматически при подключении</p>
                        </div>
                    </div>
                </Section>

                {/* ========== BARISTA TELEGRAM BOT ========== */}
                <Section title="Бот баристы (Telegram)" subtitle="Управление заказами и персоналом" icon={<Coffee size={20} className="text-amber-400" />}>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                        <div>
                            <label className="label">Токен бота баристы</label>
                            <input
                                name="baristaBotToken"
                                value={formData.baristaBotToken || ''}
                                onChange={handleChange}
                                className="input"
                                type="password"
                                placeholder="123456789:ABCDefgh..."
                            />
                            <p className="text-xs text-[#8b8fa3] mt-1">Токен для бота баристы от @BotFather</p>
                        </div>
                        <div>
                            <label className="label">Username бота баристы</label>
                            <input
                                name="baristaBotUsername"
                                value={formData.baristaBotUsername || ''}
                                className="input"
                                placeholder="barista_bot"
                                disabled
                            />
                            <p className="text-xs text-[#8b8fa3] mt-1">Устанавливается автоматически после запуска бота</p>
                        </div>
                        <div>
                            <label className="label">Код приглашения</label>
                            <div className="flex gap-2">
                                <input
                                    name="baristaInviteCode"
                                    value={formData.baristaInviteCode || ''}
                                    onChange={handleChange}
                                    className="input flex-1 font-mono"
                                    placeholder="Сгенерируйте код"
                                />
                                <button
                                    type="button"
                                    onClick={handleGenerateBaristaInviteCode}
                                    className="btn-secondary px-3"
                                    title="Сгенерировать новый код"
                                >
                                    <RefreshCw size={16} />
                                </button>
                            </div>
                            <p className="text-xs text-[#8b8fa3] mt-1">Без этого кода новый сотрудник не сможет подключиться</p>
                        </div>
                    </div>

                    <div className="flex flex-col gap-3 mb-6 bg-[#22262f] rounded-xl p-5 border border-[#2a2e3a]">
                        <h3 className="text-white font-medium flex items-center gap-2">
                            <Coffee size={16} /> Управление ботом
                        </h3>
                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                onClick={handleRestartBaristaBot}
                                disabled={restartLoading}
                                className="flex items-center gap-2 text-sm px-4 py-2.5 bg-amber-500/10 text-amber-400 rounded-lg hover:bg-amber-500/20 transition-all disabled:opacity-50 border border-amber-500/20"
                            >
                                {restartLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                                Запустить / Перезапустить бота
                            </button>
                            {restartResult && (
                                <span className="text-sm text-[#8b8fa3]">{restartResult}</span>
                            )}
                        </div>
                        {formData.baristaInviteCode && (
                            <div className="text-xs text-[#8b8fa3] space-y-1">
                                <p>
                                    Команда для сотрудника:{' '}
                                    <code className="bg-[#1a1d27] px-2 py-1 rounded text-amber-300">
                                        /start {formData.baristaInviteCode}
                                    </code>
                                </p>
                                {formData.baristaBotUsername && (
                                    <p>
                                        Ссылка:{' '}
                                        <a
                                            className="text-amber-400 hover:text-amber-300"
                                            href={`https://t.me/${String(formData.baristaBotUsername).replace(/^@/, '')}?start=${encodeURIComponent(formData.baristaInviteCode)}`}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            Открыть бота с кодом приглашения
                                        </a>
                                    </p>
                                )}
                                <p>Код сохраняется автоматически.</p>
                            </div>
                        )}
                    </div>

                    <div className="bg-[#22262f] rounded-xl p-5 border border-[#2a2e3a]">
                        <h3 className="text-white font-medium flex items-center gap-2 mb-4">
                            <Users size={16} /> Работающие бариста
                        </h3>
                        {baristaStaffLoading ? (
                            <div className="flex items-center justify-center py-6">
                                <Loader2 size={24} className="animate-spin text-amber-400" />
                            </div>
                        ) : baristaStaff.length > 0 ? (
                            <div className="space-y-2">
                                {baristaStaff.map((barista) => (
                                    <div key={barista.telegramChatId} className="flex items-center justify-between bg-[#1a1d27] rounded-lg px-4 py-3 border border-[#2a2e3a]">
                                        <div className="flex flex-col">
                                            <span className="text-sm font-medium text-white">{barista.name}</span>
                                            <span className="text-xs text-[#8b8fa3]">Chat ID: {barista.telegramChatId}</span>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => handleDeleteBarista(barista.telegramChatId, barista.name)}
                                            className="text-[#6b6f80] hover:text-red-400 transition-colors"
                                            title="Удалить сотрудника"
                                        >
                                            <UserMinus size={18} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="text-center py-6 border-2 border-dashed border-[#2a2e3a] rounded-xl text-[#6b6f80] text-sm">
                                Нет активных бариста. Сотрудник должен открыть ссылку приглашения или отправить боту команду <strong>/start КОД</strong>.
                            </div>
                        )}
                    </div>
                </Section>

                {/* ========== EMAIL ========== */}
                <Section title="Email (SMTP / IMAP)" subtitle="Отправка и приём писем" icon={<MessageSquare size={20} className="text-[#EA4335]" />}>
                    <p className="text-xs text-[#8b8fa3] mb-4">Настройте SMTP для отправки и IMAP для получения email. Используйте App Password для Gmail.</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                        <div>
                            <label className="label">SMTP Host</label>
                            <input name="emailSmtpHost" value={formData.emailSmtpHost || ''} onChange={handleChange} className="input" placeholder="smtp.gmail.com" />
                        </div>
                        <div>
                            <label className="label">SMTP Port</label>
                            <input name="emailSmtpPort" value={formData.emailSmtpPort || '587'} onChange={handleChange} className="input" placeholder="587" />
                        </div>
                        <div>
                            <label className="label">Email (логин)</label>
                            <input name="emailSmtpUser" value={formData.emailSmtpUser || ''} onChange={handleChange} className="input" placeholder="your@gmail.com" />
                        </div>
                        <div>
                            <label className="label">Пароль SMTP</label>
                            <input name="emailSmtpPass" value={formData.emailSmtpPass || ''} onChange={handleChange} className="input" type="password" placeholder="App Password" />
                        </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="label">IMAP Host</label>
                            <input name="emailImapHost" value={formData.emailImapHost || ''} onChange={handleChange} className="input" placeholder="imap.gmail.com" />
                        </div>
                        <div>
                            <label className="label">IMAP Port</label>
                            <input name="emailImapPort" value={formData.emailImapPort || '993'} onChange={handleChange} className="input" placeholder="993" />
                        </div>
                        <div>
                            <label className="label">IMAP логин</label>
                            <input name="emailImapUser" value={formData.emailImapUser || ''} onChange={handleChange} className="input" placeholder="your@gmail.com" />
                        </div>
                        <div>
                            <label className="label">IMAP пароль</label>
                            <input name="emailImapPass" value={formData.emailImapPass || ''} onChange={handleChange} className="input" type="password" placeholder="App Password" />
                        </div>
                    </div>
                    <div className="mt-4">
                        <label className="label">Имя отправителя</label>
                        <input name="emailFromName" value={formData.emailFromName || ''} onChange={handleChange} className="input" placeholder="Beauty Salon CRM" />
                    </div>
                </Section>

                {/* ========== SMART TRIGGERS TOGGLE ========== */}
                <Section title="Умные триггеры" subtitle="Автоматические действия по событиям" icon={<Bell size={20} className="text-amber-400" />}>
                    <div className="flex items-center justify-between bg-[#22262f] rounded-xl px-4 py-3 border border-[#2a2e3a]">
                        <div>
                            <p className="text-white text-sm font-medium">Включить триггеры</p>
                            <p className="text-xs text-[#8b8fa3] mt-0.5">Позволяет автоматически реагировать на события (тишина, ключевые слова, смена статуса)</p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input
                                type="checkbox"
                                className="sr-only peer"
                                checked={!!formData.smartTriggersEnabled && formData.smartTriggersEnabled !== '0' && formData.smartTriggersEnabled !== 0}
                                onChange={e => {
                                    setFormData({ ...formData, smartTriggersEnabled: e.target.checked ? 1 : 0 });
                                    setSaved(false);
                                }}
                            />
                            <div className="w-11 h-6 bg-[#2a2e3a] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-500"></div>
                        </label>
                    </div>
                    <div className="mt-3">
                        <a href="/triggers" className="text-sm text-amber-400 hover:text-amber-300 transition-colors">
                            → Управление триггерами и цепочками
                        </a>
                    </div>
                </Section>

                {/* ========== LANGUAGE & PERSONALIZATION ========== */}
                <Section title="Язык и персонализация" subtitle="Автоперевод и настройки языка" icon={<Brain size={20} className="text-cyan-400" />}>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="label">Язык бизнеса по умолчанию</label>
                            <select name="defaultLanguage" value={formData.defaultLanguage || 'ru'} onChange={handleChange} className="input">
                                <option value="ru">Русский</option>
                                <option value="en">English</option>
                                <option value="de">Deutsch</option>
                                <option value="fr">Français</option>
                                <option value="es">Español</option>
                                <option value="tr">Türkçe</option>
                                <option value="ar">العربية</option>
                                <option value="zh">中文</option>
                            </select>
                        </div>
                        <div className="flex items-center">
                            <div className="flex items-center justify-between w-full bg-[#22262f] rounded-xl px-4 py-3 border border-[#2a2e3a]">
                                <div>
                                    <p className="text-white text-sm font-medium">Автоперевод</p>
                                    <p className="text-xs text-[#8b8fa3] mt-0.5">AI переводит сообщения на язык клиента</p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input
                                        type="checkbox"
                                        className="sr-only peer"
                                        checked={!!formData.autoTranslate && formData.autoTranslate !== '0' && formData.autoTranslate !== 0}
                                        onChange={e => {
                                            setFormData({ ...formData, autoTranslate: e.target.checked ? 1 : 0 });
                                            setSaved(false);
                                        }}
                                    />
                                    <div className="w-11 h-6 bg-[#2a2e3a] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
                                </label>
                            </div>
                        </div>
                    </div>
                </Section>

                {/* ========== AUTO FOLLOW-UP ========== */}
                <Section title="Авто Фоллоу-ап" subtitle="Автоматическое напоминание о себе, если клиент молчит" icon={<Bell size={20} className="text-amber-400" />}>
                    {/* Enable toggle */}
                    <div className="flex items-center justify-between mb-5 bg-[#22262f] rounded-xl px-4 py-3 border border-[#2a2e3a]">
                        <div>
                            <p className="text-white text-sm font-medium">Авто Следующее</p>
                            <p className="text-xs text-[#8b8fa3] mt-0.5">Бот сам напишет клиенту, если тот молчит указанное время</p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input
                                type="checkbox"
                                className="sr-only peer"
                                checked={!!formData.followUpEnabled && formData.followUpEnabled !== '0' && formData.followUpEnabled !== 0}
                                onChange={e => {
                                    setFormData({ ...formData, followUpEnabled: e.target.checked ? 1 : 0 });
                                    setSaved(false);
                                }}
                            />
                            <div className="w-11 h-6 bg-[#2a2e3a] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#00c2ff]"></div>
                        </label>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="label">Задержка (часов)</label>
                            <input
                                name="followUpDelay"
                                type="number"
                                min="1"
                                max="720"
                                value={formData.followUpDelay || '48'}
                                onChange={handleChange}
                                className="input"
                                placeholder="48"
                            />
                            <p className="text-xs text-[#8b8fa3] mt-1">Через сколько часов молчания отправить сообщение. По умолчанию: 48ч</p>
                        </div>
                        <div>
                            <label className="label">Текст сообщения</label>
                            <textarea
                                name="followUpText"
                                value={formData.followUpText || 'Добрый день! Остались ли у вас вопросы? Буду рад помочь 😊'}
                                onChange={handleChange}
                                rows={3}
                                className="input h-auto"
                                placeholder="Добрый день! Остались ли у вас вопросы?"
                            />
                            <p className="text-xs text-[#8b8fa3] mt-1">Мягкое напоминание. Отправляется один раз за период молчания</p>
                        </div>
                    </div>

                    {(!!formData.followUpEnabled && formData.followUpEnabled !== '0' && formData.followUpEnabled !== 0) && (
                        <div className="mt-4 bg-amber-500/5 border border-amber-500/20 rounded-xl px-4 py-3 flex items-start gap-2.5">
                            <Bell size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
                            <p className="text-xs text-amber-300/80">
                                Авто фоллоу-ап <strong>включён</strong>. Бот будет автоматически писать лидам, которые молчат более {formData.followUpDelay || 48} часов
                                (кроме лидов во статусе «Успешно» / «Отказ»).
                            </p>
                        </div>
                    )}
                </Section>

                {/* ========== PUSH NOTIFICATIONS ========== */}
                <Section title="Push-уведомления" subtitle="Браузерные уведомления о новых лидах и запросах помощи" icon={<Bell size={20} className="text-blue-400" />}>
                    <p className="text-xs text-[#8b8fa3] mb-4">
                        При первом открытии сайта браузер попросит разрешение на уведомления. После подтверждения
                        вы будете получать мгновенные уведомления о новых лидах и запросах <code className="bg-[#22262f] px-1 rounded">human_help</code> от ИИ.
                    </p>
                    <div className="flex items-center gap-3">
                        <button
                            disabled={pushTestLoading}
                            onClick={async () => {
                                setPushTestLoading(true);
                                setPushTestResult(null);
                                try {
                                    await testPushNotification(currentInstanceId || undefined);
                                    setPushTestResult('✅ Тестовое push-уведомление отправлено!');
                                } catch {
                                    setPushTestResult('❌ Ошибка. Убедитесь что уведомления разрешены в браузере.');
                                }
                                setPushTestLoading(false);
                                setTimeout(() => setPushTestResult(null), 4000);
                            }}
                            className="flex items-center gap-2 text-sm px-4 py-2.5 bg-blue-500/10 text-blue-400 rounded-lg hover:bg-blue-500/20 transition-all disabled:opacity-50 border border-blue-500/20"
                        >
                            {pushTestLoading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                            Отправить тест
                        </button>
                        {pushTestResult && (
                            <span className="text-sm text-[#8b8fa3]">{pushTestResult}</span>
                        )}
                    </div>
                    <div className="mt-4 bg-blue-500/5 border border-blue-500/15 rounded-xl px-4 py-3">
                        <p className="text-xs text-blue-300/80">
                            💡 Если кнопка не работает — откройте настройки браузера и проверьте что уведомления для этого сайта
                            <strong> разрешены</strong>. После разрешения обновите страницу.
                        </p>
                    </div>
                </Section>
            </div>
        </div>
    );
}

// ===================== Status Badge =====================

function StatusBadge({ state }: { state: ConnectionState }) {
    const configs: Record<ConnectionState, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
        notConfigured: { label: 'Не настроено', color: 'text-stone-500', bg: 'bg-stone-500/10', icon: <AlertCircle size={12} /> },
        loading: { label: 'Загрузка...', color: 'text-blue-600', bg: 'bg-blue-600/10', icon: <Loader2 size={12} className="animate-spin" /> },
        authorized: { label: 'Подключён', color: 'text-emerald-700', bg: 'bg-emerald-500/10', icon: <CheckCircle size={12} /> },
        notAuthorized: { label: 'Ожидает сканирования QR', color: 'text-amber-700', bg: 'bg-amber-500/10', icon: <QrCode size={12} /> },
        disconnected: { label: 'Не подключён', color: 'text-stone-500', bg: 'bg-stone-500/10', icon: <Power size={12} /> },
        blocked: { label: 'Заблокирован', color: 'text-red-600', bg: 'bg-red-500/10', icon: <AlertCircle size={12} /> },
        starting: { label: 'Запускается...', color: 'text-blue-600', bg: 'bg-blue-600/10', icon: <Loader2 size={12} className="animate-spin" /> },
        yellowCard: { label: 'Предупреждение', color: 'text-amber-700', bg: 'bg-amber-500/10', icon: <AlertCircle size={12} /> },
        sleepMode: { label: 'Спящий режим', color: 'text-stone-500', bg: 'bg-stone-500/10', icon: <Power size={12} /> },
        error: { label: 'Ошибка', color: 'text-red-600', bg: 'bg-red-500/10', icon: <AlertCircle size={12} /> },
    };
    const cfg = configs[state] || configs.error;

    return (
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${cfg.color} ${cfg.bg} px-3 py-1.5 rounded-full border border-current/20`}>
            {cfg.icon}
            {cfg.label}
        </span>
    );
}

// ===================== Section =====================

function Section({ title, subtitle, icon, children }: { title: string, subtitle?: string, icon?: React.ReactNode, children: React.ReactNode }) {
    return (
        <div className="card">
            <div className="card-header">
                {icon && icon}
                <div>
                    <h2 className="font-semibold text-[var(--text-primary)]">{title}</h2>
                    {subtitle && <p className="text-xs text-[var(--text-secondary)]">{subtitle}</p>}
                </div>
            </div>
            <div className="card-body">
                {children}
            </div>
        </div>
    );
}
