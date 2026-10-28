import { useMemo, useState } from "react";
import { Boxes, Plus, RefreshCw, Settings, Trash2, Zap } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { JsonObjectModal } from "@/components/config/JsonObjectModal";
import { Card, PillButton } from "@/components/ui/core";
import { Banner, EmptyState, LoadingBlock, PageHeader } from "@/components/ui/shell";
import { useConfigDocument } from "@/hooks/useConfigDocument";
import { api } from "@/lib/api";

export default function MCPPage() {
  const { config, isLoading, save } = useConfigDocument();
  const [modalState, setModalState] = useState({ open: false, name: "", value: {}, lockName: false });

  const statusQuery = useQuery({
    queryKey: ["mcp-status"],
    queryFn: async () => (await api.get("/api/mcp/status")).data,
    retry: false,
  });

  const servers = useMemo(
    () => Object.entries(config?.mcp?.servers || {}).map(([name, value]) => ({ name, value })),
    [config],
  );

  async function persist(nextConfig, message) {
    await save(nextConfig, message);
  }

  async function saveServer(name, value) {
    const nextConfig = structuredClone(config || {});
    nextConfig.mcp = nextConfig.mcp || {};
    nextConfig.mcp.servers = nextConfig.mcp.servers || {};
    nextConfig.mcp.servers[name] = value;
    await persist(nextConfig, `MCP server ${name} saved.`);
    setModalState({ open: false, name: "", value: {}, lockName: false });
  }

  async function deleteServer(name) {
    if (!window.confirm(`Delete MCP server "${name}"?`)) {
      return;
    }
    const nextConfig = structuredClone(config || {});
    delete nextConfig.mcp?.servers?.[name];
    await persist(nextConfig, `MCP server ${name} deleted.`);
  }

  async function toggleGlobal() {
    const nextConfig = structuredClone(config || {});
    nextConfig.mcp = nextConfig.mcp || {};
    nextConfig.mcp.enabled = !nextConfig.mcp.enabled;
    await persist(nextConfig, "MCP global setting updated.");
  }

  async function testServer(name) {
    try {
      const response = await api.post(`/api/mcp/servers/${name}/test`);
      toast.success(response.data?.message || `MCP server ${name} test completed.`);
      statusQuery.refetch();
    } catch (err) {
      toast.error(err?.response?.data?.detail || `MCP server ${name} test failed.`);
    }
  }

  if (isLoading || !config) {
    return (
      <AppShell>
        <LoadingBlock label="Loading MCP" />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-8">
        <PageHeader
          eyebrow="MCP Tool Servers"
          title="MCP"
          description="Manage MCP-backed tool servers through the same YAML config the backend loads, and test their runtime reachability through the proxied API."
          actions={
            <>
              <PillButton onClick={() => statusQuery.refetch()}>
                <span className="flex items-center gap-2">
                  <RefreshCw size={14} className={statusQuery.isFetching ? "animate-spin" : ""} />
                  Refresh Status
                </span>
              </PillButton>
              <PillButton variant="solid" onClick={() => setModalState({ open: true, name: "", value: { transport: "stdio", command: [] }, lockName: false })}>
                <span className="flex items-center gap-2">
                  <Plus size={14} />
                  Add Server
                </span>
              </PillButton>
            </>
          }
        />

        <Banner tone="warning" action={<PillButton onClick={toggleGlobal}>{config.mcp?.enabled ? "Disable MCP" : "Enable MCP"}</PillButton>}>
          MCP reloads are controlled by the AI Engine. This screen edits the config, shows current proxy status, and lets you run a direct test against the selected server.
        </Banner>

        <Card className="rounded-[28px] p-6">
          <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
            Global MCP
          </p>
          <div className="mt-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-bold">Enabled: {config.mcp?.enabled ? "Yes" : "No"}</p>
              <p className="mt-1 text-sm text-[#666666]">
                Runtime status: {statusQuery.data ? "Connected" : statusQuery.error ? "Unavailable" : "Unknown"}
              </p>
            </div>
            <PillButton variant="solid" onClick={toggleGlobal}>
              {config.mcp?.enabled ? "Disable" : "Enable"}
            </PillButton>
          </div>
        </Card>

        {servers.length ? (
          <div className="grid gap-6 md:grid-cols-2">
            {servers.map((server) => (
              <Card key={server.name} className="rounded-[32px] p-8">
                <div className="mb-6 flex items-start justify-between gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#111111] text-white">
                    <Boxes size={20} />
                  </div>
                  <span className="rounded-full bg-[#111111]/5 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#666666]">
                    {server.value?.transport || "stdio"}
                  </span>
                </div>
                <h3 className="font-clash-display text-3xl font-bold uppercase">
                  {server.name}
                </h3>
                <pre className="mt-6 overflow-x-auto rounded-[24px] bg-[#111111]/5 p-4 text-xs text-[#555555]">
                  {JSON.stringify(server.value, null, 2)}
                </pre>
                <div className="mt-6 grid grid-cols-3 gap-2">
                  <ActionButton onClick={() => testServer(server.name)}>
                    <Zap size={14} />
                    Test
                  </ActionButton>
                  <ActionButton
                    onClick={() =>
                      setModalState({
                        open: true,
                        name: server.name,
                        value: server.value,
                        lockName: true,
                      })
                    }
                  >
                    <Settings size={14} />
                    Edit
                  </ActionButton>
                  <ActionButton
                    onClick={() => deleteServer(server.name)}
                    className="hover:bg-red-500 hover:text-white"
                  >
                    <Trash2 size={14} />
                    Delete
                  </ActionButton>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No MCP Servers Configured"
            description="Add an MCP server object to expose external tools through the AI Engine."
            actionLabel="Add Server"
            onAction={() => setModalState({ open: true, name: "", value: { transport: "stdio", command: [] }, lockName: false })}
          />
        )}
      </div>

      <JsonObjectModal
        isOpen={modalState.open}
        onClose={() => setModalState({ open: false, name: "", value: {}, lockName: false })}
        title={modalState.lockName ? "Edit MCP Server" : "Add MCP Server"}
        initialName={modalState.name}
        initialValue={modalState.value}
        lockName={modalState.lockName}
        onSave={saveServer}
      />
    </AppShell>
  );
}

function ActionButton({ children, onClick, className = "" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-center gap-2 rounded-full border border-[#111111]/10 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.18em] transition-all hover:bg-[#111111] hover:text-white ${className}`}
    >
      {children}
    </button>
  );
}
