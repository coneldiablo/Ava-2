import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

type Module = { business_id: number; module: 'twenty' | 'onyx'; state: string; start_url?: string; allowed_actions: string[]; error_code?: string | null };
function canOpen(row?: Module) {
    return row?.state === 'verified' && row.allowed_actions?.includes('open')
        && /^https:\/\/[a-z0-9][a-z0-9-]*\.(crm|knowledge)\.meludtech\.tech\/ava-auth\/start$/.test(row.start_url || '');
}
export default function ModuleNavigation({ businessId }: { businessId: number }) {
    const [modules, setModules] = useState<Module[]>([]);
    const [error, setError] = useState(false);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        let active = true;
        let controller: AbortController;
        let timer: ReturnType<typeof setTimeout>;
        setModules([]); setError(false); setLoading(true);
        async function refresh() {
            controller = new AbortController();
            const deadline = setTimeout(() => controller.abort(), 15000);
            try {
                const response = await fetch(`/api/businesses/${businessId}/modules`, { credentials: 'same-origin', signal: controller.signal });
                if (!response.ok) throw new Error();
                const data = await response.json();
                if (!Array.isArray(data.modules) || data.modules.some((item: Module) => item.business_id !== businessId)) throw new Error();
                if (active) { setModules(data.modules); setError(false); setLoading(false); }
            } catch (_) { if (active) { setError(true); setModules([]); setLoading(false); } }
            finally { clearTimeout(deadline); if (active) timer = setTimeout(refresh, 10000); }
        }
        void refresh();
        return () => { active = false; controller?.abort(); clearTimeout(timer); };
    }, [businessId]);
    return <section className="card space-y-4 p-5" aria-labelledby="ava-modules-title">
        <h2 id="ava-modules-title" className="text-xl font-semibold">Модули вашего бизнеса</h2>
        <nav aria-label="Рабочие разделы AVA" className="flex flex-wrap gap-3">
            <Link to="/leads" className="btn-primary min-h-[44px] px-4">Воронка клиентов</Link>
            <Link to="/all-leads" className="btn-secondary min-h-[44px] px-4">Все клиенты</Link>
            <Link to="/conversations" className="btn-secondary min-h-[44px] px-4">Диалоги</Link>
        </nav>
        <p className="text-sm">Дополнительные кабинеты открываются с вашим доступом AVA. Документы своего бизнеса можно редактировать в разделе «База знаний» внутри AVA.</p>
        <nav aria-label="Разделы AVA" className="flex flex-wrap items-center gap-3">
            {(['twenty', 'onyx'] as const).map(module => {
                const row = modules.find(item => item.module === module);
                const label = module === 'twenty' ? 'CRM-модуль' : 'Кабинет знаний';
                const ready = canOpen(row);
                const status = error ? 'временно недоступен' : loading ? 'проверяем доступ'
                    : row?.state === 'failed' ? 'ошибка подключения' : row?.state === 'revoked' ? 'доступ отозван'
                        : row?.state === 'verified' ? 'ссылка недоступна'
                            : row?.error_code && row.error_code !== 'MODULE_NOT_CONFIGURED' ? 'временно недоступен' : 'не подключён';
                return ready ? <a key={module} href={row?.start_url} className="btn-primary min-h-[44px] px-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4">Открыть {label}</a>
                    : <span key={module} className="inline-flex min-h-[44px] items-center px-4">{label} — {status}</span>;
            })}
        </nav>
        {(error || loading || !(['twenty', 'onyx'] as const).every(module => canOpen(modules.find(item => item.module === module)))) && <p className="text-sm leading-relaxed" role="status">{error
            ? 'Не удалось проверить доступ к дополнительным разделам. Повторим автоматически.'
            : loading ? 'Проверяем доступ к дополнительным разделам.'
                : !(['twenty', 'onyx'] as const).every(module => canOpen(modules.find(item => item.module === module)))
                    ? 'Дополнительные кабинеты доступны после подключения. Статус обновляется автоматически.'
                : ''}</p>}
    </section>;
}
