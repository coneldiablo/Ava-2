import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Search, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useOnboarding } from '../context/OnboardingContext';
import { useInstance } from '../context/InstanceContext';
import { canAccessRoute, getSessionMembership, hasCapability } from '../permissions';
import { getWorkspaceNavigation } from '../workspaceNavigation';
import { isCoffeeBusiness } from '../businessProfiles';
import { searchWorkspace, sourceHref } from '../avaWorkspace';
import { useResource } from '../hooks/useWorkspaceResource';
import { useReleaseFlags } from '../hooks/useReleaseFlags';
const resultGroups = { client: 'Клиент', deal: 'Сделка', message: 'Сообщение', call: 'Звонок' };
type Props = { open: boolean; onClose: () => void };
export default function QuickJump({ open, onClose }: Props) {
    const navigate = useNavigate(), auth = useAuth(); const { currentInstanceId, currentInstance } = useInstance();
    const { showGuide } = useOnboarding();
    const [query, setQuery] = useState(''), [debounced, setDebounced] = useState(''), [active, setActive] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null), panelRef = useRef<HTMLDivElement>(null);
    const release = useReleaseFlags(open);
    const canSearch = release.data?.flags.workspace === true && currentInstanceId && auth.role !== 'platform_admin' && hasCapability(auth, currentInstanceId, 'sales.read');
    const search = useResource(open && canSearch && debounced.trim().length >= 2 ? `${auth.userId}:${currentInstanceId}:${debounced}` : null, signal => searchWorkspace(currentInstanceId!, debounced.trim(), signal));
    const sections = getWorkspaceNavigation({ role: getSessionMembership(auth, currentInstanceId)?.role,
        isPlatformAdmin: auth.role === 'platform_admin', showGuide, showCoffeeOps: isCoffeeBusiness(currentInstance),
        workspaceEnabled: release.data?.flags.workspace,
        canAccess: path => canAccessRoute(auth, currentInstanceId, path) }).all;
    const navigation = sections
        .filter(section => `${section.label} ${section.group}`.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')))
        .map(section => ({ id: `section:${section.to}`, title: section.label, group: section.group, snippet: '', href: section.to }));
    const dataChoices = debounced === query && search.data ? search.data.results.filter(result => canAccessRoute(auth, currentInstanceId, sourceHref(result.href))).map(result => ({ id: `source:${result.type}:${result.id}`, title: result.title, group: resultGroups[result.type], snippet: result.snippet, href: sourceHref(result.href) })) : [];
    const choices = [...dataChoices, ...navigation]; const selectedIndex = Math.min(active, Math.max(0, choices.length - 1));
    useEffect(() => { const timer = setTimeout(() => setDebounced(query), 250); return () => clearTimeout(timer); }, [query]);
    useEffect(() => {
        if (!open) return; setQuery(''); setDebounced(''); setActive(0);
        const frame = requestAnimationFrame(() => inputRef.current?.focus());
        const trap = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
            if (event.key !== 'Tab' || !panelRef.current) return;
            const controls = Array.from(panelRef.current.querySelectorAll<HTMLElement>('input, button:not(:disabled)')).filter(element => element.getClientRects().length > 0);
            const first = controls[0], last = controls[controls.length - 1]; if (!first || !last) return;
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', trap); return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', trap); };
    }, [open, currentInstanceId, auth.userId, onClose]);
    useEffect(() => { if (open) panelRef.current?.querySelector(`[data-quick-index="${selectedIndex}"]`)?.scrollIntoView?.({ block: 'nearest' }); }, [open, selectedIndex]);
    if (!open) return null;
    const go = (href: string) => { onClose(); navigate(href); };
    return <div className="crm-quick-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={panelRef} className="crm-quick-panel" role="dialog" aria-modal="true" aria-labelledby="crm-quick-title"><div className="crm-quick-input-row"><Search size={20} aria-hidden="true" /><label id="crm-quick-title" className="sr-only" htmlFor="crm-quick-input">Поиск клиентов, сделок и общения</label><input id="crm-quick-input" ref={inputRef} value={query} placeholder="Клиент, сделка, фраза из разговора…" maxLength={200} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive(Math.min(choices.length - 1, selectedIndex + 1)); }
        if (event.key === 'ArrowUp') { event.preventDefault(); setActive(Math.max(0, selectedIndex - 1)); }
        if (event.key === 'Enter' && choices[selectedIndex]) { event.preventDefault(); go(choices[selectedIndex].href); }
    }} aria-describedby="crm-quick-help" /><button onClick={onClose} aria-label="Закрыть поиск"><X size={19} aria-hidden="true" /></button></div><div className="crm-quick-results">{canSearch && query.trim().length >= 2 && (search.loading || debounced !== query) && <p className="crm-quick-empty" role="status">Ищем в выбранном бизнесе…</p>}{search.error && <div className="crm-quick-empty" role="alert"><p>{search.error}</p><button onClick={search.reload}>Повторить поиск</button></div>}{choices.map((choice, index) => <button data-quick-index={index} className={index === selectedIndex ? 'is-active' : ''} key={choice.id} onClick={() => go(choice.href)}><span><small>{choice.group}</small><strong>{choice.title}</strong>{choice.snippet && <span className="crm-quick-snippet">{choice.snippet}</span>}</span><ArrowRight size={17} aria-hidden="true" /></button>)}{choices.length === 0 && !search.loading && !search.error && debounced === query && <p className="crm-quick-empty">Ничего не найдено.</p>}</div><p className="crm-quick-help" id="crm-quick-help">↑ ↓ выбрать · Enter открыть · Esc закрыть{canSearch && ' · Поиск только в текущем бизнесе'}</p></div></div>;
}
