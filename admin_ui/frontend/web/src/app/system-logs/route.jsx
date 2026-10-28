import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  Bug,
  Download,
  Eye,
  EyeOff,
  Pause,
  Phone,
  RefreshCw,
  Search,
  TerminalSquare,
  Waves,
  Wrench,
} from "lucide-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { Card, PillButton } from "@/components/ui/core";
import { Banner, EmptyState, LoadingBlock, PageHeader } from "@/components/ui/shell";
import { api } from "@/lib/api";
import { downloadBrowserFile, formatDateTime, formatDuration, formatNumber } from "@/lib/formatters";
import { cn } from "@/lib/utils";

const DEFAULT_CONTAINERS = ["ai_engine", "admin_ui", "local_ai_server", "updater-runner"];
const RAW_LEVEL_OPTIONS = ["error", "warning", "info", "debug"];
const CALL_PAGE_SIZE = 12;
const EVENT_LIMIT = 600;
const EMPTY_CALL_FILTERS = {
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

const VIEW_OPTIONS = [
  {
    key: "overview",
    label: "Overview",
    description: "All milestones and related call events.",
  },
  {
    key: "issues",
    label: "Issues",
    description: "Warnings, errors, and failed milestones.",
  },
  {
    key: "provider",
    label: "Provider",
    description: "Provider interactions and external API signals.",
  },
  {
    key: "media",
    label: "Media",
    description: "Transport, RTP, and audio-path diagnostics.",
  },
  {
    key: "vad",
    label: "Barge-in / VAD",
    description: "Voice activity, interruption, and turn-taking events.",
  },
];

const ANSI_COLOR_MAP = {
  30: "#9ca3af",
  31: "#f87171",
  32: "#34d399",
  33: "#fbbf24",
  34: "#60a5fa",
  35: "#f472b6",
  36: "#22d3ee",
  37: "#f3f4f6",
  90: "#6b7280",
  91: "#fca5a5",
  92: "#6ee7b7",
  93: "#fde68a",
  94: "#93c5fd",
  95: "#f9a8d4",
  96: "#67e8f9",
  97: "#ffffff",
};

function parsePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function toDateTimeInputValue(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function toIsoFromDateTimeInput(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildQueryString(filters, extras = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      params.set(key, String(value));
    }
  });
  Object.entries(extras).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      params.set(key, String(value));
    }
  });
  return params.toString();
}

function buildEventLevelFilters(includeDebug) {
  return includeDebug ? undefined : ["error", "warning", "warn", "info"];
}

function buildCategoryFilters(view) {
  if (view === "provider") return ["provider"];
  if (view === "media") return ["transport", "audio"];
  if (view === "vad") return ["vad"];
  return undefined;
}

function matchesView(event, view) {
  if (view === "issues") {
    const level = String(event.level || "").toLowerCase();
    return level.includes("error") || level.includes("warn") || String(event.milestone || "").toLowerCase().includes("fail");
  }
  return true;
}

function dedupeRepeatedEvents(events) {
  const output = [];
  let lastKey = null;

  for (const event of events) {
    const key = [
      event.level,
      event.category,
      event.component,
      event.call_id,
      event.milestone,
      event.msg,
    ].join("|");
    if (key === lastKey) {
      continue;
    }
    output.push(event);
    lastKey = key;
  }

  return output;
}

function levelTone(level) {
  const normalized = String(level || "").toLowerCase();
  if (normalized.includes("error")) {
    return "border-red-400/30 bg-red-100 text-red-700";
  }
  if (normalized.includes("warn")) {
    return "border-amber-400/30 bg-amber-100 text-amber-800";
  }
  if (normalized.includes("debug")) {
    return "border-sky-400/30 bg-sky-100 text-sky-700";
  }
  return "border-emerald-400/30 bg-emerald-100 text-emerald-700";
}

function categoryTone(category) {
  const normalized = String(category || "").toLowerCase();
  if (normalized === "provider") return "bg-[#e9f6ff] text-[#165d82]";
  if (normalized === "audio" || normalized === "transport") return "bg-[#edf7ea] text-[#27572a]";
  if (normalized === "vad") return "bg-[#fff2df] text-[#9a5a00]";
  if (normalized === "tools") return "bg-[#f3ebff] text-[#6a3fa6]";
  return "bg-[#f4f4f4] text-[#555555]";
}

function summarizeIssueCount(events) {
  return events.filter((event) => matchesView(event, "issues")).length;
}

function parseAnsiLine(line) {
  const segments = [];
  const matcher = /\u001b\[([0-9;]+)m/g;
  let cursor = 0;
  let state = { color: null, fontWeight: "normal" };
  let match;

  while ((match = matcher.exec(line))) {
    if (match.index > cursor) {
      segments.push({
        text: line.slice(cursor, match.index),
        style: {
          color: state.color || "#f9fafb",
          fontWeight: state.fontWeight,
        },
      });
    }

    const codes = match[1].split(";").map((value) => Number(value));
    for (const code of codes) {
      if (code === 0) {
        state = { color: null, fontWeight: "normal" };
      } else if (code === 1) {
        state = { ...state, fontWeight: "700" };
      } else if (ANSI_COLOR_MAP[code]) {
        state = { ...state, color: ANSI_COLOR_MAP[code] };
      }
    }

    cursor = matcher.lastIndex;
  }

  if (cursor < line.length) {
    segments.push({
      text: line.slice(cursor),
      style: {
        color: state.color || "#f9fafb",
        fontWeight: state.fontWeight,
      },
    });
  }

  if (!segments.length) {
    segments.push({ text: line, style: { color: "#f9fafb", fontWeight: "normal" } });
  }

  return segments;
}

function downloadTextFile(contents, filename, mimeType) {
  const blob = new Blob([contents], { type: mimeType });
  downloadBrowserFile(blob, filename);
}

export default function LogsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const mode = searchParams.get("mode") === "troubleshoot" ? "troubleshoot" : "raw";
  const selectedContainer = searchParams.get("container") || "ai_engine";
  const selectedCallId = searchParams.get("call_id") || "";
  const scopedBusinessId = searchParams.get("business_id") || "";

  const [tail, setTail] = useState(parsePositiveInteger(searchParams.get("tail"), 300));
  const [rawSearch, setRawSearch] = useState(searchParams.get("q") || "");
  const [rawLevels, setRawLevels] = useState(RAW_LEVEL_OPTIONS);
  const [live, setLive] = useState(searchParams.get("live") !== "0");
  const [showFinder, setShowFinder] = useState(!selectedCallId);
  const [callFilters, setCallFilters] = useState({
    ...EMPTY_CALL_FILTERS,
    business_id: scopedBusinessId,
  });
  const [appliedCallFilters, setAppliedCallFilters] = useState({
    ...EMPTY_CALL_FILTERS,
    business_id: scopedBusinessId,
  });
  const [eventFilters, setEventFilters] = useState({
    view: searchParams.get("view") || "overview",
    search: "",
    since: "",
    until: "",
    hidePayloads: true,
    includeDebug: false,
    hideRepeats: true,
  });
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const deferredRawSearch = useDeferredValue(rawSearch);
  const deferredEventSearch = useDeferredValue(eventFilters.search);
  const logViewportRef = useRef(null);

  useEffect(() => {
    if (!scopedBusinessId) {
      return;
    }
    setCallFilters((current) => ({ ...current, business_id: scopedBusinessId }));
    setAppliedCallFilters((current) => ({ ...current, business_id: scopedBusinessId }));
  }, [scopedBusinessId]);

  useEffect(() => {
    if (selectedCallId) {
      setShowFinder(false);
    }
  }, [selectedCallId]);

  const [containersQuery, healthQuery, callFilterQuery] = useQueries({
    queries: [
      {
        queryKey: ["logs-containers"],
        queryFn: async () => (await api.get("/api/system/containers")).data,
      },
      {
        queryKey: ["logs-health"],
        queryFn: async () => (await api.get("/api/system/health")).data,
        retry: false,
      },
      {
        queryKey: ["call-filter-options"],
        enabled: mode === "troubleshoot",
        staleTime: 60_000,
        queryFn: async () => (await api.get("/api/calls/filters")).data,
      },
    ],
  });

  const containerNames = useMemo(() => {
    const names = (containersQuery.data || []).map((container) => container.name).filter(Boolean);
    return Array.from(new Set([...DEFAULT_CONTAINERS, ...names]));
  }, [containersQuery.data]);

  const rawLogsQuery = useQuery({
    queryKey: ["container-logs", selectedContainer, tail, deferredRawSearch, rawLevels],
    enabled: mode === "raw",
    retry: false,
    refetchInterval: mode === "raw" && live ? 5000 : false,
    queryFn: async () => {
      const params = new URLSearchParams({ tail: String(tail) });
      if (deferredRawSearch.trim()) {
        params.set("q", deferredRawSearch.trim());
      }
      if (rawLevels.length && rawLevels.length < RAW_LEVEL_OPTIONS.length) {
        rawLevels.forEach((level) => params.append("levels", level));
      }
      return (await api.get(`/api/logs/${encodeURIComponent(selectedContainer)}?${params.toString()}`)).data;
    },
  });

  const callSearchQueryString = useMemo(
    () => buildQueryString(appliedCallFilters, { page: 1, page_size: CALL_PAGE_SIZE }),
    [appliedCallFilters],
  );

  const callSearchQuery = useQuery({
    queryKey: ["troubleshoot-call-search", callSearchQueryString],
    enabled: mode === "troubleshoot" && showFinder,
    queryFn: async () => (await api.get(`/api/calls?${callSearchQueryString}`)).data,
  });

  const eventsQuery = useQuery({
    queryKey: [
      "call-log-events",
      selectedContainer,
      selectedCallId,
      eventFilters.view,
      deferredEventSearch,
      eventFilters.since,
      eventFilters.until,
      eventFilters.hidePayloads,
      eventFilters.includeDebug,
    ],
    enabled: mode === "troubleshoot" && Boolean(selectedCallId),
    retry: false,
    refetchInterval: mode === "troubleshoot" && live && selectedCallId ? 7000 : false,
    queryFn: async () => {
      const params = new URLSearchParams({
        call_id: selectedCallId,
        hide_payloads: eventFilters.hidePayloads ? "true" : "false",
        expand_related: "true",
        limit: String(EVENT_LIMIT),
      });

      if (deferredEventSearch.trim()) {
        params.set("q", deferredEventSearch.trim());
      }

      const sinceIso = toIsoFromDateTimeInput(eventFilters.since);
      const untilIso = toIsoFromDateTimeInput(eventFilters.until);
      if (sinceIso) params.set("since", sinceIso);
      if (untilIso) params.set("until", untilIso);

      const levels = buildEventLevelFilters(eventFilters.includeDebug);
      levels?.forEach((level) => params.append("levels", level));

      const categories = buildCategoryFilters(eventFilters.view);
      categories?.forEach((category) => params.append("categories", category));

      return (await api.get(`/api/logs/${encodeURIComponent(selectedContainer)}/events?${params.toString()}`)).data;
    },
  });

  const visibleEvents = useMemo(() => {
    let items = (eventsQuery.data?.events || []).filter((event) => matchesView(event, eventFilters.view));
    if (eventFilters.hideRepeats) {
      items = dedupeRepeatedEvents(items);
    }
    return items;
  }, [eventsQuery.data?.events, eventFilters.hideRepeats, eventFilters.view]);

  useEffect(() => {
    if (!live || !logViewportRef.current) {
      return;
    }
    logViewportRef.current.scrollTop = logViewportRef.current.scrollHeight;
  }, [live, mode, visibleEvents.length, rawLogsQuery.data?.logs]);

  function updateSearchParams(patch) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      Object.entries(patch).forEach(([key, value]) => {
        if (value === null || value === undefined || value === "") {
          next.delete(key);
        } else {
          next.set(key, String(value));
        }
      });
      return next;
    });
  }

  function setMode(nextMode) {
    updateSearchParams({ mode: nextMode });
  }

  function setContainer(name) {
    updateSearchParams({ container: name });
  }

  function setSelectedCall(call) {
    updateSearchParams({
      mode: "troubleshoot",
      call_id: call.call_id,
      business_id: call.business_id || "",
    });
    setShowFinder(false);
  }

  function clearSelectedCall() {
    updateSearchParams({ call_id: null });
    setShowFinder(true);
  }

  async function refreshAll() {
    await Promise.all([
      containersQuery.refetch(),
      healthQuery.refetch(),
      rawLogsQuery.refetch(),
      callSearchQuery.refetch(),
      eventsQuery.refetch(),
    ]);
  }

  function toggleRawLevel(level) {
    setRawLevels((current) => {
      if (current.includes(level)) {
        const next = current.filter((value) => value !== level);
        return next.length ? next : current;
      }
      return [...current, level];
    });
  }

  function exportCurrentView() {
    if (mode === "raw") {
      downloadTextFile(
        rawLogsQuery.data?.logs || "",
        `${selectedContainer}-logs.txt`,
        "text/plain;charset=utf-8",
      );
      return;
    }

    if (!selectedCallId) {
      toast.error("Choose a call first.");
      return;
    }

    downloadTextFile(
      JSON.stringify(
        {
          container: selectedContainer,
          call_id: selectedCallId,
          filters: eventFilters,
          data: eventsQuery.data || {},
        },
        null,
        2,
      ),
      `${selectedCallId}-troubleshoot.json`,
      "application/json;charset=utf-8",
    );
  }

  if ((containersQuery.isLoading || healthQuery.isLoading) && !containersQuery.data) {
    return (
      <AppShell>
        <LoadingBlock label="Loading Logs" />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-8">
        <PageHeader
          eyebrow="Runtime Logs & Call Diagnostics"
          title="Logs"
          description={
            mode === "troubleshoot"
              ? "Find a historical call, pull the exact log window from Docker, and inspect structured events without leaving the admin panel."
              : "Read raw container logs with live refresh, level filters, search, and export."
          }
          actions={
            <>
              <PillButton onClick={() => setLive((current) => !current)}>
                <span className="flex items-center gap-2">
                  {live ? <Pause size={14} /> : <Activity size={14} />}
                  {live ? "Pause" : "Live"}
                </span>
              </PillButton>
              <PillButton onClick={exportCurrentView}>
                <span className="flex items-center gap-2">
                  <Download size={14} />
                  Export
                </span>
              </PillButton>
              <PillButton variant="solid" onClick={refreshAll}>
                <span className="flex items-center gap-2">
                  <RefreshCw
                    size={14}
                    className={
                      containersQuery.isFetching ||
                      healthQuery.isFetching ||
                      rawLogsQuery.isFetching ||
                      callSearchQuery.isFetching ||
                      eventsQuery.isFetching
                        ? "animate-spin"
                        : ""
                    }
                  />
                  Refresh
                </span>
              </PillButton>
            </>
          }
        />

        {rawLogsQuery.error ? (
          <Banner tone="warning">
            {rawLogsQuery.error?.response?.data?.detail || "Selected container logs could not be loaded."}
          </Banner>
        ) : null}

        {eventsQuery.error ? (
          <Banner tone="warning">
            {eventsQuery.error?.response?.data?.detail || "Structured call events could not be loaded."}
          </Banner>
        ) : null}

        <section className="grid gap-4 xl:grid-cols-4">
          <StatCard label="Mode" value={mode === "troubleshoot" ? "Troubleshoot" : "Raw"} />
          <StatCard label="Container" value={selectedContainer} />
          <StatCard label="Live State" value={live ? "Streaming" : "Paused"} />
          <StatCard
            label={mode === "troubleshoot" ? "Events" : "Backend Health"}
            value={
              mode === "troubleshoot"
                ? formatNumber(visibleEvents.length)
                : healthQuery.data
                  ? "Reachable"
                  : "Unknown"
            }
          />
        </section>

        <Card className="rounded-[32px] p-6">
          <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                Containers
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {containerNames.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setContainer(name)}
                    className={cn(
                      "rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-[0.15em] transition-all",
                      selectedContainer === name
                        ? "bg-[#111111] text-white"
                        : "bg-[#f4f4f4] text-[#666666] hover:bg-[#111111]/10",
                    )}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                Mode
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {[
                  { key: "raw", icon: TerminalSquare, label: "Raw" },
                  { key: "troubleshoot", icon: Wrench, label: "Troubleshoot" },
                ].map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setMode(option.key)}
                    className={cn(
                      "flex items-center gap-2 rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-[0.15em] transition-all",
                      mode === option.key
                        ? "bg-[#111111] text-white"
                        : "bg-[#f4f4f4] text-[#666666] hover:bg-[#111111]/10",
                    )}
                  >
                    <option.icon size={14} />
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Card>

        {mode === "raw" ? (
          <section className="grid gap-6 xl:grid-cols-12">
            <Card className="xl:col-span-3 rounded-[32px] p-6">
              <div className="space-y-5">
                <label className="block">
                  <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
                    Tail
                  </span>
                  <input
                    type="number"
                    min="20"
                    max="5000"
                    value={tail}
                    onChange={(event) => setTail(parsePositiveInteger(event.target.value, 300))}
                    className="mt-2 w-full rounded-[20px] border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none focus:border-[#111111]"
                  />
                </label>

                <label className="block">
                  <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
                    Search
                  </span>
                  <div className="mt-2 flex items-center gap-3 rounded-[20px] border border-[#111111]/10 bg-white px-4 py-3">
                    <Search size={14} className="text-[#999999]" />
                    <input
                      type="search"
                      value={rawSearch}
                      onChange={(event) => setRawSearch(event.target.value)}
                      className="w-full bg-transparent text-sm outline-none"
                      placeholder="Filter by message text"
                    />
                  </div>
                </label>

                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
                    Levels
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {RAW_LEVEL_OPTIONS.map((level) => (
                      <button
                        key={level}
                        type="button"
                        onClick={() => toggleRawLevel(level)}
                        className={cn(
                          "rounded-full border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.16em] transition-all",
                          rawLevels.includes(level)
                            ? levelTone(level)
                            : "border-[#111111]/10 bg-white text-[#777777]",
                        )}
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </Card>

            <Card className="xl:col-span-9 rounded-[32px] p-0 overflow-hidden">
              <div className="border-b border-[#111111]/10 px-6 py-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                  Raw Output
                </p>
              </div>
              <div
                ref={logViewportRef}
                className="min-h-[68vh] overflow-auto bg-[#0b1020] p-5 font-mono text-xs leading-6"
                onScroll={(event) => {
                  const target = event.currentTarget;
                  const awayFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
                  setShowJumpToLatest(awayFromBottom > 160);
                }}
              >
                {rawLogsQuery.isLoading && !rawLogsQuery.data ? (
                  <p className="text-white/70">Loading logs...</p>
                ) : rawLogsQuery.data?.logs ? (
                  <AnsiLogBlock text={rawLogsQuery.data.logs} />
                ) : (
                  <p className="text-white/70">No logs returned.</p>
                )}
              </div>
              {showJumpToLatest ? (
                <div className="border-t border-white/10 bg-[#0b1020] px-5 py-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (logViewportRef.current) {
                        logViewportRef.current.scrollTop = logViewportRef.current.scrollHeight;
                        setShowJumpToLatest(false);
                      }
                    }}
                    className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.14em] text-white transition hover:bg-white/20"
                  >
                    <ArrowDown size={14} />
                    Jump to latest
                  </button>
                </div>
              ) : null}
            </Card>
          </section>
        ) : (
          <div className="space-y-6">
            <Card className="rounded-[32px] p-6">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                    Troubleshoot Scope
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {VIEW_OPTIONS.map((view) => (
                      <button
                        key={view.key}
                        type="button"
                        onClick={() => setEventFilters((current) => ({ ...current, view: view.key }))}
                        className={cn(
                          "rounded-full px-4 py-2 text-[11px] font-bold uppercase tracking-[0.14em] transition-all",
                          eventFilters.view === view.key
                            ? "bg-[#111111] text-white"
                            : "bg-[#f4f4f4] text-[#666666] hover:bg-[#111111]/10",
                        )}
                      >
                        {view.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-[#666666]">
                    {VIEW_OPTIONS.find((view) => view.key === eventFilters.view)?.description}
                  </p>
                </div>

                <div className="flex flex-wrap gap-3">
                  <PillButton onClick={() => setShowFinder((current) => !current)}>
                    <span className="flex items-center gap-2">
                      <Phone size={14} />
                      {showFinder ? "Hide Call Finder" : "Find Call"}
                    </span>
                  </PillButton>
                  {selectedCallId ? (
                    <PillButton onClick={clearSelectedCall}>
                      <span className="flex items-center gap-2">
                        <EyeOff size={14} />
                        Clear Call
                      </span>
                    </PillButton>
                  ) : null}
                </div>
              </div>
            </Card>

            {showFinder ? (
              <CallFinder
                filters={callFilters}
                setFilters={setCallFilters}
                appliedFilters={appliedCallFilters}
                setAppliedFilters={setAppliedCallFilters}
                scopedBusinessId={scopedBusinessId}
                filterOptions={callFilterQuery.data}
                isLoading={callSearchQuery.isLoading}
                isFetching={callSearchQuery.isFetching}
                results={callSearchQuery.data?.calls || []}
                onSelectCall={setSelectedCall}
              />
            ) : null}

            {selectedCallId ? (
              <>
                <Card className="rounded-[32px] p-6">
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <SummaryStat
                      label="Call ID"
                      value={eventsQuery.data?.call?.call_id || selectedCallId}
                      icon={Phone}
                    />
                    <SummaryStat
                      label="Outcome"
                      value={eventsQuery.data?.call?.outcome || "Unknown"}
                      icon={AlertTriangle}
                    />
                    <SummaryStat
                      label="Duration"
                      value={formatDuration(eventsQuery.data?.call?.duration_seconds || 0)}
                      icon={Activity}
                    />
                    <SummaryStat
                      label="Issues"
                      value={formatNumber(summarizeIssueCount(eventsQuery.data?.events || []))}
                      icon={Bug}
                    />
                  </div>

                  <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <InfoPanel
                      title="Call"
                      lines={[
                        eventsQuery.data?.call?.caller_number || "Unknown caller",
                        `Business: ${eventsQuery.data?.call?.business_id || 1}`,
                        `Context: ${eventsQuery.data?.call?.context_name || "not set"}`,
                      ]}
                    />
                    <InfoPanel
                      title="Routing"
                      lines={[
                        `Provider: ${eventsQuery.data?.call?.provider_name || "not set"}`,
                        `Trunk: ${eventsQuery.data?.call?.trunk || "not used"}`,
                        `Caller ID: ${eventsQuery.data?.call?.caller_id || "not set"}`,
                      ]}
                    />
                    <InfoPanel
                      title="Outbound"
                      lines={[
                        `Campaign: ${eventsQuery.data?.call?.campaign_id || "not outbound"}`,
                        `Attempt: ${eventsQuery.data?.call?.attempt_id || "not set"}`,
                        eventsQuery.data?.call?.outbound_opener || "No outbound opener",
                      ]}
                    />
                    <InfoPanel
                      title="Window / IDs"
                      lines={[
                        formatDateTime(eventsQuery.data?.window?.since),
                        formatDateTime(eventsQuery.data?.window?.until),
                        ...(eventsQuery.data?.related_ids || []).slice(0, 2),
                      ]}
                    />
                  </div>
                </Card>

                <Card className="rounded-[32px] p-6">
                  <div className="grid gap-4 xl:grid-cols-2">
                    <label className="block">
                      <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
                        Search
                      </span>
                      <div className="mt-2 flex items-center gap-3 rounded-[20px] border border-[#111111]/10 bg-white px-4 py-3">
                        <Search size={14} className="text-[#999999]" />
                        <input
                          type="search"
                          value={eventFilters.search}
                          onChange={(event) =>
                            setEventFilters((current) => ({ ...current, search: event.target.value }))
                          }
                          className="w-full bg-transparent text-sm outline-none"
                          placeholder="Message, call id, or provider signal"
                        />
                      </div>
                    </label>

                    <div className="grid grid-cols-2 gap-4">
                      <DateTimeField
                        label="Since"
                        value={eventFilters.since}
                        onChange={(value) => setEventFilters((current) => ({ ...current, since: value }))}
                      />
                      <DateTimeField
                        label="Until"
                        value={eventFilters.until}
                        onChange={(value) => setEventFilters((current) => ({ ...current, until: value }))}
                      />
                    </div>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    <ToggleChip
                      active={eventFilters.hidePayloads}
                      activeLabel="Payloads Hidden"
                      inactiveLabel="Payloads Visible"
                      onClick={() =>
                        setEventFilters((current) => ({
                          ...current,
                          hidePayloads: !current.hidePayloads,
                        }))
                      }
                      icon={eventFilters.hidePayloads ? EyeOff : Eye}
                    />
                    <ToggleChip
                      active={eventFilters.includeDebug}
                      activeLabel="Debug Included"
                      inactiveLabel="Debug Hidden"
                      onClick={() =>
                        setEventFilters((current) => ({
                          ...current,
                          includeDebug: !current.includeDebug,
                        }))
                      }
                      icon={Bug}
                    />
                    <ToggleChip
                      active={eventFilters.hideRepeats}
                      activeLabel="Repeats Hidden"
                      inactiveLabel="Repeats Visible"
                      onClick={() =>
                        setEventFilters((current) => ({
                          ...current,
                          hideRepeats: !current.hideRepeats,
                        }))
                      }
                      icon={Waves}
                    />
                  </div>
                </Card>

                <Card className="rounded-[32px] p-0 overflow-hidden">
                  <div className="border-b border-[#111111]/10 px-6 py-4">
                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                          Structured Events
                        </p>
                        <p className="mt-1 text-sm text-[#666666]">
                          Showing {formatNumber(visibleEvents.length)} parsed events from{" "}
                          {eventsQuery.data?.name || selectedContainer}.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div
                    ref={logViewportRef}
                    className="max-h-[72vh] overflow-auto px-6 py-5"
                    onScroll={(event) => {
                      const target = event.currentTarget;
                      const awayFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
                      setShowJumpToLatest(awayFromBottom > 160);
                    }}
                  >
                    {eventsQuery.isLoading && !eventsQuery.data ? (
                      <LoadingBlock label="Loading Events" />
                    ) : visibleEvents.length ? (
                      <div className="space-y-3">
                        {visibleEvents.map((event, index) => (
                          <EventCard key={`${event.ts || index}-${event.msg || index}`} event={event} />
                        ))}
                      </div>
                    ) : (
                      <EmptyState
                        title="No Events Matched"
                        description="Try widening the time window, switching the view, or re-enabling debug and repeated events."
                      />
                    )}
                  </div>

                  {showJumpToLatest ? (
                    <div className="border-t border-[#111111]/10 px-6 py-4">
                      <PillButton
                        onClick={() => {
                          if (logViewportRef.current) {
                            logViewportRef.current.scrollTop = logViewportRef.current.scrollHeight;
                            setShowJumpToLatest(false);
                          }
                        }}
                      >
                        <span className="flex items-center gap-2">
                          <ArrowDown size={14} />
                          Jump to latest
                        </span>
                      </PillButton>
                    </div>
                  ) : null}
                </Card>
              </>
            ) : (
              <EmptyState
                title="Find a Call"
                description="Use the call finder to select a historical call, then the page will resolve the matching Docker log window and show structured events."
                actionLabel="Open Finder"
                onAction={() => setShowFinder(true)}
              />
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function CallFinder({
  filters,
  setFilters,
  appliedFilters,
  setAppliedFilters,
  scopedBusinessId,
  filterOptions,
  isLoading,
  isFetching,
  results,
  onSelectCall,
}) {
  return (
    <Card className="rounded-[32px] p-6">
      <div className="mb-6 flex items-center gap-3">
        <Search size={16} />
        <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
          Find a Call
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <FilterField
          label="Business ID"
          type="number"
          disabled={Boolean(scopedBusinessId)}
          value={filters.business_id}
          onChange={(value) => setFilters((current) => ({ ...current, business_id: value }))}
        />
        <FilterField
          label="Caller Number"
          value={filters.caller_number}
          onChange={(value) => setFilters((current) => ({ ...current, caller_number: value }))}
        />
        <FilterField
          label="Caller Name"
          value={filters.caller_name}
          onChange={(value) => setFilters((current) => ({ ...current, caller_name: value }))}
        />
        <SelectField
          label="Provider"
          value={filters.provider_name}
          options={filterOptions?.providers || []}
          onChange={(value) => setFilters((current) => ({ ...current, provider_name: value }))}
        />
        <SelectField
          label="Pipeline"
          value={filters.pipeline_name}
          options={filterOptions?.pipelines || []}
          onChange={(value) => setFilters((current) => ({ ...current, pipeline_name: value }))}
        />
        <SelectField
          label="Context"
          value={filters.context_name}
          options={filterOptions?.contexts || []}
          onChange={(value) => setFilters((current) => ({ ...current, context_name: value }))}
        />
        <SelectField
          label="Outcome"
          value={filters.outcome}
          options={filterOptions?.outcomes || []}
          onChange={(value) => setFilters((current) => ({ ...current, outcome: value }))}
        />
        <DateField
          label="From Date"
          value={filters.start_date}
          onChange={(value) => setFilters((current) => ({ ...current, start_date: value }))}
        />
        <DateField
          label="To Date"
          value={filters.end_date}
          onChange={(value) => setFilters((current) => ({ ...current, end_date: value }))}
        />
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <PillButton variant="solid" onClick={() => setAppliedFilters(filters)}>
          <span className="flex items-center gap-2">
            <Search size={14} />
            Search
          </span>
        </PillButton>
        <PillButton
          onClick={() => {
            const next = {
              ...EMPTY_CALL_FILTERS,
              business_id: scopedBusinessId || "",
            };
            setFilters(next);
            setAppliedFilters(next);
          }}
        >
          Clear
        </PillButton>
        <p className="self-center text-sm text-[#666666]">
          {isFetching ? "Refreshing results..." : `Using ${Object.values(appliedFilters).filter(Boolean).length || 0} active filters.`}
        </p>
      </div>

      <div className="mt-6">
        {isLoading && !results.length ? (
          <LoadingBlock label="Finding Calls" />
        ) : results.length ? (
          <div className="overflow-x-auto rounded-[24px] border border-[#111111]/10">
            <table className="w-full min-w-[900px] text-left">
              <thead className="bg-[#111111] text-white">
                <tr>
                  {["Caller", "Time", "Duration", "Provider / Pipeline", "Outcome", "Actions"].map((label) => (
                    <th key={label} className="px-5 py-4 text-[10px] font-bold uppercase tracking-[0.28em]">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map((call) => (
                  <tr key={call.id} className="border-b border-[#111111]/5 hover:bg-[#111111]/5">
                    <td className="px-5 py-4">
                      <p className="text-sm font-bold">{call.caller_number || "Unknown caller"}</p>
                      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#838282]">
                        {call.caller_name || call.call_id}
                      </p>
                    </td>
                    <td className="px-5 py-4 text-sm text-[#666666]">{formatDateTime(call.start_time)}</td>
                    <td className="px-5 py-4 text-sm font-bold">{formatDuration(call.duration_seconds || 0)}</td>
                    <td className="px-5 py-4 text-sm">
                      <p className="font-bold uppercase">{call.provider_name || "Unknown"}</p>
                      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#838282]">
                        {call.pipeline_name || "No pipeline"}
                      </p>
                    </td>
                    <td className="px-5 py-4">
                      <span className={cn("rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em]", levelTone(String(call.outcome || "").toLowerCase().includes("fail") ? "error" : "info"))}>
                        {call.outcome || "Unknown"}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <PillButton onClick={() => onSelectCall(call)}>
                        <span className="flex items-center gap-2">
                          <Wrench size={14} />
                          Troubleshoot
                        </span>
                      </PillButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No Calls Found"
            description="No call history entries matched these filters yet. Try widening the date range or clearing one of the provider-related filters."
          />
        )}
      </div>
    </Card>
  );
}

function StatCard({ label, value }) {
  return (
    <Card className="rounded-[28px] p-6">
      <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
        {label}
      </p>
      <p className="mt-3 break-all text-lg font-bold">{value || "-"}</p>
    </Card>
  );
}

function SummaryStat({ label, value, icon: Icon }) {
  return (
    <Card className="rounded-[28px] p-5">
      <div className="flex items-center gap-3">
        <div className="rounded-full bg-[#111111] p-2 text-white">
          <Icon size={14} />
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
            {label}
          </p>
          <p className="mt-2 break-all text-lg font-bold">{value || "-"}</p>
        </div>
      </div>
    </Card>
  );
}

function InfoPanel({ title, lines }) {
  const normalized = lines.filter(Boolean);
  return (
    <div className="rounded-[24px] border border-[#111111]/10 bg-[#fbfbfb] p-5">
      <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
        {title}
      </p>
      <div className="mt-3 space-y-2 text-sm text-[#555555]">
        {normalized.length ? normalized.map((line) => <p key={line}>{line}</p>) : <p>None</p>}
      </div>
    </div>
  );
}

function ToggleChip({ active, activeLabel, inactiveLabel, onClick, icon: Icon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-full border px-4 py-2 text-[11px] font-bold uppercase tracking-[0.14em] transition-all",
        active
          ? "border-[#111111] bg-[#111111] text-white"
          : "border-[#111111]/10 bg-white text-[#666666] hover:border-[#111111]/30",
      )}
    >
      <Icon size={14} />
      {active ? activeLabel : inactiveLabel}
    </button>
  );
}

function FilterField({ label, value, onChange, type = "text", disabled = false }) {
  return (
    <label className="block">
      <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]">
        {label}
      </span>
      <input
        type={type}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-[20px] border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none focus:border-[#111111] disabled:bg-[#f4f4f4]"
      />
    </label>
  );
}

function SelectField({ label, value, options, onChange }) {
  return (
    <label className="block">
      <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-[20px] border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none focus:border-[#111111]"
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
    <label className="block">
      <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]">
        {label}
      </span>
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-[20px] border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none focus:border-[#111111]"
      />
    </label>
  );
}

function DateTimeField({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]">
        {label}
      </span>
      <input
        type="datetime-local"
        value={toDateTimeInputValue(value) || value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-[20px] border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none focus:border-[#111111]"
      />
    </label>
  );
}

function EventCard({ event }) {
  const metaEntries = Object.entries(event.meta || {}).filter(([, value]) => value !== undefined && value !== null && value !== "");
  const contextEntries = Object.entries(event.context || {}).filter(([, value]) => value !== undefined && value !== null && value !== "");

  return (
    <div className="rounded-[24px] border border-[#111111]/10 bg-white p-5">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em]", levelTone(event.level))}>
              {event.level || "info"}
            </span>
            <span className={cn("rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em]", categoryTone(event.category))}>
              {event.category || "general"}
            </span>
            {event.milestone ? (
              <span className="rounded-full bg-[#111111]/5 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#555555]">
                {event.milestone}
              </span>
            ) : null}
          </div>
          <p className="text-sm font-semibold leading-6 text-[#111111]">
            {event.msg || "No message text"}
          </p>
          <div className="flex flex-wrap gap-4 text-xs text-[#666666]">
            <span>{formatDateTime(event.ts)}</span>
            {event.component ? <span>Component: {event.component}</span> : null}
            {event.provider ? <span>Provider: {event.provider}</span> : null}
            {event.pipeline ? <span>Pipeline: {event.pipeline}</span> : null}
            {event.call_id ? <span>Call ID: {event.call_id}</span> : null}
          </div>
        </div>
      </div>

      {metaEntries.length ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {metaEntries.map(([key, value]) => (
            <span
              key={`${key}-${String(value)}`}
              className="rounded-full bg-[#f4f4f4] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#555555]"
            >
              {key}: {String(value)}
            </span>
          ))}
        </div>
      ) : null}

      {contextEntries.length ? (
        <div className="mt-4 rounded-[20px] bg-[#fafafa] p-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]">
            Context
          </p>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {contextEntries.map(([key, value]) => (
              <div key={`${key}-${String(value)}`} className="text-sm text-[#555555]">
                <span className="font-bold text-[#111111]">{key}:</span> {String(value)}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AnsiLogBlock({ text }) {
  return (
    <div>
      {text.split("\n").map((line, index) => (
        <div key={`${index}-${line.slice(0, 24)}`} className="whitespace-pre-wrap break-words">
          {parseAnsiLine(line).map((segment, segmentIndex) => (
            <span key={`${segmentIndex}-${segment.text.slice(0, 12)}`} style={segment.style}>
              {segment.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
