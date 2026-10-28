import { useMemo, useState } from "react";
import { Plus, RefreshCw, Settings, Trash2, Wrench } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { JsonObjectModal } from "@/components/config/JsonObjectModal";
import { Card, PillButton } from "@/components/ui/core";
import { Banner, EmptyState, LoadingBlock, PageHeader } from "@/components/ui/shell";
import { useConfigDocument } from "@/hooks/useConfigDocument";
import { api } from "@/lib/api";

const TABS = [
  { id: "pre", label: "Pre-Call" },
  { id: "in", label: "In-Call" },
  { id: "post", label: "Post-Call" },
  { id: "catalog", label: "Catalog" },
];

export default function ToolsPage() {
  const { config, isLoading, save } = useConfigDocument();
  const [activeTab, setActiveTab] = useState("in");
  const [modalState, setModalState] = useState({ open: false, name: "", value: {}, lockName: false, target: "tools" });

  const catalogQuery = useQuery({
    queryKey: ["tool-catalog"],
    queryFn: async () => (await api.get("/api/tools/catalog")).data,
  });

  const groupedTools = useMemo(() => {
    const tools = Object.entries(config?.tools || {}).map(([name, value]) => ({
      name,
      value,
      source: "tools",
    }));
    const inCallTools = Object.entries(config?.in_call_tools || {}).map(([name, value]) => ({
      name,
      value,
      source: "in_call_tools",
    }));

    return {
      pre: tools.filter((tool) => tool.value?.phase === "pre_call"),
      in: [...tools.filter((tool) => !tool.value?.phase || tool.value?.phase === "in_call"), ...inCallTools],
      post: tools.filter((tool) => tool.value?.phase === "post_call"),
    };
  }, [config]);

  async function persist(nextConfig, message) {
    await save(nextConfig, message);
  }

  async function saveTool(name, value) {
    const nextConfig = structuredClone(config || {});
    nextConfig[modalState.target] = nextConfig[modalState.target] || {};
    nextConfig[modalState.target][name] = value;
    await persist(nextConfig, `Tool ${name} saved.`);
    setModalState({ open: false, name: "", value: {}, lockName: false, target: "tools" });
  }

  async function deleteTool(source, name) {
    if (!window.confirm(`Delete tool "${name}"?`)) {
      return;
    }
    const nextConfig = structuredClone(config || {});
    delete nextConfig[source]?.[name];
    await persist(nextConfig, `Tool ${name} deleted.`);
  }

  async function restartEngine() {
    try {
      await api.post("/api/system/containers/ai_engine/restart?force=false");
      toast.success("AI Engine restart requested.");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to restart AI Engine.");
    }
  }

  if (isLoading || !config) {
    return <LoadingBlock label="Loading Tools" />;
  }

  const visibleTools = activeTab === "catalog" ? [] : groupedTools[activeTab] || [];

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Capabilities & Integrations"
        title="Agent Tools"
        description="Edit built-in tools, HTTP tools, and the read-only runtime catalog against the actual YAML config and backend catalog endpoints."
        actions={
          <>
            <PillButton onClick={restartEngine}>Restart AI Engine</PillButton>
            <PillButton
              variant="solid"
              onClick={() =>
                setModalState({
                  open: true,
                  name: "",
                  value: { enabled: true, phase: activeTab === "pre" ? "pre_call" : activeTab === "post" ? "post_call" : "in_call" },
                  lockName: false,
                  target: activeTab === "in" ? "in_call_tools" : "tools",
                })
              }
            >
              <span className="flex items-center gap-2">
                <Plus size={14} />
                Add Tool
              </span>
            </PillButton>
          </>
        }
      />

      <Banner tone="warning" action={<PillButton onClick={restartEngine}>Restart</PillButton>}>
        Tool changes affect live call behavior. Save the tool object first, then restart the AI Engine to guarantee the new registration surface is loaded.
      </Banner>

      <div className="flex flex-wrap gap-2 border-b border-[#111111]/10 pb-4">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-full px-5 py-3 text-[10px] font-bold uppercase tracking-[0.25em] transition-all ${activeTab === tab.id ? "bg-[#111111] text-white" : "bg-white text-[#666666] hover:bg-[#111111]/5"}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "catalog" ? (
        <Card className="rounded-[32px] p-0">
          <div className="flex items-center justify-between border-b border-[#111111]/10 px-6 py-5">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                Runtime Catalog
              </p>
              <p className="mt-2 text-sm text-[#666666]">
                Live tool registry from `/api/tools/catalog`.
              </p>
            </div>
            <PillButton onClick={() => catalogQuery.refetch()}>
              <span className="flex items-center gap-2">
                <RefreshCw size={14} className={catalogQuery.isFetching ? "animate-spin" : ""} />
                Refresh
              </span>
            </PillButton>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-left">
              <thead>
                <tr>
                  {["Tool", "Phase", "Source", "Description", "Parameters"].map((header) => (
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
                {(catalogQuery.data?.tools || []).map((tool) => (
                  <tr key={tool.name} className="border-t border-[#111111]/5">
                    <td className="px-6 py-4 text-sm font-bold">{tool.name}</td>
                    <td className="px-6 py-4 text-sm">{tool.phase || "in_call"}</td>
                    <td className="px-6 py-4 text-sm">{tool.source || "builtin"}</td>
                    <td className="px-6 py-4 text-sm">{tool.description || "—"}</td>
                    <td className="px-6 py-4 text-xs text-[#666666]">
                      {JSON.stringify(tool.parameters || [], null, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : visibleTools.length ? (
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {visibleTools.map((tool) => (
            <Card key={`${tool.source}-${tool.name}`} className="rounded-[32px] p-8">
              <div className="mb-6 flex items-start justify-between gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#111111] text-white">
                  <Wrench size={20} />
                </div>
                <span className="rounded-full bg-[#111111]/5 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#666666]">
                  {tool.source === "in_call_tools" ? "In-Call Registry" : tool.value?.phase || "Built-in"}
                </span>
              </div>
              <h3 className="font-clash-display text-3xl font-bold uppercase">
                {tool.name}
              </h3>
              <p className="mt-3 text-sm text-[#666666]">
                {tool.value?.description || "Direct YAML-backed tool object."}
              </p>
              <pre className="mt-6 overflow-x-auto rounded-[24px] bg-[#111111]/5 p-4 text-xs text-[#555555]">
                {JSON.stringify(tool.value, null, 2)}
              </pre>
              <div className="mt-6 grid grid-cols-2 gap-2">
                <ActionButton
                  onClick={() =>
                    setModalState({
                      open: true,
                      name: tool.name,
                      value: tool.value,
                      lockName: true,
                      target: tool.source,
                    })
                  }
                >
                  <Settings size={14} />
                  Edit
                </ActionButton>
                <ActionButton
                  onClick={() => deleteTool(tool.source, tool.name)}
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
          title="No Tools In This Phase"
          description="Add a tool entry to this phase and it will be saved directly into the YAML-backed config."
          actionLabel="Add Tool"
          onAction={() =>
            setModalState({
              open: true,
              name: "",
              value: { enabled: true, phase: activeTab === "pre" ? "pre_call" : activeTab === "post" ? "post_call" : "in_call" },
              lockName: false,
              target: activeTab === "in" ? "in_call_tools" : "tools",
            })
          }
        />
      )}

      <JsonObjectModal
        isOpen={modalState.open}
        onClose={() => setModalState({ open: false, name: "", value: {}, lockName: false, target: "tools" })}
        title={modalState.lockName ? "Edit Tool" : "Add Tool"}
        subtitle="This editor writes directly to either config.tools or config.in_call_tools depending on the current phase."
        initialName={modalState.name}
        initialValue={modalState.value}
        lockName={modalState.lockName}
        onSave={saveTool}
      />
    </div>
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
