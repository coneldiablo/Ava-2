import { BrowserRouter, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { lazy, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Layout from './components/Layout';
import ReleaseGate from './components/ReleaseGate';
import { InstanceProvider, useInstance } from './context/InstanceContext';
import { OnboardingProvider } from './context/OnboardingContext';
import { OnboardingHomeGate, OnboardingGuideRoute } from './components/OnboardingGate';
import Login from './pages/Login';
import PublicWelcome from './pages/public/PublicWelcome';
import { clearEnrolledAccount } from './pages/public/enrollmentSession';
import { Registration, PasswordRecovery } from './pages/public/PublicForms';
import AcceptInvitation from './pages/AcceptInvitation';
import OwnerInvitation from './pages/OwnerInvitation';
import ModuleAccess from './pages/ModuleAccess';
import TodayWorkspace from './pages/TodayWorkspace';
import { getVapidPublicKey, subscribePush } from './api';
import { AuthProvider, useAuth } from './context/AuthContext';
import { canAccessRoute, getBusinessLanding } from './permissions';
import type { ReactNode } from 'react';

// Both primary customer workspaces must remain available when a browser has
// retained a failed dynamic-module request from a previous open page.
const Autopilot = lazy(() => import('./pages/Autopilot'));
const WorkspaceAnalytics = lazy(() => import('./pages/WorkspaceAnalytics'));
const SalesWorkspace = lazy(() => import('./pages/SalesWorkspace'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Integrations = lazy(() => import('./pages/Integrations'));
const Simulator = lazy(() => import('./pages/Simulator'));
const InstanceManager = lazy(() => import('./pages/InstanceManager'));
const Conversations = lazy(() => import('./pages/Conversations'));
const Leads = lazy(() => import('./pages/Leads'));
const AllLeads = lazy(() => import('./pages/AllLeads'));
const Analytics = lazy(() => import('./pages/Analytics'));
const Reports = lazy(() => import('./pages/Reports'));
const CoffeeOps = lazy(() => import('./pages/CoffeeOps'));
const SmartTriggers = lazy(() => import('./pages/SmartTriggers'));
const Channels = lazy(() => import('./pages/Channels'));
const ClientProfile = lazy(() => import('./pages/ClientProfile'));
const CustomerIntelligence = lazy(() => import('./pages/CustomerIntelligence'));
const KnowledgeBase = lazy(() => import('./pages/KnowledgeBase'));
const OutboundCampaigns = lazy(() => import('./pages/OutboundCampaigns'));
const Calls = lazy(() => import('./pages/Calls'));
const Deals = lazy(() => import('./pages/Deals'));
const Opportunities = lazy(() => import('./pages/Opportunities'));
const QuickReplies = lazy(() => import('./pages/QuickReplies'));
const Team = lazy(() => import('./pages/Team'));
const Activity = lazy(() => import('./pages/Activity'));
const BusinessGpt = lazy(() => import('./pages/BusinessGpt'));
const Studio = lazy(() => import('./pages/Studio'));
const CustomerSetup = lazy(() => import('./pages/CustomerSetup'));
const OnboardingGuide = lazy(() => import('./pages/OnboardingGuide'));

// Convert base64 URL-safe string to Uint8Array (required for VAPID)
function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    return new Uint8Array([...rawData].map(char => char.charCodeAt(0)));
}

async function registerPushNotifications() {
    try {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.info('[Push] Push notifications not supported in this browser');
            return;
        }

        // Register the service worker
        const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        console.info('[Push] Service worker registered');

        // Request notification permission if not already granted
        if (Notification.permission === 'denied') {
            console.info('[Push] Notifications are denied by user');
            return;
        }

        if (Notification.permission !== 'granted') {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                console.info('[Push] Notification permission not granted');
                return;
            }
        }

        // Get the VAPID public key from the server
        const vapidRes = await getVapidPublicKey();
        if (!vapidRes.success || !vapidRes.publicKey) {
            console.warn('[Push] Could not get VAPID public key from server');
            return;
        }

        const applicationServerKey = urlBase64ToUint8Array(vapidRes.publicKey).buffer as ArrayBuffer;

        // Subscribe to push manager
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey,
            });
        }

        // Send subscription to our backend
        await subscribePush(subscription.toJSON() as PushSubscriptionJSON);
        console.info('[Push] ✅ Push subscription registered successfully');

    } catch (err) {
        console.warn('[Push] Could not register push notifications:', err);
    }
}

function PushInitializer() {
    useEffect(() => {
        // Delay slightly to not block initial render
        const timer = setTimeout(registerPushNotifications, 2000);
        return () => clearTimeout(timer);
    }, []);
    return null;
}

export function RouteAccess({ children }: { children: ReactNode }) {
    const auth = useAuth();
    const { currentInstanceId, instancesState, refreshInstances } = useInstance();
    const { pathname } = useLocation();
    const contentRef = useRef<HTMLDivElement>(null);
    const hasPresented = useRef(false);
    const checking = auth.permissionsLoading || instancesState !== 'ready';
    const snapshotAllowed = canAccessRoute({ ...auth, permissionsLoading: false }, currentInstanceId, pathname);
    useLayoutEffect(() => { if (contentRef.current) contentRef.current.inert = checking; }, [checking]);
    if (instancesState === 'error' && !hasPresented.current) return <div className="card p-6" role="alert">
        <h1 className="text-xl font-semibold">Не удалось загрузить бизнесы</h1>
        <p className="mt-2 text-neu-muted">Проверьте соединение и повторите загрузку.</p>
        <button type="button" className="btn-secondary mt-4 min-h-11" onClick={() => void refreshInstances()}>Повторить</button>
    </div>;
    if (checking && !hasPresented.current) return <div className="card p-6" role="status" aria-live="polite">Проверяем доступ к бизнесу…</div>;
    if (!snapshotAllowed) {
        const landing = getBusinessLanding(auth, currentInstanceId);
        return <div className="card p-6" role="status">
            <h1 className="text-xl font-semibold">Раздел недоступен</h1>
            <p className="mt-2 text-neu-muted">Выберите доступный бизнес или обратитесь к его владельцу, чтобы уточнить ваш доступ.</p>
            <div className="mt-4 flex flex-wrap gap-3">
                {landing !== pathname && canAccessRoute(auth, currentInstanceId, landing) && <Link to={landing} className="btn-primary min-h-11">Открыть рабочее пространство</Link>}
                <button type="button" className="btn-secondary min-h-11" onClick={() => void auth.refreshAuth().catch(() => {})}>Проверить доступ</button>
            </div>
        </div>;
    }
    hasPresented.current = true;
    return <div className="relative" aria-busy={checking}>
        <div>{checking && <div className="card p-4 mb-4" role={auth.permissionsError || instancesState === 'error' ? 'alert' : 'status'} aria-live="polite">
            <p>{auth.permissionsError || (instancesState === 'error' ? 'Не удалось обновить бизнесы. Введённые данные сохранены.' : 'Проверяем доступ. Введённые данные сохранены; действия временно недоступны.')}</p>
            {(auth.permissionsError || instancesState === 'error') && <button type="button" className="btn-secondary mt-3 min-h-11"
                onClick={() => { void auth.refreshAuth().catch(() => {}); void refreshInstances(); }}>Повторить проверку</button>}
        </div>}</div>
        <div ref={contentRef}>{children}</div>
    </div>;
}

function BusinessHome() {
    const auth = useAuth();
    const { currentInstanceId } = useInstance();
    const { search, hash } = useLocation();
    const landing = getBusinessLanding({ ...auth, permissionsLoading: false }, currentInstanceId);
    if (landing !== '/') return <Navigate to={{ pathname: landing, search, hash }} replace />;
    const params = new URLSearchParams(search);
    if (params.has('client') || params.has('source')) return <Navigate to={{ pathname: auth.role === 'platform_admin' ? '/conversations' : '/today', search, hash }} replace />;
    return <Dashboard />;
}

export function ConversationRedirect() {
    const { search, hash } = useLocation();
    return <Navigate to={{ pathname: '/today', search, hash }} replace />;
}

function ProtectedCrm() {
    const { role } = useAuth();
    const customer = role !== 'platform_admin';
    const guarded = (children: ReactNode) => <RouteAccess>{children}</RouteAccess>;
    return (
        <InstanceProvider>
            <OnboardingProvider>
            <BrowserRouter>
                {!customer && <PushInitializer />}
                <Routes>
                    <Route path="/" element={<Layout />}>
                        <Route index element={guarded(<OnboardingHomeGate><BusinessHome /></OnboardingHomeGate>)} />
                        <Route path="today" element={guarded(<ReleaseGate feature="workspace" fallback={<SalesWorkspace />}><TodayWorkspace /></ReleaseGate>)} />
                        <Route path="sales" element={guarded(<SalesWorkspace />)} />
                        <Route path="integrations" element={guarded(customer ? <CustomerSetup /> : <Integrations />)} />
                        <Route path="getting-started" element={customer ? <OnboardingGuideRoute>{guarded(<OnboardingGuide />)}</OnboardingGuideRoute> : <Navigate to="/" replace />} />
                        <Route path="simulator" element={guarded(<Simulator />)} />
                        <Route path="instances" element={guarded(<InstanceManager />)} />
                        <Route path="conversations" element={guarded(customer ? <ReleaseGate feature="workspace" fallback={<Conversations />}><ConversationRedirect /></ReleaseGate> : <Conversations />)} />
                        <Route path="leads" element={guarded(<Leads />)} />
                        <Route path="deals" element={guarded(<Deals />)} />
                        <Route path="opportunities" element={guarded(<Opportunities />)} />
                        <Route path="clients" element={guarded(<AllLeads />)} />
                        <Route path="autopilot" element={guarded(<Autopilot />)} />
                        <Route path="workspace-analytics" element={guarded(<ReleaseGate feature="analytics"><WorkspaceAnalytics /></ReleaseGate>)} />
                        <Route path="all-leads" element={guarded(<AllLeads />)} />
                        <Route path="analytics" element={guarded(<Analytics />)} />
                        <Route path="reports" element={customer ? guarded(<Reports />) : <Navigate to="/analytics" replace />} />
                        <Route path="coffee" element={guarded(<CoffeeOps />)} />
                        <Route path="triggers" element={guarded(<SmartTriggers />)} />
                        <Route path="assistant-builder" element={customer ? guarded(<Navigate to="/integrations#business-autoprompt" replace />) : <Navigate to="/integrations" replace />} />
                        <Route path="channels" element={guarded(<Channels />)} />
                        <Route path="client/:chatId" element={guarded(customer ? <CustomerIntelligence /> : <ClientProfile />)} />
                        <Route path="customers/:chatId" element={guarded(customer ? <CustomerIntelligence /> : <ClientProfile />)} />
                        <Route path="knowledge-base" element={guarded(<KnowledgeBase />)} />
                        <Route path="outbound" element={guarded(<OutboundCampaigns />)} />
                        <Route path="calls" element={guarded(<Calls />)} />
                        <Route path="quick-replies" element={guarded(<QuickReplies />)} />
                        <Route path="team" element={guarded(<Team />)} />
                        <Route path="activity" element={guarded(<Activity />)} />
                        <Route path="business-gpt" element={customer ? guarded(<BusinessGpt />) : <Navigate to="/knowledge-base" replace />} />
                        <Route path="studio" element={customer ? guarded(<Studio />) : <Navigate to="/" replace />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Route>
                </Routes>
            </BrowserRouter>
            </OnboardingProvider>
        </InstanceProvider>
    );
}

function AppContent() {
    const { authenticated, loading } = useAuth();
    const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
    const [resumePending, setResumePending] = useState(() => {
        try { return window.location.pathname === '/' && Boolean(sessionStorage.getItem('ava:owner-guide-resume')); }
        catch { return false; }
    });
    useEffect(() => {
        if (!authenticated || loading || !resumePending) return;
        try {
            if (sessionStorage.getItem('ava:owner-guide-resume')) {
                sessionStorage.removeItem('ava:owner-guide-resume');
                window.history.replaceState(null, '', '/getting-started');
            }
        } catch { /* The guide remains available in navigation. */ }
        setResumePending(false);
    }, [authenticated, loading, resumePending]);
    useEffect(() => { if (authenticated) clearEnrolledAccount(); }, [authenticated]);
    if (pathname === '/invite') return <AcceptInvitation />;
    if (pathname === '/owner-invite') return <OwnerInvitation />;

    if (loading || (authenticated && resumePending)) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-neu-base px-4">
                <div className="card flex items-center gap-4 rounded-[28px] px-6 py-5">
                    <div className="flex h-11 w-11 items-center justify-center rounded-sm bg-[#111111] text-[#f2f2f2]">
                        <span className="font-clash-display text-xl font-bold">A</span>
                    </div>
                    <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-neu-muted">
                            Открываем AVA
                        </p>
                        <p className="mt-1 font-medium text-neu-text">Проверка доступа...</p>
                    </div>
                </div>
            </div>
        );
    }

    if (window.location.pathname === '/module-access') return <ModuleAccess />;
    if (authenticated) return <ProtectedCrm />;
    return <BrowserRouter><Routes>
        <Route path="/" element={new URLSearchParams(window.location.search).get('login') === 'manual' ? <Login /> : <PublicWelcome />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Registration />} />
        <Route path="/verify-email" element={<Registration />} />
        <Route path="/forgot-password" element={<PasswordRecovery />} />
        <Route path="*" element={<Login />} />
    </Routes></BrowserRouter>;
}

function App() {
    return (
        <AuthProvider>
            <AppContent />
        </AuthProvider>
    );
}

export default App;
