import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { getProvisioningStatus, retryProvisioning } from '../api';

type ModuleState = {
    status: string; stage: string; nextAttemptAt: string | null;
    allowedActions?: string[]; errorCode?: string | null;
};
type SetupState = { businessId: number; overallStatus: string; modules: Record<string, ModuleState> };
const names: Record<string, string> = {
    knowledge_base: 'База знаний', crm_workspace: 'CRM', onyx_runtime: 'Ответы по знаниям',
    telephony_sip: 'Телефония', whatsapp: 'WhatsApp', pms: 'Система бронирования',
};
const labels: Record<string, string> = {
    DONE: 'Подготовлено', LEASED: 'Подключаем', PENDING: 'Ожидает подключения',
    FAILED: 'Не удалось подключить', BLOCKED: 'Ожидает предыдущий шаг', SKIPPED: 'Нужно действие',
};

export default function BusinessSetupStatus({ businessId, canRetry = true, customerView = false }: { businessId: number; canRetry?: boolean; customerView?: boolean }) {
    const [state, setState] = useState<SetupState | null>(null);
    const [error, setError] = useState('');
    const [retrying, setRetrying] = useState<string | null>(null);
    const [refresh, setRefresh] = useState(0);
    const [refreshing, setRefreshing] = useState(false);
    const [checkedAt, setCheckedAt] = useState('');
    const activeBusiness = useRef(businessId);
    activeBusiness.current = businessId;

    useEffect(() => {
        setState(null);
        setRefreshing(true);
        setError('');
        setRetrying(null);
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const response = await getProvisioningStatus(businessId, controller.signal);
                if (controller.signal.aborted) return;
                if (Number(response.provisioning?.businessId) !== businessId) throw new Error('scope');
                setState(response.provisioning);
                setError('');
                setCheckedAt(new Date().toLocaleTimeString('ru-RU'));
            } catch (_) {
                if (!controller.signal.aborted) setError('Не удалось обновить состояние подключения. Попробуйте ещё раз.');
            }
            if (!controller.signal.aborted) setRefreshing(false);
            if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
        };
        void poll();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [businessId, refresh]);

    const retry = async (module: string) => {
        if (retrying) return;
        setRetrying(module);
        try {
            await retryProvisioning(businessId, module);
            if (activeBusiness.current === businessId) setRefresh(value => value + 1);
        } catch (_) {
            if (activeBusiness.current === businessId) setError('Повторная попытка не запущена. Обновите состояние и попробуйте ещё раз.');
        } finally {
            if (activeBusiness.current === businessId) setRetrying(null);
        }
    };
    const visible = state?.businessId === businessId ? state : null;
    return <section className="card mb-6" aria-label="Подключение бизнеса">
        <div className="card-header flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold text-neu-text">{customerView ? 'Готовность сервисов' : 'Подключение бизнеса'}</h2>
            {!customerView && <button type="button" disabled={refreshing} onClick={() => { setRefreshing(true); setRefresh(value => value + 1); }}
                className="btn-secondary min-h-[44px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
                <RefreshCw size={16} aria-hidden="true" /> {refreshing ? 'Обновляем…' : 'Обновить'}
            </button>}
        </div>
        <div className="card-body">
            {customerView
                ? <p className="mb-4 text-sm text-neu-muted">Здесь видно, какие возможности уже подключены. Статус обновляется автоматически.</p>
                : <p className="mb-4 text-sm text-neu-muted">Этот раздел показывает очередь автоматической настройки. «Обновить» повторно проверяет её состояние, но не запускает установку модулей.</p>}
            {checkedAt && <p role="status" className="mb-3 text-sm">Состояние проверено в {checkedAt}.</p>}
            {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
            {!visible && !error && <p role="status" aria-busy="true">Проверяем подключение…</p>}
            {visible && Object.keys(visible.modules).length === 0 && <p role="status">Статус подключений пока не отображается. Проверьте настройки, WhatsApp и документы в разделах выше.</p>}
            <ul className="space-y-3" aria-live="polite">
                {Object.entries(visible?.modules || {}).map(([name, module]) => <li key={name}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neu-muted/20 p-3">
                    <div>
                        <p className="font-medium text-neu-text">{names[name] || 'Дополнительный модуль'}</p>
                        <p className="text-sm text-neu-muted">{customerView
                            ? module.status === 'DONE' ? (name === 'telephony_sip' ? 'Настройки применены; звонок ещё нужно проверить' : 'Настроено')
                                : module.status === 'FAILED' ? 'Нужна помощь поддержки AVA'
                                    : module.status === 'SKIPPED' ? 'Нужны данные для подключения' : 'Подключается'
                            : labels[module.status] || 'Проверка состояния'}
                            {!customerView && module.stage === 'requires_verification' ? ' · требуется контрольная проверка' : ''}</p>
                        {!customerView && module.status === 'PENDING' && module.nextAttemptAt && <p className="text-sm text-neu-muted">
                            Следующая попытка: {new Date(module.nextAttemptAt.endsWith('Z') ? module.nextAttemptAt : `${module.nextAttemptAt.replace(' ', 'T')}Z`).toLocaleString('ru-RU')}
                        </p>}
                        {name === 'telephony_sip' && module.status !== 'DONE' && <p className="text-sm text-neu-muted">Для звонков требуется подключение оператора связи.</p>}
                        {name === 'whatsapp' && module.status !== 'DONE' && <p className="text-sm text-neu-muted">В разделе WhatsApp нажмите «Подключить WhatsApp» и отсканируйте QR телефоном.</p>}
                        {!customerView && module.errorCode && <p className="text-xs text-neu-muted">Код для поддержки: {module.errorCode}</p>}
                    </div>
                    {!customerView && canRetry && module.allowedActions?.includes('retry') && <button type="button" disabled={Boolean(retrying)}
                        onClick={() => void retry(name)} aria-label={`Повторить подключение: ${names[name] || name}`}
                        className="btn-secondary min-h-[44px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
                        {retrying === name ? 'Запускаем…' : 'Повторить'}
                    </button>}
                </li>)}
            </ul>
            <p className="mt-4 text-sm text-neu-muted">Готовность телефонии подтверждается отдельным контрольным разговором.</p>
        </div>
    </section>;
}
