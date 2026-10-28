import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock3, RefreshCw, Sparkles } from 'lucide-react';
import { useBusinessAccess } from '../permissions';
import { getAttention, getAvailability, updateAvailability, generateCopilot, type AvailabilityResponse, type CopilotResponse } from '../improvementsApi';
import { getClientWorkspace, sourceHref, workspaceRequest } from '../avaWorkspace';
import { createSalesTask } from '../api';
import { useAction, useResource } from '../hooks/useWorkspaceResource';
import { Feedback, LoadState } from './WorkspaceUi';
import { readableDate } from '../teamSales';
import { useScopedDraft } from '../hooks/useScopedDraft';
import { useTodayRefresh } from '../hooks/useTodayRefresh';


export function TodayAttention({ businessId, userId, choose }: { businessId: number; userId: string | null | undefined; choose: (chatId: string) => void }) {
    const resource = useResource(`${businessId}:${userId}:attention`, signal => getAttention(businessId, signal));
    useTodayRefresh(true, resource.reload);
    return <details className="aw-today-attention aw-surface"><summary><Clock3 size={16} aria-hidden="true" />Требует внимания{resource.data && <span>{resource.data.counts.total}</span>}</summary><LoadState {...resource} empty="Срочных действий пока нет.">{resource.data?.items.length ? <ul>{resource.data.items.map(item => <li key={item.id}><div><strong>{item.title}</strong><p>{item.description}</p>{item.dueAt && <small>{readableDate(item.dueAt)}</small>}</div>{item.chatId ? <button className="aw-button" onClick={() => choose(item.chatId!)}>Открыть клиента</button> : <Link className="aw-button" to={sourceHref(item.href, '/sales')}>Открыть</Link>}</li>)}</ul> : undefined}</LoadState><button className="aw-link-button" disabled={resource.loading} onClick={resource.reload}><RefreshCw size={14} aria-hidden="true" />Обновить</button></details>;
}
const statusLabel = { available: 'На смене', break: 'Перерыв', off: 'Вне смены' };
export function TodayAvailability({ businessId }: { businessId: number }) {
    const access = useBusinessAccess(), action = useAction();
    const resource = useResource(`${businessId}:${access.userId}:availability`, signal => getAvailability(businessId, signal));
    useTodayRefresh(true, resource.reload, 45000);
    const own = resource.data?.members.find(row => row.userId === access.userId);
    const manage = ['hotel_owner', 'sales_lead'].includes(access.role) && access.can('sales.assign');
    const canOwn = access.can('sales.write') && (access.role === 'manager' || manage);
    function change(row: AvailabilityResponse['members'][number], status: 'available' | 'break' | 'off', capacity = row.capacity) {
        void action.run(`availability:${row.userId}`, async signal => { await updateAvailability(businessId, row.userId, { revision: row.revision, status, ...(manage ? { capacity } : {}) }, signal); return 'Доступность обновлена.'; }, resource.reload);
    }
    return <details className="aw-today-availability aw-surface"><summary>Смена и команда{own && <span>{statusLabel[own.status]}</span>}</summary><Feedback {...action} /><LoadState {...resource} empty="Состав команды пока недоступен.">{resource.data?.members.length ? <ul>{resource.data.members.map(row => <li key={row.userId}><div><strong>{row.name}{row.userId === access.userId ? ' · Вы' : ''}</strong><small>{statusLabel[row.status]} · Клиентов: {row.currentLoad}{row.capacity === null ? '' : ` / ${row.capacity}`}</small></div>{(manage || (canOwn && row.userId === access.userId)) ? <label><span className="sr-only">Смена: {row.name}</span><select value={row.status} disabled={access.checking || resource.loading || Boolean(action.busy)} onChange={event => change(row, event.target.value as 'available' | 'break' | 'off')}>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : null}{manage && <Capacity key={`${row.userId}:${row.revision}`} name={row.name} capacity={row.capacity} disabled={access.checking || resource.loading || Boolean(action.busy)} save={capacity => change(row, row.status, capacity)} />}</li>)}</ul> : undefined}</LoadState></details>;
}
function Capacity({ name, capacity, disabled, save }: { name: string; capacity: number | null; disabled: boolean; save: (capacity: number | null) => void }) {
    const [value, setValue] = useState(capacity === null ? '' : String(capacity));
    const valid = value === '' || (Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 10000);
    return <form className="aw-today-capacity" onSubmit={event => { event.preventDefault(); if (valid) save(value === '' ? null : Number(value)); }}><label><span className="sr-only">Лимит клиентов: {name}</span><input type="number" min={1} max={10000} placeholder="Без лимита" value={value} disabled={disabled} onChange={event => setValue(event.target.value)} /></label><button className="aw-button" disabled={disabled || !valid || value === (capacity === null ? '' : String(capacity))}>Сохранить лимит</button></form>;
}

type Intent = 'reply' | 'offer' | 'next_action';
export function TodayCopilot({ businessId, chatId, dialogueRevision, disabled, canReply, canWrite, insert, reload }: { businessId: number; chatId: string; dialogueRevision?: string; disabled: boolean; canReply: boolean; canWrite: boolean; insert: (text: string) => void; reload: () => void }) {
    const access = useBusinessAccess(), action = useAction();
    const scope = { userId: access.userId, businessId, chatId };
    const [result, setResult] = useScopedDraft<CopilotResponse | null>(scope, 'copilot-result', null), [text, setText] = useScopedDraft(scope, 'copilot-text', '');
    const currentRevision = useRef(dialogueRevision); currentRevision.current = dialogueRevision;
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const stale = Boolean(result && result.dialogueRevision !== dialogueRevision);
    function generate(intent: Intent) {
        if (disabled || !access.can('ai.use')) return;
        void action.run(`copilot:${intent}`, async signal => {
            const response = await generateCopilot(businessId, chatId, intent, signal);
            if (!alive.current || signal.aborted) return;
            if (response.dialogueRevision !== currentRevision.current) { reload(); return 'История изменилась. Обновите контекст и запросите новую подсказку.'; }
            setResult(response); setText(response.draft.kind === 'next_action' ? response.draft.task?.summary || response.draft.text : response.draft.text); return 'Проверьте подсказку перед использованием.';
        });
    }
    async function checkCurrent(signal: AbortSignal) {
        const current = await getClientWorkspace(businessId, chatId, signal);
        if (signal.aborted || !alive.current) throw new DOMException('Cancelled', 'AbortError');
        if (!result || current.dialogueRevision !== result.dialogueRevision || current.control.sendInProgress) { if (alive.current && !signal.aborted) reload(); throw Object.assign(new Error('Context changed'), { code: 'COPILOT_CONTEXT_CHANGED' }); }
    }
    if (!access.can('ai.use') && !(access.checking && access.membership?.capabilities?.includes('ai.use'))) return null;
    const busy = disabled || !access.can('ai.use') || !dialogueRevision || Boolean(action.busy);
    return <section className="aw-today-copilot" aria-label="Помощник менеджера"><div className="aw-today-copilot-actions"><span><Sparkles size={15} aria-hidden="true" />Помощник</span>{canReply && <button type="button" className="aw-button" disabled={busy} onClick={() => generate('reply')}>Черновик ответа</button>}{canWrite && <><button type="button" className="aw-button" disabled={busy} onClick={() => generate('offer')}>Предложение</button><button type="button" className="aw-button" disabled={busy} onClick={() => generate('next_action')}>Следующее действие</button></>}</div>{!dialogueRevision && <p className="aw-muted" role="status">Контекст помощника пока недоступен. <button type="button" className="aw-link-button" disabled={disabled} onClick={reload}>Обновить контекст</button></p>}<Feedback {...action} />{result && <div className="aw-today-copilot-review"><label htmlFor="aw-copilot-review">Проверьте и отредактируйте</label><textarea id="aw-copilot-review" value={text} maxLength={4000} disabled={busy || stale || result.draft.kind === 'offer'} rows={3} onChange={event => setText(event.target.value)} />{result.draft.kind === 'offer' && <p className="aw-muted">После подтверждения откройте предложение в контексте клиента и проверьте условия каталога перед отправкой.</p>}{result.draft.sources.length > 0 && <details><summary>Источники</summary><ul>{result.draft.sources.map((source, index) => <li key={index}>{source.href ? <Link to={sourceHref(source.href, '/today')}>{source.title || 'Источник контекста'}</Link> : <span>{source.title || 'Источник контекста'}</span>}</li>)}</ul></details>}{stale && <p role="status" className="aw-muted">История изменилась. Запросите новую подсказку.</p>}<div className="aw-item-actions">{result.draft.kind === 'reply' && canReply && <button type="button" className="aw-button" disabled={busy || stale || !text.trim()} onClick={() => { insert(text); setResult(null); }}>Вставить в ответ</button>}{result.draft.kind === 'offer' && canWrite && result.draft.offerId && <button type="button" className="aw-button" disabled={busy || stale} onClick={() => void action.run('confirm-offer', async signal => {
        await checkCurrent(signal);
        await workspaceRequest(businessId, '/quotes', 'post', { chatId, offerId: result.draft.offerId, quantity: 1 }, signal);
        if (!signal.aborted && alive.current) setResult(null); return 'Предложение подготовлено из каталога. Проверьте его в контексте клиента.';
    }, reload)}>Подтвердить предложение</button>}{result.draft.kind === 'next_action' && canWrite && result.draft.task && <button type="button" className="aw-button" disabled={busy || stale || !text.trim() || text.trim().length > 800} onClick={() => void action.run('confirm-task', async signal => {
        await checkCurrent(signal);
        const response = await createSalesTask(businessId, { chatId, summary: text.trim(), dueAt: null, priority: 'normal' }, signal);
        if (!response.success) throw new Error(); if (!signal.aborted && alive.current) setResult(null); return 'Задача создана. Клиенту ничего не отправлено.';
    }, reload)}>Подтвердить задачу</button>}<button type="button" className="aw-link-button" disabled={Boolean(action.busy)} onClick={() => setResult(null)}>Закрыть подсказку</button></div></div>}</section>;
}
