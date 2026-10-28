import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, RefreshCw, Search, Share2, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { useInstance } from '../context/InstanceContext';
import { useAuth } from '../context/AuthContext';
import { useBusinessAccess } from '../permissions';
import { createTeamInvitation, getBusinessTeam, renewTeamInvitation, resendTeamInvitation, revokeTeamInvitation, removeTeamMember, updateTeamMemberRole } from '../api';
import { actionError, invitationDeliveryLabel, readableDate, roleLabel, type InviteRole, type InviteResult, type TeamMember, type TeamResponse } from '../teamSales';
import TeamOperations, { type TeamOperationsSnapshot } from './TeamOperations';
import './Team.css';

const PAGE_SIZE = 20;
export default function Team() {
    const { currentInstanceId, currentInstance } = useInstance();
    const { userId } = useAuth();
    if (!currentInstanceId) return <section className="ava-team team-empty"><Users aria-hidden="true"/><h1>Команда</h1><p>Выберите бизнес, чтобы открыть команду.</p></section>;
    return <TeamWorkspace key={`${userId || 'anonymous'}:${currentInstanceId}`} businessId={currentInstanceId} businessName={currentInstance?.name || 'этого бизнеса'} />;
}
function TeamWorkspace({ businessId, businessName }: { businessId: number; businessName: string }) {
    const { userId } = useAuth();
    const access = useBusinessAccess();
    const [team, setTeam] = useState<TeamResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [formError, setFormError] = useState('');
    const [rowError, setRowError] = useState<{ key: string; text: string } | null>(null);
    const [busyKey, setBusyKey] = useState('');
    const [email, setEmail] = useState('');
    const [inviteRole, setInviteRole] = useState<InviteRole>('manager');
    const [link, setLink] = useState<InviteResult | null>(null);
    const [copied, setCopied] = useState(false);
    const [notice, setNotice] = useState('');
    const [query, setQuery] = useState('');
    const [page, setPage] = useState(1);
    const [invitePage, setInvitePage] = useState(1);
    const [edit, setEdit] = useState<{ member: TeamMember; role: InviteRole } | null>(null);
    const [remove, setRemove] = useState<TeamMember | null>(null);
    const [operations, setOperations] = useState<TeamOperationsSnapshot>({ sales: null, availability: null });
    const sequence = useRef(0);
    const controller = useRef<AbortController | null>(null);
    const alive = useRef(true);
    const manageAllowed = access.can('team.manage'), checking = access.checking;
    const canManage = (manageAllowed || checking) && !!team?.capabilities.includes('team.manage');
    const blocked = !!busyKey || access.checking || loading || !!loadError;
    const filtered = team?.members.filter(member => `${member.displayName || ''} ${member.email} ${roleLabel(member.role)}`.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))) || [];

    const load = useCallback(async (signal?: AbortSignal) => {
        const revision = ++sequence.current;
        setLoading(true); setLoadError('');
        try {
            const data = await getBusinessTeam(businessId, signal);
            if (!data.success || data.businessId !== businessId || !Array.isArray(data.members) || !Array.isArray(data.invitations) || !Array.isArray(data.roleOptions) || !Array.isArray(data.capabilities)) throw new Error();
            if (alive.current && !signal?.aborted && revision === sequence.current) setTeam(data);
        } catch (error) {
            if (alive.current && !signal?.aborted && revision === sequence.current) {
                const data = (error as { response?: { data?: { code?: string } } })?.response?.data;
                if (['CAPABILITY_DENIED', 'BUSINESS_ACCESS_DENIED', 'ACCOUNT_NOT_ACTIVE'].includes(data?.code || '')) { setTeam(null); setLink(null); setEdit(null); setRemove(null); }
                setLoadError(actionError(error, 'Не удалось обновить команду. Введённые данные сохранены; обновите список и повторите попытку.'));
            }
        } finally { if (alive.current && !signal?.aborted && revision === sequence.current) setLoading(false); }
    }, [businessId]);
    useEffect(() => {
        alive.current = true;
        const request = new AbortController(); void load(request.signal);
        return () => { alive.current = false; request.abort(); controller.current?.abort(); };
    }, [load]);
    useEffect(() => {
        setPage(current => Math.min(current, Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))));
        setInvitePage(current => Math.min(current, Math.max(1, Math.ceil((team?.invitations.length || 0) / PAGE_SIZE))));
    }, [filtered.length, team?.invitations.length]);
    useEffect(() => {
        setLink(current => {
            if (current?.invitationId == null) return current;
            const invitation = team?.invitations.find(item => String(item.id) === String(current.invitationId));
            if (!invitation) return current;
            if (invitation.state !== 'pending') return null;
            return { ...current, expiresAt: invitation.expiresAt, delivery: invitation.delivery };
        });
    }, [team]);
    useEffect(() => {
        if (!checking && !manageAllowed) { controller.current?.abort(); setLink(null); setEdit(null); setRemove(null); }
    }, [checking, manageAllowed]);
    async function mutate(key: string, request: (signal: AbortSignal) => Promise<{ success: boolean }>, onSuccess?: (result: unknown) => void) {
        if (!canManage || blocked) return;
        const active = new AbortController(); controller.current = active;
        setBusyKey(key); setFormError(''); setRowError(null); setNotice('');
        try {
            const result = await request(active.signal);
            if (active.signal.aborted || !alive.current) return;
            if (!result.success) throw new Error();
            onSuccess?.(result);
            await load(active.signal);
        } catch (error) {
            if (!active.signal.aborted && alive.current) {
                const text = actionError(error, 'Изменение не подтверждено. Обновите данные и повторите попытку.');
                if (key === 'invite') setFormError(text); else setRowError({ key, text });
            }
        } finally { if (alive.current && controller.current === active) { setBusyKey(''); controller.current = null; } }
    }
    function showLink(result: unknown) {
        const data = result as InviteResult;
        const url = new URL(data.inviteUrl, window.location.origin);
        if (url.origin !== window.location.origin || url.pathname !== '/invite' || url.hash.length < 2 || url.search || url.username || url.password) throw new Error();
        setLink({ ...data, inviteUrl: url.href }); setCopied(false); setEmail(''); setNotice(`Приглашение готово. ${invitationDeliveryLabel(data.delivery)}`);
    }
    function resend(invitationId: string | number) { if (blocked) return; setLink(null); void mutate(`invite:${invitationId}`, signal => resendTeamInvitation(businessId, invitationId, signal), result => { showLink(result); setNotice(`Ссылка обновлена: прежняя ссылка больше не действует. ${invitationDeliveryLabel((result as InviteResult).delivery)}`); }); }
    function invite(event: FormEvent) { event.preventDefault(); if (blocked) return; setLink(null); void mutate('invite', signal => createTeamInvitation(businessId, { email: email.trim(), role: inviteRole }, signal), showLink); }
    async function copy() {
        if (!link) return;
        try { await navigator.clipboard.writeText(link.inviteUrl); if (alive.current) { setCopied(true); setNotice('Ссылка скопирована.'); } }
        catch { if (alive.current) setNotice('Выделите ссылку и скопируйте её вручную.'); }
    }
    async function share() {
        if (!link) return;
        try { await navigator.share({ title: `Приглашение в ${businessName}`, url: link.inviteUrl }); }
        catch { /* Cancelling the native share sheet keeps the link available. */ }
    }
    return <section className="ava-team">
        <header className="team-heading"><div><p className="team-eyebrow">ЛЮДИ И РАБОТА</p><h1>Команда</h1><p className="team-subtitle">{businessName} · смены, нагрузка и доступы сотрудников</p></div><button className="team-secondary" disabled={loading || !!busyKey} onClick={() => void load()}><RefreshCw size={16} aria-hidden="true"/>Обновить команду</button></header>
        {loadError && <div className="team-alert" role="alert">{loadError}<button className="team-retry" onClick={() => void load()}><RefreshCw size={16} aria-hidden="true"/>Повторить</button></div>}
        {notice && <p className="team-notice" role="status">{notice}</p>}
        {access.checking && <p className="team-notice" role="status">Проверяем права. Введённые данные сохранены; изменения временно недоступны.</p>}
        {canManage && <section className="team-card team-invite-card" aria-labelledby="invite-title">
            <div className="team-card-header"><div><h2 id="invite-title">Пригласить сотрудника</h2><p>Укажите почту и выберите доступ. После создания покажем результат отправки письма и личную ссылку.</p></div><UserPlus size={21} aria-hidden="true"/></div>
            <form className="team-invite-form" onSubmit={invite} aria-busy={busyKey === 'invite'}>
                <div className="team-invite-fields"><div><label htmlFor="team-email">Рабочая почта</label><input id="team-email" type="email" autoComplete="email" required maxLength={254} value={email} disabled={blocked} onChange={e => setEmail(e.target.value)} placeholder="name@company.ru" aria-describedby={formError ? 'invite-error' : undefined}/></div><div><label htmlFor="team-role">Роль в бизнесе</label><select id="team-role" value={inviteRole} disabled={blocked} onChange={e => setInviteRole(e.target.value as InviteRole)}>{team?.roleOptions.map(option => <option key={option.role} value={option.role}>{option.label}</option>)}</select></div><button type="submit" className="team-primary" disabled={blocked || !email.trim()}>{busyKey === 'invite' ? 'Создаём…' : 'Пригласить'}</button></div>
                {formError && <p id="invite-error" role="alert" className="team-inline-error">{formError}</p>}
            </form><p className="team-helper">Менеджер ведёт клиентов, руководитель распределяет работу, наблюдатель просматривает данные.</p>
            {link && <div className="team-link-box"><p className="team-delivery" role="status">{invitationDeliveryLabel(link.delivery)}</p><label htmlFor="invite-link">Личная ссылка · до {readableDate(link.expiresAt)}</label><div className="team-link-row"><input id="invite-link" readOnly value={link.inviteUrl} onFocus={e => e.currentTarget.select()}/><button onClick={copy} className="team-copy-button"><span aria-hidden="true">{copied ? <Check size={17}/> : <Copy size={17}/>}</span>{copied ? 'Скопировано' : 'Копировать'}</button>{typeof navigator.share === 'function' && <button className="team-secondary" onClick={share}><Share2 size={17} aria-hidden="true"/>Поделиться</button>}</div>{link.invitationId != null && <div className="team-resend"><p>Повторная отправка создаст новую ссылку. Прежняя ссылка больше не будет действовать.</p><button className="team-secondary" disabled={blocked || link.delivery?.state === 'sending'} onClick={() => resend(link.invitationId!)}>{busyKey === `invite:${link.invitationId}` ? 'Отправляем…' : 'Отправить письмо ещё раз'}</button>{rowError?.key === `invite:${link.invitationId}` && <p className="team-inline-error" role="alert">{rowError.text}</p>}</div>}</div>}
        </section>}
        {team && access.membership?.capabilities?.includes('sales.read') && <TeamOperations businessId={businessId} team={team} onSnapshot={setOperations}/>}
        <section className="team-card" aria-labelledby="members-title" aria-busy={loading}>
            <div className="team-card-header"><div><h2 id="members-title">Участники</h2><p>Действующие доступы к этому бизнесу</p></div><span className="team-count">{team?.members.length ?? '—'}</span></div>
            {team && <div className="team-toolbar"><label htmlFor="team-search">Найти сотрудника</label><div className="team-search"><Search size={18} aria-hidden="true"/><input id="team-search" type="search" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} placeholder="Имя, почта или роль"/></div></div>}
            {loading && !team && <p className="team-loading" role="status">Загружаем команду…</p>}
            {team && <ul className="team-list">{filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(member => {
                const key = `member:${member.userId}`;
                const self = String(member.userId) === String(userId || team.currentUserId);
                return <li className="team-member-wrap" key={key}><div className="team-member"><span className="team-avatar" aria-hidden="true">{(member.displayName || member.email).slice(0, 1).toUpperCase()}</span><div className="team-member-main"><strong>{member.displayName || member.email}{self ? ' · вы' : ''}</strong>{member.displayName && <span>{member.email}</span>}<span>{roleLabel(member.role)}</span></div>{canManage && !self && <div className="team-row-actions"><button className="team-secondary" disabled={blocked} onClick={() => { setRemove(null); setEdit({ member, role: member.role === 'hotel_owner' ? 'manager' : member.role }); }}>Изменить роль</button><button className="team-secondary" disabled={blocked} onClick={() => { setEdit(null); setRemove(member); }}>Удалить доступ</button></div>}{self && <ShieldCheck size={18} aria-label="Ваш доступ"/>}</div>
                    {edit?.member.userId === member.userId && <form className="team-confirm" onSubmit={e => { e.preventDefault(); void mutate(key, signal => updateTeamMemberRole(businessId, member.userId, edit.role, signal), () => { setEdit(null); setNotice('Роль сохранена.'); }); }}><label htmlFor={`role-${member.userId}`}>Роль для {member.displayName || member.email}</label><select id={`role-${member.userId}`} value={edit.role} onChange={e => setEdit({ member, role: e.target.value as InviteRole })} disabled={blocked}>{team.roleOptions.map(option => <option key={option.role} value={option.role}>{option.label}</option>)}</select><p>Изменение применяется только к бизнесу «{businessName}».</p><div className="team-row-actions"><button className="team-primary" disabled={blocked}>{busyKey === key ? 'Сохраняем…' : 'Сохранить роль'}</button><button className="team-secondary" type="button" onClick={() => setEdit(null)} disabled={blocked}>Отмена</button></div></form>}
                    {remove?.userId === member.userId && <div className="team-confirm"><strong>Удалить доступ для {member.displayName || member.email}?</strong><p>Сотрудник потеряет доступ к бизнесу «{businessName}». Его аккаунт AVA сохранится.</p><DeparturePreview member={member} operations={operations}/><div className="team-row-actions"><button className="team-danger" disabled={blocked} onClick={() => void mutate(key, signal => removeTeamMember(businessId, member.userId, signal), () => { setRemove(null); setNotice('Доступ к бизнесу удалён. Откройте свободные задачи и клиентов, чтобы назначить новых ответственных.'); })}>{busyKey === key ? 'Удаляем…' : `Удалить доступ к «${businessName}»`}</button><button className="team-secondary" disabled={blocked} onClick={() => setRemove(null)}>Отмена</button></div></div>}
                    {rowError?.key === key && <p className="team-inline-error" role="alert">{rowError.text}</p>}
                </li>;
            })}</ul>}
            {team && filtered.length === 0 && <p className="team-loading">{team.members.length ? 'Сотрудники не найдены.' : 'В этом бизнесе пока нет сотрудников.'}</p>}
            {team && filtered.length > PAGE_SIZE && <Pager page={page} total={filtered.length} onChange={setPage}/>}
        </section>
        {canManage && team && team.invitations.length > 0 && <section className="team-card" aria-labelledby="pending-title"><div className="team-card-header"><div><h2 id="pending-title">Приглашения</h2><p>Повторная отправка заменит ссылку; прежняя перестанет действовать.</p></div><span className="team-count">{team.invitations.length}</span></div><ul className="team-list">{team.invitations.slice((invitePage - 1) * PAGE_SIZE, invitePage * PAGE_SIZE).map(invitation => { const key = `invite:${invitation.id}`; return <li className="team-member-wrap" key={key}><div className="team-member"><UserPlus size={20} aria-hidden="true"/><div className="team-member-main"><strong>{invitation.email}</strong><span>{roleLabel(invitation.role)} · до {readableDate(invitation.expiresAt)}</span><span className="team-delivery">{invitationDeliveryLabel(invitation.delivery)}</span><span>{invitation.state === 'expired' ? 'Срок истёк' : invitation.state === 'redeeming' ? 'Доступ создаётся' : 'Ожидает принятия'}</span></div><div className="team-row-actions"><button className="team-secondary" disabled={blocked || invitation.state !== 'pending' || invitation.delivery?.state === 'sending'} onClick={() => resend(invitation.id)}>{busyKey === key ? 'Отправляем…' : 'Отправить письмо ещё раз'}</button><button className="team-secondary" disabled={blocked || invitation.state === 'redeeming'} onClick={() => { setLink(null); void mutate(key, signal => renewTeamInvitation(businessId, invitation.id, signal), showLink); }}>Обновить ссылку</button><button className="team-secondary" disabled={blocked || invitation.state === 'redeeming'} onClick={() => void mutate(key, signal => revokeTeamInvitation(businessId, invitation.id, signal), () => { setLink(null); setNotice(`Приглашение для ${invitation.email} отозвано.`); })}>Отозвать</button></div></div>{rowError?.key === key && <p role="alert" className="team-inline-error">{rowError.text}</p>}</li>; })}</ul>{team.invitations.length > PAGE_SIZE && <Pager page={invitePage} total={team.invitations.length} onChange={setInvitePage}/>}</section>}
        {team && !canManage && <p className="team-readonly"><ShieldCheck size={18} aria-hidden="true"/>Приглашениями и доступами управляет владелец бизнеса.</p>}
    </section>;
}
function DeparturePreview({ member, operations }: { member: TeamMember; operations: TeamOperationsSnapshot }) {
    const id = String(member.userId);
    const work = operations.sales?.members.find(row => row.userId === id);
    const shift = operations.availability?.members.find(row => row.userId === id);
    const tasks = operations.sales?.tasks.filter(task => task.assigneeUserId === id) || [];
    return <div className="team-departure-preview">
        <strong>Незавершённая работа</strong>
        <p>{work ? `Открытых задач: ${work.openTasks} · просрочено: ${work.overdueTasks}.` : 'Количество задач пока не подтверждено. Обновите нагрузку и проверьте задачи команды.'} {shift ? `Активных клиентов: ${shift.currentLoad}.` : 'Количество активных клиентов не подтверждено.'}</p>
        {tasks.length > 0 && <><p>Задачи сотрудника из первой страницы общего списка:</p><ul>{tasks.slice(0, 3).map(task => <li key={task.taskId}>{task.chatId ? <a href={`/customers/${encodeURIComponent(task.chatId)}`}>{task.summary}</a> : task.summary}</li>)}</ul></>}
        <p>При удалении доступа текущие назначения снимаются. Задачи и клиенты сохраняются в списке без ответственного. Если результат отправки ещё неизвестен, сначала проверьте его в карточке клиента: повторять сообщение до проверки нельзя.</p>
        <div className="team-row-actions"><a className="team-secondary" href="/sales?view=team">Проверить задачи команды</a><a className="team-secondary" href="/sales?view=queue">Открыть без ответственного</a></div>
    </div>;
}
function Pager({ page, total, onChange }: { page: number; total: number; onChange: (page: number) => void }) {
    return <nav className="team-pagination" aria-label="Страницы списка"><button className="team-secondary" disabled={page === 1} onClick={() => onChange(page - 1)}>Назад</button><span>{page} / {Math.ceil(total / PAGE_SIZE)}</span><button className="team-secondary" disabled={page * PAGE_SIZE >= total} onClick={() => onChange(page + 1)}>Далее</button></nav>;
}
