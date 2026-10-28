import SectionNavigation from './SectionNavigation';
import { Component, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Menu, Search } from 'lucide-react';
import Sidebar from './Sidebar';
import QuickJump from './QuickJump';
import SetupReturn from './SetupReturn';
import { useAuth } from '../context/AuthContext';
import { useInstance } from '../context/InstanceContext';
import { getSessionMembership } from '../permissions';
import { getWorkspaceNavigationTitle } from '../workspaceNavigation';

class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() {
        if (this.state.failed) return <div className="card p-6" role="alert">
            <h2 className="text-lg font-semibold">Не удалось открыть раздел</h2>
            <p className="mt-2">Возможно, AVA обновилась, пока страница была открыта. Обновите её и попробуйте снова.</p>
            <button type="button" className="mt-4 min-h-11 rounded-xl border px-4 font-semibold" onClick={() => window.location.reload()}>Обновить страницу</button>
        </div>;
        return this.props.children;
    }
}

export default function Layout() {
    const [menuOpen, setMenuOpen] = useState(false);
    const [quickOpen, setQuickOpen] = useState(false);
    const menuButtonRef = useRef<HTMLButtonElement>(null);
    const quickButtonRef = useRef<HTMLButtonElement>(null);
    const mainRef = useRef<HTMLDivElement>(null);
    const wasOpen = useRef(false);
    const quickWasOpen = useRef(false);
    const { pathname, search } = useLocation();
    const navigate = useNavigate();
    const auth = useAuth();
    const { currentInstanceId, currentInstance } = useInstance();
    const [renderBusinessId, setRenderBusinessId] = useState(currentInstanceId);
    const lastKnownBusinessId = useRef(currentInstanceId);
    const businessChanging = currentInstanceId !== renderBusinessId;
    useLayoutEffect(() => {
        if (!businessChanging) return;
        const switchingKnownBusiness = currentInstanceId != null && lastKnownBusinessId.current != null && currentInstanceId !== lastKnownBusinessId.current;
        if (switchingKnownBusiness && auth.role !== 'platform_admin' && ['/', '/today', '/conversations'].includes(pathname)) {
            const next = new URLSearchParams(search);
            const previous = next.toString();
            for (const key of ['client', 'source', 'q', 'view', 'page']) next.delete(key);
            // Keep the next business unmounted until the router has committed the cleared URL.
            if (next.toString() !== previous) {
                navigate({ pathname, search: next.toString() ? `?${next}` : '' }, { replace: true });
                return;
            }
        }
        if (currentInstanceId != null) lastKnownBusinessId.current = currentInstanceId;
        setRenderBusinessId(currentInstanceId);
    }, [businessChanging, currentInstanceId, auth.role, pathname, search, navigate]);
    const scopeKey = `${currentInstanceId ?? 'none'}:${auth.userId ?? auth.loginName}:${JSON.stringify(auth.memberships)}`;
    const role = auth.role === 'platform_admin' ? auth.role : getSessionMembership(auth, currentInstanceId)?.role;
    const title = getWorkspaceNavigationTitle(pathname, role);
    useEffect(() => {
        document.title = `${title} · AVA`;
        document.getElementById('main-content')?.focus({ preventScroll: true });
    }, [pathname, title]);
    useEffect(() => {
        if (!menuOpen) return;
        const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
        window.addEventListener('keydown', closeOnEscape);
        return () => window.removeEventListener('keydown', closeOnEscape);
    }, [menuOpen]);
    useLayoutEffect(() => {
        if (mainRef.current) mainRef.current.inert = menuOpen || quickOpen;
        const sidebar = document.querySelector<HTMLElement>('.crm-sidebar');
        if (sidebar) sidebar.inert = quickOpen || (!menuOpen && Boolean(window.matchMedia?.('(max-width:850px)').matches));
        if (!menuOpen && wasOpen.current) menuButtonRef.current?.focus();
        if (!quickOpen && quickWasOpen.current) quickButtonRef.current?.focus();
        wasOpen.current = menuOpen;
        quickWasOpen.current = quickOpen;
    }, [menuOpen, quickOpen]);
    useEffect(() => {
        const shortcut = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault(); setMenuOpen(false); setQuickOpen(value => !value);
            }
        };
        document.addEventListener('keydown', shortcut);
        return () => document.removeEventListener('keydown', shortcut);
    }, []);
    useEffect(() => { setMenuOpen(false); setQuickOpen(false); }, [currentInstanceId]);
    return <div className="crm-shell">
        <a className="crm-skip-link" href="#main-content">К содержимому</a>
        <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
        <div className="crm-shell-main" ref={mainRef}>
            <header className="crm-topbar">
                <button type="button" ref={menuButtonRef} className="crm-menu-button" aria-label="Открыть меню" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu size={21} aria-hidden="true" /></button>
                <div className="crm-business-context"><span>{currentInstance?.name || 'AVA'}</span></div>
                <button ref={quickButtonRef} type="button" className="crm-quick-open" onClick={() => setQuickOpen(true)} aria-label="Поиск и переход" aria-keyshortcuts="Meta+K Control+K"><Search size={16} aria-hidden="true" /><span>Поиск и переход</span><kbd>⌘ K</kbd></button>
            </header>
            <main className="crm-main" id="main-content" tabIndex={-1}><div className="crm-content"><SetupReturn /><SectionNavigation />
                <RouteErrorBoundary key={`${pathname}:${scopeKey}`}><Suspense fallback={<div className="card p-6" role="status" aria-live="polite">Загружаем раздел…</div>}>{businessChanging ? <div className="card p-6" role="status">Открываем выбранный бизнес…</div> : <Outlet />}</Suspense></RouteErrorBoundary>
            </div></main>
        </div>
        <QuickJump open={quickOpen} onClose={() => setQuickOpen(false)} />
    </div>;
}
