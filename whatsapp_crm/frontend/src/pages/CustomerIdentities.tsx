import { useEffect, useRef, useState } from "react";
import { useBusinessAccess } from '../permissions';
import { canOperateCustomer } from '../customerPermissions';
import { customerDisplayName, formatCustomerPhone } from '../customerDisplay';
import './CustomerIntelligence.css';

function permissionResponse(response: Response) {
  if (response.status === 401) window.dispatchEvent(new Event('crm:unauthorized'));
  if (response.status === 403) window.dispatchEvent(new Event('crm:forbidden'));
}

interface Dialogue {
  instanceId: number;
  chatId: string;
  senderName?: string;
  channel?: string;
  telegramChatId?: string;
  emailAddress?: string;
  vkUserId?: string;
  maxUserId?: string;
  maxChatId?: string;
  lastMessage?: string;
}
function dialogueContact(dialogue: Dialogue, kind: string): string {
  if (kind === 'telegram') return dialogue.telegramChatId || (/^tg_-?[1-9]\d*$/.test(dialogue.chatId) ? dialogue.chatId.slice(3) : '');
  if (kind === 'avito') return /^avito:[1-9]\d{0,29}:[A-Za-z0-9_~\-]{1,160}$/.test(dialogue.chatId) ? dialogue.chatId.slice(6) : '';
  if (kind === 'whatsapp') return /^[1-9]\d{6,14}@(c\.us|s\.whatsapp\.net)$/.test(dialogue.chatId) ? dialogue.chatId.replace('@s.whatsapp.net','@c.us') : '';
  if (kind === 'email') return dialogue.emailAddress?.trim().toLowerCase() || '';
  if (kind === 'vk') return dialogue.vkUserId || (/^vk_[1-9]\d*$/.test(dialogue.chatId) ? dialogue.chatId.slice(3) : '');
  if (kind === 'max') return dialogue.maxUserId ? `user:${dialogue.maxUserId}` : dialogue.maxChatId ? `chat:${dialogue.maxChatId}` : /^max_[1-9]\d*$/.test(dialogue.chatId) ? `user:${dialogue.chatId.slice(4)}` : '';
  return '';
}
interface Alias {
  id: number | null;
  primary?: boolean;
  kind: string;
  value: string;
}
interface IdentityResult {
  success: boolean;
  aliases?: Alias[];
  canonicalChatId?: string;
  conflictingChatId?: string;
}
export default function CustomerIdentities({
  instanceId,
  chatId,
  onLinked,
  assigneeUserId,
  customerName = 'Клиент',
  refreshToken = 0,
}: {
  instanceId: number;
  chatId: string;
  onLinked: () => void;
  assigneeUserId?: string | null;
  customerName?: string;
  refreshToken?: number;
}) {
  const access = useBusinessAccess();
  const canWrite = canOperateCustomer(access, { assigneeUserId }, 'sales.write');
  const [dialogues, setDialogues] = useState<Dialogue[]>([]);
  const [numberMode, setNumberMode] = useState(false);
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [kind, setKind] = useState("telegram");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [revision, setRevision] = useState(0);
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;
  const activeScope = useRef('');
  const url = `/api/clients/${instanceId}/${encodeURIComponent(chatId)}/identities`;
  activeScope.current = `${url}:${access.userId || 'session'}`;
  useEffect(() => () => { activeScope.current = ''; }, []);
  useEffect(() => { setPreviewing(false); setConfirmed(false); }, [kind, value, numberMode]);
  useEffect(() => {
    const controller = new AbortController();
    setError(''); setNotice('');
    fetch(`/api/clients/${instanceId}`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        permissionResponse(response);
        if (!response.ok) throw new Error("Не удалось загрузить диалоги.");
        const result = await response.json();
        if (controller.signal.aborted) return;
        if (!result.success) throw new Error("Не удалось загрузить диалоги.");
        setDialogues(
          (result.clients || []).filter(
            (item: Dialogue) =>
              Number(item.instanceId) === instanceId && item.chatId !== chatId,
          ),
        );
      })
      .catch((cause) => {
        if (cause.name !== "AbortError")
          setError("Не удалось загрузить диалоги.");
      });
    fetch(url, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        permissionResponse(response);
        if (!response.ok)
          throw new Error("Не удалось загрузить связанные контакты.");
        const result = (await response.json()) as IdentityResult;
        if (controller.signal.aborted) return;
        if (!result.success)
          throw new Error("Не удалось загрузить связанные контакты.");
        setAliases(result.aliases || []);
      })
      .catch((cause) => {
        if (cause.name !== "AbortError") setError("Не удалось загрузить связанные контакты. Повторите загрузку.");
      });
    return () => controller.abort();
  }, [url, revision, refreshToken]);
  const submit = async () => {
    if (!canWrite || busy || !value.trim() || ((conflict || previewing) && !confirmed)) return;
    if ((kind === 'phone' || numberMode) && (!/^\+?[\d ()-]+$/.test(value.trim()) || !/^[1-9]\d{6,14}$/.test(value.replace(/\D/g, "")))) {
      setError("Укажите полный номер с кодом страны.");
      return;
    }
    if (!previewing) { setPreviewing(true); setConfirmed(false); setError(''); return; }
    const requestScope = activeScope.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          value:
            kind === "whatsapp" && numberMode
              ? `${value.replace(/\D/g, "").replace(/^8(\d{10})$/, "7$1")}@c.us`
              : value.trim(),
          ...(conflict ? { mergeChatId: conflict, confirmMerge: true } : {}),
        }),
      });
      permissionResponse(response);
      const result = (await response.json()) as IdentityResult;
      if (activeScope.current !== requestScope || !canWriteRef.current) return;
      if (response.status === 409 && result.conflictingChatId) {
        setConflict(result.conflictingChatId);
        setConfirmed(false);
        return;
      }
      if (!response.ok || !result.success)
        throw new Error(
          response.status === 403
            ? "Нет доступа к этому контакту."
            : "Контакт не привязан. Проверьте выбранный диалог или номер и повторите.",
        );
      setAliases(result.aliases || []);
      setValue("");
      setConflict(null);
      setConfirmed(false);
      setPreviewing(false);
      setNotice("Контакт привязан. История обновлена.");
      onLinked();
    } catch (cause) {
      if (activeScope.current === requestScope) setError(
        cause instanceof Error && !(cause instanceof TypeError || cause instanceof SyntaxError)
          ? cause.message
          : "Не удалось привязать контакт.",
      );
    } finally {
      if (activeScope.current === requestScope) setBusy(false);
    }
  };
  const unlink = async (alias: Alias) => {
    if (!canWrite || busy) return;
    if (
      !window.confirm(
        "Отвязать этот контакт? Сохранённая история останется в карточке.",
      )
    )
      return;
    setBusy(true);
    setError("");
    const requestScope = activeScope.current;
    try {
      const response = await fetch(`${url}/${alias.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      permissionResponse(response);
      const result = await response.json();
      if (activeScope.current !== requestScope || !canWriteRef.current) return;
      if (!response.ok || !result.success)
        throw new Error("Не удалось отвязать контакт.");
      setAliases((previous) => previous.filter((item) => item.id !== alias.id));
      onLinked();
    } catch (cause) {
      if (activeScope.current === requestScope) setError(
        cause instanceof Error && !(cause instanceof TypeError || cause instanceof SyntaxError) ? cause.message : "Не удалось отвязать контакт. Повторите действие.",
      );
    } finally {
      if (activeScope.current === requestScope) setBusy(false);
    }
  };
  const labels: Record<string, string> = {
    telegram: "Telegram",
    whatsapp: "WhatsApp",
    avito: "Авито",
    email: "Почта",
    vk: "ВКонтакте",
    max: "MAX",
    phone: "Телефон",
  };
  const selectedDialogue = dialogues.find(dialogue => dialogueContact(dialogue, kind) === value);
  return (
    <section
      className="customer-intelligence__card"
      aria-labelledby="customer-identities-title"
    >
      <h2 id="customer-identities-title">Связанные контакты</h2>
      <p className="customer-intelligence__caption">
        {canWrite ? 'Свяжите диалог или дополнительный номер с этим клиентом. История, задачи и сообщения останутся в одной карточке.' : 'Связанные контакты и история доступны для просмотра.'}
      </p>
      {access.role === 'manager' && !canWrite && <p className="customer-intelligence__caption"><a href="/sales?view=queue">Открыть рабочее пространство</a>, чтобы проверить назначение клиента.</p>}
      <ul className="customer-intelligence__aliases">
        {aliases.map((alias) => (
          <li key={`${alias.kind}:${alias.value}`}>
            <span>
              {labels[alias.kind] || "Контакт"}
              {['phone','whatsapp'].includes(alias.kind) ? <>: <span className="customer-intelligence__contact-value">{formatCustomerPhone(alias.kind === 'phone' ? alias.value : undefined, alias.kind === 'whatsapp' ? alias.value : undefined) || 'Связан'}</span></> : alias.kind === 'email' ? `: ${alias.value}` : ' · Связан'}
            </span>
            {canWrite && alias.id !== null && !alias.primary && (
              <button
                type="button"
                disabled={busy}
                onClick={() => unlink(alias)}
              >
                Отвязать
              </button>
            )}
          </li>
        ))}
      </ul>
      {canWrite && <form
        className="customer-intelligence__contact-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          Канал
          <select
            value={kind}
            disabled={busy || !!conflict}
            onChange={(event) => {
              setKind(event.target.value);
              setValue("");
              setNumberMode(false);
              setConflict(null);
            }}
          >
            <option value="telegram">Telegram</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="avito">Авито</option>
            <option value="email">Почта</option>
            <option value="vk">ВКонтакте</option>
            <option value="max">MAX</option>
            <option value="phone">Дополнительный телефон</option>
          </select>
        </label>
        {kind === "whatsapp" && (
          <label>
            <input
              type="checkbox"
              checked={numberMode}
              disabled={busy || !!conflict}
              onChange={(event) => {
                setNumberMode(event.target.checked);
                setValue("");
              }}
            />{" "}
            Добавить по номеру WhatsApp
          </label>
        )}
        {kind === "phone" || numberMode ? (
          <label>
            Телефон с кодом страны
            <input
              type="tel"
              value={value}
              disabled={busy || !!conflict}
              onChange={(event) => setValue(event.target.value)}
              required
              autoComplete="tel"
            />
            <span>Например, +79991234567</span>
          </label>
        ) : (
          <label>
            Диалог клиента
            <select
              value={value}
              disabled={busy || !!conflict}
              required
              onChange={(event) => setValue(event.target.value)}
            >
              <option value="">Выберите диалог клиента</option>
              {dialogues.flatMap((dialogue) => {
                const stable = dialogueContact(dialogue, kind);
                if (
                  !stable ||
                  (kind === "telegram" && !/^-?[1-9]\d*$/.test(stable))
                )
                  return [];
                return [
                  <option key={dialogue.chatId} value={stable}>
                    {customerDisplayName(dialogue.senderName, undefined, dialogue.chatId)} ·{" "}
                    {labels[kind]}
                    {dialogue.lastMessage
                      ? ` · ${dialogue.lastMessage.slice(0, 70)}`
                      : ""}
                  </option>,
                ];
              })}
            </select>
          </label>
        )}
        <p className="customer-intelligence__caption">
          Выберите диалог именно этого клиента. Связь применяется после
          подтверждения.
        </p>
        {previewing && !conflict && <div className="customer-intelligence__send-review" role="region" aria-label="Проверка контакта перед привязкой">
          <h3>Связать с карточкой «{customerName}»</h3>
          <p>{labels[kind]} · {selectedDialogue?.senderName?.trim() || (kind === 'phone' || numberMode ? value : 'Выбранный диалог')}</p>
          {selectedDialogue?.lastMessage && <p className="customer-intelligence__message">Последнее сообщение: {selectedDialogue.lastMessage}</p>}
          <p>Новые обращения с этого точного контакта будут связаны с клиентом. Совпадение имени не используется для объединения.</p>
          <label className="customer-intelligence__confirmation"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Я проверил контакт и подтверждаю, что он принадлежит этому клиенту</label>
          <button type="button" className="customer-intelligence__refresh" disabled={busy} onClick={() => { setPreviewing(false); setConfirmed(false); }}>Вернуться к выбору</button>
        </div>}
        {conflict && (
          <div className="customer-intelligence__limit">
            <p>
              Этот точный контакт уже принадлежит другой карточке в этом
              бизнесе.
            </p>
            <p>Проверяемая карточка: {dialogues.find(dialogue => dialogue.chatId === conflict)?.senderName || 'Другой клиент'}. История, задачи и сведения будут объединены с карточкой «{customerName}».</p>
            <a
              href={`/customers/${encodeURIComponent(conflict)}`}
              target="_blank"
              rel="noreferrer"
            >
              Открыть карточку для проверки
            </a>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />{" "}
              Я проверил карточку и подтверждаю объединение её истории, задач и
              сведений с этим клиентом.
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConflict(null);
                setConfirmed(false);
                setPreviewing(false);
              }}
            >
              Отмена
            </button>
          </div>
        )}
        <button
          className="customer-intelligence__refresh"
          disabled={busy || !value.trim() || ((!!conflict || previewing) && !confirmed)}
        >
          {busy
            ? "Сохраняем…"
            : conflict
              ? "Объединить и привязать"
              : previewing ? 'Подтвердить привязку' : "Привязать контакт"}
        </button>
      </form>}
      {error && (
        <p role="alert" className="customer-intelligence__notice--error">
          {error}
          <button type="button" className="customer-intelligence__refresh" disabled={busy} onClick={() => setRevision(value => value + 1)}>Повторить загрузку</button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
