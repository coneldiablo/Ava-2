import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { getSalesWorkspace } from '../api';
import { getAvailability, updateAvailability, type AvailabilityMember, type AvailabilityResponse, type AvailabilityStatus } from '../improvementsApi';
import { useBusinessAccess } from '../permissions';
import { actionError, type SalesWorkspaceResponse, type TeamResponse } from '../teamSales';

export type TeamOperationsSnapshot = { sales: SalesWorkspaceResponse | null; availability: AvailabilityResponse | null };
const shiftLabels: Record<AvailabilityStatus, string> = { available: 'На смене', break: 'Перерыв', off: 'Не на смене' };
function errorCode(error: unknown) {
    const value = error as { code?: string; response?: { data?: { code?: string } } };
    return value?.response?.data?.code || value?.code;
}
function shiftError(error: unknown) {
    switch (errorCode(error)) {
        case 'WORKSPACE_FEATURE_DISABLED': return 'Смены пока не включены для этого бизнеса. Задачи можно открыть в рабочей очереди.';
        case 'AVAILABILITY_REVISION_CONFLICT': return 'Смену уже изменил другой сотрудник. Обновите данные, проверьте новое состояние и сохраните ещё раз.';
        case 'AVAILABILITY_MEMBER_NOT_FOUND': return 'Доступ сотрудника изменился. Обновите команду перед назначением работы.';
        case 'AVAILABILITY_INPUT_INVALID': return 'Укажите целый лимит больше нуля или оставьте его пустым.';
        default: return actionError(error, 'Не удалось подтвердить смены. Обновите данные и повторите попытку.');
    }
}

export default function TeamOperations({ businessId, team, onSnapshot }: { businessId: number; team: TeamResponse; onSnapshot: (snapshot: TeamOperationsSnapshot) => void }) {
    const access = useBusinessAccess({ membershipOnly: true });
    const writeAllowed = access.can('sales.write'), checking = access.checking;
    const canAssign = access.can('sales.assign') || Boolean(access.checking && team.capabilities.includes('sales.assign'));
    const view = canAssign ? 'team' : 'mine';
    const [sales, setSales] = useState<SalesWorkspaceResponse | null>(null);
    const [availability, setAvailability] = useState<AvailabilityResponse | null>(null);
    const [salesError, setSalesError] = useState('');
    const [availabilityError, setAvailabilityError] = useState('');
    const [loadingSales, setLoadingSales] = useState(true);
    const [loadingShifts, setLoadingShifts] = useState(true);
    const [editing, setEditing] = useState<string | null>(null);
    const [memberLimit, setMemberLimit] = useState(20);
    const [busy, setBusy] = useState('');
    const [rowError, setRowError] = useState<{ userId: string; text: string } | null>(null);
    const [notice, setNotice] = useState('');
    const alive = useRef(true);
    const salesRevision = useRef(0);
    const shiftRevision = useRef(0);
    const action = useRef<AbortController | null>(null);

    const loadSales = useCallback(async (signal?: AbortSignal) => {
        const revision = ++salesRevision.current;
        setLoadingSales(true); setSalesError('');
        try {
            const result = await getSalesWorkspace(businessId, view, 1, signal);
            if (!result.success || result.businessId !== businessId || result.view !== view || !Array.isArray(result.members)
                || !Array.isArray(result.tasks) || !Array.isArray(result.clients) || !Array.isArray(result.capabilities)
                || result.members.some(member => !Number.isSafeInteger(member.openTasks) || member.openTasks < 0 || !Number.isSafeInteger(member.overdueTasks) || member.overdueTasks < 0)) throw new Error();
            if (alive.current && !signal?.aborted && revision === salesRevision.current) setSales(result);
        } catch (error) {
            if (alive.current && !signal?.aborted && revision === salesRevision.current) setSalesError(actionError(error, 'Не удалось обновить нагрузку. Показаны последние полученные данные; обновите их перед распределением.'));
        } finally { if (alive.current && !signal?.aborted && revision === salesRevision.current) setLoadingSales(false); }
    }, [businessId, view]);
    const loadShifts = useCallback(async (signal?: AbortSignal) => {
        const revision = ++shiftRevision.current;
        setLoadingShifts(true); setAvailabilityError('');
        try {
            const result = await getAvailability(businessId, signal);
            if (alive.current && !signal?.aborted && revision === shiftRevision.current) setAvailability(result);
        } catch (error) {
            if (alive.current && !signal?.aborted && revision === shiftRevision.current) {
                if (errorCode(error) === 'WORKSPACE_FEATURE_DISABLED') setAvailability(null);
                setAvailabilityError(shiftError(error));
            }
        } finally { if (alive.current && !signal?.aborted && revision === shiftRevision.current) setLoadingShifts(false); }
    }, [businessId]);
    useEffect(() => {
        alive.current = true;
        const controller = new AbortController();
        void loadSales(controller.signal); void loadShifts(controller.signal);
        return () => { alive.current = false; controller.abort(); action.current?.abort(); };
    }, [loadSales, loadShifts]);
    useEffect(() => { onSnapshot({ sales: salesError ? null : sales, availability: availabilityError ? null : availability }); }, [sales, availability, salesError, availabilityError, onSnapshot]);
    useEffect(() => {
        if (!checking && !writeAllowed) { action.current?.abort(); setEditing(null); }
    }, [checking, writeAllowed]);

    async function save(member: AvailabilityMember, status: AvailabilityStatus, capacity?: number | null) {
        const isSelf = member.userId === team.currentUserId;
        if (busy || loadingShifts || availabilityError || access.checking || !access.can('sales.write') || (!canAssign && !isSelf) || (capacity !== undefined && !canAssign)) return;
        const controller = new AbortController(); action.current = controller;
        setBusy(member.userId); setRowError(null); setNotice('');
        try {
            const result = await updateAvailability(businessId, member.userId, { revision: member.revision, status, ...(capacity !== undefined ? { capacity } : {}) }, controller.signal);
            if (!alive.current || controller.signal.aborted) return;
            if (!result.success || result.businessId !== businessId || result.member?.userId !== member.userId || result.member.revision !== member.revision + 1) throw new Error();
            setEditing(null); setNotice(`Смена для ${member.name} сохранена.`);
            await loadShifts(controller.signal);
        } catch (error) {
            if (alive.current && !controller.signal.aborted) setRowError({ userId: member.userId, text: shiftError(error) });
        } finally { if (alive.current && action.current === controller) { setBusy(''); action.current = null; } }
    }
    const actorRole = team.members.find(member => String(member.userId) === team.currentUserId)?.role;
    const workingMembers = team.members.filter(member => member.role !== 'observer').sort((a, b) => String(a.userId) === team.currentUserId ? -1 : String(b.userId) === team.currentUserId ? 1 : 0);
    return <section className="team-card" aria-labelledby="team-work-title" aria-busy={loadingSales || loadingShifts}>
        <div className="team-card-header"><div><h2 id="team-work-title">Смены и нагрузка</h2><p>Активные клиенты и открытые задачи считаются отдельно.</p></div><button className="team-secondary" disabled={loadingSales || loadingShifts || !!busy} onClick={() => { void loadSales(); void loadShifts(); }}><RefreshCw size={16} aria-hidden="true"/>Обновить нагрузку</button></div>
        {notice && <p className="team-operations-notice" role="status">{notice}</p>}
        {salesError && <p className="team-inline-error" role="alert">{salesError}</p>}
        {availabilityError && <div className="team-shift-error"><p role="alert">{availabilityError}</p><button className="team-secondary" disabled={loadingShifts || !!busy} onClick={() => void loadShifts()}>Обновить смены</button></div>}
        {(loadingSales || loadingShifts) && !sales && !availability && <p className="team-loading" role="status">Загружаем смены и нагрузку…</p>}
        <div className="team-work-links">
            {canAssign && <a className="team-secondary" href="/sales?view=team">Открыть задачи команды<ArrowUpRight size={16} aria-hidden="true"/></a>}
            {actorRole !== 'observer' && <a className="team-secondary" href="/sales?view=mine">Мои задачи<ArrowUpRight size={16} aria-hidden="true"/></a>}
            <a className="team-secondary" href="/sales?view=queue">{canAssign ? 'Назначить свободные задачи' : actorRole === 'observer' ? 'Посмотреть свободные задачи' : 'Взять свободную задачу'}<ArrowUpRight size={16} aria-hidden="true"/></a>
        </div>
        <ul className="team-list">{workingMembers.slice(0, memberLimit).map(member => {
            const id = String(member.userId), shift = availability?.members.find(row => row.userId === id), work = sales?.members.find(row => row.userId === id);
            const isSelf = id === team.currentUserId;
            const canEdit = Boolean(shift && access.can('sales.write') && (canAssign || (actorRole === 'manager' && isSelf)));
            const showEditor = editing === id && shift;
            return <li className="team-member-wrap" key={id}><div className="team-work-member"><div className="team-member-main"><strong>Работа · {member.displayName || member.email}{isSelf ? ' · вы' : ''}</strong><span>{shift && !availabilityError ? shiftLabels[shift.status] : loadingShifts ? 'Проверяем смену…' : 'Смена не подтверждена'}</span></div><div className="team-work-counts"><span>{shift && !availabilityError ? `Активных клиентов: ${shift.currentLoad}${shift.capacity === null ? ' · без лимита' : ` / ${shift.capacity}`}` : 'Нагрузка клиентов не подтверждена'}</span><span>{work && !salesError ? `Открытых задач: ${work.openTasks} · просрочено: ${work.overdueTasks}` : 'Нагрузка задач не подтверждена'}</span>{shift && !availabilityError && shift.capacity !== null && shift.currentLoad >= shift.capacity && <strong>Достигнут лимит клиентов</strong>}</div>{(canEdit || (access.checking && shift && (canAssign || isSelf))) && <button className="team-secondary" disabled={!!busy || access.checking || loadingShifts || !!availabilityError} onClick={() => setEditing(editing === id ? null : id)} aria-expanded={Boolean(showEditor)}>{isSelf ? 'Моя смена' : `Изменить смену · ${member.displayName || member.email}`}</button>}</div>
                {showEditor && <ShiftEditor key={id} member={shift} capacityAllowed={canAssign} blocked={!!busy || access.checking || loadingShifts || !!availabilityError || !canEdit} saving={busy === id} onSave={(status, capacity) => void save(shift, status, capacity)} onCancel={() => setEditing(null)}/>}
                {rowError?.userId === id && <div className="team-shift-error"><p className="team-inline-error" role="alert">{rowError.text}</p><button className="team-secondary" disabled={loadingShifts || !!busy} onClick={() => void loadShifts()}>Обновить смены</button></div>}
            </li>;
        })}</ul>
        {workingMembers.length > memberLimit && <div className="team-work-links"><button className="team-secondary" onClick={() => setMemberLimit(limit => limit + 20)}>Показать ещё сотрудников</button><span className="team-delivery">Показаны {memberLimit} из {workingMembers.length}</span></div>}
        <p className="team-helper">Перерыв и завершение смены сохраняют текущих ответственных. {canAssign ? 'Передайте незавершённую работу в задачах команды.' : 'Если работу нужно передать, обратитесь к руководителю.'} Изменение смены само по себе не переназначает клиентов.</p>
    </section>;
}

function ShiftEditor({ member, capacityAllowed, blocked, saving, onSave, onCancel }: { member: AvailabilityMember; capacityAllowed: boolean; blocked: boolean; saving: boolean; onSave: (status: AvailabilityStatus, capacity?: number | null) => void; onCancel: () => void }) {
    const [status, setStatus] = useState(member.status);
    const [capacity, setCapacity] = useState(member.capacity == null ? '' : String(member.capacity));
    const [invalid, setInvalid] = useState('');
    function submit(event: FormEvent) {
        event.preventDefault();
        if (blocked) return;
        const limit = capacity.trim() ? Number(capacity) : null;
        if (capacityAllowed && limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) { setInvalid('Укажите целый лимит больше нуля или оставьте его пустым.'); return; }
        setInvalid(''); onSave(status, capacityAllowed ? limit : undefined);
    }
    return <form className="team-confirm team-shift-form" onSubmit={submit}>
        <div><label htmlFor={`team-shift-${member.userId}`}>Смена · {member.name}</label><select id={`team-shift-${member.userId}`} disabled={blocked} value={status} onChange={event => setStatus(event.target.value as AvailabilityStatus)}>{Object.entries(shiftLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        {capacityAllowed && <div><label htmlFor={`team-capacity-${member.userId}`}>Лимит активных клиентов · {member.name}</label><input id={`team-capacity-${member.userId}`} type="number" min="1" step="1" value={capacity} disabled={blocked} onChange={event => setCapacity(event.target.value)} aria-describedby={`team-capacity-help-${member.userId}`}/><p id={`team-capacity-help-${member.userId}`}>Пустое поле — без лимита. Уже назначенные клиенты сохраняются.</p></div>}
        {invalid && <p className="team-inline-error" role="alert">{invalid}</p>}
        <div className="team-row-actions"><button className="team-primary" disabled={blocked}>{saving ? 'Сохраняем смену…' : 'Сохранить смену'}</button><button className="team-secondary" type="button" disabled={saving} onClick={onCancel}>Отмена</button></div>
    </form>;
}
