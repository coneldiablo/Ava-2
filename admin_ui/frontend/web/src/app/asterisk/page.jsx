import { useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { Card, PillButton } from "@/components/ui/core";
import { Banner, LoadingBlock, PageHeader } from "@/components/ui/shell";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/formatters";

export default function AsteriskPage() {
  const statusQuery = useQuery({
    queryKey: ["asterisk-status"],
    queryFn: async () => (await api.get("/api/system/asterisk-status")).data,
  });

  async function runPreflight() {
    try {
      await api.post("/api/system/preflight");
      toast.success("Preflight started.");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to run preflight.");
    }
  }

  if (statusQuery.isLoading) {
    return (
      <AppShell>
        <LoadingBlock label="Loading Asterisk Status" />
      </AppShell>
    );
  }

  const live = statusQuery.data?.live || {};
  const manifest = statusQuery.data?.manifest;

  return (
    <AppShell>
      <div className="space-y-8">
        <PageHeader
          eyebrow="Live Integration Checks"
          title="Asterisk"
          description="See the current ARI connection state, required module presence, application registration, and the last preflight manifest available to the Admin UI."
          actions={
            <>
              <PillButton onClick={() => statusQuery.refetch()}>
                <span className="flex items-center gap-2">
                  <RefreshCw size={14} className={statusQuery.isFetching ? "animate-spin" : ""} />
                  Refresh
                </span>
              </PillButton>
              <PillButton variant="solid" onClick={runPreflight}>
                <span className="flex items-center gap-2">
                  <Activity size={14} />
                  Run Preflight
                </span>
              </PillButton>
            </>
          }
        />

        <div className="grid gap-6 xl:grid-cols-12">
          <Card className="xl:col-span-7 rounded-[32px] p-8">
            <div className="grid gap-4 md:grid-cols-2">
              <Stat label="Mode" value={statusQuery.data?.mode || "unknown"} />
              <Stat label="ARI Reachable" value={live.ari_reachable ? "Yes" : "No"} />
              <Stat label="Version" value={live.asterisk_version || live.ari_version || "—"} />
              <Stat label="App Registered" value={live.app_registered ? "Yes" : "No"} />
              <Stat label="Startup Time" value={formatDateTime(live.uptime)} />
              <Stat label="Last Reload" value={formatDateTime(live.last_reload)} />
            </div>

            <div className="mt-8 space-y-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                Required Modules
              </p>
              {Object.entries(live.modules || {}).map(([module, state]) => (
                <div
                  key={module}
                  className="flex items-center justify-between rounded-[24px] border border-[#111111]/10 px-5 py-4"
                >
                  <span className="text-sm font-bold">{module}</span>
                  <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#666666]">
                    {state}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <div className="space-y-6 xl:col-span-5">
            {manifest ? (
              <Card className="rounded-[32px] p-8">
                <div className="flex items-center gap-3">
                  <ShieldCheck size={18} />
                  <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                    Preflight Manifest
                  </p>
                </div>
                <pre className="mt-6 overflow-x-auto rounded-[24px] bg-[#111111]/5 p-4 text-xs text-[#555555]">
                  {JSON.stringify(manifest, null, 2)}
                </pre>
              </Card>
            ) : (
              <Banner tone="warning">
                No Asterisk preflight manifest was found yet. Run `./preflight.sh`
                on the host or use the button above to generate a fresh readiness
                snapshot.
              </Banner>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-[24px] border border-[#111111]/10 bg-white px-4 py-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
        {label}
      </p>
      <p className="mt-2 text-sm font-bold">{value || "—"}</p>
    </div>
  );
}
