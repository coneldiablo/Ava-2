import { useSearchParams } from 'react-router-dom';
import { customerListView } from './customerListHelpers';

export default function CustomerListScope({ role }: { role: string }) {
    const [params, setParams] = useSearchParams();
    const filtered = ['status', 'activity', 'createdFrom', 'createdTo'].some(key => params.has(key));
    return <nav className="ava-customer-scope" aria-label="Выборка клиентов">
        {([['mine', 'Мои'], ['queue', 'Без ответственного'], ['all', 'Все доступные']] as const)
            .filter(([view]) => view !== 'mine' || role !== 'observer').map(([view, label]) =>
                <button type="button" key={view} aria-pressed={customerListView(params, role) === view}
                    onClick={() => setParams(previous => { const next = new URLSearchParams(previous); next.set('view', view); return next; })}>{label}</button>)}
        {role === 'observer' && <span>Только просмотр</span>}
        {filtered && <button type="button" onClick={() => setParams(previous => {
            const next = new URLSearchParams(previous); ['status', 'activity', 'createdFrom', 'createdTo'].forEach(key => next.delete(key)); return next;
        })}>Сбросить выборку отчёта</button>}
        {params.get('createdFrom') && <span>Созданы: {params.get('createdFrom')} — {params.get('createdTo') || 'сегодня'}</span>}
    </nav>;
}
