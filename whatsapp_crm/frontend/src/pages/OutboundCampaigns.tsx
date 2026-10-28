import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  PhoneOutgoing,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useInstance } from "../context/InstanceContext";
import { getPipeline } from "../businessProfiles";
import { useAuth } from "../context/AuthContext";
import { getTelephony, type Phone, type Telephony } from "../api/telephony";
import {
  commandCampaign,
  createCampaign,
  listCampaigns,
  previewCampaign,
  reconcileCampaign,
  syncCrmCampaign,
  updateCampaignRetrySettings,
  type Campaign,
  type CampaignCreate,
  type CampaignPreview,
  type CommandInput,
} from "../api/outbound";
import "./OutboundCampaigns.css";
interface OutboundAttempt {
  id: string | null;
  leadName: string | null;
  phoneNumber: string | null;
  startedAt: string | null;
  durationSeconds: number | null;
  callId: string | null;
  outcome: string | null;
  provider: string | null;
  amdStatus: string | null;
  consentResult: string | null;
  errorStage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
}
interface AttemptPage {
  attempts: OutboundAttempt[];
  page: number;
  total: number;
  totalPages: number;
}
const campaignLabel: Record<string, string> = {
  draft: "Черновик",
  running: "Звонки запущены",
  active: "Звонки запущены",
  paused: "На паузе",
  stopped: "Остановлена",
  completed: "Завершена",
};
const errors: Record<string, string> = {
  TELEPHONY_IMPORT_EXPIRED:
    "Срок проверки контактов истёк. Проверьте список заново.",
  TELEPHONY_IMPORT_EMPTY: "В списке нет подходящих номеров.",
  TELEPHONY_IMPORT_TOO_LARGE: "Можно загрузить до 5000 контактов.",
  TELEPHONY_CSV_INVALID:
    "Не удалось прочитать таблицу. Проверьте CSV и названия столбцов.",
  TELEPHONY_SOURCE_UNAVAILABLE:
    "Исходящий номер недоступен. Проверьте телефонию.",
  TELEPHONY_AUDIENCE_CONFIRMATION_REQUIRED:
    "Список контактов изменился. Обновите кампанию и проверьте количество.",
  TELEPHONY_CAMPAIGN_OUTCOME_UNKNOWN:
    "Результат уточняется. Повторный запуск пока недоступен.",
  TELEPHONY_CAMPAIGN_STATE_CONFLICT:
    "Состояние кампании изменилось. Обновите список.",
  TELEPHONY_IDEMPOTENCY_CONFLICT:
    "Настройки изменились после предыдущей попытки. Сверьте сохранённую кампанию перед новым действием.",
  TELEPHONY_CALL_WINDOW_INVALID:
    "Укажите допустимое время начала и окончания звонков.",
  TELEPHONY_ATTEMPTS_INVALID: "Выберите от 1 до 5 попыток на контакт.",
  TELEPHONY_RETRY_INTERVAL_INVALID: "Укажите интервал от 1 до 1440 минут.",
  TELEPHONY_TIMEZONE_INVALID: "Проверьте часовой пояс.",
};
function failure(error: unknown) {
  const code = (error as { response?: { data?: { code?: string } } })?.response
    ?.data?.code;
  return code && errors[code]
    ? errors[code]
    : "Не удалось подтвердить действие. Ваши настройки сохранены на экране. Обновите состояние перед повтором.";
}
function scopedCampaign(c: Campaign, id: number) {
  return (
    c?.businessId === id &&
    typeof c.campaignId === "string" &&
    typeof c.name === "string" &&
    c.counts &&
    Number.isSafeInteger(c.audienceSize)
  );
}
export default function OutboundCampaigns() {
  const { currentInstanceId } = useInstance();
  const auth = useAuth();
  const membership = auth.memberships.find(
    (m) => m.businessId === currentInstanceId,
  );
  return (
    <CampaignWorkspace
      key={`${currentInstanceId}:${auth.userId || ""}:${membership?.role}:${[...(membership?.capabilities||[])].sort().join(",")}`}
    />
  );
}
function CampaignWorkspace() {
  const { currentInstanceId, currentInstance } = useInstance();
  const { memberships, userId, permissionsLoading } = useAuth();
  const owner = !permissionsLoading && memberships.some(
    (m) => m.businessId === currentInstanceId && m.role === "hotel_owner" && m.capabilities?.includes("business.manage"),
  );
  const [campaigns, setCampaigns] = useState<Campaign[]>([]),
    [loaded, setLoaded] = useState(false),
    [loading, setLoading] = useState(false),
    [phone, setPhone] = useState<Telephony | null>(null),
    [phoneError, setPhoneError] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(
      null,
    ),
    [busy, setBusy] = useState(""),
    [showCreate, setShowCreate] = useState(false),
    [expanded, setExpanded] = useState<string | null>(null),
    [locked, setLocked] = useState<Set<string>>(new Set());
  const [sourceMode, setSourceMode] = useState<"csv" | "crm">("csv");
  const [statuses, setStatuses] = useState(["new", "qualified"]),
    [tags, setTags] = useState(""),
    [excludeTags, setExcludeTags] = useState("do_not_call, no_call, отказ"),
    [silentDays, setSilentDays] = useState(0);
  const pipeline = getPipeline(currentInstance);
  const splitTags = (value: string) =>
    value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  const [csv, setCsv] = useState(""),
    [phoneColumn, setPhoneColumn] = useState("phone"),
    [nameColumn, setNameColumn] = useState("name"),
    [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [name, setName] = useState(""),
    [source, setSource] = useState(""),
    [timezone, setTimezone] = useState("Europe/Moscow"),
    [start, setStart] = useState("09:00"),
    [end, setEnd] = useState("18:00"),
    [acceptPartial, setAcceptPartial] = useState(false);
  const [maxAttempts, setMaxAttempts] = useState(1);
  const [retryIntervalMinutes, setRetryIntervalMinutes] = useState(1);
  const [sources, setSources] = useState<Record<string, string>>({});
  const active = useRef(new AbortController()),
    loadId = useRef(0),
    actionLock = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    return () => controller.abort();
  }, []);
  const storageKey = `ava:campaign-pending:${currentInstanceId}:${userId || ""}`;
  const pending = useRef<{ body: CampaignCreate; key: string } | null>(null);
  useEffect(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) || "null");
      if (value?.key && value?.body?.importId) {
        pending.current = value;
        setName(value.body.name);
        setSource(value.body.sourceNumberId || "");
        setTimezone(value.body.timezone);
        setStart(value.body.callWindow.start);
        setEnd(value.body.callWindow.end);
        setMaxAttempts(value.body.maxAttempts || 1);
        setRetryIntervalMinutes(value.body.retryIntervalMinutes ?? 1);
        setShowCreate(true);
        setNotice({
          error: false,
          text: "Предыдущее создание не подтверждено. Можно проверить результат с теми же настройками.",
        });
      }
    } catch {
      /* Keep an in-memory recovery when storage is unavailable. */
    }
  }, [storageKey]);
  const refresh = useCallback(
    async (clear = true) => {
      if (!currentInstanceId) return;
      const revision = ++loadId.current;
      setLoading(true);
      if (clear) setNotice(null);
      const result = await Promise.allSettled([
        listCampaigns(currentInstanceId, active.current.signal),
        getTelephony(currentInstanceId, active.current.signal),
      ]);
      if (active.current.signal.aborted || revision !== loadId.current) return;
      if (
        result[0].status === "fulfilled" &&
        result[0].value.success &&
        Array.isArray(result[0].value.campaigns) &&
        result[0].value.campaigns.every((c) =>
          scopedCampaign(c, currentInstanceId),
        )
      ) {
        setCampaigns(result[0].value.campaigns);
        setLoaded(true);
        setLocked(
          (previous) =>
            new Set(
              [...previous].filter((id) => {
                const c =
                  result[0].status === "fulfilled"
                    ? result[0].value.campaigns.find((c) => c.campaignId === id)
                    : null;
                return c?.command?.state !== "succeeded";
              }),
            ),
        );
      } else
        setNotice({
          error: true,
          text: "Не удалось загрузить кампании. Нажмите «Обновить», чтобы повторить.",
        });
      if (result[1].status === "fulfilled") {
        setPhone(result[1].value);
        setPhoneError(false);
        const ready = result[1].value.numbers.filter(
          (p) => p.state === "active" && p.outboundReady,
        );
        setSource(
          (old) =>
            old || ready.find((p) => p.isPrimary)?.id || ready[0]?.id || "",
        );
      } else setPhoneError(true);
      setLoading(false);
    },
    [currentInstanceId],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const readyPhones: Phone[] =
    phone?.numbers.filter((p) => p.state === "active" && p.outboundReady) || [];
  const sourceValid = (value: string) =>
    !!phone &&
    !phoneError &&
    (phone.managedMode
      ? readyPhones.some((p) => p.id === value)
      : !phone.connections ||
        phone.connections.some((c) => c.outbound.configured));
  async function doPreview() {
    if (!currentInstanceId || actionLock.current) return;
    actionLock.current = true;
    setBusy("preview");
    setNotice(null);
    try {
      const data = await previewCampaign(
        currentInstanceId,
        sourceMode === "csv"
          ? { csv, phoneColumn, nameColumn: nameColumn || undefined }
          : {
              sourceFilter: {
                statuses,
                tags: splitTags(tags),
                exclude_tags: splitTags(excludeTags),
                silentDays,
              },
            },
        active.current.signal,
      );
      if (active.current.signal.aborted) return;
      if (!data.success || !data.importId) throw new Error();
      setPreview(data);
      setAcceptPartial(false);
      pending.current = null;
      sessionStorage.removeItem(storageKey);
    } catch (error) {
      if (!active.current.signal.aborted)
        setNotice({ error: true, text: failure(error) });
    } finally {
      actionLock.current = false;
      if (!active.current.signal.aborted) setBusy("");
    }
  }
  async function saveDraft() {
    if (
      !currentInstanceId ||
      actionLock.current ||
      !name.trim() ||
      !sourceValid(source) ||
      !Number.isInteger(retryIntervalMinutes) || retryIntervalMinutes < 1 || retryIntervalMinutes > 1440
    )
      return;
    const previous = pending.current;
    const body: CampaignCreate = preview
      ? {
          name: name.trim(),
          importId: preview.importId,
          sourceNumberId: source || null,
          timezone,
          callWindow: { start, end },
          maxAttempts,
          retryIntervalMinutes,
        }
      : (previous?.body as CampaignCreate);
    if (
      !body ||
      (preview &&
        (preview.expiresAt < Date.now() ||
          !preview.counts.accepted ||
          (preview.counts.invalid + preview.counts.duplicates > 0 &&
            !acceptPartial)))
    )
      return;
    const item =
      previous && JSON.stringify(previous.body) === JSON.stringify(body)
        ? previous
        : { body, key: crypto.randomUUID() };
    pending.current = item;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(item));
    } catch {
      /* Original key stays in memory. */
    }
    actionLock.current = true;
    setBusy("create");
    setNotice(null);
    try {
      const data = await createCampaign(
        currentInstanceId,
        body,
        item.key,
        active.current.signal,
      );
      if (active.current.signal.aborted) return;
      if (!data.success || !scopedCampaign(data.campaign, currentInstanceId))
        throw new Error();
      pending.current = null;
      sessionStorage.removeItem(storageKey);
      setPreview(null);
      setCsv("");
      setName("");
      setShowCreate(false);
      setNotice({
        error: false,
        text: "Черновик создан. Проверьте список и отдельно подтвердите запуск звонков.",
      });
      await refresh(false);
    } catch (error) {
      if (!active.current.signal.aborted)
        setNotice({ error: true, text: failure(error) });
    } finally {
      actionLock.current = false;
      if (!active.current.signal.aborted) setBusy("");
    }
  }
  async function syncExisting(c:Campaign) {
    if(!owner||c.audienceSource!=='crm'||c.status!=='draft'||c.command||actionLock.current||!currentInstanceId)return;
    actionLock.current=true;setBusy(c.campaignId);setNotice(null);
    try {const result=await syncCrmCampaign(c.campaignId,active.current.signal);if(active.current.signal.aborted)return;if(!result.success)throw new Error();await refresh(false);setNotice({error:false,text:`Список клиентов обновлён: ${result.accepted}. Запреты на звонки сохранены. Обзвон ещё не начался.`});}
    catch(error){if(!active.current.signal.aborted)setNotice({error:true,text:failure(error)});}
    finally{actionLock.current=false;if(!active.current.signal.aborted)setBusy('');}
  }
  async function command(c: Campaign, action: CommandInput["action"]) {
    if (
      !currentInstanceId ||
      !owner ||
      actionLock.current ||
      locked.has(c.campaignId) ||
      (c.command && c.command.state !== "succeeded")
    )
      return;
    const sourceId = sources[c.campaignId] ?? c.sourceNumberId ?? source;
    if (["start", "prepare"].includes(action) && !sourceValid(sourceId)) return;
    if (
      ["start", "resume"].includes(action) &&
      !window.confirm(
        `${action === "resume" ? "Возобновить" : "Запустить"} реальные звонки по кампании «${c.name}»? В списке ${c.audienceSize} контактов, кроме запретивших звонки. Окно: ${c.callWindow.start || "09:00"}–${c.callWindow.end || "18:00"}, ${c.timezone}.`,
      )
    )
      return;
    if (
      action === "stop" &&
      !window.confirm(
        "Остановить дальнейший обзвон? Уже начатый разговор продолжится.",
      )
    )
      return;
    const body: CommandInput = {
      action,
      ...(["start", "resume"].includes(action)
        ? { confirmAudience: c.audienceSize }
        : {}),
      ...(["start", "prepare"].includes(action)
        ? { sourceNumberId: sourceId || null }
        : {}),
    };
    const key = crypto.randomUUID();
    actionLock.current = true;
    setBusy(c.campaignId);
    setNotice(null);
    setLocked((old) => new Set(old).add(c.campaignId));
    try {
      const data = await commandCampaign(
        currentInstanceId,
        c.campaignId,
        body,
        key,
        active.current.signal,
      );
      if (active.current.signal.aborted) return;
      if (
        !data.success ||
        !scopedCampaign(data.campaign, currentInstanceId) ||
        data.campaign.command?.state !== "succeeded"
      )
        throw new Error();
      setLocked((old) => new Set([...old].filter((id) => id !== c.campaignId)));
      setNotice({
        error: false,
        text:
          action === "prepare"
            ? "Кампания подготовлена. Звонки ещё не начались."
            : action === "pause"
              ? "Кампания на паузе."
              : action === "stop"
                ? "Новые звонки остановлены."
                : "Запуск подтверждён. Звонки выполняются в указанное время.",
      });
      await refresh(false);
    } catch (error) {
      if (!active.current.signal.aborted) {
        const code =
          (error as { response?: { data?: { code?: string } } })?.response?.data
            ?.code || "";
        const rejectedBeforeDispatch =
          [
            "TELEPHONY_SOURCE_UNAVAILABLE",
            "TELEPHONY_AUDIENCE_CONFIRMATION_REQUIRED",
            "TELEPHONY_CAMPAIGN_STATE_CONFLICT",
            "TELEPHONY_INPUT_INVALID",
            "TELEPHONY_TIMEZONE_INVALID",
            "TELEPHONY_CALL_WINDOW_INVALID",
          ].includes(code) || /^(CUSTOMER_|BUSINESS_)/.test(code);
        if (rejectedBeforeDispatch)
          setLocked(
            (old) => new Set([...old].filter((id) => id !== c.campaignId)),
          );
        setNotice({
          error: true,
          text:
            failure(error) +
            (rejectedBeforeDispatch
              ? ""
              : " Проверьте результат кнопкой «Уточнить состояние»."),
        });
        await refresh(false);
      }
    } finally {
      actionLock.current = false;
      if (!active.current.signal.aborted) setBusy("");
    }
  }
  async function reconcile(c: Campaign) {
    if (!currentInstanceId || actionLock.current) return;
    actionLock.current = true;
    setBusy(c.campaignId);
    try {
      const data = await reconcileCampaign(
        currentInstanceId,
        c.campaignId,
        active.current.signal,
      );
      if (active.current.signal.aborted) return;
      if (!data.success || !scopedCampaign(data.campaign, currentInstanceId))
        throw new Error();
      setCampaigns((old) =>
        old.map((row) =>
          row.campaignId === c.campaignId ? data.campaign : row,
        ),
      );
      if (data.campaign.command?.state === "succeeded")
        setLocked(
          (old) => new Set([...old].filter((id) => id !== c.campaignId)),
        );
      setNotice({
        error: false,
        text:
          data.runtimeStateConfirmed
            ? "Состояние подтверждено."
            : "Результат ещё уточняется. Новые звонки этим действием не запускаются.",
      });
    } catch (error) {
      if (!active.current.signal.aborted)
        setNotice({ error: true, text: failure(error) });
    } finally {
      actionLock.current = false;
      if (!active.current.signal.aborted) setBusy("");
    }
  }
  if (!currentInstanceId)
    return (
      <div className="card p-8">Выберите бизнес, чтобы открыть кампании.</div>
    );
  return (
    <div className="outbound-page max-w-6xl mx-auto pb-10 space-y-5">
      <header className="outbound-hero">
        <div className="outbound-hero-copy">
          <p className="outbound-eyebrow">
            <PhoneOutgoing size={16} aria-hidden="true" />{" "}
            {currentInstance?.name || "Ваш бизнес"}
          </p>
          <h1>Кампании обзвона</h1>
          <p>
            Добавьте контакты, проверьте список и подтвердите запуск. Для
            разговора AVA использует инструкции и голос вашего бизнеса.
          </p>
        </div>
        <div className="outbound-hero-actions">
          <button
            className="btn-secondary"
            type="button"
            onClick={() => void refresh()}
            disabled={loading || !!busy}
          >
            <RefreshCw size={16} aria-hidden="true" />
            Обновить
          </button>
          {owner && (
            <button
              className="btn-primary"
              type="button"
              disabled={!!busy}
              aria-expanded={showCreate}
              onClick={() => setShowCreate((v) => !v)}
            >
              <Plus size={16} aria-hidden="true" />
              Новая кампания
            </button>
          )}
        </div>
      </header>
      {notice && (
        <p
          role={notice.error ? "alert" : "status"}
          className={`outbound-notice ${notice.error ? "outbound-notice-error" : "outbound-notice-ok"}`}
        >
          {notice.error ? (
            <AlertCircle size={17} />
          ) : (
            <CheckCircle2 size={17} />
          )}{" "}
          {notice.text}
        </p>
      )}
      {phoneError && (
        <p role="alert">
          Не удалось проверить исходящие номера. Нажмите «Обновить» перед
          запуском.
        </p>
      )}
      {phone && !phoneError && (phone.managedMode ? !readyPhones.length : phone.connections && !phone.connections.some(c => c.outbound.configured)) && (
        <p>
          Нет активного исходящего номера.{" "}
          <Link to="/channels?channel=telephony" className="underline">
            Открыть телефонию
          </Link>
        </p>
      )}
      {!owner && (
        <p className="outbound-readonly">
          Кампании доступны для просмотра. Создаёт и запускает обзвон владелец
          бизнеса.
        </p>
      )}
      {showCreate && owner && (
        <section
          className="card p-5 sm:p-7 space-y-5"
          aria-labelledby="campaign-create"
        >
          <h2 id="campaign-create" className="text-xl font-semibold">
            Новая кампания
          </h2>
          <ol className="flex flex-wrap gap-3 text-sm text-neu-muted">
            <li>1. Контакты</li>
            <li>2. Проверка</li>
            <li>3. Черновик</li>
          </ol>
          <fieldset className="space-y-4" disabled={!!busy}>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Откуда взять контакты"
            >
              <button
                type="button"
                className={
                  sourceMode === "csv" ? "btn-primary" : "btn-secondary"
                }
                aria-pressed={sourceMode === "csv"}
                onClick={() => {
                  setSourceMode("csv");
                  setPreview(null);
                }}
              >
                Таблица CSV
              </button>
              <button
                type="button"
                className={
                  sourceMode === "crm" ? "btn-primary" : "btn-secondary"
                }
                aria-pressed={sourceMode === "crm"}
                onClick={() => {
                  setSourceMode("crm");
                  setPreview(null);
                }}
              >
                Клиенты AVA
              </button>
            </div>
            {sourceMode === "csv" ? (
              <>
                <label className="block">
                  Таблица контактов CSV
                  <input
                    className="input mt-2"
                    type="file"
                    accept=".csv,text/csv"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      if (file.size > 2 * 1024 * 1024) {
                        setNotice({
                          error: true,
                          text: "Размер CSV — до 2 МБ.",
                        });
                        return;
                      }
                      setCsv(await file.text());
                      setPreview(null);
                    }}
                  />
                </label>
                <label className="block">
                  Или вставьте CSV
                  <textarea
                    className="input mt-2"
                    rows={4}
                    value={csv}
                    onChange={(event) => {
                      setCsv(event.target.value);
                      setPreview(null);
                    }}
                    placeholder={"phone;name\n+79990000000;Анна"}
                  />
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label>
                    Столбец с номером
                    <input
                      className="input mt-2"
                      value={phoneColumn}
                      onChange={(e) => {
                        setPhoneColumn(e.target.value);
                        setPreview(null);
                      }}
                    />
                  </label>
                  <label>
                    Столбец с именем
                    <input
                      className="input mt-2"
                      value={nameColumn}
                      onChange={(e) => {
                        setNameColumn(e.target.value);
                        setPreview(null);
                      }}
                    />
                  </label>
                </div>
              </>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-neu-muted">
                  Выберите существующих клиентов бизнеса. В список попадут
                  только подтверждённые телефонные контакты; переписка и
                  ответственный сохраняются.
                </p>
                <fieldset>
                  <legend className="mb-2 font-semibold">
                    Стадии клиентов
                  </legend>
                  <div className="flex flex-wrap gap-3">
                    {pipeline
                      .filter((stage) => stage.id !== "junk")
                      .map((stage) => (
                        <label
                          className="flex min-h-11 items-center gap-2"
                          key={stage.id}
                        >
                          <input
                            type="checkbox"
                            checked={statuses.includes(stage.id)}
                            onChange={(e) => {
                              setStatuses((old) =>
                                e.target.checked
                                  ? [...old, stage.id]
                                  : old.filter((v) => v !== stage.id),
                              );
                              setPreview(null);
                            }}
                          />
                          {stage.label}
                        </label>
                      ))}
                  </div>
                  <p className="text-xs text-neu-muted">
                    Если ничего не выбрано, учитываются все стадии.
                  </p>
                </fieldset>
                <label className="block">
                  Без общения не менее дней
                  <input
                    className="input mt-2"
                    type="number"
                    min={0}
                    max={3650}
                    value={silentDays}
                    onChange={(e) => {
                      setSilentDays(Number(e.target.value));
                      setPreview(null);
                    }}
                  />
                </label>
                <details>
                  <summary className="min-h-11 cursor-pointer font-semibold">
                    Фильтры по тегам
                  </summary>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label>
                      Включить теги
                      <input
                        className="input mt-2"
                        value={tags}
                        onChange={(e) => {
                          setTags(e.target.value);
                          setPreview(null);
                        }}
                        placeholder="Теги через запятую"
                      />
                    </label>
                    <label>
                      Исключить теги
                      <input
                        className="input mt-2"
                        value={excludeTags}
                        onChange={(e) => {
                          setExcludeTags(e.target.value);
                          setPreview(null);
                        }}
                      />
                    </label>
                  </div>
                </details>
              </div>
            )}
            <button
              type="button"
              className="btn-secondary"
              disabled={
                sourceMode === "csv"
                  ? !csv.trim() || !phoneColumn.trim()
                  : !Number.isInteger(silentDays) ||
                    silentDays < 0 ||
                    silentDays > 3650
              }
              onClick={() => void doPreview()}
            >
              {busy === "preview" ? "Проверяем…" : "Проверить контакты"}
            </button>
          </fieldset>
          {preview && (
            <div className="space-y-3">
              <p role="status">
                Готово к добавлению: {preview.counts.accepted} · Ошибок:{" "}
                {preview.counts.invalid} · Повторов: {preview.counts.duplicates}
              </p>
              {!preview.counts.accepted && (
                <p>
                  По выбранным условиям нет контактов для звонка. Измените
                  фильтры или добавьте номера клиентов.
                </p>
              )}
              <div className="max-h-48 overflow-auto rounded-xl border border-[var(--neu-border)] p-3">
                <ul className="space-y-1">
                  {preview.rows.map((row) => (
                    <li key={row.phone} className="break-words">
                      {row.name || "Без имени"} · +{row.phone}
                    </li>
                  ))}
                </ul>
              </div>
              {preview.errors.length > 0 && (
                <p className="text-sm text-red-700">
                  Проверьте номера в строках:{" "}
                  {preview.errors.map((e) => e.row).join(", ")}.
                </p>
              )}
              {preview.counts.invalid + preview.counts.duplicates > 0 && (
                <label className="flex items-start gap-3">
                  <input
                    className="mt-1"
                    type="checkbox"
                    checked={acceptPartial}
                    onChange={(e) => setAcceptPartial(e.target.checked)}
                  />
                  Добавить только подходящие контакты, исключив ошибки и повторы
                </label>
              )}
            </div>
          )}
          <fieldset
            className="grid gap-4 sm:grid-cols-2"
            disabled={!!busy || (!!pending.current && !preview)}
          >
            <label>
              Название кампании
              <input
                className="input mt-2"
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Часовой пояс
              <input
                className="input mt-2"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </label>
            <label>
              Звонить с
              <input
                type="time"
                className="input mt-2"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              Звонить до
              <input
                type="time"
                className="input mt-2"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
            <label>
              Попыток на контакт
              <select className="input mt-2" value={maxAttempts} onChange={(e) => setMaxAttempts(Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label>
              Интервал между попытками, мин
              <input className="input mt-2" type="number" min={1} max={1440} step={1} aria-label="Интервал между попытками, мин"
                value={retryIntervalMinutes} onChange={(e) => setRetryIntervalMinutes(Number(e.target.value))}
                aria-invalid={!Number.isInteger(retryIntervalMinutes) || retryIntervalMinutes < 1 || retryIntervalMinutes > 1440}
                aria-describedby="campaign-retry-hint" />
              <span id="campaign-retry-hint" className="block mt-1 text-sm text-neu-muted">
                {Number.isInteger(retryIntervalMinutes) && retryIntervalMinutes >= 1 && retryIntervalMinutes <= 1440
                  ? "От 1 минуты до суток. Повторяем, только если клиент не ответил или линия занята."
                  : "Укажите целое число от 1 до 1440 минут."}
              </span>
            </label>
            {phone?.managedMode && (
              <label>
                Исходящий номер
                <select
                  aria-label="Исходящий номер"
                  className="input mt-2"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  <option value="">Выберите номер</option>
                  {readyPhones.map((p) => (
                    <option key={p.id} value={p.id}>
                      +{p.number}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </fieldset>
          <p className="text-sm text-neu-muted">
            Запреты на звонки сохраняются. Сохранение
            черновика не запускает обзвон.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              className="btn-secondary"
              disabled={!!busy}
              onClick={() => setShowCreate(false)}
            >
              Закрыть
            </button>
            <button
              className="btn-primary"
              disabled={
                !!busy ||
                !name.trim() ||
                !Number.isInteger(retryIntervalMinutes) || retryIntervalMinutes < 1 || retryIntervalMinutes > 1440 ||
                !sourceValid(source) ||
                (!preview && !pending.current) ||
                (!!preview &&
                  (!preview.counts.accepted ||
                    (preview.counts.invalid + preview.counts.duplicates > 0 &&
                      !acceptPartial)))
              }
              onClick={() => void saveDraft()}
            >
              {busy === "create"
                ? "Сохраняем…"
                : pending.current && !preview
                  ? "Проверить создание черновика"
                  : "Сохранить черновик"}
            </button>
          </div>
        </section>
      )}
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Ваши кампании</h2>
        <span className="text-sm text-neu-muted">
          {loading
            ? "Загрузка…"
            : loaded
              ? `${campaigns.length} камп.`
              : "Данные пока недоступны"}
        </span>
      </div>
      {campaigns.map((c) => {
        const unresolved =
          locked.has(c.campaignId) ||
          (!!c.command && c.command.state !== "succeeded");
        const selected = sources[c.campaignId] ?? c.sourceNumberId ?? source;
        return (
          <article key={c.campaignId} className="card p-5 sm:p-7 space-y-4">
            <div className="flex flex-wrap justify-between gap-3">
              <h3 className="text-lg font-semibold">{c.name}</h3>
              <span className="outbound-chip">
                {unresolved
                  ? "Результат уточняется"
                  : campaignLabel[c.status] || "Состояние уточняется"}
              </span>
            </div>
            <p className="text-sm text-neu-muted">
              {c.callWindow.start || "09:00"}–{c.callWindow.end || "18:00"} ·{" "}
              {c.timezone} · Контактов:{" "}
              {Object.values(c.counts).reduce((n, v) => n + v, 0)} · Без
              звонков: {c.counts.blocked || 0}
            </p>
            <p className="text-sm text-neu-muted">
              Попыток на контакт: {c.maxAttempts} · Интервал: {c.retryIntervalMinutes ?? 1} мин
              {(c.retryBackoffMultiplier ?? 2) > 1 && c.maxAttempts > 2 ? " · При следующих повторах ожидание увеличивается" : ""}
            </p>
            {owner && c.status === "draft" && !unresolved && (
              <CampaignRetrySettings key={`${c.campaignId}:${c.maxAttempts}:${c.retryIntervalMinutes}`} campaign={c}
                disabled={!!busy} onSave={async (input) => {
                  if (!currentInstanceId || actionLock.current) return false;
                  actionLock.current = true; setBusy(c.campaignId); setNotice(null);
                  try {
                    const result = await updateCampaignRetrySettings(currentInstanceId,c.campaignId,input,active.current.signal);
                    if(active.current.signal.aborted) return false;
                    if(!result.success || !scopedCampaign(result.campaign,currentInstanceId)) throw new Error();
                    setCampaigns(old => old.map(row => row.campaignId === c.campaignId ? result.campaign : row));
                    setNotice({error:false,text:"Настройки повторных звонков сохранены."}); return true;
                  } catch(error) {
                    if(!active.current.signal.aborted) setNotice({error:true,text:failure(error)});
                    return false;
                  } finally { actionLock.current = false; if(!active.current.signal.aborted) setBusy(""); }
                }} />
            )}
            {owner && (
              <div className="space-y-3">
                {c.audienceSource==='crm'&&c.status==='draft'&&!c.command&&!unresolved&&<button type="button" className="btn-secondary" disabled={!!busy} onClick={()=>void syncExisting(c)}>Обновить список клиентов</button>}
                {c.status === 'draft' && !c.audienceSize && !unresolved && (
                  <p id={`campaign-audience-${c.campaignId}`} className="text-sm text-neu-muted">
                    Нет контактов для звонка. {c.audienceSource === 'crm'
                      ? 'Обновите список клиентов.'
                      : 'Создайте кампанию со списком контактов.'}
                  </p>
                )}
                {phone?.managedMode && ["draft"].includes(c.status) && (
                  <label className="block">
                    Номер для кампании «{c.name}»
                    <select
                      aria-label={`Номер для кампании «${c.name}»`}
                      className="input mt-2"
                      disabled={!!busy || unresolved}
                      value={selected}
                      onChange={(e) =>
                        setSources((v) => ({
                          ...v,
                          [c.campaignId]: e.target.value,
                        }))
                      }
                    >
                      <option value="">Выберите номер</option>
                      {readyPhones.map((p) => (
                        <option key={p.id} value={p.id}>
                          +{p.number}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {unresolved ? (
                  <div>
                    <p className="text-sm">
                      Результат уточняется. Повторный запуск пока недоступен.
                    </p>
                    <button
                      type="button"
                      className="btn-secondary mt-3"
                      disabled={!!busy}
                      onClick={() => void reconcile(c)}
                    >
                      Уточнить состояние
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={!!busy}
                      onClick={() => void reconcile(c)}
                    >
                      Проверить состояние
                    </button>
                    {c.status === "draft" && (
                      <>
                        <button
                          className="btn-secondary"
                          disabled={!!busy || !sourceValid(selected)}
                          onClick={() => void command(c, "prepare")}
                        >
                          Подготовить в AVA
                        </button>
                        <button
                          className="btn-primary"
                          aria-describedby={!c.audienceSize ? `campaign-audience-${c.campaignId}` : undefined}
                          disabled={
                            !!busy || !sourceValid(selected) || !c.audienceSize
                          }
                          onClick={() => void command(c, "start")}
                        >
                          Запустить звонки
                        </button>
                      </>
                    )}
                    {["running", "active"].includes(c.status) && (
                      <button
                        className="btn-secondary"
                        disabled={!!busy}
                        onClick={() => void command(c, "pause")}
                      >
                        Пауза
                      </button>
                    )}
                    {c.status === "paused" && (
                      <button
                        className="btn-primary"
                        disabled={!!busy || !c.audienceSize}
                        onClick={() => void command(c, "resume")}
                      >
                        Возобновить звонки
                      </button>
                    )}
                    {["paused", "running", "active"].includes(c.status) && (
                      <button
                        className="btn-secondary"
                        disabled={!!busy}
                        onClick={() => void command(c, "stop")}
                      >
                        Остановить кампанию
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            <button
              className="btn-secondary"
              aria-expanded={expanded === c.campaignId}
              onClick={() =>
                setExpanded((v) => (v === c.campaignId ? null : c.campaignId))
              }
            >
              История попыток
            </button>
            {expanded === c.campaignId && (
              <AttemptHistory
                businessId={currentInstanceId}
                campaignId={c.campaignId}
              />
            )}
          </article>
        );
      })}
      {!loading && loaded && !campaigns.length && (
        <div className="outbound-empty">
          <h3 className="font-semibold">Кампаний пока нет</h3>
          <p className="mt-2 text-sm text-neu-muted">
            {owner
              ? "Добавьте контакты и сохраните первый черновик."
              : "После создания кампании она появится здесь."}
          </p>
        </div>
      )}
    </div>
  );
}
function AttemptHistory({
  businessId,
  campaignId,
}: {
  businessId: number;
  campaignId: string;
}) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AttemptPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    axios
      .get(
        `/api/businesses/${businessId}/outbound/campaigns/${encodeURIComponent(campaignId)}/attempts`,
        {
          params: { page },
          withCredentials: true,
          signal: controller.signal,
          timeout: 15000,
        },
      )
      .then(({ data }) => setResult(data as AttemptPage))
      .catch((requestError) => {
        if (axios.isCancel(requestError)) return;
        setResult(null);
        setError(
          requestError.response?.status === 404
            ? "Кампания ещё не подготовлена в AVA или история недоступна."
            : "Не удалось загрузить историю попыток. Попробуйте обновить.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [businessId, campaignId, page, revision]);

  return (
    <section
      id={`outbound-history-${campaignId}`}
      className="outbound-history"
      aria-label="История попыток звонков"
      aria-busy={loading}
    >
      <div className="outbound-history-heading">
        <div>
          <h4>Попытки звонков</h4>
          <p>Фактические результаты AVA. Просмотр не запускает звонки.</p>
        </div>
        <button
          type="button"
          className="btn-secondary text-sm"
          onClick={() => setRevision((value) => value + 1)}
          disabled={loading}
          aria-label="Обновить историю попыток"
        >
          <RefreshCw
            size={15}
            className={loading ? "animate-spin" : ""}
            aria-hidden="true"
          />{" "}
          Обновить
        </button>
      </div>
      {loading && (
        <div className="outbound-history-state" role="status">
          <Loader2 size={17} className="animate-spin" aria-hidden="true" />{" "}
          Загружаем попытки…
        </div>
      )}
      {error && (
        <div
          className="outbound-history-state outbound-history-error"
          role="alert"
        >
          <AlertCircle size={17} aria-hidden="true" /> {error}
        </div>
      )}
      {!loading && !error && result?.attempts.length === 0 && (
        <p className="outbound-history-state">
          Попыток пока нет. После реального обзвона здесь появятся результаты.
        </p>
      )}
      {!loading && !error && result && result.attempts.length > 0 && (
        <>
          <ol className="outbound-attempt-list">
            {result.attempts.map((attempt, index) => (
              <li
                key={attempt.id || `${page}-${index}`}
                className="outbound-attempt"
              >
                <div className="outbound-attempt-main">
                  <strong>
                    {attempt.leadName || attempt.phoneNumber || "Лид без имени"}
                  </strong>
                  <span>{attempt.phoneNumber || "Номер не указан"}</span>
                  <span>
                    {attempt.startedAt
                      ? new Date(attempt.startedAt).toLocaleString("ru-RU")
                      : "Время не указано"}
                  </span>
                </div>
                <div className="outbound-attempt-facts">
                  <span>
                    <b>Результат:</b>{" "}
                    {{
                      completed: "Завершён",
                      answered: "Ответили",
                      no_answer: "Без ответа",
                      busy: "Занято",
                      failed: "Не удалось соединиться",
                      voicemail: "Автоответчик",
                      unknown: "Результат уточняется",
                    }[attempt.outcome || ""] || "Результат уточняется"}
                  </span>
                  {attempt.durationSeconds !== null && (
                    <span>
                      <b>Длительность:</b> {attempt.durationSeconds} с
                    </span>
                  )}
                  {attempt.callId && (
                    <Link
                      className="inline-flex min-h-11 items-center underline"
                      to="/calls"
                    >
                      Открыть историю звонков
                    </Link>
                  )}
                  {attempt.errorCode && (
                    <span>
                      Не удалось завершить звонок. Проверьте телефонию перед
                      повтором.
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <div className="outbound-history-pagination">
            <span>
              Показано {result.attempts.length} из {result.total} · Страница{" "}
              {result.page} из {result.totalPages}
            </span>
            <div>
              <button
                type="button"
                className="btn-secondary text-sm"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
                aria-label="Предыдущая страница попыток"
              >
                Назад
              </button>
              <button
                type="button"
                className="btn-secondary text-sm"
                disabled={page >= result.totalPages}
                onClick={() => setPage((value) => value + 1)}
                aria-label="Следующая страница попыток"
              >
                Далее
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function CampaignRetrySettings({ campaign, disabled, onSave }: {
  campaign: Campaign;
  disabled: boolean;
  onSave: (input: { maxAttempts?: number; retryIntervalMinutes?: number }) => Promise<boolean>;
}) {
  const [attempts, setAttempts] = useState(campaign.maxAttempts);
  const [interval, setInterval] = useState(campaign.retryIntervalMinutes ?? 1);
  const [intervalChanged, setIntervalChanged] = useState(false);
  const valid = !intervalChanged || (Number.isInteger(interval) && interval >= 1 && interval <= 1440);
  return <details className="rounded-xl border border-[var(--neu-border)] p-3">
    <summary className="min-h-11 cursor-pointer font-semibold">Настроить повторные звонки</summary>
    <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2 mt-3">
      <label>Попыток на контакт
        <select className="input mt-2" value={attempts} onChange={e=>setAttempts(Number(e.target.value))}>
          {Array.from(new Set([1,2,3,4,5,campaign.maxAttempts])).sort((a,b)=>a-b).map(value=><option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>Интервал между попытками, мин
        <input className="input mt-2" type="number" min={1} max={1440} step={1} value={interval}
          aria-invalid={!valid} aria-describedby={`retry-hint-${campaign.campaignId}`}
          onChange={e=>{setInterval(Number(e.target.value));setIntervalChanged(true);}} />
      </label>
      <p id={`retry-hint-${campaign.campaignId}`} className="text-sm text-neu-muted sm:col-span-2">
        {!valid ? "Укажите целое число от 1 до 1440 минут." : intervalChanged
          ? "Выбранный интервал будет одинаковым между всеми попытками."
          : "Сохранённые правила ожидания действуют, пока вы не измените интервал."}
      </p>
      <button type="button" className="btn-secondary" disabled={!valid || (attempts !== campaign.maxAttempts && (attempts < 1 || attempts > 5)) || (attempts === campaign.maxAttempts && !intervalChanged)}
        onClick={()=>void onSave({...(attempts !== campaign.maxAttempts ? {maxAttempts:attempts}:{}),...(intervalChanged?{retryIntervalMinutes:interval}:{})})}>
        {disabled ? "Сохраняем…" : "Сохранить повторы"}
      </button>
    </fieldset>
  </details>;
}
