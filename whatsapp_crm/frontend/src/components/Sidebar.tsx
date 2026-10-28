import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, LogOut, X } from 'lucide-react';
import { useInstance } from '../context/InstanceContext';
import { useAuth } from '../context/AuthContext';
import { useOnboarding } from '../context/OnboardingContext';
import { isCoffeeBusiness } from '../businessProfiles';
import AvaMark from './AvaMark';
import { canAccessRoute, getSessionMembership } from '../permissions';
import { getWorkspaceNavigation, isWorkspaceSectionActive } from '../workspaceNavigation';
import { useReleaseFlags } from '../hooks/useReleaseFlags';

type SidebarProps = { open?: boolean; onClose?: () => void };

export default function Sidebar({ open = false, onClose }: SidebarProps) {
    const sidebarRef = useRef<HTMLElement>(null);
    const [mobile,setMobile]=useState(()=>window.matchMedia?.('(max-width:850px)').matches || false);
    useEffect(()=>{const media=window.matchMedia?.('(max-width:850px)');if(!media)return;const update=()=>setMobile(media.matches);media.addEventListener?.('change',update);return()=>media.removeEventListener?.('change',update);},[]);
    useLayoutEffect(()=>{if(sidebarRef.current)sidebarRef.current.inert=mobile&&!open;},[mobile,open]);
    const { instances, currentInstanceId, currentInstance, setInstanceId } = useInstance();
    const auth = useAuth();
    const { showGuide } = useOnboarding();
    const { loginName, displayName, logout, role } = auth;
    const location = useLocation();
    const showCoffeeOps = isCoffeeBusiness(currentInstance);
    const businessRole = getSessionMembership(auth, currentInstanceId)?.role;
    const release = useReleaseFlags();
    const navigation = getWorkspaceNavigation({ role: businessRole, isPlatformAdmin: role === 'platform_admin',
        showGuide, showCoffeeOps, workspaceEnabled: release.data?.flags.workspace, canAccess: path => canAccessRoute(auth, currentInstanceId, path) });
    const [moreOpen, setMoreOpen] = useState(!currentInstanceId);
    const moreGroups = Array.from(new Set(navigation.more.map(item => item.group)));

    useEffect(() => {
        if (!open) return;
        const sidebar = sidebarRef.current;
        // The drawer's visibility transition needs a rendered frame before it can receive focus.
        let focusFrame = requestAnimationFrame(() => {
            focusFrame = requestAnimationFrame(() => sidebar?.querySelector<HTMLButtonElement>('.crm-sidebar-close')?.focus({ preventScroll: true }));
        });
        const trap = (event: KeyboardEvent) => {
            if (event.key !== 'Tab' || !sidebar) return;
            const controls = Array.from(sidebar.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), select:not(:disabled)'))
                .filter(element => element.getClientRects().length > 0);
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (!first || !last) return;
            if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
                event.preventDefault(); last.focus();
            } else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) {
                event.preventDefault(); first.focus();
            }
        };
        document.addEventListener('keydown', trap);
        return () => { cancelAnimationFrame(focusFrame); document.removeEventListener('keydown', trap); };
    }, [open]);

    useEffect(() => {
        if (navigation.more.some(item => item.to === location.pathname)) setMoreOpen(true);
        onClose?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.pathname, currentInstanceId, businessRole]);

    return <>
        {open && <button type="button" className="crm-sidebar-scrim" aria-label="Закрыть меню" onClick={onClose} />}
        <aside ref={sidebarRef} className={`crm-sidebar${open ? ' crm-sidebar-open' : ''}`} aria-label="Основная навигация" aria-hidden={mobile&&!open || undefined}>
            <div className="crm-sidebar-brand">
                <span className="crm-sidebar-logo"><AvaMark size={22} /></span>
                <span><strong>AVA</strong><small>Ваше пространство</small></span>
                <button type="button" className="crm-sidebar-close" aria-label="Закрыть меню" onClick={onClose}><X size={19} /></button>
            </div>
            <nav className="crm-sidebar-nav" aria-label="Разделы CRM">
                {navigation.primary.length > 0 && <div className="crm-nav-group crm-nav-primary">
                    <div className="crm-nav-heading">Рабочее пространство</div>
                    <div className="crm-nav-items">
                        {navigation.primary.map(item => <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => `crm-nav-item${isActive || isWorkspaceSectionActive(item.to, location.pathname) ? ' crm-nav-item-active' : ''}`}>
                            <span aria-hidden="true"><item.icon size={17} /></span><span>{item.label}</span>
                        </NavLink>)}
                    </div>
                </div>}
                {navigation.more.length > 0 && <div className="crm-nav-group">
                    <button type="button" className="crm-nav-heading" aria-expanded={moreOpen} aria-controls="crm-nav-more" onClick={() => setMoreOpen(previous => !previous)}>
                        <span>Ещё</span><ChevronDown size={15} aria-hidden="true" />
                    </button>
                    {moreOpen && <div className="crm-nav-items" id="crm-nav-more">
                        {moreGroups.map(group => <div key={group}>
                            <h3 className="px-3 pb-1 pt-3 text-xs font-semibold text-neu-muted">{group}</h3>
                            {navigation.more.filter(item => item.group === group).map(item => <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => `crm-nav-item${isActive || isWorkspaceSectionActive(item.to, location.pathname) ? ' crm-nav-item-active' : ''}${item.ai ? ' crm-nav-item-ai' : ''}`}>
                                <span aria-hidden="true"><item.icon size={17} /></span><span>{item.label}</span>
                            </NavLink>)}
                        </div>)}
                    </div>}
                </div>}

            </nav>
            <div className="crm-sidebar-footer">
                <label htmlFor="crm-business-select">Текущий бизнес</label>
                <select id="crm-business-select" value={currentInstanceId || ''} onChange={event => setInstanceId(Number(event.target.value))} disabled={instances.length === 0}>
                    {instances.map(instance => <option key={instance.id} value={instance.id}>{instance.name}</option>)}
                    {instances.length === 0 && <option value="">Нет бизнесов</option>}
                </select>
                <div className="crm-sidebar-account"><span className="crm-account-avatar" aria-hidden="true">{(displayName || loginName || 'A').slice(0, 1).toUpperCase()}</span><span className="crm-account-name" title={displayName || loginName || 'Пользователь AVA'}>{displayName || loginName || 'Пользователь AVA'}</span><button type="button" onClick={() => logout()} aria-label="Выйти" title="Выйти"><LogOut size={17} /></button></div>
            </div>
        </aside>
    </>;
}
