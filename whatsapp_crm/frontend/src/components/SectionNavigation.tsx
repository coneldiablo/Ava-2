import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useInstance } from '../context/InstanceContext';
import { canAccessRoute } from '../permissions';
import './ProductUi.css';

const sections = [
    { name: 'Продажи', items: [['/deals', 'Сделки'], ['/leads', 'Клиенты по этапам'], ['/opportunities', 'Открытые запросы']] },
    { name: 'Результаты', items: [['/analytics', 'Обзор'], ['/workspace-analytics', 'Команда'], ['/reports', 'Отчёты']] },
    { name: 'Автоматизация', items: [['/autopilot', 'Режим AVA'], ['/triggers', 'Сценарии'], ['/outbound', 'Кампании']] },
];
export default function SectionNavigation() {
    const { pathname, search } = useLocation();
    const auth = useAuth(); const { currentInstanceId } = useInstance();
    const section = sections.find(group => group.items.some(([path]) => path === pathname));
    if (!section) return null;
    const days = new URLSearchParams(search).get('days');
    const suffix = section.name === 'Результаты' && ['7', '30', '90'].includes(days || '') ? `?days=${days}` : '';
    const items = section.items.filter(([path]) => canAccessRoute({ ...auth, permissionsLoading: false }, currentInstanceId, path));
    if (items.length < 2) return null;
    return <nav className="ava-section-nav" aria-label={section.name}>{items.map(([path, label]) =>
        <Link key={path} to={path + suffix} aria-current={pathname === path ? 'page' : undefined}>{label}</Link>
    )}</nav>;
}
