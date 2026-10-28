import { useEffect, useState } from "react";
import { ArrowUpCircle, Play, RefreshCw } from "lucide-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { Card, PillButton } from "@/components/ui/core";
import { LoadingBlock, PageHeader } from "@/components/ui/shell";
import { api } from "@/lib/api";

export default function UpdatesPage() {
  const [targetMode, setTargetMode] = useState("stable");
  const [selectedBranch, setSelectedBranch] = useState("main");
  const [includeUI, setIncludeUI] = useState(false);
  const [jobId, setJobId] = useState(null);

  const [statusQuery, branchesQuery, historyQuery] = useQueries({
    queries: [
      {
        queryKey: ["updates-status"],
        queryFn: async () =>
          (
            await api.get("/api/system/updates/status?check_remote=true&build_updater=true")
          ).data,
      },
      {
        queryKey: ["updates-branches"],
        queryFn: async () =>
          (await api.get("/api/system/updates/branches?build_updater=true")).data,
      },
      {
        queryKey: ["updates-history"],
        queryFn: async () => (await api.get("/api/system/updates/history")).data,
      },
    ],
  });

  const targetRef =
    targetMode === "stable"
      ? statusQuery.data?.remote?.latest_tag || "main"
      : targetMode === "main"
        ? "main"
        : selectedBranch;

  const planQuery = useQuery({
    queryKey: ["updates-plan", targetRef, includeUI, targetMode],
    enabled: Boolean(targetRef),
    queryFn: async () =>
      (
        await api.get(
          `/api/system/updates/plan?ref=${encodeURIComponent(targetRef)}&include_ui=${includeUI}&checkout=${targetMode !== "stable"}`,
        )
      ).data?.plan,
  });

  const jobQuery = useQuery({
    queryKey: ["update-job", jobId],
    enabled: Boolean(jobId),
    queryFn: async () => (await api.get(`/api/system/updates/jobs/${jobId}`)).data,
    refetchInterval: jobId ? 3000 : false,
  });

  useEffect(() => {
    if (branchesQuery.data?.branches?.length && !selectedBranch) {
      setSelectedBranch(branchesQuery.data.branches[0]);
    }
  }, [branchesQuery.data, selectedBranch]);

  async function runUpdate() {
    try {
      const response = await api.post("/api/system/updates/run", {
        include_ui: includeUI,
        ref: targetRef,
        checkout: targetMode !== "stable",
        update_cli_host: true,
      });
      setJobId(response.data?.job_id);
      toast.success("Update job started.");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to start update job.");
    }
  }

  async function rollback(job) {
    try {
      const response = await api.post("/api/system/updates/rollback", {
        from_job_id: job.job_id,
      });
      setJobId(response.data?.job_id);
      toast.success("Rollback job started.");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to start rollback.");
    }
  }

  if (statusQuery.isLoading || branchesQuery.isLoading || historyQuery.isLoading) {
    return (
      <AppShell>
        <LoadingBlock label="Loading Updates" />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-8">
        <PageHeader
          eyebrow="Git & Deployment Flow"
          title="Updates"
          description="Check local versus remote versions, preview the updater plan, start an update job, and inspect recent runs without leaving the Admin UI."
          actions={
            <PillButton
              onClick={() => {
                statusQuery.refetch();
                branchesQuery.refetch();
                planQuery.refetch();
                historyQuery.refetch();
              }}
            >
              <span className="flex items-center gap-2">
                <RefreshCw size={14} className={statusQuery.isFetching ? "animate-spin" : ""} />
                Check Updates
              </span>
            </PillButton>
          }
        />

        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
          <Stat label="Local Branch" value={statusQuery.data?.local?.branch || "unknown"} />
          <Stat label="Local Tag" value={statusQuery.data?.local?.deployed_tag || statusQuery.data?.local?.describe || "unknown"} />
          <Stat label="Latest Remote Tag" value={statusQuery.data?.remote?.latest_tag || "unknown"} />
          <Stat
            label="Update Available"
            value={
              statusQuery.data?.update_available === true
                ? "Yes"
                : statusQuery.data?.update_available === false
                  ? "No"
                  : "Unknown"
            }
          />
        </div>

        <Card className="rounded-[32px] p-8">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <SelectField
              label="Target Mode"
              value={targetMode}
              options={[
                ["stable", "Stable release"],
                ["main", "Main"],
                ["advanced", "Advanced branch"],
              ]}
              onChange={setTargetMode}
            />
            {targetMode === "advanced" ? (
              <SelectField
                label="Branch"
                value={selectedBranch}
                options={(branchesQuery.data?.branches || []).map((branch) => [branch, branch])}
                onChange={setSelectedBranch}
              />
            ) : null}
            <label className="flex items-center justify-between rounded-[24px] border border-[#111111]/10 bg-white px-4 py-3">
              <span className="text-sm font-bold">Update UI Too</span>
              <input
                type="checkbox"
                checked={includeUI}
                onChange={(event) => setIncludeUI(event.target.checked)}
                className="accent-[#111111]"
              />
            </label>
          </div>
        </Card>

        <Card className="rounded-[32px] p-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                Update Plan
              </p>
              <p className="mt-2 text-sm text-[#666666]">Target ref: {targetRef}</p>
            </div>
            <PillButton variant="solid" onClick={runUpdate}>
              <span className="flex items-center gap-2">
                <Play size={14} />
                Proceed
              </span>
            </PillButton>
          </div>
          <pre className="mt-6 overflow-x-auto rounded-[24px] bg-[#111111]/5 p-4 text-xs text-[#555555]">
            {JSON.stringify(planQuery.data || {}, null, 2)}
          </pre>
        </Card>

        {jobId ? (
          <Card className="rounded-[32px] p-8">
            <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
              Active Job
            </p>
            <p className="mt-3 text-sm font-bold">{jobId}</p>
            <pre className="mt-6 overflow-x-auto rounded-[24px] bg-[#111111]/5 p-4 text-xs text-[#555555]">
              {JSON.stringify(jobQuery.data || {}, null, 2)}
            </pre>
          </Card>
        ) : null}

        <Card className="rounded-[32px] p-0">
          <div className="border-b border-[#111111]/10 px-6 py-5">
            <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
              Recent Runs
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left">
              <thead>
                <tr>
                  {["When", "Branch", "Result", "UI", "Files", "Actions"].map((header) => (
                    <th
                      key={header}
                      className="px-6 py-4 text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(historyQuery.data?.jobs || []).map((job) => (
                  <tr key={job.job_id} className="border-t border-[#111111]/5">
                    <td className="px-6 py-4 text-sm">{job.started_at || job.created_at || "—"}</td>
                    <td className="px-6 py-4 text-sm">{job.ref || job.target_branch || "—"}</td>
                    <td className="px-6 py-4 text-sm">{job.status || job.result || "—"}</td>
                    <td className="px-6 py-4 text-sm">{job.include_ui ? "Yes" : "No"}</td>
                    <td className="px-6 py-4 text-sm">{job.changed_file_count || 0}</td>
                    <td className="px-6 py-4">
                      <div className="flex gap-2">
                        <PillButton onClick={() => setJobId(job.job_id)}>Open</PillButton>
                        {(job.status || "").toLowerCase().includes("fail") ? (
                          <PillButton onClick={() => rollback(job)}>
                            <span className="flex items-center gap-2">
                              <ArrowUpCircle size={14} />
                              Rollback
                            </span>
                          </PillButton>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </AppShell>
  );
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

function SelectField({ label, value, options, onChange }) {
  return (
    <label className="space-y-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
