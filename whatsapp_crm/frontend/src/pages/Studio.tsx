import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BarChart3, BookOpen, Check, Copy, FileText, Loader2, MessageSquareText, Printer, Save, Send, X } from 'lucide-react';
import { useInstance } from '../context/InstanceContext';
import { useAuth } from '../context/AuthContext';
import { canAccessRoute } from '../permissions';
import './Studio.css';
import CommercialDocuments from '../components/CommercialDocuments';

type Selection = { offerId: string; offerRevision: number; quantity: number };
type CatalogOffer = { offerId: string; offerRevision: number; name: string; description: string; amountMinor: number; currency: string; terms: string; publishedAt: string };
type MaterialItem = Selection & { name: string; amountMinor: number; totalMinor: number; currency: string; terms: string };
type Material = { clientChatId?: string | null; revision: number; dealRevision: number; text: string; catalogItems: MaterialItem[]; createdAt: string; updatedBy: string };
type PendingSave = { revision: number; dealRevision: number; text: string; catalogItems: Selection[]; idempotencyKey: string };
interface DealOption { id: string; title: string; clientChatId: string | null; stage: string }
interface Proposal {
    businessId: number; dealId: string; revision: number; draftText: string;
    source: { dealTitle: string; amountMinor: number; currency: string; clientName: string | null; hotelName: string | null };
    requiresManagerConfirmation: string[]; catalog?: CatalogOffer[]; material?: Material | null;
}
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const validSelection = (item: Selection) => typeof item?.offerId === 'string' && !!item.offerId && positive(item.offerRevision) && positive(item.quantity) && item.quantity <= 10000;
const validCatalog = (item: CatalogOffer) => typeof item?.offerId === 'string' && !!item.offerId && positive(item.offerRevision) && typeof item.name === 'string' && !!item.name.trim() && Number.isSafeInteger(item.amountMinor) && item.amountMinor >= 0 && typeof item.currency === 'string' && /^[A-Z]{3}$/.test(item.currency) && typeof item.description === 'string' && typeof item.terms === 'string' && typeof item.publishedAt === 'string' && Number.isFinite(Date.parse(item.publishedAt));
const validMaterial = (value: Material) => value && positive(value.revision) && positive(value.dealRevision) && typeof value.text === 'string' && !!value.text.trim() && value.text.length <= 4000 && Array.isArray(value.catalogItems) && value.catalogItems.length <= 30 && value.catalogItems.every(item => validSelection(item) && typeof item.name === 'string' && !!item.name.trim() && Number.isSafeInteger(item.amountMinor) && item.amountMinor >= 0 && Number.isSafeInteger(item.totalMinor) && item.totalMinor === item.amountMinor * item.quantity && typeof item.currency === 'string' && /^[A-Z]{3}$/.test(item.currency) && typeof item.terms === 'string') && new Set(value.catalogItems.map(item => item.offerId)).size === value.catalogItems.length;
const references = (items: Selection[]) => items.map(({ offerId, offerRevision, quantity }) => ({ offerId, offerRevision, quantity })).sort((a, b) => a.offerId.localeCompare(b.offerId));
const sameItems = (left: Selection[], right: Selection[]) => JSON.stringify(references(left)) === JSON.stringify(references(right));
const materialItems = (items: MaterialItem[]) => items.map(({ offerId, offerRevision, quantity, name, amountMinor, totalMinor, currency, terms }) => ({ offerId, offerRevision, quantity, name, amountMinor, totalMinor, currency, terms })).sort((a, b) => a.offerId.localeCompare(b.offerId));
const sameMaterial = (left: Material, right: Material) => left.revision === right.revision && left.dealRevision === right.dealRevision && left.text === right.text && JSON.stringify(materialItems(left.catalogItems)) === JSON.stringify(materialItems(right.catalogItems));
const money = (minor: number, currency: string) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency }).format(minor / 100);
function validProposal(value: Proposal, businessId: number, dealId: string) {
    return value?.businessId === businessId && value.dealId === dealId && positive(value.revision) && typeof value.draftText === 'string' && !!value.draftText.trim() && typeof value.source?.dealTitle === 'string' && Array.isArray(value.requiresManagerConfirmation) && value.requiresManagerConfirmation.every(item => typeof item === 'string') && (value.catalog === undefined || Array.isArray(value.catalog) && value.catalog.every(validCatalog) && new Set(value.catalog.map(item => item.offerId)).size === value.catalog.length) && (value.material == null || validMaterial(value.material));
}
const failureMessages: Record<string, string> = {
    STUDIO_CATALOG_CHANGED: 'Цена или условия каталога изменились. Обновите данные и выберите актуальные позиции. Ваш текст сохранён.',
    STUDIO_REVISION_CONFLICT: 'Материал уже изменён. Обновите данные и сравните сохранённую версию со своим текстом.',
    STUDIO_DEAL_CHANGED: 'Сделка изменилась. Обновите данные перед сохранением или переходом к отправке.',
    STUDIO_RECIPIENT_REQUIRED: 'У сделки нет подтверждённого клиента. Укажите клиента в сделке перед отправкой.',
    STUDIO_IDEMPOTENCY_CONFLICT: 'Не удалось сопоставить повтор сохранения. Обновите данные перед новой попыткой.',
    STUDIO_INPUT_INVALID: 'Проверьте текст (до 4000 символов) и количество выбранных позиций.',
    STUDIO_DEAL_SCOPE_DENIED: 'Изменение этой сделки недоступно. Проверьте ответственного и свои права.',
};
async function request<T>(url: string, signal: AbortSignal, method = 'GET', body?: unknown): Promise<T> {
    const controller = new AbortController(); const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) controller.abort();
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, method === 'GET' ? 15000 : 45000);
    try {
        const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal, method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
        if (response.status === 401) window.dispatchEvent(new Event('crm:unauthorized'));
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data || data.success !== true) {
            if (failureMessages[data?.code]) throw new Error(failureMessages[data.code]);
            if (response.status === 403) throw new Error('Нет доступа к этому действию. Проверьте права и ответственного в сделке.');
            if (response.status === 404) throw new Error('Сделка не найдена. Обновите список сделок.');
            throw new Error('Не удалось подтвердить действие. Ваш текст сохранён. Повторите попытку или обновите данные.');
        }
        return data as T;
    } catch (cause) {
        if (expired) throw new Error('Ответ не успел прийти. Ваш черновик сохранён на экране. Повторите попытку.');
        throw cause;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

export default function Studio() {
    const { currentInstanceId } = useInstance(); const auth = useAuth(); const { userId, role, memberships, permissionsLoading } = auth;
    const membership = memberships.find(item => item.businessId === currentInstanceId);
    const scope = `${currentInstanceId}:${userId ?? ''}:${role}:${membership?.role ?? ''}:${membership?.capabilities?.slice().sort().join(',') ?? ''}`;
    const toolRoutes = ['/analytics', '/knowledge-base', '/quick-replies'].filter(path => canAccessRoute(auth, currentInstanceId, path));
    return <StudioForBusiness key={scope} storageScope={scope} businessId={currentInstanceId} toolRoutes={toolRoutes} permissionsLoading={Boolean(permissionsLoading)} canSave={membership?.capabilities?.includes('sales.write') === true} canSend={membership?.capabilities?.includes('messages.send') === true} />;
}
function StudioForBusiness({ businessId, permissionsLoading, canSave, canSend, storageScope, toolRoutes }: { businessId: number | null; permissionsLoading: boolean; canSave: boolean; canSend: boolean; storageScope: string; toolRoutes: string[] }) {
    const navigate = useNavigate();
    const [deals, setDeals] = useState<DealOption[]>([]), [dealId, setDealId] = useState('');
    const [proposal, setProposal] = useState<Proposal | null>(null), [draft, setDraft] = useState(''), [selected, setSelected] = useState<Selection[]>([]);
    const [loading, setLoading] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(''), [feedback, setFeedback] = useState('');
    const [loadFailed, setLoadFailed] = useState(false), [loadRevision, setLoadRevision] = useState(0);
    const requestRef = useRef<AbortController | null>(null), pendingSave = useRef<PendingSave | null>(null);
    useEffect(() => () => { requestRef.current?.abort(); requestRef.current = null; }, []);
    const basePath = `/api/businesses/${businessId}/studio/proposals/${encodeURIComponent(dealId)}`;
    const storageKey = `ava:studio:pending:${storageScope}:${dealId}`;
    const generating = busy === 'load';
    const supported = Array.isArray(proposal?.catalog) && proposal?.material !== undefined;
    const changed = !proposal?.material || proposal.material.text !== draft.trim() || !sameItems(proposal.material.catalogItems, selected);
    const catalogStale = selected.some(item => !proposal?.catalog?.some(offer => offer.offerId === item.offerId && offer.offerRevision === item.offerRevision));
    const selectionValid = selected.length <= 30 && selected.every(item => validSelection(item) && Number.isSafeInteger((proposal?.catalog?.find(offer => offer.offerId === item.offerId)?.amountMinor ?? NaN) * item.quantity));
    function storePending(value: PendingSave | null) { pendingSave.current = value; try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); } catch { /* In-memory retry remains available. */ } }
    function recoverPending(): PendingSave | null {
        try {
            const value = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as PendingSave | null;
            return value && Number.isSafeInteger(value.revision) && value.revision >= 0 && positive(value.dealRevision) && typeof value.text === 'string' && !!value.text.trim() && value.text.length <= 4000 && Array.isArray(value.catalogItems) && value.catalogItems.length <= 30 && value.catalogItems.every(validSelection) && typeof value.idempotencyKey === 'string' && !!value.idempotencyKey && value.idempotencyKey.length <= 200 ? value : null;
        } catch { return null; }
    }
    useEffect(() => {
        if (!businessId) return;
        const controller = new AbortController(); setLoading(true); setLoadFailed(false);
        void request<{ business_id: number; deals: DealOption[] }>(`/api/deals/${businessId}`, controller.signal).then(data => {
            if (controller.signal.aborted) return;
            if (data.business_id !== businessId || !Array.isArray(data.deals)) throw new Error('Получены данные другого бизнеса.');
            setDeals(data.deals); setError('');
            const requested = new URLSearchParams(window.location.search).get('dealId');
            if (requested && data.deals.some(deal => deal.id === requested)) setDealId(requested);
        }).catch(cause => { if (!controller.signal.aborted) { setLoadFailed(true); setError(cause instanceof Error ? cause.message : 'Не удалось загрузить сделки.'); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [businessId, loadRevision]);
    async function generate(preserve = false) {
        if (!businessId || !dealId || requestRef.current || loading || loadFailed || permissionsLoading) return;
        if (!preserve && proposal && changed && !window.confirm('Текущие правки черновика будут заменены сохранённым вариантом. Продолжить?')) return;
        const controller = new AbortController(); requestRef.current = controller; setBusy('load'); setError(''); setFeedback('');
        try {
            const result = await request<Proposal>(basePath, controller.signal);
            if (controller.signal.aborted || requestRef.current !== controller) return;
            if (!validProposal(result, businessId, dealId)) throw new Error('Ответ не относится к выбранной сделке или содержит неполные данные.');
            setProposal(result);
            if (preserve) { setFeedback('Данные обновлены. Ваш текст и выбор позиций сохранены. Сравните сохранённую версию перед новым сохранением.'); return; }
            const pending = recoverPending();
            if (pending && result.material?.revision === pending.revision + 1 && result.material.text === pending.text && sameItems(result.material.catalogItems, pending.catalogItems)) storePending(null);
            else if (pending) { pendingSave.current = pending; setDraft(pending.text); setSelected(pending.catalogItems); setFeedback('Восстановлен текст незавершённого сохранения. Повторите сохранение или сравните его с сохранённой версией.'); return; }
            setDraft(result.material?.text ?? result.draftText); setSelected(references(result.material?.catalogItems ?? []));
            setFeedback(result.material ? 'Сохранённый материал загружен. Проверьте его перед использованием.' : 'Черновик подготовлен из данных сделки. Проверьте его перед использованием.');
        } catch (cause) { if (!controller.signal.aborted && requestRef.current === controller) setError(cause instanceof Error ? cause.message : 'Не удалось подготовить черновик.'); }
        finally { if (requestRef.current === controller) { requestRef.current = null; setBusy(''); } }
    }
    async function saveMaterial() {
        if (!businessId || !proposal || !supported || !canSave || permissionsLoading || requestRef.current || !draft.trim() || draft.length > 4000 || !selectionValid || catalogStale) return;
        const payload = { revision: proposal.material?.revision ?? 0, dealRevision: proposal.revision, text: draft.trim(), catalogItems: references(selected) };
        const previous = pendingSave.current ?? recoverPending();
        const sameRequest = previous && JSON.stringify({ revision: previous.revision, dealRevision: previous.dealRevision, text: previous.text, catalogItems: previous.catalogItems }) === JSON.stringify(payload);
        const body: PendingSave = { ...payload, idempotencyKey: sameRequest ? previous.idempotencyKey : crypto.randomUUID() };
        storePending(body);
        const controller = new AbortController(); requestRef.current = controller; setBusy('save'); setError(''); setFeedback('');
        try {
            const result = await request<{ businessId: number; dealId: string; material: Material }>(`${basePath}/material`, controller.signal, 'PUT', body);
            if (controller.signal.aborted || requestRef.current !== controller) return;
            if (result.businessId !== businessId || result.dealId !== dealId || !validMaterial(result.material) || result.material.revision !== payload.revision + 1 || result.material.dealRevision !== payload.dealRevision || result.material.text !== payload.text || !sameItems(result.material.catalogItems, payload.catalogItems)) throw new Error('Сохранение не подтверждено. Ваш текст и ключ повтора сохранены.');
            const readback = await request<Proposal>(basePath, controller.signal);
            if (controller.signal.aborted || requestRef.current !== controller) return;
            if (!validProposal(readback, businessId, dealId) || !readback.material || !sameMaterial(readback.material, result.material)) throw new Error('Сохранение принято, но текущую версию проверить не удалось. Повторите сохранение с тем же текстом или обновите данные.');
            setProposal(readback); setDraft(readback.material.text); setSelected(references(readback.material.catalogItems)); storePending(null);
            setFeedback('Материал сохранён и проверен. Отправка выполняется отдельно в диалоге после вашей проверки.');
        } catch (cause) { if (!controller.signal.aborted && requestRef.current === controller) setError(cause instanceof Error ? cause.message : 'Не удалось подтвердить сохранение. Повторите попытку.'); }
        finally { if (requestRef.current === controller) { requestRef.current = null; setBusy(''); } }
    }
    async function handoff() {
        if (!businessId || !proposal?.material || !canSend || changed || catalogStale || permissionsLoading || requestRef.current) return;
        const revision = proposal.material.revision;
        const controller = new AbortController(); requestRef.current = controller; setBusy('handoff'); setError(''); setFeedback('');
        try {
            const result = await request<{ businessId: number; dealId: string; material: Material; composer: { businessId: number; chatId: string; text: string; materialRevision: number; requiresHumanConfirmation: boolean; href: string } }>(`${basePath}/handoff`, controller.signal, 'POST', { revision });
            if (controller.signal.aborted || requestRef.current !== controller) return;
            const composer = result.composer;
            const expected = typeof composer?.chatId === 'string' && composer.chatId ? `/today?client=${encodeURIComponent(composer.chatId)}&material=${encodeURIComponent(dealId)}&materialRevision=${revision}` : '';
            if (result.businessId !== businessId || result.dealId !== dealId || !validMaterial(result.material) || result.material.revision !== revision || result.material.dealRevision !== proposal.revision || result.material.text !== draft.trim() || !sameItems(result.material.catalogItems, selected) || composer?.businessId !== businessId || composer.materialRevision !== revision || composer.text !== result.material.text || composer.requiresHumanConfirmation !== true || !expected || composer.href !== expected) throw new Error('Не удалось подтвердить получателя или сохранённый материал. Обновите данные.');
            navigate(expected);
        } catch (cause) { if (!controller.signal.aborted && requestRef.current === controller) setError(cause instanceof Error ? cause.message : 'Не удалось открыть проверку отправки.'); }
        finally { if (requestRef.current === controller) { requestRef.current = null; setBusy(''); } }
    }
    function cancelGeneration() { requestRef.current?.abort(); requestRef.current = null; setBusy(''); setFeedback('Ожидание отменено. Предыдущий черновик и ваши правки сохранены на экране.'); }
    async function copyDraft() { try { await navigator.clipboard.writeText(draft); setFeedback('Текст скопирован. Перед отправкой проверьте и подтвердите условия.'); } catch { setError('Не удалось скопировать. Выделите текст в поле и скопируйте вручную.'); } }
    function chooseOffer(offer: CatalogOffer, enabled: boolean) { setSelected(items => enabled ? [...items, { offerId: offer.offerId, offerRevision: offer.offerRevision, quantity: 1 }] : items.filter(item => item.offerId !== offer.offerId)); setFeedback(''); }
    function addCatalogText() {
        const lines = selected.map(item => { const offer = proposal?.catalog?.find(value => value.offerId === item.offerId && value.offerRevision === item.offerRevision); return offer ? `${offer.name} — ${item.quantity} шт. · ${money(offer.amountMinor * item.quantity, offer.currency)}${offer.terms ? `\nУсловия: ${offer.terms}` : ''}` : ''; }).filter(Boolean);
        setDraft(value => `${value.trim()}\n\n${lines.join('\n\n')}`); setFeedback('Позиции добавлены в текст. Проверьте формулировки и сохраните материал.');
    }
    return <div className="ava-studio">
        <header className="ava-studio-hero"><div><p className="ava-studio-eyebrow">AVA / МАТЕРИАЛЫ</p><h1>Предложения и документы</h1><p>Подготовьте предложение по сделке, выберите опубликованные позиции и сохраните текст перед отправкой.</p></div><FileText size={48} strokeWidth={1.25} aria-hidden="true" /></header>
        <div className="ava-studio-grid">
            <section className="ava-studio-card ava-studio-compose" aria-labelledby="ava-studio-proposal-title">
                <div className="ava-studio-card-head"><span className="ava-studio-icon"><FileText size={21} aria-hidden="true" /></span><div><p className="ava-studio-eyebrow">КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ</p><h2 id="ava-studio-proposal-title">Черновик из сделки</h2></div></div>
                <p className="ava-studio-hint">Позиции и цены берутся из опубликованного каталога. Бюджет сделки не подтверждает оплату; доступность и особые условия проверьте перед отправкой.</p>
                {businessId ? <><label htmlFor="ava-studio-deal">Сделка</label><select id="ava-studio-deal" value={dealId} disabled={loading || !!busy || permissionsLoading} onChange={event => {
                    if (proposal && changed && !window.confirm('Несохранённые правки черновика будут потеряны. Сменить сделку?')) return;
                    setDealId(event.target.value); setProposal(null); setDraft(''); setSelected([]); setError(''); setFeedback(''); pendingSave.current = null;
                }}><option value="">{loading ? 'Загружаем сделки…' : 'Выберите сделку'}</option>{deals.map(deal => <option key={deal.id} value={deal.id}>{deal.title}</option>)}</select>
                {!loading && !loadFailed && deals.length === 0 && <p className="ava-studio-empty">Пока нет сделок. <Link to="/deals">Создать сделку</Link></p>}
                <button className="ava-studio-primary" type="button" disabled={!dealId || !!busy || loading || loadFailed || permissionsLoading} onClick={() => void generate()}>{generating ? <Loader2 size={18} className="ava-studio-spin" aria-hidden="true" /> : <FileText size={18} aria-hidden="true" />}{generating ? 'Подготавливаем…' : proposal ? 'Обновить из сделки' : 'Подготовить черновик'}</button></> : <p className="ava-studio-empty">Сначала <Link to="/instances">выберите бизнес</Link>.</p>}
                {generating && <button className="ava-studio-secondary" type="button" onClick={cancelGeneration}><X size={17} aria-hidden="true" />Отменить ожидание</button>}
                {error && <p className="ava-studio-error" role="alert">{error}</p>}
                {proposal && error && <button className="ava-studio-secondary" type="button" disabled={!!busy || permissionsLoading} onClick={() => void generate(true)}>Обновить данные, сохранив текст</button>}
                {loadFailed && <button className="ava-studio-secondary" type="button" disabled={loading} onClick={() => setLoadRevision(value => value + 1)}>Повторить загрузку сделок</button>}
                {permissionsLoading && <p className="ava-studio-hint" role="status">Проверяем доступ к бизнесу…</p>}{feedback && <p className="ava-studio-feedback" role="status"><Check size={16} aria-hidden="true" />{feedback}</p>}
            </section>
            {toolRoutes.length > 0 && <section className="ava-studio-card ava-studio-materials" aria-labelledby="ava-studio-materials-title"><div className="ava-studio-card-head"><span className="ava-studio-icon"><BookOpen size={21} aria-hidden="true" /></span><div><p className="ava-studio-eyebrow">ДРУГИЕ МАТЕРИАЛЫ</p><h2 id="ava-studio-materials-title">Готовые инструменты</h2></div></div><nav className="ava-studio-links" aria-label="Инструменты подготовки материалов">{toolRoutes.includes('/analytics') && <Link to="/analytics"><BarChart3 size={20} aria-hidden="true" /><span><strong>Отчёты по CRM</strong><small>Показатели и динамика на реальных данных</small></span><span aria-hidden="true">↗</span></Link>}{toolRoutes.includes('/knowledge-base') && <Link to="/knowledge-base"><BookOpen size={20} aria-hidden="true" /><span><strong>Знания бизнеса</strong><small>Документы и проверка ответов AVA</small></span><span aria-hidden="true">↗</span></Link>}{toolRoutes.includes('/quick-replies') && <Link to="/quick-replies"><MessageSquareText size={20} aria-hidden="true" /><span><strong>Быстрые ответы</strong><small>Подготовленные фразы для переписки</small></span><span aria-hidden="true">↗</span></Link>}</nav></section>}
        </div>
        {proposal && <section className="ava-studio-card ava-studio-result" aria-labelledby="ava-studio-draft-title">
            <div className="ava-studio-result-head"><div><p className="ava-studio-eyebrow">{proposal.material ? `СОХРАНЁННАЯ ВЕРСИЯ ${proposal.material.revision}${changed ? ' · ЕСТЬ ПРАВКИ' : ''}` : 'РЕДАКТИРУЕМЫЙ ЧЕРНОВИК'}</p><h2 id="ava-studio-draft-title">{proposal.source.dealTitle}</h2></div><div className="ava-studio-actions"><button type="button" onClick={() => void copyDraft()} disabled={!draft}><Copy size={17} aria-hidden="true" />Копировать</button><button type="button" onClick={() => window.print()} disabled={!draft}><Printer size={17} aria-hidden="true" />Печать черновика</button></div></div>
            {supported && <fieldset className="ava-studio-catalog" disabled={!!busy || permissionsLoading || !canSave}><legend>Позиции опубликованного каталога</legend>{!proposal.catalog?.length && <p className="ava-studio-hint">В каталоге нет опубликованных позиций. Текстовый материал можно сохранить; цены и условия уточните отдельно.</p>}{proposal.catalog?.map(offer => { const item = selected.find(value => value.offerId === offer.offerId); return <div className="ava-studio-catalog-row" key={offer.offerId}><label className="ava-studio-catalog-choice"><input type="checkbox" checked={!!item} onChange={event => chooseOffer(offer, event.target.checked)} /><span><strong>{offer.name}</strong><small>{money(offer.amountMinor, offer.currency)} · версия {offer.offerRevision}</small>{offer.description && <small>{offer.description}</small>}{offer.terms && <small>Условия: {offer.terms}</small>}</span></label>{item && <label className="ava-studio-quantity">Количество · {offer.name}<input type="number" min={1} max={10000} step={1} value={item.quantity} onChange={event => setSelected(items => items.map(value => value.offerId === offer.offerId ? { ...value, offerRevision: offer.offerRevision, quantity: Number(event.target.value) } : value))} /></label>}</div>; })}{catalogStale && <p className="ava-studio-error" role="alert">Выбранные позиции изменились или сняты с публикации. Обновите данные и выберите актуальные позиции.</p>}{catalogStale && <button className="ava-studio-secondary" type="button" onClick={() => setSelected([])}>Очистить выбор позиций</button>}<button className="ava-studio-secondary" type="button" disabled={!selected.length || !selectionValid || catalogStale} onClick={addCatalogText}>Добавить позиции в текст</button></fieldset>}
            <label htmlFor="ava-studio-draft">Текст предложения</label><textarea id="ava-studio-draft" disabled={!!busy || permissionsLoading} value={draft} onChange={event => { setDraft(event.target.value); setFeedback(''); }} maxLength={4000} rows={14} spellCheck="true" />
            <p className="ava-studio-hint">Сохранение создаёт версию материала в сделке. Переход в диалог готовит ответ для проверки; сообщение отправляется только отдельным подтверждением в диалоге.</p>
            {supported && <div className="ava-studio-actions ava-studio-save-actions">{canSave && <button type="button" disabled={!!busy || permissionsLoading || !changed || !draft.trim() || draft.length > 4000 || !selectionValid || catalogStale} onClick={() => void saveMaterial()}><Save size={17} aria-hidden="true" />{busy === 'save' ? 'Сохраняем…' : 'Сохранить материал'}</button>}{canSend && <button type="button" disabled={!!busy || permissionsLoading || !proposal.material || changed || catalogStale} onClick={() => void handoff()}><Send size={17} aria-hidden="true" />{busy === 'handoff' ? 'Проверяем…' : 'Проверить и отправить в диалоге'}</button>}{!canSave && <p className="ava-studio-hint">Сохранять материал может сотрудник с правом работы по этой сделке.</p>}{changed && canSend && <p className="ava-studio-hint">Сначала сохраните текущий текст и позиции.</p>}</div>}
            {proposal.material && changed && <details className="ava-studio-saved"><summary>Сравнить с сохранённой версией {proposal.material.revision}</summary><p>{proposal.material.text}</p></details>}
            {proposal.requiresManagerConfirmation.length > 0 && <div className="ava-studio-checks"><strong>Перед отправкой подтвердите:</strong><ul>{proposal.requiresManagerConfirmation.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div>}
            {businessId && proposal.material && <CommercialDocuments key={`${businessId}:${dealId}:${proposal.material.revision}`} businessId={businessId} dealId={dealId} materialRevision={proposal.material.revision} clientChatId={proposal.material.clientChatId} canWrite={canSave && !permissionsLoading} canSend={canSend && !permissionsLoading} changed={changed || catalogStale} storageScope={storageScope}/>}
            <article className="ava-studio-print" aria-label="Печатная версия предложения"><h1>Коммерческое предложение</h1><p>{draft}</p></article>
        </section>}
    </div>;
}
