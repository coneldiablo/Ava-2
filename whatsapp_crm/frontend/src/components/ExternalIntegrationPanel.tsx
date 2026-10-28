import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import AmoCatalogImport from "./AmoCatalogImport";
import AvitoConnectionPanel from "./AvitoConnectionPanel";
type Provider = "amocrm" | "avito";
type Mapping = {
  pipelineId?: number;
  responsibleUserId?: number;
  taskTypeId?: number;
  statusMap?: Record<string, number>;
};
type Integration = {
  provider: Provider;
  status: string;
  configured: boolean;
  account: { id: string; name: string; domain: string | null } | null;
  config?: { domain?: string; redirectUri?: string; clientId?: string };
  capabilities: Record<string, boolean | string>;
  mapping: Mapping;
  lastSuccessAt: string | null;
  error: { code: string; message: string; action: string } | null;
  authorizationUrl?: string;
};
type Options = {
  pipelines: {
    id: number;
    name: string;
    statuses: { id: number; name: string }[];
  }[];
  users: { id: number; name: string }[];
};
type AvitoChat = {
  id: string;
  title: string;
  users: { id: string; name: string }[];
  clientChatId: string | null;
};
const statusLabels: Record<string, string> = {
  not_configured: "Не подключено",
  configured: "Настройки сохранены",
  connected: "Подключено",
  disconnected: "Отключено",
  reauth_required: "Войдите снова",
  access_denied: "Нужен доступ к сервису",
  rate_limited: "Проверка временно ограничена",
  error: "Требует внимания",
};
const errorLabels: Record<string, string> = {
  EXTERNAL_ACCESS_DENIED:
    "У аккаунта нет нужного доступа. Проверьте разрешения интеграции у провайдера.",
  EXTERNAL_AUTH_REQUIRED: "Авторизация истекла. Подключите аккаунт снова.",
  EXTERNAL_AUTH_OUTCOME_UNKNOWN:
    "Подключение не подтверждено. Проверьте состояние перед новым входом.",
  EXTERNAL_CREDENTIALS_REQUIRED: "Укажите ID и секрет приложения.",
  EXTERNAL_CREDENTIAL_INVALID: "Проверьте данные приложения.",
  EXTERNAL_OUTCOME_UNKNOWN:
    "Результат обмена уточняется. Проверьте историю в подключённом сервисе перед повтором.",
  EXTERNAL_RATE_LIMITED:
    "Сервис ограничил число запросов. Повторите проверку позже.",
  EXTERNAL_TIMEOUT: "Сервис не ответил вовремя. Проверьте состояние позже.",
  EXTERNAL_AMO_DOMAIN_INVALID: "Укажите домен аккаунта amoCRM.",
  EXTERNAL_REDIRECT_INVALID:
    "Адрес возврата должен совпадать с настройками приложения.",
};
function errorMessage(error: unknown) {
  const code = (error as { response?: { data?: { code?: string } } })?.response
    ?.data?.code;
  return code && errorLabels[code]
    ? errorLabels[code]
    : "Не удалось завершить действие. Проверьте подключение и попробуйте снова.";
}
export default function ExternalIntegrationPanel(props: {businessId:number;provider:Provider;canManage:boolean}) {
  return props.provider === 'avito'
    ? <AvitoConnectionPanel key={props.businessId} businessId={props.businessId} canManage={props.canManage} />
    : <CRMIntegrationPanel {...props} />;
}
function CRMIntegrationPanel({
  businessId,
  provider,
  canManage,
}: {
  businessId: number;
  provider: Provider;
  canManage: boolean;
}) {
  const [state, setState] = useState<Integration | null>(null),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [domain, setDomain] = useState(""),
    [clientId, setClientId] = useState(""),
    [secret, setSecret] = useState(""),
    [redirectUri, setRedirectUri] = useState(
      `${window.location.origin}/api/external-integrations/callback/amocrm`,
    ),
    [code, setCode] = useState(""),
    [authorization, setAuthorization] = useState(""),
    [mapping, setMapping] = useState<Mapping>({}),
    [options, setOptions] = useState<Options | null>(null),
    [chats, setChats] = useState<AvitoChat[] | null>(null),
    [offset, setOffset] = useState<number | null>(0);
  const life = useRef(new AbortController()),
    lock = useRef(false);
  const base = `/external-integrations/${businessId}/${provider}`;
  const config = () => ({ signal: life.current.signal, timeout: 20000 });
  function apply(value: Integration, restore = false) {
    if (value?.provider !== provider || typeof value.configured !== "boolean")
      throw new Error();
    setState(value);
    if (restore) {
      setDomain(value.config?.domain || "");
      setClientId(value.config?.clientId || "");
      setRedirectUri(
        value.config?.redirectUri ||
          `${window.location.origin}/api/external-integrations/callback/amocrm`,
      );
      setMapping(value.mapping || {});
    }
  }
  async function refresh(restore = false) {
    const { data } = await api.get(base, config());
    if (life.current.signal.aborted) return;
    if (data.success !== true) throw new Error();
    apply(data.integration, restore);
    return data.integration as Integration;
  }
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    setBusy("load");
    void refresh(true)
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy("");
      });
    return () => controller.abort();
  }, [businessId, provider]);
  async function action(name: string, perform: () => Promise<void>) {
    if (lock.current || !canManage) return;
    lock.current = true;
    setBusy(name);
    setError("");
    setNotice("");
    try {
      await perform();
    } catch (e) {
      if (!life.current.signal.aborted) setError(errorMessage(e));
    } finally {
      lock.current = false;
      if (!life.current.signal.aborted) setBusy("");
    }
  }
  const save = (event: FormEvent) => {
    event.preventDefault();
    void action("save", async () => {
      const body =
        provider === "amocrm"
          ? {
              domain,
              clientId,
              redirectUri,
              mapping,
              ...(secret ? { clientSecret: secret } : {}),
            }
          : { clientId, ...(secret ? { clientSecret: secret } : {}) };
      const { data } = await api.put(base, body, config());
      if (life.current.signal.aborted) return;
      if (data.success !== true) throw new Error();
      apply(data.integration);
      const url = data.integration.authorizationUrl;
      if (provider === "amocrm" && typeof url === "string") {
        const parsed = new URL(url);
        if (
          parsed.origin === "https://www.amocrm.ru" &&
          parsed.pathname === "/oauth"
        )
          setAuthorization(url);
      }
      const readback = await refresh();
      if (
        !readback ||
        readback.config?.clientId !== clientId.trim() ||
        (provider === "amocrm" &&
          readback.config?.domain !==
            domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, ""))
      )
        throw new Error();
      setSecret("");
      setNotice("Настройки сохранены. Подключите аккаунт.");
    });
  };
  async function connect() {
    await action("connect", async () => {
      const { data } = await api.post(
        base + "/connect",
        provider === "amocrm" ? { code } : {},
        config(),
      );
      if (life.current.signal.aborted) return;
      if (data.success !== true) throw new Error();
      apply(data.integration);
      await refresh();
      setCode("");
      setNotice(
        data.integration.status === "connected"
          ? "Аккаунт подключён."
          : "Проверьте состояние подключения.",
      );
    });
  }
  async function check() {
    await action("check", async () => {
      const { data } = await api.post(base + "/check", {}, config());
      if (life.current.signal.aborted) return;
      if (data.success !== true) throw new Error();
      apply(data.integration);
      await refresh();
      setNotice("Состояние подключения обновлено.");
    });
  }
  async function sync() {
    await action("sync", async () => {
      const { data } = await api.post(base + "/sync", {}, config());
      if (life.current.signal.aborted) return;
      if (data.success !== true) throw new Error();
      await refresh();
      setNotice(
        "Обмен завершён. Новые данные доступны в общих карточках клиентов.",
      );
    });
  }
  async function loadOptions() {
    await action("options", async () => {
      const { data } = await api.get(base + "/options", config());
      if (life.current.signal.aborted) return;
      if (
        data.success !== true ||
        !Array.isArray(data.pipelines) ||
        !Array.isArray(data.users)
      )
        throw new Error();
      setOptions(data);
    });
  }
  async function loadChats(next = 0) {
    await action("chats", async () => {
      const { data } = await api.get(base + "/chats", {
        ...config(),
        params: { offset: next },
      });
      if (life.current.signal.aborted) return;
      if (data.success !== true || !Array.isArray(data.chats))
        throw new Error();
      setChats((old) => (next ? [...(old || []), ...data.chats] : data.chats));
      setOffset(data.nextOffset);
    });
  }
  async function importChat(chat: AvitoChat) {
    await action(chat.id, async () => {
      const { data } = await api.post(
        base + "/chats/" + encodeURIComponent(chat.id) + "/import",
        {},
        config(),
      );
      if (life.current.signal.aborted) return;
      if (
        data.success !== true ||
        typeof data.chatId !== "string" ||
        !data.chatId
      )
        throw new Error();
      setChats(
        (old) =>
          old?.map((c) =>
            c.id === chat.id ? { ...c, clientChatId: data.chatId } : c,
          ) || null,
      );
      setNotice("Диалог добавлен в общую карточку клиента.");
    });
  }
  const connected = state?.status === "connected",
    title = provider === "amocrm" ? "amoCRM" : "Авито";
  return (
    <section
      id="ava-channel-panel"
      className="ava-channel-config"
      aria-labelledby="external-title"
    >
      <div>
        <p className="ava-channels-kicker">ПОДКЛЮЧЕНИЕ</p>
        <h2 id="external-title">{title}</h2>
        <p>
          {provider === "amocrm"
            ? "Свяжите клиентов, сделки и задачи с вашей CRM."
            : "Принимайте обращения с объявлений в общие диалоги AVA."}
        </p>
      </div>
      <div className="min-w-0 space-y-5" aria-busy={!!busy}>
        {state && (
          <div className="space-y-1">
            <p className="font-semibold">
              {statusLabels[state.status] || "Состояние уточняется"}
              {state.account?.name ? ` · ${state.account.name}` : ""}
            </p>
            {state.lastSuccessAt && (
              <p className="ava-channel-hint">
                Последний обмен:{" "}
                {new Date(state.lastSuccessAt).toLocaleString("ru-RU", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </p>
            )}
            {state.error && (
              <p role="alert" className="ava-whatsapp-error">
                {state.error.message} {state.error.action}
              </p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="ava-whatsapp-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="ava-channel-feedback">
            {notice}
          </p>
        )}
        {provider === "amocrm" && canManage && state && <AmoCatalogImport businessId={businessId} connected={!!state.account && !["disconnected", "reauth_required"].includes(state.status)} />}
        {!canManage ? (
          <p>Подключением управляет владелец бизнеса.</p>
        ) : (
          <>
            <form onSubmit={save} className="space-y-4">
              <fieldset disabled={!!busy} className="ava-channel-fields">
                {provider === "amocrm" && (
                  <label>
                    <span>Домен amoCRM</span>
                    <input
                      value={domain}
                      required
                      placeholder="company.amocrm.ru"
                      onChange={(e) => setDomain(e.target.value)}
                    />
                  </label>
                )}
                <label>
                  <span>ID приложения</span>
                  <input
                    value={clientId}
                    required
                    autoComplete="off"
                    onChange={(e) => setClientId(e.target.value)}
                  />
                </label>
                <label>
                  <span>Секрет приложения</span>
                  <input
                    value={secret}
                    type="password"
                    required={!state?.configured}
                    autoComplete="new-password"
                    placeholder={
                      state?.configured
                        ? "Оставьте пустым, чтобы не менять"
                        : ""
                    }
                    onChange={(e) => setSecret(e.target.value)}
                  />
                </label>
                {provider === "amocrm" && (
                  <label>
                    <span>Адрес возврата</span>
                    <input
                      value={redirectUri}
                      type="url"
                      required
                      onChange={(e) => setRedirectUri(e.target.value)}
                    />
                  </label>
                )}
              </fieldset>
              {provider === "amocrm" && options && (
                <fieldset disabled={!!busy} className="ava-channel-fields">
                  <label>
                    <span>Воронка</span>
                    <select
                      aria-label="Воронка amoCRM"
                      className="input"
                      value={mapping.pipelineId || ""}
                      onChange={(e) =>
                        setMapping((m) => ({
                          ...m,
                          pipelineId: Number(e.target.value) || undefined,
                          statusMap: {},
                        }))
                      }
                    >
                      <option value="">Выберите воронку</option>
                      {options.pipelines.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Ответственный</span>
                    <select
                      aria-label="Ответственный amoCRM"
                      className="input"
                      value={mapping.responsibleUserId || ""}
                      onChange={(e) =>
                        setMapping((m) => ({
                          ...m,
                          responsibleUserId:
                            Number(e.target.value) || undefined,
                        }))
                      }
                    >
                      <option value="">По настройкам CRM</option>
                      {options.users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {["new", "qualified", "proposal", "won", "lost"].map(
                    (stage, i) => (
                      <label key={stage}>
                        <span>
                          {
                            [
                              "Новый клиент",
                              "Квалификация",
                              "Предложение",
                              "Успешно",
                              "Закрыто",
                            ][i]
                          }
                        </span>
                        <select
                          className="input"
                          aria-label={`Этап amoCRM: ${stage}`}
                          value={mapping.statusMap?.[stage] || ""}
                          onChange={(e) =>
                            setMapping((m) => {
                              const statuses = { ...m.statusMap };
                              if (e.target.value)
                                statuses[stage] = Number(e.target.value);
                              else delete statuses[stage];
                              return { ...m, statusMap: statuses };
                            })
                          }
                        >
                          <option value="">Не менять этап</option>
                          {options.pipelines
                            .find((p) => p.id === mapping.pipelineId)
                            ?.statuses.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                        </select>
                      </label>
                    ),
                  )}
                </fieldset>
              )}
              <div className="ava-channel-actions">
                <button
                  type="submit"
                  className="ava-channel-primary"
                  disabled={!!busy}
                >
                  {busy === "save" ? "Сохраняем…" : "Сохранить настройки"}
                </button>
                {provider === "amocrm" && connected && (
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => void loadOptions()}
                  >
                    Настроить воронку и ответственного
                  </button>
                )}
              </div>
            </form>
            {provider === "amocrm" && authorization && (
              <a
                className="btn-primary inline-flex"
                href={authorization}
                target="_blank"
                rel="noopener noreferrer"
              >
                Разрешить доступ в amoCRM
              </a>
            )}
            {provider === "amocrm" && state?.configured && !connected && (
              <details>
                <summary className="min-h-11 cursor-pointer font-semibold">
                  У меня есть код подключения
                </summary>
                <label className="block mt-3">
                  Код авторизации
                  <input
                    className="input mt-2"
                    value={code}
                    type="password"
                    autoComplete="off"
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="btn-secondary mt-3"
                  disabled={!!busy || !code.trim()}
                  onClick={() => void connect()}
                >
                  Подключить по коду
                </button>
              </details>
            )}
            <div className="ava-channel-actions">
              {provider === "avito" && state?.configured && !connected && (
                <button
                  type="button"
                  className="ava-channel-primary"
                  disabled={!!busy}
                  onClick={() => void connect()}
                >
                  Подключить аккаунт
                </button>
              )}
              <button
                type="button"
                disabled={!!busy || !state?.configured}
                onClick={() => void check()}
              >
                Проверить подключение
              </button>
              <button
                type="button"
                disabled={!!busy || !connected}
                onClick={() => void sync()}
              >
                Синхронизировать
              </button>
              {connected && (
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() =>
                    void action("subscribe", async () => {
                      const { data } = await api.post(
                        base + "/webhook",
                        {},
                        config(),
                      );
                      if (life.current.signal.aborted) return;
                      if (data.success !== true || data.subscribed !== true)
                        throw new Error();
                      setNotice(
                        "Автоматическое получение обновлений подключено.",
                      );
                    })
                  }
                >
                  Получать обновления автоматически
                </button>
              )}
              {state?.configured && (
                <button
                  type="button"
                  className="ava-channel-disconnect"
                  disabled={!!busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Отключить ${title}? История в AVA сохранится.`,
                      )
                    )
                      void action("disconnect", async () => {
                        const { data } = await api.delete(base, config());
                        if (life.current.signal.aborted) return;
                        if (data.success !== true) throw new Error();
                        apply(data.integration);
                        const after = await refresh();
                        if (after?.status !== "disconnected") throw new Error();
                        setSecret("");
                        setCode("");
                        setAuthorization("");
                        setNotice("Подключение отключено. История сохранена.");
                      });
                  }}
                >
                  Отключить
                </button>
              )}
            </div>
            {provider === "avito" && connected && (
              <div className="space-y-3">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!!busy || state?.capabilities.read !== true}
                  onClick={() => void loadChats()}
                >
                  Показать диалоги Авито
                </button>
                {chats && (
                  <>
                    <ul className="max-h-80 space-y-3 overflow-auto pr-2">
                      {chats.map((chat) => (
                        <li
                          key={chat.id}
                          className="rounded-xl border border-[var(--neu-border)] p-3"
                        >
                          <p className="break-words font-medium">
                            {chat.users[0]?.name || chat.title}
                          </p>
                          <p className="text-sm text-neu-muted break-words">
                            {chat.title}
                          </p>
                          {chat.clientChatId ? (
                            <Link
                              className="inline-flex min-h-11 items-center underline"
                              to={`/customers/${encodeURIComponent(chat.clientChatId)}`}
                            >
                              Открыть клиента
                            </Link>
                          ) : (
                            <button
                              type="button"
                              className="btn-secondary mt-2"
                              disabled={!!busy}
                              onClick={() => void importChat(chat)}
                            >
                              Добавить диалог в AVA
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                    {!chats.length && <p>Новых диалогов пока нет.</p>}
                    {offset != null && (
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={!!busy}
                        onClick={() => void loadChats(offset)}
                      >
                        Показать ещё
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
        {!state && (
          <button
            type="button"
            className="btn-secondary"
            disabled={!!busy}
            onClick={() => {
              setBusy("load");
              void refresh(true)
                .catch((e) => setError(errorMessage(e)))
                .finally(() => setBusy(""));
            }}
          >
            Повторить загрузку
          </button>
        )}
      </div>
    </section>
  );
}
