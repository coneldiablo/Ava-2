import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
type CallResult = {
  success: boolean;
  businessId: number;
  callId: string;
  postProcessing: "pending" | "saved";
  client: { chatId: string; name: string; url: string } | null;
  summary: string | null;
  tasks: {
    taskId: string;
    summary: string;
    status: string;
    dueAt: string | null;
  }[];
  followups: {
    draftId: string;
    taskId: string;
    state: "draft" | "sent" | "unknown";
  }[];
};
type Transcript = {
  success: boolean;
  businessId: number;
  recordId: string;
  callId: string;
  turns: { role: "user" | "assistant"; text: string }[];
};
async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin", signal });
  if (r.status === 401) window.dispatchEvent(new Event("crm:unauthorized"));
  if (!r.ok) throw new Error();
  return r.json();
}
export default function CallResultPanel({
  businessId,
  callId,
  recordId,
}: {
  businessId: number;
  callId: string;
  recordId: string;
}) {
  const [open, setOpen] = useState(false),
    [result, setResult] = useState<CallResult | null>(null),
    [transcript, setTranscript] = useState<Transcript | null>(null),
    [failed, setFailed] = useState(false),
    [transcriptFailed, setTranscriptFailed] = useState(false),
    [loading, setLoading] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setLoading(true);
    setFailed(false);
    setTranscriptFailed(false);
    const root = `/api/businesses/${businessId}/telephony`;
    void Promise.allSettled([
      read<CallResult>(
        `${root}/calls/${encodeURIComponent(callId)}/result`,
        controller.signal,
      ),
      read<Transcript>(
        `${root}/records/${encodeURIComponent(recordId)}/transcript`,
        controller.signal,
      ),
    ])
      .then((values) => {
        if (disposed) return;
        const r = values[0],
          t = values[1];
        if (
          r.status === "fulfilled" &&
          r.value.success &&
          r.value.businessId === businessId &&
          r.value.callId === callId &&
          Array.isArray(r.value.tasks) &&
          Array.isArray(r.value.followups)
        )
          setResult(r.value);
        else setFailed(true);
        if (
          t.status === "fulfilled" &&
          t.value.success &&
          t.value.businessId === businessId &&
          String(t.value.recordId) === String(recordId) &&
          t.value.callId === callId &&
          Array.isArray(t.value.turns) &&
          t.value.turns.every(
            (turn) =>
              ["user", "assistant"].includes(turn.role) &&
              typeof turn.text === "string",
          )
        )
          setTranscript(t.value);
        else setTranscriptFailed(true);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [businessId, callId, recordId, open, revision]);
  return (
    <div className="min-w-0 space-y-3 sm:col-span-3">
      <button
        type="button"
        className="btn-secondary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Итог и расшифровка
      </button>
      {open && (
        <section
          className="space-y-4 rounded-2xl border border-[var(--neu-border)] p-4"
          aria-label="Результат звонка"
          aria-busy={loading}
        >
          {loading && <p role="status">Загружаем результат звонка…</p>}
          {failed && (
            <p role="alert">Не удалось получить итог. Обновите результат.</p>
          )}
          {result && (
            <>
              <p className="text-sm text-neu-muted">
                {result.postProcessing === "saved"
                  ? "Итог звонка сохранён"
                  : "AVA ещё сохраняет итог звонка"}
              </p>
              {result.summary && (
                <p className="whitespace-pre-wrap break-words">
                  {result.summary}
                </p>
              )}
              {result.client && (
                <Link
                  className="inline-flex min-h-11 items-center underline"
                  to={`/customers/${encodeURIComponent(result.client.chatId)}`}
                >
                  {result.client.name || "Открыть клиента"}
                </Link>
              )}
              {result.tasks.length > 0 && (
                <div>
                  <h4 className="font-semibold">Следующие действия</h4>
                  <ul className="mt-2 space-y-2">
                    {result.tasks.map((task) => (
                      <li key={task.taskId} className="break-words">
                        <p>{task.summary}</p>
                        <p className="text-sm text-neu-muted">
                          {task.status === "done"
                            ? "Выполнено"
                            : task.status === "cancelled"
                              ? "Отменено"
                              : "Ожидает выполнения"}
                          {task.dueAt &&
                            ` · ${new Date(task.dueAt).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })}`}
                        </p>
                      </li>
                    ))}
                  </ul>
                  {result.client && (
                    <Link
                      className="inline-flex min-h-11 items-center underline"
                      to={`/today?client=${encodeURIComponent(result.client.chatId)}`}
                    >
                      Открыть задачи клиента
                    </Link>
                  )}
                </div>
              )}
              {result.followups.map((draft) => (
                <div key={draft.draftId}>
                  <p className="text-sm">
                    {draft.state === "sent"
                      ? "Сообщение принято каналом · доставка пока не подтверждена"
                      : draft.state === "unknown"
                        ? "Отправка уточняется · повторять сообщение пока не нужно"
                        : "Сообщение после звонка готово к проверке"}
                  </p>
                  {result.client && draft.state === "draft" && (
                    <Link
                      className="inline-flex min-h-11 items-center underline"
                      to={`/customers/${encodeURIComponent(result.client.chatId)}?followup=${encodeURIComponent(draft.draftId)}#customer-followups-title`}
                    >
                      Проверить сообщение
                    </Link>
                  )}
                </div>
              ))}
            </>
          )}
          {transcriptFailed && (
            <p className="text-sm text-neu-muted">
              Расшифровку пока не удалось загрузить.
            </p>
          )}
          {transcript && (
            <div>
              <h4 className="font-semibold">Расшифровка</h4>
              {!transcript.turns.length ? (
                <p className="text-sm text-neu-muted">
                  Текст разговора ещё не сохранён.
                </p>
              ) : (
                <ol
                  className="mt-3 max-h-80 space-y-3 overflow-auto pr-2"
                  tabIndex={0}
                  aria-label="Текст разговора"
                >
                  {transcript.turns.map((turn, i) => (
                    <li key={i} className="break-words">
                      <strong className="text-sm">
                        {turn.role === "user" ? "Клиент" : "AVA"}
                      </strong>
                      <p className="whitespace-pre-wrap text-sm leading-6">
                        {turn.text}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
          <button
            type="button"
            className="btn-secondary"
            disabled={loading}
            onClick={() => setRevision((v) => v + 1)}
          >
            Обновить результат
          </button>
        </section>
      )}
    </div>
  );
}
