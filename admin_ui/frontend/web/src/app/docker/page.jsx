import { useQueries } from "@tanstack/react-query";
import { Play, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { Card, PillButton } from "@/components/ui/core";
import { Banner, LoadingBlock, PageHeader } from "@/components/ui/shell";
import { api } from "@/lib/api";

export default function DockerPage() {
  const [containersQuery, usageQuery] = useQueries({
    queries: [
      {
        queryKey: ["docker-containers"],
        queryFn: async () => (await api.get("/api/system/containers")).data,
      },
      {
        queryKey: ["docker-disk-usage"],
        queryFn: async () => (await api.get("/api/system/docker/disk-usage")).data,
      },
    ],
  });

  async function refreshAll() {
    await Promise.all([containersQuery.refetch(), usageQuery.refetch()]);
  }

  async function restartContainer(name) {
    try {
      await api.post(`/api/system/containers/${name}/restart`);
      toast.success(`${name} restart requested.`);
      refreshAll();
    } catch (err) {
      toast.error(err?.response?.data?.detail || `Failed to restart ${name}.`);
    }
  }

  async function startContainer(name) {
    try {
      await api.post(`/api/system/containers/${name}/start`);
      toast.success(`${name} start requested.`);
      refreshAll();
    } catch (err) {
      toast.error(err?.response?.data?.detail || `Failed to start ${name}.`);
    }
  }

  async function prune(kind) {
    try {
      await api.post("/api/system/docker/prune", {
        prune_build_cache: kind === "build_cache",
        prune_images: kind === "images",
        prune_containers: kind === "containers",
        prune_volumes: kind === "volumes",
      });
      toast.success("Docker cleanup completed.");
      refreshAll();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Docker cleanup failed.");
    }
  }

  if (containersQuery.isLoading || usageQuery.isLoading) {
    return (
      <AppShell>
        <LoadingBlock label="Loading Docker Services" />
      </AppShell>
    );
  }

  const usage = usageQuery.data || {};
  const containers = containersQuery.data || [];

  return (
    <AppShell>
      <div className="space-y-8">
        <PageHeader
          eyebrow="Container Operations"
          title="Docker Services"
          description="Inspect running containers, available mounts and ports, plus reclaim Docker storage directly from the Admin UI backend."
          actions={
            <PillButton onClick={refreshAll}>
              <span className="flex items-center gap-2">
                <RefreshCw size={14} className={containersQuery.isFetching || usageQuery.isFetching ? "animate-spin" : ""} />
                Refresh
              </span>
            </PillButton>
          }
        />

        {containersQuery.error ? (
          <Banner tone="warning">
            Docker access failed. This usually means the Admin UI container cannot
            reach the Docker daemon or the mounted socket permissions do not match
            the runtime user.
          </Banner>
        ) : null}

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Object.entries(usage).map(([key, value]) => (
            <Card key={key} className="rounded-[28px] p-6">
              <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
                {key.replaceAll("_", " ")}
              </p>
              <p className="mt-3 text-2xl font-bold">{value.size || "0B"}</p>
              <p className="mt-1 text-sm text-[#666666]">
                Active {value.active || 0} • Total {value.total || 0}
              </p>
              <div className="mt-4">
                <PillButton onClick={() => prune(key)}>Cleanup</PillButton>
              </div>
            </Card>
          ))}
        </section>

        <div className="grid gap-6">
          {containers.map((container) => (
            <Card key={container.id} className="rounded-[32px] p-8">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
                    Container
                  </p>
                  <h3 className="mt-3 font-clash-display text-3xl font-bold uppercase">
                    {container.name}
                  </h3>
                  <p className="mt-2 text-sm text-[#666666]">{container.image}</p>
                  <p className="mt-1 text-sm text-[#666666]">
                    Status {container.status} • Uptime {container.uptime || "—"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <PillButton onClick={() => startContainer(container.name)}>
                    <span className="flex items-center gap-2">
                      <Play size={14} />
                      Start
                    </span>
                  </PillButton>
                  <PillButton variant="solid" onClick={() => restartContainer(container.name)}>
                    <span className="flex items-center gap-2">
                      <RotateCcw size={14} />
                      Restart
                    </span>
                  </PillButton>
                </div>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <pre className="overflow-x-auto rounded-[24px] bg-[#111111]/5 p-4 text-xs text-[#555555]">
                  Ports: {JSON.stringify(container.ports || [], null, 2)}
                </pre>
                <pre className="overflow-x-auto rounded-[24px] bg-[#111111]/5 p-4 text-xs text-[#555555]">
                  Mounts: {JSON.stringify(container.mounts || [], null, 2)}
                </pre>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
