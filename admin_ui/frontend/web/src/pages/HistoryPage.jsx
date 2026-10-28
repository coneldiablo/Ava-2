import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  Activity,
  Download,
  Filter,
  Play,
  RefreshCw,
  Search,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Card, PillButton } from "@/components/ui/core";
import { Modal } from "@/components/ui/modal";
import { EmptyState, LoadingBlock, PageHeader } from "@/components/ui/shell";
import { api, downloadBlob } from "@/lib/api";
import {
  downloadBrowserFile,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
} from "@/lib/formatters";
import { cn } from "@/lib/utils";

const EMPTY_FILTERS = {
  business_id: "",
  caller_number: "",
  caller_name: "",
  provider_name: "",
  pipeline_name: "",
  context_name: "",
  outcome: "",
  start_date: "",
  end_date: "",
};

function normalizeBusinessId(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
}

export default function HistoryPage() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const scopedBusinessId = useMemo(
    () => normalizeBusinessId(searchParams.get("business_id")),
    [searchParams],
  );

  useEffect(() => {
    const id = searchParams.get("id");
    if (id) {
      setSelectedId(id);
    }
  }, [searchParams]);

  useEffect(() => {
    if (!scopedBusinessId) {
      return;
    }
    setFilters((prev) =>
      prev.business_id === String(scopedBusinessId)
        ? prev
        : { ...prev, business_id: String(scopedBusinessId) },
    );
    setPage(1);
  }, [scopedBusinessId]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("page_size", "20");
    Object.entries(filters).forEach(([key, value]) => {
      if (value) {
        params.set(key, value);
      }
    });
    return params.toString();
  }, [filters, page]);

  const [statsQuery, filterQuery, callsQuery, detailsQuery, recordingQuery] = useQueries({
    queries: [
      {
        queryKey: ["history-stats", filters.start_date, filters.end_date, filters.business_id],
        queryFn: async () => {
          const params = new URLSearchParams();
          if (filters.start_date) params.set("start_date", filters.start_date);
          if (filters.end_date) params.set("end_date", filters.end_date);
          if (filters.business_id) params.set("business_id", filters.business_id);
          const response = await api.get(`/api/calls/stats?${params.toString()}`);
          return response.data;
        },
      },
      {
        queryKey: ["history-filters"],
        queryFn: async () => {
          const response = await api.get("/api/calls/filters");
          return response.data;
        },
        staleTime: 60000,
      },
      {
        queryKey: ["history-calls", queryString],
        queryFn: async () => {
          const response = await api.get(`/api/calls?${queryString}`);
          return response.data;
        },
      },
      {
        queryKey: ["history-call", selectedId],
        enabled: Boolean(selectedId),
        queryFn: async () => {
          const response = await api.get(`/api/calls/${selectedId}`);
          return response.data;
        },
      },
      {
        queryKey: ["history-recording", selectedId],
        enabled: Boolean(selectedId),
        queryFn: async () => {
          const response = await api.get(`/api/calls/${selectedId}/recording`);
          return response.data;
        },
      },
    ],
  });

  function openDetails(id) {
    setSelectedId(id);
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.set("id", id);
      return next;
    });
  }

  function closeDetails() {
    setSelectedId(null);
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.delete("id");
      return next;
    });
  }

  async function deleteCall(id) {
    if (!window.confirm("Delete this call record?")) {
      return;
    }
    try {
      await api.delete(`/api/calls/${id}`);
      toast.success("Call record deleted.");
      if (selectedId === id) {
        closeDetails();
      }
      callsQuery.refetch();
      statsQuery.refetch();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to delete call record.");
    }
  }

  async function exportCalls(kind) {
    try {
      const response = await downloadBlob(`/api/calls/export/${kind}?${queryString}`);
      const disposition = response.headers["content-disposition"] || "";
      const filename =
        disposition.match(/filename=([^;]+)/)?.[1]?.replace(/"/g, "") ||
        `call-history.${kind}`;
      downloadBrowserFile(response.data, filename);
    } catch (err) {
      toast.error(err?.response?.data?.detail || `Failed to export ${kind.toUpperCase()}.`);
    }
  }

  if (callsQuery.isLoading && !callsQuery.data) {
    return <LoadingBlock label="Loading Call History" />;
  }

  const calls = callsQuery.data?.calls ?? [];
  const statsCards = [
    {
      label: "Total Calls",
      value: formatNumber(statsQuery.data?.total_calls || 0),
    },
    {
      label: "Success / Failed",
      value: `${formatNumber(statsQuery.data?.outcomes?.completed || 0)} / ${formatNumber(statsQuery.data?.outcomes?.failed || 0)}`,
    },
    {
      label: "Active Calls",
      value: formatNumber(statsQuery.data?.active_calls || 0),
    },
    {
      label: "Avg Duration",
      value: formatDuration(statsQuery.data?.avg_duration_seconds || 0),
    },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Call Records & Diagnostics"
        title="Call History"
        description={
          scopedBusinessId
            ? `Business #${scopedBusinessId} scoped call history, exports, call details, and troubleshoot handoff.`
            : "Search historical calls, export reports, open deep call details, and jump into troubleshoot mode with the same identifiers the backend uses."
        }
        actions={
          <>
            <PillButton onClick={() => callsQuery.refetch()}>
              <span className="flex items-center gap-2">
                <RefreshCw size={14} className={callsQuery.isFetching ? "animate-spin" : ""} />
                Refresh
              </span>
            </PillButton>
            <PillButton onClick={() => exportCalls("csv")}>
              <span className="flex items-center gap-2">
                <Download size={14} />
                Export CSV
              </span>
            </PillButton>
            <PillButton variant="solid" onClick={() => exportCalls("json")}>
              <span className="flex items-center gap-2">
                <Download size={14} />
                Export JSON
              </span>
            </PillButton>
          </>
        }
      />

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {statsCards.map((item) => (
          <Card key={item.label} className="rounded-[28px] p-5 text-center">
            <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-[#838282]">
              {item.label}
            </p>
            <h3 className="mt-3 font-clash-display text-3xl font-bold uppercase">
              {item.value}
            </h3>
          </Card>
        ))}
      </section>

      <Card className="rounded-[32px] p-6">
        <div className="mb-6 flex items-center gap-3">
          <Filter size={16} />
          <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
            Filters
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <FilterField
            icon={Filter}
            label="Business ID"
            type="number"
            disabled={Boolean(scopedBusinessId)}
            value={filters.business_id}
            onChange={(value) => setFilters((prev) => ({ ...prev, business_id: value }))}
          />
          <FilterField
            icon={Search}
            label="Caller Number"
            value={filters.caller_number}
            onChange={(value) => setFilters((prev) => ({ ...prev, caller_number: value }))}
          />
          <FilterField
            icon={Search}
            label="Caller Name"
            value={filters.caller_name}
            onChange={(value) => setFilters((prev) => ({ ...prev, caller_name: value }))}
          />
          <SelectField
            label="Provider"
            value={filters.provider_name}
            options={filterQuery.data?.providers ?? []}
            onChange={(value) => setFilters((prev) => ({ ...prev, provider_name: value }))}
          />
          <SelectField
            label="Pipeline"
            value={filters.pipeline_name}
            options={filterQuery.data?.pipelines ?? []}
            onChange={(value) => setFilters((prev) => ({ ...prev, pipeline_name: value }))}
          />
          <SelectField
            label="Context"
            value={filters.context_name}
            options={filterQuery.data?.contexts ?? []}
            onChange={(value) => setFilters((prev) => ({ ...prev, context_name: value }))}
          />
          <SelectField
            label="Outcome"
            value={filters.outcome}
            options={filterQuery.data?.outcomes ?? []}
            onChange={(value) => setFilters((prev) => ({ ...prev, outcome: value }))}
          />
          <DateField
            label="From Date"
            value={filters.start_date}
            onChange={(value) => setFilters((prev) => ({ ...prev, start_date: value }))}
          />
          <DateField
            label="To Date"
            value={filters.end_date}
            onChange={(value) => setFilters((prev) => ({ ...prev, end_date: value }))}
          />
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <PillButton
            variant="solid"
            onClick={() => {
              setPage(1);
              callsQuery.refetch();
              statsQuery.refetch();
            }}
          >
            Apply Filters
          </PillButton>
          <PillButton
            onClick={() => {
              setFilters(
                scopedBusinessId
                  ? { ...EMPTY_FILTERS, business_id: String(scopedBusinessId) }
                  : EMPTY_FILTERS,
              );
              setPage(1);
            }}
          >
            Clear All
          </PillButton>
        </div>
      </Card>

      {calls.length ? (
        <Card className="overflow-hidden rounded-[32px] p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-left">
              <thead className="bg-[#111111] text-white">
                <tr>
                  {[
                    "Caller",
                    "Business",
                    "Time",
                    "Duration",
                    "Provider / Pipeline",
                    "Context",
                    "Outcome",
                    "Turns",
                    "Latency",
                    "Barge-ins",
                    "Actions",
                  ].map((label) => (
                    <th
                      key={label}
                      className="px-5 py-4 text-[10px] font-bold uppercase tracking-[0.3em]"
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {calls.map((call) => (
                  <tr
                    key={call.id}
                    className="border-b border-[#111111]/5 hover:bg-[#111111]/5"
                  >
                    <td className="px-5 py-4">
                      <button
                        type="button"
                        className="text-left"
                        onClick={() => openDetails(call.id)}
                      >
                        <p className="text-sm font-bold">{call.caller_number || "Unknown caller"}</p>
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#838282]">
                          {call.caller_name || "No caller name"}
                        </p>
                      </button>
                    </td>
                    <td className="px-5 py-4 text-sm">
                      <p className="font-bold">#{call.business_id || 1}</p>
                      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#838282]">
                        To {call.called_number || "-"}
                      </p>
                    </td>
                    <td className="px-5 py-4 text-sm text-[#666666]">
                      {formatDateTime(call.start_time)}
                    </td>
                    <td className="px-5 py-4 text-sm font-bold">
                      {formatDuration(call.duration_seconds)}
                    </td>
                    <td className="px-5 py-4 text-sm">
                      <p className="font-bold uppercase">{call.provider_name || "Unknown"}</p>
                      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#838282]">
                        {call.pipeline_name || "No pipeline"}
                      </p>
                    </td>
                    <td className="px-5 py-4 text-sm">{call.context_name || "—"}</td>
                    <td className="px-5 py-4">
                      <span
                        className={cn(
                          "rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em]",
                          String(call.outcome).toLowerCase().includes("error")
                            ? "border-red-400/30 bg-red-100 text-red-700"
                            : "border-emerald-400/30 bg-emerald-100 text-emerald-700",
                        )}
                      >
                        {call.outcome}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-sm font-bold">
                      {formatNumber(call.total_turns)}
                    </td>
                    <td className="px-5 py-4 text-sm">
                      <span className="flex items-center gap-2">
                        <Activity size={12} className="text-[#bfbfbf]" />
                        {formatNumber(Math.round(call.avg_turn_latency_ms || 0))} ms
                      </span>
                    </td>
                    <td className="px-5 py-4 text-sm font-bold">
                      {formatNumber(call.barge_in_count)}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="rounded-full p-2 transition-colors hover:bg-[#111111] hover:text-white"
                          onClick={() => openDetails(call.id)}
                        >
                          <Play size={14} />
                        </button>
                        <button
                          type="button"
                          className="rounded-full p-2 transition-colors hover:bg-red-500 hover:text-white"
                          onClick={() => deleteCall(call.id)}
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
          <div className="flex items-center justify-between gap-4 border-t border-[#111111]/10 px-5 py-4 text-sm">
            <p className="text-[#666666]">
              Showing page {callsQuery.data?.page || 1} of {callsQuery.data?.total_pages || 1}
            </p>
            <div className="flex gap-2">
              <PillButton
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page <= 1}
              >
                Prev
              </PillButton>
              <PillButton
                onClick={() =>
                  setPage((current) =>
                    Math.min(callsQuery.data?.total_pages || current, current + 1),
                  )
                }
                disabled={page >= (callsQuery.data?.total_pages || 1)}
              >
                Next
              </PillButton>
            </div>
          </div>
        </Card>
      ) : (
        <EmptyState
          title="No Calls Found"
          description="No call history entries matched the current filters."
        />
      )}

      <Modal
        isOpen={Boolean(selectedId)}
        onClose={closeDetails}
        title="Call Details"
        subtitle={detailsQuery.data?.caller_number || detailsQuery.data?.call_id}
        size="xl"
      >
        {detailsQuery.isLoading ? (
          <LoadingBlock label="Loading Details" />
        ) : detailsQuery.data ? (
          <div className="space-y-6">
            <div className="flex flex-wrap gap-3">
              <PillButton
                onClick={() =>
                  navigate(
                    `/logs?mode=troubleshoot&call_id=${encodeURIComponent(detailsQuery.data.call_id)}&business_id=${detailsQuery.data.business_id || 1}`,
                  )
                }
              >
                <span className="flex items-center gap-2">
                  <Wrench size={14} />
                  Troubleshoot
                </span>
              </PillButton>
              <PillButton onClick={() => deleteCall(detailsQuery.data.id)}>
                <span className="flex items-center gap-2">
                  <Trash2 size={14} />
                  Delete
                </span>
              </PillButton>
              <PillButton variant="solid" onClick={closeDetails}>
                <span className="flex items-center gap-2">
                  <X size={14} />
                  Close
                </span>
              </PillButton>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
              <DetailCard label="Caller" value={detailsQuery.data.caller_number || "Unknown"} />
              <DetailCard label="Business" value={`#${detailsQuery.data.business_id || 1}`} />
              <DetailCard label="Called Number" value={detailsQuery.data.called_number || "-"} />
              <DetailCard
                label="Duration"
                value={formatDuration(detailsQuery.data.duration_seconds)}
              />
              <DetailCard label="Outcome" value={detailsQuery.data.outcome || "Unknown"} />
              <DetailCard
                label="Avg Latency"
                value={`${formatNumber(Math.round(detailsQuery.data.avg_turn_latency_ms || 0))} ms`}
              />
            </div>

            <Card className="rounded-[28px] p-6">
              <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                Recording
              </p>
              <div className="mt-4 space-y-4">
                {recordingQuery.data?.has_recording ? (
                  <>
                    <audio
                      className="w-full"
                      controls
                      src={`/api/calls/${detailsQuery.data.id}/recording.wav`}
                    />
                    <div className="grid gap-4 md:grid-cols-3">
                      <DetailCard
                        label="File"
                        value={recordingQuery.data.filename}
                      />
                      <DetailCard
                        label="Size"
                        value={formatBytes(recordingQuery.data.file_size_bytes)}
                      />
                      <DetailCard
                        label="State"
                        value={
                          recordingQuery.data.duration_hint === "empty"
                            ? "Recording exists but contains no audio"
                            : "Recording available"
                        }
                      />
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-[#666666]">No recording found for this call.</p>
                )}
              </div>
            </Card>

            <div className="grid gap-6 xl:grid-cols-2">
              <Card className="rounded-[28px] p-6">
                <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                  Configuration
                </p>
                <div className="mt-4 space-y-3 text-sm">
                  <InfoRow label="Business" value={`#${detailsQuery.data.business_id || 1}`} />
                  <InfoRow label="Called Number" value={detailsQuery.data.called_number} />
                  <InfoRow label="Provider" value={detailsQuery.data.provider_name} />
                  <InfoRow label="Pipeline" value={detailsQuery.data.pipeline_name} />
                  <InfoRow label="Context" value={detailsQuery.data.context_name} />
                  <InfoRow label="Audio Format" value={detailsQuery.data.caller_audio_format} />
                  <InfoRow
                    label="Barge-ins"
                    value={String(detailsQuery.data.barge_in_count || 0)}
                  />
                </div>
              </Card>

              <Card className="rounded-[28px] p-6">
                <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                  Tool Calls
                </p>
                <div className="mt-4 space-y-3">
                  {detailsQuery.data.tool_calls?.length ? (
                    detailsQuery.data.tool_calls.map((tool, index) => (
                      <div
                        key={`${tool.name || "tool"}-${index}`}
                        className="rounded-[20px] border border-[#111111]/10 bg-white p-4"
                      >
                        <p className="text-sm font-bold uppercase">{tool.name || tool.tool_name || "Unnamed tool"}</p>
                        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs text-[#666666]">
                          {JSON.stringify(tool.params ?? tool, null, 2)}
                        </pre>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-[#666666]">No tool executions recorded.</p>
                  )}
                </div>
              </Card>
            </div>

            <Card className="rounded-[28px] p-6">
              <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                Transcript / Conversation History
              </p>
              <div className="mt-4 space-y-3">
                {detailsQuery.data.conversation_history?.length ? (
                  detailsQuery.data.conversation_history.map((turn, index) => (
                    <div key={index} className="rounded-[20px] border border-[#111111]/10 bg-white p-4">
                      <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]">
                        {turn.role || turn.speaker || `Turn ${index + 1}`}
                      </p>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
                        {turn.content || turn.text || JSON.stringify(turn)}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-[#666666]">No transcript captured for this call.</p>
                )}
              </div>
            </Card>

            {detailsQuery.data.error_message ? (
              <Card className="rounded-[28px] border-red-400/30 bg-red-100/70 p-6 text-red-700">
                <p className="text-[10px] font-bold uppercase tracking-[0.35em]">
                  Error
                </p>
                <p className="mt-3 text-sm">{detailsQuery.data.error_message}</p>
              </Card>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-[#666666]">Call details were not found.</p>
        )}
      </Modal>
    </div>
  );
}

function FilterField({ label, value, onChange, icon: Icon, type = "text", disabled = false }) {
  return (
    <label className="block space-y-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
        {label}
      </span>
      <div className="relative">
        {Icon ? <Icon size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#bfbfbf]" /> : null}
        <input
          type={type}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            "w-full border border-[#111111]/10 bg-white py-3 pl-10 pr-4 text-sm outline-none transition-all focus:border-[#111111]",
            disabled && "cursor-not-allowed bg-[#f4f4f4] text-[#777777]",
          )}
        />
      </div>
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
        className="w-full border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none transition-all focus:border-[#111111]"
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function DateField({ label, value, onChange }) {
  return (
    <label className="block space-y-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
        {label}
      </span>
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none transition-all focus:border-[#111111]"
      />
    </label>
  );
}

function DetailCard({ label, value }) {
  return (
    <div className="rounded-[24px] border border-[#111111]/10 bg-white px-4 py-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
        {label}
      </p>
      <p className="mt-2 text-sm font-bold">{value || "—"}</p>
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]">
        {label}
      </span>
      <span className="text-sm font-bold">{value || "—"}</span>
    </div>
  );
}
