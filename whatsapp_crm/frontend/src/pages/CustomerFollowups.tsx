import { useEffect, useRef, useState } from "react";
import { useBusinessAccess } from '../permissions';

interface Draft {
  draft_id: string;
  text: string;
  status: string;
  channel?: string;
  recipient?: string;
  assigneeUserId?: string | null;
  assigneeName?: string | null;
  assignee?: string | null;
  manager_task_id?: string | null;
  call_link?: string | null;
  dueAt?: string | null;
}
interface Member { userId: string; displayName: string; email?: string }
interface Channel { channel: string; recipient: string; label: string }
function readDraft(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storeDraft(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Server save remains available. */ }
}
function clearDraft(key: string) {
  try { localStorage.removeItem(key); } catch { /* Nothing to clear. */ }
}
const statuses: Record<string, string> = {
  draft: "Подготовлено для менеджера", pending: "Результат отправки уточняется",
  failed: "Не отправлено", sent: "Отправлено", approved: 'Готово к отправке', rejected: 'Отклонено',
  sending: 'Отправляется', unknown: 'Результат отправки уточняется', unknown_pending: 'Результат отправки уточняется',
  'unknown-pending': 'Результат отправки уточняется', delivery_pending: 'Результат отправки уточняется', unconfirmed: 'Результат отправки уточняется',
};
const unresolved = new Set(['pending', 'sending', 'unknown', 'unknown_pending', 'unknown-pending', 'delivery_pending', 'unconfirmed']);
function permissionResponse(response: Response) {
  if (response.status === 401) window.dispatchEvent(new Event('crm:unauthorized'));
  if (response.status === 403) window.dispatchEvent(new Event('crm:forbidden'));
}

export default function CustomerFollowups({ instanceId, chatId, requestedDraftId = '', customerName = 'Клиент', refreshToken = 0 }: { instanceId: number; chatId: string; requestedDraftId?: string; customerName?: string; refreshToken?: number }) {
  const access = useBusinessAccess();
  const canWrite = access.can('sales.write');
  const canSend = access.can('messages.send');
  const canManage = access.can('tasks.manage');
  const canClaim = access.can('tasks.claim') || canManage;
  // The sales-workspace API requires actual business membership, including
  // for platform operators. Read scope must survive a transient auth recheck:
  // a 403 must not toggle the effect off/on and request itself indefinitely.
  const rosterScope = access.membership?.capabilities?.includes('sales.assign') === true;
  const canAssign = rosterScope && access.can('sales.assign');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [members, setMembers] = useState<Member[]>([]);
  const [rosterError, setRosterError] = useState('');
  const [assignment, setAssignment] = useState<{ draftId: string; userId: string } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [visibleCount, setVisibleCount] = useState(10);
  const [taskLimit, setTaskLimit] = useState(20);
  const scope = `${instanceId}:${chatId}:${access.userId || 'session'}`;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const permissionsRef = useRef({ canWrite, canSend, canManage, canAssign, userId: access.userId, checking: access.checking });
  permissionsRef.current = { canWrite, canSend, canManage, canAssign, userId: access.userId, checking: access.checking };
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const base = `/api/clients/${instanceId}/${encodeURIComponent(chatId)}`;
  const draftsUrl = `${base}/followup-drafts${requestedDraftId || taskLimit > 20 ? '?limit=100' : ''}`;
  const requestedDraftRef = useRef<HTMLDivElement>(null);
  const focusedDraftScope = useRef('');
  const editable = (draft: Draft) => permissionsRef.current.canWrite && Boolean(permissionsRef.current.userId) && ['draft', 'approved', 'failed'].includes(draft.status)
    && (permissionsRef.current.canManage || Boolean(permissionsRef.current.userId && draft.assigneeUserId === permissionsRef.current.userId));
  const claimable = (draft: Draft) => canWrite && canClaim && Boolean(access.userId) && ['draft', 'approved', 'failed'].includes(draft.status)
    && draft.assigneeUserId === null;
  const activeDraft = drafts.find(draft => draft.draft_id === active);
  const canEditActive = Boolean(activeDraft && editable(activeDraft));
  const selectedChannel = selected === '' ? undefined : channels[Number(selected)];
  const storageKey = (draftId: string) => `ava-followup:${instanceId}:${access.userId || 'session'}:${draftId}`;

  useEffect(() => {
    setDrafts([]); setChannels([]); setActive(null); setText(''); setSelected('');
    setError(''); setNotice(''); setBusy(false);
    setReviewing(false); setConfirmed(false); setAssignment(null); setMembers([]); setVisibleCount(10); setTaskLimit(20);
  }, [base, access.userId]);

  useEffect(() => { setReviewing(false); setConfirmed(false); }, [active, text, selected, selectedChannel?.channel, selectedChannel?.recipient, scope, canSend]);

  useEffect(() => {
    if (!rosterScope) { setMembers([]); return; }
    const controller = new AbortController();
    setRosterError('');
    fetch(`/api/businesses/${instanceId}/sales-workspace?view=team&page=1&pageSize=30`, { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        permissionResponse(response);
        const result = await response.json();
        if (!response.ok || !result.success || result.businessId !== instanceId || !Array.isArray(result.members)) throw new Error('Не удалось загрузить сотрудников. Обновите задачи, чтобы повторить.');
        if (!controller.signal.aborted) setMembers(result.members);
      }).catch(() => { if (!controller.signal.aborted) setRosterError('Не удалось загрузить сотрудников. Обновите задачи, чтобы повторить.'); });
    return () => controller.abort();
  }, [instanceId, access.userId, rosterScope, revision, refreshToken]);

  useEffect(() => {
    if (!access.checking && !canEditActive) { setActive(null); setText(''); setSelected(''); }
  }, [canEditActive, access.checking]);

  useEffect(() => {
    if (loading || !requestedDraftId || !requestedDraftRef.current) return;
    const focusScope = `${scope}:${requestedDraftId}`;
    if (focusedDraftScope.current === focusScope) return;
    focusedDraftScope.current = focusScope;
    requestedDraftRef.current.focus({ preventScroll: true });
    requestedDraftRef.current.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  }, [loading, requestedDraftId, drafts, scope]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    Promise.all([draftsUrl, `${base}/followup-channels`].map(url =>
      fetch(url, { credentials: 'same-origin', signal: controller.signal })))
      .then(async responses => {
        responses.forEach(permissionResponse);
        if (responses.some(response => !response.ok)) throw new Error('Не удалось загрузить задачи и доступные каналы.');
        const [tasks, options] = await Promise.all(responses.map(response => response.json()));
        if (controller.signal.aborted) return;
        if (!tasks.success || !options.success || !Array.isArray(tasks.drafts) || !Array.isArray(options.channels))
          throw new Error('Не удалось загрузить задачи и доступные каналы.');
        setDrafts(tasks.drafts); setChannels(options.channels);
      })
      .catch(() => { if (!controller.signal.aborted) setError('Не удалось загрузить задачи и доступные каналы. Повторите загрузку; введённый текст сохранён.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, draftsUrl, revision, refreshToken]);

  const assign = async (draft: Draft) => {
    if (!canAssign || !assignment?.userId || assignment.draftId !== draft.draft_id || !draft.manager_task_id || busy) return;
    const requestScope = scope;
    const userId = assignment.userId;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/businesses/${instanceId}/sales-workspace/tasks/${encodeURIComponent(draft.manager_task_id)}`, {
        method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assigneeUserId: userId }),
      });
      permissionResponse(response);
      const result = await response.json();
      if (!mounted.current || scopeRef.current !== requestScope) return;
      if (!response.ok || !result.success || result.businessId !== instanceId) throw new Error(response.status === 409 ? 'Назначение изменилось или результат отправки ещё уточняется. Обновите задачи перед повтором.' : 'Не удалось назначить задачу. Обновите сотрудников и повторите.');
      const readback = await fetch(draftsUrl, { credentials: 'same-origin' });
      permissionResponse(readback);
      const persisted = await readback.json();
      if (!mounted.current || scopeRef.current !== requestScope) return;
      const current = persisted.drafts?.find((item: Draft) => item.draft_id === draft.draft_id) as Draft | undefined;
      if (!readback.ok || !persisted.success || !current || current.assigneeUserId !== userId) throw new Error('Назначение не удалось проверить. Обновите задачи перед следующим действием.');
      setDrafts(persisted.drafts); setAssignment(null); setNotice('Ответственный назначен. Задача доступна сотруднику в рабочем дне.');
    } catch (cause) { if (mounted.current && scopeRef.current === requestScope) setError(cause instanceof Error && !(cause instanceof TypeError || cause instanceof SyntaxError) ? cause.message : 'Не удалось назначить задачу. Обновите задачи и повторите.'); }
    finally { if (mounted.current && scopeRef.current === requestScope) setBusy(false); }
  };

  const open = async (draft: Draft) => {
    if (busy || (!editable(draft) && !claimable(draft))) return;
    const requestScope = scope;
    setBusy(true); setError(''); setNotice('');
    try {
      let opened = draft;
      if (!editable(draft)) {
        const response = await fetch(`/api/sales-brain/followup-drafts/${encodeURIComponent(draft.draft_id)}/claim`, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId }),
        });
        permissionResponse(response);
        const result = await response.json();
        if (!mounted.current || scopeRef.current !== requestScope) return;
        if (!response.ok || !result.success || !result.draft) throw new Error(response.status === 409
          ? 'Задача уже у другого менеджера. Обновите карточку.' : 'Не удалось взять задачу. Попробуйте ещё раз.');
        opened = result.draft as Draft;
        if (!editable(opened)) throw new Error('Назначение задачи не подтверждено. Обновите карточку.');
        setDrafts(previous => previous.map(item => item.draft_id === opened.draft_id ? opened : item));
      }
      setActive(opened.draft_id);
      setText(readDraft(storageKey(opened.draft_id)) ?? opened.text);
      const index = channels.findIndex(channel => channel.channel === opened.channel && channel.recipient === opened.recipient);
      setSelected(index >= 0 ? String(index) : '');
    } catch (cause) {
      if (mounted.current && scopeRef.current === requestScope) setError(cause instanceof Error && !(cause instanceof TypeError || cause instanceof SyntaxError) ? cause.message : 'Не удалось открыть задачу. Обновите задачи и повторите.');
    } finally { if (mounted.current && scopeRef.current === requestScope) setBusy(false); }
  };

  const action = async (send: boolean) => {
    if (!active || !canEditActive || (send && (!canSend || !reviewing || !confirmed)) || busy || !text.trim()) return;
    if (text.length > 500) { setError('Сообщение должно содержать не более 500 символов. Исходный текст сохранён.'); return; }
    const choice = selected === '' ? undefined : channels[Number(selected)];
    if (send && !choice) { setError('Выберите связанный канал для отправки.'); return; }
    const requestScope = scope;
    const draftId = active;
    let sendAttempted = false;
    setBusy(true); setError(''); setNotice('');
    try {
      const url = `/api/sales-brain/followup-drafts/${encodeURIComponent(draftId)}`;
      const saved = await fetch(url, {
        method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId, text, ...(choice ? { channel: choice.channel, recipient: choice.recipient } : {}) }),
      });
      permissionResponse(saved);
      const result = await saved.json();
      if (!mounted.current || scopeRef.current !== requestScope) return;
      if (!saved.ok || !result.success) throw new Error('Не удалось сохранить черновик. Текст оставлен в этом браузере для повторной попытки.');
      // Confirm persisted content before exposing a successful save or sending.
      const readback = await fetch(draftsUrl, { credentials: 'same-origin' });
      permissionResponse(readback);
      const persisted = await readback.json();
      if (!mounted.current || scopeRef.current !== requestScope) return;
      const current = Array.isArray(persisted.drafts) ? persisted.drafts.find((item: Draft) => item.draft_id === draftId) as Draft | undefined : undefined;
      if (!readback.ok || !persisted.success || !current || typeof current.text !== 'string')
        throw new Error('Черновик сохранён, но проверить данные не удалось. Обновите карточку перед отправкой.');
      setDrafts(persisted.drafts); setText(current.text);
      if (!editable(current)) {
        if (!permissionsRef.current.checking) setActive(null);
        throw new Error(permissionsRef.current.checking ? 'Проверяем доступ. Повторите действие после проверки.' : 'Назначение задачи изменилось. Обновите карточку.');
      }
      if (current.text !== text) throw new Error('Сохранённый текст отличается. Проверьте сообщение перед отправкой.');
      if (send && choice && (current.channel !== choice.channel || current.recipient !== choice.recipient)) throw new Error('Сохранённый адресат отличается. Проверьте канал перед отправкой.');
      clearDraft(storageKey(draftId));
      if (!send) { setNotice('Черновик сохранён.'); return; }
      if (!permissionsRef.current.canSend) throw new Error('Доступ к отправке изменился. Обновите карточку.');
      sendAttempted = true;
      const response = await fetch(`${url}/send`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId }) });
      permissionResponse(response);
      const sent = await response.json();
      if (!mounted.current || scopeRef.current !== requestScope) return;
      if (unresolved.has(sent.status) || unresolved.has(sent.draft?.status)) {
        setNotice('Отправка ожидает подтверждения. Повторная отправка пока недоступна.'); setActive(null); return;
      }
      if (!response.ok || !sent.success) throw new Error(sent.status === 'failed' || sent.draft?.status === 'failed' ? 'Сообщение не отправлено. Черновик сохранён; проверьте канал и повторите.' : 'Результат отправки пока не установлен. Обновите задачи перед следующим действием; повторная отправка заблокирована до проверки.');
      setActive(null);
      setNotice(sent.status === 'already_sent' && sent.draft?.status === 'sent' ? 'Сообщение уже было отправлено.'
        : sent.success === true && sent.sent === true && sent.status === 'sent' ? 'Сообщение отправлено.' : 'Отправка ожидает подтверждения. Черновик сохранён.');
    } catch (cause) {
      if (mounted.current && scopeRef.current === requestScope) {
        if (sendAttempted) setActive(null);
        const message = sendAttempted && !(cause instanceof Error && cause.message.startsWith('Сообщение не отправлено.')) ? 'Результат отправки пока не установлен. Обновите задачи перед следующим действием; повторная отправка заблокирована до проверки.' : cause instanceof Error && !(cause instanceof TypeError || cause instanceof SyntaxError) ? cause.message : 'Не удалось сохранить черновик. Ваш текст сохранён в браузере; повторите действие.';
        if (sendAttempted) setNotice(message);
        else setError(message);
      }
    } finally {
      if (mounted.current && scopeRef.current === requestScope) { if (sendAttempted) setRevision(value => value + 1); setBusy(false); }
    }
  };

  const shownDrafts = requestedDraftId ? [...drafts.filter(draft => draft.draft_id === requestedDraftId), ...drafts.filter(draft => draft.draft_id !== requestedDraftId).slice(0, visibleCount)] : drafts.slice(0, visibleCount);
  return <section className="customer-intelligence__card customer-intelligence__timeline-card" aria-labelledby="customer-followups-title" aria-busy={loading || busy}>
    <div className="customer-intelligence__event-head"><h2 id="customer-followups-title">Задачи и подготовленные сообщения</h2><button type="button" className="customer-intelligence__refresh" disabled={busy || loading} onClick={() => setRevision(value => value + 1)}>Обновить задачи</button></div>
    {loading && <p role="status">Загружаем задачи…</p>}
    {!loading && !error && requestedDraftId && !drafts.some(draft => draft.draft_id === requestedDraftId) && <p role="status" className="customer-intelligence__limit">Задача по ссылке не найдена в текущем списке. Здесь показываем до 100 последних задач клиента.</p>}
    {!loading && !drafts.length && !error && <p className="customer-intelligence__caption">Пока нет подготовленных сообщений.</p>}
    <div className="customer-intelligence__timeline">
      {shownDrafts.map(draft => <div key={draft.draft_id}
        ref={draft.draft_id === requestedDraftId ? requestedDraftRef : undefined}
        tabIndex={draft.draft_id === requestedDraftId ? -1 : undefined}
        aria-label={draft.draft_id === requestedDraftId ? 'Задача по открытой ссылке' : undefined}
        className={`customer-intelligence__memory-group${draft.draft_id === requestedDraftId ? ' customer-intelligence__memory-group--requested' : ''}`}>
        {draft.draft_id === requestedDraftId && <p className="customer-intelligence__caption">Задача по открытой ссылке</p>}
        <p>{statuses[draft.status] || 'Состояние задачи требует проверки'}</p>
        <p className="customer-intelligence__message">{draft.text}</p>
        <p className="customer-intelligence__caption">Ответственный: {draft.assigneeName || members.find(member => member.userId === draft.assigneeUserId)?.displayName || (draft.assigneeUserId === access.userId && access.userId ? 'Вы' : draft.assigneeUserId ? 'Назначен сотруднику' : 'Не назначен')}</p>
        {draft.call_link?.startsWith('/calls') && <a href={draft.call_link}>Открыть исходный звонок</a>}
        {unresolved.has(draft.status) && <p className="customer-intelligence__limit">Повторная отправка недоступна, пока не установлен результат. <a href={`/today?client=${encodeURIComponent(chatId)}`}>Открыть разговор и проверить отправку</a></p>}
        {canAssign && draft.manager_task_id && ['draft', 'approved', 'failed'].includes(draft.status) && <div className="customer-intelligence__assignment">
          <label>Назначить сотруднику<select value={assignment?.draftId === draft.draft_id ? assignment.userId : ''} disabled={busy || !members.length} onChange={event => setAssignment({ draftId: draft.draft_id, userId: event.target.value })}><option value="">Выберите сотрудника</option>{members.map(member => <option key={member.userId} value={member.userId}>{member.displayName || member.email || 'Сотрудник'}</option>)}</select></label>
          <button type="button" className="customer-intelligence__refresh" disabled={busy || assignment?.draftId !== draft.draft_id || !assignment.userId} onClick={() => void assign(draft)}>Назначить</button>
        </div>}
        {(editable(draft) || claimable(draft)) && <button type="button" className="customer-intelligence__refresh" disabled={busy}
          onClick={() => { void open(draft); }}>{editable(draft) ? 'Открыть задачу' : 'Взять задачу'}</button>}
      </div>)}
    </div>
    {(drafts.length > visibleCount || (drafts.length >= taskLimit && taskLimit < 100)) && <button type="button" className="customer-intelligence__refresh" disabled={loading} onClick={() => { setVisibleCount(value => value + 10); if (visibleCount >= taskLimit) setTaskLimit(100); }}>Показать ещё задачи</button>}
    {taskLimit === 100 && drafts.length >= 100 && <p className="customer-intelligence__caption">Загружены 100 последних подготовленных сообщений. <a href="/sales">Открыть все задачи</a></p>}
    {rosterError && <p role="alert" className="customer-intelligence__notice--error">{rosterError}</p>}
    {active && canEditActive && <form className="customer-intelligence__contact-form" onSubmit={event => { event.preventDefault(); void action(false); }}>
      <label>Сообщение клиенту<textarea maxLength={Math.max(500, text.length)} value={text} disabled={busy} aria-invalid={text.length > 500} aria-describedby="customer-followup-length"
        onChange={event => { setText(event.target.value); storeDraft(storageKey(active), event.target.value); }} /></label>
      <p id="customer-followup-length" role="status">{text.length} / 500 символов{text.length > 500 ? ' · Сократите сообщение перед сохранением.' : ''}</p>
      <label>Связанный канал<select value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>
        <option value="">Выберите канал</option>{channels.map((channel, index) => <option key={`${channel.channel}:${channel.recipient}`} value={index}>{channel.label}</option>)}
      </select></label>
      {!channels.length && <p>Нет доступных связанных каналов. Обратитесь к владельцу бизнеса.</p>}
      <div className="customer-intelligence__filters">
        <button disabled={busy || !text.trim()}>{busy ? 'Сохраняем…' : 'Сохранить черновик'}</button>
        {canSend && <button type="button" disabled={busy || !text.trim() || text.length > 500 || selected === ''} onClick={() => { setReviewing(true); setConfirmed(false); }}>Отправить клиенту</button>}
        <button type="button" disabled={busy} onClick={() => setActive(null)}>Закрыть</button>
      </div>
      {reviewing && selectedChannel && <div className="customer-intelligence__send-review" role="region" aria-label="Проверка перед отправкой">
        <h3>Проверьте сообщение и адресата</h3><p>{customerName} · {selectedChannel.label} · <span className="customer-intelligence__contact-value">{selectedChannel.recipient.replace(/@(c\.us|s\.whatsapp\.net)$/, '')}</span></p>
        <p className="customer-intelligence__message">{text}</p>
        <label className="customer-intelligence__confirmation"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />Я проверил адресата и текст сообщения</label>
        <button type="button" className="customer-intelligence__refresh" disabled={busy || !confirmed} onClick={() => void action(true)}>Подтвердить отправку</button>
        <button type="button" className="customer-intelligence__refresh" disabled={busy} onClick={() => { setReviewing(false); setConfirmed(false); }}>Вернуться к правке</button>
      </div>}
    </form>}
    {error && <p role="alert" className="customer-intelligence__notice--error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
