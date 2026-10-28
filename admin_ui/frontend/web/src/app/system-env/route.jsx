import { useMemo, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { useQueries } from "@tanstack/react-query";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { Card, PillButton } from "@/components/ui/core";
import { Banner, LoadingBlock, PageHeader } from "@/components/ui/shell";
import { api } from "@/lib/api";

const SENSITIVE_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|JWT)/i;

export default function EnvironmentPage() {
  const [draft, setDraft] = useState(null);

  const [envQuery, statusQuery] = useQueries({
    queries: [
      {
        queryKey: ["config-env"],
        queryFn: async () => (await api.get("/api/config/env")).data,
      },
      {
        queryKey: ["config-env-status"],
        queryFn: async () => (await api.get("/api/config/env/status")).data,
        retry: false,
      },
    ],
  });

  const envMap = envQuery.data || {};
  const status = statusQuery.data || {};

  const envText = useMemo(() => JSON.stringify(envMap, null, 2), [envMap]);
  const currentText = draft ?? envText;

  async function refreshAll() {
    setDraft(null);
    await Promise.all([envQuery.refetch(), statusQuery.refetch()]);
  }

  async function saveEnv() {
    try {
      const parsed = JSON.parse(currentText || "{}");
      await api.post("/api/config/env", parsed);
      toast.success("Environment saved.");
      setDraft(null);
      await refreshAll();
    } catch (err) {
      toast.error(err?.response?.data?.detail || err?.message || "Failed to save environment.");
    }
  }

  async function applyService(plan) {
    try {
      const recreate = plan.method === "recreate" ? "?force=false&recreate=true" : "?force=false";
      await api.post(`${plan.endpoint}${recreate}`);
      toast.success(`${plan.service} restart requested.`);
      await statusQuery.refetch();
    } catch (err) {
      toast.error(err?.response?.data?.detail || `Failed to apply ${plan.service}.`);
    }
  }

  if (envQuery.isLoading || statusQuery.isLoading) {
    return (
      <AppShell>
        <LoadingBlock label="Loading Environment" />
      </AppShell>
    );
  }

  const applyPlan = status.apply_plan || [];
  const changedKeys = Object.values(status.drift || {}).flat();

  return (
    <AppShell>
      <div className="space-y-8">
        <PageHeader
          eyebrow="Runtime Environment"
          title="Environment"
          description="Edit the project .env values through the backend config API and apply service restarts when Docker environments are out of sync."
          actions={
            <>
              <PillButton onClick={refreshAll}>
                <span className="flex items-center gap-2">
                  <RefreshCw size={14} className={envQuery.isFetching || statusQuery.isFetching ? "animate-spin" : ""} />
                  Refresh
                </span>
              </PillButton>
              <PillButton variant="solid" onClick={saveEnv}>
                <span className="flex items-center gap-2">
                  <Save size={14} />
                  Save
                </span>
              </PillButton>
            </>
          }
        />

        {status.pending_restart ? (
          <Banner
            tone="warning"
            action={
              <div className="flex flex-wrap gap-2">
                {applyPlan.map((plan) => (
                  <PillButton key={`${plan.service}-${plan.method}`} onClick={() => applyService(plan)}>
                    Apply {plan.service}
                  </PillButton>
                ))}
              </div>
            }
          >
            Environment changes are saved, but running containers still need to be restarted or recreated.
          </Banner>
        ) : (
          <Banner tone="success">Running containers match the saved environment.</Banner>
        )}

        <section className="grid gap-6 xl:grid-cols-12">
          <Card className="xl:col-span-8 rounded-[32px] p-8">
            <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
              .env JSON Editor
            </p>
            <textarea
              value={currentText}
              onChange={(event) => setDraft(event.target.value)}
              rows={36}
              spellCheck={false}
              className="mt-6 min-h-[70vh] w-full border border-[#111111]/10 bg-white px-4 py-3 font-mono text-xs outline-none transition-all focus:border-[#111111]"
            />
          </Card>

          <div className="space-y-6 xl:col-span-4">
            <Card className="rounded-[32px] p-8">
              <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                Sync Status
              </p>
              <p className="mt-4 text-3xl font-bold uppercase">
                {status.pending_restart ? "Restart Needed" : "In Sync"}
              </p>
              <p className="mt-2 text-sm text-[#666666]">
                {changedKeys.length ? changedKeys.join(", ") : "No drift detected."}
              </p>
            </Card>

            <Card className="rounded-[32px] p-8">
              <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                Current Keys
              </p>
              <div className="mt-6 max-h-[58vh] space-y-3 overflow-y-auto pr-1">
                {Object.entries(envMap).map(([key, value]) => (
                  <div key={key} className="rounded-[20px] border border-[#111111]/10 px-4 py-3">
                    <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#838282]">
                      {key}
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-[#555555]">
                      {SENSITIVE_PATTERN.test(key) ? "********" : String(value || "")}
                    </p>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
