import { Activity, BarChart2, BookOpen, Bot, BriefcaseBusiness, Building2, CalendarDays, Coffee, FileBarChart2, FilePenLine, LayoutDashboard, MessageSquare, MessageSquareText, PhoneCall, PhoneOutgoing, Radio, Route, Settings, Sparkles, Users, UserPlus, Workflow, Zap, type LucideIcon } from 'lucide-react';

type NavigationItem = { to: string; label: string; group: string; icon: LucideIcon; ai?: boolean };
export type WorkspaceNavigationContext = {
    role?: string;
    isPlatformAdmin?: boolean;
    showGuide?: boolean;
    showCoffeeOps?: boolean;
    workspaceEnabled?: boolean;
    canAccess: (path: string) => boolean;
};

const roleWorkspaces: Record<string, { landing: string; label: string; primary: readonly string[] }> = {
    hotel_owner: { landing: '/', label: 'Сегодня', primary: ['/', '/conversations', '/clients', '/deals', '/analytics'] },
    sales_lead: { landing: '/today', label: 'Сегодня', primary: ['/today', '/conversations', '/clients', '/deals', '/team'] },
    manager: { landing: '/today', label: 'Мой день', primary: ['/today', '/conversations', '/clients', '/sales'] },
    observer: { landing: '/today', label: 'Обзор', primary: ['/today', '/conversations', '/clients', '/sales'] },
    platform_admin: { landing: '/', label: 'Рабочий день', primary: ['/', '/conversations', '/clients', '/analytics'] },
};
const defaultWorkspace = { landing: '/', label: 'Рабочий день', primary: ['/', '/today'] };

export function getRoleWorkspace(role?: string) {
    return roleWorkspaces[role ?? ''] ?? defaultWorkspace;
}

// Canonical destinations also supply titles for existing deep links.
export const workspaceNavigation: readonly NavigationItem[] = [
    { to: '/', label: 'Главная', group: 'Рабочее пространство', icon: LayoutDashboard },
    { to: '/today', label: 'Рабочий день', group: 'Рабочее пространство', icon: CalendarDays },
    { to: '/conversations', label: 'Обращения', group: 'Общение', icon: MessageSquare },
    { to: '/clients', label: 'Клиенты', group: 'Продажи', icon: Users },
    { to: '/deals', label: 'Сделки', group: 'Продажи', icon: BriefcaseBusiness },
    { to: '/sales', label: 'Задачи', group: 'Продажи', icon: Workflow },
    { to: '/leads', label: 'Клиенты по этапам', group: 'Продажи', icon: Workflow },
    { to: '/opportunities', label: 'Открытые запросы', group: 'Продажи', icon: Sparkles },
    { to: '/calls', label: 'История звонков', group: 'Общение', icon: PhoneCall },
    { to: '/quick-replies', label: 'Быстрые ответы', group: 'Общение', icon: MessageSquareText },
    { to: '/analytics', label: 'Результаты', group: 'Результаты', icon: BarChart2 },
    { to: '/workspace-analytics', label: 'Работа команды', group: 'Результаты', icon: BarChart2 },
    { to: '/reports', label: 'Отчёты', group: 'Результаты', icon: FileBarChart2 },
    { to: '/activity', label: 'История изменений', group: 'Результаты', icon: Activity },
    { to: '/autopilot', label: 'Автоматизация', group: 'Автоматизация', icon: Bot },
    { to: '/knowledge-base', label: 'База знаний', group: 'AVA', icon: BookOpen, ai: true },
    { to: '/business-gpt', label: 'Помощник AVA', group: 'AVA', icon: MessageSquareText, ai: true },
    { to: '/studio', label: 'Предложения и документы', group: 'AVA', icon: FilePenLine, ai: true },
    { to: '/simulator', label: 'Проверка ассистента', group: 'Настройки', icon: BookOpen },
    { to: '/outbound', label: 'Кампании', group: 'Автоматизация', icon: PhoneOutgoing },
    { to: '/triggers', label: 'Сценарии', group: 'Автоматизация', icon: Zap },
    { to: '/getting-started', label: 'Начало работы', group: 'Настройки', icon: Route },
    { to: '/channels', label: 'Каналы связи', group: 'Настройки', icon: Radio },
    { to: '/integrations', label: 'Настройки бизнеса', group: 'Настройки', icon: Settings },
    { to: '/team', label: 'Команда', group: 'Настройки', icon: UserPlus },
    { to: '/instances', label: 'Мои бизнесы', group: 'Настройки', icon: Building2 },
    { to: '/coffee', label: 'Операции кофейни', group: 'Настройки', icon: Coffee },
];

function roleLabel(item: NavigationItem, role?: string): NavigationItem {
    if (item.to === '/today') return { ...item, label: getRoleWorkspace(role).label };
    if (role === 'platform_admin') {
        if (item.to === '/integrations') return { ...item, label: 'Интеграции' };
        if (item.to === '/instances') return { ...item, label: 'Бизнесы' };
        if (item.to === '/analytics') return { ...item, label: 'Аналитика' };
    }
    return item;
}

export function getWorkspaceNavigation(context: WorkspaceNavigationContext) {
    const role = context.isPlatformAdmin ? 'platform_admin' : context.role;
    const profile = getRoleWorkspace(role);
    // With the unified inbox enabled these URLs render the same workspace.
    // Keep both destinations when the legacy fallback is active or unknown.
    const unifiedInbox = !context.isPlatformAdmin && context.workspaceEnabled === true;
    const primaryPaths = [...new Set(profile.primary.map(path => unifiedInbox && path === '/conversations' ? '/today' : path))];
    const entries = workspaceNavigation.filter(item => context.canAccess(item.to))
        .filter(item => !unifiedInbox || item.to !== '/conversations')
        .filter(item => item.to !== '/' || profile.landing === '/')
        .filter(item => item.to !== '/getting-started' || context.showGuide)
        .filter(item => item.to !== '/coffee' || context.showCoffeeOps)
        .map(item => roleLabel(item, role));
    const primary = primaryPaths.flatMap(path => entries.filter(item => item.to === path));
    const childEntries = new Set(['/leads', '/opportunities', '/workspace-analytics', '/reports', ...(!context.isPlatformAdmin && context.canAccess('/autopilot') ? ['/triggers', '/outbound'] : [])]);
    const more = entries.filter(item => !primaryPaths.includes(item.to) && !childEntries.has(item.to));
    return { primary, more, all: [...primary, ...entries.filter(item => !primaryPaths.includes(item.to))] };
}

export function getWorkspaceNavigationTitle(path: string, role?: string): string {
    const pathname = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
    if (/^\/(?:client|customers)\/[^/]+$/.test(pathname)) return 'Клиент';
    const item = workspaceNavigation.find(entry => entry.to === (pathname === '/all-leads' ? '/clients' : pathname));
    return item ? roleLabel(item, role).label : 'AVA CRM';
}

export function isWorkspaceSectionActive(target: string, pathname: string): boolean {
    return (target === '/deals' && ['/leads', '/opportunities'].includes(pathname))
        || (target === '/analytics' && ['/workspace-analytics', '/reports'].includes(pathname))
        || (target === '/autopilot' && ['/triggers', '/outbound'].includes(pathname));
}
