import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, Check } from 'lucide-react';
import { useOnboarding } from '../context/OnboardingContext';

const setupRoutes = new Set(['/integrations', '/knowledge-base', '/channels', '/assistant-builder', '/simulator']);
/** Keep the first-run journey recoverable after visiting a full settings screen. */
export default function SetupReturn() {
    const { pathname } = useLocation();
    const { phase, state } = useOnboarding();
    if (phase !== 'pending' || !state || !setupRoutes.has(pathname)) return null;
    return <nav className="ava-setup-return" aria-label="Первичная настройка бизнеса">
        <span><Check size={16} aria-hidden="true" />{state.confirmedSteps.length} из 5 шагов пройдено</span>
        <Link to="/getting-started"><ArrowLeft size={16} aria-hidden="true" />Вернуться к настройке</Link>
    </nav>;
}
