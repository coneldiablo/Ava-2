import { useMemo, useState } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { AppShell } from "@/components/layout/AppShell";
import { Card, PillButton } from "@/components/ui/core";
import { EmptyState, LoadingBlock, PageHeader } from "@/components/ui/shell";
import { api } from "@/lib/api";

const PERIODS = [
  ["24h", "24 часа"],
  ["7d", "7 дней"],
  ["30d", "30 дней"],
  ["custom", "Свой период"],
];

const SOURCE_LABELS = {
  call_history: "История звонков",
  outbound: "Попытки обзвона",
  whatsapp_crm: "WhatsApp CRM",
};

const STAGE_LABELS = {
  originate: "Создание звонка",
  provider_sip: "Провайдер / SIP",
  ava_session: "Сессия AVA",
  voicemail: "Автоответчик",
  other: "Другое",
};

function normalizePositiveInt(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
}

function formatDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (!total) return "0 с";
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes ? `${minutes} мин ${rest} с` : `${rest} с`;
}

function formatInZone(value, timeZone) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  try {
    return parsed.toLocaleString(undefined, { timeZone });
  } catch {
    return parsed.toLocaleString();
  }
}

function Metric({ label, value, hint }) {
  return (
    <div className="border border-[#111111]/10 px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]">{label}</p>
      <p className="mt-1 font-clash-display text-3xl font-bold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-[#666666]">{hint}</p> : null}
    </div>
  );
}

function BreakdownRow({ label, values }) {
  return (
    <tr className="border-t border-[#111111]/10">
      <td className="py-2 pr-4 text-xs uppercase tracking-[0.2em] text-[#838282]">{label}</td>
      {["answered", "no_answer", "failed", "voicemail", "other"].map((key) => (
        <td key={key} className="py-2 pr-4 text-right text-sm tabular-nums">
          {values?.[key] ?? 0}
        </td>
      ))}
    </tr>
  );
}

export default function PilotAnalyticsPage() {
  const [businessIdInput, setBusinessIdInput] = useState("");
  const [period, setPeriod] = useState("24h");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const businessId = normalizePositiveInt(businessIdInput);
  const isCustom = period === "custom";
  const customReady = isCustom && Boolean(startDate) && Boolean(endDate);

  const hotelsQuery = useQuery({
    queryKey: ["hotels"],
    queryFn: async () => (await api.get("/api/hotels")).data,
  });

  const analyticsQuery = useQuery({
    queryKey: ["pilot-analytics", businessId, period, startDate, endDate],
    // No business selected means no request: analytics is never unscoped.
    enabled: Boolean(businessId) && (!isCustom || customReady),
    queryFn: async () => {
      const params = { business_id: businessId };
      if (isCustom) {
        params.start_date = startDate;
        params.end_date = endDate;
      } else {
        params.period = period;
      }
      return (await api.get("/api/pilot-analytics", { params })).data;
    },
  });

  const data = analyticsQuery.data;
  const profiles = hotelsQuery.data?.profiles || [];
  const zone = data?.timezone || "UTC";

  const unavailableSources = useMemo(
    () =>
      Object.entries(data?.sources || {})
        .filter(([, status]) => status !== "ok")
        .map(([key, status]) => `${SOURCE_LABELS[key] || key}: ${status}`),
    [data],
  );

  return (
    <AppShell>
      <PageHeader
        eyebrow="Пилот"
        title="Аналитика"
        description="Показатели одного бизнеса за выбранный период: звонки, результаты, задачи менеджеров, сообщения и технические ошибки."
        actions={
          <PillButton
            variant="outline"
            onClick={() => analyticsQuery.refetch()}
            disabled={!businessId || analyticsQuery.isFetching}
          >
            <span className="flex items-center gap-2">
              <RefreshCcw size={14} />
              Обновить
            </span>
          </PillButton>
        }
      />

      <Card className="mt-8 rounded-[24px]">
        <div className="flex flex-wrap items-end gap-6">
          <label className="space-y-2">
            <span className="block text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
              Бизнес
            </span>
            <select
              value={businessIdInput}
              onChange={(event) => setBusinessIdInput(event.target.value)}
              className="rounded-full border border-[#111111] bg-transparent px-4 py-2 text-sm"
            >
              <option value="">Выберите бизнес…</option>
              {profiles.map((profile) => {
                const id = normalizePositiveInt(
                  profile?.business_id ?? profile?.businessId ?? profile?.id,
                );
                return (
                  <option key={id} value={String(id)}>
                    {profile.name} (#{id})
                  </option>
                );
              })}
            </select>
          </label>

          <div className="space-y-2">
            <span className="block text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
              Период
            </span>
            <div className="flex flex-wrap gap-2">
              {PERIODS.map(([value, label]) => (
                <PillButton
                  key={value}
                  variant={period === value ? "solid" : "outline"}
                  onClick={() => setPeriod(value)}
                  className="text-xs"
                >
                  {label}
                </PillButton>
              ))}
            </div>
          </div>

          {isCustom ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-2">
                <span className="block text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                  Начало
                </span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                  className="rounded-full border border-[#111111] bg-transparent px-4 py-2 text-sm"
                />
              </label>
              <label className="space-y-2">
                <span className="block text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                  Конец
                </span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                  className="rounded-full border border-[#111111] bg-transparent px-4 py-2 text-sm"
                />
              </label>
            </div>
          ) : null}
        </div>

        {data ? (
          <p className="mt-4 border-t border-[#111111]/10 pt-4 text-xs text-[#666666]">
            {formatInZone(data.period?.start_at, zone)} — {formatInZone(data.period?.end_at, zone)} ({zone})
          </p>
        ) : null}
      </Card>

      {!businessId ? (
        <div className="mt-8 pb-16">
          <EmptyState
            title="Выберите бизнес"
            description="Аналитика показывает данные только одного бизнеса за раз. Выберите его выше."
          />
        </div>
      ) : isCustom && !customReady ? (
        <div className="mt-8 pb-16">
          <EmptyState
            title="Выберите даты"
            description="Укажите начало и конец периода, не более 90 дней."
          />
        </div>
      ) : analyticsQuery.isLoading ? (
        <div className="mt-8">
          <LoadingBlock label="Загрузка аналитики" />
        </div>
      ) : analyticsQuery.isError ? (
        <div className="mt-8 pb-16">
          <EmptyState
            title="Не удалось загрузить аналитику"
            description={
              analyticsQuery.error?.response?.data?.detail ||
              "Сервис аналитики недоступен."
            }
            actionLabel="Повторить"
            onAction={() => analyticsQuery.refetch()}
          />
        </div>
      ) : (
        <div className="mt-8 space-y-6 pb-16">
          {data?.partial ? (
            <Card className="rounded-[24px] border-orange-500/40">
              <div className="flex items-start gap-3">
                <AlertTriangle size={16} className="mt-0.5 text-orange-600" />
                <div>
                  <p className="text-sm font-medium">Данные загружены частично</p>
                  <p className="mt-1 text-xs text-[#666666]">
                    {unavailableSources.join(" · ")}. Недоступные разделы скрыты, а не показаны как нулевые.
                  </p>
                </div>
              </div>
            </Card>
          ) : null}

          <Card className="rounded-[24px] space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-clash-display text-xl font-bold uppercase">Звонки</h2>
              <Link to="/history" className="text-xs underline underline-offset-4">
                История звонков
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
              <Metric label="Входящие" value={data?.calls?.incoming ?? 0} />
              <Metric label="Попытки исходящих" value={data?.calls?.outgoing_attempts ?? 0} />
              <Metric label="Отвечено" value={data?.totals?.answered ?? 0} />
              <Metric label="Без ответа" value={data?.totals?.no_answer ?? 0} />
              <Metric label="Ошибки" value={data?.totals?.failed ?? 0} />
              <Metric
                label="Средняя длительность"
                value={formatDuration(data?.average_answered_call_duration_seconds)}
                hint="только отвеченные звонки"
              />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left">
                <thead>
                  <tr>
                    <th className="pb-2 pr-4 text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]">
                      Направление
                    </th>
                    {["Отвечено", "Без ответа", "Ошибка", "Автоответчик", "Другое"].map((label) => (
                      <th
                        key={label}
                        className="pb-2 pr-4 text-right text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]"
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <BreakdownRow label="Входящие" values={data?.incoming_breakdown} />
                  <BreakdownRow label="Исходящие" values={data?.outgoing_breakdown} />
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="rounded-[24px] space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-clash-display text-xl font-bold uppercase">Работа менеджеров</h2>
              <span className="flex gap-4 text-xs">
                <Link to="/tasks" className="underline underline-offset-4">
                  Задачи
                </Link>
                <Link to="/followups" className="underline underline-offset-4">
                  Сообщения
                </Link>
              </span>
            </div>
            {data?.manager_tasks || data?.followups ? (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Metric label="Задач создано" value={data?.manager_tasks?.created ?? 0} />
                <Metric
                  label="Открытые задачи"
                  value={
                    (data?.manager_tasks?.by_status?.new ?? 0) +
                    (data?.manager_tasks?.by_status?.in_progress ?? 0)
                  }
                  hint="новые и в работе"
                />
                <Metric label="Сообщений отправлено" value={data?.followups?.sent ?? 0} />
                <Metric
                  label="Ожидают одобрения"
                  value={data?.followups?.by_status?.draft ?? 0}
                />
              </div>
            ) : (
              <p className="text-xs text-[#666666]">
                WhatsApp CRM недоступна, поэтому количество задач и сообщений за этот период неизвестно.
              </p>
            )}
          </Card>

          <Card className="rounded-[24px] space-y-4">
            <h2 className="font-clash-display text-xl font-bold uppercase">Ошибки провайдера / SIP</h2>
            {(data?.errors || []).length === 0 ? (
              <p className="text-xs text-[#666666]">За этот период ошибок провайдера или SIP нет.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left">
                  <thead>
                    <tr>
                      {["Этап", "Код", "Провайдер", "Количество", "Последняя ошибка"].map((label) => (
                        <th
                          key={label}
                          className="pb-2 pr-4 text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]"
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.errors.map((error, index) => (
                      <tr key={`${error.error_stage}-${error.error_code}-${index}`} className="border-t border-[#111111]/10">
                        <td className="py-2 pr-4 text-xs uppercase tracking-[0.2em] text-[#838282]">
                          {STAGE_LABELS[error.error_stage] || error.error_stage}
                        </td>
                        <td className="py-2 pr-4 text-sm">{error.error_code}</td>
                        <td className="py-2 pr-4 text-sm">{error.provider || "-"}</td>
                        <td className="py-2 pr-4 text-sm tabular-nums">{error.count}</td>
                        <td className="py-2 pr-4 text-xs text-[#666666]">
                          {formatInZone(error.last_seen_at, zone)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Link to="/scheduling" className="inline-block text-xs underline underline-offset-4">
              Исходящие кампании
            </Link>
          </Card>
        </div>
      )}
    </AppShell>
  );
}
