import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  Copy,
  Pause,
  PhoneCall,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import { useQueries } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { Card, PillButton } from "@/components/ui/core";
import { Modal } from "@/components/ui/modal";
import { EmptyState, LoadingBlock, PageHeader } from "@/components/ui/shell";
import { api, downloadBlob } from "@/lib/api";
import { downloadBrowserFile, formatNumber } from "@/lib/formatters";

const EMPTY_FORM = {
  business_id: "",
  name: "",
  timezone: "UTC",
  daily_window_start_local: "09:00",
  daily_window_end_local: "17:00",
  max_concurrent: 1,
  min_interval_seconds_between_calls: 5,
  max_attempts: 3,
  retry_initial_delay_seconds: 60,
  retry_backoff_multiplier: 2,
  retry_max_delay_seconds: 3600,
  default_context: "default",
  voicemail_drop_enabled: false,
  voicemail_drop_media_uri: "",
  consent_enabled: false,
  consent_media_uri: "",
  consent_timeout_seconds: 5,
  callerid: "",
  callerid_name: "",
  amd_options: {
    initial_silence_ms: 2000,
    greeting_ms: 2000,
    after_greeting_silence_ms: 1000,
    total_analysis_time_ms: 5000,
  },
};

const CAMPAIGN_STATUS_LABELS = {
  draft: "Черновик",
  running: "Запущена",
  paused: "На паузе",
  stopped: "Остановлена",
  completed: "Завершена",
  archived: "В архиве",
};

const LEAD_STATE_LABELS = {
  pending: "Ожидает",
  leased: "В очереди",
  dialing: "Набор номера",
  amd_pending: "Проверка ответа",
  in_progress: "Разговор",
  completed: "Завершён",
  failed: "Ошибка",
  canceled: "Отменён",
};

function normalizeBusinessId(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
}

function toCampaignPayload(form, scopedBusinessId) {
  const payload = {
    ...form,
    amd_options: { ...(form.amd_options || {}) },
  };
  const resolvedBusinessId = scopedBusinessId || normalizeBusinessId(payload.business_id);

  if (resolvedBusinessId) {
    payload.business_id = resolvedBusinessId;
  } else {
    delete payload.business_id;
  }
  if (!String(payload.callerid || "").trim()) {
    delete payload.callerid;
  }
  if (!String(payload.callerid_name || "").trim()) {
    delete payload.callerid_name;
  }

  return payload;
}

export default function SchedulingPage() {
  const [showArchived, setShowArchived] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState(null);
  const [leadQuery, setLeadQuery] = useState("");
  const [leadPage, setLeadPage] = useState(1);
  const [campaignModalOpen, setCampaignModalOpen] = useState(false);
  const [campaignForm, setCampaignForm] = useState(EMPTY_FORM);
  const [campaignMode, setCampaignMode] = useState("create");
  const [importingLeads, setImportingLeads] = useState(false);
  const [leadFile, setLeadFile] = useState(null);
  const [recordingUploadTarget, setRecordingUploadTarget] = useState(null);
  const [searchParams] = useSearchParams();
  const scopedBusinessId = useMemo(
    () => normalizeBusinessId(searchParams.get("business_id")),
    [searchParams],
  );
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [testName, setTestName] = useState("");
  const [testRunning, setTestRunning] = useState(false);
  const [diagnosticLead, setDiagnosticLead] = useState(null);

  const [metaQuery, campaignsQuery, detailsQuery, statsQuery, leadsQuery, recordingsQuery] = useQueries({
    queries: [
      {
        queryKey: ["outbound-meta"],
        queryFn: async () => (await api.get("/api/outbound/meta")).data,
      },
      {
        queryKey: ["campaigns", showArchived, scopedBusinessId],
        queryFn: async () => {
          const params = new URLSearchParams({
            include_archived: String(showArchived),
          });
          if (scopedBusinessId) {
            params.set("business_id", String(scopedBusinessId));
          }
          return (await api.get(`/api/outbound/campaigns?${params.toString()}`)).data;
        },
      },
      {
        queryKey: ["campaign-details", selectedCampaignId],
        enabled: Boolean(selectedCampaignId),
        queryFn: async () =>
          (await api.get(`/api/outbound/campaigns/${selectedCampaignId}`)).data,
      },
      {
        queryKey: ["campaign-stats", selectedCampaignId],
        enabled: Boolean(selectedCampaignId),
        queryFn: async () =>
          (await api.get(`/api/outbound/campaigns/${selectedCampaignId}/stats`)).data,
      },
      {
        queryKey: ["campaign-leads", selectedCampaignId, leadPage, leadQuery],
        enabled: Boolean(selectedCampaignId),
        queryFn: async () => {
          const params = new URLSearchParams({
            page: String(leadPage),
            page_size: "25",
          });
          if (leadQuery) {
            params.set("q", leadQuery);
          }
          return (await api.get(`/api/outbound/campaigns/${selectedCampaignId}/leads?${params.toString()}`)).data;
        },
      },
      {
        queryKey: ["outbound-recordings"],
        queryFn: async () => (await api.get("/api/outbound/recordings")).data,
      },
    ],
  });

  useEffect(() => {
    const campaigns = campaignsQuery.data || [];
    if (!campaigns.length) {
      if (selectedCampaignId) {
        setSelectedCampaignId(null);
      }
      return;
    }
    if (!selectedCampaignId || !campaigns.some((campaign) => campaign.id === selectedCampaignId)) {
      setSelectedCampaignId(campaigns[0].id);
    }
  }, [campaignsQuery.data, selectedCampaignId]);

  const selectedCampaign = useMemo(
    () => campaignsQuery.data?.find((item) => item.id === selectedCampaignId) || detailsQuery.data || null,
    [campaignsQuery.data, detailsQuery.data, selectedCampaignId],
  );

  function openCreateModal() {
    setCampaignMode("create");
    setCampaignForm({
      ...EMPTY_FORM,
      business_id: scopedBusinessId || selectedCampaign?.business_id || "",
      timezone: metaQuery.data?.server_timezone || "UTC",
      default_context: selectedCampaign?.default_context || "default",
      callerid: selectedCampaign?.callerid || "",
      callerid_name: selectedCampaign?.callerid_name || "",
    });
    setCampaignModalOpen(true);
  }

  function openEditModal() {
    if (!selectedCampaign) {
      return;
    }
    setCampaignMode("edit");
    setCampaignForm({
      ...EMPTY_FORM,
      ...selectedCampaign,
      business_id: scopedBusinessId || selectedCampaign.business_id || "",
      callerid: selectedCampaign.callerid || "",
      callerid_name: selectedCampaign.callerid_name || "",
      amd_options: {
        ...EMPTY_FORM.amd_options,
        ...(selectedCampaign.amd_options || {}),
      },
    });
    setCampaignModalOpen(true);
  }

  async function saveCampaign() {
    const payload = toCampaignPayload(campaignForm, scopedBusinessId);
    try {
      if (campaignMode === "create") {
        const response = await api.post("/api/outbound/campaigns", payload);
        toast.success("Кампания создана.");
        setSelectedCampaignId(response.data?.id || null);
      } else {
        await api.patch(`/api/outbound/campaigns/${selectedCampaignId}`, payload);
        toast.success("Кампания обновлена.");
      }
      setCampaignModalOpen(false);
      campaignsQuery.refetch();
      detailsQuery.refetch();
      statsQuery.refetch();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Не удалось сохранить кампанию.");
    }
  }

  async function updateStatus(status, cancelPending = false) {
    if (!selectedCampaignId) {
      return;
    }
    try {
      await api.post(`/api/outbound/campaigns/${selectedCampaignId}/status`, {
        status,
        cancel_pending: cancelPending,
      });
      toast.success(`Статус кампании: ${CAMPAIGN_STATUS_LABELS[status] || status}.`);
      campaignsQuery.refetch();
      detailsQuery.refetch();
      statsQuery.refetch();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Не удалось изменить статус кампании.");
    }
  }

  async function cloneCampaign() {
    if (!selectedCampaignId) {
      return;
    }
    try {
      const response = await api.post(`/api/outbound/campaigns/${selectedCampaignId}/clone`);
      toast.success("Копия кампании создана.");
      setSelectedCampaignId(response.data?.id || null);
      campaignsQuery.refetch();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Не удалось скопировать кампанию.");
    }
  }

  async function runOneNumberTest() {
    if (!selectedCampaignId || !testPhone.trim()) return;
    setTestRunning(true);
    try {
      const response = await api.post(`/api/outbound/campaigns/${selectedCampaignId}/test-runs`, {
        phone_number: testPhone.trim(),
        name: testName.trim() || null,
      });
      const testCampaignId = response.data?.test_campaign?.id;
      toast.success("Тестовая кампания на один номер запущена.");
      setTestModalOpen(false);
      setTestPhone("");
      setTestName("");
      if (testCampaignId) setSelectedCampaignId(testCampaignId);
      await campaignsQuery.refetch();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Не удалось запустить тест одного номера.");
    } finally {
      setTestRunning(false);
    }
  }

  async function archiveCampaign() {
    if (!selectedCampaignId || !window.confirm("Переместить кампанию в архив?")) {
      return;
    }
    try {
      await api.post(`/api/outbound/campaigns/${selectedCampaignId}/archive`);
      toast.success("Кампания перемещена в архив.");
      campaignsQuery.refetch();
      detailsQuery.refetch();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Не удалось архивировать кампанию.");
    }
  }

  async function deleteCampaign() {
    if (!selectedCampaignId || !window.confirm("Удалить кампанию? Это действие нельзя отменить.")) {
      return;
    }
    try {
      await api.delete(`/api/outbound/campaigns/${selectedCampaignId}`);
      toast.success("Кампания удалена.");
      setSelectedCampaignId(null);
      campaignsQuery.refetch();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Не удалось удалить кампанию.");
    }
  }

  async function downloadSampleCsv() {
    try {
      const response = await downloadBlob("/api/outbound/sample.csv");
      downloadBrowserFile(response.data, "outbound_sample_leads.csv");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Не удалось скачать пример CSV.");
    }
  }

  async function importLeads() {
    if (!selectedCampaignId || !leadFile) {
      return;
    }
    setImportingLeads(true);
    try {
      const formData = new FormData();
      formData.append("file", leadFile);
      const response = await api.post(
        `/api/outbound/campaigns/${selectedCampaignId}/leads/import`,
        formData,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      toast.success(
        `Импортировано: ${response.data.accepted}, дубликатов: ${response.data.duplicates}, отклонено: ${response.data.rejected}.`,
      );
      setLeadFile(null);
      leadsQuery.refetch();
      statsQuery.refetch();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Не удалось импортировать клиентов.");
    } finally {
      setImportingLeads(false);
    }
  }

  async function uploadRecording(kind, file, fieldName) {
    if (!file) {
      return;
    }
    setRecordingUploadTarget(fieldName);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await api.post(
        `/api/outbound/recordings/upload?kind=${encodeURIComponent(kind)}`,
        formData,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      setCampaignForm((prev) => ({ ...prev, [fieldName]: response.data.media_uri || "" }));
      recordingsQuery.refetch();
      toast.success("Запись загружена.");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Не удалось загрузить запись.");
    } finally {
      setRecordingUploadTarget(null);
    }
  }

  async function mutateLead(leadId, action, body = {}) {
    try {
      if (action === "delete") {
        await api.delete(`/api/outbound/leads/${leadId}`);
      } else {
        await api.post(`/api/outbound/leads/${leadId}/${action}`, body);
      }
      toast.success("Данные клиента обновлены.");
      leadsQuery.refetch();
      statsQuery.refetch();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Не удалось обновить клиента.");
    }
  }

  if (campaignsQuery.isLoading) {
    return (
      <AppShell>
        <LoadingBlock label="Загрузка кампаний" />
      </AppShell>
    );
  }

  const campaigns = campaignsQuery.data || [];
  const leads = leadsQuery.data?.items || leadsQuery.data?.leads || [];
  const stats = statsQuery.data || {};
  const leadStates = stats.lead_states || {};
  const recordings = recordingsQuery.data || [];

  return (
    <AppShell>
      <div className="space-y-8">
        <PageHeader
          eyebrow="Исходящие звонки"
          title="Кампании обзвона"
          description={
            scopedBusinessId
              ? `Кампании бизнеса #${scopedBusinessId}. Данные других бизнесов недоступны.`
              : "Создавайте кампании, импортируйте клиентов, запускайте тест одного номера и контролируйте результаты каждой попытки звонка."
          }
          actions={
            <>
              <PillButton onClick={() => campaignsQuery.refetch()}>
                <span className="flex items-center gap-2">
                  <RefreshCw size={14} className={campaignsQuery.isFetching ? "animate-spin" : ""} />
                  Обновить
                </span>
              </PillButton>
              <PillButton variant="solid" onClick={openCreateModal}>
                <span className="flex items-center gap-2">
                  <Plus size={14} />
                  Новая кампания
                </span>
              </PillButton>
            </>
          }
        />

        <div className="grid gap-6 xl:grid-cols-12">
          <div className="space-y-4 xl:col-span-4">
            <Card className="rounded-[28px] p-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                    Кампании
                  </p>
                  <p className="mt-2 text-sm text-[#666666]">
                    Часовой пояс сервера: {metaQuery.data?.server_timezone || "UTC"}
                  </p>
                </div>
                <label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#838282]">
                  <input
                    type="checkbox"
                    checked={showArchived}
                    onChange={(event) => setShowArchived(event.target.checked)}
                    className="accent-[#111111]"
                  />
                  Показать архив
                </label>
              </div>
            </Card>

            {campaigns.length ? (
              campaigns.map((campaign) => (
                <button
                  type="button"
                  key={campaign.id}
                  onClick={() => setSelectedCampaignId(campaign.id)}
                  className="w-full text-left"
                >
                  <Card
                    className={`rounded-[28px] p-5 ${campaign.id === selectedCampaignId ? "border-[#111111] bg-white" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-bold">{campaign.name}</p>
                        <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.2em] text-[#838282]">
                          {campaign.timezone} • {campaign.daily_window_start_local} - {campaign.daily_window_end_local}
                        </p>
                        <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.2em] text-[#838282]">
                          Бизнес #{campaign.business_id || 1} • Номер {campaign.callerid || "не настроен"}
                        </p>
                      </div>
                      <span className="rounded-full border border-[#111111]/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em]">
                        {CAMPAIGN_STATUS_LABELS[campaign.status] || campaign.status}
                      </span>
                    </div>
                  </Card>
                </button>
              ))
            ) : (
              <EmptyState
                title="Кампаний пока нет"
                description="Создайте первую кампанию, затем импортируйте клиентов или запустите тест на один номер."
                actionLabel="Новая кампания"
                onAction={openCreateModal}
              />
            )}
          </div>

          <div className="space-y-6 xl:col-span-8">
            {selectedCampaign ? (
              <>
                <Card className="rounded-[32px] p-8">
                  <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                        Выбранная кампания
                      </p>
                      <h2 className="mt-3 font-clash-display text-4xl font-bold uppercase">
                        {selectedCampaign.name}
                      </h2>
                      <p className="mt-3 text-sm text-[#666666]">
                        Бизнес #{selectedCampaign.business_id || 1} •
                        Caller ID: {selectedCampaign.callerid || "не настроен"} •
                        Контекст: {selectedCampaign.default_context || "default"} •
                        Часовой пояс: {selectedCampaign.timezone}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <PillButton onClick={openEditModal}>
                        <span className="flex items-center gap-2">
                          <Save size={14} />
                          Настроить
                        </span>
                      </PillButton>
                      <PillButton onClick={cloneCampaign}>
                        <span className="flex items-center gap-2">
                          <Copy size={14} />
                          Копировать
                        </span>
                      </PillButton>
                      <PillButton onClick={archiveCampaign}>
                        <span className="flex items-center gap-2">
                          <Archive size={14} />
                          В архив
                        </span>
                      </PillButton>
                      <PillButton onClick={deleteCampaign}>
                        <span className="flex items-center gap-2">
                          <Trash2 size={14} />
                          Удалить
                        </span>
                      </PillButton>
                    </div>
                  </div>

                  <div className="mt-8 grid gap-4 md:grid-cols-4">
                    <Stat label="Всего клиентов" value={formatNumber(Object.values(leadStates).reduce((acc, count) => acc + Number(count || 0), 0))} />
                    <Stat label="Ожидают" value={formatNumber(leadStates.pending || 0)} />
                    <Stat label="Завершены" value={formatNumber(leadStates.completed || 0)} />
                    <Stat label="Отменены" value={formatNumber(leadStates.canceled || 0)} />
                  </div>

                  <div className="mt-8 flex flex-wrap gap-2">
                    <PillButton
                      variant="solid"
                      onClick={() => updateStatus("running")}
                    >
                      <span className="flex items-center gap-2">
                        <Play size={14} />
                        Запустить
                      </span>
                    </PillButton>
                    <PillButton onClick={() => updateStatus("paused")}>
                      <span className="flex items-center gap-2">
                        <Pause size={14} />
                        Пауза
                      </span>
                    </PillButton>
                    <PillButton onClick={() => updateStatus("stopped", true)}>
                      <span className="flex items-center gap-2">
                        <Square size={14} />
                        Остановить
                      </span>
                    </PillButton>
                    <PillButton onClick={() => setTestModalOpen(true)}>
                      <span className="flex items-center gap-2">
                        <PhoneCall size={14} />
                        Тест одного номера
                      </span>
                    </PillButton>
                  </div>
                </Card>

                <Card className="rounded-[32px] p-8">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                        Клиенты
                      </p>
                      <div className="mt-3 flex flex-wrap gap-3">
                        <label className="relative block">
                          <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#bfbfbf]" />
                          <input
                            value={leadQuery}
                            onChange={(event) => setLeadQuery(event.target.value)}
                            placeholder="Поиск клиентов..."
                            className="border border-[#111111]/10 bg-white py-3 pl-10 pr-4 text-sm outline-none transition-all focus:border-[#111111]"
                          />
                        </label>
                        <PillButton onClick={() => leadsQuery.refetch()}>Найти</PillButton>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        onChange={(event) => setLeadFile(event.target.files?.[0] || null)}
                        className="max-w-[220px] text-sm"
                      />
                      <PillButton onClick={downloadSampleCsv}>
                        <span className="flex items-center gap-2">
                          <RotateCcw size={14} />
                          Пример CSV
                        </span>
                      </PillButton>
                      <PillButton
                        variant="solid"
                        onClick={importLeads}
                        disabled={!leadFile || importingLeads}
                      >
                        <span className="flex items-center gap-2">
                          <Upload size={14} />
                          {importingLeads ? "Импорт..." : "Импортировать клиентов"}
                        </span>
                      </PillButton>
                    </div>
                  </div>

                  <div className="mt-6 overflow-x-auto">
                    <table className="w-full min-w-[1180px] text-left">
                      <thead className="border-b border-[#111111]/10">
                        <tr>
                          {["Имя", "Телефон", "Статус", "Попытки", "Следующая попытка", "Результат", "Диагностика", "Контекст", "Действия"].map((header) => (
                            <th
                              key={header}
                              className="px-3 py-3 text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]"
                            >
                              {header}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {leads.map((lead) => (
                          <tr key={lead.id} className="border-b border-[#111111]/5">
                            <td className="px-3 py-3 text-sm font-bold">{lead.name || "Без имени"}</td>
                            <td className="px-3 py-3 text-sm">{lead.phone_number}</td>
                            <td className="px-3 py-3 text-sm">{LEAD_STATE_LABELS[lead.state] || lead.state}</td>
                            <td className="px-3 py-3 text-sm">{lead.attempt_count}</td>
                            <td className="px-3 py-3 text-sm">{formatDateTime(lead.next_attempt_at_utc)}</td>
                            <td className="px-3 py-3 text-sm">{lead.last_outcome_attempt || lead.last_outcome || "—"}</td>
                            <td className="px-3 py-3 text-sm">
                              {lead.last_error_code ? (
                                <button
                                  type="button"
                                  className="min-h-11 rounded-full border border-[#111111]/10 px-3 text-left text-xs font-semibold transition-colors hover:border-[#111111] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                                  onClick={() => setDiagnosticLead(lead)}
                                  aria-label={`Открыть диагностику для ${lead.name || lead.phone_number}`}
                                >
                                  {lead.last_error_stage}: {lead.last_error_code}
                                </button>
                              ) : "—"}
                            </td>
                            <td className="px-3 py-3 text-sm">{lead.context_override || selectedCampaign.default_context}</td>
                            <td className="px-3 py-3">
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  className="min-h-11 min-w-11 rounded-full p-2 transition-colors hover:bg-[#111111] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                                  onClick={() => mutateLead(lead.id, "recycle", { mode: "redial" })}
                                  aria-label={`Позвонить повторно: ${lead.name || lead.phone_number}`}
                                >
                                  <RotateCcw size={14} />
                                </button>
                                <button
                                  type="button"
                                  className="min-h-11 min-w-11 rounded-full p-2 transition-colors hover:bg-[#111111] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                                  onClick={() => mutateLead(lead.id, "ignore")}
                                  aria-label={`Исключить из обзвона: ${lead.name || lead.phone_number}`}
                                >
                                  <Archive size={14} />
                                </button>
                                <button
                                  type="button"
                                  className="min-h-11 min-w-11 rounded-full p-2 transition-colors hover:bg-red-500 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                                  onClick={() => mutateLead(lead.id, "delete")}
                                  aria-label={`Удалить: ${lead.name || lead.phone_number}`}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </>
            ) : (
              <EmptyState
                title="Выберите кампанию"
                description="Выберите кампанию слева, чтобы увидеть клиентов и результаты, запустить или приостановить обзвон."
              />
            )}
          </div>
        </div>
      </div>

      <Modal
        isOpen={campaignModalOpen}
        onClose={() => setCampaignModalOpen(false)}
        title={campaignMode === "create" ? "Новая кампания" : "Настройка кампании"}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Название" value={campaignForm.name} onChange={(value) => setCampaignForm((prev) => ({ ...prev, name: value }))} />
          <SelectField
            label="Часовой пояс"
            value={campaignForm.timezone}
            options={metaQuery.data?.iana_timezones?.slice(0, 400) || ["UTC"]}
            onChange={(value) => setCampaignForm((prev) => ({ ...prev, timezone: value }))}
          />
          <Field
            label="ID бизнеса"
            type="number"
            disabled={Boolean(scopedBusinessId)}
            value={campaignForm.business_id}
            onChange={(value) => setCampaignForm((prev) => ({ ...prev, business_id: value }))}
          />
          <Field
            label="Caller ID"
            value={campaignForm.callerid}
            onChange={(value) => setCampaignForm((prev) => ({ ...prev, callerid: value }))}
          />
          <Field
            label="Имя Caller ID"
            value={campaignForm.callerid_name}
            onChange={(value) => setCampaignForm((prev) => ({ ...prev, callerid_name: value }))}
          />
          <Field
            label="Начало ежедневного обзвона"
            type="time"
            value={campaignForm.daily_window_start_local}
            onChange={(value) =>
              setCampaignForm((prev) => ({ ...prev, daily_window_start_local: value }))
            }
          />
          <Field
            label="Окончание ежедневного обзвона"
            type="time"
            value={campaignForm.daily_window_end_local}
            onChange={(value) =>
              setCampaignForm((prev) => ({ ...prev, daily_window_end_local: value }))
            }
          />
          <Field
            label="Одновременных звонков"
            type="number"
            value={campaignForm.max_concurrent}
            onChange={(value) => setCampaignForm((prev) => ({ ...prev, max_concurrent: Number(value) }))}
          />
          <Field
            label="Интервал между звонками, сек."
            type="number"
            value={campaignForm.min_interval_seconds_between_calls}
            onChange={(value) =>
              setCampaignForm((prev) => ({
                ...prev,
                min_interval_seconds_between_calls: Number(value),
              }))
            }
          />
          <Field
            label="Максимум попыток"
            type="number"
            value={campaignForm.max_attempts}
            onChange={(value) => setCampaignForm((prev) => ({ ...prev, max_attempts: Number(value) }))}
          />
          <Field
            label="Задержка первого повтора, сек."
            type="number"
            value={campaignForm.retry_initial_delay_seconds}
            onChange={(value) => setCampaignForm((prev) => ({ ...prev, retry_initial_delay_seconds: Number(value) }))}
          />
          <Field
            label="Множитель задержки повторов"
            type="number"
            value={campaignForm.retry_backoff_multiplier}
            onChange={(value) => setCampaignForm((prev) => ({ ...prev, retry_backoff_multiplier: Number(value) }))}
          />
          <Field
            label="Максимальная задержка, сек."
            type="number"
            value={campaignForm.retry_max_delay_seconds}
            onChange={(value) => setCampaignForm((prev) => ({ ...prev, retry_max_delay_seconds: Number(value) }))}
          />
          <Field
            label="Контекст по умолчанию"
            value={campaignForm.default_context}
            onChange={(value) => setCampaignForm((prev) => ({ ...prev, default_context: value }))}
          />
          <Field
            label="Ожидание согласия, сек."
            type="number"
            value={campaignForm.consent_timeout_seconds}
            onChange={(value) =>
              setCampaignForm((prev) => ({ ...prev, consent_timeout_seconds: Number(value) }))
            }
          />
          <Toggle
            label="Сообщение на автоответчик"
            checked={Boolean(campaignForm.voicemail_drop_enabled)}
            onChange={(checked) =>
              setCampaignForm((prev) => ({ ...prev, voicemail_drop_enabled: checked }))
            }
          />
          {campaignForm.voicemail_drop_enabled ? (
            <RecordingPicker
              label="Запись для автоответчика"
              fieldName="voicemail_drop_media_uri"
              value={campaignForm.voicemail_drop_media_uri}
              recordings={recordings}
              uploading={recordingUploadTarget === "voicemail_drop_media_uri"}
              onChange={(value) =>
                setCampaignForm((prev) => ({ ...prev, voicemail_drop_media_uri: value }))
              }
              onUpload={(file) => uploadRecording("voicemail", file, "voicemail_drop_media_uri")}
            />
          ) : null}
          <Toggle
            label="Запрашивать согласие"
            checked={Boolean(campaignForm.consent_enabled)}
            onChange={(checked) =>
              setCampaignForm((prev) => ({ ...prev, consent_enabled: checked }))
            }
          />
          {campaignForm.consent_enabled ? (
            <RecordingPicker
              label="Запись запроса согласия"
              fieldName="consent_media_uri"
              value={campaignForm.consent_media_uri}
              recordings={recordings}
              uploading={recordingUploadTarget === "consent_media_uri"}
              onChange={(value) =>
                setCampaignForm((prev) => ({ ...prev, consent_media_uri: value }))
              }
              onUpload={(file) => uploadRecording("consent", file, "consent_media_uri")}
            />
          ) : null}
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <PillButton onClick={() => setCampaignModalOpen(false)}>Отмена</PillButton>
          <PillButton variant="solid" onClick={saveCampaign}>
            Сохранить кампанию
          </PillButton>
        </div>
      </Modal>

      <Modal
        isOpen={testModalOpen}
        onClose={() => !testRunning && setTestModalOpen(false)}
        title="Тест одного номера"
      >
        <div className="space-y-5">
          <p className="text-sm leading-6 text-[#5f5f5f]">
            Немедленно запускает отдельную тестовую кампанию с настройками выбранного бизнеса,
            контекстом, SIP-транком и Caller ID. Один номер, одна попытка; основная очередь не меняется.
          </p>
          <Field label="Номер телефона" type="tel" value={testPhone} onChange={setTestPhone} />
          <Field label="Имя получателя (необязательно)" value={testName} onChange={setTestName} />
          <div className="flex justify-end gap-3">
            <PillButton onClick={() => setTestModalOpen(false)} disabled={testRunning}>Отмена</PillButton>
            <PillButton variant="solid" onClick={runOneNumberTest} disabled={testRunning || !testPhone.trim()}>
              {testRunning ? "Запуск…" : "Запустить тест"}
            </PillButton>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={Boolean(diagnosticLead)}
        onClose={() => setDiagnosticLead(null)}
        title="Диагностика попытки"
      >
        {diagnosticLead ? (
          <dl className="grid gap-4 text-sm md:grid-cols-2">
            <Diagnostic label="Этап" value={diagnosticLead.last_error_stage} />
            <Diagnostic label="Код" value={diagnosticLead.last_error_code} />
            <Diagnostic label="Можно повторить" value={diagnosticLead.last_retryable == null ? "—" : diagnosticLead.last_retryable ? "Да" : "Нет"} />
            <Diagnostic label="Провайдер" value={diagnosticLead.last_provider} />
            <Diagnostic label="Call ID" value={diagnosticLead.last_call_id} />
            <Diagnostic label="Время попытки" value={formatDateTime(diagnosticLead.last_started_at_utc)} />
            <div className="md:col-span-2">
              <Diagnostic label="Сообщение" value={diagnosticLead.last_error_message} />
            </div>
          </dl>
        ) : null}
      </Modal>
    </AppShell>
  );
}

function Diagnostic({ label, value }) {
  return (
    <div className="rounded-2xl border border-[#111111]/10 bg-white p-4">
      <dt className="text-[10px] font-bold uppercase tracking-[0.24em] text-[#666666]">{label}</dt>
      <dd className="mt-2 break-words font-mono text-sm text-[#111111]">{value || "—"}</dd>
    </div>
  );
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function Stat({ label, value }) {
  return (
    <div className="rounded-[24px] border border-[#111111]/10 bg-white px-4 py-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
        {label}
      </p>
      <p className="mt-2 text-2xl font-bold">{value}</p>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", disabled = false }) {
  return (
    <label className="block space-y-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
        {label}
      </span>
      <input
        type={type}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={`min-h-11 w-full border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none transition-all focus:border-[#111111] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
          disabled ? "cursor-not-allowed bg-[#f4f4f4] text-[#777777]" : ""
        }`}
      />
    </label>
  );
}

function SelectField({ label, value, options, onChange }) {
  return (
    <label className="block space-y-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 w-full border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none transition-all focus:border-[#111111] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function RecordingPicker({ label, fieldName, value, recordings, uploading, onChange, onUpload }) {
  const previewUrl = value
    ? `/api/outbound/recordings/preview.wav?media_uri=${encodeURIComponent(value)}`
    : "";
  return (
    <div className="space-y-3 md:col-span-2">
      <label className="block space-y-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
          {label}
        </span>
        <select
          value={value || ""}
          onChange={(event) => onChange(event.target.value)}
          className="w-full border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none transition-all focus:border-[#111111]"
        >
          <option value="">Выберите запись...</option>
          {(recordings || []).map((recording) => (
            <option key={recording.media_uri} value={recording.media_uri}>
              {recording.filename || recording.media_uri}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-col gap-3 rounded-[20px] border border-[#111111]/10 bg-white p-4 sm:flex-row sm:items-center">
        {previewUrl ? (
          <audio controls src={previewUrl} className="h-9 w-full sm:max-w-[320px]" />
        ) : (
          <span className="text-sm text-[#838282]">Запись не выбрана.</span>
        )}
        <label className="inline-flex cursor-pointer items-center justify-center gap-2 border border-[#111111]/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] transition-colors hover:border-[#111111]">
          <Upload size={14} />
          {uploading ? "Загрузка..." : "Загрузить"}
          <input
            type="file"
            accept=".wav,.ulaw,audio/wav,audio/*"
            disabled={uploading}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0] || null;
              if (file) {
                onUpload(file);
              }
              event.target.value = "";
            }}
            aria-label={`Загрузить запись: ${fieldName}`}
          />
        </label>
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center justify-between rounded-[20px] border border-[#111111]/10 bg-white px-4 py-3">
      <span className="text-sm font-bold">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-[#111111]"
      />
    </label>
  );
}
