import { useMemo, useState } from "react";
import { Download, Play, RefreshCw, Trash2 } from "lucide-react";
import { useQueries } from "@tanstack/react-query";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { Card, PillButton } from "@/components/ui/core";
import { LoadingBlock, PageHeader } from "@/components/ui/shell";
import { api } from "@/lib/api";
import { formatBytes } from "@/lib/formatters";

const TABS = ["installed", "stt", "tts", "llm"];

export default function ModelsPage() {
  const [tab, setTab] = useState("installed");

  const [catalogQuery, installedQuery, statusQuery] = useQueries({
    queries: [
      {
        queryKey: ["model-catalog"],
        queryFn: async () => (await api.get("/api/wizard/local/available-models")).data,
      },
      {
        queryKey: ["installed-models"],
        queryFn: async () => (await api.get("/api/local-ai/models")).data,
      },
      {
        queryKey: ["local-ai-status"],
        queryFn: async () => (await api.get("/api/local-ai/status")).data,
      },
    ],
  });

  async function refreshAll() {
    await Promise.all([
      catalogQuery.refetch(),
      installedQuery.refetch(),
      statusQuery.refetch(),
    ]);
  }

  async function startServer() {
    try {
      await api.post("/api/wizard/local/start-server");
      toast.success("Local AI Server start requested.");
      refreshAll();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to start Local AI Server.");
    }
  }

  async function downloadModel(type, model) {
    try {
      await api.post("/api/wizard/local/download-model", {
        model_id: model.id,
        type,
        download_url: model.download_url,
        model_path: model.model_path,
        config_url: model.config_url,
        voice_files: model.voice_files,
      });
      toast.success(`Download started for ${model.name}.`);
      refreshAll();
    } catch (err) {
      toast.error(err?.response?.data?.detail || `Failed to download ${model.name}.`);
    }
  }

  async function deleteInstalled(type, model) {
    if (!window.confirm(`Delete installed model "${model.name}"?`)) {
      return;
    }
    try {
      await api.delete("/api/local-ai/models", {
        data: {
          model_path: model.path,
          type,
        },
      });
      toast.success(`Deleted ${model.name}.`);
      refreshAll();
    } catch (err) {
      toast.error(err?.response?.data?.detail || `Failed to delete ${model.name}.`);
    }
  }

  if (catalogQuery.isLoading || installedQuery.isLoading || statusQuery.isLoading) {
    return (
      <AppShell>
        <LoadingBlock label="Loading Models" />
      </AppShell>
    );
  }

  const installedByType = normalizeInstalled(installedQuery.data || {});
  const catalog = catalogQuery.data?.catalog || { stt: [], tts: [], llm: [] };
  const visibleItems =
    tab === "installed"
      ? installedByType.flat
      : catalog[tab] || [];

  return (
    <AppShell>
      <div className="space-y-8">
        <PageHeader
          eyebrow="Local AI Runtime & Library"
          title="Models"
          description="See Local AI connectivity, inspect installed models, and start downloads from the backend catalog."
          actions={
            <>
              <PillButton onClick={refreshAll}>
                <span className="flex items-center gap-2">
                  <RefreshCw size={14} className={catalogQuery.isFetching || installedQuery.isFetching || statusQuery.isFetching ? "animate-spin" : ""} />
                  Refresh
                </span>
              </PillButton>
              <PillButton variant="solid" onClick={startServer}>
                <span className="flex items-center gap-2">
                  <Play size={14} />
                  Start Local AI Server
                </span>
              </PillButton>
            </>
          }
        />

        <div className="grid gap-6 md:grid-cols-3">
          <Stat label="Connected" value={statusQuery.data?.connected ? "Yes" : "No"} />
          <Stat label="STT Backend" value={statusQuery.data?.stt_backend || "—"} />
          <Stat label="TTS Backend" value={statusQuery.data?.tts_backend || "—"} />
        </div>

        <div className="flex flex-wrap gap-2 border-b border-[#111111]/10 pb-4">
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={`rounded-full px-5 py-3 text-[10px] font-bold uppercase tracking-[0.25em] transition-all ${tab === item ? "bg-[#111111] text-white" : "bg-white text-[#666666] hover:bg-[#111111]/5"}`}
            >
              {item}
            </button>
          ))}
        </div>

        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {visibleItems.map((item) => (
            <Card key={`${tab}-${item.name}`} className="rounded-[32px] p-8">
              <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
                {tab === "installed" ? item.type : tab}
              </p>
              <h3 className="mt-3 font-clash-display text-3xl font-bold uppercase">
                {item.name}
              </h3>
              <p className="mt-2 text-sm text-[#666666]">
                {item.description || item.path || item.backend || "Model entry"}
              </p>
              <p className="mt-2 text-sm text-[#666666]">
                {item.size_display || formatBytes((item.size_mb || 0) * 1024 * 1024)}
              </p>
              <pre className="mt-6 overflow-x-auto rounded-[24px] bg-[#111111]/5 p-4 text-xs text-[#555555]">
                {JSON.stringify(item, null, 2)}
              </pre>
              <div className="mt-6">
                {tab === "installed" ? (
                  <PillButton onClick={() => deleteInstalled(item.type, item)}>
                    <span className="flex items-center gap-2">
                      <Trash2 size={14} />
                      Delete
                    </span>
                  </PillButton>
                ) : (
                  <PillButton variant="solid" onClick={() => downloadModel(tab, item)}>
                    <span className="flex items-center gap-2">
                      <Download size={14} />
                      Download
                    </span>
                  </PillButton>
                )}
              </div>
            </Card>
          ))}
        </div>
      </div>
    </AppShell>
  );
}

function normalizeInstalled(data) {
  const flat = [];
  ["stt", "tts"].forEach((type) => {
    Object.entries(data[type] || {}).forEach(([backend, items]) => {
      (items || []).forEach((item) => {
        flat.push({ ...item, type, backend });
      });
    });
  });
  (data.llm || []).forEach((item) => flat.push({ ...item, type: "llm" }));
  return { flat };
}

function Stat({ label, value }) {
  return (
    <Card className="rounded-[28px] p-6">
      <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
        {label}
      </p>
      <p className="mt-3 text-2xl font-bold">{value}</p>
    </Card>
  );
}
