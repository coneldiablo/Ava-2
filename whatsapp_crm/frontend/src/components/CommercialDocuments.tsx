import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Download, Send } from "lucide-react";
import { api } from "../api";
type Party = {
  name: string;
  inn: string;
  address: string;
  bankName?: string;
  bik?: string;
  account?: string;
  kpp?: string;
  correspondentAccount?: string;
};
type Invoice = {
  revision: number;
  materialRevision: number;
  number: string;
  issuedOn: string;
  dueOn: string;
  seller: Party;
  buyer: Party;
  note: string;
  clientChatId: string;
  totalMinor: number;
  currency: string;
  status: "issued";
  paymentStatus: "not_recorded";
  fiscalReceipt: false;
};
type DocumentList = {
  success: boolean;
  businessId: number;
  dealId: string;
  materialVersions: { revision: number; createdAt: string }[];
  invoiceVersions: Invoice[];
};
type InvoiceFields = {
  number: string;
  issuedOn: string;
  dueOn: string;
  seller: Party;
  buyer: Party;
  note: string;
  requisitesConfirmed: boolean;
};
type InvoiceRequest = InvoiceFields & {
  revision: number;
  materialRevision: number;
  idempotencyKey: string;
};
const failure: Record<string, string> = {
  DOCUMENT_REQUISITES_REQUIRED:
    "Заполните реквизиты поставщика и плательщика и подтвердите их.",
  DOCUMENT_REQUISITES_INVALID: "Проверьте ИНН, БИК и номера банковских счетов.",
  DOCUMENT_ITEMS_REQUIRED:
    "Добавьте в сохранённое предложение позиции с положительной стоимостью в одной валюте.",
  DOCUMENT_REVISION_CONFLICT:
    "Счёт уже изменён. Ваш ввод сохранён. Обновите список версий и сравните данные.",
  DOCUMENT_MATERIAL_CHANGED:
    "Предложение или сделка изменились. Обновите материал перед выпуском документа.",
  DOCUMENT_IDEMPOTENCY_CONFLICT:
    "Данные отличаются от предыдущей попытки. Сначала обновите версии и проверьте результат.",
  STUDIO_CATALOG_CHANGED:
    "Цена или условия изменились. Обновите предложение и проверьте позиции.",
  DOCUMENT_CHANNEL_UNSUPPORTED:
    "PDF можно отправить через подключённый WhatsApp. В других каналах скачайте документ и передайте его отдельно.",
  WORKSPACE_DIALOGUE_CHANGED:
    "Диалог изменился. Перечитайте последние сообщения перед отправкой.",
  WORKSPACE_CONTROL_CONFLICT:
    "Диалог уже обрабатывает другой сотрудник. Обновите карточку клиента.",
  WORKSPACE_SEND_IN_PROGRESS: "Отправка ещё выполняется. Проверьте состояние.",
  AVA_FEATURE_DISABLED:
    "Откройте диалог клиента и проверьте доступность отправки для вашего бизнеса.",
};
function message(error: unknown) {
  const code = (error as { response?: { data?: { code?: string } } })?.response
    ?.data?.code;
  return code && failure[code]
    ? failure[code]
    : "Не удалось подтвердить действие. Данные оставлены на экране. Обновите состояние перед повтором.";
}
function invoiceFields(value: InvoiceFields): InvoiceFields {
  return {
    number: value.number,
    issuedOn: value.issuedOn,
    dueOn: value.dueOn,
    seller: value.seller,
    buyer: value.buyer,
    note: value.note,
    requisitesConfirmed: value.requisitesConfirmed,
  };
}
function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const empty: InvoiceFields = {
  number: "",
  issuedOn: localDate(),
  dueOn: "",
  seller: {
    name: "",
    inn: "",
    address: "",
    bankName: "",
    bik: "",
    account: "",
    kpp: "",
    correspondentAccount: "",
  },
  buyer: { name: "", inn: "", address: "" },
  note: "",
  requisitesConfirmed: false,
};
export default function CommercialDocuments({
  businessId,
  dealId,
  materialRevision,
  clientChatId,
  canWrite,
  canSend,
  changed,
  storageScope,
}: {
  businessId: number;
  dealId: string;
  materialRevision: number;
  clientChatId?: string | null;
  canWrite: boolean;
  canSend: boolean;
  changed: boolean;
  storageScope: string;
}) {
  const [data, setData] = useState<DocumentList | null>(null),
    [proposalVersion, setProposalVersion] = useState(materialRevision),
    [invoiceVersion, setInvoiceVersion] = useState(0),
    [fields, setFields] = useState<InvoiceFields>(empty),
    [showInvoice, setShowInvoice] = useState(false),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [delivery, setDelivery] = useState<Record<string, string>>({});
  const life = useRef(new AbortController()),
    lock = useRef(false),
    pending = useRef<InvoiceRequest | null>(null);
  const path = `/businesses/${businessId}/studio/proposals/${encodeURIComponent(dealId)}/documents`,
    storage = `ava:commercial:${storageScope}:${dealId}`;
  const config = () => ({ signal: life.current.signal, timeout: 20000 });
  function storePending(value: InvoiceRequest | null) {
    pending.current = value;
    try {
      if (value) sessionStorage.setItem(storage, JSON.stringify(value));
      else sessionStorage.removeItem(storage);
    } catch {
      /* In-memory key preserves retries. */
    }
  }
  function updateDelivery(key: string, status: string) {
    setDelivery((old) => {
      const next = { ...old, [key]: status };
      try {
        sessionStorage.setItem(storage + ":delivery", JSON.stringify(next));
      } catch {
        /* Server ledger remains authoritative. */
      }
      return next;
    });
  }
  async function read() {
    const { data: result } = await api.get(path, config());
    if (life.current.signal.aborted) return;
    if (
      !result.success ||
      result.businessId !== businessId ||
      result.dealId !== dealId ||
      !Array.isArray(result.materialVersions) ||
      !Array.isArray(result.invoiceVersions) ||
      result.invoiceVersions.some(
        (i: Invoice) =>
          !Number.isSafeInteger(i.revision) ||
          i.paymentStatus !== "not_recorded" ||
          i.fiscalReceipt !== false,
      )
    )
      throw new Error();
    setData(result);
    setInvoiceVersion((old) => old || result.invoiceVersions[0]?.revision || 0);
    return result as DocumentList;
  }
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    setBusy("load");
    void read()
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy("");
      });
    try {
      const saved = JSON.parse(sessionStorage.getItem(storage) || "null");
      if (
        saved?.idempotencyKey &&
        saved?.seller &&
        saved?.buyer &&
        Number.isSafeInteger(saved.revision)
      ) {
        pending.current = saved;
        setFields(invoiceFields(saved));
        setShowInvoice(true);
        setNotice(
          "Восстановлен незавершённый счёт. Проверьте данные и подтвердите сохранение.",
        );
      }
      const states = JSON.parse(
        sessionStorage.getItem(storage + ":delivery") || "{}",
      );
      if (states && typeof states === "object") setDelivery(states);
    } catch {
      /* Start with safe empty fields. */
    }
    return () => controller.abort();
  }, [businessId, dealId, storage]);
  useEffect(() => setProposalVersion(materialRevision), [materialRevision]);
  async function action(name: string, fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(name);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      if (!life.current.signal.aborted) setError(message(e));
    } finally {
      lock.current = false;
      if (!life.current.signal.aborted) setBusy("");
    }
  }
  async function download(kind: "proposal" | "invoice", revision: number) {
    await action("download", async () => {
      const suffix =
        kind === "proposal"
          ? `/proposal.pdf?revision=${revision}`
          : `/invoices/${revision}.pdf`;
      const { data: blob } = await api.get(path + suffix, {
        ...config(),
        responseType: "blob",
      });
      if (life.current.signal.aborted) return;
      if (
        !(blob instanceof Blob) ||
        !blob.type.includes("application/pdf") ||
        blob.size > 20 * 1024 * 1024 ||
        (await blob.slice(0, 5).text()) !== "%PDF-"
      )
        throw new Error();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${kind === "proposal" ? "proposal" : "invoice"}-v${revision}.pdf`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("PDF подготовлен для скачивания.");
    });
  }
  async function saveInvoice(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || !data || changed || !fields.requisitesConfirmed) return;
    const old = pending.current;
    const unchanged =
      old &&
      old.materialRevision === materialRevision &&
      JSON.stringify(invoiceFields(old)) ===
        JSON.stringify(invoiceFields(fields));
    const body = {
      ...invoiceFields(fields),
      revision: data.invoiceVersions[0]?.revision || 0,
      materialRevision,
    };
    const input: InvoiceRequest = unchanged
      ? old
      : { ...body, idempotencyKey: crypto.randomUUID() };
    storePending(input);
    await action("invoice", async () => {
      const { data: result } = await api.post(
        path + "/invoices",
        input,
        config(),
      );
      if (life.current.signal.aborted) return;
      if (
        !result.success ||
        result.businessId !== businessId ||
        result.dealId !== dealId ||
        result.invoice?.revision !== input.revision + 1 ||
        result.invoice.materialRevision !== materialRevision
      )
        throw new Error();
      const after = await read();
      if (
        !after?.invoiceVersions.some(
          (i) =>
            i.revision === result.invoice.revision && i.number === input.number,
        )
      )
        throw new Error();
      setInvoiceVersion(result.invoice.revision);
      storePending(null);
      setShowInvoice(false);
      setNotice(
        "Счёт выпущен. PDF доступен ниже. Оплата этим действием не проводится.",
      );
    });
  }
  const documentKey = (kind: "proposal" | "invoice", revision: number) =>
    `commercial:${businessId}:${dealId}:${kind}:${revision}`;
  async function send(kind: "proposal" | "invoice", revision: number) {
    if (!clientChatId || !canSend || !canWrite || changed) return;
    const key = documentKey(kind, revision);
    if (["unknown", "sent", "sending"].includes(delivery[key])) return;
    await action("send", async () => {
      const workspacePath = `/businesses/${businessId}/workspace/clients/${encodeURIComponent(clientChatId)}`;
      const { data: client } = await api.get(workspacePath, config());
      if (life.current.signal.aborted) return;
      if (
        !client.success ||
        client.businessId !== businessId ||
        client.client?.chatId !== clientChatId
      )
        throw new Error();
      if (
        !window.confirm(
          `Отправить ${kind === "proposal" ? "коммерческое предложение" : "счёт"} (версия ${revision}) клиенту «${client.client.name || client.client.phone || "выбранный клиент"}» в WhatsApp?`,
        )
      )
        return;
      updateDelivery(key, "sending");
      try {
        const { data: result } = await api.post(
          path + "/send",
          {
            kind,
            revision,
            ...(client.dialogueRevision
              ? { expectedDialogueRevision: client.dialogueRevision }
              : {}),
          },
          config(),
        );
        if (life.current.signal.aborted) return;
        if (
          result.success !== true ||
          result.businessId !== businessId ||
          !["sent", "unknown", "failed"].includes(result.status)
        )
          throw new Error();
        updateDelivery(key, result.status);
        setNotice(
          result.status === "sent"
            ? "Документ принят WhatsApp. Доставка клиенту пока не подтверждена."
            : result.status === "unknown"
              ? "Отправка уточняется. Повторно документ не отправляем."
              : "Документ не отправлен. Проверьте диалог и подключение WhatsApp.",
        );
      } catch (e) {
        const code =
          (e as { response?: { data?: { code?: string } } })?.response?.data
            ?.code || "";
        const rejectedBeforeDispatch =
          /^(DOCUMENT_|STUDIO_|CAPABILITY_|BUSINESS_|ACCOUNT_|CUSTOMER_)/.test(
            code,
          ) ||
          [
            "AVA_FEATURE_DISABLED",
            "WORKSPACE_DIALOGUE_CHANGED",
            "WORKSPACE_CONTROL_CONFLICT",
            "WORKSPACE_INPUT_INVALID",
          ].includes(code);
        updateDelivery(key, rejectedBeforeDispatch ? "not_started" : "unknown");
        throw e;
      }
    });
  }
  async function checkDelivery(kind: "proposal" | "invoice", revision: number) {
    if (!clientChatId) return;
    await action("delivery", async () => {
      const key = documentKey(kind, revision);
      const { data: result } = await api.get(
        `/businesses/${businessId}/workspace/clients/${encodeURIComponent(clientChatId)}/reply-status`,
        { ...config(), params: { idempotencyKey: key } },
      );
      if (life.current.signal.aborted) return;
      if (
        !result.success ||
        result.businessId !== businessId ||
        !["sent", "unknown", "failed", "not_started"].includes(result.status)
      )
        throw new Error();
      updateDelivery(
        key,
        result.status === "not_started" ? "unknown" : result.status,
      );
      setNotice(
        result.status === "sent"
          ? "WhatsApp подтвердил приём документа. Доставка клиенту пока не подтверждена."
          : result.status === "failed"
            ? "Отправка не состоялась. Проверьте диалог клиента."
            : "Результат ещё не подтверждён. Повторная отправка не выполняется.",
      );
    });
  }
  function deliveryActions(kind: "proposal" | "invoice", revision: number) {
    const status = delivery[documentKey(kind, revision)];
    return (
      <div className="ava-studio-actions">
        <button
          type="button"
          disabled={!!busy || !revision}
          onClick={() => void download(kind, revision)}
        >
          <Download size={17} aria-hidden="true" />
          Скачать PDF
        </button>
        {canSend && canWrite && clientChatId && (
          <button
            type="button"
            disabled={
              !!busy ||
              changed ||
              !revision ||
              (kind === "proposal" && revision !== materialRevision) ||
              (kind === "invoice" &&
                revision !== data?.invoiceVersions[0]?.revision) ||
              ["sent", "unknown", "sending"].includes(status)
            }
            onClick={() => void send(kind, revision)}
          >
            <Send size={17} aria-hidden="true" />
            Отправить PDF в WhatsApp
          </button>
        )}
        {["unknown", "sending"].includes(status) && (
          <>
            <p className="ava-studio-hint">
              Отправка уточняется. Повторная отправка заблокирована.
            </p>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void checkDelivery(kind, revision)}
            >
              Проверить отправку
            </button>
          </>
        )}
        {status === "sent" && (
          <p className="ava-studio-hint">
            WhatsApp принял документ. Доставка пока не подтверждена.
          </p>
        )}
      </div>
    );
  }
  const invoice = data?.invoiceVersions.find(
    (i) => i.revision === invoiceVersion,
  );
  return (
    <section
      className="mt-6 space-y-5 border-t border-[var(--neu-border)] pt-5"
      aria-label="Документы по сделке"
    >
      <h3 className="text-xl font-semibold">Предложение и счёт</h3>
      {error && (
        <p className="ava-studio-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="ava-studio-feedback" role="status">
          {notice}
        </p>
      )}
      {busy === "load" && <p role="status">Загружаем документы…</p>}
      {data && (
        <>
          <div className="space-y-3">
            <label className="block">
              Версия предложения
              <select
                aria-label="Версия предложения PDF"
                className="input mt-2"
                disabled={!!busy}
                value={proposalVersion}
                onChange={(e) => setProposalVersion(Number(e.target.value))}
              >
                {data.materialVersions.map((v) => (
                  <option key={v.revision} value={v.revision}>
                    Версия {v.revision} ·{" "}
                    {new Date(v.createdAt).toLocaleDateString("ru-RU")}
                  </option>
                ))}
              </select>
            </label>
            {deliveryActions("proposal", proposalVersion)}
          </div>
          {canWrite && (
            <button
              type="button"
              className="ava-studio-secondary"
              disabled={!!busy || changed}
              aria-expanded={showInvoice}
              onClick={() => setShowInvoice((v) => !v)}
            >
              {data.invoiceVersions.length
                ? "Подготовить новую версию счёта"
                : "Выставить счёт"}
            </button>
          )}
          {showInvoice && canWrite && (
            <form
              className="space-y-4"
              onSubmit={(event) => void saveInvoice(event)}
            >
              <p className="ava-studio-hint">
                Позиции и сумма берутся из сохранённого предложения. Проверьте
                реквизиты перед выпуском.
              </p>
              <fieldset
                disabled={!!busy || changed}
                className="grid gap-4 sm:grid-cols-2"
              >
                <label>
                  Номер счёта
                  <input
                    required
                    className="input mt-2"
                    maxLength={60}
                    value={fields.number}
                    onChange={(e) =>
                      setFields((f) => ({ ...f, number: e.target.value }))
                    }
                  />
                </label>
                <label>
                  Дата счёта
                  <input
                    required
                    type="date"
                    className="input mt-2"
                    value={fields.issuedOn}
                    onChange={(e) =>
                      setFields((f) => ({ ...f, issuedOn: e.target.value }))
                    }
                  />
                </label>
                <label>
                  Оплатить до
                  <input
                    type="date"
                    min={fields.issuedOn}
                    className="input mt-2"
                    value={fields.dueOn}
                    onChange={(e) =>
                      setFields((f) => ({ ...f, dueOn: e.target.value }))
                    }
                  />
                </label>
              </fieldset>
              {(["seller", "buyer"] as const).map((party) => (
                <fieldset
                  key={party}
                  disabled={!!busy || changed}
                  className="grid gap-4 sm:grid-cols-2"
                >
                  <legend className="mb-3 font-semibold">
                    {party === "seller" ? "Поставщик" : "Плательщик"}
                  </legend>
                  {(party === "seller"
                    ? [
                        ["name", "Юридическое имя"],
                        ["inn", "ИНН"],
                        ["address", "Адрес"],
                        ["bankName", "Название банка"],
                        ["bik", "БИК"],
                        ["account", "Расчётный счёт"],
                        ["kpp", "КПП (если есть)"],
                        [
                          "correspondentAccount",
                          "Корреспондентский счёт (если есть)",
                        ],
                      ]
                    : [
                        ["name", "Имя или название плательщика"],
                        ["inn", "ИНН плательщика (если есть)"],
                        ["address", "Адрес плательщика (если есть)"],
                      ]
                  ).map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <input
                        aria-label={`${party === "seller" ? "Поставщик" : "Плательщик"}: ${label}`}
                        className="input mt-2"
                        maxLength={key === "address" ? 500 : 200}
                        required={
                          key === "name" ||
                          (party === "seller" &&
                            !["kpp", "correspondentAccount"].includes(key))
                        }
                        value={fields[party][key as keyof Party] || ""}
                        onChange={(e) =>
                          setFields((f) => ({
                            ...f,
                            [party]: { ...f[party], [key]: e.target.value },
                          }))
                        }
                      />
                    </label>
                  ))}
                </fieldset>
              ))}
              <label className="block">
                Условия и примечание
                <textarea
                  className="input mt-2"
                  maxLength={2000}
                  rows={3}
                  disabled={!!busy || changed}
                  value={fields.note}
                  onChange={(e) =>
                    setFields((f) => ({ ...f, note: e.target.value }))
                  }
                />
              </label>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={!!busy || changed}
                  checked={fields.requisitesConfirmed}
                  onChange={(e) =>
                    setFields((f) => ({
                      ...f,
                      requisitesConfirmed: e.target.checked,
                    }))
                  }
                />
                Реквизиты, позиции и сумма проверены
              </label>
              <div className="ava-studio-actions">
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => setShowInvoice(false)}
                >
                  Закрыть
                </button>
                <button
                  type="submit"
                  disabled={!!busy || changed || !fields.requisitesConfirmed}
                >
                  {busy === "invoice" ? "Выпускаем…" : "Выпустить счёт"}
                </button>
              </div>
            </form>
          )}
          {data.invoiceVersions.length > 0 && (
            <div className="space-y-3">
              <label className="block">
                Версия счёта
                <select
                  aria-label="Версия счёта PDF"
                  className="input mt-2"
                  disabled={!!busy}
                  value={invoiceVersion}
                  onChange={(e) => setInvoiceVersion(Number(e.target.value))}
                >
                  {data.invoiceVersions.map((i) => (
                    <option key={i.revision} value={i.revision}>
                      № {i.number} · версия {i.revision}
                    </option>
                  ))}
                </select>
              </label>
              {invoice && (
                <p>
                  К оплате:{" "}
                  {new Intl.NumberFormat("ru-RU", {
                    style: "currency",
                    currency: invoice.currency,
                  }).format(invoice.totalMinor / 100)}{" "}
                  · Оплата пока не зафиксирована
                </p>
              )}
              {deliveryActions("invoice", invoiceVersion)}
              <p className="ava-studio-hint">
                Счёт не является подтверждением оплаты или кассовым чеком.
              </p>
            </div>
          )}
        </>
      )}
      <button
        type="button"
        className="ava-studio-secondary"
        disabled={!!busy}
        onClick={() =>
          void action("refresh", async () => {
            await read();
            setNotice(
              "Сохранённые версии обновлены. Ваш ввод оставлен для сравнения.",
            );
          })
        }
      >
        Обновить версии документов
      </button>
      {clientChatId && (
        <Link
          className="inline-flex min-h-11 items-center underline"
          to={`/today?client=${encodeURIComponent(clientChatId)}`}
        >
          Открыть диалог клиента
        </Link>
      )}
    </section>
  );
}
