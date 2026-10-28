import { formatBusinessDate } from '../businessTime';
import { useEffect, useState } from "react";
interface Call {
  id: string;
  timestamp: string | null;
  direction: "inbound" | "outbound";
  outcome: string;
  durationSeconds: number | null;
  summary?: string | null;
  transcript?: string | null;
  recordingUrl?: string | null;
}
interface Result {
  success: boolean;
  instanceId: number;
  calls: Call[];
  nextPage: number | null;
  sourceComplete: boolean;
}
const outcomes: Record<string, string> = {
  completed: "Завершён",
  answered: "Состоялся",
  success: "Состоялся",
  no_answer: "Нет ответа",
  missed: "Пропущен",
  busy: "Занято",
  failed: "Не состоялся",
  cancelled: "Отменён",
  canceled: "Отменён",
  rejected: "Отклонён",
  abandoned: "Звонок прерван",
};
export default function CustomerCalls({
  instanceId,
  chatId,
  refreshToken = 0,
  timeZone,
}: {
  instanceId: number;
  chatId: string;
  refreshToken?: number;
  timeZone?: string;
}) {
  const dateLabel = (value: string, includeTime: boolean) => formatBusinessDate(value, includeTime, timeZone);
  const [calls, setCalls] = useState<Call[]>([]),
    [nextPage, setNextPage] = useState<number | null>(null),
    [complete, setComplete] = useState(false),
    [loading, setLoading] = useState(true),
    [failedPage, setFailedPage] = useState(1),
    [error, setError] = useState("");
  const url = `/api/clients/${instanceId}/${encodeURIComponent(chatId)}/calls`;
  async function load(page: number, signal?: AbortSignal) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${url}?page=${page}`, {
        credentials: "same-origin",
        signal,
      });
      if (response.status === 401) window.dispatchEvent(new Event('crm:unauthorized'));
      if (response.status === 403) window.dispatchEvent(new Event('crm:forbidden'));
      if (!response.ok)
        throw new Error("Не удалось загрузить звонки. Попробуйте ещё раз.");
      const result = (await response.json()) as Result;
      if (
        !result.success ||
        result.instanceId !== instanceId ||
        !Array.isArray(result.calls)
      )
        throw new Error("Не удалось загрузить звонки. Попробуйте ещё раз.");
      if (signal?.aborted) return;
      setCalls((previous) => {
        const merged =
          page === 1 ? result.calls : [...previous, ...result.calls];
        return merged.filter(
          (call, index) =>
            merged.findIndex((other) => other.id === call.id) === index,
        );
      });
      setNextPage(result.nextPage);
      setComplete(result.sourceComplete === true);
    } catch (cause) {
      if (!signal?.aborted) {
        setFailedPage(page);
        setError(
          cause instanceof Error && !(cause instanceof TypeError || cause instanceof SyntaxError)
            ? cause.message
            : "Не удалось загрузить звонки.",
        );
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(1, controller.signal);
    return () => controller.abort();
  }, [url, refreshToken]);
  return (
    <section
      className="customer-intelligence__card customer-intelligence__timeline-card"
      aria-labelledby="customer-calls-title"
    >
      <h2 id="customer-calls-title">Звонки клиента</h2>
      {calls.length > 0 && (
        <ol
          className="customer-intelligence__timeline"
          tabIndex={0}
          aria-label="История звонков, прокручиваемый список"
        >
          {calls.map((call) => (
            <li className="customer-intelligence__event" key={call.id}>
              <div className="customer-intelligence__event-body">
                <div className="customer-intelligence__event-head">
                  <strong>
                    {call.direction === "outbound"
                      ? "Исходящий звонок"
                      : "Входящий звонок"}
                  </strong>
                  <time dateTime={call.timestamp || undefined}>
                    {call.timestamp && !Number.isNaN(Date.parse(call.timestamp))
                      ? dateLabel(call.timestamp, true)
                      : "Дата не указана"}
                  </time>
                </div>
                <p className="customer-intelligence__status-note">
                  {outcomes[call.outcome] || "Результат не указан"}
                  {typeof call.durationSeconds === "number" &&
                  call.durationSeconds >= 0
                    ? ` · ${Math.floor(call.durationSeconds / 60)} мин ${Math.floor(call.durationSeconds % 60)} сек`
                    : ""}
                </p>
                {call.summary && <p className="customer-intelligence__message">{call.summary}</p>}
                {(call.transcript || call.recordingUrl?.startsWith(`/api/calls/${instanceId}/`)) && <details className="customer-intelligence__details"><summary>Подробности звонка</summary>
                  {call.recordingUrl?.startsWith(`/api/calls/${instanceId}/`) && <audio controls preload="none" src={call.recordingUrl} aria-label="Запись звонка" />}
                  {call.transcript && <p className="customer-intelligence__message">{call.transcript}</p>}
                </details>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {loading && <p role="status">Загружаем звонки…</p>}
      {!loading && !error && !calls.length && complete && (
        <p className="customer-intelligence__caption">Звонков пока нет.</p>
      )}
      {!loading && nextPage !== null && (
        <button
          type="button"
          className="customer-intelligence__refresh"
          onClick={() => {
            void load(nextPage);
          }}
        >
          Показать более ранние звонки
        </button>
      )}
      {error && (
        <>
          <p role="alert" className="customer-intelligence__notice--error">
            {error}
          </p>
          <button
            type="button"
            className="customer-intelligence__refresh"
            disabled={loading}
            onClick={() => {
              void load(failedPage);
            }}
          >
            Повторить
          </button>
        </>
      )}
    </section>
  );
}
