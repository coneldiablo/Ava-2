import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Check, Clock3, ListTodo, Plus, RefreshCw, Search, Users, X } from 'lucide-react';
import { assignSalesClient, claimSalesTask, createSalesTask, getClients, getSalesWorkspace, updateSalesTask } from '../api';
import { useInstance } from '../context/InstanceContext';
import { useBusinessAccess } from '../permissions';
import { actionError, readableDate, type SalesClient, type SalesMember, type SalesPriority, type SalesTask, type SalesTaskInput, type SalesTaskStatus, type SalesTaskUpdate, type SalesView, type SalesWorkspaceResponse } from '../teamSales';
import { getPipeline } from '../businessProfiles';
import { useScopedDraft, type WorkspaceDraftScope } from '../hooks/useScopedDraft';
import { useResource } from '../hooks/useWorkspaceResource';
import { useTodayRefresh } from '../hooks/useTodayRefresh';
import './SalesWorkspace.css';

const priorities = { low: 'Низкий', normal: 'Обычный', high: 'Высокий', urgent: 'Срочный' };
const statuses = { new: 'Новая', in_progress: 'В работе', done: 'Завершена', cancelled: 'Отменена' };
function dateInput(instant: string | null) {
    if (!instant) return '';
    const date = new Date(instant);
    if (Number.isNaN(date.getTime())) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function dueInstant(value: string) { return value ? new Date(value).toISOString() : null; }
function validWorkspace(data: SalesWorkspaceResponse, businessId: number, view: SalesView) {
    return data.success && data.businessId === businessId && data.view === view && Array.isArray(data.tasks) && Array.isArray(data.clients) && Array.isArray(data.members) && Array.isArray(data.capabilities)
        && ['openTasks', 'overdueTasks', 'pendingFollowups', 'unassignedClients'].every(key => Number.isFinite(data.summary?.[key as keyof typeof data.summary]) && data.summary[key as keyof typeof data.summary] >= 0)
        && Number.isFinite(data.pagination?.totalTasks) && Number.isFinite(data.pagination?.totalClients);
}
export default function SalesWorkspace() {
    const { currentInstanceId } = useInstance();
    const access = useBusinessAccess({ membershipOnly: true });
    if (!currentInstanceId) return <section className="ava-sales sales-empty"><ListTodo aria-hidden="true"/><h1>Задачи</h1><p>Выберите бизнес, чтобы открыть задачи и клиентов.</p></section>;
    return <Workspace key={`${access.userId}:${access.role}:${currentInstanceId}`} businessId={currentInstanceId}/>;
}
function Workspace({ businessId }: { businessId: number }) {
    const access = useBusinessAccess({ membershipOnly: true });
    const { currentInstance } = useInstance();
    const [params, setParams] = useSearchParams();
    const scope = { userId: access.userId, businessId };
    const [savedSearch, setSavedSearch] = useScopedDraft(scope, 'sales-search', '');
    const restored = useRef(false);
    useEffect(() => {
        if (!restored.current) { restored.current = true; if (!params.size && savedSearch) { setParams(new URLSearchParams(savedSearch), { replace: true }); return; } }
        setSavedSearch(params.toString());
    }, [params, savedSearch, setParams, setSavedSearch]);
    const canAssign = access.can('sales.assign') || Boolean(access.checking && access.membership?.capabilities?.includes('sales.assign'));
    const defaultView: SalesView = access.role === 'observer' ? 'overview' : ['hotel_owner', 'sales_lead'].includes(access.role) ? 'team' : 'mine';
    const rawView = params.get('view');
    const view: SalesView = rawView === 'queue' || (rawView === 'overview' && access.role === 'observer') || (rawView === 'mine' && access.role !== 'observer') || (rawView === 'team' && canAssign) ? rawView : defaultView;
    const rawPage = Number(params.get('page') || 1);
    const page = Number.isInteger(rawPage) && rawPage > 0 && rawPage <= 100000 ? rawPage : 1;
    const { data, loading, error: loadError, reload } = useResource(`${access.userId}:${businessId}:${view}:${page}`, async signal => {
        const result = await getSalesWorkspace(businessId, view, page, signal);
        if (!validWorkspace(result, businessId, view)) throw new Error('Не удалось проверить список задач. Повторите загрузку.');
        return result;
    });
    const [actionFailure, setActionFailure] = useState<{ key: string; text: string } | null>(null);
    const [busy, setBusy] = useState('');
    const [notice, setNotice] = useState('');
    const [editing, setEditing] = useScopedDraft<string | null>(scope, 'sales-editing', null);
    const [creating, setCreating] = useScopedDraft(scope, 'sales-creating', false);
    const [memberQuery, setMemberQuery] = useScopedDraft(scope, 'sales-member-query', '');
    const [memberPage, setMemberPage] = useScopedDraft(scope, 'sales-member-page', 1);
    const actionController = useRef<AbortController | null>(null);
    const alive = useRef(true);
    const pipeline = getPipeline(currentInstance);
    const statusLabel = (status: string) => pipeline.find(item => item.id === status)?.label || 'Состояние не указано';
    const can = (capability: string) => !loading && !loadError && access.can(capability) && !!data?.capabilities.includes(capability);
    // A permission refresh or a stale read keeps drafts visible, but never enables a mutation.
    const canDisplay = (capability: string) => (access.can(capability) || Boolean(access.checking && (access.membership?.capabilities?.includes(capability) || data?.capabilities.includes(capability))))
        && (!data || data.capabilities.includes(capability));
    const mutationDisabled = !!busy || !can('sales.write');
    useTodayRefresh(!access.checking && !busy, reload);
    const totalPages = data ? Math.max(1, Math.ceil(Math.max(data.pagination.totalTasks, data.pagination.totalClients) / data.pagination.pageSize)) : 1;

    function navigate(nextView: SalesView, nextPage = 1) {
        const next = new URLSearchParams(params); next.set('view', nextView);
        if (nextPage > 1) next.set('page', String(nextPage)); else next.delete('page');
        setParams(next);
    }
    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; actionController.current?.abort(); };
    }, []);
    useEffect(() => {
        if (!access.checking && !access.can('sales.write')) { actionController.current?.abort(); setEditing(null); setCreating(false); }
    }, [access.checking, access.can('sales.write')]);
    useEffect(() => { if (data && page > totalPages) navigate(view, totalPages); }, [data, page, totalPages]);
    async function mutate(key: string, request: (signal: AbortSignal) => Promise<{ success: boolean }>, text: string, onSuccess?: () => void) {
        if (busy || actionController.current || !can('sales.write')) return;
        const controller = new AbortController(); actionController.current = controller;
        setBusy(key); setActionFailure(null); setNotice('');
        try {
            const result = await request(controller.signal);
            if (!alive.current || controller.signal.aborted) return;
            if (!result.success) throw new Error();
            onSuccess?.(); setNotice(text); setEditing(null); setCreating(false);
            reload();
        } catch (error) {
            if (alive.current && !controller.signal.aborted) setActionFailure({ key, text: actionError(error, 'Изменение не подтверждено. Обновите данные и повторите попытку.') });
        } finally { if (alive.current && actionController.current === controller) { setBusy(''); actionController.current = null; } }
    }
    const members = data?.members.filter(member => `${member.displayName} ${member.email}`.toLocaleLowerCase('ru').includes(memberQuery.toLocaleLowerCase('ru'))) || [];
    return <section className="ava-sales">
        <header className="sales-heading"><div><p className="sales-eyebrow">{currentInstance?.name || 'ПРОДАЖИ'}</p><h1>Задачи</h1><p>{access.role === 'observer' ? 'Задачи и клиенты — в режиме просмотра' : 'Задачи, клиенты и следующий шаг — в одном месте'}</p></div><button className="sales-secondary" aria-label="Обновить задачи" disabled={loading} onClick={reload}><RefreshCw size={18} aria-hidden="true"/></button>{canDisplay('sales.write') && <button className="sales-primary" onClick={() => { setCreating(value => !value); setActionFailure(null); }} disabled={mutationDisabled}><Plus size={18} aria-hidden="true"/>Новая задача</button>}</header>
        <nav className="sales-views" aria-label="Представление продаж">{access.role === 'observer' ? <button aria-pressed={view === 'overview'} onClick={() => navigate('overview')}>Все доступные</button> : <button aria-pressed={view === 'mine'} onClick={() => navigate('mine')}>Мои задачи</button>}<button aria-pressed={view === 'queue'} onClick={() => navigate('queue')}>Без ответственного</button>{canAssign && <button aria-pressed={view === 'team'} onClick={() => navigate('team')}>Вся команда</button>}</nav>
        <div className="sales-summary" aria-label="Сводка по выбранному списку">{[
            ['Открытых задач', data?.summary.openTasks, ListTodo], ['Просрочено', data?.summary.overdueTasks, Clock3], ['Сообщений после звонка', data?.summary.pendingFollowups, ArrowUpRight], ['Клиентов без ответственного', data?.summary.unassignedClients, Users]
        ].map(([label, count, Icon], index) => { const Glyph = Icon as typeof ListTodo; return <div className={`sales-stat${index === 0 ? ' sales-stat-primary' : ''}`} key={String(label)}><Glyph size={18} aria-hidden="true"/><span>{String(label)}</span><strong>{typeof count === 'number' ? count : '—'}</strong></div>; })}</div>
        {loadError && <div role="alert" className="sales-alert"><p>{loadError}</p><button className="sales-secondary" onClick={reload} disabled={loading}><RefreshCw size={16} aria-hidden="true"/>Повторить</button></div>}
        {loadError && data && <p className="sales-form-help" role="status">Показан последний загруженный список. Обновите его перед изменениями.</p>}
        {notice && <p role="status" className="sales-notice">{notice}</p>}
        {creating && canDisplay('sales.write') && <NewTaskForm scope={scope} businessId={businessId} members={data?.members || []} userId={access.userId || data?.currentUserId || ''} canAssign={canDisplay('sales.assign')} busy={busy === 'new'} disabled={mutationDisabled} error={actionFailure?.key === 'new' ? actionFailure.text : ''} onClose={() => setCreating(false)} onSubmit={(input, reset) => void mutate('new', signal => createSalesTask(businessId, input, signal), 'Задача создана. Список обновлён.', reset)} />}
        <div className="sales-columns">
            <section className="sales-card" aria-labelledby="sales-tasks-title" aria-busy={loading}><div className="sales-card-header"><div><h2 id="sales-tasks-title">Задачи</h2><p>{view === 'queue' ? 'Можно взять в работу' : view === 'team' ? 'Работа всего отдела' : view === 'overview' ? 'Все доступные задачи · только просмотр' : 'Назначены лично вам'}</p></div><span>{data?.pagination.totalTasks ?? '—'}</span></div>
                {loading && !data && <p className="sales-empty" role="status">Загружаем задачи…</p>}
                {data && data.tasks.length === 0 && <div className="sales-empty"><Check size={24} aria-hidden="true"/><p>{view === 'mine' ? 'У вас нет открытых задач.' : view === 'queue' ? 'Все задачи распределены.' : 'Открытых задач пока нет.'}</p></div>}
                {data && <ul className="sales-task-list">{data.tasks.map(task => { const own = task.assigneeUserId === data.currentUserId; const editable = canDisplay('sales.write') && (canDisplay('tasks.manage') || own); const unassigned = task.assigneeUserId === null; const key = `task:${task.taskId}`; return <li className="sales-task" key={task.taskId}>
                    <div className="sales-task-top"><span className={`sales-priority sales-priority-${task.priority}`}>{priorities[task.priority]}</span><span>{statuses[task.status]}</span></div><h3>{task.summary}</h3><p className="sales-task-meta"><Clock3 size={15} aria-hidden="true"/>{task.dueAt ? readableDate(task.dueAt) : 'Без срока'}{task.dueAt && Date.parse(task.dueAt) < Date.now() && <strong> · Просрочено</strong>}</p><p className="sales-task-owner">{task.assigneeName || (unassigned ? 'Без ответственного' : 'Ответственный назначен')}</p>
                    <div className="sales-actions">{task.chatId && <Link className="sales-text-link" to={`/customers/${encodeURIComponent(task.chatId)}${task.followupDraftId ? `?followup=${encodeURIComponent(task.followupDraftId)}#customer-followups-title` : ''}`}>{task.followupDraftId ? 'Сообщение после звонка' : task.customerName || 'Карточка клиента'}<ArrowUpRight size={16} aria-hidden="true"/></Link>}{unassigned && can('tasks.claim') && <button className="sales-secondary" disabled={!!busy} onClick={() => void mutate(key, signal => claimSalesTask(businessId, task.taskId, signal), 'Задача назначена вам. Список обновлён.')}>Взять задачу</button>}{editable && <button className="sales-secondary" disabled={mutationDisabled} onClick={() => { setEditing(editing === task.taskId ? null : task.taskId); setActionFailure(null); }}>Изменить</button>}</div>
                    {editing === task.taskId && editable && <TaskEditor scope={scope} task={task} members={data.members} canAssign={canDisplay('sales.assign')} busy={busy === key} disabled={mutationDisabled} onClose={() => setEditing(null)} onSubmit={(input, reset) => void mutate(key, signal => updateSalesTask(businessId, task.taskId, input, signal), input.status === 'done' ? 'Задача завершена. Статус отправки сообщения проверяется в карточке клиента.' : 'Задача сохранена. Список обновлён.', reset)}/>}{actionFailure?.key === key && <p role="alert" className="sales-inline-error">{actionFailure.text}</p>}
                </li>; })}</ul>}
            </section>
            <section className="sales-card" aria-labelledby="sales-clients-title" aria-busy={loading}><div className="sales-card-header"><div><h2 id="sales-clients-title">Клиенты</h2><p>{view === 'queue' ? 'Ожидают ответственного' : 'Карточки и ближайшие действия'}</p></div><span>{data?.pagination.totalClients ?? '—'}</span></div>{loading && !data && <p className="sales-empty" role="status">Загружаем клиентов…</p>}{data && data.clients.length === 0 && <p className="sales-empty">{view === 'mine' ? 'За вами пока нет закреплённых клиентов.' : view === 'queue' ? 'Клиенты без ответственного отсутствуют.' : 'Клиентов пока нет.'}</p>}{data && <ul className="sales-client-list">{data.clients.map(client => <li key={client.chatId} className="sales-client"><Link className="sales-client-name" to={`/customers/${encodeURIComponent(client.chatId)}`}>{client.name || 'Клиент без имени'}<ArrowUpRight size={15} aria-hidden="true"/></Link><p>{statusLabel(client.status)}</p><p>{client.assigneeName || (client.assigneeUserId === null ? 'Без ответственного' : 'Ответственный назначен')}</p><small>{client.lastContactAt ? `Последний контакт · ${readableDate(client.lastContactAt)}` : 'Дата контакта не указана'}</small>{canDisplay('sales.assign') ? <ClientAssignee client={client} members={data.members} busy={!!busy || !can('sales.assign')} onSubmit={userId => void mutate(`client:${client.chatId}`, signal => assignSalesClient(businessId, client.chatId, userId, signal), 'Ответственный клиента сохранён.')} /> : client.assigneeUserId === null && can('tasks.claim') && <button className="sales-secondary" disabled={!!busy} onClick={() => void mutate(`client:${client.chatId}`, signal => assignSalesClient(businessId, client.chatId, data.currentUserId, signal), 'Клиент закреплён за вами. Список обновлён.')}>Взять клиента</button>}{actionFailure?.key === `client:${client.chatId}` && <p role="alert" className="sales-inline-error">{actionFailure.text}</p>}</li>)}</ul>}</section>
        </div>
        {data && totalPages > 1 && <nav className="sales-pagination" aria-label="Страницы задач и клиентов"><button className="sales-secondary" disabled={page === 1 || !!busy} onClick={() => navigate(view, page - 1)}>Назад</button><span>{page} / {totalPages}</span><button className="sales-secondary" disabled={page >= totalPages || !!busy} onClick={() => navigate(view, page + 1)}>Далее</button></nav>}
        {data && canAssign && view === 'team' && <section className="sales-card sales-workload" aria-labelledby="workload-title"><div className="sales-card-header"><div><h2 id="workload-title">Нагрузка команды</h2><p>Открытые задачи каждого сотрудника</p></div><Users size={20} aria-hidden="true"/></div><label className="sales-member-search"><Search size={18} aria-hidden="true"/><span className="sr-only">Найти сотрудника</span><input type="search" placeholder="Найти сотрудника" value={memberQuery} onChange={e => { setMemberQuery(e.target.value); setMemberPage(1); }}/></label><ul className="sales-member-list">{members.slice((memberPage - 1) * 20, memberPage * 20).map(member => <li key={member.userId}><strong>{member.displayName || member.email}</strong><span>{member.openTasks} открытых · {member.overdueTasks} просрочено</span></li>)}</ul>{members.length === 0 && <p className="sales-empty">Сотрудники не найдены.</p>}{members.length > 20 && <nav className="sales-pagination" aria-label="Страницы нагрузки"><button className="sales-secondary" disabled={memberPage === 1} onClick={() => setMemberPage(memberPage - 1)}>Назад</button><span>{memberPage}</span><button className="sales-secondary" disabled={memberPage * 20 >= members.length} onClick={() => setMemberPage(memberPage + 1)}>Далее</button></nav>}</section>}
    </section>;
}
function AssigneeSelect({ members, value, onChange, disabled, id }: { members: SalesMember[]; value: string; onChange: (value: string) => void; disabled: boolean; id: string }) {
    return <select id={id} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}><option value="">Без ответственного</option>{members.filter(member => member.role !== 'observer').map(member => <option key={member.userId} value={member.userId}>{member.displayName || member.email}</option>)}</select>;
}
function ClientAssignee({ client, members, busy, onSubmit }: { client: SalesClient; members: SalesMember[]; busy: boolean; onSubmit: (value: string | null) => void }) {
    const [value, setValue] = useState(client.assigneeUserId || '');
    useEffect(() => setValue(client.assigneeUserId || ''), [client.assigneeUserId]);
    const id = `client-owner-${client.chatId}`;
    return <form className="sales-client-assign" onSubmit={e => { e.preventDefault(); onSubmit(value || null); }}><label htmlFor={id}>Ответственный</label><AssigneeSelect id={id} members={members} value={value} onChange={setValue} disabled={busy}/><button className="sales-secondary" disabled={busy || value === (client.assigneeUserId || '')}>Назначить</button></form>;
}
function TaskEditor({ scope, task, members, canAssign, busy, disabled, onClose, onSubmit }: { scope: WorkspaceDraftScope; task: SalesTask; members: SalesMember[]; canAssign: boolean; busy: boolean; disabled: boolean; onClose: () => void; onSubmit: (value: SalesTaskUpdate, reset: () => void) => void }) {
    const [draft, setDraft, reset] = useScopedDraft({ ...scope, chatId: task.chatId || undefined }, `sales-task:${task.taskId}`, () => ({ summary: task.summary, status: task.status, dueAt: dateInput(task.dueAt), priority: task.priority, assignee: task.assigneeUserId || '' }));
    const { summary, status, dueAt, priority, assignee } = draft;
    const setSummary = (summary: string) => setDraft(previous => ({ ...previous, summary }));
    const setStatus = (status: SalesTaskStatus) => setDraft(previous => ({ ...previous, status }));
    const setDueAt = (dueAt: string) => setDraft(previous => ({ ...previous, dueAt }));
    const setPriority = (priority: SalesPriority) => setDraft(previous => ({ ...previous, priority }));
    const setAssignee = (assignee: string) => setDraft(previous => ({ ...previous, assignee }));
    const prefix = `task-${task.taskId}`;
    return <form className="sales-editor" onSubmit={e => { e.preventDefault(); onSubmit({ summary: summary.trim(), status, dueAt: dueInstant(dueAt), priority, ...(canAssign ? { assigneeUserId: assignee || null } : {}) }, reset); }}><label htmlFor={`${prefix}-summary`}>Что нужно сделать</label><textarea id={`${prefix}-summary`} value={summary} onChange={e => setSummary(e.target.value)} required maxLength={800} disabled={busy}/><div className="sales-form-grid"><div><label htmlFor={`${prefix}-status`}>Состояние задачи</label><select id={`${prefix}-status`} value={status} onChange={e => setStatus(e.target.value as SalesTaskStatus)} disabled={busy}>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div><div><label htmlFor={`${prefix}-due`}>Срок · ваше местное время</label><input id={`${prefix}-due`} type="datetime-local" value={dueAt} onChange={e => setDueAt(e.target.value)} disabled={busy}/></div><div><label htmlFor={`${prefix}-priority`}>Приоритет</label><select id={`${prefix}-priority`} value={priority} onChange={e => setPriority(e.target.value as SalesPriority)} disabled={busy}>{Object.entries(priorities).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>{canAssign && <div><label htmlFor={`${prefix}-owner`}>Ответственный</label><AssigneeSelect id={`${prefix}-owner`} members={members} value={assignee} onChange={setAssignee} disabled={busy}/></div>}</div>{task.followupDraftId && <p className="sales-form-help">Завершение задачи не отправляет сообщение. Проверьте его отдельно в карточке клиента.</p>}<div className="sales-actions"><button className="sales-primary" disabled={disabled || busy || !summary.trim()}>{busy ? 'Сохраняем…' : 'Сохранить'}</button><button className="sales-secondary" type="button" onClick={onClose} disabled={busy}>Отмена</button></div></form>;
}
function NewTaskForm({ scope, businessId, members, userId, canAssign, busy, disabled, error, onClose, onSubmit }: { scope: WorkspaceDraftScope; businessId: number; members: SalesMember[]; userId: string; canAssign: boolean; busy: boolean; disabled: boolean; error: string; onClose: () => void; onSubmit: (value: SalesTaskInput, reset: () => void) => void }) {
    const [options, setOptions] = useState<{ chatId: string; senderName: string }[] | null>(null), [optionsError, setOptionsError] = useState('');
    const [draft, setDraft, reset] = useScopedDraft(scope, 'sales-new-task', () => ({ query: '', selected: null as { chatId: string; senderName: string } | null, summary: '', dueAt: '', priority: 'normal' as SalesPriority, assignee: userId }));
    const { query, selected, summary, dueAt, priority, assignee } = draft;
    const setQuery = (query: string) => setDraft(previous => ({ ...previous, query }));
    const setSelected = (selected: typeof draft.selected) => setDraft(previous => ({ ...previous, selected }));
    const setSummary = (summary: string) => setDraft(previous => ({ ...previous, summary }));
    const setDueAt = (dueAt: string) => setDraft(previous => ({ ...previous, dueAt }));
    const setPriority = (priority: SalesPriority) => setDraft(previous => ({ ...previous, priority }));
    const setAssignee = (assignee: string) => setDraft(previous => ({ ...previous, assignee }));
    const focus = useRef<HTMLInputElement>(null);
    useEffect(() => { focus.current?.focus(); let active = true; const controller = new AbortController(); getClients(businessId, controller.signal).then(result => { if (!result.success || !Array.isArray(result.clients)) throw new Error(); if (active) setOptions(result.clients); }).catch(() => { if (active) setOptionsError('Не удалось загрузить клиентов. Закройте форму и откройте снова.'); }); return () => { active = false; controller.abort(); }; }, [businessId]);
    const matching = options?.filter(option => (option.senderName || '').toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru'))).slice(0, 10) || [];
    function submit(event: FormEvent) { event.preventDefault(); if (!disabled && !busy && selected) onSubmit({ chatId: selected.chatId, summary: summary.trim(), dueAt: dueInstant(dueAt), priority, ...(canAssign ? { assigneeUserId: assignee || null } : {}) }, reset); }
    return <section className="sales-card sales-new-task" aria-labelledby="new-task-title"><div className="sales-card-header"><h2 id="new-task-title">Новая задача</h2><button className="sales-secondary" onClick={onClose} aria-label="Закрыть новую задачу" disabled={busy}><X size={18} aria-hidden="true"/></button></div><form className="sales-editor" onSubmit={submit} aria-busy={busy}><label htmlFor="task-customer-search">Клиент</label>{selected ? <div className="sales-selected-customer"><strong>{selected.senderName || 'Клиент без имени'}</strong><button className="sales-secondary" type="button" disabled={busy} onClick={() => setSelected(null)}>Выбрать другого</button></div> : <><input ref={focus} id="task-customer-search" type="search" value={query} disabled={busy} placeholder="Начните вводить имя" onChange={e => setQuery(e.target.value)} aria-describedby="customer-search-help"/><p id="customer-search-help" className="sales-form-help">{options ? 'Показаны первые 10 совпадений. Уточните имя.' : optionsError || 'Загружаем клиентов…'}</p><ul className="sales-typeahead" aria-label="Найденные клиенты">{matching.map(option => <li key={option.chatId}><button type="button" disabled={busy} onClick={() => setSelected(option)}>{option.senderName || 'Клиент без имени'}</button></li>)}</ul>{options && matching.length === 0 && <p className="sales-form-help">Клиенты не найдены.</p>}</>}<label htmlFor="task-new-summary">Что нужно сделать</label><textarea id="task-new-summary" required maxLength={800} value={summary} onChange={e => setSummary(e.target.value)} disabled={busy}/><div className="sales-form-grid"><div><label htmlFor="task-new-due">Срок · ваше местное время</label><input id="task-new-due" type="datetime-local" value={dueAt} onChange={e => setDueAt(e.target.value)} disabled={busy}/></div><div><label htmlFor="task-new-priority">Приоритет</label><select id="task-new-priority" value={priority} onChange={e => setPriority(e.target.value as SalesPriority)} disabled={busy}>{Object.entries(priorities).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></div>{canAssign && <div><label htmlFor="task-new-owner">Ответственный</label><AssigneeSelect id="task-new-owner" members={members} value={assignee} onChange={setAssignee} disabled={busy}/></div>}</div>{error && <p role="alert" className="sales-inline-error">{error}</p>}<button className="sales-primary" disabled={disabled || busy || !selected || !summary.trim()}>{busy ? 'Создаём…' : 'Создать задачу'}</button></form></section>;
}
